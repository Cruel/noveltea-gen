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
  {
    version: 4,
    statements: [
      `ALTER TABLE studio_sessions ADD COLUMN source_commit_sha TEXT`,
    ],
  },
  {
    version: 5,
    statements: [
      `ALTER TABLE studio_sessions ADD COLUMN generation_request_json TEXT`,
      `ALTER TABLE studio_sessions ADD COLUMN generation_thread_id TEXT`,
    ],
  },
  {
    version: 6,
    statements: [
      `ALTER TABLE studio_sessions ADD COLUMN generation_config_json TEXT`,
    ],
  },
  {
    version: 7,
    statements: [
      `ALTER TABLE stories ADD COLUMN initial_content_sha256 TEXT`,
    ],
  },
  {
    version: 8,
    statements: [
      `CREATE TABLE story_onboarding_drafts (
        owner_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
        repository_id TEXT NOT NULL,
        workspace TEXT NOT NULL,
        revision INTEGER NOT NULL,
        draft_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (owner_user_id, repository_id, workspace),
        FOREIGN KEY (repository_id, owner_user_id) REFERENCES repositories (id, owner_user_id) ON DELETE CASCADE
      )`,
    ],
  },
  {
    version: 9,
    statements: [
      `CREATE TABLE pi_credentials (
         owner_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
         provider TEXT NOT NULL,
         ciphertext TEXT NOT NULL,
         revision INTEGER NOT NULL DEFAULT 1,
         PRIMARY KEY (owner_user_id, provider)
       )`,
    ],
  },
  {
    version: 10,
    statements: [
      `CREATE UNIQUE INDEX studio_sessions_owner_pair ON studio_sessions (id, owner_user_id)`,
      `CREATE TABLE generation_events (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         job_id TEXT NOT NULL,
         owner_user_id TEXT NOT NULL,
         kind TEXT NOT NULL CHECK(kind IN ('started','working','verified','finished','interrupted')),
         stage TEXT,
         milestone TEXT,
         files_json TEXT NOT NULL DEFAULT '[]',
         status TEXT,
         created_at TEXT NOT NULL,
         FOREIGN KEY (job_id, owner_user_id) REFERENCES studio_sessions (id, owner_user_id) ON DELETE CASCADE
       )`,
      `CREATE INDEX generation_events_job_idx ON generation_events (owner_user_id, job_id, id)`,
    ],
  },
  {
    version: 11,
    statements: [
      `CREATE TABLE story_onboarding_conversations (
        owner_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
        repository_id TEXT NOT NULL,
        workspace TEXT NOT NULL,
        revision INTEGER NOT NULL,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (owner_user_id, repository_id, workspace),
        FOREIGN KEY (repository_id, owner_user_id) REFERENCES repositories (id, owner_user_id) ON DELETE CASCADE
      )`,
    ],
  },
  {
    version: 12,
    statements: [
      `CREATE TABLE generation_run_queue (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL UNIQUE,
        owner_user_id TEXT NOT NULL,
        intent TEXT NOT NULL CHECK(intent IN ('start','resume')),
        phase TEXT NOT NULL CHECK(phase IN ('queued','running','finished','interrupted')),
        worker_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (job_id, owner_user_id) REFERENCES studio_sessions (id, owner_user_id) ON DELETE CASCADE
      )`,
      `CREATE INDEX generation_run_queue_order ON generation_run_queue (phase, sequence)`,
    ],
  },
  {
    version: 13,
    statements: [
      `CREATE TABLE github_publications (
        job_id TEXT PRIMARY KEY NOT NULL,
        owner_user_id TEXT NOT NULL,
        target_branch TEXT NOT NULL,
        remote_branch TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        phase TEXT NOT NULL CHECK(phase IN ('pending','linked')),
        pr_number INTEGER,
        pr_url TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (job_id, owner_user_id) REFERENCES studio_sessions (id, owner_user_id) ON DELETE CASCADE
      )`,
    ],
  },
  {
    version: 14,
    statements: [
      `CREATE TABLE gitlab_publications (
        job_id TEXT PRIMARY KEY NOT NULL,
        owner_user_id TEXT NOT NULL,
        target_branch TEXT NOT NULL,
        remote_branch TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        phase TEXT NOT NULL CHECK(phase IN ('pending','linked')),
        mr_iid INTEGER,
        mr_url TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (job_id, owner_user_id) REFERENCES studio_sessions (id, owner_user_id) ON DELETE CASCADE
      )`,
    ],
  },
  {
    version: 15,
    statements: [
      `CREATE TABLE user_preferences (
         owner_user_id TEXT PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE,
         default_model_json TEXT,
         updated_at TEXT NOT NULL
       )`,
      `CREATE TABLE git_connections (
         id TEXT PRIMARY KEY NOT NULL,
         owner_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
         provider TEXT NOT NULL CHECK (provider IN ('github','gitlab')),
         provider_account_id TEXT NOT NULL,
         login TEXT NOT NULL,
         credentials TEXT NOT NULL,
         revision INTEGER NOT NULL DEFAULT 1,
         refresh_lease_id TEXT,
         refresh_lease_until INTEGER,
         access_expires_at INTEGER,
         refresh_expires_at INTEGER,
         status TEXT NOT NULL DEFAULT 'connected' CHECK(status IN ('connected','reauthorize','disconnected')),
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         UNIQUE (owner_user_id, provider, provider_account_id),
         UNIQUE (id, owner_user_id)
       )`,
      `CREATE INDEX git_connections_owner_idx ON git_connections(owner_user_id, provider)`,
      `CREATE TABLE git_connection_flows (
         state_hash TEXT PRIMARY KEY NOT NULL,
         owner_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
         provider TEXT NOT NULL CHECK (provider IN ('github','gitlab')),
         verifier TEXT NOT NULL,
         expires_at INTEGER NOT NULL
       )`,
      `ALTER TABLE repositories ADD COLUMN connection_id TEXT REFERENCES git_connections(id) ON DELETE SET NULL`,
      `ALTER TABLE github_install_flows ADD COLUMN connection_id TEXT REFERENCES git_connections(id) ON DELETE SET NULL`,
    ],
  },
  {
    version: 16,
    statements: [
      `CREATE TABLE story_conversations (
         id TEXT PRIMARY KEY NOT NULL,
         owner_user_id TEXT NOT NULL,
         story_id TEXT NOT NULL,
         title TEXT NOT NULL,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         FOREIGN KEY (story_id, owner_user_id) REFERENCES stories (id, owner_user_id) ON DELETE CASCADE,
         UNIQUE (id, owner_user_id)
       )`,
      `CREATE INDEX story_conversations_story_idx ON story_conversations (owner_user_id, story_id)`,
      `CREATE TABLE story_threads (
         id TEXT PRIMARY KEY NOT NULL,
         owner_user_id TEXT NOT NULL,
         conversation_id TEXT NOT NULL,
         parent_thread_id TEXT,
         title TEXT NOT NULL,
         activity_at TEXT NOT NULL,
         archived_at TEXT,
         created_at TEXT NOT NULL,
         FOREIGN KEY (conversation_id, owner_user_id) REFERENCES story_conversations (id, owner_user_id) ON DELETE CASCADE,
         FOREIGN KEY (parent_thread_id, owner_user_id, conversation_id)
           REFERENCES story_threads (id, owner_user_id, conversation_id),
         CHECK (parent_thread_id IS NULL OR parent_thread_id <> id),
         UNIQUE (id, owner_user_id),
         UNIQUE (id, owner_user_id, conversation_id)
       )`,
      `CREATE INDEX story_threads_conversation_idx ON story_threads (owner_user_id, conversation_id)`,
      `CREATE TABLE story_thread_runs (
         job_id TEXT PRIMARY KEY NOT NULL,
         owner_user_id TEXT NOT NULL,
         thread_id TEXT NOT NULL,
         run_order INTEGER NOT NULL,
         needs_author INTEGER NOT NULL DEFAULT 0 CHECK (needs_author IN (0, 1)),
         FOREIGN KEY (thread_id, owner_user_id) REFERENCES story_threads (id, owner_user_id) ON DELETE CASCADE,
         FOREIGN KEY (job_id, owner_user_id) REFERENCES studio_sessions (id, owner_user_id) ON DELETE CASCADE,
         UNIQUE (thread_id, run_order)
       )`,
      `CREATE INDEX story_thread_runs_thread_idx ON story_thread_runs (owner_user_id, thread_id, run_order)`,
      `CREATE TABLE story_thread_preferences (
         owner_user_id TEXT NOT NULL,
         story_id TEXT NOT NULL,
         view_mode TEXT NOT NULL CHECK (view_mode IN ('tree', 'flat')),
         expanded_ids_json TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         PRIMARY KEY (owner_user_id, story_id),
         FOREIGN KEY (story_id, owner_user_id) REFERENCES stories (id, owner_user_id) ON DELETE CASCADE
       )`,
      // Keep historical jobs intact: each becomes one root Thread of its own
      // Conversation, without claiming historical graph checkpoints are forkable.
      `INSERT INTO story_conversations (id,owner_user_id,story_id,title,created_at,updated_at)
         SELECT 'legacy:' || id,owner_user_id,story_id,title,created_at,created_at FROM studio_sessions`,
      `INSERT INTO story_threads (id,owner_user_id,conversation_id,parent_thread_id,title,activity_at,created_at)
         SELECT 'root:' || id,owner_user_id,'legacy:' || id,NULL,title,created_at,created_at FROM studio_sessions`,
      `INSERT INTO story_thread_runs (job_id,owner_user_id,thread_id,run_order)
         SELECT id,owner_user_id,'root:' || id,0 FROM studio_sessions`,
    ],
  },
  {
    version: 17,
    statements: [
      `CREATE TABLE checkpoint_forks (
         child_id TEXT PRIMARY KEY NOT NULL,
         owner_user_id TEXT NOT NULL REFERENCES user(id),
         source_job_id TEXT NOT NULL,
         source_base_sha TEXT NOT NULL,
         commit_sha TEXT NOT NULL,
         bundle_json TEXT NOT NULL,
         draft_json TEXT NOT NULL,
         created_at TEXT NOT NULL
       )`,
    ],
  },
  {
    version: 18,
    statements: [
      `ALTER TABLE checkpoint_forks ADD COLUMN source_thread_id TEXT`,
      `ALTER TABLE checkpoint_forks ADD COLUMN proof_digest TEXT`,
      `ALTER TABLE checkpoint_forks ADD COLUMN guidance TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE checkpoint_forks ADD COLUMN history_json TEXT`,
      `CREATE TABLE story_thread_messages (
         id TEXT PRIMARY KEY NOT NULL,
         owner_user_id TEXT NOT NULL,
         thread_id TEXT NOT NULL,
         sequence INTEGER NOT NULL,
         role TEXT NOT NULL CHECK (role IN ('user','assistant')),
         status TEXT NOT NULL CHECK (status IN ('delivered','queued')),
         body TEXT NOT NULL,
         origin_message_id TEXT,
         verified_commit_sha TEXT,
         created_at TEXT NOT NULL,
         FOREIGN KEY (thread_id, owner_user_id) REFERENCES story_threads (id, owner_user_id) ON DELETE CASCADE,
         UNIQUE (thread_id, sequence)
       )`,
      `CREATE INDEX story_thread_messages_thread_idx ON story_thread_messages (owner_user_id, thread_id, sequence)`,
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
  const versions = hasJournal ? new Set((store.sqlite.prepare(
    'SELECT version FROM studio_schema_migrations').all() as Array<{ version: number }>).map(row => row.version)) : new Set<number>()
  const applied = Math.max(0, ...versions)
  if (applied > latestAppSchemaVersion) {
    throw new StudioSchemaError('Studio database schema is newer than this build. Update Studio before using it.')
  }
  if (appMigrations.some(migration => !versions.has(migration.version))) {
    throw new StudioSchemaError(`Studio database migrations are pending (requires version ${latestAppSchemaVersion}, found ${applied}). Stop Studio, run \`pnpm --filter @noveltea/studio migrate\`, then restart Studio.`)
  }
  const hasOnboarding = !!store.sqlite.prepare(`SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='story_onboarding_drafts'`).get()
  const columns = store.sqlite.pragma('table_info(stories)') as Array<{ name: string }>
  const sessionColumns = store.sqlite.pragma('table_info(studio_sessions)') as Array<{ name: string }>
  const hasPiCredentials = !!store.sqlite.prepare(`SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='pi_credentials'`).get()
  const hasEvents = !!store.sqlite.prepare(`SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='generation_events'`).get()
  const hasPiOnboarding = !!store.sqlite.prepare(`SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='story_onboarding_conversations'`).get()
  const hasGitlabPublication = !!store.sqlite.prepare(`SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='gitlab_publications'`).get()
  const hasPublication = !!store.sqlite.prepare(`SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='github_publications'`).get()
  const hasQueue = !!store.sqlite.prepare(`SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='generation_run_queue'`).get()
  const hasGitConnections = !!store.sqlite.prepare(`SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='git_connections'`).get()
  const hasPrefs = !!store.sqlite.prepare(`SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='user_preferences'`).get()
  const hasThreads = ['story_conversations', 'story_threads', 'story_thread_runs', 'story_thread_preferences']
    .every(name => !!store.sqlite.prepare(`SELECT 1 FROM sqlite_master
      WHERE type='table' AND name=?`).get(name))
  const hasGitFlows = !!store.sqlite.prepare(`SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='git_connection_flows'`).get()
  const repoColumns = store.sqlite.pragma('table_info(repositories)') as Array<{ name: string }>
  const hasForks = !!store.sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='checkpoint_forks'`).get()
  const hasMessages = !!store.sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='story_thread_messages'`).get()
  if (!hasForks || !hasMessages || !hasThreads || !hasPrefs || !hasGitConnections || !hasGitFlows || !repoColumns.some(column => column.name === 'connection_id') || !hasGitlabPublication || !hasPublication || !hasQueue || !hasOnboarding || !hasPiCredentials || !hasEvents || !hasPiOnboarding || !columns.some(column => column.name === 'source_commit_sha') ||
      !columns.some(column => column.name === 'initial_content_sha256') ||
      !sessionColumns.some(column => column.name === 'source_commit_sha') ||
      !sessionColumns.some(column => column.name === 'generation_request_json') ||
      !sessionColumns.some(column => column.name === 'generation_thread_id') ||
      !sessionColumns.some(column => column.name === 'generation_config_json')) {
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
