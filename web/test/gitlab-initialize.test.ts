import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createStudioAuth } from '../src/lib/auth'
import { openStudioDatabase } from '../src/db/connection'
import { migrateStudio } from '../src/db/migrations'
import { readUserDashboard } from '../src/lib/catalog'
import { gitlabInitializeRequest, validateNewStory } from '../src/lib/gitlab-initialize.server'
import { gitlabStoryRequest } from '../src/lib/gitlab-stories.server'
import { renderFoundation } from '../../src/foundation-record'

const origin = 'http://localhost:3000'
const config = { baseURL: origin, secret: 'gitlab-bootstrap-stable-test-secret-1234567890',
  github: { clientId: 'github', clientSecret: 'github-secret' },
  gitlab: { clientId: 'gitlab', clientSecret: 'gitlab-secret' } }
const sha = (digit: string) => digit.repeat(40)
const start = sha('a'), committed = sha('b')
const repositoryId = '22222222-2222-4222-8222-222222222222'
const foundation = {
  id: 'first',
  title: 'The Lantern Archive',
  premise: 'An archivist seeks a missing colleague.',
  central_conflict: 'Evidence versus loyalty',
  genre: 'Mystery',
  tone: 'Quietly unsettling',
  player_experience: 'Dialogue-driven detective story',
  scope: 'One archive and a small cast',
  decision: 'The player cannot leave the archive.',
  body: 'The setting is an isolated archive. The opening mystery is personal.',
}
function fixtureContent() {
  return renderFoundation({
    id: foundation.id, title: foundation.title, premise: foundation.premise,
    central_conflict: foundation.central_conflict, genre: foundation.genre,
    tone: foundation.tone, player_experience: foundation.player_experience,
    scope: foundation.scope, body: foundation.body,
    decisions: [{ id: 'initial-direction', statement: foundation.decision,
      origin: 'user', authority: 'user-protected' }],
  })
}
test('GitLab Story initialization uses a new review branch, validates, and reopens at pinned commit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-gitlab-bootstrap-'))
  const oldNative = process.env.NT_NATIVE_CLI
  const oldFetch = globalThis.fetch
  const native = join(root, 'validator')
  // This stub verifies the native CLI invocation and output contract. An
  // optional separate test below uses the real installed native CLI.
  writeFileSync(native, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv.at(-1);
const text = fs.readFileSync(path.join(root,'creative-direction/foundation.md'),'utf8');
if (!text.includes("schema: '0.1'") || !text.includes('authority: user-protected') ||
    !text.includes('The Lantern Archive')) process.exit(1);
console.log(JSON.stringify({success: true, exitCode: 0, diagnostics: [],
  catalog: {diagnostics: [], records: [{path: 'creative-direction/foundation.md',
    metadata: {schema: '0.1', type: 'creative-direction', status: 'draft'}}]}}));
`)
  chmodSync(native, 0o700)
  process.env.NT_NATIVE_CLI = native
  const store = openStudioDatabase(join(root, 'studio.sqlite'))
  let empty = false, emptyBranchConfigured = false, previousDefault = start,
    filesAlreadyExist = false, remoteRevision: string | null = null
  const commits: Array<{ branch: string; start_sha?: string; actions: Array<{ action: string; file_path: string; content: string }> }> = []
  const contacted: string[] = []
  globalThis.fetch = async (input, init) => {
    const url = String(input), method = init?.method || 'GET'
    contacted.push(method + ' ' + url)
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fake-gitlab-token')
    if (url.includes('/projects?membership=true')) {
      return Response.json([{ id: 11, path_with_namespace: 'Acme/Project',
        name_with_namespace: 'Acme / Project', archived: false }], { headers: { 'x-next-page': '' } })
    }
    if (url.endsWith('/projects/11')) {
      return Response.json({ id: 11, path_with_namespace: 'Acme/Project', archived: false,
        empty_repo: empty && !remoteRevision,
        default_branch: empty && !remoteRevision && !emptyBranchConfigured ? null : 'main' })
    }
    if (url.includes('/repository/commits/') && method === 'GET') {
      return Response.json({ id: url.endsWith('/main') ? previousDefault : committed })
    }
    if (url.endsWith('/repository/commits') && method === 'POST') {
      const data = JSON.parse(init?.body as string) as (typeof commits)[number]
      commits.push(data)
      assert.deepEqual(data.actions.map(a => a.action), ['create'])
      assert.equal(data.actions[0]?.file_path, 'story/creative-direction/foundation.md')
      assert.equal(data.actions[0]?.content, fixtureContent())
      remoteRevision = committed
      return Response.json({ id: committed, parent_ids: data.start_sha ? [data.start_sha] : [] }, { status: 201 })
    }
    if (url.includes('/repository/tree?')) {
      const params = new URL(url).searchParams
      const path = params.get('path') || ''
      const ref = params.get('ref')
      if (ref === start && path === 'story') {
        return filesAlreadyExist ? Response.json([{ name: 'existing.txt' }]) :
          new Response('', { status: 404 })
      }
      if (ref !== committed) throw new Error('Unexpected tree revision ' + ref)
      const entry = (p: string, type = 'tree') => {
        const name = p.split('/').at(-1)
        return { id: sha(type === 'tree' ? 'd' : 'e'), name, path: p, type,
          mode: type === 'tree' ? '040000' : '100644' }
      }
      if (path === 'story') return Response.json([entry('story/creative-direction')])
      if (path === 'story/creative-direction') return Response.json([entry('story/creative-direction/foundation.md', 'blob')])
      return Response.json([])
    }
    if (url.endsWith('/api/graphql')) {
      const vars = JSON.parse(init?.body as string).variables as { paths: string[]; ref: string }
      assert.equal(vars.ref, committed)
      return Response.json({ data: { project: { repository: { blobs: {
        nodes: vars.paths.map(path => ({ path, size: Buffer.byteLength(fixtureContent()) })),
      } } } } })
    }
    if (url.includes('/repository/files/')) {
      return Response.json({ encoding: 'base64', content: Buffer.from(fixtureContent()).toString('base64'),
        blob_id: sha('e'), commit_id: committed, file_path: 'story/creative-direction/foundation.md',
        size: Buffer.byteLength(fixtureContent()) })
    }
    throw new Error('Unexpected GitLab request: ' + method + ' ' + url)
  }
  try {
    await migrateStudio(store, config)
    const auth = createStudioAuth(store, config)
    const ctx = await auth.$context
    const user = await ctx.internalAdapter.createUser({ name: 'Alice', email: 'alice@example.test',
      emailVerified: true }, { method: 'test' })
    const outsider = await ctx.internalAdapter.createUser({ name: 'Bob', email: 'bob@example.test',
      emailVerified: true }, { method: 'test' })
    for (const who of [user, outsider]) {
      await ctx.internalAdapter.createAccount({ userId: who.id, providerId: 'gitlab',
        accountId: who.id, accessToken: 'fake-gitlab-token' })
    }
    store.sqlite.prepare(`INSERT INTO repositories
      (id,owner_user_id,provider,provider_repository_id,name,created_at)
      VALUES (?,?,'gitlab','11','Acme/Project','2026-10-31')`).run(repositoryId, user.id)
    const cookie = async (id: string) => {
      const session = await ctx.internalAdapter.createSession(id)
      return 'better-auth.session_token=' + session.token + '.' +
        createHmac('sha256', config.secret).update(session.token).digest('base64')
    }
    const alice = await cookie(user.id), bob = await cookie(outsider.id)
    const payload = (shaValue: string | null = start) =>
      ({ repositoryId, directory: 'story', expectedCommit: shaValue, foundation })
    const request = (data: object, session = alice, location = origin) =>
      new Request(origin + '/api/gitlab/initialize', { method: 'POST',
        headers: { origin: location, cookie: session, 'content-type': 'application/json' },
        body: JSON.stringify(data) })
    const post = (data: object, session?: string, location?: string) =>
      gitlabInitializeRequest(auth, store, request(data, session, location), origin)
    const get = () => gitlabInitializeRequest(auth, store,
      new Request(origin + '/api/gitlab/initialize?repositoryId=' + repositoryId,
        { headers: { cookie: alice } }), origin)
    assert.equal((await get()).status, 200)
    assert.equal((await (await get()).json()).commit, start)
    assert.equal((await post(payload(), bob)).status, 404)
    assert.equal((await post(payload(), alice, 'https://evil.example')).status, 403)
    assert.equal((await post({ ...payload(), directory: '../bad' })).status, 400)
    assert.equal((await post({ ...payload(), directory: '.story-inbox' })).status, 400)
    assert.equal((await post({ ...payload(), directory: '.hidden' })).status, 400)
    assert.equal((await post({ ...payload(), discoveryApproval: {
      revision: 1, digest: 'f'.repeat(64),
    } })).status, 409, 'GitLab must reject an unbound model proposal before any commit')
    assert.equal((await post({ ...payload(), foundation: { ...foundation, id: 'BAD' } })).status, 400)
    assert.equal((await post(payload(sha('f')))).status, 409)
    filesAlreadyExist = true
    assert.equal((await post(payload())).status, 409)
    filesAlreadyExist = false
    process.env.NT_NATIVE_CLI = join(root, 'missing')
    assert.equal((await post(payload())).status, 503)
    process.env.NT_NATIVE_CLI = native
    assert.equal(commits.length, 0)
    const response = await post(payload())
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    const created = await response.json()
    assert.equal(created.mode, 'review-branch')
    assert.equal(created.baseSha, start)
    assert.match(created.branch, /^noveltea\/story-/)
    assert.equal(created.commit, committed)
    assert.equal(created.story.commitSha, committed)
    assert.equal(commits.length, 1)
    assert.equal(commits[0]?.start_sha, start)
    assert.notEqual(commits[0]?.branch, 'main')
    assert.equal(JSON.stringify(commits).includes('.noveltea'), false)
    assert.equal(previousDefault, start)
    assert.equal((store.sqlite.prepare('SELECT count(*) AS n FROM stories').get() as {n: number}).n, 1)
    assert.deepEqual(readUserDashboard(store, user.id).stories.map(story => ({
      directory: story.directory, commitSha: story.commitSha, repositoryId: story.repositoryId,
    })), [{ directory: 'story', commitSha: committed, repositoryId }])
    assert.equal((await post(payload())).status, 409)
    assert.equal(commits.length, 1)
    assert.equal((await gitlabStoryRequest(auth, store,
      new Request(origin + '/api/gitlab/stories?repositoryId=' + repositoryId +
        '&directory=story&commit=' + committed, { headers: { cookie: alice } }))).status, 200)
    assert.ok(contacted.every(url => !url.includes('fake-gitlab-token')))

    // Emulate a separate newly created, genuinely empty GitLab project.
    // Only this case can create the initial default-branch commit.
    store.sqlite.prepare('DELETE FROM stories').run()
    empty = true
    // Real GitLab returns empty_repo=true with an unborn default_branch=main.
    // This must not trigger a fetch for a commit that does not exist.
    emptyBranchConfigured = true
    remoteRevision = null
    commits.length = 0
    const snapshot = await get()
    assert.equal(snapshot.status, 200)
    assert.deepEqual(await snapshot.json(), {
      empty: true, defaultBranch: 'main', commit: null, repositoryId,
    })
    emptyBranchConfigured = false
    const withoutBranch = await get()
    assert.equal(withoutBranch.status, 200)
    assert.deepEqual(await withoutBranch.json(), {
      empty: true, defaultBranch: null, commit: null, repositoryId,
    })
    emptyBranchConfigured = true
    const initialPayload = { ...payload(null), directory: '', initialBranch: 'main' }
    assert.equal((await post({ ...initialPayload, initialBranch: 'main/../bad' })).status, 400)
    assert.equal((await post({ ...initialPayload, initialBranch: 'other' })).status, 409,
      'a configured unborn default branch cannot be silently replaced')
    assert.equal((await post({ ...initialPayload, expectedCommit: start })).status, 409)
    assert.equal(commits.length, 0)
    const initialResponse = await post(initialPayload)
    assert.equal(initialResponse.status, 200, JSON.stringify(await initialResponse.clone().json()))
    const initial = await initialResponse.json()
    assert.equal(initial.mode, 'initial-default')
    assert.equal(initial.branch, 'main')
    assert.equal(initial.baseSha, null)
    assert.equal(initial.story.commitSha, committed)
    assert.equal(initial.story.directory, 'story')
    assert.equal(commits.length, 1)
    assert.equal(commits[0]?.branch, 'main')
    assert.equal(commits[0]?.start_sha, undefined)
    assert.equal((await get()).status, 200)
    // An existing project can no longer use the empty-project bootstrap.
    assert.equal((await post(initialPayload)).status, 409)
    assert.equal(commits.length, 1)
    assert.equal((await gitlabStoryRequest(auth, store,
      new Request(origin + '/api/gitlab/stories?repositoryId=' + repositoryId +
        '&directory=story&commit=' + committed, { headers: { cookie: alice } }))).status, 200)
  } finally {
    store.sqlite.close()
    globalThis.fetch = oldFetch
    if (oldNative === undefined) delete process.env.NT_NATIVE_CLI
    else process.env.NT_NATIVE_CLI = oldNative
    rmSync(root, { recursive: true, force: true })
  }
})

test('optional: installed native NovelTea CLI validates the bootstrapped Creative Direction', {
  skip: !process.env.NT_REAL_NATIVE_CLI || !existsSync(process.env.NT_REAL_NATIVE_CLI),
}, async () => {
  const before = process.env.NT_NATIVE_CLI
  try {
    process.env.NT_NATIVE_CLI = process.env.NT_REAL_NATIVE_CLI
    await validateNewStory(fixtureContent())
  } finally {
    if (before === undefined) delete process.env.NT_NATIVE_CLI
    else process.env.NT_NATIVE_CLI = before
  }
})
