import assert from "node:assert/strict";
import { test } from "node:test";
import { validateSemanticVerdict, type SemanticReviewPacket } from "../src/semantic-assignment-review.js";

const makePacket = (group = false): SemanticReviewPacket => {
  const item = (id: string, path: string) => ({
    assignment: { id, specialist: "nt-character-development", outcome: "Give Nia a reason to wait",
      targets: ["character.nia"], dependsOn: [], discovery: "canonical-story-read-only" as const,
      authority: { recordTypes: ["character"], existingPaths: [path], mayCreate: false } },
    assurance: { version: 1 as const, policyVersion: 1 as const, jobId: "j",
      baseSha: "a".repeat(40), parentSha: "a".repeat(40), commitSha: "b".repeat(40),
      workItem: id, validationProofDigest: "c".repeat(64), validatorVersion: "1",
      turnDigest: "d".repeat(64), assignmentId: id, assignmentDigest: "e".repeat(64),
      assignmentDependencies: [], changedPaths: [path], changedRecordTypes: ["character"],
      addedLines: 1, removedLines: 0, diffDigest: "f".repeat(64),
      reviewSelection: { status: "required-pending" as const, reasons: ["large-diff"] } },
    diff: "diff --git a/" + path + " b/" + path,
    canonicalContext: [{ path, content: "# Nia\nNia waits." }],
  });
  return { policy: "assignment-fidelity/v1", sourceDigest: "source",
    items: [item("focus:character.nia", "characters/nia.md"),
      ...(group ? [item("focus:character.eli", "characters/eli.md")] : [])] };
};
const evidence = (id: string, path: string) =>
  ({ assignmentId: id, path, line: 2, explanation: "Source text supports the assigned change." });
const finding = (id: string, path: string, kind: "missing-requirement" |
  "unrequested-change" = "missing-requirement") =>
  ({ assignmentId: id, path, line: 2, kind, message: "Required motive is missing." });

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
    verdict: "fail", findings: [finding("focus:character.eli", "characters/eli.md")],
    evidence: [evidence("focus:character.nia", "characters/nia.md")] }).findings[0]!.assignmentId,
    "focus:character.eli");
  assert.throws(() => validateSemanticVerdict(packet, { sourceDigest: packet.sourceDigest,
    verdict: "pass", findings: [],
    evidence: [evidence("focus:character.nia", "characters/nia.md")] }), /source-linked/);
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
