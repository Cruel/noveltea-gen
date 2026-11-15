/** Real-Pi certification continuation from a preserved, finalized work-item checkpoint.
 * Reuses the production authenticated Studio controller; never transplants SQLite
 * graph state, Pi sessions, uncommitted drafts, or source approval grants.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createServer as createNetServer } from 'node:net'
import { inspectRecoveryCheckpoints } from '../../../src/recovery-checkpoints'
import type { JobStartResult } from '../../../src/job'
import { createStudioAuth } from '../../src/lib/auth'
import { userPiCredentials, assertUserPiSelection, availableUserPiModels } from '../../src/lib/pi-credentials.server'
import { authorizedStoryJob } from '../../src/lib/fixture-jobs.server'
import { checkpointContinueRequest } from '../../src/lib/checkpoint-fork.server'
import type { TestStudioDatabase } from './studio-database'
import { localPiOAuth, syncLocalPiOAuth } from './local-pi-oauth'
import { readIsolatedStudioOAuth } from '../studio-oauth-source'
import { verifyLiveNewStory } from './full-story-case'
import type { createControllerServer } from '../../src/sandbox-controller'

type VaultCredential = ReturnType<typeof localPiOAuth> |
  Awaited<ReturnType<typeof readIsolatedStudioOAuth>> | null

export type SavedSource = {
  version: 1
  ownerId: string
  jobId: string
  storyId: string
  repositoryId: string
  sourceSha: string
  storyRoot: string
  skillsSource: string
  nativeCli: string
  mode: 'autonomous' | 'collaborative'
}

/** Read-only restart preflight; runs before the Pi agent or child Job. */
export async function inspectPreservedCheckpointRetry(args: {
  root: string
  skills: string
  store: TestStudioDatabase
  mode: string | undefined
  nativeCli: string | undefined
  checkpointSha: string | undefined
  sourceJobId?: string
}) {
  const { root, store, skills } = args
  const source = JSON.parse(readFileSync(join(root, 'certification-source.json'), 'utf8')) as SavedSource
  assert.equal(source.version, 1, 'Unsupported preserved certification manifest')
  assert.equal(source.skillsSource, skills, 'Retry must use the original source skills checkout')
  assert.equal(source.nativeCli, args.nativeCli, 'Retry must use the original native validator executable')
  assert.equal(source.mode, args.mode, 'Retry cannot change the originally approved creative mode')
  assert.match(args.checkpointSha ?? '', /^[a-f0-9]{40}$/,
    'Set NT_TEST_WEB_PI_RETRY_CHECKPOINT to an exact verified Git commit')
  const sourceId = args.sourceJobId || source.jobId
  await store.assertReady()
  const parent = await authorizedStoryJob(store, source.ownerId, sourceId)
  const original = await authorizedStoryJob(store, source.ownerId, source.jobId)
  assert.equal(original.storyRoot, source.storyRoot)
  assert.equal(original.baseSha, source.sourceSha)
  assert.equal(parent.storyRoot, original.storyRoot, 'Retry must remain in the original Story')
  const points = await inspectRecoveryCheckpoints(parent)
  const checkpoint = points.find(point => point.commitSha === args.checkpointSha && point.eligible)
  assert.ok(checkpoint, 'Chosen checkpoint is not independently finalized and eligible')
  assert.ok(checkpoint.nextWorkItem, 'Checkpoint has no next work item')
  assert.ok(checkpoint.completedWorkItems.length, 'Retry must reuse independently completed work')
  const sourceThread = await store.persistence.advancedThreads.sourceThread(source.ownerId, sourceId)
  assert.ok(sourceThread, 'Source execution has no verified Story Thread')
  const originalThread = await store.persistence.advancedThreads.sourceThread(source.ownerId, source.jobId)
  assert.equal(sourceThread.id, originalThread?.id,
    'Checkpoint retry must remain in the original visible Thread')
  const latest = await store.persistence.advancedThreads.run(source.ownerId, sourceThread.id, 'last')
  assert.ok(latest, 'Original Thread has no execution')
  return { source, sourceId, parent, original, checkpoint, sourceThread, latest }
}

