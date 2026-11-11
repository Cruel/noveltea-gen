import { execFileSync } from 'node:child_process'
import type { StudioStore as StudioDatabase } from '../persistence/store'
import { ThreadMessageConflict as ThreadChatError } from '../persistence/thread-message-contracts'
export { ThreadMessageConflict as ThreadChatError } from '../persistence/thread-message-contracts'
import { selectedJob, restoreJob, pinnedRequest, inspectRegisteredJob, verifyWebExecution } from './fixture-jobs.server'
import { trustedHead } from '../../../src/revision'
import { inspectRecoveryCheckpoints } from '../../../src/recovery-checkpoints'
import { continueCachedStory } from './git-cache.server'
import { assertServerClaimPermitted } from '../../../src/generation-owner'
import { queueRecord } from './generation-queue.server'
import { attributeSteeringCheckpoint, attributeApprovedReplanCheckpoint,
  steeringActivity } from './thread-steering-replan.server'
import { committedStoryFiles, decodeProgressFiles } from './generation-progress.server'
import { assertUserPiSelection, validPiSelection, type PiSelection } from './pi-credentials.server'
import type { GenerationRequest } from '../../../src/generation'
import type { GenerationDraft } from './generation-config.server'
import { assertPinnedRevision, revisionFromSource, submitThreadRevision, type PinnedRevision } from './story-revision.server'
import { assertProtectedThreadApproval, commitProtectedThreadChange } from './thread-protected-decision.server'
import { saveJobTurnPlan } from './turn-plan-receipt.server'
import { parseCreativePolicy, validCreativeMode, type CreativeMode } from '../../../src/creative-policy'

const unsafeText = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

export type ThreadMessage = {
  id: string; role: 'user' | 'assistant'; status: 'delivered' | 'queued'; content: string
  queuePriority: number
  phase: 'queued' | 'preparing' | 'running' | 'finished' | 'blocked' | 'cancelled'
  jobId: string | null; createdAt: string; sequence: number; hasRevisionScope: number
  cancelledAt: string | null
  liveMode: 'steer' | 'follow-up' | null
  liveState: 'pending' | 'dispatching' | 'sdk-queued' | 'delivered' | 'deferred' | 'blocked' | null
  effectVerifiedAt: string | null
  effectReviewer: string | null; effectEvidence: string | null; effectCommitSha: string | null
  liveSourceJobId: string | null; livePiSessionId: string | null
  liveWorkItem: string | null; liveDeliveredAt: string | null
  editCount: number
  creativePolicyJson: string; creativeModeOverride: CreativeMode | null
  editHistory?: Array<{ old: string; replacement: string; editedAt: string }>
}
type Run = { jobId: string; status: string; queuePhase: string | null; runOrder: number }
const now = () => new Date().toISOString()

async function currentRun(store: StudioDatabase, owner: string, id: string) {
  return store.persistence.continuation.current(owner, id)
}
/** Owner-scoped read model, including immutable messages and verified run
 * evidence; advanced steering activity remains on its separate persistence
 * boundary until its migration. */
export async function readThreadChat(store: StudioDatabase, owner: string, threadId: string) {
  const data = await store.persistence.messages.read(owner, threadId)
  const membership = await store.persistence.messages.membership(owner, threadId)
  return { threadId, storyId: membership.storyId,
    creativePolicy: parseCreativePolicy(membership.creativePolicyJson),
    archived: !!membership.archivedAt,
    turns: data.turns,
    turnReceipts: data.turnReceipts,
    messages: data.messages, steeringActivity: await steeringActivity(store, owner, threadId),
    runs: data.runs.map(({ requestJson, ...run }) => ({
      ...run, status: run.queuePhase === 'interrupted' ? 'interrupted'
        : run.queuePhase === 'queued' ? 'queued'
        : run.queuePhase === 'running' ? 'running'
        : run.status === 'paused' && !requestJson ? 'prepared' : run.status,
      fixture: (() => {
        try { return (JSON.parse(requestJson ?? '{}') as { fixture?: boolean }).fixture === true }
        catch { return true }
      })(),
    })),
    evidence: data.evidence.map(({ filesJson, ...item }) => ({
      ...item, files: decodeProgressFiles(filesJson).files,
    })),
  }
}

/** Durable, sequential, idempotent author admission across HTTP retries. */
export async function enqueueThreadMessage(store: StudioDatabase, owner: string, threadId: string,
  id: string, content: string, mode?: 'steer' | 'follow-up',
  creativeMode?: CreativeMode): Promise<ThreadMessage> {
  if (!UUID.test(id) || typeof content !== 'string' || !content.trim() ||
      unsafeText.test(content) ||
      creativeMode !== undefined && !validCreativeMode(creativeMode))
    throw new ThreadChatError(400, 'Send a printable message of 1–4000 characters with a UUID.')
  return store.persistence.messages.enqueue(owner, threadId, id, content.trim(), mode, now(), creativeMode)
}

