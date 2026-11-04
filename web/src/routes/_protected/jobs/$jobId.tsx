import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowLeft, CheckCircle2, Circle, Clock3, RefreshCw, Settings2 } from 'lucide-react'
import { jobQuery, jobControlsQuery } from '../../../lib/jobs.queries'
import { jobEventsQuery } from '../../../lib/job-events.queries'
import { useJobEventStream } from '@/hooks/use-job-event-stream'
import { updateJobControl, type JobOverview, type JobControls, type BudgetLimits } from '../../../lib/jobs.functions'
import { StoryExplorer } from './-StoryExplorer'
import { GenerationConfiguration } from './-GenerationConfiguration'
import { GenerationActivity, progressDescription } from './-GenerationActivity'
import { AuthorInteractions } from './-AuthorInteractions'
import { GitChanges } from './-GitChanges'
import { PublishDraft } from './-PublishDraft'

export const Route = createFileRoute('/_protected/jobs/$jobId')({
  loader: ({ context, params }) => Promise.all([
    context.queryClient.ensureQueryData(jobQuery(params.jobId)),
    context.queryClient.ensureQueryData(jobEventsQuery(params.jobId)),
  ]),
  component: JobDetails,
})

type JobTab = 'overview' | 'activity' | 'review' | 'story' | 'details'
const activeStatuses = new Set(['queued', 'running'])
const stopStatuses = new Set(['queued', 'running', 'paused', 'prepared', 'blocked'])

function statusLabel(status: string) {
  return status.replaceAll('-', ' ').replace(/\b\w/g, character => character.toUpperCase())
}

function readableReason(reason: string) {
  const marker = reason.indexOf(': [')
  if (marker < 0) return reason
  try {
    const details = JSON.parse(reason.slice(marker + 2)) as unknown
    if (Array.isArray(details) && details.every(item => typeof item === 'string')) {
      return reason.slice(0, marker + 1) + '\n' + details.join('\n')
    }
  } catch { /* Preserve unrecognized diagnostic text without rewriting it. */ }
  return reason
}

function statusTone(status: string) {
  if (status === 'blocked' || status === 'interrupted' || status === 'failed') return 'text-amber-300 border-amber-500/30 bg-amber-500/10'
  if (status === 'completed') return 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10'
  if (activeStatuses.has(status)) return 'text-sky-300 border-sky-500/30 bg-sky-500/10'
  return 'text-muted-foreground'
}

function JobDetails() {
  const { jobId } = Route.useParams()
  return <JobDetailsForId key={jobId} jobId={jobId} />
}

