# Complete self-hosted application certification (#71)

**Status: not release-certified merely because this document exists or the automated local gates pass.** The acceptance decision requires real hosted-model generation, real OAuth refresh and draft publication on **both** providers, an independent creative-quality assessment, and actual deployment recovery. Every evidence type must be recorded separately; a fixture, mocked HTTP response, simulated Pi output or a CLI-only Story job is not a substitute for the corresponding live gate.

This complements [sandbox containment](sandbox-certification.md), [Story layout](story-content-layout.md), [native validator contract](validator-cutover.md), and the [Compose deployment guide](../deploy/README.md). All test Stories must have a canonical `<workspace>/story` subtree, with `.story-inbox/` and `.git` **outside** it. Legacy layouts fail closed and are not migrated by certification.

## Automated gates

Run from a **clean, committed** checkout containing the release candidate, after `pnpm install --frozen-lockfile`. A dirty checkout is rejected because its content cannot be identified by the reported Git revision. Set **absolute paths** for `NT_NATIVE_CLI` (actual native `noveltea`) and `NT_SKILLS_CHECKOUT` (the pinned skills checkout). Ensure this is a private test host, not the live production deployment.

```sh
export NT_NATIVE_CLI=/absolute/path/to/noveltea
export NT_SKILLS_CHECKOUT=/absolute/path/to/noveltea-skills

pnpm certify:self-hosted --offline
pnpm certify:self-hosted --host
pnpm certify:self-hosted --compose
```

The script saves `.local/certification/issue-71.json`, which is ignored by Git and contains only the revision, gate status, completion timestamp and high-level failure reason. **It does not capture credentials, prompts, traces, or Story text.** Results from other revisions are invalidated. On failure, the selected gate fails and the process exits nonzero; unrun gates remain `not-run`. A successful invocation means its *selected* gates passed, **not** complete release acceptance.

| Gate | What it proves | What it cannot prove |
| --- | --- | --- |
| `--offline` | Full `pnpm check`; canonical native validation, baseline protection, contextual dependencies; OAuth account creation/linking/persistence; 100 MB preflight; generation queue/controls; cached worktree and LRU behavior; both mocked-provider draft API and actual local Git push/restart contracts | Actual provider API permission, real model, real Docker or rootless resources |
| `--host` | Rootless Docker cgroups, one `/story` bind mount, arbitrary new narrative directories, denial of Git/inbox/symlinks/host paths, authenticated controller, resource limits, all agent tools including bash, controller recovery, and real Git-backed fixture Foundation → Architecture → Character/World → Event stages | Real model creativity, hosted OAuth, Compose restarts or remote draft |
| `--compose` | Exact Compose stack and its one-shot bootstrap: builds images, provisions four durable named volumes and private controller token, applies migrations, starts web/agent/controller in health order, authenticates private RPC, excludes rootless daemon socket from web/agent, executes a disposable registered job in a rootless sandbox with a single verified `/story` volume-subpath mount, and verifies independent restarts plus plain `docker compose down` → `docker compose up -d` with preserved state | Existing production-volume upgrades, ongoing writer interrupted by SIGKILL, OAuth callback across deployed worker replacement, real model or provider |
| `--live-pi` | Paid model-driven, web-authenticated, controller-backed Pi Foundation writes, canonical native CLI validation and verified Git commit with Story confined to `/story` | Real provider publishing, independent literary judgment or a complete multi-Milestone production run |

**Host requirements:** the same rootless Docker daemon for the host gate and Compose controller sidecar, cgroup v2/systemd, sufficient delegated resource controls, no rootful fallback. Only the trusted controller sidecar mounts the rootless daemon Unix socket; web, agent, initializer and job sandboxes never receive it. The host gate builds the minimal sandbox image and the Compose gate builds the trusted and sandbox images. The Compose certification **refuses** to run when any of the four named `noveltea-*` volumes or project containers already exist, or its chosen loopback port is occupied. It must never destroy a real author's deployment. It generates its own fresh disposable volumes, controller token and socket, then deletes only that isolated setup. Normal deployment uses `docker compose up -d` and retains volumes. Preserve the certification console output as evidence.

