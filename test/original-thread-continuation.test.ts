import assert from "node:assert/strict";
import { test } from "node:test";
import type { JobStartResult } from "../src/job.js";
import { inspectBlockedOriginalThreadCorrection, type BlockedOriginalThreadState } from
  "../src/original-thread-continuation.js";
import { operationChecks, type GenerationOperationRecovery } from
  "../src/generation-operation-recovery.js";

const head = "a".repeat(40);
const turn = "b".repeat(64);
const thread = "original:generation:web";
const job = { jobId: "original" } as JobStartResult;
const original: GenerationOperationRecovery = {
  version: 1, operation: "independent-review",
  check: operationChecks["independent-review"], checkVersion: 1,
  phase: "fenced", outcome: "exception", safeAction: "reconcile-original-operation",
  source: { jobId: "original", threadId: thread, turnDigest: turn,
    planVersion: 2, headSha: head },
  evidence: { reference: "review-checkpoints", assignmentId: "interactive:milestone.disclosure" },
  reason: "Original independent review could not certify the current obligations.",
  nextAction: "Reconcile original review before dispatch.",
};
const saved: BlockedOriginalThreadState = {
  status: "blocked", graphThreadId: thread,
  request: { job: "original", task: "An archive mystery",
    contract: { scope: { kind: "full-story" } }, turnPlanDigest: turn },
  planVersion: 2,
  active: { id: "interactive:milestone.disclosure", stage: "interactive",
    milestone: "milestone.disclosure" },
  inventory: { headSha: head, items: [{
    id: "interactive:milestone.disclosure", status: "blocked",
  }] },
  operationRecovery: original,
};

test("blocked original-Thread admission rejects unrelated graph, Thread and operations before inspecting effects", async () => {
  const cases: Array<[string, BlockedOriginalThreadState, string]> = [
    ["missing graph state", { status: "blocked" }, /handoff/.source],
    ["unrelated paused state", { ...saved, status: "paused" }, /handoff/.source],
    ["different Thread", { ...saved, graphThreadId: "other" }, /handoff/.source],
    ["missing pinned request", { ...saved, request: undefined }, /handoff/.source],
    ["unsettled result", { ...saved, result: { status: "committed" } }, /handoff/.source],
    ["unfinished idea", { ...saved, ideaTask: { id: "ambiguous" } }, /handoff/.source],
    ["conflicting operation", { ...saved, operationRecovery: null }, /disposition/.source],
    ["wrong controller check", { ...saved, operationRecovery: { ...original,
      check: "unrelated-verifier.v1" } }, /disposition/.source],
    ["wrong controller job", { ...saved, operationRecovery: { ...original,
      source: { ...original.source, jobId: "foreign" } } }, /disposition/.source],
    ["wrong controller source", { ...saved, operationRecovery: { ...original,
      source: { ...original.source, turnDigest: "c".repeat(64) } } }, /disposition/.source],
    ["unassessed correction", { ...saved, operationRecovery: { ...original,
      phase: "assessment" } }, /disposition/.source],
  ];
  for (const [label, state, reason] of cases) {
    const proof = await inspectBlockedOriginalThreadCorrection(job, thread, state);
    assert.equal(proof.eligible, false, label);
    assert.match(proof.reason, new RegExp(reason), label);
  }
});