function JobDetailsForId({ jobId }: { jobId: string }) {
  const queryClient = useQueryClient()
  const { data: job, error: jobError, isFetching } = useQuery({
    ...jobQuery(jobId),
    refetchInterval: query => activeStatuses.has(query.state.data?.status ?? '') ? 8000 : false,
  })
  const { data: controls, error: controlsError } = useQuery(jobControlsQuery(jobId))
  const [tab, setTab] = useState<JobTab>('overview')
  const activity = useJobEventStream(jobId, tab === 'activity')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['job', jobId] }),
      queryClient.invalidateQueries({ queryKey: ['job-controls', jobId] }),
      queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
    ])
  }
  const act = async (action: 'pause' | 'resume' | 'cancel' | 'retry') => {
    setError(null)
    setBusy(true)
    try {
      await updateJobControl({ data: { jobId, action } })
      await refresh()
    } catch (e) { setError(e instanceof Error ? e.message : 'Control transition unavailable') }
    finally { setBusy(false) }
  }

  return <main className="page job-page">
    <div className="mb-4">
      <a className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        href={job?.storyId ? '/stories/' + encodeURIComponent(job.storyId) + '/conversations' : '/dashboard'}>
        <ArrowLeft className="size-4" /> {job?.storyId ? 'Back to Conversations' : 'Back to dashboard'}
      </a>
    </div>
    {(error || jobError) && <Alert variant="destructive" className="mb-4">
      <AlertTitle>Job request failed</AlertTitle>
      <AlertDescription>{error || jobError?.message}</AlertDescription>
    </Alert>}
    {!job && <Card><CardContent className="py-8 text-sm text-muted-foreground">
      {jobError ? 'Unable to load this job.' : 'Loading job…'}
    </CardContent></Card>}
    {job && <>
      <div className="job-page-header">
        <div className="min-w-0">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <Badge variant="outline" className={statusTone(job.status)}>{statusLabel(job.status)}</Badge>
            <span className="text-xs text-muted-foreground">{job.fixture ? 'Fixture' : 'Pi generation'}</span>
            <span className="text-xs text-muted-foreground">· {job.provider === 'gitlab' ? 'GitLab' : job.provider === 'github' ? 'GitHub' : job.provider}</span>
          </div>
          <h1 className="m-0 text-xl font-semibold tracking-tight md:text-2xl">{job.title}</h1>
          <p className="m-0 mt-1 text-xs text-muted-foreground">Generation job <code>{jobId.slice(0, 8)}</code></p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {job.status === 'paused' && job.threadId &&
            <Button size="sm" disabled={busy} onClick={() => void act('resume')}>Resume</Button>}
          {activeStatuses.has(job.status) &&
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void act('pause')}>Pause</Button>}
          {job.status === 'interrupted' &&
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void act('retry')}>Retry after inspection</Button>}
          {stopStatuses.has(job.status) &&
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void act('cancel')}>Cancel</Button>}
          <Button size="sm" variant="outline" disabled={busy} onClick={() => {
            setBusy(true)
            void refresh().catch(e => setError(e instanceof Error ? e.message : 'Refresh failed'))
              .finally(() => setBusy(false))
          }}><RefreshCw className={isFetching ? 'size-4 animate-spin' : 'size-4'} /> Refresh</Button>
        </div>
      </div>

      {activity.unread > 0 && tab !== 'activity' && activity.latestUpdate &&
        <div role="status" className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
          <span className="min-w-0 flex-1 break-words">
            <strong>New activity:</strong> {progressDescription(activity.latestUpdate)}
            {activity.unread > 1 && <span className="ml-1 text-muted-foreground">(+{activity.unread - 1} more)</span>}
          </span>
          <Button variant="outline" size="sm" onClick={() => setTab('activity')}>View activity</Button>
        </div>}
      <Tabs value={tab} onValueChange={value => setTab(value as JobTab)} className="mt-5 min-w-0">
        <div className="job-tab-scroll">
          <TabsList variant="line" aria-label="Job sections" className="min-w-max">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="activity">Activity{activity.unread > 0 &&
              <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground" aria-label={activity.unread + ' new events'}>
                {activity.unread > 99 ? '99+' : activity.unread}
              </span>}</TabsTrigger>
            <TabsTrigger value="review">Author review</TabsTrigger>
            <TabsTrigger value="story">Story & changes</TabsTrigger>
            <TabsTrigger value="details"><Settings2 className="size-3.5" /> Details</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="overview" className="job-tab-body">
          <JobOverviewPanel job={job} controls={controls} jobId={jobId} onReview={() => setTab('review')} onRefresh={refresh} />
          {controlsError && <p role="alert" className="mt-3 text-sm text-destructive">{controlsError.message}</p>}
          {job.status === 'prepared' && <Card className="mt-4"><CardHeader><CardTitle>Configure generation</CardTitle></CardHeader>
            <CardContent><GenerationConfiguration jobId={jobId} onStarted={refresh} /></CardContent>
          </Card>}
        </TabsContent>
        <TabsContent value="activity" className="job-tab-body">
          <GenerationActivity jobId={jobId} connection={activity.connection} />
        </TabsContent>
        <TabsContent value="review" className="job-tab-body">
          <AuthorInteractions jobId={jobId} onChanged={() => void refresh()} />
        </TabsContent>
        <TabsContent value="story" className="job-tab-body">
          {job.revisionVerified === false
            ? <Card><CardContent className="py-5">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-300" />
                <div><h2 className="font-medium">Story inspection temporarily unavailable</h2>
                  <p className="mt-1 text-sm text-muted-foreground">An unfinished specialist has unverified changes. The canonical explorer, committed diffs, and publication remain unavailable until the original worktree is reconciled. Existing committed work is preserved.</p>
                </div>
              </div>
            </CardContent></Card>
            : <div className="grid min-w-0 gap-4">
              <GitChanges jobId={jobId} revision={job.headSha} />
              {(job.provider === 'github' || job.provider === 'gitlab') &&
                <PublishDraft jobId={jobId} provider={job.provider} />}
              {job.reason && /Foundation requires|Author exception recorded|Author rejected|authorized no-write retry/.test(job.reason)
                ? <Card><CardContent className="py-4 text-sm text-muted-foreground">
                  Story explorer is unavailable while Foundation authorization or recovery is pending. Review the original evidence in Author review.
                </CardContent></Card>
                : <StoryExplorer jobId={jobId} revision={job.headSha} />}
            </div>}
        </TabsContent>
        <TabsContent value="details" className="job-tab-body">
          <JobTechnicalDetails job={job} controls={controls} jobId={jobId} onRefresh={refresh} />
        </TabsContent>
      </Tabs>
    </>}
  </main>
}

