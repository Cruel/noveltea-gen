import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { removeTestTree } from '../../test/helpers'
import type { JobStartResult } from '../../src/job'
import { SandboxClient } from '../../src/sandbox-client'
import { validateStoryJob } from '../../src/validator'
import { renderFoundation } from '../../src/foundation-record'
import { inspectRecoveryCheckpoints } from '../../src/recovery-checkpoints'
import { inspectDependencyPlan } from '../../src/dependency-state'
import { openWebGenerationGraph } from '../../src/web-fixture-runtime'
import { claimServerGeneration } from '../../src/generation-owner'
import { SandboxController, createControllerServer, type ControllerConfig } from '../src/sandbox-controller'
import { acquireCachedStory } from '../src/lib/git-cache.server'
import { createStudioAuth } from '../src/lib/auth'
import { selectedJob, restoreJob, pinnedRequest } from '../src/lib/fixture-jobs.server'
import { listGenerationEvents } from '../src/lib/generation-progress.server'
import { queueRecord } from '../src/lib/generation-queue.server'
import { userPiCredentials, availableUserPiModels, assertUserPiSelection } from '../src/lib/pi-credentials.server'
import { previewThreadRevision, submitThreadRevision, revisionFromSource, assertPinnedRevision } from '../src/lib/story-revision.server'
import { creativePolicy } from '../../src/creative-policy'
import { advanceThread, readThreadChat, settleThreadRun } from '../src/lib/thread-chat.server'
import { ensureRootThreads } from '../src/lib/threads.server'
import { readJobTurnPlan } from '../src/lib/turn-plan-receipt.server'
import { setThreadCreativeMode } from '../src/lib/threads.server'
import { authorInteractionRequest } from '../src/lib/author-interactions.server'
import { generationControlRequest } from '../src/lib/generation-controls.server'
import { readPinnedObjectivePlanning } from '../../src/orchestrator-planner'
import { loadSelectedStoryOrchestrator } from '../../src/orchestrator-selection'
import { inspectSpecialistChoice } from '../../src/specialist-choice'
import { openStudioDatabase, migrateStudio } from './support/studio-database'
import { studioSeed } from './support/studio-seed'
import { readIsolatedStudioOAuth } from './studio-oauth-source'

const dependencyTest = process.env.NT_TEST_WEB_PI_DEPENDENCY === '1'
const collaborativeTest = process.env.NT_TEST_WEB_PI_COLLABORATIVE === '1'
const enabled = process.env.NT_TEST_WEB_PI_FOCUSED === '1' || dependencyTest || collaborativeTest
const subscription = process.env.NT_TEST_WEB_PI_AUTH === 'device-code'
const isolatedLocalOAuth = process.env.NT_TEST_WEB_PI_LOCAL_OAUTH === '1'
/** Opt-in local certification only: borrow an unexpired access token in memory.
 * Never copy or refresh the user's durable Pi refresh token. */
function localOAuth(provider: string) {
  const credentials = JSON.parse(readFileSync(join(homedir(), '.pi/agent/auth.json'), 'utf8')) as
    Record<string, { type: string; access?: string; expires?: number; refresh?: string }>
  const selected = credentials[provider]
  if (selected?.type !== 'oauth' || !selected.access || !selected.expires ||
      selected.expires - Date.now() < 5 * 60_000)
    throw Error('An unexpired local Pi OAuth access token is required; do not refresh it in this certification.')
  return { type: 'oauth' as const, access: selected.access, expires: selected.expires,
    refresh: 'certification-refresh-disabled-' + randomBytes(24).toString('hex') }
}
const config = { baseURL: 'http://localhost:3000',
  secret: 'live-focused-credential-isolation-test-secret-abcdefg',
  github: { clientId: 'test', clientSecret: 'test' },
  gitlab: { clientId: 'test', clientSecret: 'test' } }

