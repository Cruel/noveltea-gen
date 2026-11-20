import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCausalAmendment, verifyCausalAmendment } from "../src/causal-amendment.js";
import type { GenerationInventory, ExecutionItem } from "../src/generation-plan.js";

const id = "a".repeat(40);
const digest = "b".repeat(64);
const source = "The signed ledger proves the transfer happened at midnight, but the witness was elsewhere.";
const blueprint = {
  schema: "noveltea-milestone-blueprint/v1" as const,
  milestoneId: "milestone.disclosure",
  events: [{
    id: "clue", purpose: "Prove the signed ledger",
    dependsOn: [], evidence: [{ anchorPath: "milestones/disclosure.md",
      source: "signed ledger", observation: "A witnessed transfer",
      access: "archive", establishes: "Transfer occurred at midnight", limits: "Witness disputed" }],
    participants: ["character.ada"], knowledge: "Ada knows the time", routes: [],
  }],
  downstream: [{ owner: "composition" as const, obligation: "Show the transfer record" }],
};
function item(id: string, status: "verified" | "pending", dependencies: string[] = []): ExecutionItem {
  const [stage, milestone] = id.split(":");
  return { id, stage: stage as ExecutionItem["stage"], milestone,
    plannedItems: [], kind: "realization", targetIds: milestone ? [milestone] : [],
    dependencies, skills: [], checks: [], planVersion: 1,
    authorization: { source: "explicit-author-cli", planVersion: 1, paths: [] },
    status, ...(status === "verified" ? { verifiedSha: "c".repeat(40) } : {}) };
}
const items = [
  item("foundation", "verified"),
  item("architecture", "verified", ["foundation"]),
  item("foundations", "verified", ["architecture"]),
  item("event:milestone.unrelated", "verified", ["foundations"]),
  item("interactive:milestone.unrelated", "verified", ["event:milestone.unrelated"]),
  item("event:milestone.disclosure", "pending", ["foundations"]),
  item("interactive:milestone.disclosure", "pending", ["event:milestone.disclosure"]),
  item("event:milestone.reckoning", "verified", ["event:milestone.disclosure"]),
  item("composition:milestone.reckoning", "verified", ["event:milestone.reckoning"]),
  item("review", "pending", ["composition:milestone.reckoning"]),
];
const inventory: GenerationInventory = { version: 3, planVersion: 1, headSha: id,
  items, rationale: "Fixture" };
const input = {
  jobId: "job-1", threadId: "thread-1", sourceSha: id, planVersion: 1,
  reportDigest: digest, milestoneId: "milestone.disclosure",
  sourcePaths: ["milestones/disclosure.md", "arcs/truth.md"],
  sourcePath: "milestones/disclosure.md",
  sourceText: source,
  sourceQuote: "The signed ledger proves the transfer happened at midnight",
  violatedObligation: "Transfer occurred at midnight",
  proposedCorrection: "Clarify when the ledger was actually signed, without changing author choices.",
  localBlueprint: blueprint,
  blueprintDigest: "d".repeat(64),
  inventory,
  reviewedWorkItems: ["foundations", "event:milestone.unrelated", "interactive:milestone.unrelated", "event:milestone.reckoning", "composition:milestone.reckoning"],
};

test("upstream causal contradiction gets precise affected descendants and preserves independent reviewed work", () => {
  const proposed = buildCausalAmendment(input);
  assert.deepEqual(proposed.affected, [
    "event:milestone.disclosure", "interactive:milestone.disclosure",
    "event:milestone.reckoning", "composition:milestone.reckoning", "review",
  ]);
  assert.deepEqual(proposed.carryForward, [
    "foundations", "event:milestone.unrelated", "interactive:milestone.unrelated",
  ]);
  assert.equal(proposed.authority, "proposal-only");
  assert.equal(proposed.source.sha, id);
  verifyCausalAmendment(proposed, input);
});

test("wrong Thread, stale HEAD, tampered proof, ungrounded quotes and wrong local plan fail closed", () => {
  const proposal = buildCausalAmendment(input);
  for (const patch of [
    { threadId: "other" }, { sourceSha: "e".repeat(40) },
    { reportDigest: "f".repeat(64) }, { sourceText: "Clue removed" },
    { sourceQuote: "A forged witness says otherwise" },
    { violatedObligation: "Invent new culprit" },
    { blueprintDigest: "0".repeat(64) },
  ]) assert.throws(() => verifyCausalAmendment(proposal, { ...input, ...patch }));
  assert.throws(() => verifyCausalAmendment({ ...proposal, carryForward: [...proposal.carryForward, "event:milestone.reckoning"] }, input));
});

test("no source-bound finding, ambiguous target, cyclic inventory or protected source is never a grant", () => {
  assert.throws(() => buildCausalAmendment({ ...input, sourcePath: "characters/ada.md" }));
  assert.throws(() => buildCausalAmendment({ ...input, sourceQuote: "signed" }));
  assert.throws(() => buildCausalAmendment({ ...input,
    sourceText: input.sourceText + " " + input.sourceQuote }));
  assert.throws(() => buildCausalAmendment({ ...input, localBlueprint: { ...blueprint, milestoneId: "milestone.other" } }));
  const cyclic = { ...inventory, items: items.map(i => ({ ...i, dependencies: i.id === "event:milestone.disclosure"
    ? ["event:milestone.reckoning"] : i.dependencies })) };
  assert.throws(() => buildCausalAmendment({ ...input, inventory: cyclic }));
});
