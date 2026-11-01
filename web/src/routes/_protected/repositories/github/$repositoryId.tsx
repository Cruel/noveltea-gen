import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

type Listing = { commit: string; directory: string; isStory: boolean; directories: Array<{ name: string; path: string }> }
type Discovery = { commit: string; stories: string[] }
type Selection = { story: { id: string; title: string; directory: string; commit: string }; sizeBytes: number; limitBytes: number; blobCount: number }
type Initialization = { mode: 'branch' | 'bootstrap'; commit: string | null; defaultBranch: string; directory: string; sizeBytes: number }
type Initialized = { story: { id: string; title: string }; job: { id: string; baseSha: string; headSha: string; branch: string }; mode: 'branch' | 'bootstrap'; published: boolean }

export const Route = createFileRoute('/_protected/repositories/github/$repositoryId')({
  component: GithubStories,
})

async function api<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(path, body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  } : { cache: 'no-store' })
  const result = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(result.error || 'GitHub Story request failed')
  return result
}

function GithubStories() {
  const { repositoryId } = Route.useParams()
  const [commit, setCommit] = useState('')
  const [directory, setDirectory] = useState('')
  const [listing, setListing] = useState<Listing | null>(null)
  const [discovered, setDiscovered] = useState<string[] | null>(null)
  const [discoveryError, setDiscoveryError] = useState<string | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [job, setJob] = useState<{ id: string; baseSha: string } | null>(null)
  const [pendingJobId, setPendingJobId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [initialization, setInitialization] = useState<Initialization | null>(null)
  const [initTitle, setInitTitle] = useState('Untitled Story')
  const [initPath, setInitPath] = useState('')
  const [initJobId, setInitJobId] = useState<string | null>(null)
  const [initialized, setInitialized] = useState<Initialized | null>(null)

  useEffect(() => {
    let cancelled = false
    setListing(null); setError(null); setSelection(null); setJob(null); setPendingJobId(null)
    const params = new URLSearchParams({ repositoryId, directory })
    if (commit) params.set('commit', commit)
    void api<Listing>('/api/github/stories?' + params).then(result => {
      if (cancelled) return
      setCommit(result.commit); setListing(result)
    }).catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'Unable to browse directory') })
    return () => { cancelled = true }
  }, [repositoryId, directory, commit])

  useEffect(() => {
    if (!commit) return
    let cancelled = false
    void api<Discovery>('/api/github/stories?' + new URLSearchParams({ repositoryId, commit, mode: 'discover' }))
      .then(result => { if (!cancelled) setDiscovered(result.stories) })
      .catch(e => { if (!cancelled) setDiscoveryError(e instanceof Error ? e.message : 'Discovery incomplete') })
    return () => { cancelled = true }
  }, [repositoryId, commit])

  useEffect(() => { setInitPath(directory) }, [directory])

  useEffect(() => {
    let cancelled = false
    setInitialization(null); setInitialized(null); setInitJobId(null)
    void api<Initialization>('/api/github/initialize?' + new URLSearchParams({ repositoryId, directory: initPath }))
      .then(result => { if (!cancelled) setInitialization(result) })
      .catch(() => { if (!cancelled) setInitialization(null) })
    return () => { cancelled = true }
  }, [repositoryId, initPath])

  const initialize = async () => {
    if (!initialization) return
    const jobId = initJobId ?? crypto.randomUUID()
    setInitJobId(jobId); setBusy(true); setError(null)
    try {
      const result = await api<Initialized>('/api/github/initialize', {
        repositoryId, directory: initialization.directory, title: initTitle, jobId, commit: initialization.commit,
      })
      setInitialized(result); setInitialization(null)
    } catch (e) { setError(e instanceof Error ? e.message : 'Story initialization failed') }
    finally { setBusy(false) }
  }

  const select = async () => {
    if (!commit || !listing?.isStory) return
    setBusy(true); setError(null); setSelection(null); setJob(null); setPendingJobId(null)
    try {
      const result = await api<Selection>('/api/github/stories', { repositoryId, directory, commit })
      setSelection(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Story preflight failed')
    } finally { setBusy(false) }
  }

  const createJob = async () => {
    if (!selection) return
    const jobId = pendingJobId ?? crypto.randomUUID()
    setPendingJobId(jobId); setBusy(true); setError(null)
    try {
      const result = await api<{ job: { id: string; baseSha: string } }>('/api/github/jobs', {
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
    <header><div><p className="eyebrow">NovelTea</p><h1>GitHub Story discovery</h1></div>
      <nav><a href="/dashboard">Dashboard</a></nav></header>
    <p>Browse the repository at a pinned Git commit. Only the selected Story's Git blobs are counted; unrelated game assets are not downloaded.</p>
    {commit && <p><strong>Commit:</strong> <code>{commit}</code>{' '}
      <button type="button" disabled={busy} onClick={() => { setCommit(''); setDiscovered(null); setDiscoveryError(null); setDirectory('') }}>Refresh HEAD</button></p>}
    {error && <p role="alert" className="error">{error}</p>}
    <section>
      <h2>Directory browser</h2>
      <p>Current path: <code>/{directory}</code></p>
      {directory && <button type="button" onClick={() => open(directory.split('/').slice(0, -1).join('/'))}>Up one directory</button>}
      {!listing && !error && <p>Loading directory…</p>}
      {listing && <ul>{listing.directories.map(entry =>
        <li key={entry.path}><button type="button" onClick={() => open(entry.path)}>{entry.name}/</button></li>
      )}</ul>}
      {listing && !listing.directories.length && <p>No child directories.</p>}
      {listing?.isStory && <div>
        <p>Canonical Story Markdown detected here. The 100 MB check must pass before the Story is registered.</p>
        <button type="button" disabled={busy} onClick={() => void select()}>{busy ? 'Verifying…' : 'Verify size and add Story'}</button>
      </div>}
      {selection && <div><p role="status">Added <strong>{selection.story.title}</strong> at commit <code>{selection.story.commit}</code>.
        {' '}{selection.sizeBytes.toLocaleString()} / {selection.limitBytes.toLocaleString()} bytes ({selection.blobCount} Git blobs).
      </p>
        <button type="button" disabled={busy || !!job} onClick={() => void createJob()}>
          {busy ? 'Preparing sparse checkout…' : 'Create isolated job worktree'}
        </button>
        {job && <p role="status">Job <code>{job.id}</code> is prepared at base <code>{job.baseSha}</code>.
          Generation starts through the future job execution flow; no agent has run yet.</p>}
      </div>}
    </section>
    <section>
      <h2>Initialize a new Story</h2>
      <p>Initialize canonical draft Story Markdown in an existing folder or a new path.
        An existing repository uses an isolated NovelTea branch for later review;
        its default branch is not changed. Only a completely empty repository
        can receive a one-time default-branch bootstrap commit.</p>
      <p>Need a new GitHub repository? <a href="https://github.com/new" target="_blank" rel="noreferrer">Create an empty repository on GitHub</a>,
        then connect it through <a href="/repositories/add">Add Repository</a> and return here.
        Do not create a README or initial commit on GitHub if you want the one-time bootstrap.</p>
      <label>Workspace directory (blank for repository root; creates a story/ child){' '}
        <input value={initPath} onChange={e => setInitPath(e.target.value)} disabled={busy} placeholder="stories/my-story" />
      </label>
      {initialization && <div>
        <p>Target: <code>/{initialization.directory}</code>.{' '}</p>
        <p>{initialization.mode === 'bootstrap'
          ? `Empty repository: initial commit will be pushed to ${initialization.defaultBranch}.`
          : `Existing repository: draft will be committed to a new isolated job branch based on ${initialization.commit}.`}</p>
        <label>Story title{' '}
          <input value={initTitle} maxLength={120} onChange={e => setInitTitle(e.target.value)} disabled={busy} />
        </label>{' '}
        <button type="button" disabled={busy || !initTitle.trim()} onClick={() => void initialize()}>
          {busy ? 'Initializing…' : 'Initialize draft Story'}
        </button>
      </div>}
      {initialized && <p role="status">
        Initialized <strong>{initialized.story.title}</strong> as job <code>{initialized.job.id}</code>
        {' '}at <code>{initialized.job.headSha}</code>.
        {initialized.published
          ? ' The first commit was pushed to the previously empty default branch.'
          : ' The draft commit is local to its NovelTea branch; default is unchanged. Publication and review are separate actions.'}
      </p>}
    </section>
    <section>
      <h2>Detected Story directories</h2>
      {discoveryError && <p role="status">{discoveryError} You can still browse directories manually.</p>}
      {discovered === null && !discoveryError && <p>Scanning Git tree metadata…</p>}
      {discovered && (discovered.length
        ? <ul>{discovered.map(path => <li key={path || '/'}><button type="button" onClick={() => open(path)}>{'/' + path}</button></li>)}</ul>
        : <p>No Story records detected at this commit. Browse manually if you expect a Story in a large monorepo.</p>)}
    </section>
  </main>
}
