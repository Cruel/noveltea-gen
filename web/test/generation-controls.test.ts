import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHmac, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { removeTestTree } from '../../test/helpers'
import { openStudioDatabase } from '../src/db/connection'
import { migrateStudio } from '../src/db/migrations'
import { createStudioAuth } from '../src/lib/auth'
import { acquireCachedStory } from '../src/lib/git-cache.server'
import { generationControlRequest } from '../src/lib/generation-controls.server'
import { generationJobRequest } from '../src/lib/fixture-jobs.server'
import { queueGeneration, queueRecord } from '../src/lib/generation-queue.server'
import { parseGenerationContract } from '../../src/generation'
import { readJobControl } from '../../src/job-control'
import { configurePiPolicy, inspectPiPolicy } from '../../src/job-pi-policy'

const skills = resolve(process.env.NT_SKILLS_CHECKOUT ?? '../noveltea-skills')
const config = { baseURL: 'http://localhost:3000',
  secret: 'studio-control-test-secret-0123456789abcdefghijklmnopqrstuvwxyz',
  github: { clientId: 'gh', clientSecret: 'secret' },
  gitlab: { clientId: 'gl', clientSecret: 'secret' } }
const contract = parseGenerationContract({
  scope: { kind: 'full-story', depth: 'composition', targets: [], branches: [] },
  constraints: [], envelope: { presentation: 'Visual novel', hardLimits: [], preferences: [] },
})
const git = (cwd: string, ...args: string[]) => {
  const p = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(p.status, 0, p.stderr)
  return p.stdout.trim()
}

