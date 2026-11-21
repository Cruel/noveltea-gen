/** Keep the user-facing explanation causal, not an exhaustive dependency cascade.
 * Decisions and checkpoint eligibility come only from the trusted job API. */
export function runAttentionText(status: string, reason: string | null): string {
  if (status === 'blocked' || status === 'interrupted' || status === 'failed') {
    if (/Foundation specialist did not edit canonical Markdown/i.test(reason ?? ''))
      return 'A foundations specialist finished without writing required canonical Story files. Earlier verified work is preserved.'
    if (!reason) return 'Generation stopped. Inspect the saved run for the cause and available recovery checkpoints.'
    return reason.split('; ')[0]!.slice(0, 450)
  }
  if (status === 'prepared') return 'This Thread has not started generating yet.'
  if (status === 'paused') return reason || 'Generation is paused at a saved boundary.'
  if (status === 'completed') return 'The run has finished. Review its saved changes and verification evidence.'
  return reason || 'Inspect the saved run for details.'
}

/** These headings reflect trusted controller state, never a model progress
 * report. Only a verified pending Author Choice can claim author input, and
 * only the actual resource ledger can claim a budget pause. */
export function runAttentionHeading(status: string, options: {
  authorPending?: boolean; budgetPaused?: boolean; retryableContinuation?: boolean
} = {}): string {
  if (options.authorPending && ['paused', 'blocked'].includes(status))
    return 'Author input required'
  if (options.budgetPaused && status === 'paused')
    return 'Resource budget paused'
  if (options.retryableContinuation) return 'Generation could not start'
  if (['blocked', 'interrupted', 'failed'].includes(status)) return 'Generation stopped'
  if (status === 'completed') return 'Generation finished'
  if (status === 'paused') return 'Generation paused'
  if (status === 'prepared') return 'Ready to generate'
  if (status === 'cancelled') return 'Run cancelled'
  return 'Generation status'
}

/** A stopped run has no independently verified continuation source. */
export function canSendThreadFollowUp(status: string | undefined, archived: boolean): boolean {
  return !archived && (status === 'running' || status === 'queued' || status === 'completed')
}
