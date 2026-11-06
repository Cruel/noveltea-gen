import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { StudioStore as StudioDatabase } from '../persistence/store'
import type { JobStartResult } from '../../../src/job'
import { inspectAuthorUpdates } from '../../../src/author-updates'
import { inspectRecoveryCheckpoints, type RecoveryInspection } from '../../../src/recovery-checkpoints'
import { collectRecoveryFork } from '../../../src/recovery-fork'
import { forkSourceSummary, type RecoveryForkBundle } from '../../../src/recovery-fork-state'
import { forkCachedStory, continueCachedStory, GitCacheError } from './git-cache.server'
import { revisionFromSource } from './story-revision.server'
import { selectedJob, restoreJob, pinnedRequest } from './fixture-jobs.server'
import { snapshotForkBoundaryHistory, recordForkBoundaryHistory, type ForkHistoryMessage } from './thread-fork-history.server'
import type { GenerationDraft } from './generation-config.server'

const SHA = /^[a-f0-9]{40}$/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const unsafeText = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
export class ThreadEditError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
const problem = 'No finalized, verified recovery point predates this instruction. Restart from the original pinned Story source instead; never guess a checkpoint from timestamps.'
type Point = Pick<RecoveryInspection, 'commitSha' | 'eligible' | 'proofDigest' | 'workItem'>
type Message = {
  id: string; threadId: string; sequence: number; role: string; status: string; body: string
  phase: string | null; jobId: string | null; sourceJobId: string | null
  origin: string | null
}
type Intent = {
  owner: string; source: string; base: string; commitSha: string; proofDigest: string | null
  sourceThreadId: string | null; editedMessageId: string | null; editedBody: string | null
  bundle: string; draft: string; history: string | null
}
function git(cwd: string, ...args: string[]) {
  const env = { ...process.env }
  for (const key of ['GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_INDEX_FILE','GIT_PREFIX']) delete env[key]
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}
function ancestor(cwd: string, earlier: string, later: string): boolean {
  if (!SHA.test(earlier) || !SHA.test(later)) return false
  try { git(cwd, 'merge-base', '--is-ancestor', earlier, later); return true }
  catch { return false }
}

/** Exact Git ancestry of the pinned application boundary, never clock time.
 * The latest eligible ancestor is the sole permissible recovery checkpoint. */
