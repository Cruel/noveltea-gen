# Production Story generator certification — issue #31

**Evidence date:** 2026-10-30. **Scope:** Git-backed `job` workflow in
`noveltea-gen`, not the historical `run` delegation prototype covered in
[certification.md](certification.md). This document distinguishes deterministic
structural safety, actual Pi authoring, and editorial quality. A test fixture,
an apparently successful graph traversal, or an empty diagnostic list is **not**
evidence of a coherent playable Story.

## Reproducible verification

From the `noveltea-gen` checkout:

```sh
pnpm check
# Requires the real native CLI and canonical reference Story; no silent skips:
NT_NATIVE_CLI=/absolute/path/to/noveltea \
NT_SKILLS_CHECKOUT=/absolute/path/to/noveltea-skills \
  pnpm certify:story
```

`NT_STORY_FIXTURE_ROOT=/absolute/path/to/reference-story` may override the
fixture location, but `NT_SKILLS_CHECKOUT` remains required for the separate
native/legacy parity and pinned-skill checks. `certify:story`
fails if the required binary or fixture is absent. It runs
`test/story-generator-certification.test.ts`, `test/validator.test.ts`,
`test/story-context.test.ts`, and the historical transport certification
matrix. The full `pnpm check` covers the larger generation, recovery,
authorization and narrative-scope integration suite. Their test directories
and state are temporary, outside the author checkout. CI without the native
binary cannot claim the gated native acceptance was run.

**Executed 2026-10-30:** `pnpm certify:story` — 23 passed, 0 failed,
0 skipped; `pnpm check` — 289 tests, 273 passed, 16 skipped,
0 failed, followed by a successful production TypeScript build. These are
local Linux results with the native CLI and skills checkout installed, not
claims about other platforms or providers.

The public native certification creates two committed Git Story repositories,
three independent job worktrees, and a separate engine-file sentinel. It
checks branch/thread separation, original author Git state, pinned native
validator path and digest, verified Git baseline, readiness and progression
reports, native Context Manifest IDs/status/inclusions/revisions, refresh on
Story edits, noncanonical idea inbox exclusion in its supported YAML format,
rejection of unauthorized protected-decision changes, and failure on corrupted
validator pins. It verifies actual subprocess results from `job start`,
`job validate`, and the native `narrative context` command, not mocks.

## Deterministic acceptance matrix

| Area | Test evidence | What a pass establishes |
| --- | --- | --- |
| New/existing Git roots, dirty base, concurrent jobs | `test/job.test.ts`, `test/generation.test.ts`, new public native certification | Distinct job branches/worktrees/threads; author checkout and unrelated engine files unchanged; dirty Story baselines refused; repeated operations do not replay commits |
| Native catalog, protection, versioned context | `test/validator.test.ts`, `test/story-context.test.ts`, new public certification | Actual native validation/readiness, exact Git SHA, checked empty baseline, protected edits/impact, revision-refresh batches, safe path handling, pinned provenance and fail-closed missing/corrupt executables |
| Typed architecture, partial readiness, independent clusters | `test/architecture.test.ts`, `test/generation.test.ts`, `test/event-work.test.ts`, `test/focused-generation.test.ts` | Authorized DAG/scope and typed dependency constraints; partial records cannot pretend completion; independent work resumes without duplicating prior commits |
| Crash and approval boundaries | `test/job-restart.test.ts`, `test/story-interruption.test.ts`, `test/author-updates.test.ts`, `test/revision.test.ts`, `test/job-pi-policy.test.ts` | Committed-before-checkpoint recovery, interrupted edits left for inspection, durable author messages, signed approvals, unknown-model refusal and budget-pause constraints |
| Alternative routes, branch knowledge and Puzzle clues | `test/interactive-work.test.ts`, `test/composition-work.test.ts`, `test/narrative-review.test.ts` | Deterministic witnesses for exclusive Choice outcomes, reachable solutions, clues before solutions, conditional prose requirements and independent review gates; not proof that the prose is good |
| Ideas, completion and merge safety | `test/ideas.test.ts`, `test/idea-placement.test.ts`, `test/generation.test.ts`, `test/job-report.test.ts`, `test/merge-preview.test.ts` | Dormant author concepts stay private; bounded placement/reassessment; unresolved ideas block claimed fulfillment; source files are untouched by merge previews; textual conflicts and semantic risks remain distinct |
| Tracing, provenance, isolation | `test/tracing.test.ts`, `test/langsmith-config.test.ts`, `test/snapshot.test.ts`, `test/certification.test.ts` | Hosted trace upload is opt-in; local trace and immutable skill provenance are separate from private transcripts; bad handoffs and corrupt snapshots fail closed |

