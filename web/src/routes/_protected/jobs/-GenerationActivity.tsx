import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { getJobEventHistory } from '@/lib/job-events.functions'
import {
  jobEventsKey, jobEventsQuery, mergeJobEvents, type JobEventHistory,
} from '@/lib/job-events.queries'
import type { ProgressEvent } from '@/lib/generation-progress.server'
import type { StreamConnection } from '@/hooks/use-job-event-stream'

export function progressDescription(event: ProgressEvent) {
  const unit = event.milestone ? 'Milestone ' + event.milestone : event.stage?.replaceAll('-', ' ') ?? 'Story'
  switch (event.kind) {
    case 'started': return 'Generation started'
    case 'working': return 'Working on ' + unit
    case 'verified': return 'Verified ' + unit
    case 'finished': return 'Generation ' + (event.status ?? 'stopped')
    case 'interrupted': return 'Generation interrupted; inspect the saved job before recovery'
  }
}

/** Read-only presentation of the job-level TanStack Query event cache.
 * No EventSource or local event array: changing tabs never replays the log. */
export function GenerationActivity({ jobId, connection }: {
  jobId: string; connection: StreamConnection
}) {
  const queryClient = useQueryClient()
  const { data, error: historyError, isPending } = useQuery(jobEventsQuery(jobId))
  const [showAll, setShowAll] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [olderError, setOlderError] = useState<string | null>(null)
  const events = data?.events ?? []
  const latest = events.at(-1)
  const visible = showAll ? events : events.slice(-8)

  const loadOlder = async () => {
    const before = events[0]?.id
    if (!before || loadingOlder) return
    setLoadingOlder(true); setOlderError(null)
    try {
      const page = await getJobEventHistory({ data: { jobId, before } })
      queryClient.setQueryData<JobEventHistory>(jobEventsKey(jobId), current => {
        if (!current) return { events: page.events, hasMore: page.hasMore }
        return { events: mergeJobEvents(current.events, page.events), hasMore: page.hasMore }
      })
      setShowAll(true)
    } catch (reason) {
      setOlderError(reason instanceof Error ? reason.message : 'Could not load older activity.')
    } finally { setLoadingOlder(false) }
  }

  return <section aria-label="Generation activity">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><h2>Generation activity</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Recorded milestones appear immediately; live updates continue while any job tab is open.
        </p></div>
      <Badge variant="outline" className="capitalize">{connection}</Badge>
    </div>
    {historyError && <p role="alert" className="error">{historyError.message}</p>}
    {olderError && <p role="alert" className="error">{olderError}</p>}
    {isPending && <p>Loading recorded activity…</p>}
    {!isPending && <p role="status" className="mt-4 text-sm">
      <span className="text-muted-foreground">Latest: </span>
      <strong className="text-foreground">{latest ? progressDescription(latest) : 'No activity recorded yet'}</strong>
    </p>}
    <ol className="job-timeline">{visible.map(event => <li key={event.id}>
      <span className="font-medium">{progressDescription(event)}</span>
      {event.files.length > 0 && <details className="w-full text-xs"><summary className="cursor-pointer text-muted-foreground">
        {event.files.length} Story {event.files.length === 1 ? 'file' : 'files'}
      </summary><ul className="mt-1 space-y-1">{event.files.map(file => <li key={file} className="border-0 p-0"><code>{file}</code></li>)}</ul></details>}
    </li>)}</ol>
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {events.length > 8 && <Button size="sm" variant="ghost" onClick={() => setShowAll(value => !value)}>
        {showAll ? 'Show recent events' : 'Show all ' + events.length + ' loaded events'}
      </Button>}
      {data?.hasMore && <Button size="sm" variant="outline" disabled={loadingOlder} onClick={() => void loadOlder()}>
        {loadingOlder ? 'Loading…' : 'Load earlier events'}
      </Button>}
    </div>
  </section>
}
