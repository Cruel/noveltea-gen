import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { openStudioDatabase } from './support/studio-database'
import { submitThreadRevision } from '../src/lib/story-revision.server'
import { migrateStudio, assertStudioSchemaCurrent } from '../src/db/migrations'
import {
  readThreadChat, enqueueThreadMessage, advanceThread, settleThreadRun, recoverSettledThreadRuns,
} from '../src/lib/thread-chat.server'

const config = {
  baseURL: 'http://localhost:3000',
  secret: 'thread-chat-test-secret-0123456789012345',
  github: { clientId: 'test', clientSecret: 'test' },
  gitlab: { clientId: 'test', clientSecret: 'test' },
}

async function setup() {
  const db = openStudioDatabase(':memory:')
  await migrateStudio(db, config)
  const [alice, bob] = [randomUUID(), randomUUID()]
  const story = randomUUID(), repo = randomUUID()
  for (const owner of [alice, bob]) {
    db.sqlite.prepare('INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)')
      .run(owner, 'Author', owner + '@example.test', 1, Date.now(), Date.now())
  }
  db.sqlite.prepare(`INSERT INTO repositories
    (id,owner_user_id,provider,provider_repository_id,name,created_at)
    VALUES (?,?,'github','123','Repo','2026-11-01T00:00:00Z')`).run(repo, alice)
  db.sqlite.prepare(`INSERT INTO stories (id,owner_user_id,repository_id,directory,title,created_at)
    VALUES (?,?,?,'story','Story','2026-11-01T00:00:00Z')`).run(story, alice, repo)
  const conversation = randomUUID(), id = randomUUID(), job = randomUUID()
  db.sqlite.prepare(`INSERT INTO story_conversations
    (id,owner_user_id,story_id,title,created_at,updated_at)
    VALUES (?,?,?,'Story chat','2026-11-01T00:00:00Z','2026-11-01T00:00:00Z')`)
    .run(conversation, alice, story)
  db.sqlite.prepare(`INSERT INTO story_threads
    (id,owner_user_id,conversation_id,title,activity_at,created_at)
    VALUES (?,?,?,'Thread','2026-11-01T00:00:00Z','2026-11-01T00:00:00Z')`)
    .run(id, alice, conversation)
  db.sqlite.prepare(`INSERT INTO studio_sessions
    (id,owner_user_id,story_id,title,source_commit_sha,status,created_at,updated_at,generation_request_json)
    VALUES (?,?,?,'Root',?,'completed','2026-11-01T00:00:00Z','2026-11-01T00:00:00Z',?)`)
    .run(job, alice, story, 'a'.repeat(40), JSON.stringify({
      task: 'Original author request', fixture: true,
    }))
  db.sqlite.prepare(`INSERT INTO story_thread_runs
    (job_id,owner_user_id,thread_id,run_order) VALUES (?,?,?,0)`).run(job, alice, id)
  db.sqlite.prepare(`INSERT INTO generation_run_queue
    (job_id,owner_user_id,intent,phase,created_at,updated_at)
    VALUES (?,?,'start','finished','2026-11-01T00:00:00Z','2026-11-01T00:00:00Z')`)
    .run(job, alice)
  db.sqlite.prepare(`INSERT INTO generation_events
    (job_id,owner_user_id,kind,stage,milestone,files_json,status,created_at)
    VALUES (?,?,'finished',NULL,NULL,'[]','completed','2026-11-01T00:00:00Z')`)
    .run(job, alice)
  return { db, alice, bob, id, story, conversation, job }
}

