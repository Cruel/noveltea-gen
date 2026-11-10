import type { DatabaseOptions } from './kysely-connection'
import { defaultStudioPath } from './studio-path'

/** Runtime and explicit migrations must choose identical backends and credentials. */
export function selectedStudioDatabaseOptions(env: NodeJS.ProcessEnv = process.env): DatabaseOptions {
  const backend = env.NT_STUDIO_DB_BACKEND ?? 'sqlite'
  if (backend === 'sqlite') return { backend, path: defaultStudioPath(env) }
  if (backend !== 'postgres')
    throw new Error('Unsupported NT_STUDIO_DB_BACKEND; expected sqlite or postgres')
  for (const name of ['PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD']) {
    if (!env[name]) throw new Error(`Missing ${name} for PostgreSQL Studio database`)
  }
  const port = Number(env.PGPORT ?? '5432')
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid PGPORT for PostgreSQL Studio database')
  return { backend, connection: {
    host: env.PGHOST, port, database: env.PGDATABASE, user: env.PGUSER,
    password: env.PGPASSWORD,
  } }
}
