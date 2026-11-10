# Studio persistence certification

This guide describes the shared Kysely Studio persistence implementation on
SQLite and PostgreSQL. The older SQLite-only certification (#101, November 5,
2026) established fixture coverage and concurrency requirements before the
shared persistence cutover. It does not certify live Git provider publishing,
paid-model execution, or production deployment.

For schema maintenance see [Kysely schema](kysely-schema.md); for deployment
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
