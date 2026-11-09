import { createHash } from 'node:crypto'
import { sql, type Transaction } from 'kysely'
import type { QueryExecutor, SharedDatabase } from '../db/kysely-connection'
import type { StudioDb } from '../db/studio-db'
import { studioSafeInteger } from '../db/kysely-values'
import type { ThreadMessage } from '../lib/thread-chat.server'
import { creativePolicy, parseCreativePolicy, type CreativeMode } from '../../../src/creative-policy'
import {
  ThreadMessageConflict, type ChatRun, type ThreadMessagePersistence, type TurnReceipt,
} from './thread-message-contracts'

type Read = QueryExecutor<StudioDb>
type Write = Transaction<StudioDb>
type Executor = Read | Write

const required = (owner: string): void => {
  if (!owner) throw new ThreadMessageConflict(401, 'Authenticated actor required.')
}

/** The caller must hold the shared Thread write guard before allocating a
 * sequence. The unique (thread_id, sequence) index is the final backstop. */
async function nextSequence(tx: Write, threadId: string): Promise<number> {
  const row = await tx.selectFrom('storyThreadMessages')
    .select(sql<number>`COALESCE(MAX("sequence"), -1) + 1`.as('next'))
    .where('threadId', '=', threadId).executeTakeFirstOrThrow()
  return studioSafeInteger(row.next)
}

async function membership(db: Executor, owner: string, threadId: string) {
  required(owner)
  const row = await db.selectFrom('storyThreads')
    .select([
      'id', 'storyId', 'creativePolicyJson',
      sql<string | null>`COALESCE("deleted_at", "archived_at")`.as('archivedAt'),
    ])
    .where('id', '=', threadId).where('ownerUserId', '=', owner)
    .executeTakeFirst()
  if (!row) throw new ThreadMessageConflict(404, 'Thread not found.')
  return row
}

async function currentRun(db: Executor, owner: string, threadId: string): Promise<ChatRun | undefined> {
  const row = await db.selectFrom('storyThreadRuns')
    .innerJoin('studioSessions', join => join
      .onRef('studioSessions.id', '=', 'storyThreadRuns.jobId')
      .onRef('studioSessions.ownerUserId', '=', 'storyThreadRuns.ownerUserId'))
    .leftJoin('generationRunQueue', join => join
      .onRef('generationRunQueue.jobId', '=', 'storyThreadRuns.jobId')
      .onRef('generationRunQueue.ownerUserId', '=', 'storyThreadRuns.ownerUserId'))
    .select([
      'storyThreadRuns.jobId', 'storyThreadRuns.runOrder',
      'studioSessions.status', 'generationRunQueue.phase as queuePhase',
    ])
    .where('storyThreadRuns.threadId', '=', threadId)
    .where('storyThreadRuns.ownerUserId', '=', owner)
    .orderBy('storyThreadRuns.runOrder', 'desc')
    .executeTakeFirst()
  return row
}

/** Every message projection is owned by this one query; never reconstruct
 * Chat state from a second driver or perform a write on the read executor. */
