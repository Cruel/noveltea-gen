# NovelTea Story Studio — authentication/bootstrap (#40)

For rootless Compose deployment, the trusted host sandbox controller and its
storage/security boundary, see [deploy/README.md](../deploy/README.md) (#51).
Jobs prepared through this UI remain paused until authenticated execution
admission (#59). All implemented narrative Pi specialists now use sandboxed
file/search/shell tools; independent reviewers receive read/search tools only.

The web application is a separate pnpm workspace package; the existing Story
generator and Skein server stay unchanged. This slice implements an authenticated
TanStack Start dashboard, Better Auth GitHub and GitLab.com sign-in and explicit
cross-provider linking, an encrypted persisted OAuth account store, and tenant-
scoped Story/repository/session catalog tables. #41 adds GitHub App installation-
aware repository discovery, Add by URL, and catalog connection without cloning.
Fixture generation (#59) and reconnectable high-level status (#64) are now implemented; publication remains a separate ticket. #43 adds GitHub Story discovery and bounded selection; #44 adds GitLab Story discovery and bounded selection.

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

## Initialize new GitLab Stories and empty projects (#49)

A connected GitLab.com repository's **Browse Stories** page now offers
**Initialize a new canonical Story**. The author supplies the Creative
Direction ID, title, premise, conflict, genre, tone, experience, scope,
a user-protected opening creative decision, and Markdown body. The result
is the canonical schema-0.1 `creative-direction/foundation.md`, serialized
by the same pure writer used for the existing Story demo. No engine project,
`.noveltea` metadata, hidden approval key or agent-authored decision is created.
The opening decision is marked `origin: user`, `authority: user-protected`;
a draft does not imply approval, narrative readiness or story completeness.

Configure `NT_NATIVE_CLI` to an installed native `noveltea` binary (or
make `noveltea` available on Studio's PATH). Studio runs
`noveltea --json narrative validate <temporary-story-root>` before
**any** GitLab commit; missing/failed/invalid catalog validation stops
creation. The temporary source is removed. Existing GitLab projects use an
explicit immutable default-branch SHA and a new
`noveltea/story-<UUID>` branch via GitLab's commit API `start_sha`.
The default branch is never written and no MR is auto-published; a later
publication workflow handles draft MRs. A genuinely empty project can
receive the **one initial** commit on the explicitly chosen initial default
branch (usually `main`, but configurable to respect group conventions).
The author selects a workspace directory (blank for repository root); the
canonical Story records are initialized in its `story/` child. The adjacent
`.story-inbox/` is reserved for trusted author-only material.

`GET /api/gitlab/initialize?repositoryId=<catalog UUID>` returns current
empty/default-branch state and the immutable default SHA (or null for a
truly empty repository). `POST /api/gitlab/initialize` accepts the
`repositoryId`, `directory`, `expectedCommit` from that GET,
`foundation` onboarding fields and an `initialBranch` only for empty
projects. Authenticated ownership, live GitLab project membership, remote
identity, path safety, exact pre-commit base SHA, directory vacancy, native
validation, committed ancestry and GitLab's pinned Story-size/LFS checks
are enforced server-side. Successful initialization registers the
new Story with its immutable commit so existing Story browsing and cached
Git job acquisition can reopen it. Existing registrations are never
silently overwritten. A failed or ambiguous write reports a conflict or
explicit recovery requirement; no automatic remote replay, branch removal,
force push or default-branch rewrite occurs.

Run `pnpm --filter @noveltea/studio exec tsx --test
test/gitlab-initialize.test.ts` for mocked GitLab write/branch, owner,
validation and reopen checks. Set `NT_REAL_NATIVE_CLI=/path/to/noveltea`
for the optional real native CLI validation test. Actual GitLab.com empty
project and protected-branch behavior remains subject to real-provider
certification; the API tests do not imply successful remote deployment.

## GitLab shared Git acquisition and job worktrees (#47)

GitLab.com uses the **same** authenticated, per-user/per-repository Git
object cache and independent sparse linked worktrees as GitHub. After verifying
and adding a GitLab Story, choose **Create isolated job worktree**. The
`POST /api/gitlab/jobs` endpoint accepts only `{storyId,jobId,commit}`.
The server derives the GitLab project and Story path from the owner-scoped
catalog, rechecks current membership and immutable project identity, resolves
the selected commit, and repeats the full GitLab size/LFS preflight before
acquiring source. A job retains its own original pinned SHA across subsequent
Story re-imports; retrying the same job ID reopens its untouched working files
rather than resetting them. A foreign, unpinned, or mismatched job is rejected.

Set `NT_GIT_CACHE_DIR` to the shared absolute cache volume described above.
GitLab projects use `https://gitlab.com/<namespace>/<project>.git`, including
nested group namespaces, without embedding credentials in the remote. The
connected user's GitLab OAuth token (authorized with `api` and
`write_repository`) is supplied to Git via a **child-process-only** HTTPS
Basic `oauth2` header. No credential is persisted in the clone remote, Git
configuration, job manifest, browser response, or logs. Revoked GitLab
access blocks new acquisitions without destroying existing job state. Missing
cache configuration, invalid project/revision, unverified Git blobs,
unsupported objects, mismatched size counts, and unsafe worktree recovery
produce explicit errors rather than overwriting files. A concurrent job-ID
registration conflict is reported as HTTP 409, with any already-created Git
state preserved for explicit reconciliation rather than silently deleted.

Jobs are prepared **paused** and do not start Pi or LangGraph until the later
web execution workflow. Run
`pnpm --filter @noveltea/studio exec tsx --test test/gitlab-jobs.test.ts`
for provider authorization, revision, transfer credential, shared cache and
recovery regressions. A live GitLab.com private-project HTTPS clone and
provider/deployment certification remain separate acceptance work, as do
disk quotas and eviction.

## GitHub Story initialization (#48)

On a connected GitHub repository, open **Browse Stories → Initialize a new
Story**. Enter a workspace directory or a new nested workspace path (blank
means repository root). Studio creates the canonical content under its
`story/` child and keeps `.story-inbox/` beside it, not in the agent mount.
Enter a draft Story title. The authenticated
`GET /api/github/initialize?repositoryId=...&directory=...` checks the
currently pinned default branch and returns `mode: branch` with a commit SHA
or `mode: bootstrap` with `commit: null` only when GitHub explicitly reports
that the repository has no commits. This operation does not start a model.

`POST /api/github/initialize` requires
`{repositoryId,directory,title,jobId,commit}` and a same-origin signed-in
session. The `jobId` is a client-generated UUID. GitHub App installation and
push rights, catalog ownership, remote identity, exact HEAD revision, directory
nonexistence/no Story records, 100 MB source cap and applicable LFS attributes
are checked again on the server. Only canonical draft
`creative-direction/foundation.md` is created: schema 0.1, no author-protected
decisions or invented narrative facts. The resulting catalog directory is
`story` (or `<workspace>/story`), not the workspace itself. Completing author
discovery and any author approval remains subsequent work. Do not put new Stories inside
`.noveltea` or `.story-inbox`; no persistent `.noveltea` content is written.

**Existing repository:** the Story is initialized and committed in a new
isolated `noveltea-gen/...` worktree branch based on the verified immutable
commit. No remote or default-branch write occurs. Publishing this job for review
is a separate deliberate action (#56), not an automatic merge. The response
contains `published: false`, the job UUID, starting SHA, draft HEAD SHA, and
branch. The catalog points to the starting SHA and the durable job tracks the
draft commit. An identical retry reopens the exact existing initialization
commit; unexpected edits, lost job state, or conflicting canonical content fail
closed and must be reconciled, not overwritten.

**Completely empty GitHub repository:** first create the empty repository on
GitHub and connect it to Studio with the GitHub App installation. With no branch
heads at all, Studio may clone that repository, write one draft canonical Story
file, make the root commit, and perform a normal **non-force** first push to the
repository's designated default branch. Git checks all remote branch heads
again immediately before the push. A concurrent initializer that creates the
target branch causes a non-fast-forward rejection, not a forced overwrite. The
response contains `published: true`, with the new SHA also used as the job's
base. A failed push or interrupted bootstrap preserves the cached clone for
manual inspection; it is never reset or silently retried over unknown history.
After the successful first commit, further Story initialization uses isolated
branches like any other existing repository.

Only completed initialization is recorded in the Studio Story/session catalog.
The Git clone/worktrees are cached separately from durable job manifests.
Connection revocation, schema mismatch, invalid paths, existing Stories,
changed default HEAD and unavailable Git/size metadata return actionable
errors before writing. Existing initialized jobs with unpublished Story paths
can be reopened by their original job UUID through the GitHub jobs API, but
new jobs must wait for that Story to be published.

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

## Authenticated, fixture-only Story generation (#59)

Once a GitHub/GitLab Story job has an isolated cached worktree, open
**Dashboard → job** or follow **Open job and start fixture generation** after
acquisition. The job page shows its verified pinned Git baseline, current
branch HEAD, durable graph thread, request and completed work stages.
`GET /api/jobs/:jobId` is an owner-scoped, read-only inspection endpoint.
`POST /api/jobs/:jobId` accepts only `{task,contract}` from a signed-in
author on the configured same origin. It validates the canonical
`parseGenerationContract` scope and reads Story, revision, branch and
worktree identity exclusively from the database and original durable job
manifest. No filesystem path, provider credential, model or fixture switch
comes from the browser. Schema migration 5 adds the durable request and
thread binding.

**This is strictly fixture execution, not production agent hosting.**
The endpoint forces `fixture: true` and refuses the legacy
`NT_LIVE_GENERATION_IDEA=1` override. It runs the *existing production
LangGraph graph* through one server-owned SQLite checkpointer in the durable
job state directory, pausing at the foundation boundary. The same immutable
request and thread are recorded in both the application catalog and the
generator's server-owner receipt. Repeated starts only inspect the existing
run; they never replay a writer or switch the thread. The CLI cannot
take over a server-owned generation. The normal native validator pin,
Git revision checks, protected-decision rules, and specialist receipts
remain in force. The test-only legacy validator flag must not be enabled
in production.

Configure `NT_STATE_DIR` (durable), `NT_GIT_CACHE_DIR` (evictable),
and `NT_NATIVE_CLI` as usual. An optional
`NT_STUDIO_SKILLS_SOURCE` specifies the trusted server's NovelTea skills
checkout for fixture skill snapshots; never accept a skills path from an
HTTP client. Run `pnpm --filter @noveltea/studio migrate` while Studio is
stopped to apply migration 5. The server and generator checkpoint SQLite
must be owned by one service process and preserved with the job receipts
across restarts. A reconnect inspects the same state; a missing checkpoint,
interrupted writer, unverified Git HEAD, or mismatched request/owner
fails closed for manual reconciliation rather than silently restarting.
Server ownership is claimed durably before publishing the first running request,
so a concurrent CLI writer cannot acquire that job during the start window.
An interrupted claim before the request reaches SQLite is reported as
interrupted, never as an unused prepared job; the same exact request can be
retried without changing the original thread. Reconnection inspects the
persisted skills path and pinned snapshot without requiring the current server
configuration to reference the same checkout directory.
An unpublished Story initialization draft with an unverified extra Git
commit can be inspected but cannot be launched until its revision is trusted.

This stage intentionally does not offer live Pi, worker sandbox tools,
safe-boundary continuation or external Agent Protocol admission; those
belong to subsequent deployment, sandbox and author-control work. Neither
a fixture completion nor a successful structural validation establishes
literary/editorial approval.

Run the authenticated fixture integration test with an existing
`noveltea-skills` checkout:

```sh
NT_SKILLS_CHECKOUT=/path/to/noveltea-skills pnpm --filter @noveltea/studio exec tsx --test test/fixture-jobs.test.ts
```

It exercises a real local Git cache/worktree and production fixture graph,
anonymous and cross-user rejection, same-origin writes, invalid/foreign
contracts, run idempotency, owner/thread receipts, checkpoint reconnect,
and fail-closed tampering.

## Reconnectable generation activity and separate Git diffs (#64)

The job page subscribes to owner-authenticated
`GET /api/jobs/:jobId/events` using Server-Sent Events. Progress is written
as an append-only, monotonically numbered log in Studio SQLite **before**
being broadcast. `id` and `event: progress` let EventSource replay from its
`Last-Event-ID` on reconnect; `?after=<numeric-id>` supports manual replay.
Fresh page loads reconstruct the complete event history from the beginning.
Only started/working/verified/finished/interrupted transitions, typed stage or
Milestone identifiers, and a bounded list of committed Story Markdown paths
are exposed. Raw LangGraph state, Pi tool calls, prompt data, transcripts,
worktree drafts, host paths, and validator internals are never sent as
progress events. An interrupted server or execution does **not** silently
restart generation; the existing job inspection still requires safe manual
reconciliation when needed.

A separate **Verified Git changes** section uses read-only
`GET /api/jobs/:jobId/changes` for committed Story filenames and an optional
`?file=<Story-relative-Markdown-path>` for the selected Git patch. It compares
the pinned job baseline against the verified current HEAD, never the dirty
working tree, and does not treat a diff as proof of narrative validation.
Ownership, job identity, trusted HEAD, file confinement and bounded output
are enforced server-side. Refresh the job to see the latest validation and
committed changes independently of activity messages.

**Deploy:** stop Studio and run `pnpm --filter @noveltea/studio migrate` to
apply schema migration **10** before restarting. Keep the Studio database on a
durable volume alongside its existing checkpoint and job-state requirements.
The `fixture-jobs.test.ts` integration covers real fixture graph transitions,
ordered persisted events, owner isolation, SSE cursor replay, restart,
path filtering, and independent verified Git diffs. The same endpoints will
serve the later sandboxed Pi executor without exposing raw worker output.

## Generation scope editor and saved drafts (#62, #56)

Before fixture generation, the authenticated job page offers **Entire Story**
or **Bounded selection**, generation depth, explicit writable targets,
separately authorized supporting targets, branches, constraints and production
envelope. The advanced JSON editor remains available for exact contract review.
`GET /api/jobs/:jobId/configuration` resolves the current, pinned canonical
catalog. `PUT` requires the same origin and the job owner, an exact current
HEAD, and a prepared, not-yet-executing job. It checks record membership and
active status against the original native report, runs the authoritative
`parseGenerationContract`, and checks focused supporting dependencies through
`resolveFocusedScope`. The server does not silently widen write targets from
the relationship graph or dependency context.

Schema migration **6** adds durable `generation_config_json` to job sessions.
Run `pnpm --filter @noveltea/studio migrate` with the Studio server stopped
before deploying the new UI. A saved draft survives a restart and is only
editable before generation. If a draft exists, fixture launch must match its
pinned task and canonical contract; a direct POST cannot replace it. An
invalid/stale/foreign draft fails closed.

The job's **Pi model and budgets** section now offers per-user API-key connections
and **ChatGPT device-code OAuth** through the Pi SDK. The selected provider,
model and optional reasoning level are verified against that signed-in user's
available Pi catalog and persisted as part of the immutable job draft. The
GET/POST/DELETE `/api/pi/models` connection endpoint is authenticated,
origin-checked for writes, and returns only model and credential metadata;
OAuth device codes are polled by the trusted server. It never exposes tokens.
Disconnecting or losing authorization removes availability and blocks any new
selection or fixture start pinned to that model; the existing draft and worktree
remain intact for recovery. The job cannot silently switch to a host model.

**Operator prerequisite:** set `NT_PI_CREDENTIAL_KEY` to an independently stored,
base64-encoded random 32-byte key (generate with
`node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`)
and run `pnpm --filter @noveltea/studio migrate` with Studio stopped to apply
migration **9**. The app stores AES-256-GCM encrypted Pi provider credentials
in `pi_credentials` keyed by the Better Auth user ID, with revision-checked
OAuth refresh writes. Keep the encryption key outside the Studio SQLite backup
but back it up securely: **losing/changing the key makes existing connections
unreadable**, and runtime requests fail closed. The Pi SDK's runtime is built
with the per-user credential store and with filesystem model configuration
disabled; it does not read shared host `~/.pi` auth/model files. OAuth flow
state is transient during device authorization; completed provider credentials
are durable across restarts. Reconnect if an in-flight device authorization
is interrupted by a restart or if provider access is revoked. An API key being
present does not prove the remote vendor will accept it until a real API call.

Job-level specialist-step, model-call and reported-cost budgets are enforced by the
real Pi controller at specialist boundaries, using persisted Pi session usage.
A budget stop pauses generation without invalidating independently verified
commits. Fixture runs do not make model requests. The rootless Docker controller
separately enforces sandbox resource ceilings; wall-clock enforcement requires
an additional deployment policy. The authenticated start endpoint refuses
client-supplied provider/model/tool settings.

The native catalog/owner-scoped integration cases are covered in
`web/test/story-explorer.test.ts`, with fixture-start binding covered in
`web/test/fixture-jobs.test.ts`.

## Job queue, controls, and crash recovery (#67)

Apply migration **12** while Studio is stopped:
`pnpm --filter @noveltea/studio migrate`. The durable SQLite
`generation_run_queue` reserves at most **two** active generation runs by default.
Set `NT_STUDIO_MAX_ACTIVE_JOBS=1..32` in the host environment to change that
limit. Entries use FIFO admission. A queued run is reconstructed from the
pinned Story/job/thread and user credential store, not its originating browser
connection. Browser disconnect does not cancel execution.

The job page exposes **Pause**, **Resume**, **Cancel**, **Retry after inspection**
and **Inspect**. `GET /api/jobs/:id/control` returns owner-scoped execution
intent, queue status, and persisted Pi budget usage; the same-origin POST
accepts a single typed action. Pause and Cancel are persistent intents handled
at safe work boundaries rather than forcibly terminating a writer. Queued
jobs can be paused or cancelled without starting. A terminal cancellation
cannot be undone. Resume only admits an unchanged pinned job at a clean,
trusted, idle graph checkpoint (or an unstarted, paused job). A budget-stopped
specialist may also resume from its recorded preflight boundary, with no
unverified Git edits or prior specialist result. Studio permits an increase
to step, model-call, or reported-cost limits while paused, but never a decrease,
usage reset, provider swap, or scope change.

Interrupted execution is **never automatically replayed**. The queue retains
failed or vanished-worker evidence; GET inspection remains available even
with dirty partial files or an unverified Git HEAD. Retry checks the original
checkpoint, owner receipt, clean Git worktree and trusted revision and rejects
anything requiring manual reconciliation. In-flight work from other live
processes cannot have its queue capacity stolen. An unrecognized or remote
host owner remains reserved pending operator intervention. Do not clear
worktree edits, specialist receipts, checkpoint files, or pinned validation
state to force a retry.

Integration tests: `web/test/generation-queue.test.ts`,
`web/test/generation-controls.test.ts`, and
`web/test/fixture-jobs.test.ts`. Real rootless Docker/Pi certification
remains opt-in via `NT_TEST_WEB_REAL_PI=1` and its documented credentials.

## New Story onboarding and author discovery (#63)

GitHub and GitLab repository pages share the **New Story discovery and
onboarding** wizard. Select a workspace (blank means repository root), then
review the resolved `<workspace>/story/creative-direction/foundation.md` before
writing. The trusted author-only `.story-inbox/` is a sibling outside the Story
content root, never an agent-mounted child. The author can choose either
**Pi collaborative discovery** (default) or the original three-round
structured author questionnaire. The latter covers premise/conflict,
genre/tone/experience/scope, protected decisions, prose, task and constraints.
Saving each structured round persists an owner/repository/workspace-scoped
revision in SQLite. An outdated tab cannot silently overwrite newer answers.

`GET/PUT /api/onboarding?repositoryId=<UUID>&workspace=<path>` loads and
persists discovery answers, with authentication, same-origin writes, bounded
requests and optimistic revision checks. `POST` with the saved revision returns
the server-reviewed *author-authored* foundation fields and the authoritative
`parseGenerationContract` full-Story composition proposal. A separate,
explicit author action invokes the provider's initialization API; the native
NovelTea validator must accept the canonical schema-0.1 Story document before
any Git commit. The author decision is tagged `origin: user` and
`authority: user-protected`, not falsely attributed to Pi.

**Pi discovery:** choose a connected user Pi model and give a short or detailed
creative brief. The authenticated `GET/POST /api/onboarding/pi` API creates a
separate durable, owner/repository/workspace-scoped conversation. A trusted
controller snapshots the configured `NT_STUDIO_SKILLS_SOURCE` checkout and
supplies the immutable `nt-story-discovery` and `nt-catalog` instructions
(including records, authority and vocabulary references) to a tool-less Pi
AgentSession. It explicitly disables all filesystem, shell, extension,
network-tool and host-Pi-config access: no Story job, branch, files or sandbox
are needed during preliminary discussion. Only the chosen user's encrypted
Pi credentials are available through #56's isolated runtime.

Each model round returns either adaptive numbered questions with recommendations
or a structured proposed Creative Direction and generation task. Partial answers,
author delegation and proposal revision can take multiple rounds. Every
conversation turn and skill digest is stored in SQLite before advancing;
optimistic revisions stop stale/concurrent requests, and an uncertain model
call is **never automatically replayed**. The author can explicitly mark a
running turn interrupted after ten minutes if its worker died, then retry
that interrupted turn, accepting the possibility of a duplicate provider charge.
No incomplete proposal writes canonical Story files. Pi-generated selections
retain agent provenance; the controller separately preserves each exact author
brief/answer as protected provenance, and an explicit review records approval
of the exact foundation digest and model-generated contract. Both GitHub and
GitLab recheck the owner, repository, workspace, approval revision and exact
foundation JSON before any Git write. The normal native Story validator still
checks the canonical file at the provider boundary, including provenance.
After initialization, the approved model is saved in the job's #62
configuration; it may be changed there before generation starts.

GitHub now accepts the same native-validated foundation fields as GitLab.
Existing repositories receive a one-commit isolated job/review branch; GitHub
stores an initial-content SHA-256 digest so the *same* unpublished draft can be
reopened without substituting placeholder source. GitLab creates its separate
remote review branch. Only a genuinely empty repository may create its first
default-branch commit, without force push or modifying preexisting history.
After provider initialization, the wizard prepares the saved Git job (for
GitLab) and saves the initial contract through the owner-scoped configuration
API introduced in #62. If remote creation succeeds but job/configuration
persistence fails, the page reports the partial state and retries **only**
the remaining setup, never the Git commit. Do not blindly repeat a request
after an ambiguous provider write.

**Deploy:** stop Studio and run `pnpm --filter @noveltea/studio migrate` for
migrations **7–8 and 11** (GitHub reviewed-content digest, durable author
drafts and separate Pi discovery sessions). Set `NT_STUDIO_SKILLS_SOURCE` to
the pinned Narrative Skills Git checkout, and connect a per-user Pi provider
with `NT_PI_CREDENTIAL_KEY` configured for collaborative mode. The local Git
cache, durable job state, and installed native CLI must be configured. Tests cover three-round durable answers, multi-user isolation,
stale revisions, native fail-closed bootstrap, existing-branch nonmutation,
reopen-by-digest, and the empty-repository exception; run
`pnpm --filter @noveltea/studio exec tsx --test test/onboarding.test.ts
test/github-initialize.test.ts test/github-initialize-api.test.ts
test/gitlab-initialize.test.ts test/onboarding-pi.test.ts`.

The Pi discovery HTTP tests use scripted model replies to certify the durable,
security and review boundaries without credentials or paid model calls.
Provider initialization integration tests use simulated remote APIs; the
actual hosted model and both real provider flows still need opt-in end-to-end
certification under #71. Structural native validation does not establish
editorial quality or grant agent authorization over protected decisions.

## Canonical Story record explorer (#60)

The authenticated job page displays a read-only Story hierarchy and Markdown
source viewer. It builds the index exclusively from the **native canonical
validator's typed records** for the saved job worktree (or that job's existing
pinned historical validator), not a directory scan, Docker mount list or
client-submitted path. Arc membership and Milestone fulfillment relationships
drive navigation through Arcs, Milestones and Events; other present and future
typed records are grouped by native type/ID without assuming mount paths.
A single record is selected by typed ID and its original Markdown is shown
without executing or rendering user-supplied HTML.

`GET /api/jobs/:jobId/records` returns the bounded typed index, canonical
validation/protection status, and source-path/line diagnostics. Selecting
`?id=<typed-id>` returns only the matching indexed Markdown (up to 512 KiB).
Both requests require the signed-in owner and the original persisted
job/cache identity. A changed Git HEAD, invalid/missing pinned validator,
malformed index, symlinked file, hidden path or out-of-root path fails closed;
no arbitrary filesystem path or revision can be passed from the browser.
Only the selected content root, typically `<workspace>/story`, is read.
The sibling trusted-author `.story-inbox/`, Git metadata and unrelated
repository files are never indexed or returned. Navigation is read-only;
successful validation does not imply author approval.

Run the explorer integration test with:

```sh
pnpm --filter @noveltea/studio exec tsx --test test/story-explorer.test.ts
```

The fixture runs the real session/auth, cached Git worktree and native CLI
pin/protocol boundary with an offline deterministic validator protocol,
including cross-user denial, diagnostics, future types, and inbox/symlink
confinement. For end-to-end native schema certification, configure the actual
`NT_NATIVE_CLI` and browse an imported Story with its normal job pin.

## Acceptance/testing limitations

The isolated migration/restart and user-ownership tests do not invoke live
GitHub/GitLab authorization servers. Complete OAuth redirect, refresh and
organization-permission acceptance requires registering a real GitHub App and
GitLab.com OAuth application and running the provider flows. Login and linking
buttons are present but will not work without those credentials.
