import type { AuthorQuestion, AuthorQuestionAnswer } from '../../../src/author-question'

export type Approval = {
  id: string; nonce: string; proposalSha256: string; verifiedHead: string
  phase: 'awaiting-controller' | 'recorded'; review: unknown
  decision?: 'approved' | 'rejected'; principal?: string
}
export type AuthorItem = {
  id: string; kind: 'question' | 'approval'
  phase: 'queued' | 'awaiting-author' | 'applied' | 'review-required'
  prompt: string; answer?: string | null
  requestType?: 'plan' | 'decision'; workItemId?: string | null
  proposalSha256?: string; changeId?: string | null
  approval: Approval | null
}
export type RecoveryDecision = {
  id: 'foundation-conflict' | 'validator-upgrade'
  title: string; description: string; proposalSha256: string; verifiedHead: string
  phase: 'awaiting-author' | 'applying' | 'recorded'
  decision?: 'approved' | 'rejected'; note?: string
  details: { sourceExcerpt: string; explanation: string } | {
    original: { version: string }
    replacement: { version: string }
    validationDigest: string; diagnostics: number
  }
}
export type SpecialistChoice = {
  id: string; workItem: string; phase: 'awaiting-author' | 'answered'
  proposalSha256: string
  delegationAllowed?: boolean
  question: AuthorQuestion
  answer?: AuthorQuestionAnswer
}
export type AuthorState = { status: string; items: AuthorItem[];
  decisions: RecoveryDecision[]; choice: SpecialistChoice | null }

export const authorInteractionsKey = (jobId: string) => ['author-interactions', jobId] as const

export function isAuthorState(state: unknown): state is AuthorState {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return false
  const value = state as Record<string, unknown>
  return typeof value.status === 'string' &&
    Array.isArray(value.items) && Array.isArray(value.decisions) &&
    (value.choice === null || typeof value.choice === 'object' &&
      value.choice !== undefined && !Array.isArray(value.choice))
}

/** Both chat and Job review share a parsed author-decision state, never
 * differently shaped values under a single query key. */
export function parseAuthorState(raw: string): AuthorState {
  const state: unknown = JSON.parse(raw)
  if (!state || typeof state !== 'object' || Array.isArray(state))
    throw new Error('Invalid author interaction response.')
  if (!isAuthorState(state))
    throw new Error('Incomplete author interaction response.')
  return state
}
