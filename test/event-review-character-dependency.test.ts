import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectDependencyPlan, saveDependencyPlan, type DependencyPlan } from "../src/dependency-state.js";
import type { JobStartResult } from "../src/job.js";
import { auditEventParticipantCorrection } from "../src/event-participant-correction.js";
import { authorizeReviewCharacterDependency } from "../src/dependency-amendments.js";
import { deriveReviewDependencyRequest, deriveReviewRepairAmendment,
  reviewNeedsDependency } from "../src/review-repair-amendment.js";
import type { TurnEvidence } from "../src/turn-plan-evidence.js";
import type { CheckpointAssurance, IndependentReviewResult } from "../src/checkpoint-assurance.js";
import type { RecoveryCheckpoint } from "../src/recovery-checkpoints.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const base = "a".repeat(40), sha = "b5803f40fb92c402d1a852f0baf102233b7ba1c1";
const foundations: TurnEvidence["assignments"][number] = {
  id: "foundations", specialist: "nt-worldbuilding + nt-character-development",
  outcome: "Create Character foundations", targets: [], dependsOn: ["architecture"],
  discovery: "canonical-story-read-only",
  authority: { recordTypes: ["character", "world-entity"], existingPaths: [], mayCreate: true },
};
const owner: TurnEvidence["assignments"][number] = {
  id: "event", specialist: "nt-event-design", outcome: "Realize discovery Event",
  targets: [], dependsOn: ["foundations"], discovery: "canonical-story-read-only",
  authority: { recordTypes: ["event"], existingPaths: [], mayCreate: true },
};
const turn: TurnEvidence = {
  version: 1, kind: "full-story", originalRequest: "Make a mystery",
  goal: "Make a mystery", source: { jobId: "event-job", verifiedSha: base },
  contract: { scope: { kind: "full-story", depth: "composition", targets: [], branches: [] },
    constraints: [], envelope: { presentation: "text", hardLimits: [], preferences: [] } },
  objective: { breadth: "whole-story", requestedTargets: [], deliveryDepth: "composition",
    obligations: ["Create central Characters and connected causal Events"] },
  assignments: [foundations, owner], reviewRequired: true, digest: "d".repeat(64),
};
const assurance: CheckpointAssurance = {
  version: 1, policyVersion: 1, jobId: "event-job", baseSha: base, parentSha: base,
  commitSha: sha, workItem: "event-discovery", validationProofDigest: "c".repeat(64),
  validatorVersion: "1.0.0", turnDigest: turn.digest,
  assignmentId: owner.id, assignmentDigest: hash(owner), assignmentDependencies: [],
  changedPaths: ["events/discovery.md"], changedRecordTypes: ["event"],
  addedLines: 30, removedLines: 0, diffDigest: "e".repeat(64),
  reviewSelection: { status: "required-pending", reasons: ["causal-discontinuity"] },
};
const review: IndependentReviewResult = {
  version: 1, reviewer: "independent-pi-assignment-review", status: "failed",
  source: { jobId: assurance.jobId, commitSha: sha, turnDigest: assurance.turnDigest,
    assignmentId: owner.id, assignmentDigest: hash(owner), diffDigest: assurance.diffDigest,
    validationProofDigest: assurance.validationProofDigest },
  findings: [{ path: "events/discovery.md", line: 40, kind: "missing-requirement",
    message: "Mara speaks as a central participant but has no Character record.",
    requiredCorrection: "Create the missing Character record for Mara and add the Event participant.",
    affectedPaths: ["events/discovery.md"] }],
  evidence: "Sealed independent source-linked failure",
};
const args = () => ({ assurance, review, original: owner, turn,
  originWorkItem: "event-discovery", planVersion: 1 });
const record = { path: "events/discovery.md", metadata: {
  id: "event.discovery", type: "event", status: "draft",
  participants: ["character.ines", "character.lev"], decisions: [],
} };
const existing = ["ines", "lev"].map(slug => ({
  path: "characters/" + slug + ".md",
  metadata: { id: "character." + slug, type: "character", status: "draft" },
}));
const proposal = { sourceSha: sha, reportDigest: "f".repeat(64),
  target: "character.mara", title: "Mara", specialist: "nt-character-development",
  outcome: review.findings[0]!.requiredCorrection,
  reason: "The signed Event source features Mara as a central named speaker." };

