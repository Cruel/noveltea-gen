import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArchitectureDraftReview, ARCHITECTURE_DRAFT_CORRECTION_LIMIT } from "../src/architecture-draft-review.js";

const paths = ["arcs/arc-one.md", "milestones/milestone-one.md"];

test("precommit Architecture correction is bounded to two original-session revisions and three independent verdicts", () => {
  assert.equal(ARCHITECTURE_DRAFT_CORRECTION_LIMIT, 2);
  assert.equal(ARCHITECTURE_DRAFT_CORRECTION_LIMIT + 1, 3);
});

test("precommit Architecture review accepts only explicit bounded source-anchored feedback", () => {
  assert.deepEqual(parseArchitectureDraftReview(
    '{"status":"pass","findings":[]}', paths), { status: "pass", findings: [] });
  const result = parseArchitectureDraftReview(JSON.stringify({
    status: "revise", findings: [{
      path: "milestones/milestone-one.md",
      reason: "The player has no independent observation against the witness account.",
      correction: "Describe which testable observation can corroborate the account without inventing an Event.",
    }],
  }), paths);
  assert.equal(result.status, "revise");
  assert.equal(result.findings[0]!.path, paths[1]);
});

test("precommit feedback cannot approve scope, omit evidence or smuggle paths", () => {
  const finding = (path: string) => ({
    status: "revise", findings: [{ path, reason: "Evidence gap", correction: "Describe the test" }],
  });
  for (const invalid of [
    "not JSON", "{}", JSON.stringify({ status: "pass", findings: [{ path: paths[0],
      reason: "ignored", correction: "no" }] }),
    JSON.stringify({ status: "revise", findings: [] }),
    JSON.stringify(finding("creative-direction/foundation.md")),
    JSON.stringify(finding("milestones/../private.md")),
    JSON.stringify(finding("arcs/not-authored.md")),
    JSON.stringify({ ...finding(paths[0]), approved: true }),
    JSON.stringify({ status: "revise", findings: Array(9).fill(finding(paths[0]).findings[0]) }),
    JSON.stringify({ status: "revise", findings: [{
      path: paths[0], reason: "x", correction: "y".repeat(751),
    }] }),
  ]) {
    assert.throws(() => parseArchitectureDraftReview(invalid, paths), /draft review|reviewer/i);
  }
});
