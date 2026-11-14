import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobStartResult } from "../src/job.js";
import { approveDependency, dependencyDigest, inspectDependencyPlan, recordReviewDependency,
  registerReviewDependency } from "../src/dependency-state.js";
import type { RecoveryCheckpoint } from "../src/recovery-checkpoints.js";
import { deriveReviewDependencyRequest, reviewNeedsDependency } from "../src/review-repair-amendment.js";
import { authorizeReviewCharacterDependency, type ReviewCharacterProposal } from "../src/dependency-amendments.js";
import { appendArcLink, auditArcLink } from "../src/focused-work.js";
import { checkEditorialVerdict, type ReviewAssignment } from "../src/narrative-review-specialist.js";
import type { CheckpointAssurance, IndependentReviewResult } from "../src/checkpoint-assurance.js";
import type { TurnEvidence } from "../src/turn-plan-evidence.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const base = "a".repeat(40), source = "b".repeat(40);
const owner: TurnEvidence["assignments"][number] = {
  id: "foundations", specialist: "nt-worldbuilding + nt-character-development",
  outcome: "Build Character and World foundations required by the architecture",
  targets: [], dependsOn: ["architecture"], discovery: "canonical-story-read-only",
  authority: { recordTypes: ["world-entity", "fact", "revelation", "character", "relationship"],
    existingPaths: [], mayCreate: true },
};
const turn: TurnEvidence = {
  version: 1, kind: "full-story", originalRequest: "Make a mystery",
  goal: "Make a mystery", source: { jobId: "job", verifiedSha: base },
  contract: { scope: { kind: "full-story", depth: "composition", targets: [], branches: [] },
    constraints: [], envelope: { presentation: "text", hardLimits: [], preferences: [] } },
  objective: { breadth: "whole-story", requestedTargets: [], deliveryDepth: "composition",
    obligations: ["Connected Arcs, Milestones, Characters and causal Events"] },
  assignments: [owner], reviewRequired: true, digest: "d".repeat(64),
};
const assurance: CheckpointAssurance = {
  version: 1, policyVersion: 1, jobId: "job", baseSha: base, parentSha: base,
  commitSha: source, workItem: "character-foundations",
  validationProofDigest: "c".repeat(64), validatorVersion: "1.0.0",
  turnDigest: turn.digest, assignmentId: owner.id, assignmentDigest: digest(owner),
  assignmentDependencies: [], changedPaths: ["arcs/the-vanishing-inspector.md",
    "characters/mara-vale.md", "characters/ives-rowan.md"],
  changedRecordTypes: ["arc", "character"], addedLines: 30, removedLines: 4,
  diffDigest: "e".repeat(64),
  reviewSelection: { status: "required-pending", reasons: ["cross-record-types"] },
};
const review: IndependentReviewResult = {
  version: 1, reviewer: "independent-pi-assignment-review", status: "failed",
  source: { jobId: assurance.jobId, commitSha: assurance.commitSha,
    turnDigest: assurance.turnDigest, assignmentId: assurance.assignmentId,
    assignmentDigest: assurance.assignmentDigest, diffDigest: assurance.diffDigest,
    validationProofDigest: assurance.validationProofDigest },
  findings: [{ path: "arcs/the-vanishing-inspector.md", line: 14, kind: "missing-requirement",
    message: "The central missing inspector has no Character profile.",
    requiredCorrection: "Create a distinct central Character profile and link it from the reviewed Arc.",
    affectedPaths: ["arcs/the-vanishing-inspector.md", "characters/mara-vale.md"] }],
  evidence: "sealed original independent review",
};
const args = () => ({ assurance, review, original: owner, turn,
  planVersion: 1, originWorkItem: "character-foundations" });

test("S14: missing inspector yields a source-bound routine supporting-work request, not a new-file grant", () => {
  const request = deriveReviewDependencyRequest(args());
  assert.equal(request.classification, "new-full-story-record");
  assert.equal(request.action, "controller-amendment-required");
  assert.equal(request.sourceSha, source);
  assert.equal(request.turnDigest, turn.digest);
  assert.equal(request.objectiveDigest, digest(turn.objective));
  assert.equal(request.scopeDigest, digest(turn.contract.scope));
  assert.equal(request.originalAssignmentDigest, digest(owner));
  assert.equal(request.reviewDigest, digest(review));
  assert.deepEqual(request.findings.map(f => [f.path, f.line]),
    [["arcs/the-vanishing-inspector.md", 14]]);
  assert.equal("newPaths" in request, false, "reviewer cannot confer file authority");
  assert.equal(request.digest, digest((({ digest: _, ...body }) => body)(request)));
  assert.deepEqual(deriveReviewDependencyRequest(args()), request);
});