export async function editQueuedThreadMessage(store: StudioDatabase, owner: string,
  threadId: string, id: string, requestId: string, expected: string, replacement: string): Promise<ThreadMessage> {
  if (!UUID.test(id) || !UUID.test(requestId) || typeof expected !== 'string' ||
      typeof replacement !== 'string' || !replacement.trim() || replacement.length > 4000 ||
      unsafeText.test(replacement))
    throw new ThreadChatError(400, 'Invalid queued message edit.')
  return store.persistence.messages.edit(owner, threadId, id, requestId,
    expected, replacement.trim(), now())
}

export async function cancelQueuedThreadMessage(store: StudioDatabase, owner: string,
  threadId: string, id: string): Promise<ThreadMessage> {
  if (!UUID.test(id)) throw new ThreadChatError(400, 'Invalid queued message identity.')
  return store.persistence.messages.cancel(owner, threadId, id, now())
}

type Admission = import('../persistence/continuation-contracts').ContinuationAdmission
async function claimMessage(store: StudioDatabase, owner: string, threadId: string): Promise<Admission | null> {
  return store.persistence.continuation.claim(owner, threadId)
}

export async function advanceThread(store: StudioDatabase, owner: string, threadId: string): Promise<void> {
  const candidate = await store.persistence.continuation.pending(owner, threadId)
  const source = await currentRun(store, owner, threadId)
  if (candidate && !candidate.scope && source?.status === 'completed' && source.queuePhase === 'finished') {
    try { await submitThreadRevision(store, owner, threadId, candidate.id, candidate.content) }
    catch {
      // Keep the instruction durably queued for an explicit scope review;
      // never treat the missing approval as a failed or interrupted writer.
      return
    }
  }
  const claim = await claimMessage(store, owner, threadId)
  if (!claim) return
  try {
    const row = await selectedJob(store, owner, claim.source)
    const parent = await restoreJob(row, owner)
    const prior = pinnedRequest(row, parent)
    if (!prior || row.status !== 'completed' || (await queueRecord(store, claim.source))?.phase !== 'finished')
      throw new ThreadChatError(409, 'Previous run did not complete; review its saved status.')
    const inspected = await inspectRegisteredJob(store, row, owner)
    if (inspected.status !== 'completed' ||
        ('revisionVerified' in inspected && inspected.revisionVerified === false))
      throw new ThreadChatError(409, 'Previous run is not a clean, completed generation.')
    const head = await trustedHead(parent)
    if (head !== parent.headSha) throw new ThreadChatError(409, 'Previous Story HEAD changed.')
    if (!claim.scopeJson) throw new ThreadChatError(409,
      'This queued instruction has no reviewed revision scope. Inspect its Story targets before retrying.')
    let scope: PinnedRevision
    try { scope = JSON.parse(claim.scopeJson) as PinnedRevision }
    catch { throw new ThreadChatError(409, 'Stored revision scope is corrupt; no writer was authorized.') }
    if (scope.sourceJobId !== claim.source || scope.sourceSha !== head ||
        !Array.isArray(scope.selectedTargets))
      throw new ThreadChatError(409, 'Revision authorization is stale or incomplete; review the Story impact again.')
    const savedTurn = await store.persistence.messages.owned(owner, threadId, claim.id)
    if (!savedTurn) throw new ThreadChatError(409, 'Admitted Turn is missing its pinned policy.')
    const refreshed = await revisionFromSource(store, owner, claim.source, claim.content,
      scope.protectedChange ? undefined : scope.selectedTargets,
      parseCreativePolicy(savedTurn.creativePolicyJson))
    assertPinnedRevision(scope, refreshed, claim.source, head)
    if (scope.protectedChange)
      await assertProtectedThreadApproval(store, owner, threadId, claim.id, claim.source, refreshed)
    const env = { ...process.env }
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX'])
      delete env[key]
    if (execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: parent.worktreeRoot, env, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()) throw new ThreadChatError(409, 'Previous Story has uncommitted files; reconcile them first.')
    const child = await continueCachedStory(parent, claim.id, head)
    if (child.baseSha !== head || child.headSha !== head)
      throw new ThreadChatError(409, 'Continuation baseline differs from verified source.')
    if (!scope.turnPlan)
      throw new ThreadChatError(409, 'Missing specialist assignment receipt; review the Turn again.')
    await saveJobTurnPlan(child, scope.turnPlan)
    if (scope.protectedChange) {
      // The controller, not a Pi writer, makes the one explicitly authorized
      // amendment in an isolated child. Native revision verification and fresh
      // child-scoped trusted approval receipts are mandatory before committing.
      const committed = await commitProtectedThreadChange(child, scope.protectedChange, owner)
      const time = now()
      const request: GenerationRequest = { story: child.storyRoot, job: child.jobId,
        task: claim.content, contract: scope.contract, fixture: true,
        turnPlanDigest: scope.turnPlan.digest }
      const draft: GenerationDraft = { version: 1, headSha: head, task: claim.content,
        contract: scope.contract, limits: {}, model: null }
      await store.persistence.continuation.protectedFinish({
        owner, threadId, claim, sourceHead: head,
        generationThread: child.threadId + ':generation:web',
        draftJson: JSON.stringify(draft), requestJson: JSON.stringify(request), at: time,
      }, committed)
      await advanceThread(store, owner, threadId)
      return
    }
    const oldDraft = row.configJson ? JSON.parse(row.configJson) as GenerationDraft : null
    const model: PiSelection | null = oldDraft?.model ?? null
    if (model && !validPiSelection(model))
      throw new ThreadChatError(409, 'Previous model configuration is invalid.')
    if (model) await assertUserPiSelection(store, owner, model)
    verifyWebExecution(!model)
    const draft: GenerationDraft = { version: 1, headSha: head, task: claim.content,
      contract: scope.contract, limits: oldDraft?.limits ?? {}, model }
    const pinned: GenerationRequest = { story: child.storyRoot, job: child.jobId,
      task: claim.content, contract: scope.contract, fixture: !model,
      orchestrationPolicy: model || prior.skillsSource || process.env.NT_STUDIO_SKILLS_SOURCE
        ? 'explicit' : 'fixture-legacy',
      turnPlanDigest: scope.turnPlan.digest,
      ...(prior.skillsSource ? { skillsSource: prior.skillsSource } : {}),
      ...(model ? { provider: model.provider, model: model.id } : {}) }
    await assertServerClaimPermitted(child, child.threadId + ':generation:web', pinned)
    await store.persistence.continuation.beginFollowUp({
      owner, threadId, claim, sourceHead: head,
      generationThread: child.threadId + ':generation:web',
      draftJson: JSON.stringify(draft), requestJson: JSON.stringify(pinned), at: now(),
    })
  } catch (error) {
    // No automatic retry or rollback of a partially created worktree.
    const message = error instanceof ThreadChatError ? error.message
      : 'Continuation preparation failed. Inspect the saved source and child worktree before retrying.'
    await store.persistence.continuation.block(owner, threadId, claim, message, now())
  }
}

