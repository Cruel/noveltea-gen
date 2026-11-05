import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { removeTestTree } from '../../test/helpers'
import { claimServerGeneration } from '../../src/generation-owner'
import { openWebGenerationGraph } from '../../src/web-fixture-runtime'
import { openStudioDatabase } from '../src/db/connection'
import { migrateStudio } from '../src/db/migrations'
import { acquireCachedStory } from '../src/lib/git-cache.server'
import { selectedJob, restoreJob, inspectRegisteredJob } from '../src/lib/fixture-jobs.server'
import { ensureRootThreads } from '../src/lib/threads.server'
import { cancelQueuedThreadMessage, advanceThread, readThreadChat } from '../src/lib/thread-chat.server'
import { previewThreadRevision, submitThreadRevision } from '../src/lib/story-revision.server'
import { assertProtectedThreadApproval, recordProtectedThreadDecision } from '../src/lib/thread-protected-decision.server'

const native = process.env.NT_NATIVE_CLI ?? '/home/thomas/dev/nt/build/cli/linux/noveltea'
const reference = resolve(process.env.NT_SKILLS_CHECKOUT ?? '/home/thomas/dev/noveltea-skills',
  'fixtures/reference-story')
const config = { baseURL: 'http://localhost:3000',
  secret: 'protected-thread-test-secret-012345678901234567',
  github: { clientId: 'test', clientSecret: 'test' },
  gitlab: { clientId: 'test', clientSecret: 'test' } }
