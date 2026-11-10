## Problem Statement

NovelTea Studio already has Git-backed Story generation, typed native validation, Pi specialists, verified checkpoints, author interrupts, publication, and recovery. Yet its ordinary authoring experience is still shaped around **Jobs**, mandatory **Conversations**, and individually configured generation scopes. An author wanting to create a complete mystery Story and later make a small dialogue or Character change must understand execution mechanics that ought to remain internal. The existing Story Outline/Graph lives in the Job interface rather than being a persistent part of the conversation workspace.

The current planning boundary also mixes the user's intent, a specialist's assignment, and up-front file authorization. Pi frequently needs to read, grep, and follow Story relationships before it can know which records a legitimate revision must modify. Requiring an exhaustive initial file list either blocks appropriate changes or forces cumbersome user approvals. Conversely, structural validation alone cannot establish that a specialist fulfilled its actual assignment, while independently reviewing *every* tiny assignment consumes excessive tokens and time.

Authors need a continuous, responsive Story-development workspace with independent Git-backed Threads, useful adaptive review, explicit publication, and understandable recovery—without weakening protected-canon authority, native validation, user isolation, or crash guarantees.

## Solution

Refactor Studio into a **Story-first, chat-first authoring workspace**. A Story contains independent **Threads**, each representing one author–agent conversation and one Git-backed revision lineage. A Thread consists of multiple **Turns**: requests that can alternate freely between whole-Story generation, focused revisions, and multi-record work. Jobs, specialist assignments, Pi sessions, approval interrupts, and checkpoints remain internal execution records. **Collections** optionally organize Threads but never determine their ancestry or become a mandatory navigation tier.

A planner interprets each Turn into bounded specialist assignments, using the original request for plan-level completeness while allowing Pi to inspect the canonical Story to discover affected files. Deterministic rules always protect the sandbox, writer ownership, native Story validity, Git identity, protected decisions, and exact human approvals. A controller-owned **adaptive semantic-review policy** independently reviews consequential assignments or bounded groups against their *specific specialist assignments* and actual diffs, while simple changes may skip a model reviewer. A reviewer finding requires an actual correction and rereview, or a user-directed assignment change; agents cannot debate a rejection into acceptance. Distinguish structurally **validated checkpoints** from independently **reviewed checkpoints**.

Provide **Autonomous** and **Collaborative** creative modes as extensible policies, a durable **Author Choice** system (free text, Yes/No/Other, or multiple-choice/Other), queued follow-ups and explicit safe-boundary steering, concise live Pi status, and persistent authoritative execution history.

On desktop, display two vertically stacked, resizable workspaces: **Outline beside a large Graph above Threads beside Chat**, with independently collapsible sidebars and a collapsible Story region. On mobile, replace the stacked layout with **Chat / Outline / Graph** full-workspace views and a Sheet for Thread navigation. All views reflect the selected Thread's verified Story revision, synchronize record selection, and distinguish live unverified activity from canonical changes.

Keep **Review Changes** as an inspect-only action, independent from automated semantic review and from **Publish**. Permit explicit publication of verified partial or completed Story progress to a GitHub PR or GitLab MR; do not automatically update publication when subsequent Turns complete.

Adopt a clean SQLite persistence model. The current Studio SQLite database is disposable local development state; **no old-schema or data compatibility migration is required**. Do not confuse that permission with deletion of independent Git worktrees, committed Story revisions, private credentials, snapshots, recovery evidence, or unrelated service data.

## User Stories

