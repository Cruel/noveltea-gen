import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { auth, database } from './runtime.server'
import { requireUser } from './access.server'
import { assertStudioSchemaCurrent } from '../db/migrations'
import { readThreadChat, advanceThread, cancelQueuedThreadMessage,
  editQueuedThreadMessage } from './thread-chat.server'
import { previewThreadRevision, submitThreadRevision } from './story-revision.server'
import { recordProtectedThreadDecision } from './thread-protected-decision.server'
import {
  syncAppliedAuthorMessages, previewThreadMessageEdit, branchEditedThreadMessage,
} from './thread-message-edit.server'

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
  .handler(async ({ data }) => {
    const ownerId = await owner()
    await syncAppliedAuthorMessages(database, ownerId, data)
    return await readThreadChat(database, ownerId, data)
  })

export const getThreadEditPreview = createServerFn({ method: 'GET' })
  .validator((data: { threadId: string; messageId: string; edited: string; selectedTargets?: string[] }) => {
    if (!data || !ID.test(data.threadId) || !ID.test(data.messageId) ||
        typeof data.edited !== 'string' || data.edited.length > 4000 ||
        data.selectedTargets !== undefined && (!Array.isArray(data.selectedTargets) ||
          data.selectedTargets.length > 128 || data.selectedTargets.some(id => typeof id !== 'string')))
      throw new Error('Invalid edited message.')
    return data
  })
  .handler(async ({ data }) =>
    previewThreadMessageEdit(database, await owner(), data.threadId, data.messageId, data.edited,
      data.selectedTargets))

export const postThreadEditFork = createServerFn({ method: 'POST' })
  .validator((data: {
    threadId: string; messageId: string; edited: string; childId: string;
    commitSha: string; proofDigest: string; selectedTargets?: string[]; approvalDigest?: string
  }) => {
    if (!data || !ID.test(data.threadId) || !ID.test(data.messageId) ||
        typeof data.edited !== 'string' || data.edited.length > 4000 ||
        typeof data.childId !== 'string' || typeof data.commitSha !== 'string' ||
        typeof data.proofDigest !== 'string' ||
        data.approvalDigest !== undefined && !/^[a-f0-9]{64}$/.test(data.approvalDigest) ||
        data.selectedTargets !== undefined && (!Array.isArray(data.selectedTargets) ||
          data.selectedTargets.length > 128 || data.selectedTargets.some(id => typeof id !== 'string')))
      throw new Error('Invalid message edit branch.')
    return data
  })
  .handler(async ({ data }) => branchEditedThreadMessage(database, await owner(), data))

export const getThreadRevisionPreview = createServerFn({ method: 'POST' })
  .validator((data: { threadId: string; content: string; selectedTargets?: string[]; messageId?: string }) => {
    if (!data || !ID.test(data.threadId) || typeof data.content !== 'string' || data.content.length > 4000 ||
        data.messageId !== undefined && !ID.test(data.messageId) ||
        data.selectedTargets !== undefined && (!Array.isArray(data.selectedTargets) ||
          data.selectedTargets.length > 128 || data.selectedTargets.some(id => typeof id !== 'string')))
      throw new Error('Invalid revision preview request.')
    return data
  })
  .handler(async ({ data }) => previewThreadRevision(database, await owner(),
    data.threadId, data.content, data.selectedTargets, data.messageId))

/** Authenticated author decision, distinct from a scope-review digest. The
 * server recomputes the exact protected diff before binding the current
 * owner, queued instruction, source job and verified Git baseline. */
