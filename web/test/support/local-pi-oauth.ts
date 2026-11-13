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

/** Local-only certification: Pi owns refresh-token rotation, never Studio.
 * Refresh the local login using its supported CLI, then copy only its access
 * token into the disposable Studio vault. This cannot consume the source
 * refresh grant or overwrite the developer's durable Studio credentials. */
export async function syncLocalPiOAuth(provider: string, model: string,
  previous: BorrowedLocalPiOAuth,
  update: (next: BorrowedLocalPiOAuth) => Promise<void>,
  options: { now?: () => number; renew?: () => void;
    read?: (provider: string) => BorrowedLocalPiOAuth } = {},
): Promise<BorrowedLocalPiOAuth> {
  const now = options.now ?? Date.now
  if (previous.expires - now() > 35 * 60_000) return previous
  const renew = options.renew ?? (() => {
    // Ignore the printed bearer token: no access or refresh secrets in logs.
    // --min-expiry preemptively refreshes before SDK requests start failing.
    execFileSync('pi', ['auth', 'print-bearer-token', '--provider', provider,
      '--model', model, '--min-expiry', '40m'], {
      stdio: 'ignore', timeout: 60_000,
    })
  })
  renew()
  const next = (options.read ?? localPiOAuth)(provider)
  if (next.expires - now() < 30 * 60_000)
    throw Error('Local Pi OAuth did not renew with sufficient validity for continued certification.')
  if (next.access === previous.access && next.expires === previous.expires) return previous
  await update(next)
  return next
}
