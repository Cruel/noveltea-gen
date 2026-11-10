import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openStudioDatabase } from './support/studio-database'
import { migrateStudio } from './support/studio-database'
import { createStudioAuth } from '../src/lib/auth'
import { getRepositoryToken } from '../src/lib/access.server'
import { githubRepositoryRequest } from '../src/lib/github-repositories.server'
import { gitlabRepositoryRequest } from '../src/lib/gitlab-repositories.server'
import { gitConnectionCallback, gitConnectionRequest } from '../src/lib/git-connections.server'
import { discoverRepositoryCatalog } from '../src/lib/repository-candidates.server'
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
  let githubProfileId = 42
  let githubProfileUnavailable = false
  const env = ['BETTER_AUTH_URL', 'BETTER_AUTH_SECRET', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET',
    'GITLAB_CLIENT_ID', 'GITLAB_CLIENT_SECRET', 'GITHUB_APP_SLUG'] as const
  const saved = Object.fromEntries(env.map(key => [key, process.env[key]])) as Record<string, string | undefined>
  Object.assign(process.env, {
    BETTER_AUTH_URL: config.baseURL, BETTER_AUTH_SECRET: config.secret,
    GITHUB_CLIENT_ID: config.github.clientId, GITHUB_CLIENT_SECRET: config.github.clientSecret,
    GITLAB_CLIENT_ID: config.gitlab.clientId, GITLAB_CLIENT_SECRET: config.gitlab.clientSecret,
    GITHUB_APP_SLUG: 'test',
  })
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === 'https://github.com/login/oauth/access_token')
      return Response.json({ access_token: 'gh-integrated', refresh_token: 'gh-refresh', expires_in: 3600 })
    if (url === 'https://gitlab.com/oauth/token')
      return Response.json({ access_token: 'gl-integrated', refresh_token: 'gl-refresh', expires_in: 3600 })
    if (url === 'https://api.github.com/user') return githubProfileUnavailable
      ? Response.json({ error: 'unavailable' }, { status: 503 })
      : Response.json({ id: githubProfileId, login: 'alice' })
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
        { id: 21, path_with_namespace: 'Acme/LoginGL', name_with_namespace: 'Acme / LoginGL',
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
      userId: alice.id, providerId: 'github', accountId: '42', accessToken: 'legacy-gh',
    })
    await ctx.internalAdapter.createAccount({
      userId: alice.id, providerId: 'gitlab', accountId: '43', accessToken: 'legacy-gl',
    })
    const cookie = async (user: string) => {
      const session = await ctx.internalAdapter.createSession(user)
      return 'better-auth.session_token=' + session.token + '.' +
        createHmac('sha256', config.secret).update(session.token).digest('base64')
    }
    const aliceCookie = await cookie(alice.id)
    const bobCookie = await cookie(bob.id)
    const getLoginMethods = async () => {
      const result = await settingsRequest(auth, store, new Request(origin + '/api/settings', {
        headers: { cookie: aliceCookie },
      }), origin)
      assert.equal(result.status, 200)
      const body = await result.json() as { loginMethods: Array<{
        provider: 'github' | 'gitlab'; accountId: string; login: string | null }> }
      return body.loginMethods
    }
    assert.deepEqual((await getLoginMethods()).map(login => [login.provider, login.login]),
      [['github', 'alice'], ['gitlab', 'alice']],
      'login-backed GitHub and GitLab should expose their verified usernames')
    githubProfileId = 999
    assert.equal((await getLoginMethods()).find(item => item.provider === 'github')?.login, null,
      'a mismatched provider identity must not be presented as the login owner')
    githubProfileId = 42
    githubProfileUnavailable = true
    assert.equal((await getLoginMethods()).find(item => item.provider === 'github')?.login, null,
      'provider failures must not block settings or invent usernames')
    githubProfileUnavailable = false
    const bobLoginMethods = await settingsRequest(auth, store, new Request(origin + '/api/settings', {
      headers: { cookie: bobCookie },
    }), origin)
    assert.deepEqual((await bobLoginMethods.json() as { loginMethods: unknown[] }).loginMethods, [],
      'login account names remain owner-scoped')
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
      const record = (await store.testing.records.first<{ id: string }>('git_connections',
        { ownerUserId: alice.id, provider }))
      return record!.id
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
    const catalog = await discoverRepositoryCatalog(auth, store,
      new Headers({ cookie: aliceCookie }), origin)
    for (const [provider, connectionId] of [
      ['github', githubId], ['gitlab', gitlabId],
    ] as const) {
      const sources = catalog.sources.filter(source => source.provider === provider)
      assert.equal(sources.some(source => source.connectionId === null), false,
        provider + ' shows one account when login and repository authorization share an identity')
      assert.ok(sources.some(source => source.connectionId === connectionId),
        provider + ' separate authorization must remain available')
    }
    const ghAdded = await githubRepositoryRequest(auth, store,
      make('POST', '/api/github/repositories', { fullName: 'Acme/Story' }),
      { baseURL: origin, appSlug: 'test' })
    assert.equal(ghAdded.status, 200, JSON.stringify(await ghAdded.clone().json()))
    const ghRepoId = (await ghAdded.json() as { repository: { id: string } }).repository.id
    const glAdded = await gitlabRepositoryRequest(auth, store,
      make('POST', '/api/gitlab/repositories', { projectId: 20 }))
    assert.equal(glAdded.status, 200)
    const glRepoId = (await glAdded.json() as { repository: { id: string } }).repository.id
    const bound = async (id: string) => ({ binding:
      (await store.testing.records.first<{ connectionId: string | null }>('repositories', { id }))?.connectionId ?? null })
    assert.deepEqual(await Promise.all([bound(ghRepoId), bound(glRepoId)]), [
      { binding: githubId }, { binding: gitlabId },
    ], 'implicit single integration must be persisted, not downgraded to login-linked access')
    assert.equal(await getRepositoryToken(auth, store, new Headers({ cookie: aliceCookie }), 'github', ghRepoId),
      'gh-integrated')
    assert.equal(await getRepositoryToken(auth, store, new Headers({ cookie: aliceCookie }), 'gitlab', glRepoId),
      'gl-integrated')
    // Login credentials remain a first-class, explicitly selectable repository authority
    // even when a separate authorization also exists for that provider.
    for (const [provider, repositoryId, separateId, loginToken, separateToken] of [
      ['github', ghRepoId, githubId, 'legacy-gh', 'gh-integrated'],
      ['gitlab', glRepoId, gitlabId, 'legacy-gl', 'gl-integrated'],
    ] as const) {
      const useLogin = await gitConnectionRequest(auth, store,
        make('PUT', '/api/integrations/git', { repositoryId, connectionId: null }), config)
      assert.equal(useLogin.status, 200, JSON.stringify(await useLogin.clone().json()))
      assert.deepEqual(await bound(repositoryId), { binding: null })
      assert.equal(await getRepositoryToken(auth, store, new Headers({ cookie: aliceCookie }), provider, repositoryId),
        loginToken)
      const useSeparate = await gitConnectionRequest(auth, store,
        make('PUT', '/api/integrations/git', { repositoryId, connectionId: separateId }), config)
      assert.equal(useSeparate.status, 200, JSON.stringify(await useSeparate.clone().json()))
      assert.deepEqual(await bound(repositoryId), { binding: separateId })
      assert.equal(await getRepositoryToken(auth, store, new Headers({ cookie: aliceCookie }), provider, repositoryId),
        separateToken)
    }
    const importedGitlabLogin = await gitlabRepositoryRequest(auth, store,
      make('POST', '/api/gitlab/repositories', { projectId: 21, connectionId: null }))
    assert.equal(importedGitlabLogin.status, 200, JSON.stringify(await importedGitlabLogin.clone().json()))
    const loginGlId = (await importedGitlabLogin.json() as { repository: { id: string } }).repository.id
    assert.deepEqual(await bound(loginGlId), { binding: null })
    assert.equal(await getRepositoryToken(auth, store, new Headers({ cookie: aliceCookie }), 'gitlab', loginGlId),
      'legacy-gl', 'explicit GitLab login import must not fall back to separate authorization')
    ;(await store.testing.records.delete('repositories', { id: loginGlId }))
    const importedLogin = await githubRepositoryRequest(auth, store,
      make('POST', '/api/github/repositories', { fullName: 'Acme/Legacy', connectionId: null }),
      { baseURL: origin, appSlug: 'test' })
    assert.equal(importedLogin.status, 200, JSON.stringify(await importedLogin.clone().json()))
    const legacy = (await importedLogin.json() as { repository: { id: string } }).repository.id
    assert.deepEqual(await bound(legacy), { binding: null })
    assert.equal(await getRepositoryToken(auth, store, new Headers({ cookie: aliceCookie }), 'github', legacy),
      'legacy-gh', 'explicit login import must never switch to the available separate connection')
    const reimport = await githubRepositoryRequest(auth, store,
      make('POST', '/api/github/repositories', { fullName: 'Acme/Legacy' }),
      { baseURL: origin, appSlug: 'test' })
    assert.equal(reimport.status, 200)
    assert.deepEqual(await bound(legacy), { binding: null },
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
    assert.deepEqual(await bound(legacy), { binding: null })
    const inaccessible = uuid(2)
    ;(await store.testing.records.insert('repositories', { id: inaccessible, ownerUserId: alice.id,
      provider: 'github', providerRepositoryId: '777', name: 'Acme/Inaccessible',
      createdAt: 'now', connectionId: null }))
    const rejected = await gitConnectionRequest(auth, store,
      make('PUT', '/api/integrations/git', { repositoryId: inaccessible, connectionId: githubId }), config)
    assert.equal(rejected.status, 404, 'remote permission checks must block unauthorized rebinding')
    const rejectedLogin = await gitConnectionRequest(auth, store,
      make('PUT', '/api/integrations/git', { repositoryId: inaccessible, connectionId: null }), config)
    assert.equal(rejectedLogin.status, 404, 'login-backed rebinding also requires verified push access')
    assert.deepEqual(await bound(inaccessible), { binding: null })
    // Remove this intentionally unbindable fixture before testing the login-unlink guard.
    ;(await store.testing.records.delete('repositories', { id: inaccessible }))
    const boundResponse = await gitConnectionRequest(auth, store,
      make('PUT', '/api/integrations/git', { repositoryId: legacy, connectionId: githubId }), config)
    assert.equal(boundResponse.status, 200, JSON.stringify(await boundResponse.clone().json()))
    assert.deepEqual(await bound(legacy), { binding: githubId })
    const unauthorised = await gitConnectionRequest(auth, store,
      make('PUT', '/api/integrations/git', { repositoryId: legacy, connectionId: githubId }, aliceCookie, 'https://attacker.invalid'), config)
    assert.equal(unauthorised.status, 403)
    const unlinked = await settingsRequest(auth, store,
      make('DELETE', '/api/settings', { provider: 'github', accountRecordId: ghLogin.id }), origin)
    assert.equal(unlinked.status, 200, JSON.stringify(await unlinked.clone().json()))
    assert.equal(await getRepositoryToken(auth, store, new Headers({ cookie: aliceCookie }), 'github', legacy),
      'gh-integrated', 'repository works after the login provider is removed')
    const noLogin = await gitConnectionRequest(auth, store,
      make('PUT', '/api/integrations/git', { repositoryId: legacy, connectionId: null }), config)
    assert.equal(noLogin.status, 409, 'a repository cannot be rebound to an absent login')
    assert.deepEqual(await bound(legacy), { binding: githubId })
    const disconnected = await gitConnectionRequest(auth, store,
      make('DELETE', '/api/integrations/git', { connectionId: githubId }), config)
    assert.equal(disconnected.status, 200)
    assert.equal((await store.testing.records.count('repositories')), 3)
    await assert.rejects(() => getRepositoryToken(auth, store, new Headers({ cookie: aliceCookie }),
      'github', legacy), /reauthorization/)
  } finally {
    globalThis.fetch = originalFetch
    store.close()
    rmSync(directory, { recursive: true, force: true })
    for (const key of env) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
})
