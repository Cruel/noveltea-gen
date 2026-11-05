import { useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { LoaderCircle, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { getThreadEditPreview, postThreadEditFork } from '@/lib/thread-chat.functions'
import { storyNavigationKey } from '@/lib/threads.queries'

type Preview = Awaited<ReturnType<typeof getThreadEditPreview>>
export function ThreadMessageEdit({ threadId, storyId, messageId, original, originalJobId }: {
  threadId: string; storyId: string; messageId: string; original: string; originalJobId: string | null
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [edited, setEdited] = useState(original)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [selectedTargets, setSelectedTargets] = useState<string[] | undefined>(undefined)
  const [candidateTargets, setCandidateTargets] = useState<string[]>([])
  const [childId, setChildId] = useState(() => crypto.randomUUID())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const revise = (text: string) => {
    setEdited(text)
    setPreview(null)
    setSelectedTargets(undefined)
    setError(null)
    setChildId(crypto.randomUUID())
  }
  const inspect = async (targets?: string[]) => {
    setBusy(true)
    setError(null)
    try {
      const next = await getThreadEditPreview({ data: {
        threadId, messageId, edited, ...(targets ? { selectedTargets: targets } : {}) } })
      setPreview(next)
      setSelectedTargets(targets)
      if (!targets) setCandidateTargets(next.revision?.targets ?? [])
    } catch (cause) {
      setPreview(null)
      setError(cause instanceof Error ? cause.message : 'Unable to verify a causal checkpoint.')
    } finally { setBusy(false) }
  }
  const fork = async () => {
    if (!preview?.checkpoint) return
    setBusy(true)
    setError(null)
    try {
      const child = await postThreadEditFork({ data: {
        threadId, messageId, edited: preview.proposed, childId,
        commitSha: preview.checkpoint.commitSha, proofDigest: preview.checkpoint.proofDigest,
        ...(selectedTargets ? { selectedTargets } : {}),
        ...(preview.revision?.reviewRequired ? { approvalDigest: preview.revision.digest } : {}),
      } })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: storyNavigationKey(storyId) }),
        queryClient.invalidateQueries({ queryKey: ['thread-chat', threadId] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ])
      await navigate({ to: '/jobs/$jobId', params: { jobId: child.id } })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Edited branch could not be prepared.')
    } finally { setBusy(false) }
  }
  return <div className="mt-2">
    <Button size="sm" variant="ghost" className="h-6 px-1 text-xs" type="button"
      aria-label="Edit message into a new Thread" disabled={busy}
      onClick={() => setOpen(value => !value)}>
      <Pencil className="mr-1 size-3" />{open ? 'Close edit' : 'Edit as new Thread'}
    </Button>
    {open && <div className="mt-2 space-y-2 border-t border-border/60 pt-2 text-xs">
      <p className="font-medium">Branch from this instruction</p>
      <p className="text-muted-foreground">Original message (unchanged in parent):</p>
      <p className="whitespace-pre-wrap break-words rounded bg-muted/30 p-2">{original}</p>
      <label className="block font-medium" htmlFor={'thread-edit-' + messageId}>Corrected instruction</label>
      <Textarea id={'thread-edit-' + messageId} aria-label="Corrected instruction"
        rows={3} maxLength={4000} value={edited} disabled={busy}
        onChange={event => revise(event.target.value)} />
      <Button type="button" size="sm" variant="outline" disabled={busy || !edited.trim() || edited.trim() === original.trim()}
        onClick={() => void inspect()}>
        {busy ? <LoaderCircle className="mr-1 size-3 animate-spin motion-reduce:animate-none" /> : null}
        Preview causal branch
      </Button>
      {preview && <div className="space-y-2">
        <p><strong>Proposed edit:</strong> {preview.proposed}</p>
        {preview.checkpoint ? <>
          <p>Pre-application checkpoint: <code className="break-all">{preview.checkpoint.commitSha}</code></p>
          <p>Finalized work: {preview.checkpoint.workItem}.
            Later parent messages and commits are not copied into the child.</p>
          {preview.revision ? <div className="space-y-1">
            <p className="font-semibold">New independently executable revision scope</p>
            <p>{preview.revision.clarification ??
              'The edited follow-up gets a fresh execution plan, not the previous completed full-Story work.'}</p>
            {candidateTargets.map(target => <label key={target} className="flex items-center gap-2">
              <input type="checkbox" checked={(selectedTargets ?? candidateTargets).includes(target)}
                disabled={busy} onChange={event => {
                  const targets = event.target.checked
                    ? [...(selectedTargets ?? candidateTargets), target]
                    : (selectedTargets ?? candidateTargets).filter(id => id !== target)
                  if (targets.length) void inspect(targets)
                }} />{target}
            </label>)}
            <p>Writable files: {preview.revision.writePaths.join(', ')}</p>
            <p>Other context remains read-only. Protected choices require separate authorization.</p>
          </div> : null}
          <p>Child starts at this verified checkpoint with its own prepared run and fresh budget.
            Review its settings before selecting Run; the parent stays unchanged.</p>
          <Button type="button" size="sm" disabled={busy || !!preview.revision?.clarification}
            onClick={() => void fork()}>
            {busy ? 'Preparing child…' : preview.revision?.reviewRequired
              ? 'Approve scoped edit and create Thread' : 'Create edited child Thread'}
          </Button>
        </> : <div role="status" className="space-y-1 text-muted-foreground">
          <p>{preview.limitation}</p>
          <Link to="/jobs/$jobId" params={{ jobId: preview.sourceJobId }}>
            Inspect the original pinned source for restart
          </Link>
        </div>}
      </div>}
      {error && <div role="alert" className="space-y-1 text-destructive">
        <p className="whitespace-pre-line">{error}</p>
        {originalJobId && <Link to="/jobs/$jobId" params={{ jobId: originalJobId }}>
          Inspect original pinned source for restart
        </Link>}
      </div>}
    </div>}
  </div>
}
