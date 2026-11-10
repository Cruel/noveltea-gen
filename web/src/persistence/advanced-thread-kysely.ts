import { randomUUID } from 'node:crypto'
import { sql, type Transaction } from 'kysely'
import type { QueryExecutor, SharedDatabase, WriteGuard } from '../db/kysely-connection'
import type { StudioDb } from '../db/studio-db'
import { studioSafeInteger } from '../db/kysely-values'
import { seedThreadMessagesKysely } from './thread-message-kysely'
import type {
  AdvancedThreadPersistence, ForkInheritedMessage, ForkIntent, ForkReservation,
  NewThreadChild, RecoveryContinuationRegistration, RestartIntent, RestartReservation,
  ThreadIdentity,
} from './advanced-thread-contracts'

type Read = QueryExecutor<StudioDb>
type Write = Transaction<StudioDb>
type Executor = Read | Write

function conflict(message: string): never { throw new Error(message) }
const required = (owner: string) => {
  if (!owner) conflict('Authenticated owner required.')
}
const thread = (id: string): WriteGuard => ({ kind: 'thread', id })
const job = (id: string): WriteGuard => ({ kind: 'job', id })

async function identity(db: Executor, owner: string, id: string): Promise<ThreadIdentity | null> {
  required(owner)
  return await db.selectFrom('storyThreads')
    .select(['id', 'parentThreadId as parent', 'storyId as story', 'title'])
    .where('id', '=', id).where('ownerUserId', '=', owner).executeTakeFirst() ?? null
}

async function ancestor(db: Executor, owner: string, id: string): Promise<ThreadIdentity | null> {
  const visited = new Set<string>()
  let row = await identity(db, owner, id)
  for (let n = 0; n < 64; n++) {
    if (!row) return null
    if (visited.has(row.id)) conflict('Thread ancestry contains a cycle.')
    visited.add(row.id)
    if (!row.parent) return row
    row = await identity(db, owner, row.parent)
  }
  throw new Error('Thread ancestry is too deep.')
}

async function requireNotDeleted(db: Executor, owner: string, id: string) {
  const row = await db.selectFrom('storyThreads').select('deletedAt')
    .where('id', '=', id).where('ownerUserId', '=', owner).executeTakeFirst()
  if (!row || row.deletedAt) conflict('Source Thread is deleted or no longer accessible.')
}

async function forkIntent(db: Executor, id: string): Promise<ForkIntent | null> {
  const row = await db.selectFrom('checkpointForks').select([
    'ownerUserId as owner', 'sourceJobId as source', 'sourceBaseSha as base',
    'commitSha', 'bundleJson as bundle', 'draftJson as draft', 'sourceThreadId',
    'proofDigest', 'guidance', 'historyJson as history', 'editedMessageId', 'editedBody',
  ]).where('childId', '=', id).executeTakeFirst()
  return row ?? null
}

async function restartIntent(db: Executor, id: string): Promise<RestartIntent | null> {
  const row = await db.selectFrom('threadRestarts').select([
    'ownerUserId as owner', 'sourceThreadId as sourceThread', 'sourceJobId as sourceJob',
    'rootJobId as rootJob', 'originalSha as original', 'mode', 'selectedSha as selected',
    'targetBranch as branch', 'draftJson as draft', 'preparedAt',
  ]).where('childId', '=', id).executeTakeFirst()
  return row ? { ...row, mode: row.mode as RestartIntent['mode'] } : null
}

async function jobClaimed(db: Executor, id: string) {
  return !!await db.selectFrom('studioSessions').select('id').where('id', '=', id).executeTakeFirst()
}

async function nextSequence(tx: Write, threadId: string) {
  const row = await tx.selectFrom('storyThreadMessages')
    .select(sql<number>`COALESCE(MAX("sequence"),-1)+1`.as('next'))
    .where('threadId', '=', threadId).executeTakeFirstOrThrow()
  return studioSafeInteger(row.next)
}

async function writeHistory(tx: Write, owner: string, threadId: string,
  inherited: ForkInheritedMessage[], guidance: string, at: string) {
  let sequence = 0
  for (const row of inherited) {
    await tx.insertInto('storyThreadMessages').values({
      id: randomUUID(), ownerUserId: owner, threadId, sequence: sequence++,
      role: row.role, status: 'delivered', body: row.body,
      originMessageId: row.originId, verifiedCommitSha: row.verifiedSha, createdAt: row.createdAt,
    }).execute()
  }
  if (guidance) await tx.insertInto('storyThreadMessages').values({
    id: 'guidance:' + threadId, ownerUserId: owner, threadId, sequence,
    role: 'user', status: 'queued', body: guidance, createdAt: at,
  }).execute()
}

