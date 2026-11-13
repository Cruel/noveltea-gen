import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { StudioAuth } from './auth'
import type { StudioStore as StudioDatabase } from '../persistence/store'
import { requireUser } from './access.server'
import { authorizedStoryJob } from './fixture-jobs.server'
import { queueGeneration, queueRecord, dequeueBeforeStart } from './generation-queue.server'
import { readJobControl, setJobControl } from '../../../src/job-control'
import { withStoryJobLock } from '../../../src/job-lock'
import { sameGenerationRequest } from '../../../src/generation-owner'
import type { GenerationRequest } from '../../../src/generation'
import { trustedHead } from '../../../src/revision'
import { activeSpecialistChoice, focusedChoiceWorkItem, verifySpecialistChoice } from '../../../src/specialist-choice'
import { validateStoryJob } from '../../../src/validator'
import { authorizedFoundationException } from '../../../src/foundation-conflict'
import { openWebGenerationGraph } from '../../../src/web-fixture-runtime'
import { inspectRejectedRepair, type RepairReceipt } from '../../../src/rejected-review-repair'
import { inspectRecoveryCheckpoints, type RecoveryInspection } from '../../../src/recovery-checkpoints'
import { inspectPiPolicy, configurePiPolicy, type PiPolicy } from '../../../src/job-pi-policy'
import { parseJobLimits } from '../../../src/job-limits'

async function readSmallCommand(request: Request): Promise<string> {
  const reader = request.body?.getReader()
  if (!reader) throw new Error('Missing job control command')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let result = '', bytes = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 256) throw new Error('Control command exceeds 256 bytes')
      result += decoder.decode(value, { stream: true })
    }
    return result + decoder.decode()
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

const reply = (value: unknown, status = 200) => Response.json(value, {
  status, headers: { 'Cache-Control': 'private, no-store' },
})
type Action = 'pause' | 'resume' | 'cancel' | 'retry' | 'budget'

/** Match an authenticated, already-verified answer to its exact checkpointed
 * assignment. A different pending writer cannot inherit the author decision. */
export function authorChoiceMatchesActiveAssignment(workItem: string, value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const active = value as { stage?: unknown; milestone?: unknown }
  if (active.stage === 'foundations')
    return workItem === 'world-foundations' || workItem === 'character-foundations'
  if (active.stage === 'event')
    return typeof active.milestone === 'string' &&
      active.milestone.startsWith('milestone.') &&
      workItem === 'event-' + active.milestone.slice('milestone.'.length)
  if (active.stage === 'focus')
    return typeof active.milestone === 'string' &&
      workItem === focusedChoiceWorkItem(active.milestone)
  return false
}

type PendingReviewChoiceState = {
  status?: string; reason?: string | null; active?: unknown; result?: unknown;
  ideaTask?: unknown; ideaResult?: unknown;
}

/** Only an exact already-sealed rejected checkpoint and its answered
 * authenticated choice may re-enter review. No specialist writer is replayed. */
export function matchesReviewRepairResumeBoundary(
  saved: PendingReviewChoiceState,
  choice: { id: string; workItem: string },
  repair: Pick<RepairReceipt, 'phase' | 'choiceId' | 'baselineHead' | 'sourceCommitSha' | 'origin'>,
  point: Pick<RecoveryInspection, 'eligible' | 'commitSha' | 'workItem' | 'semanticReview'>,
): boolean {
  const sha = choice.workItem.match(/^repair-([a-f0-9]{40})$/)?.[1]
  const result = saved.result as { status?: string; headSha?: string } | null | undefined
  // Review may pause either between a two-specialist handoff or after an
  // already committed stage. Both retain the same sealed source SHA and
  // original dispatch result; neither may replay the prior writer.
  const stage = saved.active && typeof saved.active === 'object'
    ? (saved.active as { stage?: string }).stage : undefined
  const committedStageResult: Record<string, string> = {
    foundation: 'committed', architecture: 'architecture-committed',
    foundations: 'foundations-committed', event: 'event-cluster-committed',
    interactive: 'interactive-slice-committed',
    composition: 'composition-committed', focus: 'focused-committed',
  }
  const preservedResult = result?.headSha === sha &&
    (result.status === 'review-handoff' ||
      !!stage && result.status === committedStageResult[stage])
  return !!sha && saved.status === 'paused' &&
    saved.reason === 'Independent reviewer rejected the specialist draft; the original writer disputes correction. An authenticated Author Choice is pending.' &&
    preservedResult &&
    !saved.ideaTask && !saved.ideaResult &&
    point.eligible && point.commitSha === sha && point.semanticReview === 'failed' &&
    repair.phase === 'awaiting-author' && repair.choiceId === choice.id &&
    repair.baselineHead === sha && repair.sourceCommitSha === sha &&
    repair.origin.workItem === point.workItem &&
    authorChoiceMatchesActiveAssignment(point.workItem, saved.active)
}

