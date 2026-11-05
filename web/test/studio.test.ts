import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openStudioDatabase } from './support/studio-database'
import { migrateStudio } from '../src/db/migrations'
import { createStudioAuth, readAuthConfig, studioAuthOptions } from '../src/lib/auth'
import { dashboardResponse, getDashboardData, getRepositoryToken } from '../src/lib/access.server'
import { repositories, sessions, stories } from '../src/db/schema'

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
    // These records are seeded through the server store; the browser cannot
    // supply ownerUserId or a filesystem path to the dashboard API.
    const users: Array<[string, string]> = [[alice.id, 'alice'], [bob.id, 'bob']]
    for (const [owner, suffix] of users) {
      store.db.insert(repositories).values({
        id: `repo-${suffix}`, ownerUserId: owner, provider: 'github',
        providerRepositoryId: `id-${suffix}`, name: `repo-${suffix}`,
        createdAt: '2026-10-31T00:00:00Z',
      }).run()
      store.db.insert(stories).values({
        id: `story-${suffix}`, repositoryId: `repo-${suffix}`, ownerUserId: owner,
        directory: 'Story', title: `Story ${suffix}`, createdAt: '2026-10-31T00:00:00Z',
      }).run()
      store.db.insert(sessions).values({
        id: `job-${suffix}`, storyId: `story-${suffix}`, ownerUserId: owner,
        title: `Job ${suffix}`, status: 'running',
        createdAt: '2026-10-31T00:00:00Z', updatedAt: '2026-10-31T00:00:00Z',
      }).run()
    }
    assert.throws(() => store.db.insert(stories).values({
      id: 'foreign-story', ownerUserId: alice.id, repositoryId: 'repo-bob',
      directory: 'bad', title: 'bad', createdAt: 'now',
    }).run(), /FOREIGN KEY/)
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
    const beforeRestart = readUserIds(store, alice.id)
    assert.equal(beforeRestart, 'story-alice')
    store.sqlite.close()

    store = openStudioDatabase(path)
    await migrateStudio(store, config)
    auth = createStudioAuth(store, config)
    const persisted = await getDashboardData(auth, store, headers)
    assert.equal(persisted?.user.id, alice.id)
    assert.deepEqual(persisted?.stories.map(story => story.id), ['story-alice'])
    assert.deepEqual(persisted?.activeJobs.map(job => job.id), ['job-alice'])
  } finally {
    if (store.sqlite.open) store.sqlite.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

function readUserIds(store: ReturnType<typeof openStudioDatabase>, ownerId: string) {
  return (store.sqlite.prepare('SELECT id FROM stories WHERE owner_user_id = ?').get(ownerId) as { id: string } | undefined)?.id
}

test('encrypted OAuth tokens and disabled implicit linking are required auth policy', () => {
  const store = openStudioDatabase(':memory:')
  try {
    const options = studioAuthOptions(store, config)
    assert.equal(options.account.encryptOAuthTokens, true)
    assert.equal(options.account.accountLinking.disableImplicitLinking, true)
    assert.equal(options.emailAndPassword.enabled, false)
    assert.deepEqual(options.account.accountLinking.trustedProviders, ['github','gitlab'])
  } finally { store.sqlite.close() }
})