async function run(db: Executor, owner: string, threadId: string, position: 'first' | 'last') {
  return await db.selectFrom('storyThreadRuns').select('jobId')
    .where('ownerUserId', '=', owner).where('threadId', '=', threadId)
    .orderBy('runOrder', position === 'first' ? 'asc' : 'desc').executeTakeFirst() ?? null
}

/** Shared implementation across both databases. Each operation uses the same
 * guarded executor and awaits every nested write. */
export function createKyselyAdvancedThreads(db: SharedDatabase<StudioDb>): AdvancedThreadPersistence {
  return {
    async importHistory(owner, threadId, history, guidance, at) {
      required(owner)
      await db.withWriteTransaction([thread(threadId)], async tx => {
        if (!await identity(tx, owner, threadId)) throw new Error('Thread not found.')
        if (await nextSequence(tx, threadId) !== 0)
          throw new Error('Fork history was already imported; do not rewrite immutable lineage.')
        await writeHistory(tx, owner, threadId, history, guidance, at)
      })
    },
    identity(owner, id) { return identity(db.read, owner, id) },
    ancestor(owner, id) { return ancestor(db.read, owner, id) },
    async run(owner, threadId, position) {
      required(owner)
      return run(db.read, owner, threadId, position)
    },
    async runOrder(owner, threadId, jobId) {
      required(owner)
      const row = await db.read.selectFrom('storyThreadRuns').select('runOrder')
        .where('jobId', '=', jobId).where('ownerUserId', '=', owner)
        .where('threadId', '=', threadId).executeTakeFirst()
      return row ? studioSafeInteger(row.runOrder) : null
    },
    async repository(owner, storyId) {
      required(owner)
      const row = await db.read.selectFrom('stories')
        .innerJoin('repositories', join => join
          .onRef('stories.repositoryId', '=', 'repositories.id')
          .onRef('stories.ownerUserId', '=', 'repositories.ownerUserId'))
        .select([
          'repositories.id as repositoryId', 'repositories.provider as provider',
          'repositories.providerRepositoryId as providerId', 'repositories.name as repository',
          'stories.directory as directory',
        ]).where('stories.id', '=', storyId).where('stories.ownerUserId', '=', owner)
        .executeTakeFirst()
      return row ? { ...row, provider: row.provider as 'github' | 'gitlab' } : null
    },
    async sourceThread(owner, jobId) {
      required(owner)
      return await db.read.selectFrom('storyThreadRuns')
        .innerJoin('storyThreads', join => join
          .onRef('storyThreads.id', '=', 'storyThreadRuns.threadId')
          .onRef('storyThreads.ownerUserId', '=', 'storyThreadRuns.ownerUserId'))
        .select(['storyThreadRuns.threadId as id', 'storyThreads.storyId as story'])
        .where('storyThreadRuns.jobId', '=', jobId)
        .where('storyThreadRuns.ownerUserId', '=', owner).executeTakeFirst() ?? null
    },
    async inspectJob(owner, jobId) {
      required(owner)
      const entry = await db.read.selectFrom('storyThreadRuns').select('threadId')
        .where('jobId', '=', jobId).where('ownerUserId', '=', owner).executeTakeFirst()
      const threadId = entry?.threadId ?? null
      const messages = threadId ? await db.read.selectFrom('storyThreadMessages')
        .select(['role', 'status', 'body', 'originMessageId', 'verifiedCommitSha', 'createdAt'])
        .where('ownerUserId', '=', owner).where('threadId', '=', threadId)
        .orderBy('sequence').execute() : []
      const row = await db.read.selectFrom('threadRestarts').select([
        'sourceThreadId', 'sourceJobId', 'rootJobId as originalJobId',
        'originalSha', 'selectedSha', 'mode', 'targetBranch',
      ]).where('childId', '=', jobId).where('ownerUserId', '=', owner)
        .where('preparedAt', 'is not', null).executeTakeFirst()
      return {
        threadId, messages: messages.map(m => ({
          ...m, role: m.role as 'user' | 'assistant', status: m.status as 'delivered' | 'queued',
        })),
        restart: row ? { ...row, mode: row.mode as 'original' | 'newer' } : null,
      }
    },
    async forkDraft(owner, childId) {
      required(owner)
      return await db.read.selectFrom('checkpointForks')
        .select(['bundleJson as bundle', 'draftJson as original'])
        .where('childId', '=', childId).where('ownerUserId', '=', owner)
        .executeTakeFirst() ?? null
    },
    jobClaimed(id) { return jobClaimed(db.read, id) },
    async forkIntent(owner, id) {
      required(owner)
      const receipt = await forkIntent(db.read, id)
      return receipt?.owner === owner ? receipt : null
    },
    async reserveFork(data: ForkReservation) {
      required(data.owner)
      return db.withWriteTransaction([thread(data.sourceThreadId), job(data.childId)], async tx => {
        if (await jobClaimed(tx, data.childId) || await restartIntent(tx, data.childId))
          conflict('Child identity was assigned concurrently.')
        const source = await tx.selectFrom('studioSessions').select(['storyId', 'sourceCommitSha as sha'])
          .where('id', '=', data.sourceJobId).where('ownerUserId', '=', data.owner)
          .executeTakeFirst()
        const parent = await identity(tx, data.owner, data.sourceThreadId)
        await requireNotDeleted(tx, data.owner, data.sourceThreadId)
        const sourceRun = await tx.selectFrom('storyThreadRuns').select('jobId')
          .where('jobId', '=', data.sourceJobId).where('ownerUserId', '=', data.owner)
          .where('threadId', '=', data.sourceThreadId).executeTakeFirst()
        if (!sourceRun || !source || source.sha !== data.sourceBaseSha ||
          !parent || parent.story !== source.storyId)
          conflict('Checkpoint source Story, owner, or pinned baseline changed.')
        await tx.insertInto('checkpointForks').values({
          childId: data.childId, ownerUserId: data.owner,
          sourceJobId: data.sourceJobId, sourceBaseSha: data.sourceBaseSha,
          commitSha: data.commitSha, bundleJson: data.bundle, draftJson: data.draft,
          createdAt: data.at, sourceThreadId: data.sourceThreadId,
          proofDigest: data.proofDigest, guidance: data.guidance, historyJson: data.history,
          editedMessageId: data.editedMessageId ?? null, editedBody: data.editedBody ?? null,
        }).onConflict(oc => oc.doNothing()).execute()
        const receipt = await forkIntent(tx, data.childId)
        if (!receipt || receipt.owner !== data.owner || receipt.source !== data.sourceJobId ||
          receipt.base !== data.sourceBaseSha || receipt.commitSha !== data.commitSha ||
          receipt.sourceThreadId !== data.sourceThreadId ||
          receipt.proofDigest !== data.proofDigest || receipt.guidance !== data.guidance ||
          receipt.editedMessageId !== (data.editedMessageId ?? null) ||
          receipt.editedBody !== (data.editedBody ?? null) ||
          receipt.bundle !== data.bundle || receipt.draft !== data.draft ||
          receipt.history !== data.history)
          conflict('Child ID was reserved for a different checkpoint or edit.')
        return receipt
      })
    },
    async restartIntent(owner, id) {
      required(owner)
      const receipt = await restartIntent(db.read, id)
      return receipt?.owner === owner ? receipt : null
    },
    async reserveRestart(data: RestartReservation) {
      required(data.owner)
      return db.withWriteTransaction([thread(data.sourceThread), job(data.childId)], async tx => {
        if (await jobClaimed(tx, data.childId) || await forkIntent(tx, data.childId))
          conflict('Child ID is already assigned to another operation.')
        const parent = await identity(tx, data.owner, data.sourceThread)
        await requireNotDeleted(tx, data.owner, data.sourceThread)
        const current = await tx.selectFrom('studioSessions').select('storyId')
          .where('id', '=', data.sourceJob).where('ownerUserId', '=', data.owner)
          .executeTakeFirst()
        const original = await tx.selectFrom('studioSessions').select(['storyId', 'sourceCommitSha as sha'])
          .where('id', '=', data.rootJob).where('ownerUserId', '=', data.owner)
          .executeTakeFirst()
        if (!parent || !current || !original || current.storyId !== parent.story ||
          original.storyId !== parent.story || original.sha !== data.original)
          conflict('Restart source Story or original pinned baseline changed.')
        const root = await ancestor(tx, data.owner, data.sourceThread)
        if (!root || root.story !== parent.story) conflict('Restart Thread ancestry changed.')
        const first = await run(tx, data.owner, root.id, 'first')
        const latest = await run(tx, data.owner, data.sourceThread, 'last')
        if (first?.jobId !== data.rootJob || latest?.jobId !== data.sourceJob)
          conflict('Restart pinned root or latest source run changed.')
        await tx.insertInto('threadRestarts').values({
          childId: data.childId, ownerUserId: data.owner,
          sourceThreadId: data.sourceThread, sourceJobId: data.sourceJob,
          rootJobId: data.rootJob, originalSha: data.original, mode: data.mode,
          selectedSha: data.selected, targetBranch: data.branch,
          draftJson: data.draft, createdAt: data.at,
        }).onConflict(oc => oc.doNothing()).execute()
        const receipt = await restartIntent(tx, data.childId)
        if (!receipt || receipt.owner !== data.owner ||
          receipt.sourceThread !== data.sourceThread || receipt.sourceJob !== data.sourceJob ||
          receipt.rootJob !== data.rootJob || receipt.original !== data.original ||
          receipt.mode !== data.mode || receipt.selected !== data.selected ||
          receipt.branch !== data.branch || receipt.draft !== data.draft)
          conflict('Restart reservation changed concurrently.')
        return receipt
      })
    },
    async preparedRestart(owner, childId, threadId) {
      required(owner)
      return !!await db.read.selectFrom('storyThreadRuns').select('jobId')
        .where('jobId', '=', childId).where('ownerUserId', '=', owner)
        .where('threadId', '=', threadId).executeTakeFirst()
    },
    async registerChild(data: NewThreadChild) {
      required(data.owner)
      return db.withWriteTransaction([thread(data.parentThreadId), thread(data.threadId),
        job(data.childId)], async tx => {
        const parent = await identity(tx, data.owner, data.parentThreadId)
        await requireNotDeleted(tx, data.owner, data.parentThreadId)
        if (!parent || parent.story !== data.storyId) conflict('Child parent Story identity changed.')
        const current = await tx.selectFrom('studioSessions')
          .select(['storyId', 'ownerUserId as owner', 'sourceCommitSha as commitSha'])
          .where('id', '=', data.childId).executeTakeFirst()
        if (current) {
          if (current.owner !== data.owner || current.storyId !== data.storyId ||
            current.commitSha !== data.baseSha)
            conflict('Previously prepared child differs from the saved source.')
          const registration = await tx.selectFrom('storyThreadRuns').select('jobId')
            .where('jobId', '=', data.childId).where('ownerUserId', '=', data.owner)
            .where('threadId', '=', data.threadId).executeTakeFirst()
          const registeredThread = await identity(tx, data.owner, data.threadId)
          if (!registration || !registeredThread ||
            registeredThread.parent !== data.parentThreadId ||
            registeredThread.story !== data.storyId)
            conflict('Existing child has incomplete or changed lineage registration.')
          return { inserted: false, storyId: current.storyId, commitSha: current.commitSha }
        }
        if (data.kind === 'restart') {
          const saved = await restartIntent(tx, data.childId)
          if (!saved) conflict('Restart intent changed during preparation.')
          if (saved.owner !== data.owner || saved.selected !== data.baseSha ||
            saved.sourceThread !== data.parentThreadId || saved.preparedAt)
            conflict('Restart intent changed during preparation.')
          const latest = await run(tx, data.owner, data.parentThreadId, 'last')
          const root = await ancestor(tx, data.owner, data.parentThreadId)
          const first = root && await run(tx, data.owner, root.id, 'first')
          const original = await tx.selectFrom('studioSessions').select('sourceCommitSha')
            .where('id', '=', saved.rootJob).where('ownerUserId', '=', data.owner)
            .executeTakeFirst()
          if (!root || root.story !== data.storyId ||
            first?.jobId !== saved.rootJob || latest?.jobId !== saved.sourceJob ||
            original?.sourceCommitSha !== saved.original)
            conflict('Thread advanced during restart preparation. Refresh before restarting.')
        } else {
          const saved = await forkIntent(tx, data.childId)
          if (!saved) conflict('Fork intent changed during preparation.')
          if (saved.owner !== data.owner || saved.commitSha !== data.baseSha ||
            saved.sourceThreadId !== data.parentThreadId)
            conflict('Fork intent changed during preparation.')
          const source = await tx.selectFrom('studioSessions').select(['storyId', 'sourceCommitSha as sha'])
            .where('id', '=', saved.source).where('ownerUserId', '=', data.owner)
            .executeTakeFirst()
          const sourceRun = await tx.selectFrom('storyThreadRuns').select('jobId')
            .where('jobId', '=', saved.source).where('ownerUserId', '=', data.owner)
            .where('threadId', '=', data.parentThreadId).executeTakeFirst()
          if (!sourceRun || !source || source.storyId !== data.storyId || source.sha !== saved.base)
            conflict('Fork source job changed before child registration.')
        }
        await tx.insertInto('studioSessions').values({
          id: data.childId, ownerUserId: data.owner, storyId: data.storyId, title: data.title,
          sourceCommitSha: data.baseSha, status: 'paused', createdAt: data.at,
          updatedAt: data.at, generationConfigJson: data.draft,
        }).execute()
        await tx.insertInto('storyThreads').values({
          id: data.threadId, ownerUserId: data.owner, storyId: data.storyId,
          parentThreadId: data.parentThreadId, title: data.title,
          activityAt: data.at, createdAt: data.at,
        }).execute()
        await tx.insertInto('storyThreadRuns').values({
          jobId: data.childId, ownerUserId: data.owner, threadId: data.threadId, runOrder: 0,
        }).execute()
        if (data.kind !== 'restart') {
          if (!data.history) conflict('Fork history snapshot is missing.')
          await writeHistory(tx, data.owner, data.threadId, data.history, data.guidance ?? '', data.at)
          if (data.kind === 'edit') {
            if (!data.editedMessageId || !data.editedBody) conflict('Edited message receipt missing.')
            await tx.insertInto('storyThreadMessages').values({
              id: 'edit:' + data.childId, ownerUserId: data.owner, threadId: data.threadId,
              sequence: await nextSequence(tx, data.threadId), role: 'user', status: 'queued',
              body: data.editedBody, originMessageId: data.editedMessageId,
              phase: 'queued', jobId: data.childId, createdAt: data.at,
            }).execute()
          }
        } else {
          await tx.updateTable('threadRestarts').set({ preparedAt: data.at })
            .where('childId', '=', data.childId).where('ownerUserId', '=', data.owner)
            .where('preparedAt', 'is', null).execute()
        }
        return { inserted: true, storyId: data.storyId, commitSha: data.baseSha }
      })
    },
    async registerRecoveryContinuation(data: RecoveryContinuationRegistration) {
      required(data.owner)
      return db.withWriteTransaction([thread(data.sourceThreadId), job(data.childId)], async tx => {
        const sourceThread = await identity(tx, data.owner, data.sourceThreadId)
        await requireNotDeleted(tx, data.owner, data.sourceThreadId)
        const archived = await tx.selectFrom('storyThreads').select('archivedAt')
          .where('id', '=', data.sourceThreadId).where('ownerUserId', '=', data.owner)
          .executeTakeFirst()
        if (archived?.archivedAt) conflict('Restore the archived Thread before continuing.')
        if (!sourceThread || sourceThread.story !== data.storyId)
          conflict('Recovery Thread identity has changed.')
        const intent = await forkIntent(tx, data.childId)
        if (!intent || intent.owner !== data.owner || intent.source !== data.sourceJobId ||
          intent.sourceThreadId !== data.sourceThreadId || intent.commitSha !== data.checkpointSha ||
          intent.draft !== data.draft || intent.guidance !== data.guidance)
          conflict('Recovery intent does not match the verified source.')
        const existing = await tx.selectFrom('studioSessions')
          .select(['ownerUserId as owner', 'storyId as story', 'sourceCommitSha as base'])
          .where('id', '=', data.childId).executeTakeFirst()
        if (existing) {
          const registration = await tx.selectFrom('storyThreadRuns').select('jobId')
            .where('jobId', '=', data.childId).where('ownerUserId', '=', data.owner)
            .where('threadId', '=', data.sourceThreadId).executeTakeFirst()
          if (!registration || existing.owner !== data.owner ||
            existing.story !== data.storyId || existing.base !== data.baseSha)
            conflict('Prepared recovery was registered under a different Thread.')
          return { inserted: false, storyId: data.storyId, commitSha: data.baseSha }
        }
        const current = await tx.selectFrom('storyThreadRuns')
          .innerJoin('studioSessions', join => join
            .onRef('studioSessions.id', '=', 'storyThreadRuns.jobId')
            .onRef('studioSessions.ownerUserId', '=', 'storyThreadRuns.ownerUserId'))
          .leftJoin('generationRunQueue', join => join
            .onRef('generationRunQueue.jobId', '=', 'storyThreadRuns.jobId')
            .onRef('generationRunQueue.ownerUserId', '=', 'storyThreadRuns.ownerUserId'))
          .select([
            'storyThreadRuns.jobId as jobId', 'storyThreadRuns.runOrder as runOrder',
            'studioSessions.status as status', 'generationRunQueue.phase as queuePhase',
          ]).where('storyThreadRuns.ownerUserId', '=', data.owner)
          .where('storyThreadRuns.threadId', '=', data.sourceThreadId)
          .orderBy('storyThreadRuns.runOrder', 'desc').executeTakeFirst()
        const expectedCurrent = data.expectedLatestJobId ?? data.sourceJobId
        let reusedGuidance = false
        if (!current || current.jobId !== expectedCurrent || current.status !== 'blocked' ||
          !['finished', 'interrupted'].includes(current.queuePhase ?? ''))
          conflict('The Thread has advanced or its failure is not safely recoverable.')
        if (expectedCurrent !== data.sourceJobId) {
          const failedIntent = await forkIntent(tx, expectedCurrent)
          if (!failedIntent || failedIntent.owner !== data.owner ||
            failedIntent.source !== data.sourceJobId ||
            failedIntent.sourceThreadId !== data.sourceThreadId ||
            failedIntent.commitSha !== data.checkpointSha)
            conflict('Failed continuation does not match the reviewed source checkpoint.')
          reusedGuidance = data.guidance === failedIntent.guidance
          const progress = await tx.selectFrom('generationEvents').select('id')
            .where('jobId', '=', expectedCurrent).where('ownerUserId', '=', data.owner)
            .where('kind', '=', 'verified').executeTakeFirst()
          if (progress)
            conflict('This continuation verified new work; review its own checkpoints before recovering.')
        }
        const pending = await tx.selectFrom('storyThreadMessages').select('id')
          .where('ownerUserId', '=', data.owner).where('threadId', '=', data.sourceThreadId)
          .where('role', '=', 'user').where('phase', 'in', ['queued', 'preparing', 'running'])
          .executeTakeFirst()
        if (pending) conflict('Resolve or withdraw queued instructions before recovering this Thread.')
        await tx.insertInto('studioSessions').values({
          id: data.childId, ownerUserId: data.owner, storyId: data.storyId,
          title: data.title, sourceCommitSha: data.baseSha, status: 'paused',
          createdAt: data.at, updatedAt: data.at, generationConfigJson: data.draft,
        }).execute()
        // Do not open a new transaction: this same executor reconciles any
        // original request before associating the continuation with its Turn.
        await seedThreadMessagesKysely(tx, data.owner, data.sourceThreadId, false)
        await tx.insertInto('storyThreadRuns').values({
          jobId: data.childId, ownerUserId: data.owner, threadId: data.sourceThreadId,
          runOrder: studioSafeInteger(current.runOrder) + 1,
        }).execute()
        if (!reusedGuidance) await tx.insertInto('storyThreadMessages').values({
          id: 'guidance:fork:' + data.childId,
          ownerUserId: data.owner, threadId: data.sourceThreadId,
          sequence: await nextSequence(tx, data.sourceThreadId),
          role: 'user', status: 'queued', phase: 'queued',
          body: data.guidance || 'Continue from the last verified checkpoint.',
          sourceJobId: data.sourceJobId, jobId: data.childId, createdAt: data.at,
        }).execute()
        await tx.updateTable('storyThreads').set({ activityAt: data.at })
          .where('id', '=', data.sourceThreadId).where('ownerUserId', '=', data.owner).execute()
        return { inserted: true, storyId: data.storyId, commitSha: data.baseSha }
      })
    },
    async history(owner, threadId, beforeSequence, beforeRunOrder) {
      required(owner)
      let query = db.read.selectFrom('storyThreadMessages')
        .select(['id', 'role', 'status', 'body', 'originMessageId as origin',
          'verifiedCommitSha as verifiedSha', 'createdAt'])
        .where('ownerUserId', '=', owner).where('threadId', '=', threadId)
      if (beforeSequence !== undefined) query = query.where('sequence', '<', beforeSequence)
      if (beforeRunOrder !== undefined) query = query.where(eb => eb.not(
        eb.exists(eb.selectFrom('storyThreadRuns as later')
          .select('later.jobId')
          .whereRef('later.jobId', '=', 'storyThreadMessages.jobId')
          .whereRef('later.ownerUserId', '=', 'storyThreadMessages.ownerUserId')
          .whereRef('later.threadId', '=', 'storyThreadMessages.threadId')
          .where('later.runOrder', '>', beforeRunOrder))))
      const rows = await query.orderBy('sequence').execute()
      return rows.map(row => ({
        ...row, role: row.role as 'user' | 'assistant',
        status: row.status as 'delivered' | 'queued',
      }))
    },
    async editable(owner, threadId, messageId) {
      required(owner)
      return await db.read.selectFrom('storyThreadMessages')
        .innerJoin('storyThreads', join => join
          .onRef('storyThreads.id', '=', 'storyThreadMessages.threadId')
          .onRef('storyThreads.ownerUserId', '=', 'storyThreadMessages.ownerUserId'))
        .select(['storyThreadMessages.id as id', 'storyThreadMessages.threadId as threadId',
          'storyThreadMessages.sequence as sequence', 'storyThreadMessages.role as role',
          'storyThreadMessages.status as status', 'storyThreadMessages.body as body',
          'storyThreadMessages.phase as phase', 'storyThreadMessages.jobId as jobId',
          'storyThreadMessages.sourceJobId as sourceJobId',
          'storyThreadMessages.originMessageId as origin'])
        .where('storyThreadMessages.ownerUserId', '=', owner)
        .where('storyThreadMessages.threadId', '=', threadId)
        .where('storyThreadMessages.id', '=', messageId).executeTakeFirst() ?? null
    },
    async origin(owner, messageId) {
      required(owner)
      return await db.read.selectFrom('storyThreadMessages')
        .select(['id', 'threadId', 'sequence', 'role', 'status', 'body',
          'phase', 'jobId', 'sourceJobId', 'originMessageId as origin'])
        .where('id', '=', messageId).where('ownerUserId', '=', owner)
        .executeTakeFirst() ?? null
    },
    async inheritedCount(owner, threadId, beforeSequence) {
      required(owner)
      const row = await db.read.selectFrom('storyThreadMessages')
        .select(eb => eb.fn.countAll<number>().as('total'))
        .where('ownerUserId', '=', owner).where('threadId', '=', threadId)
        .where('sequence', '<', beforeSequence).where('status', '=', 'delivered')
        .where('verifiedCommitSha', 'is not', null).executeTakeFirst()
      return studioSafeInteger(row?.total ?? 0)
    },
    async runJobs(owner, threadId) {
      required(owner)
      const rows = await db.read.selectFrom('storyThreadRuns')
        .innerJoin('storyThreads', join => join
          .onRef('storyThreads.id', '=', 'storyThreadRuns.threadId')
          .onRef('storyThreads.ownerUserId', '=', 'storyThreadRuns.ownerUserId'))
        .select('storyThreadRuns.jobId as jobId')
        .where('storyThreadRuns.ownerUserId', '=', owner)
        .where('storyThreadRuns.threadId', '=', threadId)
        .orderBy('storyThreadRuns.runOrder').execute()
      return rows.map(row => row.jobId)
    },
    async importAppliedMessage(owner, threadId, messageId, body, originalId, jobId, at) {
      required(owner)
      await db.withWriteTransaction([thread(threadId), job(jobId)], async tx => {
        const existing = await tx.selectFrom('storyThreadMessages')
          .select(['ownerUserId', 'threadId', 'body', 'originMessageId', 'jobId'])
          .where('id', '=', messageId).executeTakeFirst()
        if (existing) {
          if (existing.ownerUserId !== owner || existing.threadId !== threadId ||
            existing.body !== body || existing.originMessageId !== 'author-update:' + originalId ||
            existing.jobId !== jobId)
            conflict('Applied message ID already belongs to a different request.')
          return
        }
        if (!await identity(tx, owner, threadId)) conflict('Thread not found.')
        await tx.insertInto('storyThreadMessages').values({
          id: messageId, ownerUserId: owner, threadId,
          sequence: await nextSequence(tx, threadId), role: 'user', status: 'delivered',
          body, originMessageId: 'author-update:' + originalId,
          phase: 'finished', jobId, createdAt: at,
        }).execute()
      })
    },
  }
}
