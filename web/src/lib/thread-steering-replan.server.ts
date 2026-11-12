import type { StudioStore as StudioDatabase } from '../persistence/store'
import type { SteeringActivity, SteeringCheckpoint } from '../persistence/steering-contracts'
import { steeringCanonicalTargets } from '../../../src/steering-intent'
export type { SteeringActivity } from '../persistence/steering-contracts'

type Disposition = 'within-scope' | 'scope-review' | 'protected-review' | 'unresolved'
const now = () => new Date().toISOString()

/** This is *triage*, not narrative interpretation or a grant. Unknown and
 * multi-target edits fail closed; a specialist never gains new writable paths.
 * The trusted native catalog and #84's exact scoped preview decide the plan. */
export function classifySteeringIntent(text: string, workItem: string | null): Disposition {
  if (/\b(?:protected\s+(?:creative\s+)?decision|creative[- ]direction|retcon|override\s+canon)\b/i.test(text))
    return 'protected-review'
  const targets = steeringCanonicalTargets(text)
  if (!workItem) return 'unresolved'
  const scoped = workItem.startsWith('focus:') ? workItem.slice(6) : null
  if (workItem === 'character-foundations' && targets.length &&
      targets.every(id => id.startsWith('character.'))) return 'within-scope'
  if (workItem === 'world-foundations' && targets.length &&
      targets.every(id => /^(?:world-entity|relationship|fact|revelation)\./.test(id)))
    return 'within-scope'
  if (targets.length && (scoped === null || targets.some(id => id !== scoped)))
    return 'scope-review'
  if (/\bmilestone(?:-wide)?\b/i.test(text) && !workItem.startsWith('event-') &&
      !workItem.startsWith('interactive-') && !workItem.startsWith('composition-'))
    return 'scope-review'
  if (targets.length === 1 && scoped === targets[0]) return 'within-scope'
  // Without a single canonical target, do not pretend to have verified the
  // meaning. The instruction may have influenced the assigned work, but no
  // new plan is authorized.
  return 'unresolved'
}

/** Only the exact acknowledged SDK receipt can register considered guidance.
 * This is influence metadata, not proof that the story change was fulfilled. */
export async function recordSteeringConsideration(store: StudioDatabase, id: string, owner: string,
  threadId: string, jobId: string, content: string, workItem: string | null) {
  await store.persistence.steering.consider(id, owner, threadId, jobId, content,
    workItem, classifySteeringIntent(content, workItem), now())
}

/** A verified specialist checkpoint is the earliest safe branch origin for
 * a delivered steering instruction; pending inputs remain unresolved. */
export async function attributeSteeringCheckpoint(store: StudioDatabase, owner: string,
  jobId: string, point: SteeringCheckpoint): Promise<number> {
  return store.persistence.steering.attribute(owner, jobId, point, now())
}

/** Evidence of verified file changes, never semantic or editorial acceptance. */
export async function attributeApprovedReplanCheckpoint(store: StudioDatabase, owner: string,
  jobId: string, point: SteeringCheckpoint, files: string[]): Promise<number> {
  return store.persistence.steering.approvedReplan(owner, jobId, point, files, now())
}

/** Create at most one independently reviewable proposal for each delivered
 * out-of-scope steer when the original run completes. */
export async function prepareSteeringBoundaryReviews(store: StudioDatabase, owner: string,
  jobId: string, threadId: string, verifiedHead: string | null): Promise<number> {
  if (!verifiedHead) return 0
  return store.persistence.steering.boundaryReviews(owner, jobId, threadId, verifiedHead, now())
}

export async function steeringActivity(store: StudioDatabase, owner: string, threadId: string): Promise<SteeringActivity[]> {
  return store.persistence.steering.activity(owner, threadId)
}
