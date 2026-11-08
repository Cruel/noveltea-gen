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
source boundary, builds/typechecks and runs credential-free tests. Root
`pnpm lint` also checks general authored-source hygiene (JavaScript/TypeScript
parse errors, merge markers, unchecked TypeScript suppressions, line endings,
trailing whitespace, debugger and eval); `pnpm format` is an opt-in Prettier
command. `pnpm format:check` currently covers the formatter configuration
and new lint/fixture infrastructure, **not** all legacy authored files, to
avoid an unrelated repository-wide formatting diff. Do not claim a complete
Prettier formatting pass on the entire repository.

| Capability | Credential-free evidence |
| --- | --- |
| Fresh initialization, Better Auth-first migration ordering, idempotent CLI, journal mismatch and structural drift refusal | `web/test/db-schema-baseline.test.ts`, `web/test/migrate-cli.test.ts` |
| Better Auth login/account linking, encrypted credentials and restart | `web/test/studio.test.ts`, `web/test/oauth.test.ts`, `web/test/pi-models.test.ts` |
| Catalog, onboarding, provider fixtures, job acquisition | `web/test/onboarding.test.ts`, `web/test/git-persistence.test.ts`, `web/test/github-*.test.ts`, `web/test/gitlab-*.test.ts` |
| Queue, generation state and events, publication, protected decisions | `web/test/generation-persistence.test.ts`, `web/test/publication-approval-persistence.test.ts`, `web/test/github-publication.test.ts`, `web/test/gitlab-publication.test.ts` |
| Conversations, Threads, steering, continuation, archive, checkpoint fork and restart | `web/test/conversation-persistence.test.ts`, `web/test/advanced-thread-persistence.test.ts`, `web/test/thread-*.test.ts`, `web/test/checkpoint-fork.test.ts` |
| Four SQLite connections; 48 FIFO jobs under capacity three; four separate OS worker processes contending for 60 jobs; 80 interleaved Thread writes; restart, conflicting retries, rollback, fenced recovery; reset isolation | `web/test/studio-db-certification.test.ts`, `web/test/support/studio-claim-worker.ts` |
| Raw driver confinement and CI enforcement | `scripts/check-studio-persistence-boundary.mjs`, `web/test/persistence-boundary.test.ts` |
| Full table and index DDL drift detection (types, nullability, defaults, CHECK and FK constraints, partial-index predicates) | `web/test/db-schema-baseline.test.ts`, live comparison against a pristine reference database |
| Backend-neutral fixture records and introspection for feature tests; SQLite logic isolated in a test adapter | `web/test/support/studio-database.ts`, `web/test/support/studio-seed.ts`, `web/test/support/sqlite-test-records.ts` |

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
`web/src/persistence/store.ts` defines the driver-independent `StudioStore`
contract (`persistence`, asynchronous `assertReady()`, and potentially asynchronous `close()`).
Application requests and agent startup await the store's own read-only schema
readiness guard, not a SQLite migration helper. The Better Auth database
binding is supplied through `db/auth-storage.ts` by the backend.
`web/src/db/connection.ts` implements that contract for SQLite; the legacy
`StudioDatabase` type name is an alias, not a factory-derived type. Better Auth receives backend-selected
storage via `studioAuthStorage()` rather than importing the SQLite driver
in its service. Each Promise-returning persistence
port in `web/src/persistence/*-contracts.ts` is implemented by a Drizzle
SQLite adapter in `web/src/persistence/*-sqlite.ts`; a port method is the
atomic business operation. This includes the formerly synchronous Pi steering
ports. Pi lifecycle registration awaits its durable fence before exposing a
live turn to dispatch, and settlement awaits the SDK call's durable receipt.
Within SQLite, continuation and steering still compose synchronous operations
inside one transaction; no `await` occurs inside a SQLite transaction callback. No application-level dual write exists.

### Test persistence boundary

Feature tests use `store.persistence` for application operations and
`store.testing` for fixture inserts, updates, reads, counts, integrity
assertions and deliberate fault injection. The test factory in
`web/test/support/studio-database.ts` exposes **no** driver or dialect-specific
Drizzle connection; `studio-seed.ts` uses the same records interface for
typed fixtures. `web/test/support/test-persistence.ts` defines the
backend-independent, Promise-returning `TestPersistence` contract, with plain
record values instead of dialect-specific Drizzle insert types. All feature
fixture operations and assertions must await their results. Better Auth-owned auth fixtures and isolated schema-mutation
helpers are also behind that port.

The current implementation of the test port is
`web/test/support/sqlite-test-records.ts`. Special-purpose minimal controller
and read-only OAuth SQLite fixtures live in separate backend-specific support
modules. The root `pnpm lint` source scanner rejects direct SQLite handles
and driver imports from ordinary feature tests; raw driver access is confined
to these backend test adapters.

A future PostgreSQL implementation needs PostgreSQL persistence adapters,
migrations and a matching test-port implementation. Feature tests and their
business assertions should not need SQL rewrites. These changes do **not**
imply that a PostgreSQL backend is implemented or certified.

Better Auth exclusively owns `user`, `session`, `account`, `verification`
and `rateLimit`. `web/src/db/schema.ts` and `web/drizzle/` own the 30
application tables (Story-owned Threads, Turns and Turn-to-execution links;
no mandatory Conversation table). `auth-reference.ts` is only an FK target,
not a second user-table owner. The single explicit `migrate` command runs Better Auth's
supported migration planner first, then the immutable generated Drizzle
migration(s), then auth schema and SQLite integrity/foreign-key checks.
Runtime startup checks the migration journal and compares each application
`CREATE TABLE`, named `CREATE INDEX` and controller-invariant
`CREATE TRIGGER` definitions to a pristine SQLite reference constructed
from the committed Drizzle migration set. This fails closed on
constraint and type drift as well as column/index omissions; equivalent but
textually rewritten DDL may be rejected. Expected definitions are cached per
immutable deployed migration directory. Runtime startup only **validates**;
it must never run migrations or silently repair a mismatch.

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
Pi session transcripts; do not run `docker compose down -v`. Application
tables without Drizzle history and incompatible Drizzle journals are deliberately
refused, not adopted or automatically erased.

When changing the schema, modify `web/src/db/schema.ts`, run
`pnpm --filter @noveltea/studio db:generate`, review and commit the new SQL,
snapshot and journal together, then run `db:check`. Never rewrite an already
applied migration. Deploy `web/drizzle/` and migrate while writers are stopped.

## PostgreSQL readiness: localized work still required

**Conclusion:** App services depend on asynchronous, owner-scoped persistence
ports and avoid raw SQLite handles. A PostgreSQL cutover therefore requires
dialect-specific adapters rather than a rewrite of routes or UI. It is **not**
an environment-variable-only switch.

**PostgreSQL is deliberately out of scope for this foundation.**
No PostgreSQL driver, schema, migration, or persistence implementation is
included. SQLite remains the only supported Studio backend. The async
contracts, backend-owned authentication adapter, and schema readiness port
allow a separate backend to be implemented later without modifying feature
services.

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
5. **Better Auth.** `lib/auth.ts` receives backend-selected storage through
   `db/auth-storage.ts`. A future PostgreSQL backend would register its
   supported database adapter and verify both migration ownership and
   authentication semantics (OAuth state, account linking, encrypted token
   persistence, sessions and rate-limit storage). Keep one shared Studio
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