**ChatGPT subscription certification (no API key):** Sign into Studio as a test author, open a job's **Pi model and budgets** section, and choose **Sign in with ChatGPT**. The Pi `openai` provider (not legacy `openai-codex`) opens a browser authorization URL. Compose forwards host loopback `127.0.0.1:1455` to TanStack Start's `/auth/callback` route (web port 3000), while Pi's external-callback mode never opens its own listener; a browser on the same host completes the redirect automatically and Studio updates the connection when credentials are stored. Concurrent users are correlated by one-use OAuth state. For remote browsers, `127.0.0.1` refers to the browser host, so use the manual fallback *Final localhost redirect URL* unless a supported client-side callback relay is configured. Studio encrypts the resulting connection in its durable database.

Run the live gate with an **explicit, absolute path** to that *same* Studio database and its existing encryption key (`NT_PI_CREDENTIAL_KEY`, which can be loaded privately from `web/.env`). Do not paste tokens into the test configuration or logs:

```sh
export NT_NATIVE_CLI=/absolute/path/to/noveltea
export NT_STUDIO_SKILLS_SOURCE=/absolute/path/to/noveltea-skills
export NT_TEST_WEB_PI_AUTH=studio-oauth
export NT_TEST_WEB_PI_SOURCE_DB=/absolute/path/to/connected/studio.sqlite
# Optional if more than one Studio user has OpenAI credentials:
# export NT_TEST_WEB_PI_SOURCE_USER_ID=the-signed-in-user-id
# Optional: pin an eligible subscription model rather than auto-select:
# export NT_TEST_WEB_PI_MODEL=gpt-6.1-sol
# Set NT_PI_CREDENTIAL_KEY in the trusted shell/environment, not in Git.
pnpm certify:self-hosted --live-pi
```

The test opens the source database **read-only** and copies only the currently valid OAuth **access token** into a disposable encrypted test database, replacing its refresh token with an unusable sentinel. It refuses an expiring login; this preserves the real Studio connection even if the test crashes or tries to refresh credentials. It runs a separate dedicated agent process, real sandbox, pinned native validator and authenticated Studio queue admission. The certification job pins a trusted `pauseAfter: foundation` stage boundary, verifies that Foundation was validated and committed, and stops before launching paid-model work for Architecture or subsequent stages. It never uses shared host `~/.pi` files. A new interactive Studio login may be required if the source token is too close to expiry.

For the older API-key certification mode, set `NT_TEST_WEB_PI_AUTH=api-key`, `NT_TEST_WEB_PI_API_KEY` and `NT_TEST_WEB_PI_MODEL` instead. The OAuth mode is preferred for subscription testing. Its success is evidence of a **real** model call and a canonical commit, not of published narrative quality. Use the actual test logs and private LangGraph traces to verify Pi tools, reasoning/provider selection, and that untrusted paths remain inaccessible; do not store private transcripts in the evidence JSON.

## Release-gate evidence matrix

Every row needs its own dated execution, tested revision, environment, observed outcome, and artifact reference (run ID, sanitized logs, provider draft URL, trace ID or test file). Mark *blocked* instead of *pass* for unavailable prerequisites. Do not insert live-provider credentials into the notes.