test('opt-in live Pi: authenticated focused creation, dependency repair, or collaborative author-choice resume in rootless sandbox', {
  skip: !enabled ? 'Set NT_TEST_WEB_PI_FOCUSED=1, NT_TEST_WEB_PI_DEPENDENCY=1 or NT_TEST_WEB_PI_COLLABORATIVE=1 with isolated Pi, native CLI, skills and rootless Docker.' : false,
  timeout: 650_000,
}, async () => {
  for (const variable of ['NT_NATIVE_CLI', 'NT_STUDIO_SKILLS_SOURCE',
    'NT_TEST_WEB_PI_PROVIDER', 'NT_TEST_WEB_PI_MODEL',
    ...(subscription && !isolatedLocalOAuth ? ['NT_TEST_WEB_PI_SOURCE_DB', 'NT_PI_CREDENTIAL_KEY'] :
      subscription ? [] : ['NT_TEST_WEB_PI_API_KEY'])])
    assert.ok(process.env[variable], variable + ' required')
  const skills = resolve(process.env.NT_STUDIO_SKILLS_SOURCE!)
  const security = JSON.parse(execFileSync('docker', ['info', '--format', '{{json .SecurityOptions}}'], {
    encoding: 'utf8',
  })) as string[]
  assert.ok(security.some(value => /(^|=)rootless$/.test(value)), 'Rootless Docker required')
  assert.equal(execFileSync('docker', ['info', '--format', '{{.CgroupVersion}}/{{.CgroupDriver}}'], {
    encoding: 'utf8',
  }).trim(), '2/systemd')
  // Reuse the certified read-only token copy. Its real refresh token is never
  // copied, logged, changed, or used by the disposable test Studio instance.
  const oauth = subscription ? isolatedLocalOAuth ? localOAuth(process.env.NT_TEST_WEB_PI_PROVIDER!) :
    await readIsolatedStudioOAuth(process.env.NT_TEST_WEB_PI_SOURCE_DB!, process.env.NT_PI_CREDENTIAL_KEY!,
      process.env.NT_TEST_WEB_PI_SOURCE_USER_ID, process.env.NT_TEST_WEB_PI_PROVIDER!) : null

  const root = mkdtempSync(join(tmpdir(), 'nt-web-focused-pi-'))
  const old = Object.fromEntries(['NT_STATE_DIR', 'NT_GIT_CACHE_DIR', 'NT_PI_CREDENTIAL_KEY',
    'NT_REQUIRE_USER_PI_RUNTIME', 'NT_SANDBOX_SOCKET', 'NT_SANDBOX_TOKEN_FILE',
    'NT_SKILL_CACHE_DIR', 'NT_CONFIG_FILE', 'NT_AGENT_RPC_URL', 'NT_AGENT_RPC_TOKEN'].map(
    key => [key, process.env[key]]))
  const app = join(root, 'app'), state = join(root, 'state'), cache = join(root, 'cache')
  for (const dir of [app, state, cache]) mkdirSync(dir, { recursive: true })
  process.env.NT_STATE_DIR = state
  process.env.NT_GIT_CACHE_DIR = cache
  process.env.NT_PI_CREDENTIAL_KEY = randomBytes(32).toString('base64')
  process.env.NT_REQUIRE_USER_PI_RUNTIME = '1'
  process.env.NT_SKILL_CACHE_DIR = join(root, 'snapshots')
  process.env.NT_CONFIG_FILE = join(root, 'local-config.json')
  writeFileSync(process.env.NT_CONFIG_FILE, JSON.stringify({
    novelteaSkills: skills, skillDiscovery: 'explicit-only',
  }))
  const token = randomBytes(48).toString('hex')
  const socket = join(root, 'controller', 'sandbox.sock')
  mkdirSync(dirname(socket), { recursive: true })
  const tokenFile = join(root, 'controller-token')
  writeFileSync(tokenFile, token, { mode: 0o600 })
  process.env.NT_SANDBOX_SOCKET = socket
  process.env.NT_SANDBOX_TOKEN_FILE = tokenFile
  const controllerConfig: ControllerConfig = {
    socket, token, appVolume: app, stateVolume: state, cacheVolume: cache,
    containerState: state, containerCache: cache,
    image: process.env.NT_SANDBOX_IMAGE || 'noveltea-sandbox:local',
  }
  const server = createControllerServer(new SandboxController(controllerConfig))
  let store = openStudioDatabase(join(app, 'studio.sqlite'))
  let agent: ChildProcess | undefined
  let child: JobStartResult | undefined
  let certified = false
  try {
    await migrateStudio(store, config)
    const auth = createStudioAuth(store, config)
    const ctx = await auth.$context
    const owner = await ctx.internalAdapter.createUser({
      name: 'Focused Author', email: 'focused@live.test', emailVerified: true,
    }, { method: 'test' })
    const other = await ctx.internalAdapter.createUser({
      name: 'Other Author', email: 'other@live.test', emailVerified: true,
    }, { method: 'test' })
    const session = await ctx.internalAdapter.createSession(owner.id)
    const signedCookie = 'better-auth.session_token=' + session.token + '.' +
      createHmac('sha256', config.secret).update(session.token).digest('base64')
    assert.ok((await auth.api.getSession({ headers: new Headers({ cookie: signedCookie }) }))?.user.id === owner.id)
    const provider = process.env.NT_TEST_WEB_PI_PROVIDER!
    await userPiCredentials(store, owner.id).modify(provider, async () =>
      oauth ?? ({ type: 'api_key', key: process.env.NT_TEST_WEB_PI_API_KEY! }))
    const model = (await availableUserPiModels(store, owner.id))
      .find(item => item.provider === provider && item.id === process.env.NT_TEST_WEB_PI_MODEL!)
    assert.ok(model, 'Pinned user model unavailable')
    await assertUserPiSelection(store, owner.id, { provider, id: model.id })
    console.log('Live focused Pi model:', provider + '/' + model.id)

    // Establish a minimal, canonically validated Story and two existing
    // speakers; all source bytes must survive live Pi without modification.
    const repo = join(root, 'source'), story = join(repo, 'story')
    mkdirSync(story, { recursive: true })
    writeFileSync(join(story, 'README.txt'), 'Existing canonical witness mystery\\n')
    const git = (dir: string, ...args: string[]) => execFileSync('git', args, {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.name', 'Author')
    git(repo, 'config', 'user.email', 'author@live.test')
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'Empty Story baseline')
    // Minimal native-valid existing canon deliberately leaves Event and
    // Authored Content uncreated; a broad fixture Story would distract this
    // focused test with unrelated unreachable puzzle/Event branches.
    const originalContract = { scope: { kind: 'partial' as const, depth: 'composition' as const,
      targets: ['arc.truth', 'milestone.disclosure'], branches: ['protect', 'challenge'] },
      constraints: [], envelope: { presentation: 'Visual novel', hardLimits: [], preferences: [] } }
    for (const folder of ['creative-direction', 'arcs', 'milestones', 'characters', 'relationships'])
      mkdirSync(join(story, folder), { recursive: true })
    writeFileSync(join(story, 'creative-direction', 'foundation.md'), renderFoundation({
      id: 'foundation', title: 'The Sealed Ledger',
      premise: 'Two witnesses discover a concealed ledger in a remote archive.',
      central_conflict: 'Truth threatens the fragile bond between former partners.',
      genre: 'Mystery', tone: 'Intimate, suspenseful', player_experience: 'Dialogue-led investigation',
      scope: 'One compact Arc, one relationship, and a focused confrontation.',
      decisions: [{ id: 'ledger', statement: 'The ledger contains evidence of a concealment.',
        origin: 'agent', authority: 'delegated' }],
      body: 'The player investigates what each witness withheld and chooses whether to believe them.',
    }))
    writeFileSync(join(story, 'arcs', 'truth.md'),
      `---\nschema: '0.1'\ntype: arc\nid: arc.truth\ntitle: Hidden Truth\nstatus: draft\ndecisions: []\ndramatic_question: Can the witnesses tell the truth?\ncharacters: [character.ada, character.neri]\n---\nThe two witnesses must confront what the missing ledger means before their distrust turns into silence.\n`)
    writeFileSync(join(story, 'milestones', 'disclosure.md'),
      `---\nschema: '0.1'\ntype: milestone\nid: milestone.disclosure\ntitle: The Disclosure\nstatus: draft\ndecisions: []\ncompleteness: partial\nchange: Both witnesses acknowledge the hidden ledger.\narcs: [arc.truth]\nfulfillment: {any_of: []}\n---\nA future scene will give the witnesses a chance to discuss the secret before resolving the mystery.\n`)
    for (const [id, name] of [['ada', 'Ada'], ['neri', 'Neri']] as const) {
      writeFileSync(join(story, 'characters', id + '.md'),
        `---\nschema: '0.1'\ntype: character\nid: character.${id}\ntitle: ${name}\nstatus: draft\ndecisions: []\nmotivation: Discover the truth about the missing ledger.\n---\n# ${name}\n${name} has a personal stake in the withheld evidence and wants to hear the other witness.\n`)
    }
    writeFileSync(join(story, 'relationships', 'ada-neri.md'),
      `---\nschema: '0.1'\ntype: relationship\nid: relationship.ada-neri\ntitle: Ada and Neri\nstatus: draft\ndecisions: []\ncharacters: [character.ada, character.neri]\ninitial: estranged\n---\nAda and Neri disagree over whether the ledger should be revealed.\n`)
    if (dependencyTest || collaborativeTest) {
      for (const dir of ['facts', 'events', 'authored-content']) mkdirSync(join(story, dir), { recursive: true })
      writeFileSync(join(story, 'facts', 'ledger-forged.md'),
        `---\nschema: '0.1'\ntype: fact\nid: fact.ledger-forged\ntitle: The Ledger Was Forged\nstatus: draft\ndecisions: []\ninitial: true\n---\nThe ledger that accused Neri was forged, though Ada has not yet learned this fact.\n`)
      writeFileSync(join(story, 'events', 'ledger-disclosure.md'),
        `---\nschema: '0.1'\ntype: event\nid: event.ledger-disclosure\ntitle: Ledger Disclosure\nstatus: draft\ndecisions: []\nparticipants: [character.ada, character.neri]\narcs: [arc.truth]\nconsequences: [Ada confronts Neri with the disputed ledger accusation.]\nafter: []\nprerequisites:\n  any_of:\n    - completed: []\n      not_completed: []\nsteps:\n  - id: discovery\n    branches:\n      - id: inspection\n        conditions: []\n        effects: []\n---\nAda brings the sealed ledger to Neri and starts inspecting signatures. The documented existing Fact is fact.ledger-forged; the inspection branch is where Ada can discover the signature mismatch that proves it. The Event does not yet record that knowledge effect.\n`)
      writeFileSync(join(story, 'authored-content', 'disclosure-scene.md'),
        `---\nschema: '0.1'\ntype: authored-content\nid: authored-content.disclosure-scene\ntitle: The Disclosure Scene\nstatus: draft\ndecisions: []\nevents: [event.ledger-disclosure]\nrevelations: []\n---\n# The Disclosure\nAda: The ledger says you stole the funds, Neri.\nNeri: And do you believe it?\nAda: I have not verified the claim.\n`)
    }
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'Establish existing canonical speakers and relationship')
    const base = git(repo, 'rev-parse', 'HEAD')
    const preexisting = git(repo, 'ls-tree', '-r', '--name-only', base, '--', 'story')
      .split('\n').filter(Boolean)
    const priorBytes = new Map(preexisting.map(path => [path,
      readFileSync(join(repo, path), 'utf8')]))

    const parentId = randomUUID(), storyId = randomUUID(), repositoryId = randomUUID()
    const parent = await acquireCachedStory({ cacheDirectory: cache, ownerId: owner.id,
      repositoryId: 'github:123', remoteUrl: 'file://' + repo,
      token: '', directory: 'story', commit: base, jobId: parentId })
    await store.persistence.repositories.upsert(owner.id, 'github', '123',
      'Live/Focused', null, repositoryId, '2026-11-11')
    await store.persistence.onboarding.importStory({
      id: storyId, owner: owner.id, repositoryId, directory: 'story',
      title: 'Focused', commitSha: base, createdAt: '2026-11-11',
    })
    const initialRequest = { story: parent.storyRoot, job: parent.jobId,
      task: 'Seed a witness mystery', contract: originalContract, fixture: false,
      provider, model: model.id, orchestrationPolicy: 'explicit' as const,
      skillsSource: skills }
    const seed = studioSeed(store)
    await seed.job({ id: parentId, ownerUserId: owner.id, storyId, title: 'Canonical source',
      sourceCommitSha: base, status: 'completed', createdAt: '2026-11-11',
      updatedAt: '2026-11-11', generationRequestJson: JSON.stringify(initialRequest),
      generationThreadId: parent.threadId + ':generation:web',
      generationConfigJson: JSON.stringify({ version: 1, headSha: base,
        task: initialRequest.task, contract: originalContract,
        limits: { steps: 14 }, model: { provider, id: model.id } }),
    })
    await seed.queue({ jobId: parentId, ownerUserId: owner.id, intent: 'start',
      phase: 'finished', createdAt: '2026-11-11', updatedAt: '2026-11-11' })
    await claimServerGeneration(parent, parent.threadId + ':generation:web', initialRequest)
    const graph = openWebGenerationGraph(join(parent.stateDir, 'web-generation.sqlite'))
    await graph.graph.updateState({ configurable: { thread_id: parent.threadId + ':generation:web' } },
      { request: initialRequest, status: 'completed', completedStages: [] })
    await graph.graph.updateState({ configurable: { thread_id: parent.threadId + ':generation:web' } },
      { status: 'completed' }, 'completion_decision')
    graph.saver.db.close()
    await ensureRootThreads(store, owner.id, storyId)
    const threadId = 'root:' + parentId
    if (collaborativeTest) await setThreadCreativeMode(store, owner.id, threadId, 'collaborative')
    const baselineVerification = await validateStoryJob(parent, skills, { ...parent, baseSha: base })
    if (baselineVerification.status !== 'passed') console.error('Focused test source validation:', JSON.stringify({
      status: baselineVerification.status, diagnostics: (baselineVerification.report as { diagnostics?: unknown[] })?.diagnostics,
      protection: (baselineVerification.report as { protection?: { status?: string; base?: string; warnings?: unknown[]; changes?: unknown[] } })?.protection,
    }))
    assert.equal(baselineVerification.status, 'passed')
    const request = collaborativeTest
      ? 'Revise the conversation in authored-content.disclosure-scene only. Preserve established facts: Ada does not yet know that the ledger was forged. The dramatic direction is unresolved: how much personal vulnerability Ada reveals in her exchange with Neri. Before any edits, consult the author with 2–3 meaningfully different dramatic alternatives and a reasoned recommendation; let the author settle this consequential relationship choice. Then implement the selected direction, delegating routine phrasing to the specialist. Do not change any other Story record.'
      : dependencyTest
      ? 'Revise authored-content.disclosure-scene only: make Ada and Neri\'s conversation state truthfully that Ada learned the ledger accusation was forged. Respect canonical knowledge continuity. Do not invent off-page knowledge; report any missing causal prerequisite outside your bounded dialogue assignment before making edits.'
      : 'Write a conversation between Ada and Neri about rebuilding trust after the sealed ledger'
    await assert.rejects(previewThreadRevision(store, other.id, threadId, request), /not found|owner|no source generation/i)
    const proposal = await previewThreadRevision(store, owner.id, threadId, request)
    assert.equal(proposal.clarification, null)
    if (dependencyTest || collaborativeTest) {
      assert.deepEqual(proposal.contract.scope.targets,
        ['authored-content.disclosure-scene'], 'the unexpected Event repair must not be initially authorized')
      assert.deepEqual(proposal.contract.scope.creates ?? [], [])
    } else {
      assert.equal(proposal.reviewRequired, true)
      assert.deepEqual(proposal.contract.scope.creates?.map(item => item.id.split('.')[0]),
        ['event', 'authored-content'], 'preexisting Character/Relationship must be reused')
    }
    const turnId = randomUUID()
    const firstSubmission = await submitThreadRevision(store, owner.id, threadId, turnId, request)
    if (firstSubmission.hasRevisionScope === 0)
      assert.equal((await submitThreadRevision(store, owner.id, threadId,
        turnId, request, undefined, proposal.digest)).hasRevisionScope, 1)
    else assert.equal(firstSubmission.hasRevisionScope, 1)
    if (collaborativeTest) {
      const approval = await store.persistence.revisions.scope(owner.id, threadId, turnId)
      assert.ok(approval)
      const scoped = JSON.parse(approval) as Parameters<typeof assertPinnedRevision>[0]
      const refreshed = await revisionFromSource(store, owner.id, parentId, request,
        scoped.selectedTargets, creativePolicy('collaborative'))
      assert.equal(scoped.digest, refreshed.digest,
        JSON.stringify({ saved: scoped, refreshed }).slice(0, 5000))
      assertPinnedRevision(scoped, refreshed, parentId, base)
    }
    server.listen(socket)
    await once(server, 'listening')
    const probe = createNetServer()
    await new Promise<void>((ok, fail) => { probe.once('error', fail); probe.listen(0, '127.0.0.1', ok) })
    const address = probe.address()
    assert.ok(address && typeof address !== 'string')
    const port = address.port
    await new Promise<void>((ok, fail) => probe.close(err => err ? fail(err) : ok()))
    const rpcToken = randomBytes(48).toString('hex')
    process.env.NT_AGENT_RPC_URL = 'http://127.0.0.1:' + port
    process.env.NT_AGENT_RPC_TOKEN = rpcToken
    agent = spawn(process.execPath, ['--import', 'tsx',
      fileURLToPath(new URL('../src/agent-worker.ts', import.meta.url))], {
      cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NT_STUDIO_DB_PATH: join(app, 'studio.sqlite'),
        NT_AGENT_RPC_TOKEN: rpcToken, NT_AGENT_PORT: String(port),
        NT_REQUIRE_SANDBOX_TOOLS: '1' },
    })
    const agentLog = join(root, 'agent.log')
    agent.stdout?.on('data', bytes => appendFileSync(agentLog, bytes))
    agent.stderr?.on('data', bytes => appendFileSync(agentLog, bytes))
    let ready = false
    for (let attempt = 0; attempt < 120; attempt++) {
      if (agent.exitCode !== null) break
      try {
        const response = await fetch(process.env.NT_AGENT_RPC_URL + '/health', {
          headers: { authorization: 'Bearer ' + rpcToken }, signal: AbortSignal.timeout(500),
        })
        if (response.status === 200) { ready = true; break }
      } catch { /* agent starting */ }
      await new Promise(done => setTimeout(done, 100))
    }
    assert.equal(ready, true, 'agent process failed startup; inspect isolated agent.log')
    await advanceThread(store, owner.id, threadId)
    let admission = await readThreadChat(store, owner.id, threadId)
    for (let attempt = 0; attempt < 100 &&
        admission.messages.find(item => item.id === turnId)?.phase === 'preparing'; attempt++) {
      await new Promise(done => setTimeout(done, 200))
      admission = await readThreadChat(store, owner.id, threadId)
    }
    assert.equal(admission.messages.find(item => item.id === turnId)?.phase, 'running',
      JSON.stringify({ messages: admission.messages, runs: admission.runs }).slice(0, 7000))
    child = await restoreJob(await selectedJob(store, owner.id, turnId), owner.id)
    assert.equal(child.baseSha, base)
    const assignment = (await readJobTurnPlan(child))!
    assert.equal(assignment.digest, proposal.turnPlan?.digest)
    if (collaborativeTest) assert.equal(assignment.creativePolicy?.mode, 'collaborative')
    const pinned = pinnedRequest(await selectedJob(store, owner.id, turnId), child)!
    assert.equal(pinned.fixture, false)
    assert.equal(pinned.provider, provider)
    assert.equal(pinned.model, model.id)
    assert.deepEqual(assignment.contract.scope.creates, proposal.contract.scope.creates)
    const initialValidation = await validateStoryJob(parent, skills, { ...parent, baseSha: base })
    assert.equal(initialValidation.status, 'passed')

    const deadline = Date.now() + (collaborativeTest ? 130_000 : dependencyTest ? 580_000 : 340_000)
    while (Date.now() < deadline) {
      const events = await listGenerationEvents(store, owner.id, turnId, 0)
      if (events.some(event => event.kind === 'finished' || event.kind === 'interrupted')) break
      await new Promise(done => setTimeout(done, 1000))
    }
    const events = await listGenerationEvents(store, owner.id, turnId, 0)
    assert.ok(events.some(event => event.kind === 'finished' || event.kind === 'interrupted'),
      'focused real Pi run must have a terminal event')
    if (collaborativeTest) {
      // #155: actual authenticated Studio Turn, real pinned planner reads,
      // real specialist question, authenticated Other/delegation, same-session
      // continuation, and a mode change that cannot rewrite the Turn receipt.
      const selection = await loadSelectedStoryOrchestrator(child,
        child.threadId + ':generation:web', {
          task: request, kind: pinned.contract.scope.kind, turnPlanDigest: pinned.turnPlanDigest,
        })
      const planning = await readPinnedObjectivePlanning(child, selection, assignment, provider, model.id)
      assert.equal(planning.phase, 'planned')
      for (const method of ['nt-story-orchestrate/SKILL.md',
        'nt-story-collaborate/SKILL.md', 'nt-story-collaborate/references/interaction.md'])
        assert.ok(planning.skillReads?.some(path => path.endsWith('/skills/' + method)),
          'real orchestration transcript must have a successful pinned read: ' + method)
      assert.equal((await queueRecord(store, turnId))?.phase, 'finished')
      assert.equal(events.find(event => event.kind === 'finished')?.status, 'paused',
        'an unresolved consequential author decision must pause without writing')
      assert.equal(git(child.worktreeRoot, 'rev-parse', 'HEAD'), base)
      assert.equal(git(child.worktreeRoot, 'status', '--porcelain'), '')
      const original = JSON.parse(readFileSync(join(child.stateDir,
        'focused-items/authored-content.disclosure-scene.json'), 'utf8')) as {
        phase: string; piSessionFile: string; piSessionId: string; authorChoiceId: string
      }
      assert.equal(original.phase, 'awaiting-author')
      assert.ok(original.piSessionFile && existsSync(original.piSessionFile))
      const choice = await inspectSpecialistChoice(child, original.authorChoiceId)
      assert.equal(choice.phase, 'awaiting-author')
      assert.equal(choice.sessionId, original.piSessionId)
      assert.equal(choice.sessionFile, original.piSessionFile)
      assert.ok(choice.question.question.length > 30)
      assert.equal(choice.question.kind, 'alternatives')
      assert.ok((choice.question.options?.length ?? 0) >= 2)
      assert.ok(choice.question.recommendedId)
      assert.ok(choice.question.recommendationReason)
      const api = async (method: 'GET' | 'POST', body?: unknown, cookie = signedCookie) =>
        authorInteractionRequest(auth, store, new Request(config.baseURL + '/api/jobs/' +
          turnId + '/author', { method, headers: { cookie, origin: config.baseURL,
            'content-type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}) }), turnId, config.baseURL)
      assert.equal((await api('GET', undefined, '')).status, 401)
      const foreignSession = await ctx.internalAdapter.createSession(other.id)
      const otherCookie = 'better-auth.session_token=' + foreignSession.token + '.' +
        createHmac('sha256', config.secret).update(foreignSession.token).digest('base64')
      assert.equal((await api('GET', undefined, otherCookie)).status, 404)
      const published = await api('GET')
      const publishedData = await published.json() as { choice?: { id?: string } }
      assert.equal(published.status, 200)
      assert.equal(publishedData.choice?.id, choice.id)
      // Change the Thread default only. The already-pinned Collaborative Turn,
      // Foundation and the pending choice must remain untouched.
      await setThreadCreativeMode(store, owner.id, threadId, 'autonomous')
      assert.equal((await readThreadChat(store, owner.id, threadId)).creativePolicy.mode, 'autonomous')
      assert.equal((await readJobTurnPlan(child))?.creativePolicy?.mode, 'collaborative')
      const answer = { action: 'choice', id: choice.id, proposalSha256: choice.proposalSha256,
        kind: 'custom', text: "Choose the candid admission of uncertainty. Delegate the exact dialogue and staging to the writer. Preserve Ada's lack of knowledge of the forgery." }
      assert.equal((await api('POST', { ...answer, proposalSha256: 'f'.repeat(64) })).status, 409)
      assert.equal((await api('POST', answer, otherCookie)).status, 404)
      const submitted = await api('POST', answer)
      assert.equal(submitted.status, 200, await submitted.text())
      assert.equal((await inspectSpecialistChoice(child, choice.id)).phase, 'answered')
      assert.equal((await api('POST', answer)).status, 409)
      assert.equal(git(child.worktreeRoot, 'rev-parse', 'HEAD'), base)
      const restart = await generationControlRequest(auth, store,
        new Request(config.baseURL + '/api/jobs/' + turnId + '/control', {
          method: 'POST', headers: { cookie: signedCookie, origin: config.baseURL,
            'content-type': 'application/json' }, body: JSON.stringify({ action: 'resume' }),
        }), turnId, config.baseURL)
      assert.equal(restart.status, 202, await restart.text())
      const expectedFinished = events.filter(event => event.kind === 'finished').length + 1
      const resumeDeadline = Date.now() + 120_000
      let resumed = await listGenerationEvents(store, owner.id, turnId, 0)
      while (Date.now() < resumeDeadline &&
          resumed.filter(event => event.kind === 'finished').length < expectedFinished) {
        await new Promise(done => setTimeout(done, 1000))
        resumed = await listGenerationEvents(store, owner.id, turnId, 0)
      }
      assert.ok(resumed.filter(event => event.kind === 'finished').length >= expectedFinished,
        'the same Pi assignment must reach a terminal result after authenticated resume')
      const finalState = openWebGenerationGraph(join(child.stateDir, 'web-generation.sqlite'))
      let finalStatus: string | undefined
      let finalReason: string | null | undefined
      let focusStatus: string | undefined
      try {
        const state = (await finalState.graph.getState({
          configurable: { thread_id: child.threadId + ':generation:web' },
        })).values as { status?: string; reason?: string | null;
          inventory?: { items?: Array<{ id: string; status: string }> } }
        finalStatus = state.status
        finalReason = state.reason
        focusStatus = state.inventory?.items?.find(item =>
          item.id === 'focus:authored-content.disclosure-scene')?.status
      } finally { finalState.saver.db.close() }
      console.log('Live #155 resume:', JSON.stringify({
        finalStatus, finalReason, focusStatus,
        events: resumed.filter(event => event.kind === 'finished').map(event => event.status),
      }))
      assert.equal(focusStatus, 'verified', 'resumed original specialist must produce reviewed Story work')
      assert.equal((await inspectSpecialistChoice(child, choice.id)).phase, 'consumed')
      const completed = JSON.parse(readFileSync(join(child.stateDir,
        'focused-items/authored-content.disclosure-scene.json'), 'utf8')) as {
        phase: string; piSessionFile: string; piSessionId: string; authorChoiceId: string
      }
      assert.equal(completed.phase, 'committed')
      assert.equal(completed.piSessionId, original.piSessionId)
      assert.equal(completed.piSessionFile, original.piSessionFile)
      assert.equal(completed.authorChoiceId, original.authorChoiceId)
      const finalHead = git(child.worktreeRoot, 'rev-parse', 'HEAD')
      assert.notEqual(finalHead, base)
      assert.deepEqual(git(child.worktreeRoot, 'diff', '--name-only', base, finalHead).split('\n'),
        ['story/authored-content/disclosure-scene.md'])
      assert.equal(git(child.worktreeRoot, 'status', '--porcelain'), '')
      assert.equal((await validateStoryJob(child, skills, { ...child, baseSha: base })).status, 'passed')
      assert.equal(git(repo, 'rev-parse', 'HEAD'), base)
      console.log('Live #155 focused author-choice certification PASS (whole-Turn review is separate):', JSON.stringify({
        turn: assignment.digest, source: base, result: finalHead, choice: choice.id,
        recommended: choice.question.recommendedId, options: choice.question.options?.length,
        pinnedReads: planning.skillReads?.length, sameSession: true,
      }))
      certified = true
      return
    }
    const finalQueue = await queueRecord(store, turnId)
    const checkpointFile = join(child.stateDir, 'web-generation.sqlite')
    let checkpoint: { status?: string; reason?: string; active?: unknown;
      inventory?: { items?: Array<{ id: string; stage: string; status: string }> } } = {}
    if (existsSync(checkpointFile)) {
      const savedGraph = openWebGenerationGraph(checkpointFile)
      try {
        const currentJob = await store.persistence.generation.jobs.state(owner.id, turnId)
        if (currentJob?.threadId) checkpoint = (await savedGraph.graph.getState({
          configurable: { thread_id: currentJob.threadId },
        })).values as typeof checkpoint
      } finally { savedGraph.saver.db.close() }
    }
    if (finalQueue?.phase !== 'finished' ||
        events.some(item => item.kind === 'finished' && item.status !== 'completed'))
      console.error('Focused live worker diagnosis:', JSON.stringify({
      agentExitCode: agent.exitCode, checkpointStatus: checkpoint.status,
      reason: checkpoint.reason?.slice(0, 1200), active: checkpoint.active,
      inventory: checkpoint.inventory?.items?.map(item =>
        ({ id: item.id, stage: item.stage, status: item.status })),
    }))
    console.log('Live focused execution:', JSON.stringify({
      phase: finalQueue?.phase, events: events.map(item =>
        ({ kind: item.kind, stage: item.stage, status: item.status })),
    }))
    if (dependencyTest) {
      const dependency = await inspectDependencyPlan(child)
      console.log('Live dependency progress:', JSON.stringify({
        queuePhase: finalQueue?.phase, checkpointStatus: checkpoint.status,
        reason: checkpoint.reason?.slice(0, 1200), version: dependency?.version,
        phases: dependency?.entries.map(e => e.phase),
        changed: git(child.worktreeRoot, 'diff', '--name-only', base, 'HEAD').split('\n').filter(Boolean),
      }))
    }
    assert.equal(finalQueue?.phase, 'finished')
    const terminalStatus = events.find(item => item.kind === 'finished')?.status
    if (dependencyTest) {
      // #151 certifies the two specialist assignments and their reviews. The
      // separate whole-Turn editorial gate can fail closed without invalidating
      // native-validated, independently reviewed dependency evidence.
      assert.ok(terminalStatus === 'completed' || terminalStatus === 'blocked')
      assert.equal(checkpoint.inventory?.items?.find(item =>
        item.id === 'focus:authored-content.disclosure-scene')?.status, 'verified')
    } else {
      assert.equal(terminalStatus, 'completed',
        'real focused Turn must finish with independent review, not an unverified draft')
      assert.equal(checkpoint.status, 'completed')
    }
    const after = await validateStoryJob(child, skills, { ...child, baseSha: base })
    if (after.status !== 'passed') {
      console.error('Live focused native diagnostics:', JSON.stringify({
        status: after.status,
        diagnostics: (after.report as { diagnostics?: unknown[] })?.diagnostics,
        gitStatus: git(child.worktreeRoot, 'status', '--porcelain=v1'),
      }))
    }
    assert.equal(after.status, 'passed', 'actual Pi-authored canonical result must validate')
    const finalHead = git(child.worktreeRoot, 'rev-parse', 'HEAD')
    const changed = git(child.worktreeRoot, 'diff', '--name-only', base, finalHead)
      .split('\n').filter(Boolean)
    assert.deepEqual(changed, dependencyTest
      ? ['story/authored-content/disclosure-scene.md', 'story/events/ledger-disclosure.md']
      : proposal.writePaths.map(path => 'story/' + path).sort())
    for (const [path, content] of priorBytes) {
      if (!dependencyTest || !changed.includes(path))
        assert.equal(readFileSync(join(child.worktreeRoot, path), 'utf8'), content,
          'preexisting canon must remain byte-for-byte untouched: ' + path)
    }
    for (const item of proposal.contract.scope.creates ?? []) {
      const created = readFileSync(join(child.worktreeStoryRoot, item.path), 'utf8')
      assert.match(created, /schema: ['"]?0\.1/)
      assert.ok(created.length > 220, 'Pi must author substantive canonical content')
    }
    const dialogue = readFileSync(join(child.worktreeStoryRoot,
      dependencyTest ? 'authored-content/disclosure-scene.md' :
        proposal.contract.scope.creates!.find(item => item.id.startsWith('authored-content.'))!.path),
    'utf8')
    assert.match(dialogue, /Ada/i)
    assert.match(dialogue, /Neri/i)
    if (dependencyTest) assert.match(dialogue, /Ada:\s*.+/)
    else assert.match(dialogue, /[“"'].{5,}[”"']/)
    const checkpoints = (await inspectRecoveryCheckpoints(child))
      .filter(point => point.workItem.startsWith('focus:'))
    assert.equal(checkpoints.filter(point => point.eligible).length,
      dependencyTest ? 1 : proposal.contract.scope.creates!.length)
    if (dependencyTest) {
      const dependency = await inspectDependencyPlan(child)
      assert.equal(dependency?.version, 2)
      assert.equal(dependency?.entries.length, 1)
      const entry = dependency.entries[0]!
      assert.equal(entry.fixture, false)
      assert.equal(entry.phase, 'verified')
      assert.equal(entry.report.assignmentId, 'focus:authored-content.disclosure-scene')
      assert.equal(entry.report.likelySpecialist, 'nt-event-design')
      assert.equal(entry.report.authorDecisionRequired, false)
      assert.equal(entry.amendment?.assignment.specialist, 'nt-event-design')
      assert.deepEqual(entry.amendment?.assignment.targets, ['event.ledger-disclosure'])
      assert.equal(entry.amendment?.beforeVersion, 1)
      assert.equal(entry.amendment?.afterVersion, 2)
      assert.deepEqual(entry.amendment?.objective, assignment.objective)
      assert.equal(entry.review?.verdict, 'pass')
      assert.ok(entry.planner?.sessionFile && existsSync(entry.planner.sessionFile))
      assert.ok(entry.reviewerSession && existsSync(entry.reviewerSession))
      assert.equal(entry.approval?.jobId, child.jobId)
      assert.equal(entry.approval?.threadId, child.threadId)
      assert.equal(git(child.worktreeRoot, 'rev-list', '--count', base + '..HEAD'), '2')
      assert.match(readFileSync(join(child.worktreeStoryRoot, 'events/ledger-disclosure.md'), 'utf8'),
        /kind: knowledge[\s\S]*character: character\.ada[\s\S]*fact: fact\.ledger-forged[\s\S]*value: knows/)
      assert.match(dialogue, /forg(?:e|ed)/i)
      const original = JSON.parse(readFileSync(join(child.stateDir,
        'focused-items/authored-content.disclosure-scene.json'), 'utf8')) as
        { phase: string; resolvedDependency?: string; worker: string; piSessionFile?: string }
      assert.equal(original.phase, 'committed')
      assert.equal(original.worker, 'pi')
      assert.equal(original.resolvedDependency, entry.reportDigest)
      assert.ok(original.piSessionFile && existsSync(original.piSessionFile))
    } else {
      const reviewedEvent = checkpoints.find(point => point.workItem.startsWith('focus:event.'))
      assert.equal(reviewedEvent?.semanticReview, 'passed',
        'the new Event must have its own independent semantic review')
    }
    for (const item of proposal.contract.scope.creates ?? []) {
      const receipt = JSON.parse(readFileSync(join(child.stateDir,
        'focused-items', item.id + '.json'), 'utf8')) as {
          phase?: string; worker?: string; piSessionFile?: string; commitSha?: string
        }
      assert.equal(receipt.worker, 'pi', 'fixtures do not certify agent authorship')
      assert.equal(receipt.phase, 'committed')
      assert.ok(receipt.commitSha && receipt.piSessionFile && existsSync(receipt.piSessionFile),
        'live specialist must preserve a pinned SDK transcript and Git receipt')
    }
    const review = JSON.parse(readFileSync(join(child.stateDir,
      'narrative-review.json'), 'utf8')) as {
        worker?: string; phase?: string; editorial?: { verdict?: string }
      }
    assert.equal(review.worker, 'pi', 'literary verdict must come from the independent Pi reviewer')
    if (!dependencyTest || checkpoint.status === 'completed') {
      assert.equal(review.phase, 'completed')
      assert.equal(review.editorial?.verdict, 'pass')
    } else assert.equal(review.phase, 'blocked',
      'a blocked final Turn review must not be advertised as completed')
    assert.equal(git(repo, 'rev-parse', 'HEAD'), base)
    assert.equal(git(child.worktreeRoot, 'status', '--porcelain'), '')
    await settleThreadRun(store, owner.id, turnId)
    const chat = await readThreadChat(store, owner.id, threadId)
    assert.equal(chat.turnReceipts.find(turn => turn.id === turnId)?.executions[0]?.inputSha, base)
    // Reconnect through a newly opened Studio DB after the original run has
    // settled. Read-only recovery must preserve one Thread/execution lineage,
    // the same Git HEAD and the original checkpoint proofs without replay.
    store.close()
    store = openStudioDatabase(join(app, 'studio.sqlite'))
    await store.assertReady()
    const reopened = await readThreadChat(store, owner.id, threadId)
    assert.deepEqual(reopened.runs.map(run => run.jobId), chat.runs.map(run => run.jobId))
    assert.equal(reopened.messages.length, chat.messages.length)
    assert.equal((await queueRecord(store, turnId))?.phase, 'finished')
    const restored = await restoreJob(await selectedJob(store, owner.id, turnId), owner.id)
    assert.equal(git(restored.worktreeRoot, 'rev-parse', 'HEAD'), finalHead)
    assert.deepEqual((await inspectRecoveryCheckpoints(restored))
      .filter(point => point.workItem.startsWith('focus:'))
      .map(point => [point.workItem, point.commitSha, point.semanticReview]),
    checkpoints.map(point => [point.workItem, point.commitSha, point.semanticReview]))
    assert.equal(git(restored.worktreeRoot, 'status', '--porcelain'), '')
    console.log(dependencyTest ? 'Live #151 discovered dependency verified:' :
      'Live #150 focused conversation verified:', JSON.stringify({
      source: base, result: finalHead, changed, finalTurnStatus: checkpoint.status,
      checkpointCount: checkpoints.length, review: checkpoints.map(point =>
        ({ item: point.workItem, semanticReview: point.semanticReview })),
    }))
    certified = true
  } finally {
    if (agent && agent.exitCode === null && agent.signalCode === null) {
      agent.kill('SIGTERM')
      await Promise.race([once(agent, 'exit'), new Promise(done => setTimeout(done, 5_000))])
      if (agent.exitCode === null && agent.signalCode === null) {
        agent.kill('SIGKILL')
        await once(agent, 'exit')
      }
    }
    if (child) await new SandboxClient().dispose(child.jobId).catch(() => {})
    store.close()
    if (server.listening) { server.close(); await once(server, 'close') }
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (!certified && process.env.NT_KEEP_FAILED_LIVE === '1')
      console.error('Preserved isolated live evidence:', root)
    else removeTestTree(root)
  }
})
