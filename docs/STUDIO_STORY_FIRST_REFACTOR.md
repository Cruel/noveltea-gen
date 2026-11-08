# Studio Story-First Refactor — Design Draft

Status: **Approved design — implementation tracked by [specification #102](https://github.com/Cruel/noveltea-gen/issues/102) and its 22 child tickets (#103–#124)**

Scope: NovelTea Studio in `~/dev/noveltea-gen`

Source: author design interview, Q1–Q34 (2026-11-08)

## Goal

Replace Job- and Conversation-centric authoring UX with a Story-first, chat-first workspace. An author can ask for a whole Story or any focused revision in the same Thread, inspect the canonical Story through Outline/Graph, steer running work, request corrections, and explicitly publish verified partial or completed progress. Preserve native authoring validation, trusted approvals, Git provenance, crash safety, and independent Thread ancestry while hiding routine execution configuration.

## Canonical model and navigation

- **Story:** Canonical Story root in an imported repository, with typed records and its own Story selector. One selected Story's Threads appear in navigation.
- **Thread:** Stable conversation and independent Git-backed revision lineage. An internal Job, run, Pi session, or execution is never synonymous with a Thread. A fork descends from an exact verified checkpoint; source and child remain independent. The Thread supports many requests and does not terminate after one generation.
- **Turn:** One author's request plus the work needed to fulfill it. Turn scope is determined *for that request*, not fixed across the Thread. Whole-Story generation, focused editing, and multi-record revisions can freely alternate.
- **Collection:** Optional organizational grouping of Threads; movable membership and tree/flat navigation. A Collection is not an ancestry parent and is never required to create a Thread.
- **Internal execution:** A Turn can schedule many bounded specialist assignments, reviews, checkpoints, and/or Jobs. Preserve checkpoint and failure provenance; keep execution details in an advanced interface, not primary navigation.
- **Creating a Thread:** A new Story may open with an empty workspace and no Threads. First submitted chat instruction creates a Thread without a separate Job setup wizard.
- **Concurrency:** One active writer per Thread; additional author turns can queue, and a distinct explicit *Steer current work* action is delivered at safe boundaries. Maintain author intent and prevent stale/replayed authorization.

## Creative operation and scope

- Initially expose **Autonomous** and **Collaborative** creative modes; model them as extensible policy configurations. Thread default with per-Turn override. Possible future hybrid modes (e.g., collaborative through Milestones and autonomous afterward) must fit without redesigning the graph.
- Autonomous decides reasonable creative details and requests input on protected/major ambiguity; Collaborative seeks user direction for consequential creative decisions while automating routine implementation and validation.
- A controller-derived **specialist assignment** states a specific, bounded outcome. The original user brief provides plan-level intent; specialist semantic review checks the *specific assignment*, not whether a generic high-level brief has been fulfilled.
- Pi may discover necessary files with reads, grep, and canonical graph inspection. Do not require an exhaustive up-front editable file list for ordinary creative revisions. Keep deterministic constraints on sandbox/root boundaries, authorized record categories, protected canon, native schema, Git integrity, and privileged operations; never let Pi self-authorize a protected change.
- Planning still chooses an efficient set of specialists and tracks plan-level completion, without requiring a permanent Thread scope or unnecessary full-Story generation on minor edits.
- A separate plan-level completeness/fulfillment review remains necessary: passing every specialist assignment does not prove the planner decomposed the original request adequately.

## Validation, semantic review, and checkpoints

- Mandatory deterministic verification after each specialist's changes: canonical structure, typed references, native validator, protection/approval validity, Git provenance, and the relevant execution invariants.
- **Validated checkpoint:** Durable, recoverable revision passing deterministic gates, not falsely labeled as independently reviewed.
- **Reviewed checkpoint:** A validated revision whose applicable bounded changes passed independent semantic review.
- Semantic review is **adaptive**: controller-owned and evidence-based, not a self-exemption chosen by the writer. Small routine assignments may skip review; consequential architecture, protected-adjacent work, multi-record dependency changes, key narrative boundaries, and other risk signals require review. Related small assignments may be batched at bounded Milestone/narrative checkpoints; preserve assignment-to-diff provenance.
- A reviewer receives the assigned goal(s), pinned Story context, original baseline, and actual proposed Git diff. It checks fulfillment and unrelated creative changes, reports source-linked actionable findings, and runs read-only.
- A blocked reviewer finding goes to the *same specialist session* for a corrected draft, or the specialist may record a disagreement and ask the author. **No agent-to-agent persuasion or rebuttal loop**: a model argument alone never changes a rejection into acceptance. A user-directed revision of the assignment is then independently reviewed.
- Limit automatic correction attempts; preserve drafts/transcripts/checkpoint evidence on failure. The controller should batch related author disputes and continue independent assignments when safe.
- Downstream work may use the latest validated checkpoint unless a required semantic review is pending/failed for its dependency. Before publication, complete any required semantic review of previously uncovered changes. Passing structural validation is not editorial certification.

## Author questions, corrections, and chat

- Reuse/generalize the existing durable author-interrupt path into a unified **Author Choice** mechanism across specialists and reviewer disagreements.
- Permitted UX: plain free-text question, Yes/No/Other, or multiple-choice/Other. *Other* always reveals custom input; optional additional text may accompany a chosen option. Present options only when useful, not as a forced format.
- Agent proposes question/options; trusted controller validates/persists exact waiting work and authenticated answer. Responses resume the relevant work without granting broad or implicit protected-canon approval.
- A reviewer disagreement is an inline chat decision, not a blocking modal or a Job error page. Corrections to already accepted work are new Turns in the same Thread, optionally carrying selected file/line context from Review.
- Separate permanent conversation, compact live activity, and expandable durable execution history. Pi may emit short `report_status` progress; controller events are authoritative for checkpoints, validation, changed paths, and lifecycle.
- New Turns build from the latest validated Thread checkpoint; they may not bypass unresolved mandatory review failures/dependency gates.

## Author Review and publication

- **Automatic specialist review**, **Review Changes**, and **Publish** are independent concepts.
- Review Changes is inspect-only: no mandatory Accept action or side effects. It shows source diffs, record relationships, and evidence; author may request a new revision through Chat.
- Review invoked from a Turn's completion defaults to that Turn's diff; the persistent Review panel defaults to cumulative unpublished Thread changes. Both can switch scope.
- Publish is a separate explicit operation to create or update GitHub PR/GitLab MR for an exact verified revision. Allow publishing **verified partial progress**, not only complete Stories.
- Later Thread revisions do not silently modify the published PR/MR. Where a PR/MR already exists, offer to update it (default) or create a separate one, with explicit confirmation and remote/ref identity verification.
- Publication checks outstanding required semantic review and deterministic protections; routine Review Changes inspection is not an approval prerequisite.

## Story workspace: desktop

Two full-width, vertically stacked workspaces sharing aligned left sidebars:

| Region | Left sidebar (collapsible) | Main panel |
|---|---|---|
| Upper Story workspace | Canonical Outline | Large Story relationship Graph |
| Lower conversation workspace | Thread tree / Collections | Chat, inline choices, and activity |

- Upper Story workspace collapses entirely and is vertically resizable against Chat. Outline and Thread sidebars independently collapse. Remember expanded state, height, sidebar visibility, and layout preferences.
- Graph uses native Context Manifest relationships, not invented client edges; record selection synchronized with Outline and inspector. Selecting a record shows a compact inspector; full diffs are in Review.
- Graph preserves the user's viewport while generation updates highlights. Optional *Follow activity* may refocus; default is no auto-pan. Initially focus a relevant subgraph.
- Graph shows the selected Thread's **validated** Story revision. Live unverified edits appear as distinct activity overlays, not as canonical graph facts. Highlight current Pi work, current Thread's accumulated changes, and records referenced by hovered historical activity. Preserve record selection while showing transient highlights.
- Switching Threads loads that Thread's own Story state, not a synthetic merge of independent lineages. Remember graph viewport, filters, and selected record per Thread; panel sizing and expansion are broader workspace preferences.

## Story workspace: mobile

- Use a mutually exclusive Chat / Outline / Graph view selector. Do **not** stack a small Graph over Chat.
- Thread navigation opens as a Sheet from the header, in any workspace view.
- Outline and Graph occupy the available workspace independently. Selecting a record does not force a view switch; *View in Graph* intentionally navigates and focuses it. Live activity never hijacks the current view.
- Persist the mobile workspace choice separately from desktop panel sizing/visibility and respect reduced-motion needs.

## Recovery, security, and privacy

- Safe, provably idempotent transient retries may run automatically with limits. A recoverable uncertain writer interruption preserves the draft, checkpoint, and Pi session; offer Continue / Review recovery in Chat. Unsafe or ambiguous states remain blocked, with advanced reconciliation details.
- Never silently discard a dirty worktree, blindly repeat an interrupted writer, treat a Pi claim as a verified checkpoint, or infer protected-author consent from a choice.
- Maintain repository/owner isolation, writer leases, exact revision identity, durable controller approvals, and source-linked audit receipts.
- Advanced execution details remain accessible for session inspection, checkpoint recovery, review evidence, model usage, and administrative controls, but Jobs are not a top-level everyday user concept.

## Migration and non-goals

- The existing **local development Studio SQLite database is disposable**. Build the desired schema afresh and explicitly purge/reinitialize the known isolated dev database at implementation time; no legacy schema/data compatibility, conversion, or backward adapters are required.
- A database reset is *not* permission to discard Git worktrees, committed Story revisions, private transcripts, running service volumes, or unrelated local files. Confirm the exact DB path and service state before any destructive operation.
- Existing code hotspots include `web/src/persistence/conversation-sqlite.ts` (mandatory Conversation parent), `web/src/lib/thread-chat.server.ts` (per-follow-up pinned scope), `web/src/routes/_protected/jobs/-StoryExplorer.tsx` (Job-scoped explorer), and `src/generation.ts` / `src/narrative-review.ts` (generation and final editorial review). Rework rather than blindly remove existing provenance and verification.
- Explicitly defer **cross-Thread integration/merge UX**, additional creative-mode presets, and optional desktop split/comparison modes. Keep fork ancestry correct and future integration possible.

## Dependency-ordered implementation workstreams

1. **Model and controller contracts:** Story–Thread–Turn–Execution identities; optional Collections; revision lineage; per-Turn intent; modes as policy; validated/reviewed state and typed activity events.
2. **Persistence clean cutover:** New Drizzle schema and repository adapters; clean isolated dev DB reset; owner isolation and durable lifecycle invariants; no legacy Conversation parent.
3. **Unified Turn orchestration:** Chat-first Story/Thread creation; natural-language planning for arbitrary scope; queued follow-ups and explicit steering; incremental verified revision advancement; sessions and recovery.
4. **Review orchestration:** Shared assignment-to-diff receipts, deterministic gate, adaptive semantic-review policy and bounded group reviews, same-session repairs, disagreement interrupts, independent plan-level fulfillment check.
5. **Author interaction and activity:** Unified choice types (binary, multi-choice, free-text + Other), durable resume; report_status and controller events; concise chat activity, historical file associations.
6. **Desktop/mobile workspace:** Aligned Outline/Graph and Threads/Chat rows; full-screen mobile views and Sheet; native-backed Story graph, per-Thread selection/viewport and transient activity overlays.
7. **Review and Publish:** Turn/cumulative diff inspectors, author corrections as Turns, explicit verified partial publication, optional update existing PR/MR.
8. **Reliability, removal, and certification:** Failure/restart/approval replay and isolation checks; remove superseded primary Job UX; format/lint/type/test and real-Pi end-to-end acceptance.

These are dependency-ordered workstreams; common foundations may be delivered in smaller vertical slices and should not require a duplicate legacy frontend.

## Acceptance criteria

- Open a newly registered Story without a Job wizard, send a natural request, generate canonical content, and retain one stable Thread.
- Alternate full-Story requests, focused edits, and dependency-aware multi-record revisions in one Thread without relying on permanent or exhaustive predeclared file scope.
- Queue a normal follow-up and separately steer running Pi work at a safe boundary; recover consistent state after process interruption and service restart.
- Verify deterministic validation for every specialist change and adaptive semantic reviews for consequential/batched assignments. Confirm reviewer rejection → same-session correction → rereview, and disagreement → author choice → revised assignment → rereview.
- Exercise free text, Yes/No/Other, multi-choice/Other, and authenticated protected decisions with correct distinct authorization.
- Inspect a Turn diff and cumulative unpublished diff; request correction as a new Turn; publish a verified partial revision and update the remote only on explicit action.
- Verify the desktop two-workspace layout, independent sidebars, resizing/persistence, and mobile Chat/Outline/Graph selector plus Thread Sheet.
- Ensure Story graph uses the selected Thread's validated revision, distinguishes live working highlights, preserves viewport, and never invents merged Thread state.
- Certify safe recovery, user/repository isolation, authorization non-replay, and no blind cleanup/retry after uncertain writes.
- Require targeted automated contract tests and at least one **real Pi** end-to-end certification using the installed native NovelTea CLI and pinned skills. Fixture-only passes cannot establish live agent acceptance.

## Architectural decisions to record after design confirmation

1. **Thread owns the Story revision lineage, not Conversation/Job.** Alternatives considered: mandatory Conversation nesting and Job-as-Thread. Rationale: continuous mixed-scope conversation, optional organization, correct fork ancestry and continuation identity.
2. **Deterministic checkpoints with adaptive independent semantic review.** Alternatives considered: automatic reviewer for every specialist assignment, and exhaustive up-front file allowlists. Rationale: reliable hard protections, lower token/latency cost for routine tasks, meaningful source-backed review at consequential or batched boundaries.

## Design review / closure

This document records the agreed design. The authoritative published specification is [#102](https://github.com/Cruel/noveltea-gen/issues/102); implementation is divided into dependency-linked, `ready-for-agent` child tickets [#103–#124](https://github.com/Cruel/noveltea-gen/issues/102). This design document is supporting context, not a substitute for each ticket's acceptance criteria.
