import { PublicationStateConflict } from './publication-contracts'
import type { PublicationReceipt } from './publication-contracts'

/** Shared provider-neutral state machine for legacy and Kysely repositories.
 * Replays may not change an established branch, verified HEAD or PR/MR identity.
 */
export function reconcilePublication(
  current: PublicationReceipt | null,
  next: PublicationReceipt,
): PublicationReceipt {
  if (next.phase === 'linked' && (!Number.isSafeInteger(next.number) || (next.number ?? 0) <= 0 || !next.url))
    throw new PublicationStateConflict('Provider link identity is incomplete.')
  if (next.phase === 'pending' && (next.number !== null || next.url !== null))
    throw new PublicationStateConflict('Pending publication cannot claim a provider link.')
  if (!current) return next
  if (current.targetBranch !== next.targetBranch || current.remoteBranch !== next.remoteBranch)
    throw new PublicationStateConflict('Publication branch identity changed. Reconcile before retry.')
  if (current.phase === 'pending' && next.phase === 'linked' && current.headSha !== next.headSha)
    throw new PublicationStateConflict('Verified publication HEAD differs from the saved push intent.')
  if (
    current.phase === 'linked' &&
    next.phase === 'linked' &&
    (current.number !== next.number || current.url !== next.url)
  )
    throw new PublicationStateConflict('Linked publication identity changed. Reconcile with provider.')
  if (current.phase === 'linked' && next.phase === 'pending') return current
  // Preserve the original intended HEAD until the remote PR/MR is verified.
  if (next.phase === 'pending') return { ...current, phase: 'pending' }
  return next
}
