## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues for `Cruel/noveltea-gen`. Before issue operations, read `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical triage labels. Before triaging, read `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: root `CONTEXT.md` and `docs/adr/`. Before exploring the codebase, read `docs/agents/domain.md`.

## LangGraph / Pi development and debugging

Use pnpm. The coordinator runs a real LangGraph.js graph with Pi agent sessions and a separate direct-model worker. Read `README.md` for graph architecture, checkpoint/resume semantics, Studio setup, and tracing details.

When changing or investigating orchestration, prefer actual **local traces** over guessing from prompts or final responses. Keep tracing local unless cloud upload is explicitly requested:

```sh
pnpm check
pnpm dev run --project ./.projects/agent-debug --create-project \
  --task "Develop a mystery plot twist" --trace-local
pnpm trace:show              # Most recent local span tree and timings
pnpm trace:show --json       # Full merged spans (including inputs/outputs)
pnpm studio                # Separate local graph-visualization session
```

Inspect routing, parent/child spans, Pi turns, model/provider requests, tool calls, usage, duration, and errors. The CLI returns the exact `localTrace` path; inspect a particular run with `pnpm trace:show --file <path-to-jsonl>` (add `--json` for raw span details). Run against an explicitly chosen Story directory and use a fresh `--thread` for independent checkpointed executions. Real Pi calls can incur model usage; `--fixture` exercises both graph branches without a model, and `--fixture-direct` chooses the direct-model fixture branch.

### Where development artifacts live

These are **defaults**, not always the effective paths. Check the CLI output and environment overrides before concluding something is missing.

