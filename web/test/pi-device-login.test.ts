import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Server } from 'node:net'
import { test } from 'node:test'
import { createStudioAuth } from '../src/lib/auth'
import { openStudioDatabase } from './support/studio-database'
import { migrateStudio } from './support/studio-database'
import { deviceOnlySelection, piModelsRequest } from '../src/lib/pi-models.server'
import { userPiCredentials } from '../src/lib/pi-credentials.server'

const origin = 'http://localhost:3000'
const config = {
  baseURL: origin, secret: 'device-login-studio-test-secret-0123456789abcdef',
  github: { clientId: 'test', clientSecret: 'test-secret' },
  gitlab: { clientId: 'test', clientSecret: 'test-secret' },
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test('device-only selection never silently falls back to browser OAuth', () => {
  const prompt = { type: 'select' as const, message: 'Method', options: [
    { id: 'browser', label: 'Browser' }, { id: 'device_code', label: 'Device code' },
  ] }
  assert.equal(deviceOnlySelection('openai-codex', prompt), 'device_code')
  assert.equal(deviceOnlySelection('radius', { ...prompt, options: [
    { id: 'browser', label: 'Browser' }, { id: 'device-code', label: 'Device code' },
  ] }), 'device-code')
  assert.throws(() => deviceOnlySelection('openai-codex', {
    ...prompt, options: [{ id: 'browser', label: 'Browser' }],
  }), /does not offer/)
  assert.throws(() => deviceOnlySelection('xai', prompt), /Browser callback/)
  assert.throws(() => deviceOnlySelection('xai', { type: 'manual_code', message: 'Paste callback' }),
    /Manual browser authorization/)
})

test('Studio uses upstream Pi device codes, stores encrypted credentials, and never binds OAuth callback ports', {
  timeout: 45_000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-device-only-'))
  const oldKey = process.env.NT_PI_CREDENTIAL_KEY
  const originalFetch = globalThis.fetch
  const originalListen = Server.prototype.listen
  process.env.NT_PI_CREDENTIAL_KEY = randomBytes(32).toString('base64')
  const store = openStudioDatabase(join(dir, 'studio.sqlite'))
  let requestedXaiDevice = false
  let requestedXaiToken = false
  let boundPort = false
  try {
    await migrateStudio(store, config)
    const auth = createStudioAuth(store, config)
    const ctx = await auth.$context
    const users = await Promise.all(['Alice', 'Bob'].map(async name => {
      const user = await ctx.internalAdapter.createUser({
        name, email: name.toLowerCase() + '@device.test', emailVerified: true,
      }, { method: 'test' })
      const session = await ctx.internalAdapter.createSession(user.id)
      const cookie = 'better-auth.session_token=' + session.token + '.' +
        createHmac('sha256', config.secret).update(session.token).digest('base64')
      return { user, cookie }
    }))
    const request = async (i: number, method: 'GET' | 'POST', body?: unknown) => {
      const result = await piModelsRequest(auth, store, new Request(origin + '/api/pi/models', {
        method, headers: { cookie: users[i]!.cookie, ...(method === 'POST' ?
          { origin, 'content-type': 'application/json' } : {}) },
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
      }), origin)
      return { status: result.status, body: await result.json() as {
        connected: Array<{ providerId: string }> | undefined,
        oauth: { status: string; device?: { userCode: string; verificationUri: string };
          reason?: string; provider: string } | null,
      } }
    }
    Server.prototype.listen = function () {
      boundPort = true
      throw new Error('Browser OAuth listener must not be started')
    }
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url === 'https://auth.x.ai/oauth2/device/code') {
        requestedXaiDevice = true
        return Response.json({ device_code: 'secret-private-device', user_code: 'ABCD-EFGH',
          verification_uri: 'https://auth.x.ai/activate', interval: 3, expires_in: 900 })
      }
      if (url === 'https://auth.x.ai/oauth2/token') {
        requestedXaiToken = true
        assert.equal(new URLSearchParams(String(init?.body)).get('device_code'), 'secret-private-device')
        return Response.json({ access_token: 'ALICE-OAUTH-ACCESS',
          refresh_token: 'ALICE-OAUTH-REFRESH', expires_in: 3600 })
      }
      if (url === 'https://radius.pi.dev/v1/oauth/device') {
        return Response.json({ device_code: 'radius-private-code', user_code: 'RADIUS-CODE',
          verification_uri: 'https://radius.pi.dev/verify', expires_in: 900, interval: 20 })
      }
      if (url === 'https://radius.pi.dev/v1/oauth/token')
        return Response.json({ error: 'authorization_pending' }, { status: 400 })
      throw Error('Unexpected OAuth network endpoint: ' + url)
    }
    assert.equal((await request(0, 'POST', { action: 'oauth', provider: 'openai' })).status, 422)
    assert.equal((await request(0, 'POST', { action: 'oauth', provider: 'anthropic' })).status, 422)
    assert.equal((await request(0, 'POST', { action: 'oauth', provider: 'openrouter' })).status, 422)
    assert.equal((await request(0, 'POST', { action: 'oauth', provider: 'xai' })).status, 202)
    assert.equal((await request(1, 'POST', { action: 'oauth', provider: 'radius' })).status, 202)
    let alice = (await request(0, 'GET')).body.oauth
    let bob = (await request(1, 'GET')).body.oauth
    for (let i = 0; i < 25 && ((!alice?.device && alice?.status !== 'connected') || !bob?.device); i++) {
      await sleep(30)
      alice = (await request(0, 'GET')).body.oauth
      bob = (await request(1, 'GET')).body.oauth
    }
    assert.ok(alice?.device?.userCode === 'ABCD-EFGH' || alice?.status === 'connected',
      JSON.stringify({ alice, bob, boundPort }))
    assert.equal(requestedXaiDevice, true)
    assert.equal(bob?.device?.userCode, 'RADIUS-CODE', JSON.stringify({ alice, bob, boundPort }))
    assert.doesNotMatch(JSON.stringify({ alice, bob }), /secret-private-device|radius-private-code/)
    assert.equal(boundPort, false)
    assert.equal((await request(0, 'POST', { action: 'oauth-complete',
      redirectUrl: 'http://127.0.0.1:1455/auth/callback?code=forged' })).status, 400)
    assert.equal((await request(1, 'POST', { action: 'oauth-cancel' })).status, 200)
    assert.equal((await request(1, 'GET')).body.oauth, null)
    assert.equal(await userPiCredentials(store, users[1]!.user.id).read('radius'), undefined)
    for (let i = 0; i < 100 && alice?.status !== 'connected'; i++) {
      await sleep(50)
      alice = (await request(0, 'GET')).body.oauth
    }
    assert.equal(alice?.status, 'connected', alice?.reason)
    assert.equal(requestedXaiToken, true)
    const credential = await userPiCredentials(store, users[0]!.user.id).read('xai')
    assert.equal(credential?.type, 'oauth')
    if (credential?.type === 'oauth') assert.equal(credential.access, 'ALICE-OAUTH-ACCESS')
    assert.equal(await userPiCredentials(store, users[1]!.user.id).read('xai'), undefined)
    const row = (await store.testing.records.first<{ ciphertext: string }>('pi_credentials',
      { ownerUserId: users[0]!.user.id }))!
    assert.doesNotMatch(row.ciphertext, /ALICE-OAUTH-ACCESS|ALICE-OAUTH-REFRESH/)
    assert.equal(boundPort, false)
  } finally {
    Server.prototype.listen = originalListen
    globalThis.fetch = originalFetch
    store.close()
    if (oldKey === undefined) delete process.env.NT_PI_CREDENTIAL_KEY
    else process.env.NT_PI_CREDENTIAL_KEY = oldKey
    rmSync(dir, { recursive: true, force: true })
  }
})

