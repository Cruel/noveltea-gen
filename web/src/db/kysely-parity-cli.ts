import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { sql } from 'kysely'
import { studioDdl } from './kysely-baseline'
import {
  openStudioSchemaConnection,
  migrateStudioKysely,
  assertKyselyStudioSchemaCurrent,
} from './kysely-migrations'
import {
  studioBoolean,
  storedStudioBoolean,
  studioJson,
  storedStudioJson,
  studioSafeInteger,
  studioTimestamp,
} from './kysely-values'

// Operates in its own uniquely named schema only. CI provides PostgreSQL;
// local developers may use any explicitly selected test instance or none.
const connectionString = process.env.NT_TEST_PG_URL
if (!connectionString) throw new Error('NT_TEST_PG_URL must explicitly select a PostgreSQL test database')
const parsed = new URL(connectionString)
if (
  !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
  !parsed.hostname ||
  parsed.pathname.length <= 1
)
  throw new Error('NT_TEST_PG_URL must be a PostgreSQL URL with an explicit database name')
const schema = 'studio_parity_' + randomUUID().replace(/-/g, '')
const admin = new Pool({ connectionString })
const config = {
  baseURL: 'http://localhost:3000',
  secret: 'kysely-parity-isolated-test-only-0123456789',
  github: { clientId: 'parity', clientSecret: 'parity' },
  gitlab: { clientId: 'parity', clientSecret: 'parity' },
}
try {
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const sqlite = openStudioSchemaConnection({ backend: 'sqlite', path: ':memory:' })
  const postgres = openStudioSchemaConnection({
    backend: 'postgres',
    connection: { connectionString, options: `-c search_path=${schema}` },
  })
  try {
    for (const connection of [sqlite, postgres]) {
      await migrateStudioKysely(connection, config)
      await assertKyselyStudioSchemaCurrent(connection)
    }
    const expected = new Set(studioDdl().tables.keys())
    const excluded = new Set([
      'user',
      'session',
      'account',
      'verification',
      'rateLimit',
      'kysely_migration',
      'kysely_migration_lock',
      'studio_migration_sources',
      'sqlite_sequence',
    ])
    const profiles = await Promise.all(
      [sqlite, postgres].map(async (connection) => {
        const tables = (await connection.db.introspection.getTables()).filter(
          (table) =>
            !excluded.has(table.name) && (connection.backend === 'sqlite' || table.schema === schema),
        )
        const names = new Set(tables.map((table) => table.name))
        for (const name of expected)
          assert.ok(names.has(name), `${connection.backend} missing application table: ${name}`)
        // Any additional authored table must also appear on the other backend:
        // profiles compare the entire non-auth/non-journal inventory below.
        return tables
          .map((table) => ({
            table: table.name,
            columns: table.columns
              .map((column) => ({
                name: column.name,
                kind: /int/i.test(column.dataType) ? 'integer' : 'text',
                nullable: column.isNullable,
                generated: column.isAutoIncrementing,
                defaulted: column.hasDefaultValue,
              }))
              .sort((a, b) => a.name.localeCompare(b.name)),
          }))
          .sort((a, b) => a.table.localeCompare(b.table))
      }),
    )
    assert.deepEqual(
      profiles[1],
      profiles[0],
      'SQLite/PostgreSQL application columns must have matching logical type, default, identity and nullability',
    )
    for (const connection of [sqlite, postgres]) {
      const row = await sql<{ flag: number; payload: string; timestamp: string; bigCount: number | string }>`
        SELECT 1 AS flag,
          '{"hello":true,"items":[1,2]}' AS payload,
          '2026-11-09T00:00:00.000Z' AS timestamp,
          CAST(42 AS BIGINT) AS big_count
      `.execute(connection.db)
      const value = row.rows[0]!
      assert.equal(studioBoolean(value.flag), true)
      assert.equal(storedStudioBoolean(false), 0)
      assert.deepEqual(studioJson(value.payload), { hello: true, items: [1, 2] })
      assert.equal(storedStudioJson({ hello: true, items: [1, 2] }), value.payload)
      assert.equal(studioTimestamp(value.timestamp), '2026-11-09T00:00:00.000Z')
      assert.equal(studioSafeInteger(value.bigCount), 42)
    }
    console.log('Kysely SQLite/PostgreSQL schema and runtime value parity verified (disposable databases).')
  } finally {
    await postgres.close()
    await sqlite.close()
  }
} finally {
  try {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  } finally {
    await admin.end()
  }
}