1. As an author, I want to choose a Story before navigating its Threads, so that I work in the correct narrative without navigating Jobs.
2. As an author, I want a new Story to open immediately with Outline, Graph, and an empty Chat, so that I can begin creating without configuring a generation Job.
3. As an author, I want my first message to create a Thread automatically, so that starting Story work feels like starting a normal conversation.
4. As an author, I want a Thread to retain one stable identity across multiple requests, so that an execution finishing does not end my creative conversation.
5. As an author, I want to ask for an entire mystery game, so that the system can coordinate complex generation for me.
6. As an author, I want to request a minor Character change in that same Thread, so that I don't have to start an unrelated Job.
7. As an author, I want to alternate complete Story generation, scoped Milestone work, and focused edits, so that a Thread never locks me into one scope.
8. As an author, I want every new Turn to build on the latest valid Thread checkpoint, so that earlier verified results are preserved.
9. As an author, I want to fork a Thread from an exact verified checkpoint, so that alternate approaches cannot overwrite each other's work.
10. As an author, I want fork ancestry to remain visible, so that I know where an alternate Thread diverged.
11. As an author, I want optional Collections for organizing Threads, so that I can group creative work without changing Git ancestry.
12. As an author, I want to move a Thread between Collections, so that organization remains flexible.
13. As an author, I want tree and flat Thread views, so that I can choose between ancestry and recent activity.
14. As an author, I want compact navigation with accessible icons and meaningful status, so that I can browse many Threads efficiently.
15. As an author, I want to archive or delete a Thread using existing guarded semantics, so that cleanup does not destroy recoverable descendants.
16. As an author, I want to choose Autonomous or Collaborative behavior, so that creative initiative matches my working style.
17. As an author, I want a Thread-level creative-mode default, so that repeated requests share my preference.
18. As an author, I want to override the mode for a particular Turn, so that I can collaborate on planning and delegate later execution.
19. As an author, I want future creative-mode variations to fit the same workflow, so that new styles do not require a new generation architecture.
20. As an author, I want the planner to turn a broad request into specific specialist assignments, so that each agent has an actionable objective.
21. As an author, I want Pi to inspect relevant Story records and search for dependencies, so that legitimate changes aren't blocked by an incomplete up-front filename list.
22. As an author, I want narrow requests to invoke only necessary specialists, so that small edits don't incur full-Story generation cost.
23. As an author, I want protected canonical decisions to require explicit trusted authorization, so that creative agents cannot silently revise agreed canon.
24. As an author, I want specialists to be unable to write outside their sandbox and hard record-category permissions, so that semantic flexibility does not weaken security.
25. As an author, I want deterministic native Story checks on every specialist change, so that invalid or structurally unsafe work is never accepted as verified.
26. As an author, I want routine small changes to avoid unnecessary model review, so that the experience remains responsive and cost-efficient.
27. As an author, I want consequential changes to receive independent semantic review, so that important narrative errors and unjustified edits are detected.
28. As an author, I want related specialist assignments reviewed together when appropriate, so that a Milestone receives coherent assessment without redundant reviewers.
29. As an author, I want a semantic reviewer to assess the *specialist's actual assignment* and diff, so that a broad original prompt does not make review meaningless.
30. As an author, I want final plan-level fulfillment checked separately, so that all specialists passing does not conceal an incomplete plan.
31. As an author, I want a reviewer to identify disputed files, lines, and assignment requirements, so that corrections are actionable.
32. As an author, I want a rejected specialist to correct work in its original Pi session, so that useful context and drafts are retained.
33. As an author, I want a corrected draft independently reviewed again, so that rejected work cannot become accepted merely through explanation.
34. As an author, I want a genuine specialist/reviewer disagreement presented to me, so that I—not another model—can decide whether the assignment changes.
35. As an author, I want independent tasks to continue while one assignment awaits my decision, so that an unrelated dispute doesn't halt all progress.
36. As an author, I want bounded repair attempts and consolidated disputed choices, so that review failures don't cause infinite loops or excessive interruptions.
37. As an author, I want validated and independently reviewed checkpoints visibly distinguished, so that I understand what was actually verified.
38. As an author, I want downstream generation blocked only when a required review or protected decision is unresolved for its dependencies, so that low-risk work can progress safely.
39. As an author, I want Pi to ask ordinary questions using free text when appropriate, so that not every decision must be reduced to choices.
40. As an author, I want Yes/No/Other questions, so that simple decisions can be answered with one action or my own direction.
41. As an author, I want multiple alternatives plus Other, so that I can choose among useful approaches or propose my own.
42. As an author, I want optional notes with a selected answer, so that I can qualify a choice without replacing it.
43. As an author, I want answers saved against the exact waiting work, so that a restart or duplicate submission cannot misapply my decision.
44. As an author, I want consequential protected changes to use a separate exact approval, so that an ordinary choice isn't mistaken for authorization.
45. As an author, I want to send a normal follow-up while work is running, so that it can queue until the current work is safely complete.
46. As an author, I want an explicit Steer current work action, so that I can redirect an active Pi specialist without interrupting deterministic work.
47. As an author, I want clear concise work-status updates, so that I know what Pi is doing without noisy transcripts in Chat.
48. As an author, I want to distinguish agent-reported activity from verified controller outcomes, so that progress claims aren't mistaken for completed work.
49. As an author, I want expandable activity history and checkpoints, so that I can investigate earlier changes without cluttering the conversation.
50. As an author, I want activity entries associated with affected Story records, so that I can locate the work visually.
51. As an author, I want Outline and Graph visible above Chat on desktop, so that I can follow the evolving Story while collaborating.
52. As an author, I want the Outline sidebar vertically aligned above the Thread sidebar, so that both workspaces use the full window width efficiently.
53. As an author, I want a large resizable Graph above Chat, so that I can decide how much screen space to give to Story exploration.
54. As an author, I want independently collapsible Outline and Thread sidebars, so that either Graph or Chat can gain space.
55. As an author, I want to collapse the entire Story workspace and remember its layout, so that Chat can occupy the full work area when desired.
56. As an author, I want synchronized Outline/Graph record selection, so that I can move between hierarchy and relationships without losing context.
57. As an author, I want a compact selected-record inspector with canonical content, so that I can inspect Story facts without opening a new page.
58. As an author, I want to open the full record diff in Review, so that inspection and change assessment remain distinct.
59. As an author, I want native-backed typed Story relationships, so that Graph edges accurately represent the canonical Story.
60. As an author, I want the Graph to show the selected Thread's version of the Story, so that unrelated unpublished Thread changes never appear merged.
61. As an author, I want currently edited records highlighted distinctly from verified changed records, so that incomplete writes are not presented as established canon.
62. As an author, I want hovering historical activity to highlight affected nodes without changing my selection, so that I can inspect how the Story developed.
63. As an author, I want Graph pan and zoom preserved while Pi works, so that live highlights don't steal my viewpoint.
64. As an author, I want optional Follow activity and a relevant initial subgraph, so that I can follow generation when I choose.
65. As an author, I want Graph viewport, filters, and selected record remembered per Thread, so that I can resume exploration where I left off.
66. As a mobile author, I want to switch among full-workspace Chat, Outline, and Graph views, so that each gets usable space.
67. As a mobile author, I want Thread navigation in a Sheet, so that it remains accessible without occupying the main display.
68. As a mobile author, I want selecting a record to stay in my current view, so that I am not unexpectedly redirected.
69. As a mobile author, I want a View in Graph action from Outline, so that navigation happens when I request it.
70. As an author, I want the layout and mobile view to remember separate preferences, so that device changes don't disrupt my workspace.
71. As an author, I want Review Changes on a completion message to show that Turn's diff by default, so that I can assess the recent request.
72. As an author, I want the persistent Review panel to show cumulative unpublished changes by default, so that I can assess my full outgoing revision.
73. As an author, I want to inspect changes without a mandatory Accept step, so that reviewing isn't another approval ceremony.
74. As an author, I want to select a diff hunk and request a correction in Chat, so that the follow-up becomes a normal new Turn with relevant context.
75. As an author, I want to publish verified partial Story progress, so that useful work can be reviewed before every future Milestone is finished.
76. As an author, I want Publish separate from Review Changes, so that simply inspecting a diff never triggers a remote operation.
77. As an author, I want a published PR/MR bound to an exact verified Git revision, so that later local changes don't silently update it.
78. As an author, I want to explicitly update an existing draft PR/MR or create a separate one, so that publication remains under my control.
79. As an author, I want outstanding mandatory semantic review completed before publication, so that skipped low-risk reviews are not misrepresented as publication-ready.
80. As an author, I want an interrupted writer's draft and Pi session preserved, so that a restart cannot erase recoverable work.
81. As an author, I want safe automatic retries for provably idempotent failures and inline recovery for uncertain cases, so that routine issues don't require Job administration.
82. As an author, I want unsafe recovery blocked with an explanation and advanced diagnostics, so that the system never silently replays an ambiguous write.
83. As an advanced user, I want an Execution Details view with session/checkpoint/review evidence, so that I can troubleshoot without making Jobs the main navigation.
84. As an administrator, I want strict per-user and repository isolation across Threads, tools, storage, and API responses, so that one author's work is never exposed to another.
85. As a developer, I want a clean Studio schema without old Conversation compatibility, so that new code isn't burdened by disposable development data.
86. As a developer, I want end-to-end tests of normal authoring, review, publication, and recovery using real Pi and the native CLI, so that the refactor is certified beyond fixture-only behavior.

