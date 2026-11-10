import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { sql } from 'kysely'
import {
  openStudioSchemaConnection, migrateStudioKysely, assertKyselyStudioSchemaCurrent,
} from '../src/db/kysely-migrations'
import { postgresColumnType } from '../src/db/kysely-baseline'

const authConfig = {
  baseURL: 'http://localhost:3000',
  secret: 'schema-hardening-proof-secret-0123456789012345',
  github: { clientId: 'test', clientSecret: 'test' },
  gitlab: { clientId: 'test', clientSecret: 'test' },
}
const pgUrl = process.env.NT_TEST_PG_URL
if (!pgUrl && process.env.NT_REQUIRE_KYSELY_PROOF === '1')
  throw new Error('NT_TEST_PG_URL is required for PostgreSQL schema-hardening certification')

test('SQLite readiness rejects unexpected application-owned triggers, indexes and tables, not Better Auth objects', async () => {
  const conn = openStudioSchemaConnection({ backend: 'sqlite', path: ':memory:' })
  try {
    await migrateStudioKysely(conn, authConfig)
    await assertKyselyStudioSchemaCurrent(conn)
    await sql.raw(`CREATE TRIGGER unexpected_collection_abort
      BEFORE INSERT ON story_collections BEGIN SELECT RAISE(ABORT, 'blocked'); END`).execute(conn.db)
    await assert.rejects(assertKyselyStudioSchemaCurrent(conn),
      /unexpected schema definition drift \(trigger:unexpected_collection_abort\)/)
    await sql.raw('DROP TRIGGER unexpected_collection_abort').execute(conn.db)
    await assertKyselyStudioSchemaCurrent(conn)
    await sql.raw('CREATE INDEX unexpected_collection_index ON story_collections (name)').execute(conn.db)
    await assert.rejects(assertKyselyStudioSchemaCurrent(conn),
      /unexpected schema definition drift \(index:unexpected_collection_index\)/)
    await sql.raw('DROP INDEX unexpected_collection_index').execute(conn.db)
    await sql.raw('CREATE TABLE unexpected_studio_table (id text PRIMARY KEY)').execute(conn.db)
    await assert.rejects(assertKyselyStudioSchemaCurrent(conn),
      /unexpected schema definition drift \(table:unexpected_studio_table\)/)
  } finally {
    await conn.close()
  }
})

test('PostgreSQL baseline preserves epoch-millisecond widths but leaves counters as integer', {
  skip: !pgUrl && 'Set NT_TEST_PG_URL for PostgreSQL schema-hardening tests',
}, async () => {
  assert.equal(postgresColumnType('git_connections', 'access_expires_at', 'INTEGER'), 'bigint')
  assert.equal(postgresColumnType('git_connections', 'revision', 'INTEGER'), 'integer')
  assert.equal(postgresColumnType('github_install_flows', 'created_at', 'INTEGER'), 'bigint')
})

