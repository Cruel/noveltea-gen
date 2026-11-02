import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import type { StudioDatabase } from '../db/connection'

export type QueueIntent = 'start' | 'resume'
export type QueuePhase = 'queued' | 'running' | 'finished' | 'interrupted'
export type QueueRecord = {
  jobId: string; ownerId: string; intent: QueueIntent; phase: QueuePhase
  workerId: string | null; sequence: number
}

// The LangGraph host is a single execution owner, not an HTTP worker pool.
// A new host instance cannot inherit an old instance's active run.
export const serverInstance = `${hostname()}:${process.pid}:${randomUUID()}`

export function activeLimit(): number {
  const raw = process.env.NT_STUDIO_MAX_ACTIVE_JOBS
  if (raw === undefined) return 2
  if (!/^[1-9][0-9]*$/.test(raw) || Number(raw) > 32)
    throw new Error('NT_STUDIO_MAX_ACTIVE_JOBS must be an integer from 1 to 32.')
  return Number(raw)
}

export function queueRecord(store: StudioDatabase, jobId: string): QueueRecord | undefined {
  return store.sqlite.prepare(`SELECT job_id AS jobId, owner_user_id AS ownerId,
    intent, phase, worker_id AS workerId, sequence
    FROM generation_run_queue WHERE job_id=?`).get(jobId) as QueueRecord | undefined
}

export function queueGeneration(store: StudioDatabase, owner: string, jobId: string,
  intent: QueueIntent, expected: 'prepared' | 'paused',
  requestJson?: string, threadId?: string): void {
  store.sqlite.transaction(() => {
    const row = store.sqlite.prepare(`SELECT status, generation_request_json AS request,
      generation_thread_id AS thread FROM studio_sessions WHERE id=? AND owner_user_id=?`)
      .get(jobId, owner) as { status: string; request: string | null; thread: string | null } | undefined
    if (!row || row.status !== 'paused' ||
      (expected === 'prepared' ? row.request !== null || row.thread !== null :
        row.request === null || row.thread === null)) {
      throw new Error('Job state changed before scheduling. Inspect the saved generation.')
    }
    const existing = queueRecord(store, jobId)
    if (existing && !['finished', 'interrupted'].includes(existing.phase))
      throw new Error('This job is already queued or executing.')
    if (existing?.phase === 'interrupted')
      throw new Error('An interrupted attempt requires operator reconciliation before retry.')
    if (expected === 'prepared') {
      if (!requestJson || !threadId) throw new Error('Missing pinned generation inputs.')
      store.sqlite.prepare(`UPDATE studio_sessions
        SET generation_request_json=?, generation_thread_id=?, updated_at=?
        WHERE id=? AND owner_user_id=?`)
        .run(requestJson, threadId, new Date().toISOString(), jobId, owner)
    }
    if (existing) {
      store.sqlite.prepare(`DELETE FROM generation_run_queue WHERE job_id=? AND phase='finished'`)
        .run(jobId)
    }
    const now = new Date().toISOString()
    store.sqlite.prepare(`INSERT INTO generation_run_queue
      (job_id, owner_user_id, intent, phase, created_at, updated_at)
      VALUES (?, ?, ?, 'queued', ?, ?)`).run(jobId, owner, intent, now, now)
  })()
}

/** Atomic SQLite-wide admission. A request cannot exceed the default two live jobs. */
export function claimNext(store: StudioDatabase): QueueRecord | null {
  return store.sqlite.transaction(() => {
    const occupied = (store.sqlite.prepare(`SELECT count(*) AS count FROM generation_run_queue
      WHERE phase='running'`).get() as { count: number }).count
    if (occupied >= activeLimit()) return null
    const row = store.sqlite.prepare(`SELECT job_id AS jobId, owner_user_id AS ownerId,
      intent, phase, worker_id AS workerId, sequence FROM generation_run_queue
      WHERE phase='queued' ORDER BY sequence LIMIT 1`).get() as QueueRecord | undefined
    if (!row) return null
    const updated = store.sqlite.prepare(`UPDATE generation_run_queue
      SET phase='running', worker_id=?, updated_at=?
      WHERE job_id=? AND phase='queued'`)
      .run(serverInstance, new Date().toISOString(), row.jobId)
    if (updated.changes !== 1) throw new Error('Concurrent scheduler claim')
    return { ...row, phase: 'running' as const, workerId: serverInstance }
  })()
}

export function finishAttempt(store: StudioDatabase, jobId: string, succeeded: boolean) {
  store.sqlite.prepare(`UPDATE generation_run_queue
    SET phase=?, updated_at=? WHERE job_id=? AND phase='running' AND worker_id=?`)
    .run(succeeded ? 'finished' : 'interrupted', new Date().toISOString(), jobId, serverInstance)
}

/** Never take over a writer merely because a worker ID differs. Other
 * processes may be alive against this same SQLite DB. Only a proven dead PID
 * on the identical host can free its slot, and even then its job is fenced as
 * interrupted rather than replayed. Unknown/other hosts require operator work. */
export function fenceAbandonedRuns(store: StudioDatabase): number {
  const rows = store.sqlite.prepare(`SELECT job_id AS jobId, worker_id AS worker
    FROM generation_run_queue WHERE phase='running' AND worker_id<>?`)
    .all(serverInstance) as Array<{ jobId: string; worker: string | null }>
  let count = 0
  for (const row of rows) {
    const pieces = row.worker?.split(':')
    if (pieces?.length !== 3 || pieces[0] !== hostname() ||
        !/^[1-9][0-9]*$/.test(pieces[1] ?? '')) continue
    const pid = Number(pieces[1])
    if (!Number.isSafeInteger(pid) || pid === process.pid) continue
    try { process.kill(pid, 0); continue }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue
    }
    count += store.sqlite.prepare(`UPDATE generation_run_queue
      SET phase='interrupted', updated_at=? WHERE job_id=? AND phase='running' AND worker_id=?`)
      .run(new Date().toISOString(), row.jobId, row.worker).changes
  }
  return count
}

export function dequeueBeforeStart(store: StudioDatabase, owner: string, jobId: string): boolean {
  return store.sqlite.prepare(`DELETE FROM generation_run_queue
    WHERE owner_user_id=? AND job_id=? AND phase='queued'`)
    .run(owner, jobId).changes === 1
}
