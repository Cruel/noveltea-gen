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
| [Discovery adapter](../web/src/lib/onboarding-pi.server.ts) `onboardingPiRequest`, `realInference`, `openDiscoveryGraph`, `reconcileDiscoveryGraph` | Adapt. A started but unsealed invocation is not replayable; settled responses reauthenticate original source/session, then validate format/provenance and independent Review. Resource stop pauses; unsafe original effects fence; independently established nonconvergence remains unresolved. Retire the fixed provenance diagnostic count; use shared Review trigger plus repeat-source gate. | Onboarding tests: exact-source rejection, multiple independent diagnoses at distinct boundaries, unchanged-source stop, no implicit approval. Story Chat tests: consecutive Luna defects, interrupted correction and post-child-END/pre-parent-CAS failure with no repeated writer response. |
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
| `architecture-specialist.ts`, `architecture-draft-review.ts`, `architecture-blueprint.ts`, `milestone-blueprint.ts`, `focused-work.ts` | Adapt remaining domain-local correction and Review orchestration. One-shot empty/provenance/order/skill-read correction and precommit Review loops are still gaps in shared checkpointed ownership. Preserve independent review and source authentication. |
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
- [Shared receipt service](../src/assignment-metadata-recovery.ts) `executeAssignmentRound`, `runAssignmentReceipts`: invoke/reconcile one round, verify actual defects and seal next grant, or execute the exact admitted grant. Local format correction remains tool-free; historical receipts reconstruct progress without dispatch. `recoverSubmittedAssignment` is a temporary adapter for unmigrated lanes only, not reachable from Foundation.
- [Shared child](../src/generation-assignment-lifecycle.ts) `createAssignmentLifecycleGraph`: verification may publish the authoritative committed submission alongside its disposition, rather than promoting the preceding draft reference. Pending verification checks submission identity; the parent still independently reviews and reconciles commit/plan.
- Proof gates: [round and source AST](../test/generation-recovery-coverage.test.ts), [model consumer AST](../test/generation-model-consumer-coverage.test.ts), and [production-shaped Generation regression](../test/generation.test.ts). See the [R14A contract](generation-recovery-contract.md#r14a-261--foundation-substantive-writer-rounds).

### R14B Foundation independent Review exit/consumer audit (#262)

- [Generation](../src/generation.ts) `runFoundationAssignmentChild`: the original parent admission is rechecked at each pending child transition. A negative original submission or failed native successor returns a source-bound corrective grant; `correct_original` performs one original-writer correction and publishes a committed submission; `verify_original` independently rereviews the exact successor and admits another round only on verified progress. A typed assessment/control/fence preserves the original Case and failed root. Passing successors return to parent discharge and Work-plan verification.
- [Repair service](../src/rejected-review-repair.ts) `rejectedRepairOperations`, `executeReviewRound`, `reviewRoundGrant`, `attestNegativeReviewRound`: keep the existing repair/ledger/claim, validation, Git and independent Review operations; split ordinary Foundation execution into bounded child transitions. Reauthenticate original reviewer transcript prefixes and exact findings; a grant or submission reference is not permission by itself. No new case, retry counter or scheduler.
- `advanceRejectedRepair` and `independentAssignmentBoundary`: refuse Foundation whole-cycle corrective execution. The former remains only for unmigrated lanes. The latter's new integrity throw precedes that dispatch; it does not alter other-owner/global Review routing.
- `inspectRejectedRepair` and `beginRejectedRepair`: retain exact source, negative verdict, assignment, predecessor, path scope and native commit proofs. Reuse the already-attested predecessor and same-inspection checkpoint reads instead of duplicated recursive traversals; no cross-transition cache.
- Proof: [R14B contract](generation-recovery-contract.md#r14b-262--foundation-independent-review-rounds), [production-shaped Review and crash cases](../test/generation.test.ts), [source-linked AST gate](../test/generation-recovery-coverage.test.ts). Nonlocal assessment/author revisions retain their existing parent strategy. Later migrations must not reintroduce Foundation's retired whole-loop path.

- R14A/B follow-up: [shared Review transitions](../src/generation-review-round.ts) interpret native-rejected, native-round and committed submissions. [Repair service](../src/rejected-review-repair.ts) `prepareRepairWriter` reopens the original scoped session; `runNativeRepairRound` uses `executeAssignmentRound` and the existing budget/receipts. `nativeMetadataDefects` consumes only native diagnostics; protection findings and `protected-record-unverified` fence. Gen never parses rejected Story YAML. `inspectNativeReviewFailure`, `originalAssignmentFailure`, `selectOperationStrategy` and `executeOperationStrategy` bind native terminal evidence to the original Review Case; parent `recoveryNode` reauthenticates the handoff and terminal on restart. No new parent exit or disposition class. The actual protected rejection and queued author update after accepted rereview restart are covered by production-shaped tests.

### R14C World/Character and Choice/Puzzle (#263)

- [World/Character specialist](../src/character-world-specialist.ts) and [Interactive specialist](../src/interactive-specialist.ts): one shared assignment-round command; pending settlement returns without publication. The corresponding domain work adapters bind the logical key into the invocation digest, reject a foreign key/proof, and retain native, scope, manifest and Git evidence.
- [Generation](../src/generation.ts): `runCharacterWorldAssignmentChild` and `runInteractiveAssignmentChildren` use the existing child invoke/verify/correct phases with synchronous checkpoints, including the native-verified submission before independent Review; `subunitRoundProof` and `subunitWriterResult` exchange exact settled/grant references. `subunitReviewTransitions` uses the shared R14B transitions and `subunitReviewStop` authenticates typed parent assessment, prerequisite and control boundaries. The old whole-loop repair is refused by the migrated native ID registry.
- The intermediate World/Choice passing Review does not certify the composite. The parent independent-review edge returns to author intake for either composite before dispatching the second unit. Existing no-write and dependency gates remain.
- Proof gates: [source and routing AST](../test/generation-recovery-coverage.test.ts), [model-consumer AST](../test/generation-model-consumer-coverage.test.ts), and [scripted Generation regressions](../test/generation.test.ts). The two production-shaped composite regressions inject actual SQLite loss before first Review and second rereview, reopen before the second unit, and prove same-Case/session identity, native effects, no duplicate charges, owner and plan rejection, and parent scheduling or a typed downstream stop. The [Composition prerequisite controller](../src/cross-domain-prerequisite-controller.ts) uses the existing authenticated Review-coverage view for the exact Choice/Puzzle commits on current HEAD; an independent passing repair can cover a historical negative without rewriting it, but cannot supply a missing Event field grant. Source fingerprints include the subunit preflight and this downstream gate. Wider R14 certification remains with #260.
