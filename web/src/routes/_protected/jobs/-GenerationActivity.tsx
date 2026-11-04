import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type { ProgressEvent } from '../../../lib/generation-progress.server'

function description(event: ProgressEvent) {
  const unit = event.milestone ? 'Milestone ' + event.milestone : event.stage?.replaceAll('-', ' ') ?? 'Story'
  switch (event.kind) {
    case 'started': return 'Generation started'
    case 'working': return 'Working on ' + unit
    case 'verified': return 'Verified ' + unit
    case 'finished': return 'Generation ' + (event.status ?? 'stopped')
    case 'interrupted': return 'Generation interrupted; inspect the saved job before recovery'
  }
}

/** Independent of Git diffs and canonical validation. Only vetted SSE summaries. */
export function GenerationActivity({ jobId, onChanged }: { jobId: string; onChanged: () => void }) {
  const [events, setEvents] = useState<ProgressEvent[]>([])
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'reconnecting'>('connecting')
  const [showAll, setShowAll] = useState(false)
  const callback = useRef(onChanged)
  callback.current = onChanged
  useEffect(() => {
    const source = new EventSource('/api/jobs/' + encodeURIComponent(jobId) + '/events')
    setEvents([])
    setConnection('connecting')
    source.onopen = () => { setConnection('connected'); callback.current() }
    source.onerror = () => setConnection('reconnecting')
    const receive = (raw: MessageEvent<string>) => {
      try {
        const event = JSON.parse(raw.data) as ProgressEvent
        if (!Number.isSafeInteger(event.id) || !Array.isArray(event.files)) return
        setEvents(previous => previous.some(item => item.id === event.id) ? previous :
          [...previous, event].sort((a, b) => a.id - b.id))
        if (event.kind === 'finished' || event.kind === 'interrupted') callback.current()
      } catch { /* never render arbitrary or malformed server payloads */ }
    }
    source.addEventListener('progress', receive)
    return () => source.close()
  }, [jobId])
  const latest = events.at(-1)
  const visible = showAll ? events : events.slice(-8)
  return <section aria-label="Generation activity">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><h2>Generation activity</h2>
        <p className="mt-1 text-xs text-muted-foreground">Verified milestones and status only. No agent transcripts or tool logs.</p></div>
      <Badge variant="outline" className="capitalize">{connection}</Badge>
    </div>
    <p role="status" className="mt-4 text-sm">
      <span className="text-muted-foreground">Latest: </span>
      <strong className="text-foreground">{latest ? description(latest) : 'No activity recorded yet'}</strong>
    </p>
    <ol className="job-timeline">{visible.map(event => <li key={event.id}>
      <span className="font-medium">{description(event)}</span>
      {event.files.length > 0 && <details className="w-full text-xs"><summary className="cursor-pointer text-muted-foreground">
        {event.files.length} Story {event.files.length === 1 ? 'file' : 'files'}
      </summary><ul className="mt-1 space-y-1">{event.files.map(file => <li key={file} className="border-0 p-0"><code>{file}</code></li>)}</ul></details>}
    </li>)}</ol>
    {events.length > 8 && <Button size="sm" variant="ghost" className="mt-3" onClick={() => setShowAll(value => !value)}>
      {showAll ? 'Show recent events' : 'Show all ' + events.length + ' events'}
    </Button>}
  </section>
}