/** Recover an agent crash between queue terminalization and chat settlement.
 * Only read committed queue status; neither the generation graph nor its
 * writer is ever restarted. All follow-up claims remain SQLite-serialized. */
export async function recoverSettledThreadRuns(store: StudioDatabase) {
  const rows = await store.persistence.continuation.settledRuns()
  for (const row of rows) await settleThreadRun(store, row.owner, row.jobId)
}

/** Called after the durable queue phase is terminal. Messages are append-only;
 * next queued follow-up is eligible only after a completed run, never a pause. */
export async function settleThreadRun(store: StudioDatabase, owner: string, jobId: string) {
  const threadId = await store.persistence.continuation.runThread(owner, jobId)
  if (!threadId) return
  let verifiedCommit: string | null = null
  const settled = (await queueRecord(store, jobId))
  if (settled?.phase === 'finished') {
    // A terminal queue receipt is not itself narrative verification. Only
    // explicitly clean, independently verified Story HEADs can become fork
    // ancestry for delivered follow-up messages.
    try {
      const saved = await selectedJob(store, owner, jobId)
      if (saved.status === 'completed') {
        const job = await restoreJob(saved, owner)
        const inspected = await inspectRegisteredJob(store, saved, owner)
        const head = await trustedHead(job)
        if (inspected.status === 'completed' &&
            !('revisionVerified' in inspected && inspected.revisionVerified === false) &&
            job.headSha === head)
          verifiedCommit = head
      }
    } catch { /* Missing or unsafe worktrees remain inspectable, not inheritable. */ }
  }
  // Recover a verified per-specialist attribution if the controller crashed
  // after checkpoint finalization but before publishing the activity receipt.
  try {
    const job = await restoreJob(await selectedJob(store, owner, jobId), owner)
    for (const point of await inspectRecoveryCheckpoints(job)) {
      await attributeSteeringCheckpoint(store, owner, jobId, point)
      if (point.eligible) await attributeApprovedReplanCheckpoint(store, owner, jobId, point,
        committedStoryFiles(job, point.parentSha, point.commitSha))
    }
  } catch { /* No fabricated checkpoint or effect assertion on recovery failure. */ }
  await store.persistence.continuation.settle(owner, jobId, verifiedCommit, now())
  await advanceThread(store, owner, threadId)
}
