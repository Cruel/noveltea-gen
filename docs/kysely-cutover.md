# Shared Kysely rollout and atomic runtime cutover (#131–#142)

The shared Kysely database, transaction guards and fresh-schema migrator are
**the target architecture**. Do not build a PostgreSQL-specific domain store,
and do not bridge independent Drizzle and Kysely write transactions.

## #131–#140: incremental _implementation_, not mixed live persistence

- Build each feature repository once against typed Kysely
  `Transaction<StudioDb>` / read executors; invoke the already-certified
  `withWriteTransaction` semantic guards, not raw driver-specific SQL from
  service or route code.
- Test each new feature against independently provisioned **fresh Kysely**
  SQLite and PostgreSQL databases with the same owner-scoped conformance
  fixtures and public persistence contracts. Backend bootstrap may differ;
  application SQL, decisions, retries and external behavior must not.
- Keep existing Drizzle repositories and normal SQLite Studio startup active,
  unchanged, until all Kysely feature ports, web/worker/agent and trusted
  controller wiring are ready. New Kysely repositories may coexist **in source,
  dependency injection and isolated tests** with old Drizzle repositories.
  This is what #131's expand–contract coexistence criterion means.
- **Do not enable partially converted Kysely ports inside live Drizzle
  requests.** There is no shared transaction/connection across the two ORMs;
  mixing their independent writers in one live database would break atomic
  cross-port operations, guard admission, ownership and rollback semantics.
  A selected PostgreSQL runtime must continue to refuse startup until the
  complete store is available; never fall back to the old SQLite adapter.
- Keep `__drizzle_migrations` and Kysely migration history separate.
  Never auto-adopt, migrate or copy a live Drizzle schema as Kysely. Preserve
  the old runtime until the cutover gate; use a new DB or an **explicitly
  backed-up/reset** development database for the new runtime. Neither CI
  nor migration tooling may silently delete a developer volume.

## #141: single application-level cutover

- Atomically switch the composition root for StudioStore, Better Auth,
  controller and web/agent/worker to the **complete** shared Kysely port
  set. Retire application Drizzle only after contract-equivalence tests,
  while preserving unrelated LangGraph SQLite checkpoint dependencies.
- Select exactly one backend and one persistence stack for each running
  application instance. No hybrid cross-ORM writes, split ownership,
  stale repository fallback or mixed migration journals are permitted.
- Perform **full structural/read-only schema attestation** on startup,
  migrations, reconnect where needed and a bounded revalidation cadence.
  That covers column/FK/CHECK/index/trigger drift and migration source
  checksums. Do not rerun the full Kysely inspector on every request.
- The per-request `assertReady()` fast path should use cached successful
  attestation with fail-closed invalidation. SQLite can invalidate cheaply
  on `PRAGMA schema_version` change; PostgreSQL needs explicit invalidation
  after controlled migrations and periodic catalog reinspection (no implicit
  schema-version integer). Revalidation failure or expired/unavailable
  trustworthy attestation blocks writes, rather than silently trusting a
  stale certificate. Check latency with representative route load and
  regression tests; the existing full inspector takes milliseconds to tens
  of milliseconds per call.
- Do not couple untrusted service request execution to full replay of
  authored migrations on every HTTP request.

## #142: production acceptance

Run the **same full StudioStore feature, owner-scope, retry, crash, queue,
ordering and cross-process concurrency contract suite** on both engines,
with actual web and agent services using the single runtime store.
The smaller #128 proof tables alone are not an application acceptance gate.
Keep mandatory PostgreSQL CI coverage without requiring any particular
local developer PostgreSQL configuration.

## S06 cross-backend evidence (#131, 2026-11-09)

- `collection-kysely.ts` and `publication-kysely.ts` implement the existing
  public feature contracts once against `SharedDatabase<StudioDb>`; their
  guarded transactions and owner checks are identical for both engines.
  Publication state reconciliation is shared with the unchanged live Drizzle
  adapter rather than copied.
- `kysely-feature-fixture.ts` provisions disposable migrated databases and a
  single test-only records interface. `kysely-features.test.ts` runs the
  *same* owner/membership/cascade/selection/phase/retry/idempotency tests for
  SQLite and PostgreSQL. The PostgreSQL run uses an isolated schema, not the
  developer's Studio database.
- Executed against SQLite and a disposable PostgreSQL 17 server with
  `NT_TEST_PG_URL` and `NT_REQUIRE_KYSELY_PROOF=1`: 6/6 dedicated
  conformance tests passed; the Studio offline-safe suite passed 147 tests
  with one expected rootless-Docker integration skip. The 6 legacy
  Collections/publication regression tests also passed.
