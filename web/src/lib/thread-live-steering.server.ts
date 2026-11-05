import type { StudioDatabase } from '../db/connection'
import { activePiTurn, type ActivePiTurn } from '../../../src/live-pi-registry'
import { recordSteeringConsideration } from './thread-steering-replan.server'

type Pending = {
  id: string; owner: string; threadId: string; jobId: string
  content: string; sequence: number; mode: 'steer' | 'follow-up'
}
// Track in-flight SDK calls so turn settlement cannot overtake a just-queued
// delivery acknowledgement. A process crash is still handled by the durable
// dispatching receipt rather than replaying an ambiguous call.
const sdkCalls = new Map<string, Set<Promise<void>>>()

/** Synchronous cross-process turn ownership fence. The web process admits
 * against this SQLite snapshot, never an arbitrary later active specialist. */
export function recordPiTurnLifecycle(store: StudioDatabase, turn: ActivePiTurn,
  phase: 'registered' | 'closed') {
  store.sqlite.transaction(() => {
    if (phase === 'registered') {
      const inserted = store.sqlite.prepare(`INSERT INTO thread_active_pi_turns
        (job_id,pi_token,pi_session_id,work_item,created_at,expected_head)
        SELECT ?,?,?,?,?,? FROM generation_run_queue q
        WHERE q.job_id=? AND q.phase='running'`)
        .run(turn.jobId, turn.token, turn.session.sessionId, turn.workItem,
          new Date().toISOString(), turn.expectedHead, turn.jobId).changes
      if (inserted !== 1) throw new Error('Cannot register Pi outside a running generation job')
      return
    }
    // A steer accepted as this turn was closing goes back to the coordinator,
    // not to the next specialist. No SDK side effect was attempted.
    store.sqlite.prepare(`UPDATE thread_live_inputs SET state='deferred'
      WHERE source_job_id=? AND target_pi_token=? AND state='pending'`)
      .run(turn.jobId, turn.token)
    store.sqlite.prepare(`DELETE FROM thread_active_pi_turns
      WHERE job_id=? AND pi_token=?`).run(turn.jobId, turn.token)
  })()
}

/** On worker restart, old in-memory Pi turns cannot exist. Unsent messages
 * must be reconciled by the graph coordinator, never rebound to a new turn. */
