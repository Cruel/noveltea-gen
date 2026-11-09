import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { getThreadPublicationOptions, getThreadPublicationPreview,
  postThreadPublication } from '@/lib/thread-publication.functions'
import type { ThreadPublicationAction } from '@/lib/thread-publication.server'

type Preview = {
  jobId: string; headSha: string; baseSha: string; branch: string
  targetBranch: string; targetSha: string
  validation: string; protection: string; merge: string
  blockers: string[]; canPublish: boolean; diagnostics: unknown[]
  linked: { number: number; url: string; headSha: string } | null
  thread?: { id: string; rootBaseSha: string; passedReviews: number; skippedReviews: number }
}

export function ThreadPublishSheet({ threadId, open, onOpenChange }: {
  threadId: string; open: boolean; onOpenChange: (next: boolean) => void
}) {
  const client = useQueryClient()
  const options = useQuery({
    queryKey: ['thread-publications', threadId],
    queryFn: () => getThreadPublicationOptions({ data: threadId }),
    enabled: open, retry: false,
  })
  const linked = options.data?.publications ?? []
  const [mode, setMode] = useState<ThreadPublicationAction>('update')
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  const action = linked.length ? mode : 'create'
  const linkJobId = selectedJobId && linked.some(item => item.jobId === selectedJobId)
    ? selectedJobId : linked.at(-1)?.jobId
  const [preview, setPreview] = useState<Preview | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const change = (next: ThreadPublicationAction, id?: string) => {
    setMode(next); setSelectedJobId(id ?? null); setPreview(null); setConfirmed(false); setError(null)
  }
  const choice = () => ({
    threadId, action, ...(action === 'update' ? { linkJobId: linkJobId! } : {}),
  })
  const check = async () => {
    setBusy(true); setPreview(null); setConfirmed(false); setError(null)
    try {
      const result = await getThreadPublicationPreview({ data: choice() })
      setPreview(result as Preview)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Publication preview failed.')
    } finally { setBusy(false) }
  }
  const publish = async () => {
    if (!preview || !confirmed) return
    setBusy(true); setError(null)
    try {
      await postThreadPublication({ data: {
        ...choice(), headSha: preview.headSha, targetSha: preview.targetSha,
        allowPartial: preview.blockers.length > 0, confirmed: true,
      } })
      setPreview(null); setConfirmed(false)
      await client.invalidateQueries({ queryKey: ['thread-publications', threadId] })
      await client.invalidateQueries({ queryKey: ['thread-review', threadId] })
      onOpenChange(false)
    } catch (cause) {
      // A remote push/PR may have succeeded before a lost response. No blind replay:
      // require a new preview and reconcile the durable provider receipt.
      setPreview(null); setConfirmed(false)
      setError((cause instanceof Error ? cause.message : 'Publication failed.') +
        ' Refresh the preview before retrying.')
      await client.invalidateQueries({ queryKey: ['thread-publications', threadId] })
    } finally { setBusy(false) }
  }

  return <Sheet open={open} onOpenChange={onOpenChange}>
    <SheetContent side="right" className="min-h-0 overflow-y-auto px-5 pb-6">
      <SheetTitle>Publish verified Thread progress</SheetTitle>
      <p className="text-sm text-muted-foreground">
        Publishing creates or updates a draft review request for exactly one verified Git revision.
        Further Turns, Review Changes, and local corrections never update the remote draft.
      </p>
      {options.isLoading && <p className="text-sm">Loading linked drafts…</p>}
      {options.error && <p role="alert" className="text-sm text-destructive">
        {options.error.message}</p>}
      {linked.length > 0 && <fieldset className="mt-4 grid gap-2 text-sm">
        <legend className="font-medium">Publication destination</legend>
        <label className="flex items-center gap-2">
          <input type="radio" name="publication-mode" checked={action === 'update'}
            onChange={() => change('update')} disabled={busy} />
          Update existing draft (recommended)
        </label>
        {action === 'update' && <select aria-label="Existing draft"
          className="rounded-md border border-input bg-background p-2" disabled={busy}
          value={linkJobId ?? ''} onChange={event => change('update', event.target.value)}>
          {linked.map(item => <option key={item.jobId} value={item.jobId}>
            {item.provider === 'gitlab' ? 'MR' : 'PR'} #{item.number} · {item.headSha.slice(0, 12)}
          </option>)}
        </select>}
        <label className="flex items-center gap-2">
          <input type="radio" name="publication-mode" checked={action === 'create'}
            onChange={() => change('create')} disabled={busy} />
          Create separate draft for independent review
        </label>
      </fieldset>}
      <div className="mt-4">
        <Button size="sm" disabled={busy || options.isLoading || !!options.error ||
            !options.data?.canSelect || action === 'update' && !linkJobId}
          onClick={() => void check()}>{busy ? 'Checking…' : 'Preview publication'}</Button>
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
      {preview && <div className="mt-4 grid gap-3 text-sm">
        <p><strong>Source:</strong> <code>{preview.baseSha}</code> to <code>{preview.headSha}</code></p>
        <p><strong>Remote branch:</strong> <code>{preview.branch}</code></p>
        <p><strong>Upstream:</strong> <code>{preview.targetBranch}</code> at <code>{preview.targetSha}</code></p>
        <p>Native validation: {preview.validation}; protected canon: {preview.protection};
          upstream merge: {preview.merge}</p>
        {preview.thread && <p>Pinned upstream base: <code>{preview.thread.rootBaseSha}</code>.
          Independent semantic reviews passed: {preview.thread.passedReviews}.
          Routine reviews not required: {preview.thread.skippedReviews} (not passed reviews).</p>}
        {preview.linked && <p>Current remote draft:
          <a className="ml-1 underline" href={preview.linked.url}
            target="_blank" rel="noopener noreferrer">#{preview.linked.number}</a>
          {' '}at <code>{preview.linked.headSha}</code></p>}
        {preview.blockers.length > 0 && <div>
          <strong>Review obligations and blockers</strong>
          <ul className="ml-5 list-disc">
            {preview.blockers.map(item => <li key={item}>{item}</li>)}
          </ul>
        </div>}
        {preview.diagnostics.length > 0 && <details>
          <summary>Native diagnostics ({preview.diagnostics.length})</summary>
          <pre className="overflow-x-auto text-xs">{JSON.stringify(preview.diagnostics, null, 2)}</pre>
        </details>}
        {!preview.canPublish && <p role="alert" className="text-destructive">
          This revision is not eligible for external publication.</p>}
        {preview.canPublish && <label className="flex items-start gap-2">
          <Checkbox checked={confirmed} disabled={busy}
            onCheckedChange={next => setConfirmed(next)} />
          <span>I explicitly authorize {action === 'update' ? 'updating this existing draft' :
            'creating a separate draft'} for the exact SHA shown above.
            {preview.blockers.length ? ' I acknowledge the listed non-blocking review obligations.' : ''}</span>
        </label>}
        <Button disabled={busy || !preview.canPublish || !confirmed}
          onClick={() => void publish()}>
          {action === 'update' ? 'Update existing draft' : 'Create separate draft'}
        </Button>
      </div>}
    </SheetContent>
  </Sheet>
}
