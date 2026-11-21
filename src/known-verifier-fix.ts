import { AsyncLocalStorage } from 'node:async_hooks'

/** A deployed code fix is an exact, operator-declared check/version match.
 * It is not a retry allowance, authorization, or permission to restart jobs. */
export interface KnownFixRequest {
  id: string
  check: string
  failedVersion: number
  signature: string
}
export interface KnownVerifierFix {
  id: string
  check: string
  failedVersion: number
}
const fixId = /^[a-z0-9][a-z0-9.-]{0,100}$/
const checkId = /^[a-z][a-z0-9.-]{1,100}$/

/** Empty by default. Shipping a new build never wakes every stopped job. */
type AuthorizedFixDispatch = KnownFixRequest & { jobId: string; threadId: string }
const authorizedDispatch = new AsyncLocalStorage<AuthorizedFixDispatch>()

/** Only a controller that already verified the owner-scoped durable queue
 * claim may enter this process-local scope. Graph input alone has no authority. */
export function withKnownFixDispatch<T>(proof: AuthorizedFixDispatch, work: () => Promise<T>): Promise<T> {
  if (!deployedVerifierFixes().some(fix => fix.id === proof.id &&
      fix.check === proof.check && fix.failedVersion === proof.failedVersion))
    throw Error('Known verifier fix is not deployed')
  return authorizedDispatch.run(proof, work)
}

export function authorizedKnownFixDispatch(proof: KnownFixRequest, jobId: string,
  threadId: string): boolean {
  const active = authorizedDispatch.getStore()
  return !!active && active.id === proof.id && active.check === proof.check &&
    active.failedVersion === proof.failedVersion && active.signature === proof.signature &&
    active.jobId === jobId && active.threadId === threadId
}

export function deployedVerifierFixes(value = process.env.NT_STUDIO_KNOWN_VERIFIER_FIXES): KnownVerifierFix[] {
  if (!value) return []
  let data: unknown
  try { data = JSON.parse(value) } catch { throw Error('Invalid known-verifier-fixes JSON') }
  if (!Array.isArray(data) || data.length > 32) throw Error('Invalid known-verifier-fixes manifest')
  const keys = new Set<string>()
  return data.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw Error('Invalid known verifier fix')
    const entry = item as Record<string, unknown>
    if (Object.keys(entry).sort().join(',') !== 'check,failedVersion,id' ||
        typeof entry.id !== 'string' || !fixId.test(entry.id) ||
        typeof entry.check !== 'string' || !checkId.test(entry.check) ||
        !Number.isSafeInteger(entry.failedVersion) ||
        (entry.failedVersion as number) < 1 || (entry.failedVersion as number) > 10000)
      throw Error('Invalid known verifier fix identity')
    const key = entry.id
    if (keys.has(key)) throw Error('Duplicated known verifier fix ID')
    keys.add(key)
    return { id: entry.id, check: entry.check, failedVersion: entry.failedVersion as number }
  })
}
