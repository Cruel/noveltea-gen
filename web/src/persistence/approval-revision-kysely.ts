import { sql, type Transaction } from 'kysely'
import type { QueryExecutor, SharedDatabase, WriteGuard } from '../db/kysely-connection'
import type { StudioDb } from '../db/studio-db'
import { ThreadMessageConflict } from './thread-message-contracts'
import type {
  ApprovalJobCatalog, ProtectedDecisionGrant, ProtectedDecisionReceipt,
  ProtectedDecisionRecords, RevisionQueueHead, RevisionRecords, RevisionRun,
} from './publication-contracts'

type Read = QueryExecutor<StudioDb>
type Write = Transaction<StudioDb>
const thread = (id: string): WriteGuard => ({ kind: 'thread', id })
const job = (id: string): WriteGuard => ({ kind: 'job', id })
const changed = (row: { numUpdatedRows: bigint | number }): boolean => Number(row.numUpdatedRows) === 1
const sha = (value: string): boolean => /^[a-f0-9]{40}$/.test(value)

function ownerRequired(owner: string): void {
  if (!owner) throw new ThreadMessageConflict(401, 'Authenticated owner required.')
}

/** Preserve review-message ordering at the original steer's position. Queries
 * accept the caller's executor so the whole admission uses ONE snapshot. */
async function queueHead(db: Read, owner: string, threadId: string): Promise<RevisionQueueHead | null> {
  ownerRequired(owner)
  const row = await db.selectFrom('storyThreadMessages as m')
    .select(['m.id as id', 'm.body as content', 'm.phase as phase'])
    .where('m.ownerUserId', '=', owner).where('m.threadId', '=', threadId)
    .where('m.role', '=', 'user')
    .where('m.phase', 'in', ['queued', 'preparing', 'running', 'blocked'])
    .where(eb => eb.not(eb.exists(eb.selectFrom('threadLiveInputs as l')
      .select('l.messageId').whereRef('l.messageId', '=', 'm.id')
      .where('l.mode', '=', 'steer'))))
    .where(eb => eb.not(eb.exists(eb.selectFrom('storyThreadMessageCancellations as c')
      .select('c.messageId').whereRef('c.messageId', '=', 'm.id'))))
    .orderBy(sql<number>`COALESCE((SELECT original.sequence FROM thread_steering_intents intent
      JOIN story_thread_messages original ON original.id=intent.message_id
      WHERE intent.review_message_id="m"."id"), "m"."sequence")`)
    .orderBy('m.sequence').executeTakeFirst()
  return row ? { id: row.id, content: row.content, phase: row.phase ?? '' } : null
}

async function latestRun(db: Read, owner: string, threadId: string): Promise<RevisionRun | null> {
  ownerRequired(owner)
  const row = await db.selectFrom('storyThreadRuns as r')
    .innerJoin('studioSessions as s', join => join
      .onRef('s.id', '=', 'r.jobId').onRef('s.ownerUserId', '=', 'r.ownerUserId'))
    .innerJoin('storyThreads as t', join => join
      .onRef('t.id', '=', 'r.threadId').onRef('t.ownerUserId', '=', 'r.ownerUserId'))
    .leftJoin('generationRunQueue as q', join => join
      .onRef('q.jobId', '=', 's.id').onRef('q.ownerUserId', '=', 's.ownerUserId'))
    .select(['r.jobId as jobId', 's.status as status', 'q.phase as queuePhase'])
    .where('r.ownerUserId', '=', owner).where('r.threadId', '=', threadId)
    .orderBy('r.runOrder', 'desc').executeTakeFirst()
  return row ?? null
}

