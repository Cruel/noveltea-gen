import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { sql } from 'kysely'
import {
  openStudioSchemaConnection,
  migrateStudioKysely,
  assertKyselyStudioSchemaCurrent,
  inspectStudioMigrationHistory,
  NO_MIGRATIONS,
  studioBaselineName,
  type StudioSchemaOptions,
} from '../src/db/kysely-migrations'
import {
  studioBoolean,
  studioJson,
  studioSafeInteger,
  studioTimestamp,
  storedStudioBoolean,
  storedStudioJson,
} from '../src/db/kysely-values'

const auth = {
  baseURL: 'http://localhost:3000',
  secret: 'studio-kysely-workflow-test-0123456789',
  github: { clientId: 'test', clientSecret: 'test' },
  gitlab: { clientId: 'test', clientSecret: 'test' },
}
const addon = '20261109010101_addon'
const addonFile = `
export async function up(db: any) {
  await db.schema.createTable('migration_probe').addColumn('id', 'integer', c => c.primaryKey()).execute()
  await db.schema.alterTable('repositories').addColumn('migration_tag', 'text').execute()
}
export async function down(db: any) {
  await db.schema.alterTable('repositories').dropColumn('migration_tag').execute()
  await db.schema.dropTable('migration_probe').execute()
}
`
const unedited = '20261109010103_unedited'
const uneditedFile = `
export async function up(db: any) {
  // up migration code goes here...
}
export async function down(db: any) {
  // down migration code goes here...
}
`

const irreversible = '20261109010102_irreversible'
const irreversibleFile = `
export async function up(db: any) {
  await db.schema.createTable('irreversible_probe').addColumn('id', 'integer', c => c.primaryKey()).execute()
}
`

