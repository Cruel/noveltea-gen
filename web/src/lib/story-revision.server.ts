import { execFileSync } from 'node:child_process'
import type { StudioStore as StudioDatabase } from '../persistence/store'
import { selectedJob, restoreJob, pinnedRequest, inspectRegisteredJob } from './fixture-jobs.server'
import { trustedHead } from '../../../src/revision'
import { validateStoryJob } from '../../../src/validator'
import type { CanonicalScopeRecord } from '../../../src/focused-scope'
import { inferStoryObjective, applyCreativeModeToRevision,
  type RevisionPreview, type ProtectedDecisionChange } from './story-revision-plan'
import { assertProtectedThreadApproval } from './thread-protected-decision.server'
import { enqueueThreadMessage, type ThreadMessage, ThreadChatError } from './thread-chat.server'
import { planObjective, assertTurnPlan, type TurnPlan } from './turn-plan'
import { DEFAULT_CREATIVE_POLICY, parseCreativePolicy,
  type CreativeMode, type CreativePolicy } from '../../../src/creative-policy'

type Source = { jobId: string; status: string; queuePhase: string | null }
export type PinnedRevision = {
  sourceJobId: string; sourceSha: string; digest: string
  selectedTargets: string[]; approved: boolean
  contract: RevisionPreview['contract']; writePaths: string[]; contextIds: string[]
  protectedChange?: ProtectedDecisionChange
  turnPlan?: TurnPlan
}
/** Final authority check is performed after a fresh canonical validation and
 * before worktree allocation. A browser- or DB-originated path is never used
 * without byte-for-byte confirmation of the controller's derived grant. */
