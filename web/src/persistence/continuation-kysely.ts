import { sql, type Transaction } from 'kysely'
import type { QueryExecutor, SharedDatabase, WriteGuard } from '../db/kysely-connection'
import type { StudioDb } from '../db/studio-db'
import { studioSafeInteger } from '../db/kysely-values'
import {
  insertThreadAssistantKysely, nextThreadSequenceKysely, seedThreadMessagesKysely,
} from './thread-message-kysely'
import {
  boundarySteeringReviewsKysely, deferUndeliveredSteeringKysely,
} from './steering-boundary-kysely'
import { consumeProtectedDecisionKysely } from './approval-revision-kysely'
import type {
  ContinuationAdmission, ContinuationPersistence, ContinuationRequest,
  ContinuationRun, QueuedContinuation,
} from './continuation-contracts'

type Read = QueryExecutor<StudioDb>
type Write = Transaction<StudioDb>
type Executor = Read | Write
const requireOwner = (owner: string) => {
  if (!owner) throw new Error('Authenticated owner required.')
}
const job = (id: string): WriteGuard => ({ kind: 'job', id })
const thread = (id: string): WriteGuard => ({ kind: 'thread', id })
const count = (result: { numUpdatedRows: bigint | number }) => Number(result.numUpdatedRows)
const sha = (value: string) => /^[a-f0-9]{40}$/.test(value)

/** A single active author Turn, latest job first. All composed callers pass
 * the same transaction executor; no read can escape to another pool client. */
async function current(db: Executor, owner: string, threadId: string): Promise<ContinuationRun | null> {
  requireOwner(owner)
  const row = await db.selectFrom('storyThreadRuns as r')
    .innerJoin('studioSessions as s', join => join
      .onRef('s.id', '=', 'r.jobId').onRef('s.ownerUserId', '=', 'r.ownerUserId'))
    .leftJoin('generationRunQueue as q', join => join
      .onRef('q.jobId', '=', 'r.jobId').onRef('q.ownerUserId', '=', 'r.ownerUserId'))
    .select(['r.jobId as jobId', 's.status as status',
      'r.runOrder as runOrder', 'q.phase as queuePhase'])
    .where('r.ownerUserId', '=', owner).where('r.threadId', '=', threadId)
    .orderBy('r.runOrder', 'desc').executeTakeFirst()
  return row ? { ...row, runOrder: studioSafeInteger(row.runOrder) } : null
}

/** Review follow-ups retain the original author's message position, but
 * steers bound to a live Pi session never become an independent Turn. */
async function pending(db: Executor, owner: string, threadId: string): Promise<QueuedContinuation | null> {
  requireOwner(owner)
  const row = await db.selectFrom('storyThreadMessages as m')
    .select(['m.id as id', 'm.body as content', 'm.revisionScopeJson as scope'])
    .where('m.ownerUserId', '=', owner).where('m.threadId', '=', threadId)
    .where('m.role', '=', 'user').where('m.phase', '=', 'queued')
    .where(eb => eb.not(eb.exists(eb.selectFrom('threadLiveInputs as l')
      .select('l.messageId').whereRef('l.messageId', '=', 'm.id')
      .where('l.mode', '=', 'steer'))))
    .where(eb => eb.not(eb.exists(eb.selectFrom('storyThreadMessageCancellations as c')
      .select('c.messageId').whereRef('c.messageId', '=', 'm.id'))))
    .orderBy(sql<number>`COALESCE((SELECT original.sequence FROM thread_steering_intents intent
      JOIN story_thread_messages original ON original.id=intent.message_id
      WHERE intent.review_message_id="m"."id"), "m"."sequence")`)
    .orderBy('m.sequence').executeTakeFirst()
  return row ?? null
}

async function requireLive(tx: Write, owner: string, threadId: string): Promise<void> {
  const row = await tx.selectFrom('storyThreads').select('deletedAt')
    .where('id', '=', threadId).where('ownerUserId', '=', owner).executeTakeFirst()
  if (!row || row.deletedAt) throw new Error('This Thread was deleted during admission.')
}