## Implementation Decisions

1. **Domain ownership:** Story → Thread → Turn is the user-facing model. A Thread owns one independent Git revision lineage. Internal Jobs/executions are resources under Turns; they never replace Thread identity. Fork ancestry and immutable source checkpoint identity survive navigation or Collection changes.
2. **Optional organization:** A Collection is optional mutable grouping metadata within a Story, not a mandatory Conversation and not a parent of the fork tree. Support tree and flat presentations without changing ancestry.
3. **Clean persistence cutover:** Replace the mandatory Conversation-based application schema with first-class Story, Thread, Turn, optional Collection, execution, checkpoint, author-interaction, activity, review, and publication associations as needed. The existing local dev SQLite data and schema can be purged and recreated. No legacy migration/dual-write/compatibility UI is necessary. Reset only the verified isolated Studio DB; this does not authorize deleting Git worktrees, private sessions or separate volumes.
4. **Turn scope:** Infer a new outcome and plan per Turn. Do not persist a permanent generation depth or set of editable filenames as Thread identity. Maintain versioned, typed internal assignment and completion contracts for planning, validation, safety, and exact authorization.
5. **Specialist discovery:** Pi may inspect Story sources to discover necessary dependent records. File discovery is not blanket write permission: deterministic guards remain authoritative for Story root and record categories, Git identity, user ownership, canonical validation, explicit author-protected decisions, and external side effects. Pi cannot grant itself new protected authority.
6. **One active writer:** Serialize writes per Thread and reconcile exact HEAD, leases, and revision receipts. Normal follow-ups queue; explicit steering is injected only at safe Pi boundaries. Preserve the distinction between a Turn, a run, and a Pi SDK turn.
7. **Creative modes:** Initial Autonomous and Collaborative modes are configurable policies, with Thread defaults and per-Turn overrides. The data model must admit later hybrid modes without redesigning the orchestration graph. Policies change when creative input is requested, not hard safety requirements.
8. **Plan versus assignment review:** A planner decomposes broad user intent into specific specialist assignments. Specialist review tests the relevant assignment against its changed records; a separate plan-level assessment checks whether the *collection* of assignments fulfilled the user's overall request.
9. **Mandatory deterministic gates:** Verify canonical schema/diagnostics, typed dependencies, protected-decision provenance, allowed operations, trusted Git identity, and the pinned native validator after every specialist's changes. Persist a distinct validated checkpoint; never represent it as semantically reviewed without independent evidence.
10. **Adaptive independent review:** Controller-side, deterministic review-selection rules decide when a read-only Pi reviewer is warranted based on high-impact narrative changes, protected-adjacent decisions, dependency complexity, record changes, and prior review findings. Do not let the writer exempt itself. Allow bounded related assignments to share a semantic review while preserving assignment→diff provenance.
11. **Reviewer contract:** Compare the specialist's exact assignment, pinned relevant Story state and baseline, and actual proposed Git diff. Return pass or source-linked actionable findings. A failed finding requires a corrected draft and renewed review; a disagreement is a durable author interrupt, **not** an agent-to-agent rebuttal or negotiation. A user-directed assignment change is followed by a fresh review.
12. **Checkpoint dependency policy:** Independent downstream work may proceed from the latest validated checkpoint. A required pending/failed semantic review blocks its dependents. Group review at meaningful narrative checkpoints and before publication; record skipped versus passed review explicitly. Bound repair attempts and preserve original Pi sessions/drafts.
13. **Unified Author Choice:** Generalize existing durable specialist author questions, authenticated response handling, and typed LangGraph resume. Support free text, Yes/No/Other, and multiple-choice/Other with optional notes. Other reveals a text field. Agent-generated alternatives are presentation suggestions; trusted controller state owns binding, authorization, and replay rejection. Protected canon needs its distinct approval pathway.
14. **Chat and activity:** Keep permanent messages, compact live Pi `report_status`, and durable controller execution events separate. The controller, not Pi status narration, establishes verified paths, Git revisions, validation results, and final state. Associate activity with changed records for Outline/Graph highlighting and historical hover.
15. **Desktop layout:** Two stacked full-width areas. Upper row: collapsible Outline sidebar beside a large Graph. Lower row: independently collapsible Thread sidebar beside Chat. Horizontal divider resizes/collapses the upper row. Remember pane dimensions, expansion, and sidebar visibility independently of per-Thread graph viewport.
16. **Mobile layout:** One of Chat, Outline, or Graph occupies the main view; Thread navigation is a Sheet. Selection is synchronized but never changes views automatically. Provide explicit View in Graph and responsive persisted view selection distinct from desktop layout state.
17. **Graph authority:** Build relationships from the verified native Context Manifest and selected Thread's validated HEAD. Retain per-Thread selected record, viewport, and filters; overlay live working highlights separately. Default to no auto-pan, optional Follow activity, and relevant initial subgraph. Never synthesize a cross-Thread merged Story.
18. **Review versus publication:** Review Changes is an inspect-only diff explorer with no Accept action or Git mutation. Completion-message Review defaults to the Turn diff; persistent Review defaults to the unpublished cumulative diff. In-context correction creates a new Turn.
19. **Explicit publication:** Create or update a GitHub PR/GitLab MR only on author action and after all mandatory validation/review gates for the selected revision. Permit partial progress, exact revision pinning, default option to update the existing draft PR/MR, and an alternate new publication with explicit confirmation. New Turns never silently push to an existing publication.
20. **Recovery and advanced operations:** Reuse durable LangGraph/Pi work evidence, checkpoint receipts, and existing no-blind-retry safeguards. Present routine author interrupts and recovery inline. Retain advanced Job-level session inspection/reconciliation outside primary navigation.
21. **Implementation delivery:** Use a single Story-first UI as the target rather than maintaining two permanent UX stacks. Implement incrementally through the domain/controller contracts, schema cutover, unified Turn orchestration, semantic review, author interactions/activity, responsive workspace, review/publication, then hardening and removal of superseded Job-centric navigation. Preserve functional existing mechanisms where their safety contracts remain valid.
22. **Compatibility boundaries:** The new first-class Thread model intentionally supersedes the mandatory Conversation navigation and fixed up-front editable scope assumptions previously specified in conversational-Thread work. It does **not** supersede existing sandbox isolation, author approvals, native validation, ownership checks, checkpoint recovery, or external provider controls.

