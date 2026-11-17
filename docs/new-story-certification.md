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

## Reviewed causal Architecture blueprint (#181)

New, non-focused real-Pi Architecture assignments establish a provisional causal
blueprint **before** any Arc/Milestone Story writer receives write tools. The
read-only planner reads the approved Creative Direction and pinned Architecture
skills, proposes an ordered chain of concrete inspectable evidence, bounded
inferences, dependent turning points, consequential alternatives and a
supported resolution. A separate read-only Pi reviewer assesses the entire
chain against protected author intent. At most two same-original-planner-session
corrections are admitted, each followed by an independent complete rereview.
Malformed answers, missing required skill/source reads, unauthorized scope
changes, absent reviews and exhausted corrections block without writing Story
bytes. A pass is *not* an author approval, a native validation or a literary
certification.

The controller stores immutable private
`stateDir/architecture-blueprints/plan-<version>-draft-<iteration>.json`
and matching independent `verdict-<iteration>.json` files. The source-derived
`plan-<version>-obligations.json` also pins exact quotes and SHA-256 source
identities for the approved Creative Direction, the original author task and
the authorized scope. Each obligation identifies an applicable causal question,
required proof, reachable route and responsible beat IDs; the independent
reviewer must additionally detect omitted promises rather than treating this
model-proposed inventory as exhaustive by fiat. The source manifest is frozen
through correction and cannot rewrite protected author requirements. A missing
promise requires an explicit fresh source-bound plan, not silent authorization.

Corrections now use `plan-<version>-patch-<iteration>.json` instead of
regenerating the complete blueprint. Each read-only patch is bound to the
exact previous draft and independent revise-verdict digests. Operations must
reference an actual finding and affect only that beat, its causal dependents
or the related conclusion. Exact old-text replacement, append-only evidence
and choices, bounded beat insertion and additional resolution support preserve
unmentioned clues and all previous Choice actions and lasting consequences.
The controller reconstructs and revalidates each merged full draft, including
ordering, dependencies, evidence, size and continuity, then requires an entirely
new independent review. All intermediate reviewer transcript identities are
also preserved and reverified at checkpoint restoration. A partial/interrupted
planner or review is blocked without silent rerun. The original two-correction
limit and canonical Story write boundaries are unchanged.

The first real-Pi plan is now assembled through **separately validated
bounded model turns** in the same read-only planner session: (1) a compact
complete causal outline, fixing ordered beat identities, dependencies,
protected Choices, distinct lasting consequences and resolution; (2) a
sequence of evidence batches of at most two beats each, each with explicit
source, observation, support and limits; and (3) a separately source-quoted
obligation inventory. The controller does not retry the whole design when an
observation or quoted source fragment is malformed; each stage permits one
exact-error correction in isolation. Both the complete assembled design and
all source obligations are validated before independent review. The outline,
each evidence batch and the stage receipt are persisted privately and
bound by digests in new v3 approval pins; restoring an approved plan reassembles
and validates those stages against the frozen initial draft. Previously approved
v2 pins retain their existing strict recovery path. Missing or tampered
intermediate stage evidence fails closed.

The accepted initial drafts were approximately 23 KB of compact JSON each,
leaving almost no space for independently requested causal repairs under the
old 24 KB ceiling. The merged-blueprint ceiling is now 40 KB (still one total
validated size bound, with no arbitrary per-paragraph limit), preserving room
for corrections while leaving all structural, causal and source requirements
unchanged. The evidence and obligation batches use compact **JSONL** with one complete
strict JSON object per line; the initial outline is one bounded JSON object.
A correction patch is one version/digest header followed by independently
parsed JSONL operations. Every line must be valid; malformed, partial,
oversized or extra lines fail closed, without quote normalization or syntax
auto-repair. Legacy complete JSON envelopes are still accepted by the
separately tested original parsing helpers. No wire format grants author
approval or canonical Story writer permissions. A separate immutable
`plan-<version>-admitted.json` receipt is written **before** Pi session creation,
closing the crash window between session creation and its started-session
receipt. A missing or changed admission, start or reviewer receipt blocks
checkpoint restoration without replay.

