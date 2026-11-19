import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JobStartResult } from "../src/job.js";
import { admitRepairFinding, inspectRepairLedger, submitRepairCorrection,
  settleRepairReview, type RepairFindingInput } from "../src/repair-ledger.js";
import { removeTestTree } from "./helpers.js";

const sha = (char: string) => char.repeat(40);
const digest = (char: string) => char.repeat(64);
const turnDigest = digest("a");
const original = sha("1");
const assignmentId = "event";
const finding = (message = "The witness is missing", path = "events/absence.md"): RepairFindingInput => ({
  path, kind: "continuity", affectedPaths: [path],
  message, requiredCorrection: "Provide an actual witness account before the inference.",
});

function fixture(t: import("node:test").TestContext) {
  const stateDir = mkdtempSync(join(tmpdir(), "nt-repair-ledger-"));
  t.after(() => removeTestTree(stateDir));
  return { stateDir, jobId: "job-1", threadId: "thread-1" } as JobStartResult;
}
const source = (rootFailureSha = original, sourceSha = original) => ({
  turnDigest, rootFailureSha, sourceSha, reviewDigest: digest("b"),
  assignmentId, obligation: "Create an evidence-backed Event", findings: [finding()],
});

test("a paraphrased failed rereview retains one finding and two completed corrections exhaust it", async t => {
  const job = fixture(t);
  const first = await admitRepairFinding(job, source());
  assert.equal(first.findings.length, 1);
  assert.equal(first.findings[0]!.attempts.length, 0);
  await submitRepairCorrection(job, { turnDigest, rootFailureSha: original, sourceSha: original,
    changedPaths: ["events/absence.md"] });
  await settleRepairReview(job, { ...source(), reviewDigest: digest("c"), successorSha: sha("2"),
    status: "failed", findings: [finding("Still no identified witness")] });
  const second = await admitRepairFinding(job, { ...source(original, sha("2")),
    reviewDigest: digest("c"), findings: [finding("Nowhere is a witness actually identified")] });
  assert.equal(second.findings[0]!.id, first.findings[0]!.id);
  assert.equal(second.corrections.length, 1);
  await submitRepairCorrection(job, { turnDigest, rootFailureSha: original, sourceSha: sha("2"),
    changedPaths: ["events/absence.md"] });
  await settleRepairReview(job, { ...source(original, sha("2")), reviewDigest: digest("d"),
    successorSha: sha("3"), status: "failed", findings: [finding("Unresolved source")] });
  await assert.rejects(() => admitRepairFinding(job, { ...source(original, sha("3")),
    reviewDigest: digest("d") }), /Local corrections exhausted/);
  const saved = await inspectRepairLedger(job, turnDigest);
  assert.equal(saved.corrections.length, 2);
  assert.equal(saved.findings[0]!.attempts.length, 2);
});

test("incomplete calls do not count and idempotent submitted corrections count once across rereads", async t => {
  const job = fixture(t);
  await admitRepairFinding(job, source());
  assert.equal((await inspectRepairLedger(job, turnDigest)).corrections.length, 0);
  const data = { turnDigest, rootFailureSha: original, sourceSha: original,
    changedPaths: ["events/absence.md"] };
  await submitRepairCorrection(job, data);
  await submitRepairCorrection(job, data);
  assert.equal((await inspectRepairLedger(job, turnDigest)).corrections.length, 1);
  await assert.rejects(() => submitRepairCorrection(job, { ...data, changedPaths: ["events/other.md"] }),
    /conflicting submission/);
});

test("splitting a finding into two same-shape reviewer claims never resets the correction allowance", async t => {
  const job = fixture(t);
  await admitRepairFinding(job, source());
  await submitRepairCorrection(job, { turnDigest, rootFailureSha: original, sourceSha: original,
    changedPaths: ["events/absence.md"] });
  const repeated = [finding("Witness never appears"), finding("No witnessed timestamp is supplied")];
  await settleRepairReview(job, { ...source(), reviewDigest: digest("c"),
    successorSha: sha("2"), status: "failed", findings: repeated });
  const pending = await admitRepairFinding(job, { ...source(original, sha("2")),
    reviewDigest: digest("c"), findings: repeated });
  assert.equal(pending.findings.length, 1);
  assert.equal(pending.findings[0]!.attempts.length, 1);
  await submitRepairCorrection(job, { turnDigest, rootFailureSha: original, sourceSha: sha("2"),
    changedPaths: ["events/absence.md"] });
  await settleRepairReview(job, { ...source(original, sha("2")), reviewDigest: digest("d"),
    successorSha: sha("3"), status: "failed", findings: [finding("Same unresolved obligation")] });
  await assert.rejects(() => admitRepairFinding(job, { ...source(original, sha("3")),
    reviewDigest: digest("d") }), /Local corrections exhausted/);
});

test("new downstream finding has distinct causal identity; unrelated completed work remains untouched", async t => {
  const job = fixture(t);
  const first = await admitRepairFinding(job, source());
  await submitRepairCorrection(job, { turnDigest, rootFailureSha: original, sourceSha: original,
    changedPaths: ["events/absence.md"] });
  const other = finding("The correction introduces a contradictory Event", "events/other.md");
  await settleRepairReview(job, { ...source(), successorSha: sha("2"), status: "failed",
    findings: [other] });
  const ledger = await inspectRepairLedger(job, turnDigest);
  assert.equal(ledger.findings.length, 2);
  assert.equal(ledger.findings[0]!.status, "resolved");
  assert.equal(ledger.findings[1]!.causedBy, original);
  assert.notEqual(ledger.findings[1]!.id, first.findings[0]!.id);
  assert.equal(ledger.corrections.length, 1);
});

test("Turn ceiling covers independent roots without changing their separate local limits", async t => {
  const job = fixture(t);
  for (let i = 0; i < 12; i++) {
    const root = i.toString(16).padStart(40, "0");
    await admitRepairFinding(job, { ...source(root, root), findings: [finding("Missing witness", `events/e${i}.md`)] });
    await submitRepairCorrection(job, { turnDigest, rootFailureSha: root, sourceSha: root,
      changedPaths: [`events/e${i}.md`] });
  }
  const next = sha("f");
  await assert.rejects(() => admitRepairFinding(job, { ...source(next, next),
    findings: [finding("Missing witness", "events/last.md")] }), /Turn correction ceiling/);
  assert.equal((await inspectRepairLedger(job, turnDigest)).corrections.length, 12);
});
