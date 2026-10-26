# NovelTea-gen

A local-first TypeScript/pnpm proof of concept integrating a Pi coordinator with a compiled LangGraph.js workflow. This version targets an explicit Story project root and demonstrates a Pi-initiated LangGraph handoff to one of two isolated worker types (#4–#5), with SQLite checkpoint/restart recovery (#6) and controlled NovelTea skill loading (#7). Nested LangSmith Pi tracing remains follow-up work.

## Setup

Node.js 22+ and pnpm are required:

```sh
pnpm install
pnpm check
```

Authenticate using Pi's supported mechanism, for example `pi /login` for your OpenAI sign-in, or configure a provider API key through Pi/environment variables. NovelTea-gen has **no additional credential store**; Pi manages saved credentials and OAuth refresh.

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

`--create-project` performs directory creation only. It does **not** initialize an engine game, install skills, modify an existing project, or generate content unless the model is subsequently given approved tools (none are enabled yet).

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

## LangSmith tracing

Cloud tracing is **off by default**, even when a parent shell has `LANGSMITH_TRACING` or `LANGCHAIN_TRACING_V2` set. Explicitly enable graph tracing (which uploads trace data) by passing `--trace` and providing `LANGSMITH_API_KEY`:

```sh
LANGSMITH_API_KEY=... pnpm dev run --project ./story-test --trace --task "Example"
```

Nested Pi model/turn/tool traces and Studio setup are covered under #10. Do not enable cloud tracing with confidential Story content without reviewing the destination.

## Scope

The coordinator, project isolation, Pi worker, direct pi-ai worker, SQLite/Pi recovery, controlled NovelTea skill loading and immutable provenance snapshots implement #2–#8. Full LangSmith observability remains future work in #9–#11.
