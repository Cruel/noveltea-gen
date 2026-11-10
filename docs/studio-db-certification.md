# Studio persistence certification

This guide describes the shared Kysely Studio persistence implementation on
SQLite and PostgreSQL. The older SQLite-only certification (#101, November 5,
2026) established fixture coverage and concurrency requirements before the
shared persistence cutover. It does not certify live Git provider publishing,
paid-model execution, or production deployment.

For the final #125 acceptance mapping and full-stack S18 certificates, see
[the #143 closeout matrix](kysely-s18-closeout.md). For schema maintenance see [Kysely schema](kysely-schema.md); for deployment
and operator-controlled database reset see [Studio Kysely cutover](studio-kysely-cutover.md)
and [PostgreSQL Compose](postgres-compose.md).

## Required gates

From the repository root, with dependencies installed:

```sh
pnpm lint
pnpm --filter @noveltea/studio typegen:check
pnpm --filter @noveltea/studio persistence:boundary
pnpm --filter @noveltea/studio check
pnpm typecheck
pnpm test:offline
pnpm certify:postgres-conformance
git diff --check
```

The Studio `check` script verifies generated types, source boundaries, build
and TypeScript types, and credential-free tests. The PostgreSQL conformance
gate provisions or uses an isolated disposable PostgreSQL fixture; a skipped
backend test is not evidence of certification. Root `pnpm lint` enforces
source hygiene and prevents application code from bypassing shared persistence
ports. Formatter coverage is narrower than all historical authored files.

## Shared architecture

`web/src/db/shared-studio-store.ts` composes one
`createKyselyPersistence` implementation for both database engines. Application
services, HTTP handlers, and agent workflows access asynchronous,
owner-scoped `StudioStore.persistence` ports, not drivers or SQL builders.
The selected backend also supplies the Better Auth storage adapter. Better
Auth owns its authentication tables; Kysely migrations own the Studio
application tables. No application-level dual-write mechanism exists.

Schema changes are made using immutable migrations in
`web/kysely-schema/migrations/`, followed by type generation and certification.
The operator explicitly runs `pnpm --filter @noveltea/studio migrate`
before startup. Startup calls read-only `assertReady()` and refuses missing
migrations, drift, partial or untracked old schemas, and incompatible histories.
It never creates, repairs, imports, or deletes an existing database.
Successful readiness attestations are cached per store for at most five seconds,
with immediate SQLite `schema_version` invalidation. PostgreSQL is
revalidated at the bounded lease expiry. Errors and concurrent DDL changes
are never cached; closing the store fences pending inspections.
`web/test/studio-readiness.test.ts` and `web/test/shared-studio-store.test.ts`
cover cache reuse, bounded revalidation, fail-closed invalidation and
warm-request latency.

SQLite uses WAL, foreign keys, guarded `BEGIN IMMEDIATE` transactions, and
process-local write serialization. PostgreSQL uses guarded awaited transactions
and advisory locks. In either engine, multi-statement changes remain in a
single transaction, with nested helpers using the transaction executor and
no external Git/model/network side effects in replayable callbacks.

The sandbox controller has a separate restricted, read-only trusted catalog.
Graph checkpoints, Pi sessions, Git worktrees and recovery receipts are
independent of the Studio database; no Studio reset or migration may erase them.

## Regression and certification evidence

| Behavior | Evidence |
| --- | --- |
| Fresh migration, authentication-first sequencing, journal/readiness drift rejection | `web/test/db-schema-baseline.test.ts`, `web/test/migrate-cli.test.ts`, `web/test/kysely-schema.test.ts` |
| SQLite/PostgreSQL query equivalence, schema parity, transaction retries, owner isolation | `web/test/kysely-*.test.ts`, `web/test/shared-studio-store.test.ts` |
| Better Auth account linking, encrypted credentials and restart | `web/test/studio.test.ts`, `web/test/oauth.test.ts`, `web/test/pi-models.test.ts` |
| Queue acquisition, session fencing, publication, protected decisions | `web/test/generation-persistence.test.ts`, `web/test/publication-approval-persistence.test.ts` |
| Story navigation, conversations, Threads, steering and restart | `web/test/conversation-persistence.test.ts`, `web/test/advanced-thread-persistence.test.ts`, `web/test/thread-*.test.ts` |
| SQLite multi-connection and multi-process queue contention, rollback and restart | `web/test/studio-db-certification.test.ts`, `web/test/support/studio-claim-worker.ts` |
| Source isolation of raw drivers and forbidden application adapters | `scripts/check-studio-persistence-boundary.mjs`, `web/test/persistence-boundary.test.ts` |
| Backend-selectable Studio business fixtures against the real composition, plus isolated SQLite schema fault injection | `web/test/support/studio-database.ts`, `web/test/support/kysely-feature-fixture.ts`, `web/test/support/kysely-test-records.ts` |

Feature tests use `store.persistence` for business operations and
`store.testing` for fixture records, counts, integrity assertions and
controlled fault injection. Backend-specific test drivers must not leak
into application code or normal feature tests.

## S17: cross-engine contention, recovery and ownership certification (#142)

The same backend-neutral `StudioStore` contract runs on a disposable SQLite
file and an isolated PostgreSQL schema. `web/test/studio-store-conformance.test.ts`
opens real composed stores and independent operating-system workers; the only
SQL fault injector lives under `web/test/support/`. Assertions use reopened
Studio persistence ports, durable claim records, and owner-scoped reads.

From the repository root:

```sh
pnpm --filter @noveltea/studio exec tsx --test test/studio-store-conformance.test.ts
pnpm certify:postgres-conformance
pnpm --filter @noveltea/studio test:offline
```

The standalone test skips PostgreSQL when no disposable `NT_TEST_PG_URL` is
supplied. The **mandatory** conformance command provisions its own isolated
PostgreSQL service and sets `NT_REQUIRE_KYSELY_PROOF=1`, so missing PostgreSQL
credentials cause a failure rather than a misleading skip. The credential-free
CI `offline` job also provisions PostgreSQL and sets the proof requirement;
neither gate needs Pi, provider access, or native CLI credentials.

### Reproducible race witnesses per backend

| Race / invariant | Repeated witness |
| --- | --- |
| Queue capacity and FIFO | 8 simultaneous independent claiming processes competing for capacity 3 and 8 queued jobs; exactly the first 3 receive leases, later claim is blocked, replacement takes job 4 |
| Cross-process durability and fencing | Independent reopened `StudioStore` reads all 8 queue positions; a stale lease cannot finish another worker's job |
| Process crash and rollback | SIGKILL during an uncommitted session mutation; reopened public ports see the original state, not a partially committed cancellation |
| Lock timeout and recovery | A held transaction blocks an independent writer; a separate process observes a lock error (SQLite `SQLITE_BUSY`, PostgreSQL `55P03`), and the committed follower succeeds after SIGKILL |
| PostgreSQL namespace separation | A held writer in one schema cannot block a concurrent mutation in another schema of the same PostgreSQL database |
| Tenant/FK boundaries | Cross-owner repository/Story/Thread FKs fail; unauthorized job, collection, Git credential and dashboard reads/mutations cannot cross owners |
| Thread sequence and edit CAS | `kysely-thread-messages.test.ts`: 2 independent processes × 18 messages, 36 distinct contiguous sequences, 2 competing edits with exactly one success |
| Other one-shot and recovery contracts | Mandatory Kysely suites certify fork/restart/recovery reservations, continuation, steering attribution, approval/revision nonce consumption, generation interrupted requeue, and publication |

The tests explicitly close and reopen stores, verify persisted state, and
leave separate recovery/checkpoint and Git worktree volumes untouched. Race
assertions compare durable records and public port behavior, not invocation
order or timing of function mocks.

**Local certification result (November 10, 2026):** mandatory isolated
PostgreSQL conformance: **147 passed, 0 skipped, 0 failed**; full Studio suite:
**355 passed, 49 skipped, 0 failed** (optional external integrations and
PostgreSQL cases skipped in the non-PostgreSQL suite); root offline suite:
**70 passed, 1 skipped**. The mandatory PostgreSQL gate ran both engines
and did not skip PostgreSQL. CI must independently reproduce this after push.

**Resolved cross-engine defect:** PostgreSQL advisory write guards previously
hashed only the global guard key. Since advisory locks also conflict between
independent schemas in one PostgreSQL database, a long transaction in one
schema could stall an unrelated schema and cause a `55P03` timeout in
parallel CI. The lock key is now namespaced by
`current_database() : current_schema()` as resolved inside the transaction.
Within a schema the global capacity guard and job/Thread guards still
serialize all writers; across schemas no accidental lock contention occurs.

## Live Pi witness (November 8, 2026)

The opt-in `web/test/real-pi-generation.test.ts` previously passed one
real model invocation using a read-only copy of a credential from a stopped
Studio development database, with refresh disabled. The isolated rootless
Docker run generated and native-validated a Foundation, committed it to a
disposable worktree, and verified a Story-owned Thread and durable execution
association. The source database was not modified. That witness does **not**
prove live provider publishing, token refresh, or crash recovery under
production writers. Paid-model, native validator and rootless Docker tests
remain separately opted in and must be reported as skipped when not run.

## Safety and operator procedure

For an empty Studio database, stop Studio and Agent, configure the intended
backend and stable auth settings, run `pnpm --filter @noveltea/studio migrate`,
then start Studio and Agent. Old application schemas are **not** automatically
upgraded or imported. A destructive reset requires identifying the exact
selected database and taking a verified, consistent backup with every writer
stopped. Never remove the parent state directory, other services' checkpoints,
Pi data, Git worktrees or Docker volumes as part of Studio schema maintenance.

A credential-free test pass does not certify live GitHub/GitLab installations,
OAuth callbacks, remote pushes, real model execution, or a production
migration. Those require independent, explicitly opted-in witnesses.
