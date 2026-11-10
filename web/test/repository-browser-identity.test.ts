import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import { openStudioDatabase } from './support/studio-database'
import { migrateStudio } from './support/studio-database'
import { createStudioAuth } from '../src/lib/auth'
import { resolveRepositoryForBrowser } from '../src/lib/repository-browser.server'

const secret = 'repository-browser-authentication-test-secret-0123456'
const config = {
  baseURL: 'http://localhost:3000', secret,
  github: { clientId: 'gh', clientSecret: 'gh-secret' },
  gitlab: { clientId: 'gl', clientSecret: 'gl-secret' },
}
const githubId = '12345678-1234-4123-8123-123456789abc'
const gitlabId = '12345678-1234-4123-8123-123456789abd'
const otherId = '12345678-1234-4123-8123-123456789abe'

test('canonical repository browser resolves the provider only from the signed-in owner catalog', async () => {
  const store = openStudioDatabase(':memory:')
  try {
    await migrateStudio(store, config)
    const auth = createStudioAuth(store, config)
    const context = await auth.$context
    const alice = await context.internalAdapter.createUser({
      name: 'Alice', email: 'browser-alice@example.test', emailVerified: true,
    }, { method: 'test' })
    const bob = await context.internalAdapter.createUser({
      name: 'Bob', email: 'browser-bob@example.test', emailVerified: true,
    }, { method: 'test' })
    const sessionHeaders = async (id: string) => {
      const session = await context.internalAdapter.createSession(id)
      const signature = createHmac('sha256', secret).update(session.token).digest('base64')
      return new Headers({ cookie: 'better-auth.session_token=' + session.token + '.' + signature })
    }
    for (const [owner, provider, id] of [
      [alice.id, 'github', githubId], [alice.id, 'gitlab', gitlabId], [bob.id, 'github', otherId],
    ] as const) {
      await store.persistence.repositories.upsert(owner, provider, id,
        'Cruel/story', null, id, '2026-11-06T00:00:00Z')
    }
    const aliceHeaders = await sessionHeaders(alice.id)
    const bobHeaders = await sessionHeaders(bob.id)
    assert.deepEqual(await resolveRepositoryForBrowser(auth, store, aliceHeaders, githubId),
      { id: githubId, provider: 'github' })
    assert.deepEqual(await resolveRepositoryForBrowser(auth, store, aliceHeaders, gitlabId),
      { id: gitlabId, provider: 'gitlab' })
    await assert.rejects(
      () => resolveRepositoryForBrowser(auth, store, aliceHeaders, otherId), /Repository not found/)
    await assert.rejects(
      () => resolveRepositoryForBrowser(auth, store, bobHeaders, githubId), /Repository not found/)
    await assert.rejects(
      () => resolveRepositoryForBrowser(auth, store, aliceHeaders, 'not-an-id'), /Repository not found/)
    await assert.rejects(
      () => resolveRepositoryForBrowser(auth, store, new Headers(), githubId), /Sign in required/)
  } finally { store.close() }
})
