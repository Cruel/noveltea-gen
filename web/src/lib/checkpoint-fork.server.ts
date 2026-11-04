import type { StudioAuth } from './auth'
import type { StudioDatabase } from '../db/connection'
import { assertStudioSchemaCurrent } from '../db/migrations'
import { requireUser } from './access.server'
import { selectedJob, restoreJob, pinnedRequest } from './fixture-jobs.server'
import { readJsonInput, JsonInputError } from './json-input.server'
import { forkCachedStory, GitCacheError } from './git-cache.server'
import { collectRecoveryFork } from '../../../src/recovery-fork'
import { RecoveryCompatibilityError } from '../../../src/recovery-compatibility'
import { forkSourceSummary, type RecoveryForkBundle } from '../../../src/recovery-fork-state'
import type { GenerationDraft } from './generation-config.server'
import { ensureRootThreads } from './threads.server'
import { recordForkBoundaryHistory, snapshotForkBoundaryHistory, type ForkHistoryMessage } from './thread-fork-history.server'

const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
type Intent = { owner: string; source: string; base: string; commitSha: string; bundle: string; draft: string;
  sourceThreadId: string | null; proofDigest: string | null; guidance: string; history: string | null }

/** Authenticated server-function adapter. Clients select opaque IDs and exact
 * revisions only. The durable intent reserves the child ID across owners and
 * repositories before asynchronous Git allocation; it is never a writer grant. */
