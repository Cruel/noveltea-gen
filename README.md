# NovelTea-gen

A local-first TypeScript/pnpm proof of concept integrating a Pi coordinator with a compiled LangGraph.js workflow. This version targets an explicit Story project root and demonstrates a Pi-initiated LangGraph worker handoff (#4). Checkpoint/recovery, skills, snapshots and nested LangSmith Pi tracing remain follow-up tickets.

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

Pi sessions use a SHA-256-based project-specific directory under Pi’s session store (via its supported `SessionManager.create()` API), avoiding collisions in Pi’s ordinary path-to-folder encoding. Each invocation creates a fresh Pi coordinator conversation with its own `piSessionId`. A successful delegation creates an independent worker conversation with `workerPiSessionId`. The CLI emits `projectRoot`, `projectId`, `threadId`, `graphThreadId`, `piSessionId`, `runId` and the model's actual `response`. Even if two projects reuse the same user-facing `--thread` value, the actual LangGraph thread ID is prefixed by the project identity, preventing accidental cross-project state reuse. **Cross-process checkpointed graph restoration and explicit Pi session restoration are not implemented**; those guarantees belong to #6. The #4 continuation preserves one Pi session within the same running graph invocation.

## Pi-directed LangGraph handoff (#4)

The real coordinator has one allowlisted custom Pi tool, `delegate_to_worker`. Pi chooses the `story_note_worker` destination and supplies a concise `brief`. The custom tool **only records the handoff intent**. It does not run subagents, call a worker, modify graph state or finish the user's task. The stable yield boundary is **the settled coordinator Pi turn containing exactly one handoff tool call**. After that turn settles, the `pi_coordinator` LangGraph node validates the intent, and a conditional LangGraph edge routes to `story_note_worker`. A malformed, missing, repeated or unknown handoff causes the entire run to fail.

The worker is a separate real Pi session with no built-in tools, global extensions or project AGENTS instructions. LangGraph gives it only the projected work fields (`brief` and the shared `storyNote`); it cannot see the coordinator's transcript or original task through graph state. The worker must return JSON containing exactly one nonempty `storyNote` string. The graph validates this output and the distinct worker session ID before merging that one shared field. Invalid output fails the graph rather than silently succeeding.

Afterward, the `pi_continuation` node prompts **the original, still-live coordinator Pi session**, passing the validated worker update. The coordinator's earlier conversation remains intact and supplies context for the final answer. Once the graph ends (success or error), sessions are disposed. This is an **in-process handoff**, not a durable pause or LangGraph checkpoint; process death between nodes cannot be resumed until #6. JSON output includes `handoffDestination`, `storyNote`, and both Pi session IDs.

## Tests

Run deterministic tests and compile the CLI:

```sh
pnpm check
```

Test the public graph/CLI boundary without credentials or model requests, against a new disposable root:

```sh
pnpm dev run --project ./scratch-story --create-project --fixture --task "Hello from the graph" --thread smoke-1
```

`--fixture` still executes the real compiled LangGraph and all three graph nodes, substituting deterministic Pi coordinator/worker adapters. It does **not** exercise real Pi tool calls or provider authentication.

With a valid Pi login, run the opt-in live test (two Story projects, each using coordinator handoff, worker and continuation model calls; may incur usage):

```sh
NT_PROVIDER=openai NT_MODEL=gpt-6-luna pnpm test:live
```

The live test runs two separate disposable Story projects whose AGENTS.md files require mutually exclusive markers in the final answer. It verifies that the real model initiates delegation, separate worker sessions return valid notes, the coordinator continues with project-local instructions, and graph threads remain distinct. It does not use a preconfigured external directory or modify either the NovelTea-gen checkout or global Pi instructions.

## LangSmith tracing

Cloud tracing is **off by default**, even when a parent shell has `LANGSMITH_TRACING` or `LANGCHAIN_TRACING_V2` set. Explicitly enable graph tracing (which uploads trace data) by passing `--trace` and providing `LANGSMITH_API_KEY`:

```sh
LANGSMITH_API_KEY=... pnpm dev run --project ./story-test --trace --task "Example"
```

Nested Pi model/turn/tool traces and Studio setup are covered under #10. Do not enable cloud tracing with confidential Story content without reviewing the destination.

## Scope

The coordinator, project isolation and single graph-delegated worker implement #2–#4. Additional worker destinations, model-only worker variants, checkpoint/restart recovery, NovelTea skills, provenance snapshots and full LangSmith observability remain future work in #5–#11.
