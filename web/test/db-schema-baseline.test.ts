import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { eq } from 'drizzle-orm'
import { openStudioDatabase } from '../src/db/connection'
import { assertStudioSchemaCurrent, migrateStudio } from '../src/db/migrations'
import { createStudioAuth } from '../src/lib/auth'
import { repositories, stories } from '../src/db/schema'

const config = {
  baseURL: 'http://localhost:3000',
  secret: 'fresh-drizzle-studio-baseline-secret-0123456789',
  github: { clientId: 'test', clientSecret: 'test-secret' },
  gitlab: { clientId: 'test', clientSecret: 'test-secret' },
}
const stamp = '2026-11-05T00:00:00Z'
const webRoot = fileURLToPath(new URL('..', import.meta.url))

test('fresh baseline makes raw SQL and Drizzle observe the same complete, constrained Studio schema', async () => {
  const store = openStudioDatabase(':memory:')
  try {
    assert.throws(() => assertStudioSchemaCurrent(store), /migrations are pending/)
    assert.equal(store.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='__drizzle_migrations'").get(), undefined)
    await migrateStudio(store, config)
    await migrateStudio(store, config)
    assertStudioSchemaCurrent(store)

    const appNames = (store.sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table'
      AND name NOT LIKE 'sqlite_%' AND name NOT IN ('user','session','account','verification','rateLimit','__drizzle_migrations')`)
      .all() as Array<{ name: string }>).map(r => r.name).sort()
    assert.equal(appNames.length, 29)
    assert.ok(appNames.includes('thread_steering_checkpoint_links'))
    assert.ok(appNames.includes('github_install_flows'))
    assert.ok(appNames.includes('story_onboarding_conversations'))
    assert.equal(store.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='studio_schema_migrations'").get(), undefined)
    assert.deepEqual(store.sqlite.pragma('foreign_key_check'), [])

    const ctx = await createStudioAuth(store, config).$context
    const alice = await ctx.internalAdapter.createUser({ name: 'Alice', email: 'alice@baseline.test', emailVerified: true }, { method: 'test' })
    const bob = await ctx.internalAdapter.createUser({ name: 'Bob', email: 'bob@baseline.test', emailVerified: true }, { method: 'test' })

    store.db.insert(repositories).values({
      id: 'repository', ownerUserId: alice.id, provider: 'github', providerRepositoryId: '123',
      name: 'alice/repository', createdAt: stamp,
    }).run()
    assert.equal((store.sqlite.prepare('SELECT name FROM repositories WHERE id=?').get('repository') as { name: string }).name, 'alice/repository')
    store.sqlite.prepare(`INSERT INTO stories (id,owner_user_id,repository_id,directory,title,created_at)
      VALUES ('story',?,'repository','story','A Story',?)`).run(alice.id, stamp)
    assert.equal(store.db.select().from(stories).where(eq(stories.id, 'story')).get()?.title, 'A Story')

    assert.throws(() => store.sqlite.prepare(`INSERT INTO repositories
      (id,owner_user_id,provider,provider_repository_id,name,created_at)
      VALUES ('invalid',?,'other','123','Invalid',?)`).run(alice.id,stamp), /CHECK constraint/)
    assert.throws(() => store.sqlite.prepare(`INSERT INTO repositories
      (id,owner_user_id,provider,provider_repository_id,name,created_at)
      VALUES ('duplicate',?,'github','123','Duplicate',?)`).run(alice.id,stamp), /UNIQUE constraint/)
    assert.throws(() => store.db.insert(stories).values({
      id: 'foreign-story', ownerUserId: bob.id, repositoryId: 'repository',
      directory: 'bad', title: 'Bad', createdAt: stamp,
    }).run(), /FOREIGN KEY constraint/)

    store.sqlite.prepare(`INSERT INTO studio_sessions
      (id,owner_user_id,story_id,title,status,created_at,updated_at)
      VALUES ('job',?,'story','Job','running',?,?)`).run(alice.id,stamp,stamp)
    store.sqlite.prepare(`INSERT INTO story_conversations
      (id,owner_user_id,story_id,title,created_at,updated_at)
      VALUES ('conversation',?,'story','Conversation',?,?)`).run(alice.id,stamp,stamp)
    store.sqlite.prepare(`INSERT INTO story_threads
      (id,owner_user_id,conversation_id,title,activity_at,created_at)
      VALUES ('thread',?,'conversation','Thread',?,?)`).run(alice.id,stamp,stamp)
    assert.throws(() => store.sqlite.prepare(`INSERT INTO story_threads
      (id,owner_user_id,conversation_id,parent_thread_id,title,activity_at,created_at)
      VALUES ('self',?,'conversation','self','Broken',?,?)`).run(alice.id,stamp,stamp), /CHECK constraint/)
    const message = store.sqlite.prepare(`INSERT INTO story_thread_messages
      (id,owner_user_id,thread_id,sequence,role,status,body,phase,created_at)
      VALUES (?,?,'thread',?,'user','queued','Hello','preparing',?)`)
    message.run('one',alice.id,1,stamp)
    assert.throws(() => message.run('two',alice.id,2,stamp), /UNIQUE constraint/)
    store.sqlite.prepare(`INSERT INTO story_thread_messages
      (id,owner_user_id,thread_id,sequence,role,status,body,phase,created_at)
      VALUES ('assistant',?,'thread',2,'assistant','delivered','Reply','preparing',?)`).run(alice.id,stamp)
    assert.throws(() => store.sqlite.prepare(`INSERT INTO generation_run_queue
      (job_id,owner_user_id,intent,phase,created_at,updated_at)
      VALUES ('job',?,'unknown','queued',?,?)`).run(alice.id,stamp,stamp), /CHECK constraint/)

    store.sqlite.prepare(`INSERT INTO pi_credentials (owner_user_id,provider,ciphertext) VALUES (?,'openai','encrypted')`).run(alice.id)
    assert.equal((store.sqlite.prepare(`SELECT revision FROM pi_credentials WHERE owner_user_id=?`).get(alice.id) as { revision: number }).revision, 1)
    store.sqlite.prepare(`INSERT INTO thread_active_pi_turns
      (job_id,pi_token,pi_session_id,work_item,created_at) VALUES ('job','token','session','work',?)`).run(stamp)

    store.sqlite.prepare("DELETE FROM repositories WHERE id='repository'").run()
    for (const table of ['stories','studio_sessions','story_conversations','story_threads',
      'story_thread_messages','thread_active_pi_turns']) {
      assert.equal((store.sqlite.prepare(`SELECT count(*) AS total FROM ${table}`).get() as {total:number}).total,0, `cascade into ${table}`)
    }
    assert.deepEqual(store.sqlite.pragma('foreign_key_check'), [])
  } finally { store.sqlite.close() }
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
      assert.equal(store.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'").get(), undefined)
      assert.equal(store.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='user'").get(), undefined)
      await migrateStudio(store, config)
    } finally { store.sqlite.close() }
    const after = checkStartup()
    assert.equal(after.status, 1)
    assert.match(after.stderr, /BETTER_AUTH_URL/)
    assert.doesNotMatch(after.stderr, /migrations are pending/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('legacy Studio data and incompatible Drizzle histories are refused without rewriting databases', async () => {
  const legacy = openStudioDatabase(':memory:')
  try {
    legacy.sqlite.exec('CREATE TABLE studio_schema_migrations (version integer primary key); INSERT INTO studio_schema_migrations (version) VALUES (27)')
    await assert.rejects(migrateStudio(legacy, config), /Incompatible legacy Studio database/)
    assert.equal(legacy.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='user'").get(), undefined)
    assert.equal((legacy.sqlite.prepare('SELECT version FROM studio_schema_migrations').get() as { version: number }).version, 27)
  } finally { legacy.sqlite.close() }

  const mismatched = openStudioDatabase(':memory:')
  try {
    await migrateStudio(mismatched, config)
    mismatched.sqlite.exec("UPDATE __drizzle_migrations SET hash='wrong'")
    assert.throws(() => assertStudioSchemaCurrent(mismatched), /incompatible/)
    await assert.rejects(migrateStudio(mismatched, config), /incompatible/)
    assert.equal((mismatched.sqlite.prepare('SELECT hash FROM __drizzle_migrations').get() as { hash: string }).hash, 'wrong')
  } finally { mismatched.sqlite.close() }

  const drifted = openStudioDatabase(':memory:')
  try {
    await migrateStudio(drifted, config)
    drifted.sqlite.exec('DROP INDEX story_thread_messages_one_preparing')
    assert.throws(() => assertStudioSchemaCurrent(drifted), /does not match its schema/)
    assert.equal(drifted.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='story_thread_messages_one_preparing'").get(), undefined)
    drifted.sqlite.exec('DROP TABLE rateLimit')
    assert.throws(() => assertStudioSchemaCurrent(drifted), /Better Auth schema is incomplete/)
  } finally { drifted.sqlite.close() }
})