async function verifyClaim(tx: Write, data: ContinuationRequest, error: string): Promise<void> {
  await requireLive(tx, data.owner, data.threadId)
  const row = await tx.selectFrom('storyThreadMessages')
    .select(['phase', 'sourceJobId', 'body', 'revisionScopeJson'])
    .where('id', '=', data.claim.id).where('ownerUserId', '=', data.owner)
    .where('threadId', '=', data.threadId).executeTakeFirst()
  const latest = await current(tx, data.owner, data.threadId)
  if (row?.phase !== 'preparing' || row.sourceJobId !== data.claim.source ||
      row.body !== data.claim.content || row.revisionScopeJson !== data.claim.scopeJson ||
      latest?.jobId !== data.claim.source || latest.status !== 'completed' ||
      latest.queuePhase !== 'finished' || latest.runOrder + 1 !== data.claim.runOrder)
    throw new Error(error)
  let scope: { sourceSha?: unknown; sourceJobId?: unknown }
  try { scope = JSON.parse(row.revisionScopeJson ?? 'null') as typeof scope }
  catch { throw new Error(error) }
  if (!scope || typeof scope !== 'object' ||
      (scope.sourceSha !== undefined && scope.sourceSha !== data.sourceHead) ||
      (scope.sourceJobId !== undefined && scope.sourceJobId !== data.claim.source))
    throw new Error(error)
}

async function registerChild(tx: Write, data: ContinuationRequest,
  status: 'completed' | 'paused', suffix: string): Promise<void> {
  const source = await tx.selectFrom('studioSessions')
    .select(['storyId', 'title'])
    .where('id', '=', data.claim.source).where('ownerUserId', '=', data.owner)
    .executeTakeFirst()
  if (!source) throw new Error('Previous source session was not owned or is unavailable.')
  const membership = await tx.selectFrom('storyThreads').select('storyId')
    .where('id', '=', data.threadId).where('ownerUserId', '=', data.owner)
    .executeTakeFirst()
  if (membership?.storyId !== source.storyId)
    throw new Error('Continuation Thread and source must belong to the same Story.')
  if (!sha(data.sourceHead)) throw new Error('Continuation source is not a validated SHA.')
  const prior = await tx.selectFrom('studioSessions').select('id')
    .where('id', '=', data.claim.id).executeTakeFirst()
  if (prior) throw new Error('Continuation was already registered; reconcile its saved job.')
  await tx.insertInto('studioSessions').values({
    id: data.claim.id, ownerUserId: data.owner, storyId: source.storyId,
    title: source.title + suffix, sourceCommitSha: data.sourceHead,
    status, createdAt: data.at, updatedAt: data.at,
    generationConfigJson: data.draftJson,
    ...(status === 'completed' ? {
      generationRequestJson: data.requestJson, generationThreadId: data.generationThread,
    } : {}),
  }).execute()
  await tx.insertInto('storyThreadRuns').values({
    jobId: data.claim.id, ownerUserId: data.owner,
    threadId: data.threadId, runOrder: data.claim.runOrder,
  }).execute()
}

async function finishReview(tx: Write, data: ContinuationRequest): Promise<void> {
  await tx.updateTable('threadSteeringIntents').set({ reviewState: 'approved-run' })
    .where('reviewMessageId', '=', data.claim.id).where('ownerUserId', '=', data.owner)
    .where('threadId', '=', data.threadId)
    .where('reviewState', '=', 'awaiting-review').execute()
}

/** This is a fresh, prepared child execution, not a queue retry. Queue
 * capacity is enforced by the shared scheduler when it claims the run. */
