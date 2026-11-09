import { SqliteAdapter, sql, type Kysely } from 'kysely'
import { studioDdl } from '../../src/db/kysely-baseline'

/**
 * Git bindings need a real composite FK, not an application-level check or
 * trigger. The independent connection_id FK retains ON DELETE SET NULL while
 * the composite FK checks (connection_id, owner, provider). NO ACTION is
 * evaluated after the SET NULL action, so the owner and provider stay intact.
 *
 * SQLite cannot ALTER TABLE ADD FOREIGN KEY. These target databases have not
 * been activated by the application (#141), so we rebuild only empty tables
 * from the frozen baseline DDL and fail closed for populated instances.
 */
const candidateKey =
  'CREATE UNIQUE INDEX git_connections_owner_provider_pair ON git_connections(id, owner_user_id, provider)'

const scopes = {
  repositories: 'repositories_connection_owner_provider_fk',
  githubInstallFlows: 'github_install_connection_owner_provider_fk',
} as const

function sqlite(db: Kysely<unknown>) {
  return db.getExecutor().adapter instanceof SqliteAdapter
}

async function assertEmpty(db: Kysely<unknown>) {
  for (const table of ['repositories', 'github_install_flows']) {
    const result = await sql<{ id: number }>`SELECT 1 AS id FROM ${sql.raw(table)} LIMIT 1`.execute(db)
    if (result.rows.length)
      throw new Error(
        `Cannot change Git foreign keys on a populated ${table} table; explicitly reset the disposable Kysely database`,
      )
  }
}

function replacement(table: 'repositories' | 'github_install_flows') {
  const source = studioDdl().tables.get(table)
  if (!source) throw new Error(`Missing baseline table ${table}`)
  const original =
    '\tFOREIGN KEY (`connection_id`) REFERENCES `git_connections`(`id`) ON UPDATE no action ON DELETE set null,'
  if (!source.includes(original)) throw new Error(`Unexpected baseline connection FK for ${table}`)
  const scope =
    table === 'repositories'
      ? '\tCONSTRAINT "repositories_connection_owner_provider_fk" FOREIGN KEY (`connection_id`,`owner_user_id`,`provider`) REFERENCES `git_connections`(`id`,`owner_user_id`,`provider`) ON UPDATE no action ON DELETE no action,'
      : '\tCONSTRAINT "github_install_connection_owner_provider_fk" FOREIGN KEY (`connection_id`,`owner_user_id`,`provider`) REFERENCES `git_connections`(`id`,`owner_user_id`,`provider`) ON UPDATE no action ON DELETE no action,'
  let modified = source.replace(original, `${original}\n${scope}`)
  if (table === 'github_install_flows') {
    modified = modified.replace(
      '\t`connection_id` text,',
      "\t`connection_id` text,\n\t`provider` text DEFAULT 'github' NOT NULL,",
    )
    modified = modified.replace(
      '\tCONSTRAINT "github_install_flows_status_check"',
      '\tCONSTRAINT "github_install_flows_provider_check" CHECK(provider = \'github\'),\n\tCONSTRAINT "github_install_flows_status_check"',
    )
  }
  return modified
}

async function recreateSqlite(
  db: Kysely<unknown>,
  table: 'repositories' | 'github_install_flows',
  composite: boolean,
) {
  const schema = studioDdl()
  const original = schema.tables.get(table)
  if (!original) throw new Error(`Missing baseline table ${table}`)
  await sql.raw(`DROP TABLE "${table}"`).execute(db)
  await sql.raw(composite ? replacement(table) : original).execute(db)
  for (const index of schema.indexes.get(table) ?? []) await sql.raw(index).execute(db)
}

export async function up(db: Kysely<unknown>) {
  await assertEmpty(db)
  await sql.raw(candidateKey).execute(db)
  if (sqlite(db)) {
    // Both tables are empty. All dependent Story tables are likewise empty.
    await recreateSqlite(db, 'repositories', true)
    await recreateSqlite(db, 'github_install_flows', true)
  } else {
    await sql
      .raw("ALTER TABLE github_install_flows ADD COLUMN provider text NOT NULL DEFAULT 'github'")
      .execute(db)
    await sql
      .raw(
        "ALTER TABLE github_install_flows ADD CONSTRAINT github_install_flows_provider_check CHECK (provider = 'github')",
      )
      .execute(db)
    await sql
      .raw(
        `ALTER TABLE repositories ADD CONSTRAINT ${scopes.repositories}
          FOREIGN KEY (connection_id, owner_user_id, provider)
          REFERENCES git_connections(id, owner_user_id, provider)
          ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED`,
      )
      .execute(db)
    await sql
      .raw(
        `ALTER TABLE github_install_flows ADD CONSTRAINT ${scopes.githubInstallFlows}
          FOREIGN KEY (connection_id, owner_user_id, provider)
          REFERENCES git_connections(id, owner_user_id, provider)
          ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED`,
      )
      .execute(db)
  }
}

export async function down(db: Kysely<unknown>) {
  await assertEmpty(db)
  if (sqlite(db)) {
    await recreateSqlite(db, 'github_install_flows', false)
    await recreateSqlite(db, 'repositories', false)
  } else {
    await sql.raw(`ALTER TABLE github_install_flows DROP CONSTRAINT ${scopes.githubInstallFlows}`).execute(db)
    await sql.raw(`ALTER TABLE repositories DROP CONSTRAINT ${scopes.repositories}`).execute(db)
    await sql
      .raw('ALTER TABLE github_install_flows DROP CONSTRAINT github_install_flows_provider_check')
      .execute(db)
    await sql.raw('ALTER TABLE github_install_flows DROP COLUMN provider').execute(db)
  }
  await sql.raw('DROP INDEX git_connections_owner_provider_pair').execute(db)
}
