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
Git-backed job. Later Story-orchestration tickets will consume this durable
job worktree and thread identity. Do not treat `job start` as a completed
narrative-generation run.

## Pinned standalone Story validation (#14)

After creating a Git-backed job, validate the **Story in that job's
worktree** with the existing canonical experimental TypeScript validator:

```sh
pnpm dev job start --story /path/to/git-repo/story --job draft-1
pnpm dev job validate --story /path/to/git-repo/story --job draft-1
# If .local/config.json does not name novelteaSkills on the first validation:
pnpm dev job validate --story /path/to/git-repo/story --job draft-1 \\
  --validator-source /path/to/noveltea-skills
```

The first validation compiles `noveltea-skills/src/cli.ts` into a single
Node.js executable with esbuild, including its runtime dependencies. It
fingerprints the source files and lockfile, checks for changes during the
build, and records the checkout revision/dirty state. This pin is **separate**
from the immutable skills-only snapshot. The first validation stores
`validator.json` alongside the job's `job.json`, and a hashed read-only
executable under `~/.cache/noveltea-gen/validator-artifacts/<sha256>/`.
`NT_VALIDATOR_CACHE_DIR` can override this cache; `XDG_CACHE_HOME` changes
the default base. Repeated validation checks the exact pinned artifact and
never rebuilds or automatically replaces it, even if the source checkout
changes or is removed. Missing, changed or unexpected cache contents fail
closed. This is an executable pin, **not** a second narrative schema.

The public JSON result includes `contract: "noveltea-validator/v1"`,
`validator` provenance and SHA-256, job/base/worktree identity, and the
**unmodified canonical report**: source-located diagnostics; design versus
approved readiness and stage minima; coverage and explicitly unverified
conditions; protected decisions, change warnings, and downstream Git impact.
The adapter passes the job's immutable `baseSha` as `--base`, not the
worktree's mutable HEAD. The exit status is `0` for no structural or
protected-decision errors, `1` for a rejected canonical validation, and
`2` for missing/unverified Git baseline, missing pins, or execution errors.
A structural pass does **not** mean narrative completeness, editorial
approval or author authorization. No acknowledgement flags are offered.

**Empty Git baselines:** the experimental validator cannot produce a
verified Git-protection report when the baseline contains no Story Markdown.
In this case the adapter preserves the structural/readiness findings but
returns `status: "unverified"` with exit code `2`; it never reports that
protected changes were checked. This limitation must be resolved by the
native Git-impact contract before completion gates can depend on it.

**Temporary Pi-side CLI bridge:** Writing specialists receive `noveltea narrative
validate . --json` through a job-local `agent-validator-bin/noveltea`
command that points to `src/noveltea-cli-shim.mjs`. The shim delegates
to the existing public `job validate` adapter and honors the job's
trusted Git `--base` and strict protection checks. It is not a separate
schema or validator. Pi can inspect diagnostics and repair its draft;
the graph independently revalidates before accepting a commit. The
bridge is only available to these agent Bash sessions, not globally.
**When native narrative validation is certified, delete the shim and
`agentValidatorBashTool` session wiring**, allowing the actual NovelTea
CLI on `PATH` to be used without changing skill instructions.

The native replacement is owned by [Cruel/nt#526](https://github.com/Cruel/nt/issues/526)
and [Cruel/nt#535](https://github.com/Cruel/nt/issues/535). The validator's
single stable adapter isolates future CLI replacement from graph/agent
consumers. See [docs/validator-cutover.md](docs/validator-cutover.md)
for the structural, readiness, protection and impact parity matrix and
opt-in native parity test. No native behavior is assumed available yet.

## Git-backed Creative Direction generation (#15)

Once a Story job has been started, run a pinned Creative Direction work item:

```sh
pnpm dev job start --story /path/to/git-repo/story --job draft-1
pnpm dev job foundation --story /path/to/git-repo/story --job draft-1 \
  --mode autonomous \
  --task "A mystery aboard a stranded midnight train; invent unspecified details" \
  --envelope "Dialogue-led visual novel, compact cast, reusable locations"
```

Configure `.local/config.json` to point to the `noveltea-skills` checkout first, or specify `--skills-source /path/to/noveltea-skills` and `--validator-source /path/to/noveltea-skills` for a new job. A new foundation item pins the exact skills snapshot; its first validation separately pins the canonical catalog executable. Ordinary execution requires Pi credentials. Set `--provider` and `--model` to override the default. Only `--fixture` uses a deterministic non-model specialist; fixture outcomes are **not** Pi evidence.

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
Shared `.story-writing` and `revisions/verified-head.json` coordinate
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
It writes the shared entry, visible menu, actual responses to *all* Choice
outcomes, and actual prose for every alternative Puzzle solution Event. Shared
text must remain valid on the least-informed route; optional clues and
branch-exclusive Revelations belong only to their conditional routes.

The graph checks exact Git scope/manifest, pinned validator protection against
the last verified interactive commit, Event/branch/solution coverage, mandatory
Authored Content-to-Event/Revelation links and independently read saved text.
It checks section presence, distinct responses and known branch-exclusive
lexical leaks, but cannot derive full prose-to-step semantics from the current
schema. For **real Pi work**, a separate **read-only Pi editorial reviewer**
must read the saved content, witnesses and pinned guidance and return a
source-linked verdict covering each route; a blocked review prevents commit.
This review is editorial judgement, not a claim of mechanically proven
playability or engine output. A successful work item makes exactly one
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

Open the Studio URL printed by the server (typically `https://smith.langchain.com/studio?baseUrl=http://localhost:2024`). The local server exposes the graph named `noveltea`; its actual nodes are `pi_coordinator`, `story_note_worker`, `direct_tagline_worker` and `pi_continuation`. You can inspect node transitions, checkpoints and state locally **without a LangSmith API key**. Studio's browser UI is hosted on LangSmith, but the graph execution and checkpoint data are local; do not confuse opening that UI with opting in to hosted trace uploads.

Select an existing Story root. Generate the *full* State JSON to paste into Studio's input panel:

```sh
pnpm studio:input --project ./scratch-story --task "Invent a mystery premise"
```

The helper emits canonical `projectRoot`/`projectId`, model choice and empty initial graph fields. It emits a null skill snapshot: at each **actual Studio graph invocation**, the server captures the current skill checkout, pins it for Pi, and writes that same snapshot into graph state and trace provenance. A server restart is not necessary after skill source changes. The helper does not invoke a model, create a Story or capture a skill snapshot. Optional `--provider` and `--model` override the defaults. The Story directory itself must exist. Pi's login still supplies model credentials; **LangSmith credentials are not required for local Studio**. For CLI-generated checkpoints and project-scoped Pi JSONL histories, use `pnpm dev run --project ... --thread ... --pause-after ...` and `--resume` as documented above. The Studio server uses its own local development graph state, not the CLI's SQLite thread database, while Pi histories remain project-scoped.

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
