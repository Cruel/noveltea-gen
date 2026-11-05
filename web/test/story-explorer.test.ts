import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { removeTestTree } from '../../test/helpers'
import { openStudioDatabase } from '../src/db/connection'
import { migrateStudio } from '../src/db/migrations'
import { createStudioAuth } from '../src/lib/auth'
import { acquireCachedStory } from '../src/lib/git-cache.server'
import { canonicalExplorerIndex, canonicalRelationshipGraph, storyExplorerRequest,
  storyRelationshipsRequest } from '../src/lib/story-explorer.server'
import { generationConfigurationRequest } from '../src/lib/generation-config.server'
import { userPiCredentials } from '../src/lib/pi-credentials.server'

const secret = 'stable-test-secret-0123456789abcdefghijklmnopqrstuvwxyz'
const config = {
  baseURL: 'http://localhost:3000', secret,
  github: { clientId: 'github', clientSecret: 'github-secret' },
  gitlab: { clientId: 'gitlab', clientSecret: 'gitlab-secret' },
}
const jobId = '33333333-3333-4333-8333-333333333333'
const storyId = '22222222-2222-4222-8222-222222222222'
const repoId = '11111111-1111-4111-8111-111111111111'
const records = [
  { path: 'creative-direction/start.md', metadata: { type: 'creative-direction', id: 'creative-direction.start', title: 'First choice', status: 'draft' } },
  { path: 'arcs/warning.md', metadata: { type: 'arc', id: 'arc.warning', title: 'Restore the warning', status: 'draft' } },
  { path: 'milestones/bell.md', metadata: { type: 'milestone', id: 'milestone.bell', arcs: ['arc.warning'],
    fulfillment: { any_of: [['event.bell']] }, title: 'The bell rings', status: 'draft' } },
  { path: 'events/bell.md', metadata: { type: 'event', id: 'event.bell', arcs: ['arc.warning'], title: 'Ring the bell', status: 'draft' } },
  { path: 'future-kind/custom.md', metadata: { type: 'future-kind', id: 'future-kind.custom', title: 'New type', status: 'draft' } },
  { path: 'characters/stranger.md', metadata: { type: 'character', id: 'character.stranger', title: 'Stranger', status: 'draft' } },
]
const diagnostics = [
  { path: 'events/bell.md', line: 7, code: 'missing-field', message: 'A source field is missing' },
  { path: '.story-inbox/ideas/private.yaml', code: 'secret', message: 'Hidden path not to expose' },
]

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

