import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, CheckCircle2, Clock3, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { authorInteractionsQuery } from '@/lib/author.queries'
import { isAuthorState } from '@/lib/author-state'
import { runAttentionText } from '@/lib/thread-attention'
import { updateJobControl } from '@/lib/jobs.functions'
import { jobQuery } from '@/lib/jobs.queries'
import { CheckpointContinueAction } from './checkpoint-timeline'
import { startConfiguredGeneration } from '@/lib/generation.functions'
import { AuthorInteractions } from '../routes/_protected/jobs/-AuthorInteractions'

type Run = { jobId: string; status: string; queuePhase: string | null }

/** Read-only status projection plus existing owner-scoped controls. The cards
 * never infer approvals, replay a specialist or manufacture a checkpoint. */
export function ThreadRunAttention({ run }: { run: Run }) {
  const queryClient = useQueryClient()
  const inspectable = ['prepared', 'blocked', 'interrupted', 'paused', 'completed', 'cancelled'].includes(run.status)
  const { data: job, error } = useQuery({ ...jobQuery(run.jobId), enabled: inspectable })
  const sourceJobId = job?.forkSource?.jobId ?? ''
  const { data: sourceJob, isPending: sourcePending } = useQuery({
    ...jobQuery(sourceJobId), enabled: inspectable && !!sourceJobId &&
      !job?.recoveryCheckpoints.some(point => point.eligible),
  })
  const { data: cachedAuthorState, error: authorError } = useQuery({
    ...authorInteractionsQuery(run.jobId),
    enabled: run.status === 'paused' || run.status === 'blocked',
  })
  const authorState = isAuthorState(cachedAuthorState) ? cachedAuthorState : null
  const [busy, setBusy] = useState(false)
  const [controlError, setControlError] = useState<string | null>(null)
  const [showEvidence, setShowEvidence] = useState(false)
  const pendingDecision = authorState?.choice?.phase === 'awaiting-author' ||
    authorState?.items?.some(item => item.phase === 'awaiting-author') ||
    authorState?.decisions?.some(item => item.phase === 'awaiting-author' || item.phase === 'applying')
  const startPrepared = async () => {
    if (!job?.task || !job.contract) return
    setBusy(true); setControlError(null)
    try {
      await startConfiguredGeneration({ data: { jobId: run.jobId, requestJson:
        JSON.stringify({ task: job.task, contract: job.contract }) } })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['thread-chat'] }),
        queryClient.invalidateQueries({ queryKey: ['job', run.jobId] }),
      ])
    } catch (cause) {
      setControlError(cause instanceof Error ? cause.message : 'Cannot start this continuation.')
    } finally { setBusy(false) }
  }
  const action = async (type: 'resume') => {
    setBusy(true); setControlError(null)
    try {
      await updateJobControl({ data: { jobId: run.jobId, action: type } })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['thread-chat'] }),
        queryClient.invalidateQueries({ queryKey: ['job', run.jobId] }),
        queryClient.invalidateQueries({ queryKey: ['job-controls', run.jobId] }),
      ])
    } catch (cause) {
      setControlError(cause instanceof Error ? cause.message : 'Could not resume this run.')
    } finally { setBusy(false) }
  }

  if (run.status === 'running' || run.status === 'queued') return <div role="status"
    className="flex items-center gap-2 text-xs text-muted-foreground">
    <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />
    {run.status === 'queued' ? 'Waiting for a generation slot…' : 'NovelTea is working…'}
  </div>

  if (!inspectable) return null
  if (error) return <div role="alert" className="rounded-md border border-border/60 p-3 text-sm">
    Run status is unavailable. <Link to="/jobs/$jobId" params={{ jobId: run.jobId }}>Inspect saved run</Link>.
  </div>
  if (!job) return <div role="status" className="text-xs text-muted-foreground">Loading run status…</div>

  const blocked = ['blocked', 'interrupted', 'failed'].includes(job.status)
  const point = job.recoveryCheckpoints.filter(checkpoint => checkpoint.eligible).at(-1)
  const sourcePoint = sourceJob?.recoveryCheckpoints.find(checkpoint =>
    checkpoint.eligible && checkpoint.commitSha === job.forkSource?.commitSha)
  const retryGuidanceMarker = '\n\nCorrective guidance for this continuation:\n'
  const retryGuidance = job.task?.includes(retryGuidanceMarker)
    ? job.task.slice(job.task.lastIndexOf(retryGuidanceMarker) + retryGuidanceMarker.length)
    : ''
  const retryableContinuation = blocked && !point && !!sourcePoint && !!sourceJob
  const verified = job.completedStages.filter(stage =>
    /committed|verified|completed|finished|success/.test(stage.status))
  return <section aria-label="Generation status and next steps"
    className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-3 text-sm">
    <div className="flex items-center gap-2">
      {blocked ? <AlertCircle className="size-4 shrink-0 text-amber-500" /> :
        job.status === 'completed' ? <CheckCircle2 className="size-4 shrink-0 text-emerald-500" /> :
          <Clock3 className="size-4 shrink-0 text-muted-foreground" />}
      <strong>{retryableContinuation ? 'Generation could not start' :
        blocked ? 'Generation stopped' :
        job.status === 'completed' ? 'Generation finished' :
          job.status === 'paused' ? 'Generation paused' :
            job.status === 'prepared' ? 'Ready to generate' :
              job.status === 'cancelled' ? 'Run cancelled' : 'Generation status'}</strong>
    </div>
    <p className="whitespace-pre-wrap break-words text-sm">
      {retryableContinuation
        ? 'A setup check failed. Your previous instruction and verified Story checkpoint are preserved.'
        : runAttentionText(job.status, job.reason)}
    </p>
    {!!verified.length && <p className="text-xs text-muted-foreground">
      {verified.length} verified {verified.length === 1 ? 'stage' : 'stages'} preserved.
    </p>}
    {job.recovery && <div className="space-y-2 text-sm">
      <p>Unverified specialist files require manual reconciliation. They cannot be automatically retried or published.</p>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">Recovery instructions</summary>
        <p className="mt-2 whitespace-pre-wrap">{job.recovery.guidance}</p>
        {job.recovery.files.length > 0 && <p>Files: {job.recovery.files.join(', ')}</p>}
      </details>
    </div>}
    {job.status === 'prepared' && <p className="text-xs text-muted-foreground">
      {job.forkSource ? 'The continuation is prepared, but generation has not started yet.' :
        'Configure this Thread before its first run.'}
    </p>}
    {(job.status === 'paused' || blocked) && <AuthorInteractions jobId={run.jobId} presentation="chat"
      onChanged={() => {
        void queryClient.invalidateQueries({ queryKey: ['job', run.jobId] })
        void queryClient.invalidateQueries({ queryKey: ['thread-chat'] })
      }} />}
    {job.status === 'prepared' && (job.forkSource && job.task && job.contract
      ? <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" onClick={() => void startPrepared()} disabled={busy}>
            {busy ? 'Starting…' : 'Start prepared continuation'}
          </Button>
          <Link to="/settings" className="text-xs text-muted-foreground underline-offset-2 hover:underline">
            Check model connection
          </Link>
        </div>
      : <Link to="/jobs/$jobId" params={{ jobId: run.jobId }}>
        Configure initial generation
      </Link>)}
    {job.status === 'paused' && <Button size="sm" disabled={busy || !!pendingDecision || !authorState}
      onClick={() => void action('resume')}>
      {busy ? 'Continuing…' : 'Continue generation'}
    </Button>}
    {blocked && point && <div className="space-y-1">
      <p className="text-xs text-muted-foreground">
        A verified checkpoint is available after {point.workItem.replaceAll('-', ' ')}.
        The completed work stays intact; recovery starts a new isolated run in this same Thread.
      </p>
      <CheckpointContinueAction job={job} point={point}
        suggestedGuidance={/Foundation specialist did not edit canonical Markdown/i.test(job.reason ?? '')
          ? 'The previous foundations specialist finished without writing canonical Story files. ' +
            'Complete the required World Entity and Fact records supported by the existing Story, ' +
            'then establish the Characters and their Relationship before writing the requested dialogue. ' +
            'Validate every change. If a required record cannot be created without inventing unsupported canon, ' +
            'ask the author instead of silently completing the stage without file changes.'
          : ''} />
    </div>}
    {retryableContinuation && <CheckpointContinueAction job={sourceJob} point={sourcePoint}
      expectedLatestJobId={job.id} suggestedGuidance={retryGuidance} />}
    {blocked && !point && !sourcePoint && <p className="text-xs text-muted-foreground">
      {job.forkSource && sourcePending
        ? 'Checking the original verified checkpoint…'
        : 'No independently verified checkpoint is available for a safe continuation. Restore the source evidence before retrying.'}
    </p>}
    {authorError && (job.status === 'paused' || blocked) && <p role="alert" className="text-sm text-destructive">Author decisions could not be verified: {authorError.message}</p>}
    {controlError && <p role="alert" className="text-sm text-destructive">{controlError}</p>}
    <div className="flex flex-wrap items-center gap-3 text-xs">
      <Link to="/jobs/$jobId" params={{ jobId: run.jobId }} className="text-muted-foreground underline-offset-2 hover:underline">
        View run details
      </Link>
      {!!job.reason && <button type="button" className="text-muted-foreground underline-offset-2 hover:underline"
        onClick={() => setShowEvidence(value => !value)}>
        {showEvidence ? 'Hide technical reason' : 'Technical reason'}
      </button>}
    </div>
    {showEvidence && job.reason && <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 text-xs text-muted-foreground">{job.reason}</pre>}
  </section>
}
