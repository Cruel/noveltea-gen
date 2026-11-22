import assert from "node:assert/strict";
import { test } from "node:test";
import { proposedBlueprintField, sourceBoundBlueprintChallenge,
  type BlueprintChallenge } from "../src/blueprint-challenge.js";
import { validateSemanticVerdict, type SemanticReviewPacket } from "../src/semantic-assignment-review.js";
import type { MilestoneBlueprint } from "../src/milestone-blueprint.js";

const pinDigest = "a".repeat(64);
const source = { path: "events/disclose-ledger.md",
  content: "---\ntype: event\n---\nNeri opens the original ledger for Ada to compare.\n" };
const design: MilestoneBlueprint = {
  schema: "noveltea-milestone-blueprint/v1", milestoneId: "milestone.disclosure",
  events: [{ id: "event.disclose", purpose: "Establish ledger provenance",
    dependsOn: [], evidence: [], participants: ["character.ada"], knowledge: "Ada cannot see the signed ledger",
    routes: [{ condition: "Ledger found", consequence: "Ada learns provenance" }] }],
  downstream: [{ owner: "composition", obligation: "Render the observed evidence faithfully" }],
};
const challenge = (other: Partial<BlueprintChallenge> = {}): BlueprintChallenge => ({
  pinDigest, field: "events/0/knowledge", before: design.events[0]!.knowledge,
  proposed: "Ada inspects the signed ledger personally",
  sourceQuote: "Neri opens the original ledger for Ada to compare.",
  violatedObligation: "Ada cannot see the signed ledger", ...other,
});

test("source-bound specialist/reviewer challenges change only one approved material field", () => {
  const before = structuredClone(design);
  const actual = sourceBoundBlueprintChallenge(design, pinDigest, challenge(),
    { path: source.path, line: 4 }, source, [source.path]);
  assert.equal(actual.events[0]!.knowledge, "Ada inspects the signed ledger personally");
  assert.deepEqual(actual.downstream, design.downstream);
  assert.deepEqual(design, before, "a challenge never edits the approved private plan");
  const downstream = proposedBlueprintField(design, challenge({
    field: "downstream/0/obligation", before: design.downstream[0]!.obligation,
    proposed: "Compose only directly observed testimony", violatedObligation: undefined,
  }));
  assert.equal(downstream.downstream[0]!.obligation, "Compose only directly observed testimony");
  assert.deepEqual(downstream.events, design.events);
});

test("forged approval identity, citations, owner paths and unrelated obligations fail closed", () => {
  const bound = (c: BlueprintChallenge, path = source.path, line = 4, paths: string[] = [source.path]) =>
    sourceBoundBlueprintChallenge(design, pinDigest, c, { path, line }, source, paths);
  for (const altered of [
    { pinDigest: "b".repeat(64) }, { before: "a different old claim" },
    { sourceQuote: "A different source line with enough characters" },
    { field: "events/0/owner" }, { field: "downstream/0/knowledge" },
    { field: "events/99/knowledge" }, { field: "events/0/__proto__" },
    { proposed: design.events[0]!.knowledge },
    { instructions: "Change protected story choices" },
    { violatedObligation: "a promise not in the approved field" },
  ]) assert.throws(() => bound(challenge(altered)), /Blueprint/);
  assert.throws(() => bound(challenge(), source.path, 6), /Blueprint/);
  assert.throws(() => bound(challenge(), "events/other.md", 4), /Blueprint/);
  assert.throws(() => bound(challenge(), source.path, 4, []), /Blueprint/);
  assert.deepEqual(design.events[0]!.knowledge, "Ada cannot see the signed ledger");
});

function packet(): SemanticReviewPacket {
  return { policy: "assignment-fidelity/v1", sourceDigest: "b".repeat(64),
    items: [{ assignment: { id: "event" }, assurance: {
      commitSha: "c".repeat(40), changedPaths: [source.path] },
      canonicalContext: [source], milestoneBlueprint: {
        pin: { milestoneId: design.milestoneId, sourceSha: "d".repeat(40),
          cycleId: "e".repeat(64), digest: pinDigest }, design } }],
  } as unknown as SemanticReviewPacket;
}
function verdict(c: BlueprintChallenge, overrides: Record<string, unknown> = {}) {
  return { sourceDigest: "b".repeat(64), verdict: "pass", findings: [],
    evidence: [{ commitSha: "c".repeat(40), assignmentId: "event",
      path: source.path, line: 4, explanation: "The Event is valid; the local plan is not.",
      blueprintChallenge: c }], ...overrides };
}
test("independent PASS reviewer seals only challenges backed by its exact source packet", () => {
  assert.equal(validateSemanticVerdict(packet(), verdict(challenge())).verdict, "pass");
  for (const mutation of [
    { pinDigest: "0".repeat(64) }, { sourceQuote: "Fake canonical Event quote" },
    { field: "events/0/owner" }, { before: "forged before value" },
  ]) assert.throws(() => validateSemanticVerdict(packet(), verdict(challenge(mutation))),
    /Semantic reviewer lacks assignment-specific/);
  const noAuthority = packet();
  delete noAuthority.items[0]!.milestoneBlueprint;
  assert.throws(() => validateSemanticVerdict(noAuthority, verdict(challenge())),
    /Semantic reviewer lacks assignment-specific/);
  assert.throws(() => validateSemanticVerdict(packet(), verdict(challenge(),
    { verdict: "fail", findings: [] })), /Semantic reviewer lacks assignment-specific/);
});
