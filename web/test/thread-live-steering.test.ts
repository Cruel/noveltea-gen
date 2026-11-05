import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { removeTestTree } from '../../test/helpers'
import { openStudioDatabase } from '../src/db/connection'
import { migrateStudio } from '../src/db/migrations'
import { submitThreadRevision } from '../src/lib/story-revision.server'
import { readThreadChat, cancelQueuedThreadMessage, editQueuedThreadMessage,
  settleThreadRun, recoverSettledThreadRuns } from '../src/lib/thread-chat.server'
import { dispatchPendingPiSteering, settlePiSteering, deferUndeliveredSteering,
  recordPiTurnLifecycle, recoverOrphanedPiTurns, recordIndependentSteeringReview }
  from '../src/lib/thread-live-steering.server'
import { registerPiTurn, activePiTurn, observePiTurnLifecycle,
  type ActivePiTurn } from '../../src/live-pi-registry'

const config = { baseURL: 'http://localhost:3000', secret: 'live-steer-test-secret-01234567890123456',
  github: { clientId: 'test', clientSecret: 'test' }, gitlab: { clientId: 'test', clientSecret: 'test' } }
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'nt-steering-durable-'))
  const db = openStudioDatabase(join(root, 'studio.sqlite'))
  await migrateStudio(db, config)
  const owner = randomUUID(), stranger = randomUUID(), story = randomUUID(),
    repo = randomUUID(), conversation = randomUUID(), threadId = randomUUID(),
    job = randomUUID()
  for (const id of [owner, stranger]) db.sqlite.prepare(`INSERT INTO user
    (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,0,0)`)
    .run(id, 'Author', id + '@example.test')
  db.sqlite.prepare(`INSERT INTO repositories
    (id,owner_user_id,provider,provider_repository_id,name,created_at)
    VALUES (?,?,'github','123','Repo','now')`).run(repo, owner)
  db.sqlite.prepare(`INSERT INTO stories
    (id,owner_user_id,repository_id,directory,title,created_at)
    VALUES (?,?,?,'story','Story','now')`).run(story, owner, repo)
  db.sqlite.prepare(`INSERT INTO story_conversations
    (id,owner_user_id,story_id,title,created_at,updated_at)
    VALUES (?,?,?,'Story chat','now','now')`).run(conversation, owner, story)
  db.sqlite.prepare(`INSERT INTO story_threads
    (id,owner_user_id,conversation_id,title,activity_at,created_at)
    VALUES (?,?,?,'Thread','now','now')`).run(threadId, owner, conversation)
  db.sqlite.prepare(`INSERT INTO studio_sessions
    (id,owner_user_id,story_id,title,status,created_at,updated_at)
    VALUES (?,?,?,'Live','running','now','now')`).run(job, owner, story)
  db.sqlite.prepare(`INSERT INTO story_thread_runs
    (job_id,owner_user_id,thread_id,run_order) VALUES (?,?,?,0)`).run(job, owner, threadId)
  db.sqlite.prepare(`INSERT INTO generation_run_queue
    (job_id,owner_user_id,intent,phase,created_at,updated_at)
    VALUES (?,?,'start','running','now','now')`).run(job, owner)
  observePiTurnLifecycle((turn, phase) => recordPiTurnLifecycle(db, turn, phase))
  return { db, root, owner, stranger, threadId, job,
    cleanup() { observePiTurnLifecycle(undefined); db.sqlite.close(); removeTestTree(root) } }
}

function fakePi(job: string) {
  const sent: string[] = []
  const followUps: string[] = []
  const messages: Array<{ role: 'user'; content: string }> = []
  let streaming = true
  const turn = { jobId: job, token: randomUUID(), workItem: 'focus:character.mara',
    session: { sessionId: randomUUID(), get isStreaming() { return streaming },
      messages, async steer(text: string) { sent.push(text); return 'queued' as const },
      async followUp(text: string) { followUps.push(text); return 'queued' as const } } } as unknown as ActivePiTurn
  return { turn, sent, followUps, messages, stop: () => { streaming = false } }
}

