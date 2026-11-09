/** Only for side-effect-free pre-writer reads. The caller must provide a
 * controller-owned exact-source guard (pinned request, worker lease, HEAD and
 * clean worktree). No Pi turn, Git write, sandbox acquisition or graph step
 * may be placed inside the read callback. */
const transientReadCodes = new Set(['SQLITE_BUSY', 'SQLITE_LOCKED', 'ETIMEDOUT', 'ECONNRESET'])

export async function retryReadOnlyPreflight<T>(
  read: () => Promise<T>, verifyExactSource: () => Promise<void>,
): Promise<T> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await verifyExactSource()
    try {
      return await read()
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? (error as { code?: unknown }).code : null
      if (attempt === 3 || typeof code !== 'string' || !transientReadCodes.has(code))
        throw error
      // A transient read is not evidence that the immutable source survived
      // unchanged. Reverify before another attempt; never replay a writer.
      await verifyExactSource()
    }
  }
  throw new Error('Read-only preflight retry exhausted')
}
