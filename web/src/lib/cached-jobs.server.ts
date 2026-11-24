import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { JobStartResult } from '../../../src/job'
import type { StudioStore as StudioDatabase } from '../persistence/store'
import { acquireCachedStory, GitCacheError, initialStoryDocument, initializeStoryBranch } from './git-cache.server'
import { ensureRootThreads } from './threads.server'

import type { ProviderHandoffEffect } from './discovery-handoff-effects.server'

type Provider = 'github' | 'gitlab'

/** Only a provider-verified reopening of the *single exact* unpublished
 * initialization commit may establish this read-only trusted HEAD. A later
 * generation writer still needs its own approval, native validation and
 * work-item receipt; this marker never proves that placeholder canon is ready. */
async function attestInitializedHead(job: JobStartResult) {
  if (job.headSha === job.baseSha)
    throw new GitCacheError(409, 'Missing isolated initialization commit.')
  const folder = join(job.stateDir, 'revisions')
  const path = join(folder, 'verified-head.json')
  const marker = { version: 1, jobId: job.jobId, headSha: job.headSha,
    workItemId: 'story-initialization' }
  await mkdir(folder, { recursive: true })
  try {
    await writeFile(path, JSON.stringify(marker, null, 2) + '\n', {
      flag: 'wx', mode: 0o600,
    })
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause
    let saved: unknown
    try { saved = JSON.parse(await readFile(path, 'utf8')) }
    catch { throw new GitCacheError(409, 'Initialization HEAD receipt is corrupt.') }
    if (JSON.stringify(saved) !== JSON.stringify(marker))
      throw new GitCacheError(409, 'Initialization HEAD differs from trusted job history.')
  }
}

/** The sole exception for a new Story's unpublished initial Git commit. */
export async function isVerifiedInitializedDraft(job: JobStartResult): Promise<boolean> {
  if (job.headSha === job.baseSha) return false
  try {
    const saved = JSON.parse(await readFile(join(job.stateDir, 'revisions', 'verified-head.json'),
      'utf8')) as { version?: number; jobId?: string; headSha?: string; workItemId?: string }
    return saved.version === 1 && saved.jobId === job.jobId &&
      saved.headSha === job.headSha && saved.workItemId === 'story-initialization'
  } catch { return false }
}
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
  | { remoteUrl: string; sizeBytes: number; blobCount: number; reopenDraft?: false; initializeDraft?: false }
  | { remoteUrl: string; reopenDraft: true; initializeDraft?: false }
  | { remoteUrl: string; initializeDraft: true; reopenDraft?: false; foundationMarkdown?: string }

// Shared, trusted job-registration boundary for both Git providers. Browser
// input is only a catalog Story UUID, a retry-safe job UUID and a SHA assertion.
export async function prepareCachedJob(
  store: StudioDatabase, ownerId: string, token: string, provider: Provider, request: Request,
  verifySource: (row: CachedCatalogStory, commit: string, existingJob: boolean) => Promise<VerifiedSource>,
  effect?: ProviderHandoffEffect,
) {
  await store.assertReady()
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
  await effect?.('provider-verified')
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
  // Reopen an existing job at its exact saved one-file commit, or reconstruct
  // the separately authorized first Chat job from content-bound initialization
  // bytes. Both paths are verified before any trusted HEAD is established.
  const placeholderDigest = createHash('sha256').update(initialStoryDocument(row.title)).digest('hex')
  if (verified.initializeDraft && (existing || provider !== 'github' ||
      !row.contentSha256 ||
      (row.contentSha256 !== placeholderDigest && (!verified.foundationMarkdown ||
        createHash('sha256').update(verified.foundationMarkdown).digest('hex') !== row.contentSha256))))
    throw new GitCacheError(409, 'Only exact saved initialization content may be materialized in a new Chat job.')
  const initialization = verified.reopenDraft || verified.initializeDraft
    ? { ...source, title: row.title,
        ...(row.contentSha256 ? { foundationSha256: row.contentSha256 } : {}) }
    : null
  // The first write is always independently reopened against the committed
  // blob digest before a trusted-head marker is published. No Git filter,
  // symlink or unexpected file may silently change the initial draft bytes.
  await effect?.('worktree-started')
  if (verified.initializeDraft) {
    await initializeStoryBranch({ ...initialization!, foundationMarkdown:
      verified.foundationMarkdown ?? initialStoryDocument(row.title) })
  }
  if (!initialization && !('sizeBytes' in verified))
    throw new GitCacheError(409, 'Verified Story acquisition has no bounded Git tree evidence.')
  const job = initialization
    ? await initializeStoryBranch({ ...initialization, requireExistingCommit: true })
    : 'sizeBytes' in verified
      ? await acquireCachedStory({ ...source,
        verifiedSizeBytes: verified.sizeBytes, verifiedBlobCount: verified.blobCount })
      : (() => { throw new GitCacheError(409, 'Missing verified source tree.') })()
  const now = new Date().toISOString()
  const saved = await store.persistence.generation.jobs.register(
    ownerId, input.jobId, row.id, row.title, pinned, now)
  // Acquisition is asynchronous. Another request may have registered this
  // UUID while we verified/fetched the source. Never claim success for an
  // ownership/revision conflict whose conditional UPSERT made no change.
  if (!saved) {
    throw new GitCacheError(409, 'Job ID was assigned concurrently to another Story or revision.')
  }
  // initializeStoryBranch has just independently verified the exact one-commit
  // diff and saved foundation content digest against the original source.
  // Preserve that safe predecessor for the subsequent approved writer.
  if (verified.reopenDraft || verified.initializeDraft) await attestInitializedHead(job)
  await ensureRootThreads(store, ownerId, row.id)
  await effect?.('worktree-settled')
  return { id: input.jobId, storyId: row.id, status: 'paused' as const,
    baseSha: job.baseSha, headSha: job.headSha }
}