test('Thread chat is immutable, ordered, owner-scoped, reconnectable and honest about fixture evidence', async () => {
  const { db, alice, bob, id, job } = await setup()
  try {
    assertStudioSchemaCurrent(db)
    const initial = (await readThreadChat(db, alice, id))
    assert.deepEqual(initial.messages.map(message => message.role), ['user', 'assistant'])
    assert.equal(initial.messages[0]?.content, 'Original author request')
    assert.match(initial.messages[1]!.content, /not independently validated/)
    assert.deepEqual(initial.evidence.map(event => event.kind), ['finished'])
    await assert.rejects(() => readThreadChat(db, bob, id), /not found/)
    const id1 = randomUUID(), id2 = randomUUID()
    const sent1 = (await enqueueThreadMessage(db, alice, id, id1, 'Please expand the ending.'))
    const sent2 = (await enqueueThreadMessage(db, alice, id, id2, 'Then explore the aftermath.'))
    assert.equal(sent1.phase, 'queued')
    assert.ok(sent1.sequence < sent2.sequence)
    assert.deepEqual((await enqueueThreadMessage(db, alice, id, id1, 'Please expand the ending.')), sent1)
    await assert.rejects(() => enqueueThreadMessage(db, alice, id, id1, 'Different message'), /already in use/)
    await assert.rejects(() => enqueueThreadMessage(db, bob, id, randomUUID(), 'Unauthorized'), /not found/)
    await assert.rejects(() => enqueueThreadMessage(db, bob, id, id1, 'Please expand the ending.'), /not found/)
    const reopened = (await readThreadChat(db, alice, id))
    assert.deepEqual(reopened.messages.map(message => message.content),
      ['Original author request', initial.messages[1]!.content, sent1.content, sent2.content])
    assert.deepEqual(reopened.messages.filter(item => item.role === 'user').map(item => item.phase),
      ['finished', 'queued', 'queued'])
    assert.deepEqual(db.sqlite.pragma('foreign_key_check'), [])
    assert.equal(reopened.runs[0]?.jobId, job)
  } finally { db.sqlite.close() }
})

test('same-Thread messages cannot compete during admission or after unsafe preparation', async () => {
  const { db, alice, id, job } = await setup()
  try {
    const first = randomUUID(), next = randomUUID()
    await enqueueThreadMessage(db, alice, id, first, 'First follow-up')
    await enqueueThreadMessage(db, alice, id, next, 'Second follow-up')
    db.sqlite.prepare(`UPDATE story_thread_messages SET phase='preparing',source_job_id=?
      WHERE id=?`).run(job, first)
    await advanceThread(db, alice, id)
    assert.deepEqual((await readThreadChat(db, alice, id)).messages.slice(-2).map(item => item.phase),
      ['preparing', 'queued'])
    db.sqlite.prepare(`UPDATE story_thread_messages SET phase='queued' WHERE id=?`).run(first)
    // An unscoped queued instruction remains durable and cannot be admitted
    // or leapfrogged until its exact source scope is reviewed.
    await advanceThread(db, alice, id)
    const messages = (await readThreadChat(db, alice, id)).messages
    assert.equal(messages.find(item => item.id === first)?.phase, 'queued')
    assert.equal(messages.find(item => item.id === next)?.phase, 'queued')
    assert.equal(messages.at(-1)?.content, 'Second follow-up')
    await advanceThread(db, alice, id)
    assert.equal((db.sqlite.prepare(`SELECT count(*) AS total FROM story_thread_runs
      WHERE thread_id=?`).get(id) as { total: number }).total, 1)
    assert.deepEqual(db.sqlite.pragma('foreign_key_check'), [])
  } finally { db.sqlite.close() }
})

test('public Thread submission durably queues rapid messages without authorizing a future HEAD', async () => {
  const { db, alice, bob, id, job } = await setup()
  try {
    db.sqlite.prepare('UPDATE studio_sessions SET status=? WHERE id=?').run('running', job)
    db.sqlite.prepare('UPDATE generation_run_queue SET phase=? WHERE job_id=?').run('running', job)
    const first = randomUUID(), second = randomUUID()
    const a = await submitThreadRevision(db, alice, id, first, 'Change character.nia')
    const b = await submitThreadRevision(db, alice, id, second, 'Then revise event.bell')
    assert.equal(a.phase, 'queued')
    assert.ok(a.sequence < b.sequence)
    assert.deepEqual(await submitThreadRevision(db, alice, id, first, 'Change character.nia'), a)
    const staleApprovalId = randomUUID()
    const stale = await submitThreadRevision(db, alice, id, staleApprovalId,
      'Change character.nia', undefined, 'a'.repeat(64))
    assert.equal(stale.phase, 'queued')
    assert.equal(stale.hasRevisionScope, 0,
      'a future-HEAD approval is never applied to a later queued request')
    await assert.rejects(submitThreadRevision(db, bob, id, randomUUID(),
      'Change character.nia'), /no source generation run|not found/)
    assert.deepEqual(db.sqlite.prepare(`SELECT revision_scope_json AS scope FROM story_thread_messages
      WHERE id IN (?,?) ORDER BY sequence`).all(first, second), [{ scope: null }, { scope: null }])
    await advanceThread(db, alice, id)
    assert.deepEqual((await readThreadChat(db, alice, id)).messages.filter(m => m.phase === 'queued')
      .map(m => m.content), ['Change character.nia', 'Then revise event.bell', 'Change character.nia'])
    assert.equal((db.sqlite.prepare('SELECT COUNT(*) AS total FROM story_thread_runs').get() as
      { total: number }).total, 1)
  } finally { db.sqlite.close() }
})

