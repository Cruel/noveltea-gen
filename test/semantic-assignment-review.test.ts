import assert from "node:assert/strict";
import { test } from "node:test";
import { validateSemanticVerdict, semanticUnitOutcome,
  type SemanticReviewPacket } from "../src/semantic-assignment-review.js";
import { assertSemanticCorrectionPreserved } from "../src/narrative-review-specialist.js";

const makePacket = (group = false): SemanticReviewPacket => {
  const item = (id: string, path: string, sha: string) => ({
    reviewedWorkItem: id, unitOutcome: semanticUnitOutcome(id),
    assignment: { id, specialist: "nt-character-development", outcome: "Give Nia a reason to wait",
      targets: ["character.nia"], dependsOn: [], discovery: "canonical-story-read-only" as const,
      authority: { recordTypes: ["character"], existingPaths: [path], mayCreate: false } },
    assurance: { version: 1 as const, policyVersion: 1 as const, jobId: "j",
      baseSha: "a".repeat(40), parentSha: "a".repeat(40), commitSha: sha,
      workItem: id, validationProofDigest: "c".repeat(64), validatorVersion: "1",
      turnDigest: "d".repeat(64), assignmentId: id, assignmentDigest: "e".repeat(64),
      assignmentDependencies: [], changedPaths: [path], changedRecordTypes: ["character"],
      addedLines: 1, removedLines: 0, diffDigest: "f".repeat(64),
      reviewSelection: { status: "required-pending" as const, reasons: ["large-diff"] } },
    diff: "diff --git a/" + path + " b/" + path,
    canonicalContext: [{ path, content: "# Nia\nNia waits." }],
  });
  return { policy: "assignment-fidelity/v1", sourceDigest: "source",
    items: [item("focus:character.nia", "characters/nia.md", "b".repeat(40)),
      ...(group ? [item("focus:character.eli", "characters/eli.md", "c".repeat(40))] : [])] };
};
const evidence = (id: string, path: string, commitSha = "b".repeat(40)) =>
  ({ commitSha, assignmentId: id, path, line: 2, explanation: "Source text supports the assigned change." });
const finding = (id: string, path: string, kind: "missing-requirement" |
  "unrequested-change" = "missing-requirement", commitSha = "b".repeat(40)) =>
  ({ commitSha, assignmentId: id, path, line: 2, kind,
    message: "Required motive is missing.",
    requiredCorrection: "Write Nia's established promise as the motive for waiting.",
    affectedPaths: [path] });

test("multi-unit review requires only the exact current specialist unit, not its successor", () => {
  const world = semanticUnitOutcome("world-foundations");
  const characters = semanticUnitOutcome("character-foundations");
  const choice = semanticUnitOutcome("interactive-choice-disclosure");
  const puzzle = semanticUnitOutcome("interactive-puzzle-disclosure");
  assert.match(world, /NEXT separately committed character-foundations/);
  assert.match(world, /Do not fail World Foundations solely for not writing Characters/);
  assert.match(characters, /missing central Characters are a failure/);
  assert.match(choice, /separate later interactive-puzzle/);
  assert.match(puzzle, /Assess real solvability/);
  const packet = makePacket();
  assert.equal(packet.items[0]!.reviewedWorkItem, "focus:character.nia");
  assert.match(packet.items[0]!.unitOutcome, /exact committed work item/);
});

test("source correction preserves the original negative finding despite model paraphrasing", () => {
  const original = { verdict: "fail", findings: [{
    kind: "continuity", message: "The Event makes the wary Characters trusting too early.",
    requiredCorrection: "Remove the unsupported trusting relationship effect.",
    commitSha: "wrong", assignmentId: "event", path: "story/events/clue.md",
    affectedPaths: ["events/clue.md", "relationships/wary.md"], line: 20,
  }] };
  const corrected = { verdict: "fail", findings: [{ ...original.findings[0],
    commitSha: "a".repeat(40), path: "events/clue.md", line: 21,
    message: "The people gain trust too quickly.", requiredCorrection: "Revise their bond." }],
    evidence: [{ commitSha: "a".repeat(40), assignmentId: "event", path: "events/clue.md",
      line: 21, explanation: "The Event applies the trusting state." }] };
  const preserved = assertSemanticCorrectionPreserved(original, corrected) as typeof corrected;
  assert.equal(preserved.verdict, "fail");
  assert.equal(preserved.findings[0]!.path, "events/clue.md");
  assert.equal(preserved.findings[0]!.commitSha, "a".repeat(40));
  assert.equal(preserved.findings[0]!.message, original.findings[0]!.message);
  assert.equal(preserved.findings[0]!.requiredCorrection, original.findings[0]!.requiredCorrection);
  assert.deepEqual(preserved.findings[0]!.affectedPaths, original.findings[0]!.affectedPaths);
  assert.throws(() => assertSemanticCorrectionPreserved(original, { verdict: "pass", findings: [] }),
    /cannot erase/);
  assert.throws(() => assertSemanticCorrectionPreserved(original, { verdict: "fail", findings: [] }),
    /cannot erase/);
  assert.throws(() => assertSemanticCorrectionPreserved(original, { ...corrected,
    findings: [{ ...corrected.findings[0]!, kind: "other" }] }), /cannot change/);
  assert.throws(() => assertSemanticCorrectionPreserved(original, { ...corrected,
    findings: [{ ...corrected.findings[0]!, path: "events/another.md" }] }), /cannot change/);
});

