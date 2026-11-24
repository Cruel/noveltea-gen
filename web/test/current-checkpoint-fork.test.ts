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
import { checkpointForkRequest } from '../src/lib/checkpoint-fork.server'
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
import { startStoryJob } from '../../src/job'

const skills = resolve(process.env.NT_SKILLS_CHECKOUT ?? resolve(import.meta.dirname, '../../../noveltea-skills'))
const config = { baseURL: 'http://localhost:3000', secret: 'current-fork-secret-0123456789abcdefghijklmnopqrstuvwxyz',
  github: { clientId: 'test', clientSecret: 'test' }, gitlab: { clientId: 'test', clientSecret: 'test' } }
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
test('verified current World checkpoint forks into a new authenticated Turn and authors Character only', {
  skip: !existsSync(join(skills, 'src/cli.ts')), timeout: 120_000,
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
    const childRow = await selectedJob(store, user.id, childId)
    const draft = JSON.parse(childRow.configJson!)
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
    assert.equal(git(child.worktreeRoot, 'rev-list', '--count', world.commitSha + '..HEAD'), '1')
    assert.equal(git(parent.worktreeRoot, 'rev-parse', 'HEAD'), parentHead)
    assert.equal(readFileSync(join(parent.worktreeStoryRoot, 'uncommitted.md'), 'utf8'), 'Retain parent bytes.')
    assert.deepEqual(readFileSync(join(parent.stateDir, 'web-generation.sqlite')), parentDB)
  } finally {
    restoreSandbox?.(); restoreProvider?.(); await store.close()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    removeTestTree(root)
  }
})
