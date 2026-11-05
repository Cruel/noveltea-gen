import { timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { StudioDatabase } from './db/connection'
import { assertStudioSchemaCurrent } from './db/migrations'
import { authorizedStoryJob } from './lib/fixture-jobs.server'
import { appendGenerationEvent } from './lib/generation-progress.server'
import { claimNext, finishAttempt, fenceAbandonedRuns, queueRecord } from './lib/generation-queue.server'
import { runPersistedGeneration } from './agent-runner'
import { recoverSettledThreadRuns, settleThreadRun } from './lib/thread-chat.server'
import { executeAuthorCommand } from './lib/agent-author-command.server'
import { validAuthorCommand } from './lib/agent-author-validation'
import { observePiTurnSettlement, observePiTurnLifecycle } from '../../src/live-pi-registry'
import { dispatchPendingPiSteering, settlePiSteering, recordPiTurnLifecycle,
  recoverOrphanedPiTurns } from './lib/thread-live-steering.server'

const inFlight = new Map<string, Promise<void>>()
const initialized = new WeakSet<StudioDatabase>()
let stopping = false

/** Test/agent lifecycle observer; never called from an authenticated HTTP route. */
export async function waitForAgentJob(store: StudioDatabase, jobId: string): Promise<void> {
  const running = inFlight.get(jobId)
  if (running) { await running; return }
  // Fixture execution can finish before its SSE event has been consumed.
  // Completion is durable even when the in-memory Promise has been released.
  if (queueRecord(store, jobId)?.phase === 'finished') return
  throw new Error('Job is neither executing nor durably finished in this agent instance.')
}

/** Agent-only queue consumer; the web server must never run or pump jobs. */
export function pumpAgentQueue(store: StudioDatabase) {
  if (stopping) return
  if (!initialized.has(store)) {
    // Never re-enter an unfinished writer from a previous server lifetime.
    fenceAbandonedRuns(store)
    recoverOrphanedPiTurns(store)
    initialized.add(store)
    // Crash-safe chat catch-up only; this does not resume an unfinished writer.
    void recoverSettledThreadRuns(store).catch(() => {
      console.error('[Studio] Some settled Thread messages need operator reconciliation')
    })
  }
  for (;;) {
    const record = claimNext(store)
    if (!record) break
    const task = runPersistedGeneration(store, record)
      .then(() => finishAttempt(store, record.jobId, true))
      .catch(() => {
        // Provider errors may include secrets. Only sanitized controller events
        // and original receipts, not raw exceptions, leave this task.
        finishAttempt(store, record.jobId, false)
        appendGenerationEvent(store, record.ownerId, record.jobId, { kind: 'interrupted' })
        throw new Error('Generation failed; preserve its original receipts for recovery.')
      })
      .finally(async () => {
        // Settlement also runs on failure. Never replace the original writer
        // outcome with a chat-generation error or automatically replay it.
        try { await settleThreadRun(store, record.ownerId, record.jobId) }
        catch { console.error('[Studio] Unable to settle Thread chat; retained durable queue state') }
        inFlight.delete(record.jobId)
        pumpAgentQueue(store)
      })
    inFlight.set(record.jobId, task)
    void task.catch(() => {})
  }
}

/** A private, explicitly authenticated application-to-agent command surface.
 * Neither browser requests nor arbitrary Agent Protocol commands reach here.
 * The job identity is resolved from the durable catalog, not caller paths. */
export function createAgentCommandServer(store: StudioDatabase, secret: string): Server {
  if (secret.length < 32) throw new Error('NT_AGENT_RPC_TOKEN must contain at least 32 characters.')
  assertStudioSchemaCurrent(store)
  return createServer(async (request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify(body))
    }
    const supplied = request.headers.authorization
    const actual = Buffer.from(typeof supplied === 'string' && supplied.startsWith('Bearer ')
      ? supplied.slice(7) : '')
    const expected = Buffer.from(secret)
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      send(401, { error: 'Unauthorized agent command' })
      return
    }
    if (request.url === '/health' && request.method === 'GET') {
      send(200, { status: 'ready' })
      return
    }
    if (request.url !== '/v1/author' || request.method !== 'POST') {
      send(404, { error: 'Unknown agent command' })
      return
    }
    try {
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of request) {
        bytes += (chunk as Buffer).length
        if (bytes > 8192) { send(413, { error: 'Agent command too large' }); return }
        chunks.push(chunk as Buffer)
      }
      const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        send(400, { error: 'Invalid agent command' }); return
      }
      const data = parsed as Record<string, unknown>
      if (Object.keys(data).some(k => !['ownerId', 'jobId', 'command'].includes(k)) ||
          typeof data.ownerId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.ownerId) ||
          typeof data.jobId !== 'string' || !/^[0-9a-f-]{36}$/i.test(data.jobId) ||
          !validAuthorCommand(data.command)) {
        send(400, { error: 'Invalid typed agent command' }); return
      }
      const job = await authorizedStoryJob(store, data.ownerId, data.jobId)
      const result = await executeAuthorCommand(job, 'user:' + data.ownerId, data.command)
      response.writeHead(result.status, { 'content-type': 'application/json',
        'cache-control': 'no-store' })
      response.end(await result.text())
    } catch {
      // No host paths, provider credentials, or Pi exceptions in RPC output.
      send(409, { error: 'Agent command could not be applied; inspect preserved job state.' })
    }
  })
}

/** Polls independently of HTTP requests and browser sessions. */
export function startAgentQueue(store: StudioDatabase, intervalMs = 250) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 10)
    throw new Error('Invalid agent polling interval.')
  assertStudioSchemaCurrent(store)
  stopping = false
  observePiTurnSettlement((turn, succeeded) => settlePiSteering(store, turn, succeeded))
  observePiTurnLifecycle((turn, phase) => recordPiTurnLifecycle(store, turn, phase))
  // Detect prior dead workers before taking new jobs. Never replay their
  // interrupted writers automatically; the existing reconciliation path owns that.
  pumpAgentQueue(store)
  const tick = () => {
    pumpAgentQueue(store)
    void dispatchPendingPiSteering(store).catch(() => {
      console.error('[Studio] Could not dispatch queued Pi steering; messages remain in their recorded state')
    })
  }
  const timer = setInterval(tick, intervalMs)
  return () => { stopping = true; clearInterval(timer) }
}

export async function startAgentServer(store: StudioDatabase, secret: string,
  port = 7001, host = '0.0.0.0') {
  const server = createAgentCommandServer(store, secret)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => { server.off('error', reject); resolve() })
  })
  const stopQueue = startAgentQueue(store)
  const address = server.address() as AddressInfo
  return {
    port: address.port,
    close: async () => {
      stopQueue()
      await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
      // A graceful termination must not close SQLite while a graph is still
      // writing. Docker may ultimately SIGKILL a long writer; the next agent
      // fences its durable attempt instead of blindly replaying it.
      await Promise.allSettled([...inFlight.values()])
    },
  }
}
