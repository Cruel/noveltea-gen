import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { StoryExplorer } from './-StoryExplorer'
import { GenerationConfiguration } from './-GenerationConfiguration'
import { GenerationActivity } from './-GenerationActivity'
import { AuthorInteractions } from './-AuthorInteractions'
import { GitChanges } from './-GitChanges'
import { PublishDraft } from './-PublishDraft'

type Job = {
  id: string; storyId: string; title: string; provider: string; baseSha: string; headSha: string
  status: string; threadId: string | null; fixture: boolean; task: string | null
  contract: unknown; reason: string | null; completedStages: Array<{ stage: string; status: string }>
}
export const Route = createFileRoute('/_protected/jobs/$jobId')({ component: JobDetails })

async function load(jobId: string): Promise<Job> {
  const response = await fetch('/api/jobs/' + encodeURIComponent(jobId), { cache: 'no-store' })
  const data = await response.json() as { job?: Job; error?: string }
  if (!response.ok || !data.job) throw new Error(data.error || 'Could not inspect job')
  return data.job
}
function JobDetails() {
  const { jobId } = Route.useParams()
  return <JobDetailsForId key={jobId} jobId={jobId} />
}

type BudgetLimits = { steps?: number; modelCalls?: number; costUsd?: number }
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
      const response = await fetch('/api/jobs/' + encodeURIComponent(jobId) + '/control', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'budget', limits: next }),
      })
      const result = await response.json() as { error?: string }
      if (!response.ok) throw new Error(result.error || 'Budget increase failed')
      await onChanged()
    } catch (e) { setError(e instanceof Error ? e.message : 'Budget increase unavailable') }
    finally { setSaving(false) }
  }
  return <div>
    <h3>Increase Pi budgets</h3>
    <p>Limits can only increase. Existing usage is retained. Save before resuming a budget-stopped job.</p>
    <div className="generation-controls">
      <label>Steps <input type="number" min={0} max={1000000} disabled={saving}
        value={steps} onChange={e => setSteps(e.target.value)} /></label>
      <label>Model calls <input type="number" min={0} max={1000000} disabled={saving}
        value={calls} onChange={e => setCalls(e.target.value)} /></label>
      <label>Reported cost (USD) <input type="number" min={0} max={1000000} step="0.01"
        disabled={saving} value={cost} onChange={e => setCost(e.target.value)} /></label>
    </div>
    {error && <p role="alert">{error}</p>}
    <button type="button" disabled={saving} onClick={() => void save()}>
      {saving ? 'Saving…' : 'Increase budgets'}
    </button>
  </div>
}
function JobDetailsForId({ jobId }: { jobId: string }) {
  const [job, setJob] = useState<Job | null>(null)
  const [controls, setControls] = useState<{ control: string; queue: string | null;
    limits: BudgetLimits; budget: { steps: number; modelCalls: number; costUsd: number; pause?: { reason: string } } } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refresh = async () => {
    try {
      const [saved, controlResponse] = await Promise.all([
        load(jobId), fetch('/api/jobs/' + encodeURIComponent(jobId) + '/control', { cache: 'no-store' }),
      ])
      setJob(saved)
      if (controlResponse.ok) setControls(await controlResponse.json())
      setError(null)
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to inspect job') }
  }
  const act = async (action: 'pause' | 'resume' | 'cancel' | 'retry') => {
    setBusy(true)
    try {
      const response = await fetch('/api/jobs/' + encodeURIComponent(jobId) + '/control', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const result = await response.json() as { error?: string }
      if (!response.ok) throw new Error(result.error || 'Control transition failed')
      await refresh()
    } catch (e) { setError(e instanceof Error ? e.message : 'Control transition unavailable') }
    finally { setBusy(false) }
  }
  useEffect(() => {
    let cancelled = false
    void Promise.all([load(jobId), fetch('/api/jobs/' + encodeURIComponent(jobId) + '/control', { cache: 'no-store' })])
      .then(async ([data, response]) => {
        const control = response.ok ? await response.json() as typeof controls : null
        if (!cancelled) { setJob(data); setControls(control); setError(null) }
      }).catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'Unable to inspect job') })
    return () => { cancelled = true }
  }, [jobId])

  return <main className="page">
    <header><div><p className="eyebrow">NovelTea</p><h1>Generation job</h1></div>
      <nav><a href="/dashboard">Dashboard</a></nav></header>
    <p>Job <code>{jobId}</code>. Generation runs through the same checkpointed Story graph,
      using either deterministic fixtures or the selected, sandboxed Pi model.
      Refresh or reconnect without restarting a writer.</p>
    {error && <p role="alert" className="error">{error}</p>}
    {!job && !error && <p>Loading job…</p>}
    {job && <>
      <section>
        <h2>{job.title}</h2>
        <p><strong>Status:</strong> {job.status} · <strong>Execution:</strong> {job.status === 'prepared' ? 'not started' : job.fixture ? 'deterministic fixture' : 'sandboxed Pi'}</p>
        <p><strong>Pinned Git commit:</strong> <code>{job.baseSha}</code></p>
        <p><strong>Job HEAD:</strong> <code>{job.headSha}</code></p>
        {job.threadId && <p><strong>Durable graph thread:</strong> <code>{job.threadId}</code></p>}
        {job.reason && <p role="status">{job.reason}</p>}
        {job.completedStages.length > 0 && <ul>{job.completedStages.map((stage, index) =>
          <li key={index}>{stage.stage}: {stage.status}</li>)}</ul>}
        <button type="button" disabled={busy} onClick={() => { setBusy(true); void refresh().finally(() => setBusy(false)) }}>Refresh saved state</button>
      </section>
      <section aria-label="Job controls">
        <h2>Execution controls</h2>
        <p>Pause and cancel take effect at a safe work boundary. An interrupted writer is never automatically replayed.</p>
        {controls && <p><strong>Control:</strong> {controls.control}
          {controls.queue && <> · <strong>Queue:</strong> {controls.queue}</>}
          {' · '}<strong>Pi usage:</strong> {controls.budget.steps} steps, {controls.budget.modelCalls} model calls,
          ${controls.budget.costUsd.toFixed(3)} reported
          {controls.budget.pause && <> · Budget stop: {controls.budget.pause.reason}</>}</p>}
        {job.status === 'paused' && !job.fixture && controls &&
          <BudgetEditor key={JSON.stringify(controls.limits)} jobId={jobId}
            limits={controls.limits} onChanged={refresh} />}
        <div className="generation-actions">
          <button type="button" disabled={busy || !['queued', 'running'].includes(job.status)}
            onClick={() => void act('pause')}>Pause</button>
          <button type="button" disabled={busy || job.status !== 'paused' || !job.threadId}
            onClick={() => void act('resume')}>Resume</button>
          <button type="button" disabled={busy || !['queued', 'running', 'paused', 'prepared', 'blocked'].includes(job.status)}
            onClick={() => void act('cancel')}>Cancel</button>
          <button type="button" disabled={busy || job.status !== 'interrupted'}
            onClick={() => void act('retry')}>Retry after inspection</button>
          <button type="button" disabled={busy} onClick={() => { setBusy(true); void refresh().finally(() => setBusy(false)) }}>Inspect</button>
        </div>
      </section>
      <GenerationActivity jobId={jobId} onChanged={() => void refresh()} />
      <AuthorInteractions jobId={jobId} onChanged={() => void refresh()} />
      <GitChanges jobId={jobId} revision={job.headSha} />
      {(job.provider === 'github' || job.provider === 'gitlab') &&
        <PublishDraft jobId={jobId} provider={job.provider} />}
      {job.reason && /Foundation requires|Author exception recorded|Author rejected|authorized no-write retry/.test(job.reason)
        ? <section aria-label="Story explorer availability"><p>The canonical Story explorer is temporarily unavailable while Foundation authorization or recovery is pending. The original source is available in the review panel above.</p></section>
        : <StoryExplorer jobId={jobId} revision={job.headSha} />}
      {job.status === 'prepared'
        ? <GenerationConfiguration jobId={jobId} onStarted={refresh} />
        : <section>
          <h2>Saved generation request</h2>
          <p>{job.task}</p>
          {job.contract !== null && <pre>{JSON.stringify(job.contract, null, 2)}</pre>}
          {job.status === 'interrupted' && <p>Recovery requires explicit operator reconciliation.
            This page will never automatically rerun a possibly interrupted writer.</p>}
        </section>}
    </>}
  </main>
}
