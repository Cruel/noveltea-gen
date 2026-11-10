import { randomUUID } from 'node:crypto'
import { sql, type Transaction } from 'kysely'
import type { QueryExecutor, SharedDatabase, WriteGuard } from '../db/kysely-connection'
import type { StudioDb } from '../db/studio-db'
import { studioSafeInteger } from '../db/kysely-values'
import type {
  ClaimedPiInput, PendingPiInput, SteeringActivity, SteeringCheckpoint,
  SteeringDisposition, SteeringPersistence,
} from './steering-contracts'

type Read = QueryExecutor<StudioDb>
type Write = Transaction<StudioDb>
type Executor = Read | Write

const requireOwner = (owner: string) => {
  if (!owner) throw new Error('Authenticated owner required.')
}
const validSha = (sha: string) => /^[a-f0-9]{40}$/.test(sha)
const checkpointValid = (point: SteeringCheckpoint) =>
  point.eligible && validSha(point.commitSha) && validSha(point.parentSha) &&
  /^[a-f0-9]{64}$/.test(point.proofDigest)
const stateFor = (disposition: SteeringDisposition) =>
  disposition === 'scope-review' || disposition === 'protected-review'
    ? 'pending-boundary' : disposition === 'unresolved' ? 'unresolved' : 'considered'
const job = (id: string): WriteGuard => ({ kind: 'job', id })
const thread = (id: string): WriteGuard => ({ kind: 'thread', id })
const changed = (result: { numUpdatedRows: bigint | number }) => Number(result.numUpdatedRows)

/** Invoked within the caller's existing transaction; never obtains a root
 * connection while a SQLite/PostgreSQL write transaction is in progress. */
async function consider(tx: Write, messageId: string, owner: string, threadId: string,
  jobId: string, content: string, workItem: string | null,
  disposition: SteeringDisposition, at: string): Promise<void> {
  requireOwner(owner)
  const eligible = await tx.selectFrom('threadLiveInputs as l')
    .innerJoin('storyThreadMessages as m', join => join
      .onRef('m.id', '=', 'l.messageId')
      .onRef('m.ownerUserId', '=', 'l.ownerUserId')
      .onRef('m.threadId', '=', 'l.threadId'))
    .select('l.messageId')
    .where('l.messageId', '=', messageId).where('l.ownerUserId', '=', owner)
    .where('l.threadId', '=', threadId).where('l.sourceJobId', '=', jobId)
    .where('l.state', '=', 'delivered').where('m.body', '=', content)
    .executeTakeFirst()
  if (!eligible) return
  await tx.insertInto('threadSteeringIntents').values({
    messageId, ownerUserId: owner, threadId, sourceJobId: jobId,
    disposition, workItem, consideredAt: at, reviewState: stateFor(disposition),
  }).onConflict(oc => oc.column('messageId').doNothing()).execute()
  const saved = await tx.selectFrom('threadSteeringIntents')
    .select(['ownerUserId', 'threadId', 'sourceJobId', 'disposition', 'workItem'])
    .where('messageId', '=', messageId).executeTakeFirstOrThrow()
  if (saved.ownerUserId !== owner || saved.threadId !== threadId ||
      saved.sourceJobId !== jobId || saved.disposition !== disposition ||
      saved.workItem !== workItem)
    throw new Error('Steering consideration already exists with different evidence')
}

/** Shared author-steering data rules. All mutations use the audited guarded
 * transaction infrastructure, so SQLite BEGIN IMMEDIATE and PostgreSQL
 * advisory serialization provide the same one-shot CAS semantics.
 * Transient Pi calls are never performed inside replayable transactions. */
