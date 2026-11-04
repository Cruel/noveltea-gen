import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { LogOut, Settings } from 'lucide-react'
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
  const [signingOut, setSigningOut] = useState(false)
  const initials = dashboard.user.name?.trim().split(/\s+/).slice(0, 2)
    .map(part => part.charAt(0)).join('').toUpperCase() || dashboard.user.email.charAt(0).toUpperCase()
  const disconnect = async () => {
    if (signingOut) return
    setSigningOut(true)
    setError(null)
    try {
      const response = await authClient.signOut()
      if (response.error) setError(response.error.message || 'Sign out failed')
      else {
        // Never let the next signed-in user see cached data from the previous account.
        queryClient.clear()
        await router.navigate({ to: '/login' })
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sign out failed')
    } finally {
      setSigningOut(false)
    }
  }
  return <main className="page">
    <header className="pb-4">
      <div><p className="eyebrow">NovelTea</p><h1 className="mb-0">Story Studio</h1></div>
      <DropdownMenu>
        <DropdownMenuTrigger aria-label="Account menu" title="Account menu"
          className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
          <Avatar size="lg">
            <AvatarFallback className="bg-secondary font-medium text-secondary-foreground">{initials}</AvatarFallback>
          </Avatar>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <div className="min-w-0 px-2 py-2">
            <p className="m-0 truncate text-sm font-medium text-popover-foreground">{dashboard.user.name}</p>
            <p className="m-0 truncate text-xs text-muted-foreground" title={dashboard.user.email}>{dashboard.user.email}</p>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => void router.navigate({ to: '/settings' })}>
            <Settings className="size-4" /> Settings
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={signingOut} variant="destructive" onClick={() => void disconnect()}>
            <LogOut className="size-4" /> {signingOut ? 'Signing out…' : 'Sign out'}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
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
