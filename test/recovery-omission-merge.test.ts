import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeRecoveryOmissions } from "../src/recovery-checkpoints.js";

test("cumulative Event-only omission checkpoints retain one seal per work item", () => {
  const mara = { nonce: "mara", digest: "a".repeat(64) };
  const departure = { nonce: "departure", digest: "b".repeat(64) };
  const desk = { nonce: "desk", digest: "c".repeat(64) };
  const pair = (slug: string, seal: typeof mara) => [
    { workItem: "interactive-choice-" + slug, seal },
    { workItem: "interactive-puzzle-" + slug, seal },
  ];
  // The second finalized checkpoint embeds all first-checkpoint omissions.
  // A third composition commit must not misinterpret that history as a new
  // independent no-write approval and reject its own finalization.
  const first = pair("mara-brought-out", mara);
  const second = [...first, ...pair("the-apparent-departure", departure)];
  const third = pair("the-empty-desk", desk);
  const merged = mergeRecoveryOmissions(first, second, third);
  assert.deepEqual(merged, [...first, ...pair("the-apparent-departure", departure), ...third]);

  // A changed seal for the same work item must still fail closed rather than
  // letting the latest entry replace or silently inherit an old decision.
  assert.throws(() => mergeRecoveryOmissions(first, [
    { workItem: first[0]!.workItem, seal: { ...mara, digest: "d".repeat(64) } },
  ]), /conflict|differs|mismatch/i);
  assert.throws(() => mergeRecoveryOmissions([first[0]!, first[0]!]),
    /duplicate.*one recovery source/i,
    "One receipt cannot duplicate a decision even when the two seals match");
});
