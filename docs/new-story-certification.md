# Complete new-Story certification (#158)

This is a **release gate**, not another Story-writing engine. Studio's existing
LangGraph/controller, native CLI and immutable skill snapshot own all writer
authorization and generation. The skills repository's portable-method
evaluations (#35) are useful negative/control evidence, **not** proof that
Studio has finished a game.

The gate requires **two independent real Pi Story Chat runs**, each starting
from an empty canonical Story in a separate disposable Git repository:

1. **Autonomous:** submit a sparse "Make me a mystery game" request without
   comprehensive delegation. Confirm minimum discovery questions with
   recommendations, partial answers/delegation, exact proposed Creative
   Direction, native validation and explicit approval.
2. **Collaborative:** repeat the request in Collaborative mode. Verify
   meaningful author questions with recommendations and Other/free-text/
   delegated responses. Do not make mechanical repairs a new approval.
3. In **both**, approval must continue the **same first Turn and Thread**
   automatically. Do not issue a second "Start generation" request. Check
   connected canonical Arc/Milestone/Character/Event/Choice or Puzzle/Content
   outcomes and actual player-facing scenes, consequences and endings; there
   is no hardcoded record quota.
4. Perform a real **interruption/reconnect** at a safe boundary in each case.
   Confirm the original author question and approval are not repeated; the
   original Turn and source/skill pins remain unchanged, verified commits are
   preserved, ambiguous in-flight writers do not silently replay and
   another Thread's unpublished Story changes never leak.
5. Independently review full player-visible routes, clue placement, solved
   mystery, causal consequences, knowledge continuity, meaningful endings and
   scope. Negative findings require authorized bounded correction and review,
   or an explicitly **incomplete** outcome, never an outline-only pass.
6. Retain the two immutable initial source SHAs, verified final Git SHAs,
   snapshot IDs/skills commits, planning and specialist transcripts, model
   identity, trusted approvals, native validation/progression/readiness,
   Story diffs, reviewer receipts, and a separate human/external literary
   quality verdict.

Keep all private evidence under an ignored location (for example
`.local/certification/issue-158/`); **do not commit** transcripts, private
author input, real Story artifacts or OAuth tokens. Do not run parallel writers
against a single Job.

## Source-bound read-only acceptance check

After the real runs, prepare two **private** case JSON files and invoke:

```sh
pnpm certify:new-story --autonomous .local/certification/issue-158/autonomous.json \
  --collaborative .local/certification/issue-158/collaborative.json
```

Each file names an **existing** preserved production Job and supplies only
the independently inspected Studio and external-review attestations:

```json
{
  "story": "/absolute/disposable/repository/story",
  "job": "job-id-from-story-chat",
  "studio": {
    "threadId": "root:job-id-from-story-chat",
    "firstTurnId": "job-id-from-story-chat",
    "sourceSha": "the exact 40-character initial Git commit",
    "approvedDigest": "the 64-character Chat approval digest",
    "baselineQuestions": 2,
    "recommendationsPresented": true,
    "exactApproval": true,
    "continuedOriginalTurn": true,
    "authorInteractionsReviewed": true,
    "recoveryAndIsolationReviewed": true,
    "evidenceReference": "private Studio transcript and restart audit location"
  },
  "quality": {
    "schema": "noveltea-external-story-quality/v1",
    "mode": "autonomous",
    "headSha": "the exact 40-character final verified Git commit",
    "reviewer": "independent reader's name or stable identifier",
    "relationship": "external",
    "findings": []
  }
}
```

The sample is deliberately **not** passing: the independent evaluator must
fill all seven quality findings with `dimension`, `verdict` (`pass`,
`fail`, or `uncertain`), `evidence` (canonical `path.md:line`
witnesses) and a reasoned `analysis`:

- `playable-opening`
- `clue-trail`
- `branch-consequences`
- `knowledge-continuity`
- `mystery-payoff`
- `meaningful-endings`
- `player-facing-prose`

An evaluator must actually read **both** branch paths and their relevant
conditions, not infer quality from the presence of YAML records. Each passing
dimension requires real lines in the **exact final committed Story**;
unproven claims should be `uncertain`. Use different source Story repositories,
Job IDs, Threads, final SHAs and evaluations for each creative mode.
The external assessment is an operator-held attestation: the command cannot
cryptographically prove that a named person read the work.

A Story completed through checkpoint recovery supplies the **original** Job in
`job`, plus `finalJob` (the terminal continuation ID) and `certificationRoot`
(the preserved Studio certification run directory). The checker follows each
controller-owned, finalized recovery fork backward to that original Job,
re-verifies each parent checkpoint proof, and checks the persisted Studio
execution order and original visible Thread. It reads original approval,
first-Turn plan, and pinned orchestrator evidence from the first Job, and the
final native, editorial and narrative-quality evidence from `finalJob`.
A child Job's checkpoint-base SHA does not become a substitute for the
original Story source SHA. Missing parents, changed proofs, cross-Thread
continuations and reused initial Story sources fail closed.

The command only reads the existing Job and Git commits. It validates saved
Chat foundation approval, the original Turn and controller-owned objective,
pinned orchestrator selection, immutable skill snapshot and real Pi planner
receipt, model identity and pinned read list, saved Pi session, full Story
completion report, native/protection/editorial/whole-Turn verdicts, source
and final HEAD identity and actual tracked Story contents. A passing result is
reported as **`eligible`** for operator acceptance, not as an automatically
approved Story or a published result. It cannot write a Story, approve an
author choice, resume an uncertain writer or issue a provider request.

`blocked` is the correct result for missing/stale source identity, a fixture,
a paused Job, failed/uncertain literary quality, unsupported paths/lines,
missing real model method reads, insufficient player-facing work, or an
unverified recovery. The command exits nonzero when blocked.

## Unified opt-in Studio E2E runner

The two opt-in tests share **one** Studio live runner:
`web/test/real-pi-studio-scenario.ts`. This owns the disposable Studio database,
authenticated user, source Git repository, independent trusted agent, rootless
Docker sandbox, native CLI, worker cleanup and Pi credential isolation. The
full-Story mode adds only Story Chat discovery, approval, continuation and
completion assertions in `web/test/support/full-story-case.ts`. It does not
start or require another Docker Compose stack. The existing Foundation smoke
mode is unchanged and does **not** implicitly run the long full-Story test.

To run one mode explicitly, with a previously authorized Pi login:

```sh
NT_TEST_WEB_PI_NEW_STORY=1 NT_TEST_WEB_PI_STORY_MODE=autonomous \
  NT_TEST_WEB_PI_AUTH=device-code NT_TEST_WEB_PI_LOCAL_OAUTH=1 \
  NT_TEST_WEB_PI_PROVIDER=openai NT_TEST_WEB_PI_MODEL=gpt-6-luna \
  NT_NATIVE_CLI="$HOME/dev/nt/build/cli/linux/noveltea" \
  NT_STUDIO_SKILLS_SOURCE="$HOME/dev/noveltea-skills" \
  pnpm --filter @noveltea/studio exec tsx --test test/real-pi-new-story-certification.test.ts
```

Repeat with `NT_TEST_WEB_PI_STORY_MODE=collaborative` against a separate
fresh Job. `NT_TEST_WEB_PI_PRESERVE=1` retains private evidence under the durable,
Git-ignored `.local/certification/live-new-story/runs/` directory (or an
explicit new `NT_TEST_WEB_PI_ROOT`). It does not relocate generated jobs:
Git worktrees, the Studio database, receipts, immutable skill snapshots and
Pi sessions keep their original absolute paths across retries. The private
root is owner-only and includes the encrypted disposable Studio OAuth vault
and its key; it contains no usable local Pi refresh credential. Treat the
whole directory as sensitive and delete it only after certification evidence
is no longer needed. The
isolated local-OAuth helper copies an unexpired **access token only** from the
existing Pi login; it never copies the usable refresh token into Studio. For
long full-Story runs it checks the access-token lifetime and uses Pi's supported
`auth print-bearer-token --min-expiry 40m` command to renew the **local Pi**
login before expiry, then synchronizes only the new access token to the
throwaway owner-bound Studio vault. Pi alone stores and rotates the usable
refresh grant. Renewal failure stops certification rather than falling back
to ambient or another user's credentials; the local Pi CLI must be on `PATH`.
Alternatively the existing live runner accepts the read-only Studio OAuth
source database or an explicit provider API key. No real provider calls run
without an opt-in flag. The provider acquisition check uses an existing local
verified Git worktree instead of a remote GitHub API, which must be certified
separately. A passing E2E run does **not** replace the separate external
quality and recovery audit below.

When the remote command runner has a shorter execution ceiling than the full
Studio test, use the same existing test through the bounded local launcher:

```sh
node scripts/live-new-story-runner.mjs start autonomous
node scripts/live-new-story-runner.mjs status autonomous
node scripts/live-new-story-runner.mjs start collaborative
node scripts/live-new-story-runner.mjs status collaborative

# After inspecting the failed root's attempts/<job-id>/observation.json,
# choose an eligible point and its original owning source Job. This resumes
# the same visible Thread in a new, isolated execution without replaying work.
node scripts/live-new-story-runner.mjs retry collaborative <40-char-checkpoint-sha> [source-job-id] [optional-corrective-guidance]
# If the authenticated recovery controller prepared a child but admission was
# temporarily blocked, start THAT EXACT child after fixing the blocker:
node scripts/live-new-story-runner.mjs resume collaborative <prepared-child-job-id>
node scripts/live-new-story-runner.mjs status collaborative
```

The launcher retains process/exit status, exact Git source HEAD, private full
logs and durable root pointer under `.local/certification/live-new-story/`.
`start` creates a fresh owner-isolated source root; `retry` requires the exact
finalized checkpoint SHA and reopens its saved source, controller and Story
state. Repeated retries may target the same verified checkpoint, each with a
new child Job and independent Pi sessions. `resume` is different: it reuses the
existing authenticated same-Thread prepared child, immutable checkpoint proof
and exactly saved corrective guidance; it never allocates another child Job. No completed writer, original
interview or approved baseline is rerun. Existing blocked or dirty writers
remain in their original worktrees for manual inspection.

Each execution retains `attempts/<job-id>/observation.json` with the terminal
status, active failure, checkpoint eligibility, exact saved-receipt digests,
and any inherited checkpoint. The receipt files and Pi transcripts stay at
their original locations; no model response is treated as a recovery grant.
If the attempt is interrupted before an observation is written, examine the
preserved State directory and the retry request in `attempts/<child-id>/`.
The live test still needs valid local Pi credentials and a rootless Docker
host. A checkpoint retry is a focused *debugging* run; the final acceptance
gate additionally requires the original-Turn interruption/reconnect and
external quality evidence. Fixture tests never substitute for a Luna pass.
Only the explicitly selected real Luna model runs. A launched run is **not**
a passing certification: inspect the final status and real source-bound
findings, including blockers, independent quality and recovery evidence.
Do not publish transcripts, access tokens or local Story roots in Git.

## Automation and current evidence

Controller and safety checks (no real provider requests):

```sh
NT_SKILLS_CHECKOUT="$HOME/dev/noveltea-skills" \
  pnpm exec tsx --test test/new-story-certification.test.ts \
  test/story-skill-matrix.test.ts test/turn-delivery.test.ts \
  web/test/story-chat-discovery.test.ts \
  web/test/story-approved-continuation.test.ts
pnpm check
```

The new evidence-gate tests deliberately supply **synthetic, noncanonical**
positive and negative receipts. They prove fail-closed field checking, not
creative quality. Production run evidence must pass the actual source-linked
CLI against two **real saved jobs**. #35's last skills-side live runs stopped
at incomplete new-Story drafts; the original #35 report and skills snapshot
hashes are in [story-skill-integration.md](story-skill-integration.md).

At the November 12, 2026 local gate attempt, the native CLI 1.0.0, clean
portable skills checkout `3d798d5`, Pi 1.5.0 and rootless Docker were
present. The current Pi OpenAI login returned `invalid_grant` on live model
refresh and the separate OpenAI Codex login returned
`invalid_refresh_token`. Neither authenticated new-Story generation nor
an independent literary pass was obtained. Re-authenticate the intended Pi
provider **outside** the certification process, then restart a fresh
source-bound test; do not reuse a stale or partially delivered model turn.

## November 13 current-source certification: blocked in both modes

After #161 and #162 closed, two fresh independent runs used Gen source
`6c4a5b03954bf5161760d47d6061fe831acb9acc`, clean skills source
`3d798d5aada9f38e48a694f3f39ee73a86a02e25`, pinned snapshot
`f0aa51fa1b1e0a74c1e6cc5f8647691f8f3f18c631061b51754cb1981660e872`,
Pi 1.5.0, `openai/gpt-6-luna` and native CLI 1.0.0. The existing isolated
local-OAuth path authenticated successfully; the November 12 authentication
failure above is historical, not the blocker for these runs. Rootless Docker
reported cgroup v2/systemd. No second runner or Compose stack was introduced.

Both used the command above with `NT_TEST_WEB_PI_PRESERVE=1`, once per mode.
Both live tests **failed** their `terminal === completed` assertion; this is
negative real-Pi evidence, not creative certification:

| Evidence | Autonomous | Collaborative |
| --- | --- | --- |
| Private root | `/tmp/nt158-lwsPW0` | `/tmp/nt158-a6l8gI` |
| Job / first Turn | `665ad56f-d03c-415e-875b-d4fcba3923a1` | `e1fad179-af5b-4330-ba01-e9ddb3e71242` |
| Initial Story SHA | `e1456b709496b988df00ae3a4a806a44d4669914` | `503ae727664673438274ed989d4c50a02392d1df` |
| Final committed SHA | `a7f623b66a656151da27110e89c3eb607a187c49` | `4624500f1f3faa120c45534431b7a663414c673d` |
| Terminal / native validation | blocked / passed | blocked / passed |
| Post-baseline author choices | 0 | 0 |

Discovery questions included recommendations; the runner supplied a partial
answer and delegation, reloaded the exact proposed digest/revision, and
approved that exact foundation. Approval automatically queued the original
Turn. Both reached real pinned Architecture, World/Character and Event work.
Both worktrees were clean after the tests. Neither reached Authored Content,
Choice/Puzzle completion or final goal-level acceptance.

### Autonomous: bounded causal-evidence correction exhausted

The first Event's failed review at `c2f7b402de54438d89f03044d17a3ab9dd60b05b`
identified missing evidence for the selected Milestone and an unearned
relationship transition. Event-only corrections were committed at
`0bc34b0e93eb7f667344e632a1204acdb993421f` and
`a7f623b66a656151da27110e89c3eb607a187c49`. Independent rereview still
found inadequate support, finally an unsupported earlier witness recollection.
The repair receipt preserved the original findings and separate successor
findings, recorded two attempts, and stopped blocked. The causal-grounding
changes in #162 therefore do **not** establish real-model convergence.
No retry budget, review threshold or writer authority was changed.

### Collaborative: two passing repairs, unresolved prerequisite report

Two real negative Event reviews led to bounded original-session correction
and independent passing rereview:

- `45bf7e5bc2977dbfa53915a43c2c34cc9f201d97` →
  `7a7397731e2cafa5d7e6e002c061f7cf09f6a561`.
- `3ececd2ff31b6cd2823aad52a0ae1d966d2a9caa` →
  `4624500f1f3faa120c45534431b7a663414c673d`.

However, an earlier resolution-Milestone specialist made no edits and reported
that an enacted choice and distinct endings required interactive prerequisites
outside its Event-only assignment. Its receipt remained `writing` with
`Event specialist did not author canonical Event Markdown with an editing tool.`
The job ended blocked despite subsequent progress on the other two Events.
Focused follow-up [#163](https://github.com/Cruel/noveltea-gen/issues/163) owns
reproduction and routing of clean no-write prerequisite reports through the
existing work-plan machinery. The saved writer was not blindly resumed, and
its authority was not widened. This observation alone does not establish the
root cause or that replay is safe.

### Evidence retained and limits

Each private root retains its Studio database, isolated agent log, Job receipts,
source Git repository/worktree, skill snapshot, and Pi sessions. Each
`certification-observation.json` records native validation status and changed
paths; Event receipts contain native progression witnesses. A private manifest
at `.local/certification/issue-158/attempt-6c4a5b0.json` records source/model
identity, evidence locations and session SHA-256 hashes. Console logs and the
full check log are beside it. These private artifacts are not committed.

Verification on the tested source:

- `pnpm check`: passed; root **433 passed / 24 skipped / 0 failed**;
  Studio **408 passed / 53 skipped / 0 failed**, including typechecks and builds.
- With `NT_NATIVE_CLI` and `NT_SKILLS_CHECKOUT` set, `pnpm exec tsx --test
  test/event-work.test.ts test/review-repair-amendment.test.ts
  test/rejected-review-repair.test.ts test/rejected-repair-controller.test.ts
  test/semantic-assignment-review.test.ts`: **50 passed / 2 skipped / 0 failed**.
  The two private historical replay tests were not enabled in this invocation.
- Real-Pi new-Story tests: **0 passed / 2 failed / 0 skipped** across the two
  separate mode invocations. No additional full-generation retries were run.

The proposed-discovery reload is reconnect evidence only. Worker-process
interruption/resume, duplicate-grant/commit protection and cross-Thread
isolation were **not certified by these live runs**. Meaningful post-baseline
Collaborative participation, complete player-visible routes/clues/endings,
final readiness and whole-Turn review, and independent external literary
assessment remain unverified. No external quality attestation or `eligible`
acceptance result was fabricated for these incomplete Stories.

**#158 must remain open** until both real Story modes, negative/recovery
checks and external quality assessment are completed and recorded. A
deterministic check, intact source snapshot or successfully implemented
certification command is not closure evidence by itself.

## November 14 Luna retest after #168 and #169: still incomplete

Two fresh independent Studio/real-Pi invocations used Gen source
`bb9fc8782754eddb5fcbc5582653859e1b9f060c`, clean skills checkout
`4c0a591e9e435de061ea58add8e7b14f2b40f605`, `openai/gpt-6-luna`, Pi
1.5.0 and native CLI 1.0.0. Both began with a sparse mystery prompt, baseline
questions and recommendations, a partial delegated answer, exact author
approval, and automatic continuation of the original Turn. Both wrote real
canonical records and **passed native validation**, but neither passed the
full playable-Story assertion:

| Mode | Saved private root / Job | Final verified HEAD | Outcome |
| --- | --- | --- | --- |
| Autonomous | `/tmp/nt158-vmsiJX` / `9c56b749-2ab9-49ed-824f-dca3927f23ed` | `158079cf01aa7e5727417974fb259165653a8aca` | **blocked** after two Event corrections failed independent review: a response count and undated bell indicator did not actually test the claimed conflicting accounts. |
| Collaborative | `/tmp/nt158-6o7r2Z` / `0b58a215-d3b6-4545-a7e0-8d09dcebbfe4` | `b5803f40fb92c402d1a852f0baf102233b7ba1c1` | **paused** after independent Event review found a central named speaker without a canonical Character or typed Event participant. No actionable authenticated Author Choice was presented by the existing runner. |

The initial disposable Story SHAs were
`edfe9d732eac8c4fd7b351ec67400a21a52533b3` (Autonomous) and
`953a86b4f03fe00ec91b688155fee1b7cb91d717` (Collaborative).
Both runs retained source-linked negative-review receipts and private agent
transcripts. Neither reached complete Choice/Puzzle/Content routes or final
whole-Story editorial review. The first failed despite legitimate bounded
corrections; the second exposed an Event-to-Character dependency beyond the
Character-Foundations-only #169 path. Do not classify either as a creative pass.

The full `pnpm check` on this pre-hardening source passed, and focused
Event/Character/review regressions passed (60 passed, 3 private replay skips).
The follow-up bounded Architecture and Event prompt guidance now explicitly
requires a testable independent observation and typed participation by existing
Characters, with regressions for both. **Prompt tests are not proof that Luna
will follow the guidance in a fresh full run.** A controller-authorized,
source-bound Event-to-Character dependency path remains separate work. Neither
a worker restart/isolation audit nor external literary quality attestation was
obtained, so `pnpm certify:new-story` cannot be claimed eligible and #158
remains open.

## November 14 after #170: current-source Luna certification still blocked

Both fresh real-Pi cases ran against clean Gen source
`aa2a84d9ffa28835c7990462d4ca90add91272ec`, clean portable skills
`4c0a591e9e435de061ea58add8e7b14f2b40f605`, `openai/gpt-6-luna`, Pi
1.5.0 and native CLI 1.0.0. Each established the baseline with recommendations,
partial delegation, reloaded the same proposed digest, obtained exact author
approval, and continued the original Turn. Neither finished a playable Story.

| Mode | Private evidence / Job | Verified HEAD | Unresolved gate |
| --- | --- | --- | --- |
| Autonomous | `/tmp/nt158-qVAIaR` / `4aa73e8a-17a2-44ae-adcd-ee5ca12122b0` | `9c344eb9ceb6d0f8c24923b7a1b867f39bba6954` | **blocked** at World Foundations: Luna wrote source-grounded, native-valid World Entity/Fact files but omitted its final JSON `modifiedRecords` manifest. The controller made no unverified World commit. |
| Collaborative | `/tmp/nt158-4N3cxD` / `7a2624fa-2cc5-4355-b56d-9a7d6ca359ef` | `6bda8dc2702e06b7cca5dd09da74a12240bb3e46` | **blocked** at Puzzle: World, Character, all four Events and a Choice were written. One Event's first review and first correction failed for unsupported account comparisons, then its second correction passed independent rereview. The Puzzle writer returned a clean no-edit prerequisite report because a concrete solvable Puzzle objective and two independent solution routes lacked evidence. |

Both source repositories happened to have the same initial SHA
`fc7c425b2188f6ddf126f808cdd0a15d19c0ba4e`: the disposable Git seed commit
had identical contents, author metadata, message and timestamp. This is a
certification-fixture identity defect, not cross-Thread leakage. The runner is
now adjusted to give distinct disposable baseline commit messages, so future
real runs will have unique immutable source identities.

The World missing-manifest path now offers a bounded same-session reporting
correction and then checks the actual Git diff, native validation and original
write authority. Its focused regression passes; it has **not** been proven by
another fresh Luna run. Issue [#171](https://github.com/Cruel/noveltea-gen/issues/171)
tracks an independent controller-contract gap: `interactive-work.ts` and
`composition-work.ts` require both Choice and Puzzle, while #158 requires
Choice/Puzzle as appropriate and this author requested fair-play clues and
consequential choices rather than a formal Puzzle. A Puzzle may be skipped only
when the signed original objective and independent review allow it; necessary
mystery-clue and outcome work may not be skipped or fabricated.

Native validation passed for both Story heads, and regular `pnpm check` passed
on the tested source (root 503 passed / 31 opt-in skips; Studio 411 passed /
53 opt-in skips). Neither reached final composed scenes, native full-Story
readiness, whole-Turn review, worker interruption/isolation certification or
external literary quality evaluation. No `eligible` release certification was
produced. **Keep #158 OPEN.**
