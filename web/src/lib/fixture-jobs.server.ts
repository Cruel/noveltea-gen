import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { StudioAuth } from './auth'
import type { StudioDatabase } from '../db/connection'
import { assertStudioSchemaCurrent } from '../db/migrations'
import { requireUser } from './access.server'
import { startStoryJob, type JobStartResult } from '../../../src/job'
import { parseGenerationContract, type GenerationRequest } from '../../../src/generation'
import { assertServerClaimPermitted } from '../../../src/generation-owner'
import { trustedHead } from '../../../src/revision'
import { inspectRecoveryCheckpoints } from '../../../src/recovery-checkpoints'
import { forkSourceSummary } from '../../../src/recovery-fork-state'
import { openWebGenerationGraph } from '../../../src/web-fixture-runtime'
import { assertUserPiSelection, validPiSelection, type PiSelection } from './pi-credentials.server'
import type { PiPolicy } from '../../../src/job-pi-policy'
import { readJobControl } from '../../../src/job-control'
import { inspectFoundationConflict } from '../../../src/foundation-conflict'
import { activeSpecialistChoice, verifySpecialistChoice } from '../../../src/specialist-choice'
import { queueGeneration, queueRecord } from './generation-queue.server'

class JobError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const SHA = /^[a-f0-9]{40}$/i