Only an exact
passing review permits immutable
`plan-<version>-approved.json` publication. It pins the original Job,
Thread, base/head SHAs, plan/contract, model/provider, task digest, skill
snapshot, blueprint and verdict digests, and both original Pi sessions.
The Architecture receipt records the pin as a durable **pre-authoring
recovery boundary**; parent LangGraph resume reopens it and re-verifies
the private evidence instead of rerunning a completed blueprint review.
An interrupted unapproved plan is preserved for manual inspection, not
silently replayed. The canonical Arc/Milestone author receives only the
reviewed blueprint and continues through existing native validation and
the mandatory source-specific independent Architecture review. The
verified Architecture Git checkpoint incorporates the blueprint/verdict
digests as provenance, while the blueprint itself is **not** added to the
Story repository or treated as a transferable author grant. Recovery
forks carry committed Story and independently verified evidence only:
private blueprint sessions and approval pins are never transplanted to
another Job.

This deterministic work requires two **new, complete** real Luna profile
runs and a recovery exercise before #181 can close. Fixture tests of
manifest/patch provenance and structural preservation are not evidence that a
real Luna reviewer approved the full merged story. Existing failed real-Pi
transcripts use the former complete-regeneration protocol and remain unchanged. Earlier failed
Architecture certification attempts remain negative evidence.

**November 17, 2026 implementation and live findings:** The Architecture
blueprint subgraph, immutable draft/review evidence, private source-bound
approval pin, source/skill/session verification and committed-checkpoint
provenance were shipped in `7d63cd2`. Additional corrections permit a beat
to omit an empty decision list, use one global blueprint-size ceiling
rather than unrelated per-field prose limits, apply normal Pi budget checks
before any private planning/review model call, and retain exact fail-closed
planning diagnostics. Structural regression tests pass. Replay of the
preserved real-Pi planner responses confirms that the previously rejected
JSON is now structurally accepted; this does **not** grant semantic approval.

Fresh real Luna narrative-led and choice-heavy runs reached private
blueprint planning and separate independent reviewers. Their verified
Foundation checkpoints were then resumed using same-Thread, source-bound
recovery forks without repeating discovery or exact author approval.
The continuation reviewers identified material defects: the narrative-led
design still left unsupported causal promises after two corrections, while
the choice-heavy corrections did not preserve enough actionable Choice
evidence or proper causal support. Both continuations remained blocked
before any new Architecture commit. The failed drafts, verdicts and original
Pi sessions remain private and preserved. Neither full production-shaped
adaptive profile, its final semantic quality gate, nor the independent
end-to-end Story certification has passed. Keep #181 OPEN.

**November 17, 2026 staged Luna evidence (not certified):**
`071cc6f` split initial planning into independently validated, durable outline,
two-beat evidence and source-quoted obligation stages. Both live adaptive profile
continuations from verified Foundation checkpoints completed these stages and
reached independent blueprint review. Initial compact drafts consumed about
23 KB each and could not accommodate causal repairs within the former 24 KB
merged-design limit; `f284e04` raised that single ceiling to 40 KB without
relaxing causal validation. On `f284e04`, choice-heavy reached two successive
authenticated patches and three independent review verdicts, with findings
counts 5, 3 and 6. The final verdict refused approval. It identified
unmodeled route-specific evidence/trust outcomes after Choices converge,
unsupported motive-as-intent inference, and a nominal 90–120-minute target
without plausible single-route reading/investigation load. No Story writing
was authorized. Narrative-led separately reached independent review; it
identified unsupported assumed testimony and exposure consequences. Its
correction was still in flight at this evidence snapshot, not passed.

The ensuing planner revision requires each Choice alternative to name the
actual knowledge, access, trust or exposure state it changes; later beats
must consume those states even when routes reconverge. It requires reachable
refusal paths, checkable exposure mechanisms, independent causal proof of
motive rather than assumed benefit, and a bounded single-route duration
account when promised. The independent reviewer checks these requirements
and the exact, protected patch protocol remains unchanged. These prompt
changes are deterministic-regression-tested, not certified by the older
in-flight Luna process. Keep #181 open until both complete new-Story
semantic and recovery gates pass.

