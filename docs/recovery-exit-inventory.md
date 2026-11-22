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
| **Specialist dispatch/result**: exception, nonaccepted status, dirty active job | `specialist-dispatch` or `specialist-result` assessment before other assignments. Clean, unchanged-HEAD local failures may proceed only to independent units without retry; postcommit Foundation/World recovery needs a source-authenticated original receipt. Explicit `dependency-required` and sealed Event no-write prerequisite go to their domain controller. `review-handoff` reconciles the existing checkpoint, not a new writer. | `test/generation.test.ts`: #225 unaccepted result, #225 dirty active specialist, clean local cluster continuation, crash before World/Creative Direction finalization, Event prerequisite, sealed causal amendment |
| **Focus and Composition prerequisite amendment**: missing proof or exception | `dependency-amendment` assessment; never advance Composition without a verified correction and independent downstream checks. A protected/author-required amendment is a named author stop. | `test/generation.test.ts`: #225 failed amendment, focused plan amendment, causal replan and cross-Milestone prerequisites; #221 tests |
| **Independent assignment review**: transport/receipt exception versus genuine negative verdict | `independent-review` assessment for errors; verified negative verdict remains negative through the persistent original writer and separate reviewer. Author choice/escalation and protected prerequisite are intentional stops; pending downstream revalidation cannot be skipped. | `test/generation.test.ts`: #225 thrown independent review; original-writer repair, other-owner refusal; `test/milestone-review-diagnostic-recovery.test.ts`; #219/#220/#221 |
| **Committed work verification**: absent/unaccepted result or failed native, Git, plan or review proof | `specialist-result` returned-failure or `commit-verification` exception assessment. Only a verified and reviewed checkpoint advances the inventory and cursor; safe-boundary pause is intentional. | `test/generation.test.ts`: #225 unaccepted result, source tampering and corrected checkpoint recovery; `test/recovery-fork-review-coverage.test.ts` |
| **Completion decision**: incomplete scope, unresolved finding, missing review/approval, unsafe source, thrown final check | Known findings escalate without asserting completion; an unexplained trusted failure enters bounded read-only diagnosis. Exceptions or contradictory positive reports enter `completion-verification` assessment. Missing eligible checkpoint is an explicit integrity stop. | `test/generation.test.ts`: #225 invalid completion preflight, incomplete fixture generation, negative review; `test/unknown-recovery-diagnostic.test.ts`; `test/new-story-certification.test.ts` |
| **Successful terminal exit**: final report completed and inventory verified | `completed` only after the current verified HEAD, required review and selective dependent revalidation, original objective and author controls agree. | `test/generation.test.ts` and `test/new-story-certification.test.ts`; `test/recovery-fork-review-coverage.test.ts` |

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
