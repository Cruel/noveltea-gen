# NovelTea Studio

NovelTea Studio is a workspace for developing canonical NovelTea Stories through ongoing author–agent conversations.

## Language

**Story**:
A canonical NovelTea narrative project, associated with a repository Story root and its typed narrative records.

**Thread**:
A continuous author–agent conversation that develops an independent revision lineage of one Story. Multiple requests can advance the same Thread without implicitly incorporating unpublished changes from other Threads.

**Turn**:
One author request and the agent's resulting work within an existing Thread. A Turn may use multiple internal executions and produces reviewable changes without ending the Thread.

**Thread fork**:
A new Thread descended from an exact verified checkpoint in another Thread. Its ancestry remains visible while subsequent Story changes are independent.

**Original-Thread resumption**:
Continuation of an interrupted Turn in its existing Thread, preserving its original objective, execution lineage, and verified work. It does not create a new Thread or reinterpret unfinished operations as complete.

**Collection**:
An optional organizational grouping of Threads within a Story. Collection membership is independent of Thread ancestry and can change without changing the Story revisions.

**Creative mode**:
A policy for how much creative initiative an agent takes and when it seeks author input during Story work. A Thread has a default mode that individual requests can override; modes do not grant authority to change protected canon or exceed an authorized writing scope.

**Baseline discovery**:
The initial author–agent discussion that establishes a new Story's minimum Creative Direction before autonomous or collaborative development. It preserves author-established choices, recommendations, and explicit delegation without requiring complete Story design.

**Interaction profile**:
The author-approved Story-wide expectation for Choice frequency, branching depth, and adventure versus custom interactive Puzzle emphasis. It describes the intended experience without imposing a uniform Choice or Puzzle quota on each Milestone.

**Adventure Puzzle**:
A player-solvable challenge expressed through ordinary exploration and interaction with places, Characters, and objects, including collecting, using, or combining items.

**Custom interactive Puzzle**:
A player-solvable challenge with a bespoke interaction surface or mechanic, such as tile arrangement, a board game, or a card game; it can depend on exploration to obtain its inputs.

**Production budget**:
The author-approved hard limits and soft targets for costly Story presentation needs, including distinct illustrated backgrounds, meaningful visual variants, and Character artwork tiers. It is separate from the number of narrative locations or engine Rooms.

**Character artwork tier**:
A production classification of Main, Supporting, or Extra according to expected visual asset effort, independent of a Character's narrative importance.

**Playthrough length**:
The intended elapsed player experience along one complete Story route, including reading, exploration, and problem-solving. It does not sum the duration of alternative branches.

**Narrative time**:
Estimated time spent in predominantly authored, sequential dialogue, narration, and other scripted Story presentation.

**Exploration time**:
Estimated time spent in player-directed investigation, navigation, brief investigative conversations, object interactions, and Puzzle-solving.

**Narrative location**:
A place in the fiction where Story action occurs. It can support many distinct scenes or conditions and does not imply a one-to-one mapping to engine Rooms or unique background artwork.

**Content footprint**:
The approximate total distinct content and production effort across all routes, including reused and route-exclusive material; unlike Playthrough length, it accounts for alternatives that a single player may never see.

**Content divergence**:
The amount of route-exclusive authored content introduced by branching, distinct from how consequential a Choice remains after routes reconverge.

**Generation progress**:
The estimated share of total required, verified Story production work completed against the current approved scope. It is not the same as completed playtime and may change when the plan changes.

**Playtime coverage**:
The estimated duration already supported by player-facing Story content along a representative route relative to the approved Playthrough length target. It is distinct from Generation progress.

**Author objective**:
The Story outcome an author requests in a Turn, independent of the specialist assignments chosen to achieve it.

**Orchestrator**:
The agent responsible for interpreting an author objective against existing Story canon, coordinating specialist work, and reassessing remaining obligations as verified Story changes emerge. Its recommendations do not independently grant write authority.

**Work plan**:
A revisable set of specialist assignments and dependencies intended to fulfill an author objective. Verified Story changes and author direction may alter remaining work without redefining the original objective.

**Story Blueprint**:
A provisional, Story-wide causal design establishing the central narrative resolution, major turning points, Milestones, and consequential outcomes without specifying all local evidence or scenes.

**Milestone Blueprint**:
A provisional design for one Milestone's causal Events, evidence, decisions, and downstream obligations, developed when its verified prerequisites are available.

**Milestone Blueprint approval**:
An independent judgment that a specific version of the provisional Milestone design meets its planning contract at the cited source. It does not certify that downstream assignments have been completed, nor make the plan unchangeable.

