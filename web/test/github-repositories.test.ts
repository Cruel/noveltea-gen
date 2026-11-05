import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createStudioAuth } from '../src/lib/auth'
import { openStudioDatabase } from './support/studio-database'
import { migrateStudio } from '../src/db/migrations'
import { githubRepositoryRequest, githubInstallStart, githubInstallCallback } from '../src/lib/github-repositories.server'

const origin = 'http://localhost:3000'
const secret = 'github-repository-tests-012345678901234567890'
const config = {
  baseURL: origin, secret,
  github: { clientId: 'app-client', clientSecret: 'app-secret' },
  gitlab: { clientId: 'gl-client', clientSecret: 'gl-secret' },
}
const installations = { total_count: 2, installations: [
  { id: 12, account: { login: 'Acme', type: 'Organization' }, repository_selection: 'selected', permissions: { contents: 'write' }, suspended_at: null },
  { id: 13, account: { login: 'Other', type: 'Organization' }, repository_selection: 'all', permissions: { contents: 'write' }, suspended_at: null },
] }
const accessible = { total_count: 3, repositories: [
  { id: 100, full_name: 'Acme/Story', permissions: { push: true }, private: true },
  { id: 101, full_name: 'Acme/Viewer', permissions: { push: false }, private: true },
  { id: 102, full_name: 'Acme/Another', permissions: { push: true }, private: false },
] }

