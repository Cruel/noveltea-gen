import { randomUUID } from 'node:crypto'
import type { StudioDatabase } from '../db/connection'

type Disposition = 'within-scope' | 'scope-review' | 'protected-review' | 'unresolved'
type Checkpoint = {
  eligible: boolean; commitSha: string; parentSha: string; proofDigest: string; workItem: string
}
const canonicalIds = /\b(?:milestone|character|event|authored-content|choice-point|puzzle|world-entity|relationship|fact|revelation)\.[a-z][a-z0-9-]*/gi
const now = () => new Date().toISOString()

/** This is *triage*, not narrative interpretation or a grant. Unknown and
 * multi-target edits fail closed; a specialist never gains new writable paths.
 * The trusted native catalog and #84's exact scoped preview decide the plan. */
export function classifySteeringIntent(text: string, workItem: string | null): Disposition {
  if (/\b(?:protected\s+(?:creative\s+)?decision|creative[- ]direction|retcon|override\s+canon)\b/i.test(text))
    return 'protected-review'
  const targets = [...new Set([...text.matchAll(canonicalIds)].map(match => match[0]!.toLowerCase()))]
  if (!workItem) return 'unresolved'
  const scoped = workItem.startsWith('focus:') ? workItem.slice(6) : null
  if (workItem === 'character-foundations' && targets.length &&
      targets.every(id => id.startsWith('character.'))) return 'within-scope'
  if (workItem === 'world-foundations' && targets.length &&
      targets.every(id => /^(?:world-entity|relationship|fact|revelation)\./.test(id)))
    return 'within-scope'
  if (targets.length && (scoped === null || targets.some(id => id !== scoped)))
    return 'scope-review'
  if (/\bmilestone(?:-wide)?\b/i.test(text) && !workItem.startsWith('event-') &&
      !workItem.startsWith('interactive-') && !workItem.startsWith('composition-'))
    return 'scope-review'
  if (targets.length === 1 && scoped === targets[0]) return 'within-scope'
  // Without a single canonical target, do not pretend to have verified the
  // meaning. The instruction may have influenced the assigned work, but no
  // new plan is authorized.
  return 'unresolved'
}

/** Called at the owning Pi turn's *transcript-verified* settlement. The
 * instruction is considered, not fulfilled, and no scope change is applied. */
export function recordSteeringConsideration(store: StudioDatabase, id: string, owner: string,
  threadId: string, jobId: string, content: string, workItem: string | null) {
  const disposition = classifySteeringIntent(content, workItem)
  store.sqlite.prepare(`INSERT OR IGNORE INTO thread_steering_intents
    (message_id,owner_user_id,thread_id,source_job_id,disposition,work_item,considered_at,review_state)
    SELECT ?,?,?,?,?,?,?,?
    WHERE EXISTS (SELECT 1 FROM thread_live_inputs l JOIN story_thread_messages m
      ON m.id=l.message_id AND m.owner_user_id=l.owner_user_id
      WHERE l.message_id=? AND l.owner_user_id=? AND l.thread_id=? AND l.source_job_id=?
        AND l.state='delivered' AND m.body=?)`)
    .run(id, owner, threadId, jobId, disposition, workItem, now(),
      disposition === 'scope-review' || disposition === 'protected-review'
        ? 'pending-boundary' : disposition === 'unresolved' ? 'unresolved' : 'considered',
      id, owner, threadId, jobId, content)
}

/** Bind a consumed message to the *real finalized, verified* specialist
 * checkpoint. This establishes historical causal influence, NOT semantic
 * fulfillment; no model claim or arbitrary Git SHA can substitute for proof. */
