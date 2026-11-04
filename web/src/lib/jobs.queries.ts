import { queryOptions } from '@tanstack/react-query'
import { getJob, getJobControls } from './jobs.functions'

export const jobQuery = (id: string) => queryOptions({
  queryKey: ['job', id] as const,
  queryFn: () => getJob({ data: id }),
  staleTime: 5000,
})
export const jobControlsQuery = (id: string) => queryOptions({
  queryKey: ['job-controls', id] as const,
  queryFn: () => getJobControls({ data: id }),
  staleTime: 5000,
})
