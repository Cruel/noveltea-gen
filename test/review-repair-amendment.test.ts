import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { deriveReviewRepairAmendment } from "../src/review-repair-amendment.js";
import type { CheckpointAssurance, IndependentReviewResult } from "../src/checkpoint-assurance.js";
import type { TurnAssignmentEvidence } from "../src/turn-plan-evidence.js";

const hash = (data: unknown) => createHash("sha256").update(JSON.stringify(data)).digest("hex");
const original: TurnAssignmentEvidence = {
  id: "focus:character.nia", specialist: "nt-character-development",
  outcome: "Nia must retain her established motive and know the disclosed Fact",
  targets: ["character.nia"], dependsOn: [], discovery: "canonical-story-read-only",
  authority: { recordTypes: ["character"], existingPaths: ["characters/nia.md"], mayCreate: false },
};
const assurance: CheckpointAssurance = {
  version: 1, policyVersion: 1, jobId: "job", baseSha: "a".repeat(40),
  parentSha: "a".repeat(40), commitSha: "b".repeat(40), workItem: "focus:character.nia",
  validationProofDigest: "c".repeat(64), validatorVersion: "1.0.0",
  turnDigest: "d".repeat(64), assignmentId: original.id,
  assignmentDigest: hash(original), assignmentDependencies: [],
  changedPaths: ["characters/nia.md"], changedRecordTypes: ["character"],
  addedLines: 12, removedLines: 3, diffDigest: "e".repeat(64),
  reviewSelection: { status: "required-pending", reasons: ["previous-review-failure"] },
};
const result: IndependentReviewResult = {
  version: 1, status: "failed", reviewer: "independent-pi-assignment-review",
  source: { jobId: assurance.jobId, commitSha: assurance.commitSha,
    turnDigest: assurance.turnDigest, assignmentId: assurance.assignmentId,
    assignmentDigest: assurance.assignmentDigest, diffDigest: assurance.diffDigest,
    validationProofDigest: assurance.validationProofDigest },
  findings: [{ path: "characters/nia.md", kind: "continuity", line: 12,
    message: "The Character acts as if she never learned the Fact in the Event.",
    requiredCorrection: "Change her dialogue to acknowledge the earlier revelation.",
    affectedPaths: ["characters/nia.md", "facts/revealed.md"] }],
  evidence: "Independent review of exact pinned diff and canonical context",
};
const input = () => ({ assurance, review: result, original, planVersion: 1,
  originWorkItem: "focus:character.nia" });

test("cross-domain continuity review derives a versioned, single-owner repair overlay", () => {
  const amendment = deriveReviewRepairAmendment(input());
  assert.equal(amendment.kind, "review-correction");
  assert.equal(amendment.sourceSha, assurance.commitSha);
  assert.equal(amendment.basePlanVersion, 1);
  assert.deepEqual(amendment.readOnlyDependencies, ["facts/revealed.md"]);
  assert.deepEqual(amendment.assignment.authority.existingPaths, ["characters/nia.md"]);
  assert.deepEqual(amendment.assignment.targets, original.targets);
  assert.equal(amendment.assignment.specialist, original.specialist);
  assert.equal(amendment.assignment.authority.mayCreate, false);
  assert.deepEqual(amendment.assignment.dependsOn, [original.id]);
  assert.equal(amendment.obligations[0]!.requiredCorrection,
    "Change her dialogue to acknowledge the earlier revelation.");
  assert.equal(amendment.digest, hash((({ digest: _digest, ...body }) => body)(amendment)));
  assert.deepEqual(deriveReviewRepairAmendment(input()), amendment,
    "restart derives the exact same amendment from sealed evidence");
});

test("reviewer cannot grant an unrelated path, changed owner, or stale source", () => {
  assert.throws(() => deriveReviewRepairAmendment({ ...input(),
    review: { ...result, source: { ...result.source, commitSha: "f".repeat(40) } } }), /new writer|path|protected/);
  assert.throws(() => deriveReviewRepairAmendment({ ...input(),
    original: { ...original, specialist: "nt-worldbuilding" } }), /new writer|path|protected/);
  assert.throws(() => deriveReviewRepairAmendment({ ...input(),
    assurance: { ...assurance, changedPaths: ["characters/nia.md", "facts/revealed.md"] } }),
  /new writer|path|protected/);
  assert.throws(() => deriveReviewRepairAmendment({ ...input(),
    review: { ...result, findings: [{ ...result.findings[0]!, path: "facts/revealed.md" }] } }),
  /unverified source/);
  assert.throws(() => deriveReviewRepairAmendment({ ...input(),
    planVersion: 0 }), /new writer|path|protected/);
});

test("Foundation-only exception retains exact Creative Direction path without author-approval grants", () => {
  const foundation: TurnAssignmentEvidence = { id: "foundation", specialist: "nt-story-discovery",
    outcome: "Establish a source-linked Creative Direction", targets: [], dependsOn: [],
    discovery: "canonical-story-read-only", authority: {
      recordTypes: ["creative-direction"], existingPaths: [], mayCreate: true } };
  const check = { ...assurance, workItem: "foundation", assignmentId: "foundation",
    assignmentDigest: hash(foundation), changedPaths: ["creative-direction/foundation.md"],
    changedRecordTypes: ["creative-direction"] };
  const review: IndependentReviewResult = { ...result,
    source: { ...result.source, assignmentId: "foundation",
      assignmentDigest: hash(foundation) },
    findings: [{ path: "creative-direction/foundation.md",
      message: "The promised social consequence has no causal link in the premise.",
      requiredCorrection: "Connect the established choice to the social consequences.",
      affectedPaths: ["creative-direction/foundation.md"] }] };
  const valid = deriveReviewRepairAmendment({ assurance: check, review,
    original: foundation, planVersion: 1, originWorkItem: "foundation" });
  assert.deepEqual(valid.assignment.authority.existingPaths, ["creative-direction/foundation.md"]);
  assert.equal(valid.assignment.authority.mayCreate, false);
  assert.throws(() => deriveReviewRepairAmendment({ assurance: check, review,
    original: foundation, planVersion: 1, originWorkItem: "focus:foundation" }), /protected/);
});
