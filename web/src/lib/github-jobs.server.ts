import type { StudioAuth } from './auth'
import type { StudioDatabase } from '../db/connection'
import { actorFor, errorResponse, GithubError, json, matchingRepository } from './github-repositories.server'
import { verifyGithubStorySelection } from './github-stories.server'
import { prepareCachedJob } from './cached-jobs.server'
import { GitCacheError } from './git-cache.server'

// GitHub-specific provider authorization; the durable job and cache lifecycle
// are shared with GitLab.
export async function githubJobRequest(
  auth: StudioAuth, store: StudioDatabase, request: Request, baseURL: string,
): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  if (request.headers.get('origin') !== baseURL) return json({ error: 'Cross-origin write refused' }, 403)
  try {
    const actor = await actorFor(auth, store, request.headers)
    if (actor instanceof Response) return actor
    const job = await prepareCachedJob(store, actor.id, actor.token, 'github', request, async (row, commit) => {
      const repo = await matchingRepository(actor.token, row.repository)
      if (String(repo.id) !== row.providerId) {
        throw new GithubError(409, 'GitHub repository identity has changed; reconnect it before creating a job.')
      }
      const preflight = await verifyGithubStorySelection(actor.token, row.repository, commit, row.directory)
      return { remoteUrl: `https://github.com/${row.repository}.git`,
        sizeBytes: preflight.sizeBytes, blobCount: preflight.blobCount }
    })
    return json({ job })
  } catch (error) {
    return errorResponse(error instanceof GitCacheError ? new GithubError(error.status, error.message) : error)
  }
}
