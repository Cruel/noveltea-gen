# #213 — Persistent-review and hierarchical Blueprint certification

Date: 2026-11-20. Parent #201 / ADR 0006. This handoff records verified production boundaries and deliberately distinguishes scripted/native evidence from real-model semantic evidence. **It does not certify the whole-Story outcome of #181 or all historical recovery obligations of #197.**

## Deterministic production certification

- `test/generation.test.ts` exercises real production `start/resume/inspect` (not a parallel scheduling graph). A narrative-led Story omits unjustified formal Choice/Puzzle writers with authenticated no-write dispositions, retains stable Git/review provenance, and reports `editorial-unverified` rather than inventing completion. A Choice-heavy Story has two meaningful Choices, distinct conditional player-facing prose, native-reachable alternate routes, stable source/HEAD inspection, and refuses a completion claim without actual original-objective/editorial fulfillment.
- Three or more productive revisions and a persistent independent reviewer are covered by `test/issue-202-production-blueprint.test.ts`, `test/issue-210-postcommit-review-cycle.test.ts`, `test/composition-review-roundtrip.test.ts` and the continuity/convergence tests. Sealed negatives cannot be reclassified into a pass, nonprogress/oscillation invokes bounded diagnosis, protocol recovery preserves reviewer identity and history, and resource budgets remain authoritative.
- `test/generation.test.ts` includes real controller/native boundary coverage for #212: contradictory Milestone evidence, signed causal amendment, protecting independently runnable work, narrowed upstream correction, and carrying approved predecessor proof into the corrected downstream Event/Blueprint. `test/dependent-correction-work.test.ts`, `test/causal-amendment.test.ts` and recovery tests cover selective revalidation and false authority.
- `test/composition-work.test.ts` certifies a read-only no-write Event/Composition disposition through a same-Thread nested fork. Historical approved Milestone designs can cross a digest-bound fork without copying writer/reviewer transcripts or granting new approval; original receipt tamper, altered source/assignment, wrong Thread, stale skill and forged transfers fail closed.
- `test/event-protocol-graph.test.ts` now scripts the actual sandboxed read-only Milestone planner and separate read-only reviewer **before** the Event writer. It first emits an invalid Character assignment, repairs that output inside the original planner session, independently reviews it, then writes the Event and repairs a malformed publication manifest in the original writer session. A repeated graph call makes no new Pi turns or Git edits.
- `src/generation.ts` now refuses to clear a failed assignment at the *same* previously inventoried HEAD. This fixed an actual 300+ graph-step retry loop when externally authored Event task guidance disagreed with its source-bound Blueprint. The only same-HEAD exception is authenticated finalization of the original fixture World commit after an injected crash. `test/generation.test.ts` checks repeated resume cannot turn an unsigned external refinement into authorized parent work or replay the Event commit.
- Existing cases cover writer, reviewer, Pi format, native validation, Git commit-intent, review seal and crash-after-commit checkpoints, plus corrupted/foreign receipt denial. An ambiguous unsealed model invocation is intentionally blocked for explicit reconciliation; this is **fail-closed**, not an automatic replay guarantee.

## Trusted Studio phase status

`src/controller-review-phase.ts` emits sparse controller-origin `correcting` / `diagnosing` transitions only inside authenticated execution context. `web/src/lib/generation-progress.server.ts` refuses any attempt to combine such a phase with a Pi status report; no verified SHA, completion or approval is inferred from phase telemetry. The Thread activity renderer distinguishes these from proposed Pi prose. `thread-run-attention.tsx` uses actual pending Author Choice and controller budget state for `Author input required` vs `Resource budget paused`; exhausted author correction grants remain distinct in `thread-repair-content.tsx`. The timeline and status stay separate from Story Chat. Unit/UI tests cover these projections, including terminal completed state.

## Verification

| Boundary | Result |
| --- | --- |
| Root `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `git diff --check`, `pnpm build` | Passed |
| Studio `pnpm --filter @noveltea/studio typecheck` (includes production build) | Passed |
| Studio `pnpm --filter @noveltea/studio check` | **465 passed, 55 opt-in/integration skips, 0 failed** |
| Root suite split by file across 12 disjoint groups, with `test/generation.test.ts` split by test-name groups to respect the command runtime | **841 passed, 57 opt-in/integration skips, 0 failed** |
| Targeted root event sandbox, Composition, Blueprint, review/recovery tests after changes | Passed |
| Single aggregate `pnpm test` / `pnpm check` | Not a completed command: command runtime limit exceeded. The same root test-file inventory was exercised in bounded, disjoint groups instead. |

**Model-backed evidence (separate from fixtures):**

- `NT_LIVE_NARRATIVE_REVIEW=1 NT_PROVIDER=openai-codex NT_MODEL=gpt-5.6-sol pnpm exec tsx --test test/narrative-review-live.test.ts`: **1 passed** (approximately 110 seconds). The independent Pi reviewer inspected actual saved branching prose and gave a source-linked **BLOCK** with material branch-knowledge and puzzle-evidence defects, not a fabricated pass.
- `NT_LIVE_EVENT=1 NT_PROVIDER=openai-codex NT_MODEL=gpt-5.6-sol NT_KEEP_FAILED_LIVE=1 pnpm exec tsx --test test/event-live.test.ts`: the end-to-end Event test exceeded its time limit, **not a test pass**. It nevertheless saved independently checkable `noveltea-milestone-plan-receipt/v1` evidence at `phase: approved` with two sealed rounds (`revise` with one finding, then `pass` with none), a **single persistent reviewer session** distinct from the writer and a corrected source-bound design. Milestone ID `milestone.disclosure`, original canonical source SHA `3a6583a3271fd1028fb8d218f6577f35f407a8e7`, approved digest `ca24eb45b300710e6f8247715f45250621877f4ce5dfd6a23023b291ed50fa4d`, writer session `01a1fba8-3551-722d-846f-4659d2ec4014`, reviewer session `01a1fba9-7b0f-722d-846f-465a16c762bd`. Event writing had started but was **not** certified to completion. The model originally emitted a structured knowledge-array instead of the schema's prose string; both the initial prompt and a bounded same-session format correction were clarified, without relaxing validation.

## #181 whole-Story handoff

The deterministic narrative-led and Choice-heavy runs prove controller scheduling, native record/readiness verification, conditional branch presentation, omission/recovery provenance and **honest incomplete verdicts**. They cannot substitute for a real Pi authored-and-reviewed *complete* playable Story. #181 still needs its own end-to-end model generation, author objective coverage, reachable endings, independent source-bound review, and final completion proof. Do not close #181 from this receipt.

## #197 recovery handoff

Retain the authenticated historical Milestone Blueprint read-only design handoff in `src/recovery-fork.ts`, `src/recovery-fork-state.ts`, and `src/milestone-blueprint.ts`. Validate original reviewed source and independent pin at admission/preparation, inherited bundle digest, missing legacy proof, nested fork and rollback, cross-Thread/snapshot/native changes, dirty Git, interrupted writer/reviewer and review-seal ambiguity. The deterministic no-replay regression and newly fixed same-HEAD failure loop are supporting cases; #197 owns broader crash-matrix signoff and must remain independently tracked.

## Dependency reconciliation

#209, #210 and #212 are **closed as completed** after verification of their separate implementation and production regression evidence. The closeout comments on those issues identify their specific tests and original commits. This certification does **not** close #181, #197 or parent #201; those keep their own independent acceptance criteria.