test('steer reaches only active Pi session and is acknowledged after its tool/turn boundary', async () => {
  const f = await setup()
  const pi = fakePi(f.job)
  const release = registerPiTurn(pi.turn)
  try {
    const id = randomUUID(), note = 'Keep the witness courageous but do not change any protected decision.'
    const accepted = await submitThreadRevision(f.db, f.owner, f.threadId,
      id, note, undefined, undefined, 'steer')
    assert.equal(accepted.phase, 'queued')
    assert.equal(accepted.liveState, 'pending')
    assert.equal(accepted.hasRevisionScope, 0)
    assert.throws(() => cancelQueuedThreadMessage(f.db, f.stranger, f.threadId, id), /not found/)
    await assert.rejects(submitThreadRevision(f.db, f.stranger, f.threadId,
      id, note, undefined, undefined, 'steer'), /not found|already in use/)

    await dispatchPendingPiSteering(f.db)
    assert.equal(pi.sent.length, 1)
    assert.match(pi.sent[0]!, /only within|existing assigned targets/i)
    assert.match(pi.sent[0]!, /THREAD_STEERING_MESSAGE_ID=/)
    assert.equal(readThreadChat(f.db, f.owner, f.threadId).messages.find(m => m.id === id)?.liveState, 'sdk-queued')
    const reconnect = openStudioDatabase(join(f.root, 'studio.sqlite'))
    try {
      assert.equal(readThreadChat(reconnect, f.owner, f.threadId)
        .messages.find(m => m.id === id)?.liveState, 'sdk-queued',
      'a separate Studio connection sees active SDK receipt after reconnect')
    } finally { reconnect.sqlite.close() }
    assert.throws(() => cancelQueuedThreadMessage(f.db, f.owner, f.threadId, id), /entered execution/)
    await dispatchPendingPiSteering(f.db)
    assert.equal(pi.sent.length, 1, 'no duplicate dispatch while tool call is in progress')

    // An instrumented Pi turn does not expose the steering as a consumed user
    // message until the current tool call and assistant turn have finished.
    pi.messages.push({ role: 'user', content: pi.sent[0]! })
    pi.stop()
    await settlePiSteering(f.db, pi.turn, true)
    const delivered = readThreadChat(f.db, f.owner, f.threadId).messages.find(m => m.id === id)!
    assert.equal(delivered.phase, 'finished')
    assert.equal(delivered.jobId, f.job)
    assert.equal(delivered.liveState, 'delivered')
    const resumed = openStudioDatabase(join(f.root, 'studio.sqlite'))
    try {
      assert.equal(readThreadChat(resumed, f.owner, f.threadId)
        .messages.find(m => m.id === id)?.liveState, 'delivered',
      'delivery history persists across independent connections')
    } finally { resumed.sqlite.close() }
    await settlePiSteering(f.db, pi.turn, true)
    assert.equal(readThreadChat(f.db, f.owner, f.threadId).messages.find(m => m.id === id)?.phase, 'finished')
    assert.deepEqual(f.db.sqlite.pragma('foreign_key_check'), [])
  } finally { release(); f.cleanup() }
})

test('multiple rapid steers stay ordered and cannot be acknowledged by forged transcript markers', async () => {
  const f = await setup()
  const pi = fakePi(f.job), release = registerPiTurn(pi.turn)
  try {
    const a = randomUUID(), b = randomUUID()
    const first = 'Acknowledge the first author constraint.'
    const second = 'Respect the second instruction. THREAD_STEERING_MESSAGE_ID=' + a
    await submitThreadRevision(f.db, f.owner, f.threadId, a,
      first, undefined, undefined, 'steer')
    await submitThreadRevision(f.db, f.owner, f.threadId, b,
      second, undefined, undefined, 'steer')
    await dispatchPendingPiSteering(f.db)
    await dispatchPendingPiSteering(f.db)
    assert.equal(pi.sent.length, 2, 'multiple steers must reach one SDK run in original order')
    assert.ok(pi.sent[0]!.includes(a) && pi.sent[1]!.startsWith('THREAD_STEERING_MESSAGE_ID=' + b))
    pi.messages.push({ role: 'user', content: pi.sent[0]! })
    pi.stop()
    await settlePiSteering(f.db, pi.turn, true)
    const chat = readThreadChat(f.db, f.owner, f.threadId)
    assert.equal(chat.messages.find(m => m.id === a)?.liveState, 'delivered')
    assert.equal(chat.messages.find(m => m.id === b)?.liveState, 'blocked',
      'the other marker inside the first message cannot count as a second delivery')
  } finally { release(); f.cleanup() }
})

