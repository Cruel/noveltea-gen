import type { StudioDatabase } from '../db/connection'
import { assertStudioSchemaCurrent } from '../db/migrations'
import { acquireCachedStory, GitCacheError, initializeStoryBranch } from './git-cache.server'
import { ensureRootThreads } from './threads.server'

type Provider = 'github' | 'gitlab'
export type CachedCatalogStory = {
  id: string
  directory: string
  title: string
  commitSha: string | null
  contentSha256: string | null
  repository: string
  providerId: string
}
type VerifiedSource =
  | { remoteUrl: string; sizeBytes: number; blobCount: number; reopenDraft?: false }
  | { remoteUrl: string; reopenDraft: true }

// Shared, trusted job-registration boundary for both Git providers. Browser
// input is only a catalog Story UUID, a retry-safe job UUID and a SHA assertion.
export async function prepareCachedJob(
  store: StudioDatabase, ownerId: string, token: string, provider: Provider, request: Request,
  verifySource: (row: CachedCatalogStory, commit: string, existingJob: boolean) => Promise<VerifiedSource>,
) {
  assertStudioSchemaCurrent(store)
  const input = await request.json().catch(() => null)
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
  if (typeof input?.storyId !== 'string' || !uuid.test(input.storyId) ||
      typeof input?.jobId !== 'string' || !uuid.test(input.jobId) ||
      typeof input?.commit !== 'string' || !/^[a-f0-9]{40}$/i.test(input.commit)) {
    throw new GitCacheError(400, 'Select a Story, job UUID and pinned commit.')
  }
  const row = await store.persistence.generation.jobs.catalogStory(ownerId, input.storyId, provider)
  if (!row) throw new GitCacheError(404, 'Story is not connected to this account.')
  if (!row.commitSha) throw new GitCacheError(409, 'Story has no verified base commit; reselect it before creating a job.')
  const existing = await store.persistence.generation.jobs.identity(input.jobId)
  if (existing && (existing.storyId !== row.id || existing.ownerId !== ownerId)) {
    throw new GitCacheError(409, 'Job ID is already assigned to another Story.')
  }
  if (existing && !existing.commitSha) {
    throw new GitCacheError(409, 'Saved job has no pinned commit and cannot be safely reopened.')
  }
  const pinned = existing?.commitSha ?? row.commitSha
  if (pinned.toLowerCase() !== input.commit.toLowerCase()) {
    throw new GitCacheError(409, 'Selected Story revision changed. Refresh the selection or reopen the job at its saved commit.')
  }
  // Provider membership/repository identity and the same pinned Story's size
  // and LFS properties are reverified immediately before every acquisition.
  const verified = await verifySource(row, pinned, Boolean(existing))
  const cacheDirectory = process.env.NT_GIT_CACHE_DIR
  if (!cacheDirectory) {
    throw new GitCacheError(503, 'Studio Git cache is not configured. Set NT_GIT_CACHE_DIR to a dedicated absolute cache volume.')
  }
  const source = {
    cacheDirectory, ownerId, repositoryId: provider + ':' + row.providerId,
    remoteUrl: verified.remoteUrl, token,
    directory: row.directory, commit: pinned, jobId: input.jobId,
  }
  // An unpublished GitHub initialization draft is absent at its pinned base.
  // Only an already-registered job may reopen its exact saved one-commit draft;
  // never use this fallback to create a new job or skip identity validation.
  const job = verified.reopenDraft
    ? await initializeStoryBranch({ ...source, title: row.title, requireExistingCommit: true,
      ...(row.contentSha256 ? { foundationSha256: row.contentSha256 } : {}) })
    : await acquireCachedStory({ ...source,
      verifiedSizeBytes: verified.sizeBytes, verifiedBlobCount: verified.blobCount })
  const now = new Date().toISOString()
  const saved = await store.persistence.generation.jobs.register(
    ownerId, input.jobId, row.id, row.title, pinned, now)
  // Acquisition is asynchronous. Another request may have registered this
  // UUID while we verified/fetched the source. Never claim success for an
  // ownership/revision conflict whose conditional UPSERT made no change.
  if (!saved) {
    throw new GitCacheError(409, 'Job ID was assigned concurrently to another Story or revision.')
  }
  ensureRootThreads(store, ownerId, row.id)
  return { id: input.jobId, storyId: row.id, status: 'paused' as const,
    baseSha: job.baseSha, headSha: job.headSha }
}
