## Problem Statement

An author can request a two-hour interactive mystery or a long dialogue-led visual novel, but NovelTea currently lacks a precise, author-approved baseline for **interaction frequency, branching depth, Puzzle emphasis, playthrough length, and production cost**. The generated Story may be structurally valid yet have too few meaningful interactions, too many expensive route-exclusive scenes, unnecessary Puzzles, or no relationship between its size and the desired playing time.

The generation controller still imposes Event → Choice → Puzzle → Composition for each Milestone, despite the goal-driven orchestration design in #144. This can force an invented Choice after an observational Event, prevent a legitimate Milestone from completing, and block Composition and recovery; the live #173 certification exposed this failure. The current orchestrator mainly reorders a pre-authorized fixed assignment set, and the parent graph and independent checkpoints may still require work the Story never needed.

The native CLI already validates canonical Story records and analyzes typed routes, but no common, source-bound Story-metrics contract aggregates player-facing duration, shared versus route-exclusive content, and production budgets. The Studio cannot report a credible effort-weighted generation percentage or warn that a short but extensively branching Story may cost far more to create than its playthrough length suggests.

Authors need creative direction to govern the Story's interaction and production profile without forcing a fixed Act structure, uniform Choices/Puzzles, or premature conversion of narrative locations into NovelTea engine Rooms.

## Solution

During **Baseline discovery**, establish an approved **Interaction profile**, first-playthrough duration range, Narrative-versus-Exploration pacing, branching/divergence expectations, and hard or soft **Production budget** alongside the existing Creative Direction. Ask a compact set of genuinely missing questions with recommendations, permit explicit delegation and optional precise counts, and preserve the difference between user-protected constraints and model-suggested details.

Store enduring requirements and local estimates on **existing typed canonical records**, not in a separate planning-record type: Creative Direction owns Story-wide targets, Milestones own broad duration estimates and material route alternatives, Characters own artwork tiers, and Puzzles identify Adventure versus Custom interactive mechanics (including hybrids). Treat a Narrative location as a fictional place and distinct visual artwork as a production concept; neither implies a one-to-one engine Room.

Extend the **native NovelTea CLI** with an explicit read-only, revision-bound Story-metrics operation over its validated catalog. It calculates route-aware Narrative/Exploration duration bounds, shared and route-exclusive **Content footprint**, declared artwork/Character budgets, structural estimate coverage, and objective versus calculated constraints. It cannot turn speculative author estimates into factual playing times or judge creative quality. The CLI remains the single deterministic authority for the canonical schema and narrative graph; NovelTea Gen does not implement a competing parser or route analyzer.

Extend the **existing orchestrator** to propose conditional, versioned, source-bound specialist plans rather than merely reorder fixed assignments. The Studio controller validates plan amendments, authorization, typed causal dependencies, protected canon, review evidence, and recovery. Observational Milestones may be Event → Composition; other Milestones may require multiple Events, Choices, Puzzles or supporting work. The absence of an unjustified Choice or Puzzle must be genuinely supported throughout scheduling, Composition, final goal evaluation, checkpoint/recovery and reviewer evidence, never represented by a fictitious commit.

The architecture/review flow evaluates **Story-wide interaction balance, pacing, production feasibility, and branching consequences** before costly detailed authoring and again at final completion. Hard limits cannot silently be exceeded; significant soft-target expansion is surfaced for author direction. Route convergence, including at chapter/Act boundaries, and reuse of core Characters and locations are design options/defaults, not mandatory structures.

Report two honest, separate quantities: **Playtime coverage** (estimated single-route duration supported by authored player-facing content) and **Generation progress** (approximate effort-weighted portion of authorized, independently verified production work complete). Show uncertainty and source revision. Generation percentage can decrease when the authorized scope/estimate changes.

Related work: #144 (one goal-driven orchestrator and one production graph), #158 (complete new-Story certification), #173 (observational Milestone/Choice routing failure). This specification *extends* #144; it does not replace its original safety and collaboration invariants. Project glossary and the proposed interaction/budget ADR provide further design context.

## User Stories

