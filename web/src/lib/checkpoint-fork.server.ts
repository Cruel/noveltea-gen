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
import { snapshotForkBoundaryHistory } from './thread-fork-history.server'

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
    const row = await selectedJob(store, user.id, sourceId)
    if (row.commitSha !== input.sourceBaseSha) return reply({ error: 'Source identity changed; refresh the job.' }, 409)
    const parent = await restoreJob(row, user.id)
    await ensureRootThreads(store, user.id, row.storyId)
    const sourceThread = await store.persistence.advancedThreads.sourceThread(user.id, sourceId)
    if (!sourceThread || sourceThread.id !== input.sourceThreadId)
      return reply({ error: 'Source Thread changed; refresh its timeline.' }, 409)
    const existing = await store.persistence.advancedThreads.jobClaimed(input.childId)
    const readIntent = () => store.persistence.advancedThreads.forkIntent(input.childId as string)
    let intent = await readIntent()
    const matches = (saved: Intent) => saved.owner === user.id && saved.source === sourceId &&
      saved.base === input.sourceBaseSha && saved.commitSha === input.commitSha &&
      saved.sourceThreadId === input.sourceThreadId && saved.proofDigest === input.proofDigest &&
      saved.guidance === guidance
    if (intent && !matches(intent) || existing && !intent)
      return reply({ error: 'Child ID is already assigned to another operation.' }, 409)
    if (existing && intent) {
      const child = await restoreJob(await selectedJob(store, user.id, input.childId), user.id)
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
      const history = await snapshotForkBoundaryHistory(store, user.id, sourceThread.id, parent,
        original.task, row.createdAt, input.commitSha as string)
      const prior = row.configJson ? JSON.parse(row.configJson) as GenerationDraft : null
      const draft: GenerationDraft = { version: 1, headSha: input.commitSha, task,
        contract: bundle.contract, model: prior?.model ?? null, limits: prior?.limits ?? {} }
      // The port checks child collisions and persists the immutable intent in
      // one SQLite IMMEDIATE transaction before any Git worktree allocation.
      intent = await store.persistence.advancedThreads.reserveFork({
        childId: input.childId, owner: user.id, sourceJobId: sourceId,
        sourceBaseSha: input.sourceBaseSha, commitSha: input.commitSha,
        bundle: JSON.stringify(bundle), draft: JSON.stringify(draft),
        sourceThreadId: input.sourceThreadId as string, proofDigest: input.proofDigest as string,
        guidance, history: JSON.stringify(history), at: new Date().toISOString(),
      })
      if (!matches(intent)) throw new GitCacheError(409, 'Child ID was reserved concurrently.')

    }
    const child = await forkCachedStory(parent, JSON.parse(intent!.bundle) as RecoveryForkBundle)
    const now = new Date().toISOString()
    await store.persistence.advancedThreads.registerChild({
      childId: child.jobId, owner: user.id, storyId: row.storyId,
      title: row.title + ' (fork)', baseSha: child.baseSha,
      conversationId: sourceThread.conversation, parentThreadId: sourceThread.id,
      threadId: 'fork:' + child.jobId, draft: intent!.draft,
      at: now, kind: 'fork', history: intent!.history ? JSON.parse(intent!.history) as
        import('./thread-fork-history.server').ForkHistoryMessage[] : undefined,
      guidance: intent!.guidance,
    })
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
