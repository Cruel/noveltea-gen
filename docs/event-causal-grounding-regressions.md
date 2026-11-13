# Event causal grounding and bounded corrections (#162)

## Diagnosis

`20856cf` added disappearance-specific examples separately to the Event writer
and reviewer. It did not provide the same policy to the resumed original writer,
and the repair packet only carried finding descriptions and affected paths.
The saved Autonomous sequence demonstrates the resulting oscillation:

- `2707cb7` → `d37f675`: a correction supplied an asserted past observation/record
  without establishing who perceived it or how the player received it.
- `d37f675` → `e6e2a33`: removing that assertion left expectation rather than a
  credible last-known presence. Two corrections correctly exhausted the budget.
- `12ab1bd` → `26ba3fe` → `51d2f97` is the positive recorded sequence: the final
  independent review passed.

A separate controller defect replaced the failed source's `findings` with its
successor's negative findings. That conflicts with `inspectRejectedRepair`'s
comparison against the original sealed review and can prevent restart inspection
or the next bounded correction. Source findings now stay immutable; the successor
findings are stored separately and checked against the successor's sealed verdict.
Old already-corrupted receipts are not silently migrated or rewritten.

## Shared contract

`src/event-causal-grounding.ts` supplies the same semantic contract to initial
Event authoring, independent assignment review (including Event repair checkpoints)
and original-session correction. It requires an evidence/source/uncertainty →
inference → typed-consequence chain appropriate to the actual selected Milestone.
It does not require omniscient proof, multiple witnesses, a culprit, harm, or
story-specific mechanics.

Before claiming a repair turn, the controller builds feedback from exact rejected
Git blobs: the offending line, required correction, and original Event assignment's
Milestone/Arc/Character/Fact/earlier-Event sources, plus finding-linked dependencies.
These sources remain read-only unless in the existing repair grant. Dirty files,
later commits, inbox material, symlinks and oversized contexts cannot substitute
for those blobs. Oversized or missing context stops before a paid writer call.
Missing evidence can be delivered within the authorized Event as a sourced,
player-visible observation/report before its inference, not invented established
history. A correction needing new scope or protected truth must escalate.

No retry framework, approval path, native acceptance rule, model pin, skill pin,
writer identity or reviewer independence is replaced. The existing two-correction
budget, crash fences, native validation, Git checkpoints and fresh independent
review still govern advancement.

## Regression evidence

Focused commands (no new runner):

```sh
pnpm typecheck
pnpm lint
pnpm exec tsx --test test/event-work.test.ts test/review-repair-amendment.test.ts \
  test/rejected-review-repair.test.ts test/rejected-repair-controller.test.ts \
  test/semantic-assignment-review.test.ts
```

Coverage:

- Exact pinned offending lines and required corrections, original selected
  Milestone context even when not named by a finding, and immutable feedback
  after a permitted in-Event Git correction delivers testimony before inference.
- Source versus successor findings on pass, negative rereview and exhaustion;
  stale-successor verdict rejection. Existing controller tests cover independent
  rereview order, two-attempt exhaustion, no replay of uncertain writes, and
  authenticated resumption of a paused author-choice cycle.
- Existing native Event tests cover missing foundations, impossible prerequisites,
  localized correction, exhaustion with preserved draft, Milestone fulfillment,
  protected records, unrelated records and native validation.
- Human-labelled minimal reviewer cases cover expected presence, unshown and
  unreachable clues, uncertain testimony promoted to truth, missing prerequisites,
  invented past timestamps, premature knowledge/relationships and contradiction.
  The reviewer/repair seam preserves each finding as a bounded single-owner
  obligation. A sourced ambiguous account is permitted to pass without resolving
  harm or culpability.

Private saved-data replay is opt-in and uses the existing tests:

```sh
NT_TEST_EVENT_REPAIR_STATE=<saved-Autonomous-job-state> \
  pnpm exec tsx --test test/rejected-review-repair.test.ts
NT_TEST_SEMANTIC_REPLAY_STATE=<saved-Collaborative-job-state> \
  pnpm exec tsx --test test/semantic-assignment-review.test.ts
```

Both were run locally against the issue's saved jobs. Autonomous replay reads the
four exact source reviews, original assignments and committed blobs without
writing any saved state; the terminal transitions reproduce failed → passed and
failed → blocked respectively while retaining original findings. Collaborative
replay retains the two recorded negative responses through the #161 packet path
and confirms bounded Event-only correction authority.

**Evidence limit:** human-labelled cases verify the feedback/authority protocol,
not automated natural-language understanding. Recorded model responses verify
historical findings, not a newly generated model correction. No new real-Pi
full-Story generation or new live semantic pass is claimed here. #158 still owns
complete playable Autonomous and Collaborative certification.
