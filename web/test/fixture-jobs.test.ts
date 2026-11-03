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
import { openStudioDatabase } from '../src/db/connection'
import { migrateStudio } from '../src/db/migrations'
import { createStudioAuth } from '../src/lib/auth'
import { acquireCachedStory } from '../src/lib/git-cache.server'
import { fixtureJobRequest } from '../src/lib/fixture-jobs.server'
import { queueRecord } from '../src/lib/generation-queue.server'
import { generationEventsRequest, appendGenerationEvent, listGenerationEvents } from '../src/lib/generation-progress.server'
import { jobChangesRequest } from '../src/lib/job-changes.server'
import { claimServerGeneration } from '../../src/generation-owner'
import { parseGenerationContract } from '../../src/generation'
import { openWebGenerationGraph } from '../../src/web-fixture-runtime'
import { recordSpecialistChoice, answerSpecialistChoice } from '../../src/specialist-choice'
import { safeToResume } from '../src/lib/generation-controls.server'
import { randomUUID } from 'node:crypto'

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
const contract = {
  scope: { kind: 'partial', depth: 'composition', targets: ['arc.truth', 'milestone.disclosure'],
    branches: ['protect', 'challenge'] },
  constraints: ['The player can protect or challenge the witness'],
  envelope: { presentation: 'Dialogue-led visual novel', hardLimits: [], preferences: [] },
}
const payload = { task: 'A missing archive witness; invent unspecified details', contract }

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
    'NT_CONFIG_FILE', 'NT_VALIDATOR_TEST_LEGACY', 'NT_VALIDATOR_CACHE_DIR',
    'NT_SKILL_CACHE_DIR', 'NT_LIVE_GENERATION_IDEA'].map(key => [key, process.env[key]]))
  process.env.NT_STATE_DIR = join(root, 'durable')
  process.env.NT_GIT_CACHE_DIR = join(root, 'cache')
  process.env.NT_STUDIO_SKILLS_SOURCE = skills
  process.env.NT_CONFIG_FILE = join(root, 'config.json')
  process.env.NT_VALIDATOR_TEST_LEGACY = '1'
  process.env.NT_VALIDATOR_CACHE_DIR = join(root, 'validators')
  process.env.NT_SKILL_CACHE_DIR = join(root, 'snapshots')
  delete process.env.NT_LIVE_GENERATION_IDEA
  writeFileSync(process.env.NT_CONFIG_FILE, JSON.stringify({ novelteaSkills: skills, skillDiscovery: 'explicit-only' }))
  let store = openStudioDatabase(join(root, 'studio.sqlite'))
  let worker: ChildProcess | undefined
  try {
    await migrateStudio(store, config)
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
    store.sqlite.prepare(`INSERT INTO repositories
      (id,owner_user_id,provider,provider_repository_id,name,created_at)
      VALUES (?,?,'github','123','Acme/Private','2026-11-01')`).run(repoId, alice.id)
    store.sqlite.prepare(`INSERT INTO stories
      (id,owner_user_id,repository_id,directory,title,created_at,source_commit_sha)
      VALUES (?,?,?,'story','Private Story','2026-11-01',?)`).run(storyId, alice.id, repoId, pinned)
    store.sqlite.prepare(`INSERT INTO studio_sessions
      (id,owner_user_id,story_id,title,source_commit_sha,status,created_at,updated_at)
      VALUES (?,?,?,'Private Story',?,'paused','2026-11-01','2026-11-01')`)
      .run(jobId, alice.id, storyId, pinned)

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
    store.sqlite.prepare('UPDATE studio_sessions SET status=? WHERE id=?').run('cancelled', jobId)
    assert.equal((await api('GET', undefined, aliceCookie)).body.job.status, 'cancelled')
    assert.equal((await api('POST', payload, aliceCookie)).status, 409)
    store.sqlite.prepare('UPDATE studio_sessions SET status=? WHERE id=?').run('blocked', jobId)
    assert.equal((await api('GET', undefined, aliceCookie)).body.job.status, 'blocked')
    assert.equal((await api('POST', payload, aliceCookie)).status, 409)
    store.sqlite.prepare('UPDATE studio_sessions SET status=? WHERE id=?').run('running', jobId)
    const orphan = await api('GET', undefined, aliceCookie)
    assert.equal(orphan.body.job.status, 'interrupted')
    assert.match(orphan.body.job.reason, /without a pinned request/)
    store.sqlite.prepare('UPDATE studio_sessions SET status=? WHERE id=?').run('completed', jobId)
    assert.equal((await api('GET', undefined, aliceCookie)).status, 409)
    store.sqlite.prepare('UPDATE studio_sessions SET status=? WHERE id=?').run('paused', jobId)
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
    const unclaimed = store.sqlite.prepare(`SELECT status, generation_request_json AS request
      FROM studio_sessions WHERE id=?`).get(jobId) as { status: string; request: string | null }
    assert.equal(unclaimed.status, 'paused')
    assert.equal(unclaimed.request, null)
    assert.equal(existsSync(join(acquired.stateDir, 'generation-server-owner.json')), false)
    unlinkSync(cliCheckpoint)
    // A verified saved scope must bind the eventual fixture start, even if
    // an attacker calls the older start endpoint directly with a new body.
    store.sqlite.prepare('UPDATE studio_sessions SET generation_config_json=? WHERE id=?')
      .run(JSON.stringify({ version: 1, headSha: acquired.headSha,
        task: payload.task, contract: parseGenerationContract(contract),
        limits: { steps: 30 }, model: null }), jobId)
    assert.equal((await api('POST', { ...payload, task: 'Widen the task' }, aliceCookie)).status, 409)
    assert.equal((await api('POST', { ...payload, contract: { ...contract,
      constraints: ['Override author intent'] } }, aliceCookie)).status, 409)
    // Simulate a crash immediately after owner receipt publication but before
    // the request entered SQLite. GET must expose the interrupted ownership,
    // a different request must not take it over, and an identical retry may
    // adopt the same claim without a second thread or CLI writer.
    await claimServerGeneration(acquired, acquired.threadId + ':generation:web', {
      story: acquired.storyRoot, job: jobId, task: payload.task,
      contract: parseGenerationContract(contract), fixture: true, skillsSource: skills,
    })
    const orphaned = await api('GET', undefined, aliceCookie)
    assert.equal(orphaned.body.job.status, 'interrupted')
    assert.match(orphaned.body.job.reason, /without a saved request/)
    assert.equal((await api('POST', { ...payload, task: 'Different task' }, aliceCookie)).status, 409)
    assert.equal((store.sqlite.prepare(`SELECT generation_request_json AS request
      FROM studio_sessions WHERE id=?`).get(jobId) as { request: string | null }).request, null)
    // Subscribe before generation begins: events must arrive on the live SSE
    // connection rather than only being synthesized from a completed POST.
    const liveStream = await generationEventsRequest(auth, store,
      new Request(config.baseURL + '/api/jobs/' + jobId + '/events', {
        headers: { cookie: aliceCookie },
      }), jobId)
    assert.equal(liveStream.status, 200)
    const liveReader = liveStream.body!.getReader()
    const admitted = await api('POST', payload, aliceCookie)
    assert.equal(admitted.status, 202)
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
    assert.equal(ready, true, 'independent agent process must start and drain queued work')
    const liveFirst = await liveReader.read()
    assert.match(new TextDecoder().decode(liveFirst.value), /event: progress\ndata: .*"kind":"started"/)
    const deadline = Date.now() + 30_000
    while (queueRecord(store, jobId)?.phase !== 'finished' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 30))
    }
    assert.equal(queueRecord(store, jobId)?.phase, 'finished', 'agent must finish independently of web traffic')
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
    const events = listGenerationEvents(store, alice.id, jobId, 0)
    assert.deepEqual(events.map(event => event.kind), ['started', 'working', 'verified', 'finished'])
    assert.equal(events[1]?.stage, 'foundation')
    assert.equal(events[2]?.stage, 'foundation')
    assert.equal(events[3]?.status, 'paused')
    assert.ok(events[2]?.files.includes('creative-direction/foundation.md'))
    assert.equal(JSON.stringify(events).includes(root), false, 'no host paths or internal output in progress')
    assert.equal(JSON.stringify(events).includes('tool_calls'), false)
    assert.equal(events.every((event, index) => index === 0 || event.id > events[index - 1]!.id), true)

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
    store.sqlite.close()
    store = openStudioDatabase(join(root, 'studio.sqlite'))
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
    const replayed = listGenerationEvents(store, alice.id, jobId, events[1]!.id)
    assert.deepEqual(replayed.map(event => event.id), events.slice(2).map(event => event.id))
    assert.deepEqual(listGenerationEvents(store, bob.id, jobId, 0), [])
    const reconnected = await generationEventsRequest(restoredAuth, store,
      new Request(config.baseURL + '/api/jobs/' + jobId + '/events', {
        headers: { cookie: aliceCookie, 'Last-Event-ID': String(events[1]!.id) },
      }), jobId)
    assert.equal(reconnected.status, 200)
    const afterRestart = reconnected.body!.getReader()
    assert.match(new TextDecoder().decode((await afterRestart.read()).value),
      new RegExp('id: ' + events[2]!.id + '\\n'))
    await afterRestart.cancel()
    assert.throws(() => appendGenerationEvent(store, alice.id, jobId, {
      kind: 'working', stage: 'foundation', milestone: '../../private',
    }), /Invalid progress milestone/)
    appendGenerationEvent(store, alice.id, jobId, {
      kind: 'verified', stage: 'foundation', files: [
        '/etc/passwd', '../private.md', '.story-inbox/private.md',
        'creative-direction/foundation.md', 'creative-direction/foundation.md',
      ],
    })
    const sanitized = listGenerationEvents(store, alice.id, jobId, events.at(-1)!.id)
    assert.deepEqual(sanitized[0]?.files, ['creative-direction/foundation.md'])
    const pinnedRequest = JSON.parse((store.sqlite.prepare(
      'SELECT generation_request_json AS request FROM studio_sessions WHERE id=?').get(jobId) as { request: string }).request)
    assert.equal(pinnedRequest.fixture, true)
    assert.equal(pinnedRequest.story, acquired.storyRoot)
    assert.equal(pinnedRequest.model, undefined)
    assert.equal(pinnedRequest.provider, undefined)

    // A deliberate, answered specialist question can resume with preserved
    // draft bytes. The very same dirty tree without an answer cannot.
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
      recommendedId: 'existing-canon',
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
    const deliberate = await fixtureJobRequest(restoredAuth, store,
      new Request(config.baseURL + '/api/jobs/' + jobId, { headers: { cookie: aliceCookie } }),
      jobId, config.baseURL)
    assert.equal(deliberate.status, 200)
    const pause = (await deliberate.json() as any).job
    assert.equal(pause.status, 'paused')
    assert.equal(pause.revisionVerified, false)
    assert.equal(pause.recovery, null, 'Answered question is not an unsafe-writer repair prompt')
    assert.match(pause.reason, /creative decision/)
    await answerSpecialistChoice(acquired, pendingChoice.id, pendingChoice.proposalSha256,
      { kind: 'option', optionId: 'existing-canon', note: '' }, 'user:author')
    assert.equal(await safeToResume(acquired, saved.threadId, JSON.stringify(pinnedRequest), false),
      'resume', 'Only an exact settled, answered specialist may continue on preserved draft bytes')
    writeFileSync(pendingDraft, 'tampered while the author was answering')
    await assert.rejects(
      () => safeToResume(acquired, saved.threadId, JSON.stringify(pinnedRequest), false),
      /changed/)
    unlinkSync(pendingDraft)

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
    store.sqlite.prepare("UPDATE studio_sessions SET status='blocked' WHERE id=?").run(jobId)
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

    store.sqlite.prepare('UPDATE studio_sessions SET generation_thread_id=? WHERE id=?')
      .run('unrelated-thread', jobId)
    const conflict = await fixtureJobRequest(restoredAuth, store, new Request(config.baseURL + '/api/jobs/' + jobId, {
      headers: { cookie: aliceCookie },
    }), jobId, config.baseURL)
    assert.equal(conflict.status, 409, 'tampered server thread must fail closed')
  } finally {
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      worker.kill('SIGKILL')
      await once(worker, 'exit')
    }
    store.sqlite.close()
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    removeTestTree(root)
  }
})
