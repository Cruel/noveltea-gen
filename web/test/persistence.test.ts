import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import { openStudioDatabase } from './support/studio-database'
import { migrateStudio } from '../src/db/migrations'
import { createStudioAuth } from '../src/lib/auth'
import { getDashboardData, dashboardResponse } from '../src/lib/access.server'
import { readUserDashboard } from '../src/lib/catalog'
import { readDefaultModel, settingsRequest } from '../src/lib/settings.server'
import type { DashboardCatalog, SettingsPreferences } from '../src/persistence/contracts'

const baseURL = 'http://localhost:3000'
const secret = 'portable-persistence-test-secret-0123456789012345'
const config = {
  baseURL, secret,
  github: { clientId: 'test-gh', clientSecret: 'test-gh-secret' },
  gitlab: { clientId: 'test-gl', clientSecret: 'test-gl-secret' },
}

async function fixture() {
  const store = openStudioDatabase(':memory:')
  await migrateStudio(store, config)
  const auth = createStudioAuth(store, config)
  const ctx = await auth.$context
  const alice = await ctx.internalAdapter.createUser({
    name: 'Alice', email: 'alice@persistence.test', emailVerified: true,
  }, { method: 'test' })
  const bob = await ctx.internalAdapter.createUser({
    name: 'Bob', email: 'bob@persistence.test', emailVerified: true,
  }, { method: 'test' })
  const headers = async (owner: string) => {
    const session = await ctx.internalAdapter.createSession(owner)
    return new Headers({ cookie: 'better-auth.session_token=' + session.token + '.' +
      createHmac('sha256', secret).update(session.token).digest('base64') })
  }
  for (const [owner, label] of [[alice.id, 'alice'], [bob.id, 'bob']]) {
    (await store.testing.records.insert('repositories', {
      id: 'repo-' + label, ownerUserId: owner, provider: 'github',
      providerRepositoryId: label, name: 'Repo ' + label, createdAt: 'now',
    }))
    ;(await store.testing.records.insert('stories', {
      id: 'story-' + label, ownerUserId: owner, repositoryId: 'repo-' + label,
      directory: 'story', title: 'Story ' + label, createdAt: 'now',
    }))
  }
  return { store, auth, alice: alice.id, bob: bob.id, headers }
}

