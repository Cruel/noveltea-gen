# NovelTea Story Studio — authentication/bootstrap (#40)

The web application is a separate pnpm workspace package; the existing Story
generator and Skein server stay unchanged. This slice implements an authenticated
TanStack Start dashboard, Better Auth GitHub and GitLab.com sign-in and explicit
cross-provider linking, an encrypted persisted OAuth account store, and tenant-
scoped Story/repository/session catalog tables. #41 adds GitHub App installation-
aware repository discovery, Add by URL, and catalog connection without cloning.
Story discovery, generation, SSE, and publication remain separate tickets.

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

Configure callbacks in both provider applications:

- **GitHub App** (not a GitHub OAuth App): `<BETTER_AUTH_URL>/api/auth/callback/github`
- GitLab.com OAuth application: `<BETTER_AUTH_URL>/api/auth/callback/gitlab`

For development the base URL is `http://localhost:3000`; deploy with HTTPS.
Create a GitHub App under Developer settings > GitHub Apps and copy its **Client ID**
and **Client Secret** (not the GitHub App ID). Give it **Email addresses:
read-only** under account permissions so Better Auth can retrieve a sign-in
email. For future repository operations, configure repository permissions
**Contents: read/write** and **Pull requests: read/write**; **Metadata: read**
is added automatically. Configure repository installation access for selected
repositories. Keep **Request user authorization (OAuth) during installation**
off: login and Add Repository are intentionally separate flows. Configure the
GitHub App setup URL to `<BETTER_AUTH_URL>/api/github/install/callback` and enable **Redirect on update** to return after changes to selected repositories. Set `GITHUB_APP_SLUG` (the slug in `github.com/apps/<slug>`) in addition to the App client credentials. Keep the OAuth callback separately set to `/api/auth/callback/github`. GitHub App installation selection uses a short-lived, one-use state bound to the existing signed-in user, with an HttpOnly SameSite=Lax installation cookie to survive GitHub setup redirects that omit the state parameter; it never asks for OAuth login again.
GitHub App user tokens derive permissions from the app installation and user,
not OAuth App scopes; `offline_access` is the only requested GitHub OAuth
scope (for refreshable user tokens). An authorized GitHub identity does not
itself grant access to uninstalled repositories.

GitLab receives `api` and `write_repository` (its default `read_user` is also
included). GitLab requires the `api` scope for merge-request APIs;
`write_repository` alone covers Git-over-HTTP but not those API calls.
GitHub repository connection is available from **Dashboard → Add GitHub repository**. Browse installations and their push-access repositories, or enter `owner/repository` or a `https://github.com/owner/repository` URL. If an App installation is missing or a selected repository is not covered, choose **Install / update access**. The GitHub setup callback verifies installation access using the existing GitHub user token, and can complete the requested repository connection automatically. Organizations may require an administrator to approve an installation or selection update: the pending import remains visible for 24 hours, with a retry action. If you prefer to adjust an existing installation, use **Configure access on GitHub** and return to the Add Repository screen after approval. Only repositories with actual push permission are accepted; suspended installations and installations without Contents: write are unavailable. Catalog connection creates a lightweight record, **not** a Git clone or Story. Repository permissions are checked again when connecting, not trusted from browser selection. GitHub installations are scoped to the authenticated App user; signing in with GitLab does not grant GitHub access until the user explicitly links their GitHub identity.

Future GitHub installation-token issuance also requires the App ID and private key;
those are not needed by the #40 sign-in screen.

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
organization-permission acceptance requires registering a real GitHub App and
GitLab.com OAuth application and running the provider flows. Login and linking
buttons are present but will not work without those credentials.
