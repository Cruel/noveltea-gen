import { openStudioDatabase as openRuntimeDatabase, studioDrizzleForMigrations, studioSqliteDriver } from '../../src/db/connection'

/** Isolated test-only raw SQLite fixture hook. Never export this from runtime
 * types. Keep direct SQL only for historical/schema corruption fixtures and
 * low-level adapter assertions; normal behavior should use persistence ports.
 */
export function openStudioDatabase(path?: string) {
  const store = openRuntimeDatabase(path)
  return Object.assign(store, { sqlite: studioSqliteDriver(store), db: studioDrizzleForMigrations(store) })
}
