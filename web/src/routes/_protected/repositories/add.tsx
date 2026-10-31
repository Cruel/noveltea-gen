import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

type Installation = {
  id: number; account: string; accountType: string; selection: 'all' | 'selected'
  suspended: boolean; canImport: boolean; settingsUrl: string
}
type Repo = { id: number; fullName: string; private: boolean }
type Listing = {
  installations: Installation[]; repositories?: Repo[]; pending: string[]
  total?: number; page?: number; hasMore?: boolean
}

export const Route = createFileRoute('/_protected/repositories/add')({ component: AddRepository })

async function api<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(path, body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  } : { cache: 'no-store' })
  const result = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(result.error || 'Request failed')
  return result
}

function AddRepository() {
  const [data, setData] = useState<Listing | null>(null)
  const [installation, setInstallation] = useState<number | null>(null)
  const [page, setPage] = useState(1)
  const [fullName, setFullName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = async (id: number | null = installation, nextPage = page) => {
    try {
      const params = id === null ? '' : `?installationId=${id}&page=${nextPage}`
      const listing = await api<Listing>('/api/github/repositories' + params)
      setData(listing)
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to load repositories') }
  }

  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get('result')
    if (result === 'added') setNotice('Repository connected. You can now return to the dashboard.')
    if (result === 'installed') setNotice('Installation verified. Select a repository below to connect it.')
    if (result === 'pending') setNotice('The installation or repository selection is awaiting access or organization approval. Try again after GitHub grants access.')
    if (result === 'invalid') setError('Installation return could not be verified. Try installing the App again.')
    void refresh(null, 1)
    // Only load once; subsequent selection changes explicitly refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const choose = async (id: number | null, nextPage = 1) => {
    setInstallation(id); setPage(nextPage); setNotice(null)
    await refresh(id, nextPage)
  }
  const add = async (name: string) => {
    setBusy(true); setError(null); setNotice(null)
    try {
      const result = await api<{ repository: { name: string } }>('/api/github/repositories', { fullName: name })
      setNotice(`${result.repository.name} connected. Story discovery will be available in the next step.`)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Cannot connect repository')
    } finally { setBusy(false) }
  }
  const install = async (name?: string) => {
    setBusy(true); setError(null)
    try {
      const result = await api<{ url: string }>('/api/github/install', { fullName: name || null })
      window.location.assign(result.url)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start GitHub installation')
      setBusy(false)
    }
  }

  return <main className="page">
    <header><div><p className="eyebrow">NovelTea</p><h1>Add GitHub repository</h1></div>
      <nav><a href="/dashboard">Dashboard</a></nav></header>
    <p>Connect a repository you can push to. GitHub App installations determine which repositories NovelTea can access; signing in alone does not grant repository access.</p>
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="error">{error}</p>}
    <section>
      <h2>Add by URL</h2>
      <p>Enter a GitHub repository URL or owner/repository, including private organization repositories.</p>
      <form className="actions" onSubmit={event => { event.preventDefault(); void add(fullName) }}>
        <input aria-label="GitHub repository URL" style={{ minWidth: '19rem', padding: '.65rem', flex: 1 }} value={fullName}
          onChange={event => setFullName(event.target.value)} placeholder="https://github.com/owner/repo" required />
        <button type="submit" disabled={busy || !fullName.trim()}>Connect</button>
        <button type="button" disabled={busy} onClick={() => void install(fullName)}>Install / update access</button>
      </form>
      <p className="muted">If GitHub cannot find the repository, install the App or add it to your installation's selected repositories. Organization approval may be required.</p>
      {data?.pending?.length ? <div><h2>Awaiting GitHub approval or selection</h2><ul>{data.pending.map(name =>
        <li key={name}>{name} <button type="button" disabled={busy} onClick={() => void add(name)}>Retry connection</button></li>
      )}</ul></div> : null}
    </section>
    <section style={{ marginTop: '1rem' }}>
      <h2>Browse authorized installations</h2>
      <p>Only installed repositories where your user has push permission can be connected.</p>
      <div className="actions" style={{ justifyContent: 'flex-start' }}>
        <button type="button" onClick={() => void install()} disabled={busy}>Install GitHub App</button>
        <button type="button" onClick={() => void choose(null)} disabled={busy}>Refresh installations</button>
      </div>
      {!data && !error && <p>Loading installations…</p>}
      {data && !data.installations.length && <p>No authorized installations yet. Install the GitHub App to begin.</p>}
      {data?.installations.map(item => <div key={item.id}>
        <p><button type="button" disabled={busy || !item.canImport}
          onClick={() => void choose(item.id)}>{item.account} ({item.accountType})</button>
          {' '}<span className="pill">{item.selection === 'all' ? 'All repositories' : 'Selected repositories'}</span>
          {item.suspended ? ' — Suspended' : !item.canImport ? ' — Contents write permission required' : ''}
          {' '}<a href={item.settingsUrl} target="_blank" rel="noopener noreferrer">Configure access on GitHub</a>
        </p>
      </div>)}
      {installation !== null && data?.repositories && <>
        <h2>Push-access repositories</h2>
        {data.repositories.length ? <ul>{data.repositories.map(repo => <li key={repo.id}>
          {repo.fullName} {repo.private ? <span className="pill">Private</span> : null}
          {' '}<button type="button" disabled={busy} onClick={() => void add(repo.fullName)}>Connect</button>
        </li>)}</ul> : <p>No push-access repositories on this page of the installation.</p>}
        <div className="actions">
          <button type="button" disabled={page <= 1} onClick={() => void choose(installation, page - 1)}>Previous</button>
          <span>Page {page} (of {data.total ?? 0} total accessible repositories)</span>
          <button type="button" disabled={!data.hasMore} onClick={() => void choose(installation, page + 1)}>Next</button>
        </div>
      </>}
    </section>
  </main>
}
