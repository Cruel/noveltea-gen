import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { auth, database } from './runtime.server'
import { readAuthConfig } from './auth'
import { requireUser } from './access.server'
import { previewNaturalStory, launchNaturalStory, type NaturalStoryInput } from './natural-story.server'
import type { PlanEdits } from './natural-story-plan'
import { validCreativeMode } from '../../../src/creative-policy'

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
export const previewStoryPrompt = createServerFn({ method: 'POST' })
  .validator((data: { storyId: string; prompt: string; edits?: PlanEdits }) => {
    if (!data || !ID.test(data.storyId) || typeof data.prompt !== 'string' ||
        data.prompt.length > 4000) throw new Error('Invalid Story prompt.')
    return data
  })
  .handler(async ({ data }) => {
    const actor = await requireUser(auth, getRequestHeaders())
    if (!actor) throw new Error('Sign in required.')
    return previewNaturalStory(database, actor.id, data.storyId, data.prompt, data.edits)
  })

export const startStoryPrompt = createServerFn({ method: 'POST' })
  .validator((data: NaturalStoryInput) => {
    if (!data || !ID.test(data.storyId) || !ID.test(data.jobId) ||
        typeof data.prompt !== 'string' || data.prompt.length > 4000 ||
        typeof data.headSha !== 'string' || !/^[a-f0-9]{40}$/i.test(data.headSha) ||
        data.creativeMode !== undefined && !validCreativeMode(data.creativeMode))
      throw new Error('Invalid Story generation request.')
    return data
  })
  .handler(async ({ data }) => launchNaturalStory(auth, database,
    new Headers(getRequestHeaders()), readAuthConfig().baseURL, data))