export async function checkpointForkRequest(auth: StudioAuth, store: StudioDatabase,
  request: Request, sourceId: string, baseURL: string): Promise<Response> {
  if (request.method !== 'POST') return reply({ error: 'Method not allowed' }, 405)
  if (request.headers.get('origin') !== baseURL) return reply({ error: 'Cross-origin write refused' }, 403)
  try {
    assertStudioSchemaCurrent(store)
    const user = await requireUser(auth, request.headers)
    if (!user) return reply({ error: 'Sign in required' }, 401)
    const input = await readJsonInput(request, 4096) as Record<string, unknown>
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).sort().join(',') !== 'childId,commitSha,guidance,proofDigest,sourceBaseSha,sourceThreadId' ||
        typeof input.childId !== 'string' || !uuid.test(input.childId) || input.childId === sourceId ||
        typeof input.commitSha !== 'string' || !/^[a-f0-9]{40}$/.test(input.commitSha) ||
        typeof input.sourceBaseSha !== 'string' || !/^[a-f0-9]{40}$/.test(input.sourceBaseSha) ||
        typeof input.sourceThreadId !== 'string' || !/^[a-zA-Z0-9:_-]{1,128}$/.test(input.sourceThreadId) ||
        typeof input.proofDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.proofDigest) ||
        typeof input.guidance !== 'string' || input.guidance.length > 2000 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.guidance))
      return reply({ error: 'Select an exact Thread, finalized checkpoint proof and bounded guidance.' }, 400)
    const guidance = input.guidance.trim()
    const row = selectedJob(store, user.id, sourceId)
    if (row.commitSha !== input.sourceBaseSha) return reply({ error: 'Source identity changed; refresh the job.' }, 409)
    const parent = await restoreJob(row, user.id)
    ensureRootThreads(store, user.id, row.storyId)
    const sourceThread = store.sqlite.prepare(`SELECT r.thread_id AS id,t.conversation_id AS conversation
      FROM story_thread_runs r JOIN story_threads t ON t.id=r.thread_id AND t.owner_user_id=r.owner_user_id
      WHERE r.job_id=? AND r.owner_user_id=?`).get(sourceId, user.id) as
      { id: string; conversation: string } | undefined
    if (!sourceThread || sourceThread.id !== input.sourceThreadId)
      return reply({ error: 'Source Thread changed; refresh its timeline.' }, 409)
    const existing = store.sqlite.prepare('SELECT owner_user_id AS owner FROM studio_sessions WHERE id=?').get(input.childId)
    const readIntent = () => store.sqlite.prepare(`SELECT owner_user_id AS owner,source_job_id AS source,
      source_base_sha AS base,commit_sha AS commitSha,bundle_json AS bundle,draft_json AS draft,
      source_thread_id AS sourceThreadId,proof_digest AS proofDigest,guidance,history_json AS history
      FROM checkpoint_forks WHERE child_id=?`).get(input.childId) as Intent | undefined
    let intent = readIntent()
    const matches = (saved: Intent) => saved.owner === user.id && saved.source === sourceId &&
      saved.base === input.sourceBaseSha && saved.commitSha === input.commitSha &&
      saved.sourceThreadId === input.sourceThreadId && saved.proofDigest === input.proofDigest &&
      saved.guidance === guidance
    if (intent && !matches(intent) || existing && !intent)
      return reply({ error: 'Child ID is already assigned to another operation.' }, 409)
    if (existing && intent) {
      const child = await restoreJob(selectedJob(store, user.id, input.childId), user.id)
      const source = forkSourceSummary(child)
      if (source?.jobId !== sourceId || source.commitSha !== input.commitSha)
        throw new GitCacheError(409, 'Child fork source does not match its saved intent.')
      return reply({ id: child.jobId, storyId: row.storyId, forkSource: source })
    }
    if (!intent) {
      const original = pinnedRequest(row, parent)
      if (!original) throw new GitCacheError(409, 'Source has no pinned generation request.')
      const bundle = await collectRecoveryFork(parent, input.childId, input.commitSha,
        original.contract, original.skillsSource)
      if (bundle.checkpoint.proofDigest !== input.proofDigest)
        return reply({ error: 'Checkpoint proof changed; refresh the timeline.' }, 409)
      const task = guidance ? original.task + '\n\nCorrective guidance for this branch:\n' + guidance : original.task
      if (task.length > 4000) return reply({ error: 'Guidance exceeds the prepared run task limit.' }, 400)
      const history = snapshotForkBoundaryHistory(store, user.id, sourceThread.id, parent,
        original.task, row.createdAt, input.commitSha as string)
      const prior = row.configJson ? JSON.parse(row.configJson) as GenerationDraft : null
      const draft: GenerationDraft = { version: 1, headSha: input.commitSha, task,
        contract: bundle.contract, model: prior?.model ?? null, limits: prior?.limits ?? {} }
      // No awaits inside reservation: all preflight failures have no durable side effects.
      store.sqlite.transaction(() => {
        const collision = store.sqlite.prepare('SELECT 1 FROM studio_sessions WHERE id=?').get(input.childId)
        if (collision) throw new GitCacheError(409, 'Child ID was assigned concurrently.')
        store.sqlite.prepare(`INSERT INTO checkpoint_forks
          (child_id,owner_user_id,source_job_id,source_base_sha,commit_sha,bundle_json,draft_json,created_at,
           source_thread_id,proof_digest,guidance,history_json)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(child_id) DO NOTHING`).run(input.childId, user.id, sourceId,
          input.sourceBaseSha, input.commitSha, JSON.stringify(bundle), JSON.stringify(draft), new Date().toISOString(),
          input.sourceThreadId, input.proofDigest, guidance, JSON.stringify(history))
        intent = readIntent()
        if (!intent || !matches(intent)) throw new GitCacheError(409, 'Child ID was reserved concurrently.')
      })()
    }
    const child = await forkCachedStory(parent, JSON.parse(intent!.bundle) as RecoveryForkBundle)
    const now = new Date().toISOString()
    store.sqlite.transaction(() => {
      const saved = store.sqlite.prepare(`INSERT INTO studio_sessions
        (id,owner_user_id,story_id,title,source_commit_sha,status,created_at,updated_at,generation_config_json)
        VALUES (?,?,?,?,?,'paused',?,?,?) ON CONFLICT(id) DO NOTHING`).run(input.childId, user.id, row.storyId,
        row.title + ' (fork)', child.baseSha, now, now, intent!.draft)
      if (saved.changes === 1) {
        store.sqlite.prepare(`INSERT INTO story_threads (id,owner_user_id,conversation_id,parent_thread_id,title,activity_at,created_at)
          VALUES (?,?,?,?,?,?,?)`).run('fork:' + child.jobId, user.id, sourceThread.conversation, sourceThread.id, row.title + ' (fork)', now, now)
        store.sqlite.prepare(`INSERT INTO story_thread_runs (job_id,owner_user_id,thread_id,run_order)
          VALUES (?,?,?,0)`).run(child.jobId, user.id, 'fork:' + child.jobId)
        if (!intent!.history) throw new GitCacheError(409, 'Fork history snapshot is missing.')
        recordForkBoundaryHistory(store, user.id, 'fork:' + child.jobId,
          JSON.parse(intent!.history) as ForkHistoryMessage[], intent!.guidance, now)
      } else {
        const registered = selectedJob(store, user.id, child.jobId)
        if (registered.storyId !== row.storyId || registered.commitSha !== child.baseSha)
          throw new GitCacheError(409, 'Child registration changed concurrently.')
      }
    })()
    return reply({ id: child.jobId, storyId: row.storyId, forkSource: forkSourceSummary(child) })
  } catch (error) {
    console.error('[Studio checkpoint fork]', error instanceof Error ? error.message : 'Unknown preparation failure')
    if (error instanceof RecoveryCompatibilityError)
      return reply({ error: error.message, code: error.code, nextSteps: error.nextSteps }, 409)
    const status = error instanceof JsonInputError ? error.statusCode :
      error instanceof Error && 'status' in error && typeof error.status === 'number' ? error.status : 409
    // Internal receipt/path details never cross the authenticated browser boundary.
    return reply({ error: status === 404 ? 'Job not found' : status === 413 ? 'Fork request too large' :
      'Checkpoint fork could not be verified or prepared. Refresh the source and inspect saved recovery evidence.' }, status)
  }
}
