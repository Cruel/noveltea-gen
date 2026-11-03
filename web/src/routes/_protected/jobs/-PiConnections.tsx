import { useCallback, useEffect, useRef, useState } from 'react'

type Connection = { providerId: string; type: 'api_key' | 'oauth' }
type Flow = { status: 'starting' | 'pending' | 'completing' | 'connected' | 'failed'
  provider: string; interactive: boolean; url?: string; reason?: string; message?: string
  device?: { userCode: string; verificationUri: string }
  prompt?: { id: string; type: 'select' | 'manual_code' | 'text' | 'secret'; message: string;
    placeholder?: string; options?: readonly { id: string; label: string; description?: string }[] } }
type Catalog = { connected: Connection[]; oauth: Flow | null; error?: string }
const providerLabels: Record<string, string> = {
  openai: 'OpenAI (ChatGPT or API key)', anthropic: 'Anthropic API', google: 'Google API',
  openrouter: 'OpenRouter API', xai: 'xAI API', groq: 'Groq API', mistral: 'Mistral API',
  'openai-codex': 'OpenAI Codex (legacy)',
  'github-copilot': 'GitHub Copilot', 'kimi-coding': 'Kimi For Coding',
  meta: 'Meta', radius: 'Radius',
}
const oauthProviders = ['openai', 'anthropic', 'github-copilot', 'kimi-coding', 'meta',
  'openai-codex', 'openrouter', 'radius', 'xai'] as const
