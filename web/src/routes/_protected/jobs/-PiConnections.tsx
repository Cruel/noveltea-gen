import { useCallback, useEffect, useState } from 'react'

type Connection = { providerId: string; type: 'api_key' | 'oauth' }
type Flow = { status: 'starting' | 'pending' | 'connected' | 'failed'
  code?: string; url?: string; reason?: string }
type Catalog = { connected: Connection[]; oauth: Flow | null; error?: string }
const providerLabels: Record<string, string> = {
  openai: 'OpenAI API', anthropic: 'Anthropic API', google: 'Google API',
  openrouter: 'OpenRouter API', xai: 'xAI API', groq: 'Groq API', mistral: 'Mistral API',
  'openai-codex': 'ChatGPT OAuth',
}
export function PiConnections({ onUpdate }: { onUpdate: () => Promise<void> }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [provider, setProvider] = useState('openai')
  const [secret, setSecret] = useState('')
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
    if (!catalog?.oauth || !['pending', 'starting'].includes(catalog.oauth.status)) return
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
    <button type="button" disabled={busy || ['pending', 'starting'].includes(catalog?.oauth?.status ?? '')}
      onClick={() => void mutate('POST', { action: 'oauth', provider: 'openai-codex' })}>
      Connect ChatGPT (device code)
    </button>
    {catalog?.oauth?.status === 'pending' && <p role="status">Open <a href={catalog.oauth.url}
      target="_blank" rel="noopener noreferrer">ChatGPT device authorization</a> and enter code <strong>{catalog.oauth.code}</strong>.
      Return here after approving; the provider will connect automatically.</p>}
    {catalog?.oauth?.status === 'starting' && <p role="status">Requesting ChatGPT device authorization…</p>}
    {catalog?.oauth?.status === 'failed' && <p role="alert">{catalog.oauth.reason}</p>}
    {error && <p role="alert" className="error">{error}</p>}
  </section>
}
