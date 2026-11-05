import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { openStudioDatabase } from '../src/db/connection'
import { migrateStudio } from '../src/db/migrations'
import {
  createConversation, listStoryConversations, renameConversation, renameThread,
  saveThreadPreferences,
} from '../src/lib/threads.server'
import { orderThreads } from '../src/lib/thread-navigation'

const config = {
  baseURL: 'http://localhost:3000',
  secret: 'thread-navigation-test-secret-0123456789012345',
  github: { clientId: 'test', clientSecret: 'test' },
  gitlab: { clientId: 'test', clientSecret: 'test' },
}

test('Story Conversations expose owner-scoped legacy root Threads and meaningful progress, surviving reconnect', async () => {
  const db = openStudioDatabase(':memory:')
  try {
    await migrateStudio(db, config)
    const [alice, bob] = [randomUUID(), randomUUID()]
    for (const owner of [alice, bob]) {
      db.sqlite.prepare('INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)')
        .run(owner, 'Author', owner + '@example.test', 1, Date.now(), Date.now())
      db.sqlite.prepare(`INSERT INTO repositories (id,owner_user_id,provider,provider_repository_id,name,created_at)
        VALUES (?,?,'github',?,'Repo','2026-11-01T00:00:00Z')`).run('repo-' + owner, owner, owner)
      db.sqlite.prepare(`INSERT INTO stories (id,owner_user_id,repository_id,directory,title,created_at)
        VALUES (?,?,?,'story','The Story','2026-11-01T00:00:00Z')`).run('story-' + owner, owner, 'repo-' + owner)
    }
    const ids = [randomUUID(), randomUUID(), randomUUID()]
    for (const [index, id] of ids.entries()) {
      db.sqlite.prepare(`INSERT INTO studio_sessions
        (id,owner_user_id,story_id,title,status,created_at,updated_at)
        VALUES (?,?,?,'Chapter work',?,'2026-11-01T00:00:00Z','2026-11-04T00:00:00Z')`)
        .run(id, alice, 'story-' + alice, index === 0 ? 'running' : index === 1 ? 'paused' : 'completed')
    }
    db.sqlite.prepare(`INSERT INTO generation_run_queue
      (job_id,owner_user_id,intent,phase,created_at,updated_at)
      VALUES (?,?,'start','running','2026-11-02T02:00:00Z','2026-11-02T02:00:00Z')`).run(ids[0], alice)
    db.sqlite.prepare(`INSERT INTO generation_events
      (job_id,owner_user_id,kind,stage,milestone,files_json,status,created_at)
      VALUES (?,?,'working','event','arc.one','[]',NULL,'2026-11-02T03:00:00Z')`).run(ids[0], alice)
    const first = await listStoryConversations(db, alice, 'story-' + alice)
    assert.equal(first.conversations.length, 3)
    assert.equal(first.conversations.every(item => item.threads.length === 1), true)
    const running = first.conversations.flatMap(c => c.threads).find(t => t.jobId === ids[0])
    assert.equal(running?.status, 'running')
    assert.equal(running?.currentWork, 'Event · arc.one')
    assert.equal(running?.activityAt, '2026-11-02T03:00:00Z')
    renameThread(db, alice, running!.id, 'Character branch')
    assert.equal((await listStoryConversations(db, alice, 'story-' + alice)).conversations
      .flatMap(c => c.threads).find(t => t.id === running!.id)?.title, 'Character branch')
    // An updated_at heartbeat must not move a job or silently generate new IDs.
    db.sqlite.prepare("UPDATE studio_sessions SET updated_at='2099-01-01T00:00:00Z' WHERE id=?").run(ids[1])
    const second = await listStoryConversations(db, alice, 'story-' + alice)
    assert.deepEqual(second.conversations.map(c => c.id), first.conversations.map(c => c.id))
    assert.equal(second.conversations.flatMap(c => c.threads).find(t => t.jobId === ids[1])?.activityAt,
      '2026-11-01T00:00:00Z')
    db.sqlite.prepare("UPDATE studio_sessions SET generation_request_json='{}' WHERE id=?").run(ids[1])
    db.sqlite.prepare('UPDATE story_thread_runs SET needs_author=1 WHERE job_id=?').run(ids[1])
    assert.equal((await listStoryConversations(db, alice, 'story-' + alice)).conversations
      .flatMap(c => c.threads).find(t => t.jobId === ids[1])?.status, 'needs-author')
    const branchId = 'branch:' + randomUUID(), parent = running!.id
    const parentConversation = first.conversations.find(c => c.threads.some(t => t.id === parent))!.id
    db.sqlite.prepare(`INSERT INTO story_threads
      (id,owner_user_id,conversation_id,parent_thread_id,title,activity_at,created_at)
      VALUES (?,?,?,?,'Alternative','2026-11-04T00:00:00Z','2026-11-04T00:00:00Z')`)
      .run(branchId, alice, parentConversation, parent)
    const nested = (await listStoryConversations(db, alice, 'story-' + alice))
      .conversations.find(c => c.id === parentConversation)!.threads
    assert.deepEqual(orderThreads(nested, 'tree').map(row => [row.id, row.depth]),
      [[parent, 0], [branchId, 1]])
    assert.throws(() => db.sqlite.prepare(`INSERT INTO story_threads
      (id,owner_user_id,conversation_id,parent_thread_id,title,activity_at,created_at)
      VALUES (?,?,?,?,'Crossed','2026-11-04T00:00:00Z','2026-11-04T00:00:00Z')`)
      .run('cross:' + randomUUID(), alice, first.conversations.find(c => c.id !== parentConversation)!.id,
        parent), /FOREIGN KEY/, 'a branch cannot cross Conversations')
    await assert.rejects(() => listStoryConversations(db, bob, 'story-' + alice), /not found/i)
    assert.throws(() => renameThread(db, bob, running!.id, 'Stolen'), /not found/i)
    assert.throws(() => renameConversation(db, bob, first.conversations[0]!.id, 'Stolen'), /not found/i)
    assert.deepEqual(db.sqlite.pragma('foreign_key_check'), [])
  } finally { db.sqlite.close() }
})

