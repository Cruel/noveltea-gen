import Database from 'better-sqlite3'
import { StudioSchemaError } from './schema-error'
export { StudioSchemaError } from './schema-error'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getTableColumns, getTableName } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { getMigrations } from 'better-auth/db/migration'
import { studioDrizzleForMigrations, studioSqliteDriver, type StudioDatabase } from './connection'
import * as schema from './schema'
import { createStudioAuth, studioAuthOptions, type StudioAuthConfig } from '../lib/auth'

// This module owns only Studio application migrations. Better Auth's Kysely
// migrator owns user, session, account, verification and rateLimit tables.
// Keep the generated Drizzle SQL and meta journal in the deployed image.
function migrationDirectory(): string {
  const configured = process.env.NT_STUDIO_MIGRATIONS_DIR
  const choices = configured ? [resolve(configured)] : [
    resolve(process.cwd(), 'drizzle'),
    resolve(process.cwd(), 'web/drizzle'),
    fileURLToPath(new URL('../../drizzle/', import.meta.url)),
  ]
  const folder = choices.find(path => existsSync(join(path, 'meta/_journal.json')))
  if (!folder) throw new StudioSchemaError(
    'Studio Drizzle migration files are missing. Deploy web/drizzle and rerun the explicit migration command.',
  )
  return folder
}

const migrationConfig = () => ({ migrationsFolder: migrationDirectory() })
const appTables = Object.values(schema).map(table => {
  const config = getTableConfig(table)
  return {
    name: getTableName(table),
    columns: Object.values(getTableColumns(table)).map(column => column.name).sort(),
    indexes: config.indexes.map(index => index.config.name),
  }
})
const inspected = new WeakMap<StudioDatabase, number>()
// Migration files are immutable deployment assets, not per-request inputs.
const migrationCache = new Map<string, ReturnType<typeof readMigrationFiles>>()
type SchemaSql = { type: 'table' | 'index'; name: string; sql: string }
const schemaSqlCache = new Map<string, Map<string, SchemaSql>>()

/** Recreate the generated application schema in an isolated database once per
 * deployed migration set. Compare SQLite's stored DDL to detect changes to
 * types, nullability, defaults, CHECK/FK/UNIQUE constraints and partial-index
 * predicates, not just the presence of columns and index names.
 */
function expectedSchemaSql(): Map<string, SchemaSql> {
  const folder = migrationDirectory()
  const cached = schemaSqlCache.get(folder)
  if (cached) return cached
  const reference = new Database(':memory:')
  try {
    // Drizzle owns app tables, while Better Auth owns the referenced user table.
    reference.exec('CREATE TABLE user (id TEXT PRIMARY KEY NOT NULL)')
    migrate(drizzle(reference), { migrationsFolder: folder })
    const names = new Set<string>(appTables.map(table => table.name))
    const indexes = new Set<string>(appTables.flatMap(table => table.indexes))
    const rows = reference.prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE type IN ('table', 'index') AND sql IS NOT NULL",
    ).all() as SchemaSql[]
    const expected = new Map(rows.filter(row =>
      (row.type === 'table' && names.has(row.name)) ||
      (row.type === 'index' && indexes.has(row.name))).map(row => [row.type + ':' + row.name, row]))
    if (expected.size !== names.size + indexes.size)
      throw new StudioSchemaError('Generated Studio migration does not contain every declared table and index')
    schemaSqlCache.set(folder, expected)
    return expected
  } finally {
    reference.close()
  }
}

function schemaDefinition(store: StudioDatabase, type: 'table' | 'index', name: string): string | undefined {
  const row = studioSqliteDriver(store).prepare(
    'SELECT sql FROM sqlite_master WHERE type=? AND name=?',
  ).get(type, name) as { sql: string | null } | undefined
  return row?.sql ?? undefined
}

function hasTable(store: StudioDatabase, table: string) {
  return !!studioSqliteDriver(store).prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
}

function expectedMigrations() {
  const folder = migrationDirectory()
  let list = migrationCache.get(folder)
  if (!list) {
    list = readMigrationFiles({ migrationsFolder: folder })
    if (!list.length) throw new StudioSchemaError('Studio has no generated application migrations')
    migrationCache.set(folder, list)
  }
  return list
}

// Never adopt application tables that lack a Drizzle migration journal.
// Check before either migration system modifies the database.
function assertNoUntrackedApplicationTables(store: StudioDatabase) {
  if (!hasTable(store, '__drizzle_migrations') && appTables.some(table => hasTable(store, table.name))) {
    throw new StudioSchemaError(
      'Studio application tables exist without Drizzle migration history. Back up and explicitly reset NT_STUDIO_DB_PATH; automatic adoption is forbidden.',
    )
  }
}

