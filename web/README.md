# NovelTea Story Studio — authentication/bootstrap (#40)

The web application is a separate pnpm workspace package; the existing Story
generator and Skein server stay unchanged. This slice implements an authenticated
TanStack Start dashboard, Better Auth GitHub and GitLab.com sign-in and explicit
cross-provider linking, an encrypted persisted OAuth account store, and tenant-
scoped Story/repository/session catalog tables. #41 adds GitHub App installation-
aware repository discovery, Add by URL, and catalog connection without cloning.
GitLab Story discovery, generation, SSE, and publication remain separate tickets. #43 adds GitHub Story discovery and bounded selection.

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
GitLab.com repositories can be connected from **Dashboard → Add GitLab project**.
Discovery uses the existing signed-in or explicitly linked GitLab token, lists
personal and group projects with Developer (access level 30) or higher access,
and checks the authenticated membership list again before connecting a stable
numeric GitLab project ID to the user's catalog. An archived project is excluded.
No filesystem clone occurs. Per-branch protection and later Git push authorization
are independently enforced when publishing. Expired or revoked provider access
blocks new discovery and connections with a reconnect diagnostic; stored catalog
entries remain until explicitly removed. GitLab.com is the only supported host.
GitHub repository connection is available from **Dashboard → Add GitHub repository**. Browse installations and their push-access repositories, or enter `owner/repository` or a `https://github.com/owner/repository` URL. If an App installation is missing or a selected repository is not covered, choose **Install / update access**. The GitHub setup callback verifies installation access using the existing GitHub user token, and can complete the requested repository connection automatically. Organizations may require an administrator to approve an installation or selection update: the pending import remains visible for 24 hours, with a retry action. If you prefer to adjust an existing installation, use **Configure access on GitHub** and return to the Add Repository screen after approval. Only repositories with actual push permission are accepted; suspended installations and installations without Contents: write are unavailable. Catalog connection creates a lightweight record, **not** a Git clone or Story. Repository permissions are checked again when connecting, not trusted from browser selection. GitHub installations are scoped to the authenticated App user; signing in with GitLab does not grant GitHub access until the user explicitly links their GitHub identity.

## GitHub Story discovery and size preflight (#43)

Once connected, a GitHub repository has a **Browse Stories** link on the
dashboard. The browser resolves the default branch to an immutable 40-hex
commit SHA; all directory navigation, discovery and Story selection thereafter
use that exact commit. Refresh HEAD explicitly to pick up new upstream changes.
Automatic detection looks for canonical Story Markdown under recognized record
directories (e.g., `creative-direction/*.md`, `arcs/*.md`,
`milestones/*.md`). Detection is a **candidate** signal, not a claim of
canonical content or protected-decision validation. The native validator will
run when a job/worktree exists. Empty, untracked Story directories cannot be
detected through Git Trees. A repository with **no commits** has no Git tree;
GitHub returns HTTP 409 (`Git Repository is empty.`), which NovelTea presents
as an actionable initial-commit requirement rather than a GitHub outage.

`GET /api/github/stories?repositoryId=<catalog UUID>` lists root directories
and pins a commit; add `directory=...` and `commit=<SHA>` to browse without
moving revisions. `mode=discover` finds candidate Story roots at that commit.
`POST /api/github/stories` with `{repositoryId,directory,commit}` checks the
selected subtree and then registers an owner-scoped catalog Story and its
source commit. POST requires a same-origin authenticated session and a current
writable GitHub App repository grant; GET requires the same grant and ownership.
No request accepts a caller-supplied Git tree SHA, arbitrary provider URL or
filesystem path. The repository's current default branch is *not* used during
selection after a commit is pinned.

Preflight counts uncompressed Git blob sizes under only the selected Story
at that commit, with a **100,000,000-byte (decimal 100 MB) inclusive** cap.
Unrelated monorepo assets, Git history, and blob downloads are excluded. It
uses the GitHub recursive Trees API; if that response is truncated, it
enumerates individual nonrecursive tree objects. Nonrecursive truncation,
missing/noninteger sizes, symlinks, submodules, unsupported Git objects,
excessive tree traversal (400 calls), too many small blobs to inspect (1000),
or more than 100 applicable attributes files fail closed rather than marking
the Story verified. Files up to 2048 bytes are inspected for Git LFS pointer
signatures; applicable `.gitattributes` LFS rules are also examined at the
repository/Story ancestors and inside the Story. An LFS-tracked file or
recognized LFS pointer blocks selection rather than counting its pointer size.
Unsupported attributes patterns or attributes over 64 KiB fail closed. A
nonstandard pointer larger than 2048 bytes inserted without Git LFS tracking
cannot be identified from Git tree metadata alone, so the later checkout must
independently enforce source-size and disk limits.

On unusually large/truncated repositories, automatic discovery may fail its
tree-traversal budget. A **specific small Story can still pass preflight**
using the directory browser without traversing unrelated directories. Errors
are explicit and no partial Story catalog registration is written. Revoked
GitHub installation/user permissions block new browsing and selection, but
existing catalog records are retained. API rate limits or missing access
surface as retry/reconnect errors. New Story catalog records do not clone,
validate canonical Markdown contents, or start agents; later tickets own these
steps.

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

Migrations have two deliberate schema owners, orchestrated by **one**
`pnpm --filter @noveltea/studio migrate` command. Better Auth's supported
Kysely migration planner inspects and brings its own `user`, `account`,
`session`, `verification`, and `rateLimit` tables up to the pinned Better Auth
schema; it does not maintain an application-style versioned SQL history.
NovelTea's app tables use an append-only transactional
`studio_schema_migrations` journal. The command runs the auth migration first,
then the app migrations, waits for Better Auth's actual schema check, and runs
SQLite integrity and foreign-key checks **before** reporting success. A failed
check exits unsuccessfully. The migration command does not start a competing
auth-runtime schema check before tables exist.

Run `migrate` as an explicit deployment step **before** starting web processes
(and while application writers are stopped); runtime never silently applies
migrations. Keep Better Auth pinned and review database changes on upgrades:
its migrator is schema-diff based, not an audited version-by-version journal.
Back up the database and separately stored encryption secret before upgrades;
use the same stable secret and database path on migration and runtime.

The SQLite path defaults to
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
