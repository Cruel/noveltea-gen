import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { openStudioDatabase } from './support/studio-database'
import { studioSeed } from './support/studio-seed'
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
  const seed = studioSeed(db)
  for (const owner of [alice, bob]) (await seed.user(owner))
  const at = '2026-11-01T00:00:00Z'
  ;(await seed.repository({ id: repo, ownerUserId: alice, provider: 'github',
    providerRepositoryId: '123', name: 'Repo', createdAt: at }))
  ;(await seed.story({ id: story, ownerUserId: alice, repositoryId: repo,
    directory: 'story', title: 'Story', createdAt: at }))
  const id = randomUUID(), job = randomUUID()
  ;(await seed.thread({ id, ownerUserId: alice, storyId: story,
    title: 'Thread', activityAt: at, createdAt: at }))
  ;(await seed.job({ id: job, ownerUserId: alice, storyId: story, title: 'Root',
    sourceCommitSha: 'a'.repeat(40), status: 'completed', createdAt: at,
    updatedAt: at, generationRequestJson: JSON.stringify({
      task: 'Original author request', fixture: true,
    }) }))
  ;(await seed.threadRun({ jobId: job, ownerUserId: alice, threadId: id, runOrder: 0 }))
  ;(await seed.queue({ jobId: job, ownerUserId: alice, intent: 'start', phase: 'finished',
    createdAt: at, updatedAt: at }))
  ;(await seed.event({ jobId: job, ownerUserId: alice, kind: 'finished',
    stage: null, milestone: null, filesJson: '[]', status: 'completed', createdAt: at }))
  return { db, alice, bob, id, story, job }
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
    assert.deepEqual((await db.testing.foreignKeyViolations()), [])
    assert.equal(reopened.runs[0]?.jobId, job)
    assert.equal(reopened.turnReceipts.find(turn => turn.id === id1)?.outcome, 'queued')
    assert.equal(reopened.turnReceipts.find(turn => turn.id === id2)?.executions.length, 0)
  } finally { db.close() }
})

test('same-Thread messages cannot compete during admission or after unsafe preparation', async () => {
  const { db, alice, id, job } = await setup()
  try {
    const first = randomUUID(), next = randomUUID()
    await enqueueThreadMessage(db, alice, id, first, 'First follow-up')
    await enqueueThreadMessage(db, alice, id, next, 'Second follow-up')
    ;(await db.testing.records.update('story_thread_messages', { id: first },
      { phase: 'preparing', sourceJobId: job }))
    await advanceThread(db, alice, id)
    assert.deepEqual((await readThreadChat(db, alice, id)).messages.slice(-2).map(item => item.phase),
      ['preparing', 'queued'])
    ;(await db.testing.records.update('story_thread_messages', { id: first }, { phase: 'queued' }))
    // An unscoped queued instruction remains durable and cannot be admitted
    // or leapfrogged until its exact source scope is reviewed.
    await advanceThread(db, alice, id)
    const messages = (await readThreadChat(db, alice, id)).messages
    assert.equal(messages.find(item => item.id === first)?.phase, 'queued')
    assert.equal(messages.find(item => item.id === next)?.phase, 'queued')
    assert.equal(messages.at(-1)?.content, 'Second follow-up')
    await advanceThread(db, alice, id)
    assert.equal((await db.testing.records.count('story_thread_runs', { threadId: id })), 1)
    assert.deepEqual((await db.testing.foreignKeyViolations()), [])
  } finally { db.close() }
})

test('public Thread submission durably queues rapid messages without authorizing a future HEAD', async () => {
  const { db, alice, bob, id, job } = await setup()
  try {
    ;(await db.testing.records.update('studio_sessions', { id: job }, { status: 'running' }))
    ;(await db.testing.records.update('generation_run_queue', { jobId: job }, { phase: 'running' }))
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
    assert.deepEqual(await Promise.all([first, second].map(async id => ({ scope:
      (await db.testing.records.first<{ revisionScopeJson: string | null }>('story_thread_messages', { id }))?.revisionScopeJson,
    }))), [{ scope: null }, { scope: null }])
    await advanceThread(db, alice, id)
    assert.deepEqual((await readThreadChat(db, alice, id)).messages.filter(m => m.phase === 'queued')
      .map(m => m.content), ['Change character.nia', 'Then revise event.bell', 'Change character.nia'])
    assert.equal((await db.testing.records.count('story_thread_runs')), 1)
  } finally { db.close() }
})

