# Integration proof certification (#11)

For the later production Git-backed Story generator (#31), see
[story-generator-certification.md](story-generator-certification.md).

This historical checklist certifies the **local-first LangGraph.js + Pi proof of concept**, not the later production Story-generation system. For production #32 verification, see [README](../README.md#checkpointed-single-milestone-story-generation-32) and `test/generation.test.ts`; Studio now registers only that production graph. Start in the `noveltea-gen` checkout with Node.js 22+, pnpm and installed dependencies. The offline suite does not require a model, network access, a LangSmith key or a real `noveltea-skills` checkout; it creates disposable Git skill packages, Story roots, state directories and caches, then removes them.

```sh
pnpm install --frozen-lockfile
pnpm certify   # public CLI, cross-process resume, isolated roots, pinned snapshots, failure matrix
pnpm check     # typecheck + all deterministic tests (including certification) + build
```

A passing offline run prints four passing `certification:` tests. `pnpm check` must exit 0. Use `pnpm dev --help` for the supported CLI; `pnpm studio:input --story <existing-root> --job <id> --task "..." --contract scope.json` now supplies production Story-generation input for local Studio. All listed test files are part of the ordinary `pnpm test` run (live tests are skipped unless explicitly enabled).

## Acceptance matrix and evidence

| Requirement | Executable evidence | What is asserted |
| --- | --- | --- |
| Public CLI and both Pi-selected graph destinations | `test/certification.test.ts` (CLI route test); `test/cli.test.ts`; `test/graph.test.ts` | Each fixture branch completes through the compiled graph; local trace lists coordinator, **only** its selected worker and continuation; the coordinator session ID persists and selected fields reach the final reply. Graph adapter tests prove actual route selection comes from Pi's validated handoff, not a task-text heuristic. |
| State projection and failure matrix | `test/certification.test.ts` (error test); `test/graph.test.ts`; `test/pi-delegation.test.ts` | Workers receive only their allowed fields; a Pi worker has its own session; the direct worker has no Pi session. Unknown/duplicate/malformed handoffs, extra or empty results, changed coordinator ID, empty final text and thrown provider/worker errors fail without fallback or continuation. |
| Cross-project identity and storage separation | `test/certification.test.ts` (two Story roots); `test/project.test.ts`; `test/resources.test.ts`; `test/recovery.test.ts` | Same human thread name in two canonical roots yields different project hashes, graph thread IDs and Pi sessions; one project cannot resume another's history, and normal `run` preserves existing Story files. |
| Committed handoff / worker restart | `test/certification.test.ts` (separate subprocess pause and resume); `test/recovery.test.ts` | Stop at `--pause-after handoff`, restart with `--resume`, preserve the coordinator and SQLite thread and finish. Other tests cover worker boundary, direct branch, repeated resume, corrupted/missing Pi JSONL or SQLite state, worker retry and foreign root/mode rejection. |
| Content-addressed provenance | `test/certification.test.ts` (source revision during pause); `test/snapshot.test.ts`; `test/tracing.test.ts` | Snapshot SHA-256 IDs are reused when inputs match, differ after skill content revisions, and are preserved across restart. The resumed checkpoint retains the original **digest and Git commit** and original skill bytes, rather than reading the changed checkout; a new workflow captures the new revision. Tampering and missing cache entries fail closed; trace metadata uses an allowlist. |
| Two disposable Story roots and scoped skill access | `test/certification.test.ts` (two foundation drafts); `test/demo.test.ts`; `test/skills.test.ts` | Fixture demonstrator reads five files in its pinned `nt-story-discovery`/`nt-catalog` packages and writes only a draft `creative-direction/foundation.md` into each empty root, preserving source Git status. Restricted read rejects unrelated paths and authoring rejects overwrites. The fixture **is not evidence that a live Pi model used skills**. |
| Local, off-by-default cloud tracing | `test/certification.test.ts`; `test/local-trace.test.ts`; `test/tracing.test.ts`; `test/langsmith-config.test.ts` | Inherited cloud tracing variables do not enable uploads, local traces show selected node transitions and no unselected worker, known secrets are redacted, tracing metadata and direct-model spans are constrained, and an explicit `--trace` requires credentials. No fixture test can prove a hosted upload occurred. |
| Studio and actual skill consumption | `test/studio.test.ts` plus **opt-in live checklist below** and `test/live.test.ts` | Studio graph/input contract is inspected offline; real Pi, development catalog validation, uploaded nested LangSmith spans and Studio UI inspection require their respective live prerequisites. |

## Reproduce the CLI handoff manually (offline)

The matrix creates its own temporary files; these commands are optional human-readable equivalents. Use **independent, disposable** Story roots (do not point at an existing canon directory). Keep the same `NT_STATE_DIR` across pause and resume. The examples show deterministic transport fixtures, not model-directed routing:

```sh
export NT_STATE_DIR="$(mktemp -d)"
export NT_LOCAL_TRACE_DIR="$(mktemp -d)"
STORY_A="$(mktemp -d)"
STORY_B="$(mktemp -d)"

pnpm dev run --project "$STORY_A" --thread certify-a --fixture --trace-local \
  --task "Develop a locked-room mystery"
pnpm dev run --project "$STORY_B" --thread certify-b --fixture --fixture-direct --trace-local \
  --task "Write a dramatic tagline"
pnpm trace:show --json

pnpm dev run --project "$STORY_A" --thread restart-a --fixture \
  --task "Develop an old-manor twist" --pause-after handoff
# This second command starts a new process and resumes the saved SQLite/Pi histories.
pnpm dev run --project "$STORY_A" --thread restart-a --fixture --resume
```

Expected: story worker output has `storyNote` and independent `workerPiSessionId`, with no `tagline`; direct output has `tagline` with neither `storyNote` nor `workerPiSessionId`. Both preserve the initial `piSessionId` through continuation; distinct Story roots have different `projectId` and `graphThreadId`. Pause prints `status: paused` and pending `next`; successful resume prints `status: completed`. Normal `run` does **not** write Story canon. The test suite automatically removes its own disposable directories; the manual commands above do not delete yours.

For a pinned-source revision test, run `pnpm certify`, which constructs a temporary Git `noveltea-skills` checkout, commits version A, pauses the graph, commits version B **between separate CLI processes**, resumes and verifies the original snapshot bytes/commit and source isolation, then starts a new thread that captures version B. It intentionally avoids touching a developer's actual skills checkout.

## Opt-in live smoke checklist (credentials / provider requests)

These steps are **not** part of `pnpm check`; they may make billable model requests. Perform them only with an available Pi login or provider API key. Use a real NovelTea skills Git checkout, preferably the local development one, and a disposable Story root. Never check in credentials, trace payloads, Pi transcripts or caches.

- [ ] **Pi authentication and both live branches:** confirm `pi /login` or the existing Pi provider credentials, then run `NT_LIVE_TEST=1 NT_PROVIDER=openai NT_MODEL=gpt-6-luna pnpm exec tsx --test test/live.test.ts`. The tests exercise Pi-selected story worker and direct pi-ai worker, reusing the coordinator session. Provider/model overrides may be set to a supported pair.
- [ ] **Real catalog skill use:** set `NT_SKILLS_CHECKOUT=/absolute/path/to/noveltea-skills` on that live test invocation. Inspect the persisted coordinator Pi session: `read` tool calls must point to `nt-catalog/SKILL.md` and `references/records.md` **under the reported immutable snapshot path**, and the source checkout Git status must be unchanged. No fixture outcome substitutes for these tool calls.
- [ ] **Real minimal Story foundation:** with `NT_SKILLS_CHECKOUT` set, the opt-in authoring test must show all five required skill reads, exactly one `write_creative_direction` call, one draft `creative-direction/foundation.md`, user-protected/delegated authority attribution and unchanged source checkout. It also runs the **development-checkout-only** `pnpm catalog <disposable-story>` validator; expect no diagnostics, design foundation minimum passed and approval minimum not passed. This is not a production engine validator or actual human approval.
- [ ] **Live SQLite/Pi restart:** the live recovery test pauses after a completed worker in one process and resumes in another. Optionally test the earlier committed handoff directly with `--pause-after handoff` and `--resume` on the **same** disposable root/thread, without a new task. Check stable coordinator ID, preserved worker history when applicable and unchanged snapshot ID/commit. Do not use concurrent resumptions of one thread.
- [ ] **Local Studio (production replacement):** start `pnpm studio`, generate input using `pnpm studio:input --story <existing-story-root> --job <existing-job> --task "Develop one Milestone" --contract scope.json --fixture` and paste the JSON into Studio. Inspect `story_generation` scheduling, author intake, specialist dispatch, verification and completion nodes, then state/checkpoints. The old note/tagline graph is no longer registered. The server has **separate local state** from CLI SQLite; use one execution surface per job. No LangSmith API key is needed to view the graph locally.
- [ ] **Explicit LangSmith nested tracing:** store a tracing-only key in gitignored `.local/langsmith.env` (or environment), opt in via `pnpm dev run --project <disposable-root> --task "Propose a mystery twist" --trace --trace-local`, and repeat using a tagline prompt. In the LangSmith UI, confirm graph-parent and nested Pi agent, turns, model/provider and tool spans on the story-worker route, and a separately traced `pi-ai direct model request` on the direct route; inspect usage, selected/unselected workers, errors when present and the project/thread/snapshot digest/Git revision metadata. The direct worker must have no independent Pi session. LangSmith trace content can include prompts, Story data and skill read results; use only disposable/nonconfidential input.
- [ ] **No-upload control:** run the CLI **without `--trace`** under the same environment, even if `LANGSMITH_TRACING=true` is inherited. Verify its output reports `tracing: false`, local traces work with `--trace-local`, and **no new run appears in the hosted project**. A key file merely existing must not enable uploads. To trace Studio specifically, use `pnpm studio:trace`; `pnpm studio` is the local/no-upload default.

The source for nested trace configuration and local trace locations is [README.md](../README.md) and [AGENTS.md](../AGENTS.md). For private `--trace-local` recordings, use `pnpm trace:show --file <reported-path> --json` and inspect spans without a cloud key.

## Supported limits and certification interpretation

This is a proof of the **delegation mechanism**, not autonomous, multi-step NovelTea Story production. Normal `run` has no Story write tool; `demo-story` is a separate, intentionally bounded authoring demo that produces draft Creative Direction only. The graph's fixture adapters simulate Pi behavior and skills reads rather than calling a real model. The live tests and manual hosted inspection are the only evidence for real Pi skill consumption and successful cloud uploads; report them separately rather than silently assuming they ran.

Only fully committed LangGraph handoff/worker boundaries are safe to resume. There is no exactly-once guarantee for a process crash inside an in-flight Pi turn, side-effecting tool or provider call, and no cross-process locking for simultaneous resume. CLI SQLite threads, Pi JSONL transcripts, local traces, pinned snapshots and Studio's local dev-server state are different stores; see the location map in `AGENTS.md`. Snapshot pinning protects skills across a workflow; it does not freeze arbitrary global provider behavior or guarantee deterministic model answers. Local traces and LangSmith uploads are opt-in and may contain sensitive prompts or skill contents (provenance **metadata** omits skill contents and credentials). Credential-required runs are intentionally excluded from repeatable offline CI.