test('authenticated queue pause, pre-start resume and cancellation preserve exact pinned job', {
  skip: !existsSync(join(skills, 'src/cli.ts')), timeout: 180_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-studio-control-'))
  const keys = ['NT_STATE_DIR', 'NT_GIT_CACHE_DIR', 'NT_STUDIO_SKILLS_SOURCE',
    'NT_CONFIG_FILE', 'NT_VALIDATOR_TEST_LEGACY', 'NT_VALIDATOR_CACHE_DIR',
    'NT_SKILL_CACHE_DIR', 'NT_LIVE_GENERATION_IDEA'] as const
  const env = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  process.env.NT_STATE_DIR = join(root, 'durable')
  process.env.NT_GIT_CACHE_DIR = join(root, 'cache')
  process.env.NT_STUDIO_SKILLS_SOURCE = skills
  process.env.NT_CONFIG_FILE = join(root, 'config.json')
  process.env.NT_VALIDATOR_TEST_LEGACY = '1'
  process.env.NT_VALIDATOR_CACHE_DIR = join(root, 'validators')
  process.env.NT_SKILL_CACHE_DIR = join(root, 'snapshots')
  delete process.env.NT_LIVE_GENERATION_IDEA
  writeFileSync(process.env.NT_CONFIG_FILE, JSON.stringify({ novelteaSkills: skills, skillDiscovery: 'explicit-only' }))
  const store = openStudioDatabase(join(root, 'studio.sqlite'))
  try {
    await migrateStudio(store, config)
    const auth = createStudioAuth(store, config)
    const context = await auth.$context
    const author = await context.internalAdapter.createUser({
      name: 'Author', email: 'a@control.test', emailVerified: true,
    }, { method: 'test' })
    const stranger = await context.internalAdapter.createUser({
      name: 'Stranger', email: 'b@control.test', emailVerified: true,
    }, { method: 'test' })
    const cookie = async (id: string) => {
      const session = await context.internalAdapter.createSession(id)
      return 'better-auth.session_token=' + session.token + '.' +
        createHmac('sha256', config.secret).update(session.token).digest('base64')
    }
    const authorCookie = await cookie(author.id)
    const strangerCookie = await cookie(stranger.id)
    const source = join(root, 'source')
    mkdirSync(join(source, 'story'), { recursive: true })
    writeFileSync(join(source, 'story/.gitkeep'), '')
    git(source, 'init', '-q')
    git(source, 'config', 'user.name', 'Author')
    git(source, 'config', 'user.email', 'author@control.test')
    git(source, 'add', '.')
    git(source, 'commit', '-qm', 'Initial Story')
    const sha = git(source, 'rev-parse', 'HEAD')
    const id = randomUUID(), repoId = randomUUID(), storyId = randomUUID()
    const job = await acquireCachedStory({ cacheDirectory: process.env.NT_GIT_CACHE_DIR,
      ownerId: author.id, repositoryId: 'github:111', remoteUrl: 'file://' + source,
      token: '', directory: 'story', commit: sha, jobId: id,
      verifiedSizeBytes: 0, verifiedBlobCount: 1 })
    store.sqlite.prepare(`INSERT INTO repositories
      (id,owner_user_id,provider,provider_repository_id,name,created_at)
      VALUES (?,?,'github','111','Source','now')`).run(repoId, author.id)
    store.sqlite.prepare(`INSERT INTO stories
      (id,owner_user_id,repository_id,directory,title,created_at,source_commit_sha)
      VALUES (?,?,?,'story','Story','now',?)`).run(storyId, author.id, repoId, sha)
    store.sqlite.prepare(`INSERT INTO studio_sessions
      (id,owner_user_id,story_id,title,source_commit_sha,status,created_at,updated_at)
      VALUES (?,?,?,'Job',?,'paused','now','now')`).run(id, author.id, storyId, sha)
    const pinned = { story: job.storyRoot, job: id,
      task: 'Write a mystery foundation', contract, fixture: true, skillsSource: skills }
    queueGeneration(store, author.id, id, 'start', 'prepared', JSON.stringify(pinned),
      job.threadId + ':generation:web')
    const control = async (method: 'GET' | 'POST', cookieHeader?: string, body?: unknown,
      origin = config.baseURL) => {
      const response = await generationControlRequest(auth, store,
        new Request(config.baseURL + '/api/jobs/' + id + '/control', {
          method, headers: { ...(cookieHeader ? { cookie: cookieHeader } : {}), origin,
            'content-type': 'application/json' },
          ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
        }), id, config.baseURL)
      return { status: response.status, body: await response.json() as any }
    }
    assert.equal((await control('GET')).status, 401)
    assert.equal((await control('GET', strangerCookie)).status, 404)
    assert.equal((await control('POST', authorCookie, { action: 'cancel' }, 'https://evil.test')).status, 403)
    assert.equal((await control('POST', authorCookie, { action: 'resume', model: 'override' })).status, 400)
    assert.equal((await control('GET', authorCookie)).body.queue, 'queued')
    assert.equal((await control('POST', authorCookie, { action: 'pause' })).status, 202)
    assert.equal(queueRecord(store, id), undefined)
    assert.equal(await readJobControl(job), 'paused')
    assert.equal((await generationJobRequest(auth, store,
      new Request(config.baseURL + '/api/jobs/' + id, {
        headers: { cookie: authorCookie },
      }), id, config.baseURL)).status, 200)
    assert.equal((await control('POST', authorCookie, { action: 'resume' })).status, 200)
    const deadline = Date.now() + 45_000
    let visible = ''
    while (Date.now() < deadline) {
      const response = await generationJobRequest(auth, store,
        new Request(config.baseURL + '/api/jobs/' + id, {
          headers: { cookie: authorCookie },
        }), id, config.baseURL)
      const statusBody = await response.json() as any
      visible = statusBody.job?.status ?? `HTTP ${response.status}: ${statusBody.error}`
      if (!response.ok || visible === 'paused' || visible === 'interrupted') break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(visible, 'paused')
    assert.equal(queueRecord(store, id)?.phase, 'finished')
    assert.equal((await control('POST', authorCookie, { action: 'budget', limits: { steps: -2 } })).status, 400)
    assert.equal((await control('POST', authorCookie, { action: 'budget', limits: { steps: 100 } })).status, 409,
      'fixture execution cannot impersonate a pinned Pi budget')
    // A crash left files dirty. Merely asking to Retry must not delete files,
    // silently trust the edited HEAD, or replay a possibly interrupted writer.
    store.sqlite.prepare("UPDATE generation_run_queue SET phase='interrupted' WHERE job_id=?")
      .run(id)
    store.sqlite.prepare("UPDATE studio_sessions SET status='running' WHERE id=?").run(id)
    writeFileSync(join(job.worktreeStoryRoot, 'unverified.md'), 'Unfinished specialist edit')
    const unsafe = await control('POST', authorCookie, { action: 'retry' })
    assert.equal(unsafe.status, 409, JSON.stringify(unsafe.body))
    assert.match(unsafe.body.error, /Uncommitted files/)
    assert.equal(queueRecord(store, id)?.phase, 'interrupted')
    assert.ok(existsSync(join(job.worktreeStoryRoot, 'unverified.md')))
    assert.equal((await generationJobRequest(auth, store,
      new Request(config.baseURL + '/api/jobs/' + id, { headers: { cookie: authorCookie } }),
      id, config.baseURL)).status, 200, 'interrupted recovery must remain inspectable')
    assert.equal((await control('POST', authorCookie, { action: 'cancel' })).status, 202)
    assert.equal(await readJobControl(job), 'cancelled')
    assert.equal((await control('POST', authorCookie, { action: 'resume' })).status, 409)
    const response = await generationJobRequest(auth, store,
      new Request(config.baseURL + '/api/jobs/' + id, { headers: { cookie: authorCookie } }),
      id, config.baseURL)
    assert.equal((await response.json() as any).job?.status, 'cancelled')
    // A pinned real-Pi job paused at an assignment boundary may increase, but
    // never lower, its budget without swapping models or resetting usage.
    const piJobId = randomUUID()
    const piJob = await acquireCachedStory({ cacheDirectory: process.env.NT_GIT_CACHE_DIR,
      ownerId: author.id, repositoryId: 'github:111', remoteUrl: 'file://' + source,
      token: '', directory: 'story', commit: sha, jobId: piJobId,
      verifiedSizeBytes: 0, verifiedBlobCount: 1 })
    const piTask = { story: piJob.storyRoot, job: piJobId,
      task: 'Write a mystery foundation', contract, fixture: false,
      provider: 'openai', model: 'gpt-6-luna' }
    const draft = { version: 1, headSha: piJob.headSha, task: piTask.task,
      contract, model: { provider: 'openai', id: 'gpt-6-luna' }, limits: { steps: 2 } }
    store.sqlite.prepare(`INSERT INTO studio_sessions
      (id,owner_user_id,story_id,title,source_commit_sha,status,created_at,updated_at,
       generation_thread_id,generation_request_json,generation_config_json)
      VALUES (?,?,?,'Pi Job',?,'paused','now','now',?,?,?)`)
      .run(piJobId, author.id, storyId, sha, piJob.threadId + ':generation:web',
        JSON.stringify(piTask), JSON.stringify(draft))
    await configurePiPolicy(piJob, { version: 1,
      profile: { provider: 'openai', model: 'gpt-6-luna' }, limits: { steps: 2 } })
    const piControl = async (cookieHeader: string, body: unknown) => {
      const response = await generationControlRequest(auth, store,
        new Request(config.baseURL + '/api/jobs/' + piJobId + '/control', {
          method: 'POST', headers: { cookie: cookieHeader, origin: config.baseURL },
          body: JSON.stringify(body),
        }), piJobId, config.baseURL)
      return { status: response.status, body: await response.json() as any }
    }
    assert.equal((await piControl(strangerCookie, { action: 'budget', limits: { steps: 4 } })).status, 404)
    assert.equal((await piControl(authorCookie, { action: 'budget', limits: { steps: 1 } })).status, 409)
    const higher = await piControl(authorCookie, { action: 'budget',
      limits: { steps: 4, modelCalls: 10 } })
    assert.equal(higher.status, 200, JSON.stringify(higher.body))
    assert.deepEqual(higher.body.limits, { steps: 4, modelCalls: 10 })
    assert.deepEqual((await inspectPiPolicy(piJob)).policy.limits, { steps: 4, modelCalls: 10 })
    assert.deepEqual(JSON.parse((store.sqlite.prepare(`SELECT generation_config_json AS draft
      FROM studio_sessions WHERE id=?`).get(piJobId) as { draft: string }).draft).limits,
      { steps: 4, modelCalls: 10 })
    assert.deepEqual(store.sqlite.pragma('foreign_key_check'), [])
  } finally {
    store.sqlite.close()
    for (const key of keys) {
      if (env[key] === undefined) delete process.env[key]
      else process.env[key] = env[key]
    }
    removeTestTree(root)
  }
})
