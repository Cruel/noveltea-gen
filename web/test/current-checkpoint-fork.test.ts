import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHmac, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { removeTestTree } from '../../test/helpers'
import { openStudioDatabase, migrateStudio } from './support/studio-database'
import { studioSeed } from './support/studio-seed'
import { createStudioAuth } from '../src/lib/auth'
import { acquireCachedStory } from '../src/lib/git-cache.server'
import { checkpointContinueRequest, checkpointForkRequest } from '../src/lib/checkpoint-fork.server'
import { ensureRootThreads } from '../src/lib/threads.server'
import { authorizedStoryJob, generationJobRequest, pinnedRequest, selectedJob } from '../src/lib/fixture-jobs.server'
import { openWebGenerationGraph } from '../../src/web-fixture-runtime'
import { collectRecoveryFork } from '../../src/recovery-fork'
import { inspectRecoveryCheckpoints } from '../../src/recovery-checkpoints'
import { scriptedModel, scriptedStoryRuntime, fixtureSandboxClient } from '../../test/c03-scripted-story-helpers'
import { archiveStages } from '../../test/support/scripted-archive-stages'
import { withJobModelRuntime } from '../../src/model-runtime'
import { planWholeStory } from '../src/lib/turn-plan'
import { saveJobTurnPlan, readJobTurnPlan } from '../src/lib/turn-plan-receipt.server'
import { installScriptedArchiveProvider } from './support/scripted-archive-provider'
import { userPiCredentials } from '../src/lib/pi-credentials.server'
import { readRecoveryFork } from '../../src/recovery-fork-state'
import { verifyCertifiedRecoveryLineage } from '../../src/certification-lineage'
import { readThreadChat } from '../src/lib/thread-chat.server'
import { generationConfigurationRequest } from '../src/lib/generation-config.server'
import { startStoryJob } from '../../src/job'

