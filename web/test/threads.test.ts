import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { openStudioDatabase } from './support/studio-database'
import { studioSeed } from './support/studio-seed'
import { migrateStudio } from './support/studio-database'
import {
  createThread, listStoryNavigation, renameThread,
  saveThreadPreferences,
} from '../src/lib/threads.server'
import { orderThreads } from '../src/lib/thread-navigation'

const config = {
  baseURL: 'http://localhost:3000',
  secret: 'thread-navigation-test-secret-0123456789012345',
  github: { clientId: 'test', clientSecret: 'test' },
  gitlab: { clientId: 'test', clientSecret: 'test' },
}

test('Stories expose owner-scoped root Threads and meaningful progress, surviving reconnect', async () => {
  const db = openStudioDatabase(':memory:')
  try {
    await migrateStudio(db, config)
    const [alice, bob] = [randomUUID(), randomUUID()]
    const seed = studioSeed(db)
    const at = '2026-11-01T00:00:00Z'
    for (const owner of [alice, bob]) {
      (await seed.user(owner))
      ;(await seed.repository({ id: 'repo-' + owner, ownerUserId: owner, provider: 'github',
        providerRepositoryId: owner, name: 'Repo', createdAt: at }))
      ;(await seed.story({ id: 'story-' + owner, ownerUserId: owner, repositoryId: 'repo-' + owner,
        directory: 'story', title: 'The Story', createdAt: at }))
    }
    const ids = [randomUUID(), randomUUID(), randomUUID()]
    for (const [index, id] of ids.entries()) {
      (await seed.job({ id, ownerUserId: alice, storyId: 'story-' + alice,
        title: 'Chapter work', status: index === 0 ? 'running' : index === 1 ? 'paused' : 'completed',
        createdAt: at, updatedAt: '2026-11-04T00:00:00Z' }))
    }
    ;(await seed.queue({ jobId: ids[0]!, ownerUserId: alice, intent: 'start',
      phase: 'running', createdAt: '2026-11-02T02:00:00Z', updatedAt: '2026-11-02T02:00:00Z' }))
    ;(await seed.event({ jobId: ids[0]!, ownerUserId: alice, kind: 'working', stage: 'event',
      milestone: 'arc.one', filesJson: '[]', status: null, createdAt: '2026-11-02T03:00:00Z' }))
    const first = await listStoryNavigation(db, alice, 'story-' + alice)
    assert.equal(first.threads.length, 3)
    const running = first.threads.find(t => t.jobId === ids[0])
    assert.equal(running?.status, 'running')
    assert.equal(running?.currentWork, 'Event · arc.one')
    assert.equal(running?.activityAt, '2026-11-02T03:00:00Z')
    await renameThread(db, alice, running!.id, 'Character branch')
    assert.equal((await listStoryNavigation(db, alice, 'story-' + alice)).threads.find(t => t.id === running!.id)?.title, 'Character branch')
    // An updated_at heartbeat must not move a job or silently generate new IDs.
    ;(await db.testing.records.update('studio_sessions', { id: ids[1] }, { updatedAt: '2099-01-01T00:00:00Z' }))
    const second = await listStoryNavigation(db, alice, 'story-' + alice)
    assert.deepEqual(second.threads.map(c => c.id), first.threads.map(c => c.id))
    assert.equal(second.threads.find(t => t.jobId === ids[1])?.activityAt,
      '2026-11-01T00:00:00Z')
    ;(await db.testing.records.update('studio_sessions', { id: ids[1] }, { generationRequestJson: '{}' }))
    ;(await db.testing.records.update('story_thread_runs', { jobId: ids[1] }, { needsAuthor: 1 }))
    assert.equal((await listStoryNavigation(db, alice, 'story-' + alice)).threads.find(t => t.jobId === ids[1])?.status, 'needs-author')
    const branchId = 'branch:' + randomUUID(), parent = running!.id
    ;(await db.testing.records.insert('story_threads', { id: branchId, ownerUserId: alice,
      storyId: 'story-' + alice, parentThreadId: parent, title: 'Alternative',
      activityAt: '2026-11-04T00:00:00Z', createdAt: '2026-11-04T00:00:00Z' }))
    const nested = (await listStoryNavigation(db, alice, 'story-' + alice))
      .threads.filter(t => t.id === parent || t.parentThreadId === parent)
    assert.deepEqual(orderThreads(nested, 'tree').map(row => [row.id, row.depth]),
      [[parent, 0], [branchId, 1]])
    await assert.rejects(async () => (await db.testing.records.insert('story_threads', {
      id: 'cross:' + randomUUID(), ownerUserId: alice,
      storyId: 'story-' + bob,
      parentThreadId: parent, title: 'Crossed', activityAt: '2026-11-04T00:00:00Z',
      createdAt: '2026-11-04T00:00:00Z',
    })), /FOREIGN KEY/, 'a branch cannot cross Stories or owners')
    await assert.rejects(() => listStoryNavigation(db, bob, 'story-' + alice), /not found/i)
    await assert.rejects(() => renameThread(db, bob, running!.id, 'Stolen'), /not found/i)
    assert.deepEqual((await db.testing.foreignKeyViolations()), [])
  } finally { db.close() }
})

