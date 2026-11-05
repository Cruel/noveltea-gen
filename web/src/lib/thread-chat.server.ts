import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { StudioDatabase } from '../db/connection'
import { selectedJob, restoreJob, pinnedRequest, inspectRegisteredJob, verifyWebExecution } from './fixture-jobs.server'
import { trustedHead } from '../../../src/revision'
import { inspectRecoveryCheckpoints } from '../../../src/recovery-checkpoints'
import { continueCachedStory } from './git-cache.server'
import { assertServerClaimPermitted } from '../../../src/generation-owner'
import { queueGeneration, queueRecord } from './generation-queue.server'
import { deferUndeliveredSteering } from './thread-live-steering.server'
import { attributeSteeringCheckpoint, attributeApprovedReplanCheckpoint,
  prepareSteeringBoundaryReviews, steeringActivity } from './thread-steering-replan.server'
import { committedStoryFiles } from './generation-progress.server'
import { assertUserPiSelection, validPiSelection, type PiSelection } from './pi-credentials.server'
import type { GenerationRequest } from '../../../src/generation'
import type { GenerationDraft } from './generation-config.server'
import { assertPinnedRevision, revisionFromSource, submitThreadRevision, type PinnedRevision } from './story-revision.server'
import { assertProtectedThreadApproval, commitProtectedThreadChange,
  markProtectedThreadConsumed } from './thread-protected-decision.server'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

export class ThreadChatError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
export type ThreadMessage = {
  id: string; role: 'user' | 'assistant'; status: 'delivered' | 'queued'; content: string
  queuePriority: number
  phase: 'queued' | 'preparing' | 'running' | 'finished' | 'blocked' | 'cancelled'
  jobId: string | null; createdAt: string; sequence: number; hasRevisionScope: number
  cancelledAt: string | null
  liveMode: 'steer' | 'follow-up' | null
  liveState: 'pending' | 'dispatching' | 'sdk-queued' | 'delivered' | 'deferred' | 'blocked' | null
  effectVerifiedAt: string | null
  effectReviewer: string | null; effectEvidence: string | null; effectCommitSha: string | null
  liveSourceJobId: string | null; livePiSessionId: string | null
  liveWorkItem: string | null; liveDeliveredAt: string | null
  editCount: number
  editHistory?: Array<{ old: string; replacement: string; editedAt: string }>
}
type Run = { jobId: string; status: string; queuePhase: string | null; runOrder: number }
const now = () => new Date().toISOString()

// #79 assigns sequence numbers within each Thread (not globally). Reuse that
// contract so migrated checkpoint-fork history and later chat share one order.
function nextSequence(store: StudioDatabase, threadId: string): number {
  const row = store.sqlite.prepare(`SELECT COALESCE(MAX(sequence), -1) + 1 AS next
    FROM story_thread_messages WHERE thread_id=?`).get(threadId) as { next: number }
  return row.next
}
const messageColumns = `sequence,id,role,status,body AS content,
  COALESCE((SELECT original.sequence FROM thread_steering_intents intent
    JOIN story_thread_messages original ON original.id=intent.message_id
    WHERE intent.review_message_id=story_thread_messages.id), sequence) AS queuePriority,
  (revision_scope_json IS NOT NULL) AS hasRevisionScope,
  (SELECT c.cancelled_at FROM story_thread_message_cancellations c
    WHERE c.message_id=story_thread_messages.id) AS cancelledAt,
  CASE WHEN EXISTS (SELECT 1 FROM story_thread_message_cancellations c
      WHERE c.message_id=story_thread_messages.id) THEN 'cancelled'
    ELSE COALESCE(phase, CASE status WHEN 'queued' THEN 'queued' ELSE 'finished' END) END AS phase,
  job_id AS jobId,created_at AS createdAt,
  (SELECT l.mode FROM thread_live_inputs l WHERE l.message_id=story_thread_messages.id) AS liveMode,
  (SELECT l.state FROM thread_live_inputs l WHERE l.message_id=story_thread_messages.id) AS liveState,
  (SELECT r.verified_at FROM thread_live_effect_reviews r
    WHERE r.message_id=story_thread_messages.id) AS effectVerifiedAt,
  (SELECT r.reviewer FROM thread_live_effect_reviews r
    WHERE r.message_id=story_thread_messages.id) AS effectReviewer,
  (SELECT r.evidence FROM thread_live_effect_reviews r
    WHERE r.message_id=story_thread_messages.id) AS effectEvidence,
  (SELECT r.commit_sha FROM thread_live_effect_reviews r
    WHERE r.message_id=story_thread_messages.id) AS effectCommitSha,
  (SELECT l.source_job_id FROM thread_live_inputs l
    WHERE l.message_id=story_thread_messages.id) AS liveSourceJobId,
  (SELECT l.pi_session_id FROM thread_live_inputs l
    WHERE l.message_id=story_thread_messages.id) AS livePiSessionId,
  (SELECT l.target_work_item FROM thread_live_inputs l
    WHERE l.message_id=story_thread_messages.id) AS liveWorkItem,
  (SELECT l.delivered_at FROM thread_live_inputs l
    WHERE l.message_id=story_thread_messages.id) AS liveDeliveredAt,
  (SELECT COUNT(*) FROM thread_queued_message_edits e
    WHERE e.message_id=story_thread_messages.id) AS editCount`

