/** Expand–contract safety gate. The shared Kysely driver is not a migrated StudioStore. */
export function assertLegacySqliteBackend(env: NodeJS.ProcessEnv = process.env): void {
  const backend = env.NT_STUDIO_DB_BACKEND ?? 'sqlite'
  if (backend === 'sqlite') return
  if (backend === 'postgres') {
    throw new Error('PostgreSQL Studio application persistence is not yet migrated; refusing SQLite fallback')
  }
  throw new Error('Unsupported NT_STUDIO_DB_BACKEND; expected sqlite or postgres')
}
