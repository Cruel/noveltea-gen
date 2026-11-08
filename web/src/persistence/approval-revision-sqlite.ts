import { and, asc, desc, eq, isNull, notExists, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema'
import { generationRunQueue, repositories, sessions, stories, storyThreadMessageCancellations,
  storyThreadMessages, storyThreadRuns, storyThreads, threadProtectedDecisions,
  threadLiveInputs, threadSteeringIntents } from '../db/schema'
import { ThreadMessageConflict } from './thread-message-contracts'
import type { ApprovalJobCatalog, ProtectedDecisionGrant, ProtectedDecisionReceipt,
  ProtectedDecisionRecords, RevisionQueueHead, RevisionRun, RevisionRecords } from './publication-contracts'

type Db = BetterSQLite3Database<typeof schema>
const m = storyThreadMessages
const p = threadProtectedDecisions
function assertOwner(owner: string): void {
  if (!owner) throw new ThreadMessageConflict(401, 'Authenticated owner required.')
}

function queueHead(db: Db, owner: string, threadId: string): RevisionQueueHead | null {
  assertOwner(owner)
  return db.select({ id: m.id, content: m.body, phase: m.phase }).from(m)
    .where(and(eq(m.ownerUserId, owner), eq(m.threadId, threadId), eq(m.role, 'user'),
      sql`${m.phase} in ('queued','preparing','running','blocked')`,
      notExists(db.select({ id: threadLiveInputs.messageId }).from(threadLiveInputs)
        .where(and(eq(threadLiveInputs.messageId, m.id), eq(threadLiveInputs.mode, 'steer')))),
      notExists(db.select({ id: storyThreadMessageCancellations.messageId })
        .from(storyThreadMessageCancellations).where(eq(storyThreadMessageCancellations.messageId, m.id)))))
    .orderBy(sql`COALESCE((SELECT original.sequence FROM thread_steering_intents intent
       JOIN story_thread_messages original ON original.id=intent.message_id
       WHERE intent.review_message_id=${m.id}), ${m.sequence})`, asc(m.sequence))
    .limit(1).get() as RevisionQueueHead | undefined ?? null
}
function currentRun(db: Db, owner: string, threadId: string): RevisionRun | null {
  assertOwner(owner)
  return db.select({
    jobId: storyThreadRuns.jobId, status: sessions.status,
    queuePhase: generationRunQueue.phase,
  }).from(storyThreadRuns)
    .innerJoin(sessions, and(eq(storyThreadRuns.jobId, sessions.id),
      eq(storyThreadRuns.ownerUserId, sessions.ownerUserId)))
    .innerJoin(storyThreads, and(eq(storyThreads.id, storyThreadRuns.threadId),
      eq(storyThreads.ownerUserId, storyThreadRuns.ownerUserId)))
    .leftJoin(generationRunQueue, and(eq(generationRunQueue.jobId, sessions.id),
      eq(generationRunQueue.ownerUserId, sessions.ownerUserId)))
    .where(and(eq(storyThreadRuns.ownerUserId, owner), eq(storyThreadRuns.threadId, threadId)))
    .orderBy(desc(storyThreadRuns.runOrder)).limit(1).get() ?? null
}
function decisionReceipt(db: Db, owner: string, id: string): ProtectedDecisionReceipt | null {
  assertOwner(owner)
  return db.select({
    messageId: p.messageId, owner: p.ownerUserId, threadId: p.threadId,
    sourceJobId: p.sourceJobId, sourceSha: p.sourceSha, digest: p.proposalSha256,
    changeJson: p.changeJson, nonce: p.nonce, decision: p.decision,
    principal: p.principal, recordedAt: p.recordedAt, consumedSha: p.consumedSha,
  }).from(p).where(and(eq(p.messageId, id), eq(p.ownerUserId, owner))).get() ?? null
}

export function createSqliteApprovalJobCatalog(db: Db): ApprovalJobCatalog {
  return {
    async job(owner, jobId) {
      assertOwner(owner)
      return db.select({
        directory: stories.directory, provider: repositories.provider,
        providerId: repositories.providerRepositoryId, baseSha: sessions.sourceCommitSha,
      }).from(sessions).innerJoin(stories, and(eq(sessions.storyId, stories.id),
        eq(sessions.ownerUserId, stories.ownerUserId)))
        .innerJoin(repositories, and(eq(stories.repositoryId, repositories.id),
          eq(stories.ownerUserId, repositories.ownerUserId)))
        .where(and(eq(sessions.id, jobId), eq(sessions.ownerUserId, owner))).get() ?? null
    },
  }
}

/** Shared synchronous statement used by the protected continuation's
 * transaction and by the public async port. The caller decides the transaction
 * boundary; no async operation may occur inside a SQLite writer transaction. */
export function consumeProtectedDecisionSqlite(db: Db, owner: string,
  messageId: string, sha: string): boolean {
  assertOwner(owner)
  return db.update(p).set({ consumedSha: sha }).where(and(
    eq(p.messageId, messageId), eq(p.ownerUserId, owner),
    eq(p.decision, 'approved'), isNull(p.consumedSha),
  )).run().changes === 1
}

export function createSqliteProtectedDecisionRecords(db: Db): ProtectedDecisionRecords {
  const bridge: {
    get(owner: string, messageId: string): ProtectedDecisionReceipt | null
    record(owner: string, data: ProtectedDecisionGrant, request: string): ProtectedDecisionReceipt
    consume(owner: string, messageId: string, sha: string): boolean
  } = {
    get(owner, messageId) { return decisionReceipt(db, owner, messageId) },
    record(owner, data, request) {
      assertOwner(owner)
      return db.transaction(tx => {
        if (data.owner !== owner || data.principal !== 'user:' + owner)
          throw new ThreadMessageConflict(409, 'Protected approval principal differs from the authenticated owner.')
        const message = tx.select({ body: m.body, phase: m.phase }).from(m)
          .where(and(eq(m.id, data.messageId), eq(m.ownerUserId, owner),
            eq(m.threadId, data.threadId), eq(m.role, 'user'),
            notExists(tx.select({ id: storyThreadMessageCancellations.messageId })
              .from(storyThreadMessageCancellations)
              .where(eq(storyThreadMessageCancellations.messageId, m.id))))).get()
        const head = queueHead(db, owner, data.threadId)
        const run = currentRun(db, owner, data.threadId)
        if (!message || message.body !== request || message.phase !== 'queued' ||
            head?.id !== data.messageId || run?.jobId !== data.sourceJobId ||
            run.status !== 'completed' || run.queuePhase !== 'finished')
          throw new ThreadMessageConflict(409,
            'Protected decision review is no longer the queued instruction at its verified source.')
        const existing = decisionReceipt(db, owner, data.messageId)
        if (existing) {
          if (existing.threadId !== data.threadId || existing.sourceJobId !== data.sourceJobId ||
              existing.sourceSha !== data.sourceSha || existing.digest !== data.digest ||
              existing.changeJson !== data.changeJson || existing.decision !== data.decision ||
              existing.principal !== data.principal)
            throw new ThreadMessageConflict(409, 'This instruction already has a different or stale protected decision receipt.')
          return existing
        }
        tx.insert(p).values({
          messageId: data.messageId, ownerUserId: owner, threadId: data.threadId,
          sourceJobId: data.sourceJobId, sourceSha: data.sourceSha,
          proposalSha256: data.digest, changeJson: data.changeJson, nonce: data.nonce,
          decision: data.decision, principal: data.principal, recordedAt: data.recordedAt,
        }).run()
        return decisionReceipt(db, owner, data.messageId)!
      }, { behavior: 'immediate' })
    },
    consume(owner, messageId, sha) {
      return consumeProtectedDecisionSqlite(db, owner, messageId, sha)
    },
  }
  return {
    async get(owner, messageId) { return bridge.get(owner, messageId) },
    async record(owner, data, request) { return bridge.record(owner, data, request) },
    async consume(owner, messageId, sha) { return bridge.consume(owner, messageId, sha) },
  }
}

export function createSqliteRevisionRecords(db: Db): RevisionRecords {
  return {
    async head(owner, threadId) { return queueHead(db, owner, threadId) },
    async latestRun(owner, threadId) { return currentRun(db, owner, threadId) },
    async scope(owner, threadId, messageId) {
      assertOwner(owner)
      return db.select({ scope: m.revisionScopeJson }).from(m).where(and(
        eq(m.ownerUserId, owner), eq(m.threadId, threadId), eq(m.id, messageId),
      )).get()?.scope ?? null
    },
    async redirected(owner, threadId, messageId) {
      assertOwner(owner)
      return !!db.select({ disposition: threadSteeringIntents.disposition })
        .from(threadSteeringIntents).where(and(
          eq(threadSteeringIntents.ownerUserId, owner),
          eq(threadSteeringIntents.threadId, threadId),
          eq(threadSteeringIntents.reviewMessageId, messageId),
        )).get()
    },
    async grant(owner, threadId, messageId, content, source, receiptJson) {
      assertOwner(owner)
      return db.transaction(tx => {
        const current = tx.select({
          id: m.id, body: m.body, phase: m.phase, scope: m.revisionScopeJson,
        }).from(m).where(and(eq(m.id, messageId), eq(m.ownerUserId, owner),
          eq(m.threadId, threadId))).get()
        const run = currentRun(db, owner, threadId)
        const head = queueHead(db, owner, threadId)
        if (!current || current.phase !== 'queued' || current.body !== content ||
            head?.id !== messageId || run?.jobId !== source.jobId ||
            run.status !== 'completed' || run.queuePhase !== 'finished' ||
            source.status !== 'completed' || source.queuePhase !== 'finished')
          return 'stale'
        if (current.scope !== null) {
          if (current.scope !== receiptJson)
            throw new ThreadMessageConflict(409, 'Message UUID already has a different scope authorization.')
          return 'already'
        }
        const updated = tx.update(m).set({ revisionScopeJson: receiptJson }).where(and(
          eq(m.id, messageId), eq(m.ownerUserId, owner), eq(m.threadId, threadId),
          eq(m.phase, 'queued'), isNull(m.revisionScopeJson),
          notExists(tx.select({ id: storyThreadMessageCancellations.messageId })
            .from(storyThreadMessageCancellations)
            .where(eq(storyThreadMessageCancellations.messageId, m.id))),
        )).run()
        return updated.changes === 1 ? 'granted' : 'stale'
      }, { behavior: 'immediate' })
    },
  }
}
