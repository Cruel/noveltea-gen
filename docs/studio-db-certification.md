# Studio persistence certification and PostgreSQL readiness

Status: **SQLite certified for credential-free Studio workflows**, 2026-11-05, issue #101.
This is a certification of the Drizzle-backed Studio application database, **not**
a certification of a PostgreSQL deployment or live Git provider/Pi execution.

## Repeatable certification

From the repository root, with dependencies installed:

```sh
pnpm --filter @noveltea/studio db:check
pnpm --filter @noveltea/studio persistence:boundary
pnpm --filter @noveltea/studio typecheck
pnpm --filter @noveltea/studio test
pnpm check
git diff --check
```

The Studio `check` script (also invoked by root `pnpm check` and
`.github/workflows/ci.yml`) checks migration metadata, enforces the
source boundary, builds/typechecks and runs credential-free tests. There is
currently no separately configured ESLint or Prettier command; the source
boundary is the enforced persistence-specific lint, TypeScript is the
static correctness check, and `git diff --check` checks changed-line whitespace.
Do not report these as a full-project formatting or general lint pass.

| Capability | Credential-free evidence |
| --- | --- |
| Fresh initialization, Better Auth-first migration ordering, idempotent CLI, journal mismatch and structural drift refusal | `web/test/db-schema-baseline.test.ts`, `web/test/migrate-cli.test.ts` |
| Better Auth login/account linking, encrypted credentials and restart | `web/test/studio.test.ts`, `web/test/oauth.test.ts`, `web/test/pi-models.test.ts` |
| Catalog, onboarding, provider fixtures, job acquisition | `web/test/onboarding.test.ts`, `web/test/git-persistence.test.ts`, `web/test/github-*.test.ts`, `web/test/gitlab-*.test.ts` |
| Queue, generation state and events, publication, protected decisions | `web/test/generation-persistence.test.ts`, `web/test/publication-approval-persistence.test.ts`, `web/test/github-publication.test.ts`, `web/test/gitlab-publication.test.ts` |
| Conversations, Threads, steering, continuation, archive, checkpoint fork and restart | `web/test/conversation-persistence.test.ts`, `web/test/advanced-thread-persistence.test.ts`, `web/test/thread-*.test.ts`, `web/test/checkpoint-fork.test.ts` |
| Four SQLite connections; 48 FIFO jobs under capacity three; four separate OS worker processes contending for 60 jobs; 80 interleaved Thread writes; restart, conflicting retries, rollback, fenced recovery; reset isolation | `web/test/studio-db-certification.test.ts`, `web/test/support/studio-claim-worker.ts` |
| Raw driver confinement and CI enforcement | `scripts/check-studio-persistence-boundary.mjs`, `web/test/persistence-boundary.test.ts` |

Fixture-based provider tests do not prove that a real GitHub App/GitLab
installation, OAuth callback, remote push, or merge-request creation will
work in a deployed environment. Optional real Pi, native validator and
rootless Docker tests remain explicit opt-ins; skipped tests must be reported.
The race suite uses both independent SQLite WAL handles within one process
and four independent OS worker processes. It does not measure PostgreSQL
contention or multi-host network behavior.

## Schema ownership and fresh SQLite procedure

There is **one** Studio application database, selected by the absolute
`NT_STUDIO_DB_PATH` (default `$XDG_STATE_HOME/noveltea-gen/studio.sqlite`).
`web/src/db/connection.ts` opens the driver and exposes only `persistence`
and `close()` to application services. Each Promise-returning persistence
port in `web/src/persistence/*-contracts.ts` is implemented by a Drizzle
SQLite adapter in `web/src/persistence/*-sqlite.ts`; a port method is the
atomic business operation. No application-level dual write exists.

Better Auth exclusively owns `user`, `session`, `account`, `verification`
and `rateLimit`. `web/src/db/schema.ts` and `web/drizzle/` own the 29
application tables; `auth-reference.ts` is only an FK target, not a second
user-table owner. The single explicit `migrate` command runs Better Auth's
supported migration planner first, then the immutable generated Drizzle
migration(s), then auth schema and SQLite integrity/foreign-key checks.
Runtime startup only **validates** journal and structural schema; it must
never run migrations or silently repair a mismatch.

For a **new** database, stop Studio/worker processes, configure the same
stable auth secret and provider IDs as runtime, then run:

```sh
pnpm --filter @noveltea/studio migrate
pnpm --filter @noveltea/studio dev
```

For a **deliberate destructive reset**, stop all Studio/agent writers, back up
the stopped Studio database including WAL data, then remove only the Studio
file and its `-wal` and `-shm` companions at the configured absolute path.
Run `migrate` and restart. See [the Studio setup and reset guide](../web/README.md)
for the exact guarded command and Docker Compose procedure. Do **not**
remove the parent `NT_STATE_DIR`, job directories, graph checkpoints or
Pi session transcripts; do not run `docker compose down -v`. Legacy handwritten
Studio migration histories and incompatible Drizzle journals are deliberately
refused, not adopted or automatically erased.

