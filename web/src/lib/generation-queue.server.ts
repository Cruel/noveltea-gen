import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import type { StudioDatabase } from '../db/connection'
import type { QueueIntent, QueueRecord } from '../persistence/generation-contracts'

export type { QueueIntent, QueuePhase, QueueRecord } from '../persistence/generation-contracts'

// A new agent incarnation cannot inherit the old process's writer lease.
export const serverInstance = `${hostname()}:${process.pid}:${randomUUID()}`

export function activeLimit(): number {
  const raw = process.env.NT_STUDIO_MAX_ACTIVE_JOBS
  if (raw === undefined) return 2
  if (!/^[1-9][0-9]*$/.test(raw) || Number(raw) > 32)
    throw new Error('NT_STUDIO_MAX_ACTIVE_JOBS must be an integer from 1 to 32.')
  return Number(raw)
}

/** Compatibility helpers for existing synchronous Thread transactions.
 * All storage and concurrency decisions are implemented by the Drizzle port.
 * New consumers should call the async store.persistence.generation.queue API.
 */
export function queueRecord(store: StudioDatabase, jobId: string): QueueRecord | undefined {
  return store.persistence.generation.queue.sqliteTransactionBridge.record(jobId) ?? undefined
}
export function queueGeneration(store: StudioDatabase, owner: string, jobId: string,
  intent: QueueIntent, expected: 'prepared' | 'paused',
  requestJson?: string, threadId?: string): void {
  store.persistence.generation.queue.sqliteTransactionBridge.enqueue(
    owner, jobId, intent, expected, new Date().toISOString(), requestJson, threadId)
}
/** Atomic across WAL connections: SQLite takes BEGIN IMMEDIATE before counting
 * slots and claiming the lowest-sequence queued job. */
export function claimNext(store: StudioDatabase): QueueRecord | null {
  return store.persistence.generation.queue.sqliteTransactionBridge.claim(
    serverInstance, activeLimit(), new Date().toISOString())
}
export function finishAttempt(store: StudioDatabase, jobId: string, succeeded: boolean): void {
  store.persistence.generation.queue.sqliteTransactionBridge.finish(
    jobId, serverInstance, succeeded, new Date().toISOString())
}

/** Unknown/foreign-host writers are not assumed dead. Only an observed dead
 * PID on this host (or the same PID with an obsolete instance nonce) can be
 * fenced, always to interrupted, NEVER re-enqueued or automatically replayed.
 */
export function fenceAbandonedRuns(store: StudioDatabase): number {
  const storage = store.persistence.generation.queue.sqliteTransactionBridge
  const rows = storage.foreignRunning(serverInstance)
  let count = 0
  for (const row of rows) {
    const pieces = row.worker?.split(':')
    if (pieces?.length !== 3 || pieces[0] !== hostname() ||
      !/^[1-9][0-9]*$/.test(pieces[1] ?? '')) continue
    const pid = Number(pieces[1])
    if (!Number.isSafeInteger(pid)) continue
    if (pid !== process.pid) {
      try { process.kill(pid, 0); continue }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue
      }
    }
    if (storage.interrupt(row.jobId, row.worker, new Date().toISOString())) count++
  }
  return count
}
export function dequeueBeforeStart(store: StudioDatabase, owner: string, jobId: string): boolean {
  return store.persistence.generation.queue.sqliteTransactionBridge.dequeue(owner, jobId)
}
