import { Suspense, lazy, useState } from 'react'

// Avoid loading generation operations until an author actually opens a Thread.
// The navigation tree stays lightweight and SSR-safe.
const ExpandedThreadTimeline = lazy(async () => ({
  default: (await import('./checkpoint-timeline')).ExpandedThreadTimeline,
}))

export function ThreadExecutionTimeline({ jobId }: { jobId: string }) {
  const [open, setOpen] = useState(false)
  return <details className="ml-7 max-w-full pb-2" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">Execution timeline</summary>
    {open && <Suspense fallback={<p className="text-xs text-muted-foreground">Loading checkpoints…</p>}>
      <ExpandedThreadTimeline jobId={jobId} />
    </Suspense>}
  </details>
}
