import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { existsSync, mkdtempSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { removeTestTree } from '../../test/helpers'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { openStudioDatabase, openCutoverTestStudioDatabase } from './support/studio-database'
import { studioSeed } from './support/studio-seed'
import { openStudioSchemaConnection, migrateStudioKysely } from '../src/db/kysely-migrations'
import { createStudioAuth } from '../src/lib/auth'
import { acquireCachedStory } from '../src/lib/git-cache.server'
import { fixtureJobRequest } from '../src/lib/fixture-jobs.server'
import { queueRecord } from '../src/lib/generation-queue.server'
import { generationEventsRequest, appendGenerationEvent, listGenerationEvents, recentGenerationEvents } from '../src/lib/generation-progress.server'
import { jobChangesRequest } from '../src/lib/job-changes.server'
import { claimServerGeneration } from '../../src/generation-owner'
import { parseGenerationContract } from '../../src/generation'
import { openWebGenerationGraph } from '../../src/web-fixture-runtime'
import { recordSpecialistChoice, inspectSpecialistChoice } from '../../src/specialist-choice'
import { authorInteractionRequest } from '../src/lib/author-interactions.server'
import { setJobControl } from '../../src/job-control'
import { safeToResume } from '../src/lib/generation-controls.server'
import { randomUUID } from 'node:crypto'
import { interpretNaturalStoryPrompt } from '../src/lib/natural-story-plan'
import { associateNaturalThread } from '../src/lib/natural-story.server'
import { ensureRootThreads } from '../src/lib/threads.server'
import { readThreadChat } from '../src/lib/thread-chat.server'

const secret = 'stable-test-secret-0123456789abcdefghijklmnopqrstuvwxyz'
const config = {
  baseURL: 'http://localhost:3000', secret,
  github: { clientId: 'github', clientSecret: 'github-secret' },
  gitlab: { clientId: 'gitlab', clientSecret: 'gitlab-secret' },
}
const skills = resolve(process.env.NT_SKILLS_CHECKOUT ?? '../../noveltea-skills')
const available = existsSync(join(skills, 'src/cli.ts'))
const storyId = '22222222-2222-4222-8222-222222222222'
const jobId = '33333333-3333-4333-8333-333333333333'
const repoId = '11111111-1111-4111-8111-111111111111'
const naturalPlan = interpretNaturalStoryPrompt(
  'Write a branching mystery visual novel about a missing archive witness. The player can protect or challenge the witness.')
const contract = naturalPlan.contract
const payload = { task: naturalPlan.task, contract }

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

test('authenticated fixture start binds one checkpoint and returns it after a database restart', {
  skip: !available, timeout: 180_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-studio-fixture-'))
  const old = Object.fromEntries(['NT_STATE_DIR', 'NT_GIT_CACHE_DIR', 'NT_STUDIO_SKILLS_SOURCE',
    'NT_CONFIG_FILE',
    'NT_SKILL_CACHE_DIR', 'NT_LIVE_GENERATION_IDEA'].map(key => [key, process.env[key]]))
  process.env.NT_STATE_DIR = join(root, 'durable')
  process.env.NT_GIT_CACHE_DIR = join(root, 'cache')
  process.env.NT_STUDIO_SKILLS_SOURCE = skills
  process.env.NT_CONFIG_FILE = join(root, 'config.json')
  process.env.NT_SKILL_CACHE_DIR = join(root, 'snapshots')
  delete process.env.NT_LIVE_GENERATION_IDEA
  writeFileSync(process.env.NT_CONFIG_FILE, JSON.stringify({ novelteaSkills: skills, skillDiscovery: 'explicit-only' }))
  let store = openStudioDatabase(join(root, 'studio.sqlite'))
  let worker: ChildProcess | undefined
  try {
    const maintenance = openStudioSchemaConnection({ backend: 'sqlite', path: join(root, 'studio.sqlite') })
    try { await migrateStudioKysely(maintenance, config) }
    finally { await maintenance.close() }
    await store.close()
    store = openCutoverTestStudioDatabase(join(root, 'studio.sqlite'))
    const auth = createStudioAuth(store, config)
    const ctx = await auth.$context
    const alice = await ctx.internalAdapter.createUser({
      name: 'Alice', email: 'alice@example.test', emailVerified: true,
    }, { method: 'test' })
    const bob = await ctx.internalAdapter.createUser({
      name: 'Bob', email: 'bob@example.test', emailVerified: true,
    }, { method: 'test' })
    const cookie = async (id: string) => {
      const session = await ctx.internalAdapter.createSession(id)
      return 'better-auth.session_token=' + session.token + '.' +
        createHmac('sha256', secret).update(session.token).digest('base64')
    }
    const aliceCookie = await cookie(alice.id)
    const bobCookie = await cookie(bob.id)
    const repo = join(root, 'remote')
    mkdirSync(join(repo, 'story'), { recursive: true })
    writeFileSync(join(repo, 'story', '.gitkeep'), '')
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.name', 'Author')
    git(repo, 'config', 'user.email', 'author@example.test')
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'Initial Story')
    const pinned = git(repo, 'rev-parse', 'HEAD')
    const acquired = await acquireCachedStory({
      cacheDirectory: process.env.NT_GIT_CACHE_DIR, ownerId: alice.id,
      repositoryId: 'github:123', remoteUrl: 'file://' + repo, token: 'not-persisted',
      commit: pinned, directory: 'story', jobId,
      verifiedSizeBytes: 0, verifiedBlobCount: 1,
    })
    const seed = studioSeed(store)
    ;(await seed.repository({ id: repoId, ownerUserId: alice.id, provider: 'github',
      providerRepositoryId: '123', name: 'Acme/Private', createdAt: '2026-11-01' }))
    ;(await seed.story({ id: storyId, ownerUserId: alice.id, repositoryId: repoId,
      directory: 'story', title: 'Private Story', createdAt: '2026-11-01',
      sourceCommitSha: pinned }))
    ;(await seed.job({ id: jobId, ownerUserId: alice.id, storyId, title: 'Private Story',
      sourceCommitSha: pinned, status: 'paused',
      createdAt: '2026-11-01', updatedAt: '2026-11-01' }))
    await ensureRootThreads(store, alice.id, storyId)
    assert.equal(await associateNaturalThread(store, alice.id, storyId, jobId, payload.task), 'root:' + jobId)
    await assert.rejects(() => associateNaturalThread(store, bob.id, storyId, jobId, payload.task), /not found/)
    assert.deepEqual((await readThreadChat(store, alice.id, 'root:' + jobId)).messages, [])

    const api = async (method: 'GET' | 'POST', body?: unknown, session?: string, origin = config.baseURL) => {
      const request = new Request(config.baseURL + '/api/jobs/' + jobId, {
        method, headers: { origin, 'content-type': 'application/json', ...(session ? { cookie: session } : {}) },
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
      })
      const response = await fixtureJobRequest(auth, store, request, jobId, config.baseURL)
      return { status: response.status, body: await response.json() as any }
    }
    assert.equal((await api('GET')).status, 401)
    assert.equal((await api('GET', undefined, bobCookie)).status, 404)
    assert.equal((await api('POST', payload, aliceCookie, 'https://evil.test')).status, 403)
    assert.equal((await api('POST', { ...payload, fixture: false }, aliceCookie)).status, 400)
    assert.equal((await api('POST', { ...payload, contract: {} }, aliceCookie)).status, 422)
    assert.equal((await api('POST', { ...payload, task: 'x'.repeat(70 * 1024) }, aliceCookie)).status, 413)
    assert.equal((await api('POST', { ...payload, task: '€'.repeat(30 * 1024) }, aliceCookie)).status, 413)
    ;(await store.testing.records.update('studio_sessions', { id: jobId }, { status: 'cancelled' }))
    assert.equal((await api('GET', undefined, aliceCookie)).body.job.status, 'cancelled')
    assert.equal((await api('POST', payload, aliceCookie)).status, 409)
    ;(await store.testing.records.update('studio_sessions', { id: jobId }, { status: 'blocked' }))
    assert.equal((await api('GET', undefined, aliceCookie)).body.job.status, 'blocked')
    assert.equal((await api('POST', payload, aliceCookie)).status, 409)
    ;(await store.testing.records.update('studio_sessions', { id: jobId }, { status: 'running' }))
    const orphan = await api('GET', undefined, aliceCookie)
    assert.equal(orphan.body.job.status, 'interrupted')
    assert.match(orphan.body.job.reason, /without a pinned request/)
    ;(await store.testing.records.update('studio_sessions', { id: jobId }, { status: 'completed' }))
    assert.equal((await api('GET', undefined, aliceCookie)).status, 409)
    ;(await store.testing.records.update('studio_sessions', { id: jobId }, { status: 'paused' }))
    assert.equal((await api('GET', undefined, aliceCookie)).body.job.status, 'prepared')
    // An unpublished initialization draft can be inspected, but an unverified
    // commit is not accepted as the generator's trusted starting revision.
    writeFileSync(join(acquired.worktreeStoryRoot, 'draft.md'), 'Unreviewed draft\\n')
    git(acquired.worktreeRoot, 'add', '--', 'story/draft.md')
    git(acquired.worktreeRoot, '-c', 'user.name=Test', '-c', 'user.email=test@example.test',
      'commit', '-qm', 'Initialize unverified draft')
    assert.equal((await api('GET', undefined, aliceCookie)).body.job.status, 'prepared')
    assert.equal((await api('POST', payload, aliceCookie)).status, 409)
    git(acquired.worktreeRoot, 'reset', '--hard', pinned)
    process.env.NT_LIVE_GENERATION_IDEA = '1'
    assert.equal((await api('POST', payload, aliceCookie)).status, 503)
    delete process.env.NT_LIVE_GENERATION_IDEA
    // A preexisting CLI checkpoint must be fenced BEFORE publishing a web
    // request to the application database, not only in LangGraph schedule.
    const cliCheckpoint = join(acquired.stateDir, 'generation.sqlite')
    writeFileSync(cliCheckpoint, 'foreign CLI checkpoint')
    const conflictBeforeClaim = await api('POST', payload, aliceCookie)
    assert.equal(conflictBeforeClaim.status, 409)
    const unclaimed = (await store.testing.records.first<{ status: string;
      generationRequestJson: string | null }>('studio_sessions', { id: jobId }))!
    assert.equal(unclaimed.status, 'paused')
    assert.equal(unclaimed.generationRequestJson, null)
    assert.equal(existsSync(join(acquired.stateDir, 'generation-server-owner.json')), false)
    unlinkSync(cliCheckpoint)
    // A verified saved scope must bind the eventual fixture start, even if
    // an attacker calls the older start endpoint directly with a new body.
    ;(await store.testing.records.update('studio_sessions', { id: jobId }, {
      generationConfigJson: JSON.stringify({ version: 1, headSha: acquired.headSha,
        task: payload.task, contract: parseGenerationContract(contract),
        limits: { steps: 30 }, model: null }),
    }))
    assert.equal((await api('POST', { ...payload, task: 'Widen the task' }, aliceCookie)).status, 409)
    assert.equal((await api('POST', { ...payload, contract: { ...contract,
      constraints: ['Override author intent'] } }, aliceCookie)).status, 409)
    // Simulate a crash immediately after owner receipt publication but before
    // the request entered SQLite. GET must expose the interrupted ownership,
    // a different request must not take it over, and an identical retry may
    // adopt the same claim without a second thread or CLI writer.
    await claimServerGeneration(acquired, acquired.threadId + ':generation:web', {
      story: acquired.storyRoot, job: jobId, task: payload.task,
      contract: parseGenerationContract(contract), fixture: true, skillsSource: skills, orchestrationPolicy: 'explicit',
    })
    const orphaned = await api('GET', undefined, aliceCookie)
    assert.equal(orphaned.body.job.status, 'interrupted')
    assert.match(orphaned.body.job.reason, /without a saved request/)
    assert.equal((await api('POST', { ...payload, task: 'Different task' }, aliceCookie)).status, 409)
    assert.equal((await store.testing.records.first<{ generationRequestJson: string | null }>('studio_sessions',
      { id: jobId }))?.generationRequestJson, null)
    // Subscribe before generation begins: events must arrive on the live SSE
    // connection rather than only being synthesized from a completed POST.
    const liveStream = await generationEventsRequest(auth, store,
      new Request(config.baseURL + '/api/jobs/' + jobId + '/events', {
        headers: { cookie: aliceCookie },
      }), jobId)
    assert.equal(liveStream.status, 200)
    const liveReader = liveStream.body!.getReader()
    const admitted = await api('POST', payload, aliceCookie)
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body))
    assert.equal(admitted.body.job.status, 'queued')
    // Start the genuine agent entrypoint in a separate OS process. Studio
    // remains live with a separate SQLite connection and cannot pump the queue.
    const portProbe = createServer()
    await new Promise<void>((resolve, reject) => {
      portProbe.once('error', reject)
      portProbe.listen(0, '127.0.0.1', resolve)
    })
    const portAddress = portProbe.address()
    assert.ok(portAddress && typeof portAddress !== 'string')
    const port = portAddress.port
    await new Promise<void>((resolve, reject) => portProbe.close(error => error ? reject(error) : resolve()))
    const token = randomBytes(48).toString('hex')
    worker = spawn(process.execPath, ['--import', 'tsx', resolve('src/agent-worker.ts')], {
      cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NT_STUDIO_DB_PATH: join(root, 'studio.sqlite'), NT_AGENT_PORT: String(port),
        NT_AGENT_RPC_TOKEN: token, NT_SANDBOX_SOCKET: join(root, 'fixture-controller.sock'),
        NT_SANDBOX_TOKEN_FILE: join(root, 'fixture-controller-token'), NT_REQUIRE_SANDBOX_TOOLS: '1',
      },
    })
    let workerStderr = ''
    worker.stderr?.on('data', (chunk: Buffer) => { workerStderr += chunk.toString() })
    let ready = false
    for (let i = 0; i < 100; i++) {
      if (worker.exitCode !== null) break
      try {
        const check = await fetch('http://127.0.0.1:' + port + '/health', {
          headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(350),
        })
        if (check.status === 200) { ready = true; break }
      } catch { /* separate process still starting */ }
      await new Promise(resolve => setTimeout(resolve, 75))
    }
    assert.equal(ready, true, 'independent agent process must start and drain queued work: ' + workerStderr.slice(-4000))
    const liveFirst = await liveReader.read()
    assert.match(new TextDecoder().decode(liveFirst.value), /event: progress\ndata: .*"kind":"started"/)
    const deadline = Date.now() + 30_000
    while ((await queueRecord(store, jobId))?.phase !== 'finished' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 30))
    }
    assert.equal((await queueRecord(store, jobId))?.phase, 'finished', 'agent must finish independently of web traffic')
    worker.kill('SIGTERM')
    const [workerCode] = await once(worker, 'exit')
    assert.equal(workerCode, 0)
    worker = undefined
    const started = await api('GET', undefined, aliceCookie)
    await liveReader.cancel()
    assert.equal(started.status, 200, JSON.stringify(started.body))
    assert.equal(started.body.job.status, 'paused', JSON.stringify(started.body))
    assert.equal(started.body.job.completedStages.length, 1)
    assert.equal(git(repo, 'rev-parse', 'HEAD'), pinned)
    assert.equal(started.body.job.threadId, acquired.threadId + ':generation:web')
    assert.equal(started.body.job.fixture, true)
    const chat = (await readThreadChat(store, alice.id, 'root:' + jobId))
    assert.equal(chat.messages[0]?.content, naturalPlan.task)
    assert.match(chat.messages.at(-1)?.content ?? '', /paused/i)
    assert.equal(chat.runs.length, 1)
    assert.equal(chat.runs[0]?.jobId, jobId)
    const points = started.body.job.recoveryCheckpoints as Array<{
      workItem: string; commitSha: string; eligible: boolean; proofDigest: string; source: string
    }>
    assert.equal(points.length, 1)
    assert.equal(points[0]?.workItem, 'foundation')
    assert.equal(points[0]?.commitSha, started.body.job.headSha)
    assert.equal(points[0]?.eligible, true)
    assert.match(points[0]?.proofDigest ?? '', /^[a-f0-9]{64}$/)
    assert.equal(points[0]?.source, 'foundation.json')
    assert.ok(!('repository' in points[0]!) && !('story' in points[0]!))
    const events = (await listGenerationEvents(store, alice.id, jobId, 0))
    assert.deepEqual(events.map(event => event.kind), ['started', 'working', 'verified', 'finished'])
    assert.equal(events[1]?.stage, 'foundation')
    assert.equal(events[2]?.stage, 'foundation')
    assert.equal(events[3]?.status, 'paused')
    assert.ok(events[2]?.files.includes('creative-direction/foundation.md'))
    assert.equal(events[1]?.detail?.source, 'controller')
    assert.equal(events[2]?.detail?.source, 'controller')
    assert.equal(events[2]?.detail?.turnId,
      chat.turns.find(turn => turn.executionIds.includes(jobId))?.id)
    assert.equal(events[2]?.detail?.headSha, started.body.job.headSha)
    assert.equal(events[2]?.detail?.validation, 'passed')
    assert.ok((events[2]?.detail?.diagnostics ?? 1) >= 0)
    assert.ok((events[2]?.detail?.changedRecordIds ?? []).every(id => typeof id === 'string'))
    assert.equal(JSON.stringify(events).includes(root), false, 'no host paths or internal output in progress')
    assert.equal(JSON.stringify(events).includes('tool_calls'), false)
    assert.equal(events.every((event, index) => index === 0 || event.id > events[index - 1]!.id), true)
    const recent = (await recentGenerationEvents(store, alice.id, jobId))
    assert.deepEqual(recent.events.map(event => event.id), events.map(event => event.id))
    assert.equal(recent.hasMore, false)
    assert.deepEqual((await recentGenerationEvents(store, alice.id, jobId, events.at(-1)!.id)).events
      .map(event => event.id), events.slice(0, -1).map(event => event.id))
    assert.deepEqual((await recentGenerationEvents(store, bob.id, jobId)).events, [],
      'durable history is owner-scoped just like the stream')
    await assert.rejects(() => recentGenerationEvents(store, alice.id, jobId, 0), /Invalid history cursor/)

    const eventApi = (cookie: string | undefined, cursor?: string) => generationEventsRequest(
      auth, store, new Request(config.baseURL + '/api/jobs/' + jobId + '/events', {
        headers: { ...(cookie ? { cookie } : {}), ...(cursor ? { 'Last-Event-ID': cursor } : {}) },
      }), jobId)
    assert.equal((await eventApi(undefined)).status, 401)
    assert.equal((await eventApi(bobCookie)).status, 404)
    assert.equal((await eventApi(aliceCookie, 'not-an-id')).status, 400)
    const eventResponse = await eventApi(aliceCookie)
    assert.equal(eventResponse.status, 200)
    assert.match(eventResponse.headers.get('content-type') ?? '', /text\/event-stream/)
    const firstReader = eventResponse.body!.getReader()
    const firstChunk = await firstReader.read()
    assert.match(new TextDecoder().decode(firstChunk.value), new RegExp('id: ' + events[0]!.id + '\\n'))
    await firstReader.cancel()
    const resumeResponse = await eventApi(aliceCookie, String(events[1]!.id))
    const resumed = resumeResponse.body!.getReader()
    const resumeChunk = await resumed.read()
    assert.match(new TextDecoder().decode(resumeChunk.value), new RegExp('id: ' + events[2]!.id + '\\n'))
    await resumed.cancel()

    const changesApi = (cookie: string, file?: string) => jobChangesRequest(auth, store,
      new Request(config.baseURL + '/api/jobs/' + jobId + '/changes' +
        (file ? '?file=' + encodeURIComponent(file) : ''), { headers: { cookie } }), jobId)
    assert.equal((await changesApi(bobCookie)).status, 404)
    const changed = await changesApi(aliceCookie)
    assert.equal(changed.status, 200)
    const changedFiles = (await changed.json() as { files: string[] }).files
    assert.ok(changedFiles.includes('creative-direction/foundation.md'))
    assert.equal((await changesApi(aliceCookie, '../../.story-inbox/ideas/private.yaml')).status, 404)
    const patch = await changesApi(aliceCookie, 'creative-direction/foundation.md')
    assert.equal(patch.status, 200)
    assert.match((await patch.json() as { diff: string }).diff, /foundation\.md/)
    assert.ok(existsSync(join(acquired.stateDir, 'web-generation.sqlite')))
    assert.ok(existsSync(join(acquired.stateDir, 'generation-server-owner.json')))
    assert.doesNotMatch(JSON.stringify(started.body), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

    const currentHead = git(acquired.worktreeRoot, 'rev-parse', 'HEAD')
    const retry = await api('POST', payload, aliceCookie)
    assert.equal(retry.status, 200)
    assert.equal(retry.body.job.threadId, started.body.job.threadId)
    assert.equal(git(acquired.worktreeRoot, 'rev-parse', 'HEAD'), currentHead)
    assert.equal((await api('POST', { ...payload, task: 'Changed task' }, aliceCookie)).status, 409)

    // Simulate a new application process using the same on-disk catalog and graph checkpoint.
    await store.close()
    store = openCutoverTestStudioDatabase(join(root, 'studio.sqlite'))
    // A reconnect must use the saved request and immutable skill snapshot;
    // the current deployment's optional checkout path is not an authority.
    delete process.env.NT_STUDIO_SKILLS_SOURCE
    const restoredAuth = createStudioAuth(store, config)
    const reopened = await fixtureJobRequest(restoredAuth, store, new Request(config.baseURL + '/api/jobs/' + jobId, {
      headers: { cookie: aliceCookie },
    }), jobId, config.baseURL)
    assert.equal(reopened.status, 200)
    const saved = (await reopened.json() as any).job
    assert.equal(saved.status, 'paused')
    assert.equal(saved.threadId, started.body.job.threadId)
    assert.deepEqual(saved.completedStages, started.body.job.completedStages)
    const replayed = (await listGenerationEvents(store, alice.id, jobId, events[1]!.id))
    assert.deepEqual(replayed.map(event => event.id), events.slice(2).map(event => event.id))
    assert.deepEqual((await listGenerationEvents(store, bob.id, jobId, 0)), [])
    const reconnected = await generationEventsRequest(restoredAuth, store,
      new Request(config.baseURL + '/api/jobs/' + jobId + '/events', {
        headers: { cookie: aliceCookie, 'Last-Event-ID': String(events[1]!.id) },
      }), jobId)
    assert.equal(reconnected.status, 200)
    const afterRestart = reconnected.body!.getReader()
    assert.match(new TextDecoder().decode((await afterRestart.read()).value),
      new RegExp('id: ' + events[2]!.id + '\\n'))
    await afterRestart.cancel()
    await assert.rejects(() => appendGenerationEvent(store, alice.id, jobId, {
      kind: 'working', stage: 'foundation', milestone: '../../private',
    }), /Invalid progress milestone/)
    await appendGenerationEvent(store, alice.id, jobId, {
      kind: 'verified', stage: 'foundation', files: [
        '/etc/passwd', '../private.md', '.story-inbox/private.md',
        'creative-direction/foundation.md', 'creative-direction/foundation.md',
      ],
    })
    const sanitized = await listGenerationEvents(store, alice.id, jobId, events.at(-1)!.id)
    assert.deepEqual(sanitized[0]?.files, ['creative-direction/foundation.md'])
    await assert.rejects(() => appendGenerationEvent(store, alice.id, jobId, {
      kind: 'verified', stage: 'foundation',
      piStatus: { summary: 'I validated everything', proposedPaths: ['events/test.md'] },
    }), /Model status cannot claim controller evidence/)
    const approvalRevision = { id: 'a'.repeat(64), scope: 'milestone' as const,
      milestoneId: 'milestone.disclosure',
      cause: 'unclassified' as const, severity: 'warning' as const,
      disposition: 'corrected' as const }
    await appendGenerationEvent(store, alice.id, jobId, { kind: 'working', stage: 'review',
      approvalRevision })
    const operatorActivity = await listGenerationEvents(store, alice.id, jobId, sanitized[0]!.id)
    assert.deepEqual(operatorActivity[0]?.detail?.approvalRevision, approvalRevision)
    await assert.rejects(() => appendGenerationEvent(store, alice.id, jobId, {
      kind: 'working', stage: 'review', approvalRevision: { ...approvalRevision, severity: 'info' },
    }), /Invalid trusted post-approval activity/)
    await assert.rejects(() => appendGenerationEvent(store, alice.id, jobId, {
      kind: 'working', stage: 'review', piStatus: { summary: 'I approve this source', proposedPaths: [] },
      approvalRevision,
    }), /Model status cannot claim controller evidence/)
    const storyWideRevision = { id: 'b'.repeat(64),
      scope: 'story' as const, milestoneId: null,
      cause: 'author-directed' as const, severity: 'info' as const,
      disposition: 'carried-forward' as const };
    await appendGenerationEvent(store, alice.id, jobId, { kind: "working", stage: "review",
      approvalRevision: storyWideRevision });
    await appendGenerationEvent(store, alice.id, jobId, { kind: "finished", status: "completed" });
    const storyEvents = await listGenerationEvents(store, alice.id, jobId, operatorActivity[0]!.id);
    assert.deepEqual(storyEvents[0]?.detail?.approvalRevision, storyWideRevision);
    assert.equal(storyEvents[0]?.milestone, null,
      "a Story-wide Architecture incident must not masquerade as a Milestone");
    assert.equal(storyEvents[1]?.kind, 'finished',
      'incident publication must not prevent the terminal activity event');
    await assert.rejects(() => appendGenerationEvent(store, alice.id, jobId, {
      kind: 'working', stage: 'review',
      approvalRevision: { ...storyWideRevision, milestoneId: 'milestone.fake' },
    }), /Invalid trusted post-approval activity/);
    await assert.rejects(() => appendGenerationEvent(store, alice.id, jobId, {
      kind: 'working', stage: 'review',
      approvalRevision: { ...approvalRevision, scope: 'story' },
    }), /Invalid trusted post-approval activity/);
    const pinnedRequest = JSON.parse((await store.testing.records.first<{ generationRequestJson: string }>(
      'studio_sessions', { id: jobId }))!.generationRequestJson)
    assert.equal(pinnedRequest.fixture, true)
    assert.equal(pinnedRequest.story, acquired.storyRoot)
    assert.equal(pinnedRequest.model, undefined)
    assert.equal(pinnedRequest.provider, undefined)

    // An obsolete plain paused status and question receipt cannot authorize
    // an answer or writer continuation without a pending nested checkpoint.
    const choiceGraph = openWebGenerationGraph(join(acquired.stateDir, 'web-generation.sqlite'))
    try {
      await choiceGraph.graph.updateState(
        { configurable: { thread_id: saved.threadId } },
        { status: 'paused',
          reason: 'Specialist paused for an author choice. Review 2–4 options or supply your own direction in Author questions and approvals.',
          active: { id: 'foundations', stage: 'foundations' }, result: null })
    } finally { choiceGraph.saver.db.close() }
    mkdirSync(join(acquired.worktreeStoryRoot, 'characters'), { recursive: true })
    const pendingDraft = join(acquired.worktreeStoryRoot, 'characters', 'awaiting-choice.md')
    writeFileSync(pendingDraft, 'A protected, incomplete character draft for the same specialist.')
    const choiceSessionDir = join(acquired.stateDir, 'character-world-sessions', 'character')
    mkdirSync(choiceSessionDir, { recursive: true })
    const choiceSessionId = randomUUID(), choiceSession = join(choiceSessionDir, 'choice.jsonl')
    writeFileSync(choiceSession, [
      JSON.stringify({ type: 'session', id: choiceSessionId, cwd: acquired.worktreeStoryRoot }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'Which creative path?' } }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', stopReason: 'stop',
        content: [{ type: 'text', text: 'I need the author to choose a consequential arc.' }] } }),
    ].join('\n') + '\n')
    const question = {
      question: 'Which established narrative interpretation should this character develop under this story contract?',
      recommendedId: 'existing-canon', allowStudioDecision: true,
      recommendationReason: 'The existing Character record provides a coherent, approved foundation to extend.',
      options: [
        { id: 'existing-canon', title: 'Preserve canon', approach: 'Expand existing characterization.',
          benefits: 'Fewer contradictions.', tradeoffs: 'Narrower creative variation.' },
        { id: 'new-direction', title: 'Explore a new conflict',
          approach: 'Propose a new relationship change.', benefits: 'More dramatic stakes.',
          tradeoffs: 'Requires additional protected review.' },
      ],
    }
    const pendingChoice = await recordSpecialistChoice(acquired, 'character-foundations',
      question, choiceSessionId, choiceSession)
    writeFileSync(join(acquired.stateDir, 'character-world.json'), JSON.stringify({
      jobId: acquired.jobId, threadId: acquired.threadId,
      units: [{ id: 'world-foundations', phase: 'committed' },
        { id: 'character-foundations', phase: 'awaiting-author', authorChoiceId: pendingChoice.id }],
    }))
    await assert.rejects(
      () => safeToResume(acquired, saved.threadId, JSON.stringify(pinnedRequest), false),
      /Uncommitted files/)
    const accepted = await authorInteractionRequest(restoredAuth, store,
      new Request(config.baseURL + '/api/jobs/' + jobId + '/author', {
        method: 'POST', headers: { cookie: aliceCookie, origin: config.baseURL,
          'content-type': 'application/json' },
        body: JSON.stringify({ action: 'choice', id: pendingChoice.id,
          proposalSha256: pendingChoice.proposalSha256, draftRevision: 1,
          kind: 'delegate', note: 'Choose only within the authorized Character assignment.' }),
      }), jobId, config.baseURL)
    assert.equal(accepted.status, 409, await accepted.clone().text())
    assert.equal((await inspectSpecialistChoice(acquired, pendingChoice.id)).answer, undefined)
    assert.notEqual((await queueRecord(store, jobId))?.phase, 'queued')
    unlinkSync(pendingDraft)
    unlinkSync(join(acquired.stateDir, 'character-world.json'))

    // A later specialist can leave a dirty worktree on an otherwise verified
    // HEAD. Inspection must show the original blocked reason, not the generic
    // "unverified HEAD" error or stale Foundation authorization.
    const blockedCause = 'Specialist reported architectural conflicts: Duplicate character.nia in a new file.'
    const graphPath = join(acquired.stateDir, 'web-generation.sqlite')
    const blockedGraph = openWebGenerationGraph(graphPath)
    try {
      await blockedGraph.graph.updateState(
        { configurable: { thread_id: saved.threadId } },
        { status: 'blocked', reason: blockedCause, active: { id: 'foundations', stage: 'foundations' } })
    } finally { blockedGraph.saver.db.close() }
    mkdirSync(join(acquired.worktreeStoryRoot, 'characters'), { recursive: true })
    const dirtyFile = join(acquired.worktreeStoryRoot, 'characters', 'new-duplicate.md')
    writeFileSync(dirtyFile, 'unfinished candidate must remain preserved')
    ;(await store.testing.records.update('studio_sessions', { id: jobId }, { status: 'blocked' }))
    const failed = await fixtureJobRequest(restoredAuth, store,
      new Request(config.baseURL + '/api/jobs/' + jobId, { headers: { cookie: aliceCookie } }),
      jobId, config.baseURL)
    assert.equal(failed.status, 200, await failed.clone().text())
    const blocked = (await failed.json() as any).job
    assert.equal(blocked.status, 'blocked')
    assert.equal(blocked.revisionVerified, false)
    assert.equal(blocked.reason, blockedCause)
    assert.equal(blocked.recovery.kind, 'operator-reconciliation')
    assert.equal(blocked.recovery.stage, 'foundations')
    assert.match(blocked.recovery.guidance, /reconcile/)
    assert.equal(existsSync(dirtyFile), true, 'read-only failure inspection cannot discard a draft')
    assert.equal(git(acquired.worktreeRoot, 'rev-parse', 'HEAD'), currentHead)
    const stillPending = await fixtureJobRequest(restoredAuth, store,
      new Request(config.baseURL + '/api/jobs/' + jobId, { headers: { cookie: bobCookie } }),
      jobId, config.baseURL)
    assert.equal(stillPending.status, 404, 'foreign users never see failure details')

    ;(await store.testing.records.update('studio_sessions', { id: jobId },
      { generationThreadId: 'unrelated-thread' }))
    const conflict = await fixtureJobRequest(restoredAuth, store, new Request(config.baseURL + '/api/jobs/' + jobId, {
      headers: { cookie: aliceCookie },
    }), jobId, config.baseURL)
    assert.equal(conflict.status, 409, 'tampered server thread must fail closed')
    // Initial history is bounded; older pages do not require replaying every
    // event over SSE and never include a different user's event records.
    const earlierCount = (await listGenerationEvents(store, alice.id, jobId, 0)).length
    for (let index = 0; index < 105; index++) await appendGenerationEvent(store, alice.id, jobId,
      { kind: 'working', stage: 'foundation' })
    const newest = (await recentGenerationEvents(store, alice.id, jobId))
    assert.equal(newest.events.length, 100)
    assert.equal(newest.hasMore, true)
    assert.deepEqual(newest.events.map(event => event.id),
      [...new Set(newest.events.map(event => event.id))].sort((left, right) => left - right))
    const older = (await recentGenerationEvents(store, alice.id, jobId, newest.events[0]!.id))
    assert.equal(older.hasMore, false)
    assert.equal(older.events.length, earlierCount + 5)
    assert.ok(older.events.at(-1)!.id < newest.events[0]!.id)
    // Pi status uses the same durable owner-scoped cursor but cannot fabricate
    // a checkpoint, diagnostic, canonical change or independent review.
    await appendGenerationEvent(store, alice.id, jobId, {
      kind: 'working',
      piStatus: { summary: 'Inspecting opening', proposedPaths: ['events/opening.md'] },
    })
    const proposed = (await listGenerationEvents(store, alice.id, jobId, newest.events.at(-1)!.id))[0]!
    assert.equal(proposed.detail?.source, 'pi')
    assert.deepEqual(proposed.files, [])
    assert.deepEqual(proposed.detail?.proposedPaths, ['events/opening.md'])
    assert.equal(proposed.detail?.headSha, undefined)
    assert.equal(proposed.detail?.review, undefined)
    assert.equal(proposed.detail?.diagnostics, undefined)
    assert.deepEqual(await listGenerationEvents(store, bob.id, jobId, newest.events.at(-1)!.id), [])
    await store.close()
    store = openCutoverTestStudioDatabase(join(root, 'studio.sqlite'))
    assert.deepEqual((await listGenerationEvents(store, alice.id, jobId, newest.events.at(-1)!.id))
      .map(event => event.id), [proposed.id], 'restart preserves exact Pi status cursor')
  } finally {
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      worker.kill('SIGKILL')
      await once(worker, 'exit')
    }
    await store.close()
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    removeTestTree(root)
  }
})
