import type { Transaction } from 'kysely'
import type { QueryExecutor, SharedDatabase, WriteGuard } from '../db/kysely-connection'
import { studioSafeInteger, storedStudioBoolean } from '../db/kysely-values'
import type { StudioDb } from '../db/studio-db'
import { seedThreadMessagesKysely } from './thread-message-kysely'
import type {
  GenerationPersistence, QueueRecord, QueueIntent, JobState, ProgressRow,
  FinalizedTranscriptCandidate, KnownVerifierFix, IndexedVerifierStop, VerifierStop,
} from './generation-contracts'

type Read = QueryExecutor<StudioDb>
type Write = Transaction<StudioDb>
const job = (id: string): WriteGuard => ({ kind: 'job', id })
const changed = (value: { numUpdatedRows: bigint | number }) => Number(value.numUpdatedRows) === 1
const deleted = (value: { numDeletedRows: bigint | number }) => Number(value.numDeletedRows) === 1
const ownerRequired = (owner: string) => {
  if (!owner) throw new Error('Authenticated owner is required')
}

const queueColumns = ['jobId', 'ownerUserId as ownerId', 'intent', 'phase',
  'workerId', 'sequence', 'fixId'] as const

function queueValue(row: {
  jobId: string; ownerId: string; intent: string; phase: string
  workerId: string | null; sequence: number | string | bigint; fixId: string | null
}): QueueRecord {
  if (!['start', 'resume'].includes(row.intent) ||
      !['queued', 'running', 'finished', 'interrupted'].includes(row.phase))
    throw new Error('Persisted generation queue phase or intent is invalid.')
  return { ...row, intent: row.intent as QueueIntent, phase: row.phase as QueueRecord['phase'],
    sequence: studioSafeInteger(row.sequence) }
}

async function queueRecord(db: Read, jobId: string): Promise<QueueRecord | null> {
  const row = await db.selectFrom('generationRunQueue').select(queueColumns)
    .where('jobId', '=', jobId).executeTakeFirst()
  return row ? queueValue(row) : null
}

async function jobState(db: Read, owner: string, jobId: string): Promise<JobState | null> {
  ownerRequired(owner)
  const row = await db.selectFrom('studioSessions').select([
    'status', 'generationRequestJson as requestJson',
    'generationThreadId as threadId', 'generationConfigJson as configJson',
  ]).where('id', '=', jobId).where('ownerUserId', '=', owner).executeTakeFirst()
  return row ? { ...row, status: row.status as JobState['status'] } : null
}

async function assertNotDeleted(tx: Write, owner: string, jobId: string): Promise<void> {
  const blocked = await tx.selectFrom('storyThreadRuns as r')
    .innerJoin('storyThreads as t', join => join.onRef('t.id', '=', 'r.threadId')
      .onRef('t.ownerUserId', '=', 'r.ownerUserId'))
    .select('t.id').where('r.jobId', '=', jobId).where('r.ownerUserId', '=', owner)
    .where('t.deletedAt', 'is not', null).executeTakeFirst()
  if (blocked) throw new Error('Deleted Thread cannot start or resume generation.')
}

/** Caller holds the root writer lock and passes its transaction executor;
 * needed by both generation admission and Thread continuation. No independent
 * reader or nested transaction is opened while checking state and queue. */
