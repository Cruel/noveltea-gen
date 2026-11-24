import type { ValidationResult } from '../../../src/validator'
import type { JobStartResult } from '../../../src/job'
import { validateStoryJob } from '../../../src/validator'
import { trustedHead } from '../../../src/revision'
import { reusableExistingFoundation } from '../../../src/foundation-readiness'
import { isVerifiedInitializedDraft } from './cached-jobs.server'
import type { StudioAuth } from './auth'
import type { StudioStore } from '../persistence/store'
import { actorFor, matchingRepository, GithubError } from './github-repositories.server'
import { actor as gitlabActor } from './gitlab-repositories.server'
import { verifyGithubStorySelection } from './github-stories.server'
import { verifyGitlabStorySelection } from './gitlab-stories.server'
import { verifiedGithubInitialFoundation } from './github-initial-foundation.server'
import { authorizedStoryJob } from './fixture-jobs.server'
import { inspectCachedStory } from './git-cache.server'
import { nativeValidateSource } from '../../../src/native-validator'
import { nativeVersion } from '../../../src/native-cli-version'

/** A source-pinned published Story is checked normally. An unpublished
 * initialization may be checked against its own exact controller-attested
 * initial commit instead of a source commit containing no Story records.
 * The original baseline is never rewritten, and unreviewed placeholders
 * still fail the canonical readiness/provenance checks. */
export async function verifiedReusableStoryFoundation(job: JobStartResult,
  sourceValidation: ValidationResult): Promise<boolean> {
  if (await reusableExistingFoundation(job, sourceValidation)) return true
  if (!await isVerifiedInitializedDraft(job)) return false
  const verified = await trustedHead(job)
  if (verified !== job.headSha) return false
  const baseline = await validateStoryJob(job, undefined, { ...job, baseSha: verified })
  return reusableExistingFoundation(job, baseline)
}

/** Inspect the provider-pinned Story without materializing a Generation Job.
 * Only a verified existing Foundation permits the caller to register one. */
export async function inspectExistingStoryFoundation(auth: StudioAuth, store: StudioStore,
  owner: string, headers: Headers, storyId: string): Promise<boolean> {
  const story = await store.persistence.naturalStory.story(owner, storyId)
  if (!story?.headSha) return false
  const row = await store.persistence.generation.jobs.catalogStory(owner, storyId, story.provider)
  if (!row || row.commitSha !== story.headSha) return false
  const cacheDirectory = process.env.NT_GIT_CACHE_DIR
  if (!cacheDirectory) throw Error('Studio Git cache is unavailable')
  const source = { cacheDirectory, ownerId: owner,
    repositoryId: story.provider + ':' + row.providerId,
    directory: row.directory, commit: row.commitSha }
  let token: string
  let remoteUrl: string
  let preflight: { sizeBytes: number; blobCount: number }
  if (story.provider === 'github') {
    const actor = await actorFor(auth, store, headers, story.repositoryId)
    if (actor instanceof Response || actor.id !== owner) throw Error('GitHub authorization unavailable')
    token = actor.token
    const repo = await matchingRepository(token, row.repository)
    if (String(repo.id) !== row.providerId) throw Error('Repository identity changed')
    remoteUrl = `https://github.com/${row.repository}.git`
    try {
      preflight = await verifyGithubStorySelection(token, row.repository, row.commitSha, row.directory)
    } catch (error) {
      if (!(error instanceof GithubError) || error.status !== 404 || !row.contentSha256) throw error
      // An unpublished initialization is inspected at its original, already
      // attested commit, never reconstructed into the pending first Turn.
      await verifiedGithubInitialFoundation(store, owner, storyId, row.commitSha, row.contentSha256)
      const original = await store.persistence.naturalStory.originalInitializationJob(owner, storyId)
      if (!original) return false
      const job = await authorizedStoryJob(store, owner, original)
      // The original initialization is proven by the exact one-commit and
      // content-digest check above; unlike a later writer it need not already
      // carry a reopened-job trusted-head marker.
      const result = await validateStoryJob(job, undefined, { ...job, baseSha: job.headSha })
      await verifiedGithubInitialFoundation(store, owner, storyId, row.commitSha, row.contentSha256)
      return reusableExistingFoundation(job, result)
    }
  } else {
    const actor = await gitlabActor(auth, store, headers, story.repositoryId)
    if (actor.id !== owner) throw Error('GitLab authorization unavailable')
    token = actor.token
    const projectId = Number(row.providerId)
    if (!Number.isSafeInteger(projectId) || projectId <= 0) throw Error('Invalid project identity')
    remoteUrl = `https://gitlab.com/${row.repository}.git`
    preflight = await verifyGitlabStorySelection(token, projectId, row.repository, row.commitSha, row.directory)
  }
  return inspectCachedStory({ ...source, remoteUrl, token,
    verifiedSizeBytes: preflight.sizeBytes, verifiedBlobCount: preflight.blobCount }, async view =>
    reusableExistingFoundation(view, nativeValidateSource(view, {
      contract: 'noveltea-validator/v1', implementation: 'native-cli', version: nativeVersion(),
    })))
}
