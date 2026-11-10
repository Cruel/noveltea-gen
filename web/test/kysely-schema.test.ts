import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql } from 'kysely'
import { betterAuth } from 'better-auth'
import {
  openStudioSchemaConnection,
  inspectStudioMigrationHistory,
  migrateStudioKysely,
  assertKyselyStudioSchemaCurrent,
  studioMigrationNames,
  type StudioSchemaOptions,
} from '../src/db/kysely-migrations'
import { studioAuthOptionsForDatabase } from '../src/lib/auth'

const config = {
  baseURL: 'http://localhost:3000',
  secret: 'kysely-schema-certification-test-secret-0123456789',
  github: { clientId: 'test', clientSecret: 'test-secret' },
  gitlab: { clientId: 'test', clientSecret: 'test-secret' },
}

async function selectedTables(connection: ReturnType<typeof openStudioSchemaConnection>) {
  const tables = await connection.db.introspection.getTables()
  if (connection.backend === 'sqlite') return tables
  const result = await sql<{ schema: string }>`SELECT current_schema() AS schema`.execute(connection.db)
  return tables.filter((table) => table.schema === result.rows[0]?.schema)
}

async function assertNativeGitForeignKeys(connection: ReturnType<typeof openStudioSchemaConnection>) {
  if (connection.backend === 'postgres') {
    const constraints = await sql<{ conname: string; definition: string }>`
      SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = current_schema() AND c.contype = 'f'
        AND c.conname IN ('repositories_connection_owner_provider_fk', 'github_install_connection_owner_provider_fk')
    `.execute(connection.db)
    assert.equal(constraints.rows.length, 2, 'Git associations must use native composite PG foreign keys')
    for (const constraint of constraints.rows) {
      assert.match(constraint.definition, /FOREIGN KEY \(connection_id, owner_user_id, provider\)/i)
      assert.match(constraint.definition, /REFERENCES git_connections\(id, owner_user_id, provider\)/i)
    }
  } else {
    for (const table of ['repositories', 'github_install_flows']) {
      const fks = await sql<{
        id: number
        seq: number
        from: string
        to: string
        table: string
        onDelete: string
      }>`${sql.raw(`PRAGMA foreign_key_list("${table}")`)}`.execute(connection.db)
      const grouped = new Map<number, typeof fks.rows>()
      for (const fk of fks.rows) grouped.set(fk.id, [...(grouped.get(fk.id) ?? []), fk])
      assert.ok(
        [...grouped.values()].some(
          (group) =>
            group.length === 3 &&
            group.every(
              (fk) => fk.table === 'git_connections' && fk.onDelete.toUpperCase() === 'NO ACTION',
            ) &&
            group
              .sort((a, b) => a.seq - b.seq)
              .map((fk) => fk.from)
              .join(',') === 'connection_id,owner_user_id,provider' &&
            group.map((fk) => fk.to).join(',') === 'id,owner_user_id,provider',
        ),
        `${table} must declare a native composite SQLite foreign key`,
      )
    }
  }
}

