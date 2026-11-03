import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openStudioDatabase } from '../src/db/connection'
import { migrateStudio } from '../src/db/migrations'
import { createStudioAuth } from '../src/lib/auth'
import { piModelsRequest } from '../src/lib/pi-models.server'
import { userPiCredentials } from '../src/lib/pi-credentials.server'

const origin = 'http://localhost:3000'
const config = {
  baseURL: origin, secret: 'pi-interactive-oauth-integration-secret-0123456789',
  github: { clientId: 'test', clientSecret: 'test-secret' },
  gitlab: { clientId: 'test', clientSecret: 'test-secret' },
}

test('Pi interactive OAuth prompts are one-use, user-scoped and persist encrypted credentials', {
  timeout: 30_000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-pi-interactive-'))
  const oldKey = process.env.NT_PI_CREDENTIAL_KEY
  const originalFetch = globalThis.fetch
  process.env.NT_PI_CREDENTIAL_KEY = randomBytes(32).toString('base64')
  const store = openStudioDatabase(join(dir, 'studio.sqlite'))
  let tokenCalls = 0
  try {
    await migrateStudio(store, config)
    const auth = createStudioAuth(store, config)
    const ctx = await auth.$context
    const cookies: string[] = []
    const users = await Promise.all(['Alice', 'Bob'].map(name =>
      ctx.internalAdapter.createUser({ name, email: name.toLowerCase() + '@interactive.test',
        emailVerified: true }, { method: 'test' })))
    for (const user of users) {
      const session = await ctx.internalAdapter.createSession(user.id)
      cookies.push('better-auth.session_token=' + session.token + '.' +
        createHmac('sha256', config.secret).update(session.token).digest('base64'))
    }
    const request = async (index: number, method: 'GET' | 'POST' | 'DELETE', body?: unknown) => {
      const response = await piModelsRequest(auth, store, new Request(origin + '/api/pi/models', {
        method, headers: { cookie: cookies[index]!, ...(method !== 'GET'
          ? { origin, 'content-type': 'application/json' } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), origin)
      return { status: response.status, body: await response.json() as {
        oauth: { status: string; provider: string; interactive: boolean; url?: string;
          prompt?: { id: string; type: string; options?: { id: string }[] };
          device?: { userCode: string; verificationUri: string } } | null;
        connected?: { providerId: string }[]; error?: string
      } }
    }
    const until = async (index: number, predicate: (flow: NonNullable<Awaited<ReturnType<typeof request>>['body']['oauth']>) => boolean) => {
      for (let attempts = 0; attempts < 80; attempts++) {
        const current = (await request(index, 'GET')).body.oauth
        if (current?.status === 'failed') assert.fail('Pi OAuth login failed unexpectedly')
        if (current && predicate(current)) return current
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      assert.fail('Timed out waiting for Pi OAuth state')
    }
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), 'https://platform.claude.com/v1/oauth/token')
      const body = JSON.parse(String(init?.body)) as Record<string, string>
      assert.equal(body.grant_type, 'authorization_code')
      assert.equal(body.code, 'authorized-code')
      tokenCalls++
      return Response.json({ access_token: 'ALICE-ACCESS-SECRET',
        refresh_token: 'ALICE-REFRESH-SECRET', expires_in: 3600 })
    }
    const start = await request(0, 'POST', { action: 'oauth', provider: 'anthropic' })
    assert.equal(start.status, 202)
    const select = await until(0, f => f.prompt?.type === 'select')
    assert.equal(select.provider, 'anthropic')
    assert.equal(select.interactive, true)
    assert.ok(select.prompt?.options?.some(option => option.id === 'copy_code'))
    assert.equal((await request(1, 'POST', {
      action: 'oauth-answer', promptId: select.prompt!.id, value: 'copy_code',
    })).status, 409, 'another owner cannot answer a provider prompt')
    assert.equal((await request(0, 'POST', {
      action: 'oauth-answer', promptId: 'forged', value: 'copy_code',
    })).status, 409)
    assert.equal((await request(0, 'POST', {
      action: 'oauth-answer', promptId: select.prompt!.id, value: 'not-an-option',
    })).status, 422)
    assert.equal((await request(0, 'POST', {
      action: 'oauth-answer', promptId: select.prompt!.id, value: 'copy_code',
    })).status, 200)
    assert.equal((await request(0, 'POST', {
      action: 'oauth-answer', promptId: select.prompt!.id, value: 'copy_code',
    })).status, 409, 'prompt cannot be replayed')
    const manual = await until(0, f => f.prompt?.type === 'manual_code' && !!f.url)
    const state = new URL(manual.url!).searchParams.get('state')
    assert.ok(state)
    const answer = await request(0, 'POST', {
      action: 'oauth-answer', promptId: manual.prompt!.id, value: 'authorized-code#' + state,
    })
    assert.equal(answer.status, 200)
    await until(0, f => f.status === 'connected')
    assert.equal(tokenCalls, 1)
    const stored = await userPiCredentials(store, users[0]!.id).read('anthropic')
    assert.equal(stored?.type, 'oauth')
    if (stored?.type === 'oauth') assert.equal(stored.access, 'ALICE-ACCESS-SECRET')
    assert.equal(await userPiCredentials(store, users[1]!.id).read('anthropic'), undefined)
    const row = store.sqlite.prepare('SELECT ciphertext FROM pi_credentials WHERE owner_user_id=?')
      .get(users[0]!.id) as { ciphertext: string }
    assert.doesNotMatch(row.ciphertext, /ALICE-ACCESS-SECRET|ALICE-REFRESH-SECRET/)
    assert.equal((await request(0, 'POST', {
      action: 'oauth-answer', promptId: manual.prompt!.id, value: 'authorized-code#' + state,
    })).status, 409)
    assert.equal((await request(1, 'GET')).body.oauth, null)
  } finally {
    globalThis.fetch = originalFetch
    store.sqlite.close()
    if (oldKey === undefined) delete process.env.NT_PI_CREDENTIAL_KEY
    else process.env.NT_PI_CREDENTIAL_KEY = oldKey
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Pi device-code OAuth can be cancelled without persisting credentials', {
  timeout: 30_000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-pi-device-'))
  const oldKey = process.env.NT_PI_CREDENTIAL_KEY
  const originalFetch = globalThis.fetch
  process.env.NT_PI_CREDENTIAL_KEY = randomBytes(32).toString('base64')
  const store = openStudioDatabase(join(dir, 'studio.sqlite'))
  try {
    await migrateStudio(store, config)
    const auth = createStudioAuth(store, config)
    const ctx = await auth.$context
    const user = await ctx.internalAdapter.createUser({ name: 'Device', email: 'device@interactive.test',
      emailVerified: true }, { method: 'test' })
    const session = await ctx.internalAdapter.createSession(user.id)
    const cookie = 'better-auth.session_token=' + session.token + '.' +
      createHmac('sha256', config.secret).update(session.token).digest('base64')
    const request = async (method: 'GET' | 'POST', body?: unknown) => {
      const response = await piModelsRequest(auth, store, new Request(origin + '/api/pi/models', {
        method, headers: { cookie, ...(method === 'POST' ? { origin, 'content-type': 'application/json' } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), origin)
      return { status: response.status, body: await response.json() as {
        oauth: { status: string; device?: { userCode: string; verificationUri: string } } | null
      } }
    }
    globalThis.fetch = async input => {
      assert.equal(String(input), 'https://auth.x.ai/oauth2/device/code')
      return Response.json({ device_code: 'private-device-code', user_code: 'ABCD-EFGH',
        verification_uri: 'https://auth.x.ai/activate', expires_in: 900, interval: 10 })
    }
    assert.equal((await request('POST', { action: 'oauth', provider: 'xai' })).status, 202)
    let state = (await request('GET')).body.oauth
    for (let i = 0; i < 80 && !state?.device; i++) {
      assert.notEqual(state?.status, 'failed')
      await new Promise(resolve => setTimeout(resolve, 50))
      state = (await request('GET')).body.oauth
    }
    assert.equal(state?.device?.userCode, 'ABCD-EFGH')
    assert.equal(state?.device?.verificationUri, 'https://auth.x.ai/activate')
    assert.doesNotMatch(JSON.stringify(state), /private-device-code/)
    assert.equal((await request('POST', { action: 'oauth-cancel' })).status, 200)
    assert.equal((await request('GET')).body.oauth, null)
    assert.equal(await userPiCredentials(store, user.id).read('xai'), undefined)
  } finally {
    globalThis.fetch = originalFetch
    store.sqlite.close()
    if (oldKey === undefined) delete process.env.NT_PI_CREDENTIAL_KEY
    else process.env.NT_PI_CREDENTIAL_KEY = oldKey
    rmSync(dir, { recursive: true, force: true })
  }
})
