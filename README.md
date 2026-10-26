# NovelTea-gen

A local-first TypeScript/pnpm proof of concept integrating a Pi coordinator with a compiled LangGraph.js workflow. This version targets an explicit Story project root and demonstrates a Pi-initiated LangGraph handoff to one of two isolated worker types (#4–#5). Checkpoint/recovery, skills, snapshots and nested LangSmith Pi tracing remain follow-up tickets.

## Setup

Node.js 22+ and pnpm are required:

```sh
pnpm install
pnpm check
```

Authenticate using Pi's supported mechanism, for example `pi /login` for your OpenAI sign-in, or configure a provider API key through Pi/environment variables. NovelTea-gen has **no additional credential store**; Pi manages saved credentials and OAuth refresh.

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

Only the selected Story root's AGENTS-style instructions are loaded. We deliberately disable global/ancestor instructions, user extensions, nonapproved tools, automatic skill discovery, additional prompts and themes in this early read-only coordinator. Provider authentication **is shared**, through Pi's own credential store. Later tickets define explicit skill discovery, controlled Story authoring tools and custom extensions.

Pi sessions use a SHA-256-based project-specific directory under Pi’s session store (via its supported `SessionManager.create()` API), avoiding collisions in Pi’s ordinary path-to-folder encoding. Each invocation creates a fresh Pi coordinator conversation with its own `piSessionId`. A `story_note_worker` delegation creates an independent Pi worker conversation with `workerPiSessionId`; `direct_tagline_worker` instead makes one model call without a worker Pi session. The CLI emits `projectRoot`, `projectId`, `threadId`, `graphThreadId`, `piSessionId`, `runId` and the model's actual `response`. Even if two projects reuse the same user-facing `--thread` value, the actual LangGraph thread ID is prefixed by the project identity, preventing accidental cross-project state reuse. **Cross-process checkpointed graph restoration and explicit Pi session restoration are not implemented**; those guarantees belong to #6. The #4 continuation preserves one Pi session within the same running graph invocation.

## Pi-directed LangGraph handoff (#4–#5)

The coordinator has one allowlisted custom Pi tool, `delegate_to_worker`. **Pi chooses** between two mutually exclusive destinations and supplies a concise `brief`. The tool **only records the intent**; it never runs a worker or changes shared graph state. The stable yield boundary is **the settled coordinator Pi turn containing exactly one handoff tool call**. LangGraph strictly validates the selected destination before executing only the chosen worker, then resumes the original Pi coordinator session. Missing, repeated or unknown handoffs fail the run.

- **`story_note_worker` (#4):** A separate Pi agent session without coding tools, extensions or project instructions receives only `{brief, storyNote}`. Its exact JSON `{storyNote: string}` updates the shared `storyNote` field. This route reports `workerPiSessionId`.
- **`direct_tagline_worker` (#5):** A single tool-free **pi-ai direct model call**, implemented through the coding-agent's `ModelRuntime.completeSimple()`. It receives only `{brief}` (no original user task, coordinator transcript, AGENTS instructions, project root, tools or skills) and returns exact JSON `{tagline: string}`. It updates **only** `tagline`; it creates no Pi agent session and reports no worker session ID.

The selected implementation for #5 is **direct pi-ai**, not a minimal Pi SDK agent. There is no runtime fallback. Both branches use Pi's existing `ModelRuntime` and supported credentials, including saved OAuth tokens with refresh and configured API keys. Provider/model selection is inherited from the CLI. Unsupported models, unavailable credentials and failed model calls produce actionable errors without adding credentials or raw provider payloads to graph state or CLI error text. Worker outputs are strictly validated before merging and failures prevent continuation.

The `pi_continuation` node prompts **the same live coordinator Pi session** with only the validated result from the selected worker. The final response retains the coordinator's pre-delegation conversation. After the graph ends or fails, Pi sessions are disposed. This is an **in-process handoff**, not a durable graph checkpoint; cross-process recovery belongs to #6.

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

With a valid Pi login, run the opt-in live tests (two Story-project isolation runs and a separate direct-model branch run; may incur usage):

```sh
NT_PROVIDER=openai NT_MODEL=gpt-6-luna pnpm test:live
```

The live test runs two separate disposable Story projects whose AGENTS.md files require mutually exclusive markers in the final answer. It verifies that the model initiates the appropriate delegation, the Pi worker and direct-model branches return validated results, the same coordinator resumes with project-local instructions, and graph threads remain distinct. It does not use a preconfigured external directory or modify either the NovelTea-gen checkout or global Pi instructions.

## LangSmith tracing

Cloud tracing is **off by default**, even when a parent shell has `LANGSMITH_TRACING` or `LANGCHAIN_TRACING_V2` set. Explicitly enable graph tracing (which uploads trace data) by passing `--trace` and providing `LANGSMITH_API_KEY`:

```sh
LANGSMITH_API_KEY=... pnpm dev run --project ./story-test --trace --task "Example"
```

Nested Pi model/turn/tool traces and Studio setup are covered under #10. Do not enable cloud tracing with confidential Story content without reviewing the destination.

## Scope

The coordinator, project isolation, Pi worker and direct pi-ai worker implement #2–#5. Checkpoint/restart recovery, NovelTea skills, provenance snapshots and full LangSmith observability remain future work in #6–#11.
