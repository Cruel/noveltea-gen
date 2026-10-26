# NovelTea-gen

A local-first TypeScript/pnpm proof of concept integrating a Pi coordinator with a compiled LangGraph.js workflow. This version targets an explicit Story project root and demonstrates a Pi-initiated LangGraph handoff to one of two isolated worker types (#4–#5), with SQLite checkpoint/restart recovery (#6), controlled NovelTea skill loading (#7–#9), and local/opt-in hosted nested tracing (#10).

## Setup

Node.js 22+ and pnpm are required:

```sh
pnpm install
pnpm check
```

Authenticate using Pi's supported mechanism, for example `pi /login` for your OpenAI sign-in, or configure a provider API key through Pi/environment variables. NovelTea-gen has **no additional model credential store**; Pi manages saved credentials and OAuth refresh.

## Developer quick start: run, inspect, locate

For future maintainers and coding agents, the operational entry point is **`AGENTS.md`**, including a map of stored artifacts and their environment overrides. Detailed behavior is documented in the relevant sections below.

```sh
pnpm check
pnpm dev run --project ./.projects/agent-debug --create-project \
  --task "Develop a mystery plot twist" --trace-local
pnpm trace:show              # Read the latest local trace tree
pnpm trace:show --json       # All spans, inputs, outputs, timings and errors
pnpm studio                  # Local graph visualization; no LangSmith API key
```

Look in **`.local/traces/*.jsonl`** for saved local traces. Each `--trace-local` run reports its exact `localTrace` path; `pnpm trace:show --file <path>` opens a specific saved run. Other important state lives outside the Story project: checkpoints under `~/.local/state/noveltea-gen/<project-id>/`, real Pi sessions under the Pi agent session directory, and pinned skills under `~/.cache/noveltea-gen/skill-snapshots/`. Local configuration and optional LangSmith credentials live in the repo's ignored `.local/` directory. Consult **`AGENTS.md`** for the full storage map and overrides. Cloud tracing is off unless explicitly enabled via `--trace`; `--trace-local` does not upload traces. Real Pi runs may consume model usage, so use `--fixture` for deterministic graph checks.

## Local NovelTea skills configuration (#7)

To load the real `noveltea-skills` packages without installing them into each Story, create **`.local/config.json`** in this application checkout. The `.local/` directory is gitignored:

```json
{
  "novelteaSkills": "../../noveltea-skills",
  "skillDiscovery": "explicit-only",
  "skillDirs": [],
  "requiredSkills": ["nt-catalog"]
}
```

`novelteaSkills` points at the **Git checkout root**, not its `skills/` subdirectory. Paths are resolved relative to the config file; absolute and `~/` paths work too. `skillDirs` optionally adds other skill directories independently of the NovelTea checkout. `requiredSkills` adds mandatory NovelTea skill names; `nt-catalog` is always required when `novelteaSkills` is configured. Invalid checkouts, missing `.git`, inaccessible directories, and missing required skills fail explicitly. The source checkout and Pi global configuration are never modified.

The `skillDiscovery` setting has two modes:

- `"standard"` (default): enable Pi's normal global and selected-Story skill discovery alongside configured directories, but never let a globally installed same-name skill override a configured NovelTea skill.
- `"explicit-only"`: disable automatically discovered global and Story skills; load only the dedicated checkout and `skillDirs`.

Configured NovelTea skills take precedence, then `skillDirs` in order, then standard Pi discovery. Name collisions produce diagnostics identifying the winner and loser. Global/ancestor AGENTS instructions, extensions, prompt templates, themes and writing/shell tools remain disabled in both modes; Pi's existing authentication is still shared.

The coordinator has only `delegate_to_worker` and, when skills are available, a restricted read-only `read` tool. It can read `SKILL.md` and bundled text references inside advertised skill directories only, without accessing unrelated Story, global or arbitrary files. Separate Pi workers and direct-model workers receive no skills or reader. `NT_CONFIG_FILE=/absolute/path/to/config.json` selects another config file. If there is no config, standard Pi skill discovery is enabled but no NovelTea checkout is assumed. The snapshot mechanism described below pins the effective NovelTea skill source for the entire workflow, including process restarts.

## Immutable NovelTea skill snapshots (#8)

At the start of every **new** workflow with `novelteaSkills` configured, NovelTea-gen captures the checkout's complete `skills/` package tree (SKILL.md files, supporting references and examples) into a content-addressed local cache. The SHA-256 digest is computed from a deterministic list of **sorted relative paths and file-content SHA-256 hashes**. The scan omits Git internals, dependency directories and unrelated checkout-root files. Symlinks inside packages are rejected rather than allowing external inputs.

Snapshots are stored at `~/.cache/noveltea-gen/skill-snapshots/<full-sha256>/`, or under `$XDG_CACHE_HOME/noveltea-gen/skill-snapshots`. Set `NT_SKILL_CACHE_DIR` to override the cache root (for example, the gitignored `.local/skill-snapshots` directory). A new snapshot is staged and checked before atomic directory publication; existing verified digests are reused between Story projects and workflows. Invalid existing snapshots are **not** silently repaired or replaced. Missing or corrupted pinned snapshots stop recovery with an actionable error, and referenced snapshots are retained indefinitely until manually removed. No installers, updates or automated garbage collection run.

LangGraph checkpoints persist the snapshot identifier, full digest and source Git commit, branch (or detached HEAD) and dirty status. The selected snapshot is also included in CLI run output. On every resumed run, the pinned cache directory is validated **before** a Pi agent is restored. NovelTea-skills discovery and the restricted skill reader use that directory; changed, pulled or even deleted source checkouts have no effect on resumed skill contents. A new workflow captures the current live checkout instead. Snapshot metadata can appear in graph trace metadata when tracing is explicitly enabled; **skill contents are not uploaded** as snapshot metadata. Skills that the model actually reads can still appear in Pi transcript/model conversations, as expected.

## Run against a Story project

Select an **existing** Story directory using `--project`:

```sh
pnpm dev run --project /path/to/story --task "In one sentence, what makes an opening scene compelling?"
```

Alternatively, create an **empty** Story directory:

```sh
pnpm dev run --project ./story-test --create-project --task "Suggest a one-sentence premise."
```

For `run`, `--create-project` performs directory creation only. It does **not** initialize an engine game, install skills, modify an existing project or generate Story content. The separate opt-in `demo-story` command below has one narrowly scoped Story-writing tool.

The default model is `openai/gpt-6-luna`, if the selected Pi credentials support it. Use `pi --list-models` to see available provider/model combinations, and override with `--provider` and `--model`. Unsupported pairs fail explicitly.

Relative project paths are resolved against the shell's working directory. Pi uses the canonical absolute Story root as its `cwd`; symlink aliases resolve to the same project identity. The selected project's root-level `AGENTS.md` (or `CLAUDE.md` if AGENTS is absent) is available to Pi. Project instructions that resolve to files outside the root are rejected.

### Context and conversation isolation

Only the selected Story root's AGENTS-style instructions are loaded. We deliberately disable global/ancestor instructions, user extensions, nonapproved tools, additional prompts and themes. Skill discovery is governed by the dedicated local configuration described above. Provider authentication **is shared**, through Pi's own credential store. Later tickets define explicit skill discovery, controlled Story authoring tools and custom extensions.

Pi sessions use a SHA-256-based project-specific directory under Pi’s session store (via its supported `SessionManager.create()` and `SessionManager.open()` APIs), avoiding collisions in Pi’s ordinary path-to-folder encoding. Each invocation creates a fresh Pi coordinator conversation with its own `piSessionId`. A `story_note_worker` delegation creates an independent Pi worker conversation with `workerPiSessionId`; `direct_tagline_worker` instead makes one model call without a worker Pi session. The CLI emits `projectRoot`, `projectId`, `threadId`, `graphThreadId`, `piSessionId`, `runId` and the model's actual `response`. Even if two projects reuse the same user-facing `--thread` value, the actual LangGraph thread ID is prefixed by the project identity, preventing accidental cross-project state reuse. Since #6, local SQLite checkpoints preserve graph progress across processes. Pi coordinator and worker histories remain independently persisted in their project-scoped Pi JSONL session store. The graph stores session identifiers and paths, not live SDK objects. See **Checkpoint/restart recovery** below.

## Pi-directed LangGraph handoff (#4–#5)

The coordinator has one allowlisted custom Pi tool, `delegate_to_worker`. **Pi chooses** between two mutually exclusive destinations and supplies a concise `brief`. The tool **only records the intent**; it never runs a worker or changes shared graph state. The stable yield boundary is **the settled coordinator Pi turn containing exactly one handoff tool call**. LangGraph strictly validates the selected destination before executing only the chosen worker, then resumes the original Pi coordinator session. Missing, repeated or unknown handoffs fail the run.

- **`story_note_worker` (#4):** A separate Pi agent session without coding tools, extensions or project instructions receives only `{brief, storyNote}`. Its exact JSON `{storyNote: string}` updates the shared `storyNote` field. This route reports `workerPiSessionId`.
- **`direct_tagline_worker` (#5):** A single tool-free **pi-ai direct model call**, implemented through the coding-agent's `ModelRuntime.completeSimple()`. It receives only `{brief}` (no original user task, coordinator transcript, AGENTS instructions, project root, tools or skills) and returns exact JSON `{tagline: string}`. It updates **only** `tagline`; it creates no Pi agent session and reports no worker session ID.

The selected implementation for #5 is **direct pi-ai**, not a minimal Pi SDK agent. There is no runtime fallback. Both branches use Pi's existing `ModelRuntime` and supported credentials, including saved OAuth tokens with refresh and configured API keys. Provider/model selection is inherited from the CLI. Unsupported models, unavailable credentials and failed model calls produce actionable errors without adding credentials or raw provider payloads to graph state or CLI error text. Worker outputs are strictly validated before merging and failures prevent continuation.

The `pi_continuation` node prompts **the same live coordinator Pi session** with only the validated result from the selected worker. The final response retains the coordinator's pre-delegation conversation. After each process completes or pauses, live SDK objects are disposed. The stable committed handoff and worker boundaries can now resume in another process from SQLite and Pi session histories (#6).

## Checkpoint/restart recovery (#6)

Every CLI execution writes **local SQLite LangGraph checkpoints** under
`~/.local/state/noveltea-gen/<project-hash>/checkpoints.sqlite` by default.
If `XDG_STATE_HOME` is set, the base is `$XDG_STATE_HOME/noveltea-gen`;
`NT_STATE_DIR` overrides that base entirely. The project hash is SHA-256
of the canonical Story root. This storage is outside the Story directory;
an empty Story project remains empty. The
project's canonical path scopes graph thread IDs and the checkpoint store. Pass a
stable `--thread` when you expect to resume; otherwise a new UUID is assigned.
Resuming through a different project root, including a copy at another path,
does not reuse the original checkpoint.

To stop at the **safe committed handoff boundary** and resume in a fresh process:

```sh
pnpm dev run --project /path/to/story --thread draft-1 --task "Develop a mystery premise" --pause-after handoff
# Close the process or terminal. Later:
pnpm dev run --project /path/to/story --thread draft-1 --resume
```

To checkpoint the selected worker's validated result before the original Pi
coordinator continues, use `--pause-after worker` on the first invocation
(instead of `handoff`). This also works with `direct_tagline_worker`, which
does not have a Pi worker session. Both pause types return `status: "paused"`
and a list of pending `next` nodes. A successful continuation returns
`status: "completed"`; repeating `--resume` on a completed thread reads the
committed result without rerunning nodes. An existing thread cannot be
accidentally restarted or overwritten, and `--resume` takes no new task,
provider, model, or project-creation options.

The graph checkpoint contains the original task, selected destination and
structured updates, plus *serializable references* to independent Pi JSONL
session histories. On resume, NovelTea-gen verifies the stored canonical
project identity, mode, session file location, session headers, JSONL syntax
and the presence of conversation history **before** invoking downstream work; then it reopens the exact
sessions through Pi's supported `SessionManager.open()`, never
`continueRecent()` (which can silently create a replacement). For a
noninteractive test with no provider usage, add `--fixture` to both invocations.

Pi's existing credential storage and OAuth refresh are unchanged.
`NT_STATE_DIR` optionally overrides the default application state location;
keep the same setting across invocations. The pnpm workspace explicitly allows
the `better-sqlite3` native dependency's installation build.

**Recovery limits:** LangGraph records a checkpoint between graph supersteps,
not a distributed transaction with Pi's JSONL persistence or external systems.
If a process crashes *during* a coordinator turn, model request, worker
execution, or a side-effecting tool, the in-flight operation may need manual
reconciliation and could be repeated on retry. No exactly-once guarantee is
claimed for uncommitted model/tool side effects. Only committed nodes are
skipped on resume. Don't run simultaneous continuations of the same thread;
cross-process thread leasing and external side-effect idempotency are outside
this proof of concept. Restore missing session files or SQLite backups when
recovery reports a damaged or mismatched record—do not replace them with fresh
Pi conversations.

## Opt-in skill-driven Story foundation demo (#9)

`demo-story` is **separate from** the existing `run` LangGraph handoff. It exercises a real Pi agent using the immutable NovelTea skill snapshot against a **fresh, empty, explicitly selected** Story root. Configure `.local/config.json` with `novelteaSkills` pointing at the `noveltea-skills` Git checkout first (see configuration above). The command forces explicit-only discovery from the **pinned snapshot**, requires `nt-story-discovery` and `nt-catalog`, and does not install skills, update their source checkout or change global Pi configuration. It retains its own Pi transcript under the application state directory, not inside the Story.

With valid Pi credentials, run:

```sh
pnpm dev demo-story --project ./scratch-story-foundation --create-project \
  --task "Create a murder mystery set aboard a stopped midnight train. Keep it dialogue-led with reusable visual locations. You are delegated all other creative foundation choices."
```

The agent is directed to actually load `nt-story-discovery/SKILL.md`, `nt-catalog/SKILL.md`, `nt-catalog/references/records.md`, `authority-and-validation.md` and `glossary.md` through its restricted `read` tool. The one allowlisted `write_creative_direction` tool **refuses to write until those reads succeed**. It accepts constrained structured inputs and creates only `creative-direction/foundation.md`, with `schema: '0.1'`, `status: draft`, required foundation fields, Markdown prose and individually attributed Creative Decisions. User-supplied choices are `origin: user` / `authority: user-protected`; choices filled within the explicitly delegated scope remain `origin: agent` / `authority: delegated`. There is no approval implied by the draft status.

The directory must be **empty**, even if it already exists. The tool cannot overwrite canon or create additional records, an engine project, or an entire Story. The response reports the skill digest and Git provenance, exact read paths, Pi transcript file, created artifact, and `catalogValidation: "unverified"`. The demo performs constrained input checks and reads the written file back, but does **not** claim native catalog validation, foundation readiness, creative quality, author approval or NovelTea engine playability. This installed NovelTea CLI currently does not expose `noveltea narrative validate`; if it becomes available, use its documented interface separately. In a `noveltea-skills` development checkout only, you can explicitly run `pnpm catalog /absolute/path/to/scratch-story-foundation` to see diagnostics and the **design** versus **approved** foundation minimums. That temporary validator is not a production dependency.

To exercise the same file boundary deterministically without credentials or a model:

```sh
pnpm dev demo-story --project ./scratch-story-fixture --create-project \
  --fixture --task "A murder mystery"
```

The fixture is **not** proof of a Pi agent actually reading or using the skills. For an opt-in real-model integration smoke that checks the persisted Pi tool calls, validates the authored record with the development catalog, and verifies the source checkout remains unchanged:

```sh
NT_LIVE_TEST=1 NT_SKILLS_CHECKOUT=/path/to/noveltea-skills \
  pnpm exec tsx --test --test-name-pattern='opt-in real Pi authors' test/live.test.ts
```

Set `NT_PROVIDER` and `NT_MODEL` if needed. The real-model test may incur usage; it uses a disposable Story root and isolated local state/cache paths. It expects `pnpm catalog` to be usable in the development skills checkout. The normal `run` command remains a graph-routing proof of concept with **no Story write permissions**.

## Tests

Run deterministic tests and compile the CLI:

```sh
pnpm check
```

Test the public graph/CLI boundary without credentials or model requests, against a new disposable root:

```sh
pnpm dev run --project ./scratch-story --create-project --fixture --task "Hello from the graph" --thread smoke-1
```

`--fixture` executes the compiled LangGraph using deterministic adapters and defaults to `story_note_worker`. Add `--fixture-direct` to exercise `direct_tagline_worker` instead (this flag requires `--fixture`). Neither fixture executes real Pi model calls or provider authentication. Both fixtures verify routing and state merges through the public CLI.

With a valid Pi login, run the opt-in live tests (project isolation, direct-model routing and cross-process SQLite/Pi recovery; may incur usage):

```sh
NT_PROVIDER=openai NT_MODEL=gpt-6-luna pnpm test:live
```

The live test runs two separate disposable Story projects whose AGENTS.md files require mutually exclusive markers in the final answer. It verifies that the model initiates the appropriate delegation, the Pi worker and direct-model branches return validated results, the same coordinator resumes with project-local instructions, and graph threads remain distinct. The existing project-isolation tests do not require an external checkout or modify global Pi instructions. To also test **real** skill consumption, set `NT_SKILLS_CHECKOUT=/path/to/noveltea-skills` with `NT_LIVE_TEST=1`. The skill integration test loads the actual Git checkout without modifying it, exercises Pi against a supplied Story contract and inspects the persisted Pi transcript to verify that `nt-catalog/SKILL.md` and `references/records.md` were read through the restricted tool.

## Local LangGraph Studio and opt-in LangSmith tracing (#10)

**Local Studio:** The JS LangGraph CLI is installed as a development dependency. Start the local API server from this checkout:

```sh
pnpm studio
```

Open the Studio URL printed by the server (typically `https://smith.langchain.com/studio?baseUrl=http://localhost:2024`). The local server exposes the graph named `noveltea`; its actual nodes are `pi_coordinator`, `story_note_worker`, `direct_tagline_worker` and `pi_continuation`. You can inspect node transitions, checkpoints and state locally **without a LangSmith API key**. Studio's browser UI is hosted on LangSmith, but the graph execution and checkpoint data are local; do not confuse opening that UI with opting in to hosted trace uploads.

Select an existing Story root. Generate the *full* State JSON to paste into Studio's input panel:

```sh
pnpm studio:input --project ./scratch-story --task "Invent a mystery premise"
```

The helper emits canonical `projectRoot`/`projectId`, model choice, empty initial graph fields and the pinned skill snapshot (if configured). It is read-only except for reuse/creation of the immutable skill cache; it does not invoke a model or create a Story. Optional `--provider` and `--model` override the defaults. The Story directory itself must exist. Pi's login still supplies model credentials; **LangSmith credentials are not required for local Studio**. For CLI-generated checkpoints and project-scoped Pi JSONL histories, use `pnpm dev run --project ... --thread ... --pause-after ...` and `--resume` as documented above. The Studio server uses its own local development graph state, not the CLI's SQLite thread database, while Pi histories remain project-scoped.

**Studio limits:** This is an inspection proof of concept, not a multi-user execution server. Run only one Studio conversation at a time; it rejects overlapping executions. Start a fresh run after failures, and use the CLI for tested cross-process checkpoint/restart recovery. Studio doesn't provide cross-process recovery of an in-progress Pi SDK session. The standalone authoring demo (`demo-story`) is not the Studio graph and has its own stricter Story-write permissions.

**Hosted trace opt-in:** Cloud tracing is **off by default**, even when the shell already has `LANGSMITH_TRACING`, `LANGCHAIN_TRACING_V2` or `TRACE_TO_LANGSMITH` set. No LangSmith API key is needed for normal CLI, fixtures, or local Studio use. Optionally store tracing-only credentials in the gitignored `.local/langsmith.env` (restrict permissions to `0600`):

```dotenv
LANGSMITH_API_KEY=<your-tracing-only-key>
LANGSMITH_PROJECT=noveltea-gen
```

This file is read **only** after `--trace` (CLI) or `NT_STUDIO_TRACE=1` (`pnpm studio:trace`). Its presence **never** enables tracing by itself. Explicit shell/CI environment values take precedence. Never commit or paste the real key into source, tests, or trace metadata. For hosted LangSmith traces, use a valid key **and an explicit flag**:

```sh
pnpm dev run --project ./scratch-story --thread trace-pi --trace \
  --task "Propose a murder mystery twist"
```

The CLI loads `@langchain/langsmith-pi-extension` programmatically for coordinator and independent Pi worker sessions, without enabling global, Story, or arbitrary Pi extensions. LangGraph and Pi traces share a parent context. Pi agent runs contain turns, model/provider calls, tool executions, usage, errors and compaction spans if Pi emits them. The model-only `direct_tagline_worker` is traced separately as a `pi-ai direct model request` LLM span, including the brief, response, available token/cache counts and stop/error status; it creates no Pi agent. The extension uses the same pinned `langsmith` SDK version as LangGraph to preserve trace context.

The graph and Pi metadata include stable run/thread/project identifiers and the skill snapshot digest, Git commit, branch and dirty status. **Skill contents, source paths and credentials are not placed in provenance metadata.** Explicit hosted tracing can still send **prompt text, model responses and tool read results**, including loaded skill references, because those are part of Pi model execution; do not enable it with confidential Story data, secrets or skill content you do not intend to upload. The direct-model span never receives Pi credentials or raw provider objects, and provider SDK error text is redacted before entering that span. No tracing extension is loaded when tracing is off.

For a Studio-server hosted trace (as distinct from the CLI), use this explicit launch and paste a generated input:

```sh
pnpm studio:trace
```

### Manual LangSmith end-to-end inspection (requires key and Pi login)

1. Create or select a disposable Story root and set `LANGSMITH_API_KEY` and, optionally, `LANGSMITH_PROJECT`. Use a new `--thread` for each case. Leave tracing off for an initial fixture run; confirm no LangSmith runs appear for it and the local SQLite checkpoint and Pi JSONL files remain available.
2. Run `pnpm dev run --project <root> --trace --task "Invent a compact locked-room mystery premise"`. Confirm a single graph trace with `pi_coordinator → story_note_worker → pi_continuation`; under the correct graph nodes, expand the Pi agent/turn/provider/tool runs. Verify model usage and a `delegate_to_worker` tool span. If Pi emits a compaction or error, check its status/span rather than expecting one every run.
3. Run `pnpm dev run --project <root> --trace --task "Write a promotional tagline for a gothic mystery"`. Confirm `pi_coordinator → direct_tagline_worker → pi_continuation` and a model span labeled `pi-ai direct model request` under the direct worker node, with request brief, returned JSON text, stop status and token usage. There must be **no** independent Pi worker session in this branch.
4. Confirm the graph and child trace correlation identifiers and snapshot Git revision/digest match CLI output. Check that no API key, authorization header, raw provider SDK object or **skill contents in metadata** appear in the runs. Trace payloads may contain user/task/skill **content**, as noted above; review before transmitting. Repeat a run without `--trace` to verify opt-out even with inherited LangSmith environment variables.
5. Optionally use `pnpm studio`, then `pnpm studio:input` for the same root and inspect the live graph node transitions locally. Hosted tracing for Studio requires `pnpm studio:trace` and a valid LangSmith API key; it is never silently enabled by local Studio.

Automated instrumentation tests: `pnpm exec tsx --test test/tracing.test.ts`. They require no LangSmith key and verify the opt-in gate, disabled Pi extensions, metadata allowlist, direct-model output sanitization and both graph branch configurations. A live hosted trace tree must be inspected with real credentials; fixture tests are not evidence of a successful upload.

### Local nested traces for development (no cloud required)

To capture and inspect the **actual** LangGraph and Pi trace tree on disk, independently of hosted LangSmith:

```sh
pnpm dev run --project ./scratch-story --thread debug-1 --trace-local \
  --task "Propose a locked-room mystery twist"
pnpm trace:show
pnpm trace:show --json
pnpm trace:show --file .local/traces/<specific-run>.jsonl
```

The CLI reports `localTrace` in its result JSON. `trace:show` opens the latest trace and displays graph node transitions, nested Pi agent turns, provider/model spans, tool executions, compactions, status, duration and token usage. `--json` provides the complete merged span records, including inputs and outputs, for deeper debugging and automated inspection. Raw append-only LangSmith-style create/update events are saved under gitignored **`.local/traces/*.jsonl`** (mode `0600`); `NT_LOCAL_TRACE_DIR` overrides the directory for isolated test runs. Failed runs also print the trace path to stderr so partial/error traces can be investigated.

`--trace-local` **never requires a LangSmith key and makes no hosted trace uploads**. Cloud tracing is still **off** unless separately enabled by `--trace`. The two flags can be combined to keep a local copy while explicitly submitting the same run to LangSmith. Local recordings are not pruned automatically; remove files under `.local/traces` when no longer needed.

**Data sensitivity:** Local traces include Story prompts, model messages, skills returned by read tools, and model/tool outputs. Protect or delete them as confidential development data. Known credential fields and configured environment secret values are redacted; this is not a guarantee that arbitrary user-included secrets cannot occur in content. Both local and cloud capture remain opt-in. Pi session JSONL and SQLite checkpoints are still separate from these full execution traces.

Instrumented fixture tests: `pnpm exec tsx --test test/local-trace.test.ts`. The tests exercise both branches locally, require no model credentials and verify trace completion, file permissions, cloud opt-out and credential redaction. A real-Pi smoke test also confirmed an actual local tree containing Pi agent, model, tool and direct-model spans.

## Scope

#2–#10 include the coordinator, worker isolation, SQLite/Pi recovery, controlled and pinned NovelTea skill discovery, the bounded Story authoring demo, local LangGraph Studio and opt-in nested LangSmith observability. This does not claim a production Story orchestration graph or a fully implemented Story engine.