export function createKyselySteeringPersistence(db: SharedDatabase<StudioDb>): SteeringPersistence {
  return {
    async registerTurn(jobId, piToken, piSessionId, workItem, expectedHead, at) {
      await db.withWriteTransaction([job(jobId)], async tx => {
        const running = await tx.selectFrom('generationRunQueue').select('jobId')
          .where('jobId', '=', jobId).where('phase', '=', 'running').executeTakeFirst()
        if (!running) throw new Error('Cannot register Pi outside a running generation job')
        await tx.insertInto('threadActivePiTurns').values({
          jobId, piToken, piSessionId, workItem, expectedHead, createdAt: at,
        }).onConflict(oc => oc.column('jobId').doNothing()).execute()
        const saved = await tx.selectFrom('threadActivePiTurns').selectAll()
          .where('jobId', '=', jobId).executeTakeFirstOrThrow()
        if (saved.piToken !== piToken || saved.piSessionId !== piSessionId ||
            saved.workItem !== workItem || saved.expectedHead !== expectedHead)
          throw new Error('An incompatible Pi Turn is already active for this job')
      })
    },
    async closeTurn(jobId, piToken) {
      await db.withWriteTransaction([job(jobId)], async tx => {
        await tx.updateTable('threadLiveInputs').set({ state: 'deferred' })
          .where('sourceJobId', '=', jobId).where('targetPiToken', '=', piToken)
          .where('state', '=', 'pending').execute()
        await tx.deleteFrom('threadActivePiTurns').where('jobId', '=', jobId)
          .where('piToken', '=', piToken).execute()
      })
    },
    async recoverOrphaned() {
      await db.withWriteTransaction([], async tx => {
        // Use correlated, owner/job-bound existence checks rather than a root
        // read; a running queue alone is not evidence of a live Pi Turn.
        await tx.updateTable('threadLiveInputs').set({ state: 'deferred' })
          .where('state', '=', 'pending').where('targetPiToken', 'is not', null)
          .where(eb => eb.not(eb.exists(
            eb.selectFrom('threadActivePiTurns as t')
              .innerJoin('generationRunQueue as q', join => join
                .onRef('q.jobId', '=', 't.jobId').on('q.phase', '=', 'running'))
              .select('t.jobId')
              .whereRef('t.piToken', '=', 'threadLiveInputs.targetPiToken')
              .whereRef('t.jobId', '=', 'threadLiveInputs.sourceJobId'),
          ))).execute()
        await tx.deleteFrom('threadActivePiTurns')
          .where(eb => eb.not(eb.exists(
            eb.selectFrom('generationRunQueue as q').select('q.jobId')
              .whereRef('q.jobId', '=', 'threadActivePiTurns.jobId')
              .where('q.phase', '=', 'running'),
          ))).execute()
        await tx.updateTable('threadLiveInputs').set({ state: 'blocked' })
          .where('state', 'in', ['dispatching', 'sdk-queued'])
          .where(eb => eb.not(eb.exists(
            eb.selectFrom('threadActivePiTurns as t')
              .innerJoin('generationRunQueue as q', join => join
                .onRef('q.jobId', '=', 't.jobId').on('q.phase', '=', 'running'))
              .select('t.jobId')
              .whereRef('t.piToken', '=', 'threadLiveInputs.piToken')
              .whereRef('t.jobId', '=', 'threadLiveInputs.sourceJobId'),
          ))).execute()
        await tx.updateTable('storyThreadMessages').set({ phase: 'blocked' })
          .where('phase', '=', 'queued')
          .where(eb => eb.exists(eb.selectFrom('threadLiveInputs as l')
            .select('l.messageId').whereRef('l.messageId', '=', 'storyThreadMessages.id')
            .where('l.state', '=', 'blocked')))
          .execute()
      })
    },
    async dispatchable(): Promise<PendingPiInput[]> {
      const rows = await db.read.selectFrom('threadLiveInputs as l')
        .innerJoin('storyThreadMessages as m', join => join
          .onRef('m.id', '=', 'l.messageId').onRef('m.ownerUserId', '=', 'l.ownerUserId')
          .onRef('m.threadId', '=', 'l.threadId'))
        .innerJoin('generationRunQueue as q', join => join
          .onRef('q.jobId', '=', 'l.sourceJobId').onRef('q.ownerUserId', '=', 'l.ownerUserId'))
        .select([
          'l.messageId as id', 'l.ownerUserId as owner', 'l.threadId as threadId',
          'l.sourceJobId as jobId', 'm.body as content', 'm.sequence as sequence', 'l.mode as mode',
        ])
        .where('l.mode', '=', 'steer').where('l.state', '=', 'pending')
        .where('q.phase', '=', 'running').where('m.phase', '=', 'queued')
        .where(eb => eb.exists(eb.selectFrom('threadActivePiTurns as t')
          .select('t.jobId').whereRef('t.jobId', '=', 'l.sourceJobId')
          .whereRef('t.piToken', '=', 'l.targetPiToken')))
        .where(eb => eb.not(eb.exists(eb.selectFrom('storyThreadMessageCancellations as c')
          .select('c.messageId').whereRef('c.messageId', '=', 'm.id'))))
        // A future follow-up is not a Pi SDK steer. Only an earlier unsent
        // steer for the same source job can hold this admission.
        .where(eb => eb.not(eb.exists(
          eb.selectFrom('threadLiveInputs as prior')
            .innerJoin('storyThreadMessages as earlier', 'earlier.id', 'prior.messageId')
            .select('prior.messageId')
            .whereRef('prior.threadId', '=', 'l.threadId')
            .whereRef('prior.ownerUserId', '=', 'l.ownerUserId')
            .whereRef('prior.sourceJobId', '=', 'l.sourceJobId')
            .where('prior.mode', '=', 'steer')
            .where('prior.state', 'in', ['pending', 'dispatching'])
            .whereRef('earlier.sequence', '<', 'm.sequence')
            .where('earlier.phase', '=', 'queued')
            .where(eb2 => eb2.not(eb2.exists(
              eb2.selectFrom('storyThreadMessageCancellations as c')
                .select('c.messageId').whereRef('c.messageId', '=', 'earlier.id'),
            ))),
        )))
        .orderBy('m.sequence', 'asc').limit(32).execute()
      return rows.map(row => ({ ...row, sequence: studioSafeInteger(row.sequence),
        mode: row.mode as PendingPiInput['mode'] }))
    },
    async turn(jobId, piToken) {
      return await db.read.selectFrom('threadActivePiTurns').select('piSessionId as sessionId')
        .where('jobId', '=', jobId).where('piToken', '=', piToken).executeTakeFirst() ?? null
    },
    async claim(item, token, sessionId) {
      requireOwner(item.owner)
      return await db.withWriteTransaction([job(item.jobId), thread(item.threadId)], async tx => {
        const result = await tx.updateTable('threadLiveInputs')
          .set({ state: 'dispatching', piToken: token, piSessionId: sessionId })
          .where('messageId', '=', item.id).where('ownerUserId', '=', item.owner)
          .where('threadId', '=', item.threadId).where('sourceJobId', '=', item.jobId)
          .where('mode', '=', 'steer').where('state', '=', 'pending')
          .where('targetPiToken', '=', token)
          .where(eb => eb.exists(eb.selectFrom('threadActivePiTurns as t')
            .select('t.jobId').whereRef('t.jobId', '=', 'threadLiveInputs.sourceJobId')
            .whereRef('t.piToken', '=', 'threadLiveInputs.targetPiToken')
            .whereRef('t.workItem', '=', 'threadLiveInputs.targetWorkItem')
            .where(eb2 => eb2.or([
              eb2('t.expectedHead', '=', eb2.ref('threadLiveInputs.submittedHead')),
              eb2.and([
                eb2('t.expectedHead', 'is', null),
                eb2('threadLiveInputs.submittedHead', 'is', null),
              ]),
            ]))
            .where('t.piSessionId', '=', sessionId)))
          .where(eb => eb.exists(eb.selectFrom('generationRunQueue as q')
            .select('q.jobId').whereRef('q.jobId', '=', 'threadLiveInputs.sourceJobId')
            .where('q.phase', '=', 'running').whereRef('q.ownerUserId', '=', 'threadLiveInputs.ownerUserId')))
          .where(eb => eb.exists(eb.selectFrom('storyThreadMessages as m')
            .select('m.id').whereRef('m.id', '=', 'threadLiveInputs.messageId')
            .whereRef('m.ownerUserId', '=', 'threadLiveInputs.ownerUserId')
            .whereRef('m.threadId', '=', 'threadLiveInputs.threadId')
            .where('m.phase', '=', 'queued')
            .where(eb2 => eb2.not(eb2.exists(
              eb2.selectFrom('storyThreadMessageCancellations as c')
                .select('c.messageId').whereRef('c.messageId', '=', 'm.id'),
            )))))
          .executeTakeFirst()
        return changed(result) === 1
      })
    },
    async deferUnsent(messageId, token) {
      await db.withWriteTransaction([], async tx => {
        await tx.updateTable('threadLiveInputs').set({ state: 'deferred' })
          .where('messageId', '=', messageId).where('piToken', '=', token)
          .where('state', '=', 'dispatching').execute()
      })
    },
    async accepted(messageId, token) {
      await db.withWriteTransaction([], async tx => {
        await tx.updateTable('threadLiveInputs').set({ state: 'sdk-queued' })
          .where('messageId', '=', messageId).where('piToken', '=', token)
          .where('state', '=', 'dispatching').execute()
      })
    },
    async blocked(messageId, owner, token, attempted) {
      requireOwner(owner)
      await db.withWriteTransaction([], async tx => {
        const result = await tx.updateTable('threadLiveInputs')
          .set({ state: attempted ? 'blocked' : 'deferred' })
          .where('messageId', '=', messageId).where('ownerUserId', '=', owner)
          .where('piToken', '=', token).where('state', '=', 'dispatching').executeTakeFirst()
        if (attempted && changed(result) === 1)
          await tx.updateTable('storyThreadMessages').set({ phase: 'blocked' })
            .where('id', '=', messageId).where('ownerUserId', '=', owner)
            .where('phase', '=', 'queued').execute()
      })
    },
    async settling(jobId, token): Promise<ClaimedPiInput[]> {
      const rows = await db.read.selectFrom('threadLiveInputs as l')
        .innerJoin('storyThreadMessages as m', 'm.id', 'l.messageId')
        .select([
          'l.messageId as id', 'l.ownerUserId as owner', 'l.threadId as threadId',
          'l.sourceJobId as jobId', 'm.body as content', 'm.sequence as sequence',
          'l.state as delivery', 'l.mode as mode',
        ])
        .where('l.sourceJobId', '=', jobId).where('l.piToken', '=', token)
        .where('l.state', 'in', ['dispatching', 'sdk-queued'])
        .orderBy('m.sequence').execute()
      return rows.map(row => ({ ...row, sequence: studioSafeInteger(row.sequence),
        mode: row.mode as ClaimedPiInput['mode'] }))
    },
    async settle(row, token, delivered, workItem, disposition, at) {
      requireOwner(row.owner)
      await db.withWriteTransaction([job(row.jobId), thread(row.threadId)], async tx => {
        const result = await tx.updateTable('threadLiveInputs').set({
          state: delivered ? 'delivered' : 'blocked', deliveredAt: delivered ? at : null,
        }).where('messageId', '=', row.id).where('ownerUserId', '=', row.owner)
          .where('threadId', '=', row.threadId).where('sourceJobId', '=', row.jobId)
          .where('piToken', '=', token).where('state', 'in', ['dispatching', 'sdk-queued'])
          .executeTakeFirst()
        if (changed(result) !== 1) return
        const message = await tx.updateTable('storyThreadMessages').set({
          phase: delivered ? 'finished' : 'blocked',
          ...(delivered ? { status: 'delivered', jobId: row.jobId } : {}),
        }).where('id', '=', row.id).where('ownerUserId', '=', row.owner)
          .where('threadId', '=', row.threadId).where('phase', '=', 'queued')
          .executeTakeFirst()
        if (changed(message) !== 1)
          throw new Error('Cannot settle a stale or invalid Thread instruction')
        if (delivered)
          await consider(tx, row.id, row.owner, row.threadId, row.jobId,
            row.content, workItem, disposition, at)
      })
    },
    async deferTurn(jobId, token) {
      await db.withWriteTransaction([job(jobId)], async tx => {
        await tx.updateTable('threadLiveInputs').set({ state: 'deferred' })
          .where('sourceJobId', '=', jobId).where('targetPiToken', '=', token)
          .where('state', '=', 'pending').execute()
      })
    },
    async review(owner, threadId, messageId, reviewer, evidence, at) {
      requireOwner(owner)
      await db.withWriteTransaction([thread(threadId)], async tx => {
        const row = await tx.selectFrom('threadLiveInputs as l')
          .innerJoin('storyThreadMessages as m', join => join
            .onRef('m.id', '=', 'l.messageId').onRef('m.ownerUserId', '=', 'l.ownerUserId')
            .onRef('m.threadId', '=', 'l.threadId'))
          .select(['l.sourceJobId as jobId', 'm.verifiedCommitSha as sha'])
          .where('l.messageId', '=', messageId).where('l.ownerUserId', '=', owner)
          .where('l.threadId', '=', threadId).where('l.state', '=', 'delivered')
          .where('m.verifiedCommitSha', 'is not', null).executeTakeFirst()
        if (!row?.sha || !validSha(row.sha))
          throw new Error('Cannot verify an unacknowledged instruction or an unverified Story commit')
        await tx.insertInto('threadLiveEffectReviews').values({
          messageId, ownerUserId: owner, threadId, jobId: row.jobId,
          commitSha: row.sha, reviewer: reviewer.trim(), evidence: evidence.trim(),
          verifiedAt: at,
        }).onConflict(oc => oc.column('messageId').doNothing()).execute()
        const saved = await tx.selectFrom('threadLiveEffectReviews')
          .select(['commitSha', 'reviewer', 'evidence', 'jobId', 'ownerUserId', 'threadId'])
          .where('messageId', '=', messageId).executeTakeFirst()
        if (!saved || saved.commitSha !== row.sha || saved.jobId !== row.jobId ||
            saved.ownerUserId !== owner || saved.threadId !== threadId ||
            saved.reviewer !== reviewer.trim() || saved.evidence !== evidence.trim())
          throw new Error('Effect review already exists with different evidence')
      })
    },
    async deferUndelivered(owner, jobId) {
      requireOwner(owner)
      await db.withWriteTransaction([job(jobId)], async tx => {
        await tx.updateTable('threadLiveInputs').set({ state: 'deferred' })
          .where('ownerUserId', '=', owner).where('sourceJobId', '=', jobId)
          .where('state', '=', 'pending').execute()
        const stuck = await tx.selectFrom('threadLiveInputs').select('messageId')
          .where('ownerUserId', '=', owner).where('sourceJobId', '=', jobId)
          .where('state', 'in', ['dispatching', 'sdk-queued']).execute()
        for (const row of stuck) {
          await tx.updateTable('threadLiveInputs').set({ state: 'blocked' })
            .where('messageId', '=', row.messageId)
            .where('ownerUserId', '=', owner)
            .where('state', 'in', ['dispatching', 'sdk-queued']).execute()
          await tx.updateTable('storyThreadMessages').set({ phase: 'blocked' })
            .where('id', '=', row.messageId).where('ownerUserId', '=', owner)
            .where('phase', '=', 'queued').execute()
        }
      })
    },
    async consider(messageId, owner, threadId, jobId, content, workItem, disposition, at) {
      await db.withWriteTransaction([job(jobId), thread(threadId)], tx =>
        consider(tx, messageId, owner, threadId, jobId, content, workItem, disposition, at))
    },
    async attribute(owner, jobId, checkpoint, at) {
      requireOwner(owner)
      if (!checkpointValid(checkpoint)) return 0
      return db.withWriteTransaction([job(jobId)], async tx => {
        const rows = await tx.selectFrom('threadLiveInputs as l')
          .innerJoin('threadSteeringIntents as i', join => join
            .onRef('i.messageId', '=', 'l.messageId')
            .onRef('i.ownerUserId', '=', 'l.ownerUserId')
            .onRef('i.threadId', '=', 'l.threadId')
            .onRef('i.sourceJobId', '=', 'l.sourceJobId'))
          .innerJoin('storyThreadMessages as m', join => join
            .onRef('m.id', '=', 'l.messageId')
            .onRef('m.ownerUserId', '=', 'l.ownerUserId')
            .onRef('m.threadId', '=', 'l.threadId'))
          .select(['l.messageId as id', 'l.threadId as threadId'])
          .where('l.ownerUserId', '=', owner).where('l.sourceJobId', '=', jobId)
          .where('l.state', '=', 'delivered').where('l.targetWorkItem', '=', checkpoint.workItem)
          .where('l.submittedHead', '=', checkpoint.parentSha)
          .where('i.checkpointSha', 'is', null)
          .where('m.status', '=', 'delivered').execute()
        for (const row of rows) {
          await tx.insertInto('threadSteeringCheckpointLinks').values({
            messageId: row.id, ownerUserId: owner, threadId: row.threadId,
            sourceJobId: jobId, checkpointSha: checkpoint.commitSha,
            proofDigest: checkpoint.proofDigest, workItem: checkpoint.workItem,
            association: 'verified-influence', recordedAt: at,
          }).onConflict(oc => oc.doNothing()).execute()
          const intent = await tx.updateTable('threadSteeringIntents').set({
            checkpointSha: checkpoint.commitSha, checkpointProof: checkpoint.proofDigest,
          }).where('messageId', '=', row.id).where('ownerUserId', '=', owner)
            .where('sourceJobId', '=', jobId).where('checkpointSha', 'is', null)
            .executeTakeFirst()
          if (changed(intent) !== 1)
            throw new Error('Steering checkpoint attribution changed during admission')
          await tx.updateTable('storyThreadMessages').set({ verifiedCommitSha: checkpoint.commitSha })
            .where('id', '=', row.id).where('ownerUserId', '=', owner)
            .where('verifiedCommitSha', 'is', null).execute()
        }
        const pending = await tx.selectFrom('threadLiveInputs as l')
          .innerJoin('storyThreadMessages as m', join => join
            .onRef('m.id', '=', 'l.messageId')
            .onRef('m.ownerUserId', '=', 'l.ownerUserId')
            .onRef('m.threadId', '=', 'l.threadId'))
          .select(['l.messageId as id', 'l.threadId as threadId'])
          .where('l.ownerUserId', '=', owner).where('l.sourceJobId', '=', jobId)
          .where('l.mode', '=', 'steer').where('l.state', 'in', ['pending', 'deferred'])
          .where('m.phase', '=', 'queued')
          .where(eb => eb.not(eb.exists(eb.selectFrom('storyThreadMessageCancellations as c')
            .select('c.messageId').whereRef('c.messageId', '=', 'l.messageId'))))
          .execute()
        for (const row of pending)
          await tx.insertInto('threadSteeringCheckpointLinks').values({
            messageId: row.id, ownerUserId: owner, threadId: row.threadId,
            sourceJobId: jobId, checkpointSha: checkpoint.commitSha,
            proofDigest: checkpoint.proofDigest, workItem: checkpoint.workItem,
            association: 'pending-unresolved', recordedAt: at,
          }).onConflict(oc => oc.doNothing()).execute()
        return rows.length
      })
    },
    async approvedReplan(owner, jobId, point, files, at) {
      requireOwner(owner)
      if (!checkpointValid(point) || !files.length) return 0
      return db.withWriteTransaction([job(jobId)], async tx => {
        const row = await tx.selectFrom('threadSteeringIntents as i')
          .innerJoin('storyThreadMessages as m', join => join
            .onRef('m.id', '=', 'i.reviewMessageId')
            .onRef('m.ownerUserId', '=', 'i.ownerUserId')
            .onRef('m.threadId', '=', 'i.threadId'))
          .innerJoin('storyThreadRuns as r', join => join
            .onRef('r.jobId', '=', 'm.jobId')
            .onRef('r.threadId', '=', 'i.threadId')
            .onRef('r.ownerUserId', '=', 'i.ownerUserId'))
          .select(['i.messageId as original', 'i.threadId as threadId',
            'm.revisionScopeJson as scope'])
          .where('i.ownerUserId', '=', owner).where('r.jobId', '=', jobId)
          .where('i.reviewState', '=', 'approved-run')
          .where('m.status', 'in', ['queued', 'delivered'])
          .where('m.phase', 'in', ['running', 'finished'])
          .orderBy('m.sequence').executeTakeFirst()
        if (!row?.scope) return 0
        let scope: { approved?: boolean; writePaths?: unknown; selectedTargets?: unknown }
        try { scope = JSON.parse(row.scope) } catch { return 0 }
        const paths = Array.isArray(scope.writePaths) && scope.writePaths.every(
          (p: unknown) => typeof p === 'string') ? scope.writePaths as string[] : []
        const targets = Array.isArray(scope.selectedTargets) ? scope.selectedTargets as unknown[] : []
        if (!scope.approved || !paths.length || !targets.length ||
            !files.every(file => paths.includes(file)) ||
            !point.workItem.startsWith('focus:') || !targets.includes(point.workItem.slice(6)))
          return 0
        const insertion = await tx.insertInto('threadSteeringCheckpointLinks').values({
          messageId: row.original, ownerUserId: owner, threadId: row.threadId,
          sourceJobId: jobId, checkpointSha: point.commitSha, proofDigest: point.proofDigest,
          workItem: point.workItem, association: 'verified-implementation', recordedAt: at,
        }).onConflict(oc => oc.doNothing()).returning('sequence').execute()
        return insertion.length
      })
    },
    async boundaryReviews(owner, jobId, threadId, verifiedHead, at) {
      requireOwner(owner)
      if (!validSha(verifiedHead)) return 0
      return db.withWriteTransaction([job(jobId), thread(threadId)], async tx => {
        const rows = await tx.selectFrom('threadSteeringIntents as i')
          .innerJoin('storyThreadMessages as m', join => join
            .onRef('m.id', '=', 'i.messageId').onRef('m.ownerUserId', '=', 'i.ownerUserId')
            .onRef('m.threadId', '=', 'i.threadId'))
          .innerJoin('generationRunQueue as q', join => join
            .onRef('q.jobId', '=', 'i.sourceJobId').onRef('q.ownerUserId', '=', 'i.ownerUserId'))
          .innerJoin('studioSessions as s', join => join
            .onRef('s.id', '=', 'i.sourceJobId').onRef('s.ownerUserId', '=', 'i.ownerUserId'))
          .select(['i.messageId as id', 'm.body as content'])
          .where('i.ownerUserId', '=', owner).where('i.sourceJobId', '=', jobId)
          .where('i.threadId', '=', threadId).where('i.reviewState', '=', 'pending-boundary')
          .where('i.reviewMessageId', 'is', null)
          .where('i.disposition', 'in', ['scope-review', 'protected-review'])
          .where('q.phase', '=', 'finished').where('s.status', '=', 'completed')
          .where('m.status', '=', 'delivered')
          .orderBy('m.sequence').execute()
        for (const row of rows) {
          const sequence = await tx.selectFrom('storyThreadMessages')
            .select(sql<number>`COALESCE(MAX("sequence"), -1) + 1`.as('next'))
            .where('threadId', '=', threadId).where('ownerUserId', '=', owner)
            .executeTakeFirstOrThrow()
          const id = randomUUID()
          await tx.insertInto('storyThreadMessages').values({
            id, ownerUserId: owner, threadId, sequence: studioSafeInteger(sequence.next),
            role: 'user', status: 'queued', body: row.content,
            originMessageId: row.id, phase: 'queued', createdAt: at,
          }).execute()
          const result = await tx.updateTable('threadSteeringIntents').set({
            reviewMessageId: id, reviewState: 'awaiting-review',
          }).where('messageId', '=', row.id).where('ownerUserId', '=', owner)
            .where('threadId', '=', threadId).where('reviewState', '=', 'pending-boundary')
            .where('reviewMessageId', 'is', null).executeTakeFirst()
          if (changed(result) !== 1) throw new Error('Steering boundary review was already claimed')
        }
        return rows.length
      })
    },
    async activity(owner, threadId): Promise<SteeringActivity[]> {
      requireOwner(owner)
      const considered = await db.read.selectFrom('threadSteeringIntents as i')
        .leftJoin('threadSteeringCheckpointLinks as l', join => join
          .onRef('l.messageId', '=', 'i.messageId')
          .onRef('l.checkpointSha', '=', 'i.checkpointSha')
          .onRef('l.ownerUserId', '=', 'i.ownerUserId')
          .onRef('l.threadId', '=', 'i.threadId'))
        .leftJoin('threadLiveEffectReviews as r', join => join
          .onRef('r.messageId', '=', 'i.messageId')
          .onRef('r.ownerUserId', '=', 'i.ownerUserId'))
        .select([
          'i.messageId as messageId', 'i.disposition as disposition',
          'i.reviewState as state', 'i.reviewMessageId as reviewMessageId',
          'i.sourceJobId as sourceJobId', 'i.checkpointSha as checkpointSha',
          'l.workItem as checkpointWorkItem', 'l.proofDigest as checkpointProof',
          'i.consideredAt as consideredAt', 'r.verifiedAt as verifiedEffectAt',
          sql<string | null>`(SELECT cp.checkpoint_sha FROM thread_steering_checkpoint_links cp
            WHERE cp.message_id="i"."message_id" AND cp.association='verified-implementation'
            ORDER BY cp.sequence DESC LIMIT 1)`.as('implementationSha'),
          sql<number>`(SELECT CAST(COUNT(*) AS INTEGER) FROM thread_steering_checkpoint_links cp
            WHERE cp.message_id="i"."message_id" AND cp.association='verified-implementation')`
            .as('implementationCount'),
        ])
        .where('i.ownerUserId', '=', owner).where('i.threadId', '=', threadId)
        .orderBy('i.consideredAt').orderBy('i.messageId').execute()
      const pending = await db.read.selectFrom('threadLiveInputs as l')
        .select([
          'l.messageId as messageId', 'l.state as state',
          'l.sourceJobId as sourceJobId', 'l.createdAt as consideredAt',
          sql<string | null>`(SELECT p.checkpoint_sha FROM thread_steering_checkpoint_links p
            WHERE p.message_id="l"."message_id" AND p.association='pending-unresolved'
            ORDER BY p.sequence DESC LIMIT 1)`.as('checkpointSha'),
          sql<string | null>`(SELECT p.work_item FROM thread_steering_checkpoint_links p
            WHERE p.message_id="l"."message_id" AND p.association='pending-unresolved'
            ORDER BY p.sequence DESC LIMIT 1)`.as('checkpointWorkItem'),
          sql<string | null>`(SELECT p.proof_digest FROM thread_steering_checkpoint_links p
            WHERE p.message_id="l"."message_id" AND p.association='pending-unresolved'
            ORDER BY p.sequence DESC LIMIT 1)`.as('checkpointProof'),
        ])
        .where('l.ownerUserId', '=', owner).where('l.threadId', '=', threadId)
        .where('l.mode', '=', 'steer').where('l.state', 'in', ['pending', 'deferred'])
        .where(eb => eb.not(eb.exists(eb.selectFrom('threadSteeringIntents as i')
          .select('i.messageId').whereRef('i.messageId', '=', 'l.messageId'))))
        .orderBy('l.createdAt').orderBy('l.messageId').execute()
      return [
        ...considered.map(row => ({
          ...row, disposition: row.disposition as SteeringDisposition,
          implementationCount: studioSafeInteger(row.implementationCount),
        })),
        ...pending.map(row => ({
          ...row, disposition: 'unresolved' as const, reviewMessageId: null,
          verifiedEffectAt: null, implementationSha: null, implementationCount: 0,
        })),
      ]
    },
  }
}
