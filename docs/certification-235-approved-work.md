# #235 — Approved-work correction and original-Thread recovery certification

Date: 2026-11-21. Parent: #226. This is a **bounded recovery certification**, not a claim that #181's complete Story was freshly generated or that #197's broader failure matrix is closed. All deterministic fixtures use a disposable Git Story, the existing production generation graph, native CLI verification and real Studio Kysely queue/controls. Their Pi responses are scripted; no model-semantic result can be inferred from them.

## Evidence and observed results

| Boundary | Exercised path / asserted outcome | Verification |
| --- | --- | --- |
| Initial contradiction rejected before Event writing | In `test/issue-220-production-milestone-diagnostic.test.ts`, the *real sandboxed* `ensureMilestoneBlueprint` writer proposes an Interactive owner whose obligation explicitly says no Choice/Puzzle is required. The independent v5 reviewer cites the exact defective downstream field and returns `revise`; no canonical Git change is permitted. A four-call budget pauses before correction, retains the original writer/reviewer sessions and their sealed negative receipt. Raising it admits exactly four more scripted source-reading calls (eight cumulatively); the same reviewer approves the corrected Composition-only plan. Re-reading the approved plan spends no calls; tampering with the negative review fails. | 1 passed (27–28 seconds) |
| Historical approved mistake, unchanged valid Event | `test/generation.test.ts` drives production `generate start/resume/inspect` in separate CLI processes with real Git and native validation. `interactive` corrects a once-approved but false Interactive owner without changing the reviewed Event source/commit; omission has its authenticated no-write proof. `knowledge` corrects a distinct, independently reviewed Character-knowledge defect. `specialist` exercises authenticated specialist-origin challenge; their original reviewed source and pin remain readable after correction, and downstream Interactive/Composition are selectively revalidated. No fixture is accepted as a final independent Story editorial pass. | 3 positive origin tests passed; additional 8 negative/restart variants passed |
| Post-approval operator warnings | Production repair ledgers produce stable per-incident identity, cause, severity, original/successor digests and dependent impact. `generation.test.ts` now feeds actual *graph-produced* Event-only (info) and knowledge/specialist (warning) incidents through the trusted Studio progress-event validator and verifies one correctly scoped operator activity event per incident; repeated synchronization does not duplicate IDs. Separately signed Architecture v2 and v3 revisions retain their own history and Story-wide activity events. | 4 positive graph/activity tests passed |
| Original blocked Thread + Studio queue | The original saved LangGraph `generation:web` Thread is persisted, checked by `safeToResume` and resumed under the **same** graph configuration. Missing no-write proof and unresolved reviewer evidence refuse admission. The integrated test now registers that exact request and Thread in a migrated, genuine SQLite Kysely Studio store; verifies start→blocked→finished→approved-work resume→worker claim→graph execution→paused/finished. The queue refuses an unverified or duplicate enqueue, preserves `resumeKind=approved-work`, and the original-Thread graph advances only scheduling/intake with **zero additional model calls and zero Git commits**. | 1 integrated original-Thread test passed; separate Studio queue/controls: 9 passed, 7 PostgreSQL opt-in skips |
| Refusal of forged/replayed effects | `generation.test.ts` and the complementary `original-thread-continuation`, `adaptive-operation-recovery`, `post-approval-revision-warning`, `blueprint-challenge`, Studio controls and recovery suites cover wrong Thread, missing proof, stale Git/receipt, changed original reviewer/Blueprint, tampered Event/plan/source, unacceptable correction, reviewer dispute, restart during archival, incomplete model usage, unauthorized author scope, cancellation, budget and rejected duplicate dispatch. Unsafe cases are *fenced*, never described as successful automatic replay. | 8 negative graph scenarios, 11 focused guard tests and Studio controls passed |
| Real Pi smoke | `test/issue-235-live-blueprint.test.ts` is **opt-in only**, uses a disposable Milestone, a rootless sandbox, a pinned provider/model, the production Blueprint author+independent reviewer boundary, and a limit of 12 model calls / 300 active seconds. It separately prints calls, tokens, cost, review verdicts and original Git source status; does not silently upgrade a clean first-pass review into evidence of a correction. | **Not run**: explicit paid-model opt-in not given. No paid usage claimed. |

