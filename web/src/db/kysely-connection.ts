import Database from 'better-sqlite3'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import {
  CamelCasePlugin,
  CompiledQuery,
  Kysely,
  SqliteDialect,
  sql,
  type Transaction,
} from 'kysely'
import { Pool, type PoolConfig } from 'pg'
import type { StudioDb } from './studio-db'
import { StudioPostgresDialect } from './studio-postgres-dialect'

export type WriteGuard = { kind: 'thread' | 'job'; id: string }
export type QueryExecutor<DB> = Pick<Kysely<DB>, 'selectFrom' | 'selectNoFrom'>
export interface SharedDatabase<DB> {
  /** Standalone reads only. Mutations (including CAS) must use withWriteTransaction. */
  readonly read: QueryExecutor<DB>
  withWriteTransaction<T>(
    guards: readonly WriteGuard[],
    work: (tx: Transaction<DB>) => Promise<T>,
  ): Promise<T>
  close(): Promise<void>
}
export type DatabaseOptions = (
  | { backend: 'sqlite'; path: string; busyTimeoutMs?: number; contentionBudgetMs?: number }
  | { backend: 'postgres'; connection: Omit<PoolConfig, 'max'>; poolSize?: number }
) & { maxAttempts?: number }

function bounded(value: number, name: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`)
  return value
}

/** Stable namespace/key mapping across processes. Collisions only serialize extra work. */
function lockId(value: string): string {
  return createHash('sha256')
    .update('noveltea:studio:write:v1:' + value)
    .digest()
    .readBigInt64BE()
    .toString()
}

/** Infrastructure only. No schema creation, migration or backend fallback occurs here.
 * Callbacks may be replayed in full: database queries only, never Git/model/network effects.
 * Nested helpers receive tx; they must not reopen a root transaction.
 */
export function openKyselyDatabase<DB = StudioDb>(options: DatabaseOptions): SharedDatabase<DB> {
  const backend = options.backend
  const attempts = bounded(options.maxAttempts ?? (backend === 'sqlite' ? 10 : 3), 'maxAttempts', 1, 10)
  const contentionBudgetMs =
    backend === 'sqlite'
      ? bounded(options.contentionBudgetMs ?? 5000, 'contentionBudgetMs', 1, 60_000)
      : undefined
  const sqliteDeadline = backend === 'sqlite' ? new AsyncLocalStorage<number>() : undefined
  let db: Kysely<DB>
  let sqliteHandle: Database.Database | undefined
  if (options.backend === 'sqlite') {
    const timeout = bounded(options.busyTimeoutMs ?? 500, 'busyTimeoutMs', 0, 5000)
    if (options.path !== ':memory:') {
      if (!isAbsolute(options.path)) throw new Error('Studio database path must be absolute')
      mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 })
    }
    const sqlite = new Database(options.path, { timeout })
    sqliteHandle = sqlite
    try {
      if (options.path !== ':memory:') {
        chmodSync(options.path, 0o600)
        sqlite.pragma('journal_mode = WAL')
      }
      sqlite.pragma('foreign_keys = ON')
      const dialect = new SqliteDialect({ database: sqlite })
      const createDriver = dialect.createDriver.bind(dialect)
      dialect.createDriver = () => {
        const driver = createDriver()
        // Kysely owns this exact connection and handles awaited commit/rollback/release.
        driver.beginTransaction = async (connection) => {
          // The synchronous SQLite busy handler must never consume a fresh timeout
          // on every retry. Cap each lock wait to the transaction's shared deadline.
          const remaining = (sqliteDeadline?.getStore() ?? performance.now() + timeout) - performance.now()
          sqlite.pragma(`busy_timeout = ${Math.max(0, Math.min(timeout, Math.floor(remaining)))}`)
          await connection.executeQuery(CompiledQuery.raw('BEGIN IMMEDIATE'))
        }
        return driver
      }
      db = new Kysely<DB>({ dialect, plugins: [new CamelCasePlugin()] })
    } catch (error) {
      sqlite.close()
      throw error
    }
  } else if (options.backend === 'postgres') {
    const max = bounded(options.poolSize ?? 4, 'poolSize', 1, 32)
    const pool = new Pool({ ...options.connection, max, connectionTimeoutMillis: 5000 })
    // pg evicts disconnected idle clients. Consume the pool's notification so an
    // idle disconnect cannot crash the server; checked-out queries still reject.
    pool.on('error', () => {})
    pool.on('connect', (client) => {
      // A checked-out transaction can be idle between awaited queries when its
      // backend is terminated. pg marks it unqueryable; the next query rejects.
      client.on('error', () => {})
    })
    db = new Kysely<DB>({ dialect: new StudioPostgresDialect({ pool }), plugins: [new CamelCasePlugin()] })
  } else {
    throw new Error('Unsupported Studio database backend')
  }
  let closed = false
  let closing: Promise<void> | undefined
  return {
    // Do not expose a root write executor even at runtime.
    read: {
      get selectFrom() {
        if (closed) throw new Error('Studio database is closed')
        return db.selectFrom.bind(db)
      },
      get selectNoFrom() {
        if (closed) throw new Error('Studio database is closed')
        return db.selectNoFrom.bind(db)
      },
    },
    async withWriteTransaction(guards, work) {
      if (closed) throw new Error('Studio database is closed')
      const keys = [
        ...new Set(
          guards.map((guard) => {
            if (!['thread', 'job'].includes(guard.kind) || !guard.id) throw new Error('Invalid write guard')
            return `${guard.kind === 'thread' ? '1' : '2'}:${guard.kind}:${guard.id}`
          }),
        ),
      ].sort()
      const deadline = contentionBudgetMs === undefined ? undefined : performance.now() + contentionBudgetMs
      for (let attempt = 1; ; attempt++) {
        try {
          const run = () =>
            db.transaction().execute(async (tx) => {
              if (backend === 'postgres') {
                await sql`set local lock_timeout = '5s'`.execute(tx)
                // Mandatory for EVERY writer, including empty guard lists and formerly autocommit DML.
                // Queue capacity, absent identities and event publication are covered by this fallback.
                for (const key of ['0:exclusive', ...keys]) {
                  await sql`select pg_advisory_xact_lock(${lockId(key)}::bigint)`.execute(tx)
                }
              }
              return await work(tx)
            })
          return await (sqliteDeadline && deadline !== undefined ? sqliteDeadline.run(deadline, run) : run())
        } catch (error) {
          const code = (error as { code?: string } | null)?.code
          const retry =
            backend === 'postgres'
              ? code === '40P01' || code === '40001'
              : code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT'
          if (!retry || attempt >= attempts) throw error
          const backoff = 10 * attempt
          if (deadline !== undefined && performance.now() + backoff >= deadline) throw error
          await delay(backoff)
        }
      }
    },
    close() {
      closed = true
      return (closing ??= db.destroy().finally(() => {
        // Kysely's destroy is a no-op before first acquisition; we opened eagerly.
        if (sqliteHandle?.open) sqliteHandle.close()
      }))
    },
  }
}
