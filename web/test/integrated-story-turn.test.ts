import assert from 'node:assert/strict'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { scriptedModel, scriptedStoryRuntime, fixtureSandboxClient } from '../../test/c03-scripted-story-helpers'
import { archiveStages } from '../../test/support/scripted-archive-stages'
import { removeTestTree } from '../../test/helpers'
import { createStudioAuth } from '../src/lib/auth'
import { openStudioBusinessFixture } from './support/studio-database'
import { submitFirstStoryTurn } from '../src/lib/story-first-chat.server'
import { storyChatDiscoveryRequest } from '../src/lib/story-chat-discovery.server'
import { initialStoryDocument, acquireCachedStory } from '../src/lib/git-cache.server'
import { userPiCredentials, availableUserPiModels } from '../src/lib/pi-credentials.server'
import { openStoryThread } from '../src/lib/story-threads.server'
import { settleThreadRun } from '../src/lib/thread-chat.server'
import { claimNext, finishAttempt } from '../src/lib/generation-queue.server'
import { runPersistedGeneration } from '../src/agent-runner'
import { authorizedStoryJob } from '../src/lib/fixture-jobs.server'
import { readDiscoveryHandoff } from '../../src/discovery-generation-handoff'
import { readHandoffEffect } from '../src/lib/discovery-handoff-effects.server'
import { requireGenerationTurn } from '../../src/generation'
import type { RecoveryDischarge } from '../../src/generation-recovery-contract'
import { inspectPiPolicy } from '../../src/job-pi-policy'
import { inspectRecoveryCheckpoints } from '../../src/recovery-checkpoints'
import { openWebGenerationGraph } from '../../src/web-fixture-runtime'
import { validateStoryJob } from '../../src/validator'
import { planningDimensions } from '../../src/planning-interpretation'
import { withFixtureSemanticReview } from './support/discovery-semantic-fixture'
import { meterDiscoveryAttempts } from '../src/lib/discovery-evidence.server'

const origin = 'http://localhost:3000'
const skills = resolve(process.env.NT_SKILLS_CHECKOUT ?? resolve(import.meta.dirname, '../../../noveltea-skills'))
const config = {
  baseURL: origin, secret: randomBytes(48).toString('hex'),
  github: { clientId: 'test', clientSecret: 'test' },
  gitlab: { clientId: 'test', clientSecret: 'test' },
}
const objective = 'Create a complete mystery visual novel about Ada, a missing archive witness and Neri’s concealed ledger.'
const planning = {
  choice_frequency: 'occasional', choice_impact: 'lasting',
  branching: { depth: 'shallow', route_exclusivity: 'limited' },
  puzzle_emphasis: 'adventure', pacing: 'balanced',
  first_playthrough: { min_minutes: 90, max_minutes: 120 },
  production: { illustrated_backgrounds: { count: { max: 5 }, firmness: 'soft' } },
} as const

if (process.env.NT_REQUIRE_KYSELY_PROOF === '1' && !process.env.NT_TEST_PG_URL)
  throw new Error('Integrated Story Turn conformance requires NT_TEST_PG_URL')

