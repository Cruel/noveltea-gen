import { sql, type Transaction } from 'kysely'
import type { QueryExecutor, SharedDatabase } from '../db/kysely-connection'
import type { StudioDb } from '../db/studio-db'
import type {
  ConversationCatalog, NavigationThreadRecord, ThreadDeletionRecord,
} from './conversation-contracts'

type Read = QueryExecutor<StudioDb>
type Write = Transaction<StudioDb>

function required(owner: string): void {
  if (!owner) throw new Error('Authenticated actor required')
}

async function deletion(db: Read | Write, owner: string, id: string): Promise<ThreadDeletionRecord | null> {
  const thread = await db.selectFrom('storyThreads')
    .select([
      'deletedAt', 'deletionCompleteAt as completedAt',
      'deletionPlanJson as planJson', 'deletionBytes as bytes',
    ])
    .where('id', '=', id).where('ownerUserId', '=', owner).executeTakeFirst()
  if (!thread) return null
  const runs = await db.selectFrom('storyThreadRuns')
    .innerJoin('studioSessions', (join) => join
      .onRef('studioSessions.id', '=', 'storyThreadRuns.jobId')
      .onRef('studioSessions.ownerUserId', '=', 'storyThreadRuns.ownerUserId'))
    .leftJoin('generationRunQueue', (join) => join
      .onRef('generationRunQueue.jobId', '=', 'studioSessions.id')
      .onRef('generationRunQueue.ownerUserId', '=', 'studioSessions.ownerUserId'))
    .select([
      'storyThreadRuns.jobId as id', 'studioSessions.status as status',
      'generationRunQueue.phase as queue',
    ])
    .where('storyThreadRuns.threadId', '=', id)
    .where('storyThreadRuns.ownerUserId', '=', owner)
    .orderBy('storyThreadRuns.runOrder')
    .execute()
  // Deleted intermediate ancestors still connect living descendants.
  const tree = await db.selectFrom('storyThreads')
    .select(['id', 'parentThreadId as parent', 'deletedAt'])
    .where('ownerUserId', '=', owner).execute()
  const visited = new Set([id])
  let frontier = [id]
  let children = 0
  for (let depth = 0; frontier.length && depth < tree.length; depth++) {
    const next = tree.filter(row => row.parent && frontier.includes(row.parent) && !visited.has(row.id))
    for (const row of next) {
      visited.add(row.id)
      if (!row.deletedAt) children++
    }
    frontier = next.map(row => row.id)
  }
  const jobs = runs.map(run => run.id)
  let pendingForks = 0, externalPublications = 0
  if (jobs.length) {
    const forks = await db.selectFrom('checkpointForks')
      .leftJoin('studioSessions', 'studioSessions.id', 'checkpointForks.childId')
      .select('checkpointForks.childId')
      .where('checkpointForks.ownerUserId', '=', owner)
      .where('checkpointForks.sourceJobId', 'in', jobs)
      .where('studioSessions.id', 'is', null).execute()
    const restarts = await db.selectFrom('threadRestarts')
      .leftJoin('studioSessions', 'studioSessions.id', 'threadRestarts.childId')
      .select('threadRestarts.childId')
      .where('threadRestarts.ownerUserId', '=', owner)
      .where('threadRestarts.sourceJobId', 'in', jobs)
      .where('studioSessions.id', 'is', null).execute()
    pendingForks = forks.length + restarts.length
    const github = await db.selectFrom('githubPublications').select('jobId')
      .where('jobId', 'in', jobs).execute()
    const gitlab = await db.selectFrom('gitlabPublications').select('jobId')
      .where('jobId', 'in', jobs).execute()
    externalPublications = github.length + gitlab.length
  }
  // An initial/continued Turn can keep phase=blocked after the execution
  // finishes. That is historical failure evidence, not a pending writer. Only
  // disregard it when the exact owner-scoped run is terminal AND the assistant
  // has published its final settlement. Pre-admission failures, missing final
  // replies and genuinely in-flight author/Pi messages still veto deletion.
  const activeMessages = await db.selectFrom('storyThreadMessages')
    .select(eb => eb.fn.countAll<number>().as('total'))
    .where('threadId', '=', id).where('ownerUserId', '=', owner)
    .where('role', '=', 'user')
    .where('phase', 'in', ['preparing', 'running'])
    .executeTakeFirstOrThrow()
  const blockedMessages = await db.selectFrom('storyThreadMessages')
    .select(['jobId', 'status'])
    .where('threadId', '=', id).where('ownerUserId', '=', owner)
    .where('role', '=', 'user').where('phase', '=', 'blocked').execute()
  const terminalRuns = new Set(runs.filter(run =>
    ['blocked', 'completed', 'cancelled'].includes(run.status) && run.queue === 'finished')
    .map(run => run.id))
  const finalAssistants = new Set(terminalRuns.size
    ? (await db.selectFrom('storyThreadMessages').select('jobId')
      .where('threadId', '=', id).where('ownerUserId', '=', owner)
      .where('role', '=', 'assistant').where('status', '=', 'delivered')
      .where('phase', '=', 'finished')
      .where('jobId', 'in', [...terminalRuns]).execute())
      .map(message => message.jobId)
    : [])
  const blockedPending = blockedMessages.filter(message =>
    message.status !== 'delivered' || !message.jobId ||
    !terminalRuns.has(message.jobId) || !finalAssistants.has(message.jobId)).length
  const liveCount = await db.selectFrom('threadLiveInputs')
    .select(eb => eb.fn.countAll<number>().as('total'))
    .where('threadId', '=', id).where('ownerUserId', '=', owner)
    .where('state', 'in', ['dispatching', 'sdk-queued'])
    .executeTakeFirstOrThrow()
  return {
    ...thread, children, pendingForks, externalPublications,
    unsettledMessages: Number(activeMessages.total) + blockedPending + Number(liveCount.total),
    runs,
  }
}