function JobOverviewPanel({ job, controls, jobId, onReview, onRefresh }: {
  job: JobOverview; controls?: JobControls; jobId: string; onReview: () => void
  onRefresh: () => Promise<void>
}) {
  const hasRecovery = !!job.recovery
  const isBlocked = job.status === 'blocked' || job.status === 'interrupted' || job.status === 'failed'
  const completed = job.completedStages.filter(stage =>
    /committed|verified|completed|finished|success/.test(stage.status)).length
  return <div className="grid min-w-0 gap-4">
    {(job.reason || hasRecovery) && <Card className="border-amber-500/30">
      <CardContent className="py-4">
        <div className="flex items-start gap-3">
          {isBlocked ? <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-300" /> :
            <Clock3 className="mt-0.5 size-5 shrink-0 text-muted-foreground" />}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-semibold text-foreground">{hasRecovery ? 'Manual recovery required' :
                isBlocked ? 'Generation stopped' : 'Current status'}</h2>
              {hasRecovery && <Badge variant="outline">Specialist files preserved</Badge>}
            </div>
            {job.reason && <p className="mt-2 whitespace-pre-wrap break-words text-sm text-foreground/85">{readableReason(job.reason)}</p>}
            {hasRecovery && <>
              <p className="mt-2 text-sm text-muted-foreground">
                The uncommitted files have been preserved. Automated retry and publication are unavailable until they are inspected and explicitly reconciled.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Badge variant="secondary">{statusLabel(job.recovery!.stage)}</Badge>
                <Badge variant="outline">{job.recovery!.files.length} files to review</Badge>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={onReview}>Open author review</Button>
                <details className="job-disclosure w-full">
                  <summary>Recovery instructions and preserved files</summary>
                  <div className="mt-3 space-y-3 text-sm">
                    <p className="whitespace-pre-wrap break-words">{job.recovery!.guidance}</p>
                    {job.recovery!.kind === 'manual-specialist' &&
                      <p>Compare Character records with existing canonical IDs, then inspect and reconcile the corrected files in the original worktree. The unverified draft must not be approved as-is.</p>}
                    {job.recovery!.files.length > 0 && <ul className="job-file-list">
                      {job.recovery!.files.map(file => <li key={file}><code>{file}</code></li>)}
                    </ul>}
                    {job.recovery!.workItem && <p>Work item: <code>{job.recovery!.workItem}</code></p>}
                    {job.recovery!.candidateDigest && <p>Draft digest: <code className="break-all">{job.recovery!.candidateDigest}</code></p>}
                  </div>
                </details>
              </div>
            </>}
          </div>
        </div>
      </CardContent>
    </Card>}

    <Card>
      <CardHeader className="pb-2"><div className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle className="text-sm">Progress</CardTitle>
        <span className="text-xs text-muted-foreground">{completed} of {job.completedStages.length} recorded stages verified</span>
      </div></CardHeader>
      <CardContent>
        {job.completedStages.length ? <ol className="job-stage-list">
          {job.completedStages.map((stage, index) => {
            const verified = /committed|verified|completed|finished|success/.test(stage.status)
            return <li key={index} className="job-stage">
              {verified ? <CheckCircle2 className="size-4 shrink-0 text-emerald-400" /> :
                <Circle className="size-4 shrink-0 text-muted-foreground" />}
              <span className="truncate font-medium">{statusLabel(stage.stage)}</span>
              <span className="ml-auto truncate text-xs text-muted-foreground">{statusLabel(stage.status)}</span>
            </li>
          })}
        </ol> : <p className="text-sm text-muted-foreground">
          {job.status === 'prepared' ? 'Ready to configure and start generation.' : 'No verified stages recorded yet.'}
        </p>}
      </CardContent>
    </Card>

    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-sm">Execution summary</CardTitle></CardHeader>
      <CardContent className="job-metric-grid">
        <div><span>Execution</span><strong>{job.status === 'prepared' ? 'Not started' : job.fixture ? 'Fixture' : 'Sandboxed Pi'}</strong></div>
        <div><span>Control</span><strong>{controls ? statusLabel(controls.control) : 'Unavailable'}</strong></div>
        <div><span>Model calls</span><strong>{controls?.budget.modelCalls ?? '—'}</strong></div>
        <div><span>Steps</span><strong>{controls?.budget.steps ?? '—'}</strong></div>
        <div><span>Reported cost</span><strong>{controls ? '$' + controls.budget.costUsd.toFixed(3) : '—'}</strong></div>
        <div><span>Queue</span><strong>{controls?.queue ? statusLabel(controls.queue) : '—'}</strong></div>
      </CardContent>
      {controls?.budget.pause && <CardContent className="pt-0 text-sm text-amber-300">
        Budget stopped: {controls.budget.pause.reason}
      </CardContent>}
      {job.status === 'paused' && !job.fixture && controls && <CardContent className="pt-0">
        <BudgetEditor key={JSON.stringify(controls.limits)} jobId={jobId}
          limits={controls.limits} onChanged={onRefresh} />
      </CardContent>}
    </Card>
  </div>
}

