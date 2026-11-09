import type { ExplorerIndex } from './story-explorer.server'
import type { ActivityStep } from './thread-activity'

export type ActivityRecordState = 'proposed' | 'working' | 'verified'
export type ActivityRecordHighlights = Record<string, ActivityRecordState>

/** Only exact native-indexed IDs and paths may be highlighted. Pi paths are
 * author-visible proposals, never evidence of current uncommitted edits. */
export function activityHighlights(index: ExplorerIndex | null,
  step: ActivityStep | null): ActivityRecordHighlights {
  if (!index || !step) return {}
  const paths = new Set(step.kind === 'report'
    ? step.detail?.proposedPaths ?? []
    : step.state === 'verified' ? step.files : [])
  const ids = new Set(step.state === 'verified' ? step.detail?.changedRecordIds ?? [] : [])
  const result: ActivityRecordHighlights = {}
  for (const record of index.records) {
    if (paths.has(record.path) || ids.has(record.id)) result[record.id] =
      step.kind === 'report' ? 'proposed' : 'verified'
    else if (step.state === 'working' && record.id === step.milestone)
      result[record.id] = 'working'
  }
  return result
}

/** Selecting a Thread clears hover from any other Thread, even when two runs
 * happen to use an identical record ID or path. */
export function visibleActivityStep(
  hovered: { threadId: string; jobId: string; step: ActivityStep } | null,
  threadId: string | null, activeJobs: readonly string[],
  fallback: { jobId: string; step: ActivityStep } | null): ActivityStep | null {
  if (hovered && hovered.threadId === threadId && activeJobs.includes(hovered.jobId))
    return hovered.step
  if (!fallback || !activeJobs.includes(fallback.jobId)) return null
  return fallback.step
}
