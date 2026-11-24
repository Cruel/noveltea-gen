import { createHash } from 'node:crypto'
import type { StudioAuth } from './auth'
import type { StudioStore as StudioDatabase } from '../persistence/store'
import { actorFor, errorResponse, GithubError, json, matchingRepository } from './github-repositories.server'
import { verifyGithubStorySelection } from './github-stories.server'
import { verifiedGithubInitialFoundation } from './github-initial-foundation.server'
import { prepareCachedJob } from './cached-jobs.server'
import type { ProviderHandoffEffect } from './discovery-handoff-effects.server'
import { GitCacheError, initialStoryDocument } from './git-cache.server'
import { repositoryForStory, requireUser } from './access.server'

// GitHub authorization and pinned preflight feed the shared GitHub/GitLab job
// registration boundary. An unpublished initial Story is either reopened at
// its exact saved commit or reconstructed for a distinct first Chat Turn from
// a content-digested, source-linked initialization; never from an absent
// remote path alone.
export async function githubJobRequest(
  auth: StudioAuth, store: StudioDatabase, request: Request, baseURL: string,
  effect?: ProviderHandoffEffect,
): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  if (request.headers.get('origin') !== baseURL) return json({ error: 'Cross-origin write refused' }, 403)
  try {
    const user = await requireUser(auth, request.headers)
    const input = await request.clone().json().catch(() => null)
    const repositoryId = user ? await repositoryForStory(store, user.id, input?.storyId, 'github') : undefined
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
          // A newly submitted first Chat Turn uses a different UUID from the
          // original onboarding job. The ONLY new-worktree exception is an
          // exact saved initialization placeholder absent at the pinned source.
          // Provider 422 (LFS, unsupported trees) never authorizes a new draft.
          if (!(error instanceof GithubError)) throw error
          const initial = row.contentSha256 === createHash('sha256')
            .update(initialStoryDocument(row.title)).digest('hex')
          if (!existingJob && error.status === 404 && row.contentSha256) {
            if (initial) return { remoteUrl, initializeDraft: true as const }
            const foundationMarkdown = await verifiedGithubInitialFoundation(store,
              actor.id, row.id, commit, row.contentSha256)
            return { remoteUrl, initializeDraft: true as const, foundationMarkdown }
          }
          // Reopen only the already-registered job's exact saved local commit.
          if (!existingJob || (error.status !== 404 && error.status !== 422))
            throw error
          return { remoteUrl, reopenDraft: true as const }
        }
      }, effect)
    return json({ job })
  } catch (error) {
    return errorResponse(error instanceof GitCacheError ? new GithubError(error.status, error.message) : error)
  }
}
