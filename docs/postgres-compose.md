# Opt-in PostgreSQL Compose topology (#127)

SQLite remains the default. `docker compose up -d` uses only
`compose.yaml`, retains the existing named SQLite/state/cache/controller
volumes, and keeps the controller's `network_mode: none`.

## Configuration and commands

Set three **different random passwords** in a Git-ignored root `.env`
(or export them to the Compose shell). Never commit or copy real developer
credentials into the test environment:

```dotenv
NT_PG_ADMIN_PASSWORD=<random-bootstrap-password>
NT_PG_APP_PASSWORD=<independent-random-app-password>
NT_PG_CONTROLLER_PASSWORD=<independent-random-read-password>
```

The override is explicit; it never starts on normal SQLite deployments:

```sh
docker compose -f compose.yaml -f compose.postgres.yaml config --quiet
docker compose -f compose.yaml -f compose.postgres.yaml up -d postgres
docker compose -f compose.yaml -f compose.postgres.yaml ps postgres
docker compose -f compose.yaml -f compose.postgres.yaml logs postgres
```

This initializes a dedicated `noveltea-postgres` persistent volume via
`deploy/postgres-bootstrap.sh`, checks PostgreSQL health with an authenticated
query, and publishes **no database host port**. The initializer, Web and Agent
now select the same Kysely backend explicitly; PostgreSQL never falls back to
SQLite. The initializer runs the Kysely schema migration before the Web and
Agent perform their strict, read-only startup readiness checks. Keep using
both Compose files for all PostgreSQL operations. The override supplies
`PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and `PGPASSWORD` to the
initializer, production Web, development Web, agent, and controller. The
initializer retains the existing one-shot migration order and the Web/Agent
backend remains private. Keep both Compose files in all subsequent commands;
do not mix them with a running SQLite deployment until explicitly migrated.

## Network and privilege boundaries

The override creates two **internal** networks, neither published to the
host. PostgreSQL alone joins both. The initializer, Web, Web-dev and Agent
join `pg-app`, in addition to their existing application networks.
The daemon-facing controller joins **only** `pg-controller`: Compose's
`!reset null` removes the incompatible SQLite `network_mode: none`.
Because Web/Agent do not join `pg-controller`, a DB connection does not
grant the controller access to their HTTP/RPC endpoints. The existing
rootless Docker socket mount, token/Unix-socket ownership, dropped controller
capabilities, and `--network none` job containers remain unchanged.

The PostgreSQL bootstrap creates `noveltea_app` (application migration
owner) and `noveltea_controller` (login-only, no table/DDL/temp privileges).
It denies default public database/schema access and grants the controller
only `USAGE` on the dedicated `controller_catalog` schema plus `SELECT`
on `controller_catalog.trusted_jobs`. The bootstrap view is initially **empty** and cannot expose user credentials.
The explicit `0002_trusted_catalog` Kysely migration replaces it with the
same typed owner-scoped job projection used to build the SQLite catalog view.
Until that migration is applied, the PostgreSQL controller authorizes no jobs. The controller must
never read `pi_credentials`, `git_connections`, or Better Auth tables.
The bootstrap owns a new empty data volume; changing passwords later requires
a deliberate PostgreSQL role-rotation procedure, not simply editing `.env`.

PostgreSQL's official startup needs `CHOWN`, `FOWNER`, `SETUID`,
`SETGID`, and `DAC_OVERRIDE` to initialize its volume and drop to the
postgres UID inside a **rootless** user namespace. No such capabilities
are granted to the controller, Web, Agent or job sandboxes.

## Disposable, credential-free certification

```sh
pnpm --filter @noveltea/studio exec tsx --test test/postgres-compose.test.ts
pnpm certify:postgres-compose
```

The static test checks actual Compose interpolation/merge without resolving
private service env files, including the `web-dev` profile. The live test uses
`compose.postgres.test.yaml` to remove private service env-file references
from the isolated probe stack. It requires the rootless Docker daemon and
pulls the official PostgreSQL image. It generates fresh per-run roles/passwords,
a unique Compose project and one uniquely named PostgreSQL volume. It starts
**only PostgreSQL and network probes**, not Studio, model sessions, real
OAuth credentials or private skills. It verifies network reachability and
Web/Agent isolation; populated owner-joined view SELECT; the actual Kysely
controller reader and cross-owner/malicious-ID rejection inside the restricted
network; denied private reads, writes and DDL; absence of a published port;
and reader/restart/full down-up persistence. It removes
only its unique volume. **Never run `docker compose down -v` on the ordinary
deployment**: that would destroy live SQLite, state and controller volumes.

This is a PostgreSQL **topology and role** certificate, not a claim of
application query/transaction parity.

The post-#127 Gate 0 **transaction feasibility** certificate is separate:

```sh
pnpm certify:postgres-transactions
```

It launches an independent, disposable PostgreSQL Compose project and verifies
transaction-scoped advisory-lock exclusion/release, uncommitted-write isolation
and rollback, and capacity-one FIFO admission with two competing database
sessions. It removes only its own uniquely named volume and never starts Studio.
See [the Gate 0 audit addendum](kysely-transaction-audit.md) for evidence and
remaining #128 proof requirements.

For the full **SQLite/PostgreSQL common-port and schema** certification, run:

```sh
pnpm certify:postgres-conformance
```

This extends the same disposable Gate 0 environment with the shared Kysely
feature suites, schema hardening, migration rollback and steering race tests.
It uses a randomly assigned **loopback-only** PostgreSQL port for the
isolated test process, never the application Compose deployment. The test
fixture uses the disposable bootstrap role for temporary schema creation;
production application and controller grants remain restricted. Both the
test project and its uniquely named volume are cleaned up afterward.

The full-stack #143 certificate now verifies **both** SQLite and PostgreSQL
on a fresh, disposable Compose project (real init, compiled Web, Agent,
Controller and persisted Better Auth/Studio records), including service
restarts, full down/up and PostgreSQL read-only Controller permissions:

```sh
pnpm certify:studio-compose sqlite
pnpm certify:studio-compose postgres
```

These require local rootless Docker, the native CLI and skills checkout, but
no real model/provider credentials. Generated disposable OAuth placeholders
are used only to validate startup and schema/auth storage. The two projects
use independently named volumes and never remove operator data; see the
[#143 acceptance matrix](kysely-s18-closeout.md).
