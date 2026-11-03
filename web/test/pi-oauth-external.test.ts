import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openStudioDatabase } from '../src/db/connection'
import { migrateStudio } from '../src/db/migrations'
import { createStudioAuth } from '../src/lib/auth'
import { chatGPTCallbackRequest, piModelsRequest } from '../src/lib/pi-models.server'
import { userPiCredentials } from '../src/lib/pi-credentials.server'

const origin = 'http://localhost:3000'

test('code-free OAuth completion signals the original tab and closes scripted popup', () => {
  const script = readFileSync(new URL('../public/oauth-popup-complete.js', import.meta.url), 'utf8')
  const sent: unknown[] = []
  let closed = false
  let disconnected = false
  class FakeBroadcastChannel {
    constructor(readonly name: string) { assert.equal(name, 'noveltea-pi-oauth') }
    postMessage(message: unknown) { sent.push(message) }
    close() { disconnected = true }
  }
  runInNewContext(script, {
    BroadcastChannel: FakeBroadcastChannel,
    window: { close: () => { closed = true } },
  })
  assert.deepEqual(sent, ['callback-received'])
  assert.equal(disconnected, true)
  assert.equal(closed, true)
  // Browser implementations without BroadcastChannel still close the popup.
  closed = false
  runInNewContext(script, { window: { close: () => { closed = true } } })
  assert.equal(closed, true)
})
const config = {
  baseURL: origin, secret: 'multiuser-external-oauth-authorization-secret-123456',
  github: { clientId: 'test', clientSecret: 'test-secret' },
  gitlab: { clientId: 'test', clientSecret: 'test-secret' },
}

