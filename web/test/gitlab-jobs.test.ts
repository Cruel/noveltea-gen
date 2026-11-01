import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createStudioAuth } from '../src/lib/auth'
import { openStudioDatabase } from '../src/db/connection'
import { migrateStudio } from '../src/db/migrations'
import { prepareCachedJob } from '../src/lib/cached-jobs.server'
import { allowedGitRemote, gitEnvironment } from '../src/lib/git-cache.server'
import { gitlabJobRequest } from '../src/lib/gitlab-jobs.server'

const origin = 'http://localhost:3000'
const secret = 'gitlab-acquisition-stable-test-secret-012345678901'
const config = {
  baseURL: origin, secret,
  github: { clientId: 'github', clientSecret: 'github-secret' },
  gitlab: { clientId: 'gitlab', clientSecret: 'gitlab-secret' },
}
const sha = (char: string) => char.repeat(40)
const foundation = '---\nschema: \'0.1\'\ntype: creative-direction\nid: creative-direction.foundation\n---\nTest.\n'
function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
function makeRequest(storyId: string, jobId: string, commit: string, cookie = '') {
  return new Request(origin + '/api/gitlab/jobs', {
    method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ storyId, jobId, commit }),
  })
}
async function setupDatabase(root: string) {
  const store = openStudioDatabase(join(root, 'studio.sqlite'))
  await migrateStudio(store, config)
  const auth = createStudioAuth(store, config)
  const ctx = await auth.$context
  const alice = await ctx.internalAdapter.createUser({
    name: 'Alice', email: 'alice@example.test', emailVerified: true,
  }, { method: 'test' })
  const bob = await ctx.internalAdapter.createUser({
    name: 'Bob', email: 'bob@example.test', emailVerified: true,
  }, { method: 'test' })
  await ctx.internalAdapter.createAccount({
    userId: alice.id, providerId: 'gitlab', accountId: 'alice', accessToken: 'gitlab-private-oauth-token',
  })
  const session = async (id: string) => {
    const created = await ctx.internalAdapter.createSession(id)
    return 'better-auth.session_token=' + created.token + '.' +
      createHmac('sha256', secret).update(created.token).digest('base64')
  }
  const repositoryId = randomUUID()
  const storyId = randomUUID()
  const now = new Date().toISOString()
  store.sqlite.prepare(`INSERT INTO repositories
    (id,owner_user_id,provider,provider_repository_id,name,created_at)
    VALUES (?,?,'gitlab','11','Acme/Subgroup/Project',?)`).run(repositoryId, alice.id, now)
  store.sqlite.prepare(`INSERT INTO stories
    (id,owner_user_id,repository_id,directory,title,source_commit_sha,created_at)
    VALUES (?,?,?,'story','Story',?,?)`).run(storyId, alice.id, repositoryId, sha('a'), now)
  return { store, auth, alice, bob, repositoryId, storyId, session }
}
test('GitLab job API rejects foreign jobs and revoked or mismatched revisions before cloning', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-gitlab-job-auth-'))
  const oldFetch = globalThis.fetch
  const oldCache = process.env.NT_GIT_CACHE_DIR
  delete process.env.NT_GIT_CACHE_DIR
  let revoked = false
  let tooLarge = false
  const tracked: string[] = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    tracked.push(url)
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer gitlab-private-oauth-token')
    if (url.includes('/projects?membership=true')) {
      if (revoked) return new Response('', { status: 401 })
      return Response.json([{ id: 11, path_with_namespace: 'Acme/Subgroup/Project',
        name_with_namespace: 'Acme / Subgroup / Project', archived: false }],
      { headers: { 'x-next-page': '' } })
    }
    if (url.endsWith('/projects/11')) return Response.json({
      default_branch: 'main', path_with_namespace: 'Acme/Subgroup/Project', archived: false,
    })
    if (url.includes('/repository/commits/')) return Response.json({ id: sha('a') })
    if (url.includes('/repository/tree?')) {
      const query = new URL(url).searchParams
      assert.equal(query.get('ref'), sha('a'))
      const directory = query.get('path')
      if (!directory) return Response.json([{ id: sha('b'), name: 'story',
        path: 'story', type: 'tree', mode: '040000' }])
      if (directory === 'story') return Response.json([{ id: sha('c'), name: 'creative-direction',
        path: 'story/creative-direction', type: 'tree', mode: '040000' }])
      if (directory === 'story/creative-direction') return Response.json([{ id: sha('d'), name: 'foundation.md',
        path: 'story/creative-direction/foundation.md', type: 'blob', mode: '100644' }])
      return Response.json([])
    }
    if (url.endsWith('/api/graphql')) {
      const vars = JSON.parse(init?.body as string).variables as { ref: string; fullPath: string; paths: string[] }
      assert.equal(vars.ref, sha('a'))
      assert.equal(vars.fullPath, 'Acme/Subgroup/Project')
      return Response.json({ data: { project: { repository: { blobs: { nodes: vars.paths.map(path => ({
        path, size: tooLarge ? 100_000_001 : Buffer.byteLength(foundation),
      })) } } } } })
    }
    if (url.includes('/repository/files/')) return Response.json({
      encoding: 'base64', content: Buffer.from(foundation).toString('base64'),
      blob_id: sha('d'), commit_id: sha('a'),
      file_path: 'story/creative-direction/foundation.md', size: Buffer.byteLength(foundation),
    })
    throw new Error('Unexpected GitLab endpoint ' + url)
  }
  let store: Awaited<ReturnType<typeof setupDatabase>>['store'] | null = null
  try {
    const setup = await setupDatabase(root)
    store = setup.store
    const aliceCookie = await setup.session(setup.alice.id)
    const bobCookie = await setup.session(setup.bob.id)
    const jobId = randomUUID()
    const request = (cookie = aliceCookie, commit = sha('a'), id: string = jobId) =>
      makeRequest(setup.storyId, id, commit, cookie)
    const post = (req: Request) => gitlabJobRequest(setup.auth, setup.store, req, origin)
    assert.equal((await post(request(''))).status, 401)
    assert.equal((await post(request(bobCookie))).status, 409) // No linked GitLab identity
    await (await setup.auth.$context).internalAdapter.createAccount({
      userId: setup.bob.id, providerId: 'gitlab', accountId: 'bob', accessToken: 'gitlab-private-oauth-token',
    })
    assert.equal((await post(request(bobCookie))).status, 404)
    const badOrigin = request()
    badOrigin.headers.set('origin', 'https://evil.invalid')
    assert.equal((await post(badOrigin)).status, 403)
    assert.equal((await post(request(aliceCookie, sha('b')))).status, 409)
    assert.equal((await post(request(aliceCookie, sha('a'), 'bad-job'))).status, 400)
    store.sqlite.prepare('DELETE FROM studio_schema_migrations WHERE version=4').run()
    const unmigrated = await post(request())
    assert.equal(unmigrated.status, 503)
    assert.match((await unmigrated.json()).error, /migrations are pending/)
    store.sqlite.prepare('INSERT INTO studio_schema_migrations (version) VALUES (4)').run()

    // Another user's job ID must never be adopted, even on a shared repository.
    const bobRepo = randomUUID(), bobStory = randomUUID()
    store.sqlite.prepare(`INSERT INTO repositories
      (id,owner_user_id,provider,provider_repository_id,name,created_at)
      VALUES (?,?,'gitlab','12','Other/Project','2026-10-31')`).run(bobRepo, setup.bob.id)
    store.sqlite.prepare(`INSERT INTO stories
      (id,owner_user_id,repository_id,directory,title,source_commit_sha,created_at)
      VALUES (?,?,?,'story','Other Story',?,'2026-10-31')`).run(bobStory, setup.bob.id, bobRepo, sha('a'))
    store.sqlite.prepare(`INSERT INTO studio_sessions
      (id,owner_user_id,story_id,title,status,created_at,updated_at)
      VALUES (?,?,?,'Foreign','paused','2026-10-31','2026-10-31')`)
      .run(jobId, setup.bob.id, bobStory)
    assert.equal((await post(request())).status, 409)
    store.sqlite.prepare('DELETE FROM studio_sessions WHERE id=?').run(jobId)

    revoked = true
    assert.equal((await post(request())).status, 409)
    revoked = false
    tooLarge = true
    assert.equal((await post(request())).status, 422)
    tooLarge = false

    // Successful GitLab OAuth/membership/pinned-content preflight reaches the
    // shared cache seam; absent configuration blocks it before Git transfer.
    const verified = await post(request())
    assert.equal(verified.status, 503, JSON.stringify(await verified.clone().json()))
    assert.match((await verified.json()).error, /NT_GIT_CACHE_DIR/)
    assert.ok(tracked.some(url => url.endsWith('/api/graphql')))
    assert.ok(tracked.some(url => url.includes('/repository/files/')))
    assert.equal((store.sqlite.prepare('SELECT COUNT(*) AS total FROM studio_sessions').get() as { total: number }).total, 0)
    store.sqlite.prepare(`INSERT INTO studio_sessions
      (id,owner_user_id,story_id,title,status,created_at,updated_at)
      VALUES (?,?,?,'Unpinned','paused','2026-10-31','2026-10-31')`)
      .run(jobId, setup.alice.id, setup.storyId)
    assert.equal((await post(request())).status, 409)
  } finally {
    store?.sqlite.close()
    globalThis.fetch = oldFetch
    if (oldCache === undefined) delete process.env.NT_GIT_CACHE_DIR
    else process.env.NT_GIT_CACHE_DIR = oldCache
    rmSync(root, { recursive: true, force: true })
  }
})

