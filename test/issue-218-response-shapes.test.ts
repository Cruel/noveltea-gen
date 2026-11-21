import assert from "node:assert/strict";
import { test } from "node:test";
import { adaptiveResponseFailures } from "../src/adaptive-protocol.js";

const proposal = {
  sourceSha: "a".repeat(40), turnDigest: "b".repeat(64), beforeVersion: 1,
  reason: "Respond with the next admissible work", actions: [], order: [],
};
const failures = (patch: Record<string, unknown>) =>
  adaptiveResponseFailures(JSON.stringify({ ...proposal, ...patch }));

test("#218 corrects malformed array entries in the original protocol, not in semantic admission", () => {
  assert.deepEqual(failures({ actions: [null] }), [
    { path: "$.actions[0]", expected: "action object with a recognized kind" },
  ]);
  assert.deepEqual(failures({ actions: [{ kind: "add", stage: "event", milestone: "milestone.one",
    dependsOn: [42] }] }), [
    { path: "$.actions[0].dependsOn[0]", expected: "string" },
  ]);
  assert.deepEqual(failures({ order: [null] }), [
    { path: "$.order[0]", expected: "string" },
  ]);
  assert.deepEqual(failures({ actions: [{ kind: "split", item: "event:milestone.one",
    domains: ["not-a-domain"] }] }), [
    { path: "$.actions[0].domains[0]", expected: "choice|puzzle" },
  ]);
  assert.deepEqual(failures({ actions: [{ kind: "omit", item: "event:milestone.one",
    unauthorized: true }] }), [
    { path: "$.actions[0].unauthorized", expected: "no unknown fields" },
  ]);
  assert.deepEqual(failures({ actions: [{ kind: "add", stage: "event",
    milestone: "milestone.one", dependsOn: ["foundation"] }] }), []);
  // An unauthorized but well-shaped semantic change still reaches the
  // separate trusted controller's source/authority admission.
  assert.deepEqual(failures({ sourceSha: "wrong", actions: [
    { kind: "omit", item: "protected-target" },
  ] }), []);
});
