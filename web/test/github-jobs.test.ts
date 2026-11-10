import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openStudioDatabase } from './support/studio-database'
import { migrateStudio } from './support/studio-database'
import { createStudioAuth } from '../src/lib/auth'
import { githubJobRequest } from '../src/lib/github-jobs.server'

const secret = 'stable-test-secret-0123456789abcdefghijklmnopqrstuvwxyz'
const config = {
  baseURL: 'http://localhost:3000', secret,
  github: { clientId: 'github', clientSecret: 'github-secret' },
  gitlab: { clientId: 'gitlab', clientSecret: 'gitlab-secret' },
}
const origin = config.baseURL

test('GitHub job acquisition rejects unauthenticated, foreign and conflicting catalog identities before Git', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-github-jobs-'))
  const store = openStudioDatabase(join(dir, 'studio.sqlite'))
  try {
    await migrateStudio(store, config)
    const auth = createStudioAuth(store, config)
    const ctx = await auth.$context
    const alice = await ctx.internalAdapter.createUser({
      name: 'Alice', email: 'alice@example.test', emailVerified: true,
    }, { method: 'test' })
    const bob = await ctx.internalAdapter.createUser({
      name: 'Bob', email: 'bob@example.test', emailVerified: true,
    }, { method: 'test' })
    for (const user of [alice, bob]) {
      await ctx.internalAdapter.createAccount({
        userId: user.id, providerId: 'github', accountId: user.id, accessToken: 'mock-secret',
      })
    }
    const cookie = async (id: string) => {
      const session = await ctx.internalAdapter.createSession(id)
      return 'better-auth.session_token=' + session.token + '.' +
        createHmac('sha256', secret).update(session.token).digest('base64')
    }
    const aliceCookie = await cookie(alice.id)
    const bobCookie = await cookie(bob.id)
    const repositoryId = '11111111-1111-4111-8111-111111111111'
    const storyId = '22222222-2222-4222-8222-222222222222'
    const jobId = '33333333-3333-4333-8333-333333333333'
    await store.persistence.repositories.upsert(alice.id, 'github', '123', 'Acme/Private',
      null, repositoryId, '2026-10-31')
    await store.persistence.onboarding.importStory({
      id: storyId, owner: alice.id, repositoryId, directory: 'story',
      title: 'Private Story', createdAt: '2026-10-31', commitSha: 'a'.repeat(40),
    })
    const post = (body: unknown, session?: string, requestOrigin = origin) => githubJobRequest(auth, store,
      new Request(origin + '/api/github/jobs', {
        method: 'POST',
        headers: { 'origin': requestOrigin, 'content-type': 'application/json', ...(session ? { cookie: session } : {}) },
        body: JSON.stringify(body),
      }), origin)
    const payload = { storyId, jobId, commit: 'a'.repeat(40) }
    assert.equal((await post(payload)).status, 401)
    assert.equal((await post(payload, aliceCookie, 'https://evil.example')).status, 403)
    assert.equal((await post({ storyId, jobId: '../etc/passwd', commit: payload.commit }, aliceCookie)).status, 400)
    assert.equal((await post({ storyId, jobId }, aliceCookie)).status, 400)
    assert.equal((await post(payload, bobCookie)).status, 404)
    assert.equal((await post({ ...payload, commit: 'b'.repeat(40) }, aliceCookie)).status, 409)
    assert.equal((await post({ ...payload, storyId: '44444444-4444-4444-8444-444444444444' }, aliceCookie)).status, 404)
    const bobRepositoryId = '55555555-5555-4555-8555-555555555555'
    const bobStoryId = '66666666-6666-4666-8666-666666666666'
    await store.persistence.repositories.upsert(bob.id, 'github', '987',
      'Other/Repo', null, bobRepositoryId, '2026-10-31')
    await store.persistence.onboarding.importStory({
      id: bobStoryId, owner: bob.id, repositoryId: bobRepositoryId,
      directory: 'story', title: 'Other Story', createdAt: '2026-10-31',
      commitSha: 'b'.repeat(40),
    })
    await store.persistence.generation.jobs.register(
      bob.id, jobId, bobStoryId, 'Other Job', 'b'.repeat(40), '2026-10-31')
    assert.equal((await post(payload, aliceCookie)).status, 409)
    assert.equal((await store.persistence.dashboard.forOwner(bob.id)).recentSessions.length, 1)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