test("S14 #170: missing central Event speaker is a source-bound routine Character dependency", () => {
  assert.equal(reviewNeedsDependency(assurance, review, "event-discovery"), true);
  const request = deriveReviewDependencyRequest(args());
  assert.equal(request.classification, "new-full-story-record");
  assert.equal(request.action, "controller-amendment-required");
  assert.equal(request.recordTypeHint, "character");
  assert.equal(request.reviewDigest, hash(review));
  assert.equal(request.objectiveDigest, hash(turn.objective));
  assert.equal(request.sourceSha, sha);
  assert.equal(request.findings[0]?.path, "events/discovery.md");
  assert.equal("newPaths" in request, false, "negative reviewer is never write authority");
  const grant = authorizeReviewCharacterDependency({
    plan: turn, head: sha, request, proposal, reportDigest: proposal.reportDigest,
    records: [record, ...existing], version: 1,
  });
  assert.equal(grant.resumes, "event");
  assert.deepEqual(grant.assignment.authority, {
    recordTypes: ["character"], existingPaths: [],
    newPaths: ["characters/mara.md"], mayCreate: true,
  });
  assert.deepEqual(grant.assignment.targets, ["character.mara"]);
  assert.equal(grant.assignment.specialist, "nt-character-development");
});

test("S14 #170: stale, duplicated, forged, unauthorized or protected Event dependencies fail closed", () => {
  const request = deriveReviewDependencyRequest(args());
  const valid = { plan: turn, head: sha, request, proposal,
    reportDigest: proposal.reportDigest, records: [record, ...existing], version: 1 };
  assert.equal(authorizeReviewCharacterDependency({ ...valid, version: 9, versionBase: 9 }).assignment.id,
    "dependency:9:character.mara");
  assert.equal(authorizeReviewCharacterDependency({ ...valid, version: 16, versionBase: 9 }).afterVersion, 17);
  assert.throws(() => authorizeReviewCharacterDependency({ ...valid, version: 17, versionBase: 9 }), /dependency|authorization/i);
  const invalid = [
    { ...valid, head: base },
    { ...valid, proposal: { ...proposal, sourceSha: base } },
    { ...valid, proposal: { ...proposal, target: "character.ines" } },
    { ...valid, proposal: { ...proposal, target: "character.mara", path: "characters/mara.md" } },
    { ...valid, proposal: { ...proposal, target: "event.mara" } },
    { ...valid, proposal: { ...proposal, outcome: "Change protected Milestone" } },
    { ...valid, proposal: { ...proposal, title: "Mara\nDifferent" } },
    { ...valid, version: 0 },
    { ...valid, records: [{ ...record, metadata: { ...record.metadata,
      participants: ["character.ines", "character.ines"] } }, ...existing] },
    { ...valid, records: [{ ...record, metadata: { ...record.metadata,
      status: "superseded" } }, ...existing] },
    { ...valid, records: [record, ...existing, { path: "characters/other-name.md",
      metadata: { id: "character.mara", type: "character", status: "draft" } }] },
    { ...valid, priorAmendments: [{ ...owner, authority: {
      ...owner.authority, newPaths: ["characters/mara.md"] } }] },
    { ...valid, priorAmendments: [{ ...owner, targets: ["character.mara"] }] },
    { ...valid, plan: { ...turn, assignments: [owner] } },
    { ...valid, request: { ...request, scopeDigest: "0".repeat(64) } },
    { ...valid, request: { ...request, ownersDigest: "0".repeat(64) } },
    { ...valid, request: { ...request, originalAssignmentId: "foundations" } },
  ];
  for (const [index, item] of invalid.entries())
    assert.throws(() => authorizeReviewCharacterDependency(item),
      /dependency|authorization/i, "invalid event grant #" + index);
  const notWholeStory = { ...turn, kind: "revision" as const,
    objective: { ...turn.objective!, breadth: "focused" as const } };
  assert.equal(deriveReviewDependencyRequest({ ...args(), turn: notWholeStory }).action,
    "author-approval-required");
  const protectedReview = { ...review, findings: [{
    ...review.findings[0]!, requiredCorrection: "Retcon a protected decision: create a Character record",
  }] };
  assert.equal(deriveReviewDependencyRequest({ ...args(), review: protectedReview }).action,
    "author-approval-required");
  assert.throws(() => deriveReviewDependencyRequest({
    ...args(), review: { ...review, source: { ...review.source, commitSha: base } },
  }), /sealed|source/i);
  assert.throws(() => deriveReviewDependencyRequest({
    ...args(), review: { ...review, findings: [
      ...review.findings, { ...review.findings[0]!, path: "arcs/other.md" },
    ] },
  }), /source|evidence/i);
});

