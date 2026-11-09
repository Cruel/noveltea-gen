import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { sql, type Transaction } from 'kysely'
import { fork } from 'node:child_process'
import { drainProofQueue, type ProofDb } from './support/kysely-proof'
import { Pool } from 'pg'
import { openKyselyDatabase, type DatabaseOptions } from '../src/db/kysely-connection'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const url = process.env.NT_KYSELY_PROOF_URL

for (const backend of ['sqlite', 'postgres'] as const) {
  test(
    `${backend}: shared guarded transaction proofs`,
    { skip: backend === 'postgres' && !url, timeout: 90_000 },
    async (t) => {
      const dir = mkdtempSync(join(tmpdir(), 'nt-guards-'))
      const options: DatabaseOptions =
        backend === 'sqlite'
          ? { backend, path: join(dir, 'proof.sqlite'), busyTimeoutMs: 0, maxAttempts: 10 }
          : { backend, connection: { connectionString: url }, poolSize: 1 }
      const connections = Array.from({ length: 4 }, () => openKyselyDatabase<ProofDb>(options))
      const first = connections[0]!
      const second = connections[1]!
      const third = connections[2]!
      const observer = backend === 'postgres' ? new Pool({ connectionString: url, max: 1 }) : undefined
      try {
        await first.withWriteTransaction([], async (tx) => {
          await tx.schema
            .createTable('proofQueue')
            .addColumn('id', 'integer', (c) => c.primaryKey())
            .addColumn('phase', 'text', (c) => c.notNull())
            .execute()
          await tx.schema
            .createTable('proofMessages')
            .addColumn('sequence', 'integer', (c) => c.notNull())
            .addColumn('threadId', 'text', (c) => c.notNull())
            .addColumn('jobId', 'integer', (c) => c.notNull())
            .addUniqueConstraint('proof_message_sequence', ['threadId', 'sequence'])
            .execute()
          await tx.schema
            .createTable('proofChildren')
            .addColumn('id', 'text', (c) => c.primaryKey())
            .addColumn('intent', 'text', (c) => c.notNull())
            .execute()
          await tx.schema
            .createTable('proofEvents')
            .addColumn('id', 'integer', (c) =>
              backend === 'sqlite'
                ? c.primaryKey().autoIncrement()
                : c.primaryKey().generatedAlwaysAsIdentity(),
            )
            .addColumn('jobId', 'text', (c) => c.notNull())
            .addColumn('body', 'text', (c) => c.notNull())
            .execute()
        })

        await t.test(
          'nested executor reads its own writes and rollback removes every nested mutation',
          async () => {
            async function nested(tx: Transaction<ProofDb>) {
              await tx.insertInto('proofChildren').values({ id: 'rollback', intent: 'child' }).execute()
              assert.ok(
                await tx
                  .selectFrom('proofChildren')
                  .selectAll()
                  .where('id', '=', 'rollback')
                  .executeTakeFirst(),
              )
              assert.equal(
                await second.read
                  .selectFrom('proofChildren')
                  .selectAll()
                  .where('id', '=', 'rollback')
                  .executeTakeFirst(),
                undefined,
              )
            }
            await assert.rejects(
              first.withWriteTransaction([], async (tx) => {
                await nested(tx)
                throw new Error('rollback')
              }),
              /rollback/,
            )
            assert.equal(
              await second.read
                .selectFrom('proofChildren')
                .selectAll()
                .where('id', '=', 'rollback')
                .executeTakeFirst(),
              undefined,
            )
          },
        )

        await t.test(
          'all write shapes participate before preconditions; absent child identity has one winner',
          async () => {
            const results = await Promise.all(
              connections.map((db, index) =>
                db.withWriteTransaction([], async (tx) => {
                  if (
                    await tx
                      .selectFrom('proofChildren')
                      .selectAll()
                      .where('id', '=', 'same-child')
                      .executeTakeFirst()
                  )
                    return false
                  await tx
                    .insertInto('proofChildren')
                    .values({ id: 'same-child', intent: String(index) })
                    .execute()
                  return true
                }),
              ),
            )
            assert.equal(results.filter(Boolean).length, 1)
            // Formerly autocommit UPDATE/CAS and DELETE use exactly the same mandatory guard.
            const mutations = await Promise.all(
              connections.map((db) =>
                db.withWriteTransaction([], async (tx) => {
                  return (
                    await tx
                      .updateTable('proofChildren')
                      .set({ intent: 'settled' })
                      .where('id', '=', 'same-child')
                      .where('intent', '!=', 'settled')
                      .returning('id')
                      .execute()
                  ).length
                }),
              ),
            )
            assert.equal(
              mutations.reduce((a, b) => a + b),
              1,
            )
            await first.withWriteTransaction([], (tx) =>
              tx.deleteFrom('proofChildren').where('id', '=', 'same-child').execute(),
            )
            assert.equal(
              await first.read
                .selectFrom('proofChildren')
                .selectAll()
                .where('id', '=', 'same-child')
                .executeTakeFirst(),
              undefined,
            )
            assert.equal('insertInto' in first.read, false)
            assert.equal('updateTable' in first.read, false)
            assert.equal('deleteFrom' in first.read, false)
          },
        )

        await t.test('four connections preserve capacity-three FIFO and Thread sequencing', async () => {
          await first.withWriteTransaction([], (tx) =>
            tx
              .insertInto('proofQueue')
              .values(Array.from({ length: 48 }, (_, i) => ({ id: i + 1, phase: 'queued' })))
              .execute(),
          )
          const claims = (await Promise.all(connections.map(drainProofQueue))).flat()
          assert.deepEqual(
            claims.sort((a, b) => a - b),
            Array.from({ length: 48 }, (_, i) => i + 1),
          )
          // Check durable FIFO order, not the arrival order of network responses.
          assert.deepEqual(
            await first.read
              .selectFrom('proofMessages')
              .select(['sequence', 'jobId'])
              .orderBy('sequence')
              .execute(),
            Array.from({ length: 48 }, (_, i) => ({ sequence: i + 1, jobId: i + 1 })),
          )
        })

        await t.test(
          'four independent processes preserve queue capacity, FIFO and Thread sequence',
          async () => {
            await first.withWriteTransaction([], async (tx) => {
              await tx.deleteFrom('proofMessages').execute()
              await tx.deleteFrom('proofQueue').execute()
              await tx
                .insertInto('proofQueue')
                .values(Array.from({ length: 80 }, (_, i) => ({ id: i + 1, phase: 'queued' })))
                .execute()
            })
            const workers = Array.from({ length: 4 }, () => {
              const child = fork(new URL('./support/kysely-proof-worker.ts', import.meta.url), [], {
                execArgv: ['--import', 'tsx'],
                env: { ...process.env, NT_KYSELY_WORKER_OPTIONS: JSON.stringify(options) },
                stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
              })
              let stderr = ''
              child.stderr!.on('data', (data) => {
                stderr += String(data)
              })
              const ready = new Promise<void>((resolve, reject) => {
                child.once('message', () => resolve())
                child.once('error', reject)
                child.once('exit', () => reject(new Error('Worker exited before ready: ' + stderr)))
              })
              const done = new Promise<void>((resolve, reject) => {
                child.once('error', reject)
                child.once('exit', (code) =>
                  code === 0 ? resolve() : reject(new Error('Proof worker failed: ' + stderr)),
                )
              })
              void done.catch(() => {})
              return { child, ready, done }
            })
            try {
              await Promise.all(workers.map((worker) => worker.ready))
              workers.forEach((worker) => worker.child.send('start'))
              await Promise.all(workers.map((worker) => worker.done))
            } finally {
              workers.forEach((worker) => {
                if (worker.child.exitCode === null) worker.child.kill()
              })
              await Promise.allSettled(workers.map((worker) => worker.done))
            }
            assert.deepEqual(
              await first.read
                .selectFrom('proofMessages')
                .select(['sequence', 'jobId'])
                .orderBy('sequence')
                .execute(),
              Array.from({ length: 80 }, (_, i) => ({ sequence: i + 1, jobId: i + 1 })),
            )
            assert.equal(
              (
                await first.read
                  .selectFrom('proofQueue')
                  .select('id')
                  .where('phase', '=', 'finished')
                  .execute()
              ).length,
              80,
            )
          },
        )

        await t.test('same-Job event cursor cannot pass a late-committing allocated ID', async () => {
          const entered = deferred<void>()
          const release = deferred<void>()
          let secondEntered = false
          const writer = first.withWriteTransaction([{ kind: 'job', id: 'job' }], async (tx) => {
            await tx.insertInto('proofEvents').values({ jobId: 'job', body: 'first' }).execute()
            entered.resolve()
            await release.promise
          })
          await entered.promise
          const follower = second.withWriteTransaction([{ kind: 'job', id: 'job' }], async (tx) => {
            secondEntered = true
            await tx.insertInto('proofEvents').values({ jobId: 'job', body: 'second' }).execute()
          })
          try {
            await delay(30)
            assert.equal(secondEntered, false)
            assert.deepEqual(await third.read.selectFrom('proofEvents').selectAll().execute(), [])
          } finally {
            release.resolve()
            await Promise.all([writer, follower])
          }
          const events = await first.read
            .selectFrom('proofEvents')
            .selectAll()
            .where('jobId', '=', 'job')
            .orderBy('id')
            .execute()
          assert.deepEqual(
            events.map((e) => e.body),
            ['first', 'second'],
          )
          assert.deepEqual(
            (
              await first.read
                .selectFrom('proofEvents')
                .select('body')
                .where('jobId', '=', 'job')
                .where('id', '>', events[0]!.id)
                .execute()
            ).map((e) => e.body),
            ['second'],
          )
        })

        if (observer) {
          await t.test(
            'ordered multi-guards, bounded whole-transaction retries and no semantic retries',
            async () => {
              const guards = [
                { kind: 'job' as const, id: 'b' },
                { kind: 'thread' as const, id: 'z' },
                { kind: 'thread' as const, id: 'a' },
              ]
              await Promise.all(
                connections.map((db, i) =>
                  db.withWriteTransaction(i % 2 ? guards : [...guards].reverse(), async (tx) => {
                    const locks = await sql<{
                      count: number
                    }>`select count(*)::int as count from pg_locks where pid = pg_backend_pid() and locktype = 'advisory'`.execute(
                      tx,
                    )
                    assert.equal(locks.rows[0]!.count, 4)
                  }),
                ),
              )
              for (const code of ['40P01', '40001', '23505']) {
                let calls = 0
                await assert.rejects(
                  first.withWriteTransaction(guards, async (tx) => {
                    calls++
                    await tx
                      .insertInto('proofChildren')
                      .values({ id: 'retry', intent: String(calls) })
                      .execute()
                    // PostgreSQL itself raises the SQLSTATE; tests exercise actual driver error propagation.
                    await sql
                      .raw(`DO $$ BEGIN RAISE EXCEPTION 'proof failure' USING ERRCODE = '${code}'; END $$`)
                      .execute(tx)
                  }),
                  { code },
                )
                assert.equal(calls, code === '23505' ? 1 : 3)
                assert.equal(
                  await second.read
                    .selectFrom('proofChildren')
                    .selectAll()
                    .where('id', '=', 'retry')
                    .executeTakeFirst(),
                  undefined,
                )
              }
              let calls = 0
              await first.withWriteTransaction(guards, async (tx) => {
                calls++
                await tx
                  .insertInto('proofChildren')
                  .values({ id: 'retry-success', intent: 'committed' })
                  .execute()
                if (calls === 1)
                  await sql
                    .raw("DO $$ BEGIN RAISE EXCEPTION 'retry' USING ERRCODE = '40001'; END $$")
                    .execute(tx)
              })
              assert.equal(calls, 2)
            },
          )

          await t.test(
            'guard precedes callback and releases after abrupt connection termination',
            async () => {
              const started = deferred<number>()
              const release = deferred<void>()
              const held = first.withWriteTransaction([], async (tx) => {
                await tx
                  .insertInto('proofChildren')
                  .values({ id: 'terminated', intent: 'uncommitted' })
                  .execute()
                const pid = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(tx)
                started.resolve(pid.rows[0]!.pid)
                await release.promise
                await tx.selectFrom('proofChildren').selectAll().execute()
              })
              // Attach immediately so connection errors cannot become unhandled rejections.
              const rejected = assert.rejects(held)
              const pid = await started.promise
              let entered = false
              const waiting = second.withWriteTransaction([], async (tx) => {
                entered = true
                assert.equal(
                  await tx
                    .selectFrom('proofChildren')
                    .selectAll()
                    .where('id', '=', 'terminated')
                    .executeTakeFirst(),
                  undefined,
                )
              })
              try {
                let blocked = false
                for (let i = 0; i < 100; i++) {
                  const result = await observer.query<{ blocked: boolean }>(
                    'select exists(select 1 from pg_stat_activity where $1 = any(pg_blocking_pids(pid))) as blocked',
                    [pid],
                  )
                  if (result.rows[0]!.blocked) {
                    blocked = true
                    break
                  }
                  await delay(10)
                }
                assert.ok(blocked, 'competing connection must actually be waiting for our guard')
                assert.equal(entered, false)
                await observer.query('select pg_terminate_backend($1)', [pid])
              } finally {
                release.resolve()
              }
              await rejected
              await waiting
              assert.equal(entered, true)
            },
          )
        }
      } finally {
        await observer?.end()
        await Promise.all(connections.map((db) => db.close()))
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )
}
