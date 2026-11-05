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

/** All application callers use the asynchronous persistence contract.
 * SQLite remains free to use a synchronous transaction internally.
 */
export async function queueRecord(store: StudioDatabase, jobId: string): Promise<QueueRecord | undefined> {
  return await store.persistence.generation.queue.record(jobId) ?? undefined
}
export async function queueGeneration(store: StudioDatabase, owner: string, jobId: string,
  intent: QueueIntent, expected: 'prepared' | 'paused',
  requestJson?: string, threadId?: string): Promise<void> {
  await store.persistence.generation.queue.enqueue(
    owner, jobId, intent, expected, new Date().toISOString(), requestJson, threadId)
}
export async function claimNext(store: StudioDatabase): Promise<QueueRecord | null> {
  return store.persistence.generation.queue.claim(
    serverInstance, activeLimit(), new Date().toISOString())
}
export async function finishAttempt(store: StudioDatabase, jobId: string,
  succeeded: boolean): Promise<void> {
  await store.persistence.generation.queue.finish(
    jobId, serverInstance, succeeded, new Date().toISOString())
}

/** Unknown/foreign-host writers are not assumed dead. Only an observed dead
 * PID on this host (or the same PID with an obsolete instance nonce) can be
 * fenced, always to interrupted, NEVER re-enqueued or automatically replayed.
 */
export async function fenceAbandonedRuns(store: StudioDatabase): Promise<number> {
  const storage = store.persistence.generation.queue
  const rows = await storage.foreignRunning(serverInstance)
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
    if (await storage.interrupt(row.jobId, row.worker, new Date().toISOString())) count++
  }
  return count
}
export async function dequeueBeforeStart(store: StudioDatabase, owner: string,
  jobId: string): Promise<boolean> {
  return store.persistence.generation.queue.dequeue(owner, jobId)
}
