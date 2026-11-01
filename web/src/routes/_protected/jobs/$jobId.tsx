import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { StoryExplorer } from './-StoryExplorer'

type Job = {
  id: string; storyId: string; title: string; baseSha: string; headSha: string
  status: string; threadId: string | null; fixture: true; task: string | null
  contract: unknown; reason: string | null; completedStages: Array<{ stage: string; status: string }>
}
const defaultContract = {
  scope: { kind: 'full-story', depth: 'composition', targets: [], branches: [] },
  constraints: [],
  envelope: { presentation: 'Visual novel', hardLimits: [], preferences: [] },
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
  const [job, setJob] = useState<Job | null>(null)
  const [task, setTask] = useState('')
  const [contract, setContract] = useState(JSON.stringify(defaultContract, null, 2))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refresh = async () => {
    try { setJob(await load(jobId)); setError(null) }
    catch (e) { setError(e instanceof Error ? e.message : 'Unable to inspect job') }
  }
  useEffect(() => {
    let cancelled = false
    void load(jobId).then(data => { if (!cancelled) { setJob(data); setError(null) } })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'Unable to inspect job') })
    return () => { cancelled = true }
  }, [jobId])

  const start = async () => {
    let parsed: unknown
    try { parsed = JSON.parse(contract) }
    catch { setError('Completion contract must be valid JSON.'); return }
    setBusy(true); setError(null)
    try {
      const response = await fetch('/api/jobs/' + encodeURIComponent(jobId), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task, contract: parsed }),
      })
      const data = await response.json() as { job?: Job; error?: string }
      if (!response.ok || !data.job) throw new Error(data.error || 'Fixture start failed')
      setJob(data.job)
    } catch (e) { setError(e instanceof Error ? e.message : 'Fixture start failed') }
    finally { setBusy(false) }
  }

  return <main className="page">
    <header><div><p className="eyebrow">NovelTea</p><h1>Generation job</h1></div>
      <nav><a href="/dashboard">Dashboard</a></nav></header>
    <p>Job <code>{jobId}</code>. This phase only runs the real Story graph with deterministic fixtures;
      no real Pi session or model-directed shell tools are permitted.</p>
    {error && <p role="alert" className="error">{error}</p>}
    {!job && !error && <p>Loading job…</p>}
    {job && <>
      <section>
        <h2>{job.title}</h2>
        <p><strong>Status:</strong> {job.status}</p>
        <p><strong>Pinned Git commit:</strong> <code>{job.baseSha}</code></p>
        <p><strong>Job HEAD:</strong> <code>{job.headSha}</code></p>
        {job.threadId && <p><strong>Durable graph thread:</strong> <code>{job.threadId}</code></p>}
        {job.reason && <p role="status">{job.reason}</p>}
        {job.completedStages.length > 0 && <ul>{job.completedStages.map((stage, index) =>
          <li key={index}>{stage.stage}: {stage.status}</li>)}</ul>}
        <button type="button" disabled={busy} onClick={() => void refresh()}>Refresh saved state</button>
      </section>
      <StoryExplorer jobId={jobId} revision={job.headSha} />
      {job.status === 'prepared' ? <section>
        <h2>Start fixture generation</h2>
        <p>A validated contract is bound permanently to this job and graph thread.
          Generation pauses after the foundation stage. Retrying does not rerun the graph;
          interrupt recovery and live model execution are separate features.</p>
        <label>Generation task
          <textarea rows={3} maxLength={4000} value={task} onChange={e => setTask(e.target.value)}
            disabled={busy} placeholder="Develop a mystery about a missing witness" />
        </label>
        <label>Completion contract (JSON)
          <textarea rows={13} value={contract} onChange={e => setContract(e.target.value)} disabled={busy} />
        </label>
        <button type="button" disabled={busy || !task.trim()} onClick={() => void start()}>
          {busy ? 'Running fixture…' : 'Start fixture generation'}
        </button>
      </section> : <section>
        <h2>Saved generation request</h2>
        <p>{job.task}</p>
        {job.contract !== null && <pre>{JSON.stringify(job.contract, null, 2)}</pre>}
        {job.status === 'interrupted' && <p>Recovery requires explicit operator reconciliation.
          This page will never automatically rerun a possibly interrupted writer.</p>}
      </section>}
    </>}
  </main>
}
