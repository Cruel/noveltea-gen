# NovelTea-gen

A local-first TypeScript/pnpm Story generator using LangGraph.js to coordinate Git-backed Story jobs and pinned Pi specialists. The production `job generate` entrypoint schedules an explicitly scoped Story or Arc/Milestone set through independent review. The original `run` note/tagline routing proof of concept remains separate, with its own SQLite checkpoints and tracing.

## Setup

Node.js 22+ and pnpm are required:

```sh
pnpm install
pnpm check
```

Production Git-backed Story generator certification is tracked in
[docs/story-generator-certification.md](docs/story-generator-certification.md).
Run `pnpm certify:story` with an installed native CLI and canonical fixture to
require real native validation (no skipped checks). Opt-in real Pi results are
reported separately; deterministic fixtures do not certify narrative quality.

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

## Checkpointed scope-driven Story generation (#32, #33)

Start a Git-backed job once, then give the production parent graph an explicit
objective and completion contract. You do **not** need to invoke each specialist:

```sh
pnpm dev job start --story /path/to/existing/repo/story --job draft-1
pnpm dev job generate start --story /path/to/existing/repo/story --job draft-1 \
  --task "Develop the missing witness mystery; invent unspecified details" \
  --contract ./scope.json --skills-source /path/to/noveltea-skills
pnpm dev job generate inspect --story /path/to/existing/repo/story --job draft-1
pnpm dev job generate resume --story /path/to/existing/repo/story --job draft-1
```

`scope.json` uses the existing architecture completion contract, for example:

```json
{
  "scope": {
    "kind": "partial", "depth": "composition",
    "targets": ["arc.truth", "milestone.disclosure"],
    "branches": ["protect", "challenge"]
  },
  "constraints": ["The player can protect or challenge the witness"],
  "envelope": {
    "presentation": "Dialogue-led visual novel",
    "hardLimits": [], "preferences": []
  }
}
```

The scheduler accepts a **full-Story** contract or a **bounded partial** contract
targeting one or more Arcs/Milestones. It starts with Creative Direction, architecture
and World/Character foundations, then selects runnable pending Event,
Choice/Puzzle and composition work items from the current typed plan and canonical
scope. Independent clusters can continue after a clean local block; their dependent
work remains blocked, and cycles, unknown dependencies and unapproved new
coverage fail closed. Several Milestone fulfillment alternatives retain their
canonical route witnesses; they are not flattened into an invented all-path
prerequisite. `architecture` and `interactive` depths omit later authoring stages,
but still request independent scope assessment. No arbitrary Event/scene counts,
iterative whole-Story improvement or automatic integration are imposed. Canonical
Story Markdown remains authoritative. Under #22, Pi specialists can call
`story_context` to consume the native read-only `noveltea narrative context`
manifest and batch-read new or revised canonical files. Set `NT_NATIVE_CLI` to
an installed native binary or put `noveltea` on `PATH`. Without the native
command, the tool can only read the scheduler's explicitly supplied paths;
it cannot resolve new typed targets or reconstruct the Story graph. Native
manifests preserve source revisions, record status, priorities, typed inclusion
witnesses and unresolved dependencies; additional lookups require a reason
and never expand edit authority. The separate experimental validator and Pi
validation shim remain until native validation/protection parity is certified.
Run native context integration tests with `NT_NATIVE_CLI=/path/to/noveltea
NT_SKILLS_CHECKOUT=/path/to/noveltea-skills pnpm exec tsx --test
test/story-context.test.ts`.

### Focused record scopes (#35)

A partial scope can instead target existing typed canonical records directly, for
example `character.ada`, `event.disclose-ledger`, `choice-point.loyalty`,
`puzzle.ledger-proof` or `authored-content.disclosure-scene`. Such a scope
**adopts verified existing Creative Direction and architecture context without
running discovery, global Character/World, or unrelated Milestone specialists**.
Each focused target becomes a checkpointed, independently committed `focus:<id>`
work item. A committed Story baseline and valid upstream references are required;
missing prerequisites block with an explicit authorization requirement, not an
automatically expanded Story generation pass. Source context is not write
permission. Only existing targeted records may be edited. To authorize a narrowly
bounded supporting change, list its typed record ID in `supportingTargets`; these
files are committed in the first targeted work item and independently reviewed.
Editing anything else blocks the commit and preserves the dirty worktree and Pi
session for manual recovery. Unrelated incomplete records do not become scoped
completion obligations. Real Pi works through the pinned domain-specific skill
and Context Manifest adapter; fixtures only verify mechanical contracts, never
literary completeness.

For instance, the same public `job generate start` entrypoint accepts:

```json
{
  "scope": {
    "kind": "partial", "preset": "full-composition",
    "targets": ["authored-content.disclosure-scene"],
    "branches": ["protect"], "supportingTargets": []
  },
  "constraints": ["Preserve both choices' consequences"],
  "envelope": {
    "presentation": "Dialogue-led visual novel",
    "hardLimits": [], "preferences": []
  }
}
```

Optional presets `architecture-outline`, `interactive-development`, and
`full-composition` normalize to the existing `architecture`, `interactive`,
and `composition` depths before the versioned completion contract is saved.
The legacy explicit `depth` form remains supported; a conflicting explicit
depth/preset is rejected. Combining an Arc/Milestone-wide generation target with
individual-record targets in one contract is rejected; use separate explicitly
authorized scopes to keep the requested write set unambiguous. Branch requirements are independently checked against
reachable Choice/branch witnesses, and no preset inserts a fixed number of
Arcs, Events, scenes or acts. A focused task that needs edits to unlisted
records must be replanned with explicit author authorization rather than
silently widening the write set.

`start` pins the objective, contract, fixture/Pi selection and explicit model/source
options. `resume` accepts no replacement inputs; it uses that same request. Existing
work-item receipts retain their own stronger brief/model/authorization checks.
A missing or unauthenticated architecture plan blocks the run. Approved, signed
architecture/scope revisions are adopted at a clean boundary, with current
obligations rebuilt from canonical Story coverage and explicit carry-forward
verification for unaffected specialist commits. Unapproved scope expansion is
blocked. The original contract and signed transitions remain in the checkpoint
history/architecture receipt; `inspect` shows the currently accepted contract.
No author question or protected decision is automatically approved.

The actual parent StateGraph has `schedule`, `author_update_intake`,
`specialist_dispatch`, `verify_committed_work`, and `completion_decision` nodes.
Per-job `generation.sqlite` lives beside `job.json`, under the effective
`NT_STATE_DIR`/XDG job state directory, with thread `<job-thread>:generation`.
Inspection returns the currently accepted request, original signed history in
the architecture receipt, per-Milestone completed commit evidence, current
versioned work inventory with typed dependencies/block reasons, next runnable
unit, checkpoint location and the existing source-linked job report. The live
inventory resides only in the parent's private SQLite checkpoints, **not** in
the signed `architecture.json` plan or Story canon; specialist commits and
signed plan transitions retain their original immutable authority. A separate crash-reclaimable parent
lease serializes CLI continuations; every writer still uses the existing shared
Story writer lock. No checkpoint is assumed to atomically commit Git or Pi effects.

To exercise cross-process resume, use `--pause-after foundation` (or
`architecture`, `foundations`, `event`, `interactive`, `composition`, `review`) on
start or resume. Every continuation re-enters the safe-boundary intake and uses
saved results or the current specialist's receipt/recovery API before advancing.
A commit made before receipt/checkpoint publication is reconciled by the original
specialist, not authored again. Interrupted writers, dirty worktrees and unexpected
HEADs preserve edits/transcripts and block for the existing manual reconciliation
procedures. Author `paused`/`cancelled` controls, pending questions/approvals, and
cumulative Pi budgets stop downstream dispatch. Use `job author resume` with the
exact typed response (and signed evidence where required), or explicitly raise the
job's budget before `generate resume`. Cancellation is not released by resume.

A run reports `completed` only when the existing current-scope report confirms
independent **real Pi** editorial completion. `--fixture` runs all deterministic
specialists and real Git/validator gates, but ends `blocked` with
`editorial-unverified`, never literary success. Other blocks include the unresolved inventory reasons and
return a resumable state. A blocked dependency is not a completed work item. The author's original checkout is untouched.

**Studio:** `pnpm studio` registers only **`story_generation`**, exported from
`src/studio.ts`. The old note/tagline prototype is no longer registered. For a fresh
disposable job, Studio input is `{"request":{"story":"/absolute/story",
"job":"draft-1","task":"Your objective","contract":{...},"fixture":true,
"skillsSource":"/absolute/noveltea-skills"}}`, using the full contract above.
Studio requires `request.story`, `request.job`, `request.task`, and the nested
`request.contract` (`scope`, `constraints`, `envelope`); `fixture`, provider/model,
and source overrides are optional. Specify `scope.depth` or `scope.preset`.
Generate a validated payload with `pnpm studio:input` rather than submitting an
empty request. LangGraph's API serializes its top-level graph input as a partial
state update, so Studio may still label the outer `Request` group **Optional**;
its nested mandatory fields are accurately marked required and the runtime
rejects a missing request before any specialist is dispatched. The external
Studio input schema is separate from the internal checkpoint state, whose
fields are not new-run form inputs.
Studio owns its server checkpoints; CLI `generate resume` uses the per-job SQLite
store, not Studio's thread. Use one execution surface per job, no concurrent
Studio/CLI runs, and the CLI for tested process-restart recovery. Studio resume
must retain the saved request/cursor/completed stages; never reset an interrupted
writer with a fresh Studio thread. Both surfaces invoke the same production graph
and existing specialist APIs, not the note/tagline graph. Hosted tracing remains
an independent opt-in (`NT_STUDIO_TRACE=1`); ordinary CLI generation disables it.

### Autonomous deferred-idea integration and editorial escalation (#34)

The production parent graph now examines the existing noncanonical idea-placement
task snapshots at safe work boundaries. After architecture is committed, eligible
in-scope ideas are placed when developed competing candidates exist (or the
generation is ready for final review). Dormant ideas remain invisible to normal
Story writers. A **separate read-only Pi reviewer** compares all candidate
canonical records, may reject them all, and chooses a reasonable location.
The existing dedicated placement specialist edits only the chosen canonical
record; the independent fulfillment reviewer checks original author intent,
meaning, wording, and participants before its Git-backed placement commit.
Neither a rejected placement nor a fixture-only integration satisfies a binding
completion obligation.

