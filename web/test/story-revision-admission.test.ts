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
import { advanceThread, readThreadChat, cancelQueuedThreadMessage } from '../src/lib/thread-chat.server'
import { previewThreadRevision, submitThreadRevision } from '../src/lib/story-revision.server'
import { recordSteeringConsideration, prepareSteeringBoundaryReviews,
  attributeApprovedReplanCheckpoint } from '../src/lib/thread-steering-replan.server'
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
  { path: 'events/reckoning.md', metadata: {
    type: 'event', id: 'event.reckoning', title: 'Reckoning event', status: 'draft',
    arcs: ['arc.trust'], characters: ['character.nia'] } },
  { path: 'characters/nia.md', metadata: {
    type: 'character', id: 'character.nia', title: 'Nia', status: 'draft' } },
  { path: 'authored-content/confession.md', metadata: {
    type: 'authored-content', id: 'authored-content.confession', title: 'Confession lines',
    status: 'draft', events: ['event.confession'] } },
]

async function exerciseRevisionAdmission(kind: 'broad' | 'narrow' | 'concurrent' | 'cancel' | 'cancel-inflight' | 'redirect') {
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
if (args.length === 1 && args[0] === '--version') {
  process.stdout.write('1.0.0\\n');
  process.exit(0);
}
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

    const task = kind === 'broad' || kind === 'redirect'
      ? 'Rewrite milestone.confession for better emotional pacing'
      : kind === 'cancel' ? 'Change this Event' : 'Make character.nia less confrontational'
    await assert.rejects(previewThreadRevision(store, stranger, threadId, task), /no source generation|has no source|not found/i)
    const plan = await previewThreadRevision(store, owner, threadId, task)
    if (kind === 'redirect') {
      const originalId = randomUUID()
      const existing = readThreadChat(store, owner, threadId)
      const sequence = Math.max(...existing.messages.map(m => m.sequence), -1) + 1
      store.sqlite.prepare(`INSERT INTO story_thread_messages
        (id,owner_user_id,thread_id,sequence,role,status,body,phase,job_id,created_at)
        VALUES (?,?,?,?,'user','delivered',?,'finished',?,'now')`)
        .run(originalId, owner, threadId, sequence, task, sourceId)
      store.sqlite.prepare(`INSERT INTO thread_live_inputs
        (message_id,owner_user_id,thread_id,source_job_id,mode,state,created_at)
        VALUES (?,?,?,?,'steer','delivered','now')`)
        .run(originalId, owner, threadId, sourceId)
      recordSteeringConsideration(store, originalId, owner, threadId,
        sourceId, task, 'focus:character.nia')
      assert.equal(prepareSteeringBoundaryReviews(store, owner, sourceId, threadId, sha), 1)
      assert.equal(prepareSteeringBoundaryReviews(store, owner, sourceId, threadId, sha), 0)
      const continuation = readThreadChat(store, owner, threadId)
        .messages.find(m => m.phase === 'queued')!
      assert.equal(continuation.hasRevisionScope, 0)
      assert.equal(continuation.content, task)
      await advanceThread(store, owner, threadId)
      assert.equal(readThreadChat(store, owner, threadId)
        .messages.find(m => m.id === continuation.id)?.phase, 'queued')
      assert.equal((store.sqlite.prepare('SELECT COUNT(*) AS n FROM story_thread_runs')
        .get() as { n: number }).n, 1,
      'no automatic specialist for out-of-scope change')
      const reviewed = await previewThreadRevision(store, owner, threadId, task,
        undefined, continuation.id)
      assert.equal(reviewed.digest, plan.digest)
      assert.deepEqual(reviewed.targets, ['authored-content.confession', 'event.confession'])
      await submitThreadRevision(store, owner, threadId, continuation.id, task,
        undefined, reviewed.digest)
      await advanceThread(store, owner, threadId)
      const after = readThreadChat(store, owner, threadId)
      assert.equal(after.messages.find(m => m.id === continuation.id)?.phase, 'running')
      assert.deepEqual(after.runs.map(r => r.jobId), [sourceId, continuation.id])
      assert.equal(after.steeringActivity.find(a => a.messageId === originalId)?.state, 'approved-run')
      const child = await restoreJob(selectedJob(store, owner, continuation.id), owner)
      const pinned = pinnedRequest(selectedJob(store, owner, continuation.id), child)!
      assert.deepEqual(pinned.contract.scope.targets,
        ['authored-content.confession', 'event.confession'])
      assert.equal(pinned.contract.scope.kind, 'partial')
      assert.equal(pinned.contract.scope.depth, 'composition')
      assert.equal(child.baseSha, sha, 'previous committed Story stays the new baseline')
      const proof = { eligible: true, parentSha: sha, commitSha: 'a'.repeat(40),
        proofDigest: 'b'.repeat(64), workItem: 'focus:event.confession' }
      assert.equal(attributeApprovedReplanCheckpoint(store, stranger,
        continuation.id, proof, ['events/confession.md']), 0)
      assert.equal(attributeApprovedReplanCheckpoint(store, owner,
        continuation.id, proof, ['characters/nia.md']), 0,
      'a committed out-of-scope path cannot be misattributed as approved')
      assert.equal(attributeApprovedReplanCheckpoint(store, owner,
        continuation.id, proof, ['events/confession.md']), 1)
      assert.equal(attributeApprovedReplanCheckpoint(store, owner,
        continuation.id, proof, ['events/confession.md']), 0,
      'recovery never duplicates verified checkpoint associations')
      const activity = readThreadChat(store, owner, threadId).steeringActivity
        .find(item => item.messageId === originalId)!
      assert.equal(activity.implementationCount, 1)
      assert.equal(activity.implementationSha, proof.commitSha)
      assert.equal(activity.verifiedEffectAt, null,
        'verified scoped file change cannot claim narrative fulfillment')
      assert.deepEqual(store.sqlite.pragma('foreign_key_check'), [])
      return
    }
    if (kind === 'cancel-inflight') {
      const pendingId = randomUUID()
      const inFlight = submitThreadRevision(store, owner, threadId, pendingId, task)
      const cancelled = cancelQueuedThreadMessage(store, owner, threadId, pendingId)
      assert.equal(cancelled.phase, 'cancelled')
      const settled = await inFlight
      assert.equal(settled.phase, 'cancelled',
        'a scope inference completing after cancellation must not resurrect the instruction')
      assert.equal(readThreadChat(store, owner, threadId).messages.find(m => m.id === pendingId)?.hasRevisionScope, 0)
      await advanceThread(store, owner, threadId)
      assert.deepEqual(readThreadChat(store, owner, threadId).runs.map(run => run.jobId), [sourceId])
      assert.deepEqual(store.sqlite.pragma('foreign_key_check'), [])
      return
    }
    if (kind === 'concurrent') {
      const firstId = randomUUID(), secondId = randomUUID()
      const [first, second] = await Promise.all([
        submitThreadRevision(store, owner, threadId, firstId, task),
        submitThreadRevision(store, owner, threadId, secondId,
          'Make character.nia more thoughtful'),
      ])
      assert.equal(first.phase, 'queued')
      assert.equal(second.phase, 'queued')
      assert.ok(first.sequence < second.sequence,
        'concurrent calls reserve one stable queue order before validation')
      const before = readThreadChat(store, owner, threadId)
      assert.deepEqual(before.messages.filter(item => new Set<string>([firstId, secondId]).has(item.id))
        .map(item => [item.id, item.hasRevisionScope]), [[firstId, 1], [secondId, 0]],
      'only the queue head receives an authorized scope')
      await Promise.all([
        advanceThread(store, owner, threadId),
        advanceThread(store, owner, threadId),
      ])
      const after = readThreadChat(store, owner, threadId)
      assert.equal(after.messages.find(item => item.id === firstId)?.phase, 'running')
      assert.equal(after.messages.find(item => item.id === secondId)?.phase, 'queued')
      assert.deepEqual(after.runs.map(run => run.jobId), [sourceId, firstId])
      assert.equal((store.sqlite.prepare('SELECT COUNT(*) AS n FROM studio_sessions WHERE id=?')
        .get(secondId) as { n: number }).n, 0)
      assert.deepEqual(store.sqlite.pragma('foreign_key_check'), [])
      return
    }
    if (kind === 'cancel') {
      assert.ok(plan.clarification, 'unresolved Event reference requires clarification')
      const ambiguousId = randomUUID(), nextId = randomUUID()
      const initial = await submitThreadRevision(store, owner, threadId, ambiguousId, task)
      assert.equal(initial.phase, 'queued')
      assert.equal(initial.hasRevisionScope, 0)
      const later = await submitThreadRevision(store, owner, threadId, nextId,
        'Make character.nia less confrontational')
      assert.ok(initial.sequence < later.sequence)
      await advanceThread(store, owner, threadId)
      assert.equal(readThreadChat(store, owner, threadId).messages.find(m => m.id === nextId)?.phase,
        'queued', 'ambiguous first instruction still blocks later authoring')
      const reviewed = await previewThreadRevision(store, owner, threadId, task,
        undefined, ambiguousId)
      assert.ok(reviewed.clarification)
      await assert.rejects(async () => cancelQueuedThreadMessage(store, stranger, threadId,
        ambiguousId), /not found/i)
      const original = store.sqlite.prepare(`SELECT id,body,sequence,phase FROM story_thread_messages
        WHERE id=?`).get(ambiguousId)
      const cancelled = cancelQueuedThreadMessage(store, owner, threadId, ambiguousId)
      assert.equal(cancelled.phase, 'cancelled')
      assert.ok(cancelled.cancelledAt)
      assert.deepEqual(cancelQueuedThreadMessage(store, owner, threadId, ambiguousId), cancelled,
        'cancellation is idempotent and preserves one receipt')
      assert.deepEqual(store.sqlite.prepare(`SELECT id,body,sequence,phase FROM story_thread_messages
        WHERE id=?`).get(ambiguousId), original, 'the original queued message remains immutable')
      assert.equal((store.sqlite.prepare(`SELECT COUNT(*) AS n FROM story_thread_message_cancellations
        WHERE message_id=?`).get(ambiguousId) as { n: number }).n, 1)
      await assert.rejects(submitThreadRevision(store, owner, threadId, ambiguousId, task),
        /cancelled.*new ID/i)
      await advanceThread(store, owner, threadId)
      const settled = readThreadChat(store, owner, threadId)
      assert.deepEqual(settled.messages.filter(m => new Set<string>([ambiguousId, nextId]).has(m.id))
        .map(m => m.phase), ['cancelled', 'running'])
      assert.equal(settled.messages.find(m => m.id === ambiguousId)?.content, task)
      assert.equal(settled.messages.find(m => m.id === nextId)?.hasRevisionScope, 1)
      assert.deepEqual(settled.runs.map(run => run.jobId), [sourceId, nextId])
      assert.throws(() => cancelQueuedThreadMessage(store, owner, threadId, nextId),
        /entered execution/i)
      assert.deepEqual(store.sqlite.pragma('foreign_key_check'), [])
      return
    }
    assert.equal(plan.reviewRequired, kind === 'broad')
    assert.deepEqual(plan.writePaths, kind === 'broad'
      ? ['authored-content/confession.md', 'events/confession.md']
      : ['characters/nia.md'])
    assert.ok(plan.readOnlyIds.includes(kind === 'broad' ? 'milestone.confession' : 'arc.trust'))
    const childId = randomUUID()
    if (kind === 'broad') {
      const held = await submitThreadRevision(store, owner, threadId, childId, task)
      assert.equal(held.phase, 'queued', 'material expansion is retained but not authorized')
      assert.equal(held.hasRevisionScope, 0)
    }
    await assert.rejects(submitThreadRevision(store, owner, threadId, childId, task,
      undefined, 'f'.repeat(64)), /changed since review/i)
    assert.equal((store.sqlite.prepare('SELECT count(*) AS n FROM story_thread_messages WHERE id=?')
      .get(childId) as { n: number }).n, 1,
    'a rejected approval does not discard the earlier atomically reserved message')

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
      /already.*use/)
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

test('out-of-scope Character steering requires reviewed Milestone continuation with bounded downstream inventory',
  { timeout: 60_000 }, () => exerciseRevisionAdmission('redirect'))
test('reviewed Milestone expansion admits a scoped child and rejects changed approval',
  { timeout: 60_000 }, () => exerciseRevisionAdmission('broad'))
test('unambiguous Character revision admits only its one focused path without a form',
  { timeout: 60_000 }, () => exerciseRevisionAdmission('narrow'))
test('simultaneous completed-Thread submissions both persist; only the first receives a scope',
  { timeout: 60_000 }, () => exerciseRevisionAdmission('concurrent'))
test('ambiguous queued instruction can be cancelled without rewriting its history or blocking the next',
  { timeout: 60_000 }, () => exerciseRevisionAdmission('cancel'))
test('cancellation racing with asynchronous inference cannot resurrect or authorize the message',
  { timeout: 60_000 }, () => exerciseRevisionAdmission('cancel-inflight'))
