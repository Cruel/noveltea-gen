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
