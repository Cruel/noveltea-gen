import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { openKyselyFeatureFixture, type KyselyFeatureFixture } from './support/studio-database'
import type { QueueRecord, QueueIntent } from '../src/persistence/generation-contracts'

const now = '2026-11-09T12:00:00Z'
const later = '2026-11-09T13:00:00Z'
const base = 'a'.repeat(40)
const pg = process.env.NT_TEST_PG_URL
if (process.env.NT_REQUIRE_KYSELY_PROOF === '1' && !pg)
  throw new Error('NT_TEST_PG_URL required for cross-engine generation queue conformance')
type F = KyselyFeatureFixture

async function setup(f: F) {
  const owner = await f.owner(), stranger = await f.owner()
  const repo = randomUUID(), story = randomUUID()
  await f.records.insert('repositories', {
    id: repo, ownerUserId: owner, provider: 'github',
    providerRepositoryId: repo, name: 'Owner/Story', createdAt: now,
  })
  await f.records.insert('stories', {
    id: story, ownerUserId: owner, repositoryId: repo,
    directory: 'story', title: 'Story', sourceCommitSha: base, createdAt: now,
  })
  return { owner, stranger, repo, story }
}
type X = Awaited<ReturnType<typeof setup>>

async function register(f: F, x: X, title: string) {
  const id = randomUUID()
  assert.equal(await f.generation.jobs.register(x.owner, id, x.story, title, base, now), true)
  return id
}
async function prepare(f: F, x: X, title: string) {
  const id = await register(f, x, title)
  const request = JSON.stringify({ task: title })
  const threadId = 'generation:' + id
  await f.generation.queue.enqueue(x.owner, id, 'start', 'prepared', now, request, threadId)
  return { id, request, threadId }
}

