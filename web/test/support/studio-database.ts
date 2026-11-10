import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { openSharedStudioStore } from '../../src/db/shared-studio-store'
import { openStudioSchemaConnection, migrateStudioKysely } from '../../src/db/kysely-migrations'
import type { StudioAuthConfig } from '../../src/lib/auth'
import { createKyselyTestRecords } from './kysely-test-records'

/** Backend-selectable Studio business integration fixture.
 * The shared runtime ports are exercised for both SQLite and PostgreSQL,
 * with separately provisioned disposable migration/record infrastructure.
 * The synchronous factory below remains for SQLite-only white-box tests.
 */
export { openKyselyFeatureFixture, type KyselyFeatureFixture,
  openKyselyFeatureFixture as openStudioBusinessFixture,
  type KyselyFeatureFixture as StudioBusinessFixture } from './kysely-feature-fixture'

/** Disposable fixture factory, available before explicit migration.
 * A real temporary SQLite file substitutes for :memory: so Better Auth,
 * Kysely and independent inspection connections see the same database.
 */
export function openStudioDatabase(path?: string) {
  const temporary = !path || path === ':memory:' ? mkdtempSync(join(tmpdir(), 'nt-test-studio-')) : null
  const filename = temporary ? join(temporary, 'studio.sqlite') : path!
  mkdirSync(dirname(filename), { recursive: true })
  const initialize = new Database(filename)
  initialize.close()
  const shared = openSharedStudioStore({ backend: 'sqlite', path: filename })
  const closeShared = shared.close.bind(shared)
  const testing = createKyselyTestRecords(filename)
  let closed = false
  return Object.assign(shared, {
    testDatabasePath: filename,
    testing,
    async close() {
      if (closed) return
      closed = true
      testing.close()
      try { await closeShared() }
      finally { if (temporary) rmSync(temporary, { recursive: true, force: true }) }
    },
  })
}

export type TestStudioDatabase = ReturnType<typeof openStudioDatabase>
export const openCutoverTestStudioDatabase = openStudioDatabase

/** Only tests may explicitly migrate their disposable Studio store. */
export async function migrateStudio(store: TestStudioDatabase, config: StudioAuthConfig) {
  const connection = openStudioSchemaConnection({ backend: 'sqlite', path: store.testDatabasePath })
  try { await migrateStudioKysely(connection, config) }
  finally { await connection.close() }
}

export async function assertStudioSchemaCurrent(store: TestStudioDatabase) {
  await store.assertReady()
}
