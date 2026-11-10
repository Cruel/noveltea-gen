import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { ContinuationRequest } from '../src/persistence/continuation-contracts'
import { openKyselyFeatureFixture, type KyselyFeatureFixture } from './support/kysely-feature-fixture'

const at = '2026-11-09T12:00:00Z'
const later = '2026-11-09T13:00:00Z'
const base = 'a'.repeat(40)
const checked = 'b'.repeat(40)
const pg = process.env.NT_TEST_PG_URL
if (process.env.NT_REQUIRE_KYSELY_PROOF === '1' && !pg)
  throw new Error('NT_TEST_PG_URL required for shared Thread continuation conformance')

async function setup(f: KyselyFeatureFixture) {
  const owner = await f.owner(), stranger = await f.owner()
  const repo = randomUUID(), story = randomUUID(), job = randomUUID(), thread = randomUUID()
  await f.records.insert('repositories', {
    id: repo, ownerUserId: owner, provider: 'github', providerRepositoryId: repo,
    name: 'Author/Novel', createdAt: at,
  })
  await f.records.insert('stories', {
    id: story, ownerUserId: owner, repositoryId: repo,
    directory: 'story', title: 'Novel', sourceCommitSha: base, createdAt: at,
  })
  await f.records.insert('studio_sessions', {
    id: job, ownerUserId: owner, storyId: story, title: 'Original',
    status: 'completed', sourceCommitSha: base, createdAt: at, updatedAt: at,
  })
  await f.records.insert('story_threads', {
    id: thread, ownerUserId: owner, storyId: story,
    title: 'Thread', createdAt: at, activityAt: at,
  })
  await f.records.insert('story_thread_runs', {
    jobId: job, ownerUserId: owner, threadId: thread, runOrder: 0,
  })
  await f.records.insert('generation_run_queue', {
    jobId: job, ownerUserId: owner, intent: 'start', phase: 'finished',
    createdAt: at, updatedAt: at,
  })
  return { owner, stranger, job, thread, story }
}

async function queued(f: KyselyFeatureFixture, x: Awaited<ReturnType<typeof setup>>,
  sequence: number, scope: string | null = JSON.stringify({ sourceSha: base })) {
  const id = randomUUID()
  await f.records.insert('story_thread_messages', {
    id, ownerUserId: x.owner, threadId: x.thread, sequence,
    role: 'user', status: 'queued', phase: 'queued',
    body: 'Author revision ' + sequence, revisionScopeJson: scope, createdAt: at,
  })
  return id
}

function request(x: Awaited<ReturnType<typeof setup>>,
  claim: NonNullable<Awaited<ReturnType<KyselyFeatureFixture['continuation']['claim']>>>): ContinuationRequest {
  return {
    owner: x.owner, threadId: x.thread, claim, sourceHead: base,
    generationThread: 'generation:' + claim.id,
    draftJson: JSON.stringify({ version: 1, headSha: base }),
    requestJson: JSON.stringify({ task: claim.content, fixture: true }), at: later,
  }
}