async function certify(options: StudioSchemaOptions) {
  const connection = openStudioSchemaConnection(options)
  try {
    assert.equal(await inspectStudioMigrationHistory(connection), 0)
    await assert.rejects(assertKyselyStudioSchemaCurrent(connection), /migrations are pending/)
    const before = await selectedTables(connection)
    assert.equal(
      before.some((table) => table.name === 'user'),
      false,
      'readiness must be read-only, including Better Auth',
    )
    await migrateStudioKysely(connection, config)
    await migrateStudioKysely(connection, config)
    await assertNativeGitForeignKeys(connection)
    assert.equal(await inspectStudioMigrationHistory(connection), studioMigrationNames().length)
    await assertKyselyStudioSchemaCurrent(connection)
    const readOnly = openStudioSchemaConnection(options, 'read')
    try {
      await assertKyselyStudioSchemaCurrent(readOnly)
      await assert.rejects(
        sql.raw('CREATE TABLE forbidden_write (id integer)').execute(readOnly.db),
        /readonly|read-only|cannot execute/i,
      )
    } finally {
      await readOnly.close()
    }

    const tables = await selectedTables(connection)
    for (const name of [
      'user',
      'account',
      'session',
      'verification',
      'rateLimit',
      'repositories',
      'stories',
      'story_threads',
      'story_turn_executions',
      'thread_live_inputs',
      'thread_steering_intents',
    ]) {
      assert.ok(
        tables.some((table) => table.name === name),
        'missing ' + name,
      )
    }
    const auth = betterAuth(studioAuthOptionsForDatabase(connection.authDatabase, config))
    const context = await auth.$context
    const alice = await context.internalAdapter.createUser(
      {
        name: 'Alice',
        email: 'alice@kysely.test',
        emailVerified: true,
      },
      { method: 'test' },
    )
    const bob = await context.internalAdapter.createUser(
      {
        name: 'Bob',
        email: 'bob@kysely.test',
        emailVerified: true,
      },
      { method: 'test' },
    )
    const timestamp = '2026-11-09T00:00:00Z'
    await connection.db
      .insertInto('repositories')
      .values({
        id: 'repo',
        ownerUserId: alice.id,
        provider: 'github',
        providerRepositoryId: '123',
        name: 'Alice Repo',
        createdAt: timestamp,
      })
      .execute()
    await connection.db
      .insertInto('stories')
      .values({
        id: 'story',
        ownerUserId: alice.id,
        repositoryId: 'repo',
        directory: 'story',
        title: 'Story',
        createdAt: timestamp,
      })
      .execute()
    await assert.rejects(
      connection.db
        .insertInto('stories')
        .values({
          id: 'cross-owner',
          ownerUserId: bob.id,
          repositoryId: 'repo',
          directory: 'cross',
          title: 'Bad',
          createdAt: timestamp,
        })
        .execute(),
      /foreign key|constraint/i,
    )
    await assert.rejects(
      connection.db
        .insertInto('repositories')
        .values({
          id: 'invalid',
          ownerUserId: alice.id,
          provider: 'invalid',
          providerRepositoryId: '456',
          name: 'Bad',
          createdAt: timestamp,
        })
        .execute(),
      /check|constraint/i,
    )
    await connection.db
      .insertInto('studioSessions')
      .values({
        id: 'job',
        ownerUserId: alice.id,
        storyId: 'story',
        title: 'Run',
        status: 'running',
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .execute()
    await connection.db
      .insertInto('storyThreads')
      .values({
        id: 'thread',
        ownerUserId: alice.id,
        storyId: 'story',
        title: 'Thread',
        activityAt: timestamp,
        createdAt: timestamp,
      })
      .execute()
    await connection.db
      .insertInto('stories')
      .values({
        id: 'second-story',
        ownerUserId: alice.id,
        repositoryId: 'repo',
        directory: 'second',
        title: 'Second',
        createdAt: timestamp,
      })
      .execute()
    await connection.db
      .insertInto('storyThreads')
      .values({
        id: 'second-thread',
        ownerUserId: alice.id,
        storyId: 'second-story',
        title: 'Second Thread',
        activityAt: timestamp,
        createdAt: timestamp,
      })
      .execute()
    // Cross-Story Thread run rejection is enforced by the trigger, not
    // merely by FK existence. PostgreSQL must port this exact invariant.
    await assert.rejects(
      connection.db
        .insertInto('storyThreadRuns')
        .values({
          jobId: 'job',
          ownerUserId: alice.id,
          threadId: 'second-thread',
          runOrder: 0,
        })
        .execute(),
      /same owned story/i,
    )
    await connection.db
      .insertInto('storyThreadRuns')
      .values({
        jobId: 'job',
        ownerUserId: alice.id,
        threadId: 'thread',
        runOrder: 0,
      })
      .execute()
    await connection.db
      .insertInto('storyThreadMessages')
      .values({
        id: 'queued',
        ownerUserId: alice.id,
        threadId: 'thread',
        sequence: 1,
        role: 'user',
        status: 'queued',
        body: 'Hello',
        phase: 'preparing',
        jobId: 'job',
        createdAt: timestamp,
      })
      .execute()
    assert.equal((await connection.db.selectFrom('storyTurns').select('id').execute()).length, 1)
    assert.equal((await connection.db.selectFrom('storyTurnExecutions').select('turnId').execute()).length, 1)
    await assert.rejects(
      connection.db
        .insertInto('storyThreadMessages')
        .values({
          id: 'second-preparing',
          ownerUserId: alice.id,
          threadId: 'thread',
          sequence: 2,
          role: 'user',
          status: 'queued',
          body: 'Duplicate preparing',
          phase: 'preparing',
          createdAt: timestamp,
        })
        .execute(),
      /unique|constraint/i,
    )
    await connection.db
      .insertInto('storyThreadMessages')
      .values({
        id: 'followup',
        ownerUserId: alice.id,
        threadId: 'thread',
        sequence: 2,
        role: 'user',
        status: 'queued',
        body: 'Follow-up',
        phase: 'queued',
        createdAt: timestamp,
      })
      .execute()
    await connection.db
      .insertInto('threadLiveInputs')
      .values({
        messageId: 'followup',
        ownerUserId: alice.id,
        threadId: 'thread',
        sourceJobId: 'job',
        mode: 'follow-up',
        state: 'pending',
        createdAt: timestamp,
      })
      .execute()
    assert.equal(
      (
        await connection.db
          .selectFrom('storyTurnExecutions')
          .select('turnId')
          .where('turnId', '=', 'followup')
          .execute()
      ).length,
      0,
      'queued follow-ups cannot inherit the active execution',
    )
    await connection.db
      .insertInto('storyThreadMessages')
      .values({
        id: 'steer',
        ownerUserId: alice.id,
        threadId: 'thread',
        sequence: 3,
        role: 'user',
        status: 'queued',
        body: 'Steer',
        phase: 'queued',
        createdAt: timestamp,
      })
      .execute()
    await connection.db
      .insertInto('threadLiveInputs')
      .values({
        messageId: 'steer',
        ownerUserId: alice.id,
        threadId: 'thread',
        sourceJobId: 'job',
        mode: 'steer',
        state: 'pending',
        createdAt: timestamp,
      })
      .execute()
    assert.equal(
      (
        await connection.db
          .selectFrom('storyTurnExecutions')
          .select('turnId')
          .where('turnId', '=', 'steer')
          .execute()
      ).length,
      1,
    )
    const firstEdit = await connection.db
      .insertInto('threadQueuedMessageEdits')
      .values({
        requestId: 'edit-1',
        messageId: 'queued',
        ownerUserId: alice.id,
        threadId: 'thread',
        oldBody: 'Hello',
        newBody: 'Hello again',
        editedAt: timestamp,
      })
      .returning('sequence')
      .executeTakeFirstOrThrow()
    const secondEdit = await connection.db
      .insertInto('threadQueuedMessageEdits')
      .values({
        requestId: 'edit-2',
        messageId: 'queued',
        ownerUserId: alice.id,
        threadId: 'thread',
        oldBody: 'Hello again',
        newBody: 'Hello again!',
        editedAt: timestamp,
      })
      .returning('sequence')
      .executeTakeFirstOrThrow()
    assert.ok(
      secondEdit.sequence > firstEdit.sequence,
      'queued edit first/last order requires generated sequence, not rowid/timestamp',
    )
    await assert.rejects(
      connection.db
        .insertInto('threadQueuedMessageEdits')
        .values({
          requestId: 'edit-1',
          messageId: 'queued',
          ownerUserId: alice.id,
          threadId: 'thread',
          oldBody: 'Hello',
          newBody: 'Duplicate',
          editedAt: timestamp,
        })
        .execute(),
      /unique|constraint/i,
    )

    const firstLink = await connection.db
      .insertInto('threadSteeringCheckpointLinks')
      .values({
        messageId: 'steer',
        ownerUserId: alice.id,
        threadId: 'thread',
        sourceJobId: 'job',
        checkpointSha: 'a'.repeat(40),
        proofDigest: 'proof',
        workItem: 'work',
        association: 'considered',
        recordedAt: timestamp,
      })
      .returning('sequence')
      .executeTakeFirstOrThrow()
    const secondLink = await connection.db
      .insertInto('threadSteeringCheckpointLinks')
      .values({
        messageId: 'steer',
        ownerUserId: alice.id,
        threadId: 'thread',
        sourceJobId: 'job',
        checkpointSha: 'b'.repeat(40),
        proofDigest: 'proof',
        workItem: 'work',
        association: 'verified-influence',
        recordedAt: timestamp,
      })
      .returning('sequence')
      .executeTakeFirstOrThrow()
    assert.ok(
      secondLink.sequence > firstLink.sequence,
      'checkpoint influence latest order requires generated sequence',
    )
    await assert.rejects(
      connection.db
        .insertInto('threadSteeringCheckpointLinks')
        .values({
          messageId: 'steer',
          ownerUserId: alice.id,
          threadId: 'thread',
          sourceJobId: 'job',
          checkpointSha: 'a'.repeat(40),
          proofDigest: 'proof',
          workItem: 'work',
          association: 'considered',
          recordedAt: timestamp,
        })
        .execute(),
      /unique|constraint/i,
    )

    await assert.rejects(
      connection.db
        .updateTable('storyThreads')
        .set({ parentThreadId: 'second-thread' })
        .where('id', '=', 'thread')
        .execute(),
      /immutable/i,
    )
    const event1 = await connection.db
      .insertInto('generationEvents')
      .values({
        jobId: 'job',
        ownerUserId: alice.id,
        kind: 'started',
        createdAt: timestamp,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const event2 = await connection.db
      .insertInto('generationEvents')
      .values({
        jobId: 'job',
        ownerUserId: alice.id,
        kind: 'working',
        createdAt: timestamp,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    assert.ok(event2.id > event1.id, 'generated event identity must preserve insertion order')
    const queuedRun = await connection.db
      .insertInto('generationRunQueue')
      .values({
        jobId: 'job',
        ownerUserId: alice.id,
        intent: 'start',
        phase: 'queued',
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning('sequence')
      .executeTakeFirstOrThrow()
    assert.ok(queuedRun.sequence > 0, 'queue sequence must be database-generated')
    await assertKyselyStudioSchemaCurrent(connection)
    await connection.db.deleteFrom('repositories').where('id', '=', 'repo').execute()
    assert.equal(
      (await connection.db.selectFrom('storyThreads').select('id').execute()).length,
      0,
      'owned Story and Thread cascades are preserved',
    )
    await migrateStudioKysely(connection, config, 'down')
    assert.equal(await inspectStudioMigrationHistory(connection), 2,
      'first rollback removes only the trusted-catalog view')
    await assert.rejects(assertKyselyStudioSchemaCurrent(connection), /migrations are pending/)
    await migrateStudioKysely(connection, config, 'down')
    assert.equal(await inspectStudioMigrationHistory(connection), 1,
      'second rollback reverses only the Git binding migration')
    await migrateStudioKysely(connection, config, 'down')
    assert.equal(await inspectStudioMigrationHistory(connection), 0)
    assert.ok(!(await selectedTables(connection)).some((row) => row.name === 'repositories'))
    assert.ok(
      (await selectedTables(connection)).some((row) => row.name === 'user'),
      'Kysely rollback must not drop Better Auth tables',
    )
    await migrateStudioKysely(connection, config)
    await assertKyselyStudioSchemaCurrent(connection)

    if (connection.backend === 'postgres') {
      // Keep the CHECK constraint name and index name intact while replacing
      // their semantics; the reader must detect more than missing names.
      await sql
        .raw('ALTER TABLE repositories DROP CONSTRAINT repositories_provider_check')
        .execute(connection.db)
      await sql
        .raw(
          "ALTER TABLE repositories ADD CONSTRAINT repositories_provider_check CHECK (provider IN ('github'))",
        )
        .execute(connection.db)
      await assert.rejects(assertKyselyStudioSchemaCurrent(connection), /CHECK constraint drift/i)
      await sql
        .raw('ALTER TABLE repositories DROP CONSTRAINT repositories_provider_check')
        .execute(connection.db)
      await sql
        .raw(
          "ALTER TABLE repositories ADD CONSTRAINT repositories_provider_check CHECK (provider IN ('github', 'gitlab'))",
        )
        .execute(connection.db)
      await assertKyselyStudioSchemaCurrent(connection)
      await sql.raw('DROP INDEX "story_thread_messages_one_preparing"').execute(connection.db)
      await sql
        .raw(
          "CREATE UNIQUE INDEX story_thread_messages_one_preparing ON story_thread_messages(thread_id) WHERE role='user' AND phase='queued'",
        )
        .execute(connection.db)
      await assert.rejects(assertKyselyStudioSchemaCurrent(connection), /partial index drift/i)
    } else {
      await sql.raw('DROP INDEX "story_thread_messages_one_preparing"').execute(connection.db)
    }
    await assert.rejects(assertKyselyStudioSchemaCurrent(connection), /index|schema definition drift/i)
  } finally {
    await connection.close()
  }
}

test('Kysely SQLite baseline: independent auth, parity, checks, idempotency, rollback and drift', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nt-kysely-studio-'))
  try {
    await certify({ backend: 'sqlite', path: join(directory, 'fresh.sqlite') })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('legacy Drizzle application tables are never silently adopted by Kysely', async () => {
  const connection = openStudioSchemaConnection({ backend: 'sqlite', path: ':memory:' })
  try {
    await sql.raw('CREATE TABLE repositories (id text PRIMARY KEY)').execute(connection.db)
    await assert.rejects(migrateStudioKysely(connection, config), /Untracked Studio/)
    const tables = await connection.db.introspection.getTables()
    assert.ok(tables.some((table) => table.name === 'repositories'))
    assert.ok(!tables.some((table) => table.name === 'user'))
    assert.ok(!tables.some((table) => table.name === 'kysely_migration'))
  } finally {
    await connection.close()
  }
})

test('readiness rejects future and incompatible Kysely histories without auto-repair', async () => {
  for (const mismatch of ['unknown', 'newer'] as const) {
    const connection = openStudioSchemaConnection({ backend: 'sqlite', path: ':memory:' })
    try {
      await migrateStudioKysely(connection, config)
      if (mismatch === 'unknown') {
        await sql
          .raw("UPDATE kysely_migration SET name = '0000_unknown' WHERE name = '0000_studio_baseline'")
          .execute(connection.db)
      } else {
        await sql
          .raw("INSERT INTO kysely_migration (name, timestamp) VALUES ('9999_future', '2099-01-01')")
          .execute(connection.db)
      }
      await assert.rejects(assertKyselyStudioSchemaCurrent(connection), /incompatible|newer application/)
      await assert.rejects(migrateStudioKysely(connection, config), /incompatible|newer application/)
      assert.ok(
        (await connection.db.introspection.getTables()).some((table) => table.name === 'repositories'),
      )
    } finally {
      await connection.close()
    }
  }
})

test('Kysely CLI up/down/check operates on isolated SQLite without changing the legacy path', () => {
  const directory = mkdtempSync(join(tmpdir(), 'nt-kysely-cli-'))
  const database = join(directory, 'kysely.sqlite')
  const env = {
    ...process.env,
    NT_STUDIO_DB_BACKEND: 'sqlite',
    NT_STUDIO_DB_PATH: database,
    BETTER_AUTH_URL: config.baseURL,
    BETTER_AUTH_SECRET: config.secret,
    GITHUB_CLIENT_ID: config.github.clientId,
    GITHUB_CLIENT_SECRET: config.github.clientSecret,
    GITLAB_CLIENT_ID: config.gitlab.clientId,
    GITLAB_CLIENT_SECRET: config.gitlab.clientSecret,
  }
  const cwd = fileURLToPath(new URL('..', import.meta.url))
  const invoke = (...commands: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'src/db/kysely-migrate-cli.ts', ...commands], {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 20_000,
    })
  try {
    const pending = invoke('check')
    assert.notEqual(pending.status, 0)
    assert.match(pending.stderr, /database is absent/)
    assert.equal(existsSync(database), false, 'a read-only check must not create the selected database')
    for (const action of ['up', 'up', 'check', 'down', 'up', 'check']) {
      const result = invoke(action)
      assert.equal(result.status, 0, `Kysely CLI ${action}: ${result.stderr}`)
      assert.match(result.stdout, /Kysely migration|Kysely schema is current/)
    }
    for (const target of ['baseline', 'none', '0000_studio_baseline', 'latest']) {
      const result = invoke('to', target)
      assert.equal(result.status, 0, `Kysely CLI to ${target}: ${result.stderr}`)
    }
    assert.equal(invoke('check').status, 0)
    const unknown = invoke('to', 'unrecognized_version')
    assert.notEqual(unknown.status, 0)
    assert.match(unknown.stderr, /Unknown Studio migration target/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test(
  'PostgreSQL readiness rejects unexpected indexes, constraints and triggers',
  {
    skip: !process.env.NT_TEST_PG_URL && 'Set NT_TEST_PG_URL for PostgreSQL schema tests',
  },
  async () => {
    const connectionString = process.env.NT_TEST_PG_URL!
    const schema = 'studio_extra_' + randomUUID().replace(/-/g, '')
    const admin = new Pool({ connectionString })
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`)
      const conn = openStudioSchemaConnection({
        backend: 'postgres',
        connection: { connectionString, options: `-c search_path=${schema}` },
      })
      try {
        await migrateStudioKysely(conn, config)
        await sql.raw('CREATE INDEX unexpected_extra_idx ON repositories (id)').execute(conn.db)
        await assert.rejects(assertKyselyStudioSchemaCurrent(conn), /index drift/)
        await sql.raw('DROP INDEX unexpected_extra_idx').execute(conn.db)
        await sql
          .raw('ALTER TABLE repositories ADD CONSTRAINT unexpected_extra_check CHECK (length(id) > 0)')
          .execute(conn.db)
        await assert.rejects(assertKyselyStudioSchemaCurrent(conn), /CHECK constraint drift/)
        await sql.raw('ALTER TABLE repositories DROP CONSTRAINT unexpected_extra_check').execute(conn.db)
        await sql
          .raw('ALTER TABLE repositories ADD CONSTRAINT unexpected_extra_unique UNIQUE (name)')
          .execute(conn.db)
        await assert.rejects(assertKyselyStudioSchemaCurrent(conn), /unique constraint drift/)
        await sql.raw('ALTER TABLE repositories DROP CONSTRAINT unexpected_extra_unique').execute(conn.db)
        await sql
          .raw(
            `CREATE FUNCTION unexpected_extra_fn() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RETURN NEW; END;
        $$`,
          )
          .execute(conn.db)
        await sql
          .raw(
            `CREATE TRIGGER unexpected_extra BEFORE UPDATE ON repositories
          FOR EACH ROW EXECUTE FUNCTION unexpected_extra_fn()`,
          )
          .execute(conn.db)
        await assert.rejects(assertKyselyStudioSchemaCurrent(conn), /trigger drift/)
      } finally {
        await conn.close()
      }
    } finally {
      try {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      } finally {
        await admin.end()
      }
    }
  },
)

test(
  'Kysely PostgreSQL baseline: real database parity, FKs, auth, rollback and drift',
  {
    skip: !process.env.NT_TEST_PG_URL && 'Set NT_TEST_PG_URL for PostgreSQL schema tests',
  },
  async () => {
    const connectionString = process.env.NT_TEST_PG_URL!
    const schema = 'studio_baseline_' + randomUUID().replace(/-/g, '')
    const admin = new Pool({ connectionString })
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`)
      await certify({
        backend: 'postgres',
        connection: { connectionString, options: `-c search_path=${schema}` },
      })
    } finally {
      try {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      } finally {
        await admin.end()
      }
    }
  },
)
