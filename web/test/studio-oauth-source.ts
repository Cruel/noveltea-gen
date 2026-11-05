import { randomBytes } from 'node:crypto'
import { isAbsolute } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { StudioDatabase } from '../src/db/connection'
import * as schema from '../src/db/schema'
import { createSqlitePersistence } from '../src/persistence/sqlite'
import { userPiCredentials } from '../src/lib/pi-credentials.server'

/** Read-only access to a provider's existing device-code OAuth credential. The real OAuth
 * refresh token NEVER enters the disposable test job. It is replaced by an
 * invalid sentinel so a test can only use a still-valid access token; it cannot
 * rotate or revoke the user's durable Studio OAuth session. */
export async function readIsolatedStudioOAuth(sourcePath: string, encryptionKey: string,
  selectedOwner?: string, provider = 'openai') {
  if (!sourcePath || !isAbsolute(sourcePath))
    throw new Error('NT_TEST_WEB_PI_SOURCE_DB must be an absolute Studio SQLite path.')
  const sqlite = new Database(sourcePath, { readonly: true, fileMustExist: true })
  try {
    const owners = sqlite.prepare(
      'SELECT owner_user_id AS id FROM pi_credentials WHERE provider=? ORDER BY owner_user_id',
    ).all(provider) as Array<{ id: string }>
    const owner = selectedOwner
      ? owners.find(candidate => candidate.id === selectedOwner)?.id
      : owners.length === 1 ? owners[0]!.id : undefined
    if (!owner) throw new Error('Select exactly one connected Studio account for ' + provider + ' using NT_TEST_WEB_PI_SOURCE_USER_ID.')
    const db = drizzle(sqlite, { schema })
    const store: StudioDatabase = { sqlite, db, persistence: createSqlitePersistence(db) }
    const credential = await userPiCredentials(
      store, owner, { NT_PI_CREDENTIAL_KEY: encryptionKey },
    ).read(provider)
    if (credential?.type !== 'oauth')
      throw new Error('Selected Studio provider must have a device-code OAuth credential, not an API key.')
    // Pi refreshes three minutes early; leave an ample margin for the entire
    // bounded live-Pi test and process shutdown. Never risk source token rotation.
    if (credential.expires - Date.now() < 12 * 60_000)
      throw new Error('Studio device-code access token is close to expiry; reconnect in Studio before certification.')
    return { ...credential, refresh: 'certification-disabled-' + randomBytes(32).toString('hex') }
  } finally { sqlite.close() }
}