test('GitLab OAuth Git credentials are child-only, never embedded in remote URLs or Git config', () => {
  const token = 'sensitive-gitlab-token'
  const env = gitEnvironment('https://gitlab.com/Acme/Subgroup/Project.git', token)
  assert.equal(env.GIT_CONFIG_COUNT, '1')
  assert.equal(env.GIT_CONFIG_KEY_0, 'http.https://gitlab.com/.extraheader')
  assert.equal(env.GIT_CONFIG_VALUE_0,
    'AUTHORIZATION: basic ' + Buffer.from('oauth2:' + token).toString('base64'))
  assert.equal(env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(env.GIT_LFS_SKIP_SMUDGE, '1')
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null')
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1')
  assert.equal(env.GIT_ASKPASS, undefined)
  assert.equal(env.GIT_TRACE, undefined)
  assert.equal(env.GIT_CURL_VERBOSE, undefined)
  assert.equal(gitEnvironment('https://github.com/Acme/Project.git', token).GIT_CONFIG_KEY_0,
    'http.https://github.com/.extraheader')
  assert.throws(() => gitEnvironment('https://gitlab.com/Acme/Project.git', ''), /authorization is missing/)
  assert.equal(allowedGitRemote('https://gitlab.com/Acme/Subgroup/Project.git'), true)
  assert.equal(allowedGitRemote('https://gitlab.com/Acme/Project.git'), true)
  assert.equal(allowedGitRemote('https://github.com/Acme/Project.git'), true)
  for (const remote of [
    'https://gitlab.com/Acme/../Project.git',
    'https://gitlab.com/Acme/%2e%2e/Project.git',
    'https://gitlab.com/Acme/Project.git?access_token=private',
    'https://secret@gitlab.com/Acme/Project.git',
    'https://evil.example/Acme/Project.git',
    'https://gitlab.com.evil.example/Acme/Project.git',
    'https://gitlab.com/Acme/Project.git/extra',
  ]) assert.equal(allowedGitRemote(remote), false, remote)
})

test('shared GitLab job registration creates isolated sparse worktrees and reopens the original SHA', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-gitlab-cache-'))
  const oldState = process.env.NT_STATE_DIR
  const oldCache = process.env.NT_GIT_CACHE_DIR
  process.env.NT_STATE_DIR = join(root, 'state')
  process.env.NT_GIT_CACHE_DIR = join(root, 'cache')
  let store: Awaited<ReturnType<typeof setupDatabase>>['store'] | null = null
  try {
    const remote = join(root, 'remote')
    mkdirSync(remote)
    git(remote, 'init', '-q')
    git(remote, 'config', 'user.email', 'test@example.com')
    git(remote, 'config', 'user.name', 'Test')
    mkdirSync(join(remote, 'story', 'creative-direction'), { recursive: true })
    mkdirSync(join(remote, 'unrelated-assets'))
    writeFileSync(join(remote, 'story', 'creative-direction', 'foundation.md'), foundation)
    writeFileSync(join(remote, 'unrelated-assets', 'video.bin'), Buffer.alloc(1024 * 1024, 1))
    git(remote, 'add', '.'); git(remote, 'commit', '-qm', 'Story')
    const baseline = git(remote, 'rev-parse', 'HEAD')
    const setup = await setupDatabase(root)
    store = setup.store
    setup.store.sqlite.prepare('UPDATE stories SET source_commit_sha=? WHERE id=?').run(baseline, setup.storyId)
    const fileUrl = 'file://' + remote
    const verify = async (row: { repository: string; directory: string; providerId: string }, commit: string) => {
      assert.equal(row.repository, 'Acme/Subgroup/Project')
      assert.equal(row.providerId, '11')
      assert.equal(row.directory, 'story')
      assert.ok([baseline, nextSha].includes(commit))
      return { remoteUrl: fileUrl, sizeBytes: Buffer.byteLength(foundation) +
        (nextSha !== baseline && commit === nextSha ? Buffer.byteLength('Later\n') : 0),
      blobCount: nextSha !== baseline && commit === nextSha ? 2 : 1 }
    }
    let nextSha = baseline
    const jobA = randomUUID(), jobB = randomUUID()
    const run = (jobId: string, commit: string) =>
      prepareCachedJob(setup.store, setup.alice.id, 'test-token', 'gitlab',
        makeRequest(setup.storyId, jobId, commit), verify)
    const [a, b] = await Promise.all([run(jobA, baseline), run(jobB, baseline)])
    assert.equal(a.baseSha, baseline)
    assert.equal(b.baseSha, baseline)
    const cacheOwner = createHash('sha256').update(setup.alice.id).digest('hex')
    const cacheRepo = createHash('sha256').update('gitlab:11').digest('hex')
    const base = join(root, 'cache', cacheOwner, cacheRepo, 'base')
    const objectStore = join(base, '.git')
    assert.equal(existsSync(objectStore), true)
    const dirs = git(base, 'worktree', 'list', '--porcelain')
    assert.equal((dirs.match(/^worktree /gm) || []).length, 3)
    const branches = dirs.match(/^branch .+$/gm) || []
    assert.equal(new Set(branches).size, 2)
    const jobStates = readdirSync(join(root, 'state', 'jobs'))
    assert.equal(jobStates.length, 2)
    const worktrees = readdirSync(join(root, 'cache', cacheOwner, cacheRepo, 'worktrees'))
    assert.equal(worktrees.length, 2)
    const manifests = jobStates.map(name => JSON.parse(
      readFileSync(join(root, 'state', 'jobs', name, 'job.json'), 'utf8'),
    ) as { jobId: string; worktreeRoot: string })
    const pathA = manifests.find(manifest => manifest.jobId === jobA)?.worktreeRoot
    const pathB = manifests.find(manifest => manifest.jobId === jobB)?.worktreeRoot
    assert.ok(pathA && pathB)
    assert.notEqual(pathA, pathB)
    for (const path of [pathA, pathB]) {
      assert.equal(existsSync(join(path, 'unrelated-assets', 'video.bin')), false)
      assert.equal(existsSync(join(path, 'story', 'creative-direction', 'foundation.md')), true)
    }
    writeFileSync(join(pathA, 'story', 'creative-direction', 'foundation.md'), 'Draft A\n')
    assert.equal(readFileSync(join(pathB, 'story', 'creative-direction', 'foundation.md'), 'utf8'), foundation)
    assert.equal((await run(jobA, baseline)).baseSha, baseline)
    assert.equal(readFileSync(join(pathA, 'story', 'creative-direction', 'foundation.md'), 'utf8'), 'Draft A\n')
    for (const name of jobStates) {
      assert.doesNotMatch(readFileSync(join(root, 'state', 'jobs', name, 'job.json'), 'utf8'), /test-token/)
    }
    assert.doesNotMatch(readFileSync(join(objectStore, 'config'), 'utf8'), /test-token/)

    writeFileSync(join(remote, 'story', 'creative-direction', 'later.md'), 'Later\n')
    git(remote, 'add', '.'); git(remote, 'commit', '-qm', 'Later story')
    nextSha = git(remote, 'rev-parse', 'HEAD')
    setup.store.sqlite.prepare('UPDATE stories SET source_commit_sha=? WHERE id=?').run(nextSha, setup.storyId)
    assert.equal((await run(jobA, baseline)).baseSha, baseline)
    await assert.rejects(run(jobA, nextSha), /revision changed/)
    const newJob = await run(randomUUID(), nextSha)
    assert.equal(newJob.baseSha, nextSha)
    assert.equal(readFileSync(join(pathA, 'story', 'creative-direction', 'foundation.md'), 'utf8'), 'Draft A\n')
    assert.equal((setup.store.sqlite.prepare('SELECT COUNT(*) AS total FROM studio_sessions').get() as { total: number }).total, 3)
    await assert.rejects(run(randomUUID(), '1'.repeat(40)), /revision changed/)

    // Reproduce a concurrent request claiming the same UUID while the first
    // request awaits provider preflight. Its conditional INSERT must fail,
    // never report a job belonging to a different pinned source revision.
    const racedJobId = randomUUID()
    await assert.rejects(
      prepareCachedJob(setup.store, setup.alice.id, 'test-token', 'gitlab',
        makeRequest(setup.storyId, racedJobId, nextSha), async (row, commit) => {
          setup.store.sqlite.prepare(`INSERT INTO studio_sessions
            (id,owner_user_id,story_id,title,source_commit_sha,status,created_at,updated_at)
            VALUES (?,?,?,'Raced job',?,'paused','2026-10-31','2026-10-31')`)
            .run(racedJobId, setup.alice.id, setup.storyId, baseline)
          return verify(row, commit)
        }),
      /assigned concurrently/,
    )
    assert.equal((setup.store.sqlite.prepare('SELECT source_commit_sha AS sha FROM studio_sessions WHERE id=?')
      .get(racedJobId) as { sha: string }).sha, baseline)
  } finally {
    store?.sqlite.close()
    if (oldState === undefined) delete process.env.NT_STATE_DIR
    else process.env.NT_STATE_DIR = oldState
    if (oldCache === undefined) delete process.env.NT_GIT_CACHE_DIR
    else process.env.NT_GIT_CACHE_DIR = oldCache
    rmSync(root, { recursive: true, force: true })
  }
})