const skills = resolve(process.env.NT_SKILLS_CHECKOUT ?? resolve(import.meta.dirname, '../../../noveltea-skills'))
const config = { baseURL: 'http://localhost:3000', secret: 'current-fork-secret-0123456789abcdefghijklmnopqrstuvwxyz',
  github: { clientId: 'test', clientSecret: 'test' }, gitlab: { clientId: 'test', clientSecret: 'test' } }
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
test('authenticated recovery forks retain verified work through Composition and same-Thread continuation', {
  skip: !existsSync(join(skills, 'skills')), timeout: 240_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-current-fork-'))
  const env = { NT_STATE_DIR: join(root, 'state'), NT_GIT_CACHE_DIR: join(root, 'cache'),
    NT_SKILL_CACHE_DIR: join(root, 'skills'), NT_CONFIG_FILE: join(root, 'config.json'),
    NT_STUDIO_SKILLS_SOURCE: skills, NT_REQUIRE_USER_PI_RUNTIME: '1',
    NT_PI_CREDENTIAL_KEY: Buffer.alloc(32, 20).toString('base64'), PI_OFFLINE: '1',
    NT_AGENT_RPC_URL: 'http://127.0.0.1:1', NT_AGENT_RPC_TOKEN: 'fork-test-not-used-for-network' }
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  Object.assign(process.env, env)
  writeFileSync(env.NT_CONFIG_FILE, JSON.stringify({ novelteaSkills: skills, skillDiscovery: 'explicit-only' }))
  const store = openStudioDatabase(join(root, 'studio.sqlite'))
  let restoreProvider: (() => void) | undefined
  let restoreSandbox: (() => void) | undefined
  try {
    await migrateStudio(store, config)
    const auth = createStudioAuth(store, config), ctx = await auth.$context
    const user = await ctx.internalAdapter.createUser({ name: 'Author', email: 'current-fork@example.test', emailVerified: true }, { method: 'test' })
    const session = await ctx.internalAdapter.createSession(user.id)
    const cookie = 'better-auth.session_token=' + session.token + '.' + createHmac('sha256', config.secret).update(session.token).digest('base64')
    const repo = join(root, 'remote'), storyId = randomUUID(), parentId = randomUUID(), childId = randomUUID(), repoId = randomUUID()
    mkdirSync(join(repo, 'story'), { recursive: true }); writeFileSync(join(repo, 'story', '.gitkeep'), '')
    git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Author'); git(repo, 'config', 'user.email', 'author@example.test')
    git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'Initial Story')
    const initial = git(repo, 'rev-parse', 'HEAD')
    let parent = await acquireCachedStory({ cacheDirectory: env.NT_GIT_CACHE_DIR, ownerId: user.id,
      repositoryId: 'github:123', remoteUrl: 'file://' + repo, token: '', directory: 'story', commit: initial, jobId: parentId })
    const seed = studioSeed(store)
    await seed.repository({ id: repoId, ownerUserId: user.id, provider: 'github', providerRepositoryId: '123', name: 'Fork', createdAt: 'now' })
    await seed.story({ id: storyId, ownerUserId: user.id, repositoryId: repoId, directory: 'story',
      title: 'Archive', createdAt: 'now', sourceCommitSha: initial })
    const task = 'A missing archive witness; invent unspecified details'
    const contract = { scope: { kind: 'full-story' as const, depth: 'composition' as const, targets: [], branches: [] },
      constraints: [], envelope: { presentation: 'Visual novel', hardLimits: [], preferences: [] } }
    const turn = planWholeStory(task, contract, initial)
    await saveJobTurnPlan(parent, turn)
    const model = { provider: scriptedModel.provider, id: scriptedModel.id }
    const request = { story: parent.storyRoot, job: parentId, task, contract, fixture: false,
      skillsSource: skills, orchestrationPolicy: 'explicit' as const, turnPlanDigest: turn.digest, provider: model.provider, model: model.id }
    await seed.job({ id: parentId, ownerUserId: user.id, storyId, title: 'Archive', sourceCommitSha: initial,
      status: 'running', createdAt: 'now', updatedAt: 'now', generationRequestJson: JSON.stringify(request),
      generationThreadId: parent.threadId + ':generation:web',
      generationConfigJson: JSON.stringify({ version: 1, headSha: initial, task, contract, limits: { steps: 100 }, model }) })
    await ensureRootThreads(store, user.id, storyId)
    const provider = await installScriptedArchiveProvider(parent, turn)
    restoreProvider = provider.restore
    await userPiCredentials(store, user.id).modify(model.provider, async () => ({ type: 'api_key', key: 'in-process-only' }))
    restoreSandbox = fixtureSandboxClient(parent.jobId, parent.worktreeStoryRoot)
    const runtime = await scriptedStoryRuntime(archiveStages(parent, turn))
    const graph = openWebGenerationGraph(join(parent.stateDir, 'web-generation.sqlite'))
    try {
      const result = await withJobModelRuntime(runtime.runtime, () => graph.graph.invoke({ request, pauseAfter: 'foundations' },
        { configurable: { thread_id: parent.threadId + ':generation:web' }, recursionLimit: 1000 }))
      assert.equal(result.status, 'paused', result.reason ?? '')
    } finally { graph.saver.db.close() }
    parent = await startStoryJob({ story: parent.storyRoot, job: parentId }, false)
    const world = (await inspectRecoveryCheckpoints(parent)).find(p => p.eligible && p.workItem === 'world-foundations')!
    assert.equal(world.semanticReview, 'passed')
    writeFileSync(join(parent.worktreeStoryRoot, 'uncommitted.md'), 'Retain parent bytes.')
    const parentHead = parent.headSha
    const parentDB = readFileSync(join(parent.stateDir, 'web-generation.sqlite'))
    const input = { childId, commitSha: world.commitSha, sourceBaseSha: initial, sourceThreadId: 'root:' + parentId,
      proofDigest: world.proofDigest, guidance: 'Focus on the witness; preserve existing Character IDs.' }
    const forkRequest = (data: unknown, authCookie = cookie) => checkpointForkRequest(auth, store,
      new Request(config.baseURL + '/fork', {
        method: 'POST', headers: { origin: config.baseURL, ...(authCookie ? { cookie: authCookie } : {}), 'content-type': 'application/json' },
        body: JSON.stringify(data),
      }), parentId, config.baseURL)
    const countForks = () => store.testing.records.count('checkpoint_forks')
    assert.equal((await forkRequest(input, '')).status, 401)
    for (const mutation of [{ sourceBaseSha: world.commitSha }, { sourceThreadId: 'root:invalid' },
      { proofDigest: 'a'.repeat(64) }, { commitSha: initial }])
      assert.equal((await forkRequest({ ...input, ...mutation })).status, 409)
    const checkpointPath = join(parent.stateDir, 'recovery-checkpoints', world.commitSha + '.json')
    const checkpointBytes = readFileSync(checkpointPath, 'utf8')
    try {
      const forged = JSON.parse(checkpointBytes)
      forged.completedWorkItems.push('event-fabricated')
      writeFileSync(checkpointPath, JSON.stringify(forged))
      assert.equal((await forkRequest(input)).status, 409)
      const obsolete = JSON.parse(checkpointBytes)
      obsolete.compatibility.graphSchema = 'noveltea-generation/v0'
      writeFileSync(checkpointPath, JSON.stringify(obsolete))
      const historical = (await inspectRecoveryCheckpoints(parent)).find(p => p.commitSha === world.commitSha)
      assert.ok(historical && !historical.eligible)
      assert.equal((await forkRequest(input)).status, 409)
    } finally { writeFileSync(checkpointPath, checkpointBytes) }
    const worldPath = join(parent.stateDir, 'character-world.json')
    const worldBytes = readFileSync(worldPath, 'utf8')
    try {
      writeFileSync(worldPath, JSON.stringify({ ...JSON.parse(worldBytes), version: 0 }))
      assert.equal((await forkRequest(input)).status, 409)
    } finally { writeFileSync(worldPath, worldBytes) }
    const stranger = await ctx.internalAdapter.createUser({ name: 'Other', email: 'current-fork-other@example.test', emailVerified: true }, { method: 'test' })
    const strangerSession = await ctx.internalAdapter.createSession(stranger.id)
    const strangerCookie = 'better-auth.session_token=' + strangerSession.token + '.' + createHmac('sha256', config.secret).update(strangerSession.token).digest('base64')
    assert.equal((await forkRequest(input, strangerCookie)).status, 404)
    assert.equal(await countForks(), 0)
    const native = process.env.NT_NATIVE_CLI
    process.env.NT_STUDIO_SKILLS_SOURCE = join(root, 'missing-skills')
    try {
      const missing = await forkRequest(input)
      assert.equal(missing.status, 409)
      assert.equal((await missing.json() as { code?: string }).code, 'missing-tooling')
    } finally { process.env.NT_STUDIO_SKILLS_SOURCE = skills }
    process.env.NT_NATIVE_CLI = join(root, 'missing-validator')
    try { assert.equal((await forkRequest(input)).status, 409) }
    finally {
      if (native === undefined) delete process.env.NT_NATIVE_CLI
      else process.env.NT_NATIVE_CLI = native
    }
    assert.equal(await countForks(), 0)
    const fork = await checkpointForkRequest(auth, store, new Request(config.baseURL + '/fork', {
      method: 'POST', headers: { origin: config.baseURL, cookie, 'content-type': 'application/json' }, body: JSON.stringify(input),
    }), parentId, config.baseURL)
    assert.equal(fork.status, 200, JSON.stringify(await fork.clone().json()))
    const child = await authorizedStoryJob(store, user.id, childId)
    const childTurn = await readJobTurnPlan(child)
    assert.ok(childTurn)
    assert.equal(childTurn.source.verifiedSha, world.commitSha)
    assert.notEqual(childTurn.digest, turn.digest)
    assert.equal(git(child.worktreeRoot, 'status', '--porcelain'), '')
    assert.equal(existsSync(join(child.worktreeStoryRoot, 'characters/ada.md')), false)
    assert.equal((await forkRequest(input)).status, 200)
    assert.equal((await forkRequest({ ...input, guidance: 'Changed after submission' })).status, 409)
    const lineage = await verifyCertifiedRecoveryLineage(parent, child)
    assert.equal(lineage?.originalJobId, parentId)
    assert.equal(lineage?.terminalJobId, childId)
    const bundlePath = join(child.stateDir, 'recovery-fork.json')
    const bundleBytes = readFileSync(bundlePath, 'utf8')
    try {
      const forged = JSON.parse(bundleBytes)
      forged.completedStages.push({ stage: 'event', milestone: 'milestone.fabricated', status: 'committed', headSha: world.commitSha })
      writeFileSync(bundlePath, JSON.stringify(forged))
      assert.throws(() => readRecoveryFork(child), /immutable job pin/)
    } finally { writeFileSync(bundlePath, bundleBytes) }
    const childRow = await selectedJob(store, user.id, childId)
    const draft = JSON.parse(childRow.configJson!)
    const configRequest = (data: unknown) => generationConfigurationRequest(auth, store,
      new Request(config.baseURL + '/jobs/' + childId, {
        method: 'PUT', headers: { origin: config.baseURL, cookie, 'content-type': 'application/json' },
        body: JSON.stringify(data),
      }), childId, config.baseURL)
    assert.equal((await configRequest({ ...draft, task: 'Changed objective' })).status, 409)
    assert.equal((await configRequest({ ...draft, contract: { ...draft.contract, constraints: ['Unapproved replacement'] } })).status, 409)
    const budget = await configRequest({ ...draft, limits: { steps: 90 } })
    assert.equal(budget.status, 200, JSON.stringify(await budget.clone().json()))
    const start = await generationJobRequest(auth, store, new Request(config.baseURL + '/jobs/' + childId, {
      method: 'POST', headers: { origin: config.baseURL, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ task: draft.task, contract: draft.contract }),
    }), childId, config.baseURL)
    assert.equal(start.status, 202, JSON.stringify(await start.clone().json()))
    const childRequest = pinnedRequest(await selectedJob(store, user.id, childId), child)!
    assert.equal(childRequest.turnPlanDigest, childTurn.digest)
    restoreSandbox()
    restoreSandbox = fixtureSandboxClient(child.jobId, child.worktreeStoryRoot)
    const childRuntime = await scriptedStoryRuntime(archiveStages(child, childTurn))
    const next = openWebGenerationGraph(join(child.stateDir, 'web-generation.sqlite'))
    try {
      const result = await withJobModelRuntime(childRuntime.runtime, () => next.graph.invoke({ request: childRequest, pauseAfter: 'foundations' },
        { configurable: { thread_id: child.threadId + ':generation:web' }, recursionLimit: 1000 }))
      assert.equal(result.status, 'paused', result.reason ?? '')
    } finally { next.saver.db.close() }
    const checkpoints = await inspectRecoveryCheckpoints(child)
    const character = checkpoints.find(p => p.eligible && p.workItem === 'character-foundations')!
    assert.equal(character.parentSha, world.commitSha)
    assert.equal(character.assurance?.turnDigest, childTurn.digest)
    assert.equal(character.semanticReview, 'passed')
    const grandchild = await collectRecoveryFork(child, randomUUID(), character.commitSha, childTurn.contract, skills)
    assert.equal(grandchild.reviewTurn?.digest, childTurn.digest)
    assert.equal(grandchild.checkpoint.assurance?.turnDigest, childTurn.digest)
    assert.equal(grandchild.commits['world-foundations']?.sha, world.commitSha)
    const grandId = randomUUID()
    const forkGrand = await checkpointForkRequest(auth, store, new Request(config.baseURL + '/fork', {
      method: 'POST', headers: { origin: config.baseURL, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ childId: grandId, commitSha: character.commitSha, sourceBaseSha: child.baseSha,
        sourceThreadId: 'fork:' + childId, proofDigest: character.proofDigest, guidance: '' }),
    }), childId, config.baseURL)
    assert.equal(forkGrand.status, 200, JSON.stringify(await forkGrand.clone().json()))
    const grand = await authorizedStoryJob(store, user.id, grandId)
    const grandTurn = (await readJobTurnPlan(grand))!
    const grandDraft = JSON.parse((await selectedJob(store, user.id, grandId)).configJson!)
    const grandStart = await generationJobRequest(auth, store, new Request(config.baseURL + '/jobs/' + grandId, {
      method: 'POST', headers: { origin: config.baseURL, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ task: grandDraft.task, contract: grandDraft.contract }),
    }), grandId, config.baseURL)
    assert.equal(grandStart.status, 202, JSON.stringify(await grandStart.clone().json()))
    const grandRequest = pinnedRequest(await selectedJob(store, user.id, grandId), grand)!
    assert.equal(grandRequest.turnPlanDigest, grandTurn.digest)
    restoreSandbox()
    restoreSandbox = fixtureSandboxClient(grand.jobId, grand.worktreeStoryRoot)
    const grandRuntime = await scriptedStoryRuntime(archiveStages(grand, grandTurn))
    const grandGraph = openWebGenerationGraph(join(grand.stateDir, 'web-generation.sqlite'))
    try {
      const result = await withJobModelRuntime(grandRuntime.runtime, () => grandGraph.graph.invoke({ request: grandRequest, pauseAfter: 'event' },
        { configurable: { thread_id: grand.threadId + ':generation:web' }, recursionLimit: 1000 }))
      assert.equal(result.status, 'paused', result.reason ?? '')
    } finally { grandGraph.saver.db.close() }
    const event = (await inspectRecoveryCheckpoints(grand)).find(p => p.eligible && p.workItem === 'event-disclosure')
    assert.ok(event)
    assert.equal(event.parentSha, character.commitSha)
    assert.equal(event.assurance?.turnDigest, grandTurn.digest)
    assert.doesNotMatch(git(grand.worktreeRoot, 'log', '--format=%B', character.commitSha + '..HEAD'), /NovelTea-Work-Item: (world-foundations|character-foundations)/)
    const runFork = async (sourceJob: typeof parent, point: typeof world,
      stage: 'interactive' | 'composition', expected: string) => {
      const id = randomUUID()
      const response = await checkpointForkRequest(auth, store, new Request(config.baseURL + '/fork', {
        method: 'POST', headers: { origin: config.baseURL, cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ childId: id, commitSha: point.commitSha, sourceBaseSha: sourceJob.baseSha,
          sourceThreadId: 'fork:' + sourceJob.jobId, proofDigest: point.proofDigest, guidance: '' }),
      }), sourceJob.jobId, config.baseURL)
      assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
      const job = await authorizedStoryJob(store, user.id, id)
      const turn = (await readJobTurnPlan(job))!
      const draft = JSON.parse((await selectedJob(store, user.id, id)).configJson!)
      const admission = await generationJobRequest(auth, store, new Request(config.baseURL + '/jobs/' + id, {
        method: 'POST', headers: { origin: config.baseURL, cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ task: draft.task, contract: draft.contract }),
      }), id, config.baseURL)
      assert.equal(admission.status, 202, JSON.stringify(await admission.clone().json()))
      const request = pinnedRequest(await selectedJob(store, user.id, id), job)!
      restoreSandbox?.()
      restoreSandbox = fixtureSandboxClient(job.jobId, job.worktreeStoryRoot)
      const runtime = await scriptedStoryRuntime(archiveStages(job, turn))
      const graph = openWebGenerationGraph(join(job.stateDir, 'web-generation.sqlite'))
      try {
        const cfg = { configurable: { thread_id: job.threadId + ':generation:web' }, recursionLimit: 1000 }
        // A separate Event-only milestone may settle first without a commit.
        // Resume only the same current Turn until the selected successor has
        // published a genuine checkpoint (bounded by the two milestones).
        for (let boundary = 0; boundary < 3; boundary++) {
          const result = await withJobModelRuntime(runtime.runtime, () => graph.graph.invoke({ request, pauseAfter: stage }, cfg))
          assert.equal(result.status, 'paused', JSON.stringify({ reason: result.reason, active: result.active, recovery: result.recoveryLifecycle }))
          assert.equal(result.reason, 'Requested safe-boundary pause')
          if ((await inspectRecoveryCheckpoints(job)).some(p => p.eligible && p.workItem === expected)) break
          assert.ok(boundary < 2, JSON.stringify(result.completedStages))
        }
      } finally { graph.saver.db.close() }
      return { job, turn, points: await inspectRecoveryCheckpoints(job),
        commits: git(job.worktreeRoot, 'log', '--format=%B', point.commitSha + '..HEAD') }
    }
    const fourth = await runFork(grand, event, 'interactive', 'interactive-puzzle-disclosure')
    const choice = fourth.points.find(p => p.eligible && p.workItem === 'interactive-choice-disclosure')!
    const puzzle = fourth.points.find(p => p.eligible && p.workItem === 'interactive-puzzle-disclosure')!
    assert.ok(choice && puzzle)
    assert.doesNotMatch(fourth.commits, /NovelTea-Work-Item: (event-disclosure|world-foundations|character-foundations)/)
    const fifth = await runFork(fourth.job, choice, 'interactive', 'interactive-puzzle-disclosure')
    assert.match(fifth.commits, /NovelTea-Work-Item: interactive-puzzle-disclosure/, JSON.stringify({ choice: choice.completedWorkItems, source: readRecoveryFork(fifth.job)?.completedStages, receipt: JSON.parse(readFileSync(join(fifth.job.stateDir, 'interactive-items/disclosure.json'), 'utf8')).units.map((u: any) => ({ id: u.id, phase: u.phase, commitSha: u.commitSha, noWrite: u.noWrite })) }))
    assert.doesNotMatch(fifth.commits, /NovelTea-Work-Item: interactive-choice-disclosure/)
    const sixth = await runFork(fourth.job, puzzle, 'composition', 'composition-disclosure')
    assert.match(sixth.commits, /NovelTea-Work-Item: composition-/)
    assert.doesNotMatch(sixth.commits, /NovelTea-Work-Item: (interactive-choice-disclosure|interactive-puzzle-disclosure|event-disclosure|world-foundations|character-foundations)/)
    assert.equal(git(child.worktreeRoot, 'rev-list', '--count', world.commitSha + '..HEAD'), '1')
    assert.equal(git(parent.worktreeRoot, 'rev-parse', 'HEAD'), parentHead)
    assert.equal(readFileSync(join(parent.worktreeStoryRoot, 'uncommitted.md'), 'utf8'), 'Retain parent bytes.')
    assert.deepEqual(readFileSync(join(parent.stateDir, 'web-generation.sqlite')), parentDB)
    await store.testing.records.update('studio_sessions', { id: parentId }, { status: 'blocked' })
    await store.testing.records.insert('generation_run_queue', { jobId: parentId, ownerUserId: user.id,
      intent: 'start', phase: 'finished', createdAt: 'now', updatedAt: 'now' })
    const continuationId = randomUUID()
    const continuation = { ...input, childId: continuationId, guidance: 'Continue the original Character assignment' }
    const continueRequest = (body: unknown) => checkpointContinueRequest(auth, store,
      new Request(config.baseURL + '/continue', { method: 'POST',
        headers: { origin: config.baseURL, cookie, 'content-type': 'application/json' },
        body: JSON.stringify(body) }), parentId, config.baseURL)
    assert.equal((await continueRequest({ ...continuation, expectedLatestJobId: randomUUID() })).status, 409)
    assert.equal(await store.persistence.advancedThreads.jobClaimed(continuationId), false)
    // Credentials are not inherited with the fork. Failed provider admission
    // leaves a retryable prepared run without creating a queue entry.
    const credentials = userPiCredentials(store, user.id)
    await credentials.delete(model.provider)
    try {
      const prepared = await continueRequest(continuation)
      const receipt = await prepared.json() as { id: string; started: boolean; warning?: string }
      assert.equal(prepared.status, 202, JSON.stringify(receipt))
      assert.equal(receipt.id, continuationId)
      assert.equal(receipt.started, false)
      assert.ok(receipt.warning)
      assert.equal(await store.persistence.generation.queue.record(continuationId), null)
    } finally {
      await credentials.modify(model.provider, async () => ({ type: 'api_key', key: 'in-process-only' }))
    }
    const continued = await continueRequest(continuation)
    const body = await continued.json() as { id: string; started: boolean; warning?: string }
    assert.equal(continued.status, 202, JSON.stringify(body))
    assert.equal(body.started, true, body.warning)
    assert.equal(body.id, continuationId)
    assert.equal(await store.persistence.advancedThreads.runOrder(user.id, 'root:' + parentId, continuationId), 1)
    assert.equal(await store.persistence.advancedThreads.identity(user.id, 'fork:' + continuationId), null)
    assert.equal((await store.persistence.generation.queue.record(continuationId))?.phase, 'queued')
    assert.equal((await continueRequest(continuation)).status, 202)
    assert.equal(await store.persistence.advancedThreads.runOrder(user.id, 'root:' + parentId, continuationId), 1)
    const sourceThreadId = 'root:' + parentId
    const guidanceId = 'guidance:fork:' + continuationId
    const guidance = await store.testing.records.first<{ body: string }>('story_thread_messages', { id: guidanceId })
    assert.equal(guidance?.body, continuation.guidance)
    await store.testing.records.update('studio_sessions', { id: continuationId }, { status: 'blocked' })
    await store.testing.records.update('generation_run_queue', { jobId: continuationId }, { phase: 'finished' })
    await store.testing.records.update('story_thread_messages', { id: guidanceId }, { phase: 'blocked' })
    const repairedId = randomUUID()
    const repaired = await continueRequest({ ...continuation, childId: repairedId, expectedLatestJobId: continuationId })
    const repairedBody = await repaired.json() as { started?: boolean; warning?: string }
    assert.equal(repaired.status, 202, JSON.stringify(repairedBody))
    assert.equal(repairedBody.started, true, repairedBody.warning)
    assert.equal(await store.persistence.advancedThreads.runOrder(user.id, sourceThreadId, repairedId), 2)
    assert.equal(await store.testing.records.first('story_thread_messages', { id: 'guidance:fork:' + repairedId }), undefined)
    const chat = await readThreadChat(store, user.id, sourceThreadId)
    assert.ok(!chat.messages.some(message => message.id === 'initial:' + repairedId))
    await store.testing.records.insert('story_thread_messages', {
      id: 'initial:' + repairedId, ownerUserId: user.id, threadId: sourceThreadId,
      sequence: Math.max(...chat.messages.map(item => item.sequence)) + 1,
      role: 'user', status: 'delivered', phase: 'finished',
      body: 'Original request\n\nCorrective guidance for this continuation:\nRepeated text',
      jobId: repairedId, createdAt: '2026-01-01',
    })
    const reopened = await readThreadChat(store, user.id, sourceThreadId)
    assert.deepEqual(reopened.messages.map(item => item.id), chat.messages.map(item => item.id))
    assert.deepEqual(reopened.turnReceipts, chat.turnReceipts)
    await store.testing.records.insert('story_thread_messages', {
      id: randomUUID(), ownerUserId: user.id, threadId: sourceThreadId,
      sequence: Math.max(...chat.messages.map(item => item.sequence)) + 2,
      role: 'user', status: 'delivered', phase: 'finished',
      body: 'Later Turn intent must not enter an older checkpoint',
      jobId: repairedId, verifiedCommitSha: world.commitSha, createdAt: '2026-01-02',
    })
    await store.testing.records.update('studio_sessions', { id: repairedId }, { status: 'blocked' })
    await store.testing.records.update('generation_run_queue', { jobId: repairedId }, { phase: 'finished' })
    await store.testing.records.update('story_thread_messages', { id: guidanceId }, { phase: 'blocked' })
    await store.testing.records.insert('generation_events', {
      jobId: repairedId, ownerUserId: user.id, kind: 'verified', stage: 'event',
      filesJson: '["story/events/example.md"]', createdAt: '2026-01-03',
    })
    assert.equal((await continueRequest({ ...continuation, childId: randomUUID(), expectedLatestJobId: repairedId })).status, 409)
    const olderId = randomUUID()
    assert.equal((await forkRequest({ ...input, childId: olderId })).status, 200)
    const olderChat = await readThreadChat(store, user.id, 'fork:' + olderId)
    assert.ok(!olderChat.messages.some(item => item.content === 'Later Turn intent must not enter an older checkpoint'))
    assert.equal((await store.persistence.advancedThreads.run(user.id, sourceThreadId, 'last'))?.jobId, repairedId)

  } finally {
    restoreSandbox?.(); restoreProvider?.(); await store.close()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    removeTestTree(root)
  }
})
