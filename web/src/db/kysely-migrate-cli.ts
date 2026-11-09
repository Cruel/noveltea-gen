import { loadEnv } from 'vite'
import { defaultStudioPath } from './connection'
import { readAuthConfig } from '../lib/auth'
import {
  assertKyselyStudioSchemaCurrent,
  migrateStudioKysely,
  openStudioSchemaConnection,
  type StudioSchemaOptions,
} from './kysely-migrations'

// Explicit fresh-schema path. The existing `migrate` command intentionally
// remains the legacy Drizzle initializer until the application cutover.
const mode = process.env.NODE_ENV === 'production' ? 'production' : 'development'
const env = loadEnv(mode, process.cwd(), '')
const operation = process.argv[2] ?? 'up'
if (!['up', 'down', 'check'].includes(operation) || process.argv.length > 3) {
  throw new Error('Usage: pnpm --filter @noveltea/studio migrate:kysely [up|down|check]')
}
const backend = env.NT_STUDIO_DB_BACKEND ?? 'sqlite'
let options: StudioSchemaOptions
if (backend === 'sqlite') {
  options = { backend, path: defaultStudioPath(env) }
} else if (backend === 'postgres') {
  for (const name of ['PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD']) {
    if (!env[name]) throw new Error(`Missing ${name} for PostgreSQL Kysely migration`)
  }
  const port = Number(env.PGPORT ?? '5432')
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid PGPORT for PostgreSQL Kysely migration')
  options = {
    backend,
    connection: {
      host: env.PGHOST,
      port,
      database: env.PGDATABASE,
      user: env.PGUSER,
      password: env.PGPASSWORD,
    },
  }
} else {
  throw new Error('Unsupported NT_STUDIO_DB_BACKEND; expected sqlite or postgres')
}

const connection = openStudioSchemaConnection(options, operation === 'check' ? 'read' : 'migrate')
try {
  if (operation === 'check') {
    await assertKyselyStudioSchemaCurrent(connection)
    console.log(`NovelTea Studio ${backend} Kysely schema is current (read-only check).`)
  } else {
    await migrateStudioKysely(connection, readAuthConfig(env), operation === 'down' ? 'down' : 'latest')
    console.log(`NovelTea Studio ${backend} Kysely migration ${operation} completed.`)
  }
} finally {
  await connection.close()
}
