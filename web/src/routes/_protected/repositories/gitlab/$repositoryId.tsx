import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { NewStoryOnboarding } from '../-NewStoryOnboarding'

type Listing = { commit: string; directory: string; isStory: boolean; directories: Array<{ name: string; path: string }> }
type Discovery = { commit: string; stories: string[] }
type InitState = { empty: boolean; defaultBranch: string | null; commit: string | null }
type Created = { story: { id: string; directory: string; title: string };
  jobId: string; headSha: string; branch: string; commit: string; mode: string }
type Selection = { story: { id: string; title: string; directory: string; commit: string }; sizeBytes: number; limitBytes: number; blobCount: number }

export const Route = createFileRoute('/_protected/repositories/gitlab/$repositoryId')({
  validateSearch: (search: Record<string, unknown>) => ({
    directory: typeof search.directory === 'string' ? search.directory : '',
    commit: typeof search.commit === 'string' && /^[a-f0-9]{40}$/i.test(search.commit)
      ? search.commit : '',
  }),
  component: GitlabStories,
})
async function api<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(path, body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  } : { cache: 'no-store' })
  const result = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(result.error || 'GitLab Story request failed')
  return result
}
function GitlabStories() {
  const { repositoryId } = Route.useParams()
  const pinnedLink = Route.useSearch()
  const [commit, setCommit] = useState(pinnedLink.commit)
  const [directory, setDirectory] = useState(pinnedLink.directory)
  const [listing, setListing] = useState<Listing | null>(null)
  const [initState, setInitState] = useState<InitState | null>(null)
  const [created, setCreated] = useState<Created | null>(null)
  const [discovered, setDiscovered] = useState<string[] | null>(null)
  const [discoveryError, setDiscoveryError] = useState<string | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [job, setJob] = useState<{ id: string; baseSha: string } | null>(null)
  const [pendingJobId, setPendingJobId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let cancelled = false
    setInitState(null)
    void api<InitState>('/api/gitlab/initialize?' + new URLSearchParams({ repositoryId }))
      .then(state => { if (!cancelled) setInitState(state) })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'Unable to verify GitLab project') })
    return () => { cancelled = true }
  }, [repositoryId])
  useEffect(() => {
    if (initState === null || initState.empty) return
    let cancelled = false
    setListing(null); setError(null); setSelection(null); setJob(null); setPendingJobId(null)
    const params = new URLSearchParams({ repositoryId, directory })
    if (commit) params.set('commit', commit)
    void api<Listing>('/api/gitlab/stories?' + params).then(result => {
      if (cancelled) return
      setCommit(result.commit); setListing(result)
    }).catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'Unable to browse directory') })
    return () => { cancelled = true }
  }, [repositoryId, directory, commit, initState])
  useEffect(() => {
    if (!commit) return
    let cancelled = false
    void api<Discovery>('/api/gitlab/stories?' + new URLSearchParams({ repositoryId, commit, mode: 'discover' }))
      .then(result => { if (!cancelled) setDiscovered(result.stories) })
      .catch(e => { if (!cancelled) setDiscoveryError(e instanceof Error ? e.message : 'Discovery incomplete') })
    return () => { cancelled = true }
  }, [repositoryId, commit])
  const select = async () => {
    if (!commit || !listing?.isStory) return
    setBusy(true); setError(null); setSelection(null); setJob(null); setPendingJobId(null)
    try {
      setSelection(await api<Selection>('/api/gitlab/stories', { repositoryId, directory, commit }))
    } catch (e) { setError(e instanceof Error ? e.message : 'Story preflight failed') }
    finally { setBusy(false) }
  }
  const createJob = async () => {
    if (!selection) return
    const jobId = pendingJobId ?? crypto.randomUUID()
    setPendingJobId(jobId); setBusy(true); setError(null)
    try {
      const result = await api<{ job: { id: string; baseSha: string } }>('/api/gitlab/jobs', {
        storyId: selection.story.id, jobId, commit: selection.story.commit,
      })
      setJob(result.job)
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to acquire the selected Story') }
    finally { setBusy(false) }
  }
  const open = (path: string) => {
    setError(null); setSelection(null); setJob(null); setPendingJobId(null); setDirectory(path)
  }
  return <main className="page">
    <header><div><p className="eyebrow">NovelTea</p><h1>GitLab Story discovery</h1></div>
      <nav><a href="/dashboard">Dashboard</a></nav></header>
    <p>Browse a connected GitLab project at one pinned commit. Only the selected Story is size-verified; no project assets are cloned.</p>
    {commit && <p><strong>Commit:</strong> <code>{commit}</code>{' '}
      <button type="button" disabled={busy} onClick={() => { setCommit(''); setDirectory(''); setDiscovered(null); setDiscoveryError(null) }}>Refresh HEAD</button></p>}
    {error && <p role="alert" className="error">{error}</p>}
    {initState && <NewStoryOnboarding provider="gitlab" repositoryId={repositoryId}
      initialWorkspace={directory}
      onCreated={result => {
        setCreated(result)
        setError(null)
      }} />}
    {created && <p role="status">Initialized <strong>{created.story.title}</strong> at
      <code>{created.commit}</code> on <code>{created.branch}</code>.
      {created.mode === 'review-branch'
        ? ' Existing default branch was not modified; use the later merge-request publishing flow for review.'
        : ' This was the initial commit of an empty project.'}
    </p>}
    {initState && !initState.empty && <section>
      <h2>Directory browser</h2>
      <p>Current path: <code>/{directory}</code></p>
      {directory && <button type="button" onClick={() => open(directory.split('/').slice(0, -1).join('/'))}>Up one directory</button>}
      {!listing && !error && <p>Loading directory…</p>}
      {listing && <ul>{listing.directories.map(entry =>
        <li key={entry.path}><button type="button" onClick={() => open(entry.path)}>{entry.name}/</button></li>
      )}</ul>}
      {listing && !listing.directories.length && <p>No child directories.</p>}
      {listing?.isStory && <div>
        <p>Canonical Story Markdown detected here. Verify the 100 MB uncompressed Git-blob limit before registering the Story.</p>
        <button type="button" disabled={busy} onClick={() => void select()}>{busy ? 'Verifying…' : 'Verify size and add Story'}</button>
      </div>}
      {selection && <div><p role="status">Added <strong>{selection.story.title}</strong> at commit <code>{selection.story.commit}</code>.
        {' '}{selection.sizeBytes.toLocaleString()} / {selection.limitBytes.toLocaleString()} bytes ({selection.blobCount} Git blobs).
      </p>
        <button type="button" disabled={busy || !!job} onClick={() => void createJob()}>
          {busy ? 'Preparing sparse checkout…' : 'Create isolated job worktree'}
        </button>
        {job && <p role="status">Job <code>{job.id}</code> is prepared at base <code>{job.baseSha}</code>.
          {' '}<a href={'/jobs/' + job.id}>Open job and start fixture generation</a>.</p>}
      </div>}
    </section>}
    {initState && !initState.empty && <section>
      <h2>Detected Story directories</h2>
      {discoveryError && <p role="status">{discoveryError} You can still browse directories manually.</p>}
      {discovered === null && !discoveryError && <p>Scanning Git tree metadata…</p>}
      {discovered && (discovered.length
        ? <ul>{discovered.map(path => <li key={path || '/'}><button type="button" onClick={() => open(path)}>{'/' + path}</button></li>)}</ul>
        : <p>No Story records detected at this commit. Browse manually if you expect a Story in a large project.</p>)}
    </section>}
  </main>
}
