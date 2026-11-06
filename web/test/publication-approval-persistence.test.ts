import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openStudioDatabase } from './support/studio-database'
import { studioSeed } from './support/studio-seed'
import { migrateStudio } from '../src/db/migrations'
import type { PublicationReceipt, ProtectedDecisionGrant } from '../src/persistence/publication-contracts'

const config = {
  baseURL: 'http://localhost:3000',
  secret: 'publication-approval-revision-port-test-secret-01234',
  github: { clientId: 'test', clientSecret: 'test' },
  gitlab: { clientId: 'test', clientSecret: 'test' },
}
const t0 = '2026-11-01T00:00:00Z'
const sha = 'a'.repeat(40)
const commit = 'b'.repeat(40)

test('publication intents and links are owner/provider scoped, restart-safe and never overwrite remote identity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'noveltea-publication-db-'))
  const file = join(dir, 'studio.sqlite')
  const a = openStudioDatabase(file), b = openStudioDatabase(file)
  try {
    await migrateStudio(a, config)
    const owner = randomUUID(), stranger = randomUUID()
    const githubJob = randomUUID(), gitlabJob = randomUUID()
    const seed = studioSeed(a)
    for (const id of [owner, stranger]) { await seed.user(id) }
    for (const [provider, jobId, remoteId] of [
      ['github', githubJob, '123'], ['gitlab', gitlabJob, '456'],
    ] as const) {
      const repo = randomUUID(), story = randomUUID()
      ;(await seed.repository({ id: repo, ownerUserId: owner, provider,
        providerRepositoryId: remoteId, name: 'A/Story', createdAt: t0 }))
      ;(await seed.story({ id: story, ownerUserId: owner, repositoryId: repo,
        directory: 'story', title: 'Test Story', createdAt: t0, sourceCommitSha: sha }))
      ;(await seed.job({ id: jobId, ownerUserId: owner, storyId: story, title: 'Test Job',
        status: 'paused', sourceCommitSha: sha, createdAt: t0, updatedAt: t0 }))
    }
    for (const [provider, jobId, number] of [
      ['github', githubJob, 15], ['gitlab', gitlabJob, 22],
    ] as const) {
      const portA = a.persistence.publications, portB = b.persistence.publications
      assert.equal((await portB.job(owner, jobId, provider))?.baseSha, sha)
      assert.equal(await portA.job(stranger, jobId, provider), null)
      assert.equal(await portA.job(owner, jobId, provider === 'github' ? 'gitlab' : 'github'), null)
      const pending: PublicationReceipt = {
        phase: 'pending', targetBranch: 'main', remoteBranch: 'noveltea-gen/job',
        headSha: commit, number: null, url: null,
      }
      await assert.rejects(portA.save(stranger, jobId, provider, pending, t0), /owned/i)
      await portA.save(owner, jobId, provider, pending, t0)
      const recovered = openStudioDatabase(file)
      try {
        assert.deepEqual(await recovered.persistence.publications.get(owner, jobId, provider), pending,
          'interrupted push intent survives a fresh Studio process before provider reconciliation')
      } finally { recovered.close() }
      await portB.save(owner, jobId, provider, { ...pending, headSha: sha }, t0)
      assert.deepEqual(await portA.get(owner, jobId, provider), pending,
        'the verified pending HEAD remains pinned after ambiguous retries')
      assert.equal(await portB.get(stranger, jobId, provider), null)
      await assert.rejects(portB.save(owner, jobId, provider,
        { ...pending, targetBranch: 'develop' }, t0), /branch identity/)
      const linked: PublicationReceipt = {
        ...pending, phase: 'linked', number,
        url: `https://provider.test/review/${number}`,
      }
      await assert.rejects(portB.save(owner, jobId, provider,
        { ...linked, headSha: sha }, t0), /HEAD differs/)
      await portB.save(owner, jobId, provider, linked, t0)
      await portA.save(owner, jobId, provider, linked, t0)
      await portA.save(owner, jobId, provider, pending, t0)
      assert.deepEqual(await portB.get(owner, jobId, provider), linked,
        'retries cannot turn a verified link into an unlinked pending intent')
      await assert.rejects(portA.save(owner, jobId, provider,
        { ...linked, number: number + 1 }, t0), /identity changed/)
      await assert.rejects(portA.save(owner, jobId, provider,
        { ...linked, remoteBranch: 'other-branch' }, t0), /branch identity/)
    }
    assert.deepEqual((await a.testing.foreignKeyViolations()), [])
    a.close(); b.close()
    const reopened = openStudioDatabase(file)
    try {
      assert.equal((await reopened.persistence.publications.get(owner, githubJob, 'github'))?.number, 15)
      assert.equal((await reopened.persistence.publications.get(owner, gitlabJob, 'gitlab'))?.number, 22)
    } finally { reopened.close() }
  } finally {
    a.close()
    b.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('protected receipts and Story-scope grants enforce current owner, queue head, source and one consumption', async () => {
  const db = openStudioDatabase(':memory:')
  try {
    await migrateStudio(db, config)
    const owner = randomUUID(), outsider = randomUUID(), repo = randomUUID()
    const story = randomUUID(), job = randomUUID(), conversation = randomUUID(), thread = randomUUID()
    const seed = studioSeed(db)
    for (const id of [owner, outsider]) { await seed.user(id) }
    (await seed.repository({ id: repo, ownerUserId: owner, provider: 'github',
      providerRepositoryId: '123', name: 'A/Story', createdAt: t0 }))
    ;(await seed.story({ id: story, ownerUserId: owner, repositoryId: repo,
      directory: 'story', title: 'Story', createdAt: t0, sourceCommitSha: sha }))
    ;(await seed.job({ id: job, ownerUserId: owner, storyId: story, title: 'Job',
      status: 'completed', sourceCommitSha: sha, createdAt: t0, updatedAt: t0 }))
    ;(await seed.queue({ jobId: job, ownerUserId: owner, intent: 'start', phase: 'finished',
      createdAt: t0, updatedAt: t0 }))
    ;(await seed.conversation({ id: conversation, ownerUserId: owner, storyId: story,
      title: 'Chat', createdAt: t0, updatedAt: t0 }))
    ;(await seed.thread({ id: thread, ownerUserId: owner, conversationId: conversation,
      title: 'Thread', activityAt: t0, createdAt: t0 }))
    ;(await seed.threadRun({ jobId: job, ownerUserId: owner, threadId: thread, runOrder: 0 }))
    const [denialId, approvalId, futureId] = [randomUUID(), randomUUID(), randomUUID()]
    for (const [sequence, id] of [denialId, approvalId, futureId].entries()) {
      (await seed.message({ id, ownerUserId: owner, threadId: thread, sequence,
        role: 'user', status: 'queued', body: 'Change the decision',
        phase: 'queued', createdAt: t0 }))
    }
    assert.equal((await db.persistence.approvalJobs.job(owner, job))?.directory, 'story')
    assert.equal(await db.persistence.approvalJobs.job(outsider, job), null)
    const approved = (messageId: string, decision: 'approved' | 'rejected'): ProtectedDecisionGrant => ({
      messageId, owner, threadId: thread, sourceJobId: job,
      sourceSha: sha, digest: 'd'.repeat(64), changeJson: '{"before":"old","after":"new"}',
      nonce: randomUUID(), decision, principal: 'user:' + owner, recordedAt: t0,
    })
    const denial = approved(denialId, 'rejected')
    const port = db.persistence.protectedDecisions
    const recordedDenial = await port.record(owner, denial, 'Change the decision')
    assert.equal(recordedDenial.decision, 'rejected')
    assert.equal((await port.record(owner, { ...denial, nonce: randomUUID() }, 'Change the decision')).nonce,
      recordedDenial.nonce, 'duplicate decision retains the original trusted receipt')
    await assert.rejects(port.record(owner, approved(denialId, 'approved'), 'Change the decision'),
      /different or stale/)
    await assert.rejects(port.record(outsider, { ...denial, owner: outsider, principal: 'user:' + outsider },
      'Change the decision'), /queued|source/)
    assert.equal(await port.get(outsider, denialId), null)
    await assert.rejects(port.record(owner, approved(approvalId, 'approved'), 'Change the decision'),
      /queued/)
    await db.persistence.messages.cancel(owner, thread, denialId, t0)
    const grant = approved(approvalId, 'approved')
    assert.equal((await port.record(owner, grant, 'Change the decision')).decision, 'approved')
    assert.equal(await port.consume(owner, approvalId, commit), true)
    assert.equal(await port.consume(owner, approvalId, commit), false)
    assert.equal((await port.get(owner, approvalId))?.consumedSha, commit)
    assert.equal(await port.consume(outsider, approvalId, commit), false)

    const revisions = db.persistence.revisions
    assert.equal((await revisions.head(owner, thread))?.id, approvalId)
    assert.equal((await revisions.latestRun(owner, thread))?.jobId, job)
    assert.equal(await revisions.latestRun(outsider, thread), null)
    assert.equal(await revisions.grant(owner, thread, futureId, 'Change the decision',
      { jobId: job, status: 'completed', queuePhase: 'finished' }, '{"target":"future"}'), 'stale')
    assert.equal(await revisions.grant(owner, thread, approvalId, 'Change the decision',
      { jobId: job, status: 'completed', queuePhase: 'finished' }, '{"target":"original"}'), 'granted')
    assert.equal(await revisions.grant(owner, thread, approvalId, 'Change the decision',
      { jobId: job, status: 'completed', queuePhase: 'finished' }, '{"target":"original"}'), 'already')
    await assert.rejects(revisions.grant(owner, thread, approvalId, 'Change the decision',
      { jobId: job, status: 'completed', queuePhase: 'finished' }, '{"target":"other"}'),
      /different scope/)
    assert.equal(await revisions.grant(outsider, thread, approvalId, 'Change the decision',
      { jobId: job, status: 'completed', queuePhase: 'finished' }, '{"target":"other"}'), 'stale')
    await db.persistence.messages.cancel(owner, thread, approvalId, t0)
    assert.equal(await revisions.grant(owner, thread, futureId, 'Change the decision',
      { jobId: job, status: 'completed', queuePhase: 'finished' }, '{"target":"future"}'), 'granted')
    ;(await db.testing.records.update('generation_run_queue', { jobId: job }, { phase: 'interrupted' }))
    assert.equal(await revisions.grant(owner, thread, futureId, 'Change the decision',
      { jobId: job, status: 'completed', queuePhase: 'finished' }, '{"target":"future"}'), 'stale')
    assert.deepEqual((await db.testing.foreignKeyViolations()), [])
  } finally { db.close() }
})