1. As an author, I want a short prompt to initiate a coherent Baseline discovery, so that I need not know the engine or schema before requesting a Story.
2. As an author, I want the discovery conversation to ask only questions still unresolved by my brief, so that I do not repeat information.
3. As an author, I want recommended interaction and production profiles, so that I can approve a sensible starting point quickly.
4. As an author, I want to answer baseline questions partially, so that I can delegate the remaining creative details.
5. As an author, I want an explicitly delegated profile proposed for my approval, so that autonomous creativity does not silently become my decision.
6. As an author, I want interaction frequency established before generation, so that a supposedly interactive Story does not consist almost entirely of passive scenes.
7. As an author, I want the number and importance of meaningful Choices to be distinct, so that a handful of consequential decisions is not confused with many trivial menu options.
8. As an author, I want branching depth distinguished from route-exclusive content, so that stateful choices can have lasting consequences without demanding an entirely separate Story.
9. As an author, I want to specify whether my Story is narrative-led or exploration-led, so that pacing matches the intended player experience.
10. As an author, I want Adventure Puzzle emphasis specified independently, so that object collection, conversations, item use and environment interactions receive the right attention.
11. As an author, I want Custom interactive Puzzle emphasis separately specified, so that tile boards, card games and other bespoke interfaces are not introduced casually.
12. As an author, I want mixed-mechanic Puzzles supported, so that an adventure inventory hunt can culminate in a self-contained puzzle mechanic.
13. As an author, I want investigative conversations and examining clues to count as Exploration rather than mandatory formal Puzzles, so that ordinary mystery play is modeled accurately.
14. As an author, I want qualitative interaction preferences to be sufficient, so that I am not forced to invent an exact number of Choices or Puzzles.
15. As an author, I want to provide optional counts or ranges, so that I can enforce a precise design target when I have one.
16. As an author, I want a target for typical first-playthrough length, so that a three-hour Story differs appropriately from a thirty-hour Story.
17. As an author, I want alternative branches excluded from the duration of one playthrough, so that a branching game is not mislabeled as an excessively long game.
18. As an author, I want Narrative and Exploration duration ranges estimated separately, so that the generated pacing matches my intent.
19. As an author, I want substantial scripted dialogue counted as Narrative time, so that dialogue-led visual novels receive appropriate estimates.
20. As an author, I want brief investigative dialogue, navigation and all Puzzle-solving counted as Exploration time, so that estimates reflect player-directed activity.
21. As an author, I want unique illustrated backgrounds budgeted separately from in-fiction locations, so that reuse does not count as new expensive art.
22. As an author, I want significant variants of artwork estimated separately, so that night/day, damage or special versions are visible production costs.
23. As an author, I want Main, Supporting and Extra Character artwork tiers, so that a background NPC does not carry the expected cost of a protagonist.
24. As an author, I want Character artwork tiers to be distinct from narrative importance, so that a crucial but minimally illustrated Character remains possible.
25. As an author, I want hard limits and soft targets distinguished, so that the generator knows when to redesign versus warn.
26. As an author, I want baseline decisions preserved with correct provenance, so that my stated constraints cannot be replaced by model preferences.
27. As an author, I want the approved baseline reused by later Turns, so that the same Story does not repeatedly restart discovery.
28. As an author, I want a Story architected for my approved interaction profile across the whole route, so that a single ending Choice cannot substitute for the intended experience.
29. As an author, I want observation and discovery Milestones without forced formal Choices, so that the Story progresses naturally.
30. As an author, I want a Choice to be included only when it has a justifiable player decision and payoff, so that agents do not invent empty branches to satisfy scheduling.
31. As an author, I want Puzzles to be optional when not required by my Story direction, so that dialogue-led games remain coherent.
32. As an author, I want a Milestone to support multiple Events or Choices when needed, so that complicated plot developments are not artificially compressed.
33. As an author, I want the same core cast to remain accessible or relevant across major branches by default, so that the Story feels cohesive and artwork is reusable.
34. As an author, I want recurring Narrative locations across routes by default, so that location production remains affordable without forbidding new scenes.
35. As an author, I want route-exclusive Characters and locations when justified, so that production defaults do not erase meaningful creative alternatives.
36. As an author, I want different routes to rejoin while retaining divergent Facts, Relationships and later consequences, so that reconvergence does not trivialize decisions.
37. As an author, I want chapter- or Act-boundary convergence to be optional, so that my Story need not adopt a fixed three-Act formula.
38. As an author, I want a warning when extensive branching magnifies unique content requirements, so that a short playthrough does not hide a huge production commitment.
39. As an author, I want suggestions for reuse or selective convergence, so that I can manage cost without silently losing promised agency.
40. As an author, I want hard-budget violations blocked for redesign or explicit approval, so that production constraints are respected.
41. As an author, I want soft-budget overruns shown with rationale, so that ordinary creative flexibility does not become undetected scope creep.
42. As an author, I want material soft-budget expansion referred back to me, so that major cost changes are my decision.
43. As an author, I want estimates revised as real authored content is produced, so that planning becomes more accurate rather than remaining a first-pass guess.
44. As an author, I want unknown or weak duration estimates visibly marked, so that approximate metrics do not appear to be measured gameplay.
45. As an author, I want actual player testing able to inform later duration estimates, so that Story metrics improve with evidence.
46. As an author, I want estimated Playtime coverage displayed independently of Generation progress, so that longer content is not mistaken for completed work.
47. As an author, I want a Generation progress percentage only when there is a meaningful plan, so that early speculative stages do not display fictional precision.
48. As an author, I want progress weighted by required work and verified outcomes, so that completed trivial Milestones do not inflate a difficult Story's completion claim.
49. As an author, I want progress changes explained after scope amendments, so that a decrease in percentage is understandable.
50. As an author, I want the Stage/Review status visible even without a percentage, so that I can follow the process honestly.
51. As a Story architect, I want each Milestone's Narrative and Exploration estimate expressed as a range, so that pacing can be planned without per-line accounting.
52. As a Story architect, I want optional estimates for materially different route alternatives, so that the longest and shortest routes are not averaged deceptively.
53. As a Story architect, I want to budget logical illustration concepts without assigning engine Room IDs, so that narrative design is not constrained by a future implementation detail.
54. As a specialist, I want to report an unnecessary Choice or Puzzle with actual source evidence, so that the orchestrator can reassess it instead of insisting on invention.
55. As a specialist, I want typed relevant Story context and the existing canonical contract, so that my scope reasoning does not depend on invented metadata or prose-only references.
56. As an orchestrator, I want to add, split, drop or reorder pending specialist assignments, so that the plan follows remaining Story needs.
57. As an orchestrator, I want verified prior work reused after a bounded plan change, so that a new dependency does not waste previously reviewed authoring.
58. As an orchestrator, I want a missing upstream prerequisite reported as an actionable dependency, so that the correct specialist is assigned within permitted scope.
59. As an orchestrator, I want the approved baseline checked at each meaningful architectural review, so that local optimizations cannot quietly undermine the whole Story's intent.
60. As a reviewer, I want to examine Choice consequences even after route reconvergence, so that stateful agency can be judged independently of unique content quantity.
61. As a reviewer, I want to compare actual authored interaction and pacing against the baseline, so that complete-looking records cannot mask an unbalanced player experience.
62. As a reviewer, I want read-only source context spanning relevant routes, so that an unchanged branch is not wrongly declared missing.
63. As a reviewer, I want proposed duration and cost revisions checked for plausibility, so that syntactically valid numbers are not automatically credible.
64. As an operator, I want native route metrics returned with exact revision and validation provenance, so that Studio cannot combine results from stale Story versions.
65. As an operator, I want a bounded and explicit native metrics request, so that ordinary validation remains fast and expensive route enumeration cannot hang generation.
66. As an operator, I want incomplete route coverage reported as unknown, so that search exhaustion never becomes a false success.
67. As an operator, I want stale or tampered estimate or omission evidence rejected, so that recovery cannot invent completed work.
68. As an operator, I want interrupted specialist drafts preserved without blind replay, so that a failed process can be safely reconciled from its original checkpoint.
69. As a maintainer, I want Story schema and generated native contracts to remain synchronized, so that portable skills, Studio and CLI accept the same records.
70. As a maintainer, I want one coherent generation/recovery test suite exercising optional assignments, so that the scheduler and the Composition gate cannot disagree.
71. As a maintainer, I want native CLI metric fixtures covering branches and uncertainty, so that deterministic totals remain correct after catalog changes.
72. As a maintainer, I want representative real-Pi Story runs resumed from preserved reviewed checkpoints where possible, so that agent behavior is demonstrated without unnecessary repeated model calls.
73. As a maintainer, I want no duplicate standalone scheduler or premature Story-to-engine generator, so that the feature extends the existing architecture instead of adding parallel implementations.