export function selectCausalRecoveryPoint<T extends Point>(
  worktreeRoot: string, points: T[], appliedBeforeSha: string): T | null {
  if (!SHA.test(appliedBeforeSha)) return null
  let selected: T | null = null
  for (const point of points) {
    if (!point.eligible || !ancestor(worktreeRoot, point.commitSha, appliedBeforeSha)) continue
    if (!selected) { selected = point; continue }
    if (ancestor(worktreeRoot, selected.commitSha, point.commitSha)) selected = point
    else if (!ancestor(worktreeRoot, point.commitSha, selected.commitSha)) return null
  }
  return selected
}
async function messageRecord(store: StudioDatabase, owner: string, threadId: string, messageId: string): Promise<Message> {
  const row = await store.persistence.advancedThreads.editable(owner, threadId, messageId)
  if (!row) throw new ThreadEditError(404, 'Message not found in this Thread.')
  if (row.role !== 'user' || row.status !== 'delivered' || ![null, 'finished'].includes(row.phase))
    throw new ThreadEditError(409, 'Only a delivered user instruction can be edited into a new Thread.')
  return row
}
function textCheck(original: string, edited: string) {
  if (typeof edited !== 'string' || !edited.trim() || edited.length > 4000 ||
      unsafeText.test(edited) || edited.trim() === original.trim())
    throw new ThreadEditError(400, 'Enter a changed, printable instruction of 1–4000 characters.')
  return edited.trim()
}
async function resolveOriginal(store: StudioDatabase, owner: string, row: Message): Promise<Message> {
  let message = row
  const seen = new Set<string>()
  while (message.origin && !message.origin.startsWith('author-update:') && !message.jobId) {
    if (seen.has(message.id)) throw new ThreadEditError(409, 'Inherited message lineage is cyclic.')
    seen.add(message.id)
    const original = await store.persistence.advancedThreads.origin(owner, message.origin)
    if (!original) break
    if (original.body !== row.body || original.role !== 'user')
      throw new ThreadEditError(409, 'Inherited message provenance changed.')
    message = original
  }
  return message
}
type CausalSource = { sourceJob: JobStartResult; sourceId: string; boundary: string }
async function sourceOf(store: StudioDatabase, owner: string, message: Message): Promise<CausalSource> {
  const original = await resolveOriginal(store, owner, message)
  const owningJob = original.jobId
  if (!owningJob) throw new ThreadEditError(409, 'This historical message has no saved application receipt.')
  let boundary: string
  let sourceId: string
  if (original.origin?.startsWith('author-update:')) {
    // Live Pi steering is acknowledged under the writer lock. Its pinned HEAD
    // is the pre-application boundary, even between two specialist commits.
    const authorJob = await restoreJob(await selectedJob(store, owner, owningJob), owner)
    const updates = await inspectAuthorUpdates(authorJob)
    const id = original.origin.slice('author-update:'.length)
    const record = updates.records.find(item => item.message.id === id)
    const payload = record?.message.payload as { original?: string; text?: string } | undefined
    const body = record?.message.kind === 'idea' ? payload?.original : payload?.text
    if (!record || record.acknowledgement.phase !== 'applied' || !record.acknowledgement.pinned ||
      body !== original.body || record.acknowledgement.pinned.jobId !== owningJob ||
      record.acknowledgement.pinned.threadId !== authorJob.threadId)
      throw new ThreadEditError(409, 'Saved author delivery/application receipt is missing or changed.')
    sourceId = owningJob
    boundary = record.acknowledgement.pinned.headSha
  } else {
    const own = await selectedJob(store, owner, owningJob)
    const pinned = await restoreJob(own, owner)
    const request = pinnedRequest(own, pinned)
    if (!request || request.task !== original.body)
      throw new ThreadEditError(409, 'Original pinned instruction no longer matches the delivered message.')
    // #81 follow-ups have a new job at the exact pre-effect SHA of the previous
    // completed run. The original source job itself contains the checkpoints.
    sourceId = original.sourceJobId ?? owningJob
    boundary = pinned.baseSha
  }
  const sourceJob = await restoreJob(await selectedJob(store, owner, sourceId), owner)
  if (!ancestor(sourceJob.worktreeRoot, boundary, git(sourceJob.worktreeRoot, 'rev-parse', 'HEAD')))
    throw new ThreadEditError(409, 'The saved application boundary is no longer on the source history.')
  return { sourceJob, sourceId, boundary }
}

/** Import only truly applied, source-bound author ideas, not pending proposals
 * or untrusted Pi text. Their original receipt ID remains available for the
 * edit preview; these entries do not assert editorial acceptance. */
