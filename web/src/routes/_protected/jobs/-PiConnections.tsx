import { Button } from '@/components/ui/button'
import { StudioSelect } from '@/components/studio-select'
import { Input } from '@/components/ui/input'
import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getPiCatalog, mutatePiCredentials } from '../../../lib/pi.functions'

type Connection = { providerId: string; type: 'api_key' | 'oauth' }
type Prompt = { id: string; type: 'text' | 'secret' | 'select' | 'manual_code';
  message: string; placeholder?: string; options?: readonly { id: string; label: string; description?: string }[] }
type Flow = { provider: string; status: 'starting' | 'pending' | 'connected' | 'failed';
  device?: { userCode: string; verificationUri: string };
  prompt?: Prompt; message?: string; reason?: string }
type Catalog = { connected: Connection[]; oauth: Flow | null; error?: string }

const apiProviders: Record<string, string> = {
  openai: 'OpenAI API', anthropic: 'Anthropic API', google: 'Google API',
  openrouter: 'OpenRouter API', xai: 'xAI API', groq: 'Groq API', mistral: 'Mistral API',
}
const deviceProviders: Record<string, string> = {
  'openai-codex': 'OpenAI Codex (legacy)',
  'github-copilot': 'GitHub Copilot',
  'kimi-coding': 'Kimi For Coding',
  meta: 'Meta', radius: 'Radius', xai: 'xAI',
}
const providerName = (id: string) => deviceProviders[id] ?? apiProviders[id] ?? id
function safeVerificationLink(value: string): string | undefined {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : undefined
  } catch { return undefined }
}

export function PiConnections({ onUpdate }: { onUpdate: () => Promise<void> }) {
  const queryClient = useQueryClient()
  const catalogQuery = useQuery({
    queryKey: ['pi-models'] as const,
    queryFn: async () => JSON.parse(await getPiCatalog()) as Catalog,
    refetchInterval: query => ['starting', 'pending'].includes((query.state.data as Catalog | undefined)?.oauth?.status ?? '')
      ? 1000 : false,
  })
  const catalog = catalogQuery.data ?? null
  const previousOauthStatus = useRef<string | null>(null)
  const [provider, setProvider] = useState('openai')
  const [oauthProvider, setOauthProvider] = useState('github-copilot')
  const [secret, setSecret] = useState('')
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const status = catalog?.oauth?.status ?? null
    if (status === 'connected' && previousOauthStatus.current !== 'connected') void onUpdate()
    previousOauthStatus.current = status
  }, [catalog?.oauth?.status, onUpdate])

  const mutate = async (method: 'POST' | 'DELETE', value: unknown) => {
    setBusy(true); setError(null)
    try {
      await mutatePiCredentials({ data: { method, payloadJson: JSON.stringify(value) } })
      if (method === 'POST' && (value as { action?: string }).action === 'api-key') setSecret('')
      await queryClient.invalidateQueries({ queryKey: ['pi-models'] })
      await onUpdate()
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connection failed')
      return false
    } finally { setBusy(false) }
  }
  const active = ['starting', 'pending'].includes(catalog?.oauth?.status ?? '')

  return <section aria-label="Model provider connections">
    <p className="muted">Connect a personal provider. Credentials are encrypted on the server and never shared with sandbox tools. No local OAuth callback servers are used.</p>
    {(error || catalogQuery.error) && <p role="alert" className="error">{error || catalogQuery.error?.message}</p>}
    {catalog?.connected.length ? <ul>{catalog.connected.map(item =>
      <li key={item.providerId}>{providerName(item.providerId)} ({item.type})
        {' '}<Button type="button" disabled={busy}
          onClick={() => void mutate('DELETE', { provider: item.providerId })}>Disconnect</Button>
      </li>)}</ul> : <p>No connected model providers.</p>}
    <div className="generation-controls">
      <label>API key provider
        <StudioSelect aria-label="API key provider" disabled={busy} value={provider}
          onValueChange={setProvider}
          options={Object.entries(apiProviders).map(([value, label]) => ({ value, label }))} />
      </label>
      <label>Personal API key
        <Input type="password" autoComplete="off" value={secret} disabled={busy}
          onChange={e => setSecret(e.target.value)} placeholder="API key (not saved in browser)" />
      </label>
      <Button type="button" disabled={busy || !secret.trim()}
        onClick={() => void mutate('POST', { action: 'api-key', provider, key: secret })}>Connect API key</Button>
    </div>
    <div className="generation-controls">
      <label>Device-code subscription provider
        <StudioSelect aria-label="Device-code subscription provider" disabled={busy || active}
          value={oauthProvider} onValueChange={setOauthProvider}
          options={Object.entries(deviceProviders).map(([value, label]) => ({ value, label }))} />
      </label>
      <Button type="button" disabled={busy || active}
        onClick={() => void mutate('POST', { action: 'oauth', provider: oauthProvider })}>
        Connect with device code
      </Button>
    </div>
    {catalog?.oauth && ['starting', 'pending'].includes(catalog.oauth.status) && <div role="status">
      <p>{providerName(catalog.oauth.provider)}: {catalog.oauth.message || 'Preparing device authorization…'}</p>
      {catalog.oauth.device && <>
        <p>Enter verification code: <code>{catalog.oauth.device.userCode}</code></p>
        {safeVerificationLink(catalog.oauth.device.verificationUri) &&
          <p><a href={safeVerificationLink(catalog.oauth.device.verificationUri)}
            target="_blank" rel="noopener noreferrer">Open verification page</a></p>}
        <p>Finish authorization in your browser. Studio will detect completion automatically.</p>
      </>}
      {catalog.oauth.prompt && <form key={catalog.oauth.prompt.id} onSubmit={event => {
        event.preventDefault()
        const prompt = catalog.oauth?.prompt
        if (!prompt) return
        const value = prompt.type === 'select' ? answer || prompt.options?.[0]?.id || '' : answer
        void mutate('POST', { action: 'oauth-answer', promptId: prompt.id, value })
          .then(ok => { if (ok) setAnswer('') })
      }}>
        <label>{catalog.oauth.prompt.message}
          {catalog.oauth.prompt.type === 'select' ?
            <StudioSelect aria-label="Provider authorization answer" value={answer} disabled={busy}
              onValueChange={setAnswer} placeholder="Choose a response"
              options={(catalog.oauth.prompt.options ?? []).map(option => ({
                value: option.id, label: option.label,
              }))} /> :
            <Input type={catalog.oauth.prompt.type === 'secret' ? 'password' : 'text'}
              autoComplete="off" disabled={busy} value={answer}
              placeholder={catalog.oauth.prompt.placeholder}
              onChange={e => setAnswer(e.target.value)} />}
        </label>
        <Button type="submit" disabled={busy || (catalog.oauth.prompt.type !== 'select' && !answer.trim())}>
          Continue
        </Button>
      </form>}
      <Button type="button" disabled={busy} onClick={() => void mutate('POST', { action: 'oauth-cancel' })}>
        Cancel sign-in
      </Button>
    </div>}
    {catalog?.oauth?.status === 'failed' && <p role="alert">{catalog.oauth.reason}</p>}
    {error && <p role="alert" className="error">{error}</p>}
  </section>
}