type SavedJob = {
  id: string; storyId: string; title: string; commitSha: string | null
  provider: string; providerId: string; directory: string
  requestJson: string | null; threadId: string | null; configJson: string | null; status: string
}
export function selectedJob(store: StudioDatabase, owner: string, id: string): SavedJob {
  if (!UUID.test(id)) throw new JobError(400, 'Invalid job ID.')
  const row = store.sqlite.prepare(`SELECT j.id, j.story_id AS storyId, j.title, j.status,
    j.source_commit_sha AS commitSha, j.generation_request_json AS requestJson,
    j.generation_thread_id AS threadId, j.generation_config_json AS configJson, s.directory,
    r.provider, r.provider_repository_id AS providerId
    FROM studio_sessions j JOIN stories s ON j.story_id=s.id AND j.owner_user_id=s.owner_user_id
    JOIN repositories r ON s.repository_id=r.id AND s.owner_user_id=r.owner_user_id
    WHERE j.id=? AND j.owner_user_id=?`).get(id, owner) as SavedJob | undefined
  if (!row) throw new JobError(404, 'Job is not connected to this account.')
  if (!row.commitSha || !SHA.test(row.commitSha) || !['github', 'gitlab'].includes(row.provider) ||
      (row.requestJson === null) !== (row.threadId === null)) {
    throw new JobError(409, 'Saved job metadata is incomplete or inconsistent. Operator inspection required.')
  }
  return row
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

export async function restoreJob(row: SavedJob, owner: string): Promise<JobStartResult> {
  const cache = process.env.NT_GIT_CACHE_DIR
  if (!cache || !isAbsolute(cache)) throw new JobError(503, 'Configure an absolute NT_GIT_CACHE_DIR to reopen job worktrees.')
  const root = resolve(cache, digest(owner), digest(row.provider + ':' + row.providerId))
  let job: JobStartResult
  try {
    job = await startStoryJob({
      story: join(root, 'base', row.directory), job: row.id, worktreeCacheRoot: root,
    }, false)
  } catch {
    throw new JobError(409, 'Saved Git job worktree cannot be verified. Restore the original cache and durable job state.')
  }
  if (job.baseSha.toLowerCase() !== row.commitSha?.toLowerCase() ||
      job.storyRelativePath !== row.directory || job.jobId !== row.id) {
    throw new JobError(409, 'Job Git baseline differs from the saved Story selection. No generation was started.')
  }
  return job
}

/** Resolve an owner-scoped registered job without accepting filesystem paths from clients. */
export async function authorizedStoryJob(store: StudioDatabase, owner: string, id: string): Promise<JobStartResult> {
  return restoreJob(selectedJob(store, owner, id), owner)
}

export async function verifyTrustedRevision(job: JobStartResult) {
  try { await trustedHead(job) }
  catch { throw new JobError(409, 'Job HEAD is not a verified narrative revision. Reconcile the preserved branch before generation.') }
}

export function verifyWebExecution(fixture: boolean, agent = false) {
  // Fixture-only evaluation must not silently invoke real model placement.
  if (fixture && process.env.NT_LIVE_GENERATION_IDEA === '1') {
    throw new JobError(503, 'Fixture execution refuses live model-directed idea placement.')
  }
  if (!fixture && (process.env.NT_REQUIRE_USER_PI_RUNTIME !== '1' ||
      (agent ? (!process.env.NT_SANDBOX_SOCKET?.startsWith('/') ||
        !process.env.NT_SANDBOX_TOKEN_FILE?.startsWith('/')) :
        (!process.env.NT_AGENT_RPC_URL || !process.env.NT_AGENT_RPC_TOKEN)))) {
    throw new JobError(503, 'Real generation requires a rootless sandbox controller and an isolated per-user Pi runtime.')
  }
}
export function pinnedRequest(row: SavedJob, job: JobStartResult): GenerationRequest | null {
  if (!row.requestJson) return null
  let request: GenerationRequest
  try {
    request = JSON.parse(row.requestJson) as GenerationRequest
    const draft = row.configJson ? JSON.parse(row.configJson) as { model?: PiSelection | null } : null
    if (request.fixture !== !draft?.model || request.story !== job.storyRoot || request.job !== row.id ||
        !request.task?.trim() || !request.contract ||
        JSON.stringify(parseGenerationContract(request.contract)) !== JSON.stringify(request.contract) ||
        request.provider !== (draft?.model?.provider) || request.model !== (draft?.model?.id) ||
        (draft?.model && !validPiSelection(draft.model)) ||
        request.skillsSource !== undefined && typeof request.skillsSource !== 'string' ||
        request.validatorSource !== undefined) {
      throw new Error('invalid persisted request')
    }
  } catch {
    throw new JobError(409, 'Pinned generation request is invalid or changed. No execution is permitted.')
  }
  if (row.threadId !== job.threadId + ':generation:web') {
    throw new JobError(409, 'Saved generation thread does not match its durable job identity.')
  }
  return request
}

/** Owner-scoped, read-only diagnostic view; never authorizes a writer. */
export async function inspectRegisteredJob(store: StudioDatabase, row: SavedJob, owner: string) {
  const job = await restoreJob(row, owner)
  const pinned = pinnedRequest(row, job)
  const queued = queueRecord(store, row.id)
  // Finalized per-work-item points are safe to inspect even while a later
  // specialist is editing: the uncommitted draft is never part of the point.
  const recoveryCheckpoints = (await inspectRecoveryCheckpoints(job)).map(point => ({
    commitSha: point.commitSha, parentSha: point.parentSha, workItem: point.workItem, stage: point.stage,
    eligible: point.eligible, planVersion: point.planVersion,
    planDigest: point.planDigest, proofDigest: point.proofDigest,
    source: point.source, snapshotId: point.snapshotId,
    completedWorkItems: point.completedWorkItems, remainingWorkItems: point.remainingWorkItems,
    nextWorkItem: point.nextWorkItem, dependencies: point.dependencies, validation: point.validation,
    reason: point.eligible ? null : point.reason?.includes("finalization is incomplete")
      ? "Checkpoint finalization is incomplete; reconcile the original receipt."
      : "Checkpoint failed verification; operator reconciliation required.",
  }))
  const base = { recoveryCheckpoints, forkSource: forkSourceSummary(job), id: row.id, storyId: row.storyId, title: row.title, provider: row.provider,
    baseSha: job.baseSha, headSha: job.headSha, fixture: pinned?.fixture ?? true }
  if (!pinned) {
    // A crash between the server-owner claim and the database publication
    // leaves an intentional orphan: it must not appear as a fresh job.
    if (existsSync(join(job.stateDir, 'generation-server-owner.json'))) {
      return { ...base, status: 'interrupted', threadId: null, task: null, contract: null,
        reason: 'Server ownership was claimed without a saved request. Reconcile the original claim before retrying.',
        completedStages: [] }
    }
    if (row.status === 'completed') {
      throw new JobError(409, 'Completed job has no pinned generation request. Inspect its saved state.')
    }
    const status = row.status === 'paused' ? 'prepared' :
      row.status === 'running' ? 'interrupted' : row.status
    return { ...base, status, threadId: null, task: null, contract: null,
      reason: row.status === 'running'
        ? 'Job was marked running without a pinned request. Reconcile its durable state before starting.'
        : row.status === 'blocked' ? 'Job is blocked before generation; inspect its saved state.'
        : row.status === 'cancelled' ? 'Job was cancelled; generation cannot be started.' : null,
      completedStages: [] }
  }
  // An agent owns active graph state; never inspect partially committed
  // checkpoints while it may be between a Git commit and its receipt.
  if (queued?.phase === 'running')
    return { ...base, status: 'running', threadId: row.threadId,
      task: pinned.task, contract: pinned.contract, reason: null, completedStages: [] }
  // A failed writer may leave a dirty tree or Git HEAD beyond its verified
  // receipt. Inspection must remain possible without implying it is trusted.
  if (row.status === 'cancelled') return { ...base, status: 'cancelled',
    threadId: row.threadId, task: pinned.task, contract: pinned.contract,
    reason: 'Generation was cancelled. Saved files and receipts were retained.', completedStages: [] }
  if (queued?.phase === 'interrupted') return { ...base, status: 'interrupted',
    threadId: row.threadId, task: pinned.task, contract: pinned.contract,
    reason: 'Previous worker stopped without clean completion. Inspect preserved files and receipts; no replay is permitted.',
    completedStages: [] }
  let revisionVerified = true
  try {
    await verifyTrustedRevision(job)
    // A verified Git commit is not evidence that an unfinished specialist's
    // working files were accepted. Keep the separate dirty-tree distinction.
    const env = { ...process.env }
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX']) delete env[key]
    if (execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: job.worktreeRoot, env, encoding: 'utf8',
    }).trim()) throw new Error('Uncommitted specialist files remain')
  }
  catch {
    // A failed specialist is expected to leave a dirty worktree on a
    // previously verified HEAD. Owner-scoped, settled checkpoint INSPECTION
    // must still work; this does not authorize a write or a retry.
    if (!row.requestJson || !['blocked', 'paused', 'interrupted'].includes(row.status) ||
        ['queued', 'running'].includes(queued?.phase ?? ''))
      throw new JobError(409, 'Unverified job revision requires operator reconciliation.')
    revisionVerified = false
  }
  if (queued?.phase === 'queued') return { ...base, status: 'queued',
    threadId: row.threadId, task: pinned.task, contract: pinned.contract,
    reason: 'Waiting for an available generation slot.', completedStages: [] }
  const checkpoint = join(job.stateDir, 'web-generation.sqlite')
  const initial = { ...base, threadId: row.threadId, task: pinned.task, contract: pinned.contract }
  if (!existsSync(checkpoint)) {
    if (row.status === 'paused' && await readJobControl(job) === 'paused')
      return { ...initial, status: 'paused', reason: 'Paused before its first work item.', completedStages: [] }
    return { ...initial, status: 'interrupted',
      reason: 'No generation checkpoint was published. Inspect the preserved job before any retry.',
      completedStages: [] }
  }
  const { saver, graph } = openWebGenerationGraph(checkpoint)
  try {
    const snapshot = await graph.getState({ configurable: { thread_id: row.threadId! } })
    const state = snapshot.values as {
      request?: GenerationRequest; status?: string; reason?: string | null
      active?: { stage?: string; id?: string } | null
      completedStages?: Array<{ stage: string; status: string }>
    }
    if (!state.request) {
      return { ...initial, status: 'interrupted',
        reason: 'No saved generation request. Inspect the preserved checkpoint before recovery.',
        completedStages: [] }
    }
    if (JSON.stringify(state.request) !== JSON.stringify(pinned) ||
        !existsSync(join(job.stateDir, 'generation-server-owner.json'))) {
      throw new JobError(409, 'Generation checkpoint or execution owner differs from the pinned request.')
    }
    try { await assertServerClaimPermitted(job, row.threadId!, pinned) }
    catch { throw new JobError(409, 'Generation owner receipt conflicts with this job. Inspect saved state before recovery.') }
    const interrupted = state.status === 'running'
    const isFoundationHandoff = state.active?.stage === 'foundation' &&
      state.reason === 'Foundation requires an explicit author decision before generation can proceed.'
    const handoff = isFoundationHandoff ? await inspectFoundationConflict(job) : null
    const authorReady = handoff?.status === 'authorized' && !handoff.retryUsed && row.status === 'paused'
    // A previously authorized Foundation is not a permanent status override:
    // later specialist failures must show their OWN checkpoint reason.
    const checkpointReason = typeof state.reason === 'string'
      ? state.reason.slice(0, 2400).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '') : null
    let recovery: { kind: 'manual-specialist' | 'operator-reconciliation'; stage: string;
      workItem: string | null; files: string[]; candidateDigest: string | null;
      guidance: string } | null = null
    let waitingForChoice = false
    if (!revisionVerified && row.status === 'paused' && state.active?.stage === 'foundations' &&
        checkpointReason === 'Specialist paused for an author choice. Review 2–4 options or supply your own direction in Author questions and approvals.') {
      try {
        const question = await activeSpecialistChoice(job)
        if (question && (question.phase === 'awaiting-author' || question.phase === 'answered')) {
          await verifySpecialistChoice(job, question.id, question.phase)
          waitingForChoice = true
        }
      } catch { /* unsafe/stale choice keeps manual reconciliation required */ }
    }
    if (['blocked', 'paused'].includes(row.status) && !revisionVerified && !waitingForChoice) {
      if (state.active?.stage === 'foundations' && existsSync(join(job.stateDir, 'character-world.json'))) {
        // The specialist owns the reconciliation contract. Inspect only; its
        // dirty work and Pi session must never be replayed or discarded by GET.
        try {
          const { runCharacterWorldJob } = await import('../../../src/character-world')
          const inspection = await runCharacterWorldJob({
            story: job.storyRoot, job: job.jobId, action: 'inspect',
          })
          if (!('recovery' in inspection)) throw new Error('Missing read-only recovery inspection')
          const candidate = inspection.recovery?.candidate
          const files = candidate?.paths ?? (inspection.recovery?.changes ?? [])
            .map((entry: string) => entry.slice(3).replace(/^story\//, ''))
            .filter((p: string) => /^(arcs|characters|relationships|facts|world-entities)\/[a-z0-9-]+\.md$/.test(p))
          recovery = {
            kind: 'manual-specialist', stage: 'foundations',
            workItem: candidate?.unit ?? state.active.id ?? null,
            files: files.slice(0, 32), candidateDigest: candidate?.digest ?? null,
            guidance: 'Review and repair the preserved, uncommitted specialist files. Reuse existing canonical character IDs rather than creating duplicates. Then inspect and explicitly reconcile the exact corrected files with the Character/World foundations workflow. This UI cannot safely replay or discard an unfinished writer; Resume stays disabled until the parent generation checkpoint is separately reconciled.',
          }
        } catch {
          // Even if the specialist inspect path is unavailable, report the
          // original checkpoint cause rather than hiding the blocked job.
        }
      }
      if (!recovery) recovery = {
        kind: 'operator-reconciliation', stage: state.active?.stage ?? 'unknown',
        workItem: state.active?.id ?? null, files: [], candidateDigest: null,
        guidance: 'An unfinished work item has unverified files or receipts. Inspect its saved session and Git changes, reconcile the original specialist, then verify the parent generation checkpoint before resuming. Automatic retry is disabled.',
      }
    }
    return { ...initial, status: interrupted ? 'interrupted' : authorReady ? 'paused' :
        (state.status ?? 'interrupted'),
      revisionVerified, recovery,
      reason: interrupted ? 'The graph did not finish before the server stopped; manual reconciliation is required.'
        : waitingForChoice ? 'The specialist is waiting for your creative decision. Choose one of 2–4 proposed approaches or enter your own answer under Author questions and approvals. After saving your choice, use Resume.'
        : authorReady ? 'Foundation exception approved; use Resume to request its first verified retry.'
        : handoff && handoff.status === 'rejected'
          ? 'Author rejected the requested Foundation exception. The protected decision remains binding.'
        : checkpointReason ?? (!revisionVerified
          ? 'The worktree has unverified changes. Review the saved specialist before recovery.' : null),
      completedStages: (state.completedStages ?? []).map(item => ({ stage: item.stage, status: item.status })) }
  } finally {
    saver.db.close()
  }
}

