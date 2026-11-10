import Database from 'better-sqlite3'
import { isAbsolute } from 'node:path'
import { CamelCasePlugin, Kysely, SqliteDialect } from 'kysely'
import { Pool, type PoolConfig } from 'pg'
import { StudioPostgresDialect } from './studio-postgres-dialect'
import type { StudioDb } from './studio-db'
import { trustedCatalogProjection } from './trusted-catalog-definition'

/** PostgreSQL exposes only the restricted projection view. SQLite reads the
 * identical typed join directly so the currently deployed Drizzle schema
 * remains usable before the application Kysely cutover. Neither executor
 * escapes the read-only reader API. */
type TrustedCatalogDb = Pick<StudioDb, 'trustedJobs'>
export type TrustedControllerJobRow = {
  ownerId: string; provider: string; providerId: string; directory: string
  pin: string; configJson: string | null
}
export type TrustedCatalogOptions =
  | { backend: 'sqlite'; path: string }
  | { backend: 'postgres'; connection: Pick<PoolConfig, 'host' | 'port' | 'database' | 'user' | 'password'> }

export interface TrustedCatalogReader {
  readJob(jobId: string): Promise<TrustedControllerJobRow | null>
  close(): Promise<void>
}

/** The database is opened separately from Studio persistence and never migrated.
 * SQLite refuses absent files and enables query_only; PG is pinned to its
 * restricted role, private view schema, and a read-only transaction policy. */
export function openTrustedCatalog(options: TrustedCatalogOptions): TrustedCatalogReader {
  let postgresDb: Kysely<TrustedCatalogDb> | undefined
  let sqliteDb: Kysely<StudioDb> | undefined
  let sqlite: Database.Database | undefined
  if (options.backend === 'sqlite') {
    if (!isAbsolute(options.path)) throw new Error('Trusted catalog path must be absolute')
    sqlite = new Database(options.path, { readonly: true, fileMustExist: true })
    try {
      sqlite.pragma('query_only = ON')
      sqliteDb = new Kysely<StudioDb>({
        dialect: new SqliteDialect({ database: sqlite }),
        plugins: [new CamelCasePlugin()],
      })
    } catch (error) {
      sqlite.close()
      throw error
    }
  } else {
    if (options.connection.user !== 'noveltea_controller' || !options.connection.password ||
        !options.connection.database || !options.connection.host) {
      throw new Error('Trusted PostgreSQL catalog requires the restricted controller role and connection settings')
    }
    const pool = new Pool({
      ...options.connection,
      max: 1,
      connectionTimeoutMillis: 5000,
      options: '-c search_path=controller_catalog -c default_transaction_read_only=on',
    })
    pool.on('error', () => {})
    postgresDb = new Kysely<TrustedCatalogDb>({
      dialect: new StudioPostgresDialect({ pool }),
      plugins: [new CamelCasePlugin()],
    })
  }
  let closed = false
  let closing: Promise<void> | undefined
  return {
    async readJob(jobId) {
      if (closed) throw new Error('Trusted catalog is closed')
      const row = sqliteDb
        ? await trustedCatalogProjection(sqliteDb).where('job.id', '=', jobId).executeTakeFirst()
        : await postgresDb!.selectFrom('trustedJobs')
          .select(['ownerId', 'provider', 'providerId', 'directory', 'pin', 'configJson'])
          .where('jobId', '=', jobId).executeTakeFirst()
      if (!row) return null
      if (!row.pin) throw new Error('Registered job lacks a pinned source SHA')
      const { ownerId, provider, providerId, directory, pin, configJson } = row
      if (!ownerId || !provider || !providerId || directory === null ||
          (configJson !== null && typeof configJson !== 'string'))
        throw new Error('Trusted catalog has malformed job identity fields')
      return { ownerId, provider, providerId, directory, pin, configJson }
    },
    close() {
      closed = true
      return (closing ??= (sqliteDb ?? postgresDb!).destroy().finally(() => { if (sqlite?.open) sqlite.close() }))
    },
  }
}

export async function readTrustedControllerJob(options: TrustedCatalogOptions, jobId: string) {
  const catalog = openTrustedCatalog(options)
  try { return await catalog.readJob(jobId) }
  finally { await catalog.close() }
}
