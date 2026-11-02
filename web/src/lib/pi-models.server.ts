import { createHmac } from 'node:crypto'
import type { StudioAuth } from './auth'
import type { StudioDatabase } from '../db/connection'
import { assertStudioSchemaCurrent } from '../db/migrations'
import { requireUser } from './access.server'
import { availableUserPiModels, createUserPiRuntime, userPiCredentials } from './pi-credentials.server'

type Flow = { status: 'starting' | 'pending' | 'completing' | 'connected' | 'failed'
  url?: string; expires: number; reason?: string; abort: AbortController;
  resolveManual?: (value: string) => void }
const flows = new Map<string, Flow>()
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
    return callback.origin === 'http://127.0.0.1:1455' &&
      callback.pathname === '/auth/callback' &&
      callback.searchParams.get('state') === requestUrl.searchParams.get('state') &&
      !!callback.searchParams.get('code') && !!callback.searchParams.get('client_id') &&
      !!requestUrl.searchParams.get('state')
  } catch { return false }
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
        flows.get(actor.id)?.abort.abort()
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
        flows.get(actor.id)?.abort.abort()
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
      existing?.abort.abort()
      const flow: Flow = { status: 'starting', expires: Date.now() + 15 * 60_000, abort: new AbortController() }
      flows.set(actor.id, flow)
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
                flow.url = event.url
                flow.status = 'pending'
              }
            },
          }, { agentName: 'NovelTea Studio',
            getDeviceId: () => oauthHostDeviceId(actor.id, process.env.NT_PI_CREDENTIAL_KEY!) })
          flow.status = 'connected'
          delete flow.url
        } catch {
          flow.status = 'failed'
          flow.reason = 'ChatGPT authorization did not complete. Retry sign-in.'
        } finally {
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
