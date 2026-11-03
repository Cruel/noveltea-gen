import { createHmac } from 'node:crypto'
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth'

// Nitro bundles Pi's main module but cannot trace its variable-specified
// Node-only OAuth flow imports. Register the SDK's official static loaders
// so production SSR includes the flows without copying generated files.
registerBunOAuthFlows()
import type { StudioAuth } from './auth'
import type { StudioDatabase } from '../db/connection'
import { assertStudioSchemaCurrent } from '../db/migrations'
import { requireUser } from './access.server'
import { availableUserPiModels, createUserPiRuntime, userPiCredentials } from './pi-credentials.server'

type Flow = { status: 'starting' | 'pending' | 'completing' | 'connected' | 'failed'
  url?: string; state?: string; expires: number; reason?: string; abort: AbortController;
  resolveManual?: (value: string) => void }
const flows = new Map<string, Flow>()
// Random provider-generated state is the one-use callback correlation key.
// No Studio session cookie is expected on the provider's redirect.
const flowsByState = new Map<string, Flow>()
const allowedApiProviders = new Set(['openai', 'anthropic', 'google', 'openrouter', 'xai', 'groq', 'mistral'])
const reply = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } })

/** Per-owner stable OAuth host ID; never expose the actual account ID to Pi. */
export function oauthHostDeviceId(owner: string, encodedKey: string): string {
  const key = Buffer.from(encodedKey, 'base64')
  if (key.length !== 32 || key.toString('base64') !== encodedKey)
    throw new Error('Invalid Pi credential encryption key')
  const digest = createHmac('sha256', key).update('pi-openai-device-v1\0' + owner).digest('hex')
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`
}

/** The SDK independently verifies the state and issued OAuth client ID before
 * exchanging a code. Reject clearly wrong redirects at our browser boundary. */
export function validChatGPTCallback(redirectUrl: string, authorizationUrl: string): boolean {
  try {
    const callback = new URL(redirectUrl)
    const requestUrl = new URL(authorizationUrl)
    const expected = new URL(requestUrl.searchParams.get('redirect_uri') ?? '')
    return expected.protocol === 'http:' && expected.hostname === '127.0.0.1' &&
      expected.pathname === '/auth/callback' &&
      callback.origin === expected.origin && callback.pathname === expected.pathname &&
      callback.searchParams.get('state') === requestUrl.searchParams.get('state') &&
      !!callback.searchParams.get('code') && !!callback.searchParams.get('client_id') &&
      !!requestUrl.searchParams.get('state')
  } catch { return false }
}

function releaseCallback(flow: Flow) {
  if (flow.state && flowsByState.get(flow.state) === flow) flowsByState.delete(flow.state)
}

const callbackHeaders = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
}
const callbackPage = (message: string, status = 200) =>
  new Response('<!doctype html><meta charset="utf-8"><title>NovelTea authorization</title><p>' +
    message + '</p>', { status, headers: callbackHeaders })

/** Handle a provider redirect without an authenticated browser cookie. The
 * unguessable OAuth state identifies one pending account and is consumed once. */
export function chatGPTCallbackRequest(request: Request): Response {
  const requested = new URL(request.url)
  if (requested.pathname !== '/auth/callback') return callbackPage('Unknown callback.', 404)
  const studioOrigin = new URL(process.env.BETTER_AUTH_URL ?? 'http://localhost:3000').origin
  // After consuming the authorization code, move to the regular Studio origin.
  // Only this clean URL loads the popup-closing script; the code never reaches it.
  if (requested.searchParams.get('complete') === '1' && !requested.searchParams.has('state')) {
    return new Response(
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>ChatGPT connected</title></head>' +
      '<body><p>Authorization received. You can close this window.</p><p><a href="' +
      studioOrigin + '/">Return to NovelTea Studio</a></p>' +
      '<script src="/oauth-popup-complete.js" defer></script></body></html>',
      { headers: { ...callbackHeaders,
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'" } },
    )
  }
  const state = requested.searchParams.get('state')
  if (!state) return callbackPage('No authorization callback. Return to NovelTea Studio.', 400)
  const flow = flowsByState.get(state)
  if (!flow || flow.status !== 'pending' || !flow.url || !flow.resolveManual ||
      Date.now() > flow.expires) return callbackPage('No matching pending authorization.', 409)
  if (requested.searchParams.has('error')) {
    releaseCallback(flow)
    flow.status = 'failed'
    flow.reason = 'ChatGPT authorization was cancelled or denied.'
    flow.abort.abort()
    return callbackPage('ChatGPT authorization was not completed.', 400)
  }
  const callback = new URL(new URL(flow.url).searchParams.get('redirect_uri') ?? '')
  callback.search = requested.search
  if (callback.toString().length > 4096 || !validChatGPTCallback(callback.toString(), flow.url))
    return callbackPage('Invalid authorization callback.', 400)
  releaseCallback(flow)
  flow.status = 'completing'
  flow.resolveManual(callback.toString())
  // Never send an OAuth code, client ID, or state to Studio's main origin.
  // The browser can close a script-opened popup on the clean completion page.
  const clean = new URL('/auth/callback?complete=1', studioOrigin)
  return new Response(null, { status: 303, headers: { Location: clean.toString(),
    'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } })
}

function publicFlow(flow?: Flow) {
  if (!flow || Date.now() > flow.expires) return null
  return { status: flow.status, url: flow.url, reason: flow.reason }
}
async function inputBody(request: Request) {
  const reader = request.body?.getReader()
  if (!reader) throw new Error('Missing Pi credential request')
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > 16_384) throw new Error('Pi credential request exceeds size limit')
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown
}

export async function piModelsRequest(auth: StudioAuth, store: StudioDatabase,
  request: Request, baseURL: string) {
  if (!['GET', 'POST', 'DELETE'].includes(request.method)) return reply({ error: 'Method not allowed' }, 405)
  if (request.method !== 'GET' && request.headers.get('origin') !== baseURL)
    return reply({ error: 'Cross-origin write refused' }, 403)
  try {
    assertStudioSchemaCurrent(store)
    const actor = await requireUser(auth, request.headers)
    if (!actor) return reply({ error: 'Sign in required' }, 401)
    const credentials = userPiCredentials(store, actor.id)
    if (request.method === 'GET') {
      return reply({
        models: await availableUserPiModels(store, actor.id),
        connected: await credentials.list(),
        oauth: publicFlow(flows.get(actor.id)),
      })
    }
    const value = await inputBody(request)
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return reply({ error: 'Invalid credential request' }, 400)
    const input = value as Record<string, unknown>
    if (request.method === 'DELETE') {
      if (typeof input.provider !== 'string' || !['openai-codex', ...allowedApiProviders].includes(input.provider))
        return reply({ error: 'Invalid provider' }, 400)
      if (input.provider === 'openai' || input.provider === 'openai-codex') {
        const flow = flows.get(actor.id)
        if (flow) { releaseCallback(flow); flow.abort.abort() }
        flows.delete(actor.id)
      }
      await credentials.delete(input.provider)
      return reply({ connected: await credentials.list() })
    }
    if (input.action === 'api-key') {
      if (typeof input.provider !== 'string' || !allowedApiProviders.has(input.provider) ||
          typeof input.key !== 'string' || !input.key.trim() || input.key.length > 8192)
        return reply({ error: 'Choose a supported API provider and supply a key' }, 422)
      const runtime = await createUserPiRuntime(store, actor.id)
      if (!runtime.getProvider(input.provider)) return reply({ error: 'Pi provider is not installed' }, 422)
      if (input.provider === 'openai') {
        const flow = flows.get(actor.id)
        if (flow) { releaseCallback(flow); flow.abort.abort() }
        flows.delete(actor.id)
      }
      await credentials.modify(input.provider, async () => ({ type: 'api_key', key: input.key as string }))
      return reply({ connected: await credentials.list(), models: await availableUserPiModels(store, actor.id) })
    }
    if (input.action === 'oauth') {
      if (input.provider !== 'openai') return reply({ error: 'Use the OpenAI provider for ChatGPT subscription login' }, 422)
      const existing = flows.get(actor.id)
      if (existing && ['starting', 'pending', 'completing'].includes(existing.status) && Date.now() < existing.expires)
        return reply({ oauth: publicFlow(existing) })
      if (existing) { releaseCallback(existing); existing.abort.abort() }
      const flow: Flow = { status: 'starting', expires: Date.now() + 15 * 60_000, abort: new AbortController() }
      flows.set(actor.id, flow)
      // Even abandoned logins must release their state and pending Pi prompt.
      const timeout = setTimeout(() => {
        flow.status = 'failed'
        flow.reason = 'ChatGPT authorization expired. Start sign-in again.'
        releaseCallback(flow)
        flow.abort.abort()
      }, 15 * 60_000)
      timeout.unref()
      // Pi owns the device-code exchange and the credential refresh contract.
      // Only user-code/URL/status (never OAuth tokens) crosses into the browser.
      void (async () => {
        try {
          const runtime = await createUserPiRuntime(store, actor.id)
          await runtime.login('openai', 'oauth', {
            signal: flow.abort.signal,
            prompt: async prompt => {
              if (prompt.type !== 'manual_code') throw new Error('Unsupported OpenAI OAuth prompt')
              return new Promise<string>((resolve, reject) => {
                flow.resolveManual = resolve
                const signal = prompt.signal ?? flow.abort.signal
                if (signal.aborted) reject(new Error('Authorization cancelled'))
                else signal.addEventListener('abort', () => reject(new Error('Authorization cancelled')), { once: true })
              })
            },
            notify: event => {
              if (event.type === 'auth_url') {
                flow.abort.signal.throwIfAborted()
                const state = new URL(event.url).searchParams.get('state')
                if (!state || flowsByState.has(state)) throw new Error('Invalid OAuth authorization state')
                flow.url = event.url
                flow.state = state
                flow.status = 'pending'
                flowsByState.set(state, flow)
              }
            },
          }, { agentName: 'NovelTea Studio', callback: {
            mode: 'external', redirectUri: process.env.NT_PI_OAUTH_REDIRECT_URI ??
              'http://127.0.0.1:3000/auth/callback',
          }, getDeviceId: () => oauthHostDeviceId(actor.id, process.env.NT_PI_CREDENTIAL_KEY!) })
          flow.status = 'connected'
          delete flow.url
        } catch (error) {
          // A deliberate disconnect/replacement is not a failed sign-in.
          if (flow.abort.signal.aborted) return
          // This is an operator-only diagnostic. Never log OAuth URLs, codes,
          // refresh/access tokens, credentials, or arbitrary SDK error text.
          const kind = error instanceof Error ? error.name.replace(/[^A-Za-z]/g, '').slice(0, 50) : 'Unknown'
          const code = error && typeof error === 'object' && 'code' in error &&
            typeof error.code === 'string' && /^[A-Z_]{2,40}$/.test(error.code)
            ? error.code : 'unknown'
          const detail = error instanceof Error ? error.message
            .replace(/https?:\/\/\S+/g, '[url]')
            .replace(/\b(?:access_token|refresh_token|client_secret|code|token|authorization)\s*[=:]\s*[^\s,;]+/gi, '[credential]')
            .replace(/[A-Za-z0-9_.+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
            .replace(/[A-Za-z0-9_+\/-]{32,}={0,2}/g, '[redacted]')
            .slice(0, 180) : 'unknown'
          console.error('[Studio ChatGPT OAuth] Authorization flow failed', { kind, code, detail })
          flow.status = 'failed'
          flow.reason = 'ChatGPT authorization did not complete. Retry sign-in. (See Studio operator logs.)'
        } finally {
          clearTimeout(timeout)
          releaseCallback(flow)
          delete flow.resolveManual
        }
      })()
      return reply({ oauth: publicFlow(flow) }, 202)
    }
    if (input.action === 'oauth-complete') {
      const flow = flows.get(actor.id)
      if (!flow || flow.status !== 'pending' || !flow.url || !flow.resolveManual ||
          Date.now() > flow.expires) return reply({ error: 'No pending ChatGPT browser authorization' }, 409)
      if (typeof input.redirectUrl !== 'string' || input.redirectUrl.length > 4096)
        return reply({ error: 'Paste the final localhost redirect URL' }, 422)
      if (!validChatGPTCallback(input.redirectUrl, flow.url))
        return reply({ error: 'Redirect URL does not match the pending ChatGPT login' }, 422)
      // Only the original signed-in owner may complete this specific OAuth
      // flow. The SDK verifies state again before exchanging the code.
      releaseCallback(flow)
      flow.status = 'completing'
      flow.resolveManual(input.redirectUrl)
      return reply({ oauth: publicFlow(flow) }, 202)
    }
    return reply({ error: 'Unknown credential action' }, 400)
  } catch (error) {
    if (error instanceof Error && error.message.includes('NT_PI_CREDENTIAL_KEY'))
      return reply({ error: 'Studio Pi credential encryption is not configured (NT_PI_CREDENTIAL_KEY).' }, 503)
    return reply({ error: 'Unable to access user Pi credentials. Check connection and operator configuration.' }, 409)
  }
}
