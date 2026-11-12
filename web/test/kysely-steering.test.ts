import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { openKyselyFeatureFixture, type KyselyFeatureFixture } from './support/studio-database'
import type { PendingPiInput } from '../src/persistence/steering-contracts'

const at = '2026-11-09T10:00:00Z'
const later = '2026-11-09T11:00:00Z'
const base = 'a'.repeat(40)
const head = 'b'.repeat(40)
const finalHead = 'c'.repeat(40)
const proof = 'd'.repeat(64)
const pg = process.env.NT_TEST_PG_URL
if (process.env.NT_REQUIRE_KYSELY_PROOF === '1' && !pg)
  throw new Error('NT_TEST_PG_URL required for shared live steering conformance')

async function worker(f: KyselyFeatureFixture, operation: string, args: unknown[] = []) {
  const path = fileURLToPath(new URL('./support/kysely-steering-worker.ts', import.meta.url))
  const child = spawn(process.execPath, ['--import', 'tsx', path], {
    cwd: process.cwd(),
    env: { ...process.env, NT_STEERING_WORKER_INPUT: JSON.stringify({
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
  if (exit !== 0) throw new Error('Independent steering worker failed: ' + stderr.slice(0, 1000))
  return JSON.parse(stdout.trim()) as { ok: boolean; result?: unknown; error?: string }
}

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
    id: job, ownerUserId: owner, storyId: story, title: 'Generation',
    status: 'running', sourceCommitSha: base, createdAt: at, updatedAt: at,
  })
  await f.records.insert('story_threads', {
    id: thread, ownerUserId: owner, storyId: story,
    title: 'Thread', createdAt: at, activityAt: at,
  })
  await f.records.insert('story_thread_runs', {
    jobId: job, ownerUserId: owner, threadId: thread, runOrder: 0,
  })
  await f.records.insert('generation_run_queue', {
    jobId: job, ownerUserId: owner, intent: 'start', phase: 'running',
    createdAt: at, updatedAt: at,
  })
  return { owner, stranger, repo, story, job, thread }
}

async function message(f: KyselyFeatureFixture, x: Awaited<ReturnType<typeof setup>>,
  sequence: number, mode: 'steer' | 'follow-up' = 'steer') {
  const id = randomUUID()
  await f.records.insert('story_thread_messages', {
    id, ownerUserId: x.owner, threadId: x.thread, sequence, role: 'user',
    status: 'queued', body: 'Author instruction ' + sequence, phase: 'queued', createdAt: at,
  })
  await f.records.insert('thread_live_inputs', {
    messageId: id, ownerUserId: x.owner, threadId: x.thread,
    sourceJobId: x.job, mode, state: 'pending', createdAt: at,
    targetPiToken: 'token-1', targetWorkItem: 'focus:character', submittedHead: base,
  })
  return id
}

for (const backend of ['sqlite', 'postgres'] as const) {
  test(backend + ': authenticated safe-boundary plan admission is source-bound and restart-idempotent', {
    skip: backend === 'postgres' && !pg && 'Set NT_TEST_PG_URL',
    timeout: 90_000,
  }, async t => {
    const f = await openKyselyFeatureFixture(backend)
    t.after(() => f.close())
    const x = await setup(f)
    const other = await f.openIndependentSteering()
    t.after(() => other.close())
    const first = await message(f, x, 0)
    const second = await message(f, x, 1)
    // A Pi influence checkpoint may already occupy this exact Git SHA.
    await f.records.insert("thread_steering_checkpoint_links", {
      messageId: first, ownerUserId: x.owner, threadId: x.thread,
      sourceJobId: x.job, checkpointSha: head, proofDigest: "e".repeat(64),
      workItem: "focus:character", association: "verified-influence", recordedAt: at,
    })
    assert.deepEqual((await f.steering.pendingBoundary(x.owner, x.job, x.thread))
      .map(item => item.messageId), [first, second])
    assert.deepEqual(await f.steering.pendingBoundary(x.stranger, x.job, x.thread), [])
    const decision = { messageId: first, content: 'Author instruction 0',
      kind: 'applied' as const, sourceSha: head,
      amendmentDigest: proof, reason: 'Controller verified pending assignment' }
    await assert.rejects(f.steering.settleBoundary(x.stranger, x.job, x.thread, decision, later),
      /ownership|changed|ended/i)
    await f.steering.settleBoundary(x.owner, x.job, x.thread, decision, later)
    await other.steering.settleBoundary(x.owner, x.job, x.thread, decision, later)
    assert.equal((await f.steering.activity(x.owner, x.thread))
      .find(activity => activity.messageId === first)?.state, 'applied-boundary')
    assert.equal((await f.records.first<{ state: string }>('thread_live_inputs',
      { messageId: first }))?.state, 'deferred')
    assert.equal((await f.records.first<{ phase: string }>('story_thread_messages',
      { id: first }))?.phase, 'finished')
    assert.deepEqual(await f.records.first<{ sourceSha: string; amendmentDigest: string }>(
      'thread_steering_plan_amendments', { messageId: first }).then(row =>
        row && { sourceSha: row.sourceSha, amendmentDigest: row.amendmentDigest }),
      { sourceSha: head, amendmentDigest: proof })
    assert.equal((await f.records.first<{ proofDigest: string }>(
      'thread_steering_checkpoint_links', { messageId: first }))?.proofDigest, 'e'.repeat(64),
      'Pi influence provenance cannot be overwritten by a plan amendment')
    assert.deepEqual((await other.steering.pendingBoundary(x.owner, x.job, x.thread))
      .map(item => item.messageId), [second])
    await assert.rejects(other.steering.settleBoundary(x.owner, x.job, x.thread, {
      ...decision, sourceSha: finalHead,
    }, later), /source/)
    await assert.rejects(f.steering.settleBoundary(x.owner, x.job, x.thread, {
      ...decision, content: 'Tampered author instruction',
    }, later), /changed/)
    await other.steering.settleBoundary(x.owner, x.job, x.thread, {
      messageId: second, content: 'Author instruction 1', kind: 'review-required',
      sourceSha: head, amendmentDigest: null, reason: 'Outside originally approved scope',
    }, later)
    assert.equal((await f.steering.activity(x.owner, x.thread))
      .find(activity => activity.messageId === second)?.state, 'pending-boundary')
    assert.deepEqual((await f.steering.pendingBoundary(x.owner, x.job, x.thread))
      .map(item => item.messageId), [],
      'a blocked instruction is durably review-only; resuming cannot repeatedly pause the same source')
    assert.equal((await f.steering.activity(x.owner, x.thread))
      .find(activity => activity.messageId === second)?.disposition, 'scope-review')
    await f.records.update('generation_run_queue', { jobId: x.job }, { phase: 'finished' })
    await f.records.update('studio_sessions', { id: x.job }, { status: 'completed' })
    assert.equal(await f.steering.boundaryReviews(x.owner, x.job, x.thread, head, later), 1)
    assert.equal(await f.steering.boundaryReviews(x.owner, x.job, x.thread, head, later), 0,
      'review handoff is replay-safe')
    assert.equal((await f.steering.activity(x.owner, x.thread))
      .find(activity => activity.messageId === second)?.state, 'awaiting-review')
    assert.ok((await f.steering.activity(x.owner, x.thread))
      .find(activity => activity.messageId === second)?.reviewMessageId)
    assert.deepEqual((await f.steering.boundaryReceipts(x.owner, x.job, x.thread))
      .map(receipt => receipt.messageId), [first])
  })

  test(backend + ': shared Pi Turn lifecycle, dispatch fences, recovery and checkpoint ordering', {
    skip: backend === 'postgres' && !pg && 'Set NT_TEST_PG_URL',
    timeout: 90_000,
  }, async t => {
    const f = await openKyselyFeatureFixture(backend)
    t.after(() => f.close())
    const x = await setup(f)
    const other = await f.openIndependentSteering()
    t.after(() => other.close())
    const a = f.steering, b = other.steering
    const first = await message(f, x, 0), second = await message(f, x, 1)
    const follow = await message(f, x, 2, 'follow-up')
    await Promise.all([
      a.registerTurn(x.job, 'token-1', 'session-1', 'focus:character', base, at),
      b.registerTurn(x.job, 'token-1', 'session-1', 'focus:character', base, at),
    ])
    assert.equal(await f.records.count('thread_active_pi_turns'), 1)
    await assert.rejects(b.registerTurn(x.job, 'token-2', 'session-2', 'focus:world', base, at))
    assert.deepEqual(await b.turn(x.job, 'token-1'), { sessionId: 'session-1' })
    assert.equal((await b.dispatchable()).map(r => r.id).join(','), first)
    const row = (await a.dispatchable())[0]!
    await f.records.update('thread_live_inputs', { messageId: first }, { targetWorkItem: 'focus:other' })
    assert.equal(await a.claim(row, 'token-1', 'session-1'), false,
      'token alone is not sufficient: specialist work-item fence must match')
    await f.records.update('thread_live_inputs', { messageId: first }, {
      targetWorkItem: 'focus:character', submittedHead: finalHead,
    })
    assert.equal(await a.claim(row, 'token-1', 'session-1'), false,
      'a stale submitted checkpoint cannot acquire a live specialist')
    await f.records.update('thread_live_inputs', { messageId: first }, { submittedHead: base })
    assert.equal(await a.claim({ ...row, owner: x.stranger }, 'token-1', 'session-1'), false)
    assert.deepEqual(await Promise.all([
      a.claim(row, 'token-1', 'session-1'),
      b.claim(row, 'token-1', 'session-1'),
    ]).then(x => x.sort()), [false, true])
    assert.equal(await a.claim(row, 'token-1', 'session-1'), false)
    assert.deepEqual(await b.dispatchable(), [], 'dispatching prior steer holds the next message')
    await b.accepted(first, 'token-1')
    assert.equal((await b.dispatchable()).map(r => r.id).join(','), second)
    const [settling] = await a.settling(x.job, 'token-1')
    assert.equal(settling?.id, first)
    await Promise.all([
      a.settle(settling!, 'token-1', true, 'focus:character', 'within-scope', later),
      b.settle(settling!, 'token-1', true, 'focus:character', 'within-scope', later),
    ])
    assert.equal(await f.records.count('thread_steering_intents'), 1)
    assert.equal(await a.attribute(x.stranger, x.job, {
      eligible: true, commitSha: head, parentSha: base, proofDigest: proof,
      workItem: 'focus:character',
    }, later), 0)
    assert.equal(await a.attribute(x.owner, x.job, {
      eligible: false, commitSha: head, parentSha: base, proofDigest: proof,
      workItem: 'focus:character',
    }, later), 0)
    assert.equal(await a.attribute(x.owner, x.job, {
      eligible: true, commitSha: head, parentSha: base, proofDigest: proof,
      workItem: 'focus:character',
    }, later), 1)
    assert.equal(await b.attribute(x.owner, x.job, {
      eligible: true, commitSha: head, parentSha: base, proofDigest: proof,
      workItem: 'focus:character',
    }, later), 0)
    const activity = await b.activity(x.owner, x.thread)
    assert.equal(activity.find(r => r.messageId === first)?.checkpointSha, head)
    assert.equal(activity.find(r => r.messageId === second)?.state, 'pending')
    assert.equal(activity.find(r => r.messageId === second)?.checkpointSha, head)
    assert.equal((await b.activity(x.stranger, x.thread)).length, 0)
    const link = (await f.records.all<{ sequence: number }>(
      'thread_steering_checkpoint_links', { messageId: second },
    ))[0]!
    assert.equal(typeof link.sequence, 'number')
    await a.attribute(x.owner, x.job, {
      eligible: true, commitSha: finalHead, parentSha: head, proofDigest: proof,
      workItem: 'focus:character',
    }, later)
    assert.equal((await b.activity(x.owner, x.thread))
      .find(r => r.messageId === second)?.checkpointSha, finalHead,
    'latest pending-unresolved association uses generated sequence, not rowid')
    await b.review(x.owner, x.thread, first, 'reviewer', 'independent proof', later)
    await b.review(x.owner, x.thread, first, 'reviewer', 'independent proof', later)
    await assert.rejects(a.review(x.owner, x.thread, first, 'other reviewer', 'different', later),
      /different evidence/)
    await assert.rejects(a.review(x.stranger, x.thread, first, 'reviewer', 'proof', later),
      /unacknowledged/)
    await Promise.all([a.closeTurn(x.job, 'token-1'), b.closeTurn(x.job, 'token-1')])
    assert.equal(await f.records.count('thread_active_pi_turns'), 0)
    assert.equal((await f.records.first<{ state: string }>('thread_live_inputs', { messageId: second }))?.state, 'deferred')
    assert.equal((await f.records.first<{ state: string }>('thread_live_inputs', { messageId: follow }))?.state, 'deferred')
    await a.recoverOrphaned()
  })

  test(backend + ': edit-versus-dispatch rejects the stale instruction snapshot', {
    skip: backend === 'postgres' && !pg && 'Set NT_TEST_PG_URL',
    timeout: 90_000,
  }, async t => {
    const f = await openKyselyFeatureFixture(backend)
    t.after(() => f.close())
    const x = await setup(f)
    const id = await message(f, x, 0)
    await f.steering.registerTurn(x.job, 'token-1', 'session-1', 'focus:character', base, at)
    const stale = (await f.steering.dispatchable())[0]!
    const revised = 'Author replaced this instruction'
    assert.equal((await f.messages.edit(x.owner, x.thread, id, randomUUID(),
      stale.content, revised, later)).content, revised)
    assert.equal(await f.steering.claim(stale, 'token-1', 'session-1'), false,
      'stale dispatchable result must never claim a replaced author message')
    const fresh = (await f.steering.dispatchable())[0]!
    assert.equal(fresh.content, revised)
    assert.equal(await f.steering.claim(fresh, 'token-1', 'session-1'), true)
    assert.equal(await f.steering.claim(stale, 'token-1', 'session-1'), false)
  })

  test(backend + ': boundary review authorization, implementation idempotency and restart recovery', {
    skip: backend === 'postgres' && !pg && 'Set NT_TEST_PG_URL',
    timeout: 90_000,
  }, async t => {
    const f = await openKyselyFeatureFixture(backend)
    t.after(() => f.close())
    const x = await setup(f), s = f.steering
    const id = await message(f, x, 0)
    await s.registerTurn(x.job, 'token-1', 'session-1', 'focus:character', base, at)
    const row: PendingPiInput = (await s.dispatchable())[0]!
    await s.claim(row, 'token-1', 'session-1')
    await s.settle({ ...row, delivery: 'dispatching' }, 'token-1', true,
      'focus:character', 'scope-review', later)
    await f.records.update('generation_run_queue', { jobId: x.job }, { phase: 'finished' })
    await f.records.update('studio_sessions', { id: x.job }, { status: 'completed' })
    assert.equal(await s.boundaryReviews(x.stranger, x.job, x.thread, head, later), 0)
    assert.equal(await s.boundaryReviews(x.owner, x.job, x.thread, head, later), 1)
    assert.equal(await s.boundaryReviews(x.owner, x.job, x.thread, head, later), 0)
    const original = (await s.activity(x.owner, x.thread)).find(r => r.messageId === id)!
    const reviewId = original.reviewMessageId!
    assert.ok(reviewId)
    const scope = JSON.stringify({
      approved: true, writePaths: ['characters/hero.yaml'], selectedTargets: ['character'],
    })
    await f.records.update('story_thread_messages', { id: reviewId }, {
      status: 'delivered', phase: 'finished', jobId: x.job, revisionScopeJson: scope,
    })
    await f.records.update('thread_steering_intents', { messageId: id }, {
      reviewState: 'approved-run',
    })
    const point = { eligible: true, commitSha: head, parentSha: base,
      proofDigest: proof, workItem: 'focus:character' }
    assert.equal(await s.approvedReplan(x.stranger, x.job, point, ['characters/hero.yaml'], later), 0)
    assert.equal(await s.approvedReplan(x.owner, x.job, point, ['different'], later), 0)
    assert.equal(await s.approvedReplan(x.owner, x.job, point, ['characters/hero.yaml'], later), 1)
    assert.equal(await s.approvedReplan(x.owner, x.job, point, ['characters/hero.yaml'], later), 0)
    const impl = (await s.activity(x.owner, x.thread)).find(r => r.messageId === id)!
    assert.equal(impl.implementationSha, head)
    assert.equal(impl.implementationCount, 1)
    assert.equal(await s.approvedReplan(x.owner, x.job, {
      ...point, commitSha: finalHead,
    }, ['characters/hero.yaml'], later), 1)
    const latest = (await s.activity(x.owner, x.thread)).find(r => r.messageId === id)!
    assert.equal(latest.implementationSha, finalHead,
      'latest verified implementation uses generated sequence, even with identical timestamps')
    assert.equal(latest.implementationCount, 2)
    await f.records.update('story_thread_messages', { id: reviewId }, {
      revisionScopeJson: '{invalid',
    })
    assert.equal(await s.approvedReplan(x.owner, x.job, {
      ...point, commitSha: 'e'.repeat(40),
    }, ['characters/hero.yaml'], later), 0)
    await f.records.update('studio_sessions', { id: x.job }, { status: 'blocked' })
    await s.recoverOrphaned()
    assert.equal(await f.records.count('thread_active_pi_turns'), 0)
    assert.equal((await f.records.first<{ state: string }>('thread_live_inputs', { messageId: id }))?.state, 'delivered')
  })

  test(backend + ': separate processes serialize Pi registration, reject partial settlement, and recover after restart', {
    skip: backend === 'postgres' && !pg && 'Set NT_TEST_PG_URL',
    timeout: 90_000,
  }, async t => {
    const f = await openKyselyFeatureFixture(backend)
    t.after(() => f.close())
    const x = await setup(f)
    const register = [x.job, 'token-1', 'session-1', 'focus:character', base, at]
    const results = await Promise.all(Array.from({ length: 3 }, () =>
      worker(f, 'registerTurn', register)))
    assert.deepEqual(results.map(r => r.ok), [true, true, true])
    assert.equal(await f.records.count('thread_active_pi_turns'), 1)
    assert.equal((await worker(f, 'registerTurn',
      [x.job, 'token-2', 'session-2', 'focus:character', base, at])).ok, false)
    const id = await message(f, x, 0)
    const id2 = await message(f, x, 1)
    const item = (await f.steering.dispatchable())[0]!
    assert.equal((await worker(f, 'claim',
      [{ ...item, owner: x.stranger }, 'token-1', 'session-1'])).result, false)
    const claims = await Promise.all([
      worker(f, 'claim', [item, 'token-1', 'session-1']),
      worker(f, 'claim', [item, 'token-1', 'session-1']),
    ])
    assert.deepEqual(claims.map(r => r.result).sort(), [false, true])
    // If the instruction changes after the SDK claim, the whole settlement
    // must roll back: the input must not become delivered without its message.
    await f.records.update('story_thread_messages', { id }, { phase: 'blocked' })
    const invalid = await worker(f, 'settle', [
      { ...item, delivery: 'dispatching' }, 'token-1', true,
      'focus:character', 'within-scope', later,
    ])
    assert.equal(invalid.ok, false)
    assert.match(invalid.error ?? '', /stale or invalid/)
    assert.equal((await f.records.first<{ state: string }>('thread_live_inputs', {
      messageId: id,
    }))?.state, 'dispatching')
    assert.equal(await f.records.count('thread_steering_intents'), 0)
    await f.records.update('story_thread_messages', { id }, { phase: 'queued' })
    const settled = await worker(f, 'settle', [
      { ...item, delivery: 'dispatching' }, 'token-1', true,
      'focus:character', 'within-scope', later,
    ])
    assert.equal(settled.ok, true)
    assert.equal((await worker(f, 'settle', [
      { ...item, delivery: 'dispatching' }, 'token-1', true,
      'focus:character', 'within-scope', later,
    ])).ok, true, 'settlement replay is a no-op')
    assert.equal(await f.records.count('thread_steering_intents'), 1)
    const point = { eligible: true, commitSha: head, parentSha: base,
      proofDigest: proof, workItem: 'focus:character' }
    assert.equal((await worker(f, 'attribute',
      [x.owner, x.job, { ...point, parentSha: finalHead }, later])).result, 0)
    assert.equal((await worker(f, 'attribute', [x.owner, x.job, point, later])).result, 1)
    assert.equal((await worker(f, 'attribute', [x.owner, x.job, point, later])).result, 0)
    assert.equal((await f.steering.activity(x.owner, x.thread))
      .find(r => r.messageId === id)?.checkpointSha, head)
    const next = (await f.steering.dispatchable()).find(r => r.id === id2)!
    assert.ok(next)
    assert.equal((await worker(f, 'claim', [next, 'token-1', 'session-1'])).result, true)
    await f.steering.accepted(id2, 'token-1')
    await f.records.update('generation_run_queue', { jobId: x.job }, { phase: 'finished' })
    assert.equal((await worker(f, 'recoverOrphaned')).ok, true)
    assert.equal(await f.records.count('thread_active_pi_turns'), 0)
    assert.equal((await f.records.first<{ state: string }>('thread_live_inputs', {
      messageId: id2,
    }))?.state, 'blocked')
    assert.equal((await f.records.first<{ phase: string }>('story_thread_messages', {
      id: id2,
    }))?.phase, 'blocked')
    assert.equal((await f.records.first<{ state: string }>('thread_live_inputs', {
      messageId: id,
    }))?.state, 'delivered', 'verified prior instruction survives crash recovery')
    assert.equal((await worker(f, 'registerTurn', register)).ok, false,
      'stale job cannot recreate a Pi Turn after restart')
    assert.equal((await worker(f, 'closeTurn', [x.job, 'token-1'])).ok, true)
  })
}
