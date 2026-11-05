import { execFileSync } from 'node:child_process'
import type { StudioDatabase } from '../db/connection'
import { selectedJob, restoreJob, pinnedRequest, inspectRegisteredJob } from './fixture-jobs.server'
import { trustedHead } from '../../../src/revision'
import { validateStoryJob } from '../../../src/validator'
import type { CanonicalScopeRecord } from '../../../src/focused-scope'
import { inferStoryRevision, type RevisionPreview, type ProtectedDecisionChange } from './story-revision-plan'
import { assertProtectedThreadApproval } from './thread-protected-decision.server'
import { enqueueThreadMessage, type ThreadMessage, ThreadChatError } from './thread-chat.server'
import { ownedThreadMessageSqlite } from '../persistence/thread-message-sqlite'

type Source = { jobId: string; status: string; queuePhase: string | null }
export type PinnedRevision = {
  sourceJobId: string; sourceSha: string; digest: string
  selectedTargets: string[]; approved: boolean
  contract: RevisionPreview['contract']; writePaths: string[]; contextIds: string[]
  protectedChange?: ProtectedDecisionChange
}
/** Final authority check is performed after a fresh canonical validation and
 * before worktree allocation. A browser- or DB-originated path is never used
 * without byte-for-byte confirmation of the controller's derived grant. */
export function assertPinnedRevision(scope: PinnedRevision, refreshed: RevisionPreview,
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
      JSON.stringify(refreshed.protectedChange) !== JSON.stringify(scope.protectedChange ?? null))
    throw new ThreadChatError(409, 'Story impact or protected scope changed since approval; no continuation was started.')
}
function pendingInstruction(store: StudioDatabase, owner: string, threadId: string) {
  return store.sqlite.prepare(`SELECT m.id,m.body AS content,m.phase
    FROM story_thread_messages m WHERE m.owner_user_id=? AND m.thread_id=? AND m.role='user'
      AND m.phase IN ('queued','preparing','running','blocked')
      AND NOT EXISTS (SELECT 1 FROM story_thread_message_cancellations c WHERE c.message_id=m.id)
    ORDER BY COALESCE((SELECT original.sequence FROM thread_steering_intents intent
      JOIN story_thread_messages original ON original.id=intent.message_id
      WHERE intent.review_message_id=m.id),m.sequence),m.sequence LIMIT 1`).get(owner, threadId) as
    { id: string; content: string; phase: string } | undefined
}
function assertHeadOfQueue(store: StudioDatabase, owner: string, threadId: string,
  messageId?: string) {
  const pending = pendingInstruction(store, owner, threadId)
  if (pending && (pending.phase !== 'queued' || pending.id !== messageId))
    throw new ThreadChatError(409, 'Wait for the preceding Thread instruction to reach a verified boundary.')
  return pending
}
function latestRunStatus(store: StudioDatabase, owner: string, threadId: string): Source {
  const row = store.sqlite.prepare(`SELECT r.job_id AS jobId,j.status,q.phase AS queuePhase
    FROM story_thread_runs r
    JOIN studio_sessions j ON j.id=r.job_id AND j.owner_user_id=r.owner_user_id
    LEFT JOIN generation_run_queue q ON q.job_id=j.id AND q.owner_user_id=j.owner_user_id
    JOIN story_threads t ON t.id=r.thread_id AND t.owner_user_id=r.owner_user_id
    WHERE r.thread_id=? AND r.owner_user_id=? ORDER BY r.run_order DESC LIMIT 1`).get(threadId, owner) as Source | undefined
  if (!row) throw new ThreadChatError(404, 'Thread has no source generation run.')
  return row
}
function latestRun(store: StudioDatabase, owner: string, threadId: string): Source {
  const row = latestRunStatus(store, owner, threadId)
  if (row.status !== 'completed' || row.queuePhase !== 'finished')
    throw new ThreadChatError(409, 'Finish or reconcile the current Thread run before proposing a revision.')
  return row
}
export async function revisionFromSource(store: StudioDatabase, owner: string,
  sourceJobId: string, prompt: string, selectedTargets?: string[]) {
  const jobRow = selectedJob(store, owner, sourceJobId)
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
  return inferStoryRevision(prompt, report.records, headSha, pinned.contract, selectedTargets)
}
export async function previewThreadRevision(store: StudioDatabase, owner: string,
  threadId: string, prompt: string, selectedTargets?: string[], messageId?: string) {
  const pending = assertHeadOfQueue(store, owner, threadId, messageId)
  if (pending && pending.content !== prompt.trim())
    throw new ThreadChatError(409, 'Queued instruction changed; refresh the Thread before reviewing.')
  const run = latestRun(store, owner, threadId)
  return revisionFromSource(store, owner, run.jobId, prompt, selectedTargets)
}
/** One transaction binds the reviewed preview to the immutable queued message.
 * A retry with the same UUID cannot replace its earlier controller grant. */
