import { and, eq, isNull, notExists, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema'
import { generationRunQueue, sessions, stories, storyConversations, storyThreadRuns,
  storyThreads } from '../db/schema'
import type { ConversationCatalog } from './conversation-contracts'

type Db = BetterSQLite3Database<typeof schema>
function ownerRequired(owner: string): void {
  if (!owner) throw new Error('Authenticated actor required')
}

export function createSqliteConversationCatalog(db: Db): ConversationCatalog {
  return {
    async story(owner, storyId) {
      ownerRequired(owner)
      return db.select({ id: stories.id, title: stories.title }).from(stories)
        .where(and(eq(stories.id, storyId), eq(stories.ownerUserId, owner))).get() ?? null
    },
    async reconcileRoots(owner, storyId) {
      ownerRequired(owner)
      db.transaction(tx => {
        const missing = tx.select({
          id: sessions.id, owner: sessions.ownerUserId, story: sessions.storyId,
          title: sessions.title, createdAt: sessions.createdAt,
        }).from(sessions).where(and(
          eq(sessions.ownerUserId, owner), eq(sessions.storyId, storyId),
          notExists(tx.select({ id: storyThreadRuns.jobId }).from(storyThreadRuns)
            .where(eq(storyThreadRuns.jobId, sessions.id))),
        )).all()
        for (const job of missing) {
          const conversationId = 'legacy:' + job.id
          const threadId = 'root:' + job.id
          tx.insert(storyConversations).values({
            id: conversationId, ownerUserId: job.owner, storyId: job.story,
            title: job.title, createdAt: job.createdAt, updatedAt: job.createdAt,
          }).onConflictDoNothing().run()
          tx.insert(storyThreads).values({
            id: threadId, ownerUserId: job.owner, conversationId, title: job.title,
            activityAt: job.createdAt, createdAt: job.createdAt,
          }).onConflictDoNothing().run()
          tx.insert(storyThreadRuns).values({
            jobId: job.id, ownerUserId: job.owner, threadId, runOrder: 0,
          }).onConflictDoNothing().run()
        }
      })
    },
    async navigation(owner, storyId) {
      ownerRequired(owner)
      const conversations = db.select({
        id: storyConversations.id, title: storyConversations.title,
        createdAt: storyConversations.createdAt, updatedAt: storyConversations.updatedAt,
      }).from(storyConversations).where(and(
        eq(storyConversations.ownerUserId, owner), eq(storyConversations.storyId, storyId),
      )).all()
      const threads = db.select({
        id: storyThreads.id, conversationId: storyThreads.conversationId,
        parentThreadId: storyThreads.parentThreadId, title: storyThreads.title,
        activityAt: storyThreads.activityAt, archivedAt: storyThreads.archivedAt,
        createdAt: storyThreads.createdAt,
        jobId: storyThreadRuns.jobId, needsAuthor: storyThreadRuns.needsAuthor,
        jobStatus: sessions.status, requestJson: sessions.generationRequestJson,
        queuePhase: generationRunQueue.phase, queueAt: generationRunQueue.createdAt,
        queueUpdatedAt: generationRunQueue.updatedAt,
        lastEventAt: sql<string | null>`(SELECT MAX(e.created_at) FROM generation_events e
          WHERE e.job_id = ${storyThreadRuns.jobId} AND e.owner_user_id = ${storyThreads.ownerUserId})`,
        workingStage: sql<string | null>`(SELECT e.stage FROM generation_events e
          WHERE e.job_id = ${storyThreadRuns.jobId} AND e.owner_user_id = ${storyThreads.ownerUserId}
            AND e.kind = 'working'
            AND e.id >= COALESCE((SELECT MAX(started.id) FROM generation_events started
              WHERE started.job_id = ${storyThreadRuns.jobId}
                AND started.owner_user_id = ${storyThreads.ownerUserId}
                AND started.kind = 'started'), 0)
          ORDER BY e.id DESC LIMIT 1)`,
        workingMilestone: sql<string | null>`(SELECT e.milestone FROM generation_events e
          WHERE e.job_id = ${storyThreadRuns.jobId} AND e.owner_user_id = ${storyThreads.ownerUserId}
            AND e.kind = 'working'
            AND e.id >= COALESCE((SELECT MAX(started.id) FROM generation_events started
              WHERE started.job_id = ${storyThreadRuns.jobId}
                AND started.owner_user_id = ${storyThreads.ownerUserId}
                AND started.kind = 'started'), 0)
          ORDER BY e.id DESC LIMIT 1)`,
      }).from(storyThreads)
        .innerJoin(storyConversations, and(eq(storyConversations.id, storyThreads.conversationId),
          eq(storyConversations.ownerUserId, storyThreads.ownerUserId)))
        .leftJoin(storyThreadRuns, and(eq(storyThreadRuns.threadId, storyThreads.id),
          eq(storyThreadRuns.ownerUserId, storyThreads.ownerUserId),
          eq(storyThreadRuns.runOrder, sql<number>`(SELECT MAX(r2.run_order)
            FROM story_thread_runs r2 WHERE r2.thread_id = ${storyThreads.id}
              AND r2.owner_user_id = ${storyThreads.ownerUserId})`)))
        .leftJoin(sessions, and(eq(sessions.id, storyThreadRuns.jobId),
          eq(sessions.ownerUserId, storyThreads.ownerUserId)))
        .leftJoin(generationRunQueue, and(eq(generationRunQueue.jobId, storyThreadRuns.jobId),
          eq(generationRunQueue.ownerUserId, storyThreads.ownerUserId)))
        .where(and(eq(storyThreads.ownerUserId, owner),
          eq(storyConversations.storyId, storyId))).all()
      return { conversations, threads }
    },
    async create(owner, storyId, id, at) {
      ownerRequired(owner)
      return db.transaction(tx => {
        const count = tx.select({ total: sql<number>`count(*)` }).from(storyConversations)
          .where(and(eq(storyConversations.ownerUserId, owner),
            eq(storyConversations.storyId, storyId))).get()?.total ?? 0
        const title = 'New conversation' + (count ? ' ' + (count + 1) : '')
        tx.insert(storyConversations).values({
          id, ownerUserId: owner, storyId, title, createdAt: at, updatedAt: at,
        }).run()
        return { id, title }
      })
    },
    async renameConversation(owner, id, title, at) {
      ownerRequired(owner)
      return db.update(storyConversations).set({ title, updatedAt: at })
        .where(and(eq(storyConversations.id, id), eq(storyConversations.ownerUserId, owner)))
        .run().changes === 1
    },
    async renameThread(owner, id, title) {
      ownerRequired(owner)
      return db.update(storyThreads).set({ title })
        .where(and(eq(storyThreads.id, id), eq(storyThreads.ownerUserId, owner)))
        .run().changes === 1
    },
    async archiveThread(owner, id, archived, at) {
      ownerRequired(owner)
      return db.transaction(tx => {
        const membership = tx.select({ id: storyThreads.id }).from(storyThreads)
          .where(and(eq(storyThreads.id, id), eq(storyThreads.ownerUserId, owner))).get()
        if (!membership) return false
        const condition = archived ? isNull(storyThreads.archivedAt)
          : sql`${storyThreads.archivedAt} IS NOT NULL`
        tx.update(storyThreads).set({ archivedAt: archived ? at : null })
          .where(and(eq(storyThreads.id, id), eq(storyThreads.ownerUserId, owner), condition)).run()
        return true
      })
    },
  }
}