test('GitHub App connection: only authenticated, installed push repositories are browsable/importable; pending install resumes without OAuth', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'noveltea-gh-'))
  const store = openStudioDatabase(join(dir, 'studio.sqlite'))
  const original = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    requests.push(url)
    assert.match(url, /^https:\/\/api.github.com\//)
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer mock-secret')
    if (url.includes('/user/installations/12/repositories')) return Response.json(accessible)
    if (url.includes('/user/installations/13/repositories')) return Response.json({ total_count: 0, repositories: [] })
    if (url.includes('/user/installations')) return Response.json(installations)
    throw new Error('unexpected URL')
  }
  try {
    await migrateStudio(store, config)
    const auth = createStudioAuth(store, config)
    const context = await auth.$context
    const alice = await context.internalAdapter.createUser({ name: 'Alice', email: 'alice@example.test', emailVerified: true }, { method: 'test' })
    const bob = await context.internalAdapter.createUser({ name: 'Bob', email: 'bob@example.test', emailVerified: true }, { method: 'test' })
    await context.internalAdapter.createAccount({ userId: alice.id, providerId: 'github', accountId: 'alice', accessToken: 'mock-secret' })
    const makeHeaders = async (userId: string) => {
      const session = await context.internalAdapter.createSession(userId)
      return { cookie: 'better-auth.session_token=' + session.token + '.' + createHmac('sha256', secret).update(session.token).digest('base64'), origin }
    }
    const aliceHeaders = await makeHeaders(alice.id)
    const bobHeaders = await makeHeaders(bob.id)
    const req = (method: string, path: string, headers: { origin: string; cookie?: string } = aliceHeaders, body?: unknown) =>
      new Request(origin + path, { method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const opts = { appSlug: 'noveltea-test', baseURL: origin }
    const list = await githubRepositoryRequest(auth, store, req('GET', '/api/github/repositories'), opts)
    assert.equal(list.status, 200)
    const data = await list.json()
    assert.equal(data.installations.length, 2)
    assert.equal(data.installations[0].selection, 'selected')
    assert.doesNotMatch(JSON.stringify(data), /mock-secret/)
    const page = await githubRepositoryRequest(auth, store, req('GET', '/api/github/repositories?installationId=12&page=1'), opts)
    const pageData = await page.json()
    assert.deepEqual(pageData.repositories.map((r: { fullName: string }) => r.fullName), ['Acme/Story', 'Acme/Another'])
    assert.equal(pageData.total, 3)
    const denied = await githubRepositoryRequest(auth, store, req('POST', '/api/github/repositories', aliceHeaders, { fullName: 'Acme/Viewer' }), opts)
    assert.equal(denied.status, 403)
    assert.equal((await githubRepositoryRequest(auth, store, req('POST', '/api/github/repositories', aliceHeaders, { fullName: 'Acme/Missing' }), opts)).status, 404)
    assert.equal((await githubRepositoryRequest(auth, store, req('POST', '/api/github/repositories', bobHeaders, { fullName: 'Acme/Story' }), opts)).status, 409)
    assert.equal((await githubRepositoryRequest(auth, store, req('GET', '/api/github/repositories', bobHeaders), opts)).status, 409)
    const added = await githubRepositoryRequest(auth, store, req('POST', '/api/github/repositories', aliceHeaders, { fullName: 'https://github.com/Acme/Story.git' }), opts)
    assert.equal(added.status, 200)
    assert.equal((await added.json()).repository.name, 'Acme/Story')
    const repeated = await githubRepositoryRequest(auth, store, req('POST', '/api/github/repositories', aliceHeaders, { fullName: 'Acme/Story' }), opts)
    assert.equal((await repeated.json()).repository.id, (store.sqlite.prepare('SELECT id FROM repositories WHERE owner_user_id = ?').get(alice.id) as { id: string }).id)
    assert.equal((store.sqlite.prepare('SELECT count(*) count FROM repositories').get() as { count: number }).count, 1)
    assert.equal((await githubRepositoryRequest(auth, store, req('GET', '/api/github/repositories', { origin }), opts)).status, 401)
    assert.equal((await githubRepositoryRequest(auth, store, req('POST', '/api/github/repositories', { ...aliceHeaders, origin: 'https://evil.example' }, { fullName: 'Acme/Story' }), opts)).status, 403)
    const begin = await githubInstallStart(auth, store, req('POST', '/api/github/install', aliceHeaders, { fullName: 'Acme/New' }), opts)
    const beginBody = await begin.json()
    const url = new URL(beginBody.url)
    assert.equal(url.hostname, 'github.com')
    assert.equal(url.pathname, '/apps/noveltea-test/installations/new')
    const state = url.searchParams.get('state')
    assert.ok(state)
    const forged = await githubInstallCallback(auth, store, req('GET', '/api/github/install/callback?installation_id=12&state=bogus'), opts)
    assert.match(forged.headers.get('location') || '', /\/dashboard\?addRepository=invalid/)
    // The other user has a real linked GitHub identity too; state ownership
    // must still reject the return instead of relying on a missing token.
    await context.internalAdapter.createAccount({ userId: bob.id, providerId: 'github', accountId: 'bob', accessToken: 'mock-secret' })
    const otherUser = await githubInstallCallback(auth, store, req('GET', '/api/github/install/callback?installation_id=12&state=' + state, bobHeaders), opts)
    assert.match(otherUser.headers.get('location') || '', /\/dashboard\?addRepository=invalid/)
    const callback = await githubInstallCallback(auth, store, req('GET', '/api/github/install/callback?installation_id=12&state=' + state), opts)
    assert.match(callback.headers.get('location') || '', /\/dashboard\?addRepository=pending/)
    const replay = await githubInstallCallback(auth, store, req('GET', '/api/github/install/callback?installation_id=12&state=' + state), opts)
    assert.match(replay.headers.get('location') || '', /\/dashboard\?addRepository=invalid/)
    const pending = await githubRepositoryRequest(auth, store, req('GET', '/api/github/repositories'), opts)
    assert.deepEqual((await pending.json()).pending, ['Acme/New'])
    // GitHub sometimes drops state from setup redirects. The secure, user-bound
    // installation cookie must still finish an authorized import.
    const second = await githubInstallStart(auth, store, req('POST', '/api/github/install', aliceHeaders, { fullName: 'Acme/Another' }), opts)
    const secondUrl = new URL((await second.json()).url)
    const cookie = second.headers.get('set-cookie')?.split(';', 1)[0]
    assert.ok(cookie?.startsWith('nt-gh-install-state='))
    assert.match(second.headers.get('set-cookie')!, /HttpOnly; SameSite=Lax/)
    const returnHeaders = { ...aliceHeaders, cookie: aliceHeaders.cookie + '; ' + cookie }
    const completed = await githubInstallCallback(auth, store,
      req('GET', '/api/github/install/callback?installation_id=12', returnHeaders), opts)
    assert.match(completed.headers.get('location') || '', /\/dashboard\?addRepository=added/)
    assert.match(completed.headers.get('set-cookie') || '', /Max-Age=0/)
    assert.equal((store.sqlite.prepare('SELECT count(*) count FROM repositories').get() as { count: number }).count, 2)
    const rejected = await githubInstallCallback(auth, store,
      req('GET', '/api/github/install/callback?installation_id=12', returnHeaders), opts)
    assert.match(rejected.headers.get('location') || '', /\/dashboard\?addRepository=invalid/)
    const tampered = await githubInstallCallback(auth, store,
      req('GET', '/api/github/install/callback?installation_id=13&state=' + secondUrl.searchParams.get('state')), opts)
    assert.match(tampered.headers.get('location') || '', /\/dashboard\?addRepository=invalid/)
    // A setup redirect with no active installation flow must not mutate the catalog.
    const unsolicited = await githubInstallCallback(auth, store,
      req('GET', '/api/github/install/callback?installation_id=12'), opts)
    assert.match(unsolicited.headers.get('location') || '', /\/dashboard\?addRepository=installed/)
    assert.equal((store.sqlite.prepare('SELECT count(*) count FROM repositories').get() as { count: number }).count, 2)
    assert.ok(requests.every(s => !s.includes('mock-secret')))
    assert.equal(createHash('sha256').update(state).digest('hex').length, 64)
  } finally {
    globalThis.fetch = original
    store.sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
