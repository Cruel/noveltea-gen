import assert from "node:assert/strict";
import { test } from "node:test";
import { assertRecoveryCompatibility, assertRecoveryReceiptCompatibility,
  RecoveryCompatibilityError } from "../src/recovery-compatibility.js";
import type { RecoveryCheckpoint } from "../src/recovery-checkpoints.js";

const valid = (): RecoveryCheckpoint => ({
  version: 1, status: "finalized", jobId: "original-job", repository: "/repo", story: "/repo/story",
  storyRelativePath: "story", branch: "noveltea-gen/original", graphThread: "original:generation",
  baseSha: "1".repeat(40), commitSha: "2".repeat(40), parentSha: "1".repeat(40),
  workItem: "world-foundations", stage: "foundations", planVersion: 1,
  planDigest: "a".repeat(64),
  plan: {
    version: 1, contract: {
      scope: { kind: "partial", depth: "composition", targets: ["arc.truth", "milestone.disclosure"],
        branches: ["protect", "challenge"] },
      constraints: ["Retain the witness"], envelope: { presentation: "Visual novel",
        hardLimits: [], preferences: [] },
    },
    items: [{ id: "global-architecture", kind: "architecture", targetIds: ["arc.truth", "milestone.disclosure"],
      dependencies: [], skills: ["nt-story-architecture"], checks: ["canonical-structure"],
      authorization: { source: "explicit-author-cli", planVersion: 1, paths: [] },
      planVersion: 1, status: "verified", verifiedSha: "2".repeat(40) }],
  },
  completedWorkItems: ["foundation", "global-architecture", "world-foundations"],
  remainingWorkItems: ["character-foundations"], nextWorkItem: "character-foundations",
  dependencies: {}, validation: { status: "passed", validatorVersion: "1.0.0" },
  source: "character-world.json", proofDigest: "c".repeat(64), snapshotId: "d".repeat(64),
  compatibility: { logicalSchema: "noveltea-recovery/v1", graphSchema: "noveltea-generation/v1" },
  provenance: { authorApprovals: "source-bound-not-reusable", authorMessages: "source-bound-not-reusable" },
});

const rejects = (point: RecoveryCheckpoint, code: RecoveryCompatibilityError["code"]) =>
  assert.throws(() => assertRecoveryCompatibility(point),
    (err: unknown) => err instanceof RecoveryCompatibilityError && err.code === code &&
      err.nextSteps.some(step => /fresh Thread|migrate|restore/i.test(step)));

test("compatible historical logical plan is readable with current graph", () => {
  assert.equal((assertRecoveryCompatibility(valid()))?.version, 1);
  const foundation = valid();
  foundation.workItem = "foundation";
  foundation.plan = null;
  foundation.planVersion = null;
  assert.equal(assertRecoveryCompatibility(foundation), null);
});

test("obsolete graph, approval and receipt shapes fail closed without replay", () => {
  const oldGraph = valid();
  oldGraph.compatibility.graphSchema = "noveltea-generation/v0" as never;
  rejects(oldGraph, "obsolete-checkpoint");

  const oldAuthorization = valid();
  oldAuthorization.provenance.authorApprovals = "reusable" as never;
  rejects(oldAuthorization, "invalid-evidence");

  const missingPin = valid();
  missingPin.validation.validatorVersion = "";
  rejects(missingPin, "invalid-evidence");

  const changedPlan = valid();
  (changedPlan.plan as { version: number }).version = 5;
  rejects(changedPlan, "obsolete-checkpoint");

  const invalidItem = valid();
  (invalidItem.plan as { items: unknown[] }).items = [{ id: "global-architecture", kind: "legacy" }];
  rejects(invalidItem, "obsolete-checkpoint");

  const unknownContract = valid();
  (unknownContract.plan as { contract: unknown }).contract = { legacy: true };
  rejects(unknownContract, "obsolete-checkpoint");

  const planlessEvent = valid();
  planlessEvent.plan = null;
  rejects(planlessEvent, "obsolete-checkpoint");
});

test("current specialist receipt schemas admit only compatible, committed prior units", () => {
  const completed = new Set(["foundation", "global-architecture", "world-foundations"]);
  const snapshot = { id: "e".repeat(64) };
  const foundation = { version: 1, stage: "committed",
    commitSha: "2".repeat(40), snapshot };
  assert.doesNotThrow(() =>
    assertRecoveryReceiptCompatibility("foundation.json", foundation, completed));
  assert.doesNotThrow(() => assertRecoveryReceiptCompatibility("character-world.json", {
    version: 1, snapshot, units: [
      { id: "world-foundations", phase: "committed", commitSha: "2".repeat(40) },
      { id: "character-foundations", phase: "pending" },
    ],
  }, completed));

  const reject = (source: string, receipt: Record<string, unknown>) =>
    assert.throws(() => assertRecoveryReceiptCompatibility(source, receipt, completed),
      (err: unknown) => err instanceof RecoveryCompatibilityError &&
        err.code === "obsolete-checkpoint");

  reject("foundation.json", { ...foundation, version: 0 });
  reject("foundation.json", { ...foundation, snapshot: null });
  reject("character-world.json", { version: 1, snapshot,
    units: [{ id: "world-foundations", phase: "writing" }, { id: "character-foundations", phase: "pending" }] });
  reject("event-items/disclosure.json", { version: 0, snapshot,
    phase: "committed", workItemId: "event-disclosure", commitSha: "3".repeat(40) });
  reject("architecture.json", { format: 0, snapshot, phase: "committed", plan: {}, history: [] });
});
