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
fresh Job. `NT_TEST_WEB_PI_PRESERVE=1` saves private evidence in a disposable
`/tmp/nt158-*` location, rather than exposing transcripts in Git. The
isolated local-OAuth helper copies an unexpired **access token only** from the
existing Pi login; it never copies the usable refresh token into Studio.
Alternatively the existing live runner accepts the read-only Studio OAuth
source database or an explicit provider API key. No real provider calls run
without an opt-in flag. The provider acquisition check uses an existing local
verified Git worktree instead of a remote GitHub API, which must be certified
separately. A passing E2E run does **not** replace the separate external
quality and recovery audit below.

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

**#158 must remain open** until both real Story modes, negative/recovery
checks and external quality assessment are completed and recorded. A
deterministic check, intact source snapshot or successfully implemented
certification command is not closure evidence by itself.