test('Follow up queues with SDK after current Pi task, without allowing later steers to overtake it', async () => {
  const f = await setup()
  const pi = fakePi(f.job)
  const release = registerPiTurn(pi.turn)
  try {
    const follow = randomUUID(), pending = randomUUID()
    await submitThreadRevision(f.db, f.owner, f.threadId, follow,
      'Please revise the Event after this run', undefined, undefined, 'follow-up')
    const recorded = await submitThreadRevision(f.db, f.owner, f.threadId, pending,
      'Keep the character motive consistent', undefined, undefined, 'steer')
    assert.equal(recorded.liveState, 'pending')
    await dispatchPendingPiSteering(f.db)
    assert.equal(readThreadChat(f.db, f.owner, f.threadId).messages.find(m => m.id === pending)?.liveState, 'pending')
    try {
      await dispatchPendingPiSteering(f.db)
      assert.equal(pi.followUps.length, 1, 'SDK followUp queues after the running Pi task')
      assert.equal(pi.sent.length, 0, 'steer cannot overtake an earlier Follow up')
      await dispatchPendingPiSteering(f.db)
      assert.equal(pi.sent.length, 0)
      pi.messages.push({ role: 'user', content: pi.followUps[0]! })
      pi.stop()
      await settlePiSteering(f.db, pi.turn, true)
      const chat = readThreadChat(f.db, f.owner, f.threadId)
      assert.equal(chat.messages.find(m => m.id === follow)?.liveState, 'delivered')
      assert.equal(chat.messages.find(m => m.id === pending)?.liveState, 'deferred')
    } finally { release() }
    deferUndeliveredSteering(f.db, f.owner, f.job)
    const chat = readThreadChat(f.db, f.owner, f.threadId)
    assert.equal(chat.messages.find(m => m.id === pending)?.liveState, 'deferred')
    assert.equal(chat.messages.find(m => m.id === pending)?.phase, 'queued')
    assert.deepEqual(f.db.sqlite.pragma('foreign_key_check'), [])
  } finally { f.cleanup() }
})

test('a pre-dispatch cancellation is durable and never reaches Pi', async () => {
  const f = await setup()
  const pi = fakePi(f.job), release = registerPiTurn(pi.turn)
  try {
    const id = randomUUID()
    await submitThreadRevision(f.db, f.owner, f.threadId, id,
      'Do not extend this Event', undefined, undefined, 'steer')
    assert.equal(cancelQueuedThreadMessage(f.db, f.owner, f.threadId, id).phase, 'cancelled')
    await dispatchPendingPiSteering(f.db)
    assert.equal(pi.sent.length, 0)
    assert.equal(readThreadChat(f.db, f.owner, f.threadId)
      .messages.find(message => message.id === id)?.phase, 'cancelled')
  } finally { release(); f.cleanup() }
})

test('non-Pi boundary settles pending input as deferred and restart never replays old writer', async () => {
  const f = await setup()
  try {
    const id = randomUUID()
    await submitThreadRevision(f.db, f.owner, f.threadId, id,
      'Check the character motive after the current run', undefined, undefined, 'follow-up')
    f.db.sqlite.prepare("UPDATE generation_run_queue SET phase='finished' WHERE job_id=?").run(f.job)
    f.db.sqlite.prepare("UPDATE studio_sessions SET status='completed' WHERE id=?").run(f.job)
    await settleThreadRun(f.db, f.owner, f.job)
    const saved = readThreadChat(f.db, f.owner, f.threadId).messages.find(m => m.id === id)
    assert.equal(saved?.liveState, 'deferred')
    assert.equal(saved?.phase, 'queued')
    await recoverSettledThreadRuns(f.db)
    assert.equal(readThreadChat(f.db, f.owner, f.threadId)
      .messages.find(m => m.id === id)?.liveState, 'deferred')
    assert.equal((f.db.sqlite.prepare('SELECT COUNT(*) AS total FROM story_thread_runs')
      .get() as { total: number }).total, 1,
      'reconciliation must never replay an old generation writer')
  } finally { f.cleanup() }
})

