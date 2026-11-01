import type { StudioAuth } from './auth'
import type { StudioDatabase } from '../db/connection'
import { assertStudioSchemaCurrent } from '../db/migrations'
import { requireUser } from './access.server'
import { availableUserPiModels, createUserPiRuntime, userPiCredentials } from './pi-credentials.server'

type Flow = { status: 'starting' | 'pending' | 'connected' | 'failed'
  code?: string; url?: string; expires: number; reason?: string; abort: AbortController }
const flows = new Map<string, Flow>()
const allowedApiProviders = new Set(['openai', 'anthropic', 'google', 'openrouter', 'xai', 'groq', 'mistral'])
const reply = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } })

function publicFlow(flow?: Flow) {
  if (!flow || Date.now() > flow.expires) return null
  return { status: flow.status, code: flow.code, url: flow.url, reason: flow.reason }
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
      if (input.provider === 'openai-codex') {
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
      await credentials.modify(input.provider, async () => ({ type: 'api_key', key: input.key as string }))
      return reply({ connected: await credentials.list(), models: await availableUserPiModels(store, actor.id) })
    }
    if (input.action === 'oauth') {
      if (input.provider !== 'openai-codex') return reply({ error: 'Unsupported Pi OAuth provider' }, 422)
      const existing = flows.get(actor.id)
      if (existing && existing.status === 'pending' && Date.now() < existing.expires)
        return reply({ oauth: publicFlow(existing) })
      existing?.abort.abort()
      const flow: Flow = { status: 'starting', expires: Date.now() + 15 * 60_000, abort: new AbortController() }
      flows.set(actor.id, flow)
      // Pi owns the device-code exchange and the credential refresh contract.
      // Only user-code/URL/status (never OAuth tokens) crosses into the browser.
      void (async () => {
        try {
          const runtime = await createUserPiRuntime(store, actor.id)
          await runtime.login('openai-codex', 'oauth', {
            signal: flow.abort.signal,
            prompt: async prompt => {
              if (prompt.type === 'select' && prompt.options.some(option => option.id === 'device_code'))
                return 'device_code'
              throw new Error('Unsupported Pi OAuth prompt')
            },
            notify: event => {
              if (event.type === 'device_code') {
                flow.code = event.userCode
                flow.url = event.verificationUri
                flow.status = 'pending'
              }
            },
          }, { agentName: 'NovelTea Studio' })
          flow.status = 'connected'
          delete flow.code
          delete flow.url
        } catch {
          flow.status = 'failed'
          flow.reason = 'ChatGPT authorization was not completed. Retry the connection.'
        }
      })()
      return reply({ oauth: publicFlow(flow) }, 202)
    }
    return reply({ error: 'Unknown credential action' }, 400)
  } catch (error) {
    if (error instanceof Error && error.message.includes('NT_PI_CREDENTIAL_KEY'))
      return reply({ error: 'Studio Pi credential encryption is not configured (NT_PI_CREDENTIAL_KEY).' }, 503)
    return reply({ error: 'Unable to access user Pi credentials. Check connection and operator configuration.' }, 409)
  }
}
