import { randomUUID } from 'node:crypto'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema'
import { generationRunQueue as queue, storyThreadMessages as messages,
  threadActivePiTurns as turns, threadLiveInputs as inputs,
  threadLiveEffectReviews as reviews, threadSteeringIntents as intents,
  threadSteeringCheckpointLinks as links, storyThreadMessageCancellations as cancellations,
} from '../db/schema'
import type { ClaimedPiInput, PendingPiInput, SteeringActivity,
  SteeringCheckpoint, SteeringDisposition, SteeringPersistence } from './steering-contracts'
type Db = BetterSQLite3Database<typeof schema>
const ownerCheck = (owner: string) => { if (!owner) throw new Error('Authenticated owner required.') }
const checkpointValid = (p: SteeringCheckpoint) => p.eligible &&
  /^[a-f0-9]{40}$/.test(p.commitSha) && /^[a-f0-9]{64}$/.test(p.proofDigest)
const stateFor = (disposition: SteeringDisposition) =>
  disposition === 'scope-review' || disposition === 'protected-review'
    ? 'pending-boundary' as const : disposition === 'unresolved' ? 'unresolved' as const : 'considered' as const

export type SynchronousSteering = { [K in keyof SteeringPersistence]:
  (...args: Parameters<SteeringPersistence[K]>) => Awaited<ReturnType<SteeringPersistence[K]>> }

/** Kept private to the SQLite adapter so continuation can compose a single
 * synchronous SQLite transaction, without awaiting a Promise inside it. */