These tests are in the normal `pnpm test`/ `pnpm check` suite; only
credential-gated live tests are skipped by default.

## Separate live Pi results (2026-10-30)

- **PASS — GPT-6 Luna, foundation:** `NT_LIVE_FOUNDATION=1` with native CLI
  and real `noveltea-skills`; 1/1 test passed, ~65 seconds. Actual Pi
  `read` and Markdown `write/edit` calls were inspected; `story_validate`
  was invoked; the author checkout stayed unchanged. Generated Creative
  Direction had canonical schema 0.1 and explicit user-protected/delegated
  origin. This certifies a foundation stage, **not** Story quality.
- **FAIL — GPT-6 Luna, interactive:** `NT_LIVE_INTERACTIVE=1`; 1/1 test
  failed after ~122 seconds. The Choice Point
  `choice-point.disclosure-response/protect` had no reachable later
  consumer or sufficiently specific conditional-writing obligation after
  bounded repair. The validator correctly blocked publication. This is a
  real quality/craft reliability failure, not a fixture mismatch or permission
  to weaken the causal requirement.
- **INCONCLUSIVE — GPT-6.1 Sol, high thinking, interactive:** The opt-in
  test exceeded the 290-second execution limit; the process did not produce
  complete test output. Do not count as pass or fail. A separately retained
  private test worktree may contain agent transcripts; never commit them.
- **NOT RUN:** Live full small Story to scoped continuation; independent
  real Pi editorial pass of fully composed interactive Story; live deferred
  idea fulfillment/reassessment; complete cross-provider and cross-platform
  runs; GUI/Studio manual inspection; LangSmith hosted-upload verification.
  Deterministic tests of these boundaries are not a substitute.

The current result is **deterministic interface certification passed; live
end-to-end narrative-quality certification remains open**. Issue #31 should
not be marked complete until the outstanding live checks produce inspected,
actually authored Story artifacts and an independent review. A model's final
self-report is not independent evidence.

## Findings and constraints

1. The live Choice failure should be repaired by clearer downstream causal
   obligations or an actual reachable consumer in authorized Event/Choice
   records, then rerun with persisted evidence. Tracked in
   [noveltea-gen#37](https://github.com/Cruel/noveltea-gen/issues/37).
   Do not accept a branch merely because its Choice Point record exists or
   its selection branch is reachable.
2. Native catalog/Context Manifest discovery currently produces a
   `frontmatter` diagnostic when a noncanonical `.md` is placed under
   `.story-inbox/ideas/`. Supported deferred ideas are YAML; the YAML
   exclusion passed. Nevertheless, ignore the entire private inbox regardless
   of file extension in upstream native catalog discovery. Do not copy private
   idea content into ordinary Story context or logs. Tracked in
   [nt#575](https://github.com/Cruel/nt/issues/575).
3. The native executable and historical validator pins are immutable job
   dependencies. Do not silently retarget a job to a new binary; a broken
   digest is an error, not permission to repin.
4. Neither fixture assertions nor native reachability proves human consent,
   manuscript import, engine runtime behavior, actual GUI integration, or
   successful automatic merges. Engine records, manuscript imports, GUI
   Story trees, metric infrastructure and auto-merge implementations are
   outside this issue's scope.

Logs, local traces, generated Pi sessions and live Story drafts belong only
in disposable or ignored private locations; never publish secrets or private
transcripts to GitHub. Cloud tracing remains disabled unless explicitly opted
in. Live checks should state the model, runtime settings, credential source
availability (not credentials), exact test result, relevant saved source
artifacts and whether a model response was actually inspected.
