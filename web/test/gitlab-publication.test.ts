import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { removeTestTree } from '../../test/helpers'
import { openStudioDatabase } from './support/studio-database'
import { migrateStudio } from './support/studio-database'
import { createStudioAuth } from '../src/lib/auth'
import { acquireCachedStory, initialStoryDocument } from '../src/lib/git-cache.server'
import { gitlabPublicationRequest } from '../src/lib/gitlab-publication.server'

const secret = 'stable-gitlab-publication-test-secret-0123456789'
const config = {
  baseURL: 'http://localhost:3000', secret,
  github: { clientId: 'github', clientSecret: 'github-secret' },
  gitlab: { clientId: 'gitlab', clientSecret: 'gitlab-secret' },
}
const jobId = '33333333-3333-4333-8333-333333333333'
const skills = resolve(process.env.NT_SKILLS_CHECKOUT ?? join(import.meta.dirname, '../../../noveltea-skills'))
const available = existsSync(join(skills, 'src/cli.ts'))
function git(cwd: string, ...args: string[]) {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  return run.stdout.trim()
}

test('GitLab draft MR publication retains verified work, enforces author review and recovers one MR', {
  skip: !available, timeout: 180_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-gitlab-publish-'))
  const old = Object.fromEntries(['NT_STATE_DIR','NT_GIT_CACHE_DIR',
    'NT_STUDIO_SKILLS_SOURCE','NT_CONFIG_FILE'].map(key => [key, process.env[key]]))
  const oldFetch = globalThis.fetch
  process.env.NT_STATE_DIR = join(root, 'state')
  process.env.NT_GIT_CACHE_DIR = join(root, 'cache')
  process.env.NT_STUDIO_SKILLS_SOURCE = skills
  process.env.NT_CONFIG_FILE = join(root, 'config.json')
  writeFileSync(process.env.NT_CONFIG_FILE, JSON.stringify({ novelteaSkills: skills, skillDiscovery: 'explicit-only' }))
  let store = openStudioDatabase(join(root, 'studio.sqlite'))
  let upstream = ''
  let permission = true
  let created = 0
  let updated = 0
  let mr: any = null
  const bare = join(root, 'remote.git')
  const base = join(root, 'seed')
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    assert.equal(url.hostname, 'gitlab.com')
    const method = init?.method ?? 'GET'
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer mock-gitlab-secret')
    const body = method === 'POST' || method === 'PUT' ? JSON.parse(String(init?.body)) : null
    let value: unknown
    let status = 200
    if (url.pathname === '/api/v4/projects') value = permission ? [{
      id: 123, path_with_namespace: 'Acme/Private', name_with_namespace: 'Acme / Private',
      archived: false,
    }] : []
    else if (!permission) { status = 403; value = { message: 'Forbidden' } }
    else if (url.pathname === '/api/v4/projects/123')
      value = { id: 123, path_with_namespace: 'Acme/Private', archived: false, default_branch: 'main' }
    else if (url.pathname === '/api/v4/projects/123/repository/branches/main')
      value = { commit: { id: upstream } }
    else if (url.pathname === '/api/v4/projects/123/merge_requests' && method === 'GET')
      value = mr ? [mr] : []
    else if (url.pathname === '/api/v4/projects/123/merge_requests' && method === 'POST') {
      created++
      assert.equal(body.source_branch.startsWith('noveltea-gen/'), true)
      assert.equal(body.target_branch, 'main')
      assert.equal(body.title.startsWith('Draft: '), true)
      assert.equal(body.remove_source_branch, false)
      assert.match(body.description, /Outstanding blockers/)
      assert.match(body.description, /Full scoped completion review/)
      mr = { iid: 27, web_url: 'https://gitlab.com/Acme/Private/-/merge_requests/27',
        state: 'opened', draft: true, work_in_progress: true, title: body.title,
        source_project_id: 123, target_project_id: 123,
        source_branch: body.source_branch, target_branch: body.target_branch,
        sha: git(bare, 'rev-parse', 'refs/heads/' + body.source_branch) }
      value = mr; status = 201
    } else if (url.pathname === '/api/v4/projects/123/merge_requests/27' && method === 'PUT') {
      assert.match(body.description, /Canonical validation/)
      updated++
      value = mr
    } else if (url.pathname === '/api/v4/projects/123/merge_requests/27' && method === 'GET') value = mr
    else assert.fail('Unexpected GitLab API ' + method + ' ' + url.toString())
    return new Response(JSON.stringify(value), { status, headers: { 'x-next-page': '' } })
  }
  try {
    await migrateStudio(store, config)
    let auth = createStudioAuth(store, config)
    const ctx = await auth.$context
    const alice = await ctx.internalAdapter.createUser({ name: 'Alice', email: 'alice@gitlab.test',
      emailVerified: true }, { method: 'test' })
    const bob = await ctx.internalAdapter.createUser({ name: 'Bob', email: 'bob@gitlab.test',
      emailVerified: true }, { method: 'test' })
    await ctx.internalAdapter.createAccount({ userId: alice.id, providerId: 'gitlab',
      accountId: alice.id, accessToken: 'mock-gitlab-secret' })
    await ctx.internalAdapter.createAccount({ userId: bob.id, providerId: 'gitlab',
      accountId: bob.id, accessToken: 'mock-gitlab-secret' })
    const cookie = async (id: string) => {
      const session = await ctx.internalAdapter.createSession(id)
      return 'better-auth.session_token=' + session.token + '.' +
        createHmac('sha256', secret).update(session.token).digest('base64')
    }
    const aliceCookie = await cookie(alice.id), bobCookie = await cookie(bob.id)
    mkdirSync(join(base, 'story'), { recursive: true })
    writeFileSync(join(base, 'story', '.gitkeep'), '')
    git(base, 'init', '-q')
    git(base, 'config', 'user.name', 'Author')
    git(base, 'config', 'user.email', 'author@example.test')
    git(base, 'add', '.')
    git(base, 'commit', '-qm', 'Initial empty Story')
    git(base, 'branch', '-M', 'main')
    upstream = git(base, 'rev-parse', 'HEAD')
    git(root, 'clone', '-q', '--bare', base, bare)
    const job = await acquireCachedStory({
      cacheDirectory: process.env.NT_GIT_CACHE_DIR!, ownerId: alice.id,
      repositoryId: 'gitlab:123', remoteUrl: 'file://' + bare,
      token: '', commit: upstream, directory: 'story', jobId,
      verifiedSizeBytes: 0, verifiedBlobCount: 1,
    })
    mkdirSync(join(job.worktreeStoryRoot, 'creative-direction'), { recursive: true })
    writeFileSync(join(job.worktreeStoryRoot, 'creative-direction', 'foundation.md'),
      initialStoryDocument('GitLab Private Story'))
    git(job.worktreeRoot, 'add', 'story/creative-direction/foundation.md')
    git(job.worktreeRoot, '-c', 'user.name=NovelTea', '-c', 'user.email=studio@noveltea.dev',
      'commit', '-qm', 'Draft verified Story')
    const head = git(job.worktreeRoot, 'rev-parse', 'HEAD')
    mkdirSync(join(job.stateDir, 'revisions'), { recursive: true })
    writeFileSync(join(job.stateDir, 'revisions', 'verified-head.json'),
      JSON.stringify({ version: 1, jobId, headSha: head, workItemId: 'foundation' }))
    git(job.gitRoot, 'config', 'url.file://' + bare + '.insteadOf', 'https://gitlab.com/Acme/Private.git')
    git(job.gitRoot, 'remote', 'set-url', 'origin', 'https://gitlab.com/Acme/Private.git')
    const repositoryId = '11111111-1111-4111-8111-111111111111'
    const storyId = '22222222-2222-4222-8222-222222222222'
    await store.persistence.repositories.upsert(alice.id, 'gitlab', '123',
      'Acme/Private', null, repositoryId, '2026-11-01')
    await store.persistence.onboarding.importStory({
      id: storyId, owner: alice.id, repositoryId, directory: 'story',
      title: 'GitLab Private Story', createdAt: '2026-11-01', commitSha: upstream,
    })
    await store.persistence.generation.jobs.register(alice.id, jobId, storyId,
      'GitLab Private Story', upstream, '2026-11-01')

    const api = async (method: 'GET' | 'POST', cookie?: string, body?: unknown, origin = config.baseURL) => {
      const res = await gitlabPublicationRequest(auth, store,
        new Request(config.baseURL + '/api/jobs/' + jobId + '/publish', {
          method, headers: { origin, ...(cookie ? { cookie } : {}) },
          ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
        }), jobId, config.baseURL)
      return { status: res.status, data: await res.json() as any }
    }
    assert.equal((await api('GET')).status, 401)
    assert.equal((await api('GET', bobCookie)).status, 404)
    assert.equal((await api('POST', aliceCookie, {}, 'https://malicious.test')).status, 403)
    assert.equal((await api('POST', aliceCookie, { huge: 'x'.repeat(3000) })).status, 413)
    const viewed = await api('GET', aliceCookie)
    assert.equal(viewed.status, 200, JSON.stringify(viewed.data))
    assert.equal(viewed.data.publication.headSha, head)
    assert.equal(viewed.data.publication.targetSha, upstream)
    assert.equal(viewed.data.publication.canPublish, true, JSON.stringify(viewed.data))
    assert.ok(viewed.data.publication.blockers.length > 0)
    // Uncommitted edits remain visible for inspection, not publishable canon.
    const draft = join(job.worktreeStoryRoot, 'uncommitted.md')
    writeFileSync(draft, 'Not committed')
    const dirty = await api('GET', aliceCookie)
    assert.equal(dirty.status, 200)
    assert.equal(dirty.data.publication.canPublish, false)
    assert.match(dirty.data.publication.blockers.join(' '), /Uncommitted/)
    unlinkSync(draft)
    const payload = { headSha: head, targetSha: upstream, allowPartial: true }
    assert.equal((await api('POST', aliceCookie, { ...payload, allowPartial: false })).status, 409)
    upstream = 'f'.repeat(40)
    assert.equal((await api('POST', aliceCookie, payload)).status, 409)
    upstream = git(base, 'rev-parse', 'HEAD')
    permission = false
    assert.equal((await api('POST', aliceCookie, payload)).status, 403)
    assert.equal(created, 0)
    permission = true
    const hook = join(bare, 'hooks', 'pre-receive')
    writeFileSync(hook, '#!/bin/sh\nexit 1\n')
    chmodSync(hook, 0o755)
    assert.equal((await api('POST', aliceCookie, payload)).status, 409)
    assert.equal(created, 0)
    assert.equal(git(bare, 'branch', '--list', 'noveltea-gen/*'), '')
    assert.equal((await store.testing.records.first<{ phase: string }>('gitlab_publications', { jobId }))?.phase, 'pending')
    unlinkSync(hook)
    const createdResponse = await api('POST', aliceCookie, payload)
    assert.equal(createdResponse.status, 200, JSON.stringify(createdResponse.data))
    assert.equal(createdResponse.data.publication.linked.number, 27)
    assert.equal(created, 1)
    assert.equal(git(bare, 'rev-parse', 'refs/heads/main'), upstream)
    assert.equal(git(bare, 'rev-parse', 'refs/heads/' + job.branch), head)
    store.close()
    store = openStudioDatabase(join(root, 'studio.sqlite'))
    await migrateStudio(store, config)
    auth = createStudioAuth(store, config)
    assert.equal((await api('POST', aliceCookie, payload)).status, 200)
    assert.equal(updated, 1)
    // Lost local linkage after remote CREATE must reconcile the one existing MR.
    ;(await store.testing.records.update('gitlab_publications', { jobId },
      { phase: 'pending', mrIid: null, mrUrl: null }))
    assert.equal((await api('POST', aliceCookie, payload)).status, 200)
    assert.equal(created, 1)
    assert.equal(updated, 2)
    mr.sha = 'e'.repeat(40)
    assert.equal((await api('POST', aliceCookie, payload)).status, 409)
    mr.sha = head
    permission = false
    assert.equal((await api('POST', aliceCookie, payload)).status, 403)
    assert.equal(git(bare, 'rev-parse', 'refs/heads/' + job.branch), head)
    permission = true
    git(base, 'checkout', '-qb', 'diverged')
    writeFileSync(join(base, 'other.md'), 'Unrelated branch')
    git(base, 'add', 'other.md')
    git(base, 'commit', '-qm', 'Divergent history')
    const other = git(base, 'rev-parse', 'HEAD')
    git(base, 'push', 'file://' + bare, 'HEAD:refs/heads/divergence-fixture')
    git(bare, 'update-ref', 'refs/heads/' + job.branch, other)
    assert.equal((await api('POST', aliceCookie, payload)).status, 409)
    assert.equal(git(bare, 'rev-parse', 'refs/heads/' + job.branch), other)
    git(bare, 'update-ref', 'refs/heads/' + job.branch, head)
    mr.draft = false; mr.work_in_progress = false; mr.title = 'Ready for merge'
    assert.equal((await api('POST', aliceCookie, payload)).status, 409)
  } finally {
    globalThis.fetch = oldFetch
    store.close()
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    removeTestTree(root)
  }
})