function thread(store: StudioDatabase, owner: string, id: string) {
  const row = store.sqlite.prepare(`SELECT t.id,t.archived_at AS archivedAt,c.story_id AS storyId
    FROM story_threads t JOIN story_conversations c
    ON c.id=t.conversation_id AND c.owner_user_id=t.owner_user_id
    WHERE t.id=? AND t.owner_user_id=?`).get(id, owner) as
    { id: string; archivedAt: string | null; storyId: string } | undefined
  if (!row) throw new ThreadChatError(404, 'Thread not found.')
  return row
}
function currentRun(store: StudioDatabase, owner: string, id: string): Run | undefined {
  return store.sqlite.prepare(`SELECT r.job_id AS jobId,j.status,r.run_order AS runOrder,
      q.phase AS queuePhase FROM story_thread_runs r
    JOIN studio_sessions j ON j.id=r.job_id AND j.owner_user_id=r.owner_user_id
    LEFT JOIN generation_run_queue q ON q.job_id=r.job_id
    WHERE r.thread_id=? AND r.owner_user_id=? ORDER BY r.run_order DESC LIMIT 1`)
    .get(id, owner) as Run | undefined
}
function jobSummary(store: StudioDatabase, owner: string, jobId: string): string {
  const row = store.sqlite.prepare(`SELECT j.status,j.generation_request_json AS requestJson,
    q.phase AS queuePhase FROM studio_sessions j
    LEFT JOIN generation_run_queue q ON q.job_id=j.id
    WHERE j.id=? AND j.owner_user_id=?`).get(jobId, owner) as
    { status: string; requestJson: string | null; queuePhase: string | null } | undefined
  if (!row) return 'The run is unavailable. Inspect its saved job.'
  if (store.sqlite.prepare(`SELECT 1 FROM thread_protected_decisions
    WHERE message_id=? AND consumed_sha IS NOT NULL AND decision='approved'`).get(jobId))
    return 'The author-approved protected Creative Decision was changed in an isolated Thread and committed through verified native revision and trusted approval receipts.'
  const fixture = (() => {
    try { return (JSON.parse(row.requestJson ?? '{}') as { fixture?: boolean }).fixture === true }
    catch { return true }
  })()
  if (row.queuePhase === 'interrupted' || row.status === 'running')
    return 'The run was interrupted. Inspect the preserved worktree and receipts; do not automatically replay the writer.'
  if (row.status === 'completed')
    return fixture
      ? 'Fixture execution finished. Its output is not independently validated editorial completion.'
      : 'Generation run finished. Review the committed Story and validation evidence before editorial acceptance.'
  if (row.status === 'paused') return 'Generation paused. Open the run to inspect the required action or resume.'
  if (row.status === 'cancelled') return 'Generation cancelled. Saved files and receipts remain available for inspection.'
  return 'Generation blocked. Open the run for the saved error, evidence and recovery options.'
}
function insertAssistant(store: StudioDatabase, owner: string, threadId: string, jobId: string) {
  const content = jobSummary(store, owner, jobId)
  const latest = store.sqlite.prepare(`SELECT id,body FROM story_thread_messages
    WHERE owner_user_id=? AND thread_id=? AND role='assistant' AND job_id=?
    ORDER BY sequence DESC LIMIT 1`).get(owner, threadId, jobId) as
    { id: string; body: string } | undefined
  // Keep the old immutable summary, but publish a new one when an author
  // resumes a paused/blocked run and its independently settled outcome changes.
  if (latest?.body === content) return latest.id
  const event = store.sqlite.prepare(`SELECT id FROM generation_events
    WHERE owner_user_id=? AND job_id=? AND kind IN ('finished','interrupted')
    ORDER BY id DESC LIMIT 1`).get(owner, jobId) as { id: number } | undefined
  const signature = createHash('sha256').update(content).digest('hex').slice(0, 12)
  const id = latest ? `assistant:${jobId}:${event?.id ?? 'settlement'}:${signature}` : 'assistant:' + jobId
  store.sqlite.prepare(`INSERT OR IGNORE INTO story_thread_messages
    (id,owner_user_id,thread_id,sequence,role,status,body,phase,job_id,created_at)
    VALUES (?,?,?,?,'assistant','delivered',?,'finished',?,?)`)
    .run(id, owner, threadId, nextSequence(store, threadId), content, jobId, now())
  return id
}
function seedExistingMessages(store: StudioDatabase, owner: string, threadId: string) {
  const runs = store.sqlite.prepare(`SELECT r.job_id AS jobId,j.generation_request_json AS requestJson,
    j.status,q.phase AS queuePhase,r.run_order AS runOrder,
    j.source_commit_sha AS sourceSha FROM story_thread_runs r
    JOIN studio_sessions j ON j.id=r.job_id AND j.owner_user_id=r.owner_user_id
    LEFT JOIN generation_run_queue q ON q.job_id=j.id
    WHERE r.thread_id=? AND r.owner_user_id=? ORDER BY r.run_order`).all(threadId, owner) as
    Array<{ jobId: string; requestJson: string | null; status: string; queuePhase: string | null; runOrder: number; sourceSha: string | null }>
  for (const run of runs) {
    if (run.requestJson) {
      let task: unknown
      try { task = (JSON.parse(run.requestJson) as { task?: unknown }).task } catch { /* legacy corrupt request */ }
      if (typeof task === 'string' && task.trim() &&
          !store.sqlite.prepare(`SELECT 1 FROM story_thread_messages
            WHERE owner_user_id=? AND thread_id=? AND role='user'
              AND (job_id=? OR (?=0 AND job_id IS NULL)) LIMIT 1`)
            .get(owner, threadId, run.jobId, run.runOrder)) {
        store.sqlite.prepare(`INSERT OR IGNORE INTO story_thread_messages
          (id,owner_user_id,thread_id,sequence,role,status,body,phase,job_id,
            verified_commit_sha,created_at)
          VALUES (?,?,?,?,'user','delivered',?,'finished',?,?,
            (SELECT created_at FROM studio_sessions WHERE id=?))`)
          .run('initial:' + run.jobId, owner, threadId, nextSequence(store, threadId),
            task, run.jobId, run.sourceSha, run.jobId)
      }
    }
    if (run.queuePhase === 'finished' && ['completed', 'paused', 'blocked', 'cancelled'].includes(run.status))
      insertAssistant(store, owner, threadId, run.jobId)
  }
}

