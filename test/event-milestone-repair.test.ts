import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readEventMilestoneRepairGrant } from "../src/event-milestone-repair.js";
import { deriveReviewRepairAmendment, reviewNeedsDependency } from "../src/review-repair-amendment.js";
import { readIndependentReview } from "../src/checkpoint-assurance.js";
import type { TurnEvidence } from "../src/turn-plan-evidence.js";
import { eventConsequenceProofDigest, type EventConsequenceProof } from "../src/event-consequence-proof.js";
import { changedRepairPaths, type RepairReceipt } from "../src/rejected-review-repair.js";
import { assertMilestoneFulfillmentOnly } from "../src/milestone-field-scope.js";
import type { RecoveryCheckpoint } from "../src/recovery-checkpoints.js";
import type { TurnAssignmentEvidence } from "../src/turn-plan-evidence.js";
import type { JobStartResult } from "../src/job.js";
import { removeTestTree } from "./helpers.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const selectedPath = "milestones/selected-notice.md"; // Filename deliberately differs from typed ID.
const eventPath = "events/notice-absence.md";
const milestone = `---
schema: '0.1'
type: milestone
id: milestone.notice-absence
title: "A missing passenger"
status: draft
decisions: []
arcs: [arc.locked-door]
completeness: partial
fulfillment: {any_of: []}
---

The passenger's absence becomes important only when the locked compartment matters.
`;
const corrected = milestone.replace("completeness: partial", "completeness: complete")
  .replace("fulfillment: {any_of: []}", "fulfillment: {any_of: [[event.notice-absence]]}");
function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
const original: TurnAssignmentEvidence = {
  id: "event", specialist: "nt-event-design", outcome: "Make the lock causally necessary",
  targets: ["milestone.notice-absence"], dependsOn: [], discovery: "canonical-story-read-only",
  authority: { recordTypes: ["event"], existingPaths: [], mayCreate: true },
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nt168-event-field-grant-"));
  const story = join(root, "story"), stateDir = join(root, ".git", "state");
  mkdirSync(join(story, "milestones"), { recursive: true });
  mkdirSync(join(story, "events"), { recursive: true });
  writeFileSync(join(story, selectedPath), milestone);
  git(root, "init", "-q"); git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.test");
  git(root, "add", "."); git(root, "commit", "-qm", "Prior architecture");
  const parentSha = git(root, "rev-parse", "HEAD");
  mkdirSync(join(stateDir, "event-items"), { recursive: true });
  writeFileSync(join(story, selectedPath), corrected);
  writeFileSync(join(story, eventPath), "---\ntype: event\nid: event.notice-absence\n---\n\nA key opens the door.\n");
  const proof: EventConsequenceProof = {
    version: 1, milestone: { id: original.targets[0]!, path: selectedPath,
      line: 12, claim: "The locked state matters" },
    sourceDigest: "0".repeat(64), sourceHashes: [
      { path: selectedPath, sha256: hash(corrected) },
      { path: eventPath, sha256: hash(readFileSync(join(story, eventPath), "utf8")) },
    ], routes: [], baselines: [], events: [], laterObligations: [],
    unresolvedChoiceOutcomes: [], diagnostics: [],
  };
  git(root, "add", "."); git(root, "commit", "-qm",
    "Event authored\n\nNovelTea-Event-Consequence: " + eventConsequenceProofDigest(proof));
  const sourceSha = git(root, "rev-parse", "HEAD");
  const job = { jobId: "event-job", baseSha: parentSha, worktreeRoot: root,
    worktreeStoryRoot: story, storyRelativePath: "story", stateDir } as JobStartResult;
  const point = { workItem: "event-notice-absence", jobId: job.jobId, commitSha: sourceSha,
    parentSha, planVersion: 2, assurance: {
      assignmentId: "event", changedPaths: [eventPath, selectedPath],
    } } as RecoveryCheckpoint;
  const receipt = { version: 1, jobId: job.jobId, baseSha: job.baseSha,
    workItemId: point.workItem, worker: "pi", phase: "committed", commitSha: sourceSha,
    expectedHead: parentSha, planVersion: 2, milestoneId: original.targets[0],
    paths: [eventPath, selectedPath], validation: { status: "passed" },
    assignment: { milestoneId: original.targets[0], milestonePath: selectedPath,
      workItemId: point.workItem, sourcePaths: [selectedPath, eventPath] },
    consequenceProof: proof };
  const file = join(stateDir, "event-items", "notice-absence.json");
  const save = (value = receipt) => writeFileSync(file, JSON.stringify(value));
  save();
  return { root, story, job, point, receipt, save };
}

