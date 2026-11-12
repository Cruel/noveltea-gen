import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { removeTestTree } from '../../test/helpers'
import type { JobStartResult } from '../../src/job'
import { SandboxClient } from '../../src/sandbox-client'
import { validateStoryJob } from '../../src/validator'
import { renderFoundation } from '../../src/foundation-record'
import { inspectRecoveryCheckpoints } from '../../src/recovery-checkpoints'
import { openWebGenerationGraph } from '../../src/web-fixture-runtime'
import { claimServerGeneration } from '../../src/generation-owner'
import { SandboxController, createControllerServer, type ControllerConfig } from '../src/sandbox-controller'
import { acquireCachedStory } from '../src/lib/git-cache.server'
import { createStudioAuth } from '../src/lib/auth'
import { selectedJob, restoreJob, pinnedRequest } from '../src/lib/fixture-jobs.server'
import { listGenerationEvents } from '../src/lib/generation-progress.server'
import { queueRecord } from '../src/lib/generation-queue.server'
import { userPiCredentials, availableUserPiModels, assertUserPiSelection } from '../src/lib/pi-credentials.server'
import { previewThreadRevision, submitThreadRevision } from '../src/lib/story-revision.server'
import { advanceThread, readThreadChat, settleThreadRun } from '../src/lib/thread-chat.server'
import { ensureRootThreads } from '../src/lib/threads.server'
import { readJobTurnPlan } from '../src/lib/turn-plan-receipt.server'
import { openStudioDatabase, migrateStudio } from './support/studio-database'
import { studioSeed } from './support/studio-seed'
import { readIsolatedStudioOAuth } from './studio-oauth-source'

const enabled = process.env.NT_TEST_WEB_PI_FOCUSED === '1'
const subscription = process.env.NT_TEST_WEB_PI_AUTH === 'device-code'
const config = { baseURL: 'http://localhost:3000',
  secret: 'live-focused-credential-isolation-test-secret-abcdefg',
  github: { clientId: 'test', clientSecret: 'test' },
  gitlab: { clientId: 'test', clientSecret: 'test' } }