### Reproducible commands

From `~/dev/noveltea-gen` with `noveltea-skills` available in the neighboring checkout:

```sh
pnpm typecheck
pnpm lint
pnpm exec tsx --test test/issue-220-production-milestone-diagnostic.test.ts
pnpm exec tsx --test --test-name-pattern='actual generation graph resumes Event-only Composition after historical (interactive|knowledge|specialist) correction|authenticated author-directed Architecture change' test/generation.test.ts
pnpm exec tsx --test --test-name-pattern='actual generation graph resumes Event-only Composition after historical (rejected|tampered|specialist-tampered|specialist-disputed|specialist-restart|specialist-wrong-path|specialist-receipt-tamper|specialist-model-tamper) correction' test/generation.test.ts
pnpm exec tsx --test test/original-thread-continuation.test.ts test/adaptive-operation-recovery.test.ts test/post-approval-revision-warning.test.ts test/blueprint-challenge.test.ts
pnpm --filter @noveltea/studio exec tsx --test test/kysely-generation.test.ts test/generation-controls.test.ts
```

Additional `#225` assessment and original-Thread dispatch/cancellation/budget scenarios passed as **7 focused tests**. Root `pnpm typecheck`, `pnpm lint`, `pnpm build`, Studio production `pnpm --filter @noveltea/studio typecheck` and `git diff --check` passed. The aggregate root `pnpm test` was attempted but exceeded the command runtime limit; **do not count it as passed**. The focused matrix above completed separately.

The standalone provider-budget probe is **not part of default CI**. To deliberately spend paid model usage on just one Milestone, use an authenticated Pi provider and a specifically selected compatible model:

```sh
NT_LIVE_APPROVED_WORK_235=1 NT_PROVIDER=<provider> NT_MODEL=<model> \
  pnpm exec tsx --test test/issue-235-live-blueprint.test.ts
```

The live test requires real negative→corrected review rounds for a full pass. A clean first-pass Blueprint means only the live author/reviewer smoke passed; the test deliberately fails the stronger correction-certification assertion. This is an *honest incomplete certification*, not an incentive to retry an expensive model repeatedly. Model calls, price availability and tokens are reported separately in the test output; `NT_KEEP_FAILED_LIVE=1` retains a failing disposable run's local evidence instead of writing into `.local/certification/live-new-story` or replacing old Sol runs. Credentials and Pi JSONL histories are not checked in.

## Limits and outstanding signoff

- Scripted review evidence verifies controller provenance, packet parsing, persistence and routing; it cannot establish the semantic quality of real model judgments, generated prose, or an autonomous complete Story. No new complete Story was generated or approved for #181.
- The opt-in paid model correction has **not** been executed. Its actual negative-review/convergence behavior, token quota and elapsed cost require separate evidence before claiming full real-Pi certification for #235.
- Ambiguous external effects intentionally remain fail-closed until sealed original invocation evidence is reconciled. Cancellation, budgets and wrong-Thread refusal are safety boundaries, not guarantees that every failed job will automatically continue.
- The Studio PostgreSQL queue matrix requires `NT_TEST_PG_URL`. The SQLite Studio queue and controls passed in this certification.
- The unrelated Studio aggregate `pnpm --filter @noveltea/studio check` presently stops at `typegen:check` because committed `web/src/db/studio-db.ts` differs from fresh introspection; this certification did not change migrations or generated types. The Studio production build/typecheck and focused queue/controls tests were run separately. Do not report the aggregate check as green until that mismatch is reconciled.

The associated test changes do **not** mint or relax approval authority: they assert actual production graph, sealed review, event reporting and Kysely behavior. No prior private Story run was modified.