export function recoverOrphanedPiTurns(store: StudioDatabase) {
  store.sqlite.transaction(() => {
    store.sqlite.prepare(`UPDATE thread_live_inputs SET state='deferred'
      WHERE state='pending' AND target_pi_token IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM thread_active_pi_turns t
          JOIN generation_run_queue q ON q.job_id=t.job_id AND q.phase='running'
          WHERE t.pi_token=thread_live_inputs.target_pi_token
            AND t.job_id=thread_live_inputs.source_job_id)`).run()
    store.sqlite.prepare(`DELETE FROM thread_active_pi_turns WHERE NOT EXISTS
      (SELECT 1 FROM generation_run_queue q
        WHERE q.job_id=thread_active_pi_turns.job_id AND q.phase='running')`).run()
    // A prior worker may have been killed mid-SDK call. Those instructions
    // are ambiguous and remain blocked until operator reconciliation.
    store.sqlite.prepare(`UPDATE thread_live_inputs SET state='blocked'
      WHERE state IN ('dispatching','sdk-queued')
        AND NOT EXISTS (SELECT 1 FROM thread_active_pi_turns t
          JOIN generation_run_queue q ON q.job_id=t.job_id AND q.phase='running'
          WHERE t.pi_token=thread_live_inputs.pi_token
            AND t.job_id=thread_live_inputs.source_job_id)`).run()
    store.sqlite.prepare(`UPDATE story_thread_messages SET phase='blocked'
      WHERE id IN (SELECT message_id FROM thread_live_inputs WHERE state='blocked')
        AND phase='queued'`).run()
  })()
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
  const pending = store.sqlite.prepare(`SELECT l.message_id AS id,l.owner_user_id AS owner,
    l.thread_id AS threadId,l.source_job_id AS jobId,m.body AS content,m.sequence,l.mode
    FROM thread_live_inputs l
    JOIN story_thread_messages m ON m.id=l.message_id AND m.owner_user_id=l.owner_user_id
      AND m.thread_id=l.thread_id
    JOIN generation_run_queue q ON q.job_id=l.source_job_id AND q.owner_user_id=l.owner_user_id
    WHERE l.state='pending' AND q.phase='running'
      AND m.phase='queued'
      AND EXISTS (SELECT 1 FROM thread_active_pi_turns t
        WHERE t.job_id=l.source_job_id AND t.pi_token=l.target_pi_token)
      AND NOT EXISTS (SELECT 1 FROM story_thread_message_cancellations c WHERE c.message_id=m.id)
      AND NOT EXISTS (SELECT 1 FROM story_thread_messages earlier
        WHERE earlier.thread_id=m.thread_id AND earlier.owner_user_id=m.owner_user_id
          AND earlier.role='user' AND earlier.sequence<m.sequence AND earlier.phase='queued'
          AND NOT EXISTS (SELECT 1 FROM story_thread_message_cancellations c
            WHERE c.message_id=earlier.id)
          AND NOT EXISTS (SELECT 1 FROM thread_live_inputs prior
            WHERE prior.message_id=earlier.id
              AND prior.source_job_id=l.source_job_id AND prior.state='sdk-queued'
              AND (prior.mode='steer' OR l.mode='follow-up')))
    ORDER BY m.sequence LIMIT 32`).all() as Pending[]
  for (const item of pending) {
    const turn = activePiTurn(item.jobId)
    if (!turn) continue
    const ownerTurn = store.sqlite.prepare(`SELECT pi_token AS token,pi_session_id AS sessionId
      FROM thread_active_pi_turns WHERE job_id=? AND pi_token=?`)
      .get(item.jobId, turn.token) as { token: string; sessionId: string } | undefined
    if (!ownerTurn || ownerTurn.sessionId !== turn.session.sessionId) continue
    const claimed = store.sqlite.prepare(`UPDATE thread_live_inputs SET
      state='dispatching',pi_token=?,pi_session_id=?
      WHERE message_id=? AND owner_user_id=? AND source_job_id=? AND state='pending'
        AND target_pi_token=?
        AND EXISTS (SELECT 1 FROM thread_active_pi_turns t
          WHERE t.job_id=thread_live_inputs.source_job_id
            AND t.pi_token=thread_live_inputs.target_pi_token)
        AND EXISTS (SELECT 1 FROM story_thread_messages m
          WHERE m.id=thread_live_inputs.message_id AND m.phase='queued'
          AND NOT EXISTS (SELECT 1 FROM story_thread_message_cancellations c WHERE c.message_id=m.id))`)
      .run(turn.token, turn.session.sessionId, item.id, item.owner, item.jobId, turn.token).changes
    if (!claimed) continue
    let attempted = false
    const call = (async () => {
      try {
        if (!turn.session.isStreaming || activePiTurn(item.jobId)?.token !== turn.token) {
          store.sqlite.prepare(`UPDATE thread_live_inputs SET state='deferred'
            WHERE message_id=? AND pi_token=? AND state='dispatching'`)
            .run(item.id, turn.token)
          return
        }
        // The SDK enforces the current tool/turn boundary. Its acceptance is
        // only a send receipt; the model may still never consume the message.
        attempted = true
        const result = item.mode === 'steer'
          ? await turn.session.steer(boundedInstruction(item))
          : await turn.session.followUp(boundedInstruction(item))
        if (result !== 'queued') throw new Error('SDK did not accept instruction')
        store.sqlite.prepare(`UPDATE thread_live_inputs SET state='sdk-queued'
          WHERE message_id=? AND pi_token=? AND state='dispatching'`)
          .run(item.id, turn.token)
      } catch {
        store.sqlite.transaction(() => {
          store.sqlite.prepare(`UPDATE thread_live_inputs SET state=?
            WHERE message_id=? AND pi_token=? AND state='dispatching'`)
            .run(attempted ? 'blocked' : 'deferred', item.id, turn.token)
          if (attempted) store.sqlite.prepare(`UPDATE story_thread_messages SET phase='blocked'
            WHERE id=? AND owner_user_id=? AND phase='queued'`).run(item.id, item.owner)
        })()
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
  const rows = store.sqlite.prepare(`SELECT l.message_id AS id,l.owner_user_id AS owner,
    l.thread_id AS threadId,l.source_job_id AS jobId,m.body AS content,m.sequence,
    l.state AS delivery,l.mode
    FROM thread_live_inputs l JOIN story_thread_messages m ON m.id=l.message_id
    WHERE l.source_job_id=? AND l.pi_token=? AND l.state IN ('dispatching','sdk-queued')`)
    .all(turn.jobId, turn.token) as Array<Pending & { delivery: string }>
  for (const row of rows) {
    const expected = boundedInstruction(row)
    const seen = turn.session.messages.some(message => {
      if (message.role !== 'user') return false
      const content = message.content
      return typeof content === 'string' ? content === expected
        : Array.isArray(content) && content.filter(part => part.type === 'text')
          .map(part => part.text).join('') === expected
    })
    store.sqlite.transaction(() => {
      const state = succeeded && seen && row.delivery === 'sdk-queued'
        ? 'delivered' : 'blocked'
      store.sqlite.prepare(`UPDATE thread_live_inputs SET state=?,
        delivered_at=CASE WHEN ?='delivered' THEN ? ELSE NULL END
        WHERE message_id=? AND pi_token=? AND state IN ('dispatching','sdk-queued')`)
        .run(state, state, new Date().toISOString(), row.id, turn.token)
      store.sqlite.prepare(`UPDATE story_thread_messages
        SET phase=?,status=CASE WHEN ?='delivered' THEN 'delivered' ELSE status END,
          job_id=CASE WHEN ?='delivered' THEN ? ELSE job_id END
        WHERE id=? AND owner_user_id=? AND phase='queued'`)
        .run(state === 'delivered' ? 'finished' : 'blocked', state, state, turn.jobId, row.id, row.owner)
      if (state === 'delivered') recordSteeringConsideration(store, row.id, row.owner,
        row.threadId, turn.jobId, row.content, turn.workItem)
    })()
  }
  // A pending instruction explicitly owned by this settled turn was never
  // sent. Keep it actionable for coordinator scope routing after the graph
  // settles, rather than delivering it to the next specialist session.
  store.sqlite.prepare(`UPDATE thread_live_inputs SET state='deferred'
    WHERE source_job_id=? AND target_pi_token=? AND state='pending'`)
    .run(turn.jobId, turn.token)
}

/** Record a separately reviewed effect only when a verified source commit is
 * already saved and a non-Pi reviewer supplies explicit supporting evidence.
 * This is intentionally not exposed as a model tool or HTTP mutation. */
export function recordIndependentSteeringReview(store: StudioDatabase, owner: string,
  threadId: string, messageId: string, reviewer: string, evidence: string) {
  if (!reviewer.trim() || reviewer.length > 128 || !evidence.trim() || evidence.length > 2000)
    throw new Error('Independent effect review requires reviewer and evidence')
  return store.sqlite.transaction(() => {
    const row = store.sqlite.prepare(`SELECT l.source_job_id AS jobId,m.verified_commit_sha AS sha
      FROM thread_live_inputs l JOIN story_thread_messages m ON m.id=l.message_id
      WHERE l.message_id=? AND l.owner_user_id=? AND l.thread_id=?
        AND l.state='delivered' AND m.verified_commit_sha IS NOT NULL`)
      .get(messageId, owner, threadId) as { jobId: string; sha: string } | undefined
    if (!row || !/^[a-f0-9]{40}$/.test(row.sha))
      throw new Error('Cannot verify an unacknowledged instruction or an unverified Story commit')
    const time = new Date().toISOString()
    store.sqlite.prepare(`INSERT OR IGNORE INTO thread_live_effect_reviews
      (message_id,owner_user_id,thread_id,job_id,commit_sha,reviewer,evidence,verified_at)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(messageId, owner, threadId, row.jobId, row.sha, reviewer.trim(), evidence.trim(), time)
    const saved = store.sqlite.prepare(`SELECT commit_sha AS sha,reviewer,evidence
      FROM thread_live_effect_reviews WHERE message_id=?`).get(messageId) as
      { sha: string; reviewer: string; evidence: string }
    if (saved.sha !== row.sha || saved.reviewer !== reviewer.trim() || saved.evidence !== evidence.trim())
      throw new Error('Effect review already exists with different evidence')
  })()
}

/** When the original graph finishes, no late steering may leak into a new job.
 * Undelivered (not sent to SDK) messages remain ordinary next-run follow-ups.
 * Ambiguous SDK dispatches block instead of being sent a second time. */
export function deferUndeliveredSteering(store: StudioDatabase, owner: string, jobId: string) {
  store.sqlite.prepare(`UPDATE thread_live_inputs SET state='deferred'
    WHERE owner_user_id=? AND source_job_id=? AND state='pending'`).run(owner, jobId)
  const stuck = store.sqlite.prepare(`SELECT message_id AS id FROM thread_live_inputs
    WHERE owner_user_id=? AND source_job_id=? AND state IN ('dispatching','sdk-queued')`)
    .all(owner, jobId) as Array<{ id: string }>
  for (const { id } of stuck) {
    store.sqlite.transaction(() => {
      store.sqlite.prepare(`UPDATE thread_live_inputs SET state='blocked'
        WHERE message_id=? AND state IN ('dispatching','sdk-queued')`).run(id)
      store.sqlite.prepare(`UPDATE story_thread_messages SET phase='blocked'
        WHERE id=? AND owner_user_id=? AND phase='queued'`).run(id, owner)
    })()
  }
}
