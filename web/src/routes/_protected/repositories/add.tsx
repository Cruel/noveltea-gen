import { Button } from '@/components/ui/button'
import { StudioSelect } from '@/components/studio-select'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { settingsQuery } from '../../../lib/settings.queries'
import { beginGitHubInstallation, importGitHubRepository, listGitHubRepositories } from '../../../lib/repositories.functions'

export const Route = createFileRoute('/_protected/repositories/add')({ component: AddRepository })

function AddRepository() {
  const queryClient = useQueryClient()
  const { data: settings } = useSuspenseQuery(settingsQuery())
  const connections = settings.gitConnections.filter(item => item.provider === 'github' && item.status === 'connected')
  const [installation, setInstallation] = useState<number | null>(null)
  const [page, setPage] = useState(1)
  const [fullName, setFullName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [connectedId, setConnectedId] = useState<string | null>(null)
  const [connectionId, setConnectionId] = useState('')
  useEffect(() => {
    if (connections.length === 1 && !connectionId) setConnectionId(connections[0]!.id)
  }, [connections, connectionId])
  const eligible = connections.length === 0 || !!connectionId
  const listing = useQuery({
    queryKey: ['github-repositories', connectionId, installation, page] as const,
    queryFn: () => listGitHubRepositories({ data: {
      ...(connectionId ? { connectionId } : {}),
      ...(installation !== null ? { installationId: installation, page } : {}),
    } }),
    enabled: eligible,
  })
  const data = listing.data
  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get('result')
    if (result === 'added') setNotice('Repository connected. You can now return to the dashboard.')
    if (result === 'installed') setNotice('Installation verified. Select a repository below to connect it.')
    if (result === 'pending') setNotice('The installation or repository selection is awaiting access or organization approval. Try again after GitHub grants access.')
    if (result === 'invalid') setError('Installation return could not be verified. Try installing the App again.')
  }, [])
  const choose = async (id: number | null, nextPage = 1) => {
    setInstallation(id); setPage(nextPage); setNotice(null)
    if (id === installation && page === nextPage) await listing.refetch()
  }
  const add = async (name: string) => {
    setBusy(true); setError(null); setNotice(null); setConnectedId(null)
    try {
      const result = await importGitHubRepository({ data: { fullName: name, ...(connectionId ? { connectionId } : {}) } })
      setConnectedId(result.repository.id)
      setNotice(`${result.repository.name} connected.`)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['github-repositories'] }),
      ])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Cannot connect repository')
    } finally { setBusy(false) }
  }
  const install = async (name?: string) => {
    setBusy(true); setError(null)
    try {
      const result = await beginGitHubInstallation({ data: {
        fullName: name || null, ...(connectionId ? { connectionId } : {}),
      } })
      window.location.assign(result.url)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start GitHub installation')
      setBusy(false)
    }
  }

  return <main className="page">
    <h1>Add GitHub repository</h1>
    <p>Connect a repository you can push to. GitHub App installations determine which repositories NovelTea can access.</p>
    <Card>
      <CardHeader><CardTitle>Repository identity</CardTitle></CardHeader>
      <CardContent className="grid gap-2">
        <label className="grid gap-2">Repository account
          <StudioSelect aria-label="Repository account" value={connectionId}
            onValueChange={value => { setConnectionId(value); setInstallation(null); setPage(1) }}
            options={[{ value: '', label: connections.length
              ? 'Choose a connected GitHub account' : 'Historical login-linked identity' },
              ...connections.map(entry => ({ value: entry.id, label: entry.login }))]} />
        </label>
        {connections.length > 1 && !connectionId && <p>Select an account before browsing or importing repositories.</p>}
        <p className="muted">Manage accounts in <a href="/settings#integrations">Settings → Git integrations</a>.</p>
      </CardContent>
    </Card>
    {notice && <p role="status">{notice} {connectedId && <a href={'/repositories/github/' + connectedId}>Browse Stories</a>}</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {listing.error && <p role="alert" className="error">{listing.error.message}</p>}
    <Card className="mt-4">
      <CardHeader><CardTitle>Add by URL</CardTitle></CardHeader>
      <CardContent>
        <p>Enter a GitHub repository URL or owner/repository, including private organization repositories.</p>
        <form className="actions" onSubmit={event => { event.preventDefault(); void add(fullName) }}>
          <Input aria-label="GitHub repository URL" className="min-w-72 flex-1" value={fullName}
            onChange={event => setFullName(event.target.value)} placeholder="https://github.com/owner/repo" required />
          <Button type="submit" disabled={busy || !eligible || !fullName.trim()}>Connect</Button>
          <Button variant="outline" type="button" disabled={busy || !eligible} onClick={() => void install(fullName)}>Install / update access</Button>
        </form>
        <p className="muted">If GitHub cannot find the repository, install the App or add it to your installation's selected repositories. Organization approval may be required.</p>
        {data?.pending?.length ? <div><h2>Awaiting GitHub approval or selection</h2><ul>{data.pending.map(name =>
          <li key={name}>{name} <Button type="button" disabled={busy} onClick={() => void add(name)}>Retry connection</Button></li>
        )}</ul></div> : null}
      </CardContent>
    </Card>
    <Card className="mt-4">
      <CardHeader><CardTitle>Browse authorized installations</CardTitle></CardHeader>
      <CardContent>
        <p>Only installed repositories where your user has push permission can be connected.</p>
        <div className="actions justify-start">
          <Button type="button" onClick={() => void install()} disabled={busy || !eligible}>Install GitHub App</Button>
          <Button variant="outline" type="button" onClick={() => void choose(null)} disabled={busy || !eligible}>Refresh installations</Button>
        </div>
        {listing.isPending && eligible && <Skeleton className="my-3 h-14 w-full" />}
        {data && !data.installations.length && <p>No authorized installations yet. Install the GitHub App to begin.</p>}
        {data?.installations.map(item => <div key={item.id}>
          <p><Button variant="outline" type="button" disabled={busy || !item.canImport}
            onClick={() => void choose(item.id)}>{item.account} ({item.accountType})</Button>
            {' '}<Badge variant="secondary">{item.selection === 'all' ? 'All repositories' : 'Selected repositories'}</Badge>
            {item.suspended ? ' — Suspended' : !item.canImport ? ' — Contents write permission required' : ''}
            {' '}<a href={item.settingsUrl} target="_blank" rel="noopener noreferrer">Configure access on GitHub</a>
          </p>
        </div>)}
        {installation !== null && data?.repositories && <>
          <h2>Push-access repositories</h2>
          {data.repositories.length ? <ul>{data.repositories.map(repo => <li key={repo.id}>
            {repo.fullName} {repo.private && <Badge variant="outline">Private</Badge>}
            {' '}<Button type="button" disabled={busy} onClick={() => void add(repo.fullName)}>Connect</Button>
          </li>)}</ul> : <p>No push-access repositories on this page of the installation.</p>}
          <div className="actions">
            <Button variant="outline" type="button" disabled={page <= 1} onClick={() => void choose(installation, page - 1)}>Previous</Button>
            <span>Page {page} (of {data.total ?? 0} total accessible repositories)</span>
            <Button variant="outline" type="button" disabled={!data.hasMore} onClick={() => void choose(installation, page + 1)}>Next</Button>
          </div>
        </>}
      </CardContent>
    </Card>
  </main>
}