export async function runPreservedCheckpointRetry(args: {
  root: string
  skills: string
  store: TestStudioDatabase
  server: ReturnType<typeof createControllerServer>
  oauth: VaultCredential
  token: string
  socket: string
  config: {
    baseURL: string
    secret: string
    github: { clientId: string; clientSecret: string }
    gitlab: { clientId: string; clientSecret: string }
  }
  setAgent: (agent: ChildProcess) => void
  setAcquiredJob: (job: JobStartResult) => void
  setOauthRelay: (relay: ReturnType<typeof setInterval>) => void
  setOauthSync: (sync: Promise<void> | undefined) => void
}) {
  const { root, store, skills, server, socket, config } = args
  const selectedSha = process.env.NT_TEST_WEB_PI_RETRY_CHECKPOINT!
  const { source, sourceId, parent, checkpoint, sourceThread, latest } =
    await inspectPreservedCheckpointRetry({ root, skills, store,
      mode: process.env.NT_TEST_WEB_PI_STORY_MODE, nativeCli: process.env.NT_NATIVE_CLI,
      checkpointSha: selectedSha, sourceJobId: process.env.NT_TEST_WEB_PI_RETRY_SOURCE_JOB })
  const correctiveGuidance = process.env.NT_TEST_WEB_PI_RETRY_GUIDANCE ?? ''
  assert.ok(correctiveGuidance.length <= 2000, 'Corrective guidance exceeds the controller limit')
  console.log('Checkpoint certification retry:', JSON.stringify({
    sourceJob: sourceId, commitSha: selectedSha, completed: checkpoint.completedWorkItems.length,
    nextWorkItem: checkpoint.nextWorkItem,
  }))

  const auth = createStudioAuth(store, config)
  const ctx = await auth.$context
  const session = await ctx.internalAdapter.createSession(source.ownerId)
  const cookie = 'better-auth.session_token=' + session.token + '.' +
    createHmac('sha256', config.secret).update(session.token).digest('base64')
  const headers = new Headers({ cookie, origin: config.baseURL, 'content-type': 'application/json' })
  const provider = process.env.NT_TEST_WEB_PI_PROVIDER!
  await userPiCredentials(store, source.ownerId).modify(provider, async () =>
    args.oauth ?? ({ type: 'api_key', key: process.env.NT_TEST_WEB_PI_API_KEY! }))
  const models = await availableUserPiModels(store, source.ownerId)
  const picked = models.find(model => model.provider === provider &&
    model.id === process.env.NT_TEST_WEB_PI_MODEL)
  assert.ok(picked, 'Selected model is not available on checkpoint retry')
  const selected = { provider, id: picked.id }
  await assertUserPiSelection(store, source.ownerId, selected)
  let oauthFailure: Error | undefined
  if (process.env.NT_TEST_WEB_PI_LOCAL_OAUTH === '1' && args.oauth?.type === 'oauth') {
    let previous = args.oauth
    let inFlight: Promise<void> | undefined
    const relay = setInterval(() => {
      if (inFlight) return
      inFlight = syncLocalPiOAuth(provider, selected.id, previous, async next => {
        await userPiCredentials(store, source.ownerId).modify(provider, async () => next)
      }).then(next => { previous = next }).catch(() => {
        oauthFailure = new Error('Local Pi OAuth renewal failed during checkpoint certification retry')
      }).finally(() => {
        inFlight = undefined
        args.setOauthSync(undefined)
      })
      args.setOauthSync(inFlight)
    }, 30_000)
    relay.unref()
    args.setOauthRelay(relay)
  }

  server.listen(socket)
  await once(server, 'listening')
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
  const agent = spawn(process.execPath, ['--import', 'tsx', resolve('src/agent-worker.ts')], {
    cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NT_STUDIO_DB_PATH: join(root, 'app/studio.sqlite'),
      NT_AGENT_RPC_TOKEN: agentToken, NT_AGENT_PORT: String(agentPort),
      NT_REQUIRE_SANDBOX_TOOLS: '1' },
  })
  args.setAgent(agent)
  writeFileSync(join(root, 'certification-agent.json'), JSON.stringify({ pid: agent.pid }) + '\n',
    { mode: 0o600 })
  agent.stdout?.on('data', chunk => appendFileSync(join(root, 'agent.log'), chunk))
  agent.stderr?.on('data', chunk => appendFileSync(join(root, 'agent.log'), chunk))
  let ready = false
  for (let i = 0; i < 120; i++) {
    if (agent.exitCode !== null) break
    try {
      const response = await fetch(process.env.NT_AGENT_RPC_URL + '/health', {
        headers: { authorization: 'Bearer ' + agentToken }, signal: AbortSignal.timeout(400),
      })
      if (response.status === 200) { ready = true; break }
    } catch { /* agent initialization */ }
    await new Promise(done => setTimeout(done, 100))
  }
  assert.equal(ready, true, 'Trusted agent must accept the continuation')

  const childId = randomUUID()
  const attempt = join(root, 'attempts', childId)
  mkdirSync(attempt, { recursive: true, mode: 0o700 })
  writeFileSync(join(attempt, 'retry-request.json'), JSON.stringify({
    version: 1, mode: source.mode, originalJobId: source.jobId,
    sourceJobId: sourceId, checkpointSha: selectedSha, completed: checkpoint.completedWorkItems,
    nextWorkItem: checkpoint.nextWorkItem, childId, guidance: correctiveGuidance,
  }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  const response = await checkpointContinueRequest(auth, store,
    new Request(config.baseURL + '/api/jobs/' + sourceId + '/continue', {
      method: 'POST', headers,
      body: JSON.stringify({
        childId, commitSha: selectedSha, sourceBaseSha: parent.baseSha,
        sourceThreadId: sourceThread.id, proofDigest: checkpoint.proofDigest,
        expectedLatestJobId: latest.jobId, guidance: correctiveGuidance,
      }),
    }), sourceId, config.baseURL)
  const result = await response.json() as { id?: string; started?: boolean; warning?: string; error?: string }
  assert.equal(response.status, 202, JSON.stringify(result))
  assert.equal(result.id, childId)
  assert.equal(result.started, true, result.warning ?? 'Checkpoint continuation was not started')
  const child = await authorizedStoryJob(store, source.ownerId, childId)
  args.setAcquiredJob(child)
  assert.equal(child.baseSha, selectedSha)
  await verifyLiveNewStory({
    auth, store, headers, baseURL: config.baseURL,
    ownerId: source.ownerId, storyId: source.storyId, repositoryId: source.repositoryId,
    jobId: childId, mode: source.mode, sourceSha: source.sourceSha,
    job: child, root, skills, model: picked.id,
  })
  if (oauthFailure) throw oauthFailure
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: join(root, 'source'), encoding: 'utf8',
  }).trim()
  assert.equal(head, source.sourceSha, 'Checkpoint retry must not modify the original author repository')
}