export function createSqliteSteeringSync(db: Db): SynchronousSteering {
  const consider = (messageId: string, owner: string, threadId: string, jobId: string,
    content: string, workItem: string | null, disposition: SteeringDisposition, at: string): void => {
      ownerCheck(owner)
      const eligible = db.select({ id: inputs.messageId }).from(inputs)
        .innerJoin(messages, and(eq(messages.id, inputs.messageId),
          eq(messages.ownerUserId, inputs.ownerUserId), eq(messages.threadId, inputs.threadId)))
        .where(and(eq(inputs.messageId, messageId), eq(inputs.ownerUserId, owner),
          eq(inputs.threadId, threadId), eq(inputs.sourceJobId, jobId),
          eq(inputs.state, 'delivered'), eq(messages.body, content))).get()
      if (!eligible) return
      db.insert(intents).values({
        messageId, ownerUserId: owner, threadId, sourceJobId: jobId,
        disposition, workItem, consideredAt: at, reviewState: stateFor(disposition),
      }).onConflictDoNothing().run()
    }
  return {
    registerTurn(jobId, piToken, piSessionId, workItem, expectedHead, at) {
      db.transaction(() => {
        if (!db.select({ id: queue.jobId }).from(queue).where(and(
          eq(queue.jobId, jobId), eq(queue.phase, 'running'))).get())
          throw new Error('Cannot register Pi outside a running generation job')
        db.insert(turns).values({
          jobId, piToken, piSessionId, workItem, expectedHead, createdAt: at,
        }).run()
      }, { behavior: 'immediate' })
    },
    closeTurn(jobId, piToken) {
      db.transaction(() => {
        db.update(inputs).set({ state: 'deferred' }).where(and(
          eq(inputs.sourceJobId, jobId), eq(inputs.targetPiToken, piToken),
          eq(inputs.state, 'pending'))).run()
        db.delete(turns).where(and(eq(turns.jobId, jobId),
          eq(turns.piToken, piToken))).run()
      }, { behavior: 'immediate' })
    },
    recoverOrphaned() {
      db.transaction(() => {
        db.run(sql`UPDATE thread_live_inputs SET state='deferred'
          WHERE state='pending' AND target_pi_token IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM thread_active_pi_turns t
              JOIN generation_run_queue q ON q.job_id=t.job_id AND q.phase='running'
              WHERE t.pi_token=thread_live_inputs.target_pi_token
                AND t.job_id=thread_live_inputs.source_job_id)`)
        db.run(sql`DELETE FROM thread_active_pi_turns WHERE NOT EXISTS
          (SELECT 1 FROM generation_run_queue q
            WHERE q.job_id=thread_active_pi_turns.job_id AND q.phase='running')`)
        db.run(sql`UPDATE thread_live_inputs SET state='blocked'
          WHERE state IN ('dispatching','sdk-queued')
            AND NOT EXISTS (SELECT 1 FROM thread_active_pi_turns t
              JOIN generation_run_queue q ON q.job_id=t.job_id AND q.phase='running'
              WHERE t.pi_token=thread_live_inputs.pi_token
                AND t.job_id=thread_live_inputs.source_job_id)`)
        db.run(sql`UPDATE story_thread_messages SET phase='blocked'
          WHERE id IN (SELECT message_id FROM thread_live_inputs WHERE state='blocked')
            AND phase='queued'`)
      }, { behavior: 'immediate' })
    },
    dispatchable() {
      return db.all(sql`SELECT l.message_id AS id,l.owner_user_id AS owner,
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
        ORDER BY m.sequence LIMIT 32`) as PendingPiInput[]
    },
    turn(jobId, piToken) {
      return db.select({ sessionId: turns.piSessionId }).from(turns)
        .where(and(eq(turns.jobId, jobId), eq(turns.piToken, piToken))).get() ?? null
    },
    claim(item, token, sessionId) {
      ownerCheck(item.owner)
      return db.run(sql`UPDATE thread_live_inputs SET
        state='dispatching',pi_token=${token},pi_session_id=${sessionId}
        WHERE message_id=${item.id} AND owner_user_id=${item.owner}
          AND source_job_id=${item.jobId} AND state='pending'
          AND target_pi_token=${token}
          AND EXISTS (SELECT 1 FROM thread_active_pi_turns t
            WHERE t.job_id=thread_live_inputs.source_job_id
              AND t.pi_token=thread_live_inputs.target_pi_token)
          AND EXISTS (SELECT 1 FROM story_thread_messages m
            WHERE m.id=thread_live_inputs.message_id AND m.phase='queued'
            AND NOT EXISTS (SELECT 1 FROM story_thread_message_cancellations c WHERE c.message_id=m.id))`).changes === 1
    },
    deferUnsent(messageId, token) {
      db.update(inputs).set({ state: 'deferred' }).where(and(
        eq(inputs.messageId, messageId), eq(inputs.piToken, token),
        eq(inputs.state, 'dispatching'))).run()
    },
    accepted(messageId, token) {
      db.update(inputs).set({ state: 'sdk-queued' }).where(and(
        eq(inputs.messageId, messageId), eq(inputs.piToken, token),
        eq(inputs.state, 'dispatching'))).run()
    },
    blocked(messageId, owner, token, attempted) {
      ownerCheck(owner)
      db.transaction(() => {
        db.update(inputs).set({ state: attempted ? 'blocked' : 'deferred' }).where(and(
          eq(inputs.messageId, messageId), eq(inputs.ownerUserId, owner),
          eq(inputs.piToken, token), eq(inputs.state, 'dispatching'))).run()
        if (attempted) db.update(messages).set({ phase: 'blocked' }).where(and(
          eq(messages.id, messageId), eq(messages.ownerUserId, owner),
          eq(messages.phase, 'queued'))).run()
      }, { behavior: 'immediate' })
    },
    settling(jobId, token) {
      return db.select({
        id: inputs.messageId, owner: inputs.ownerUserId, threadId: inputs.threadId,
        jobId: inputs.sourceJobId, content: messages.body, sequence: messages.sequence,
        delivery: inputs.state, mode: inputs.mode,
      }).from(inputs).innerJoin(messages, eq(messages.id, inputs.messageId))
        .where(and(eq(inputs.sourceJobId, jobId), eq(inputs.piToken, token),
          sql`${inputs.state} IN ('dispatching','sdk-queued')`)).all() as ClaimedPiInput[]
    },
    settle(row, token, delivered, workItem, disposition, at) {
      ownerCheck(row.owner)
      db.transaction(() => {
        const changed = db.update(inputs).set({
          state: delivered ? 'delivered' : 'blocked', deliveredAt: delivered ? at : null,
        }).where(and(eq(inputs.messageId, row.id), eq(inputs.ownerUserId, row.owner),
          eq(inputs.piToken, token), sql`${inputs.state} IN ('dispatching','sdk-queued')`)).run().changes
        if (changed !== 1) return
        db.update(messages).set({
          phase: delivered ? 'finished' : 'blocked',
          ...(delivered ? { status: 'delivered', jobId: row.jobId } : {}),
        }).where(and(eq(messages.id, row.id), eq(messages.ownerUserId, row.owner),
          eq(messages.phase, 'queued'))).run()
        if (delivered) consider(row.id, row.owner, row.threadId, row.jobId,
          row.content, workItem, disposition, at)
      }, { behavior: 'immediate' })
    },
    deferTurn(jobId, token) {
      db.update(inputs).set({ state: 'deferred' }).where(and(
        eq(inputs.sourceJobId, jobId), eq(inputs.targetPiToken, token),
        eq(inputs.state, 'pending'))).run()
    },
    review(owner, threadId, messageId, reviewer, evidence, at) {
      ownerCheck(owner)
      db.transaction(() => {
        const row = db.select({
          jobId: inputs.sourceJobId, sha: messages.verifiedCommitSha,
        }).from(inputs).innerJoin(messages, eq(messages.id, inputs.messageId))
          .where(and(eq(inputs.messageId, messageId), eq(inputs.ownerUserId, owner),
            eq(inputs.threadId, threadId), eq(inputs.state, 'delivered'),
            sql`${messages.verifiedCommitSha} IS NOT NULL`)).get()
        if (!row || !row.sha || !/^[a-f0-9]{40}$/.test(row.sha))
          throw new Error('Cannot verify an unacknowledged instruction or an unverified Story commit')
        db.insert(reviews).values({
          messageId, ownerUserId: owner, threadId, jobId: row.jobId,
          commitSha: row.sha, reviewer: reviewer.trim(), evidence: evidence.trim(),
          verifiedAt: at,
        }).onConflictDoNothing().run()
        const saved = db.select({
          sha: reviews.commitSha, reviewer: reviews.reviewer, evidence: reviews.evidence,
        }).from(reviews).where(eq(reviews.messageId, messageId)).get()
        if (!saved || saved.sha !== row.sha ||
            saved.reviewer !== reviewer.trim() || saved.evidence !== evidence.trim())
          throw new Error('Effect review already exists with different evidence')
      }, { behavior: 'immediate' })
    },
    deferUndelivered(owner, jobId) {
      ownerCheck(owner)
      db.transaction(() => {
        db.update(inputs).set({ state: 'deferred' }).where(and(
          eq(inputs.ownerUserId, owner), eq(inputs.sourceJobId, jobId),
          eq(inputs.state, 'pending'))).run()
        const stuck = db.select({ id: inputs.messageId }).from(inputs).where(and(
          eq(inputs.ownerUserId, owner), eq(inputs.sourceJobId, jobId),
          sql`${inputs.state} IN ('dispatching','sdk-queued')`)).all()
        for (const row of stuck) {
          db.update(inputs).set({ state: 'blocked' }).where(and(
            eq(inputs.messageId, row.id),
            sql`${inputs.state} IN ('dispatching','sdk-queued')`)).run()
          db.update(messages).set({ phase: 'blocked' }).where(and(
            eq(messages.id, row.id), eq(messages.ownerUserId, owner),
            eq(messages.phase, 'queued'))).run()
        }
      }, { behavior: 'immediate' })
    },
    consider,
    attribute(owner, jobId, checkpoint, at) {
      ownerCheck(owner)
      if (!checkpointValid(checkpoint)) return 0
      return db.transaction(() => {
        const rows = db.all(sql`SELECT l.message_id AS id,l.thread_id AS threadId
          FROM thread_live_inputs l JOIN thread_steering_intents i ON i.message_id=l.message_id
          WHERE l.owner_user_id=${owner} AND l.source_job_id=${jobId} AND l.state='delivered'
            AND l.target_work_item=${checkpoint.workItem}
            AND l.submitted_head=${checkpoint.parentSha} AND i.checkpoint_sha IS NULL
            AND EXISTS (SELECT 1 FROM story_thread_messages m
              WHERE m.id=l.message_id AND m.status='delivered')`) as Array<{ id: string; threadId: string }>
        for (const row of rows) {
          db.insert(links).values({
            messageId: row.id, ownerUserId: owner, threadId: row.threadId,
            sourceJobId: jobId, checkpointSha: checkpoint.commitSha,
            proofDigest: checkpoint.proofDigest, workItem: checkpoint.workItem,
            association: 'verified-influence', recordedAt: at,
          }).onConflictDoNothing().run()
          db.update(intents).set({
            checkpointSha: checkpoint.commitSha, checkpointProof: checkpoint.proofDigest,
          }).where(and(eq(intents.messageId, row.id), eq(intents.sourceJobId, jobId),
            isNull(intents.checkpointSha))).run()
          db.update(messages).set({ verifiedCommitSha: checkpoint.commitSha })
            .where(and(eq(messages.id, row.id), eq(messages.ownerUserId, owner),
              isNull(messages.verifiedCommitSha))).run()
        }
        const pending = db.all(sql`SELECT l.message_id AS id,l.thread_id AS threadId
          FROM thread_live_inputs l JOIN story_thread_messages m ON m.id=l.message_id
          WHERE l.owner_user_id=${owner} AND l.source_job_id=${jobId}
            AND l.state IN ('pending','deferred') AND m.phase='queued'
            AND NOT EXISTS (SELECT 1 FROM story_thread_message_cancellations c
              WHERE c.message_id=l.message_id)`) as Array<{ id: string; threadId: string }>
        for (const row of pending) db.insert(links).values({
          messageId: row.id, ownerUserId: owner, threadId: row.threadId,
          sourceJobId: jobId, checkpointSha: checkpoint.commitSha,
          proofDigest: checkpoint.proofDigest, workItem: checkpoint.workItem,
          association: 'pending-unresolved', recordedAt: at,
        }).onConflictDoNothing().run()
        return rows.length
      }, { behavior: 'immediate' })
    },
    approvedReplan(owner, jobId, point, files, at) {
      ownerCheck(owner)
      if (!checkpointValid(point) || !files.length) return 0
      return db.transaction(() => {
        const row = db.get(sql`SELECT i.message_id AS original,i.thread_id AS threadId,
          m.revision_scope_json AS scope FROM thread_steering_intents i
          JOIN story_thread_messages m ON m.id=i.review_message_id AND m.owner_user_id=i.owner_user_id
          JOIN story_thread_runs r ON r.job_id=m.job_id AND r.thread_id=i.thread_id
            AND r.owner_user_id=i.owner_user_id
          WHERE i.owner_user_id=${owner} AND r.job_id=${jobId}
            AND i.review_state='approved-run'
            AND m.status IN ('queued','delivered') AND m.phase IN ('running','finished')`) as
          { original: string; threadId: string; scope: string | null } | undefined
        if (!row?.scope) return 0
        let scope: { approved?: boolean; writePaths?: unknown; selectedTargets?: unknown }
        try { scope = JSON.parse(row.scope) } catch { return 0 }
        const paths = Array.isArray(scope.writePaths) && scope.writePaths.every(
          (p: unknown) => typeof p === 'string') ? scope.writePaths as string[] : []
        const targets = Array.isArray(scope.selectedTargets) ? scope.selectedTargets as unknown[] : []
        if (!scope.approved || !paths.length || !targets.length ||
            !files.every(file => paths.includes(file)) ||
            !point.workItem.startsWith('focus:') || !targets.includes(point.workItem.slice(6)))
          return 0
        return db.insert(links).values({
          messageId: row.original, ownerUserId: owner, threadId: row.threadId,
          sourceJobId: jobId, checkpointSha: point.commitSha, proofDigest: point.proofDigest,
          workItem: point.workItem, association: 'verified-implementation', recordedAt: at,
        }).onConflictDoNothing().run().changes
      }, { behavior: 'immediate' })
    },
    boundaryReviews(owner, jobId, threadId, verifiedHead, at) {
      ownerCheck(owner)
      if (!/^[a-f0-9]{40}$/.test(verifiedHead)) return 0
      return db.transaction(() => {
        const rows = db.all(sql`SELECT i.message_id AS id,m.body AS content
          FROM thread_steering_intents i JOIN story_thread_messages m ON m.id=i.message_id
          JOIN generation_run_queue q ON q.job_id=i.source_job_id AND q.owner_user_id=i.owner_user_id
          JOIN studio_sessions s ON s.id=i.source_job_id AND s.owner_user_id=i.owner_user_id
          WHERE i.owner_user_id=${owner} AND i.source_job_id=${jobId}
            AND i.thread_id=${threadId} AND i.review_state='pending-boundary'
            AND i.review_message_id IS NULL
            AND i.disposition IN ('scope-review','protected-review')
            AND q.phase='finished' AND s.status='completed' AND m.status='delivered'
          ORDER BY m.sequence`) as Array<{ id: string; content: string }>
        for (const row of rows) {
          const id = randomUUID()
          const sequence = db.select({
            next: sql<number>`COALESCE(MAX(${messages.sequence}),-1)+1`,
          }).from(messages).where(and(eq(messages.threadId, threadId),
            eq(messages.ownerUserId, owner))).get()!.next
          db.insert(messages).values({
            id, ownerUserId: owner, threadId, sequence,
            role: 'user', status: 'queued', body: row.content,
            originMessageId: row.id, phase: 'queued', createdAt: at,
          }).run()
          db.update(intents).set({
            reviewMessageId: id, reviewState: 'awaiting-review',
          }).where(and(eq(intents.messageId, row.id),
            eq(intents.ownerUserId, owner), eq(intents.reviewState, 'pending-boundary'))).run()
        }
        return rows.length
      }, { behavior: 'immediate' })
    },
    activity(owner, threadId) {
      ownerCheck(owner)
      const considered = db.all(sql`SELECT i.message_id AS messageId,i.disposition,
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
        WHERE i.owner_user_id=${owner} AND i.thread_id=${threadId}
        ORDER BY i.considered_at,i.message_id`) as SteeringActivity[]
      const pending = db.all(sql`SELECT l.message_id AS messageId,
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
        WHERE l.owner_user_id=${owner} AND l.thread_id=${threadId}
          AND l.state IN ('pending','deferred')
          AND NOT EXISTS (SELECT 1 FROM thread_steering_intents i WHERE i.message_id=l.message_id)
        ORDER BY l.created_at,l.message_id`) as SteeringActivity[]
      return [...considered, ...pending]
    },
  }
}