/** Immutable, serially ordered messages. Evidence is limited to controller-owned
 * finished/verified events, never raw Pi transcripts or editable working files. */
export function readThreadChat(store: StudioDatabase, owner: string, threadId: string) {
  const membership = thread(store, owner, threadId)
  store.sqlite.transaction(() => seedExistingMessages(store, owner, threadId))()
  const messages = store.sqlite.prepare(`SELECT ${messageColumns} FROM story_thread_messages
    WHERE owner_user_id=? AND thread_id=? ORDER BY sequence`)
    .all(owner, threadId) as ThreadMessage[]
  const edits = store.sqlite.prepare(`SELECT e.message_id AS messageId,e.old_body AS old,
    e.new_body AS replacement,e.edited_at AS editedAt FROM thread_queued_message_edits e
    WHERE e.owner_user_id=? AND e.thread_id=? ORDER BY e.rowid`)
    .all(owner, threadId) as Array<{ messageId: string; old: string; replacement: string; editedAt: string }>
  const history = new Map<string, Array<{ old: string; replacement: string; editedAt: string }>>()
  for (const { messageId, ...edit } of edits)
    history.set(messageId, [...(history.get(messageId) ?? []), edit])
  for (const message of messages) message.editHistory = history.get(message.id) ?? []
  const runs = store.sqlite.prepare(`SELECT r.job_id AS jobId,r.run_order AS runOrder,j.status,
    q.phase AS queuePhase,j.generation_request_json AS requestJson
    FROM story_thread_runs r JOIN studio_sessions j
      ON j.id=r.job_id AND j.owner_user_id=r.owner_user_id
    LEFT JOIN generation_run_queue q ON q.job_id=j.id
    WHERE r.owner_user_id=? AND r.thread_id=? ORDER BY r.run_order`)
    .all(owner, threadId) as Array<Run & { requestJson: string | null }>
  const evidence = store.sqlite.prepare(`SELECT e.job_id AS jobId,e.kind,e.stage,e.milestone,
    e.files_json AS filesJson,e.status,e.created_at AS createdAt FROM generation_events e
    JOIN story_thread_runs r ON r.job_id=e.job_id AND r.owner_user_id=e.owner_user_id
    WHERE r.thread_id=? AND r.owner_user_id=? AND e.kind IN ('verified','finished','interrupted')
    ORDER BY e.id`).all(threadId, owner) as Array<{
      jobId: string; kind: string; stage: string | null; milestone: string | null
      filesJson: string; status: string | null; createdAt: string
    }>
  return { threadId, storyId: membership.storyId, archived: !!membership.archivedAt,
    messages, steeringActivity: steeringActivity(store, owner, threadId),
    runs: runs.map(({ requestJson, ...run }) => ({
      ...run, status: run.queuePhase === 'interrupted' ? 'interrupted'
        : run.queuePhase === 'queued' ? 'queued'
        : run.queuePhase === 'running' ? 'running' : run.status,
      fixture: (() => {
        try { return (JSON.parse(requestJson ?? '{}') as { fixture?: boolean }).fixture === true }
        catch { return true }
      })(),
    })), evidence: evidence.map(({ filesJson, ...item }) => ({
      ...item, files: JSON.parse(filesJson) as string[],
    })) }
}

/** Durable idempotent admission. Multiple rapid posts preserve their order
 * without granting more than one active execution to the same Thread. */