## Implementation Decisions

1. **Authoritative baseline.** The approved Creative Direction is the Story-wide source of author requirements. The original Author objective remains authoritative about delivery depth and scope, while the Work plan is a revisable implementation proposal. No model plan can override protected decisions.
2. **Discovery behavior.** New Story discovery establishes premise/conflict, genre/tone, player experience, broad scope, Interaction profile, pacing, target Playthrough length, and hard/soft Production budget with compact recommendations. Exact approval remains mandatory, including in Autonomous mode after full delegation. A focused later Turn does not trigger a new interview just because planning metadata is present.
3. **Interaction semantics.** Distinguish Choice frequency, meaningful decision impact, branching depth, and Content divergence. A reconverged route may have substantial lasting consequences despite limited route-exclusive authored content. No per-Milestone interaction quota.
4. **Puzzle semantics.** Puzzle mechanic family is Adventure, Custom interactive, or a supported hybrid. Ordinary exploration, clue inspection and optional investigative conversations do not automatically establish a formal Puzzle requirement. The existence of a narrative Puzzle does not imply that an engine-level Layout or minigame has already been implemented.
5. **Playthrough contract.** Duration is a range for one typical complete first playthrough. It is not total time over all branches; the route analysis can supply bounds when no single representative route is justified. Narrative time covers mostly sequential authored presentation; Exploration time covers player-directed activity, including short exploratory conversations and Puzzle-solving.
6. **Artwork production semantics.** Budget distinct illustration concepts and significant visual variants rather than engine Rooms. Character artwork tiers are Main, Supporting, and Extra, independent of Character narrative importance. Core cast and Narrative location reuse is a default creative efficiency, not a deterministic prohibition on exclusive content.
7. **Single canonical schema.** Introduce typed, optional planning metadata on existing Creative Direction, Milestone, Character and Puzzle records. Enforce the expected baseline through new Foundation approval rather than forcing every partial Story record to contain an estimate. Do not create a separate canonical planning record. The schemas, portable reference and generated native contract must advance together; the old generated test Stories do not require compatibility migration.
8. **Metadata ownership.** Story-wide targets and restrictions belong to Creative Direction. Broad Narrative/Exploration duration ranges and materially different route-specific estimates belong to Milestones. Artwork tier belongs to Character; mechanic family belongs to Puzzle. Finer-grained estimates are optional only when needed for trustworthy route totals. Missing values must be distinguishable from zero.
9. **Source-backed illustration reuse.** Deduplicate logical visual concepts and variants only when they have stable source-backed identities or explicit references; matching prose descriptions is not deterministic proof of a shared asset. Do not infer engine Room counts or prematurely generate Project data.
10. **Read-only native metric contract.** Add an explicitly invoked narrative metrics operation to the existing native CLI and return a versioned JSON envelope including catalog/revision identity, route coverage and search completeness, duration ranges, shared/exclusive content footprint, resource estimates, constraint comparisons, and uncertainty diagnostics. Avoid a separate TypeScript catalog parser.
11. **Performance and boundedness.** Metrics reuse the CLI's existing canonical typed catalog and route reasoning without requiring an expensive analysis on ordinary hot-path validation. Do not silently substitute a best-effort route enumeration when bounded search exhausts: mark affected results unverified or unknown.
12. **Route aggregation.** Count common Narrative/Exploration segments once per route; never sum mutually exclusive alternatives into a playthrough. Compute distinct authored content/illustration footprint across route alternatives separately. Do not invent a probability-weighted typical route absent an approved basis; report route bounds or coverage gaps.
13. **Estimate confidence.** Structural validation accepts consistent nonnegative ranges, but duration plausibility and narrative quality require independent semantic review and eventually optional playtest evidence. Unreviewed or speculative estimates do not become precise facts. Record source revision and confidence/unknown state in consumer results.
14. **Budgets and warnings.** Hard-limit breaches require redesign or explicit approval before publishing the violating plan. Soft-budget variance produces surfaced, explained warnings, with material scope expansion sent for author decision. Do not implement a universal arbitrary percentage allowance; use source-specific evidence, consequences and constraints.
15. **Pre-authoring architectural review.** Once Architecture is planned, review the proposed interaction density/distribution, route divergence, expected playing time and projected footprint against the approved baseline before expensive Event/Composition work. This is an additional goal-fulfillment check, not merely a record-count minimum.
16. **One orchestrator and one production controller.** Extend existing read-only orchestration from ordering fixed assignments to proposing source-bound, versioned plan amendments with add/remove/split/reorder semantics. The LangGraph controller remains the sole owner of scheduling, authorization, Git history, writer locks, cancellations, recovery and review.
17. **Plan admission.** Authenticate amendment source, approved scope and plan version; validate dependency DAG, typed authoring bounds, exact permitted outputs, protected canon and carry-forward of previously reviewed checkpoints. A specialist or model explanation is not a capability token. Scope expansions requiring author approval remain paused until approved.
18. **Flexible specialist selection.** Use actual remaining Story obligations to choose Event, Choice, Puzzle, Composition and supporting specialists. An observational Milestone can be fulfilled by an Event with no Choice; a decision-oriented Milestone can require multiple interacting units. Unnecessary work is dropped with source-grounded rationale and genuine omission evidence, not a fake authoring commit.
19. **Truthful Milestone closeout.** A Milestone completes only when its actual bound Event routes satisfy the declared change under native validation and required independent review. The controller supports a bounded verified correction for previously partial observational Milestones; it never silently edits protected fields or declares fulfillment from the model's prose.
20. **Downstream optionality.** The graph scheduler, interactive receipt model, Composition preconditions, literary review, final goal assessment, and recovery-checkpoint verifier must agree on the authorized work for a Milestone. Event-only Composition verifies the original Event provenance and authored content; Choice/Puzzle branch obligations are enforced only when authorized and present. A required Choice/Puzzle cannot be silently omitted.
21. **Independent reviews.** Review exact route context, including unchanged downstream relevant Events, and compare fulfilled authored work with both assignment-specific promises and Story-wide interaction/production obligations. Never certify from merely valid metadata or accept a reviewer's proposed unapproved write grant.
22. **Progress ownership.** The CLI owns deterministic Story metrics, but NovelTea Gen owns effort-weighted Generation progress using the current authorized plan and *independently verified* assignment states. Playtime coverage remains a separate approximation. A metric cannot increase certified completion solely because text, duration or record counts grew.
23. **Progress UX.** Show a percentage only when a sufficiently developed plan permits a defensible denominator; otherwise show specific activity and unknown estimate. Label confidence and source revision, distinguish hard violation from soft warning, and explain any progress decline due to authorized replanning.
24. **Revision isolation.** Pin estimates, plan, skill snapshot, validation, review and omission evidence to exact source boundaries. Preserve other Threads' unpublished changes and interrupted worktrees; do not rerun uncertain writers. On fork/resume, carry forward only eligible independently reviewed checkpoints.
25. **No new engine translation.** Creative planning stays at the Story level. Do not generate real Room, Character artwork, Interactable, or Layout implementations as part of this feature. No prescribed Act count, fixed branch topology, or mandatory gameplay mechanic formula.
26. **One cross-repository specification.** The existing goal-driven orchestration spec remains the architectural foundation. This work spans schema/portable skills, native CLI analysis and Studio orchestration; integrate those contracts in compatible order rather than introducing a second scheduler or several competing specifications.

