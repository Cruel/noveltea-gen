import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { sql, type Kysely } from 'kysely'
import type { Migration } from 'kysely/migration'

/**
 * Fresh-schema Kysely baseline. The SQL asset is an independent frozen snapshot
 * of the application schema, not generated from a runtime database.
 * Auth tables are deliberately absent: Better Auth owns those migrations.
 *
 * The two dialects share tables, columns, indexes and invariants. PostgreSQL
 * only requires DDL ordering, identity conversion and trigger-function syntax.
 * Never run this against a populated legacy database.
 */
const ddl = readFileSync(new URL('../../kysely-schema/0000_studio_baseline.sql', import.meta.url), 'utf8')

function cleaned(statement: string): string {
  return statement.replace(/^(?:\s|--[^\n]*(?:\n|$))*/, '').trim()
}

export const baselineStatements = ddl
  .split(/--> statement-breakpoint/)
  .map(cleaned)
  .filter(Boolean)

export type StudioDdl = {
  tables: Map<string, string>
  indexes: Map<string, string[]>
  alters: string[]
  triggers: Map<string, string>
}

function nameOf(statement: string, kind: 'TABLE' | 'TRIGGER'): string {
  const match = new RegExp(`^CREATE ${kind} [` + '`' + `"]?([a-z_]+)`, 'i').exec(statement)
  if (!match) throw new Error('Invalid Studio baseline ' + kind)
  return match[1]!
}

export function studioDdl(): StudioDdl {
  const tables = new Map<string, string>()
  const indexes = new Map<string, string[]>()
  const triggers = new Map<string, string>()
  const alters: string[] = []
  for (const statement of baselineStatements) {
    if (/^CREATE TABLE\b/i.test(statement)) tables.set(nameOf(statement, 'TABLE'), statement)
    else if (/^CREATE (?:UNIQUE )?INDEX\b/i.test(statement)) {
      const match = /^CREATE (?:UNIQUE )?INDEX [`"]?[a-z_]+[`"]? ON [`"]?([a-z_]+)[`"]?/i.exec(statement)
      if (!match) throw new Error('Invalid Studio baseline index')
      indexes.set(match[1]!, [...(indexes.get(match[1]!) ?? []), statement])
    } else if (/^ALTER TABLE\b/i.test(statement)) alters.push(statement)
    else if (/^CREATE TRIGGER\b/i.test(statement)) triggers.set(nameOf(statement, 'TRIGGER'), statement)
    else if (/^DROP TRIGGER\b/i.test(statement)) {
      const match = /^DROP TRIGGER (?:IF EXISTS )?([a-z_]+)/i.exec(statement)
      if (!match) throw new Error('Invalid Studio baseline trigger drop')
      triggers.delete(match[1]!)
    } else throw new Error('Unsupported Studio baseline DDL: ' + statement.slice(0, 90))
  }
  if (tables.size !== 33 || triggers.size !== 15)
    throw new Error(`Unexpected Studio baseline: ${tables.size} tables, ${triggers.size} triggers`)
  return { tables, indexes, alters, triggers }
}

function dependencies(ddl: string): string[] {
  return [...ddl.matchAll(/\bREFERENCES\s+[`"]?([a-z_]+)[`"]?/gi)].map((m) => m[1]!)
}

/** Parent tables and their composite unique indexes must exist before PG FKs. */
export function tableOrder(tables: ReadonlyMap<string, string>): string[] {
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const order: string[] = []
  const visit = (table: string) => {
    if (visited.has(table)) return
    if (visiting.has(table)) throw new Error('Cyclic Studio table dependency: ' + table)
    visiting.add(table)
    for (const parent of dependencies(tables.get(table)!)) {
      if (parent !== table && tables.has(parent)) visit(parent)
      else if (parent !== 'user' && parent !== table && !tables.has(parent))
        throw new Error('Unknown Studio FK parent: ' + parent)
    }
    visiting.delete(table)
    visited.add(table)
    order.push(table)
  }
  for (const table of tables.keys()) visit(table)
  return order
}

