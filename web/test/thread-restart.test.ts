import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID, createHmac } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { removeTestTree } from '../../test/helpers'
import { openStudioDatabase } from '../src/db/connection'
import { migrateStudio } from '../src/db/migrations'
import { createStudioAuth } from '../src/lib/auth'
import { acquireCachedStory, continueCachedStory } from '../src/lib/git-cache.server'
import { selectedJob, restoreJob, inspectRegisteredJob, generationJobRequest } from '../src/lib/fixture-jobs.server'
import { generationConfigurationRequest } from '../src/lib/generation-config.server'
import { ensureRootThreads, listStoryConversations } from '../src/lib/threads.server'
import { threadRestartRequest, type Upstream } from '../src/lib/thread-restart.server'
import { initialStoryDocument } from '../src/lib/git-cache.server'

const config = { baseURL: 'http://localhost:3000',
  secret: 'restart-thread-test-secret-01234567890123456789',
  github: { clientId: 'test', clientSecret: 'test' }, gitlab: { clientId: 'test', clientSecret: 'test' } }
const contract = { scope: { kind: 'full-story' as const, depth: 'composition' as const, targets: [], branches: [] },
  constraints: [], envelope: { presentation: 'NovelTea visual novel', hardLimits: [], preferences: [] } }
const native = process.env.NT_NATIVE_CLI ?? '/home/thomas/dev/nt/build/cli/linux/noveltea'
const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()