## Adaptive assignment identity and receipt trust (#179)

The controller's executable boundary is a **Milestone-owned specialist unit**, not
one arbitrary assignment for every newly authored canonical record. One Event
unit may realize several source-connected Events and supporting Facts; one
Choice unit may author several consequential Choice Points; a Puzzle unit
assesses genuine, solvable Puzzle obligations. The existing native stage audits
and original specialist receipts verify each authored record, and independent
review judges the complete unit against the approved Story-wide baseline.
Choice and Puzzle remain separately reviewed units with a shared original
Interactive receipt. A new Milestone-stage unit requires verified Architecture
authority and typed dependencies; a source-grounded `narrow` amendment can
refine the actual task and independent review obligation of an unstarted unit.
It cannot invent a new canonical Milestone, change the specialist's file grants,
or require a protected/author-constraint change. A later change that would
invalidate completed dependent work is blocked for reconciliation rather than
refiring the original writer.

The private `adaptive-plan.json` receipt is a **controller-owned integrity
record**, not an author signature. Its SHA-256 digest detects modification; it
is not a cryptographic proof of consent. Authenticity comes from the isolated
controller-held job state, exact job/Thread/Turn/Architecture/source identities,
the pinned skill snapshot and hashed original settled Pi transcript, clean
native validation and original Git/checkpoint assurance. Model-directed tools
have no access to that private state. Independent reviewers consume the
source-ancestral amendment from this boundary; their prose neither grants
write capability nor author approval. Any protected decision or material
expansion must use the separate existing trusted author-approval workflow
documented in `docs/author-signing.md`; a rejected planner proposal cannot
silently become a granted or resumable authorization.

