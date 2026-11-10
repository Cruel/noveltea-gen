import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { openStudioSchemaConnection, migrateStudioKysely } from '../src/db/kysely-migrations'
import { openSharedStudioStore, selectedStudioDatabaseOptions } from '../src/db/shared-studio-store'
import { createStudioAuth } from '../src/lib/auth'
import { openKyselyFeatureFixture } from './support/kysely-feature-fixture'
import { openStudioDatabase, migrateStudio } from './support/studio-database'

const auth = {
  baseURL: 'http://localhost:3000',
  secret: 'shared-studio-store-test-secret-0123456789',
  github: { clientId: 'test', clientSecret: 'test' },
  gitlab: { clientId: 'test', clientSecret: 'test' },
}

test('PostgreSQL application composition has one Kysely domain and auth storage', {
  skip: !process.env.NT_TEST_PG_URL && 'Set NT_TEST_PG_URL for a disposable PostgreSQL test database',
}, async () => {
  const fixture = await openKyselyFeatureFixture('postgres')
  try {
    const store = openSharedStudioStore(fixture.databaseOptions)
    try {
      await store.assertReady()
      const context = await createStudioAuth(store, auth).$context
      assert.ok(context.internalAdapter)
      const owner = await fixture.owner()
      assert.deepEqual(await store.persistence.settings.listRepositories(owner), [])
      assert.deepEqual(await store.persistence.dashboard.forOwner(owner), {
        repositories: [], stories: [], selectedStoryId: null,
        activeJobs: [], recentSessions: [],
      })
    } finally {
      await store.close()
    }
  } finally {
    await fixture.close()
  }
})

test('real SQLite startup attestation is cached, fast, and invalidated immediately by DDL', async () => {
  const store = openStudioDatabase()
  try {
    await migrateStudio(store, auth)
    await store.assertReady()
    const started = performance.now()
    for (let i = 0; i < 40; i++) await store.assertReady()
    const warmMs = performance.now() - started
    assert.ok(warmMs < 250, '40 warm readiness calls should not rerun full attestation: ' + warmMs)
    await store.testing.schema.dropIndex('story_thread_messages_one_preparing')
    await assert.rejects(store.assertReady(), /index|schema|mismatch|drift/i,
      'SQLite schema_version invalidates successful cache before lease expiry')
    await assert.rejects(store.assertReady(), /index|schema|mismatch|drift/i,
      'failed readiness cannot be cached')
  } finally {
    await store.close()
  }
})

test('real PostgreSQL warm readiness is fast and detects catalog drift after lease expiry', {
  skip: !process.env.NT_TEST_PG_URL && 'Set NT_TEST_PG_URL for real PostgreSQL readiness',
  timeout: 45_000,
}, async () => {
  const fixture = await openKyselyFeatureFixture('postgres')
  try {
    const store = fixture.store
    await store.assertReady()
    const started = performance.now()
    for (let i = 0; i < 40; i++) await store.assertReady()
    assert.ok(performance.now() - started < 250,
      '40 warm PostgreSQL checks must not open/inspect schema')
    await fixture.dropReadinessIndex()
    // PostgreSQL external DDL cannot be detected by a SQLite-style version
    // PRAGMA. The bounded lease must force a fresh full catalog inspection.
    await delay(5_100)
    await assert.rejects(store.assertReady(), /index|schema|mismatch|drift/i)
    await assert.rejects(store.assertReady(), /index|schema|mismatch|drift/i)
  } finally {
    await fixture.close()
  }
})

test('backend selection requires explicit PostgreSQL credentials and rejects fallback', () => {
  assert.deepEqual(selectedStudioDatabaseOptions({ NT_STUDIO_DB_BACKEND: 'postgres',
    PGHOST: 'db', PGDATABASE: 'studio', PGUSER: 'studio', PGPASSWORD: 'secret' }),
    { backend: 'postgres', connection: { host: 'db', port: 5432,
      database: 'studio', user: 'studio', password: 'secret' } })
  assert.throws(() => selectedStudioDatabaseOptions({ NT_STUDIO_DB_BACKEND: 'postgres' }), /Missing PGHOST/)
  assert.throws(() => selectedStudioDatabaseOptions({ NT_STUDIO_DB_BACKEND: 'unknown' }), /Unsupported/)
})

test('composed runtime uses Kysely ports, authenticates and checks schema without migrating', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-shared-store-'))
  const options = { backend: 'sqlite' as const, path: join(root, 'studio.sqlite') }
  try {
    assert.throws(() => openSharedStudioStore(options), /existing migrated SQLite/)
    const maintenance = openStudioSchemaConnection(options)
    try {
      await migrateStudioKysely(maintenance, auth)
    } finally {
      await maintenance.close()
    }
    const store = openSharedStudioStore(options)
    try {
      await store.assertReady()
      const authContext = await createStudioAuth(store, auth).$context
      assert.ok(authContext.internalAdapter)
      assert.deepEqual(await store.persistence.settings.listRepositories('owner'), [])
      assert.equal(await store.persistence.settings.getDefaultModel('owner'), null)
    } finally {
      await store.close()
    }
    const second = openSharedStudioStore(options)
    try {
      await second.assertReady()
      assert.deepEqual(await second.persistence.settings.listRepositories('owner'), [])
    } finally {
      await second.close()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
