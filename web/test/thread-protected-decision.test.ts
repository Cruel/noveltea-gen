import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { removeTestTree } from '../../test/helpers'
import { claimServerGeneration } from '../../src/generation-owner'
import { openWebGenerationGraph } from '../../src/web-fixture-runtime'
import { openStudioDatabase } from './support/studio-database'
import { studioSeed } from './support/studio-seed'
import { migrateStudio } from './support/studio-database'
import { acquireCachedStory } from '../src/lib/git-cache.server'
import { selectedJob, restoreJob, inspectRegisteredJob, pinnedRequest } from '../src/lib/fixture-jobs.server'
import { ensureRootThreads } from '../src/lib/threads.server'
import { cancelQueuedThreadMessage, advanceThread, readThreadChat,
  settleThreadRun, recoverSettledThreadRuns } from '../src/lib/thread-chat.server'
import { previewThreadRevision, submitThreadRevision } from '../src/lib/story-revision.server'
import { assertProtectedThreadApproval, recordProtectedThreadDecision } from '../src/lib/thread-protected-decision.server'
import { readJobTurnPlan } from '../src/lib/turn-plan-receipt.server'
import { runRevisionAction, trustedHead } from '../../src/revision'
import { requestTrustedApproval, recordTrustedControllerDecision } from '../../src/trusted-approval'
import { snapshotForkBoundaryHistory } from '../src/lib/thread-fork-history.server'
import { openStoryThread } from '../src/lib/story-threads.server'

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
  const seed = studioSeed(store)
  for (const id of [owner, stranger]) { await seed.user(id, 0) }
  (await seed.repository({ id: repoId, ownerUserId: owner, provider: 'github',
    providerRepositoryId: '934', name: 'Fixture', createdAt: 'now' }))
  ;(await seed.story({ id: storyId, ownerUserId: owner, repositoryId: repoId,
    directory: 'story', title: 'Protected Story', createdAt: 'now', sourceCommitSha: sha }))
  const source = await acquireCachedStory({
    cacheDirectory: process.env.NT_GIT_CACHE_DIR!, ownerId: owner,
    repositoryId: 'github:934', remoteUrl: 'file://' + remote, token: '',
    directory: 'story', commit: sha, jobId: sourceId,
  })
  const request = { story: source.storyRoot, job: source.jobId,
    task: 'Explore the mystery', contract, fixture: true }
  ;(await seed.job({ id: sourceId, ownerUserId: owner, storyId, title: 'Parent',
    sourceCommitSha: sha, status: 'completed', createdAt: 'now', updatedAt: 'now',
    generationRequestJson: JSON.stringify(request),
    generationThreadId: source.threadId + ':generation:web',
    generationConfigJson: JSON.stringify({
      version: 1, headSha: sha, task: request.task, contract, limits: {}, model: null,
    }) }))
  ;(await seed.queue({ jobId: sourceId, ownerUserId: owner, intent: 'start',
    phase: 'finished', createdAt: 'now', updatedAt: 'now' }))
  await ensureRootThreads(store, owner, storyId)
  await claimServerGeneration(source, source.threadId + ':generation:web', request)
  const graph = openWebGenerationGraph(join(source.stateDir, 'web-generation.sqlite'))
  await graph.graph.updateState({ configurable: { thread_id: source.threadId + ':generation:web' } },
    { request, status: 'completed', completedStages: [] })
  await graph.graph.updateState({ configurable: { thread_id: source.threadId + ':generation:web' } },
    { status: 'completed' }, 'completion_decision')
  graph.saver.db.close()
  function cleanup() {
    store.close()
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
      assert.equal(plan.turnPlan?.kind, 'protected-amendment')
      assert.equal(plan.turnPlan?.objective?.breadth, 'protected-amendment')
      assert.deepEqual(plan.turnPlan?.assignments.map(a => a.id), ['protected-decision'])
      await assert.rejects(previewThreadRevision(f.store, f.stranger, f.threadId, message),
        /no source|not found/i)
      const held = await submitThreadRevision(f.store, f.owner, f.threadId,
        firstId, message, undefined, plan.digest)
      assert.equal(held.phase, 'queued')
      assert.equal(held.hasRevisionScope, 0,
        'a scope digest or prior job consent must never permit a protected retcon')
      await advanceThread(f.store, f.owner, f.threadId)
      assert.deepEqual((await readThreadChat(f.store, f.owner, f.threadId)).runs.map(r => r.jobId), [f.sourceId])
      assert.equal(git(f.source.worktreeRoot, 'rev-parse', 'HEAD'), f.sha)
      assert.equal(git(f.source.worktreeRoot, 'status', '--porcelain'), '')
      assert.equal((await f.store.testing.records.count('studio_sessions')), 1)
      await assert.rejects(() => recordProtectedThreadDecision(f.store, f.stranger, f.threadId,
        firstId, f.sourceId, plan, 'approved'), /queued|source|review|not found/i)
      const denied = await recordProtectedThreadDecision(f.store, f.owner, f.threadId,
        firstId, f.sourceId, plan, 'rejected')
      assert.equal(denied.decision, 'rejected')
      await assert.rejects(() => recordProtectedThreadDecision(f.store, f.owner, f.threadId,
        firstId, f.sourceId, plan, 'approved'), /different|stale/i)
      await assert.rejects(() => assertProtectedThreadApproval(f.store, f.owner, f.threadId,
        firstId, f.sourceId, plan), /fresh|exact/i)
      assert.equal(git(f.source.worktreeRoot, 'status', '--porcelain'), '')
      await cancelQueuedThreadMessage(f.store, f.owner, f.threadId, firstId)

      const childId = randomUUID()
      const preview = await previewThreadRevision(f.store, f.owner, f.threadId, message)
      await submitThreadRevision(f.store, f.owner, f.threadId, childId, message)
      const granted = await recordProtectedThreadDecision(f.store, f.owner, f.threadId,
        childId, f.sourceId, preview, 'approved')
      assert.equal(granted.digest, preview.digest)
      await assert.rejects(() => assertProtectedThreadApproval(f.store, f.stranger, f.threadId,
        childId, f.sourceId, preview), /fresh|exact/i)
      await assert.rejects(() => assertProtectedThreadApproval(f.store, f.owner, f.threadId,
        childId, f.sourceId, { ...preview, digest: 'f'.repeat(64) }), /fresh|exact/i)
      await assert.rejects(() => assertProtectedThreadApproval(f.store, f.owner, f.threadId,
        childId, randomUUID(), preview), /fresh|exact/i)
      await submitThreadRevision(f.store, f.owner, f.threadId, childId, message, undefined, preview.digest)
      assert.equal((await readThreadChat(f.store, f.owner, f.threadId)).messages.find(m => m.id === childId)?.hasRevisionScope, 1)
      await advanceThread(f.store, f.owner, f.threadId)
      const current = (await readThreadChat(f.store, f.owner, f.threadId))
      assert.equal(current.messages.find(m => m.id === childId)?.phase, 'finished',
        JSON.stringify(current.messages))
      assert.deepEqual(current.runs.map(r => r.jobId), [f.sourceId, childId])
      const child = await restoreJob(await selectedJob(f.store, f.owner, childId), f.owner)
      const persisted = await readJobTurnPlan(child)
      assert.equal(persisted?.kind, 'protected-amendment')
      assert.deepEqual(persisted?.assignments.map(a => a.id), ['protected-decision'])
      assert.equal(persisted?.digest, preview.turnPlan?.digest)
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
      assert.equal((await inspectRegisteredJob(f.store, await selectedJob(f.store, f.owner, childId),
        f.owner)).status, 'completed')
      assert.equal(current.messages.filter(m => m.id === childId).length, 1)
      await assert.rejects(() => assertProtectedThreadApproval(f.store, f.owner, f.threadId,
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
      await recordProtectedThreadDecision(f.store, f.owner, f.threadId, nextId, childId,
        newerPlan, 'approved')
      await submitThreadRevision(f.store, f.owner, f.threadId,
        nextId, newerMessage, undefined, newerPlan.digest)
      await advanceThread(f.store, f.owner, f.threadId)
      assert.equal((await readThreadChat(f.store, f.owner, f.threadId))
        .messages.find(m => m.id === nextId)?.phase, 'finished')
      const nextJob = await restoreJob(await selectedJob(f.store, f.owner, nextId), f.owner)
      assert.notEqual(nextJob.headSha, child.headSha,
        'natural-language proposal requires a distinct approved child commit')
      assert.equal(git(f.source.worktreeRoot, 'rev-parse', 'HEAD'), f.sha)
      const ordinaryId = randomUUID()
      const ordinary = await submitThreadRevision(f.store, f.owner, f.threadId,
        ordinaryId, 'Make character.mara more assertive')
      assert.equal(ordinary.hasRevisionScope, 1,
        'nonprotected follow-up edits continue normally after the exact protected amendment')
      assert.deepEqual((await f.store.testing.foreignKeyViolations()), [])
    } finally { f.cleanup() }
  })

