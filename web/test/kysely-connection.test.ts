import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fork } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { openKyselyDatabase } from '../src/db/kysely-connection'
import { openStudioDatabase } from '../src/db/connection'
import { readTrustedControllerJob } from '../src/db/trusted-catalog'

interface ProofDb {
  proofRows: { rowId: number }
}

async function withExternalSqliteLock(path: string, holdMs: number, work: () => Promise<void>) {
  const child = fork(new URL('./support/sqlite-lock-holder.ts', import.meta.url), [path, String(holdMs)], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  let stderr = ''
  child.stderr!.on('data', (chunk) => {
    stderr += String(chunk)
  })
  const ready = new Promise<void>((resolve, reject) => {
    child.once('message', () => resolve())
    child.once('error', reject)
    child.once('exit', () => reject(new Error('SQLite lock holder exited before ready: ' + stderr)))
  })
  const finished = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) =>
      code === 0 || signal === 'SIGTERM'
        ? resolve()
        : reject(new Error('SQLite lock holder failed: ' + stderr)),
    )
  })
  void finished.catch(() => {})
  try {
    await ready
    await work()
  } finally {
    if (child.exitCode === null) child.kill()
    await finished
  }
}

test('factories reject invalid configuration, close before first query and reject use after close', async () => {
  assert.throws(() => openKyselyDatabase({ backend: 'sqlite', path: 'relative.sqlite' }), /absolute/)
  assert.throws(
    () => openKyselyDatabase({ backend: 'sqlite', path: ':memory:', maxAttempts: 0 }),
    /maxAttempts/,
  )
  assert.throws(
    () => openKyselyDatabase({ backend: 'sqlite', path: ':memory:', contentionBudgetMs: 0 }),
    /contentionBudgetMs/,
  )
  assert.throws(() => openKyselyDatabase({ backend: 'postgres', connection: {}, poolSize: 33 }), /poolSize/)
  const db = openKyselyDatabase<ProofDb>({ backend: 'sqlite', path: ':memory:' })
  await db.close()
  await db.close()
  assert.throws(() => db.read.selectFrom('proofRows'), /closed/)
  await assert.rejects(
    db.withWriteTransaction([], async () => {}),
    /closed/,
  )
})

test('unmigrated application and controller reject PostgreSQL rather than opening SQLite', () => {
  const previous = process.env.NT_STUDIO_DB_BACKEND
  try {
    process.env.NT_STUDIO_DB_BACKEND = 'postgres'
    assert.throws(() => openStudioDatabase(':memory:'), /not yet migrated.*refusing SQLite fallback/)
    assert.throws(() => readTrustedControllerJob('/does-not-exist.sqlite', 'job'), /not yet migrated/)
    process.env.NT_STUDIO_DB_BACKEND = 'typo'
    assert.throws(() => openStudioDatabase(':memory:'), /Unsupported NT_STUDIO_DB_BACKEND/)
  } finally {
    if (previous === undefined) delete process.env.NT_STUDIO_DB_BACKEND
    else process.env.NT_STUDIO_DB_BACKEND = previous
  }
})

test('shared SQLite executor uses immediate admission, awaits callbacks and rolls back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-kysely-'))
  const options = {
    backend: 'sqlite' as const,
    path: join(dir, 'proof.sqlite'),
    busyTimeoutMs: 0,
    maxAttempts: 1,
  }
  const first = openKyselyDatabase<ProofDb>(options)
  const second = openKyselyDatabase<ProofDb>(options)
  try {
    await first.withWriteTransaction([], async (tx) => {
      await tx.schema
        .createTable('proofRows')
        .addColumn('rowId', 'integer', (c) => c.primaryKey())
        .execute()
    })
    await assert.rejects(
      first.withWriteTransaction([], async (tx) => {
        // Contention before the first write proves BEGIN IMMEDIATE, not deferred BEGIN.
        await assert.rejects(
          second.withWriteTransaction([], async (other) => {
            await other.insertInto('proofRows').values({ rowId: 2 }).execute()
          }),
          { code: 'SQLITE_BUSY' },
        )
        await tx.insertInto('proofRows').values({ rowId: 1 }).execute()
        assert.deepEqual(await tx.selectFrom('proofRows').selectAll().execute(), [{ rowId: 1 }])
        assert.deepEqual(await second.read.selectFrom('proofRows').selectAll().execute(), [])
        throw new Error('rollback')
      }),
      /rollback/,
    )
    assert.deepEqual(await first.read.selectFrom('proofRows').selectAll().execute(), [])
    await second.withWriteTransaction([], async (tx) => {
      await tx.insertInto('proofRows').values({ rowId: 3 }).execute()
    })
    assert.deepEqual(await first.read.selectFrom('proofRows').selectAll().execute(), [{ rowId: 3 }])
  } finally {
    await first.close()
    await second.close()
    await first.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SQLite retries when another process holds a lock longer than one 500 ms wait', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-kysely-wait-'))
  const path = join(dir, 'proof.sqlite')
  const db = openKyselyDatabase<ProofDb>({ backend: 'sqlite', path })
  try {
    await withExternalSqliteLock(path, 900, async () => {
      const start = performance.now()
      await db.withWriteTransaction([], (tx) =>
        tx.schema
          .createTable('proofRows')
          .addColumn('rowId', 'integer', (c) => c.primaryKey())
          .execute(),
      )
      assert.ok(performance.now() - start > 500, 'writer must retry after a full lock wait')
    })
    assert.deepEqual(await db.read.selectFrom('proofRows').selectAll().execute(), [])
  } finally {
    await db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SQLite busy retries share one contention budget instead of resetting per attempt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-kysely-budget-'))
  const path = join(dir, 'proof.sqlite')
  const db = openKyselyDatabase<ProofDb>({
    backend: 'sqlite',
    path,
    busyTimeoutMs: 100,
    contentionBudgetMs: 350,
  })
  try {
    await withExternalSqliteLock(path, 1500, async () => {
      const start = performance.now()
      let callbacks = 0
      await assert.rejects(
        db.withWriteTransaction([], async () => {
          callbacks++
        }),
        { code: 'SQLITE_BUSY' },
      )
      const elapsed = performance.now() - start
      assert.equal(callbacks, 0, 'BEGIN IMMEDIATE never admits the blocked callback')
      assert.ok(elapsed >= 200 && elapsed < 700, `budget should bound contention; elapsed ${elapsed}ms`)
    })
  } finally {
    await db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
