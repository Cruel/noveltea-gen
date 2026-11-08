import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openStudioDatabase } from './support/studio-database'
import { studioSeed } from './support/studio-seed'
import { migrateStudio } from '../src/db/migrations'
import { appendGenerationEvent, listGenerationEvents } from '../src/lib/generation-progress.server'
import { archiveThread, listStoryNavigation, restoreThread } from '../src/lib/threads.server'
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
    const seed = studioSeed(store)
    for (const id of [owner, stranger]) (await seed.user(id))
    const at = '2026-11-01T00:00:00Z'
    ;(await seed.repository({ id: repo, ownerUserId: owner, provider: 'github',
      providerRepositoryId: 'repo', name: 'Repository', createdAt: at }))
    ;(await seed.story({ id: story, ownerUserId: owner, repositoryId: repo,
      directory: 'story', title: 'Story', createdAt: at }))
    ;(await seed.job({ id: job, ownerUserId: owner, storyId: story, title: 'Work on finale',
      status: 'paused', generationRequestJson: '{"task":"finale"}',
      generationThreadId: 'graph:execution', createdAt: at,
      updatedAt: '2026-11-03T00:00:00Z' }))
    await appendGenerationEvent(store, owner, job, {
      kind: 'verified', stage: 'foundation', files: ['creative-direction/foundation.md'],
    })
    const original = (await listStoryNavigation(store, owner, story)).threads[0]!
    const archiveId = original.id
    const beforeRun = (await store.testing.records.first('story_thread_runs', { jobId: job }))
    const beforeJob = (await store.testing.records.first('studio_sessions', { id: job }))
    const beforeEvents = (await listGenerationEvents(store, owner, job, 0))
    const checkpoint = join(root, 'verified-recovery-receipt.json')
    writeFileSync(checkpoint, JSON.stringify({ job, workItem: 'foundation', verified: true }))
    const originalReceipt = readFileSync(checkpoint)
    await assert.rejects(() => archiveThread(store, stranger, archiveId), /not found/i)
    await archiveThread(store, owner, archiveId)
    const archivedAt = (await store.testing.records.first<{ archivedAt: string | null }>('story_threads', { id: archiveId }))!
    assert.ok(archivedAt.archivedAt)
    await archiveThread(store, owner, archiveId)
    assert.deepEqual((await store.testing.records.first<{ archivedAt: string | null }>('story_threads', { id: archiveId })), archivedAt, 'retry never advances the archive timestamp')
    const after = await listStoryNavigation(store, owner, story)
    assert.deepEqual(selectNavigationThreads(after.threads, 'active'), [])
    assert.equal(selectNavigationThreads(after.threads, 'archived')[0]?.id, archiveId)
    assert.equal(after.threads[0]?.status, 'archived')
    assert.deepEqual((await store.testing.records.first('story_thread_runs', { jobId: job })), beforeRun)
    assert.deepEqual((await store.testing.records.first('studio_sessions', { id: job })), beforeJob)
    assert.deepEqual((await listGenerationEvents(store, owner, job, 0)), beforeEvents)
    assert.deepEqual(readFileSync(checkpoint), originalReceipt)

    store.close()
    store = openStudioDatabase(join(root, 'studio.sqlite'))
    await migrateStudio(store, config)
    assert.ok((await listStoryNavigation(store, owner, story)).threads[0]?.archivedAt)
    await assert.rejects(() => restoreThread(store, stranger, archiveId), /not found/i)
    await restoreThread(store, owner, archiveId)
    await restoreThread(store, owner, archiveId)
    const restored = (await listStoryNavigation(store, owner, story)).threads[0]!
    assert.deepEqual(restored, { ...original }, 'restore preserves original status, title and activity')
    assert.deepEqual((await store.testing.records.first('story_thread_runs', { jobId: job })), beforeRun)
    assert.deepEqual((await listGenerationEvents(store, owner, job, 0)), beforeEvents)
    assert.deepEqual(readFileSync(checkpoint), originalReceipt)
    assert.deepEqual((await store.testing.foreignKeyViolations()), [])
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('archiving an ancestor preserves active child navigation and archived descendants keep full lineage', async () => {
  const store = openStudioDatabase(':memory:')
  try {
    await migrateStudio(store, config)
    const owner = randomUUID(), repo = randomUUID(), story = randomUUID(), job = randomUUID()
    const seed = studioSeed(store)
    ;(await seed.user(owner))
    const at = '2026-11-01T00:00:00Z'
    ;(await seed.repository({ id: repo, ownerUserId: owner, provider: 'github',
      providerRepositoryId: 'repo', name: 'Repository', createdAt: at }))
    ;(await seed.story({ id: story, ownerUserId: owner, repositoryId: repo,
      directory: 'story', title: 'Story', createdAt: at }))
    ;(await seed.job({ id: job, ownerUserId: owner, storyId: story, title: 'Job',
      status: 'completed', createdAt: at, updatedAt: at }))
    const nav = await listStoryNavigation(store, owner, story)
    const parent = nav.threads[0]!
    const childId = 'child:' + randomUUID(), grandchildId = 'child:' + randomUUID()
    const childJob = randomUUID()
    ;(await seed.job({ id: childJob, ownerUserId: owner, storyId: story, title: 'Child work',
      status: 'running', sourceCommitSha: 'a'.repeat(40), createdAt: '2026-11-02T00:00:00Z',
      updatedAt: '2026-11-02T00:00:00Z' }))
    for (const [id, parentThreadId, title] of [
      [childId, parent.id, 'Active child'], [grandchildId, childId, 'Archived grandchild'],
    ] as const) {
      ;(await seed.thread({ id, ownerUserId: owner, storyId: parent.storyId,
        parentThreadId, title, activityAt: '2026-11-04T00:00:00Z',
        createdAt: '2026-11-04T00:00:00Z' }))
    }
    await seed.forkReceipt(childJob, owner, job, parent.id, 'a'.repeat(40), at)
    ;(await seed.threadRun({ jobId: childJob, ownerUserId: owner, threadId: childId, runOrder: 0 }))
    ;(await seed.queue({ jobId: childJob, ownerUserId: owner, intent: 'start',
      phase: 'running', createdAt: '2026-11-03T00:00:00Z',
      updatedAt: '2026-11-03T00:00:00Z' }))
    const childQueue = (await store.testing.records.first('generation_run_queue', { jobId: childJob }))
    await archiveThread(store, owner, parent.id)
    await archiveThread(store, owner, grandchildId)
    const updated = await listStoryNavigation(store, owner, story)
    const all = updated.threads
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
    assert.deepEqual((await store.testing.records.first('generation_run_queue', { jobId: childJob })),
      childQueue, 'archiving a parent does not interrupt an active child job')
    await restoreThread(store, owner, parent.id)
    assert.deepEqual(selectNavigationThreads(
      (await listStoryNavigation(store, owner, story)).threads, 'active'
    ).map(t => t.id).sort(), [parent.id, childId].sort())
    assert.deepEqual((await store.testing.foreignKeyViolations()), [])
  } finally { store.close() }
})
