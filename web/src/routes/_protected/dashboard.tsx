import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { getDashboard } from '../../lib/dashboard.functions'
import { authClient } from '../../lib/auth-client'

export const Route = createFileRoute('/_protected/dashboard')({
  loader: () => getDashboard(),
  component: Dashboard,
})

function Dashboard() {
  const dashboard = Route.useLoaderData()
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState<string | null>(null)
  const connect = async (provider: 'github' | 'gitlab') => {
    setWorking(provider)
    setError(null)
    const response = await authClient.linkSocial({ provider, callbackURL: '/dashboard' })
    if (response.error) { setError(response.error.message || 'Could not link account'); setWorking(null) }
  }
  const disconnect = async () => {
    const response = await authClient.signOut()
    if (response.error) setError(response.error.message || 'Sign out failed')
    else await router.navigate({ to: '/login' })
  }
  return <main className="page">
    <header>
      <div><p className="eyebrow">NovelTea</p><h1>Story Studio</h1></div>
      <nav aria-label="Main navigation"><a href="/dashboard" aria-current="page">Dashboard</a><button type="button" onClick={() => void disconnect()}>Sign out</button></nav>
    </header>
    <p>Signed in as <strong>{dashboard.user.name}</strong> ({dashboard.user.email})</p>
    <section>
      <h2>Connected repository identities</h2>
      <p>Signing in connects that provider automatically. Link the other provider here to use both without signing in again.</p>
      <div className="actions">
        {(['github', 'gitlab'] as const).map(provider => (
          dashboard.connectedProviders.includes(provider)
            ? <span className="pill" key={provider}>{provider === 'github' ? 'GitHub' : 'GitLab.com'} connected</span>
            : <button type="button" key={provider} disabled={working !== null} onClick={() => void connect(provider)}>Link {provider === 'github' ? 'GitHub' : 'GitLab.com'}</button>
        ))}
      </div>
      {error && <p role="alert" className="error">{error}</p>}
    </section>
    <div className="grid">
      <section><h2>Stories</h2>
        {dashboard.stories.length ? <ul>{dashboard.stories.map(story => <li key={story.id}>{story.title}</li>)}</ul> : <p>No Stories imported yet.</p>}
      </section>
      <section><h2>Active jobs</h2>
        {dashboard.activeJobs.length ? <ul>{dashboard.activeJobs.map(job => <li key={job.id}>{job.title} <span className="pill">{job.status}</span></li>)}</ul> : <p>No active jobs.</p>}
      </section>
      <section><h2>Recent sessions</h2>
        {dashboard.recentSessions.length ? <ul>{dashboard.recentSessions.map(job => <li key={job.id}>{job.title} <span className="pill">{job.status}</span></li>)}</ul> : <p>No recent sessions.</p>}
      </section>
    </div>
    <section style={{ marginTop: '1rem' }}><h2>Repositories</h2>
      {dashboard.repositories.length ? <ul>{dashboard.repositories.map(repo => <li key={repo.id}>{repo.name} <span className="pill">{repo.provider}</span></li>)}</ul> : <p>Repository import will be available in a later milestone.</p>}
    </section>
  </main>
}
