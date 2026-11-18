import type { StudioAuth } from './auth'
import type { StudioStore } from '../persistence/store'
import { requireUser } from './access.server'
import { onboardingPiRequest, type ChatDiscoveryBinding, type DiscoveryInference } from './onboarding-pi.server'
import { readDefaultModel } from './settings.server'
import { availableUserPiModels } from './pi-credentials.server'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

/** No caller supplies a repository/workspace, a source SHA or a creative brief.
 * Resolve all of them from the one durable, owner-scoped first Turn. The shared
 * Pi discovery state machine supplies CAS, crash fencing and exact approval. */
export async function storyChatDiscoveryRequest(
  auth: StudioAuth, store: StudioStore, request: Request, baseURL: string,
  storyId: string, firstTurnId: string, infer?: DiscoveryInference,
): Promise<Response> {
  if (!UUID.test(storyId) || !UUID.test(firstTurnId))
    return Response.json({ error: 'Invalid Story or first Turn identity.' }, { status: 400 })
  await store.assertReady()
  const actor = await requireUser(auth, request.headers)
  if (!actor) return Response.json({ error: 'Sign in required.' }, { status: 401 })
  const story = await store.persistence.naturalStory.story(actor.id, storyId)
  const message = await store.persistence.messages.owned(actor.id, 'root:' + firstTurnId, firstTurnId)
  const membership = message ? await store.persistence.messages.membership(actor.id,
    'root:' + firstTurnId) : null
  if (!story || !message || membership?.storyId !== storyId || message.role !== 'user' ||
      (message.jobId && message.jobId !== firstTurnId) || message.phase === 'cancelled' || !story.headSha ||
      message.content.length > 4000)
    return Response.json({ error: 'This Story has no eligible saved first Turn.' }, { status: 404 })
  const binding: ChatDiscoveryBinding = {
    storyId, firstTurnId, repositoryId: story.repositoryId, directory: story.directory,
    sourceSha: story.headSha, originalObjective: message.content,
  }
  return onboardingPiRequest(auth, store, request, baseURL, infer, binding)
}

export async function beginStoryChatDiscovery(
  auth: StudioAuth, store: StudioStore, headers: Headers, baseURL: string,
  storyId: string, firstTurnId: string, objective: string, infer?: DiscoveryInference,
) {
  const actor = await requireUser(auth, headers)
  if (!actor) throw new Error('Sign in required.')
  const existing = await storyChatDiscoveryRequest(auth, store,
    new Request(baseURL + '/api/story-chat-discovery', { headers }),
    baseURL, storyId, firstTurnId)
  if (!existing.ok) throw new Error('Saved discovery state could not be read.')
  const stored = await existing.json() as { session: { phase: string } | null }
  if (stored.session) return stored.session

  const model = await readDefaultModel(store.persistence.settings, actor.id)
  const connected = await availableUserPiModels(store, actor.id)
  if (!model || !connected.some(candidate => candidate.provider === model.provider &&
      candidate.id === model.id && (!model.thinking || candidate.reasoning)))
    throw new Error('Connect an AI model and set a default in Settings before starting Story discovery.')
  const response = await storyChatDiscoveryRequest(auth, store,
    new Request(baseURL + '/api/story-chat-discovery', {
      method: 'POST', headers: new Headers({ ...Object.fromEntries(headers), origin: baseURL }),
      body: JSON.stringify({ action: 'start', text: objective, model }),
    }), baseURL, storyId, firstTurnId, infer)
  const value = await response.json() as { session?: { phase: string }; error?: string }
  if (!response.ok || !value.session)
    throw new Error(value.error ?? 'Discovery could not be started safely.')
  return value.session
}
