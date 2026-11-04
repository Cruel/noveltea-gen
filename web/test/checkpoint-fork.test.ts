import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHmac, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { removeTestTree } from '../../test/helpers'
import { openStudioDatabase } from '../src/db/connection'
import { migrateStudio } from '../src/db/migrations'
import { createStudioAuth } from '../src/lib/auth'
import { acquireCachedStory } from '../src/lib/git-cache.server'
import { checkpointForkRequest } from '../src/lib/checkpoint-fork.server'
import { generationConfigurationRequest } from '../src/lib/generation-config.server'
import { generationJobRequest } from '../src/lib/fixture-jobs.server'
import { authorizedStoryJob, inspectRegisteredJob, selectedJob } from '../src/lib/fixture-jobs.server'
import { openWebGenerationGraph } from '../../src/web-fixture-runtime'
import { inspectRecoveryCheckpoints } from '../../src/recovery-checkpoints'
import { startStoryJob } from '../../src/job'
import { readRecoveryFork } from '../../src/recovery-fork-state'

const skills = resolve(process.env.NT_SKILLS_CHECKOUT ?? '../noveltea-skills')
const native = process.env.NT_NATIVE_CLI ?? '/home/thomas/dev/nt/build/cli/linux/noveltea'
const available = existsSync(native) && existsSync(join(skills, 'skills'))
const config = { baseURL: 'http://localhost:3000', secret: 'checkpoint-fork-test-secret-0123456789abcdefghijklmnopqrstuvwxyz',
  github: { clientId: 'test', clientSecret: 'test' }, gitlab: { clientId: 'test', clientSecret: 'test' } }
const contract = { scope: { kind: 'partial' as const, depth: 'composition' as const,
  targets: ['arc.truth', 'milestone.disclosure'], branches: ['protect', 'challenge'] },
  constraints: ['The player can protect or challenge the witness'],
  envelope: { presentation: 'Dialogue-led visual novel', hardLimits: [], preferences: [] } }
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

