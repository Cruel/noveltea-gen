import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createStudioAuth } from '../src/lib/auth'
import { openStudioDatabase } from './support/studio-database'
import { migrateStudio } from './support/studio-database'
import { githubStoryRequest, STORY_LIMIT_BYTES } from '../src/lib/github-stories.server'
import { errorResponse } from '../src/lib/github-repositories.server'

const origin = 'http://localhost:3000'
const secret = 'github-story-tests-01234567890123456789012345'
const config = {
  baseURL: origin, secret,
  github: { clientId: 'app-client', clientSecret: 'app-secret' },
  gitlab: { clientId: 'gl-client', clientSecret: 'gl-secret' },
}
const sha = (digit: string) => digit.repeat(40)
const commit = sha('a')
const root = sha('b')
const storyTree = sha('c')
const directionTree = sha('d')
const storyBlob = sha('e')
const tinyBlob = sha('f')
const otherTree = sha('1')
const otherBlob = sha('2')
const submodule = sha('3')
const attrBlob = sha('4')
const rootEntries = [
  { path: '.gitattributes', type: 'blob', mode: '100644', sha: attrBlob, size: 17 },
  { path: 'game-assets', type: 'tree', mode: '040000', sha: otherTree },
  { path: 'sample-story', type: 'tree', mode: '040000', sha: storyTree },
  // An unrelated submodule and symlink must not invalidate this Story.
  { path: 'vendor', type: 'commit', mode: '160000', sha: submodule },
  { path: 'link', type: 'blob', mode: '120000', sha: otherBlob, size: 8 },
]