/** Owner-scoped Story-first Thread/Conversation compatibility contract. There
 * is deliberately no Conversation table. Reads and all mutations use the same
 * Kysely query definitions on SQLite and PostgreSQL. Staged until #141. */
export function createKyselyConversationCatalog(db: SharedDatabase<StudioDb>): ConversationCatalog {
  return {
    async story(owner, storyId) {
      required(owner)
      return (await db.read.selectFrom('stories').select(['id', 'title'])
        .where('id', '=', storyId).where('ownerUserId', '=', owner)
        .executeTakeFirst()) ?? null
    },
    async usageRuns(owner, storyId) {
      required(owner)
      return db.read.selectFrom('storyThreadRuns')
        .innerJoin('storyThreads', (join) => join
          .onRef('storyThreads.id', '=', 'storyThreadRuns.threadId')
          .onRef('storyThreads.ownerUserId', '=', 'storyThreadRuns.ownerUserId'))
        .innerJoin('studioSessions', (join) => join
          .onRef('studioSessions.id', '=', 'storyThreadRuns.jobId')
          .onRef('studioSessions.ownerUserId', '=', 'storyThreadRuns.ownerUserId'))
        .select([
          'storyThreadRuns.jobId as jobId', 'storyThreadRuns.threadId as threadId',
          'storyThreadRuns.runOrder as runOrder', 'studioSessions.status as status',
          'studioSessions.generationRequestJson as requestJson',
          'storyThreads.deletedAt as deletedAt', 'storyThreads.deletionPlanJson as deletionPlanJson',
        ])
        .where('storyThreadRuns.ownerUserId', '=', owner)
        .where('storyThreads.storyId', '=', storyId)
        .orderBy('storyThreadRuns.threadId').orderBy('storyThreadRuns.runOrder').execute()
    },
    async reconcileRoots(owner, storyId) {
      required(owner)
      await db.withWriteTransaction([], async (tx) => {
        const missing = await tx.selectFrom('studioSessions')
          .leftJoin('storyThreadRuns', 'storyThreadRuns.jobId', 'studioSessions.id')
          .select([
            'studioSessions.id as id', 'studioSessions.ownerUserId as owner',
            'studioSessions.storyId as story', 'studioSessions.title as title',
            'studioSessions.createdAt as createdAt',
          ])
          .where('studioSessions.ownerUserId', '=', owner)
          .where('studioSessions.storyId', '=', storyId)
          .where('storyThreadRuns.jobId', 'is', null).execute()
        for (const job of missing) {
          const threadId = 'root:' + job.id
          await tx.insertInto('storyThreads').values({
            id: threadId, ownerUserId: job.owner, storyId: job.story,
            title: job.title, activityAt: job.createdAt, createdAt: job.createdAt,
          }).onConflict(oc => oc.doNothing()).execute()
          await tx.insertInto('storyThreadRuns').values({
            jobId: job.id, ownerUserId: job.owner, threadId, runOrder: 0,
          }).onConflict(oc => oc.doNothing()).execute()
        }
      })
    },
    async navigation(owner, storyId) {
      required(owner)
      // Multiple runs belong to one visible Thread. Select their latest
      // sequence explicitly instead of trusting timestamp or physical row order.
      const rows = await db.read.selectFrom('storyThreads')
        .leftJoin('storyCollectionMemberships', (join) => join
          .onRef('storyCollectionMemberships.threadId', '=', 'storyThreads.id')
          .onRef('storyCollectionMemberships.ownerUserId', '=', 'storyThreads.ownerUserId')
          .onRef('storyCollectionMemberships.storyId', '=', 'storyThreads.storyId'))
        .leftJoin('storyThreadRuns', (join) => join
          .onRef('storyThreadRuns.threadId', '=', 'storyThreads.id')
          .onRef('storyThreadRuns.ownerUserId', '=', 'storyThreads.ownerUserId')
          .on('storyThreadRuns.runOrder', '=', sql<number>`(SELECT MAX(r2.run_order)
            FROM story_thread_runs r2
            WHERE r2.thread_id = "story_threads"."id"
              AND r2.owner_user_id = "story_threads"."owner_user_id")`))
        .leftJoin('studioSessions', (join) => join
          .onRef('studioSessions.id', '=', 'storyThreadRuns.jobId')
          .onRef('studioSessions.ownerUserId', '=', 'storyThreads.ownerUserId'))
        .leftJoin('generationRunQueue', (join) => join
          .onRef('generationRunQueue.jobId', '=', 'storyThreadRuns.jobId')
          .onRef('generationRunQueue.ownerUserId', '=', 'storyThreads.ownerUserId'))
        .select([
          'storyThreads.id as id', 'storyThreads.storyId as storyId',
          'storyThreads.parentThreadId as parentThreadId',
          'storyCollectionMemberships.collectionId as collectionId',
          'storyThreads.title as title', 'storyThreads.activityAt as activityAt',
          'storyThreads.archivedAt as archivedAt', 'storyThreads.deletedAt as deletedAt',
          'storyThreads.deletionCompleteAt as deletionCompleteAt',
          'storyThreads.createdAt as createdAt',
          'storyThreadRuns.jobId as jobId',
          'storyThreadRuns.needsAuthor as needsAuthor', 'studioSessions.status as jobStatus',
          'studioSessions.generationRequestJson as requestJson',
          'generationRunQueue.phase as queuePhase',
          'generationRunQueue.createdAt as queueAt',
          'generationRunQueue.updatedAt as queueUpdatedAt',
          // These bounded index-backed lookups avoid materializing every
          // historical event for every visible Thread in the web process.
          sql<string | null>`(SELECT MAX(e.created_at) FROM generation_events e
            WHERE e.job_id = "story_thread_runs"."job_id"
              AND e.owner_user_id = "story_threads"."owner_user_id")`.as('lastEventAt'),
          sql<string | null>`(SELECT e.stage FROM generation_events e
            WHERE e.job_id = "story_thread_runs"."job_id"
              AND e.owner_user_id = "story_threads"."owner_user_id"
              AND e.kind = 'working'
              AND e.id >= COALESCE((SELECT MAX(started.id) FROM generation_events started
                WHERE started.job_id = "story_thread_runs"."job_id"
                  AND started.owner_user_id = "story_threads"."owner_user_id"
                  AND started.kind = 'started'), 0)
            ORDER BY e.id DESC LIMIT 1)`.as('workingStage'),
          sql<string | null>`(SELECT e.milestone FROM generation_events e
            WHERE e.job_id = "story_thread_runs"."job_id"
              AND e.owner_user_id = "story_threads"."owner_user_id"
              AND e.kind = 'working'
              AND e.id >= COALESCE((SELECT MAX(started.id) FROM generation_events started
                WHERE started.job_id = "story_thread_runs"."job_id"
                  AND started.owner_user_id = "story_threads"."owner_user_id"
                  AND started.kind = 'started'), 0)
            ORDER BY e.id DESC LIMIT 1)`.as('workingMilestone'),
        ])
        .where('storyThreads.ownerUserId', '=', owner)
        .where('storyThreads.storyId', '=', storyId)
        .orderBy('storyThreads.id').execute()
      const threads: NavigationThreadRecord[] = rows.map(row => ({
          id: row.id, storyId: row.storyId, parentThreadId: row.parentThreadId,
          collectionId: row.collectionId, title: row.title, activityAt: row.activityAt,
          archivedAt: row.archivedAt, deletedAt: row.deletedAt,
          deletionCompleteAt: row.deletionCompleteAt, createdAt: row.createdAt,
          jobId: row.jobId, needsAuthor: row.needsAuthor === null ? null : !!row.needsAuthor,
          jobStatus: row.jobStatus, requestJson: row.requestJson,
          queuePhase: row.queuePhase, queueAt: row.queueAt, queueUpdatedAt: row.queueUpdatedAt,
          lastEventAt: row.lastEventAt,
          workingStage: row.workingStage,
          workingMilestone: row.workingMilestone,
        }))
      return { threads }
    },
    async create(owner, storyId, id, at) {
      required(owner)
      return db.withWriteTransaction([{ kind: 'thread', id }], async (tx) => {
        const title = 'New Thread'
        await tx.insertInto('storyThreads').values({
          id, ownerUserId: owner, storyId, title, createdAt: at, activityAt: at,
        }).execute()
        return { id, title }
      })
    },
    async renameThread(owner, id, title) {
      required(owner)
      return db.withWriteTransaction([{ kind: 'thread', id }], async (tx) =>
        (await tx.updateTable('storyThreads').set({ title })
          .where('id', '=', id).where('ownerUserId', '=', owner)
          .where('deletedAt', 'is', null).executeTakeFirst()).numUpdatedRows === 1n)
    },
    async setCreativePolicy(owner, id, policyJson) {
      required(owner)
      return db.withWriteTransaction([{ kind: 'thread', id }], async (tx) =>
        (await tx.updateTable('storyThreads').set({ creativePolicyJson: policyJson })
          .where('id', '=', id).where('ownerUserId', '=', owner)
          .where('deletedAt', 'is', null).executeTakeFirst()).numUpdatedRows === 1n)
    },
    async archiveThread(owner, id, archived, at) {
      required(owner)
      return db.withWriteTransaction([{ kind: 'thread', id }], async (tx) => {
        const member = await tx.selectFrom('storyThreads').select(['id', 'deletedAt'])
          .where('id', '=', id).where('ownerUserId', '=', owner).executeTakeFirst()
        if (!member || member.deletedAt) return false
        let query = tx.updateTable('storyThreads').set({ archivedAt: archived ? at : null })
          .where('id', '=', id).where('ownerUserId', '=', owner)
        query = archived ? query.where('archivedAt', 'is', null) :
          query.where('archivedAt', 'is not', null)
        await query.execute()
        return true
      })
    },
    async deletion(owner, id) {
      required(owner)
      return deletion(db.read, owner, id)
    },
    async beginDeletion(owner, id, jobIds, planJson, at) {
      required(owner)
      return db.withWriteTransaction([{ kind: 'thread', id }], async (tx) => {
        const current = await deletion(tx, owner, id)
        if (!current) return false
        if (current.deletedAt) return current.planJson === planJson
        if (current.pendingForks || current.externalPublications || current.unsettledMessages ||
          current.runs.some(run => run.status === 'running' ||
            ['running', 'queued', 'interrupted'].includes(run.queue ?? '')) ||
          JSON.stringify(current.runs.map(run => run.id)) !== JSON.stringify(jobIds))
          return false
        return (await tx.updateTable('storyThreads').set({
          deletedAt: at, deletionPlanJson: planJson,
        }).where('id', '=', id).where('ownerUserId', '=', owner)
          .where('deletedAt', 'is', null).executeTakeFirst()).numUpdatedRows === 1n
      })
    },
    async finishDeletion(owner, id, at, bytes) {
      required(owner)
      await db.withWriteTransaction([{ kind: 'thread', id }], async (tx) => {
        const record = await deletion(tx, owner, id)
        if (!record?.deletedAt || !record.planJson) throw new Error('No reserved deletion.')
        if (record.completedAt) return
        const { preserveReceipts, usageSummaries } = JSON.parse(record.planJson) as {
          preserveReceipts?: boolean; usageSummaries?: Record<string, unknown>
        }
        await tx.updateTable('storyThreads').set({
          deletionCompleteAt: at,
          deletionPlanJson: JSON.stringify({
            preserveReceipts: preserveReceipts === true, usageSummaries: usageSummaries ?? {},
          }),
          deletionBytes: bytes,
        }).where('id', '=', id).where('ownerUserId', '=', owner).execute()
      })
    },
    async deletedJob(owner, jobId) {
      required(owner)
      return !!(await db.read.selectFrom('storyThreads')
        .innerJoin('storyThreadRuns', (join) => join
          .onRef('storyThreadRuns.threadId', '=', 'storyThreads.id')
          .onRef('storyThreadRuns.ownerUserId', '=', 'storyThreads.ownerUserId'))
        .select('storyThreads.id')
        .where('storyThreadRuns.jobId', '=', jobId)
        .where('storyThreads.ownerUserId', '=', owner)
        .where('storyThreads.deletedAt', 'is not', null).executeTakeFirst())
    },
  }
}