export function assertPinnedRevision(scope: PinnedRevision, refreshed: RevisionPreview & { turnPlan?: TurnPlan | null },
  sourceJobId: string, headSha: string): void {
  if (scope.sourceJobId !== sourceJobId || scope.sourceSha !== headSha ||
      !Array.isArray(scope.selectedTargets) || !Array.isArray(scope.writePaths) ||
      !Array.isArray(scope.contextIds) || typeof scope.digest !== 'string' ||
      refreshed.clarification || refreshed.digest !== scope.digest ||
      refreshed.reviewRequired && scope.approved !== true ||
      JSON.stringify(refreshed.targets) !== JSON.stringify(scope.selectedTargets) ||
      JSON.stringify(refreshed.writePaths) !== JSON.stringify(scope.writePaths) ||
      JSON.stringify(refreshed.contextIds) !== JSON.stringify(scope.contextIds) ||
      JSON.stringify(refreshed.contract) !== JSON.stringify(scope.contract) ||
      JSON.stringify(refreshed.protectedChange) !== JSON.stringify(scope.protectedChange ?? null) ||
      (!!refreshed.turnPlan !== !!scope.turnPlan))
    throw new ThreadChatError(409, 'Story impact or protected scope changed since approval; no continuation was started.')
  if (refreshed.turnPlan && scope.turnPlan) {
    try { assertTurnPlan(scope.turnPlan, refreshed.turnPlan) }
    catch { throw new ThreadChatError(409, 'Saved specialist assignments changed since approval.') }
  }
}
async function pendingInstruction(store: StudioDatabase, owner: string, threadId: string) {
  return store.persistence.revisions.head(owner, threadId)
}
async function assertHeadOfQueue(store: StudioDatabase, owner: string, threadId: string,
  messageId?: string) {
  const pending = await pendingInstruction(store, owner, threadId)
  if (pending && (pending.phase !== 'queued' || pending.id !== messageId))
    throw new ThreadChatError(409, 'Wait for the preceding Thread instruction to reach a verified boundary.')
  return pending
}
async function latestRunStatus(store: StudioDatabase, owner: string, threadId: string): Promise<Source> {
  const row = await store.persistence.revisions.latestRun(owner, threadId)
  if (!row) throw new ThreadChatError(404, 'Thread has no source generation run.')
  return row
}
async function latestRun(store: StudioDatabase, owner: string, threadId: string): Promise<Source> {
  const row = await latestRunStatus(store, owner, threadId)
  if (row.status !== 'completed' || row.queuePhase !== 'finished')
    throw new ThreadChatError(409, 'Finish or reconcile the current Thread run before proposing a revision.')
  return row
}
export async function revisionFromSource(store: StudioDatabase, owner: string,
  sourceJobId: string, prompt: string, selectedTargets?: string[],
  policy: CreativePolicy = DEFAULT_CREATIVE_POLICY) {
  const jobRow = await selectedJob(store, owner, sourceJobId)
  const parent = await restoreJob(jobRow, owner)
  const pinned = pinnedRequest(jobRow, parent)
  if (!pinned) throw new ThreadChatError(409, 'Source run has no pinned generation contract.')
  const inspected = await inspectRegisteredJob(store, jobRow, owner)
  if (inspected.status !== 'completed' ||
      ('revisionVerified' in inspected && inspected.revisionVerified === false))
    throw new ThreadChatError(409, 'Source run has no completed verified Story revision.')
  const headSha = await trustedHead(parent)
  if (headSha !== parent.headSha)
    throw new ThreadChatError(409, 'Source Story revision changed; inspect the saved job before continuing.')
  const env = { ...process.env }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[key]
  if (execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: parent.worktreeRoot, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()) throw new ThreadChatError(409, 'The source worktree is dirty; reconcile changes before proposing a scope.')
  const result = await validateStoryJob(parent, pinned.validatorSource ?? pinned.skillsSource,
    { ...parent, baseSha: headSha })
  const report = result.report as { records?: CanonicalScopeRecord[]; diagnostics?: unknown[];
    protection?: { status?: string; base?: string; changes?: unknown[]; warnings?: unknown[] } } | undefined
  if (result.status !== 'passed' || !Array.isArray(report?.records) || !Array.isArray(report.diagnostics) ||
      report.diagnostics.length || report.protection?.status !== 'checked' ||
      report.protection.base !== headSha || report.protection.changes?.length ||
      report.protection.warnings?.length)
    throw new ThreadChatError(409, 'The pinned canonical validator cannot verify the complete Story and protected decisions at this HEAD.')
  const preview = applyCreativeModeToRevision(
    inferStoryObjective(prompt, report.records, headSha, pinned.contract, selectedTargets), policy)
  return { ...preview, turnPlan: preview.clarification ? null :
    !preview.protectedChange && preview.contract.scope.kind === 'full-story'
      ? planObjective({ kind: 'full-story', request: preview.request,
          contract: preview.contract, base: headSha, sourceJobId, policy })
      : planObjective({ kind: 'revision', request: preview.request,
          contract: preview.contract, base: headSha, sourceJobId, catalog: report.records,
          targetIds: preview.targets, allowedPaths: preview.writePaths,
          protectedChange: preview.protectedChange, policy }) }
}
export async function previewThreadRevision(store: StudioDatabase, owner: string,
  threadId: string, prompt: string, selectedTargets?: string[], messageId?: string) {
  const pending = await assertHeadOfQueue(store, owner, threadId, messageId)
  if (pending && pending.content !== prompt.trim())
    throw new ThreadChatError(409, 'Queued instruction changed; refresh the Thread before reviewing.')
  const run = await latestRun(store, owner, threadId)
  const pinned = messageId ? await store.persistence.messages.owned(owner, threadId, messageId) : null
  const policy = parseCreativePolicy(pinned?.creativePolicyJson ??
    (await store.persistence.messages.membership(owner, threadId)).creativePolicyJson)
  return revisionFromSource(store, owner, run.jobId, prompt, selectedTargets, policy)
}
/** One transaction binds the reviewed preview to the immutable queued message.
 * A retry with the same UUID cannot replace its earlier controller grant. */