### Isolating failed Architecture boundaries without regenerating a Story

The production recovery unit remains the **verified Git work-item
checkpoint**. Use the existing `live-new-story-runner.mjs retry` or `fork`
against an eligible Foundation/Architecture SHA only when actually continuing
Story work. An interrupted or semantically rejected **private** blueprint
is not an approved Story checkpoint and cannot be silently reused as one.

For debugging, the existing `replay:step` implementation now supports
the preserved Architecture planning evidence. Given a Job's *private*
`architecture-blueprints` state directory (not a Story root), capture
the exact independently recorded review or bounded correction:

```sh
pnpm replay:step capture-blueprint-review <private-architecture-blueprints-dir> <plan-version> <review-iteration> .local/certification/replay/architecture-review
pnpm replay:step capture-blueprint-patch <private-architecture-blueprints-dir> <plan-version> <patch-iteration> .local/certification/replay/architecture-patch
pnpm replay:step replay .local/certification/replay/architecture-review
pnpm replay:step replay .local/certification/replay/architecture-patch
```

For example, review iteration 0 is the first independent verdict; patch
iteration 1 applies the first correction to that exact review. The
capture verifier checks the immutable source/session lineage, staged
outline/evidence digests, sequential review-session identities and
digests, and all prior exact patches/drafts. Captures and expected
outcomes are private write-once hashes of the observed controller
boundary. A replay is strictly offline and deterministic: no Pi,
credential resolution, Story write, model regrading, author approval
or scope grant. It can reproduce the **same rejection and patch outcome**
while the controller implementation changes; it cannot establish that a
revised narrative is semantically sound. Use a new independent real-Pi
review for that judgment, then finally run production Story certification.

On November 17, the two saved final Luna review failures and the
choice-heavy second patch from the verified Foundation continuation
were successfully captured under
`.local/certification/replay/issue-181-*` and replayed without a Pi
request. The narrative-led final verdict still identified an
unspecified death mechanism and ineffective bell misdirection.
The choice-heavy final verdict still rejected unsupported persistent
branch states and causal proof. These are reproducible diagnostic
cases, **not** passing #181 acceptance evidence.

**November 17 causal-answer follow-up:** Inspection of the saved initial
outlines revealed an upstream error: both deferred selecting a concrete
solution, mechanism, and motive because those facts were not yet in the
canonical Story. That confuses provisional planning with proven canon;
no evidence batch or late correction can reliably prove a mechanism the
outline never specified. New planning now requires
`noveltea-causal-outline/v2`, including a *provisional* but explicit
answer/mechanism/responsibility/motive/misdirection explanation, separately
named direct and independent proof, and a usable witness-refusal fallback.
Every indexed Choice alternative must carry distinct earned/foregone
state into a named later causal beat or resolution. The controller checks
coverage, identity, supported proof-beat IDs, reachable downstream beat
references, and rejects obviously deferred solution placeholders before
costly evidence collection. The existing independent review sees the
frozen proposal and tests the eventual full design against it; it does
not treat the provisional answer as already verified or author-approved
canon. Existing v1 outlines remain valid for exact historical approved
checkpoint restoration; **new** Pi planning cannot emit v1. Stage
digests/pins continue to bind the full outline byte-for-byte.
Offline deterministic tests and stored replay cases exercise this,
but a new real Pi completion is still required.

