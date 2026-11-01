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
import { claimServerGeneration } from '../../../src/generation-owner'
import { trustedHead } from '../../../src/revision'
import { openWebFixtureGraph } from '../../../src/web-fixture-runtime'

class JobError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const SHA = /^[a-f0-9]{40}$/i
const active = new Set<string>() // one server process owns each SQLite checkpointer

type SavedJob = {
  id: string; storyId: string; title: string; commitSha: string | null
  provider: string; providerId: string; directory: string
  requestJson: string | null; threadId: string | null; status: string
}
function selectedJob(store: StudioDatabase, owner: string, id: string): SavedJob {
  if (!UUID.test(id)) throw new JobError(400, 'Invalid job ID.')
  const row = store.sqlite.prepare(`SELECT j.id, j.story_id AS storyId, j.title, j.status,
    j.source_commit_sha AS commitSha, j.generation_request_json AS requestJson,
    j.generation_thread_id AS threadId, s.directory,
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

async function verifyTrustedRevision(job: JobStartResult) {
  try { await trustedHead(job) }
  catch { throw new JobError(409, 'Job HEAD is not a verified narrative revision. Reconcile the preserved branch before generation.') }
}

function verifyFixtureRuntime() {
  // The old opt-in live idea-placement evaluation is deliberately forbidden
  // in this unsandboxed web phase even when a deployer enabled it elsewhere.
  if (process.env.NT_LIVE_GENERATION_IDEA === '1') {
    throw new JobError(503, 'Fixture-only Studio refuses live idea-placement configuration.')
  }
}
function pinnedRequest(row: SavedJob, job: JobStartResult): GenerationRequest | null {
  if (!row.requestJson) return null
  let request: GenerationRequest
  try {
    request = JSON.parse(row.requestJson) as GenerationRequest
    if (request.fixture !== true || request.story !== job.storyRoot || request.job !== row.id ||
        !request.task?.trim() || !request.contract ||
        JSON.stringify(parseGenerationContract(request.contract)) !== JSON.stringify(request.contract) ||
        request.provider !== undefined || request.model !== undefined ||
        request.skillsSource !== undefined && request.skillsSource !== process.env.NT_STUDIO_SKILLS_SOURCE ||
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

async function inspect(row: SavedJob, owner: string) {
  const job = await restoreJob(row, owner)
  const pinned = pinnedRequest(row, job)
  const base = { id: row.id, storyId: row.storyId, title: row.title,
    baseSha: job.baseSha, headSha: job.headSha, fixture: true as const }
  if (!pinned) return { ...base, status: 'prepared', threadId: null, task: null, contract: null,
    reason: null, completedStages: [] }
  await verifyTrustedRevision(job)
  const checkpoint = join(job.stateDir, 'web-generation.sqlite')
  const running = active.has(row.id)
  const initial = { ...base, threadId: row.threadId, task: pinned.task, contract: pinned.contract }
  if (!existsSync(checkpoint)) {
    return { ...initial, status: running ? 'running' : 'interrupted',
      reason: running ? null : 'No generation checkpoint was published. Inspect the preserved job before any retry.',
      completedStages: [] }
  }
  const { saver, graph } = openWebFixtureGraph(checkpoint)
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
    await claimServerGeneration(job, row.threadId!, pinned)
    const interrupted = state.status === 'running' && !running
    return { ...initial, status: interrupted ? 'interrupted' : (state.status ?? 'interrupted'),
      reason: interrupted ? 'The graph did not finish before the server stopped; manual reconciliation is required.'
        : (state.reason ?? null),
      completedStages: (state.completedStages ?? []).map(item => ({ stage: item.stage, status: item.status })) }
  } finally {
    saver.db.close()
  }
}

async function readInput(request: Request) {
  const raw = await request.text()
  if (raw.length > 64 * 1024) throw new JobError(413, 'Generation request is too large.')
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

/** The only web generation entrypoint: never accept model/tool/fixture/path settings. */
export async function fixtureJobRequest(auth: StudioAuth, store: StudioDatabase, request: Request,
  id: string, baseURL: string): Promise<Response> {
  if (!['GET', 'POST'].includes(request.method)) return reply({ error: 'Method not allowed' }, 405)
  if (request.method === 'POST' && request.headers.get('origin') !== baseURL) {
    return reply({ error: 'Cross-origin write refused' }, 403)
  }
  try {
    assertStudioSchemaCurrent(store)
    const user = await requireUser(auth, request.headers)
    if (!user) throw new JobError(401, 'Sign in required.')
    const row = selectedJob(store, user.id, id)
    if (request.method === 'GET') return reply({ job: await inspect(row, user.id) })
    verifyFixtureRuntime()
    const input = await readInput(request)
    const job = await restoreJob(row, user.id)
    await verifyTrustedRevision(job)
    if (row.requestJson) {
      const existing = pinnedRequest(row, job)
      if (JSON.stringify({ task: existing?.task, contract: existing?.contract }) !== JSON.stringify(input)) {
        throw new JobError(409, 'This job already has a different pinned generation request.')
      }
      return reply({ job: await inspect(row, user.id) })
    }
    if (row.status !== 'paused') {
      throw new JobError(409, 'Only a paused, prepared job can start fixture generation. Inspect its saved state first.')
    }
    // Never run a graph over staged, untracked or partially authored files.
    const env = { ...process.env }
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX']) delete env[key]
    if (execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: job.worktreeRoot, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()) {
      throw new JobError(409, 'Job has uncommitted changes. Inspect and reconcile them before generation.')
    }
    const requestValue: GenerationRequest = {
      story: job.storyRoot, job: row.id, task: input.task, contract: input.contract, fixture: true,
      ...(process.env.NT_STUDIO_SKILLS_SOURCE ? { skillsSource: process.env.NT_STUDIO_SKILLS_SOURCE } : {}),
    }
    const threadId = job.threadId + ':generation:web'
    const started = store.sqlite.prepare(`UPDATE studio_sessions
      SET generation_request_json=?, generation_thread_id=?, status='running', updated_at=?
      WHERE id=? AND owner_user_id=? AND generation_request_json IS NULL AND generation_thread_id IS NULL`)
      .run(JSON.stringify(requestValue), threadId, new Date().toISOString(), row.id, user.id)
    if (started.changes !== 1) throw new JobError(409, 'Generation was claimed concurrently. Reopen its saved status.')
    active.add(row.id)
    const checkpoint = join(job.stateDir, 'web-generation.sqlite')
    const { saver, graph } = openWebFixtureGraph(checkpoint)
    try {
      const result = await graph.invoke({ request: requestValue, pauseAfter: 'foundation' },
        { configurable: { thread_id: threadId }, recursionLimit: 10000 })
      const outcome = result as { status?: string }
      const state = ['running', 'paused', 'blocked', 'completed', 'cancelled'].includes(outcome.status || '')
        ? outcome.status! : 'blocked'
      store.sqlite.prepare(`UPDATE studio_sessions SET status=?, updated_at=?
        WHERE id=? AND owner_user_id=? AND generation_thread_id=?`)
        .run(state, new Date().toISOString(), row.id, user.id, threadId)
    } finally {
      saver.db.close()
      active.delete(row.id)
    }
    return reply({ job: await inspect(selectedJob(store, user.id, id), user.id) }, 201)
  } catch (error) {
    if (error instanceof JobError) return reply({ error: error.message }, error.status)
    // Unexpected failures preserve job receipts and checkpoints; do not replay.
    console.error('[Studio fixture job] Failure; preserved state for inspection', error instanceof Error ? error.stack : String(error))
    return reply({ error: 'Job could not be executed safely. Inspect its preserved state; automatic replay is disabled.' }, 500)
  }
}
