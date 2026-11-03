import type { AuthEvent, AuthPrompt } from '@earendil-works/pi-ai'
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth'
import type { StudioAuth } from './auth'
import type { StudioDatabase } from '../db/connection'
import { assertStudioSchemaCurrent } from '../db/migrations'
import { requireUser } from './access.server'
import { availableUserPiModels, createUserPiRuntime, userPiCredentials } from './pi-credentials.server'
import { randomUUID } from 'node:crypto'

// Nitro does not trace Pi's variable-specified OAuth loader imports. This
// official registration imports provider flows without starting HTTP servers.
registerBunOAuthFlows()

type PromptView = { id: string; type: AuthPrompt['type']; message: string; placeholder?: string;
  options?: readonly { id: string; label: string; description?: string }[] }
type Flow = {
  owner: string; provider: string
  status: 'starting' | 'pending' | 'connected' | 'failed'
  expires: number; abort: AbortController; timeout?: ReturnType<typeof setTimeout>
  prompt?: PromptView; answer?: { id: string; respond: (value: string) => void; cancel: () => void }
  device?: { userCode: string; verificationUri: string }; message?: string; reason?: string
}
const flows = new Map<string, Flow>()
const allowedApiProviders = new Set(['openai', 'anthropic', 'google', 'openrouter', 'xai', 'groq', 'mistral'])
export const deviceOAuthProviders = new Set([
  'openai-codex', 'github-copilot', 'kimi-coding', 'meta', 'radius', 'xai',
])

const reply = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } })

function publicFlow(flow?: Flow) {
  if (!flow || Date.now() > flow.expires) return null
  return {
    status: flow.status, provider: flow.provider,
    ...(flow.device ? { device: flow.device } : {}),
    ...(flow.prompt ? { prompt: flow.prompt } : {}),
    ...(flow.message ? { message: flow.message } : {}),
    ...(flow.reason ? { reason: flow.reason } : {}),
  }
}

