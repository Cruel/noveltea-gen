import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { auth, database } from './runtime.server'
import { assertStudioSchemaCurrent } from '../db/migrations'
import { requireUser } from './access.server'
import {
  archiveThread, createConversation, listStoryConversations, renameConversation, renameThread,
  restoreThread, saveThreadPreferences,
} from './threads.server'

const isId = (id: unknown): id is string =>
  typeof id === 'string' && /^[a-zA-Z0-9:_-]{1,128}$/.test(id)
async function ownerId() {
  assertStudioSchemaCurrent(database)
  const actor = await requireUser(auth, getRequestHeaders())
  if (!actor) throw new Error('Sign in required.')
  return actor.id
}
export const getStoryNavigation = createServerFn({ method: 'GET' })
  .validator((storyId: string) => {
    if (!isId(storyId)) throw new Error('Invalid Story ID.')
    return storyId
  })
  .handler(async ({ data }) => listStoryConversations(database, await ownerId(), data))

export const addConversation = createServerFn({ method: 'POST' })
  .validator((storyId: string) => {
    if (!isId(storyId)) throw new Error('Invalid Story ID.')
    return storyId
  })
  .handler(async ({ data }) => createConversation(database, await ownerId(), data))

export const setConversationTitle = createServerFn({ method: 'POST' })
  .validator((data: { id: string; title: string }) => {
    if (!data || !isId(data.id) || typeof data.title !== 'string' || data.title.length > 120)
      throw new Error('Invalid Conversation title.')
    return data
  })
  .handler(async ({ data }) => {
    renameConversation(database, await ownerId(), data.id, data.title)
    return { success: true }
  })

export const setThreadTitle = createServerFn({ method: 'POST' })
  .validator((data: { id: string; title: string }) => {
    if (!data || !isId(data.id) || typeof data.title !== 'string' || data.title.length > 120)
      throw new Error('Invalid Thread title.')
    return data
  })
  .handler(async ({ data }) => {
    renameThread(database, await ownerId(), data.id, data.title)
    return { success: true }
  })

/** This is a reversible catalog flag, never a job execution or cleanup control. */
export const changeThreadArchive = createServerFn({ method: 'POST' })
  .validator((data: { id: string; archived: boolean }) => {
    if (!data || !isId(data.id) || typeof data.archived !== 'boolean')
      throw new Error('Invalid Thread archive request.')
    return data
  })
  .handler(async ({ data }) => {
    const owner = await ownerId()
    if (data.archived) archiveThread(database, owner, data.id)
    else restoreThread(database, owner, data.id)
    return { success: true }
  })

export const setThreadPreferences = createServerFn({ method: 'POST' })
  .validator((data: { storyId: string; view: 'tree' | 'flat'; expandedIds: string[] }) => {
    if (!data || !isId(data.storyId) || !['tree', 'flat'].includes(data.view) ||
        !Array.isArray(data.expandedIds) || data.expandedIds.length > 200 ||
        data.expandedIds.some(id => !isId(id)))
      throw new Error('Invalid Thread preferences.')
    return data
  })
  .handler(async ({ data }) => {
    await saveThreadPreferences(database, await ownerId(), data.storyId, data.view, data.expandedIds)
    return { success: true }
  })