function messagesQuery(db: Executor) {
  return db.selectFrom('storyThreadMessages')
    .leftJoin('storyThreadMessageCancellations', 'storyThreadMessageCancellations.messageId',
      'storyThreadMessages.id')
    .leftJoin('threadLiveInputs', 'threadLiveInputs.messageId', 'storyThreadMessages.id')
    .leftJoin('threadLiveEffectReviews', 'threadLiveEffectReviews.messageId', 'storyThreadMessages.id')
    .select([
      'storyThreadMessages.sequence as sequence',
      'storyThreadMessages.id as id', 'storyThreadMessages.role as role',
      'storyThreadMessages.status as status', 'storyThreadMessages.body as content',
      'storyThreadMessages.creativePolicyJson as creativePolicyJson',
      'storyThreadMessages.creativeModeOverride as creativeModeOverride',
      sql<number>`COALESCE((SELECT original.sequence FROM thread_steering_intents intent
        JOIN story_thread_messages original ON original.id=intent.message_id
        WHERE intent.review_message_id="story_thread_messages"."id"),
        "story_thread_messages"."sequence")`.as('queuePriority'),
      sql<number>`CASE WHEN "story_thread_messages"."revision_scope_json" IS NULL
        THEN 0 ELSE 1 END`.as('hasRevisionScope'),
      'storyThreadMessageCancellations.cancelledAt as cancelledAt',
      sql<ThreadMessage['phase']>`CASE
        WHEN "story_thread_message_cancellations"."message_id" IS NOT NULL THEN 'cancelled'
        ELSE COALESCE("story_thread_messages"."phase",
          CASE "story_thread_messages"."status" WHEN 'queued' THEN 'queued'
            ELSE 'finished' END) END`.as('phase'),
      'storyThreadMessages.jobId as jobId', 'storyThreadMessages.createdAt as createdAt',
      'threadLiveInputs.mode as liveMode', 'threadLiveInputs.state as liveState',
      'threadLiveEffectReviews.verifiedAt as effectVerifiedAt',
      'threadLiveEffectReviews.reviewer as effectReviewer',
      'threadLiveEffectReviews.evidence as effectEvidence',
      'threadLiveEffectReviews.commitSha as effectCommitSha',
      'threadLiveInputs.sourceJobId as liveSourceJobId',
      'threadLiveInputs.piSessionId as livePiSessionId',
      'threadLiveInputs.targetWorkItem as liveWorkItem',
      'threadLiveInputs.deliveredAt as liveDeliveredAt',
      sql<number>`(SELECT COUNT(*) FROM thread_queued_message_edits edits
        WHERE edits.message_id="story_thread_messages"."id")`.as('editCount'),
    ])
}

type MessageRow = Awaited<ReturnType<ReturnType<typeof messagesQuery>['executeTakeFirst']>>
function asMessage(row: NonNullable<MessageRow>): ThreadMessage {
  return {
    ...row,
    role: row.role as ThreadMessage['role'],
    status: row.status as ThreadMessage['status'],
    liveMode: row.liveMode as ThreadMessage['liveMode'],
    liveState: row.liveState as ThreadMessage['liveState'],
    creativeModeOverride: row.creativeModeOverride as CreativeMode | null,
    sequence: studioSafeInteger(row.sequence),
    queuePriority: studioSafeInteger(row.queuePriority),
    hasRevisionScope: studioSafeInteger(row.hasRevisionScope),
    editCount: studioSafeInteger(row.editCount),
  }
}
async function ownedMessage(db: Executor, owner: string, threadId: string, id: string) {
  const row = await messagesQuery(db).where('storyThreadMessages.id', '=', id)
    .where('storyThreadMessages.ownerUserId', '=', owner)
    .where('storyThreadMessages.threadId', '=', threadId)
    .executeTakeFirst()
  return row ? asMessage(row) : null
}