**November 17 v2 live checkpoint evidence (not certified):** An authenticated
same-Thread continuation on `1edd2c9` reused the previous verified
Foundation checkpoint, generated a concrete 4-beat, 4-Choice-alternative v2
outline, completed bounded evidence/obligation batches, and reached a fresh
independent review. The reviewer found three remaining fixable gaps:
source-specific proof tying the actor to the bell/weapon/service passage,
dated bell/death timing, and a plausible 60–90-minute single-route load.
The original planner proposed eight patch operations, six with permitted
reviewer provenance. Two descendant pacing edits incorrectly used the
**edited beat** as `findingBeatId` instead of the existing early-beat reviewer
finding. The controller correctly refused both original and formatting-retry
responses without authoring canon or issuing a passing verdict. Replay
of the source-bound saved review is captured in the private
`.local/certification/replay/issue-181-v2-narrative-first-review`.
A diagnostic **in-memory only** remap of those two finding references
passed the unchanged full deterministic patch validator, establishing
that this was a precise identifier-protocol failure, not a reason to replay
the rest of the Story. The correction prompt and parser error now provide
the exact reviewed finding-to-descendant map and report **all** invalid
identifiers together. They do not rewrite, waive or autoapprove any patch.
The Architecture failure receipt now distinguishes a settled
`invalid-plan` patch rejection from genuinely `interrupted` Pi work,
so the inspection/recovery advice can identify the correct failure class.
The corrected-prompt diagnostic on `f1b38cb` then accepted patch 1
without a finding-ID violation; the independent reviewer feedback fell
from eight findings to three, and after patch 2 the model returned
a `pass` verdict on the complete blueprint. **The approval is still not
recoverable or certified:** inspection of all three reviewer receipts
found they pointed at the same Pi session ID and JSONL file. The common
`preparePiContext` policy reused its prior session by `group`, ignoring
the distinct review `step`. The source-bound checkpoint verifier and
offline replay correctly rejected this non-independent review lineage;
the Foundation Git SHA and all private evidence remained unchanged.
The architecture blueprint reviewer now uses a distinct
`group=step` for each review iteration, yielding independent sessions
without sharing previous reviewers' messages. The same group-key mistake
in the early precommit Architecture review was corrected. A real-Git
policy regression checks independent session IDs/files and no previous
review content in the next round. New blueprint approval also fails
**before** the next expensive reviewer model call if the planner or a
previous review identity/file recurs; this is not deferred until final
checkpoint restoration. **Neither the invalid historical
approval pin nor its transcripts are rewritten or silently promoted.**
A new checkpoint continuation is required to verify the corrected
independence semantics in real Pi. #181 remains OPEN.

**November 17 isolated outline-stage failure and correction:** A new same-Thread
continuation on `b3a49b0` reused the exact Foundation checkpoint but blocked
before any evidence or review: its first 13.8 KB complete outline response
was malformed JSON, while its one bounded correction duplicated both
alternatives of the same Choice in the route-consequences array. Both raw
responses and the rejection receipt remain in the private Pi transcript;
the controller correctly rejected the second as `invalid-plan`, without
promoting any unapproved Story work. The bottleneck was the oversized
single model response combining causal core, beat graph and all branch states.

The planner now emits a separately validated
`noveltea-causal-outline-core/v1` (proposed solution, beat dependencies,
decisions and resolution), followed by an exact-keyed JSONL route-state
stage enumerated from that **frozen** core. The controller demands
exactly one entry per [beatId, decisionIndex, alternativeIndex], rejects
duplicates/missing alternatives with the specific keys, and assembles the
same full `noveltea-causal-outline/v2` before subsequent evidence and
independent review. There is no relaxation of causal proof or protected
Choice requirements. Private immutable `plan-<version>-outline-core.json`
and `plan-<version>-outline-routes.json` are included in the new
`noveltea-blueprint-stages/v2` receipt alongside outline and evidence
digests; original v1 receipts and approved v2 outlines remain readable.
Exact restoration and offline replay check both stages separately and
reject tampering. This is controller/test evidence only until real Pi runs
produce independently reviewed complete Story output; #181 remains OPEN.

**First live check on `b1d8226` (not passing):** Another authenticated
continuation from the same verified Foundation checkpoint reached the
new causal-core stage but failed before persisting it. The original Luna
response was 12,100 characters and its one bounded correction was 9,985
characters; both ended after the nested `causalAnswer.proof` object and
omitted the final outer JSON closing brace. Their complete raw
responses and rejected receipt are preserved in that child Job's
private planner transcript, with no authored Story change or reviewed
blueprint. This demonstrated that separating the Choice
rows was **not sufficient**: the causal core remained a large,
failure-prone single model response. The planner now collects a short
`noveltea-causal-outline-header/v1` with the proposed concrete solution,
resolution, and fixed ordered beat IDs, then requests only two beat
objects per independently validated JSONL call, then the exact-keyed
Choice route states, then two-beat evidence batches and source-quoted
obligations. An accepted header and earlier beats cannot be silently
regenerated when a later batch fails.