test("faithful single assignment passes with exact source-linked evidence", () => {
  const packet = makePacket();
  assert.equal(validateSemanticVerdict(packet, { sourceDigest: packet.sourceDigest,
    verdict: "pass", findings: [],
    evidence: [evidence("focus:character.nia", "characters/nia.md")] }).verdict, "pass");
});
test("irrelevant creative addition and missing assignment requirement are actionable failures", () => {
  const packet = makePacket();
  for (const kind of ["missing-requirement", "unrequested-change"] as const) {
    const result = validateSemanticVerdict(packet, { sourceDigest: packet.sourceDigest,
      verdict: "fail", findings: [finding("focus:character.nia", "characters/nia.md", kind)],
      evidence: [] });
    assert.equal(result.findings[0]!.kind, kind);
  }
});
test("group review attributes failure to its exact assignment and record", () => {
  const packet = makePacket(true);
  assert.equal(validateSemanticVerdict(packet, { sourceDigest: packet.sourceDigest,
    verdict: "fail", findings: [finding("focus:character.eli", "characters/eli.md", "missing-requirement", "c".repeat(40))],
    evidence: [evidence("focus:character.nia", "characters/nia.md")] }).findings[0]!.assignmentId,
    "focus:character.eli");
  assert.throws(() => validateSemanticVerdict(packet, { sourceDigest: packet.sourceDigest,
    verdict: "pass", findings: [],
    evidence: [evidence("focus:character.nia", "characters/nia.md")] }), /source-linked/);
  assert.throws(() => validateSemanticVerdict(packet, { sourceDigest: packet.sourceDigest,
    verdict: "fail", findings: [finding("focus:character.eli", "characters/eli.md",
      "missing-requirement", "c".repeat(40))], evidence: [] }), /source-linked/,
    "a grouped failure cannot silently approve an unchecked sibling");
  assert.throws(() => validateSemanticVerdict(packet, { sourceDigest: packet.sourceDigest,
    verdict: "fail", findings: [finding("focus:character.eli", "characters/eli.md",
      "missing-requirement", "b".repeat(40))],
    evidence: [evidence("focus:character.nia", "characters/nia.md")] }), /source-linked/,
    "the wrong checkpoint cannot receive another checkpoint's finding");
});
test("repeated assignment IDs remain distinct across group checkpoint commits", () => {
  const packet = makePacket(true);
  packet.items[1]!.assignment.id = packet.items[0]!.assignment.id;
  packet.items[1]!.assurance.assignmentId = packet.items[0]!.assurance.assignmentId;
  assert.equal(validateSemanticVerdict(packet, { sourceDigest: packet.sourceDigest,
    verdict: "fail", findings: [finding("focus:character.nia", "characters/eli.md",
      "unrequested-change", "c".repeat(40))],
    evidence: [evidence("focus:character.nia", "characters/nia.md")] }).findings[0]!.commitSha,
    "c".repeat(40));
});
test("cross-domain causal defect names real linked context but cannot invent a writable record", () => {
  const packet = makePacket();
  packet.items[0]!.canonicalContext.push({ path: "facts/promise.md",
    content: "# Fact\nNia knows the witness made a promise." });
  const actual = { ...finding("focus:character.nia", "characters/nia.md"),
    kind: "continuity" as const, affectedPaths: ["characters/nia.md", "facts/promise.md"],
    message: "Nia behaves as if she never learned the Fact referenced by her dialogue.",
    requiredCorrection: "Correct Nia's dialogue so it acknowledges the learned Fact without rewriting it." };
  assert.equal(validateSemanticVerdict(packet, { sourceDigest: packet.sourceDigest,
    verdict: "fail", findings: [actual], evidence: [] }).findings[0]!.affectedPaths[1],
    "facts/promise.md");
  for (const invalid of [
    { ...actual, affectedPaths: ["characters/nia.md", "facts/invented.md"] },
    { ...actual, affectedPaths: ["facts/promise.md"] },
    { ...actual, requiredCorrection: "retry" },
    { ...actual, requiredCorrection: "" },
    { ...actual, affectedPaths: ["characters/nia.md", "characters/nia.md"] },
  ]) {
    assert.throws(() => validateSemanticVerdict(packet, {
      sourceDigest: packet.sourceDigest, verdict: "fail", findings: [invalid], evidence: [],
    }), /source-linked/);
  }
});

test("stale source and unauthorized reviewer actions cannot become approvals", () => {
  const packet = makePacket();
  const valid = { sourceDigest: packet.sourceDigest, verdict: "pass", findings: [],
    evidence: [evidence("focus:character.nia", "characters/nia.md")] };
  assert.throws(() => validateSemanticVerdict(packet, { ...valid, sourceDigest: "changed" }),
    /stale/);
  assert.throws(() => validateSemanticVerdict(packet, { ...valid, findings: [
    finding("focus:character.nia", "events/unapproved.md")] }), /source-linked/);
  assert.throws(() => validateSemanticVerdict(packet, { ...valid,
    evidence: [evidence("focus:character.nia", "characters/nia.md"),
      { ...evidence("focus:character.nia", "characters/nia.md"), line: 900 }] }), /source-linked/);
  assert.throws(() => validateSemanticVerdict(packet, { ...valid,
    verdict: "approve-author-protected-canon" }), /malformed/);
});
