import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

type Project = { id: number; name: string; path: string; visibility: string; empty: boolean }
type Page = { projects: Project[]; page: number; nextPage: number | null; error?: string }
export const Route = createFileRoute('/_protected/repositories/gitlab')({ component: GitLabRepositories })

function GitLabRepositories() {
  const [page, setPage] = useState<Page | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [connectedId, setConnectedId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [connections, setConnections] = useState<Array<{ id: string; login: string; provider: string; status: string }>>([])
  const [connectionId, setConnectionId] = useState('')
  async function load(number = 1, selected = connectionId) {
    setError(null)
    try {
      const params = new URLSearchParams({ page: String(number) })
      if (selected) params.set('connectionId', selected)
      const response = await fetch('/api/gitlab/repositories?' + params, { cache: 'no-store' })
      const body = await response.json() as Page
      if (!response.ok) throw new Error(body.error || 'Could not fetch GitLab projects')
      setPage(body)
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to load GitLab projects') }
  }
  useEffect(() => {
    void fetch('/api/integrations/git', { cache: 'no-store' })
      .then(r => r.json() as Promise<{ connections: typeof connections }>)
      .then(data => {
        const entries = (data.connections ?? []).filter(item => item.provider === 'gitlab' && item.status === 'connected')
        setConnections(entries)
        const selected = entries.length === 1 ? entries[0]!.id : ''
        setConnectionId(selected)
        void load(1, selected)
      }).catch(() => void load())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  async function connect(projectId: number) {
    setBusy(true); setError(null); setNotice(null); setConnectedId(null)
    try {
      const response = await fetch('/api/gitlab/repositories', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, ...(connectionId ? { connectionId } : {}) }),
      })
      const body = await response.json() as { repository?: { id: string; name: string }; error?: string }
      if (!response.ok) throw new Error(body.error || 'GitLab project connection failed')
      setConnectedId(body.repository!.id)
      setNotice(body.repository!.name + ' connected.')
    } catch (e) { setError(e instanceof Error ? e.message : 'Connection failed') }
    finally { setBusy(false) }
  }
  return <main className="page">
    <header><div><p className="eyebrow">NovelTea</p><h1>Connect GitLab project</h1></div><nav><a href="/dashboard">Dashboard</a><a href="/settings">Settings</a></nav></header>
    <p>Personal and group projects where your chosen GitLab.com account has Developer access or higher. Protected branches may impose additional push restrictions when publishing.</p>
    <label>Repository account
      <select value={connectionId} onChange={e => {
        setConnectionId(e.target.value); setPage(null); void load(1, e.target.value)
      }}>
        <option value="">{connections.length ? 'Choose a GitLab account' : 'Historical login-linked identity'}</option>
        {connections.map(entry => <option key={entry.id} value={entry.id}>{entry.login}</option>)}
      </select>
    </label>
    {connections.length > 1 && !connectionId && <p>Select a GitLab account to browse projects.</p>}
    <p className="muted">Manage accounts in <a href="/settings#integrations">Settings → Git integrations</a>.</p>
    {error && <p role="alert" className="error">{error}</p>}
    {notice && <p role="status">{notice} {connectedId && <a href={'/repositories/gitlab/' + connectedId}>Browse Stories</a>}</p>}
    <section>
      <h2>Push-access projects</h2>
      <button type="button" disabled={busy} onClick={() => void load(page?.page || 1)}>Refresh</button>
      {!page && !error && <p>Loading projects…</p>}
      {page && !page.projects.length && <p>No eligible projects on this page.</p>}
      {page && <ul>{page.projects.map(project => <li key={project.id}>
        {project.name} <span className="pill">{project.visibility}</span>
        {project.empty && <span className="pill">Empty</span>}
        {' '}<button type="button" disabled={busy} onClick={() => void connect(project.id)}>Connect</button>
      </li>)}</ul>}
      {page && <div className="actions">
        <button type="button" disabled={page.page <= 1 || busy} onClick={() => void load(page.page - 1)}>Previous</button>
        <span>Page {page.page}</span>
        <button type="button" disabled={!page.nextPage || busy} onClick={() => void load(page.nextPage!)}>Next</button>
      </div>}
    </section>
  </main>
}
