import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openStudioDatabase } from '../src/db/connection'
import { migrateStudio } from '../src/db/migrations'
import { createStudioAuth } from '../src/lib/auth'
import { piOAuthCallbackRequest, piModelsRequest } from '../src/lib/pi-models.server'
import { userPiCredentials } from '../src/lib/pi-credentials.server'

const origin = 'http://localhost:3000'
const config = {
  baseURL: origin, secret: 'studio-browser-oauth-providers-integration-secret-123456',
  github: { clientId: 'test', clientSecret: 'test-secret' },
  gitlab: { clientId: 'test', clientSecret: 'test-secret' },
}
const jwt = [
  Buffer.from('{}').toString('base64'),
  Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } })).toString('base64'),
  'signature',
].join('.')

test('all Pi browser providers use the same owner-scoped two-phase callbacks without listener ports', {
  timeout: 30_000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-oauth-browser-providers-'))
  const oldKey = process.env.NT_PI_CREDENTIAL_KEY
  const oldUrl = process.env.BETTER_AUTH_URL
  const oldFetch = globalThis.fetch
  process.env.NT_PI_CREDENTIAL_KEY = randomBytes(32).toString('base64')
  process.env.BETTER_AUTH_URL = origin
  const store = openStudioDatabase(join(dir, 'studio.sqlite'))
  const exchanges: Array<{ provider: string; code: string; redirect: string }> = []
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url === 'https://radius.pi.dev/v1/oauth')
        return Response.json({ authorizationEndpoint: 'https://radius.example/authorize' })
      const provider = url === 'https://platform.claude.com/v1/oauth/token' ? 'anthropic' :
        url === 'https://auth.openai.com/oauth/token' ? 'openai-codex' :
        url === 'https://openrouter.ai/api/v1/auth/keys' ? 'openrouter' :
        url === 'https://radius.pi.dev/v1/oauth/token' ? 'radius' : ''
      assert.ok(provider, 'Unexpected OAuth request: ' + url)
      const body = provider === 'anthropic' || provider === 'openrouter' ?
        JSON.parse(String(init?.body)) as Record<string, string> :
        Object.fromEntries(new URLSearchParams(String(init?.body)))
      assert.ok(body.code)
      exchanges.push({ provider, code: body.code, redirect: body.redirect_uri ?? '' })
      return provider === 'openrouter' ? Response.json({ key: 'KEY-' + body.code }) :
        Response.json({ access_token: provider === 'openai-codex' ? jwt : 'ACCESS-' + body.code,
          refresh_token: 'REFRESH-' + body.code, expires_in: 3600 })
    }
    await migrateStudio(store, config)
    const auth = createStudioAuth(store, config)
    const ctx = await auth.$context
    const providers = ['anthropic', 'openrouter', 'radius', 'openai-codex'] as const
    const users = await Promise.all(providers.map(provider =>
      ctx.internalAdapter.createUser({ name: provider, email: provider + '@oauth.test',
        emailVerified: true }, { method: 'test' })))
    const cookies = await Promise.all(users.map(async user => {
      const session = await ctx.internalAdapter.createSession(user.id)
      return 'better-auth.session_token=' + session.token + '.' +
        createHmac('sha256', config.secret).update(session.token).digest('base64')
    }))
    const req = async (i: number, method: 'GET' | 'POST', body?: unknown) => {
      const response = await piModelsRequest(auth, store, new Request(origin + '/api/pi/models', {
        method, headers: { cookie: cookies[i]!, ...(method === 'GET' ? {} :
          { origin, 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), origin)
      return { status: response.status, body: await response.json() as {
        oauth: { status: string; provider: string; url?: string; interactive: boolean } | null
      } }
    }
    const starts = await Promise.all(providers.map((provider, i) =>
      req(i, 'POST', { action: 'oauth', provider })))
    assert.deepEqual(starts.map(response => response.status), [202, 202, 202, 202])
    const pending = [] as URL[]
    for (const i of providers.keys()) {
      let flow = (await req(i, 'GET')).body.oauth
      for (let tries = 0; tries < 60 && flow?.status === 'starting'; tries++) {
        await new Promise(resolve => setTimeout(resolve, 50))
        flow = (await req(i, 'GET')).body.oauth
      }
      assert.equal(flow?.status, 'pending', providers[i])
      assert.equal(flow.interactive, false)
      assert.equal(flow.provider, providers[i])
      pending.push(new URL(flow.url!))
    }
    const states = pending.map(url => url.searchParams.get('state'))
    assert.equal(new Set(states).size, providers.length)
    const callbacks = pending.map((url, i) => {
      const param = providers[i] === 'openrouter' ? 'callback_url' : 'redirect_uri'
      const uri = new URL(url.searchParams.get(param)!)
      uri.searchParams.set('state', states[i]!)
      uri.searchParams.set('code', 'code-' + providers[i])
      return uri
    })
    const forged = new URL(callbacks[0]!)
    forged.searchParams.set('state', states[1]!)
    assert.equal((await piOAuthCallbackRequest(new Request(forged), store)).status, 400,
      'state from another provider must not authorize this callback')
    assert.equal((await req(1, 'POST', {
      action: 'oauth-complete', redirectUrl: callbacks[0]!.toString(),
    })).status, 409, 'another owner cannot consume a foreign callback')
    const outcomes = await Promise.all(callbacks.slice(0, 3).map(uri =>
      piOAuthCallbackRequest(new Request(uri), store)))
    assert.deepEqual(outcomes.map(response => response.status), [303, 303, 303])
    const manual = await req(3, 'POST', { action: 'oauth-complete', redirectUrl: callbacks[3]!.toString() })
    assert.equal(manual.status, 200, 'legacy Codex completes without binding port 1455')
    assert.equal((await piOAuthCallbackRequest(new Request(callbacks[0]!), store)).status, 409)
    for (const i of providers.keys()) {
      const credential = await userPiCredentials(store, users[i]!.id).read(providers[i]!)
      assert.equal(credential?.type, 'oauth', providers[i])
      if (credential?.type === 'oauth') {
        assert.equal(credential.access, providers[i] === 'openrouter' ? 'KEY-code-openrouter' :
          providers[i] === 'openai-codex' ? jwt : 'ACCESS-code-' + providers[i])
      }
      const other = (i + 1) % providers.length
      assert.equal(await userPiCredentials(store, users[i]!.id).read(providers[other]!), undefined)
    }
    assert.equal(exchanges.length, 4)
    const stored = store.sqlite.prepare('SELECT ciphertext FROM pi_credentials').all() as Array<{ ciphertext: string }>
    for (const row of stored) assert.doesNotMatch(row.ciphertext, /ACCESS-|KEY-code|REFRESH-/)
  } finally {
    globalThis.fetch = oldFetch
    store.sqlite.close()
    if (oldKey === undefined) delete process.env.NT_PI_CREDENTIAL_KEY
    else process.env.NT_PI_CREDENTIAL_KEY = oldKey
    if (oldUrl === undefined) delete process.env.BETTER_AUTH_URL
    else process.env.BETTER_AUTH_URL = oldUrl
    rmSync(dir, { recursive: true, force: true })
  }
})
test('encrypted pending browser authorization survives a database reopen and can be claimed only once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-oauth-restart-'))
  const path = join(dir, 'studio.sqlite')
  const previous = process.env.NT_PI_CREDENTIAL_KEY
  process.env.NT_PI_CREDENTIAL_KEY = randomBytes(32).toString('base64')
  let first = openStudioDatabase(path)
  try {
    await migrateStudio(first, config)
    const auth = createStudioAuth(first, config)
    const ctx = await auth.$context
    const user = await ctx.internalAdapter.createUser({ name: 'Restart', email: 'restart@oauth.test',
      emailVerified: true }, { method: 'test' })
    const state = randomBytes(24).toString('base64url')
    const authorization = { url: 'https://openrouter.ai/auth?state=' + state,
      state, context: 'PRIVATE-PKCE-CONTEXT' }
    const { saveBrowserAuthorization, ownerBrowserFlow, pendingByState, claimBrowserAuthorization,
      finishBrowserAuthorization } = await import('../src/lib/pi-oauth-pending.server')
    saveBrowserAuthorization(first, user.id, 'openrouter', authorization, Date.now() + 600_000)
    const raw = first.sqlite.prepare('SELECT ciphertext FROM pi_oauth_pending WHERE owner_user_id=?')
      .get(user.id) as { ciphertext: string }
    assert.doesNotMatch(raw.ciphertext, /PRIVATE-PKCE-CONTEXT/)
    first.sqlite.close()
    const reopened = openStudioDatabase(path)
    try {
      assert.equal(ownerBrowserFlow(reopened, user.id)?.url, authorization.url)
      assert.deepEqual(pendingByState(reopened, state)?.authorization, authorization)
      assert.equal(claimBrowserAuthorization(reopened, user.id, state), true)
      assert.equal(claimBrowserAuthorization(reopened, user.id, state), false)
      assert.equal(pendingByState(reopened, state), null)
      finishBrowserAuthorization(reopened, user.id, state, 'connected')
      assert.equal(ownerBrowserFlow(reopened, user.id)?.status, 'connected')
      assert.equal((reopened.sqlite.prepare('SELECT ciphertext FROM pi_oauth_pending WHERE owner_user_id=?')
        .get(user.id) as { ciphertext: string | null }).ciphertext, null)
    } finally { reopened.sqlite.close() }
  } finally {
    if (first.sqlite.open) first.sqlite.close()
    if (previous === undefined) delete process.env.NT_PI_CREDENTIAL_KEY
    else process.env.NT_PI_CREDENTIAL_KEY = previous
    rmSync(dir, { recursive: true, force: true })
  }
})