When new alternatives appear or the current realization changes, the parent
runs the existing semantic `ideas reassess --record` path. It never relocates
an integrated idea without the exact signed Ed25519 relocation approval.
Automation is capped at three candidate/context attempts per idea; further
reconsideration requires author action. The noncanonical
`generation-idea-dispatch.json` receipt fences interrupted Pi/editorial work.
If a writer was interrupted without a published placement receipt, inspect its
transcript and preserved worktree; **resume never blindly replays the writer**.
A verified integration and assessment trail is visible in `job generate
inspect` as `ideaHistory`. The pinned parent contract, original source text,
typed placement links, rationale, and full historical commits remain authoritative.

The parent delegates composition-only editorial repairs to the existing bounded
narrative reviewer. Structural and protected findings return an inspectable
`escalation` (`dependency-replan` or `protected-approval`) rather than
silently changing Story scope. The author must approve the existing exact signed
architecture/revision proposal before the scheduler reconciles dependencies,
preserves explicitly carried-forward work, and revalidates affected branches.
`completed` requires the independent real-Pi review and all in-scope binding
ideas; `blocked` and `paused` are not completion. The separate job report
continues to expose integration/merge-preview status.

Deterministic fixtures exercise the graph, Git isolation, provenance, rejection,
reconsideration and restart behavior without asserting literary quality.
Set `NT_IDEA_FIXTURE_REJECT=<idea-id>` only for deterministic rejected-location
tests; it has no effect on real Pi placement. The opt-in evaluation runs
fixture Story stages but uses real Pi for candidate selection, bounded craft
integration, and independent fulfillment review. It does not certify the
fixture-generated Story as a whole. To run it, set
`NT_LIVE_GENERATION_IDEA=1` and `NT_SKILLS_CHECKOUT` to the canonical skills
checkout, then run `pnpm exec tsx --test --test-name-pattern='opt-in real Pi generation semantically chooses' test/generation.test.ts`.

Verification (canonical sibling skills checkout required for fixtures):

```sh
pnpm exec tsx --test test/generation.test.ts
# Explicit opt-in: consumes model usage and can truthfully finish blocked.
NT_LIVE_GENERATION=1 NT_SKILLS_CHECKOUT=/path/to/noveltea-skills \
  NT_PROVIDER=openai NT_MODEL=gpt-6-luna NT_KEEP_FAILED_LIVE=1 \
  pnpm exec tsx --test --test-name-pattern='opt-in real Pi single-Milestone' test/generation.test.ts
```

The live test verifies actual pinned discovery-skill reads and Markdown editing,
then resumes the parent in a new process and checks its truthful outcome and author
checkout isolation. With `NT_KEEP_FAILED_LIVE=1`, disposable evidence is preserved
at the printed path (including on success). Fixture results alone certify neither
real skill invocation nor creative quality.

## Pi context reuse, pinned model policy and resumable budgets (#28)

Git-backed Story jobs keep canonical Markdown and the validated work-item plan authoritative. Pi
conversations are a reusable optimization, not another Story source of truth. Completed related
specialist conversations are restored or forked with Pi's supported `SessionManager` APIs into
the next work item's own session directory. Writer and independent reviewer contexts remain
separate; related milestones within the same Arc can reuse a prefix, while unrelated
Arc contexts and author-only deferred ideas never share conversations.
The first prompt retains a consistent skill/instruction prefix and explicitly states that saved
Story files supersede old conversation content. A private receipt records the pinned skill
snapshot, selected model, successful Story reads, source SHA-256 versions, and conversation
identity. Changed or newly relevant files are identified on the next assignment; a substantial
architecture change or overly long history causes a fresh scoped conversation. As with all
specialists, the Git-diff/validator gate owns publication, not Pi.

The default model is `openai/gpt-6-luna`. To set a **job-level** profile and optional
budgets before writing, run:

```sh
pnpm dev job pi configure --story /path/to/story --job draft-1 \
  --provider openai --model gpt-6-luna --thinking low \
  --max-steps 8 --max-model-calls 150 --max-cost-usd 10
pnpm dev job pi inspect --story /path/to/story --job draft-1
```

You may supply **both** `--fallback-provider` and `--fallback-model` to permit an
explicit fallback *only if* the requested model/capability is unavailable. The selected
provider/model and whether fallback occurred are persisted and inspected through
`job pi inspect`. A resumed workflow will not silently switch from its pinned selection;
unavailable mandatory models or reasoning capabilities fail explicitly. Work-item CLIs
that do not specify another model use the configured job profile.

Budgets are optional and cumulative across the job. Pi's saved assistant usage (including
reported cost) supplies observed model-call/cost totals; shared history from forked
sessions is counted once. When a cost budget is configured but Pi omits a model
call's price, the next safe boundary pauses with `cost-unavailable` rather than
incorrectly treating unknown spend as free. No independent telemetry service is created. A limit reached at
a safe assignment boundary returns `{"status":"paused-budget","resumable":true}`
without starting a new specialist turn. The job runner checks budget and required
model availability **before** persisting the writer-start marker; a pause leaves the
work item retryable without an interrupted-write reconciliation. Independent review
nested inside an active writer defers its budget gate to the next safe boundary.
Increase the limit via `job pi configure` and
rerun the same command; counters are not reset. Once a writer has begun an assignment,
its bounded repair prompts can finish without an artificial mid-edit budget interruption.
An actual process crash or partial tool edit still requires the established Git/worktree
reconciliation; do not blindly replay an interrupted writer.

Private receipts live next to the job's `job.json`: `pi-policy.json`,
`pi-resolution.json`, `pi-budget.json` and `pi-contexts/`. Individual Pi JSONL files
remain in their existing role-specific session directories. Tokens, latency and cache-hit
details continue through existing Pi/LangGraph/LangSmith or local traces when available.
Opt-in live model tests are separate from deterministic CI.

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

Snapshots are stored at `~/.cache/noveltea-gen/skill-snapshots/<full-sha256>/`, or under `$XDG_CACHE_HOME/noveltea-gen/skill-snapshots`. Set `NT_SKILL_CACHE_DIR` to override the cache root (for example, the gitignored `.local/skill-snapshots` directory). A new snapshot is staged and checked before atomic directory publication; existing verified digests are reused between Story projects and workflows. Published snapshot files and directories are **read-only** (files `0444`, directories `0555` on POSIX); valid older cache entries are sealed on reuse. The pinned Pi read tool checks both the verified file allowlist and each resource hash, rejecting later file injections or mutations. Source filtering never applies to cache verification: unexpected `dist/`, `node_modules/`, or even empty directories invalidate a published snapshot. To delete a disposable read-only cache manually, first restore owner write permission on its directories. Invalid existing snapshots are **not** silently repaired or replaced. Missing or corrupted pinned snapshots stop recovery with an actionable error, and referenced snapshots are retained indefinitely until manually removed. No installers, updates or automated garbage collection run.

LangGraph checkpoints persist the snapshot identifier, full digest and source Git commit, branch (or detached HEAD) and dirty status. The selected snapshot is also included in CLI run output. On every resumed run, the pinned cache directory is validated **before** a Pi agent is restored. NovelTea-skills discovery and the restricted skill reader use that directory; changed, pulled or even deleted source checkouts have no effect on resumed skill contents. A new workflow captures the current live checkout instead. Snapshot metadata can appear in graph trace metadata when tracing is explicitly enabled; **skill contents are not uploaded** as snapshot metadata. Skills that the model actually reads can still appear in Pi transcript/model conversations, as expected.

## Git-backed Story job setup (#13)

Use the separate public job entry point to establish a durable, isolated Git
baseline before future Story-generation work:

```sh
pnpm dev job start --story /path/to/existing-git-repo/story --job draft-1
# Repeat the identical command to re-open the same job and worktree.
```

`--story` must name an **existing directory** within an **existing Git
worktree** with a committed HEAD. The directory can be empty, or contain
previously committed canonical Story records. Paths are canonicalized, so
symlink aliases refer to the same Story. No Git initialization, staging,
committing, stashing or author-branch checkout takes place.

New jobs reject tracked edits, staged edits and untracked files **within
the selected Story root**; unrelated dirty files in a containing monorepo are
permitted. Each `--job` ID is a stable logical identity for that Story,
and distinct IDs (or different sibling Story roots) receive distinct branches,
worktrees and thread IDs. A resumed job may have unfinished files or later
commits in **its own** worktree. The original author branch is never modified
or automatically merged.

The command prints machine-readable JSON with `jobId`, `storyRoot`,
`storyRelativePath`, `gitRoot`, `baseSha`, `branch`, `worktreeRoot`,
`worktreeStoryRoot`, `headSha`, and the durable `threadId`. The job
branch is `noveltea-gen/<sha256>`; it is checked out only in its own Git
worktree. By default persistent job metadata and the worktree live outside
the author's Git checkout:

```text
~/.local/state/noveltea-gen/jobs/<sha256>/job.json
~/.local/state/noveltea-gen/jobs/<sha256>/worktree/
```

`XDG_STATE_HOME` changes the state base and `NT_STATE_DIR` replaces the
application state root; storage resolving inside the author Git checkout
is rejected. Lost, altered or unexpected job worktree/branch identity
fails closed instead of silently creating another. A second invocation with
the same Story and job reopens the existing worktree, even if the author's
checkout has since changed. Optional `--noveltea-project /path/to/engine`
stores a separate future engine-project path as metadata only; engine records
are never opened.

This ticket establishes the Git job boundary only. The older `run`
LangGraph/Pi proof of concept below still operates directly on its explicit
`--project` directory, and does **not** automatically start or attach a
Git-backed job. The production `job generate` parent consumes this durable
job worktree and thread identity. Do not treat `job start` as a completed
narrative-generation run.

## Native Story validation (#14, #22)

After creating a Git-backed job, validate the **Story in that job's
worktree** with the native NovelTea CLI. Install `noveltea` on `PATH` or set
`NT_NATIVE_CLI` to an absolute executable path:

