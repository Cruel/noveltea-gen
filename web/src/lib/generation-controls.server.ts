import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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
import { inspectRejectedRepair, acceptGuidedRepairContinuation, type RepairReceipt } from '../../../src/rejected-review-repair'
import { inspectRepairLedger, authorizeRepairGuidance, totalTurnCorrections,
  MAX_AUTHOR_REPAIR_GRANTS, MAX_AUTHOR_GRANTS_PER_ROOT, type AuthorRepairGrant,
  turnCorrectionLimit, localCorrectionLimit } from '../../../src/repair-ledger'
import { inspectRecoveryCheckpoints, type RecoveryInspection } from '../../../src/recovery-checkpoints'
import { inspectCheckpointReview } from '../../../src/checkpoint-assurance'
import { inspectPiPolicy, configurePiPolicy, type PiPolicy } from '../../../src/job-pi-policy'
import { parseJobLimits } from '../../../src/job-limits'

async function readSmallCommand(request: Request, maximum = 256): Promise<string> {
  const reader = request.body?.getReader()
  if (!reader) throw new Error('Missing job control command')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let result = '', bytes = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maximum) throw new Error('Control command exceeds ' + maximum + ' bytes')
      result += decoder.decode(value, { stream: true })
    }
    return result + decoder.decode()
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

const reply = (value: unknown, status = 200) => Response.json(value, {
  status, headers: { 'Cache-Control': 'private, no-store' },
})
type Action = 'pause' | 'resume' | 'cancel' | 'retry' | 'budget' | 'repair'

/** Project only compact evidence from independently sealed reviews. Never send
 * transcript text, model tool calls or unverifiable findings to the browser. */
async function inspectPublicRepairFindings(job: Awaited<ReturnType<typeof authorizedStoryJob>>,
  findings: Awaited<ReturnType<typeof inspectRepairLedger>>['findings']) {
  const points = await inspectRecoveryCheckpoints(job)
  const reviewed = new Map<string, ReturnType<typeof inspectCheckpointReview>>()
  return Promise.all(findings.map(async finding => {
    const key = finding.source.sourceSha
    let requested = reviewed.get(key)
    if (!requested) {
      const point = points.find(p => p.eligible && p.commitSha === key && p.assurance)
      requested = point ? inspectCheckpointReview(job, point) : Promise.resolve(null)
      reviewed.set(key, requested)
    }
    const review = await requested
    const digest = review?.result && createHash('sha256')
      .update(JSON.stringify(review.result)).digest('hex')
    if (!review || review.status !== 'failed' || !review.result ||
        digest !== finding.source.reviewDigest)
      throw Error('Repair finding lost its original independently sealed review evidence.')
    const detail = review.result.findings.find(f =>
      (f.kind ?? 'other') === finding.category &&
      JSON.stringify([...new Set(f.affectedPaths ?? [f.path])].sort()) ===
      JSON.stringify(finding.targets))
    if (!detail) throw Error('Repair finding no longer matches the sealed source review.')
    return {
      id: finding.id, type: finding.category, specialist: finding.assignmentId,
      outcome: finding.obligation, paths: finding.targets, status: finding.status,
      sourceSha: finding.source.sourceSha, reviewDigest: finding.source.reviewDigest,
      attempts: finding.attempts.length,
      message: detail.message.slice(0, 400),
      requiredCorrection: detail.requiredCorrection?.slice(0, 400) ?? null,
    }
  }))
}

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
  const preservedResult = !!result && result.headSha === sha &&
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

/** A guidance grant is not a new specialist dispatch. Only a blocked
 * independently rejected stage whose original committed result remains saved
 * may re-enter its original review node after the author has raised the
 * existing Repair ledger's exact source-bound allowance. */
