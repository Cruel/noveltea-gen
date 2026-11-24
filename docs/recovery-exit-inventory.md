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
| `generation.ts` `assignmentDiagnosticReentry`, `runAssignmentDiagnosticRecovery`; `generation-operation-strategy.ts` `diagnosticWriterSupported`, `authenticateAssignmentDiagnosticDecision`, `authenticateAssignmentDiagnosticDischarge` | Reenter the original child with the existing diagnostic-bound receipt command. | Native metadata/provenance defects only, original owner, Case, scope, session, terminal, plan, current source and no extra prerequisites; one successor, not a new retry allowance. |
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
