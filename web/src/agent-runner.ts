import { pendingGenerationQuestion, generationQuestionResume } from '../../src/generation-author-question'
import { assertNativeVersion } from '../../src/native-cli-version';
import { withPiStatusReporter } from '../../src/pi-work-status'
import { withControllerReviewPhase } from '../../src/controller-review-phase'
import { withSteeringBoundary } from '../../src/steering-boundary'
import { validateStoryJob } from '../../src/validator'
import { trustedHead } from '../../src/revision'
import { execFileSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import { join } from 'node:path'
import type { StudioStore as StudioDatabase } from './persistence/store'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { requireGenerationTurn, type GenerationEvidence } from '../../src/generation'
import { readJobControl } from '../../src/job-control'
import { claimServerGeneration } from '../../src/generation-owner'
import { withStoryJobLock } from '../../src/job-lock'
import { openWebGenerationGraph } from '../../src/web-fixture-runtime'
import { inspectModernGenerationRecovery } from '../../src/generation-recovery-inspection'
import { projectRecovery } from '../../src/generation-recovery-graph'
import type { RecoveryLifecycle } from '../../src/generation-recovery-contract'
import { reconcileRecoveryCheckpoints, inspectRecoveryCheckpoints } from '../../src/recovery-checkpoints'
import { configurePiPolicy, resolvePiModel, type PiPolicy } from '../../src/job-pi-policy'
import { withActiveExecutionTime } from '../../src/job-active-time'
import { parseJobLimits } from '../../src/job-limits'
import { withJobModelRuntime } from '../../src/model-runtime'
import { SandboxClient } from '../../src/sandbox-client'
import { assertUserPiSelection, createUserPiRuntime, validPiSelection, type PiSelection } from './lib/pi-credentials.server'
import { appendGenerationEvent, committedStoryFiles, syncApprovalRevisionActivity } from './lib/generation-progress.server'
import { queueRecord, type QueueRecord } from './lib/generation-queue.server'
import { selectedJob, restoreJob, pinnedRequest, verifyTrustedRevision, verifyWebExecution } from './lib/fixture-jobs.server'
import { attributeSteeringCheckpoint, attributeApprovedReplanCheckpoint } from './lib/thread-steering-replan.server'
import { retryReadOnlyPreflight } from './lib/read-only-preflight-retry'
import { deployedVerifierFixes, withKnownFixDispatch } from '../../src/known-verifier-fix'
import { verifyKnownFixProof } from './lib/known-fix-pickup.server'
import { sameGenerationRequest } from '../../src/generation-owner'
import type { AdaptiveRecovery } from '../../src/adaptive-protocol'
import { verifiedResumeAdmission } from './lib/generation-controls.server'

/** Verify the queued identity and resume the pinned graph, never browser inputs. */
export async function runPersistedGeneration(store: StudioDatabase, item: QueueRecord): Promise<void> {
  const row = await selectedJob(store, item.ownerId, item.jobId)
  const job = await restoreJob(row, item.ownerId)
  assertNativeVersion(job.validatorVersion)
  const pinned = pinnedRequest(row, job)
  const fix = item.fixId
    ? deployedVerifierFixes().find(candidate => candidate.id === item.fixId) : null
  const indexedStop = fix
    ? await store.persistence.generation.queue.verifierStop(item.ownerId, item.jobId) : null
  if (item.fixId && item.resumeKind)
    throw Error('A queued known-fix pickup cannot inherit a second recovery reason.')
  if (item.fixId && (!fix || !indexedStop ||
      fix.check !== indexedStop.check || fix.failedVersion !== indexedStop.checkVersion ||
      item.fixId !== fix.id))
    throw Error('Queued known-verifier-fix recheck lost its exact deployed fix or failure')
  if (!pinned || row.status !== 'paused' || (await queueRecord(store, row.id))?.phase !== 'running')
    throw new Error('Queued generation state changed before execution.')
  const config = row.configJson ? JSON.parse(row.configJson) as {
    model?: PiSelection | null; limits?: PiPolicy['limits']; pauseAfter?: 'foundation'
  } : null
  const limits = parseJobLimits(config?.limits ?? {})
  if (config?.pauseAfter !== undefined && config.pauseAfter !== 'foundation')
    throw new Error('Unsupported pinned generation stage pause.')
  const selected = config?.model ?? null
  if (selected && !validPiSelection(selected)) throw new Error('Saved Pi model is invalid.')
  if (pinned.fixture === !!selected) throw new Error('Saved Pi model disagrees with pinned execution.')
  await requireGenerationTurn(job, pinned)
  verifyWebExecution(pinned.fixture, true)
  await verifyTrustedRevision(job)
  if (await readJobControl(job) !== 'running') throw new Error('Generation is not authorized to run.')
  const threadId = row.threadId!
  const questionAtDispatch = async () => {
    if (item.intent !== 'resume') return null
    const { saver, graph } = openWebGenerationGraph(join(job.stateDir, 'web-generation.sqlite'))
    try {
      const snapshot = await graph.getState({ configurable: { thread_id: threadId } })
      const question = await pendingGenerationQuestion(job, saver, snapshot, threadId, 'user:' + item.ownerId)
      if (question && (question.phase === 'interrupt' && question.choice.phase !== 'answered' || item.fixId ||
          item.resumeKind !== 'ordinary' || !sameGenerationRequest(snapshot.values.request, pinned)))
        throw Error('Queued continuation lost the exact authenticated Author Question.')
      return question
    } finally { saver.db.close() }
  }
  const pendingAtDispatch = await questionAtDispatch()
  // Check again at dispatch, not only at enqueue: queued work can be mutated.
  const env = { ...process.env }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX']) delete env[key]
  if (!pendingAtDispatch && execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: job.worktreeRoot, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()) throw new Error('Job has uncommitted work; manual reconciliation required.')
  // A known-verifier-fix pickup already carries its durable fixId and exact
  // indexed-stop proof, which claim() re-verifies under the Story lock. It is
  // not an approved-Blueprint correction. Other blocked resumes (guided
  // repair, foundation exception, and corrected Blueprint) must re-run the
  // SAME full admission verifier as Studio control against this saved Thread.
  // Never reinterpret one recovery disposition as a different writer grant.
  if (item.intent === 'resume' && !item.fixId) {
    const { saver, graph } = openWebGenerationGraph(join(job.stateDir, 'web-generation.sqlite'))
    try {
      const snapshot = await graph.getState({ configurable: { thread_id: threadId } })
      if ((snapshot.values as { status?: string }).status === 'blocked') {
        if (snapshot.next.length)
          throw Error('Blocked original-Thread recovery is not at an idle checkpoint.')
        if (!item.resumeKind || item.resumeKind === 'ordinary')
          throw Error('Blocked original Thread lost its queued recovery reason.')
        const admitted = await verifiedResumeAdmission(job, threadId,
          JSON.stringify(pinned), false, 'blocked', 'user:' + item.ownerId)
        if (admitted.intent !== 'resume' || admitted.resumeKind !== item.resumeKind)
          throw Error('Queued recovery reason differs from the original verified Studio admission.')
      } else if (item.resumeKind && item.resumeKind !== 'ordinary') {
        throw Error('Original blocked recovery checkpoint was replaced before dispatch.')
      }
    } finally { saver.db.close() }
  }
  let runtime: ModelRuntime | undefined
  if (selected) {
    // This is an entirely read-only preflight: no Pi call, Git write, sandbox
    // writer, graph stream, or server generation claim has occurred yet.
    const verify = async () => {
      const state = await store.persistence.generation.jobs.state(item.ownerId, row.id)
      const lease = await queueRecord(store, row.id)
      if (state?.status !== 'paused' || state.requestJson !== row.requestJson ||
          state.threadId !== row.threadId || lease?.phase !== 'running' ||
          lease.workerId !== item.workerId || await trustedHead(job) !== job.headSha ||
          (!await questionAtDispatch() && execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
            cwd: job.worktreeRoot, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
          }).trim()))
        throw new Error('Preflight source changed; retain job for explicit reconciliation.')
    }
    runtime = await retryReadOnlyPreflight(async () => {
      await assertUserPiSelection(store, item.ownerId, selected)
      return createUserPiRuntime(store, item.ownerId)
    }, verify)
  }
  // Resolve the durable Turn->execution association once, owner-scoped, so
  // replayed controller events identify the exact author request.
  const ownerThreadId = await store.persistence.continuation.runThread(item.ownerId, row.id)
  const turnId = ownerThreadId
    ? (await store.persistence.messages.read(item.ownerId, ownerThreadId))
      .turns.find(turn => turn.executionIds.includes(row.id))?.id
    : undefined
  const claim = () => withStoryJobLock(job, 'studio-generation-admission', async () => {
    const current = await store.persistence.generation.jobs.state(item.ownerId, row.id)
    if (current?.status !== 'paused' || current.requestJson !== JSON.stringify(pinned) ||
        current.threadId !== threadId || (await queueRecord(store, row.id))?.phase !== 'running' ||
        await readJobControl(job) !== 'running')
      throw new Error('Conflicting generation admission.')
    await requireGenerationTurn(job, pinned)
    if (pendingAtDispatch && !await questionAtDispatch()) throw Error('Pending author interrupt changed before claim.')
    if (fix && indexedStop) await verifyKnownFixProof(job, pinned, indexedStop)
    let sandbox: SandboxClient | null = null
    if (selected) {
      sandbox = new SandboxClient()
      await sandbox.acquire(job.jobId)
    }
    try {
      if (selected && runtime) {
        await configurePiPolicy(job, { version: 1, profile: {
          provider: selected.provider, model: selected.id,
          ...(selected.thinking ? { thinking: selected.thinking } : {}),
        }, limits })
        await resolvePiModel(job, runtime, selected.provider, selected.id, selected.thinking)
      }
      await claimServerGeneration(job, threadId, pinned)
      const updated = await store.persistence.generation.jobs.start(
        item.ownerId, row.id, threadId, JSON.stringify(pinned), item.workerId!, new Date().toISOString())
      if (!updated) throw new Error('Concurrent admission.')
    } catch (error) {
      if (sandbox) await sandbox.dispose(job.jobId).catch(() => {})
      throw error
    }
  })
  await claim()
  const execute = async () => {
    await appendGenerationEvent(store, item.ownerId, row.id, { kind: 'started', turnId })
    const { saver, graph } = openWebGenerationGraph(join(job.stateDir, 'web-generation.sqlite'))
    try {
      const prior = await graph.getState({ configurable: { thread_id: threadId } })
      const pending = await pendingGenerationQuestion(job, saver, prior, threadId, 'user:' + item.ownerId)
      if (!!pending !== !!pendingAtDispatch || pending && (!pendingAtDispatch || pending.interruptId !== pendingAtDispatch.interruptId ||
          pending.choice.answerSeal?.digest !== pendingAtDispatch.choice.answerSeal?.digest))
        throw Error('Pending author interrupt changed before execution.')
      if (item.intent !== 'start' && !pending) {
        // A committed specialist can precede its parent LangGraph snapshot.
        // Reconcile only the original trusted receipt, never repeat the writer.
        await withStoryJobLock(job, 'studio-recovery-finalization', () =>
          reconcileRecoveryCheckpoints(job))
      }
      const modern = await inspectModernGenerationRecovery(job, saver, threadId)
      if (modern && !isDeepStrictEqual(modern,
        (prior.values as { recoveryLifecycle?: RecoveryLifecycle }).recoveryLifecycle))
        throw new Error('Saved recovery failed original Pi, source or decision authentication; ' +
          'do not stream the original writer. Inspect the preserved checkpoint.')
      const stages = (prior.values as { completedStages?: GenerationEvidence[] }).completedStages ?? []
      let working = '', verified = stages.length
      let previousHead = stages.at(-1)?.headSha ?? job.headSha
      for await (const patch of await graph.stream(pending ? generationQuestionResume(pending) : { request: pinned,
        fixPickup: fix && indexedStop ? { id: fix.id, check: fix.check,
          failedVersion: fix.failedVersion, signature: indexedStop.signature } : null,
        pauseAfter: item.intent === 'start' && (pinned.fixture || config?.pauseAfter === 'foundation')
          ? 'foundation' : null },
        { configurable: { thread_id: threadId }, recursionLimit: 10000, streamMode: 'updates' })) {
        const updates = patch as Record<string, unknown>
        const diagnosis = updates.completion_decision as {
          recoveryLifecycle?: RecoveryLifecycle
        } | undefined
        if (diagnosis?.recoveryLifecycle?.active?.origin.operation === 'completion-verification' &&
            diagnosis.recoveryLifecycle.phase === 'assessing') {
          await appendGenerationEvent(store, item.ownerId, row.id, {
            kind: 'working', stage: 'review', outcome: 'unknown-failure-assessing', turnId,
          })
        }
        const intake = updates.author_update_intake as { active?: {
          stage: GenerationEvidence['stage']; milestone?: string } } | undefined
        if (intake?.active) {
          const key = intake.active.stage + ':' + (intake.active.milestone ?? '')
          if (working !== key) {
            working = key
            await appendGenerationEvent(store, item.ownerId, row.id, { kind: 'working',
              stage: intake.active.stage, milestone: intake.active.milestone,
              specialist: intake.active.stage, turnId })
          }
        }
        const completed = (updates.verify_committed_work as {
          completedStages?: GenerationEvidence[] } | undefined)?.completedStages
        if (completed && completed.length > verified) {
          for (const evidence of completed.slice(verified)) {
            const files = committedStoryFiles(job, previousHead, evidence.headSha)
            // The native catalog may resolve changed record IDs, but never
            // infer IDs from filenames or treat a rejected catalog as canonical.
            const validated = await validateStoryJob(job)
            const records = validated.status === 'passed' &&
              Array.isArray(validated.report?.records) ? validated.report.records : []
            const changedRecordIds = records.flatMap((candidate: unknown) => {
              if (!candidate || typeof candidate !== 'object') return []
              const record = candidate as { path?: unknown; metadata?: { id?: unknown } }
              return typeof record.path === 'string' && files.includes(record.path) &&
                typeof record.metadata?.id === 'string' ? [record.metadata.id] : []
            })
            const diagnostics = Array.isArray(validated.report?.diagnostics)
              ? validated.report.diagnostics.length : undefined
            await appendGenerationEvent(store, item.ownerId, row.id, { kind: 'verified',
              stage: evidence.stage, milestone: evidence.milestone, files,
              headSha: evidence.headSha, outcome: evidence.status, specialist: evidence.stage,
              turnId, changedRecordIds, validation: validated.status, diagnostics })
            // Only a finalized recovery proof can associate a steering message
            // with this verified Git boundary. If publication is interrupted,
            // terminal settlement reconciles the same proof idempotently.
            const points = await inspectRecoveryCheckpoints(job)
            for (const point of points.filter(p => p.commitSha === evidence.headSha)) {
              await attributeSteeringCheckpoint(store, item.ownerId, row.id, point)
              await attributeApprovedReplanCheckpoint(store, item.ownerId, row.id, point, files)
            }
            previousHead = evidence.headSha
          }
          verified = completed.length
        }
      }
      const snapshot = await graph.getState({ configurable: { thread_id: threadId } })
      const outcome = snapshot.values as { status?: string; reason?: string | null;
        recoveryLifecycle: RecoveryLifecycle;
        recoverySources: import('../../src/generation-recovery-graph').RecoverySource[];
        request?: typeof pinned }
      const compatibility = projectRecovery({
        recoveryLifecycle: outcome.recoveryLifecycle,
        recoverySources: outcome.recoverySources,
      })
      const waiting = await pendingGenerationQuestion(job, saver, snapshot, threadId, 'user:' + item.ownerId)
      const state = waiting?.phase === 'interrupt' ? 'paused' : ['running', 'paused', 'blocked', 'completed', 'cancelled'].includes(outcome.status || '')
        ? outcome.status! : 'blocked'
      if (state === 'running') throw new Error('Graph stream ended without safe terminal state.')
      // The graph owns the author-input distinction; a generic pause must
      // never be presented as a request for creative approval.
      const needsAuthor = waiting?.phase === 'interrupt' || (state === 'paused' || state === 'blocked') &&
        typeof outcome.reason === 'string' &&
        /author (decision|choice|approval|question|input)|waiting for (your|an author)|approval required|author review/i.test(outcome.reason)
      if (!await store.persistence.generation.jobs.finish(
        item.ownerId, row.id, threadId, state as 'paused' | 'blocked' | 'completed' | 'cancelled',
        needsAuthor, item.workerId!, new Date().toISOString(),
        state === 'blocked' && !needsAuthor && outcome.reason?.startsWith('protocol-exhausted:') &&
          compatibility.recovery?.phase === 'protocol-exhausted' &&
          compatibility.recovery.check === 'adaptive-plan.v1' &&
          outcome.request && sameGenerationRequest(outcome.request, pinned) &&
          await trustedHead(job) === compatibility.recovery.sourceSha
          ? { check: compatibility.recovery.check, checkVersion: compatibility.recovery.checkVersion,
              signature: compatibility.recovery.signature, sourceSha: compatibility.recovery.sourceSha,
              turnDigest: compatibility.recovery.turnDigest } : null)) {
        throw new Error('Generation finished against a changed worker or job state.')
      }
      const diagnosticStatus = compatibility.unknownRecovery?.phase
      const diagnosticOutcome = diagnosticStatus &&
        ['assessment', 'resource-limit', 'operator-intervention', 'unsafe-evidence'].includes(diagnosticStatus)
        ? 'unknown-failure-' + diagnosticStatus : undefined
      await syncApprovalRevisionActivity(store, item.ownerId, row.id, job, turnId)
      await appendGenerationEvent(store, item.ownerId, row.id, { kind: 'finished',
        status: state as 'paused' | 'blocked' | 'completed' | 'cancelled',
        ...(diagnosticOutcome ? { outcome: diagnosticOutcome } : {}), turnId })
    } finally { saver.db.close() }
  }
  try {
    await withActiveExecutionTime(job, async () => {
      const executeWithStatus = () => withControllerReviewPhase(
        phase => appendGenerationEvent(store, item.ownerId, row.id, {
          kind: 'working', stage: 'review', reviewPhase: phase, turnId }),
        () => withSteeringBoundary({
        receipts: async source => {
          if (!ownerThreadId || source.jobId !== row.id)
            throw new Error('Steering amendment receipts require the exact authenticated Thread.')
          return store.persistence.steering.boundaryReceipts(item.ownerId, row.id, ownerThreadId)
        },
        pending: async source => {
          if (!ownerThreadId || source.jobId !== row.id)
            throw new Error('Live steering requires the exact authenticated Thread source.')
          return store.persistence.steering.pendingBoundary(item.ownerId, row.id, ownerThreadId)
        },
        settle: async (source, decision) => {
          if (!ownerThreadId || source.jobId !== row.id)
            throw new Error('Steering amendment does not belong to the active Thread.')
          await store.persistence.steering.settleBoundary(item.ownerId, row.id,
            ownerThreadId, decision, new Date().toISOString())
        },
      }, () => withPiStatusReporter(
        status => appendGenerationEvent(store, item.ownerId, row.id, {
          kind: 'working', piStatus: status, turnId }),
        execute)))
      const authorized = () => fix && indexedStop
        ? withKnownFixDispatch({ id: fix.id, check: fix.check,
            failedVersion: fix.failedVersion, signature: indexedStop.signature,
            jobId: job.jobId, threadId: job.threadId }, executeWithStatus)
        : executeWithStatus()
      if (runtime) await withJobModelRuntime(runtime, authorized)
      else await authorized()
    })
  } finally {
    if (selected) await new SandboxClient().dispose(job.jobId).catch(() => {})
  }
}
