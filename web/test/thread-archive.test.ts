import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openStudioDatabase } from './support/studio-database'
import { migrateStudio } from '../src/db/migrations'
import { appendGenerationEvent, listGenerationEvents } from '../src/lib/generation-progress.server'
import { archiveThread, listStoryConversations, restoreThread } from '../src/lib/threads.server'
import { selectNavigationThreads, orderThreads } from '../src/lib/thread-navigation'

const config = {
  baseURL: 'http://localhost:3000',
  secret: 'thread-archive-integration-test-secret-01234567890',
  github: { clientId: 'test', clientSecret: 'test' },
  gitlab: { clientId: 'test', clientSecret: 'test' },
}

test('archive and restore persist, are idempotent and preserve run, history and checkpoint provenance', async () => {
  const root = mkdtempSync(join(tmpdir(), 'noveltea-thread-archive-'))
  let store = openStudioDatabase(join(root, 'studio.sqlite'))
  try {
    await migrateStudio(store, config)
    const owner = randomUUID(), stranger = randomUUID(), repo = randomUUID()
    const story = randomUUID(), job = randomUUID()
    for (const id of [owner, stranger]) store.sqlite.prepare(
      'INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)')
      .run(id, id, id + '@example.test', 1, Date.now(), Date.now())
    store.sqlite.prepare(`INSERT INTO repositories
      (id,owner_user_id,provider,provider_repository_id,name,created_at)
      VALUES (?,?,'github','repo','Repository','2026-11-01T00:00:00Z')`).run(repo, owner)
    store.sqlite.prepare(`INSERT INTO stories
      (id,owner_user_id,repository_id,directory,title,created_at)
      VALUES (?,?,?,'story','Story','2026-11-01T00:00:00Z')`).run(story, owner, repo)
    store.sqlite.prepare(`INSERT INTO studio_sessions
      (id,owner_user_id,story_id,title,status,generation_request_json,generation_thread_id,created_at,updated_at)
      VALUES (?,?,?,'Work on finale','paused','{"task":"finale"}','graph:execution','2026-11-01T00:00:00Z','2026-11-03T00:00:00Z')`)
      .run(job, owner, story)
    appendGenerationEvent(store, owner, job, {
      kind: 'verified', stage: 'foundation', files: ['creative-direction/foundation.md'],
    })
    const original = (await listStoryConversations(store, owner, story)).conversations[0]!.threads[0]!
    const archiveId = original.id
    const beforeRun = store.sqlite.prepare('SELECT * FROM story_thread_runs WHERE job_id=?').get(job)
    const beforeJob = store.sqlite.prepare('SELECT * FROM studio_sessions WHERE id=?').get(job)
    const beforeEvents = listGenerationEvents(store, owner, job, 0)
    const checkpoint = join(root, 'verified-recovery-receipt.json')
    writeFileSync(checkpoint, JSON.stringify({ job, workItem: 'foundation', verified: true }))
    const originalReceipt = readFileSync(checkpoint)
    await assert.rejects(() => archiveThread(store, stranger, archiveId), /not found/i)
    await archiveThread(store, owner, archiveId)
    const archivedAt = store.sqlite.prepare('SELECT archived_at AS archivedAt FROM story_threads WHERE id=?')
      .get(archiveId) as { archivedAt: string | null }
    assert.ok(archivedAt.archivedAt)
    await archiveThread(store, owner, archiveId)
    assert.deepEqual(store.sqlite.prepare('SELECT archived_at AS archivedAt FROM story_threads WHERE id=?')
      .get(archiveId), archivedAt, 'retry never advances the archive timestamp')
    const after = await listStoryConversations(store, owner, story)
    assert.deepEqual(selectNavigationThreads(after.conversations[0]!.threads, 'active'), [])
    assert.equal(selectNavigationThreads(after.conversations[0]!.threads, 'archived')[0]?.id, archiveId)
    assert.equal(after.conversations[0]!.threads[0]?.status, 'archived')
    assert.deepEqual(store.sqlite.prepare('SELECT * FROM story_thread_runs WHERE job_id=?').get(job), beforeRun)
    assert.deepEqual(store.sqlite.prepare('SELECT * FROM studio_sessions WHERE id=?').get(job), beforeJob)
    assert.deepEqual(listGenerationEvents(store, owner, job, 0), beforeEvents)
    assert.deepEqual(readFileSync(checkpoint), originalReceipt)

    store.sqlite.close()
    store = openStudioDatabase(join(root, 'studio.sqlite'))
    await migrateStudio(store, config)
    assert.ok((await listStoryConversations(store, owner, story)).conversations[0]!.threads[0]?.archivedAt)
    await assert.rejects(() => restoreThread(store, stranger, archiveId), /not found/i)
    await restoreThread(store, owner, archiveId)
    await restoreThread(store, owner, archiveId)
    const restored = (await listStoryConversations(store, owner, story)).conversations[0]!.threads[0]!
    assert.deepEqual(restored, { ...original }, 'restore preserves original status, title and activity')
    assert.deepEqual(store.sqlite.prepare('SELECT * FROM story_thread_runs WHERE job_id=?').get(job), beforeRun)
    assert.deepEqual(listGenerationEvents(store, owner, job, 0), beforeEvents)
    assert.deepEqual(readFileSync(checkpoint), originalReceipt)
    assert.deepEqual(store.sqlite.pragma('foreign_key_check'), [])
  } finally {
    if (store.sqlite.open) store.sqlite.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('archiving an ancestor preserves active child navigation and archived descendants keep full lineage', async () => {
  const store = openStudioDatabase(':memory:')
  try {
    await migrateStudio(store, config)
    const owner = randomUUID(), repo = randomUUID(), story = randomUUID(), job = randomUUID()
    store.sqlite.prepare('INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)')
      .run(owner, 'A', 'author@example.test', 1, Date.now(), Date.now())
    store.sqlite.prepare(`INSERT INTO repositories
      (id,owner_user_id,provider,provider_repository_id,name,created_at)
      VALUES (?,?,'github','repo','Repository','2026-11-01T00:00:00Z')`).run(repo, owner)
    store.sqlite.prepare(`INSERT INTO stories
      (id,owner_user_id,repository_id,directory,title,created_at)
      VALUES (?,?,?,'story','Story','2026-11-01T00:00:00Z')`).run(story, owner, repo)
    store.sqlite.prepare(`INSERT INTO studio_sessions
      (id,owner_user_id,story_id,title,status,created_at,updated_at)
      VALUES (?,?,?,'Job','completed','2026-11-01T00:00:00Z','2026-11-01T00:00:00Z')`).run(job, owner, story)
    const nav = await listStoryConversations(store, owner, story)
    const parent = nav.conversations[0]!.threads[0]!
    const childId = 'child:' + randomUUID(), grandchildId = 'child:' + randomUUID()
    const childJob = randomUUID()
    store.sqlite.prepare(`INSERT INTO studio_sessions
      (id,owner_user_id,story_id,title,status,created_at,updated_at)
      VALUES (?,?,?,'Child work','running','2026-11-02T00:00:00Z','2026-11-02T00:00:00Z')`)
      .run(childJob, owner, story)
    for (const [id, parentThreadId, title] of [
      [childId, parent.id, 'Active child'], [grandchildId, childId, 'Archived grandchild'],
    ]) store.sqlite.prepare(`INSERT INTO story_threads
      (id,owner_user_id,conversation_id,parent_thread_id,title,activity_at,created_at)
      VALUES (?,?,?,?,?,'2026-11-04T00:00:00Z','2026-11-04T00:00:00Z')`)
      .run(id, owner, parent.conversationId, parentThreadId, title)
    store.sqlite.prepare(`INSERT INTO story_thread_runs
      (job_id,owner_user_id,thread_id,run_order) VALUES (?,?,?,0)`)
      .run(childJob, owner, childId)
    store.sqlite.prepare(`INSERT INTO generation_run_queue
      (job_id,owner_user_id,intent,phase,created_at,updated_at)
      VALUES (?,?,'start','running','2026-11-03T00:00:00Z','2026-11-03T00:00:00Z')`)
      .run(childJob, owner)
    const childQueue = store.sqlite.prepare('SELECT * FROM generation_run_queue WHERE job_id=?').get(childJob)
    await archiveThread(store, owner, parent.id)
    await archiveThread(store, owner, grandchildId)
    const updated = await listStoryConversations(store, owner, story)
    const all = updated.conversations[0]!.threads
    const active = selectNavigationThreads(all, 'active')
    const archived = selectNavigationThreads(all, 'archived')
    assert.deepEqual(active.map(t => t.id), [childId])
    assert.deepEqual(orderThreads(active, 'tree').map(t => [t.id, t.depth]), [[childId, 0]],
      'active child remains visible when its parent is archived')
    assert.deepEqual(orderThreads(archived, 'tree').map(t => [t.id, t.depth]),
      [[parent.id, 0], [childId, 1], [grandchildId, 2]],
      'archived grandchild retains its full original ancestry in archived view')
    assert.equal(all.find(t => t.id === childId)?.archivedAt, null)
    assert.equal(all.find(t => t.id === childId)?.status, 'running')
    assert.equal(all.find(t => t.id === childId)?.jobId, childJob)
    assert.deepEqual(store.sqlite.prepare('SELECT * FROM generation_run_queue WHERE job_id=?').get(childJob),
      childQueue, 'archiving a parent does not interrupt an active child job')
    await restoreThread(store, owner, parent.id)
    assert.deepEqual(selectNavigationThreads(
      (await listStoryConversations(store, owner, story)).conversations[0]!.threads, 'active'
    ).map(t => t.id).sort(), [parent.id, childId].sort())
    assert.deepEqual(store.sqlite.pragma('foreign_key_check'), [])
  } finally { store.sqlite.close() }
})
