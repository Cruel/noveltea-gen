import assert from "node:assert/strict";
import { test } from "node:test";
import { applySelectiveRevalidation, planSelectiveRevalidation,
  decideSelectiveRevalidation } from "../src/selective-revalidation.js";
import type { GenerationInventory, ExecutionItem } from "../src/generation-plan.js";

const sha = (char: string) => char.repeat(40);
const digest = (char: string) => char.repeat(64);
const original = sha("1");
const corrected = sha("2");
const item = (id: string, dependencies: string[], verifiedSha = sha("a")) => ({
  id, stage: id.split(":")[0], kind: "realization",
  targetIds: [id], dependencies, plannedItems: [],
  authorization: { source: "trusted-controller", planVersion: 2, paths: [] },
  status: "verified", verifiedSha, planVersion: 2, skills: [], checks: [],
} as ExecutionItem);
const inventory = (): GenerationInventory => ({
  version: 11, planVersion: 2, headSha: original, rationale: "Verified sources",
  items: [
    item("event:milestone.alpha", []),
    item("interactive:milestone.alpha", ["event:milestone.alpha"]),
    item("composition:milestone.alpha", ["interactive:milestone.alpha"]),
    item("event:milestone.beta", []),
    item("interactive:milestone.beta", ["event:milestone.beta"]),
    item("composition:milestone.beta", ["interactive:milestone.beta"]),
    item("review", ["composition:milestone.alpha", "composition:milestone.beta"]),
  ],
});
const reviewers = () => Object.fromEntries(inventory().items.map((i, index) => [
  i.id, {
    commitSha: i.verifiedSha!, reviewDigest: digest((index + 3).toString(16)),
    status: "passed" as const,
    sourcePaths: i.id.includes(".alpha") ? ["events/alpha.md"] : i.id.includes(".beta")
      ? ["events/beta.md"] : ["events/alpha.md", "events/beta.md"],
  },
]));
const correction = () => ({
  version: 1 as const, planVersion: 2, upstreamItemId: "event:milestone.alpha", baseSha: original,
  successorSha: corrected, predecessorCommitSha: sha("a"),
  reviewDigest: digest("c"), turnDigest: digest("e"),
  changedPaths: ["events/alpha.md"],
  permittedPaths: ["events/alpha.md"],
});
test("one upstream Event correction revalidates only dependent reviewed results", () => {
  const source = inventory();
  const plan = planSelectiveRevalidation({
    inventory: source, correction: correction(), reviews: reviewers(),
  });
  assert.deepEqual(plan.affected, ["composition:milestone.alpha",
    "interactive:milestone.alpha", "review"]);
  assert.deepEqual(plan.unaffected, ["composition:milestone.beta",
    "event:milestone.beta", "interactive:milestone.beta"]);
  assert.deepEqual(plan.unknown, []);
  assert.match(plan.digest, /^[a-f0-9]{64}$/);
  const next = applySelectiveRevalidation(source, plan);
  assert.equal(next.items.find(i => i.id === "interactive:milestone.alpha")!.status, "blocked");
  assert.equal(next.items.find(i => i.id === "composition:milestone.beta")!.status, "verified");
  assert.equal(next.items.find(i => i.id === "event:milestone.alpha")!.status, "verified");
  assert.deepEqual(source.items.every(i => i.status === "verified"), true,
    "Original verified inventory is never overwritten");
});
test("source-read-only consumers are impacted even without direct structural edges", () => {
  const source = inventory(), receipts = reviewers();
  receipts["event:milestone.beta"]!.sourcePaths.push("events/alpha.md");
  const plan = planSelectiveRevalidation({ inventory: source, correction: correction(),
    reviews: receipts });
  assert.ok(plan.affected.includes("event:milestone.beta"));
  assert.ok(plan.affected.includes("interactive:milestone.beta"));
  assert.equal(plan.unaffected.length, 0);
});
test("missing consumption proofs are unknown, never silently carried forward", () => {
  const source = inventory(), receipts = reviewers();
  delete receipts["event:milestone.beta"];
  const plan = planSelectiveRevalidation({ inventory: source,
    correction: correction(), reviews: receipts });
  assert.ok(plan.unknown.includes("event:milestone.beta"));
  assert.ok(plan.affected.includes("composition:milestone.beta"),
    "An unproven parent also invalidates its descendants");
  assert.equal(plan.unaffected.includes("event:milestone.beta"), false);
});
test("stale HEAD, forged correction path, missing review and replacement plan refuse", () => {
  const source = inventory(), receipts = reviewers();
  assert.throws(() => planSelectiveRevalidation({ inventory: source,
    correction: { ...correction(), baseSha: sha("f") }, reviews: receipts }), /source|HEAD/i);
  assert.throws(() => planSelectiveRevalidation({ inventory: source,
    correction: { ...correction(), changedPaths: ["characters/unrelated.md"] },
    reviews: receipts }), /scope/i);
  assert.throws(() => planSelectiveRevalidation({ inventory: source,
    correction: correction(), reviews: { ...receipts,
      "event:milestone.alpha": { ...receipts["event:milestone.alpha"]!,
        status: "failed" } } }), /review/i);
  assert.throws(() => planSelectiveRevalidation({ inventory: {
    ...source, planVersion: 3 }, correction: correction(), reviews: receipts }), /plan|version/i);
});
test("fresh independent verdict carries forward a valid dependent without rewriting old proof", () => {
  const originalInventory = inventory();
  const plan = planSelectiveRevalidation({ inventory: originalInventory,
    correction: correction(), reviews: reviewers() });
  const outcome = decideSelectiveRevalidation(plan, originalInventory, [{
    itemId: "interactive:milestone.alpha", sourceSha: corrected,
    status: "passed", reviewerDigest: digest("d"),
  }]);
  assert.deepEqual(outcome.carriedForward, ["interactive:milestone.alpha"]);
  assert.ok(outcome.pending.includes("composition:milestone.alpha"));
  assert.ok(outcome.pending.includes("review"));
  assert.equal(outcome.failures.length, 0);
});
test("a dependent cannot be certified before its changed upstream dependency", () => {
  const source = inventory();
  const plan = planSelectiveRevalidation({ inventory: source,
    correction: correction(), reviews: reviewers() });
  assert.throws(() => decideSelectiveRevalidation(plan, source, [{
    itemId: "composition:milestone.alpha", sourceSha: corrected,
    status: "passed", reviewerDigest: digest("d"),
  }]), /before its affected upstream/);
  const result = decideSelectiveRevalidation(plan, source, [
    { itemId: "interactive:milestone.alpha", sourceSha: corrected,
      status: "passed", reviewerDigest: digest("d") },
    { itemId: "composition:milestone.alpha", sourceSha: corrected,
      status: "passed", reviewerDigest: digest("a") },
  ]);
  assert.deepEqual(result.carriedForward,
    ["composition:milestone.alpha", "interactive:milestone.alpha"]);
});
test("a downstream finding keeps its identity when the new source SHA or wording changes", () => {
  const source = inventory();
  const first = planSelectiveRevalidation({ inventory: source,
    correction: correction(), reviews: reviewers() });
  const changed = planSelectiveRevalidation({ inventory: source,
    correction: { ...correction(), successorSha: sha("f") }, reviews: reviewers() });
  const report = (sourceSha: string, message: string, path: string) => [{
    itemId: "interactive:milestone.alpha", sourceSha,
    status: "failed" as const, reviewerDigest: digest("d"),
    findings: [{ path, kind: "continuity" as const, message }],
  }];
  const initial = decideSelectiveRevalidation(first, source,
    report(corrected, "Missing evidence", "events/alpha.md"));
  const paraphrased = decideSelectiveRevalidation(changed, source,
    report(sha("f"), "Not justified by on-page events", "events/alpha.md"));
  assert.equal(initial.failures[0]!.id, paraphrased.failures[0]!.id);
  assert.notEqual(initial.failures[0]!.causedBy, paraphrased.failures[0]!.causedBy);
  const different = decideSelectiveRevalidation(first, source,
    report(corrected, "New independent defect", "choice-points/new.md"));
  assert.notEqual(different.failures[0]!.id, initial.failures[0]!.id);
});
test("failed dependent remains pending and emits a causally linked finding, without resetting upstream identity", () => {
  const source = inventory();
  const plan = planSelectiveRevalidation({ inventory: source,
    correction: correction(), reviews: reviewers() });
  const outcome = decideSelectiveRevalidation(plan, source, [{
    itemId: "interactive:milestone.alpha", sourceSha: corrected,
    status: "failed", reviewerDigest: digest("d"),
    findings: [{ path: "choice-points/choice.md", kind: "missing-requirement",
      message: "New conditional payoff is broken." }],
  }]);
  assert.equal(outcome.failures.length, 1);
  assert.equal(outcome.failures[0]!.causedBy, corrected);
  assert.equal(outcome.failures[0]!.itemId, "interactive:milestone.alpha");
  assert.ok(outcome.pending.includes("composition:milestone.alpha"));
  assert.throws(() => decideSelectiveRevalidation(plan, source, [{
    itemId: "event:milestone.beta", sourceSha: corrected,
    status: "passed", reviewerDigest: digest("d"),
  }]), /unaffected|source/i);
});
