import { and, asc, desc, eq, getTableColumns, getTableName, isNull } from 'drizzle-orm'
import { SQLiteTable } from 'drizzle-orm/sqlite-core'
import * as schema from '../../src/db/schema'
import type { TestPersistence } from './test-persistence'
import { studioDrizzleForMigrations, studioSqliteDriver, type StudioDatabase } from '../../src/db/connection'

/** Backend-neutral test fixture/inspection contract. This implementation is
 * SQLite-specific, but tests express domain records and conditions rather
 * than SQLite SQL. PostgreSQL can implement the same contract later.
 *
 * Avoid using these helpers to replace an existing application persistence
 * method when exercising ordinary behavior.
 */
const tables = new Map<string, SQLiteTable>()
for (const entry of Object.values(schema)) {
  if (entry instanceof SQLiteTable) tables.set(getTableName(entry), entry)
}
type Fields = Record<string, unknown>
type Direction = { by: string; direction?: 'asc' | 'desc' }

function createSynchronousSqliteTestRecords(store: StudioDatabase) {
  const db = studioDrizzleForMigrations(store)
  const sqlite = studioSqliteDriver(store)
  const tableFor = (name: string) => {
    const table = tables.get(name)
    if (!table) throw new Error('Unknown test record table ' + name)
    return table
  }
  const predicate = (table: SQLiteTable, filter: Fields) => {
    const columns = getTableColumns(table) as Fields
    const parts = Object.entries(filter).map(([key, value]) => {
      const column = columns[key]
      if (!column) throw new Error('Unknown test record column ' + getTableName(table) + '.' + key)
      return value === null ? isNull(column as never) : eq(column as never, value as never)
    })
    return parts.length ? and(...parts) : undefined
  }
  return {
    records: {
      insert(tableName: string, row: Fields) {
        db.insert(tableFor(tableName)).values(row).run()
      },
      update(tableName: string, filter: Fields, changes: Fields) {
        if (!Object.keys(filter).length) throw new Error('Test update requires a predicate')
        return db.update(tableFor(tableName)).set(changes)
          .where(predicate(tableFor(tableName), filter)).run().changes
      },
      delete(tableName: string, filter: Fields) {
        if (!Object.keys(filter).length) throw new Error('Test delete requires a predicate')
        return db.delete(tableFor(tableName))
          .where(predicate(tableFor(tableName), filter)).run().changes
      },
      all<T extends Fields = Fields>(tableName: string, filter: Fields = {},
        sort?: Direction): T[] {
        const table = tableFor(tableName)
        const columns = getTableColumns(table) as Fields
        const where = predicate(table, filter)
        const query = db.select().from(table).where(where)
        return (sort ? query.orderBy(sort.direction === 'desc'
          ? desc(columns[sort.by] as never) : asc(columns[sort.by] as never)).all()
          : query.all()) as T[]
      },
      first<T extends Fields = Fields>(tableName: string, filter: Fields = {}): T | undefined {
        const table = tableFor(tableName)
        return db.select().from(table).where(predicate(table, filter)).limit(1).get() as T | undefined
      },
      count(tableName: string, filter: Fields = {}): number {
        const table = tableFor(tableName)
        return db.select().from(table).where(predicate(table, filter)).all().length
      },
    },
    /** Better Auth owns these tables, rather than the Studio Drizzle schema. */
    auth: {
      createUser(id: string, at = Date.now()) {
        sqlite.prepare('INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)')
          .run(id, 'Test Author', id + '@example.test', 1, at, at)
      },
      accounts(): Array<{ providerId: string; accessToken: string | null; refreshToken: string | null }> {
        return sqlite.prepare('SELECT providerId, accessToken, refreshToken FROM account ORDER BY providerId')
          .all() as Array<{ providerId: string; accessToken: string | null; refreshToken: string | null }>
      },
      userCount(): number {
        return (sqlite.prepare('SELECT COUNT(*) AS n FROM user').get() as { n: number }).n
      },
      accountCount(): number {
        return (sqlite.prepare('SELECT COUNT(*) AS n FROM account').get() as { n: number }).n
      },
      expireAccounts(providers: string[], at: number) {
        for (const provider of providers) sqlite.prepare(
          'UPDATE account SET accessTokenExpiresAt=? WHERE providerId=?',
        ).run(at, provider)
      },
    },
    /** Test invariants; no SQLite PRAGMAs are exposed to feature tests. */
    foreignKeyViolations(): unknown[] {
      return sqlite.pragma('foreign_key_check') as unknown[]
    },
    integrityHealthy(): boolean {
      return JSON.stringify(sqlite.pragma('integrity_check')) === '[{"integrity_check":"ok"}]'
    },
    schema: {
      tables(): string[] {
        return (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all() as Array<{ name: string }>).map(row => row.name)
      },
      columns(table: string): string[] {
        if (!/^[a-z_]+$/.test(table)) throw new Error('Invalid test table name')
        return (sqlite.pragma('table_info("' + table + '")') as Array<{ name: string }>)
          .map(row => row.name)
      },
      hasMigrationJournal(): boolean {
        return !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='__drizzle_migrations'").get()
      },
      migrationHistory(): Array<{ hash: string; createdAt: number }> {
        return sqlite.prepare('SELECT hash, created_at AS createdAt FROM __drizzle_migrations')
          .all() as Array<{ hash: string; createdAt: number }>
      },
      hasTable(name: string): boolean {
        return this.tables().includes(name)
      },
      /** SQLite-only schema fault injections stay in the backend test adapter. */
      tamperMigrationHash(hash: string) {
        sqlite.prepare('UPDATE __drizzle_migrations SET hash = ?').run(hash)
      },
      dropIndex(index: string) {
        if (!/^[a-z_]+$/.test(index)) throw new Error('Invalid index')
        sqlite.exec('DROP INDEX "' + index + '"')
      },
      dropTable(table: string) {
        if (!/^[a-zA-Z_]+$/.test(table)) throw new Error('Invalid table')
        sqlite.exec('DROP TABLE "' + table + '"')
      },
      definition(type: 'table' | 'index', name: string): string | undefined {
        return (sqlite.prepare('SELECT sql FROM sqlite_master WHERE type=? AND name=?')
          .get(type, name) as { sql: string } | undefined)?.sql
      },
      replaceTableFragment(table: string, original: string, replacement: string): boolean {
        const current = this.definition('table', table)
        if (!current?.includes(original)) return false
        const indexes = sqlite.prepare(
          "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL",
        ).all(table) as Array<{ sql: string }>
        sqlite.pragma('foreign_keys = OFF')
        try {
          this.dropTable(table)
          sqlite.exec(current.replace(original, replacement))
          for (const index of indexes) sqlite.exec(index.sql)
        } finally {
          sqlite.pragma('foreign_keys = ON')
        }
        return true
      },
      replaceIndexFragment(index: string, original: string, replacement: string): boolean {
        const current = this.definition('index', index)
        if (!current?.includes(original)) return false
        this.dropIndex(index)
        sqlite.exec(current.replace(original, replacement))
        return true
      },
      beginTemporaryColumnDrop(table: string, column: string) {
        if (!/^[a-z_]+$/.test(table) || !/^[a-z_]+$/.test(column))
          throw new Error('Invalid temporary schema mutation')
        sqlite.exec('SAVEPOINT test_schema_mutation')
        sqlite.exec('ALTER TABLE "' + table + '" DROP COLUMN "' + column + '"')
      },
      rollbackTemporaryColumnDrop() {
        sqlite.exec('ROLLBACK TO test_schema_mutation; RELEASE test_schema_mutation')
      },
      /** Simulate an untracked migration without changing the product's migration API. */
      removeMigrationHistory() {
        sqlite.exec('DELETE FROM __drizzle_migrations')
      },
      appendMigration(hash: string, createdAt: number) {
        sqlite.prepare('INSERT INTO __drizzle_migrations (hash,created_at) VALUES (?,?)')
          .run(hash, createdAt)
      },
    },
  }
}

/** Adapter boundary: preserve synchronous SQLite transactional operations
 * internally, while exposing only Promise-returning fixture operations to
 * feature tests. The same contract can be implemented using an async driver. */
export function createSqliteTestRecords(store: StudioDatabase): TestPersistence {
  const sync = createSynchronousSqliteTestRecords(store)
  const wrap = <T extends object>(source: T): object => Object.fromEntries(
    Object.entries(source).map(([key, value]) => [
      key, typeof value === 'function'
        ? (...args: unknown[]) => Promise.resolve().then(() =>
          (value as (...args: unknown[]) => unknown).apply(source, args))
        : wrap(value as object),
    ]),
  )
  return wrap(sync) as TestPersistence
}