test('authors can create, rename and persist navigation preferences, with bounds and cross-tenant refusal', async () => {
  const db = openStudioDatabase(':memory:')
  try {
    await migrateStudio(db, config)
    const alice = randomUUID(), bob = randomUUID(), story = randomUUID(), repo = randomUUID()
    const seed = studioSeed(db)
    for (const id of [alice, bob]) { await seed.user(id) }
    (await seed.repository({ id: repo, ownerUserId: alice, provider: 'github',
      providerRepositoryId: 'repo', name: 'Repo', createdAt: 'now' }))
    ;(await seed.story({ id: story, ownerUserId: alice, repositoryId: repo,
      directory: 'story', title: 'Story', createdAt: 'now' }))
    const thread = await createThread(db, alice, story)
    assert.match(thread.title, /New Thread/)
    assert.equal((await listStoryNavigation(db, alice, story)).threads.length, 1)
    await renameThread(db, alice, thread.id, 'Character alternatives')
    assert.equal((await listStoryNavigation(db, alice, story)).threads[0]?.title, 'Character alternatives')
    await assert.rejects(() => createThread(db, bob, story), /not found/i)
    await assert.rejects(() => saveThreadPreferences(db, bob, story, 'flat', []), /not found/i)
    await assert.rejects(() => renameThread(db, alice, thread.id, ' '.repeat(5)), /title/i)
    await assert.rejects(() => renameThread(db, alice, thread.id, 'X'.repeat(121)), /title/i)
    await saveThreadPreferences(db, alice, story, 'flat', ['root-1', 'root-1', 'root-2'])
    assert.deepEqual((await listStoryNavigation(db, alice, story)).preferences,
      { view: 'flat', expandedIds: ['root-1', 'root-2'], collapsedCollectionIds: [] })
    assert.deepEqual((await db.testing.foreignKeyViolations()), [])
  } finally { db.close() }
})

test('Thread tree promotes active descendants while flat view globally sorts by own activity', () => {
  const threads = [
    { id: 'a', parentThreadId: null, activityAt: '2026-11-01T00:00:00Z' },
    { id: 'b', parentThreadId: null, activityAt: '2026-11-03T00:00:00Z' },
    { id: 'a-child', parentThreadId: 'a', activityAt: '2026-11-04T00:00:00Z' },
    { id: 'a-old', parentThreadId: 'a', activityAt: '2026-11-02T00:00:00Z' },
  ]
  const tree = orderThreads(threads, 'tree')
  assert.deepEqual(tree.map(row => [row.id, row.depth]), [
    ['a', 0], ['a-child', 1], ['a-old', 1], ['b', 0],
  ])
  assert.deepEqual(orderThreads(threads, 'flat').map(row => row.id),
    ['a-child', 'b', 'a-old', 'a'])
  assert.deepEqual(orderThreads([
    { id: 'before', parentThreadId: null, activityAt: '2026-11-04T00:00:00Z' },
    { id: 'after', parentThreadId: null, activityAt: '2026-11-04T00:00:00.100Z' },
  ], 'flat').map(row => row.id), ['after', 'before'],
  'fractional seconds must not be incorrectly ordered before whole seconds')
})
