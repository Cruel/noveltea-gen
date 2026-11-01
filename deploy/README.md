# Rootless Compose and host sandbox controller (#51)

This is the deployment *foundation*, not the completed multiuser agent execution
flow. #52 routes Foundation discovery/writing and Arc/Milestone architecture
Pi file/search/shell tools through the private sandbox client. Other specialists
explicitly refuse hosted execution until #53/#54 route them; there is no
implicit host-tool fallback. #55 performs real-host containment and restart certification.
#59 adds authenticated web execution/admission. Do not expose the raw Skein Agent
Protocol listener or enable unsandboxed model-directed tool execution.

## Trust boundaries

- **Web** (TanStack Start) serves authenticated OAuth and Story catalog APIs.
  It has its own durable app SQLite volume, shared durable job state and the
  evictable Git cache volume. It has no Docker socket or controller credentials.
- **Agent** is the single private Skein/LangGraph process. It shares durable
  job state and the job cache, but has its own persistent graph SQLite volume.
  Only this trusted worker receives the private controller Unix socket and the
  controller bearer-token file. Raw Agent Protocol is reachable only on the
  Compose bridge; there is no published port.
- **Host controller** is a separate, trusted process outside Compose, operating
  with the same **host-level rootless Docker** daemon. It looks up the job in
  the Studio catalog and checks the pinned worktree manifest before computing
  any host mount. HTTP callers provide ONLY a registered job UUID. The daemon
  socket never enters Compose.
- **Job sandbox** is a disposable sibling container on the same daemon.
  `--network none`, read-only container filesystem, no capabilities, no new
  privileges, bounded CPU/memory/PIDs/tmpfs/output/execution time and no host
  controller/socket/credential/Git mounts. The verified canonical content
  directory (`<workspace>/story`) is a **single** writable bind mount at
  `/story`, including newly added record-type directories automatically.
  Hidden, symlinked and special entries in the mounted tree are rejected.
  `.git` and the sibling `.story-inbox` remain outside the mount. Legacy
  repository-root Stories or Stories containing an inbox must migrate before
  hosted acquisition; the controller fails closed rather than exposing them.
  See [Story content layout](../docs/story-content-layout.md).

**UID note:** Containers run as namespace UID 0 to give the rootless daemon's
unprivileged host owner write access to shared cache mounts. This is not host
root. All capabilities are dropped. Non-root *container* user IDs require
verified idmapped bind-mount support or matching subordinate-UID ACLs; do not
weaken filesystem access controls just to make them write. #55 must certify
the chosen host's confinement and quota enforcement before production use.

The controller verifies rootless Docker, cgroup v2/systemd, a fixed rootless
image ID, volume mountpoints, catalog owner/repository/Story/pin, deterministic
state and worktree paths, manifest identity, linked-Git pointer, path ancestry,
and record-tree filesystem type before acquisition. The controller is the
**only** process allowed to execute Docker lifecycle commands. It never accepts
a mount path, image, network mode or daemon argument from web or model input.

## Provision (Linux rootless Docker + systemd user session)

The host needs Node.js 24, pnpm 11.15, a rootless Docker engine, and a Docker
Compose plugin **using that engine**. Ensure `docker info` lists
`name=rootless`, cgroup version `2` and driver `systemd`. Cgroup delegation
must support enforced memory, CPU and PID limits. The controller refuses to
start on a rootful or unbounded daemon; never work around this by giving a
container the host's Docker socket.

1. Populate `web/.env` from `web/.env.example`. Configure a valid production
   HTTPS `BETTER_AUTH_URL`, GitHub App and GitLab credentials, and a separately
   backed-up stable `BETTER_AUTH_SECRET`. This file is operator-private; no
   secret values belong in Compose or Git. In this deployment, the app DB,
   state and Git cache paths are supplied by Compose. The native validator must
   be installed into the trusted web image or mounted separately before new
   GitLab Story initialization; an absent validator fails closed.
