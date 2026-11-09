import Database from 'better-sqlite3'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, promises as fs } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CamelCasePlugin, Kysely, PostgresDialect, SqliteDialect, sql } from 'kysely'
import { FileMigrationProvider, Migrator, NO_MIGRATIONS, type Migration } from 'kysely/migration'
import { Pool, type PoolConfig } from 'pg'
import { betterAuth } from 'better-auth'
import { getMigrations } from 'better-auth/db/migration'
import { StudioSchemaError } from './schema-error'
import { expectedSqliteDefinitions, postgresTrigger, studioBaselineFor, studioDdl } from './kysely-baseline'
import { studioAuthOptionsForDatabase, type StudioAuthConfig } from '../lib/auth'

export type StudioSchemaOptions =
  { backend: 'sqlite'; path: string } | { backend: 'postgres'; connection: PoolConfig; poolSize?: number }

type Connection = {
  backend: 'sqlite' | 'postgres'
  migrationFolder: string
  db: Kysely<any>
  authDatabase: Database.Database | Pool
  close(): Promise<void>
}

/** Dedicated explicit-maintenance connection, never exposed through StudioStore.
 * This is not the web application's persistence switch: legacy Drizzle keeps
 * serving SQLite until the later repository cutover.
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
    dialect: new PostgresDialect({ pool }),
    plugins: [new CamelCasePlugin()],
  })
  return { backend: 'postgres', migrationFolder, db, authDatabase: pool, close: () => db.destroy() }
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
  // The authored checks are limited to IN, IS NULL, <> and OR.
  // Compare the canonical PostgreSQL expression, not just literals or names.
  const unqualified = expectedExpression.replace(/"[^"]+"\."([^"]+)"/g, '$1')
  const clauses = unqualified.split(/\s+or\s+/i).map((clause) => {
    const membership = /^\s*([a-z_]+)\s+in\s*\((.+)\)\s*$/i.exec(clause)
    if (!membership) return clause.trim()
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
  const normalized = (source: string) => source.toLowerCase().replace(/["\s]/g, '')
  return normalized(canonical) === normalized(actualDefinition)
}
function normalizedIndexPredicate(predicate: string): string {
  return predicate
    .toLowerCase()
    .replace(/["`]/g, '')
    .replace(/\b[a-z_]+\./g, '')
    .replace(/::(?:text|character varying)/g, '')
    .replace(/[();\s]/g, '')
}

const expectedTableNames = new Set(expected.tables.keys())
const authTables = new Set(['user', 'session', 'account', 'verification', 'rateLimit'])

async function migrator(connection: Connection): Promise<Migrator> {
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
          [studioBaselineName]: studioBaselineFor(connection.backend),
        }
        for (const name of studioMigrationNames(connection.migrationFolder).slice(1)) {
          const migration = authored[name]
          if (!migration || typeof migration.up !== 'function')
            throw new StudioSchemaError(`Missing or invalid Studio migration: ${name}`)
          const template = readFileSync(join(connection.migrationFolder, `${name}.ts`), 'utf8')
          result[name] = {
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
          }
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

/** Reject legacy Drizzle and partial/future Kysely journals before any write.
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
  if (!hasJournal) return 0
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
  return history.rows.length
}

function compareDefinitions(actual: Map<string, string>, expectedSql: Map<string, string>) {
  for (const [key, definition] of expectedSql) {
    if (actual.get(key) !== definition)
      throw new StudioSchemaError(
        `Studio Kysely schema definition drift (${key}); restore the matching schema or explicitly reset.`,
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

type SqliteDefinition = { type: string; name: string; sql: string }
const schemaDefinitionsSql = `SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('table', 'index', 'trigger')`
const internalTables = new Set(['user', 'kysely_migration', 'kysely_migration_lock', 'sqlite_sequence'])

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
  const actual = new Map(result.rows.map((row) => [row.type + ':' + row.name, row.sql]))
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
}
type PgConstraint = {
  tableName: string
  conname: string
  contype: string
  definition: string
  condeferrable: boolean
  condeferred: boolean
}
type PgTrigger = { tableName: string; tgname: string; tgenabled: string; prosrc: string; triggerDef: string }

/** Catalog inspection contains no DDL or mutating probes, including on a read-only PG role. */
async function assertPostgresSchema(connection: Connection): Promise<void> {
  const db = connection.db
  const [columnsResult, indexesResult, constraintsResult, triggersResult] = await Promise.all([
    sql<PgColumn>`SELECT table_name, column_name, data_type, is_nullable, column_default, is_identity
      FROM information_schema.columns WHERE table_schema = current_schema()`.execute(db),
    sql<PgIndex>`SELECT t.relname AS tablename, i.relname AS indexname,
        pg_get_indexdef(x.indexrelid) AS indexdef, x.indisunique
      FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid
      JOIN pg_class t ON t.oid=x.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname=current_schema()`.execute(db),
    sql<PgConstraint>`SELECT t.relname AS table_name, c.conname, c.contype,
        c.condeferrable, c.condeferred, pg_get_constraintdef(c.oid) AS definition
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
  await expectedSqliteSnapshot(connection, async (sqlite) => {
    const appTables = [...appDefinitions(sqlite).keys()]
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
        const type = col.type.toLowerCase() === 'integer' ? 'integer' : 'text'
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
          !found ||
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
      for (const [, name, expression] of checks) {
        const found = constraintsResult.rows.find(
          (c) => c.tableName === table && c.conname === name && c.contype === 'c',
        )
        if (!found || !sameCheckSemantics(expression!, found.definition))
          throw new StudioSchemaError(`Studio PostgreSQL CHECK constraint drift (${name})`)
      }
    }
  })
  for (const [table, definitions] of expected.indexes) {
    for (const ddl of definitions) {
      const match =
        /^CREATE (UNIQUE )?INDEX [`"]?([a-z_]+)[`"]? ON [`"]?[a-z_]+[`"]?\s*\(([^)]+)\)(?:\s+WHERE\s+([\s\S]*?))?;?$/i.exec(
          ddl,
        )
      if (!match) throw new Error('Cannot inspect Studio index: ' + ddl)
      const actual = indexesResult.rows.find((row) => row.tablename === table && row.indexname === match[2])
      if (!actual || actual.indisunique !== !!match[1])
        throw new StudioSchemaError(`Studio PostgreSQL index drift (${match[2]})`)
      const columns = match[3]!.replace(/[`"\s]/g, '')
      const indexdef = actual.indexdef.toLowerCase().replace(/["\s]/g, '')
      if (!indexdef.includes('(' + columns + ')'))
        throw new StudioSchemaError(`Studio PostgreSQL index columns drift (${match[2]})`)
      const predicate = match[4]
      const actualPredicate = actual.indexdef.split(/\bwhere\b/i)[1]
      if (
        !!predicate !== !!actualPredicate ||
        (predicate && normalizedIndexPredicate(predicate) !== normalizedIndexPredicate(actualPredicate!))
      )
        throw new StudioSchemaError(`Studio PostgreSQL partial index drift (${match[2]})`)
    }
  }
  for (const [name, ddl] of expected.triggers) {
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
}

/** Explicit migration entrypoint. Better Auth owns its own tables and always
 * migrates them before the application baseline. Both checks are fail closed;
 * migrate never tries to adopt Drizzle or repair altered application DDL.
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
