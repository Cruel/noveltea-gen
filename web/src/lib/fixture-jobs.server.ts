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
import { claimServerGeneration, assertServerClaimPermitted } from '../../../src/generation-owner'
import { withStoryJobLock } from '../../../src/job-lock'
import { trustedHead } from '../../../src/revision'
import { openWebGenerationGraph } from '../../../src/web-fixture-runtime'
import { appendGenerationEvent, committedStoryFiles } from './generation-progress.server'
import type { GenerationEvidence } from '../../../src/generation'
import { assertUserPiSelection, createUserPiRuntime, validPiSelection, type PiSelection } from './pi-credentials.server'
import { configurePiPolicy, resolvePiModel, type PiPolicy } from '../../../src/job-pi-policy'
import { withJobModelRuntime } from '../../../src/model-runtime'
import { SandboxClient } from '../../../src/sandbox-client'
import { readJobControl } from '../../../src/job-control'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { queueGeneration, queueRecord, claimNext, finishAttempt, fenceAbandonedRuns, dequeueBeforeStart, type QueueRecord } from './generation-queue.server'

class JobError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const SHA = /^[a-f0-9]{40}$/i
const active = new Set<string>()
const inFlight = new Map<string, Promise<void>>()
const initialized = new WeakSet<StudioDatabase>()

/** The database owns capacity; disconnected HTTP requests do not own runs. */
function pump(store: StudioDatabase) {
  if (!initialized.has(store)) {
    // Never re-enter an unfinished writer from a previous server lifetime.
    fenceAbandonedRuns(store)
    initialized.add(store)
  }
  for (;;) {
    const record = claimNext(store)
    if (!record) break
    active.add(record.jobId)
    const task = runPersistedGeneration(store, record)
      .then(() => finishAttempt(store, record.jobId, true))
      .catch(() => {
        // Provider errors may include secrets. Only sanitized controller events
        // and original receipts, not raw exceptions, leave this task.
        finishAttempt(store, record.jobId, false)
        appendGenerationEvent(store, record.ownerId, record.jobId, { kind: 'interrupted' })
        throw new Error('Generation failed; preserve its original receipts for recovery.')
      })
      .finally(() => {
        inFlight.delete(record.jobId)
        active.delete(record.jobId)
        pump(store)
      })
    inFlight.set(record.jobId, task)
    void task.catch(() => {})
  }
}

