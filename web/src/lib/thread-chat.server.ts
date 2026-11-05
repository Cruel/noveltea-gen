import { execFileSync } from 'node:child_process'
import type { StudioDatabase } from '../db/connection'
import { ThreadMessageConflict as ThreadChatError } from '../persistence/thread-message-contracts'
export { ThreadMessageConflict as ThreadChatError } from '../persistence/thread-message-contracts'
import { currentThreadRunSqlite, nextThreadSequenceSqlite,
  seedThreadMessagesSqlite, insertThreadAssistantSqlite } from '../persistence/thread-message-sqlite'
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

const unsafeText = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

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
  return nextThreadSequenceSqlite(store.db, threadId)
}
function currentRun(store: StudioDatabase, owner: string, id: string): Run | undefined {
  return currentThreadRunSqlite(store.db, owner, id)
}
function insertAssistant(store: StudioDatabase, owner: string, threadId: string, jobId: string): string {
  return insertThreadAssistantSqlite(store.db, owner, threadId, jobId)
}
function seedExistingMessages(store: StudioDatabase, owner: string, threadId: string): void {
  seedThreadMessagesSqlite(store.db, owner, threadId)
}

/** Owner-scoped read model, including immutable messages and verified run
 * evidence; advanced steering activity remains on its separate persistence
 * boundary until its migration. */
export async function readThreadChat(store: StudioDatabase, owner: string, threadId: string) {
  const data = await store.persistence.messages.read(owner, threadId)
  const membership = await store.persistence.messages.membership(owner, threadId)
  return { threadId, storyId: membership.storyId,
    archived: !!membership.archivedAt,
    messages: data.messages, steeringActivity: steeringActivity(store, owner, threadId),
    runs: data.runs.map(({ requestJson, ...run }) => ({
      ...run, status: run.queuePhase === 'interrupted' ? 'interrupted'
        : run.queuePhase === 'queued' ? 'queued'
        : run.queuePhase === 'running' ? 'running' : run.status,
      fixture: (() => {
        try { return (JSON.parse(requestJson ?? '{}') as { fixture?: boolean }).fixture === true }
        catch { return true }
      })(),
    })),
    evidence: data.evidence.map(({ filesJson, ...item }) => ({
      ...item, files: JSON.parse(filesJson) as string[],
    })),
  }
}

/** Durable, sequential, idempotent author admission across HTTP retries. */
export async function enqueueThreadMessage(store: StudioDatabase, owner: string, threadId: string,
  id: string, content: string, mode?: 'steer' | 'follow-up'): Promise<ThreadMessage> {
  if (!UUID.test(id) || typeof content !== 'string' || !content.trim() ||
      unsafeText.test(content))
    throw new ThreadChatError(400, 'Send a printable message of 1–4000 characters with a UUID.')
  return store.persistence.messages.enqueue(owner, threadId, id, content.trim(), mode, now())
}

export async function editQueuedThreadMessage(store: StudioDatabase, owner: string,
  threadId: string, id: string, requestId: string, expected: string, replacement: string): Promise<ThreadMessage> {
  if (!UUID.test(id) || !UUID.test(requestId) || typeof expected !== 'string' ||
      typeof replacement !== 'string' || !replacement.trim() || replacement.length > 4000 ||
      unsafeText.test(replacement))
    throw new ThreadChatError(400, 'Invalid queued message edit.')
  return store.persistence.messages.edit(owner, threadId, id, requestId,
    expected, replacement.trim(), now())
}

export async function cancelQueuedThreadMessage(store: StudioDatabase, owner: string,
  threadId: string, id: string): Promise<ThreadMessage> {
  if (!UUID.test(id)) throw new ThreadChatError(400, 'Invalid queued message identity.')
  return store.persistence.messages.cancel(owner, threadId, id, now())
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