```sh
pnpm dev job start --story /path/to/git-repo/story --job draft-1
pnpm dev job validate --story /path/to/git-repo/story --job draft-1
```

New jobs use only `noveltea narrative validate` with the verified Git
`--base` and `noveltea narrative readiness`. Native context selection uses
`noveltea narrative context`. The generator does not compile a TypeScript
catalog or implement a second narrative schema. The native executable's
resolved path and SHA-256 are pinned in `validator.json` and `job.json`;
missing or changed binaries fail closed. Replace or restore the originally
pinned binary explicitly rather than silently switching versions mid-job.
A valid historical commit with no Story Markdown is a checked empty Story
baseline: newly authored records appear in `protection.impact.changed`.

`job validate` preserves the `noveltea-validator/v1` envelope used by
existing generation stages: status, diagnostics, readiness, coverage,
protected-decision findings and downstream impact. Structural validity does
not confer author approval, editorial completeness, or engine playability.
Pi writing specialists use the dedicated `story_validate` tool, which binds
the trusted job baseline automatically; no fake `noveltea` executable or
PATH interception is installed. Agent Bash remains available for ordinary
authoring and inspection, not as the source of authorization.

Historical jobs already pinned to `canonical-typescript-bundle` continue
using their original verified, content-addressed artifacts; missing or
corrupted pins fail closed. New jobs never bundle the experimental validator.
`--validator-source` is retained only for compatibility with such jobs.
See [docs/validator-cutover.md](docs/validator-cutover.md) for native parity
tests and legacy compatibility details.

## Git-backed Creative Direction generation (#15)

Once a Story job has been started, run a pinned Creative Direction work item:

```sh
pnpm dev job start --story /path/to/git-repo/story --job draft-1
pnpm dev job foundation --story /path/to/git-repo/story --job draft-1 \
  --mode autonomous \
  --task "A mystery aboard a stranded midnight train; invent unspecified details" \
  --envelope "Dialogue-led visual novel, compact cast, reusable locations"
```

Configure `.local/config.json` to point to the `noveltea-skills` checkout first, or specify `--skills-source /path/to/noveltea-skills` for a new job. A new foundation item pins the exact skills snapshot; validation independently pins the native NovelTea executable. Ordinary execution requires Pi credentials. Set `--provider` and `--model` to override the default. Only `--fixture` uses a deterministic non-model specialist; fixture outcomes are **not** Pi evidence.

For collaborative discovery, start with `--mode collaborative --task "..." --envelope "..."`. The first invocation reads pinned guidance (real Pi, or a deterministic fixture) and returns `status: awaiting-author`, a set of author questions and a durable handoff **without writing the Story**. Resume with the same `--story` and `--job` plus `--author-input "Your decisions; delegate everything else"` (and `--fixture` if testing). The worker mode and model/provider are persisted and cannot change silently on continuation. Explicit author constraints become user-protected decisions; delegated choices remain agent-origin. The work item can be reopened without creating another commit.

The writing specialist works inside the isolated job Story directory, reads the actual pinned `nt-story-discovery` and `nt-catalog` skill files and uses ordinary Pi read/write/edit, search and Git inspection tools. There is no structured-record writer. **LangGraph** owns the separate validation/commit node, checks the exact file diff, unexpected staged/out-of-scope changes, branch HEAD and canonical validator report, and makes a single agent-attributed commit with `NovelTea-Job` and `NovelTea-Work-Item` trailers. A job with one existing tracked Creative Direction edits that file; an empty Story creates `creative-direction/foundation.md`. Ambiguous multiple foundations, unauthorized protected changes, missing readiness and unexpected edits block committing. Existing edits are preserved for manual inspection, not automatically reset.

**Empty Story baseline:** the experimental canonical Git-protection contract cannot verify changes against an initial commit without Story Markdown. The graph verifies that absence independently, requires the canonical **structural** and foundation-design readiness checks to pass, and reports `validation: unverified-empty-baseline` instead of claiming user-protection verification. Already-established Story baselines require an actual checked protection report. No author approval, literary quality or full Story completion is implied by a foundation commit. The specialist is not given the optional engine-project root and is directed to work only on Story Markdown; unrestricted shell access is not an operating-system sandbox, so the graph independently gates the Git changes it commits. No automatic merge into the author's checkout occurs.

The job's `foundation.json` (brief, provenance, handoff, target, commit and validation identity) lives beside `job.json` outside the author's checkout. Read-only discovery transcripts are stored in `foundation-discovery-sessions/`; real writing sessions in `foundation-sessions/` in that same job-state directory. After an interrupted partial edit, inspect the preserved worktree instead of blindly restarting the specialist. If the commit completed before its receipt, a one-commit provenance check can recover it. Future tickets expand job-wide checkpoints, approval management and planning.

To certify the public CLI deterministically, run `pnpm exec tsx --test test/foundation.test.ts`; it includes a real canonical-catalog integration case when the sibling skills checkout is present. To certify **real Pi** authoring using your configured Pi credentials, explicitly opt in:

```sh
NT_LIVE_FOUNDATION=1 NT_SKILLS_CHECKOUT=/path/to/noveltea-skills \
  pnpm exec tsx --test test/foundation-live.test.ts
```

The opt-in test inspects the Pi session's actual pinned skill reads and Markdown editing tool calls, the validated output and the Git branch. It can incur model charges. Neither fixture passing nor a model's own completion claim substitutes for this evidence.

## Scoped Story architecture and work-item DAG (#17)

After a canonical Creative Direction has passed foundation design readiness, an
architecture job uses the existing Git-backed Story job/worktree. Scope is a
typed **author completion contract**, not a model-suggested stopping point.
Provide a JSON file such as:

```json
{
  "scope": {
    "kind": "partial",
    "depth": "architecture",
    "targets": ["arc.mystery", "milestone.first-revelation"],
    "branches": []
  },
  "constraints": ["The revelation must preserve the player's ability to refuse"],
  "envelope": {
    "presentation": "Dialogue-led visual novel",
    "hardLimits": ["Reuse the existing interrogation location"],
    "preferences": ["Minimize bespoke backgrounds"]
  }
}
```

Run `pnpm dev job start --story /path/to/story --job draft-1` if the
job does not yet exist, then:

```sh
pnpm dev job architecture run --story /path/to/story --job draft-1 \
  --contract ./architecture-scope.json \
  --skills-source /path/to/noveltea-skills
pnpm dev job architecture inspect --story /path/to/story --job draft-1
```

The **autonomous** mode requires the contract up front. In
`--mode collaborative`, the first run may omit `--contract`, returning
`awaiting-author` without Story edits; supply the contract on a later `run`
using the same mode, Story and job. `--fixture` selects a deterministic
test specialist (and must remain selected on continuation), not real Pi
authorship. A full-Story contract uses `kind: "full-story"`,
`depth: "composition"` and empty targets/branches; this plans the downstream
work and **does not claim** full-Story completion. Partial scope supports
targeted Arc/Milestone IDs, branch intent, and architecture/interactive/
composition depths. Branch intent and qualitative constraints require later
editorial and interactive verification: architectural validation alone does
not prove a playable route. A branch-scoped job therefore reports
`architecture-committed`, not `complete-in-scope`, until branch evidence exists.

The architecture specialist reads pinned `nt-story-architecture` and
`nt-catalog` guidance, writes canonical `arcs/*.md` and
`milestones/*.md` directly, and does not fabricate Events. Unbound
planning-stage Milestones use `completeness: partial` and
`fulfillment: {any_of: []}`. The pinned validator checks canonical
structure, architecture readiness, protection and recorded outstanding
obligations. The graph independently enforces the authorized paths,
verifies the diff and commits an architecture work item. Inspect the returned
typed dependency DAG, verified commit SHA, queued realization/composition/
review items, obligations and unverified editorial evidence. Stored receipts,
architecture Pi transcripts and the plan's previous authorized versions live
in the job state directory (`architecture.json`, `architecture-sessions/`).
Never reset an interrupted writer's uncommitted work; inspect and reconcile it.
No changes are automatically merged into the author's normal checkout.

### Story work-item crash recovery (#23)

Job state lives beside the persistent job worktree. `job.json` pins Git,
branch/worktree, trusted base and thread identity; `foundation.json` and
`architecture.json` pin current work-item state, the last expected verified
HEAD, authoring files/digests and Pi-session identity. The model and skills
snapshot and independently pinned validator are unchanged on resume.

`job architecture inspect --story <original-story> --job <id>` reports
`recovery` with actual HEAD, uncommitted paths and either `ready`,
`recoverable-commit` or `blocked`. When blocked, the top-level status
is also `blocked`, with the reason and preserved Git state. No worker is
invoked by inspection. Retrying `architecture run` from a safely authored
receipt revalidates *the same recorded bytes*, or recognizes an exact
single work-item commit (parent SHA, paths, digest and provenance) that
completed before receipt publication. It cannot create a second accepted
commit. Validation failures retain the original writer's files and receipt.

A crash after a worker starts but before a complete authored receipt is
**not** permission to create a new Pi conversation or overwrite partial
Markdown. Restoring the original session transcript is required; missing or
corrupt transcripts, ambiguous edits and unexpected Git/staged changes
produce a reviewable block. Inspect the actual changed files, finish or
correct them manually if necessary, and take the exact
`recovery.candidate.digest` from `architecture inspect`:

```sh
pnpm dev job architecture reconcile --story /path/to/story --job draft-1 --digest <reviewed-sha256>
pnpm dev job architecture run --story /path/to/story --job draft-1 --fixture
```

The second command uses `--fixture` **only when the original worker was a fixture**.
For Pi-authored jobs, omit it. `reconcile` records human review of the
existing bytes, with distinct Git provenance; it does not rerun the writer,
approve protected decisions, or skip canonical validation. If the candidate
is absent, resolve unexpected file/staging changes first, or start a
separate job. Never edit receipt hashes to bypass this review.

Foundation work items also pin authored bytes before their Git commit and
never restart an interrupted writer automatically. Their parallel inspection
and explicit-reconciliation interface is:

```sh
pnpm dev job foundation --story /path/to/story --job draft-1 --inspect
pnpm dev job foundation --story /path/to/story --job draft-1 --reconcile-digest <reviewed-sha256>
pnpm dev job foundation --story /path/to/story --job draft-1
```

