import type { StudioDatabase } from '../db/connection'
import { activePiTurn, type ActivePiTurn } from '../../../src/live-pi-registry'

type Pending = {
  id: string; owner: string; threadId: string; jobId: string
  content: string; sequence: number; mode: 'steer' | 'follow-up'
}
const marker = (id: string) => 'THREAD_STEERING_MESSAGE_ID=' + id
const boundedInstruction = (item: Pending) =>
  marker(item.id) + '\nCURRENT AUTHOR ' + (item.mode === 'steer' ? 'STEERING' : 'FOLLOW-UP') +
  ' (not new write authority):\n' +
  item.content + '\nHonor this guidance ONLY within your existing assigned targets, ' +
  'tool sandbox, and canonical protected-decision constraints. Do not modify ' +
  'other files, create new records, widen the completion contract, or treat this ' +
  'message as authorization to retcon protected decisions. Report a conflict ' +
  'instead of making any unauthorized change. Complete the original specialist ' +
  'assignment using its REQUIRED structured result format and validation; ' +
  'this message does not replace the assigned task.\n'

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
    const claimed = store.sqlite.prepare(`UPDATE thread_live_inputs SET
      state='dispatching',pi_token=?,pi_session_id=?
      WHERE message_id=? AND owner_user_id=? AND source_job_id=? AND state='pending'
        AND EXISTS (SELECT 1 FROM story_thread_messages m
          WHERE m.id=thread_live_inputs.message_id AND m.phase='queued'
          AND NOT EXISTS (SELECT 1 FROM story_thread_message_cancellations c WHERE c.message_id=m.id))`)
      .run(turn.token, turn.session.sessionId, item.id, item.owner, item.jobId).changes
    if (!claimed) continue
    try {
      if (!turn.session.isStreaming || activePiTurn(item.jobId)?.token !== turn.token)
        throw new Error('Pi turn ended before delivery')
      // The SDK enforces safe boundaries: steer waits for the completed tool
      // turn before the next LLM request; followUp waits until current task
      // settlement. Both stay inside the existing writer's scope and sandbox.
      const result = item.mode === 'steer'
        ? await turn.session.steer(boundedInstruction(item))
        : await turn.session.followUp(boundedInstruction(item))
      if (result !== 'queued')
        throw new Error('SDK did not queue this instruction in the active Pi turn')
      store.sqlite.prepare(`UPDATE thread_live_inputs SET state='sdk-queued'
        WHERE message_id=? AND pi_token=? AND state='dispatching'`)
        .run(item.id, turn.token)
    } catch {
      // Once dispatch was attempted, outcome is ambiguous; never replay it
      // into another session or new writer. Manual inspection remains possible.
      store.sqlite.transaction(() => {
        store.sqlite.prepare(`UPDATE thread_live_inputs SET state='blocked'
          WHERE message_id=? AND pi_token=? AND state='dispatching'`)
          .run(item.id, turn.token)
        store.sqlite.prepare(`UPDATE story_thread_messages SET phase='blocked'
          WHERE id=? AND owner_user_id=? AND phase='queued'`)
          .run(item.id, item.owner)
      })()
    }
  }
}

/** Called by the very wrapper that owns the SDK turn, after it settles. An
 * SDK-queued instruction counts as delivered only if the real transcript
 * contains the exact correlation marker; lack of evidence fails closed. */
export async function settlePiSteering(store: StudioDatabase, turn: ActivePiTurn, succeeded: boolean) {
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
    })()
  }
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
