import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JobStartResult } from "../src/job.js";
import { admitPrerequisiteRepair, inspectRepairLedger, settlePrerequisiteRepair,
  submitPrerequisiteRepair, admitRepairFinding, admitCausalRevalidationFinding,
  submitRepairCorrection, settleRepairReview, totalTurnCorrections } from "../src/repair-ledger.js";
import { removeTestTree } from "./helpers.js";

const sha = (c: string) => c.repeat(40);
const digest = (c: string) => c.repeat(64);
const turnDigest = digest("b");
const proposal = (head = sha("1")) => ({
  turnDigest, milestoneId: "milestone.choice-enacted",
  path: "milestones/choice-enacted.md", sourceEventSha: sha("a"),
  proposalDigest: digest(head[0]!), sourceSha: head, planVersion: 2,
});
function job(t: import("node:test").TestContext): JobStartResult {
  const stateDir = mkdtempSync(join(tmpdir(), "nt-prerequisite-repair-"));
  t.after(() => removeTestTree(stateDir));
  return { stateDir, jobId: "job-1", threadId: "thread-1" } as JobStartResult;
}
test("four independently rejected prerequisite cycles can converge without a fixed local limit", async t => {
  const j = job(t);
  const first = await admitPrerequisiteRepair(j, proposal());
  assert.equal((await admitPrerequisiteRepair(j, proposal())).id, first.id);
  for (let n = 1; n <= 4; n++) {
    const base = sha(String(n)), after = sha(String(n + 1));
    await admitPrerequisiteRepair(j, proposal(base));
    const submission = { turnDigest, id: first.id, sourceSha: base,
      submittedSha: after, paths: [first.path] };
    await submitPrerequisiteRepair(j, submission);
    await submitPrerequisiteRepair(j, submission);
    await settlePrerequisiteRepair(j, { turnDigest, id: first.id,
      submittedSha: after, reviewDigest: digest(String(n)),
      verdict: n === 4 ? "passed" : "failed" });
  }
  const saved = await inspectRepairLedger(j, turnDigest);
  assert.equal(totalTurnCorrections(saved), 4);
  assert.equal(saved.prerequisites?.[0]?.status, "resolved");
  assert.equal(saved.prerequisites?.[0]?.attempts.length, 4);
});

test("out-of-scope, unsettled and conflicting narrow correction is refused", async t => {
  const j = job(t);
  const finding = await admitPrerequisiteRepair(j, proposal());
  await assert.rejects(() => submitPrerequisiteRepair(j, { turnDigest, id: finding.id,
    sourceSha: sha("1"), submittedSha: sha("2"), paths: ["events/other.md"] }),
  /bounded authorized/);
  await submitPrerequisiteRepair(j, { turnDigest, id: finding.id,
    sourceSha: sha("1"), submittedSha: sha("2"), paths: [finding.path] });
  await assert.rejects(() => admitPrerequisiteRepair(j, proposal(sha("2"))), /Unsettled/);
  await assert.rejects(() => settlePrerequisiteRepair(j, { turnDigest, id: finding.id,
    submittedSha: sha("3"), reviewDigest: digest("4"), verdict: "passed" }), /no submitted/);
  await settlePrerequisiteRepair(j, { turnDigest, id: finding.id,
    submittedSha: sha("2"), reviewDigest: digest("4"), verdict: "passed" });
  assert.equal((await inspectRepairLedger(j, turnDigest)).prerequisites?.[0]?.status, "resolved");
});

test("later dependent revalidation preserves original assignment, not prior semantic issue labels", async t => {
  const j = job(t);
  const report = (sourceSha: string, reviewDigest: string, message: string) => ({
    turnDigest, rootFailureSha: sha("a"), sourceSha, causedBy: sourceSha,
    reviewDigest, assignmentId: "interactive",
    obligation: "Preserve the earlier Choice after Event correction.",
    findings: [{ path: "choice-points/reviewed.md", kind: "continuity" as const,
      message, affectedPaths: ["choice-points/reviewed.md"] }],
  });
  const first = await admitCausalRevalidationFinding(j,
    report(sha("c"), digest("d"), "Contradictory original payoff"));
  const saved = first.findings[0]!;
  assert.equal(saved.causedBy, sha("c"));
  await assert.rejects(() => admitCausalRevalidationFinding(j,
    report(sha("c"), digest("d"), "Another issue in same sealed review")),
  /Conflicting sealed review/);
  await submitRepairCorrection(j, { turnDigest, rootFailureSha: sha("a"),
    sourceSha: sha("c"), changedPaths: ["choice-points/reviewed.md"] });
  await settleRepairReview(j, {
    ...report(sha("c"), digest("e"), "A separately surfaced missing consequence"),
    successorSha: sha("b"), status: "failed",
  });
  const second = await admitCausalRevalidationFinding(j,
    report(sha("b"), digest("e"), "A separately surfaced missing consequence"));
  assert.equal(second.findings.filter(f => f.status === "open").length, 1);
  assert.notEqual(second.findings.at(-1)!.id, saved.id);
  await assert.rejects(() => admitCausalRevalidationFinding(j, {
    ...report(sha("b"), digest("e"), "A separately surfaced missing consequence"),
    assignmentId: "event",
  }), /originally assigned owner/);
});

test("dependency and ordinary correction submissions share accounting without a Turn count stop", async t => {
  const j = job(t);
  const prereq = await admitPrerequisiteRepair(j, proposal());
  await submitPrerequisiteRepair(j, { turnDigest, id: prereq.id, sourceSha: sha("1"),
    submittedSha: sha("2"), paths: [prereq.path] });
  await settlePrerequisiteRepair(j, { turnDigest, id: prereq.id,
    submittedSha: sha("2"), reviewDigest: digest("4"), verdict: "passed" });
  for (let n = 0; n < 12; n++) {
    const root = n.toString(16).padStart(40, "0");
    const path = "events/test-" + n + ".md";
    await admitRepairFinding(j, {
      turnDigest, rootFailureSha: root, sourceSha: root,
      reviewDigest: digest("e"), assignmentId: "event", obligation: "Real Event evidence",
      findings: [{ path, kind: "continuity",
        message: "Unfulfilled testimony", requiredCorrection: "Actual evidence" }],
    });
    await submitRepairCorrection(j, { turnDigest, rootFailureSha: root,
      sourceSha: root, changedPaths: [path] });
  }
  assert.equal(totalTurnCorrections(await inspectRepairLedger(j, turnDigest)), 13);
});