| Required scenario | Existing proof / run method | Status before a full live run |
| --- | --- | --- |
| GitHub OAuth sign-in, installation-scoped discovery, 100 MB boundary, refresh across service restart | `web/test/oauth.test.ts`, `github-stories.test.ts`; exercise actual expiring GitHub App token in a running Compose instance, restart web and confirm API still works | Fixtures only; live OAuth refresh outstanding |
| GitLab.com OAuth, linked account, discovery, pagination and 100 MB boundary, refresh across service restart | `web/test/oauth.test.ts`, `gitlab-stories.test.ts`; repeat with an expiring **real** GitLab token | Fixtures only; live OAuth refresh outstanding |
| Git worktree isolation, stale upstream, same-job draft updates, revocation and LRU eviction | `web/test/github-publication.test.ts`, `gitlab-publication.test.ts`, `git-cache-quota.test.ts`; inspect verified head and preserved blocked worktree | Mock provider endpoints; actual publication outstanding |
| Adversarial sandbox escape, single mount, rootless controls, writer teardown and reacquire | `--host`, `docs/sandbox-certification.md`; inspect Docker mount, network and cgroup evidence | Requires real rootless gate per target host |
| Canonical Story generation and native validation/protection | `--offline`, `--host`, `--live-pi`; compare against independently pinned native CLI output | Deterministic and live stages must be reported separately |
| Agent/browser disconnect, web restart, graph restart, controller restart, paused approval and crashed writer | `--compose`, `web/test/generation-queue.test.ts`, `generation-controls.test.ts`, `approval.test.ts`, `test/story-interruption.test.ts` | Compose restart is synthetic-state; real mid-write SIGKILL/recovery remains outstanding |
| Real GitHub draft PR | On a designated disposable GitHub App-installed repository: sign in, select `story/`, preflight, generate with Pi, validate, approve, push, create **draft** PR, then update same PR after restart. Verify no default-branch modification or automatic merge | **Not certified by mock API tests** |
| Real GitLab draft MR | Repeat on an authorized disposable GitLab.com project; verify `Draft:` MR, update in place, permission revocation preserves unpublished work, no auto merge | **Not certified by mock API tests** |
| Narrative creative quality | Independent reviewer reads real generated Story, considers causal consistency, protected decisions, routes, pacing, playable VN constraints and source-linked evidence. Record factual/structural validation separately | **Not certified by fixture output or schema validation** |

## Live run procedure and evidence record

1. Provision a **disposable** GitHub repository with a selected GitHub App installation and a separate GitLab.com project; grant test-account push capability. Create a clean branch/reference and record each canonical `story/` baseline SHA. Check chosen Story metadata is below the 100 MB uncompressed blob threshold, then deliberately test the boundary and unsupported LFS/symlink cases on disposable inputs. Never modify another user's repository or an existing release branch.
2. Start the full production-style Compose stack with `docker compose up -d` as documented in `deploy/README.md`; its init service runs migrations and its rootless controller sidecar starts automatically. Sign in through real GitHub and real GitLab in turn. Verify both account links persist after web restart, explicitly expire/refresh test tokens, and check owner-scoped access denies a second account.
3. Create a real web generation job for each selected Story using an explicitly selected Pi provider/model; inspect the pinned starting SHA, scope and private traces. Confirm only `/story` is writable, sibling inbox/Git metadata cannot be read, and the native CLI's structural validation/protection output refers to the same verified SHA.
4. During a bounded real generation, disconnect the client, independently restart web, graph worker and host controller, and reconnect. Test question/approval with exact proposal digest and one-time typed resume. Kill a sandbox mid-write in a separate job and confirm the saved partial bytes require inspection, not blind replay. Re-acquire a new sandbox only after safe reconciliation. Do not endanger a real author's work to run this test.
5. Publish **only after explicit test-author confirmation**; capture the draft PR/MR URL, branch SHA, blockers and validator receipt. Repeat the publication request after restart and verify it updates the *same* draft. Simulate permission revocation on a separate test job and confirm blocked/preserved state. Confirm no default-branch write, force push or auto-merge.
6. Finalize a safely published test job and exercise LRU eviction; confirm durable publication/audit metadata survives. Refuse eviction for dirty, active, paused, blocked and unpublished jobs, including when cache is at capacity.
7. Obtain independent creative-quality review of the actual Pi-authored canonical Markdown, preserving a distinction between native structural correctness, protection/approval authority, and the reviewer's narrative findings. Record verdict and link to the exact checked revision/trace.
8. Restore a copy of backed-up durable app, graph, state and separately held encryption key into a **new test deployment**; verify one author can reconnect to their published job and a different user cannot access it. Do not treat synthetic SQLite markers as backup/restore proof.

Capture the run in an operator-controlled record with: Git commit, UTC date, host/rootless Docker version and cgroup config, native executable SHA-256, skills revision, Compose image IDs, test run/trace IDs, both draft URLs and head SHAs, signed-in test principals (no secrets), actual restart/kill actions, observed recovered job/approval state, real model ID and cost/budget, and an independent review verdict. A complete #71 result must have **no skipped mandatory gates**, no ambiguous failure/recovery, and explicit human-verified real-provider evidence.

If any gate is unavailable or fails, keep #71 **open**. An issue comment can report the precise verified subset and blockers without claiming complete certification.
