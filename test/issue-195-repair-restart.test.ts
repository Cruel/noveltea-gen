import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectCompletedRepairPiTurn } from "../src/rejected-review-repair.js";
import { admitRepairFinding, submitRepairCorrection, settleRepairReview,
  inspectRepairLedger } from "../src/repair-ledger.js";
import type { JobStartResult } from "../src/job.js";

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const line = (message: unknown) => JSON.stringify({ type: "message", message }) + "\n";
const begin = JSON.stringify({ type: "session", id: "original" }) + "\n" +
  line({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Prior work" }] });

test("completed original Pi repair is inspectable twice; interrupted provider calls never submit", async t => {
  const dir = await mkdtemp(join(tmpdir(), "nt-195-repair-pi-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "original.jsonl");
  const prefix = Buffer.from(begin);
  const digest = sha256(prefix);
  await writeFile(file, prefix);
  assert.equal(await inspectCompletedRepairPiTurn(file, prefix.length, digest), "incomplete");
  const turn = line({ role: "user", content: "Correct original failed assignment" }) +
    line({ role: "assistant", stopReason: "toolUse", content: [
      { type: "toolCall", name: "edit", id: "edit-1", arguments: { path: "events/clue.md" } }] }) +
    line({ role: "toolResult", toolCallId: "edit-1", content: [{ type: "text", text: "success" }] }) +
    line({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Corrected" }] });
  await writeFile(file, Buffer.concat([prefix, Buffer.from(turn)]));
  for (let restart = 0; restart < 2; restart++)
    assert.equal(await inspectCompletedRepairPiTurn(file, prefix.length, digest), "completed");
  await writeFile(file, Buffer.concat([prefix, Buffer.from(turn +
    line({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Unexpected second result" }] }))]));
  await assert.rejects(inspectCompletedRepairPiTurn(file, prefix.length, digest), /integrity-blocked/);
  await writeFile(file, Buffer.from("X" + begin.slice(1) + turn));
  await assert.rejects(inspectCompletedRepairPiTurn(file, prefix.length, digest), /integrity-blocked/);
});

test("exact Repair finding, submission, and independent verdict remain idempotent across two resumes", async t => {
  const stateDir = await mkdtemp(join(tmpdir(), "nt-195-repair-ledger-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const job = { jobId: "repair-job", threadId: "repair-thread", stateDir } as JobStartResult;
  const original = "a".repeat(40), successor = "b".repeat(40);
  const turnDigest = "c".repeat(64), reviewDigest = "d".repeat(64);
  const finding = { path: "events/clue.md", kind: "continuity" as const,
    message: "Player knows clue before seeing it",
    requiredCorrection: "Add the visible clue before the inference" };
  const admitted = {
    turnDigest, rootFailureSha: original, sourceSha: original, reviewDigest,
    assignmentId: "event-clue", obligation: "Clue is witnessed before inference",
    findings: [finding],
  };
  const submitted = {
    turnDigest, rootFailureSha: original, sourceSha: original,
    changedPaths: ["events/clue.md"],
  };
  const reviewed = {
    ...admitted, successorSha: successor, reviewDigest: "e".repeat(64),
    findings: [] as typeof admitted.findings, status: "passed" as const,
  };
  await admitRepairFinding(job, admitted);
  await submitRepairCorrection(job, submitted);
  // Crash after ledger commit but before parent Repair receipt changes phase.
  await settleRepairReview(job, reviewed);
  for (let restart = 0; restart < 2; restart++) {
    await submitRepairCorrection(job, submitted);
    await settleRepairReview(job, reviewed);
    const ledger = await inspectRepairLedger(job, turnDigest);
    assert.equal(ledger.corrections.length, 1);
    assert.equal(ledger.findings.length, 1);
    assert.deepEqual(ledger.findings[0]!.attempts, [original]);
    assert.equal(ledger.findings[0]!.status, "resolved");
  }
  assert.match(await readFile(join(stateDir, "repair-ledgers", turnDigest + ".json"), "utf8"),
    /"passed"/);
});