test('a fenced interrupted writer remains blocked across reconnect and denies other owners', async () => {
  const { db, alice, bob, id, job } = await setup()
  try {
    ;(await db.testing.records.update('studio_sessions', { id: job }, { status: 'running' }))
    ;(await db.testing.records.update('generation_run_queue', { jobId: job },
      { phase: 'interrupted' }))
    const before = await readThreadChat(db, alice, id)
    const after = await readThreadChat(db, alice, id)
    assert.equal(before.runs[0]?.status, 'interrupted')
    assert.equal(after.runs[0]?.status, 'interrupted')
    assert.equal(after.turnReceipts[0]?.executions[0]?.validatedSha, null,
      'a stale terminal event cannot confer verified completion on an interrupted run')
    assert.ok(after.messages.every(message => message.phase !== 'running'),
      'dead worker must not continue appearing as live')
    await assert.rejects(() => readThreadChat(db, bob, id), /not found/)
    assert.equal(await db.testing.records.count('story_thread_runs'), 1,
      'reconnect never allocates or replays a writer')
  } finally { db.close() }
})

test('agent restart reconciles a terminal queue receipt without replaying its writer', async () => {
  const { db, alice, id, job } = await setup()
  try {
    const message = randomUUID()
    ;(await db.testing.records.insert('story_thread_messages', { id: message, ownerUserId: alice,
      threadId: id, sequence: 2, role: 'user', status: 'queued',
      body: 'Sent before the crash', phase: 'running', jobId: job, createdAt: 'now' }))
    await recoverSettledThreadRuns(db)
    await recoverSettledThreadRuns(db)
    const chat = (await readThreadChat(db, alice, id))
    assert.equal(chat.messages.find(item => item.id === message)?.phase, 'blocked',
      'a queue-only success is not a verified Story checkpoint')
    assert.equal(chat.messages.filter(item => item.id === 'assistant:' + job).length, 1)
    assert.equal(chat.runs.length, 1)
    assert.equal(chat.turnReceipts.find(turn => turn.id === message)?.executions[0]?.validatedSha, null)
    assert.equal(await db.testing.records.count('story_thread_runs'), 1,
      'restart must never allocate or replay an execution')
  } finally { db.close() }
})

test('verified partial pause preserves a running Turn until resume completes the same execution', async () => {
  const { db, alice, id, job } = await setup()
  try {
    const messageId = randomUUID(), head = 'b'.repeat(40)
    ;(await db.testing.records.insert('story_thread_messages', {
      id: messageId, ownerUserId: alice, threadId: id, sequence: 2, role: 'user',
      status: 'queued', body: 'Keep working from this safe boundary',
      phase: 'running', jobId: job, createdAt: 'now',
    }))
    ;(await db.testing.records.update('studio_sessions', { id: job }, { status: 'paused' }))
    await db.persistence.continuation.settle(alice, job, null, '2026-11-08T12:00:00Z')
    assert.equal((await readThreadChat(db, alice, id)).messages.find(m => m.id === messageId)?.phase,
      'running', 'a safe pause does not end the author Turn')
    ;(await db.testing.records.update('studio_sessions', { id: job }, { status: 'completed' }))
    await db.persistence.continuation.settle(alice, job, head, '2026-11-08T12:01:00Z')
    await db.persistence.continuation.settle(alice, job, head, '2026-11-08T12:01:00Z')
    const final = await readThreadChat(db, alice, id)
    assert.equal(final.messages.find(m => m.id === messageId)?.phase, 'finished')
    assert.equal(final.turnReceipts.find(turn => turn.id === messageId)?.executions[0]?.validatedSha,
      head)
    assert.deepEqual((await db.testing.foreignKeyViolations()), [])
  } finally { db.close() }
})

