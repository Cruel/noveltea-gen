import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { openKyselyFeatureFixture } from './support/studio-database'
import { deployedVerifierFixes, withKnownFixDispatch, authorizedKnownFixDispatch } from '../../src/known-verifier-fix'

const now = '2026-11-21T00:00:00Z'
const original = {
  check: 'adaptive-plan.v1', checkVersion: 1, signature: 'f'.repeat(64),
  sourceSha: 'a'.repeat(40), turnDigest: 'b'.repeat(64),
}
const fix = { id: 'adaptive-validator-2', check: original.check, failedVersion: 1 }
const pg = process.env.NT_TEST_PG_URL

test('known verifier fixes are an explicit bounded, versioned startup manifest', () => {
  assert.deepEqual(deployedVerifierFixes(''), [])
  assert.deepEqual(deployedVerifierFixes(JSON.stringify([fix])), [fix])
  for (const value of ['not-json', '{}', '[{"id":"ok","check":"other.v1","failedVersion":0}]',
    '[{"id":"bad id","check":"adaptive-plan.v1","failedVersion":1}]',
    JSON.stringify([fix, fix]),
    JSON.stringify([fix, { ...fix, failedVersion: 2 }])]) {
    assert.throws(() => deployedVerifierFixes(value), /Invalid|Duplicated/)
  }
})

test('a supplied graph fix ID has no dispatch authority outside the exact agent context', async () => {
  const old = process.env.NT_STUDIO_KNOWN_VERIFIER_FIXES
  process.env.NT_STUDIO_KNOWN_VERIFIER_FIXES = JSON.stringify([fix])
  try {
    const auth = { ...fix, signature: original.signature, jobId: 'job', threadId: 'thread' }
    const request = { ...fix, signature: original.signature }
    assert.equal(authorizedKnownFixDispatch(request, 'job', 'thread'), false)
    await withKnownFixDispatch(auth, async () => {
      await Promise.resolve()
      assert.equal(authorizedKnownFixDispatch(request, 'job', 'thread'), true)
      assert.equal(authorizedKnownFixDispatch(request, 'job', 'other'), false)
      assert.equal(authorizedKnownFixDispatch({ ...request, signature: 'c'.repeat(64) },
        'job', 'thread'), false)
    })
    assert.equal(authorizedKnownFixDispatch(request, 'job', 'thread'), false)
    assert.throws(() => withKnownFixDispatch({ ...auth, id: 'foreign-fix' },
      async () => {}), /not deployed/i)
  } finally {
    if (old === undefined) delete process.env.NT_STUDIO_KNOWN_VERIFIER_FIXES
    else process.env.NT_STUDIO_KNOWN_VERIFIER_FIXES = old
  }
})

for (const backend of ['sqlite', 'postgres'] as const) {
  test(backend + ': exact stopped verifier pickup is atomic, owner-scoped and idempotent', {
    skip: backend === 'postgres' && !pg && 'Set NT_TEST_PG_URL',
    timeout: 90_000,
  }, async t => {
    const f = await openKyselyFeatureFixture(backend)
    t.after(() => f.close())
    const owner = await f.owner(), stranger = await f.owner()
    const repository = randomUUID(), story = randomUUID(), id = randomUUID()
    const threadId = 'graph:' + randomUUID()
    const authorThreadId = randomUUID()
    await f.records.insert('repositories', { id: repository, ownerUserId: owner,
      provider: 'github', providerRepositoryId: repository, name: 'Story', createdAt: now })
    await f.records.insert('stories', { id: story, ownerUserId: owner, repositoryId: repository,
      directory: 'story', title: 'Story', sourceCommitSha: original.sourceSha, createdAt: now })
    await f.records.insert('story_threads', { id: authorThreadId, storyId: story, ownerUserId: owner,
      title: 'Original Turn', createdAt: now, activityAt: now })
    assert.equal(await f.generation.jobs.register(owner, id, story, 'Story', original.sourceSha, now), true)
    await f.records.insert('story_thread_runs', {
      jobId: id, ownerUserId: owner, threadId: authorThreadId, runOrder: 0,
    })
    const pinned = '{"task":"original"}'
    const queue = f.generation.queue, jobs = f.generation.jobs, worker = 'host:1:worker'
    await queue.enqueue(owner, id, 'start', 'prepared', now, pinned, threadId)
    assert.equal((await queue.claim(worker, 2, now))?.intent, 'start')
    assert.equal(await jobs.start(owner, id, threadId, pinned, worker, now), true)
    assert.equal(await jobs.finish(owner, id, threadId, 'blocked', false, worker, now, original), true)
    assert.equal(await queue.finish(id, worker, true, now), true)
    assert.equal((await queue.verifierStop(stranger, id)), null)
    assert.equal((await queue.verifierStop(owner, id))?.signature, original.signature)
    assert.deepEqual(await queue.matchingVerifierStops(fix), [{
      ...original, jobId: id, ownerId: owner, threadId,
    }])
    assert.deepEqual(await queue.matchingVerifierStops({
      ...fix, failedVersion: 2,
    }), [])
    assert.deepEqual(await queue.matchingVerifierStops({
      ...fix, check: 'other.v1',
    }), [])
    const results = await Promise.all([
      queue.enqueueFix(owner, id, original, fix, now),
      queue.enqueueFix(owner, id, original, fix, now),
    ])
    assert.deepEqual(results.sort(), [false, true])
    assert.equal((await jobs.state(owner, id))?.status, 'paused')
    assert.equal((await queue.record(id))?.intent, 'resume')
    assert.equal((await queue.record(id))?.fixId, fix.id)
    assert.equal((await queue.record(id))?.phase, 'queued')
    assert.equal(await queue.enqueueFix(owner, id, original, fix, now), false)
    assert.equal((await queue.claim(worker, 2, now))?.intent, 'resume')
    assert.equal(await jobs.start(owner, id, threadId, pinned, worker, now), true)
    assert.equal(await jobs.finish(owner, id, threadId, 'blocked', false, worker, now, original), true)
    assert.equal(await queue.finish(id, worker, true, now), true)
    assert.deepEqual(await queue.matchingVerifierStops(fix), [], 'same failure cannot repeat the same fix')
    assert.equal(await queue.enqueueFix(owner, id, original, fix, now), false)
    const distinct = { ...original, signature: 'c'.repeat(64) }
    // A changed failure is a distinct source-bound stop. It does not inherit the
    // original failed-check fix proof, even when the software version is equal.
    const otherFix = { ...fix, id: 'adaptive-validator-3' }
    assert.deepEqual(await queue.matchingVerifierStops(otherFix), [{
      ...original, jobId: id, ownerId: owner, threadId,
    }])
    assert.equal(await queue.enqueueFix(stranger, id, original, otherFix, now), false)
    assert.equal(await queue.enqueueFix(owner, id, distinct, otherFix, now), false)
    await jobs.cancel(owner, id, now)
    assert.deepEqual(await queue.matchingVerifierStops(otherFix), [],
      'cancellation is never overridden by deployment pickup')
    assert.equal(await queue.enqueueFix(owner, id, original, otherFix, now), false)
  })
}