## Testing Decisions

**Primary seam:** Test the **highest practical authenticated Studio Story/Thread workflow**, from starting a Story conversation through its persisted execution, native Story revision, review and publication. Drive the same application/controller contracts used by UI actions and inspect externally observable persisted/remote results. This single primary seam should capture the feature's behavior, rather than introducing a separate test-only orchestration API or asserting implementation-private intermediate function calls.

A good test asserts observable user-visible outcomes, exact saved Git/Story results, verified ownership and consent, and behavior across restart. It should not assert incidental component layout implementation, internal method order, model wording, timing guesses, or the specific sequence of Pi tool calls. Keep deterministic fixtures for repeatable negative cases; supplement them with actual Pi and native NovelTea CLI certification to validate integration, not model phrasing.

Existing prior art includes the Studio Thread chat and continuation tests, advanced Thread persistence and checkpoint-fork tests, navigation UI tests, Story explorer tests, generation queue/controls tests, author-decision tests, protected approval and publication tests, native generation/focused-generation/narrative-review tests, recovery tests, and self-hosted and real-Pi certification. Extend these seams where useful rather than inventing duplicate infrastructure.

**Required coverage:**
1. New Story → first message automatically creates exactly one stable Thread; Story selection and access are owner-scoped.
2. One Thread executes complete-Story generation, focused correction, and dependency-aware multi-record changes as sequential Turns, each from an exact validated checkpoint.
3. Optional Collections can organize/move Threads without changing fork ancestry; tree/flat and archived/deleted lineage remain sound.
4. Autonomous/Collaborative defaults and per-Turn overrides influence creative questions without affecting deterministic protection.
5. Pi may discover needed files through read/search; unintended edits, unauthorized record categories, protected changes, and out-of-root writes are rejected.
6. Native validation runs and records durable evidence for each specialist change; validated and semantically reviewed checkpoints remain distinct through restart.
7. Controller-triggered semantic review may be skipped for routine safe edits, invoked for high-risk work, or grouped for bounded related assignments; reviewer assignment/diff coverage is complete.
8. Reviewer rejection → original specialist session repairs draft → fresh review. Specialist disagreement → user interrupt → exact authorized assignment revision → independent rereview. Agent-only rebuttal never passes.
9. Plan-level fulfillment still detects a missing overall requirement even when individual specialist assignments pass.
10. Free-text, binary/Other, multiple-choice/Other, notes, and custom answers correctly resume exact work; stale/replayed/wrong-owner answers are rejected. Ordinary choices cannot authorize protected decisions.
11. Queued follow-ups, mid-run steering, boundary dispatch, independent work during an unrelated disagreement, and last-verified-HEAD continuation are race-safe.
12. React desktop Story/Chat rows, independent sidebar collapse, resize, persistence, synchronized Outline/Graph selection, and record inspection operate accessibly.
13. Mobile Chat/Outline/Graph views and Thread navigation Sheet work with keyboard/screen reader and reduced motion; selection and activity never unexpectedly change views.
14. Native-backed Graph represents only the selected Thread's verified canon; active/unverified edits and committed changes have different indicators, hovered activity highlights correct records, and viewport is preserved.
15. Turn Review and cumulative Review display the correct diff/record associations; requesting a correction adds a Turn and does not mutate the reviewed checkpoint.
16. Publication only occurs by explicit command, on an exact verified revision with outstanding mandatory review resolved; partial progress is eligible, published PR/MR updates are explicit, and subsequent Turns do not silently push.
17. Crash/restart/reconnect and interrupted writer recovery preserve drafts and evidence, never replay uncertain work, and do not forge completed checks or approvals.
18. Cross-user, cross-Story, and cross-repository isolation apply to messages, graph data, activity, approvals, Git worktrees and external publication.
19. Explicitly initialized fresh SQLite schema passes schema integrity and fresh restart tests with no requirement to read discarded legacy data.
20. End-to-end self-hosted certification includes at least one **real Pi** generation and focused follow-up using the installed native NovelTea CLI and pinned skills; fixtures alone do not close acceptance. Record exact revision, outcomes and environmental limits.

