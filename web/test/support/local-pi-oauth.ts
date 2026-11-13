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