export async function enqueueGenerationKysely(
  tx: Write, owner: string, jobId: string, intent: QueueIntent,
  expected: 'prepared' | 'paused', now: string, requestJson?: string, threadId?: string,
): Promise<void> {
  ownerRequired(owner)
  await assertNotDeleted(tx, owner, jobId)
  const row = await jobState(tx, owner, jobId)
  if (!row || row.status !== 'paused' ||
      (expected === 'prepared' ? row.requestJson !== null || row.threadId !== null :
        row.requestJson === null || row.threadId === null))
    throw new Error('Job state changed before scheduling. Inspect the saved generation.')
  const existing = await queueRecord(tx, jobId)
  if (existing && existing.phase !== 'finished' && existing.phase !== 'interrupted')
    throw new Error('This job is already queued or executing.')
  if (existing?.phase === 'interrupted')
    throw new Error('An interrupted attempt requires operator reconciliation before retry.')
  if (expected === 'prepared') {
    if (!requestJson || !threadId) throw new Error('Missing pinned generation inputs.')
    const updated = await tx.updateTable('studioSessions')
      .set({ generationRequestJson: requestJson, generationThreadId: threadId, updatedAt: now })
      .where('id', '=', jobId).where('ownerUserId', '=', owner).where('status', '=', 'paused')
      .where('generationRequestJson', 'is', null).where('generationThreadId', 'is', null)
      .executeTakeFirst()
    if (!changed(updated)) throw new Error('Job state changed before scheduling.')
  }
  if (existing) await tx.deleteFrom('generationRunQueue')
    .where('jobId', '=', jobId).where('ownerUserId', '=', owner).where('phase', '=', 'finished')
    .execute()
  await tx.insertInto('generationRunQueue').values({
    jobId, ownerUserId: owner, intent, phase: 'queued', createdAt: now, updatedAt: now,
  }).execute()
  const membership = await tx.selectFrom('storyThreadRuns').select('threadId')
    .where('jobId', '=', jobId).where('ownerUserId', '=', owner).executeTakeFirst()
  if (membership) await seedThreadMessagesKysely(tx, owner, membership.threadId)
}

const checkName = /^[a-z][a-z0-9.-]{1,100}$/
const digest = /^[a-f0-9]{64}$/
const sha = /^[a-f0-9]{40}$/
function validStop(stop: VerifierStop): boolean {
  return checkName.test(stop.check) && Number.isSafeInteger(stop.checkVersion) &&
    stop.checkVersion >= 1 && stop.checkVersion <= 10000 &&
    digest.test(stop.signature) && digest.test(stop.turnDigest) && sha.test(stop.sourceSha)
}
function indexedStop(row: {
  jobId: string; ownerUserId: string; threadId: string; checkId: string;
  checkVersion: number; failureSignature: string; sourceSha: string; turnDigest: string
}): IndexedVerifierStop {
  return { jobId: row.jobId, ownerId: row.ownerUserId, threadId: row.threadId,
    check: row.checkId, checkVersion: row.checkVersion, signature: row.failureSignature,
    sourceSha: row.sourceSha, turnDigest: row.turnDigest }
}

async function finalizedCandidates(
  db: Read, limit: number, offset: number, owner?: string, jobId?: string,
): Promise<FinalizedTranscriptCandidate[]> {
  let query = db.selectFrom('studioSessions as s')
    .innerJoin('generationRunQueue as q', join => join
      .onRef('q.jobId', '=', 's.id').onRef('q.ownerUserId', '=', 's.ownerUserId'))
    .innerJoin('storyThreadRuns as r', join => join
      .onRef('r.jobId', '=', 's.id').onRef('r.ownerUserId', '=', 's.ownerUserId'))
    .innerJoin('storyThreads as t', join => join
      .onRef('t.id', '=', 'r.threadId').onRef('t.ownerUserId', '=', 's.ownerUserId'))
    .leftJoin('githubPublications as gh', join => join
      .onRef('gh.jobId', '=', 's.id').onRef('gh.ownerUserId', '=', 's.ownerUserId'))
    .leftJoin('gitlabPublications as gl', join => join
      .onRef('gl.jobId', '=', 's.id').onRef('gl.ownerUserId', '=', 's.ownerUserId'))
    .select([
      's.ownerUserId as owner', 's.id as jobId', 'r.threadId as threadId',
      's.updatedAt as completedAt', 'gh.updatedAt as githubAt',
      'gh.headSha as githubHead', 'gh.phase as githubPhase',
      'gl.updatedAt as gitlabAt', 'gl.headSha as gitlabHead', 'gl.phase as gitlabPhase',
    ])
    .where('s.status', '=', 'completed').where('q.phase', '=', 'finished')
    .where('t.deletedAt', 'is', null).where('r.needsAuthor', '=', 0)
    .where(eb => eb.or([eb('gh.phase', '=', 'linked'), eb('gl.phase', '=', 'linked')]))
  if (owner) query = query.where('s.ownerUserId', '=', owner)
  if (jobId) query = query.where('s.id', '=', jobId)
  const rows = await query.orderBy('s.updatedAt').orderBy('s.id').limit(limit).offset(offset).execute()
  return rows.flatMap(row => {
    const linked = row.githubPhase === 'linked' && row.githubAt && row.githubHead
      ? { publishedAt: row.githubAt, publishedHead: row.githubHead }
      : row.gitlabPhase === 'linked' && row.gitlabAt && row.gitlabHead
        ? { publishedAt: row.gitlabAt, publishedHead: row.gitlabHead } : null
    return linked ? [{
      owner: row.owner, jobId: row.jobId, threadId: row.threadId,
      completedAt: row.completedAt, ...linked,
    }] : []
  })
}