async function enqueuePrepared(tx: Write, data: ContinuationRequest): Promise<void> {
  const saved = await tx.selectFrom('studioSessions')
    .select(['status', 'generationRequestJson', 'generationThreadId'])
    .where('id', '=', data.claim.id).where('ownerUserId', '=', data.owner)
    .executeTakeFirst()
  const membership = await tx.selectFrom('storyThreadRuns')
    .innerJoin('storyThreads', join => join
      .onRef('storyThreads.id', '=', 'storyThreadRuns.threadId')
      .onRef('storyThreads.ownerUserId', '=', 'storyThreadRuns.ownerUserId'))
    .select('storyThreads.deletedAt')
    .where('storyThreadRuns.jobId', '=', data.claim.id)
    .where('storyThreadRuns.ownerUserId', '=', data.owner).executeTakeFirst()
  if (!membership || membership.deletedAt ||
      saved?.status !== 'paused' || saved.generationRequestJson !== null ||
      saved.generationThreadId !== null || !data.requestJson || !data.generationThread)
    throw new Error('Job state changed before scheduling. Inspect the saved generation.')
  const existing = await tx.selectFrom('generationRunQueue').select('jobId')
    .where('jobId', '=', data.claim.id).executeTakeFirst()
  if (existing) throw new Error('This continuation is already queued or executing.')
  const updated = await tx.updateTable('studioSessions').set({
    generationRequestJson: data.requestJson, generationThreadId: data.generationThread,
    updatedAt: data.at,
  }).where('id', '=', data.claim.id).where('ownerUserId', '=', data.owner)
    .where('status', '=', 'paused').where('generationRequestJson', 'is', null)
    .where('generationThreadId', 'is', null).executeTakeFirst()
  if (count(updated) !== 1) throw new Error('Job state changed before scheduling.')
  await tx.insertInto('generationRunQueue').values({
    jobId: data.claim.id, ownerUserId: data.owner, intent: 'start', phase: 'queued',
    createdAt: data.at, updatedAt: data.at,
  }).execute()
}

/** Single domain implementation for both database engines. External Git,
 * validator, and model calls stay outside replayable write transactions.
 * Steering, queue registration, review/approval, and message reconciliation
 * always use the caller's transaction handle. */