test('native-validated protected Turn then Character Turn preserve exact Git lineage, restart receipts and older fork authority',
  { skip: !existsSync(native) || !existsSync(reference), timeout: 180_000 }, async () => {
    const f = await setup()
    try {
      const protectedId = randomUUID()
      const protectedPlan = await previewThreadRevision(f.store, f.owner, f.threadId, message)
      await submitThreadRevision(f.store, f.owner, f.threadId, protectedId, message)
      await recordProtectedThreadDecision(f.store, f.owner, f.threadId,
        protectedId, f.sourceId, protectedPlan, 'approved')
      await submitThreadRevision(f.store, f.owner, f.threadId,
        protectedId, message, undefined, protectedPlan.digest)
      await Promise.all([advanceThread(f.store, f.owner, f.threadId),
        advanceThread(f.store, f.owner, f.threadId)])
      const first = await restoreJob(await selectedJob(f.store, f.owner, protectedId), f.owner)
      const firstSha = git(first.worktreeRoot, 'rev-parse', 'HEAD')
      assert.notEqual(firstSha, f.sha)
      assert.equal(await trustedHead(first), firstSha,
        'the first Turn was committed by the native-validated protected revision graph')
      assert.equal((await readThreadChat(f.store, f.owner, f.threadId))
        .turnReceipts.find(turn => turn.id === protectedId)?.executions[0]?.validatedSha, firstSha)
      await assert.rejects(() => assertProtectedThreadApproval(f.store, f.owner, f.threadId,
        protectedId, f.sourceId, protectedPlan), /fresh|exact/i,
      'a consumed protected approval cannot be replayed')

      const characterId = randomUUID()
      const characterTask = 'Make character.mara more assertive'
      const characterPlan = await previewThreadRevision(f.store, f.owner, f.threadId, characterTask)
      assert.deepEqual(characterPlan.targets, ['character.mara'])
      assert.equal(characterPlan.headSha, firstSha)
      await submitThreadRevision(f.store, f.owner, f.threadId, characterId, characterTask)
      await Promise.all([advanceThread(f.store, f.owner, f.threadId),
        advanceThread(f.store, f.owner, f.threadId)])
      const second = await restoreJob(await selectedJob(f.store, f.owner, characterId), f.owner)
      const pinned = pinnedRequest(await selectedJob(f.store, f.owner, characterId), second)!
      assert.equal(second.baseSha, firstSha)
      assert.equal(git(second.worktreeRoot, 'rev-parse', 'HEAD'), firstSha)
      assert.equal(git(second.worktreeRoot, 'status', '--porcelain'), '')
      const path = join(second.worktreeStoryRoot, 'characters/mara.md')
      writeFileSync(path, readFileSync(path, 'utf8') +
        '\nMara calmly challenges the council rather than retreating.\n')
      const proposal = await runRevisionAction({ story: second.storyRoot, job: second.jobId,
        workItem: 'character-follow-up', action: 'inspect', path: 'characters/mara.md' })
      assert.equal(proposal.status, 'proposed')
      assert.deepEqual(proposal.protectedChanges, [],
        'native diff reports no protected decision under the separate Character scope')
      const staged = await requestTrustedApproval(second, {
        id: 'character-review', kind: 'editorial', workItemId: 'character-follow-up',
        payload: {
          version: 1, kind: 'editorial', jobId: second.jobId, threadId: second.threadId,
          workItemId: 'character-follow-up', baseSha: second.baseSha,
          verifiedHead: firstSha, proposalSha256: proposal.proposalSha256,
          verdict: 'pass', evidence: 'characters/mara.md:1',
          notes: 'The added character line stays within the approved characterization request.',
        },
      })
      const approved = await recordTrustedControllerDecision(second, {
        id: staged.id, nonce: staged.nonce, proposalSha256: proposal.proposalSha256,
      }, 'approved', { source: 'trusted-web', principal: 'user:' + f.owner })
      const referenceFile = join(second.stateDir, 'character-approval-reference.json')
      writeFileSync(referenceFile, JSON.stringify({ receiptId: approved.id, nonce: approved.nonce }))
      await runRevisionAction({ story: second.storyRoot, job: second.jobId,
        workItem: 'character-follow-up', action: 'review',
        proposal: proposal.proposalSha256, approvalFile: referenceFile })
      const finished = await runRevisionAction({ story: second.storyRoot, job: second.jobId,
        workItem: 'character-follow-up', action: 'commit', proposal: proposal.proposalSha256 })
      const secondSha = finished.commitSha!
      assert.equal(finished.status, 'committed')
      assert.notEqual(secondSha, firstSha)
      assert.equal(await trustedHead(second), secondSha)
      assert.equal(git(second.worktreeRoot, 'diff', '--name-only', firstSha, secondSha),
        'story/characters/mara.md')
      assert.equal(git(first.worktreeRoot, 'rev-parse', 'HEAD'), firstSha,
        'the second Turn cannot mutate the previous verified execution')
      assert.equal(git(f.source.worktreeRoot, 'rev-parse', 'HEAD'), f.sha)

      await claimServerGeneration(second, second.threadId + ':generation:web', pinned)
      const graph = openWebGenerationGraph(join(second.stateDir, 'web-generation.sqlite'))
      await graph.graph.updateState({ configurable: { thread_id: second.threadId + ':generation:web' } },
        { request: pinned, status: 'completed', completedStages: [] })
      await graph.graph.updateState({ configurable: { thread_id: second.threadId + ':generation:web' } },
        { status: 'completed' }, 'completion_decision')
      graph.saver.db.close()
      await f.store.testing.records.update('studio_sessions', { id: characterId }, {
        status: 'completed', generationRequestJson: JSON.stringify(pinned),
        generationThreadId: second.threadId + ':generation:web',
      })
      await f.store.testing.records.update('generation_run_queue', { jobId: characterId },
        { phase: 'finished' })
      await settleThreadRun(f.store, f.owner, characterId)
      await recoverSettledThreadRuns(f.store)
      await recoverSettledThreadRuns(f.store)
      const chat = await readThreadChat(f.store, f.owner, f.threadId)
      assert.deepEqual(chat.runs.map(run => run.jobId), [f.sourceId, protectedId, characterId])
      assert.deepEqual(chat.turnReceipts.find(turn => turn.id === characterId)?.executions.map(
        run => [run.jobId, run.inputSha, run.validatedSha]),
      [[characterId, firstSha, secondSha]])
      assert.equal(chat.messages.filter(row => row.id === 'assistant:' + characterId).length, 1)

      // Fork the *older* trusted checkpoint only after the newer Turn settles.
      // Its immutable origin must not move to the later Character commit.
      const firstRunOrder = await f.store.persistence.advancedThreads.runOrder(
        f.owner, f.threadId, protectedId)
      assert.equal(firstRunOrder, 1)
      const history = await snapshotForkBoundaryHistory(f.store, f.owner, f.threadId,
        first, message, 'now', firstSha, undefined, firstRunOrder)
      assert.ok(history.every(row => row.verifiedSha !== secondSha))
      assert.ok(!history.some(row => row.body === characterTask), JSON.stringify(history))
      assert.ok(!chat.messages.some(row => row.id === 'initial:' + characterId),
        'the admitted author Turn must not get a second synthetic message at its input SHA')
      const digest = createHash('sha256').update(readFileSync(
        join(first.stateDir, 'revisions/thread-protected.json'))).digest('hex')
      const forkJob = randomUUID(), forkThread = 'fork:' + forkJob
      await f.store.persistence.advancedThreads.reserveFork({
        childId: forkJob, owner: f.owner, sourceJobId: protectedId,
        sourceBaseSha: first.baseSha, commitSha: firstSha,
        bundle: '{"version":1}', draft: '{"version":1}',
        sourceThreadId: f.threadId, proofDigest: digest,
        guidance: 'Explore the earlier protected version', history: JSON.stringify(history),
        at: new Date().toISOString(),
      })
      await f.store.persistence.advancedThreads.registerChild({
        childId: forkJob, owner: f.owner, storyId: (await readThreadChat(f.store, f.owner, f.threadId)).storyId,
        title: 'Earlier checkpoint alternative', baseSha: firstSha,
        parentThreadId: f.threadId, threadId: forkThread,
        draft: '{"version":1}', at: new Date().toISOString(), kind: 'fork',
        history, guidance: 'Explore the earlier protected version',
      })
      const forked = await openStoryThread(f.store, f.owner, chat.storyId, forkThread)
      assert.equal(forked.ancestry.at(-1)?.forkPoint?.commitSha, firstSha)
      assert.equal(forked.ancestry.at(-1)?.forkPoint?.proofDigest, digest)
      assert.ok(!forked.state.messages.some(row => row.content === characterTask))
      await assert.rejects(() => assertProtectedThreadApproval(f.store, f.owner,
        forkThread, protectedId, f.sourceId, protectedPlan), /fresh|exact/i,
      'fork ancestry is not a transferable protected approval')
      const reopened = openStudioDatabase(join(f.root, 'studio.sqlite'))
      try {
        await reopened.assertReady()
        assert.deepEqual((await readThreadChat(reopened, f.owner, f.threadId)).turnReceipts,
          chat.turnReceipts)
        assert.deepEqual((await openStoryThread(reopened, f.owner, chat.storyId, forkThread)).ancestry,
          forked.ancestry)
      } finally { reopened.close() }
      assert.deepEqual(await f.store.testing.foreignKeyViolations(), [])
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