test("S14 #170: an existing cast member needs only Event-owner correction, not a new Character", () => {
  const existingCastReview: IndependentReviewResult = {
    ...review, findings: [{ ...review.findings[0]!,
      message: "The existing Character Ines is omitted from this Event's participants.",
      requiredCorrection: "Add the existing Character record for Ines to Event participants.",
    }],
  };
  assert.equal(reviewNeedsDependency(assurance, existingCastReview, "event-discovery"), false);
  const correction = deriveReviewRepairAmendment({
    assurance, review: existingCastReview, original: owner,
    planVersion: 1, originWorkItem: "event-discovery",
  });
  assert.deepEqual(correction.assignment.authority.existingPaths, ["events/discovery.md"]);
  assert.equal(correction.assignment.authority.mayCreate, false);
  assert.equal(correction.eventCharacter, undefined);
});

test("S14 #170: original Event owner may correct only one approved Event after supporting review", () => {
  const eventCharacter = { id: "character.mara", path: "events/discovery.md",
    failedSourceSha: sha, supportingCommitSha: "c".repeat(40) };
  const amendment = deriveReviewRepairAmendment({
    assurance, review, original: owner, planVersion: 1,
    originWorkItem: "event-discovery", eventCharacter,
  });
  assert.deepEqual(amendment.assignment.authority, {
    recordTypes: ["event"], existingPaths: ["events/discovery.md"], mayCreate: false,
  });
  assert.deepEqual(amendment.eventCharacter, eventCharacter);
  for (const altered of [
    { ...eventCharacter, path: "events/other.md" },
    { ...eventCharacter, id: "character.ines/../other" },
    { ...eventCharacter, supportingCommitSha: "stale" },
  ]) assert.throws(() => deriveReviewRepairAmendment({
    assurance, review, original: owner, planVersion: 1,
    originWorkItem: "event-discovery", eventCharacter: altered,
  }), /Event Character correction/i);
});

test("S14 #170: Event participants append is exact; all other metadata and old participants are immutable", () => {
  const before = "---\nschema: '0.1'\ntype: event\nid: event.discovery\ntitle: Discovery\n" +
    "status: draft\ndecisions: []\nparticipants: [character.ines, character.lev]\n" +
    "arcs: [arc.mystery]\nsteps: []\n---\nMara speaks to Ines.\n";
  const after = before.replace("character.lev]", "character.lev, character.mara]")
    .replace("Mara speaks to Ines.", "Mara confronts Ines about the missing passenger.");
  assert.doesNotThrow(() => auditEventParticipantCorrection(before, after, "character.mara"));
  for (const changed of [
    before, after.replace("decisions: []", "decisions: [protected]"),
    after.replace("arcs: [arc.mystery]", "arcs: [arc.new]"),
    after.replace("status: draft", "status: complete"),
    after.replace("character.ines", "character.mara"),
    after.replace("character.lev, character.mara", "character.mara, character.lev"),
    after.replace("character.lev, character.mara", "character.lev, character.mara, character.mara"),
    after.replace("Mara confronts Ines about the missing passenger.", ""),
  ]) assert.throws(() => auditEventParticipantCorrection(before, changed, "character.mara"),
    /Event correction/i);
  const blockBefore = before.replace("participants: [character.ines, character.lev]",
    "participants:\n  - character.ines\n  - character.lev");
  const blockAfter = blockBefore.replace("  - character.lev",
    "  - character.lev\n  - character.mara");
  assert.doesNotThrow(() => auditEventParticipantCorrection(blockBefore, blockAfter, "character.mara"));
});

