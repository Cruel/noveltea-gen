import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { auth, database } from './runtime.server'
import { readAuthConfig } from './auth'
import { submitFirstStoryTurn, type FirstStoryTurnInput } from './story-first-chat.server'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
/** The ordinary Chat first-send entrypoint: no client-supplied write scope,
 * execution fixture toggle, repository path, or provider secret. */
export const sendFirstStoryTurn = createServerFn({ method: 'POST' })
  .validator((data: FirstStoryTurnInput) => {
    if (
      !data ||
      !UUID.test(data.storyId) ||
      !UUID.test(data.jobId) ||
      typeof data.prompt !== 'string' ||
      data.prompt.length > 4000 ||
      (data.confirmFullStory !== undefined && typeof data.confirmFullStory !== 'boolean')
    )
      throw new Error('Invalid Story message.')
    return data
  })
  .handler(async ({ data }) =>
    submitFirstStoryTurn(auth, database, new Headers(getRequestHeaders()), readAuthConfig().baseURL, data),
  )
