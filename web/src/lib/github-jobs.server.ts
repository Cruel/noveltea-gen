import type { StudioAuth } from './auth'
import type { StudioDatabase } from '../db/connection'
import { actorFor, errorResponse, GithubError, json, matchingRepository } from './github-repositories.server'
import { verifyGithubStorySelection } from './github-stories.server'
import { prepareCachedJob } from './cached-jobs.server'
import { GitCacheError } from './git-cache.server'
import { repositoryForStory, requireUser } from './access.server'

// GitHub authorization and pinned preflight feed the shared GitHub/GitLab job
// registration boundary. Only an already saved, unpublished initialization
// draft may reopen its single local Story-creation commit.
export async function githubJobRequest(
  auth: StudioAuth, store: StudioDatabase, request: Request, baseURL: string,
): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  if (request.headers.get('origin') !== baseURL) return json({ error: 'Cross-origin write refused' }, 403)
  try {
    const user = await requireUser(auth, request.headers)
    const input = await request.clone().json().catch(() => null)
    const repositoryId = user ? repositoryForStory(store, user.id, input?.storyId, 'github') : undefined
    const actor = await actorFor(auth, store, request.headers, repositoryId)
    if (actor instanceof Response) return actor
    const job = await prepareCachedJob(store, actor.id, actor.token, 'github', request,
      async (row, commit, existingJob) => {
        const repo = await matchingRepository(actor.token, row.repository)
        if (String(repo.id) !== row.providerId) {
          throw new GithubError(409, 'GitHub repository identity has changed; reconnect it before creating a job.')
        }
        const remoteUrl = `https://github.com/${row.repository}.git`
        try {
          const preflight = await verifyGithubStorySelection(actor.token, row.repository, commit, row.directory)
          return { remoteUrl, sizeBytes: preflight.sizeBytes, blobCount: preflight.blobCount }
        } catch (error) {
          // An initial Story may exist only in its own worktree branch until
          // the review workflow publishes it. A missing source at the original
          // baseline is acceptable only when reopening the original saved job.
          // Never bypass a revoked installation or an unrelated provider error.
          if (!existingJob || !(error instanceof GithubError) ||
              (error.status !== 404 && error.status !== 422)) throw error
          return { remoteUrl, reopenDraft: true as const }
        }
      })
    return json({ job })
  } catch (error) {
    return errorResponse(error instanceof GitCacheError ? new GithubError(error.status, error.message) : error)
  }
}
