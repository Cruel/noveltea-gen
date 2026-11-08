import { lazy, Suspense, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog'

// Keep provider preview/server functions out of the initial Thread tree bundle.
const ThreadRestartPreview = lazy(async () => ({
  default: (await import('./thread-restart-preview')).ThreadRestartPreview,
}))

export function ThreadRestartControl({ threadId }: { threadId: string }) {
  const [open, setOpen] = useState(false)
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger title="Restart Thread" aria-label="Restart Thread"
      className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2">
      <RotateCcw className="size-3.5" />
    </DialogTrigger>
    <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
      <DialogTitle>Restart Thread</DialogTitle>
      <Suspense fallback={<p className="text-xs text-muted-foreground">Loading restart options…</p>}>
        <ThreadRestartPreview threadId={threadId} onClose={() => setOpen(false)} />
      </Suspense>
    </DialogContent>
  </Dialog>
}
