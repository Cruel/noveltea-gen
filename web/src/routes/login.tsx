import { createFileRoute, redirect } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { authClient } from '../lib/auth-client'
import { getViewer } from '../lib/dashboard.functions'
import { oauthLoginError } from '../lib/oauth-login-error'

export const Route = createFileRoute('/login')({
  beforeLoad: async () => { if (await getViewer()) throw redirect({ to: '/dashboard' }) },
  component: Login,
})

function Login() {
  const [error, setError] = useState<string | null>(null)
  const [callbackError, setCallbackError] = useState<string | null>(null)
  const [lastUsed, setLastUsed] = useState<string | null>(null)
  useEffect(() => {
    const method = authClient.getLastUsedLoginMethod()
    setLastUsed(method)
    setCallbackError(oauthLoginError(new URLSearchParams(window.location.search), method))
  }, [])
  const [pending, setPending] = useState<string | null>(null)
  const signIn = async (provider: 'github' | 'gitlab') => {
    setPending(provider)
    setError(null)
    const result = await authClient.signIn.social({ provider, callbackURL: '/dashboard', errorCallbackURL: '/login' })
    if (result.error) { setError(result.error.message || 'Sign-in failed'); setPending(null) }
  }
  return <main className="page center">
    <p className="eyebrow">NovelTea</p>
    <h1>Story Studio</h1>
    <p>Sign in with a linked GitHub or GitLab login identity. Repository integrations are managed separately from login methods.</p>
    <div className="actions">
      <button type="button" disabled={pending !== null} onClick={() => void signIn('github')}>Sign in with GitHub{lastUsed === 'github' ? ' · Last used' : ''}</button>
      <button type="button" disabled={pending !== null} onClick={() => void signIn('gitlab')}>Sign in with GitLab.com{lastUsed === 'gitlab' ? ' · Last used' : ''}</button>
    </div>
    {(error || callbackError) && <p role="alert" className="error">{error || callbackError}</p>}
  </main>
}