const eventColumns = ['id', 'kind', 'stage', 'milestone', 'filesJson', 'status', 'createdAt'] as const
function eventValue(row: {
  id: number | bigint | string; kind: string; stage: string | null
  milestone: string | null; filesJson: string; status: string | null; createdAt: string
}): ProgressRow {
  if (!['started', 'working', 'verified', 'finished', 'interrupted'].includes(row.kind))
    throw new Error('Persisted generation event kind is invalid.')
  return { ...row, id: studioSafeInteger(row.id), kind: row.kind as ProgressRow['kind'] }
}

/** The global advisory transaction guard on PostgreSQL (and BEGIN IMMEDIATE on
 * SQLite) serializes ALL capacity counts, FIFO claims and recovery writes.
 * SKIP LOCKED alone would violate the global worker limit and oldest eligible
 * ordering. All domain algorithms stay shared between engines. */
export function createKyselyGenerationPersistence(db: SharedDatabase<StudioDb>): GenerationPersistence {
  return {
    queue: {
      record: jobId => queueRecord(db.read, jobId),
      async matchingVerifierStops(fix) {
        if (!checkName.test(fix.check) || !fix.id || !Number.isSafeInteger(fix.failedVersion))
          throw Error('Invalid deployed verifier fix')
        const rows = await db.read.selectFrom('generationVerifierStops as v')
          .innerJoin('studioSessions as s', join => join
            .onRef('s.id', '=', 'v.jobId').onRef('s.ownerUserId', '=', 'v.ownerUserId'))
          .innerJoin('generationRunQueue as q', join => join
            .onRef('q.jobId', '=', 'v.jobId').onRef('q.ownerUserId', '=', 'v.ownerUserId'))
          .innerJoin('storyThreadRuns as r', join => join
            .onRef('r.jobId', '=', 'v.jobId').onRef('r.ownerUserId', '=', 'v.ownerUserId'))
          .innerJoin('storyThreads as t', join => join
            .onRef('t.id', '=', 'r.threadId').onRef('t.ownerUserId', '=', 'v.ownerUserId'))
          .select(['v.jobId', 'v.ownerUserId', 'v.threadId', 'v.checkId',
            'v.checkVersion', 'v.failureSignature', 'v.sourceSha', 'v.turnDigest',
            'v.attemptedFixesJson'])
          .where('v.checkId', '=', fix.check).where('v.checkVersion', '=', fix.failedVersion)
          .where('s.status', '=', 'blocked').where('q.phase', '=', 'finished')
          .where('r.needsAuthor', '=', 0).where('t.deletedAt', 'is', null).execute()
        return rows.filter(row => {
          try {
            const attempted: unknown = JSON.parse(row.attemptedFixesJson)
            return Array.isArray(attempted) && attempted.every(v => typeof v === 'string') &&
              !attempted.includes(fix.id)
          } catch { return false }
        }).map(indexedStop)
      },
      async verifierStop(owner, jobId) {
        ownerRequired(owner)
        const row = await db.read.selectFrom('generationVerifierStops')
          .selectAll().where('ownerUserId', '=', owner).where('jobId', '=', jobId).executeTakeFirst()
        return row ? indexedStop(row) : null
      },
      async enqueueFix(owner, jobId, expected, fix, now) {
        ownerRequired(owner)
        if (!validStop(expected) || fix.check !== expected.check ||
            fix.failedVersion !== expected.checkVersion || !/^[a-z0-9][a-z0-9.-]{0,100}$/.test(fix.id))
          throw Error('Invalid source-bound verifier fix pairing')
        return db.withWriteTransaction([job(jobId)], async tx => {
          await assertNotDeleted(tx, owner, jobId)
          const row = await tx.selectFrom('generationVerifierStops').selectAll()
            .where('jobId', '=', jobId).where('ownerUserId', '=', owner).executeTakeFirst()
          const live = await jobState(tx, owner, jobId)
          const queue = await queueRecord(tx, jobId)
          const membership = await tx.selectFrom('storyThreadRuns as r')
            .innerJoin('storyThreads as t', join => join
              .onRef('t.id', '=', 'r.threadId').onRef('t.ownerUserId', '=', 'r.ownerUserId'))
            .select('r.threadId')
            .where('r.jobId', '=', jobId).where('r.ownerUserId', '=', owner)
            .where('r.needsAuthor', '=', 0).where('t.deletedAt', 'is', null)
            .executeTakeFirst()
          if (!membership || !row || !live || live.status !== 'blocked' || !live.requestJson ||
              live.threadId !== row.threadId || queue?.phase !== 'finished' ||
              queue.ownerId !== owner || queue.fixId === fix.id ||
              row.checkId !== expected.check || row.checkVersion !== expected.checkVersion ||
              row.failureSignature !== expected.signature || row.sourceSha !== expected.sourceSha ||
              row.turnDigest !== expected.turnDigest)
            return false
          const attempted: unknown = JSON.parse(row.attemptedFixesJson)
          if (!Array.isArray(attempted) || attempted.some(v => typeof v !== 'string') ||
              attempted.includes(fix.id)) return false
          const updated = await tx.updateTable('studioSessions').set({ status: 'paused', updatedAt: now })
            .where('id', '=', jobId).where('ownerUserId', '=', owner)
            .where('status', '=', 'blocked').where('generationThreadId', '=', row.threadId)
            .where('generationRequestJson', '=', live.requestJson).executeTakeFirst()
          if (!changed(updated)) return false
          await tx.updateTable('generationVerifierStops')
            .set({ attemptedFixesJson: JSON.stringify([...attempted, fix.id]) })
            .where('jobId', '=', jobId).where('ownerUserId', '=', owner).execute()
          await tx.deleteFrom('generationRunQueue')
            .where('jobId', '=', jobId).where('ownerUserId', '=', owner).where('phase', '=', 'finished')
            .execute()
          await tx.insertInto('generationRunQueue').values({
            jobId, ownerUserId: owner, intent: 'resume', fixId: fix.id,
            phase: 'queued', createdAt: now, updatedAt: now,
          }).execute()
          return true
        })
      },
      async enqueue(owner, jobId, intent, expected, now, requestJson, threadId) {
        ownerRequired(owner)
        await db.withWriteTransaction([job(jobId)], tx =>
          enqueueGenerationKysely(tx, owner, jobId, intent, expected, now, requestJson, threadId))
      },
      async claim(workerId, limit, now) {
        if (!workerId || !Number.isSafeInteger(limit) || limit < 1)
          throw new Error('Invalid worker or scheduler capacity')
        return db.withWriteTransaction([], async tx => {
          const occupied = await tx.selectFrom('generationRunQueue')
            .select(eb => eb.fn.countAll<string>().as('total'))
            .where('phase', '=', 'running').executeTakeFirstOrThrow()
          if (studioSafeInteger(occupied.total) >= limit) return null
          const oldest = await tx.selectFrom('generationRunQueue').select(queueColumns)
            .where('phase', '=', 'queued').orderBy('sequence').executeTakeFirst()
          if (!oldest) return null
          const claimed = await tx.updateTable('generationRunQueue')
            .set({ phase: 'running', workerId, updatedAt: now })
            .where('jobId', '=', oldest.jobId).where('phase', '=', 'queued')
            .executeTakeFirst()
          if (!changed(claimed)) throw new Error('Concurrent scheduler claim')
          return { ...queueValue(oldest), phase: 'running', workerId }
        })
      },
      async finish(jobId, workerId, succeeded, now) {
        return db.withWriteTransaction([job(jobId)], async tx =>
          changed(await tx.updateTable('generationRunQueue')
            .set({ phase: succeeded ? 'finished' : 'interrupted', updatedAt: now })
            .where('jobId', '=', jobId).where('phase', '=', 'running')
            .where('workerId', '=', workerId).executeTakeFirst()))
      },
      async foreignRunning(workerId) {
        return db.read.selectFrom('generationRunQueue')
          .select(['jobId', 'workerId as worker']).where('phase', '=', 'running')
          .where('workerId', '!=', workerId).execute()
      },
      async interrupt(jobId, worker, now) {
        return db.withWriteTransaction([job(jobId)], async tx =>
          changed(await tx.updateTable('generationRunQueue')
            .set({ phase: 'interrupted', updatedAt: now })
            .where('jobId', '=', jobId).where('phase', '=', 'running')
            .where('workerId', worker === null ? 'is' : '=', worker)
            .executeTakeFirst()))
      },
      async dequeue(owner, jobId) {
        ownerRequired(owner)
        return db.withWriteTransaction([job(jobId)], async tx =>
          deleted(await tx.deleteFrom('generationRunQueue')
            .where('ownerUserId', '=', owner).where('jobId', '=', jobId)
            .where('phase', '=', 'queued').executeTakeFirst()))
      },
      async reconcileAndEnqueue(owner, jobId, intent, saved, interrupted, now, verifiedBlocked = false) {
        ownerRequired(owner)
        await db.withWriteTransaction([job(jobId)], async tx => {
          await assertNotDeleted(tx, owner, jobId)
          const live = await jobState(tx, owner, jobId)
          if (!live || live.status !== saved.status ||
              live.requestJson !== saved.request || live.threadId !== saved.thread)
            throw new Error('Recovered job no longer matches verified checkpoint.')
          const existing = await queueRecord(tx, jobId)
          if (interrupted) {
            if (!existing || existing.phase !== 'interrupted' || existing.ownerId !== owner ||
                !deleted(await tx.deleteFrom('generationRunQueue')
                  .where('jobId', '=', jobId).where('ownerUserId', '=', owner)
                  .where('phase', '=', 'interrupted').executeTakeFirst()))
              throw new Error('Interrupted attempt changed before recovery.')
          } else if (existing?.phase === 'interrupted') {
            throw new Error('Interrupted attempt requires operator reconciliation before retry.')
          }
          if (verifiedBlocked && (saved.status !== 'blocked' || interrupted || intent !== 'resume'))
            throw new Error('Only an authenticated blocked original Thread may be readmitted.')
          if (saved.status === 'blocked') {
            if (!verifiedBlocked || !changed(await tx.updateTable('studioSessions')
              .set({ status: 'paused', updatedAt: now })
              .where('id', '=', jobId).where('ownerUserId', '=', owner)
              .where('status', '=', 'blocked')
              .where('generationRequestJson', '=', saved.request)
              .where('generationThreadId', '=', saved.thread).executeTakeFirst()))
              throw new Error('Blocked generation lacks verified original-Thread recovery.')
          } else if (saved.status === 'running') {
            if (!interrupted || !changed(await tx.updateTable('studioSessions')
              .set({ status: 'paused', updatedAt: now })
              .where('id', '=', jobId).where('ownerUserId', '=', owner)
              .where('status', '=', 'running')
              .where('generationRequestJson', '=', saved.request)
              .where('generationThreadId', '=', saved.thread).executeTakeFirst()))
              throw new Error('Recovered job no longer matches verified checkpoint.')
          } else if (saved.status !== 'paused') {
            throw new Error('Only paused generation can resume.')
          }
          const active = await queueRecord(tx, jobId)
          if (active && active.phase !== 'finished')
            throw new Error('This job is already queued or executing.')
          if (active) await tx.deleteFrom('generationRunQueue')
            .where('jobId', '=', jobId).where('ownerUserId', '=', owner)
            .where('phase', '=', 'finished').execute()
          await tx.insertInto('generationRunQueue').values({
            jobId, ownerUserId: owner, intent, phase: 'queued', createdAt: now, updatedAt: now,
          }).execute()
        })
      },
    },
    events: {
      async append(owner, jobId, row) {
        ownerRequired(owner)
        await db.withWriteTransaction([job(jobId)], async tx => {
          await tx.insertInto('generationEvents').values({
            jobId, ownerUserId: owner, kind: row.kind, stage: row.stage,
            milestone: row.milestone, filesJson: row.filesJson, status: row.status,
            createdAt: row.createdAt,
          }).execute()
        })
      },
      async after(owner, jobId, after, limit) {
        ownerRequired(owner)
        const rows = await db.read.selectFrom('generationEvents').select(eventColumns)
          .where('ownerUserId', '=', owner).where('jobId', '=', jobId)
          .where('id', '>', after).orderBy('id').limit(limit).execute()
        return rows.map(eventValue)
      },
      async recent(owner, jobId, before, limit) {
        ownerRequired(owner)
        const rows = await db.read.selectFrom('generationEvents').select(eventColumns)
          .where('ownerUserId', '=', owner).where('jobId', '=', jobId)
          .where('id', '<', before).orderBy('id', 'desc').limit(limit).execute()
        return rows.map(eventValue)
      },
      async hasAfter(owner, jobId, after) {
        ownerRequired(owner)
        return Boolean(await db.read.selectFrom('generationEvents').select('id')
          .where('ownerUserId', '=', owner).where('jobId', '=', jobId)
          .where('id', '>', after).executeTakeFirst())
      },
    },
    jobs: {
      finalizedTranscriptCandidates: (limit, offset, owner, jobId) =>
        finalizedCandidates(db.read, limit, offset, owner, jobId),
      async finalizedTranscriptCandidate(owner, jobId) {
        ownerRequired(owner)
        return (await finalizedCandidates(db.read, 1, 0, owner, jobId))[0] ?? null
      },
      async selected(owner, jobId) {
        ownerRequired(owner)
        const row = await db.read.selectFrom('studioSessions as s')
          .innerJoin('stories as st', join => join
            .onRef('st.id', '=', 's.storyId').onRef('st.ownerUserId', '=', 's.ownerUserId'))
          .innerJoin('repositories as r', join => join
            .onRef('r.id', '=', 'st.repositoryId').onRef('r.ownerUserId', '=', 'st.ownerUserId'))
          .select([
            's.id as id', 's.storyId as storyId', 's.title as title',
            's.sourceCommitSha as commitSha', 's.status as status',
            's.createdAt as createdAt', 's.generationRequestJson as requestJson',
            's.generationThreadId as threadId', 's.generationConfigJson as configJson',
            'st.directory as directory', 'r.provider as provider',
            'r.providerRepositoryId as providerId',
          ]).where('s.id', '=', jobId).where('s.ownerUserId', '=', owner).executeTakeFirst()
        return row ? { ...row, status: row.status as JobState['status'] } : null
      },
      state: (owner, jobId) => jobState(db.read, owner, jobId),
      async catalogStory(owner, storyId, provider) {
        ownerRequired(owner)
        return (await db.read.selectFrom('stories as st')
          .innerJoin('repositories as r', join => join
            .onRef('r.id', '=', 'st.repositoryId').onRef('r.ownerUserId', '=', 'st.ownerUserId'))
          .select([
            'st.id as id', 'st.directory as directory', 'st.title as title',
            'st.sourceCommitSha as commitSha', 'st.initialContentSha256 as contentSha256',
            'r.name as repository', 'r.providerRepositoryId as providerId',
          ]).where('st.id', '=', storyId).where('st.ownerUserId', '=', owner)
          .where('r.provider', '=', provider).executeTakeFirst()) ?? null
      },
      async identity(jobId) {
        const row = await db.read.selectFrom('studioSessions')
          .select(['storyId', 'ownerUserId as ownerId', 'sourceCommitSha as commitSha'])
          .where('id', '=', jobId).executeTakeFirst()
        return row ?? null
      },
      async register(owner, jobId, storyId, title, commitSha, now) {
        ownerRequired(owner)
        return db.withWriteTransaction([job(jobId)], async tx => {
          const row = await tx.insertInto('studioSessions').values({
            id: jobId, ownerUserId: owner, storyId, title,
            sourceCommitSha: commitSha, status: 'paused', createdAt: now, updatedAt: now,
          }).onConflict(oc => oc.column('id').doUpdateSet({ updatedAt: now })
            .where('studioSessions.ownerUserId', '=', owner)
            .where('studioSessions.storyId', '=', storyId)
            .where('studioSessions.sourceCommitSha', '=', commitSha))
            .returning('id').executeTakeFirst()
          return Boolean(row)
        })
      },
      async saveConfiguration(owner, jobId, configJson, now) {
        ownerRequired(owner)
        return db.withWriteTransaction([job(jobId)], async tx =>
          changed(await tx.updateTable('studioSessions')
            .set({ generationConfigJson: configJson, updatedAt: now })
            .where('id', '=', jobId).where('ownerUserId', '=', owner)
            .where('status', '=', 'paused').where('generationRequestJson', 'is', null)
            .executeTakeFirst()))
      },
      async increaseBudget(owner, jobId, oldJson, newJson, now) {
        ownerRequired(owner)
        return db.withWriteTransaction([job(jobId)], async tx =>
          changed(await tx.updateTable('studioSessions')
            .set({ generationConfigJson: newJson, updatedAt: now })
            .where('id', '=', jobId).where('ownerUserId', '=', owner)
            .where('status', '=', 'paused').where('generationConfigJson', '=', oldJson)
            .executeTakeFirst()))
      },
      async cancel(owner, jobId, now) {
        ownerRequired(owner)
        await db.withWriteTransaction([job(jobId)], tx =>
          tx.updateTable('studioSessions').set({ status: 'cancelled', updatedAt: now })
            .where('id', '=', jobId).where('ownerUserId', '=', owner).execute().then(() => undefined))
      },
      async authorDecision(owner, jobId, status, now) {
        ownerRequired(owner)
        await db.withWriteTransaction([job(jobId)], tx =>
          tx.updateTable('studioSessions').set({ status, updatedAt: now })
            .where('id', '=', jobId).where('ownerUserId', '=', owner)
            .where('status', 'in', ['blocked', 'paused']).execute().then(() => undefined))
      },
      async start(owner, jobId, threadId, expectedRequest, workerId, now) {
        ownerRequired(owner)
        return db.withWriteTransaction([job(jobId)], async tx =>
          changed(await tx.updateTable('studioSessions')
            .set({ status: 'running', updatedAt: now })
            .where('id', '=', jobId).where('ownerUserId', '=', owner)
            .where('status', '=', 'paused').where('generationThreadId', '=', threadId)
            .where('generationRequestJson', '=', expectedRequest)
            .where(eb => eb.exists(eb.selectFrom('generationRunQueue as q').select('q.jobId')
              .whereRef('q.jobId', '=', 'studioSessions.id')
              .whereRef('q.ownerUserId', '=', 'studioSessions.ownerUserId')
              .where('q.phase', '=', 'running').where('q.workerId', '=', workerId)))
            .executeTakeFirst()))
      },
      async finish(owner, jobId, threadId, status, needsAuthor, workerId, now, stop) {
        ownerRequired(owner)
        return db.withWriteTransaction([job(jobId)], async tx => {
          const active = await tx.selectFrom('generationRunQueue').select('jobId')
            .where('jobId', '=', jobId).where('ownerUserId', '=', owner)
            .where('phase', '=', 'running').where('workerId', '=', workerId)
            .executeTakeFirst()
          if (!active) return false
          const updated = await tx.updateTable('studioSessions')
            .set({ status, updatedAt: now })
            .where('id', '=', jobId).where('ownerUserId', '=', owner)
            .where('generationThreadId', '=', threadId)
            .where('status', '=', 'running').executeTakeFirst()
          if (!changed(updated)) return false
          await tx.updateTable('storyThreadRuns')
            .set({ needsAuthor: storedStudioBoolean(needsAuthor) })
            .where('jobId', '=', jobId).where('ownerUserId', '=', owner).execute()
          if (status === 'blocked' && !needsAuthor && stop) {
            if (!validStop(stop)) throw Error('Invalid verifier failure identity')
            const previous = await tx.selectFrom('generationVerifierStops').selectAll()
              .where('jobId', '=', jobId).where('ownerUserId', '=', owner).executeTakeFirst()
            const same = previous && previous.threadId === threadId &&
              previous.checkId === stop.check && previous.checkVersion === stop.checkVersion &&
              previous.failureSignature === stop.signature && previous.sourceSha === stop.sourceSha &&
              previous.turnDigest === stop.turnDigest
            await tx.insertInto('generationVerifierStops').values({
              jobId, ownerUserId: owner, threadId, checkId: stop.check,
              checkVersion: stop.checkVersion, failureSignature: stop.signature,
              sourceSha: stop.sourceSha, turnDigest: stop.turnDigest,
              attemptedFixesJson: same ? previous.attemptedFixesJson : '[]',
            }).onConflict(oc => oc.column('jobId').doUpdateSet({
              threadId, checkId: stop.check, checkVersion: stop.checkVersion,
              failureSignature: stop.signature, sourceSha: stop.sourceSha,
              turnDigest: stop.turnDigest,
              attemptedFixesJson: same ? previous!.attemptedFixesJson : '[]',
            })).execute()
          } else {
            await tx.deleteFrom('generationVerifierStops')
              .where('jobId', '=', jobId).where('ownerUserId', '=', owner).execute()
          }
          return true
        })
      },
    },
  }
}
