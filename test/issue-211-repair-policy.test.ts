import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JobStartResult } from "../src/job.js";
import { admitRepairFinding, inspectRepairLedger, submitRepairCorrection,
  settleRepairReview, admitCausalRevalidationFinding,
  admitPrerequisiteRepair, submitPrerequisiteRepair, settlePrerequisiteRepair,
  totalTurnCorrections } from "../src/repair-ledger.js";
import { removeTestTree } from "./helpers.js";
import { configurePiPolicy, guardPiBudget, inspectPiPolicy, PiBudgetPause } from "../src/job-pi-policy.js";

const sha = (v: string) => v.repeat(40);
const digest = (v: string) => v.repeat(64);
const turnDigest = digest("a");
const root = sha("1");
const path = "events/arrival.md";
const finding = (message: string) => ({
  path, kind: "continuity" as const, affectedPaths: [path], message,
  requiredCorrection: "Deliver independently supported evidence.",
});
const report = (sourceSha: string, reviewDigest: string, messages: string[]) => ({
  turnDigest, rootFailureSha: root, sourceSha, reviewDigest,
  assignmentId: "event:arrival", obligation: "Evidence-backed arrival",
  findings: messages.map(finding),
});
function job(t: import("node:test").TestContext): JobStartResult {
  const stateDir = mkdtempSync(join(tmpdir(), "nt-211-"));
  t.after(() => removeTestTree(stateDir));
  return { stateDir, jobId: "job-211", threadId: "thread-211" } as JobStartResult;
}

test("improving repair can submit more than two sealed corrections without identity-based resets", async t => {
  const j = job(t);
  await admitRepairFinding(j, report(root, digest("b"), ["Missing witness", "Missing timestamp"]));
  let current = root;
  const reviews = ["c", "d", "e", "f"];
  for (const [index, reviewer] of reviews.entries()) {
    const next = sha(String(index + 2));
    const submitted = await submitRepairCorrection(j, {
      turnDigest, rootFailureSha: root, sourceSha: current, changedPaths: [path],
    });
    const replay = await submitRepairCorrection(j, {
      turnDigest, rootFailureSha: root, sourceSha: current, changedPaths: [path],
    });
    assert.deepEqual(replay, submitted, "repeated restart must not double-submit");
    const unresolved = index === 0
      ? ["Missing timestamp", "Contradictory arrival location"]
      : index === 1 ? ["Contradictory arrival location"]
      : index === 2 ? ["Unsupported final timestamp"] : [];
    await settleRepairReview(j, {
      ...report(current, digest(reviewer), unresolved), successorSha: next,
      status: unresolved.length ? "failed" : "passed",
    });
    const again = await settleRepairReview(j, {
      ...report(current, digest(reviewer), unresolved), successorSha: next,
      status: unresolved.length ? "failed" : "passed",
    });
    assert.equal(again.corrections.length, index + 1);
    if (unresolved.length) {
      const active = await admitRepairFinding(j, report(next, digest(reviewer), unresolved));
      assert.equal(active.findings.filter(f => f.status === "open").length, unresolved.length,
        "two distinct defects in one record remain distinct");
    }
    current = next;
  }
  const ledger = await inspectRepairLedger(j, turnDigest);
  assert.equal(totalTurnCorrections(ledger), 4);
  assert.equal(ledger.corrections.every(c => c.result), true);
  assert.equal(ledger.findings.filter(f => f.status === "open").length, 0);
});

test("a repeated source cannot exchange reviewers or submit unauthorized paths", async t => {
  const j = job(t);
  await admitRepairFinding(j, report(root, digest("b"), ["No direct evidence"]));
  await assert.rejects(() => admitRepairFinding(j, report(root, digest("c"), ["No direct evidence"])),
    /Conflicting sealed review/);
  await assert.rejects(() => submitRepairCorrection(j, {
    turnDigest, rootFailureSha: root, sourceSha: root,
    changedPaths: ["../../outside.md"],
  }), /bounded submitted source/);
  await submitRepairCorrection(j, {
    turnDigest, rootFailureSha: root, sourceSha: root, changedPaths: [path],
  });
  await assert.rejects(() => submitRepairCorrection(j, {
    turnDigest, rootFailureSha: root, sourceSha: root, changedPaths: ["characters/other.md"],
  }), /conflicting submission/);
  const ledger = await inspectRepairLedger(j, turnDigest);
  assert.equal(ledger.corrections.length, 1);
});