function JobTechnicalDetails({ job, controls, jobId, onRefresh }: {
  job: JobOverview; controls?: JobControls; jobId: string; onRefresh: () => Promise<void>
}) {
  return <div className="grid gap-4">
    <Card>
      <CardHeader><CardTitle className="text-sm">Job metadata</CardTitle></CardHeader>
      <CardContent className="job-detail-table">
        <div><span>Job ID</span><code>{job.id}</code></div>
        <div><span>Story ID</span><code>{job.storyId}</code></div>
        <div><span>Provider</span><strong>{job.provider}</strong></div>
        <div><span>Base commit</span><code>{job.baseSha}</code></div>
        <div><span>Verified HEAD</span><code>{job.headSha}</code></div>
        <div><span>Graph thread</span><code>{job.threadId ?? 'Not assigned'}</code></div>
        <div><span>Revision verified</span><strong>{job.revisionVerified === false ? 'No' : 'Not marked unverified'}</strong></div>
      </CardContent>
    </Card>
    {job.recoveryCheckpoints.length > 0 && <Card>
      <CardHeader><CardTitle className="text-sm">Verified recovery checkpoints ({job.recoveryCheckpoints.filter(point => point.eligible).length} eligible)</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {job.recoveryCheckpoints.map(point => <details key={point.commitSha} className="border-b border-border/50 pb-2 last:border-0">
          <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <code className="text-xs">{point.commitSha.slice(0, 12)}</code>
            <span className="font-medium">{point.workItem}</span>
            <span className="text-xs text-muted-foreground">{point.eligible ? "Branchable" : "Not branchable"}</span>
          </summary>
          <div className="mt-2 space-y-1 break-words text-xs text-muted-foreground">
            <div>Stage: {point.stage} · Plan: {point.planVersion ?? "not yet established"}</div>
            <div>Verified work: {point.completedWorkItems.join(", ") || "none"}</div>
            <div>Next: {point.nextWorkItem ?? "No ready work item"} · Remaining: {point.remainingWorkItems.join(", ") || "none"}</div>
            <div>Validator: {point.validation.status} ({point.validation.validatorSha256.slice(0, 12)})</div>
            {point.eligible && <>
              <div>Parent commit: <code>{point.parentSha.slice(0, 12)}</code> · Receipt: {point.source}</div>
              <div>Receipt proof: <code>{point.proofDigest.slice(0, 20)}</code></div>
              <div>Plan digest: <code>{point.planDigest?.slice(0, 20) ?? "not established"}</code> · Skills: <code>{point.snapshotId?.slice(0, 20) ?? "not pinned"}</code></div>
            </>}
            {point.reason && <div>{point.reason}</div>}
          </div>
        </details>)}
      </CardContent>
    </Card>}
    {job.status !== 'prepared' && <Card>
      <CardHeader><CardTitle className="text-sm">Saved generation request</CardTitle></CardHeader>
      <CardContent>
        <p className="whitespace-pre-wrap break-words text-sm text-foreground/80">{job.task || 'No task supplied.'}</p>
        {job.contract !== null && <details className="job-disclosure mt-4">
          <summary>Generation contract (JSON)</summary>
          <pre className="job-json mt-3">{JSON.stringify(job.contract, null, 2)}</pre>
        </details>}
      </CardContent>
    </Card>}
    <Card>
      <CardHeader><CardTitle className="text-sm">Execution safety</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm text-muted-foreground">
        <p>Pause and cancel apply at safe work boundaries. An interrupted writer is not automatically replayed.</p>
        <p>Generated work is only available for publication after verification. Protected author approvals remain bound to their original proposal.</p>
        {controls && <p>Current control: <strong className="text-foreground">{controls.control}</strong>.</p>}
        {job.status === 'interrupted' && <p className="text-amber-300">An interrupted job requires explicit operator reconciliation before retry.</p>}
        <Button size="sm" variant="outline" onClick={() => void onRefresh()}>Inspect latest saved state</Button>
      </CardContent>
    </Card>
  </div>
}

