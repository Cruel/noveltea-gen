# Shared Kysely transaction infrastructure (#128)

This began as the S03 driver/guard layer. The application-level Kysely
composition now uses the same guarded persistence ports on SQLite and PostgreSQL;
backend selection is explicit and unsupported values fail closed. The #141 cleanup retires the obsolete SQLite-specific application repositories and
migration artifacts; schema maintenance and both runtimes use Kysely.

## Interface and ownership

`web/src/db/kysely-connection.ts` provides `openKyselyDatabase<DB = StudioDb>`.
Selection is an explicit discriminated option: `{ backend: 'sqlite', path }` or
`{ backend: 'postgres', connection, poolSize }`. There is no fallback or implicit
migration. Both use `CamelCasePlugin`. PostgreSQL pools default to four clients,
are bounded to 1–32, and have a five-second acquisition timeout.

`StudioDb` is now committed **kysely-codegen output** from fresh SQLite
Kysely migrations (#130), excluding Better Auth. It accounts for the physical
`studio_sessions` table and SQLite's integer boolean representation. Use
`kysely-values.ts` for explicit cross-driver conversions at domain boundaries.
Do not apply this plugin to Better Auth's mixed-case physical column names.

The returned interface exposes:

- `read`: standalone SELECT builders, not a root write/transaction executor;
- `withWriteTransaction(guards, async tx => result)`: an awaited atomic callback;
- `close()`: idempotent asynchronous driver/pool cleanup, including an unused
  eagerly opened SQLite handle. Stop admitting work before closing the owner.

Nested helpers take `Transaction<StudioDb>` (or `QueryExecutor<StudioDb>` when
read-only). They must receive **the caller's `tx`**, never capture the root handle
or open another transaction. Callbacks contain database work only: no network,
Git, model, notification or other external effects. A callback can be replayed.
The source-boundary check keeps driver/factory imports out of application services.

## Admission and guard protocol

SQLite overrides Kysely's driver `beginTransaction` on the exact acquired
connection to execute **BEGIN IMMEDIATE**, preserving Kysely commit/rollback and
awaited callback handling. WAL and foreign keys are enabled; file paths must be
absolute (except `:memory:`), with private file/directory permissions.

PostgreSQL currently uses the audit's **global serialization fallback**. EVERY
write callback first acquires the same transaction-scoped advisory guard, even
with an empty guard list. This includes queue admission and formerly autocommit
INSERT, UPDATE/CAS, DELETE, reconciliation and read-side seeding. The common
interface intentionally has no unguarded write method. Application writers now use this boundary through the shared Kysely ports.
No ordinary application route or service may expose a root Kysely pool.

Optional Thread/Job identity guards follow the global guard. They are de-duplicated
and acquired in deterministic order: all sorted Thread identities, then all
sorted Job identities. Keys are stable namespaced SHA-256-derived signed 64-bit
values. A hash collision only adds serialization. Identity advisory locks work
for **missing** parents/children too; this implementation does not depend on row
locks finding an existing row. Queue capacity, child reservation and event ID
allocation/commit visibility are already covered by the mandatory global guard.
There is deliberately no separate queue lock or narrower bypass protocol yet.

PostgreSQL `lock_timeout` is five seconds per acquisition. Deadlock (`40P01`) and
serialization (`40001`) errors retry the **whole rolled-back transaction**, with
locks reacquired before preconditions. SQLite retries `SQLITE_BUSY` and
`SQLITE_BUSY_SNAPSHOT` with a shared five-second contention budget
(`contentionBudgetMs`, configurable 1–60000 ms), rather than restarting the
budget on each attempt. SQLite's `busyTimeoutMs` defaults to 500 ms (0–5000 ms)
and is capped to the remaining budget before each `BEGIN IMMEDIATE` on that
connection, avoiding long synchronous event-loop stalls. PostgreSQL defaults to
three attempts and SQLite to ten; `maxAttempts` remains configurable within 1–10
for both. Backoff is 10 ms times the failed attempt. Uniqueness/semantic errors,
PostgreSQL lock timeout and connection loss are not retried. Connection
termination rejects the active transaction; `pg` disconnect notifications do
not crash the process and broken clients are evicted.

## Proofs and certification

Run focused offline tests:

```sh
pnpm --filter @noveltea/studio exec tsx --test test/kysely-connection.test.ts test/kysely-guards.test.ts
```

The repository's mandatory credential-free CI runs both files with
`NT_KYSELY_PROOF_URL` bound to the CI PostgreSQL service and
`NT_REQUIRE_KYSELY_PROOF=1`; missing proof configuration fails instead of
silently skipping. Each proof run creates an isolated PostgreSQL schema for
its tables and processes; no permanent developer database configuration is
needed. To independently rerun the wider Gate 0 proof, execute:

```sh
pnpm certify:postgres-transactions
```

The certificate reruns the native Gate 0 primitives and executes the **same typed
Kysely proof suite** against SQLite and PostgreSQL 17, using independent
application-role connections. It requires rootless Docker, creates a unique
Compose project/volume, and starts no Studio/model/provider service. Only this
certificate adds an ephemeral loopback port and disposable test network for the
host's node-postgres clients. Production networks/ports are unchanged. Cleanup
removes the invocation's temporary override, networks and exact database volume,
never developer volumes. `NT_KYSELY_PROOF_URL` is a CI-supplied variable or an explicit local test
option; it needs permission to create and drop one uniquely named schema,
not a specific local PostgreSQL setup. Never target a production database.

Proof coverage:

- immediate SQLite admission **before the first write**, independent-handle
  visibility, awaited callback, rollback, release and lifecycle, plus real
  cross-process contention lasting beyond 100 ms and a bounded shared retry budget;
- nested typed queries read their own writes while another connection cannot,
  with complete rollback after failure;
- competing absent-child reservations, CAS and DELETE under mandatory admission;
- capacity-three FIFO claims and Thread sequences across four connections
  (48 jobs), then four synchronized OS processes (80 jobs), on both engines;
- same-Job event append allocation/commit serialization and after-cursor reads;
- reversed multi-guard requests, PostgreSQL-generated `40P01`/`40001` SQLSTATEs,
  rollback of every failed attempt, bounded exhaustion, eventual retry success,
  and no retry for `23505`;
- an observer verifies a competing PostgreSQL backend is actually blocked before
  its callback; abrupt backend termination rolls back writes and releases guards.

These are deliberately small semantic proof algorithms, not parallel domain
repositories. SQLSTATE injection tests retry handling, not spontaneous production
deadlock incidence. Full migrated StudioStore trigger, owner, queue, Thread and
event suites still must carry these invariants forward through #131–#139 and
#142. Do not remove the global guard until **every interacting writer** passes an
equivalent narrower protocol's cross-process tests.
