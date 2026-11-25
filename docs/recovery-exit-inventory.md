# Production Story-generation recovery exit inventory (#225)

> Historical #225 audit snapshot. The **single normative recovery contract** for the C02–C08 consolidation is [generation-recovery-contract.md](generation-recovery-contract.md) (#238). The older descriptions of independent fencing and advisory-only diagnosis document the pre-consolidation implementation; they must not be mistaken for the target recovery behavior.

This inventory covers the **single** production `createGenerationGraph` in
`src/generation.ts` and the public CLI `runStoryGeneration` start, resume,
and inspect entrypoints. It implements the exit audit of spec #216; ADR 0005
governs evidence and authority, as amended by ADR 0006 for persistent review
cycles. A safe stop is **not** an assertion that a Story is complete.

## Shared dispositions

- **Assessment**: an unresolved execution exception or failed specialist result
  records `operationRecovery` with an operation-specific, versioned check,
  source job/Thread/Turn/plan/HEAD, evidence reference and proposed safe action.
  The graph checks this state at every transition before another dispatch.
  `assess_recovery` authenticates the checkpoint and author control. Unknown
  or ambiguous writer effects are **fenced**, not blindly replayed. A clean,
  settled local specialist failure can continue only dependency-independent
  units after matching the original failed assignment, unchanged Git HEAD and
  persisted blocked inventory. A Foundation or World commit published before
  finalization is reconciled only through its original specialist, verified
  original receipt and exact Git proof.
- **Proven local continuation**: failed adaptive format receipts are corrected
  through their pinned original session; a matching verifier fix rechecks its
  *original* response. Verified read-only scheduling/intake may reconcile and
  continue. A deferred idea may continue independent work only after verifying
  the original no-write placement receipt, inbox and unchanged Git HEAD.
- **Domain recovery**: legitimate Event prerequisites, negative independent
  reviews, cross-owner dependencies, and affected dependent revalidations follow
  their separately authorized controllers. The reviewer never grants a write or
  approves itself. A pending causal amendment fences unrelated dispatch.
- **Intentional stop**: author pause/cancel/question, protected scope approval,
  known protocol/resource exhaustion, genuinely unresolved semantic repairs,
  uncertain dirty writer effects, and missing/tampered controller proof remain
  paused, cancelled, or blocked as appropriate. These may be resumed only
  through their existing authenticated workflow; they are not recoverable by
  an unconditional new writer.
- **Completion**: only an authenticated, current assignment inventory and
  completed job report, required native validation, independent reviews,
  affected-dependent coverage and author approvals can pass. An unexplained
  well-evidenced final failure gets at most one read-only diagnosis per
  unchanged evidence state. Missing proofs cannot be diagnosed into success.

## Node and entrypoint audit

| Boundary / exit | Disposition | Deterministic evidence |
| --- | --- | --- |
| **Start / schedule**: invalid request, unavailable job, missing Thread identity or pin | Pre-admission integrity refusal if job or request identity cannot be trusted; otherwise checkpointed `scheduling` assessment. Never repin or invent an objective plan. | `test/generation.test.ts`: failed scheduling on resume; lost orchestrator selection; `test/recovery-compatibility.test.ts` |
| **Resume preflight**: original work-item checkpoint reconciliation fails | `resume-reconciliation` assessment, fenced until original source/effects are examined. Explicit pause/cancel remains a control, not recovery. | `test/generation.test.ts`: committed World/Character checkpoint reconciliation, unexpected edits, preserved incomplete/tampered proof; #225 restart assertions |
| **Inspect**: state, selection, checkpoint, reviewer or plan proof is invalid | Strict read-only report or integrity refusal. No specialist dispatch, reviewer/model prompt, budget reset, ledger mutation or checkpoint finalization. | `test/generation.test.ts`: inspection of invalid correction receipts, dirty work and source-proof tampering; `test/milestone-review-diagnostic-recovery.test.ts` |
| **Author-update intake**: exception or processing error | `author-update-intake` assessment; recheck the same saved message and acknowledgment under lock, without repeating a writer. Saved author questions/reviews and author controls are intentional stops. | `test/generation.test.ts`: thrown intake start/inspect/resume and repaired receipt |
| **Adaptive schedule/admission**: malformed response, exhausted correction, later verifier failure | Shared original-session protocol correction; typed exhaustion; new admission failure after a compatible fix gets a distinct `adaptive-admission` assessment, never a second planner. | `test/adaptive-protocol-graph.test.ts`, `test/issue-191-protocol-recovery.test.ts`, `test/issue-195-protocol-restart.test.ts`; #218/#223 certification |
| **Deferred idea dispatch/verify**: exception, inconsistent commit/status, intentional deferral | `idea-integration` / `idea-verification` assessment. Ambiguous writer effects fenced; verified no-write deferral may continue independently. | `test/generation.test.ts`: unverified idea dispatch on resume, rejected placement, intentional reassessment |
| **Specialist dispatch/result**: exception, nonaccepted status, dirty active job | `specialist-dispatch` or `specialist-result` assessment before other assignments. Clean, unchanged-HEAD local failures may proceed only to independent units without retry; postcommit Foundation/World recovery needs a source-authenticated original receipt. R02 routes a current-format pending Foundation only to its original child after source/plan/control checks; scoped metadata and tool-free protocol correction use the original Pi session and sealed effect receipts, not a new scheduler. Settled terminal protocol exhaustion and nonconvergence return child `unresolved` and source-authenticated `specialist-result` to the same assessor; the former yields typed `exhausted`, the latter independent read-only diagnosis. Missing or altered original effects remain inspection fences. Explicit `dependency-required` and sealed Event no-write prerequisite go to their domain controller. `review-handoff` reconciles the existing checkpoint, not a new writer. | `test/generation.test.ts`: #225 unaccepted result, #225 dirty active specialist, clean local cluster continuation, crash before World/Creative Direction finalization, Event prerequisite, sealed causal amendment |
| **Focus and Composition prerequisite amendment**: missing proof or exception | `dependency-amendment` assessment; never advance Composition without a verified correction and independent downstream checks. A protected/author-required amendment is a named author stop. | `test/generation.test.ts`: #225 failed amendment, focused plan amendment, causal replan and cross-Milestone prerequisites; #221 tests |
| **Independent assignment review**: transport/receipt exception versus genuine negative verdict | `independent-review` assessment for errors; verified negative verdict remains negative through the persistent original writer and separate reviewer. Author choice/escalation and protected prerequisite are intentional stops; pending downstream revalidation cannot be skipped. | `test/generation.test.ts`: #225 thrown independent review; original-writer repair, other-owner refusal; `test/milestone-review-diagnostic-recovery.test.ts`; #219/#220/#221 |
| **Committed work verification**: absent/unaccepted result or failed native, Git, plan or review proof | `specialist-result` returned-failure or `commit-verification` exception assessment. Only a verified and reviewed checkpoint advances the inventory and cursor; safe-boundary pause is intentional. | `test/generation.test.ts`: #225 unaccepted result, source tampering and corrected checkpoint recovery; `test/recovery-fork-review-coverage.test.ts` |
| **Completion decision**: incomplete scope, unresolved finding, missing review/approval, unsafe source, thrown final check | Known findings escalate without asserting completion; an unexplained trusted failure enters bounded read-only diagnosis. Exceptions or contradictory positive reports enter `completion-verification` assessment. Missing eligible checkpoint is an explicit integrity stop. | `test/generation.test.ts`: #225 invalid completion preflight, incomplete fixture generation, negative review; `test/unknown-recovery-diagnostic.test.ts`; `test/new-story-certification.test.ts` |
| **Successful terminal exit**: final report completed and inventory verified | `completed` only after the current verified HEAD, required review and selective dependent revalidation, original objective and author controls agree. | `test/generation.test.ts` and `test/new-story-certification.test.ts`; `test/recovery-fork-review-coverage.test.ts` |

## R14 (#260) — current Discovery, handoff and execution cutover audit