| Artifact | Default location | Override / details |
| --- | --- | --- |
| **Local nested traces** | `.local/traces/*.jsonl` (repo checkout) | `NT_LOCAL_TRACE_DIR`; one private event stream per `--trace-local` invocation. Use `pnpm trace:show` / `--file`. |
| **NovelTea skills config** | `.local/config.json` (repo checkout) | `NT_CONFIG_FILE`; references the separate `noveltea-skills` Git checkout. |
| **LangSmith credentials** | `.local/langsmith.env` (repo checkout) | Read only when cloud tracing is explicitly selected. Never print or commit secrets. |
| **Git-backed Story jobs** | `~/.local/state/noveltea-gen/jobs/<sha256>/job.json` plus `worktree/` | `NT_STATE_DIR` or `XDG_STATE_HOME`; `pnpm dev job start --story <path> --job <id>` returns exact branch/worktree/Story and persistent thread identity. Read README's Git-backed Story job and Creative Direction generation sections before modifying or recovering one. |
| **Interactive Choice/Puzzle work items and transcripts** | `~/.local/state/noveltea-gen/jobs/<sha256>/interactive-items/<milestone-slug>.json`, `interactive-sessions/interactive-<milestone-slug>/{choice,puzzle}/` | `NT_STATE_DIR` / `XDG_STATE_HOME`; two serialized real specialists after a completed Event Milestone. Read README's interactive alternatives section; never automatically rerun an interrupted writer. |
| **Branch-aware composition receipts and Pi sessions** | `~/.local/state/noveltea-gen/jobs/<sha256>/composition-items/<milestone-slug>.json`, `composition-sessions/composition-<milestone-slug>/{write,review}/` | `NT_STATE_DIR` / `XDG_STATE_HOME`; pinned Authored Content writer and separate read-only editorial reviewer. Read README's branch-aware narrative composition section; preserve interrupted drafts for manual reconciliation. |
| **Milestone Event-design receipts and specialist transcripts** | `~/.local/state/noveltea-gen/jobs/<sha256>/event-items/<milestone-slug>.json`, `event-sessions/event-<milestone-slug>/` | `NT_STATE_DIR` / `XDG_STATE_HOME`; read README's causal Event realization section. Only proceed from a clean verified Character/World head; no blind recovery of an interrupted writer. |
| **Character/World foundation receipts and Pi transcripts** | `~/.local/state/noveltea-gen/jobs/<sha256>/character-world.json`, `character-world-sessions/{world,character}/` | `NT_STATE_DIR` / `XDG_STATE_HOME`; two serialized specialist work units after committed architecture. Read README's Character and World foundations section before modifying/recovering; never blindly rerun an interrupted writer. |
| **Foundation work-item receipts and Pi specialist transcripts** | `~/.local/state/noveltea-gen/jobs/<sha256>/foundation.json`, `foundation-sessions/`, `foundation-discovery-sessions/` | `NT_STATE_DIR` / `XDG_STATE_HOME`; see README's Creative Direction generation section. Read the stored handoff and inspect the job worktree after an interrupted edit; never blindly rerun a writer. |
| **Deferred author ideas (noncanonical)** | Job worktree workspace sibling of `story/`: `.story-inbox/ideas/<stable-id>.yaml`, receipts in job state `ideas/<id>.json` | `pnpm dev job ideas capture|inspect|eligibility|context|placement-context`. The full inbox is author-only and MUST NOT enter ordinary Pi writer context, grep/search results, or canonical Story generation. Use `context --target` only for explicitly authorized narrow constraints; `placement-context` is reserved for dedicated later placement. Read [README deferred inbox](README.md#deferred-author-idea-inbox-24). |
| **Durable live author updates** | `~/.local/state/noveltea-gen/jobs/<sha256>/author-updates/{messages,receipts,checkpoints.sqlite}` | `pnpm dev job author send|inspect|process|resume|control`. Enqueue `send` without the writer lock even during active Pi edits; process under the lock only at a safe work boundary. Each message is stable-ID and source-bound; ideas go through #24 capture, direct change through scope-aware impact/proposal review. A paused approval/question resumes ONLY by exact typed LangGraph `Command(resume)` and verified Ed25519 evidence for protected approvals. `paused`, `cancelled`, `completed` are execution controls; narrative messages must not restart these jobs. See [README author updates](README.md#live-author-messages-and-langgraph-approval-interrupts-25). |
| **Job writer lock and crash evidence** | `~/.local/state/noveltea-gen/jobs/<sha256>/.story-job-running/`, `.story-job-stale-<nonce>/` | Every foundation, architecture and revision action serializes through this lock. For interrupted jobs, read `architecture.json` / `foundation.json`, run `pnpm dev job architecture inspect`, then follow [README crash recovery](README.md#story-work-item-crash-recovery-23). Preserve blocked worktree edits and Pi transcripts. |
| **Protected revision approvals and last verified head** | `~/.local/state/noveltea-gen/jobs/<sha256>/revisions/<work-item>.json`, `revisions/verified-head.json` | `NT_STATE_DIR` / `XDG_STATE_HOME`; see README's protected-decision revision section. Approval/review must use offline Ed25519 signatures tied to the exact job thread/proposal, verified against `.noveltea/approval-author.pub` committed in the original trusted Git base; never treat CLI flags or model/validator claims as consent. See `docs/author-signing.md`. |
| **Pinned narrative validator** | `~/.local/state/noveltea-gen/jobs/<sha256>/validator.json`; native executable stays at its verified installation path | `pnpm dev job validate --story <path> --job <id>` pins the native NovelTea CLI binary path and SHA-256 for new jobs (`NT_NATIVE_CLI` or `PATH`). Historical jobs retain their original content-addressed TypeScript validator artifacts. Missing/changed pins fail closed. See [docs/validator-cutover.md](docs/validator-cutover.md). |
| **Graph checkpoints** | `~/.local/state/noveltea-gen/<project-id>/checkpoints.sqlite` | `XDG_STATE_HOME` changes the base; `NT_STATE_DIR` replaces it. `project-id` is SHA-256 of the canonical Story root. |
| **Pi session transcripts** | Pi agent directory `sessions/--noveltea-gen-<project-id>--/*.jsonl` | Real coordinator/worker sessions are isolated per Story; exact `piSessionFile` / `workerPiSessionFile` are returned by CLI. Fixture histories instead live under the graph state directory's `fixture-sessions/`. |
| **Pinned skill copies** | `~/.cache/noveltea-gen/skill-snapshots/<sha256>/` | `XDG_CACHE_HOME` or `NT_SKILL_CACHE_DIR`; immutable, reused between runs. |
| **Studio dev-server data** | `.langgraph_api/` (repo checkout) | Local development-server state; separate from CLI SQLite checkpoints. |
| **Story authoring output** | Selected `--project` directory | `demo-story` alone can write `creative-direction/foundation.md` into a **fresh empty** Story directory. Normal `run` does not write Story canon. |

The repo's `.local/`, `.langgraph_api/`, and `.projects/` directories are Git-ignored. Traces and Pi transcripts can contain prompts, model outputs, skill references, and other private data. Treat them as sensitive; **do not clean, overwrite, or commit** project state, snapshots, or traces without explicit reason. Do not confuse the local trace stream with Pi session JSONL or SQLite checkpoints.

Cloud uploads are **off by default**. `--trace-local` never requires a LangSmith API key; `--trace` is an independent, explicit hosted-upload opt-in. Both flags can be used together when genuinely needed.
