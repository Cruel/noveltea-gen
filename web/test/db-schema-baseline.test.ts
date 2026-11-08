import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { openStudioDatabase } from './support/studio-database'
import { assertStudioSchemaCurrent, migrateStudio } from '../src/db/migrations'
import { createStudioAuth } from '../src/lib/auth'

const config = {
  baseURL: 'http://localhost:3000',
  secret: 'fresh-drizzle-studio-baseline-secret-0123456789',
  github: { clientId: 'test', clientSecret: 'test-secret' },
  gitlab: { clientId: 'test', clientSecret: 'test-secret' },
}
const stamp = '2026-11-05T00:00:00Z'
const webRoot = fileURLToPath(new URL('..', import.meta.url))

test('fresh Drizzle baseline initializes the complete, constrained Studio schema', async () => {
  const store = openStudioDatabase(':memory:')
  try {
    assert.throws(() => assertStudioSchemaCurrent(store), /migrations are pending/)
    await assert.rejects(store.assertReady(), /migrations are pending/)
    assert.equal((await store.testing.schema.hasMigrationJournal()), false)
    await migrateStudio(store, config)
    await migrateStudio(store, config)
    assertStudioSchemaCurrent(store)
    await store.assertReady()

    const appNames = (await store.testing.schema.tables()).filter(name =>
      !name.startsWith('sqlite_') &&
      !['user', 'session', 'account', 'verification', 'rateLimit', '__drizzle_migrations'].includes(name))
    assert.equal(appNames.length, 33)
    assert.ok(!appNames.includes('story_conversations'))
    assert.ok(appNames.includes('story_turns'))
    assert.ok(appNames.includes('story_turn_executions'))
    for (const table of ['story_collections', 'story_collection_memberships', 'user_story_selection'])
      assert.ok(appNames.includes(table))
    for (const name of ['thread_steering_checkpoint_links', 'github_install_flows',
      'story_onboarding_conversations']) assert.ok(appNames.includes(name))
    assert.deepEqual((await store.testing.foreignKeyViolations()), [])

    const ctx = await createStudioAuth(store, config).$context
    const alice = await ctx.internalAdapter.createUser({
      name: 'Alice', email: 'alice@baseline.test', emailVerified: true,
    }, { method: 'test' })
    const bob = await ctx.internalAdapter.createUser({
      name: 'Bob', email: 'bob@baseline.test', emailVerified: true,
    }, { method: 'test' })
    const data = store.testing.records

    await data.insert('repositories', { id: 'repository', ownerUserId: alice.id,
      provider: 'github', providerRepositoryId: '123', name: 'alice/repository', createdAt: stamp })
    assert.equal((await data.first<{ name: string }>('repositories', { id: 'repository' }))?.name, 'alice/repository')
    await data.insert('stories', { id: 'story', ownerUserId: alice.id, repositoryId: 'repository',
      directory: 'story', title: 'A Story', createdAt: stamp })
    assert.equal((await data.first<{ title: string }>('stories', { id: 'story' }))?.title, 'A Story')

    await assert.rejects(() => data.insert('repositories', { id: 'invalid', ownerUserId: alice.id,
      provider: 'other', providerRepositoryId: '123', name: 'Invalid', createdAt: stamp }), /CHECK constraint/)
    await assert.rejects(() => data.insert('repositories', { id: 'duplicate', ownerUserId: alice.id,
      provider: 'github', providerRepositoryId: '123', name: 'Duplicate', createdAt: stamp }), /UNIQUE constraint/)
    await assert.rejects(() => data.insert('stories', { id: 'foreign-story', ownerUserId: bob.id,
      repositoryId: 'repository', directory: 'bad', title: 'Bad', createdAt: stamp }), /FOREIGN KEY constraint/)

    await data.insert('studio_sessions', { id: 'job', ownerUserId: alice.id, storyId: 'story',
      title: 'Job', status: 'running', createdAt: stamp, updatedAt: stamp })
    await data.insert('story_threads', { id: 'thread', ownerUserId: alice.id,
      storyId: 'story', title: 'Thread', activityAt: stamp, createdAt: stamp })
    await assert.rejects(() => data.insert('story_threads', { id: 'self', ownerUserId: alice.id,
      storyId: 'story', parentThreadId: 'self', title: 'Broken',
      activityAt: stamp, createdAt: stamp }), /CHECK constraint/)

    await data.insert('stories', { id: 'other-story', ownerUserId: alice.id, repositoryId: 'repository',
      directory: 'other', title: 'Other Story', createdAt: stamp })
    await data.insert('story_threads', { id: 'other-thread', ownerUserId: alice.id,
      storyId: 'other-story', title: 'Other', activityAt: stamp, createdAt: stamp })
    await assert.rejects(() => data.insert('story_thread_runs', { jobId: 'job', ownerUserId: alice.id,
      threadId: 'other-thread', runOrder: 0 }), /same owned Story/)
    await assert.rejects(() => data.insert('story_threads', { id: 'cross-story', ownerUserId: alice.id,
      storyId: 'other-story', parentThreadId: 'thread', title: 'Crossed', activityAt: stamp,
      createdAt: stamp }), /FOREIGN KEY/)
    await data.insert('story_thread_runs', { jobId: 'job', ownerUserId: alice.id,
      threadId: 'thread', runOrder: 0 })

    // Collection membership cannot cross Story or owner, and removing the
    // Collection cannot delete a Thread or rewrite its fork provenance.
    await data.insert('story_collections', { id: 'collection', ownerUserId: alice.id,
      storyId: 'story', name: 'Drafts', createdAt: stamp, updatedAt: stamp })
    await data.insert('story_collection_memberships', { threadId: 'thread',
      ownerUserId: alice.id, storyId: 'story', collectionId: 'collection' })
    await assert.rejects(() => data.insert('story_collection_memberships', {
      threadId: 'other-thread', ownerUserId: alice.id, storyId: 'other-story',
      collectionId: 'collection',
    }), /FOREIGN KEY constraint/)
    await assert.rejects(() => data.insert('story_collection_memberships', {
      threadId: 'other-thread', ownerUserId: bob.id, storyId: 'story',
      collectionId: 'collection',
    }), /FOREIGN KEY constraint/)
    await assert.rejects(() => data.insert('user_story_selection', {
      ownerUserId: bob.id, storyId: 'story', updatedAt: stamp,
    }), /FOREIGN KEY constraint/)
    await data.insert('user_story_selection', { ownerUserId: alice.id,
      storyId: 'story', updatedAt: stamp })
    await data.delete('story_collections', { id: 'collection' })
    assert.equal(await data.count('story_collection_memberships'), 0)
    assert.equal(await data.count('story_threads'), 2)
    assert.equal(await data.count('story_thread_runs'), 1)

    await data.insert('story_thread_messages', { id: 'one', ownerUserId: alice.id,
      threadId: 'thread', sequence: 1, role: 'user', status: 'queued',
      body: 'Hello', phase: 'preparing', jobId: 'job', createdAt: stamp })
    assert.equal(await data.count('story_turns'), 1)
    assert.equal(await data.count('story_turn_executions'), 1)
    await assert.rejects(() => data.insert('story_turn_executions', { turnId: 'one', jobId: 'job',
      ownerUserId: bob.id, threadId: 'other-thread' }), /FOREIGN KEY|UNIQUE/)
    await assert.rejects(() => data.insert('story_thread_messages', { id: 'two', ownerUserId: alice.id,
      threadId: 'thread', sequence: 2, role: 'user', status: 'queued',
      body: 'Hello', phase: 'preparing', createdAt: stamp }), /UNIQUE constraint/)
    await data.insert('story_thread_messages', { id: 'assistant', ownerUserId: alice.id,
      threadId: 'thread', sequence: 2, role: 'assistant', status: 'delivered',
      body: 'Reply', phase: 'preparing', createdAt: stamp })
    await assert.rejects(() => data.insert('generation_run_queue', { jobId: 'job', ownerUserId: alice.id,
      intent: 'unknown', phase: 'queued', createdAt: stamp, updatedAt: stamp }), /CHECK constraint/)
    await data.insert('pi_credentials', { ownerUserId: alice.id, provider: 'openai', ciphertext: 'encrypted' })
    assert.equal((await data.first<{ revision: number }>('pi_credentials', { ownerUserId: alice.id }))?.revision, 1)
    await data.insert('thread_active_pi_turns', { jobId: 'job', piToken: 'token',
      piSessionId: 'session', workItem: 'work', createdAt: stamp })

    await data.delete('repositories', { id: 'repository' })
    for (const table of ['stories', 'studio_sessions', 'story_threads',
      'story_thread_messages', 'story_turns', 'story_turn_executions', 'thread_active_pi_turns']) {
      assert.equal(await data.count(table), 0, 'cascade into ' + table)
    }
    assert.deepEqual((await store.testing.foreignKeyViolations()), [])
  } finally { store.close() }
})

