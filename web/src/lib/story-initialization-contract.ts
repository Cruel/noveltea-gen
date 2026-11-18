/** Shared validation and failure provenance for repository Story initialization.
 * Only the provider handlers can attest that a mutation was not attempted. */
export const WRITE_OUTCOME_HEADER = 'x-noveltea-write-outcome'
export type WriteOutcome = 'not-attempted' | 'unknown'

export function validStoryTitle(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length >= 1 &&
    value.trim().length <= 120 && !/[\x00-\x1f\x7f]/.test(value)
}

/** Use the approved title verbatim for guided discovery: never substitute
 * the independent manual form or silently rewrite a reviewed proposal. */
export function titleForInitialization(mode: 'guided' | 'manual',
  manualTitle: string, reviewedTitle?: string): string {
  const raw = mode === 'guided' ? reviewedTitle : manualTitle
  const title = raw?.trim()
  if (!validStoryTitle(raw) || !title || (mode === 'guided' && title !== raw))
    throw new Error('Story title must be 1–120 printable characters.')
  return title
}

export function providerWriteOutcome(response: Response): WriteOutcome {
  return response.headers.get(WRITE_OUTCOME_HEADER) === 'not-attempted'
    ? 'not-attempted' : 'unknown'
}

/** An unmarked failure is never proof that a remote write did not occur. */
export function markWriteOutcome(response: Response, mutationStarted: boolean): Response {
  response.headers.set(WRITE_OUTCOME_HEADER, mutationStarted ? 'unknown' : 'not-attempted')
  return response
}