For fixture jobs include `--fixture` in each invocation. The digest comes
from the inspection response's `recovery.candidate.digest`, after
reviewing the actual `creative-direction/*.md` edit. The resumed run checks
the same digest, original Pi transcript (when applicable), unchanged Git
baseline and canonical validation before committing the existing bytes.

Character/World foundation work items use the same job-wide lock and
recoverable receipt discipline. `job foundations inspect --story <story>
--job <id>` exposes the interrupted World or Character unit and candidate
paths/digest. After inspecting the preserved files, use:

```sh
pnpm dev job foundations reconcile --story /path/to/story --job draft-1 --digest <reviewed-sha256> --fixture
pnpm dev job foundations run --story /path/to/story --job draft-1 --fixture
```

Omit `--fixture` for a Pi-authored job. Both commands verify the pinned
original session when applicable and never create another conversation.
The reviewed files are checked against the specialist's allowed record
inventory and canonical protection before a single provenance-marked commit.
Unexpected staging, manual commits, corrupt sessions and unauthorized Arc
rewrites block without discarding the Story changes.

Foundation, architecture, Character/World and protected revision actions share a single
per-job `.story-job-running/owner.json` exclusive lock. Concurrent
processes cannot commit or resume into the same worktree. If the local owner
PID is definitively dead, a later invocation archives the stale lock as
`.story-job-stale-<nonce>/` before acquiring a fresh one; remote-host,
live-process and corrupt/unpublished locks fail closed for inspection.
Neither the stale evidence nor any Story files or Git history are discarded.

An existing scope cannot be changed by passing a different `--contract` to
`run`. At a clean, verified work-item boundary, the author may approve an
exact, versioned proposal:

```sh
pnpm dev job architecture propose --story /path/to/story --job draft-1 \
  --contract ./revised-scope.json
# Independently review and Ed25519-sign authorSigningRequest from propose.
pnpm dev job architecture approve --story /path/to/story --job draft-1 \
  --proposal <digest-from-propose> --signed-evidence /path/to/signed-plan.json
pnpm dev job architecture run --story /path/to/story --job draft-1
```

A revision reuses already verified architecture only if it meets the new
contract; otherwise it writes and validates another bounded architecture
cluster. Plan revisions require a separately Ed25519-signed author approval,
using the public key pinned in the original author Git baseline (see
[offline author signing](docs/author-signing.md)). `propose` returns an
`authorSigningRequest` containing the exact plan version, head and proposal
SHA; the author reviews the entire new contract before signing the request.
Unsigned CLI assertions and model claims are not authorization.
Test the public interface with
`pnpm exec tsx --test test/architecture.test.ts`.

## Deferred author idea inbox (#24)

Deferred Event concepts, conversations, exact dialogue and narrative anchors are **not**
canonical Story records. They live as one Git-tracked YAML 1.2 file per idea
under the reserved `.story-inbox/ideas/<stable-id>.yaml` path within the
**job worktree's Story root**, not in the disposable `.noveltea` cache.
The files use JSON formatting (a strict, valid subset of YAML 1.2) so literal
dialogue and individual requirements survive serialization without loss.
An author's normal checkout is not altered.

Capture author material explicitly during initial onboarding (after `job
start`, before `job foundation`) or at a clean, verified continuation boundary:

```sh
pnpm dev job ideas capture --story /path/to/story --job draft-1 --file ./idea.json
pnpm dev job ideas inspect --story /path/to/story --job draft-1
pnpm dev job ideas eligibility --story /path/to/story --job draft-1
pnpm dev job ideas context --story /path/to/story --job draft-1 --target arc.truth
pnpm dev job ideas placement-context --story /path/to/story --job draft-1 --target event.reveal
```

The `--file` contains a JSON object; for example:

```json
{
  "id": "the-bell-conversation",
  "kind": "exact-dialogue",
  "source": { "kind": "author-onboarding", "reference": "notebook p. 7" },
  "original": "Mara: \"No one remembers the bell.\"",
  "requirements": {
    "meaning": [{ "text": "Mara's confession changes trust", "binding": true }],
    "wording": [{ "text": "No one remembers the bell.", "binding": true }],
    "participants": [{ "text": "character.mara", "binding": true }]
  },
  "identities": { "known": ["character.mara"], "unresolved": ["silent witness"] },
  "prerequisites": ["milestone.disclosure"],
  "placement": {
    "scopeIds": ["arc.truth"],
    "flexible": true,
    "earliest": "event",
    "minRelevantEvents": 3,
    "minRelevantMilestones": 2
  },
  "upstreamConstraints": [
    { "text": "Keep Mara present in the truth arc", "targets": ["arc.truth"], "authorized": true }
  ]
}
```

The optional ID is a safe slug; when omitted, a content-addressed ID is
derived from the capture request. Distinct meaning/wording/participant
requirements remain **individually binding**, not collapsed into a broad
paraphrase. The source and `original` preserve author wording. Optional
`unresolvedPrerequisites` preserves free-text prerequisites that have no
canonical ID yet; they block eligibility rather than being silently assumed
fulfilled. The `lifecycle` starts `dormant`, with null activation/placement references
and an empty placement history. Placement and reassessment are handled by the
separate, author-intent-aware #27 workflow below.

A capture obtains the shared job writer lock, checks the trusted HEAD and
clean worktree, then records a durable receipt **before** writing the idea.
The only new Git path in its commit is that idea's YAML, with exact blob
hash and provenance trailers; commit recovery checks parent, path, hash
and trailers. Replaying the same capture returns its original commit,
even across process restart; a conflicting stable ID, unexpected Git
changes or an interrupted other writer blocks without overwriting author
work. A capture between architecture and Character/World foundations
advances the verified starting HEAD without changing the authorized plan.

The interfaces have deliberately different audiences:

- `ideas inspect` returns the complete committed author inbox **only** for
  direct author inspection; do not forward it to Story writing agents.
- `ideas eligibility` returns *IDs, depth, relevant breadth and unmet
  prerequisites*, never original prose. Only declared scope/actual record
  references count. Dialogue requires at least three relevant Events and
  two relevant Milestones, not just an opening Event. Partial Story scopes
  may leave ideas dormant indefinitely.
- `ideas context --target` returns **only** explicitly authorized,
  target-scoped upstream constraints, never unplaced original wording.
