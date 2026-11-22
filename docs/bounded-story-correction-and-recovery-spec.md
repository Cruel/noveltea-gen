# Spec: Unified bounded correction and graph-wide protocol recovery for Story Turns

> Historical design for the earlier recovery implementation. **ADR 0006 supersedes its hard 2/3/12 semantic correction limits, mandatory fresh reviewer sessions and ordinary creative-finding identity rules.** For C02–C08, [generation-recovery-contract.md](generation-recovery-contract.md) (#238) is the sole normative technical contract; this document is preserved for historical context, not as a competing implementation specification.

## Problem Statement

Authors expect NovelTea to complete an approved Story objective without a manual restart whenever an agent makes a correctable mistake. The current production generation graph can repair certain negative specialist reviews, but recovery depends on the particular specialist and failure path. A malformed JSON response may get same-session retry in one specialist and immediately fail in another. A missing cross-domain prerequisite may be identified without a general way to authorize supporting work. Earlier reviewed results can later need correction, yet downstream acceptance is difficult to reconsider selectively. Many recoverable states become generic `blocked` outcomes, wasting usage and requiring author intervention.

A motivating case: Event and Choice work leave a Milestone incomplete, and Composition discovers the missing closeout. The expected behavior is source-bound prerequisite detection, controller authorization of the responsible specialist, verification of a small correction, selective downstream revalidation, and continuation in the *same* Turn. The design must not undermine isolated job worktrees, serialized writers, immutable Git/validation/review evidence, protected decisions, saved author instructions or budget controls.

The key architecture risk is overengineering: a separate recovery graph, duplicate review engine, independent resource meter, or full alternative checkpoint-state database would make reliability worse.

## Solution

Extend the **one existing goal-driven production LangGraph** with typed recoverable outcomes, a shared agent-response protocol retry helper, a *thin controller-owned Repair ledger* and controller-authorized corrective routing. A known structural prerequisite is checked before dispatch; true semantic defects are recorded and repaired within specialist authority or escalated to the orchestrator for a versioned, narrowly bounded cross-specialist corrective assignment. Previously reviewed work remains immutable historically, but may be superseded by new independently verified correction; only affected dependent work is revalidated.

Recoverable errors keep the Turn running. Author input, budget pauses, exhaustion and integrity failure are distinct, actionable results. The author sees succinct progress and may inspect source-linked evidence. An exhausted Turn can resume in the same Thread with new guidance or explicitly extended limits without resetting usage or attempts.

Do not replace the existing nine-node generation graph. Scheduling/preflight, specialist execution, independent review, verification/progress and recovery decision are **logical responsibilities**, not a mandate for five replacement nodes. Extend existing nodes and adapters; at most one general recovery-decision node may be justified if it centralizes typed routing. Protocol retry remains a helper inside an invocation, never a new graph node.

## User Stories

1. As an author, I want correctable specialist mistakes repaired automatically, so that I do not need to restart generation.
2. As an author, I want known missing Milestone prerequisites detected before Composition, so that no impossible writing call is attempted.
3. As an author, I want the responsible domain specialist to supply a missing prerequisite, so that write scope remains meaningful.
4. As an author, I want a defect found after a review to be repairable, so that earlier acceptance is not a permanent freeze.
5. As an author, I want immutable historical revisions and negative reviews preserved, so that changes remain auditable.
6. As an author, I want unaffected reviewed Story material retained, so that a small correction doesn't regenerate the whole Story.
7. As an author, I want only affected downstream work rechecked, so that validation and review resources are used appropriately.
8. As an author, I want routine correction in both Autonomous and Collaborative modes, so that participation mode doesn't change reliability.
9. As an author, I want automatic recovery visible as quiet execution activity, so that Chat isn't flooded with retry messages.
10. As an author, I want to inspect finding details, correction attempts and review outcomes, so that automatic repair remains understandable.
11. As an author, I want repair progress distinguished from author-required, exhausted and integrity-blocked states, so that action is unambiguous.
12. As an author, I want consequential creative changes and protected canon referred to me, so that automated repair does not silently reinterpret approval.
13. As an author, I want new steering instructions evaluated before the next correction attempt, so that obsolete work does not continue.
14. As an author, I want exhausted recovery to preserve eligible work and the original Thread, so that I can resume with new guidance.
15. As an author, I want to explicitly authorize additional recovery attempts while retaining all previous counts, so that extensions are accountable.
16. As an author, I want a resource pause to preserve the job, so that I can change permitted usage and resume safely.
17. As an author, I want the configured model to remain pinned, so that the system cannot silently change capability or consumption.
18. As an author, I want final completion to require objective fulfillment and discharged findings, so that an empty work queue never masks an incomplete Story.
19. As an orchestrator, I want findings bound to specific obligations and records, so that proposed corrections address the actual problem.
20. As an orchestrator, I want deterministic verification of specialist diagnoses, so that a mistaken claim does not trigger avoidable writes.
21. As an orchestrator, I want versioned corrective plans with causal dependencies, so that missing support can be scheduled in the right order.
22. As an orchestrator, I want the controller to authorize each corrective assignment, so that model proposals are not write grants.
23. As an orchestrator, I want confirmed repairs prioritized before dependent pending work, so that the defect isn't propagated.
24. As an orchestrator, I want later defects linked causally to the correction that introduced them, so that repair cascades are visible and finite.
25. As an orchestrator, I want oscillation and lack of progress detected, so that repeated ineffective edits escalate early.
26. As a specialist, I want bounded feedback in my original Pi session, so that my context is retained when I correct my own work.
27. As a specialist, I want out-of-authority requirements routed to orchestration, so that I am not asked to violate domain ownership.
28. As a specialist, I want concrete response-schema feedback after malformed JSON, so that I can repair reporting without rewriting Story files.
29. As a specialist, I want two further response attempts in the same conversation by default, so that ordinary formatting failures are recoverable.
30. As a specialist, I want format-only retries to have no write tools, so that existing edits cannot be accidentally changed.
31. As a specialist, I want Pi's normal automatic context compaction preserved, so that no extra context reset or needless compaction is imposed.
32. As a reviewer, I want a fresh read-only session for each substantive review, so that verdicts are independent of writer conversation state.
33. As a reviewer, I want the assignment, prior negative findings, attempts, diffs and current source, so that I can evaluate a correction fully.
34. As a reviewer, I want malformed verdicts fixed as protocol errors, so that reviewer execution failure is not blamed on the writer.
35. As a reviewer, I want a format-only correction to preserve substantive negative findings, so that review cannot be argued into approval.
36. As a reviewer, I want a bounded fresh independent adjudication of semantic disputes, so that mistaken verdicts can be challenged without endless debate.
37. As a controller, I want repair-finding identity stable across wording and commits, so that retries cannot reset budgets through rephrasing.
38. As a controller, I want independent local, dependency, infrastructure, protocol and Turn-wide attempt budgets, so that failure classes are accounted for correctly.
39. As a controller, I want a correction counted only when a completed revision is submitted for verification, so that unfinished calls do not consume semantic attempts.
40. As a controller, I want new downstream findings to consume the same Turn-wide ceiling, so that a chain of fixes cannot run forever.
41. As a controller, I want to reconcile interrupted Pi tool operations and Git state before any replay, so that unfinished writers are never duplicated.
42. As a controller, I want the job's existing single writer lock retained, so that no concurrent Story commit can advance HEAD behind a repair.
43. As a controller, I want historical checkpoint proofs checked against historical committed bytes, so that new dirty drafts cannot invalidate valid prior work.
44. As a controller, I want malformed-output retry counts persisted by invocation and response contract, so that crashes cannot grant more attempts.
45. As a controller, I want one bounded fresh-session fallback after protocol exhaustion, so that recovery remains possible but finite.
46. As a controller, I want fresh writer sessions restricted to missing report completion after reconciliation, so that corrected response formatting does not repeat filesystem writes.
47. As a controller, I want sensitive details excluded from validation feedback, so that model retries do not leak credentials or internal error stacks.
48. As a controller, I want source-bound correction authority checked against the actual current job HEAD at dispatch, so that stale queued assignments don't silently overwrite work.
49. As an operator, I want recorded recovery attempts and resource usage to survive restarts, so that operational limits cannot be bypassed by process churn.
50. As an operator, I want recovery paths certified through production start/resume/inspect behavior, so that tests cover the actual graph rather than an artificial alternative scheduler.
51. As an operator, I want both positive convergence and fail-closed integrity behavior tested, so that automated recovery cannot make unsafe progress.
52. As an operator, I want deterministic test scenarios before costly real-Pi Story runs, so that failures are reproducible and cheap to diagnose.
53. As an operator, I want existing checkpointed Threads explicitly supported or safely rejected, so that a new graph shape doesn't silently reinterpret persisted state.
54. As an operator, I want resource usage attributed to Turns while preserving job-wide budget authority, so that there is only one resource meter.

## Implementation Decisions

1. **Keep one production execution graph.** Extend scheduling, author-intake, specialist dispatch, independent review, committed-work verification and completion; keep existing idea/dependency paths. A small shared recovery decision may be a physical node if needed, not a parallel recovery graph.
2. **Typed failure contracts.** Distinguish protocol response failure, infrastructure failure, substantive Story defect, missing prerequisite, review dispute, pending author input, budget pause, exhausted correction and integrity failure. A specialist's prose does not establish authority or control transitions.
3. **Controller-only authority.** The orchestrator proposes source-bound, versioned corrective work; controller verifies author objective, paths, original scope, dependencies, protected decisions, model/skills pins and actual job HEAD before dispatch.
4. **Thin Repair ledger.** Persist finding ID/category/obligation/targets, causal predecessor, state, bounded attempts and references to existing assignment, review, Git and Pi receipts. The ledger must not duplicate canonical Story, full work plans, transcripts or historical checkpoint proofs.
5. **Finding identity.** Repeated reports of the same violated obligation/targets/category retain one identity regardless of wording or source commit. A genuine newly caused downstream defect is a distinct, causally linked finding.
6. **Semantic correction policy.** Allow an initial configurable two local corrections per finding, three cross-domain dependency cycles per finding, two infrastructure retries, and twelve completed agentic corrections per Turn. Escalate stagnation or oscillation earlier. Count correction only on completed submission for verification, not on a failed model call.
7. **Common protocol-retry wrapper.** For agent JSON, schema, required-field and required-read failures across planners, writers and reviewers, supply sanitized, field-specific feedback in the same Pi session with two further complete response attempts. Protocol attempts do not consume semantic correction counts or the Turn-wide semantic ceiling, but do consume normal resource budgets.
8. **Tool restriction on response repair.** Suppress all writer tools during format-only retry, allow authorized read-only tools for omitted evidence, and independently verify returned claims against actual files/receipts. A retry must not negate a previous independent negative verdict.
9. **Bounded fresh invocation.** After three responses in the original invocation, permit at most one fresh-session protocol recovery invocation for that same contract, itself limited to two additional responses. A writer must be reconciled first; fresh execution completes missing reporting, not writing. Another exhaustion stops with source-linked diagnostics.
10. **Pi continuity and review independence.** Local semantic repairs reuse the original writer Pi session; distinct substantive reviews start fresh, read-only Pi sessions with prior failure context. Do not add routine compaction on top of Pi's built-in threshold and overflow handling. Truly unrecoverable context exhaustion may use controlled source-linked handoff without resetting counts.
11. **Dispute rules.** Controller verifies deterministic claims first; disputed semantics may get bounded independent review with source-linked opposing evidence; no agent can self-approve, soften a sealed failed verdict, or reopen arbitrary write scopes.
12. **Preflight prerequisites.** Verify known assignment/source obligations before dispatch; route missing structural prerequisites to the proper domain instead of paying for an impossible downstream invocation. Avoid Story-specific exception catalogs.
13. **Dependency-aware revalidation.** Determine impacted consumers from existing versioned work plans and source/assignment relationships; revalidate only affected work. Retain unaffected reviewed work and immutable historical review evidence.
14. **Serialized mutations.** Retain the per-job Git worktree and single mutation lane. Read-only planning/review may overlap if safe. Repairs take priority over dependent work at the next safe boundary. No speculative concurrent-writer/rebase subsystem.
15. **Idempotent recovery.** Save admission, invocation, draft, validation, commit and review phase references. Compare persisted Pi session/tool history, current Git state, source receipts and graph checkpoint after a crash; never replay an uncertain writer, double-count or duplicate commits. Historical source checks use historical committed bytes.
16. **Execution status.** Correctable findings stay inside a running Turn. Author decisions and job resource limits pause. Exhaustion preserves evidence and offers guided continuation. Untrustworthy authority or state fails closed. Required defects never count as success.
17. **Author steering.** Process newer author direction at the next safe boundary; stop or reconcile active writers before changing work. Preserve independently verified work; material objective changes go through the normal approval and plan revision path.
18. **Resource ownership.** Reuse job-level cost, model-call, step, time and token usage controls. Maintain separate per-Turn correction attempts and Turn-attributed resource reporting, but not a second billing or usage database. Hard token budgets are not required.
19. **Completion gate.** Require the requested objective/delivery depth, all required findings resolved, necessary downstream revalidation, current native validation, fresh mandatory semantic review and protected/author approvals against the current Story revision.
20. **UX.** Provide unobtrusive activity status, source-bound finding/attempt inspection, and actionable pause/exhaustion. No separate recovery experience or routine Chat spam.
21. **Checkpoint compatibility.** Store only routing/ledger references in new graph channels. Existing persisted Threads must preserve their prior meaning or receive an explicit safe reconciliation boundary; don't silently upgrade historical evidence.
22. **Size constraint.** Reuse the current graph, existing specialist repair adapters, independent reviews, native validation, dependency inventory, Git checkpoint, Pi session and budget infrastructure. Prohibit a parallel recovery engine, duplicate dependency graph, separate review authority or per-failure-type execution graph.
23. **Relationship to prior work.** Extend ADR 0002's goal-driven orchestration and ADR 0005's recovery policy; this is a generalized recovery specification rather than a replacement for the existing orchestration spec or its certification tickets.

## Testing Decisions

1. **Preferred highest seam:** deterministic production graph start/resume/inspect and final completion using ordinary trusted controller, job, Git and review receipts. Assert observable behavior, not internal helper ordering. This matches the author-approved certification approach.
2. **Second seam if needed:** the common Pi invocation/response-contract wrapper using deterministic fake model replies and actual task validation, checking retries, session continuity, tool isolation and limits. Avoid one testing seam per specialist.
3. Inject a missing Milestone/Choice closeout and prove prerequisite preflight → authorized owner correction → native/review verification → continued Composition without a full Story restart.
4. Inject local semantic error and same-session correction; verify fresh independent review, preserved scope and completed-attempt count.
5. Inject cross-domain missing Character/Event/Choice context; verify correct narrow supporting assignment, causal order and no authorization expansion.
6. Correct a previously reviewed upstream commit and test selective downstream revalidation versus unaffected carry-forward, preserving historical review evidence.
7. Test repeated wording of one finding and a truly new downstream defect; verify deduplication, causal linking and preserved overall ceiling.
8. Test stagnant identical edits, oscillating revisions and independent review disputes; verify finite escalation and no self-approval.
9. Test malformed JSON, schema mismatch, required-field omission, required-read omission and failed reviewer output across planner/writer/reviewer roles; verify accurate sanitized feedback and unchanged source files during protocol-only correction.
10. Test two same-session retries, one bounded fresh invocation, final protocol exhaustion and persistence of counts across crashes; ensure protocol attempts are not semantic attempts.
11. Test reviewer provenance-only corrections against an existing negative finding; verify that changing response format never changes substantive rejection.
12. Crash before and after admission, assistant response, validation, Git publication and review persistence. Reconcile each more than once; prove no duplicate commits, tool replays or attempt charges.
13. Test dirty current worktree while verifying a historical checkpoint, plus deliberate proof/source/approval corruption that must fail closed.
14. Test independent local, dependency, infrastructure, protocol, global Turn and job resource budget exhaustion; verify exact status, counts, and explicit authorized budget extension without resetting usage.
15. Test author steering while a repair is pending, protected-scope changes, explicit approvals, job cancellation, safe boundaries and resumed objective fidelity.
16. Assert final completion is refused while any required finding, revalidation, native validation, review or author decision remains pending, and accepted when discharged.
17. Exercise both creative modes, new and existing Story goals, Thread restart, checkpoint compatibility and correct durable status display.
18. Reuse existing production graph fixtures, negative-review repair tests, independent assurance checks, job budget tests and Studio activity/Thread tests; do not create a second fake orchestration engine.
19. Gate expensive real-Pi certification on deterministic and native success; opt in to a small real-Pi set (local, cross-domain, completion) before rerunning the full autonomous Story. Report fixture and real model evidence separately; no cloud trace upload by default.

## Out of Scope

- Replacing the one production LangGraph or introducing a second autonomous/collaborative/recovery scheduler.
- Reimplementing Pi compaction, Git worktree isolation, validation, reviews or protected author approvals.
- Automatic model/provider switching, unlimited retries or silent relaxation of mandatory Story obligations.
- A second independent dependency DAG, shared-write concurrency and speculative commit rebasing.
- Full rewrite of the Story Chat/Jobs UI, raw publication of Pi transcripts or other private context.
- Unrelated baseline discovery, external manuscript import, or Story enrichment outside approved objective.
- Full expensive real-Pi Story reruns before deterministic recovery testing passes.
- Implementation patches as part of this specification; implementation is split into tickets afterward.

## Further Notes

**Source decisions:** ADR 0002 (single goal-driven orchestrator), ADR 0005 (bounded correction and recovery), and the root domain glossary. This spec covers the broader generalized failure path beyond the original orchestration issue #144 and the specific adaptive certification #181.

**Default limits:** local semantic corrections 2; cross-domain dependency cycles 3; infrastructure retries 2; completed agentic Turn-wide corrections 12. Invalid agent output gets two additional same-session attempts, then at most one new session for the same response contract, also with two additional attempts. All counters and source evidence are persisted. Review disputes are bounded, and exhaustion never confers approval.

**Behavioral flow:** schedule/preflight → bounded Pi specialist invocation → native validation and independent reviewer → progress reconciliation. A recoverable semantic finding → controller's recovery decision → same specialist correction or authorized work-plan revision → resume schedule. A protocol output error is handled inside the invoking node. Author/budget pauses and integrity/exhaustion stops preserve receipts.

**Status:** Design specification only. Follow with `to-tickets` after review. Existing issue acceptance criteria remain valid; this spec does not silently supersede other open work.