async function withFixture(
  options: StudioSchemaOptions,
  filename: string,
  source: string,
  work: (connection: ReturnType<typeof openStudioSchemaConnection>, file: string) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), 'nt-kysely-migrations-'))
  const file = join(directory, filename + '.ts')
  writeFileSync(file, source)
  const connection = openStudioSchemaConnection(options, 'migrate', directory)
  try {
    await work(connection, file)
  } finally {
    await connection.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

async function selectedTables(connection: ReturnType<typeof openStudioSchemaConnection>) {
  const found = await connection.db.introspection.getTables()
  if (connection.backend === 'sqlite') return found
  const result = await sql<{ name: string }>`SELECT current_schema() AS name`.execute(connection.db)
  return found.filter((table) => table.schema === result.rows[0]?.name)
}

async function certifyTarget(options: StudioSchemaOptions) {
  await withFixture(options, addon, addonFile, async (connection, file) => {
    await migrateStudioKysely(connection, auth, 'latest')
    assert.equal(await inspectStudioMigrationHistory(connection), 2)
    await assertKyselyStudioSchemaCurrent(connection)
    assert.ok((await selectedTables(connection)).some((table) => table.name === 'migration_probe'))
    assert.ok(
      (await selectedTables(connection))
        .find((table) => table.name === 'repositories')
        ?.columns.some((column) => column.name === 'migration_tag'),
    )
    await migrateStudioKysely(connection, auth, studioBaselineName)
    assert.equal(await inspectStudioMigrationHistory(connection), 1)
    assert.ok(!(await selectedTables(connection)).some((table) => table.name === 'migration_probe'))
    assert.ok(
      !(await selectedTables(connection))
        .find((table) => table.name === 'repositories')
        ?.columns.some((column) => column.name === 'migration_tag'),
    )
    await migrateStudioKysely(connection, auth, addon)
    assert.equal(await inspectStudioMigrationHistory(connection), 2)
    await migrateStudioKysely(connection, auth, NO_MIGRATIONS)
    assert.equal(await inspectStudioMigrationHistory(connection), 0)
    assert.ok(!(await selectedTables(connection)).some((table) => table.name === 'repositories'))
    assert.ok((await selectedTables(connection)).some((table) => table.name === 'user'))
    await migrateStudioKysely(connection, auth, 'latest')
    assert.equal(await inspectStudioMigrationHistory(connection), 2)
    await assert.rejects(
      migrateStudioKysely(connection, auth, 'missing_target'),
      /Unknown Studio migration target/,
    )
    await sql
      .raw("INSERT INTO kysely_migration (name, timestamp) VALUES ('9999_future', '2099-01-01')")
      .execute(connection.db)
    await assert.rejects(inspectStudioMigrationHistory(connection), /newer application/)
    await sql.raw("DELETE FROM kysely_migration WHERE name = '9999_future'").execute(connection.db)
    // The exact historical migration source is mandatory; no silent adoption/repair.
    unlinkSync(file)
    await assert.rejects(inspectStudioMigrationHistory(connection), /newer application/)
    await assert.rejects(migrateStudioKysely(connection, auth, 'latest'), /newer application/)
  })
}

async function certifyUnedited(options: StudioSchemaOptions) {
  await withFixture(options, unedited, uneditedFile, async (connection) => {
    await assert.rejects(migrateStudioKysely(connection, auth), /unimplemented up/)
    // SQLite commits each successful migration before the later scaffold
    // fails; PostgreSQL rolls the entire transactional batch back.
    assert.equal(await inspectStudioMigrationHistory(connection), connection.backend === 'sqlite' ? 1 : 0)
  })
}

async function certifyIrreversible(options: StudioSchemaOptions) {
  await withFixture(options, irreversible, irreversibleFile, async (connection) => {
    await migrateStudioKysely(connection, auth)
    assert.equal(await inspectStudioMigrationHistory(connection), 2)
    await assert.rejects(migrateStudioKysely(connection, auth, studioBaselineName), /irreversible/)
    assert.equal(await inspectStudioMigrationHistory(connection), 2)
    assert.ok((await selectedTables(connection)).some((table) => table.name === 'irreversible_probe'))
  })
}

test('kysely-ctl scaffolds a file, never generates a schema diff or opens a developer database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-kysely-scaffold-'))
  const cwd = fileURLToPath(new URL('..', import.meta.url))
  try {
    const result = spawnSync('pnpm', ['migration:new', 'issue130example'], {
      cwd,
      env: { ...process.env, NT_KYSELY_SCAFFOLD_DIR: dir },
      encoding: 'utf8',
      timeout: 20_000,
    })
    assert.equal(result.status, 0, result.stderr + result.stdout)
    const files = readdirSync(dir).filter((file) => file.endsWith('.ts'))
    assert.equal(files.length, 1)
    assert.match(files[0]!, /^\d{14}_issue130example\.ts$/)
    assert.equal(existsSync(join(dir, files[0]!)), true)
    // Generated migration bodies must be implemented, not applied as empty no-ops.
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('canonical cross-dialect value converters reject unsafe implicit coercions', () => {
  assert.equal(studioSafeInteger('9007199254740991'), Number.MAX_SAFE_INTEGER)
  assert.equal(studioSafeInteger(42n), 42)
  assert.throws(() => studioSafeInteger('9007199254740992'), /safe integer/)
  assert.throws(() => studioSafeInteger(1.5), /safe integer/)
  assert.throws(() => studioSafeInteger('NaN'), /safe integer/)
  assert.equal(studioBoolean(1), true)
  assert.equal(studioBoolean(0), false)
  assert.throws(() => studioBoolean('1'), /boolean/)
  assert.equal(storedStudioBoolean(true), 1)
  assert.equal(storedStudioBoolean(false), 0)
  const data = { value: true, items: ['hello'] }
  assert.deepEqual(studioJson(storedStudioJson(data)), data)
  assert.throws(() => studioJson('broken'), /JSON/)
  assert.equal(studioTimestamp(new Date('2026-11-09T00:00:00Z')), '2026-11-09T00:00:00.000Z')
  assert.throws(() => studioTimestamp('yesterday'), /timestamp/)
})

test('SQLite: target-version rollback, reapply, missing source, future history', async () => {
  await certifyTarget({ backend: 'sqlite', path: ':memory:' })
})
test('SQLite: unedited scaffold cannot silently apply', async () => {
  await certifyUnedited({ backend: 'sqlite', path: ':memory:' })
})
test('SQLite: custom migration without down refuses rollback', async () => {
  await certifyIrreversible({ backend: 'sqlite', path: ':memory:' })
})

const postgres = process.env.NT_TEST_PG_URL
async function isolatedPostgres(work: (options: StudioSchemaOptions) => Promise<void>) {
  assert.ok(postgres, 'NT_TEST_PG_URL required')
  const database = new URL(postgres)
  assert.ok(['postgres:', 'postgresql:'].includes(database.protocol))
  assert.ok(database.hostname && database.pathname.length > 1)
  const schema = 'studio_workflow_' + randomUUID().replace(/-/g, '')
  const admin = new Pool({ connectionString: postgres })
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await work({
      backend: 'postgres',
      connection: { connectionString: postgres, options: `-c search_path=${schema}` },
    })
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin.end()
  }
}

test(
  'PostgreSQL: target-version rollback, reapply, missing source, future history',
  { skip: !postgres && 'Set NT_TEST_PG_URL for PostgreSQL schema tests' },
  async () => isolatedPostgres(certifyTarget),
)
test(
  'PostgreSQL: unedited scaffold cannot silently apply',
  { skip: !postgres && 'Set NT_TEST_PG_URL for PostgreSQL schema tests' },
  async () => isolatedPostgres(certifyUnedited),
)

test(
  'PostgreSQL: custom migration without down refuses rollback',
  { skip: !postgres && 'Set NT_TEST_PG_URL for PostgreSQL schema tests' },
  async () => isolatedPostgres(certifyIrreversible),
)