async function setup(canonicalStory = false) {
  const root = mkdtempSync(join(tmpdir(), 'nt-thread-restart-'))
  const old = Object.fromEntries(['NT_STATE_DIR','NT_GIT_CACHE_DIR','NT_CONFIG_FILE','NT_NATIVE_CLI']
    .map(key => [key, process.env[key]]))
  process.env.NT_STATE_DIR = join(root, 'state')
  process.env.NT_GIT_CACHE_DIR = join(root, 'cache')
  process.env.NT_CONFIG_FILE = join(root, 'config.json')
  const db = openStudioDatabase(join(root, 'studio.sqlite'))
  await migrateStudio(db, config)
  const auth = createStudioAuth(db, config), ctx = await auth.$context
  const owner = await ctx.internalAdapter.createUser({ name: 'Owner', email: 'restart-owner@local.test', emailVerified: true }, { method: 'test' })
  const other = await ctx.internalAdapter.createUser({ name: 'Other', email: 'restart-other@local.test', emailVerified: true }, { method: 'test' })
  const cookie = async (id: string) => {
    const session = await ctx.internalAdapter.createSession(id)
    return 'better-auth.session_token=' + session.token + '.' +
      createHmac('sha256', config.secret).update(session.token).digest('base64')
  }
  const ownerCookie = await cookie(owner.id), otherCookie = await cookie(other.id)
  const remote = join(root, 'remote')
  mkdirSync(join(remote, 'story', 'creative-direction'), { recursive: true })
  if (canonicalStory) {
    cpSync(reference, join(remote, 'story'), { recursive: true })
    const foundation = join(remote, 'story', 'creative-direction', 'last-bell.md')
    const original = readFileSync(foundation, 'utf8')
    // Protect one real, initially committed author decision. The selected
    // upstream must not inherit a changed version without fresh approval.
    writeFileSync(foundation, original.replace('origin: agent\n    authority: delegated',
      'origin: user\n    authority: user-protected'))
  } else writeFileSync(join(remote, 'story', 'creative-direction', 'foundation.md'), initialStoryDocument('Restart Story'))
  git(remote, 'init', '-q')
  git(remote, 'config', 'user.name', 'Author')
  git(remote, 'config', 'user.email', 'test@example.local')
  git(remote, 'add', '.')
  git(remote, 'commit', '-qm', 'Original Story')
  const original = git(remote, 'rev-parse', 'HEAD')
  const repoId = randomUUID(), storyId = randomUUID(), sourceId = randomUUID()
  db.sqlite.prepare(`INSERT INTO repositories (id,owner_user_id,provider,provider_repository_id,name,created_at)
    VALUES (?,?,'github','123','Acme/Private','2026-01-01')`).run(repoId, owner.id)
  db.sqlite.prepare(`INSERT INTO stories (id,owner_user_id,repository_id,directory,title,created_at,source_commit_sha)
    VALUES (?,?,?,'story','Restart Story','2026-01-01',?)`).run(storyId, owner.id, repoId, original)
  const parent = await acquireCachedStory({ cacheDirectory: process.env.NT_GIT_CACHE_DIR!,
    ownerId: owner.id, repositoryId: 'github:123', remoteUrl: 'file://' + remote,
    token: '', directory: 'story', commit: original, jobId: sourceId })
  const draft = { version: 1, headSha: original, task: 'Original creative goal',
    contract, limits: { steps: 7 }, model: null }
  const request = { story: parent.storyRoot, job: sourceId, task: draft.task, contract,
    fixture: true }
  db.sqlite.prepare(`INSERT INTO studio_sessions (id,owner_user_id,story_id,title,source_commit_sha,status,
    created_at,updated_at,generation_request_json,generation_thread_id,generation_config_json)
    VALUES (?,?,?,'Original Thread',?,'running','2026-01-01','2026-01-01',?,?,?)`)
    .run(sourceId, owner.id, storyId, original, JSON.stringify(request),
      parent.threadId + ':generation:web', JSON.stringify(draft))
  ensureRootThreads(db, owner.id, storyId)
  const threadId = 'root:' + sourceId
  const later = () => {
    writeFileSync(join(remote, 'story', 'notes.txt'), 'New upstream notes ' + randomUUID() + '\n')
    git(remote, 'add', '.'); git(remote, 'commit', '-qm', 'New upstream')
    return git(remote, 'rev-parse', 'HEAD')
  }
  const lookup = async (): Promise<Upstream> => ({ branch: 'main', sha: git(remote, 'rev-parse', 'HEAD'),
    remoteUrl: 'file://' + remote, token: '' })
  const send = async (thread: string, method: 'POST' | 'GET', body?: unknown, actor = ownerCookie,
    resolver = lookup) => {
    const response = await threadRestartRequest(auth, db, new Request(config.baseURL + '/api/restart', {
      method, headers: { cookie: actor, ...(method === 'POST' ?
        { origin: config.baseURL, 'content-type': 'application/json' } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), thread, config.baseURL, resolver)
    return { status: response.status, body: await response.json() as any }
  }
  const cleanup = () => {
    db.sqlite.close()
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    removeTestTree(root)
  }
  return { root, remote, db, auth, owner, other, ownerCookie, otherCookie, parent, threadId, storyId,
    original, sourceId, later, send, cleanup }
}

test('owner restarts from the original SHA with new Thread/run while live parent and messages stay unchanged', async () => {
  const f = await setup()
  try {
    const newer = f.later()
    const preview = await f.send(f.threadId, 'GET')
    assert.equal(preview.status, 200)
    assert.equal(preview.body.originalSha, f.original)
    assert.equal(preview.body.upstream.sha, newer)
    const selected = { childId: randomUUID(), sourceJobId: f.sourceId, originalSha: f.original,
      selectedSha: f.original, mode: 'original', targetBranch: null }
    const parentDirty = join(f.parent.worktreeStoryRoot, 'uncommitted.txt')
    writeFileSync(parentDirty, 'In-flight parent writer')
    const originalMessages = f.db.sqlite.prepare(`INSERT INTO story_thread_messages
      (id,owner_user_id,thread_id,sequence,role,status,body,phase,created_at)
      VALUES (?,?,?,0,'user','queued','parent steering','queued','now')`)
      .run(randomUUID(), f.owner.id, f.threadId)
    assert.equal(originalMessages.changes, 1)
    const before = git(f.parent.worktreeRoot, 'status', '--porcelain')
    const prepared = await f.send(f.threadId, 'POST', selected)
    assert.equal(prepared.status, 200, JSON.stringify(prepared.body))
    const child = await restoreJob(selectedJob(f.db, f.owner.id, selected.childId), f.owner.id)
    assert.equal(child.baseSha, f.original)
    assert.equal(child.headSha, f.original)
    assert.notEqual(child.threadId, f.parent.threadId)
    assert.notEqual(child.branch, f.parent.branch)
    assert.equal(git(child.worktreeRoot, 'status', '--porcelain'), '')
    assert.equal(git(f.parent.worktreeRoot, 'status', '--porcelain'), before)
    assert.equal(readFileSync(parentDirty, 'utf8'), 'In-flight parent writer')
    assert.equal(existsSync(join(child.stateDir, 'pi-budget.json')), false)
    assert.equal(existsSync(join(child.stateDir, 'web-generation.sqlite')), false)
    assert.equal((await inspectRegisteredJob(f.db, selectedJob(f.db, f.owner.id, selected.childId), f.owner.id)).status, 'prepared')
    const record = selectedJob(f.db, f.owner.id, selected.childId)
    assert.equal(JSON.parse(record.configJson!).task, 'Original creative goal')
    assert.equal(JSON.parse(record.configJson!).limits.steps, 7)
    const conversations = await listStoryConversations(f.db, f.owner.id, f.storyId)
    const all = conversations.conversations.flatMap(c => c.threads)
    const restart = all.find(t => t.id === 'restart:' + selected.childId)
    assert.equal(restart?.parentThreadId, f.threadId)
    assert.equal(restart?.status, 'prepared')
    assert.equal(f.db.sqlite.prepare(`SELECT 1 FROM story_thread_messages
      WHERE thread_id=?`).get('restart:' + selected.childId), undefined,
    'parent future conversation and queued messages are not copied')
    const intent = f.db.sqlite.prepare(`SELECT mode,original_sha AS original,selected_sha AS selected,prepared_at AS ready
      FROM thread_restarts WHERE child_id=?`).get(selected.childId) as any
    assert.equal(intent.mode, 'original')
    assert.equal(intent.original, f.original)
    assert.equal(intent.selected, f.original)
    assert.ok(intent.ready)
    const retry = await f.send(f.threadId, 'POST', selected)
    assert.equal(retry.status, 200)
    assert.equal((await f.send(f.threadId, 'POST', { ...selected, selectedSha: newer, mode: 'newer', targetBranch: 'main' })).status, 409)
    assert.equal((await f.send(f.threadId, 'POST', { ...selected, childId: randomUUID(), originalSha: newer })).status, 400)
    assert.equal((await f.send(f.threadId, 'POST', { ...selected, childId: randomUUID() }, f.otherCookie)).status, 404)
    assert.equal((await f.send(f.threadId, 'POST', { ...selected, childId: randomUUID() }, '')).status, 401)
    assert.equal(git(f.parent.worktreeRoot, 'status', '--porcelain'), before)
    assert.deepEqual(f.db.sqlite.pragma('foreign_key_check'), [])
  } finally { f.cleanup() }
})

test('newer revision requires explicit exact provider SHA and refuses a moving upstream without child allocation', async () => {
  const f = await setup()
  try {
    const rev = f.later(), input = { childId: randomUUID(), sourceJobId: f.sourceId,
      originalSha: f.original, selectedSha: rev, mode: 'newer', targetBranch: 'main' }
    assert.equal((await f.send(f.threadId, 'POST', { ...input, selectedSha: f.original })).status, 400)
    assert.equal((await f.send(f.threadId, 'POST', { ...input, targetBranch: 'other' })).status, 409)
    f.later()
    const invalid = await f.send(f.threadId, 'POST', input)
    assert.equal(invalid.status, 409)
    assert.match(invalid.body.error, /moved/i)
    assert.equal((f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM thread_restarts').get() as { n: number }).n, 0)
    assert.equal(f.db.sqlite.prepare('SELECT 1 FROM studio_sessions WHERE id=?').get(input.childId), undefined)
    assert.equal(git(f.parent.worktreeRoot, 'rev-parse', 'HEAD'), f.original)
    // Even a maliciously selected foreign Thread must not disclose its original SHA.
    assert.equal((await f.send('root:' + randomUUID(), 'GET', undefined, f.otherCookie)).status, 404)
    assert.deepEqual(f.db.sqlite.pragma('foreign_key_check'), [])
  } finally { f.cleanup() }
})

const reference = resolve(process.env.NT_SKILLS_CHECKOUT ?? '/home/thomas/dev/noveltea-skills',
  'fixtures/reference-story')
test('newer restart revalidates canonical Story, protected decisions, exact remote revision and clean independent run',
  { skip: !existsSync(native) || !existsSync(reference), timeout: 100_000 }, async () => {
    const f = await setup(true)
    const previousNative = process.env.NT_NATIVE_CLI
    process.env.NT_NATIVE_CLI = native
    try {
      const latest = f.later()
      const newer = { childId: randomUUID(), sourceJobId: f.sourceId, originalSha: f.original,
        mode: 'newer', selectedSha: latest, targetBranch: 'main' }
      const attempt = await f.send(f.threadId, 'POST', newer)
      assert.equal(attempt.status, 200, JSON.stringify(attempt.body))
      const child = await restoreJob(selectedJob(f.db, f.owner.id, newer.childId), f.owner.id)
      assert.equal(child.baseSha, latest)
      assert.equal(child.headSha, latest)
      assert.equal(existsSync(join(child.worktreeStoryRoot, 'notes.txt')), true)
      assert.equal(existsSync(join(child.stateDir, 'web-generation.sqlite')), false)
      assert.equal(existsSync(join(child.stateDir, 'pi-budget.json')), false)
      assert.equal(git(f.parent.worktreeRoot, 'rev-parse', 'HEAD'), f.original)
      assert.equal(git(child.worktreeRoot, 'status', '--porcelain'), '')
      const inspected = await inspectRegisteredJob(f.db, selectedJob(f.db, f.owner.id, newer.childId), f.owner.id)
      assert.equal(inspected.status, 'prepared')
      assert.equal(inspected.restartSource?.mode, 'newer')
      assert.equal(inspected.restartSource?.originalSha, f.original)
      assert.equal(inspected.restartSource?.selectedSha, latest)
      assert.equal(inspected.restartSource?.targetBranch, 'main')
      const configuration = await generationConfigurationRequest(f.auth, f.db,
        new Request(config.baseURL + '/jobs/' + newer.childId + '/configuration', {
          headers: { cookie: f.ownerCookie },
        }), newer.childId, config.baseURL)
      assert.equal(configuration.status, 200, JSON.stringify(await configuration.clone().json()))
      const settings = (await configuration.json() as { saved: { task: string; contract: unknown; headSha: string } }).saved
      assert.equal(settings.task, 'Original creative goal')
      assert.equal(settings.headSha, latest)
      assert.equal((await f.send(f.threadId, 'POST', newer)).status, 200, 'same ID replay is idempotent')
      const start = await generationJobRequest(f.auth, f.db,
        new Request(config.baseURL + '/jobs/' + newer.childId, {
          method: 'POST', headers: { cookie: f.ownerCookie, origin: config.baseURL,
            'content-type': 'application/json' },
          body: JSON.stringify({ task: settings.task, contract: settings.contract }),
        }), newer.childId, config.baseURL)
      assert.equal(start.status, 202, JSON.stringify(await start.clone().json()))
      assert.equal(git(f.parent.worktreeRoot, 'rev-parse', 'HEAD'), f.original)
      const before = readFileSync(join(f.remote, 'story', 'creative-direction', 'last-bell.md'), 'utf8')
      writeFileSync(join(f.remote, 'story', 'creative-direction', 'last-bell.md'),
        before.replace('repair rather than revenge', 'punishment rather than repair'))
      git(f.remote, 'add', '.'); git(f.remote, 'commit', '-qm', 'Changed protected author choice')
      const changed = { ...newer, childId: randomUUID(), selectedSha: git(f.remote, 'rev-parse', 'HEAD') }
      const refused = await f.send(f.threadId, 'POST', changed)
      assert.equal(refused.status, 409, JSON.stringify(refused.body))
      assert.equal(f.db.sqlite.prepare('SELECT 1 FROM studio_sessions WHERE id=?').get(changed.childId), undefined)
      assert.equal(git(f.parent.worktreeRoot, 'rev-parse', 'HEAD'), f.original)
      assert.deepEqual(f.db.sqlite.pragma('foreign_key_check'), [])
    } finally {
      if (previousNative === undefined) delete process.env.NT_NATIVE_CLI
      else process.env.NT_NATIVE_CLI = previousNative
      f.cleanup()
    }
  })

test('a sequential Thread run still restarts from its first pinned Story SHA and original request', async () => {
  const f = await setup()
  try {
    const newer = f.later(), followId = randomUUID()
    const follow = await acquireCachedStory({ cacheDirectory: process.env.NT_GIT_CACHE_DIR!,
      ownerId: f.owner.id, repositoryId: 'github:123', remoteUrl: 'file://' + f.remote,
      token: '', directory: 'story', commit: newer, jobId: followId })
    f.db.sqlite.prepare(`INSERT INTO studio_sessions
      (id,owner_user_id,story_id,title,source_commit_sha,status,created_at,updated_at,generation_config_json)
      VALUES (?,?,?,'Follow-up',?,'paused','now','now',?)`)
      .run(followId, f.owner.id, f.storyId, newer, JSON.stringify({
        version: 1, headSha: newer, task: 'Second unrelated message', contract,
        model: null, limits: { steps: 12 },
      }))
    f.db.sqlite.prepare(`INSERT INTO story_thread_runs
      (job_id,owner_user_id,thread_id,run_order) VALUES (?,?,?,1)`)
      .run(followId, f.owner.id, f.threadId)
    const preview = await f.send(f.threadId, 'GET')
    assert.equal(preview.status, 200)
    assert.equal(preview.body.originalSha, f.original)
    assert.equal(preview.body.sourceJobId, followId)
    const input = { childId: randomUUID(), sourceJobId: followId,
      originalSha: f.original, selectedSha: f.original, mode: 'original', targetBranch: null }
    const restarted = await f.send(f.threadId, 'POST', input)
    assert.equal(restarted.status, 200, JSON.stringify(restarted.body))
    const child = await restoreJob(selectedJob(f.db, f.owner.id, input.childId), f.owner.id)
    assert.equal(child.baseSha, f.original)
    assert.equal(JSON.parse(selectedJob(f.db, f.owner.id, input.childId).configJson!).task,
      'Original creative goal')
    assert.equal(JSON.parse(selectedJob(f.db, f.owner.id, input.childId).configJson!).limits.steps, 12)
    assert.equal(git(follow.worktreeRoot, 'rev-parse', 'HEAD'), newer)
    assert.deepEqual(f.db.sqlite.pragma('foreign_key_check'), [])
  } finally { f.cleanup() }
})

test('upstream moving during native preflight preserves the source and registers no replacement',
  { skip: !existsSync(native) || !existsSync(reference), timeout: 80_000 }, async () => {
    const f = await setup(true)
    const oldNative = process.env.NT_NATIVE_CLI
    process.env.NT_NATIVE_CLI = native
    try {
      const originalHead = f.later()
      const input = { childId: randomUUID(), sourceJobId: f.sourceId,
        originalSha: f.original, selectedSha: originalHead, mode: 'newer', targetBranch: 'main' }
      let lookups = 0
      const resolver = async (): Promise<Upstream> => {
        lookups++
        if (lookups === 2) f.later()
        return { sha: git(f.remote, 'rev-parse', 'HEAD'), branch: 'main',
          remoteUrl: 'file://' + f.remote, token: '' }
      }
      const refused = await f.send(f.threadId, 'POST', input, f.ownerCookie, resolver)
      assert.equal(refused.status, 409)
      assert.match(refused.body.error, /moved/i)
      assert.equal(lookups, 2)
      assert.equal(f.db.sqlite.prepare('SELECT 1 FROM studio_sessions WHERE id=?').get(input.childId), undefined)
      assert.equal(git(f.parent.worktreeRoot, 'rev-parse', 'HEAD'), f.original)
      assert.equal(git(f.parent.worktreeRoot, 'status', '--porcelain'), '')
      assert.deepEqual(f.db.sqlite.pragma('foreign_key_check'), [])
    } finally {
      if (oldNative === undefined) delete process.env.NT_NATIVE_CLI
      else process.env.NT_NATIVE_CLI = oldNative
      f.cleanup()
    }
  })

test('GitHub restart preview requires an authorized installation and exact repository identity', async () => {
  const f = await setup()
  const originalFetch = globalThis.fetch
  let permitted = false, matching = true
  try {
    const ctx = await f.auth.$context
    await ctx.internalAdapter.createAccount({ userId: f.owner.id, providerId: 'github',
      accountId: 'owner', accessToken: 'mock-restart-token' })
    const revision = f.later()
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer mock-restart-token')
      if (url.includes('/user/installations?')) return Response.json({ total_count: 1,
        installations: [{ id: 42, permissions: { contents: permitted ? 'write' : 'read' },
          suspended_at: null }] })
      if (url.includes('/user/installations/42/repositories')) return Response.json({
        total_count: 1, repositories: [{ id: matching ? 123 : 999, full_name: 'Acme/Private',
          permissions: { push: true }, private: true }],
      })
      if (url.endsWith('/repos/Acme/Private')) return Response.json({
        id: matching ? 123 : 999, default_branch: 'main',
      })
      if (url.endsWith('/repos/Acme/Private/branches/main')) return Response.json({ commit: { sha: revision } })
      throw new Error('Unexpected provider URL: ' + url)
    }
    const request = (method: 'GET' | 'POST', body?: unknown) => new Request(config.baseURL + '/restart', {
      method, headers: { cookie: f.ownerCookie, ...(method === 'POST' ? {
        origin: config.baseURL, 'content-type': 'application/json',
      } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const { threadRestartRequest } = await import('../src/lib/thread-restart.server')
    const noWrite = await threadRestartRequest(f.auth, f.db, request('GET'), f.threadId, config.baseURL)
    assert.equal((await noWrite.json()).upstream, null, 'read-only installation cannot propose a newer revision')
    permitted = true
    matching = false
    const wrongRepo = await threadRestartRequest(f.auth, f.db, request('GET'), f.threadId, config.baseURL)
    assert.equal((await wrongRepo.json()).upstream, null, 'provider identity mismatch must fail closed')
    const input = { childId: randomUUID(), sourceJobId: f.sourceId,
      originalSha: f.original, selectedSha: revision, mode: 'newer', targetBranch: 'main' }
    assert.equal((await threadRestartRequest(f.auth, f.db, request('POST', input), f.threadId, config.baseURL)).status, 409)
    matching = true
    const refreshed = await threadRestartRequest(f.auth, f.db, request('GET'), f.threadId, config.baseURL)
    const preview = await refreshed.json()
    assert.equal(preview.upstream.sha, revision)
    assert.equal(preview.upstream.branch, 'main')
    assert.equal(preview.originalSha, f.original)
    assert.equal((f.db.sqlite.prepare('SELECT count(*) AS n FROM thread_restarts').get() as { n: number }).n, 0)
  } finally { globalThis.fetch = originalFetch; f.cleanup() }
})
