import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openStudioDatabase } from './support/studio-database'
import { studioSeed } from './support/studio-seed'
import { migrateStudio } from '../src/db/migrations'
import type { AdvancedThreadPersistence, ForkReservation,
  NewThreadChild, RestartReservation } from '../src/persistence/advanced-thread-contracts'

const config = {
  baseURL: 'http://localhost:3000',
  secret: 'advanced-threads-restart-persistence-test-secret',
  github: { clientId: 'test', clientSecret: 'test' },
  gitlab: { clientId: 'test', clientSecret: 'test' },
}
const at = '2026-11-05T00:00:00Z'
const sha = 'a'.repeat(40)
const nextSha = 'b'.repeat(40)
const proof = 'd'.repeat(64)

type TestDb = ReturnType<typeof openStudioDatabase>
type Fixture = {
  owner: string; stranger: string; repo: string; story: string
  job: string; conversation: string; thread: string
}
async function fixtures(db: TestDb): Promise<Fixture> {
  await migrateStudio(db, config)
  const owner = randomUUID(), stranger = randomUUID()
  const repo = randomUUID(), story = randomUUID(), job = randomUUID()
  const conversation = randomUUID(), thread = randomUUID()
  const seed = studioSeed(db)
  for (const id of [owner, stranger]) { await seed.user(id) }
  (await seed.repository({ id: repo, ownerUserId: owner, provider: 'github',
    providerRepositoryId: '123', name: 'Author/Story', createdAt: at }))
  ;(await seed.story({ id: story, ownerUserId: owner, repositoryId: repo,
    directory: 'story', title: 'Story', createdAt: at, sourceCommitSha: sha }))
  ;(await seed.job({ id: job, ownerUserId: owner, storyId: story, title: 'Source',
    status: 'completed', sourceCommitSha: sha, createdAt: at, updatedAt: at }))
  ;(await seed.queue({ jobId: job, ownerUserId: owner, intent: 'start', phase: 'finished',
    createdAt: at, updatedAt: at }))
  ;(await seed.conversation({ id: conversation, ownerUserId: owner, storyId: story,
    title: 'Conversation', createdAt: at, updatedAt: at }))
  ;(await seed.thread({ id: thread, ownerUserId: owner, conversationId: conversation,
    title: 'Root', activityAt: at, createdAt: at }))
  ;(await seed.threadRun({ jobId: job, ownerUserId: owner, threadId: thread, runOrder: 0 }))
  return { owner, stranger, repo, story, job, conversation, thread }
}
function openPair() {
  const dir = mkdtempSync(join(tmpdir(), 'noveltea-advanced-thread-db-'))
  const path = join(dir, 'studio.sqlite')
  const a = openStudioDatabase(path), b = openStudioDatabase(path)
  return { a, b, path, close() {
    a.close()
    b.close()
    rmSync(dir, { recursive: true, force: true })
  } }
}
function forkReservation(f: Fixture, id: string): ForkReservation {
  return {
    childId: id, owner: f.owner, sourceJobId: f.job, sourceBaseSha: sha,
    commitSha: nextSha, bundle: JSON.stringify({ version: 1, mode: 'checkpoint' }),
    draft: JSON.stringify({ version: 1, headSha: nextSha }),
    sourceThreadId: f.thread, proofDigest: proof, guidance: 'Keep this branch narrow',
    history: JSON.stringify([{
      role: 'user', body: 'Original prompt', originId: 'original:' + f.job,
      verifiedSha: sha, createdAt: at,
    }]), at,
  }
}
function child(f: Fixture, data: ForkReservation): NewThreadChild {
  return {
    childId: data.childId, owner: data.owner, storyId: f.story,
    title: 'Fork', baseSha: nextSha,
    conversationId: f.conversation, parentThreadId: f.thread,
    threadId: 'fork:' + data.childId, draft: data.draft, at,
    kind: 'fork', history: JSON.parse(data.history), guidance: data.guidance,
  }
}

