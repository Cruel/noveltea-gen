# #213 — Persistent-review and hierarchical Blueprint certification handoff

Date: 2026-11-20. Scope: deterministic production generation and reviewer/recovery boundaries for #201 / ADR 0006. This is a **partial certification**, not an end-to-end model-generated Story acceptance.

## Deterministic evidence completed

- `test/generation.test.ts`: narrative-led full-Story production `start/resume/inspect` keeps an Event-only Milestone's Choice and Puzzle dispositions genuinely no-write, preserves Git HEAD on repeated inspection, and refuses to interpret fixture/native coverage as independently completed Story review.
- `test/generation.test.ts`: Choice-heavy production `start/resume/inspect` verifies two consequential Choices, alternate native-reachable Milestone routes, distinct player-facing prose, stable checkpoints, and no false `completed` settlement without editorial review.
- `src/composition-work.ts`: two-Choice fixture now writes independent selectable/conditioned prose for the second Choice. This was detected by a failing production Composition validator and fixed through that validator, not a bypass.
- `test/composition-work.test.ts`: a same-Thread Event-only no-write review survives nested forks. Admission and preparation verify the original approved private Milestone Blueprint before transferring its **design only** as bundle-digest-pinned, commit/source-bound evidence; child never acquires the original Pi session or a new approval. Tampering with the original reviewed receipt and in-memory transfer fails closed. Legacy schema replay is not replaced by current new-draft admission.
- Existing regression gates exercised: three productive sandboxed Blueprint revisions, independent reviewer continuity over corrected checkpoints, diagnostic nonprogress/oscillation evidence, causal amendment rejection on wrong Thread/source, stale plans, historical recovery compatibility, and native/Git provenance.
- Studio correction UI distinguishes exhausted *author correction grants* from resource-budget pauses and active correction without granting an unintended retry.

## Checks and their scope

| Check | Result |
| --- | --- |
| `pnpm lint` and `pnpm format:check` | Passed |
| `pnpm typecheck` and `pnpm build` | Passed |
| `pnpm --filter @noveltea/studio check` | Passed: 463 tests, 55 skipped, zero failed |
| `pnpm --filter @noveltea/studio typecheck` | Passed (includes Vite production build) |
| Focused root Blueprint/Composition/Review/Recovery group (11 files) | Passed: 65 tests, 4 opt-in real-model tests skipped |
| New `#213` production generation scenarios | Passed: 2 tests |
| `pnpm test` / aggregate `pnpm check` | **Inconclusive**: execution exceeded the command time limit; neither is claimed green |
| Real Pi persistent Review + Milestone Blueprint | **Not certified**; deterministic scripted provider is not equivalent to live model semantics |

The root test grouping can be replayed with:

```sh
pnpm exec tsx --test test/issue-202-production-blueprint.test.ts \
  test/issue-205-compact-story-blueprint.test.ts \
  test/issue-206-production-architecture.test.ts \
  test/issue-210-postcommit-review-cycle.test.ts \
  test/issue-211-postcommit-diagnostic.test.ts \
  test/issue-211-repair-policy.test.ts test/causal-amendment.test.ts \
  test/plan-continuity-fork.test.ts test/recovery-compatibility.test.ts \
  test/blueprint-diagnostic.test.ts test/composition-work.test.ts
pnpm exec tsx --test --test-name-pattern '#213' test/generation.test.ts
```

## Remaining #213 gates

1. Run a targeted **real Pi** persistent-review correction sequence and a just-in-time Milestone Blueprint correction on a pinned model/skills/native CLI. Record the same review-session identity, original and corrected source SHAs, and independent verdict receipts without exposing private transcript content.
2. Run the entire root suite to a final summary (split by file groups if execution time is bounded). Certify end-to-end actual objective satisfaction, not only canonical validity and fixture coverage.
3. Finish controller-grounded Studio phase telemetry for **diagnosing** and **author-required** in addition to the existing correcting, resource-pause, grant-exhausted and completed signals; avoid inferring approval or status from an untrusted model's prose.
4. Certify the remaining crash points (writer, protocol, native validation, commit, reviewer seal) and post-amendment selective carry-forward through full production start/resume; existing individual regression tests are supporting evidence, not an exhaustive matrix.
5. Reconcile the dependency issues #209, #210 and #212 still marked open before declaring #213 complete. Keep #181, #197 and #201 independently governed.

## Handoff to #181 (whole-Story certification)

The narrative-led and Choice-heavy fixture runs establish native/structural scope and fail closed rather than claiming a complete Story. For #181, execute a real model through composition **and independent Story review**, then compare playable routes, player-visible evidence, original objective, Story depth and reviewer verdict to immutable completion contracts. Distinguish reviewer-confirmed narrative facts from the mere presence of records and native reachability.

## Handoff to #197 (recovery certification)

Carry forward the newly protected same-Thread historical Milestone Blueprint design handoff in `src/recovery-fork.ts` / `src/milestone-blueprint.ts`. Verify inherited Event trailers, immutable source plan pin, original independent approval at admission/preparation, digest-checked child bundle, and absence of imported live Pi sessions or authority. Include source receipt tamper, pre-prepare handoff mutation, nested no-write forks, stale/foreign Thread, changed snapshot/native tooling and interrupted review. Confirm an older fork bundle lacking new historical proof requires reconciliation rather than fabricating a reviewer pass.