export async function submitThreadRevision(store: StudioDatabase, owner: string, threadId: string,
  id: string, content: string, selectedTargets?: string[], approvalDigest?: string,
  liveMode?: 'steer' | 'follow-up'): Promise<ThreadMessage> {
  if (liveMode && (selectedTargets || approvalDigest))
    throw new ThreadChatError(409, 'Live Pi instructions cannot grant a new Story write scope.')
  // Reserve the UUID and its exact place in the queue *synchronously* before
  // any native validation, Git access or other asynchronous scope inference.
  // The second concurrent request therefore always has its own durable slot.
  const saved = await enqueueThreadMessage(store, owner, threadId, id, content, liveMode)
  // Admission is durable, but scope inference is asynchronous: retry/cancel
  // may update the row before this request returns to the caller.
  const latest = () => ownedThreadMessageSqlite(store.db, owner, threadId, id) ?? saved
  // A duplicate HTTP request may arrive after the author has edited the
  // queued message. Return the durable current version without inferring or
  // granting a new scope from the stale pre-edit text.
  if (saved.content !== content.trim()) return latest()
  if (saved.liveMode && liveMode) {
    if (selectedTargets || approvalDigest)
      throw new ThreadChatError(409, 'Steering is not a new scope approval or a writer grant.')
    return latest()
  }
  if (saved.phase === 'cancelled')
    throw new ThreadChatError(409, 'This instruction was cancelled. Send a new instruction with a new ID.')
  const pinnedRow = store.sqlite.prepare(`SELECT revision_scope_json AS scope
    FROM story_thread_messages WHERE id=? AND owner_user_id=? AND thread_id=?`)
    .get(id, owner, threadId) as { scope: string | null }
  if (pinnedRow.scope) {
    const pinned = JSON.parse(pinnedRow.scope) as PinnedRevision
    if (approvalDigest && approvalDigest !== pinned.digest ||
        selectedTargets && JSON.stringify([...selectedTargets].sort()) !== JSON.stringify(pinned.selectedTargets))
      throw new ThreadChatError(409, 'The retry differs from the saved approved revision scope.')
    return latest()
  }
  const pending = pendingInstruction(store, owner, threadId)
  const current = latestRunStatus(store, owner, threadId)
  // Later queued requests may carry a preview/approval for the old HEAD, but
  // none of it is applied to the as-yet-unverified future Story revision.
  if (saved.phase !== 'queued' || pending?.id !== id ||
      current.status !== 'completed' || current.queuePhase !== 'finished') return latest()

  const source = current
  const plan = await revisionFromSource(store, owner, source.jobId, content, selectedTargets)
  // Clarifications and unapproved material expansions stay durably queued for
  // review or cancellation, rather than consuming the head of the Thread.
  if (plan.clarification) return latest()
  // A delivered steer asking for additional scope must never auto-admit a
  // single-target replan. Author approval is required even if the inferred
  // new scope would normally be eligible for automatic continuation.
  const redirected = store.sqlite.prepare(`SELECT i.disposition FROM thread_steering_intents i
    WHERE i.review_message_id=? AND i.owner_user_id=? AND i.thread_id=?`)
    .get(id, owner, threadId) as { disposition: string } | undefined
  if (redirected && !approvalDigest) return latest()
  if (approvalDigest && approvalDigest !== plan.digest)
    throw new ThreadChatError(409, 'Story scope changed since review. Inspect the updated proposal.')
  if (plan.protectedChange) {
    // A reviewed scope digest is not an authorization. A separate authenticated
    // controller decision must exist in the owner-scoped immutable ledger.
    try { assertProtectedThreadApproval(store, owner, threadId, id, source.jobId, plan) }
    catch (error) {
      if (error instanceof ThreadChatError && error.status === 409) return latest()
      throw error
    }
  } else if (plan.reviewRequired && !approvalDigest) return latest()
  const receipt: PinnedRevision = { sourceJobId: source.jobId, sourceSha: plan.headSha,
    digest: plan.digest, selectedTargets: plan.targets, approved: !!approvalDigest || !!plan.protectedChange,
    contract: plan.contract, writePaths: plan.writePaths, contextIds: plan.contextIds,
    ...(plan.protectedChange ? { protectedChange: plan.protectedChange } : {}) }
  return store.sqlite.transaction(() => {
    const currentMessage = ownedThreadMessageSqlite(store.db, owner, threadId, id)
    if (!currentMessage) throw new ThreadChatError(409, 'Queued instruction is no longer available.')
    const live = latestRunStatus(store, owner, threadId)
    const head = pendingInstruction(store, owner, threadId)
    // A cancellation, concurrent claim or newly completed predecessor means
    // this preview is no longer a writer grant. Leave the original in history.
    if (currentMessage.phase !== 'queued' || currentMessage.content !== content.trim() ||
        head?.id !== id || live.jobId !== source.jobId || live.status !== 'completed' || live.queuePhase !== 'finished')
      return currentMessage
    const existing = store.sqlite.prepare(`SELECT revision_scope_json AS scope FROM story_thread_messages
      WHERE id=? AND owner_user_id=? AND thread_id=?`).get(id, owner, threadId) as
      { scope: string | null } | undefined
    if (existing?.scope) {
      if (existing.scope !== JSON.stringify(receipt))
        throw new ThreadChatError(409, 'Message UUID already has a different scope authorization.')
    } else {
      const changes = store.sqlite.prepare(`UPDATE story_thread_messages SET revision_scope_json=?
        WHERE id=? AND owner_user_id=? AND thread_id=? AND phase='queued' AND revision_scope_json IS NULL
          AND NOT EXISTS (SELECT 1 FROM story_thread_message_cancellations c
            WHERE c.message_id=story_thread_messages.id)`)
        .run(JSON.stringify(receipt), id, owner, threadId).changes
      if (changes !== 1) return ownedThreadMessageSqlite(store.db, owner, threadId, id) ?? saved
    }
    return ownedThreadMessageSqlite(store.db, owner, threadId, id) ?? saved
  })()
}
