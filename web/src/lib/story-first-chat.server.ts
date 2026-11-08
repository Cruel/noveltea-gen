import type { StudioAuth } from './auth'
import type { StudioStore } from '../persistence/store'
import { requireUser } from './access.server'
import { interpretNaturalStoryPrompt } from './natural-story-plan'
import { launchNaturalStory } from './natural-story.server'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

export type FirstStoryTurnInput = {
  storyId: string
  jobId: string
  prompt: string
  /** Explicit author confirmation of full-Story execution after clarification. */
  confirmFullStory?: boolean
}
export type FirstStoryTurnResult = {
  storyId: string
  jobId: string
  threadId: string
  state: 'admitted' | 'pending' | 'attention'
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
    (input.confirmFullStory !== undefined && typeof input.confirmFullStory !== 'boolean')
  )
    throw new Error('Invalid first Story Turn.')
  const plan = interpretNaturalStoryPrompt(input.prompt)
  const prompt = plan.task
  const { headSha, state } = await store.persistence.naturalStory.beginFirstTurn(
    actor.id,
    input.storyId,
    input.jobId,
    prompt,
    new Date().toISOString(),
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
  try {
    if (plan.reviewRequired && !input.confirmFullStory) {
      await store.persistence.naturalStory.finishFirstTurn(actor.id, input.storyId, input.jobId, false)
      return {
        ...result,
        state: 'attention',
        message: plan.clarification ?? 'Confirm full-Story generation before starting.',
      }
    }
    await launchNaturalStory(auth, store, headers, baseURL, {
      storyId: input.storyId,
      jobId: input.jobId,
      headSha,
      prompt,
      ...(input.confirmFullStory ? { approvedDigest: plan.digest } : {}),
    })
    await store.persistence.naturalStory.finishFirstTurn(actor.id, input.storyId, input.jobId, true)
    return { ...result, state: 'admitted' }
  } catch (cause) {
    await store.persistence.naturalStory.finishFirstTurn(actor.id, input.storyId, input.jobId, false)
    const detail = cause instanceof Error ? cause.message : ''
    // Provider failures can contain remote URLs, private filesystem paths and
    // credential context. Keep the durable author request but disclose only
    // actionable, non-secret categories in the Chat response.
    const message = /Connect a Pi model|Pinned Pi credentials|credential/i.test(detail)
      ? 'Connect a Pi model and select a default in Settings, then retry this saved message. No fixture or host credential fallback was used.'
      : /base revision changed/i.test(detail)
        ? 'The Story base revision changed. Inspect the Story connection and pinned source before retrying.'
        : 'Generation was not admitted. Your message is saved; check Story repository access, provider credentials and native CLI/sandbox setup, then retry. If a job was partially prepared, inspect its saved execution before replay.'
    return { ...result, state: 'attention', message }
  }
}
