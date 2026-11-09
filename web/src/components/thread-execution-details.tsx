import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getJobEventHistory } from '@/lib/job-events.functions'
import { jobEventsKey, jobEventsQuery, mergeJobEvents, type JobEventHistory } from '@/lib/job-events.queries'
import { jobControlsQuery, jobQuery } from '@/lib/jobs.queries'
import { ExecutionEvidence } from './thread-execution-evidence'
import { Button } from '@/components/ui/button'

export function ThreadExecutionDetails({ jobId }: { jobId: string }) {
  const [open, setOpen] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [olderError, setOlderError] = useState<string | null>(null)
  const client = useQueryClient()
  const { data: job, error: jobError } = useQuery({
    ...jobQuery(jobId), enabled: open,
  })
  const { data: controls, error: controlsError } = useQuery({
    ...jobControlsQuery(jobId), enabled: open,
  })
  const { data: history, error: eventsError } = useQuery({
    ...jobEventsQuery(jobId), enabled: open,
  })
  const loadOlder = async () => {
    const before = history?.events[0]?.id
    if (!before || loadingOlder) return
    setLoadingOlder(true); setOlderError(null)
    try {
      const page = await getJobEventHistory({ data: { jobId, before } })
      client.setQueryData<JobEventHistory>(jobEventsKey(jobId), prior => prior
        ? { events: mergeJobEvents(prior.events, page.events), hasMore: page.hasMore }
        : page)
    } catch (cause) {
      setOlderError(cause instanceof Error ? cause.message : 'Cannot load older execution events.')
    } finally { setLoadingOlder(false) }
  }
  return <details id="thread-execution-details" className="min-w-0 text-xs"
    open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
      Execution Details
    </summary>
    <div className="mt-2 max-h-[50vh] overflow-y-auto break-words rounded-md border border-border/50 bg-background px-3">
      {jobError && <p role="alert">Saved execution is unavailable: {jobError.message}</p>}
      {controlsError && <p role="alert">Usage details are unavailable.</p>}
      {eventsError && <p role="alert">Controller event history is unavailable.</p>}
      {job ? <>
        <ExecutionEvidence job={job} controls={controls}
          events={history?.events} hasMore={history?.hasMore} />
        <Link to="/jobs/$jobId" params={{ jobId }}
          className="mb-3 inline-block text-muted-foreground underline underline-offset-2">
          Open full saved Job/session controls
        </Link>
      </> : !jobError && <p className="py-3">Loading saved execution…</p>}
      {olderError && <p role="alert">{olderError}</p>}
      {history?.hasMore && <Button type="button" size="sm" variant="ghost"
        className="mb-2" disabled={loadingOlder} onClick={() => void loadOlder()}>
        {loadingOlder ? 'Loading…' : 'Load older controller events'}
      </Button>}
    </div>
  </details>
}