test('dispatch is pinned to the exact job and ambiguous SDK admission never replays into another turn', async () => {
  const f = await setup()
  const unrelated = fakePi(randomUUID())
  f.db.sqlite.prepare(`INSERT INTO studio_sessions
    (id,owner_user_id,story_id,title,status,created_at,updated_at)
    SELECT ?,owner_user_id,story_id,'Other job','running','now','now'
    FROM studio_sessions WHERE id=?`).run(unrelated.turn.jobId, f.job)
  f.db.sqlite.prepare(`INSERT INTO generation_run_queue
    (job_id,owner_user_id,intent,phase,created_at,updated_at)
    VALUES (?,?,'start','running','now','now')`).run(unrelated.turn.jobId, f.owner)
  const releaseUnrelated = registerPiTurn(unrelated.turn)
  try {
    const id = randomUUID()
    const current = fakePi(f.job)
    current.turn.session.steer = async () => { throw new Error('Simulated SDK failure') }
    const releaseCurrent = registerPiTurn(current.turn)
    try {
      await submitThreadRevision(f.db, f.owner, f.threadId, id,
        'Keep the mystery focused', undefined, undefined, 'steer')
      await dispatchPendingPiSteering(f.db)
      assert.equal(unrelated.sent.length, 0, 'no cross-session routing')
    } finally { releaseCurrent() }
    const blocked = readThreadChat(f.db, f.owner, f.threadId).messages.find(m => m.id === id)!
    assert.equal(blocked.liveState, 'blocked')
    assert.equal(blocked.phase, 'blocked')
    deferUndeliveredSteering(f.db, f.owner, f.job)
    assert.equal(readThreadChat(f.db, f.owner, f.threadId).messages.find(m => m.id === id)?.phase, 'blocked')
  } finally { releaseUnrelated(); f.cleanup() }
})

test('queued edits preserve provenance, revoke stale scopes, and reject duplicate or cross-owner changes', async () => {
  const f = await setup()
  try {
    const id = randomUUID(), requestId = randomUUID()
    await submitThreadRevision(f.db, f.owner, f.threadId, id,
      'Original character constraint', undefined, undefined, 'steer')
    assert.equal(readThreadChat(f.db, f.owner, f.threadId).messages.find(m => m.id === id)?.liveState,
      'deferred', 'no active Pi means coordinator routing, not an arbitrary future Pi session')
    assert.throws(() => editQueuedThreadMessage(f.db, f.stranger, f.threadId, id, requestId,
      'Original character constraint', 'Edited constraint'), /not found/)
    const edited = editQueuedThreadMessage(f.db, f.owner, f.threadId, id, requestId,
      'Original character constraint', 'Edited constraint')
    assert.equal(edited.content, 'Edited constraint')
    assert.equal(edited.editCount, 1)
    const replay = await submitThreadRevision(f.db, f.owner, f.threadId, id,
      'Original character constraint', undefined, undefined, 'steer')
    assert.equal(replay.content, 'Edited constraint', 'stale POST retry must not revert a subsequent edit')
    const history = readThreadChat(f.db, f.owner, f.threadId).messages.find(m => m.id === id)?.editHistory
    assert.deepEqual(history?.map(h => [h.old, h.replacement]),
      [['Original character constraint', 'Edited constraint']])
    assert.equal(editQueuedThreadMessage(f.db, f.owner, f.threadId, id, requestId,
      'Original character constraint', 'Edited constraint').editCount, 1,
    'exactly the same edit request can be safely retried')
    assert.throws(() => editQueuedThreadMessage(f.db, f.owner, f.threadId, id, requestId,
      'Original character constraint', 'Different content'), /already in use/)
    assert.throws(() => editQueuedThreadMessage(f.db, f.owner, f.threadId, id, randomUUID(),
      'Original character constraint', 'Another change'), /changed/)
    const audit = f.db.sqlite.prepare(`SELECT old_body AS before,new_body AS after
      FROM thread_queued_message_edits WHERE message_id=?`).all(id)
    assert.deepEqual(audit, [{ before: 'Original character constraint', after: 'Edited constraint' }])
    assert.equal(cancelQueuedThreadMessage(f.db, f.owner, f.threadId, id).phase, 'cancelled')
    assert.throws(() => editQueuedThreadMessage(f.db, f.owner, f.threadId, id, randomUUID(),
      'Edited constraint', 'Unwithdraw'), /already admitted/)
  } finally { f.cleanup() }
})

