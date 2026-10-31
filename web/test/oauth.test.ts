import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStudioDatabase } from '../src/db/connection'
import { migrateStudio } from '../src/db/migrations'
import { createStudioAuth } from '../src/lib/auth'
import { dashboardResponse, getRepositoryToken } from '../src/lib/access.server'

const origin = 'http://localhost:3000'
const config = {
  baseURL: origin, secret: 'unique-test-key-01234567890123456789-strong',
  github: { clientId: 'github-client', clientSecret: 'github-secret' },
  gitlab: { clientId: 'gitlab-client', clientSecret: 'gitlab-secret' },
}
const providerResponses = {
  github: {
    token: { access_token: 'github-access-sensitive', refresh_token: 'github-refresh-sensitive', token_type: 'bearer', expires_in: 3600, scope: 'repo' },
    profile: { id: 42, login: 'alice', name: 'Alice', email: 'alice@github.test', avatar_url: '' },
    emails: [{ email: 'alice@github.test', primary: true, verified: true }],
  },
  gitlab: {
    token: { access_token: 'gitlab-access-sensitive', refresh_token: 'gitlab-refresh-sensitive', token_type: 'bearer', expires_in: 3600, scope: 'api' },
    profile: { id: 73, username: 'alice-gl', name: 'Alice GitLab', email: 'different@gitlab.test', email_verified: true, state: 'active' },
  },
}

function headersForCookies(responses: Response[]): Headers {
  const cookies = new Map<string, string>()
  for (const response of responses) {
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(';', 1)[0]
      if (!pair) continue
      const name = pair.split('=', 1)[0]!
      cookies.set(name, pair)
    }
  }
  return new Headers({ cookie: [...cookies.values()].join('; ') })
}

async function begin(auth: ReturnType<typeof createStudioAuth>, endpoint: string, headers = new Headers()) {
  const response = await auth.handler(new Request(`${origin}/api/auth/${endpoint}`, {
    method: 'POST',
    headers: { ...Object.fromEntries(headers), 'content-type': 'application/json', origin },
    body: JSON.stringify({ provider: endpoint === 'link-social' ? 'gitlab' : 'github', callbackURL: '/dashboard' }),
  }))
  if (response.status !== 200) assert.fail(`OAuth start: ${response.status} ${await response.text()}`)
  const data = await response.json() as { url: string }
  assert.ok(data.url, 'OAuth must provide an authorization URL')
  return { response, data }
}

test('OAuth callback persists encrypted GitHub token, explicit GitLab link and session across restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'noveltea-oauth-'))
  let store = openStudioDatabase(join(directory, 'studio.sqlite'))
  let auth = createStudioAuth(store, config)
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push(url)
    const data = url.includes('github.com/login/oauth/access_token') ? providerResponses.github.token
      : url.includes('api.github.com/user/emails') ? providerResponses.github.emails
      : url.includes('api.github.com/user') ? providerResponses.github.profile
      : url.includes('gitlab.com/oauth/token') ? providerResponses.gitlab.token
      : url.includes('gitlab.com/api/v4/user') ? providerResponses.gitlab.profile
      : null
    if (!data) throw Error(`Unexpected OAuth fetch ${url} ${init?.method}`)
    return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    await migrateStudio(store, auth)
    const sign = await begin(auth, 'sign-in/social')
    assert.match(sign.data.url, /^https:\/\/github.com\/login\/oauth\/authorize/)
    // GitHub Apps ignore OAuth App repository scopes; request only the
    // supported refreshable-token scope.
    assert.equal(new URL(sign.data.url).searchParams.get('scope'), 'offline_access')
    const state = new URL(sign.data.url).searchParams.get('state')
    assert.ok(state)
    const callback = await auth.handler(new Request(`${origin}/api/auth/callback/github?code=good&state=${encodeURIComponent(state)}`, {
      headers: headersForCookies([sign.response]),
    }))
    if (callback.status !== 302) assert.fail(`GitHub callback: ${callback.status} ${await callback.text()}`)
    assert.doesNotMatch(callback.headers.get('location') || '', /error=/)
    const ghCookies = headersForCookies([sign.response, callback])
    const dashboard = await dashboardResponse(auth, store, new Request(`${origin}/api/dashboard`, { headers: ghCookies }))
    if (dashboard.status !== 200) assert.fail(`Dashboard: ${dashboard.status} ${await dashboard.text()}`)

    const link = await begin(auth, 'link-social', ghCookies)
    assert.match(link.data.url, /^https:\/\/gitlab.com\/oauth\/authorize/)
    const linkState = new URL(link.data.url).searchParams.get('state')
    assert.ok(linkState)
    const linkedCallback = await auth.handler(new Request(`${origin}/api/auth/callback/gitlab?code=good&state=${encodeURIComponent(linkState)}`, {
      headers: headersForCookies([sign.response, callback, link.response]),
    }))
    if (linkedCallback.status !== 302) assert.fail(`GitLab callback: ${linkedCallback.status} ${await linkedCallback.text()}`)
    assert.doesNotMatch(linkedCallback.headers.get('location') || '', /error=/)

    const accounts = store.sqlite.prepare('SELECT providerId, accessToken, refreshToken FROM account ORDER BY providerId').all() as Array<{
      providerId: string, accessToken: string, refreshToken: string
    }>
    assert.deepEqual(accounts.map(row => row.providerId), ['github', 'gitlab'])
    for (const account of accounts) {
      assert.notEqual(account.accessToken, providerResponses[account.providerId as 'github' | 'gitlab'].token.access_token)
      assert.doesNotMatch(account.accessToken, /sensitive/)
      assert.doesNotMatch(account.refreshToken, /sensitive/)
    }
    assert.equal((store.sqlite.prepare('SELECT COUNT(*) AS count FROM user').get() as { count: number }).count, 1)
    assert.equal(await getRepositoryToken(auth, store, ghCookies, 'github'), 'github-access-sensitive')
    assert.equal(await getRepositoryToken(auth, store, ghCookies, 'gitlab'), 'gitlab-access-sensitive')
    assert.equal(await getRepositoryToken(auth, store, new Headers(), 'github'), null)
    store.sqlite.close()
    store = openStudioDatabase(join(directory, 'studio.sqlite'))
    auth = createStudioAuth(store, config)
    await migrateStudio(store, auth)
    assert.equal((await dashboardResponse(auth, store, new Request(`${origin}/api/dashboard`, { headers: ghCookies }))).status, 200)
    assert.equal(await getRepositoryToken(auth, store, ghCookies, 'github'), 'github-access-sensitive')
    assert.equal(await getRepositoryToken(auth, store, ghCookies, 'gitlab'), 'gitlab-access-sensitive')
    assert.ok(calls.some(url => url.includes('github.com/login/oauth/access_token')))
    assert.ok(calls.some(url => url.includes('gitlab.com/oauth/token')))
  } finally {
    globalThis.fetch = originalFetch
    if (store.sqlite.open) store.sqlite.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