When changing the schema, modify `web/src/db/schema.ts`, run
`pnpm --filter @noveltea/studio db:generate`, review and commit the new SQL,
snapshot and journal together, then run `db:check`. Never rewrite an already
applied migration. Deploy `web/drizzle/` and migrate while writers are stopped.

## PostgreSQL readiness: localized work still required

**Conclusion:** App services depend on asynchronous, owner-scoped persistence
ports and avoid raw SQLite handles. A PostgreSQL cutover would therefore be
a new adapter and dialect implementation rather than a pervasive rewrite of
routes, UI or workflow services. It is **not** an environment-variable-only
switch. No PostgreSQL implementation, schema or migration is present.

1. **Schema/dialect.** Add a PostgreSQL Drizzle schema and adapter-specific
   column mappings for SQLite `sqliteTable`, `integer` auto-increment keys,
   text timestamps/JSON, boolean representations, checks, composite FK
   constraints, partial/unique indexes and conflict targets. Preserve DB-level
   tenant isolation, durable FIFO ordering, one-active-state constraints and
   delete cascades. The SQLite `rowid` ordering of queued-message edit history
   in `persistence/thread-message-sqlite.ts` needs an explicit durable
   sequence/key instead of a PostgreSQL analogue. Examine raw Drizzle
   ``sql`...` `` fragments in the SQLite adapters for dialect-specific
   expressions before translating.
2. **Async driver and transactions.** Add a PostgreSQL connection factory
   (e.g. a supported `pg` pool with Drizzle's PostgreSQL driver) and implement
   every `StudioPersistence` port in a PostgreSQL-specific module.
   SQLite's synchronous `.run()/.get()/.all()` and `BEGIN IMMEDIATE` stay in
   the SQLite adapter; PostgreSQL ports must await queries and perform
   multi-statement operations within one awaited transaction. Do not expose a
   generic cross-database transaction callback to application services.
   Revisit the sandbox controller's separate read-only
   `db/trusted-catalog.ts` lookup, which currently opens SQLite directly.
3. **Claims and lock semantics.** Port queue admission, capacity checks,
   FIFO claim, state transitions, worker leases and interrupted-run
   reconciliation as indivisible operations. Use transaction-scoped global
   capacity locking (for example a lock row or advisory lock) **and**
   `SELECT ... FOR UPDATE SKIP LOCKED` on pending jobs; row locking alone
   does not stop two schedulers from each counting a free global slot.
   Similarly serialize each Thread's `MAX(sequence)+1` message allocation,
   one preparing continuation and one-shot Pi/approval claim. Preserve
   idempotency keys, comparison-and-swap updates and stale-worker fencing
   across process crashes. Repeat stress tests with genuinely concurrent
   PostgreSQL connections and transaction retries.
4. **Migrations and drift.** Introduce a PostgreSQL Drizzle migration journal
   and generated migrations. `db/migrations.ts` currently introspects
   `sqlite_master`, PRAGMA `schema_version`, `table_info`, `index_list`,
   integrity and foreign-key checks; none can be reused as-is. Build a
   PostgreSQL-native inspection and migration strategy, retain the
   independent Better Auth-first ordering and refuse incompatible histories.
   Since no backward compatibility is required, a fresh PostgreSQL database
   and explicit data-cutover policy are acceptable.
5. **Better Auth.** `lib/auth.ts` passes the embedded better-sqlite3 handle
   into Better Auth. Replace this with its supported PostgreSQL database
   adapter/driver and verify both migration ownership and authentication
   semantics (OAuth state, account linking, encrypted token persistence,
   sessions and rate-limit storage). Keep one shared PostgreSQL Studio
   database with two *disjoint* schema owners.
6. **Separate LangGraph/Pi state.** The `SqliteSaver` instances in
   `src/generation.ts`, `src/checkpoint.ts`,
   `src/web-fixture-runtime.ts` and other graph controllers store **graph
   checkpoints**, not Studio application rows. Pi sessions and trusted
   work-item receipts are separate durable state as well. A Studio
   PostgreSQL migration does **not** require or authorize changing,
   deleting or migrating them. Decide whether to migrate the LangGraph
   checkpointer to its own PostgreSQL backend in an independent project.

### Suggested PostgreSQL gate

Implement a second `StudioPersistence` adapter while keeping the public
ports and their owner/idempotency semantics unchanged. Run the same
behavioral fixtures against both adapters, plus a real PostgreSQL
multi-process race suite, before enabling any deployment switch. Explicitly
test empty migrations, auth migrations and login, stale worker leases,
transaction rollback, ambiguous crashes, and restart/recovery. Only then
consider production cutover. The existing CI restriction on SQLite access
must remain active, with **new dialect access confined to the new adapter**.