export async function syncAppliedAuthorMessages(store: StudioDatabase, owner: string, threadId: string): Promise<void> {
  const runs = (await store.persistence.advancedThreads.runJobs(owner, threadId)).map(jobId => ({ jobId }))
  for (const { jobId } of runs) {
    let job: JobStartResult
    try { job = await restoreJob(await selectedJob(store, owner, jobId), owner) }
    catch { continue }
    const updates = await inspectAuthorUpdates(job)
    for (const { message, acknowledgement } of updates.records) {
      if (message.kind !== 'idea' || acknowledgement.phase !== 'applied' || !acknowledgement.pinned ||
          acknowledgement.pinned.jobId !== jobId || acknowledgement.pinned.threadId !== job.threadId) continue
      const body = (message.payload as { original?: unknown }).original
      if (typeof body !== 'string' || !body.trim() || body.length > 4000 ||
          unsafeText.test(body)) continue
      const id = 'author:' + jobId + ':' + message.id
      await store.persistence.advancedThreads.importAppliedMessage(
        owner, threadId, id, body, message.id, jobId, message.createdAt)
    }
  }
}
export async function previewThreadMessageEdit(store: StudioDatabase, owner: string, threadId: string,
  messageId: string, edited: string, selectedTargets?: string[]) {
  const message = await messageRecord(store, owner, threadId, messageId)
  const proposed = textCheck(message.body, edited)
  const { sourceJob, sourceId, boundary } = await sourceOf(store, owner, message)
  const points = await inspectRecoveryCheckpoints(sourceJob)
  const point = selectCausalRecoveryPoint(sourceJob.worktreeRoot, points, boundary)
  const original = await resolveOriginal(store, owner, message)
  const followup = !!original.sourceJobId && !original.origin?.startsWith('author-update:')
  // A later instruction is NOT a continuation of the previous run's writing
  // authorization. Only the already-verified source HEAD can be used to infer
  // a fresh focused plan; never copy completed full-Story specialist receipts.
  const eligible = !followup || point?.commitSha === sourceJob.headSha
  const revision = followup && point && eligible
    ? await revisionFromSource(store, owner, sourceId, proposed, selectedTargets) : null
  return {
    original: message.body, proposed, threadId, messageId,
    inheritedMessages: { n: await store.persistence.advancedThreads.inheritedCount(
      owner, threadId, message.sequence) },
    sourceJobId: sourceId,
    appliedBeforeSha: boundary,
    revision,
    checkpoint: point && eligible ? { commitSha: point.commitSha, proofDigest: point.proofDigest,
      workItem: point.workItem, completedWorkItems: point.completedWorkItems,
      nextWorkItem: point.nextWorkItem } : null,
    limitation: !eligible ? 'Editing this follow-up needs a finalized checkpoint at the previous run’s exact verified HEAD; older work cannot authorize a guessed revision scope.' : point ? null : problem,
  }
}

/** Reserve the exact edit+checkpoint+history before async Git preparation.
 * Retries with the same child ID cannot change either the edit or source. */