## Out of Scope

- Cross-Thread merging/integration workflows, merged-Story preview UI, or automatic import of another Thread's unpublished work. Retain correct fork ancestry for future integration.
- New creative-mode presets beyond the initial Autonomous and Collaborative policies.
- A permanent alternate Job-centric authoring experience or duplicate frontend.
- Extensive configurable manual generation scope forms in the normal Chat composer.
- Mandatory independent semantic-review calls for every small specialist assignment.
- A model-to-model reviewer debate/rebuttal process or reviewer authority to grant protected-canon permission.
- Automatically publishing after each Turn or treating Review Changes as approval for Git publication.
- Legacy SQLite schema/data migration, dual reads/writes, or retaining mandatory Conversation compatibility.
- Replacing existing native NovelTea Story schemas, the native validator, Git isolation, or the rootless tool sandbox.
- Optional desktop comparison/split layouts beyond the agreed Outline-sidebar/Graph arrangement.
- Creation of implementation child tickets as part of this specification publication.

## Further Notes

- **Relationship to existing specs:** Extends the multiuser Studio foundation in #38 and the completed conversational Thread implementation in #73. Intentionally revises their *user-facing* mandatory Conversation hierarchy, fixed per-follow-up file scope, and Job-oriented navigation. Existing delivery, sandbox, Git, approval, and recovery proofs remain valuable and must not be discarded by the UI reorganization.
- **Development state:** This is a local-development-only Studio deployment. The author explicitly permitted purging and recreating its SQLite database; no application-level legacy-data preservation is required. Do not delete unrelated Git checkouts, private Pi session transcripts or Docker volumes based on that permission.
- **Scope vocabulary:** Story, Thread, Turn, Collection, Specialist assignment, Specialist review, Validated checkpoint, Reviewed checkpoint, Author choice, Author review, and Publication are canonical terms. Agent executors and controller receipts are internal.
- **Architectural rationale:** Threads—not Jobs or Conversations—own revision lineages, because a creative conversation must survive multiple arbitrary-scope requests while optional organization stays mutable. Deterministic gates plus adaptive semantic review distinguish safety from narrative judgment and avoid wasteful reviewer calls for trivial tasks.
- **Delivery plan:** Start with domain and controller contracts, then fresh persistence, multi-Turn orchestration, adaptive review, author interactions/events, responsive Story workspace, Review/Publish, and end-to-end certification. Do not treat passing screenshots or fixture-only unit tests as production completion.
- **Test seam decision:** The user already agreed to end-to-end Studio acceptance with a real-Pi certification and targeted contract tests during the design interview; the primary public Story/Thread action seam above implements that agreed testing intent.
