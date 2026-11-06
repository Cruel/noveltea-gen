import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getThreadRestartPreview, restartThread, restartAndDiscardThread } from '@/lib/thread-restart.functions'
import { storyNavigationKey } from '@/lib/threads.queries'

export function ThreadRestartPreview({ threadId, onClose }: { threadId: string; onClose: () => void }) {
  const navigate = useNavigate()
  const client = useQueryClient()
  const { data, error, isFetching, refetch } = useQuery({
    queryKey: ['thread-restart-preview', threadId],
    queryFn: () => getThreadRestartPreview({ data: threadId }),
    staleTime: 0, refetchOnMount: 'always',
  })
  const [mode, setMode] = useState<'original' | 'newer'>('original')
  const [selectedNewer, setSelectedNewer] = useState<{ branch: string; sha: string } | null>(null)
  const [childId, setChildId] = useState(() => crypto.randomUUID())
  const [busy, setBusy] = useState(false)
  const [discard, setDiscard] = useState(false)
  const [issue, setIssue] = useState<string | null>(null)
  const [preparedCleanup, setPreparedCleanup] = useState(false)
  const [preparedId, setPreparedId] = useState<string | null>(null)
  const newer = data?.upstream && data.upstream.sha !== data.originalSha ? data.upstream : null
  const run = async () => {
    if (!data || busy || (!preparedCleanup && mode === 'newer' && (!newer ||
      selectedNewer?.sha !== newer.sha || selectedNewer.branch !== newer.branch))) {
      setIssue('The upstream selection changed. Refresh and explicitly select the new revision.'); return
    }
    setBusy(true); setIssue(null)
    try {
      const selection = {
        threadId, childId, sourceJobId: data.sourceJobId,
        originalSha: data.originalSha, mode,
        selectedSha: mode === 'newer' ? selectedNewer!.sha : data.originalSha,
        targetBranch: mode === 'newer' ? selectedNewer!.branch : null,
      }
      const result = discard ? await restartAndDiscardThread({ data: selection })
        : await restartThread({ data: selection })
      await client.invalidateQueries({ queryKey: storyNavigationKey(result.storyId) })
      if (discard && 'cleanup' in result && result.cleanup && typeof result.cleanup === 'object' &&
        'state' in result.cleanup && result.cleanup.state !== 'complete') {
        const message = 'message' in result.cleanup ? String(result.cleanup.message) : 'Retry required.'
        setPreparedCleanup(true)
        setPreparedId(result.id)
        setIssue('Replacement Thread ' + result.threadId + ' was prepared, but old Thread cleanup is ' + result.cleanup.state + ': ' + message + ' Retry here, or use Retry Thread cleanup in Conversations after the original writer has stopped.')
        return
      }
      await navigate({ to: '/jobs/$jobId', params: { jobId: result.id } })
    } catch (cause) {
      setIssue(cause instanceof Error ? cause.message : 'Restart preparation failed.')
    } finally { setBusy(false) }
  }
  return <div role="group" aria-label="Restart Thread options"
    className="min-w-0 rounded-md border border-border p-3 text-xs">
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <strong className="text-sm">Prepare a restart</strong>
      <Button type="button" variant="ghost" size="xs" onClick={onClose}>Close</Button>
    </div>
    {isFetching && <LoaderCircle aria-label="Refreshing restart revision" className="size-3.5 animate-spin motion-reduce:animate-none" />}
    {error && <p role="alert" className="text-destructive">{error.message}</p>}
    {data && <>
      <p className="mb-2 text-muted-foreground">Source: {data.provider} · {data.repository}. The existing Thread and its running work remain unchanged.</p>
      <label className="mb-2 flex cursor-pointer items-start gap-2">
        <input type="radio" name={'restart-mode-' + threadId} checked={mode === 'original'}
          disabled={busy || preparedCleanup} onChange={() => { setMode('original'); setSelectedNewer(null); setChildId(crypto.randomUUID()); setIssue(null) }} />
        <span><strong>Original Story revision (default)</strong>
          <code className="mt-0.5 block break-all">{data.originalSha}</code>
          <span className="text-muted-foreground">Replay the original author request from its pinned Story commit.</span>
        </span>
      </label>
      <label className="mb-2 flex cursor-pointer items-start gap-2">
        <input type="radio" name={'restart-mode-' + threadId} checked={mode === 'newer'}
          disabled={busy || preparedCleanup || !newer} onChange={() => { setMode('newer'); setSelectedNewer(newer); setChildId(crypto.randomUUID()); setIssue(null) }} />
        <span><strong>Explicitly select newer upstream revision</strong>
          {newer ? <>
            <span className="block text-muted-foreground">Branch: {newer.branch}</span>
            <code className="block break-all">{newer.sha}</code>
            <span className="text-muted-foreground">Requires renewed Story, scope, tool and protected-decision validation. Changes to protected canon are refused until separately reviewed.</span>
          </> : <span className="block text-muted-foreground">{data.upstreamError ?? 'No different upstream revision available.'}</span>}
        </span>
      </label>
      <label className="mb-2 flex items-start gap-2 text-muted-foreground">
        <input type="checkbox" checked={discard} disabled={busy || preparedCleanup}
          onChange={event => setDiscard(event.target.checked)} />
        <span><strong>Restart and discard old Thread</strong> — prepare and verify a replacement first, then permanently delete eligible old resources. Active writers must stop at a safe boundary; dirty work and unresolved dependencies are preserved. Cleanup can require a retry.</span>
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" disabled={busy || (!preparedCleanup && mode === 'newer' && (!newer ||
          selectedNewer?.sha !== newer.sha || selectedNewer.branch !== newer.branch))}
          onClick={() => void run()}>
          {busy ? 'Preparing…' : discard ? 'Restart and discard old Thread' : 'Create prepared restart Thread'}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={busy || isFetching || preparedCleanup}
          onClick={() => { setMode('original'); setSelectedNewer(null);
            setChildId(crypto.randomUUID()); void refetch(); setIssue(null) }}>
          Refresh upstream
        </Button>
      </div>
      {preparedCleanup && <p className="mt-2 text-muted-foreground">Replacement identity is pinned. Retry cleanup without refreshing or changing the selection. {preparedId && <a className="underline" href={'/jobs/' + encodeURIComponent(preparedId)}>Open prepared replacement</a>}</p>}
      <p className="mt-2 text-muted-foreground">After preparation, review the task, model and budget, then explicitly Run. {discard ? 'Permanent cleanup is irreversible and may remain pending until the old writer stops.' : 'The old Thread is not deleted.'}</p>
      {issue && <p role="alert" className="mt-2 whitespace-pre-wrap text-destructive">{issue}</p>}
    </>}
  </div>
}
