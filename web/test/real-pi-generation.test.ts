import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer as createNetServer } from 'node:net'
import { test } from 'node:test'
import { removeTestTree } from '../../test/helpers'
import type { JobStartResult } from '../../src/job'
import { SandboxClient } from '../../src/sandbox-client'
import { openStudioDatabase } from '../src/db/connection'
import { migrateStudio } from '../src/db/migrations'
import { createStudioAuth } from '../src/lib/auth'
import { acquireCachedStory } from '../src/lib/git-cache.server'
import { generationJobRequest } from '../src/lib/fixture-jobs.server'
import { listGenerationEvents } from '../src/lib/generation-progress.server'
import { queueRecord } from '../src/lib/generation-queue.server'
import { interpretNaturalStoryPrompt } from '../src/lib/natural-story-plan'
import { openWebGenerationGraph } from '../../src/web-fixture-runtime'
import { userPiCredentials, assertUserPiSelection, availableUserPiModels } from '../src/lib/pi-credentials.server'
import { readIsolatedStudioOAuth } from './studio-oauth-source'
import { SandboxController, createControllerServer, type ControllerConfig } from '../src/sandbox-controller'

const enabled = process.env.NT_TEST_WEB_REAL_PI === '1'
const subscriptionTest = process.env.NT_TEST_WEB_PI_AUTH === 'device-code'
const required = subscriptionTest
  ? ['NT_NATIVE_CLI', 'NT_STUDIO_SKILLS_SOURCE', 'NT_TEST_WEB_PI_SOURCE_DB', 'NT_PI_CREDENTIAL_KEY',
      'NT_TEST_WEB_PI_PROVIDER', 'NT_TEST_WEB_PI_MODEL'] as const
  : ['NT_NATIVE_CLI', 'NT_TEST_WEB_PI_API_KEY', 'NT_TEST_WEB_PI_PROVIDER', 'NT_TEST_WEB_PI_MODEL',
      'NT_STUDIO_SKILLS_SOURCE'] as const
const config = { baseURL: 'http://localhost:3000',
  secret: 'web-live-test-secret-0123456789abcdefghijklmnopqrstuvwxyz',
  github: { clientId: 'test', clientSecret: 'secret' },
  gitlab: { clientId: 'test', clientSecret: 'secret' } }

