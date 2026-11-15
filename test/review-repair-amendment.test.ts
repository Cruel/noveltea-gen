import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { deriveReviewRepairAmendment, reviewRepairTargets, reviewNeedsDependency } from "../src/review-repair-amendment.js";
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

test("new missing Character foundation routes to controller dependency, not existing-file retry", () => {
  const changed = { ...assurance, workItem: "character-foundations",
    changedPaths: ["arcs/night-train-mystery.md", "characters/rowan-bell.md",
      "characters/maeve-sloane.md", "relationships/maeve-rowan.md"] };
  const finding = { ...result.findings[0]!, path: "characters/rowan-bell.md",
    kind: "missing-requirement" as const,
    message: "The missing passenger has no Character foundation and the Arc requires that central role.",
    requiredCorrection: "Create a Character foundation for the missing passenger, then add " +
      "that Character's ID to the existing Arc's characters array while preserving other fields.",
    affectedPaths: ["characters/rowan-bell.md", "arcs/night-train-mystery.md"] };
  const review = { ...result, findings: [finding] };
  assert.equal(reviewNeedsDependency(changed, review, "character-foundations"), true,
    "Exact preserved Luna wording must request a new authorized Character");
  assert.equal(reviewNeedsDependency(changed, { ...review, findings: [{
    ...finding, requiredCorrection: "Create a new Character record for the missing passenger.",
  }] }, "character-foundations"), true);
  for (const correction of [
    "Revise the Character foundation already authored for the passenger.",
    "Update the existing Character record's dialogue and Fact knowledge.",
    "Change Rowan's existing characterization so the witness has a credible motivation.",
  ]) assert.equal(reviewNeedsDependency(changed, { ...review, findings: [{
    ...finding, requiredCorrection: correction,
  }] }, "character-foundations"), false,
  "Existing Character corrections must stay in their original bounded lease");
  assert.deepEqual(reviewRepairTargets(changed.changedPaths, "character-foundations"), [
    "characters/maeve-sloane.md", "characters/rowan-bell.md",
    "relationships/maeve-rowan.md",
  ], "Arc changes still cannot be authorized by a rejected review");
});

test("Character checkpoint's verified Arc links remain read-only while owned Characters can be repaired", () => {
  const character: TurnAssignmentEvidence = {
    id: "foundations", specialist: "nt-character-development", outcome: "Introduce the witnesses",
    targets: ["character.witness"], dependsOn: [], discovery: "canonical-story-read-only",
    authority: { recordTypes: ["character", "relationship"], existingPaths: [], mayCreate: true },
  };
  const changedPaths = ["arcs/train-disappearance.md", "characters/guarded-passenger.md",
    "characters/player-witness.md", "relationships/player-and-guarded-passenger.md"];
  assert.deepEqual(reviewRepairTargets(changedPaths, "character-foundations"), [
    "characters/guarded-passenger.md", "characters/player-witness.md",
    "relationships/player-and-guarded-passenger.md",
  ]);
  const check = { ...assurance, workItem: "character-foundations",
    assignmentId: character.id, assignmentDigest: hash(character), changedPaths };
  const review: IndependentReviewResult = { ...result,
    source: { ...result.source, assignmentId: character.id,
      assignmentDigest: hash(character) },
    findings: [{ path: "characters/guarded-passenger.md", kind: "continuity", line: 12,
      message: "The witness forgets what the player knows about the train.",
      requiredCorrection: "Revise this Character's established knowledge without touching the Arc.",
      affectedPaths: ["characters/guarded-passenger.md", "arcs/train-disappearance.md"] }] };
  const args = { assurance: check, review, original: character,
    planVersion: 1, originWorkItem: "character-foundations" };
  const amendment = deriveReviewRepairAmendment(args);
  assert.deepEqual(amendment.assignment.authority.existingPaths, [
    "characters/guarded-passenger.md", "characters/player-witness.md",
    "relationships/player-and-guarded-passenger.md",
  ]);
  assert.deepEqual(amendment.readOnlyDependencies, ["arcs/train-disappearance.md"]);
  assert.equal(amendment.assignment.specialist, character.specialist);
  assert.equal(amendment.assignment.authority.mayCreate, false);
  assert.deepEqual(deriveReviewRepairAmendment(args), amendment,
    "Restart must derive identical bounded authority");
  assert.throws(() => deriveReviewRepairAmendment({ ...args,
    review: { ...review, findings: [{ ...review.findings[0]!,
      path: "arcs/train-disappearance.md" }] } }),
    /unverified source.*arcs\/train-disappearance\.md.*controller-approved/);
  assert.throws(() => deriveReviewRepairAmendment({ ...args,
    assurance: { ...check, changedPaths: ["arcs/train-disappearance.md"] } }),
    /new writer|path|protected/);
});

