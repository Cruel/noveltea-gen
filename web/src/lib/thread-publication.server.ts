import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { inspectRecoveryCheckpoints } from '../../../src/recovery-checkpoints'
import { resolvedCheckpointReviews } from '../../../src/checkpoint-assurance'
import { trustedHead } from '../../../src/revision'
import type { JobStartResult } from '../../../src/job'
import type { StudioStore } from '../persistence/store'
import type { CatalogProvider } from '../persistence/contracts'
import type { PublicationReceipt } from '../persistence/publication-contracts'
import { ThreadMessageConflict } from '../persistence/thread-message-contracts'
import { selectedJob, restoreJob } from './fixture-jobs.server'
import { readThreadChat } from './thread-chat.server'
import { PublicationFailure } from './publication-review.server'

const SHA = /^[a-f0-9]{40}$/i
export type ThreadPublicationAction = 'create' | 'update'
export type ThreadPublicationChoice = {
  threadId: string; action: ThreadPublicationAction; linkJobId?: string
}
export type ThreadPublicationLink = {
  jobId: string; receipt: PublicationReceipt
}
export type ThreadPublicationSelection = {
  threadId: string; job: JobStartResult; provider: CatalogProvider; headSha: string
  rootBaseSha: string
  recordJobId: string; remoteBranch: string
  linked: ThreadPublicationLink | null; publications: ThreadPublicationLink[]
  /** A skipped routine review is not a semantic pass. */
  review: { passed: number; skipped: number }
}

export async function resolveThreadPublication(store: StudioStore, owner: string,
  choice: ThreadPublicationChoice): Promise<ThreadPublicationSelection> {
  const chat = await readThreadChat(store, owner, choice.threadId).catch(error => {
    if (error instanceof ThreadMessageConflict)
      throw new PublicationFailure(error.status, error.message)
    throw error
  })
  if (chat.archived || !chat.runs.length)
    throw new PublicationFailure(409, 'This Thread cannot publish without an active verified history.')
  const lastRun = chat.runs.at(-1)!
  if (lastRun.status !== 'completed' || lastRun.queuePhase !== 'finished')
    throw new PublicationFailure(409, 'Wait for a completed, verified Turn before publishing.')
  const eligible = chat.turnReceipts.flatMap(turn =>
    turn.outcome === 'finished' ? turn.executions.filter(execution =>
      execution.status === 'completed' && execution.queuePhase === 'finished' &&
      SHA.test(execution.validatedSha ?? '')) : [])
  const current = eligible.at(-1)
  if (!current || current.jobId !== lastRun.jobId)
    throw new PublicationFailure(409, 'Latest Thread revision lacks a finished, validated Turn receipt.')

  const row = await selectedJob(store, owner, current.jobId)
  if (row.storyId !== chat.storyId || !['github', 'gitlab'].includes(row.provider))
    throw new PublicationFailure(409, 'Thread repository ownership or provider changed.')
  const provider = row.provider as CatalogProvider
  const rootRow = await selectedJob(store, owner, chat.runs[0]!.jobId)
  if (rootRow.storyId !== chat.storyId || rootRow.provider !== provider)
    throw new PublicationFailure(409, 'Thread upstream repository identity has changed.')
  const firstJob = await restoreJob(rootRow, owner)
  // A fork's first Job starts at its parent's private checkpoint, not at the
  // repository default branch. The Story import pins the true upstream base
  // shared by every Thread and prevents misclassifying safe fork revisions.
  const canonical = await store.persistence.naturalStory.story(owner, chat.storyId)
  if (!canonical || canonical.provider !== provider ||
      canonical.providerId !== row.providerId || canonical.directory !== row.directory)
    throw new PublicationFailure(409, 'Pinned Story repository identity has changed.')
  const rootBaseSha = canonical.headSha ?? firstJob.baseSha
  if (!SHA.test(rootBaseSha))
    throw new PublicationFailure(409, 'Pinned Story upstream baseline is unavailable.')
  const job = await restoreJob(row, owner)
  if (job.headSha !== current.validatedSha || await trustedHead(job) !== current.validatedSha)
    throw new PublicationFailure(409, 'Saved Thread revision differs from its verified Git HEAD.')

  const publications: ThreadPublicationLink[] = []
  for (const run of chat.runs) {
    const receipt = await store.persistence.publications.get(owner, run.jobId, provider)
    if (receipt) publications.push({ jobId: run.jobId, receipt })
  }
  // Never create another remote branch while a previous push/PR intent has an
  // uncertain outcome. The operator must reconcile the original job first.
  const pending = publications.find(item => item.receipt.phase === 'pending' &&
    (choice.action === 'update' || item.jobId !== current.jobId))
  if (pending) throw new PublicationFailure(409,
    'An earlier publication is pending. Reconcile its remote branch before creating another.')
  const linked = choice.action === 'update'
    ? publications.find(item => item.jobId === choice.linkJobId && item.receipt.phase === 'linked') ?? null
    : null
  if (choice.action === 'update' && !linked)
    throw new PublicationFailure(409, 'Choose an existing linked draft to update.')
  if (choice.action === 'create' && publications.some(item => item.jobId === current.jobId &&
      item.receipt.phase === 'pending' && item.receipt.headSha !== current.validatedSha))
    throw new PublicationFailure(409, 'A pending publication pins another checkpoint. Reconcile the original push before retrying.')
  if (choice.action === 'create' && publications.some(item => item.jobId === current.jobId &&
      item.receipt.phase === 'linked' && item.receipt.headSha !== current.validatedSha))
    throw new PublicationFailure(409, 'This checkpoint already has a draft. Update it or advance the Thread first.')

  // Review assurance is derived from trusted controller checkpoints in each
  // completed execution, not from the UI, Pi's prose, or a job-level "completed"
  // flag. A required pending/failed/invalid review always vetoes publication.
  let passed = 0, skipped = 0
  for (const run of chat.runs) {
    const saved = await selectedJob(store, owner, run.jobId)
    if (saved.storyId !== chat.storyId)
      throw new PublicationFailure(409, 'Thread revision lineage changed.')
    const work = await restoreJob(saved, owner)
    const points = await inspectRecoveryCheckpoints(work)
    // The controller records authentic repair chains without rewriting
    // historical failed verdicts. Use the same exact repair-coverage proof as
    // execution admission; never treat an unrelated later pass as clearance.
    const cleared = await resolvedCheckpointReviews(work, points)
    if (points.some(point => !point.eligible ||
        ['failed', 'required-pending'].includes(cleared.get(point.commitSha) ?? point.semanticReview)))
      throw new PublicationFailure(409, 'A mandatory semantic review is pending, failed or has invalid controller evidence.')
    if (existsSync(join(work.stateDir, 'turn-plan.json')) &&
        (!points.length || points.some(point => point.semanticReview === 'untracked')))
      throw new PublicationFailure(409, 'Planned specialist changes lack verifiable semantic review selection.')
    passed += points.filter(point => point.semanticReview === 'passed').length
    skipped += points.filter(point => point.semanticReview === 'not-required').length
  }
  if (await trustedHead(job) !== current.validatedSha)
    throw new PublicationFailure(409, 'Thread HEAD changed while reviewing publication evidence.')
  return {
    threadId: choice.threadId, rootBaseSha, job, provider, headSha: current.validatedSha!,
    recordJobId: linked?.jobId ?? job.jobId,
    remoteBranch: linked?.receipt.remoteBranch ?? job.branch,
    linked, publications, review: { passed, skipped },
  }
}
