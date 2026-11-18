import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createStudioAuth } from '../src/lib/auth'
import { openStudioDatabase } from './support/studio-database'
import { migrateStudio } from './support/studio-database'
import { githubInitializationRequest } from '../src/lib/github-initialize.server'

const origin = 'http://localhost:3000'
const secret = 'initialize-test-secret-0123456789abcdefghijklmnopqrstuvwxyz'
const config = {
  baseURL: origin, secret,
  github: { clientId: 'app-client', clientSecret: 'app-secret' },
  gitlab: { clientId: 'gitlab', clientSecret: 'gitlab-secret' },
}
const sha = (character: string) => character.repeat(40)

test('initialization is owner-scoped and commit-pinned; rejects LFS and existing Stories before Git operations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-initialize-api-'))
  const store = openStudioDatabase(join(root, 'studio.sqlite'))
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  const commit = sha('a'), treeSha = sha('b'), attrSha = sha('c'), dirSha = sha('d')
  let attrs = ''
  let empty = false
  let alreadyStory = false
  let moved = false
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push(url)
    assert.ok(url.startsWith('https://api.github.com/'))
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-token')
    if (url.includes('/user/installations/12/repositories')) return Response.json({
      total_count: 1, repositories: [{ id: 123, full_name: 'Acme/Repo', permissions: { push: true } }],
    })
    if (url.includes('/user/installations')) return Response.json({
      total_count: 1, installations: [{ id: 12, account: { login: 'Acme', type: 'Organization' },
        repository_selection: 'all', permissions: { contents: 'write' }, suspended_at: null }],
    })
    if (url.endsWith('/repos/Acme/Repo')) return Response.json({ default_branch: 'main' })
    if (url.endsWith('/repos/Acme/Repo/commits/main')) {
      if (empty) return Response.json({ message: 'Git Repository is empty.' }, { status: 409 })
      return Response.json({ sha: moved ? sha('e') : commit, commit: { tree: { sha: treeSha } } })
    }
    if (url.endsWith('/git/trees/' + treeSha)) return Response.json({
      sha: treeSha, truncated: false, tree: [
        { path: 'README.md', type: 'blob', mode: '100644', sha: sha('f'), size: 12 },
        ...(attrs ? [{ path: '.gitattributes', type: 'blob', mode: '100644',
          sha: attrSha, size: Buffer.byteLength(attrs) }] : []),
        ...(alreadyStory ? [{ path: 'story', type: 'tree', mode: '040000', sha: dirSha }] : []),
      ],
    })
    if (url.endsWith('/git/trees/' + dirSha)) return Response.json({
      sha: dirSha, truncated: false, tree: [{ path: 'creative-direction', type: 'tree',
        mode: '040000', sha: sha('1') }],
    })
    if (url.endsWith('/git/trees/' + sha('1'))) return Response.json({
      sha: sha('1'), truncated: false, tree: [{ path: 'foundation.md', type: 'blob',
        mode: '100644', sha: sha('2'), size: 20 }],
    })
    if (url.endsWith('/git/blobs/' + attrSha)) return Response.json({
      encoding: 'base64', content: Buffer.from(attrs).toString('base64'), size: Buffer.byteLength(attrs),
    })
    throw new Error('Unexpected GitHub API: ' + url)
  }
  try {
    await migrateStudio(store, config)
    const auth = createStudioAuth(store, config)
    const context = await auth.$context
    const alice = await context.internalAdapter.createUser({ name: 'Alice',
      email: 'alice@example.test', emailVerified: true }, { method: 'test' })
    const bob = await context.internalAdapter.createUser({ name: 'Bob',
      email: 'bob@example.test', emailVerified: true }, { method: 'test' })
    for (const user of [alice, bob]) {
      await context.internalAdapter.createAccount({ userId: user.id, accountId: user.id,
        providerId: 'github', accessToken: 'test-token' })
    }
    const cookie = async (userId: string) => {
      const session = await context.internalAdapter.createSession(userId)
      return 'better-auth.session_token=' + session.token + '.' +
        createHmac('sha256', secret).update(session.token).digest('base64')
    }
    const aliceCookie = await cookie(alice.id)
    const bobCookie = await cookie(bob.id)
    const repositoryId = '11111111-1111-4111-8111-111111111111'
    await store.persistence.repositories.upsert(alice.id, 'github', '123',
      'Acme/Repo', null, repositoryId, '2026-10-31')
    const get = (session = aliceCookie) => githubInitializationRequest(auth, store,
      new Request(origin + '/api/github/initialize?' + new URLSearchParams({
        repositoryId, directory: 'story',
      }), { headers: { cookie: session } }), origin)
    const post = (body: object, requestOrigin = origin) => githubInitializationRequest(auth, store,
      new Request(origin + '/api/github/initialize', {
        method: 'POST', headers: { cookie: aliceCookie, origin: requestOrigin,
          'content-type': 'application/json' }, body: JSON.stringify(body),
      }), origin)
    assert.equal((await get(bobCookie)).status, 404)
    const available = await get()
    assert.equal(available.status, 200)
    assert.deepEqual((await available.json()).mode, 'branch')
    const base = { repositoryId, directory: 'story', jobId: '22222222-2222-4222-8222-222222222222',
      title: 'A new Story', commit }
    assert.equal((await post(base, 'https://attacker.invalid')).status, 403)
    const foundation = {
      id: 'last-bell', title: base.title, premise: 'An archive mystery',
      central_conflict: 'Whom to trust', genre: 'Mystery', tone: 'Somber',
      player_experience: 'Investigate competing accounts', scope: 'One town',
      decision: 'Preserve the author-approved conflict', body: 'An original Story premise.',
    }
    assert.equal((await post({ ...base, foundation, discoveryApproval: {
      revision: 1, digest: 'f'.repeat(64),
    } })).status, 409, 'unbound model foundation must be refused before validator or Git writes')
    assert.equal((await post({ ...base, foundation: { ...foundation, id: 'BAD' } })).status, 400)
    assert.equal((await post({ ...base, foundation: { ...foundation, title: 'Different title' } })).status, 400)
    const previousNative = process.env.NT_NATIVE_CLI
    process.env.NT_NATIVE_CLI = join(root, 'not-a-validator')
    try {
      assert.equal((await post({ ...base, foundation })).status, 503,
        'an unavailable native validator must prevent the initial Git commit')
    } finally {
      if (previousNative === undefined) delete process.env.NT_NATIVE_CLI
      else process.env.NT_NATIVE_CLI = previousNative
    }
    assert.equal((await post({ ...base, commit: sha('9') })).status, 409)
    assert.equal((await post({ ...base, directory: '../x' })).status, 400)
    assert.equal((await post({ ...base, directory: '.private' })).status, 400)
    assert.equal((await post({ ...base, directory: 'invalid,name' })).status, 400)
    assert.equal((await post({ ...base, directory: 'invalid=name' })).status, 400)
    const invalidTitle = await post({ ...base, title: '' })
    assert.equal(invalidTitle.status, 400)
    assert.equal(invalidTitle.headers.get('x-noveltea-write-outcome'), 'not-attempted',
      'a rejected title must never latch the wizard into an unknown-write state')
    moved = true
    assert.equal((await post(base)).status, 409)
    moved = false
    attrs = '*.md filter=lfs'
    const lfs = await get()
    assert.equal(lfs.status, 422)
    assert.match((await lfs.json()).error, /LFS/)
    attrs = ''
    alreadyStory = true
    const conflict = await get()
    assert.equal(conflict.status, 409)
    assert.match((await conflict.json()).error, /already has Story/)
    alreadyStory = false
    empty = true
    const bootstrap = await get()
    assert.equal(bootstrap.status, 200)
    assert.equal((await bootstrap.json()).mode, 'bootstrap')
    assert.equal((await post(base)).status, 409)
    assert.equal((await store.persistence.dashboard.forOwner(alice.id)).stories.length, 0)
    assert.ok(calls.every(url => !url.includes('test-token')))
  } finally {
    globalThis.fetch = originalFetch
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})