test('legacy Codex login selects device code rather than opening localhost:1455', {
  timeout: 25_000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-codex-device-'))
  const oldKey = process.env.NT_PI_CREDENTIAL_KEY
  const originalFetch = globalThis.fetch
  const originalListen = Server.prototype.listen
  process.env.NT_PI_CREDENTIAL_KEY = randomBytes(32).toString('base64')
  const store = openStudioDatabase(join(dir, 'studio.sqlite'))
  let bound = false
  try {
    await migrateStudio(store, config)
    const auth = createStudioAuth(store, config)
    const ctx = await auth.$context
    const user = await ctx.internalAdapter.createUser({
      name: 'Codex User', email: 'codex@device.test', emailVerified: true,
    }, { method: 'test' })
    const session = await ctx.internalAdapter.createSession(user.id)
    const cookie = 'better-auth.session_token=' + session.token + '.' +
      createHmac('sha256', config.secret).update(session.token).digest('base64')
    const request = async (method: 'GET' | 'POST', body?: unknown) => {
      const response = await piModelsRequest(auth, store, new Request(origin + '/api/pi/models', {
        method, headers: { cookie, ...(method === 'POST' ?
          { origin, 'content-type': 'application/json' } : {}) },
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
      }), origin)
      return { status: response.status, body: await response.json() as {
        oauth: { status: string; device?: { userCode: string; verificationUri: string }; reason?: string } | null,
      } }
    }
    Server.prototype.listen = function () {
      bound = true
      throw new Error('Unexpected local Codex OAuth callback server')
    }
    globalThis.fetch = async input => {
      const url = String(input)
      if (url === 'https://auth.openai.com/api/accounts/deviceauth/usercode')
        return Response.json({ device_auth_id: 'private-device-auth-id',
          user_code: 'C0D3-X7', interval: 20 })
      if (url === 'https://auth.openai.com/api/accounts/deviceauth/token')
        return Response.json({ error: 'deviceauth_authorization_pending' }, { status: 403 })
      throw new Error('Unexpected Codex OAuth request: ' + url)
    }
    assert.equal((await request('POST', { action: 'oauth', provider: 'openai-codex' })).status, 202)
    let flow = (await request('GET')).body.oauth
    for (let i = 0; i < 25 && !flow?.device; i++) {
      await sleep(40)
      flow = (await request('GET')).body.oauth
    }
    assert.equal(flow?.device?.userCode, 'C0D3-X7', JSON.stringify(flow))
    assert.equal(flow?.device?.verificationUri, 'https://auth.openai.com/codex/device')
    assert.equal(bound, false, 'Codex must never bind its browser callback listener')
    assert.equal((await request('POST', { action: 'oauth-cancel' })).status, 200)
    assert.equal((await request('GET')).body.oauth, null)
    assert.equal(await userPiCredentials(store, user.id).read('openai-codex'), undefined)
  } finally {
    globalThis.fetch = originalFetch
    Server.prototype.listen = originalListen
    store.close()
    if (oldKey === undefined) delete process.env.NT_PI_CREDENTIAL_KEY
    else process.env.NT_PI_CREDENTIAL_KEY = oldKey
    rmSync(dir, { recursive: true, force: true })
  }
})
