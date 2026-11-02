import { useCallback, useEffect, useState } from 'react'

type Connection = { providerId: string; type: 'api_key' | 'oauth' }
type Flow = { status: 'starting' | 'pending' | 'completing' | 'connected' | 'failed'
  url?: string; reason?: string }
type Catalog = { connected: Connection[]; oauth: Flow | null; error?: string }
const providerLabels: Record<string, string> = {
  openai: 'OpenAI (ChatGPT or API key)', anthropic: 'Anthropic API', google: 'Google API',
  openrouter: 'OpenRouter API', xai: 'xAI API', groq: 'Groq API', mistral: 'Mistral API',
  'openai-codex': 'Legacy Codex OAuth (reconnect with OpenAI)',
}
export function PiConnections({ onUpdate }: { onUpdate: () => Promise<void> }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [provider, setProvider] = useState('openai')
  const [secret, setSecret] = useState('')
  const [redirect, setRedirect] = useState('')
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
    if (!catalog?.oauth || !['pending', 'starting', 'completing'].includes(catalog.oauth.status)) return
    const interval = setInterval(() => {
      void refresh().then(current => {
        if (current.oauth?.status === 'connected') void onUpdate()
      }).catch(e => setError(e instanceof Error ? e.message : 'Pi unavailable'))
    }, 3000)
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
    } catch (e) { setError(e instanceof Error ? e.message : 'Connection failed') }
    finally { setBusy(false) }
  }
  return <section aria-label="Pi model provider connections">
    <p className="muted">Connect a personal provider. Credentials are encrypted on the server and never shared with sandbox tools.</p>
    {catalog?.connected.length ? <ul>{catalog.connected.map(item =>
      <li key={item.providerId}>{providerLabels[item.providerId] ?? item.providerId} ({item.type})
        {' '}<button type="button" disabled={busy} onClick={() => void mutate('DELETE', { provider: item.providerId })}>Disconnect</button>
      </li>)}</ul> : <p>No connected model providers.</p>}
    <div className="generation-controls">
      <label>API key provider
        <select disabled={busy} value={provider} onChange={e => setProvider(e.target.value)}>
          {Object.entries(providerLabels).filter(([id]) => id !== 'openai-codex').map(([id, name]) =>
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
    <button type="button" disabled={busy || ['pending', 'starting', 'completing'].includes(catalog?.oauth?.status ?? '')}
      onClick={() => void mutate('POST', { action: 'oauth', provider: 'openai' })}>
      Sign in with ChatGPT
    </button>
    {catalog?.oauth?.status === 'pending' && <div role="status">
      <p>Open <a href={catalog.oauth.url} target="_blank" rel="noopener noreferrer">ChatGPT authorization</a> and sign in.
      On the same computer as Studio, the browser callback completes automatically and this page updates when connected.
      If you access a remote Studio whose localhost callback cannot reach its server, use the manual fallback below.</p>
      <label>Manual fallback: final localhost redirect URL
        <input type="text" autoComplete="off" value={redirect} disabled={busy}
          onChange={event => setRedirect(event.target.value)} placeholder="http://127.0.0.1:1455/auth/callback?..." />
      </label>
      <button type="button" disabled={busy || !redirect.trim()}
        onClick={() => void mutate('POST', { action: 'oauth-complete', redirectUrl: redirect.trim() }).then(() => setRedirect(''))}>
        Complete ChatGPT sign-in
      </button>
    </div>}
    {catalog?.oauth?.status === 'completing' && <p role="status">Completing ChatGPT sign-in…</p>}
    {catalog?.oauth?.status === 'starting' && <p role="status">Preparing ChatGPT browser authorization…</p>}
    {catalog?.oauth?.status === 'failed' && <p role="alert">{catalog.oauth.reason}</p>}
    {error && <p role="alert" className="error">{error}</p>}
  </section>
}
