import assert from "node:assert/strict";
import { test } from "node:test";
import { projectAdaptiveFinal } from "../src/adaptive-final-review.js";
import type { AdaptiveState } from "../src/adaptive-state.js";

const sha = "a".repeat(40), digest = "b".repeat(64);
const state = (actions: AdaptiveState["entries"][number]["actions"],
  omissions: AdaptiveState["entries"][number]["omissions"] = []): AdaptiveState => ({
  schema: "noveltea-adaptive-plan/v1", jobId: "job", threadId: "thread",
  baseSha: sha, branch: "branch", turnDigest: digest, planVersion: 1, version: 2,
  attempts: [], digest,
  entries: [{
    schema: "noveltea-adaptive-assignments/v1", sourceSha: sha,
    turnDigest: digest, planVersion: 1, beforeVersion: 1, afterVersion: 2,
    inventoryDigest: digest, reason: "Reviewed Story-specific outcomes",
    actions, order: [], carried: [], omissions, digest,
  }],
});

test("narrative-led reviewed Event-only omission stays visible to the final independent reviewer", () => {
  const s = state([{ kind: "omit", item: "interactive:milestone.discovery" }],
    [{ assignmentId: "interactive:milestone.discovery", sourceSha: sha,
      path: "milestones/discovery.md", sourceHash: digest,
      evidence: "milestones/discovery.md:12 observational Event-only justification",
      reviewerSession: "/private/review.jsonl", reviewerSnapshot: digest }]);
  const review = projectAdaptiveFinal(s);
  assert.deepEqual(review.source.amendments, [digest]);
  assert.equal(review.source.version, 2);
  assert.match(review.objectives[0]!.text, /whole-Story|Story-wide/i);
  assert.equal(review.plannedWork[0]!.status, "reviewed-omission");
  assert.equal(review.plannedWork[0]!.id, "interactive:milestone.discovery");
  assert.equal(review.plannedWork[0]!.targets[0], "milestone.discovery");
});

test("choice-heavy adaptive assignments reach final review with new causal Events, Choices and Puzzle obligations", () => {
  const review = projectAdaptiveFinal(state([
    { kind: "add", stage: "event", milestone: "milestone.confrontation",
      dependsOn: ["event:milestone.discovery"] },
    { kind: "split", item: "interactive:milestone.confrontation", domains: ["choice", "puzzle"] },
    { kind: "narrow", item: "choice:milestone.confrontation", sourcePath: "milestones/confrontation.md",
      sourceHash: digest, outcome: "Two consequential choices whose effects persist after convergence" },
  ]));
  assert.deepEqual(review.plannedWork.map(item => item.id), [
    "event:milestone.confrontation", "choice:milestone.confrontation",
    "puzzle:milestone.confrontation",
  ]);
  assert.deepEqual(review.superseded, ["interactive:milestone.confrontation"],
    "a superseded aggregate must not appear alongside its independently reviewed Choice/Puzzle writers");
  assert.ok(review.objectives.some(o => /effects persist after convergence/.test(o.text)));
  assert.ok(review.objectives.some(o => /Puzzle/.test(o.text)));
  assert.ok(review.objectives.some(o => /causal/.test(o.text)));
});


test("#243 reviewed C06 successor replaces the stale narrowed goal in final whole-Story review", () => {
  const id = "interactive:milestone.discovery";
  const s = state([{ kind: "narrow", item: id, sourcePath: "milestones/discovery.md",
    sourceHash: digest, outcome: "An early formal Choice must be authored." }]);
  s.entries[0]!.order = [id, "review"];
  s.version = 3;
  s.supersessions = [{
    schema: "noveltea-adaptive-supersession/v1", beforeVersion: 2, afterVersion: 3,
    turnDigest: digest, planVersion: 1, sourceSha: sha, assignmentId: id,
    originalAmendmentDigest: digest, negativeReportDigest: "c".repeat(64),
    omission: { nonce: "aafaba04-d8b8-4fdc-b22e-37df8c98228d", digest: "d".repeat(64) },
    reviewedBlueprint: { milestoneId: "milestone.discovery", sourceSha: sha,
      digest: "e".repeat(64), cycleId: "review-cycle" }, digest: "f".repeat(64),
  }];
  const review = projectAdaptiveFinal(s);
  assert.deepEqual(review.source.amendments, [digest, "f".repeat(64)]);
  assert.equal(review.source.version, 3);
  assert.deepEqual(review.plannedWork.map(w => [w.id, w.status]), [[id, "reviewed-omission"]]);
  assert.ok(review.plannedWork[0]!.supersession);
  assert.ok(review.objectives.some(o => /original author goals/i.test(o.text)));
  assert.ok(!review.objectives.some(o => /An early formal Choice must be authored/.test(o.text)),
    "supersession must not keep treating the superseded narrow task as an independent writer demand");
});

test("missing or conflicting omission provenance never becomes a final no-write disposition", () => {
  assert.throws(() => projectAdaptiveFinal(state([{
    kind: "omit", item: "interactive:milestone.discovery",
  }])), /reviewed omission/i);
  const proof = { assignmentId: "interactive:milestone.discovery", sourceSha: sha,
    path: "milestones/discovery.md", sourceHash: digest, evidence: "review",
    reviewerSession: "/private/review.jsonl", reviewerSnapshot: digest };
  assert.throws(() => projectAdaptiveFinal(state([
    { kind: "omit", item: proof.assignmentId }, { kind: "omit", item: proof.assignmentId },
  ], [proof])), /duplicate|conflicting/i);
});
