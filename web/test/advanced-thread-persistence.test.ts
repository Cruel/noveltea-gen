import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openStudioDatabase } from './support/studio-database'
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
  for (const id of [owner, stranger])
    db.sqlite.prepare('INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)')
      .run(id, id, id + '@example.test', 1, Date.now(), Date.now())
  db.sqlite.prepare(`INSERT INTO repositories
    (id,owner_user_id,provider,provider_repository_id,name,created_at)
    VALUES (?,?,'github','123','Author/Story',?)`).run(repo, owner, at)
  db.sqlite.prepare(`INSERT INTO stories
    (id,owner_user_id,repository_id,directory,title,created_at,source_commit_sha)
    VALUES (?,?,?,'story','Story',?,?)`).run(story, owner, repo, at, sha)
  db.sqlite.prepare(`INSERT INTO studio_sessions
    (id,owner_user_id,story_id,title,status,source_commit_sha,created_at,updated_at)
    VALUES (?,?,?,'Source','completed',?,?,?)`).run(job, owner, story, sha, at, at)
  db.sqlite.prepare(`INSERT INTO generation_run_queue
    (job_id,owner_user_id,intent,phase,created_at,updated_at)
    VALUES (?,?,'start','finished',?,?)`).run(job, owner, at, at)
  db.sqlite.prepare(`INSERT INTO story_conversations
    (id,owner_user_id,story_id,title,created_at,updated_at)
    VALUES (?,?,?,'Conversation',?,?)`).run(conversation, owner, story, at, at)
  db.sqlite.prepare(`INSERT INTO story_threads
    (id,owner_user_id,conversation_id,title,activity_at,created_at)
    VALUES (?,?,?,'Root',?,?)`).run(thread, owner, conversation, at, at)
  db.sqlite.prepare(`INSERT INTO story_thread_runs
    (job_id,owner_user_id,thread_id,run_order) VALUES (?,?,?,0)`).run(job, owner, thread)
  return { owner, stranger, repo, story, job, conversation, thread }
}
function openPair() {
  const dir = mkdtempSync(join(tmpdir(), 'noveltea-advanced-thread-db-'))
  const path = join(dir, 'studio.sqlite')
  const a = openStudioDatabase(path), b = openStudioDatabase(path)
  return { a, b, path, close() {
    if (a.sqlite.open) a.sqlite.close()
    if (b.sqlite.open) b.sqlite.close()
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
    assert.deepEqual(pair.a.sqlite.pragma('foreign_key_check'), [])
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
    pair.a.sqlite.prepare(`INSERT INTO studio_sessions
      (id,owner_user_id,story_id,title,status,source_commit_sha,created_at,updated_at)
      VALUES (?,?,?,'Later job','completed',?,?,?)`).run(newerRun, f.owner, f.story, sha, at, at)
    pair.a.sqlite.prepare(`INSERT INTO story_thread_runs
      (job_id,owner_user_id,thread_id,run_order) VALUES (?,?,?,1)`).run(newerRun, f.owner, f.thread)
    const register: NewThreadChild = {
      childId: id, owner: f.owner, storyId: f.story, title: 'Restart',
      baseSha: sha, conversationId: f.conversation,
      parentThreadId: f.thread, threadId: 'restart:' + id,
      draft: data.draft, at, kind: 'restart',
    }
    await assert.rejects(b.registerChild(register), /Thread advanced/)
    assert.equal(await b.jobClaimed(id), false)
    assert.equal((await b.restartIntent(id))?.preparedAt, null)
    pair.a.sqlite.prepare('DELETE FROM story_thread_runs WHERE job_id=?').run(newerRun)
    pair.a.sqlite.prepare('DELETE FROM studio_sessions WHERE id=?').run(newerRun)
    assert.equal((await b.registerChild(register)).inserted, true)
    assert.equal((await a.registerChild(register)).inserted, false)
    assert.equal((await a.restartIntent(id))?.preparedAt, at)
    assert.equal((await b.registerChild({ ...register, at: '2026-11-06T00:00:00Z' })).inserted, false)
    assert.equal((await a.restartIntent(id))?.preparedAt, at,
      'idempotent registration must not rewrite the original preparation timestamp')
    assert.equal(await a.preparedRestart(f.owner, id, 'restart:' + id), true)
    assert.equal(await a.preparedRestart(f.stranger, id, 'restart:' + id), false)
    assert.deepEqual(pair.a.sqlite.pragma('foreign_key_check'), [])
  } finally { pair.close() }
})