for (const backend of ['sqlite', 'postgres'] as const) test(`${backend}: R14L authenticated Discovery corrections and approved Turn reach the original queued Generation objective`, {
  timeout: 240_000,
  skip: backend === 'postgres' && !process.env.NT_TEST_PG_URL && 'Set NT_TEST_PG_URL for PostgreSQL certification',
}, async () => {
  assert.ok(existsSync(join(skills, 'skills/nt-story-discovery/SKILL.md')), 'Real NovelTea skills required')
  const root = mkdtempSync(join(tmpdir(), 'nt-r14l-integrated-'))
  const env = {
    NT_STATE_DIR: join(root, 'state'), NT_GIT_CACHE_DIR: join(root, 'cache'),
    NT_SKILL_CACHE_DIR: join(root, 'skills'), NT_DISCOVERY_EVIDENCE_DIR: join(root, 'discovery'),
    NT_CONFIG_FILE: join(root, 'config.json'), NT_STUDIO_SKILLS_SOURCE: skills,
    NT_PI_CREDENTIAL_KEY: randomBytes(32).toString('base64'), NT_REQUIRE_USER_PI_RUNTIME: '1',
    NT_AGENT_RPC_URL: 'http://127.0.0.1:1', NT_AGENT_RPC_TOKEN: randomBytes(32).toString('hex'), PI_OFFLINE: '1',
  }
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  Object.assign(process.env, env)
  writeFileSync(env.NT_CONFIG_FILE, JSON.stringify({ novelteaSkills: skills, skillDiscovery: 'explicit-only' }))
  const fixture = await openStudioBusinessFixture(backend)
  const store = fixture.store
  const create = ModelRuntime.create
  let script: ReturnType<typeof archiveStages> | undefined
  let restoreSandbox: (() => void) | undefined
  try {
    const runtime = await scriptedStoryRuntime((index, context) => {
      assert.ok(script, 'Generation provider cannot be invoked before approval')
      return script(index, context)
    })
    ModelRuntime.create = async options => {
      const scoped = await create.call(ModelRuntime, options)
      scoped.registerNativeProvider(runtime.runtime.getProvider(scriptedModel.provider)!)
      return scoped
    }
    const auth = createStudioAuth(store, config)
    const adapter = (await auth.$context).internalAdapter
    const owner = (await adapter.createUser({ name: 'Author', email: 'r14l-integrated@test.invalid',
      emailVerified: true }, { method: 'test' })).id
    const session = await adapter.createSession(owner)
    const cookie = 'better-auth.session_token=' + session.token + '.' +
      createHmac('sha256', config.secret).update(session.token).digest('base64')
    const headers = new Headers({ cookie, origin })
    const repositoryId = randomUUID(), storyId = randomUUID(), jobId = randomUUID()
    await store.persistence.repositories.upsert(owner, 'github', '274', 'Author/Archive', null, repositoryId, 'now')
    await userPiCredentials(store, owner).modify(scriptedModel.provider,
      async () => ({ type: 'api_key', key: 'in-process-only' }))
    const model = { provider: scriptedModel.provider, id: scriptedModel.id }
    assert.ok((await availableUserPiModels(store, owner)).some(m => m.provider === model.provider && m.id === model.id))
    await store.persistence.settings.putDefaultModel(owner, model, 'now')
    const repo = join(root, 'remote'), story = join(repo, 'story')
    mkdirSync(join(story, 'creative-direction'), { recursive: true })
    writeFileSync(join(story, 'creative-direction/foundation.md'), initialStoryDocument('The Archive Witness'))
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
    git(repo, 'init', '-q', '--initial-branch=main')
    git(repo, 'config', 'user.name', 'Author')
    git(repo, 'config', 'user.email', 'r14l-integrated@test.invalid')
    git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'Initial Story')
    const source = git(repo, 'rev-parse', 'HEAD')
    await store.persistence.onboarding.importStory({ id: storyId, owner, repositoryId, directory: 'story',
      title: 'The Archive Witness', createdAt: 'now', commitSha: source })
    const started = await submitFirstStoryTurn(auth, store, headers, origin, {
      storyId, jobId, prompt: objective, creativeMode: 'autonomous',
    }, async () => JSON.stringify({ phase: 'questions', questions: { questions: [{
      id: 'baseline', kind: 'free-text', question: 'May Studio decide the complete planning baseline?',
      allowStudioDecision: true,
    }] } }))
    assert.equal(started.state, 'discovery', JSON.stringify(started))
    let writerCalls = 0
    const infer = withFixtureSemanticReview(async (state, instructions) => {
      writerCalls++
      const source = { kind: 'answer', setId: state.accepted![0]!.setId, questionId: 'baseline' }
      const value = {
        phase: 'proposal', task: objective,
        foundation: {
          id: 'foundation', title: 'The Archive Witness',
          premise: 'Ada investigates a missing archive witness and Neri’s concealed ledger.',
          central_conflict: 'Ada must prove concealment without exposing the witness.',
          genre: 'Mystery', tone: 'Intimate and suspenseful',
          player_experience: 'Compare sources and make a consequential decision.',
          scope: 'One archive, Ada and Neri, two causal turning points.',
          planning, body: 'Ada compares the signed ledger with the independent daily register, then chooses whether to protect or challenge Neri. The redacted account establishes concealment without exposing the witness.',
          decisions: [{ statement: 'A branching resolution with distinct trust consequences', authority: 'delegated', source }],
        },
        interpretations: planningDimensions(planning).map(({ path }) => ({ path: String(path), source, basis: 'delegated',
          rationale: 'The author expressly delegated remaining baseline decisions to Studio.' })),
      }
      if (writerCalls === 1) {
        value.interpretations[0]!.path = value.interpretations[0]!.path.slice('planning.'.length)
      } else if (writerCalls === 2) {
        assert.match(instructions, /Invalid planning interpretation path/)
        value.foundation.decisions.push({ statement: 'The ledger must be made of silver',
          authority: 'user-protected', source: { kind: 'turn', index: 0 } } as never)
      } else {
        assert.equal(writerCalls, 3)
        assert.match(instructions, /un-delegated Studio suggestion/i)
      }
      return JSON.stringify(value)
    })
    let gatewayCalls = 0
    const gateway = async (_auth: unknown, _store: unknown, request: Request,
      _url: string, effect?: import('../src/lib/discovery-handoff-effects.server').ProviderHandoffEffect) => {
      gatewayCalls++
      assert.deepEqual(await request.json(), { storyId, jobId, commit: source })
      await effect?.('provider-verified')
      await effect?.('worktree-started')
      await acquireCachedStory({ cacheDirectory: env.NT_GIT_CACHE_DIR, ownerId: owner,
        repositoryId: 'github:274', remoteUrl: 'file://' + repo, token: '',
        directory: 'story', commit: source, jobId })
      await store.persistence.generation.jobs.register(owner, jobId, storyId,
        'The Archive Witness', source, 'now')
      await store.persistence.conversations.reconcileRoots(owner, storyId)
      return Response.json({ job: { headSha: source } })
    }
    const request = async (body?: unknown) => {
      const response = await storyChatDiscoveryRequest(auth, store,
        new Request(origin + '/api/story-chat-discovery', { method: body ? 'POST' : 'GET',
          headers, ...(body ? { body: JSON.stringify(body) } : {}) }),
        origin, storyId, jobId, infer, { github: gateway })
      const result = await response.json() as any
      assert.equal(response.status, 200, JSON.stringify({ result, writerCalls }))
      return result
    }
    const questions = (await request()).session
    const proposed = await request({ action: 'answer', revision: questions.revision,
      setId: questions.questions.id, setRevision: questions.questions.revision,
      responses: [{ questionId: 'baseline', answer: { kind: 'delegate', note: '' } }] })
    assert.equal(proposed.session.phase, 'proposed', JSON.stringify(proposed))
    assert.equal(writerCalls, 3)
    const discovery = JSON.parse((await store.persistence.onboarding.conversation(owner, repositoryId,
      'story-chat,' + storyId + ',' + jobId))!.state)
    const usage = await meterDiscoveryAttempts(discovery.settledAttempts)
    const approval = await request({ action: 'approve', revision: proposed.session.revision, digest: proposed.session.digest })
    assert.equal(approval.continuation.state, 'queued', JSON.stringify(approval.continuation))
    const job = await authorizedStoryJob(store, owner, jobId)
    const handoff = await readDiscoveryHandoff(job)
    assert.ok(handoff)
    assert.deepEqual(handoff.usage, usage)
    assert.deepEqual((await inspectPiPolicy(job)).budget, usage)
    assert.equal((await readHandoffEffect(store, owner, repositoryId, storyId, jobId))?.stage, 'queue-settled')
    const state = (await store.persistence.generation.jobs.state(owner, jobId))!
    const generation = JSON.parse(state.requestJson!)
    const turn = await requireGenerationTurn(job, generation)
    assert.equal(turn.digest, handoff.turnPlanDigest)
    assert.equal(handoff.originalObjective, objective)
    const duplicate = await request({ action: 'continue', revision: approval.session.revision, digest: approval.session.digest })
    assert.equal(duplicate.continuation.state, 'queued')
    assert.equal(gatewayCalls, 1)
    assert.equal(runtime.calls(), 0)
    script = archiveStages(job, turn, true, true)
    restoreSandbox = fixtureSandboxClient(job.jobId, job.worktreeStoryRoot)
    const claimed = await claimNext(store)
    assert.equal(claimed?.jobId, jobId)
    assert.equal(await claimNext(store), null)
    await runPersistedGeneration(store, claimed!)
    await finishAttempt(store, jobId, true)
    await settleThreadRun(store, owner, jobId)
    const final = (await store.persistence.generation.jobs.state(owner, jobId))!
    const { graph, saver } = openWebGenerationGraph(join(job.stateDir, 'web-generation.sqlite'))
    let discharged: readonly RecoveryDischarge[] = []
    try {
      const snapshot = await graph.getState({ configurable: { thread_id: final.threadId! } })
      assert.equal(final.status, 'completed', JSON.stringify({ reason: snapshot.values.reason,
        active: snapshot.values.active, recovery: snapshot.values.recoveryLifecycle }))
      assert.equal(snapshot.values.status, 'completed')
      assert.equal(snapshot.values.request.turnPlanDigest, turn.digest)
      assert.equal(snapshot.values.recoveryLifecycle.active, null)
      assert.equal(snapshot.values.recoveryLifecycle.pending.length, 0)
      discharged = snapshot.values.recoveryLifecycle.discharged
      assert.equal(snapshot.next.length, 0)
    } finally { saver.db.close() }
    assert.equal((await store.persistence.generation.queue.record(jobId))?.phase, 'finished')
    assert.equal(await claimNext(store), null)
    assert.ok(runtime.calls() > 0)
    assert.equal((await inspectPiPolicy(job)).budget.modelCalls, usage.modelCalls + runtime.calls())
    const thread = await openStoryThread(store, owner, storyId, 'root:' + jobId)
    assert.deepEqual(thread.state.turns, [{ id: jobId, executionIds: [jobId] }])
    assert.equal(thread.state.messages[0]?.phase, 'finished')
    assert.equal(thread.state.messages[0]?.content, objective)
    const checkpoints = (await inspectRecoveryCheckpoints(job)).filter(p => p.eligible)
    assert.ok(checkpoints.some(p => p.workItem === 'composition-disclosure' && p.semanticReview === 'passed'))
    const rejected = checkpoints.find(p => p.workItem === 'event-disclosure' && p.semanticReview === 'failed')
    assert.ok(rejected?.assurance)
    const { inspectPostcommitReviewCycle } = await import('../../src/postcommit-review-cycle')
    const cycle = await inspectPostcommitReviewCycle(job, rejected.commitSha, rejected.assurance.assignmentDigest)
    assert.ok(cycle)
    assert.equal(cycle.rounds.length, 2)
    assert.equal(cycle.rounds[0]!.commitSha, rejected.commitSha)
    const successor = checkpoints.find(p => p.commitSha === cycle.rounds[1]!.commitSha)
    assert.equal(successor?.semanticReview, 'passed')
    const { readRepairCommitProof } = await import('../../src/checkpoint-assurance')
    const proof = await readRepairCommitProof(job, successor!.workItem)
    assert.equal(proof.rootFailureSha, rejected.commitSha)
    const originalEvent = JSON.parse(readFileSync(join(job.stateDir, 'event-items', 'disclosure.json'), 'utf8'))
    assert.equal(originalEvent.commitSha, rejected.commitSha)
    assert.equal(proof.sessionFile, originalEvent.sessionFile)
    assert.notEqual(cycle.reviewer.file, proof.sessionFile)
    const originalCase = discharged.filter(entry => entry.case.origin.sourceHeadSha === rejected.commitSha &&
      entry.correctedHeadSha === successor!.commitSha)
    assert.equal(originalCase.length, 1, 'The original failed Review Case must be discharged exactly once')
    assert.equal(originalCase[0]!.disposition, 'active-verified')
    assert.ok(checkpoints.every(p => p.commitSha === rejected.commitSha || ['passed', 'not-required'].includes(p.semanticReview)))
    const revalidations = readdirSync(join(job.stateDir, 'revalidation-items')).filter(path => path.endsWith('.json'))
      .map(path => JSON.parse(readFileSync(join(job.stateDir, 'revalidation-items', path), 'utf8')))
    const closeout = revalidations.find(receipt => receipt.proposal.upstreamItemId === 'event:milestone.disclosure')
    assert.equal(closeout?.state, 'completed')
    assert.equal(closeout.proposal.rootUpstreamCommitSha, successor!.commitSha)
    assert.ok(closeout.proposal.unaffected.includes('foundation'))
    assert.ok(closeout.proposal.affected.includes('interactive:milestone.disclosure'))
    assert.deepEqual(closeout.results.map((result: { itemId: string }) => result.itemId).sort(),
      [...closeout.proposal.affected, ...closeout.proposal.unknown].sort())
    assert.ok(closeout.results.every((result: { status: string }) => result.status === 'passed'))
    assert.equal((await validateStoryJob(job)).status, 'passed')
    assert.equal(git(repo, 'rev-parse', 'HEAD'), source)
    assert.equal(git(job.worktreeRoot, 'status', '--porcelain'), '')
  } finally {
    restoreSandbox?.()
    ModelRuntime.create = create
    await fixture.close()
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    removeTestTree(root)
  }
})
