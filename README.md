# NovelTea-gen

A local-first TypeScript/pnpm proof of concept integrating a Pi coordinator with a compiled LangGraph.js workflow. This version targets an explicit Story project root. Graph delegation, checkpoint/recovery, skills, snapshots and nested LangSmith Pi tracing are follow-up tickets.

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

Pi sessions use a SHA-256-based project-specific directory under Pi’s session store (via its supported `SessionManager.create()` API), avoiding collisions in Pi’s ordinary path-to-folder encoding. Each invocation creates a fresh Pi conversation with its own `piSessionId`. The CLI emits `projectRoot`, `projectId`, `threadId`, `graphThreadId`, `piSessionId`, `runId` and the model's actual `response`. Even if two projects reuse the same user-facing `--thread` value, the actual LangGraph thread ID is prefixed by the project identity, preventing accidental cross-project state reuse. **Checkpointed graph restoration and explicit Pi session resumption are not yet implemented**; those guarantees belong to #6.

## Tests

Run deterministic tests and compile the CLI:

```sh
pnpm check
```

Test the public graph/CLI boundary without credentials or model requests, against a new disposable root:

```sh
pnpm dev run --project ./scratch-story --create-project --fixture --task "Hello from the graph" --thread smoke-1
```

`--fixture` still executes the real compiled LangGraph but substitutes a deterministic fake coordinator. It does **not** exercise the real Pi SDK or provider authentication.

With a valid Pi login, run the opt-in live test (it makes two real model calls and may incur usage):

```sh
NT_PROVIDER=openai NT_MODEL=gpt-6-luna pnpm test:live
```

The live test runs two separate disposable Story projects whose AGENTS.md files require mutually exclusive tokens. It verifies the model uses the correct local instructions, that the conversations and graph threads remain distinct, and that model responses pass back through LangGraph. It does not use a preconfigured external directory or modify either the NovelTea-gen checkout or global Pi instructions.

## LangSmith tracing

Cloud tracing is **off by default**, even when a parent shell has `LANGSMITH_TRACING` or `LANGCHAIN_TRACING_V2` set. Explicitly enable graph tracing (which uploads trace data) by passing `--trace` and providing `LANGSMITH_API_KEY`:

```sh
LANGSMITH_API_KEY=... pnpm dev run --project ./story-test --trace --task "Example"
```

Nested Pi model/turn/tool traces and Studio setup are covered under #10. Do not enable cloud tracing with confidential Story content without reviewing the destination.

## Scope

The initial coordinator and project isolation implement #2–#3 only. The two worker destinations, Pi-initiated graph handoff, model-only worker, checkpoint/restart recovery, NovelTea skills, provenance snapshots and full LangSmith observability are still scheduled in #4–#11.