- Root TypeScript checking, Studio TypeScript checking, Drizzle schema check,
  Kysely generated-type check and persistence boundary checks passed.
- One PostgreSQL difference was exposed by the common suite: an unqualified
  `ON CONFLICT DO UPDATE` ownership predicate is ambiguous in PostgreSQL.
  The shared Kysely queries now qualify their target table columns on both
  engines. No provider- or backend-specific repository algorithm was added.
- Live Drizzle SQLite operation and PostgreSQL fail-closed runtime selection
  remain in place pending the **single** #141 application cutover.

## S07 Git persistence implementation (#132, 2026-11-09)

- `git-kysely.ts` implements the existing Git identities, repository catalog,
  Story onboarding and Pi credential ports once against `SharedDatabase<StudioDb>`;
  live Drizzle repositories stay in use until the atomic #141 runtime cutover.
- The common disposable SQLite/PostgreSQL fixture runs the same owner-scoped
  conformance cases for login accounts, repository import/rebind, OAuth and
  installation single-use states, credential CAS, refresh-lease fencing, Story
  initialization/import rollback, duplicate identities, and restart persistence.
  No live provider credentials or network calls are needed.
- `0001_git_connection_scope` adds **native composite foreign keys** for
  `(connection_id, owner_user_id, provider)` on repositories and GitHub install
  flows, backed by a unique Git connection candidate key. A constrained
  `provider = 'github'` field on install flows prevents cross-provider links.
  Existing single-column connection FKs retain `ON DELETE SET NULL`; the
  complementary composite `NO ACTION` FK validates references without nulling
  the required owner/provider fields when a connection is deleted. PostgreSQL
  uses deferrable referential checks, matching its existing cascade strategy.
  SQLite transactionally rebuilds the two tables from the canonical baseline,
  while PostgreSQL uses `ALTER TABLE`; **both require the target tables to be
  empty**, failing closed rather than silently discarding records. These are
  staged, fresh Kysely databases; live Drizzle data and volumes are untouched.
  Both directions of the migration are tested, as are owner/provider isolation
  and nullable connection deletion on both engines. The application port also
  validates active, owned connection bindings before import/rebind.
- Local evidence: new Git conformance 10/10 across both engines; Studio offline
  suite 149 passed, 0 failed, 2 optional skips; PostgreSQL transaction-guard
  suite 14/14 separately; schema/rollback/parity, generated type, TypeScript,
  and persistence-boundary checks passed. CI still needs to verify the commit.

## S08 Story admission and navigation implementation (#133, 2026-11-09)

- `natural-story-kysely.ts` implements Story-first initial Turn reservation,
  restart/idempotency, admission fencing and root association using the common
  transaction-scoped executor. The existing Git Kysely onboarding port owns
  Story registration and import; there is no mandatory Conversation layer.
- `conversation-kysely.ts` shares Thread reconciliation, owner-scoped run
  history, latest-run navigation, archive, creative policy, deletion
  reservations and tombstones. Event-work lookups use the same indexed,
  transaction-neutral SQL on SQLite and PostgreSQL; no event history is
  materialized in the web process. `catalog-kysely.ts` shares dashboard,
  repository and Story selections, and Thread view preferences, while
  `collection-kysely.ts` retains optional Collection organization.
- `kysely-story-navigation.test.ts` uses the common, disposable Kysely
  fixture and the same contract assertions on both engines: Story imports,
  exact owner/repository identity, first Turn retries, cross-user conflicts,
  latest run/event ordering, nested ancestry and Collections, archival,
  deletion, legacy root reconciliation, preference filtering, and restart.
  These tests are required in the Studio offline CI gate; a missing required
  PostgreSQL URL fails rather than silently skipping.
- The new ports are **staged only**. Live SQLite Studio continues using the
  old Drizzle composition until #141 switches all domains together; no
  cross-ORM write transaction or PostgreSQL runtime is enabled here.

## S09 Thread message admission and durable sequencing (#134, 2026-11-09)

- `thread-message-kysely.ts` supplies the existing `ThreadMessagePersistence`
  contract once for SQLite and PostgreSQL, including exact owner-scoped read
  models, durable Turn associations and verified receipts, idempotent initial
  message and assistant settlement reconciliation (including a status returning
  to an earlier outcome), queued message admission, edit/cancel fencing and
  first-edit replay history.
- Sequence allocation, queue activity and derived Turn creation run inside the
  existing shared `withWriteTransaction` thread guard. The canonical schema's
  generated `thread_queued_message_edits.sequence` defines first/latest edit
  semantics instead of SQLite `rowid`; no new migration is necessary.