test('GitHub Story preflight is owner-scoped, commit-pinned, bounded and avoids monorepo asset blobs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-gh-story-'))
  const store = openStudioDatabase(join(dir, 'studio.sqlite'))
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  let storySize = STORY_LIMIT_BYTES - 500
  let truncate = false
  let invalid = false
  let lfs = false
  let revoke = false
  let unsupported = false
  let defaultBranch = 'main'
  let repositoryEmpty = false
  let attributes = '*.bin filter=lfs'
  const blobText = () => lfs
    ? 'version https://git-lfs.github.com/spec/v1\noid sha256:' + sha('a') + '\nsize 999999999\n'
    : 'canonical Story metadata'
  const blobEntry = () => ({ path: 'foundation.md', type: 'blob', mode: '100644', sha: storyBlob, size: invalid ? undefined : storySize })
  const smallEntry = () => ({ path: 'README.md', type: 'blob', mode: '100644', sha: tinyBlob, size: Buffer.byteLength(blobText()) })
  const tree = (hash: string, recursive: boolean) => {
    if (hash === root) return { sha: root, truncated: recursive && truncate, tree: recursive && !truncate
      ? [...rootEntries,
        { ...blobEntry(), path: 'sample-story/creative-direction/foundation.md' },
        { ...smallEntry(), path: 'sample-story/README.md' },
        { path: 'sample-story/creative-direction', type: 'tree', mode: '040000', sha: directionTree },
        // Many unrelated assets must not count towards the selected Story.
        { path: 'game-assets/large.mp4', type: 'blob', mode: '100644', size: 2_000_000_000, sha: otherBlob }]
      : rootEntries }
    if (hash === storyTree) return { sha: storyTree, truncated: recursive && truncate, tree: recursive && !truncate
      ? [
        { path: 'creative-direction', type: 'tree', mode: '040000', sha: directionTree },
        { ...blobEntry(), path: 'creative-direction/foundation.md' },
        smallEntry(),
        ...(unsupported ? [{ path: 'external', type: 'commit', mode: '160000', sha: submodule }] : []),
      ] : [
        { path: 'creative-direction', type: 'tree', mode: '040000', sha: directionTree },
        smallEntry(),
        ...(unsupported ? [{ path: 'external', type: 'commit', mode: '160000', sha: submodule }] : []),
      ] }
    if (hash === directionTree) return { sha: directionTree, truncated: false, tree: [invalid
      ? { ...blobEntry(), size: undefined }
      : blobEntry()] }
    if (hash === otherTree) return { sha: otherTree, truncated: false, tree: [
      { path: 'huge.bin', type: 'blob', mode: '100644', sha: otherBlob, size: 2_000_000_000 }] }
    throw new Error('Unexpected tree ' + hash)
  }
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push(url)
    assert.match(url, /^https:\/\/api.github.com\//)
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer mock-secret')
    if (url.includes('/user/installations/12/repositories')) return Response.json({
      total_count: revoke ? 0 : 1, repositories: revoke ? [] : [
        { id: 123, full_name: 'Acme/BigRepo', permissions: { push: true }, private: true }] })
    if (url.includes('/user/installations')) return Response.json({
      total_count: 1, installations: [{
        id: 12, account: { login: 'Acme', type: 'Organization' }, repository_selection: 'all',
        permissions: { contents: 'write' }, suspended_at: null,
      }] })
    if (url.endsWith('/repos/Acme/BigRepo')) return Response.json({ default_branch: defaultBranch })
    if (url.endsWith('/repos/Acme/BigRepo/commits/' + defaultBranch)) {
      if (repositoryEmpty) return Response.json({ message: 'Git Repository is empty.', status: 409 }, { status: 409 })
      return Response.json({ sha: commit, commit: { tree: { sha: root } } })
    }
    if (url.endsWith('/repos/Acme/BigRepo/git/commits/' + commit)) return Response.json({ sha: commit, tree: { sha: root } })
    if (url.includes('/repos/Acme/BigRepo/git/commits/')) return Response.json({ message: 'Not Found' }, { status: 404 })
    const match = url.match(/\/git\/trees\/([a-f0-9]{40})(\?recursive=1)?$/)
    if (match) return Response.json(tree(match[1]!, !!match[2]))
    if (url.endsWith('/git/blobs/' + attrBlob)) return Response.json({
      encoding: 'base64', content: Buffer.from(attributes).toString('base64'), size: Buffer.byteLength(attributes),
    })
    if (url.endsWith('/git/blobs/' + tinyBlob)) return Response.json({
      encoding: 'base64', content: Buffer.from(blobText()).toString('base64'), size: Buffer.byteLength(blobText()),
    })
    throw new Error('Unexpected request: ' + url)
  }
  try {
    await migrateStudio(store, config)
    const auth = createStudioAuth(store, config)
    const context = await auth.$context
    const alice = await context.internalAdapter.createUser({ name: 'Alice', email: 'alice@example.test', emailVerified: true }, { method: 'test' })
    const bob = await context.internalAdapter.createUser({ name: 'Bob', email: 'bob@example.test', emailVerified: true }, { method: 'test' })
    await context.internalAdapter.createAccount({ userId: alice.id, providerId: 'github', accountId: 'alice', accessToken: 'mock-secret' })
    await context.internalAdapter.createAccount({ userId: bob.id, providerId: 'github', accountId: 'bob', accessToken: 'mock-secret' })
    const makeCookie = async (id: string) => {
      const session = await context.internalAdapter.createSession(id)
      return 'better-auth.session_token=' + session.token + '.' +
        createHmac('sha256', secret).update(session.token).digest('base64')
    }
    const cookie = await makeCookie(alice.id)
    const otherCookie = await makeCookie(bob.id)
    const repoId = '11111111-1111-4111-8111-111111111111'
    await store.persistence.repositories.upsert(alice.id, 'github', '123',
      'Acme/BigRepo', null, repoId, new Date().toISOString())
    const request = (method: string, query = '', body?: object, session = cookie, suppliedOrigin = origin) =>
      new Request(origin + '/api/github/stories' + query, {
        method, headers: { cookie: session, origin: suppliedOrigin, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    const get = (query: string, session?: string) => githubStoryRequest(auth, store, request('GET', query, undefined, session), origin)
    const post = (body: object, suppliedOrigin?: string) =>
      githubStoryRequest(auth, store, request('POST', '', body, cookie, suppliedOrigin), origin)
    const query = '?' + new URLSearchParams({ repositoryId: repoId })
    assert.equal((await get(query, otherCookie)).status, 404)
    const browse = await get(query)
    assert.equal(browse.status, 200)
    const data = await browse.json()
    assert.equal(data.commit, commit)
    assert.deepEqual(data.directories.map((d: { path: string }) => d.path), ['game-assets', 'sample-story'])
    assert.equal(data.isStory, false)
    // GitHub returns 409 for an empty repository. The API must communicate
    // that actionable state instead of reporting a generic 502 outage.
    repositoryEmpty = true
    const empty = await get(query)
    assert.equal(empty.status, 409)
    assert.match((await empty.json()).error, /no commits|empty repository/i)
    repositoryEmpty = false
    const subdir = await get(query + '&directory=sample-story&commit=' + commit)
    assert.equal(subdir.status, 200)
    assert.equal((await subdir.json()).isStory, true)
    const discovery = await get(query + '&commit=' + commit + '&mode=discover')
    assert.equal(discovery.status, 200)
    assert.deepEqual((await discovery.json()).stories, ['sample-story'])

    const base = { repositoryId: repoId, directory: 'sample-story', commit }
    // Browsing may work without Studio migrations, but importing must fail
    // closed instead of reporting an upstream GitHub error or changing the DB.
    const migrations = await store.testing.schema.migrationHistory()
    ;(await store.testing.schema.removeMigrationHistory())
    const outdated = await post(base)
    assert.equal(outdated.status, 503)
    assert.match((await outdated.json()).error, /migration|source integrity|schema/i)
    for (const migration of migrations)
      await store.testing.schema.appendMigration(migration.hash, migration.createdAt)
    // Restore exact DDL with a savepoint: DROP + ADD changes the generated schema.
    ;(await store.testing.schema.beginTemporaryColumnDrop('stories', 'source_commit_sha'))
    const inconsistent = await post(base)
    assert.equal(inconsistent.status, 503)
    assert.match((await inconsistent.json()).error, /schema|drift|reset/i)
    ;(await store.testing.schema.rollbackTemporaryColumnDrop())
    assert.equal((await post({ ...base, commit: null })).status, 400)
    assert.equal((await post(base, 'https://attacker.invalid')).status, 403)
    assert.equal((await post({ ...base, directory: '../elsewhere' })).status, 400)
    assert.equal((await post({ ...base, commit: sha('9') })).status, 404)
    const initial = await post(base)
    assert.equal(initial.status, 200, JSON.stringify({ body: await initial.clone().json(), calls: calls.slice(-12) }))
    const selected = await initial.json()
    assert.equal(selected.sizeBytes, STORY_LIMIT_BYTES - 500 + Buffer.byteLength(blobText()))
    assert.equal(selected.story.commit, commit)
    assert.equal(selected.story.directory, 'sample-story')
    assert.equal((await post(base)).status, 200)
    assert.equal((await store.persistence.dashboard.forOwner(alice.id)).stories.length, 1)
    assert.equal((await store.persistence.dashboard.forOwner(alice.id)).stories[0]?.commitSha, commit)
    assert.equal(calls.some(url => url.includes('/git/blobs/' + otherBlob)), false)
    assert.equal(calls.some(url => url.includes('/git/trees/' + otherTree)), false)
    assert.ok(calls.every(url => !url.includes('mock-secret')))

    storySize = STORY_LIMIT_BYTES + 1
    const oversized = await post(base)
    assert.equal(oversized.status, 422)
    assert.match((await oversized.json()).error, /100 MB/)
    storySize = STORY_LIMIT_BYTES - 500
    lfs = true
    const lfsResult = await post(base)
    assert.equal(lfsResult.status, 422)
    assert.match((await lfsResult.json()).error, /LFS/)
    lfs = false
    // A root-level LFS rule for unrelated game assets does not block the
    // Story; an applicable rule does, even when the pointer itself is large.
    attributes = '*.md filter=lfs'
    const attributed = await post(base)
    assert.equal(attributed.status, 422)
    assert.match((await attributed.json()).error, /LFS/)
    attributes = '[am] filter=lfs'
    assert.equal((await post(base)).status, 422)
    attributes = '*.bin filter=lfs'
    unsupported = true
    assert.equal((await post(base)).status, 422)
    unsupported = false
    invalid = true
    // Metadata that cannot establish blob size must not be accepted.
    assert.equal((await post(base)).status, 422)
    invalid = false
    truncate = true
    // GitHub's recursive Tree endpoint can truncate: the implementation
    // falls back to individual nonrecursive directory trees.
    const resumed = await post(base)
    assert.equal(resumed.status, 200)
    const fallbackDiscovery = await get(query + '&commit=' + commit + '&mode=discover')
    assert.equal(fallbackDiscovery.status, 200)
    assert.deepEqual((await fallbackDiscovery.json()).stories, ['sample-story'])
    revoke = true
    assert.equal((await post(base)).status, 404)
    // Existing imported record survives a temporary revoked installation.
    assert.equal((await store.persistence.dashboard.forOwner(alice.id)).stories.length, 1)
  } finally {
    globalThis.fetch = originalFetch
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('unexpected local server errors are logged with a reference, never misreported as GitHub outages', async () => {
  const original = console.error
  const logs: unknown[][] = []
  console.error = (...args: unknown[]) => { logs.push(args) }
  try {
    const response = errorResponse(new Error('private-provider-details-MUST-NOT-LEAK'))
    assert.equal(response.status, 500)
    const body = await response.json()
    assert.match(body.error, /Studio encountered an internal error.*reference/)
    assert.doesNotMatch(body.error, /GitHub|private-provider-details/)
    assert.equal(logs.length, 1)
    const reference = body.error.match(/reference ([a-f0-9]{8})/)?.[1]
    assert.ok(reference)
    assert.match(JSON.stringify(logs[0]), new RegExp(reference))
    assert.doesNotMatch(JSON.stringify(logs), /private-provider-details/)
  } finally { console.error = original }
})