export function attributeSteeringCheckpoint(store: StudioDatabase, owner: string,
  jobId: string, point: Checkpoint) {
  if (!point.eligible || !/^[a-f0-9]{40}$/.test(point.commitSha) ||
      !/^[a-f0-9]{64}$/.test(point.proofDigest)) return 0
  return store.sqlite.transaction(() => {
    const rows = store.sqlite.prepare(`SELECT l.message_id AS id,l.thread_id AS threadId
      FROM thread_live_inputs l JOIN thread_steering_intents i ON i.message_id=l.message_id
      WHERE l.owner_user_id=? AND l.source_job_id=? AND l.state='delivered'
        AND l.target_work_item=? AND l.submitted_head=? AND i.checkpoint_sha IS NULL
        AND EXISTS (SELECT 1 FROM story_thread_messages m
          WHERE m.id=l.message_id AND m.status='delivered')`)
      .all(owner, jobId, point.workItem, point.parentSha) as Array<{ id: string; threadId: string }>
    for (const row of rows) {
      store.sqlite.prepare(`INSERT OR IGNORE INTO thread_steering_checkpoint_links
        (message_id,owner_user_id,thread_id,source_job_id,checkpoint_sha,
          proof_digest,work_item,association,recorded_at)
        VALUES (?,?,?,?,?,?,?,'verified-influence',?)`)
        .run(row.id, owner, row.threadId, jobId, point.commitSha, point.proofDigest,
          point.workItem, now())
      store.sqlite.prepare(`UPDATE thread_steering_intents SET checkpoint_sha=?,checkpoint_proof=?
        WHERE message_id=? AND source_job_id=? AND checkpoint_sha IS NULL`)
        .run(point.commitSha, point.proofDigest, row.id, jobId)
      // The first verified influence checkpoint is the earliest point from
      // which a branch may inherit this *message*. In particular a branch
      // between two steers must not import the later steer.
      store.sqlite.prepare(`UPDATE story_thread_messages SET verified_commit_sha=?
        WHERE id=? AND owner_user_id=? AND verified_commit_sha IS NULL`)
        .run(point.commitSha, row.id, owner)
    }
    // A message not consumed at this boundary is still part of the durable
    // coordinator queue. Capture its unresolved presence against the actual
    // verified checkpoint without inventing application or fork ancestry.
    const pending = store.sqlite.prepare(`SELECT l.message_id AS id,l.thread_id AS threadId
      FROM thread_live_inputs l JOIN story_thread_messages m ON m.id=l.message_id
      WHERE l.owner_user_id=? AND l.source_job_id=? AND l.state IN ('pending','deferred')
        AND m.phase='queued'
        AND NOT EXISTS (SELECT 1 FROM story_thread_message_cancellations c WHERE c.message_id=l.message_id)`)
      .all(owner, jobId) as Array<{ id: string; threadId: string }>
    for (const row of pending) store.sqlite.prepare(`INSERT OR IGNORE INTO thread_steering_checkpoint_links
      (message_id,owner_user_id,thread_id,source_job_id,checkpoint_sha,
        proof_digest,work_item,association,recorded_at)
      VALUES (?,?,?,?,?,?,?,'pending-unresolved',?)`)
      .run(row.id, owner, row.threadId, jobId, point.commitSha, point.proofDigest,
        point.workItem, now())
    return rows.length
  })()
}

/** An approved redirect runs in a new, narrowly scoped generation child. Its
 * independently verified file commit can be linked to the original author
 * message, but only with the child's *pinned* scope and finalized checkpoint.
 * This is structural implementation evidence, not editorial fulfillment. */
export function attributeApprovedReplanCheckpoint(store: StudioDatabase, owner: string,
  jobId: string, point: Checkpoint, files: string[]) {
  if (!point.eligible || !/^[a-f0-9]{40}$/.test(point.commitSha) ||
      !/^[a-f0-9]{64}$/.test(point.proofDigest) || !files.length) return 0
  return store.sqlite.transaction(() => {
    const row = store.sqlite.prepare(`SELECT i.message_id AS original,i.thread_id AS threadId,
      m.revision_scope_json AS scope FROM thread_steering_intents i
      JOIN story_thread_messages m ON m.id=i.review_message_id AND m.owner_user_id=i.owner_user_id
      JOIN story_thread_runs r ON r.job_id=m.job_id AND r.thread_id=i.thread_id
        AND r.owner_user_id=i.owner_user_id
      WHERE i.owner_user_id=? AND r.job_id=? AND i.review_state='approved-run'
        AND m.status IN ('queued','delivered') AND m.phase IN ('running','finished')`)
      .get(owner, jobId) as { original: string; threadId: string; scope: string | null } | undefined
    if (!row?.scope) return 0
    let scope: { approved?: boolean; writePaths?: unknown; selectedTargets?: unknown }
    try { scope = JSON.parse(row.scope) } catch { return 0 }
    const paths = Array.isArray(scope.writePaths) && scope.writePaths.every((p: unknown) => typeof p === 'string')
      ? scope.writePaths as string[] : []
    const targets = Array.isArray(scope.selectedTargets) ? scope.selectedTargets as unknown[] : []
    if (!scope.approved || !paths.length || !targets.length ||
        !files.every(file => paths.includes(file)) ||
        !point.workItem.startsWith('focus:') || !targets.includes(point.workItem.slice(6)))
      return 0
    return store.sqlite.prepare(`INSERT OR IGNORE INTO thread_steering_checkpoint_links
      (message_id,owner_user_id,thread_id,source_job_id,checkpoint_sha,
        proof_digest,work_item,association,recorded_at)
      VALUES (?,?,?,?,?,?,?,'verified-implementation',?)`)
      .run(row.original, owner, row.threadId, jobId, point.commitSha, point.proofDigest,
        point.workItem, now()).changes
  })()
}

/** At a verified terminal boundary, turn a consumed out-of-scope instruction
 * into ONE separately reviewed next-run proposal. Never replay the consumed
 * instruction directly into Pi or silently expand the old specialist's scope.
 * Its parent message remains immutable. A crash/retry is SQLite-idempotent. */
