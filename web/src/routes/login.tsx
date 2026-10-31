import { createFileRoute, redirect } from '@tanstack/react-router'
import { useState } from 'react'
import { authClient } from '../lib/auth-client'
import { getViewer } from '../lib/dashboard.functions'

export const Route = createFileRoute('/login')({
  beforeLoad: async () => { if (await getViewer()) throw redirect({ to: '/dashboard' }) },
  component: Login,
})

function Login() {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const signIn = async (provider: 'github' | 'gitlab') => {
    setPending(provider)
    setError(null)
    const result = await authClient.signIn.social({ provider, callbackURL: '/dashboard' })
    if (result.error) { setError(result.error.message || 'Sign-in failed'); setPending(null) }
  }
  return <main className="page center">
    <p className="eyebrow">NovelTea</p>
    <h1>Story Studio</h1>
    <p>Sign in using your Git provider. Your connected identity will also be available for repository operations.</p>
    <div className="actions">
      <button type="button" disabled={pending !== null} onClick={() => void signIn('github')}>Sign in with GitHub</button>
      <button type="button" disabled={pending !== null} onClick={() => void signIn('gitlab')}>Sign in with GitLab.com</button>
    </div>
    {error && <p role="alert" className="error">{error}</p>}
  </main>
}