test('two independent connections reserve and register one exact checkpoint fork without duplicating immutable lineage', async () => {
  const pair = openPair()
  try {
    const f = await fixtures(pair.a)
    const a = pair.a.persistence.advancedThreads, b = pair.b.persistence.advancedThreads
    const id = randomUUID(), data = forkReservation(f, id)
    assert.equal(await b.identity(f.stranger, f.thread), null)
    assert.equal((await a.sourceThread(f.owner, f.job))?.id, f.thread)
    assert.equal((await a.ancestor(f.owner, f.thread))?.id, f.thread)
    const [reservedA, reservedB] = await Promise.all([a.reserveFork(data), b.reserveFork(data)])
    assert.deepEqual(reservedA, reservedB)
    assert.equal(reservedB.proofDigest, proof)
    await assert.rejects(b.reserveFork({ ...data, guidance: 'Different permission' }),
      /different checkpoint|reserved/)
    await assert.rejects(a.registerChild({ ...child(f, data), history: undefined }),
      /Fork history snapshot is missing/)
    assert.equal(await b.jobClaimed(id), false,
      'failed multi-table registration rolls back the session, Thread and run')
    await assert.rejects(b.registerChild({ ...child(f, data), storyId: f.repo }),
      /Child parent Story/)
    assert.equal(await b.jobClaimed(id), false,
      'foreign Story registration cannot create a partial child')
    const [insertA, insertB] = await Promise.all([
      a.registerChild(child(f, data)), b.registerChild(child(f, data)),
    ])
    assert.equal(Number(insertA.inserted) + Number(insertB.inserted), 1)
    const history = await b.history(f.owner, 'fork:' + id)
    assert.deepEqual(history.map(row => [row.body, row.status, row.origin]), [
      ['Original prompt', 'delivered', 'original:' + f.job],
      ['Keep this branch narrow', 'queued', null],
    ])
    assert.equal((await b.run(f.owner, 'fork:' + id, 'first'))?.jobId, id)
    assert.equal(await b.run(f.stranger, 'fork:' + id, 'first'), null)
    assert.equal((await a.ancestor(f.owner, 'fork:' + id))?.id, f.thread)
    assert.deepEqual(await a.history(f.owner, f.thread), [])
    assert.equal(await b.jobClaimed(id), true)
    await assert.rejects(a.reserveRestart({
      childId: id, owner: f.owner, sourceThread: f.thread,
      sourceJob: f.job, rootJob: f.job, original: sha, selected: sha,
      mode: 'original', branch: null, draft: data.draft, at,
    }), /assigned/)
    assert.deepEqual((await pair.a.testing.foreignKeyViolations()), [])
  } finally { pair.close() }
})

