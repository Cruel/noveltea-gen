import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { StoryExplorer } from './-StoryExplorer'
import { GenerationConfiguration } from './-GenerationConfiguration'
import { GenerationActivity } from './-GenerationActivity'
import { AuthorInteractions } from './-AuthorInteractions'
import { GitChanges } from './-GitChanges'

type Job = {
  id: string; storyId: string; title: string; baseSha: string; headSha: string
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

function JobDetailsForId({ jobId }: { jobId: string }) {
  const [job, setJob] = useState<Job | null>(null)
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
      <GenerationActivity jobId={jobId} onChanged={() => void refresh()} />
      <AuthorInteractions jobId={jobId} onChanged={() => void refresh()} />
      <GitChanges jobId={jobId} revision={job.headSha} />
      <StoryExplorer jobId={jobId} revision={job.headSha} />
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
