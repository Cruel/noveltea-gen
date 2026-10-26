# NovelTea-gen

A local-first TypeScript/pnpm proof of concept integrating a real Pi coordinator with a compiled LangGraph.js workflow. This first ticket is intentionally only a single coordinator node; graph-level delegation, persistent sessions, Story project roots, NovelTea skills and nested Pi tracing are separate follow-up tickets.

## Setup

Node.js 22+ and pnpm are required.

```sh
pnpm install
pnpm check
```

To use a real agent, authenticate with Pi's supported mechanism (for example, use `pi /login` for Codex subscription OAuth), or configure a provider API key using Pi's standard credential support or provider environment variables. No NovelTea-gen credential store exists. Your saved Pi credentials stay in Pi's existing auth store and can be refreshed there.

```sh
pnpm dev run --task "In one sentence, what makes an opening scene compelling?" \
  --provider openai-codex --model gpt-6-luna
```

The requested default is `openai-codex/gpt-6-luna` **where available**; providers may not expose that model. If it is absent, the CLI fails with an actionable error instead of silently using another model. Use `pi --list-models` to find a supported pair and override `--provider` and `--model`.

The program prints the actual Pi response as JSON along with independently generated `threadId` and `runId`. The identifiers are **correlation IDs only** at this stage: SQLite checkpointing, Pi session persistence and resumption are separate work under #6. The Pi agent has no tools in this initial read-only demonstration; later tickets will define project-scoped tools and skills.

## Deterministic no-network exercise

```sh
pnpm dev run --fixture --task "Hello from the graph" --thread smoke-1
pnpm test
pnpm typecheck
pnpm build
```

The explicit `--fixture` mode still compiles and executes LangGraph; it substitutes a deterministic responder at the Pi adapter boundary. It deliberately does not claim to exercise provider authentication or the actual Pi SDK invocation.

To exercise the real Pi SDK through the public CLI with your existing sign-in (may incur usage):

```sh
NT_PROVIDER=openai-codex NT_MODEL=gpt-6-luna pnpm test:live
```

The live test is opt-in and is skipped during routine tests. Choose a provider/model pair actually supported by your Pi account.

## Tracing privacy

Cloud tracing is **off by default** even if `LANGSMITH_TRACING` or `LANGCHAIN_TRACING_V2` is set in the parent environment. To opt in to graph tracing:

```sh
LANGSMITH_API_KEY=... pnpm dev run --trace --task "Example" \
  --provider <provider> --model <model>
```

This intentionally uploads graph trace data to LangSmith. Full parent-child tracing of Pi turns, tool calls and model requests, as well as Studio support, is tracked under #10 and is not claimed by this ticket. Do not enable cloud tracing for sensitive Story material without reviewing the destination.

## Boundaries

This code intentionally does not implement work scheduled in #3–#11, including branch handoff, project selection, SQLite checkpoints, skills, snapshots or LangSmith Pi extension. Its exposed entry point and injectable coordinator adapter establish a small integration seam for those features.
