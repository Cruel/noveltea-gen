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

**Specialist assignment**:
A bounded task derived from a Thread request or work plan, describing the specific outcome a specialist is responsible for producing. It is the reference for reviewing that specialist's proposed Story changes, rather than the original broad Story brief.

**Specialist review**:
An independent semantic check of a specialist's proposed changes against its assignment and the relevant Story state. Reviews can cover a bounded group of related assignments; findings require a corrected draft or author-directed resolution of a disagreement, never argument-only approval.

**Validated checkpoint**:
A recoverable Story revision that passed mandatory deterministic verification. It does not imply independent semantic review.

**Reviewed checkpoint**:
A validated Story revision whose relevant changes and assignments have passed the required independent semantic review. Review may be selectively triggered or grouped under the controller's review policy.

**Author choice**:
A durable question proposed by an agent and answered through binary options, multiple alternatives, or free text; structured options always permit a custom Other response. The trusted controller binds the answer to the exact waiting work, without bypassing protected-decision authorization.

**Author review**:
An author's inspection of changes made in a Thread, including Story diffs and affected records. It is distinct from automatic specialist review and from external publication.

**Publication**:
An explicit operation that exposes a verified Story revision for external review through a linked GitHub pull request or GitLab merge request. Publication is separate from author review and does not automatically incorporate later Thread changes.