type SavedJob = {
  id: string; storyId: string; title: string; commitSha: string | null
  provider: string; providerId: string; directory: string
  requestJson: string | null; threadId: string | null; configJson: string | null; status: string
}
function selectedJob(store: StudioDatabase, owner: string, id: string): SavedJob {
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

async function restoreJob(row: SavedJob, owner: string): Promise<JobStartResult> {
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

async function verifyTrustedRevision(job: JobStartResult) {
  try { await trustedHead(job) }
  catch { throw new JobError(409, 'Job HEAD is not a verified narrative revision. Reconcile the preserved branch before generation.') }
}

function verifyWebExecution(fixture: boolean) {
  // Fixture-only evaluation must not silently invoke real model placement.
  if (fixture && process.env.NT_LIVE_GENERATION_IDEA === '1') {
    throw new JobError(503, 'Fixture execution refuses live model-directed idea placement.')
  }
  if (!fixture && (!process.env.NT_SANDBOX_SOCKET?.startsWith('/') ||
      !process.env.NT_SANDBOX_TOKEN_FILE?.startsWith('/') ||
      process.env.NT_REQUIRE_USER_PI_RUNTIME !== '1')) {
    throw new JobError(503, 'Real generation requires a rootless sandbox controller and an isolated per-user Pi runtime.')
  }
}
function pinnedRequest(row: SavedJob, job: JobStartResult): GenerationRequest | null {
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

async function inspect(store: StudioDatabase, row: SavedJob, owner: string) {
  const job = await restoreJob(row, owner)
  const pinned = pinnedRequest(row, job)
  const queued = queueRecord(store, row.id)
  const base = { id: row.id, storyId: row.storyId, title: row.title, provider: row.provider,
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
  // The writer may be between its Git commit and trusted-head receipt.
  // Never mistake that intentionally transient boundary for corrupt recovery.
  if (queued?.phase === 'running' && active.has(row.id))
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
  await verifyTrustedRevision(job)
  if (queued?.phase === 'queued') return { ...base, status: 'queued',
    threadId: row.threadId, task: pinned.task, contract: pinned.contract,
    reason: 'Waiting for an available generation slot.', completedStages: [] }
  const checkpoint = join(job.stateDir, 'web-generation.sqlite')
  const running = active.has(row.id)
  const initial = { ...base, threadId: row.threadId, task: pinned.task, contract: pinned.contract }
  if (!existsSync(checkpoint)) {
    if (row.status === 'paused' && await readJobControl(job) === 'paused')
      return { ...initial, status: 'paused', reason: 'Paused before its first work item.', completedStages: [] }
    return { ...initial, status: running ? 'running' : 'interrupted',
      reason: running ? null : 'No generation checkpoint was published. Inspect the preserved job before any retry.',
      completedStages: [] }
  }
  const { saver, graph } = openWebGenerationGraph(checkpoint)
  try {
    const snapshot = await graph.getState({ configurable: { thread_id: row.threadId! } })
    const state = snapshot.values as {
      request?: GenerationRequest; status?: string; reason?: string | null
      completedStages?: Array<{ stage: string; status: string }>
    }
    if (!state.request) {
      return { ...initial, status: running ? 'running' : 'interrupted',
        reason: running ? null : 'No saved generation request. Inspect the preserved checkpoint before recovery.',
        completedStages: [] }
    }
    if (JSON.stringify(state.request) !== JSON.stringify(pinned) ||
        !existsSync(join(job.stateDir, 'generation-server-owner.json'))) {
      throw new JobError(409, 'Generation checkpoint or execution owner differs from the pinned request.')
    }
    try { await claimServerGeneration(job, row.threadId!, pinned) }
    catch { throw new JobError(409, 'Generation owner receipt conflicts with this job. Inspect saved state before recovery.') }
    const interrupted = state.status === 'running' && !running
    return { ...initial, status: interrupted ? 'interrupted' : (state.status ?? 'interrupted'),
      reason: interrupted ? 'The graph did not finish before the server stopped; manual reconciliation is required.'
        : pinned.fixture ? (state.reason ?? null) : state.reason
          ? 'Generation needs review. Inspect the saved specialist, validator and approval receipts before recovery.' : null,
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

/** Verify the queued identity and resume the pinned graph, never browser inputs. */
async function runPersistedGeneration(store: StudioDatabase, item: QueueRecord): Promise<void> {
  const row = selectedJob(store, item.ownerId, item.jobId)
  const job = await restoreJob(row, item.ownerId)
  const pinned = pinnedRequest(row, job)
  if (!pinned || row.status !== 'paused' || queueRecord(store, row.id)?.phase !== 'running')
    throw new Error('Queued generation state changed before execution.')
  const config = row.configJson ? JSON.parse(row.configJson) as {
    model?: PiSelection | null; limits?: PiPolicy['limits']
  } : null
  const selected = config?.model ?? null
  if (selected && !validPiSelection(selected)) throw new Error('Saved Pi model is invalid.')
  if (pinned.fixture === !!selected) throw new Error('Saved Pi model disagrees with pinned execution.')
  verifyWebExecution(pinned.fixture)
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
    const current = store.sqlite.prepare(`SELECT status, generation_request_json AS request,
      generation_thread_id AS thread FROM studio_sessions WHERE id=? AND owner_user_id=?`)
      .get(row.id, item.ownerId) as { status: string; request: string; thread: string } | undefined
    if (current?.status !== 'paused' || current.request !== JSON.stringify(pinned) ||
        current.thread !== threadId || queueRecord(store, row.id)?.phase !== 'running')
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
      const updated = store.sqlite.prepare(`UPDATE studio_sessions SET status='running', updated_at=?
        WHERE id=? AND owner_user_id=? AND status='paused' AND generation_thread_id=?`)
        .run(new Date().toISOString(), row.id, item.ownerId, threadId)
      if (updated.changes !== 1) throw new Error('Concurrent admission.')
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
      const prior = await graph.getState({ configurable: { thread_id: threadId } })
      const stages = (prior.values as { completedStages?: GenerationEvidence[] }).completedStages ?? []
      let working = '', verified = stages.length
      let previousHead = stages.at(-1)?.headSha ?? job.headSha
      for await (const patch of await graph.stream({ request: pinned,
        pauseAfter: item.intent === 'start' && pinned.fixture ? 'foundation' : null },
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
            previousHead = evidence.headSha
          }
          verified = completed.length
        }
      }
      const snapshot = await graph.getState({ configurable: { thread_id: threadId } })
      const outcome = snapshot.values as { status?: string }
      const state = ['running', 'paused', 'blocked', 'completed', 'cancelled'].includes(outcome.status || '')
        ? outcome.status! : 'blocked'
      store.sqlite.prepare(`UPDATE studio_sessions SET status=?, updated_at=?
        WHERE id=? AND owner_user_id=? AND generation_thread_id=?`)
        .run(state, new Date().toISOString(), row.id, item.ownerId, threadId)
      if (state === 'running') throw new Error('Graph stream ended without safe terminal state.')
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
      pump(store)
      return reply({ job: await inspect(store, row, user.id) })
    }
    const input = await readInput(request)
    const job = await restoreJob(row, user.id)
    const existing = pinnedRequest(row, job)
    if (existing && JSON.stringify({ task: existing.task, contract: existing.contract }) !== JSON.stringify(input))
      throw new JobError(409, 'Job already has a different pinned generation request.')
    const queued = queueRecord(store, id)
    if (existing) {
      pump(store)
      return reply({ job: await inspect(store, row, user.id) })
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
    pump(store)
    // Fixture compatibility: an immediately admitted fixture returns its
    // checkpointed outcome; queued and real Pi jobs detach from the HTTP call.
    const task = pinned.fixture ? inFlight.get(id) : undefined
    if (task) {
      await task
      return reply({ job: await inspect(store, selectedJob(store, user.id, id), user.id) }, 201)
    }
    return reply({ job: await inspect(store, selectedJob(store, user.id, id), user.id) }, 202)
  } catch (error) {
    if (error instanceof JobError) return reply({ error: error.message }, error.status)
    // Do not include Pi/provider exceptions; they can contain credentials.
    console.error('[Studio generation] Unverified execution failure; saved state retained')
    return reply({ error: 'Job could not run safely. Inspect preserved receipts; automatic writer replay is disabled.' }, 500)
  }
}

export const fixtureJobRequest = generationJobRequest
