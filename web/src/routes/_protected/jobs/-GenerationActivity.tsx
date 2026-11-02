import { useEffect, useRef, useState } from 'react'
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
  return <section aria-label="Generation activity">
    <h2>Generation activity</h2>
    <p className="muted">Saved milestones replay across reconnects. Agent tool calls and transcripts are never shown here.</p>
    <p role="status">Latest recorded event: {latest ? description(latest) : 'No generation activity yet.'}
      {' '}<small>({connection})</small></p>
    <ol>{events.map(event => <li key={event.id}>
      <span>{description(event)}</span>
      {event.files.length > 0 && <small> · Story files: {event.files.join(', ')}</small>}
    </li>)}</ol>
  </section>
}
