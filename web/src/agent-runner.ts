import { assertNativeVersion } from '../../src/native-cli-version';
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import type { StudioDatabase } from './db/connection'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { GenerationEvidence } from '../../src/generation'
import { readJobControl } from '../../src/job-control'
import { claimServerGeneration } from '../../src/generation-owner'
import { withStoryJobLock } from '../../src/job-lock'
import { openWebGenerationGraph } from '../../src/web-fixture-runtime'
import { reconcileRecoveryCheckpoints, inspectRecoveryCheckpoints } from '../../src/recovery-checkpoints'
import { configurePiPolicy, resolvePiModel, type PiPolicy } from '../../src/job-pi-policy'
import { withJobModelRuntime } from '../../src/model-runtime'
import { SandboxClient } from '../../src/sandbox-client'
import { assertUserPiSelection, createUserPiRuntime, validPiSelection, type PiSelection } from './lib/pi-credentials.server'
import { appendGenerationEvent, committedStoryFiles } from './lib/generation-progress.server'
import { queueRecord, type QueueRecord } from './lib/generation-queue.server'
import { selectedJob, restoreJob, pinnedRequest, verifyTrustedRevision, verifyWebExecution } from './lib/fixture-jobs.server'
import { attributeSteeringCheckpoint, attributeApprovedReplanCheckpoint } from './lib/thread-steering-replan.server'

/** Verify the queued identity and resume the pinned graph, never browser inputs. */
export async function runPersistedGeneration(store: StudioDatabase, item: QueueRecord): Promise<void> {
  const row = selectedJob(store, item.ownerId, item.jobId)
  const job = await restoreJob(row, item.ownerId)
  assertNativeVersion(job.validatorVersion)
  const pinned = pinnedRequest(row, job)
  if (!pinned || row.status !== 'paused' || queueRecord(store, row.id)?.phase !== 'running')
    throw new Error('Queued generation state changed before execution.')
  const config = row.configJson ? JSON.parse(row.configJson) as {
    model?: PiSelection | null; limits?: PiPolicy['limits']; pauseAfter?: 'foundation'
  } : null
  if (config?.pauseAfter !== undefined && config.pauseAfter !== 'foundation')
    throw new Error('Unsupported pinned generation stage pause.')
  const selected = config?.model ?? null
  if (selected && !validPiSelection(selected)) throw new Error('Saved Pi model is invalid.')
  if (pinned.fixture === !!selected) throw new Error('Saved Pi model disagrees with pinned execution.')
  verifyWebExecution(pinned.fixture, true)
  await verifyTrustedRevision(job)
  if (await readJobControl(job) !== 'running') throw new Error('Generation is not authorized to run.')
  // Check again at dispatch, not only at enqueue: queued work can be mutated.
  const env = { ...process.env }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX']) delete env[key]
  if (execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: job.worktreeRoot, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()) throw new Error('Job has uncommitted work; manual reconciliation required.')
  let runtime: ModelRuntime | undefined
  if (selected) {
    await assertUserPiSelection(store, item.ownerId, selected)
    runtime = await createUserPiRuntime(store, item.ownerId)
  }
  const threadId = row.threadId!
  const claim = () => withStoryJobLock(job, 'studio-generation-admission', async () => {
    const current = await store.persistence.generation.jobs.state(item.ownerId, row.id)
    if (current?.status !== 'paused' || current.requestJson !== JSON.stringify(pinned) ||
        current.threadId !== threadId || queueRecord(store, row.id)?.phase !== 'running')
      throw new Error('Conflicting generation admission.')
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
        }, limits: config?.limits ?? {} })
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
    appendGenerationEvent(store, item.ownerId, row.id, { kind: 'started' })
    const { saver, graph } = openWebGenerationGraph(join(job.stateDir, 'web-generation.sqlite'))
    try {
      if (item.intent !== 'start') {
        // A committed specialist can precede its parent LangGraph snapshot.
        // Reconcile only the original trusted receipt, never repeat the writer.
        await withStoryJobLock(job, 'studio-recovery-finalization', () =>
          reconcileRecoveryCheckpoints(job))
      }
      const prior = await graph.getState({ configurable: { thread_id: threadId } })
      const stages = (prior.values as { completedStages?: GenerationEvidence[] }).completedStages ?? []
      let working = '', verified = stages.length
      let previousHead = stages.at(-1)?.headSha ?? job.headSha
      for await (const patch of await graph.stream({ request: pinned,
        pauseAfter: item.intent === 'start' && (pinned.fixture || config?.pauseAfter === 'foundation')
          ? 'foundation' : null },
        { configurable: { thread_id: threadId }, recursionLimit: 10000, streamMode: 'updates' })) {
        const updates = patch as Record<string, unknown>
        const intake = updates.author_update_intake as { active?: {
          stage: GenerationEvidence['stage']; milestone?: string } } | undefined
        if (intake?.active) {
          const key = intake.active.stage + ':' + (intake.active.milestone ?? '')
          if (working !== key) {
            working = key
            appendGenerationEvent(store, item.ownerId, row.id, { kind: 'working',
              stage: intake.active.stage, milestone: intake.active.milestone })
          }
        }
        const completed = (updates.verify_committed_work as {
          completedStages?: GenerationEvidence[] } | undefined)?.completedStages
        if (completed && completed.length > verified) {
          for (const evidence of completed.slice(verified)) {
            const files = committedStoryFiles(job, previousHead, evidence.headSha)
            appendGenerationEvent(store, item.ownerId, row.id, { kind: 'verified',
              stage: evidence.stage, milestone: evidence.milestone, files })
            // Only a finalized recovery proof can associate a steering message
            // with this verified Git boundary. If publication is interrupted,
            // terminal settlement reconciles the same proof idempotently.
            const points = await inspectRecoveryCheckpoints(job)
            for (const point of points.filter(p => p.commitSha === evidence.headSha)) {
              attributeSteeringCheckpoint(store, item.ownerId, row.id, point)
              attributeApprovedReplanCheckpoint(store, item.ownerId, row.id, point, files)
            }
            previousHead = evidence.headSha
          }
          verified = completed.length
        }
      }
      const snapshot = await graph.getState({ configurable: { thread_id: threadId } })
      const outcome = snapshot.values as { status?: string; reason?: string | null }
      const state = ['running', 'paused', 'blocked', 'completed', 'cancelled'].includes(outcome.status || '')
        ? outcome.status! : 'blocked'
      if (state === 'running') throw new Error('Graph stream ended without safe terminal state.')
      // The graph owns the author-input distinction; a generic pause must
      // never be presented as a request for creative approval.
      const needsAuthor = (state === 'paused' || state === 'blocked') &&
        typeof outcome.reason === 'string' &&
        /author (decision|choice|approval|question|input)|waiting for (your|an author)|approval required|author review/i.test(outcome.reason)
      if (!await store.persistence.generation.jobs.finish(
        item.ownerId, row.id, threadId, state as 'paused' | 'blocked' | 'completed' | 'cancelled',
        needsAuthor, item.workerId!, new Date().toISOString())) {
        throw new Error('Generation finished against a changed worker or job state.')
      }
      appendGenerationEvent(store, item.ownerId, row.id, { kind: 'finished',
        status: state as 'paused' | 'blocked' | 'completed' | 'cancelled' })
    } finally { saver.db.close() }
  }
  try {
    if (runtime) await withJobModelRuntime(runtime, execute)
    else await execute()
  } finally {
    if (selected) await new SandboxClient().dispose(job.jobId).catch(() => {})
  }
}
