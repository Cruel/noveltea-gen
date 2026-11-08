import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { continueJobCheckpoint, forkJobCheckpoint, type JobOverview } from '@/lib/jobs.functions'
import { jobQuery } from '@/lib/jobs.queries'
import { storyNavigationKey } from '@/lib/threads.queries'

type Point = JobOverview['recoveryCheckpoints'][number]

export function ThreadHistory({ messages }: { messages: JobOverview['threadMessages'] }) {
  if (!messages.length) return null
  return <section aria-label="Thread history" className="min-w-0 space-y-2">
    <h3 className="text-sm font-semibold">Thread history</h3>
    {messages.map((message, index) => <div key={index} className="rounded-md bg-muted/40 px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <strong className="text-foreground">{message.role === 'user' ? 'Author' : 'Assistant'}</strong>
        <span>{message.status === 'queued' ? 'Queued for this branch' : 'Delivered'}</span>
        {message.verifiedCommitSha && <span>Verified at <code>{message.verifiedCommitSha.slice(0, 12)}</code></span>}
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words">{message.body}</p>
    </div>)}
  </section>
}

export function CheckpointTimeline({ job }: { job: JobOverview }) {
  return <div className="space-y-3">
    {job.recoveryCheckpoints.length === 0 &&
      <p className="text-sm text-muted-foreground">No finalized recovery checkpoints are available.</p>}
    {job.recoveryCheckpoints.map(point => <details key={point.commitSha}
      className="border-b border-border/50 pb-2 last:border-0">
      <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <code className="text-xs">{point.commitSha.slice(0, 12)}</code>
        <span className="font-medium">{point.workItem}</span>
        <span className="text-xs text-muted-foreground">{point.eligible ? 'Branchable' : 'Not branchable'}</span>
      </summary>
      <div className="mt-2 space-y-1 break-words text-xs text-muted-foreground">
        <div>Exact pinned Story SHA: <code className="break-all">{point.commitSha}</code></div>
        <div>Stage: {point.stage} · Plan: {point.planVersion ?? 'not yet established'}</div>
        <div>Verified work: {point.completedWorkItems.join(', ') || 'none'}</div>
        <div>Next: {point.nextWorkItem ?? 'No ready work item'} · Remaining: {point.remainingWorkItems.join(', ') || 'none'}</div>
        {point.nextWorkItem && <div>Next prerequisites: {(point.dependencies[point.nextWorkItem] ?? []).join(', ') || 'none'}</div>}
        <div>Validator: {point.validation.status} (<code>{point.validation.validatorVersion.slice(0, 12)}</code>)</div>
        {point.eligible && <>
          <div>Parent commit: <code>{point.parentSha.slice(0, 12)}</code> · Receipt: {point.source}</div>
          <div>Receipt proof: <code>{point.proofDigest.slice(0, 20)}</code></div>
          <div>Plan digest: <code>{point.planDigest?.slice(0, 20) ?? 'not established'}</code> · Skills: <code>{point.snapshotId?.slice(0, 20) ?? 'not pinned'}</code></div>
          <CheckpointBranchAction job={job} point={point} />
        </>}
        {point.reason && <div>{point.reason}</div>}
      </div>
    </details>)}
  </div>
}

/** In-place recovery: a fresh isolated run remains in the same visible Thread.
 * No route change or configuration page on the successful path. */
