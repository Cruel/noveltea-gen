import { createFileRoute } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { dashboardQuery } from '../../lib/dashboard.queries'
import { AddRepositoryDialog } from '@/components/add-repository-dialog'
import { GitProviderIcon } from '@/components/git-provider-icon'
import { repositoryBrowseHref } from '../../lib/repository-story-navigation'

export const Route = createFileRoute('/_protected/dashboard')({
  loader: ({ context }) => context.queryClient.ensureQueryData(dashboardQuery()),
  component: Dashboard,
})

function Dashboard() {
  const { data: dashboard } = useSuspenseQuery(dashboardQuery())
  return <main className="page">
    <div className="dashboard-grid">
      <Card><CardHeader><CardTitle>Stories</CardTitle></CardHeader><CardContent>
        {dashboard.stories.length ? <ul>{dashboard.stories.map(story => {
          const repository = dashboard.repositories.find(repo => repo.id === story.repositoryId)
          const href = repository
            ? repositoryBrowseHref(repository.id, story.directory, story.commitSha)
            : null
          return <li key={story.id} className="flex flex-wrap items-center gap-2">
            {repository && <GitProviderIcon provider={repository.provider} />}
            <a href={'/stories/' + encodeURIComponent(story.id) + '/conversations'}>{story.title}</a>
            {repository && <span className="text-xs text-muted-foreground">{repository.name}</span>}
            {href && <a href={href} className="text-xs text-muted-foreground">Browse repository</a>}
          </li>
        })}</ul> : <p>No Stories imported yet.</p>}
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Active jobs</CardTitle></CardHeader><CardContent>
        {dashboard.activeJobs.length ? <ul>{dashboard.activeJobs.map(job => <li key={job.id}><a href={'/jobs/' + job.id}>{job.title}</a> <Badge variant="secondary">{job.status}</Badge></li>)}</ul> : <p>No active jobs.</p>}
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Recent sessions</CardTitle></CardHeader><CardContent>
        {dashboard.recentSessions.length ? <ul>{dashboard.recentSessions.map(job => <li key={job.id}><a href={'/jobs/' + job.id}>{job.title}</a> <Badge variant="secondary">{job.status}</Badge></li>)}</ul> : <p>No recent sessions.</p>}
      </CardContent></Card>
    </div>
    <Card className="mt-5"><CardHeader className="flex flex-row items-center justify-between gap-3">
      <CardTitle>Repositories</CardTitle><AddRepositoryDialog />
    </CardHeader><CardContent>
      {dashboard.repositories.length ? <ul>{dashboard.repositories.map(repo =>
        <li key={repo.id} className="flex flex-wrap items-center gap-2">
          <GitProviderIcon provider={repo.provider} />{repo.name}
          <a href={repositoryBrowseHref(repo.id)}>Browse Stories</a>
        </li>
      )}</ul> : <p>No repositories connected yet.</p>}
    </CardContent></Card>
  </main>
}
