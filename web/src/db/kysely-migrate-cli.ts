import { loadEnv } from 'vite'
import { selectedStudioDatabaseOptions } from './studio-options'
import { readAuthConfig } from '../lib/auth'
import {
  assertKyselyStudioSchemaCurrent,
  migrateStudioKysely,
  openStudioSchemaConnection,
  studioMigrationNames,
  NO_MIGRATIONS,
} from './kysely-migrations'

// This is the only Studio migration runner. Both `migrate` and `migrate:kysely`
// use the same explicit backend, independent of runtime schema readiness.
const mode = process.env.NODE_ENV === 'production' ? 'production' : 'development'
const env = loadEnv(mode, process.cwd(), '')
const operation = process.argv[2] ?? 'up'
const target = process.argv[3]
if (
  !['up', 'down', 'check', 'to'].includes(operation) ||
  (operation === 'to'
    ? !target || process.argv.length !== 4
    : process.argv.length !== 3 && process.argv.length !== 2)
) {
  throw new Error('Usage: migrate:kysely [up|down|check|to <baseline|latest|migration-name|none>]')
}
const options = selectedStudioDatabaseOptions(env)
const { backend } = options

const connection = openStudioSchemaConnection(options, operation === 'check' ? 'read' : 'migrate')
try {
  if (operation === 'check') {
    await assertKyselyStudioSchemaCurrent(connection)
    console.log(`NovelTea Studio ${backend} Kysely schema is current (read-only check).`)
  } else {
    const requested =
      operation === 'to'
        ? target === 'baseline'
          ? studioMigrationNames()[0]!
          : target === 'none'
            ? NO_MIGRATIONS
            : target!
        : operation === 'down'
          ? 'down'
          : 'latest'
    await migrateStudioKysely(connection, readAuthConfig(env), requested)
    console.log(
      `NovelTea Studio ${backend} Kysely migration ${operation}${target ? ' ' + target : ''} completed.`,
    )
  }
} finally {
  await connection.close()
}