test('restart source identity and reservation stay pinned across interrupt, concurrent retry and resumed registration', async () => {
  const pair = openPair()
  try {
    const f = await fixtures(pair.a)
    const a = pair.a.persistence.advancedThreads, b = pair.b.persistence.advancedThreads
    const id = randomUUID()
    const data: RestartReservation = {
      childId: id, owner: f.owner, sourceThread: f.thread, sourceJob: f.job,
      rootJob: f.job, original: sha, selected: sha, mode: 'original',
      branch: null, draft: JSON.stringify({ version: 1, headSha: sha }), at,
    }
    assert.equal((await a.run(f.owner, f.thread, 'first'))?.jobId, f.job)
    assert.deepEqual(await b.reserveRestart(data), await a.reserveRestart(data))
    await assert.rejects(a.reserveRestart({ ...data, selected: nextSha }),
      /reservation changed/)
    assert.equal((await b.restartIntent(id))?.preparedAt, null)
    const newerRun = randomUUID()
    ;(await pair.a.testing.records.insert('studio_sessions', { id: newerRun, ownerUserId: f.owner,
      storyId: f.story, title: 'Later job', status: 'completed', sourceCommitSha: sha,
      createdAt: at, updatedAt: at }))
    ;(await pair.a.testing.records.insert('story_thread_runs', { jobId: newerRun, ownerUserId: f.owner,
      threadId: f.thread, runOrder: 1 }))
    const register: NewThreadChild = {
      childId: id, owner: f.owner, storyId: f.story, title: 'Restart',
      baseSha: sha, conversationId: f.conversation,
      parentThreadId: f.thread, threadId: 'restart:' + id,
      draft: data.draft, at, kind: 'restart',
    }
    await assert.rejects(b.registerChild(register), /Thread advanced/)
    assert.equal(await b.jobClaimed(id), false)
    assert.equal((await b.restartIntent(id))?.preparedAt, null)
    ;(await pair.a.testing.records.delete('story_thread_runs', { jobId: newerRun }))
    ;(await pair.a.testing.records.delete('studio_sessions', { id: newerRun }))
    assert.equal((await b.registerChild(register)).inserted, true)
    assert.equal((await a.registerChild(register)).inserted, false)
    assert.equal((await a.restartIntent(id))?.preparedAt, at)
    assert.equal((await b.registerChild({ ...register, at: '2026-11-06T00:00:00Z' })).inserted, false)
    assert.equal((await a.restartIntent(id))?.preparedAt, at,
      'idempotent registration must not rewrite the original preparation timestamp')
    assert.equal(await a.preparedRestart(f.owner, id, 'restart:' + id), true)
    assert.equal(await a.preparedRestart(f.stranger, id, 'restart:' + id), false)
    assert.deepEqual((await pair.a.testing.foreignKeyViolations()), [])
  } finally { pair.close() }
})

test('same-Thread continuation claim is serialized, terminal crash recovery cannot duplicate a writer or messages', async () => {
  const pair = openPair()
  try {
    const f = await fixtures(pair.a)
    const a = pair.a.persistence.continuation, b = pair.b.persistence.continuation
    const first = randomUUID(), second = randomUUID()
    for (const [sequence, id] of [first, second].entries())
      (await pair.a.testing.records.insert('story_thread_messages', { id, ownerUserId: f.owner,
        threadId: f.thread, sequence, role: 'user', status: 'queued',
        body: 'Author follow-up ' + sequence, phase: 'queued',
        revisionScopeJson: JSON.stringify({ sourceSha: sha }), createdAt: at }))
    const [claim1, claim2] = await Promise.all([
      Promise.resolve().then(() => a.claim(f.owner, f.thread)),
      Promise.resolve().then(() => b.claim(f.owner, f.thread)),
    ])
    const claim = claim1 ?? claim2
    assert.ok(claim)
    assert.equal(Number(!!claim1) + Number(!!claim2), 1)
    assert.equal(claim.id, first)
    assert.equal(await a.pending(f.stranger, f.thread), null)
    const request = {
      owner: f.owner, threadId: f.thread, claim, sourceHead: sha,
      generationThread: 'generation:one',
      draftJson: JSON.stringify({ version: 1 }), requestJson: JSON.stringify({ task: 'Do it' }), at,
    }
    await b.beginFollowUp(request)
    assert.equal((await b.current(f.owner, f.thread))?.jobId, first)
    assert.equal((await pair.a.testing.records.first<{ phase: string }>('generation_run_queue',
      { jobId: first }))?.phase, 'queued')
    assert.equal(await await a.claim(f.owner, f.thread), null)
    ;(await pair.a.testing.records.update('generation_run_queue', { jobId: first }, { phase: 'interrupted' }))
    ;(await pair.a.testing.records.update('studio_sessions', { id: first }, { status: 'blocked' }))
    assert.equal(await await a.settle(f.owner, first, null, at), f.thread)
    assert.equal(await await b.settle(f.owner, first, null, at), f.thread)
    const messages = (await pair.a.persistence.messages.read(f.owner, f.thread)).messages
    assert.equal(messages.find(row => row.id === first)?.phase, 'blocked')
    assert.equal(messages.find(row => row.id === second)?.phase, 'queued')
    assert.equal(messages.filter(row => row.id === 'assistant:' + first).length, 1)
    assert.equal(await await a.claim(f.owner, f.thread), null)
    assert.deepEqual((await pair.a.testing.foreignKeyViolations()), [])
  } finally { pair.close() }
})