export function createKyselyContinuationPersistence(
  db: SharedDatabase<StudioDb>,
): ContinuationPersistence {
  return {
    current: (owner, threadId) => current(db.read, owner, threadId),
    pending: (owner, threadId) => pending(db.read, owner, threadId),

    async claim(owner, threadId): Promise<ContinuationAdmission | null> {
      requireOwner(owner)
      return db.withWriteTransaction([thread(threadId)], async tx => {
        await requireLive(tx, owner, threadId)
        const run = await current(tx, owner, threadId)
        if (!run || run.status !== 'completed' || run.queuePhase !== 'finished') return null
        const active = await tx.selectFrom('storyThreadMessages').select('id')
          .where('ownerUserId', '=', owner).where('threadId', '=', threadId)
          .where('role', '=', 'user').where('phase', 'in', ['preparing', 'running', 'blocked'])
          .executeTakeFirst()
        if (active) return null
        const next = await pending(tx, owner, threadId)
        if (!next?.scope) return null
        const result = await tx.updateTable('storyThreadMessages')
          .set({ phase: 'preparing', sourceJobId: run.jobId })
          .where('id', '=', next.id).where('ownerUserId', '=', owner)
          .where('threadId', '=', threadId).where('phase', '=', 'queued')
          .where(eb => eb.not(eb.exists(eb.selectFrom('storyThreadMessageCancellations as c')
            .select('c.messageId').whereRef('c.messageId', '=', 'storyThreadMessages.id'))))
          .executeTakeFirst()
        return count(result) === 1
          ? { id: next.id, content: next.content, scopeJson: next.scope,
            source: run.jobId, runOrder: run.runOrder + 1 }
          : null
      })
    },

    async protectedFinish(data, committedSha) {
      requireOwner(data.owner)
      if (!sha(committedSha)) throw new Error('Protected continuation lacks a verified commit.')
      await db.withWriteTransaction([thread(data.threadId), job(data.claim.source), job(data.claim.id)], async tx => {
        await verifyClaim(tx, data, 'Protected Thread changed during exact native revision.')
        await registerChild(tx, data, 'completed', ' (protected revision)')
        await tx.insertInto('generationRunQueue').values({
          jobId: data.claim.id, ownerUserId: data.owner, intent: 'start', phase: 'finished',
          createdAt: data.at, updatedAt: data.at,
        }).execute()
        const consumed = await consumeProtectedDecisionKysely(
          tx, data.owner, data.claim.id, committedSha, {
            threadId: data.threadId, sourceJobId: data.claim.source, sourceSha: data.sourceHead,
          })
        if (!consumed)
          throw new Error('Protected approval was already consumed or its commit identity changed.')
        await finishReview(tx, data)
        const finished = await tx.updateTable('storyThreadMessages').set({
          phase: 'finished', status: 'delivered', jobId: data.claim.id,
          verifiedCommitSha: committedSha,
        }).where('id', '=', data.claim.id).where('ownerUserId', '=', data.owner)
          .where('threadId', '=', data.threadId).where('phase', '=', 'preparing')
          .executeTakeFirst()
        if (count(finished) !== 1) throw new Error('Protected continuation was already finalized.')
        const assistantId = await insertThreadAssistantKysely(tx, data.owner, data.threadId, data.claim.id)
        await tx.updateTable('storyThreadMessages').set({ verifiedCommitSha: committedSha })
          .where('id', '=', assistantId).where('ownerUserId', '=', data.owner)
          .where('threadId', '=', data.threadId).execute()
        await tx.updateTable('storyThreads').set({ activityAt: data.at })
          .where('id', '=', data.threadId).where('ownerUserId', '=', data.owner).execute()
      })
    },

    async beginFollowUp(data) {
      requireOwner(data.owner)
      await db.withWriteTransaction([thread(data.threadId), job(data.claim.source), job(data.claim.id)], async tx => {
        await verifyClaim(tx, data, 'Thread admission changed during worktree preparation.')
        await registerChild(tx, data, 'paused', ' (follow-up)')
        await enqueuePrepared(tx, data)
        await finishReview(tx, data)
        const updated = await tx.updateTable('storyThreadMessages')
          .set({ phase: 'running', jobId: data.claim.id })
          .where('id', '=', data.claim.id).where('ownerUserId', '=', data.owner)
          .where('threadId', '=', data.threadId).where('phase', '=', 'preparing')
          .executeTakeFirst()
        if (count(updated) !== 1) throw new Error('Continuation admission changed; inspect the saved Thread.')
        await seedThreadMessagesKysely(tx, data.owner, data.threadId)
      })
    },

    async block(owner, threadId, claim, reason, at) {
      requireOwner(owner)
      await db.withWriteTransaction([thread(threadId), job(claim.source)], async tx => {
        await requireLive(tx, owner, threadId)
        const updated = await tx.updateTable('storyThreadMessages').set({ phase: 'blocked' })
          .where('id', '=', claim.id).where('ownerUserId', '=', owner)
          .where('threadId', '=', threadId).where('sourceJobId', '=', claim.source)
          .where('phase', '=', 'preparing').executeTakeFirst()
        if (count(updated) !== 1) {
          const row = await tx.selectFrom('storyThreadMessages').select('phase')
            .where('id', '=', claim.id).where('ownerUserId', '=', owner)
            .where('threadId', '=', threadId).where('sourceJobId', '=', claim.source)
            .executeTakeFirst()
          if (row?.phase === 'blocked') {
            const child = await tx.selectFrom('storyThreadRuns').select('jobId')
              .where('jobId', '=', claim.id).where('ownerUserId', '=', owner)
              .where('threadId', '=', threadId).executeTakeFirst()
            if (!child) return // Retry of the same failed preparation.
          }
          throw new Error('Continuation is no longer preparing; inspect the saved Thread.')
        }
        await tx.updateTable('threadSteeringIntents').set({ reviewState: 'unresolved' })
          .where('reviewMessageId', '=', claim.id).where('ownerUserId', '=', owner)
          .where('threadId', '=', threadId).where('reviewState', '=', 'awaiting-review').execute()
        await tx.insertInto('storyThreadMessages').values({
          id: 'assistant:' + claim.id, ownerUserId: owner, threadId,
          sequence: await nextThreadSequenceKysely(tx, threadId),
          role: 'assistant', status: 'delivered', body: reason,
          phase: 'blocked', createdAt: at,
        }).onConflict(oc => oc.doNothing()).execute()
      })
    },

    async settledRuns() {
      const rows = await db.read.selectFrom('storyThreadRuns as r')
        .innerJoin('generationRunQueue as q', join => join
          .onRef('q.jobId', '=', 'r.jobId').onRef('q.ownerUserId', '=', 'r.ownerUserId'))
        .innerJoin('storyThreadMessages as m', join => join
          .onRef('m.threadId', '=', 'r.threadId').onRef('m.ownerUserId', '=', 'r.ownerUserId'))
        .select(['r.jobId as jobId', 'r.ownerUserId as owner']).distinct()
        .where('q.phase', 'in', ['finished', 'interrupted'])
        .where(eb => eb.or([
          eb.and([eb('m.role', '=', 'user'), eb('m.phase', '=', 'running'),
            eb('m.jobId', '=', eb.ref('r.jobId'))]),
          eb.and([eb('m.role', '=', 'user'), eb('m.phase', '=', 'queued'),
            eb('r.runOrder', '=', sql<number>`(SELECT MAX(n.run_order) FROM story_thread_runs n
              WHERE n.thread_id="r"."thread_id" AND n.owner_user_id="r"."owner_user_id")`)]),
        ])).execute()
      return rows
    },

    async runThread(owner, jobId) {
      requireOwner(owner)
      return (await db.read.selectFrom('storyThreadRuns').select('threadId')
        .where('jobId', '=', jobId).where('ownerUserId', '=', owner)
        .executeTakeFirst())?.threadId ?? null
    },

    async settle(owner, jobId, verifiedCommit, at) {
      requireOwner(owner)
      if (verifiedCommit !== null && !sha(verifiedCommit))
        throw new Error('A verified Story commit must be a full Git SHA.')
      const member = await db.read.selectFrom('storyThreadRuns').select('threadId')
        .where('jobId', '=', jobId).where('ownerUserId', '=', owner).executeTakeFirst()
      if (!member) return null
      return db.withWriteTransaction([thread(member.threadId), job(jobId)], async tx => {
        const saved = await tx.selectFrom('storyThreadRuns as r')
          .innerJoin('studioSessions as s', join => join
            .onRef('s.id', '=', 'r.jobId').onRef('s.ownerUserId', '=', 'r.ownerUserId'))
          .select(['r.threadId as threadId', 's.status as status'])
          .where('r.jobId', '=', jobId).where('r.ownerUserId', '=', owner)
          .where('r.threadId', '=', member.threadId).executeTakeFirst()
        if (!saved) return null
        const phase = (await tx.selectFrom('generationRunQueue').select('phase')
          .where('jobId', '=', jobId).where('ownerUserId', '=', owner)
          .executeTakeFirst())?.phase
        if (phase !== 'finished' && phase !== 'interrupted') return null
        await deferUndeliveredSteeringKysely(tx, owner, jobId)
        await seedThreadMessagesKysely(tx, owner, saved.threadId)
        const verified = phase === 'finished' && verifiedCommit !== null
        const pausedForResume = phase === 'finished' && saved.status === 'paused'
        const updated = pausedForResume ? 0 : count(await tx.updateTable('storyThreadMessages')
          .set({ phase: verified ? 'finished' : 'blocked',
            ...(verified ? { status: 'delivered', verifiedCommitSha: verifiedCommit } : {}) })
          .where('ownerUserId', '=', owner).where('jobId', '=', jobId)
          .where('role', '=', 'user').where('phase', '=', 'running')
          .executeTakeFirst())
        if (phase === 'finished' && !verified && updated > 0)
          await tx.updateTable('studioSessions').set({ status: 'blocked', updatedAt: at })
            .where('id', '=', jobId).where('ownerUserId', '=', owner)
            .where('status', '=', 'completed').execute()
        if (verified && verifiedCommit) {
          await tx.updateTable('storyThreadMessages').set({
            phase: 'finished', status: 'delivered', verifiedCommitSha: verifiedCommit,
          }).where('ownerUserId', '=', owner).where('threadId', '=', saved.threadId)
            .where('role', '=', 'user').where('phase', '=', 'blocked')
            .where('id', 'in', eb => eb.selectFrom('storyTurnExecutions')
              .select('turnId').where('jobId', '=', jobId)
              .where('ownerUserId', '=', owner).where('threadId', '=', saved.threadId))
            .execute()
          await boundarySteeringReviewsKysely(tx, owner, jobId, saved.threadId, verifiedCommit, at)
        }
        const assistantId = await insertThreadAssistantKysely(tx, owner, saved.threadId, jobId)
        if (verified)
          await tx.updateTable('storyThreadMessages').set({ verifiedCommitSha: verifiedCommit })
            .where('id', '=', assistantId).where('ownerUserId', '=', owner)
            .where('threadId', '=', saved.threadId).execute()
        await tx.updateTable('storyThreads').set({ activityAt: at })
          .where('id', '=', saved.threadId).where('ownerUserId', '=', owner).execute()
        return saved.threadId
      })
    },
  }
}