// Both runtime admission and the explicit migration command must validate
// the same durable journal before permitting writes or serving application data.
function compatibleMigrationCount(store: StudioDatabase, expected: ReturnType<typeof expectedMigrations>) {
  const rows = hasTable(store, '__drizzle_migrations')
    ? studioSqliteDriver(store).prepare('SELECT hash, created_at AS createdAt FROM __drizzle_migrations ORDER BY created_at').all() as Array<{ hash: string; createdAt: number }>
    : []
  if (rows.length > expected.length) {
    throw new StudioSchemaError('Studio database was created by a newer application; refusing downgrade')
  }
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.hash !== expected[i]!.hash || rows[i]!.createdAt !== expected[i]!.folderMillis) {
      throw new StudioSchemaError('Studio migration history is incompatible with this build. Restore the matching build or explicitly reset Studio; automatic repair is forbidden.')
    }
  }
  return rows.length
}

// Run-time checks are read-only. In addition to the journal, check the actual
// tables, columns and named indexes. Cache the expensive structural check only
// while SQLite's schema_version is unchanged; the journal is ALWAYS checked.
export function assertStudioSchemaCurrent(store: StudioDatabase) {
  assertNoUntrackedApplicationTables(store)
  const expected = expectedMigrations()
  const applied = compatibleMigrationCount(store, expected)
  if (applied < expected.length) {
    throw new StudioSchemaError(
      `Studio database migrations are pending (requires ${expected.length}, found ${applied}). Stop Studio, run \`pnpm --filter @noveltea/studio migrate\`, then restart Studio.`,
    )
  }

  const schemaVersion = studioSqliteDriver(store).pragma('schema_version', { simple: true }) as number
  if (inspected.get(store) === schemaVersion) return
  // Better Auth owns these tables; we verify their presence but never define
  // or migrate them via Drizzle. Its own schema checker verifies their shape.
  for (const table of ['user', 'account', 'session', 'verification', 'rateLimit']) {
    if (!hasTable(store, table)) {
      throw new StudioSchemaError(`Better Auth schema is incomplete (missing ${table}). Stop Studio and run the explicit migration command.`)
    }
  }
  const definitions = expectedSchemaSql()
  for (const table of appTables) {
    if (!hasTable(store, table.name)) {
      throw new StudioSchemaError(`Studio database migration journal does not match its schema (missing ${table.name}). Restore or explicitly reset Studio.`)
    }
    const columns = (studioSqliteDriver(store).pragma(`table_info("${table.name}")`) as Array<{ name: string }>).map(c => c.name).sort()
    const indexes = new Set((studioSqliteDriver(store).pragma(`index_list("${table.name}")`) as Array<{ name: string }>).map(i => i.name))
    if (columns.length !== table.columns.length || columns.some((column, i) => column !== table.columns[i])
      || table.indexes.some(index => !indexes.has(index))) {
      throw new StudioSchemaError(`Studio database migration journal does not match its schema (${table.name}). Restore or explicitly reset Studio.`)
    }
    for (const [type, name] of [['table', table.name], ...table.indexes.map(index =>
      ['index', index])] as Array<['table' | 'index', string]>) {
      const expectedSql = definitions.get(type + ':' + name)?.sql
      if (!expectedSql || schemaDefinition(store, type, name) !== expectedSql) {
        throw new StudioSchemaError(`Studio database schema definition drift (${name}). Restore or explicitly reset Studio.`)
      }
    }
  }
  inspected.set(store, schemaVersion)
}

export async function migrateStudio(store: StudioDatabase, config: StudioAuthConfig) {
  assertNoUntrackedApplicationTables(store)
  compatibleMigrationCount(store, expectedMigrations())

  // Only the explicit migration command is allowed to write either schema.
  // Better Auth comes first because Studio's app foreign keys reference user.
  const { runMigrations } = await getMigrations(studioAuthOptions(store, config))
  await runMigrations()
  migrate(studioDrizzleForMigrations(store), migrationConfig())
  assertStudioSchemaCurrent(store)

  const context = await createStudioAuth(store, config).$context
  if (!context.checkSchema) throw new Error('Better Auth adapter does not support schema validation')
  await context.checkSchema()
  const integrity = studioSqliteDriver(store).pragma('integrity_check') as Array<{ integrity_check: string }>
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
    throw new Error('Studio SQLite integrity check failed')
  }
  if ((studioSqliteDriver(store).pragma('foreign_key_check') as Array<unknown>).length) {
    throw new Error('Studio SQLite foreign-key check failed')
  }
}