const git = (root: string, ...args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const decision = 'creative-direction.last-bell#repair-not-revenge'
const original = 'The investigation should invite repair rather than revenge.'
const changed = 'The investigation must invite forgiveness instead of revenge.'
const message = `Change protected decision ${decision} to "${changed}"`
const contract = { scope: { kind: 'full-story' as const, depth: 'composition' as const,
  targets: [], branches: [] }, constraints: [],
  envelope: { presentation: 'Visual novel', hardLimits: [], preferences: [] } }

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'nt-thread-protected-'))
  const keys = ['NT_STATE_DIR','NT_GIT_CACHE_DIR','NT_NATIVE_CLI','NT_STUDIO_SKILLS_SOURCE']
  const oldEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  process.env.NT_STATE_DIR = join(root, 'state')
  process.env.NT_GIT_CACHE_DIR = join(root, 'cache')
  process.env.NT_NATIVE_CLI = native
  delete process.env.NT_STUDIO_SKILLS_SOURCE
  const remote = join(root, 'remote')
  mkdirSync(join(remote, 'story'), { recursive: true })
  cpSync(reference, join(remote, 'story'), { recursive: true })
  const foundation = join(remote, 'story', 'creative-direction', 'last-bell.md')
  writeFileSync(foundation, readFileSync(foundation, 'utf8').replace(
    'origin: agent\n    authority: delegated', 'origin: user\n    authority: user-protected'))
  git(remote, 'init', '-q')
  git(remote, 'config', 'user.name', 'Author')
  git(remote, 'config', 'user.email', 'author@example.test')
  git(remote, 'add', '.')
  git(remote, 'commit', '-qm', 'Protected source')
  const sha = git(remote, 'rev-parse', 'HEAD')
  const store = openStudioDatabase(join(root, 'studio.sqlite'))
  await migrateStudio(store, config)
  const owner = randomUUID(), stranger = randomUUID(), repoId = randomUUID(),
    storyId = randomUUID(), sourceId = randomUUID(), threadId = 'root:' + sourceId
  for (const id of [owner,stranger]) store.sqlite.prepare(
    'INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?, ?, ?, 1, 0, 0)')
    .run(id, 'Author', id + '@example.test')
  store.sqlite.prepare(`INSERT INTO repositories
    (id,owner_user_id,provider,provider_repository_id,name,created_at)
    VALUES (?,?,'github','934','Fixture','now')`).run(repoId, owner)
  store.sqlite.prepare(`INSERT INTO stories
    (id,owner_user_id,repository_id,directory,title,created_at,source_commit_sha)
    VALUES (?,?,?,'story','Protected Story','now',?)`).run(storyId, owner, repoId, sha)
  const source = await acquireCachedStory({
    cacheDirectory: process.env.NT_GIT_CACHE_DIR!, ownerId: owner,
    repositoryId: 'github:934', remoteUrl: 'file://' + remote, token: '',
    directory: 'story', commit: sha, jobId: sourceId,
  })
  const request = { story: source.storyRoot, job: source.jobId,
    task: 'Explore the mystery', contract, fixture: true }
  store.sqlite.prepare(`INSERT INTO studio_sessions
    (id,owner_user_id,story_id,title,source_commit_sha,status,created_at,updated_at,
     generation_request_json,generation_thread_id,generation_config_json)
    VALUES (?,?,?,'Parent',?,'completed','now','now',?,?,?)`)
    .run(sourceId, owner, storyId, sha, JSON.stringify(request),
      source.threadId + ':generation:web', JSON.stringify({
        version: 1, headSha: sha, task: request.task, contract, limits: {}, model: null }))
  store.sqlite.prepare(`INSERT INTO generation_run_queue
    (job_id,owner_user_id,intent,phase,created_at,updated_at)
    VALUES (?,?,'start','finished','now','now')`).run(sourceId, owner)
  ensureRootThreads(store, owner, storyId)
  await claimServerGeneration(source, source.threadId + ':generation:web', request)
  const graph = openWebGenerationGraph(join(source.stateDir, 'web-generation.sqlite'))
  await graph.graph.updateState({ configurable: { thread_id: source.threadId + ':generation:web' } },
    { request, status: 'completed', completedStages: [] })
  await graph.graph.updateState({ configurable: { thread_id: source.threadId + ':generation:web' } },
    { status: 'completed' }, 'completion_decision')
  graph.saver.db.close()
  function cleanup() {
    store.sqlite.close()
    for (const [key,value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    removeTestTree(root)
  }
  return { root, store, source, owner, stranger, sourceId, threadId, sha, cleanup }
}

test('protected conversation amendment needs a new owner-bound exact receipt and native commit',
  { skip: !existsSync(native) || !existsSync(reference), timeout: 120_000 }, async () => {
    const f = await setup()
    try {
      const firstId = randomUUID()
      const plan = await previewThreadRevision(f.store, f.owner, f.threadId, message)
      assert.deepEqual(plan.protectedChange, {
        decision, path: 'creative-direction/last-bell.md', before: original, after: changed,
      })
      assert.equal(plan.reviewRequired, true)
      assert.deepEqual(plan.targets, [])
      assert.deepEqual(plan.writePaths, ['creative-direction/last-bell.md'])
      await assert.rejects(previewThreadRevision(f.store, f.stranger, f.threadId, message),
        /no source|not found/i)
      const held = await submitThreadRevision(f.store, f.owner, f.threadId,
        firstId, message, undefined, plan.digest)
      assert.equal(held.phase, 'queued')
      assert.equal(held.hasRevisionScope, 0,
        'a scope digest or prior job consent must never permit a protected retcon')
      await advanceThread(f.store, f.owner, f.threadId)
      assert.deepEqual(readThreadChat(f.store, f.owner, f.threadId).runs.map(r => r.jobId), [f.sourceId])
      assert.equal(git(f.source.worktreeRoot, 'rev-parse', 'HEAD'), f.sha)
      assert.equal(git(f.source.worktreeRoot, 'status', '--porcelain'), '')
      assert.equal((f.store.sqlite.prepare('SELECT COUNT(*) AS n FROM studio_sessions')
        .get() as { n: number }).n, 1)
      assert.throws(() => recordProtectedThreadDecision(f.store, f.stranger, f.threadId,
        firstId, f.sourceId, plan, 'approved'), /queued|source|review|not found/i)
      const denied = recordProtectedThreadDecision(f.store, f.owner, f.threadId,
        firstId, f.sourceId, plan, 'rejected')
      assert.equal(denied.decision, 'rejected')
      assert.throws(() => recordProtectedThreadDecision(f.store, f.owner, f.threadId,
        firstId, f.sourceId, plan, 'approved'), /different|stale/i)
      assert.throws(() => assertProtectedThreadApproval(f.store, f.owner, f.threadId,
        firstId, f.sourceId, plan), /fresh|exact/i)
      assert.equal(git(f.source.worktreeRoot, 'status', '--porcelain'), '')
      cancelQueuedThreadMessage(f.store, f.owner, f.threadId, firstId)

      const childId = randomUUID()
      const preview = await previewThreadRevision(f.store, f.owner, f.threadId, message)
      await submitThreadRevision(f.store, f.owner, f.threadId, childId, message)
      const granted = recordProtectedThreadDecision(f.store, f.owner, f.threadId,
        childId, f.sourceId, preview, 'approved')
      assert.equal(granted.digest, preview.digest)
      assert.throws(() => assertProtectedThreadApproval(f.store, f.stranger, f.threadId,
        childId, f.sourceId, preview), /fresh|exact/i)
      assert.throws(() => assertProtectedThreadApproval(f.store, f.owner, f.threadId,
        childId, f.sourceId, { ...preview, digest: 'f'.repeat(64) }), /fresh|exact/i)
      assert.throws(() => assertProtectedThreadApproval(f.store, f.owner, f.threadId,
        childId, randomUUID(), preview), /fresh|exact/i)
      await submitThreadRevision(f.store, f.owner, f.threadId, childId, message, undefined, preview.digest)
      assert.equal(readThreadChat(f.store, f.owner, f.threadId).messages.find(m => m.id === childId)?.hasRevisionScope, 1)
      await advanceThread(f.store, f.owner, f.threadId)
      const current = readThreadChat(f.store, f.owner, f.threadId)
      assert.equal(current.messages.find(m => m.id === childId)?.phase, 'finished',
        JSON.stringify(current.messages))
      assert.deepEqual(current.runs.map(r => r.jobId), [f.sourceId, childId])
      const child = await restoreJob(selectedJob(f.store, f.owner, childId), f.owner)
      assert.equal(child.baseSha, f.sha)
      assert.notEqual(child.headSha, f.sha)
      const changedFile = readFileSync(join(child.worktreeStoryRoot,
        'creative-direction', 'last-bell.md'), 'utf8')
      assert.match(changedFile, /The investigation must invite forgiveness/)
      assert.match(changedFile, /authority: user-protected/)
      assert.equal(git(child.worktreeRoot, 'status', '--porcelain'), '')
      assert.equal(git(child.worktreeRoot, 'diff', '--name-only', f.sha, child.headSha),
        'story/creative-direction/last-bell.md')
      assert.equal(git(f.source.worktreeRoot, 'rev-parse', 'HEAD'), f.sha,
        'parent protected decision is immutable')
      assert.equal(git(f.source.worktreeRoot, 'status', '--porcelain'), '')
      assert.equal((await inspectRegisteredJob(f.store, selectedJob(f.store, f.owner, childId),
        f.owner)).status, 'completed')
      assert.equal(current.messages.filter(m => m.id === childId).length, 1)
      assert.throws(() => assertProtectedThreadApproval(f.store, f.owner, f.threadId,
        childId, f.sourceId, preview), /fresh|exact/i, 'approval cannot be replayed')
      const nextId = randomUUID()
      const newerMessage = 'Make the investigation invite revenge instead of forgiveness'
      const newerPlan = await previewThreadRevision(f.store, f.owner, f.threadId, newerMessage)
      assert.equal(newerPlan.protectedChange?.before, changed,
        'the next run inherits the actual canonical Story, not stale ancestor text')
      assert.equal(newerPlan.protectedChange?.after,
        'The investigation must invite revenge rather than forgiveness.')
      const notInherited = await submitThreadRevision(f.store, f.owner, f.threadId,
        nextId, newerMessage, undefined, newerPlan.digest)
      assert.equal(notInherited.hasRevisionScope, 0,
        'even an ancestor author approval cannot be reused for a new protected change')
      recordProtectedThreadDecision(f.store, f.owner, f.threadId, nextId, childId,
        newerPlan, 'approved')
      await submitThreadRevision(f.store, f.owner, f.threadId,
        nextId, newerMessage, undefined, newerPlan.digest)
      await advanceThread(f.store, f.owner, f.threadId)
      assert.equal(readThreadChat(f.store, f.owner, f.threadId)
        .messages.find(m => m.id === nextId)?.phase, 'finished')
      const nextJob = await restoreJob(selectedJob(f.store, f.owner, nextId), f.owner)
      assert.notEqual(nextJob.headSha, child.headSha,
        'natural-language proposal requires a distinct approved child commit')
      assert.equal(git(f.source.worktreeRoot, 'rev-parse', 'HEAD'), f.sha)
      const ordinaryId = randomUUID()
      const ordinary = await submitThreadRevision(f.store, f.owner, f.threadId,
        ordinaryId, 'Make character.mara more assertive')
      assert.equal(ordinary.hasRevisionScope, 1,
        'nonprotected follow-up edits continue normally after the exact protected amendment')
      assert.deepEqual(f.store.sqlite.pragma('foreign_key_check'), [])
    } finally { f.cleanup() }
  })

test('unprotected edits remain eligible for ordinary focused scope without protected approval',
  { skip: !existsSync(native) || !existsSync(reference), timeout: 60_000 }, async () => {
    const f = await setup()
    try {
      const plan = await previewThreadRevision(f.store, f.owner, f.threadId,
        'Make character.mara more assertive')
      assert.equal(plan.protectedChange, null)
      assert.equal(plan.clarification, null)
      assert.equal(plan.reviewRequired, false)
      assert.equal(plan.targets.length, 1)
    } finally { f.cleanup() }
  })
