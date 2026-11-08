import { createHash } from 'node:crypto'
import { and, asc, desc, eq, isNotNull, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema'
import {
  checkpointForks, generationEvents, generationRunQueue, sessions, storyThreadMessageCancellations,
  storyThreadMessages, storyThreadRuns, storyThreads, storyTurns, storyTurnExecutions, threadActivePiTurns, threadLiveEffectReviews,
  threadLiveInputs, threadProtectedDecisions, threadQueuedMessageEdits,
} from '../db/schema'
import type { ThreadMessage } from '../lib/thread-chat.server'
import { ThreadMessageConflict, type ChatRun, type ThreadMessagePersistence,
  type TurnReceipt } from './thread-message-contracts'

type Db = BetterSQLite3Database<typeof schema>
const m = storyThreadMessages
const ownerRequired = (owner: string): void => {
  if (!owner) throw new ThreadMessageConflict(401, 'Authenticated actor required.')
}

/** These SQLite-only synchronous helpers are used by the advanced Thread
 * transaction paths until their separate persistence migration. No network IO
 * occurs inside a SQLite transaction; the public port is async-compatible. */
export function nextThreadSequenceSqlite(db: Db, threadId: string): number {
  return db.select({ next: sql<number>`COALESCE(MAX(${m.sequence}), -1) + 1` })
    .from(m).where(eq(m.threadId, threadId)).get()!.next
}

function membership(db: Db, owner: string, threadId: string) {
  ownerRequired(owner)
  const row = db.select({
    id: storyThreads.id,
    archivedAt: sql<string | null>`COALESCE(${storyThreads.deletedAt}, ${storyThreads.archivedAt})`,
    storyId: storyThreads.storyId,
  }).from(storyThreads).where(and(eq(storyThreads.id, threadId), eq(storyThreads.ownerUserId, owner))).get()
  if (!row) throw new ThreadMessageConflict(404, 'Thread not found.')
  return row
}

export function currentThreadRunSqlite(db: Db, owner: string, threadId: string): ChatRun | undefined {
  return db.select({
    jobId: storyThreadRuns.jobId, status: sessions.status, runOrder: storyThreadRuns.runOrder,
    queuePhase: generationRunQueue.phase,
  }).from(storyThreadRuns)
    .innerJoin(sessions, and(eq(sessions.id, storyThreadRuns.jobId),
      eq(sessions.ownerUserId, storyThreadRuns.ownerUserId)))
    .leftJoin(generationRunQueue, and(eq(generationRunQueue.jobId, storyThreadRuns.jobId),
      eq(generationRunQueue.ownerUserId, storyThreadRuns.ownerUserId)))
    .where(and(eq(storyThreadRuns.threadId, threadId), eq(storyThreadRuns.ownerUserId, owner)))
    .orderBy(desc(storyThreadRuns.runOrder)).limit(1).get()
}

const messageFields = {
  sequence: m.sequence, id: m.id, role: m.role, status: m.status, content: m.body,
  queuePriority: sql<number>`COALESCE((SELECT original.sequence FROM thread_steering_intents intent
    JOIN story_thread_messages original ON original.id=intent.message_id
    WHERE intent.review_message_id=${m.id}), ${m.sequence})`,
  hasRevisionScope: sql<number>`CASE WHEN ${m.revisionScopeJson} IS NULL THEN 0 ELSE 1 END`,
  cancelledAt: storyThreadMessageCancellations.cancelledAt,
  phase: sql<ThreadMessage['phase']>`CASE
    WHEN ${storyThreadMessageCancellations.messageId} IS NOT NULL THEN 'cancelled'
    ELSE COALESCE(${m.phase}, CASE ${m.status} WHEN 'queued' THEN 'queued' ELSE 'finished' END)
    END`,
  jobId: m.jobId, createdAt: m.createdAt,
  liveMode: threadLiveInputs.mode, liveState: threadLiveInputs.state,
  effectVerifiedAt: threadLiveEffectReviews.verifiedAt,
  effectReviewer: threadLiveEffectReviews.reviewer,
  effectEvidence: threadLiveEffectReviews.evidence,
  effectCommitSha: threadLiveEffectReviews.commitSha,
  liveSourceJobId: threadLiveInputs.sourceJobId,
  livePiSessionId: threadLiveInputs.piSessionId,
  liveWorkItem: threadLiveInputs.targetWorkItem,
  liveDeliveredAt: threadLiveInputs.deliveredAt,
  editCount: sql<number>`(SELECT COUNT(*) FROM thread_queued_message_edits e WHERE e.message_id=${m.id})`,
}
function messagesQuery(db: Db) {
  return db.select(messageFields).from(m)
    .leftJoin(storyThreadMessageCancellations, eq(storyThreadMessageCancellations.messageId, m.id))
    .leftJoin(threadLiveInputs, eq(threadLiveInputs.messageId, m.id))
    .leftJoin(threadLiveEffectReviews, eq(threadLiveEffectReviews.messageId, m.id))
}
function messageById(db: Db, id: string): ThreadMessage | undefined {
  return messagesQuery(db).where(eq(m.id, id)).get()
}
function ownedMessage(db: Db, owner: string, threadId: string, id: string): ThreadMessage | undefined {
  return messagesQuery(db).where(and(eq(m.id, id), eq(m.ownerUserId, owner),
    eq(m.threadId, threadId))).get()
}

export function ownedThreadMessageSqlite(db: Db, owner: string, threadId: string, id: string): ThreadMessage | undefined {
  return ownedMessage(db, owner, threadId, id)
}

function summary(db: Db, owner: string, jobId: string): string {
  const run = db.select({
    status: sessions.status, requestJson: sessions.generationRequestJson,
    queuePhase: generationRunQueue.phase,
  }).from(sessions).leftJoin(generationRunQueue, and(
    eq(generationRunQueue.jobId, sessions.id), eq(generationRunQueue.ownerUserId, sessions.ownerUserId),
  )).where(and(eq(sessions.id, jobId), eq(sessions.ownerUserId, owner))).get()
  if (!run) return 'The run is unavailable. Inspect its saved job.'
  const protectedApproval = db.select({ id: threadProtectedDecisions.messageId })
    .from(threadProtectedDecisions).where(and(
      eq(threadProtectedDecisions.messageId, jobId),
      eq(threadProtectedDecisions.ownerUserId, owner),
      eq(threadProtectedDecisions.decision, 'approved'),
      isNotNull(threadProtectedDecisions.consumedSha),
    )).get()
  if (protectedApproval)
    return 'The author-approved protected Creative Decision was changed in an isolated Thread and committed through verified native revision and trusted approval receipts.'
  const fixture = (() => {
    try { return (JSON.parse(run.requestJson ?? '{}') as { fixture?: boolean }).fixture === true }
    catch { return true }
  })()
  if (run.queuePhase === 'interrupted' || run.status === 'running')
    return 'The run was interrupted. Inspect the preserved worktree and receipts; do not automatically replay the writer.'
  const unverified = db.select({ id: m.id }).from(m).where(and(
    eq(m.ownerUserId, owner), eq(m.jobId, jobId), eq(m.role, 'user'),
    eq(m.phase, 'blocked'),
  )).limit(1).get()
  if (unverified)
    return 'The execution ended without a verified final Story revision. Its worktree and checkpoints require reconciliation; no writer was replayed.'
  if (run.status === 'completed')
    return fixture
      ? 'Fixture execution finished. Its output is not independently validated editorial completion.'
      : 'Generation run finished. Review the committed Story and validation evidence before editorial acceptance.'
  if (run.status === 'paused') return 'Generation paused. Open the run to inspect the required action or resume.'
  if (run.status === 'cancelled') return 'Generation cancelled. Saved files and receipts remain available for inspection.'
  return 'Generation blocked. Open the run for the saved error, evidence and recovery options.'
}

/** Assistant settlement is immutable; changing a run outcome appends a new ID
 * derived from the controller event rather than rewriting a prior summary. */
export function insertThreadAssistantSqlite(db: Db, owner: string, threadId: string, jobId: string): string {
  const content = summary(db, owner, jobId)
  const latest = db.select({ id: m.id, body: m.body }).from(m).where(and(
    eq(m.ownerUserId, owner), eq(m.threadId, threadId), eq(m.role, 'assistant'),
    eq(m.jobId, jobId),
  )).orderBy(desc(m.sequence)).limit(1).get()
  if (latest?.body === content) return latest.id
  const event = db.select({ id: generationEvents.id }).from(generationEvents).where(and(
    eq(generationEvents.ownerUserId, owner), eq(generationEvents.jobId, jobId),
    sql`${generationEvents.kind} IN ('finished','interrupted')`,
  )).orderBy(desc(generationEvents.id)).limit(1).get()
  const signature = createHash('sha256').update(content).digest('hex').slice(0, 12)
  const id = latest ? `assistant:${jobId}:${event?.id ?? 'settlement'}:${signature}`
    : 'assistant:' + jobId
  db.insert(m).values({
    id, ownerUserId: owner, threadId, sequence: nextThreadSequenceSqlite(db, threadId),
    role: 'assistant', status: 'delivered', body: content, phase: 'finished',
    jobId, createdAt: new Date().toISOString(),
  }).onConflictDoNothing().run()
  return id
}

/** A checkpoint continuation is a new execution of the existing Thread, not
 * a new author request. Its task includes the original task plus existing
 * guidance, but must not be synthesized as another chat message. */
function sameThreadRecoveryJobsSqlite(db: Db, owner: string, threadId: string): Set<string> {
  return new Set(db.select({ childId: checkpointForks.childId }).from(checkpointForks)
    .where(and(eq(checkpointForks.ownerUserId, owner),
      eq(checkpointForks.sourceThreadId, threadId)))
    .all().map(row => row.childId))
}

/** Persist initial admitted requests atomically, preserving execution identities.
 * Also idempotently reconcile fixture/prepared runs when reading Chat. */
export function seedThreadMessagesSqlite(db: Db, owner: string, threadId: string, includeSummaries = true): void {
  const recoveryJobs = sameThreadRecoveryJobsSqlite(db, owner, threadId)
  const runs = db.select({
    jobId: storyThreadRuns.jobId, requestJson: sessions.generationRequestJson,
    status: sessions.status, queuePhase: generationRunQueue.phase,
    runOrder: storyThreadRuns.runOrder, sourceSha: sessions.sourceCommitSha,
    createdAt: sessions.createdAt,
  }).from(storyThreadRuns)
    .innerJoin(sessions, and(eq(sessions.id, storyThreadRuns.jobId),
      eq(sessions.ownerUserId, storyThreadRuns.ownerUserId)))
    .leftJoin(generationRunQueue, and(eq(generationRunQueue.jobId, sessions.id),
      eq(generationRunQueue.ownerUserId, sessions.ownerUserId)))
    .where(and(eq(storyThreadRuns.threadId, threadId), eq(storyThreadRuns.ownerUserId, owner)))
    .orderBy(asc(storyThreadRuns.runOrder)).all()
  for (const run of runs) {
    if (run.requestJson && !recoveryJobs.has(run.jobId)) {
      let task: unknown
      try { task = (JSON.parse(run.requestJson) as { task?: unknown }).task } catch { /* legacy corrupt request */ }
      if (typeof task === 'string' && task.trim()) {
        const existing = db.select({ id: m.id }).from(m).where(and(
          eq(m.ownerUserId, owner), eq(m.threadId, threadId), eq(m.role, 'user'),
          sql`(${m.jobId} = ${run.jobId} OR (${run.runOrder} = 0 AND ${m.jobId} IS NULL))`,
        )).limit(1).get()
        if (!existing) db.insert(m).values({
          id: 'initial:' + run.jobId, ownerUserId: owner, threadId,
          sequence: nextThreadSequenceSqlite(db, threadId), role: 'user',
          status: 'delivered', body: task, phase: 'finished', jobId: run.jobId,
          verifiedCommitSha: run.sourceSha, createdAt: run.createdAt,
        }).onConflictDoNothing().run()
      }
    }
    // Queue terminalization may precede durable chat settlement. Do not
    // fabricate an assistant completion while its author Turn is still running.
    const unsettled = db.select({ id: m.id }).from(m).where(and(
      eq(m.ownerUserId, owner), eq(m.jobId, run.jobId),
      eq(m.role, 'user'), eq(m.phase, 'running'),
    )).limit(1).get()
    if (includeSummaries && !unsettled && run.queuePhase === 'finished' &&
        ['completed', 'paused', 'blocked', 'cancelled'].includes(run.status))
      insertThreadAssistantSqlite(db, owner, threadId, run.jobId)
  }
}

export function createSqliteThreadMessages(db: Db): ThreadMessagePersistence {
  return {
    async owned(owner, threadId, id) {
      ownerRequired(owner)
      return ownedMessage(db, owner, threadId, id) ?? null
    },
    async markAdmitted(owner, jobId) {
      ownerRequired(owner)
      // Never mark guidance or an edited instruction as delivered until the
      // generation request has actually been admitted to the durable queue.
      db.transaction(tx => {
        const admitted = tx.select({ id: generationRunQueue.jobId }).from(generationRunQueue)
          .where(and(eq(generationRunQueue.ownerUserId, owner),
            eq(generationRunQueue.jobId, jobId))).get()
        if (!admitted) throw new ThreadMessageConflict(409, 'Generation was not admitted.')
        tx.update(m).set({ status: 'delivered', phase: 'running', jobId }).where(and(
          eq(m.id, 'guidance:fork:' + jobId), eq(m.ownerUserId, owner), eq(m.status, 'queued'),
        )).run()
        tx.update(m).set({ status: 'delivered', phase: 'running' }).where(and(
          eq(m.id, 'edit:' + jobId), eq(m.ownerUserId, owner),
          eq(m.status, 'queued'), eq(m.jobId, jobId),
        )).run()
      }, { behavior: 'immediate' })
    },
    async membership(owner, threadId) {
      const row = membership(db, owner, threadId)
      return { storyId: row.storyId, archivedAt: row.archivedAt }
    },
    async read(owner, threadId) {
      membership(db, owner, threadId)
      // A read of older jobs is a one-time reconciliation; keep this and
      // subsequent reads idempotent across concurrent requests.
      db.transaction(() => seedThreadMessagesSqlite(db, owner, threadId))
      const recoveryJobs = sameThreadRecoveryJobsSqlite(db, owner, threadId)
      const messages = (messagesQuery(db)
        .where(and(eq(m.ownerUserId, owner), eq(m.threadId, threadId)))
        .orderBy(asc(m.sequence)).all() as ThreadMessage[])
        .filter(message => !(message.role === 'user' && message.jobId &&
          message.id === 'initial:' + message.jobId && recoveryJobs.has(message.jobId)))
      // Old versions may already have written synthetic "initial:" receipts.
      // Preserve those durable records for audit but omit them from chat;
      // recovery is never a second user instruction.
      const edits = db.select({
        messageId: threadQueuedMessageEdits.messageId, old: threadQueuedMessageEdits.oldBody,
        replacement: threadQueuedMessageEdits.newBody, editedAt: threadQueuedMessageEdits.editedAt,
      }).from(threadQueuedMessageEdits).where(and(
        eq(threadQueuedMessageEdits.ownerUserId, owner), eq(threadQueuedMessageEdits.threadId, threadId),
      )).orderBy(sql`rowid`).all()
      const editHistory = new Map<string, Array<{ old: string; replacement: string; editedAt: string }>>()
      for (const { messageId, ...edit } of edits)
        editHistory.set(messageId, [...(editHistory.get(messageId) ?? []), edit])
      for (const item of messages) item.editHistory = editHistory.get(item.id) ?? []
      const runs = db.select({
        jobId: storyThreadRuns.jobId, runOrder: storyThreadRuns.runOrder,
        status: sessions.status, queuePhase: generationRunQueue.phase,
        requestJson: sessions.generationRequestJson,
      }).from(storyThreadRuns)
        .innerJoin(sessions, and(eq(sessions.id, storyThreadRuns.jobId),
          eq(sessions.ownerUserId, storyThreadRuns.ownerUserId)))
        .leftJoin(generationRunQueue, and(eq(generationRunQueue.jobId, sessions.id),
          eq(generationRunQueue.ownerUserId, sessions.ownerUserId)))
        .where(and(eq(storyThreadRuns.ownerUserId, owner), eq(storyThreadRuns.threadId, threadId)))
        .orderBy(asc(storyThreadRuns.runOrder)).all()
      const evidence = db.select({
        jobId: generationEvents.jobId, kind: generationEvents.kind,
        stage: generationEvents.stage, milestone: generationEvents.milestone,
        filesJson: generationEvents.filesJson, status: generationEvents.status,
        createdAt: generationEvents.createdAt,
      }).from(generationEvents).innerJoin(storyThreadRuns, and(
        eq(storyThreadRuns.jobId, generationEvents.jobId),
        eq(storyThreadRuns.ownerUserId, generationEvents.ownerUserId),
      )).where(and(eq(storyThreadRuns.threadId, threadId),
        eq(storyThreadRuns.ownerUserId, owner),
        sql`${generationEvents.kind} IN ('verified','finished','interrupted')`))
        .orderBy(asc(generationEvents.id)).all()
      const turnRows = db.select({
        id: storyTurns.id, jobId: storyTurnExecutions.jobId,
        inputSha: sessions.sourceCommitSha, status: sessions.status,
        queuePhase: generationRunQueue.phase,
        // Only a controller-settled assistant receipt proves a completed
        // deterministic boundary. Queue state and a source SHA alone do not.
        validatedSha: sql<string | null>`(SELECT proof.verified_commit_sha
          FROM story_thread_messages proof
          WHERE proof.owner_user_id=${storyTurns.ownerUserId}
            AND proof.thread_id=${storyTurns.threadId}
            AND proof.job_id=${storyTurnExecutions.jobId}
            AND proof.role='assistant' AND proof.verified_commit_sha IS NOT NULL
          ORDER BY proof.sequence DESC LIMIT 1)`,
      }).from(storyTurns).innerJoin(m, eq(m.id, storyTurns.id))
        .leftJoin(storyTurnExecutions, eq(storyTurnExecutions.turnId, storyTurns.id))
        .leftJoin(storyThreadRuns, and(eq(storyThreadRuns.jobId, storyTurnExecutions.jobId),
          eq(storyThreadRuns.ownerUserId, owner)))
        .leftJoin(sessions, and(eq(sessions.id, storyTurnExecutions.jobId),
          eq(sessions.ownerUserId, owner)))
        .leftJoin(generationRunQueue, and(eq(generationRunQueue.jobId, storyTurnExecutions.jobId),
          eq(generationRunQueue.ownerUserId, owner)))
        .where(and(eq(storyTurns.ownerUserId, owner), eq(storyTurns.threadId, threadId)))
        .orderBy(m.sequence, storyThreadRuns.runOrder).all()
      const turns: Array<{ id: string; executionIds: string[] }> = []
      const turnReceipts: TurnReceipt[] = []
      const messagesById = new Map(messages.map(message => [message.id, message]))
      for (const row of turnRows) {
        let turn = turns.at(-1), receipt = turnReceipts.at(-1)
        if (turn?.id !== row.id) {
          turn = { id: row.id, executionIds: [] }; turns.push(turn)
          const original = messagesById.get(row.id)
          if (!original) throw new Error('Turn has no persisted author request.')
          receipt = { id: row.id, request: original.editHistory?.[0]?.old ?? original.content,
            effectiveRequest: original.content, outcome: original.phase,
            inputSha: null, executions: [] }
          turnReceipts.push(receipt)
        }
        if (row.jobId && row.inputSha && row.status) {
          turn!.executionIds.push(row.jobId)
          receipt!.inputSha ??= row.inputSha
          receipt!.executions.push({ jobId: row.jobId, inputSha: row.inputSha,
            status: row.status, queuePhase: row.queuePhase, validatedSha: row.validatedSha })
        }
      }
      return { messages, runs, evidence, turns, turnReceipts }
    },
    async enqueue(owner, threadId, id, body, mode, at) {
      ownerRequired(owner)
      return db.transaction(() => {
        const member = membership(db, owner, threadId)
        seedThreadMessagesSqlite(db, owner, threadId)
        if (member.archivedAt) throw new ThreadMessageConflict(409, 'Restore the archived Thread before sending.')
        const existing = messageById(db, id)
        if (existing) {
          const edit = db.select({ body: threadQueuedMessageEdits.oldBody })
            .from(threadQueuedMessageEdits).where(eq(threadQueuedMessageEdits.messageId, id))
            .orderBy(sql`rowid`).limit(1).get()
          if (existing.role !== 'user' ||
              existing.content !== body && edit?.body !== body ||
              mode !== undefined && existing.liveMode !== mode ||
              !ownedMessage(db, owner, threadId, id))
            throw new ThreadMessageConflict(409, 'Message ID is already in use.')
          return existing
        }
        if (db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, id)).get())
          throw new ThreadMessageConflict(409, 'Message ID is already assigned to a job.')
        const run = currentThreadRunSqlite(db, owner, threadId)
        if (!run) throw new ThreadMessageConflict(409, 'Create a generation run for this Thread before sending follow-ups.')
        // A terminal blocked/paused run has no verified continuation source.
        // Reject at this serialized admission boundary rather than storing an
        // instruction that the controller can never dispatch.
        // The special pre-start fork guidance is not a chat follow-up. It is
        // recorded before its first queue admission and has a controller-owned
        // stable ID; public chat submissions require UUIDs instead.
        const initialGuidance = id === 'guidance:fork:' + run.jobId &&
          run.status === 'paused' && !mode
        if (!initialGuidance && (run.queuePhase === 'interrupted' ||
            ['blocked', 'paused', 'cancelled'].includes(run.status)))
          throw new ThreadMessageConflict(409,
            'This Thread cannot accept follow-ups while generation is stopped. Review its saved decision or recovery checkpoint.')
        if (mode && (run.status !== 'running' || run.queuePhase !== 'running'))
          throw new ThreadMessageConflict(409, 'Steer or Follow up is available only while a generation run is active.')
        db.insert(m).values({
          id, ownerUserId: owner, threadId, sequence: nextThreadSequenceSqlite(db, threadId),
          role: 'user', status: 'queued', body, phase: 'queued', createdAt: at,
        }).run()
        if (mode) {
          const target = db.select({
            token: threadActivePiTurns.piToken, workItem: threadActivePiTurns.workItem,
            expectedHead: threadActivePiTurns.expectedHead,
          }).from(threadActivePiTurns).innerJoin(generationRunQueue, and(
            eq(generationRunQueue.jobId, threadActivePiTurns.jobId),
            eq(generationRunQueue.ownerUserId, owner), eq(generationRunQueue.phase, 'running'),
          )).where(eq(threadActivePiTurns.jobId, run.jobId)).get()
          db.insert(threadLiveInputs).values({
            messageId: id, ownerUserId: owner, threadId, sourceJobId: run.jobId, mode,
            state: target ? 'pending' : 'deferred', createdAt: at,
            targetPiToken: target?.token ?? null, targetWorkItem: target?.workItem ?? null,
            submittedHead: target?.expectedHead ?? null,
          }).run()
        }
        db.update(storyThreads).set({ activityAt: at }).where(and(
          eq(storyThreads.id, threadId), eq(storyThreads.ownerUserId, owner),
        )).run()
        return ownedMessage(db, owner, threadId, id)!
      })
    },
    async edit(owner, threadId, id, requestId, expected, replacement, at) {
      ownerRequired(owner)
      return db.transaction(() => {
        membership(db, owner, threadId)
        const prior = db.select({
          messageId: threadQueuedMessageEdits.messageId,
          owner: threadQueuedMessageEdits.ownerUserId,
          threadId: threadQueuedMessageEdits.threadId,
          oldBody: threadQueuedMessageEdits.oldBody,
          newBody: threadQueuedMessageEdits.newBody,
        }).from(threadQueuedMessageEdits).where(eq(threadQueuedMessageEdits.requestId, requestId)).get()
        if (prior) {
          if (prior.messageId !== id || prior.owner !== owner || prior.threadId !== threadId ||
              prior.oldBody !== expected || prior.newBody !== replacement)
            throw new ThreadMessageConflict(409, 'Edit request ID is already in use.')
          return ownedMessage(db, owner, threadId, id)!
        }
        const message = ownedMessage(db, owner, threadId, id)
        if (!message) throw new ThreadMessageConflict(404, 'Queued Thread instruction not found.')
        const raw = db.select({ sourceJobId: m.sourceJobId }).from(m).where(eq(m.id, id)).get()
        const approval = db.select({ id: threadProtectedDecisions.messageId })
          .from(threadProtectedDecisions).where(eq(threadProtectedDecisions.messageId, id)).get()
        if (message.role !== 'user' || message.phase !== 'queued' || message.jobId !== null ||
            ['dispatching', 'sdk-queued', 'delivered', 'blocked'].includes(message.liveState ?? '') ||
            raw?.sourceJobId || approval)
          throw new ThreadMessageConflict(409, 'This instruction is already admitted or approved and cannot be edited.')
        if (message.content !== expected || message.content === replacement)
          throw new ThreadMessageConflict(409, 'Queued message changed. Refresh the Thread before editing.')
        db.insert(threadQueuedMessageEdits).values({
          requestId, messageId: id, ownerUserId: owner, threadId,
          oldBody: expected, newBody: replacement, editedAt: at,
        }).run()
        db.update(m).set({ body: replacement, revisionScopeJson: null })
          .where(and(eq(m.id, id), eq(m.ownerUserId, owner), eq(m.threadId, threadId),
            eq(m.phase, 'queued'))).run()
        db.update(storyThreads).set({ activityAt: at }).where(and(
          eq(storyThreads.id, threadId), eq(storyThreads.ownerUserId, owner),
        )).run()
        return ownedMessage(db, owner, threadId, id)!
      })
    },
    async cancel(owner, threadId, id, at) {
      ownerRequired(owner)
      return db.transaction(() => {
        membership(db, owner, threadId)
        const message = ownedMessage(db, owner, threadId, id)
        if (!message) throw new ThreadMessageConflict(404, 'Queued Thread instruction not found.')
        if (message.role !== 'user') throw new ThreadMessageConflict(409, 'Only author instructions can be cancelled.')
        if (message.phase === 'cancelled') return message
        const raw = db.select({ sourceJobId: m.sourceJobId }).from(m).where(eq(m.id, id)).get()
        if (message.phase !== 'queued' || message.jobId !== null ||
            ['dispatching', 'sdk-queued', 'delivered'].includes(message.liveState ?? '') ||
            raw?.sourceJobId)
          throw new ThreadMessageConflict(409, 'The instruction has entered execution and cannot be cancelled.')
        db.insert(storyThreadMessageCancellations).values({
          messageId: id, ownerUserId: owner, threadId, cancelledAt: at,
        }).run()
        db.update(storyThreads).set({ activityAt: at }).where(and(
          eq(storyThreads.id, threadId), eq(storyThreads.ownerUserId, owner),
        )).run()
        return ownedMessage(db, owner, threadId, id)!
      })
    },
  }
}