/** Read-only, evidence-checked admission. Exported for crash/restart regression tests. */
export async function safeToResume(job: Awaited<ReturnType<typeof authorizedStoryJob>>,
  threadId: string, pinned: string, retry: boolean): Promise<'start' | 'resume'> {
  return withStoryJobLock(job, 'studio-control-recovery', async () => {
    const env = { ...process.env }
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX']) delete env[key]
    const choice = await activeSpecialistChoice(job)
    const choiceAnswer = choice?.phase === 'answered'
      ? await verifySpecialistChoice(job, choice.id, 'answered') : null
    if (!choiceAnswer && execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: job.worktreeRoot, env, encoding: 'utf8',
    }).trim()) throw new Error('Uncommitted files require manual reconciliation; the writer will not be replayed.')
    await trustedHead(job)
    const checkpoint = join(job.stateDir, 'web-generation.sqlite')
    if (!existsSync(checkpoint)) {
      if (retry || existsSync(join(job.stateDir, 'generation-server-owner.json')))
        throw new Error('An unfinished writer claim has no checkpoint; operator recovery is required.')
      return 'start'
    }
    const { saver, graph } = openWebGenerationGraph(checkpoint)
    try {
      const state = await graph.getState({ configurable: { thread_id: threadId } })
      const saved = state.values as PendingReviewChoiceState & { request?: unknown }
      const policy = await inspectPiPolicy(job)
      const conflict = await authorizedFoundationException(job)
      const authorBoundary = !!conflict && !conflict.retryUsed &&
        saved.active !== null && typeof saved.active === 'object' &&
        (saved.active as { stage?: string }).stage === 'foundation' &&
        ['paused', 'blocked'].includes(saved.status ?? '') && !saved.result &&
        ['Foundation requires an explicit author decision before generation can proceed.',
          'Pi did not author the canonical Markdown through a standard write/edit tool.'].includes(saved.reason ?? '')
      const choiceBoundary = !!choiceAnswer &&
        authorChoiceMatchesActiveAssignment(choiceAnswer.workItem, saved.active) &&
        saved.status === 'paused' && !saved.result &&
        saved.reason?.startsWith('Specialist paused for an author choice.') === true
      const budgetBoundary = !!policy.budget.pause && !!saved.active && !saved.result &&
        saved.reason?.startsWith('Pi budget exhausted at safe boundary:') === true
      // The original specialist already committed before its independent
      // review and a reviewer dispute interrupted this graph. Preserve the
      // in-flight dispatch/result; only the exact authenticated answered
      // review-repair choice can re-enter its read-only review boundary.
      let reviewRepairBoundary = false
      const sourceSha = choiceAnswer?.workItem.match(/^repair-([a-f0-9]{40})$/)?.[1]
      if (sourceSha && saved.status === 'paused' &&
          saved.reason === 'Independent reviewer rejected the specialist draft; the original writer disputes correction. An authenticated Author Choice is pending.' &&
          (saved.result as { status?: string; headSha?: string } | null)?.headSha === sourceSha) {
        const repair = await inspectRejectedRepair(job, sourceSha)
        const checkpoint = (await inspectRecoveryCheckpoints(job)).find(p =>
          p.eligible && p.commitSha === sourceSha && p.semanticReview === 'failed')
        reviewRepairBoundary = !!checkpoint &&
          matchesReviewRepairResumeBoundary(saved, choiceAnswer!, repair, checkpoint)
      }
      if (authorBoundary) {
        // Check the exact pinned native executable before consuming the
        // single no-write retry; a rotated bind mount must not let Pi edit
        // and then strand a partially written Foundation on validation.
        const validation = await validateStoryJob(job)
        if (validation.status !== 'passed')
          throw new Error('Pinned native validator did not pass the unchanged Story. Restore the exact original validator before resuming.')
      }
      if ((!authorBoundary && !choiceBoundary && !reviewRepairBoundary && saved.status !== 'paused') ||
          (saved.active && !budgetBoundary && !authorBoundary && !choiceBoundary && !reviewRepairBoundary) ||
          (saved.result && !reviewRepairBoundary) || saved.ideaTask || saved.ideaResult ||
          (!saved.request || !sameGenerationRequest(saved.request as GenerationRequest,
            JSON.parse(pinned) as GenerationRequest)) || state.next.length !== 0)
        throw new Error('Checkpoint is not at a verified, idle safe boundary. Inspect the original specialist receipts.')
      return 'resume'
    } finally { saver.db.close() }
  })
}

