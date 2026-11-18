# Shared Author Questions certification (#188)

Scope: the authenticated NovelTea Studio first-Story baseline and the
authenticated paused-specialist Author Question flow. This certification
compares both against [ADR 0004](adr/0004-shared-author-question-boundary.md),
the [question infrastructure contract](author-question-infrastructure-design.md),
and the existing source-bound Job/approval controls.

## Shared UI and authoritative boundary

- New-Story Story Chat and repository Guided Story creation both render
  `AuthorQuestionSetView`; paused specialists use the same component through
  `SpecialistQuestionEditor`. There is no separate editable specialist
  questionnaire. Saved specialist answers and submitted discovery rounds both
  use `AuthorQuestionAnswerSummary` and remain read-only.
- The set parser validates stable IDs, option/recommendation references,
  input kinds, bounded context, and immutable controller-issued identity.
  An agent-requested `allowStudioDecision` does not grant controller authority.
  All answers are parsed together before a single authoritative submission.
- Both adapters use `useQuestionSetDrafts` for immediately responsive local
  fields, debounced/deduplicated CAS persistence, flush-before-submit, and
  concurrent-tab conflict handling. Discovery persists to owner-scoped Studio
  storage; specialists persist to the owner/receipt-scoped Job sidecar.
  An unexpected revision/Question Set transition preserves unsent words in a
  copyable, read-only recovery view, never as an accepted response to a new set.
  Guided repository discovery exposes the same recovery view. Specialist edits
  also retain a Job-keyed, tab-local emergency copy outside the editor's
  component mount lifetime so the Thread can display it if a paused Job becomes
  queued/running and unmounts the author panel. The emergency copy is cleared
  when the exact draft saves successfully; it is not another author submission
  or a Story write. Recovery is scoped to the same Story or Job identity.
- Discovery binds repository, Story, immutable first Turn and source SHA;
  question rounds bind set ID and revision; approval uses the exact proposed
  digest and native validation before the original Turn may continue.
  A failed discovery model turn preserves accepted answers, fences unsafe
  retry, and permits explicit recovery.
- Specialist questions retain their immutable proposal digest, session/worktree
  identity, Job lock, and graph checkpoint. A verified answered checkpoint may
  automatically queue the original assignment; absence of such a checkpoint
  preserves the answer and returns manual recovery instead. No answer grants
  protected-canon permission.

## Deterministic evidence

| Scenario | Test evidence |
| --- | --- |
| Baseline: sparse first Turn, recommended multi-question set, explicit and delegated answers, next question round, exact original objective, normalized provenance, native approval, blocked/retry recovery | `web/test/story-chat-discovery.test.ts` |
| Repository discovery and Story Chat UI; compact radio/checkbox/Other, recommendation tooltip, free-text placeholder, default delegation, submitted answer history and summary | `web/test/pi-story-discovery-ui.test.tsx`, `web/test/story-chat-baseline-ui.test.tsx`, `web/test/author-question-set-ui.test.tsx`, `web/test/author-question-affordances.test.tsx` |
| Approved baseline continues the exact original Story Turn once, resumes after a web/server restart, queues a single owner-scoped execution and commits the reviewed foundation once | `web/test/story-approved-continuation.test.ts`, `web/test/new-story-resume.test.ts`, `test/chat-approved-commit.test.ts` |
| Specialist: owner-scoped question response/delegation, immutable receipt, invalid identity or forged approval rejection, saved drafts, failure recovery | `web/test/author-decisions-api.test.ts`, `test/specialist-choice.test.ts`, `web/test/specialist-question-drafts.test.ts` |
| Original paused specialist checkpoint queues on authenticated delegation, preserves draft bytes, rejects changed worktree on resumption | `web/test/fixture-jobs.test.ts` |
| Generic validation: unknown/duplicate question IDs, recommendation targets, arbitrary model-defined fields, missing/duplicate replies, invalid choice IDs, forbidden delegation and invalid drafts | `test/author-question-set.test.ts`, `test/author-question.test.ts` |
| Source-backed planning: exact author wording, interpretation vs explicit choice vs delegation, meaningful ambiguity and conflict, Git-only rationale, no unapproved Story edits | `web/test/story-chat-discovery.test.ts`, `test/planning-interpretation.test.ts` |
| Pre-v1 unsupported textual questions: no old renderer, no conversion, explicit restart and no approval of an unconverted proposal | `web/test/story-chat-discovery.test.ts`, `web/test/pi-story-discovery-ui.test.tsx`, `web/test/story-chat-baseline-ui.test.tsx` |
| Genuine browser controls: fresh proposed/blocked/approved/legacy reload and button actions, keyboard input, separate tabs in Story Chat and repository Guided Story, in-flight draft preservation, specialist answer and receipt reload, new specialist Question Set, and recovery after the specialist author panel unmounts | `web/test/browser-author-questions.test.ts`, with `NT_BROWSER_TEST=1` in headless Chromium |
| Large multibyte specialist answer accepted at the same limit as its draft; combined large valid question-plus-answer receipt remains readable through claim and consumption; separated contradictory branching answers require clarification; mandatory clarification rejects model-proposed delegation | `web/test/author-decisions-api.test.ts`, `test/specialist-choice.test.ts`, `test/planning-interpretation.test.ts`, `web/test/story-chat-discovery.test.ts` |
| Discovery transport accepts valid nine-question CJK drafts, maximum 16-question CJK draft and answer batches, and JSON-escaped maximum drafts; rejects oversized bodies with 413 before parsing | `web/test/onboarding-pi.test.ts` |

