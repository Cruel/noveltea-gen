import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { auth, database } from './runtime.server'
import { requireUser } from './access.server'
import { deleteThread } from './thread-deletion.server'
import { inspectStoryUsage } from './thread-usage.server'
import { listStoryThreads, openStoryThread } from './story-threads.server'
import {
  archiveThread,
  createThread,
  createCollection, renameCollection, removeCollection, assignThreadCollection, chooseStory,
  listStoryNavigation,
  renameThread,
  setThreadCreativeMode,
  restoreThread,
  saveThreadPreferences,
} from './threads.server'

import { validCreativeMode, type CreativeMode } from '../../../src/creative-policy'
const isId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9:_-]{1,128}$/.test(id)
async function ownerId() {
  await database.assertReady()
  const actor = await requireUser(auth, getRequestHeaders())
  if (!actor) throw new Error('Sign in required.')
  return actor.id
}
export const getStoryNavigation = createServerFn({ method: 'GET' })
  .validator((storyId: string) => {
    if (!isId(storyId)) throw new Error('Invalid Story ID.')
    return storyId
  })
  .handler(async ({ data }) => listStoryNavigation(database, await ownerId(), data))

/** Story-first gateway: clients need only a Story ID to list Threads, or a
 * Story ID and stable Thread ID to open its state and pinned fork lineage. */
export const getStoryThreads = createServerFn({ method: 'GET' })
  .validator((storyId: string) => {
    if (!isId(storyId)) throw new Error('Invalid Story ID.')
    return storyId
  })
  .handler(async ({ data }) => listStoryThreads(database, await ownerId(), data))

export const getStoryThread = createServerFn({ method: 'GET' })
  .validator((data: { storyId: string; threadId: string }) => {
    if (!data || !isId(data.storyId) || !isId(data.threadId)) throw new Error('Invalid Story or Thread ID.')
    return data
  })
  .handler(async ({ data }) => openStoryThread(database, await ownerId(), data.storyId, data.threadId))

export const getStoryUsage = createServerFn({ method: 'GET' })
  .validator((storyId: string) => {
    if (!isId(storyId)) throw new Error('Invalid Story ID.')
    return storyId
  })
  .handler(async ({ data }) => inspectStoryUsage(database, await ownerId(), data))

export const addThread = createServerFn({ method: 'POST' })
  .validator((storyId: string) => {
    if (!isId(storyId)) throw new Error('Invalid Story ID.')
    return storyId
  })
  .handler(async ({ data }) => createThread(database, await ownerId(), data))

export const addCollection = createServerFn({ method: 'POST' })
  .validator((data: { storyId: string; name: string }) => {
    if (!data || !isId(data.storyId) || typeof data.name !== 'string' || data.name.length > 80)
      throw new Error('Invalid Collection request.')
    return data
  })
  .handler(async ({ data }) => createCollection(database, await ownerId(), data.storyId, data.name))

export const setCollectionName = createServerFn({ method: 'POST' })
  .validator((data: { storyId: string; id: string; name: string }) => {
    if (!data || !isId(data.storyId) || !isId(data.id) || typeof data.name !== 'string' || data.name.length > 80)
      throw new Error('Invalid Collection request.')
    return data
  })
  .handler(async ({ data }) => {
    await renameCollection(database, await ownerId(), data.storyId, data.id, data.name)
    return { success: true }
  })

export const deleteCollection = createServerFn({ method: 'POST' })
  .validator((data: { storyId: string; id: string }) => {
    if (!data || !isId(data.storyId) || !isId(data.id)) throw new Error('Invalid Collection request.')
    return data
  })
  .handler(async ({ data }) => {
    await removeCollection(database, await ownerId(), data.storyId, data.id)
    return { success: true }
  })

export const moveThreadToCollection = createServerFn({ method: 'POST' })
  .validator((data: { storyId: string; threadId: string; collectionId: string | null }) => {
    if (!data || !isId(data.storyId) || !isId(data.threadId) ||
        (data.collectionId !== null && !isId(data.collectionId)))
      throw new Error('Invalid Collection assignment.')
    return data
  })
  .handler(async ({ data }) => {
    await assignThreadCollection(database, await ownerId(), data.storyId, data.threadId, data.collectionId)
    return { success: true }
  })

export const saveSelectedStory = createServerFn({ method: 'POST' })
  .validator((storyId: string) => {
    if (!isId(storyId)) throw new Error('Invalid Story ID.')
    return storyId
  })
  .handler(async ({ data }) => {
    await chooseStory(database, await ownerId(), data)
    return { success: true }
  })

export const setCreativeMode = createServerFn({ method: 'POST' })
  .validator((data: { threadId: string; mode: CreativeMode }) => {
    if (!data || !isId(data.threadId) || !validCreativeMode(data.mode))
      throw new Error('Invalid creative mode.')
    return data
  })
  .handler(async ({ data }) => {
    await setThreadCreativeMode(database, await ownerId(), data.threadId, data.mode)
    return { success: true }
  })

export const setThreadTitle = createServerFn({ method: 'POST' })
  .validator((data: { id: string; title: string }) => {
    if (!data || !isId(data.id) || typeof data.title !== 'string' || data.title.length > 120)
      throw new Error('Invalid Thread title.')
    return data
  })
  .handler(async ({ data }) => {
    await renameThread(database, await ownerId(), data.id, data.title)
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
    if (data.archived) await archiveThread(database, owner, data.id)
    else await restoreThread(database, owner, data.id)
    return { success: true }
  })

/** Explicit, irreversible deletion: no client-controlled filesystem paths. */
export const deleteThreadResources = createServerFn({ method: 'POST' })
  .validator((id: string) => {
    if (!isId(id)) throw new Error('Invalid Thread ID.')
    return id
  })
  .handler(async ({ data }) => deleteThread(database, await ownerId(), data))

export const setThreadPreferences = createServerFn({ method: 'POST' })
  .validator((data: { storyId: string; view: 'tree' | 'flat'; expandedIds: string[]; collapsedCollectionIds?: string[] }) => {
    if (
      !data ||
      !isId(data.storyId) ||
      !['tree', 'flat'].includes(data.view) ||
      !Array.isArray(data.expandedIds) ||
      data.expandedIds.length > 200 ||
      data.expandedIds.some((id) => !isId(id)) ||
      (data.collapsedCollectionIds !== undefined &&
        (!Array.isArray(data.collapsedCollectionIds) || data.collapsedCollectionIds.length > 100 ||
          data.collapsedCollectionIds.some(id => id !== 'ungrouped' && !isId(id))))
    )
      throw new Error('Invalid Thread preferences.')
    return data
  })
  .handler(async ({ data }) => {
    await saveThreadPreferences(database, await ownerId(), data.storyId, data.view,
      data.expandedIds, data.collapsedCollectionIds)
    return { success: true }
  })