A narrowed Milestone source hash covers its immutable planning metadata and
narrative prose, excluding only the two Event-owned realization fields
(`completeness` and `fulfillment`). Thus an authorized Event closeout does not
invalidate an already admitted downstream Choice goal, but source narrative
drift fails review binding. Filenames are independent of canonical record IDs.
A completed specialist's task overlay may disappear on reconciliation **only**
if its original reviewed commit is verified; a missing unstarted overlay still
fails closed. The original final Story-wide goal review must pass, and the
controller additionally requires every currently authorized assignment to
have a verified disposition before reporting completion.

Deterministic fixture/native tests prove admission, multiple outputs, dispatch
and restart mechanics; they do not certify real-Pi literary judgment. Adaptive
planning stays opt-in until the real-Pi whole-Story certification in #181.
Reviewed optional work omissions are explicitly handled by #180, not by
inventing specialist commits or silently dropping original obligations here.

## Testing Decisions

**Principal seam: the author-visible Story generation contract.** Prefer existing fixture-backed Studio Story Chat / generation execution tests that exercise Baseline discovery, native-validated canonical records, proposed and approved work plans, specialist dispatch, independent review, Composition, checkpoint persistence and final goal fulfillment. This is the highest seam at which a forced Choice or missing approval is observable.

**Second necessary seam: the public native CLI.** Use the actual JSON narrative validation and new metrics command against representative canonical Story fixtures to establish route aggregation, schema behavior, budget comparisons, stable contract identity and bounded uncertainty. This is a separate executable/public API, so it should be tested at its public seam rather than via internal helper mocks. Synchronization with the portable schema and catalog is verified through existing schema-contract tests.

