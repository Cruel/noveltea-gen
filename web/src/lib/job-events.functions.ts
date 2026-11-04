import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { auth, database } from './runtime.server'
import { assertStudioSchemaCurrent } from '../db/migrations'
import { requireUser } from './access.server'
import { authorizedStoryJob } from './fixture-jobs.server'
import { recentGenerationEvents } from './generation-progress.server'

/** Read the latest 100 persisted events, or the page preceding a cursor.
 * The owner check is identical to the authenticated SSE stream. */
export const getJobEventHistory = createServerFn({ method: 'GET' })
  .validator((input: { jobId: string; before?: number }) => {
    if (!input || typeof input.jobId !== 'string' ||
        !/^[0-9a-f-]{36}$/i.test(input.jobId) ||
        (input.before !== undefined &&
          (!Number.isSafeInteger(input.before) || input.before <= 0)))
      throw new Error('Invalid job history request.')
    return input
  })
  .handler(async ({ data }) => {
    assertStudioSchemaCurrent(database)
    const user = await requireUser(auth, getRequestHeaders())
    if (!user) throw new Error('Sign in required.')
    await authorizedStoryJob(database, user.id, data.jobId)
    return recentGenerationEvents(database, user.id, data.jobId, data.before)
  })
