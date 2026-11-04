import { Button } from '@/components/ui/button'
import { StudioSelect } from '@/components/studio-select'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { settingsQuery } from '../../lib/settings.queries'
import { beginGitConnection, disconnectGitConnection, rebindGitRepository,
  setDefaultModel, unlinkLogin as unlinkLoginFn } from '../../lib/settings.functions'
import { authClient } from '../../lib/auth-client'
import { PiConnections } from './jobs/-PiConnections'
import { getPiCatalog } from '../../lib/pi.functions'

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
export const Route = createFileRoute('/_protected/settings')({
  loader: ({ context }) => context.queryClient.ensureQueryData(settingsQuery()),
  component: SettingsPage,
})

const names = { github: 'GitHub', gitlab: 'GitLab.com' }
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
  const queryClient = useQueryClient()
  const { data: settings } = useSuspenseQuery(settingsQuery())
  const modelsQuery = useQuery({
    queryKey: ['pi-models'] as const,
    queryFn: async () => JSON.parse(await getPiCatalog()) as { models: Model[] },
  })
  const models = modelsQuery.data?.models ?? []
  const [selected, setSelected] = useState('')
  const [thinking, setThinking] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [oauthNotice, setOauthNotice] = useState<string | null>(null)
  const [bindings, setBindings] = useState<Record<string, string>>({})
  useEffect(() => { setOauthNotice(noticeFor(new URLSearchParams(window.location.search))) }, [])
  useEffect(() => {
    setSelected(settings.defaultModel ? settings.defaultModel.provider + '/' + settings.defaultModel.id : '')
    setThinking(settings.defaultModel?.thinking ?? '')
  }, [settings.defaultModel])
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['settings'] })
  }
  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setError(null); setNotice(null)
    try { await operation() } catch (e) {
      setError(e instanceof Error ? e.message : 'Operation failed')
    } finally { setBusy(false) }
  }
  const save = () => run(async () => {
    const model = models.find(item => item.provider + '/' + item.id === selected)
    if (selected && !model) throw new Error('The default model is not available.')
    await setDefaultModel({ data: model
      ? { provider: model.provider, id: model.id, ...(thinking ? { thinking: thinking as 'low' | 'medium' | 'high' } : {}) } : null })
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
    await unlinkLoginFn({ data: { provider, accountRecordId } })
    await refresh()
    setNotice('Login method removed.')
  })
  const connectGit = (provider: 'github' | 'gitlab') => run(async () => {
    const result = await beginGitConnection({ data: provider })
    window.location.assign(result.authorizationUrl)
  })
  const rebindRepository = (repositoryId: string, connectionId: string) => run(async () => {
    await rebindGitRepository({ data: { repositoryId, connectionId } })
    await refresh()
    setNotice('Repository access verified and bound to the selected Git identity.')
  })
  const disconnectGit = (entry: Connection) => run(async () => {
    if (!window.confirm('Disconnect ' + entry.provider + '/' + entry.login +
      '? Repositories and jobs are kept, but remote operations using this identity will stop until it is reconnected.')) return
    await disconnectGitConnection({ data: entry.id })
    await refresh()
    setNotice('Repository connection disconnected. Stories and jobs were preserved.')
  })
  return <main className="page settings-page">
    <header>
      <div><p className="eyebrow">NovelTea</p><h1>Settings</h1></div>
      <nav aria-label="Main navigation"><a href="/dashboard">Dashboard</a><a href="/settings" aria-current="page">Settings</a></nav>
    </header>
    <p>Preferences and connections are scoped to your Studio user, not shared with other users.</p>
    {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
    {(notice || oauthNotice) && <Alert role="status"><AlertDescription>{notice || oauthNotice}</AlertDescription></Alert>}
    <>
      <Card id="ai-models" className="mt-6">
        <CardHeader><CardTitle>AI &amp; models</CardTitle></CardHeader><CardContent>
        <p>Connect personal model credentials and choose the defaults for new generation jobs.</p>
        {modelsQuery.error && <p role="alert" className="error">Could not load models: {modelsQuery.error.message}</p>}
        <PiConnections onUpdate={async () => {
          await queryClient.invalidateQueries({ queryKey: ['pi-models'] })
        }} />
        <div className="generation-controls">
          <label>Default model
            <StudioSelect aria-label="Default model" value={selected} disabled={busy}
              onValueChange={value => { setSelected(value); setThinking('') }}
              options={[
                { value: '', label: 'No default (choose for each job)' },
                ...(selected && !models.some(model => model.provider + '/' + model.id === selected)
                  ? [{ value: selected, label: selected + ' (disconnected)' }] : []),
                ...models.map(model => ({ value: model.provider + '/' + model.id,
                  label: model.provider + ' / ' + model.id })),
              ]} />
          </label>
          <label>Default reasoning
            <StudioSelect aria-label="Default reasoning" value={thinking}
              disabled={busy || !models.some(m => m.provider + '/' + m.id === selected && m.reasoning)}
              onValueChange={setThinking}
              options={[{ value: '', label: 'Provider default' },
                { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' },
                { value: 'high', label: 'High' }]} />
          </label>
        </div>
        <Button type="button" disabled={busy} onClick={() => void save()}>Save model defaults</Button>
        </CardContent>
      </Card>
      <Card id="integrations" className="mt-6">
        <CardHeader><CardTitle>Git integrations</CardTitle></CardHeader><CardContent>
        <p>Repository authorization is independent of login. You can connect multiple accounts from either provider,
          even an identity used to sign into another Studio user.</p>
        <ul>{settings.gitConnections.map(entry => <li key={entry.id} className="settings-connection">
          <div><strong>{names[entry.provider]} / {entry.login}</strong>
            <small>{entry.status === 'connected' ? 'Connected' : entry.status === 'reauthorize'
              ? 'Reauthorization required' : 'Disconnected'}</small></div>
          {entry.status === 'connected'
            ? <Button type="button" disabled={busy} onClick={() => void disconnectGit(entry)}>Disconnect</Button>
            : <Button type="button" disabled={busy} onClick={() => void connectGit(entry.provider)}>Reconnect</Button>}
        </li>)}</ul>
        {!settings.gitConnections.length && <p>No independent Git repository connections yet.
          Existing repositories may still use their historical login-linked access until rebound.</p>}
        <div className="actions settings-actions">
          <Button type="button" disabled={busy} onClick={() => void connectGit('github')}>Connect GitHub account</Button>
          <Button type="button" disabled={busy} onClick={() => void connectGit('gitlab')}>Connect GitLab account</Button>
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
                <StudioSelect aria-label={'Git identity for ' + repo.name} value={selected} disabled={busy}
                  placeholder="Choose a connection"
                  onValueChange={value => setBindings(previous => ({ ...previous, [repo.id]: value }))}
                  options={settings.gitConnections.filter(connection => connection.provider === repo.provider)
                    .map(connection => ({ value: connection.id,
                      label: connection.login + (connection.status === 'connected' ? '' : ' (reconnect first)'),
                      disabled: connection.status !== 'connected',
                    }))} />
                <Button type="button" disabled={busy || !selected || selected === repo.connectionId ||
                  !available.some(connection => connection.id === selected)}
                  onClick={() => void rebindRepository(repo.id, selected)}>Save binding</Button>
              </div>
            </li>
          })}</ul>
        </>}
        </CardContent>
      </Card>
      <Card id="account" className="mt-6">
        <CardHeader><CardTitle>Account · login methods</CardTitle></CardHeader><CardContent>
        <p>These identities can sign into this Studio user. Linking an identity already used by another Studio
          user is not permitted. Adding a repository connection does not add a login method.</p>
        <ul>{settings.loginMethods.map(login => <li key={login.provider + login.accountId} className="settings-connection">
          <div><strong>{names[login.provider]}</strong><small>Account ID: {login.accountId}</small></div>
          <Button type="button" disabled={busy || settings.loginMethods.length < 2}
            title={settings.loginMethods.length < 2 ? 'Keep at least one login method' : undefined}
            onClick={() => void unlinkLogin(login.provider, login.id)}>Remove login</Button>
        </li>)}</ul>
        <div className="actions settings-actions">
          {(['github', 'gitlab'] as const).map(provider => <Button key={provider} type="button"
            disabled={busy} onClick={() => void linkLogin(provider)}>Link {names[provider]} login</Button>)}
        </div>
        </CardContent>
      </Card>
    </>
  </main>
}
