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
import { assertUserPiSelection, availableUserPiModels, createUserPiRuntime,
  userPiCredentials, validPiSelection } from '../src/lib/pi-credentials.server'

const origin = 'http://localhost:3000'
const config = {
  baseURL: origin, secret: 'pi-credential-test-secret-0123456789abcdefghijklmnopqrstuvwxyz',
  github: { clientId: 'test', clientSecret: 'test-secret' },
  gitlab: { clientId: 'test', clientSecret: 'test-secret' },
}

test('Pi model credentials are user-scoped, encrypted, restart-safe and never expose host auth', {
  timeout: 100_000,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nt-pi-credentials-'))
  const saved = { key: process.env.NT_PI_CREDENTIAL_KEY, host: process.env.OPENAI_API_KEY }
  process.env.NT_PI_CREDENTIAL_KEY = randomBytes(32).toString('base64')
  process.env.OPENAI_API_KEY = 'HOST-PRIVATE-DO-NOT-USE'
  let store = openStudioDatabase(join(directory, 'studio.sqlite'))
  try {
    await migrateStudio(store, config)
    const auth = createStudioAuth(store, config)
    const ctx = await auth.$context
    const alice = await ctx.internalAdapter.createUser({ name: 'Alice', email: 'alice@pi.test',
      emailVerified: true }, { method: 'test' })
    const bob = await ctx.internalAdapter.createUser({ name: 'Bob', email: 'bob@pi.test',
      emailVerified: true }, { method: 'test' })
    const cookie = async (id: string) => {
      const session = await ctx.internalAdapter.createSession(id)
      return 'better-auth.session_token=' + session.token + '.' +
        createHmac('sha256', config.secret).update(session.token).digest('base64')
    }
    const aliceCookie = await cookie(alice.id)
    const bobCookie = await cookie(bob.id)
    const request = async (method: 'GET' | 'POST' | 'DELETE', user?: string,
      value?: unknown, passedOrigin = origin) => {
      const response = await piModelsRequest(auth, store,
        new Request(origin + '/api/pi/models', {
          method, headers: { ...(user ? { cookie: user } : {}),
            ...(method === 'GET' ? {} : { origin: passedOrigin, 'Content-Type': 'application/json' }) },
          ...(method !== 'GET' ? { body: JSON.stringify(value) } : {}),
        }), origin)
      return { status: response.status, response, body: await response.json() as any }
    }
    assert.equal((await request('GET')).status, 401)
    assert.equal((await request('POST', aliceCookie, { action: 'api-key', provider: 'openai', key: 'SHOULD-NOT-SAVE' }, 'https://evil.test')).status, 403)
    const initial = await request('GET', aliceCookie)
    assert.equal(initial.status, 200)
    assert.deepEqual(initial.body.models, [], 'host OPENAI_API_KEY must not create user-scoped availability')
    assert.deepEqual((await request('GET', bobCookie)).body.models, [])
    const bobRuntime = await createUserPiRuntime(store, bob.id)
    assert.equal(await bobRuntime.getAuth('openai'), undefined,
      'even a direct Pi runtime call cannot borrow OPENAI_API_KEY from the host')
    assert.deepEqual(await bobRuntime.getAvailable('openai'), [])
    assert.equal((await request('POST', aliceCookie, { action: 'api-key', provider: 'openai', key: '' })).status, 422)
    assert.equal((await request('POST', aliceCookie, { action: 'api-key', provider: '../other', key: 'x' })).status, 422)
    const key = 'ALICE-PRIVATE-MODEL-KEY'
    const added = await request('POST', aliceCookie, { action: 'api-key', provider: 'openai', key })
    assert.equal(added.status, 200, JSON.stringify(added.body))
    assert.deepEqual(added.body.connected, [{ providerId: 'openai', type: 'api_key' }])
    assert.ok(added.body.models.some((model: { provider: string }) => model.provider === 'openai'),
      'Pi SDK must report eligible models after an explicit per-user connection')
    assert.doesNotMatch(JSON.stringify(added.body), /ALICE-PRIVATE-MODEL-KEY|HOST-PRIVATE/)
    assert.deepEqual((await request('GET', bobCookie)).body.models, [], 'Bob cannot enumerate Alice models')
    assert.deepEqual((await request('GET', bobCookie)).body.connected, [])
    const row = store.sqlite.prepare('SELECT owner_user_id AS owner, ciphertext FROM pi_credentials')
      .get() as { owner: string; ciphertext: string }
    assert.equal(row.owner, alice.id)
    assert.doesNotMatch(row.ciphertext, /ALICE-PRIVATE-MODEL-KEY|HOST-PRIVATE|api_key/)
    assert.equal((await userPiCredentials(store, alice.id).read('openai'))?.type, 'api_key')
    assert.equal(await userPiCredentials(store, bob.id).read('openai'), undefined)
    const selectable = added.body.models[0] as { provider: string; id: string; reasoning: boolean }
    const selection = { provider: selectable.provider, id: selectable.id,
      ...(selectable.reasoning ? { thinking: 'high' as const } : {}) }
    assert.equal(validPiSelection(selection), true)
    assert.equal(validPiSelection({ ...selection, hostCredential: true }), false)
    await assertUserPiSelection(store, alice.id, selection)
    await assert.rejects(assertUserPiSelection(store, bob.id, selection), /unavailable/)
    const runtime = await createUserPiRuntime(store, alice.id)
    assert.ok(runtime.getModel(selectable.provider, selectable.id))
    assert.equal((await runtime.listCredentials()).length, 1)
    // Persist a canonical Pi OAuth credential and rehydrate it through a fresh runtime.
    const oauth = { type: 'oauth' as const, access: 'OAUTH-ACCESS-SECRET',
      refresh: 'OAUTH-REFRESH-SECRET', expires: Date.now() + 3600_000, accountId: 'alice' }
    await userPiCredentials(store, alice.id).modify('openai-codex', async () => oauth)
    const anotherStore = openStudioDatabase(join(directory, 'studio.sqlite'))
    try {
      const restored = await userPiCredentials(anotherStore, alice.id).read('openai-codex')
      assert.deepEqual(restored, oauth)
      const restoredRuntime = await createUserPiRuntime(anotherStore, alice.id)
      assert.equal(restoredRuntime.getProvider('openai-codex')?.id, 'openai-codex')
      assert.equal((await restoredRuntime.getAuth('openai-codex'))?.auth.apiKey, oauth.access,
        'OAuth connection is rehydrated from the user database, not the host Pi profile')
      await assert.rejects(async () => {
        const wrong = userPiCredentials(anotherStore, alice.id, { NT_PI_CREDENTIAL_KEY: randomBytes(32).toString('base64') })
        await wrong.read('openai')
      })
    } finally { anotherStore.sqlite.close() }
    assert.equal((await request('DELETE', bobCookie, { provider: 'openai' })).status, 200)
    assert.ok(await userPiCredentials(store, alice.id).read('openai'), 'foreign delete must not affect Alice')
    assert.equal((await request('DELETE', aliceCookie, { provider: 'openai' })).status, 200)
    await assert.rejects(assertUserPiSelection(store, alice.id, selection), /unavailable/,
      'revocation blocks the previously pinned model')
    assert.equal(await userPiCredentials(store, alice.id).read('openai'), undefined)
    const anon = await request('GET')
    assert.equal(anon.status, 401)
    assert.match(anon.response.headers.get('cache-control') ?? '', /no-store/)
  } finally {
    store.sqlite.close()
    if (saved.key === undefined) delete process.env.NT_PI_CREDENTIAL_KEY
    else process.env.NT_PI_CREDENTIAL_KEY = saved.key
    if (saved.host === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = saved.host
    rmSync(directory, { recursive: true, force: true })
  }
})
