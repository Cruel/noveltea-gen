import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertPersistenceBoundary, sourceViolations } from '../../scripts/check-studio-persistence-boundary.mjs'

test('Studio application source cannot import or access the raw SQLite driver', () => {
  assertPersistenceBoundary()
  for (const source of [
    "import Database from 'better-sqlite3'",
    "import { Pool } from 'pg'",
    "import { Kysely } from 'kysely'",
    "import { openKyselyDatabase } from '../db/kysely-connection'",
    "const Database = require('better-sqlite3')",
    "await import('drizzle-orm/better-sqlite3')",
    "import { drizzle } from 'drizzle-orm/better-sqlite3'",
    "store?.sqlite.prepare('SELECT 1')",
    "store['sqlite'].prepare('SELECT 1')",
    "store.sqlite.prepare('SELECT 1')",
    "database.sqlite.transaction(() => {})",
    "import { ownedThreadMessageSqlite } from '../persistence/thread-message-sqlite'",
    "studioSqliteDriver(store)",
    "studioDrizzleForMigrations(store)",
    "import { assertStudioSchemaCurrent } from '../db/migrations'",
    "store.persistence.generation.queue.sqliteTransactionBridge.claim('id', 1, 'now')",
    "store.persistence.generation.events.sqliteBridge.after(owner, jobId, 0, 1)",
  ]) {
    assert.ok(sourceViolations('lib/application.server.ts', source).length > 0, source)
  }
  assert.deepEqual(sourceViolations('lib/application.server.ts',
    'await store.persistence.messages.owned(owner, threadId, id)'), [])
  assert.ok(sourceViolations('lib/auth.ts',
    'database: studioSqliteDriver(store)').length > 0)
})
