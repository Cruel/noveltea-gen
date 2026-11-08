import { and, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema'
import { repositories, sessions, stories, storyThreadRuns, storyThreads } from '../db/schema'
import type { NaturalStoryPersistence } from './natural-story-contracts'

type Db = BetterSQLite3Database<typeof schema>
const validOwner = (owner: string) => {
  if (!owner) throw new Error('Authenticated actor required.')
}

export function createSqliteNaturalStoryPersistence(db: Db): NaturalStoryPersistence {
  const selected = (owner: string, id: string) =>
    db.select({
      id: stories.id, storyId: stories.id,
      headSha: stories.sourceCommitSha, provider: repositories.provider,
    }).from(stories).innerJoin(repositories, and(
      eq(repositories.id, stories.repositoryId),
      eq(repositories.ownerUserId, stories.ownerUserId),
    )).where(and(eq(stories.id, id), eq(stories.ownerUserId, owner))).get() ?? null
  return {
    async story(owner, id) {
      validOwner(owner)
      return selected(owner, id)
    },
    async previousJob(owner, jobId) {
      validOwner(owner)
      return db.select({
        storyId: sessions.storyId, requestJson: sessions.generationRequestJson,
        configJson: sessions.generationConfigJson, threadId: storyThreadRuns.threadId,
      }).from(sessions).leftJoin(storyThreadRuns, and(
        eq(storyThreadRuns.jobId, sessions.id), eq(storyThreadRuns.ownerUserId, sessions.ownerUserId),
      )).where(and(eq(sessions.id, jobId), eq(sessions.ownerUserId, owner))).get() ?? null
    },
    async associateRoot(owner, storyId, jobId, title, at) {
      validOwner(owner)
      return db.transaction(tx => {
        const member = selected(owner, storyId)
        if (!member) throw new Error('Story not found.')
        if (!member.headSha || !/^[a-f0-9]{40}$/i.test(member.headSha))
          throw new Error('Story has no verified source commit.')
        const threadId = 'root:' + jobId
        const row = tx.select({ parentId: storyThreads.parentThreadId, deletedAt: storyThreads.deletedAt })
          .from(storyThreads).innerJoin(storyThreadRuns, and(
            eq(storyThreadRuns.threadId, storyThreads.id),
            eq(storyThreadRuns.ownerUserId, storyThreads.ownerUserId),
          )).innerJoin(sessions, and(
            eq(sessions.id, storyThreadRuns.jobId),
            eq(sessions.ownerUserId, storyThreadRuns.ownerUserId),
          )).where(and(eq(storyThreads.id, threadId), eq(storyThreads.storyId, storyId),
            eq(storyThreads.ownerUserId, owner), eq(storyThreadRuns.jobId, jobId),
            eq(storyThreadRuns.runOrder, 0), eq(sessions.storyId, storyId))).get()
        if (!row || row.deletedAt || row.parentId)
          throw new Error('Generation job already belongs to another Thread or Story.')
        tx.update(storyThreads).set({ title: title.slice(0, 120), activityAt: at })
          .where(and(eq(storyThreads.id, threadId), eq(storyThreads.ownerUserId, owner))).run()
        return threadId
      }, { behavior: 'immediate' })
    },
  }
}