Existing prior art includes the Studio generation, orchestrator planning, independent Composition, recovery/fork and #173 incident regression tests; Story discovery/approved Foundation tests; the portable catalog/CLI and Puzzle tests; native narrative schema, route/coverage, readiness and context certifications; and opt-in real-Pi Story certification. Reuse those seams and extend their fixtures; avoid introducing a parallel scheduler, mock CLI implementation or independent completion oracle.

Test **observable outcomes**, not method call order or internal class shapes:

1. A sparse new-Story brief solicits the essential new baseline dimensions and exact author approval; explicit full delegation proposes but does not auto-approve.
2. An author-protected interaction style, length target or hard art budget remains intact after proposal, revision, resumed Turn and an agent recommendation to relax it.
3. A mostly passive visual novel can complete with few meaningful Choices and no Puzzle, while a Choice-heavy adventure must meet its approved distribution and cannot pass with a token late Choice.
4. A discovery-only Milestone can bind authentic Event fulfillment, proceed directly to relevant authored Composition, and survive restart without creating a fictitious Choice receipt or commit.
5. A Milestone with an approved Choice, Puzzle or specific branching payoff cannot evade those obligations by claiming they were optional.
6. A mixed Adventure/Custom interactive Puzzle remains narratively valid without premature engine implementation; ordinary investigative dialogue remains Exploration rather than a fabricated Puzzle.
7. A 2-hour heavily branching Story reports route-level playtime separately from the total distinct content footprint; a mostly linear longer Story can have a smaller footprint.
8. Shared scenes, reusable illustration concepts, Main/Supporting/Extra Character tiers and variants aggregate without double-counting; same location prose without a declared shared concept does not silently deduplicate.
9. Mutually exclusive branches do not sum into one route; shared events count once; variable-length routes report bounded results, not a fabricated representative route.
10. Missing fine-grained estimates, ambiguous routes, route cycles and search-budget exhaustion return explicit unknown/uncertain results, never falsely precise totals or false success.
11. Hard-budget exceedance blocks or requests exact author approval; soft overruns warn, and materially expanded scope cannot be silently approved by a model.
12. Architecture review catches interaction imbalance and projected branching-cost inflation before detailed authoring, while still permitting meaningful, stateful reconvergence and justified route-exclusive Characters/locations.
13. The CLI output is read-only, stable against repeated calls at the same verified revision, rejects malformed metadata, and does not require unrelated Project or playable runtime artifacts.
14. A verified plan amendment removes or inserts necessary pending work without broadening grants or replaying unaffected writers; invalid dependency cycles and unauthorized expansions fail closed.
15. Interrupted authoring, stale estimates, dirty Story roots, replaced skills, mismatched native catalog versions, tampered omission evidence and stale recovery receipts cannot become certified success.
16. A Composition reviewer sees both new and unchanged relevant branch Events, distinguishes required absent content from legitimately omitted work, and retains independent judgment.
17. A progress indicator remains unavailable before a defensible estimate, updates after reviewed work, can decrease after approved scope growth, and never reaches certified complete while required review is outstanding.
18. A completed real-Pi certified Story satisfies the original approved baseline and finished player-facing narrative, including legitimate optional work; resume existing verified checkpoints where applicable rather than replaying initial turns.
19. No test depends on old generated example Stories continuing to parse under the new coordinated schema. Tests explicitly create fresh canonical fixtures.

