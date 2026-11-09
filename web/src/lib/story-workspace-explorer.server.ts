import type { StudioAuth } from './auth'
import type { StudioStore } from '../persistence/store'
import { requireUser } from './access.server'
import { selectedJob } from './fixture-jobs.server'
import { storyExplorerRequest, storyRelationshipsRequest } from './story-explorer.server'

type Kind = 'index' | 'record' | 'graph'
const SHA = /^[a-f0-9]{40}$/i
const ID = /^[a-zA-Z0-9:_-]{1,128}$/

/** The browser chooses a Story and optionally a Thread, never a Job, path,
 * filesystem root, Git SHA, or validator. This is the only bridge from the
 * Story-first workspace into the existing native-backed Job explorer. */
export async function storyWorkspaceExplorerRequest(
  auth: StudioAuth,
  store: StudioStore,
  request: Request,
  storyId: string,
  threadId: string | null,
  kind: Kind,
): Promise<Response> {
  const json = (value: unknown, status = 200) =>
    Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } })
  if (request.method !== 'GET') return json({ error: 'Method not allowed.' }, 405)
  try {
    if (!ID.test(storyId) || (threadId !== null && !ID.test(threadId)))
      return json({ error: 'Invalid Story or Thread identity.' }, 400)
    await store.assertReady()
    const actor = await requireUser(auth, request.headers)
    if (!actor) return json({ error: 'Sign in required.' }, 401)
    const [story, pinned] = await Promise.all([
      store.persistence.conversations.story(actor.id, storyId),
      store.persistence.naturalStory.story(actor.id, storyId),
    ])
    if (!story || !pinned) return json({ error: 'Story not found.' }, 404)
    if (!SHA.test(pinned.headSha ?? ''))
      return json({ error: 'Story source does not have a verified commit pin.' }, 409)

    // No Thread: expose only source provenance, never fabricate a native
    // catalog from a sparse cached Git base that has not been validated.
    if (!threadId) {
      if (kind !== 'index' || new URL(request.url).search)
        return json({ error: 'Select a Thread to inspect a canonical record.' }, 404)
      return json({ source: 'base', baseSha: pinned.headSha,
        story: { title: story.title, provider: pinned.provider, directory: pinned.directory },
        index: null, jobId: null })
    }

    const membership = await store.persistence.conversations.navigation(actor.id, storyId)
    const member = membership.threads.find(thread => thread.id === threadId && !thread.deletedAt)
    if (!member) return json({ error: 'Thread not found in this Story.' }, 404)
    const run = await store.persistence.continuation.current(actor.id, threadId)
    if (!run || !member.jobId || run.jobId !== member.jobId)
      return json({ error: 'Thread has no consistent registered source run.' }, 409)
    const saved = await selectedJob(store, actor.id, run.jobId)
    if (saved.storyId !== storyId || saved.provider !== pinned.provider ||
        saved.providerId !== pinned.providerId || saved.directory !== pinned.directory)
      return json({ error: 'Thread source identity does not match this Story.' }, 409)
    if (!(run.status === 'completed' && run.queuePhase === 'finished') &&
        !(run.status === 'paused' && !saved.requestJson && !run.queuePhase))
      return json({ error: 'Thread execution has no settled verified canonical revision.' }, 409)

    const verified = { storyBaseSha: pinned.headSha! }
    const response = kind === 'graph'
      ? await storyRelationshipsRequest(auth, store, request, run.jobId, verified)
      : await storyExplorerRequest(auth, store, request, run.jobId, verified)
    if (!response.ok) return response

    // A later Turn can replace a Thread's latest run during validation. Do
    // not return a snapshot mislabeled as the selected Thread's current HEAD.
    const current = await store.persistence.continuation.current(actor.id, threadId)
    if (!current || current.jobId !== run.jobId || current.status !== run.status ||
        current.queuePhase !== run.queuePhase)
      return json({ error: 'Thread revision changed during inspection. Refresh the explorer.' }, 409)
    const body = await response.json() as Record<string, unknown>
    return json({ ...body, ...(kind === 'index'
      ? { source: 'thread', baseSha: pinned.headSha, jobId: run.jobId }
      : {}) })
  } catch (error) {
    if (error instanceof Error && 'status' in error && typeof error.status === 'number' &&
        error.status >= 400 && error.status < 500)
      return json({ error: error.message }, error.status)
    console.error('[Studio Story workspace explorer] Source verification failed',
      error instanceof Error ? error.stack : String(error))
    return json({ error: 'Story or Thread source could not be safely verified.' }, 409)
  }
}
