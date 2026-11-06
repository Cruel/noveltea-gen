import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { startStoryJob, type JobStartResult } from '../../src/job'
import { configurePiPolicy, guardPiBudget, inspectPiPolicy, PiBudgetPause } from '../../src/job-pi-policy'
import { openStudioDatabase } from './support/studio-database'
import { studioSeed } from './support/studio-seed'
import { migrateStudio } from '../src/db/migrations'
import { inspectStoryUsage, aggregateUsage, snapshotJobUsage } from '../src/lib/thread-usage.server'
import { deleteThread } from '../src/lib/thread-deletion.server'
import { archiveThread } from '../src/lib/threads.server'
import type { RunUsage } from '../src/lib/thread-usage.server'
import { ThreadUsage } from '../src/components/thread-usage'

const config = {
  baseURL: 'http://localhost:3000', secret: 'usage-integration-test-secret-01234567890',
  github: { clientId: 'test', clientSecret: 'test' },
  gitlab: { clientId: 'test', clientSecret: 'test' },
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

test('run budgets are independent; Story, Thread and deleted-history usage survives reconnect and is tenant scoped', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'nt-thread-usage-'))
  const previousCache = process.env.NT_GIT_CACHE_DIR
  const previousState = process.env.NT_STATE_DIR
  const cache = join(tmp, 'cache')
  process.env.NT_GIT_CACHE_DIR = cache
  process.env.NT_STATE_DIR = join(tmp, 'state')
  let db = openStudioDatabase(join(tmp, 'studio.sqlite'))
  try {
    await migrateStudio(db, config)
    const owner = randomUUID(), stranger = randomUUID()
    const repoId = randomUUID(), storyId = randomUUID(), conversationId = randomUUID()
    const parentThread = randomUUID(), childThread = randomUUID()
    const providerId = 'repo-usage'
    const root = join(cache, hash(owner), hash('github:' + providerId), 'base')
    mkdirSync(join(root, 'story'), { recursive: true })
    git(root, 'init', '-q')
    git(root, 'config', 'user.email', 'test@example.com')
    git(root, 'config', 'user.name', 'Test')
    writeFileSync(join(root, 'story', 'foundation.md'), 'Story baseline.\n')
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'Base')
    const commit = git(root, 'rev-parse', 'HEAD')

    const seed = studioSeed(db)
    await seed.user(owner)
    await seed.user(stranger)
    const at = '2026-11-05T00:00:00Z'
    await seed.repository({ id: repoId, ownerUserId: owner, provider: 'github',
      providerRepositoryId: providerId, name: 'NovelTea', createdAt: at })
    await seed.story({ id: storyId, ownerUserId: owner, repositoryId: repoId,
      directory: 'story', title: 'The Story', createdAt: at })
    await seed.conversation({ id: conversationId, ownerUserId: owner, storyId,
      title: 'Primary', createdAt: at, updatedAt: at })
    await seed.thread({ id: parentThread, ownerUserId: owner, conversationId,
      parentThreadId: null, title: 'Original', activityAt: at, createdAt: at })
    await seed.thread({ id: childThread, ownerUserId: owner, conversationId,
      parentThreadId: parentThread, title: 'Fork', activityAt: at, createdAt: at })

    const jobs: JobStartResult[] = []
    for (let i = 0; i < 3; i++) {
      const id = randomUUID()
      const job = await startStoryJob({ story: join(root, 'story'), job: id,
        worktreeCacheRoot: join(cache, hash(owner), hash('github:' + providerId)) })
      const threadId = i === 2 ? childThread : parentThread
      const order = i === 2 ? 0 : i
      await seed.job({ id, ownerUserId: owner, storyId, title: 'Run ' + i,
        sourceCommitSha: commit, status: 'completed',
        generationRequestJson: JSON.stringify({ fixture: false }),
        generationThreadId: 'graph:' + id, createdAt: at, updatedAt: at })
      await seed.threadRun({ jobId: id, ownerUserId: owner, threadId, runOrder: order })
      await configurePiPolicy(job, { version: 1,
        profile: { provider: 'openai', model: 'gpt-6-luna' },
        limits: { modelCalls: i === 0 ? 1 : 3 } })
      await guardPiBudget(job, 'work:' + i)
      const dir = join(job.stateDir, 'sessions', 'usage')
      const session = SessionManager.create(job.worktreeStoryRoot, dir)
      session.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Done' }],
        api: 'openai-completions', provider: 'openai', model: 'gpt-6-luna',
        usage: { input: 10 + i, output: 5, cacheRead: 2, cacheWrite: 1,
          totalTokens: 18 + i,
          cost: { total: (i + 1) * 0.1 } },
        stopReason: 'stop', timestamp: Date.now() } as Parameters<typeof session.appendMessage>[0])
      if (i === 0) {
        await assert.rejects(() => guardPiBudget(job, 'work:' + i, session.getSessionFile()!),
          (error: unknown) => error instanceof PiBudgetPause && error.reason === 'modelCalls')
      } else await guardPiBudget(job, 'work:' + i, session.getSessionFile()!)
      jobs.push(job)
    }
    await assert.rejects(() => guardPiBudget(jobs[0]!, 'next'),
      (error: unknown) => error instanceof PiBudgetPause && error.reason === 'modelCalls')
    await guardPiBudget(jobs[1]!, 'next')
    assert.equal((await inspectPiPolicy(jobs[2]!)).budget.modelCalls, 1,
      'fork has its own counter, unaffected by the parent budget pause')

    const first = await inspectStoryUsage(db, owner, storyId)
    assert.equal(first.total.runs, 3)
    assert.equal(first.total.modelCalls, 3)
    assert.equal(first.total.tokens.total, 57)
    assert.ok(Math.abs(first.total.costUsd - 0.6) < 0.000001)
    assert.equal(first.threads.find(item => item.threadId === parentThread)?.total.modelCalls, 2)
    assert.equal(first.threads.find(item => item.threadId === childThread)?.total.modelCalls, 1)
    assert.equal(first.total.unavailableRuns, 0)
    await assert.rejects(() => inspectStoryUsage(db, stranger, storyId), /not found/i)
    await archiveThread(db, owner, childThread)
    assert.deepEqual((await inspectStoryUsage(db, owner, storyId)).total, first.total,
      'archiving a child does not discard or duplicate its usage')
    await db.testing.records.update('studio_sessions', { id: jobs[2]!.jobId },
      { generationRequestJson: '{corrupt' })
    const uncertain = await inspectStoryUsage(db, owner, storyId)
    assert.equal(uncertain.total.unavailableRuns, 1,
      'a corrupt request cannot be reported as a known zero-cost execution')
    await db.testing.records.update('studio_sessions', { id: jobs[2]!.jobId },
      { generationRequestJson: JSON.stringify({ fixture: false }) })

    await deleteThread(db, owner, childThread)
    assert.equal(existsSync(jobs[2]!.stateDir), false, 'deleted leaf removes the raw Pi transcript')
    const deletion = await db.testing.records.first<{ deletionPlanJson: string }>(
      'story_threads', { id: childThread })
    assert.ok(deletion?.deletionPlanJson)
    assert.equal(deletion.deletionPlanJson.includes('worktreeRoot'), false,
      'retention record cannot contain source or filesystem paths')
    assert.equal(deletion.deletionPlanJson.includes('Done'), false)
    const afterDelete = await inspectStoryUsage(db, owner, storyId)
    assert.deepEqual(afterDelete.total, first.total, 'deleted run keeps only the aggregated meter')
    assert.equal(afterDelete.threads.find(item => item.threadId === childThread)?.runs[0]?.origin,
      'retained-summary')
    // Pre-upgrade deletion summaries did not contain activeSeconds. They must
    // retain historic recorded calls and costs after this budget addition.
    const historical = JSON.parse(deletion.deletionPlanJson) as {
      usageSummaries: Record<string, { spent?: { activeSeconds?: number } | null }>
    }
    for (const summary of Object.values(historical.usageSummaries))
      if (summary.spent) delete summary.spent.activeSeconds
    await db.testing.records.update('story_threads', { id: childThread },
      { deletionPlanJson: JSON.stringify(historical) })
    assert.deepEqual((await inspectStoryUsage(db, owner, storyId)).total, first.total)

    db.close()
    db = openStudioDatabase(join(tmp, 'studio.sqlite'))
    await migrateStudio(db, config)
    assert.deepEqual((await inspectStoryUsage(db, owner, storyId)).total, first.total)
    assert.deepEqual(await db.testing.foreignKeyViolations(), [])
  } finally {
    db.close()
    if (previousCache === undefined) delete process.env.NT_GIT_CACHE_DIR
    else process.env.NT_GIT_CACHE_DIR = previousCache
    if (previousState === undefined) delete process.env.NT_STATE_DIR
    else process.env.NT_STATE_DIR = previousState
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('missing Pi budget evidence is unknown, not a confirmed zero-cost run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-missing-usage-'))
  try {
    const job = { stateDir: root } as JobStartResult
    const real = await snapshotJobUsage({ requestJson: JSON.stringify({ fixture: false }) }, job)
    assert.deepEqual(real, { version: 1, origin: 'unavailable', limits: null, spent: null })
    const fixture = await snapshotJobUsage({ requestJson: JSON.stringify({ fixture: true }) }, job)
    assert.equal(fixture.origin, 'fixture')
    assert.equal(fixture.spent?.modelCalls, 0, 'fixture can legitimately report no Pi calls')
    const prepared = await snapshotJobUsage({ requestJson: null }, job)
    assert.equal(prepared.origin, 'prepared')
    assert.equal(prepared.spent?.modelCalls, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('deleted run summaries remain readable without dead job links', () => {
  const spent = { steps: 1, modelCalls: 2, costUsd: 0.1, activeSeconds: 0, unpricedCalls: 0,
    unknownTokenCalls: 0, tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 } }
  const run: RunUsage = {
    version: 1, jobId: 'deleted-job', threadId: 'child', runOrder: 0,
    status: 'completed', origin: 'retained-summary', limits: null, spent, deleted: true,
  }
  const view = renderToStaticMarkup(createElement(ThreadUsage, {
    usage: { storyId: 'story', total: aggregateUsage([run]),
      threads: [{ threadId: 'child', total: aggregateUsage([run]), runs: [run] }] },
    threadId: 'child',
  }))
  assert.match(view, /Retained usage summary/)
  assert.match(view, /Individual run budgets and usage/)
  assert.ok(!view.includes('href="/jobs/deleted-job"'))
})

test('aggregates deduplicate run IDs and keep unavailable usage explicitly unknown', () => {
  const meter = { steps: 1, modelCalls: 1, costUsd: 0.5, activeSeconds: 0, unpricedCalls: 1,
    unknownTokenCalls: 0, tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, total: 17 } }
  const one: RunUsage = { version: 1, jobId: 'one', threadId: 'thread', runOrder: 0,
    status: 'completed', origin: 'pi-transcript', limits: { modelCalls: 2 }, spent: meter,
    deleted: false }
  const missing: RunUsage = { ...one, jobId: 'missing', origin: 'unavailable', spent: null }
  assert.deepEqual(aggregateUsage([one, one, missing]), {
    runs: 2, unavailableRuns: 1, steps: 1, modelCalls: 1, costUsd: 0.5, activeSeconds: 0,
    unpricedCalls: 1, unknownTokenCalls: 0, tokens: meter.tokens,
  })
})