async function jobSummary(db: Executor, owner: string, jobId: string): Promise<string> {
  const run = await db.selectFrom('studioSessions')
    .leftJoin('generationRunQueue', join => join
      .onRef('generationRunQueue.jobId', '=', 'studioSessions.id')
      .onRef('generationRunQueue.ownerUserId', '=', 'studioSessions.ownerUserId'))
    .select([
      'studioSessions.status', 'studioSessions.generationRequestJson as requestJson',
      'generationRunQueue.phase as queuePhase',
    ])
    .where('studioSessions.id', '=', jobId).where('studioSessions.ownerUserId', '=', owner)
    .executeTakeFirst()
  if (!run) return 'The run is unavailable. Inspect its saved job.'
  const approval = await db.selectFrom('threadProtectedDecisions')
    .select('messageId').where('messageId', '=', jobId)
    .where('ownerUserId', '=', owner).where('decision', '=', 'approved')
    .where('consumedSha', 'is not', null).executeTakeFirst()
  if (approval)
    return 'The author-approved protected Creative Decision was changed in an isolated Thread and committed through verified native revision and trusted approval receipts.'
  const fixture = (() => {
    try { return (JSON.parse(run.requestJson ?? '{}') as { fixture?: boolean }).fixture === true }
    catch { return true }
  })()
  if (run.queuePhase === 'interrupted' || run.status === 'running')
    return 'The run was interrupted. Inspect the preserved worktree and receipts; do not automatically replay the writer.'
  const unverified = await db.selectFrom('storyThreadMessages').select('id')
    .where('ownerUserId', '=', owner).where('jobId', '=', jobId)
    .where('role', '=', 'user').where('phase', '=', 'blocked')
    .executeTakeFirst()
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

/** Stable settlement ids retain old summaries rather than rewriting history. */
async function insertAssistant(tx: Write, owner: string, threadId: string, jobId: string): Promise<string> {
  const content = await jobSummary(tx, owner, jobId)
  const latest = await tx.selectFrom('storyThreadMessages')
    .select(['id', 'body']).where('ownerUserId', '=', owner)
    .where('threadId', '=', threadId).where('role', '=', 'assistant')
    .where('jobId', '=', jobId).orderBy('sequence', 'desc').executeTakeFirst()
  if (latest?.body === content) return latest.id
  const event = await tx.selectFrom('generationEvents').select('id')
    .where('ownerUserId', '=', owner).where('jobId', '=', jobId)
    .where('kind', 'in', ['finished', 'interrupted'])
    .orderBy('id', 'desc').executeTakeFirst()
  const signature = createHash('sha256').update(content).digest('hex').slice(0, 12)
  const candidateId = latest ? `assistant:${jobId}:${event?.id ?? 'settlement'}:${signature}`
    : 'assistant:' + jobId
  const sequence = await nextSequence(tx, threadId)
  // Returning to a previous status must append another immutable settlement,
  // rather than silently collide with the old content-derived message ID.
  // Guarded sequence allocation makes this suffix deterministic on retry.
  const previouslyUsed = await tx.selectFrom('storyThreadMessages').select('id')
    .where('id', '=', candidateId).executeTakeFirst()
  const id = previouslyUsed ? candidateId + ':' + sequence : candidateId
  await tx.insertInto('storyThreadMessages').values({
    id, ownerUserId: owner, threadId, sequence,
    role: 'assistant', status: 'delivered', body: content, phase: 'finished',
    jobId, createdAt: new Date().toISOString(),
  }).onConflict(oc => oc.doNothing()).execute()
  return id
}

async function recoveryJobs(db: Executor, owner: string, threadId: string): Promise<Set<string>> {
  return new Set((await db.selectFrom('checkpointForks').select('childId')
    .where('ownerUserId', '=', owner).where('sourceThreadId', '=', threadId)
    .execute()).map(row => row.childId))
}

/** Seed historical root requests and terminal summaries under the same
 * transaction as chat reading, so another writer cannot allocate a duplicate
 * sequence or claim an uncommitted synthetic message. */
async function reconcile(tx: Write, owner: string, threadId: string): Promise<Set<string>> {
  const recoveries = await recoveryJobs(tx, owner, threadId)
  const runs = await tx.selectFrom('storyThreadRuns')
    .innerJoin('studioSessions', join => join
      .onRef('studioSessions.id', '=', 'storyThreadRuns.jobId')
      .onRef('studioSessions.ownerUserId', '=', 'storyThreadRuns.ownerUserId'))
    .leftJoin('generationRunQueue', join => join
      .onRef('generationRunQueue.jobId', '=', 'studioSessions.id')
      .onRef('generationRunQueue.ownerUserId', '=', 'studioSessions.ownerUserId'))
    .select([
      'storyThreadRuns.jobId as jobId', 'storyThreadRuns.runOrder as runOrder',
      'studioSessions.generationRequestJson as requestJson',
      'studioSessions.status as status',
      'generationRunQueue.phase as queuePhase',
      'studioSessions.sourceCommitSha as sourceSha',
      'studioSessions.createdAt as createdAt',
    ])
    .where('storyThreadRuns.threadId', '=', threadId)
    .where('storyThreadRuns.ownerUserId', '=', owner)
    .orderBy('storyThreadRuns.runOrder').execute()
  for (const run of runs) {
    if (run.requestJson && !recoveries.has(run.jobId)) {
      let task: unknown
      try { task = (JSON.parse(run.requestJson) as { task?: unknown }).task }
      catch { /* older malformed requests have no recoverable task */ }
      if (typeof task === 'string' && task.trim()) {
        const existing = await tx.selectFrom('storyThreadMessages').select('id')
          .where('ownerUserId', '=', owner).where('threadId', '=', threadId)
          .where('role', '=', 'user')
          .where(eb => eb.or([
            eb('jobId', '=', run.jobId),
            eb('id', '=', run.jobId),
            ...(run.runOrder === 0 ? [eb('jobId', 'is', null)] : []),
          ])).executeTakeFirst()
        if (!existing)
          await tx.insertInto('storyThreadMessages').values({
            id: 'initial:' + run.jobId, ownerUserId: owner, threadId,
            sequence: await nextSequence(tx, threadId), role: 'user',
            status: 'delivered', body: task, phase: 'finished', jobId: run.jobId,
            verifiedCommitSha: run.sourceSha, createdAt: run.createdAt,
          }).onConflict(oc => oc.doNothing()).execute()
      }
    }
    const unsettled = await tx.selectFrom('storyThreadMessages').select('id')
      .where('ownerUserId', '=', owner).where('jobId', '=', run.jobId)
      .where('role', '=', 'user').where('phase', '=', 'running').executeTakeFirst()
    if (!unsettled && run.queuePhase === 'finished' &&
      ['completed', 'paused', 'blocked', 'cancelled'].includes(run.status))
      await insertAssistant(tx, owner, threadId, run.jobId)
  }
  return recoveries
}

export function createKyselyThreadMessages(db: SharedDatabase<StudioDb>): ThreadMessagePersistence {
  return {
    async owned(owner, threadId, id) {
      required(owner)
      return ownedMessage(db.read, owner, threadId, id)
    },
    async markAdmitted(owner, jobId) {
      required(owner)
      await db.withWriteTransaction([{ kind: 'job', id: jobId }], async tx => {
        const admitted = await tx.selectFrom('generationRunQueue').select('jobId')
          .where('ownerUserId', '=', owner).where('jobId', '=', jobId).executeTakeFirst()
        if (!admitted) throw new ThreadMessageConflict(409, 'Generation was not admitted.')
        await tx.updateTable('storyThreadMessages').set({
          status: 'delivered', phase: 'running', jobId,
        }).where('id', '=', 'guidance:fork:' + jobId).where('ownerUserId', '=', owner)
          .where('status', '=', 'queued').execute()
        await tx.updateTable('storyThreadMessages').set({
          status: 'delivered', phase: 'running',
        }).where('id', '=', 'edit:' + jobId).where('ownerUserId', '=', owner)
          .where('jobId', '=', jobId).where('status', '=', 'queued').execute()
      })
    },
    async membership(owner, threadId) {
      const row = await membership(db.read, owner, threadId)
      return {
        storyId: row.storyId, archivedAt: row.archivedAt,
        creativePolicyJson: row.creativePolicyJson,
      }
    },
    async read(owner, threadId) {
      required(owner)
      return db.withWriteTransaction([{ kind: 'thread', id: threadId }], async tx => {
        await membership(tx, owner, threadId)
        const recoveries = await reconcile(tx, owner, threadId)
        const messageRows = await messagesQuery(tx)
          .where('storyThreadMessages.ownerUserId', '=', owner)
          .where('storyThreadMessages.threadId', '=', threadId)
          .orderBy('storyThreadMessages.sequence').execute()
        const messages = messageRows.map(asMessage).filter(message =>
          !(message.role === 'user' && message.jobId &&
            message.id === 'initial:' + message.jobId && recoveries.has(message.jobId)))
        const edits = await tx.selectFrom('threadQueuedMessageEdits')
          .select([
            'messageId', 'oldBody as old', 'newBody as replacement', 'editedAt',
          ])
          .where('ownerUserId', '=', owner).where('threadId', '=', threadId)
          .orderBy('sequence').execute()
        const history = new Map<string, Array<{ old: string; replacement: string; editedAt: string }>>()
        for (const { messageId, ...edit } of edits)
          history.set(messageId, [...(history.get(messageId) ?? []), edit])
        for (const message of messages) message.editHistory = history.get(message.id) ?? []
        const runs = await tx.selectFrom('storyThreadRuns')
          .innerJoin('studioSessions', join => join
            .onRef('studioSessions.id', '=', 'storyThreadRuns.jobId')
            .onRef('studioSessions.ownerUserId', '=', 'storyThreadRuns.ownerUserId'))
          .leftJoin('generationRunQueue', join => join
            .onRef('generationRunQueue.jobId', '=', 'studioSessions.id')
            .onRef('generationRunQueue.ownerUserId', '=', 'studioSessions.ownerUserId'))
          .select([
            'storyThreadRuns.jobId as jobId', 'storyThreadRuns.runOrder as runOrder',
            'studioSessions.status as status', 'generationRunQueue.phase as queuePhase',
            'studioSessions.generationRequestJson as requestJson',
          ])
          .where('storyThreadRuns.threadId', '=', threadId)
          .where('storyThreadRuns.ownerUserId', '=', owner)
          .orderBy('storyThreadRuns.runOrder').execute()
        const evidence = await tx.selectFrom('generationEvents')
          .innerJoin('storyThreadRuns', join => join
            .onRef('storyThreadRuns.jobId', '=', 'generationEvents.jobId')
            .onRef('storyThreadRuns.ownerUserId', '=', 'generationEvents.ownerUserId'))
          .select([
            'generationEvents.jobId as jobId', 'generationEvents.kind as kind',
            'generationEvents.stage as stage', 'generationEvents.milestone as milestone',
            'generationEvents.filesJson as filesJson', 'generationEvents.status as status',
            'generationEvents.createdAt as createdAt',
          ])
          .where('storyThreadRuns.threadId', '=', threadId)
          .where('storyThreadRuns.ownerUserId', '=', owner)
          .where('generationEvents.kind', 'in', ['verified', 'finished', 'interrupted'])
          .orderBy('generationEvents.id').execute()
        const turnRows = await tx.selectFrom('storyTurns')
          .innerJoin('storyThreadMessages', 'storyThreadMessages.id', 'storyTurns.id')
          .leftJoin('storyTurnExecutions', 'storyTurnExecutions.turnId', 'storyTurns.id')
          .leftJoin('storyThreadRuns', join => join
            .onRef('storyThreadRuns.jobId', '=', 'storyTurnExecutions.jobId')
            .on('storyThreadRuns.ownerUserId', '=', owner))
          .leftJoin('studioSessions', join => join
            .onRef('studioSessions.id', '=', 'storyTurnExecutions.jobId')
            .on('studioSessions.ownerUserId', '=', owner))
          .leftJoin('generationRunQueue', join => join
            .onRef('generationRunQueue.jobId', '=', 'storyTurnExecutions.jobId')
            .on('generationRunQueue.ownerUserId', '=', owner))
          .select([
            'storyTurns.id as id', 'storyTurns.creativePolicyJson as creativePolicyJson',
            'storyTurnExecutions.jobId as jobId',
            'studioSessions.sourceCommitSha as inputSha', 'studioSessions.status as status',
            'generationRunQueue.phase as queuePhase',
            sql<string | null>`(SELECT proof.verified_commit_sha
              FROM story_thread_messages proof
              WHERE proof.owner_user_id="story_turns"."owner_user_id"
                AND proof.thread_id="story_turns"."thread_id"
                AND proof.job_id="story_turn_executions"."job_id"
                AND proof.role='assistant' AND proof.verified_commit_sha IS NOT NULL
              ORDER BY proof.sequence DESC LIMIT 1)`.as('validatedSha'),
          ])
          .where('storyTurns.ownerUserId', '=', owner).where('storyTurns.threadId', '=', threadId)
          .orderBy('storyThreadMessages.sequence').orderBy('storyThreadRuns.runOrder').execute()
        const turns: Array<{ id: string; executionIds: string[] }> = []
        const turnReceipts: TurnReceipt[] = []
        const messagesById = new Map(messages.map(message => [message.id, message]))
        for (const row of turnRows) {
          if (!messagesById.has(row.id) && row.id.startsWith('initial:') &&
            recoveries.has(row.id.slice('initial:'.length))) continue
          let turn = turns.at(-1)
          let receipt = turnReceipts.at(-1)
          if (turn?.id !== row.id) {
            turn = { id: row.id, executionIds: [] }
            turns.push(turn)
            const original = messagesById.get(row.id)
            if (!original) throw new Error('Turn has no persisted author request.')
            receipt = {
              id: row.id, request: original.editHistory?.[0]?.old ?? original.content,
              effectiveRequest: original.content, outcome: original.phase,
              inputSha: null, creativePolicy: parseCreativePolicy(row.creativePolicyJson),
              executions: [],
            }
            turnReceipts.push(receipt)
          }
          if (row.jobId && row.inputSha && row.status) {
            turn!.executionIds.push(row.jobId)
            receipt!.inputSha ??= row.inputSha
            receipt!.executions.push({
              jobId: row.jobId, inputSha: row.inputSha,
              status: row.status, queuePhase: row.queuePhase, validatedSha: row.validatedSha,
            })
          }
        }
        return { messages, runs, evidence, turns, turnReceipts }
      })
    },
    async enqueue(owner, threadId, id, body, mode, at, creativeMode?: CreativeMode) {
      required(owner)
      return db.withWriteTransaction([{ kind: 'thread', id: threadId }], async tx => {
        const member = await membership(tx, owner, threadId)
        await reconcile(tx, owner, threadId)
        if (member.archivedAt) throw new ThreadMessageConflict(409, 'Restore the archived Thread before sending.')
        const existing = await messagesQuery(tx).where('storyThreadMessages.id', '=', id)
          .executeTakeFirst()
        if (existing) {
          const edit = await tx.selectFrom('threadQueuedMessageEdits').select('oldBody')
            .where('messageId', '=', id).orderBy('sequence').executeTakeFirst()
          if (existing.role !== 'user' ||
            (existing.content !== body && edit?.oldBody !== body) ||
            (mode !== undefined && existing.liveMode !== mode) ||
            (creativeMode !== undefined && existing.creativeModeOverride !== creativeMode) ||
            !(await ownedMessage(tx, owner, threadId, id)))
            throw new ThreadMessageConflict(409, 'Message ID is already in use.')
          return asMessage(existing)
        }
        const collision = await tx.selectFrom('studioSessions').select('id')
          .where('id', '=', id).executeTakeFirst()
        if (collision) throw new ThreadMessageConflict(409, 'Message ID is already assigned to a job.')
        const run = await currentRun(tx, owner, threadId)
        if (!run) throw new ThreadMessageConflict(409,
          'Create a generation run for this Thread before sending follow-ups.')
        const initialGuidance = id === 'guidance:fork:' + run.jobId &&
          run.status === 'paused' && !mode
        if (!initialGuidance && (run.queuePhase === 'interrupted' ||
          ['blocked', 'paused', 'cancelled'].includes(run.status)))
          throw new ThreadMessageConflict(409,
            'This Thread cannot accept follow-ups while generation is stopped. Review its saved decision or recovery checkpoint.')
        if (mode === 'steer' && (run.status !== 'running' || run.queuePhase !== 'running'))
          throw new ThreadMessageConflict(409,
            'Steer is available only while a generation run is active.')
        await tx.insertInto('storyThreadMessages').values({
          id, ownerUserId: owner, threadId, sequence: await nextSequence(tx, threadId),
          role: 'user', status: 'queued', body, phase: 'queued', createdAt: at,
          creativePolicyJson: JSON.stringify(creativeMode ? creativePolicy(creativeMode) :
            parseCreativePolicy(member.creativePolicyJson)),
          creativeModeOverride: creativeMode ?? null,
        }).execute()
        if (mode) {
          const target = mode === 'steer'
            ? await tx.selectFrom('threadActivePiTurns')
              .innerJoin('generationRunQueue', join => join
                .onRef('generationRunQueue.jobId', '=', 'threadActivePiTurns.jobId')
                .on('generationRunQueue.ownerUserId', '=', owner)
                .on('generationRunQueue.phase', '=', 'running'))
              .select([
                'threadActivePiTurns.piToken as token',
                'threadActivePiTurns.workItem as workItem',
                'threadActivePiTurns.expectedHead as expectedHead',
              ])
              .where('threadActivePiTurns.jobId', '=', run.jobId).executeTakeFirst()
            : undefined
          await tx.insertInto('threadLiveInputs').values({
            messageId: id, ownerUserId: owner, threadId, sourceJobId: run.jobId, mode,
            state: target ? 'pending' : 'deferred', createdAt: at,
            targetPiToken: target?.token ?? null,
            targetWorkItem: target?.workItem ?? null,
            submittedHead: target?.expectedHead ?? null,
          }).execute()
        }
        await tx.updateTable('storyThreads').set({ activityAt: at })
          .where('id', '=', threadId).where('ownerUserId', '=', owner).execute()
        return (await ownedMessage(tx, owner, threadId, id))!
      })
    },
    async edit(owner, threadId, id, requestId, expected, replacement, at) {
      required(owner)
      return db.withWriteTransaction([{ kind: 'thread', id: threadId }], async tx => {
        await membership(tx, owner, threadId)
        const prior = await tx.selectFrom('threadQueuedMessageEdits')
          .select([
            'messageId', 'ownerUserId as owner', 'threadId',
            'oldBody', 'newBody',
          ]).where('requestId', '=', requestId).executeTakeFirst()
        if (prior) {
          if (prior.messageId !== id || prior.owner !== owner || prior.threadId !== threadId ||
            prior.oldBody !== expected || prior.newBody !== replacement)
            throw new ThreadMessageConflict(409, 'Edit request ID is already in use.')
          return (await ownedMessage(tx, owner, threadId, id))!
        }
        const message = await ownedMessage(tx, owner, threadId, id)
        if (!message) throw new ThreadMessageConflict(404, 'Queued Thread instruction not found.')
        const raw = await tx.selectFrom('storyThreadMessages').select('sourceJobId')
          .where('id', '=', id).executeTakeFirst()
        const approval = await tx.selectFrom('threadProtectedDecisions').select('messageId')
          .where('messageId', '=', id).executeTakeFirst()
        if (message.role !== 'user' || message.phase !== 'queued' || message.jobId !== null ||
          ['dispatching', 'sdk-queued', 'delivered', 'blocked'].includes(message.liveState ?? '') ||
          raw?.sourceJobId || approval)
          throw new ThreadMessageConflict(409,
            'This instruction is already admitted or approved and cannot be edited.')
        if (message.content !== expected || message.content === replacement)
          throw new ThreadMessageConflict(409,
            'Queued message changed. Refresh the Thread before editing.')
        await tx.insertInto('threadQueuedMessageEdits').values({
          requestId, messageId: id, ownerUserId: owner, threadId,
          oldBody: expected, newBody: replacement, editedAt: at,
        }).execute()
        await tx.updateTable('storyThreadMessages').set({
          body: replacement, revisionScopeJson: null,
        }).where('id', '=', id).where('ownerUserId', '=', owner)
          .where('threadId', '=', threadId).where('phase', '=', 'queued').execute()
        await tx.updateTable('storyThreads').set({ activityAt: at })
          .where('id', '=', threadId).where('ownerUserId', '=', owner).execute()
        return (await ownedMessage(tx, owner, threadId, id))!
      })
    },
    async cancel(owner, threadId, id, at) {
      required(owner)
      return db.withWriteTransaction([{ kind: 'thread', id: threadId }], async tx => {
        await membership(tx, owner, threadId)
        const message = await ownedMessage(tx, owner, threadId, id)
        if (!message) throw new ThreadMessageConflict(404, 'Queued Thread instruction not found.')
        if (message.role !== 'user')
          throw new ThreadMessageConflict(409, 'Only author instructions can be cancelled.')
        if (message.phase === 'cancelled') return message
        const raw = await tx.selectFrom('storyThreadMessages').select('sourceJobId')
          .where('id', '=', id).executeTakeFirst()
        if (message.phase !== 'queued' || message.jobId !== null ||
          ['dispatching', 'sdk-queued', 'delivered'].includes(message.liveState ?? '') ||
          raw?.sourceJobId)
          throw new ThreadMessageConflict(409,
            'The instruction has entered execution and cannot be cancelled.')
        await tx.insertInto('storyThreadMessageCancellations').values({
          messageId: id, ownerUserId: owner, threadId, cancelledAt: at,
        }).execute()
        await tx.updateTable('storyThreads').set({ activityAt: at })
          .where('id', '=', threadId).where('ownerUserId', '=', owner).execute()
        return (await ownedMessage(tx, owner, threadId, id))!
      })
    },
  }
}
