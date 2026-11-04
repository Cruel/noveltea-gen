import { lazy, Suspense, useState } from 'react'
import { RotateCcw } from 'lucide-react'

// Keep provider preview/server functions out of the initial Thread tree bundle.
const ThreadRestartPreview = lazy(async () => ({
  default: (await import('./thread-restart-preview')).ThreadRestartPreview,
}))

export function ThreadRestartControl({ threadId }: { threadId: string }) {
  const [open, setOpen] = useState(false)
  return <div className="relative min-w-0">
    <button type="button" title="Restart Thread" aria-label="Restart Thread"
      className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2"
      onClick={() => setOpen(value => !value)}>
      <RotateCcw className="size-3.5" />
    </button>
    {open && <div className="absolute right-0 top-full z-30 mt-2 w-[min(28rem,calc(100vw-2rem))] bg-background shadow-lg">
      <Suspense fallback={<p className="text-xs text-muted-foreground">Loading restart options…</p>}>
        <ThreadRestartPreview threadId={threadId} onClose={() => setOpen(false)} />
      </Suspense>
    </div>}
  </div>
}
