import type { StudioStore as StudioDatabase } from '../persistence/store'
import { activePiTurn, type ActivePiTurn } from '../../../src/live-pi-registry'
import { classifySteeringIntent } from './thread-steering-replan.server'

type Pending = {
  id: string; owner: string; threadId: string; jobId: string
  content: string; sequence: number; mode: 'steer' | 'follow-up'
}
// Track in-flight SDK calls so turn settlement cannot overtake a just-queued
// delivery acknowledgement. A process crash is still handled by the durable
// dispatching receipt rather than replaying an ambiguous call.
const sdkCalls = new Map<string, Set<Promise<void>>>()

/** Durable cross-process turn fence. Registration is awaited before the SDK
 * exposes this turn to any queued steering dispatch. */
export async function recordPiTurnLifecycle(store: StudioDatabase, turn: ActivePiTurn,
  phase: 'registered' | 'closed') {
  const db = store.persistence.steering
  if (phase === 'registered') await db.registerTurn(turn.jobId, turn.token, turn.session.sessionId,
    turn.workItem, turn.expectedHead ?? null, new Date().toISOString())
  else await db.closeTurn(turn.jobId, turn.token)
}

/** On worker restart, old in-memory Pi turns cannot exist. Unsent messages
 * must be reconciled by the graph coordinator, never rebound to a new turn. */
export async function recoverOrphanedPiTurns(store: StudioDatabase) {
  await store.persistence.steering.recoverOrphaned()
}
const marker = (id: string) => 'THREAD_STEERING_MESSAGE_ID=' + id
const boundedInstruction = (item: Pending) =>
  marker(item.id) + '\nCURRENT AUTHOR ' + (item.mode === 'steer' ? 'STEERING' : 'FOLLOW-UP') +
  ' (not new write authority):\n' +
  item.content + '\nHonor this guidance ONLY within your existing assigned targets, ' +
  'tool sandbox, and canonical protected-decision constraints. Do not modify ' +
  'other files, create new records, widen the completion contract, or treat this ' +
  'message as authorization to retcon protected decisions. If this redirects ' +
  'work beyond your assigned scope, acknowledge the mismatch and defer those ' +
  'edits to the controller for reviewed replanning. Avoid drafting now-obsolete ' +
  'work when possible, but never claim the original assignment was fulfilled ' +
  'without its required evidence. Preserve the REQUIRED structured result ' +
  'format and validation; this message does not replace your authority.\n'

/** Agent-process-only: use the same SDK instance already executing under its
 * exclusive Story writer lease. This cannot start a Pi session or an agent
 * graph, and the model cannot choose the target session. */
export async function dispatchPendingPiSteering(store: StudioDatabase) {
  const pending = await store.persistence.steering.dispatchable()
  for (const item of pending) {
    const turn = activePiTurn(item.jobId)
    if (!turn) continue
    const ownerTurn = await store.persistence.steering.turn(item.jobId, turn.token)
    if (!ownerTurn || ownerTurn.sessionId !== turn.session.sessionId) continue
    const claimed = await store.persistence.steering.claim(item, turn.token, turn.session.sessionId)
    if (!claimed) continue
    let attempted = false
    const call = (async () => {
      try {
        if (!turn.session.isStreaming || activePiTurn(item.jobId)?.token !== turn.token) {
          await store.persistence.steering.deferUnsent(item.id, turn.token)
          return
        }
        // The SDK enforces the current tool/turn boundary. Its acceptance is
        // only a send receipt; the model may still never consume the message.
        attempted = true
        const result = item.mode === 'steer'
          ? await turn.session.steer(boundedInstruction(item))
          : await turn.session.followUp(boundedInstruction(item))
        if (result !== 'queued') throw new Error('SDK did not accept instruction')
        await store.persistence.steering.accepted(item.id, turn.token)
      } catch {
        await store.persistence.steering.blocked(item.id, item.owner, turn.token, attempted)
      }
    })()
    const calls = sdkCalls.get(turn.token) ?? new Set<Promise<void>>()
    calls.add(call)
    sdkCalls.set(turn.token, calls)
    try { await call } finally {
      calls.delete(call)
      if (!calls.size) sdkCalls.delete(turn.token)
    }
  }
}

/** Called by the very wrapper that owns the SDK turn, after it settles. An
 * SDK-queued instruction counts as delivered only if the real transcript
 * contains the exact correlation marker; lack of evidence fails closed. */
export async function settlePiSteering(store: StudioDatabase, turn: ActivePiTurn, succeeded: boolean) {
  // Settlement must not race an SDK call that was claimed immediately before
  // the specialist's last tool completed.
  await Promise.allSettled([...(sdkCalls.get(turn.token) ?? [])])
  const rows = await store.persistence.steering.settling(turn.jobId, turn.token)
  for (const row of rows) {
    const expected = boundedInstruction(row)
    const seen = turn.session.messages.some(message => {
      if (message.role !== 'user') return false
      const content = message.content
      return typeof content === 'string' ? content === expected
        : Array.isArray(content) && content.filter(part => part.type === 'text')
          .map(part => part.text).join('') === expected
    })
    const delivered = succeeded && seen && row.delivery === 'sdk-queued'
    await store.persistence.steering.settle(row, turn.token, delivered, turn.workItem,
      classifySteeringIntent(row.content, turn.workItem), new Date().toISOString())
  }
  // A pending instruction explicitly owned by this settled turn was never
  // sent. Keep it actionable for coordinator scope routing after the graph
  // settles, rather than delivering it to the next specialist session.
  await store.persistence.steering.deferTurn(turn.jobId, turn.token)
}

/** Record a separately reviewed effect only when a verified source commit is
 * already saved and a non-Pi reviewer supplies explicit supporting evidence.
 * This is intentionally not exposed as a model tool or HTTP mutation. */
export async function recordIndependentSteeringReview(store: StudioDatabase, owner: string,
  threadId: string, messageId: string, reviewer: string, evidence: string) {
  if (!reviewer.trim() || reviewer.length > 128 || !evidence.trim() || evidence.length > 2000)
    throw new Error('Independent effect review requires reviewer and evidence')
  await store.persistence.steering.review(owner, threadId, messageId,
    reviewer, evidence, new Date().toISOString())
}

/** When the original graph finishes, no late steering may leak into a new job.
 * Undelivered (not sent to SDK) messages remain ordinary next-run follow-ups.
 * Ambiguous SDK dispatches block instead of being sent a second time. */
export async function deferUndeliveredSteering(store: StudioDatabase, owner: string, jobId: string) {
  await store.persistence.steering.deferUndelivered(owner, jobId)
}
