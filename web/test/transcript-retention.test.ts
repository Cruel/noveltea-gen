import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { startStoryJob } from '../../src/job'
import { guardPiBudget } from '../../src/job-pi-policy'
import { migrateStudio } from '../src/db/migrations'
import { cleanFinalizedTranscripts, transcriptRetentionDays } from '../src/lib/transcript-retention.server'
import { inspectStoryUsage } from '../src/lib/thread-usage.server'
import { openStudioDatabase } from './support/studio-database'
import { studioSeed } from './support/studio-seed'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const settings = { baseURL: 'http://localhost:3000',
  secret: 'transcript-retention-test-secret-01234567890',
  github: { clientId: 'test', clientSecret: 'test' },
  gitlab: { clientId: 'test', clientSecret: 'test' } }

test('finalized transcript retention is operator-configured and fail closed', () => {
  assert.equal(transcriptRetentionDays(undefined), 30)
  assert.equal(transcriptRetentionDays('7'), 7)
  assert.equal(transcriptRetentionDays('off'), null)
  for (const value of ['0', '-1', '1.5', 'abc', '36501', ' 30']) {
    assert.throws(() => transcriptRetentionDays(value), /Invalid finalized/)
  }
})

test('retention expires only settled published sessions, retaining recovery evidence, numeric usage and tenant isolation across restarts', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'nt-transcript-retention-'))
  const previous = {
    cache: process.env.NT_GIT_CACHE_DIR, state: process.env.NT_STATE_DIR,
    retention: process.env.NT_FINALIZED_TRANSCRIPT_RETENTION_DAYS,
  }
  process.env.NT_GIT_CACHE_DIR = join(tmp, 'cache')
  process.env.NT_STATE_DIR = join(tmp, 'state')
  process.env.NT_FINALIZED_TRANSCRIPT_RETENTION_DAYS = '30'
  let db = openStudioDatabase(join(tmp, 'studio.sqlite'))
  try {
    await migrateStudio(db, settings)
    const owner = randomUUID(), stranger = randomUUID()
    const repositoryId = randomUUID(), storyId = randomUUID(), conversationId = randomUUID()
    const providerId = 'retention-example'
    const base = join(tmp, 'cache', hash(owner), hash('github:' + providerId), 'base')
    mkdirSync(join(base, 'story'), { recursive: true })
    git(base, 'init', '-q')
    git(base, 'config', 'user.name', 'Test')
    git(base, 'config', 'user.email', 'test@example.com')
    writeFileSync(join(base, 'story', 'intro.md'), 'Original story\n')
    git(base, 'add', '.')
    git(base, 'commit', '-qm', 'Initial story')
    const sha = git(base, 'rev-parse', 'HEAD')
    const seed = studioSeed(db)
    await seed.user(owner)
    await seed.user(stranger)
    const old = '2026-08-01T00:00:00.000Z'
    const recent = '2026-11-01T00:00:00.000Z'
    const now = Date.parse('2026-11-06T12:00:00.000Z')
    await seed.repository({ id: repositoryId, ownerUserId: owner,
      provider: 'github', providerRepositoryId: providerId, name: 'Repo', createdAt: old })
    await seed.story({ id: storyId, ownerUserId: owner, repositoryId,
      directory: 'story', title: 'Retention Story', createdAt: old })
    await seed.conversation({ id: conversationId, ownerUserId: owner, storyId,
      title: 'History', createdAt: old, updatedAt: old })

    type Scenario = {
      name: string; status: 'completed' | 'paused' | 'blocked' | 'cancelled'
      queue: 'finished' | 'interrupted'; published: boolean; recent?: boolean
      evidence?: 'conflict' | 'approval' | 'symlink' | 'stale-lock' | 'missing-checkpoint'; pending?: boolean
    }
    const scenarios: Scenario[] = [
      { name: 'expired', status: 'completed', queue: 'finished', published: true },
      { name: 'recent', status: 'completed', queue: 'finished', published: true, recent: true },
      { name: 'unpublished', status: 'completed', queue: 'finished', published: false },
      { name: 'paused', status: 'paused', queue: 'finished', published: true },
      { name: 'interrupted', status: 'completed', queue: 'interrupted', published: true },
      { name: 'blocked', status: 'blocked', queue: 'finished', published: true },
      { name: 'cancelled', status: 'cancelled', queue: 'finished', published: true },
      { name: 'conflict-evidence', status: 'completed', queue: 'finished',
        published: true, evidence: 'conflict' },
      { name: 'approval-evidence', status: 'completed', queue: 'finished',
        published: true, evidence: 'approval' },
      { name: 'foreign-symlink', status: 'completed', queue: 'finished',
        published: true, evidence: 'symlink' },
      { name: 'stale-lock', status: 'completed', queue: 'finished',
        published: true, evidence: 'stale-lock' },
      { name: 'missing-checkpoint', status: 'completed', queue: 'finished',
        published: true, evidence: 'missing-checkpoint' },
      { name: 'unsettled', status: 'completed', queue: 'finished', published: true,
        pending: true },
    ]
    const saved = new Map<string, { path: string; state: string; jobId: string }>()
    for (const scenario of scenarios) {
      const jobId = randomUUID(), threadId = randomUUID()
      const job = await startStoryJob({ story: join(base, 'story'), job: jobId,
        worktreeCacheRoot: join(tmp, 'cache', hash(owner), hash('github:' + providerId)) })
      const at = scenario.recent ? recent : old
      await seed.thread({ id: threadId, ownerUserId: owner, conversationId,
        title: scenario.name, activityAt: at, createdAt: at })
      await seed.job({ id: jobId, ownerUserId: owner, storyId, title: scenario.name,
        sourceCommitSha: sha, status: scenario.status,
        generationRequestJson: JSON.stringify({ fixture: false }),
        generationThreadId: job.threadId + ':generation:web',
        createdAt: old, updatedAt: at })
      await seed.threadRun({ jobId, ownerUserId: owner, threadId, runOrder: 0 })
      await seed.queue({ jobId, ownerUserId: owner, intent: 'start',
        phase: scenario.queue, sequence: undefined, createdAt: at, updatedAt: at })
      if (scenario.published) await db.testing.records.insert('github_publications', {
        jobId, ownerUserId: owner, targetBranch: 'main', remoteBranch: job.branch,
        headSha: job.headSha, phase: 'linked', prNumber: 11, prUrl: 'https://example.test/pr/11',
        updatedAt: at,
      })
      const dir = join(job.stateDir, 'foundation-sessions')
      const session = SessionManager.create(job.worktreeStoryRoot, dir)
      session.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Private transcript' }],
        api: 'openai-completions', provider: 'openai', model: 'gpt-6-luna',
        usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10,
          cost: { total: 0.04 } }, stopReason: 'stop', timestamp: Date.now(),
      } as Parameters<typeof session.appendMessage>[0])
      await guardPiBudget(job, 'stage', session.getSessionFile()!)
      // Checkpoints/receipts are durable and must never be removed with JSONL.
      if (scenario.evidence !== 'missing-checkpoint')
        writeFileSync(join(job.stateDir, 'web-generation.sqlite'), 'checkpoint sentinel')
      if (scenario.evidence === 'conflict')
        writeFileSync(join(job.stateDir, 'foundation-conflict.json'), JSON.stringify({ sessionSha256: 'bound' }))
      if (scenario.evidence === 'approval') {
        mkdirSync(join(job.stateDir, 'specialist-choices'))
        writeFileSync(join(job.stateDir, 'specialist-choices', 'author.json'), JSON.stringify({ sessionSha256: 'bound' }))
      }
      if (scenario.evidence === 'symlink') {
        writeFileSync(join(tmp, 'outside-private.jsonl'), 'outside of this job')
        symlinkSync(join(tmp, 'outside-private.jsonl'), join(dir, 'foreign.jsonl'))
      }
      if (scenario.evidence === 'stale-lock')
        writeFileSync(join(job.stateDir, '.story-job-stale-reconciliation'), 'original writer evidence')
      if (scenario.pending) await seed.message({
        id: randomUUID(), ownerUserId: owner, threadId, sequence: 1,
        role: 'user', status: 'queued', body: 'Pending author approval',
        phase: 'blocked', createdAt: old,
      })
      saved.set(scenario.name, { path: session.getSessionFile()!, state: job.stateDir, jobId })
    }
    const expired = saved.get('expired')!
    assert.equal(await db.persistence.generation.jobs.finalizedTranscriptCandidate(stranger, expired.jobId), null,
      'foreign owner cannot retrieve another owner\'s pruning authority')
    assert.equal(await cleanFinalizedTranscripts(db, Date.parse('2026-08-20T00:00:00.000Z')), 0,
      'retention interval starts after both completion and publication')
    assert.equal(existsSync(expired.path), true)
    const before = await inspectStoryUsage(db, owner, storyId)
    const removed = await cleanFinalizedTranscripts(db, now)
    assert.equal(removed, 1)
    assert.equal(existsSync(expired.path), false)
    for (const [name, item] of saved) {
      assert.equal(existsSync(item.path), name !== 'expired', name + ' protection')
      if (name !== 'missing-checkpoint')
        assert.equal(readFileSync(join(item.state, 'web-generation.sqlite'), 'utf8'),
          'checkpoint sentinel', 'checkpoint must survive')
      assert.equal(existsSync(join(item.state, 'job.json')), true)
    }
    assert.equal(readFileSync(join(tmp, 'outside-private.jsonl'), 'utf8'), 'outside of this job')
    const receipt = readFileSync(join(expired.state, 'transcript-retention.json'), 'utf8')
    assert.equal(receipt.includes('Private transcript'), false)
    assert.equal(receipt.includes(expired.path), false)
    assert.equal(receipt.includes('0.04'), true)
    assert.deepEqual((await inspectStoryUsage(db, owner, storyId)).total, before.total,
      'usage is retained without raw JSONL')
    assert.equal(await cleanFinalizedTranscripts(db, now), 0, 'repeat cleanup is idempotent')
    db.close()
    db = openStudioDatabase(join(tmp, 'studio.sqlite'))
    await migrateStudio(db, settings)
    assert.equal(await cleanFinalizedTranscripts(db, now), 0, 'restart is idempotent')
    assert.deepEqual((await inspectStoryUsage(db, owner, storyId)).total, before.total)
  } finally {
    db.close()
    if (previous.cache === undefined) delete process.env.NT_GIT_CACHE_DIR
    else process.env.NT_GIT_CACHE_DIR = previous.cache
    if (previous.state === undefined) delete process.env.NT_STATE_DIR
    else process.env.NT_STATE_DIR = previous.state
    if (previous.retention === undefined) delete process.env.NT_FINALIZED_TRANSCRIPT_RETENTION_DAYS
    else process.env.NT_FINALIZED_TRANSCRIPT_RETENTION_DAYS = previous.retention
    rmSync(tmp, { recursive: true, force: true })
  }
})
