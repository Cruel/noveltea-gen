import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type {
  ForkReservation, NewThreadChild, RecoveryContinuationRegistration, RestartReservation,
} from '../src/persistence/advanced-thread-contracts'
import { openKyselyFeatureFixture, type KyselyFeatureFixture } from './support/kysely-feature-fixture'

const at = '2026-11-09T12:00:00Z'
const later = '2026-11-09T13:00:00Z'
const base = 'a'.repeat(40)
const checked = 'b'.repeat(40)
const pg = process.env.NT_TEST_PG_URL
if (process.env.NT_REQUIRE_KYSELY_PROOF === '1' && !pg)
  throw new Error('NT_TEST_PG_URL required for shared advanced Thread conformance')

type Setup = Awaited<ReturnType<typeof setup>>
async function setup(fixture: KyselyFeatureFixture) {
  const owner = await fixture.owner(), stranger = await fixture.owner()
  const repo = randomUUID(), story = randomUUID(), job = randomUUID(), thread = randomUUID()
  await fixture.records.insert('repositories', {
    id: repo, ownerUserId: owner, provider: 'github', providerRepositoryId: repo,
    name: 'Author/Story', createdAt: at,
  })
  await fixture.records.insert('stories', {
    id: story, ownerUserId: owner, repositoryId: repo, directory: 'story',
    title: 'Story', sourceCommitSha: base, createdAt: at,
  })
  await fixture.records.insert('studio_sessions', {
    id: job, ownerUserId: owner, storyId: story, title: 'Root',
    status: 'completed', sourceCommitSha: base, createdAt: at, updatedAt: at,
    generationRequestJson: JSON.stringify({ task: 'Initial request', fixture: true }),
  })
  await fixture.records.insert('story_threads', {
    id: thread, ownerUserId: owner, storyId: story, title: 'Root', createdAt: at, activityAt: at,
  })
  await fixture.records.insert('story_thread_runs', {
    jobId: job, ownerUserId: owner, threadId: thread, runOrder: 0,
  })
  await fixture.records.insert('generation_run_queue', {
    jobId: job, ownerUserId: owner, intent: 'start', phase: 'finished',
    createdAt: at, updatedAt: at,
  })
  return { owner, stranger, repo, story, job, thread }
}
function fork(f: Setup, childId: string = randomUUID()): ForkReservation {
  return {
    childId, owner: f.owner, sourceJobId: f.job, sourceBaseSha: base,
    commitSha: checked, bundle: '{"proof":true}', draft: '{"source":"fork"}',
    sourceThreadId: f.thread, proofDigest: 'f'.repeat(64),
    guidance: 'Continue from checkpoint', history: JSON.stringify([
      { role: 'user', originId: 'source-message', body: 'Ancestral prompt',
        verifiedSha: base, createdAt: at },
      { role: 'assistant', originId: 'source-answer', body: 'Verified answer',
        verifiedSha: checked, createdAt: at },
    ]), at,
  }
}
function child(f: Setup, d: ForkReservation, kind: 'fork' | 'edit' = 'fork'): NewThreadChild {
  return {
    childId: d.childId, owner: d.owner, storyId: f.story, title: 'Branch',
    baseSha: d.commitSha, parentThreadId: f.thread, threadId: 'fork:' + d.childId,
    draft: d.draft, at, kind, history: JSON.parse(d.history),
    guidance: d.guidance,
  }
}
function restart(f: Setup, childId: string = randomUUID()): RestartReservation {
  return {
    childId, owner: f.owner, sourceThread: f.thread, sourceJob: f.job, rootJob: f.job,
    original: base, selected: checked, mode: 'newer', branch: 'review',
    draft: '{"source":"restart"}', at,
  }
}
async function worker(fixture: KyselyFeatureFixture,
  method: 'reserveFork' | 'registerChild' | 'reserveRestart' | 'registerRecoveryContinuation',
  data: object) {
  const path = fileURLToPath(new URL('./support/kysely-advanced-worker.ts', import.meta.url))
  const child = spawn(process.execPath, ['--import', 'tsx', path], {
    cwd: process.cwd(),
    env: { ...process.env, NT_ADVANCED_WORKER_INPUT: JSON.stringify({
      options: fixture.databaseOptions, method, data,
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
  if (exit !== 0) throw new Error('Independent lifecycle worker failed: ' + stderr.slice(0, 1000))
  return JSON.parse(stdout.trim()) as { ok: boolean; result?: unknown; message?: string }
}

for (const backend of ['sqlite', 'postgres'] as const) {
  test(backend + ': shared fork/restart/checkpoint contracts and atomic rollback', {
    skip: backend === 'postgres' && !pg && 'Set NT_TEST_PG_URL',
    timeout: 90_000,
  }, async t => {
    const fixture = await openKyselyFeatureFixture(backend)
    t.after(() => fixture.close())
    const { records: data, advancedThreads: a } = fixture
    const f = await setup(fixture)
    const other = await fixture.openIndependentAdvancedThreads()
    t.after(() => other.close())
    const b = other.advancedThreads

    await t.test('owner-scoped identity, ancestor, run, inspection and history', async () => {
      assert.equal((await a.identity(f.owner, f.thread))?.story, f.story)
      assert.equal((await a.ancestor(f.owner, f.thread))?.id, f.thread)
      assert.equal(await a.identity(f.stranger, f.thread), null)
      assert.equal(await a.ancestor(f.stranger, f.thread), null)
      assert.equal((await a.sourceThread(f.owner, f.job))?.id, f.thread)
      assert.equal(await a.sourceThread(f.stranger, f.job), null)
      assert.equal((await a.run(f.owner, f.thread, 'last'))?.jobId, f.job)
      assert.equal(await a.run(f.stranger, f.thread, 'first'), null)
      assert.equal(await a.runOrder(f.owner, f.thread, f.job), 0)
      assert.equal(await a.runOrder(f.stranger, f.thread, f.job), null)
      assert.equal((await a.repository(f.owner, f.story))?.repositoryId, f.repo)
      assert.equal(await a.repository(f.stranger, f.story), null)
      assert.equal((await a.inspectJob(f.owner, f.job)).threadId, f.thread)
      assert.equal((await a.inspectJob(f.stranger, f.job)).threadId, null)
      assert.deepEqual(await a.runJobs(f.owner, f.thread), [f.job])
      assert.deepEqual(await a.runJobs(f.stranger, f.thread), [])
    })
    await t.test('fork idempotency, immutable ancestry, atomic failed import and edit fork', async () => {
      const d = fork(f)
      assert.deepEqual(await a.reserveFork(d), await b.reserveFork(d))
      assert.equal((await a.forkIntent(f.owner, d.childId))?.proofDigest, d.proofDigest)
      assert.equal(await b.forkIntent(f.stranger, d.childId), null)
      assert.equal((await a.forkDraft(f.owner, d.childId))?.original, d.draft)
      assert.equal(await a.forkDraft(f.stranger, d.childId), null)
      await assert.rejects(a.reserveFork({ ...d, guidance: 'Another permission' }),
        /different checkpoint/)
      await assert.rejects(a.registerChild({ ...child(f, d), history: undefined }),
        /history snapshot is missing/)
      assert.equal(await b.jobClaimed(d.childId), false)
      const [first, second] = await Promise.all([a.registerChild(child(f, d)),
        b.registerChild(child(f, d))])
      assert.equal(Number(first.inserted) + Number(second.inserted), 1)
      const history = await a.history(f.owner, 'fork:' + d.childId)
      assert.deepEqual(history.map(m => [m.body, m.status]), [
        ['Ancestral prompt', 'delivered'], ['Verified answer', 'delivered'],
        [d.guidance, 'queued'],
      ])
      assert.deepEqual((await a.history(f.owner, 'fork:' + d.childId, 2))
        .map(m => m.body), ['Ancestral prompt', 'Verified answer'])
      assert.equal((await a.ancestor(f.owner, 'fork:' + d.childId))?.id, f.thread)
      assert.equal(await a.inheritedCount(f.owner, 'fork:' + d.childId, 3), 2)
      assert.equal((await a.inspectJob(f.owner, d.childId)).messages.length, 3)
      assert.equal(await a.runOrder(f.owner, 'fork:' + d.childId, d.childId), 0)
      assert.equal((await a.editable(f.owner, 'fork:' + d.childId, 'guidance:' +
        'fork:' + d.childId))?.status, 'queued')
      await assert.rejects(a.reserveRestart(restart(f, d.childId)), /assigned/)
      await assert.rejects(a.importHistory(f.owner, 'fork:' + d.childId, [], '', at),
        /already imported/)
      await assert.rejects(a.importHistory(f.stranger, 'fork:' + d.childId, [], '', at),
        /Thread not found/)

      const edit = fork(f)
      await a.reserveFork({ ...edit, editedMessageId: 'source-message', editedBody: 'Rewrite' })
      const editChild = {
        ...child(f, edit, 'edit'), editedMessageId: 'source-message', editedBody: 'Rewrite',
      }
      await a.registerChild(editChild)
      const rows = await b.history(f.owner, 'fork:' + edit.childId)
      assert.equal(rows.at(-1)?.body, 'Rewrite')
      assert.equal(rows.at(-1)?.origin, 'source-message')
      assert.equal(rows.at(-1)?.status, 'queued')
      assert.equal(await a.inheritedCount(f.stranger, 'fork:' + edit.childId, 99), 0)
    })
    await t.test('restart reservation retains exact pinned root and denies stale run', async () => {
      const d = restart(f), childId = d.childId
      assert.deepEqual(await a.reserveRestart(d), await b.reserveRestart(d))
      await assert.rejects(b.reserveRestart({ ...d, selected: base }), /reservation changed/)
      assert.equal((await a.restartIntent(f.owner, childId))?.preparedAt, null)
      assert.equal(await b.restartIntent(f.stranger, childId), null)
      const newer = randomUUID()
      await data.insert('studio_sessions', {
        id: newer, ownerUserId: f.owner, storyId: f.story, title: 'Later',
        status: 'completed', sourceCommitSha: checked, createdAt: later, updatedAt: later,
      })
      await data.insert('story_thread_runs', {
        jobId: newer, ownerUserId: f.owner, threadId: f.thread, runOrder: 1,
      })
      const prepared = { ...child(f, fork(f, childId)), kind: 'restart' as const,
        draft: d.draft, baseSha: d.selected, history: undefined, guidance: undefined }
      await assert.rejects(a.registerChild(prepared), /advanced during restart/)
      assert.equal(await a.jobClaimed(childId), false)
      await data.delete('story_thread_runs', { jobId: newer })
      await data.delete('studio_sessions', { id: newer })
      assert.equal((await a.registerChild(prepared)).inserted, true)
      assert.equal((await b.registerChild(prepared)).inserted, false)
      assert.equal((await a.inspectJob(f.owner, childId)).restart?.mode, 'newer')
      assert.equal((await a.restartIntent(f.owner, childId))?.preparedAt, at)
      assert.equal(await a.preparedRestart(f.owner, childId, prepared.threadId), true)
      assert.equal(await a.preparedRestart(f.stranger, childId, prepared.threadId), false)
    })
    await t.test('recovery is one visible Thread, rejects pending, nonblocked and verified failures', async () => {
      const d = fork(f)
      await a.reserveFork(d)
      const continuation: RecoveryContinuationRegistration = {
        owner: f.owner, sourceJobId: f.job, sourceThreadId: f.thread,
        childId: d.childId, storyId: f.story, title: 'Recovery',
        baseSha: checked, checkpointSha: checked, draft: d.draft,
        guidance: d.guidance, at,
      }
      await assert.rejects(a.registerRecoveryContinuation(continuation), /not safely recoverable/)
      await data.update('studio_sessions', { id: f.job }, { status: 'blocked' })
      const queued = randomUUID()
      await data.insert('story_thread_messages', {
        id: queued, ownerUserId: f.owner, threadId: f.thread,
        sequence: 0, role: 'user', status: 'queued', body: 'Pending', phase: 'queued',
        createdAt: at,
      })
      await assert.rejects(a.registerRecoveryContinuation(continuation), /queued instructions/)
      assert.equal(await a.jobClaimed(d.childId), false)
      await data.delete('story_thread_messages', { id: queued })
      assert.equal((await a.registerRecoveryContinuation(continuation)).inserted, true)
      assert.equal((await b.registerRecoveryContinuation(continuation)).inserted, false)
      assert.equal(await a.runOrder(f.owner, f.thread, d.childId), 1)
      assert.equal(await a.identity(f.owner, 'fork:' + d.childId), null)
      assert.equal((await b.history(f.owner, f.thread)).at(-1)?.body, d.guidance)
      assert.deepEqual((await a.history(f.owner, f.thread, undefined, 0))
        .map(row => row.body), ['Initial request'],
        'historical cutoff excludes later internal executions')
      assert.equal((await a.inspectJob(f.owner, d.childId)).threadId, f.thread)
      assert.equal((await fixture.messages.read(f.owner, f.thread)).turnReceipts[0]?.executions.length, 2)

      await data.update('studio_sessions', { id: d.childId }, { status: 'blocked' })
      await data.insert('generation_run_queue', {
        jobId: d.childId, ownerUserId: f.owner, intent: 'start', phase: 'finished',
        createdAt: at, updatedAt: at,
      })
      await data.update('story_thread_messages',
        { id: 'guidance:fork:' + d.childId }, { phase: 'blocked' })
      await data.insert('generation_events', {
        jobId: d.childId, ownerUserId: f.owner, kind: 'verified',
        createdAt: later,
      })
      const second = fork(f)
      await a.reserveFork(second)
      await assert.rejects(a.registerRecoveryContinuation({
        ...continuation, childId: second.childId,
        expectedLatestJobId: d.childId,
      }), /verified new work/)
      assert.equal(await a.jobClaimed(second.childId), false)
    })
    await t.test('immutable applied message, historical cutoff and restart', async () => {
      const original = randomUUID(), id = randomUUID()
      await a.importAppliedMessage(f.owner, f.thread, id, 'Applied', original, f.job, at)
      await b.importAppliedMessage(f.owner, f.thread, id, 'Applied', original, f.job, at)
      await assert.rejects(b.importAppliedMessage(f.stranger, f.thread, id, 'Applied', original,
        f.job, at), /different request/)
      await assert.rejects(b.importAppliedMessage(f.owner, f.thread, id, 'Changed', original,
        f.job, at), /different request/)
      assert.equal((await a.origin(f.owner, id))?.origin, 'author-update:' + original)
      assert.equal(await a.origin(f.stranger, id), null)
      assert.equal((await a.history(f.owner, f.thread)).filter(row => row.id === id).length, 1)
      const restarted = await fixture.reopenAdvancedThreads()
      assert.equal((await restarted.origin(f.owner, id))?.body, 'Applied')
    })
  })

  test(backend + ': source membership, stale execution, archival and deletion fail closed', {
    skip: backend === 'postgres' && !pg && 'Set NT_TEST_PG_URL',
    timeout: 90_000,
  }, async t => {
    const fixture = await openKyselyFeatureFixture(backend)
    t.after(() => fixture.close())
    const f = await setup(fixture)
    const { advancedThreads: a, records: data } = fixture
    const unrelated = randomUUID()
    await data.insert('story_threads', {
      id: unrelated, ownerUserId: f.owner, storyId: f.story,
      title: 'Other Thread', activityAt: at, createdAt: at,
    })
    const wrongThread = fork(f)
    await assert.rejects(a.reserveFork({ ...wrongThread, sourceThreadId: unrelated }),
      /source Story|pinned baseline/)
    assert.equal(await data.count('checkpoint_forks', { childId: wrongThread.childId }), 0)
    const reserved = fork(f)
    await a.reserveFork(reserved)
    const recovery: RecoveryContinuationRegistration = {
      owner: f.owner, sourceJobId: f.job, sourceThreadId: f.thread,
      childId: reserved.childId, storyId: f.story, title: 'Retry',
      baseSha: checked, checkpointSha: checked, draft: reserved.draft,
      guidance: reserved.guidance, at,
    }
    await data.update('studio_sessions', { id: f.job }, { status: 'blocked' })
    await data.update('generation_run_queue', { jobId: f.job }, { phase: 'running' })
    await assert.rejects(a.registerRecoveryContinuation(recovery), /not safely recoverable/)
    assert.equal(await a.jobClaimed(reserved.childId), false)
    await data.update('generation_run_queue', { jobId: f.job }, { phase: 'interrupted' })
    await data.update('story_threads', { id: f.thread }, { archivedAt: at })
    await assert.rejects(a.registerRecoveryContinuation(recovery), /archived Thread/)
    await data.update('story_threads', { id: f.thread }, { archivedAt: null, deletedAt: at })
    await assert.rejects(a.registerRecoveryContinuation(recovery), /deleted or no longer accessible/)
    await assert.rejects(a.reserveRestart(restart(f)), /deleted or no longer accessible/)
    await assert.rejects(a.reserveFork(fork(f)), /deleted or no longer accessible/)
    assert.equal(await a.jobClaimed(reserved.childId), false)
  })

  test(backend + ': competing recovery executions cannot both advance one blocked Thread', {
    skip: backend === 'postgres' && !pg && 'Set NT_TEST_PG_URL',
    timeout: 90_000,
  }, async t => {
    const fixture = await openKyselyFeatureFixture(backend)
    t.after(() => fixture.close())
    const f = await setup(fixture)
    await fixture.records.update('studio_sessions', { id: f.job }, { status: 'blocked' })
    const first = fork(f), second = fork(f)
    await fixture.advancedThreads.reserveFork(first)
    await fixture.advancedThreads.reserveFork(second)
    const recover = (reservation: ForkReservation): RecoveryContinuationRegistration => ({
      owner: f.owner, sourceJobId: f.job, sourceThreadId: f.thread,
      childId: reservation.childId, storyId: f.story, title: 'Recovery',
      baseSha: checked, checkpointSha: checked, draft: reservation.draft,
      guidance: reservation.guidance, at,
    })
    const outcomes = await Promise.all([
      worker(fixture, 'registerRecoveryContinuation', recover(first)),
      worker(fixture, 'registerRecoveryContinuation', recover(second)),
    ])
    assert.equal(outcomes.filter(result => result.ok).length, 1)
    assert.match(outcomes.find(result => !result.ok)?.message ?? '', /Thread has advanced/)
    assert.equal(await fixture.records.count('story_thread_runs', { threadId: f.thread }), 2)
    assert.equal((await fixture.advancedThreads.runJobs(f.owner, f.thread)).length, 2)
    assert.equal((await fixture.advancedThreads.history(f.owner, f.thread)).filter(row =>
      row.id.startsWith('guidance:fork:')).length, 1)
    assert.equal((await fixture.advancedThreads.jobClaimed(first.childId) ? 1 : 0) +
      (await fixture.advancedThreads.jobClaimed(second.childId) ? 1 : 0), 1)
  })

  test(backend + ': competing independent processes serialize fork/restart and recovery writes', {
    skip: backend === 'postgres' && !pg && 'Set NT_TEST_PG_URL',
    timeout: 90_000,
  }, async t => {
    const fixture = await openKyselyFeatureFixture(backend)
    t.after(() => fixture.close())
    const f = await setup(fixture)
    const d = fork(f)
    const reservations = await Promise.all([
      worker(fixture, 'reserveFork', d), worker(fixture, 'reserveFork', d),
    ])
    assert.equal(reservations.filter(r => r.ok).length, 2)
    const children = await Promise.all([
      worker(fixture, 'registerChild', child(f, d)),
      worker(fixture, 'registerChild', child(f, d)),
    ])
    assert.equal(children.filter(r => r.ok).length, 2)
    assert.deepEqual(children.map(r => (r.result as { inserted: boolean }).inserted).sort(),
      [false, true])
    assert.equal(await fixture.records.count('story_thread_runs', { jobId: d.childId }), 1)
    assert.equal(await fixture.records.count('story_thread_messages', { threadId: 'fork:' + d.childId }), 3)

    const rd = restart(f)
    const restarts = await Promise.all([
      worker(fixture, 'reserveRestart', rd),
      worker(fixture, 'reserveRestart', { ...rd, selected: base }),
    ])
    assert.equal(restarts.filter(r => r.ok).length, 1)
    assert.match(restarts.find(r => !r.ok)?.message ?? '', /reservation changed/)
    assert.equal(await fixture.records.count('thread_restarts', { childId: rd.childId }), 1)
    await fixture.records.update('studio_sessions', { id: f.job }, { status: 'blocked' })
    const recovery = fork(f)
    await fixture.advancedThreads.reserveFork(recovery)
    const data: RecoveryContinuationRegistration = {
      owner: f.owner, sourceJobId: f.job, sourceThreadId: f.thread,
      childId: recovery.childId, storyId: f.story, title: 'Recovery',
      baseSha: checked, checkpointSha: checked, draft: recovery.draft,
      guidance: recovery.guidance, at,
    }
    const attempts = await Promise.all([
      worker(fixture, 'registerRecoveryContinuation', data),
      worker(fixture, 'registerRecoveryContinuation', data),
    ])
    assert.equal(attempts.filter(r => r.ok).length, 2)
    assert.deepEqual(attempts.map(r => (r.result as { inserted: boolean }).inserted).sort(),
      [false, true])
    assert.equal(await fixture.records.count('story_thread_runs', { threadId: f.thread }), 2)
    assert.deepEqual((await fixture.advancedThreads.runJobs(f.owner, f.thread)),
      [f.job, recovery.childId])
  })
}