async function receipt(db: Read, owner: string, id: string): Promise<ProtectedDecisionReceipt | null> {
  ownerRequired(owner)
  const row = await db.selectFrom('threadProtectedDecisions')
    .select(['messageId', 'ownerUserId as owner', 'threadId', 'sourceJobId',
      'sourceSha', 'proposalSha256 as digest', 'changeJson', 'nonce', 'decision',
      'principal', 'recordedAt', 'consumedSha'])
    .where('messageId', '=', id).where('ownerUserId', '=', owner).executeTakeFirst()
  if (!row) return null
  if (row.decision !== 'approved' && row.decision !== 'rejected')
    throw new ThreadMessageConflict(409, 'Stored protected decision is invalid.')
  return { ...row, decision: row.decision }
}

/** Caller must hold a writer transaction. The optional original-source binding
 * prevents a prepared continuation from consuming a receipt for another Thread
 * or Git source. No root connection/transaction may be used here. */
export async function consumeProtectedDecisionKysely(
  tx: Write, owner: string, messageId: string, committedSha: string,
  source?: { threadId: string; sourceJobId: string; sourceSha: string },
): Promise<boolean> {
  ownerRequired(owner)
  if (!sha(committedSha)) return false
  let query = tx.updateTable('threadProtectedDecisions').set({ consumedSha: committedSha })
    .where('messageId', '=', messageId).where('ownerUserId', '=', owner)
    .where('decision', '=', 'approved').where('consumedSha', 'is', null)
  if (source) query = query.where('threadId', '=', source.threadId)
    .where('sourceJobId', '=', source.sourceJobId).where('sourceSha', '=', source.sourceSha)
  return changed(await query.executeTakeFirst())
}

