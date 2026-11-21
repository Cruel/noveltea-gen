import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { claimServerGeneration } from '../../src/generation-owner'
import { startStoryJob } from '../../src/job'
import { planWholeStory } from '../src/lib/turn-plan'
import { openWebGenerationGraph } from '../../src/web-fixture-runtime'
import { pickupKnownVerifierFixes, verifyKnownFixProof } from '../src/lib/known-fix-pickup.server'
import { selectedJob, restoreJob, pinnedRequest } from '../src/lib/fixture-jobs.server'
import { migrateStudio, openStudioDatabase } from './support/studio-database'
import { studioSeed } from './support/studio-seed'

const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const now = '2026-11-21T00:00:00Z'
const fix = { id: 'adaptive-parser-new-v2', check: 'adaptive-plan.v1', failedVersion: 1 }
const config = {
  baseURL: 'http://localhost:3000',
  secret: 'known-fix-pickup-test-secret-012345678901234567890',
  github: { clientId: 'test-gh', clientSecret: 'test' },
  gitlab: { clientId: 'test-gl', clientSecret: 'test' },
}
const contract = {
  scope: { kind: 'full-story' as const, depth: 'composition' as const,
    targets: [], branches: [] }, constraints: [],
  envelope: { presentation: 'Visual novel', hardLimits: [], preferences: [] },
}

