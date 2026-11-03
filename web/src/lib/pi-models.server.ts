import { createHmac, randomUUID } from 'node:crypto'
import { createModels, type AuthEvent, type AuthPrompt, type OAuthAuthorization } from '@earendil-works/pi-ai'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter'
import { radiusProvider } from '@earendil-works/pi-ai/providers/radius'
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
import { cancelBrowserAuthorization, claimBrowserAuthorization, finishBrowserAuthorization,
  ownerBrowserFlow, pendingByState, saveBrowserAuthorization } from './pi-oauth-pending.server'

type PromptView = { id: string; type: AuthPrompt['type']; message: string; placeholder?: string;
  options?: readonly { id: string; label: string; description?: string }[] }
type Flow = { status: 'starting' | 'pending' | 'completing' | 'connected' | 'failed'
  owner: string; provider: string; interactive?: boolean; alternativeMethod?: string; url?: string; state?: string;
  authorization?: OAuthAuthorization; prompt?: PromptView; message?: string;
  device?: { userCode: string; verificationUri: string }; answer?: {
    id: string; respond: (value: string) => void; cancel: () => void
  };
  expires: number; reason?: string; abort: AbortController; timeout?: ReturnType<typeof setTimeout> }
const flows = new Map<string, Flow>()
// Random provider-generated state is the one-use callback correlation key.
// No Studio session cookie is expected on the provider's redirect.
const flowsByState = new Map<string, Flow>()
const allowedApiProviders = new Set([
  'openai', 'anthropic', 'google', 'openrouter', 'xai', 'groq', 'mistral',
  'github-copilot', 'kimi-coding', 'meta', 'radius',
])
const oauthProviders = new Set([
  'openai', 'anthropic', 'github-copilot', 'kimi-coding', 'meta',
  'openai-codex', 'openrouter', 'radius', 'xai',
])
const browserOAuthProviders = new Set(['openai', 'anthropic', 'openai-codex', 'openrouter', 'radius'])
const callbackPaths = new Set(['/auth/callback', '/callback', '/oauth/callback'])

function browserRedirect(provider: string): string {
  const studio = new URL(process.env.BETTER_AUTH_URL ?? 'http://localhost:3000')
  if (provider === 'openai')
    return process.env.NT_PI_OAUTH_REDIRECT_URI ??
      `http://127.0.0.1:${studio.hostname === 'localhost' || studio.hostname === '127.0.0.1'
        ? studio.port || '3000' : '3000'}/auth/callback`
  if (provider === 'openai-codex')
    return 'http://localhost:1455/auth/callback'
  if (provider === 'anthropic' && studio.hostname === '127.0.0.1') {
    studio.hostname = 'localhost'
    return new URL('/callback', studio).toString()
  }
  return new URL(provider === 'anthropic' ? '/callback' :
    provider === 'radius' ? '/oauth/callback' : '/auth/callback', studio).toString()
}

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

/** Reject malformed redirects before passing them to Pi for its own validation. */
export function validPiCallback(redirectUrl: string, authorizationUrl: string, provider: string): boolean {
  try {
    const callback = new URL(redirectUrl)
    const requestUrl = new URL(authorizationUrl)
    const expected = new URL(requestUrl.searchParams.get(provider === 'openrouter' ? 'callback_url' : 'redirect_uri') ?? '')
    return callback.origin === expected.origin && callback.pathname === expected.pathname &&
      callback.searchParams.get('state') === requestUrl.searchParams.get('state') &&
      !!requestUrl.searchParams.get('state') && !!callback.searchParams.get('code') &&
      (provider !== 'openai' || !!callback.searchParams.get('client_id'))
  } catch { return false }
}
export const validChatGPTCallback = (redirectUrl: string, authorizationUrl: string) =>
  validPiCallback(redirectUrl, authorizationUrl, 'openai')