- `kysely-thread-messages.test.ts` runs identical tests on fresh SQLite and
  PostgreSQL schemas for owner isolation, replay, protected edits, guided and
  live mode transitions, synthetic-history reconciliation, verification
  provenance, abort/rollback and restart. Its OS-process workers actually
  contend for the same Thread writer guard and validate contiguous message
  allocation and single-winner concurrent edits on both engines.
- The test belongs to the mandatory Studio offline CI gate. The live Drizzle
  composition remains unchanged until #141; independent staged repositories
  never participate in a mixed live transaction.

## S10 advanced Thread lifecycle implementation (#135, 2026-11-09)

- `advanced-thread-kysely.ts` implements the existing
  `AdvancedThreadPersistence` contract once for both SQLite and PostgreSQL:
  owner-scoped identity/ancestry, exact fork and restart reservations, child
  and in-place recovery registration, pinned Story source, historical message
  boundaries, prepared restart receipts and imported author updates.
- Source job/Thread association and pinned baseline are verified **inside the
  reservation transaction**. Parent deletion, archived recovery, stale run
  status/queue admission, pending requests and failed continuations with new
  verified work are denied without partially creating child sessions.
  Replay of an applied message cannot conceal a conflicting owner or payload.
  Existing fork/restart receipt reads now require an authenticated owner in
  the shared contract, both adapters and their server consumers, so a known
  child ID cannot reveal another owner's checkpoint or restart details.
- Every multi-table mutation uses the approved shared guarded transaction;
  all nested reads and inserts receive its executor. Recovery reuses the
  transaction-scoped reconciliation in `thread-message-kysely.ts` instead of
  duplicating seeding or creating a nested root transaction. The original
  SQLite live adapter remains active until #141.
- `kysely-advanced-threads.test.ts` certifies the **same** behavior on
  independently migrated SQLite and PostgreSQL: owner isolation, immutable
  ancestry, restart/advance pinning, rollback, recovery, archive/deletion
  fences and replay. Independent OS-process clients contend for the same
  fork/restart reservation and child/recovery registration, including two
  different recoveries racing to advance one blocked Thread. Required in
  the Studio offline test gate; PostgreSQL proof is mandatory in CI.

## Schema parity and certification hardening (2026-11-09)

- SQLite INTEGER accommodates 64-bit epoch milliseconds. PostgreSQL's
  32-bit INTEGER does not. The frozen-baseline translator maps only the six
  OAuth/credential/install timestamp columns to PostgreSQL BIGINT; all
  unrelated counters, booleans and generated identity keys retain their
  existing logical type. Git record/summary reads convert BIGINT strings to
  validated safe JavaScript integers at the shared domain boundary. Previously
  generated PostgreSQL development schemas with 32-bit timestamp columns must
  be explicitly recreated; readiness rejects their incompatible column types.
- PostgreSQL readiness requires `convalidated` for the expected foreign keys
  and CHECK constraints. CHECK and partial-index normalization retains
  case-sensitive SQL string literals while canonicalizing syntax.
- SQLite readiness compares the complete application-owned tables, indexes
  and triggers against the authored snapshot, rejecting additional objects
  without confusing Better Auth, Kysely journals or SQLite internal objects.
- Studio's PostgreSQL dialect limits catalog introspection at query time to
  `current_schema()`, so concurrent test-schema teardown cannot make
  another fixture's objects disappear mid-query. The same scoped dialect is
  used by maintenance and shared persistence connections. Better Auth also
  receives this dialect through its supported `{ dialect, type: 'postgres',
  transaction: true }` database configuration, not a raw `pg.Pool`: its own
  Kysely instance must never fall back to the stock all-schema introspector.
  Auth intentionally does not inherit Studio's `CamelCasePlugin` or change
  Better Auth's physical table and column casing.
- `kysely-schema-hardening.test.ts` exercises both Studio introspection and
  **200 actual Better Auth migration plans** under 65 unrelated PostgreSQL
  schema create/drop cycles, alongside real-millisecond cases in
  `kysely-git.test.ts`. These are mandatory in the offline test gate. Run with
  `NT_TEST_PG_URL`, `NT_KYSELY_PROOF_URL` (for guarded transaction tests),
  and `NT_REQUIRE_KYSELY_PROOF=1` for both engines.

## Gate ownership

- #128: shared executor/guard correctness and mandatory SQLite/PostgreSQL CI
- #129/#130: fresh common schema, source-checksummed migration history,
  semantic drift checks, deterministic codegen and cross-backend parity
- #131–#140: independent feature conversions and shared fixture certification
- #141: atomic runtime cutover, efficient fail-closed readiness and removal
  of the old Drizzle application stack
- #142: full real-runtime concurrency and contract certification