test('edit before Pi dispatch is used once; edit and withdrawal after SDK claim are fenced', async () => {
  const f = await setup(), pi = fakePi(f.job)
  const release = registerPiTurn(pi.turn)
  try {
    const id = randomUUID()
    await submitThreadRevision(f.db, f.owner, f.threadId, id,
      'Keep the old alibi', undefined, undefined, 'steer')
    editQueuedThreadMessage(f.db, f.owner, f.threadId, id, randomUUID(),
      'Keep the old alibi', 'Remove the old alibi')
    await dispatchPendingPiSteering(f.db)
    assert.equal(pi.sent.length, 1)
    assert.match(pi.sent[0]!, /Remove the old alibi/)
    assert.doesNotMatch(pi.sent[0]!, /Keep the old alibi/)
    assert.throws(() => cancelQueuedThreadMessage(f.db, f.owner, f.threadId, id), /entered execution/)
    assert.throws(() => editQueuedThreadMessage(f.db, f.owner, f.threadId, id, randomUUID(),
      'Remove the old alibi', 'Unapproved edit'), /already admitted/)
    pi.messages.push({ role: 'user', content: pi.sent[0]! })
    pi.stop()
    await settlePiSteering(f.db, pi.turn, true)
    const acknowledged = readThreadChat(f.db, f.owner, f.threadId).messages.find(m => m.id === id)
    assert.equal(acknowledged?.liveState, 'delivered')
    assert.equal(acknowledged?.effectVerifiedAt, null, 'Pi delivery is not an independent effect proof')
    assert.equal(acknowledged?.livePiSessionId, pi.turn.session.sessionId)
    assert.equal(acknowledged?.liveWorkItem, 'focus:character.mara')
    assert.ok(acknowledged?.liveDeliveredAt)
    assert.throws(() => recordIndependentSteeringReview(f.db, f.owner, f.threadId,
      id, 'independent-editor', 'Checked resulting canon'), /unverified Story commit/)
    // Simulate the separately verified Story HEAD published by the controller,
    // then explicitly record an independent review of this particular effect.
    f.db.sqlite.prepare(`UPDATE story_thread_messages SET verified_commit_sha=? WHERE id=?`)
      .run('a'.repeat(40), id)
    recordIndependentSteeringReview(f.db, f.owner, f.threadId, id,
      'independent-editor', 'Read and compared the committed Character')
    recordIndependentSteeringReview(f.db, f.owner, f.threadId, id,
      'independent-editor', 'Read and compared the committed Character')
    assert.equal(readThreadChat(f.db, f.owner, f.threadId)
      .messages.find(m => m.id === id)?.effectReviewer, 'independent-editor')
    assert.throws(() => recordIndependentSteeringReview(f.db, f.owner, f.threadId, id,
      'other-reviewer', 'Different review'), /already exists/)
  } finally { release(); f.cleanup() }
})

