import { and, eq, inArray, isNull, notExists, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema'
import { checkpointForks, generationRunQueue, githubPublications, gitlabPublications,
  sessions, stories, storyConversations, storyThreadMessages,
  storyThreadRuns, storyThreads, threadLiveInputs, threadRestarts } from '../db/schema'
import type { ConversationCatalog, ThreadDeletionRecord } from './conversation-contracts'

type Db = BetterSQLite3Database<typeof schema>
function ownerRequired(owner: string): void {
  if (!owner) throw new Error('Authenticated actor required')
}

export function createSqliteConversationCatalog(db: Db): ConversationCatalog {
  const deletion = (owner: string, id: string): ThreadDeletionRecord | null => {
    const thread = db.select({ deletedAt: storyThreads.deletedAt,
      completedAt: storyThreads.deletionCompleteAt, planJson: storyThreads.deletionPlanJson,
      bytes: storyThreads.deletionBytes }).from(storyThreads)
      .where(and(eq(storyThreads.id, id), eq(storyThreads.ownerUserId, owner))).get()
    if (!thread) return null
    const runs = db.select({ id: storyThreadRuns.jobId, status: sessions.status,
      queue: generationRunQueue.phase }).from(storyThreadRuns)
      .innerJoin(sessions, and(eq(sessions.id, storyThreadRuns.jobId),
        eq(sessions.ownerUserId, storyThreadRuns.ownerUserId)))
      .leftJoin(generationRunQueue, eq(generationRunQueue.jobId, sessions.id))
      .where(and(eq(storyThreadRuns.threadId, id), eq(storyThreadRuns.ownerUserId, owner)))
      .orderBy(storyThreadRuns.runOrder).all()
    // Deleted intermediate ancestors still connect living descendants. Retain
    // source provenance until the entire reachable subtree has been deleted.
    const tree = db.select({ id: storyThreads.id, parent: storyThreads.parentThreadId,
      deletedAt: storyThreads.deletedAt }).from(storyThreads)
      .where(eq(storyThreads.ownerUserId, owner)).all()
    const visited = new Set([id])
    let frontier = [id], children = 0
    for (let depth = 0; frontier.length && depth < tree.length; depth++) {
      const next = tree.filter(row => row.parent && frontier.includes(row.parent) &&
        !visited.has(row.id))
      for (const row of next) {
        visited.add(row.id)
        if (!row.deletedAt) children++
      }
      frontier = next.map(row => row.id)
    }
    const jobs = runs.map(run => run.id)
    const pendingForks = jobs.length ? (
      db.select({ id: checkpointForks.childId }).from(checkpointForks)
        .where(and(eq(checkpointForks.ownerUserId, owner),
          inArray(checkpointForks.sourceJobId, jobs),
          notExists(db.select({ id: sessions.id }).from(sessions)
            .where(eq(sessions.id, checkpointForks.childId))))).all().length +
      db.select({ id: threadRestarts.childId }).from(threadRestarts)
        .where(and(eq(threadRestarts.ownerUserId, owner),
          inArray(threadRestarts.sourceJobId, jobs),
          notExists(db.select({ id: sessions.id }).from(sessions)
            .where(eq(sessions.id, threadRestarts.childId))))).all().length
    ) : 0
    const externalPublications = jobs.length ?
      db.select({ id: githubPublications.jobId }).from(githubPublications)
        .where(inArray(githubPublications.jobId, jobs)).all().length +
      db.select({ id: gitlabPublications.jobId }).from(gitlabPublications)
        .where(inArray(gitlabPublications.jobId, jobs)).all().length : 0
    const unsettledMessages = db.select({ total: sql<number>`count(*)` }).from(storyThreadMessages)
      .where(and(eq(storyThreadMessages.threadId, id), eq(storyThreadMessages.ownerUserId, owner),
        eq(storyThreadMessages.role, 'user'),
        inArray(storyThreadMessages.phase, ['preparing', 'running', 'blocked']))).get()!.total +
      db.select({ total: sql<number>`count(*)` }).from(threadLiveInputs)
        .where(and(eq(threadLiveInputs.threadId, id), eq(threadLiveInputs.ownerUserId, owner),
          inArray(threadLiveInputs.state, ['dispatching', 'sdk-queued']))).get()!.total
    return { ...thread, children, pendingForks, externalPublications,
      unsettledMessages, runs }
  }
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
        deletedAt: storyThreads.deletedAt,
        deletionCompleteAt: storyThreads.deletionCompleteAt, createdAt: storyThreads.createdAt,
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
        .where(and(eq(storyThreads.id, id), eq(storyThreads.ownerUserId, owner),
          isNull(storyThreads.deletedAt)))
        .run().changes === 1
    },
    async deletion(owner, id) {
      ownerRequired(owner)
      return deletion(owner, id)
    },
    async beginDeletion(owner, id, jobIds, planJson, at) {
      ownerRequired(owner)
      return db.transaction(() => {
        const current = deletion(owner, id)
        if (!current) return false
        if (current.deletedAt) return current.planJson === planJson
        if (current.pendingForks || current.externalPublications ||
          current.unsettledMessages || current.runs.some(run =>
          run.status === 'running' || ['running', 'queued', 'interrupted'].includes(run.queue ?? '')) ||
          JSON.stringify(current.runs.map(run => run.id)) !== JSON.stringify(jobIds))
          return false
        return db.update(storyThreads).set({ deletedAt: at, deletionPlanJson: planJson })
          .where(and(eq(storyThreads.id, id), eq(storyThreads.ownerUserId, owner),
            isNull(storyThreads.deletedAt))).run().changes === 1
      }, { behavior: 'immediate' })
    },
    async finishDeletion(owner, id, at, bytes) {
      ownerRequired(owner)
      db.transaction(() => {
        const record = deletion(owner, id)
        if (!record?.deletedAt || !record.planJson) throw new Error('No reserved deletion.')
        if (record.completedAt) return
        const { preserveReceipts } = JSON.parse(record.planJson) as { preserveReceipts?: boolean }
        db.update(storyThreads).set({ deletionCompleteAt: at,
          deletionPlanJson: JSON.stringify({ preserveReceipts: preserveReceipts === true }),
          deletionBytes: bytes })
          .where(and(eq(storyThreads.id, id), eq(storyThreads.ownerUserId, owner))).run()
      }, { behavior: 'immediate' })
    },
    async deletedJob(owner, jobId) {
      ownerRequired(owner)
      return !!db.select({ id: storyThreads.id }).from(storyThreads)
        .innerJoin(storyThreadRuns, and(eq(storyThreadRuns.threadId, storyThreads.id),
          eq(storyThreadRuns.ownerUserId, storyThreads.ownerUserId)))
        .where(and(eq(storyThreadRuns.jobId, jobId), eq(storyThreads.ownerUserId, owner),
          sql`${storyThreads.deletedAt} IS NOT NULL`)).get()
    },
    async archiveThread(owner, id, archived, at) {
      ownerRequired(owner)
      return db.transaction(tx => {
        const membership = tx.select({ id: storyThreads.id, deletedAt: storyThreads.deletedAt })
          .from(storyThreads)
          .where(and(eq(storyThreads.id, id), eq(storyThreads.ownerUserId, owner))).get()
        if (!membership || membership.deletedAt) return false
        const condition = archived ? isNull(storyThreads.archivedAt)
          : sql`${storyThreads.archivedAt} IS NOT NULL`
        tx.update(storyThreads).set({ archivedAt: archived ? at : null })
          .where(and(eq(storyThreads.id, id), eq(storyThreads.ownerUserId, owner), condition)).run()
        return true
      })
    },
  }
}