test('dashboard and preferences ports share fresh SQLite schema with unconverted raw callers', async () => {
  const f = await fixture()
  const { store, alice, bob } = f
  try {
    // Test fixture records use the backend-neutral interface.
    for (let i = 0; i < 23; i++) {
      (await store.testing.records.insert('studio_sessions', {
        id: 'job-' + i, ownerUserId: alice, storyId: 'story-alice',
        title: 'Job ' + i, status: i % 3 === 0 ? 'running' : i % 3 === 1 ? 'paused' : 'completed',
        createdAt: 'now', updatedAt: new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString(),
      }))
    }
    ;(await store.testing.records.insert('studio_sessions', {
      id: 'job-bob', ownerUserId: bob, storyId: 'story-bob',
      title: 'Bob job', status: 'running', createdAt: 'now', updatedAt: 'now',
    }))
    const result = await readUserDashboard(store.persistence.dashboard, alice)
    assert.deepEqual(result.repositories.map(r => r.id), ['repo-alice'])
    assert.deepEqual(result.stories.map(s => s.id), ['story-alice'])
    assert.equal(result.recentSessions.length, 20)
    assert.deepEqual(result.recentSessions.slice(0, 2).map(r => r.id), ['job-22', 'job-21'])
    assert.equal(result.activeJobs.length, result.recentSessions.filter(r => r.status !== 'completed').length)
    assert.ok(result.recentSessions.every(r => r.storyId === 'story-alice'))
    assert.deepEqual((await readUserDashboard(store.persistence.dashboard, bob)).recentSessions.map(r => r.id), ['job-bob'])
    await assert.rejects(() => readUserDashboard(store.persistence.dashboard, ''), /Authenticated actor/)

    const prefs = store.persistence.settings
    assert.equal(await prefs.getDefaultModel(alice), null)
    await prefs.putDefaultModel(alice, { provider: 'openai', id: 'model-a', thinking: 'medium' }, '2026-11-05')
    assert.deepEqual(await readDefaultModel(prefs, alice),
      { provider: 'openai', id: 'model-a', thinking: 'medium' })
    assert.equal(await prefs.getDefaultModel(bob), null)
    assert.equal((await store.testing.records.first<{ ownerUserId: string }>('user_preferences'))?.ownerUserId,
      alice, 'test reader observes the persisted Drizzle upsert')
    await prefs.putDefaultModel(alice, null, '2026-11-06')
    assert.equal(await readDefaultModel(prefs, alice), null)
    assert.equal((await store.testing.records.first<{ defaultModelJson: string | null }>('user_preferences'))?.defaultModelJson,
      null)
    await prefs.putThreadPreferences(alice, 'story-alice', 'flat', ['branch-1'], '2026-11-05')
    assert.deepEqual(await prefs.getThreadPreferences(alice, 'story-alice'),
      { view: 'flat', expandedIds: ['branch-1'], collapsedCollectionIds: [] })
    assert.equal(await prefs.getThreadPreferences(bob, 'story-alice'), null)
    await assert.rejects(() => prefs.putThreadPreferences(bob, 'story-alice', 'tree', [], 'now'), /FOREIGN KEY/)
    await prefs.putThreadPreferences(alice, 'story-alice', 'tree', [], '2026-11-06')
    assert.deepEqual(await prefs.getThreadPreferences(alice, 'story-alice'),
      { view: 'tree', expandedIds: [], collapsedCollectionIds: [] })
    assert.deepEqual((await prefs.listRepositories(alice)).map(r => r.id), ['repo-alice'])
    assert.equal(await prefs.hasLegacyRepositories(alice, 'github'), true)
    assert.equal(await prefs.hasLegacyRepositories(alice, 'gitlab'), false)
    assert.equal(await prefs.hasLegacyRepositories(bob, 'github'), true)
    assert.deepEqual((await store.testing.foreignKeyViolations()), [])
  } finally { store.close() }
})

test('dashboard and Settings preserve auth, owner scope, validation, CSRF, and response contracts', async () => {
  const f = await fixture()
  const { store, auth, alice, bob } = f
  try {
    const aliceHeaders = await f.headers(alice)
    const bobHeaders = await f.headers(bob)
    const get = async (headers: Headers) =>
      settingsRequest(auth, store, new Request(baseURL + '/api/settings', { headers }), baseURL)
    assert.equal((await dashboardResponse(auth, store, new Request(baseURL + '/api/dashboard'))).status, 401)
    assert.equal((await get(new Headers())).status, 401)
    const dashboard = await dashboardResponse(auth, store,
      new Request(baseURL + '/api/dashboard', { headers: aliceHeaders }))
    assert.equal(dashboard.status, 200)
    assert.equal(dashboard.headers.get('cache-control'), 'no-store')
    assert.deepEqual((await dashboard.json() as { stories: Array<{ id: string }> }).stories.map(s => s.id),
      ['story-alice'])
    const before = await get(aliceHeaders)
    assert.equal(before.headers.get('cache-control'), 'private, no-store')
    const settings = await before.json() as { repositories: Array<{ id: string }>; defaultModel: unknown }
    assert.deepEqual(settings.repositories.map(r => r.id), ['repo-alice'])
    assert.equal(settings.defaultModel, null)
    const put = async (headers: Headers, model: unknown, origin?: string) =>
      settingsRequest(auth, store, new Request(baseURL + '/api/settings', {
        method: 'PUT', headers: { ...Object.fromEntries(headers), ...(origin ? { origin } : {}),
          'content-type': 'application/json' }, body: JSON.stringify({ defaultModel: model }),
      }), baseURL)
    assert.equal((await put(aliceHeaders, null)).status, 403)
    assert.equal((await put(aliceHeaders, { provider: 'openai', id: 'unavailable' }, baseURL)).status, 422)
    assert.equal((await put(aliceHeaders, { invalid: true }, baseURL)).status, 422)
    assert.equal((await put(aliceHeaders, null, baseURL)).status, 200)
    await store.persistence.settings.putDefaultModel(alice, { provider: 'openai', id: 'saved' }, 'now')
    assert.deepEqual((await (await get(aliceHeaders)).json() as { defaultModel: unknown }).defaultModel,
      { provider: 'openai', id: 'saved' })
    assert.equal((await (await get(bobHeaders)).json() as { defaultModel: unknown }).defaultModel, null)
    for (const corrupt of ['{"invalid":true}', 'null', '{not-json']) {
      (await store.testing.records.update('user_preferences', { ownerUserId: alice }, { defaultModelJson: corrupt }))
      const invalid = await get(aliceHeaders)
      assert.equal(invalid.status, 409)
      assert.deepEqual(await invalid.json(), { error: 'Settings could not be updated. Refresh and retry.' })
    }
  } finally { store.close() }
})