Each stage is preserved in the original source-bound private Job:
`plan-<version>-outline-header.json`,
`plan-<version>-outline-beats-<first>.json`,
`plan-<version>-outline-core.json`, and the existing route and evidence
files. The new `noveltea-blueprint-stages/v3` receipt pins the header,
each beat batch, core, route rows, assembled outline and evidence batch
digests. Both exact checkpoint restore and offline replay revalidate the
full chain. Historical v1/v2 stage receipts remain readable for
already-approved checkpoint recovery; no private evidence is imported
as another Thread's approval. No automatic syntactic repair or extra
independent-review authority is granted. The failure-classifier now
correctly labels settled malformed `Blueprint response` output as
`invalid-plan` rather than an interrupted Pi call. This is
deterministic-regression evidence only until a new real-Pi continuation
passes the complete independent review and Story completion gates;
#181 remains OPEN.

**Live continuation on `9be95b4` (not certified):** Reusing the same
verified Foundation checkpoint, real Luna successfully emitted the
short validated `causal-outline-header/v1` (six ordered beats and a
concrete proposed answer). The following two-beat JSONL stage initially
blocked twice with `Blueprint JSONL line 1 must be a complete,
unwrapped JSON object`. Inspection of both exact saved model outputs
showed **both JSONL lines were parseable JSON objects**; the first line
merely had a trailing ASCII space after its final brace. The wire
codec checked `line.endsWith("}")` before JSON.parse, rejecting
grammar-legal whitespace. The codec now trims **only whitespace**
around each line before strict object checking/JSON.parse; it still
rejects malformed braces, extra text, blank lines, arrays where
objects are required, and oversized responses. Both original model
responses were replayed read-only against the preserved six-beat
header using the corrected parser: the expected two beat IDs were
accepted verbatim, without editing any original source/response or
making a new Pi call. The regression suite covers whitespace and
negative shape cases. The remaining full Story semantic/recovery
gates have not passed. #181 stays OPEN.

## Adaptive Story profile gate (#181, opt-in only)

Issue #181 additionally requires **two** complete real-Pi runs that exercise
actual controller-admitted adaptive assignments, not merely the original
fixed Architecture inventory. The existing Studio test/runner accepts a
distinct, intentionally author-proposed profile per fresh Story:

```sh
NT_TEST_WEB_PI_ADAPTIVE_SHAPE=narrative-led node scripts/live-new-story-runner.mjs start autonomous
node scripts/live-new-story-runner.mjs status autonomous
NT_TEST_WEB_PI_ADAPTIVE_SHAPE=choice-heavy node scripts/live-new-story-runner.mjs start collaborative
node scripts/live-new-story-runner.mjs status collaborative
```

The launcher pins `NT_ADAPTIVE_PLANNING=1` **only** for this explicit
certification. Each successful run must show a genuine admitted read-only
Pi plan amendment, independent final `turn-completeness/v1` semantic pass
against the original request and canonical Interaction profile, and a
verified Story including actual authored Events, interactions and
player-facing content. Narrative-led must additionally show a reviewed
no-write omission; choice-heavy must show a real add/split/narrow/depend
amendment. The reviewer must assess causal branch consequences through
reconvergence, not record counts or uniform Milestone quotas.

The saved local observation includes `adaptiveShape`, `adaptiveEvidence`,
`finalGoal`, `recoveryCheckpoints` and source-bound receipt digests;
missing, interrupted and malformed evidence fails closed. The
`NT_TEST_WEB_PI_DIAGNOSTIC=1` option, for a trusted isolated run, logs
a **category only** for a failed discovery turn; no raw model/provider
message or OAuth credential is printed.

For checkpoint recovery, pass the preserved verified commit to
`node scripts/live-new-story-runner.mjs retry <mode> <sha>`. The retry
in a separately allocated Job retains the original Author Turn as
read-only review criteria and completed specialist commits but cannot
inherit an amended writer grant. The observation explicitly marks it as
`recoveryOnly`, not a fresh adaptive amendment admission. A blocked
specialist or original reviewer, including a required protected author
change, is **not** a certification success. Keep its exact preserved
Pi session and original native/Git receipts; do not auto-restart or
forge approval in a test.