test("selected Milestone grant is bound to the Event's original signed native-typed source", async t => {
  const fx = fixture();
  t.after(() => removeTestTree(fx.root));
  assert.deepEqual(await readEventMilestoneRepairGrant(fx.job, fx.point, original),
    { id: original.targets[0], path: selectedPath });
  assert.deepEqual(await readEventMilestoneRepairGrant(fx.job, fx.point,
    { ...original, targets: [] }), { id: original.targets[0], path: selectedPath },
  "Broad full-Story Turn assignments select exactly one Milestone through their signed Event receipt");
  // Source comparisons must use committed bytes, never a subsequent dirty edit.
  writeFileSync(join(fx.story, selectedPath), milestone);
  assert.deepEqual(await readEventMilestoneRepairGrant(fx.job, fx.point, original),
    { id: original.targets[0], path: selectedPath });
  for (const change of [
    { jobId: "foreign-job" },
    { commitSha: "f".repeat(40) },
    { expectedHead: "f".repeat(40) },
    { planVersion: 3 },
    { milestoneId: "milestone.other" },
    { assignment: { ...fx.receipt.assignment, milestonePath: "milestones/other.md" } },
    { assignment: { ...fx.receipt.assignment, sourcePaths: [eventPath] } },
    { consequenceProof: { ...fx.receipt.consequenceProof,
      milestone: { ...fx.receipt.consequenceProof.milestone, id: "milestone.other" } } },
    { consequenceProof: { ...fx.receipt.consequenceProof, sourceHashes: [{
      path: selectedPath, sha256: "f".repeat(64) }] } },
  ]) {
    fx.save({ ...fx.receipt, ...change });
    await assert.rejects(readEventMilestoneRepairGrant(fx.job, fx.point, original),
      /grant|signed|source/);
  }
  fx.save();
  await assert.rejects(readEventMilestoneRepairGrant(fx.job, fx.point, {
    ...original, targets: ["milestone.other"] }), /assignment/);
  await assert.rejects(readEventMilestoneRepairGrant(fx.job, { ...fx.point,
    assurance: { ...fx.point.assurance!, changedPaths: [eventPath] } } as RecoveryCheckpoint,
  original), /grant/);
  await assert.rejects(readEventMilestoneRepairGrant(fx.job, { ...fx.point,
    planVersion: 3 } as RecoveryCheckpoint, original), /grant/);
});

