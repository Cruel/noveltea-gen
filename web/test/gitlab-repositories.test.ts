import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openStudioDatabase } from '../src/db/connection'
import { migrateStudio } from '../src/db/migrations'
import { createStudioAuth } from '../src/lib/auth'
import { gitlabRepositoryRequest } from '../src/lib/gitlab-repositories.server'

const origin = 'http://localhost:3000'
const secret = 'gitlab-repositories-stable-test-secret-0123456789'
const config = { baseURL: origin, secret,
  github: { clientId: 'github', clientSecret: 'github-secret' },
  gitlab: { clientId: 'gitlab', clientSecret: 'gitlab-secret' } }
const projects = [
  { id: 11, path_with_namespace: 'group/Story', name_with_namespace: 'Group / Story', visibility: 'private', archived: false },
  { id: 12, path_with_namespace: 'alice/Personal', name_with_namespace: 'Alice / Personal', visibility: 'public', archived: false },
  { id: 13, path_with_namespace: 'group/Old', name_with_namespace: 'Group / Old', visibility: 'private', archived: true },
]
test('GitLab signed-in and linked users browse scoped projects, import stable IDs, and fail closed on revocation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-gitlab-'))
  const store = openStudioDatabase(join(dir, 'studio.sqlite'))
  const original = globalThis.fetch
  let revoked = false
  const seen: string[] = []
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    seen.push(url)
    assert.match(url, /^https:\/\/gitlab.com\/api\/v4\/projects\?membership=true&min_access_level=30/)
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer private-gitlab-token')
    return revoked ? new Response('Unauthorized', { status: 401 }) :
      Response.json(projects, { headers: { 'x-next-page': '' } })
  }
  try {
    await migrateStudio(store, config)
    const auth = createStudioAuth(store, config)
    const ctx = await auth.$context
    const alice = await ctx.internalAdapter.createUser({ name: 'Alice', email: 'alice@test.dev', emailVerified: true }, { method: 'test' })
    const bob = await ctx.internalAdapter.createUser({ name: 'Bob', email: 'bob@test.dev', emailVerified: true }, { method: 'test' })
    await ctx.internalAdapter.createAccount({ userId: alice.id, providerId: 'gitlab', accountId: 'alice', accessToken: 'private-gitlab-token' })
    const headers = async (id: string) => {
      const session = await ctx.internalAdapter.createSession(id)
      return { origin, cookie: 'better-auth.session_token=' + session.token + '.' + createHmac('sha256', secret).update(session.token).digest('base64') }
    }
    const aliceHeaders = await headers(alice.id)
    const bobHeaders = await headers(bob.id)
    const req = (method: string, path: string, h: { origin: string; cookie?: string } = aliceHeaders, body?: object) =>
      new Request(origin + path, { method, headers: { ...h, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    assert.equal((await gitlabRepositoryRequest(auth, store, req('GET', '/api/gitlab/repositories', { origin }))).status, 401)
    assert.equal((await gitlabRepositoryRequest(auth, store, req('GET', '/api/gitlab/repositories', bobHeaders))).status, 409)
    const listed = await gitlabRepositoryRequest(auth, store, req('GET', '/api/gitlab/repositories'))
    assert.equal(listed.status, 200)
    const data = await listed.json()
    assert.deepEqual(data.projects.map((p: { id: number }) => p.id), [11, 12])
    assert.doesNotMatch(JSON.stringify(data), /private-gitlab-token/)
    assert.equal((await gitlabRepositoryRequest(auth, store, req('POST', '/api/gitlab/repositories', { ...aliceHeaders, origin: 'https://evil.test' }, { projectId: 11 }))).status, 403)
    assert.equal((await gitlabRepositoryRequest(auth, store, req('POST', '/api/gitlab/repositories', aliceHeaders, { projectId: 99 }))).status, 403)
    const added = await gitlabRepositoryRequest(auth, store, req('POST', '/api/gitlab/repositories', aliceHeaders, { projectId: 11 }))
    assert.equal(added.status, 200)
    const id = (await added.json()).repository.id
    assert.equal((await gitlabRepositoryRequest(auth, store, req('POST', '/api/gitlab/repositories', aliceHeaders, { projectId: 11 }))).status, 200)
    assert.equal((await store.persistence.repositories.identities(alice.id)).length, 1)
    assert.equal((await store.persistence.repositories.get(alice.id, id, 'gitlab'))?.providerId, '11')
    revoked = true
    const denied = await gitlabRepositoryRequest(auth, store, req('GET', '/api/gitlab/repositories'))
    assert.equal(denied.status, 409)
    assert.match(JSON.stringify(await denied.json()), /expired or was revoked/)
    assert.equal((await gitlabRepositoryRequest(auth, store, req('POST', '/api/gitlab/repositories', aliceHeaders, { projectId: 12 }))).status, 409)
    assert.equal((await store.persistence.repositories.identities(alice.id)).length, 1)
    assert.ok(seen.every(url => !url.includes('private-gitlab-token')))
  } finally {
    globalThis.fetch = original
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
