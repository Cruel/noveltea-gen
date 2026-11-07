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
import { accountForRepository, credentialForAccount, gitAccounts } from '../../lib/git-accounts'
import type { StudioSettings } from '../../lib/settings.functions'

type Model = { provider: string; id: string; reasoning: boolean }
type Connection = StudioSettings['gitConnections'][number]
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
  const [editingRepository, setEditingRepository] = useState<string | null>(null)
  const accounts = gitAccounts(settings)
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
  const rebindRepository = (repositoryId: string, connectionId: string | null) => run(async () => {
    await rebindGitRepository({ data: { repositoryId, connectionId } })
    await refresh()
    setEditingRepository(null)
    setNotice('Repository access verified and assigned to the selected Git account.')
  })
  const disconnectGit = (entry: Connection) => run(async () => {
    if (!window.confirm('Disconnect ' + entry.provider + '/' + entry.login +
      '? Repositories and jobs are kept, but remote operations using this identity will stop until it is reconnected.')) return
    await disconnectGitConnection({ data: entry.id })
    await refresh()
    setNotice('Repository connection disconnected. Stories and jobs were preserved.')
  })
  return <main className="page settings-page">
    <h1>Settings</h1>
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
        <CardHeader><CardTitle>Git accounts</CardTitle></CardHeader><CardContent>
        <p>Use GitHub and GitLab accounts to access repositories. Accounts linked for Studio login work here too;
          additional repository accounts can be connected separately.</p>
        <ul>{accounts.map(account => {
          const connection = account.connection
          const loginCount = settings.loginMethods.filter(login => login.provider === account.provider).length
          const used = settings.repositories.filter(repo => repo.provider === account.provider &&
            (repo.connectionId ? repo.connectionId === connection?.id : account.loginMethod && loginCount === 1)).length
          return <li key={account.key} className="settings-connection">
            <div>
              <strong>{names[account.provider]} · {account.login ?? 'Account ' + account.accountId}</strong>
              {account.loginMethod && <small>Studio login</small>}
              {connection
                ? <small>Separate repository authorization · {connection.status === 'connected'
                  ? 'Connected' : connection.status === 'reauthorize' ? 'Reauthorization required' : 'Disconnected'}</small>
                : account.loginMethod && <small>Repository access via Studio login</small>}
              {used > 0 && <small>Used by {used} {used === 1 ? 'repository' : 'repositories'}</small>}
            </div>
            {connection && (connection.status === 'connected'
              ? <Button type="button" variant="outline" disabled={busy}
                  onClick={() => void disconnectGit(connection)}>Disconnect authorization</Button>
              : <Button type="button" variant="outline" disabled={busy}
                  onClick={() => void connectGit(account.provider)}>Authorize again</Button>)}
          </li>
        })}</ul>
        {!accounts.length && <p>No Git accounts linked yet. Link a login method or connect a repository account.</p>}
        <div className="actions settings-actions">
          <Button type="button" variant="outline" disabled={busy}
            onClick={() => void connectGit('github')}>Add GitHub account</Button>
          <Button type="button" variant="outline" disabled={busy}
            onClick={() => void connectGit('gitlab')}>Add GitLab account</Button>
        </div>
        {settings.repositories.length > 0 && <>
          <h3>Repository access</h3>
          <p>Each repository uses the account shown below. To change it, Studio checks repository identity and
            push permissions before saving. Existing Stories and jobs are preserved.</p>
          <ul>{settings.repositories.map(repo => {
            const current = accountForRepository(repo, accounts)
            const eligibleAccounts = accounts.filter(account => account.provider === repo.provider)
            const loginCount = settings.loginMethods.filter(login => login.provider === repo.provider).length
            const currentKey = current?.key ?? ''
            const selected = bindings[repo.id] ?? currentKey
            const selectedAccount = eligibleAccounts.find(account => account.key === selected)
            const credential = selectedAccount ? credentialForAccount(selectedAccount, loginCount) : undefined
            const currentDescription = current
              ? (current.login ?? 'Account ' + current.accountId)
              : repo.connectionId ? 'Authorization unavailable' : 'Studio login unavailable or ambiguous'
            return <li key={repo.id} className="settings-repository">
              <div className="settings-connection">
                <div><strong>{repo.name}</strong>
                  <small>{names[repo.provider]} · {currentDescription}</small>
                  {!repo.connectionId && <small>Using Studio login</small>}
                </div>
                <Button type="button" variant="outline" disabled={busy}
                  onClick={() => setEditingRepository(previous => previous === repo.id ? null : repo.id)}>
                  {editingRepository === repo.id ? 'Hide options' : 'Change account'}
                </Button>
              </div>
              {editingRepository === repo.id && <div className="actions settings-actions">
                <StudioSelect aria-label={'Git account for ' + repo.name} value={selected}
                  disabled={busy} placeholder="Choose a Git account"
                  onValueChange={value => setBindings(previous => ({ ...previous, [repo.id]: value }))}
                  options={eligibleAccounts.map(account => ({
                    value: account.key, label: account.login ?? 'Account ' + account.accountId,
                    disabled: credentialForAccount(account, loginCount) === undefined,
                  }))} />
                <Button type="button" disabled={busy || credential === undefined ||
                  !selected || (selected === currentKey && credential === repo.connectionId)}
                  onClick={() => void rebindRepository(repo.id, credential!)}>Save account</Button>
                <Button type="button" variant="ghost" disabled={busy}
                  onClick={() => { setEditingRepository(null); setBindings(previous => {
                    const next = { ...previous }; delete next[repo.id]; return next
                  }) }}>Cancel</Button>
              </div>}
            </li>
          })}</ul>
        </>}
        </CardContent>
      </Card>
      <Card id="account" className="mt-6">
        <CardHeader><CardTitle>Account &amp; security</CardTitle></CardHeader><CardContent>
        <h3>Login methods</h3>
        <p>These accounts can sign into Studio. Adding a Git repository account does not add a login method.
          Removing a login method never silently changes a repository's authorization.</p>
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