**November 16, 2026 corrective workflow changes (not yet a live certification pass):**
The adaptive orchestrator now requests missing pinned skill reads once inside
its original, read-only Pi session, verifies successful tool-read receipts,
and requires the complete six-field proposal again. A new independent,
read-only precommit Architecture critique checks source-visible causal
prerequisites, lasting Choice consequences and route estimates. Its feedback
permits at most two same-original-writer-session corrections of the already authorized
Arc/Milestone draft, each followed by independent rereview. The existing native,
protected-decision and postcommit semantic gates remain mandatory. Event-local
no-write corrections now describe source-visible ledger/trace discrepancies
explicitly: the writer may present evidence in its original authorized Event,
but cannot invent an authoritative off-screen alteration, a new Fact or
another-owner grant. Cross-owner and protected changes still require a
separate typed, authenticated amendment and cannot be inferred from prose.
A fresh choice-heavy Luna certification at `5151ab8` exercised the new
precommit reviewer: its first verdict identified a missing concrete testable
observation, the original writer revised that Milestone, and a separate
rereview then identified a missing concrete terminal Arc action/consequence.
The original one-correction limit blocked safely before committing Architecture;
only Foundation had a verified checkpoint. The subsequently strengthened writer
prompt requires these concrete details up front, and the precommit gate now
requests all source-grounded findings together and permits at most two
corrections in the SAME original session, each independently rereviewed. The
failed draft and private sessions remain preserved, not silently replayed.
Deterministic coverage is necessary but the two full real-Pi scenario
acceptance runs below remain the criterion for closing #181.

**Further #181 real-Pi attempts on `844007b` (not passing):** Fresh narrative-led and
choice-heavy Stories used independent Foundation approval and reached the
uncommitted Architecture review. The narrative-led reviewer found that the
planned disappearance resolution and evidence trail remained causally
unsupported after two same-session corrections. The choice-heavy reviewer
caught a missing independent observation and protected welfare alternative;
its final response contained an invalid record path (a period in place of
the folder slash), which the controller correctly refused to accept. Both
runs blocked without an Architecture commit and without adaptive plan
admission. No original-author objective, negative verdict or protected
decision was waived.

The subsequent Architecture prompt now explicitly distinguishes delegated
future on-page clue *planning* from asserting already-proven canonical Facts,
requires concrete causal links to the promised mystery outcome, and demands
that author-protected safety/Choice requirements survive route convergence.
The read-only draft reviewer can request ONE exact same-session correction
for a malformed typed verdict; the controller still rejects unauthorized
paths and preserves the complete transcript, and the mandatory review and
two writer-correction limit remain unchanged. No full end-to-end success
is claimed for these runs.

**November 16, 2026 real-Pi observations:** The source-bound
narrative-led Story approved `puzzle_emphasis: none` and zero formal
Puzzles, verified Architecture and independent reviews. Its real
adaptive planning attempt was correctly read-only but initially
blocked at restart because the controller rejected canonical Story
reads inside a legitimate pinned Pi transcript. That verifier defect
was corrected and the original transcript successfully reopened.
A later authenticated same-Thread checkpoint continuation reused the
verified original Architecture and progressed through multiple
native-validated Event commits and independent reviews. The Story
ultimately remained blocked by a genuinely missing causal
prerequisite and exhausted bounded correction reviews: it did not
pass whole-Story completion.

Two separate choice-heavy live runs produced native-valid Architecture
commits, but independent semantic reviewers rejected them for
insufficient source-backed decision consequences and/or inconsistent
route-duration estimates. The controller correctly required an
author-approved Architecture change and did not escalate a writer's
scope. Architecture prompts now request explicit causal decision
and post-reconvergence planning and warn against summing mutually
exclusive route estimates. These are **negative production evidence**,
not a live end-to-end pass. Keep #181 and parent #177 open until
new full live runs pass; neither the recovery-only child nor the
deterministic fixture suite satisfies the remaining Story acceptance
criteria. The separate #158/#159/#160 release requirements still apply.

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