test('Pi SDK claim is one-shot across connections; verified checkpoints preserve causal order and orphan recovery blocks replay', async () => {
  const pair = openPair()
  try {
    const f = await fixtures(pair.a)
    const a = pair.a.persistence.steering, b = pair.b.persistence.steering
    ;(await pair.a.testing.records.update('generation_run_queue', { jobId: f.job }, { phase: 'running' }))
    ;(await pair.a.testing.records.update('studio_sessions', { id: f.job }, { status: 'running' }))
    const token = randomUUID(), id = randomUUID()
    const job = f.job
    ;(await pair.a.testing.records.insert('story_thread_messages', { id, ownerUserId: f.owner,
      threadId: f.thread, sequence: 0, role: 'user', status: 'queued',
      body: 'Adjust character motive', phase: 'queued', createdAt: at }))
    ;(await pair.a.testing.records.insert('thread_live_inputs', { messageId: id,
      ownerUserId: f.owner, threadId: f.thread, sourceJobId: job,
      mode: 'steer', state: 'pending', targetPiToken: token,
      targetWorkItem: 'character-foundations', submittedHead: sha, createdAt: at }))
    await a.registerTurn(job, token, 'pi-session', 'character-foundations', sha, at)
    const list = await b.dispatchable()
    assert.equal(list.length, 1)
    assert.equal((await a.turn(job, token))?.sessionId, 'pi-session')
    assert.equal(await a.claim(list[0]!, token, 'pi-session'), true)
    assert.equal(await b.claim(list[0]!, token, 'pi-session'), false)
    await a.accepted(id, token)
    const settlement = await b.settling(job, token)
    assert.equal(settlement.length, 1)
    await b.settle(settlement[0]!, token, true, 'character-foundations', 'unresolved', at)
    assert.equal((await a.settling(job, token)).length, 0)
    assert.equal((await a.activity(f.owner, f.thread))[0]?.disposition, 'unresolved')
    assert.deepEqual(await a.activity(f.stranger, f.thread), [])
    const checkpoint = { eligible: true, parentSha: sha, commitSha: nextSha,
      proofDigest: proof, workItem: 'character-foundations' }
    assert.equal(await a.attribute(f.owner, job, checkpoint, at), 1)
    assert.equal(await b.attribute(f.owner, job, checkpoint, at), 0)
    assert.equal((await a.activity(f.owner, f.thread))[0]?.checkpointSha, nextSha)
    await a.closeTurn(job, token)
    // A claimed SDK send without transcript confirmation is blocked, not replayed.
    const late = randomUUID()
    ;(await pair.a.testing.records.insert('story_thread_messages', { id: late, ownerUserId: f.owner,
      threadId: f.thread, sequence: 1, role: 'user', status: 'queued',
      body: 'Second instruction', phase: 'queued', createdAt: at }))
    ;(await pair.a.testing.records.insert('thread_live_inputs', { messageId: late,
      ownerUserId: f.owner, threadId: f.thread, sourceJobId: job,
      mode: 'steer', state: 'sdk-queued', piToken: token, targetPiToken: token, createdAt: at }))
    await b.recoverOrphaned()
    assert.equal((await pair.a.testing.records.first<{ state: string }>('thread_live_inputs',
      { messageId: late }))?.state, 'blocked')
    assert.equal((await pair.a.testing.records.first<{ phase: string }>('story_thread_messages',
      { id: late }))?.phase, 'blocked')
    assert.equal((await b.dispatchable()).length, 0)
    assert.deepEqual((await pair.a.testing.foreignKeyViolations()), [])
  } finally { pair.close() }
})
