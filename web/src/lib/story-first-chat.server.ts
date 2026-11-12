import { createHash } from 'node:crypto'
import type { StudioAuth } from './auth'
import type { StudioStore } from '../persistence/store'
import { requireUser } from './access.server'
import { interpretNaturalStoryPrompt } from './natural-story-plan'
import { isExistingStoryModificationRequest } from './story-revision-plan'
import { beginStoryChatDiscovery } from './story-chat-discovery.server'
import { githubJobRequest } from './github-jobs.server'
import { gitlabJobRequest } from './gitlab-jobs.server'
import { authorizedStoryJob } from './fixture-jobs.server'
import { validatedExplorer } from './story-explorer.server'
import { verifiedReusableStoryFoundation } from './story-foundation-reuse.server'
import { launchNaturalStory } from './natural-story.server'
import { foundationOnlyObjective } from './foundation-intent'
import { initialStoryDocument } from './git-cache.server'
import { pinReusedFoundation } from '../../../src/chat-reused-foundation'
import type { DiscoveryInference } from './onboarding-pi.server'
import { validCreativeMode, type CreativeMode } from '../../../src/creative-policy'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

export type FirstStoryTurnInput = {
  storyId: string
  jobId: string
  prompt: string
  /** Explicit author confirmation of full-Story execution after clarification. */
  confirmFullStory?: boolean
  creativeMode?: CreativeMode
}
export type FirstStoryTurnResult = {
  storyId: string
  jobId: string
  threadId: string
  state: 'admitted' | 'pending' | 'attention' | 'discovery' | 'completed'
  message?: string
}

/** Story-first Chat admission. A first request, not a blank Thread, owns the
 * stable root identity. SQLite claims it before any external provider/CLI
 * operation, so double submissions and reconnects cannot race two writers. */