/** Shared SQLite/PostgreSQL authorization persistence. */
export function createKyselyApprovalRevisionPersistence(db: SharedDatabase<StudioDb>): {
  approvalJobs: ApprovalJobCatalog
  protectedDecisions: ProtectedDecisionRecords
  revisions: RevisionRecords
} {
  return {
    approvalJobs: {
      async job(owner, jobId) {
        ownerRequired(owner)
        const row = await db.read.selectFrom('studioSessions as s')
          .innerJoin('stories as st', join => join
            .onRef('s.storyId', '=', 'st.id').onRef('s.ownerUserId', '=', 'st.ownerUserId'))
          .innerJoin('repositories as r', join => join
            .onRef('st.repositoryId', '=', 'r.id').onRef('st.ownerUserId', '=', 'r.ownerUserId'))
          .select(['st.directory as directory', 'r.provider as provider',
            'r.providerRepositoryId as providerId', 's.sourceCommitSha as baseSha'])
          .where('s.id', '=', jobId).where('s.ownerUserId', '=', owner)
          .executeTakeFirst()
        return row ? { ...row, provider: row.provider as 'github' | 'gitlab' } : null
      },
    },
    protectedDecisions: {
      get: (owner, messageId) => receipt(db.read, owner, messageId),
      async record(owner, data: ProtectedDecisionGrant, request) {
        ownerRequired(owner)
        return db.withWriteTransaction([thread(data.threadId), job(data.sourceJobId)], async tx => {
          if (data.owner !== owner || data.principal !== 'user:' + owner)
            throw new ThreadMessageConflict(409,
              'Protected approval principal differs from the authenticated owner.')
          const message = await tx.selectFrom('storyThreadMessages as m')
            .select(['m.body as body', 'm.phase as phase'])
            .where('m.id', '=', data.messageId).where('m.ownerUserId', '=', owner)
            .where('m.threadId', '=', data.threadId).where('m.role', '=', 'user')
            .where(eb => eb.not(eb.exists(eb.selectFrom('storyThreadMessageCancellations as c')
              .select('c.messageId').whereRef('c.messageId', '=', 'm.id'))))
            .executeTakeFirst()
          const head = await queueHead(tx, owner, data.threadId)
          const run = await latestRun(tx, owner, data.threadId)
          if (!message || message.body !== request || message.phase !== 'queued' ||
              head?.id !== data.messageId || run?.jobId !== data.sourceJobId ||
              run.status !== 'completed' || run.queuePhase !== 'finished')
            throw new ThreadMessageConflict(409,
              'Protected decision review is no longer the queued instruction at its verified source.')
          const existing = await receipt(tx, owner, data.messageId)
          if (existing) {
            if (existing.threadId !== data.threadId || existing.sourceJobId !== data.sourceJobId ||
                existing.sourceSha !== data.sourceSha || existing.digest !== data.digest ||
                existing.changeJson !== data.changeJson || existing.decision !== data.decision ||
                existing.principal !== data.principal)
              throw new ThreadMessageConflict(409,
                'This instruction already has a different or stale protected decision receipt.')
            return existing
          }
          await tx.insertInto('threadProtectedDecisions').values({
            messageId: data.messageId, ownerUserId: owner, threadId: data.threadId,
            sourceJobId: data.sourceJobId, sourceSha: data.sourceSha,
            proposalSha256: data.digest, changeJson: data.changeJson,
            nonce: data.nonce, decision: data.decision, principal: data.principal,
            recordedAt: data.recordedAt,
          }).execute()
          return (await receipt(tx, owner, data.messageId))!
        })
      },
      async consume(owner, messageId, committedSha) {
        ownerRequired(owner)
        // A receipt can only be consumed once, even when separate workers race.
        return db.withWriteTransaction([], tx =>
          consumeProtectedDecisionKysely(tx, owner, messageId, committedSha))
      },
    },
    revisions: {
      head: (owner, threadId) => queueHead(db.read, owner, threadId),
      latestRun: (owner, threadId) => latestRun(db.read, owner, threadId),
      async scope(owner, threadId, messageId) {
        ownerRequired(owner)
        return (await db.read.selectFrom('storyThreadMessages').select('revisionScopeJson')
          .where('id', '=', messageId).where('ownerUserId', '=', owner)
          .where('threadId', '=', threadId).executeTakeFirst())?.revisionScopeJson ?? null
      },
      async redirected(owner, threadId, messageId) {
        ownerRequired(owner)
        return Boolean(await db.read.selectFrom('threadSteeringIntents')
          .select('disposition').where('ownerUserId', '=', owner)
          .where('threadId', '=', threadId).where('reviewMessageId', '=', messageId)
          .executeTakeFirst())
      },
      async grant(owner, threadId, messageId, content, source, receiptJson) {
        ownerRequired(owner)
        return db.withWriteTransaction([thread(threadId), job(source.jobId)], async tx => {
          const current = await tx.selectFrom('storyThreadMessages')
            .select(['body', 'phase', 'revisionScopeJson'])
            .where('id', '=', messageId).where('ownerUserId', '=', owner)
            .where('threadId', '=', threadId).executeTakeFirst()
          const run = await latestRun(tx, owner, threadId)
          const head = await queueHead(tx, owner, threadId)
          if (!current || current.phase !== 'queued' || current.body !== content ||
              head?.id !== messageId || run?.jobId !== source.jobId ||
              run.status !== 'completed' || run.queuePhase !== 'finished' ||
              source.status !== 'completed' || source.queuePhase !== 'finished')
            return 'stale'
          if (current.revisionScopeJson !== null) {
            if (current.revisionScopeJson !== receiptJson)
              throw new ThreadMessageConflict(409,
                'Message UUID already has a different scope authorization.')
            return 'already'
          }
          const updated = await tx.updateTable('storyThreadMessages')
            .set({ revisionScopeJson: receiptJson })
            .where('id', '=', messageId).where('ownerUserId', '=', owner)
            .where('threadId', '=', threadId).where('phase', '=', 'queued')
            .where('revisionScopeJson', 'is', null)
            .where(eb => eb.not(eb.exists(eb.selectFrom('storyThreadMessageCancellations as c')
              .select('c.messageId').whereRef('c.messageId', '=', 'storyThreadMessages.id'))))
            .executeTakeFirst()
          return changed(updated) ? 'granted' : 'stale'
        })
      },
    },
  }
}