test('Studio web startup rejects pending migrations before initializing auth or touching application data', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nt-studio-startup-'))
  const path = join(directory, 'studio.sqlite')
  const env = { ...process.env, NT_STUDIO_DB_PATH: path }
  const checkStartup = () => spawnSync(process.execPath, ['--import', 'tsx', '-e',
    "import('./src/lib/runtime.server.ts').catch(error => { console.error(error.message); process.exitCode = 1 })",
  ], { cwd: webRoot, env, encoding: 'utf8', timeout: 20_000 })
  try {
    const initial = checkStartup()
    assert.equal(initial.status, 1)
    assert.match(initial.stderr, /migrations are pending/)
    const store = openStudioDatabase(path)
    try {
      assert.equal((await store.testing.schema.hasMigrationJournal()), false)
      assert.equal((await store.testing.schema.hasTable('user')), false)
      await migrateStudio(store, config)
    } finally { store.close() }
    const after = checkStartup()
    assert.equal(after.status, 1)
    assert.match(after.stderr, /BETTER_AUTH_URL/)
    assert.doesNotMatch(after.stderr, /migrations are pending/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('untracked application tables and incompatible Drizzle histories are refused without rewriting databases', async () => {
  const untracked = openStudioDatabase(':memory:')
  try {
    await migrateStudio(untracked, config)
    await untracked.testing.schema.dropTable('__drizzle_migrations')
    await assert.rejects(migrateStudio(untracked, config), /tables exist without Drizzle migration history/)
    assert.equal(await untracked.testing.schema.hasTable('repositories'), true)
    assert.equal(await untracked.testing.schema.hasMigrationJournal(), false)
  } finally { untracked.close() }

  const mismatched = openStudioDatabase(':memory:')
  try {
    await migrateStudio(mismatched, config)
    ;(await mismatched.testing.schema.tamperMigrationHash('wrong'))
    assert.throws(() => assertStudioSchemaCurrent(mismatched), /incompatible/)
    await assert.rejects(migrateStudio(mismatched, config), /incompatible/)
    assert.equal((await mismatched.testing.schema.migrationHistory())[0]?.hash, 'wrong')
  } finally { mismatched.close() }

  const drifted = openStudioDatabase(':memory:')
  try {
    await migrateStudio(drifted, config)
    ;(await drifted.testing.schema.dropIndex('story_thread_messages_one_preparing'))
    assert.throws(() => assertStudioSchemaCurrent(drifted), /does not match its schema/)
    assert.equal((await drifted.testing.schema.definition('index', 'story_thread_messages_one_preparing')), undefined)
    ;(await drifted.testing.schema.dropTable('rateLimit'))
    assert.throws(() => assertStudioSchemaCurrent(drifted), /Better Auth schema is incomplete/)
  } finally { drifted.close() }
})

test('runtime rejects type, nullability, default, foreign-key and CHECK drift with a valid migration journal', async () => {
  const variants = [
    ['repositories', '`name` text NOT NULL', '`name` integer NOT NULL'],
    ['repositories', '`name` text NOT NULL', '`name` text'],
    ['git_connections', '`revision` integer DEFAULT 1 NOT NULL', '`revision` integer DEFAULT 2 NOT NULL'],
    ['repositories', 'FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`)', 'FOREIGN KEY (`owner_user_id`) REFERENCES `account`(`id`)'],
    ['repositories', "in ('github', 'gitlab')", "in ('github')"],
  ] as const
  for (const [table, original, replacement] of variants) {
    const store = openStudioDatabase(':memory:')
    try {
      await migrateStudio(store, config)
      assert.ok((await store.testing.schema.replaceTableFragment(table, original, replacement)),
        table + ': original schema fragment missing')
      assert.throws(() => assertStudioSchemaCurrent(store), /schema definition drift/, table)
    } finally { store.close() }
  }
})

test('runtime rejects altered index uniqueness and partial-index predicates', async () => {
  for (const [index, original, replacement] of [
    ['repositories_identity', 'CREATE UNIQUE INDEX', 'CREATE INDEX'],
    ['story_thread_messages_one_preparing', "='preparing'", "='queued'"],
  ] as const) {
    const store = openStudioDatabase(':memory:')
    try {
      await migrateStudio(store, config)
      assert.ok((await store.testing.schema.replaceIndexFragment(index, original, replacement)))
      assert.throws(() => assertStudioSchemaCurrent(store), /schema definition drift/, index)
    } finally { store.close() }
  }
})
