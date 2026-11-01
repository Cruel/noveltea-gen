import type { StudioDatabase } from './connection'
import { getMigrations } from 'better-auth/db/migration'
import { createStudioAuth, studioAuthOptions, type StudioAuthConfig } from '../lib/auth'

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
  {
    version: 2,
    statements: [
      `CREATE TABLE github_install_flows (
         state_hash TEXT PRIMARY KEY NOT NULL,
         owner_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
         desired_repository TEXT,
         created_at INTEGER NOT NULL,
         expires_at INTEGER NOT NULL,
         status TEXT NOT NULL CHECK(status IN ('started','used','pending'))
       )`,
      `CREATE INDEX github_install_flows_owner ON github_install_flows (owner_user_id, status, expires_at)`,
    ],
  },
  {
    version: 3,
    statements: [
      `ALTER TABLE stories ADD COLUMN source_commit_sha TEXT`,
    ],
  },
] as const

const latestAppSchemaVersion = appMigrations[appMigrations.length - 1]!.version

export class StudioSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StudioSchemaError'
  }
}

// Runtime must never silently migrate a live database. Check the durable
// migration journal and the actual column needed by Story registration so a
// missed deployment migration produces an actionable error, not a provider 502.
export function assertStudioSchemaCurrent(store: StudioDatabase) {
  const hasJournal = !!store.sqlite.prepare(`SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='studio_schema_migrations'`).get()
  const applied = hasJournal
    ? (store.sqlite.prepare('SELECT max(version) AS version FROM studio_schema_migrations').get() as { version: number | null }).version
    : null
  if (applied === null || applied < latestAppSchemaVersion) {
    throw new StudioSchemaError(`Studio database migrations are pending (requires version ${latestAppSchemaVersion}, found ${applied ?? 0}). Stop Studio, run \`pnpm --filter @noveltea/studio migrate\`, then restart Studio.`)
  }
  if (applied > latestAppSchemaVersion) {
    throw new StudioSchemaError('Studio database schema is newer than this build. Update Studio before using it.')
  }
  const columns = store.sqlite.pragma('table_info(stories)') as Array<{ name: string }>
  if (!columns.some(column => column.name === 'source_commit_sha')) {
    throw new StudioSchemaError('Studio database migration journal does not match its schema. Check migration status and restore or repair the database before using Story imports.')
  }
}

export async function migrateStudio(store: StudioDatabase, config: StudioAuthConfig) {
  // Better Auth's supported Kysely migration planner reads its options without
  // constructing an auth instance (which would concurrently check the unmigrated schema).
  const { runMigrations } = await getMigrations(studioAuthOptions(store, config))
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
  // Now it is safe to initialize Better Auth and await the *same* schema
  // validation that normal runtime requests use, before closing SQLite or
  // reporting migration success. A failure rejects this command.
  const context = await createStudioAuth(store, config).$context
  if (!context.checkSchema) throw new Error('Better Auth adapter does not support schema validation')
  await context.checkSchema()
  const integrity = store.sqlite.pragma('integrity_check') as Array<{ integrity_check: string }>
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
    throw new Error('Studio SQLite integrity check failed')
  }
  const foreignKeys = store.sqlite.pragma('foreign_key_check') as Array<unknown>
  if (foreignKeys.length) throw new Error('Studio SQLite foreign-key check failed')
}
