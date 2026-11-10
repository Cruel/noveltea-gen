import Database from 'better-sqlite3'
import type { TestFields, TestPersistence, TestRecordSort } from './test-persistence'

/** Only the disposable fixture layer opens a raw SQLite inspection connection.
 * Application code and ordinary persistence ports always use shared Kysely.
 */
export function createKyselyTestRecords(path: string): TestPersistence & { close(): void } {
  const sqlite = new Database(path, { fileMustExist: true })
  sqlite.pragma('foreign_keys = ON')
  const snake = (field: string) => field.replace(/[A-Z]/g, letter => '_' + letter.toLowerCase())
  const camel = (field: string) => field.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())
  const ident = (value: string) => {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error('Invalid fixture identifier')
    return '"' + value + '"'
  }
  const cell = (value: unknown): string | number | bigint | Buffer | null => {
    if (value === null || value === undefined) return null
    if (typeof value === 'boolean') return value ? 1 : 0
    if (typeof value === 'string' || typeof value === 'number' ||
        typeof value === 'bigint' || Buffer.isBuffer(value)) return value
    throw new Error('Unsupported fixture SQLite value')
  }
  const values = (record: TestFields) =>
    Object.fromEntries(Object.entries(record).map(([key, value]) => [snake(key), cell(value)]))
  const row = <T extends TestFields>(record: Record<string, unknown>): T =>
    Object.fromEntries(Object.entries(record).map(([key, value]) => [camel(key), value])) as T
  const fields = (record: TestFields) => Object.keys(record).map(snake)
  const condition = (filter: TestFields) => {
    const keys = Object.keys(filter)
    return keys.length
      ? ' WHERE ' + keys.map(key => ident(snake(key)) + (filter[key] === null ? ' IS NULL' : ' = ?')).join(' AND ')
      : ''
  }
  const params = (filter: TestFields) =>
    Object.values(filter).filter(value => value !== null).map(cell)
  const table = (name: string) => ident(name)
  let droppedColumnSnapshot: {
    table: string; ddl: string; attachedDdl: string[]; data: Record<string, unknown>[]
  } | null = null
  const definition = (type: 'table' | 'index', name: string) =>
    (sqlite.prepare('SELECT sql FROM sqlite_master WHERE type=? AND name=?')
      .get(type, name) as { sql: string } | undefined)?.sql
  const tables = () => (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all() as Array<{ name: string }>).map(record => record.name)
  const columns = (name: string) =>
    (sqlite.pragma('table_info(' + table(name) + ')') as Array<{ name: string }>).map(record => record.name)

  const records: TestPersistence['records'] = {
    async insert(name, entry) {
      const data = values(entry)
      const keys = Object.keys(data)
      if (!keys.length) throw new Error('Fixture insert requires values')
      sqlite.prepare('INSERT INTO ' + table(name) + ' (' + keys.map(ident).join(',') +
        ') VALUES (' + keys.map(() => '?').join(',') + ')').run(...Object.values(data))
    },
    async update(name, filter, changes) {
      if (!fields(filter).length) throw new Error('Test update requires a predicate')
      const data = values(changes)
      const keys = Object.keys(data)
      if (!keys.length) throw new Error('Test update requires changes')
      const result = sqlite.prepare('UPDATE ' + table(name) + ' SET ' +
        keys.map(key => ident(key) + ' = ?').join(',') + condition(filter))
        .run(...Object.values(data), ...params(filter))
      return result.changes
    },
    async delete(name, filter) {
      if (!fields(filter).length) throw new Error('Test delete requires a predicate')
      return sqlite.prepare('DELETE FROM ' + table(name) + condition(filter))
        .run(...params(filter)).changes
    },
    async all<T extends TestFields = TestFields>(
      name: string, filter: TestFields = {}, sort?: TestRecordSort,
    ): Promise<T[]> {
      const ordering = sort ? ' ORDER BY ' + ident(snake(sort.by)) +
        (sort.direction === 'desc' ? ' DESC' : ' ASC') : ''
      return (sqlite.prepare('SELECT * FROM ' + table(name) + condition(filter) + ordering)
        .all(...params(filter)) as Record<string, unknown>[]).map(record => row<T>(record))
    },
    async first<T extends TestFields = TestFields>(name: string, filter: TestFields = {}) {
      const found = sqlite.prepare('SELECT * FROM ' + table(name) + condition(filter) + ' LIMIT 1')
        .get(...params(filter)) as Record<string, unknown> | undefined
      return found ? row<T>(found) : undefined
    },
    async count(name, filter = {}) {
      const result = sqlite.prepare('SELECT count(*) AS count FROM ' + table(name) + condition(filter))
        .get(...params(filter)) as { count: number }
      return result.count
    },
  }

  const schema: TestPersistence['schema'] = {
    async tables() { return tables() },
    async columns(name) { return columns(name) },
    async hasMigrationJournal() { return tables().includes('kysely_migration') },
    async migrationHistory() {
      if (!tables().includes('kysely_migration')) return []
      return (sqlite.prepare('SELECT name, timestamp FROM kysely_migration ORDER BY name')
        .all() as Array<{ name: string; timestamp: string }>).map(record =>
        ({ hash: record.name, createdAt: Date.parse(record.timestamp) || 0 }))
    },
    async hasTable(name) { return tables().includes(name) },
    async tamperMigrationHash(hash) {
      sqlite.prepare('UPDATE kysely_migration SET name=? WHERE name=(SELECT name FROM kysely_migration ORDER BY name LIMIT 1)')
        .run(hash)
    },
    async dropIndex(index) { sqlite.exec('DROP INDEX ' + ident(index)) },
    async dropTable(name) { sqlite.exec('DROP TABLE ' + table(name)) },
    async definition(type, name) { return definition(type, name) },
    async replaceTableFragment(name, original, replacement) {
      const source = definition('table', name)
      if (!source?.includes(original)) return false
      const indexes = sqlite.prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL",
      ).all(name) as Array<{ sql: string }>
      sqlite.pragma('foreign_keys = OFF')
      try {
        sqlite.exec('DROP TABLE ' + table(name))
        sqlite.exec(source.replace(original, replacement))
        for (const index of indexes) sqlite.exec(index.sql)
      } finally {
        sqlite.pragma('foreign_keys = ON')
      }
      return true
    },
    async replaceIndexFragment(name, original, replacement) {
      const source = definition('index', name)
      if (!source?.includes(original)) return false
      sqlite.exec('DROP INDEX ' + ident(name))
      sqlite.exec(source.replace(original, replacement))
      return true
    },
    async beginTemporaryColumnDrop(name, column) {
      if (droppedColumnSnapshot) throw new Error('Another test schema mutation is active')
      const ddl = definition('table', name)
      if (!ddl || !columns(name).includes(column)) throw new Error('Unknown column')
      const attachedDdl = (sqlite.prepare(
        "SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL",
      ).all(name) as Array<{ sql: string }>).map(item => item.sql)
      const data = sqlite.prepare('SELECT * FROM ' + table(name)).all() as Record<string, unknown>[]
      sqlite.exec('ALTER TABLE ' + table(name) + ' DROP COLUMN ' + ident(column))
      droppedColumnSnapshot = { table: name, ddl, attachedDdl, data }
    },
    async rollbackTemporaryColumnDrop() {
      const snapshot = droppedColumnSnapshot
      if (!snapshot) throw new Error('No pending test schema mutation')
      sqlite.pragma('foreign_keys = OFF')
      try {
        sqlite.transaction(() => {
          sqlite.exec('DROP TABLE ' + table(snapshot.table))
          sqlite.exec(snapshot.ddl)
          for (const item of snapshot.data) {
            const keys = Object.keys(item)
            sqlite.prepare('INSERT INTO ' + table(snapshot.table) + ' (' + keys.map(ident).join(',') +
              ') VALUES (' + keys.map(() => '?').join(',') + ')').run(...Object.values(item).map(cell))
          }
          for (const ddl of snapshot.attachedDdl) sqlite.exec(ddl)
        })()
      } finally {
        sqlite.pragma('foreign_keys = ON')
        droppedColumnSnapshot = null
      }
    },
    async removeMigrationHistory() { sqlite.exec('DELETE FROM kysely_migration') },
    async appendMigration(hash, createdAt) {
      sqlite.prepare('INSERT INTO kysely_migration (name,timestamp) VALUES (?,?)')
        .run(hash, new Date(createdAt).toISOString())
    },
  }

  return {
    records,
    schema,
    auth: {
      async createUser(id, at = Date.now()) {
        sqlite.prepare('INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)')
          .run(id, 'Test Author', id + '@example.test', 1, at, at)
      },
      async accounts() {
        return sqlite.prepare('SELECT providerId, accessToken, refreshToken FROM account ORDER BY providerId')
          .all() as Array<{ providerId: string; accessToken: string | null; refreshToken: string | null }>
      },
      async userCount() { return (sqlite.prepare('SELECT COUNT(*) AS n FROM user').get() as { n: number }).n },
      async accountCount() { return (sqlite.prepare('SELECT COUNT(*) AS n FROM account').get() as { n: number }).n },
      async expireAccounts(providers, at) {
        const update = sqlite.prepare('UPDATE account SET accessTokenExpiresAt=? WHERE providerId=?')
        for (const provider of providers) update.run(at, provider)
      },
    },
    async foreignKeyViolations() { return sqlite.pragma('foreign_key_check') as unknown[] },
    async integrityHealthy() {
      return JSON.stringify(sqlite.pragma('integrity_check')) === '[{"integrity_check":"ok"}]'
    },
    close() { if (sqlite.open) sqlite.close() },
  }
}