function finishFlow(flow: Flow) {
  if (flow.timeout) clearTimeout(flow.timeout)
  flow.timeout = undefined
  flow.answer?.cancel()
  delete flow.answer
  delete flow.prompt
  delete flow.device
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

/** A provider selector must never fall through to the browser callback path. */
export function deviceOnlySelection(provider: string, prompt: AuthPrompt): string | null {
  if (prompt.type === 'manual_code')
    throw new Error('Manual browser authorization is disabled in Studio')
  if (prompt.type !== 'select') return null
  const required = provider === 'openai-codex' ? 'device_code' :
    provider === 'radius' ? 'device-code' : null
  if (required) {
    if (!prompt.options.some(option => option.id === required))
      throw new Error('Provider does not offer its expected device-code login method')
    return required
  }
  if (prompt.options.some(option => /browser|callback/i.test(option.id)))
    throw new Error('Browser callback login is disabled in Studio')
  return null
}

function startDeviceLogin(store: StudioDatabase, flow: Flow) {
  const prompt = async (request: AuthPrompt): Promise<string> => {
    flow.abort.signal.throwIfAborted()
    if (request.signal?.aborted) throw new Error('Login prompt cancelled')
    const chosen = deviceOnlySelection(flow.provider, request)
    if (chosen !== null) return chosen
    if (flow.answer) throw new Error('Overlapping provider login prompts')
    const id = randomUUID()
    flow.prompt = {
      id, type: request.type, message: request.message,
      ...('placeholder' in request ? { placeholder: request.placeholder } : {}),
      ...(request.type === 'select' ? { options: request.options } : {}),
    }
    flow.status = 'pending'
    return new Promise<string>((resolve, reject) => {
      const cancel = () => {
        cleanup()
        reject(new Error('Authorization cancelled'))
      }
      const cleanup = () => {
        flow.abort.signal.removeEventListener('abort', cancel)
        request.signal?.removeEventListener('abort', cancel)
        if (flow.answer?.id === id) delete flow.answer
        if (flow.prompt?.id === id) delete flow.prompt
      }
      flow.answer = { id, respond: value => { cleanup(); resolve(value) }, cancel }
      flow.abort.signal.addEventListener('abort', cancel, { once: true })
      request.signal?.addEventListener('abort', cancel, { once: true })
      if (flow.abort.signal.aborted || request.signal?.aborted) cancel()
    })
  }
  const notify = (event: AuthEvent) => {
    if (flow.abort.signal.aborted) return
    if (event.type === 'device_code') {
      flow.device = { userCode: event.userCode, verificationUri: event.verificationUri }
      flow.status = 'pending'
    } else if (event.type === 'auth_url') {
      // Fail closed if a provider changes its login implementation: never ask
      // the user to follow a redirect that could start a local callback server.
      flow.status = 'failed'
      flow.reason = 'This provider unexpectedly requested browser callback login.'
      flow.abort.abort()
      finishFlow(flow)
    } else if (event.type === 'info' || event.type === 'progress') {
      flow.message = event.message.slice(0, 500)
    }
  }
  void (async () => {
    try {
      const runtime = await createUserPiRuntime(store, flow.owner)
      if (!runtime.getProvider(flow.provider)?.auth.oauth)
        throw new Error('Selected provider does not support subscription login')
      await runtime.login(flow.provider, 'oauth', { signal: flow.abort.signal, prompt, notify },
        { agentName: 'NovelTea Studio' })
      if (flow.abort.signal.aborted) return
      flow.status = 'connected'
      finishFlow(flow)
    } catch (error) {
      if (flow.abort.signal.aborted) return
      const kind = error instanceof Error ? error.name.replace(/[^A-Za-z]/g, '').slice(0, 50) : 'Unknown'
      console.error('[Studio Pi device login] Failed', { provider: flow.provider, kind })
      flow.status = 'failed'
      flow.reason = 'Device-code login did not complete. Check the provider settings or retry.'
      finishFlow(flow)
    }
  })()
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
      if (typeof input.provider !== 'string' ||
          !(allowedApiProviders.has(input.provider) || deviceOAuthProviders.has(input.provider)))
        return reply({ error: 'Invalid provider' }, 400)
      const flow = flows.get(actor.id)
      if (flow?.provider === input.provider) {
        flow.abort.abort()
        finishFlow(flow)
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
      const flow = flows.get(actor.id)
      if (flow?.provider === input.provider) {
        flow.abort.abort(); finishFlow(flow); flows.delete(actor.id)
      }
      await credentials.modify(input.provider, async () => ({ type: 'api_key', key: input.key as string }))
      return reply({ connected: await credentials.list(), models: await availableUserPiModels(store, actor.id) })
    }
    if (input.action === 'oauth') {
      if (typeof input.provider !== 'string' || !deviceOAuthProviders.has(input.provider))
        return reply({ error: 'Only device-code subscription providers are supported' }, 422)
      const existing = flows.get(actor.id)
      if (existing && ['starting', 'pending'].includes(existing.status) && Date.now() < existing.expires)
        return reply({ oauth: publicFlow(existing) }, 202)
      if (existing) { existing.abort.abort(); finishFlow(existing) }
      const flow: Flow = { owner: actor.id, provider: input.provider,
        status: 'starting', expires: Date.now() + 15 * 60_000, abort: new AbortController() }
      flows.set(actor.id, flow)
      flow.timeout = setTimeout(() => {
        if (flow.status === 'connected' || flow.status === 'failed') return
        flow.abort.abort()
        flow.status = 'failed'
        flow.reason = 'Device-code authorization expired. Start sign-in again.'
        finishFlow(flow)
      }, 15 * 60_000)
      startDeviceLogin(store, flow)
      return reply({ oauth: publicFlow(flow) }, 202)
    }
    if (input.action === 'oauth-answer') {
      const flow = flows.get(actor.id)
      if (!flow || flow.status !== 'pending' || Date.now() > flow.expires ||
          !flow.prompt || !flow.answer || typeof input.promptId !== 'string' ||
          flow.answer.id !== input.promptId || typeof input.value !== 'string' || input.value.length > 4096)
        return reply({ error: 'No matching pending provider prompt' }, 409)
      if (flow.prompt.type === 'select' &&
          !flow.prompt.options?.some(option => option.id === input.value))
        return reply({ error: 'Choose one of the offered options' }, 422)
      flow.answer.respond(input.value)
      flow.status = 'starting'
      return reply({ oauth: publicFlow(flow) })
    }
    if (input.action === 'oauth-cancel') {
      const flow = flows.get(actor.id)
      if (flow) {
        flow.abort.abort()
        finishFlow(flow)
        flows.delete(actor.id)
      }
      return reply({ oauth: null })
    }
    return reply({ error: 'Unknown credential action' }, 400)
  } catch (error) {
    if (error instanceof Error && error.message.includes('NT_PI_CREDENTIAL_KEY'))
      return reply({ error: 'Studio Pi credential encryption is not configured (NT_PI_CREDENTIAL_KEY).' }, 503)
    return reply({ error: 'Unable to access user Pi credentials. Check connection and operator configuration.' }, 409)
  }
}
