import type { StudioDatabase } from './connection'
import { getMigrations } from 'better-auth/db/migration'
import type { StudioAuth } from '../lib/auth'

// App migrations are append-only and applied transactionally. Auth tables are
// managed by Better Auth's own schema migrator using the same SQLite database.
const appMigrations = [
  {
    version: 1,
    statements: [
      `CREATE TABLE repositories (
         id TEXT PRIMARY KEY NOT NULL,
         owner_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
         provider TEXT NOT NULL CHECK (provider IN ('github', 'gitlab')),
         provider_repository_id TEXT NOT NULL,
         name TEXT NOT NULL,
         created_at TEXT NOT NULL,
         UNIQUE (owner_user_id, provider, provider_repository_id),
         UNIQUE (id, owner_user_id)
       )`,
      `CREATE INDEX repositories_owner_idx ON repositories (owner_user_id)`,
      `CREATE TABLE stories (
         id TEXT PRIMARY KEY NOT NULL,
         owner_user_id TEXT NOT NULL,
         repository_id TEXT NOT NULL,
         directory TEXT NOT NULL,
         title TEXT NOT NULL,
         created_at TEXT NOT NULL,
         UNIQUE (repository_id, directory),
         UNIQUE (id, owner_user_id),
         FOREIGN KEY (repository_id, owner_user_id) REFERENCES repositories (id, owner_user_id) ON DELETE CASCADE
       )`,
      `CREATE INDEX stories_owner_idx ON stories (owner_user_id)`,
      `CREATE TABLE studio_sessions (
         id TEXT PRIMARY KEY NOT NULL,
         owner_user_id TEXT NOT NULL,
         story_id TEXT NOT NULL,
         title TEXT NOT NULL,
         status TEXT NOT NULL CHECK (status IN ('running','paused','blocked','completed','cancelled')),
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         FOREIGN KEY (story_id, owner_user_id) REFERENCES stories (id, owner_user_id) ON DELETE CASCADE
       )`,
      `CREATE INDEX studio_sessions_owner_idx ON studio_sessions (owner_user_id, updated_at)`,
    ],
  },
] as const

export async function migrateStudio(store: StudioDatabase, auth: StudioAuth) {
  const { runMigrations } = await getMigrations(auth.options)
  await runMigrations()
  store.sqlite.exec('CREATE TABLE IF NOT EXISTS studio_schema_migrations (version INTEGER PRIMARY KEY NOT NULL)')
  const applied = new Set(
    (store.sqlite.prepare('SELECT version FROM studio_schema_migrations').all() as Array<{version: number}>)
      .map(row => row.version),
  )
  if (Math.max(0, ...applied) > appMigrations[appMigrations.length - 1]!.version) {
    throw new Error('Studio database was created by a newer application; refusing downgrade')
  }
  for (const migration of appMigrations) {
    if (applied.has(migration.version)) continue
    store.sqlite.transaction(() => {
      for (const statement of migration.statements) store.sqlite.exec(statement)
      store.sqlite.prepare('INSERT INTO studio_schema_migrations (version) VALUES (?)').run(migration.version)
    })()
  }
}
