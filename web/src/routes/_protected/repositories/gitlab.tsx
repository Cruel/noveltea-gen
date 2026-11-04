import { Button } from '@/components/ui/button'
import { StudioSelect } from '@/components/studio-select'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { settingsQuery } from '../../../lib/settings.queries'
import { importGitLabProject, listGitLabProjects } from '../../../lib/repositories.functions'

export const Route = createFileRoute('/_protected/repositories/gitlab')({ component: GitLabRepositories })

function GitLabRepositories() {
  const queryClient = useQueryClient()
  const { data: settings } = useSuspenseQuery(settingsQuery())
  const connections = settings.gitConnections.filter(item => item.provider === 'gitlab' && item.status === 'connected')
  const [connectionId, setConnectionId] = useState('')
  const [pageNumber, setPageNumber] = useState(1)
  const [notice, setNotice] = useState<string | null>(null)
  const [connectedId, setConnectedId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (connections.length === 1 && !connectionId) setConnectionId(connections[0]!.id)
  }, [connections, connectionId])
  const eligible = connections.length === 0 || !!connectionId
  const listing = useQuery({
    queryKey: ['gitlab-projects', connectionId, pageNumber] as const,
    queryFn: () => listGitLabProjects({ data: { page: pageNumber, ...(connectionId ? { connectionId } : {}) } }),
    enabled: eligible,
  })
  const page = listing.data
  async function load(number = pageNumber, selected = connectionId) {
    setError(null)
    if (number === pageNumber && selected === connectionId) {
      await listing.refetch()
    } else {
      setPageNumber(number)
      setConnectionId(selected)
    }
  }
  async function connect(projectId: number) {
    setBusy(true); setError(null); setNotice(null); setConnectedId(null)
    try {
      const result = await importGitLabProject({ data: { projectId, ...(connectionId ? { connectionId } : {}) } })
      setConnectedId(result.repository.id)
      setNotice(result.repository.name + ' connected.')
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    } catch (e) { setError(e instanceof Error ? e.message : 'Connection failed') }
    finally { setBusy(false) }
  }
  return <main className="page">
    <h1>Connect GitLab project</h1>
    <p>Personal and group projects where the chosen GitLab.com identity has Developer access or higher. Protected branches may impose additional push restrictions when publishing.</p>
    <Card>
      <CardHeader><CardTitle>GitLab identity</CardTitle></CardHeader>
      <CardContent className="grid gap-3">
        <label className="grid gap-2">Repository account
          <StudioSelect aria-label="Repository account" value={connectionId}
            onValueChange={value => { setConnectionId(value); setPageNumber(1) }}
            options={[{ value: '', label: connections.length
              ? 'Choose an account' : 'Historical login-linked identity' },
              ...connections.map(entry => ({ value: entry.id, label: entry.login }))]} />
        </label>
        {connections.length > 1 && !connectionId && <p>Select a GitLab account to browse projects.</p>}
        <p className="muted">Manage accounts in <a href="/settings#integrations">Settings → Git integrations</a>.</p>
      </CardContent>
    </Card>
    {error && <p role="alert" className="error">{error}</p>}
    {listing.error && <p role="alert" className="error">{listing.error.message}</p>}
    {notice && <p role="status">{notice} {connectedId && <a href={'/repositories/gitlab/' + connectedId}>Browse Stories</a>}</p>}
    <Card className="mt-4">
      <CardHeader><CardTitle>Push-access projects</CardTitle></CardHeader>
      <CardContent>
        <Button variant="outline" type="button" disabled={busy || !eligible} onClick={() => void load()}>Refresh</Button>
        {listing.isPending && eligible && <Skeleton className="my-3 h-12 w-full" />}
        {page && !page.projects.length && <p>No eligible projects on this page.</p>}
        {page && <ul>{page.projects.map(project => <li key={project.id}>
          {project.name} <Badge variant="secondary">{project.visibility}</Badge>
          {project.empty && <Badge variant="outline">Empty</Badge>}
          {' '}<Button type="button" disabled={busy} onClick={() => void connect(project.id)}>Connect</Button>
        </li>)}</ul>}
        {page && <div className="actions">
          <Button variant="outline" type="button" disabled={page.page <= 1 || busy} onClick={() => void load(page.page - 1)}>Previous</Button>
          <span>Page {page.page}</span>
          <Button variant="outline" type="button" disabled={!page.nextPage || busy} onClick={() => void load(page.nextPage!)}>Next</Button>
        </div>}
      </CardContent>
    </Card>
  </main>
}