- `ideas placement-context --target` is reserved for a **dedicated**
  placement specialist (#27), and returns original content only when the
  idea is eligible and the selected canonical target has the correct depth
  and Arc/Milestone relevance.

Existing Pi writing specialists are instructed not to read or search the
reserved directory. Ordinary inspections (including grep/rg/git diff)
remain available; the source-selection boundary and scoped context API
are not a filesystem-level security sandbox. Capturing an idea never
implicitly places it. Incoming unsolicited author messages are routed to
this inbox by #25.

Test with `pnpm exec tsx --test test/ideas.test.ts test/foundation.test.ts
test/character-world.test.ts`.

## Independent deferred-idea placement and reassessment (#27)

The generator creates noncanonical, scheduler-only idea-placement task
snapshots at completed architecture, Character/World, Event, Interactive,
Composition and final-review boundaries (in `idea-placement-tasks.json` under
the job state directory). Scheduling tracks eligibility and compares **all**
relevant developed Event, Milestone or Authored Content targets rather than
forcing the first match. Nothing in a normal craft writer's context receives
the complete dormant inbox. An eligible idea with no suitable canonical
placement remains deferred.

```sh
pnpm dev job ideas plan --story /path/to/story --job draft-1
pnpm dev job ideas place --story /path/to/story --job draft-1 \\
  --id the-bell-conversation --target authored-content.disclosure \\
  --skills-source /path/to/noveltea-skills
pnpm dev job ideas audit --story /path/to/story --job draft-1
pnpm dev job ideas reverse --story /path/to/story --job draft-1
pnpm dev job ideas reassess --story /path/to/story --job draft-1 \\
  --id the-bell-conversation
pnpm dev job ideas reassess --story /path/to/story --job draft-1 \\
  --id the-bell-conversation --record --skills-source /path/to/noveltea-skills
pnpm dev job ideas relocate --story /path/to/story --job draft-1 \\
  --id the-bell-conversation --target authored-content.later
```

`plan` returns only IDs, eligibility, relevant breadth and competing canonical
candidates. Dedicated `place` starts a pinned **existing** craft specialist
(architecture, Event design or composition) on a single explicitly selected
canonical target, then validates scoped structure/protected decisions and
launches a separate, read-only `nt-narrative-review` Pi session to check the
literal source against original author intent, protected wording, participants
and semantic obligations. An integration is committed only after both gates
pass. Exact protected dialogue is additionally checked byte-for-byte. `--fixture`
provides a deterministic structural test of the same public workflow, but its
output remains `integrated-editorial-unverified` and cannot satisfy a binding
completion obligation. Blocked edits are left for manual reconciliation; no
blind restart or author-branch merge occurs.

Each integration and reassessment is stored as a new commit. The immutable
original/source/requirements are preserved in `.story-inbox/ideas/*.yaml`
(JSON-subset YAML), while `lifecycle.placements` records the current canonical
IDs, candidate comparisons, rationale, Git predecessor, actual realization
fingerprint, model evidence and historical review sessions. Immutable capture
receipts and later placement receipts are checked against every Git ancestor,
blob/path inventory and provenance trailer. `reverse` derives canonical
record ID → inbox ID relationships from those histories, without introducing
provenance keys into canonical frontmatter.

`audit` rechecks current realization bytes and newly developed plausible
locations. `reassess` proposes changes and impact; `--record` performs a new
semantic review and commits a historical retained-placement entry. A real
reviewer is required to mark that entry `pi` verified; a fixture cannot do so.
The final scoped narrative review checks outstanding binding ideas, but
unrelated partial-scope ideas remain deferred without failing the requested
scope. Changed canonical text or newly developed alternatives invalidate stale
fulfillment until reviewed again.

`relocate` first returns `approval-required` with its precise
`proposal` (SHA-256 of the current head, old/new ID and competing locations),
plus affected paths. The caller must produce an offline **Ed25519-signed**
`kind: decision`, `action: approved` payload bound to `workItemId:
idea-relocate:<id>`, `verifiedHead`, and `changeId`/`proposalSha256` equal to
that exact proposal; see `docs/author-signing.md`. Supply it using
`--signed-evidence /path/to/signed-approval.json`. Only then may a bounded
craft specialist edit both old and new realization records. The old occurrence
is removed, the new one is validated and independently reviewed, and one
commit records both canonical paths and the inbox's updated current IDs. The
signed approval itself is retained and verified in historical placement receipts.

Run `pnpm exec tsx --test test/idea-placement.test.ts` for deterministic
full-CLI integration, relocation and tamper tests. To exercise real pinned Pi
craft authorship and separate semantic review (model usage required):

```sh
NT_LIVE_IDEA_PLACEMENT=1 NT_PROVIDER=openai NT_MODEL=gpt-6-luna \\
  NT_THINKING=low pnpm exec tsx --test test/idea-placement.test.ts
```

## Live author messages and LangGraph approval interrupts (#25)

The author can submit unsolicited narrative updates while a Pi writer is actively
editing, without interrupting its tool calls or taking its Git writer lock.
Messages are immutable, per-job JSON records stored **outside canonical Story**
at the job state directory's `author-updates/messages/<id>.json`; acknowledgements
are in `author-updates/receipts/<id>.json`. A message ID is an optional explicit
lowercase slug, or a content-derived stable ID. Duplicate sends return the
existing receipt; conflicting content under the same ID is rejected. Receipts
distinguish `queued`, `awaiting-author`, `review-required`, and `applied`.

```sh
pnpm dev job author send --story /path/to/story --job draft-1 --file ./message.json
pnpm dev job author inspect --story /path/to/story --job draft-1
pnpm dev job author process --story /path/to/story --job draft-1
pnpm dev job author plan --story /path/to/story --job draft-1 --id change-1 --file ./revised-contract.json
pnpm dev job author resume --story /path/to/story --job draft-1 --file ./response.json
pnpm dev job author control --story /path/to/story --job draft-1 --state paused
pnpm dev job author control --story /path/to/story --job draft-1 --state running
```

Messages use the envelope `{"id":"note-1","kind":"idea","payload":{...}}`.
The four kinds are:

- **`idea`** — `payload` is the exact #24 deferred-idea capture object
  (source, original wording, requirements, prerequisites, placement). When
  processed, it produces its own independently verified, idempotent Git commit.
  The next ordinary writer receives **no** dormant idea source or dialogue.
- **`change`** — `payload` has `text`, `affectedIds` (canonical IDs, or an
  empty array if unknown), and optionally `proposedContract` in the existing
  architecture completion-contract format. Processing records affected work
  items, scope/depth/version and an **unverified impact review**. When a
  contract is given, it creates an exact versioned `job architecture propose`
  proposal but **does not approve or implement** it. If the author did not
  submit a contract initially, use `job author plan --id <change-message>`
  to attach one at a later safe boundary. The message remains
  `review-required` until independently approved; a matching signed plan
  approval then marks the review applied.
- **`question`** — `payload` is
  `{"question":"Should the witness be trusted?"}`. The graph emits an
  interrupt and awaits a typed answer, with no speculative writer action.
- **`approval`** — `payload` is either
  `{"requestType":"plan","proposalSha256":"<digest>"}` or
  `{"requestType":"decision","workItemId":"change-witness","proposalSha256":"<digest>","changeId":"<digest>"}`.
  It pauses on a persistent LangGraph interrupt bound to this precise request.
  A response alone is not authorization: the Ed25519 signature must verify
  against the author's public key in the **original Git baseline**, and the
  proposal, decision, thread and verified HEAD must match. Approval is routed
  through the existing #16 versioned architecture or protected-revision gate.

The two typed resume-file shapes are:

```json
{ "type": "answer", "messageId": "note-1", "answer": "Leave it ambiguous." }
```

```json
{
  "type": "decision",
  "messageId": "approve-the-witness",
  "signedEvidence": {
    "payload": { "version": 1, "kind": "decision", "jobId": "draft-1",
      "threadId": "<original job thread>", "workItemId": "change-witness",
      "baseSha": "<original base>", "verifiedHead": "<verified HEAD>",
      "proposalSha256": "<exact proposal digest>",
      "decision": "creative-direction.foundation#witness",
      "changeId": "<exact change digest>", "action": "approved",
      "reason": "Substantive author rationale explaining the specific approval" },
    "signature": "<base64 Ed25519 signature over JSON.stringify(payload)>"
  }
}
```

For a plan approval, use the exact `authorSigningRequest` returned by
`job architecture propose` (with a substantive author rationale) and
provide its signed payload instead. For protected decisions, use the
`authorSigningRequests.decisions[]` returned by `job revision inspect`.
Do not invent or edit the proposed digest or protected-change IDs.

`job author process` acquires the shared Story writer lock. The
`process_author_updates` LangGraph node checkpoints each message into
`author-updates/checkpoints.sqlite`; questions and approvals resume that
same saved thread using `Command(resume)`, without restarting Pi sessions
or regenerating canonical Markdown. A crash after Git capture or signature
application is reconciled against its durable receipt and Git/signature
provenance. Generation also checks pending messages **before starting**
a safe foundation, architecture, Character/World, Event, Interactive or
Composition work unit and **after** completed work-unit graphs. Interactive
Choice and Puzzle are distinct safe boundaries. All these writers share
the same per-job lock; a paused or approval-blocked job cannot start its
next specialist. The resulting `authorUpdates` field reports
any queued/applied work or outstanding approval without rewriting the
completed work's commit. Event-to-Interactive and Interactive-to-Composition
continuations accept an intervening verified, independently recorded deferred
idea capture. The new writer starts from its actual verified HEAD while
retaining the source specialist's historical commit; intervening changes to
canonical narrative premises require separate impact review. Signed plan
proposals likewise bind the current verified HEAD without changing historical
architecture provenance. Puzzle's saved `beforeHead` also permits an exact
verified idea capture **between Choice and Puzzle**, with both commits
independently checked before Composition.

After an approved scope replan, previously committed specialists retain their
historical plan version. They are **not silently upgraded**: an author who has
reviewed unaffected work must explicitly include its work-item IDs in the
next signed plan proposal. For example, place
`["foundations", "event:milestone.disclosure"]` in `unaffected.json` and run:

```sh
pnpm dev job architecture propose --story /repo/story --job draft-1 \
  --contract revised-scope.json --carry-forward unaffected.json
```

`job author plan` also accepts `--carry-forward unaffected.json` for a
pending direct-change impact review. The proposal digest and Ed25519 signature
bind this exact list, previous plan, new contract and verified HEAD. Every
listed work item must have a committed receipt on that branch, and a downstream
item requires its upstream dependencies (e.g., an Event requires foundations;
Interactive requires its Event and foundations). The code verifies the
historical commit provenance, retains original receipt versions and only
allows *new* specialists under the revised plan. Approval cannot be inferred
from validation or a version number alone.

Omitted or impacted work remains **blocked**, with an explicit carry-forward
error rather than an automatic rewrite. The author can review and sign a
subsequent plan re-evaluation that names still-valid work, even if a previous
replan did not carry it forward. Work that genuinely requires new canon must
instead undergo independently authorized revision and work-item replanning;
the system does not automatically replay previously committed Pi specialists
over existing canonical files. There is no external polling daemon: a new
`job author process` or a subsequent safe job invocation drives the
next boundary.

Execution controls are separate from narrative messages: `--state paused`
prevents processing/starting new work without interrupting an in-flight
Pi writer; `running` explicitly releases this execution pause **but
does not answer** any LangGraph approval interrupt. `cancelled` and
`completed` are terminal for that job ID and do not accept new messages.
New unrelated author messages cannot resume a pending approval or restart a
canceled/completed job. Do not treat a `review-required` message as a
completed scope change; only signed, matching author approval resolves it.

**Cooperative active Pi cancellation (#36).** A `cancelled` control is
delivered across processes to the running Pi specialist (including repair and
review turns) through Pi's supported `abort()` lifecycle. It is not merely
polled at the next work boundary. The active `job author control --state
cancelled` result is an *intent*, not proof of termination. Query `job author
inspect` for `activeSpecialist`: `cancellation-requested-not-yet-settled`
means the owner can still be editing; `cooperative-aborted` requires a
new Pi assistant stop reason of `aborted` and a settled turn.
`cancelled-at-boundary` means the turn settled without a confirmed abort;
`cancellation-unverified` means an abort was sent but Pi did not report an
aborted turn. `provider-failed` and `owner-exited-without-pi-settlement`
distinguish provider errors and process crashes. `abort-unavailable` means
the provider/abort could not be verified idle and the Story writer lock
has been retained. No hard real-time
termination or exactly-once external effects are promised.

The private job-state `active-specialist.json` records the exact work item,
original Pi session file/ID, expected and actual HEAD, and dirty file inventory.
Earlier commits and unfinished Markdown remain in the isolated worktree.
The specialist receipt still requires explicit inspection/reconciliation;
cancellation never creates a commit, resets edits, deletes the worktree or
replays Pi writers. If abort fails or a provider remains unresponsive, inspect
the owner PID, retained `.story-job-running` lock, Pi transcript and worktree
before any recovery. A dead owner's stale lock is archived by normal recovery,
not silently erased. Unlike cancellation, `paused` never aborts Pi: it waits
until the current serialized work unit reaches a safe boundary.

To verify cross-process behavior deterministically, run `pnpm exec tsx
--test test/story-interruption.test.ts`. An opt-in live Pi cancellation smoke
test is available with `NT_LIVE_CANCEL=1 NT_SKILLS_CHECKOUT=/path/to/noveltea-skills
pnpm exec tsx --test test/story-interruption-live.test.ts` (requires working Pi
credentials and a long enough live turn to deliver the abort).

Run `NT_SKILLS_CHECKOUT=/path/to/noveltea-skills pnpm exec tsx --test
test/author-updates.test.ts` to exercise real public CLI/process boundaries,
separate-process checkpoints, writer-lock contention, exact signed plan and
protected-decision approvals, crash recovery and negative controls.
Live Pi/prompt-quality certification is separately tracked under #31.

## Canonical Character and World foundations (#18)

After `job architecture run` has committed a verified Arc/Milestone cluster,
develop its Story foundations in the **same isolated job worktree**:

```sh
pnpm dev job foundations run --story /path/to/story --job draft-1 \
  --skills-source /path/to/noveltea-skills
pnpm dev job foundations inspect --story /path/to/story --job draft-1
pnpm dev job validate --story /path/to/story --job draft-1
```

`run` uses two **serialized LangGraph work units**. First, the real Pi
`nt-worldbuilding` specialist authors `world-entities/*.md` and `facts/*.md`,
including objective initial truth. Then the real Pi
`nt-character-development` specialist authors `characters/*.md`,
`relationships/*.md`, honest initial Fact knowledge and (when necessary)
**only** the `characters` array of a relevant, planned `arcs/*.md` record.
Each specialist reads its own pinned skill and the canonical catalog,
receives the current completion contract and a bounded set of relevant
source files, and reports exactly which records it modified, architectural
conflicts and deferred downstream work. Neither specialist commits changes.

The graph independently compares the specialist's claimed paths to the
actual unstaged Git diff, rejects out-of-domain or unsafe paths and
unauthorized Arc rewrites, validates the canonical Story against the
**previous verified work-item HEAD** with strict protection, records
outstanding/partial obligations, and makes a separately attributed Git
commit. The verified-head marker advances after each work unit. For
canonical structural diagnostics, the same Pi session gets at most two
bounded repair attempts before acceptance fails. Protected changes,
unresolved architectural conflicts, unexpected staging, mismatched references
and unresolved structural errors always fail closed. An Arc's `characters`
list may be authored in inline or block YAML without permitting edits to any
other Arc fields or prose. On interruption,
modified Story files and specialist transcripts remain intact for
inspection—an interrupted writer cannot be automatically restarted.
Completed stages are idempotent and commit provenance is rechecked.

The public output reports both work items, specialist names, commit
identities, actual paths, validator provenance, obligations, and remaining
Event/branch-dependent tasks. `foundations-committed` confirms these
**foundations only**; it does not certify a completed interactive route,
future knowledge transition, literary review or full Story. The generator
does not write engine Rooms or fabricate future Event/state references.

Receipts live at `~/.local/state/noveltea-gen/jobs/<sha256>/character-world.json`,
with private Pi transcripts under `character-world-sessions/{world,character}/`.
Shared `.story-job-running` and `revisions/verified-head.json` coordinate
the job with architecture and protected revision work. Source checkout
changes cannot alter an already pinned specialist snapshot. `--fixture`
creates a deterministic small Story (two Characters, one consequential
Relationship, a World Entity and an objective Fact) for certification, but
is **not** live Pi evidence. Certify fixtures with
`pnpm exec tsx --test test/character-world.test.ts`. To certify the **real**
Pi specialists with configured credentials, explicitly opt in:

```sh
NT_LIVE_FOUNDATIONS=1 NT_SKILLS_CHECKOUT=/path/to/noveltea-skills \\
  pnpm exec tsx --test test/character-world-live.test.ts
```

The live test inspects the actual pinned reads, editing tool calls, canonical
records, clean worktree and both specialist commits. It can incur model usage.
Use `NT_KEEP_FAILED_LIVE=1` during a live run to preserve a failed disposable
Story job and Pi transcripts for diagnosis; successful runs still clean up.

## Causal Event realization for one planned Milestone (#19)

After the architecture and Character/World foundations have been committed
within a Git Story job, authorize **one exact planned Milestone** per Event
work item:

```sh
pnpm dev job event run --story /path/to/story --job draft-1 \
  --milestone milestone.disclosure --skills-source /path/to/noveltea-skills
pnpm dev job event inspect --story /path/to/story --job draft-1 \
  --milestone milestone.disclosure
pnpm dev job validate --story /path/to/story --job draft-1
```

The LangGraph work item delegates canonical `events/*.md` to a **real, pinned
`nt-event-design` Pi specialist**, carrying the authorized architecture
contract, existing Creative Direction, selected Milestone/Arcs, linked Character,
Fact, World and Relationship records, and author-decision authority. It may
make connected scoped Arc/Fact/Revelation/Relationship edits and **only** bind
the selected Milestone's `fulfillment` (and `completeness`); other Milestones,
Characters, Creative Direction and engine data are not writable. The graph
verifies its declared changed files against actual Git changes and permits
only safe canonical Markdown in its owned directories, with strict protection
from the previous verified head. Protected retcons require the separate
author-signed revision workflow, never a specialist's claim.

The pinned canonical validator supplies localized diagnostics, Event and branch
reachability, Milestone route witnesses and incompleteness obligations. The
same Pi session can make **up to two bounded repairs** before the work item
fails closed. `after` is optional chronology (when both Events occur);
`prerequisites.any_of` contains true enabling conditions. At least one
authored Event and a deterministically reachable fulfillment route are
required. Unrelated composition/readiness gaps are not Event acceptance
requirements, and Editorial/branch-intent proof remains unverified. Any
unresolved future alternative is explicitly reported as a downstream
obligation, never filled with a fabricated Event ID.

Independent Milestones can have their own serialized receipts and commits at
**clean verified work-item boundaries**; failures never implicitly complete
dependent work. Interrupted writer edits remain in the job worktree and
must be inspected/reconciled manually before any other Story writer runs.
Durable status and provenance live under
`~/.local/state/noveltea-gen/jobs/<sha256>/event-items/<milestone-slug>.json`;
real Pi transcripts live under `event-sessions/event-<milestone-slug>/`.
The item reports its expected head, canonical validation SHA, changed paths,
Git commit and outstanding obligations.

`--fixture` selects a deterministic non-model author and does **not**
certify Pi authorship. Public CLI positive/negative integration tests:

```sh
pnpm exec tsx --test test/event-work.test.ts
```

Optional real specialist certification may consume model usage:

```sh
NT_LIVE_EVENT=1 NT_PROVIDER=nvidia NT_MODEL=nvidia/nemotron-3-ultra-550b-a55b \
  pnpm exec tsx --test test/event-live.test.ts
```

## Interactive Choice Point and Puzzle alternatives (#20)

Run this **after** the Event work item for the same planned Milestone has
committed. Both stages use the existing job's isolated Git Story worktree:

```sh
pnpm dev job interactive run --story /path/to/story --job draft-1 \
  --milestone milestone.disclosure --skills-source /path/to/noveltea-skills
pnpm dev job interactive inspect --story /path/to/story --job draft-1 \
  --milestone milestone.disclosure
pnpm dev job validate --story /path/to/story --job draft-1
```

The LangGraph workflow serializes two real pinned Pi specialists:
`nt-interactive-narrative` develops a consequential **Choice Point**, typed
Event branches, and a later conditional response; `nt-puzzle-design`
develops a **Puzzle**, two alternative solution Events, discoverable clues in
linked Authored Content, and observable typed state changes. Both receive
existing Milestone, Event, Character, Fact, Relationship and author-contract
context, and read their skill plus the canonical catalog. Each independently
produces an exact changed-file manifest, validates against the previous
**verified Git HEAD** with strict protection, and commits a single bounded
work item. Previously committed Event `prerequisites` are immutable in this
workflow: a new option cannot bypass an old gate merely by adding an enabling
route. All previously reachable Events must stay reachable; branches of
unmodified Events must remain reachable. Authorized interactive work may replace
steps within a changed Event when its original entry gate is preserved and its
new outcome branches are proven.

Acceptance checks that **every declared Choice Point outcome** is selected
by a reachable Event branch, has a distinct typed consequence, and has a
reachable later conditional consumer or an explicit per-outcome writing
obligation. Every newly authored Puzzle must have two genuine solution
Events, distinct consequences, canonical clue-content records and
`coverage.puzzleSolutions[*].solutions[*].clueAccess.status === reachable`
for every solution. Invalid/impossible/unverified routes, inaccessible clues,
staged/out-of-domain files, protected changes and contradictory branches
fail closed. Existing Milestones and other read-only source records are context,
not editable targets: `sourcePaths` and the architecture's Milestone targets do
not grant edit authority. The specialists get up to two localized repairs in
their original Pi sessions. An unstaged edit to a known read-only source can
receive a bounded repair diagnostic only when pinned Git protection confirms
no protected changes; the specialist must restore it exactly, without the graph
silently reverting or authorizing it. Staged changes, unsafe or unrelated paths,
and protected violations stop immediately. Failed stages preserve uncommitted source and transcripts;
**dependent Puzzle design cannot run after Choice failure**.

The progress receipt is at
`~/.local/state/noveltea-gen/jobs/<sha256>/interactive-items/<milestone-slug>.json`;
Pi transcripts are in
`interactive-sessions/interactive-<milestone-slug>/{choice,puzzle}/`.
The output includes pinned skills, each commit, validator digest, source
head, choice/solution witnesses and any remaining prose or presentation
obligations. Structural reachability never certifies a player's subjective
perception, the quality of a clue or finished engine implementation.

Deterministic tests (no LLM calls):

```sh
pnpm exec tsx --test test/interactive-work.test.ts
```

Opt-in **real Pi** certification (incurs provider usage):

```sh
NT_LIVE_INTERACTIVE=1 NT_PROVIDER=nvidia \
  NT_MODEL=nvidia/nemotron-3-ultra-550b-a55b \
  pnpm exec tsx --test test/interactive-live.test.ts

# Compare GPT-6 Luna using explicitly low or high Pi thinking effort:
NT_LIVE_INTERACTIVE=1 NT_PROVIDER=openai NT_MODEL=gpt-6-luna \
  NT_THINKING=low pnpm exec tsx --test test/interactive-live.test.ts
NT_LIVE_INTERACTIVE=1 NT_PROVIDER=openai NT_MODEL=gpt-6-luna \
  NT_THINKING=high pnpm exec tsx --test test/interactive-live.test.ts
```

Add `NT_KEEP_FAILED_LIVE=1` to preserve a failed disposable live Story and
its private transcripts. Neither fixture runs nor successful generation
automatically merges into the author's normal checkout.

## Branch-aware narrative composition (#21)

After an interactive Choice Point and Puzzle milestone has committed, compose
the associated Events into player-facing Story prose in the **same job worktree**:

```sh
pnpm dev job composition run --story /path/to/story --job draft-1 \
  --milestone milestone.disclosure --skills-source /path/to/noveltea-skills
pnpm dev job composition inspect --story /path/to/story --job draft-1 \
  --milestone milestone.disclosure
pnpm dev job validate --story /path/to/story --job draft-1
```

The architecture contract must authorize `depth: "composition"` and include
the same Milestone as a verified target. The interactive two-unit receipt must
be committed, with valid Choice/Puzzle route witnesses and the previous verified
HEAD. A pinned real Pi `nt-narrative-composition` specialist receives relevant
Event, Character, Relationship, Fact, Revelation, Choice, Puzzle, clue and
route-witness context. It edits **only** new or specifically linked existing
`authored-content/*.md`, using canonical `events` and `revelations`
references. Other Story records, including existing Puzzle clues, are read-only.
It writes one owned Authored Content record per consequential Event, including
the shared entry and choice menu, actual responses to *all* Choice outcomes,
distinct downstream outcome-conditioned aftermath, and standalone prose for
each alternative Puzzle solution Event. Previously authored Puzzle clues
remain linked to their own discovery Events without duplicate rewriting.
Shared text must remain valid on the least-informed route; optional clues and
branch-exclusive Revelations belong only to their conditional routes.

The graph checks exact Git scope/manifest, pinned validator protection against
the last verified interactive commit, Event/branch/solution coverage, mandatory
Authored Content-to-Event/Revelation links and independently read saved text.
It checks section presence, distinct responses and known branch-exclusive
lexical leaks, but cannot derive full prose-to-step semantics from the current
schema. For **real Pi work**, a separate **read-only Pi editorial reviewer**
must read the saved content, witnesses and pinned guidance and return a
source-linked verdict covering each route. A blocked review returns actionable
diagnostics to the **same** writer Pi session, with at most two repair turns;
exhaustion prevents commit and preserves the failed draft and transcripts.
The passing verdict is bound to the exact reviewed file digest and independently
rechecked at commit time. This review is editorial judgement, not a claim of
mechanically proven playability or engine output. A successful work item makes exactly one
provenance-attributed commit and advances the verified-head marker. The
author's original checkout is never touched.

The receipt lives in the job state directory at
`composition-items/<milestone-slug>.json`, with Pi transcripts in
`composition-sessions/composition-<milestone-slug>/{write,review}/`. Failed or interrupted work
preserves edited files and receipts; an interrupted `writing` phase is **not**
automatically restarted. Real runs may consume model usage. Test the public
workflow without a model with:

```sh
pnpm exec tsx --test test/composition-work.test.ts
```

The `--fixture` variant exercises the same Git/validator and structural gates
but cannot certify semantic editorial meaning. For opt-in **real Pi**
certification (including the separate reviewer), use
`NT_LIVE_COMPOSITION=1 NT_SKILLS_CHECKOUT=/path/to/noveltea-skills pnpm exec tsx --test test/composition-work.test.ts`.
Provider/model/thinking overrides use `NT_PROVIDER`, `NT_MODEL`, and
`NT_THINKING=low|high`; `NT_KEEP_FAILED_LIVE=1` retains test state for
diagnosis. Neither mode merges into the author's branch.

## Independent requested-scope narrative review (#26)

After the planned Story scope has been realized, evaluate the **actual saved
canonical Story** against its versioned author contract, rather than assuming
an apparently complete work-item DAG proves the requested narrative is done:

```sh
pnpm dev job review run --story /path/to/story --job draft-1 \
  --skills-source /path/to/noveltea-skills
pnpm dev job review inspect --story /path/to/story --job draft-1
```

The review uses the pinned canonical validator and representative Event,
Milestone-alternative, Choice branch, and Puzzle clue/solution witnesses. The
result separates **scoped deterministic obligations** from **global catalog
readiness**; an unrelated incomplete Arc does not invalidate a bounded request.
Truncation, unreachable or uncertain routes, protection failures and binding
unplaced deferred ideas are explicit scoped findings. An independent, read-only
`nt-narrative-review` Pi session examines actual prose and source-linked route
evidence for continuity, pacing, voice, Puzzle fairness, agency, payoff and
conditional knowledge. A green canonical validator alone is **not** an
editorial pass. Representative witnesses are not an exhaustive route proof.

Composition-only blocking findings can receive at most two edits **within the
original Composition writer's persisted Pi session**, limited to that writer's
previously committed Authored Content. Each attempt undergoes canonical
revalidation and independent re-review; oscillation, unresolved problems,
missing provenance, or findings needing Event, architecture or protected
decisions stop and require explicit reconciliation. Interrupted sessions and
uncommitted drafts are preserved; neither the review nor repair merges into the
author's branch. New authorized plans or later verified commits invalidate an
old completion verdict; prior review receipts are archived outside Story canon.

`--fixture` runs only structural/route checks and explicitly returns
`editorial-unverified`, **never** `complete-in-scope`, even if the deterministic
audit passes. Real Pi editorial certification is opt-in, incurs model usage and
requires configured credentials. The review receipt and Pi transcripts live in
the job state directory (`narrative-review.json`, `review-sessions/`). Test with
`pnpm exec tsx --test test/narrative-review.test.ts`. To certify the real,
separate read-only Pi reviewer against the actual branch-aware Story fixture:

```sh
NT_LIVE_NARRATIVE_REVIEW=1 NT_PROVIDER=openai NT_MODEL=gpt-6-luna \\
  NT_THINKING=low pnpm exec tsx --test test/narrative-review-live.test.ts
```

This fixture intentionally contains continuity/knowledge/Puzzle issues. A
source-linked **blocking** editorial verdict is the expected successful gate,
not a failure to certify the generated Story. The test checks the independent
read-only transcript, protected author checkout, and absence of automatic
canon edits; actual literary completion remains deliberately blocked.

## Non-destructive Story merge preview (#29)

A completed generation branch is not automatically merged into the author's
branch. Compare its original generation base against the **current committed
author HEAD** with:

```sh
pnpm dev job merge preview --story /path/to/story --job draft-1 \\
  --skills-source /path/to/noveltea-skills
```

The preview requires a clean, committed generation job branch; it does not
discard an in-progress writer's edits. A current, completed scoped-review
receipt is separately indicated; a commit alone is not proof of requested-scope
completion. Uncommitted target Story changes are
reported but deliberately **not included**: commit them first if they should be
part of the comparison. The result pins both revision SHAs, reports the target's
drift since the generation base, and lists impacted paths and record IDs.

Git constructs a candidate via `merge --no-commit --no-ff` in a detached,
disposable worktree, not in the author's checkout. Textual Git conflicts return
record IDs and evidence, with validation marked `not-run`. Once constructible,
the existing pinned canonical validator assesses the candidate against **both**
target and generation baselines for typed dependencies, progression and protected
decisions. The read-only independent narrative reviewer considers motivations,
Revelation conditions and ending assumptions even when Git merges the text
without conflict. Overlapping edits to the same record are flagged as semantic
risks regardless of Git's textual verdict. Findings include uncertainty and
bounded reconciliation options; neither branch is automatically changed.

`--fixture` exercises the Git merge and validator without a model, returning
`narrative.status: unverified` rather than a literary attestation. A live Pi
review requires the pinned `nt-narrative-review` and `nt-catalog` skills and
configured credentials. Each invocation recomputes against the current target
HEAD, so a later target commit invalidates the previous preview. The output
is advisory; any subsequent generation-branch edit requires a separate,
**explicit author-approved reconciliation task**. Test the public CLI with
`pnpm exec tsx --test test/merge-preview.test.ts`. Set
`NT_LIVE_MERGE_PREVIEW=1` with a configured Pi provider/model and the NovelTea
skills checkout to exercise the opt-in qualitative contradiction test.

## Read-only Story job completion and integration report (#30)

Generate an **author-facing** report from the persisted Git-backed job state after
any process restart. No graph worker or model is needed for ordinary inspection:

```sh
pnpm dev job report --story /path/to/story --job draft-1
pnpm dev job report --story /path/to/story --job draft-1 --format markdown
pnpm dev job report --story /path/to/story --job draft-1 --format markdown \\
  --output /outside-the-repo/story-report.md
```

The default output is versioned JSON (`noveltea-job-report/v1`). The alternative
Markdown view includes source-linked diagnostic findings, current scope and
contract version, path-derived stable Story ID (shared across jobs on that Story),
verified Git HEAD/base/branch/worktree/thread identity,
historical work items and committed Git revisions, structural/readiness and
bounded progression witnesses, protected-decision status, independent editorial
evidence, and IDs/statuses of captured deferred author ideas. Author ideas'
original wording, full inbox, and private message payloads **never** enter the
report. Export is exclusive (no overwrites), and destinations under either the
author checkout or generation worktree are rejected.

Scope fulfillment is derived from the current reviewed Git revision and remains
separate from execution control: pausing a verified, completed job does not
invalidate its committed scope evidence. Generation
`completed|paused|blocked|failed` is **independent** from integration
`mergeable|conflicts|not assessed`. Only a current, matching versioned plan
and scope audit with a successful **real Pi** independent editorial verdict
can yield `completed`; deterministic fixtures remain unverified. A
historical architecture scheduling placeholder is not a current blocker once
a downstream specialist has fulfilled it. Paused execution control and
unresolved binding ideas in the **requested scope** remain explicit. A full
Story contract treats all binding ideas as in scope; out-of-scope unfinished
Arcs and deferred ideas do not block a bounded Arc's verdict.

Integration is `not assessed` until requested:

```sh
pnpm dev job report --story /path/to/story --job draft-1 --preview \\
  --skills-source /path/to/noveltea-skills
pnpm dev job report --story /path/to/story --job draft-1 --preview --fixture
```

`--preview` delegates to the disposable merge-preview command (#29) and
includes the exact target revision, canonical validation and source-linked
narrative-conflict options. A textual collision or a deterministic/protected
decision/semantic conflict is `conflicts`. `mergeable` requires the merge
preview’s own compatible-for-author-review verdict, including successful
combined-Story validation **and** independent narrative review; a fixture's
positive textual merge remains `not assessed` for literary compatibility.
A completed Story branch may therefore still have merge conflicts.
No command automatically integrates or alters protected decisions.

The tests use the public CLI against disposable Git repositories:
`pnpm exec tsx --test test/job-report.test.ts`. Positive completed status is
also exercised with a **simulated** prior Pi completion receipt; this is
projection-only coverage and does not claim that a fixture review is literary
certification.

## Protected-decision revision and author approval (#16)

The job never treats a model request, a validator acknowledgement, a Git commit
or a record's `approved` status as an author's permission. For a bounded
revision, edit one tracked canonical Story Markdown file in the **job worktree**
(the normal author checkout is untouched), and inspect it from the public CLI:

```sh
pnpm dev job revision inspect --story /path/to/story --job draft-1 \
  --work-item fix-culprit --path creative-direction/foundation.md
```

The output contains a `proposalSha256`, individually hashed
`protectedChanges[].id` values, exact original and latest comparison
baselines, before/after decision content, affected records, unrelated
uncommitted paths and pending authorization/review status. The first call pins
the validator if not already pinned. The work item is stable: changed proposed
bytes or a changed verified HEAD **cannot inherit earlier approvals**. Start a
different work-item ID to propose another candidate.

The **author** must approve or reject **each** protected delta, including
newly protected or promoted decisions, using a separately signed Ed25519
approval. Before the job starts, the author must have committed the public key
`.noveltea/approval-author.pub` in the **original trusted Git baseline**.
The private signing key must reside on an independent signing device/service
inaccessible to Pi and its shell tools. `inspect` returns exact unsigned
`authorSigningRequests` templates; the author reviews the actual patch,
specifies a rationale, then signs the chosen decision on the separate device.

```sh
pnpm dev job revision authorize --story /path/to/story --job draft-1 \
  --work-item fix-culprit --proposal <proposalSha256> \
  --signed-evidence /path/to/author-signed-decision.json
```

**Setup and complete offline signing instructions:**
[Author signing and revision approval](docs/author-signing.md).

A rejection remains durable and blocks the work item. Each signature binds
the original job baseline, unique job thread, last verified head, work-item and proposal hashes,
stable protected-decision ID, exact change digest and author rationale.
Unsanctioned flags, model assertions, other keys, changed proposed bytes and
tampered job-state receipts are rejected. Saved signatures are reverified
against the **original Git public-key blob** whenever approvals are read;
an agent changing the working-tree copy of the key cannot authorize a revision.
The key is not loaded from the mutable job manifest or moving HEAD.

This is a cryptographic author-consent boundary, not an operating-system
sandbox. Protect the private key from any environment the agent can execute
commands in. A malicious agent with permission to replace the generator's
executable itself remains outside this application's trust model.

A separate editorial review is **always required**, even for changes that do
not alter any protected decision metadata. Compare the source-linked prose
and its narrative consequences (including indirect contradictions) before
recording the verdict; metadata equality is not semantic proof:

```sh
pnpm dev job revision review --story /path/to/story --job draft-1 \
  --work-item fix-culprit --proposal <proposalSha256> \
  --signed-evidence /path/to/author-signed-editorial.json
pnpm dev job revision commit --story /path/to/story --job draft-1 \
  --work-item fix-culprit --proposal <proposalSha256>
```

`--verdict block` saves a separate blocking semantic-review finding; a
positive review is a **reviewer attestation**, not machine proof of coherence.
The graph-side commit gate re-runs the *pinned canonical validator* in a
disposable candidate worktree, first against the immutable original base,
then against the most recently verified commit. It checks every exact
protected delta and adoption against a durable author approval, independent
review, structured diagnostics, staged files, current job HEAD and candidate
bytes. The validated single-file work item is committed as
`NovelTea Generator`, with job, work-item, proposal, approval, signer authority,
actual graph committer identity and editorial trailers. Unrelated **unstaged** files remain in the job worktree unchanged;
unexpected staged/conflicted edits block. The original author branch is not
advanced or merged. A verified-head receipt persists across subsequent
revisions, and an interrupted commit can be reconciled from its exact Git
trailers rather than duplicated.

Approval/review receipts live outside Story canon under
`~/.local/state/noveltea-gen/jobs/<sha256>/revisions/<work-item>.json`,
with `revisions/verified-head.json` tracking the latest verified SHA.
`NT_STATE_DIR` and `XDG_STATE_HOME` change the base location. The unmodified
canonical validator report still comes from the pinned adapter, preserving
the future native `Cruel/nt#535` migration seam.

Run `pnpm exec tsx --test test/revision.test.ts` for disposable Git Story
fixtures exercising approved/rejected/missing/modified/later-protected changes,
authority adoption, separate prose review, invalid YAML, unexpected staging
and unchanged author checkout.

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

The directory must be **empty**, even if it already exists. The tool cannot overwrite canon or create additional records, an engine project, or an entire Story. The response reports the skill digest and Git provenance, exact read paths, Pi transcript file, created artifact, and `catalogValidation: "unverified"`. The demo performs constrained input checks and reads the written file back, but does **not** claim native catalog validation, foundation readiness, creative quality, author approval or NovelTea engine playability. The installed native NovelTea CLI exposes `noveltea narrative validate` and `noveltea narrative readiness`; use them separately for canonical diagnostics and design versus approved foundation minimums. The demonstration itself does not claim these checks were performed.

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

Set `NT_PROVIDER` and `NT_MODEL` if needed. The real-model test may incur usage; it uses a disposable Story root and isolated local state/cache paths. Canonical Story validation is provided by the native `noveltea` CLI; the normal `run` command remains a graph-routing proof of concept with **no Story write permissions**.

## Certification of the integration proof (#11)

See **[docs/certification.md](docs/certification.md)** for the acceptance matrix, reproducible CLI examples, cross-process/snapshot checks, evidence boundaries and the optional real-Pi/Studio/LangSmith live-smoke checklist. Run `pnpm certify` for the dedicated offline end-to-end matrix; `pnpm check` runs every deterministic test, typecheck and build. Fixture success **does not** demonstrate real Pi skill use or hosted traces; the checklist separates those checks explicitly.

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

Open the Studio URL printed by the server (typically `https://smith.langchain.com/studio?baseUrl=http://localhost:2024`). The server exposes the production **`story_generation`** graph from `src/studio.ts`, not the old note/tagline prototype. You can inspect scheduling, author intake, specialist dispatch, verification and completion nodes locally **without a LangSmith API key**. Studio's browser UI is hosted on LangSmith, but graph execution and checkpoint data are local; opening the UI does not opt in to hosted trace uploads.

Prepare an existing Git-backed job and generate input for a fresh Studio thread:

```sh
pnpm dev job start --story /path/to/story --job studio-draft
pnpm studio:input --story /path/to/story --job studio-draft \
  --task "Develop the selected Story scope" --contract ./scope.json \
  --skills-source /path/to/noveltea-skills --fixture
```

The helper validates the full-Story or partial Arc/Milestone contract and existing job identity, and emits the production `request` object. It does not create a job, invoke a model or edit Story files. Omit `--fixture` to opt into real Pi; optional `--provider` and `--model` override defaults. Specialists pin their own skills and transcripts through the same work-item APIs used by CLI generation.

**Studio limits:** Use only one execution surface/thread per job. Studio owns its development-server checkpoints, separate from CLI `generation.sqlite`; use `job generate` for tested durable CLI restart/reconciliation. The generator now also binds a server-run job to its original thread/request and refuses CLI takeover. Never start a fresh thread to overwrite interrupted specialist work. See the production generation section for safe-boundary controls, resume and preserved crash evidence. Legacy `run`/`demo-story` CLI commands remain available, but are not Studio's registered graph.

**Skein compatibility:** The single-process self-hosted Agent Protocol qualification, regression fixture, restart/interrupt tests, live Pi smoke, version pins and deployment limitations are documented in [Skein qualification](docs/skein-qualification.md). The test-only localhost host is not a production endpoint; no fallback HTTP server was introduced.

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

The graph and Pi metadata include stable run/thread/project identifiers and the skill snapshot digest, Git commit, branch and dirty status. **Skill contents, source paths and credentials are not placed in provenance metadata.** Explicit hosted tracing can still send **prompt text, model responses and tool read results**, including loaded skill references, because those are part of Pi model execution; do not enable it with confidential Story data, secrets or skill content you do not intend to upload. The direct-model span never receives Pi credentials or raw provider objects; provider SDK error text is redacted. Any returned non-success stop reason (`error`, `aborted`, `length`, or unexpected) also marks the LLM span as failed while retaining sanitized response/usage metadata. No tracing extension is loaded when tracing is off.

For a Studio-server hosted trace (as distinct from the CLI), use this explicit launch and paste a generated input:

```sh
pnpm studio:trace
```

### Manual LangSmith end-to-end inspection (requires key and Pi login)

1. Create or select a disposable Story root and set `LANGSMITH_API_KEY` and, optionally, `LANGSMITH_PROJECT`. Use a new `--thread` for each case. Leave tracing off for an initial fixture run; confirm no LangSmith runs appear for it and the local SQLite checkpoint and Pi JSONL files remain available.
2. Run `pnpm dev run --project <root> --trace --task "Invent a compact locked-room mystery premise"`. Confirm a single graph trace with `pi_coordinator → story_note_worker → pi_continuation`; under the correct graph nodes, expand the Pi agent/turn/provider/tool runs. Verify model usage and a `delegate_to_worker` tool span. If Pi emits a compaction or error, check its status/span rather than expecting one every run.
3. Run `pnpm dev run --project <root> --trace --task "Write a promotional tagline for a gothic mystery"`. Confirm `pi_coordinator → direct_tagline_worker → pi_continuation` and a model span labeled `pi-ai direct model request` under the direct worker node, with request brief, returned JSON text, stop status and token usage. There must be **no** independent Pi worker session in this branch.
4. Confirm the graph and child trace correlation identifiers and snapshot Git revision/digest match CLI output. Check that no API key, authorization header, raw provider SDK object or **skill contents in metadata** appear in the runs. Trace payloads may contain user/task/skill **content**, as noted above; review before transmitting. Repeat a run without `--trace` to verify opt-out even with inherited LangSmith environment variables.

[Showing lines 1-640 of 668 (50.0KB limit). Use offset=641 to continue.]