export function matchesGuidedRepairResumeBoundary(
  saved: PendingReviewChoiceState,
  repair: Pick<RepairReceipt, 'phase' | 'rootFailureSha' | 'sourceCommitSha' |
    'repairedCommitSha' | 'baselineHead'>,
  grant: AuthorRepairGrant,
  point: Pick<RecoveryInspection, 'eligible' | 'commitSha' | 'workItem' | 'semanticReview'>,
  headSha: string,
): boolean {
  const stage = saved.active && typeof saved.active === 'object'
    ? (saved.active as { stage?: string }).stage : undefined
  const allowedResult: Record<string, string> = {
    foundation: 'committed', architecture: 'architecture-committed',
    foundations: 'foundations-committed', event: 'event-cluster-committed',
    interactive: 'interactive-slice-committed', composition: 'composition-committed',
    focus: 'focused-committed',
  }
  const result = saved.result as { status?: string; headSha?: string } | null
  return saved.status === 'blocked' &&
    !!saved.reason && /correction|review/i.test(saved.reason) &&
    !!stage && !!result && (result.status === 'review-handoff' ||
      result.status === allowedResult[stage]) &&
    !saved.ideaTask && !saved.ideaResult &&
    result.headSha === repair.rootFailureSha &&
    repair.phase === 'failed' && grant.rootFailureSha === repair.rootFailureSha &&
    grant.sourceSha === repair.sourceCommitSha &&
    grant.headSha === repair.repairedCommitSha &&
    grant.headSha === repair.baselineHead &&
    grant.headSha === headSha &&
    point.eligible && point.semanticReview === 'failed' &&
    point.commitSha === grant.headSha &&
    point.workItem === 'repair-' + grant.sourceSha
}

/** A pending author steer reached an independently reviewed correction
 * boundary and required scope/protected review. Resuming the unchanged
 * original Story Turn grants no steering authority and cannot replay a writer. */
export function matchesRepairSteeringReviewBoundary(
  saved: PendingReviewChoiceState,
  repair: Pick<RepairReceipt, 'phase' | 'rootFailureSha' | 'sourceCommitSha' |
    'repairedCommitSha' | 'baselineHead'>,
  point: Pick<RecoveryInspection, 'eligible' | 'commitSha' | 'workItem' | 'semanticReview'>,
  headSha: string,
): boolean {
  const result = saved.result as { headSha?: string } | null | undefined
  return saved.status === 'paused' &&
    saved.reason?.startsWith('Author approval required for live steering:') === true &&
    !!saved.active && !!result && !saved.ideaTask && !saved.ideaResult &&
    result.headSha === repair.rootFailureSha &&
    repair.phase === 'failed' && repair.repairedCommitSha === headSha &&
    repair.baselineHead === headSha &&
    point.eligible && point.semanticReview === 'failed' &&
    point.commitSha === headSha &&
    point.workItem === 'repair-' + repair.sourceCommitSha
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
      let guidedRepairBoundary = false
      let steeringReviewBoundary = false
      if (saved.status === 'paused' &&
          saved.reason?.startsWith('Author approval required for live steering:') &&
          saved.request) {
        const pinned = saved.request as { turnPlanDigest?: string }
        if (pinned.turnPlanDigest) {
          const ledger = await inspectRepairLedger(job, pinned.turnPlanDigest)
          const head = await trustedHead(job)
          const source = ledger.corrections.findLast(c =>
            c.result?.status === 'failed' && c.result.successorSha === head)
          if (source) {
            const repair = await inspectRejectedRepair(job, source.sourceSha)
            const point = (await inspectRecoveryCheckpoints(job)).find(p =>
              p.eligible && p.commitSha === head)
            steeringReviewBoundary = !!point && matchesRepairSteeringReviewBoundary(
              saved, repair, point, head)
          }
        }
      }
      if (saved.status === 'blocked' && saved.request) {
        const pinned = saved.request as { turnPlanDigest?: string }
        if (pinned.turnPlanDigest) {
          const ledger = await inspectRepairLedger(job, pinned.turnPlanDigest)
          const grant = ledger.authorGrants?.at(-1)
          if (grant) {
            const repair = await inspectRejectedRepair(job, grant.sourceSha)
            const point = (await inspectRecoveryCheckpoints(job)).find(p =>
              p.eligible && p.commitSha === grant.headSha)
            guidedRepairBoundary = !!point && matchesGuidedRepairResumeBoundary(
              saved, repair, grant, point, await trustedHead(job))
          }
        }
      }
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
      if ((!authorBoundary && !choiceBoundary && !reviewRepairBoundary && !guidedRepairBoundary && saved.status !== 'paused') ||
          (saved.active && !budgetBoundary && !authorBoundary && !choiceBoundary && !reviewRepairBoundary && !guidedRepairBoundary && !steeringReviewBoundary) ||
          (saved.result && !reviewRepairBoundary && !guidedRepairBoundary && !steeringReviewBoundary) || saved.ideaTask || saved.ideaResult ||
          (!saved.request || !sameGenerationRequest(saved.request as GenerationRequest,
            JSON.parse(pinned) as GenerationRequest)) || state.next.length !== 0)
        throw new Error('Checkpoint is not at a verified, idle safe boundary. Inspect the original specialist receipts.')
      return 'resume'
    } finally { saver.db.close() }
  })
}