test("saved #158 Collaborative Luna Milestone finding is repairable within its actual original grant", {
  skip: !process.env.NT_TEST_168_STATE && "set NT_TEST_168_STATE to preserved #158 job state",
}, async () => {
  const stateDir = process.env.NT_TEST_168_STATE!;
  const manifest = JSON.parse(readFileSync(join(stateDir, "job.json"), "utf8")) as JobStartResult;
  const job: JobStartResult = { ...manifest, stateDir, status: "ready",
    headSha: "" };
  const sha = "ae7ca52c90b062cc724155d458c42fb0bac53d17";
  const point = JSON.parse(readFileSync(join(stateDir, "recovery-checkpoints",
    sha + ".json"), "utf8")) as RecoveryCheckpoint;
  const turn = JSON.parse(readFileSync(join(stateDir, "turn-plan.json"), "utf8")) as TurnEvidence;
  const original = turn.assignments.find(a => a.id === point.assurance?.assignmentId)!;
  const sealed = await readIndependentReview(job, point.assurance!);
  assert.equal(sealed.status, "failed");
  assert.ok(sealed.result?.findings.some(f => f.path === "milestones/notice-absence.md"));
  assert.deepEqual(original.targets, [], "Full-Story Turn target list is intentionally broad");
  const grant = await readEventMilestoneRepairGrant(job, point, original);
  assert.deepEqual(grant, { id: "milestone.notice-absence", path: "milestones/notice-absence.md" });
  assert.equal(reviewNeedsDependency(point.assurance!, sealed.result!, point.workItem, grant), false);
  const correction = deriveReviewRepairAmendment({ assurance: point.assurance!,
    review: sealed.result!, original, planVersion: point.planVersion!,
    originWorkItem: point.workItem, eventMilestone: grant });
  assert.deepEqual(correction.eventMilestone, grant);
  assert.ok(correction.assignment.authority.existingPaths.includes(grant!.path));
  assert.equal(correction.assignment.authority.mayCreate, false);
});

test("renaming a selected Milestone never becomes a permitted repair", t => {
  const fx = fixture();
  t.after(() => removeTestTree(fx.root));
  git(fx.root, "mv", "story/" + selectedPath, "story/milestones/renamed.md");
  const state = { allowedPaths: [selectedPath],
    origin: { workItem: "event-notice-absence" }, baselineHead: fx.point.commitSha,
    planAmendment: { eventMilestone: { id: original.targets[0], path: selectedPath } },
  } as RepairReceipt;
  assert.throws(() => changedRepairPaths(fx.job, state), /staged|renamed|unsafe/);
});

test("Event's repair diff changes fulfillment only, never other Milestone fields or files", t => {
  const fx = fixture();
  t.after(() => removeTestTree(fx.root));
  const state = {
    allowedPaths: [eventPath, selectedPath], origin: { workItem: "event-notice-absence" },
    baselineHead: fx.point.commitSha, planAmendment: {
      eventMilestone: { id: original.targets[0], path: selectedPath },
    },
  } as RepairReceipt;
  const target = join(fx.story, selectedPath);
  const newer = corrected.replace("completeness: complete", "completeness: partial")
    .replace("fulfillment: {any_of: [[event.notice-absence]]}", "fulfillment: {any_of: []}");
  writeFileSync(target, newer);
  assert.deepEqual(changedRepairPaths(fx.job, state), [selectedPath]);
  assert.doesNotThrow(() => assertMilestoneFulfillmentOnly(corrected, newer));
  const eventFile = join(fx.story, eventPath);
  const originalEvent = readFileSync(eventFile, "utf8");
  writeFileSync(eventFile, originalEvent.replace("A key opens the door.",
    "A verified key opens the door."));
  assert.deepEqual(changedRepairPaths(fx.job, state), [eventPath, selectedPath],
    "The original Event and its selected Milestone may be corrected together");
  writeFileSync(eventFile, originalEvent);

  for (const bad of [
    newer.replace("title: \"A missing passenger\"", "title: \"A new story\""),
    newer.replace("arcs: [arc.locked-door]", "arcs: [arc.other]"),
    newer.replace("decisions: []", "decisions: [retcon]"),
    newer.replace("status: draft", "status: superseded"),
    newer.replace("The passenger's absence", "A different passenger's absence"),
    newer + "unwanted prose\n",
  ]) {
    writeFileSync(target, bad);
    assert.throws(() => changedRepairPaths(fx.job, state),
      /Milestone repair changed unrelated/);
  }
  writeFileSync(target, corrected);
  writeFileSync(join(fx.story, "milestones", "unrelated.md"), milestone);
  assert.throws(() => changedRepairPaths(fx.job, state), /protected|unrelated/);
  rmSync(join(fx.story, "milestones", "unrelated.md"));
  rmSync(target);
  symlinkSync("../events/notice-absence.md", target);
  assert.throws(() => changedRepairPaths(fx.job, state), /staged|unsafe|symlink/);
});
