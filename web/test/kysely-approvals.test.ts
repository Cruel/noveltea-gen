import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { ProtectedDecisionGrant, RevisionRun } from '../src/persistence/publication-contracts'
import { ThreadMessageConflict } from '../src/persistence/thread-message-contracts'
import { openKyselyFeatureFixture, type KyselyFeatureFixture } from './support/kysely-feature-fixture'

const now = '2026-11-09T12:00:00Z'
const base = 'a'.repeat(40)
const committed = 'b'.repeat(40)
const changed = 'c'.repeat(40)
const pg = process.env.NT_TEST_PG_URL
if (process.env.NT_REQUIRE_KYSELY_PROOF === '1' && !pg)
  throw new Error('NT_TEST_PG_URL required for shared protected decision conformance')

async function setup(f: KyselyFeatureFixture) {
  const owner = await f.owner(), outsider = await f.owner()
  const repo = randomUUID(), story = randomUUID(), job = randomUUID(), thread = randomUUID()
  await f.records.insert('repositories', {
    id: repo, ownerUserId: owner, provider: 'github',
    providerRepositoryId: '123', name: 'Owner/Story', createdAt: now,
  })
  await f.records.insert('stories', {
    id: story, ownerUserId: owner, repositoryId: repo,
    directory: 'story', title: 'Story', sourceCommitSha: base, createdAt: now,
  })
  await f.records.insert('studio_sessions', {
    id: job, ownerUserId: owner, storyId: story, title: 'Complete source',
    status: 'completed', sourceCommitSha: base, createdAt: now, updatedAt: now,
  })
  await f.records.insert('story_threads', {
    id: thread, ownerUserId: owner, storyId: story,
    title: 'Thread', createdAt: now, activityAt: now,
  })
  await f.records.insert('story_thread_runs', {
    jobId: job, ownerUserId: owner, threadId: thread, runOrder: 0,
  })
  await f.records.insert('generation_run_queue', {
    jobId: job, ownerUserId: owner, intent: 'start', phase: 'finished',
    createdAt: now, updatedAt: now,
  })
  return { owner, outsider, job, thread, story }
}
type X = Awaited<ReturnType<typeof setup>>

async function message(f: KyselyFeatureFixture, x: X, sequence: number, body = 'Change decision') {
  const id = randomUUID()
  await f.records.insert('story_thread_messages', {
    id, ownerUserId: x.owner, threadId: x.thread,
    sequence, role: 'user', status: 'queued', phase: 'queued',
    body, createdAt: now,
  })
  return id
}
function proposal(x: X, messageId: string, decision: 'approved' | 'rejected' = 'approved'): ProtectedDecisionGrant {
  return {
    owner: x.owner, threadId: x.thread, messageId, sourceJobId: x.job,
    sourceSha: base, digest: 'd'.repeat(64),
    changeJson: '{"before":"original","after":"new"}',
    nonce: randomUUID(), decision, principal: 'user:' + x.owner,
    recordedAt: now,
  }
}
const source = (x: X): RevisionRun =>
  ({ jobId: x.job, status: 'completed', queuePhase: 'finished' })

async function cancel(f: KyselyFeatureFixture, x: X, messageId: string) {
  await f.records.insert('story_thread_message_cancellations', {
    messageId, ownerUserId: x.owner, threadId: x.thread, cancelledAt: now,
  })
}