This extends the normative [#246](https://github.com/Cruel/noveltea-gen/issues/246) / ADR 0007 contract. The existing Generation node/adapter gate remains in place; the R14 AST gate additionally fingerprints the following production Studio function bodies (including nested callbacks, throws, returned statuses and graph edges). A changed fingerprint requires source/effect review, not automatic baseline regeneration.

| Boundary / source | Disposition and required proof | Qualification |
| --- | --- | --- |
| [Discovery parent](../web/src/lib/discovery-graph.server.ts) `discoveryGraph` | Keep. Authenticate operation identity before execute; only genuine pending author interrupt accepts resume; stale input/identity/receipt disagreement fences. Approved gate reaches END; reconciliation advances only a settled receipt or referential task. | Story Chat SQLite persistence/reconciliation; PostgreSQL variant requires configured test database. |
| [Story Chat entry](../web/src/lib/story-chat-discovery.server.ts) `storyChatDiscoveryRequest`, `beginStoryChatDiscovery` | Keep. Authenticate owner and original Chat/Turn; reject wrong owner, stale/duplicate requests before model effects. | Story Chat integration. |
| [Discovery adapter](../web/src/lib/onboarding-pi.server.ts) `onboardingPiRequest`, `realInference`, `openDiscoveryGraph`, `reconcileDiscoveryGraph` | Adapt. A started but unsealed invocation is not replayable; settled responses reauthenticate original source/session, then validate format/provenance and independent Review. Resource stop pauses; unsafe original effects fence; independently established nonconvergence remains unresolved. Retire the fixed provenance diagnostic count; use shared Review trigger plus repeat-source gate. | Onboarding tests: exact-source rejection, changed-wording nonprogress, unchanged-source stop, independently admitted replacement and negative replacement, no implicit approval. Story Chat tests: consecutive Luna defects, multiple materially improving repairs, interrupted writer/correction checkpoints and post-child-END/pre-parent-CAS failure with no repeated writer response. |
| [Discovery evidence](../web/src/lib/discovery-evidence.server.ts) `createDiscoveryEvidence`, `discoveryEvidence`, `readDiscoveryResponse`, `reopenDiscoveryPiReference`, `meterDiscoveryAttempts` | Keep original effect and transcript receipts; refuse mismatched/unsealed proof; cumulative budget counts original attempts rather than retry invocations. | Onboarding and Story Chat interruption/usage tests. |
| [Approval](../web/src/lib/onboarding-pi.server.ts) `settleInterruptedApproval`; [Chat receipt](../src/chat-approved-foundation.ts) | Keep exact accepted proposal/owner/approval proof; failed or interrupted approval does not grant Generation writing. Retire repository approval execution and draft-status Chat receipt acceptance. | Story Chat exact proposal and interrupted approval tests; `chat-approved-foundation.test.ts` rejects obsolete receipts without rewriting them. |
| [Repository bootstrap](../web/src/lib/github-initialize.server.ts), [GitLab bootstrap](../web/src/lib/gitlab-initialize.server.ts), [retired API](../web/src/routes/api/onboarding.pi.ts) | Retire workspace-only live inference and approval. Provider initialization rejects historical approval and model-shaped decisions before writes; title-only setup creates an unapproved draft, while manual author canon retains native validation. The only live Discovery is the original authenticated Story Chat Turn. | Provider initialization tests, onboarding Pi rejection test, Story Chat integration. |
| [Handoff effects](../web/src/lib/discovery-handoff-effects.server.ts) `readHandoffEffect`, `handoffEffects`; [approved continuation](../web/src/lib/story-approved-continuation.server.ts) `admitWholeApprovedStory`, `continueApprovedStoryChat` | Keep original receipt, verified effect or explicit blocked/queued outcome; do not recreate original Job/Turn, remeter or repeat ambiguous Git/queue effects. | Approved continuation and Story Chat fault/duplicate tests. |
| [Generation node admission](../src/generation.ts) `recoveryNode`, [owner](../src/generation-owner.ts), [inventory](../src/generation-plan.ts), [Composition prerequisite](../src/cross-domain-prerequisite-controller.ts) | Retire historical owner digest matches, unversioned inventory reconciliation and missing Turn prerequisite bypass. Obsolete inventory is an integrity refusal at every resumed node before effects (`recoveryNode/throw#2`, fingerprint `f7ec8691c6e8a121`). Preserve history for read-only inspection; never upgrade old executable state. | `generation-owner-request-order.test.ts`, `recovery-cutover.test.ts`, `pending-work-amendments.test.ts`, `generation-recovery-graph.test.ts`. |
| [Shared Review policy](../src/review-cycle.ts) and Architecture, Story/Milestone Blueprint, Composition, Discovery adapters | Adapt the diagnostic trigger to the last settled assessment boundary instead of a fixed diagnostic count. Retain material-progress, repeat-source, independent negative Review, scope and budget constraints. Composition reconstruction checks diagnostic evidence against original sources and history. | Architecture/Blueprint/Composition policy tests and Discovery convergence tests. |

### Direct model consumers

The [direct consumer AST gate](../test/generation-model-consumer-coverage.test.ts)
inventories top-level owners of Pi session creation, direct prompts and known
response-recovery calls across both production source trees. It detects a new
owner or a changed owner body (even if invocation counts are unchanged);
aliased imports are included. This supplements, not replaces, the graph-exit
gate. The fingerprint baseline records current code including gaps, not
permission to retain those gaps.

| Consumer family / source | Disposition |
| --- | --- |
| `adaptive-planner.ts`, `adaptive-protocol.ts`, `orchestrator-planner.ts`, `dependency-planner.ts`, `idea-placement.ts` | Preserve original scoped planning/placement evidence and the protocol adapter; audit each exhaustion, negative result, and admission failure at its parent boundary. |
| `foundation.ts`, `character-world-specialist.ts`, `event-specialist.ts`, `interactive-specialist.ts`, `composition-specialist.ts`, `assignment-metadata-recovery.ts` | R14A: Foundation uses the checkpointed child round interface; the generic Foundation dispatch and whole-loop call are removed. Preserve source-bound writer and metadata receipts. Remaining specialist callers of the temporary whole-loop adapter require migration; standalone obsolete entrypoints require R14K cutover review. |
| `architecture-specialist.ts`, `architecture-draft-review.ts`, `architecture.ts` | R14F (#266): canonical Architecture uses the shared assignment invoke/verify/correct transitions. Tool-free causal-order format recovery, native metadata and provenance verification, and exact-draft precommit Review produce shared writer-round settlements or correction grants. A settled negative verdict reopens the original reviewer; a started but unsettled effect fences. Parent routing for the original pending Architecture effect is reviewed at `4cd1b9be23e93fec:G`. Production sandbox tests cover sequential native/source corrections, productive precommit Review, settled-review replay, five injected parent checkpoint-loss windows and a nonproductive Review reaching the existing independent diagnosis. Recovered publication reauthenticates the complete original commit effect and accepted reviewer transcript prefixes. |
| `architecture-blueprint.ts`, `milestone-blueprint.ts`, `architecture.ts`, `event-work.ts` | R14G (#267): retire both private multi-round draft/Review loops in favor of the shared child. Each bounded transition verifies the original source, assignment and sealed prior effect. Independent approval pins remain private and cannot replace native/Git or downstream Review gates. |
| `blueprint-reassessment.ts`, `generation.ts`, `generation-operation-strategy.ts`, `generation-recovery-resolution.ts` | The typed negative Review handoff retains the active original assignment at the existing assessor. The source-bound review-cycle decision grants only private Blueprint reassessment, never the canonical writer. Historical discharge verifies the exact original/archived approval pin; unknown effects fence. |
| `focused-work.ts` | Remaining focused-work orchestration is outside R14G. |
| `narrative-review-specialist.ts`, `dependent-correction-specialist.ts`, `cross-domain-closeout-specialist.ts`, `rejected-review-repair.ts`, `unknown-recovery-diagnostic.ts` | Preserve independent reviewer/repair/diagnostic scope and original evidence; audit returned failures and throws through parent assessment. |
| `response-contract-recovery.ts`, `non-specialist-protocol.ts`, `pinned-skill-reads.ts`, `specialist-manifest.ts`, `story-interruption.ts` | Keep shared low-level protocol/evidence/control adapters; distinguish safe read-only correction from writer or semantic authority. |
| `web/src/lib/onboarding-pi.server.ts`, `web/src/agent-runner.ts`, `web/src/lib/pi-credentials.server.ts` | Discovery/handoff and persisted worker paths retain authenticated operation identity; credential runtime is transport only. |
| `demo.ts`, `pi.ts` | Inventory separate demo/delegation graph adapters, not evidence that Story Generation recovery is certified. They must not become alternate Story execution entrypoints. |

This is an incremental R14 audit, **not universal certification**. The older Generation matrix above is historical. The direct-call inventory is not a transitive control-flow proof. Further audit must trace every output consumer to its actual parent/child invocation and terminal-effect route and retire remaining competing workflow/recovery paths. Verify actual production nested author interruption, complete Postgres and live Luna/new-Story certification, and the public inspection/status contract before closing #260.

## Certification scope and nonclaims

The matrix above uses real disposable Git repositories, the actual production
graph and persisted LangGraph checkpoints, with fixture or deterministic Pi
transport boundaries. It tests **both** positive continuation and forbidden
effects: no repeated commit/writer/reviewer when the source is uncertain, no
auto-reset of a correction allowance, no progress through dirty or forged
proofs, and no incomplete Story success. The targeted #225 tests use the
public CLI for process-restart inspect/resume after checkpointed graph failures.

Other deterministic protocol and cross-specialist certification belongs to
**#197**, including its broader role/semantics/resource matrix. Full opt-in
live end-to-end Story generation belongs separately to **#181**. Passing these
deterministic exits is **not** evidence of a fresh completed live #181 Story,
and no live Pi usage is claimed by this inventory.

### R14A Foundation writer exit/consumer audit (#261)

- [Generation](../src/generation.ts) `runFoundationAssignmentChild`: every original/metadata correction dispatch uses a child transition with synchronous checkpoint durability; each pending node checks current assignment, plan, author control and source. The generic Foundation branch of `dispatch` refuses execution. Integrity exceptions use the existing parent specialist-dispatch assessment; authenticated exhaustion/nonconvergence use original specialist-result proof.
- [Foundation](../src/foundation.ts) `runFoundationJob`, `piAuthor`, `executeFoundationGraph`: preserve the original Pi session, writer lock, validation, commit and effect reconciliation. `writer-round` returns without committing or processing post-work author updates; only accepted verification may publish. Unadmitted standalone Pi writing is refused. Approved Chat materialization is not a Pi writer.
- [Shared receipt service](../src/assignment-metadata-recovery.ts) `executeAssignmentRound`, `runAssignmentReceipts`: invoke/reconcile one round, verify actual defects and seal next grant, or execute the exact admitted grant. Local format correction remains tool-free; historical receipts reconstruct progress without dispatch. `recoverSubmittedAssignment` was a temporary adapter for unmigrated lanes; R14K removes it and requires an explicit round command.
- [Shared child](../src/generation-assignment-lifecycle.ts) `createAssignmentLifecycleGraph`: verification may publish the authoritative committed submission alongside its disposition, rather than promoting the preceding draft reference. Pending verification checks submission identity; the parent still independently reviews and reconciles commit/plan.
- Proof gates: [round and source AST](../test/generation-recovery-coverage.test.ts), [model consumer AST](../test/generation-model-consumer-coverage.test.ts), and [production-shaped Generation regression](../test/generation.test.ts). See the [R14A contract](generation-recovery-contract.md#r14a-261--foundation-substantive-writer-rounds).

### R14B Foundation independent Review exit/consumer audit (#262)

- [Generation](../src/generation.ts) `runFoundationAssignmentChild`: the original parent admission is rechecked at each pending child transition. A negative original submission or failed native successor returns a source-bound corrective grant; `correct_original` performs one original-writer correction and publishes a committed submission; `verify_original` independently rereviews the exact successor and admits another round only on verified progress. A typed assessment/control/fence preserves the original Case and failed root. Passing successors return to parent discharge and Work-plan verification.
- [Repair service](../src/rejected-review-repair.ts) `rejectedRepairOperations`, `executeReviewRound`, `reviewRoundGrant`, `attestNegativeReviewRound`: keep the existing repair/ledger/claim, validation, Git and independent Review operations; split ordinary Foundation execution into bounded child transitions. Reauthenticate original reviewer transcript prefixes and exact findings; a grant or submission reference is not permission by itself. No new case, retry counter or scheduler.
- `advanceRejectedRepair` and `independentAssignmentBoundary`: refuse Foundation whole-cycle corrective execution. The former remains only for unmigrated lanes. The latter's new integrity throw precedes that dispatch; it does not alter other-owner/global Review routing.
- `inspectRejectedRepair` and `beginRejectedRepair`: retain exact source, negative verdict, assignment, predecessor, path scope and native commit proofs. Reuse the already-attested predecessor and same-inspection checkpoint reads instead of duplicated recursive traversals; no cross-transition cache.
- Proof: [R14B contract](generation-recovery-contract.md#r14b-262--foundation-independent-review-rounds), [production-shaped Review and crash cases](../test/generation.test.ts), [source-linked AST gate](../test/generation-recovery-coverage.test.ts). Nonlocal assessment/author revisions retain their existing parent strategy. Later migrations must not reintroduce Foundation's retired whole-loop path.

- R14A/B follow-up: [shared Review transitions](../src/generation-review-round.ts) interpret native-rejected, native-round and committed submissions. [Repair service](../src/rejected-review-repair.ts) `prepareRepairWriter` reopens the original scoped session; `runNativeRepairRound` uses `executeAssignmentRound` and the existing budget/receipts. `nativeMetadataDefects` consumes only native diagnostics; protection findings and `protected-record-unverified` fence. Gen never parses rejected Story YAML. `inspectNativeReviewFailure`, `originalAssignmentFailure`, `selectOperationStrategy` and `executeOperationStrategy` bind native terminal evidence to the original Review Case; parent `recoveryNode` reauthenticates the handoff and terminal on restart. No new parent exit or disposition class. The actual protected rejection and queued author update after accepted rereview restart are covered by production-shaped tests.

### Production adapter traceability (#274, partial)

The following is an item-level status report, not integrated qualification. `generation.test.ts` uses scripted Pi transport over the production SQLite graph, native validator and Git worktree. Historical commits identify unchanged implementations; they are not evidence that a newly requested path ran.

| Transferred ticket | Production boundary and evidence | Remaining acceptance |
| --- | --- | --- |
| #252 — required interaction vs omission, composite no-write | `runInteractiveAssignmentChildren`, `resolveAdaptiveNoWriteSupersession` (b079f8b, 2a1cfc4). The `prospective` graph scenario consumes independently verified support, then writes the real Choice/Puzzle and Composition; it does **not** start from an Interactive refusal. | Required interaction after declined omission; authenticated Choice **and** Puzzle wrong-owner support followed by original continuation. |
| #253 — R07 progression and focused scope | `runNarrativeAssignmentChild`, `historicalMilestoneHandoff`, `preflightCompositionBoundary`. `prospective` now runs from a Character predecessor through Event, Interactive, closeout, Composition and ordinary completion on the original Turn. `focused-generation.test.ts` covers the existing bounded focused path (38e006d). | Missing World/Event/Blueprint obligations and multiple owners in that progression; selective revalidation after upstream corrections beyond this Character case. |
| #254 — R08 historical approval, changed scope and revalidation | `readEventSourceBlueprint`, `historicalMilestoneHandoff`, `correctPendingBlueprint`: a writer base may differ from its original approval only at the exact independently verified predecessor tip. `prospective` rejects missing lineage and substituted pins, and actually consumes the historical approval downstream. Existing Architecture flow: 976b108, c22ab30. | Pre-dispatch challenge to previously reviewed canon, authorized upstream edit, new independent Review and affected-only revalidation in one Turn. |
| #264 — Event no-write, original session and focused Review | Removed `routeEventPrerequisite` and the fresh-session branch from `specialist_dispatch` and `runEventWorkItem`. `future-choice` and `scene-evidence` recover in the original round, survive a dropped checkpoint, run independent negative Review and repair, and return to ordinary scheduling. `settled-no-write` and `stale-choice-finding` keep the original no-write receipt across restart: no Event replay, no Git commit, no invented support. | General ambiguous or other-owner no-write planning and execution. A clean report without a verified local reference is evidence for assessment, not itself a support grant. |
| #265 — Composition readiness, correction and rereview | `runCompositionWorkItem`, `verifyCompositionReviewOrigin` (c17331d, 74f34fb). `prospective` consumes the supported Event through independently reviewed Composition. No change to editorial or publication authority. | Missing upstream owner admission/suspension/reentry and selective verification of previously composed material. |
| #266 — canonical Architecture precommit and source gates | `runArchitectureAssignmentChild` and `architecture.ts` (7a8f0db, be6871f, 25f59cd). `prospective` uses real precommit Architecture; no new defect shown in its writer. | Plan/revision/Review requalification in the canonical upstream correction scenario; successful initial Architecture is not that test. |
| #267 — Story/Milestone Blueprint discovery and lineage | `inspectBlueprintPredecessorCompletion` and `readEventSourceBlueprint` distinguish historical approval from supported execution. `inspectCausalAmendment` consumes the same gate. `correctPendingBlueprint` still requires an independent Event Review for its postcommit challenge; no pre-dispatch Review is fabricated. | Accounts discovering an earlier committed Event that spans later search/recovery/testimony: prospective redesign alone must not discharge that defect. Both Blueprint lanes and their consumers still require upstream correction qualification. |

Foundation, World/Character, planning/idea, Discovery and global Review are not certified by the Event tests. The cross-adapter residual-policy audit remains open. No additional scheduler or active Case store is introduced.

### R14D Event and Focused boundaries (#264)

- [Event specialist](../src/event-specialist.ts) now calls `executeAssignmentRound` once per shared child command. Its session and domain-native verifier are unchanged; a pending round returns without publishing a commit.
- [Event work item](../src/event-work.ts) pins the parent logical key, refuses an unadmitted Pi write, and returns a nonterminal writer-round reference. [Narrative child](../src/generation.ts) authenticates that reference, schedules the exact admitted correction, and retains the original native/Review completion gate.
- The model consumer and narrative child fingerprints cover this changed boundary. [Sandboxed Event test](../test/event-protocol-graph.test.ts) checks no commit before verification, refusal of a foreign assignment key and no duplicate model effects after replay.
- [Focused work](../src/focused-work.ts) pins and authenticates its original invocation and settled no-write proof. The shared child verifies the exact approved diff and native evidence before publication. Its prerequisite continuation retains the original session and logical identity; independently verified support is parent authority.
- [Generation](../src/generation.ts) projects Event/Focused writer settlements and negative Review through the existing shared round children. [Review repair](../src/rejected-review-repair.ts) returns authenticated other-owner evidence to the parent, and [dependency state](../src/dependency-state.ts) verifies the passing original Event repair lineage instead of imposing a local two-round ceiling.
- [Focused regression](../test/focused-generation.test.ts) exercises original writer and Review prerequisite paths, rejects supporting no-write, and loses the settled corrective child output before SQLite checkpoint; restart must not repeat the original edit or corrective model response. The new receipt/source and Review-reentry gates are explicitly fingerprinted.
- [Supporting work](../src/dependency-work.ts) now uses the same invoke/verify/correct child for both no-write and Review prerequisites, with exact plan/HEAD/owner reconciliation and no standalone Pi authoring fallback. [Shared round-reference codec](../src/generation-writer-round.ts) is used by the parent and support adapters. [Focused work](../src/focused-work.ts) refuses all unadmitted Pi invocations.
- [Corrective Event fixtures](../src/event-work.ts) substitute deterministic transport in the shared round service; the old local retry ceiling is removed. Fixture receipts are not Pi assurance. The native validator, manifest checking and Git proof are still authoritative.
- [Production SQLite Event regressions](../test/generation.test.ts) cover original native correction, independently negative Review, same-writer repair, same-reviewer pass, optional separately authorized Character support and next Interactive scheduling. The Focused regression also loses returned-END and supporting commit outputs and proves exact continuation without duplicate effects. [Authority controls](../test/event-review-character-dependency.test.ts) and [cross-owner controls](../test/review-other-owner-dependency.test.ts) cover stale source/plan, owner/path and protected expansion; the Event work tests cover pause, lock and invalid no-write. Source fingerprints cover the new support and fixture adapters, the shared codec, and the Review projection's distinction between native work-item and sealed Turn assignment ID. No change to Composition or Blueprint orchestration is claimed.

### R14C World/Character and Choice/Puzzle (#263)

- [World/Character specialist](../src/character-world-specialist.ts) and [Interactive specialist](../src/interactive-specialist.ts): one shared assignment-round command; pending settlement returns without publication. The corresponding domain work adapters bind the logical key into the invocation digest, reject a foreign key/proof, and retain native, scope, manifest and Git evidence.
- [Generation](../src/generation.ts): `runCharacterWorldAssignmentChild` and `runInteractiveAssignmentChildren` use the existing child invoke/verify/correct phases with synchronous checkpoints, including the native-verified submission before independent Review; `subunitRoundProof` and `subunitWriterResult` exchange exact settled/grant references. `subunitReviewTransitions` uses the shared R14B transitions and `subunitReviewStop` authenticates typed parent assessment, prerequisite and control boundaries. The old whole-loop repair is refused by the migrated native ID registry.
- The intermediate World/Choice passing Review does not certify the composite. The parent independent-review edge returns to author intake for either composite before dispatching the second unit. Existing no-write and dependency gates remain.
- Proof gates: [source and routing AST](../test/generation-recovery-coverage.test.ts), [model-consumer AST](../test/generation-model-consumer-coverage.test.ts), and [scripted Generation regressions](../test/generation.test.ts). The two production-shaped composite regressions inject actual SQLite loss before first Review and second rereview, reopen before the second unit, and prove same-Case/session identity, native effects, no duplicate charges, owner and plan rejection, and parent scheduling or a typed downstream stop. The [Composition prerequisite controller](../src/cross-domain-prerequisite-controller.ts) uses the existing authenticated Review-coverage view for the exact Choice/Puzzle commits on current HEAD; an independent passing repair can cover a historical negative without rewriting it, but cannot supply a missing Event field grant. Source fingerprints include the subunit preflight and this downstream gate. Wider R14 certification remains with #260.

### R14J Studio Discovery exit/consumer audit (#270)

- [Discovery adapter](../web/src/lib/onboarding-pi.server.ts): `onboardingPiRequest` retires raw-draft-hash progress and closure-only submission/correction references. `expectedProposal` and [planning interpretation validation](../src/planning-interpretation.ts) report exact claim checks, not new semantic authority. The child restores original request, response, validation and session evidence before pending verify/correct; shared `assignmentChildConfig` isolates logical assignments. Reconstruction cannot dispatch. Verified END is reattested from original receipt lineage before the parent CAS. Foreign or missing references fence; a source-specific rejection enters the shared convergence/assessment route.
- [Shared bounded assessment](../src/generation-recovery-lifecycle.ts) admits an independent reviewer replacement only after the adapter establishes the exact negative predecessor and source-backed diagnostic dispute. [Semantic diagnostic parser](../src/discovery-semantic-review.ts) validates quotations and full claim coverage. A fresh metered replacement must independently assess the exact packet and pass; prior negatives remain sealed. Neither diagnostic nor replacement grants author approval or waives deterministic source rejection.
- [Discovery evidence](../web/src/lib/discovery-evidence.server.ts) keeps the original writer and reviewer session identities and separately receipts the replacement. Existing budget, provider pre-dispatch refusal, uncertain-effect, stale author and approval boundaries remain authoritative. The current execution format explicitly rejects obsolete beta graph contracts. `realInference` uses the same source-bound Pi protocol, sealed transcript and budget admission for live and scripted responses; no fixture-only format allowance or extra substantive child correction remains. A cancelled first Turn is ineligible before dispatch/approval; the queued-message control cannot cancel an already-preparing first Turn, and an archived Thread cannot authorize handoff.
- Proof gates: [reviewed source AST](../test/generation-recovery-coverage.test.ts), [model consumer AST](../test/generation-model-consumer-coverage.test.ts), [semantic diagnostic tests](../test/discovery-semantic-review.test.ts), [Studio adapter regressions](../web/test/onboarding-pi.test.ts), [SQLite Story Chat checkpoint loss](../web/test/story-chat-discovery.test.ts), and [Pi transcript evidence](../web/test/discovery-evidence.test.ts). See the [R14J contract](generation-recovery-contract.md#r14j-270--studio-discovery-source-correction-and-independent-review).

### R14I author question exits (#269)

- [Generation question adapter](../src/generation-author-question.ts):
  original World/Character, Narrative Event and focused writer questions bind
  the original receipt and interrupt in the shared child. The root pending
  task, nested SQLite namespace and receipt must match; no writer lease spans
  the wait. The answer does not grant a new assignment or broaden scope.
- [Shared child](../src/generation-assignment-lifecycle.ts): authenticated
  author answer transitions back to the original phase; the next writer round
  is admitted separately. Returned-END prerequisites retain the existing
  parent re-entry path. The parent propagates the LangGraph interrupt instead
  of assessing it as a specialist failure.
- [Receipt](../src/specialist-choice.ts): immutable accepted answer seal,
  duplicate submission check and scoped child claim authority. Drafts do not
  confer authority. Existing protected Foundation and rejected Review dispute
  decisions remain parent-owned, not independent writer authorization.
- [CLI](../src/generation.ts), [Studio admission](../web/src/lib/generation-controls.server.ts),
  [HTTP](../web/src/lib/author-interactions.server.ts) and
  [worker](../web/src/agent-runner.ts): ordinary pause alone is not author
  authorization. Only a matching pending child uses a targeted resume command;
  after durable child consumption, continue without another command. Cancellation
  and original effect fences remain authoritative.
- Regression evidence: [production World restart](../test/generation.test.ts),
  [child lifecycle](../test/generation-assignment-lifecycle.test.ts),
  [receipt checks](../test/specialist-choice.test.ts) and
  [HTTP boundary](../web/test/author-decisions-api.test.ts). The production
  World variants certify CLI submission and the registered Studio Chat/HTTP/
  queue-worker flow through the next Character question; the standalone HTTP
  test separately checks draft/revision and receipt controls.

- The model-consumer audit includes the #269 worker's existing accepted-answer budget gate: `runPersistedGeneration` does not stream a new graph invocation while that answer is resource-blocked, and cancellation remains terminal. The rebased R14H audit preserves this already certified behavior.

### R14H: authenticated postdiagnostic continuation (#268)

| Source | Authority / effect | Verification or refusal |
| --- | --- | --- |
| `generation-operation-strategy.ts` `assignmentDiagnosticDecision`, `assignmentDiagnosticDefects`, `authorizeOperationDiagnosticStrategy` | Parent selects an exact original writer successor in the migrated lanes only after independent source-bound diagnosis. | No generic proposal grants new scope, ownership, approval or work. Unsafe or unsupported strategies retain the original unresolved Case. |
| `assignment-metadata-recovery.ts` `inspectSettledChain`, `inspectAssignmentFailure`, `runAssignmentReceipts` | Original immutable terminal, one diagnostic-bound successor grant, existing started/submitted/settled writer receipts. | Match predecessor, defects, transcript prefix, original session and current native effect; uncertain start or foreign grant fences. No new terminal overwrite or retry budget. |
| `foundation.ts` `inspectFoundationDiagnosticFailure`, `piAuthor` | Domain verifies original target-only dirty draft or exact committed bytes; existing writer executes only the admitted command. | Scope, provenance, author control and cumulative budget checks remain; no unrelated files. |
| `generation.ts` `runAssignmentDiagnosticRecovery`, `runFoundationAssignmentChild`, assessor return 1 and wrapper return 22 | Existing assessor and child execute the selected successor; parent resumes ordinary verification after discharge. | No new scheduler, Case or logical assignment. All successful results require exact native/Git/Review evidence; error paths fence or return typed control. |
| `generation.ts` recoveryNode returns 9–11, throw 4; `assignmentDiagnosticDecisionForLifecycle` | Typed pause retains the original diagnostic admission; schedule reauthenticates it before returning to assessor. | Actual current control, original Case/Thread/decision and receipts required; changed proof fences. |
| `generation-operation-strategy.ts` `authenticateAssignmentDiagnosticDecision`, `authenticateAssignmentDiagnosticDischarge`, `authenticateSettledReviewVerdict`, `originalFailedReviewProof` | Read exact diagnostic and independent Review transcripts and controller seals; shared positive/negative verdict reconstruction. | Exact successor commit, Turn/plan and the existing Review selection required. Mandatory Review retains independent reviewer identity and passing transcript; no self-approval. |
| `adaptive-planner.ts` `inspectCompletedAdaptiveProposal` | Read original Pi session only, no new context restoration or budget admission. | Exact session prefix, terminal response, original prompt, selected model and pinned method reads. |
| `adaptive-reconciliation.ts` `inspectSettledAdaptiveReconciliation` | Read original controller-admitted amendment; bind receipt to Job, Thread, Turn, plan, source, session, exact proposal and version. | Reject non-admitted, interrupted, corrected-format, stale or substituted receipts. Historical verification does not grant new work. |
| `generation.ts` assessor returns 9–11 and recoveryNode throw 14 | Restore native-checked pending inventory with amendment disabled; same Case. | Accepted version and HEAD must match; original diagnosis reauthenticated before and after restore. Errors fence without a writer. |
| `generation-recovery-inspection.ts`, `generation-recovery-resolution.ts`, `generation-recovery-lifecycle.ts` | Reauthenticate original decision/attempt and historical discharge, validate new typed adapter through existing policy. | No model call or new permission. |

The [contract's R14H strategy matrix](generation-recovery-contract.md#r14h-268--authenticated-postdiagnostic-continuation) distinguishes executable adapters from advisory proposals. Existing typed independent Review adjudication, dependency/Blueprint/work-plan ownership, no-write omission and author/resource controllers retain sole authority for their effects. The old unconditional advisory stop is bypassed only by a proven supported strategy. Focused production tests in [generation.test.ts](../test/generation.test.ts) assert the Foundation repair, crash windows, invalid receipt and control stops, unsafe/foreign refusal, actual independent Review, and accepted/rejected parent planner behavior. [Source/exit](../test/generation-recovery-coverage.test.ts) and [model-consumer](../test/generation-model-consumer-coverage.test.ts) gates bind these exact changes.

Follow-up correction: `originalOwnerAdapter` and `selectOperationStrategy` distinguish executable owner adapters from an unsupported implementation; `executeOperationStrategy` retains the authenticated original Case for a settled Blueprint prerequisite refusal or negative Review. `inspectDependencyAdmission` is the read-only deterministic admission check; `inspectDependencyPlanningRefusal` and the shared supporting Review packet reconstruct the exact settled evidence without a new model call or scope grant. `authenticateUnresolvedStrategy` is the common restart/inspection verifier. Altered evidence fails closed. The production SQLite R14D prospective matrix covers positive multi-Arc support, planner refusal, unauthorized scope, committed negative supporting Review, and transcript tampering; the C04 World negative path tests the explicit unsupported disposition. Remaining upstream amendment and bounded negative-support continuation paths are not certified by these tests.

### R14E Composition boundaries (#265)

- [Composition specialist](../src/composition-specialist.ts) `authorComposition` calls the bounded shared round service, not `recoverSubmittedAssignment`. `createCompositionReviewCycle` is a single source-check operation: the original reviewer admission, exact current reads, tool-free protocol correction, negative or passing verdict and immutable transcript/source history are evidence. The former Composition-only diagnostic loop is removed; verified progress goes to the shared convergence policy.
- [Composition work](../src/composition-work.ts) binds the parent logical key into the invocation source, refuses unadmitted Pi work, and returns pending writer settlements/correction grants without publishing. An accepted draft returns its exact settled proof; the shared child checkpoints that acceptance before separately authorized publication. The existing native validator, branch coverage, protected canon, exact file manifest and precommit editorial gate still apply. The historical origin checker verifies original Git bytes and original writer/reviewer proof independently of later repair bytes.
- [Generation](../src/generation.ts) routes Composition through the original narrative child and common postcommit Review transitions. [Shared lifecycle](../src/generation-assignment-lifecycle.ts) distinguishes draft publication from the subsequent committed Review handoff, and its migrated-work registry prohibits the old whole-loop Review repair adapter. [Review repair](../src/rejected-review-repair.ts) authenticates the original Composition receipt and exposes authenticated other-owner findings to the existing parent prerequisite flow. Global Review, parent dependency admission and final Turn fulfillment are not moved into the child.
- Proof gates: [reviewed routing and source AST](../test/generation-recovery-coverage.test.ts), [model consumers](../test/generation-model-consumer-coverage.test.ts), [production SQLite restart cases](../test/generation.test.ts), [editorial pin controls](../test/composition-review-pin.test.ts), [editorial roundtrip](../test/composition-review-roundtrip.test.ts) and [convergence policy](../test/composition-review-policy.test.ts). Scripted transport does not replace canonical validation, Git, receipt checks or checkpoint persistence; no live model certification is claimed.

- [Final Turn fulfillment](../src/turn-fulfillment.ts) now consumes the existing authenticated repair-coverage view, preserving original negative Review as historical evidence in the final packet. A negative verdict with no independently passed successor still blocks. This avoids a false block after a verified Composition repair without waiving the separate global completion gate.

### Pre-R14K cross-lane recovery review

| Source | Authority / effect | Verification or refusal |
| --- | --- | --- |
| `architecture.ts` `verifyArchitectureReviewOrigin`; `architecture-draft-review.ts` `verifyArchitectureDraftReviewPin` | Authenticate the original canonical Architecture writer and its immutable precommit Review and Blueprint. | Original committed source and approved plan, exact paths, historical content and settled transcript; not the mutable repair draft. |
| `review-repair-amendment.ts`, `rejected-review-repair.ts`, `architecture-record-path.ts`, `semantic-assignment-review.ts` | Admit only original Architecture prose paths into the existing independent postcommit Review cycle. | Exact original frontmatter bytes, no new records, no plan order or protected metadata changes. Successor Review retains Architecture-specific criteria and source context. |
| `generation.ts` `runArchitectureAssignmentChild`, `subunitReviewTransitions`, `subunitReviewStop` | Shared native writer and Review rounds with the original logical Architecture identity and native work-item identifier. | The first committed plan version becomes the parent plan only after passing correction, so author intake can verify the original result before new work. Old whole-loop repair is no longer an Architecture route. |
| `specialist-choice.ts` `focusedChoiceStates`; `dependency-work.ts` `advanceFocusedDependency`, `advanceReviewDependency`; `generation-author-question.ts` `pendingGenerationQuestion`, `pendingQuestionBudgetPause` | Both supporting assignments use the existing authenticated nested question graph, unique question work-item identity and admitted dependency overlay. | Exact original parent suspension, dependency report/grant, Turn, overlay version, scope, source and original session; no answer can cross from the original writer or another support assignment. |
| `generation.ts` `dependency_amendment` additional throw `8c468a57ba68bc74` | Propagate the actual nested GraphInterrupt. | Never turn a pending author interrupt into a failure assessment or a new writer. |
| `generation.ts` `assignmentDiagnosticReentry`, `runAssignmentDiagnosticRecovery`; `generation-operation-strategy.ts` `diagnosticWriterSupported`, `authenticateAssignmentDiagnosticDecision`, `authenticateAssignmentDiagnosticDischarge` | Reenter the original child with the existing diagnostic-bound receipt command. | Native metadata/provenance or exact typed Event-local fulfillment/evidence defects, original owner, Case, scope, session, terminal, plan, current source and no extra prerequisites; one successor, not a new retry allowance. |
| `assignment-metadata-recovery.ts` `assignmentCommittedEffect`; per-lane failure inspectors in Foundation, Architecture, World/Character, Event, Interactive, Composition and Focused | Reauthenticate immutable historical commit bytes and original settled effect, or the audited dirty draft. | Reject foreign paths, different predecessor, changed receipt/session and uncertain effect; require existing Review policy before discharge. |
| `event-work.ts`, `event-specialist.ts`, `interactive-work.ts`, `interactive-specialist.ts` | Preserve typed, path-bound native metadata diagnostics when the native validator and owned diff prove that category. | Semantic/causal feedback remains distinct; protection and unrelated edits never acquire diagnostic repair authority. |

Production regressions cover supporting writer and Review questions with restart and same-session continuation, Architecture's postcommit negative Review and subsequent scheduling, and Event's nonconverging native metadata repair with an admitted diagnostic and crash/restart at the successor submission. Other migrated writer lanes share the same admission contract and domain-specific proof ports; full cross-lane qualification remains R14L.

### R14K (#271) — initial entrypoint audit

| Entrypoint / production source | Disposition and remaining proof |
| --- | --- |
| [CLI `refuseObsoleteStageCommand`](../src/cli.ts) | Retire live standalone Foundation and stage `run` (Architecture, foundations, Event, Interactive, Composition, narrative Review, repair), Idea place/relocate/recorded reassess before opening a Job. Keep historical inspect. Deterministic stage fixture callers, explicit reconcile, author-update/plan/approval and administrative routes still require complete disposition and migration; the fixture switch is **not** the final contract. |
| [Generation `requireGenerationTurn`, `runStoryGeneration`](../src/generation.ts) | Adapt live request/source admission; reject an absent digest before creating a CLI checkpoint/owner; same current Turn receipt is checked at nodes. The legacy no-Turn fixture identity, phase/focus fallback, strategy branches and final fulfillment still require removal and fixture conversion. |
| [Studio start](../web/src/lib/fixture-jobs.server.ts), [resume admission](../web/src/lib/generation-controls.server.ts), [worker](../web/src/agent-runner.ts) | Adapt admission before credentials/queue and fence obsolete inventory. Preserve independent worker-side proof; other queue/answer/fix paths still require complete qualification. |
| [Foundation inspect](../src/foundation.ts), [approved handoff](../web/src/lib/story-approved-continuation.server.ts) | Inspect cannot consume a retry. Keep exact current approved handoff; no new standalone model authority. |
| [Idea integration](../src/generation.ts) | Remove the `NT_LIVE_GENERATION_IDEA` fixture-to-live override. Paid certification must use current authenticated live/scripted transport instead. |
| [Merge preview](../src/merge-preview.ts) | Separate disposable detached Git candidate and independent integration review; no canonical write/merge grant. Full administrative-path qualification remains outstanding. |

Focused regression: [recovery-cutover](../test/recovery-cutover.test.ts).
The three touched existing helper fingerprints in the [reviewed AST gate](../test/generation-recovery-coverage.test.ts)
are individually updated for the Job/Turn check, Foundation inspect retry guard,
and Studio resume preflight/inventory gate. No blanket snapshot regeneration.

`runStoryGeneration/throw#1` (`aee3a3f31877864a`) refuses a missing start task before SQLite ownership. The CLI regression asserts that an unplanned start leaves the Job state directory and Git unchanged.

#### R14K pending-node and fulfillment audit

| Source / entrypoint | Disposition and evidence |
| --- | --- |
| [Generation node owner gate](../src/generation.ts), [owner receipt](../src/generation-owner.ts) | All registered nodes pass the actual execution owner. Current Turn pending tasks recheck the immutable original request and graph Thread. Missing claim on admitted server execution and CLI/server conflicts fence before node effects. Real SQLite restart negative control in `recovery-cutover.test.ts`. |
| [Worker admission](../web/src/agent-runner.ts), [known-fix pickup](../web/src/lib/known-fix-pickup.server.ts) | Verify existing owner before runtime/sandbox acquisition and again before worker claim. Authenticate current Turn before enqueuing a known-fix pickup. |
| [CLI resume](../src/generation.ts) | Obsolete inventory rejection before generic reconciliation. New `runStoryGeneration/throw#11` (`f7ec8691c6e8a121`) is a caught preflight refusal, with no specialist dispatch or Git continuation. |
| [Final fulfillment](../src/turn-fulfillment.ts), [report projection](../src/job-report.ts) | Remove missing-Turn final fulfillment return. Retain scope and historical receipt inspection without claiming full completion. Require current objective for fixtures with an explicit Turn. |
| [Studio input](../src/studio-input.ts) | Validate existing current-format Turn and emit digest; never manufacture a Turn for a CLI or Studio user. Missing plan negative and existing-plan positive tests in `generation.test.ts`. |
| [Operation strategy](../src/generation-operation-strategy.ts) | Require matching Turn digest; integrity and authenticated protocol exhaustion cannot be waived by transport selection. Effectful fixture stop and other fixture proof branches remain to be migrated. |
| [Paid Generation/Idea test setup](../test/generation.test.ts) | Produce original whole-Story Turn using the actual planner and receipt writer; remove the old fixture-to-live override from certification invocation. Paid model calls not executed in offline verification. |

The AST changes are limited to the reviewed owner argument at each node,
`recoveryNode/return#1`, `runStoryGeneration/return#1` and the single new
inventory throw, and the changed source-proof functions (Turn admission,
operation selection, fulfillment and Studio worker). The worker retains one
model consumer; its fingerprint changes only because admission now precedes
runtime acquisition. No blanket rebaseline.

#### R14K receipt admission and whole-assignment adapter removal

| Source / entrypoint | Disposition and evidence |
| --- | --- |
| [Shared assignment receipts](../src/assignment-metadata-recovery.ts) | Remove the unused whole-assignment `recoverSubmittedAssignment` entry and the command-less correction loop. The existing `executeAssignmentRound` interface requires an invoke, verify, or correct command; absent or invalid commands fail before session/effect access. Iteration only authenticates preceding receipts. [Receipt tests](../test/assignment-metadata-recovery.test.ts) now drive the same explicit rounds, including pause/resume, drift, protocol exhaustion, and non-convergence. |
| [Turn reader](../src/turn-plan-evidence.ts), [fork review projection](../src/fork-review-turn.ts) | Reject old objective-less receipts even with a matching digest, including inherited Review criteria. The shared web verifier also uses the current objective attestation. Existing fork evidence with a current objective remains usable. [Cutover regressions](../test/recovery-cutover.test.ts) and [fork regressions](../test/fork-review-turn.test.ts). |
| [CLI demo](../src/cli.ts) | Retire the pre-Generation standalone Creative Direction authoring command for both live and fixture modes, before project creation, skill snapshot, provider initialization or writer access. Delete its separate model writer and custom write tool; the pure canonical serializer remains shared by Foundation and Studio. [Negative controls](../test/demo.test.ts) assert no state, cache, existing bytes or directory creation; [certification](../test/certification.test.ts) checks both roots and source checkout. Consolidate the former paid demo smoke into [authenticated Foundation certification](../test/foundation-live.test.ts). The read-only `run` routing demonstration remains separate. |

The only updated model consumer fingerprint is `runAssignmentReceipts` (still two
call sites); the R02 gate tracks its mandatory command and removes the deleted
whole-assignment adapter. The no-Turn fixture admission and standalone repair paths remain outstanding.




The deleted `runFoundationDemo` model consumer is removed from the reviewed
inventory; no other model consumer changes for this retirement.

#### R14K transport-independent assessment and scripted subprocess migration

| Source / entrypoint | Disposition and evidence |
| --- | --- |
| [Strategy selection](../src/generation-operation-strategy.ts) | Remove fixture-based selection skips from assignment, Review, blueprint and diagnostic proof selection. An authentic case requires the same current Turn pin and source receipts regardless of transport; an Interactive no-write report must be Pi-owned. [Event diagnostic regression](../test/generation-operation-event-diagnostic.test.ts) proves that fixture flags cannot alter a selected source-bound diagnostic or manufacture a missing Turn. |
| [Model runtime](../src/model-runtime.ts), [node execution](../src/generation.ts) | While structural fixtures remain, their execution is explicitly denied a model runtime, including an ambient bound runtime and nested rebinding. This is transport isolation, not a recovery policy. Production-shaped tests use the ordinary execution path with a deterministic Pi transport. [Cutover regression](../test/recovery-cutover.test.ts) verifies denial and restoration of the outer runtime. |
| [Scripted CLI subprocess](../test/support/scripted-foundation-cli.ts), [Generation tests](../test/generation.test.ts) | Four former structural CLI tests now use a real whole-Story Turn, original planner, Foundation writer, native Git verification, independent Review and actual subprocess checkpoints; missing or swapped method receipts and dirty Git inspection/resume must not invoke another model. R01 Foundation scenarios no longer substitute a synthetic review callback: the normal independent Review consumes the scripted model transport. |

The reviewed strategy helper fingerprints are individually updated, and the
owner no-write and blueprint assessment proof functions are explicitly included.
Structural fixture admission and remaining standalone recovery routes are not
certified by these changes.

#### R14K standalone Review repair and collaborative Foundation retirement

| Source / entrypoint | Disposition and evidence |
| --- | --- |
| [CLI](../src/cli.ts), [Review repair](../src/rejected-review-repair.ts), [Generation parent](../src/generation.ts) | Retire `job repair run` (including fixture flags), retaining `job repair inspect`. Delete `advanceRejectedRepair` and the parent whole-cycle correction fallback. `executeReviewRound` requires the exact original work item admitted to a checkpointed Review child; receipt reconciliation, scoped writer, validation, publication and rereview are bounded effects. The parent can observe a failed verdict and admit its Case but cannot dispatch its correction. The remaining old pure loop is referenced only by tests, not executable production callers. [Cutover tests](../test/recovery-cutover.test.ts) refuse the direct command; [Generation tests](../test/generation.test.ts) exercise Event review and support, Choice/Puzzle and Foundation convergence, scope revision and native correction through the current child. |
| [Foundation](../src/foundation.ts), [CLI](../src/cli.ts) | Delete the standalone free-text Discovery model consumer, deterministic question generator and author-input execution transition. Refuse obsolete start or historical receipt re-entry before author update, retry consumption or writer invocation. Preserve historical inspection and authenticated approved Foundation handoff. [Foundation tests](../test/foundation.test.ts) prove refusal and unchanged Git/receipt; [approved continuation](../web/test/story-approved-continuation.test.ts) proves the supported handoff. |
| [Historical Event](../test/issue-168-live.test.ts), [historical Choice](../test/issue-173-checkpoint-repair-live.test.ts), [hosted Foundation](../test/sandbox-hosted-live.test.ts) | The first two opt-in certificates now inspect historical negative evidence and verify refusal rather than dispatch an obsolete standalone writer. The hosted repair certificate requires the preserved original current-format CLI Generation and resumes it, not a separate repair operation. These paid/preserved-environment opt-ins were not executed in the focused offline run; positive scripted current-contract correction is covered separately. |

The reviewed AST changes remove the deleted parent exits and the retired Discovery model consumer, and attest the new parent integrity refusal and bounded Review operation adapter. Remaining no-Turn structural fixture admission, direct structural fixture stage writers, and test-only legacy recovery orchestration are not certified by this increment.

#### R14K focused revision transport and canonical baseline

| Source / entrypoint | Disposition and evidence |
| --- | --- |
| [Archive witness baseline](../test/fixtures/README.md), [focused integration tests](../test/focused-generation.test.ts) | Replace seven generated seed setups with static canonical author input committed to fresh repositories; do not copy any approval, execution, native or Review receipt. |
| [Scripted focused CLI](../test/support/scripted-focused-cli.ts) | Test-only transport uses native catalog, actual revision planner, immutable current Turn, ordinary CLI, scoped Pi tools, real Git, independent assignment/narrative/Turn Review. Five separate record types and a two-assignment restart exercise the same production graph, with model-call logs to prove no replay. Only Pi responses and sandbox filesystem are substituted, not authority. |
| [Turn reader](../src/turn-plan-evidence.ts), [delivery history](../src/turn-delivery.ts) | Preserve exact signed receipt integrity and semantic contract equality regardless of object key order after preset parsing and SQLite normalization. Reordered keys pass; changed depth or branch scope does not. |
| [CLI resume](../src/generation.ts) | Verify pinned dependency and pending-plan histories before generic recovery reconciliation, including when a previous terminal diagnostic exists. Missing history fences rather than being hidden by a previously selected decision. Existing focused missing-ledger regressions prove refusal and unchanged Git. The enclosing CLI return fingerprint is updated for these two added checks only. |

This increment migrates the public scoped revision scenario and removes its
legacy seed execution prerequisite. Other focused structural fixtures and
missing-Turn dispatch paths remain pending; this is not final R14K certification.

#### R14K authenticated archive prelude and focused admission

- [Archive scripted transport](../test/support/scripted-archive-stages.ts) and [CLI entry](../test/support/scripted-archive-cli.ts) exercise the ordinary Foundation, compact Blueprint, Architecture, World and Character checkpoints. They supply model responses and sandbox tool effects, not synthetic approval or recovery receipts. R05 World/Character, C04 World-negative, R14D Event correction and R14I question-resume tests now use the real prelude; R14I Studio preserves the original server owner and Turn rather than replacing an admitted fixture request.
- [Focused CLI](../test/support/scripted-focused-cli.ts) uses the canonical scope resolver, authenticates the actual revision plan, and tests a process exit after the durable intent publication. Missing scope, unsupported expansion and external worktree drift remain rejected. The recovered writer is not replayed.
- [Generation admission](../src/generation.ts) now requires the original Turn even for focused requests carrying the historical fixture flag, before CLI SQLite ownership and on node re-entry. Focus dispatch always goes through the focused assignment child rather than its missing-Turn narrative fallback. [Negative admission regression](../test/recovery-cutover.test.ts) checks no SQLite or Git effect.

Whole-story structural fixtures, their remaining standalone paths, and Studio fixture admission still require migration; this increment does not certify final R14K cutover.

#### R14K Studio execution admission and current recovery forks

| Surface | Disposition and evidence |
| --- | --- |
| [Generation start](../web/src/lib/fixture-jobs.server.ts), [Natural Story](../web/src/lib/natural-story.server.ts), [Thread continuation](../web/src/lib/thread-chat.server.ts) | Retire model-less fixture dispatch. An executable start requires an authenticated Turn and selected owner-scoped model before queue admission; an already pinned obsolete request cannot be started again. The human-approved protected amendment remains a separately authorized non-model effect. |
| [Generation controls](../web/src/lib/generation-controls.server.ts), [Worker](../web/src/agent-runner.ts) | Refuse obsolete resume/start before provider acquisition, sandbox execution or dispatch. Remove worker's alternative fixture execution branch. Keep inspection and the exact original queue/owner binding. The reviewed AST fingerprints cover these changed admission and runtime boundaries. |
| [Restart](../web/src/lib/thread-restart.server.ts), [Checkpoint fork](../web/src/lib/checkpoint-fork.server.ts), [Edited message](../web/src/lib/thread-message-edit.server.ts), [Replacement Turn](../web/src/lib/replacement-turn.server.ts) | A new executable job receives a fresh Turn bound to the selected verified Git base and authorized contract; historical Review attribution is not writer authority. Fresh focused edits retain the exact reviewed revision plan. |
| [Fork evidence](../src/recovery-fork.ts), [World/Character](../src/character-world.ts), [Review projection](../src/fork-review-turn.ts) | Retain already committed effects using the immutable fork bundle, exact inherited specialist receipt, original Git provenance and resolved independent Review. Never import the old invocation as a new writer grant. A newly committed child checkpoint retains the current child's own Turn attribution. |
| [Scripted worker](../web/test/support/scripted-archive-worker.ts), [Queue tests](../web/test/fixture-jobs.test.ts), [Controls](../web/test/generation-controls.test.ts), [Steering and dependency](../web/test/story-revision-admission.test.ts), [Current fork](../web/test/current-checkpoint-fork.test.ts) | Actual persisted queue, current owner, credential vault, production graph, native validator, scoped tools, Git, original and child Turn identities. Deterministic Pi replies and sandbox transport are the test seams; no fixture verdict substitutes for Review. |
| [Archive transport](../test/support/scripted-archive-stages.ts), [Generation regression](../test/generation.test.ts) | Event prerequisite, actual Milestone plan, Event-only omission, independent Choice/Puzzle correction and the subsequent closeout proposal use real production evidence. |

The older CLI structural-fixture execution branches and their remaining direct
specialist tests still require migration. This is not final R14K certification.

#### R14K final execution cutover (#271)

This supersedes the incremental migration notes above. Historical receipt
formats remain readable for inspection; they do not provide an alternative
execution contract. The authority is the local immutable Turn, original
owner/graph identity, current approved plan, and production assignment
lifecycle. A deterministic provider cannot substitute another lifecycle.

| Source / surface | Keep, adapt or retire; effect boundary |
| --- | --- |
| [CLI](../src/cli.ts), [Studio input](../src/studio-input.ts), [Generation admission](../src/generation.ts) | **Retire** standalone Foundation discovery/writing, Architecture and Foundations run/manual reconcile, Event/Interactive/Composition/Review writers, direct repair and idea placement. Refuse fixture execution and old orchestration policy before invoking a Story writer. Keep job setup, native validate, inspect/report, explicit human revision/approval and Pi budget/control operations. Architecture proposal/approval requires the actual local Turn and exact existing approval protocol; it does not invoke a specialist. |
| [Turn evidence](../src/turn-plan-evidence.ts), [owner verification](../src/generation-owner.ts), [Studio start](../web/src/lib/fixture-jobs.server.ts), [resume](../web/src/lib/generation-controls.server.ts), [worker](../web/src/agent-runner.ts) | **Adapt** all executable admissions to current Turn objective, exact source and digest; no missing-Turn fixture exception or ownerless dispatch. Keep original queue, owner, credential and source-bound provider reconciliation. A prepared replacement Turn fixes the task and contract; changing model/budget does not replace it. |
| [Discovery](../web/src/lib/discovery-graph.server.ts), [handoff](../web/src/lib/story-chat-discovery.server.ts), [Foundation](../src/foundation.ts) | **Keep** authorized human/bootstrap and approved Foundation handoff. Retire the separate collaborative writer/discovery fallback; old questions and receipts are evidence, not new permission. |
| [Generation parent](../src/generation.ts), [assignment lifecycle](../src/generation-assignment-lifecycle.ts), [operation strategy](../src/generation-operation-strategy.ts), [recovery graph](../src/generation-recovery-graph.ts), [inspection](../src/generation-recovery-inspection.ts) | **Adapt** to one actual scheduler, Review adapter and original source-bound Case. Remove fixture-specific identities, missing-pin alternate focused dispatch and whole-loop repair. No caller-supplied Review bypass. A proven controller-only scheduling recheck discharges its original case with no additional model charge. |
| [Architecture](../src/architecture.ts), [Character/World](../src/character-world.ts), [Event](../src/event-work.ts), [Interactive](../src/interactive-work.ts), [Composition](../src/composition-work.ts), [focused work](../src/focused-work.ts), [idea placement](../src/idea-placement.ts), [narrative review](../src/narrative-review.ts) | **Adapt** production adapters, retain native catalog, scoped tools, Git path/diff/manifest, exact invocation and independent Review gates. Remove structural fixture authors and obsolete final-editorial/repair-controller loops. Refuse a standalone writer round. Historical worker labels are retained only where needed to identify non-executable evidence. |
| [Milestone prerequisites](../src/cross-domain-prerequisite-controller.ts), [Event grant](../src/event-milestone-repair.ts), [dependent revalidation](../src/selective-revalidation-controller.ts), [dependent work](../src/selective-revalidation-work.ts), [fulfillment](../src/turn-fulfillment.ts) | **Keep** independent native, causal and final-objective checks. Remove fixture permission. A commitless Event-only obligation requires its original independently reviewed omission seal; it does not fabricate a checkpoint. Inherited committed dependencies use original sealed native and review proof, never a replayable invocation. Negative revalidation of inherited/commitless work cannot grant an old writer; it needs authorized owner amendment. |
| [Fork collection](../src/recovery-fork.ts), [immutable fork evidence](../src/recovery-fork-state.ts), [replacement Turn](../web/src/lib/replacement-turn.server.ts) | **Adapt** current fork admission to carry exact original native checkpoints with existing commit and Review evidence. A new Turn owns only future work; previously reviewed Choice is not dispatched as a writer. Inherited Event proof identifies its selected fields, not a general writer grant. Composition closeout is admitted by the new Turn and independently revalidated. Preserve old source, history cutoff, same-Thread retry and stale/verified rewind refusal. |
| [Cutover negatives](../test/recovery-cutover.test.ts), [current archive](../test/support/scripted-archive-stages.ts), [current graph](../test/generation.test.ts), [focused graph](../test/focused-generation.test.ts), [adaptive protocol](../test/adaptive-protocol-scenario.ts), [native domain tests](../test/domain-cutover.test.ts), [Studio recovery forks](../web/test/current-checkpoint-fork.test.ts) | **Adapt** tests to actual authenticated Turn, SQLite graph, native validator, Git commits and independently reviewed output. Script only model responses and explicit sandbox/provider transport. Replace obsolete standalone structural-writer scenarios with native domain checks and parent/child recovery regressions; remove duplicate legacy orchestration. Non-Story tagline and disposable integration preview fixtures remain separate read-only/noncanonical tools, not Story execution modes. |

The source gate continues to fingerprint the reviewed actual production
dispatch and prerequisite functions. R14K does not certify paid provider
behavior or the later integrated qualification (#272/#260).

The former credential-gated standalone Character/World, Event,
Event-to-Character dependency, Interactive and narrative-review tests were
retired with their obsolete entrypoints. Their native/protocol checks are
covered by the current deterministic suite; live narrative outcomes require
the subsequent integrated qualification. The hosted sandbox smoke now uses
a scripted provider on the same authenticated Generation graph and real
rootless Docker controller. The cooperative live interruption test also
starts an authenticated Turn; paid interruption is not claimed here.

#### R14K CI follow-up

The C08 crosswalk binds each live graph node, decision and lifecycle phase to
the current regression, including the registered variants of parameterized
tests. The production-graph tests now cover a foreign Idea dispatch receipt,
a forged integration result, a genuine deferred read-only selection, an
unaccepted specialist result, an unreadable completion plan and a failed
dependency amendment. The Studio approval regression builds an authenticated
Turn through independently reviewed Architecture, proposes the real plan
amendment, and retains the owner, nonce, replay and historical-worker
rejection checks. The rootless Blueprint adapter's reviewer-crash and
active-time admission regressions invoke the original assignment round, not
the retired standalone Architecture command. The same suite independently
exercises the authenticated Generation parent.

Native Review recovery also requires the corrected native catalog protection
semantics in Cruel/nt. A malformed record retaining the exact protected
identity and decisions must not be misreported as deletion of those decisions;
an actual changed or missing protected decision must still be rejected.
The older native artifact from Build 45475149240 reproduced the Review
recovery failure. The native Git regression and the five Foundation
native-correction variants pass with the corrected CLI. Publish a successful
native master Build containing that correction before certifying the
generator against the downloaded artifact. Do not relax the generator's
protected-record refusal or substitute fixture evidence for the native
contract.

### R14L incremental qualification (#272)

This section records deterministic qualification under #246/#260
and the R14A–K migrations (#247–#259, #261–#271). ADRs 0005–0007 and
the existing recovery contract remain normative; no new recovery authority
is introduced. Live provider certification remains separate.

| Changed boundary | Former exit / next authority | Current gate and independent regression |
| --- | --- | --- |
| [Shared assignment outcome](../src/generation-assignment-lifecycle.ts), `assertAssignmentOutcome` | An unknown discriminant could fall through to the unresolved-reference check, and a verified result could contain contradictory control fields. | Exact runtime union, logical key, typed nonblank evidence and disposition reference, and verified source/HEAD are checked before the result can route. The shape gate does not authenticate the referenced receipt; the adapter still must. [Lifecycle regression](../test/generation-assignment-lifecycle.test.ts) proves invalid outputs cannot dispatch or verify the original assignment. |
| [Subunit Review correction](../src/generation.ts), `subunitReviewTransitions`, `subunitReviewStop` | The admitted Review prerequisite returned unresolved with a string tag; a later parent projection constructed the real suspension. | A sealed controller-amendment request returns `needs-prerequisite` with original Review digest, suspension digest, bounded owner, scope and pending Review phase. The stop consumer authenticates the native checkpoint and exact ledger tuple before handing the request to the parent. Protected approval remains a separate control. |
| [Review prerequisite identity and continuation](../src/generation.ts), `reviewPrerequisiteOwner`, `reviewPrerequisiteIdentity`, `runReviewPrerequisiteChild` | Supporting owner resolution was performed only by the later parent projection. A returned suspension could be projected without comparing its complete tuple. | Resolve owner from the same pinned Turn for both boundaries; parent authenticates the original Case/plan/native negative Review and rejects inconsistent returned suspension or a stale suspension after support. Only the parent may admit the supporting assignment; the existing continuation requires its verified receipt. [R14D support](../test/generation.test.ts) checks actual persisted correction-child outcomes equal the parent suspension, original assignment key, native Git diff, original reviewer/writer session, child-before-parent crash/restart and next scheduled work. |
| [Studio fork regression](../web/test/current-checkpoint-fork.test.ts) | Unset native CLI override was restored as the literal string `undefined`; valid fork then failed the tooling gate. | Restore absence rather than assigning undefined. The native tooling guard is unchanged. Test retains negative controls and verified same-Thread continuation. |

#### Downstream reply-consumer gate

The [existing model-consumer AST test](../test/generation-model-consumer-coverage.test.ts)
now separately enumerates 37 consumer owners of 16 named reply/Review/planning
producer functions. The direct-call baseline is not regenerated. The second
inventory catches imported aliases, new downstream owners and changed
same-count consumer bodies. A fingerprint is a change alarm, not a semantic
proof. The following is the crosswalk for this named boundary set; existing
regressions are referenced as verification targets, not a claim that all
were executed in this qualification.

| Actual downstream producer → consumer | Validation, disposition and next authority | Regression |
| --- | --- | --- |
| `proposeAdaptiveWork` → [reconcileAdaptiveWork](../src/adaptive-work.ts) | Proposal admission and source/plan checks precede reconciliation; invalid/stale proposal cannot authorize dispatch; parent retains plan admission. | [adaptive operation recovery](../test/adaptive-operation-recovery.test.ts) |
| `proposeDependency`, `reviewNarrative` → [admitDependency, runSupportingDependency, advanceReviewDependency, continueReviewDependency](../src/dependency-work.ts) | Exact dependency source/authority and independently verified support before original continuation; no reviewer output grants a writer; unmet/negative support cannot advance original assignment. | [R14D/R04](../test/generation.test.ts), [dependency amendments](../test/dependency-amendments.test.ts) |
| `runPiAssignmentReview` → [independentAssignmentBoundary](../src/generation.ts); `runPinnedObjectivePlanner`, `assessTurnFulfillment`, `reviewTurnCompleteness` → [createGenerationGraph](../src/generation.ts) | Authenticate native checkpoint/Turn; negative Review enters parent recovery; planner output does not bypass plan admission; final objective verdict must independently pass. | [production archive and Event recovery](../test/generation.test.ts), [Turn fulfillment](../test/turn-fulfillment.test.ts) |
| `diagnoseUnknownCompletion` → [executeOperationStrategy](../src/generation-operation-strategy.ts); `independentReviewResults` → authenticateSettledReviewVerdict | Diagnostic proposal is not a corrective grant; compare sealed original verdict and source before parent strategy admission. Untrusted evidence fences. | [operation Event diagnostic](../test/generation-operation-event-diagnostic.test.ts) |
| `parseSpecialistJson` → [authorMilestoneCloseout](../src/cross-domain-closeout-specialist.ts), [recoveredCloseoutReview, verifyLegacyCloseoutReviewTranscript](../src/cross-domain-closeout-work.ts); `reviewNarrative` → advanceCrossDomainCloseout | Parse/validate exact closeout scope and source; legacy evidence re-read is not executable permission; require independent review/native proof before original closure. | [closeout successor](../test/cross-domain-closeout-successor.test.ts) |
| `reviewNarrative` → [advanceDependentCorrection](../src/dependent-correction-work.ts), [revalidateAfterReviewedCorrection](../src/selective-revalidation-work.ts), [candidateReview](../src/pending-work.ts) | Review exact affected/candidate scope, retain pending obligations on negative/untrusted results; parent decides next authorization. | [dependent correction](../test/dependent-correction-work.test.ts), [selective revalidation](../test/selective-revalidation.test.ts), [pending amendments](../test/pending-work-amendments.test.ts) |
| `validateSemanticVerdict`, `independentReviewResults` → [captureSealedReview](../src/execution-replay-capture.ts); plus `parseSpecialistJson` → [executeReplay](../src/execution-replay.ts) | Capture/replay validates evidence against the original packet; replay analysis is not a new canonical writer grant. | [execution replay](../test/execution-replay.test.ts) |
| `reviewNarrative` → [decideEventOnlyOmission](../src/interactive-event-only.ts), [previewStoryMerge](../src/merge-preview.ts), [runNarrativeReview](../src/narrative-review.ts) | Independently review omission/preview/parent scope; no fabricated native checkpoint or positive verdict from an invalid response. | [omission merge](../test/recovery-omission-merge.test.ts), [merge preview](../test/merge-preview.test.ts), [narrative Review](../test/narrative-review.test.ts) |
| `parseSpecialistJson`, `validateSemanticVerdict` → [reviewNarrative, assignmentVerdictResponseContract, reviewSpecialistAssignments](../src/narrative-review-specialist.ts); `reviewPostcommitDiagnosis` → diagnoseAcceptedPostcommitRound; `validateTurnFulfillment` → reviewTurnCompleteness | Bounded parser/protocol correction, sealed read-only verdict and source-linked findings; only the owning controller can act on a negative verdict or diagnosis. | [semantic assignment Review](../test/semantic-assignment-review.test.ts), [postcommit diagnostic](../test/issue-211-postcommit-diagnostic.test.ts), [fulfillment](../test/turn-fulfillment.test.ts) |
| `parseSpecialistJson` → [readSealedPostcommitVerdict](../src/postcommit-repair-diagnostic.ts); `runPiAssignmentReview` → [adjudicateRejectedRepair, rejectedRepairOperations](../src/rejected-review-repair.ts); `validateSemanticVerdict`, `independentReviewResults` → foundationDiagnosticSource; `reviewPostcommitDiagnosis` → executeFoundationReviewAssessment | Reopen original transcript and review cycle; diagnosis/adjudication never self-approves a repair; original native and reviewer successor evidence remains mandatory. | [postcommit Review cycle](../test/issue-210-postcommit-review-cycle.test.ts), [R14D](../test/generation.test.ts) |
| `validateSemanticVerdict`, `independentReviewResults` → [reviewBoundedAssignments](../src/semantic-assignment-review.ts); `reviewSpecialistAssignments` → runPiAssignmentReview | Strict packet, diff, source and assignment review; failed result stays negative, invalid evidence rejected. | [semantic assignment Review](../test/semantic-assignment-review.test.ts) |
| `validateTurnFulfillment` → [readTurnFulfillment, assessTurnFulfillment](../src/turn-fulfillment.ts) | Revalidate persisted/returned final objective verdict and source; incomplete or forged evidence cannot complete the Turn. | [Turn fulfillment](../test/turn-fulfillment.test.ts) |
| `readDiscoveryResponse` → [meterDiscoveryAttempts](../web/src/lib/discovery-evidence.server.ts), [onboardingPiRequest](../web/src/lib/onboarding-pi.server.ts); `onboardingPiRequest` → [storyChatDiscoveryRequest](../web/src/lib/story-chat-discovery.server.ts) | Authenticate original attempt/transcript, exact reviewed proposal, owner and approval; meter once, no repeated handoff effects; unresolved/ambiguous response or missing authority cannot grant a new execution. | [real backend Discovery](../web/test/story-chat-discovery.test.ts), [approved continuation](../web/test/story-approved-continuation.test.ts) |

#### Typed adapter exits and parent projection

The six-outcome union is shared. A particular adapter only returns the
outcomes that its authenticated source admits. A parent-wide failure or
cancellation is not a seventh child disposition. The common
[projection gate](../src/generation.ts) (`reviewProjectionOutcome`,
`assertReviewProjection`) whitelists callback fields and compares the
persisted outcome before a callback can influence the parent. A control
is not a semantic finding; a negative verdict is not verification.
A sealed writer terminal references its own proof, not a generic Review
receipt. A persisted fence remains a fence even when the callback was
lost. The existing graph assessor owns recovery decisions, and the
commit-verification node independently reauthenticates verified results.

| Adapter / producer | Boundary, disposition and next authority | Production regression |
| --- | --- | --- |
| [Discovery](../web/src/lib/onboarding-pi.server.ts), [Discovery assignment](../web/src/lib/discovery-graph.server.ts) | Validate Question Set, answer revision, proposal and independent verdict against the source attempt. Await exact author answer/approval; pause on control, fence untrusted effects, unresolved only on exhausted response/correction. Verified proposal is not Generation admission; exact approval and durable handoff remain parent-owned. | [Studio Discovery](../web/test/story-chat-discovery.test.ts), [integrated Turn](../web/test/integrated-story-turn.test.ts) |
| Foundation, `runFoundationAssignmentChild` | Validate original writer/native commit and Review checkpoint. Project verified only after passing proof; reconstruct original failed Review from sealed checkpoint. Cancel at parent terminal; typed budget/provider/author control pauses. Invalid or foreign result fences, sealed terminal enters original assessment. | [Generation](../test/generation.test.ts), [Review cancellation](../test/rejected-review-repair.test.ts) |
| Architecture, `runArchitectureAssignmentChild` | Original architecture receipt and plan version must match verified HEAD; Review cannot grant a new plan. Reject contradictory callback or replayed disposition before parent admission; pause remains control. | [Generation R14K](../test/generation.test.ts), [architecture/native cutover](../test/domain-cutover.test.ts) |
| World then Character, `runCharacterWorldAssignmentChild` | Separate child identities and exact unit submissions. Verify original commit/review; negative no-write conflicts become original assessment, not another unit's writer grant; a missing callback is reconstructed only from exact Review disposition. | [R14I nested author question and World recovery](../test/generation.test.ts) |
| Event and Composition, `runNarrativeAssignmentChild` | Original source-bound invocation, native Git/manifest, independent review and exact successor. Typed pause/fence/unresolved is compared to the callback; rejected original review stays pending until verified successor. Parent alone advances inventory, plans and closeout. | [R14D recovery](../test/generation.test.ts), [integrated Turn](../web/test/integrated-story-turn.test.ts) |
| Choice then Puzzle, `runInteractiveAssignmentChildren` | Separate unit checkpoints or sealed no-write omission, exact current Event/plan; retain negative finding and pause control; original receipt must verify before next unit. | [Generation](../test/generation.test.ts), [omission merge](../test/recovery-omission-merge.test.ts) |
| Focused, `runFocusedAssignmentChild` | Exact authorized target and original writer/reviewer; bounded prerequisite must match sealed report and owner/scope; suspend at END for parent support, reauthenticate before same assignment re-entry; preserve submitted result during pause. | [R04 and R07](../test/focused-generation.test.ts) |
| Subunit Review and supporting child, `subunitReviewTransitions`, `subunitReviewStop`, `runReviewPrerequisiteChild` | Source-bound negative Review, typed writer/Review-phase prerequisite, parent admission and exact support receipt; control does not become semantic rejection. Protected approval is separate; cancellation stays parent terminal. | [R14D support, review and diagnosis](../test/generation.test.ts) |
| [Shared lifecycle](../src/generation-assignment-lifecycle.ts), [parent boundary](../src/generation.ts) | Exact discriminant, logical identity, source and outcome references; question interrupt differs from prerequisite END; forged/contradictory fields and lost fence cannot authorize work. Parent authenticates every entry before effects. | [Lifecycle](../test/generation-assignment-lifecycle.test.ts), [projection guard](../test/generation-recovery-graph.test.ts), [persisted Generation](../test/generation.test.ts) |

#### Native, manifest and durable-effect consumers

The third source gate in [model-consumer coverage](../test/generation-model-consumer-coverage.test.ts)
lists the exact function owners and individual reviewed signatures in
`effectReviewed`. It covers 20 named native, manifest, stage execution,
handoff and queue producers (72 consumer owners). New imported aliases,
new consumers and same-count changes are detected. The following groups
map these owners to their source and independent validation authority;
no hash alone is evidence of successful work.

| Producer and actual consumers | Validation, exit, next authority / regression |
| --- | --- |
| Manifest/report: [responsePolicy](../src/assignment-metadata-recovery.ts), [authorCharacterWorld](../src/character-world-specialist.ts), [inspectFoundationConflict](../src/character-world.ts), [parseEventManifest](../src/event-manifest.ts), [authorEventCluster](../src/event-specialist.ts), [piAuthor](../src/foundation.ts), [parseInteractiveManifest](../src/interactive-specialist.ts), [originalSpecialistChallenge](../src/milestone-blueprint-correction.ts), [inspectSpecialistManifest, requireSpecialistManifest](../src/specialist-manifest.ts) | Parse exact source-bound report and validate bounded response or no-write claim. Invalid protocol -> bounded correction or sealed terminal, not native success. Independent native/Git and Review required before parent adoption. [Metadata recovery](../test/assignment-metadata-recovery.test.ts), [Generation](../test/generation.test.ts). |
| Native validation: [verifyArchitectureAssignmentResult, runArchitectureJob](../src/architecture.ts), [runCharacterWorldJob](../src/character-world.ts), [runCompositionWorkItem](../src/composition-work.ts), [runEventWorkItem](../src/event-work.ts), [focusedSourceCatalog, runFocusedWorkItem](../src/focused-work.ts), [executeFoundationGraph](../src/foundation.ts), [runInteractiveWorkItem](../src/interactive-work.ts), [createStoryValidateTool](../src/validator.ts) | Authenticate current source/plan/authorized paths, native validation, exact invocation/Git effect. Negative native or uncertain result cannot advance; original correction/assessment only. Tool result alone is not a commit. [Domain cutover](../test/domain-cutover.test.ts), [Generation](../test/generation.test.ts), [Focused](../test/focused-generation.test.ts). |
| Native and Review successor: [validateCloseoutDraft, reviewerAssignment](../src/cross-domain-closeout-work.ts), [preflightCompositionBoundary](../src/cross-domain-prerequisite-controller.ts), [native](../src/dependent-correction-work.ts), [validateRejectedRepairDraft, runNativeRepairRound](../src/rejected-review-repair.ts), [revalidateAfterReviewedCorrection](../src/selective-revalidation-work.ts) | Original signed field grant and independently reviewed successor are distinct; authenticate both before new closeout, validate affected-only re-review and final parent adoption. Negative or stale proof fences. [Integrated Turn](../web/test/integrated-story-turn.test.ts), [selective revalidation](../test/selective-revalidation.test.ts), [Review cycle](../test/issue-210-postcommit-review-cycle.test.ts). |
| Planning/no-write and authority: [reviewedAdaptiveOmissions](../src/adaptive-omission.ts), [resolveAdaptiveNoWriteSupersession](../src/adaptive-work.ts), [inspectCausalAmendment](../src/causal-amendment-controller.ts), [registerReviewDependency, approveDependency](../src/dependency-state.ts), [supportingWriterRounds](../src/dependency-work.ts), [verifyDraft](../src/idea-placement.ts), [executeOperationStrategy](../src/generation-operation-strategy.ts), [reconcile, applyLiveSteeringAtBoundary, dispatch, runFoundationAssignmentChild, runNarrativeAssignmentChild, runInteractiveAssignmentChildren](../src/generation.ts) | Parent admits the exact source-bound plan, owner, scope, omission or supporting work. Negative proof is not authorization; no-write work requires original proof. Read-only diagnosis cannot grant a writer. [Recovery lifecycle](../test/generation-recovery-lifecycle.test.ts), [operation recovery](../test/adaptive-operation-recovery.test.ts), [dependency amendments](../test/dependency-amendments.test.ts), [Generation](../test/generation.test.ts). |
| Read-only and continuation: [main](../src/cli.ts), [previewStoryMerge](../src/merge-preview.ts), [runNarrativeReview](../src/narrative-review.ts), [inspectBlockedOriginalThreadCorrection](../src/original-thread-continuation.ts), [prepareRecoveryFork](../src/recovery-fork.ts), [inspectProposal](../src/revision.ts), [reviewedMilestoneObjectives](../src/turn-fulfillment.ts) | Validate source/head/Turn/native/Review before inspection, preview or replacement. A historical receipt cannot invoke an obsolete writer. Final objective independently assessed. [Cutover](../test/recovery-cutover.test.ts), [fork](../web/test/current-checkpoint-fork.test.ts), [fulfillment](../test/turn-fulfillment.test.ts). |
| Studio handoff: [admitWholeApprovedStory, continueApprovedStoryChat](../web/src/lib/story-approved-continuation.server.ts), [prepareCachedJob](../web/src/lib/cached-jobs.server.ts), [initializeStoryBranch](../web/src/lib/git-cache.server.ts), [githubInitializationRequest](../web/src/lib/github-initialize.server.ts), [launchNaturalStory](../web/src/lib/natural-story.server.ts) | Authenticate owner, approved proposal, exact source and Turn before committing Foundation or queueing; effect ledger reconciles uncertain provider/worktree/queue starts and prevents duplicate admission. Foundation-only does not queue. [Discovery](../web/test/story-chat-discovery.test.ts), [approved continuation](../web/test/story-approved-continuation.test.ts), [integrated Turn](../web/test/integrated-story-turn.test.ts). |
| Studio worker: [runPersistedGeneration](../web/src/agent-runner.ts), [pumpAgentQueue](../web/src/agent-service.ts), [verifiedResumeAdmission](../web/src/lib/generation-controls.server.ts), [inspectRegisteredJob, generationJobRequest](../web/src/lib/fixture-jobs.server.ts), [advanceThread, recoverSettledThreadRuns](../web/src/lib/thread-chat.server.ts) | Current owner/Turn/graph Thread admission before provider/sandbox; queue claim and settlement use original durable effect; inspection no writer; lost settlement reconciled, no duplicate usage or execution. [Queue](../web/test/generation-queue.test.ts), [cutover](../test/recovery-cutover.test.ts), [integrated Turn](../web/test/integrated-story-turn.test.ts). |
| Studio revision / inspection: [reviewPublication](../web/src/lib/publication-review.server.ts), [prepareReplacementTurn](../web/src/lib/replacement-turn.server.ts), [validatedExplorer](../web/src/lib/story-explorer.server.ts), [verifiedReusableStoryFoundation, inspectExistingStoryFoundation](../web/src/lib/story-foundation-reuse.server.ts), [revisionFromSource](../web/src/lib/story-revision.server.ts), [branchEditedThreadMessage](../web/src/lib/thread-message-edit.server.ts), [verifyNewerStory, verifyPreparedStory, prepareThreadRestart](../web/src/lib/thread-restart.server.ts), [readThreadReview](../web/src/lib/thread-review.server.ts) | Revalidate exact owner, source, native checkpoint and replacement authorization before new Turn; read-only consumers cannot grant effects or expose private transcript. [Current fork](../web/test/current-checkpoint-fork.test.ts), [Thread continuation](../web/test/thread-continuation.test.ts), [Thread Review](../web/test/thread-review.test.ts). |

#### Integrated regression and fixes discovered during qualification

- [Approved continuation](../web/src/lib/story-approved-continuation.server.ts)
  previously committed the approved Foundation before pinning its Generation
  Turn. Pin the immutable admitted Turn before native commit; remove the
  early-Foundation missing-assurance exception in
  [checkpoint verification](../src/recovery-checkpoints.ts). A
  Foundation-only approval remains a distinct terminal path.
- [Composition prerequisite](../src/cross-domain-prerequisite-controller.ts)
  previously required the failed Event itself to have passed, even after
  authenticated Review correction. Require the same resolved successor
  coverage used by the other composite units, without relabeling the
  original failure or widening the Event grant.
- [Closeout](../src/cross-domain-closeout-work.ts) authenticates the original
  signed Event field grant and exact passing successor independently.
  [Selective impact](../src/selective-revalidation-controller.ts) uses that
  passing checkpoint as the correction predecessor and recognizes the
  exact Turn-bound pre-plan Foundation as unaffected, not unknown. Unrelated
  verified items are not reviewed again.
- The [integrated Studio test](../web/test/integrated-story-turn.test.ts)
  performs authenticated Question Sets and two Luna-style source defects,
  exact proposal approval, durable handoff with cumulative usage, real local
  Git worktree, duplicate continuation and queue claim, original Generation
  graph, native Event correction, failed independent Review and passing
  original-cycle successor, composite units, affected-only revalidation,
  native final validation, final objective verdict and Thread settlement.
  It asserts one Turn/execution, clean Git and unchanged source repo, exact
  cumulative model calls, no pending/active Case, no duplicate claim, and
  original negative Review preserved. The provider and sandbox transports
  are deterministic, not the graph, database, native validator or Git.
  The same test passed on real SQLite and PostgreSQL with no backend skips.
  Separate tests cover Foundation-only approval, fork continuation, nested
  author interrupt and prerequisite END re-entry.

The named producer gates are maintained change alarms rather than a
general proof of arbitrary JavaScript higher-order data flow. Coverage
claims concern the explicitly inventoried production boundaries and
behavioral regressions, not paid provider behavior. Live provider
certification and the downloaded native master artifact remain #260
responsibilities.

#### Incremental verification, 2026-11-24

Base `73f66f8`, Node 24.18.0, pnpm 11.15.0, installed native
NovelTea 1.0.0 (local Cruel/nt checkout `f842e3c6a`). Studio PostgreSQL
was a disposable PostgreSQL 17 Alpine container bound to a random
loopback port with a temporary credential; `NT_TEST_PG_URL` supplied
the actual connection. No backend substitution or paid provider call.

- `pnpm exec tsx --test test/generation-recovery-c08-matrix.test.ts test/generation-recovery-coverage.test.ts test/generation-model-consumer-coverage.test.ts test/generation-assignment-lifecycle.test.ts test/generation-recovery-graph.test.ts test/generation-operation-event-diagnostic.test.ts test/recovery-cutover.test.ts` — 65 passed, zero failures/skips before downstream audit extension. Final rerun of recovery coverage, model-consumer coverage and shared lifecycle: 32 passed, zero failures/skips, including both new downstream mutation checks.
- `pnpm exec tsx --test --test-name-pattern='R14D Event native correction.*support' test/generation.test.ts` — passed after typed suspension and final equality check, with real native validation, Git, scripted Pi, and persisted SQLite.
- `pnpm exec tsx --test --test-name-pattern='R14K canonical archive reaches|R14K current archive reaches|R14I production World question|R14D Event native correction.*(review|diagnosis)' test/generation.test.ts` — six passed, zero failures/skips, including final independent Turn fulfillment and all three nested author question variants.
- `pnpm --filter @noveltea/studio exec tsx --test test/story-chat-discovery.test.ts test/story-approved-continuation.test.ts test/current-checkpoint-fork.test.ts` — real SQLite and PostgreSQL Discovery and approved continuation passed; fork originally failed because of the unset environment restoration defect. Separate rerun of `test/current-checkpoint-fork.test.ts` after correction passed. No skipped backend.
- `pnpm exec tsx --test test/semantic-assignment-review.test.ts test/turn-fulfillment.test.ts test/generation-recovery-lifecycle.test.ts test/review-other-owner-controller.test.ts test/review-dependency-request.test.ts` — 59 passed, three private historical-replay-state tests skipped (require `NT_TEST_SEMANTIC_REPLAY_STATE` / `NT_TEST_S14_STATE`), zero failures.
- `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm --filter @noveltea/studio typecheck`, `pnpm --filter @noveltea/studio build` — all passed, including final production guard change; native validation/Git exercised through the above generator and Studio regressions. No unrelated full test suite.

These are the initial incremental results; the subsequent integrated runs
above and final verification below supersede the earlier seam-only status.
Separate live #260 certification is not established.

#### Integrated qualification, 2026-11-24

Source base `0362144` plus R14L integrated qualification changes.
Node 24.18.0, pnpm 11.15.0, actual local NovelTea CLI 1.0.0 from
Cruel/nt `f842e3c6a`, skills `a602b70`. PostgreSQL 17 Alpine ran
in a disposable container on a random loopback port. The connection
was provided by `NT_TEST_PG_URL`; `NT_REQUIRE_KYSELY_PROOF=1`
makes backend absence a failure. The CI matrix's integrated-recovery
entry provisions the same backend and actual native artifact rather
than relying on the ordinary Studio shard's optional PostgreSQL skip.

- `pnpm --filter @noveltea/studio exec tsx --test test/story-chat-discovery.test.ts test/story-approved-continuation.test.ts test/integrated-story-turn.test.ts test/current-checkpoint-fork.test.ts` with mandatory PostgreSQL proof — 6 passed, no skips/failures, including the same complete integrated original Turn on both databases.
- `pnpm exec tsx --test test/generation-recovery-coverage.test.ts test/generation-model-consumer-coverage.test.ts test/generation-assignment-lifecycle.test.ts test/generation-recovery-c08-matrix.test.ts test/generation-recovery-graph.test.ts test/generation-operation-event-diagnostic.test.ts test/recovery-cutover.test.ts test/selective-revalidation.test.ts test/selective-revalidation-receipt.test.ts` — 85 passed, zero failures/skips.
- `pnpm exec tsx --test test/generation-recovery-graph.test.ts test/generation-recovery-coverage.test.ts test/generation-model-consumer-coverage.test.ts` — 40 passed, zero failures/skips, after replay-fence, contradictory callback HEAD and typed-integrity propagation guard.
- `pnpm exec tsx --test --test-name-pattern='crash-cancel|nonconverging-continue-(cancel|budget)|review-native|review-reviewer-unavailable|review-session-unavailable' test/generation.test.ts` — 10 passed, no skips/failures, including the original-Thread author steering, budget and cancellation regressions.
- `pnpm exec tsx --test test/focused-generation.test.ts` — 8 passed, no failures/skips, including native focused commit restart and supporting writer/Review/omission prerequisites.
- `pnpm exec tsx --test test/generation-recovery-lifecycle.test.ts test/assignment-metadata-recovery.test.ts test/semantic-assignment-review.test.ts test/turn-fulfillment.test.ts test/review-other-owner-controller.test.ts test/review-dependency-request.test.ts test/adaptive-operation-recovery.test.ts test/job-pi-policy.test.ts test/issue-210-postcommit-review-cycle.test.ts test/dependency-amendments.test.ts` — 114 passed, 3 private historical replay inputs unavailable/skipped, zero failures. The private replay cases are not claimed as executed; deterministic scenarios exercise the current evidence and correction paths.
- `pnpm --filter @noveltea/studio exec tsx --test test/generation-queue.test.ts test/discovery-evidence.test.ts test/generation-controls.test.ts test/thread-live-steering.test.ts test/thread-continuation.test.ts test/thread-review.test.ts test/thread-usage.test.ts` — 28 passed, no skips/failures.
- `NT_NATIVE_CLI=<absolute native CLI> NT_SKILLS_CHECKOUT=<canonical skills checkout> pnpm certify:story` — 22 passed, no skips/failures (native contract, Git isolation, validator version and resume).
- `pnpm typecheck && pnpm lint && pnpm build && pnpm --filter @noveltea/studio typecheck && pnpm --filter @noveltea/studio build` — passed after the replay-fence projection guard.

All deterministic execution uses the current source-bound production
controller. No paid or live provider certification was performed.

Final verification on implementation commit `259e70b`:

- For each `i=1..6`, `NT_GENERATION_TEST_SHARD="$i/6" pnpm exec tsx --test --test-name-pattern='^(?!opt-in real Pi)' test/generation.test.ts`: all six shards passed; 62 deterministic cases passed, zero failures, two paid live cases intentionally skipped.
- With mandatory PostgreSQL proof, `pnpm --filter @noveltea/studio exec tsx --test test/integrated-story-turn.test.ts`: both actual backends passed, zero skips. The strengthened final assertions prove the original Event writer session, independent reviewer, exact failing commit and passing successor, one active-verified Case discharge, and cumulative meter.
- `pnpm exec tsx --test test/rejected-review-repair.test.ts test/focused-generation.test.ts`: 20 passed, zero failures, one unavailable private historical Event replay skipped (`NT_TEST_EVENT_REPAIR_STATE`, #162). Current deterministic repair, cancellation, focused support/END re-entry and restart paths passed.
- `pnpm --filter @noveltea/studio exec tsc --noEmit -p tsconfig.json`: passed with the final identity assertions.
- Workflow YAML parsed locally; hosted Actions execution is not claimed.

The parent author-intake boundary executes in the integrated run. The
actual queued author change and protected steering handoff are exercised
separately in the passing Generation `review-native-steer` and Studio
live-steering regressions. The private historical captures (#158, #161,
#162) were not available; current deterministic equivalents, not those
captured runs, support the acceptance claim. The two opt-in paid tests
and further live provider validation remain #260.

### R14 live qualification: precommit Review protocol exhaustion (#260)

The Architecture and Composition draft-review adapters retain the exact
review-round origin constraint in their model-visible protocol corrections.
The new `specialist_dispatch/return#19` is a recovery assessment exit, not a
writer-result or a commit-reconciliation grant. A typed precommit Review
protocol failure goes to the existing independent-review assessment, using
the originating review contract's transcript, admitted cycle, round, pinned
sources and prior verdict chain. The original writer's latest settlement is
verified separately against the unchanged draft. No writer terminal receipt
is created for a malformed reviewer verdict. Exhausted or untrusted evidence
remains blocked without writer replay, false Review approval or a renewed
protocol allowance. The production Blueprint regression exercises same-session
round-origin correction and the exhausted-reviewer parent disposition.

### R14 checkpoint qualification: Milestone source reads and Event realization (#260)

- `milestone-blueprint.ts` checks successful, current-round source reads before accepting any writer, independent reviewer, or diagnostic JSON. The read-only correction names exact missing `skill://` and Story-relative source addresses, retains the original session and budget, and rechecks the actual tool receipts. Interrupted or still-incomplete evidence never authorizes a fresh planner or an approval. The production #220 regression omits the catalog read from both the initial writer and reviewer, then verifies their same-session corrections and normal independent verdict progression.
- `event-work.ts` differentiates a missing formal Milestone binding from native-unreachable declared routes and source-scoped evidence findings. Only the original Event's controller-verified typed defects on its authenticated selected Milestone path are eligible for the existing diagnostic-bound successor; the original grant, effect, transcript and negative evidence remain intact. No binding can replace the independent semantic Review. Regression: `event-work.test.ts` (exact typed defect and rejection of another owner/path/code) and `generation.test.ts` (Event diagnostic continuation).
- The live certification harness prints bounded original failure details, actual blocked assignment and disposition, and eligible checkpoint identity, retaining full private observation evidence. The generic Foundation-only assertion is retired.

### R14 checkpoint qualification: Milestone protocol and inherited skills (#260)

- The Milestone planner, reviewer and diagnostician use the shared format-only response recovery after required read evidence is complete. Corrections retain the original read-only session, revoke tools and preserve source-bound verdict requirements. The controller supplies zero-based historical finding identities, the current provisional IDs and exact allowed fields; a removed Event must be cited against the original identity. The #220 production regression injects a one-based prior index and proves correction of that reply without extra tools or a fresh reviewer. `issue-227-milestone-review.test.ts` also rejects foreign IDs and nonexistent Blueprint fields.
- Checkpoint preparation preserves historical receipt snapshots and Event-only omission source identities, checking the original Event completion seal before allocating a child. New work uses the configured current skills; a partially inherited multi-unit specialist retains its already pinned shared assignment snapshot. The authenticated Studio fork regression changes skills between Event and Interactive, verifies original Event identity and current Interactive snapshot, and continues through Composition.
- The certification monitor consumes ordered controller activity by cursor, reports planning, round-specific independent Blueprint verdicts, source-read/format/substantive corrections and diagnosis, and logs verified Git and checkpoint identities. Shared writer correction admissions report their typed defects. Progress never substitutes for native or independent Review proof.


### #260 prospective source readiness and diagnostic correction (partial)

- `specialist_dispatch/return#10` (R): the approved Milestone design and
  current native catalog identify material Character predecessor work before
  any Event writer is invoked. The new throws at #5/#6 reject foreign or changed
  readiness proof; previous exits move by one return and two throws.
  `inspectEventBlueprintPrerequisite` revalidates the exact clean original
  source. This enters existing C06 owner/plan assessment; an authenticated
  unrealized Character with unambiguous delegated authority may dispatch
  the shared supporting assignment.
- C05 general diagnostic v3 retains the same four model consumer call sites
  and tool-free original session. Controller binding, field-specific format
  feedback, and sealed exhaustion inspection change their proof gates, not
  the allowance. A verified exhaustion is terminal protocol disposition,
  whereas a changed seal still fences. Historical v2 is inspection-only.
- Regressions: `test/issue-227-milestone-review.test.ts` (prospective witness,
  absent/foreign/duplicate declarations), `test/unknown-recovery-diagnostic.test.ts`
  (scripted Pi exact feedback, controller identities, restart, terminal
  exhaustion and tamper), `test/recovery-diagnostic-proposal.test.ts` (schema).
- The pre-Event supporting dependency is admitted through the same plan
  ledger and Focused writer/Review child as existing supporting work.
  `advanceFocusedDependency` delegates its former reviewer call to
  `runSupportingDependency`; no duplicate Review allowance is added.
  `admitDependency` shares planner admission across focused, Blueprint and
  Review sources. Blueprint candidates use native IDs and paths; ambiguous
  candidates require a read-only proposal. `approveDependency` validates
  narrowly scoped Character creation or existing-Character links to selected
  Arcs; all authorized Arc edits are audited. Nested support uses the same
  ledger, admission and child lifecycle, pins its original suspension, and
  re-enters only after independent verification of its descendant. The
  production focused-generation and multi-Arc Event regressions cover
  nested author answers, SQLite checkpoint loss after support commits,
  distinct canonical IDs and filenames, and original assignment advancement.
  Receipt-only replay preserves earlier dynamic child invocation slots.
  Negative supporting Review correction and generic selective dependent
  revalidation remain unqualified; a rejected support is not advanced.
  `rebindEventAfterBlueprintPredecessors` validates the
  successor catalog and retains the original Blueprint pin. The active-case
  discharge reauthenticates the verified dependency chain and Event receipt.
  The parent recovery node passes its original graph configuration to the
  existing operation adapter, not a new recovery controller.
- Review wire selectors bind exact before/after values in the controller,
  and transcript replay normalizes the same replies. The shared Event
  acceptance gate permits player-only inspection and returns field-specific
  semantic defects; generic unresolved in-scope conflicts use the original
  correction ledger rather than attempting to authenticate a nonexistent
  commit. Local Blueprint prompts emphasize the selected Milestone's causal
  limit and independent review of already-authored occurrences.
- R14D prospective production SQLite regression exercises the complete
  pre-dispatch Character/Arc writer, Review, rebind and resumed Event path.
  Remaining qualification includes arbitrary downstream no-write reports,
  ambiguous/existing out-of-lease or non-Character dependencies, and live
  full Story certification.

- #248 Milestone planner correction: `parseMilestoneBlueprint` separates mechanical shape admission from deterministic `milestoneBlueprintSourceFindings`. The planner response receipt accepts only the wire shape, not narrative validity. Negative source/authority findings are delivered to the existing independent Review and original planner with source scope and exact offending fields; an unchanged negative draft uses the existing Blueprint parent assessment. `ensureMilestoneBlueprint` records an explicit controller veto of any PASS with unresolved deterministic source findings, retains the original independent verdict and corrects through the same cycle; `assertRounds` replays rejected draft shapes and strictly validates approvals. No additional model consumer, retry allowance, canonical authority, or scheduler. Regressions: `issue-227-milestone-review.test.ts`, `issue-220-production-milestone-diagnostic.test.ts`, and `response-contract-recovery.test.ts`.

## #273 incremental parent-boundary correction

| Boundary | Reviewed disposition and evidence |
| --- | --- |
| `dependency_amendment/return#3`, `runReviewPrerequisiteChild` | Retain G (verified continuation); pin the entire independently verified supporting subtree, rather than the root receipt alone. R04 nested support verifies parent history and original session continuity. |
| `executeOperationStrategy` Blueprint prerequisite success | Existing active Case discharge requires independent parent reinspection of complete dependency history, current verified HEAD and original rebound receipt. No new model invocation or grant. |
| `recoveryNode/return#12–14`, `status#11–13`, `throw#5` | U/G/F: author control preserves pause/cancel; resume requires the same selected dependency strategy and every intervening committed effect independently attested; a lost original grant fences. R14D prospective-paused crosses a verified first support without replay. Prior subsequent exit ordinals shift by three returns/statuses and one throw. |
| `inspectModernGenerationRecovery` interrupted Blueprint support publication | Read-only exception for the exact already-admitted writer effect, verified native source and exact Git parent/diff; the prior published parent remains the historical lineage anchor. R14D tests the real committed support with its prior verified-HEAD receipt restored. Unauthenticated effects still fence. |

| Supporting assignment checkpoint/Review admission | Direct and nested support now enter ordinary checkpoint assurance and mandatory postcommit Review with the exact approved dependency assignment, not a synthesized Turn assignment. The read-only grant lookup authenticates the dependency plan and original writer/Git proof without recursively reading the Review ledger. |
| `runSupportingDependency`, `runSupportingChild`, `supportingWriterRounds` | The original logical child uses existing Review-round transitions and original-writer correction; a passing successor must be independently reattested before the ledger becomes verified. The support root stays immutable, the effective successor changes only after verification. A negative requiring unauthorized expansion is unresolved, not a new writer grant. R14D verifies real negative Review correction and interrupted corrective publication, and R04 verifies nested support. |
| `prepareRepairWriter`, `beginRejectedRepair`, `readRejectedRepairOrigin`, `verifyFinal`, `usesSharedAssignmentReview`, `usesCheckpointedReviewRounds`, `reviewSupportRoot` | Reuse the existing repair skill, sealed transcript, checkpoint and writer lease with the support identity. No new model consumer policy or allowance; Review is mandatory and the original failed checkpoint is not relabeled. |
| `executeOperationStrategy`, `inspectBlueprintSupportProgress`, `supportingBoundary`, `advanceFocusedDependency` | Carry the original Case into support correction and authenticate verified roots and repair chains on reentry. Original parent authority and dependency closure are unchanged. |

| `SupportingAssignmentStop`, `inspectSupportingReviewSelection`, `executeOperationStrategy` | Returned END is an authenticated outcome, not a generic exception. Persist the existing parent Case's selected support Review assessment before running the existing assessor. Reauthenticate the exact support root, grant and lineage; continue only on an authorized assessment, or seal the existing exhausted/protected disposition. |
| `runSupportingChild` physical namespace | Same logical assignment key; retain the parent task identity in the checkpoint namespace so a fresh task cannot inherit a prior END result. Replay of the same task does not repeat effects. |
| `inspectSupportingNativeFailure`, `authenticateSupportingNativeOrigin`, `inspectModernGenerationRecovery`, `recoveryNode/return#1` | Exact Case/assignment-bound native failure determines protocol exhaustion or existing diagnostic selection. Reinspect the original source across verified descendants; keep G for the outer recovery-node dispatch. A supporting failure never grants the Event writer a new repair scope. |
| `repairNativeMetadataDefects`, `nativeMetadataDefects` | Only exact Git-proved unchanged consumers of directly invalid owned records may contribute derived broken-reference diagnostics; no new path authority or bypass of final native validation. R14D native-protocol and exact-reference unit tests exercise the gate. |
| C08 deferred-two / existing selective revalidation and fulfillment gates | Two separate deferred Cases survive ordinary next dispatch; neither is silently discharged. Existing affected-only revalidation, receipt authentication, and steering/fulfillment tests remain authoritative. |

The shared parent interface is exercised by the R04/R14D production graph
regressions; remaining specialist adapter admission and lane integration
(including the legacy review-source root) belong to #274. Full cross-lane
and persistence qualification belongs to #275. Neither is implied by this
parent-boundary audit.

## #274 production adapter integration (partial)

The Event dispatch and C03 assessor now share the complete settled-invocation
proof gate. `diagnosticEvidence` calls `inspectEventNoWrite` under the existing
parent lease, rejecting a report whose digest is intact but whose invocation
proof is missing. R14D settled-no-write and stale-choice-finding exercise the
real SQLite graph, preserving the original Case and model-call count. The
digest-only synthetic test is a negative control, not evidence of a settled
writer. Reviewed AST gates reflect the strengthened authentication.

Current traceability (not final acceptance):

| Transferred issue | Production boundary and evidence | Outstanding integration |
| --- | --- | --- |
| #252 | `originalNoWriteOwnerProof`, `originalOwnerAdapter`, `executeOperationStrategy`: existing Interactive omission path retained. | General Choice/Puzzle and declined-omission corrective dispatch and original continuation. |
| #253 | `advanceFocusedDependency`, `runSupportingDependency`: existing #273 nested support and independent Review. | R07 across owner types, including existing out-of-authority records. |
| #254 | `correctPendingBlueprint`, `inspectCausalAmendment`: existing approved-source gates retained. | R08 actual upstream correction and affected-only continuation across Blueprint and Architecture. |
| #264 | Prior #274 keyword-route retirement; `inspectEventNoWrite` and `diagnosticEvidence` strengthened here. R14D future-choice, scene-evidence, settled-no-write, stale-choice-finding. | Generic owner-bound repair execution rather than diagnostic-only outcome; broader non-Character admission. |
| #265 | `preflightCompositionBoundary`, `advanceCrossDomainCloseout`: existing Event/Choice closeout retained. | General upstream prerequisite suspension and verified reentry for Composition. |
| #266 | Existing signed Architecture revision and independent Review boundaries retained. | Full residual boundary audit and qualification. |
| #267 | `inspectEventBlueprintPrerequisite`, `rebindEventAfterBlueprintPredecessors`, existing #250/#273 prospective support. | Authenticated pre-dispatch cross-assignment upstream contradiction and correction; no prospective pass as substitute. |

Other adapter audit and mandatory R07/R08 qualification remain open. No
additional corrective controller or writer grant is introduced.

### #274 follow-up: checkpointed Review-origin support

| Transferred requirement | Production boundary and verification | Residual scope |
| --- | --- | --- |
| #252 Interactive | `inspectInteractiveConflict` requires the original settled invocation and rederived source; R06 real Interactive Pi manifest correction rejects removed proof and modified assignment. Postcommit wrong-owner correction now enters the shared parent route for Choice/Puzzle as well as Event/Composition/Focused. | Precommit no-write owner amendment, declined omission and original writer continuation remain incomplete. |
| #253 cross-lane | `advanceReviewDependency`, `runSupportingDependency`, `inspectDependencyCheckpointAssignment` share the support writer/Review and original Case. R14D support and support-negative exercise an actual supporting creation, negative Review, original-session correction and original Event correction; R04 review/writer/nested/no-write exercise the actual Focused graph. R14D other-owner and other-owner-world authenticate previous Character and World producers and independently reviewed existing-record corrections with SQLite crash/reentry and ordinary next dispatch. | Multiple-owner and additional precommit missing-record cases remain; this is not blanket R07 certification. |
| #254 Blueprint/upstream | `reviewOtherOwnerCheckpoint`, `reviewOtherOwners`, `authorizeReviewOtherOwnerDependency`, `revalidateOtherOwnerPrerequisite` authenticate prior actual Git writer and precise inventory node in a whole-Story Turn (not merely record-type permission). `authenticateSettledEventNoWrite` is shared by causal amendment admission, historical approval incident and Event replay. | Pre-dispatch canonical Blueprint contradiction correction and full R08 acceptance remain. |
| #264 Event/Focused | R14D other-owner-world demonstrates a non-Character production support path; R14D settled-no-write and stale-choice-finding exercise authenticated no-write assessment; causal/archived gates now use the same proof. | Arbitrary precommit wrong-owner report execution and multiple-owner support remain. |
| #265 Composition | Existing postcommit source-linked repair enters shared Review-origin support; no local replacement scheduler or new writer grant. | General pre-dispatch missing Event/Choice/Puzzle/Character/World/Blueprint correction still needs production acceptance. |
| #266 Architecture | `inspectCausalAmendment`, `originalEvent` and `runEventWorkItem` require complete settled original no-write evidence, not an altered digest-only report. R14D negative invocation and substituted causal report controls exercise the shared gate. | Remaining residual boundary audit; no claim of full Architecture qualification. |
| #267 Blueprint | Source-backed historical causal admission is strengthened without a new Blueprint scheduler. | Upstream canonical correction from pre-dispatch Blueprint finding, verified descendant lineage and affected-only revalidation remain. |

AST audit changes are limited to the reviewed admission, dependency and
historical proof gates above. The Event settled response consumer moved
from the live wrapper to the shared immutable proof helper; no new model
call was added. The original parent dependency node now forwards its Case
ID into the existing supporting child. No graph return/throw sites changed.

An extended R14D World-owner run reached the next ordinary Event commit but
timed out before Interactive/Composition/final Review (240 seconds). The
bounded regression verifies recovery and next dispatch, not full-Story
completion. R07 downstream qualification and investigation of the prolonged
verification remain open.

### #274 follow-up: precommit existing-owner writer and Blueprint admission

| Transferred issue | Production boundary and verification | Remaining qualification |
| --- | --- | --- |
| #252 | `inspectInteractiveWriterDependency`, `rebindInteractiveAfterWriterDependency`, `runInteractiveAssignmentChildren` use the shared parent support child and original logical/session identity. R07 Choice and Puzzle both pass with native commits and mandatory independent Review. | Declined C06 omission requiring corrective execution rather than operator advice. |
| #253 | `reconstructWriterDependency`, `authorizeWriterDependency`, `advanceWriterDependency` authenticate the actual prior native producer, exact linked records and original obligation, then verify support and selective revalidation. R14D writer-other-owner exercises a real SQLite restart and next ordinary dispatch; R04 nested/other-owner-world cover nested and non-Character support. | Multiple sequential root findings and full integrated R07 progression. |
| #254 | `blueprintOwnerSeal`, `inspectEventWriterDependency`, `rebindEventAfterWriterDependency` distinguish a pre-dispatch Blueprint contradiction from a settled Event writer. R08 blueprint suspends for an earlier Event whose actual content prematurely concludes a later inquiry, removes the premature claim in a reviewed Git commit, obtains a new reviewed pin and commits the original later Event. | Expanded Accounts scenario, affected downstream consumers in the same R08 run and full R08 matrix. |
| #264 | `authenticateSettledEventNoWrite`, `inspectEventWriterDependency` and `runNarrativeAssignmentChild` admit a typed existing owner instead of choosing from conflict keywords. R14D writer-other-owner passes; prior future-choice and stale-choice-finding remain separate negative cases. | Broader missing-record and multiple-owner admission. |
| #265 | `inspectCompositionWriterDependency`, `rebindCompositionAfterWriterDependency`, `runNarrativeAssignmentChild` preserve the original writer session and independent editor; R07 composition passes. | Other missing record kinds and integrated downstream progression. |
| #266 | Existing Architecture protected approval and canonical Review boundaries unchanged by precommit writer reentry. | Full residual adapter audit. |
| #267 | `parseMilestoneBlueprint`, `runEventWorkItem` preserve the independently reviewed design with a typed earlier canonical correction before Event admission. R08 proves an actual earlier Event correction and newly reviewed descendant pin. | Expanded R08 qualification; Story Blueprint and existing challenge regression sweep. |

The C01 reviewed source-exit baseline adds the exact author-intake resume
guard and dependency-amendment return/throw for this source, not another
scheduler or Case ledger. R01/R02 and R14/R14L fingerprints cover the
changed shared child, native invocation, manifest and admission gates.
All 21 AST audit tests pass. The bounded scripted production regressions
are not evidence of completion of the remaining transferred requirements.

### #274 Review-origin suspension routing follow-up

The narrative child routes Review-origin prerequisite outcomes to the existing authenticated Review suspension adapter, not the settled no-write writer inspector. The R14D World-owner Review case and original-writer owner case exercise both branches.

### #274 cross-lane implementation and qualification record

This matrix supersedes the earlier **partial** #274 matrices above. Earlier
entries remain as development history. Implementation commits include
`dd342fc`, `67232a6`, `510fe21`, `16e104e`, and the follow-up changes
identified by the commit containing this record.

| Transferred acceptance | Corrected production boundary or justified retention | Executed regression / evidence |
| --- | --- | --- |
| #252: settled no-write and declined omission, exact Choice/Puzzle identity and protected commitments | `inspectInteractiveConflict`, `inspectInteractiveWriterDependency`, `prepareRetainedChoiceContinuation`, `executeRetainedChoice`, `runInteractiveAssignmentChildren`, `inspectRetainedChoiceCompletion`. A retained Choice executes under the original Case and archived negative, including a later typed prerequisite; no synthetic omission or advisory-only disposition. `verifyEventOnlyOmission` and `assertRevalidatedEventOnlySource` separate historical evidence from current authority. | R07 choice, puzzle, retained Choice native/independent/support; real Git commit, independent Review, original session and Case, next Puzzle, SQLite checkpoint replay, unchanged call count. R07 integrated verifies an actual affected Event-only omission after upstream correction. |
| #253: multiple owners, outside authority, prospective prerequisites, nested support, affected-only continuation | `reconstructWriterDependency`, `authorizeWriterDependency`, `advanceWriterDependency`, `advanceSuspendedWriter`, `runSupportingDependency`, `assertWriterAssignmentRoot`, `verifiedNarrativeChain`, `assertCompletedOtherOwnerRevalidation`. Existing prospective Character creation and Focused grants remain separate from authenticated existing-record correction. | R07 integrated Event → Character support → Event → Choice → World support → Choice/Puzzle → Composition → Event support → Composition → ordinary next scheduling; composition-multi proves sequential root findings; R04 review/writer/nested/no-write tests actual focused graph. R14D prospective-multi and other-owner regressions cover earlier producer authority. |
| #254: correction of realized canon, earlier consumers, new approved source lineage | `blueprintOwnerSeal`, `inspectEventWriterDependency`, `rebindEventAfterWriterDependency`, `correctPendingBlueprint`, `historicalMilestoneHandoff`. Last actual producer is checked even if a later cross-domain grant edited the canonical record; revalidation starts at first verified realization. Existing source-bound causal amendment/approval rules retained. | R08 blueprint and blueprint-consumer: original Story Blueprint/Architecture precede Milestone work; earlier Event prematurely depicts search, recovery, testimony and inquiry conclusion. Actual prior record corrected in independently reviewed Git commit, earlier realized Interactive consumer independently revalidated, new reviewed Milestone pin accepted, substituted old approval refused, original later Event commits. |
| #264: Event and Focused typed recovery without keywords or competing terminal policy | `authenticateSettledEventNoWrite`, `inspectEventNoWrite`, `diagnosticEvidence`, `runNarrativeAssignmentChild`, `runFocusedAssignmentChild`. Removed keyword policy; no-write conflict does not create ownership or a fake effect. Existing bounded Focused authority is unchanged. | R14D future-choice, stale-choice-finding, settled-no-write and writer-other-owner; R04 production focus review/writer/nested/no-write; R07 actual Event→Character, Choice→World, Composition→Event. |
| #265: Composition upstream and independent editorial correction | `inspectCompositionWriterDependency`, `rebindCompositionAfterWriterDependency`, `runNarrativeAssignmentChild`, `advanceCrossDomainCloseout`, `authorMilestoneCloseout`. Composition's native and independent editorial/assignment Review remain mandatory; no writer starts against an unmet admitted prerequisite. Closeout field-only native feedback uses typed defects and common material-progress policy, not free text or fixed retry ceiling. | R07 composition, composition-multi, composition-choice, composition-puzzle and integrated. Existing composition-review policy/pin/roundtrip, cross-domain closeout successor and prerequisite tests retain independent negative evidence and protect scope. |
| #266: canonical Architecture precommit/source/plan/revision/Review boundaries | `runArchitectureAssignmentChild`, `verifyArchitectureReviewOrigin`, `inspectCausalAmendment` and `originalEvent` remain the source-bound writer and independent review authorities. No new preapproval Git grant; causal no-write proof strengthened in earlier commits. | R08 actual production Story Blueprint/Architecture before the challenged Milestone; source-bound compact Blueprint, Architecture draft Review, architecture patch and challenge tests; R01/R02 source gate fingerprints. |
| #267: Blueprint substantive vs format failures, prospective vs canonical contradiction | `parseMilestoneBlueprint`, `readReviewedMilestoneBlueprint`, `correctPendingBlueprint`, `runEventWorkItem`, `rebindEventAfterBlueprintPredecessors`. Typed contradiction does not inherit prospective approval as canonical correction; historical pin remains exact, then fresh independent approval. Existing #248 protocol/semantic split and #250/#268 parent strategies retained. | R08 blueprint/blueprint-consumer and forged pin control, R14D prospective-multi/future-choice, #205 compact Blueprint, #227 substantive-rejection and approved-source challenge tests. |

Residual production adapter audit (existing authority is retained rather than
duplicated):

| Adapter | Authority and disposition | Regression / reviewed source |
| --- | --- | --- |
| Foundation | `runFoundationAssignmentChild` uses original approved source and shared round transition; no draft-status approval or replacement foundation writer. | chat-approved-foundation, foundation-provenance, R01/R02 |
| World / Character | `runCharacterWorldAssignmentChild` retains separate original units, world approval before Character, and shared postcommit repair. Supporting correction uses the actual producer, not the coarse lane. | R07 integrated, R14D other-owner-world, original World/Character handoff gates |
| Architecture / Story and Milestone Blueprint | Original source, signed scope and precommit independent approval are separate from native commit and postcommit Review. Shared progress and substantive-vs-protocol assessment remain authoritative. | R08, #205/#206/#227, blueprint-challenge, R01/R02 |
| Planning / idea placement | `selectIdeaTask`, `scheduleIdeasAtBoundary`, `runIdeaPlacement` use eligible bounded source and original receipt; model-selected location is advisory until existing parent admission. Format correction cannot admit an extra writer. | idea-placement, original idea capture/acknowledgement regressions, R14L consumer inventory |
| Discovery / handoff | `parseDiscoverySemanticVerdict`, `parseDiscoverySemanticDiagnostic`, existing Discovery handoff keep immutable claim/source/author text and independent Review; no Generation identity or preapproval Git authority. | discovery-semantic-review, R14 Discovery/handoff and R14I question gates |
| Global Review / completion | `prepareSemanticReview`, `sealIndependentReview`, `inspectPostcommitReviewCycle`, `completion_decision` preserve genuine multi-source independent review and negative predecessors; historical scans are restricted to inspection, live completion still requires exact source or verified revalidation. | narrative-review, review-convergence, selective-revalidation, R07/R08 and R02/R14L |

C01 graph return/throw inventory changes are limited to the shared
parent/suspended-child routing already recorded above. R01/R02/R14/R14L
proof and consumer gates cover the changed functions; typed closeout native
feedback is not a new scheduler. The original-thread omission continuation
is verified, not a new authorization to transfer revalidated changed bytes
into an independent fork. Full-suite, persistence and final consolidated
qualification remain #275, not an inference from an individual lane pass.

## #275 consolidated deterministic qualification

Source under qualification: integrated `48b6756` (#274), including parent
progression `3fa3179`, `eed0686`, `1e64bce` (#273). Completed baseline
`aa449d8` (#248), `583409b` (#250), and `e4e0a88` (#268) is retained. The
transferred ticket requirements above are still normative. The rows below
identify what the combined regressions actually exercise; none turns a
selected strategy or child `verified` outcome into proof of Story completion.

### Compositional production matrix

Use the same [Generation parent](../src/generation.ts) and shared
[assignment child](../src/generation-assignment-lifecycle.ts) with the real
native CLI, Git and SQLite. The [Studio Turn](../web/test/integrated-story-turn.test.ts)
adds real Studio persistence, handoff and queue ownership to the same
Generation path. Only Pi transport (and the Studio test's external provider
and sandbox transport) is scripted. These are overlapping configurations of
existing seams, not parallel schedulers.

| Origin, topology and authority | Execution → independent verifier → same logical work / scheduling | Evidence on integrated source |
| --- | --- | --- |
| #248/#267: well-formed witness/availability error, substantive stagnation; distinct malformed-JSON control | [Milestone planner and Review](../src/milestone-blueprint.ts) seal semantic source findings; [Blueprint reassessment](../src/blueprint-reassessment.ts) authenticates a fresh independent diagnosis and allows the original writer/Review to correct the exact rejected source. Malformed JSON instead uses finite zero-tool response correction with no Review or pin. | `R14D ... source-recovery` and `#220` production Milestone diagnostic; source regression compares original sessions, retained negative rounds, approved successor, discharge, and subsequent prerequisite/original Event. |
| #250/#259/#268: one or two prospective witnesses under a Milestone, multiple Arcs with IDs that differ from file paths; ambiguity and unauthorized selection | [Dependency admission](../src/dependency-state.ts) derives candidates from native source and the reviewed pin; the planner proposes only necessary Arc links. [Parent strategy](../src/generation-operation-strategy.ts) verifies all supporting work and re-enters the original Event. A sealed ambiguity/refusal remains unresolved; foreign scope is refused without a writer. | `R14D ... prospective[-multi\|-refused\|-unauthorized]`; the multi-Arc case checks exact Character IDs, Milestone anchor, native Arc paths, verified inventory, next dispatch and cumulative charges. This preflight has no original Event writer to reopen; the descendant gets a new source-bound grant for the same pending Work-plan item. |
| #259/#253: negative supporting Review, diagnostic continuation, supporting writer requiring support | [Supporting assignment](../src/dependency-work.ts) releases writer claim at END, retains original Case and scoped receipts, and verifies support before original re-entry. An independently diagnosed continuation must commit and pass Review, not just return advice. | `R14D ... prospective-review-{negative,stalled,stalled-continue,author,native-protocol}` and `R04 ... nested`; compare failed predecessor and passing successor, restart and distinct authority/resource controls. |
| Milestone Blueprint diagnosis: unavailable pinned provider or sealed escalation | [Milestone Blueprint](../src/milestone-blueprint.ts) restores the settled phase only for typed pre-invocation admission failures. The [parent](../src/generation-operation-strategy.ts) reauthenticates the exact private approval before discharge, or the sealed diagnostic response before an unresolved stop. | `R14D ... source-provider-pause` reopens SQLite and resumes the same Case and distinct writer/Review conversations through approval and ordinary scheduling. `source-diagnostic-stop` preserves all negative rounds, reports `exhausted/nonconverging`, withholds approval and dispatches no extra model or writer. |
| Independently deferred Idea Cases and historical discharge | [Recovery resolution](../src/generation-recovery-resolution.ts) discharges only the exact Idea with a verified placement, and verifies a historical discharge against its original commit even after a later independent reassessment. | `C08 ... deferred-two` observes two pending identities, then discharges them separately after native/Git/Pi placements. It verifies both original discharges survive inspection after reassessment, with exactly 16 model calls and no replay. |
| #252/#253/#264/#265: Event → Character; Choice → World; Composition → existing Event, Character, World, Choice or Puzzle; earlier Review vs writer origin | [Writer dependency](../src/writer-dependency.ts) seals original producer, existing authority and pending phase. [Resolved support](../src/generation-recovery-resolution.ts) checks native/independent Review and [affected-only revalidation](../src/selective-revalidation-work.ts); the original work must finish and return to parent scheduling. | `R07 integrated`, `R07 composition*`, `R07 choice`, `R07 puzzle`, `R07 retained Choice`, and `R04` Focused. Includes changed-source omission revalidation, reviewed material carried forward, repeated SQLite checkpoint replay, and Event no-write without fabricated effects. |
| #275 C04: Character → existing, independently reviewed World | The original Character no-write manifest and session are sealed; the shared writer-dependency path grants only the cited existing Fact/World Entity. The World-only historical revalidation projection never completes the still-pending Foundations item. Verified support re-enters the original Character child and Pi session. | `C04 typed Character prerequisite supports reviewed World and resumes the original assignment` (production SQLite/native/Git); paired with the free-text World no-write refusal. |
| #254/#266/#267: canonical Architecture and both Blueprint levels; actual earlier Event has later search, recovery and testimony | [Event admission](../src/event-work.ts) turns the approved provisional contradiction into typed canonical owner work. [Historical Blueprint handoff](../src/milestone-obligation-handoff.ts) preserves the original approval and refuses substitution. Actual tightly scoped Git correction and independent revalidation precede a new source approval and the original later Event. | `R08 blueprint` and `blueprint-consumer`; verifies earlier Interaction where present, unrelated Foundation unchanged, new Review pin, later Event verification, next scheduling and exact charges. Existing architecture draft and approved-source challenge regressions are separate boundaries. |
| #272: approved Story starts one Turn with cumulative budget, author controls and final objective | [Discovery](../web/src/lib/discovery-graph.server.ts) → [approved handoff](../web/src/lib/story-approved-continuation.server.ts) → [queue/worker](../web/src/agent-service.ts) → Generation native/independent Review → [final objective](../src/turn-fulfillment.ts). Durable Studio source/approval/queue receipts do not confer verified Git effects. | `integrated-story-turn` on both DBs; `story-chat-discovery`, `story-approved-continuation`, `current-checkpoint-fork`. `R14I` distinguishes genuine nested author interruption from END-returned support; `R01` tests current-contract CLI/server ownership, steering, protected consent, budget, cancellation and corrupted or uncertain operation receipts. |

### Execution and verification exits

| Parent disposition / adapter | Effect authority and exit evidence |
| --- | --- |
| `known-correction/response-contract` | [Generation recovery wrapper](../src/generation.ts) returns to the existing planner session/helper. [Response contracts](../src/response-contract-recovery.ts) limit format-only prompts and revoke write tools. New output is revalidated at the original consumer; exhausting the allowance is not an independent negative Review. |
| `known-correction/review-cycle` and `assignment-diagnostic` | [Operation strategy](../src/generation-operation-strategy.ts) authenticates the exact original negative Review/diagnostic, then re-enters the owning child or the separately sealed Blueprint Review. [Recovery resolution](../src/generation-recovery-resolution.ts) verifies current-source successor or sealed private Blueprint approval. A returned recommendation does not resolve a Case. |
| `plan-amendment/dependency-work` | [Dependency admission and support](../src/dependency-work.ts) authenticate parent scope, original no-write or Review, each planner proposal, and a verified support chain. `executeOperationStrategy` verifies history, current HEAD and original prerequisite satisfaction before clearing the active Case; Focused/other writer and Review suspensions authenticate their saved re-entry phase separately. |
| `plan-amendment/adaptive-work` | [Adaptive omission](../src/adaptive-omission.ts) and [retained Choice execution](../src/interactive-work.ts) distinguish independently verified omission from existing obligation. Same negative receipt is retained on declined omission and the original Choice or its support must verify before progressing to Puzzle. |
| `plan-amendment/cross-domain-closeout` | [Composition preflight](../src/cross-domain-prerequisite-controller.ts) binds outstanding causal fields to original Event authority. [Closeout](../src/cross-domain-closeout-work.ts) checks exact native delta and independent successor Review, then revalidates affected dependents before parent scheduling. |
| `continue-independent`, reconciliation and completion | [Recovery lifecycle](../src/generation-recovery-lifecycle.ts) preserves deferred Cases and rejects conflicting/duplicate source. [Generation parent](../src/generation.ts) rechecks inventory/current plan and runs safe author intake before dispatch; verified independent progress cannot discharge another Case. [Turn fulfillment](../src/turn-fulfillment.ts) independently verifies objective at the current source. |
| Author interrupt, resource pause, cancellation, untrusted effects | [Generation author question](../src/generation-author-question.ts) authenticates the pending task and answer; a child that returned END has no pending task. [Studio discovery evidence](../web/src/lib/discovery-evidence.server.ts) and [worker queue claim](../web/src/agent-service.ts) separately authenticate across their effect boundaries. Real pause preserves original resource/authority; cancelled Turn is terminal; ambiguous external effects are preserved and fenced. |

### Disposition checks and limitations

The [R14L transitive reply and effect consumer inventory](#r14l-incremental-qualification-272)
and [#274 adapter crosswalk](#274-cross-lane-implementation-and-qualification-record)
remain the source-linked change alarms for native, Planning, diagnostic,
Review, Studio provider/queue/handoff and completion exits. The separate
[behavioral mutation runner](../scripts/qualify-recovery-mutations.mjs) runs
only real production-seam tests in disposable source copies. It requires each
unmodified test to pass and each mutated source to fail at the designated
behavioral assertion, not at build/import failure or an AST fingerprint:

- authenticated planner ambiguity/refusal becomes an integrity fence;
- structurally valid but semantically wrong witness data is checked as a
  response-contract/format failure;
- an authenticated diagnostic `continue` result terminates at advice before
  support correction, verification and original Case discharge.

This is not exhaustive semantic verification of arbitrary higher-order
consumer flow. In particular, `originalOwnerAdapter` covers only specific
sealed source capabilities. The C04 World no-write regression still expects
`unsupported-implementation` for its free-text report without a typed
source-bound grant. The typed Character→World regression separately exercises
the executable existing-record support route through native commit, passing
independent Review, affected-only revalidation, original assignment/session
re-entry and parent verification, followed by ordinary scheduling. It also
rejects tampering with the archived finding without additional model charges.
The latter is not authority to edit an Arc, Milestone, protected decision,
or arbitrary earlier record. The new historical receipt verifier and
support-bound re-entry helpers are fingerprinted by R01/R02; the old direct
manifest-consumer alarm moves to the sealed invocation proof rather than a
second parsing of the final turn. `executeOperationStrategy` also retains a sealed
advisory stop when the controller cannot authenticate a proposed diagnostic
strategy. Such a stop is valid only where the controller lacks a safe grant;
its existence does not qualify every proposed owner/scope combination. The
matrix above tests the executable known routes listed, not every combination
of adapters and failure origins. Full #275 closure and paid #260 certification
remain blocked wherever that proof is missing.

### Reproduction environment

Node 24.18.0, pnpm 11.15.0, installed NovelTea CLI 1.0.0, local skills
`4d92c75`. Use absolute paths via `NT_NATIVE_CLI` / `NT_SKILLS_CHECKOUT`.
Studio PostgreSQL is a disposable `postgres:17-alpine` container with a
random loopback port and private credentials in `NT_TEST_PG_URL`; require it
with `NT_REQUIRE_KYSELY_PROOF=1`. Also set `NT_KYSELY_PROOF_URL` to the same
URL for the separate transaction proof and `NT_REAL_NATIVE_CLI` to the
installed binary for Studio tests that probe the native CLI. SQLite uses actual persisted Studio and
Generation files in disposable fixtures. `LANGSMITH_TRACING=false`,
`LANGCHAIN_TRACING_V2=false`, `TRACE_TO_LANGSMITH=false`; no live opt-ins,
private captured fixtures, or paid provider calls.

### Verification record

- The handoff's completed Generation shards 1, 2-rerun, 3, 4, 5 and 6 passed **98** tests, skipped **2**, and had no failures or cancellations on the pre-Character-support source. The initial shard 2 failure was rerun in isolation. Logs: `/tmp/nt275-current.kk8bFV/generation-{1,2-rerun,3,4,5,6}.log` and corresponding exit files.
- The new C04 positive regression first failed at actual Generation suspension/admission (unsupported producer). Following implementation, a focused red→green run passed the same-session native/Review/parent verification. The final `pnpm exec tsx --test --test-name-pattern='^C04' test/generation.test.ts` run passed **2** tests, including archive tampering, SQLite close/reopen before the original Character re-entry, unchanged assignment scope and Pi session, exact cumulative charges, and ordinary next dispatch; the free-text World regression did not authorize any additional writer. The adjacent integrated Event/Interactive/Composition and World/Character correction cases passed alongside both C04 cases (4 passed). Source and effect consumer alarms were updated only for the changed proof gates; all **25** C01/R01/R02/R14L/C08 checks passed. Adjacent World/Character, dependency-amendment, selective-revalidation and shared lifecycle/graph checks passed **62**, skipped **1**, with no failures. Root typecheck, lint and build passed again after the final receipt-binding guard, and Studio typecheck/build and all 22 native certification tests passed on the Character-support implementation. The four focused Studio files (`story-chat-discovery`, `story-approved-continuation`, `integrated-story-turn`, `current-checkpoint-fork`) passed again on the Character-support implementation (**6 passed**, no skips), including the integrated original Turn on SQLite and PostgreSQL. Logs: `/tmp/nt275-character-{restart-guard,final-focus,adjacent,alarms-final,native,studio-focus}.log`. The full pre-Character-support suites were not repeated after this scoped change. No paid provider calls were made.

- On the follow-up, `pnpm exec tsx --test --test-name-pattern='source-diagnostic-stop$|source-recovery$' test/generation.test.ts`, plus the `source-provider-pause$` and `deferred-two$` selections, passed all four cases. Red reproductions observed an integrity fence instead of a sealed diagnostic stop, a paused record stuck in `diagnosing`, and two otherwise valid discharges rejected after an Idea reassessment.
- The full Studio run with both URL variables and both native CLI variables set (`pnpm exec tsx --test --test-concurrency=2 test/*.test.ts test/*.test.tsx` in `web/`) had **555 passed, 5 skipped, 0 failures**. After the remaining parent changes, the four focused Studio files listed below passed again (**6 passed, 0 skipped**), including the original Turn on SQLite and PostgreSQL. `pnpm certify:story` passed all **22** native certification tests again.
- `pnpm exec tsx --test --test-concurrency=2` across `test/*.test.ts` except `test/generation.test.ts` passed **872**, skipped **43**, with no failures or cancellations. The first repeat caught the expected consumer fingerprint changes and timed out in the multi-cycle #202/#203 fixture. The final repeat used the updated source alarms and a larger fixture timeout (no production budget changes).
- `node scripts/qualify-recovery-mutations.mjs` passed **3 baselines** and rejected **3 mutants** at the intended assertions. Root typecheck, lint, format check and build, and Studio typegen, typecheck and build also passed on the production fixes.

Earlier qualification on `9dc8ca4`:

- `pnpm --filter @noveltea/studio exec tsx --test test/story-chat-discovery.test.ts test/story-approved-continuation.test.ts test/integrated-story-turn.test.ts test/current-checkpoint-fork.test.ts`: **6 passed**, no backend skips. Both databases ran the complete original Studio Turn.
- `pnpm certify:story`: **22 passed**, no skips. Native executable, protected edits, source-bound validation, Git isolation, restart and CLI version covered.
- `pnpm exec tsx --test test/generation-model-consumer-coverage.test.ts test/generation-recovery-coverage.test.ts test/generation-recovery-c08-matrix.test.ts test/generation-assignment-lifecycle.test.ts test/generation-recovery-graph.test.ts`: **57 passed**, no skips. These are supplemental source alarms and focused authority tests, not the compositional matrix by themselves.
- `pnpm exec tsx --test test/issue-220-production-milestone-diagnostic.test.ts`: **1 passed**, including genuine malformed Blueprint exhaustion (two tool-free retries, no rounds or approval) and the false independent PASS control. `pnpm exec tsx --test --test-name-pattern='^R08' test/generation.test.ts`: **2 passed**, including parent verification and next scheduling after real upstream correction.
- `pnpm exec tsx --test --test-name-pattern='^R07 integrated' test/generation.test.ts`: **1 passed**. The wider `R07|R08|R04|C08|R14I|R14D.*(prospective|diagnosis)` selection across `test/generation.test.ts test/focused-generation.test.ts` was stopped after the four R04 Focused scenarios and the R07/R08 upstream variants passed; it is not a completed sweep. `pnpm exec tsx --test --test-name-pattern='^R14I|^C08.*deferred-two$' test/generation.test.ts`: **4 passed** (crash, public CLI and Studio nested-interrupt variants, plus two independent deferred Cases).
- `pnpm exec tsx --test --test-name-pattern='R14D.* (prospective-multi|prospective-review-negative|prospective-paused)$' test/generation.test.ts`: the multi-Arc reproduction passed. The pause variant timed out in the concurrent run. Rerunning the `prospective-paused` and `prospective-review-negative` pair with an extended fixture timeout passed both, no skips.
- `node scripts/qualify-recovery-mutations.mjs`: **3 production baselines passed, 3 mutants rejected** at the named disposition/continuation assertions. Isolating each run in its own process and allowing the multi-commit diagnostic fixture more time avoided a timeout contaminating the next test's fixture environment. The existing `integrated-recovery` native CI entry now runs these controls; hosted CI execution is not claimed.
- `NT_KYSELY_PROOF_URL="$NT_TEST_PG_URL" NT_REAL_NATIVE_CLI="$NT_NATIVE_CLI" pnpm --filter @noveltea/studio exec tsx --test test/kysely-guards.test.ts test/story-explorer.test.ts test/gitlab-initialize.test.ts`: **21 passed**, no skips. The first full Studio run provided the Studio DB URL but omitted the separate transaction-proof URL; the targeted rerun supplies both.
- `pnpm typecheck`, `pnpm lint` (including Studio persistence boundary), `pnpm format:check`, `pnpm build`, `pnpm --filter @noveltea/studio typegen:check`, `pnpm --filter @noveltea/studio typecheck`, `pnpm --filter @noveltea/studio build`: **passed** after making the Arc array required in the multi-Arc test fixture. The integrated baseline failed Studio typecheck with TS2488 at the optional Arc-array spread. No production type or validator grant was loosened.

The full-suite attempt covered the root files with `pnpm exec tsx --test
--test-concurrency=4` (excluding `test/generation.test.ts`), all six
`NT_GENERATION_TEST_SHARD=i/6 node --import tsx --test test/generation.test.ts`
shards in private source copies to isolate CLI build products, and Studio
with `pnpm exec tsx --test --test-concurrency=4 test/*.test.ts test/*.test.tsx`
from `web/`. The run did **not** qualify the full suite. The Studio run
reported 538 passed, 8 skipped and one setup failure (missing
`NT_KYSELY_PROOF_URL`, see passing rerun above). The non-Generation root
run reported 870 passed, 43 skipped and two cancellations from timeouts
in the production adaptive and #202/#203 Blueprint regressions. Both passed
on focused reruns: `pnpm exec tsx --test test/issue-191-production-pi.test.ts`
(1 passed), and `pnpm exec tsx --test test/adaptive-protocol-graph.test.ts
 test/issue-202-production-blueprint.test.ts` (2 passed, no skips).
The six concurrent Generation shards reported 85 passed, 2 skipped,
5 cancellations from timeouts and 6 failures (including subsequent
original-source fences). Focused passes do not replace the full-suite
requirement. Browser, paid Pi,
private replay captures and optional hosted-sandbox coverage are not claimed.
Do not close #275 or enable paid #260 on this record.

### #275 follow-up: native support and Review diagnosis

The new R14D `prospective-review-native-diagnosis` and
`prospective-writer-native-diagnosis` cases exercise real Blueprint support
native nonconvergence, exact source-bound read-only diagnosis, the original
corrective owner/session, independent Review, the original parent Case
discharge, and next ordinary Event scheduling. The first also exhausts and
restores the same budget before the new invocation and reopens SQLite.
R01 `review-native-diagnosis` independently exercises the ordinary
Foundation Review repair path, retaining the original negative verdict and
then verifying and resuming its parent assignment. The precommit reproduction
initially fenced a derived Arc-to-Character broken reference; the exact
link-only derived-reference guard fixes it without broadening scope.
The writer regression also corrupts and restores the historical diagnosis
transcript after discharge; inspection must fence and spend no new calls.

R01/R02 source proof fingerprints and the direct/transitive effect consumer
gates were updated for the affected child and repair continuations, the
three new pause exits, published grant inspection, and their proof helpers.
These changes reuse the existing Case and dependency ledgers. The subsequent
ordinary-suspension correction below generalizes this assessor re-entry to
writer-, Focused- and Review-origin dependency-amendment paths.

Full-suite qualification is deliberately deferred by the author; the prior
suite runs remain historical evidence only. No paid provider calls.

Targeted verification on the follow-up implementation (local native CLI and
skills checkout; tracing disabled): root typecheck passed; the three recovery
coverage/consumer/matrix files passed 25/25; the final Generation selection
`prospective-(writer|review)-native-diagnosis$|\(review-native-diagnosis\)$|R14D.* (prospective-multi|other-owner)$`
passed 5/5 with no skips or cancellations. This includes historical transcript
tamper detection. Logs: `/tmp/nt275-history-targeted.log`,
`/tmp/nt275-history-audit-final.log`, `/tmp/nt275-history-type3.log`.
The two added behavioral mutation controls await the later qualification run.

### #275 follow-up: ordinary suspended prerequisite recovery

The shared dependency inspector now binds a supporting tree to either its
original Blueprint report or its exact original suspended writer/Focused/Review
report. It validates ancestry, original child identity and terminal evidence.
The original dependency-amendment node yields an authenticated native or
Review-assessment handoff to the existing assessor; the Review-origin path
retains its original Case. The assessor uses the same dependency-work
continuation and supporting Review boundary, then verifies the original
support subtree before re-entering the original consumer. A native diagnostic
does not grant an additional record or replacement session. The published
support verification binds the captured terminal to the actual historical
diagnostic grant. Review-origin re-entry reattests published support, not
merely its recorded pass. The same inspector handles interrupted publication
for ordinary suspensions. Existing-record derived references are limited to
the exact invalid owned ID and unchanged original Git bytes of the consumer.

New graph exits: dependency_amendment returns #4/#6 request an authenticated
assessment of an existing Case; #5/#7 admit a typed new dependency-amendment
observation; recoveryNode return #29 selects the existing Case's diagnostic,
exhaustion or supporting Review assessment, not a writer grant. The extracted
ordinary dependency authentication and continuation helpers and shared
support-owner/Review selectors are now fingerprinted as part of R02.
The direct/transitive consumer and C01/C08 inventories were refreshed for
the changed source boundaries, not relaxed.

Targeted deterministic evidence (local native CLI, local skills checkout,
tracing disabled; no paid provider):
- C04 typed Character prerequisite and its new native-diagnosis variant:
  original Character -> reviewed World Fact support -> same Character
  assignment, SQLite reopen, affected-only revalidation and scheduling.
- R04 writer-native-diagnosis and review-native-diagnosis: existing Character
  support reaches native nonconvergence, returns to the same supporting
  writer with a sealed diagnosis and independently verified result; the
  suspended original Focused writer or negative Review then resumes.
  The ordinary nested-support crash/re-entry and no-write controls also pass.
- Root typecheck and the three recovery coverage/consumer/matrix files
  pass (25/25 audit tests). Logs: `/tmp/nt275-final-type.log`,
  `/tmp/nt275-final-focused.log`, `/tmp/nt275-final-generation.log`,
  `/tmp/nt275-final-audit2.log`.

The author explicitly deferred the full qualification run. The targeted
ordinary-origin cases exercise native writer nonconvergence; the shared
supporting Review-assessment routing is not independently certified by these
new cases. The broader cross-product, mutation controls, full root and Studio
runs and both DB backend runs on this final source remain qualification work.
Do not close #275 or enable paid #260 until the deferred acceptance is passed.

Final targeted commands on this follow-up source:
```sh
pnpm typecheck
pnpm exec tsx --test --test-name-pattern='R04.*(native-diagnosis|nested|support-no-write)' test/focused-generation.test.ts
pnpm exec tsx --test --test-name-pattern='C04.*(native diagnosis|prerequisite)|prospective-(writer|review)-native-diagnosis$' test/generation.test.ts
pnpm exec tsx --test test/generation-recovery-coverage.test.ts test/generation-model-consumer-coverage.test.ts test/generation-recovery-c08-matrix.test.ts
```
The Focused and Generation selections each passed 4/4, with zero failures,
skips or cancellations; the Generation selection includes both earlier
Blueprint native-diagnosis continuations. The source audit passed 25/25.

The previously unqualified supporting Review-assessment route is now
independently exercised by the R04 `writer-review-assessment` and
`review-review-assessment` regressions. Each executes two cosmetic repairs
with negative independent verdicts, checkpoints the actual supporting
Review assessment before calling the read-only diagnostic, reopens SQLite,
executes the same supporting writer's third correction, independently reviews
the material change, and resumes the original parent. The writer case
discharges its own support Case; the Review case retains the existing negative
Review Case and seals the original reassessment. Original session, logical
assignment, scope and exact commit counts are checked by the parent fixture.
Both passed without skips or cancellation against production source e9bbc09
in an isolated archive with only the additional test fixture changed.
Command: `node --import tsx --test --test-name-pattern='^R04 cross-owner prerequisite .*review-assessment' test/focused-generation.test.ts`.
Log: `/tmp/nt275-qualification.ibYUWE/assessment.log`.

### #275 final deterministic acceptance — 2026-11-25

**PASS.** This supersedes the incomplete qualification and deferred-evidence
notes above. Production revision `e9bbc092268f3c4b48a5f8d13fec87a0bb30c30d`
includes `802a404`, `81a888d`, `a0c3ca1`, the completed #273/#274 baseline
and the earlier #275 qualification fixes. Test-only qualification follow-up
`f30f89e` adds the two R04 supporting Review-assessment cases; it changes no
production source. The two new cases ran successfully against an archive of
the exact same production source. Typecheck passed again after adding them.

| Qualification | Passed | Expected skips | Failed/cancelled |
| --- | ---: | ---: | ---: |
| Root tests excluding generation.test.ts | 874 | 43 | 0 |
| All six Generation shards | 103 | 2 | 0 |
| Studio tests (real SQLite and PostgreSQL) | 555 | 5 | 0 |
| Native Story certification | 22 | 0 | 0 |
| Added R04 writer/Review-origin supporting Review assessments | 2 | 0 | 0 |
| Behavioral mutation controls | 5 baseline passes, 5 intended mutant failures | 0 | 0 unintended |

Generation shards individually: 7/7, 14/14, 17/17, 19/19, 22/23
(one opt-in live test), 24/25 (one opt-in live test). Root and Studio
typechecking, lint/persistence boundary, formatting, builds, and migration
typegen check passed. All deterministic test processes exited 0. The actual
R14L authenticated Discovery corrections and approved queued Generation Turn
reached the original verified objective on both real database backends.
The original #248/#250/#268 and transferred #252/#253/#254/#259/#264–#267/#272
acceptance crosswalks above are covered by these integrated suites, including
the ordinary and Blueprint support-diagnosis continuations, nested support,
source-bound approval, affected-only revalidation, retained original negative
Review, persisted restart, and ordinary parent scheduling. The C01/R02/R14L
source alarms supplement the real execution and verifier regressions.

The mutation runner verified all five counterexamples on disposable copies:
authenticated planner refusal misclassified as integrity; semantic witness
defects misclassified as protocol; native diagnostic continuation reduced to
advice; historical discharge ignoring a corrupt diagnosis transcript; and
supporting Review continuation stopping before verified discharge. Each
unmodified production baseline passed, and each mutation failed at its
specified behavioral assertion, not at import or build failure.

Commands (Node 24.18.0, pnpm 11.15.0, local native NovelTea CLI 1.0.0,
clean local skills revision `4d92c7530a9d60329e83d0d2f85e57db42056abc`):

```sh
export NT_NATIVE_CLI="$(command -v noveltea)" NT_REAL_NATIVE_CLI="$(command -v noveltea)"
export NT_SKILLS_CHECKOUT="$HOME/dev/noveltea-skills"
export LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false TRACE_TO_LANGSMITH=false
# Unset NT_LIVE_* flags; no paid provider invocation.
# Disposable postgres:17-alpine, random password, loopback ephemeral port.
# NT_TEST_PG_URL and NT_KYSELY_PROOF_URL point to that database;
# NT_REQUIRE_KYSELY_PROOF=1. SQLite uses real test-local files.
pnpm typecheck && pnpm lint && pnpm format:check && pnpm build
pnpm --filter @noveltea/studio typegen:check
pnpm --filter @noveltea/studio typecheck
pnpm --filter @noveltea/studio build
files=(); for f in test/*.test.ts; do [[ $f == test/generation.test.ts ]] || files+=("$f"); done
pnpm exec tsx --test --test-concurrency=2 "${files[@]}"
# Each shard in its own git archive of the production revision:
for n in 1 2 3 4 5 6; do
  NT_GENERATION_TEST_SHARD="$n/6" node --import tsx --test test/generation.test.ts
done
(cd web && pnpm exec tsx --test --test-concurrency=2 test/*.test.ts test/*.test.tsx)
pnpm certify:story
node scripts/qualify-recovery-mutations.mjs
# Additional test-only fixture in a production archive:
node --import tsx --test --test-name-pattern='^R04 cross-owner prerequisite .*review-assessment' test/focused-generation.test.ts
```

Actual qualification ran the independent suites concurrently with bounded
worker counts; all used the pinned production source. Logs and original exit
codes: `/tmp/nt275-qualification.ibYUWE/` (`source`, `checks.log`,
`root.log`, `generation-{1..6}.log`, `studio.log`, `native.log`,
`assessment.log`, `mutations.log`, `qualification-typecheck.log` and
corresponding exit records). The disposable PostgreSQL container was removed.

Limitations: the 50 expected skips are opt-in paid/live, private preserved
replay captures, browser or optional hosted/rootless-sandbox tests; no
required deterministic backend was skipped. The qualified matrix covers the
supported source-bound strategies and explicit terminal controls, not every
hypothetical combination of arbitrary model output and scope. Unproven
authority (including free-text World conflict without a typed source grant)
still intentionally cannot authorize a writer. Paid live Discovery and
complete new-Story certification remain separate #260 work; this deterministic
gate is passed, not a claim that live certification already passed.
