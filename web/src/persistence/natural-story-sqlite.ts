import { and, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema'
import { repositories, sessions, stories, storyConversations, storyThreadRuns, storyThreads } from '../db/schema'
import type { NaturalStoryPersistence } from './natural-story-contracts'

type Db = BetterSQLite3Database<typeof schema>
const validOwner = (owner: string) => {
  if (!owner) throw new Error('Authenticated actor required.')
}

export function createSqliteNaturalStoryPersistence(db: Db): NaturalStoryPersistence {
  const selected = (owner: string, id: string) =>
    db.select({
      id: storyConversations.id, storyId: storyConversations.storyId,
      headSha: stories.sourceCommitSha, provider: repositories.provider,
    }).from(storyConversations).innerJoin(stories, and(
      eq(stories.id, storyConversations.storyId),
      eq(stories.ownerUserId, storyConversations.ownerUserId),
    )).innerJoin(repositories, and(
      eq(repositories.id, stories.repositoryId),
      eq(repositories.ownerUserId, stories.ownerUserId),
    )).where(and(eq(storyConversations.id, id),
      eq(storyConversations.ownerUserId, owner))).get() ?? null
  return {
    async conversation(owner, id) {
      validOwner(owner)
      return selected(owner, id)
    },
    async previousJob(owner, jobId) {
      validOwner(owner)
      return db.select({
        storyId: sessions.storyId, requestJson: sessions.generationRequestJson,
        configJson: sessions.generationConfigJson, conversationId: storyThreads.conversationId,
      }).from(sessions).leftJoin(storyThreadRuns, and(
        eq(storyThreadRuns.jobId, sessions.id), eq(storyThreadRuns.ownerUserId, sessions.ownerUserId),
      )).leftJoin(storyThreads, and(
        eq(storyThreads.id, storyThreadRuns.threadId),
        eq(storyThreads.ownerUserId, storyThreadRuns.ownerUserId),
      )).where(and(eq(sessions.id, jobId), eq(sessions.ownerUserId, owner))).get() ?? null
    },
    async associateRoot(owner, conversationId, jobId, title, at) {
      validOwner(owner)
      return db.transaction(tx => {
        // Membership, source Story identity, and reassociation are one atomic
        // transaction; a stale or foreign Conversation never accepts the job.
        const member = selected(owner, conversationId)
        if (!member) throw new Error('Conversation not found.')
        if (!member.headSha || !/^[a-f0-9]{40}$/i.test(member.headSha))
          throw new Error('Story has no verified source commit.')
        const threadId = 'root:' + jobId
        const row = tx.select({
          conversationId: storyThreads.conversationId,
          parentId: storyThreads.parentThreadId,
        }).from(storyThreads).innerJoin(storyThreadRuns, and(
          eq(storyThreadRuns.threadId, storyThreads.id),
          eq(storyThreadRuns.ownerUserId, storyThreads.ownerUserId),
        )).innerJoin(sessions, and(
          eq(sessions.id, storyThreadRuns.jobId),
          eq(sessions.ownerUserId, storyThreadRuns.ownerUserId),
        )).where(and(eq(storyThreads.id, threadId),
          eq(storyThreads.ownerUserId, owner), eq(storyThreadRuns.jobId, jobId),
          eq(storyThreadRuns.runOrder, 0), eq(sessions.storyId, member.storyId))).get()
        if (!row || row.parentId ||
            (row.conversationId !== conversationId && row.conversationId !== 'legacy:' + jobId))
          throw new Error('Generation job already belongs to another Thread or Conversation.')
        tx.update(storyThreads).set({
          conversationId, title: title.slice(0, 120), activityAt: at,
        }).where(and(eq(storyThreads.id, threadId), eq(storyThreads.ownerUserId, owner))).run()
        tx.update(storyConversations).set({ updatedAt: at }).where(and(
          eq(storyConversations.id, conversationId), eq(storyConversations.ownerUserId, owner))).run()
        const legacy = 'legacy:' + jobId
        const stillUsed = tx.select({ id: storyThreads.id }).from(storyThreads).where(and(
          eq(storyThreads.conversationId, legacy), eq(storyThreads.ownerUserId, owner),
        )).limit(1).get()
        if (!stillUsed) tx.delete(storyConversations).where(and(
          eq(storyConversations.id, legacy), eq(storyConversations.ownerUserId, owner),
        )).run()
        return threadId
      }, { behavior: 'immediate' })
    },
  }
}
