import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { removeTestTree } from '../../test/helpers'
import { openWebGenerationGraph } from '../../src/web-fixture-runtime'
import { claimServerGeneration } from '../../src/generation-owner'
import { openStudioDatabase } from '../src/db/connection'
import { migrateStudio } from '../src/db/migrations'
import { acquireCachedStory } from '../src/lib/git-cache.server'
import { selectedJob, restoreJob, pinnedRequest } from '../src/lib/fixture-jobs.server'
import { advanceThread, readThreadChat } from '../src/lib/thread-chat.server'
import { previewThreadRevision, submitThreadRevision } from '../src/lib/story-revision.server'
import { ensureRootThreads } from '../src/lib/threads.server'

const config = { baseURL: 'http://localhost:3000',
  secret: 'scope-admission-test-secret-012345678901234567890',
  github: { clientId: 'test', clientSecret: 'test' }, gitlab: { clientId: 'test', clientSecret: 'test' } }
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const catalog = [
  { path: 'creative-direction/direction.md', metadata: {
    type: 'creative-direction', id: 'creative-direction.direction', title: 'Direction', status: 'draft' } },
  { path: 'arcs/trust.md', metadata: {
    type: 'arc', id: 'arc.trust', title: 'Trust', status: 'draft', characters: ['character.nia'] } },
  { path: 'milestones/confession.md', metadata: {
    type: 'milestone', id: 'milestone.confession', title: 'Confession', status: 'draft',
    arcs: ['arc.trust'], fulfillment: { any_of: [['event.confession']] } } },
  { path: 'events/confession.md', metadata: {
    type: 'event', id: 'event.confession', title: 'Confession event', status: 'draft',
    arcs: ['arc.trust'], characters: ['character.nia'] } },
  { path: 'characters/nia.md', metadata: {
    type: 'character', id: 'character.nia', title: 'Nia', status: 'draft' } },
  { path: 'authored-content/confession.md', metadata: {
    type: 'authored-content', id: 'authored-content.confession', title: 'Confession lines',
    status: 'draft', events: ['event.confession'] } },
]

