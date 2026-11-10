import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { Pool } from 'pg'
import { StudioPostgresDialect } from './studio-postgres-dialect'
import { openKyselyDatabase, type DatabaseOptions } from './kysely-connection'
import { openStudioSchemaConnection, assertKyselyStudioSchemaCurrent } from './kysely-migrations'
import { createKyselyPersistence } from '../persistence/kysely'
import { registerStudioAuthStorage } from './auth-storage'
import { createStudioReadinessGate } from './studio-readiness'
import type { StudioStore } from '../persistence/store'
import type { StudioDb } from './studio-db'
export { selectedStudioDatabaseOptions } from './studio-options'

/** Runtime construction is side-effect-free with respect to migrations.
 * All backends have a single shared domain implementation. */
export function openSharedStudioStore(options: DatabaseOptions): StudioStore {
  if (options.backend === 'sqlite' && (options.path === ':memory:' || !existsSync(options.path)))
    throw new Error('Shared Studio requires an existing migrated SQLite database')
  const database = openKyselyDatabase<StudioDb>(options.backend === 'sqlite'
    ? { ...options, serializeLocalWrites: true } : options)
  let authSqlite: Database.Database | undefined
  let authPool: Pool | undefined
  try {
    const authDatabase = options.backend === 'sqlite'
      ? (authSqlite = new Database(options.path, { fileMustExist: true }))
      : (() => {
          authPool = new Pool({ ...options.connection, max: options.poolSize ?? 4 })
          authPool.on('error', () => {})
          return { dialect: new StudioPostgresDialect({ pool: authPool }), type: 'postgres' as const,
            transaction: true as const }
        })()
    // Better Auth uses its own SQLite handle; enforce referential integrity there too.
    authSqlite?.pragma('foreign_keys = ON')
    const readiness = createStudioReadinessGate({
      schemaVersion: options.backend === 'sqlite'
        ? () => authSqlite!.pragma('schema_version', { simple: true }) as number
        : undefined,
      async attest() {
        const maintenance = openStudioSchemaConnection(options, 'read')
        try { await assertKyselyStudioSchemaCurrent(maintenance) }
        finally { await maintenance.close() }
      },
    })
    const store: StudioStore = {
      persistence: createKyselyPersistence(database),
      assertReady: () => readiness.assertReady(),
      invalidateReadiness: () => readiness.invalidate(),
      async close() {
        await readiness.close()
        try {
          await database.close()
        } finally {
          authSqlite?.close()
          await authPool?.end()
        }
      },
    }
    registerStudioAuthStorage(store, authDatabase)
    return store
  } catch (error) {
    authSqlite?.close()
    void authPool?.end()
    void database.close()
    throw error
  }
}
