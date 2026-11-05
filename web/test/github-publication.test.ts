import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { removeTestTree } from '../../test/helpers'
import { openStudioDatabase } from '../src/db/connection'
import { migrateStudio } from '../src/db/migrations'
import { createStudioAuth } from '../src/lib/auth'
import { initializeStoryBranch, initialStoryDocument } from '../src/lib/git-cache.server'
import { githubPublicationRequest } from '../src/lib/github-publication.server'

const secret = 'stable-test-secret-0123456789abcdefghijklmnopqrstuvwxyz'
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

test('authenticated GitHub draft publication previews canonical validation, pushes non-force and reuses PR after restart', {
  skip: !available, timeout: 180_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-github-publish-'))
  const originals = Object.fromEntries(['NT_STATE_DIR','NT_GIT_CACHE_DIR',
    'NT_STUDIO_SKILLS_SOURCE','NT_CONFIG_FILE'].map(k => [k, process.env[k]]))
  const originalFetch = globalThis.fetch
  process.env.NT_STATE_DIR = join(root, 'state')
  process.env.NT_GIT_CACHE_DIR = join(root, 'cache')
  process.env.NT_STUDIO_SKILLS_SOURCE = skills
  process.env.NT_CONFIG_FILE = join(root, 'config.json')
  writeFileSync(process.env.NT_CONFIG_FILE, JSON.stringify({ novelteaSkills: skills, skillDiscovery: 'explicit-only' }))
  let store = openStudioDatabase(join(root, 'studio.sqlite'))
  let remoteTarget = ''
  let created = 0
  let updated = 0
  let pr: any = null
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    assert.equal(url.hostname, 'api.github.com', url.toString())
    const path = url.pathname
    const method = init?.method ?? 'GET'
    const body = method === 'POST' || method === 'PATCH' ? JSON.parse(String(init?.body)) : null
    let value: unknown
    if (path === '/user/installations') value = { installations: [{
      id: 11, account: { login: 'Acme', type: 'Organization' },
      permissions: { contents: 'write', pull_requests: 'write' }, suspended_at: null,
      repository_selection: 'selected',
    }], total_count: 1 }
    else if (path === '/user/installations/11/repositories') value = {
      repositories: [{ id: 123, full_name: 'Acme/Private', private: true,
        permissions: { push: true } }], total_count: 1,
    }
    else if (path === '/repos/Acme/Private') value = { id: 123, default_branch: 'main' }
    else if (path === '/repos/Acme/Private/branches/main') value = { commit: { sha: remoteTarget } }
    else if (path === '/repos/Acme/Private/pulls' && method === 'GET') value = pr ? [pr] : []
    else if (path === '/repos/Acme/Private/pulls' && method === 'POST') {
      created++
      assert.equal(body.draft, true)
      assert.match(body.body, /Outstanding blockers/)
      assert.equal(body.head.startsWith('noveltea-gen/'), true)
      pr = { number: 17, html_url: 'https://github.com/Acme/Private/pull/17',
        state: 'open', draft: true, head: { ref: body.head, sha: git(bare, 'rev-parse', 'refs/heads/' + body.head),
          repo: { id: 123 } }, base: { ref: 'main' } }
      value = pr
    } else if (path === '/repos/Acme/Private/pulls/17' && method === 'PATCH') {
      updated++; value = pr
    } else if (path === '/repos/Acme/Private/pulls/17') value = pr
    else assert.fail('Unexpected mock GitHub endpoint ' + method + ' ' + url)
    return new Response(JSON.stringify(value), { status: method === 'POST' ? 201 : 200 })
  }
  const bare = join(root, 'remote.git')
  try {
    await migrateStudio(store, config)
    let auth = createStudioAuth(store, config)
    const ctx = await auth.$context
    const alice = await ctx.internalAdapter.createUser({
      name: 'Alice', email: 'alice@acme.test', emailVerified: true,
    }, { method: 'test' })
    const bob = await ctx.internalAdapter.createUser({
      name: 'Bob', email: 'bob@acme.test', emailVerified: true,
    }, { method: 'test' })
    await ctx.internalAdapter.createAccount({ userId: alice.id, providerId: 'github',
      accountId: alice.id, accessToken: 'mock-secret' })
    const cookie = async (id: string) => {
      const session = await ctx.internalAdapter.createSession(id)
      return 'better-auth.session_token=' + session.token + '.' +
        createHmac('sha256', secret).update(session.token).digest('base64')
    }
    const aliceCookie = await cookie(alice.id)
    const bobCookie = await cookie(bob.id)
    const base = join(root, 'seed')
    mkdirSync(join(base, 'story'), { recursive: true })
    writeFileSync(join(base, 'story', '.gitkeep'), '')
    git(base, 'init', '-q')
    git(base, 'config', 'user.name', 'Test')
    git(base, 'config', 'user.email', 'test@example.test')
    git(base, 'add', '.')
    git(base, 'commit', '-qm', 'Initial empty Story')
    git(base, 'branch', '-M', 'main')
    remoteTarget = git(base, 'rev-parse', 'HEAD')
    git(root, 'clone', '-q', '--bare', base, bare)
    const foundation = initialStoryDocument('Private Story')
    const initialized = await initializeStoryBranch({
      cacheDirectory: process.env.NT_GIT_CACHE_DIR!, ownerId: alice.id,
      repositoryId: 'github:123', remoteUrl: 'file://' + bare, token: '',
      directory: 'story', commit: remoteTarget, jobId, title: 'Private Story',
      foundationMarkdown: foundation, verifiedSizeBytes: 0, verifiedBlobCount: 1,
    })
    // Exercise actual git push through a repository with an HTTPS origin and a
    // test-local URL rewrite; production credentials are never replaced.
    git(initialized.gitRoot, 'config', 'url.file://' + bare + '.insteadOf',
      'https://github.com/Acme/Private.git')
    git(initialized.gitRoot, 'remote', 'set-url', 'origin', 'https://github.com/Acme/Private.git')
    const digest = createHash('sha256').update(foundation).digest('hex')
    store.sqlite.prepare(`INSERT INTO repositories
      (id,owner_user_id,provider,provider_repository_id,name,created_at)
      VALUES ('11111111-1111-4111-8111-111111111111',?,'github','123','Acme/Private',?)`).run(alice.id, '2026-11-01')
    store.sqlite.prepare(`INSERT INTO stories
      (id,owner_user_id,repository_id,directory,title,created_at,source_commit_sha,initial_content_sha256)
      VALUES ('22222222-2222-4222-8222-222222222222',?,
        '11111111-1111-4111-8111-111111111111','story','Private Story',?,?,?)`)
      .run(alice.id, '2026-11-01', remoteTarget, digest)
    store.sqlite.prepare(`INSERT INTO studio_sessions
      (id,owner_user_id,story_id,title,source_commit_sha,status,created_at,updated_at)
      VALUES (?,?,'22222222-2222-4222-8222-222222222222','Private Story',?,'paused',?,?)`)
      .run(jobId, alice.id, remoteTarget, '2026-11-01', '2026-11-01')

    const api = async (method: 'GET' | 'POST', cookie?: string, body?: unknown, origin = config.baseURL) => {
      const response = await githubPublicationRequest(auth, store,
        new Request(config.baseURL + '/api/jobs/' + jobId + '/publish', {
          method, headers: { origin, ...(cookie ? { cookie } : {}) },
          ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
        }), jobId, config.baseURL)
      return { code: response.status, data: await response.json() as any }
    }
    assert.equal((await api('GET')).code, 401)
    assert.equal((await api('GET', bobCookie)).code, 404)
    assert.equal((await api('POST', aliceCookie, {}, 'https://evil.example')).code, 403)
    assert.equal((await api('POST', aliceCookie, { oversized: 'x'.repeat(3000) })).code, 413)
    const viewed = await api('GET', aliceCookie)
    assert.equal(viewed.code, 200, JSON.stringify(viewed.data))
    assert.equal(viewed.data.publication.headSha, initialized.headSha)
    assert.equal(viewed.data.publication.targetSha, remoteTarget)
    assert.equal(viewed.data.publication.canPublish, true, JSON.stringify(viewed.data))
    assert.ok(viewed.data.publication.blockers.length)
    assert.equal((await api('POST', aliceCookie, { headSha: initialized.headSha,
      targetSha: remoteTarget })).code, 409)
    // The review must reject a stale upstream target before any remote push.
    const oldTarget = remoteTarget
    remoteTarget = 'f'.repeat(40)
    assert.equal((await api('POST', aliceCookie, { headSha: initialized.headSha,
      targetSha: oldTarget, allowPartial: true })).code, 409)
    remoteTarget = oldTarget
    assert.equal(created, 0)
    assert.equal(git(bare, 'branch', '--list', 'noveltea-gen/*'), '')
    const payload = { headSha: initialized.headSha, targetSha: remoteTarget, allowPartial: true }
    const rejectHook = join(bare, 'hooks', 'pre-receive')
    writeFileSync(rejectHook, '#!/bin/sh\nexit 1\n')
    chmodSync(rejectHook, 0o755)
    assert.equal((await api('POST', aliceCookie, payload)).code, 409)
    assert.equal(created, 0)
    assert.equal(git(bare, 'branch', '--list', 'noveltea-gen/*'), '')
    assert.equal((store.sqlite.prepare('SELECT phase FROM github_publications WHERE job_id=?').get(jobId) as any).phase, 'pending')
    unlinkSync(rejectHook)
    const published = await api('POST', aliceCookie, payload)
    assert.equal(published.code, 200, JSON.stringify(published.data))
    assert.equal(published.data.publication.linked.number, 17)
    assert.equal(git(bare, 'rev-parse', 'refs/heads/' + initialized.branch), initialized.headSha)
    assert.equal(git(bare, 'rev-parse', 'refs/heads/main'), remoteTarget)
    // A new server process must use the durable PR linkage rather than create
    // another review for this same job branch.
    store.sqlite.close()
    store = openStudioDatabase(join(root, 'studio.sqlite'))
    await migrateStudio(store, config)
    auth = createStudioAuth(store, config)
    assert.equal((await api('POST', aliceCookie, payload)).code, 200)
    assert.equal(created, 1)
    assert.equal(updated, 1)
    assert.equal((store.sqlite.prepare('SELECT pr_number AS number FROM github_publications').get() as any).number, 17)
    // Simulate loss of the database linkage after a successful remote create;
    // retry must discover the existing PR, not create a duplicate.
    store.sqlite.prepare("UPDATE github_publications SET phase='pending',pr_number=NULL,pr_url=NULL WHERE job_id=?")
      .run(jobId)
    assert.equal((await api('POST', aliceCookie, payload)).code, 200)
    assert.equal(created, 1)
    assert.equal(updated, 2)
    // An independently advanced remote branch must never be force-pushed,
    // overwritten or used to create a replacement PR.
    git(base, 'checkout', '-qb', 'diverged')
    writeFileSync(join(base, 'upstream.md'), 'Concurrent remote change')
    git(base, 'add', 'upstream.md')
    git(base, 'commit', '-qm', 'Concurrent work')
    const divergent = git(base, 'rev-parse', 'HEAD')
    git(base, 'push', 'file://' + bare, 'HEAD:refs/heads/divergence-fixture')
    git(bare, 'update-ref', 'refs/heads/' + initialized.branch, divergent)
    assert.equal((await api('POST', aliceCookie, payload)).code, 409)
    assert.equal(git(bare, 'rev-parse', 'refs/heads/' + initialized.branch), divergent)
    assert.equal(created, 1)
    git(bare, 'update-ref', 'refs/heads/' + initialized.branch, initialized.headSha)
    pr.head.sha = 'e'.repeat(40)
    assert.equal((await api('POST', aliceCookie, payload)).code, 409)
    pr.head.sha = initialized.headSha
    pr.state = 'closed'
    assert.equal((await api('POST', aliceCookie, payload)).code, 409)
    // Corrupt durable revision receipts may not be bypassed by the original
    // one-commit initialization fallback, even when file bytes still match.
    mkdirSync(join(initialized.stateDir, 'revisions'), { recursive: true })
    writeFileSync(join(initialized.stateDir, 'revisions', 'verified-head.json'),
      JSON.stringify({ version: 1, jobId, headSha: 'd'.repeat(40), workItemId: 'bad-receipt' }))
    assert.equal((await api('GET', aliceCookie)).code, 409)
  } finally {
    globalThis.fetch = originalFetch
    store.sqlite.close()
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    removeTestTree(root)
  }
})