function BudgetEditor({ jobId, limits, onChanged }: {
  jobId: string; limits: BudgetLimits; onChanged: () => Promise<void>
}) {
  const [steps, setSteps] = useState(String(limits.steps ?? ''))
  const [calls, setCalls] = useState(String(limits.modelCalls ?? ''))
  const [cost, setCost] = useState(String(limits.costUsd ?? ''))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    setSaving(true); setError(null)
    try {
      const next: BudgetLimits = {
        ...(steps.trim() ? { steps: Number(steps) } : {}),
        ...(calls.trim() ? { modelCalls: Number(calls) } : {}),
        ...(cost.trim() ? { costUsd: Number(cost) } : {}),
      }
      if (!Object.keys(next).length || Object.values(next).some(v => !Number.isFinite(v) || v! < 0))
        throw new Error('Supply an increased budget limit.')
      await updateJobControl({ data: { jobId, action: 'budget', limits: next } })
      await onChanged()
    } catch (e) { setError(e instanceof Error ? e.message : 'Budget increase unavailable') }
    finally { setSaving(false) }
  }
  return <div className="border-t border-border pt-4">
    <h3 className="text-sm font-medium">Increase Pi budgets</h3>
    <p className="mt-1 text-xs text-muted-foreground">Limits can only increase. Existing usage is retained.</p>
    <div className="mt-3 grid gap-3 sm:grid-cols-3">
      <label className="grid gap-1 text-xs">Steps <Input type="number" min={0} max={1000000} disabled={saving}
        value={steps} onChange={e => setSteps(e.target.value)} /></label>
      <label className="grid gap-1 text-xs">Model calls <Input type="number" min={0} max={1000000} disabled={saving}
        value={calls} onChange={e => setCalls(e.target.value)} /></label>
      <label className="grid gap-1 text-xs">Cost limit (USD) <Input type="number" min={0} max={1000000} step="0.01"
        disabled={saving} value={cost} onChange={e => setCost(e.target.value)} /></label>
    </div>
    {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
    <Button size="sm" className="mt-3" disabled={saving} onClick={() => void save()}>
      {saving ? 'Saving…' : 'Increase budgets'}
    </Button>
  </div>
}
