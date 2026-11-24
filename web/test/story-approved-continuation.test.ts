import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { hostname } from 'node:os'
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { startStoryJob } from '../../src/job'
import { renderFoundation } from '../../src/foundation-record'
import { createSkillSnapshot } from '../../src/snapshot'
import { trustedHead } from '../../src/revision'
import { initialStoryDocument } from '../src/lib/git-cache.server'
import { nativeExecutable } from '../../src/validator'
import { removeTestTree } from '../../test/helpers'
import { createStudioAuth } from '../src/lib/auth'
import { continueApprovedStoryChat } from '../src/lib/story-approved-continuation.server'
import { availableUserPiModels, userPiCredentials } from '../src/lib/pi-credentials.server'
import { openStudioDatabase, migrateStudio } from './support/studio-database'
import { openStoryThread } from '../src/lib/story-threads.server'

const origin = 'http://localhost:3000'
const config = {
  baseURL: origin, secret: 'story-continuation-test-secret-012345678901234567890',
  github: { clientId: 'github', clientSecret: 'secret' },
  gitlab: { clientId: 'gitlab', clientSecret: 'secret' },
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

test('approved original Story Turn queues one owner-scoped execution, while foundation-only stops without a queue', {
  skip: !existsSync(nativeExecutable()), timeout: 150_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-approved-continuation-'))
  const previous = Object.fromEntries([
    'NT_STATE_DIR', 'NT_GIT_CACHE_DIR', 'NT_PI_CREDENTIAL_KEY',
    'NT_REQUIRE_USER_PI_RUNTIME', 'NT_AGENT_RPC_URL', 'NT_AGENT_RPC_TOKEN',
    'NT_STUDIO_SKILLS_SOURCE', 'NT_SKILL_CACHE_DIR', 'NT_CONFIG_FILE',
  ].map(name => [name, process.env[name]]))
  process.env.NT_STATE_DIR = join(root, 'state')
  process.env.NT_GIT_CACHE_DIR = join(root, 'cache')
  process.env.NT_PI_CREDENTIAL_KEY = randomBytes(32).toString('base64')
  process.env.NT_REQUIRE_USER_PI_RUNTIME = '1'
  process.env.NT_AGENT_RPC_URL = 'http://127.0.0.1:9999'
  process.env.NT_AGENT_RPC_TOKEN = 'controller-test-only'
  const db = openStudioDatabase(join(root, 'studio.sqlite'))
  try {
    await migrateStudio(db, config)
    const auth = createStudioAuth(db, config)
    const adapter = (await auth.$context).internalAdapter
    const owner = (await adapter.createUser({
      name: 'Author', email: 'author@continuation.test', emailVerified: true,
    }, { method: 'test' })).id
    const session = await adapter.createSession(owner)
    const headers = new Headers({
      cookie: 'better-auth.session_token=' + session.token + '.' +
        createHmac('sha256', config.secret).update(session.token).digest('base64'),
      origin,
    })
    const repoId = randomUUID(), storyId = randomUUID(), providerId = '42'
    const now = new Date().toISOString()
    await db.persistence.repositories.upsert(owner, 'github', providerId, 'Owner/Story',
      null, repoId, now)
    const cache = join(root, 'cache', hash(owner), hash('github:' + providerId))
    const repository = join(cache, 'base'), story = join(repository, 'story')
    mkdirSync(story, { recursive: true })
    const git = (...args: string[]) => execFileSync('git', args, {
      cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    git('init', '-q', '--initial-branch=main')
    git('config', 'user.name', 'Author')
    git('config', 'user.email', 'author@continuation.test')
    const foundation = {
      id: 'foundation', title: 'The Last Bell',
      premise: 'A lost bell is the key to a mystery',
      central_conflict: 'The village debates whether to reveal the truth',
      genre: 'Mystery', tone: 'Suspenseful',
      player_experience: 'Investigate witnesses and make consequential choices',
      scope: 'A coastal village',
      body: 'An approved Creative Direction with protected author decisions.',
      decisions: [{ id: 'author-brief', statement: 'Keep it a mystery',
        origin: 'user' as const, authority: 'user-protected' as const }],
    }
    mkdirSync(join(story, 'creative-direction'))
    writeFileSync(join(story, 'creative-direction', 'foundation.md'),
      renderFoundation(foundation))
    git('add', '.')
    git('commit', '-qm', 'Approved original author foundation')
    const sha = git('rev-parse', 'HEAD')
    await db.persistence.onboarding.importStory({
      id: storyId, owner, repositoryId: repoId, directory: 'story',
      title: 'The Last Bell', createdAt: now, commitSha: sha,
    })
    await userPiCredentials(db, owner).modify('openai',
      async () => ({ type: 'api_key', key: 'TEST-CONNECTION-NOT-A-REAL-PROVIDER-KEY' }))
    const model = (await availableUserPiModels(db, owner))
      .find(value => value.provider === 'openai')
    assert.ok(model, 'test user has an owner-scoped model catalog')

    const prepare = async (jobId: string, task: string) => {
      await db.persistence.naturalStory.beginFirstTurn(owner, storyId, jobId,
        task, new Date().toISOString(), 'autonomous')
      await db.persistence.naturalStory.finishFirstTurn(owner, storyId, jobId, false)
      await startStoryJob({ story, job: jobId, worktreeCacheRoot: cache })
      await db.persistence.generation.jobs.register(owner, jobId, storyId,
        'The Last Bell', sha, new Date().toISOString())
      await db.persistence.conversations.reconcileRoots(owner, storyId)
    }
    const proof = (draft: unknown) => ({
      owner, graphEpoch: 'a'.repeat(64), approvalOperation: 5,
      reviewedProposalDigest: 'b'.repeat(64), authorEvidenceDigest: 'd'.repeat(64),
      reviewDigest: 'e'.repeat(64), foundationDigest: hash(JSON.stringify(draft)),
      usageEvidenceDigest: 'f'.repeat(64), limits: { modelCalls: 3 },
      usage: { steps: 2, modelCalls: 3, costUsd: 0.5, unpricedCalls: 0,
        activeSeconds: 10, unknownTokenCalls: 0,
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 } },
    })
    const approval = (jobId: string, objective: string) => ({
      chat: { storyId, firstTurnId: jobId, repositoryId: repoId,
        directory: 'story', sourceSha: sha, originalObjective: objective },
      digest: 'b'.repeat(64), skillId: 'c'.repeat(64),
      model: { provider: model.provider, id: model.id }, foundation, proof: proof(foundation),
    })
    let providerCalls = 0
    const gateway = async (_auth: unknown, _store: unknown, request: Request) => {
      providerCalls++
      const requested = await request.json() as {
        storyId: string; jobId: string; commit: string
      }
      assert.equal(requested.storyId, storyId)
      assert.equal(requested.commit, sha)
      assert.ok(requested.jobId)
      return Response.json({ job: { headSha: sha } })
    }
    const fullId = randomUUID(), objective = 'Make me a mystery game'
    await prepare(fullId, objective)
    delete process.env.NT_AGENT_RPC_URL
    const blocked = await continueApprovedStoryChat(auth, db,
      headers, origin, approval(fullId, objective), { github: gateway })
    assert.equal(blocked.state, 'blocked', 'controller absence is actionable in Chat')
    assert.match(blocked.message ?? '', /controller/)
    assert.equal(providerCalls, 0)
    assert.equal(await db.persistence.generation.queue.record(fullId), null)
    process.env.NT_AGENT_RPC_URL = 'http://127.0.0.1:9999'

    const queued = await continueApprovedStoryChat(auth, db,
      headers, origin, approval(fullId, objective), { github: gateway })
    assert.equal(queued.state, 'queued', queued.message)
    assert.equal(providerCalls, 1)
    const run = await db.persistence.generation.queue.record(fullId)
    assert.equal(run?.phase, 'queued')
    const { inspectPiPolicy, guardPiBudget, configurePiPolicy, PiBudgetPause } = await import('../../src/job-pi-policy')
    const fullJob = await startStoryJob({ story, job: fullId, worktreeCacheRoot: cache }, false)
    assert.deepEqual((await inspectPiPolicy(fullJob)).budget, proof(foundation).usage,
      'the Generation meter inherits the settled Discovery usage exactly once')
    const thread = await openStoryThread(db, owner, storyId, 'root:' + fullId)
    assert.deepEqual(thread.state.turns, [{ id: fullId, executionIds: [fullId] }])
    assert.equal(thread.state.messages[0]?.content, objective)
    assert.equal(thread.state.messages[0]?.phase, 'running')
    assert.equal((await db.persistence.generation.jobs.state(owner, fullId))?.requestJson !== null, true)
    assert.equal((await continueApprovedStoryChat(auth, db,
      headers, origin, approval(fullId, objective), { github: gateway })).state, 'queued')
    assert.equal(providerCalls, 1, 'reconnect must never admit another writer')
    assert.deepEqual((await inspectPiPolicy(fullJob)).budget, proof(foundation).usage)
    const policy = (await inspectPiPolicy(fullJob)).policy
    await assert.rejects(configurePiPolicy(fullJob, { ...policy, limits: { modelCalls: 2 } }), /budget/i)
    await assert.rejects(guardPiBudget(fullJob, 'first-generation-assignment'), PiBudgetPause)
    await configurePiPolicy(fullJob, { ...policy, limits: { ...policy.limits, modelCalls: 4 } })
    await guardPiBudget(fullJob, 'first-generation-assignment')
    const inherited = (await inspectPiPolicy(fullJob)).budget
    assert.equal(inherited.modelCalls, 3)
    assert.equal(inherited.steps, 3)
    // Exercise the actual first Generation checkpoint from the queued Studio
    // request. The author's durable pause must win before objective planning
    // (there is deliberately no provider transport in this test).
    const savedGeneration = (await db.persistence.generation.jobs.state(owner, fullId))!
    const { openWebGenerationGraph } = await import('../../src/web-fixture-runtime')
    const { setJobControl } = await import('../../src/job-control')
    const { graph, saver } = openWebGenerationGraph(join(fullJob.stateDir, 'web-generation.sqlite'))
    try {
      await setJobControl(fullJob, 'paused')
      const checkpoint = { configurable: { thread_id: savedGeneration.threadId! } }
      const result = await graph.invoke({ request: JSON.parse(savedGeneration.requestJson!) }, checkpoint)
      assert.equal(result.status, 'paused', result.reason ?? undefined)
      assert.equal(result.reason, 'paused')
      assert.ok(!result.orchestratorOrder, 'the original author boundary precedes model planning')
      assert.equal((await inspectPiPolicy(fullJob)).budget.modelCalls, 3)
    } finally {
      saver.db.close()
      await setJobControl(fullJob, 'running')
    }

    const limitedId = randomUUID(), limited = 'Only the existing premise'
    await prepare(limitedId, limited)
    const completed = await continueApprovedStoryChat(auth, db,
      headers, origin, approval(limitedId, limited), { github: gateway })
    assert.equal(completed.state, 'completed', completed.message)
    assert.equal(providerCalls, 2)
    assert.equal(await db.persistence.generation.queue.record(limitedId), null)
    assert.equal((await db.persistence.generation.jobs.state(owner, limitedId))?.status, 'completed')
    const limitedThread = await openStoryThread(db, owner, storyId, 'root:' + limitedId)
    assert.deepEqual(limitedThread.state.turns,
      [{ id: limitedId, executionIds: [limitedId] }])
    assert.equal(limitedThread.state.messages[0]?.phase, 'finished')
    assert.equal((await continueApprovedStoryChat(auth, db,
      headers, origin, approval(limitedId, limited), { github: gateway })).state, 'completed')
    assert.equal(providerCalls, 2)
    assert.equal(git('rev-parse', 'HEAD'), sha,
      'both executions preserve the original author Git checkout')

    // New Story with an initialization placeholder: approve the foundation
    // before attempting full-Story configuration, and queue the SAME Turn.
    const skillRepo = join(root, 'noveltea-skills')
    mkdirSync(join(skillRepo, 'skills', 'nt-story-discovery'), { recursive: true })
    mkdirSync(join(skillRepo, 'skills', 'nt-catalog', 'references'), { recursive: true })
    const skillGit = (...args: string[]) => execFileSync('git', args, {
      cwd: skillRepo, encoding: 'utf8',
    }).trim()
    skillGit('init', '-q')
    for (const skillName of ['nt-story-discovery', 'nt-catalog']) {
      writeFileSync(join(skillRepo, 'skills', skillName, 'SKILL.md'),
        '# ' + skillName + '\\n')
    }
    for (const name of ['records.md', 'authority-and-validation.md', 'glossary.md'])
      writeFileSync(join(skillRepo, 'skills', 'nt-catalog', 'references', name), '# Canonical\\n')
    skillGit('add', '.')
    skillGit('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '-qm', 'Pinned discovery skills')
    const skillsConfig = join(root, 'skills-config.json')
    writeFileSync(skillsConfig, JSON.stringify({
      novelteaSkills: skillRepo, skillDiscovery: 'explicit-only',
    }))
    process.env.NT_CONFIG_FILE = skillsConfig
    process.env.NT_STUDIO_SKILLS_SOURCE = skillRepo
    process.env.NT_SKILL_CACHE_DIR = join(root, 'skills-cache')
    const snapshot = await createSkillSnapshot({
      discovery: 'explicit-only', novelteaSkills: skillRepo, skillDirs: [],
      requiredSkills: ['nt-story-discovery', 'nt-catalog'],
    })
    assert.ok(snapshot)
    const newStory = join(repository, 'story-new')
    mkdirSync(join(newStory, 'creative-direction'), { recursive: true })
    writeFileSync(join(newStory, 'creative-direction', 'foundation.md'),
      initialStoryDocument('Fresh Mystery'))
    git('add', 'story-new')
    git('commit', '-qm', 'Unapproved Story placeholder')
    const newSha = git('rev-parse', 'HEAD')
    const newStoryId = randomUUID(), newJobId = randomUUID()
    await db.persistence.onboarding.importStory({
      id: newStoryId, owner, repositoryId: repoId, directory: 'story-new',
      title: 'Fresh Mystery', createdAt: new Date().toISOString(),
      commitSha: newSha,
    })
    await db.persistence.naturalStory.beginFirstTurn(owner, newStoryId, newJobId,
      objective, new Date().toISOString(), 'autonomous')
    await db.persistence.naturalStory.finishFirstTurn(owner, newStoryId, newJobId, false)
    const newJob = await startStoryJob({
      story: newStory, job: newJobId, worktreeCacheRoot: cache,
    })
    await db.persistence.generation.jobs.register(owner, newJobId, newStoryId,
      'Fresh Mystery', newSha, new Date().toISOString())
    await db.persistence.conversations.reconcileRoots(owner, newStoryId)
    const newFoundation = { ...foundation, title: 'Fresh Mystery',
      premise: 'A new town that conceals a century-old mystery' }
    const newApproval = {
      chat: { storyId: newStoryId, firstTurnId: newJobId,
        repositoryId: repoId, directory: 'story-new',
        sourceSha: newSha, originalObjective: objective },
      digest: 'b'.repeat(64), skillId: snapshot.id,
      model: { provider: model.provider, id: model.id },
      foundation: newFoundation, proof: proof(newFoundation),
    }
    let newProviderCalls = 0
    const newGateway = async () => {
      newProviderCalls++
      return Response.json({ job: { headSha: newSha } })
    }
    // Interrupt the original admission after the exact native Foundation
    // commit but before queue admission. Retry must not reopen the provider
    // or create another commit.
    const save = db.persistence.onboarding.saveConversation
    let interrupted = false
    db.persistence.onboarding.saveConversation = async (...args) => {
      if (!interrupted && args[2].startsWith('story-discovery-handoff,') &&
          JSON.parse(args[4]).stage === 'queue-started') {
        interrupted = true
        throw Error('Injected interruption after Foundation commit')
      }
      return save(...args)
    }
    try {
      const stopped = await continueApprovedStoryChat(auth, db,
        headers, origin, newApproval, { github: newGateway })
      assert.equal(stopped.state, 'blocked', stopped.message)
      assert.equal(await db.persistence.generation.queue.record(newJobId), null)
    } finally { db.persistence.onboarding.saveConversation = save }
    assert.ok(interrupted)
    const committed = await trustedHead(newJob)
    assert.notEqual(committed, newSha)
    // Simulate the durable state left by a killed process, rather than an
    // exception that runs the continuation's catch/finally.
    const key = 'story-discovery-handoff,' + newStoryId + ',' + newJobId
    const savedEffect = (await db.persistence.onboarding.conversation(owner, repoId, key))!
    const state = JSON.parse(savedEffect.state)
    await db.persistence.naturalStory.beginFirstTurn(owner, newStoryId, newJobId,
      objective, new Date().toISOString())
    const setLease = async (pid: number, revision: number) => {
      assert.ok(await save(owner, repoId, key, revision + 1, JSON.stringify({
        ...state, revision: revision + 1, lease: { host: hostname(), pid, nonce: randomUUID() },
      }), revision, new Date().toISOString()))
    }
    await setLease(process.pid, savedEffect.revision)
    assert.equal((await continueApprovedStoryChat(auth, db, headers, origin,
      newApproval, { github: newGateway })).state, 'pending')
    // The child has exited and been reaped: its PID is no longer a live owner.
    const deadPid = Number(execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }))
    await setLease(deadPid, savedEffect.revision + 1)
    const started = await continueApprovedStoryChat(auth, db,
      headers, origin, newApproval, { github: newGateway })
    assert.equal(started.state, 'queued', started.message)
    assert.equal(await trustedHead(newJob), committed)
    assert.equal(newProviderCalls, 1)
    assert.equal((await db.persistence.generation.queue.record(newJobId))?.phase, 'queued')
    assert.notEqual(await trustedHead(newJob), newSha)
    assert.equal(git('rev-parse', 'HEAD'), newSha,
      'the source checkout remains pinned after the first Chat handoff')
    assert.equal((await continueApprovedStoryChat(auth, db,
      headers, origin, newApproval, { github: newGateway })).state, 'queued')
    assert.equal(newProviderCalls, 1)
    assert.equal((await openStoryThread(db, owner,
      newStoryId, 'root:' + newJobId)).state.messages[0]?.phase, 'running')
    assert.deepEqual(await db.testing.foreignKeyViolations(), [])
  } finally {
    await db.close()
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    removeTestTree(root)
  }
})