const providerName = (id: string) => providerLabels[id]?.replace(/ API$| \(ChatGPT or API key\)$/, '') ?? id
const safeVerificationLink = (value?: string) => {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined
  } catch { return undefined }
}
export function PiConnections({ onUpdate }: { onUpdate: () => Promise<void> }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [provider, setProvider] = useState('openai')
  const [oauthProvider, setOauthProvider] = useState('openai')
  const [answer, setAnswer] = useState('')
  const [secret, setSecret] = useState('')
  const [redirect, setRedirect] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const oauthPopup = useRef<Window | null>(null)
  const openedAuthUrl = useRef<string | null>(null)
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
    }, catalog.oauth.status === 'starting' ? 500 : 1000)
    return () => clearInterval(interval)
  }, [catalog?.oauth?.status, refresh, onUpdate])
  useEffect(() => {
    // The popup returns to Studio's origin after consuming the callback.
    // BroadcastChannel works even when the OAuth provider severs window.opener.
    const channel = new BroadcastChannel('noveltea-pi-oauth')
    channel.onmessage = event => {
      if (event.data !== 'callback-received') return
      void refresh().then(current => {
        if (current.oauth?.status === 'connected') void onUpdate()
      }).catch(e => setError(e instanceof Error ? e.message : 'Pi unavailable'))
    }
    return () => channel.close()
  }, [refresh, onUpdate])
  useEffect(() => {
    if (catalog?.oauth?.status === 'pending' && catalog.oauth.url &&
        oauthPopup.current && !oauthPopup.current.closed &&
        openedAuthUrl.current !== catalog.oauth.url) {
      openedAuthUrl.current = catalog.oauth.url
      oauthPopup.current.location.replace(catalog.oauth.url)
    }
    if (catalog?.oauth?.status === 'connected' && oauthPopup.current && !oauthPopup.current.closed)
      oauthPopup.current.close()
  }, [catalog?.oauth?.status, catalog?.oauth?.url])
  const mutate = async (method: 'POST' | 'DELETE', value: unknown): Promise<boolean> => {
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
  const startOAuth = () => {
    // Opening the window synchronously with the click avoids popup blockers.
    // Its URL is assigned once Pi emits the authorization link asynchronously.
    const popup = oauthProvider === 'openai'
      ? window.open('about:blank', '_blank', 'popup,width=560,height=720') : null
    if (popup) {
      popup.opener = null
      popup.document.title = 'Sign in with ChatGPT'
      popup.document.body.textContent = 'Preparing ChatGPT authorization…'
    }
    oauthPopup.current = popup
    openedAuthUrl.current = null
    void mutate('POST', { action: 'oauth', provider: oauthProvider }).then(ok => {
      if (!ok && popup && !popup.closed) popup.close()
    })
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
    <div className="generation-controls">
      <label>Pi OAuth provider
        <select disabled={busy} value={oauthProvider} onChange={e => setOauthProvider(e.target.value)}>
          {oauthProviders.map(id => <option key={id} value={id}>{providerName(id)}</option>)}
        </select>
      </label>
      <button type="button" disabled={busy || ['pending', 'starting', 'completing'].includes(catalog?.oauth?.status ?? '')}
        onClick={startOAuth}>Sign in with {oauthProvider === 'openai' ? 'ChatGPT' : providerName(oauthProvider)}</button>
    </div>
    {catalog?.oauth?.status === 'pending' && !catalog.oauth.interactive && <div role="status">
      <p>Complete sign-in in the ChatGPT window. It will close automatically when authorization completes.
        {' '}If it did not open, <a href={catalog.oauth.url} target="_blank" rel="noopener noreferrer">open ChatGPT authorization</a>.</p>
      <details>
        <summary>Manual callback fallback (remote browsers)</summary>
        <p>If your browser cannot reach the loopback callback address, paste its final redirect URL here.</p>
        <label>Final localhost redirect URL
          <input type="text" autoComplete="off" value={redirect} disabled={busy}
            onChange={event => setRedirect(event.target.value)}
            placeholder={(catalog.oauth.url
              ? new URL(catalog.oauth.url).searchParams.get('redirect_uri')
              : null) ?? 'http://127.0.0.1:3000/auth/callback?code=...'} />
        </label>
        <button type="button" disabled={busy || !redirect.trim()}
          onClick={() => void mutate('POST', { action: 'oauth-complete', redirectUrl: redirect.trim() }).then(() => setRedirect(''))}>
          Complete ChatGPT sign-in
        </button>
      </details>
    </div>}
    {catalog?.oauth?.interactive && ['starting', 'pending'].includes(catalog.oauth.status) && <div role="status">
      <p>{catalog.oauth.message || 'Preparing ' + providerName(catalog.oauth.provider) + ' authorization…'}</p>
      {catalog.oauth.url && safeVerificationLink(catalog.oauth.url) &&
        <p><a href={safeVerificationLink(catalog.oauth.url)} target="_blank" rel="noopener noreferrer">
          Open {providerName(catalog.oauth.provider)} authorization</a></p>}
      {catalog.oauth.device && <p>Verification code: <code>{catalog.oauth.device.userCode}</code>
        {' '}{safeVerificationLink(catalog.oauth.device.verificationUri) &&
        <a href={safeVerificationLink(catalog.oauth.device.verificationUri)}
          target="_blank" rel="noopener noreferrer">Open verification page</a>}</p>}
      {catalog.oauth.prompt && <form key={catalog.oauth.prompt.id} onSubmit={e => {
        e.preventDefault()
        const prompt = catalog.oauth?.prompt
        if (!prompt) return
        const value = prompt.type === 'select' ? answer || prompt.options?.[0]?.id || '' :
          prompt.type === 'manual_code' ? answer.trim() : answer
        void mutate('POST', { action: 'oauth-answer', promptId: prompt.id, value }).then(ok => {
          if (ok) setAnswer('')
        })
      }}>
        <label>{catalog.oauth.prompt.message}
          {catalog.oauth.prompt.type === 'select' ?
            <select value={answer} onChange={e => setAnswer(e.target.value)} disabled={busy}>
              {catalog.oauth.prompt.options?.map(option =>
                <option key={option.id} value={option.id}>{option.label}</option>)}
            </select> :
            <input type={catalog.oauth.prompt.type === 'secret' ? 'password' : 'text'}
              autoComplete="off" value={answer} disabled={busy}
              placeholder={catalog.oauth.prompt.placeholder}
              onChange={e => setAnswer(e.target.value)} />}
        </label>
        {catalog.oauth.provider === 'radius' && catalog.oauth.prompt.type === 'select' &&
          <p className="muted">For a remotely hosted Studio, choose device code. Radius browser login requires a local callback.</p>}
        <button type="submit" disabled={busy || (catalog.oauth.prompt.type === 'manual_code' && !answer.trim())}>
          Continue
        </button>
      </form>}
      <button type="button" disabled={busy} onClick={() => void mutate('POST', { action: 'oauth-cancel' })}>
        Cancel sign-in
      </button>
    </div>}
    {catalog?.oauth?.status === 'completing' && <p role="status">Completing ChatGPT sign-in…</p>}
    {catalog?.oauth?.status === 'starting' && !catalog.oauth.interactive &&
      <p role="status">Preparing ChatGPT browser authorization…</p>}
    {catalog?.oauth?.status === 'failed' && <p role="alert">{catalog.oauth.reason}</p>}
    {error && <p role="alert" className="error">{error}</p>}
  </section>
}