export async function submitFirstStoryTurn(
  auth: StudioAuth,
  store: StudioStore,
  headers: Headers,
  baseURL: string,
  input: FirstStoryTurnInput,
  infer?: DiscoveryInference,
): Promise<FirstStoryTurnResult> {
  await store.assertReady()
  const actor = await requireUser(auth, headers)
  if (!actor) throw new Error('Sign in required.')
  const origin = headers.get('origin')
  if (origin && origin !== baseURL) throw new Error('Cross-origin write refused.')
  if (
    !input ||
    !UUID.test(input.storyId) ||
    !UUID.test(input.jobId) ||
    (input.confirmFullStory !== undefined && typeof input.confirmFullStory !== 'boolean') ||
    (input.creativeMode !== undefined && !validCreativeMode(input.creativeMode))
  )
    throw new Error('Invalid first Story Turn.')
  // Preserve the original objective, independent of whatever baseline details
  // Pi subsequently proposes. The full generation contract is planned only
  // after this exact foundation has been reviewed, never from sparse input.
  const prompt = interpretNaturalStoryPrompt(input.prompt).task
  const { state } = await store.persistence.naturalStory.beginFirstTurn(
    actor.id,
    input.storyId,
    input.jobId,
    prompt,
    new Date().toISOString(),
    input.creativeMode,
  )
  const result: FirstStoryTurnResult = {
    storyId: input.storyId,
    jobId: input.jobId,
    threadId: 'root:' + input.jobId,
    state: 'pending',
  }
  if (state === 'admitted') return { ...result, state: 'admitted' }
  if (state === 'pending')
    return {
      ...result,
      message:
        'This request is already being prepared. Refresh the Thread to inspect its saved status; do not start a second writer.',
    }
  if (!infer && isExistingStoryModificationRequest(prompt)) {
    // No discovery or Foundation creation for a first-Turn edit. The shared
    // admission obtains an owner-bound native catalog and rejects ambiguity.
    try {
      const story = await store.persistence.naturalStory.story(actor.id, input.storyId)
      if (!story?.headSha) throw new Error('Story source is not verified')
      await launchNaturalStory(auth, store, headers, baseURL, {
        storyId: input.storyId, jobId: input.jobId,
        headSha: story.headSha, prompt, creativeMode: input.creativeMode,
      })
      await store.persistence.naturalStory.finishFirstTurn(actor.id, input.storyId, input.jobId, true)
      return { ...result, state: 'admitted' }
    } catch {
      if (await store.persistence.generation.queue.record(input.jobId)) {
        await store.persistence.naturalStory.finishFirstTurn(actor.id, input.storyId, input.jobId, true)
        return { ...result, state: 'admitted' }
      }
      await store.persistence.naturalStory.finishFirstTurn(actor.id, input.storyId, input.jobId, false)
      return { ...result, state: 'attention', message:
        'Review the focused target against the existing native-verified Story and confirm model access. No whole-Story generation or new Foundation was authorized.' }
    }
  }
  try {
    // A validated existing Creative Direction is already canonical author
    // context, not a reason to interview the author again. Probe the exact
    // owner/source-pinned provider job before opening a discovery session.
    // Failure to inspect a remote is not evidence that its foundation is ready.
    // A supplied inference driver is used only by deterministic discovery tests;
    // those tests must not invoke real provider network preflight.
    if (!infer) {
      let existing = false
      try {
        const story = await store.persistence.naturalStory.story(actor.id, input.storyId)
        const unapprovedInitialization = story?.initialContentSha256 &&
          createHash('sha256').update(initialStoryDocument(story.title)).digest('hex') ===
            story.initialContentSha256
        // A known initialization placeholder cannot be considered canon, and
        // there is no reason to fetch or clone it just to ask discovery questions.
        if (story?.headSha && !unapprovedInitialization) {
          const reqHeaders = new Headers(headers)
          reqHeaders.set('origin', baseURL)
          reqHeaders.set('content-type', 'application/json')
          const preparedRequest = new Request(baseURL + '/api/stories/job', {
            method: 'POST', headers: reqHeaders,
            body: JSON.stringify({ storyId: input.storyId, jobId: input.jobId,
              commit: story.headSha }),
          })
          const response = await (story.provider === 'github'
            ? githubJobRequest(auth, store, preparedRequest, baseURL)
            : gitlabJobRequest(auth, store, preparedRequest, baseURL))
          if (response.ok) {
            const job = await authorizedStoryJob(store, actor.id, input.jobId)
            const native = await validatedExplorer(auth, store,
              new Request(baseURL + '/api/stories/validation', { headers }), input.jobId)
            existing = await verifiedReusableStoryFoundation(job, native.result)
          }
        }
      } catch { /* Unavailable remote/CLI is not proof of an existing foundation. */ }
      if (existing) {
        try {
          if (foundationOnlyObjective(prompt)) {
            const job = await authorizedStoryJob(store, actor.id, input.jobId)
            await pinReusedFoundation(job, prompt)
            await store.persistence.naturalStory.associateRoot(actor.id, input.storyId,
              input.jobId, prompt.slice(0, 120), new Date().toISOString())
            await store.persistence.naturalStory.finishFoundationOnly(actor.id,
              input.storyId, input.jobId)
            return { ...result, state: 'completed' }
          }
          await launchNaturalStory(auth, store, headers, baseURL, {
            storyId: input.storyId, jobId: input.jobId,
            headSha: (await store.persistence.naturalStory.story(actor.id, input.storyId))!.headSha!,
            prompt, creativeMode: input.creativeMode,
          })
          await store.persistence.naturalStory.finishFirstTurn(actor.id, input.storyId, input.jobId, true)
          return { ...result, state: 'admitted' }
        } catch {
          if (await store.persistence.generation.queue.record(input.jobId)) {
            await store.persistence.naturalStory.finishFirstTurn(actor.id, input.storyId, input.jobId, true)
            return { ...result, state: 'admitted' }
          }
          await store.persistence.naturalStory.finishFirstTurn(actor.id, input.storyId, input.jobId, false)
          return { ...result, state: 'attention',
            message: 'This Story already has verified Creative Direction. Check model access and the generation controller, then retry the saved Turn; no new discovery is needed.' }
        }
      }
    }
    // The pinned first Turn is the sole discovery owner. A prior discovery
    // session is reloaded, not restarted or replayed on HTTP retry.
    const session = await beginStoryChatDiscovery(auth, store, headers, baseURL,
      input.storyId, input.jobId, prompt, infer)
    await store.persistence.naturalStory.finishFirstTurn(actor.id, input.storyId, input.jobId, false)
    return { ...result, state: 'discovery',
      ...(session.phase === 'blocked' ? { message: 'Discovery needs explicit recovery in Chat.' } : {}) }
  } catch (cause) {
    await store.persistence.naturalStory.finishFirstTurn(actor.id, input.storyId, input.jobId, false)
    const detail = cause instanceof Error ? cause.message : ''
    // Provider failures can contain remote URLs, private filesystem paths and
    // credential context. Keep the durable author request but disclose only
    // actionable, non-secret categories in the Chat response.
    const message = /Connect a Pi model|Pinned Pi credentials|credential/i.test(detail)
      ? 'Connect a Pi model and select a default in Settings, then retry this saved message. No fixture or host credential fallback was used.'
      : /source revision changed|base revision changed/i.test(detail)
        ? 'The Story base revision changed. Inspect the saved Story before continuing discovery.'
        : 'Discovery could not finish. Your original message is saved; inspect the pinned discovery session in Chat before explicitly retrying any interrupted model call.'
    return { ...result, state: 'attention', message }
  }
}