test("S14 #170: disconnected ledger reads never transfer authorization across jobs or Threads", async t => {
  const root = mkdtempSync(join(tmpdir(), "nt170-isolation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const { digest: _old, ...body } = {
    ...turn, assignments: [{ ...foundations, dependsOn: [] }, owner],
  };
  const pinned: TurnEvidence = { ...body, digest: hash(body) };
  writeFileSync(join(stateDir, "turn-plan.json"), JSON.stringify(pinned));
  const job = { stateDir, jobId: "event-job", threadId: "root:event-job",
    baseSha: base } as JobStartResult;
  const plan: DependencyPlan = {
    schema: "noveltea-dependency-plan/v1", jobId: job.jobId,
    threadId: job.threadId, turnDigest: pinned.digest, version: 1,
    entries: [], reviewRequests: [], digest: "",
  };
  await saveDependencyPlan(job, plan);
  const initial = await inspectDependencyPlan(job);
  assert.equal(initial?.version, 1);
  assert.deepEqual(await inspectDependencyPlan({ ...job }), initial,
    "a disconnected process reads the same authoritative ledger without rewriting it");
  await assert.rejects(inspectDependencyPlan({ ...job, threadId: "root:other" }),
    /identity|source/i, "a foreign Thread cannot inherit the controller-owned plan");
  await assert.rejects(inspectDependencyPlan({ ...job, jobId: "other-job" }),
    /identity|source/i, "another Job cannot inherit the controller-owned plan");
  const stored = readFileSync(join(stateDir, "dependency-plan.json"), "utf8");
  const altered = JSON.parse(stored) as DependencyPlan;
  altered.version = 2;
  assert.notEqual(altered.digest, hash((({ digest: _discard, ...rest }) => rest)(altered)));
  writeFileSync(join(stateDir, "dependency-plan.json"), JSON.stringify(altered));
  await assert.rejects(inspectDependencyPlan(job), /identity|version|source/i,
    "a stale or corrupted amendment version cannot be resurrected on restart");
  writeFileSync(join(stateDir, "dependency-plan.json"), stored);
  assert.deepEqual(await inspectDependencyPlan(job), initial);
});

test("S14 #170: preserved Event-review negative remains immutable when external fixture is supplied", {
  skip: !process.env.NT_TEST_S14_EVENT_STATE && "set NT_TEST_S14_EVENT_STATE to the private saved #170 job state",
}, () => {
  const state = process.env.NT_TEST_S14_EVENT_STATE!;
  const reviewed = "b5803f40fb92c402d1a852f0baf102233b7ba1c1";
  const checkpoint = JSON.parse(readFileSync(join(state, "recovery-checkpoints", reviewed + ".json"),
    "utf8")) as RecoveryCheckpoint;
  const negative = JSON.parse(readFileSync(join(state, "independent-reviews", reviewed + ".json"),
    "utf8")) as IndependentReviewResult;
  const original = JSON.parse(readFileSync(join(state, "turn-plan.json"), "utf8")) as TurnEvidence;
  const assignment = original.assignments.find(a => a.id === checkpoint.assurance?.assignmentId)!;
  const request = deriveReviewDependencyRequest({
    assurance: checkpoint.assurance!, review: negative, original: assignment, turn: original,
    originWorkItem: checkpoint.workItem, planVersion: checkpoint.planVersion!,
  });
  assert.equal(request.classification, "new-full-story-record");
  assert.equal(request.findings[0]?.path, "events/discovery.md");
  assert.equal(request.action, "controller-amendment-required");
});
