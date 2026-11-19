import { useQuery, useQueryClient } from '@tanstack/react-query'
import { jobControlsQuery } from '@/lib/jobs.queries'
import { updateJobControl } from '@/lib/jobs.functions'
import { ThreadRepairContent } from './thread-repair-content'

/** Durable controller Repair ledger projection; private Pi transcripts stay
 * on the server and the author can only submit a source-bound control action. */
export function ThreadRepairStatus({ jobId, status, reason }: {
  jobId: string; status: string; reason?: string | null
}) {
  const queryClient = useQueryClient()
  const { data, error } = useQuery({
    ...jobControlsQuery(jobId),
    refetchInterval: status === 'running' ? 8000 : false,
  })
  if (error) return <p role="alert" className="text-xs text-destructive">
    Repair evidence could not be verified. Integrity recovery must be inspected before another correction.
  </p>
  if (!data) return null
  return <ThreadRepairContent repair={data.repair} status={status} reason={reason}
    queue={data.queue} budgetPause={data.budget.pause?.reason}
    onContinue={async (sourceSha, guidance) => {
      await updateJobControl({ data: {
        jobId, action: 'repair', sourceSha, guidance,
      } })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['job-controls', jobId] }),
        queryClient.invalidateQueries({ queryKey: ['job', jobId] }),
        queryClient.invalidateQueries({ queryKey: ['thread-chat'] }),
      ])
    }} />
}