export const postThreadProtectedDecision = createServerFn({ method: 'POST' })
  .validator((data: { threadId: string; messageId: string; content: string;
    digest: string; decision: 'approved' | 'rejected' }) => {
    if (!data || !ID.test(data.threadId) || !ID.test(data.messageId) ||
        typeof data.content !== 'string' || data.content.length > 4000 ||
        typeof data.digest !== 'string' || !/^[a-f0-9]{64}$/.test(data.digest) ||
        !['approved', 'rejected'].includes(data.decision))
      throw new Error('Invalid protected-decision authorization.')
    return data
  })
  .handler(async ({ data }) => {
    const ownerId = await owner()
    const plan = await previewThreadRevision(database, ownerId, data.threadId,
      data.content, undefined, data.messageId)
    if (!plan.protectedChange || plan.clarification || plan.digest !== data.digest)
      throw new Error('Protected decision changed or no exact proposal is available. Refresh the review.')
    const source = database.sqlite.prepare(`SELECT r.job_id AS id FROM story_thread_runs r
      WHERE r.thread_id=? AND r.owner_user_id=? ORDER BY r.run_order DESC LIMIT 1`)
      .get(data.threadId, ownerId) as { id: string } | undefined
    if (!source) throw new Error('No verified source run is available.')
    const receipt = recordProtectedThreadDecision(database, ownerId, data.threadId,
      data.messageId, source.id, plan, data.decision)
    if (data.decision === 'approved') {
      await submitThreadRevision(database, ownerId, data.threadId, data.messageId,
        data.content, undefined, plan.digest)
    } else {
      // A denial retains its immutable author receipt but must not leave an
      // unreviewable rejected queue head blocking later Thread instructions.
      await cancelQueuedThreadMessage(database, ownerId, data.threadId, data.messageId)
    }
    await advanceThread(database, ownerId, data.threadId)
    return { receipt, chat: await readThreadChat(database, ownerId, data.threadId) }
  })

/** Compare-and-swap edit; request ID survives duplicate HTTP submissions. */
export const editThreadQueuedMessage = createServerFn({ method: 'POST' })
  .validator((data: { threadId: string; messageId: string; requestId: string;
    expected: string; replacement: string }) => {
    if (!data || !ID.test(data.threadId) || !ID.test(data.messageId) ||
        !ID.test(data.requestId) || typeof data.expected !== 'string' ||
        typeof data.replacement !== 'string' || data.replacement.length > 4000)
      throw new Error('Invalid queued message edit.')
    return data
  })
  .handler(async ({ data }) => {
    const ownerId = await owner()
    const message = await editQueuedThreadMessage(database, ownerId, data.threadId,
      data.messageId, data.requestId, data.expected, data.replacement)
    await advanceThread(database, ownerId, data.threadId)
    return { message, chat: await readThreadChat(database, ownerId, data.threadId) }
  })

/** Idempotent owner-scoped cancellation. An admitted writer cannot be cancelled
 * through this path; the immutable queued text and its sequence remain visible. */
export const cancelThreadMessage = createServerFn({ method: 'POST' })
  .validator((data: { threadId: string; messageId: string }) => {
    if (!data || !ID.test(data.threadId) || !ID.test(data.messageId))
      throw new Error('Invalid queued Thread instruction.')
    return data
  })
  .handler(async ({ data }) => {
    const ownerId = await owner()
    const message = await cancelQueuedThreadMessage(database, ownerId, data.threadId, data.messageId)
    await advanceThread(database, ownerId, data.threadId)
    return { message, chat: await readThreadChat(database, ownerId, data.threadId) }
  })

export const postThreadMessage = createServerFn({ method: 'POST' })
  .validator((data: { threadId: string; id: string; content: string;
    selectedTargets?: string[]; approvalDigest?: string;
    liveMode?: 'steer' | 'follow-up' }) => {
    if (!data || !ID.test(data.threadId) || typeof data.id !== 'string' ||
        typeof data.content !== 'string' || data.content.length > 4000 ||
        data.selectedTargets !== undefined && (!Array.isArray(data.selectedTargets) ||
          data.selectedTargets.length > 128 || data.selectedTargets.some(id => typeof id !== 'string')) ||
        data.approvalDigest !== undefined && !/^[a-f0-9]{64}$/.test(data.approvalDigest) ||
        data.liveMode !== undefined && !['steer','follow-up'].includes(data.liveMode))
      throw new Error('Invalid Thread message.')
    return data
  })
  .handler(async ({ data }) => {
    const ownerId = await owner()
    const message = await submitThreadRevision(database, ownerId, data.threadId, data.id,
      data.content, data.selectedTargets, data.approvalDigest, data.liveMode)
    await advanceThread(database, ownerId, data.threadId)
    return { message, chat: await readThreadChat(database, ownerId, data.threadId) }
  })