test('persistence consumers accept async-only injected adapters without needing a SQLite driver', async () => {
  const f = await fixture()
  const { store, auth, alice } = f
  try {
    const headers = await f.headers(alice)
    let queriedOwner = ''
    const injectedCatalog: DashboardCatalog = {
      async forOwner(owner) {
        queriedOwner = owner
        return { repositories: [], stories: [], selectedStoryId: null, activeJobs: [], recentSessions: [] }
      },
    }
    assert.deepEqual(await readUserDashboard(injectedCatalog, alice),
      { repositories: [], stories: [], selectedStoryId: null, activeJobs: [], recentSessions: [] })
    assert.equal(queriedOwner, alice)
    const original = store.persistence.dashboard
    store.persistence.dashboard = injectedCatalog
    try {
      assert.deepEqual((await getDashboardData(auth, store, headers))?.stories, [])
    } finally { store.persistence.dashboard = original }

    let writtenOwner: string | undefined
    const settings: SettingsPreferences = {
      async getDefaultModel(owner) {
        queriedOwner = owner
        return { selection: { provider: 'openai', id: 'injected' } }
      },
      async putDefaultModel(owner, model, updatedAt) {
        writtenOwner = owner
        assert.equal(model, null)
        assert.ok(updatedAt)
      },
      async listRepositories(owner) {
        assert.equal(owner, alice)
        return [{ id: 'injected-repo', provider: 'github', name: 'Injected', connectionId: null }]
      },
      async hasLegacyRepositories() { return false },
      async getThreadPreferences() { return null },
      async putThreadPreferences() {},
    }
    const response = await settingsRequest(auth, store,
      new Request(baseURL + '/api/settings', { headers }), baseURL, settings)
    assert.equal(response.status, 200)
    assert.equal(queriedOwner, alice)
    const injected = await response.json() as { defaultModel: unknown; repositories: Array<{ id: string }> }
    assert.deepEqual(injected.defaultModel, { provider: 'openai', id: 'injected' })
    assert.deepEqual(injected.repositories.map(row => row.id), ['injected-repo'])
    const updated = await settingsRequest(auth, store, new Request(baseURL + '/api/settings', {
      method: 'PUT', headers: { cookie: headers.get('cookie')!, origin: baseURL,
        'content-type': 'application/json' }, body: '{"defaultModel":null}',
    }), baseURL, settings)
    assert.equal(updated.status, 200)
    assert.equal(writtenOwner, alice)
    assert.equal(await store.persistence.settings.getDefaultModel(alice), null,
      'injected writes must not silently fall back to the real database')
    assert.deepEqual((await readUserDashboard(store.persistence.dashboard, alice)).stories.map(s => s.id),
      ['story-alice'])
  } finally { store.close() }
})