function releaseCallback(flow: Flow) {
  if (flow.state && flowsByState.get(flow.state) === flow) flowsByState.delete(flow.state)
}
function finishFlow(flow: Flow) {
  releaseCallback(flow)
  if (flow.timeout) clearTimeout(flow.timeout)
  flow.answer?.cancel()
  delete flow.authorization
  delete flow.prompt
  delete flow.device
}
function studioOAuth(store: StudioDatabase, owner: string, provider: string) {
  const models = createModels({ credentials: userPiCredentials(store, owner) })
  switch (provider) {
    case 'anthropic': models.setProvider(anthropicProvider()); break
    case 'openai-codex': models.setProvider(openaiCodexProvider()); break
    case 'openrouter': models.setProvider(openrouterProvider()); break
    case 'radius': models.setProvider(radiusProvider()); break
    default: models.setProvider(openaiProvider())
  }
  return models
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
export async function piOAuthCallbackRequest(request: Request, store: StudioDatabase): Promise<Response> {
  const requested = new URL(request.url)
  if (!callbackPaths.has(requested.pathname)) return callbackPage('Unknown callback.', 404)
  const studioOrigin = new URL(process.env.BETTER_AUTH_URL ?? 'http://localhost:3000').origin
  // After consuming the authorization code, move to the regular Studio origin.
  // Only this clean URL loads the popup-closing script; the code never reaches it.
  if (requested.searchParams.get('complete') === '1' && !requested.searchParams.has('state')) {
    return new Response(
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Model provider connected</title></head>' +
      '<body><p>Authorization received. You can close this window.</p><p><a href="' +
      studioOrigin + '/">Return to NovelTea Studio</a></p>' +
      '<script src="/oauth-popup-complete.js" defer></script></body></html>',
      { headers: { ...callbackHeaders,
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'" } },
    )
  }
  const state = requested.searchParams.get('state')
  if (!state) return callbackPage('No authorization callback. Return to NovelTea Studio.', 400)
  const pending = pendingByState(store, state)
  if (!pending || !browserOAuthProviders.has(pending.provider))
    return callbackPage('No matching pending authorization.', 409)
  const flow = flowsByState.get(state)
  if (requested.searchParams.has('error')) {
    finishBrowserAuthorization(store, pending.owner, state, 'failed', 'Provider authorization was cancelled or denied.')
    if (flow) { flow.status = 'failed'; finishFlow(flow); flow.abort.abort() }
    return callbackPage('Provider authorization was not completed.', 400)
  }
  const callback = requested
  if (callback.toString().length > 4096 || !validPiCallback(callback.toString(), pending.authorization.url, pending.provider))
    return callbackPage('Invalid authorization callback.', 400)
  if (!claimBrowserAuthorization(store, pending.owner, state))
    return callbackPage('No matching pending authorization.', 409)
  if (flow) { releaseCallback(flow); flow.status = 'completing' }
  try {
    await studioOAuth(store, pending.owner, pending.provider).completeOAuth(pending.provider,
      pending.authorization, callback.toString(), { signal: flow?.abort.signal })
    finishBrowserAuthorization(store, pending.owner, state, 'connected')
    if (flow) { flow.status = 'connected'; delete flow.url; finishFlow(flow) }
  } catch {
    finishBrowserAuthorization(store, pending.owner, state, 'failed', 'Provider authorization could not be completed.')
    if (flow) { flow.status = 'failed'; flow.reason = 'Provider authorization could not be completed.'; finishFlow(flow) }
    return callbackPage('Provider authorization could not be completed.', 400)
  }
  // Never send an OAuth code, client ID, or state to Studio's main origin.
  // The browser can close a script-opened popup on the clean completion page.
  const clean = new URL('/auth/callback?complete=1', studioOrigin)
  return new Response(null, { status: 303, headers: { Location: clean.toString(),
    'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } })
}

export const chatGPTCallbackRequest = piOAuthCallbackRequest

function publicFlow(flow?: Flow) {
  if (!flow || Date.now() > flow.expires) return null
  return { status: flow.status, provider: flow.provider, interactive: !!flow.interactive,
    url: flow.url, reason: flow.reason, message: flow.message, prompt: flow.prompt, device: flow.device }
}

/** Pi's interactive OAuth contract becomes owner-scoped one-shot HTTP prompts.
 * Pi owns token exchange and device-code polling; no tokens reach the browser. */
function runInteractiveLogin(store: StudioDatabase, flow: Flow) {
  const notify = (event: AuthEvent) => {
    if (flow.abort.signal.aborted) return
    if (event.type === 'auth_url') {
      flow.url = event.url
      flow.message = event.instructions
      flow.status = 'pending'
    } else if (event.type === 'device_code') {
      flow.device = { userCode: event.userCode, verificationUri: event.verificationUri }
      flow.status = 'pending'
    } else if (event.type === 'progress' || event.type === 'info') {
      flow.message = event.message
    }
  }
  const prompt = (request: AuthPrompt): Promise<string> => {
    if (flow.abort.signal.aborted || request.signal?.aborted)
      return Promise.reject(new Error('Login cancelled'))
    if (flow.alternativeMethod && request.type === 'select' &&
        request.options.some(option => option.id === flow.alternativeMethod))
      return Promise.resolve(flow.alternativeMethod)
    if (flow.answer) return Promise.reject(new Error('Overlapping Pi OAuth prompts'))
    const view: PromptView = { id: randomUUID(), type: request.type, message: request.message,
      ...('placeholder' in request ? { placeholder: request.placeholder } : {}),
      ...(request.type === 'select' ? { options: request.options } : {}) }
    flow.prompt = view
    flow.status = 'pending'
    return new Promise((resolve, reject) => {
      const clear = () => {
        flow.abort.signal.removeEventListener('abort', cancel)
        request.signal?.removeEventListener('abort', cancel)
        if (flow.prompt === view) delete flow.prompt
        if (flow.answer?.id === view.id) delete flow.answer
      }
      const cancel = () => { clear(); reject(new Error('Login cancelled')) }
      const respond = (value: string) => { clear(); resolve(value) }
      flow.answer = { id: view.id, respond, cancel }
      flow.abort.signal.addEventListener('abort', cancel, { once: true })
      request.signal?.addEventListener('abort', cancel, { once: true })
      if (flow.abort.signal.aborted || request.signal?.aborted) cancel()
    })
  }
  void (async () => {
    try {
      const runtime = await createUserPiRuntime(store, flow.owner)
      flow.abort.signal.throwIfAborted()
      if (!runtime.getProvider(flow.provider)?.auth.oauth) throw new Error('Provider does not support Pi OAuth')
      await runtime.login(flow.provider, 'oauth',
        { prompt, notify, signal: flow.abort.signal }, { agentName: 'NovelTea Studio' })
      if (flow.abort.signal.aborted) return
      flow.status = 'connected'
      delete flow.url
    } catch (error) {
      if (flow.abort.signal.aborted) return
      flow.status = 'failed'
      console.error('[Studio Pi OAuth] Authorization failed', flow.provider, error instanceof Error ? error.name : 'Unknown')
      flow.reason = 'Provider authorization failed. Retry or choose another login method.'
    } finally {
      finishFlow(flow)
    }
  })()
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
        oauth: ownerBrowserFlow(store, actor.id) ?? publicFlow(flows.get(actor.id)),
      })
    }
    const value = await inputBody(request)
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return reply({ error: 'Invalid credential request' }, 400)
    const input = value as Record<string, unknown>
    if (request.method === 'DELETE') {
      if (typeof input.provider !== 'string' || !(allowedApiProviders.has(input.provider) || oauthProviders.has(input.provider)))
        return reply({ error: 'Invalid provider' }, 400)
      const flow = flows.get(actor.id)
      if (flow?.provider === input.provider) {
        flow.abort.abort()
        finishFlow(flow)
        flows.delete(actor.id)
      }
      if (ownerBrowserFlow(store, actor.id)?.provider === input.provider)
        cancelBrowserAuthorization(store, actor.id)
      await credentials.delete(input.provider)
      return reply({ connected: await credentials.list() })
    }
    if (input.action === 'api-key') {
      if (typeof input.provider !== 'string' || !allowedApiProviders.has(input.provider) ||
          typeof input.key !== 'string' || !input.key.trim() || input.key.length > 8192)
        return reply({ error: 'Choose a supported API provider and supply a key' }, 422)
      const runtime = await createUserPiRuntime(store, actor.id)
      if (!runtime.getProvider(input.provider)) return reply({ error: 'Pi provider is not installed' }, 422)
      const flow = flows.get(actor.id)
      if (flow?.provider === input.provider) {
        flow.abort.abort()
        finishFlow(flow)
        flows.delete(actor.id)
      }
      if (ownerBrowserFlow(store, actor.id)?.provider === input.provider)
        cancelBrowserAuthorization(store, actor.id)
      await credentials.modify(input.provider, async () => ({ type: 'api_key', key: input.key as string }))
      return reply({ connected: await credentials.list(), models: await availableUserPiModels(store, actor.id) })
    }
    if (input.action === 'oauth') {
      if (typeof input.provider !== 'string' || !oauthProviders.has(input.provider))
        return reply({ error: 'Choose a Pi provider with OAuth login' }, 422)
      const pending = ownerBrowserFlow(store, actor.id)
      if (pending && ['pending', 'completing'].includes(pending.status))
        return reply({ oauth: pending })
      const existing = flows.get(actor.id)
      if (existing && ['starting', 'pending', 'completing'].includes(existing.status) && Date.now() < existing.expires)
        return reply({ oauth: publicFlow(existing) })
      if (existing) { existing.abort.abort(); finishFlow(existing) }
      cancelBrowserAuthorization(store, actor.id)
      const alternative = input.method === 'copy-code' && input.provider === 'anthropic' ? 'copy_code' :
        input.method === 'device-code' && input.provider === 'radius' ? 'device-code' :
        input.method === 'device-code' && input.provider === 'openai-codex' ? 'device_code' : undefined
      const flow: Flow = { owner: actor.id, provider: input.provider, alternativeMethod: alternative,
        interactive: !browserOAuthProviders.has(input.provider) || input.method === 'interactive' || !!alternative,
        status: 'starting', expires: Date.now() + 15 * 60_000, abort: new AbortController() }
      flows.set(actor.id, flow)
      // Even abandoned authorizations must release their state and PKCE context.
      flow.timeout = setTimeout(() => {
        flow.status = 'failed'
        flow.reason = 'Provider authorization expired. Start sign-in again.'
        if (!flow.interactive && flow.state)
          finishBrowserAuthorization(store, flow.owner, flow.state, 'failed', flow.reason)
        finishFlow(flow)
        flow.abort.abort()
      }, 15 * 60_000)
      flow.timeout.unref()
      if (flow.interactive) {
        runInteractiveLogin(store, flow)
        return reply({ oauth: publicFlow(flow) }, 202)
      }
      // Only the authorization URL reaches the browser. The opaque PKCE
      // context remains with this owner on the trusted Studio server.
      try {
        const authorization = await studioOAuth(store, actor.id, flow.provider).beginOAuth(flow.provider, {
          signal: flow.abort.signal,
          agentName: 'NovelTea Studio',
          redirectUri: browserRedirect(flow.provider),
          getDeviceId: () => oauthHostDeviceId(actor.id, process.env.NT_PI_CREDENTIAL_KEY!),
        })
        flow.abort.signal.throwIfAborted()
        if (flowsByState.has(authorization.state)) throw new Error('OAuth authorization state collision')
        saveBrowserAuthorization(store, actor.id, flow.provider, authorization, flow.expires)
        flow.authorization = authorization
        flow.url = authorization.url
        flow.state = authorization.state
        flow.status = 'pending'
        flowsByState.set(authorization.state, flow)
      } catch (error) {
        if (flow.abort.signal.aborted) return reply({ error: 'Provider authorization expired' }, 409)
        // Avoid exposing authorization details in responses or logs.
        console.error('[Studio Pi OAuth] Authorization start failed', flow.provider, error instanceof Error ? error.name : 'Unknown')
        flow.status = 'failed'
        flow.reason = 'Provider authorization did not start. Check Studio operator logs.'
        finishFlow(flow)
      }
      return reply({ oauth: ownerBrowserFlow(store, actor.id) ?? publicFlow(flow) }, flow.status === 'failed' ? 503 : 202)
    }
    if (input.action === 'oauth-answer') {
      const flow = flows.get(actor.id)
      if (!flow?.interactive || flow.status !== 'pending' || Date.now() > flow.expires || !flow.prompt || !flow.answer ||
          typeof input.promptId !== 'string' || input.promptId !== flow.answer.id ||
          typeof input.value !== 'string' || input.value.length > 4096)
        return reply({ error: 'No matching pending provider prompt' }, 409)
      if (flow.prompt.type === 'select' &&
          !flow.prompt.options?.some(option => option.id === input.value))
        return reply({ error: 'Choose one of the offered login methods' }, 422)
      flow.answer.respond(input.value)
      flow.status = 'starting'
      return reply({ oauth: publicFlow(flow) })
    }
    if (input.action === 'oauth-cancel') {
      if (ownerBrowserFlow(store, actor.id)?.status === 'completing')
        return reply({ error: 'Authorization is already completing' }, 409)
      const flow = flows.get(actor.id)
      if (flow) {
        flow.abort.abort()
        finishFlow(flow)
        flows.delete(actor.id)
      }
      cancelBrowserAuthorization(store, actor.id)
      return reply({ oauth: null })
    }
    if (input.action === 'oauth-complete') {
      if (typeof input.redirectUrl !== 'string' || input.redirectUrl.length > 4096)
        return reply({ error: 'Paste the final browser redirect URL' }, 422)
      let state: string | null = null
      try { state = new URL(input.redirectUrl).searchParams.get('state') } catch { /* invalid input */ }
      const pending = state ? pendingByState(store, state) : null
      if (!pending || pending.owner !== actor.id || !browserOAuthProviders.has(pending.provider))
        return reply({ error: 'No pending browser authorization' }, 409)
      if (!validPiCallback(input.redirectUrl, pending.authorization.url, pending.provider))
        return reply({ error: 'Redirect URL does not match the pending provider login' }, 422)
      if (!claimBrowserAuthorization(store, pending.owner, state!))
        return reply({ error: 'Authorization callback was already consumed' }, 409)
      const flow = flowsByState.get(state!)
      if (flow) { releaseCallback(flow); flow.status = 'completing' }
      try {
        await studioOAuth(store, pending.owner, pending.provider).completeOAuth(pending.provider,
          pending.authorization, input.redirectUrl, { signal: flow?.abort.signal })
        finishBrowserAuthorization(store, pending.owner, state!, 'connected')
        if (flow) { flow.status = 'connected'; delete flow.url; finishFlow(flow) }
        return reply({ oauth: ownerBrowserFlow(store, pending.owner) })
      } catch {
        finishBrowserAuthorization(store, pending.owner, state!, 'failed',
          'Provider authorization could not be completed.')
        if (flow) { flow.status = 'failed'; flow.reason = 'Provider authorization could not be completed.'; finishFlow(flow) }
        return reply({ oauth: ownerBrowserFlow(store, pending.owner) }, 409)
      }
    }
    return reply({ error: 'Unknown credential action' }, 400)
  } catch (error) {
    if (error instanceof Error && error.message.includes('NT_PI_CREDENTIAL_KEY'))
      return reply({ error: 'Studio Pi credential encryption is not configured (NT_PI_CREDENTIAL_KEY).' }, 503)
    return reply({ error: 'Unable to access user Pi credentials. Check connection and operator configuration.' }, 409)
  }
}
