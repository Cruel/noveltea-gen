import { queryOptions } from '@tanstack/react-query'
import { getJobEventHistory } from './job-events.functions'
import type { JobEventHistory } from './job-events.shared'
export { mergeJobEvents } from './job-events.shared'
export type { JobEventHistory } from './job-events.shared'

export const jobEventsKey = (jobId: string) => ['job-events', jobId] as const

/** The durable history is hydrated once; SSE owns subsequent freshness.
 * Don't refetch a short initial page over already paginated or streamed data. */
export const jobEventsQuery = (jobId: string) => queryOptions({
  queryKey: jobEventsKey(jobId),
  queryFn: (): Promise<JobEventHistory> => getJobEventHistory({ data: { jobId } }),
  staleTime: Infinity,
})