test('authenticated finalized World fork is isolated from a running dirty parent and continues with Character using native validation',
  { skip: !available, timeout: 240_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'nt-checkpoint-fork-'))
    const keys = ['NT_STATE_DIR', 'NT_GIT_CACHE_DIR', 'NT_SKILL_CACHE_DIR', 'NT_CONFIG_FILE',
      'NT_NATIVE_CLI', 'NT_VALIDATOR_TEST_LEGACY', 'NT_STUDIO_SKILLS_SOURCE']
    const old = Object.fromEntries(keys.map(key => [key, process.env[key]]))
    Object.assign(process.env, { NT_STATE_DIR: join(root, 'state'), NT_GIT_CACHE_DIR: join(root, 'cache'),
      NT_SKILL_CACHE_DIR: join(root, 'skills'), NT_CONFIG_FILE: join(root, 'config.json'),
      NT_NATIVE_CLI: native, NT_STUDIO_SKILLS_SOURCE: skills })
    delete process.env.NT_VALIDATOR_TEST_LEGACY
    writeFileSync(process.env.NT_CONFIG_FILE!, JSON.stringify({ novelteaSkills: skills, skillDiscovery: 'explicit-only' }))
    const store = openStudioDatabase(join(root, 'studio.sqlite'))
    try {
      await migrateStudio(store, config)
      const auth = createStudioAuth(store, config), ctx = await auth.$context
      const user = await ctx.internalAdapter.createUser({ name: 'Author', email: 'fork@example.test', emailVerified: true }, { method: 'test' })
      const session = await ctx.internalAdapter.createSession(user.id)
      const cookie = 'better-auth.session_token=' + session.token + '.' + createHmac('sha256', config.secret).update(session.token).digest('base64')
      const repo = join(root, 'remote'), storyId = randomUUID(), parentId = randomUUID(), childId = randomUUID(), repoId = randomUUID()
      mkdirSync(join(repo, 'story'), { recursive: true }); writeFileSync(join(repo, 'story', '.gitkeep'), '')
      git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Author'); git(repo, 'config', 'user.email', 'author@example.test')
      git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'Initial Story')
      const initial = git(repo, 'rev-parse', 'HEAD')
      let parent = await acquireCachedStory({ cacheDirectory: process.env.NT_GIT_CACHE_DIR!, ownerId: user.id,
        repositoryId: 'github:123', remoteUrl: 'file://' + repo, token: '', directory: 'story', commit: initial, jobId: parentId })
      store.sqlite.prepare(`INSERT INTO repositories (id,owner_user_id,provider,provider_repository_id,name,created_at)
        VALUES (?,?,'github','123','Acme/Private','2026-01-01')`).run(repoId, user.id)
      store.sqlite.prepare(`INSERT INTO stories (id,owner_user_id,repository_id,directory,title,created_at,source_commit_sha)
        VALUES (?,?,?,'story','Fork Story','2026-01-01',?)`).run(storyId, user.id, repoId, initial)
      const request = { story: parent.storyRoot, job: parentId, task: 'A missing archive witness; invent unspecified details', contract, fixture: true, skillsSource: skills }
      const draft = { version: 1, headSha: initial, task: request.task, contract, limits: { steps: 100 }, model: null }
      store.sqlite.prepare(`INSERT INTO studio_sessions (id,owner_user_id,story_id,title,source_commit_sha,status,created_at,updated_at,generation_request_json,generation_thread_id,generation_config_json)
        VALUES (?,?,?,'Fork Story',?,'running','2026-01-01','2026-01-01',?,?,?)`).run(parentId, user.id, storyId, initial,
        JSON.stringify(request), parent.threadId + ':generation:web', JSON.stringify(draft))
      const runtime = openWebGenerationGraph(join(parent.stateDir, 'web-generation.sqlite'))
      try {
        const cfg = { configurable: { thread_id: parent.threadId + ':generation:web' }, recursionLimit: 1000 }
        await runtime.graph.updateState(cfg, { request, pauseAfter: 'foundations' })
        const result = await runtime.graph.invoke(null, cfg)
        assert.equal(result.status, 'paused', result.reason ?? '')
      } finally { runtime.saver.db.close() }
      parent = await startStoryJob({ story: parent.storyRoot, job: parentId }, false)
      const world = (await inspectRecoveryCheckpoints(parent)).find(p => p.eligible && p.workItem === 'world-foundations')!
      assert.ok(world)
      assert.equal(JSON.parse(readFileSync(join(parent.stateDir, 'validator.json'), 'utf8')).implementation, 'native-cli')
      writeFileSync(join(parent.worktreeStoryRoot, 'characters', 'unfinished.md'), 'private uncommitted draft')
      mkdirSync(join(parent.stateDir, '.story-job-running'))
      writeFileSync(join(parent.stateDir, '.story-job-running', 'owner.json'), 'live parent lock evidence')
      writeFileSync(join(parent.stateDir, 'pi-budget.json'), 'parent budget evidence')
      const before = { head: git(parent.worktreeRoot, 'rev-parse', 'HEAD'), dirty: git(parent.worktreeRoot, 'status', '--porcelain'),
        database: readFileSync(join(parent.stateDir, 'web-generation.sqlite')) }
      const fork = async (body: unknown, authenticated = true) => {
        const response = await checkpointForkRequest(auth, store, new Request(config.baseURL + '/fork', {
          method: 'POST', headers: { origin: config.baseURL, ...(authenticated ? { cookie } : {}), 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }), parentId, config.baseURL)
        return { status: response.status, body: await response.json() as any }
      }
      const input = { childId, commitSha: world.commitSha, sourceBaseSha: initial }
      const forkCount = () => (store.sqlite.prepare('SELECT COUNT(*) AS n FROM checkpoint_forks').get() as { n: number }).n
      assert.equal(forkCount(), 0)
      assert.equal((await fork(input, false)).status, 401)
      assert.equal((await fork({ ...input, sourceBaseSha: world.commitSha })).status, 409)
      assert.equal((await fork({ ...input, commitSha: initial })).status, 409)
      assert.equal(forkCount(), 0)
      const checkpointPath = join(parent.stateDir, 'recovery-checkpoints', world.commitSha + '.json')
      const authentic = readFileSync(checkpointPath, 'utf8')
      try {
        const forged = JSON.parse(authentic)
        forged.completedWorkItems.push('event-fabricated')
        writeFileSync(checkpointPath, JSON.stringify(forged))
        assert.equal((await fork({ ...input, childId: randomUUID() })).status, 409)
        assert.equal(forkCount(), 0)
      } finally { writeFileSync(checkpointPath, authentic) }
      process.env.NT_NATIVE_CLI = join(root, 'missing-native-validator')
      try {
        assert.equal((await fork({ ...input, childId: randomUUID() })).status, 409)
        assert.equal(forkCount(), 0)
      } finally { process.env.NT_NATIVE_CLI = native }
      const stranger = await ctx.internalAdapter.createUser({ name: 'Other', email: 'fork-other@example.test', emailVerified: true }, { method: 'test' })
      const strangerSession = await ctx.internalAdapter.createSession(stranger.id)
      const strangerCookie = 'better-auth.session_token=' + strangerSession.token + '.' + createHmac('sha256', config.secret).update(strangerSession.token).digest('base64')
      const foreign = await checkpointForkRequest(auth, store, new Request(config.baseURL + '/fork', {
        method: 'POST', headers: { origin: config.baseURL, cookie: strangerCookie, 'content-type': 'application/json' }, body: JSON.stringify(input),
      }), parentId, config.baseURL)
      assert.equal(foreign.status, 404)
      assert.equal(forkCount(), 0)
      const made = await fork(input)
      assert.equal(made.status, 200, JSON.stringify(made.body))
      const child = await authorizedStoryJob(store, user.id, childId)
      assert.equal(child.headSha, world.commitSha)
      assert.notEqual(child.threadId, parent.threadId); assert.notEqual(child.branch, parent.branch)
      assert.equal(git(child.worktreeRoot, 'status', '--porcelain'), '')
      assert.equal(existsSync(join(child.worktreeStoryRoot, 'characters', 'unfinished.md')), false)
      assert.equal(existsSync(join(child.stateDir, 'web-generation.sqlite')), false)
      assert.equal(existsSync(join(child.stateDir, 'pi-budget.json')), false)
      const bundleFile = join(child.stateDir, 'recovery-fork.json')
      const bundleBytes = readFileSync(bundleFile, 'utf8')
      try {
        const tampered = JSON.parse(bundleBytes)
        tampered.completedStages.push({ stage: 'event', milestone: 'milestone.fabricated', status: 'committed', headSha: world.commitSha })
        writeFileSync(bundleFile, JSON.stringify(tampered))
        assert.throws(() => readRecoveryFork(child), /immutable job pin/)
      } finally { writeFileSync(bundleFile, bundleBytes) }
      assert.equal((await fork(input)).body.id, childId)
      assert.equal((await fork({ ...input, commitSha: parent.headSha })).status, 409)
      const inspected = await inspectRegisteredJob(store, selectedJob(store, user.id, childId), user.id)
      assert.equal(inspected.status, 'prepared')
      assert.equal(inspected.forkSource?.nextWorkItem, 'character-foundations')
      const browser = (method: 'GET' | 'PUT' | 'POST', body?: unknown) => new Request(config.baseURL + '/jobs/' + childId, {
        method, headers: { origin: config.baseURL, cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      const configuration = await generationConfigurationRequest(auth, store, browser('GET'), childId, config.baseURL)
      assert.equal(configuration.status, 200)
      const saved = (await configuration.json() as { saved: any }).saved
      assert.equal(saved.headSha, world.commitSha)
      const invalid = await generationConfigurationRequest(auth, store, browser('PUT', {
        ...saved, contract: { ...saved.contract, constraints: ['Changed without plan authorization'] },
      }), childId, config.baseURL)
      assert.equal(invalid.status, 409)
      const updated = { ...saved, task: 'Pursue the witness with a different tone', limits: { steps: 28 }, model: null }
      const update = await generationConfigurationRequest(auth, store, browser('PUT', updated), childId, config.baseURL)
      assert.equal(update.status, 200, JSON.stringify(await update.clone().json()))
      const started = await generationJobRequest(auth, store, browser('POST', {
        task: updated.task, contract: updated.contract,
      }), childId, config.baseURL)
      assert.equal(started.status, 202, JSON.stringify(await started.clone().json()))
      const childRequest = JSON.parse(selectedJob(store, user.id, childId).requestJson!)
      const childRuntime = openWebGenerationGraph(join(child.stateDir, 'web-generation.sqlite'))
      try {
        const cfg = { configurable: { thread_id: child.threadId + ':generation:web' }, recursionLimit: 1000 }
        await childRuntime.graph.updateState(cfg, { request: childRequest, pauseAfter: 'foundations' })
        const result = await childRuntime.graph.invoke(null, cfg)
        assert.equal(result.status, 'paused', result.reason ?? '')
        const messages = git(child.worktreeRoot, 'log', '--format=%B', world.commitSha + '..HEAD')
        assert.match(messages, /NovelTea-Work-Item: character-foundations/)
        assert.doesNotMatch(messages, /NovelTea-Work-Item: (world-foundations|global-architecture|foundation)\n/)
      } finally { childRuntime.saver.db.close() }
      const advancedChild = await startStoryJob({ story: child.storyRoot, job: childId }, false)
      const character = (await inspectRecoveryCheckpoints(advancedChild))
        .find(point => point.eligible && point.workItem === 'character-foundations')
      assert.ok(character, 'the child publishes its own eligible character checkpoint')
      const grandId = randomUUID()
      const grandResponse = await checkpointForkRequest(auth, store, new Request(config.baseURL + '/fork', {
        method: 'POST', headers: { origin: config.baseURL, cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ childId: grandId, commitSha: character.commitSha, sourceBaseSha: child.baseSha }),
      }), childId, config.baseURL)
      assert.equal(grandResponse.status, 200, JSON.stringify(await grandResponse.clone().json()))
      const grand = await authorizedStoryJob(store, user.id, grandId)
      assert.equal(grand.baseSha, character.commitSha)
      assert.equal(git(grand.worktreeRoot, 'status', '--porcelain'), '')
      assert.equal(existsSync(join(grand.stateDir, 'web-generation.sqlite')), false)
      const grandStart = await generationJobRequest(auth, store, new Request(config.baseURL + '/jobs/' + grandId, {
        method: 'POST', headers: { origin: config.baseURL, cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ task: childRequest.task, contract: childRequest.contract }),
      }), grandId, config.baseURL)
      assert.equal(grandStart.status, 202, JSON.stringify(await grandStart.clone().json()))
      const grandRequest = JSON.parse(selectedJob(store, user.id, grandId).requestJson!)
      const grandRuntime = openWebGenerationGraph(join(grand.stateDir, 'web-generation.sqlite'))
      try {
        const cfg = { configurable: { thread_id: grand.threadId + ':generation:web' }, recursionLimit: 1000 }
        await grandRuntime.graph.updateState(cfg, { request: grandRequest, pauseAfter: 'event' })
        const result = await grandRuntime.graph.invoke(null, cfg)
        assert.equal(result.status, 'paused', result.reason ?? '')
        const commits = git(grand.worktreeRoot, 'log', '--format=%B', character.commitSha + '..HEAD')
        assert.match(commits, /NovelTea-Work-Item: event-/)
        assert.doesNotMatch(commits, /NovelTea-Work-Item: (world-foundations|character-foundations)/)
      } finally { grandRuntime.saver.db.close() }
      const advancedGrand = await startStoryJob({ story: grand.storyRoot, job: grandId }, false)
      const event = (await inspectRecoveryCheckpoints(advancedGrand))
        .find(point => point.eligible && point.workItem.startsWith('event-'))
      assert.ok(event, 'the grandchild publishes an independently branchable Event checkpoint')
      const fourthId = randomUUID()
      const fourthResponse = await checkpointForkRequest(auth, store, new Request(config.baseURL + '/fork', {
        method: 'POST', headers: { origin: config.baseURL, cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ childId: fourthId, commitSha: event.commitSha, sourceBaseSha: grand.baseSha }),
      }), grandId, config.baseURL)
      assert.equal(fourthResponse.status, 200, JSON.stringify(await fourthResponse.clone().json()))
      const fourth = await authorizedStoryJob(store, user.id, fourthId)
      assert.equal(fourth.baseSha, event.commitSha)
      const fourthStart = await generationJobRequest(auth, store, new Request(config.baseURL + '/jobs/' + fourthId, {
        method: 'POST', headers: { origin: config.baseURL, cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ task: grandRequest.task, contract: grandRequest.contract }),
      }), fourthId, config.baseURL)
      assert.equal(fourthStart.status, 202, JSON.stringify(await fourthStart.clone().json()))
      const fourthRequest = JSON.parse(selectedJob(store, user.id, fourthId).requestJson!)
      const fourthRuntime = openWebGenerationGraph(join(fourth.stateDir, 'web-generation.sqlite'))
      try {
        const cfg = { configurable: { thread_id: fourth.threadId + ':generation:web' }, recursionLimit: 1000 }
        await fourthRuntime.graph.updateState(cfg, { request: fourthRequest, pauseAfter: 'interactive' })
        const result = await fourthRuntime.graph.invoke(null, cfg)
        assert.equal(result.status, 'paused', result.reason ?? '')
        const commits = git(fourth.worktreeRoot, 'log', '--format=%B', event.commitSha + '..HEAD')
        assert.match(commits, /NovelTea-Work-Item: interactive-/)
        assert.doesNotMatch(commits, /NovelTea-Work-Item: (world-foundations|character-foundations|event-)/)
      } finally { fourthRuntime.saver.db.close() }
      const advancedFourth = await startStoryJob({ story: fourth.storyRoot, job: fourthId }, false)
      const interactivePoints = await inspectRecoveryCheckpoints(advancedFourth)
      const choice = interactivePoints.find(point => point.eligible && point.workItem.startsWith('interactive-choice-'))
      const puzzle = interactivePoints.find(point => point.eligible && point.workItem.startsWith('interactive-puzzle-'))
      assert.ok(choice, 'Choice remains branchable after Puzzle has committed')
      assert.ok(puzzle, 'Puzzle is finalized for a Composition continuation')
      const fifthId = randomUUID()
      const fifthResponse = await checkpointForkRequest(auth, store, new Request(config.baseURL + '/fork', {
        method: 'POST', headers: { origin: config.baseURL, cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ childId: fifthId, commitSha: choice.commitSha, sourceBaseSha: fourth.baseSha }),
      }), fourthId, config.baseURL)
      assert.equal(fifthResponse.status, 200, JSON.stringify(await fifthResponse.clone().json()))
      const fifth = await authorizedStoryJob(store, user.id, fifthId)
      assert.equal(fifth.baseSha, choice.commitSha)
      const fifthRuntime = openWebGenerationGraph(join(fifth.stateDir, 'web-generation.sqlite'))
      try {
        const cfg = { configurable: { thread_id: fifth.threadId + ':generation:web' }, recursionLimit: 1000 }
        await fifthRuntime.graph.updateState(cfg, { request: { ...fourthRequest, job: fifthId }, pauseAfter: 'interactive' })
        const result = await fifthRuntime.graph.invoke(null, cfg)
        assert.equal(result.status, 'paused', result.reason ?? '')
        const commits = git(fifth.worktreeRoot, 'log', '--format=%B', choice.commitSha + '..HEAD')
        assert.match(commits, /NovelTea-Work-Item: interactive-puzzle-/)
        assert.doesNotMatch(commits, /NovelTea-Work-Item: (interactive-choice-|event-|character-foundations|world-foundations)/)
      } finally { fifthRuntime.saver.db.close() }
      const sixthId = randomUUID()
      const sixthResponse = await checkpointForkRequest(auth, store, new Request(config.baseURL + '/fork', {
        method: 'POST', headers: { origin: config.baseURL, cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ childId: sixthId, commitSha: puzzle.commitSha, sourceBaseSha: fourth.baseSha }),
      }), fourthId, config.baseURL)
      assert.equal(sixthResponse.status, 200, JSON.stringify(await sixthResponse.clone().json()))
      const sixth = await authorizedStoryJob(store, user.id, sixthId)
      assert.equal(sixth.baseSha, puzzle.commitSha)
      const sixthRuntime = openWebGenerationGraph(join(sixth.stateDir, 'web-generation.sqlite'))
      try {
        const cfg = { configurable: { thread_id: sixth.threadId + ':generation:web' }, recursionLimit: 1000 }
        await sixthRuntime.graph.updateState(cfg, { request: { ...fourthRequest, job: sixthId }, pauseAfter: 'composition' })
        const result = await sixthRuntime.graph.invoke(null, cfg)
        assert.equal(result.status, 'paused', result.reason ?? '')
        const commits = git(sixth.worktreeRoot, 'log', '--format=%B', puzzle.commitSha + '..HEAD')
        assert.match(commits, /NovelTea-Work-Item: composition-/)
        assert.doesNotMatch(commits, /NovelTea-Work-Item: (interactive-|event-|character-foundations|world-foundations)/)
      } finally { sixthRuntime.saver.db.close() }
      assert.equal(git(parent.worktreeRoot, 'rev-parse', 'HEAD'), before.head)
      assert.equal(git(parent.worktreeRoot, 'status', '--porcelain'), before.dirty)
      assert.deepEqual(readFileSync(join(parent.stateDir, 'web-generation.sqlite')), before.database)
      assert.equal(readFileSync(join(parent.stateDir, '.story-job-running', 'owner.json'), 'utf8'), 'live parent lock evidence')
      assert.equal(readFileSync(join(parent.stateDir, 'pi-budget.json'), 'utf8'), 'parent budget evidence')
    } finally {
      store.sqlite.close()
      for (const key of keys) if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]
      removeTestTree(root)
    }
  })