/** Resume an answered specialist only through the same pinned checkpoint gates as
 * the explicit Resume control. Never dispatch a model call from this request. */
export async function enqueueAnsweredSpecialistContinuation(store: StudioDatabase,
  owner: string, job: Awaited<ReturnType<typeof authorizedStoryJob>>, id: string) {
  const current = await store.persistence.generation.jobs.state(owner, id)
  const queued = await queueRecord(store, id)
  if (current?.status !== 'paused' || !current.requestJson || !current.threadId ||
      queued?.phase !== 'finished')
    throw Error('The accepted answer is saved; generation requires manual recovery inspection.')
  const choice = await activeSpecialistChoice(job)
  if (choice?.phase !== 'answered')
    throw Error('An exact answered specialist receipt is required before continuation.')
  const intent = await safeToResume(job, current.threadId, current.requestJson, false)
  if (intent !== 'resume') throw Error('Original specialist checkpoint is unavailable.')
  await setJobControl(job, 'running')
  await store.persistence.generation.queue.reconcileAndEnqueue(owner, id, intent, {
    status: current.status, request: current.requestJson, thread: current.threadId,
  }, false, new Date().toISOString())
  return { control: 'running' as const, queue: 'queued' as const, intent }
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
      const pinned = saved.request ? JSON.parse(saved.request) as { turnPlanDigest?: string } : null
      const ledger = pinned?.turnPlanDigest ?
        await inspectRepairLedger(job, pinned.turnPlanDigest) : null
      const failed = ledger?.corrections.filter(c => c.result?.status === 'failed').at(-1)
      const pendingGrant = failed && ledger?.authorGrants?.find(g =>
        g.rootFailureSha === failed.rootFailureSha && g.sourceSha === failed.sourceSha &&
        g.headSha === failed.result?.successorSha &&
        !ledger.corrections.some(c => c.rootFailureSha === g.rootFailureSha &&
          c.sourceSha === g.headSha))
      const active = failed && ledger?.findings.some(f =>
        f.rootFailureSha === failed.rootFailureSha && f.status === 'open' &&
        f.source.sourceSha === failed.result?.successorSha)
      const repair = ledger && (ledger.findings.length || ledger.prerequisites?.length) ? {
        attempts: totalTurnCorrections(ledger), limit: turnCorrectionLimit(ledger),
        findings: (await inspectPublicRepairFindings(job, ledger.findings.slice(-12)))
          .map(f => ({ ...f, allowance: localCorrectionLimit(ledger, ledger.findings.find(
            saved => saved.id === f.id)!.rootFailureSha) })),
        recent: ledger.corrections.slice(-12).map(c => ({
          sourceSha: c.sourceSha, paths: c.changedPaths,
          outcome: c.result?.status ?? 'pending',
          successorSha: c.result?.successorSha ?? null,
        })),
        prerequisites: (ledger.prerequisites ?? []).slice(-12).map(p => ({
          type: p.obligation, specialist: p.milestoneId, path: p.path,
          status: p.status, attempts: p.attempts.length,
        })),
        ...(failed && active ? { continuation: {
          sourceSha: failed.sourceSha, rootSha: failed.rootFailureSha,
          reviewedSha: failed.result!.successorSha,
          ...(pendingGrant ? { pendingGuidance: pendingGrant.guidance } : {}),
          remainingGrants: Math.max(0, Math.min(
            MAX_AUTHOR_REPAIR_GRANTS - (ledger.authorGrants?.length ?? 0),
            MAX_AUTHOR_GRANTS_PER_ROOT - (ledger.authorGrants ?? []).filter(g =>
              g.rootFailureSha === failed.rootFailureSha).length)),
        } } : {}),
      } : null
      return reply({ control: await readJobControl(job), queue: queued?.phase ?? null,
        budget: pi.budget, limits: pi.policy.limits, repair })
    }
    if (Number(request.headers.get('content-length') ?? 0) > 2048)
      return reply({ error: 'Control command too large' }, 413)
    const raw = await readSmallCommand(request, 2048)
    let command: Record<string, unknown>
    try { command = JSON.parse(raw) as Record<string, unknown> }
    catch { return reply({ error: 'Invalid control JSON' }, 400) }
    if (!command || typeof command !== 'object' || Array.isArray(command) ||
        !['pause', 'resume', 'cancel', 'retry', 'budget', 'repair'].includes(String(command.action)) ||
        Object.keys(command).some(key => !['action', ...(command.action === 'budget' ? ['limits'] : []),
          ...(command.action === 'repair' ? ['sourceSha', 'guidance'] : [])].includes(key)) ||
        (!['budget', 'repair'].includes(String(command.action)) && Object.keys(command).length !== 1))
      return reply({ error: 'Expected one typed control or budget action' }, 400)
    const action = command.action as Action
    if (action === 'repair') {
      if (!saved.request || !saved.thread || !['blocked', 'paused'].includes(saved.status) ||
          !['finished', undefined].includes(queued?.phase) ||
          typeof command.sourceSha !== 'string' ||
          !/^[a-f0-9]{40}$/.test(command.sourceSha) ||
          (command.guidance !== undefined && (typeof command.guidance !== 'string' ||
            command.guidance.length > 1200)))
        return reply({ error: 'Exhausted repair requires exact source and bounded guidance in a stopped job.' }, 409)
      const sourceSha = command.sourceSha as string
      const guidance = (typeof command.guidance === 'string' ? command.guidance.trim() : '') ||
        'Attempt one more evidence-backed correction of the original sealed finding within the unchanged assignment and file grant.'
      const grant = await withStoryJobLock(job, 'author-guided-repair', async () => {
        const current = await store.persistence.generation.jobs.state(user.id, id)
        if (!current || current.requestJson !== saved.request ||
            current.threadId !== saved.thread || current.status !== saved.status)
          throw Error('Generation changed before guided repair admission.')
        const { saver, graph } = openWebGenerationGraph(join(job.stateDir, 'web-generation.sqlite'))
        let state: PendingReviewChoiceState & { request?: GenerationRequest }
        try {
          const snapshot = await graph.getState({ configurable: { thread_id: saved.thread! } })
          if (snapshot.next.length) throw Error('Repair graph is not idle at a reconciled checkpoint.')
          state = snapshot.values as typeof state
        } finally { saver.db.close() }
        const repair = await inspectRejectedRepair(job, sourceSha)
        const original = (state.result as { headSha?: string } | null)?.headSha
        if (state.status !== 'blocked' || !state.active || !state.result ||
            !state.reason?.includes('correction') && !state.reason?.includes('review') ||
            original !== repair.rootFailureSha ||
            repair.phase !== 'blocked' && repair.phase !== 'failed' ||
            !repair.repairedCommitSha ||
            repair.repairedCommitSha !== await trustedHead(job) ||
            !state.request?.turnPlanDigest ||
            state.request.turnPlanDigest !== repair.originalSource.turnDigest)
          throw Error('Original failed repair and saved Story Turn are not a safe continuation boundary.')
        const approved = await authorizeRepairGuidance(job, {
          turnDigest: repair.originalSource.turnDigest, authorId: user.id,
          rootFailureSha: repair.rootFailureSha, sourceSha: repair.sourceCommitSha,
          headSha: repair.repairedCommitSha, guidance,
        })
        await acceptGuidedRepairContinuation(job, repair.sourceCommitSha, approved.id)
        await store.persistence.generation.jobs.authorDecision(user.id, id, 'paused',
          new Date().toISOString())
        return approved
      })
      const current = await store.persistence.generation.jobs.state(user.id, id)
      if (!current?.requestJson || !current.threadId) throw Error('Repair continuation lost its pinned job.')
      const intent = await safeToResume(job, current.threadId, current.requestJson, false)
      await setJobControl(job, 'running')
      await store.persistence.generation.queue.reconcileAndEnqueue(user.id, id, intent, {
        status: current.status, request: current.requestJson, thread: current.threadId,
      }, false, new Date().toISOString())
      return reply({ control: 'running', queue: 'queued', intent, grantId: grant.id }, 202)
    }
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
          throw new Error('Only a consistent pinned sandboxed model job has editable budgets.')
        const pi = await inspectPiPolicy(job)
        if (pi.policy.profile.provider !== selected.provider ||
            pi.policy.profile.model !== selected.id)
          throw new Error('Saved model budget policy no longer matches the pinned model.')
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
      error instanceof Error && error.message.startsWith('Control command exceeds ') ? 413 : 409
    return reply({ error: status === 404 ? 'Job not found' :
      error instanceof Error ? error.message : 'Control transition unavailable; inspect durable state.' }, status)
  }
}
