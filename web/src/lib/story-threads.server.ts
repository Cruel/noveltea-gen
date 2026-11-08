import type { StudioStore } from '../persistence/store'
import { readThreadChat } from './thread-chat.server'
import { syncAppliedAuthorMessages } from './thread-message-edit.server'
import { listStoryConversations, type StoryThread } from './threads.server'

/** Story -> Thread is the author-facing identity. This adapter intentionally
 * hides temporary Conversation grouping and internal Job catalog IDs. Existing
 * reconciliation and run/checkpoint receipts remain authoritative until the
 * clean Studio schema cutover. */
export type StoryScopedThread = Omit<StoryThread, 'conversationId' | 'jobId'>
export type ThreadForkPoint = {
  kind: 'checkpoint' | 'restart'
  commitSha: string
  proofDigest: string | null
}
export type ThreadAncestryNode = Pick<StoryScopedThread, 'id' | 'parentThreadId' | 'title' | 'archivedAt'> & {
  forkPoint: ThreadForkPoint | null
}
export type StoryThreadList = {
  story: { id: string; title: string }
  threads: StoryScopedThread[]
}

export async function listStoryThreads(
  store: StudioStore,
  owner: string,
  storyId: string,
): Promise<StoryThreadList> {
  const navigation = await listStoryConversations(store, owner, storyId)
  // Navigation preferences are presentation-only and cannot affect the
  // existence, ordering, or parent revision of any Thread.
  return {
    story: navigation.story,
    threads: navigation.conversations.flatMap((conversation) =>
      conversation.threads.map(({ conversationId: _conversationId, jobId: _jobId, ...thread }) => thread),
    ),
  }
}

function selectedThread(threads: readonly StoryScopedThread[], threadId: string): StoryScopedThread {
  const thread = threads.find((item) => item.id === threadId)
  if (!thread) throw new Error('Thread not found.')
  return thread
}

/** Resolve lineage by persisted Thread identity, never by Conversation or the
 * latest execution. A fork point is returned only when there is a durable,
 * source-bound reservation behind the registered child run; unknown historical
 * ancestry remains explicit rather than inventing a verified checkpoint. */
async function ancestry(
  store: StudioStore,
  owner: string,
  threads: readonly StoryScopedThread[],
  threadId: string,
): Promise<ThreadAncestryNode[]> {
  let current: StoryScopedThread | undefined = selectedThread(threads, threadId)
  const byId = new Map(threads.map((thread) => [thread.id, thread]))
  const visited = new Set<string>()
  const path: StoryScopedThread[] = []
  while (current) {
    if (visited.has(current.id) || path.length >= 64) throw new Error('Thread ancestry is invalid.')
    visited.add(current.id)
    path.push(current)
    if (!current.parentThreadId) break
    current = byId.get(current.parentThreadId)
    if (!current) throw new Error('Thread ancestry is invalid.')
  }
  const ordered = path.reverse()
  return Promise.all(
    ordered.map(async (thread, index) => {
      const parent = ordered[index - 1]
      let forkPoint: ThreadForkPoint | null = null
      if (parent) {
        const first = await store.persistence.advancedThreads.run(owner, thread.id, 'first')
        if (first) {
          const fork = await store.persistence.advancedThreads.forkIntent(first.jobId)
          const restart = fork ? null : await store.persistence.advancedThreads.restartIntent(first.jobId)
          if (fork) {
            if (fork.owner !== owner || fork.sourceThreadId !== parent.id)
              throw new Error('Thread ancestry is invalid.')
            forkPoint = { kind: 'checkpoint', commitSha: fork.commitSha, proofDigest: fork.proofDigest }
          } else if (restart) {
            if (restart.owner !== owner || restart.sourceThread !== parent.id || !restart.preparedAt)
              throw new Error('Thread ancestry is invalid.')
            forkPoint = { kind: 'restart', commitSha: restart.selected, proofDigest: null }
          }
        }
      }
      return {
        id: thread.id,
        parentThreadId: thread.parentThreadId,
        title: thread.title,
        archivedAt: thread.archivedAt,
        forkPoint,
      }
    }),
  )
}

export async function resolveStoryThreadAncestry(
  store: StudioStore,
  owner: string,
  storyId: string,
  threadId: string,
): Promise<ThreadAncestryNode[]> {
  const { threads } = await listStoryThreads(store, owner, storyId)
  return ancestry(store, owner, threads, threadId)
}

/** Authenticated HTTP handlers use this service for opening a selected Story
 * Thread. It keeps the existing chat/run/evidence read contract, including
 * the same source-bound applied-message sync as the legacy chat route. */
export async function openStoryThread(store: StudioStore, owner: string, storyId: string, threadId: string) {
  const { story, threads } = await listStoryThreads(store, owner, storyId)
  const thread = selectedThread(threads, threadId)
  const lineage = await ancestry(store, owner, threads, threadId)
  await syncAppliedAuthorMessages(store, owner, threadId)
  const state = await readThreadChat(store, owner, threadId)
  if (state.storyId !== storyId) throw new Error('Thread not found.')
  return { story, thread, ancestry: lineage, state }
}