test('agent restart reconciles a terminal queue receipt without replaying its writer', async () => {
  const { db, alice, id, job } = await setup()
  try {
    const message = randomUUID()
    db.sqlite.prepare(`INSERT INTO story_thread_messages
      (id,owner_user_id,thread_id,sequence,role,status,body,phase,job_id,created_at)
      VALUES (?,?,?,2,'user','queued','Sent before the crash','running',?,'now')`)
      .run(message, alice, id, job)
    await recoverSettledThreadRuns(db)
    await recoverSettledThreadRuns(db)
    const chat = (await readThreadChat(db, alice, id))
    assert.equal(chat.messages.find(item => item.id === message)?.phase, 'finished')
    assert.equal(chat.messages.filter(item => item.id === 'assistant:' + job).length, 1)
    assert.equal(chat.runs.length, 1)
  } finally { db.sqlite.close() }
})

test('paused settlement remains immutable and a later completion appends a fresh assistant outcome', async () => {
  const { db, alice, id, job } = await setup()
  try {
    const initial = (await readThreadChat(db, alice, id))
    assert.equal(initial.messages.filter(m => m.role === 'assistant').length, 1)
    db.sqlite.prepare(`UPDATE studio_sessions SET status='paused' WHERE id=?`).run(job)
    const paused = (await readThreadChat(db, alice, id))
    assert.equal(paused.messages.filter(m => m.role === 'assistant').length, 2)
    assert.match(paused.messages.at(-1)?.content ?? '', /paused/i)
    db.sqlite.prepare(`UPDATE studio_sessions SET status='completed' WHERE id=?`).run(job)
    const completed = (await readThreadChat(db, alice, id))
    const summaries = completed.messages.filter(m => m.role === 'assistant')
    assert.equal(summaries.length, 3)
    assert.match(summaries.at(-1)?.content ?? '', /finished/i)
    assert.match(summaries.at(-2)?.content ?? '', /paused/i)
    assert.equal((await readThreadChat(db, alice, id)).messages.filter(m => m.role === 'assistant').length, 3)
    assert.equal(new Set(summaries.map(m => m.id)).size, 3)
  } finally { db.sqlite.close() }
})

test('settlement appends an assistant response on changed status; incomplete work cannot admit the queued follow-up', async () => {
  const { db, alice, id, job } = await setup()
  try {
    const messageId = randomUUID()
    await enqueueThreadMessage(db, alice, id, messageId, 'Follow-up while blocked')
    db.sqlite.prepare(`UPDATE studio_sessions SET status='blocked' WHERE id=?`).run(job)
    await settleThreadRun(db, alice, job)
    await settleThreadRun(db, alice, job)
    const chat = (await readThreadChat(db, alice, id))
    assert.equal(chat.messages.filter(m => m.role === 'assistant').length, 2)
    assert.match(chat.messages.filter(m => m.role === 'assistant').at(-1)?.content ?? '', /blocked/i)
    assert.equal(chat.messages.find(m => m.id === messageId)?.phase, 'queued')
    assert.equal(chat.runs.at(-1)?.status, 'blocked')
    assert.deepEqual(db.sqlite.pragma('foreign_key_check'), [])
  } finally { db.sqlite.close() }
})
