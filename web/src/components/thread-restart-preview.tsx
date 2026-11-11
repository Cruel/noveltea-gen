import { useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Info, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { getThreadRestartPreview, restartThread, restartAndDiscardThread } from '@/lib/thread-restart.functions'
import { storyNavigationKey } from '@/lib/threads.queries'

function HelpTip({ label, children }: { label: string; children: string }) {
  return <Tooltip>
    <TooltipTrigger render={<button type="button" aria-label={label}
      className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1" />}>
      <Info aria-hidden="true" className="size-3.5" />
    </TooltipTrigger>
    <TooltipContent>{children}</TooltipContent>
  </Tooltip>
}

export function ThreadRestartPreview({ threadId }: { threadId: string }) {
  const navigate = useNavigate()
  const client = useQueryClient()
  const { data, error, isFetching } = useQuery({
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
  const [preparedReplacement, setPreparedReplacement] = useState<{
    storyId: string; threadId: string
  } | null>(null)
  const newer = data?.upstream && data.upstream.sha !== data.originalSha ? data.upstream : null
  // If an upstream option disappears, the implicit original revision remains usable.
  const effectiveMode = newer ? mode : 'original'
  const run = async () => {
    if (!data || busy || (!preparedCleanup && effectiveMode === 'newer' && (!newer ||
      selectedNewer?.sha !== newer.sha || selectedNewer.branch !== newer.branch))) {
      setIssue('The upstream selection changed. Refresh and explicitly select the new revision.'); return
    }
    setBusy(true); setIssue(null)
    try {
      const selection = {
        threadId, childId, sourceJobId: data.sourceJobId,
        originalSha: data.originalSha, mode: effectiveMode,
        selectedSha: effectiveMode === 'newer' ? selectedNewer!.sha : data.originalSha,
        targetBranch: effectiveMode === 'newer' ? selectedNewer!.branch : null,
      }
      const result = discard ? await restartAndDiscardThread({ data: selection })
        : await restartThread({ data: selection })
      await client.invalidateQueries({ queryKey: storyNavigationKey(result.storyId) })
      if (discard && 'cleanup' in result && result.cleanup && typeof result.cleanup === 'object' &&
        'state' in result.cleanup && result.cleanup.state !== 'complete') {
        const message = 'message' in result.cleanup ? String(result.cleanup.message) : 'Retry required.'
        setPreparedCleanup(true)
        setPreparedReplacement({ storyId: result.storyId, threadId: result.threadId })
        setIssue('Old Thread could not be deleted: ' + message)
        return
      }
      await navigate({ to: '/stories/$storyId', params: { storyId: result.storyId },
        search: { thread: result.threadId } })
    } catch (cause) {
      setIssue(cause instanceof Error ? cause.message : 'Restart preparation failed.')
    } finally { setBusy(false) }
  }
  return <div role="group" aria-label="Restart Thread options" className="min-w-0 space-y-3 text-sm">
    {isFetching && <LoaderCircle aria-label="Checking Story revision"
      className="size-3.5 animate-spin motion-reduce:animate-none" />}
    {error && <p role="alert" className="text-destructive">{error.message}</p>}
    {data && <>
      <div className="min-w-0 rounded-md bg-muted/40 px-3 py-2">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Request
          </span>
          <span className="inline-flex shrink-0 items-center gap-1 text-xs">
            <span className="text-muted-foreground">Scope: </span>
            {data.scopeKind === 'full-story' ? 'Entire Story' : 'Selected records'}
            <HelpTip label="About restart scope">
              Restart repeats this request and its original scope. To change either, start a New Thread.
              The replacement is prepared first; generation does not begin automatically.
            </HelpTip>
          </span>
        </div>
        <p className="mt-1 max-h-36 overflow-y-auto whitespace-pre-wrap break-words font-medium">
          {data.task}
        </p>
      </div>
      {newer && <fieldset className="min-w-0 space-y-1.5">
        <legend className="mb-1 text-xs font-medium text-muted-foreground">Story version</legend>
        <label className="flex cursor-pointer items-center gap-2">
          <input type="radio" name={'restart-mode-' + threadId} className="shrink-0"
            checked={mode === 'original'} disabled={busy || preparedCleanup}
            onChange={() => { setMode('original'); setSelectedNewer(null); setChildId(crypto.randomUUID()); setIssue(null) }} />
          <span>Original</span>
          <code className="text-xs text-muted-foreground" title={data.originalSha}>{data.originalSha.slice(0, 12)}</code>
        </label>
        <label className="flex cursor-pointer items-center gap-2">
          <input type="radio" name={'restart-mode-' + threadId} className="shrink-0"
            checked={mode === 'newer'} disabled={busy || preparedCleanup}
            onChange={() => { setMode('newer'); setSelectedNewer(newer); setChildId(crypto.randomUUID()); setIssue(null) }} />
          <span>Latest upstream</span>
          <code className="text-xs text-muted-foreground" title={newer.sha}>{newer.sha.slice(0, 12)}</code>
          <HelpTip label="About restarting from a newer Story version">
            Uses the selected newer upstream commit after checking Story validity and protected decisions.
          </HelpTip>
        </label>
      </fieldset>}
      <div className="flex items-center gap-1">
        <label className="flex cursor-pointer items-center gap-2">
          <input type="checkbox" checked={discard} className="shrink-0"
            disabled={busy || preparedCleanup} onChange={event => setDiscard(event.target.checked)} />
          <span>Delete Old Thread</span>
        </label>
        <HelpTip label="About deleting the old Thread">
          By default, the original Thread stays in the list. If selected, the original is permanently deleted
          only after preparing the replacement. Active or unverified work may delay cleanup;
          the replacement is kept and cleanup can be retried.
        </HelpTip>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" disabled={busy || (!preparedCleanup && effectiveMode === 'newer' && (!newer ||
          selectedNewer?.sha !== newer.sha || selectedNewer.branch !== newer.branch))}
          onClick={() => void run()}>
          {busy ? 'Preparing…' : preparedCleanup ? 'Retry cleanup' : 'Restart'}
        </Button>
      </div>
      {preparedCleanup && <p className="text-xs text-muted-foreground">
        The replacement is ready. Retry cleanup, or{' '}
        {preparedReplacement && <Link className="underline" to="/stories/$storyId"
          params={{ storyId: preparedReplacement.storyId }}
          search={{ thread: preparedReplacement.threadId }}>
          open the replacement Thread
        </Link>}. If you leave this dialog, delete the original using its Thread menu.
      </p>}
      {issue && <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">{issue}</p>}
    </>}
  </div>
}
