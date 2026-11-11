import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { auth, database } from './runtime.server'
import { readAuthConfig } from './auth'
import { storyChatDiscoveryRequest } from './story-chat-discovery.server'
import type { DiscoverySessionView } from './onboarding-pi.server'

type Identity = { storyId: string; firstTurnId: string }
type Action = Identity & { action: 'answer' | 'revise' | 'approve' | 'retry' | 'reconcile' | 'continue';
  revision: number; text?: string; digest?: string }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
function valid(input: Identity) {
  if (!input || !uuid.test(input.storyId) || !uuid.test(input.firstTurnId))
    throw new Error('Invalid saved Story/Thread.')
  return input
}
async function unwrap(response: Response) {
  const body = await response.json() as { session?: DiscoverySessionView | null; continuation?: { state: string; message?: string }; error?: string }
  if (!response.ok) throw new Error(body.error ?? 'Discovery state could not be verified.')
  return body
}
function headers() { return new Headers(getRequestHeaders()) }

export const readStoryChatDiscovery = createServerFn({ method: 'GET' })
  .validator((data: Identity) => valid(data))
  .handler(async ({ data }) => unwrap(await storyChatDiscoveryRequest(
    auth, database, new Request(readAuthConfig().baseURL + '/api/story-chat-discovery', {
      headers: headers(),
    }), readAuthConfig().baseURL, data.storyId, data.firstTurnId)))

export const actStoryChatDiscovery = createServerFn({ method: 'POST' })
  .validator((data: Action) => {
    valid(data)
    if (!['answer', 'revise', 'approve', 'retry', 'reconcile', 'continue'].includes(data.action) ||
        !Number.isSafeInteger(data.revision) || data.revision < 1 ||
        (data.text !== undefined && (typeof data.text !== 'string' || data.text.length > 4000)) ||
        (data.digest !== undefined && (typeof data.digest !== 'string' || !/^[a-f0-9]{64}$/.test(data.digest))))
      throw new Error('Invalid discovery action.')
    return data
  })
  .handler(async ({ data }) => {
    const origin = readAuthConfig().baseURL
    const requestHeaders = headers()
    requestHeaders.set('origin', origin)
    const { storyId, firstTurnId, ...body } = data
    return unwrap(await storyChatDiscoveryRequest(auth, database,
      new Request(origin + '/api/story-chat-discovery', {
        method: 'POST', headers: requestHeaders, body: JSON.stringify(body),
      }), origin, storyId, firstTurnId))
  })
