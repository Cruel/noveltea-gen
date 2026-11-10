/**
 * Runtime readiness attestation lease, scoped to one StudioStore.
 * Successful inspections are coalesced and cached only for a bounded interval.
 * SQLite immediately invalidates the lease on schema_version changes;
 * PostgreSQL and non-DDL SQLite drift are detected at the next lease expiry.
 */
export function createStudioReadinessGate(options: {
  attest(): Promise<void>
  schemaVersion?(): number
  now?(): number
  maxAgeMs?: number
}) {
  const now = options.now ?? Date.now
  const maxAgeMs = options.maxAgeMs ?? 5_000
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 5_000)
    throw new Error('Studio readiness revalidation interval must be within 1–5000 ms')
  let verifiedAt: number | undefined
  let verifiedVersion: number | undefined
  let inFlight: Promise<void> | undefined
  let closed = false
  let generation = 0

  return {
    async assertReady(): Promise<void> {
      if (closed) throw new Error('Studio store is closed')
      if (inFlight) return inFlight
      const version = options.schemaVersion?.()
      if (verifiedAt !== undefined &&
          now() - verifiedAt >= 0 && now() - verifiedAt < maxAgeMs &&
          version === verifiedVersion) return
      const revision = generation
      const check = (async () => {
        try {
          await options.attest()
          if (options.schemaVersion?.() !== version)
            throw new Error('Studio schema changed during readiness verification')
          if (closed) throw new Error('Studio store closed during readiness verification')
          if (generation !== revision)
            throw new Error('Studio readiness invalidated during verification')
          verifiedVersion = version
          verifiedAt = now()
        } catch (error) {
          verifiedAt = undefined
          throw error
        }
      })()
      inFlight = check
      try { await check }
      finally { if (inFlight === check) inFlight = undefined }
    },
    invalidate(): void {
      if (closed) throw new Error('Studio store is closed')
      generation++
      verifiedAt = undefined
      verifiedVersion = undefined
    },
    async close(): Promise<void> {
      closed = true
      generation++
      verifiedAt = undefined
      await inFlight?.catch(() => {})
    },
  }
}
