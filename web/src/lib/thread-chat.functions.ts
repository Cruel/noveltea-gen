import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { auth, database } from './runtime.server'
import { requireUser } from './access.server'
import { assertStudioSchemaCurrent } from '../db/migrations'
import { readThreadChat, enqueueThreadMessage, advanceThread } from './thread-chat.server'

const ID = /^[a-zA-Z0-9:_-]{1,128}$/
async function owner() {
  assertStudioSchemaCurrent(database)
  const user = await requireUser(auth, getRequestHeaders())
  if (!user) throw new Error('Sign in required.')
  return user.id
}

export const getThreadChat = createServerFn({ method: 'GET' })
  .validator((threadId: string) => {
    if (!ID.test(threadId)) throw new Error('Invalid Thread ID.')
    return threadId
  })
  .handler(async ({ data }) => readThreadChat(database, await owner(), data))

export const postThreadMessage = createServerFn({ method: 'POST' })
  .validator((data: { threadId: string; id: string; content: string }) => {
    if (!data || !ID.test(data.threadId) || typeof data.id !== 'string' ||
        typeof data.content !== 'string' || data.content.length > 4000)
      throw new Error('Invalid Thread message.')
    return data
  })
  .handler(async ({ data }) => {
    const ownerId = await owner()
    const message = enqueueThreadMessage(database, ownerId, data.threadId, data.id, data.content)
    await advanceThread(database, ownerId, data.threadId)
    return { message, chat: readThreadChat(database, ownerId, data.threadId) }
  })
