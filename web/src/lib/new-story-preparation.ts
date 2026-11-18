/** The initialization job is registered against the source commit; its
 * isolated HEAD is the new un-published Story commit. The provider's existing
 * job preparation verifies that exact one-file initialization and establishes
 * the trusted-head receipt. Never feed the new HEAD as the source revision. */
type InitializationRecord = { jobId: string; headSha: string; commit: string; baseSha?: string }

const SHA = /^[a-f0-9]{40}$/i

export function pinnedInitializationCommit(provider: 'github' | 'gitlab',
  record: InitializationRecord, inspectedCommit: string | null | undefined): string {
  if (provider === 'gitlab') {
    if (!SHA.test(record.commit)) throw new Error('Story initialization has no pinned provider commit.')
    return record.commit
  }
  if (record.baseSha && inspectedCommit && record.baseSha !== inspectedCommit)
    throw new Error('The pinned Story source changed. Inspect the existing job before continuing.')
  const source = record.baseSha ?? inspectedCommit
  if (!source || !SHA.test(source))
    throw new Error('The pinned initialization source is unavailable. Inspect the existing job.')
  return source
}

export function confirmPreparedInitialization(record: InitializationRecord,
  prepared: { id: string; headSha: string }): string {
  if (prepared.id !== record.jobId || prepared.headSha !== record.headSha ||
      !SHA.test(prepared.headSha))
    throw new Error('Prepared job identity or initialization HEAD mismatch. Reconcile the Story job.')
  return prepared.headSha
}