async function worker(f: F, operation: string, args: unknown[]) {
  const path = fileURLToPath(new URL('./support/kysely-generation-worker.ts', import.meta.url))
  const child = spawn(process.execPath, ['--import', 'tsx', path], {
    cwd: process.cwd(),
    env: { ...process.env, NT_GENERATION_WORKER_INPUT: JSON.stringify({
      options: f.databaseOptions, operation, args,
    }) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.setEncoding('utf8').on('data', (part: string) => { stdout += part })
  child.stderr.setEncoding('utf8').on('data', (part: string) => { stderr += part })
  const exit = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  })
  if (exit !== 0) throw new Error('Generation worker failed: ' + stderr.slice(0, 1000))
  return JSON.parse(stdout.trim()) as { ok: boolean; result: unknown; error?: string }
}

for (const backend of ['sqlite', 'postgres'] as const) {
  test(backend + ': generation job and event ports preserve owner identity, CAS and durable journals', {
    skip: backend === 'postgres' && !pg && 'Set NT_TEST_PG_URL',
    timeout: 90_000,
  }, async t => {
    const f = await openKyselyFeatureFixture(backend)
    t.after(() => f.close())
    const x = await setup(f)
    const id = await register(f, x, 'First Story')
    assert.equal(await f.generation.jobs.register(x.owner, id, x.story, 'Retry', base, later), true)
    assert.equal(await f.generation.jobs.register(x.stranger, id, x.story, 'Foreign', base, later), false)
    assert.equal(await f.generation.jobs.register(x.owner, id, x.story, 'Other SHA', 'b'.repeat(40), later), false)
    await assert.rejects(f.generation.jobs.register(x.stranger, randomUUID(), x.story,
      'Foreign', base, later), /foreign key|constraint/i)
    assert.deepEqual(await f.generation.jobs.identity(id), {
      storyId: x.story, ownerId: x.owner, commitSha: base,
    })
    assert.deepEqual(await f.generation.jobs.catalogStory(x.owner, x.story, 'github'), {
      id: x.story, directory: 'story', title: 'Story', commitSha: base,
      contentSha256: null, repository: 'Owner/Story', providerId: x.repo,
    })
    assert.equal(await f.generation.jobs.catalogStory(x.stranger, x.story, 'github'), null)
    assert.equal(await f.generation.jobs.catalogStory(x.owner, x.story, 'gitlab'), null)
    assert.equal(await f.generation.jobs.selected(x.stranger, id), null)
    assert.equal((await f.generation.jobs.selected(x.owner, id))?.title, 'First Story')
    assert.deepEqual(await f.generation.jobs.state(x.owner, id), {
      status: 'paused', requestJson: null, threadId: null, configJson: null,
    })
    assert.equal(await f.generation.jobs.saveConfiguration(x.owner, id, '{"budget":1}', later), true)
    assert.equal(await f.generation.jobs.saveConfiguration(x.stranger, id, 'bad', later), false)
    assert.equal(await f.generation.jobs.increaseBudget(x.owner, id,
      '{"budget":1}', '{"budget":2}', later), true)
    assert.equal(await f.generation.jobs.increaseBudget(x.owner, id,
      '{"budget":1}', '{"budget":3}', later), false)

    const events = f.generation.events
    await events.append(x.owner, id, {
      kind: 'started', stage: 'world', milestone: null,
      filesJson: '[]', status: 'running', createdAt: now,
    })
    await events.append(x.owner, id, {
      kind: 'working', stage: 'world', milestone: 'beginning',
      filesJson: '["scene.yaml"]', status: 'working', createdAt: later,
    })
    await assert.rejects(events.append(x.stranger, id, {
      kind: 'finished', stage: null, milestone: null,
      filesJson: '[]', status: null, createdAt: later,
    }), /foreign key|constraint/i)
    const all = await events.after(x.owner, id, 0, 10)
    assert.deepEqual(all.map(row => row.kind), ['started', 'working'])
    assert.equal(all[0]!.id < all[1]!.id, true)
    assert.deepEqual(await events.after(x.stranger, id, 0, 10), [])
    assert.deepEqual(await events.recent(x.owner, id, all[1]!.id + 1, 1),
      [all[1]])
    assert.equal(await events.hasAfter(x.owner, id, all[0]!.id), true)
    assert.equal(await events.hasAfter(x.owner, id, all[1]!.id), false)
    assert.equal(await events.hasAfter(x.stranger, id, 0), false)
    assert.equal(await f.generation.jobs.finalizedTranscriptCandidate(x.owner, id), null)
    assert.deepEqual(await f.generation.jobs.finalizedTranscriptCandidates(10, 0), [])
    assert.equal(await f.generation.queue.record(id), null)
    assert.equal(await f.generation.jobs.start(x.owner, id, 'gen', '{}', 'worker', later), false)
    assert.equal(await f.generation.jobs.finish(x.owner, id, 'gen', 'completed', false, 'worker', later), false)
  })

  test(backend + ': queue capacity and strict FIFO survive concurrent connections and process workers', {
    skip: backend === 'postgres' && !pg && 'Set NT_TEST_PG_URL',
    timeout: 90_000,
  }, async t => {
    const f = await openKyselyFeatureFixture(backend)
    t.after(() => f.close())
    const x = await setup(f)
    const second = await f.openIndependentGeneration()
    t.after(() => second.close())
    const jobs: Array<{ id: string; request: string; threadId: string }> = []
    for (let index = 0; index < 5; index++) jobs.push(await prepare(f, x, 'Job ' + index))
    assert.deepEqual((await f.generation.queue.record(jobs[0]!.id))?.sequence, 1)
    await assert.rejects(f.generation.queue.enqueue(x.owner, jobs[0]!.id, 'start',
      'paused', later), /already queued or executing/)

    const claims = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      i % 2 ? second.generation.queue.claim('worker-b', 2, later) :
        f.generation.queue.claim('worker-a', 2, later)))
    const active = claims.filter((c): c is QueueRecord => c !== null)
    assert.equal(active.length, 2)
    assert.deepEqual(active.map(c => c.jobId).sort(),
      jobs.slice(0, 2).map(j => j.id).sort())
    assert.deepEqual((await f.generation.queue.foreignRunning('worker-a'))
      .map(row => row.jobId).sort(),
      active.filter(c => c.workerId !== 'worker-a').map(c => c.jobId).sort())
    assert.equal(await f.generation.queue.finish(active[0]!.jobId, 'stale', true, later), false)
    assert.equal(await f.generation.queue.interrupt(active[0]!.jobId, 'stale', later), false)
    assert.equal(await f.generation.queue.claim('blocked', 1, later), null)
    assert.equal(await f.generation.queue.finish(active[0]!.jobId,
      active[0]!.workerId!, true, later), true)
    assert.equal(await second.generation.queue.finish(active[0]!.jobId,
      active[0]!.workerId!, true, later), false)
    assert.equal((await second.generation.queue.claim('worker-c', 2, later))?.jobId, jobs[2]!.id)
    assert.equal((await second.generation.queue.record(jobs[3]!.id))?.phase, 'queued')
    assert.equal(await f.generation.queue.dequeue(x.stranger, jobs[3]!.id), false)
    assert.equal(await f.generation.queue.dequeue(x.owner, jobs[3]!.id), true)
    assert.equal(await f.generation.queue.record(jobs[3]!.id), null)
    assert.equal(await f.generation.queue.dequeue(x.owner, jobs[1]!.id), false)
    assert.equal(await f.generation.queue.claim('blocked', 2, later), null)

    const processClaims = await Promise.all([
      worker(f, 'claim', ['process-one', 3, later]),
      worker(f, 'claim', ['process-two', 3, later]),
      worker(f, 'claim', ['process-three', 3, later]),
    ])
    assert.ok(processClaims.every(p => p.ok))
    assert.deepEqual(processClaims.map(p => (p.result as QueueRecord | null)?.jobId)
      .filter(Boolean), [jobs[4]!.id], 'only one eligible job remains')
    assert.equal(await f.generation.queue.finish(jobs[1]!.id,
      active.find(c => c.jobId === jobs[1]!.id)!.workerId!, false, later), true)
    assert.equal((await f.generation.queue.record(jobs[1]!.id))?.phase, 'interrupted')
    assert.equal(await second.generation.queue.interrupt(jobs[1]!.id,
      active.find(c => c.jobId === jobs[1]!.id)!.workerId!, later), false)
    await assert.rejects(second.generation.queue.enqueue(x.owner, jobs[1]!.id,
      'resume', 'paused', later), /reconciliation/)
  })

  test(backend + ': paused and running job admission is worker-fenced, interruptible and recoverable once', {
    skip: backend === 'postgres' && !pg && 'Set NT_TEST_PG_URL',
    timeout: 90_000,
  }, async t => {
    const f = await openKyselyFeatureFixture(backend)
    t.after(() => f.close())
    const x = await setup(f)
    const session = await prepare(f, x, 'Prepare and resume')
    const queue = f.generation.queue, jobs = f.generation.jobs
    const first = await worker(f, 'claim', ['first-process', 1, later])
    assert.equal((first.result as QueueRecord)?.jobId, session.id)
    assert.equal(await jobs.start(x.stranger, session.id, session.threadId,
      session.request, 'first-process', later), false)
    assert.equal(await jobs.start(x.owner, session.id, session.threadId,
      session.request, 'stale', later), false)
    assert.equal(await jobs.start(x.owner, session.id, session.threadId,
      '{"task":"modified"}', 'first-process', later), false)
    assert.equal(await jobs.start(x.owner, session.id, session.threadId,
      session.request, 'first-process', later), true)
    assert.equal(await jobs.start(x.owner, session.id, session.threadId,
      session.request, 'first-process', later), false)
    assert.equal(await jobs.finish(x.owner, session.id, session.threadId,
      'completed', false, 'stale', later), false)
    assert.equal(await jobs.finish(x.stranger, session.id, session.threadId,
      'completed', false, 'first-process', later), false)
    assert.equal((await jobs.state(x.owner, session.id))?.status, 'running')
    assert.equal(await queue.interrupt(session.id, 'stale', later), false)
    assert.equal(await queue.interrupt(session.id, 'first-process', later), true)
    assert.equal(await jobs.finish(x.owner, session.id, session.threadId,
      'completed', false, 'first-process', later), false)
    assert.equal((await jobs.state(x.owner, session.id))?.status, 'running')
    await assert.rejects(queue.reconcileAndEnqueue(x.owner, session.id,
      'resume', { status: 'running', request: session.request, thread: 'tampered' },
      true, later), /verified checkpoint/)
    assert.equal((await queue.record(session.id))?.phase, 'interrupted')
    await assert.rejects(queue.reconcileAndEnqueue(x.stranger, session.id,
      'resume', { status: 'running', request: session.request, thread: session.threadId },
      true, later), /verified checkpoint/)
    assert.equal((await queue.record(session.id))?.phase, 'interrupted')
    await queue.reconcileAndEnqueue(x.owner, session.id, 'resume', {
      status: 'running', request: session.request, thread: session.threadId,
    }, true, later)
    assert.equal((await jobs.state(x.owner, session.id))?.status, 'paused')
    assert.equal((await queue.record(session.id))?.phase, 'queued')
    assert.equal((await queue.record(session.id))?.intent, 'resume')
    await assert.rejects(queue.reconcileAndEnqueue(x.owner, session.id, 'resume', {
      status: 'running', request: session.request, thread: session.threadId,
    }, true, later), /verified checkpoint/)
    const claim = await worker(f, 'claim', ['second-process', 1, later])
    assert.equal((claim.result as QueueRecord)?.jobId, session.id)
    assert.equal(await jobs.start(x.owner, session.id, session.threadId,
      session.request, 'first-process', later), false)
    assert.equal(await jobs.start(x.owner, session.id, session.threadId,
      session.request, 'second-process', later), true)
    assert.equal(await jobs.finish(x.owner, session.id, session.threadId,
      'completed', true, 'second-process', later), true)
    assert.equal(await jobs.finish(x.owner, session.id, session.threadId,
      'completed', false, 'second-process', later), false)
    assert.equal((await f.records.first<{ needsAuthor: number }>('story_thread_runs', {
      jobId: session.id,
    }))?.needsAuthor, undefined, 'standalone jobs have no Thread run')
    assert.equal(await queue.finish(session.id, 'second-process', true, later), true)
    assert.equal(await queue.finish(session.id, 'second-process', true, later), false)
    assert.equal((await jobs.state(x.owner, session.id))?.status, 'completed')
  })

  test(backend + ': cancelled, deleted and interrupted work stays fenced; published transcript evidence is filtered', {
    skip: backend === 'postgres' && !pg && 'Set NT_TEST_PG_URL',
    timeout: 90_000,
  }, async t => {
    const f = await openKyselyFeatureFixture(backend)
    t.after(() => f.close())
    const x = await setup(f), id = await register(f, x, 'With Thread')
    const threadId = randomUUID()
    await f.records.insert('story_threads', {
      id: threadId, ownerUserId: x.owner, storyId: x.story,
      title: 'Thread', activityAt: now, createdAt: now,
    })
    await f.records.insert('story_thread_runs', {
      jobId: id, ownerUserId: x.owner, threadId, runOrder: 0,
    })
    await f.records.update('story_threads', { id: threadId }, { deletedAt: later })
    await assert.rejects(f.generation.queue.enqueue(x.owner, id, 'start', 'prepared',
      now, '{"task":"bad"}', 'thread:' + id), /Deleted Thread/)
    assert.equal((await f.generation.jobs.state(x.owner, id))?.requestJson, null)
    await f.records.update('story_threads', { id: threadId }, { deletedAt: null })
    await f.generation.queue.enqueue(x.owner, id, 'start', 'prepared',
      now, '{"task":"ready"}', 'thread:' + id)
    assert.equal((await f.generation.queue.record(id))?.phase, 'queued')
    assert.equal(await f.generation.queue.dequeue(x.owner, id), true)
    assert.equal(await f.generation.queue.record(id), null)
    await f.generation.queue.enqueue(x.owner, id, 'start', 'paused', later)
    const first = await f.generation.queue.claim('worker', 1, later)
    assert.equal(first?.jobId, id)
    assert.equal(await f.generation.jobs.start(x.owner, id, 'thread:' + id,
      '{"task":"ready"}', 'worker', later), true)
    await f.generation.jobs.cancel(x.owner, id, later)
    assert.equal((await f.generation.jobs.state(x.owner, id))?.status, 'cancelled')
    assert.equal(await f.generation.queue.interrupt(id, 'worker', later), true)
    assert.equal(await f.generation.queue.record(id).then(row => row?.phase), 'interrupted')
    await assert.rejects(f.generation.queue.enqueue(x.owner, id,
      'resume', 'paused', later), /Job state changed/)
    await f.generation.jobs.authorDecision(x.owner, id, 'paused', later)
    assert.equal((await f.generation.jobs.state(x.owner, id))?.status, 'cancelled',
      'author decisions cannot silently reactivate cancelled jobs')
    await f.records.update('studio_sessions', { id }, { status: 'completed' })
    await f.records.update('generation_run_queue', { jobId: id }, { phase: 'finished' })
    await f.records.insert('github_publications', {
      jobId: id, ownerUserId: x.owner, targetBranch: 'main',
      remoteBranch: 'review/story', headSha: base, phase: 'linked',
      prNumber: 123, prUrl: 'https://example.test/review/123', updatedAt: later,
    })
    assert.deepEqual(await f.generation.jobs.finalizedTranscriptCandidates(10, 0), [{
      owner: x.owner, jobId: id, threadId, completedAt: later,
      publishedAt: later, publishedHead: base,
    }])
    assert.equal((await f.generation.jobs.finalizedTranscriptCandidate(x.owner, id))?.jobId, id)
    assert.equal(await f.generation.jobs.finalizedTranscriptCandidate(x.stranger, id), null)
    await f.records.update('story_thread_runs', { jobId: id }, { needsAuthor: 1 })
    assert.deepEqual(await f.generation.jobs.finalizedTranscriptCandidates(10, 0), [])
    await f.records.update('story_thread_runs', { jobId: id }, { needsAuthor: 0 })
    await f.records.update('story_threads', { id: threadId }, { deletedAt: later })
    assert.deepEqual(await f.generation.jobs.finalizedTranscriptCandidates(10, 0), [])
  })

  test(backend + ': failed admission and interrupted recovery roll back every SQL mutation', {
    skip: backend === 'postgres' && !pg && 'Set NT_TEST_PG_URL',
    timeout: 90_000,
  }, async t => {
    const f = await openKyselyFeatureFixture(backend)
    t.after(() => f.close())
    const x = await setup(f)
    const id = await register(f, x, 'Rollback')
    const request = '{"task":"rollback"}'
    const threadId = 'generation:' + id
    // Deliberately bypass the TypeScript input union to force the DB CHECK to
    // fail AFTER the preparatory session CAS. Neither write may survive.
    const invalid = 'invalid' as QueueIntent
    await assert.rejects(f.generation.queue.enqueue(x.owner, id, invalid,
      'prepared', now, request, threadId), /check|constraint/i)
    assert.deepEqual(await f.generation.jobs.state(x.owner, id), {
      status: 'paused', requestJson: null, threadId: null, configJson: null,
    })
    assert.equal(await f.generation.queue.record(id), null)
    await f.generation.queue.enqueue(x.owner, id, 'start', 'prepared', now, request, threadId)
    assert.equal((await f.generation.queue.claim('first-worker', 1, later))?.jobId, id)
    assert.equal(await f.generation.jobs.start(x.owner, id, threadId, request,
      'first-worker', later), true)
    assert.equal(await f.generation.queue.interrupt(id, 'first-worker', later), true)

    await assert.rejects(f.generation.queue.reconcileAndEnqueue(x.owner, id,
      invalid, { status: 'running', request, thread: threadId }, true, later),
    /check|constraint/i)
    assert.equal((await f.generation.jobs.state(x.owner, id))?.status, 'running',
      'rolled-back recovery must not pause the session')
    assert.equal((await f.generation.queue.record(id))?.phase, 'interrupted',
      'rolled-back recovery must not consume the interrupted receipt')
    await f.generation.queue.reconcileAndEnqueue(x.owner, id, 'resume',
      { status: 'running', request, thread: threadId }, true, later)
    assert.equal((await f.generation.queue.record(id))?.phase, 'queued')
    assert.equal((await f.generation.jobs.state(x.owner, id))?.status, 'paused')
  })

  test(backend + ': reviewed blocked recovery requeues the original Thread exactly once', {
    skip: backend === 'postgres' && !pg && 'Set NT_TEST_PG_URL',
    timeout: 90_000,
  }, async t => {
    const f = await openKyselyFeatureFixture(backend)
    t.after(() => f.close())
    const x = await setup(f)
    const original = await prepare(f, x, 'Original approved correction')
    const queue = f.generation.queue
    const jobs = f.generation.jobs
    assert.equal((await queue.claim('original-worker', 1, later))?.jobId, original.id)
    assert.equal(await jobs.start(x.owner, original.id, original.threadId,
      original.request, 'original-worker', later), true)
    assert.equal(await jobs.finish(x.owner, original.id, original.threadId,
      'blocked', false, 'original-worker', later), true)
    assert.equal(await queue.finish(original.id, 'original-worker', true, later), true)
    const saved = { status: 'blocked', request: original.request, thread: original.threadId }
    assert.equal((await queue.record(original.id))?.phase, 'finished')
    await assert.rejects(queue.reconcileAndEnqueue(x.owner, original.id, 'resume',
      saved, false, later), /lacks verified original-Thread recovery/)
    await assert.rejects(queue.reconcileAndEnqueue(x.stranger, original.id, 'resume',
      saved, false, later, true), /verified checkpoint/)
    await assert.rejects(queue.reconcileAndEnqueue(x.owner, original.id, 'start',
      saved, false, later, true), /Invalid queued resume proof kind/)
    await assert.rejects(queue.reconcileAndEnqueue(x.owner, original.id, 'resume',
      { ...saved, thread: 'substitute' }, false, later, true), /verified checkpoint/)
    assert.equal((await jobs.state(x.owner, original.id))?.status, 'blocked')
    assert.equal((await queue.record(original.id))?.phase, 'finished')
    await assert.rejects(queue.reconcileAndEnqueue(x.owner, original.id, 'resume',
      saved, false, later, true), /Invalid queued resume proof kind/)
    await queue.reconcileAndEnqueue(x.owner, original.id, 'resume',
      saved, false, later, true, 'approved-work')
    assert.equal((await jobs.state(x.owner, original.id))?.status, 'paused')
    assert.equal((await queue.record(original.id))?.phase, 'queued')
    assert.equal((await queue.record(original.id))?.intent, 'resume')
    assert.equal((await queue.record(original.id))?.resumeKind, 'approved-work',
      'the exact reviewed recovery reason survives the atomic blocked→queued CAS')
    await assert.rejects(queue.reconcileAndEnqueue(x.owner, original.id, 'resume',
      saved, false, later, true), /verified checkpoint/)
    assert.equal((await queue.record(original.id))?.phase, 'queued')
    const handoff = await queue.claim('continued-worker', 1, later)
    assert.equal(handoff?.jobId, original.id)
    assert.equal(handoff?.resumeKind, 'approved-work',
      'worker claim must retain the original admission mechanism')
    assert.equal(await jobs.start(x.owner, original.id, original.threadId,
      original.request, 'continued-worker', later), true)
    assert.equal(await jobs.finish(x.owner, original.id, original.threadId,
      'completed', false, 'continued-worker', later), true)
    assert.equal(await queue.finish(original.id, 'continued-worker', true, later), true)
    assert.equal((await jobs.state(x.owner, original.id))?.status, 'completed')
  })

  test(backend + ': independent processes enforce capacity and do not reclaim exited workers', {
    skip: backend === 'postgres' && !pg && 'Set NT_TEST_PG_URL',
    timeout: 90_000,
  }, async t => {
    const f = await openKyselyFeatureFixture(backend)
    t.after(() => f.close())
    const x = await setup(f)
    const jobs: Array<{ id: string; request: string; threadId: string }> = []
    for (let i = 0; i < 4; i++) jobs.push(await prepare(f, x, 'Process ' + i))
    const claims = await Promise.all(Array.from({ length: 5 }, (_, i) =>
      worker(f, 'claim', ['worker-' + i, 2, later])))
    assert.ok(claims.every(c => c.ok), JSON.stringify(claims))
    const active = claims.map(c => c.result as QueueRecord | null).filter(
      (c): c is QueueRecord => c !== null)
    assert.equal(active.length, 2)
    assert.deepEqual(active.map(c => c.jobId).sort(), jobs.slice(0, 2).map(j => j.id).sort())
    assert.equal((await f.generation.queue.record(jobs[0]!.id))?.phase, 'running')
    assert.equal((await f.generation.queue.record(jobs[1]!.id))?.phase, 'running')
    assert.equal((await worker(f, 'claim', ['new-worker', 2, later])).result, null,
      'process exit cannot implicitly release a worker lease')
    assert.equal((await worker(f, 'finish',
      [active[0]!.jobId, active[0]!.workerId, true, later])).result, true)
    const replacement = await worker(f, 'claim', ['replacement', 2, later])
    assert.equal((replacement.result as QueueRecord)?.jobId, jobs[2]!.id)
    assert.equal((await f.generation.queue.record(jobs[2]!.id))?.phase, 'running')
    assert.equal((await f.generation.queue.record(jobs[3]!.id))?.phase, 'queued')
  })
}