test('submit-versus-settle cannot leak a steer to a later specialist or lose coordinator handoff', async () => {
  const f = await setup(), before = fakePi(f.job)
  const releaseBefore = registerPiTurn(before.turn)
  try {
    const id = randomUUID()
    await submitThreadRevision(f.db, f.owner, f.threadId, id,
      'Revise only the current Character', undefined, undefined, 'steer')
    before.stop()
    await settlePiSteering(f.db, before.turn, true)
    releaseBefore()
    const later = fakePi(f.job)
    const releaseLater = registerPiTurn(later.turn)
    try {
      await dispatchPendingPiSteering(f.db)
      assert.equal(later.sent.length, 0, 'never send a previous turn instruction to a different specialist')
      const item = readThreadChat(f.db, f.owner, f.threadId).messages.find(m => m.id === id)
      assert.equal(item?.liveState, 'deferred')
      assert.equal(item?.phase, 'queued')
      const reopened = openStudioDatabase(join(f.root, 'studio.sqlite'))
      try { assert.equal(readThreadChat(reopened, f.owner, f.threadId)
        .messages.find(m => m.id === id)?.liveState, 'deferred') }
      finally { reopened.sqlite.close() }
    } finally { releaseLater() }
    recoverOrphanedPiTurns(f.db)
    await dispatchPendingPiSteering(f.db)
    assert.equal(readThreadChat(f.db, f.owner, f.threadId)
      .messages.filter(m => m.id === id).length, 1)
  } finally { releaseBefore(); f.cleanup() }
})

test('withdrawal racing an in-flight SDK call is rejected; settlement waits for the SDK result', async () => {
  const f = await setup(), pi = fakePi(f.job)
  const release = registerPiTurn(pi.turn)
  try {
    const id = randomUUID()
    await submitThreadRevision(f.db, f.owner, f.threadId, id,
      'Keep the scope narrow', undefined, undefined, 'steer')
    let accept!: (result: 'queued') => void
    pi.turn.session.steer = async (text: string) => {
      pi.sent.push(text)
      return new Promise<'queued'>(resolve => { accept = resolve })
    }
    const dispatch = dispatchPendingPiSteering(f.db)
    assert.equal(readThreadChat(f.db, f.owner, f.threadId)
      .messages.find(m => m.id === id)?.liveState, 'dispatching')
    assert.throws(() => cancelQueuedThreadMessage(f.db, f.owner, f.threadId, id), /entered execution/)
    // Pi may settle just after the tool call while the SDK call is unresolved.
    pi.messages.push({ role: 'user', content: pi.sent[0]! })
    pi.stop()
    const settlement = settlePiSteering(f.db, pi.turn, true)
    accept('queued')
    await Promise.all([dispatch, settlement])
    assert.equal(readThreadChat(f.db, f.owner, f.threadId)
      .messages.find(m => m.id === id)?.liveState, 'delivered')
  } finally { release(); f.cleanup() }
})

test('worker crash with an ambiguous SDK call fences replay and preserves owner identity', async () => {
  const f = await setup(), pi = fakePi(f.job)
  const release = registerPiTurn(pi.turn)
  try {
    const id = randomUUID()
    await submitThreadRevision(f.db, f.owner, f.threadId, id,
      'Never broaden Story scope', undefined, undefined, 'steer')
    f.db.sqlite.prepare(`UPDATE thread_live_inputs SET state='dispatching',pi_token=?,pi_session_id=?
      WHERE message_id=?`).run(pi.turn.token, pi.turn.session.sessionId, id)
    release()
    f.db.sqlite.prepare(`UPDATE generation_run_queue SET phase='interrupted' WHERE job_id=?`).run(f.job)
    recoverOrphanedPiTurns(f.db)
    assert.equal(readThreadChat(f.db, f.owner, f.threadId)
      .messages.find(m => m.id === id)?.liveState, 'blocked')
    assert.equal(readThreadChat(f.db, f.owner, f.threadId)
      .messages.find(m => m.id === id)?.phase, 'blocked')
    assert.throws(() => editQueuedThreadMessage(f.db, f.stranger, f.threadId, id,
      randomUUID(), 'Never broaden Story scope', 'New instructions'), /not found/)
    await dispatchPendingPiSteering(f.db)
    assert.equal(pi.sent.length, 0)
  } finally { release(); f.cleanup() }
})
