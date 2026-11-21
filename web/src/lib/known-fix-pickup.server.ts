import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { deployedVerifierFixes } from '../../../src/known-verifier-fix'
import { readJobControl } from '../../../src/job-control'
import { withStoryJobLock } from '../../../src/job-lock'
import { trustedHead } from '../../../src/revision'
import { verifyAdaptivePickupProof, type AdaptiveRecovery } from '../../../src/adaptive-protocol'
import { readTurnEvidence } from '../../../src/turn-plan-evidence'
import { sameGenerationRequest, assertServerClaimPermitted } from '../../../src/generation-owner'
import type { GenerationRequest } from '../../../src/generation'
import type { JobStartResult } from '../../../src/job'
import type { IndexedVerifierStop } from '../persistence/generation-contracts'
import { openWebGenerationGraph } from '../../../src/web-fixture-runtime'
import { pinnedRequest, restoreJob, selectedJob } from './fixture-jobs.server'
import type { StudioStore } from '../persistence/store'

/** Shared read-only proof check used both at initial pickup and at the
 * worker's final admission fence. This must run while holding the Story lock.
 * It cannot authorize a writer; the graph independently authenticates the
 * original response again before admitting an adaptive proposal. */
export async function verifyKnownFixProof(job: JobStartResult, request: GenerationRequest,
  stop: IndexedVerifierStop): Promise<void> {
  if (job.jobId !== stop.jobId || !request.turnPlanDigest ||
      request.fixture || request.turnPlanDigest !== stop.turnDigest ||
      !existsSync(join(job.stateDir, 'web-generation.sqlite')) ||
      await trustedHead(job) !== stop.sourceSha)
    throw Error('Known-fix pickup lost the original source-bound Turn')
  const turn = await readTurnEvidence(job, request.contract, request.task, stop.turnDigest)
  if (!turn) throw Error('Known-fix pickup lacks original signed Turn evidence')
  const { saver, graph } = openWebGenerationGraph(join(job.stateDir, 'web-generation.sqlite'))
  try {
    const saved = await graph.getState({ configurable: { thread_id: stop.threadId } })
    const state = saved.values as {
      status?: string; request?: typeof request; recovery?: AdaptiveRecovery | null;
      active?: unknown; result?: unknown; ideaTask?: unknown; ideaResult?: unknown;
      planVersion?: number;
      orchestratorOrder?: string[]; orchestratorPlanningDigest?: string;
      orchestratorSnapshotId?: string; graphThreadId?: string;
    }
    const r = state.recovery
    if (saved.next.length || state.status !== 'blocked' || state.active || state.result ||
        state.ideaTask || state.ideaResult || !state.request ||
        !sameGenerationRequest(state.request, request) ||
        !state.orchestratorOrder || !state.orchestratorPlanningDigest ||
        !state.orchestratorSnapshotId || state.graphThreadId !== stop.threadId ||
        !r || r.phase !== 'protocol-exhausted' ||
        r.check !== stop.check || r.checkVersion !== stop.checkVersion ||
        r.signature !== stop.signature || r.sourceSha !== stop.sourceSha ||
        r.turnDigest !== stop.turnDigest || r.planVersion !== state.planVersion ||
        r.jobId !== job.jobId || r.threadId !== job.threadId)
      throw Error('Known-fix pickup lost the original blocked graph checkpoint')
    await verifyAdaptivePickupProof(job, r)
  } finally { saver.db.close() }
}

/** Startup pickup is a narrow, indexed operation. No legacy filesystem scan,
 * stale queue replay, or implicit authorization from a new deployed build. */
export async function pickupKnownVerifierFixes(store: StudioStore): Promise<number> {
  let admitted = 0
  for (const fix of deployedVerifierFixes()) {
    const matching = await store.persistence.generation.queue.matchingVerifierStops(fix)
    for (const stop of matching) {
      try {
        const row = await selectedJob(store, stop.ownerId, stop.jobId)
        if (row.status !== 'blocked' || row.threadId !== stop.threadId) continue
        const job = await restoreJob(row, stop.ownerId)
        await withStoryJobLock(job, 'known-verifier-fix-pickup', async () => {
          if (await readJobControl(job) !== 'running') return
          const request = pinnedRequest(row, job)
          if (!request || request.fixture || request.turnPlanDigest !== stop.turnDigest) return
          await assertServerClaimPermitted(job, stop.threadId, request)
          const env = { ...process.env }
          for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR',
            'GIT_INDEX_FILE', 'GIT_PREFIX']) delete env[name]
          if (execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
            cwd: job.worktreeRoot, env, encoding: 'utf8',
          }).trim()) return
          await verifyKnownFixProof(job, request, stop)
          if (await store.persistence.generation.queue.enqueueFix(stop.ownerId, stop.jobId,
            stop, fix, new Date().toISOString())) admitted++
        })
      } catch {
        // A single damaged or independently stopped Turn must not prevent
        // other exact matches from being checked. No optimistic retry.
        console.error('[Studio] A known verifier-fix pickup was not eligible; preserved its stopped evidence')
      }
    }
  }
  return admitted
}