test('external Pi OAuth handles two concurrent owners by state without a per-login listener', {
  timeout: 30_000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-pi-external-oauth-'))
  const oldKey = process.env.NT_PI_CREDENTIAL_KEY
  const oldBase = process.env.BETTER_AUTH_URL
  const oldRedirect = process.env.NT_PI_OAUTH_REDIRECT_URI
  const oldFetch = globalThis.fetch
  process.env.NT_PI_OAUTH_REDIRECT_URI = 'http://127.0.0.1:3000/auth/callback'
  process.env.BETTER_AUTH_URL = origin
  process.env.NT_PI_CREDENTIAL_KEY = randomBytes(32).toString('base64')
  const store = openStudioDatabase(join(dir, 'studio.sqlite'))
  const exchanged: string[] = []
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://auth.openai.com/api/accounts/oauth/token',
      'synthetic OAuth test must not call another remote service')
    const params = new URLSearchParams(String(init?.body))
    const code = params.get('code')
    assert.ok(code)
    assert.ok(params.get('code_verifier'))
    assert.equal(params.get('redirect_uri'), 'http://127.0.0.1:3000/auth/callback')
    exchanged.push(code)
    return Response.json({
      access_token: 'synthetic-access-' + code,
      refresh_token: 'synthetic-refresh-' + code,
      id_token: 'synthetic-id',
      expires_in: 3600,
      scope: 'openid chatgpt.tokens.use.direct',
    })
  }
  try {
    await migrateStudio(store, config)
    const auth = createStudioAuth(store, config)
    const ctx = await auth.$context
    const users = await Promise.all(['Alice', 'Bob'].map(name =>
      ctx.internalAdapter.createUser({ name, email: name.toLowerCase() + '@oauth.test',
        emailVerified: true }, { method: 'test' })))
    const cookies = await Promise.all(users.map(async user => {
      const session = await ctx.internalAdapter.createSession(user.id)
      return 'better-auth.session_token=' + session.token + '.' +
        createHmac('sha256', config.secret).update(session.token).digest('base64')
    }))
    const req = async (cookie: string, method: 'GET' | 'POST' | 'DELETE', body?: unknown) => {
      const response = await piModelsRequest(auth, store, new Request(origin + '/api/pi/models', {
        method,
        headers: { cookie, ...(method === 'GET' ? {} : { origin, 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), origin)
      return { status: response.status, value: await response.json() as {
        oauth: { status: string; url?: string } | null; connected: { providerId: string }[];
      } }
    }
    const starts = await Promise.all(cookies.map(cookie => req(cookie, 'POST', { action: 'oauth', provider: 'openai' })))
    assert.deepEqual(starts.map(s => s.status), [202, 202])
    const pending: URL[] = []
    for (const cookie of cookies) {
      let flow = (await req(cookie, 'GET')).value.oauth
      for (let i = 0; i < 60 && flow?.status !== 'pending'; i++) {
        if (flow?.status === 'failed') break
        await new Promise(resolve => setTimeout(resolve, 50))
        flow = (await req(cookie, 'GET')).value.oauth
      }
      assert.equal(flow?.status, 'pending', 'both users must start independently')
      assert.ok(flow.url)
      pending.push(new URL(flow.url))
    }
    assert.notEqual(pending[0]!.searchParams.get('state'), pending[1]!.searchParams.get('state'))
    const callback = (index: number) => {
      const uri = new URL('http://127.0.0.1:3000/auth/callback')
      uri.searchParams.set('state', pending[index]!.searchParams.get('state')!)
      uri.searchParams.set('code', 'user-' + index)
      uri.searchParams.set('client_id', 'issued-client-' + index)
      return uri
    }
    const forged = callback(0)
    forged.searchParams.set('state', randomBytes(32).toString('base64url'))
    assert.equal(chatGPTCallbackRequest(new Request(forged)).status, 409)
    const missingClientId = callback(0)
    missingClientId.searchParams.delete('client_id')
    assert.equal(chatGPTCallbackRequest(new Request(missingClientId)).status, 400)
    const completions = await Promise.all([callback(1), callback(0)].map(uri =>
      chatGPTCallbackRequest(new Request(uri))))
    assert.deepEqual(completions.map(response => response.status), [303, 303])
    for (const result of completions) {
      assert.equal(result.headers.get('location'), origin + '/auth/callback?complete=1',
        'completion must return to Studio origin without exposing OAuth credentials')
      assert.match(result.headers.get('referrer-policy') ?? '', /no-referrer/)
    }
    const finished = chatGPTCallbackRequest(new Request(origin + '/auth/callback?complete=1'))
    assert.equal(finished.status, 200)
    assert.match(await finished.text(), /oauth-popup-complete\.js/)
    assert.match(finished.headers.get('content-security-policy') ?? '', /script-src 'self'/)
    assert.equal(chatGPTCallbackRequest(new Request(callback(0))).status, 409, 'state must be one-use')
    for (let i = 0; i < cookies.length; i++) {
      let flow = (await req(cookies[i]!, 'GET')).value.oauth
      for (let attempt = 0; attempt < 60 && flow?.status !== 'connected'; attempt++) {
        if (flow?.status === 'failed') break
        await new Promise(resolve => setTimeout(resolve, 50))
        flow = (await req(cookies[i]!, 'GET')).value.oauth
      }
      assert.equal(flow?.status, 'connected')
      const credential = await userPiCredentials(store, users[i]!.id).read('openai')
      assert.equal(credential?.type, 'oauth')
      if (credential?.type === 'oauth') {
        assert.equal(credential.access, 'synthetic-access-user-' + i)
        assert.equal(credential.clientId, 'issued-client-' + i)
      }
    }
    assert.deepEqual(exchanged.sort(), ['user-0', 'user-1'])
    assert.equal(chatGPTCallbackRequest(new Request('http://127.0.0.1:3000/auth/callback')).status, 400)
  } finally {
    globalThis.fetch = oldFetch
    store.sqlite.close()
    if (oldKey === undefined) delete process.env.NT_PI_CREDENTIAL_KEY
    else process.env.NT_PI_CREDENTIAL_KEY = oldKey
    if (oldBase === undefined) delete process.env.BETTER_AUTH_URL
    else process.env.BETTER_AUTH_URL = oldBase
    if (oldRedirect === undefined) delete process.env.NT_PI_OAUTH_REDIRECT_URI
    else process.env.NT_PI_OAUTH_REDIRECT_URI = oldRedirect
    rmSync(dir, { recursive: true, force: true })
  }
})