export function CheckpointContinueAction({ job, point, suggestedGuidance = '',
  expectedLatestJobId }: {
  job: JobOverview; point: Point; suggestedGuidance?: string; expectedLatestJobId?: string
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [childId, setChildId] = useState(() => crypto.randomUUID())
  const [guidance, setGuidance] = useState(suggestedGuidance)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    if (!job.storyThreadId) { setError('The original Thread could not be verified.'); return }
    setBusy(true); setError(null)
    try {
      const result = await continueJobCheckpoint({ data: {
        jobId: job.id, childId, commitSha: point.commitSha,
        sourceBaseSha: job.baseSha, sourceThreadId: job.storyThreadId,
        proofDigest: point.proofDigest, guidance,
        ...(expectedLatestJobId ? { expectedLatestJobId } : {}),
      } })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['thread-chat', job.storyThreadId] }),
        queryClient.invalidateQueries({ queryKey: storyNavigationKey(job.storyId) }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ])
      if (!result.started) setError(result.warning || 'Continuation was prepared but could not start.')
      else setOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not prepare a safe continuation.')
    } finally { setBusy(false) }
  }
  return <div className="space-y-2 py-1 text-sm">
    <div className="flex flex-wrap items-center gap-3">
      {expectedLatestJobId
        ? <Button type="button" size="sm" disabled={busy || !job.storyThreadId}
            onClick={() => void submit()}>
            {busy ? 'Retrying…' : 'Retry'}
          </Button>
        : <Button type="button" size="sm" disabled={busy || !job.storyThreadId}
            onClick={() => setOpen(value => !value)}>
            {open ? 'Cancel' : 'Resolve and continue'}
          </Button>}
      {expectedLatestJobId && <button type="button" disabled={busy}
        aria-expanded={open} aria-controls={'continuation-' + job.id}
        className="text-xs text-muted-foreground underline-offset-2 hover:underline"
        onClick={() => setOpen(value => !value)}>
        {open ? 'Hide instructions' : 'Edit instructions'}
      </button>}
    </div>
    {open && <div className="max-w-xl space-y-2">
      <label className="block text-xs font-medium" htmlFor={'continuation-' + job.id}>
        {expectedLatestJobId ? 'Change your previous instruction' : 'Corrective instruction (optional)'}
      </label>
      <Textarea id={'continuation-' + job.id} rows={2} maxLength={2000}
        disabled={busy} value={guidance}
        placeholder="Describe a correction, or leave blank to retry the approved plan."
        onChange={event => {
          setGuidance(event.target.value); setChildId(crypto.randomUUID()); setError(null)
        }} />
      {!expectedLatestJobId && <Button type="button" size="sm" disabled={busy}
        onClick={() => void submit()}>{busy ? 'Continuing…' : 'Continue'}</Button>}
    </div>}
    {error && <p role="alert" className="whitespace-pre-wrap text-xs text-destructive">{error}</p>}
  </div>
}

/** Explicit alternate-history branch. Unlike recovery, this is a new Thread. */
export function CheckpointBranchAction({ job, point, buttonLabel = 'Branch from here' }: {
  job: JobOverview; point: Point; buttonLabel?: string
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [childId, setChildId] = useState(() => crypto.randomUUID())
  const [guidance, setGuidance] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fork = async () => {
    if (!job.storyThreadId) { setError('Source Thread is unavailable; refresh the job.'); return }
    setBusy(true); setError(null)
    try {
      const child = await forkJobCheckpoint({ data: {
        jobId: job.id, childId, commitSha: point.commitSha, sourceBaseSha: job.baseSha,
        sourceThreadId: job.storyThreadId, proofDigest: point.proofDigest, guidance,
      } })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: storyNavigationKey(job.storyId) }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ])
      await navigate({ to: '/jobs/$jobId', params: { jobId: child.id } })
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Branch preparation failed') }
    finally { setBusy(false) }
  }
  return <div className="py-2 text-sm">
    <Button type="button" size="sm" variant="outline" disabled={!job.storyThreadId || busy}
      onClick={() => setOpen(value => !value)}>{open ? 'Close recovery options' : buttonLabel}</Button>
    {open && <div className="mt-3 max-w-xl space-y-2">
      <p className="text-xs text-foreground">This creates a child Thread with its own clean worktree, fresh budget and prepared run at <code>{point.commitSha.slice(0, 12)}</code>. The original Thread remains unchanged.</p>
      <label className="block text-xs font-medium text-foreground" htmlFor={'guidance-' + point.commitSha}>
        Corrective guidance (optional)
      </label>
      <Textarea id={'guidance-' + point.commitSha} rows={3} maxLength={2000}
        value={guidance} disabled={busy} placeholder="What should the continuation do differently?"
        onChange={e => { setGuidance(e.target.value); setChildId(crypto.randomUUID()); setError(null) }} />
      <Button type="button" size="sm" disabled={busy} onClick={() => void fork()}>
        {busy ? 'Preparing child Thread…' : 'Create prepared child Thread'}
      </Button>
      <p className="text-xs">You can review the task, model and budget before explicitly selecting Run.</p>
    </div>}
    {error && <p role="alert" className="mt-2 whitespace-pre-line text-destructive">{error}</p>}
  </div>
}

/** Only fetch the authenticated job when its Thread timeline is expanded. */
export function ExpandedThreadTimeline({ jobId }: { jobId: string }) {
  const { data, error, isFetching } = useQuery(jobQuery(jobId))
  return <div className="mt-2 pl-2">
    {error && <p role="alert" className="text-xs text-destructive">{error.message}</p>}
    {data ? <div className="space-y-4">
      <ThreadHistory messages={data.threadMessages} />
      <CheckpointTimeline job={data} />
    </div> : !error && <p className="text-xs text-muted-foreground">
      {isFetching ? 'Loading verified checkpoints…' : 'No checkpoints available.'}</p>}
  </div>
}
