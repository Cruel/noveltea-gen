import { useCallback, useEffect, useState } from 'react'

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
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [provider, setProvider] = useState('openai')
  const [oauthProvider, setOauthProvider] = useState('github-copilot')
  const [secret, setSecret] = useState('')
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const response = await fetch('/api/pi/models', { cache: 'no-store' })
    const body = await response.json() as Catalog
    if (!response.ok) throw new Error(body.error || 'Pi providers are unavailable')
    setCatalog(body)
    return body
  }, [])
  useEffect(() => {
    void refresh().catch(e => setError(e instanceof Error ? e.message : 'Pi unavailable'))
  }, [refresh])
  useEffect(() => {
    if (!catalog?.oauth || !['starting', 'pending'].includes(catalog.oauth.status)) return
    const interval = setInterval(() => {
      void refresh().then(current => {
        if (current.oauth?.status === 'connected') void onUpdate()
      }).catch(e => setError(e instanceof Error ? e.message : 'Pi unavailable'))
    }, 1000)
    return () => clearInterval(interval)
  }, [catalog?.oauth?.status, refresh, onUpdate])

  const mutate = async (method: 'POST' | 'DELETE', value: unknown) => {
    setBusy(true); setError(null)
    try {
      const response = await fetch('/api/pi/models', {
        method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
      })
      const result = await response.json() as Catalog
      if (!response.ok) throw new Error(result.error || 'Unable to update Pi connection')
      if (method === 'POST' && (value as { action?: string }).action === 'api-key') setSecret('')
      await refresh()
      await onUpdate()
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connection failed')
      return false
    } finally { setBusy(false) }
  }
  const active = ['starting', 'pending'].includes(catalog?.oauth?.status ?? '')

  return <section aria-label="Pi model provider connections">
    <p className="muted">Connect a personal provider. Credentials are encrypted on the server and never shared with sandbox tools. No local OAuth callback servers are used.</p>
    {catalog?.connected.length ? <ul>{catalog.connected.map(item =>
      <li key={item.providerId}>{providerName(item.providerId)} ({item.type})
        {' '}<button type="button" disabled={busy}
          onClick={() => void mutate('DELETE', { provider: item.providerId })}>Disconnect</button>
      </li>)}</ul> : <p>No connected model providers.</p>}
    <div className="generation-controls">
      <label>API key provider
        <select disabled={busy} value={provider} onChange={e => setProvider(e.target.value)}>
          {Object.entries(apiProviders).map(([id, name]) =>
            <option key={id} value={id}>{name}</option>)}
        </select>
      </label>
      <label>Personal API key
        <input type="password" autoComplete="off" value={secret} disabled={busy}
          onChange={e => setSecret(e.target.value)} placeholder="API key (not saved in browser)" />
      </label>
      <button type="button" disabled={busy || !secret.trim()}
        onClick={() => void mutate('POST', { action: 'api-key', provider, key: secret })}>Connect API key</button>
    </div>
    <div className="generation-controls">
      <label>Device-code subscription provider
        <select disabled={busy || active} value={oauthProvider}
          onChange={e => setOauthProvider(e.target.value)}>
          {Object.entries(deviceProviders).map(([id, name]) =>
            <option key={id} value={id}>{name}</option>)}
        </select>
      </label>
      <button type="button" disabled={busy || active}
        onClick={() => void mutate('POST', { action: 'oauth', provider: oauthProvider })}>
        Connect with device code
      </button>
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
            <select value={answer} disabled={busy} onChange={e => setAnswer(e.target.value)}>
              {catalog.oauth.prompt.options?.map(option =>
                <option key={option.id} value={option.id}>{option.label}</option>)}
            </select> :
            <input type={catalog.oauth.prompt.type === 'secret' ? 'password' : 'text'}
              autoComplete="off" disabled={busy} value={answer}
              placeholder={catalog.oauth.prompt.placeholder}
              onChange={e => setAnswer(e.target.value)} />}
        </label>
        <button type="submit" disabled={busy || (catalog.oauth.prompt.type !== 'select' && !answer.trim())}>
          Continue
        </button>
      </form>}
      <button type="button" disabled={busy} onClick={() => void mutate('POST', { action: 'oauth-cancel' })}>
        Cancel sign-in
      </button>
    </div>}
    {catalog?.oauth?.status === 'failed' && <p role="alert">{catalog.oauth.reason}</p>}
    {error && <p role="alert" className="error">{error}</p>}
  </section>
}
