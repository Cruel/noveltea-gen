# Rootless Story sandbox containment certification (#55)

This certification covers the hosted **Story content** sandbox, not future NovelTea engine-record editing, a complete production deployment, or an independent security audit. The authoritative layout is [Story content layout](story-content-layout.md): a verified job worktree's `<workspace>/story` is the **only** bind mount, projected as `/story`. The sibling `.story-inbox/`, Git metadata, tokens, job receipts, other jobs, Docker API and the host filesystem remain outside the sandbox.

## Reproduce on the target Linux host

Use the **same rootless Docker context and unprivileged user** as the host controller. The test creates disposable test fixtures and containers; it does not use or modify the application's catalog/volumes. Build the sandbox image first (`docker build -f deploy/sandbox.Dockerfile -t noveltea-sandbox:local .`), then run:

```sh
docker info --format '{{json .SecurityOptions}} {{.CgroupVersion}}/{{.CgroupDriver}}'
# Must include name=rootless and 2/systemd.
NT_TEST_ROOTLESS_SANDBOX=1 pnpm --filter @noveltea/studio exec tsx --test test/sandbox-controller.test.ts
NT_TEST_ROOTLESS_SANDBOX=1 pnpm exec tsx --test test/sandbox-pi-tools.test.ts test/story-context.test.ts
pnpm check
```

The opt-in tests are skipped unless `NT_TEST_ROOTLESS_SANDBOX=1` is set. **A skipped test is not a successful host certification.** The configured image must exist locally. Do not bypass the rootless/cgroup precondition to make a failing host pass.

## Acceptance evidence

| Boundary | Evidence |
| --- | --- |
| Registered, pinned job identity | Controller unit tests reject unknown UUIDs, tampered manifests, redirected linked-Git pointers, and legacy registered roots before Docker create. An old per-record container label cannot be adopted; an authorized controller may dispose it and acquire a current-layout container. |
| Single trusted content mount | Real Docker `inspect` checks exactly one bind mount at `/story`, rooted in the registered worktree's `story/` directory. The container reads/writes a newly created, previously unknown record-type directory without controller changes. |
| Other jobs, author inbox, Git, credentials, host/controller | A real container cannot resolve an adjacent job's private record, sibling `.story-inbox` idea, Git pointer, controller secret/socket, state/cache paths, Docker socket or traversal into the parent workspace. The host-side fixtures retain their original bytes. The root filesystem is read-only, the network mode is `none`, all capabilities are dropped, and no-new-privileges is enabled. |
| Unsafe paths | Mock-controller tests reject hidden files and directories, `.git`, nested inboxes, symlinks, FIFOs and manipulated worktree ancestry. Pi adapter tests reject absolute host paths, traversal and hidden paths for structured reads/writes/search before they reach the sandbox. Real Pi-tool tests exercise all seven file/search/bash tools inside Docker and deny host fallback. |
| Enforced rootless resource budgets | Docker is required to report rootless, cgroup v2/systemd. Actual Docker HostConfig and **in-container cgroup** values certify 512 MiB RAM, disabled swap, 128 PIDs, and a one-CPU quota; the container also has a read-only root filesystem. Controller code additionally bounds output to 64 KiB and execution to 30 seconds; a mocked output-overflow test verifies fail-closed teardown and reacquisition, alongside unsafe writer-boundary tests. These tests validate configuration and kernel enforcement surfaces, not an intentional OOM/fork bomb. |
| Execution isolation and recovery | A real delayed background writer is killed before command completion is reported and cannot mutate the Story afterward. A stopped sandbox is restarted; a destroyed sandbox fails execution closed until reacquired from the registered job. Disposal is idempotent, and a new container can be acquired without losing canonical Story bytes. No host execution fallback exists. |
| Protected Git/validation boundary | Production Pi file tools operate only on `/story` (plus narrowly verified, pinned skill reads). Native validation, Git commits, approvals and their receipts remain trusted-orchestrator operations. The hosted integration test in `test/sandbox-hosted-live.test.ts` separately checks the approval interrupt and these paths using disposable registered jobs. |

## Failure states and recovery

- **Invalid job identity, legacy Story root, moved Git pointer or manifest mismatch:** Fail before creating/mounting a container (HTTP 400/404/409 as applicable). Preserve the worktree and state; reconcile or migrate the Story through a trusted Git revision and create a new registered job. Never silently repoint an active job.
- **Hidden entry, symlink, FIFO or unsafe mount ancestry:** Acquisition rejects the projection (HTTP 409/422); inspect and correct the Story in the trusted worktree. No automatic deletion or migration.
- **Old container layout, changed image or conflicting container name/labels:** Reject reuse (HTTP 409). Inspect before authorized disposal. A legacy *Story identity* must be migrated first; the controller cannot dispose a job it no longer trusts.
- **Unavailable/rootful Docker, missing cgroup delegation or image:** Controller startup/acquisition fails (typically 503 for Docker/image). Do not bypass isolation or run local Pi tools.
- **Stopped or destroyed sandbox:** Commands fail or inspection reports stopped/not acquired. Once the last writer is accounted for, `acquire` rechecks trusted identity and Story projection and starts or creates an isolated sandbox. Previous Git and Story files are not deleted.
- **Command timeout/output overflow, Docker stop/start failure:** The controller destroys the container or fails closed when destruction cannot be proven. Treat the writer result as **unknown**, inspect receipts, worktree and partial edits, and never blindly replay a non-idempotent writer or approve an action from a model's claim.
- **Agent private socket/token missing or controller offline:** Pi tool creation/operation fails; it cannot switch to host shell, host file reads, or an unauthenticated controller.

## Scope of this evidence

The test harness verifies a real local rootless daemon and image, not a separate production Compose deployment with live authentication. Production volume backup/restore, hostile co-tenants with independent host-level access, external pen testing, and model-assisted end-to-end runs are distinct activities. The paid Pi integration can be run separately with `NT_LIVE_HOSTED_SANDBOX=1` and an installed skills checkout as documented in [deployment verification](../deploy/README.md#verification); a passing fixture or sandbox certification must not be represented as that live model test.

On **2026-11-01**, this checkout passed the opt-in real controller suite (**16 passed, 0 failed**) and the Pi/context suite (**15 passed, 0 failed, 1 native-CLI-dependent skip**) on rootless Docker with `2/systemd` cgroups and local `noveltea-sandbox:local` image. Repeat these commands against the actual deployment host after upgrades or changes to the image, mount policy, controller, or tool adapter.
