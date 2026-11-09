# Shared Kysely transaction infrastructure (#128)

This is the S03 driver/guard layer, **not a migrated PostgreSQL StudioStore**.
Existing Drizzle SQLite repositories continue to run unchanged. Application and
read-only controller entry points reject `NT_STUDIO_DB_BACKEND=postgres` until
their repositories are migrated; an unknown backend also fails closed.

## Interface and ownership

`web/src/db/kysely-connection.ts` provides `openKyselyDatabase<DB = StudioDb>`.
Selection is an explicit discriminated option: `{ backend: 'sqlite', path }` or
`{ backend: 'postgres', connection, poolSize }`. There is no fallback or implicit
migration. Both use `CamelCasePlugin`. PostgreSQL pools default to four clients,
are bounded to 1–32, and have a five-second acquisition timeout.

`StudioDb` is currently a **type-only bridge** to the legacy schema, excluding
Better Auth. It accounts for the physical `studio_sessions` table and SQLite's
integer boolean representation. #129/#130 must replace this bridge with canonical
migration/codegen types and certify value normalization before application use.
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
interface intentionally has no unguarded write method. No application writer has
been ported yet: each future conversion must use this boundary, not expose a
root Kysely pool. The existing SQLite repositories are not PostgreSQL writers.

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
`SQLITE_BUSY_SNAPSHOT`. Attempts default to three, configurable within 1–10;
backoff is 10 ms times the failed attempt. SQLite busy timeout defaults to 100 ms,
bounded to 0–5000 ms. Uniqueness/semantic errors, lock timeout and connection loss
are not retried. Connection termination rejects the active transaction; `pg`
disconnect notifications do not crash the process and broken clients are evicted.

## Proofs and certification

Run focused offline tests:

```sh
pnpm --filter @noveltea/studio exec tsx --test test/kysely-connection.test.ts test/kysely-guards.test.ts
```

Run the required live certificate:

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
never developer volumes. `NT_KYSELY_PROOF_URL` is an internal opt-in test variable;
never point it at an existing database (the proof creates its own tables).

Proof coverage:

- immediate SQLite admission **before the first write**, independent-handle
  visibility, awaited callback, rollback, release and lifecycle;
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
