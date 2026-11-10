import { randomBytes } from 'node:crypto'
import { isAbsolute } from 'node:path'
import Database from 'better-sqlite3'
import { CamelCasePlugin, Kysely, SqliteDialect } from 'kysely'
import type { StudioDb } from '../../src/db/studio-db'
import type { SharedDatabase } from '../../src/db/kysely-connection'
import { createKyselyPersistence } from '../../src/persistence/kysely'
import { userPiCredentials } from '../../src/lib/pi-credentials.server'

/** Read-only access to an existing Studio device-code OAuth credential.
 * Never expose or rotate the user's durable refresh token.
 */
export async function readIsolatedStudioOAuth(sourcePath: string, encryptionKey: string,
  selectedOwner?: string, provider = 'openai') {
  if (!sourcePath || !isAbsolute(sourcePath))
    throw new Error('NT_TEST_WEB_PI_SOURCE_DB must be an absolute Studio SQLite path.')
  const sqlite = new Database(sourcePath, { readonly: true, fileMustExist: true })
  const db = new Kysely<StudioDb>({
    dialect: new SqliteDialect({ database: sqlite }),
    plugins: [new CamelCasePlugin()],
  })
  try {
    const owners = sqlite.prepare(
      'SELECT owner_user_id AS id FROM pi_credentials WHERE provider=? ORDER BY owner_user_id',
    ).all(provider) as Array<{ id: string }>
    const owner = selectedOwner
      ? owners.find(candidate => candidate.id === selectedOwner)?.id
      : owners.length === 1 ? owners[0]!.id : undefined
    if (!owner) throw new Error('Select exactly one connected Studio account for ' + provider +
      ' using NT_TEST_WEB_PI_SOURCE_USER_ID.')
    const readonlyDb: SharedDatabase<StudioDb> = {
      read: db,
      async withWriteTransaction() {
        throw new Error('Isolated Studio credential source is read-only')
      },
      async close() { await db.destroy() },
    }
    const store = {
      persistence: createKyselyPersistence(readonlyDb),
      async assertReady() { throw new Error('Read-only credential fixture cannot attest Studio schema') },
      invalidateReadiness() { throw new Error('Read-only credential fixture has no readiness lease') },
      close: () => readonlyDb.close(),
    }
    const credential = await userPiCredentials(
      store, owner, { NT_PI_CREDENTIAL_KEY: encryptionKey },
    ).read(provider)
    if (credential?.type !== 'oauth')
      throw new Error('Selected Studio provider must have a device-code OAuth credential, not an API key.')
    if (credential.expires - Date.now() < 12 * 60_000)
      throw new Error('Studio device-code access token is close to expiry; reconnect in Studio before certification.')
    return { ...credential, refresh: 'certification-disabled-' + randomBytes(32).toString('hex') }
  } finally {
    await db.destroy()
    if (sqlite.open) sqlite.close()
  }
}
