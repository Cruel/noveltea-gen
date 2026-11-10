import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHmac, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { removeTestTree } from '../../test/helpers'
import { openStudioDatabase } from './support/studio-database'
import { studioSeed } from './support/studio-seed'
import { migrateStudio } from './support/studio-database'
import { createStudioAuth } from '../src/lib/auth'
import { acquireCachedStory, continueCachedStory } from '../src/lib/git-cache.server'
import { readThreadChat } from '../src/lib/thread-chat.server'
import { githubPublicationRequest } from '../src/lib/github-publication.server'
import { gitlabPublicationRequest } from '../src/lib/gitlab-publication.server'
import type { ThreadPublicationChoice } from '../src/lib/thread-publication.server'
import type { JobStartResult } from '../../src/job'

const secret = 'thread-provider-integration-test-secret-01234567'
const config = {
  baseURL: 'http://localhost:3000', secret,
  github: { clientId: 'github', clientSecret: 'github-secret' },
  gitlab: { clientId: 'gitlab', clientSecret: 'gitlab-secret' },
}
const at = '2026-11-09T00:00:00Z'
function git(path: string, ...args: string[]) {
  const run = spawnSync('git', args, { cwd: path, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  return run.stdout.trim()
}
const event = (body: string) =>
  '---\nschema: "0.1"\ntype: event\nid: event.bell\ntitle: "Bell"\nstatus: draft\n---\n\n' + body + '\n'

for (const provider of ['github', 'gitlab'] as const) {
  test(provider + ' publishes partial Thread checkpoint, updates exactly one linked draft and creates separate draft only on action', {
    timeout: 180_000,
  }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'nt-thread-provider-' + provider + '-'))
    const env = ['NT_STATE_DIR', 'NT_GIT_CACHE_DIR', 'NT_NATIVE_CLI', 'NT_CONFIG_FILE']
    const old = Object.fromEntries(env.map(key => [key, process.env[key]]))
    const originalFetch = globalThis.fetch
    process.env.NT_STATE_DIR = join(root, 'state')
    process.env.NT_GIT_CACHE_DIR = join(root, 'cache')
    process.env.NT_CONFIG_FILE = join(root, 'config.json')
    const cli = join(root, 'noveltea')
    writeFileSync(cli, `#!/usr/bin/env node
if (process.argv.length === 3 && process.argv[2] === '--version') {
  process.stdout.write('1.0.0\\n'); process.exit(0)
}
const base = process.argv[process.argv.indexOf('--base') + 1];
process.stdout.write(JSON.stringify({ protocolVersion: 1, success: true, exitCode: 0,
 diagnostics: [], catalog: { contractRevision: '0.1', records: [], diagnostics: [],
 coverage: {}, authorization: {}, protection: { status: 'checked',
 base, authorizationVerified: false, complete: true, findings: [],
 impact: { changed: [], moved: [], affected: [] } } },
 readiness: { contractRevision: '0.1', stage: 'review', view: 'design',
 design: { stages: {} }, approved: { stages: {} }, outstanding: [] } }))
`)
    chmodSync(cli, 0o755)
    process.env.NT_NATIVE_CLI = cli
    let store = openStudioDatabase(join(root, 'studio.sqlite'))
    let auth: ReturnType<typeof createStudioAuth>
    const source = join(root, 'source')
    const bare = join(root, 'remote.git')
    let upstream = ''
    let writable = true
    let created = 0, updated = 0
    const requests = new Map<string, any>()
    const branchHead = (branch: string) => git(bare, 'rev-parse', 'refs/heads/' + branch)
    const linkedRequests = () => [...requests.values()]
    const refreshed = (request: any) => {
      if (provider === 'github') request.head.sha = branchHead(request.head.ref)
      else request.sha = branchHead(request.source_branch)
      return request
    }
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      const method = init?.method ?? 'GET'
      const body = ['POST', 'PUT', 'PATCH'].includes(method) ? JSON.parse(String(init?.body)) : null
      let value: unknown
      let status = 200
      if (provider === 'github') {
        assert.equal(url.hostname, 'api.github.com')
        if (url.pathname === '/user/installations') value = {
          installations: [{ id: 11, account: { login: 'Acme', type: 'Organization' },
            permissions: { contents: 'write', pull_requests: 'write' }, suspended_at: null,
            repository_selection: 'selected' }], total_count: 1,
        }
        else if (url.pathname === '/user/installations/11/repositories') value = {
          repositories: writable ? [{ id: 123, full_name: 'Acme/Private',
            private: true, permissions: { push: true } }] : [],
          total_count: writable ? 1 : 0,
        }
        else if (url.pathname === '/repos/Acme/Private') value = { id: 123, default_branch: 'main' }
        else if (url.pathname === '/repos/Acme/Private/branches/main')
          value = { commit: { sha: upstream } }
        else if (url.pathname === '/repos/Acme/Private/pulls' && method === 'GET') {
          const requested = url.searchParams.get('head')?.split(':').slice(1).join(':')
          value = linkedRequests().filter(p => p.head.ref === requested).map(refreshed)
        }
        else if (url.pathname === '/repos/Acme/Private/pulls' && method === 'POST') {
          created++
          assert.equal(body.draft, true)
          assert.match(body.body, /Routine reviews not required/)
          const number = 16 + created
          const pr = { number, html_url: 'https://github.com/Acme/Private/pull/' + number,
            state: 'open', draft: true, head: {
              ref: body.head, sha: branchHead(body.head), repo: { id: 123 },
            }, base: { ref: 'main' } }
          requests.set(body.head, pr)
          value = pr; status = 201
        }
        else if (/^\/repos\/Acme\/Private\/pulls\/\d+$/.test(url.pathname)) {
          const number = Number(url.pathname.split('/').at(-1))
          const pr = linkedRequests().find(item => item.number === number)
          assert.ok(pr, 'Previously linked GitHub PR exists')
          if (method === 'PATCH') {
            updated++
            assert.match(body.body, /Pinned upstream base/)
          }
          value = refreshed(pr)
        } else assert.fail('Unexpected GitHub API ' + method + ' ' + url)
      } else {
        assert.equal(url.hostname, 'gitlab.com')
        assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer mock-token')
        if (url.pathname === '/api/v4/projects') value = writable ? [{
          id: 123, path_with_namespace: 'Acme/Private', name_with_namespace: 'Acme / Private',
          archived: false,
        }] : []
        else if (!writable) { status = 403; value = { message: 'Forbidden' } }
        else if (url.pathname === '/api/v4/projects/123') value = {
          id: 123, path_with_namespace: 'Acme/Private',
          default_branch: 'main', archived: false,
        }
        else if (url.pathname === '/api/v4/projects/123/repository/branches/main')
          value = { commit: { id: upstream } }
        else if (url.pathname === '/api/v4/projects/123/merge_requests' && method === 'GET') {
          value = linkedRequests().filter(mr =>
            mr.source_branch === url.searchParams.get('source_branch')).map(refreshed)
        } else if (url.pathname === '/api/v4/projects/123/merge_requests' && method === 'POST') {
          created++
          assert.match(body.description, /Routine reviews not required/)
          const number = 26 + created
          const mr = { iid: number, web_url: 'https://gitlab.com/Acme/Private/-/merge_requests/' + number,
            state: 'opened', draft: true, title: body.title,
            source_branch: body.source_branch, target_branch: body.target_branch,
            source_project_id: 123, target_project_id: 123, sha: branchHead(body.source_branch) }
          requests.set(body.source_branch, mr)
          value = mr; status = 201
        } else if (/^\/api\/v4\/projects\/123\/merge_requests\/\d+$/.test(url.pathname)) {
          const number = Number(url.pathname.split('/').at(-1))
          const mr = linkedRequests().find(item => item.iid === number)
          assert.ok(mr, 'Previously linked GitLab MR exists')
          if (method === 'PUT') {
            updated++
            assert.match(body.description, /Pinned upstream base/)
          }
          value = refreshed(mr)
        } else assert.fail('Unexpected GitLab API ' + method + ' ' + url)
      }
      return new Response(JSON.stringify(value), { status, headers: { 'x-next-page': '' } })
    }

    try {
      await migrateStudio(store, config)
      auth = createStudioAuth(store, config)
      const ctx = await auth.$context
      const alice = await ctx.internalAdapter.createUser({
        name: 'Alice', email: 'alice@example.test', emailVerified: true,
      }, { method: 'test' })
      const bob = await ctx.internalAdapter.createUser({
        name: 'Bob', email: 'bob@example.test', emailVerified: true,
      }, { method: 'test' })
      await ctx.internalAdapter.createAccount({
        userId: alice.id, providerId: provider, accountId: alice.id, accessToken: 'mock-token',
      })
      const cookie = async (userId: string) => {
        const session = await ctx.internalAdapter.createSession(userId)
        return 'better-auth.session_token=' + session.token + '.' +
          createHmac('sha256', secret).update(session.token).digest('base64')
      }
      const aliceCookie = await cookie(alice.id), bobCookie = await cookie(bob.id)
      mkdirSync(join(source, 'story', 'events'), { recursive: true })
      writeFileSync(join(source, 'story', 'events', 'bell.md'), event('Original'))
      git(source, 'init', '-q')
      git(source, 'config', 'user.name', 'Author')
      git(source, 'config', 'user.email', 'author@example.test')
      git(source, 'add', '.')
      git(source, 'commit', '-qm', 'Initial Story')
      git(source, 'branch', '-M', 'main')
      upstream = git(source, 'rev-parse', 'HEAD')
      git(root, 'clone', '-q', '--bare', source, bare)
      const repoId = randomUUID(), storyId = randomUUID(), threadId = randomUUID()
      const seed = studioSeed(store)
      await store.persistence.repositories.upsert(alice.id, provider, '123',
        'Acme/Private', null, repoId, at)
      await store.persistence.onboarding.importStory({
        id: storyId, owner: alice.id, repositoryId: repoId, directory: 'story',
        title: 'Story', createdAt: at, commitSha: upstream,
      })
      await seed.thread({ id: threadId, ownerUserId: alice.id, storyId,
        title: 'Main', activityAt: at, createdAt: at })
      const firstId = randomUUID(), secondId = randomUUID()
      const first = await acquireCachedStory({
        cacheDirectory: process.env.NT_GIT_CACHE_DIR!, ownerId: alice.id,
        repositoryId: provider + ':123', remoteUrl: 'file://' + bare,
        token: '', commit: upstream, directory: 'story', jobId: firstId,
        verifiedSizeBytes: Buffer.byteLength(event('Original')), verifiedBlobCount: 1,
      })
      const providerUrl = 'https://' + (provider === 'github' ? 'github.com/' : 'gitlab.com/') +
        'Acme/Private.git'
      git(first.gitRoot, 'config', 'url.file://' + bare + '.insteadOf', providerUrl)
      git(first.gitRoot, 'remote', 'set-url', 'origin', providerUrl)
      const commit = (job: JobStartResult, description: string) => {
        git(job.worktreeRoot, 'add', '-A', '--', 'story')
        git(job.worktreeRoot, 'commit', '-qm', description)
        const sha = git(job.worktreeRoot, 'rev-parse', 'HEAD')
        mkdirSync(join(job.stateDir, 'revisions'), { recursive: true })
        writeFileSync(join(job.stateDir, 'revisions', 'verified-head.json'),
          JSON.stringify({ version: 1, jobId: job.jobId, headSha: sha, workItemId: 'test' }))
        return sha
      }
      const register = async (job: JobStartResult, order: number, baseSha: string) => {
        await seed.job({ id: job.jobId, ownerUserId: alice.id, storyId,
          title: 'Turn ' + order, status: 'completed', sourceCommitSha: baseSha,
          generationThreadId: job.threadId + ':generation:web',
          generationRequestJson: JSON.stringify({ task: 'Update Story', fixture: true }),
          createdAt: at, updatedAt: at })
        await seed.threadRun({ jobId: job.jobId, ownerUserId: alice.id, threadId, runOrder: order })
        await seed.queue({ jobId: job.jobId, ownerUserId: alice.id,
          intent: 'start', phase: 'finished', createdAt: at, updatedAt: at })
      }

      writeFileSync(join(first.worktreeStoryRoot, 'events', 'bell.md'), event('First Turn'))
      const sha1 = commit(first, 'First verified Turn')
      await register(first, 0, upstream)
      await readThreadChat(store, alice.id, threadId)
      await store.persistence.continuation.settle(alice.id, firstId, sha1, at)
      const api = async (method: 'GET' | 'POST', jobId: string,
        choice?: ThreadPublicationChoice, data?: object, cookieValue = aliceCookie) => {
        const request = new Request(config.baseURL + '/api/jobs/' + jobId + '/publish', {
          method, headers: { cookie: cookieValue, origin: config.baseURL },
          ...(method === 'POST' ? { body: JSON.stringify(data) } : {}),
        })
        const response = provider === 'github'
          ? await githubPublicationRequest(auth, store, request, jobId, config.baseURL, choice)
          : await gitlabPublicationRequest(auth, store, request, jobId, config.baseURL, choice)
        return { code: response.status, data: await response.json() as any }
      }
      const create = { threadId, action: 'create' as const }
      const initial = await api('GET', firstId, create)
      assert.equal(initial.code, 200, JSON.stringify(initial.data))
      assert.equal(initial.data.publication.canPublish, true, JSON.stringify(initial.data))
      assert.equal(initial.data.publication.thread.rootBaseSha, upstream)
      assert.equal((await api('GET', firstId)).code, 409,
        'Job-only endpoint cannot bypass mandatory Thread assurance')
      assert.equal((await api('GET', firstId, create, undefined, bobCookie)).code, 404)
      const firstPayload = { headSha: sha1, targetSha: upstream, allowPartial: true }
      assert.equal((await api('POST', firstId, create, {
        ...firstPayload, headSha: 'f'.repeat(40),
      })).code, 409)
      assert.equal(created, 0)
      assert.equal((await api('POST', firstId, create, firstPayload)).code, 200)
      assert.equal(created, 1)
      assert.equal(branchHead(first.branch), sha1)
      assert.equal(branchHead('main'), upstream)

      const second = await continueCachedStory(first, secondId, sha1)
      writeFileSync(join(second.worktreeStoryRoot, 'events', 'bell.md'), event('Second Turn'))
      const sha2 = commit(second, 'Second verified Turn')
      await register(second, 1, sha1)
      await seed.message({ id: randomUUID(), ownerUserId: alice.id, threadId, sequence: 3,
        role: 'user', status: 'queued', body: 'Continue the Story',
        phase: 'running', jobId: secondId, createdAt: at })
      await store.persistence.continuation.settle(alice.id, secondId, sha2, at)
      assert.equal(branchHead(first.branch), sha1, 'local Turn must not update existing PR/MR')
      assert.equal(created, 1)
      const updateChoice = { threadId, action: 'update' as const, linkJobId: firstId }
      const latest = await api('GET', secondId, updateChoice)
      assert.equal(latest.code, 200, JSON.stringify(latest.data))
      assert.equal(latest.data.publication.canPublish, true, JSON.stringify(latest.data))
      assert.equal(latest.data.publication.headSha, sha2)
      assert.equal(latest.data.publication.branch, first.branch)
      assert.equal(latest.data.publication.targetSha, upstream)
      assert.equal((await api('POST', secondId, updateChoice, {
        headSha: sha2, targetSha: upstream, allowPartial: true,
      }, bobCookie)).code, 404)
      assert.equal((await api('POST', secondId, updateChoice, {
        headSha: sha2, targetSha: 'a'.repeat(40), allowPartial: true,
      })).code, 409)
      assert.equal(branchHead(first.branch), sha1)
      const secondPayload = { headSha: sha2, targetSha: upstream, allowPartial: true }
      assert.equal((await api('POST', secondId, updateChoice, secondPayload)).code, 200)
      assert.equal(created, 1)
      assert.equal(updated, 1)
      assert.equal(branchHead(first.branch), sha2)
      assert.equal(branchHead('main'), upstream)
      assert.equal((await store.persistence.publications.get(alice.id, firstId, provider))?.headSha, sha2)
      assert.equal(await store.persistence.publications.get(alice.id, secondId, provider), null,
        'update preserves first review identity and records published HEAD there')
      store.close()
      store = openStudioDatabase(join(root, 'studio.sqlite'))
      await migrateStudio(store, config)
      auth = createStudioAuth(store, config)
      assert.equal((await api('POST', secondId, updateChoice, secondPayload)).code, 200)
      assert.equal(created, 1, 'retries after restart do not duplicate review requests')
      assert.equal(updated, 2)

      // After updating an earlier draft the author can still explicitly
      // create an independently reviewable draft from the current Turn.
      const separate = await api('GET', secondId, create)
      assert.equal(separate.code, 200, JSON.stringify(separate.data))
      assert.equal(separate.data.publication.canPublish, true)
      assert.equal(separate.data.publication.branch, second.branch)
      assert.equal((await api('POST', secondId, create, secondPayload)).code, 200)
      assert.equal(created, 2)
      assert.equal(branchHead(second.branch), sha2)
      assert.equal((await store.persistence.publications.get(alice.id, secondId, provider))?.number,
        provider === 'github' ? 18 : 28)
      assert.equal((await api('POST', secondId, create, secondPayload)).code, 200)
      assert.equal(created, 2)

      // Changed provider access and upstream targets fail without rewriting
      // the last verified local HEAD, even after an existing publication.
      writable = false
      assert.notEqual((await api('POST', secondId, updateChoice, secondPayload)).code, 200)
      writable = true
      upstream = 'e'.repeat(40)
      assert.equal((await api('POST', secondId, updateChoice, secondPayload)).code, 409)
      upstream = branchHead('main')
      assert.equal(branchHead(first.branch), sha2)
      assert.equal(branchHead(second.branch), sha2)

      // A different remote writer must not be overwritten, even if its HEAD
      // is a descendant of the original published SHA (no force or silent adopt).
      git(source, 'checkout', '-qb', 'external-change')
      writeFileSync(join(source, 'external.md'), 'External author changed remote branch')
      git(source, 'add', 'external.md')
      git(source, 'commit', '-qm', 'External remote change')
      const external = git(source, 'rev-parse', 'HEAD')
      git(source, 'push', 'file://' + bare, 'HEAD:refs/heads/external-check')
      git(bare, 'update-ref', 'refs/heads/' + first.branch, external)
      assert.equal((await api('POST', secondId, updateChoice, secondPayload)).code, 409)
      assert.equal(branchHead(first.branch), external)
      assert.equal(branchHead(second.branch), sha2)
    } finally {
      globalThis.fetch = originalFetch
      store.close()
      for (const [key, value] of Object.entries(old)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      removeTestTree(root)
    }
  })
}
