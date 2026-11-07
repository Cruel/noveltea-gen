import { Button } from '@/components/ui/button'
import { GitProviderIcon } from '@/components/git-provider-icon'
import { useEffect, useState } from 'react'
import { NewStoryOnboarding } from './-NewStoryOnboarding'
import { inspectRepositoryInitialization, readRepositoryStories,
  selectRepositoryStory, prepareRepositoryJob } from '../../../lib/story-workflows.functions'
import type { CatalogProvider } from '../../../persistence/contracts'
import type { RepositoryBrowseSearch } from '../../../lib/repository-story-navigation'

type Listing = {
  commit: string; directory: string; isStory: boolean
  directories: Array<{ name: string; path: string }>
}
type Discovery = { commit: string; stories: string[] }
type Selection = {
  story: { id: string; title: string; directory: string; commit: string }
  sizeBytes: number; limitBytes: number; blobCount: number
}
type InitState = { empty: boolean }

export type RepositoryStoryBrowserProps = {
  provider: CatalogProvider
  repositoryId: string
  location: RepositoryBrowseSearch
  onNavigate: (location: RepositoryBrowseSearch, replace?: boolean) => void
}

/**
 * The same remote Story browser for GitHub and GitLab. Provider-specific
 * authorization, pagination, size/LFS checks and writes stay in server adapters.
 */
