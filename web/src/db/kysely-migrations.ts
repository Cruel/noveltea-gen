import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, promises as fs } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CamelCasePlugin, Kysely, SqliteDialect, sql } from 'kysely'
import { StudioPostgresDialect } from './studio-postgres-dialect'
import { trustedCatalogProjectionSql, trustedCatalogViewName } from './trusted-catalog-definition'
import { FileMigrationProvider, Migrator, NO_MIGRATIONS, type Migration } from 'kysely/migration'
import { Pool, type PoolConfig } from 'pg'
import { register } from 'tsx/esm/api'
import { betterAuth } from 'better-auth'
import { getMigrations } from 'better-auth/db/migration'
import { StudioSchemaError } from './schema-error'
import { expectedSqliteDefinitions, postgresColumnType, postgresTrigger, studioBaselineFor, studioDdl } from './kysely-baseline'
import { studioAuthOptionsForDatabase, type StudioAuthConfig } from '../lib/auth'

export type StudioSchemaOptions =
  { backend: 'sqlite'; path: string } | { backend: 'postgres'; connection: PoolConfig; poolSize?: number }

type Connection = {
  backend: 'sqlite' | 'postgres'
  migrationFolder: string
  db: Kysely<any>
  authDatabase: Database.Database | {
    dialect: StudioPostgresDialect
    type: 'postgres'
    transaction: true
  }
  close(): Promise<void>
}

/** Dedicated explicit-maintenance connection, never exposed through StudioStore.
 * Runtime startup uses this only for read-only readiness; migration requires
 * a separate, explicit operator invocation.
 */
export function openStudioSchemaConnection(
  options: StudioSchemaOptions,
  mode: 'migrate' | 'read' = 'migrate',
  migrationFolder = studioMigrationFolder,
): Connection {
  if (options.backend === 'sqlite') {
    if (options.path !== ':memory:' && !isAbsolute(options.path))
      throw new Error('Studio database path must be absolute')
    if (mode === 'read' && options.path !== ':memory:' && !existsSync(options.path))
      throw new StudioSchemaError('Studio SQLite database is absent; read-only readiness will not create it')
    if (mode === 'migrate' && options.path !== ':memory:')
      mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 })
    const sqlite = new Database(options.path, {
      timeout: 5000,
      readonly: mode === 'read',
      fileMustExist: mode === 'read' && options.path !== ':memory:',
    })
    if (mode === 'migrate' && options.path !== ':memory:') {
      chmodSync(options.path, 0o600)
      sqlite.pragma('journal_mode = WAL')
    }
    sqlite.pragma('foreign_keys = ON')
    const db = new Kysely<any>({
      dialect: new SqliteDialect({ database: sqlite }),
      plugins: [new CamelCasePlugin()],
    })
    return {
      backend: 'sqlite',
      migrationFolder,
      db,
      authDatabase: sqlite,
      async close() {
        await db.destroy()
        if (sqlite.open) sqlite.close()
      },
    }
  }
  if (options.backend !== 'postgres') throw new Error('Unsupported Studio schema backend')
  const poolSize = options.poolSize ?? 4
  if (!Number.isInteger(poolSize) || poolSize < 1 || poolSize > 32)
    throw new Error('Studio PostgreSQL pool size must be between 1 and 32')
  const pool = new Pool({
    ...options.connection,
    max: poolSize,
    connectionTimeoutMillis: 5000,
    options:
      mode === 'read'
        ? [options.connection.options, '-c default_transaction_read_only=on'].filter(Boolean).join(' ')
        : options.connection.options,
  })
  pool.on('error', () => {})
  const db = new Kysely<any>({
    dialect: new StudioPostgresDialect({ pool }),
    plugins: [new CamelCasePlugin()],
  })
  // Better Auth accepts a Kysely dialect config. Pass our schema-scoped
  // PostgreSQL introspector instead of the raw pool (which makes Better Auth
  // construct the stock, all-schema introspector). Auth runs without Studio's
  // CamelCasePlugin and retains transaction support on the same owned pool.
  const authDatabase = { dialect: new StudioPostgresDialect({ pool }), type: 'postgres' as const,
    transaction: true as const }
  return { backend: 'postgres', migrationFolder, db, authDatabase, close: () => db.destroy() }
}

export const studioMigrationFolder = fileURLToPath(
  new URL('../../kysely-schema/migrations/', import.meta.url),
)
export const studioBaselineName = '0000_studio_baseline'

