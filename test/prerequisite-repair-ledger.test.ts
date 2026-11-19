import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JobStartResult } from "../src/job.js";
import { admitPrerequisiteRepair, inspectRepairLedger, MAX_DEPENDENCY_CYCLES,
  settlePrerequisiteRepair, submitPrerequisiteRepair,
  admitRepairFinding, admitCausalRevalidationFinding, submitRepairCorrection,
  totalTurnCorrections } from "../src/repair-ledger.js";
import { removeTestTree } from "./helpers.js";
const sha = (c: string) => c.repeat(40);
const digest = (c: string) => c.repeat(64);
const turnDigest = digest("b");
const proposal = (head = sha("1")) => ({
  turnDigest, milestoneId: "milestone.choice-enacted",
  path: "milestones/choice-enacted.md", sourceEventSha: sha("a"),
  proposalDigest: digest(head[0]!), sourceSha: head, planVersion: 2,
});
function job(t: import("node:test").TestContext) {
  const stateDir = mkdtempSync(join(tmpdir(), "nt-prerequisite-repair-"));
  t.after(() => removeTestTree(stateDir));
  return { stateDir, jobId: "job-1", threadId: "thread-1" } as JobStartResult;
}
test("a preflight finding retains identity through three rejected cycles and blocks a fourth", async t => {
  const j = job(t);
  const first = await admitPrerequisiteRepair(j, proposal());
  assert.equal((await admitPrerequisiteRepair(j, proposal())).id, first.id);
  for (let n = 1; n <= MAX_DEPENDENCY_CYCLES; n++) {
    const base = sha(String(n)), after = sha(String(n + 1));
    await admitPrerequisiteRepair(j, proposal(base));
    const submission = { turnDigest, id: first.id, sourceSha: base,
      submittedSha: after, paths: [first.path] };
    await submitPrerequisiteRepair(j, submission);
    await submitPrerequisiteRepair(j, submission);
    await settlePrerequisiteRepair(j, { turnDigest, id: first.id,
      submittedSha: after, reviewDigest: digest(String(n)), verdict: "failed" });
  }
  assert.equal(totalTurnCorrections(await inspectRepairLedger(j, turnDigest)), 3);
  await assert.rejects(() => admitPrerequisiteRepair(j, proposal(sha("4"))),
    /Dependency repair cycles exhausted/);
  assert.equal((await inspectRepairLedger(j, turnDigest)).prerequisites?.[0]?.attempts.length, 3);
});
test("out-of-scope, unsettled, conflicting and exhausted corrections fail closed", async t => {
  const j = job(t);
  const finding = await admitPrerequisiteRepair(j, proposal());
  await assert.rejects(() => submitPrerequisiteRepair(j, { turnDigest, id: finding.id,
    sourceSha: sha("1"), submittedSha: sha("2"), paths: ["events/other.md"] }), /bounded authorized/);
  await submitPrerequisiteRepair(j, { turnDigest, id: finding.id,
    sourceSha: sha("1"), submittedSha: sha("2"), paths: [finding.path] });
  await assert.rejects(() => admitPrerequisiteRepair(j, proposal(sha("2"))), /Unsettled/);
  await assert.rejects(() => settlePrerequisiteRepair(j, { turnDigest, id: finding.id,
    submittedSha: sha("3"), reviewDigest: digest("4"), verdict: "passed" }), /no submitted/);
  await settlePrerequisiteRepair(j, { turnDigest, id: finding.id,
    submittedSha: sha("2"), reviewDigest: digest("4"), verdict: "passed" });
  assert.equal((await inspectRepairLedger(j, turnDigest)).prerequisites?.[0]?.status, "resolved");
});
test("a newly discovered downstream defect inherits the same Turn budget and causal predecessor", async t => {
  const j = job(t);
  const report = (message: string, sourceSha = sha("c"), path = "choice-points/reviewed.md") => ({
    turnDigest, rootFailureSha: sha("a"), sourceSha, causedBy: sourceSha,
    reviewDigest: digest("d"), assignmentId: "interactive",
    obligation: "Preserve the earlier reviewed Choice after Event correction.",
    findings: [{ path, kind: "continuity" as const, message,
      affectedPaths: [path] }],
  });
  const first = await admitCausalRevalidationFinding(j, report("After correction, payoff contradicts Choice"));
  const old = first.findings[0]!;
  assert.equal(old.causedBy, sha("c"));
  const again = await admitCausalRevalidationFinding(j, report("Choice payoff remains impossible"));
  assert.equal(again.findings.length, 1);
  assert.equal(again.findings[0]!.id, old.id);
  assert.equal(totalTurnCorrections(again), 0);
  await submitRepairCorrection(j, { turnDigest, rootFailureSha: sha("a"),
    sourceSha: sha("c"), changedPaths: ["choice-points/reviewed.md"] });
  assert.equal(totalTurnCorrections(await inspectRepairLedger(j, turnDigest)), 1);
  const rephrased = await admitCausalRevalidationFinding(j, {
    ...report("A second source revision still fails", sha("b")),
    reviewDigest: digest("e"),
  });
  assert.equal(rephrased.findings.length, 1);
  assert.equal(rephrased.findings[0]!.id, old.id);
  assert.equal(rephrased.findings[0]!.causedBy, sha("c"),
    "Original causal predecessor is immutable even after later source changes.");
  await assert.rejects(() => admitCausalRevalidationFinding(j, {
    ...report("Moved owner"), assignmentId: "event",
  }), /originally assigned owner/);
});
test("dependency and original-session corrections consume the same 12-attempt Turn budget", async t => {
  const j = job(t);
  const finding = await admitPrerequisiteRepair(j, proposal());
  await submitPrerequisiteRepair(j, { turnDigest, id: finding.id,
    sourceSha: sha("1"), submittedSha: sha("2"), paths: [finding.path] });
  await settlePrerequisiteRepair(j, { turnDigest, id: finding.id,
    submittedSha: sha("2"), reviewDigest: digest("4"), verdict: "passed" });
  for (let n = 0; n < 11; n++) {
    const root = n.toString(16).padStart(40, "0");
    await admitRepairFinding(j, {
      turnDigest, rootFailureSha: root, sourceSha: root,
      reviewDigest: digest("e"), assignmentId: "event", obligation: "Real Event evidence",
      findings: [{ path: `events/test-${n}.md`, kind: "continuity",
        message: "Unfulfilled testimony", requiredCorrection: "Actual evidence" }],
    });
    await submitRepairCorrection(j, { turnDigest, rootFailureSha: root, sourceSha: root,
      changedPaths: [`events/test-${n}.md`] });
  }
  assert.equal(totalTurnCorrections(await inspectRepairLedger(j, turnDigest)), 12);
  await assert.rejects(() => admitRepairFinding(j, {
    turnDigest, rootFailureSha: sha("f"), sourceSha: sha("f"),
    reviewDigest: digest("e"), assignmentId: "event", obligation: "Real Event evidence",
    findings: [{ path: "events/last.md", kind: "continuity",
      message: "Missing", requiredCorrection: "Correct it" }],
  }), /Turn correction ceiling/);
});