export function prepareSteeringBoundaryReviews(store: StudioDatabase, owner: string,
  jobId: string, threadId: string, verifiedHead: string | null) {
  if (!verifiedHead || !/^[a-f0-9]{40}$/.test(verifiedHead)) return 0
  return store.sqlite.transaction(() => {
    const rows = store.sqlite.prepare(`SELECT i.message_id AS id,m.body AS content
      FROM thread_steering_intents i JOIN story_thread_messages m ON m.id=i.message_id
      JOIN generation_run_queue q ON q.job_id=i.source_job_id AND q.owner_user_id=i.owner_user_id
      JOIN studio_sessions s ON s.id=i.source_job_id AND s.owner_user_id=i.owner_user_id
      WHERE i.owner_user_id=? AND i.source_job_id=? AND i.thread_id=?
        AND i.review_state='pending-boundary' AND i.review_message_id IS NULL
        AND i.disposition IN ('scope-review','protected-review')
        AND q.phase='finished' AND s.status='completed' AND m.status='delivered'
      ORDER BY m.sequence`).all(owner, jobId, threadId) as Array<{ id: string; content: string }>
    const insert = store.sqlite.prepare(`INSERT INTO story_thread_messages
      (id,owner_user_id,thread_id,sequence,role,status,body,origin_message_id,phase,created_at)
      VALUES (?,?,?,?,'user','queued',?,?,'queued',?)`)
    for (const row of rows) {
      const id = randomUUID()
      const next = store.sqlite.prepare(`SELECT COALESCE(MAX(sequence),-1)+1 AS next
        FROM story_thread_messages WHERE thread_id=? AND owner_user_id=?`)
        .get(threadId, owner) as { next: number }
      insert.run(id, owner, threadId, next.next, row.content, row.id, now())
      store.sqlite.prepare(`UPDATE thread_steering_intents
        SET review_message_id=?,review_state='awaiting-review'
        WHERE message_id=? AND owner_user_id=? AND review_state='pending-boundary'`)
        .run(id, row.id, owner)
    }
    return rows.length
  })()
}

export type SteeringActivity = {
  messageId: string; disposition: Disposition; state: string
  reviewMessageId: string | null; sourceJobId: string
  checkpointSha: string | null; checkpointWorkItem: string | null
  checkpointProof: string | null; consideredAt: string
  verifiedEffectAt: string | null
  implementationSha: string | null
  implementationCount: number
}
export function steeringActivity(store: StudioDatabase, owner: string, threadId: string): SteeringActivity[] {
  const considered = store.sqlite.prepare(`SELECT i.message_id AS messageId,i.disposition,
    i.review_state AS state,i.review_message_id AS reviewMessageId,
    i.source_job_id AS sourceJobId,i.checkpoint_sha AS checkpointSha,
    l.work_item AS checkpointWorkItem,l.proof_digest AS checkpointProof,
    i.considered_at AS consideredAt,r.verified_at AS verifiedEffectAt,
    (SELECT cp.checkpoint_sha FROM thread_steering_checkpoint_links cp
      WHERE cp.message_id=i.message_id AND cp.association='verified-implementation'
      ORDER BY cp.rowid DESC LIMIT 1) AS implementationSha,
    (SELECT COUNT(*) FROM thread_steering_checkpoint_links cp
      WHERE cp.message_id=i.message_id AND cp.association='verified-implementation') AS implementationCount
    FROM thread_steering_intents i
    LEFT JOIN thread_steering_checkpoint_links l ON l.message_id=i.message_id
      AND l.checkpoint_sha=i.checkpoint_sha
    LEFT JOIN thread_live_effect_reviews r ON r.message_id=i.message_id
    WHERE i.owner_user_id=? AND i.thread_id=? ORDER BY i.considered_at,i.message_id`)
    .all(owner, threadId) as SteeringActivity[]
  const pending = store.sqlite.prepare(`SELECT l.message_id AS messageId,
    'unresolved' AS disposition,l.state AS state,NULL AS reviewMessageId,
    l.source_job_id AS sourceJobId,p.checkpoint_sha AS checkpointSha,
    p.work_item AS checkpointWorkItem,p.proof_digest AS checkpointProof,
    l.created_at AS consideredAt,NULL AS verifiedEffectAt,
    NULL AS implementationSha,0 AS implementationCount
    FROM thread_live_inputs l
    LEFT JOIN thread_steering_checkpoint_links p ON p.message_id=l.message_id
      AND p.association='pending-unresolved'
      AND p.rowid=(SELECT latest.rowid FROM thread_steering_checkpoint_links latest
        WHERE latest.message_id=l.message_id AND latest.association='pending-unresolved'
        ORDER BY latest.rowid DESC LIMIT 1)
    WHERE l.owner_user_id=? AND l.thread_id=? AND l.state IN ('pending','deferred')
      AND NOT EXISTS (SELECT 1 FROM thread_steering_intents i WHERE i.message_id=l.message_id)
    ORDER BY l.created_at,l.message_id`).all(owner, threadId) as SteeringActivity[]
  return [...considered, ...pending]
}