/** Public async contract; SQLite's atomic mutation bodies stay synchronous. */
export function createSqliteSteeringPersistence(sync: SynchronousSteering): SteeringPersistence {
  return {
    registerTurn: async (...args) => sync.registerTurn(...args),
    closeTurn: async (...args) => sync.closeTurn(...args),
    recoverOrphaned: async (...args) => sync.recoverOrphaned(...args),
    dispatchable: async (...args) => sync.dispatchable(...args),
    turn: async (...args) => sync.turn(...args),
    claim: async (...args) => sync.claim(...args),
    deferUnsent: async (...args) => sync.deferUnsent(...args),
    accepted: async (...args) => sync.accepted(...args),
    blocked: async (...args) => sync.blocked(...args),
    settling: async (...args) => sync.settling(...args),
    settle: async (...args) => sync.settle(...args),
    deferTurn: async (...args) => sync.deferTurn(...args),
    review: async (...args) => sync.review(...args),
    deferUndelivered: async (...args) => sync.deferUndelivered(...args),
    consider: async (...args) => sync.consider(...args),
    attribute: async (...args) => sync.attribute(...args),
    approvedReplan: async (...args) => sync.approvedReplan(...args),
    boundaryReviews: async (...args) => sync.boundaryReviews(...args),
    activity: async (...args) => sync.activity(...args),
  }
}