test('#223 Studio startup picks only a source- and check-matched stopped Turn from a real Git job', {
  timeout: 60_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-known-fix-studio-'))
  const keys = ['NT_STATE_DIR', 'NT_GIT_CACHE_DIR', 'NT_NATIVE_CLI',
    'NT_STUDIO_KNOWN_VERIFIER_FIXES']
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  let store: ReturnType<typeof openStudioDatabase> | undefined
  try {
    const cache = join(root, 'cache')
    const state = join(root, 'state')
    const owner = randomUUID(), providerId = 'repo-1'
    const scoped = join(cache, hash(owner), hash('github:' + providerId))
    const repository = join(scoped, 'base'), story = join(repository, 'story')
    mkdirSync(story, { recursive: true })
    writeFileSync(join(story, 'README.txt'), 'Original tracked Story\n')
    git(repository, 'init', '-q'); git(repository, 'config', 'user.name', 'Author')
    git(repository, 'config', 'user.email', 'author@example.test')
    git(repository, 'add', '.'); git(repository, 'commit', '-qm', 'Original Story')
    const sha = git(repository, 'rev-parse', 'HEAD')
    const cli = join(root, 'noveltea')
    writeFileSync(cli, '#!/bin/sh\nprintf "1.0.0\\n"\n')
    chmodSync(cli, 0o755)
    Object.assign(process.env, { NT_STATE_DIR: state, NT_GIT_CACHE_DIR: cache,
      NT_NATIVE_CLI: cli, NT_STUDIO_KNOWN_VERIFIER_FIXES: JSON.stringify([fix]) })
    store = openStudioDatabase(join(root, 'studio.sqlite'))
    await migrateStudio(store, config)
    const seed = studioSeed(store)
    const repositoryId = randomUUID(), storyId = randomUUID()
    await seed.user(owner)
    await seed.repository({ id: repositoryId, ownerUserId: owner, provider: 'github',
      providerRepositoryId: providerId, name: 'Test Story', createdAt: now })
    await seed.story({ id: storyId, ownerUserId: owner, repositoryId,
      directory: 'story', title: 'Test Story', sourceCommitSha: sha, createdAt: now })
    const createStop = async (status: 'blocked' | 'paused' | 'cancelled',
      signature: string, checkVersion = 1, prepareGraph = true) => {
      const id = randomUUID()
      const job = await startStoryJob({ story, job: id, worktreeCacheRoot: scoped })
      const threadId = job.threadId + ':generation:web'
      const authorThreadId = randomUUID()
      const task = 'Make an original mystery'
      const plan = planWholeStory(task, contract, sha, id)
      writeFileSync(join(job.stateDir, 'turn-plan.json'), JSON.stringify(plan))
      const request = { story, job: id, task, contract, fixture: false,
        provider: 'openai', model: 'gpt-6-luna',
        turnPlanDigest: plan.digest, orchestrationPolicy: 'explicit' as const }
      const sessionDir = join(job.stateDir, 'adaptive-planning-sessions')
      const protocolDir = join(job.stateDir, 'adaptive-protocol')
      mkdirSync(sessionDir); mkdirSync(protocolDir)
      const file = join(sessionDir, 'initial.jsonl'), piId = 'sealed-session'
      const assistant = (text: string) => JSON.stringify({ type: 'message', message: {
        role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }],
      } })
      const correction = JSON.stringify({ type: 'message', message: {
        role: 'user', content: [{ type: 'text', text: 'Repair the original verifier result' }],
      } })
      const prefix = [JSON.stringify({ type: 'session', id: piId }),
        assistant('old format')].join('\n') + '\n'
      // The synthetic original verifier rejected this final response; the
      // deployed fix admits it without modifying any transcript bytes.
      const valid = JSON.stringify({ sourceSha: sha, turnDigest: plan.digest,
        beforeVersion: 1, reason: 'Original approved order',
        actions: [], order: [] })
      writeFileSync(file, prefix + [correction, assistant('second invalid'),
        correction, assistant(valid)].join('\n') + '\n')
      const invocationId = hash('adaptive-plan.v1\0' + piId + '\0' + file)
      writeFileSync(join(protocolDir, signature + '.started.json'), JSON.stringify({
        version: 1, contract: 'adaptive-plan.v1', sourceDigest: signature,
        invocationId, sessionId: piId, sessionFile: file, freshInvocationAllowance: 1,
        transcriptBytesBeforePrompt: Buffer.byteLength(prefix),
        transcriptSha256BeforePrompt: hash(prefix),
      }))
      writeFileSync(join(protocolDir, signature + '.initial.json'), JSON.stringify({
        version: 1, contract: 'adaptive-plan.v1', sourceDigest: signature,
        invocationId, sessionId: piId, sessionFile: file,
        status: 'protocol-exhausted', attempts: 3, responseOrdinal: 3,
        responseHash: hash(valid), failedPaths: ['$.previousVerifier'],
      }))
      const recovery = {
        operation: 'adaptive-planner', failedPhase: 'completed-response',
        check: 'adaptive-plan.v1', checkVersion, action: 'correct-original-response',
        phase: 'protocol-exhausted', jobId: id, threadId: job.threadId,
        turnDigest: plan.digest, planVersion: 1, sourceSha: sha, signature,
        proof: { file, id: piId, bytes: Buffer.byteLength(prefix), sha256: hash(prefix) },
      }
      await seed.job({ id, ownerUserId: owner, storyId, title: 'Original Stop',
        sourceCommitSha: sha, status, createdAt: now, updatedAt: now,
        generationRequestJson: JSON.stringify(request), generationThreadId: threadId,
        generationConfigJson: JSON.stringify({ model: { provider: 'openai', id: 'gpt-6-luna' } }) })
      await seed.thread({ id: authorThreadId, storyId, ownerUserId: owner,
        title: 'Original Thread', activityAt: now, createdAt: now })
      await seed.threadRun({ jobId: id, ownerUserId: owner, threadId: authorThreadId, runOrder: 0 })
      await seed.queue({ jobId: id, ownerUserId: owner, intent: 'start',
        phase: 'finished', createdAt: now, updatedAt: now })
      await store!.testing.records.insert('generation_verifier_stops', {
        jobId: id, ownerUserId: owner, threadId,
        checkId: 'adaptive-plan.v1', checkVersion, failureSignature: signature,
        sourceSha: sha, turnDigest: plan.digest, attemptedFixesJson: '[]',
      })
      if (prepareGraph) {
        await claimServerGeneration(job, threadId, request)
        const saved = openWebGenerationGraph(join(job.stateDir, 'web-generation.sqlite'))
        try {
          await saved.graph.updateState({ configurable: { thread_id: threadId } }, {
            request, status: 'blocked', recovery, graphThreadId: threadId,
            planVersion: 1, orchestratorOrder: ['foundation', 'architecture'],
            orchestratorSnapshotId: hash('snapshot'),
            orchestratorPlanningDigest: hash('planner'), active: null, result: null,
            // At a failed first planner attempt there is often no persisted
            // inventory; source identity comes from authenticated HEAD/proof.
            inventory: null,
          }, 'completion_decision')
        } finally { saved.saver.db.close() }
      }
      return { id, job, threadId }
    }
    const eligible = await createStop('blocked', 'a'.repeat(64))
    const paused = await createStop('paused', 'b'.repeat(64))
    const cancelled = await createStop('cancelled', 'c'.repeat(64))
    const unrelated = await createStop('blocked', 'd'.repeat(64), 2)
    const damaged = await createStop('blocked', 'e'.repeat(64), 1, false)
    const tampered = await createStop('blocked', 'f'.repeat(64))
    writeFileSync(join(tampered.job.stateDir, 'adaptive-planning-sessions', 'initial.jsonl'),
      '{"type":"session","id":"altered"}\n')
    const candidates = await store.persistence.generation.queue.matchingVerifierStops(fix)
    assert.equal(candidates.length, 3, 'all exact-check stops are indexed before proof validation')
    const row = await selectedJob(store, owner, eligible.id)
    const recovered = await restoreJob(row, owner)
    const pinned = pinnedRequest(row, recovered)
    assert.ok(pinned)
    await verifyKnownFixProof(recovered, pinned, candidates.find(v => v.jobId === eligible.id)!)
    const n = await pickupKnownVerifierFixes(store)
    assert.equal(n, 1, 'only the valid original verifier/Turn is queued')
    const q = store.persistence.generation.queue
    assert.equal((await q.record(eligible.id))?.phase, 'queued')
    assert.equal((await q.record(eligible.id))?.fixId, fix.id)
    assert.equal((await store.persistence.generation.jobs.state(owner, eligible.id))?.status, 'paused')
    for (const [row, status] of [[paused, 'paused'], [cancelled, 'cancelled'],
      [unrelated, 'blocked'], [damaged, 'blocked'], [tampered, 'blocked']] as const) {
      assert.equal((await q.record(row.id))?.phase, 'finished')
      assert.equal((await store.persistence.generation.jobs.state(owner, row.id))?.status, status)
    }
    assert.equal(await pickupKnownVerifierFixes(store), 0,
      'duplicate startup never allocates another queue record')
    assert.equal(git(eligible.job.worktreeRoot, 'rev-parse', 'HEAD'), sha,
      'recheck admission must not write Story content')
  } finally {
    if (store) await store.close()
    for (const key of keys) {
      if (old[key] === undefined) delete process.env[key]
      else process.env[key] = old[key]
    }
    rmSync(root, { recursive: true, force: true })
  }
})
