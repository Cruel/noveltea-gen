import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { dashboardQuery } from '../../lib/dashboard.queries'
import { authClient } from '../../lib/auth-client'

export const Route = createFileRoute('/_protected/dashboard')({
  loader: ({ context }) => context.queryClient.ensureQueryData(dashboardQuery()),
  component: Dashboard,
})

function Dashboard() {
  const { data: dashboard } = useSuspenseQuery(dashboardQuery())
  const queryClient = useQueryClient()
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const disconnect = async () => {
    const response = await authClient.signOut()
    if (response.error) setError(response.error.message || 'Sign out failed')
    else {
      // Never let the next signed-in user see cached data from the previous account.
      queryClient.clear()
      await router.navigate({ to: '/login' })
    }
  }
  return <main className="page">
    <header>
      <div><p className="eyebrow">NovelTea</p><h1>Story Studio</h1></div>
      <nav aria-label="Main navigation"><a href="/dashboard" aria-current="page">Dashboard</a><a href="/settings">Settings</a><Button variant="outline" type="button" onClick={() => void disconnect()}>Sign out</Button></nav>
    </header>
    <p>Signed in as <strong>{dashboard.user.name}</strong> ({dashboard.user.email})</p>
    <p>Manage <a href="/settings#integrations">repository integrations</a> and <a href="/settings#account">login methods</a> independently in Settings.</p>
    {error && <p role="alert" className="error">{error}</p>}
    <div className="dashboard-grid">
      <Card><CardHeader><CardTitle>Stories</CardTitle></CardHeader><CardContent>
        {dashboard.stories.length ? <ul>{dashboard.stories.map(story => {
          const provider = dashboard.repositories.find(repo => repo.id === story.repositoryId)?.provider
          const href = provider === 'gitlab' && story.commitSha
            ? '/repositories/gitlab/' + story.repositoryId + '?' +
              new URLSearchParams({ directory: story.directory, commit: story.commitSha })
            : null
          return <li key={story.id}>{href ? <a href={href}>{story.title}</a> : story.title}</li>
        })}</ul> : <p>No Stories imported yet.</p>}
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Active jobs</CardTitle></CardHeader><CardContent>
        {dashboard.activeJobs.length ? <ul>{dashboard.activeJobs.map(job => <li key={job.id}><a href={'/jobs/' + job.id}>{job.title}</a> <Badge variant="secondary">{job.status}</Badge></li>)}</ul> : <p>No active jobs.</p>}
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Recent sessions</CardTitle></CardHeader><CardContent>
        {dashboard.recentSessions.length ? <ul>{dashboard.recentSessions.map(job => <li key={job.id}><a href={'/jobs/' + job.id}>{job.title}</a> <Badge variant="secondary">{job.status}</Badge></li>)}</ul> : <p>No recent sessions.</p>}
      </CardContent></Card>
    </div>
    <Card className="mt-5"><CardHeader><CardTitle>Repositories</CardTitle></CardHeader><CardContent>
      <p><a href="/repositories/add">Add GitHub repository</a> · <a href="/repositories/gitlab">Add GitLab project</a></p>
      {dashboard.repositories.length ? <ul>{dashboard.repositories.map(repo => <li key={repo.id}>{repo.name} <Badge variant="outline">{repo.provider}</Badge>{' '}<a href={'/repositories/' + repo.provider + '/' + repo.id}>Browse Stories</a></li>)}</ul> : <p>No repositories connected yet.</p>}
    </CardContent></Card>
  </main>
}
