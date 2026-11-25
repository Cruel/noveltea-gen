import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { authorizeReviewOtherOwnerDependency } from "../src/dependency-amendments.js";
import { deriveReviewDependencyRequest } from "../src/review-repair-amendment.js";
import type { CheckpointAssurance, IndependentReviewResult } from "../src/checkpoint-assurance.js";
import type { TurnEvidence } from "../src/turn-plan-evidence.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const base = "a".repeat(40), source = "b".repeat(40);
const event = {
  id: "event", specialist: "nt-event-design", outcome: "Ground the witness's knowledge",
  targets: ["event.arrival"], dependsOn: [], discovery: "canonical-story-read-only" as const,
  authority: { recordTypes: ["event"], existingPaths: ["events/arrival.md"], mayCreate: false },
};
const character = {
  id: "foundations", specialist: "nt-worldbuilding + nt-character-development",
  outcome: "Establish the witness's source-grounded knowledge",
  targets: ["character.witness"], dependsOn: [], discovery: "canonical-story-read-only" as const,
  authority: { recordTypes: ["character"], existingPaths: ["characters/witness.md"], mayCreate: false },
};
const turn: TurnEvidence = {
  version: 1, kind: "full-story", originalRequest: "Build a mystery with a witness",
  goal: "Build a mystery with a witness",
  source: { jobId: "job", verifiedSha: base }, digest: "c".repeat(64),
  contract: { scope: { kind: "full-story", depth: "composition", targets: [], branches: [] },
    constraints: [], envelope: { presentation: "text", hardLimits: [], preferences: [] } },
  objective: { breadth: "whole-story", requestedTargets: [], deliveryDepth: "composition",
    obligations: ["Show an established witness before the Event revelation"] },
  assignments: [event, character], reviewRequired: true,
};
const assurance: CheckpointAssurance = {
  version: 1, policyVersion: 1, jobId: "job", baseSha: base, parentSha: base,
  commitSha: source, workItem: "event-arrival", validatorVersion: "1.0.0",
  validationProofDigest: "d".repeat(64), diffDigest: "e".repeat(64),
  turnDigest: turn.digest, assignmentId: event.id, assignmentDigest: hash(event),
  assignmentDependencies: [], changedPaths: ["events/arrival.md"],
  changedRecordTypes: ["event"], addedLines: 5, removedLines: 0,
  reviewSelection: { status: "required-pending", reasons: ["cross-specialist"] },
};
const review: IndependentReviewResult = {
  version: 1, reviewer: "independent-pi-assignment-review", status: "failed",
  source: { jobId: assurance.jobId, commitSha: assurance.commitSha,
    turnDigest: assurance.turnDigest, assignmentId: assurance.assignmentId,
    assignmentDigest: assurance.assignmentDigest, diffDigest: assurance.diffDigest,
    validationProofDigest: assurance.validationProofDigest },
  findings: [{ path: "events/arrival.md", line: 12, kind: "missing-requirement",
    message: "The witness lacks credible prior knowledge.",
    requiredCorrection: "Ground the witness's knowledge before the Event.",
    affectedPaths: ["events/arrival.md", "characters/witness.md"] }],
  evidence: "independent review of the Event",
};
const args = () => ({
  assurance, review, original: event, turn, planVersion: 1, originWorkItem: "event-arrival",
  otherOwnerPath: "characters/witness.md",
});
const records = [
  { path: "events/arrival.md", metadata: { type: "event", id: "event.arrival",
    status: "draft", participants: ["character.witness"], decisions: [] } },
  { path: "characters/witness.md", metadata: { type: "character",
    id: "character.witness", status: "draft", decisions: [] } },
];
const proposal = {
  sourceSha: source, reportDigest: "f".repeat(64), target: "character.witness",
  specialist: "nt-character-development",
  outcome: "Ground the witness's knowledge before the Event.",
  reason: "The Event depends on the witness's established and limited knowledge.",
};
const authorize = (change: Record<string, unknown> = {}) =>
  authorizeReviewOtherOwnerDependency({
    plan: turn, head: source, request: deriveReviewDependencyRequest(args()),
    proposal, reportDigest: proposal.reportDigest, records, version: 1, ...change,
  });

test("#221: sealed other-owner report yields a single existing-record controller grant", () => {
  const request = deriveReviewDependencyRequest(args());
  assert.equal(request.classification, "other-owner");
  assert.equal(request.action, "controller-amendment-required");
  assert.equal(request.otherOwnerPath, "characters/witness.md");
  assert.equal(request.digest, hash((({ digest: _, ...body }) => body)(request)));
  const approved = authorize();
  assert.equal(approved.resumes, "event");
  assert.deepEqual(approved.assignment.authority, {
    recordTypes: ["character"], existingPaths: ["characters/witness.md"], mayCreate: false,
  });
  assert.equal(approved.assignment.specialist, "nt-character-development");
  assert.deepEqual(approved.assignment.targets, ["character.witness"]);
  assert.deepEqual(approved.assignment.authority.newPaths, undefined);
});