2. Provision a **private host** controller directory (0700) and token file
   (0600), for example under `$XDG_RUNTIME_DIR/noveltea-controller/`. Generate
   a random secret with `openssl rand -hex 48`. Set both
   `NT_CONTROLLER_SOCKET_DIR` to that **absolute** directory and
   `NT_CONTROLLER_TOKEN_FILE` to the **absolute** token-file path for Compose.
   Avoid logging or committing their contents.
3. Run `pnpm install --frozen-lockfile` and build:
   ```sh
   docker compose build web
   docker build -f deploy/sandbox.Dockerfile -t noveltea-sandbox:local .
   docker compose create
   ```
   `docker compose create` prepares the named volumes and nonrunning service
   containers. Keep these exact volume names: `noveltea-app`, `noveltea-state`,
   `noveltea-cache`, `noveltea-graph`.
4. Start the *host* controller **as the same rootless Docker user**:
   ```sh
   export NT_SANDBOX_SOCKET="$NT_CONTROLLER_SOCKET_DIR/controller.sock"
   export NT_SANDBOX_TOKEN_FILE="$NT_CONTROLLER_TOKEN_FILE"
   # From repository root, using the same Docker context:
   pnpm --filter @noveltea/studio host:controller
   ```
   For production, supervise this command with a systemd user unit, with
   `Restart=on-failure` and `Requires=docker.service` as appropriate for your
   rootless Docker installation. The controller binds an authenticated local
   Unix-domain socket, not a TCP listener. Configure no proxy for it.
5. **Before** application startup, explicitly apply migrations while service
   writers are stopped:
   ```sh
   docker compose run --rm --no-deps web pnpm --filter @noveltea/studio migrate
   docker compose up -d web agent
   ```
   Bind `127.0.0.1:3000` to a properly configured external HTTPS reverse proxy
   with request limits and rate limiting. The Compose bridge is not a public
   Agent Protocol endpoint. Do not publish agent port 7001.

The agent token is injected as a file secret and is never mounted in the
sandbox; its path inside the agent is
`/run/secrets/noveltea-controller-token`. The trusted worker's private client
uses `NT_SANDBOX_SOCKET` and `NT_SANDBOX_TOKEN_FILE` to connect.

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

Durable `noveltea-app` holds Studio OAuth/catalog data;
`noveltea-state` holds Story job manifests/receipts/locks/sessions;
`noveltea-graph` holds the Skein SQLite checkpoints.
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
- An existing controller socket is **not** automatically unlinked on start;
  confirm the old process is stopped before manual stale-socket cleanup.
  Ambiguous Git/worktree state still needs manual reconciliation.
- The trusted graph worker acquires and verifies a registered sandbox before
  opening a Foundation or Architecture Pi session. The agent service requires
  `NT_REQUIRE_SANDBOX_TOOLS=1`, the private controller socket and token.
  Pinned skills are read through a digest-verified, read-only trusted-worker
  adapter; the Story file tools are sandbox-only. The snapshot cache is stored
  on the durable job-state volume across agent restarts. Native `story_validate`
  remains bound to the trusted job identity and cannot accept model-provided
  paths or validator flags. CLI-local workflows without sandbox configuration
  retain their existing behavior.
- Other Pi specialists are not yet sandbox-routed and fail closed in hosted mode
  until #53/#54. The web job-preparation endpoint still does not initiate model
  execution until authenticated admission and scheduling are connected by #59.

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
Unlike the future #59 web-to-Skein flow, this test calls the production
Foundation and Architecture job functions directly. It proves the agent tool
routing through the real controller and Docker, **not** web admission or
Skein-to-controller deployment wiring.
It also checks denied host/hidden paths, pinned skill reads and missing-controller
fail-closed behavior with deterministic fixtures. Run `pnpm check` for the full
root and Studio suites. Set `NT_TEST_SANDBOX_IMAGE` if not using
`noveltea-sandbox:local`. The controller test
checks that a shell-launched background process cannot write after a
successful command boundary. It intentionally skips on ordinary development
hosts unless explicitly enabled; it must pass on the deployment host.
Real daemon binding, permitted Story writes, isolation escapes, UID behavior,
memory/cgroup constraints, cleanup after SIGKILL and Compose backup/restore
are required for **#55** on a real configured rootless Linux host; fixture
tests do not certify them.
