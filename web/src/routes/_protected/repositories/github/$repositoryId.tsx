import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

type Listing = { commit: string; directory: string; isStory: boolean; directories: Array<{ name: string; path: string }> }
type Discovery = { commit: string; stories: string[] }
type Selection = { story: { id: string; title: string; directory: string; commit: string }; sizeBytes: number; limitBytes: number; blobCount: number }

export const Route = createFileRoute('/_protected/repositories/github/$repositoryId')({
  component: GithubStories,
})

async function api<T>(query: string, body?: object): Promise<T> {
  const response = await fetch('/api/github/stories' + query, body ? {
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
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    setListing(null); setError(null); setSelection(null)
    const params = new URLSearchParams({ repositoryId, directory })
    if (commit) params.set('commit', commit)
    void api<Listing>('?' + params).then(result => {
      if (cancelled) return
      setCommit(result.commit); setListing(result)
    }).catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'Unable to browse directory') })
    return () => { cancelled = true }
  }, [repositoryId, directory, commit])

  useEffect(() => {
    if (!commit) return
    let cancelled = false
    void api<Discovery>('?' + new URLSearchParams({ repositoryId, commit, mode: 'discover' }))
      .then(result => { if (!cancelled) setDiscovered(result.stories) })
      .catch(e => { if (!cancelled) setDiscoveryError(e instanceof Error ? e.message : 'Discovery incomplete') })
    return () => { cancelled = true }
  }, [repositoryId, commit])

  const select = async () => {
    if (!commit || !listing?.isStory) return
    setBusy(true); setError(null); setSelection(null)
    try {
      const result = await api<Selection>('', { repositoryId, directory, commit })
      setSelection(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Story preflight failed')
    } finally { setBusy(false) }
  }

  const open = (path: string) => {
    setError(null); setSelection(null); setDirectory(path)
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
      {selection && <p role="status">Added <strong>{selection.story.title}</strong> at commit <code>{selection.story.commit}</code>.
        {' '}{selection.sizeBytes.toLocaleString()} / {selection.limitBytes.toLocaleString()} bytes ({selection.blobCount} Git blobs).
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
