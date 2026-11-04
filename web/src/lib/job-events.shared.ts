import type { ProgressEvent } from './generation-progress.server'

export type JobEventHistory = { events: ProgressEvent[]; hasMore: boolean }

/** Merge persisted history, SSE replays and older pages without duplicates. */
export function mergeJobEvents(existing: readonly ProgressEvent[], incoming: readonly ProgressEvent[]): ProgressEvent[] {
  if (!incoming.length) return [...existing]
  const byId = new Map(existing.map(event => [event.id, event]))
  for (const event of incoming) byId.set(event.id, event)
  return [...byId.values()].sort((left, right) => left.id - right.id)
}
