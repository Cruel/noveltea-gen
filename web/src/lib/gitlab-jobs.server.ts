import type { StudioAuth } from './auth'
import type { StudioDatabase } from '../db/connection'
import { StudioSchemaError } from '../db/migrations'
import { prepareCachedJob } from './cached-jobs.server'
import { GitCacheError } from './git-cache.server'
import { actor, failure, ProviderFailure, reply } from './gitlab-repositories.server'
import { verifyGitlabStorySelection } from './gitlab-stories.server'
import { repositoryForStory, requireUser } from './access.server'

// GitLab.com uses the same trusted job registration and linked Git worktrees
// as GitHub, with its own OAuth membership and pinned metadata preflight.
export async function gitlabJobRequest(
  auth: StudioAuth, store: StudioDatabase, request: Request, baseURL: string,
): Promise<Response> {
  if (request.method !== 'POST') return reply({ error: 'Method not allowed' }, 405)
  if (request.headers.get('origin') !== baseURL) return reply({ error: 'Cross-origin write refused' }, 403)
  try {
    const user = await requireUser(auth, request.headers)
    const input = await request.clone().json().catch(() => null)
    const repositoryId = user ? repositoryForStory(store, user.id, input?.storyId, 'gitlab') : undefined
    const current = await actor(auth, store, request.headers, repositoryId)
    const job = await prepareCachedJob(store, current.id, current.token, 'gitlab', request, async (row, commit) => {
      const projectId = Number(row.providerId)
      if (!Number.isSafeInteger(projectId) || projectId <= 0) {
        throw new ProviderFailure(422, 'GitLab catalog has invalid project metadata.')
      }
      const preflight = await verifyGitlabStorySelection(current.token, projectId, row.repository, commit, row.directory)
      return { remoteUrl: `https://gitlab.com/${row.repository}.git`,
        sizeBytes: preflight.sizeBytes, blobCount: preflight.blobCount }
    })
    return reply({ job })
  } catch (error) {
    if (error instanceof StudioSchemaError) return reply({ error: error.message }, 503)
    return failure(error instanceof GitCacheError ? new ProviderFailure(error.status, error.message) : error)
  }
}
