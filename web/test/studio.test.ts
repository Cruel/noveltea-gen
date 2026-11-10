import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openStudioDatabase } from './support/studio-database'
import { migrateStudio, openStudioBusinessFixture } from './support/studio-database'
import { openSharedStudioStore } from '../src/db/shared-studio-store'
import { createStudioAuth, readAuthConfig, studioAuthOptions } from '../src/lib/auth'
import { dashboardResponse, getDashboardData, getRepositoryToken } from '../src/lib/access.server'

const secret = 'stable-test-secret-0123456789abcdefghijklmnopqrstuvwxyz'
const config = {
  baseURL: 'http://localhost:3000',
  secret,
  github: { clientId: 'fake-github', clientSecret: 'fake-github-secret' },
  gitlab: { clientId: 'fake-gitlab', clientSecret: 'fake-gitlab-secret' },
}

async function sessionHeaders(auth: ReturnType<typeof createStudioAuth>, userId: string) {
  const context = await auth.$context
  const session = await context.internalAdapter.createSession(userId)
  const signature = createHmac('sha256', secret).update(session.token).digest('base64')
  return new Headers({ cookie: `better-auth.session_token=${session.token}.${signature}` })
}

test('startup fails closed when URL, credentials or durable secret are misconfigured', () => {
  assert.throws(() => readAuthConfig({}), /BETTER_AUTH_URL/)
  assert.throws(() => readAuthConfig({
    BETTER_AUTH_URL: 'http://remote.example',
    BETTER_AUTH_SECRET: secret,
    GITHUB_CLIENT_ID: 'a', GITHUB_CLIENT_SECRET: 'b',
    GITLAB_CLIENT_ID: 'c', GITLAB_CLIENT_SECRET: 'd',
  }), /HTTPS/)
})

