/** Read-only certification of an exact, finalized recovery lineage.
 * The original first Turn remains authoritative; each continuation has a
 * separate Job, pin, verified Git baseline, and controller-owned proof.
 */
import type { JobStartResult } from './job.js'
import { startStoryJob } from './job.js'
import { inspectRecoveryCheckpoints } from './recovery-checkpoints.js'
import { readRecoveryFork } from './recovery-fork-state.js'
import type { NewStoryEvidence } from './new-story-certification.js'

export async function verifyCertifiedRecoveryLineage(source: JobStartResult,
  terminal: JobStartResult): Promise<NewStoryEvidence['lineage']> {
  if (source.jobId === terminal.jobId) return undefined
  const seen = new Set([terminal.jobId])
  const hops: NonNullable<NewStoryEvidence['lineage']>['hops'] = []
  let child = terminal
  while (child.jobId !== source.jobId) {
    if (hops.length >= 16) throw new Error('Checkpoint lineage exceeds the bounded certification depth.')
    const fork = readRecoveryFork(child)
    if (!fork || !fork.sourceJobId || seen.has(fork.sourceJobId))
      throw new Error('Terminal execution is not descended from the original verified Story Job.')
    if (fork.storyRoot !== source.storyRoot || child.baseSha !== fork.checkpoint.commitSha)
      throw new Error('Checkpoint lineage changed the original Story or fork Git baseline.')
    const parent = await startStoryJob({ story: source.storyRoot, job: fork.sourceJobId }, false)
    if (parent.baseSha !== fork.sourceBaseSha || fork.checkpoint.jobId !== parent.jobId ||
        parent.storyRoot !== source.storyRoot)
      throw new Error('Checkpoint lineage source identity differs from its controller-owned parent.')
    const points = await inspectRecoveryCheckpoints(parent)
    const point = points.find(p => p.eligible && p.commitSha === fork.checkpoint.commitSha &&
      p.proofDigest === fork.checkpoint.proofDigest && p.workItem === fork.checkpoint.workItem &&
      p.planDigest === fork.checkpoint.planDigest &&
      JSON.stringify(p.completedWorkItems) === JSON.stringify(fork.checkpoint.completedWorkItems))
    if (!point) throw new Error('A claimed inherited checkpoint is no longer independently verifiable.')
    hops.unshift({ sourceJobId: parent.jobId, childJobId: child.jobId,
      sourceBaseSha: parent.baseSha, checkpointSha: point.commitSha,
      proofDigest: point.proofDigest, verified: true })
    child = parent
    seen.add(child.jobId)
  }
  return { originalJobId: source.jobId, originalSourceSha: source.baseSha,
    terminalJobId: terminal.jobId, hops }
}
