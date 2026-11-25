import { useEffect, useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle, CheckCircle2, ChevronDown, ChevronRight, CircleDot, FileText, LoaderCircle, PauseCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger,
  TraceDescription, TraceIcon, TraceLine, TraceTitle,
} from '@/components/ui/trace'
import { getJobEventHistory } from '@/lib/job-events.functions'
import { jobEventsKey, jobEventsQuery, mergeJobEvents, type JobEventHistory } from '@/lib/job-events.queries'
import { activityTitle, projectActivity, type ActivityStep } from '@/lib/thread-activity'
import { useJobEventStream } from '@/hooks/use-job-event-stream'

function StepIcon({ step }: { step: ActivityStep }) {
  if (step.state === 'verified' || step.outcome === 'completed')
    return <CheckCircle2 className="size-3.5 text-emerald-500" />
  if (step.state === 'working')
    return <LoaderCircle className="size-3.5 animate-spin text-primary motion-reduce:animate-none" />
  if (step.state === 'paused' || step.outcome === 'paused')
    return <PauseCircle className="size-3.5 text-muted-foreground" />
  if (step.state === 'stopped' || step.state === 'unverified' ||
      ['blocked', 'interrupted', 'cancelled'].includes(step.outcome ?? ''))
    return <AlertCircle className="size-3.5 text-amber-500" />
  return <CircleDot className="size-3.5" />
}

export function ActivityRow({ step, onHover, onPin, pinned = false }: {
  step: ActivityStep; onHover?: (step: ActivityStep | null) => void
  onPin?: () => void; pinned?: boolean
}) {
  const [showFiles, setShowFiles] = useState(false)
  const [open, setOpen] = useState<boolean | undefined>()
  const isStart = step.kind === 'started'
  const canHighlight = step.state === 'verified' && (step.files.length > 0 ||
    !!step.detail?.changedRecordIds?.length) ||
    step.state === 'proposed' && !!step.detail?.proposedPaths?.length ||
    step.state === 'working' && !!step.milestone
  const pinButton = onPin && canHighlight && <button type="button"
    aria-pressed={pinned} className="mt-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
    onClick={onPin}>{pinned ? 'Clear Story highlight' : 'Highlight in Story'}</button>
  const files = showFiles ? step.files : step.files.slice(0, 3)
  const status = step.state === 'working' ? 'running' :
    step.state === 'stopped' ? 'error' : undefined

  const interaction = onHover ? {
    onMouseEnter: () => onHover(step), onMouseLeave: () => onHover(null),
    onFocus: () => onHover(step), onBlur: () => onHover(null), tabIndex: 0,
  } : {}
  if (isStart || step.kind === 'report') return <TraceLine status={status} title={step.at}
    {...interaction} data-activity-source={step.detail?.source === 'pi' ? 'pi' : 'controller'}>
    <TraceIcon><StepIcon step={step} /></TraceIcon>
    <div className="min-w-0"><TraceTitle>{activityTitle(step)}</TraceTitle>
      {step.kind === 'report' && <TraceDescription>
        {step.detail?.reviewPhase
          ? 'Controller-confirmed Blueprint or review activity; no new verified Story files claimed'
          : 'Studio-proposed, unverified' + (step.detail?.proposedPaths?.length
              ? ' · ' + step.detail.proposedPaths.join(', ') : '')}
      </TraceDescription>}
      {pinButton}
    </div>
  </TraceLine>

  return <TraceLine status={status} title={step.at} className="grid-cols-1 gap-0"
    {...interaction} data-activity-source="controller">

    <TraceCollapsible open={open ?? step.state === 'working'}
      onOpenChange={setOpen}>
      <TraceCollapsibleTrigger className="group/trigger w-full">
        <TraceIcon><StepIcon step={step} /></TraceIcon>
        <div className="min-w-0 flex-1">
          <TraceTitle>{activityTitle(step)}</TraceTitle>
          {step.detail?.headSha && <span className="block text-xs text-muted-foreground">
            Checkpoint {step.detail.headSha.slice(0, 12)}
            {step.detail.outcome ? ' · ' + step.detail.outcome : ''}
            {step.detail.validation ? ' · native ' + step.detail.validation : ''}
            {step.detail.diagnostics !== undefined ? ' · ' + step.detail.diagnostics + ' diagnostics' : ''}
            {step.detail.review ? ' · review ' + step.detail.review : ''}
            {step.detail.turnId ? ' · Turn ' + step.detail.turnId.slice(0, 8) : ''}
          </span>}
          {step.state === 'verified' && step.files.length > 0 &&
            <span className="block text-xs text-muted-foreground">
              {step.files.length} verified Story {step.files.length === 1 ? 'file' : 'files'}
            </span>}
        </div>
        <ChevronRight className={'mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none ' +
          ((open ?? step.state === 'working') ? 'rotate-90' : '')} aria-hidden="true" />
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="ml-6 mt-1 border-l border-border/50 pl-3 pb-1">
        {step.state === 'verified' && step.files.length > 0 ? <>
          <Trace className="gap-1.5" aria-label="Verified Story files">
            {files.map(file => <TraceLine key={file} className="gap-1.5">
              <TraceIcon><FileText className="size-3" /></TraceIcon>
              <div className="min-w-0">
                <TraceTitle className="break-all font-mono text-xs text-muted-foreground">{file}</TraceTitle>
              </div>
            </TraceLine>)}
          </Trace>
          {step.files.length > 3 && <button type="button" aria-expanded={showFiles}
            className="mt-1 rounded text-xs text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => setShowFiles(current => !current)}>
            {showFiles ? 'Show fewer files' : 'Show ' + (step.files.length - 3) + ' more files'}
          </button>}
        </> : <TraceDescription className="mt-0">
          {step.state === 'working' ? 'Working on this stage. Verified files will appear here when committed.' :
            step.state === 'stopped' ? 'This stage stopped without a verified result or confirmed file changes.' :
            step.state === 'paused' ? 'Paused before this stage produced a verified result.' :
            step.state === 'unverified' ? 'No verified result was recorded for this stage.' :
            'The stage was verified without recorded canonical file changes.'}
        </TraceDescription>}
      </TraceCollapsibleContent>
    </TraceCollapsible>
    {pinButton}
  </TraceLine>
}