test("Event correction edits its reviewed Event, never the validated Milestone metadata", () => {
  const event: TurnAssignmentEvidence = {
    id: "event", specialist: "nt-event-design", outcome: "Present fair-play observations",
    targets: ["milestone.evidence"], dependsOn: [], discovery: "canonical-story-read-only",
    authority: { recordTypes: ["event"], existingPaths: [], mayCreate: true },
  };
  const changed = { ...assurance, workItem: "event-evidence", assignmentId: event.id,
    assignmentDigest: hash(event), changedPaths: ["events/compare.md", "milestones/evidence.md"],
    changedRecordTypes: ["event", "milestone"] };
  const review: IndependentReviewResult = { ...result,
    source: { ...result.source, assignmentId: event.id,
      assignmentDigest: hash(event) },
    findings: [{ path: "events/compare.md", kind: "missing-requirement", line: 22,
      message: "Comparison skips the evidence observations needed for fair play.",
      requiredCorrection: "Show both observations in a playable scene before the comparison.",
      affectedPaths: ["events/compare.md", "milestones/evidence.md"] }] };
  const args = { assurance: changed, review, original: event,
    planVersion: 1, originWorkItem: "event-evidence" };
  const amendment = deriveReviewRepairAmendment(args);
  assert.deepEqual(amendment.assignment.authority.existingPaths, ["events/compare.md"]);
  assert.deepEqual(amendment.readOnlyDependencies, ["milestones/evidence.md"]);
  assert.equal(amendment.assignment.authority.mayCreate, false);
  assert.throws(() => deriveReviewRepairAmendment({ ...args,
    review: { ...review, findings: [{ ...review.findings[0]!,
      path: "milestones/evidence.md" }] } }),
    /unverified source.*milestones\/evidence\.md.*field-limited/);
  const linkedArc = { ...args,
    assurance: { ...changed, changedPaths: [...changed.changedPaths, "arcs/connected.md"] },
    review: { ...review, findings: [{ ...review.findings[0]!,
      affectedPaths: [...review.findings[0]!.affectedPaths, "arcs/connected.md"] }] } };
  const linkedRepair = deriveReviewRepairAmendment(linkedArc);
  assert.deepEqual(linkedRepair.assignment.authority.existingPaths, ["events/compare.md"]);
  assert.deepEqual(linkedRepair.readOnlyDependencies,
    ["arcs/connected.md", "milestones/evidence.md"]);
  assert.throws(() => deriveReviewRepairAmendment({ ...linkedArc,
    review: { ...linkedArc.review, findings: [{ ...linkedArc.review.findings[0]!,
      path: "arcs/connected.md" }] } }), /unverified source/);
  assert.deepEqual(reviewRepairTargets(["arcs/linked.md", "milestones/linked.md"],
    "event-evidence"), [], "A wholly protected checkpoint offers no writable repair target");
  assert.deepEqual(reviewRepairTargets(["events/compare.md", "arcs/../unsafe.md"],
    "event-evidence"), [], "Invalid canonical paths still fail closed");
});

test("sealed Event grant corrects only the selected native-typed Milestone fulfillment slots", () => {
  const event: TurnAssignmentEvidence = {
    id: "event", specialist: "nt-event-design", outcome: "Make the locked door materially matter",
    targets: ["milestone.notice-absence"], dependsOn: [], discovery: "canonical-story-read-only",
    authority: { recordTypes: ["event"], existingPaths: ["events/notice-absence.md"], mayCreate: false },
  };
  const grant = { id: "milestone.notice-absence", path: "milestones/selected-record.md" };
  const changed = { ...assurance, workItem: "event-notice-absence", assignmentId: event.id,
    assignmentDigest: hash(event), changedPaths: ["events/notice-absence.md",
      grant.path, "milestones/other.md"] };
  const review: IndependentReviewResult = { ...result,
    source: { ...result.source, assignmentId: event.id, assignmentDigest: hash(event) },
    findings: [{ path: grant.path, kind: "missing-requirement", line: 14,
      message: "The locked compartment does not matter to the selected Milestone.",
      requiredCorrection: "Keep Milestone partial until the lock is materially supported.",
      affectedPaths: [grant.path, "events/notice-absence.md"] }] };
  const args = { assurance: changed, review, original: event,
    planVersion: 2, originWorkItem: "event-notice-absence", eventMilestone: grant };
  assert.equal(reviewNeedsDependency(changed, review, args.originWorkItem), true);
  assert.equal(reviewNeedsDependency(changed, review, args.originWorkItem, grant), false);
  const amendment = deriveReviewRepairAmendment(args);
  assert.deepEqual(amendment.eventMilestone, grant);
  assert.deepEqual(amendment.assignment.authority.existingPaths,
    ["events/notice-absence.md", grant.path]);
  assert.deepEqual(amendment.assignment.authority.recordTypes, ["event", "milestone"]);
  assert.equal(amendment.assignment.authority.mayCreate, false);
  assert.deepEqual(amendment.readOnlyDependencies, []);
  assert.deepEqual(deriveReviewRepairAmendment(args), amendment, "replay is deterministic");
  assert.deepEqual(reviewRepairTargets(changed.changedPaths, args.originWorkItem, grant),
    amendment.assignment.authority.existingPaths);

  for (const eventMilestone of [
    { ...grant, id: "milestone.other" },
    { ...grant, path: "milestones/missing.md" },
    { ...grant, path: "milestones/../unsafe.md" },
  ])
    assert.throws(() => deriveReviewRepairAmendment({ ...args, eventMilestone }), /grant/);
  assert.throws(() => deriveReviewRepairAmendment({ ...args, original: {
    ...event, specialist: "nt-worldbuilding" } }), /grant/);
  assert.throws(() => deriveReviewRepairAmendment({ ...args, assurance: {
    ...changed, changedPaths: ["events/notice-absence.md"] } }), /grant/);
  assert.throws(() => deriveReviewRepairAmendment({ ...args,
    review: { ...review, source: { ...review.source, commitSha: "f".repeat(40) } } }),
    /protected|grant|writer/);
  assert.throws(() => deriveReviewRepairAmendment({ ...args,
    review: { ...review, findings: [{ ...review.findings[0]!,
      path: "milestones/other.md" }] } }), /unverified source/);
  assert.throws(() => deriveReviewRepairAmendment({ ...args,
    planVersion: 0 }), /protected|writer/);
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