test("S14: replay the exact preserved #158 missing-inspector failure without modifying Story state", {
  skip: !process.env.NT_TEST_S14_STATE && "set NT_TEST_S14_STATE to the preserved private #158 job state directory",
}, () => {
  const state = process.env.NT_TEST_S14_STATE!;
  const sha = "a7f2e1f972b42e194798f577bbe3be613ab7e188";
  const saved = <T>(path: string): T => JSON.parse(readFileSync(join(state, path), "utf8")) as T;
  const checkpoint = saved<RecoveryCheckpoint>("recovery-checkpoints/" + sha + ".json");
  const sealed = saved<IndependentReviewResult>("independent-reviews/" + sha + ".json");
  const originalTurn = saved<TurnEvidence>("turn-plan.json");
  const assignment = originalTurn.assignments.find(a => a.id === checkpoint.assurance!.assignmentId);
  assert.ok(assignment, "The original verified Turn must retain its foundations owner.");
  const request = deriveReviewDependencyRequest({
    assurance: checkpoint.assurance!, review: sealed, original: assignment,
    turn: originalTurn, planVersion: checkpoint.planVersion!,
    originWorkItem: checkpoint.workItem,
  });
  assert.equal(request.classification, "new-full-story-record");
  assert.equal(request.action, "controller-amendment-required");
  assert.deepEqual(request.findings.map(f => [f.path, f.line]), [
    ["arcs/the-vanishing-inspector.md", 14],
  ]);
  assert.match(request.findings[0]!.requiredCorrection, /Create a Character record/);
  assert.equal(request.sourceSha, sha);
});

