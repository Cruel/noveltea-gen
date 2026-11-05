import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { removeTestTree } from '../../test/helpers'
import { openStudioDatabase } from '../src/db/connection'
import { migrateStudio } from '../src/db/migrations'
import { submitThreadRevision, previewThreadRevision } from '../src/lib/story-revision.server'
import { readThreadChat, cancelQueuedThreadMessage, editQueuedThreadMessage,
  settleThreadRun, recoverSettledThreadRuns } from '../src/lib/thread-chat.server'
import { dispatchPendingPiSteering, settlePiSteering, deferUndeliveredSteering,
  recordPiTurnLifecycle, recoverOrphanedPiTurns, recordIndependentSteeringReview }
  from '../src/lib/thread-live-steering.server'
import { classifySteeringIntent, steeringActivity, prepareSteeringBoundaryReviews,
  attributeSteeringCheckpoint } from '../src/lib/thread-steering-replan.server'
import { snapshotForkBoundaryHistory } from '../src/lib/thread-fork-history.server'
import type { JobStartResult } from '../../src/job'
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

function fakePi(job: string, expectedHead = '0'.repeat(40)) {
  const sent: string[] = []
  const followUps: string[] = []
  const messages: Array<{ role: 'user'; content: string }> = []
  let streaming = true
  const turn = { jobId: job, token: randomUUID(), workItem: 'focus:character.mara',
    expectedHead,
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
    await assert.rejects(() => cancelQueuedThreadMessage(f.db, f.stranger, f.threadId, id), /not found/)
    await assert.rejects(submitThreadRevision(f.db, f.stranger, f.threadId,
      id, note, undefined, undefined, 'steer'), /not found|already in use/)

    await dispatchPendingPiSteering(f.db)
    assert.equal(pi.sent.length, 1)
    assert.match(pi.sent[0]!, /only within|existing assigned targets/i)
    assert.match(pi.sent[0]!, /THREAD_STEERING_MESSAGE_ID=/)
    assert.equal((await readThreadChat(f.db, f.owner, f.threadId)).messages.find(m => m.id === id)?.liveState, 'sdk-queued')
    const reconnect = openStudioDatabase(join(f.root, 'studio.sqlite'))
    try {
      assert.equal((await readThreadChat(reconnect, f.owner, f.threadId))
        .messages.find(m => m.id === id)?.liveState, 'sdk-queued',
      'a separate Studio connection sees active SDK receipt after reconnect')
    } finally { reconnect.sqlite.close() }
    await assert.rejects(() => cancelQueuedThreadMessage(f.db, f.owner, f.threadId, id), /entered execution/)
    await dispatchPendingPiSteering(f.db)
    assert.equal(pi.sent.length, 1, 'no duplicate dispatch while tool call is in progress')

    // An instrumented Pi turn does not expose the steering as a consumed user
    // message until the current tool call and assistant turn have finished.
    pi.messages.push({ role: 'user', content: pi.sent[0]! })
    pi.stop()
    await settlePiSteering(f.db, pi.turn, true)
    const delivered = (await readThreadChat(f.db, f.owner, f.threadId)).messages.find(m => m.id === id)!
    assert.equal(delivered.phase, 'finished')
    assert.equal(delivered.jobId, f.job)
    assert.equal(delivered.liveState, 'delivered')
    const resumed = openStudioDatabase(join(f.root, 'studio.sqlite'))
    try {
      assert.equal((await readThreadChat(resumed, f.owner, f.threadId))
        .messages.find(m => m.id === id)?.liveState, 'delivered',
      'delivery history persists across independent connections')
    } finally { resumed.sqlite.close() }
    await settlePiSteering(f.db, pi.turn, true)
    assert.equal((await readThreadChat(f.db, f.owner, f.threadId)).messages.find(m => m.id === id)?.phase, 'finished')
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
    const chat = (await readThreadChat(f.db, f.owner, f.threadId))
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
    assert.equal((await readThreadChat(f.db, f.owner, f.threadId)).messages.find(m => m.id === pending)?.liveState, 'pending')
    try {
      await dispatchPendingPiSteering(f.db)
      assert.equal(pi.followUps.length, 1, 'SDK followUp queues after the running Pi task')
      assert.equal(pi.sent.length, 0, 'steer cannot overtake an earlier Follow up')
      await dispatchPendingPiSteering(f.db)
      assert.equal(pi.sent.length, 0)
      pi.messages.push({ role: 'user', content: pi.followUps[0]! })
      pi.stop()
      await settlePiSteering(f.db, pi.turn, true)
      const chat = (await readThreadChat(f.db, f.owner, f.threadId))
      assert.equal(chat.messages.find(m => m.id === follow)?.liveState, 'delivered')
      assert.equal(chat.messages.find(m => m.id === pending)?.liveState, 'deferred')
    } finally { release() }
    deferUndeliveredSteering(f.db, f.owner, f.job)
    const chat = (await readThreadChat(f.db, f.owner, f.threadId))
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
    assert.equal((await cancelQueuedThreadMessage(f.db, f.owner, f.threadId, id)).phase, 'cancelled')
    await dispatchPendingPiSteering(f.db)
    assert.equal(pi.sent.length, 0)
    assert.equal((await readThreadChat(f.db, f.owner, f.threadId))
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
    const saved = (await readThreadChat(f.db, f.owner, f.threadId)).messages.find(m => m.id === id)
    assert.equal(saved?.liveState, 'deferred')
    assert.equal(saved?.phase, 'queued')
    await recoverSettledThreadRuns(f.db)
    assert.equal((await readThreadChat(f.db, f.owner, f.threadId))
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
    const blocked = (await readThreadChat(f.db, f.owner, f.threadId)).messages.find(m => m.id === id)!
    assert.equal(blocked.liveState, 'blocked')
    assert.equal(blocked.phase, 'blocked')
    deferUndeliveredSteering(f.db, f.owner, f.job)
    assert.equal((await readThreadChat(f.db, f.owner, f.threadId)).messages.find(m => m.id === id)?.phase, 'blocked')
  } finally { releaseUnrelated(); f.cleanup() }
})

test('queued edits preserve provenance, revoke stale scopes, and reject duplicate or cross-owner changes', async () => {
  const f = await setup()
  try {
    const id = randomUUID(), requestId = randomUUID()
    await submitThreadRevision(f.db, f.owner, f.threadId, id,
      'Original character constraint', undefined, undefined, 'steer')
    assert.equal((await readThreadChat(f.db, f.owner, f.threadId)).messages.find(m => m.id === id)?.liveState,
      'deferred', 'no active Pi means coordinator routing, not an arbitrary future Pi session')
    await assert.rejects(() => editQueuedThreadMessage(f.db, f.stranger, f.threadId, id, requestId,
      'Original character constraint', 'Edited constraint'), /not found/)
    const edited = (await editQueuedThreadMessage(f.db, f.owner, f.threadId, id, requestId,
      'Original character constraint', 'Edited constraint'))
    assert.equal(edited.content, 'Edited constraint')
    assert.equal(edited.editCount, 1)
    const replay = await submitThreadRevision(f.db, f.owner, f.threadId, id,
      'Original character constraint', undefined, undefined, 'steer')
    assert.equal(replay.content, 'Edited constraint', 'stale POST retry must not revert a subsequent edit')
    const history = (await readThreadChat(f.db, f.owner, f.threadId)).messages.find(m => m.id === id)?.editHistory
    assert.deepEqual(history?.map(h => [h.old, h.replacement]),
      [['Original character constraint', 'Edited constraint']])
    assert.equal((await editQueuedThreadMessage(f.db, f.owner, f.threadId, id, requestId,
      'Original character constraint', 'Edited constraint')).editCount, 1,
    'exactly the same edit request can be safely retried')
    await assert.rejects(() => editQueuedThreadMessage(f.db, f.owner, f.threadId, id, requestId,
      'Original character constraint', 'Different content'), /already in use/)
    await assert.rejects(() => editQueuedThreadMessage(f.db, f.owner, f.threadId, id, randomUUID(),
      'Original character constraint', 'Another change'), /changed/)
    const audit = f.db.sqlite.prepare(`SELECT old_body AS before,new_body AS after
      FROM thread_queued_message_edits WHERE message_id=?`).all(id)
    assert.deepEqual(audit, [{ before: 'Original character constraint', after: 'Edited constraint' }])
    assert.equal((await cancelQueuedThreadMessage(f.db, f.owner, f.threadId, id)).phase, 'cancelled')
    await assert.rejects(() => editQueuedThreadMessage(f.db, f.owner, f.threadId, id, randomUUID(),
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
    await editQueuedThreadMessage(f.db, f.owner, f.threadId, id, randomUUID(),
      'Keep the old alibi', 'Remove the old alibi')
    await dispatchPendingPiSteering(f.db)
    assert.equal(pi.sent.length, 1)
    assert.match(pi.sent[0]!, /Remove the old alibi/)
    assert.doesNotMatch(pi.sent[0]!, /Keep the old alibi/)
    await assert.rejects(() => cancelQueuedThreadMessage(f.db, f.owner, f.threadId, id), /entered execution/)
    await assert.rejects(() => editQueuedThreadMessage(f.db, f.owner, f.threadId, id, randomUUID(),
      'Remove the old alibi', 'Unapproved edit'), /already admitted/)
    pi.messages.push({ role: 'user', content: pi.sent[0]! })
    pi.stop()
    await settlePiSteering(f.db, pi.turn, true)
    const acknowledged = (await readThreadChat(f.db, f.owner, f.threadId)).messages.find(m => m.id === id)
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
    assert.equal((await readThreadChat(f.db, f.owner, f.threadId))
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
      const item = (await readThreadChat(f.db, f.owner, f.threadId)).messages.find(m => m.id === id)
      assert.equal(item?.liveState, 'deferred')
      assert.equal(item?.phase, 'queued')
      const reopened = openStudioDatabase(join(f.root, 'studio.sqlite'))
      try { assert.equal((await readThreadChat(reopened, f.owner, f.threadId))
        .messages.find(m => m.id === id)?.liveState, 'deferred') }
      finally { reopened.sqlite.close() }
    } finally { releaseLater() }
    recoverOrphanedPiTurns(f.db)
    await dispatchPendingPiSteering(f.db)
    assert.equal((await readThreadChat(f.db, f.owner, f.threadId))
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
    assert.equal((await readThreadChat(f.db, f.owner, f.threadId))
      .messages.find(m => m.id === id)?.liveState, 'dispatching')
    await assert.rejects(() => cancelQueuedThreadMessage(f.db, f.owner, f.threadId, id), /entered execution/)
    // Pi may settle just after the tool call while the SDK call is unresolved.
    pi.messages.push({ role: 'user', content: pi.sent[0]! })
    pi.stop()
    const settlement = settlePiSteering(f.db, pi.turn, true)
    accept('queued')
    await Promise.all([dispatch, settlement])
    assert.equal((await readThreadChat(f.db, f.owner, f.threadId))
      .messages.find(m => m.id === id)?.liveState, 'delivered')
  } finally { release(); f.cleanup() }
})

test('a Character specialist redirection becomes one separately reviewed Milestone proposal', async () => {
  const f = await setup(), pi = fakePi(f.job)
  const release = registerPiTurn(pi.turn)
  try {
    const id = randomUUID()
    const instruction = 'Revise milestone.reckoning to change the ending.'
    assert.equal(classifySteeringIntent(instruction, pi.turn.workItem), 'scope-review')
    const original = await submitThreadRevision(f.db, f.owner, f.threadId,
      id, instruction, undefined, undefined, 'steer')
    assert.equal(original.hasRevisionScope, 0)
    const laterId = randomUUID()
    await submitThreadRevision(f.db, f.owner, f.threadId, laterId,
      'Later independent instruction')
    await dispatchPendingPiSteering(f.db)
    assert.equal(pi.sent.length, 1)
    assert.match(pi.sent[0]!, /not new write authority/i)
    pi.messages.push({ role: 'user', content: pi.sent[0]! })
    pi.stop()
    await settlePiSteering(f.db, pi.turn, true)
    assert.equal(steeringActivity(f.db, f.owner, f.threadId)[0]?.disposition, 'scope-review')
    assert.equal(steeringActivity(f.db, f.stranger, f.threadId).length, 0)
    release()
    // Replanning is not attempted mid-specialist, or from an unverified run.
    assert.equal(prepareSteeringBoundaryReviews(f.db, f.owner, f.job, f.threadId,
      'a'.repeat(40)), 0)
    f.db.sqlite.prepare("UPDATE generation_run_queue SET phase='finished' WHERE job_id=?").run(f.job)
    f.db.sqlite.prepare("UPDATE studio_sessions SET status='completed' WHERE id=?").run(f.job)
    assert.equal(prepareSteeringBoundaryReviews(f.db, f.owner, f.job, f.threadId, null), 0)
    assert.equal(prepareSteeringBoundaryReviews(f.db, f.owner, f.job, f.threadId,
      'a'.repeat(40)), 1)
    assert.equal(prepareSteeringBoundaryReviews(f.db, f.owner, f.job, f.threadId,
      'a'.repeat(40)), 0, 'worker restart cannot duplicate the redirect')
    const chat = (await readThreadChat(f.db, f.owner, f.threadId))
    assert.equal(chat.messages.filter(m => m.role === 'user').length, 3)
    const queued = chat.messages.find(m => m.content === instruction && m.phase === 'queued')!
    const later = chat.messages.find(m => m.id === laterId)!
    assert.ok(queued.sequence > later.sequence, 'append-only history stays chronological')
    assert.ok(queued.queuePriority < later.queuePriority,
      'causal redirect review is considered before a later queued instruction')
    await assert.rejects(() => previewThreadRevision(f.db, f.owner, f.threadId,
      later.content, undefined, laterId), /preceding Thread instruction/)
    assert.equal(queued.content, instruction)
    assert.equal(queued.hasRevisionScope, 0, 'no additional writer authority was granted')
    const activity = chat.steeringActivity.find(a => a.messageId === id)!
    assert.equal(activity.reviewMessageId, queued.id)
    assert.equal(activity.state, 'awaiting-review')
    assert.equal(chat.messages.find(m => m.id === id)?.phase, 'finished',
      'the consumed instruction remains immutable')
    await assert.rejects(() => cancelQueuedThreadMessage(f.db, f.stranger, f.threadId, queued.id),
      /not found/)
  } finally { release(); f.cleanup() }
})

test('pending coordinator messages remain unresolved at a verified checkpoint without false influence', async () => {
  const f = await setup()
  try {
    const id = randomUUID()
    const original = await submitThreadRevision(f.db, f.owner, f.threadId,
      id, 'Change milestone.reckoning after the current specialist finishes',
      undefined, undefined, 'follow-up')
    assert.equal(original.liveState, 'deferred')
    const point = {
      eligible: true, commitSha: 'c'.repeat(40), parentSha: '0'.repeat(40),
      proofDigest: 'd'.repeat(64),
      workItem: 'focus:character.mara',
    }
    attributeSteeringCheckpoint(f.db, f.owner, f.job, point)
    const unresolved = steeringActivity(f.db, f.owner, f.threadId).find(a => a.messageId === id)!
    assert.equal(unresolved.state, 'deferred')
    assert.equal(unresolved.checkpointSha, point.commitSha)
    assert.equal(unresolved.checkpointWorkItem, point.workItem)
    assert.equal((f.db.sqlite.prepare('SELECT verified_commit_sha AS sha FROM story_thread_messages WHERE id=?')
      .get(id) as { sha: string | null }).sha, null,
    'unconsumed instruction cannot become inherited verified history')
    assert.equal((f.db.sqlite.prepare('SELECT association FROM thread_steering_checkpoint_links WHERE message_id=?')
      .get(id) as { association: string }).association, 'pending-unresolved')
    assert.equal((f.db.sqlite.prepare('SELECT COUNT(*) AS count FROM thread_steering_intents')
      .get() as { count: number }).count, 0)
  } finally { f.cleanup() }
})

test('protected redirection requires its own approval, not Pi acknowledgement or a plan digest', async () => {
  const f = await setup(), pi = fakePi(f.job), release = registerPiTurn(pi.turn)
  try {
    const id = randomUUID()
    const text = 'Change protected decision creative-direction.last-bell#repair-not-revenge to "Revenge".'
    await submitThreadRevision(f.db, f.owner, f.threadId,
      id, text, undefined, undefined, 'steer')
    await dispatchPendingPiSteering(f.db)
    pi.messages.push({ role: 'user', content: pi.sent[0]! })
    pi.stop()
    await settlePiSteering(f.db, pi.turn, true)
    assert.equal(steeringActivity(f.db, f.owner, f.threadId)[0]?.disposition, 'protected-review')
    release()
    f.db.sqlite.prepare("UPDATE generation_run_queue SET phase='finished' WHERE job_id=?").run(f.job)
    f.db.sqlite.prepare("UPDATE studio_sessions SET status='completed' WHERE id=?").run(f.job)
    assert.equal(prepareSteeringBoundaryReviews(f.db, f.owner, f.job, f.threadId,
      'b'.repeat(40)), 1)
    const derived = (await readThreadChat(f.db, f.owner, f.threadId)).messages.find(m => m.phase === 'queued')!
    assert.equal(derived.hasRevisionScope, 0)
    assert.equal((f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM thread_protected_decisions')
      .get() as { n: number }).n, 0, 'Pi delivery is never author consent')
  } finally { release(); f.cleanup() }
})

test('verified checkpoint provenance branches between two delivered steering messages', async () => {
  const f = await setup()
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: f.root, encoding: 'utf8' }).trim()
    git('init', '-q')
    git('config', 'user.name', 'Test')
    git('config', 'user.email', 'test@example.test')
    writeFileSync(join(f.root, 'story.md'), 'baseline\n')
    git('add', 'story.md')
    git('commit', '-qm', 'baseline')
    const baseline = git('rev-parse', 'HEAD')
    const emit = async (message: string, expectedHead: string) => {
      const pi = fakePi(f.job, expectedHead), release = registerPiTurn(pi.turn)
      const id = randomUUID()
      try {
        await submitThreadRevision(f.db, f.owner, f.threadId,
          id, message, undefined, undefined, 'steer')
        await dispatchPendingPiSteering(f.db)
        pi.messages.push({ role: 'user', content: pi.sent[0]! })
        pi.stop()
        await settlePiSteering(f.db, pi.turn, true)
      } finally { release() }
      return id
    }
    const first = await emit('Keep character.mara within existing scope', baseline)
    writeFileSync(join(f.root, 'story.md'), 'first checkpoint\n')
    git('add', 'story.md')
    git('commit', '-qm', 'one')
    const one = git('rev-parse', 'HEAD')
    const proof = 'a'.repeat(64)
    assert.equal(attributeSteeringCheckpoint(f.db, f.owner, f.job, {
      eligible: true, commitSha: one, parentSha: '9'.repeat(40),
      proofDigest: proof, workItem: 'focus:character.mara',
    }), 0, 'wrong checkpoint parent cannot acquire earlier or later steering')
    attributeSteeringCheckpoint(f.db, f.owner, f.job, {
      eligible: true, commitSha: one, parentSha: baseline,
      proofDigest: proof, workItem: 'focus:character.mara',
    })
    const second = await emit('Keep character.mara consistent with the previous chapter', one)
    writeFileSync(join(f.root, 'story.md'), 'second checkpoint\n')
    git('add', 'story.md')
    git('commit', '-qm', 'two')
    const two = git('rev-parse', 'HEAD')
    attributeSteeringCheckpoint(f.db, f.owner, f.job, {
      eligible: true, commitSha: two, parentSha: one,
      proofDigest: 'b'.repeat(64), workItem: 'focus:character.mara',
    })
    const messages = (await readThreadChat(f.db, f.owner, f.threadId)).messages
    assert.equal(messages.find(m => m.id === first)?.effectVerifiedAt, null)
    assert.equal(messages.find(m => m.id === first)?.jobId, f.job)
    assert.equal((f.db.sqlite.prepare('SELECT verified_commit_sha AS sha FROM story_thread_messages WHERE id=?')
      .get(first) as { sha: string }).sha, one)
    assert.equal((f.db.sqlite.prepare('SELECT verified_commit_sha AS sha FROM story_thread_messages WHERE id=?')
      .get(second) as { sha: string }).sha, two)
    const source = { worktreeRoot: f.root, baseSha: baseline, jobId: f.job } as JobStartResult
    const frozen = await snapshotForkBoundaryHistory(f.db, f.owner, f.threadId, source,
      'Original task', 'now', one)
    assert.ok(frozen.some(m => m.originId === first))
    assert.ok(!frozen.some(m => m.originId === second),
      'fork from intermediate checkpoint cannot inherit later message')
    const both = await snapshotForkBoundaryHistory(f.db, f.owner, f.threadId, source,
      'Original task', 'now', two)
    assert.ok(both.some(m => m.originId === first))
    assert.ok(both.some(m => m.originId === second))
  } finally { f.cleanup() }
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
    assert.equal((await readThreadChat(f.db, f.owner, f.threadId))
      .messages.find(m => m.id === id)?.liveState, 'blocked')
    assert.equal((await readThreadChat(f.db, f.owner, f.threadId))
      .messages.find(m => m.id === id)?.phase, 'blocked')
    await assert.rejects(() => editQueuedThreadMessage(f.db, f.stranger, f.threadId, id,
      randomUUID(), 'Never broaden Story scope', 'New instructions'), /not found/)
    await dispatchPendingPiSteering(f.db)
    assert.equal(pi.sent.length, 0)
  } finally { release(); f.cleanup() }
})
