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

## Gate ownership

- #128: shared executor/guard correctness and mandatory SQLite/PostgreSQL CI
- #129/#130: fresh common schema, source-checksummed migration history,
  semantic drift checks, deterministic codegen and cross-backend parity
- #131–#140: independent feature conversions and shared fixture certification
- #141: atomic runtime cutover, efficient fail-closed readiness and removal
  of the old Drizzle application stack
- #142: full real-runtime concurrency and contract certification
