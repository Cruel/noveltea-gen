import type { ValidationResult } from '../../../src/validator'
import type { JobStartResult } from '../../../src/job'
import { validateStoryJob } from '../../../src/validator'
import { trustedHead } from '../../../src/revision'
import { reusableExistingFoundation } from '../../../src/foundation-readiness'
import { isVerifiedInitializedDraft } from './cached-jobs.server'

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