export async function branchEditedThreadMessage(store: StudioDatabase, owner: string,
  data: { threadId: string; messageId: string; edited: string; childId: string;
    commitSha: string; proofDigest: string; selectedTargets?: string[]; approvalDigest?: string }) {
  if (!UUID.test(data.childId) || !SHA.test(data.commitSha) || !/^[a-f0-9]{64}$/.test(data.proofDigest))
    throw new ThreadEditError(400, 'Invalid branch identity or checkpoint proof.')
  const preview = await previewThreadMessageEdit(store, owner, data.threadId, data.messageId,
    data.edited, data.selectedTargets)
  const point = preview.checkpoint
  const revision = preview.revision
  if (revision?.clarification) throw new ThreadEditError(422, revision.clarification)
  if (revision?.protectedChange) throw new ThreadEditError(409,
    'A protected Creative Decision cannot be approved by message editing or a scope digest. Submit the exact change through Thread chat for fresh owner approval.')
  if (revision?.reviewRequired && data.approvalDigest !== revision.digest)
    throw new ThreadEditError(409, 'Review the affected Story records and explicitly approve the exact revised write scope.')
  if (data.approvalDigest && data.approvalDigest !== revision?.digest)
    throw new ThreadEditError(409, 'Edit scope approval is stale or does not match this author instruction.')
  if (!point) throw new ThreadEditError(409, preview.limitation ?? problem)
  if (point.commitSha !== data.commitSha || point.proofDigest !== data.proofDigest)
    throw new ThreadEditError(409, 'Checkpoint application boundary changed; refresh the edit preview.')
  if (data.childId === preview.sourceJobId)
    throw new ThreadEditError(409, 'Child job identity must differ from its parent.')
  const source = await restoreJob(await selectedJob(store, owner, preview.sourceJobId), owner)
  const row = await selectedJob(store, owner, preview.sourceJobId)
  const original = pinnedRequest(row, source)
  if (!original) throw new ThreadEditError(409, 'Source generation contract is no longer pinned.')
  const sourceThread = await store.persistence.advancedThreads.identity(owner, data.threadId)
  const sourceStoryId = sourceThread?.story
  if (!sourceThread || sourceStoryId !== row.storyId)
    throw new ThreadEditError(409, 'Edit source does not belong to this Story.')
  const readIntent = () => store.persistence.advancedThreads.forkIntent(data.childId)
  let intent = await readIntent()
  const matchesMode = (saved: Intent) => {
    try {
      const bundle = JSON.parse(saved.bundle) as { mode?: string; digest?: string }
      return revision ? bundle.mode === 'fresh-revision' && bundle.digest === revision.digest :
        bundle.mode !== 'fresh-revision'
    } catch { return false }
  }
  const matches = (saved: Intent) => saved.owner === owner && saved.source === preview.sourceJobId &&
    saved.base === row.commitSha && saved.commitSha === point.commitSha &&
    saved.proofDigest === point.proofDigest && saved.sourceThreadId === data.threadId &&
    saved.editedMessageId === data.messageId && saved.editedBody === preview.proposed &&
    matchesMode(saved)
  const existing = await store.persistence.advancedThreads.jobClaimed(data.childId)
  if (intent && !matches(intent) || existing && !intent)
    throw new ThreadEditError(409, 'Child identity is already reserved for a different operation.')
  if (!intent) {
    const bundle = revision ? { mode: 'fresh-revision' as const, digest: revision.digest,
      sourceSha: revision.headSha, targets: revision.targets, paths: revision.writePaths } :
      await collectRecoveryFork(source, data.childId, point.commitSha,
        original.contract, original.skillsSource)
    if (!revision && (bundle as RecoveryForkBundle).checkpoint.proofDigest !== point.proofDigest)
      throw new ThreadEditError(409, 'Finalized checkpoint proof changed.')
    const rowMessage = await messageRecord(store, owner, data.threadId, data.messageId)
    const runOrder = rowMessage.jobId
      ? await store.persistence.advancedThreads.runOrder(owner, data.threadId, rowMessage.jobId)
      : null

    const history = await snapshotForkBoundaryHistory(store, owner, data.threadId, source,
      original.task, row.createdAt, point.commitSha, rowMessage.sequence, runOrder ?? undefined)
    const prior = row.configJson ? JSON.parse(row.configJson) as GenerationDraft : null
    const draft: GenerationDraft = {
      version: 1, headSha: point.commitSha, task: preview.proposed,
      contract: revision?.contract ?? (bundle as RecoveryForkBundle).contract,
      model: prior?.model ?? null, limits: prior?.limits ?? {},
    }
    intent = await store.persistence.advancedThreads.reserveFork({
      childId: data.childId, owner, sourceJobId: preview.sourceJobId,
      sourceBaseSha: row.commitSha!, commitSha: point.commitSha,
      bundle: JSON.stringify(bundle), draft: JSON.stringify(draft),
      sourceThreadId: data.threadId, proofDigest: point.proofDigest,
      guidance: '', history: JSON.stringify(history), at: new Date().toISOString(),
      editedMessageId: data.messageId, editedBody: preview.proposed,
    })
    if (!matches(intent)) throw new ThreadEditError(409, 'Child ID is bound to a different edit.')
  }
  const savedBundle = JSON.parse(intent!.bundle) as RecoveryForkBundle | { mode: 'fresh-revision'; digest: string }
  const fresh = 'mode' in savedBundle && savedBundle.mode === 'fresh-revision'
  const child = fresh ? await continueCachedStory(source, data.childId, point.commitSha) :
    await forkCachedStory(source, savedBundle as RecoveryForkBundle)
  const now = new Date().toISOString(), childThread = 'fork:' + child.jobId
  await store.persistence.advancedThreads.registerChild({
    childId: child.jobId, owner, storyId: row.storyId, title: row.title + ' (edited message)',
    baseSha: child.baseSha, conversationId: sourceThread!.conversation,
    parentThreadId: data.threadId, threadId: childThread,
    draft: intent!.draft, at: now, kind: 'edit',
    history: intent!.history ? JSON.parse(intent!.history) as ForkHistoryMessage[] : undefined,
    editedMessageId: data.messageId, editedBody: preview.proposed,
  })
  return { id: child.jobId, threadId: childThread, storyId: row.storyId, checkpoint: point }
}