/** Authenticated, controller-only job controls. A request never carries a path,
 * approval, graph state, or alternate thread identifier. */
export async function generationControlRequest(auth: StudioAuth, store: StudioDatabase,
  request: Request, id: string, baseURL: string): Promise<Response> {
  if (!['GET', 'POST'].includes(request.method)) return reply({ error: 'Method not allowed' }, 405)
  if (request.method === 'POST' && request.headers.get('origin') !== baseURL)
    return reply({ error: 'Cross-origin write refused' }, 403)
  try {
    await store.assertReady()
    const user = await requireUser(auth, request.headers)
    if (!user) return reply({ error: 'Sign in required' }, 401)
    const job = await authorizedStoryJob(store, user.id, id)
    const savedRow = await store.persistence.generation.jobs.state(user.id, id)
    if (!savedRow) return reply({ error: 'Job not found' }, 404)
    const saved = { status: savedRow.status, request: savedRow.requestJson,
      thread: savedRow.threadId }
    const queued = (await queueRecord(store, id))
    if (request.method === 'GET') {
      const pi = await inspectPiPolicy(job)
      return reply({ control: await readJobControl(job), queue: queued?.phase ?? null,
        budget: pi.budget, limits: pi.policy.limits })
    }
    if (Number(request.headers.get('content-length') ?? 0) > 256)
      return reply({ error: 'Control command too large' }, 413)
    const raw = await readSmallCommand(request)
    let command: Record<string, unknown>
    try { command = JSON.parse(raw) as Record<string, unknown> }
    catch { return reply({ error: 'Invalid control JSON' }, 400) }
    if (!command || typeof command !== 'object' || Array.isArray(command) ||
        !['pause', 'resume', 'cancel', 'retry', 'budget'].includes(String(command.action)) ||
        Object.keys(command).some(key => !['action', ...(command.action === 'budget' ? ['limits'] : [])].includes(key)) ||
        (command.action !== 'budget' && Object.keys(command).length !== 1))
      return reply({ error: 'Expected one typed control or budget action' }, 400)
    const action = command.action as Action
    if (action === 'budget') {
      if (saved.status !== 'paused' || !saved.request || queued?.phase === 'running' ||
          queued?.phase === 'queued')
        return reply({ error: 'Budgets can be increased only for a paused, pinned job.' }, 409)
      const value = command.limits
      if (!value || typeof value !== 'object' || Array.isArray(value) ||
          Object.keys(value).length === 0 ||
          Object.keys(value).some(key => !['steps', 'modelCalls', 'costUsd', 'activeSeconds'].includes(key)))
        return reply({ error: 'Provide one or more supported budget limits.' }, 400)
      const requested = value as Record<string, unknown>
      try { parseJobLimits(requested) }
      catch { return reply({ error: 'Invalid budget limit.' }, 400) }
      const update = await withStoryJobLock(job, 'studio-budget-increase', async () => {
        const current = await store.persistence.generation.jobs.state(user.id, id)
        if (!current) throw new Error('Job not found')
        const original = { status: current.status, draft: current.configJson,
          request: current.requestJson }
        if (original.status !== 'paused' || original.request !== saved.request || !original.draft)
          throw new Error('Generation changed before budget adjustment.')
        const draft = JSON.parse(original.draft) as {
          version: number; model: unknown; limits: PiPolicy['limits']
        }
        const selected = draft.model as { provider?: unknown; id?: unknown } | null
        const pinned = JSON.parse(saved.request!) as { fixture?: unknown; provider?: unknown; model?: unknown }
        if (draft.version !== 1 || !selected || typeof selected.provider !== 'string' ||
            typeof selected.id !== 'string' || pinned.fixture !== false ||
            pinned.provider !== selected.provider || pinned.model !== selected.id)
          throw new Error('Only a consistent pinned sandboxed Pi job has editable budgets.')
        const pi = await inspectPiPolicy(job)
        if (pi.policy.profile.provider !== selected.provider ||
            pi.policy.profile.model !== selected.id)
          throw new Error('Saved Pi budget policy no longer matches the pinned model.')
        const previous = pi.policy.limits
        const next = { ...previous, ...requested } as PiPolicy['limits']
        if (Object.entries(requested).some(([key, amount]) =>
          (previous[key as keyof PiPolicy['limits']] ?? 0) > (amount as number)) ||
            Object.entries(requested).every(([key, amount]) =>
              (previous[key as keyof PiPolicy['limits']] ?? 0) === amount))
          throw new Error('Budget adjustment must increase at least one limit and cannot decrease any.')
        await configurePiPolicy(job, { ...pi.policy, limits: next })
        const changed = await store.persistence.generation.jobs.increaseBudget(
          user.id, id, original.draft, JSON.stringify({ ...draft, limits: next }),
          new Date().toISOString())
        if (!changed) throw new Error('Generation budget was edited concurrently.')
        return next
      })
      return reply({ limits: update })
    }
    if (action === 'pause' || action === 'cancel') {
      if (action === 'pause' && !saved.request)
        return reply({ error: 'No generation has been scheduled to pause.' }, 409)
      if (saved.status === 'completed' || saved.status === 'cancelled')
        return reply({ error: 'Finished jobs cannot be controlled' }, 409)
      if (!saved.request && saved.status !== 'paused')
        return reply({ error: 'No recoverable generation exists' }, 409)
      await setJobControl(job, action === 'cancel' ? 'cancelled' : 'paused')
      const removed = (await dequeueBeforeStart(store, user.id, id))
      if (action === 'cancel' && (removed || saved.status === 'paused' || queued?.phase !== 'running')) {
        await store.persistence.generation.jobs.cancel(user.id, id, new Date().toISOString())
      }
      return reply({ control: action === 'cancel' ? 'cancelled' : 'paused',
        pendingBoundary: !removed && queued?.phase === 'running' }, 202)
    }
    if (!saved.request || !saved.thread ||
        (saved.status !== 'paused' && !(action === 'retry' && saved.status === 'running' && queued?.phase === 'interrupted')))
      return reply({ error: 'Only paused, pinned generation can resume. Inspect the saved state.' }, 409)
    if (queued?.phase === 'running' || queued?.phase === 'queued')
      return reply({ error: 'Generation is already queued or running' }, 409)
    if (queued?.phase === 'interrupted' && action !== 'retry')
      return reply({ error: 'Interrupted writers need explicit recovery inspection, not Resume.' }, 409)
    if (action === 'retry' && queued?.phase !== 'interrupted')
      return reply({ error: 'Retry is reserved for a reconciled interrupted attempt.' }, 409)
    const intent = await safeToResume(job, saved.thread, saved.request, action === 'retry')
    // Persist one exact transition; a second attempt never races this queue
    // claim into a changed request or alternate thread.
    await setJobControl(job, 'running')
    await store.persistence.generation.queue.reconcileAndEnqueue(
      user.id, id, intent, {
        status: saved.status, request: saved.request, thread: saved.thread,
      }, queued?.phase === 'interrupted', new Date().toISOString())
    // The agent polls this durable queue. No HTTP request owns execution.
    return reply({ control: 'running', queue: 'queued', intent }, 202)
  } catch (error) {
    const status = error instanceof Error && 'status' in error &&
      typeof error.status === 'number' ? error.status :
      error instanceof Error && error.message === 'Control command exceeds 256 bytes' ? 413 : 409
    return reply({ error: status === 404 ? 'Job not found' :
      error instanceof Error ? error.message : 'Control transition unavailable; inspect durable state.' }, status)
  }
}