The headless-browser test mounts the actual Story Chat, repository Guided Story
and Author Interactions React components in Chromium, with a shared simulated
transport to create controlled reload/two-tab races. Its specialist harness
unmounts the author-interaction panel on a simulated Job status change and
renders the same independent unsent-recovery component as the real Thread.
Chrome targets are explicitly navigated rather than trusting `/json/new` to
leave `about:blank`; navigation is verified before making UI assertions. It exercises real DOM event handlers, keyboard
text entry and autosave transitions. It does **not** authenticate against a
running Studio server or execute a real specialist model; those boundaries
are covered separately by authenticated API, native validation, queue and
checkpoint fixtures. The normal first-Story test's negative controller branch
verifies that exact approval cannot silently create a Job when the execution
controller is unavailable; the approved-Story continuation fixture verifies
one original-Turn queue. An independent Job fixture verifies automatic
specialist requeue, **not** the resumed writer's successful completion.

## Limits and separate gates

The older explicit standalone `pnpm dev job foundation` CLI still supports
a prose-based collaborative discovery handoff in `src/foundation.ts`.
It is not a second web questionnaire, is not used to collect new first-Story
questions in the Studio Chat flow, and remains reachable for existing
CLI workflows/tests. It must not be mistaken for certified shared Question Set
behavior or deleted while those explicit callers remain supported.

No paid authenticated real-Pi certification or full authenticated Studio
browser walkthrough is claimed here. The controlled browser regression runs
with `cd web && NT_BROWSER_TEST=1 pnpm exec tsx --test test/browser-author-questions.test.ts`;
its browser is found in the local Puppeteer cache or explicitly configured via
`NT_BROWSER_CHROME=/path/to/chrome`. The full two-mode real-Pi Story quality
and recovery gate is separately specified in
[new-Story certification](new-story-certification.md); do not represent
fixture success as a completed live Story.

For final authenticated end-to-end signoff, create an actual first Story with a
sparse Turn; answer two rounds of mixed typed/delegated questions; reload before
and after proposal approval; observe native validation and a single original
Turn completion. In a separate real Collaborative Job, answer a paused
specialist question, confirm the exact receipt, safe automatic requeue and
successful completion of that original assignment. Deliberately interrupt a
checkpoint and verify explicit recovery rather than writer replay. Inspect
multiple tabs, keyboard focus, and protected-decision boundaries in the
configured rootless environment. These complete live sequences remain pending.

## Observed checkout verification (November 18, 2026)

- Focused root Question Set/provenance/specialist/protected-approval tests:
  **32/32 passed**, including combined Unicode receipt reading through
  specialist claim/consumption and contradictory branching answers.
- Focused Studio discovery, author decision, saved-draft, UI, original-Turn
  continuation, and opt-in headless Chromium scenarios: **27/27 passed** in
  the prior certification. The authenticated discovery request-budget test
  additionally passed with valid nine- and sixteen-question submissions and
  boundary-sized JSON-escaped drafts in this follow-up.
  Chromium covers clicked recovery/approval controls after reload, typed input,
  separate tabs and unsent-copy behavior in all three author-question surfaces,
  including specialist panel unmount on a running Job. The Chromium run passed
  three consecutive standalone executions following explicit navigation.
  Its transport is controlled by the test, not a running authenticated Studio server.
- Root source-hygiene lint and Studio persistence boundary, root and Studio
  TypeScript, configured `format:check`, and `git diff --check`: **passed**.
- A broad root test shard exposed the pre-existing, reproducible
  `test/architecture-blueprint.test.ts` failure, where the assertion expects
  a total-size rejection for an input now accepted by the unrelated
  `src/architecture-blueprint.ts` bound. Neither file was changed by #188.
  No aggregate full-suite pass is claimed.
- Full authenticated browser-to-Job Story completion, successful resumed
  specialist writing, and paid real-model literary certification remain
  **unverified**; #188 should remain open until those gates are explicitly
  dispositioned.
