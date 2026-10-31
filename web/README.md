# NovelTea Story Studio — authentication/bootstrap (#40)

The web application is a separate pnpm workspace package; the existing Story
generator and Skein server stay unchanged. This slice implements an authenticated
TanStack Start dashboard, Better Auth GitHub and GitLab.com sign-in and explicit
cross-provider linking, an encrypted persisted OAuth account store, and tenant-
scoped Story/repository/session catalog tables. Repository import, generation,
SSE, and publication are separate tickets; no implicit clone occurs.

## Setup

Use Node.js 24 (Node >=22.12 supported by Better Auth, 24 recommended for
SQLite compatibility), `pnpm install --frozen-lockfile`, and configure the
variables documented in `web/.env.example`. Export them in your shell or
service environment before running `migrate` or `start`: unlike Vite's dev
server, the standalone migration command does not load a private `.env` file.
Do not commit OAuth secrets. `BETTER_AUTH_SECRET` is **required**, at least
32 characters and stable across restarts. Its loss prevents decrypting saved
provider tokens; back it up separately from SQLite. For rotations, see Better
Auth's versioned `BETTER_AUTH_SECRETS` guidance.

Configure callbacks in both provider apps:

- GitHub: `<BETTER_AUTH_URL>/api/auth/callback/github`
- GitLab.com: `<BETTER_AUTH_URL>/api/auth/callback/gitlab`

For development the base URL is `http://localhost:3000`; deploy with HTTPS.
GitHub receives `repo`, `read:user`, and `user:email` OAuth scopes.
GitLab receives `api` and `write_repository` (its default `read_user` is also included). GitLab requires the `api` scope for merge-request APIs; `write_repository` alone covers Git-over-HTTP but not those API calls.
OAuth grants enable repository operations where the user is authorized;
GitHub App installations and repository import are handled by later tickets.

From the repository root:

```sh
pnpm --filter @noveltea/studio migrate
pnpm --filter @noveltea/studio dev
# release:
pnpm --filter @noveltea/studio build
pnpm --filter @noveltea/studio start
```

Migrations use Better Auth's Kysely SQLite migration and an append-only,
transactional studio application migration journal. Run `migrate` before
starting any web process; runtime does **not** silently initialize missing
tables. The SQLite path defaults to
`$XDG_STATE_HOME/noveltea-gen/studio.sqlite` or
`~/.local/state/noveltea-gen/studio.sqlite`. Configure
`NT_STUDIO_DB_PATH` as an absolute durable-volume path in production.
Database mode is WAL; copy it via a SQLite backup rather than copying the
live database alone. Enforce filesystem access control around the state
directory and the separately stored Better Auth secret.

The server is bound to loopback for `pnpm dev`. Use a trusted HTTPS proxy in
production and do not put the application on the public internet without
rate-limiting, HTTPS, and an adequately secured database and secret volume.

**Security contract.** No email/password auth. Same-email OAuth accounts
are not silently merged; a signed-in user links the second provider explicitly.
Different provider emails are permitted only through that explicit linking
flow. Better Auth encrypts OAuth tokens before writing to SQLite and refreshes
expiring access tokens in its account API; the trusted server fetches an access
token using the account ID already selected by the current authenticated
user. Browser-facing data never includes tokens, arbitrary per-user paths or
Git credentials. `/api/dashboard` returns 401 without a valid session,
and `Cache-Control: no-store` for all responses.

## Acceptance/testing limitations

The isolated migration/restart and user-ownership tests do not invoke live
GitHub/GitLab authorization servers. Complete OAuth redirect, refresh and
organization-permission acceptance requires registering both real OAuth apps
and running the provider flows. Login and linking buttons are present but
will not work without those credentials.
