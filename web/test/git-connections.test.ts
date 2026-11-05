import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openStudioDatabase } from './support/studio-database'
import { migrateStudio } from '../src/db/migrations'
import { createStudioAuth } from '../src/lib/auth'
import { gitConnectionCallback, gitConnectionRequest, listGitConnections,
  tokenForGitConnection } from '../src/lib/git-connections.server'
import { getRepositoryToken } from '../src/lib/access.server'
import { settingsRequest } from '../src/lib/settings.server'

const config = {
  baseURL: 'http://localhost:3000',
  secret: 'git-connection-test-secret-0123456789abcdefghijklmnopqrstuvwxyz',
  github: { clientId: 'github-app', clientSecret: 'github-secret' },
  gitlab: { clientId: 'gitlab-app', clientSecret: 'gitlab-secret' },
}
const origin = config.baseURL
async function session(auth: ReturnType<typeof createStudioAuth>, owner: string) {
  const ctx = await auth.$context
  const row = await ctx.internalAdapter.createSession(owner)
  const signature = createHmac('sha256', config.secret).update(row.token).digest('base64')
  return new Headers({ cookie: 'better-auth.session_token=' + row.token + '.' + signature })
}
test('two Studio users may authorize the same Git integration without linking login identities', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'studio-git-integrations-'))
  const store = openStudioDatabase(join(folder, 'db.sqlite'))
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  let githubAccountId = 212
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    const params = new URLSearchParams(String(init?.body))
    calls.push(url)
    if (url.includes('/login/oauth/access_token')) {
      const refresh = params.get('grant_type') === 'refresh_token'
      return Response.json({ access_token: refresh ? 'refreshed-secret' : 'connected-secret',
        refresh_token: refresh ? 'rotated-secret' : 'initial-refresh-secret',
        expires_in: 3600, refresh_token_expires_in: 800000 })
    }
    if (url === 'https://api.github.com/user')
      return Response.json({ id: githubAccountId, login: githubAccountId === 212 ? 'shared-github' : 'second-github' })
    if (url === 'https://gitlab.com/oauth/token')
      return Response.json({ access_token: 'gitlab-connected-secret', refresh_token: 'gitlab-refresh-secret', expires_in: 3600 })
    if (url === 'https://gitlab.com/api/v4/user')
      return Response.json({ id: 313, username: 'shared-gitlab' })
    throw new Error('Unexpected provider call: ' + url)
  }
  try {
    await migrateStudio(store, config)
    const auth = createStudioAuth(store, config)
    const ctx = await auth.$context
    const alice = await ctx.internalAdapter.createUser({
      name: 'Alice', email: 'alice@example.test', emailVerified: true,
    }, { method: 'test' })
    const bob = await ctx.internalAdapter.createUser({
      name: 'Bob', email: 'bob@example.test', emailVerified: true,
    }, { method: 'test' })
    const aliceHeaders = await session(auth, alice.id)
    const bobHeaders = await session(auth, bob.id)
    const begin = async (headers: Headers, provider: 'github' | 'gitlab' = 'github') => {
      const response = await gitConnectionRequest(auth, store, new Request(origin + '/api/integrations/git', {
        method: 'POST', headers: { cookie: headers.get('cookie')!, origin,
          'content-type': 'application/json' }, body: JSON.stringify({ provider }),
      }), config)
      assert.equal(response.status, 200)
      const { authorizationUrl } = await response.json() as { authorizationUrl: string }
      assert.match(authorizationUrl, provider === 'github'
        ? /^https:\/\/github.com\/login\/oauth\/authorize/ : /^https:\/\/gitlab.com\/oauth\/authorize/)
      const callback = new URL(authorizationUrl)
      assert.equal(callback.searchParams.get('redirect_uri'), origin + '/api/integrations/git/callback/' + provider)
      assert.ok(callback.searchParams.get('code_challenge'))
      assert.equal(callback.searchParams.get('scope'), provider === 'github' ? 'offline_access' : 'api write_repository')
      const state = callback.searchParams.get('state')
      assert.ok(state)
      const returned = await gitConnectionCallback(auth, store, new Request(
        origin + '/api/integrations/git/callback/' + provider + '?code=good&state=' + state, { headers },
      ), provider, config)
      assert.equal(returned.status, 303)
      assert.equal(returned.headers.get('location'), origin + '/settings?integration_connected=' + provider)
      const replay = await gitConnectionCallback(auth, store, new Request(
        origin + '/api/integrations/git/callback/' + provider + '?code=replay&state=' + state, { headers },
      ), provider, config)
      assert.match(replay.headers.get('location')!, /integration_error=expired/)
      return (await listGitConnections(store, (headers === aliceHeaders ? alice : bob).id))
        .find(connection => connection.provider === provider)!
    }
    const a = await begin(aliceHeaders)
    const b = await begin(bobHeaders)
    assert.equal(a.login, 'shared-github')
    assert.equal(b.login, 'shared-github')
    assert.notEqual(a.id, b.id, 'connection IDs are independent')
    const ag = await begin(aliceHeaders, 'gitlab')
    const bg = await begin(bobHeaders, 'gitlab')
    assert.equal(ag.login, 'shared-gitlab')
    assert.equal(bg.login, 'shared-gitlab')
    assert.notEqual(ag.id, bg.id)
    assert.equal(await tokenForGitConnection(store, bob.id, bg.id, config), 'gitlab-connected-secret')
    githubAccountId = 214
    await begin(aliceHeaders)
    githubAccountId = 212
    const aliceGithub = (await listGitConnections(store, alice.id)).filter(item => item.provider === 'github')
    assert.equal(aliceGithub.length, 2, 'multiple GitHub identities coexist within one Studio user')
    const second = aliceGithub.find(item => item.login === 'second-github')!
    await assert.rejects(() => getRepositoryToken(auth, store, aliceHeaders, 'github', undefined, undefined, config),
      /Choose which github account/)
    assert.equal(await getRepositoryToken(auth, store, aliceHeaders, 'github', undefined, second.id, config),
      'connected-secret')
    assert.equal((store.sqlite.prepare('SELECT COUNT(*) AS n FROM account').get() as { n: number }).n, 0,
      'Git connections never create Better Auth login accounts')
    assert.doesNotMatch(JSON.stringify(store.sqlite.prepare('SELECT credentials FROM git_connections').all()),
      /connected-secret|initial-refresh-secret/, 'credentials must be encrypted')

    store.sqlite.prepare(`INSERT INTO repositories
      (id,owner_user_id,provider,provider_repository_id,name,created_at,connection_id)
      VALUES ('alice-repo',?,'github','111','shared-github/repo','now',?)`)
      .run(alice.id, a.id)
    assert.equal(await getRepositoryToken(auth, store, aliceHeaders, 'github', 'alice-repo', undefined, config), 'connected-secret')
    await assert.rejects(() => getRepositoryToken(auth, store, bobHeaders, 'github', 'alice-repo', undefined, config),
      /Repository does not belong/)
    assert.equal(await tokenForGitConnection(store, bob.id, b.id, config), 'connected-secret')
    await assert.rejects(() => tokenForGitConnection(store, alice.id, b.id, config), /not found/)

    store.sqlite.prepare('UPDATE git_connections SET access_expires_at=? WHERE id=?').run(Date.now() - 100, a.id)
    assert.equal(await tokenForGitConnection(store, alice.id, a.id, config), 'refreshed-secret')
    assert.equal(await tokenForGitConnection(store, alice.id, a.id, config), 'refreshed-secret')
    assert.equal(calls.filter(url => url.includes('login/oauth/access_token')).length, 4,
      'three authorizations and one refresh, no extra refresh')
    const disconnected = await gitConnectionRequest(auth, store, new Request(origin + '/api/integrations/git', {
      method: 'DELETE', headers: { cookie: aliceHeaders.get('cookie')!, origin,
        'content-type': 'application/json' }, body: JSON.stringify({ connectionId: a.id }),
    }), config)
    assert.equal(disconnected.status, 200)
    assert.equal((await listGitConnections(store, alice.id)).find(item => item.id === a.id)?.status, 'disconnected')
    await assert.rejects(() => getRepositoryToken(auth, store, aliceHeaders, 'github', 'alice-repo', undefined, config),
      /reauthorization/)
    assert.equal(await tokenForGitConnection(store, bob.id, b.id, config), 'connected-secret')

    const settings = await settingsRequest(auth, store,
      new Request(origin + '/api/settings', { headers: aliceHeaders }), origin)
    assert.equal(settings.status, 200)
    const body = await settings.text()
    assert.doesNotMatch(body, /connected-secret|initial-refresh-secret|bob@example/)
  } finally {
    globalThis.fetch = originalFetch
    store.sqlite.close()
    rmSync(folder, { recursive: true, force: true })
  }
})
