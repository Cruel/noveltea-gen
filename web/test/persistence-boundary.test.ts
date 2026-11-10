import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assertPersistenceBoundary,
  sourceViolations,
} from '../../scripts/check-studio-persistence-boundary.mjs'
import { featureTestImportViolations } from '../../scripts/check-source-quality.mjs'

test('ordinary feature tests cannot bypass shared persistence ports', () => {
  for (const source of [
    "import { Pool } from 'pg'",
    "import { Kysely } from 'kysely'",
    "import type { Transaction } from 'kysely'",
    "import { openKyselyDatabase } from '../src/db/kysely-connection'",
    "const pg = require('pg')",
    "await import('kysely')",
    "export { sql } from 'kysely'",
    "import Database from 'better-sqlite3'",
  ]) {
    assert.ok(featureTestImportViolations('web/test/studio.test.ts', source).length > 0, source)
  }
  assert.deepEqual(featureTestImportViolations('web/test/studio.test.ts',
    "import { openStudioDatabase } from './support/studio-database'"), [])
  assert.deepEqual(featureTestImportViolations('web/test/kysely-schema.test.ts',
    "import { Pool } from 'pg'"), [])
  assert.deepEqual(featureTestImportViolations('web/test/support/kysely-feature-fixture.ts',
    "import { openKyselyDatabase } from '../../src/db/kysely-connection'"), [])
})

test('Studio application source cannot import or access the raw SQLite driver', () => {
  assertPersistenceBoundary()
  for (const source of [
    "import Database from 'better-sqlite3'",
    "import { Pool } from 'pg'",
    "import { Kysely } from 'kysely'",
    "import { sql } from 'kysely'",
    "import { createKyselyCollectionCatalog } from '../persistence/collection-kysely'",
    "import { createKyselyPublicationRecords } from '../persistence/publication-kysely'",
    "import { createKyselyGitPersistence } from '../persistence/git-kysely'",
    "import { openKyselyDatabase } from '../db/kysely-connection'",
    "const Database = require('better-sqlite3')",
    "store?.sqlite.prepare('SELECT 1')",
    "store['sqlite'].prepare('SELECT 1')",
    "store.sqlite.prepare('SELECT 1')",
    'database.sqlite.transaction(() => {})',
  ]) {
    assert.ok(sourceViolations('lib/application.server.ts', source).length > 0, source)
  }
  assert.deepEqual(
    sourceViolations(
      'lib/application.server.ts',
      'await store.persistence.messages.owned(owner, threadId, id)',
    ),
    [],
  )
  assert.deepEqual(sourceViolations('persistence/collection-kysely.ts', "import { sql } from 'kysely'"), [])
  assert.deepEqual(sourceViolations('persistence/git-kysely.ts', "import { sql } from 'kysely'"), [])
  assert.ok(sourceViolations('persistence/unconverted.ts', "import { sql } from 'kysely'").length > 0)
  assert.ok(sourceViolations('persistence/collection-kysely.ts', "import { Pool } from 'pg'").length > 0)
})