export async function submitThreadRevision(store: StudioDatabase, owner: string, threadId: string,
  id: string, content: string, selectedTargets?: string[], approvalDigest?: string,
  liveMode?: 'steer' | 'follow-up', creativeMode?: CreativeMode): Promise<ThreadMessage> {
  if (liveMode === 'steer' && (selectedTargets || approvalDigest))
    throw new ThreadChatError(409, 'Live model instructions cannot grant a new Story write scope.')
  // Reserve the UUID and its exact place in the queue *synchronously* before
  // any native validation, Git access or other asynchronous scope inference.
  // The second concurrent request therefore always has its own durable slot.
  const saved = await enqueueThreadMessage(store, owner, threadId, id, content, liveMode, creativeMode)
  // Admission is durable, but scope inference is asynchronous: retry/cancel
  // may update the row before this request returns to the caller.
  const latest = async () => await store.persistence.messages.owned(owner, threadId, id) ?? saved
  // A duplicate HTTP request may arrive after the author has edited the
  // queued message. Return the durable current version without inferring or
  // granting a new scope from the stale pre-edit text.
  if (saved.content !== content.trim()) return latest()
  if (saved.liveMode === 'steer') {
    if (selectedTargets || approvalDigest)
      throw new ThreadChatError(409, 'Steering is not a new scope approval or a writer grant.')
    return latest()
  }
  // Explicit follow-ups use the same verified-source admission as normal Turns.
  // They never inherit the current running specialist's scope or Pi session.
  if (saved.phase === 'cancelled')
    throw new ThreadChatError(409, 'This instruction was cancelled. Send a new instruction with a new ID.')
  const pinnedRow = { scope: await store.persistence.revisions.scope(owner, threadId, id) }
  if (pinnedRow.scope) {
    const pinned = JSON.parse(pinnedRow.scope) as PinnedRevision
    if (approvalDigest && approvalDigest !== pinned.digest ||
        selectedTargets && JSON.stringify([...selectedTargets].sort()) !== JSON.stringify(pinned.selectedTargets))
      throw new ThreadChatError(409, 'The retry differs from the saved approved revision scope.')
    return latest()
  }
  const pending = await pendingInstruction(store, owner, threadId)
  const current = await latestRunStatus(store, owner, threadId)
  // Later queued requests may carry a preview/approval for the old HEAD, but
  // none of it is applied to the as-yet-unverified future Story revision.
  if (saved.phase !== 'queued' || pending?.id !== id ||
      current.status !== 'completed' || current.queuePhase !== 'finished') return latest()

  const source = current
  const plan = await revisionFromSource(store, owner, source.jobId, content, selectedTargets,
    parseCreativePolicy(saved.creativePolicyJson))
  // Clarifications and unapproved material expansions stay durably queued for
  // review or cancellation, rather than consuming the head of the Thread.
  if (plan.clarification) return latest()
  // A delivered steer asking for additional scope must never auto-admit a
  // single-target replan. Author approval is required even if the inferred
  // new scope would normally be eligible for automatic continuation.
  const redirected = await store.persistence.revisions.redirected(owner, threadId, id)
  if (redirected && !approvalDigest) return latest()
  if (approvalDigest && approvalDigest !== plan.digest)
    throw new ThreadChatError(409, 'Story scope changed since review. Inspect the updated proposal.')
  if (plan.protectedChange) {
    // A reviewed scope digest is not an authorization. A separate authenticated
    // controller decision must exist in the owner-scoped immutable ledger.
    try { await assertProtectedThreadApproval(store, owner, threadId, id, source.jobId, plan) }
    catch (error) {
      if (error instanceof ThreadChatError && error.status === 409) return latest()
      throw error
    }
  } else if (plan.reviewRequired && !approvalDigest) return latest()
  const receipt: PinnedRevision = { sourceJobId: source.jobId, sourceSha: plan.headSha,
    digest: plan.digest, selectedTargets: plan.targets, approved: !!approvalDigest || !!plan.protectedChange,
    contract: plan.contract, writePaths: plan.writePaths, contextIds: plan.contextIds,
    ...(plan.turnPlan ? { turnPlan: plan.turnPlan } : {}),
    ...(plan.protectedChange ? { protectedChange: plan.protectedChange } : {}) }
  await store.persistence.revisions.grant(owner, threadId, id, content, source, JSON.stringify(receipt))
  return latest()

}