test('opt-in live Pi: authenticated Thread creates only missing Event and dialogue in rootless sandbox', {
  skip: !enabled ? 'Set NT_TEST_WEB_PI_FOCUSED=1 with isolated user Pi, native CLI, skills and rootless Docker.' : false,
  timeout: 450_000,
}, async () => {
  for (const variable of ['NT_NATIVE_CLI', 'NT_STUDIO_SKILLS_SOURCE',
    'NT_TEST_WEB_PI_PROVIDER', 'NT_TEST_WEB_PI_MODEL',
    ...(subscription ? ['NT_TEST_WEB_PI_SOURCE_DB', 'NT_PI_CREDENTIAL_KEY'] : ['NT_TEST_WEB_PI_API_KEY'])])
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
  const oauth = subscription ? await readIsolatedStudioOAuth(
    process.env.NT_TEST_WEB_PI_SOURCE_DB!, process.env.NT_PI_CREDENTIAL_KEY!,
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
    const baselineVerification = await validateStoryJob(parent, skills, { ...parent, baseSha: base })
    if (baselineVerification.status !== 'passed') console.error('Focused test source validation:', JSON.stringify({
      status: baselineVerification.status, diagnostics: (baselineVerification.report as { diagnostics?: unknown[] })?.diagnostics,
      protection: (baselineVerification.report as { protection?: { status?: string; base?: string; warnings?: unknown[]; changes?: unknown[] } })?.protection,
    }))
    assert.equal(baselineVerification.status, 'passed')
    const request = 'Write a conversation between Ada and Neri about rebuilding trust after the sealed ledger'
    await assert.rejects(previewThreadRevision(store, other.id, threadId, request), /not found|owner|no source generation/i)
    const proposal = await previewThreadRevision(store, owner.id, threadId, request)
    assert.equal(proposal.clarification, null)
    assert.equal(proposal.reviewRequired, true)
    assert.deepEqual(proposal.contract.scope.creates?.map(item => item.id.split('.')[0]),
      ['event', 'authored-content'], 'preexisting Character/Relationship must be reused')
    const turnId = randomUUID()
    assert.equal((await submitThreadRevision(store, owner.id, threadId,
      turnId, request)).hasRevisionScope, 0, 'new support requires author review')
    assert.equal((await submitThreadRevision(store, owner.id, threadId,
      turnId, request, undefined, proposal.digest)).hasRevisionScope, 1)
    await advanceThread(store, owner.id, threadId)
    const admission = await readThreadChat(store, owner.id, threadId)
    assert.equal(admission.messages.find(item => item.id === turnId)?.phase, 'running')
    child = await restoreJob(await selectedJob(store, owner.id, turnId), owner.id)
    assert.equal(child.baseSha, base)
    const assignment = (await readJobTurnPlan(child))!
    assert.equal(assignment.digest, proposal.turnPlan?.digest)
    const pinned = pinnedRequest(await selectedJob(store, owner.id, turnId), child)!
    assert.equal(pinned.fixture, false)
    assert.equal(pinned.provider, provider)
    assert.equal(pinned.model, model.id)
    assert.deepEqual(assignment.contract.scope.creates, proposal.contract.scope.creates)
    const initialValidation = await validateStoryJob(parent, skills, { ...parent, baseSha: base })
    assert.equal(initialValidation.status, 'passed')

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
    agent = spawn(process.execPath, ['--import', 'tsx', resolve('src/agent-worker.ts')], {
      cwd: resolve('.'), stdio: 'ignore',
      env: { ...process.env, NT_STUDIO_DB_PATH: join(app, 'studio.sqlite'),
        NT_AGENT_RPC_TOKEN: rpcToken, NT_AGENT_PORT: String(port),
        NT_REQUIRE_SANDBOX_TOOLS: '1' },
    })
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
    assert.equal(ready, true)
    const deadline = Date.now() + 340_000
    while (Date.now() < deadline) {
      const events = await listGenerationEvents(store, owner.id, turnId, 0)
      if (events.some(event => event.kind === 'finished' || event.kind === 'interrupted')) break
      await new Promise(done => setTimeout(done, 1000))
    }
    const events = await listGenerationEvents(store, owner.id, turnId, 0)
    assert.ok(events.some(event => event.kind === 'finished' || event.kind === 'interrupted'),
      'focused real Pi run must have a terminal event')
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
    assert.equal(finalQueue?.phase, 'finished')
    assert.equal(events.find(item => item.kind === 'finished')?.status, 'completed',
      'real focused Turn must finish with independent review, not an unverified draft')
    assert.equal(checkpoint.status, 'completed')
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
    assert.deepEqual(changed, proposal.writePaths.map(path => 'story/' + path).sort())
    for (const [path, content] of priorBytes) {
      assert.equal(readFileSync(join(child.worktreeRoot, path), 'utf8'), content,
        'preexisting canon must remain byte-for-byte untouched: ' + path)
    }
    for (const item of proposal.contract.scope.creates!) {
      const created = readFileSync(join(child.worktreeStoryRoot, item.path), 'utf8')
      assert.match(created, /schema: ['"]?0\.1/)
      assert.ok(created.length > 220, 'Pi must author substantive canonical content')
    }
    const dialogue = readFileSync(join(child.worktreeStoryRoot,
      proposal.contract.scope.creates!.find(item => item.id.startsWith('authored-content.'))!.path),
    'utf8')
    assert.match(dialogue, /Ada/i)
    assert.match(dialogue, /Neri/i)
    assert.match(dialogue, /[“"'].{5,}[”"']/)
    const checkpoints = (await inspectRecoveryCheckpoints(child))
      .filter(point => point.workItem.startsWith('focus:'))
    assert.equal(checkpoints.filter(point => point.eligible).length,
      proposal.contract.scope.creates!.length)
    const reviewedEvent = checkpoints.find(point => point.workItem.startsWith('focus:event.'))
    assert.equal(reviewedEvent?.semanticReview, 'passed',
      'the new Event must have its own independent semantic review')
    for (const item of proposal.contract.scope.creates!) {
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
    assert.equal(review.phase, 'completed')
    assert.equal(review.editorial?.verdict, 'pass')
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
    console.log('Live #150 focused conversation verified:', JSON.stringify({
      source: base, result: finalHead, changed,
      checkpointCount: checkpoints.length, review: checkpoints.map(point =>
        ({ item: point.workItem, semanticReview: point.semanticReview })),
    }))
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
    removeTestTree(root)
  }
})
