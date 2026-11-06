import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStudioDatabase } from './support/studio-database'
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
  let auth: ReturnType<typeof createStudioAuth>
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  const refreshes: string[] = []
  let gitlabCallbackEmail = providerResponses.gitlab.profile.email
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push(url)
    const refresh = String(init?.body).includes('refresh_token')
    const data = url.includes('github.com/login/oauth/access_token') ? (refresh
      ? { ...providerResponses.github.token, access_token: 'github-refreshed-sensitive' }
      : providerResponses.github.token)
      : url.includes('api.github.com/user/emails') ? providerResponses.github.emails
      : url.includes('api.github.com/user') ? providerResponses.github.profile
      : url.includes('gitlab.com/oauth/token') ? (refresh
        ? { ...providerResponses.gitlab.token, access_token: 'gitlab-refreshed-sensitive' }
        : providerResponses.gitlab.token)
      : url.includes('gitlab.com/api/v4/user') ? { ...providerResponses.gitlab.profile, email: gitlabCallbackEmail }
      : null
    if (!data) throw Error(`Unexpected OAuth fetch ${url} ${init?.method}`)
    if (refresh) refreshes.push(url)
    return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    await migrateStudio(store, config)
    auth = createStudioAuth(store, config)
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
    assert.match(callback.headers.getSetCookie().join(';'), /better-auth\.last_used_login_method=github/,
      'successful GitHub login records a browser-local last-used provider')
    const ghCookies = headersForCookies([sign.response, callback])
    const dashboard = await dashboardResponse(auth, store, new Request(`${origin}/api/dashboard`, { headers: ghCookies }))
    if (dashboard.status !== 200) assert.fail(`Dashboard: ${dashboard.status} ${await dashboard.text()}`)

    // A matching-email GitLab sign-in must not silently attach itself to the
    // GitHub-created Studio user. It should redirect back with a visible error.
    gitlabCallbackEmail = providerResponses.github.profile.email
    const independent = await auth.handler(new Request(`${origin}/api/auth/sign-in/social`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'gitlab', callbackURL: '/dashboard', errorCallbackURL: '/login' }),
    }))
    assert.equal(independent.status, 200)
    const independentUrl = new URL((await independent.json() as { url: string }).url)
    const independentState = independentUrl.searchParams.get('state')!
    const independentCallback = await auth.handler(new Request(
      `${origin}/api/auth/callback/gitlab?code=good&state=${encodeURIComponent(independentState)}`, {
        headers: headersForCookies([independent]),
      }))
    assert.equal(independentCallback.status, 302)
    assert.match(independentCallback.headers.get('location') || '', /account_not_linked/i)
    gitlabCallbackEmail = providerResponses.gitlab.profile.email

    const link = await begin(auth, 'link-social', ghCookies)
    assert.match(link.data.url, /^https:\/\/gitlab.com\/oauth\/authorize/)
    const linkState = new URL(link.data.url).searchParams.get('state')
    assert.ok(linkState)
    const linkedCallback = await auth.handler(new Request(`${origin}/api/auth/callback/gitlab?code=good&state=${encodeURIComponent(linkState)}`, {
      headers: headersForCookies([sign.response, callback, link.response]),
    }))
    if (linkedCallback.status !== 302) assert.fail(`GitLab callback: ${linkedCallback.status} ${await linkedCallback.text()}`)
    assert.doesNotMatch(linkedCallback.headers.get('location') || '', /error=/)

    const accounts = (await store.testing.auth.accounts())
    assert.deepEqual(accounts.map(row => row.providerId), ['github', 'gitlab'])
    for (const account of accounts) {
      assert.notEqual(account.accessToken, providerResponses[account.providerId as 'github' | 'gitlab'].token.access_token)
      assert.doesNotMatch(account.accessToken ?? '', /sensitive/)
      assert.doesNotMatch(account.refreshToken ?? '', /sensitive/)
    }
    assert.equal((await store.testing.auth.userCount()), 1)
    assert.equal(await getRepositoryToken(auth, store, ghCookies, 'github'), 'github-access-sensitive')
    assert.equal(await getRepositoryToken(auth, store, ghCookies, 'gitlab'), 'gitlab-access-sensitive')
    assert.equal(await getRepositoryToken(auth, store, new Headers(), 'github'), null)
    store.close()
    store = openStudioDatabase(join(directory, 'studio.sqlite'))
    await migrateStudio(store, config)
    auth = createStudioAuth(store, config)
    assert.equal((await dashboardResponse(auth, store, new Request(`${origin}/api/dashboard`, { headers: ghCookies }))).status, 200)
    assert.equal(await getRepositoryToken(auth, store, ghCookies, 'github'), 'github-access-sensitive')
    assert.equal(await getRepositoryToken(auth, store, ghCookies, 'gitlab'), 'gitlab-access-sensitive')
    // Force both encrypted accounts to expire in the persisted store, then
    // exercise refresh through the same public server-side repository adapter.
    ;(await store.testing.auth.expireAccounts(['github', 'gitlab'], 1))
    assert.equal(await getRepositoryToken(auth, store, ghCookies, 'github'), 'github-refreshed-sensitive')
    assert.equal(await getRepositoryToken(auth, store, ghCookies, 'gitlab'), 'gitlab-refreshed-sensitive')
    assert.equal(refreshes.length, 2)
    // Refreshed tokens remain encrypted and are reused without another OAuth
    // request when a second repository operation follows.
    const refreshedRows = (await store.testing.auth.accounts())
    assert.ok(refreshedRows.every(row => !(row.accessToken ?? '').includes('refreshed-sensitive')))
    assert.equal(await getRepositoryToken(auth, store, ghCookies, 'github'), 'github-refreshed-sensitive')
    assert.equal(await getRepositoryToken(auth, store, ghCookies, 'gitlab'), 'gitlab-refreshed-sensitive')
    assert.equal(refreshes.length, 2)
    // After an explicit link, either provider must sign into the same Studio user.
    const gitlabSignIn = await auth.handler(new Request(`${origin}/api/auth/sign-in/social`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'gitlab', callbackURL: '/dashboard', errorCallbackURL: '/login' }),
    }))
    const gitlabUrl = new URL((await gitlabSignIn.json() as { url: string }).url)
    const gitlabCallback = await auth.handler(new Request(`${origin}/api/auth/callback/gitlab?code=good&state=${encodeURIComponent(gitlabUrl.searchParams.get('state')!)}`, {
      headers: headersForCookies([gitlabSignIn]),
    }))
    assert.equal(gitlabCallback.status, 302)
    const identity = await auth.api.getSession({ headers: headersForCookies([gitlabSignIn, gitlabCallback]) })
    const original = await auth.api.getSession({ headers: ghCookies })
    assert.equal(identity?.user.id, original?.user.id)
    assert.ok(calls.some(url => url.includes('github.com/login/oauth/access_token')))
    assert.ok(calls.some(url => url.includes('gitlab.com/oauth/token')))
  } finally {
    globalThis.fetch = originalFetch
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
