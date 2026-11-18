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
  Drafts are never author approval or canonical Story writes.
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

These tests are deterministic fixtures, native validation, local persistence and
checkpoint/queue assertions. Some are unit or server-rendered UI tests and
are **not** substitutes for a human browser interaction test. The normal
first-Story test's negative controller branch verifies that exact approval
cannot silently create a Job when the execution controller is unavailable;
the approved-Story continuation fixture verifies one original-Turn queue, while
an independent Job fixture verifies the positive automatic specialist-requeue
branch.

## Limits and separate gates

The older explicit standalone `pnpm dev job foundation` CLI still supports
a prose-based collaborative discovery handoff in `src/foundation.ts`.
It is not a second web questionnaire, is not used to collect new first-Story
questions in the Studio Chat flow, and remains reachable for existing
CLI workflows/tests. It must not be mistaken for certified shared Question Set
behavior or deleted while those explicit callers remain supported.

No paid authenticated real-Pi certification and no interactive browser
keyboard/reload walkthrough are claimed here. The full two-mode real-Pi Story
quality and recovery gate is separately specified in
[new-Story certification](new-story-certification.md); do not represent
fixture success as a completed live Story. UI operators should still verify
typing, reload, multiple tabs, keyboard focus, and post-approval continued
generation with a configured native CLI, model and rootless controller.

## Observed checkout verification

- Shared core, specialist and provenance fixtures: 15/15 passing.
- Discovery, authenticated author decision, specialist drafts, and UI: 20/20
  passing; the revised keyboard/control/attribution UI checks: 19/19 passing.
- Authenticated recovery/queue tests: 8/8 passing; verified approved
  original-Turn admission/restart tests: 5/5 passing.
- Planning/provenance, native foundation commit, and certification gate
  fixtures: 19/19 passing.
- Repository lint, root TypeScript, Studio TypeScript and Studio app build/
  typecheck pass; repository `format:check` and `git diff --check` pass.
- A broad root test shard exposed the pre-existing, reproducible
  `test/architecture-blueprint.test.ts` failure, where the assertion expects
  a total-size rejection for an input now accepted by the unrelated
  `src/architecture-blueprint.ts` bound. Neither file was changed by #188.
  The previous aggregate `pnpm test` attempt also exceeded the remote
  execution window; no full-suite pass is claimed.
- A subsequent focused rerun of Story Chat and repository discovery, including
  the legacy blocked-session retry guard, passed (3/3). The final focused UI,
  authenticated author decision, specialist drafts and original-Turn
  continuation regression run passed (24/24); Studio TypeScript and configured
  formatting checks passed again.
- No paid real-model certification run or interactive browser walkthrough was
  executed for this ticket, so the full literary quality/recovery gate has
  not been independently satisfied.
