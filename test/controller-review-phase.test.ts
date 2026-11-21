import assert from "node:assert/strict";
import { test } from "node:test";
import { reportControllerReviewPhase, withControllerReviewPhase } from "../src/controller-review-phase.js";

test("#213 trusted review phase reports only inside the scoped controller execution", async () => {
  const observed: string[] = [];
  await reportControllerReviewPhase("diagnosing");
  assert.deepEqual(observed, [], "unscoped CLI work has no Studio event sink");
  await withControllerReviewPhase(async phase => { observed.push("outer:" + phase); }, async () => {
    await reportControllerReviewPhase("correcting");
    await withControllerReviewPhase(async phase => { observed.push("inner:" + phase); },
      async () => { await reportControllerReviewPhase("diagnosing"); });
    await reportControllerReviewPhase("correcting");
  });
  await reportControllerReviewPhase("diagnosing");
  assert.deepEqual(observed, ["outer:correcting", "inner:diagnosing", "outer:correcting"],
    "nested executions cannot leak reporter identity or create phantom events");
});
