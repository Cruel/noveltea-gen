import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Test-only: borrow an unexpired local access token without copying or
 * refreshing the developer's durable OAuth refresh credential. The disposable
 * Studio database receives a deliberately unusable refresh string. */
export function localPiOAuth(provider: string) {
  const credentials = JSON.parse(readFileSync(join(homedir(), '.pi/agent/auth.json'), 'utf8')) as Record<
    string,
    { type: string; access?: string; expires?: number }
  >
  const selected = credentials[provider]
  if (
    selected?.type !== 'oauth' ||
    !selected.access ||
    !selected.expires ||
    selected.expires - Date.now() < 5 * 60_000
  )
    throw Error(
      'An unexpired local Pi OAuth access token is required; renew your local Pi login before certification.',
    )
  return {
    type: 'oauth' as const,
    access: selected.access,
    expires: selected.expires,
    refresh: 'certification-refresh-disabled-' + randomBytes(24).toString('hex'),
  }
}

export type BorrowedLocalPiOAuth = ReturnType<typeof localPiOAuth>

type LocalOAuthOptions = { now?: () => number; renew?: () => void;
  read?: (provider: string) => BorrowedLocalPiOAuth }

function renewLocalPiOAuth(provider: string, model: string): void {
  // Never emit the bearer token into the certification log.
  execFileSync('pi', ['auth', 'print-bearer-token', '--provider', provider,
    '--model', model, '--min-expiry', '40m'], {
    stdio: 'ignore', timeout: 60_000,
  })
}

/** The local Pi login is the sole owner of its refresh grant. Refresh before
 * copying any access-only token into disposable Studio storage, including when
 * the old token is already expired and cannot pass localPiOAuth's read check. */
export function readyLocalPiOAuth(provider: string, model: string,
  options: LocalOAuthOptions = {}): BorrowedLocalPiOAuth {
  const now = options.now ?? Date.now
  const read = options.read ?? localPiOAuth
  let current: BorrowedLocalPiOAuth | undefined
  try { current = read(provider) }
  catch { /* An expired/missing access token may be renewable by Pi. */ }
  if (current && current.expires - now() > 35 * 60_000) return current
  try { (options.renew ?? (() => renewLocalPiOAuth(provider, model)))() }
  catch {
    throw new Error('Local Pi OAuth renewal failed. Reconnect Pi and retry certification.')
  }
  const next = read(provider)
  if (next.expires - now() < 30 * 60_000)
    throw new Error('Local Pi OAuth did not renew with sufficient validity for certification.')
  return next
}

/** Local-only certification: Pi owns refresh-token rotation, never Studio.
 * Refresh the local login using its supported CLI, then copy only its access
 * token into the disposable Studio vault. This cannot consume the source
 * refresh grant or overwrite the developer's durable Studio credentials. */
export async function syncLocalPiOAuth(provider: string, model: string,
  previous: BorrowedLocalPiOAuth,
  update: (next: BorrowedLocalPiOAuth) => Promise<void>,
  options: LocalOAuthOptions = {},
): Promise<BorrowedLocalPiOAuth> {
  const now = options.now ?? Date.now
  if (previous.expires - now() > 35 * 60_000) return previous
  const renew = options.renew ?? (() => renewLocalPiOAuth(provider, model))
  renew()
  const next = (options.read ?? localPiOAuth)(provider)
  if (next.expires - now() < 30 * 60_000)
    throw Error('Local Pi OAuth did not renew with sufficient validity for continued certification.')
  if (next.access === previous.access && next.expires === previous.expires) return previous
  await update(next)
  return next
}
