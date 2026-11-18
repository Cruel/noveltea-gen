import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { getThreadChat } from '@/lib/thread-chat.functions'
import { getThreadReview, getThreadReviewDiff, postThreadReviewCorrection } from '@/lib/thread-review.functions'
import type { ReviewSelection } from '@/lib/thread-review.server'

export type ReviewOpen = { scope: ReviewSelection; token: number }

/** Source-backed inspection only. Sending a correction queues a new ordinary
 * Turn; nothing in the Review panel accepts, publishes or approves changes. */
export function ThreadReviewSheet({ threadId, initialScope, open, onOpenChange,
  onInspectRecord, canInspectRecord, onCorrection }: {
  threadId: string; initialScope: ReviewSelection; open: boolean
  onOpenChange: (open: boolean) => void
  onInspectRecord: (id: string) => void; canInspectRecord: (id: string) => boolean
  onCorrection: () => void
}) {
  const client = useQueryClient()
  const [scope, setScope] = useState<ReviewSelection>(initialScope)
  const [path, setPath] = useState<string | null>(null)
  const [hunkIndex, setHunkIndex] = useState<number | null>(null)
  const [annotation, setAnnotation] = useState('')
  const [requestId, setRequestId] = useState(crypto.randomUUID())
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const chat = useQuery({
    queryKey: ['thread-chat', threadId],
    queryFn: () => getThreadChat({ data: threadId }), enabled: open,
  })
  const review = useQuery({
    queryKey: ['thread-review', threadId, scope],
    queryFn: () => getThreadReview({ data: { threadId, scope } }),
    enabled: open, retry: false, staleTime: 0,
  })
  const selected = review.data?.files.find(file => file.path === path)
  const diff = useQuery({
    queryKey: ['thread-review-diff', threadId, scope, path, review.data?.currentSha],
    queryFn: () => getThreadReviewDiff({ data: {
      threadId, scope, path: path!, currentSha: review.data!.currentSha,
    } }),
    enabled: open && !!selected, retry: false, staleTime: 0,
  })
  const content = diff.data && review.data && diff.data.headSha === review.data.headSha
    ? diff.data.diff : null
  const hunks = content?.split(/(?=^@@ )/m).slice(1) ?? []
  const changeScope = (value: string) => {
    setScope(value === 'cumulative' ? { kind: 'cumulative' } : { kind: 'turn', turnId: value })
    setPath(null); setHunkIndex(null); setAnnotation(''); setError(null)
    setRequestId(crypto.randomUUID())
  }
  const selectFile = (next: string) => {
    setPath(next); setHunkIndex(null); setAnnotation(''); setError(null)
    setRequestId(crypto.randomUUID())
  }
  const send = async () => {
    if (!review.data || !selected?.indexed || !content || !annotation.trim() || sending) return
    setSending(true); setError(null)
    try {
      await postThreadReviewCorrection({ data: {
        threadId, scope, path: selected.path, headSha: review.data.headSha,
        currentSha: review.data.currentSha, annotation: annotation.trim(),
        hunkIndex, id: requestId,
      } })
      await client.invalidateQueries({ queryKey: ['thread-chat', threadId] })
      onOpenChange(false)
      onCorrection()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Correction could not be queued.')
    } finally { setSending(false) }
  }
  const visibleTurnIds = chat.data?.turnReceipts.filter(turn =>
    turn.outcome === 'finished' && turn.executions.some(execution =>
      execution.validatedSha && execution.status === 'completed' &&
      execution.queuePhase === 'finished')) ?? []
  return <Sheet open={open} onOpenChange={onOpenChange}>
    <SheetContent side="right" className="w-[min(52rem,96vw)] gap-3 p-4">
      <SheetTitle className="shrink-0 pr-9">Review changes</SheetTitle>
      <p className="m-0 text-xs text-muted-foreground">
        Read-only verified Git differences. No Accept step, approval or publication is performed.
        A correction becomes a new Turn.
      </p>
      <label className="flex shrink-0 flex-wrap items-center gap-2 text-sm">
        Review scope
        <select aria-label="Review scope" value={scope.kind === 'cumulative' ? 'cumulative' : scope.turnId}
          onChange={event => changeScope(event.target.value)}
          className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1.5">
          <option value="cumulative">Unpublished cumulative changes</option>
          {visibleTurnIds.map((turn, index) => <option key={turn.id} value={turn.id}>
            Turn {index + 1}: {turn.effectiveRequest.slice(0, 64)}
          </option>)}
        </select>
      </label>
      <div className="min-h-0 flex-1 overflow-y-auto space-y-3 text-sm">
        {review.isPending && <p role="status">Loading verified review…</p>}
        {review.error && <p role="alert" className="text-destructive">{review.error.message}</p>}
        {review.data && <>
          <p className="m-0 break-all text-xs text-muted-foreground">
            Base <code>{review.data.baseSha}</code>
            {' · '}Verified <code>{review.data.headSha}</code>
            {review.data.publicationSha && <> · Published <code>{review.data.publicationSha}</code></>}
          </p>
          {review.data.files.length === 0 ? <p>No changes in this scope.</p> :
            <div className="grid gap-1" role="group" aria-label="Affected Story files">
              {review.data.files.map(file => <div key={file.path} className="flex min-w-0 items-center gap-1">
                <Button type="button" size="sm" variant={file.path === path ? 'secondary' : 'ghost'}
                  className="h-auto min-w-0 flex-1 justify-start whitespace-normal break-all text-left text-xs"
                  aria-pressed={file.path === path} onClick={() => selectFile(file.path)}>
                  {file.status} · {file.path}{!file.indexed ? ' (unindexed: path only)' : ''}
                </Button>
                {file.recordId && canInspectRecord(file.recordId) &&
                  <Button type="button" size="sm" variant="outline"
                    onClick={() => onInspectRecord(file.recordId!)}>Inspect record</Button>}
              </div>)}
            </div>}
          {selected && <>
            <p className="m-0 text-xs font-medium">Source diff · {selected.path}</p>
            {diff.isPending && <p role="status">Loading verified diff…</p>}
            {diff.error && <p role="alert" className="text-destructive">{diff.error.message}</p>}
            {!selected.indexed && <p className="text-xs text-muted-foreground">
              Unindexed file contents are not exposed. Only the verified path and change status are available.
            </p>}
            {content && <pre aria-label="Verified source diff"
              className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 text-xs">{content}</pre>}
            {content && !chat.data?.archived && <div className="space-y-2 border-t border-border/50 pt-3">
              <label className="block text-xs font-medium">Correction target
                <select aria-label="Correction hunk" value={hunkIndex ?? 'record'}
                  onChange={event => { setHunkIndex(event.target.value === 'record' ? null : Number(event.target.value))
                    setRequestId(crypto.randomUUID()) }}
                  className="mt-1 block w-full rounded-md border border-input bg-background px-2 py-1.5">
                  <option value="record">Whole changed record</option>
                  {hunks.map((hunk, index) => <option key={index} value={index}>
                    {hunk.split('\n')[0]}
                  </option>)}
                </select>
              </label>
              <textarea aria-label="Correction annotation" rows={3} maxLength={1000}
                value={annotation} onChange={event => { setAnnotation(event.target.value)
                  setRequestId(crypto.randomUUID()) }}
                placeholder="Describe what NovelTea Studio should correct in this record or hunk…"
                className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm" />
              <Button type="button" size="sm" disabled={sending || !annotation.trim()}
                onClick={() => void send()}>{sending ? 'Sending correction…' : 'Send correction as new Turn'}</Button>
              {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
            </div>}
          </>}
        </>}
      </div>
    </SheetContent>
  </Sheet>
}