export function RepositoryStoryBrowser({ provider, repositoryId, location, onNavigate }:
  RepositoryStoryBrowserProps) {
  const { directory, commit } = location
  const [empty, setEmpty] = useState<boolean | null>(provider === 'github' ? false : null)
  const [listing, setListing] = useState<Listing | null>(null)
  const [discovered, setDiscovered] = useState<string[] | null>(null)
  const [discoveryError, setDiscoveryError] = useState<string | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [job, setJob] = useState<{ id: string; baseSha: string } | null>(null)
  const [pendingJobId, setPendingJobId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [refreshRevision, setRefreshRevision] = useState(0)

  // GitLab exposes empty-repository status explicitly; GitHub signals an
  // unborn HEAD while browsing. Both become the same empty-state UI.
  useEffect(() => {
    let cancelled = false
    // Keep an active onboarding form mounted during a repository refresh.
    // A new repository mounts a new browser instance from its route wrapper.
    if (provider === 'github') setEmpty(false)
    setError(null)
    if (provider === 'gitlab') {
      void inspectRepositoryInitialization({ data: { provider, repositoryId } })
        .then(text => {
          if (!cancelled) setEmpty((JSON.parse(text) as InitState).empty)
        })
        .catch(cause => {
          if (!cancelled) setError(cause instanceof Error ? cause.message : 'Unable to inspect repository')
        })
    }
    return () => { cancelled = true }
  }, [provider, repositoryId, refreshRevision])

  useEffect(() => {
    if (empty !== false) return
    let cancelled = false
    setListing(null); setError(null); setSelection(null); setJob(null); setPendingJobId(null)
    void readRepositoryStories({ data: {
      provider, repositoryId, directory, ...(commit ? { commit } : {}),
    } }).then(text => {
      if (cancelled) return
      const result = JSON.parse(text) as Listing
      setListing(result)
      if (!commit) onNavigate({ directory, commit: result.commit }, true)
    }).catch(cause => {
      if (cancelled) return
      const message = cause instanceof Error ? cause.message : 'Unable to browse directory'
      if (provider === 'github' && !commit && /no commits|empty repository/i.test(message)) {
        setEmpty(true)
      } else setError(message)
    })
    return () => { cancelled = true }
  }, [provider, repositoryId, directory, commit, empty, refreshRevision])

  useEffect(() => {
    if (!commit || empty !== false) {
      setDiscovered(null); setDiscoveryError(null)
      return
    }
    let cancelled = false
    setDiscovered(null); setDiscoveryError(null)
    void readRepositoryStories({ data: { provider, repositoryId, commit, mode: 'discover' } })
      .then(text => {
        if (!cancelled) setDiscovered((JSON.parse(text) as Discovery).stories)
      })
      .catch(cause => {
        if (!cancelled) setDiscoveryError(cause instanceof Error ? cause.message : 'Discovery incomplete')
      })
    return () => { cancelled = true }
  }, [provider, repositoryId, commit, empty])

  const select = async () => {
    if (!commit || !listing?.isStory) return
    setBusy(true); setError(null); setSelection(null); setJob(null); setPendingJobId(null)
    try {
      setSelection(JSON.parse(await selectRepositoryStory({ data: {
        provider, json: JSON.stringify({ repositoryId, directory, commit }),
      } })) as Selection)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Story preflight failed')
    } finally { setBusy(false) }
  }
  const createJob = async () => {
    if (!selection) return
    const jobId = pendingJobId ?? crypto.randomUUID()
    setPendingJobId(jobId); setBusy(true); setError(null)
    try {
      const result = JSON.parse(await prepareRepositoryJob({ data: {
        provider, json: JSON.stringify({ storyId: selection.story.id, jobId,
          commit: selection.story.commit }),
      } })) as { job: { id: string; baseSha: string } }
      setJob(result.job)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to acquire the selected Story')
    } finally { setBusy(false) }
  }

  const open = (path: string) => {
    if (busy) return
    setError(null); setSelection(null); setJob(null); setPendingJobId(null)
    onNavigate({ directory: path, commit })
  }

  return <main className="page">
    <h1>Repository Stories</h1>
    <p className="flex items-center gap-2 text-sm">
      <GitProviderIcon provider={provider} />
      Browse Story directories at a pinned Git revision without cloning unrelated assets.
    </p>
    {commit && <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
      <span>Commit: <code title={commit}>{commit.slice(0, 12)}</code></span>
      <Button type="button" size="sm" variant="outline" disabled={busy}
        onClick={() => onNavigate({ directory: '', commit: '' })}>Refresh HEAD</Button>
    </div>}
    {error && <p role="alert" className="error">{error}</p>}
    {empty === null && !error && <p role="status">Inspecting repository…</p>}
    {empty === true && <div className="mb-3 flex flex-wrap items-center gap-3">
      <p role="status">This repository has no commits yet. Create its first Story below.</p>
      <Button type="button" size="sm" variant="outline"
        onClick={() => setRefreshRevision(n => n + 1)}>Refresh repository</Button>
    </div>}
    {empty === false && <section>
      <h2>Directory browser</h2>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">/{directory}</span>
        {directory && <Button type="button" size="sm" variant="outline" disabled={busy}
          onClick={() => open(directory.split('/').slice(0, -1).join('/'))}>Up one directory</Button>}
      </div>
      {!listing && !error && <p>Loading directory…</p>}
      {listing && <ul>{listing.directories.map(entry =>
        <li key={entry.path}><Button type="button" size="sm" variant="ghost" disabled={busy}
          onClick={() => open(entry.path)}>{entry.name}/</Button></li>
      )}</ul>}
      {listing && !listing.directories.length && <p>No child directories.</p>}
      {listing?.isStory && <div>
        <p>Canonical Story records detected. The 100 MB uncompressed Git-blob size check
          must pass before the Story can be added.</p>
        <Button type="button" disabled={busy || !commit}
          onClick={() => void select()}>{busy ? 'Verifying…' : 'Verify size and add Story'}</Button>
      </div>}
      {selection && <div>
        <p role="status">Added <strong>{selection.story.title}</strong> at commit
          {' '}<code>{selection.story.commit}</code>.
          {' '}{selection.sizeBytes.toLocaleString()} / {selection.limitBytes.toLocaleString()}
          {' '}bytes ({selection.blobCount} Git blobs).</p>
        <Button type="button" disabled={busy || !!job} onClick={() => void createJob()}>
          {busy ? 'Preparing sparse checkout…' : 'Create isolated job worktree'}
        </Button>
        {job && <p role="status">Job <code>{job.id}</code> is prepared at base <code>{job.baseSha}</code>.
          {' '}<a href={'/jobs/' + job.id}>Open job</a>.</p>}
      </div>}
    </section>}
    {empty === false && <section>
      <h2>Detected Story directories</h2>
      {discoveryError && <p role="status">{discoveryError} You can still browse manually.</p>}
      {discovered === null && !discoveryError && <p>Scanning Git tree metadata…</p>}
      {discovered && (discovered.length
        ? <ul>{discovered.map(path => <li key={path || '/'}>
          <Button type="button" size="sm" variant="ghost" disabled={busy}
            onClick={() => open(path)}>{'/' + path}</Button>
        </li>)}</ul>
        : <p>No Story records detected at this commit. Browse manually if this is a large repository.</p>)}
    </section>}
    {(empty !== null || provider === 'github') && <NewStoryOnboarding
      key={provider + ':' + repositoryId + ':' + directory}
      provider={provider} repositoryId={repositoryId} initialWorkspace={directory}
      onCreated={() => setRefreshRevision(n => n + 1)} />}
  </main>
}
