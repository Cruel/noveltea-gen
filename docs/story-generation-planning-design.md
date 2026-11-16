# Story baseline, adaptive orchestration, and production-metrics plan

Status: design accepted; see [the implementation specification](story-generation-production-spec.md) for the issue-ready functional contract. Implements the decisions in [ADR 0002](adr/0002-goal-driven-story-orchestration.md) and [ADR 0003](adr/0003-story-interaction-budget-and-estimation.md).
Scope: `noveltea-skills`, native `nt` narrative CLI, and `noveltea-gen`. Implementation is tracked by cross-repository tickets linked to [spec #174](https://github.com/Cruel/noveltea-gen/issues/174); no separate production scheduler. Current test Stories can be regenerated; preserving their old format is not an acceptance requirement.

## Outcome and non-negotiable boundaries

NovelTea creates a Story that meets the **approved player experience, playthrough length, branching, and production budget**, not an arbitrary count of Milestones. The existing rigid Event → Choice → Puzzle → Composition scheduler must not demand a Choice/Puzzle for observational Milestones. An approved Story might be dialogue-led, exploration-led, or a mixture. A short branching game can require more unique authored content than a long linear game.

There is **one goal-driven orchestrator**; the Studio graph remains the only production scheduler and retains the authority for scope, protection, revision lineage, checkpoints, recovery, and independent review. The orchestrator proposes appropriate specialist work and replans at safe boundaries. A proposed assignment is not a write grant or a completion claim. Story work stays creative and narrative-first; engineering conversion to actual NovelTea Rooms, Interactables, sprites, Layouts, and scripts is future work.

## 1. Initial baseline and its authority

Extend `nt-story-discovery`, Studio Story Chat discovery/proposal validation, and the Foundation writer to establish the following in **one concise question round when unspecified**:

- Core Creative Direction: premise, central conflict, genre/tone, intended experience, broad scope, presentation constraints, and author-protected decisions.
- **Interaction profile:** Choice frequency; branching depth/consequence persistence; adventure-Puzzle emphasis; separate custom-interactive-Puzzle emphasis; expected amount of content divergence. Support qualitative responses and optional explicit counts/ranges. A custom interactive Puzzle does not default to being mandatory.
- **Pacing and playthrough length:** narrative-led, balanced, or exploration-led; target range for **one typical complete first playthrough** (not all routes combined).
- **Production budget:** hard limits or soft targets for unique illustrated background concepts, important art variants, and Main/Supporting/Extra Character artwork tiers. Distinguish fictional locations and reused visual concepts from engine Rooms.

Offer genre- and scope-appropriate recommendations, not arbitrary numeric caps or required Act structure. The author may accept, customize, or explicitly delegate suggestions, but the exact proposed Foundation still requires approval in both creative modes. Preserve author words and decision provenance, including the distinction between a soft preference and hard limit. Existing approved decisions are not silently relaxed or reprompted.

The approved baseline is the **Story-wide acceptance contract**. Subsequent plans are implementation hypotheses and do not override it. The whole-Story Turn objectives must reflect the approved profile rather than unconditionally inventing a meaningful Choice for every Milestone.

## 2. Canonical metadata (no separate canonical planning record)

Add **optional typed fields to existing records**, with the required baseline properties enforced for *new approved Foundation proposals* by the discovery/approval workflow. Do not create a second canonical planning document. Determine final field spelling and schema version through a coordinated schema/CLI contract change:

| Existing record | Proposed owned metadata |
| --- | --- |
| Creative Direction | Interaction profile, narrative/exploration pacing, playthrough target range, production budget with hard/soft designation |
| Milestone | Narrative and exploration duration ranges; optional route-specific duration estimates where alternatives materially differ; optional planned reusable background concepts/variants where a grounded production estimate needs them |
| Character | Artwork tier (Main/Supporting/Extra), optionally justified requirements for unusual asset effort |
| Puzzle | Mechanic family (adventure/custom-interactive) and optional estimate/complexity notes only if needed for exploration totals; a hybrid mechanic is allowed |

These are **planning estimates and creative requirements**, not executable runtime semantics. All estimate ranges must be nonnegative, internally consistent, and explicit about missing/unknown values; no fabricated precision. Maintain stable *logical illustration concept* identities for deduplication when practical, without inventing engine Room or Asset IDs. Milestone duration is not the sum of every branch; the CLI handles compatible route aggregation.

Narrative time means predominantly sequential authored dialogue/narration and other scripted presentation. Exploration time means player-directed navigation, investigation, short investigative conversations, object interaction, and all Puzzle-solving. Avoid mandatory time metadata on every Event, line of dialogue, or Puzzle.

Modify the `noveltea-skills` schema and catalog references and regenerate the native `nt` contract together; update Gen's Foundation serializer/proposal checks and authoring/review instructions against the single canonical schema. We need not preserve existing generated test Story formats, but the transition must not create independently interpreted schema definitions.

## 3. Native CLI metrics and deterministic guardrails

The native CLI already owns `narrative validate`, `readiness`, `context`, and route/coverage analysis. Introduce a **read-only, explicitly requested** narrative-metrics operation (working command name: `noveltea --json narrative metrics <catalog-root>`) rather than burdening ordinary hot-path validation or misusing `narrative coverage`, which has a Project/test association.

From one validated, revision-bound catalog, return machine-readable evidence for:

- Per-Milestone and per-supported-route **Narrative / Exploration** duration ranges; route totals exclude mutually exclusive branches and account for shared content once. When no representative-route assumption is justified, report supported route bounds and uncertainty rather than a fake precise average.
- **Content footprint** across all routes: shared versus route-exclusive authored content, distinct logical background concepts/variants, and declared Character-art tier counts. Branching depth and content divergence are separate measurements; reconvergence can preserve distinct facts/relationships.
- Comparison with the **author's declared hard/soft budgets and timing target**, with explicit diagnostics, unknown/unestimated fields, coverage status, and source/contract revision identifiers. The CLI reports numerical/structural facts, not creative desirability.

Readiness/metrics must fail closed on unsupported route analysis, missing causal evidence, inconsistent references, unsafe source revision, or truncated analysis. Bounded search is required; exhausted budgets report `unverified` rather than pretending every route was measured. The CLI does **not** decide whether a Puzzle is interesting, whether dialogue flows naturally, or how long an unplaytested challenge really takes.

## 4. Orchestrator-owned creative planning; controller-owned execution

Replace `src/orchestrator-planner.ts`'s "reorder every previously fixed assignment" proposal with **source-bound, versioned, revisable assignments**. Stage names are domain responsibilities, not compulsory per-Milestone steps.

- Architecture specialist plans the *distribution* of meaningful player agency, puzzles, pacing, and route divergence against the full approved profile **before** expensive content generation. It should favor a shared core cast and recurring narrative locations across routes, with justified exceptions, while avoiding engine-centric Room counts.
- The orchestrator can propose **adding, dropping, splitting, or reordering pending** Event/Choice/Puzzle/Composition and supporting assignments at verified safe boundaries. Several Events or Choices may serve one Milestone; observational Milestones may need Event → Composition only. Puzzles are optional unless their presence is required by approved creative direction.
- Specialists can report an ungrounded or unnecessary Choice/Puzzle. That report triggers source-grounded orchestration reassessment, **not** automatic silent omission or another speculative writer pass. Track explicit rationale and authentic reviewed no-write/omission evidence when appropriate.
- The controller validates each revised dependency DAG, scope, exact allowed paths/types, protected decisions, original objective, and historical provenance. Independent review checks that the remaining Story still satisfies promised interaction density and consequences. Amendments affecting hard limits, material author preferences, protected canon, or the requested outcome require applicable approval. Preserve eligible verified checkpoints and reject stale, tampered, or ambiguous successors.
- Update `generation-plan.ts`, `interactive-work.ts`, `composition-work.ts`, recovery work plans, independent context/review, and final goal fulfillment **consistently**, so optional work does not become mandatory again downstream. Do not claim a skipped Choice has a fictitious commit; support an Event-only composition path with real typed source and review evidence.

An architecture that technically contains choices but delivers insufficient *overall* interaction must fail its qualitative/contract review rather than pass via a count. Route convergence, including at chapter/Act boundaries, is an optional cost-control pattern, **not** a mandatory three-Act formula.

## 5. Budget warnings, estimate lifecycle, and progress UI

**Hard limits:** block the violating proposed plan or require exact author approval of a change. **Soft targets:** emit source-grounded warnings and alternatives; ordinary justified variance may proceed, while a **material** scope increase requests author approval. No arbitrary universal percentage threshold.

When projected branching or custom-interactive complexity makes a short-playthrough Story unusually expensive, warn about **unique content footprint and art/implementation workload**, even if the single-path duration target is satisfied. Suggest optional shared scenes, common locations, limited divergence, or later convergence without silently reducing promised agency.

At verified work boundaries, invoke native metrics when estimates need refreshing, then derive two clearly distinct measures:

- **Playtime coverage:** estimated usable single-route Narrative/Exploration duration relative to the approved playthrough target; does not imply finished or playable production.
- **Generation progress:** approximate effort-weighted share of *required, independently verified* Story work completed from the current versioned assignment plan and CLI's Story metrics. Never infer completion solely from record count, commit count, estimated duration, or validator success.

Show a completion percentage **only after** a sufficiently coherent architecture/effort estimate exists; otherwise use stage/status and "estimate unavailable". Display uncertainty and last revision, and explain if the percentage changes after authorized scope or estimate revisions. User-facing activity and checkpoint status remain auditable even when the estimate is unavailable.

## 6. Implementation order

1. **Schema and terminology:** settle typed field shapes in `noveltea-skills` with golden serialization/validation tests; update portable discovery, architecture, Puzzle, and review guidance; align generated native contract and Gen bootstrap/Foundation serializers.
2. **Native metric engine:** implement CLI read-only route-aware metrics and bounded/uncertain outcomes; test shared versus exclusive branches, logical-background reuse, unknown durations, contradictory constraints, and soft/hard comparisons.
3. **Baseline and architectural gate:** make initial discovery explicitly capture the profile/length/budget, preserve authority, and have architecture/reviewer check duration, interaction balance, and projected footprint before content authoring.
4. **Adaptive workflow:** implement source-bound assignment amendment and true optional Choice/Puzzle paths throughout dispatch, independent review, completion checks, and recovery/checkpoint lineage. Address `noveltea-gen#173`'s observational-Milestone impasse without fabricating Choice work or silently closing partial Milestones.
5. **Progress and UX:** integrate CLI metrics with controller's weighted remaining-work estimate; compact display of playtime, progress, warnings, and estimate confidence; explicit author approval at protected/hard-budget boundaries.
6. **Certification and completion:** run narrow deterministic tests first; recover from the existing real-Luna checkpoints rather than replaying initial Story stages, then certify a genuinely complete approved Story, with independent reviews and negative recovery cases. Do not rely on CI usage.

## 7. Acceptance scenarios

- A narrative-heavy short VN with few meaningful Choices and no formal Puzzle completes without forced Interactive work; a discovery Event legitimately completes its observational Milestone and is followed by appropriate Composition.
- A choice-heavy adventure distributes meaningful interactions across the Story rather than meeting the requirement with one late Choice; conditions and consequences survive route convergence.
- A hybrid collectible-tiles/custom Layout-like challenge is classified distinctly from ordinary adventure investigation, without requiring an engine implementation during Story generation.
- A 2-hour heavily branching game reports small **single-playthrough** duration and potentially substantial unique footprint; a roughly 12-hour game with extensive route-exclusive content warns early without an invented global threshold.
- Multiple Story scenes/locations share one proposed illustration concept; neither engine Room count nor repeated Characters inflate unique-art counts. Main/Supporting/Extra tier budgets remain distinct; route-exclusive exceptions can be justified.
- Narrative versus Exploration estimates treat incidental investigative dialogue and adventure puzzles as Exploration; a route estimate never double-counts mutually exclusive alternatives.
- Hard-budget exceedance blocks until redesign/approval; material soft overrun is surfaced; suggested convergence never silently changes author-protected branching promises.
- Planning can remove a pending Choice/Puzzle with reviewed rationale, insert a genuinely needed new assignment, or add an authorized supporting Event; no authoring permission is inferred from model prose.
- Forks, interruptions, stale plans/estimates, protected conflicts, dirty Story roots, tampered no-write receipts, and independent-review failures do not produce false success. Existing eligible reviewed work is reused safely.
- Progress estimates are explicitly uncertain, can decrease after plan expansion, do not reach certified completion before required reviews, and do not confuse playtime coverage with finished work.

## Deliberate exclusions

No separate canonical planning record; no fixed number of Acts/Choices/Puzzles per Milestone; no artificial exact-count production budget when the author did not request one; no premature NovelTea engine Room/Layout/Asset conversion; no new independent orchestrator or scheduler; no backward-compatibility work for the generated test Stories. Numeric thresholds, exact YAML field names, and the CLI command name are implementation choices to prove with schema and contract tests, not additional creative decisions.
