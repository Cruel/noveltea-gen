import { and, asc, desc, eq, isNull, notExists, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema'
import { generationRunQueue as queue, sessions, storyThreads as threads,
  storyThreadRuns as runs, storyThreadMessages as messages, storyThreadMessageCancellations as cancellations,
  threadSteeringIntents as steeringIntents } from '../db/schema'
import { insertThreadAssistantSqlite, nextThreadSequenceSqlite,
  seedThreadMessagesSqlite } from './thread-message-sqlite'
import { consumeProtectedDecisionSqlite } from './approval-revision-sqlite'
import { enqueueGenerationSqlite } from './generation-sqlite'
import type { SteeringPersistence } from './steering-contracts'
import type { ContinuationAdmission, ContinuationPersistence, ContinuationRun,
  ContinuationRequest, QueuedContinuation } from './continuation-contracts'
type Db = BetterSQLite3Database<typeof schema>
const auth = (owner: string) => { if (!owner) throw new Error('Authenticated owner required.') }
const activePhases = sql`${messages.phase} IN ('preparing','running','blocked')`
const ordered = sql`COALESCE((SELECT original.sequence FROM thread_steering_intents intent
  JOIN story_thread_messages original ON original.id=intent.message_id
  WHERE intent.review_message_id=${messages.id}), ${messages.sequence})`

export function createSqliteContinuationPersistence(db: Db,
  steering: SteeringPersistence): ContinuationPersistence {
  const current = (owner: string, threadId: string): ContinuationRun | null => {
    auth(owner)
    return db.select({
      jobId: runs.jobId, status: sessions.status, runOrder: runs.runOrder,
      queuePhase: queue.phase,
    }).from(runs).innerJoin(sessions, and(eq(sessions.id, runs.jobId),
      eq(sessions.ownerUserId, runs.ownerUserId)))
      .leftJoin(queue, and(eq(queue.jobId, runs.jobId),
        eq(queue.ownerUserId, runs.ownerUserId)))
      .where(and(eq(runs.threadId, threadId), eq(runs.ownerUserId, owner)))
      .orderBy(desc(runs.runOrder)).limit(1).get() ?? null
  }
  const pending = (owner: string, threadId: string): QueuedContinuation | null => {
    auth(owner)
    return db.select({
      id: messages.id, content: messages.body, scope: messages.revisionScopeJson,
    }).from(messages).where(and(eq(messages.ownerUserId, owner),
      eq(messages.threadId, threadId), eq(messages.role, 'user'),
      eq(messages.phase, 'queued'), notExists(
        db.select({ id: cancellations.messageId }).from(cancellations)
          .where(eq(cancellations.messageId, messages.id)),
      ))).orderBy(ordered, asc(messages.sequence)).limit(1).get() ?? null
  }
  const verifyClaim = (data: ContinuationRequest, message: string) => {
    const row = db.select({ phase: messages.phase, source: messages.sourceJobId })
      .from(messages).where(and(eq(messages.id, data.claim.id),
        eq(messages.ownerUserId, data.owner),
        eq(messages.threadId, data.threadId))).get()
    const latest = current(data.owner, data.threadId)
    if (row?.phase !== 'preparing' || row.source !== data.claim.source ||
        latest?.jobId !== data.claim.source || latest.status !== 'completed' ||
        latest.queuePhase !== 'finished' || latest.runOrder + 1 !== data.claim.runOrder)
      throw new Error(message)
  }
  const registerChildRun = (data: ContinuationRequest, status: 'completed' | 'paused',
    suffix: string) => {
    const source = db.select({ storyId: sessions.storyId, title: sessions.title })
      .from(sessions).where(and(eq(sessions.id, data.claim.source),
        eq(sessions.ownerUserId, data.owner))).get()
    if (!source) throw new Error('Previous source session was not owned or is unavailable.')
    db.insert(sessions).values({
      id: data.claim.id, ownerUserId: data.owner, storyId: source.storyId,
      title: source.title + suffix, sourceCommitSha: data.sourceHead,
      status, createdAt: data.at, updatedAt: data.at,
      generationConfigJson: data.draftJson,
      ...(status === 'completed' ? { generationRequestJson: data.requestJson,
        generationThreadId: data.generationThread } : {}),
    }).run()
    db.insert(runs).values({
      jobId: data.claim.id, ownerUserId: data.owner,
      threadId: data.threadId, runOrder: data.claim.runOrder,
    }).run()
  }
  const finishReview = (data: ContinuationRequest) =>
    db.update(steeringIntents).set({ reviewState: 'approved-run' }).where(and(
      eq(steeringIntents.reviewMessageId, data.claim.id),
      eq(steeringIntents.ownerUserId, data.owner),
      eq(steeringIntents.threadId, data.threadId),
      eq(steeringIntents.reviewState, 'awaiting-review'),
    )).run()
  type SynchronousAdapter = { [K in keyof ContinuationPersistence]:
    (...args: Parameters<ContinuationPersistence[K]>) => Awaited<ReturnType<ContinuationPersistence[K]>> }
  const operation: SynchronousAdapter = {
    current,
    pending,
    claim(owner, threadId) {
      auth(owner)
      return db.transaction(() => {
        const run = current(owner, threadId)
        if (!run || run.status !== 'completed' || run.queuePhase !== 'finished') return null
        if (db.select({ id: messages.id }).from(messages).where(and(
          eq(messages.ownerUserId, owner), eq(messages.threadId, threadId),
          eq(messages.role, 'user'), activePhases)).limit(1).get()) return null
        const next = pending(owner, threadId)
        if (!next?.scope) return null
        const result = db.update(messages).set({
          phase: 'preparing', sourceJobId: run.jobId,
        }).where(and(eq(messages.id, next.id), eq(messages.ownerUserId, owner),
          eq(messages.phase, 'queued'), notExists(
            db.select({ id: cancellations.messageId }).from(cancellations)
              .where(eq(cancellations.messageId, messages.id)),
          ))).run()
        if (result.changes !== 1) return null
        return { id: next.id, content: next.content, scopeJson: next.scope,
          source: run.jobId, runOrder: run.runOrder + 1 }
      }, { behavior: 'immediate' })
    },
    protectedFinish(data, committedSha) {
      auth(data.owner)
      db.transaction(() => {
        verifyClaim(data, 'Protected Thread changed during exact native revision.')
        registerChildRun(data, 'completed', ' (protected revision)')
        db.insert(queue).values({
          jobId: data.claim.id, ownerUserId: data.owner, intent: 'start', phase: 'finished',
          createdAt: data.at, updatedAt: data.at,
        }).run()
        if (!consumeProtectedDecisionSqlite(db, data.owner, data.claim.id, committedSha))
          throw new Error('Protected approval was already consumed or its commit identity changed.')
        finishReview(data)
        db.update(messages).set({
          phase: 'finished', status: 'delivered', jobId: data.claim.id,
          verifiedCommitSha: committedSha,
        }).where(and(eq(messages.id, data.claim.id),
          eq(messages.ownerUserId, data.owner), eq(messages.phase, 'preparing'))).run()
        insertThreadAssistantSqlite(db, data.owner, data.threadId, data.claim.id)
        db.update(threads).set({ activityAt: data.at }).where(and(
          eq(threads.id, data.threadId), eq(threads.ownerUserId, data.owner))).run()
      }, { behavior: 'immediate' })
    },
    beginFollowUp(data) {
      auth(data.owner)
      db.transaction(() => {
        verifyClaim(data, 'Thread admission changed during worktree preparation.')
        registerChildRun(data, 'paused', ' (follow-up)')
        enqueueGenerationSqlite(db, data.owner, data.claim.id, 'start', 'prepared',
          data.at, data.requestJson, data.generationThread)
        finishReview(data)
        db.update(messages).set({ phase: 'running', jobId: data.claim.id })
          .where(and(eq(messages.id, data.claim.id), eq(messages.ownerUserId, data.owner),
            eq(messages.phase, 'preparing'))).run()
      }, { behavior: 'immediate' })
    },
    block(owner, threadId, claim, reason, at) {
      auth(owner)
      db.transaction(() => {
        db.update(messages).set({ phase: 'blocked' }).where(and(
          eq(messages.id, claim.id), eq(messages.ownerUserId, owner),
          eq(messages.phase, 'preparing'))).run()
        db.update(steeringIntents).set({ reviewState: 'unresolved' }).where(and(
          eq(steeringIntents.reviewMessageId, claim.id),
          eq(steeringIntents.ownerUserId, owner),
          eq(steeringIntents.threadId, threadId),
          eq(steeringIntents.reviewState, 'awaiting-review'))).run()
        db.insert(messages).values({
          id: 'assistant:' + claim.id, ownerUserId: owner, threadId,
          sequence: nextThreadSequenceSqlite(db, threadId),
          role: 'assistant', status: 'delivered', body: reason, phase: 'blocked',
          createdAt: at,
        }).onConflictDoNothing().run()
      }, { behavior: 'immediate' })
    },
    settledRuns() {
      return db.all(sql`SELECT DISTINCT r.job_id AS jobId,
        r.owner_user_id AS owner FROM story_thread_runs r
        JOIN generation_run_queue q ON q.job_id=r.job_id AND q.owner_user_id=r.owner_user_id
        JOIN story_thread_messages m ON m.thread_id=r.thread_id AND m.owner_user_id=r.owner_user_id
        WHERE q.phase IN ('finished','interrupted') AND
          ((m.role='user' AND m.phase='running' AND m.job_id=r.job_id)
          OR (m.role='user' AND m.phase='queued' AND r.run_order=(
            SELECT MAX(next.run_order) FROM story_thread_runs next
            WHERE next.thread_id=r.thread_id AND next.owner_user_id=r.owner_user_id)))`) as
        Array<{ jobId: string; owner: string }>
    },
    runThread(owner, jobId) {
      auth(owner)
      return db.select({ threadId: runs.threadId }).from(runs)
        .where(and(eq(runs.jobId, jobId), eq(runs.ownerUserId, owner))).get()?.threadId ?? null
    },
    settle(owner, jobId, verifiedCommit, at) {
      auth(owner)
      return db.transaction(() => {
        const saved = db.select({ threadId: runs.threadId }).from(runs).where(and(
          eq(runs.jobId, jobId), eq(runs.ownerUserId, owner))).get()
        if (!saved) return null
        const phase = db.select({ phase: queue.phase }).from(queue).where(and(
          eq(queue.jobId, jobId), eq(queue.ownerUserId, owner))).get()?.phase
        if (phase !== 'finished' && phase !== 'interrupted') return null
        steering.deferUndelivered(owner, jobId)
        seedThreadMessagesSqlite(db, owner, saved.threadId)
        db.update(messages).set({
          phase: phase === 'finished' ? 'finished' : 'blocked',
          ...(phase === 'finished' ? { status: 'delivered' } : {}),
          ...(verifiedCommit ? { verifiedCommitSha: verifiedCommit } : {}),
        }).where(and(eq(messages.ownerUserId, owner), eq(messages.jobId, jobId),
          eq(messages.role, 'user'), eq(messages.phase, 'running'))).run()
        if (verifiedCommit) steering.boundaryReviews(owner, jobId, saved.threadId, verifiedCommit, at)
        const assistant = insertThreadAssistantSqlite(db, owner, saved.threadId, jobId)
        if (verifiedCommit) db.update(messages).set({ verifiedCommitSha: verifiedCommit }).where(and(
          eq(messages.id, assistant), eq(messages.ownerUserId, owner),
          eq(messages.threadId, saved.threadId))).run()
        db.update(threads).set({ activityAt: at }).where(and(
          eq(threads.id, saved.threadId), eq(threads.ownerUserId, owner))).run()
        return saved.threadId
      }, { behavior: 'immediate' })
    },
  }
  return {
    async current(owner, threadId) { return operation.current(owner, threadId) },
    async pending(owner, threadId) { return operation.pending(owner, threadId) },
    async claim(owner, threadId) { return operation.claim(owner, threadId) },
    async protectedFinish(data, committedSha) { operation.protectedFinish(data, committedSha) },
    async beginFollowUp(data) { operation.beginFollowUp(data) },
    async block(owner, threadId, claim, reason, at) { operation.block(owner, threadId, claim, reason, at) },
    async settledRuns() { return operation.settledRuns() },
    async runThread(owner, jobId) { return operation.runThread(owner, jobId) },
    async settle(owner, jobId, verifiedCommit, at) {
      return operation.settle(owner, jobId, verifiedCommit, at)
    },
  }
}