test('PostgreSQL readiness requires validated ownership FKs and case-exact CHECK/index literals', {
  skip: !pgUrl && 'Set NT_TEST_PG_URL for PostgreSQL schema-hardening tests',
  timeout: 60_000,
}, async () => {
  const schema = 'studio_harden_' + randomUUID().replace(/-/g, '')
  const admin = new Pool({ connectionString: pgUrl })
  let created = false
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    created = true
    const conn = openStudioSchemaConnection({
      backend: 'postgres', connection: { connectionString: pgUrl, options: `-c search_path=${schema}` },
    })
    try {
      await migrateStudioKysely(conn, authConfig)
      await assertKyselyStudioSchemaCurrent(conn)
      const expectedBigints = new Map<string, string[]>([
        ['git_connection_flows', ['expires_at']],
        ['git_connections', ['refresh_lease_until', 'access_expires_at', 'refresh_expires_at']],
        ['github_install_flows', ['created_at', 'expires_at']],
      ])
      const columns = await sql<{ tableName: string; columnName: string; dataType: string }>`
        SELECT table_name AS "tableName", column_name AS "columnName", data_type AS "dataType"
        FROM information_schema.columns WHERE table_schema=current_schema()
      `.execute(conn.db)
      for (const [table, names] of expectedBigints) for (const name of names)
        assert.equal(columns.rows.find(row => row.tableName === table && row.columnName === name)?.dataType,
          'bigint', `${table}.${name}`)
      assert.equal(columns.rows.find(row =>
        row.tableName === 'git_connections' && row.columnName === 'revision')?.dataType,
      'integer')

      const foreignKey = await sql<{ name: string; definition: string }>`
        SELECT c.conname AS name, pg_get_constraintdef(c.oid) AS definition
        FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
        JOIN pg_namespace n ON n.oid=t.relnamespace
        WHERE n.nspname=current_schema() AND t.relname='stories' AND c.contype='f'
          AND pg_get_constraintdef(c.oid) LIKE '%repository_id%'
        LIMIT 1
      `.execute(conn.db)
      assert.equal(foreignKey.rows.length, 1)
      const fk = foreignKey.rows[0]!
      const fkName = '"' + fk.name.replaceAll('"', '""') + '"'
      await sql.raw(`ALTER TABLE stories DROP CONSTRAINT ${fkName}`).execute(conn.db)
      await sql.raw(`ALTER TABLE stories ADD CONSTRAINT ${fkName} ${fk.definition} NOT VALID`).execute(conn.db)
      await assert.rejects(assertKyselyStudioSchemaCurrent(conn), /foreign-key drift/)
      await sql.raw(`ALTER TABLE stories VALIDATE CONSTRAINT ${fkName}`).execute(conn.db)
      await assertKyselyStudioSchemaCurrent(conn)

      const providerCheck = await sql<{ definition: string }>`
        SELECT pg_get_constraintdef(c.oid) AS definition
        FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
        JOIN pg_namespace n ON n.oid=t.relnamespace
        WHERE n.nspname=current_schema() AND t.relname='repositories'
          AND c.conname='repositories_provider_check'
      `.execute(conn.db)
      assert.equal(providerCheck.rows.length, 1)
      await sql.raw('ALTER TABLE repositories DROP CONSTRAINT repositories_provider_check').execute(conn.db)
      await sql.raw('ALTER TABLE repositories ADD CONSTRAINT repositories_provider_check ' +
        providerCheck.rows[0]!.definition + ' NOT VALID').execute(conn.db)
      await assert.rejects(assertKyselyStudioSchemaCurrent(conn), /CHECK constraint drift/)
      await sql.raw('ALTER TABLE repositories VALIDATE CONSTRAINT repositories_provider_check').execute(conn.db)
      await assertKyselyStudioSchemaCurrent(conn)
      await sql.raw('ALTER TABLE repositories DROP CONSTRAINT repositories_provider_check').execute(conn.db)
      await sql.raw(`ALTER TABLE repositories ADD CONSTRAINT repositories_provider_check
        CHECK (provider IN ('GITHUB','GITLAB'))`).execute(conn.db)
      await assert.rejects(assertKyselyStudioSchemaCurrent(conn), /CHECK constraint drift/)
      await sql.raw('ALTER TABLE repositories DROP CONSTRAINT repositories_provider_check').execute(conn.db)
      await sql.raw('ALTER TABLE repositories ADD CONSTRAINT repositories_provider_check ' +
        providerCheck.rows[0]!.definition).execute(conn.db)
      await assertKyselyStudioSchemaCurrent(conn)

      const originalIndex = await sql<{ definition: string }>`
        SELECT indexdef AS definition FROM pg_indexes
        WHERE schemaname=current_schema() AND indexname='story_thread_messages_one_preparing'
      `.execute(conn.db)
      assert.equal(originalIndex.rows.length, 1)
      await sql.raw('DROP INDEX story_thread_messages_one_preparing').execute(conn.db)
      await sql.raw(`CREATE UNIQUE INDEX story_thread_messages_one_preparing
        ON story_thread_messages (thread_id) WHERE role='USER' AND phase='preparing'`).execute(conn.db)
      await assert.rejects(assertKyselyStudioSchemaCurrent(conn), /partial index drift/)
      await sql.raw('DROP INDEX story_thread_messages_one_preparing').execute(conn.db)
      await sql.raw(originalIndex.rows[0]!.definition).execute(conn.db)
      await assertKyselyStudioSchemaCurrent(conn)
    } finally {
      await conn.close()
    }
  } finally {
    try {
      if (created) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    } finally { await admin.end() }
  }
})

test('PostgreSQL introspector never observes another disposable schema during teardown', {
  skip: !pgUrl && 'Set NT_TEST_PG_URL for PostgreSQL schema-hardening tests',
  timeout: 60_000,
}, async () => {
  const own = 'studio_scope_' + randomUUID().replace(/-/g, '')
  const noisy = 'studio_noisy_' + randomUUID().replace(/-/g, '')
  const admin = new Pool({ connectionString: pgUrl })
  let ownCreated = false, noisyCreated = false
  try {
    await admin.query(`CREATE SCHEMA "${own}"`)
    ownCreated = true
    await admin.query(`CREATE SCHEMA "${noisy}"`)
    noisyCreated = true
    await admin.query(`CREATE TABLE "${noisy}"."foreign_fixture" (id integer)`)
    const conn = openStudioSchemaConnection({
      backend: 'postgres', connection: { connectionString: pgUrl, options: `-c search_path=${own}` },
    })
    try {
      await migrateStudioKysely(conn, authConfig)
      const first = await conn.db.introspection.getTables({ withInternalKyselyTables: true })
      assert.ok(first.some(row => row.name === 'repositories'))
      assert.ok(first.some(row => row.name === 'kysely_migration'))
      assert.ok(first.every(row => row.schema === own))
      const checks = Array.from({ length: 16 }, () =>
        conn.db.introspection.getTables().then(rows => {
          assert.ok(rows.some(row => row.name === 'repositories'))
          assert.ok(rows.every(row => row.schema === own))
        }))
      await Promise.all([
        ...checks,
        admin.query(`DROP SCHEMA "${noisy}" CASCADE`),
      ])
      noisyCreated = false
      await assertKyselyStudioSchemaCurrent(conn)
    } finally { await conn.close() }
  } finally {
    try {
      if (ownCreated) await admin.query(`DROP SCHEMA IF EXISTS "${own}" CASCADE`)
      if (noisyCreated) await admin.query(`DROP SCHEMA IF EXISTS "${noisy}" CASCADE`)
    } finally { await admin.end() }
  }
})
