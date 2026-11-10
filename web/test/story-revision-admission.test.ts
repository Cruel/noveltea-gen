import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { removeTestTree } from '../../test/helpers'
import { openWebGenerationGraph } from '../../src/web-fixture-runtime'
import { claimServerGeneration } from '../../src/generation-owner'
import { openStudioDatabase } from './support/studio-database'
import { studioSeed } from './support/studio-seed'
import { migrateStudio } from './support/studio-database'
import { acquireCachedStory } from '../src/lib/git-cache.server'
import { selectedJob, restoreJob, pinnedRequest } from '../src/lib/fixture-jobs.server'
import { advanceThread, readThreadChat, cancelQueuedThreadMessage,
  settleThreadRun, recoverSettledThreadRuns } from '../src/lib/thread-chat.server'
import { previewThreadRevision, submitThreadRevision } from '../src/lib/story-revision.server'
import { readJobTurnPlan } from '../src/lib/turn-plan-receipt.server'
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

async function exerciseRevisionAdmission(kind: 'broad' | 'narrow' | 'concurrent' | 'cancel' | 'cancel-inflight' | 'redirect' | 'multi-turn' | 'unverified-crash') {
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
const ready = args.includes('--readiness');
const base = args[args.indexOf('--base') + 1];
const catalog = ${JSON.stringify(catalog)};
const report = {
  catalog: { contractRevision: '0.1', records: catalog, diagnostics: [],
    coverage: { search: { truncated: false }, eventProgress: [], milestoneRoutes: [],
      branchProgress: [], puzzleSolutions: [] }, authorization: {},
    protection: { status: 'checked', base, complete: true, authorizationVerified: false,
      findings: [], impact: { changed: [], moved: [], affected: [] } } },
  ...(ready ? { readiness: { contractRevision: '0.1', stage: 'review', view: 'design',
    design: { stages: { foundation: { minimum: 'passed' }, architecture: { minimum: 'passed' } } },
    approved: { stages: {} }, outstanding: [] } } : {}),
};
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
    const seed = studioSeed(store)
    for (const id of [owner, stranger]) { await seed.user(id, 0) }
    (await seed.repository({ id: repo, ownerUserId: owner, provider: 'github',
      providerRepositoryId: '124', name: 'Fixture', createdAt: 'now' }))
    ;(await seed.story({ id: storyId, ownerUserId: owner, repositoryId: repo,
      directory: 'story', title: 'Scope Story', createdAt: 'now', sourceCommitSha: sha }))
    const parent = await acquireCachedStory({ cacheDirectory: process.env.NT_GIT_CACHE_DIR!,
      ownerId: owner, repositoryId: 'github:124', remoteUrl: 'file://' + remote,
      token: '', directory: 'story', commit: sha, jobId: sourceId })
    const originalContract = { scope: { kind: 'full-story' as const,
      depth: 'composition' as const, targets: [], branches: [] },
      constraints: [], envelope: { presentation: 'Visual novel', hardLimits: [], preferences: [] } }
    const sourceRequest = { story: parent.storyRoot, job: parent.jobId,
      task: 'Build the story', contract: originalContract, fixture: true }
    ;(await seed.job({ id: sourceId, ownerUserId: owner, storyId, title: 'Source Story',
      sourceCommitSha: sha, status: 'completed', createdAt: 'now', updatedAt: 'now',
      generationRequestJson: JSON.stringify(sourceRequest),
      generationThreadId: parent.threadId + ':generation:web',
      generationConfigJson: JSON.stringify({
        version: 1, headSha: sha, task: sourceRequest.task, contract: originalContract,
        limits: { steps: 6 }, model: null,
      }) }))
    ;(await seed.queue({ jobId: sourceId, ownerUserId: owner, intent: 'start',
      phase: 'finished', createdAt: 'now', updatedAt: 'now' }))
    await ensureRootThreads(store, owner, storyId)
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
    if (kind === 'multi-turn' || kind === 'unverified-crash') {
      const firstId = randomUUID(), secondId = randomUUID()
      await submitThreadRevision(store, owner, threadId, firstId, task)
      await Promise.all([advanceThread(store, owner, threadId), advanceThread(store, owner, threadId)])
      const firstChat = await readThreadChat(store, owner, threadId)
      const firstReceipt = firstChat.turnReceipts.find(turn => turn.id === firstId)!
      assert.equal(firstReceipt.request, task)
      assert.equal(firstReceipt.inputSha, sha)
      assert.deepEqual(firstReceipt.executions.map(run => ({ jobId: run.jobId, inputSha: run.inputSha,
        validatedSha: run.validatedSha })), [{ jobId: firstId, inputSha: sha, validatedSha: null }])
      assert.equal(firstChat.runs.length, 2)
      if (kind === 'multi-turn' || kind === 'unverified-crash') {
        // The queued child has been claimed by the agent and is executing
        // its first specialist when the author sends another Turn.
        ;(await store.testing.records.update('studio_sessions', { id: firstId }, { status: 'running' }))
        ;(await store.testing.records.update('generation_run_queue', { jobId: firstId }, { phase: 'running' }))
      }
      const secondTask = 'Make event.confession more suspenseful'
      if (kind === 'multi-turn' || kind === 'unverified-crash') {
        const queued = await submitThreadRevision(store, owner, threadId, secondId, secondTask,
          undefined, undefined, 'follow-up')
        assert.equal(queued.liveMode, 'follow-up')
        assert.equal(queued.liveState, 'deferred', 'future Turn must not acquire a Pi lease')
        assert.equal(queued.hasRevisionScope, 0, 'future HEAD cannot be preapproved')
        await Promise.all([advanceThread(store, owner, threadId), advanceThread(store, owner, threadId)])
        assert.equal((await readThreadChat(store, owner, threadId)).runs.length, 2,
          'running first Turn prevents admission of a second writer')
      }
      await assert.rejects(previewThreadRevision(store, owner, threadId, secondTask),
        /preceding Thread instruction|Finish or reconcile/, 'an unfinished first Turn cannot seed the next writer')
      const firstChild = await restoreJob(await selectedJob(store, owner, firstId), owner)
      const pinnedFirst = pinnedRequest(await selectedJob(store, owner, firstId), firstChild)!
      const recordPath = join(firstChild.worktreeStoryRoot, 'characters/nia.md')
      writeFileSync(recordPath, readFileSync(recordPath, 'utf8') + '\nCharacter revised\n')
      git(firstChild.worktreeRoot, 'add', '.')
      git(firstChild.worktreeRoot, '-c', 'user.name=Studio fixture',
        '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Fixture validated Character revision')
      const firstOutput = git(firstChild.worktreeRoot, 'rev-parse', 'HEAD')
      assert.notEqual(firstOutput, sha)
      if (kind === 'unverified-crash') {
        // The worker finished in the queue after an actual Git commit, but
        // crashed before trusted-head finalization or the graph checkpoint.
        ;(await store.testing.records.update('studio_sessions', { id: firstId }, {
          status: 'completed', generationRequestJson: JSON.stringify(pinnedFirst),
          generationThreadId: firstChild.threadId + ':generation:web',
        }))
        ;(await store.testing.records.update('generation_run_queue', { jobId: firstId },
          { phase: 'finished' }))
        await settleThreadRun(store, owner, firstId)
        await recoverSettledThreadRuns(store)
        const unsafe = await readThreadChat(store, owner, threadId)
        assert.equal(unsafe.messages.find(message => message.id === firstId)?.phase, 'blocked')
        assert.equal(unsafe.runs.at(-1)?.status, 'blocked')
        assert.equal(unsafe.turnReceipts.find(turn => turn.id === firstId)?.executions[0]?.validatedSha,
          null, 'the unverified Git HEAD must not become an inheritable checkpoint')
        assert.equal(unsafe.messages.find(message => message.id === secondId)?.phase, 'queued',
          'previously queued next Turn must survive failure without gaining a writer')
        assert.equal(unsafe.messages.find(message => message.id === secondId)?.hasRevisionScope, 0,
          'unverified output never authorizes queued scope')
        await advanceThread(store, owner, threadId)
        assert.equal(await store.testing.records.count('story_thread_runs'), 2,
          'an unverified source cannot dispatch the queued next Turn')
        assert.equal((await submitThreadRevision(store, owner, threadId,
          secondId, secondTask, undefined, undefined, 'follow-up')).phase, 'queued',
        'idempotent retry must retain already-queued author intent')
        await assert.rejects(() => submitThreadRevision(store, owner, threadId,
          randomUUID(), secondTask), /cannot accept follow-ups/i,
        'new Turns are disallowed while the source requires recovery')
        assert.equal(git(firstChild.worktreeRoot, 'rev-parse', 'HEAD'), firstOutput,
          'reconciliation leaves the unverified branch intact for inspection')
        assert.equal(await store.testing.records.count('story_thread_runs'), 2)
        assert.equal(unsafe.messages.filter(message => message.id === 'assistant:' + firstId).length,
          1, 'recovery must not duplicate an unverified completion response')
        assert.deepEqual((await store.testing.foreignKeyViolations()), [])
        return
      }
      // Simulate the *controller's* finalized trusted revision and graph; the
      // real native/specialist proof contract is exercised in its own tests.
      mkdirSync(join(firstChild.stateDir, 'revisions'), { recursive: true })
      writeFileSync(join(firstChild.stateDir, 'revisions', 'verified-head.json'), JSON.stringify({
        version: 1, jobId: firstId, headSha: firstOutput, workItemId: 'focus:character.nia',
      }))
      await claimServerGeneration(firstChild, firstChild.threadId + ':generation:web', pinnedFirst)
      const graph = openWebGenerationGraph(join(firstChild.stateDir, 'web-generation.sqlite'))
      await graph.graph.updateState({ configurable: { thread_id: firstChild.threadId + ':generation:web' } },
        { request: pinnedFirst, status: 'completed', completedStages: [] })
      await graph.graph.updateState({ configurable: { thread_id: firstChild.threadId + ':generation:web' } },
        { status: 'completed' }, 'completion_decision')
      graph.saver.db.close()
      ;(await store.testing.records.update('studio_sessions', { id: firstId }, {
        status: 'completed', generationRequestJson: JSON.stringify(pinnedFirst),
        generationThreadId: firstChild.threadId + ':generation:web',
      }))
      ;(await store.testing.records.update('generation_run_queue', { jobId: firstId }, { phase: 'finished' }))
      await settleThreadRun(store, owner, firstId)
      await recoverSettledThreadRuns(store)
      const settled = await readThreadChat(store, owner, threadId)
      assert.equal(settled.turnReceipts.find(turn => turn.id === firstId)?.executions[0]?.validatedSha,
        firstOutput)
      assert.equal(settled.messages.filter(message => message.id === 'assistant:' + firstId).length, 1,
        'settlement and restart recovery must not duplicate chat delivery')
      if (kind === 'multi-turn') {
        const alreadyAdmitted = await readThreadChat(store, owner, threadId)
        assert.equal(alreadyAdmitted.messages.find(m => m.id === secondId)?.phase, 'running',
          'settling the verified source should admit the queued Turn exactly once')
        assert.deepEqual(alreadyAdmitted.runs.map(r => r.jobId), [sourceId, firstId, secondId])
        assert.equal(alreadyAdmitted.messages.find(m => m.id === secondId)?.liveState, 'deferred',
          'the queued Turn is never marked as a consumed Pi steer')
      } else {
        const secondPlan = await previewThreadRevision(store, owner, threadId, secondTask)
        assert.equal(secondPlan.headSha, firstOutput)
        assert.deepEqual(secondPlan.targets, ['event.confession'])
        await submitThreadRevision(store, owner, threadId, secondId, secondTask)
        await Promise.all([advanceThread(store, owner, threadId), advanceThread(store, owner, threadId)])
      }
      const secondChild = await restoreJob(await selectedJob(store, owner, secondId), owner)
      assert.equal(secondChild.baseSha, firstOutput)
      assert.equal(git(firstChild.worktreeRoot, 'rev-parse', 'HEAD'), firstOutput)
      assert.equal(git(parent.worktreeRoot, 'rev-parse', 'HEAD'), sha)
      assert.equal(git(secondChild.worktreeRoot, 'status', '--porcelain'), '')
      const chained = await readThreadChat(store, owner, threadId)
      assert.deepEqual(chained.runs.map(run => run.jobId), [sourceId, firstId, secondId])
      assert.deepEqual(chained.turnReceipts.find(turn => turn.id === secondId)?.executions.map(
        run => [run.jobId, run.inputSha, run.validatedSha]), [[secondId, firstOutput, null]])
      const reopened = openStudioDatabase(join(root, 'studio.sqlite'))
      try {
        await reopened.assertReady()
        assert.deepEqual((await readThreadChat(reopened, owner, threadId)).turnReceipts,
          chained.turnReceipts, 'Turn provenance is durable across a database restart')
      } finally { reopened.close() }
      assert.deepEqual((await store.testing.foreignKeyViolations()), [])
      return
    }
    if (kind === 'redirect') {
      const originalId = randomUUID()
      const existing = (await readThreadChat(store, owner, threadId))
      const sequence = Math.max(...existing.messages.map(m => m.sequence), -1) + 1
      ;(await store.testing.records.insert('story_thread_messages', { id: originalId,
        ownerUserId: owner, threadId, sequence, role: 'user', status: 'delivered',
        body: task, phase: 'finished', jobId: sourceId, createdAt: 'now' }))
      ;(await store.testing.records.insert('thread_live_inputs', { messageId: originalId,
        ownerUserId: owner, threadId, sourceJobId: sourceId,
        mode: 'steer', state: 'delivered', createdAt: 'now' }))
      assert.equal(await store.testing.records.count('story_turn_executions',
        { turnId: originalId, jobId: sourceId }), 1,
      'a live input already linked by its request must not duplicate the Turn execution')
      await recordSteeringConsideration(store, originalId, owner, threadId,
        sourceId, task, 'focus:character.nia')
      assert.equal(await prepareSteeringBoundaryReviews(store, owner, sourceId, threadId, sha), 1)
      assert.equal(await prepareSteeringBoundaryReviews(store, owner, sourceId, threadId, sha), 0)
      const continuation = (await readThreadChat(store, owner, threadId))
        .messages.find(m => m.phase === 'queued')!
      assert.equal(continuation.hasRevisionScope, 0)
      assert.equal(continuation.content, task)
      await advanceThread(store, owner, threadId)
      assert.equal((await readThreadChat(store, owner, threadId))
        .messages.find(m => m.id === continuation.id)?.phase, 'queued')
      assert.equal((await store.testing.records.count('story_thread_runs')), 1,
      'no automatic specialist for out-of-scope change')
      const reviewed = await previewThreadRevision(store, owner, threadId, task,
        undefined, continuation.id)
      assert.equal(reviewed.digest, plan.digest)
      assert.deepEqual(reviewed.targets, ['authored-content.confession', 'event.confession'])
      await submitThreadRevision(store, owner, threadId, continuation.id, task,
        undefined, reviewed.digest)
      await advanceThread(store, owner, threadId)
      const after = (await readThreadChat(store, owner, threadId))
      assert.equal(after.messages.find(m => m.id === continuation.id)?.phase, 'running')
      assert.deepEqual(after.runs.map(r => r.jobId), [sourceId, continuation.id])
      assert.equal(after.steeringActivity.find(a => a.messageId === originalId)?.state, 'approved-run')
      const child = await restoreJob(await selectedJob(store, owner, continuation.id), owner)
      const pinned = pinnedRequest(await selectedJob(store, owner, continuation.id), child)!
      assert.deepEqual(pinned.contract.scope.targets,
        ['authored-content.confession', 'event.confession'])
      assert.equal(pinned.contract.scope.kind, 'partial')
      assert.equal(pinned.contract.scope.depth, 'composition')
      assert.equal(child.baseSha, sha, 'previous committed Story stays the new baseline')
      const proof = { eligible: true, parentSha: sha, commitSha: 'a'.repeat(40),
        proofDigest: 'b'.repeat(64), workItem: 'focus:event.confession' }
      assert.equal(await attributeApprovedReplanCheckpoint(store, stranger,
        continuation.id, proof, ['events/confession.md']), 0)
      assert.equal(await attributeApprovedReplanCheckpoint(store, owner,
        continuation.id, proof, ['characters/nia.md']), 0,
      'a committed out-of-scope path cannot be misattributed as approved')
      assert.equal(await attributeApprovedReplanCheckpoint(store, owner,
        continuation.id, proof, ['events/confession.md']), 1)
      assert.equal(await attributeApprovedReplanCheckpoint(store, owner,
        continuation.id, proof, ['events/confession.md']), 0,
      'recovery never duplicates verified checkpoint associations')
      const activity = (await readThreadChat(store, owner, threadId)).steeringActivity
        .find(item => item.messageId === originalId)!
      assert.equal(activity.implementationCount, 1)
      assert.equal(activity.implementationSha, proof.commitSha)
      assert.equal(activity.verifiedEffectAt, null,
        'verified scoped file change cannot claim narrative fulfillment')
      assert.deepEqual((await store.testing.foreignKeyViolations()), [])
      return
    }
    if (kind === 'cancel-inflight') {
      const pendingId = randomUUID()
      const inFlight = submitThreadRevision(store, owner, threadId, pendingId, task)
      const cancelled = (await cancelQueuedThreadMessage(store, owner, threadId, pendingId))
      assert.equal(cancelled.phase, 'cancelled')
      const settled = await inFlight
      assert.equal(settled.phase, 'cancelled',
        'a scope inference completing after cancellation must not resurrect the instruction')
      assert.equal((await readThreadChat(store, owner, threadId)).messages.find(m => m.id === pendingId)?.hasRevisionScope, 0)
      await advanceThread(store, owner, threadId)
      assert.deepEqual((await readThreadChat(store, owner, threadId)).runs.map(run => run.jobId), [sourceId])
      assert.deepEqual((await store.testing.foreignKeyViolations()), [])
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
      const before = (await readThreadChat(store, owner, threadId))
      assert.deepEqual(before.messages.filter(item => new Set<string>([firstId, secondId]).has(item.id))
        .map(item => [item.id, item.hasRevisionScope]), [[firstId, 1], [secondId, 0]],
      'only the queue head receives an authorized scope')
      await Promise.all([
        advanceThread(store, owner, threadId),
        advanceThread(store, owner, threadId),
      ])
      const after = (await readThreadChat(store, owner, threadId))
      assert.equal(after.messages.find(item => item.id === firstId)?.phase, 'running')
      assert.equal(after.messages.find(item => item.id === secondId)?.phase, 'queued')
      assert.deepEqual(after.runs.map(run => run.jobId), [sourceId, firstId])
      assert.equal((await store.testing.records.count('studio_sessions', { id: secondId })), 0)
      assert.deepEqual((await store.testing.foreignKeyViolations()), [])
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
      assert.equal((await readThreadChat(store, owner, threadId)).messages.find(m => m.id === nextId)?.phase,
        'queued', 'ambiguous first instruction still blocks later authoring')
      const reviewed = await previewThreadRevision(store, owner, threadId, task,
        undefined, ambiguousId)
      assert.ok(reviewed.clarification)
      await assert.rejects(async () => cancelQueuedThreadMessage(store, stranger, threadId,
        ambiguousId), /not found/i)
      const original = (await store.testing.records.first('story_thread_messages', { id: ambiguousId }))
      const cancelled = (await cancelQueuedThreadMessage(store, owner, threadId, ambiguousId))
      assert.equal(cancelled.phase, 'cancelled')
      assert.ok(cancelled.cancelledAt)
      assert.deepEqual((await cancelQueuedThreadMessage(store, owner, threadId, ambiguousId)), cancelled,
        'cancellation is idempotent and preserves one receipt')
      assert.deepEqual((await store.testing.records.first('story_thread_messages', { id: ambiguousId })),
        original, 'the original queued message remains immutable')
      assert.equal((await store.testing.records.count('story_thread_message_cancellations', { messageId: ambiguousId })), 1)
      await assert.rejects(submitThreadRevision(store, owner, threadId, ambiguousId, task),
        /cancelled.*new ID/i)
      await advanceThread(store, owner, threadId)
      const settled = (await readThreadChat(store, owner, threadId))
      assert.deepEqual(settled.messages.filter(m => new Set<string>([ambiguousId, nextId]).has(m.id))
        .map(m => m.phase), ['cancelled', 'running'])
      assert.equal(settled.messages.find(m => m.id === ambiguousId)?.content, task)
      assert.equal(settled.messages.find(m => m.id === nextId)?.hasRevisionScope, 1)
      assert.deepEqual(settled.runs.map(run => run.jobId), [sourceId, nextId])
      await assert.rejects(() => cancelQueuedThreadMessage(store, owner, threadId, nextId),
        /entered execution/i)
      assert.deepEqual((await store.testing.foreignKeyViolations()), [])
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
    assert.equal((await store.testing.records.count('story_thread_messages', { id: childId })), 1,
    'a rejected approval does not discard the earlier atomically reserved message')

    await submitThreadRevision(store, owner, threadId, childId, task,
      undefined, kind === 'broad' ? plan.digest : undefined)
    await assert.rejects(previewThreadRevision(store, owner, threadId,
      'Change character.nia again'), /preceding Thread instruction/i)
    const bufferedId = randomUUID()
    const buffered = await submitThreadRevision(store, owner, threadId,
      bufferedId, 'Change character.nia again')
    assert.equal(buffered.phase, 'queued')
    assert.equal((await store.testing.records.first<{ revisionScopeJson: string | null }>('story_thread_messages',
      { id: bufferedId }))?.revisionScopeJson, null)
    await assert.rejects(submitThreadRevision(store, owner, threadId, childId, 'Other task', undefined, plan.digest),
      /already.*use/)
    assert.equal((await store.testing.records.count('story_thread_messages', { id: childId })), 1)
    await advanceThread(store, owner, threadId)
    const chat = (await readThreadChat(store, owner, threadId))
    assert.equal(chat.messages.find(item => item.id === childId)?.phase, 'running')
    assert.deepEqual(chat.runs.map(run => run.jobId), [sourceId, childId])
    const child = await restoreJob(await selectedJob(store, owner, childId), owner)
    const pinned = pinnedRequest(await selectedJob(store, owner, childId), child)
    assert.deepEqual(pinned?.contract.scope.targets, kind === 'broad'
      ? ['authored-content.confession', 'event.confession'] : ['character.nia'])
    assert.equal(pinned?.contract.scope.kind, 'partial')
    assert.equal(pinned?.contract.scope.depth, kind === 'broad' ? 'composition' : 'architecture')
    assert.equal(pinned?.task, task)
    assert.equal(child.baseSha, sha)
    const turn = await readJobTurnPlan(child)
    assert.ok(turn, 'the admitted child must preserve its own immutable Turn plan')
    assert.equal(turn.originalRequest, task)
    assert.equal(turn.source.jobId, sourceId)
    assert.equal(turn.source.verifiedSha, sha)
    assert.equal(turn.digest, pinned?.turnPlanDigest,
      'the server-owned generation request pins the precise specialist plan')
    assert.deepEqual(turn.assignments.filter(a => a.id.startsWith('focus:'))
      .flatMap(a => a.authority.existingPaths).sort(), plan.writePaths)
    assert.equal((await readJobTurnPlan(await restoreJob(
      await selectedJob(store, owner, childId), owner)))?.digest, turn.digest,
      'reconnect must read the same persisted plan, not silently regenerate scope')
    assert.equal(git(child.worktreeRoot, 'status', '--porcelain'), '')
    assert.equal(git(parent.worktreeRoot, 'rev-parse', 'HEAD'), sha)
    assert.deepEqual((await store.testing.foreignKeyViolations()), [])
  } finally {
    store.close()
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
test('two different-scope Turns continue a single Thread from exact verified Git HEAD across restart',
  { timeout: 90_000 }, () => exerciseRevisionAdmission('multi-turn'))
test('Git commit without final trusted checkpoint blocks further Turns and survives recovery',
  { timeout: 60_000 }, () => exerciseRevisionAdmission('unverified-crash'))
test('cancellation racing with asynchronous inference cannot resurrect or authorize the message',
  { timeout: 60_000 }, () => exerciseRevisionAdmission('cancel-inflight'))