test('same-Thread continuation claim is serialized, terminal crash recovery cannot duplicate a writer or messages', async () => {
  const pair = openPair()
  try {
    const f = await fixtures(pair.a)
    const a = pair.a.persistence.continuation, b = pair.b.persistence.continuation
    const first = randomUUID(), second = randomUUID()
    for (const [sequence, id] of [first, second].entries())
      pair.a.sqlite.prepare(`INSERT INTO story_thread_messages
        (id,owner_user_id,thread_id,sequence,role,status,body,phase,revision_scope_json,created_at)
        VALUES (?,?,?,?,'user','queued',?,'queued',?,?)`)
        .run(id, f.owner, f.thread, sequence, 'Author follow-up ' + sequence,
          JSON.stringify({ sourceSha: sha }), at)
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
    assert.equal((pair.a.sqlite.prepare('SELECT phase FROM generation_run_queue WHERE job_id=?')
      .get(first) as { phase: string }).phase, 'queued')
    assert.equal(await a.claim(f.owner, f.thread), null)
    pair.a.sqlite.prepare("UPDATE generation_run_queue SET phase='interrupted' WHERE job_id=?").run(first)
    pair.a.sqlite.prepare("UPDATE studio_sessions SET status='blocked' WHERE id=?").run(first)
    assert.equal(await a.settle(f.owner, first, null, at), f.thread)
    assert.equal(await b.settle(f.owner, first, null, at), f.thread)
    const messages = (await pair.a.persistence.messages.read(f.owner, f.thread)).messages
    assert.equal(messages.find(row => row.id === first)?.phase, 'blocked')
    assert.equal(messages.find(row => row.id === second)?.phase, 'queued')
    assert.equal(messages.filter(row => row.id === 'assistant:' + first).length, 1)
    assert.equal(await a.claim(f.owner, f.thread), null)
    assert.deepEqual(pair.a.sqlite.pragma('foreign_key_check'), [])
  } finally { pair.close() }
})

test('Pi SDK claim is one-shot across connections; verified checkpoints preserve causal order and orphan recovery blocks replay', async () => {
  const pair = openPair()
  try {
    const f = await fixtures(pair.a)
    const a = pair.a.persistence.steering, b = pair.b.persistence.steering
    pair.a.sqlite.prepare("UPDATE generation_run_queue SET phase='running' WHERE job_id=?").run(f.job)
    pair.a.sqlite.prepare("UPDATE studio_sessions SET status='running' WHERE id=?").run(f.job)
    const token = randomUUID(), id = randomUUID()
    const job = f.job
    pair.a.sqlite.prepare(`INSERT INTO story_thread_messages
      (id,owner_user_id,thread_id,sequence,role,status,body,phase,created_at)
      VALUES (?,?,?,0,'user','queued','Adjust character motive','queued',?)`).run(id, f.owner, f.thread, at)
    pair.a.sqlite.prepare(`INSERT INTO thread_live_inputs
      (message_id,owner_user_id,thread_id,source_job_id,mode,state,
       target_pi_token,target_work_item,submitted_head,created_at)
      VALUES (?,?,?,?,'steer','pending',?,'character-foundations',?,?)`)
      .run(id, f.owner, f.thread, job, token, sha, at)
    a.registerTurn(job, token, 'pi-session', 'character-foundations', sha, at)
    const list = b.dispatchable()
    assert.equal(list.length, 1)
    assert.equal(a.turn(job, token)?.sessionId, 'pi-session')
    assert.equal(a.claim(list[0]!, token, 'pi-session'), true)
    assert.equal(b.claim(list[0]!, token, 'pi-session'), false)
    a.accepted(id, token)
    const settlement = b.settling(job, token)
    assert.equal(settlement.length, 1)
    b.settle(settlement[0]!, token, true, 'character-foundations', 'unresolved', at)
    assert.equal(a.settling(job, token).length, 0)
    assert.equal(a.activity(f.owner, f.thread)[0]?.disposition, 'unresolved')
    assert.deepEqual(a.activity(f.stranger, f.thread), [])
    const checkpoint = { eligible: true, parentSha: sha, commitSha: nextSha,
      proofDigest: proof, workItem: 'character-foundations' }
    assert.equal(a.attribute(f.owner, job, checkpoint, at), 1)
    assert.equal(b.attribute(f.owner, job, checkpoint, at), 0)
    assert.equal(a.activity(f.owner, f.thread)[0]?.checkpointSha, nextSha)
    a.closeTurn(job, token)
    // A claimed SDK send without transcript confirmation is blocked, not replayed.
    const late = randomUUID()
    pair.a.sqlite.prepare(`INSERT INTO story_thread_messages
      (id,owner_user_id,thread_id,sequence,role,status,body,phase,created_at)
      VALUES (?,?,?,1,'user','queued','Second instruction','queued',?)`)
      .run(late, f.owner, f.thread, at)
    pair.a.sqlite.prepare(`INSERT INTO thread_live_inputs
      (message_id,owner_user_id,thread_id,source_job_id,mode,state,
       pi_token,target_pi_token,created_at)
      VALUES (?,?,?,?,'steer','sdk-queued',?,?,?)`).run(late, f.owner, f.thread, job, token, token, at)
    b.recoverOrphaned()
    assert.equal((pair.a.sqlite.prepare('SELECT state FROM thread_live_inputs WHERE message_id=?')
      .get(late) as { state: string }).state, 'blocked')
    assert.equal((pair.a.sqlite.prepare('SELECT phase FROM story_thread_messages WHERE id=?')
      .get(late) as { phase: string }).phase, 'blocked')
    assert.equal(b.dispatchable().length, 0)
    assert.deepEqual(pair.a.sqlite.pragma('foreign_key_check'), [])
  } finally { pair.close() }
})
