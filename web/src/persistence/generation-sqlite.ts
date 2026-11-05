import { and, asc, count, desc, eq, exists, gt, lt, ne, isNull, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema'
import { generationRunQueue as runs, generationEvents as events, sessions, stories,
  repositories, storyThreadRuns } from '../db/schema'
import type { GenerationPersistence, GenerationQueueSqliteBridge,
  GenerationProgress, QueueRecord, QueueIntent } from './generation-contracts'

type StudioDrizzle = BetterSQLite3Database<typeof schema>
function assertOwner(owner: string) {
  if (!owner) throw new Error('Authenticated owner is required')
}
const changed = (result: { changes: number }) => result.changes === 1
const queueFields = {
  jobId: runs.jobId, ownerId: runs.ownerUserId, intent: runs.intent,
  phase: runs.phase, workerId: runs.workerId, sequence: runs.sequence,
}
const eventFields = {
  id: events.id, kind: events.kind, stage: events.stage,
  milestone: events.milestone, filesJson: events.filesJson,
  status: events.status, createdAt: events.createdAt,
}
const stateFields = {
  status: sessions.status, requestJson: sessions.generationRequestJson,
  threadId: sessions.generationThreadId, configJson: sessions.generationConfigJson,
}

/** Only this adapter knows how to acquire an SQLite writer lock. A future
 * PostgreSQL implementation must use a row-locking claim algorithm such as
 * SELECT FOR UPDATE SKIP LOCKED under a transaction, with capacity serialized
 * by an advisory/slot lock. Its implementation must preserve the same FIFO and
 * fencing contract. No await is permitted inside this adapter's transactions.
 * Better-sqlite3 uses BEGIN IMMEDIATE before counting running slots to avoid
 * the read-count / write-claim race across WAL connections.
 */
export function createSqliteGenerationPersistence(db: StudioDrizzle): GenerationPersistence {
  const record = (jobId: string): QueueRecord | null =>
    db.select(queueFields).from(runs).where(eq(runs.jobId, jobId)).get() ?? null
  const enqueue = (owner: string, jobId: string, intent: QueueIntent,
    expected: 'prepared' | 'paused', now: string, requestJson?: string, threadId?: string) => {
    assertOwner(owner)
    db.transaction(tx => {
      const row = tx.select(stateFields).from(sessions).where(and(
        eq(sessions.id, jobId), eq(sessions.ownerUserId, owner))).get()
      if (!row || row.status !== 'paused' ||
        (expected === 'prepared' ? row.requestJson !== null || row.threadId !== null :
          row.requestJson === null || row.threadId === null)) {
        throw new Error('Job state changed before scheduling. Inspect the saved generation.')
      }
      const existing = tx.select(queueFields).from(runs).where(eq(runs.jobId, jobId)).get()
      if (existing && existing.phase !== 'finished' && existing.phase !== 'interrupted')
        throw new Error('This job is already queued or executing.')
      if (existing?.phase === 'interrupted')
        throw new Error('An interrupted attempt requires operator reconciliation before retry.')
      if (expected === 'prepared') {
        if (!requestJson || !threadId) throw new Error('Missing pinned generation inputs.')
        const updated = tx.update(sessions).set({
          generationRequestJson: requestJson, generationThreadId: threadId, updatedAt: now,
        }).where(and(eq(sessions.id, jobId), eq(sessions.ownerUserId, owner),
          eq(sessions.status, 'paused'), isNull(sessions.generationRequestJson),
          isNull(sessions.generationThreadId))).run()
        if (!changed(updated)) throw new Error('Job state changed before scheduling.')
      }
      if (existing) tx.delete(runs).where(and(eq(runs.jobId, jobId),
        eq(runs.phase, 'finished'))).run()
      tx.insert(runs).values({
        jobId, ownerUserId: owner, intent, phase: 'queued',
        createdAt: now, updatedAt: now,
      }).run()
    }, { behavior: 'immediate' })
  }
  const bridge: GenerationQueueSqliteBridge = {
    record,
    enqueue,
    claim(workerId, limit, now) {
      if (!workerId || !Number.isSafeInteger(limit) || limit < 1)
        throw new Error('Invalid worker or scheduler capacity')
      return db.transaction(tx => {
        const occupied = tx.select({ total: count() }).from(runs)
          .where(eq(runs.phase, 'running')).get()!.total
        if (occupied >= limit) return null
        const oldest = tx.select(queueFields).from(runs).where(eq(runs.phase, 'queued'))
          .orderBy(asc(runs.sequence)).limit(1).get()
        if (!oldest) return null
        const updated = tx.update(runs).set({ phase: 'running', workerId, updatedAt: now })
          .where(and(eq(runs.jobId, oldest.jobId), eq(runs.phase, 'queued'))).run()
        if (!changed(updated)) throw new Error('Concurrent scheduler claim')
        return { ...oldest, phase: 'running', workerId }
      }, { behavior: 'immediate' })
    },
    finish(jobId, workerId, succeeded, now) {
      return changed(db.update(runs).set({
        phase: succeeded ? 'finished' : 'interrupted', updatedAt: now,
      }).where(and(eq(runs.jobId, jobId), eq(runs.phase, 'running'),
        eq(runs.workerId, workerId))).run())
    },
    foreignRunning(workerId) {
      return db.select({ jobId: runs.jobId, worker: runs.workerId }).from(runs)
        .where(and(eq(runs.phase, 'running'), ne(runs.workerId, workerId))).all()
    },
    interrupt(jobId, worker, now) {
      return changed(db.update(runs).set({ phase: 'interrupted', updatedAt: now })
        .where(and(eq(runs.jobId, jobId), eq(runs.phase, 'running'),
          worker === null ? isNull(runs.workerId) : eq(runs.workerId, worker))).run())
    },
    dequeue(owner, jobId) {
      assertOwner(owner)
      return changed(db.delete(runs).where(and(eq(runs.ownerUserId, owner),
        eq(runs.jobId, jobId), eq(runs.phase, 'queued'))).run())
    },
    reconcileAndEnqueue(owner, jobId, intent, saved, interrupted, now) {
      assertOwner(owner)
      // The queue change and paused-session reconciliation must commit as one
      // transaction. A stale worker claim cannot be silently converted to retry.
      db.transaction(tx => {
        const live = tx.select(stateFields).from(sessions).where(and(
          eq(sessions.id, jobId), eq(sessions.ownerUserId, owner))).get()
        if (!live || live.status !== saved.status ||
          live.requestJson !== saved.request || live.threadId !== saved.thread)
          throw new Error('Recovered job no longer matches verified checkpoint.')
        const existing = tx.select(queueFields).from(runs).where(eq(runs.jobId, jobId)).get()
        if (interrupted) {
          if (!existing || existing.phase !== 'interrupted' || existing.ownerId !== owner ||
            !changed(tx.delete(runs).where(and(eq(runs.jobId, jobId),
              eq(runs.ownerUserId, owner), eq(runs.phase, 'interrupted'))).run()))
            throw new Error('Interrupted attempt changed before recovery.')
        } else if (existing && existing.phase === 'interrupted') {
          throw new Error('Interrupted attempt requires operator reconciliation before retry.')
        }
        if (saved.status === 'running') {
          if (!interrupted || !changed(tx.update(sessions).set({
            status: 'paused', updatedAt: now,
          }).where(and(eq(sessions.id, jobId), eq(sessions.ownerUserId, owner),
            eq(sessions.status, 'running'), eq(sessions.generationRequestJson, saved.request),
            eq(sessions.generationThreadId, saved.thread))).run()))
            throw new Error('Recovered job no longer matches verified checkpoint.')
        } else if (saved.status !== 'paused') {
          throw new Error('Only paused generation can resume.')
        }
        const active = tx.select(queueFields).from(runs).where(eq(runs.jobId, jobId)).get()
        if (active && active.phase !== 'finished')
          throw new Error('This job is already queued or executing.')
        if (active) tx.delete(runs).where(and(eq(runs.jobId, jobId),
          eq(runs.phase, 'finished'))).run()
        tx.insert(runs).values({
          jobId, ownerUserId: owner, intent, phase: 'queued',
          createdAt: now, updatedAt: now,
        }).run()
      }, { behavior: 'immediate' })
    },
  }
  const progressBridge: GenerationProgress['sqliteBridge'] = {
    append(owner, jobId, row) {
      assertOwner(owner)
      db.insert(events).values({
        jobId, ownerUserId: owner, kind: row.kind, stage: row.stage,
        milestone: row.milestone, filesJson: row.filesJson,
        status: row.status, createdAt: row.createdAt,
      }).run()
    },
    after(owner, jobId, after, limit) {
      assertOwner(owner)
      return db.select(eventFields).from(events).where(and(
        eq(events.ownerUserId, owner), eq(events.jobId, jobId), gt(events.id, after)))
        .orderBy(asc(events.id)).limit(limit).all()
    },
    recent(owner, jobId, before, limit) {
      assertOwner(owner)
      return db.select(eventFields).from(events).where(and(
        eq(events.ownerUserId, owner), eq(events.jobId, jobId), lt(events.id, before)))
        .orderBy(desc(events.id)).limit(limit).all()
    },
    hasAfter(owner, jobId, after) {
      assertOwner(owner)
      return !!db.select({ id: events.id }).from(events).where(and(
        eq(events.ownerUserId, owner), eq(events.jobId, jobId), gt(events.id, after))).limit(1).get()
    },
  }
  return {
    queue: {
      sqliteTransactionBridge: bridge,
      async claim(workerId, limit, now) { return bridge.claim(workerId, limit, now) },
      async record(jobId) { return bridge.record(jobId) },
      async enqueue(owner, jobId, intent, expected, now, requestJson, threadId) {
        bridge.enqueue(owner, jobId, intent, expected, now, requestJson, threadId)
      },
      async finish(jobId, workerId, succeeded, now) { return bridge.finish(jobId, workerId, succeeded, now) },
      async foreignRunning(workerId) { return bridge.foreignRunning(workerId) },
      async interrupt(jobId, worker, now) { return bridge.interrupt(jobId, worker, now) },
      async dequeue(owner, jobId) { return bridge.dequeue(owner, jobId) },
      async reconcileAndEnqueue(owner, jobId, intent, saved, interrupted, now) {
        bridge.reconcileAndEnqueue(owner, jobId, intent, saved, interrupted, now)
      },
    },
    events: {
      sqliteBridge: progressBridge,
      async append(owner, jobId, row) { progressBridge.append(owner, jobId, row) },
      async after(owner, jobId, after, limit) { return progressBridge.after(owner, jobId, after, limit) },
      async recent(owner, jobId, before, limit) { return progressBridge.recent(owner, jobId, before, limit) },
      async hasAfter(owner, jobId, after) { return progressBridge.hasAfter(owner, jobId, after) },
    },
    jobs: {
      async selected(owner, jobId) {
          assertOwner(owner)
          return db.select({
            id: sessions.id, storyId: sessions.storyId, title: sessions.title,
            commitSha: sessions.sourceCommitSha, status: sessions.status,
            createdAt: sessions.createdAt, requestJson: sessions.generationRequestJson,
            threadId: sessions.generationThreadId, configJson: sessions.generationConfigJson,
            directory: stories.directory, provider: repositories.provider,
            providerId: repositories.providerRepositoryId,
          }).from(sessions).innerJoin(stories, and(
            eq(sessions.storyId, stories.id), eq(sessions.ownerUserId, stories.ownerUserId),
          )).innerJoin(repositories, and(
            eq(stories.repositoryId, repositories.id), eq(stories.ownerUserId, repositories.ownerUserId),
          )).where(and(eq(sessions.id, jobId), eq(sessions.ownerUserId, owner))).get() ?? null
      },
      async state(owner, jobId) {
        assertOwner(owner)
        return db.select(stateFields).from(sessions).where(and(eq(sessions.id, jobId),
          eq(sessions.ownerUserId, owner))).get() ?? null
      },
      async catalogStory(owner, storyId, provider) {
        assertOwner(owner)
        return db.select({
          id: stories.id, directory: stories.directory, title: stories.title,
          commitSha: stories.sourceCommitSha, contentSha256: stories.initialContentSha256,
          repository: repositories.name, providerId: repositories.providerRepositoryId,
        }).from(stories).innerJoin(repositories, and(
          eq(stories.repositoryId, repositories.id),
          eq(stories.ownerUserId, repositories.ownerUserId),
        )).where(and(eq(stories.id, storyId), eq(stories.ownerUserId, owner),
          eq(repositories.provider, provider))).get() ?? null
      },
      async identity(jobId) {
        return db.select({ storyId: sessions.storyId, ownerId: sessions.ownerUserId,
          commitSha: sessions.sourceCommitSha }).from(sessions).where(eq(sessions.id, jobId)).get() ?? null
      },
      async register(owner, jobId, storyId, title, commitSha, now) {
        assertOwner(owner)
        return changed(db.insert(sessions).values({
          id: jobId, ownerUserId: owner, storyId, title, sourceCommitSha: commitSha,
          status: 'paused', createdAt: now, updatedAt: now,
        }).onConflictDoUpdate({
          target: sessions.id, set: { updatedAt: now },
          setWhere: and(eq(sessions.ownerUserId, owner), eq(sessions.storyId, storyId),
            eq(sessions.sourceCommitSha, commitSha)),
        }).run())
      },
      async saveConfiguration(owner, jobId, configJson, now) {
        assertOwner(owner)
        return changed(db.update(sessions).set({
          generationConfigJson: configJson, updatedAt: now,
        }).where(and(eq(sessions.id, jobId), eq(sessions.ownerUserId, owner),
          eq(sessions.status, 'paused'), isNull(sessions.generationRequestJson))).run())
      },
      async increaseBudget(owner, jobId, oldJson, newJson, now) {
        assertOwner(owner)
        return changed(db.update(sessions).set({
          generationConfigJson: newJson, updatedAt: now,
        }).where(and(eq(sessions.id, jobId), eq(sessions.ownerUserId, owner),
          eq(sessions.status, 'paused'), eq(sessions.generationConfigJson, oldJson))).run())
      },
      async cancel(owner, jobId, now) {
        assertOwner(owner)
        db.update(sessions).set({ status: 'cancelled', updatedAt: now }).where(and(
          eq(sessions.id, jobId), eq(sessions.ownerUserId, owner))).run()
      },
      async authorDecision(owner, jobId, status, now) {
        assertOwner(owner)
        db.update(sessions).set({ status, updatedAt: now }).where(and(
          eq(sessions.id, jobId), eq(sessions.ownerUserId, owner),
          sql`${sessions.status} IN ('blocked','paused')`,
        )).run()
      },
      async start(owner, jobId, threadId, expectedRequest, workerId, now) {
        assertOwner(owner)
        // The durable worker lease must still be running for this job.
        const workerClaim = db.select({ jobId: runs.jobId }).from(runs).where(and(
          eq(runs.jobId, jobId), eq(runs.ownerUserId, owner), eq(runs.phase, 'running'),
          eq(runs.workerId, workerId)))
        return changed(db.update(sessions).set({
          status: 'running', updatedAt: now,
        }).where(and(eq(sessions.id, jobId), eq(sessions.ownerUserId, owner),
          eq(sessions.status, 'paused'), eq(sessions.generationThreadId, threadId),
          eq(sessions.generationRequestJson, expectedRequest),
          exists(workerClaim))).run())
      },
      async finish(owner, jobId, threadId, status, needsAuthor, workerId, now) {
        assertOwner(owner)
        return db.transaction(tx => {
          const worker = tx.select({ jobId: runs.jobId }).from(runs).where(and(
            eq(runs.jobId, jobId), eq(runs.ownerUserId, owner), eq(runs.phase, 'running'),
            eq(runs.workerId, workerId))).get()
          if (!worker) return false
          const result = tx.update(sessions).set({ status, updatedAt: now })
            .where(and(eq(sessions.id, jobId), eq(sessions.ownerUserId, owner),
              eq(sessions.generationThreadId, threadId), eq(sessions.status, 'running')))
            .run()
          if (!changed(result)) return false
          tx.update(storyThreadRuns).set({ needsAuthor }).where(and(
            eq(storyThreadRuns.jobId, jobId), eq(storyThreadRuns.ownerUserId, owner))).run()
          return true
        }, { behavior: 'immediate' })
      },
    },
  }
}
