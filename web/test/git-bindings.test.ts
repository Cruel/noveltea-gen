import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openStudioDatabase } from '../src/db/connection'
import { migrateStudio } from '../src/db/migrations'
import { createStudioAuth } from '../src/lib/auth'
import { getRepositoryToken } from '../src/lib/access.server'
import { githubRepositoryRequest } from '../src/lib/github-repositories.server'
import { gitlabRepositoryRequest } from '../src/lib/gitlab-repositories.server'
import { gitConnectionCallback, gitConnectionRequest } from '../src/lib/git-connections.server'
import { settingsRequest } from '../src/lib/settings.server'

const origin = 'http://localhost:3000'
const config = {
  baseURL: origin,
  secret: 'production-binding-review-test-0123456789012345',
  github: { clientId: 'github-test', clientSecret: 'github-secret' },
  gitlab: { clientId: 'gitlab-test', clientSecret: 'gitlab-secret' },
}
const uuid = (suffix: number) => 'aaaaaaaa-aaaa-4aaa-8aaa-' + String(suffix).padStart(12, '0')
test('repository identities persist across imports, verified rebinding and login unlinking', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nt-bindings-'))
  const store = openStudioDatabase(join(directory, 'studio.sqlite'))
  const originalFetch = globalThis.fetch
  const env = ['BETTER_AUTH_URL', 'BETTER_AUTH_SECRET', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET',
    'GITLAB_CLIENT_ID', 'GITLAB_CLIENT_SECRET'] as const
  const saved = Object.fromEntries(env.map(key => [key, process.env[key]])) as Record<string, string | undefined>
  Object.assign(process.env, {
    BETTER_AUTH_URL: config.baseURL, BETTER_AUTH_SECRET: config.secret,
    GITHUB_CLIENT_ID: config.github.clientId, GITHUB_CLIENT_SECRET: config.github.clientSecret,
    GITLAB_CLIENT_ID: config.gitlab.clientId, GITLAB_CLIENT_SECRET: config.gitlab.clientSecret,
  })
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === 'https://github.com/login/oauth/access_token')
      return Response.json({ access_token: 'gh-integrated', refresh_token: 'gh-refresh', expires_in: 3600 })
    if (url === 'https://gitlab.com/oauth/token')
      return Response.json({ access_token: 'gl-integrated', refresh_token: 'gl-refresh', expires_in: 3600 })
    if (url === 'https://api.github.com/user') return Response.json({ id: 42, login: 'alice' })
    if (url === 'https://gitlab.com/api/v4/user') return Response.json({ id: 43, username: 'alice' })
    if (url.startsWith('https://api.github.com/user/installations/12/repositories')) {
      return Response.json({ total_count: 2, repositories: [
        { id: 100, full_name: 'Acme/Story', permissions: { push: true }, private: true },
        { id: 101, full_name: 'Acme/Legacy', permissions: { push: true }, private: true },
      ] })
    }
    if (url.startsWith('https://api.github.com/user/installations?')) {
      return Response.json({ total_count: 1, installations: [{
        id: 12, account: { login: 'Acme', type: 'Organization' }, repository_selection: 'selected',
        permissions: { contents: 'write' }, suspended_at: null,
      }] })
    }
    if (url.startsWith('https://gitlab.com/api/v4/projects?')) {
      return Response.json([
        { id: 20, path_with_namespace: 'Acme/GL', name_with_namespace: 'Acme / GL',
          visibility: 'private', archived: false },
      ], { headers: { 'x-next-page': '' } })
    }
    throw new Error('Unexpected mocked provider request ' + url + ' ' + JSON.stringify(init?.method))
  }
  try {
    await migrateStudio(store, config)
    const auth = createStudioAuth(store, config)
    const ctx = await auth.$context
    const alice = await ctx.internalAdapter.createUser({
      name: 'Alice', email: 'alice@demo.test', emailVerified: true,
    }, { method: 'test' })
    const bob = await ctx.internalAdapter.createUser({
      name: 'Bob', email: 'bob@demo.test', emailVerified: true,
    }, { method: 'test' })
    const ghLogin = await ctx.internalAdapter.createAccount({
      userId: alice.id, providerId: 'github', accountId: 'alice-login', accessToken: 'legacy-gh',
    })
    await ctx.internalAdapter.createAccount({
      userId: alice.id, providerId: 'gitlab', accountId: 'alice-login', accessToken: 'legacy-gl',
    })
    const cookie = async (user: string) => {
      const session = await ctx.internalAdapter.createSession(user)
      return 'better-auth.session_token=' + session.token + '.' +
        createHmac('sha256', config.secret).update(session.token).digest('base64')
    }
    const aliceCookie = await cookie(alice.id)
    const bobCookie = await cookie(bob.id)
    const make = (method: string, path: string, data?: object, authCookie = aliceCookie, requestOrigin = origin) =>
      new Request(origin + path, { method,
        headers: { cookie: authCookie, origin: requestOrigin, 'content-type': 'application/json' },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }) })
    const connect = async (provider: 'github' | 'gitlab') => {
      const start = await gitConnectionRequest(auth, store, make('POST', '/api/integrations/git', { provider }), config)
      assert.equal(start.status, 200)
      const { authorizationUrl } = await start.json() as { authorizationUrl: string }
      const state = new URL(authorizationUrl).searchParams.get('state')
      const callback = await gitConnectionCallback(auth, store,
        make('GET', '/api/integrations/git/callback/' + provider + '?state=' + state + '&code=test'),
        provider, config)
      assert.match(callback.headers.get('location')!, /integration_connected/)
      const record = store.sqlite.prepare('SELECT id FROM git_connections WHERE owner_user_id=? AND provider=?')
        .get(alice.id, provider) as { id: string }
      return record.id
    }
    const tooLarge = await gitConnectionRequest(auth, store,
      make('POST', '/api/integrations/git', { provider: 'github', padding: 'x'.repeat(10000) }), config)
    assert.equal(tooLarge.status, 413, 'integration mutations must reject oversized input')
    const malformedSettings = await settingsRequest(auth, store,
      new Request(origin + '/api/settings', { method: 'PUT',
        headers: { cookie: aliceCookie, origin, 'content-type': 'application/json' },
        body: '{invalid-json',
      }), origin)
    assert.equal(malformedSettings.status, 400)
    const githubId = await connect('github')
    const gitlabId = await connect('gitlab')
    const ghAdded = await githubRepositoryRequest(auth, store,
      make('POST', '/api/github/repositories', { fullName: 'Acme/Story' }),
      { baseURL: origin, appSlug: 'test' })
    assert.equal(ghAdded.status, 200, JSON.stringify(await ghAdded.clone().json()))
    const ghRepoId = (await ghAdded.json() as { repository: { id: string } }).repository.id
    const glAdded = await gitlabRepositoryRequest(auth, store,
      make('POST', '/api/gitlab/repositories', { projectId: 20 }))
    assert.equal(glAdded.status, 200)
    const glRepoId = (await glAdded.json() as { repository: { id: string } }).repository.id
    const bound = store.sqlite.prepare('SELECT connection_id AS binding FROM repositories WHERE id=?')
    assert.deepEqual([bound.get(ghRepoId), bound.get(glRepoId)], [
      { binding: githubId }, { binding: gitlabId },
    ], 'implicit single integration must be persisted, not downgraded to login-linked access')
    assert.equal(await getRepositoryToken(auth, store, new Headers({ cookie: aliceCookie }), 'github', ghRepoId),
      'gh-integrated')
    assert.equal(await getRepositoryToken(auth, store, new Headers({ cookie: aliceCookie }), 'gitlab', glRepoId),
      'gl-integrated')
    const legacy = uuid(1)
    store.sqlite.prepare(`INSERT INTO repositories
      (id,owner_user_id,provider,provider_repository_id,name,created_at,connection_id)
      VALUES (?,?,'github','101','Acme/Legacy','now',NULL)`).run(legacy, alice.id)
    assert.equal(await getRepositoryToken(auth, store, new Headers({ cookie: aliceCookie }), 'github', legacy), 'legacy-gh')
    const reimport = await githubRepositoryRequest(auth, store,
      make('POST', '/api/github/repositories', { fullName: 'Acme/Legacy' }),
      { baseURL: origin, appSlug: 'test' })
    assert.equal(reimport.status, 200)
    assert.deepEqual(bound.get(legacy), { binding: null },
      'reimporting a legacy repository must never implicitly switch its authorization identity')
    assert.equal((await settingsRequest(auth, store,
      make('DELETE', '/api/settings', { provider: 'github', accountRecordId: ghLogin.id }), origin)).status, 409,
      'cannot unlink a login identity that still provides legacy repository authorization')
    const foreign = await gitConnectionRequest(auth, store,
      make('PUT', '/api/integrations/git', { repositoryId: legacy, connectionId: githubId }, bobCookie), config)
    assert.equal(foreign.status, 404)
    const wrongProvider = await gitConnectionRequest(auth, store,
      make('PUT', '/api/integrations/git', { repositoryId: legacy, connectionId: gitlabId }), config)
    assert.equal(wrongProvider.status, 409)
    assert.deepEqual(bound.get(legacy), { binding: null })
    const inaccessible = uuid(2)
    store.sqlite.prepare(`INSERT INTO repositories
      (id,owner_user_id,provider,provider_repository_id,name,created_at,connection_id)
      VALUES (?,?,'github','777','Acme/Inaccessible','now',NULL)`).run(inaccessible, alice.id)
    const rejected = await gitConnectionRequest(auth, store,
      make('PUT', '/api/integrations/git', { repositoryId: inaccessible, connectionId: githubId }), config)
    assert.equal(rejected.status, 404, 'remote permission checks must block unauthorized rebinding')
    assert.deepEqual(bound.get(inaccessible), { binding: null })
    // Remove this intentionally unbindable fixture before testing the login-unlink guard.
    store.sqlite.prepare('DELETE FROM repositories WHERE id=?').run(inaccessible)
    const boundResponse = await gitConnectionRequest(auth, store,
      make('PUT', '/api/integrations/git', { repositoryId: legacy, connectionId: githubId }), config)
    assert.equal(boundResponse.status, 200, JSON.stringify(await boundResponse.clone().json()))
    assert.deepEqual(bound.get(legacy), { binding: githubId })
    const unauthorised = await gitConnectionRequest(auth, store,
      make('PUT', '/api/integrations/git', { repositoryId: legacy, connectionId: githubId }, aliceCookie, 'https://attacker.invalid'), config)
    assert.equal(unauthorised.status, 403)
    const unlinked = await settingsRequest(auth, store,
      make('DELETE', '/api/settings', { provider: 'github', accountRecordId: ghLogin.id }), origin)
    assert.equal(unlinked.status, 200, JSON.stringify(await unlinked.clone().json()))
    assert.equal(await getRepositoryToken(auth, store, new Headers({ cookie: aliceCookie }), 'github', legacy),
      'gh-integrated', 'repository works after the login provider is removed')
    const disconnected = await gitConnectionRequest(auth, store,
      make('DELETE', '/api/integrations/git', { connectionId: githubId }), config)
    assert.equal(disconnected.status, 200)
    assert.equal((store.sqlite.prepare('SELECT COUNT(*) AS n FROM repositories').get() as { n: number }).n, 3)
    await assert.rejects(() => getRepositoryToken(auth, store, new Headers({ cookie: aliceCookie }),
      'github', legacy), /reauthorization/)
  } finally {
    globalThis.fetch = originalFetch
    store.sqlite.close()
    rmSync(directory, { recursive: true, force: true })
    for (const key of env) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
})