test('native indexed Story explorer is owner-scoped, read-only, and never reveals the author inbox', {
  timeout: 180_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-story-explorer-'))
  const envKeys = ['NT_GIT_CACHE_DIR', 'NT_STATE_DIR', 'NT_NATIVE_CLI', 'NT_PI_CREDENTIAL_KEY']
  const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
  process.env.NT_GIT_CACHE_DIR = join(root, 'cache')
  process.env.NT_STATE_DIR = join(root, 'durable')
  process.env.NT_PI_CREDENTIAL_KEY = Buffer.alloc(32, 8).toString('base64')
  let store = openStudioDatabase(join(root, 'studio.sqlite'))
  try {
    await migrateStudio(store, config)
    const auth = createStudioAuth(store, config)
    const ctx = await auth.$context
    const alice = await ctx.internalAdapter.createUser({ name: 'Alice', email: 'alice@example.test', emailVerified: true }, { method: 'test' })
    const bob = await ctx.internalAdapter.createUser({ name: 'Bob', email: 'bob@example.test', emailVerified: true }, { method: 'test' })
    const cookie = async (id: string) => {
      const session = await ctx.internalAdapter.createSession(id)
      return 'better-auth.session_token=' + session.token + '.' +
        createHmac('sha256', secret).update(session.token).digest('base64')
    }
    const aliceCookie = await cookie(alice.id)
    const bobCookie = await cookie(bob.id)

    const repo = join(root, 'remote')
    for (const record of records) {
      const path = join(repo, 'story', record.path)
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, record.metadata.type === 'character'
        ? '---\nschema: "0.1"\ntype: character\nid: character.stranger\ntitle: "Stranger"\nstatus: draft\n---\n\nStranger.\n'
        : '# ' + record.metadata.title + '\n\nCanonical source content.\n')
    }
    writeFileSync(join(repo, 'story', 'events', 'retired.md'),
      '---\nschema: "0.1"\ntype: event\nid: event.retired\ntitle: "Old Event"\nstatus: draft\n---\n\nRetired.\n')
    mkdirSync(join(repo, '.story-inbox', 'ideas'), { recursive: true })
    writeFileSync(join(repo, '.story-inbox', 'ideas', 'private.yaml'), 'top-secret-inbox-content')
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.name', 'Author')
    git(repo, 'config', 'user.email', 'author@example.test')
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'Story and trusted inbox')
    const pinned = git(repo, 'rev-parse', 'HEAD')
    const bytes = records.reduce((sum, r) => sum + Buffer.byteLength(readFileSync(join(repo, 'story', r.path))), 0) +
      Buffer.byteLength(readFileSync(join(repo, 'story', 'events', 'retired.md')))
    const acquired = await acquireCachedStory({
      cacheDirectory: process.env.NT_GIT_CACHE_DIR, ownerId: alice.id,
      repositoryId: 'github:123', remoteUrl: 'file://' + repo, token: 'unused',
      commit: pinned, directory: 'story', jobId,
      verifiedSizeBytes: bytes, verifiedBlobCount: records.length + 1,
    })
    store.sqlite.prepare(`INSERT INTO repositories
      (id,owner_user_id,provider,provider_repository_id,name,created_at)
      VALUES (?,?,'github','123','Acme/Private','2026-11-01')`).run(repoId, alice.id)
    store.sqlite.prepare(`INSERT INTO stories
      (id,owner_user_id,repository_id,directory,title,created_at,source_commit_sha)
      VALUES (?,?,?,'story','Private Story','2026-11-01',?)`).run(storyId, alice.id, repoId, pinned)
    store.sqlite.prepare(`INSERT INTO studio_sessions
      (id,owner_user_id,story_id,title,source_commit_sha,status,created_at,updated_at)
      VALUES (?,?,?,'Private Story',?,'paused','2026-11-01','2026-11-01')`)
      .run(jobId, alice.id, storyId, pinned)

    // A deterministic native-CLI protocol fixture: real job pinning, baseline
    // checks and HTTP/auth boundaries run, but the model and provider stay offline.
    const cli = join(root, 'noveltea')
    writeFileSync(cli, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--version') {
  process.stdout.write('1.0.0\\n');
  process.exit(0);
}
const fs = require('node:fs');
const path = require('node:path');
const root = args[3];
const records = ${JSON.stringify(records)}.filter(r => fs.existsSync(path.join(root, r.path)));
for (const [file, id] of [['new.md', 'event.new'], ['draft.md', 'event.draft']]) {
  if (fs.existsSync(path.join(root, 'events', file))) records.push({
    path: 'events/' + file, metadata: { type: 'event', id, title: id, status: 'draft' }
  });
}
const diagnostics = ${JSON.stringify(diagnostics)};
const base = args[args.indexOf('--base') + 1];
const readiness = args.includes('--readiness');
const context = args.includes('context');
const manifest = { contractRevision: '0.1', unresolved: [], bounded: { truncated: false, maxDepth: 2, maxFiles: 128 },
  files: [
    { id: 'event.bell', path: 'events/bell.md', inclusions: [
      { code: 'requested-id', sourceId: 'event.bell', targetId: 'event.bell' },
      { code: 'arc-membership', sourceId: 'event.bell', targetId: 'arc.warning', pointer: '/arcs/0' }] },
    { id: 'arc.warning', path: 'arcs/warning.md', inclusions: [
      { code: 'arc-membership', sourceId: 'event.bell', targetId: 'arc.warning', pointer: '/arcs/0' }] },
    { id: 'milestone.bell', path: 'milestones/bell.md', inclusions: [
      { code: 'fulfillment', sourceId: 'milestone.bell', targetId: 'event.bell' }] },
  ] };
const payload = context ? { manifest } : {
  catalog: { contractRevision: '0.1', records, diagnostics,
    coverage: {}, authorization: {}, protection: { status: 'checked', base,
      authorizationVerified: false, complete: true, findings: [],
      impact: { changed: [], moved: [], affected: [] } } },
  ...(readiness ? { readiness: { contractRevision: '0.1', stage: 'review', view: 'design',
    design: { stages: {} }, approved: { stages: {} }, outstanding: [] } } : {}),
};
const exit = context ? 0 : 1;
process.stdout.write(JSON.stringify({protocolVersion: 1, exitCode: exit,
  success: exit === 0, diagnostics: [], ...payload}));
process.exit(exit);
`)
    chmodSync(cli, 0o755)
    process.env.NT_NATIVE_CLI = cli

    const api = async (suffix = '', session?: string) => {
      const response = await storyExplorerRequest(auth, store,
        new Request(config.baseURL + '/api/jobs/' + jobId + '/records' + suffix,
          { headers: session ? { cookie: session } : {} }), jobId)
      return { response, body: await response.json() as any }
    }
    assert.equal((await api()).response.status, 401)
    assert.equal((await api('', bobCookie)).response.status, 404)
    const { response, body } = await api('', aliceCookie)
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.match(response.headers.get('cache-control') ?? '', /no-store/)
    assert.equal(body.index.validation, 'rejected')
    assert.equal(body.index.protection, 'checked')
    assert.deepEqual(body.index.records.map((r: { id: string }) => r.id), records.map(r => r.metadata.id))
    assert.equal(body.index.records.find((r: { id: string }) => r.id === 'milestone.bell').events[0], 'event.bell')
    assert.equal(body.index.records.find((r: { id: string }) => r.id === 'future-kind.custom').path, 'future-kind/custom.md')
    assert.equal(body.index.diagnostics.length, 1)
    assert.equal(body.index.diagnostics[0].line, 7)
    assert.doesNotMatch(JSON.stringify(body), /top-secret-inbox-content|private.yaml|hidden path not to expose/)
    assert.equal(body.index.records.some((r: { path: string }) => r.path.includes('.story-inbox')), false)
    assert.equal((await api('?id=event.bell', aliceCookie)).body.markdown,
      '# Ring the bell\n\nCanonical source content.\n')
    assert.equal((await api('?id=../../.story-inbox/ideas/private.yaml', aliceCookie)).response.status, 404)
    assert.equal((await api('?path=events%2Fbell.md', aliceCookie)).response.status, 400)
    assert.equal((await api('?id=event.bell&id=arc.warning', aliceCookie)).response.status, 400)
    assert.equal((await api('?id=event.unknown', aliceCookie)).response.status, 404)

    const relationships = async (suffix: string, session?: string) => {
      const response = await storyRelationshipsRequest(auth, store,
        new Request(config.baseURL + '/api/jobs/' + jobId + '/relationships' + suffix,
          { headers: session ? { cookie: session } : {} }), jobId)
      return { response, body: await response.json() as any }
    }
    assert.equal((await relationships('?id=event.bell')).response.status, 401)
    assert.equal((await relationships('?id=event.bell', bobCookie)).response.status, 404)
    assert.equal((await relationships('?id=event.unknown', aliceCookie)).response.status, 404)
    assert.equal((await relationships('?id=event.bell&scope=other', aliceCookie)).response.status, 400)
    assert.equal((await relationships('?id=event.bell&kind=event', aliceCookie)).response.status, 400)
    assert.equal((await relationships('?id=event.bell&scope=related&scope=focused', aliceCookie)).response.status, 400)
    const relation = await relationships('?id=event.bell&scope=related', aliceCookie)
    assert.equal(relation.response.status, 200, JSON.stringify(relation.body))
    assert.deepEqual(relation.body.graph.relationships, [
      { source: 'event.bell', target: 'arc.warning', code: 'arc-membership' },
      { source: 'milestone.bell', target: 'event.bell', code: 'fulfillment' },
    ])
    assert.equal(relation.body.graph.protection, 'checked')
    assert.equal(relation.body.graph.validation, 'rejected')
    assert.equal(relation.body.graph.headSha, acquired.headSha)
    assert.doesNotMatch(JSON.stringify(relation.body), /private.yaml|top-secret-inbox-content/)

    // Generation configuration is an authenticated, native-catalog-validated
    // job resource. It must never infer writable targets from the UI graph.
    const configuration = async (method: 'GET' | 'PUT', value?: unknown,
      session?: string, origin = config.baseURL) => {
      const response = await generationConfigurationRequest(auth, store,
        new Request(config.baseURL + '/api/jobs/' + jobId + '/configuration', {
          method, headers: { origin, ...(session ? { cookie: session } : {}) },
          ...(method === 'PUT' ? { body: JSON.stringify(value) } : {}),
        }), jobId, config.baseURL)
      return { status: response.status, body: await response.json() as any }
    }
    assert.equal((await configuration('GET')).status, 401)
    assert.equal((await configuration('GET', undefined, bobCookie)).status, 404)
    const initial = await configuration('GET', undefined, aliceCookie)
    assert.equal(initial.status, 200)
    assert.equal(initial.body.models.length, 0, 'a host Pi model must not appear in another user’s catalog')
    assert.equal(initial.body.saved, null)
    const full = {
      version: 1, headSha: pinned, task: 'Outline the Story',
      contract: {
        scope: { kind: 'full-story', depth: 'composition', targets: [], branches: [] },
        constraints: [], envelope: { presentation: 'Visual novel', hardLimits: [], preferences: [] },
      },
      limits: { steps: 20, modelCalls: 5, costUsd: 1.5 }, model: null,
    }
    assert.equal((await configuration('PUT', full, aliceCookie, 'https://evil.test')).status, 403)
    assert.equal((await configuration('PUT', full, bobCookie)).status, 404)
    assert.equal((await configuration('PUT', { ...full, model: { provider: 'openai', id: 'host' } }, aliceCookie)).status, 422)
    const personal = userPiCredentials(store, alice.id)
    await personal.modify('openai', async () => ({ type: 'api_key', key: 'ALICE-STORY-KEY' }))
    const catalog = await configuration('GET', undefined, aliceCookie)
    assert.ok(catalog.body.models.length > 0, 'only a connected personal Pi provider offers models')
    const chosen = catalog.body.models[0]
    const pinnedModel = { provider: chosen.provider, id: chosen.id,
      ...(chosen.reasoning ? { thinking: 'medium' } : {}) }
    const modelDraft = { ...full, model: pinnedModel }
    const savedModel = await configuration('PUT', modelDraft, aliceCookie)
    assert.equal(savedModel.status, 200, JSON.stringify(savedModel.body))
    assert.deepEqual(savedModel.body.saved.model, pinnedModel)
    assert.deepEqual((await configuration('GET', undefined, aliceCookie)).body.saved.model, pinnedModel)
    assert.equal((await configuration('PUT', modelDraft, bobCookie)).status, 404,
      'cross-user selection cannot borrow Alice credentials')
    await personal.delete('openai')
    const disconnected = await configuration('GET', undefined, aliceCookie)
    assert.deepEqual(disconnected.body.saved.model, pinnedModel,
      'revocation retains a pinned draft for recovery without silently switching models')
    assert.deepEqual(disconnected.body.models, [])
    assert.equal((await configuration('PUT', modelDraft, aliceCookie)).status, 422,
      'revoked credentials block new job model selection')
    assert.equal((await configuration('PUT', { ...full, headSha: 'a'.repeat(40) }, aliceCookie)).status, 422)
    assert.equal((await configuration('PUT', { ...full, limits: { steps: -1 } }, aliceCookie)).status, 422)
    assert.equal((await configuration('PUT', {
      ...full, contract: { ...full.contract, scope: { ...full.contract.scope, targets: ['arc.warning'] } },
    }, aliceCookie)).status, 422, 'no implicit whole-Story scope widening')
    const partial = { ...full, contract: {
      ...full.contract, scope: { kind: 'partial', depth: 'composition',
        targets: ['arc.warning', 'event.bell'], branches: [] },
    } }
    assert.equal((await configuration('PUT', partial, aliceCookie)).status, 422, 'mixed cluster and record targets fail')
    const duplicate = { ...full, contract: { ...full.contract,
      scope: { kind: 'partial', depth: 'architecture', targets: ['arc.warning', 'arc.warning'], branches: [] } } }
    assert.equal((await configuration('PUT', duplicate, aliceCookie)).status, 422)
    const missing = { ...full, contract: { ...full.contract,
      scope: { kind: 'partial', depth: 'architecture', targets: ['arc.not-real'], branches: [] } } }
    assert.equal((await configuration('PUT', missing, aliceCookie)).status, 422)
    const unrelated = { ...full, contract: { ...full.contract,
      scope: { kind: 'partial', depth: 'composition', targets: ['arc.warning'], branches: [],
        supportingTargets: ['character.stranger'] } } }
    assert.equal((await configuration('PUT', unrelated, aliceCookie)).status, 422,
      'unrelated supporting edits cannot be authorized through context expansion')
    const focused = { ...full, contract: { ...full.contract,
      scope: { kind: 'partial', depth: 'interactive', targets: ['event.bell'], branches: ['protect'] } } }
    const stored = await configuration('PUT', focused, aliceCookie)
    assert.equal(stored.status, 200, JSON.stringify(stored.body))
    assert.deepEqual(stored.body.saved.contract.scope.targets, ['event.bell'])
    assert.deepEqual(stored.body.saved.limits, full.limits)
    assert.deepEqual((await configuration('GET', undefined, aliceCookie)).body.saved, stored.body.saved)
    const savedRow = store.sqlite.prepare('SELECT generation_config_json AS config FROM studio_sessions WHERE id=?')
      .get(jobId) as { config: string }
    assert.deepEqual(JSON.parse(savedRow.config), stored.body.saved)
    // Once a job is pinned to execution, configuration is immutable.
    store.sqlite.prepare('UPDATE studio_sessions SET generation_request_json=?, generation_thread_id=? WHERE id=?')
      .run('{"pinned":true}', acquired.threadId + ':generation:web', jobId)
    assert.equal((await configuration('PUT', focused, aliceCookie)).status, 409)
    const readOnly = await configuration('GET', undefined, aliceCookie)
    assert.equal(readOnly.status, 200)
    assert.equal(readOnly.body.editable, false)
    assert.deepEqual(readOnly.body.saved, stored.body.saved)
    store.sqlite.prepare('UPDATE studio_sessions SET generation_request_json=NULL, generation_thread_id=NULL WHERE id=?').run(jobId)

    // Full Git overlay: baseline -> verified commit and verified HEAD -> dirty
    // worktree are independent. Deleted records never become navigable IDs.
    const working = acquired.worktreeRoot
    writeFileSync(join(acquired.worktreeStoryRoot, 'events', 'bell.md'), '# Updated Bell\n')
    writeFileSync(join(acquired.worktreeStoryRoot, 'events', 'new.md'),
      '---\nschema: "0.1"\ntype: event\nid: event.new\ntitle: "New Event"\nstatus: draft\n---\n\nNew.\n')
    unlinkSync(join(acquired.worktreeStoryRoot, 'events', 'retired.md'))
    git(working, 'add', '--', 'story')
    git(working, 'commit', '-qm', 'Verified Story edits')
    const verifiedHead = git(working, 'rev-parse', 'HEAD')
    assert.equal((await api('', aliceCookie)).response.status, 409,
      'an unverified branch HEAD must not be displayed as a verified change')
    mkdirSync(join(acquired.stateDir, 'revisions'), { recursive: true })
    writeFileSync(join(acquired.stateDir, 'revisions', 'verified-head.json'),
      JSON.stringify({ version: 1, jobId, headSha: verifiedHead, workItemId: 'test' }))
    writeFileSync(join(acquired.worktreeStoryRoot, 'events', 'bell.md'), '# Dirty Bell\n')
    writeFileSync(join(acquired.worktreeStoryRoot, 'events', 'draft.md'), '# Uncommitted Draft\n')
    unlinkSync(join(acquired.worktreeStoryRoot, 'characters', 'stranger.md'))
    mkdirSync(join(acquired.worktreeStoryRoot, 'notes'), { recursive: true })
    for (let i = 0; i < 30; i++) writeFileSync(
      join(acquired.worktreeStoryRoot, 'notes', 'unindexed-' + i + '.md'), '# Not in canonical catalog\n')
    const changed = await api('', aliceCookie)
    assert.equal(changed.response.status, 200, JSON.stringify(changed.body))
    assert.equal(changed.body.index.headSha, verifiedHead)
    const byId = (id: string) => changed.body.index.records.find((r: { id: string }) => r.id === id)
    assert.deepEqual(byId('event.bell').change, { committed: 'modified', uncommitted: 'modified' })
    assert.deepEqual(byId('event.new').change, { committed: 'added' })
    assert.deepEqual(byId('event.draft').change, { uncommitted: 'added' })
    assert.equal(byId('character.stranger'), undefined)
    assert.deepEqual(changed.body.index.deletedRecords.map((r: { id: string; path: string; change: unknown }) =>
      ({ id: r.id, path: r.path, change: r.change })), [
      { id: 'character.stranger', path: 'characters/stranger.md', change: { uncommitted: 'deleted' } },
      { id: 'event.retired', path: 'events/retired.md', change: { committed: 'deleted' } },
    ])
    assert.ok(changed.body.index.deletedRecords.every((r: { id: string }) =>
      !changed.body.index.records.some((n: { id: string }) => n.id === r.id)))
    assert.equal(changed.body.index.unindexedRecords.length, 30,
      'the explorer must not reuse the 24-file progress-log limit')
    assert.deepEqual(changed.body.index.unindexedRecords[0],
      { path: 'notes/unindexed-0.md', change: { uncommitted: 'added' } })
    const changedGraph = await relationships('?id=event.bell', aliceCookie)
    assert.equal(changedGraph.response.status, 200, JSON.stringify(changedGraph.body))
    assert.deepEqual(changedGraph.body.graph.records.find((r: { id: string }) => r.id === 'event.bell').change,
      { committed: 'modified', uncommitted: 'modified' })
    assert.equal(changedGraph.body.graph.relationships.length, 2,
      'Git overlay must not invent deleted-record relationship edges')
    assert.doesNotMatch(JSON.stringify(changed.body), /top-secret-inbox-content|private.yaml/)

    // A concurrent change to the worktree must not turn the indexed path
    // into a file read through a symlink, even if the validator fixture lists it.
    unlinkSync(join(acquired.worktreeStoryRoot, 'events', 'bell.md'))
    symlinkSync(join(repo, '.story-inbox', 'ideas', 'private.yaml'), join(acquired.worktreeStoryRoot, 'events', 'bell.md'))
    assert.equal((await api('?id=event.bell', aliceCookie)).response.status, 409)
    assert.equal((await relationships('?id=event.bell', aliceCookie)).response.status, 409)
  } finally {
    store.sqlite.close()
    for (const key of envKeys) {
      const value = previous[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    removeTestTree(root)
  }
})

test('optional installed native validator supplies real typed index and Milestone fulfillment', {
  skip: !process.env.NT_REAL_NATIVE_CLI ||
    !existsSync(resolve(process.env.NT_SKILLS_CHECKOUT ?? '../noveltea-skills', 'fixtures/reference-story')),
}, () => {
  const skills = resolve(process.env.NT_SKILLS_CHECKOUT ?? '../noveltea-skills')
  const fixture = join(skills, 'fixtures/reference-story')
  const baseline = git(skills, 'rev-parse', 'HEAD')
  const run = spawnSync(process.env.NT_REAL_NATIVE_CLI!,
    ['--json', 'narrative', 'validate', fixture, '--base', baseline],
    { encoding: 'utf8', timeout: 60_000 })
  assert.equal(run.status, 0, run.stderr)
  const response = JSON.parse(run.stdout) as { catalog: Record<string, unknown> }
  const index = canonicalExplorerIndex(response.catalog, baseline, baseline, 'passed')
  assert.equal(index.protection, 'checked')
  assert.ok(index.records.length > 10)
  assert.ok(index.records.some(record => record.id === 'creative-direction.last-bell'))
  assert.ok(index.records.some(record => record.type === 'event'))
  assert.ok(index.records.filter(record => record.type === 'milestone').some(record => record.events.length > 0))
  assert.equal(index.diagnostics.length, 0)
})

test('optional installed native Context Manifest supplies typed relationship evidence, not invented reachability', {
  skip: !process.env.NT_REAL_NATIVE_CLI ||
    !existsSync(resolve(process.env.NT_SKILLS_CHECKOUT ?? '../noveltea-skills', 'fixtures/reference-story')),
}, () => {
  const skills = resolve(process.env.NT_SKILLS_CHECKOUT ?? '../noveltea-skills')
  const fixture = join(skills, 'fixtures/reference-story')
  const baseline = git(skills, 'rev-parse', 'HEAD')
  const validated = spawnSync(process.env.NT_REAL_NATIVE_CLI!,
    ['--json', 'narrative', 'validate', fixture, '--base', baseline],
    { encoding: 'utf8', timeout: 60_000 })
  assert.equal(validated.status, 0, validated.stderr)
  const index = canonicalExplorerIndex(JSON.parse(validated.stdout).catalog, baseline, baseline, 'passed')
  const queried = spawnSync(process.env.NT_REAL_NATIVE_CLI!,
    ['--json', 'narrative', 'context', fixture, '--kind', 'review',
      '--id', 'event.question-ivo', '--scope', 'related'],
    { encoding: 'utf8', timeout: 60_000 })
  assert.equal(queried.status, 0, queried.stderr)
  const reply = JSON.parse(queried.stdout)
  const graph = canonicalRelationshipGraph(reply.manifest, index, 'event.question-ivo', 'related')
  assert.ok(graph.records.some(r => r.id === 'event.question-ivo'))
  assert.ok(graph.relationships.some(r => r.code === 'arc-membership' &&
    r.source === 'event.question-ivo' && r.target === 'arc.stolen-warning'))
  assert.ok(graph.relationships.every(r => r.source !== r.target))
  assert.ok(graph.relationships.every(r => graph.records.some(n => n.id === r.source) &&
    graph.records.some(n => n.id === r.target)))
})

test('native-only relationship projection refuses unsafe records, truncation and invented edges', () => {
  const index = canonicalExplorerIndex({ records, diagnostics: [], protection: { status: 'checked' } },
    'base', 'head', 'passed')
  const native = (files: unknown[], truncated = false) => ({
    contractRevision: '0.1', unresolved: [], bounded: { maxFiles: 128, truncated }, files,
  })
  const event = { id: 'event.bell', path: 'events/bell.md', inclusions: [
    { code: 'requested-id', sourceId: 'event.bell', targetId: 'event.bell' },
  ] }
  const noEdges = canonicalRelationshipGraph(native([event]), index, 'event.bell', 'focused')
  assert.deepEqual(noEdges.relationships, [])
  assert.deepEqual(noEdges.records.map(r => r.id), ['event.bell'])
  assert.throws(() => canonicalRelationshipGraph(native([event], true), index, 'event.bell', 'focused'), /truncated/)
  assert.throws(() => canonicalRelationshipGraph(native([]), index, 'event.bell', 'focused'), /omitted the requested/)
  assert.throws(() => canonicalRelationshipGraph(native([{ ...event, path: '.story-inbox/ideas/private.md' }]),
    index, 'event.bell', 'focused'), /noncanonical/)
  assert.throws(() => canonicalRelationshipGraph(native([{ ...event, inclusions: [
    { code: 'made up!', sourceId: 'event.bell', targetId: 'arc.warning' },
  ] }]), index, 'event.bell', 'related'), /invalid relationship/)
  assert.throws(() => canonicalRelationshipGraph(native([event, event]), index, 'event.bell', 'focused'),
    /noncanonical/)
})

test('canonical index fails closed on duplicate IDs and outside paths', () => {
  const report = (items: unknown[]) => ({ records: items, diagnostics: [],
    protection: { status: 'checked' } })
  assert.throws(() => canonicalExplorerIndex(report([records[0], records[0]]), 'base', 'head', 'passed'), /duplicate/)
  assert.throws(() => canonicalExplorerIndex(report([
    { path: '.story-inbox/ideas/private.md', metadata: { id: 'event.private', type: 'event' } },
  ]), 'base', 'head', 'passed'), /invalid/)
  assert.throws(() => canonicalExplorerIndex(report([
    { path: 'events/../../.story-inbox/ideas/private.md', metadata: { id: 'event.private', type: 'event' } },
  ]), 'base', 'head', 'passed'), /invalid/)
})
