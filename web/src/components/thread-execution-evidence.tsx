import type { JobControls, JobOverview } from '@/lib/jobs.functions'
import type { ProgressEvent } from '@/lib/generation-progress.server'

/** Only trusted, bounded controller fields are displayed; Pi prompts,
 * credentials, private transcript bodies and raw server errors stay out.
 * All three requests are independently owner-scoped on the server. */
export function ExecutionEvidence({ job, controls, events, hasMore }: {
  job: JobOverview
  controls?: JobControls
  events?: readonly ProgressEvent[]
  hasMore?: boolean
}) {
  const checked = job.recoveryCheckpoints.filter(point => point.eligible)
  return <div className="grid min-w-0 gap-4 py-3 text-xs">
    <div className="grid gap-1">
      <strong>Controller execution and Story source</strong>
      <p>State: {job.status} · Run: <code>{job.id}</code></p>
      <p>Generation session: <code className="break-all">{job.threadId ?? 'not started'}</code></p>
      <p>Base revision: <code className="break-all">{job.baseSha}</code></p>
      <p>Last recorded HEAD (not necessarily verified): <code className="break-all">{job.headSha}</code></p>
      <p>Revision verification: {job.revisionVerified === true ? 'passed' :
        job.revisionVerified === false ? 'failed / unverified' : 'not established'}</p>
      {job.forkSource && <p>Recovery parent: <code>{job.forkSource.jobId}</code> ·
        pinned checkpoint <code>{job.forkSource.commitSha}</code></p>}
    </div>
    <div className="grid gap-1">
      <strong>Specialist and reviewer evidence</strong>
      <p>{checked.length} independently eligible recovery checkpoints,
        {job.recoveryCheckpoints.length - checked.length} ineligible.</p>
      {job.recoveryCheckpoints.map(point => <div key={point.proofDigest}
        className="border-l border-border/60 pl-3">
        <p>{point.workItem} · {point.stage} · {point.eligible ? 'eligible' : 'not eligible'}</p>
        <p>Git SHA: <code className="break-all">{point.commitSha}</code></p>
        <p>Native validation: {point.validation.status} · version <code>{point.validation.validatorVersion}</code></p>
        <p>Semantic review: {point.semanticReview}</p>
        {point.assurance && <p>Assignment: {point.assurance.assignmentId} ·
          {point.assurance.changedPaths.length} changed files ·
          {point.assurance.reasons.join('; ') || 'no additional review trigger'}</p>}
        {point.reason && <p>{point.reason}</p>}
      </div>)}
      {!job.recoveryCheckpoints.length && <p>No finalized recovery checkpoint; unverified work cannot be resumed blindly.</p>}
      {job.recovery && <p>Preserved interrupted specialist: {job.recovery.kind} ·
        {job.recovery.stage} · {job.recovery.files.length} unverified files.
        Review the saved session before operator reconciliation.</p>}
      {job.completedStages.map((stage, i) => <p key={i}>{stage.stage}: {stage.status}</p>)}
    </div>
    <div className="grid gap-1">
      <strong>Saved specialist sessions</strong>
      {job.savedPiSessions?.map(session => <p key={session.group + session.sessionId}
        className="break-words">
        {session.group} · session <code>{session.sessionId}</code> · {session.model} ·
        {session.transcriptRetained ? 'original transcript retained' : 'transcript unavailable'}
      </p>)}
      {!job.savedPiSessions?.length && <p>No finalized specialist session receipts found.
        Unfinished transcripts are not treated as verified sessions.</p>}
    </div>
    <div className="grid gap-1">
      <strong>Model usage and limits</strong>
      {controls ? <>
        <p>Queue: {controls.queue ?? 'not queued'} · control: {controls.control}</p>
        <p>Calls: {controls.budget.modelCalls} · tokens: {controls.budget.tokens.total} ·
          cost: ${controls.budget.costUsd.toFixed(4)}</p>
        <p>Active execution: {controls.budget.activeSeconds}s · steps: {controls.budget.steps}</p>
        {controls.budget.pause && <p>Budget pause: {controls.budget.pause.reason}</p>}
      </> : <p>Usage is unavailable; this does not imply zero usage.</p>}
    </div>
    <div className="grid gap-1">
      <strong>Controller lifecycle events</strong>
      {events ? events.filter(event => event.detail?.source !== 'pi').map(event => <p
        key={event.id} className="break-words font-mono">
        #{event.id} {event.createdAt} · {event.kind}
        {event.stage ? ' · ' + event.stage : ''}
        {event.status ? ' · ' + event.status : ''}
        {event.detail?.validation ? ' · native ' + event.detail.validation : ''}
        {event.detail?.headSha ? ' · ' + event.detail.headSha : ''}
        {event.files.length ? ' · ' + event.files.join(', ') : ''}
      </p>) : <p>Loading controller events…</p>}
      {hasMore && <p>Older events are available.</p>}
    </div>
  </div>
}