test("dependent revalidation records distinct defects without path/category matching", async t => {
  const j = job(t);
  const first = {
    ...report(root, digest("b"), ["One missing requirement"]),
    causedBy: root,
  };
  await admitCausalRevalidationFinding(j, first);
  await assert.rejects(() => admitCausalRevalidationFinding(j, {
    ...first, findings: [finding("A different material issue in the same event")],
  }), /Conflicting sealed review/,
  "a different finding payload cannot be attributed to the same sealed review digest");
});

test("job resource pause persists across attempted semantic corrections and resumes without resetting history", async t => {
  const j = job(t);
  const policy = (steps: number) => ({
    version: 1 as const,
    profile: { provider: "openai", model: "gpt-6-luna" },
    limits: { steps },
  });
  await configurePiPolicy(j, policy(2));
  await admitRepairFinding(j, report(root, digest("b"), ["Missing witness"]));
  await guardPiBudget(j, "semantic-repair:round-1");
  await submitRepairCorrection(j, { turnDigest, rootFailureSha: root, sourceSha: root,
    changedPaths: [path] });
  await settleRepairReview(j, {
    ...report(root, digest("c"), ["Witness still missing"]),
    successorSha: sha("2"), status: "failed",
  });
  await admitRepairFinding(j, report(sha("2"), digest("c"), ["Witness still missing"]));
  await guardPiBudget(j, "semantic-repair:round-2");
  await assert.rejects(() => guardPiBudget(j, "semantic-repair:round-3"),
    (cause: unknown) => cause instanceof PiBudgetPause && cause.reason === "steps");
  assert.equal((await inspectPiPolicy(j)).budget.pause?.reason, "steps");
  const before = await inspectRepairLedger(j, turnDigest);
  assert.equal(before.corrections.length, 1, "resource pauses never fabricate a pending submission");
  await configurePiPolicy(j, policy(3));
  await guardPiBudget(j, "semantic-repair:round-3");
  await guardPiBudget(j, "semantic-repair:round-3");
  assert.equal((await inspectPiPolicy(j)).budget.steps, 3,
    "safe retries reuse the same step instead of double charging");
  assert.deepEqual((await inspectRepairLedger(j, turnDigest)).corrections, before.corrections);
});

test("prerequisite revalidation can make four independently reviewed narrow corrections", async t => {
  const j = job(t);
  const proposal = {
    turnDigest, milestoneId: "milestone.arrival", path: "milestones/arrival.md",
    sourceEventSha: sha("a"), proposalDigest: digest("b"), sourceSha: root, planVersion: 1,
  };
  const admitted = await admitPrerequisiteRepair(j, proposal);
  let current = root;
  for (let i = 0; i < 4; i++) {
    const next = sha(String(i + 2));
    await submitPrerequisiteRepair(j, {
      turnDigest, id: admitted.id, sourceSha: current, submittedSha: next,
      paths: [proposal.path],
    });
    await settlePrerequisiteRepair(j, {
      turnDigest, id: admitted.id, submittedSha: next,
      reviewDigest: digest(String(i + 2)), verdict: i === 3 ? "passed" : "failed",
    });
    if (i !== 3) await admitPrerequisiteRepair(j, {
      ...proposal, sourceSha: next, proposalDigest: digest(String(i + 2)),
    });
    current = next;
  }
  const ledger = await inspectRepairLedger(j, turnDigest);
  assert.equal(ledger.prerequisites![0]!.status, "resolved");
  assert.equal(ledger.prerequisites![0]!.attempts.length, 4);
});
