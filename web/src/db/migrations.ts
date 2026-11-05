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

export class StudioSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StudioSchemaError'
  }
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

// Detect old Studio databases BEFORE modifying anything (including Better
// Auth tables). This baseline is deliberately NOT an upgrade of the 27 old
// handwritten migrations; reset is an operator decision, never automatic.
function assertNotLegacy(store: StudioDatabase) {
  if (hasTable(store, 'studio_schema_migrations')) {
    throw new StudioSchemaError(
      'Incompatible legacy Studio database (27 handwritten migrations). Back up and explicitly reset NT_STUDIO_DB_PATH; this build does not upgrade existing Studio data.',
    )
  }
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
  assertNotLegacy(store)
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
  }
  inspected.set(store, schemaVersion)
}

export async function migrateStudio(store: StudioDatabase, config: StudioAuthConfig) {
  assertNotLegacy(store)
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
