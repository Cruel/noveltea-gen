import { execFileSync } from 'node:child_process'
import type { StudioDatabase } from '../db/connection'
import { selectedJob, restoreJob, pinnedRequest, inspectRegisteredJob } from './fixture-jobs.server'
import { trustedHead } from '../../../src/revision'
import { validateStoryJob } from '../../../src/validator'
import type { CanonicalScopeRecord } from '../../../src/focused-scope'
import { inferStoryRevision, type RevisionPreview } from './story-revision-plan'
import { enqueueThreadMessage, type ThreadMessage, ThreadChatError } from './thread-chat.server'

type Source = { jobId: string; status: string; queuePhase: string | null }
export type PinnedRevision = {
  sourceJobId: string; sourceSha: string; digest: string
  selectedTargets: string[]; approved: boolean
  contract: RevisionPreview['contract']; writePaths: string[]; contextIds: string[]
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
      JSON.stringify(refreshed.contract) !== JSON.stringify(scope.contract))
    throw new ThreadChatError(409, 'Story impact or protected scope changed since approval; no continuation was started.')
}
function pendingInstruction(store: StudioDatabase, owner: string, threadId: string) {
  return store.sqlite.prepare(`SELECT id,body AS content,phase FROM story_thread_messages
    WHERE owner_user_id=? AND thread_id=? AND role='user'
      AND phase IN ('queued','preparing','running','blocked')
    ORDER BY sequence LIMIT 1`).get(owner, threadId) as
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
  id: string, content: string, selectedTargets?: string[], approvalDigest?: string): Promise<ThreadMessage> {
  const retry = store.sqlite.prepare(`SELECT id,owner_user_id AS owner,thread_id AS threadId,
    body,revision_scope_json AS scope FROM story_thread_messages WHERE id=?`).get(id) as
    { id: string; owner: string; threadId: string; body: string; scope: string | null } | undefined
  if (retry && (retry.owner !== owner || retry.threadId !== threadId || retry.body !== content.trim()))
    throw new ThreadChatError(409, 'Message UUID is already used for another instruction.')
  if (retry?.scope) {
    const pinned = JSON.parse(retry.scope) as PinnedRevision
    if (approvalDigest && approvalDigest !== pinned.digest ||
        selectedTargets && JSON.stringify([...selectedTargets].sort()) !== JSON.stringify(pinned.selectedTargets))
      throw new ThreadChatError(409, 'The retry differs from the saved approved revision scope.')
    return enqueueThreadMessage(store, owner, threadId, id, content)
  }
  const pending = pendingInstruction(store, owner, threadId)
  const live = latestRunStatus(store, owner, threadId)
  // Rapid messages are recorded immediately, without inventing scope at a
  // future HEAD. The first pending message is reviewed only after its source
  // completes. Later queued messages cannot overtake it.
  if ((!retry && (pending || live.status !== 'completed' || live.queuePhase !== 'finished')) ||
      (retry && (pending?.id !== id || live.status !== 'completed' || live.queuePhase !== 'finished'))) {
    if (approvalDigest || selectedTargets)
      throw new ThreadChatError(409, 'A scoped approval cannot be applied before the preceding Story revision completes. Queue the instruction without an approval.')
    return enqueueThreadMessage(store, owner, threadId, id, content)
  }
  const source = latestRun(store, owner, threadId)
  const plan = await revisionFromSource(store, owner, source.jobId, content, selectedTargets)
  if (plan.clarification) throw new ThreadChatError(422, plan.clarification)
  if (plan.reviewRequired && approvalDigest !== plan.digest)
    throw new ThreadChatError(409, 'Review the exact affected Story records and authorize the proposed write paths first.')
  if (approvalDigest && approvalDigest !== plan.digest)
    throw new ThreadChatError(409, 'Story scope changed since review. Inspect the updated proposal.')
  const receipt: PinnedRevision = { sourceJobId: source.jobId, sourceSha: plan.headSha,
    digest: plan.digest, selectedTargets: plan.targets, approved: !!approvalDigest,
    contract: plan.contract, writePaths: plan.writePaths, contextIds: plan.contextIds }
  return store.sqlite.transaction(() => {
    assertHeadOfQueue(store, owner, threadId, retry ? id : undefined)
    const live = latestRun(store, owner, threadId)
    if (live.jobId !== source.jobId)
      throw new ThreadChatError(409, 'Thread source changed during scope review.')
    const message = enqueueThreadMessage(store, owner, threadId, id, content)
    const existing = store.sqlite.prepare(`SELECT revision_scope_json AS scope FROM story_thread_messages
      WHERE id=? AND owner_user_id=? AND thread_id=?`).get(id, owner, threadId) as
      { scope: string | null } | undefined
    if (existing?.scope) {
      if (existing.scope !== JSON.stringify(receipt))
        throw new ThreadChatError(409, 'Message UUID already has a different scope authorization.')
    } else {
      if (message.phase !== 'queued') throw new ThreadChatError(409, 'Revision scope cannot be added after execution began.')
      const changes = store.sqlite.prepare(`UPDATE story_thread_messages SET revision_scope_json=?
        WHERE id=? AND owner_user_id=? AND thread_id=? AND phase='queued' AND revision_scope_json IS NULL`)
        .run(JSON.stringify(receipt), id, owner, threadId).changes
      if (changes !== 1) throw new ThreadChatError(409, 'Revision scope changed during admission.')
    }
    return message
  })()
}
