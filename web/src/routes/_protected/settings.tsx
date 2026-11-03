import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { authClient } from '../../lib/auth-client'
import { PiConnections } from './jobs/-PiConnections'

type Model = { provider: string; id: string; reasoning: boolean }
type Selection = { provider: string; id: string; thinking?: 'low' | 'medium' | 'high' } | null
type Connection = { id: string; provider: 'github' | 'gitlab'; accountId: string; login: string;
  status: 'connected' | 'reauthorize' | 'disconnected'; accessExpiresAt: number | null }
type Settings = {
  defaultModel: Selection
  loginMethods: Array<{ id: string; provider: 'github' | 'gitlab'; accountId: string }>
  gitConnections: Connection[]
  repositories: Array<{ id: string; provider: 'github' | 'gitlab'; name: string; connectionId: string | null }>
}
export const Route = createFileRoute('/_protected/settings')({ component: SettingsPage })

const names = { github: 'GitHub', gitlab: 'GitLab.com' }
async function request<T>(path: string, method?: 'POST' | 'DELETE' | 'PUT', body?: object): Promise<T> {
  const result = await fetch(path, method ? {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  } : { cache: 'no-store' })
  const data = await result.json() as T & { error?: string }
  if (!result.ok) throw new Error(data.error || 'Request failed')
  return data
}
function noticeFor(query: URLSearchParams) {
  if (query.has('integration_connected')) return 'Repository identity connected successfully.'
  const errors: Record<string, string> = {
    expired: 'Authorization expired. Start again.',
    denied: 'Authorization was denied.',
    invalid_state: 'The connection return was not verified. Try again.',
    session_mismatch: 'Your Studio session changed during authorization. Sign in and reconnect.',
    invalid_code: 'The provider did not return a valid authorization code.',
    authorization_failed: 'Git authorization was not completed. Verify the provider callback configuration or retry.',
  }
  const integrationError = query.get('integration_error')
  if (integrationError) return errors[integrationError] ?? 'Connection failed.'
  if (query.has('error')) return 'Login-method linking failed. This identity may belong to a different Studio user.'
  return null
}
function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [models, setModels] = useState<Model[]>([])
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [selected, setSelected] = useState('')
  const [thinking, setThinking] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [oauthNotice, setOauthNotice] = useState<string | null>(null)
  const [bindings, setBindings] = useState<Record<string, string>>({})
  useEffect(() => { setOauthNotice(noticeFor(new URLSearchParams(window.location.search))) }, [])
  const refresh = useCallback(async () => {
    const [saved, catalog] = await Promise.all([
      request<Settings>('/api/settings'),
      request<{ models: Model[] }>('/api/pi/models').then(result => {
        setModelsError(null)
        return result
      }).catch((error: unknown) => {
        setModelsError(error instanceof Error ? error.message : 'Could not load the Pi model catalog.')
        return { models: [] as Model[] }
      }),
    ])
    setSettings(saved)
    setModels(catalog.models)
    setSelected(saved.defaultModel ? saved.defaultModel.provider + '/' + saved.defaultModel.id : '')
    setThinking(saved.defaultModel?.thinking ?? '')
  }, [])
  useEffect(() => { void refresh().catch(e => setError(String(e))) }, [refresh])
  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setError(null); setNotice(null)
    try { await operation() } catch (e) {
      setError(e instanceof Error ? e.message : 'Operation failed')
    } finally { setBusy(false) }
  }
  const save = () => run(async () => {
    const model = models.find(item => item.provider + '/' + item.id === selected)
    if (selected && !model) throw new Error('The default model is not available.')
    await request('/api/settings', 'PUT', { defaultModel: model
      ? { provider: model.provider, id: model.id, ...(thinking ? { thinking } : {}) } : null })
    await refresh()
    setNotice('Default model saved. Existing job settings are unchanged.')
  })
  const linkLogin = (provider: 'github' | 'gitlab') => run(async () => {
    const result = await authClient.linkSocial({
      provider, callbackURL: '/settings', errorCallbackURL: '/settings',
    })
    if (result.error) throw new Error(result.error.message ?? 'Could not link login identity.')
  })
  const unlinkLogin = (provider: 'github' | 'gitlab', accountRecordId: string) => run(async () => {
    if (!window.confirm('Remove this Studio login method? Other repository connections are unaffected.')) return
    await request('/api/settings', 'DELETE', { provider, accountRecordId })
    await refresh()
    setNotice('Login method removed.')
  })
  const connectGit = (provider: 'github' | 'gitlab') => run(async () => {
    const result = await request<{ authorizationUrl: string }>('/api/integrations/git', 'POST', { provider })
    window.location.assign(result.authorizationUrl)
  })
  const rebindRepository = (repositoryId: string, connectionId: string) => run(async () => {
    await request('/api/integrations/git', 'PUT', { repositoryId, connectionId })
    await refresh()
    setNotice('Repository access verified and bound to the selected Git identity.')
  })
  const disconnectGit = (entry: Connection) => run(async () => {
    if (!window.confirm('Disconnect ' + entry.provider + '/' + entry.login +
      '? Repositories and jobs are kept, but remote operations using this identity will stop until it is reconnected.')) return
    await request('/api/integrations/git', 'DELETE', { connectionId: entry.id })
    await refresh()
    setNotice('Repository connection disconnected. Stories and jobs were preserved.')
  })
  return <main className="page settings-page">
    <header>
      <div><p className="eyebrow">NovelTea</p><h1>Settings</h1></div>
      <nav aria-label="Main navigation"><a href="/dashboard">Dashboard</a><a href="/settings" aria-current="page">Settings</a></nav>
    </header>
    <p>Preferences and connections are scoped to your Studio user, not shared with other users.</p>
    {error && <p role="alert" className="error">{error}</p>}
    {(notice || oauthNotice) && <p role="status">{notice || oauthNotice}</p>}
    {!settings && !error && <p>Loading settings…</p>}
    {settings && <>
      <section id="ai-models">
        <h2>AI &amp; models</h2>
        <p>Connect personal model credentials and choose the defaults for new generation jobs.</p>
        {modelsError && <p role="alert" className="error">Could not load models: {modelsError}</p>}
        <PiConnections onUpdate={async () => {
          const catalog = await request<{ models: Model[] }>('/api/pi/models')
          setModels(catalog.models)
        }} />
        <div className="generation-controls">
          <label>Default model
            <select value={selected} disabled={busy} onChange={e => { setSelected(e.target.value); setThinking('') }}>
              <option value="">No default (choose for each job)</option>
              {selected && !models.some(model => model.provider + '/' + model.id === selected) &&
                <option value={selected}>{selected} (disconnected)</option>}
              {models.map(model => <option key={model.provider + '/' + model.id} value={model.provider + '/' + model.id}>
                {model.provider} / {model.id}
              </option>)}
            </select>
          </label>
          <label>Default reasoning
            <select value={thinking} disabled={busy || !models.some(m => m.provider + '/' + m.id === selected && m.reasoning)}
              onChange={e => setThinking(e.target.value)}>
              <option value="">Provider default</option>
              <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
            </select>
          </label>
        </div>
        <button type="button" disabled={busy} onClick={() => void save()}>Save model defaults</button>
      </section>
      <section id="integrations">
        <h2>Git integrations</h2>
        <p>Repository authorization is independent of login. You can connect multiple accounts from either provider,
          even an identity used to sign into another Studio user.</p>
        <ul>{settings.gitConnections.map(entry => <li key={entry.id} className="settings-connection">
          <div><strong>{names[entry.provider]} / {entry.login}</strong>
            <small>{entry.status === 'connected' ? 'Connected' : entry.status === 'reauthorize'
              ? 'Reauthorization required' : 'Disconnected'}</small></div>
          {entry.status === 'connected'
            ? <button type="button" disabled={busy} onClick={() => void disconnectGit(entry)}>Disconnect</button>
            : <button type="button" disabled={busy} onClick={() => void connectGit(entry.provider)}>Reconnect</button>}
        </li>)}</ul>
        {!settings.gitConnections.length && <p>No independent Git repository connections yet.
          Existing repositories may still use their historical login-linked access until rebound.</p>}
        <div className="actions settings-actions">
          <button type="button" disabled={busy} onClick={() => void connectGit('github')}>Connect GitHub account</button>
          <button type="button" disabled={busy} onClick={() => void connectGit('gitlab')}>Connect GitLab account</button>
        </div>
        {settings.repositories.length > 0 && <>
          <h3>Repository access bindings</h3>
          <p>Choose the Git identity to use for each repository. Studio verifies push access and repository identity before changing a binding. Existing work is preserved.</p>
          <ul>{settings.repositories.map(repo => {
            const selected = bindings[repo.id] ?? repo.connectionId ?? ''
            const available = settings.gitConnections.filter(connection => connection.provider === repo.provider && connection.status === 'connected')
            return <li className="settings-connection" key={repo.id}>
              <div><strong>{repo.name}</strong><small>{names[repo.provider]}{repo.connectionId ? '' : ' · Historical login-linked access'}</small></div>
              <div className="actions settings-actions">
                <select aria-label={'Git identity for ' + repo.name} value={selected} disabled={busy}
                  onChange={event => setBindings(previous => ({ ...previous, [repo.id]: event.target.value }))}>
                  <option value="" disabled>Choose a connection</option>
                  {settings.gitConnections.filter(connection => connection.provider === repo.provider)
                    .map(connection => <option key={connection.id} value={connection.id} disabled={connection.status !== 'connected'}>
                      {connection.login}{connection.status === 'connected' ? '' : ' (reconnect first)'}
                    </option>)}
                </select>
                <button type="button" disabled={busy || !selected || selected === repo.connectionId ||
                  !available.some(connection => connection.id === selected)}
                  onClick={() => void rebindRepository(repo.id, selected)}>Save binding</button>
              </div>
            </li>
          })}</ul>
        </>}
      </section>
      <section id="account">
        <h2>Account · login methods</h2>
        <p>These identities can sign into this Studio user. Linking an identity already used by another Studio
          user is not permitted. Adding a repository connection does not add a login method.</p>
        <ul>{settings.loginMethods.map(login => <li key={login.provider + login.accountId} className="settings-connection">
          <div><strong>{names[login.provider]}</strong><small>Account ID: {login.accountId}</small></div>
          <button type="button" disabled={busy || settings.loginMethods.length < 2}
            title={settings.loginMethods.length < 2 ? 'Keep at least one login method' : undefined}
            onClick={() => void unlinkLogin(login.provider, login.id)}>Remove login</button>
        </li>)}</ul>
        <div className="actions settings-actions">
          {(['github', 'gitlab'] as const).map(provider => <button key={provider} type="button"
            disabled={busy} onClick={() => void linkLogin(provider)}>Link {names[provider]} login</button>)}
        </div>
      </section>
    </>}
  </main>
}