async function exerciseRevisionAdmission(kind: 'broad' | 'narrow') {
  const root = mkdtempSync(join(tmpdir(), 'nt-story-scope-admission-'))
  const keys = ['NT_GIT_CACHE_DIR', 'NT_STATE_DIR', 'NT_NATIVE_CLI', 'NT_STUDIO_SKILLS_SOURCE']
  const savedEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  process.env.NT_GIT_CACHE_DIR = join(root, 'cache')
  process.env.NT_STATE_DIR = join(root, 'state')
  delete process.env.NT_STUDIO_SKILLS_SOURCE
  const remote = join(root, 'remote')
  for (const record of catalog) {
    const target = join(remote, 'story', record.path)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, '# ' + record.metadata.title + '\n')
  }
  git(remote, 'init', '-q')
  git(remote, 'config', 'user.name', 'Author')
  git(remote, 'config', 'user.email', 'author@example.test')
  git(remote, 'add', '.')
  git(remote, 'commit', '-qm', 'Source Story')
  const sha = git(remote, 'rev-parse', 'HEAD')
  const cli = join(root, 'noveltea')
  writeFileSync(cli, `#!/usr/bin/env node
const args = process.argv.slice(2);
const ready = args.includes('readiness');
const base = args[args.indexOf('--base') + 1];
const catalog = ${JSON.stringify(catalog)};
const report = ready ? { readiness: { contractRevision: '0.1',
  design: { stages: { foundation: { minimum: 'passed' }, architecture: { minimum: 'passed' } } },
  approved: { stages: {} }, outstanding: [] } }
  : { catalog: { contractRevision: '0.1', records: catalog, diagnostics: [],
    coverage: { search: { truncated: false }, eventProgress: [], milestoneRoutes: [],
      branchProgress: [], puzzleSolutions: [] }, authorization: {},
    protection: { status: 'checked', base, complete: true, authorizationVerified: false,
      findings: [], impact: { changed: [], moved: [], affected: [] } } } };
process.stdout.write(JSON.stringify({protocolVersion: 1, exitCode: 0, success: true,
  diagnostics: [], ...report}));
`)
  chmodSync(cli, 0o755)
  process.env.NT_NATIVE_CLI = cli
  const store = openStudioDatabase(join(root, 'studio.sqlite'))
  try {
    await migrateStudio(store, config)
    const owner = randomUUID(), stranger = randomUUID()
    const repo = randomUUID(), storyId = randomUUID(), sourceId = randomUUID()
    const threadId = 'root:' + sourceId
    for (const id of [owner, stranger]) store.sqlite.prepare(
      'INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?, ?, ?, 1, 0, 0)')
      .run(id, 'Author', id + '@example.test')
    store.sqlite.prepare(`INSERT INTO repositories
      (id,owner_user_id,provider,provider_repository_id,name,created_at)
      VALUES (?,?,'github','124','Fixture','now')`).run(repo, owner)
    store.sqlite.prepare(`INSERT INTO stories
      (id,owner_user_id,repository_id,directory,title,created_at,source_commit_sha)
      VALUES (?,?,?,'story','Scope Story','now',?)`).run(storyId, owner, repo, sha)
    const parent = await acquireCachedStory({ cacheDirectory: process.env.NT_GIT_CACHE_DIR!,
      ownerId: owner, repositoryId: 'github:124', remoteUrl: 'file://' + remote,
      token: '', directory: 'story', commit: sha, jobId: sourceId })
    const originalContract = { scope: { kind: 'full-story' as const,
      depth: 'composition' as const, targets: [], branches: [] },
      constraints: [], envelope: { presentation: 'Visual novel', hardLimits: [], preferences: [] } }
    const sourceRequest = { story: parent.storyRoot, job: parent.jobId,
      task: 'Build the story', contract: originalContract, fixture: true }
    store.sqlite.prepare(`INSERT INTO studio_sessions
      (id,owner_user_id,story_id,title,source_commit_sha,status,created_at,updated_at,
       generation_request_json,generation_thread_id,generation_config_json)
      VALUES (?,?,?,'Source Story',?,'completed','now','now',?,?,?)`)
      .run(sourceId, owner, storyId, sha, JSON.stringify(sourceRequest),
        parent.threadId + ':generation:web', JSON.stringify({
          version: 1, headSha: sha, task: sourceRequest.task, contract: originalContract,
          limits: { steps: 6 }, model: null }))
    store.sqlite.prepare(`INSERT INTO generation_run_queue
      (job_id,owner_user_id,intent,phase,created_at,updated_at)
      VALUES (?,?,'start','finished','now','now')`).run(sourceId, owner)
    ensureRootThreads(store, owner, storyId)
    await claimServerGeneration(parent, parent.threadId + ':generation:web', sourceRequest)
    const sourceGraph = openWebGenerationGraph(join(parent.stateDir, 'web-generation.sqlite'))
    await sourceGraph.graph.updateState({ configurable: { thread_id: parent.threadId + ':generation:web' } },
      { request: sourceRequest, status: 'completed', completedStages: [] })
    await sourceGraph.graph.updateState({ configurable: { thread_id: parent.threadId + ':generation:web' } },
      { status: 'completed' }, 'completion_decision')
    sourceGraph.saver.db.close()

    const task = kind === 'broad'
      ? 'Rewrite milestone.confession for better emotional pacing'
      : 'Make character.nia less confrontational'
    await assert.rejects(previewThreadRevision(store, stranger, threadId, task), /no source generation|has no source|not found/i)
    const plan = await previewThreadRevision(store, owner, threadId, task)
    assert.equal(plan.reviewRequired, kind === 'broad')
    assert.deepEqual(plan.writePaths, kind === 'broad'
      ? ['authored-content/confession.md', 'events/confession.md']
      : ['characters/nia.md'])
    assert.ok(plan.readOnlyIds.includes(kind === 'broad' ? 'milestone.confession' : 'arc.trust'))
    const childId = randomUUID()
    if (kind === 'broad') await assert.rejects(
      submitThreadRevision(store, owner, threadId, childId, task), /authorize.*write paths/i)
    await assert.rejects(submitThreadRevision(store, owner, threadId, childId, task,
      undefined, 'f'.repeat(64)), /authorize.*write paths|changed since review/i)
    assert.equal((store.sqlite.prepare('SELECT count(*) AS n FROM story_thread_messages WHERE id=?')
      .get(childId) as { n: number }).n, 0)

    await submitThreadRevision(store, owner, threadId, childId, task,
      undefined, kind === 'broad' ? plan.digest : undefined)
    await assert.rejects(previewThreadRevision(store, owner, threadId,
      'Change character.nia again'), /preceding Thread instruction/i)
    const bufferedId = randomUUID()
    const buffered = await submitThreadRevision(store, owner, threadId,
      bufferedId, 'Change character.nia again')
    assert.equal(buffered.phase, 'queued')
    assert.equal((store.sqlite.prepare(`SELECT revision_scope_json AS scope
      FROM story_thread_messages WHERE id=?`).get(bufferedId) as { scope: string | null }).scope, null)
    await assert.rejects(submitThreadRevision(store, owner, threadId, childId, 'Other task', undefined, plan.digest),
      /already used/)
    assert.equal((store.sqlite.prepare('SELECT count(*) AS n FROM story_thread_messages WHERE id=?')
      .get(childId) as { n: number }).n, 1)
    await advanceThread(store, owner, threadId)
    const chat = readThreadChat(store, owner, threadId)
    assert.equal(chat.messages.find(item => item.id === childId)?.phase, 'running')
    assert.deepEqual(chat.runs.map(run => run.jobId), [sourceId, childId])
    const child = await restoreJob(selectedJob(store, owner, childId), owner)
    const pinned = pinnedRequest(selectedJob(store, owner, childId), child)
    assert.deepEqual(pinned?.contract.scope.targets, kind === 'broad'
      ? ['authored-content.confession', 'event.confession'] : ['character.nia'])
    assert.equal(pinned?.contract.scope.kind, 'partial')
    assert.equal(pinned?.contract.scope.depth, kind === 'broad' ? 'composition' : 'architecture')
    assert.equal(pinned?.task, task)
    assert.equal(child.baseSha, sha)
    assert.equal(git(child.worktreeRoot, 'status', '--porcelain'), '')
    assert.equal(git(parent.worktreeRoot, 'rev-parse', 'HEAD'), sha)
    assert.deepEqual(store.sqlite.pragma('foreign_key_check'), [])
  } finally {
    store.sqlite.close()
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    removeTestTree(root)
  }
}

test('reviewed Milestone expansion admits a scoped child and rejects changed approval',
  { timeout: 60_000 }, () => exerciseRevisionAdmission('broad'))
test('unambiguous Character revision admits only its one focused path without a form',
  { timeout: 60_000 }, () => exerciseRevisionAdmission('narrow'))