/** SQLite INTEGER is 64-bit. PostgreSQL INTEGER is only 32-bit; these
 * application values are epoch milliseconds and need a full signed 64-bit
 * range. Keep counters, boolean flags, and identity sequences unchanged. */
const postgresEpochColumns: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['git_connection_flows', new Set(['expires_at'])],
  ['git_connections', new Set(['refresh_lease_until', 'access_expires_at', 'refresh_expires_at'])],
  ['github_install_flows', new Set(['created_at', 'expires_at'])],
])

export function postgresColumnType(table: string, column: string, sqliteType: string): string {
  if (sqliteType.toLowerCase() !== 'integer') return 'text'
  return postgresEpochColumns.get(table)?.has(column) ? 'bigint' : 'integer'
}

export function postgresDdl(statement: string): string {
  const table = /^CREATE TABLE [`"]?([a-z_][a-z0-9_]*)[`"]?/i.exec(statement)?.[1]
  let translated = statement.replace(/`/g, '"')
  if (table) {
    for (const column of postgresEpochColumns.get(table) ?? []) {
      translated = translated.replace(
        new RegExp('(^\\s*"' + column + '"\\s+)integer\\b', 'gmi'),
        '$1bigint',
      )
    }
  }
  return (
    translated
      .replace(
        /\binteger\s+PRIMARY KEY AUTOINCREMENT NOT NULL/gi,
        'integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY NOT NULL',
      )
      // PostgreSQL doesn't permit qualifying the subject table in a CHECK or index WHERE.
      .replace(/"([a-z_]+)"\."([a-z_]+)"/gi, '"$2"')
  )
}

export function postgresTrigger(name: string, statement: string) {
  const stripped = statement.replace(/;\s*$/, '')
  const header =
    /^CREATE TRIGGER\s+[a-z_]+\s+(BEFORE|AFTER)\s+(INSERT|UPDATE(?: OF [a-z_]+)?|DELETE)\s+ON\s+([a-z_]+)\s*/i.exec(
      stripped,
    )
  if (!header) throw new Error('Invalid Studio trigger: ' + name)
  const remainder = stripped.slice(header[0].length)
  const beginAt = remainder.indexOf('BEGIN')
  const endAt = remainder.lastIndexOf('END')
  if (beginAt < 0 || endAt <= beginAt) throw new Error('Invalid Studio trigger body: ' + name)
  const condition = remainder
    .slice(0, beginAt)
    .trim()
    .replace(/^WHEN\s+/i, '')
    .replace(/\bIS NOT\s+(?=(?:OLD|NEW)\.)/gi, 'IS DISTINCT FROM ')
  let body = remainder.slice(beginAt + 5, endAt).trim()
  body = body
    .replace(/\bSELECT RAISE\(ABORT,\s*('[^']*')\)/gi, 'RAISE EXCEPTION $1')
    .replace(/\bIS NOT\s+(?=(?:OLD|NEW)\.)/gi, 'IS DISTINCT FROM ')
    .replace(
      /\bINSERT OR IGNORE INTO\s+([\s\S]*?);/gi,
      (_, insertion: string) => `INSERT INTO ${insertion.trim()} ON CONFLICT DO NOTHING;`,
    )
  const returnValue = header[2]!.startsWith('DELETE') ? 'OLD' : 'NEW'
  const source = `BEGIN\n${condition ? `  IF ${condition} THEN\n` : ''}${body}\n${condition ? '  END IF;\n' : ''}  RETURN ${returnValue};\nEND;`
  const event = header[2]!
  const create = `CREATE TRIGGER "${name}" ${header[1]} ${event} ON "${header[3]}" FOR EACH ROW EXECUTE FUNCTION "${name}_fn"()`
  return {
    table: header[3]!,
    source,
    functionDdl: `CREATE FUNCTION "${name}_fn"() RETURNS trigger LANGUAGE plpgsql AS $studio$\n${source}\n$studio$`,
    create,
  }
}

export const studioBaseline: Migration = {
  async up(db: Kysely<unknown>) {
    const { tables, indexes, alters, triggers } = studioDdl()
    // Kysely doesn't expose the dialect name. The migrator is constructed by
    // the caller with an explicit backend and binds this immutable migration.
    const backend = activeBackend.get(db)
    if (!backend) throw new Error('Studio migration backend was not bound')
    if (backend === 'sqlite') {
      for (const statement of baselineStatements) await sql.raw(statement).execute(db)
      return
    }
    const deferredForeignKeys: Array<{ table: string; ddl: string }> = []
    for (const name of tableOrder(tables)) {
      // A self-referential composite FK may require an explicit unique index
      // that does not exist until *after* CREATE TABLE. Collect all FKs and
      // add them after every table and owner-key index has been created.
      const lines = tables.get(name)!.split('\n')
      const foreignKeys = lines.filter((line) => line.trimStart().startsWith('FOREIGN KEY'))
      const withoutForeignKeys = lines
        .filter((line) => !line.trimStart().startsWith('FOREIGN KEY'))
        .join('\n')
        .replace(/,\s*\);$/, '\n);')
      await sql.raw(postgresDdl(withoutForeignKeys)).execute(db)
      for (const index of indexes.get(name) ?? []) await sql.raw(postgresDdl(index)).execute(db)
      for (const statement of foreignKeys)
        deferredForeignKeys.push({
          table: name,
          ddl: statement.trim().replace(/,$/, ''),
        })
    }
    for (const { table, ddl } of deferredForeignKeys) {
      // SQLite resolves multi-level cascades without rejecting a transient
      // reference while another cascading branch is still being deleted.
      // PostgreSQL's default immediate NO ACTION check can reject that same
      // valid final state; defer only NO ACTION checks to transaction commit.
      const compatible = /ON DELETE no action$/i.test(ddl) ? `${ddl} DEFERRABLE INITIALLY DEFERRED` : ddl
      await sql.raw(postgresDdl(`ALTER TABLE "${table}" ADD ${compatible}`)).execute(db)
    }
    for (const statement of alters) await sql.raw(postgresDdl(statement)).execute(db)
    for (const [name, statement] of triggers) {
      const translated = postgresTrigger(name, statement)
      await sql.raw(translated.functionDdl).execute(db)
      await sql.raw(translated.create).execute(db)
    }
  },
  async down(db: Kysely<unknown>) {
    const backend = activeBackend.get(db)
    if (!backend) throw new Error('Studio migration backend was not bound')
    const { tables, triggers } = studioDdl()
    if (backend === 'postgres') {
      for (const [name, statement] of triggers) {
        await sql.raw(`DROP TRIGGER "${name}" ON "${postgresTrigger(name, statement).table}"`).execute(db)
        await sql.raw(`DROP FUNCTION "${name}_fn"()`).execute(db)
      }
    }
    for (const name of tableOrder(tables).reverse()) {
      await sql.raw(`DROP TABLE "${name}"`).execute(db)
    }
  },
}

// Kysely Migrator invokes its migrations with the transaction executor, which
// is distinct from the root Kysely object. Bind both via the provider closure.
const activeBackend = new WeakMap<object, 'sqlite' | 'postgres'>()
export function studioBaselineFor(backend: 'sqlite' | 'postgres'): Migration {
  return {
    async up(db) {
      activeBackend.set(db, backend)
      try {
        await studioBaseline.up(db)
      } finally {
        activeBackend.delete(db)
      }
    },
    async down(db) {
      activeBackend.set(db, backend)
      try {
        await studioBaseline.down!(db)
      } finally {
        activeBackend.delete(db)
      }
    },
  }
}

/** Exact expected SQLite DDL including CHECK, partial indexes and triggers. */
export function expectedSqliteDefinitions(): Map<string, string> {
  const sqlite = new Database(':memory:')
  try {
    sqlite.exec('CREATE TABLE user (id TEXT PRIMARY KEY NOT NULL)')
    for (const statement of baselineStatements) sqlite.exec(statement)
    const rows = sqlite
      .prepare(
        "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('table', 'index', 'trigger')",
      )
      .all() as Array<{ type: string; name: string; sql: string }>
    return new Map(
      rows
        .filter((row) => row.name !== 'user' && !row.name.startsWith('sqlite_'))
        .map((row) => [row.type + ':' + row.name, row.sql]),
    )
  } finally {
    sqlite.close()
  }
}