/** File-based, ordered, handwritten migrations; never infer a schema diff. */
export function studioMigrationNames(migrationFolder = studioMigrationFolder): string[] {
  const authored = readdirSync(migrationFolder)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'))
    .map((file) => {
      if (!/^\d{4,}_[a-z][a-z0-9_]*\.ts$/.test(file))
        throw new StudioSchemaError(`Invalid Studio migration filename: ${file}`)
      return file.slice(0, -3)
    })
    .sort()
  if (authored.some((name) => name <= studioBaselineName) || new Set(authored).size !== authored.length)
    throw new StudioSchemaError('Studio migration filenames must be unique and newer than the baseline')
  return [studioBaselineName, ...authored]
}
const expected = studioDdl()

function sameCheckSemantics(expectedExpression: string, actualDefinition: string): boolean {
  // The authored checks are limited to IN, literal equality, IS NULL, <> and OR.
  // Compare the canonical PostgreSQL expression, not just literals or names.
  const unqualified = expectedExpression.replace(/"[^"]+"\."([^"]+)"/g, '$1')
  const clauses = unqualified.split(/\s+or\s+/i).map((clause) => {
    const membership = /^\s*([a-z_]+)\s+in\s*\((.+)\)\s*$/i.exec(clause)
    if (!membership) {
      const equality = /^\s*([a-z_]+)\s*=\s*('(?:[^']*)'|\d+)\s*$/i.exec(clause)
      if (equality)
        return `${equality[1]} = ${equality[2]!.startsWith("'") ? equality[2] + '::text' : equality[2]}`
      return clause.trim()
    }
    const values = membership[2]!.split(',').map((value) => {
      const token = value.trim()
      if (!/^'(?:[^']*)'$|^\d+$/.test(token)) throw new Error('Unsupported baseline CHECK value')
      return token.startsWith("'") ? token + '::text' : token
    })
    return `${membership[1]} = ANY (ARRAY[${values.join(', ')}])`
  })
  const canonical =
    clauses.length === 1
      ? `CHECK ((${clauses[0]}))`
      : `CHECK ((${clauses.map((part) => `(${part})`).join(' OR ')}))`
  const normalized = (source: string) =>
    normalizeSqlOutsideLiterals(source, (part) => part.toLowerCase().replace(/["\s]/g, ''))
  return normalized(canonical) === normalized(actualDefinition)
}

/** SQL keywords and identifiers are case-insensitive; string literals are not.
 * Keeping quoted text intact prevents false schema-parity witnesses. */
function normalizeSqlOutsideLiterals(source: string, normalize: (part: string) => string): string {
  return source.split(/('(?:''|[^'])*')/g)
    .map((part, index) => index % 2 ? part : normalize(part))
    .join('')
}

function normalizedIndexPredicate(predicate: string): string {
  return normalizeSqlOutsideLiterals(predicate, (part) => part
    .toLowerCase()
    .replace(/["`]/g, '')
    .replace(/\b[a-z_]+\./g, '')
    .replace(/::(?:text|character varying)/g, '')
    .replace(/[();\s]/g, ''))
}

const expectedTableNames = new Set(expected.tables.keys())
const authTables = new Set(['user', 'session', 'account', 'verification', 'rateLimit'])
const sourceLedger = 'studio_migration_sources'

/** Hash the exact applied source, not its physical DDL: data-only migration
 * changes and even comment changes must be detected. Baseline translations
 * are source-owned by both the frozen SQL and its interpreter.
 */
function migrationChecksum(name: string, folder: string): string {
  const hash = createHash('sha256').update('NovelTea Kysely migration source v1\\0').update(name)
  if (name === studioBaselineName) {
    hash.update(readFileSync(new URL('../../kysely-schema/0000_studio_baseline.sql', import.meta.url)))
    hash.update(readFileSync(new URL('./kysely-baseline.ts', import.meta.url)))
  } else {
    hash.update(readFileSync(join(folder, name + '.ts')))
    // This migration creates a view from the canonical typed projection.
    // Its imported source is part of the applied schema contract, just as
    // the baseline interpreter is part of baseline migration provenance.
    if (name === '0002_trusted_catalog') {
      hash.update(readFileSync(new URL('./trusted-catalog-definition.ts', import.meta.url)))
    }
  }
  return hash.digest('hex')
}

function withSourceLedger(name: string, folder: string, migration: Migration): Migration {
  const checksum = migrationChecksum(name, folder)
  return {
    async up(db) {
      if (name === studioBaselineName) {
        await db.schema
          .createTable('studioMigrationSources')
          .ifNotExists()
          .addColumn('name', 'text', (col) => col.primaryKey().notNull())
          .addColumn('checksum', 'text', (col) => col.notNull())
          .execute()
      }
      await migration.up(db)
      await db.insertInto('studioMigrationSources').values({ name, checksum }).execute()
    },
    async down(db) {
      if (!migration.down) throw new StudioSchemaError(`Migration ${name} cannot roll back without down()`)
      await migration.down(db)
      await db.deleteFrom('studioMigrationSources').where('name', '=', name).execute()
    },
  }
}

let migrationLoaderRegistered = false
function ensureMigrationTypeScriptLoader() {
  if (migrationLoaderRegistered) return
  register()
  migrationLoaderRegistered = true
}

async function migrator(connection: Connection): Promise<Migrator> {
  // Vite's dev SSR imports migrations through native Node ESM, while the
  // migration CLI already runs under tsx. Register one shared TS resolver
  // before importing authored files so immutable extensionless imports work
  // without creating a second Kysely module identity.
  ensureMigrationTypeScriptLoader()
  const files = new FileMigrationProvider({ fs, path: { join }, migrationFolder: connection.migrationFolder })
  // Kysely's unqualified table-existence test sees migration journals in
  // unrelated PostgreSQL schemas. Pin the journal to the selected schema so
  // a disposable test schema cannot inherit an existing public journal.
  const migrationTableSchema =
    connection.backend === 'postgres'
      ? (await sql<{ name: string }>`SELECT current_schema() AS name`.execute(connection.db)).rows[0]?.name
      : undefined
  if (connection.backend === 'postgres' && !migrationTableSchema)
    throw new StudioSchemaError('PostgreSQL schema is not selected for Studio migrations')
  return new Migrator({
    db: connection.db,
    ...(migrationTableSchema ? { migrationTableSchema } : {}),
    provider: {
      async getMigrations() {
        const authored = await files.getMigrations()
        const result: Record<string, Migration> = {
          [studioBaselineName]: withSourceLedger(
            studioBaselineName,
            connection.migrationFolder,
            studioBaselineFor(connection.backend),
          ),
        }
        for (const name of studioMigrationNames(connection.migrationFolder).slice(1)) {
          const migration = authored[name]
          if (!migration || typeof migration.up !== 'function')
            throw new StudioSchemaError(`Missing or invalid Studio migration: ${name}`)
          const template = readFileSync(join(connection.migrationFolder, `${name}.ts`), 'utf8')
          result[name] = withSourceLedger(name, connection.migrationFolder, {
            up: (db) => {
              if (template.includes('up migration code goes here...'))
                throw new StudioSchemaError(`Migration ${name} has an unimplemented up() scaffold`)
              return migration.up(db)
            },
            down: (db) => {
              if (
                typeof migration.down !== 'function' ||
                template.includes('down migration code goes here...')
              )
                throw new StudioSchemaError(
                  `Migration ${name} is irreversible: implement down() or explicitly throw`,
                )
              return migration.down(db)
            },
          })
        }
        return result
      },
    },
  })
}

async function listedTables(connection: Connection): Promise<Set<string>> {
  // Kysely intentionally hides its own journal tables from introspection.
  // Use a read-only catalog query so their absence is never mistaken for
  // an untracked Studio schema.
  const tables =
    connection.backend === 'sqlite'
      ? await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type='table'`.execute(connection.db)
      : await sql<{
          name: string
        }>`SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema()`.execute(connection.db)
  return new Set(tables.rows.map((table) => table.name))
}

/** Reject incompatible legacy and partial/future Kysely journals before any write.
 * Kysely Migrator must never infer adoption from pre-existing tables.
 */
export async function inspectStudioMigrationHistory(connection: Connection): Promise<number> {
  const tables = await listedTables(connection)
  const hasApp = [...expectedTableNames].some((table) => tables.has(table))
  const hasJournal = tables.has('kysely_migration')
  if (!hasJournal && hasApp)
    throw new StudioSchemaError(
      'Untracked Studio application tables exist without Kysely migration history. Back up and explicitly reset the selected Studio database; automatic adoption is forbidden.',
    )
  if (!hasJournal) {
    if (tables.has(sourceLedger))
      throw new StudioSchemaError('Studio Kysely source integrity ledger has no migration journal')
    return 0
  }
  if (!tables.has('kysely_migration_lock'))
    throw new StudioSchemaError('Studio Kysely migration lock table is missing')
  const history = await sql<{ name: string }>`SELECT name FROM kysely_migration ORDER BY name`.execute(
    connection.db,
  )
  const migrationNames = studioMigrationNames(connection.migrationFolder)
  if (history.rows.length > migrationNames.length)
    throw new StudioSchemaError('Studio database was created by a newer application; refusing downgrade')
  for (let i = 0; i < history.rows.length; i++) {
    if (history.rows[i]!.name !== migrationNames[i])
      throw new StudioSchemaError(
        'Studio Kysely migration history is incompatible or newer than this build; refusing automatic repair.',
      )
  }
  if (!tables.has(sourceLedger)) {
    // Kysely can create an empty journal before a transaction that fails;
    // when no application migrations committed there is no provenance to lose.
    if (history.rows.length === 0 && !hasApp) return 0
    throw new StudioSchemaError(
      'Studio Kysely source integrity ledger is missing; migration provenance cannot be adopted',
    )
  }
  const sources = await sql<{
    name: string
    checksum: string
  }>`SELECT name, checksum FROM studio_migration_sources ORDER BY name`.execute(connection.db)
  if (sources.rows.length !== history.rows.length)
    throw new StudioSchemaError('Studio Kysely source integrity ledger count mismatch')
  for (let i = 0; i < history.rows.length; i++) {
    const source = sources.rows[i]!
    if (
      source.name !== history.rows[i]!.name ||
      source.checksum !== migrationChecksum(source.name, connection.migrationFolder)
    )
      throw new StudioSchemaError(`Studio Kysely migration source checksum drift (${source.name})`)
  }
  return history.rows.length
}

function compareDefinitions(actual: Map<string, string>, expectedSql: Map<string, string>) {
  for (const [key, definition] of expectedSql) {
    if (actual.get(key) !== definition)
      throw new StudioSchemaError(
        `Studio Kysely schema definition drift (${key}); restore the matching schema or explicitly reset.`,
      )
  }
  for (const key of actual.keys()) {
    if (!expectedSql.has(key))
      throw new StudioSchemaError(
        `Studio Kysely unexpected schema definition drift (${key}); restore the matching schema or explicitly reset.`,
      )
  }
}

function assertAuthAndAppTables(tables: Set<string>) {
  for (const name of authTables) {
    if (!tables.has(name)) throw new StudioSchemaError(`Better Auth schema is incomplete (missing ${name})`)
  }
  for (const name of expectedTableNames) {
    if (!tables.has(name)) throw new StudioSchemaError(`Studio Kysely schema drift (missing ${name})`)
  }
}

type SqliteDefinition = { type: string; name: string; tableName: string; sql: string }
const schemaDefinitionsSql = `SELECT type, name, tbl_name AS tableName, sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('table', 'index', 'trigger')`
const internalTables = new Set([
  'user',
  'kysely_migration',
  'kysely_migration_lock',
  'sqlite_sequence',
  sourceLedger,
])

/** Replay the authored migration history into an empty in-memory SQLite DB.
 * This is only an expectation for read-only schema checks; never auto-repairs
 * the inspected database, and never maintains a second handwritten schema.
 */
async function expectedSqliteSnapshot<T>(
  connection: Connection,
  check: (sqlite: Database.Database) => Promise<T> | T,
): Promise<T> {
  const scratch = openStudioSchemaConnection(
    { backend: 'sqlite', path: ':memory:' },
    'migrate',
    connection.migrationFolder,
  )
  try {
    const sqlite = scratch.authDatabase as Database.Database
    sqlite.exec('CREATE TABLE user (id TEXT PRIMARY KEY NOT NULL)')
    const runner = await migrator(scratch)
    const result = await runner.migrateToLatest()
    if (result.error) throw result.error
    return await check(sqlite)
  } finally {
    await scratch.close()
  }
}
function appDefinitions(sqlite: Database.Database): Map<string, string> {
  const entries = sqlite.prepare(schemaDefinitionsSql).all() as SqliteDefinition[]
  return new Map(
    entries
      .filter((row) => !internalTables.has(row.name) && !row.name.startsWith('sqlite_autoindex'))
      .map((row) => [row.type + ':' + row.name, row.sql]),
  )
}

async function assertSqliteSchema(connection: Connection): Promise<void> {
  const result = await sql<SqliteDefinition>`${sql.raw(schemaDefinitionsSql)}`.execute(connection.db)
  // Compare the complete Studio-owned inventory, not just expected object
  // names. Auth, the migration journal, and SQLite's own objects are managed
  // independently and must not cause false positive drift.
  const actual = new Map(result.rows
    .filter((row) => !internalTables.has(row.tableName) &&
      !authTables.has(row.tableName) && !row.name.startsWith('sqlite_'))
    .map((row) => [row.type + ':' + row.name, row.sql]))
  const expectedSql =
    studioMigrationNames(connection.migrationFolder).length === 1
      ? expectedSqliteDefinitions()
      : await expectedSqliteSnapshot(connection, appDefinitions)
  compareDefinitions(actual, expectedSql)
  const violations = await sql`PRAGMA foreign_key_check`.execute(connection.db)
  if (violations.rows.length) throw new StudioSchemaError('Studio SQLite foreign-key violations')
}

type PgColumn = {
  tableName: string
  columnName: string
  dataType: string
  isNullable: string
  columnDefault: string | null
  isIdentity: string
}
type PgIndex = {
  tablename: string
  indexname: string
  indexdef: string
  indisunique: boolean
  constraintIndex: boolean
}
type PgConstraint = {
  tableName: string
  conname: string
  contype: string
  definition: string
  condeferrable: boolean
  condeferred: boolean
  convalidated: boolean
}
type PgTrigger = { tableName: string; tgname: string; tgenabled: string; prosrc: string; triggerDef: string }

/** Catalog inspection contains no DDL or mutating probes, including on a read-only PG role. */
async function assertPostgresSchema(connection: Connection): Promise<void> {
  const db = connection.db
  const [columnsResult, indexesResult, constraintsResult, triggersResult] = await Promise.all([
    sql<PgColumn>`SELECT table_name, column_name, data_type, is_nullable, column_default, is_identity
      FROM information_schema.columns AS col
      WHERE col.table_schema = current_schema()
        AND EXISTS (SELECT 1 FROM information_schema.tables AS t
          WHERE t.table_schema = col.table_schema AND t.table_name = col.table_name
            AND t.table_type = 'BASE TABLE')`.execute(db),
    sql<PgIndex>`SELECT t.relname AS tablename, i.relname AS indexname,
        pg_get_indexdef(x.indexrelid) AS indexdef, x.indisunique,
        (c.oid IS NOT NULL) AS constraint_index
      FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid
      JOIN pg_class t ON t.oid=x.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      LEFT JOIN pg_constraint c ON c.conindid=x.indexrelid AND c.contype IN ('p','u')
      WHERE n.nspname=current_schema()`.execute(db),
    sql<PgConstraint>`SELECT t.relname AS table_name, c.conname, c.contype,
        c.condeferrable, c.condeferred, c.convalidated, pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
      JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname=current_schema()`.execute(db),
    sql<PgTrigger>`SELECT t.relname AS table_name, g.tgname, g.tgenabled, p.prosrc,
        pg_get_triggerdef(g.oid) AS trigger_def
      FROM pg_trigger g JOIN pg_class t ON t.oid=g.tgrelid
      JOIN pg_namespace n ON n.oid=t.relnamespace
      JOIN pg_proc p ON p.oid=g.tgfoid
      WHERE n.nspname=current_schema() AND NOT g.tgisinternal`.execute(db),
  ])
  const byTable = new Map<string, PgColumn[]>()
  for (const row of columnsResult.rows) {
    byTable.set(row.tableName, [...(byTable.get(row.tableName) ?? []), row])
  }
  // Replay authored SQLite migrations instead of maintaining an independent
  // type/schema engine. This also includes future added columns and tables.
  const snapshot = await expectedSqliteSnapshot(connection, async (sqlite) => {
    const definitions = appDefinitions(sqlite)
    const appTables = [...definitions.keys()]
      .filter((key) => key.startsWith('table:'))
      .map((key) => key.slice('table:'.length))
    for (const table of appTables) {
      const cols = sqlite.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
        name: string
        type: string
        notnull: number
        dflt_value: string | null
        pk: number
      }>
      const actual = byTable.get(table) ?? []
      if (actual.length !== cols.length)
        throw new StudioSchemaError(`Studio PostgreSQL schema column drift (${table})`)
      for (const col of cols) {
        const found = actual.find((row) => row.columnName === col.name)
        const type = postgresColumnType(table, col.name, col.type)
        const nullable = col.notnull === 0 && col.pk === 0
        const expectedDefault = col.dflt_value?.replace(/^\((.*)\)$/, '$1') ?? null
        const actualDefault =
          found?.columnDefault
            ?.replace(/::(?:text|integer|character varying)/g, '')
            .replace(/^\((.*)\)$/, '$1') ?? null
        if (
          !found ||
          found.dataType !== type ||
          (found.isNullable === 'YES') !== nullable ||
          (found.isIdentity !== 'YES' && expectedDefault !== actualDefault)
        ) {
          throw new StudioSchemaError(`Studio PostgreSQL schema column drift (${table}.${col.name})`)
        }
        // Generated ordering keys must be true PG identity columns, not merely
        // integer columns with a replaceable or missing default.
        const tableSql = (
          sqlite.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(table) as {
            sql: string
          }
        ).sql
        const generatedBySqlite = col.pk === 1 && /\bAUTOINCREMENT\b/i.test(tableSql)
        if ((found.isIdentity === 'YES') !== generatedBySqlite)
          throw new StudioSchemaError(`Studio PostgreSQL identity drift (${table}.${col.name})`)
      }
      const primaryColumns = cols
        .filter((column) => column.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((column) => column.name)
      const pgPrimary = constraintsResult.rows.find((c) => c.tableName === table && c.contype === 'p')
      const actualPrimary =
        pgPrimary?.definition
          .match(/^PRIMARY KEY \((.*)\)$/i)?.[1]
          ?.replace(/["\s]/g, '')
          .split(',') ?? []
      if (primaryColumns.join(',') !== actualPrimary.join(','))
        throw new StudioSchemaError(`Studio PostgreSQL primary-key drift (${table})`)
      const foreignKeys = sqlite.prepare(`PRAGMA foreign_key_list("${table}")`).all() as Array<{
        id: number
        seq: number
        table: string
        from: string
        to: string
        on_delete: string
      }>
      const groups = new Map<number, typeof foreignKeys>()
      for (const fk of foreignKeys) groups.set(fk.id, [...(groups.get(fk.id) ?? []), fk])
      const pgKeys = constraintsResult.rows.filter((c) => c.tableName === table && c.contype === 'f')
      if (groups.size !== pgKeys.length)
        throw new StudioSchemaError(`Studio PostgreSQL foreign-key drift (${table})`)
      for (const group of groups.values()) {
        group.sort((a, b) => a.seq - b.seq)
        const from = group.map((f) => f.from).join(',')
        const to = group.map((f) => f.to).join(',')
        const normalized = (value: string) =>
          value
            .toLowerCase()
            .replace(/["\s]/g, '')
            .replace(/public\./g, '')
        const relation = normalized(`FOREIGN KEY (${from}) REFERENCES ${group[0]!.table}(${to})`)
        const found = pgKeys.find((key) => normalized(key.definition).startsWith(relation))
        if (
          !found || !found.convalidated ||
          (group[0]!.on_delete.toLowerCase() === 'cascade' && !/ON DELETE CASCADE/i.test(found.definition)) ||
          (group[0]!.on_delete.toLowerCase() === 'set null' &&
            !/ON DELETE SET NULL/i.test(found.definition)) ||
          (group[0]!.on_delete.toLowerCase() === 'no action' &&
            (/ON DELETE (CASCADE|SET NULL|RESTRICT)/i.test(found.definition) ||
              !found.condeferrable ||
              !found.condeferred)) ||
          /ON UPDATE (CASCADE|SET NULL|RESTRICT)/i.test(found.definition)
        )
          throw new StudioSchemaError(`Studio PostgreSQL foreign-key drift (${table}.${from})`)
      }
      const tableSql = (
        sqlite.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(table) as {
          sql: string
        }
      ).sql
      const checks = [...tableSql.matchAll(/CONSTRAINT\s+"([^"]+)"\s+CHECK\(([^\n]*)\)/gi)]
      const expectedCheckNames = new Set<string>()
      for (const [, name, expression] of checks) {
        expectedCheckNames.add(name!)
        const found = constraintsResult.rows.find(
          (c) => c.tableName === table && c.conname === name && c.contype === 'c',
        )
        if (!found || !found.convalidated || !sameCheckSemantics(expression!, found.definition))
          throw new StudioSchemaError(`Studio PostgreSQL CHECK constraint drift (${name})`)
      }
      for (const row of constraintsResult.rows.filter((c) => c.tableName === table && c.contype === 'c')) {
        if (!expectedCheckNames.has(row.conname))
          throw new StudioSchemaError(`Studio PostgreSQL unexpected CHECK constraint drift (${row.conname})`)
      }
      const namedUniques = [
        ...tableSql.matchAll(/CONSTRAINT\s+["`]?([a-z_][a-z0-9_]*)["`]?\s+UNIQUE\s*\(([^)]+)\)/gi),
      ]
      const expectedUniqueNames = new Set<string>()
      for (const [, name, columns] of namedUniques) {
        expectedUniqueNames.add(name!)
        const row = constraintsResult.rows.find(
          (c) => c.tableName === table && c.contype === 'u' && c.conname === name,
        )
        const normalize = (value: string) => value.replace(/["`\s]/g, '').toLowerCase()
        if (!row || normalize(row.definition) !== normalize(`UNIQUE (${columns})`))
          throw new StudioSchemaError(`Studio PostgreSQL unique constraint drift (${name})`)
      }
      for (const row of constraintsResult.rows.filter((c) => c.tableName === table && c.contype === 'u')) {
        if (!expectedUniqueNames.has(row.conname))
          throw new StudioSchemaError(`Studio PostgreSQL unexpected unique constraint drift (${row.conname})`)
      }
    }
    return definitions
  })
  const applicationTables = new Set(
    [...snapshot.keys()]
      .filter((name) => name.startsWith('table:'))
      .map((name) => name.slice('table:'.length)),
  )
  const physicalTables = new Set(columnsResult.rows.map((col) => col.tableName))
  const unrelated = new Set([
    ...authTables,
    'kysely_migration',
    'kysely_migration_lock',
    'studio_migration_sources',
  ])
  for (const table of physicalTables) {
    if (!applicationTables.has(table) && !unrelated.has(table))
      throw new StudioSchemaError(`Studio PostgreSQL unexpected application table drift (${table})`)
  }
  const expectedIndexNames = new Set<string>()
  for (const [key, ddl] of snapshot) {
    if (!key.startsWith('index:')) continue
    const name = key.slice('index:'.length)
    expectedIndexNames.add(name)
    {
      const match =
        /^CREATE (UNIQUE )?INDEX [`"]?([a-z_][a-z0-9_]*)[`"]? ON [`"]?([a-z_][a-z0-9_]*)[`"]?\s*\(([^)]+)\)(?:\s+WHERE\s+([\s\S]*?))?;?$/i.exec(
          ddl,
        )
      if (!match) throw new Error('Cannot inspect Studio index: ' + ddl)
      const actual = indexesResult.rows.find(
        (row) => row.tablename === match[3] && row.indexname === match[2] && !row.constraintIndex,
      )
      if (!actual || actual.indisunique !== !!match[1])
        throw new StudioSchemaError(`Studio PostgreSQL index drift (${match[2]})`)
      const columns = match[4]!.replace(/[`"\s]/g, '')
      const indexdef = actual.indexdef.toLowerCase().replace(/["\s]/g, '')
      if (!indexdef.includes('(' + columns + ')'))
        throw new StudioSchemaError(`Studio PostgreSQL index columns drift (${match[2]})`)
      const predicate = match[5]
      const actualPredicate = actual.indexdef.split(/\bwhere\b/i)[1]
      if (
        !!predicate !== !!actualPredicate ||
        (predicate && normalizedIndexPredicate(predicate) !== normalizedIndexPredicate(actualPredicate!))
      )
        throw new StudioSchemaError(`Studio PostgreSQL partial index drift (${match[2]})`)
    }
  }
  for (const row of indexesResult.rows) {
    if (
      applicationTables.has(row.tablename) &&
      !row.constraintIndex &&
      !expectedIndexNames.has(row.indexname)
    )
      throw new StudioSchemaError(`Studio PostgreSQL unexpected index drift (${row.indexname})`)
  }
  const expectedTriggerNames = new Set<string>()
  for (const [key, ddl] of snapshot) {
    if (!key.startsWith('trigger:')) continue
    const name = key.slice('trigger:'.length)
    expectedTriggerNames.add(name)
    const trigger = postgresTrigger(name, ddl)
    const row = triggersResult.rows.find((r) => r.tgname === name && r.tableName === trigger.table)
    const normalizeTrigger = (definition: string) =>
      definition
        .toLowerCase()
        .replace(/"/g, '')
        .replace(/\b[a-z][a-z0-9_]*\.(?=[a-z][a-z0-9_]*\b)/g, '')
        .replace(/\s+/g, '')
    if (
      !row ||
      row.tgenabled !== 'O' ||
      row.prosrc.trim() !== trigger.source.trim() ||
      normalizeTrigger(row.triggerDef) !== normalizeTrigger(trigger.create)
    )
      throw new StudioSchemaError(`Studio PostgreSQL trigger drift (${name})`)
  }
  for (const row of triggersResult.rows) {
    if (applicationTables.has(row.tableName) && !expectedTriggerNames.has(row.tgname))
      throw new StudioSchemaError(`Studio PostgreSQL unexpected trigger drift (${row.tgname})`)
  }
}

/** Compare the physical, persisted view with the one typed authorization query.
 * PostgreSQL deparses view SQL with join parentheses and optional AS tokens.
 * Removing only those syntactic differences preserves all projected columns,
 * source tables, identifiers, equality operands and join conditions. */
function comparableTrustedViewSql(source: string): string {
  return source.toLowerCase().replace(/["`]/g, '')
    // PostgreSQL omits a redundant projected alias like provider AS provider.
    .replace(/\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\s+as\s+\2\b/g, '$1.$2')
    .replace(/\b(?:inner|as)\b/g, '')
    .replace(/[\s();]/g, '')
}

export async function assertTrustedCatalogView(connection: Connection): Promise<void> {
  const view = await trustedCatalogViewName(connection.db, connection.backend)
  const projection = trustedCatalogProjectionSql(connection.db)
  let actual: string | undefined
  if (connection.backend === 'sqlite') {
    const result = await sql<{ definition: string }>`SELECT sql AS definition FROM sqlite_master
      WHERE type = 'view' AND name = 'trusted_jobs'`.execute(connection.db)
    actual = result.rows[0]?.definition
    if (actual !== `CREATE VIEW trusted_jobs AS ${projection}`)
      throw new StudioSchemaError('Studio trusted catalog view definition drift (SQLite)')
  } else {
    const result = await sql<{ definition: string }>`SELECT pg_get_viewdef(c.oid, false) AS definition
      FROM pg_class c WHERE c.oid = to_regclass(${view}) AND c.relkind = 'v'`.execute(connection.db)
    actual = result.rows[0]?.definition
    if (!actual || comparableTrustedViewSql(actual) !== comparableTrustedViewSql(projection))
      throw new StudioSchemaError('Studio trusted catalog view definition drift (PostgreSQL)')
  }
  try {
    await sql.raw(`SELECT job_id, owner_id, provider, provider_id, directory, pin, config_json FROM ${view} LIMIT 0`)
      .execute(connection.db)
  } catch {
    throw new StudioSchemaError('Studio trusted catalog view is missing or inaccessible; explicit migration required')
  }
}

export async function assertKyselyStudioSchemaCurrent(connection: Connection): Promise<void> {
  const applied = await inspectStudioMigrationHistory(connection)
  const migrationNames = studioMigrationNames(connection.migrationFolder)
  if (applied !== migrationNames.length)
    throw new StudioSchemaError(
      `Studio Kysely migrations are pending (requires ${migrationNames.length}, found ${applied}). Run the explicit Kysely migration command.`,
    )
  const tables = await listedTables(connection)
  assertAuthAndAppTables(tables)
  if (connection.backend === 'sqlite') await assertSqliteSchema(connection)
  else await assertPostgresSchema(connection)
  // Custom migration certification fixtures deliberately exclude the hosted
  // catalog migration. Enforce this view only where it is an authored part of
  // the checked schema history, never add DDL during runtime readiness.
  if (!migrationNames.includes('0002_trusted_catalog')) return
  await assertTrustedCatalogView(connection)
}

/** Explicit migration entrypoint. Better Auth owns its own tables and always
 * migrates them before the application baseline. Both checks are fail closed;
 * migrate never tries to adopt old schemas or repair altered application DDL.
 */
export async function migrateStudioKysely(
  connection: Connection,
  config: StudioAuthConfig,
  target: string | typeof NO_MIGRATIONS = 'latest',
): Promise<void> {
  const names = studioMigrationNames(connection.migrationFolder)
  if (
    target !== 'latest' &&
    target !== 'down' &&
    target !== NO_MIGRATIONS &&
    (typeof target !== 'string' || !names.includes(target))
  )
    throw new StudioSchemaError(`Unknown Studio migration target: ${target}`)
  const applied = await inspectStudioMigrationHistory(connection)
  if (applied === names.length && target !== NO_MIGRATIONS) await assertKyselyStudioSchemaCurrent(connection)
  const authOptions = studioAuthOptionsForDatabase(connection.authDatabase, config)
  const { runMigrations } = await getMigrations(authOptions)
  await runMigrations()
  const runner = await migrator(connection)
  const result =
    target === 'down'
      ? await runner.migrateDown()
      : target === 'latest'
        ? await runner.migrateToLatest()
        : await runner.migrateTo(target)
  if (result.error) throw result.error
  if (target === 'latest' || target === names.at(-1)) {
    await assertKyselyStudioSchemaCurrent(connection)
    const context = await betterAuth(authOptions).$context
    if (!context.checkSchema) throw new Error('Better Auth schema validation unavailable')
    await context.checkSchema()
  }
}

export { NO_MIGRATIONS }
