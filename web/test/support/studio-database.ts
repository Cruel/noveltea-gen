import { openStudioDatabase as openRuntimeDatabase } from '../../src/db/connection'
import { createSqliteTestRecords } from './sqlite-test-records'

/** Test-facing Studio database. Runtime services and feature tests share the
 * same StudioPersistence contract; fixture and inspection operations use an
 * additional backend-neutral testing port.
 *
 * No SQLite driver or dialect-specific Drizzle handle escapes this factory.
 */
export function openStudioDatabase(path?: string) {
  const store = openRuntimeDatabase(path)
  return Object.assign(store, { testing: createSqliteTestRecords(store) })
}
export type TestStudioDatabase = ReturnType<typeof openStudioDatabase>
