import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openStudioDatabase } from '../src/db/connection'
import { migrateStudio } from '../src/db/migrations'
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
    store.sqlite.prepare(`INSERT INTO repositories
      (id,owner_user_id,provider,provider_repository_id,name,created_at)
      VALUES (?,?,'github','123','Acme/Private','2026-10-31')`).run(repositoryId, alice.id)
    store.sqlite.prepare(`INSERT INTO stories
      (id,owner_user_id,repository_id,directory,title,created_at,source_commit_sha)
      VALUES (?,?,?,'story','Private Story','2026-10-31',?)`)
      .run(storyId, alice.id, repositoryId, 'a'.repeat(40))
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
    store.sqlite.prepare(`INSERT INTO repositories
      (id,owner_user_id,provider,provider_repository_id,name,created_at)
      VALUES ('55555555-5555-4555-8555-555555555555',?,'github','987','Other/Repo','2026-10-31')`).run(bob.id)
    store.sqlite.prepare(`INSERT INTO stories
      (id,owner_user_id,repository_id,directory,title,created_at,source_commit_sha)
      VALUES ('66666666-6666-4666-8666-666666666666',?,'55555555-5555-4555-8555-555555555555',
        'story','Other Story','2026-10-31',?)`).run(bob.id, 'b'.repeat(40))
    store.sqlite.prepare(`INSERT INTO studio_sessions
      (id,owner_user_id,story_id,title,status,created_at,updated_at)
      VALUES (?,?,?,'Other Job','paused','2026-10-31','2026-10-31')`)
      .run(jobId, bob.id, '66666666-6666-4666-8666-666666666666')
    assert.equal((await post(payload, aliceCookie)).status, 409)
    assert.equal((store.sqlite.prepare('SELECT count(*) AS count FROM studio_sessions').get() as { count: number }).count, 1)
  } finally {
    store.sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
