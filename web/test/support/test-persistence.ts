/** Backend-independent test data and inspection port. Production behavior is
 * exercised through StudioStore.persistence; this extra port exists only for
 * deterministic fixtures, fault injection and persistence contract tests.
 * Its Promise semantics match a remote PostgreSQL implementation.
 */
export type TestFields = Record<string, unknown>
export type TestRecordSort = { by: string; direction?: 'asc' | 'desc' }

export interface TestPersistence {
  records: {
    insert(table: string, row: TestFields): Promise<void>
    update(table: string, filter: TestFields, changes: TestFields): Promise<number>
    delete(table: string, filter: TestFields): Promise<number>
    all<T extends TestFields = TestFields>(table: string, filter?: TestFields, sort?: TestRecordSort): Promise<T[]>
    first<T extends TestFields = TestFields>(table: string, filter?: TestFields): Promise<T | undefined>
    count(table: string, filter?: TestFields): Promise<number>
  }
  auth: {
    createUser(id: string, at?: number): Promise<void>
    accounts(): Promise<Array<{ providerId: string; accessToken: string | null; refreshToken: string | null }>>
    userCount(): Promise<number>
    accountCount(): Promise<number>
    expireAccounts(providers: string[], at: number): Promise<void>
  }
  foreignKeyViolations(): Promise<unknown[]>
  integrityHealthy(): Promise<boolean>
  schema: {
    tables(): Promise<string[]>
    columns(table: string): Promise<string[]>
    hasMigrationJournal(): Promise<boolean>
    migrationHistory(): Promise<Array<{ hash: string; createdAt: number }>>
    hasTable(name: string): Promise<boolean>
    createLegacyJournal(version: number): Promise<void>
    legacyVersion(): Promise<number | undefined>
    tamperMigrationHash(hash: string): Promise<void>
    dropIndex(index: string): Promise<void>
    dropTable(table: string): Promise<void>
    definition(type: 'table' | 'index', name: string): Promise<string | undefined>
    replaceTableFragment(table: string, original: string, replacement: string): Promise<boolean>
    replaceIndexFragment(index: string, original: string, replacement: string): Promise<boolean>
    beginTemporaryColumnDrop(table: string, column: string): Promise<void>
    rollbackTemporaryColumnDrop(): Promise<void>
    removeMigrationHistory(): Promise<void>
    appendMigration(hash: string, createdAt: number): Promise<void>
  }
}