test('a verified same-Thread recovery execution completes the original blocked Turn', async () => {
  const { db, alice, id, job, story } = await setup()
  try {
    const messageId = randomUUID(), childId = randomUUID(), newHead = 'c'.repeat(40)
    ;(await db.testing.records.insert('story_thread_messages', {
      id: messageId, ownerUserId: alice, threadId: id, sequence: 2,
      role: 'user', status: 'queued', body: 'Original unresolved author request',
      phase: 'blocked', jobId: job, createdAt: 'now',
    }))
    const seed = studioSeed(db)
    ;(await seed.job({ id: childId, ownerUserId: alice, storyId: story, title: 'Recovery',
      sourceCommitSha: 'b'.repeat(40), status: 'completed',
      createdAt: 'now', updatedAt: 'now' }))
    ;(await seed.threadRun({ jobId: childId, ownerUserId: alice, threadId: id, runOrder: 1 }))
    ;(await seed.queue({ jobId: childId, ownerUserId: alice, intent: 'start',
      phase: 'finished', createdAt: 'now', updatedAt: 'now' }))
    // Model the immutable recovery association created by checkpoint-fork
    // registration; settlement cannot infer this link from job timestamps.
    ;(await db.testing.records.insert('story_turn_executions', {
      turnId: messageId, jobId: childId, ownerUserId: alice, threadId: id,
    }))
    await db.persistence.continuation.settle(alice, childId, newHead, '2026-11-08T12:02:00Z')
    const after = await readThreadChat(db, alice, id)
    const receipt = after.turnReceipts.find(turn => turn.id === messageId)!
    assert.equal(after.messages.find(m => m.id === messageId)?.phase, 'finished')
    assert.deepEqual(receipt.executions.map(run => [run.jobId, run.inputSha, run.validatedSha]),
      [[job, 'a'.repeat(40), null], [childId, 'b'.repeat(40), newHead]])
    assert.equal(after.runs.length, 2)
    assert.deepEqual((await db.testing.foreignKeyViolations()), [])
  } finally { db.close() }
})

test('paused settlement remains immutable and a later completion appends a fresh assistant outcome', async () => {
  const { db, alice, id, job } = await setup()
  try {
    const initial = (await readThreadChat(db, alice, id))
    assert.equal(initial.messages.filter(m => m.role === 'assistant').length, 1)
    ;(await db.testing.records.update('studio_sessions', { id: job }, { status: 'paused' }))
    const paused = (await readThreadChat(db, alice, id))
    assert.equal(paused.messages.filter(m => m.role === 'assistant').length, 2)
    assert.match(paused.messages.at(-1)?.content ?? '', /paused/i)
    ;(await db.testing.records.update('studio_sessions', { id: job }, { status: 'completed' }))
    const completed = (await readThreadChat(db, alice, id))
    const summaries = completed.messages.filter(m => m.role === 'assistant')
    assert.equal(summaries.length, 3)
    assert.match(summaries.at(-1)?.content ?? '', /finished/i)
    assert.match(summaries.at(-2)?.content ?? '', /paused/i)
    assert.equal((await readThreadChat(db, alice, id)).messages.filter(m => m.role === 'assistant').length, 3)
    assert.equal(new Set(summaries.map(m => m.id)).size, 3)
  } finally { db.close() }
})

test('settlement appends an assistant response on changed status; incomplete work cannot admit the queued follow-up', async () => {
  const { db, alice, id, job } = await setup()
  try {
    const messageId = randomUUID()
    await enqueueThreadMessage(db, alice, id, messageId, 'Follow-up while blocked')
    ;(await db.testing.records.update('studio_sessions', { id: job }, { status: 'blocked' }))
    await assert.rejects(() => enqueueThreadMessage(db, alice, id, randomUUID(), 'Cannot run yet'),
      /cannot accept follow-ups while generation is stopped/)
    await settleThreadRun(db, alice, job)
    await settleThreadRun(db, alice, job)
    const chat = (await readThreadChat(db, alice, id))
    assert.equal(chat.messages.filter(m => m.role === 'assistant').length, 2)
    assert.match(chat.messages.filter(m => m.role === 'assistant').at(-1)?.content ?? '', /blocked/i)
    assert.equal(chat.messages.find(m => m.id === messageId)?.phase, 'queued')
    assert.equal(chat.runs.at(-1)?.status, 'blocked')
    assert.deepEqual((await db.testing.foreignKeyViolations()), [])
  } finally { db.close() }
})
