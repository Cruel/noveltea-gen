# Shared Kysely persistence for SQLite and PostgreSQL

Status: accepted. See [spec #125](https://github.com/Cruel/noveltea-gen/issues/125) and its [implementation tickets](https://github.com/Cruel/noveltea-gen/issues/125) for scope, dependencies, acceptance criteria, and execution status.

## Context

Studio previously used SQLite-specific persistence repositories. SQLite's implicit writer serialization protects several multi-step operations, including generation queue claims, Thread sequencing, and recovery. Implementing PostgreSQL by copying these repositories would duplicate domain rules and allow database behavior to diverge. A dialect switch alone does not guarantee transactional equivalence.

## Decision

**One implementation of each persistence operation.** Replace application database-specific persistence with Kysely. Retain the asynchronous `StudioStore`/`StudioPersistence` boundary and owner-scoped domain contracts; application services, routes, and agents must not depend on a database backend. A single set of typed persistence queries runs on both SQLite and PostgreSQL. Backend-specific code is confined to minimal driver, connection, locking, schema/DDL, inspection, and value-normalization infrastructure. Do not create parallel SQLite/PostgreSQL domain repositories. Use one canonical `StudioDb` type with `CamelCasePlugin` and matching code generation; physical SQL names remain snake_case.

**Prove concurrency portability before conversion.** The transaction and dialect audit in [#126](https://github.com/Cruel/noveltea-gen/issues/126) is a hard prerequisite. It must identify every protected invariant, implicit SQLite serialization dependency, nested transaction helper, and cross-engine proof test. Preserve `BEGIN IMMEDIATE` semantics where needed; PostgreSQL may use targeted row locks or transaction-scoped advisory/mutex locks, including a capacity-wide guard for the generation queue. All nested queries in an operation must use its transaction-scoped executor. If equivalent behavior requires substantial duplicated business algorithms, stop for architectural review rather than hide the duplication.

**Keep ordering explicit only where required.** Do not rely on SQLite `rowid`, UUIDv7, or timestamps for strict database insertion order. Add generated integer ordering keys to queued-message edit or steering-checkpoint records only when their first/latest semantics require one. Preserve the existing idempotency keys, timestamps, and uniqueness guarantees.

**Use Kysely migrations as the application schema source of truth.** Use Kysely Migrator and `kysely-ctl` for authored `up`/`down` migrations and scaffolding, not automatic schema-diff generation. Support forward migration, rollback-one, migration to a target version, and reproducible `kysely-codegen` output. Follow Django-like rollback semantics: a valid reverse operation may discard data, while an operation with no valid inverse must explicitly refuse rollback. Verify the canonical database types and logical schema parity against both engines. Better Auth continues to own and migrate its authentication tables separately, before Studio application migrations.

**Support and certify both engines.** SQLite remains the default local and Compose backend; an explicit PostgreSQL Compose override selects PostgreSQL. Both must pass real migration, authentication, owner-isolation, concurrent-worker/Thread, recovery, and deployment tests in CI. Preserve Compose's one-shot migration initializer and read-only, fail-closed runtime readiness checks. Static compilation without PostgreSQL execution is insufficient.

**Preserve controller isolation.** The sandbox controller shares the typed trusted-catalog query but opens a separate read-only connection. For PostgreSQL, use a dedicated internal Compose network connecting only controller and database, plus a least-privilege read-only database role; do not publish the DB port or connect the controller to Web/Agent networks. Network topology does not replace database authorization. Retain existing sandbox and rootless Docker protections.

**Do not silently move or destroy state.** A fresh Studio schema may replace the old Studio development schema only after an explicit operator backup/reset, never by automatically deleting Compose volumes. Independent LangGraph checkpoints, Pi sessions, Git worktrees, and recovery evidence remain out of scope.

## Consequences

Small dialect-specific infrastructure is permitted; duplicated domain persistence algorithms are not. This requires a genuine cross-backend concurrency audit and certification instead of an untested PostgreSQL factory. The issue tracker, rather than a parallel local implementation plan, owns milestone sequencing and acceptance requirements.