test('migrations survive restart, account identity is persisted, and catalog is owned by the session user', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'noveltea-studio-'))
  const path = join(directory, 'studio.sqlite')
  let store = openStudioDatabase(path)
  try {
    await migrateStudio(store, config)
    await migrateStudio(store, config)
    let auth = createStudioAuth(store, config)
    const ctx = await auth.$context
    const alice = await ctx.internalAdapter.createUser({
      name: 'Alice', email: 'alice@example.test', emailVerified: true,
    }, { method: 'test' })
    const bob = await ctx.internalAdapter.createUser({
      name: 'Bob', email: 'bob@example.test', emailVerified: true,
    }, { method: 'test' })
    // Normal behavior tests seed via the same owner-scoped ports as Studio.
    const users: Array<[string, string]> = [[alice.id, 'alice'], [bob.id, 'bob']]
    for (const [owner, suffix] of users) {
      const repositoryId = `repo-${suffix}`, storyId = `story-${suffix}`
      await store.persistence.repositories.upsert(owner, 'github', `id-${suffix}`,
        `repo-${suffix}`, null, repositoryId, '2026-10-31T00:00:00Z')
      await store.persistence.onboarding.importStory({
        id: storyId, owner, repositoryId, directory: 'Story', title: `Story ${suffix}`,
        commitSha: 'a'.repeat(40), createdAt: '2026-10-31T00:00:00Z',
      })
      assert.equal(await store.persistence.generation.jobs.register(owner, `job-${suffix}`,
        storyId, `Job ${suffix}`, 'a'.repeat(40), '2026-10-31T00:00:00Z'), true)
    }
    await assert.rejects(() => store.persistence.onboarding.importStory({
      id: 'foreign-story', owner: alice.id, repositoryId: 'repo-bob',
      directory: 'bad', title: 'bad', createdAt: 'now', commitSha: 'a'.repeat(40),
    }), /FOREIGN KEY/)
    const headers = await sessionHeaders(auth, alice.id)
    assert.equal((await dashboardResponse(auth, store, new Request('http://localhost:3000/api/dashboard'))).status, 401)
    const response = await dashboardResponse(auth, store, new Request('http://localhost:3000/api/dashboard', { headers }))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const body = await response.text()
    assert.match(body, /Story alice/)
    assert.match(body, /repo-alice/)
    assert.match(body, /Job alice/)
    assert.doesNotMatch(body, /bob|accessToken|refreshToken|session_token/)
    const bobHeaders = await sessionHeaders(auth, bob.id)
    const bobResult = await dashboardResponse(auth, store, new Request('http://localhost:3000/api/dashboard', { headers: bobHeaders }))
    const bobBody = await bobResult.text()
    assert.equal(bobResult.status, 200)
    assert.match(bobBody, /Story bob/)
    assert.doesNotMatch(bobBody, /alice/)
    assert.equal(await getRepositoryToken(auth, store, headers, 'gitlab'), null)
    assert.equal(await getRepositoryToken(auth, store, new Headers(), 'github'), null)
    const beforeRestart = await readUserIds(store, alice.id)
    assert.equal(beforeRestart, 'story-alice')
    store.close()

    store = openStudioDatabase(path)
    await migrateStudio(store, config)
    auth = createStudioAuth(store, config)
    const persisted = await getDashboardData(auth, store, headers)
    assert.equal(persisted?.user.id, alice.id)
    assert.deepEqual(persisted?.stories.map(story => story.id), ['story-alice'])
    assert.deepEqual(persisted?.activeJobs.map(job => job.id), ['job-alice'])
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

async function readUserIds(store: ReturnType<typeof openStudioDatabase>, ownerId: string) {
  return (await store.persistence.dashboard.forOwner(ownerId)).stories[0]?.id
}

for (const backend of ['sqlite', 'postgres'] as const) {
  test(backend + ': dashboard HTTP service enforces tenant isolation and survives connection restart', {
    skip: backend === 'postgres' && !process.env.NT_TEST_PG_URL && 'Set NT_TEST_PG_URL',
    timeout: 60_000,
  }, async () => {
    const fixture = await openStudioBusinessFixture(backend)
    try {
      const store = fixture.store
      const auth = createStudioAuth(store, config)
      const alice = await fixture.owner()
      const bob = await fixture.owner()
      for (const [owner, label] of [[alice, 'Alice'], [bob, 'Bob']] as const) {
        const repositoryId = randomUUID(), storyId = randomUUID()
        await store.persistence.repositories.upsert(owner, 'github', repositoryId,
          'Acme/' + label, null, repositoryId, '2026-11-10T00:00:00Z')
        await store.persistence.onboarding.importStory({
          id: storyId, owner, repositoryId, directory: 'story',
          title: label + ' Story', commitSha: 'a'.repeat(40),
          createdAt: '2026-11-10T00:00:00Z',
        })
      }
      const headers = await sessionHeaders(auth, alice)
      const request = () => new Request('http://localhost:3000/api/dashboard', { headers })
      assert.equal((await dashboardResponse(auth, store, new Request('http://localhost:3000/api/dashboard'))).status, 401)
      const response = await dashboardResponse(auth, store, request())
      assert.equal(response.status, 200)
      const body = await response.text()
      assert.match(body, /Alice Story/)
      assert.doesNotMatch(body, /Bob Story/)
      const reopened = openSharedStudioStore(fixture.databaseOptions)
      try {
        await reopened.assertReady()
        const authAfterRestart = createStudioAuth(reopened, config)
        const persisted = await dashboardResponse(authAfterRestart, reopened, request())
        assert.equal(persisted.status, 200)
        assert.match(await persisted.text(), /Alice Story/)
      } finally {
        await reopened.close()
      }
    } finally {
      await fixture.close()
    }
  })
}

test('encrypted OAuth tokens and disabled implicit linking are required auth policy', () => {
  const store = openStudioDatabase(':memory:')
  try {
    const options = studioAuthOptions(store, config)
    assert.equal(options.account.encryptOAuthTokens, true)
    assert.equal(options.account.accountLinking.disableImplicitLinking, true)
    assert.equal(options.emailAndPassword.enabled, false)
    assert.deepEqual(options.account.accountLinking.trustedProviders, ['github','gitlab'])
  } finally { store.close() }
})
