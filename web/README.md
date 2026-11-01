# NovelTea Story Studio — authentication/bootstrap (#40)

The web application is a separate pnpm workspace package; the existing Story
generator and Skein server stay unchanged. This slice implements an authenticated
TanStack Start dashboard, Better Auth GitHub and GitLab.com sign-in and explicit
cross-provider linking, an encrypted persisted OAuth account store, and tenant-
scoped Story/repository/session catalog tables. #41 adds GitHub App installation-
aware repository discovery, Add by URL, and catalog connection without cloning.
Story generation, SSE, and publication remain separate tickets. #43 adds GitHub Story discovery and bounded selection; #44 adds GitLab Story discovery and bounded selection.

## Setup

Use Node.js 24 (Node >=22.12 supported by Better Auth, 24 recommended for
SQLite compatibility), `pnpm install --frozen-lockfile`, and configure the
variables documented in `web/.env.example`. For local development, place them
in `web/.env` (optionally overridden by `web/.env.local`). The `migrate`
command now reads those files with the same Vite environment precedence as
`dev`, including `NT_STUDIO_DB_PATH` if configured. Export the configuration
through the service environment when running the production `start` command;
that standalone server does not load Vite's development `.env` files. Stop
Studio before running migrations. Do not commit OAuth secrets. `BETTER_AUTH_SECRET` is **required**, at least
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
surface as retry/reconnect errors. New Story catalog records do not clone or validate canonical Markdown
contents. Job acquisition is an explicit separate action; it does not run an
agent or replace native narrative validation. Story registration requires app migration 3 (`source_commit_sha`). On an
older Studio database, POST returns a specific HTTP 503 explaining how to run
the explicit migration, rather than misreporting a GitHub outage. An inconsistent
migration journal/schema is rejected without attempting a runtime repair.
Unexpected internal failures are logged server-side with a short incident
reference and reported as HTTP 500, without exposing exception details in the
browser.

## GitHub sparse Git acquisition and job worktrees (#46)

After verifying and adding a GitHub Story, choose **Create isolated job worktree**.
The authenticated `POST /api/github/jobs` accepts `{storyId,jobId,commit}`;
`jobId` is a client-generated UUID retained for retry, and `commit` must match
the server's selected or previously saved job SHA exactly. It is an optimistic
revision assertion, not permission to choose arbitrary remote revisions. App schema migration
4 records a durable pinned source SHA on each created session; reopening a job
continues using that SHA even if its Story is later re-imported at a newer
commit. Older session rows without this pin cannot be adopted as a Git job. The server resolves
owner, repository, directory and immutable source SHA exclusively from its
catalog, rechecks the GitHub App grant and stable repository ID, and reruns
size/LFS preflight at the same commit. A changed default branch does not move
an existing job's source revision. Neither Git URLs nor filesystem paths are
accepted from the browser. The response contains only job ID, status and Git
SHAs; server paths and tokens remain private.

Configure `NT_GIT_CACHE_DIR` to a dedicated absolute **evictable** cache volume
outside `NT_STATE_DIR` (or the default `~/.local/state/noveltea-gen`). One
cache directory per hashed user/repository identity holds a reusable filtered,
shallow base clone and `worktrees/<job-hash>` linked checkouts. The base Git
working tree intentionally contains no source files. Each job's sparse checkout
materializes only the selected Story path, shares repository Git objects but
has its own branch/index/work files. Large unrelated monorepo assets are not
checked out. GitHub Git HTTPS authorization is passed as ephemeral subprocess
configuration, never stored in remote URLs, `.git/config`, application rows,
or durable job manifests. Only the explicitly selected Story is checked against
the 100 MB source-size limit; Git cache bytes/history remain a separate disk
quota concern for subsequent cache-governance work.

The existing job engine retains receipts, locks, Pi sessions and checkpoints
under durable `NT_STATE_DIR`; a missing/tampered job worktree or a pinned-commit
mismatch fails closed, preserving recoverable state. Creation and reopen are
serialized per cached repository, with an unreleased lock requiring operator
inspection after a crash rather than silent deletion. Blob fetch, Git tree
verification, or worktree failure is reported explicitly. A Story path with
Git sparse-pattern metacharacters is rejected, rather than potentially
materializing content outside its selected subtree. Existing CLI jobs retain
their original full-checkout behavior; no legacy manifest migration is required.

Job creation currently leaves the job **paused**, prepared for the later web
execution/interrupt workflow; it does not start LangGraph or Pi. Manual test:
register a GitHub Story, set the Git cache variable, create two distinct jobs,
and verify different job IDs and common Git storage. Reopen using the same
`jobId` via API to confirm its branch/work files survive. The backend test
`pnpm --filter @noveltea/studio exec tsx --test test/github-acquisition.test.ts`
uses a local remote to assert sparse selection, object sharing, concurrent
jobs, recoverable edits, pin and size mismatches, and user isolation. Live
GitHub App Git transfer, disk quotas and safe cache eviction still need
provider/deployment certification; no job or worktree is silently evicted.

## GitLab Story discovery and size preflight (#44)

Connected GitLab.com projects have **Browse Stories** links on the dashboard
and immediately after connecting. `GET /api/gitlab/stories?repositoryId=<catalog UUID>`
resolves the default branch to a pinned 40-hex commit and lists its root
folders; `directory=...` and `commit=<SHA>` browse immutable directory
metadata, while `mode=discover` scans for Story candidates. Discovery is
bounded; very large projects may require manual directory browsing.
`POST /api/gitlab/stories` accepts `{repositoryId,directory,commit}` to
verify and register the selected Story without cloning or downloading unrelated
project assets. The server revalidates the owner-scoped catalog record and
current GitLab project membership at every request. New registration is
idempotent per Story directory, records the selected commit, and requires
Studio schema migration 3 for Story selection (migration 4 is needed for job acquisition).

GitLab's paginated REST tree entries do **not** include blob sizes. The 100 MB
(decimal, inclusive) preflight uses commit-pinned GraphQL `repository.blobs`
size-only queries in batches of 100 paths. When GraphQL metadata is missing,
invalid, or unavailable, HEAD requests to the repository-file API verify the
blob ID, immutable commit ID, ref, and exact `X-Gitlab-Size` before any size
is accepted. Failures in both paths prevent registration. Pagination reads
all pages and rejects duplicates, inconsistent paths or malformed page headers;
the selected Story alone is traversed during preflight, with up to 800 metadata
requests and 5000 files. Symlinks, Git submodules, unsupported file modes,
missing/unverifiable sizes, and Story sizes above 100,000,000 bytes fail closed.

Git LFS tracking is checked from `.gitattributes` along the repository/Story
ancestors and within the selected Story; up to 100 attributes files of at most
64 KiB are inspected, and up to 1000 small blobs (up to 2048 bytes) are
retrieved to detect LFS pointers. Blob IDs, sizes and pinned commits are
revalidated before reading these contents. An unusual nonstandard LFS pointer
outside that inspection window cannot be proven from tree metadata alone:
the eventual checkout must independently enforce its own source-size and disk
limits. These checks detect Story candidates but do not yet validate canonical
Markdown; native validation is performed at job/worktree creation. API errors
surface as explicit auth, permission, pagination, rate-limit or verification
failures rather than a generic GitLab outage for internal server errors.

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