export function enqueueThreadMessage(store: StudioDatabase, owner: string, threadId: string,
  id: string, content: string, mode?: 'steer' | 'follow-up'): ThreadMessage {
  if (!UUID.test(id) || typeof content !== 'string' || !content.trim() ||
      content.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(content))
    throw new ThreadChatError(400, 'Send a printable message of 1–4000 characters with a UUID.')
  return store.sqlite.transaction(() => {
    const membership = thread(store, owner, threadId)
    seedExistingMessages(store, owner, threadId)
    if (membership.archivedAt) throw new ThreadChatError(409, 'Restore the archived Thread before sending.')
    const existing = store.sqlite.prepare(`SELECT ${messageColumns}
      FROM story_thread_messages WHERE id=?`).get(id) as ThreadMessage | undefined
    if (existing) {
      const firstEdit = store.sqlite.prepare(`SELECT old_body AS body FROM thread_queued_message_edits
        WHERE message_id=? ORDER BY rowid LIMIT 1`).get(id) as { body: string } | undefined
      // A retry of the original POST after a queued edit must return the same
      // durable message, not reinsert or overwrite the author's later edit.
      if (existing.role !== 'user' ||
          existing.content !== content.trim() && firstEdit?.body !== content.trim() ||
          (mode !== undefined && existing.liveMode !== mode) ||
          !store.sqlite.prepare(`SELECT 1 FROM story_thread_messages
            WHERE id=? AND owner_user_id=? AND thread_id=?`).get(id, owner, threadId))
        throw new ThreadChatError(409, 'Message ID is already in use.')
      return existing
    }
    if (store.sqlite.prepare('SELECT 1 FROM studio_sessions WHERE id=?').get(id))
      throw new ThreadChatError(409, 'Message ID is already assigned to a job.')
    if (!currentRun(store, owner, threadId))
      throw new ThreadChatError(409, 'Create a generation run for this Thread before sending follow-ups.')
    const time = now()
    const run = currentRun(store, owner, threadId)!
    if (mode && (run.status !== 'running' || run.queuePhase !== 'running'))
      throw new ThreadChatError(409, 'Steer or Follow up is available only while a generation run is active.')
    store.sqlite.prepare(`INSERT INTO story_thread_messages
      (id,owner_user_id,thread_id,sequence,role,status,body,phase,created_at)
      VALUES (?,?,?,?,'user','queued',?,'queued',?)`)
      .run(id, owner, threadId, nextSequence(store, threadId), content.trim(), time)
    if (mode) {
      // The turn snapshot and message admission share SQLite's serialization
      // order across the web and agent processes. Never target a later Pi
      // specialist merely because it happens to be active at dispatch time.
      const target = store.sqlite.prepare(`SELECT t.pi_token AS token,t.work_item AS workItem,
        t.expected_head AS expectedHead FROM thread_active_pi_turns t
        JOIN generation_run_queue q ON q.job_id=t.job_id AND q.phase='running'
        WHERE t.job_id=? AND q.owner_user_id=?`).get(run.jobId, owner) as
        { token: string; workItem: string; expectedHead: string } | undefined
      store.sqlite.prepare(`INSERT INTO thread_live_inputs
        (message_id,owner_user_id,thread_id,source_job_id,mode,state,created_at,target_pi_token,target_work_item,submitted_head)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, owner, threadId, run.jobId, mode,
          target ? 'pending' : 'deferred', time, target?.token ?? null,
          target?.workItem ?? null, target?.expectedHead ?? null)
    }
    store.sqlite.prepare(`UPDATE story_threads SET activity_at=? WHERE id=? AND owner_user_id=?`)
      .run(time, threadId, owner)
    return store.sqlite.prepare(`SELECT ${messageColumns}
      FROM story_thread_messages WHERE id=?`).get(id) as ThreadMessage
  })()
}

/** Edits to messages not yet admitted to a writer or SDK are audited, not
 * silently rewritten in history. All existing scope reviews are invalidated.
 * Request IDs and expected text guard two-tab edits and HTTP retries. */
export function editQueuedThreadMessage(store: StudioDatabase, owner: string,
  threadId: string, id: string, requestId: string, expected: string, replacement: string): ThreadMessage {
  if (!UUID.test(id) || !UUID.test(requestId) || typeof expected !== 'string' ||
      typeof replacement !== 'string' || !replacement.trim() || replacement.length > 4000 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(replacement))
    throw new ThreadChatError(400, 'Invalid queued message edit.')
  return store.sqlite.transaction(() => {
    thread(store, owner, threadId)
    const read = () => store.sqlite.prepare(`SELECT ${messageColumns} FROM story_thread_messages
      WHERE id=? AND owner_user_id=? AND thread_id=?`).get(id, owner, threadId) as ThreadMessage | undefined
    const prior = store.sqlite.prepare(`SELECT message_id AS messageId,owner_user_id AS owner,
      thread_id AS threadId,old_body AS oldBody,new_body AS newBody
      FROM thread_queued_message_edits WHERE request_id=?`).get(requestId) as
      { messageId: string; owner: string; threadId: string; oldBody: string; newBody: string } | undefined
    if (prior) {
      if (prior.messageId !== id || prior.owner !== owner || prior.threadId !== threadId ||
          prior.oldBody !== expected || prior.newBody !== replacement.trim())
        throw new ThreadChatError(409, 'Edit request ID is already in use.')
      return read()!
    }
    const message = read()
    if (!message) throw new ThreadChatError(404, 'Queued Thread instruction not found.')
    if (message.role !== 'user' || message.phase !== 'queued' || message.jobId !== null ||
        ['dispatching','sdk-queued','delivered','blocked'].includes(message.liveState ?? '') ||
        store.sqlite.prepare(`SELECT 1 FROM story_thread_messages
          WHERE id=? AND source_job_id IS NOT NULL`).get(id) ||
        store.sqlite.prepare(`SELECT 1 FROM thread_protected_decisions
          WHERE message_id=?`).get(id))
      throw new ThreadChatError(409, 'This instruction is already admitted or approved and cannot be edited.')
    if (message.content !== expected || message.content === replacement.trim())
      throw new ThreadChatError(409, 'Queued message changed. Refresh the Thread before editing.')
    const time = now()
    store.sqlite.prepare(`INSERT INTO thread_queued_message_edits
      (request_id,message_id,owner_user_id,thread_id,old_body,new_body,edited_at)
      VALUES (?,?,?,?,?,?,?)`).run(requestId, id, owner, threadId, expected, replacement.trim(), time)
    store.sqlite.prepare(`UPDATE story_thread_messages SET body=?,revision_scope_json=NULL
      WHERE id=? AND owner_user_id=? AND thread_id=? AND phase='queued'`)
      .run(replacement.trim(), id, owner, threadId)
    store.sqlite.prepare(`UPDATE story_threads SET activity_at=?
      WHERE id=? AND owner_user_id=?`).run(time, threadId, owner)
    return read()!
  })()
}

/** Append-only cancellation receipt. The queued message and sequence are never
 * edited or reused; only an unadmitted, owner-scoped instruction is cancelable.
 * A concurrent writer claim and cancellation are serialized by SQLite. */
export function cancelQueuedThreadMessage(store: StudioDatabase, owner: string,
  threadId: string, id: string): ThreadMessage {
  if (!UUID.test(id)) throw new ThreadChatError(400, 'Invalid queued message identity.')
  return store.sqlite.transaction(() => {
    thread(store, owner, threadId)
    const read = () => store.sqlite.prepare(`SELECT ${messageColumns}
      FROM story_thread_messages WHERE id=? AND thread_id=? AND owner_user_id=?`)
      .get(id, threadId, owner) as ThreadMessage | undefined
    const message = read()
    if (!message) throw new ThreadChatError(404, 'Queued Thread instruction not found.')
    if (message.role !== 'user') throw new ThreadChatError(409, 'Only author instructions can be cancelled.')
    if (message.phase === 'cancelled') return message
    if (message.phase !== 'queued' || message.jobId !== null ||
        ['dispatching','sdk-queued','delivered'].includes(message.liveState ?? '') ||
        store.sqlite.prepare(`SELECT 1 FROM story_thread_messages
          WHERE id=? AND source_job_id IS NOT NULL`).get(id))
      throw new ThreadChatError(409, 'The instruction has entered execution and cannot be cancelled.')
    const time = now()
    store.sqlite.prepare(`INSERT INTO story_thread_message_cancellations
      (message_id,owner_user_id,thread_id,cancelled_at) VALUES (?,?,?,?)`)
      .run(id, owner, threadId, time)
    store.sqlite.prepare(`UPDATE story_threads SET activity_at=?
      WHERE id=? AND owner_user_id=?`).run(time, threadId, owner)
    return read()!
  })()
}

type Admission = { id: string; content: string; source: string; runOrder: number; scopeJson: string | null }
/** An atomic SQLite claim is the only path from queued user message to a new
 * worktree. A crash mid-preparation leaves an inspectable, non-replayed claim. */
function claimMessage(store: StudioDatabase, owner: string, threadId: string): Admission | null {
  return store.sqlite.transaction(() => {
    const run = currentRun(store, owner, threadId)
    if (!run || run.status !== 'completed' || run.queuePhase !== 'finished') return null
    if (store.sqlite.prepare(`SELECT 1 FROM story_thread_messages
      WHERE owner_user_id=? AND thread_id=? AND role='user'
      AND phase IN ('preparing','running','blocked') LIMIT 1`).get(owner, threadId)) return null
    const next = store.sqlite.prepare(`SELECT m.id,m.body AS content,m.revision_scope_json AS scopeJson
      FROM story_thread_messages m WHERE m.owner_user_id=? AND m.thread_id=?
        AND m.role='user' AND m.phase='queued'
        AND NOT EXISTS (SELECT 1 FROM story_thread_message_cancellations c WHERE c.message_id=m.id)
      ORDER BY COALESCE((SELECT original.sequence FROM thread_steering_intents intent
        JOIN story_thread_messages original ON original.id=intent.message_id
        WHERE intent.review_message_id=m.id),m.sequence), m.sequence LIMIT 1`).get(owner, threadId) as
      { id: string; content: string; scopeJson: string | null } | undefined
    if (!next || !next.scopeJson) return null
    const changed = store.sqlite.prepare(`UPDATE story_thread_messages SET phase='preparing',
      source_job_id=? WHERE id=? AND owner_user_id=? AND phase='queued'
        AND NOT EXISTS (SELECT 1 FROM story_thread_message_cancellations c WHERE c.message_id=story_thread_messages.id)`)
      .run(run.jobId, next.id, owner).changes
    if (changed !== 1) return null
    return { ...next, source: run.jobId, runOrder: run.runOrder + 1 }
  })()
}

export async function advanceThread(store: StudioDatabase, owner: string, threadId: string): Promise<void> {
  const candidate = store.sqlite.prepare(`SELECT m.id,m.body AS content,m.revision_scope_json AS scope
    FROM story_thread_messages m WHERE m.owner_user_id=? AND m.thread_id=?
      AND m.role='user' AND m.phase='queued'
      AND NOT EXISTS (SELECT 1 FROM story_thread_message_cancellations c WHERE c.message_id=m.id)
    ORDER BY COALESCE((SELECT original.sequence FROM thread_steering_intents intent
      JOIN story_thread_messages original ON original.id=intent.message_id
      WHERE intent.review_message_id=m.id),m.sequence),m.sequence LIMIT 1`)
    .get(owner, threadId) as { id: string; content: string; scope: string | null } | undefined
  const source = currentRun(store, owner, threadId)
  if (candidate && !candidate.scope && source?.status === 'completed' && source.queuePhase === 'finished') {
    try { await submitThreadRevision(store, owner, threadId, candidate.id, candidate.content) }
    catch {
      // Keep the instruction durably queued for an explicit scope review;
      // never treat the missing approval as a failed or interrupted writer.
      return
    }
  }
  const claim = claimMessage(store, owner, threadId)
  if (!claim) return
  try {
    const row = selectedJob(store, owner, claim.source)
    const parent = await restoreJob(row, owner)
    const prior = pinnedRequest(row, parent)
    if (!prior || row.status !== 'completed' || queueRecord(store, claim.source)?.phase !== 'finished')
      throw new ThreadChatError(409, 'Previous run did not complete; review its saved status.')
    const inspected = await inspectRegisteredJob(store, row, owner)
    if (inspected.status !== 'completed' ||
        ('revisionVerified' in inspected && inspected.revisionVerified === false))
      throw new ThreadChatError(409, 'Previous run is not a clean, completed generation.')
    const head = await trustedHead(parent)
    if (head !== parent.headSha) throw new ThreadChatError(409, 'Previous Story HEAD changed.')
    if (!claim.scopeJson) throw new ThreadChatError(409,
      'This queued instruction has no reviewed revision scope. Inspect its Story targets before retrying.')
    let scope: PinnedRevision
    try { scope = JSON.parse(claim.scopeJson) as PinnedRevision }
    catch { throw new ThreadChatError(409, 'Stored revision scope is corrupt; no writer was authorized.') }
    if (scope.sourceJobId !== claim.source || scope.sourceSha !== head ||
        !Array.isArray(scope.selectedTargets))
      throw new ThreadChatError(409, 'Revision authorization is stale or incomplete; review the Story impact again.')
    const refreshed = await revisionFromSource(store, owner, claim.source, claim.content,
      scope.protectedChange ? undefined : scope.selectedTargets)
    assertPinnedRevision(scope, refreshed, claim.source, head)
    if (scope.protectedChange)
      assertProtectedThreadApproval(store, owner, threadId, claim.id, claim.source, refreshed)
    const env = { ...process.env }
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX'])
      delete env[key]
    if (execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: parent.worktreeRoot, env, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()) throw new ThreadChatError(409, 'Previous Story has uncommitted files; reconcile them first.')
    const child = await continueCachedStory(parent, claim.id, head)
    if (child.baseSha !== head || child.headSha !== head)
      throw new ThreadChatError(409, 'Continuation baseline differs from verified source.')
    if (scope.protectedChange) {
      // The controller, not a Pi writer, makes the one explicitly authorized
      // amendment in an isolated child. Native revision verification and fresh
      // child-scoped trusted approval receipts are mandatory before committing.
      const committed = await commitProtectedThreadChange(child, scope.protectedChange, owner)
      store.sqlite.transaction(() => {
        const active = store.sqlite.prepare(`SELECT phase,source_job_id AS source
          FROM story_thread_messages WHERE id=? AND owner_user_id=? AND thread_id=?`)
          .get(claim.id, owner, threadId) as { phase: string; source: string } | undefined
        const latest = currentRun(store, owner, threadId)
        if (active?.phase !== 'preparing' || active.source !== claim.source ||
            latest?.jobId !== claim.source || latest.status !== 'completed' ||
            latest.queuePhase !== 'finished')
          throw new ThreadChatError(409, 'Protected Thread changed during exact native revision.')
        const time = now()
        const request: GenerationRequest = { story: child.storyRoot, job: child.jobId,
          task: claim.content, contract: scope.contract, fixture: true }
        const draft: GenerationDraft = { version: 1, headSha: head, task: claim.content,
          contract: scope.contract, limits: {}, model: null }
        store.sqlite.prepare(`INSERT INTO studio_sessions
          (id,owner_user_id,story_id,title,source_commit_sha,status,created_at,updated_at,
           generation_config_json,generation_request_json,generation_thread_id)
          SELECT ?,?,story_id,title || ' (protected revision)',?,'completed',?,?,?,?,?
          FROM studio_sessions WHERE id=? AND owner_user_id=?`)
          .run(claim.id, owner, head, time, time, JSON.stringify(draft),
            JSON.stringify(request), child.threadId + ':generation:web', claim.source, owner)
        store.sqlite.prepare(`INSERT INTO story_thread_runs
          (job_id,owner_user_id,thread_id,run_order) VALUES (?,?,?,?)`)
          .run(claim.id, owner, threadId, claim.runOrder)
        store.sqlite.prepare(`INSERT INTO generation_run_queue
          (job_id,owner_user_id,intent,phase,created_at,updated_at)
          VALUES (?,?,'start','finished',?,?)`).run(claim.id, owner, time, time)
        markProtectedThreadConsumed(store, owner, claim.id, committed)
        store.sqlite.prepare(`UPDATE thread_steering_intents SET review_state='approved-run'
          WHERE review_message_id=? AND owner_user_id=? AND thread_id=? AND review_state='awaiting-review'`)
          .run(claim.id, owner, threadId)
        store.sqlite.prepare(`UPDATE story_thread_messages SET phase='finished',
          status='delivered',job_id=?,verified_commit_sha=?
          WHERE id=? AND owner_user_id=? AND phase='preparing'`)
          .run(claim.id, committed, claim.id, owner)
        insertAssistant(store, owner, threadId, claim.id)
        store.sqlite.prepare(`UPDATE story_threads SET activity_at=? WHERE id=? AND owner_user_id=?`)
          .run(time, threadId, owner)
      })()
      await advanceThread(store, owner, threadId)
      return
    }
    const oldDraft = row.configJson ? JSON.parse(row.configJson) as GenerationDraft : null
    const model: PiSelection | null = oldDraft?.model ?? null
    if (model && !validPiSelection(model))
      throw new ThreadChatError(409, 'Previous model configuration is invalid.')
    if (model) await assertUserPiSelection(store, owner, model)
    verifyWebExecution(!model)
    const draft: GenerationDraft = { version: 1, headSha: head, task: claim.content,
      contract: scope.contract, limits: oldDraft?.limits ?? {}, model }
    const pinned: GenerationRequest = { story: child.storyRoot, job: child.jobId,
      task: claim.content, contract: scope.contract, fixture: !model,
      ...(prior.skillsSource ? { skillsSource: prior.skillsSource } : {}),
      ...(model ? { provider: model.provider, model: model.id } : {}) }
    await assertServerClaimPermitted(child, child.threadId + ':generation:web', pinned)
    store.sqlite.transaction(() => {
      const active = store.sqlite.prepare(`SELECT phase,source_job_id AS source FROM story_thread_messages
        WHERE id=? AND owner_user_id=? AND thread_id=?`).get(claim.id, owner, threadId) as
        { phase: string; source: string } | undefined
      const latest = currentRun(store, owner, threadId)
      if (active?.phase !== 'preparing' || active.source !== claim.source ||
          latest?.jobId !== claim.source || latest.status !== 'completed' || latest.queuePhase !== 'finished')
        throw new ThreadChatError(409, 'Thread admission changed during worktree preparation.')
      const time = now()
      store.sqlite.prepare(`INSERT INTO studio_sessions
        (id,owner_user_id,story_id,title,source_commit_sha,status,created_at,updated_at,generation_config_json)
        SELECT ?,?,story_id,title || ' (follow-up)',?,'paused',?,?,?
        FROM studio_sessions WHERE id=? AND owner_user_id=?`)
        .run(claim.id, owner, head, time, time, JSON.stringify(draft), claim.source, owner)
      store.sqlite.prepare(`INSERT INTO story_thread_runs
        (job_id,owner_user_id,thread_id,run_order) VALUES (?,?,?,?)`)
        .run(claim.id, owner, threadId, claim.runOrder)
      queueGeneration(store, owner, child.jobId, 'start', 'prepared', JSON.stringify(pinned),
        child.threadId + ':generation:web')
      store.sqlite.prepare(`UPDATE thread_steering_intents SET review_state='approved-run'
        WHERE review_message_id=? AND owner_user_id=? AND thread_id=? AND review_state='awaiting-review'`)
        .run(claim.id, owner, threadId)
      store.sqlite.prepare(`UPDATE story_thread_messages SET phase='running',job_id=?
        WHERE id=? AND owner_user_id=? AND phase='preparing'`).run(claim.id, claim.id, owner)
    })()
  } catch (error) {
    // No automatic retry or rollback of a partially created worktree.
    const message = error instanceof ThreadChatError ? error.message
      : 'Continuation preparation failed. Inspect the saved source and child worktree before retrying.'
    store.sqlite.transaction(() => {
      store.sqlite.prepare(`UPDATE story_thread_messages SET phase='blocked'
        WHERE id=? AND owner_user_id=? AND phase='preparing'`).run(claim.id, owner)
      store.sqlite.prepare(`UPDATE thread_steering_intents SET review_state='unresolved'
        WHERE review_message_id=? AND owner_user_id=? AND thread_id=? AND review_state='awaiting-review'`)
        .run(claim.id, owner, threadId)
      store.sqlite.prepare(`INSERT OR IGNORE INTO story_thread_messages
        (id,owner_user_id,thread_id,sequence,role,status,body,phase,created_at)
        VALUES (?,?,?,?,'assistant','delivered',?,'blocked',?)`)
        .run('assistant:' + claim.id, owner, threadId, nextSequence(store, threadId), message, now())
    })()
  }
}

/** Recover an agent crash between queue terminalization and chat settlement.
 * Only read committed queue status; neither the generation graph nor its
 * writer is ever restarted. All follow-up claims remain SQLite-serialized. */
export async function recoverSettledThreadRuns(store: StudioDatabase) {
  const rows = store.sqlite.prepare(`SELECT DISTINCT r.job_id AS jobId,
    r.owner_user_id AS owner FROM story_thread_runs r
    JOIN generation_run_queue q ON q.job_id=r.job_id AND q.owner_user_id=r.owner_user_id
    JOIN story_thread_messages m ON m.thread_id=r.thread_id AND m.owner_user_id=r.owner_user_id
    WHERE q.phase IN ('finished','interrupted') AND
      ((m.role='user' AND m.phase='running' AND m.job_id=r.job_id)
      OR (m.role='user' AND m.phase='queued' AND r.run_order=(
        SELECT MAX(next.run_order) FROM story_thread_runs next
        WHERE next.thread_id=r.thread_id AND next.owner_user_id=r.owner_user_id)))`)
    .all() as Array<{ jobId: string; owner: string }>
  for (const row of rows) await settleThreadRun(store, row.owner, row.jobId)
}

/** Called after the durable queue phase is terminal. Messages are append-only;
 * next queued follow-up is eligible only after a completed run, never a pause. */
export async function settleThreadRun(store: StudioDatabase, owner: string, jobId: string) {
  const record = store.sqlite.prepare(`SELECT thread_id AS threadId FROM story_thread_runs
    WHERE job_id=? AND owner_user_id=?`).get(jobId, owner) as { threadId: string } | undefined
  if (!record) return
  let verifiedCommit: string | null = null
  const settled = queueRecord(store, jobId)
  if (settled?.phase === 'finished') {
    // A terminal queue receipt is not itself narrative verification. Only
    // explicitly clean, independently verified Story HEADs can become fork
    // ancestry for delivered follow-up messages.
    try {
      const saved = selectedJob(store, owner, jobId)
      if (saved.status === 'completed') {
        const job = await restoreJob(saved, owner)
        const inspected = await inspectRegisteredJob(store, saved, owner)
        const head = await trustedHead(job)
        if (inspected.status === 'completed' && job.headSha === head)
          verifiedCommit = head
      }
    } catch { /* Missing or unsafe worktrees remain inspectable, not inheritable. */ }
  }
  // Recover a verified per-specialist attribution if the controller crashed
  // after checkpoint finalization but before publishing the activity receipt.
  try {
    const job = await restoreJob(selectedJob(store, owner, jobId), owner)
    for (const point of await inspectRecoveryCheckpoints(job)) {
      attributeSteeringCheckpoint(store, owner, jobId, point)
      if (point.eligible) attributeApprovedReplanCheckpoint(store, owner, jobId, point,
        committedStoryFiles(job, point.parentSha, point.commitSha))
    }
  } catch { /* No fabricated checkpoint or effect assertion on recovery failure. */ }
  store.sqlite.transaction(() => {
    const phase = queueRecord(store, jobId)?.phase
    if (!['finished', 'interrupted'].includes(phase ?? '')) return
    deferUndeliveredSteering(store, owner, jobId)
    // Publish the initial user request before its assistant settlement. Agent
    // workers can settle before anyone opens chat; an untouched Thread must
    // never present the assistant response ahead of the author's first prompt.
    seedExistingMessages(store, owner, record.threadId)
    store.sqlite.prepare(`UPDATE story_thread_messages SET phase=?,
      status=CASE WHEN ?='finished' THEN 'delivered' ELSE status END,
      verified_commit_sha=CASE WHEN ? IS NOT NULL THEN ? ELSE verified_commit_sha END
      WHERE owner_user_id=? AND job_id=? AND role='user' AND phase='running'`)
      .run(phase === 'finished' ? 'finished' : 'blocked',
        phase, verifiedCommit, verifiedCommit, owner, jobId)
    // A delivered steer without a finalized, matching specialist checkpoint
    // has no inheritable Git boundary. A terminal run HEAD cannot invent one.
    prepareSteeringBoundaryReviews(store, owner, jobId, record.threadId, verifiedCommit)
    const assistantId = insertAssistant(store, owner, record.threadId, jobId)
    if (verifiedCommit) store.sqlite.prepare(`UPDATE story_thread_messages
      SET verified_commit_sha=? WHERE owner_user_id=? AND thread_id=? AND id=?`)
      .run(verifiedCommit, owner, record.threadId, assistantId)
    store.sqlite.prepare(`UPDATE story_threads SET activity_at=?
      WHERE id=? AND owner_user_id=?`).run(now(), record.threadId, owner)
  })()
  await advanceThread(store, owner, record.threadId)
}