test("S14: preserved Luna source authorizes the exact Character/Arc work through the shared private ledger", {
  skip: !process.env.NT_TEST_S14_STATE && "set NT_TEST_S14_STATE to preserved private #158 job state",
}, async () => {
  const state = process.env.NT_TEST_S14_STATE!;
  const sha = "a7f2e1f972b42e194798f577bbe3be613ab7e188";
  const temp = mkdtempSync(join(tmpdir(), "nt-s14-plan-"));
  try {
    const scratch = join(temp, "job");
    cpSync(state, scratch, { recursive: true });
    const saved = <T>(path: string): T =>
      JSON.parse(readFileSync(join(scratch, path), "utf8")) as T;
    const job = { ...saved<JobStartResult>("job.json"),
      stateDir: scratch, status: "ready" as const, headSha: sha };
    const checkpoint = saved<RecoveryCheckpoint>("recovery-checkpoints/" + sha + ".json");
    const sealed = saved<IndependentReviewResult>("independent-reviews/" + sha + ".json");
    const turn = saved<TurnEvidence>("turn-plan.json");
    const assignment = turn.assignments.find(a => a.id === checkpoint.assurance!.assignmentId)!;
    const request = deriveReviewDependencyRequest({ assurance: checkpoint.assurance!,
      review: sealed, original: assignment, turn,
      planVersion: checkpoint.planVersion!, originWorkItem: checkpoint.workItem });
    await recordReviewDependency(job, request);
    const { plan, entry } = await registerReviewDependency(job, request);
    assert.equal(entry.reviewSourceSha, sha);
    assert.equal(entry.phase, "reported");
    assert.equal(entry.report.affectedIds.length, 1);
    assert.equal(entry.report.sources[0]?.path, "arcs/the-vanishing-inspector.md");
    assert.equal(entry.report.missing, sealed.findings[0]?.requiredCorrection);
    const proposal: ReviewCharacterProposal = {
      sourceSha: sha, reportDigest: entry.reportDigest,
      target: "character.missing-inspector", specialist: "nt-character-development",
      title: "The Missing Inspector", outcome: entry.report.missing,
      reason: "Central existing Arc requires a concrete missing-inspector Character.",
    };
    await assert.rejects(approveDependency(job, plan, entry, {
      ...proposal, target: "character.mara-vale",
    }), /authorization|dependency/i);
    await approveDependency(job, plan, entry, proposal);
    const persisted = await inspectDependencyPlan(job);
    assert.equal(persisted?.version, 2);
    assert.equal(persisted?.entries[0]?.phase, "authorized");
    assert.deepEqual(persisted?.entries[0]?.amendment?.assignment.authority, {
      recordTypes: ["arc", "character"],
      existingPaths: ["arcs/the-vanishing-inspector.md"],
      newPaths: ["characters/missing-inspector.md"], mayCreate: true,
    });
    // Re-invocation at the same source must never allocate a second writer
    // or duplicate the amended work-plan version.
    assert.deepEqual(await recordReviewDependency(job, request), request);
    assert.equal((await inspectDependencyPlan(job))?.version, 2);
    // A tampered ledger digest cannot replace an independently sealed finding
    // even after an attacker recomputes the ledger's self-checksum.
    const corrupt = JSON.parse(readFileSync(join(scratch, "dependency-plan.json"), "utf8"));
    corrupt.reviewRequests[0].findings[0].requiredCorrection = "Invent a different character.";
    const { digest: _discard, ...body } = corrupt;
    corrupt.digest = dependencyDigest(body);
    writeFileSync(join(scratch, "dependency-plan.json"), JSON.stringify(corrupt));
    await assert.rejects(inspectDependencyPlan(job),
      /immutable source|ownership|scope|review dependency/i);
    // The private Story source and negative review were only READ, not edited.
    assert.equal(saved<IndependentReviewResult>("independent-reviews/" + sha + ".json").status, "failed");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("S14: a separate verified Character assignment may create one exact new Character and link one Arc", () => {
  const request = deriveReviewDependencyRequest(args());
  const proposal: ReviewCharacterProposal = {
    sourceSha: source, reportDigest: "a".repeat(64),
    target: "character.missing-inspector", specialist: "nt-character-development",
    title: "The Missing Inspector", outcome: request.findings[0]!.requiredCorrection,
    reason: "The original Arc relies on the missing central inspector.",
  };
  const arc = { path: "arcs/the-vanishing-inspector.md", metadata: {
    id: "arc.the-vanishing-inspector", type: "arc", status: "draft",
    characters: ["character.mara-vale", "character.ives-rowan"], decisions: [] } };
  const records = [arc, ...["mara-vale", "ives-rowan"].map(slug => ({
    path: "characters/" + slug + ".md", metadata: {
      id: "character." + slug, type: "character", status: "draft", decisions: [],
    },
  }))];
  const valid = { plan: turn, head: source, request, proposal,
    reportDigest: proposal.reportDigest, version: 1, records };
  const amendment = authorizeReviewCharacterDependency(valid);
  assert.equal(amendment.resumes, "foundations");
  assert.deepEqual(amendment.assignment.authority, {
    recordTypes: ["arc", "character"], existingPaths: [arc.path],
    newPaths: ["characters/missing-inspector.md"], mayCreate: true,
  });
  assert.equal(amendment.assignment.specialist, "nt-character-development");
  const invalid = [
    { ...valid, head: base },
    { ...valid, proposal: { ...proposal, sourceSha: base } },
    { ...valid, proposal: { ...proposal, target: "character.ives-rowan" } },
    { ...valid, proposal: { ...proposal, target: "character.evil", path: "characters/evil.md" } },
    { ...valid, proposal: { ...proposal, target: "fact.missing-inspector" } },
    { ...valid, proposal: { ...proposal, specialist: "nt-worldbuilding" } },
    { ...valid, proposal: { ...proposal, outcome: "Invent a culprit" } },
    { ...valid, proposal: { ...proposal, title: "Other\nLine" } },
    { ...valid, records: [{ ...arc, metadata: { ...arc.metadata, status: "superseded" } }] },
    { ...valid, priorAmendments: [{ ...owner, authority: {
      ...owner.authority, existingPaths: [arc.path] } }] },
    { ...valid, priorAmendments: [{ ...owner, authority: {
      ...owner.authority, newPaths: ["characters/missing-inspector.md"] } }] },
    { ...valid, plan: { ...turn, objective: { ...turn.objective!, breadth: "focused" as const } } },
  ];
  for (const [index, candidate] of invalid.entries()) assert.throws(
    () => authorizeReviewCharacterDependency(candidate),
    /dependency|authorization/i, "Rejected invalid proposal #" + index);
});

test("S14: a missing newly requested Character is routed even if the cited Character file is writable", () => {
  const writable = { ...assurance, changedPaths: ["characters/mara-vale.md"] };
  const finding = { ...review.findings[0]!, path: "characters/mara-vale.md",
    affectedPaths: ["characters/mara-vale.md"] };
  const negative = { ...review, findings: [finding] };
  assert.equal(reviewNeedsDependency(writable, negative, "character-foundations"), true);
  assert.equal(deriveReviewDependencyRequest({
    ...args(), assurance: writable, review: {
      ...negative, source: { ...negative.source, diffDigest: writable.diffDigest },
    },
  }).classification, "new-full-story-record");
});

test("S14: Arc editor accepts one Character link without prose, decisions or other-frontmatter changes", () => {
  const target = "character.missing-inspector";
  for (const yaml of [
    "characters: [character.mara-vale, character.ives-rowan]",
    "characters:\n  - character.mara-vale\n  - character.ives-rowan",
  ]) {
    const before = "---\nschema: '0.1'\ntype: arc\nid: arc.the-vanishing-inspector\n" +
      "title: The Vanishing Inspector\nstatus: draft\n" + yaml +
      "\ndecisions: []\n---\nOne vanishing inspector drives the mystery.\n";
    const after = appendArcLink(before, target);
    assert.doesNotThrow(() => auditArcLink(before, after, target));
    assert.match(after, /character\.missing-inspector/);
    assert.deepEqual(after.split("\n").filter(line => line.includes("One vanishing")),
      before.split("\n").filter(line => line.includes("One vanishing")));
    assert.throws(() => auditArcLink(before, after.replace("vanishing inspector", "vanishing mayor"),
      target), /Arc changed/);
    assert.throws(() => auditArcLink(before, after.replace("decisions: []", "decisions: [retcon]"),
      target), /Arc changed/);
    assert.throws(() => auditArcLink(before, after.replace("status: draft", "status: complete"),
      target), /Arc changed/);
    assert.throws(() => auditArcLink(before, appendArcLink(after, "character.unknown"), target),
      /Arc changed/);
    const reordered = after.replace(
      "character.mara-vale", "character.mara-placeholder")
      .replace("character.ives-rowan", "character.mara-vale")
      .replace("character.mara-placeholder", "character.ives-rowan");
    assert.throws(() => auditArcLink(before, reordered, target), /Arc changed/,
      "Preexisting Arc Character order is protected");
    assert.throws(() => appendArcLink(after, target), /already exists/);
  }
});

test("S14: protected or non-delegated new Character requests must require explicit scope approval", () => {
  const restricted: TurnEvidence = { ...turn, kind: "revision",
    objective: { ...turn.objective!, breadth: "focused" } };
  const request = deriveReviewDependencyRequest({ ...args(), turn: restricted });
  assert.equal(request.action, "author-approval-required");
  assert.equal(request.classification, "scope-or-protected");
});

test("S14: forged review, owner, SHA, plan version and changed paths never create an amendment request", () => {
  const invalid = [
    { ...args(), review: { ...review, source: { ...review.source, commitSha: "f".repeat(40) } } },
    { ...args(), original: { ...owner, authority: { ...owner.authority, mayCreate: false } } },
    { ...args(), assurance: { ...assurance, changedPaths: ["characters/mara-vale.md"] } },
    { ...args(), turn: { ...turn, digest: "f".repeat(64) } },
    { ...args(), planVersion: 0 },
    { ...args(), review: { ...review, status: "passed" as const } },
    { ...args(), review: { ...review, findings: [{ ...review.findings[0]!,
      affectedPaths: ["arcs/../malicious.md"] }] } },
  ];
  for (const value of invalid) assert.throws(() => deriveReviewDependencyRequest(value),
    /review|source|assignment|scope|authority|plan|sealed|provenance/i);
});

test("S14: a passing independent rereview must cite both the new Character and Arc", () => {
  const assignment: ReviewAssignment = {
    contract: turn.contract, planVersion: 2,
    scopeIds: ["character.missing-inspector", "arc.the-vanishing-inspector"],
    paths: ["arcs/the-vanishing-inspector.md", "characters/missing-inspector.md"],
    routes: [], milestoneRoutes: [], puzzleRoutes: [], outstanding: [], uncertainties: [],
    turnGoal: "Verify the suspended original Character Foundations obligation",
    reassessment: { assignmentId: owner.id, failedSourceSha: source,
      correctedHeadSha: "c".repeat(40) },
    specialistAssignments: [{ id: "dependency:1:character.missing-inspector",
      specialist: "nt-character-development", outcome: review.findings[0]!.requiredCorrection,
      targets: ["character.missing-inspector"],
      authority: { recordTypes: ["arc", "character"],
        existingPaths: ["arcs/the-vanishing-inspector.md"],
        newPaths: ["characters/missing-inspector.md"], mayCreate: true } }],
  };
  const verdict = { verdict: "pass" as const, findings: [], evidence: [
    "arcs/the-vanishing-inspector.md:14 now links the inspector",
    "characters/missing-inspector.md:15 establishes motivation and honest knowledge",
  ] };
  assert.equal(checkEditorialVerdict(verdict, assignment).verdict, "pass");
  assert.throws(() => checkEditorialVerdict({ ...verdict, evidence: [verdict.evidence[0]!] },
    assignment), /omitted source-linked evidence/);
  assert.throws(() => checkEditorialVerdict({ ...verdict, evidence: [verdict.evidence[1]!] },
    assignment), /omitted source-linked evidence/);
  assert.throws(() => checkEditorialVerdict({ ...verdict, evidence: verdict.evidence,
    findings: [{ severity: "blocking" as const, dimension: "obligation" as const,
      source: "arcs/the-vanishing-inspector.md:14", message: "Inspector is absent",
      repair: "architecture" as const }] }, assignment), /conflicts with blocking/);
});