Do not use CI while the account's Actions quota is unavailable. Local deterministic tests and bounded, opt-in real-Luna checkpoints are the evidence; preserve all historical failed checkpoints as negative evidence.

## Out of Scope

- A separate canonical planning record, duplicate metric engine in NovelTea Gen, second orchestrator, or standalone production scheduler.
- The Story-to-Project translation layer that turns fictional places and characters into actual engine Rooms, sprite assets, Interactables, Layouts, scripts and playable minigames.
- Mandated three-Act outlines, prescribed convergence points, fixed Choices/Puzzles per Milestone, exact numerical interaction quotas when the author did not request them, or automatically inventing custom minigames.
- Exact playtime prediction, empirical solve-time inference without playtest data, and a guarantee of resource-cost accuracy from prose alone.
- Universal percentage thresholds for soft budgets, unapproved changes to author-protected requirements, or automatic acceptance of subjective reviewer opinions as deterministic facts.
- Migration of the existing generated test Stories to a backwards-compatible schema; they can be regenerated under the synchronized new contract.
- Building new presentation asset generators, actual artwork production, implementing the runtime UI mechanics for Custom interactive Puzzles, or expanding the engine itself beyond the required narrative schema/metrics support.
- Refactoring unrelated persistence, Git hosting, or Studio UI features.
- Creating implementation subtickets in this spec-writing step.

## Further Notes

This is **one cohesive extension** of existing Story orchestration (#144), not a rewrite of the already agreed security and checkpoint architecture. The original #173 issue and its preserved failed/independently reviewed Luna evidence must remain truthful; this spec does not claim that #173, #158 or complete new-Story certification has passed.

Implementation should proceed in dependency order: (1) typed schema + portable skill methods, (2) read-only native metrics, (3) baseline/architecture reviews, (4) revisable controller plans and true conditional specialist routing, (5) progress UI, (6) deterministic and resumed real-Pi certification. A later work-breakdown step may split these into implementation tickets if explicitly requested; this issue is the authoritative cross-repository specification.

**Test-seam agreement to verify before implementation:** author-visible generation through its existing checked/recoverable Story Job API is the principal system seam; the public native narrative metrics CLI is the one additional seam mandated by the separate executable contract. These match the current integration-testing architecture and avoid lower-level seam proliferation.
