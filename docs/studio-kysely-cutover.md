# Studio Kysely cutover (#141)

Studio Web and Agent now select one shared Kysely domain-persistence implementation
using `NT_STUDIO_DB_BACKEND=sqlite` (default) or `postgres`. The selected
backend is used for domain ports and Better Auth. Runtime startup calls strict,
read-only schema readiness; migration is a separate operator command. The
restricted sandbox controller keeps its independent, read-only trusted-catalog
connection. Successful runtime readiness is cached per store for at most five
seconds, with immediate SQLite schema-version invalidation and a bounded
PostgreSQL revalidation lease; failures never enter the cache. When schema
maintenance runs within a live process, call `store.invalidateReadiness()`
after completing it; external migrations are detected on the next bounded
lease expiry (or immediately by opening a new store). PostgreSQL
selection never falls back to the SQLite Studio file.

## Manual reset of an older Studio development database

Old SQLite Studio files containing obsolete application tables or
an incompatible migration journal cannot be migrated or adopted automatically. Stop Web,
Agent and any other Studio writers before making a consistent backup. Find the
**selected Studio file** using `NT_STUDIO_DB_PATH` or the default under
`${XDG_STATE_HOME:-~/.local/state}/noveltea-gen/studio.sqlite`. Never guess
from a worktree or delete a parent state directory.

Back up this file (and its WAL state) with a SQLite-consistent backup mechanism
such as the SQLite `.backup` command, or copy the stopped database together with
any `-wal` and `-shm` sidecars. Verify the backup can be opened and contains
the expected tables before making any destructive change. Then explicitly
rename or move **only that Studio database and its sidecars** out of the selected
path. With an empty path, run `pnpm --filter @noveltea/studio migrate` and
`pnpm --filter @noveltea/studio migrate:kysely check` before restarting Web
and Agent. Recreating Studio discards its old users, OAuth identities,
credentials, registered repositories, Stories, Threads and queue catalog; it
is not an in-place upgrade. If continuity is needed, retain the backup and
plan a separate controlled data migration instead of resetting.

For PostgreSQL, explicitly configure `NT_STUDIO_DB_BACKEND=postgres` and
`PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` for the existing
migration role, then run the same `migrate` and `migrate:kysely check`
commands against the selected database before serving requests. Do not point
the migrator at production or an existing unrelated schema to test the cutover.

No command in this cutover automatically deletes Compose volumes, Git job
worktrees, Pi sessions/transcripts, LangGraph checkpoints, trusted approval
receipts, or recovery artifacts. In particular, do not use `docker compose
down -v` against an existing deployment.

## Verification

Run `pnpm --filter @noveltea/studio typecheck`,
`pnpm --filter @noveltea/studio typegen:check`,
`pnpm --filter @noveltea/studio persistence:boundary`, and
`pnpm --filter @noveltea/studio test`. The PostgreSQL integration suite
requires an isolated disposable `NT_TEST_PG_URL`; tests skipped without it
are not evidence of PostgreSQL runtime certification.