async function readInput(request: Request) {
  // Enforce the limit while reading; Request.text() would buffer an arbitrary
  // size body before checking its length in this multiuser service.
  const limit = 64 * 1024
  const reader = request.body?.getReader()
  if (!reader) throw new JobError(400, 'Missing generation request body.')
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > limit) throw new JobError(413, 'Generation request is too large.')
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally { reader.releaseLock() }
  let raw: string
  try { raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) }
  catch { throw new JobError(400, 'Generation request must be UTF-8 JSON.') }
  let input: Record<string, unknown>
  try {
    input = JSON.parse(raw) as Record<string, unknown>
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => key !== 'task' && key !== 'contract') ||
        typeof input.task !== 'string' || !input.task.trim() || input.task.length > 4000) {
      throw new Error('invalid request')
    }
  } catch {
    throw new JobError(400, 'Supply a task (up to 4000 characters) and a valid completion contract. Execution settings are server-controlled.')
  }
  try { return { task: (input.task as string).trim(), contract: parseGenerationContract(input.contract) } }
  catch { throw new JobError(422, 'Invalid generation contract. Specify an authorized typed Story scope and production envelope.') }
}

function reply(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}


/** The only owner-authenticated web generation entrypoint. */
export async function generationJobRequest(auth: StudioAuth, store: StudioDatabase, request: Request,
  id: string, baseURL: string): Promise<Response> {
  if (!['GET', 'POST'].includes(request.method)) return reply({ error: 'Method not allowed' }, 405)
  if (request.method === 'POST' && request.headers.get('origin') !== baseURL)
    return reply({ error: 'Cross-origin write refused' }, 403)
  try {
    assertStudioSchemaCurrent(store)
    const user = await requireUser(auth, request.headers)
    if (!user) throw new JobError(401, 'Sign in required.')
    const row = selectedJob(store, user.id, id)
    if (request.method === 'GET') {
      return reply({ job: await inspectRegisteredJob(store, row, user.id) })
    }
    const input = await readInput(request)
    const job = await restoreJob(row, user.id)
    const existing = pinnedRequest(row, job)
    if (existing && JSON.stringify({ task: existing.task, contract: existing.contract }) !== JSON.stringify(input))
      throw new JobError(409, 'Job already has a different pinned generation request.')
    const queued = queueRecord(store, id)
    if (existing) {
      return reply({ job: await inspectRegisteredJob(store, row, user.id) })
    }
    if (row.status !== 'paused') throw new JobError(409, 'Only a prepared job can start generation.')
    await verifyTrustedRevision(job)
    if (await readJobControl(job) !== 'running') throw new JobError(409, 'Job is paused or cancelled.')
    let selected: PiSelection | null = null
    if (row.configJson) {
      let config: { version?: unknown; headSha?: unknown; task?: unknown; contract?: unknown;
        model?: unknown; limits?: PiPolicy['limits'] }
      try { config = JSON.parse(row.configJson) as typeof config }
      catch { throw new JobError(409, 'Saved generation configuration is corrupt.') }
      if (config.version !== 1 || config.headSha !== job.headSha ||
          (config.model !== null && !validPiSelection(config.model)) ||
          JSON.stringify({ task: config.task, contract: config.contract }) !== JSON.stringify(input))
        throw new JobError(409, 'Start differs from saved generation configuration or Story revision.')
      selected = (config.model ?? null) as PiSelection | null
      if (selected) {
        try { await assertUserPiSelection(store, user.id, selected) }
        catch { throw new JobError(409, 'Pinned Pi credentials unavailable. Reconnect before starting.') }
      }
    }
    verifyWebExecution(!selected)
    const env = { ...process.env }
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX']) delete env[key]
    if (execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: job.worktreeRoot, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()) throw new JobError(409, 'Uncommitted files require manual reconciliation.')
    const pinned: GenerationRequest = {
      story: job.storyRoot, job: row.id, task: input.task, contract: input.contract, fixture: !selected,
      ...(process.env.NT_STUDIO_SKILLS_SOURCE ? { skillsSource: process.env.NT_STUDIO_SKILLS_SOURCE } : {}),
      ...(selected ? { provider: selected.provider, model: selected.id } : {}),
    }
    try { await assertServerClaimPermitted(job, job.threadId + ':generation:web', pinned) }
    catch { throw new JobError(409, 'CLI or conflicting server generation ownership prevents this queue admission.') }
    queueGeneration(store, user.id, row.id, 'start', 'prepared', JSON.stringify(pinned),
      job.threadId + ':generation:web')
    // The agent process owns graph execution, including fixture runs.
    return reply({ job: await inspectRegisteredJob(store, selectedJob(store, user.id, id), user.id) }, 202)
  } catch (error) {
    if (error instanceof JobError) return reply({ error: error.message }, error.status)
    // Do not include Pi/provider exceptions; they can contain credentials.
    console.error('[Studio generation] Unverified execution failure; saved state retained')
    return reply({ error: 'Job could not run safely. Inspect preserved receipts; automatic writer replay is disabled.' }, 500)
  }
}

export const fixtureJobRequest = generationJobRequest