test('authors can create, rename and persist navigation preferences, with bounds and cross-tenant refusal', async () => {
  const db = openStudioDatabase(':memory:')
  try {
    await migrateStudio(db, config)
    const alice = randomUUID(), bob = randomUUID(), story = randomUUID(), repo = randomUUID()
    for (const id of [alice, bob]) db.sqlite.prepare(
      'INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)')
      .run(id, id, id + '@test.local', 1, Date.now(), Date.now())
    db.sqlite.prepare(`INSERT INTO repositories (id,owner_user_id,provider,provider_repository_id,name,created_at)
      VALUES (?,?,'github','repo','Repo','now')`).run(repo, alice)
    db.sqlite.prepare(`INSERT INTO stories (id,owner_user_id,repository_id,directory,title,created_at)
      VALUES (?,?,?,'story','Story','now')`).run(story, alice, repo)
    const conversation = createConversation(db, alice, story)
    assert.match(conversation.title, /New conversation/)
    assert.equal((await listStoryConversations(db, alice, story)).conversations.length, 1)
    renameConversation(db, alice, conversation.id, 'Character alternatives')
    assert.equal((await listStoryConversations(db, alice, story)).conversations[0]?.title, 'Character alternatives')
    assert.throws(() => createConversation(db, bob, story), /not found/i)
    await assert.rejects(() => saveThreadPreferences(db, bob, story, 'flat', []), /not found/i)
    assert.throws(() => renameConversation(db, alice, conversation.id, ' '.repeat(5)), /title/i)
    assert.throws(() => renameConversation(db, alice, conversation.id, 'X'.repeat(121)), /title/i)
    await saveThreadPreferences(db, alice, story, 'flat', ['root-1', 'root-1', 'root-2'])
    assert.deepEqual((await listStoryConversations(db, alice, story)).preferences,
      { view: 'flat', expandedIds: ['root-1', 'root-2'] })
    assert.deepEqual(db.sqlite.pragma('foreign_key_check'), [])
  } finally { db.sqlite.close() }
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