test("#221: a later checkpoint retains original Turn authority across legitimate parents", () => {
  const downstream = {
    ...assurance, baseSha: "1".repeat(40), parentSha: "1".repeat(40),
  };
  const laterReview = { ...review, source: { ...review.source,
    commitSha: downstream.commitSha, diffDigest: downstream.diffDigest } };
  const request = deriveReviewDependencyRequest({ ...args(),
    assurance: downstream, review: laterReview });
  assert.equal(request.action, "controller-amendment-required");
  assert.equal(request.sourceSha, source);
  // Production separately requires Git ancestry from the original Turn
  // through this later checkpoint before saving an amendment request.
});

test("#221: a protected other-owner path never acquires a new controller writer", () => {
  const protectedOwner = {
    ...character, authority: { ...character.authority,
      existingPaths: ["creative-direction/story.md"] },
  };
  const protectedTurn = { ...turn, assignments: [event, protectedOwner] };
  const protectedReview = { ...review, findings: [{
    ...review.findings[0]!, affectedPaths: [
      "events/arrival.md", "creative-direction/story.md",
    ],
  }] };
  const request = deriveReviewDependencyRequest({ ...args(),
    turn: protectedTurn, review: protectedReview,
    otherOwnerPath: "creative-direction/story.md" });
  assert.equal(request.action, "author-approval-required");
  assert.equal(request.classification, "scope-or-protected");
});

test("#221: source, ownership, scope and protected decisions reject speculative other-owner dispatch", () => {
  assert.throws(() => deriveReviewDependencyRequest({ ...args(), otherOwnerPath: "facts/other.md" }),
    /unambiguous|source/);
  assert.throws(() => deriveReviewDependencyRequest({ ...args(), turn: { ...turn,
    assignments: [event, { ...character, authority: { ...character.authority, existingPaths: [] } }] } }),
    /unambiguous|source/);
  assert.throws(() => authorize({ head: "1".repeat(40) }), /in-scope/);
  assert.throws(() => authorize({ proposal: { ...proposal, target: "character.other" } }), /in-scope/);
  assert.throws(() => authorize({ proposal: { ...proposal, outcome: "Rewrite all characters" } }), /in-scope/);
  assert.throws(() => authorize({ records: [records[0], {
    ...records[1], metadata: { ...records[1]!.metadata, decisions: ["retcon"] },
  }] }), /in-scope/);
  assert.throws(() => authorize({ records: [{ ...records[0], metadata: {
    ...records[0]!.metadata, participants: [] } }, records[1]] }), /in-scope/);
  assert.throws(() => authorize({ priorAmendments: [{
    ...character, authority: { ...character.authority, existingPaths: ["characters/witness.md"] },
  }] }), /in-scope/);
});

test("#274: a realized whole-Story record needs checkpoint-backed owner authority", () => {
  const unenumerated = { ...turn, assignments: [event, { ...character,
    authority: { ...character.authority, existingPaths: [], mayCreate: true } }] };
  const otherOwnerCheckpoint = { assignmentId: character.id, workItem: "character-foundations",
    commitSha: "2".repeat(40), assuranceDigest: "3".repeat(64) };
  assert.throws(() => deriveReviewDependencyRequest({ ...args(), turn: unenumerated }),
    /unambiguous authenticated other-owner/);
  const request = deriveReviewDependencyRequest({ ...args(), turn: unenumerated, otherOwnerCheckpoint });
  assert.equal(request.classification, "other-owner");
  assert.deepEqual(request.otherOwnerCheckpoint, otherOwnerCheckpoint);
  const grant = authorizeReviewOtherOwnerDependency({ plan: unenumerated, head: source,
    request, proposal, reportDigest: proposal.reportDigest, records, version: 1 });
  assert.deepEqual(grant.assignment.authority, { recordTypes: ["character"],
    existingPaths: ["characters/witness.md"], mayCreate: false });
  for (const foreign of [
    { ...otherOwnerCheckpoint, assignmentId: event.id },
    { ...otherOwnerCheckpoint, commitSha: source },
    { ...otherOwnerCheckpoint, assuranceDigest: "invalid" },
  ]) assert.throws(() => deriveReviewDependencyRequest({ ...args(), turn: unenumerated,
    otherOwnerCheckpoint: foreign }), /checkpoint|other-owner/);
  assert.throws(() => authorizeReviewOtherOwnerDependency({ plan: unenumerated, head: source,
    request, proposal, reportDigest: proposal.reportDigest, version: 1,
    records: [records[0]!, { ...records[1]!, metadata: { ...records[1]!.metadata,
      decisions: ["protected"] } }] }), /in-scope/);
});