test('opt-in authenticated real Pi writes native-validated Story foundation inside rootless sandbox', {
  skip: !enabled ? 'Set NT_TEST_WEB_REAL_PI=1 and provide a rootless Docker/Pi/native CLI test environment.' : false,
  timeout: 300_000,
}, async () => {
  for (const variable of required) assert.ok(process.env[variable], variable + ' is required')
  const skills = resolve(process.env.NT_STUDIO_SKILLS_SOURCE!)
  assert.ok(existsSync(join(skills, 'skills/nt-story-discovery/SKILL.md')))
  const docker = execFileSync('docker', ['info', '--format', '{{json .SecurityOptions}}'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
  assert.ok((JSON.parse(docker) as string[]).some(value => /(^|=)rootless$/.test(value)),
    'Only a verified rootless Docker host can run this certification')
  assert.equal(execFileSync('docker', ['info', '--format', '{{.CgroupVersion}}/{{.CgroupDriver}}'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim(), '2/systemd')

  // Read the durable Studio credential only in a readonly transaction, before
  // switching to a disposable test encryption key. The test copy contains no
  // usable refresh token and cannot invalidate the normal Studio login.
  const oauth = subscriptionTest ? await readIsolatedStudioOAuth(
    process.env.NT_TEST_WEB_PI_SOURCE_DB!, process.env.NT_PI_CREDENTIAL_KEY!,
    process.env.NT_TEST_WEB_PI_SOURCE_USER_ID, process.env.NT_TEST_WEB_PI_PROVIDER!,
  ) : null
  const root = mkdtempSync(join(tmpdir(), 'nt-web-real-pi-'))
  const envKeys = ['NT_STATE_DIR', 'NT_GIT_CACHE_DIR', 'NT_PI_CREDENTIAL_KEY', 'NT_REQUIRE_USER_PI_RUNTIME',
    'NT_SANDBOX_SOCKET', 'NT_SANDBOX_TOKEN_FILE', 'NT_SKILL_CACHE_DIR', 'NT_CONFIG_FILE',
    'NT_AGENT_RPC_URL', 'NT_AGENT_RPC_TOKEN'] as const
  const old = Object.fromEntries(envKeys.map(name => [name, process.env[name]]))
  const app = join(root, 'app'), state = join(root, 'state'), cache = join(root, 'cache')
  for (const dir of [app, state, cache]) mkdirSync(dir)
  process.env.NT_STATE_DIR = state
  process.env.NT_GIT_CACHE_DIR = cache
  process.env.NT_PI_CREDENTIAL_KEY = randomBytes(32).toString('base64')
  process.env.NT_REQUIRE_USER_PI_RUNTIME = '1'
  process.env.NT_SKILL_CACHE_DIR = join(root, 'snapshots')
  process.env.NT_CONFIG_FILE = join(root, 'local-config.json')
  writeFileSync(process.env.NT_CONFIG_FILE, JSON.stringify({ novelteaSkills: skills, skillDiscovery: 'explicit-only' }))
  const token = randomBytes(48).toString('hex')
  const tokenFile = join(root, 'controller-token')
  const socket = join(root, 'controller', 'sandbox.sock')
  mkdirSync(join(root, 'controller'))
  writeFileSync(tokenFile, token, { mode: 0o600 })
  process.env.NT_SANDBOX_SOCKET = socket
  process.env.NT_SANDBOX_TOKEN_FILE = tokenFile
  const sandbox: ControllerConfig = {
    socket, token, appVolume: app, stateVolume: state, cacheVolume: cache,
    containerState: state, containerCache: cache,
    image: process.env.NT_SANDBOX_IMAGE || 'noveltea-sandbox:local',
  }
  let store = openStudioDatabase(join(app, 'studio.sqlite'))
  const server = createControllerServer(new SandboxController(sandbox))
  let agent: ChildProcess | undefined
  let acquiredJob: JobStartResult | undefined
  try {
    await migrateStudio(store, config)
    const auth = createStudioAuth(store, config)
    const ctx = await auth.$context
    const user = await ctx.internalAdapter.createUser({ name: 'Author', email: 'author@web-live.test',
      emailVerified: true }, { method: 'test' })
    const session = await ctx.internalAdapter.createSession(user.id)
    const cookie = 'better-auth.session_token=' + session.token + '.' +
      createHmac('sha256', config.secret).update(session.token).digest('base64')
    const repo = join(root, 'source')
    mkdirSync(join(repo, 'story'), { recursive: true })
    // Git needs an initial tracked file, but Story Markdown (.md) must carry
    // canonical YAML frontmatter. Keep the placeholder noncanonical so the
    // first Foundation is genuinely a new Story record with an empty baseline.
    const baselineStory = 'A new mystery visual-novel Story\n'
    writeFileSync(join(repo, 'story/README.txt'), baselineStory)
    const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir,
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.name', 'Author')
    git(repo, 'config', 'user.email', 'author@web-live.test')
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'Story baseline')
    const commit = git(repo, 'rev-parse', 'HEAD')
    assert.equal(git(repo, 'ls-tree', '-r', '--name-only', 'HEAD', '--', 'story')
      .split('\n').filter(path => path.endsWith('.md')).length, 0,
      'live Foundation baseline must not contain unvalidated Story Markdown')
    const jobId = randomUUID(), storyId = randomUUID(), repositoryId = randomUUID()
    const job = await acquireCachedStory({ cacheDirectory: cache, ownerId: user.id,
      repositoryId: 'github:123', remoteUrl: 'file://' + repo, token: '', directory: 'story',
      commit, jobId, verifiedSizeBytes: Buffer.byteLength(baselineStory), verifiedBlobCount: 1 })
    acquiredJob = job
    store.sqlite.prepare(`INSERT INTO repositories (id,owner_user_id,provider,provider_repository_id,name,created_at)
      VALUES (?,?,'github','123','Story/Live','2026-11-01')`).run(repositoryId, user.id)
    store.sqlite.prepare(`INSERT INTO stories (id,owner_user_id,repository_id,directory,title,created_at,source_commit_sha)
      VALUES (?,?,?,'story','Live','2026-11-01',?)`).run(storyId, user.id, repositoryId, commit)
    store.sqlite.prepare(`INSERT INTO studio_sessions (id,owner_user_id,story_id,title,status,source_commit_sha,created_at,updated_at)
      VALUES (?,?,?,'Live','paused',?,'2026-11-01','2026-11-01')`).run(jobId, user.id, storyId, commit)
    const provider = process.env.NT_TEST_WEB_PI_PROVIDER!
    await userPiCredentials(store, user.id).modify(provider, async () =>
      oauth ?? ({ type: 'api_key', key: process.env.NT_TEST_WEB_PI_API_KEY! }))
    const eligible = (await availableUserPiModels(store, user.id)).filter(model => model.provider === provider)
    const selectedModel = eligible.find(model => model.id === process.env.NT_TEST_WEB_PI_MODEL!)
    assert.ok(selectedModel, 'The requested model is not available for the selected user provider')
    const selected = { provider, id: selectedModel.id }
    console.log('Live Pi certification model:', selected.provider + '/' + selected.id)
    await assertUserPiSelection(store, user.id, selected)
    const { task, contract } = interpretNaturalStoryPrompt(
      'Write a concise mystery visual novel about an archivist on a stranded train. You can decide unspecified details.')
    const request = { task, contract }
    store.sqlite.prepare('UPDATE studio_sessions SET generation_config_json=? WHERE id=?')
      // Two specialist steps cannot complete the skill-read + authoring +
      // native-validation sequence with a real model. Keep a bounded budget
      // without forcing a premature stop before the first verified commit.
      .run(JSON.stringify({ version: 1, headSha: job.headSha, ...request,
        limits: { steps: 8 }, pauseAfter: 'foundation', model: selected }), jobId)
    server.listen(socket)
    await once(server, 'listening')
    // Web admission no longer executes LangGraph. It must dispatch through
    // the same dedicated agent process used in the real Compose deployment.
    const probe = createNetServer()
    await new Promise<void>((done, fail) => {
      probe.once('error', fail)
      probe.listen(0, '127.0.0.1', done)
    })
    const address = probe.address()
    assert.ok(address && typeof address !== 'string')
    const agentPort = address.port
    await new Promise<void>((done, fail) => probe.close(error => error ? fail(error) : done()))
    const agentToken = randomBytes(48).toString('hex')
    process.env.NT_AGENT_RPC_URL = 'http://127.0.0.1:' + agentPort
    process.env.NT_AGENT_RPC_TOKEN = agentToken
    const started = await generationJobRequest(auth, store,
      new Request(config.baseURL + '/api/jobs/' + jobId, { method: 'POST',
        headers: { cookie, origin: config.baseURL, 'content-type': 'application/json' },
        body: JSON.stringify(request) }), jobId, config.baseURL)
    assert.equal(started.status, 202, await started.clone().text())
    const pinned = JSON.parse((store.sqlite.prepare(
      'SELECT generation_request_json AS request FROM studio_sessions WHERE id=?').get(jobId) as { request: string }).request)
    assert.equal(pinned.fixture, false)
    assert.equal(pinned.provider, selected.provider)
    assert.equal(pinned.model, selected.id)
    agent = spawn(process.execPath, ['--import', 'tsx', resolve('src/agent-worker.ts')], {
      cwd: resolve('.'), stdio: 'ignore',
      env: { ...process.env, NT_STUDIO_DB_PATH: join(app, 'studio.sqlite'),
        NT_AGENT_RPC_TOKEN: agentToken, NT_AGENT_PORT: String(agentPort),
        NT_REQUIRE_SANDBOX_TOOLS: '1' },
    })
    let ready = false
    for (let i = 0; i < 120; i++) {
      if (agent.exitCode !== null) break
      try {
        const response = await fetch(process.env.NT_AGENT_RPC_URL + '/health', {
          headers: { authorization: 'Bearer ' + agentToken }, signal: AbortSignal.timeout(400),
        })
        if (response.status === 200) { ready = true; break }
      } catch { /* dedicated agent initializing */ }
      await new Promise(done => setTimeout(done, 100))
    }
    assert.equal(ready, true, 'independent trusted agent must accept and execute real Pi jobs')
    const deadline = Date.now() + 250_000
    let verified = false, finished = false
    while (Date.now() < deadline) {
      const events = listGenerationEvents(store, user.id, jobId, 0)
      verified ||= events.some(event => event.kind === 'verified' && event.stage === 'foundation')
      finished = events.some(event => event.kind === 'finished' || event.kind === 'interrupted')
      if (finished) break
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    assert.ok(finished, 'real generation must produce a durable terminal/pause event')
    if (!verified) {
      const events = listGenerationEvents(store, user.id, jobId, 0).map(e =>
        ({ kind: e.kind, stage: e.stage, status: e.status }))
      let checkpoint: { status?: string; reason?: string; failures?: Record<string,string>;
        cursor?: number; active?: {stage?: string; id?: string} | null;
        inventory?: {items?: Array<{stage?: string; status?: string}>} } = {}
      const checkpointFile = join(job.stateDir, 'web-generation.sqlite')
      if (existsSync(checkpointFile)) {
        const { saver, graph } = openWebGenerationGraph(checkpointFile)
        try {
          const entry = store.sqlite.prepare('SELECT generation_thread_id AS threadId FROM studio_sessions WHERE id=?')
            .get(jobId) as { threadId: string }
          const snapshot = await graph.getState({ configurable: { thread_id: entry.threadId } })
          checkpoint = snapshot.values as typeof checkpoint
        } finally { saver.db.close() }
      }
      const classify = (reason?: string) => {
        const text = (reason ?? '').toLowerCase()
        if (/^pi budget exhausted at safe boundary:/.test(text)) return 'pi-budget-exhausted'
        if (/(?:step|turn|model.call) (?:budget|limit)(?:s)? (?:exceeded|reached|exhausted)/.test(text)) return 'step-limit'
        if (/resource (?:limit|exhaust)|oom|out of memory/.test(text)) return 'sandbox-resource-limit'
        if (/unauthori|forbidden|401|403|token|credential|oauth|login/.test(text)) return 'authentication'
        if (/429|rate.limit|quota/.test(text)) return 'rate-limit'
        if (/context window|context length|token limit/.test(text)) return 'model-context-limit'
        if (/model|provider|response|api/.test(text)) return 'provider'
        if (/sandbox|docker|container|socket|mount/.test(text)) return 'sandbox'
        if (/validate|schema|story|yaml|revision/.test(text)) return 'validation'
        if (/git|worktree|dirty|commit/.test(text)) return 'git-state'
        if (/prompt|assistant|tool|specialist/.test(text)) return 'specialist'
        return text ? 'other' : 'none'
      }
      if (process.env.NT_TEST_WEB_PI_DIAGNOSTIC === '1') {
        // This explicit opt-in belongs only to the trusted local certification
        // process, NEVER the public Studio event log. Preserve the specific
        // failure for diagnosis before disposable state is destroyed.
        const failure = (checkpoint.reason ?? '(no checkpoint reason)')
          .replaceAll(root, '<test-root>')
          .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
          .replace(/(access_token|refresh_token|api_key|authorization)[=:]\s*["']?[^\s,"']+/gi,
            '$1=[redacted]')
          .slice(0, 5000)
        console.error('Trusted local graph failure detail:', failure)
        const foundationPath = join(job.stateDir, 'foundation.json')
        if (existsSync(foundationPath)) {
          const persisted = JSON.parse(readFileSync(foundationPath, 'utf8')) as {
            stage?: string; writerStarted?: boolean; piSessionFile?: string;
            authoredSha256?: string; validation?: unknown
          }
          console.error('Foundation execution state:', JSON.stringify({
            stage: persisted.stage, writerStarted: persisted.writerStarted,
            sessionExists: !!persisted.piSessionFile && existsSync(persisted.piSessionFile),
            authored: !!persisted.authoredSha256,
            hasValidation: !!persisted.validation,
          }))
        }
      }
      console.error('Live generation stopped before foundation verification:', JSON.stringify({
        events, queuePhase: queueRecord(store, jobId)?.phase,
        checkpointStatus: checkpoint.status,
        reasonCategory: classify(checkpoint.reason),
        reasonIndicators: {
          budget: /^Pi budget exhausted at safe boundary/.test(checkpoint.reason ?? ''),
          containsLimit: /limit/i.test(checkpoint.reason ?? ''),
          containsStep: /step/i.test(checkpoint.reason ?? ''),
          containsError: /error|fail/i.test(checkpoint.reason ?? ''),
        },
        cursor: checkpoint.cursor, activeStage: checkpoint.active?.stage,
        inventory: checkpoint.inventory?.items?.map(item => ({stage: item.stage, status: item.status})),
        failures: Object.fromEntries(Object.entries(checkpoint.failures ?? {}).map(
          ([key, reason]) => [key, classify(reason)])),
      }))
    }
    assert.ok(verified, 'real Pi foundation must validate and commit before the safe-boundary pause')
    const terminal = listGenerationEvents(store, user.id, jobId, 0)
    assert.equal(terminal.find(e => e.kind === 'finished')?.status, 'paused',
      'Foundation-only certification must stop at the first verified boundary')
    assert.equal(terminal.some(e => e.kind === 'verified' && e.stage !== 'foundation'), false,
      'Foundation-only certification must not launch additional generation stages')
    assert.ok(existsSync(join(job.worktreeStoryRoot, 'creative-direction/foundation.md')))
    assert.notEqual(git(job.worktreeRoot, 'rev-parse', 'HEAD'), commit)
    assert.equal(git(repo, 'rev-parse', 'HEAD'), commit, 'source repository remains untouched')
    assert.equal(git(job.worktreeRoot, 'status', '--porcelain'), '')
    const record = readFileSync(join(job.worktreeStoryRoot, 'creative-direction/foundation.md'), 'utf8')
    assert.match(record, /schema: ['"]?0\.1/)
    assert.match(git(job.worktreeRoot, 'log', '-1', '--format=%B'), /NovelTea-Work-Item: foundation/)
    assert.ok(!JSON.stringify(listGenerationEvents(store, user.id, jobId, 0)).includes(root),
      'the public progress journal must not reveal local paths')
  } finally {
    if (agent && agent.exitCode === null && agent.signalCode === null) {
      agent.kill('SIGTERM')
      await Promise.race([once(agent, 'exit'), new Promise(done => setTimeout(done, 5_000))])
      if (agent.exitCode === null && agent.signalCode === null) {
        agent.kill('SIGKILL')
        await once(agent, 'exit')
      }
    }
    // A test timeout must not strand an executing rootless sandbox after
    // shutting down its agent. The trusted test controller is still alive.
    if (acquiredJob) await new SandboxClient().dispose(acquiredJob.jobId).catch(() => {})
    store.sqlite.close()
    if (server.listening) {
      server.close()
      await once(server, 'close')
    }
    for (const key of envKeys) {
      if (old[key] === undefined) delete process.env[key]
      else process.env[key] = old[key]
    }
    removeTestTree(root)
  }
})
