# NovelTea Story Studio — authentication/bootstrap (#40)

For rootless Compose deployment, the trusted host sandbox controller and its
storage/security boundary, see [deploy/README.md](../deploy/README.md) (#51).
Jobs prepared through this UI remain paused until authenticated execution
admission (#59). All implemented narrative Pi specialists now use sandboxed
file/search/shell tools; independent reviewers receive read/search tools only.

The web application is a separate pnpm workspace package; the existing Story
generator now runs in a dedicated LangGraph agent service instead of Skein. The Studio implements an authenticated
TanStack Start dashboard, Better Auth GitHub and GitLab.com sign-in and explicit
login-method linking, independent multi-account Git repository connections under
Settings, encrypted OAuth credentials, and tenant-scoped Story/repository/session
catalog tables. #41 adds GitHub App installation-
aware repository discovery, Add by URL, and catalog connection without cloning.
Fixture generation (#59) and reconnectable high-level status (#64) are now implemented; publication remains a separate ticket. #43 adds GitHub Story discovery and bounded selection; #44 adds GitLab Story discovery and bounded selection.

## Frontend architecture (#38)

Studio uses TanStack Start/Router, React, **Tailwind CSS v4** and **shadcn with Base UI**. The registry configuration is `web/components.json`; use the official shadcn CLI (`cd web && pnpm dlx shadcn@latest add <component> -y`) to install or update UI primitives under `src/components/ui/`. Do not duplicate those components as handcrafted HTML/CSS wrappers. The Story graph continues using React Flow; its specialized visualizations and editor layout use targeted application styles in `src/style.css`.

**TanStack Query is the server-state layer.** The root router creates one `QueryClient` per SSR request; `@tanstack/react-router-ssr-query` dehydrates/hydrates server-fetched data. Route loaders prefetch important data (`dashboard`, `settings`, and `job`), and feature query keys cover repository listings, Story records/relationships, model catalogs, author prompts, Git changes and publication previews. Mutations invalidate affected keys, and sign-out clears the Query cache before navigation to prevent stale user data. Queries do not replace durable database, Git or LangGraph state.

**Internal application operations use TanStack Start `createServerFn`** (see `src/lib/*.functions.ts`) instead of browser `fetch()` to Studio JSON routes. They preserve the owner checks, bounded payloads, revision preflight and authorization enforced by the existing server-side handlers. Keep explicit HTTP endpoints for Better Auth/OAuth/provider callbacks, GitHub App installation return, SSE job-progress streaming, and compatibility with existing tools/tests; do not add new browser-facing JSON endpoints without a specific protocol or external-consumer requirement. The legacy internal HTTP handlers remain available during this migration and are not required by the new UI; their removal should be a separately audited compatibility change. Use ordinary React local state for short-lived form/interaction state and Router search parameters for shareable selections. **Zustand is intentionally deferred**, not installed.

## Story Conversations and Thread navigation (#78)

After initializing the current Drizzle Studio schema with the web services stopped, choose a Story on the Dashboard to open its **Conversations**. New generation jobs receive a stable root Thread within an automatically created Conversation. The prior Studio database is intentionally not migrated. Authors can create additional Conversations, edit Conversation and Thread titles, and switch between a compact ancestry-aware tree and an activity-sorted flat Thread list. The selected Conversation is shareable through the URL. Tree/flat and expansion preferences are stored per owner and Story.

The navigation reads the existing owner-scoped catalog, durable generation events and execution queue. Meaningful work and status transitions affect activity ordering; HTTP polling and SSE heartbeats do not. Running work shows the most recent specialist work item. Status distinguishes queued, running, paused, blocked, author attention, completed and archived where applicable. No existing LangGraph execution identity or job worktree is changed, and the legacy root mapping **does not** reconstruct historical forkable recovery checkpoints. Creating child Threads, branching and continuing runs are separate follow-up milestones of spec #73.

**Archive/restore (#89):** In a Story's Conversations page, use the Archive control on an active Thread. Archived Threads disappear from the default Active navigation but remain available under **Archived**, where any active ancestor nodes are shown as lineage context and the entire path is expanded. Use Restore to return the Thread to the Active view. Both operations are authenticated, owner-scoped and idempotent. They update only `story_threads.archived_at`; they do **not** stop running jobs, alter status/activity/title, remove worktrees or sessions, change message history, or invalidate verified recovery checkpoints. Active descendants of an archived parent stay visible and executable. Archived entries retain links to their original job's detail and recovery evidence. Permanent deletion and cleanup are not implemented by Archive.

**Permanent Thread deletion (#90):** Choose the trash control on a Thread in Active or Archived and confirm the irreversible operation. Unlike Archive, Delete reserves an owner-scoped cleanup plan and blocks later message admission and checkpoint branching. If generation is active, Delete first requests cancellation and returns a pending state; retry only after the writer reaches an idle boundary. Unfinished fork/restart reservations, published review branches, dirty/ignored/untracked files, ambiguous job locks, and changed Git identities refuse cleanup. Git worktree and branch removal is performed only against an exact registered identity, under the repository acquisition lease, with a compare-and-delete ref guard. Git object garbage collection is **never** run automatically; descendants and other refs retain their objects. Leaf job state (private graph checkpoints, transcripts and receipts) is removed; an ancestor with surviving descendants retains source receipts for lineage. Deleted ancestors remain noninteractive tree placeholders, and deleted leaf checkpoints cannot be branched from. If deletion fails halfway, its persisted plan and storage-byte accounting allow a safe retry without guessing paths or force-removing a worktree. There is no undelete operation. The original owner-scoped catalog identities and minimal deletion receipt remain for referential integrity and audit. Stopping Studio and running the explicit migration is required before enabling Delete.

**Restart and discard (#91):** From a Thread's Restart menu, choose the original pinned Story SHA or explicitly select a freshly checked newer upstream SHA, then enable **Restart and discard old Thread**. The server prepares an independent run and verifies its Git SHA, native validator version, Story canon, generation scope and (for newer commits) protected-decision ancestry before attempting any old execution cleanup. A failed preparation leaves the original execution untouched. Once the replacement is registered, deletion first requests cancellation of active execution; an unsettled author message, writer lock, dirty checkout, external publication, or changed Git identity prevents resource removal until safe. The prepared child remains usable even if cleanup fails. Retry with the same selection in the open dialog; if the old Thread shows **Deletion pending** in Conversations, use **Retry Thread cleanup** there after inspection, including after a reload. A partially completed purge resumes its pinned deletion plan without moving the author's checkout or pruning Git objects. Existing descendants retain their lineage; a deleted ancestor is a noninteractive placeholder. The replacement is prepared, not automatically started—review its task and budget before running it. No additional schema migration is required beyond #90.

Run `pnpm --filter @noveltea/studio migrate` while Studio is stopped **before** deploying this code; the running server refuses a missing migration.

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

Configure **both** login and integration callbacks in each provider application:

- **GitHub App** (not a GitHub OAuth App): `<BETTER_AUTH_URL>/api/auth/callback/github` and `<BETTER_AUTH_URL>/api/integrations/git/callback/github`
- **GitLab.com OAuth application**: `<BETTER_AUTH_URL>/api/auth/callback/gitlab` and `<BETTER_AUTH_URL>/api/integrations/git/callback/gitlab`

The same provider client ID/secret is used for its two separate authorization flows. Each callback URL must be explicitly registered with that provider (or OAuth returns to an invalid redirect). The integration flow uses a single-use server-side state, PKCE and an authenticated Studio session; it creates **only** a repository connection, never a Better Auth login account. Existing linked login accounts remain valid sign-in methods until explicitly unlinked. Git identity connections can be shared across distinct Studio users without linking their Studio accounts.

**Settings Git accounts:** With Studio stopped, initialize the fresh schema with `pnpm --filter @noveltea/studio migrate` before starting. Settings → Git accounts shows both login-backed GitHub/GitLab identities and separately authorized repository accounts, merging records with the same provider identity for display. Both authorization methods are supported; there is no required credential upgrade. Repository imports retain the credential source selected in Add repository, and existing repository bindings remain unchanged on reimport. Under **Repository access → Change account**, Studio verifies remote repository identity and current push permissions before rebinding, including when selecting the sole Studio login for that provider. An account used for login cannot be unlinked while repositories still depend on its login token. Disconnecting a separate Git connection erases its stored tokens and suspends remote access without deleting repositories, Stories or jobs; reauthorizing the same provider identity restores the existing binding. Do not rotate `BETTER_AUTH_SECRET` without a credential-rotation plan, since encrypted repository tokens derive their key from that secret. Live OAuth callback/refresh/push testing against configured provider applications is still required for deployment certification.

For development the base URL is `http://localhost:3000`; deploy with HTTPS.
Create a GitHub App under Developer settings > GitHub Apps and copy its **Client ID**
and **Client Secret** (not the GitHub App ID). Give it **Email addresses:
read-only** under account permissions so Better Auth can retrieve a sign-in
email. For future repository operations, configure repository permissions
**Contents: read/write** and **Pull requests: read/write**; **Metadata: read**
is added automatically. Configure repository installation access for selected
repositories. Keep **Request user authorization (OAuth) during installation**
off: login and Add Repository are intentionally separate flows. Configure the
GitHub App setup URL to `<BETTER_AUTH_URL>/api/github/install/callback` and enable **Redirect on update** to return after changes to selected repositories. Set `GITHUB_APP_SLUG` (the slug in `github.com/apps/<slug>`) in addition to the App client credentials. Keep both OAuth callbacks configured; the login endpoint is `/api/auth/callback/github`, while Settings uses `/api/integrations/git/callback/github`. GitHub App installation selection uses a short-lived, one-use state bound to the existing signed-in user, with an HttpOnly SameSite=Lax installation cookie to survive GitHub setup redirects that omit the state parameter; it never asks for OAuth login again.
GitHub App user tokens derive permissions from the app installation and user,
not OAuth App scopes; `offline_access` is the only requested GitHub OAuth
scope (for refreshable user tokens). An authorized GitHub identity does not
itself grant access to uninstalled repositories.

GitLab receives `api` and `write_repository` (its default `read_user` is also
included). GitLab requires the `api` scope for merge-request APIs;
`write_repository` alone covers Git-over-HTTP but not those API calls.
All repository imports now start at **Dashboard → Add repository**, a single compact dialog that queries every connected GitHub and GitLab identity and presents one searchable list. The list is owner-scoped, excludes previously imported repositories, pages large provider results in 100-item batches, and imports in place without navigating away. Old `/repositories/add` and `/repositories/gitlab` URLs redirect to the dashboard picker. Connecting a new provider identity still happens through Settings.
Discovery uses the selected independent GitLab integration connection (or a permitted login-linked credential for an unbound repository), and lists
personal and group projects with Developer (access level 30) or higher access,
and checks the authenticated membership list again before connecting a stable
numeric GitLab project ID to the user's catalog. An archived project is excluded.
No filesystem clone occurs. Per-branch protection and later Git push authorization
are independently enforced when publishing. Expired or revoked provider access
blocks new discovery and connections with a reconnect diagnostic; stored catalog
entries remain until explicitly removed. GitLab.com is the only supported host.
GitHub repositories appear in the same **Add repository** dialog alongside GitLab projects. The expandable **Can't find a repository?** section accepts `owner/repository` or a `https://github.com/owner/repository` URL, and provides a **Configure GitHub App** action if a selected repository is missing. The GitHub App installation handshake still uses an HTTP POST so the browser receives its HttpOnly state cookie before navigating to GitHub; the callback returns to `/dashboard?addRepository=...` and reopens the dialog. The callback verifies installation access using the existing GitHub user token, and can complete the requested repository connection automatically. Organizations may require an administrator to approve an installation or selection update: the pending import remains visible for 24 hours, with a retry action. If you prefer to adjust an existing installation, use **Configure GitHub App**; the installation callback returns to the dashboard and reopens the consolidated picker after approval. Only repositories with actual push permission are accepted; suspended installations and installations without Contents: write are unavailable. Catalog connection creates a lightweight record, **not** a Git clone or Story. Repository permissions are checked again when connecting, not trusted from browser selection. GitHub installations are scoped to the selected authorized GitHub account; GitLab login does not grant GitHub repository access. Link a GitHub login or connect a GitHub repository account under Settings → Git accounts.

## GitHub Story discovery and size preflight (#43)

**Shared repository browser:** Both GitHub and GitLab use the single
`/repositories/:repositoryId` route and the shared
`-RepositoryStoryBrowser.tsx` component. Only the authenticated owner's
repository record determines the provider: the URL and browser cannot select
a different Git provider for a repository ID. Optional `directory` and
`commit` query parameters retain the same pinned selection on both providers,
for example `/repositories/<catalog UUID>?directory=story&commit=<SHA>`.
Older `/repositories/github/:repositoryId` and
`/repositories/gitlab/:repositoryId` links redirect to the canonical path,
preserving valid pinned search parameters; the destination still enforces
ownership. The dashboard offers **Browse repository** for an imported Story
when its repository exists, using its pinned source commit when available.
`story-workflows.functions.ts` dispatches to provider-specific server
handlers, which continue enforcing provider ownership, access, size/LFS limits,
and safe initialization. Empty repositories share the onboarding UI;
GitLab supplies an empty-project flag while GitHub reports an unborn HEAD.

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
agent or replace native narrative validation. Story registration requires the current Drizzle Studio baseline (`source_commit_sha`). On an
unmigrated Studio database, POST returns a specific HTTP 503 explaining how to run
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
revision assertion, not permission to choose arbitrary remote revisions. The Studio schema
records a durable pinned source SHA on each created session; reopening a job
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
the current Studio Drizzle schema for Story selection and job acquisition.

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

For the repeatable fresh-database certification matrix, enforced source
boundary and concrete PostgreSQL porting backlog, see
[Studio persistence certification](../docs/studio-db-certification.md) (#101).

Migrations have two deliberate schema owners, orchestrated by **one**
`pnpm --filter @noveltea/studio migrate` command. Better Auth's supported
Kysely migration planner owns `user`, `account`, `session`, `verification`,
and `rateLimit`. Drizzle Kit generates versioned, immutable SQL for the 29
application-owned tables from `web/src/db/schema.ts`; it deliberately does
not create Better Auth tables. `web/src/db/auth-reference.ts` supplies only a
foreign-key target for Better Auth's `user` table.

The command runs Better Auth's migrator **first**, then Drizzle's
`web/drizzle/` migrations, then Better Auth's runtime schema check and
SQLite integrity/foreign-key checks. The application migration journal is
`__drizzle_migrations`. The public `StudioDatabase` API exposes only the
Drizzle-backed persistence ports and a lifecycle `close()` method. Raw SQLite
handles are confined to the adapter, Better Auth's required embedded-driver
configuration, migration/schema maintenance, and the controller's isolated
read-only catalog. Normal Studio startup is read-only with respect to schema;
missing, stale or incompatible migrations (or schema drift) fail closed.

**Persistence expand (#94):** `web/src/persistence/contracts.ts` defines focused,
owner-scoped, Promise-returning ports for dashboard/catalog reads and settings
(default model, repository listings, legacy-login guard, and per-Story Thread
view preferences). `web/src/persistence/sqlite.ts` implements these contracts
with Drizzle and is assembled by `openStudioDatabase`. HTTP handlers obtain the
owner from the authenticated session; callers cannot supply a different owner
through request bodies. For tests, inject a contract implementation directly
into `readUserDashboard` or as the optional preferences dependency to
`settingsRequest`. These converted consumers do not read the SQLite driver.

**Transaction convention:** a port method is the unit of work. SQLite methods
perform all reads/writes synchronously and only return an already-settled
Promise; a multi-statement atomic method must use a synchronous Drizzle
transaction callback with **no `await` or asynchronous work inside it**.
Do not expose a generic cross-adapter async transaction callback: PostgreSQL
may implement the same owner-scoped business method using its own async
transaction internally. All application persistence targets the same Studio
SQLite database through Drizzle-backed ports. There is no separate application
storage, dual-write, or data synchronization mechanism.

**Generation persistence (#96):** `web/src/persistence/generation-contracts.ts`
defines queue admission/claim/recovery, owner-scoped job metadata and status,
configuration CAS, and paginated progress-event interfaces. The
`generation-sqlite.ts` Drizzle implementation uses `BEGIN IMMEDIATE` before
counting active slots and claiming the oldest queued sequence, preventing two
WAL connections from oversubscribing the concurrency limit. Each admission
pins the request and queue entry atomically; reconciliation conditionally
replaces an interrupted receipt in the same transaction. Start/finish require
the worker's exact durable lease, request, Thread and owner, and a stale lease
cannot finalize another worker's run. Crash fencing never auto-replays a writer.

The Promise-returning ports isolate SQLite-specific locking. A future
PostgreSQL implementation must serialize capacity reservation (for example
with dedicated slot/advisory locks) and claim FIFO rows with row locks such as
`FOR UPDATE SKIP LOCKED` in one transaction. Never count slots outside that
transaction. The queue/claim/recovery, progress events, and continuation
interfaces are now entirely Promise-returning. The SQLite implementations
remain synchronous *inside* their adapters to preserve `BEGIN IMMEDIATE`,
CAS conditions and multi-record atomicity, including the combined follow-up
session and queue admission. The agent queue serializes overlapping asynchronous
polls; SSE rechecks disconnect state after awaiting event reads.
LangGraph checkpoints and saved Pi sessions remain separate from Studio DB.
`web/test/generation-persistence.test.ts` exercises two independent WAL
connections and shared claim/cancel/recovery behavior.

**Persistence boundary (#100):** Studio's runtime database type exposes
`persistence` and `close()` only. The source check
`pnpm --filter @noveltea/studio persistence:boundary` runs within `pnpm check`
and rejects raw SQLite imports, raw statements, migration handles, or direct
SQLite-adapter imports in application services and routes. Its exemptions are
confined to `web/src/persistence/*-sqlite.ts` and `persistence/sqlite.ts` implementations, `db/connection.ts`,
`db/migrations.ts`, `db/migrate-cli.ts`, and `db/trusted-catalog.ts` (the
rootless controller's read-only host catalog); `lib/auth.ts` uses only the
internal driver accessor required by Better Auth. Test-only legacy white-box
fixtures live in `web/test/support/studio-database.ts` and cannot be imported
by application code. New normal-behavior tests should use the public ports,
with SQL assertions reserved for explicit schema/adapter certification.

For later schema changes: edit only the Drizzle application schema, run
`pnpm --filter @noveltea/studio db:generate`, inspect and commit the
generated SQL, snapshot and journal together. Run
`pnpm --filter @noveltea/studio db:check` before release. Never edit the
applied baseline or add Better Auth's tables to the Drizzle schema.
Deploy `web/drizzle/` with the application; set `NT_STUDIO_MIGRATIONS_DIR`
to an explicit directory if the deployment working directory is different.
Always stop Studio writers and run `migrate` as a separate deployment step.
Keep Better Auth pinned, and use the same stable secret and database path
on migration and runtime.

**Development schema reset:** The Studio application now uses a fresh
Drizzle migration baseline. Existing application tables without a Drizzle
migration journal cannot be adopted automatically. Back up any data you
wish to keep before resetting; this reset intentionally discards Studio
users, connections, repositories, Stories, jobs, and credentials. The
independent LangGraph/agent/checkpointer SQLite databases are **not**
affected.

To reset deliberately, stop Studio and any agent/worker processes first.
Set `NT_STUDIO_DB_PATH` to the **absolute path** of the Studio SQLite file
(the default is documented below). After making a backup, remove only
that file and its `-wal` and `-shm` companions with all writers stopped:

```sh
: "${NT_STUDIO_DB_PATH:?Set the absolute Studio DB path before resetting}"
# Back up the stopped database, including any WAL contents, first.
rm -f -- "${NT_STUDIO_DB_PATH}" "${NT_STUDIO_DB_PATH}-wal" "${NT_STUDIO_DB_PATH}-shm"
pnpm --filter @noveltea/studio migrate
```

For Docker Compose, stop services and perform this operation **inside the
Studio data volume**, then run the normal `init` service (or migration
command) and restart. Do not run `docker compose down -v`: that would also
remove unrelated state volumes. The explicit reset is a one-time cutover,
not a normal upgrade path.

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
comes from the browser. The current Studio baseline stores the durable request and
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
stopped to initialize the current Studio baseline. The **agent** is the sole writer of the per-job LangGraph checkpoint SQLite;
Studio only reads checkpoints at safe inspection boundaries. Application
and checkpoint SQLite persist separately from the evictable Git cache. A reconnect inspects the same state; a missing checkpoint,
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

The dedicated NovelTea agent runs LangGraph.js directly; Skein is no longer a
runtime dependency. Start it independently with
`pnpm --filter @noveltea/studio agent:worker` (or Compose's `agent` service)
after running database migrations. Configure `NT_AGENT_RPC_TOKEN` (a shared
private random token of at least 32 characters) and `NT_AGENT_RPC_URL` in the
trusted Studio environment. The agent requires its own private sandbox socket
and token, and holds the Pi credential decryption key. The web process never
receives the sandbox controller token or executes a generation graph. Live Pi
still requires a certified rootless controller and explicit per-user credentials;
fixture success does not establish literary/editorial approval.

**Finalized Pi transcript retention (spec #38).** Set
`NT_FINALIZED_TRANSCRIPT_RETENTION_DAYS` in the trusted agent environment (or
`web/.env` for Compose). The default is **30 days**, measured from the *later*
of completed execution and a verified linked GitHub PR/GitLab MR publication.
Use a positive integer (up to 36500), or `off` to disable automatic expiry;
invalid values prevent agent startup. The existing agent queue runs private
maintenance at startup and at most once per six hours, without another daemon,
public endpoint, migration, or separate scheduler. Failures leave files intact
and log no job paths or transcript contents.

Expiry is **not** based on JSONL modification time or job status alone. Only
completed, queue-settled, remotely linked jobs with the exact published Git
HEAD, clean worktree and stable owner-scoped catalog identity qualify. Any
active/paused/blocked/cancelled/interrupted, unlinked/unpublished or otherwise
unverified job remains protected, as do Threads with pending author messages,
unsettled Pi steering, active descendants or fork/restart reservations. Jobs
with foundation-conflict or specialist-choice session-hash evidence are
**categorically exempt**, even when completed and published: their approvals
and reconciliation checks still depend on exact original session bytes.
Complete jobs whose worktree, locks, state directory, usage evidence or
publication identity cannot be verified are also exempt, rather than silently
becoming nonrecoverable. Completed job checkpoints can be branched from their
independent immutable Git/stage proof; they never replay a removed Pi session.

Maintenance removes only job-local `sessions/` and `*-sessions/` JSONL files,
never LangGraph checkpoint SQLite, `job.json`, worktree, receipt JSON, trusted
approval records, review/fork proofs, or author-update evidence. Before the
first removal it atomically records a private `transcript-retention.json`
containing **only numeric usage and finalized publication provenance**, so
usage reports and permanent Thread deletion continue to work after restart.
The receipt contains no prompts, model output, credentials, raw transcript
paths or tool invocations. Repeated/partially interrupted sweeps are safe to
retry. Standalone CLI/demo Pi sessions, local traces, and sessions outside
these trusted job-local directories have no verifiable Studio finalization
proof and are **not** automatically deleted; they require separate operator
retention and backup policies. Raw transcripts remain sensitive until expiry:
do not publish or log them, and do not treat this policy as in-place redaction.

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
On a fresh page load, the authenticated Start server function hydrates the
latest 100 recorded events into TanStack Query; older events can be loaded in
100-event pages without an unbounded response. The job page owns one SSE
subscription across all its tabs, resuming after the newest hydrated event ID
and merging replay or live additions into the same Query cache. Tab changes
never reset this history or reconnect the stream. Activity shows the cached
timeline immediately; while another tab is selected, new events appear as an
unread count and a brief status notification. Relevant transitions invalidate
job status, execution controls, dashboard data, and pending author decisions.
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
initialize the Studio Drizzle schema before startup. Keep the Studio database on a
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

The Studio Drizzle schema stores durable `generation_config_json` on job sessions.
Run `pnpm --filter @noveltea/studio migrate` with the Studio server stopped
before deploying the UI. A saved draft survives a restart and is only
editable before generation. If a draft exists, fixture launch must match its
pinned task and canonical contract; a direct POST cannot replace it. An
invalid/stale/foreign draft fails closed.

The job's **Pi model and budgets** section supports per-user API keys
(OpenAI, Anthropic, OpenRouter, xAI, Google, Groq, Mistral) and device-code
subscription login (legacy OpenAI Codex, GitHub Copilot, Kimi For Coding,
Meta, Radius and xAI). Studio uses the official Pi 1.5.0 authentication API
and **never starts local OAuth callback listeners**. Providers which also
offer browser login are explicitly constrained to their device-code method.
The newer Pi `openai` ChatGPT subscription browser flow and Anthropic's
browser/copy-code subscription flow are not offered; use an API key instead.
Device-code authorization still uses outbound HTTPS and verification in the
user's browser, but no return callback is required.

The selected provider, model and optional reasoning level are verified
against that signed-in user's available Pi catalog and persisted as part
of the immutable job draft. The GET/POST/DELETE `/api/pi/models` endpoint is
authenticated, origin-checked for writes, and exposes only model metadata,
device verification codes and temporary prompts—not stored OAuth tokens.
Disconnecting or losing authorization removes availability and blocks any new
selection or fixture start pinned to that model; the existing draft and worktree
remain intact for recovery. The job cannot silently switch to a host model.

**Shared author decisions:** The job's **Author questions and approvals** panel
is the sole active browser interface for questions, exact protected proposals,
Foundation no-write conflicts and validator replacement reviews. All browser
interactions use the authenticated, same-origin `/api/jobs/:jobId/author`
endpoint. Exact recovery approvals use one typed `action: "decision"` contract:
`id`, `proposalSha256`, `decision: "approved" | "rejected"` and an **optional**
`note` (at most 1,000 characters). No author-written reason is required;
notes on narrative conflicts can guide later specialists, whereas validator
notes are audit annotations. The common controller records principal, exact
proposal, verdict, optional note and timestamps in bounded, durable
`author-decisions/` receipts, with an idempotent in-progress recovery state.
Earlier specialized approval receipts remain readable and enforce their
original permissions. Retired browser endpoints `foundation-review` and
`validator-upgrade` now respond HTTP 410; neither can authorize a job.

**Specialist creative questions:** The Character/World specialists may pause
when 2–4 substantively different, canon-consistent creative alternatives
remain and the choice affects the Story. The specialist must provide a
question, an approach with benefits and trade-offs for each option, and exactly
one grounded recommendation with reasoning. Ordinary syntax errors, duplicate
typed IDs and broken references should instead be repaired and revalidated
automatically; the agent must not manufacture an author question for routine
implementation failures. The existing **Author questions and approvals**
panel presents the alternatives, flags the recommendation, and **always**
provides a free-text `Something else` answer. Extra instructions are optional.
The owner-only, same-origin `/author` endpoint accepts a typed `choice`
action bound to the exact proposal digest; the selected option or custom text
is stored with authenticated user identity and a saved Pi session/file snapshot.

A question is a deliberate safe boundary, not a failed writer. The original
session JSONL, pinned Git HEAD and (if present) all independently audited,
unchanged draft bytes are preserved. The user must first answer, then explicitly
click **Resume**; no author response automatically launches a model call. The
same Pi session is reopened and receives the saved answer. Changed or unsafe
draft files, stale proposals, altered transcripts, unexpected file operations,
and uncertain process termination all fail closed. Once claimed for
continuation, the resumed writer is never automatically replayed after a crash.
Native validation and exact protected-change authorization remain mandatory.
The shared question/answer receipt and UI are reusable by other specialists;
the running specialist integration is currently Character/World only.

A completed, no-write Foundation specialist may request a job-scoped exception;
authorizing it preserves every original protected decision while permitting one
explicitly requested retry. If the previously pinned native validator is no
longer installed, the shared review panel offers a second exact validator
replacement decision after validating the unchanged Story against the mounted
replacement. The validator adapter retains old and new SHA-256 identities in
its audit journal, and repairs only a matching partial update. Dirty or
ambiguous writers, stale proposals and changed executable bytes fail closed.
Neither approval automatically starts generation. Jobs with committed revisions
still require a separate history-aware validator migration.

**Blocked specialist inspection:** Once a queue finishes, the owner-scoped job
page reads the saved generation checkpoint even when an incomplete specialist
left uncommitted files. It shows the original bounded failure reason, active
work item, and read-only Character/World reconciliation inventory and candidate
digest. This is **inspection only**, not a verified revision or authorization
to publish. Uncommitted Story files are preserved; the canonical explorer,
committed diff view, and publication remain unavailable while the tree is dirty.
For a duplicate-Character failure, correct the existing canonical Character
file instead of introducing a second filename for the same typed ID, and repair
referencing records. An operator can then use the original
`job foundations inspect`, `job foundations reconcile --digest <corrected-digest>`
and `job foundations run` workflow to validate and commit **the corrected
bytes**, rather than trusting the original model's failed draft digest.
The parent generation checkpoint also requires explicit reconciliation before
Resume becomes available. Studio does not silently restore, replay, or commit a
failed writer. Future Character specialists receive existing linked Character
sources and can use bounded same-session repairs for reported architectural
conflicts.

**Operator prerequisite:** set `NT_PI_CREDENTIAL_KEY` to an independently stored,
base64-encoded random 32-byte key (generate with
`node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`)
and run `pnpm --filter @noveltea/studio migrate` with Studio stopped to initialize
the current schema. The app stores AES-256-GCM encrypted Pi provider credentials
in `pi_credentials` keyed by the Better Auth user ID, with revision-checked
OAuth refresh writes. Keep the encryption key outside the Studio SQLite backup
but back it up securely: **losing/changing the key makes existing connections
unreadable**, and runtime requests fail closed. The Pi SDK's runtime is built
with the per-user credential store and with filesystem model configuration
disabled; it does not read shared host `~/.pi` auth/model files. In-progress
device-code polling is process-local, while completed provider credentials
survive restarts. Reconnect if the web worker restarts during authorization
or if provider access is revoked. An API key being
present does not prove the remote vendor will accept it until a real API call.

Job-level specialist-step, model-call, reported-cost and **active execution
time** budgets are enforced at safe specialist boundaries. Pi transcript usage
and cumulative active time are durable per job, including across worker restarts.
Time spent waiting for an author decision, or while a worker is stopped, is not
charged. A budget stop pauses generation without invalidating independently
verified commits; limits can be raised without resetting usage. Fixture runs
never make model requests.

The owner-scoped generation draft also accepts requested sandbox CPU cores,
memory (MiB), and process counts. The read-only trusted controller derives
Docker limits from the saved, pinned Studio job—not HTTP, prompts or sandbox
tool arguments. Its operator maximums clamp requests; absent requests preserve
1 CPU, 512 MiB RAM without swap, and 128 PIDs. The operator's default hard
maximums are 4 CPUs, 2048 MiB and 512 PIDs, adjustable only through controller
environment variables `NT_SANDBOX_MAX_CPUS`, `NT_SANDBOX_MAX_MEMORY_MIB`
and `NT_SANDBOX_MAX_PIDS`. Changed limits cannot silently reuse an existing
container with a different resource label. Docker commands continue to have
a separate hard 30-second timeout and bounded output.

The native catalog/owner-scoped integration cases are covered in
`web/test/story-explorer.test.ts`, with fixture-start binding covered in
`web/test/fixture-jobs.test.ts`.

## Job queue, controls, and crash recovery (#67)

Initialize the Studio Drizzle schema while Studio is stopped:
`pnpm --filter @noveltea/studio migrate`. The durable SQLite
`generation_run_queue` reserves at most **two** active generation runs by default.
Set `NT_STUDIO_MAX_ACTIVE_JOBS=1..32` in the host environment to change that
limit. The **agent** polls and drains FIFO entries on startup and every 250 ms
without browser traffic. A queued run is reconstructed from its pinned
Story/job/thread and encrypted owner-scoped Pi credential store, not its
originating browser connection. Browser disconnect does not cancel execution.
Studio never executes or pumps the queue inline.

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
to step, model-call, reported-cost, or active-time limits while paused, but never a decrease,
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

**Deploy:** stop Studio and run `pnpm --filter @noveltea/studio migrate` to
initialize the current schema (including reviewed-content digests, durable
author drafts, and separate Pi discovery sessions). Set `NT_STUDIO_SKILLS_SOURCE` to
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

### Git change overlays (#68)

The hierarchy and bounded relationship graph show two separate Git states:
**verified** additions/modifications/deletions between the job's pinned base
and its trusted HEAD, and **uncommitted** changes between that HEAD and the
index/working tree. All Story Markdown changes are considered (the activity
feed's 24-file limit does not apply). The tree rolls up changed descendants,
including historically identified arc members. Deletions remain non-clickable
path/typed-ID placeholders, and files missing from the native typed index
remain path-only, non-clickable entries. For deleted records, typed labels
come only from bounded historical Git Markdown frontmatter; absent or invalid
metadata is not guessed from directories. These overlays never grant edit
access, alter structural/protection status, or create native relationships:
Git-only graph placeholders are isolated nodes without inferred edges. A
changed HEAD without a trusted verified-head receipt fails closed. Revalidate
the explorer to refresh working-tree indicators without advancing HEAD.
The explorer integration test exercises the verified/uncommitted split,
restored trusted receipt, deletions, unindexed paths and more than 24 changes.

## Draft GitHub publication (#69)

On a GitHub generation job, choose **Preview validation and upstream** in the
Draft GitHub pull request section. The read-only preview rechecks the connected
GitHub App installation, repository identity and current default-branch SHA;
verifies the trusted job revision and clean worktree; runs the pinned canonical
Story validator and protected-decision checks; and assesses Git merge conflicts
against upstream without merging or rebasing the worktree. Missing current-head
scope review and any upstream divergence are reported as blockers. A saved
single-commit onboarding draft is verified by its original content digest.
Canonical rejection, unchecked protection on an established Story, dirty files,
unsafe Git ancestry or incomplete revision receipts prohibit publication.

Click **Push branch and create draft PR** only after reviewing the preview.
Partial but structurally validated work requires explicit blocker confirmation
and publishes a draft, never a final PR or merge. POST requires the exact
previewed job HEAD and upstream SHA and rechecks both before writing. The
server uses normal non-force Git pushes; remote divergence is rejected. The
linked PR number, URL, target and last head live in the durable
`github_publications` table, separate from the evictable Git cache. A pending
publication intent is persisted before the push, and retries reconcile any
remote branch and existing draft PR before creating one. Later publication
updates the same draft PR; closed or non-draft PRs require manual reconciliation.
A failed push or lost GitHub authorization preserves the local job branch.

Routes: `GET/POST /api/jobs/:jobId/publish`, owner-authenticated and
same-origin protected for writes. Migrate before starting Studio using
`pnpm --filter @noveltea/studio migrate`. The local integration test uses a
real bare Git remote with a GitHub API fixture (including restart, stale
upstream, duplicate-PR prevention and divergent remote branch):

```sh
pnpm --filter @noveltea/studio exec tsx --test test/github-publication.test.ts
```

Real GitHub credentials and live push/PR publication remain part of #71's
end-to-end certification; this test does not claim to certify provider access
or hosted GitHub behavior.

## Draft GitLab publication (#70)

The same authenticated job publication page and `GET/POST /api/jobs/:jobId/publish`
endpoints also support GitLab.com Stories. GitLab publication uses the **same
pinned native Story validation, protected-decision, clean verified HEAD,
read-only upstream merge assessment, partial-draft confirmation, and non-force
push contract** as GitHub (#69). On every request, the provider adapter
rechecks the current GitLab OAuth connection, writable project membership,
immutable GitLab project ID/path and default branch commit. A lost grant or
failed push leaves the job's original committed worktree untouched.

GitLab drafts use the documented `Draft:` title prefix. The first successful
publication creates an MR from the isolated job branch without deleting it;
subsequent publication updates the **same draft MR description** with current
validation status, unresolved obligations, and GitHub-independent GitLab links.
If an existing MR is closed, merged, marked ready or points at a different
project/branch, the controller rejects rather than creating a second MR or
forcing it back to draft. An ambiguous create is reconciled by exhaustive
source-branch lookup. Migration **14** stores the MR's IID, URL, target, last
verified HEAD and pending/linked phase outside the Git cache in
`gitlab_publications`. Run `pnpm --filter @noveltea/studio migrate` before
starting a deployment built with #70.

The offline integration test uses a real bare Git remote and simulated GitLab
API: authentication/foreign-job rejection, upstream staleness, explicit partial
authorization, failed push, durable restart, duplicate-MR reconciliation,
remote divergence, lost permissions and a no-longer-draft MR.

```sh
pnpm --filter @noveltea/studio exec tsx --test test/gitlab-publication.test.ts
```

Live GitLab.com OAuth, push and MR behavior remain an explicit end-to-end
certification obligation under #71. No workflow automatically merges, rebases
or advances an existing default branch.

## Acceptance/testing limitations

The isolated migration/restart and user-ownership tests do not invoke live
GitHub/GitLab authorization servers. Complete OAuth redirect, refresh and
organization-permission acceptance requires registering a real GitHub App and
GitLab.com OAuth application and running the provider flows. Login and linking
buttons are present but will not work without those credentials.