for (const backend of ['sqlite', 'postgres'] as const) {
  test(backend + ': trusted approval jobs, decisions and revision grants share owner and source guards', {
    skip: backend === 'postgres' && !pg && 'Set NT_TEST_PG_URL',
    timeout: 90_000,
  }, async t => {
    const f = await openKyselyFeatureFixture(backend)
    t.after(() => f.close())
    const x = await setup(f), { records: data } = f
    const other = await f.openIndependentApprovals()
    t.after(() => other.close())
    const denial = await message(f, x, 0)
    const approval = await message(f, x, 1)
    const future = await message(f, x, 2)
    assert.deepEqual(await f.approvalJobs.job(x.owner, x.job), {
      directory: 'story', provider: 'github', providerId: '123', baseSha: base,
    })
    assert.equal(await f.approvalJobs.job(x.outsider, x.job), null)
    assert.equal(await f.approvalJobs.job(x.owner, randomUUID()), null)
    assert.equal((await f.revisions.head(x.owner, x.thread))?.id, denial)
    assert.equal((await f.revisions.latestRun(x.owner, x.thread))?.jobId, x.job)
    assert.equal(await f.revisions.head(x.outsider, x.thread), null)
    assert.equal(await f.revisions.latestRun(x.outsider, x.thread), null)

    const denied = proposal(x, denial, 'rejected')
    const saved = await f.protectedDecisions.record(x.owner, denied, 'Change decision')
    assert.equal(saved.decision, 'rejected')
    assert.equal(await f.protectedDecisions.consume(x.owner, denial, committed), false)
    assert.equal((await other.protectedDecisions.record(x.owner, {
      ...denied, nonce: randomUUID(),
    }, 'Change decision')).nonce, saved.nonce, 'retry retains trusted receipt identity')
    await assert.rejects(other.protectedDecisions.record(x.owner, {
      ...denied, decision: 'approved',
    }, 'Change decision'), /different or stale/)
    await assert.rejects(f.protectedDecisions.record(x.outsider, {
      ...denied, owner: x.outsider, principal: 'user:' + x.outsider,
    }, 'Change decision'), /queued|source/)
    await assert.rejects(f.protectedDecisions.record(x.owner, {
      ...denied, principal: 'user:' + x.outsider,
    }, 'Change decision'), /principal/)
    await assert.rejects(f.protectedDecisions.record(x.owner, proposal(x, approval),
      'Change decision'), /queued/)
    assert.equal(await other.protectedDecisions.get(x.outsider, denial), null)

    assert.equal(await f.revisions.grant(x.owner, x.thread, future, 'Change decision',
      source(x), '{"scope":"future"}'), 'stale')
    await cancel(f, x, denial)
    assert.equal((await f.revisions.head(x.owner, x.thread))?.id, approval)
    const approved = proposal(x, approval)
    await assert.rejects(other.protectedDecisions.record(x.owner, {
      ...approved, sourceJobId: randomUUID(),
    }, 'Change decision'), /queued/)
    await assert.rejects(other.protectedDecisions.record(x.owner, {
      ...approved, threadId: randomUUID(),
    }, 'Change decision'), /queued/)
    assert.equal(await f.protectedDecisions.get(x.owner, approval), null)

    // Two independent connections can submit the same trusted action, but
    // authorization identity and revision scope remain single-valued.
    const [a, b] = await Promise.all([
      f.protectedDecisions.record(x.owner, approved, 'Change decision'),
      other.protectedDecisions.record(x.owner, { ...approved, nonce: randomUUID() }, 'Change decision'),
    ])
    assert.equal(a.nonce, b.nonce)
    assert.equal(await data.count('thread_protected_decisions', { messageId: approval }), 1)
    const grants = await Promise.all([
      f.revisions.grant(x.owner, x.thread, approval, 'Change decision', source(x), '{"scope":"exact"}'),
      other.revisions.grant(x.owner, x.thread, approval, 'Change decision', source(x), '{"scope":"exact"}'),
    ])
    assert.deepEqual(grants.sort(), ['already', 'granted'])
    assert.equal(await other.revisions.scope(x.owner, x.thread, approval), '{"scope":"exact"}')
    assert.equal(await f.revisions.scope(x.outsider, x.thread, approval), null)
    assert.equal(await f.revisions.grant(x.outsider, x.thread, approval, 'Change decision',
      source(x), '{"scope":"exact"}'), 'stale')
    await assert.rejects(f.revisions.grant(x.owner, x.thread, approval, 'Change decision',
      source(x), '{"scope":"changed"}'), (e: unknown) => e instanceof ThreadMessageConflict && e.status === 409)
    assert.equal(await other.revisions.grant(x.owner, x.thread, approval, 'Wrong text',
      source(x), '{"scope":"exact"}'), 'stale')
    const consumed = await Promise.all([
      f.protectedDecisions.consume(x.owner, approval, committed),
      other.protectedDecisions.consume(x.owner, approval, changed),
    ])
    assert.deepEqual([...consumed].sort(), [false, true])
    assert.equal((await f.protectedDecisions.get(x.owner, approval))?.consumedSha,
      consumed[0] ? committed : changed)
    assert.equal(await f.protectedDecisions.consume(x.owner, approval, committed), false)
    assert.equal(await other.protectedDecisions.consume(x.outsider, approval, committed), false)
    assert.equal(await other.protectedDecisions.consume(x.owner, approval, 'invalid'), false)

    await data.insert('thread_live_inputs', {
      messageId: denial, ownerUserId: x.owner, threadId: x.thread, sourceJobId: x.job,
      mode: 'steer', state: 'delivered', createdAt: now,
    })
    await data.insert('thread_steering_intents', {
      messageId: denial, ownerUserId: x.owner, threadId: x.thread, sourceJobId: x.job,
      disposition: 'protected-review', reviewMessageId: approval,
      reviewState: 'awaiting-review', consideredAt: now,
    })
    assert.equal(await f.revisions.redirected(x.owner, x.thread, approval), true)
    assert.equal(await f.revisions.redirected(x.outsider, x.thread, approval), false)

    await cancel(f, x, approval)
    assert.equal((await f.revisions.head(x.owner, x.thread))?.id, future)
    assert.equal(await f.revisions.grant(x.owner, x.thread, future, 'Change decision',
      source(x), '{"scope":"future"}'), 'granted')
    await data.update('generation_run_queue', { jobId: x.job }, { phase: 'interrupted' })
    assert.equal(await other.revisions.grant(x.owner, x.thread, future, 'Change decision',
      source(x), '{"scope":"future"}'), 'stale')
    await assert.rejects(other.protectedDecisions.record(x.owner, proposal(x, future),
      'Change decision'), /queued/)
    assert.equal(await data.count('thread_protected_decisions', { messageId: future }), 0)
  })

  test(backend + ': foreign keys, cancelled approval, nonce collisions and protected finish rollback', {
    skip: backend === 'postgres' && !pg && 'Set NT_TEST_PG_URL',
    timeout: 90_000,
  }, async t => {
    const f = await openKyselyFeatureFixture(backend)
    t.after(() => f.close())
    const x = await setup(f)
    const id = await message(f, x, 0)
    await assert.rejects(f.records.insert('thread_protected_decisions', {
      messageId: id, ownerUserId: x.outsider, threadId: x.thread,
      sourceJobId: x.job, sourceSha: base, proposalSha256: 'd'.repeat(64),
      changeJson: '{}', nonce: randomUUID(), decision: 'approved',
      principal: 'user:' + x.outsider, recordedAt: now,
    }), /foreign key|constraint/i, 'composite owner FKs cannot cross tenants')

    const saved = await f.protectedDecisions.record(x.owner, proposal(x, id), 'Change decision')
    const another = await message(f, x, 1)
    await cancel(f, x, id)
    await assert.rejects(f.protectedDecisions.record(x.owner, {
      ...proposal(x, another), nonce: saved.nonce,
    }, 'Change decision'), /unique|constraint|duplicate/i)
    assert.equal(await f.protectedDecisions.get(x.owner, another), null,
      'failed uniqueness check leaves no partial receipt')
    await assert.rejects(f.protectedDecisions.record(x.owner, proposal(x, id),
      'Change decision'), /queued/, 'cancelled messages cannot renew consent')
    assert.equal(await f.revisions.grant(x.owner, x.thread, id, 'Change decision',
      source(x), '{"scope":"stale"}'), 'stale')
    const pending = await f.continuation.claim(x.owner, x.thread)
    assert.equal(pending, null, 'claim without revision scope is not admitted')
    assert.equal(await f.records.count('story_thread_runs', { jobId: another }), 0)
  })

  test(backend + ': one-shot protected continuation binds exact verified head and rolls back', {
    skip: backend === 'postgres' && !pg && 'Set NT_TEST_PG_URL',
    timeout: 90_000,
  }, async t => {
    const f = await openKyselyFeatureFixture(backend)
    t.after(() => f.close())
    const x = await setup(f)
    const id = await message(f, x, 0)
    await f.revisions.grant(x.owner, x.thread, id, 'Change decision',
      source(x), JSON.stringify({ sourceSha: base, sourceJobId: x.job }))
    await f.protectedDecisions.record(x.owner, proposal(x, id), 'Change decision')
    const claim = await f.continuation.claim(x.owner, x.thread)
    assert.equal(claim?.id, id)
    const data = {
      owner: x.owner, threadId: x.thread, claim: claim!, sourceHead: base,
      generationThread: 'generation:' + id,
      draftJson: '{"version":1}', requestJson: '{"task":"protected"}',
      at: now,
    }
    await assert.rejects(f.continuation.protectedFinish({
      ...data, sourceHead: changed,
    }, committed), /changed|consumed/)
    assert.equal(await f.records.count('studio_sessions', { id }), 0)
    assert.equal((await f.protectedDecisions.get(x.owner, id))?.consumedSha, null)
    await f.continuation.protectedFinish(data, committed)
    assert.equal((await f.protectedDecisions.get(x.owner, id))?.consumedSha, committed)
    assert.equal((await f.records.first<{ verifiedCommitSha: string }>('story_thread_messages', {
      id,
    }))?.verifiedCommitSha, committed)
    assert.equal(await f.records.count('studio_sessions', { id }), 1)
    assert.equal(await f.records.count('generation_run_queue', { jobId: id }), 1)
    await assert.rejects(f.continuation.protectedFinish(data, committed), /changed|registered|consumed/)
    assert.equal(await f.records.count('story_thread_messages', { id: 'assistant:' + id }), 1)
  })
}
