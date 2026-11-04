# One-command rootless Compose deployment

This is the deployment *foundation*, not the completed multiuser agent execution
flow. #52–#54 route narrative Pi file/search/shell tools through the private
sandbox client; reviewers receive read/search only. There is no implicit
host-tool fallback. #55 certifies real rootless containment and recovery;
see [sandbox certification](../docs/sandbox-certification.md). The combined release gates and real-provider evidence requirements are in [self-hosted certification](../docs/self-hosted-certification.md) (#71).
The dedicated agent owns the durable queue, direct LangGraph execution and typed
user-message resumes. Only the authenticated web service can call its private
command endpoint; never expose port 7001 or enable unsandboxed Pi tools.

## Trust boundaries

- **Web** (TanStack Start) serves authenticated OAuth and Story catalog APIs.
  It has its own durable app SQLite volume, shared durable job state and the
  evictable Git cache volume. It has no Docker socket or controller credentials.
- **Agent** is a dedicated single-process LangGraph.js worker, independently
  consuming Studio's durable FIFO queue. It shares the application SQLite
  catalog for owner-scoped admissions, job state, worktree cache, and the
  per-job graph checkpoints stored outside the application database. Only
  this trusted worker receives the private controller Unix socket/token.
  Its authenticated author-command endpoint stays on the unpublished Compose
  backend bridge; neither Studio nor agent tools expose the controller token.
- **Controller** is a dedicated trusted Compose service operating
  with the same **host-level rootless Docker** daemon. It looks up the job in
  the Studio catalog and checks the pinned worktree manifest before computing
  any host mount. HTTP callers provide ONLY a registered job UUID. Only the controller service mounts the rootless daemon socket. The web,
  agent, init service, and job sandboxes never receive it.
- **Job sandbox** is a disposable sibling container on the same daemon.
  `--network none`, read-only container filesystem, no capabilities, no new
  privileges, bounded CPU/memory/PIDs/tmpfs/output/execution time and no host
  controller/socket/credential/Git mounts. The verified canonical content
  directory (`<workspace>/story`) is the **only** writable mount at
  `/story`: a validated named-volume subpath in Compose, or a bind mount
  in host-only mode. New record-type directories are included automatically.
  Hidden, symlinked and special entries in the mounted tree are rejected.
  `.git` and the sibling `.story-inbox` remain outside the mount. Legacy
  repository-root Stories or Stories containing an inbox must migrate before
  hosted acquisition; the controller fails closed rather than exposing them.
  See [Story content layout](../docs/story-content-layout.md).

**UID note:** Containers run as namespace UID 0 to give the rootless daemon's
unprivileged host owner write access to shared cache mounts. This is not host
root. All capabilities are dropped. Non-root *container* user IDs require
verified idmapped bind-mount support or matching subordinate-UID ACLs; do not
weaken filesystem access controls just to make them write. Repeat #55's
rootless containment and cgroup certification on each target deployment host.

The controller verifies rootless Docker, cgroup v2/systemd, a fixed rootless
image ID, volume mountpoints, catalog owner/repository/Story/pin, deterministic
state and worktree paths, manifest identity, linked-Git pointer, path ancestry,
and record-tree filesystem type before acquisition. The controller is the
**only** process allowed to execute Docker lifecycle commands. It never accepts
a mount path, image, network mode or daemon argument from web or model input.

## Quick start (Linux, rootless Docker)

From the repository root, after configuring the **single** Git-ignored `web/.env` file:

```sh
docker compose up -d
docker compose ps
```

The first command builds the trusted application and minimal sandbox images,
creates the four named persistent volumes, generates the private controller token,
applies Studio SQLite migrations **before services start**, starts the trusted
controller service, and waits for the agent's authenticated health check before
starting the web server. Later invocations are idempotent. This is the supported
deployment path; **no** manual host controller, `docker build`, `docker compose
create`, token-file generation, or migration command is required.

Prerequisites: a Linux **rootless Docker daemon** with cgroup v2/systemd and
delegated CPU/memory/PID controls; the Docker Compose plugin; the native NovelTea
CLI and `noveltea-skills` checkout. The defaults are the sibling paths
`../nt/build/cli/linux/noveltea` and `../noveltea-skills`. These work with
the standard NovelTea checkout layout and require **no second env file**.
For a different installation, override `NT_NATIVE_CLI_HOST` and `NT_SKILLS_HOST`
from the shell or a Git-ignored root `.env`, for example:

```dotenv
NT_NATIVE_CLI_HOST=/absolute/path/to/nt/build/cli/linux/noveltea
NT_SKILLS_HOST=/absolute/path/to/noveltea-skills
```

Compose rejects nonexistent mount sources instead of creating placeholder
host paths. The optional root `.env` is for Compose mount interpolation;
`web/.env` remains the only required runtime-secrets file. The rootless
Docker socket defaults to `/run/user/1000/docker.sock`; override it using `NT_ROOTLESS_DOCKER_SOCKET`
when the host UID or socket path differs. Missing native CLI / skills / socket
mount sources fail the deployment rather than silently creating empty paths.
The native CLI is bind-mounted read-only into the trusted web and agent services;
no native executable, skills repository, or Docker socket is mounted into
an untrusted job sandbox.

Populate `web/.env` from `web/.env.example`: configure `BETTER_AUTH_URL`
(`http://localhost:3000` for local testing, HTTPS behind a reverse proxy
for remotely reachable deployments), `BETTER_AUTH_SECRET`, GitHub App and
GitLab OAuth credentials, `NT_PI_CREDENTIAL_KEY`, and
`NT_AGENT_RPC_TOKEN` (at least 32 characters). Reuse stable encryption and
authentication secrets across restarts; changing them invalidates existing
OAuth data or sessions. Studio accepts provider API keys or upstream Pi's
OAuth device-code login for supported subscription providers; it does not
create localhost callback listeners. Local `pnpm dev` and Compose
use **separate** database locations. Starting Compose fresh does not migrate
existing dev jobs or Pi logins.

The controller token is generated on first startup and stored in the
`noveltea-controller` named volume. Its Unix socket and token are
shared only with the trusted agent; the web service receives neither.
The controller alone has the rootless daemon Unix socket, with
`network_mode: none`, dropped capabilities and no new privileges.
The job sandboxes remain isolated rootless sibling containers, with
a single validated `/story` mount, no networking, and no Docker socket.

Inspect health / failures:

```sh
docker compose ps
docker compose logs --tail=100 init controller agent web
```

Stop without deleting user data:

```sh
docker compose down
```

**Destructive reset**: `docker compose down --volumes` deletes the
`noveltea-app`, `noveltea-state`, `noveltea-cache`, and
`noveltea-controller` volumes, including encrypted ChatGPT credentials,
job checkpoints and unpublished work. Never use this to repair a failed job.

Only the web port is published, bound to loopback by default. To expose Studio
remotely, configure a trusted HTTPS reverse proxy with request limits and
align `BETTER_AUTH_URL` and OAuth redirect origins. Never publish the
agent's port 7001 or the controller socket.

## Live web development with Compose

Production remains the default: `docker compose up -d` starts `web`,
which serves the built TanStack Start application. The **same**
`compose.yaml` also defines a `web-dev` service in the optional `dev`
profile. It inherits the production web environment, persistent volumes,
private network and health check, but runs Vite with hot module replacement
(HMR). No second Compose file is required.

To switch an existing deployment to development mode:

```sh
docker compose stop web
docker compose --profile dev up -d --scale web=0
docker compose --profile dev logs -f web-dev
```

For a fresh development deployment, only the second command is needed.
The `--scale web=0` flag keeps the production web container off; both
variants bind the **same** localhost port 3000 and must not run together.
All other services continue running with the same storage and credentials.

Open `http://localhost:3000`. Edits under `web/src/` are reflected without
an image rebuild (client HMR or a full reload for server-side modules).
`web/vite.config.ts` is also mounted. Only those paths are mounted so
the image's pnpm-installed `node_modules` remain available. The port stays
localhost-only. An initial image build is still necessary, and changed
dependencies, root `src/`, or backend agent/controller code require
rebuilding the relevant image.

To return to production:

```sh
docker compose --profile dev stop web-dev
docker compose up -d
```

Never run both web profiles at once, or `down --volumes` when switching
modes: the latter destroys saved Studio data and job state.

## Controller API (trusted agent only)

All requests go to the private Unix socket with
`Authorization: Bearer <controller token>`. Only registered job UUIDs are
accepted; IDs are not filesystem paths. Do not forward browser requests here.

| Method | Path | Input | Result |
| --- | --- | --- | --- |
| POST | `/v1/sandboxes` | `{"jobId":"<uuid>"}` | Acquire verified container; status |
| GET | `/v1/sandboxes/<uuid>` | none | Inspect existing identity/status |
| POST | `/v1/sandboxes/<uuid>/exec` | `{"argv":["command","arg"]}` | NDJSON stdout/stderr and exit code |
| DELETE | `/v1/sandboxes/<uuid>` | none | Destroy ephemeral container only |

The agent-side `SandboxClient` implements all four operations without exposing
Docker options. Exec runs inside the sandbox with a fixed `/story` working
directory. Output is bounded to 64 KiB per call and commands to 30 seconds.
After each foreground command (including nonzero exit), the controller stops
the entire container with zero grace and restarts a clean init before returning
the command result. This kills orphaned/background writers before the trusted
worker's validation or commit boundary. While an exec is active, acquire,
another exec, and dispose for that job are rejected. A failed stop/start tears
down the sandbox and fails closed; a timeout or output overrun destroys it.
Never blindly replay an interrupted writer.

## State, restart and failure behavior

Durable `noveltea-app` holds Studio OAuth/catalog data and the job queue;
`noveltea-state` holds Story manifests, receipts, locks, sessions and
per-job LangGraph checkpoints. They are separate SQLite databases.
`noveltea-cache` is evictable only according to future #50 policy and
**must not be removed as a substitute for stopping a sandbox**.

- Unknown UUID, inconsistent catalog pins, missing/tampered manifests,
  redirected worktrees or unexpected container labels fail closed; inspect
  the original job, never recreate or reset its Git branch.
- Missing rootless engine, missing cgroup limits, untrusted storage, invalid
  image or an unacquired container fail explicitly. The host controller
  does not fall back to local shell execution.
- Stopping/restarting the web and agent processes retains all volumes.
  Controller restart retains containers but re-verifies labels and job
  identity before reuse. Image replacement prevents reusing an old container
  for execution, but does not block authorized disposal. Disposal never
  deletes Git working files.
- The Compose controller checks whether a previous Unix socket is still
  live before reconciling a stale socket after restart. Host-only controller
  mode remains fail-closed and requires explicit operator reconciliation.
  Ambiguous Git/worktree state still needs manual reconciliation.
- The trusted graph worker acquires and verifies a registered sandbox before
  opening any narrative Pi specialist session, including CLI-launched jobs.
  The agent service requires the private controller socket and token;
  missing configuration fails closed regardless of `NT_REQUIRE_SANDBOX_TOOLS`.
  Pinned skills are read through a digest-verified, read-only trusted-worker
  adapter; the Story file tools are sandbox-only. The snapshot cache is stored
  on the durable job-state volume across agent restarts. Native `story_validate`
  remains bound to the trusted job identity and cannot accept model-provided
  paths or validator flags. There is no host-tool fallback for CLI jobs.
- Authenticated Studio requests persist queue entries without invoking the
  graph. The independent agent polls and claims work; interrupted writers
  require manual reconciliation before retry. A missing agent does not cause
  Studio to execute generation inline. Passing #55 does not certify this full flow.

## Verification

Run `pnpm --filter @noveltea/studio exec tsx --test
test/sandbox-controller.test.ts` to verify read-only catalog identity,
tampered worktree refusal, symlink denial, scoped mounts and authenticated
controller requests, UTF-8 chunk boundaries, background-writer cleanup
ordering and image-replacement disposal. Run `pnpm check` for existing
Story/Studio regressions. On a configured rootless Docker host, build the
sandbox image and run the actual delayed-writer regression with:

```sh
NT_TEST_ROOTLESS_SANDBOX=1 pnpm --filter @noveltea/studio exec tsx --test test/sandbox-controller.test.ts
```

The #52 adapter has an additional rootless smoke test for all seven Pi tools:
`NT_TEST_ROOTLESS_SANDBOX=1 pnpm exec tsx --test test/sandbox-pi-tools.test.ts`.

To certify Foundation and Architecture against the **real authenticated host
controller** without deploying Studio OAuth or the unfinished #59 web
scheduler, use the opt-in disposable registered-job integration test:

```sh
NT_SKILLS_CHECKOUT=/absolute/path/to/noveltea-skills \\
  NT_TEST_HOSTED_FIXTURE=1 \\
  pnpm exec tsx --test test/sandbox-hosted-live.test.ts

# Calls the configured Pi model for both Foundation and Architecture (paid):
NT_SKILLS_CHECKOUT=/absolute/path/to/noveltea-skills \\
  NT_LIVE_HOSTED_SANDBOX=1 \\
  pnpm exec tsx --test test/sandbox-hosted-live.test.ts
```

Optional `NT_PROVIDER` and `NT_MODEL` select the Pi provider/model. The test
requires the `noveltea-sandbox:local` image (override with
`NT_TEST_SANDBOX_IMAGE`) and host-level rootless Docker with enforced cgroup
limits. It creates an isolated temporary Git repository, registered Studio
catalog entry, controller socket/token and worktree; it sets
`NT_REQUIRE_SANDBOX_TOOLS`, `NT_SANDBOX_SOCKET` and
`NT_SANDBOX_TOKEN_FILE` automatically. It leaves existing Compose volumes and
Studio data untouched. On a failed run it preserves the disposable directory
for investigation; `NT_KEEP_FAILED_LIVE=1` also preserves a successful run.
This test calls production Foundation and Architecture functions directly.
It proves sandbox tool routing and containment, **not** web admission or
web-to-agent command execution.
It also checks denied host/hidden paths, pinned skill reads and missing-controller
fail-closed behavior with deterministic fixtures. Run `pnpm check` for the full
root and Studio suites. Set `NT_TEST_SANDBOX_IMAGE` if not using
`noveltea-sandbox:local`. The controller test
checks that a shell-launched background process cannot write after a
successful command boundary. It intentionally skips on ordinary development
hosts unless explicitly enabled; it must pass on the deployment host.
The #55 opt-in suite additionally inspects the **actual Docker mount and
HostConfig** and the **in-container memory, PID and CPU cgroup limits**. It
probes private paths, unknown record types, stopped/lost-container recovery and
disposal. Read [the #55 certification and failure-state matrix](../docs/sandbox-certification.md).
These tests do not certify a production Compose deployment, backup/restore,
or an independent adversarial penetration test.
