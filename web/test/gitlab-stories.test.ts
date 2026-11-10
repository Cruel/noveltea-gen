import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createStudioAuth } from '../src/lib/auth'
import { openStudioDatabase } from './support/studio-database'
import { migrateStudio } from './support/studio-database'
import { gitlabStoryRequest } from '../src/lib/gitlab-stories.server'
import { STORY_LIMIT_BYTES } from '../src/lib/github-stories.server'

const origin = 'http://localhost:3000'
const secret = 'gitlab-stories-stable-test-secret-012345678901'
const config = {
  baseURL: origin, secret,
  github: { clientId: 'github', clientSecret: 'github-secret' },
  gitlab: { clientId: 'gitlab', clientSecret: 'gitlab-secret' },
}
const sha = (digit: string) => digit.repeat(40)
const commit = sha('a')
const foundation = '---\nschema: \'0.1\'\ntype: creative-direction\nid: creative-direction.foundation\n---\nTest.\n'
const makeEntry = (path: string, id: string, type = 'blob', mode = '100644') => ({
  path, name: path.split('/').at(-1)!, id, type, mode,
})
const root = [makeEntry('story', sha('b'), 'tree', '040000'), makeEntry('huge-assets', sha('c'), 'tree', '040000')]
const story = [makeEntry('story/creative-direction', sha('d'), 'tree', '040000'), makeEntry('story/large.bin', sha('e'))]
const records = [
  makeEntry('story/creative-direction/foundation.md', sha('f')),
  ...Array.from({ length: 101 }, (_, i) =>
    makeEntry('story/creative-direction/record-' + String(i).padStart(3, '0') + '.md',
      i.toString(16).padStart(40, '0'))),
]
test('GitLab Story discovery and import are owner-scoped, pinned, paginated and size-verified', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-gitlab-story-'))
  const store = openStudioDatabase(join(dir, 'studio.sqlite'))
  const original = globalThis.fetch
  const requests: Array<{ url: string; method: string }> = []
  let revoked = false
  let wrongHead = false
  let wrongCommit = false
  let duplicatePage = false
  let graphError = false
  let invalidGraph = false
  let missingPage = false
  let lfs = false
  let lfsAttributes = false
  let submodule = false
  let extraSize = 0
  let defaultBranch = 'main'
  const content = () => lfs
    ? 'version https://git-lfs.github.com/spec/v1\noid sha256:' + sha('1') + '\nsize 200000000\n'
    : foundation
  const entries = (path: string) => {
    if (path === '') return root
    if (path === 'story') return [
      ...story,
      ...(lfsAttributes ? [makeEntry('story/.gitattributes', sha('9'))] : []),
      ...(submodule ? [makeEntry('story/dependency', sha('8'), 'commit', '160000')] : []),
    ]
    if (path === 'story/creative-direction') return records
    return []
  }
  const filesize = (path: string) => path.endsWith('/foundation.md') ? Buffer.byteLength(content()) :
    path.endsWith('.gitattributes') ? Buffer.byteLength('*.md filter=lfs\n') :
    path === 'story/large.bin' ? STORY_LIMIT_BYTES - (101 * 5000 + Buffer.byteLength(content())) + extraSize : 5000
  const lookup = (path: string) => [...entries('story'), ...entries('story/creative-direction')].find(item => item.path === path)!
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = init?.method ?? 'GET'
    requests.push({ url, method })
    assert.match(url, /^https:\/\/gitlab\.com\/api\//)
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer private-gitlab-token')
    if (url.includes('/projects?membership=true')) {
      return revoked ? new Response('', { status: 401 }) : Response.json([
        { id: 11, path_with_namespace: 'Acme/BigProject', name_with_namespace: 'Acme / BigProject', archived: false },
      ], { headers: { 'x-next-page': '' } })
    }
    if (url === 'https://gitlab.com/api/v4/projects/11') {
      return Response.json({ default_branch: defaultBranch, path_with_namespace: 'Acme/BigProject', archived: false })
    }
    if (url.includes('/repository/commits/')) {
      if (url.endsWith('/' + sha('1'))) return Response.json({ message: 'not found' }, { status: 404 })
      return Response.json({ id: commit })
    }
    if (url.includes('/repository/tree?')) {
      const query = new URL(url).searchParams
      assert.equal(query.get('ref'), commit)
      const path = query.get('path')!
      const page = Number(query.get('page'))
      const all = entries(path)
      if (missingPage && path === 'story/creative-direction' && page === 2) {
        return new Response('oops', { status: 500 })
      }
      const slice = duplicatePage && page === 2 && path === 'story/creative-direction'
        ? [all[0]!] : all.slice((page - 1) * 100, page * 100)
      return Response.json(slice, {
        headers: { 'x-next-page': page * 100 < all.length ? String(page + 1) : '' },
      })
    }
    if (url === 'https://gitlab.com/api/graphql') {
      const vars = JSON.parse(init?.body as string).variables as { fullPath: string; ref: string; paths: string[] }
      assert.equal(vars.fullPath, 'Acme/BigProject')
      assert.equal(vars.ref, commit)
      if (graphError) return new Response('fail', { status: 500 })
      const nodes = vars.paths.map(path => ({ path, size: filesize(path) }))
      if (invalidGraph) nodes.pop()
      return Response.json({ data: { project: { repository: { blobs: { nodes } } } } })
    }
    if (url.includes('/repository/files/')) {
      const decoded = decodeURIComponent(url.split('/repository/files/')[1]!.split('?')[0]!)
      const query = new URL(url).searchParams
      assert.equal(query.get('ref'), commit)
      const entry = lookup(decoded)
      assert.ok(entry, 'unexpected file: ' + decoded)
      const size = filesize(decoded)
      if (method === 'HEAD') return new Response(null, { headers: {
        'x-gitlab-size': String(size),
        'x-gitlab-blob-id': wrongHead ? sha('0') : entry.id,
        'x-gitlab-commit-id': wrongCommit ? sha('1') : commit, 'x-gitlab-ref': commit,
      } })
      assert.equal(method, 'GET')
      const data = decoded.endsWith('.gitattributes') ? '*.md filter=lfs\n' : content()
      return Response.json({
        encoding: 'base64', content: Buffer.from(data).toString('base64'),
        blob_id: entry.id, commit_id: commit, file_path: decoded, size: Buffer.byteLength(data),
      })
    }
    throw new Error('unexpected fetch: ' + url)
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
      return { cookie: 'better-auth.session_token=' + session.token + '.' +
        createHmac('sha256', secret).update(session.token).digest('base64'), origin }
    }
    const cookie = await headers(alice.id)
    const other = await headers(bob.id)
    const repositoryId = '11111111-1111-4111-8111-111111111111'
    await store.persistence.repositories.upsert(alice.id, 'gitlab', '11',
      'Acme/BigProject', null, repositoryId, new Date().toISOString())
    const request = (method: string, query: string, body?: object, session = cookie, requestOrigin = origin) =>
      new Request(origin + '/api/gitlab/stories' + query, {
        method, headers: { ...session, origin: requestOrigin, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    const get = (query: string, session?: typeof cookie) =>
      gitlabStoryRequest(auth, store, request('GET', query, undefined, session),)
    const post = (body: object, requestOrigin?: string) =>
      gitlabStoryRequest(auth, store, request('POST', '', body, cookie, requestOrigin))
    const base = { repositoryId, directory: 'story', commit }
    const query = '?' + new URLSearchParams({ repositoryId })
    assert.equal((await get(query, other)).status, 409) // Bob has no linked GitLab identity
    await ctx.internalAdapter.createAccount({ userId: bob.id, providerId: 'gitlab', accountId: 'bob', accessToken: 'private-gitlab-token' })
    assert.equal((await get(query, other)).status, 404) // Linked identity does not grant Alice's catalog access
    const listed = await get(query)
    assert.equal(listed.status, 200)
    assert.deepEqual((await listed.json()).directories.map((d: { path: string }) => d.path), ['story', 'huge-assets'])
    const browse = await get(query + '&directory=story&commit=' + commit)
    assert.equal(browse.status, 200)
    assert.equal((await browse.json()).isStory, true)
    const detection = await get(query + '&mode=discover&commit=' + commit)
    assert.equal(detection.status, 200)
    assert.deepEqual((await detection.json()).stories, ['story'])
    assert.equal((await post(base, 'https://evil.invalid')).status, 403)
    assert.equal((await post({ ...base, directory: '../something' })).status, 400)
    assert.equal((await post({ ...base, commit: sha('1') })).status, 404)
    const initial = await post(base)
    assert.equal(initial.status, 200, JSON.stringify(await initial.clone().json()))
    const body = await initial.json()
    assert.equal(body.sizeBytes, STORY_LIMIT_BYTES)
    assert.equal(body.blobCount, 103)
    assert.equal(body.story.directory, 'story')
    assert.equal(body.story.commit, commit)
    assert.equal((await post(base)).status, 200)
    assert.equal((await store.persistence.dashboard.forOwner(alice.id)).stories.length, 1)
    assert.ok(requests.some(call => call.url.includes('page=2')))
    assert.ok(requests.some(call => call.url === 'https://gitlab.com/api/graphql'))
    assert.equal(requests.some(call => call.url.includes('huge-assets/') && call.method !== 'GET'), false)
    extraSize = 1
    assert.equal((await post(base)).status, 422)
    extraSize = 0
    graphError = true
    const fallback = await post(base)
    assert.equal(fallback.status, 200, JSON.stringify(await fallback.clone().json()))
    assert.ok(requests.some(call => call.method === 'HEAD'))
    wrongHead = true
    assert.equal((await post(base)).status, 422)
    wrongHead = false
    wrongCommit = true
    assert.equal((await post(base)).status, 422)
    wrongCommit = false
    graphError = false
    invalidGraph = true
    assert.equal((await post(base)).status, 200) // Incomplete GraphQL batch is verified via HEAD
    invalidGraph = false
    lfs = true
    assert.equal((await post(base)).status, 422)
    lfs = false
    lfsAttributes = true
    assert.equal((await post(base)).status, 422)
    lfsAttributes = false
    submodule = true
    assert.equal((await post(base)).status, 422)
    submodule = false
    missingPage = true
    assert.notEqual((await post(base)).status, 200)
    missingPage = false
    duplicatePage = true
    assert.equal((await post(base)).status, 422)
    duplicatePage = false
    revoked = true
    assert.equal((await post(base)).status, 409)
    assert.equal((await store.persistence.dashboard.forOwner(alice.id)).stories.length, 1)
    assert.ok(requests.every(call => !call.url.includes('private-gitlab-token')))
    defaultBranch = 'moved'
    // An explicit pin remains immutable even if default-branch config changes.
    revoked = false
    assert.equal((await post(base)).status, 200)
  } finally {
    globalThis.fetch = original
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
