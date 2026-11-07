import { Button } from '@/components/ui/button'
import { StudioSelect } from '@/components/studio-select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Info } from 'lucide-react'
import { siGithub, siGitlab } from 'simple-icons'
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

const names = { github: 'GitHub', gitlab: 'GitLab' }
const accountLabel = (login: string | null | undefined, id: string) =>
  login ? '@' + login : 'Account ' + id
function GitProviderIcon({ provider }: { provider: 'github' | 'gitlab' }) {
  const icon = provider === 'github' ? siGithub : siGitlab
  return <span role="img" aria-label={names[provider]}
    className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4 fill-current"
      style={provider === 'gitlab' ? { color: '#FC6D26' } : undefined}>
      <path d={icon.path} />
    </svg>
  </span>
}
function HelpTip({ label, text }: { label: string; text: string }) {
  return <Tooltip>
    <TooltipTrigger render={<button type="button" aria-label={label}
      className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring" />}>
      <Info aria-hidden="true" className="size-3.5" />
    </TooltipTrigger>
    <TooltipContent>{text}</TooltipContent>
  </Tooltip>
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
  const cancelRepositoryEdit = (repositoryId: string) => {
    setEditingRepository(null)
    setBindings(previous => {
      const next = { ...previous }
      delete next[repositoryId]
      return next
    })
  }
  const rebindRepository = (repositoryId: string, connectionId: string | null) => run(async () => {
    await rebindGitRepository({ data: { repositoryId, connectionId } })
    await refresh()
    setEditingRepository(null)
    setNotice('Repository access verified and assigned to the selected Git account.')
  })
  const disconnectGit = (entry: Connection) => run(async () => {
    const alsoLogin = settings.loginMethods.some(login =>
      login.provider === entry.provider && login.accountId === entry.accountId)
    if (!window.confirm('Disconnect separate repository authorization for ' +
      names[entry.provider] + ' · @' + entry.login + '? Stories and jobs are preserved. ' +
      (alsoLogin ? 'Studio login and login-backed repository access remain available.'
        : 'Remote operations using this connection will stop until it is reconnected.'))) return
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
      <Card id="integrations" size="sm" className="mt-6">
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Git accounts</CardTitle>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" disabled={busy}
              onClick={() => void connectGit('github')}>Add GitHub</Button>
            <Button type="button" size="sm" variant="outline" disabled={busy}
              onClick={() => void connectGit('gitlab')}>Add GitLab</Button>
          </div>
        </CardHeader><CardContent>
        <ul className="m-0">{accounts.map(account => {
          const connection = account.connection
          const loginCount = settings.loginMethods.filter(login => login.provider === account.provider).length
          const used = settings.repositories.filter(repo => repo.provider === account.provider &&
            (repo.connectionId ? repo.connectionId === connection?.id : account.loginMethod && loginCount === 1)).length
          const status = connection?.status
          const accessDetails = [
            account.loginMethod ? 'Can sign in to Studio and access repositories through the login.'
              : 'Authorized for repositories only; not a Studio login method.',
            status === 'connected' ? 'Separate repository authorization is connected.'
              : status === 'reauthorize' ? 'Separate authorization requires reconnection.'
                : status === 'disconnected' ? 'Separate authorization is disconnected.' : '',
            !account.login ? 'The provider username could not be retrieved.' : '',
          ].filter(Boolean).join(' ')
          return <li key={account.key} className="settings-connection">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <GitProviderIcon provider={account.provider} />
              <strong>{accountLabel(account.login, account.accountId)}</strong>
              <HelpTip label={'Access details for ' + names[account.provider] + ' account'} text={accessDetails} />
              <span className="text-xs text-muted-foreground">{used} {used === 1 ? 'repository' : 'repositories'}</span>
              {status === 'reauthorize' && <span className="text-xs text-muted-foreground">Reauthorization required</span>}
              {status === 'disconnected' && <span className="text-xs text-muted-foreground">Disconnected</span>}
            </div>
            {connection && (connection.status === 'connected'
              ? <Button type="button" size="sm" variant="outline" disabled={busy}
                  onClick={() => void disconnectGit(connection)}>
                  {account.loginMethod ? 'Disconnect separate access' : 'Disconnect'}
                </Button>
              : <Button type="button" size="sm" variant="outline" disabled={busy}
                  onClick={() => void connectGit(account.provider)}>Reconnect</Button>)}
          </li>
        })}</ul>
        {!accounts.length && <p className="text-sm text-muted-foreground">No Git accounts linked.</p>}
        {settings.repositories.length > 0 && <div className="mt-4">
          <div className="flex items-center gap-1">
            <h3 className="text-sm font-semibold">Repository access</h3>
            <HelpTip label="About repository access" text="Choose which Git account each repository uses. Studio verifies repository identity and push permissions before saving. Existing Stories and jobs are preserved." />
          </div>
          <ul className="m-0">{settings.repositories.map(repo => {
            const current = accountForRepository(repo, accounts)
            const eligibleAccounts = accounts.filter(account => account.provider === repo.provider)
            const loginCount = settings.loginMethods.filter(login => login.provider === repo.provider).length
            const currentKey = current?.key ?? ''
            const selected = bindings[repo.id] ?? currentKey
            const selectedAccount = eligibleAccounts.find(account => account.key === selected)
            const credential = selectedAccount ? credentialForAccount(selectedAccount, loginCount) : undefined
            const currentDescription = current
              ? accountLabel(current.login, current.accountId)
              : repo.connectionId ? 'Authorization unavailable' : 'Studio login unavailable or ambiguous'
            return <li key={repo.id} className="settings-repository">
              <div className="settings-connection">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <GitProviderIcon provider={repo.provider} />
                  <strong>{repo.name}</strong>
                  <span className="text-xs text-muted-foreground">{currentDescription}</span>
                  <HelpTip label={'Access details for ' + repo.name + ' on ' + names[repo.provider]}
                    text={repo.connectionId ? 'This repository uses a separate Git authorization.'
                      : 'This repository uses your Studio login credentials for Git access.'} />
                </div>
                <Button type="button" size="sm" variant="outline" disabled={busy}
                  onClick={() => editingRepository === repo.id
                    ? cancelRepositoryEdit(repo.id) : setEditingRepository(repo.id)}>
                  {editingRepository === repo.id ? 'Cancel change' : 'Change'}
                </Button>
              </div>
              {editingRepository === repo.id && <div className="flex flex-wrap items-center gap-2 pt-2">
                <StudioSelect aria-label={'Git account for ' + repo.name} value={selected}
                  disabled={busy} placeholder="Choose a Git account"
                  onValueChange={value => setBindings(previous => ({ ...previous, [repo.id]: value }))}
                  options={eligibleAccounts.map(account => ({
                    value: account.key, label: accountLabel(account.login, account.accountId),
                    disabled: credentialForAccount(account, loginCount) === undefined,
                  }))} />
                <Button type="button" size="sm" disabled={busy || credential === undefined ||
                  !selected || (selected === currentKey && credential === repo.connectionId)}
                  onClick={() => void rebindRepository(repo.id, credential!)}>Save account</Button>
                <Button type="button" size="sm" variant="ghost" disabled={busy}
                  onClick={() => cancelRepositoryEdit(repo.id)}>Cancel</Button>
              </div>}
            </li>
          })}</ul>
        </div>}
        </CardContent>
      </Card>
      <Card id="account" size="sm" className="mt-6">
        <CardHeader><CardTitle>Account &amp; security</CardTitle></CardHeader><CardContent>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <h3 className="text-sm font-semibold">Login methods</h3>
            <HelpTip label="About login methods"
              text="These accounts can sign in to Studio. Connecting a repository account does not add a login method. Removing a login method never silently changes repository authorization." />
          </div>
          <div className="flex flex-wrap gap-2">
            {(['github', 'gitlab'] as const).map(provider => <Button key={provider}
              type="button" size="sm" variant="outline" disabled={busy}
              onClick={() => void linkLogin(provider)}>Link {names[provider]}</Button>)}
          </div>
        </div>
        <ul className="m-0">{settings.loginMethods.map(login =>
          <li key={login.provider + login.accountId} className="settings-connection">
            <div className="flex min-w-0 items-center gap-2">
              <GitProviderIcon provider={login.provider} />
              <strong>{accountLabel(login.login, login.accountId)}</strong>
              <HelpTip label={'Login details for ' + names[login.provider]}
                text="This account is a Studio login method. Removing it does not remove separate Git repository authorizations." />
            </div>
            <Button type="button" size="sm" variant="outline"
              disabled={busy || settings.loginMethods.length < 2}
              title={settings.loginMethods.length < 2 ? 'Keep at least one login method' : undefined}
              onClick={() => void unlinkLogin(login.provider, login.id)}>Remove login</Button>
          </li>
        )}</ul>
        </CardContent>
      </Card>
    </>
  </main>
}