async function worker(f: KyselyFeatureFixture, operation: string, args: unknown[]) {
  const path = fileURLToPath(new URL('./support/kysely-continuation-worker.ts', import.meta.url))
  const child = spawn(process.execPath, ['--import', 'tsx', path], {
    cwd: process.cwd(),
    env: { ...process.env, NT_CONTINUATION_WORKER_INPUT: JSON.stringify({
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
  if (exit !== 0) throw new Error('Independent continuation worker failed: ' + stderr.slice(0, 1000))
  return JSON.parse(stdout.trim()) as { ok: boolean; result?: unknown; error?: string }
}

for (const backend of ['sqlite', 'postgres'] as const) {
  test(backend + ': guarded continuation claims, exact child admission, pause and verified recovery', {
    skip: backend === 'postgres' && !pg && 'Set NT_TEST_PG_URL',
    timeout: 90_000,
  }, async t => {
    const f = await openKyselyFeatureFixture(backend)
    t.after(() => f.close())
    const x = await setup(f)
    const b = await f.openIndependentContinuation()
    t.after(() => b.close())
    const first = await queued(f, x, 0), second = await queued(f, x, 1)
    assert.equal((await f.continuation.current(x.owner, x.thread))?.jobId, x.job)
    assert.equal((await f.continuation.pending(x.owner, x.thread))?.id, first)
    assert.equal(await b.continuation.current(x.stranger, x.thread), null)
    assert.equal(await b.continuation.pending(x.stranger, x.thread), null)
    const [aClaim, bClaim] = await Promise.all([
      f.continuation.claim(x.owner, x.thread),
      b.continuation.claim(x.owner, x.thread),
    ])
    const claim = aClaim ?? bClaim
    assert.equal(Number(Boolean(aClaim)) + Number(Boolean(bClaim)), 1)
    assert.equal(claim?.id, first)
    assert.equal(await f.continuation.claim(x.owner, x.thread), null)
    const data = request(x, claim!)
    await assert.rejects(f.continuation.beginFollowUp({ ...data, sourceHead: 'invalid' }),
      /changed during worktree preparation|validated SHA/)
    await assert.rejects(f.continuation.beginFollowUp({
      ...data, claim: { ...data.claim, content: 'Forged content' },
    }), /changed during worktree preparation/)
    await assert.rejects(f.continuation.beginFollowUp({
      ...data, claim: { ...data.claim, scopeJson: '{"sourceSha":"forged"}' },
    }), /changed during worktree preparation/)
    assert.equal(await f.records.count('studio_sessions', { id: first }), 0,
      'child insert and queue registration roll back together')
    await b.continuation.beginFollowUp(data)
    await assert.rejects(f.continuation.beginFollowUp(data), /admission changed|already registered/)
    assert.equal(await f.records.count('studio_sessions', { id: first }), 1)
    assert.equal(await f.records.count('generation_run_queue', { jobId: first }), 1)
    assert.equal(await f.records.count('story_thread_messages', { id: 'initial:' + first }), 0,
      'the original admitted author Turn must not be duplicated during queue seeding')
    assert.equal((await f.records.first<{ phase: string }>('generation_run_queue', {
      jobId: first,
    }))?.phase, 'queued')
    assert.equal((await f.records.first<{ phase: string }>('story_thread_messages', {
      id: first,
    }))?.phase, 'running')
    assert.equal((await f.continuation.current(x.owner, x.thread))?.jobId, first)
    assert.equal(await f.continuation.claim(x.owner, x.thread), null)
    // A safe-boundary pause does not complete the author Turn even when the
    // worker has returned a successful queue receipt.
    await f.records.update('generation_run_queue', { jobId: first }, { phase: 'finished' })
    assert.deepEqual(await b.continuation.settledRuns(), [{ jobId: first, owner: x.owner }])
    assert.equal(await b.continuation.settle(x.owner, first, null, later), x.thread)
    assert.equal((await f.records.first<{ phase: string }>('story_thread_messages', { id: first }))?.phase,
      'running')
    await f.records.update('studio_sessions', { id: first }, { status: 'completed' })
    assert.equal(await b.continuation.settle(x.owner, first, checked, later), x.thread)
    assert.equal(await f.continuation.settle(x.owner, first, checked, later), x.thread)
    const message = await f.records.first<{ phase: string; verifiedCommitSha: string }>(
      'story_thread_messages', { id: first })
    assert.equal(message?.phase, 'finished')
    assert.equal(message?.verifiedCommitSha, checked)
    assert.equal(await f.records.count('story_thread_messages', { id: 'assistant:' + first }), 1)
    assert.equal((await f.continuation.pending(x.owner, x.thread))?.id, second)
    assert.equal(await f.continuation.settle(x.stranger, first, checked, later), null)
    assert.equal(await f.continuation.runThread(x.stranger, first), null)
  })

  test(backend + ': protected decision and steering boundary reconcile atomically; stale scope never consumes approval', {
    skip: backend === 'postgres' && !pg && 'Set NT_TEST_PG_URL',
    timeout: 90_000,
  }, async t => {
    const f = await openKyselyFeatureFixture(backend)
    t.after(() => f.close())
    const x = await setup(f), s = f.continuation
    const id = await queued(f, x, 0)
    const claim = await s.claim(x.owner, x.thread)
    assert.equal(claim?.id, id)
    const data = request(x, claim!)
    await assert.rejects(s.protectedFinish(data, checked), /approval was already consumed/)
    assert.equal(await f.records.count('studio_sessions', { id }), 0)
    assert.equal(await f.records.count('generation_run_queue', { jobId: id }), 0)
    await f.records.insert('thread_protected_decisions', {
      messageId: id, ownerUserId: x.owner, threadId: x.thread,
      sourceJobId: x.job, sourceSha: base, proposalSha256: 'f'.repeat(64),
      changeJson: '{}', nonce: randomUUID(), decision: 'approved',
      principal: 'user:' + x.owner, recordedAt: at,
    })
    await assert.rejects(s.protectedFinish({ ...data, owner: x.stranger }, checked))
    assert.equal(await f.records.count('studio_sessions', { id }), 0)
    await s.protectedFinish(data, checked)
    await assert.rejects(s.protectedFinish(data, checked), /changed|registered|consumed/)
    assert.equal((await f.records.first<{ consumedSha: string }>('thread_protected_decisions', {
      messageId: id,
    }))?.consumedSha, checked)
    assert.equal((await f.records.first<{ phase: string; verifiedCommitSha: string }>(
      'story_thread_messages', { id }))?.verifiedCommitSha, checked)
    assert.equal(await f.records.count('story_thread_messages', { id: 'assistant:' + id }), 1)
    assert.equal((await s.current(x.owner, x.thread))?.jobId, id)

    // Different Thread: a finished child steer's independent review must not
    // become a new source approval without its own pending-boundary receipt.
    const liveId = randomUUID()
    await f.records.insert('story_thread_messages', {
      id: liveId, ownerUserId: x.owner, threadId: x.thread, sequence: 2,
      role: 'user', status: 'delivered', phase: 'finished',
      body: 'Do not change the protected decision', createdAt: at,
    })
    await f.records.insert('thread_live_inputs', {
      messageId: liveId, ownerUserId: x.owner, threadId: x.thread,
      sourceJobId: id, mode: 'steer', state: 'delivered', createdAt: at,
    })
    await f.records.insert('thread_steering_intents', {
      messageId: liveId, ownerUserId: x.owner, threadId: x.thread,
      sourceJobId: id, disposition: 'protected-review',
      consideredAt: at, reviewState: 'pending-boundary',
    })
    assert.equal(await s.settle(x.owner, id, checked, later), x.thread)
    const original = await f.records.first<{ reviewState: string; reviewMessageId: string }>(
      'thread_steering_intents', { messageId: liveId })
    assert.equal(original?.reviewState, 'awaiting-review')
    assert.ok(original?.reviewMessageId)
    assert.equal(await f.records.count('story_thread_messages', {
      originMessageId: liveId,
    }), 1)
    assert.equal(await s.settle(x.owner, id, checked, later), x.thread)
    assert.equal(await f.records.count('story_thread_messages', {
      originMessageId: liveId,
    }), 1)
  })

  test(backend + ': independent processes fence admission, interruption, cancellation, restart and stale settlement', {
    skip: backend === 'postgres' && !pg && 'Set NT_TEST_PG_URL',
    timeout: 90_000,
  }, async t => {
    const f = await openKyselyFeatureFixture(backend)
    t.after(() => f.close())
    const x = await setup(f)
    const first = await queued(f, x, 0), second = await queued(f, x, 1)
    const claims = await Promise.all([
      worker(f, 'claim', [x.owner, x.thread]),
      worker(f, 'claim', [x.owner, x.thread]),
    ])
    assert.equal(claims.filter(r => r.result !== null).length, 1)
    assert.ok(claims.every(r => r.ok))
    const claim = claims.find(r => r.result !== null)!.result as NonNullable<
      Awaited<ReturnType<KyselyFeatureFixture['continuation']['claim']>>>
    assert.equal(claim.id, first)
    const data = request(x, claim)
    const wrong = await worker(f, 'beginFollowUp', [{ ...data, threadId: randomUUID() }])
    assert.equal(wrong.ok, false)
    assert.equal(await f.records.count('studio_sessions', { id: first }), 0)
    const starts = await Promise.all([
      worker(f, 'beginFollowUp', [data]),
      worker(f, 'beginFollowUp', [data]),
    ])
    assert.equal(starts.filter(r => r.ok).length, 1)
    assert.equal(await f.records.count('studio_sessions', { id: first }), 1)
    assert.equal(await f.records.count('story_thread_runs', { jobId: first }), 1)
    await f.records.update('generation_run_queue', { jobId: first }, { phase: 'interrupted' })
    await f.records.update('studio_sessions', { id: first }, { status: 'blocked' })
    const settled = await Promise.all([
      worker(f, 'settle', [x.owner, first, null, later]),
      worker(f, 'settle', [x.owner, first, null, later]),
    ])
    assert.ok(settled.every(r => r.ok && r.result === x.thread))
    assert.equal((await f.records.first<{ phase: string }>('story_thread_messages', { id: first }))?.phase,
      'blocked')
    assert.equal(await f.records.count('story_thread_messages', { id: 'assistant:' + first }), 1)
    assert.equal((await f.records.first<{ phase: string }>('story_thread_messages', {
      id: second,
    }))?.phase, 'queued')
    assert.equal(await f.continuation.claim(x.owner, x.thread), null,
      'interrupted source never automatically acquires next author Turn')
    assert.equal((await worker(f, 'settle', [x.stranger, first, checked, later])).result, null)
    assert.equal((await worker(f, 'settle', [x.owner, first, 'invalid', later])).ok, false)
    // Cancellation cannot resurrect an already-admitted or interrupted Turn.
    assert.equal((await worker(f, 'block', [x.owner, x.thread, claim, 'late', later])).ok, false)
    assert.equal(await f.records.count('story_thread_messages', { id: 'assistant:' + first }), 1)
  })

  test(backend + ': rejected continuation and canceled queue do not create orphan child or unblock a newer Turn', {
    skip: backend === 'postgres' && !pg && 'Set NT_TEST_PG_URL',
    timeout: 90_000,
  }, async t => {
    const f = await openKyselyFeatureFixture(backend)
    t.after(() => f.close())
    const x = await setup(f), c = f.continuation
    const canceled = await queued(f, x, 0), valid = await queued(f, x, 1)
    await f.records.insert('story_thread_message_cancellations', {
      messageId: canceled, ownerUserId: x.owner, threadId: x.thread, cancelledAt: later,
    })
    assert.equal((await c.pending(x.owner, x.thread))?.id, valid)
    const claim = await c.claim(x.owner, x.thread)
    assert.equal(claim?.id, valid)
    const data = request(x, claim!)
    await assert.rejects(c.beginFollowUp({ ...data, claim: { ...claim!, source: randomUUID() } }),
      /changed during worktree preparation/)
    assert.equal(await f.records.count('studio_sessions', { id: valid }), 0)
    await c.block(x.owner, x.thread, claim!, 'Cannot validate source', later)
    await c.block(x.owner, x.thread, claim!, 'Cannot validate source', later)
    assert.equal(await f.records.count('story_thread_messages', { id: 'assistant:' + valid }), 1)
    assert.equal((await f.records.first<{ phase: string }>('story_thread_messages', { id: valid }))?.phase,
      'blocked')
    assert.equal(await c.claim(x.owner, x.thread), null)
    assert.equal(await c.runThread(x.owner, valid), null)
  })
}