**Post-approval revision**:
A source-bound correction or amendment of previously approved provisional Story work that preserves the prior approval as historical evidence. Its consequences for dependent work must be assessed against the new approved version.

**Approval escape**:
A defect that was already present in the evidence accepted by an earlier independent approval but was recognized only afterward. It is distinct from a revision justified by later Story information or an author's changed direction.

**Downstream obligation**:
A requirement for additional Story work that remains after the current stage and has a responsible specialist. A determination that no Choice or Puzzle is needed is not an Interactive downstream obligation.

**Specialist assignment**:
A bounded task derived from a Thread request or work plan, describing the specific outcome a specialist is responsible for producing. It is the reference for reviewing that specialist's proposed Story changes, rather than the original broad Story brief.

**Review cycle**:
A bounded collaboration between an independent, read-only reviewer and an authorized writer over successive revisions of the same work, retaining both conversations until review is resolved or escalated.

**Diagnostic review**:
A fresh independent assessment of a stalled or nonconverging Review cycle, used to distinguish genuine blockers from reviewer drift or unsuitable planning scope without granting approval or write authority.

**Specialist review**:
An independent semantic check of a specialist's proposed changes against its assignment and the relevant Story state. Reviews can cover a bounded group of related assignments; findings require a corrected draft or author-directed resolution of a disagreement, never argument-only approval.

**Repair finding**:
A source-bound unmet Story obligation or defect discovered during a Turn that may require an authorized corrective assignment. Reviewers may follow multiple evolving concerns within one Review cycle without assigning a permanent identity to every observation.

**Repair ledger**:
Controller-owned recovery state linking authorized corrective work with verified revisions, submitted attempts, review outcomes and continuation authority. It does not own a reviewer's evolving semantic analysis or canonical Story content.

**Corrective assignment**:
A bounded specialist assignment authorized to resolve a Repair finding, including a defect in previously reviewed work. It preserves the original author objective and does not implicitly grant authority over protected decisions.

**Repair cycle**:
A controller-mediated correction of a source-bound failure through authorized specialist work and verification, possibly revising earlier reviewed content. It is distinct from a Review cycle, which may address multiple evolving concerns within one bounded assignment.

**Repair exhaustion**:
A safe stop when an unresolved correction cannot proceed within available authority, integrity safeguards or recovery limits. The Turn's eligible completed work and evidence remain available for author-guided continuation.

**Review dispute**:
A source-linked challenge to an independent specialist-review finding, presented for controller verification and, where needed, fresh independent adjudication. It cannot override the original verdict merely through an agent's argument.

**Protocol failure**:
An agent execution failure to satisfy its prescribed response or source-inspection contract, such as invalid JSON or missing required fields, independent of whether its Story-writing changes are correct. Its bounded correction attempts are tracked separately from substantive Repair findings.

**Pending revalidation**:
A previously reviewed specialist result whose relevant upstream evidence changed and must be checked against the updated Story before it can be carried forward as current.

**Validated checkpoint**:
A recoverable Story revision that passed mandatory deterministic verification. It does not imply independent semantic review.

**Reviewed checkpoint**:
A validated Story revision whose relevant changes and assignments have passed the required independent semantic review. Review may be selectively triggered or grouped under the controller's review policy; later authorized corrections can supersede its content without rewriting its history.

**Author Question**:
A bounded request for an author's direction, with defined response options or an open-ended answer and optional recommendations. It can arise during Story discovery or ongoing Story work; answering it is distinct from granting protected-decision approval.

**Question Set**:
One or more related Author Questions presented for a single author response round. It is completed only when each question has an explicit answer or authorized Studio delegation; unfinished responses remain drafts until then.

**Author choice**:
An Author Question raised by a specialist during Story work and bound to the exact waiting assignment. Its answer can guide that work but cannot bypass protected-decision authorization.

**Studio delegation**:
An author-submitted response permitting NovelTea Studio to decide a bounded Author Question on the author's behalf, only where the workflow allows it. A recommendation, a provisional default, or delegation is never approval to change protected canon.

**Studio decision**:
A choice made by NovelTea Studio under an authorized delegation, recorded separately from that delegation and subject to the applicable Story validation and review rules.

**Planning interpretation**:
A structured Story planning value inferred from an author's exact response or an authorized Studio delegation. Its source remains identifiable, and author approval of the resulting Creative Direction confirms the proposed interpretation without rewriting the original words.

**Author review**:
An author's inspection of changes made in a Thread, including Story diffs and affected records. It is distinct from automatic specialist review and from external publication.

**Publication**:
An explicit operation that exposes a verified Story revision for external review through a linked GitHub pull request or GitLab merge request. Publication is separate from author review and does not automatically incorporate later Thread changes.
