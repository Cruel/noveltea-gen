# Kysely S18 closeout — #125 user-story and Gate 0 matrix

This is the evidence recorded for #143, not permission to close parent
[#125](https://github.com/Cruel/noveltea-gen/issues/125). The parent remains
open for maintainer review.

## Required acceptance

| Requirement | Evidence and outcome |
| --- | --- |
| SQLite and PostgreSQL full-stack Compose boot | **PASS**: `pnpm certify:studio-compose sqlite` and `pnpm certify:studio-compose postgres`; isolated one-shot `init` migrates before Web, Agent and Controller, then all become healthy |
| Service restart and complete down/up | **PASS**: in each engine independently restart Web, Agent, Controller and (PostgreSQL only) DB; then `down`/`up` without `-v`; persisted Better Auth owner and Studio repository are verified through reopened public ports after each stage |
| Kysely migrate/rollback/target/reapply, codegen and source attestation | **PASS**: `web/test/kysely-schema.test.ts`, `kysely-workflow.test.ts`, `migrate-cli.test.ts`, `db-schema-baseline.test.ts`, `kysely-schema-hardening.test.ts`; `typegen:check`, `schema:parity`. Source checksum, partial/future/modified ledger, constraint and view drift remain fail-closed |
| Controller network boundary | **PASS**: PostgreSQL Controller belongs only to `pg-controller`, PostgreSQL also to `pg-app`, and Web/Agent cannot enter `pg-controller`; live DNS denies Web/Agent resolution from Controller. SQLite Controller retains `network_mode: none` |
| Controller read-only role and restricted catalog | **PASS**: Controller can query its intended catalog, but cannot select app jobs/credential tables, create temp or app tables, or mutate catalog; `scripts/certify-postgres-compose.ts` additionally verifies the actual Kysely reader and populated owner-joined projection |
| Database exposure and state safety | **PASS**: no PostgreSQL host port; unique Compose project, generated passwords and isolated volumes for every run; teardown never calls `down -v` or touches operator volumes, Pi sessions, worktrees or checkpoints |
| Credential-free CI | **Mandatory gates**: `.github/workflows/ci.yml` provisions PostgreSQL unconditionally for the offline job with `NT_REQUIRE_KYSELY_PROOF=1`, runs `pnpm lint`, both database conformance suites, Compose configuration tests, type generation and production build; separate required `compose-certification` runs the full SQLite and PostgreSQL production Compose lifecycle on an independent rootless Docker daemon |
| Single shared Kysely persistence and no obsolete application adapters | **PASS**: `web/src/persistence/kysely.ts`, `web/src/db/shared-studio-store.ts`, `scripts/check-studio-persistence-boundary.mjs` and source lint. Better Auth's transitive Drizzle packages are not application imports |
| Migration and reset documentation | **PASS**: `docs/kysely-schema.md`, `docs/studio-kysely-cutover.md`, `docs/postgres-compose.md`, `docs/studio-db-certification.md` |
| Parent closure policy | **PASS**: parent #125 intentionally remains open for maintainer acceptance |

The full Compose witness requires a **rootless** Docker daemon. Local runs
use the real native NovelTea executable and skills checkout. Mandatory CI runs
both modes on an independent rootless Docker daemon and injects a deliberately
restricted CLI `--version` fixture and isolated skills directory. This proves
compiled production Web/Agent/Controller startup, migration order, persistence,
networking and database permissions, **not native Story execution**. The
separate native integration job covers native behavior when private artifacts
are available. Both CI gates generate disposable OAuth/Agent/Pi configuration
values without contacting any model, provider or live OAuth endpoint. Opt-in
live Pi and provider publishing remain separate certification scopes.

## #125 user stories

| Story | Outcome and primary evidence |
| --- | --- |
| 1. One persistence algorithm | PASS: `web/src/persistence/kysely.ts` |
| 2. Unchanged StudioStore interface across consumers | PASS: `shared-studio-store.ts`, `web/test/studio.test.ts` |
| 3. Transaction/invariant audit before conversion | PASS: `docs/kysely-transaction-audit.md`, 48/48 explicit transaction sites |
| 4. Stop if domain SQL duplication is required | PASS: Gate 0 decision in transaction audit; one composition, no divergent domain repositories |
| 5. One typed Kysely interface/plugin | PASS: `web/src/db/studio-db.ts`, `kysely-connection.ts` |
| 6. Physical snake_case, logical camelCase | PASS: CamelCasePlugin and `kysely-schema` |
| 7. Nested transactions share one executor | PASS: `kysely-connection.ts`, `web/test/kysely-guards.test.ts` |
| 8. Minimal semantic locking helpers | PASS: SQLite BEGIN IMMEDIATE / PG schema-scoped advisory locks; S17 proofs |
| 9. Queue capacity/FIFO | PASS: `kysely-generation.test.ts`, `studio-store-conformance.test.ts` |
| 10. Worker leases, retries, recovery | PASS: generation, steering, continuation and S17 crash recovery tests |
| 11. Stable concurrent Thread sequencing | PASS: `kysely-thread-messages.test.ts` (36 contiguous independent-process messages) |
| 12. Edit/steer/fork/restart/approval/Turn atomicity | PASS: advanced-threads, approvals, steering, continuation, messages |
| 13. First/latest edit and checkpoint selection | PASS: message sequencing and steering attribution persisted-state tests |
| 14. Remove rowid assumptions without unnecessary fields | PASS: Gate 0 schema audit and `kysely-schema.test.ts` |
| 15. Preserve UUID/idempotency keys | PASS: generation, Git, Thread and approval cross-engine tests |
| 16. Owner-scoped reads plus DB constraints | PASS: Git, Story, Collections, publication, S17 tenancy witnesses |
| 17. Normalize bool/timestamp/bigint/JSON | PASS: `web/src/db/kysely-values.ts`, cross-engine fixtures |
| 18. Generate committed schema types | PASS: `web/src/db/studio-db.ts`, `kysely-typegen-cli.ts --check` |
| 19. Deterministic parity and codegen in CI | PASS: `typegen:check`, `schema:parity`, CI offline job |
| 20. Scaffold migrations | PASS: `pnpm --filter @noveltea/studio migration:new` |
| 21. Up/down-one/migrate-to | PASS: `kysely-migrate-cli.ts`, `kysely-workflow.test.ts` |
| 22. Destructive down allowed | PASS: tested authored reversal where defined |
| 23. Impossible/unimplemented down denied | PASS: scaffold/irreversible migration regression tests |
| 24. Better Auth migrates before app schema | PASS: `migrateStudioKysely` and fresh Compose certificates |
| 25. Default SQLite Compose | PASS: `compose.yaml` and S18 SQLite full-stack witness |
| 26. Opt-in PostgreSQL Compose | PASS: `compose.postgres.yaml` and S18 PostgreSQL full-stack witness |
| 27. One-shot init before runtime | PASS: Compose health dependencies and init log certificate |
| 28. Pending/tampered/future/drift refusal | PASS: `kysely-schema-hardening.test.ts`, `shared-studio-store.test.ts` |
| 29. Read-only controller catalog | PASS: actual restricted role and Kysely catalog probe |
| 30. Private Controller/PostgreSQL network | PASS: S18 live DNS and network membership certificate |
| 31. Independently verified restricted DB grants | PASS: `certify:postgres-compose`, `certify:studio-compose postgres` |
| 32. Shared SQLite/PostgreSQL conformance | PASS: `web/test/support/kysely-feature-fixture.ts`, mandatory PostgreSQL proof |
| 33. Real cross-process races and recovery | PASS: S17 independent worker/lock/crash certification |
| 34. PostgreSQL required by credential-free CI | PASS: CI PostgreSQL service and fail-on-missing proof setting |
| 35. Obsolete application repositories removed | PASS: source boundary checks, shared Kysely-only domain composition |
| 36. Manual scoped reset | PASS: `docs/studio-kysely-cutover.md`; no automatic volume reset |

## Gate 0 decisions and closeout

| Feasibility decision | Result |
| --- | --- |
| One owner-scoped SQL implementation; dialect differences only at driver, DDL, value and guard seams | **Satisfied**; see shared composition and audited helper modules |
| SQLite immediate-lock/PG transaction-scoped locking; no root connection escape inside callbacks | **Satisfied** with nested-transaction/rollback and cross-process proof; PG advisory guards now include the selected database and schema |
| Capacity, absent-identity races, lock ordering and bounded retries | **Satisfied** with `kysely-guards.test.ts`, `kysely-generation.test.ts` and S17 claims |
| Sequential IDs, cursor/commit ordering, stale receipts, approvals, steering and restart recovery | **Satisfied** with mandatory domain suites and S17 crash witness |
| Auth-first migration, source integrity and controller scope | **Satisfied** in S18 full-stack deployment plus schema/controller tests |
| Architecture stop condition: substantial duplicate SQL required | **Not triggered**: no parallel domain implementations were needed |

## Locally reproduced results (November 10, 2026)

- `pnpm certify:studio-compose sqlite`: PASS, full initial boot + 3 service restarts + down/up
- `pnpm certify:studio-compose postgres`: PASS, full initial boot + 4 service/DB restarts + down/up, Controller DNS and role denial
- `pnpm certify:postgres-conformance`: database contract and SQL migration certification on both engines (see S17 evidence)
- `pnpm --filter @noveltea/studio check`: complete Studio test/build gate
- `pnpm lint`, `pnpm typecheck`, `pnpm --filter @noveltea/studio typegen:check`, `pnpm --filter @noveltea/studio schema:parity`: required integrity checks

**Production-only defect resolved during S18:** Nitro's bundle relocated
`import.meta.url` relative migration inputs and duplicated the Kysely adapter
class between compiled code and authored migrations. The build now stages
byte-identical immutable migration/attestation assets alongside the Nitro
bundle, and externalizes Kysely in Nitro's server rollup. This preserves
migration-source checksums, avoids a destructive database reset, and is
verified by both full-stack certificates and CI's mandatory production build.