function LiveActivityStream({ jobId }: { jobId: string }) {
  useJobEventStream(jobId, true)
  return null
}

/** Durable activity is embedded after the user's run request, not hidden in a
 * separate tab. This reads the same shared Query cache as the Job page's SSE.
 * Only controller-verified changes produce file rows; never read Pi transcripts. */
export function ThreadRunActivity({ jobId, status, onProgress, onActivityHover,
  onActivityPin, pinnedId }: {
  jobId: string; status: string; onProgress?: () => void
  onActivityHover?: (jobId: string, step: ActivityStep | null) => void
  onActivityPin?: (jobId: string, step: ActivityStep) => void
  pinnedId?: number | null
}) {
  const queryClient = useQueryClient()
  const { data: history, error, isPending } = useQuery(jobEventsQuery(jobId))
  const [expanded, setExpanded] = useState(status === 'running' || status === 'queued')
  const [showAll, setShowAll] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [olderError, setOlderError] = useState<string | null>(null)
  const steps = useMemo(() => projectActivity(history?.events ?? [], status), [history?.events, status])
  // Terminal status and recovery actions already have an assistant card below.
  // Keep this trace about the work itself, not a duplicated "Generation stopped".
  const workSteps = steps.filter(step => step.kind !== 'finished')
  const visible = showAll ? workSteps : workSteps.slice(-8)
  const verified = workSteps.filter(step => step.state === 'verified').length
  const stillRunning = status === 'running' || status === 'queued'

  useEffect(() => {
    if (history?.events.length) onProgress?.()
  }, [history?.events.length, onProgress])

  const loadOlder = async () => {
    const before = history?.events[0]?.id
    if (!before || loadingOlder) return
    setLoadingOlder(true); setOlderError(null)
    try {
      const page = await getJobEventHistory({ data: { jobId, before } })
      queryClient.setQueryData<JobEventHistory>(jobEventsKey(jobId), current =>
        current
          ? { events: mergeJobEvents(current.events, page.events), hasMore: page.hasMore }
          : page)
      setShowAll(true)
    } catch (cause) {
      setOlderError(cause instanceof Error ? cause.message : 'Could not load earlier activity.')
    } finally { setLoadingOlder(false) }
  }

  // A failed preflight can record "started" without reaching a specialist.
  // The status card already explains it; don't show an empty second timeline.
  if (!stillRunning && !isPending && !error && !history?.hasMore &&
      !workSteps.some(step => step.kind === 'stage' || step.kind === 'report')) return null

  return <div role="group" aria-label="Generation activity"
    className="mr-6 min-w-0 px-1 py-2 text-sm">
    {stillRunning && <LiveActivityStream jobId={jobId} />}
    <TraceCollapsible open={expanded} onOpenChange={setExpanded}>
    <TraceCollapsibleTrigger
      className="flex min-w-0 items-center gap-2 rounded py-1 text-left text-sm hover:text-foreground">
      {expanded ? <ChevronDown className="size-3.5 shrink-0" /> :
        <ChevronRight className="size-3.5 shrink-0" />}
      <strong>Generation activity</strong>
      <span className="text-xs text-muted-foreground">
        {verified > 0 ? verified + ' verified ' + (verified === 1 ? 'stage' : 'stages') :
          stillRunning ? 'In progress' : ''}
      </span>
    </TraceCollapsibleTrigger>
    <TraceCollapsibleContent className="ml-1 mt-2 border-l border-border/60 pl-3">
      {error && <p role="alert" className="text-xs text-destructive">
        Activity could not be loaded. <Link to="/jobs/$jobId" params={{ jobId }}>Inspect run</Link>.
      </p>}
      {olderError && <p role="alert" className="text-xs text-destructive">{olderError}</p>}
      {isPending && !error && <p role="status" className="text-xs text-muted-foreground">
        Loading saved activity…
      </p>}
      {!isPending && workSteps.length === 0 && <p role="status" className="text-xs text-muted-foreground">
        {stillRunning ? 'Waiting for the first recorded stage…' : 'No stage activity was recorded for this run.'}
      </p>}
      {visible.length > 0 && <Trace>
        {visible.map(step => <ActivityRow key={step.id} step={step}
          onHover={onActivityHover ? next => onActivityHover(jobId, next) : undefined}
          onPin={onActivityPin ? () => onActivityPin(jobId, step) : undefined}
          pinned={pinnedId === step.id} />)}
      </Trace>}
      {(workSteps.length > 8 || history?.hasMore) && <div className="mt-2 flex flex-wrap gap-2">
        {workSteps.length > 8 && <Button size="sm" variant="ghost"
          onClick={() => setShowAll(value => !value)}>
          {showAll ? 'Show recent stages' : 'Show all ' + workSteps.length + ' recorded steps'}
        </Button>}
        {history?.hasMore && <Button size="sm" variant="ghost"
          disabled={loadingOlder} onClick={() => void loadOlder()}>
          {loadingOlder ? 'Loading…' : 'Load earlier activity'}
        </Button>}
      </div>}
    </TraceCollapsibleContent>
    </TraceCollapsible>
  </div>
}
