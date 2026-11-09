import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobStartResult } from "../src/job.js";
import { readTurnFulfillment, validateTurnFulfillment, type TurnFulfillmentPacket,
  type TurnFulfillmentVerdict } from "../src/turn-fulfillment.js";

const a = "a".repeat(40), b = "b".repeat(40), h = "c".repeat(64);
const makePacket = (): TurnFulfillmentPacket => ({
  policy: "turn-completeness/v1",
  source: { jobId: "child", baseSha: a, headSha: b, turnDigest: h,
    planVersion: 2, planDigest: "d".repeat(64), scopeReviewDigest: "e".repeat(64),
    checkpoints: [{ commitSha: b, assignmentId: "event", proofDigest: "f".repeat(64),
      review: "passed", assignmentDigest: "0".repeat(64) }] },
  originalRequest: "A mystery with a witness reveal AND a meaningful branch choice",
  goal: "A mystery with a witness reveal AND a meaningful branch choice",
  contract: { scope: { kind: "partial", depth: "composition",
    targets: ["milestone.reveal", "milestone.choice"], branches: ["confess", "hide"] },
    constraints: ["The witness chooses whether to confess"],
    envelope: { presentation: "Dialogue-led mystery", hardLimits: [], preferences: [] } },
  objectives: [
    { id: "goal", text: "A mystery with a witness reveal AND a meaningful branch choice" },
    { id: "constraint:0", text: "The witness chooses whether to confess" },
    { id: "presentation", text: "Dialogue-led mystery" },
    { id: "assignment:event", text: "Deliver a reveal" },
    { id: "assignment:interactive", text: "Deliver an actual choice" },
  ],
  plannedWork: [
    { id: "event:milestone.reveal", kind: "realization", targets: ["milestone.reveal"], status: "verified" },
    { id: "interactive:milestone.choice", kind: "realization", targets: ["milestone.choice"], status: "verified" },
  ],
  canonical: [{ path: "events/reveal.md", content: "Reveal\nThe witness confesses." }],
  digest: h,
});
const evidence = () => [{ path: "events/reveal.md", line: 2, explanation: "Witness confession in canon." }];
const complete = (packet: TurnFulfillmentPacket): TurnFulfillmentVerdict => ({
  digest: packet.digest, verdict: "complete",
  checks: packet.objectives.map(o => ({ objectiveId: o.id, fulfilled: true, evidence: evidence() })),
  findings: [],
});
const missed = (packet: TurnFulfillmentPacket): TurnFulfillmentVerdict => ({
  ...complete(packet), verdict: "incomplete",
  checks: complete(packet).checks.map(c => c.objectiveId === "goal"
    ? { ...c, fulfilled: false, evidence: [] } : c),
  findings: [{ objectiveId: "goal", message: "The alternate choice was never realized.",
    followUp: { assignmentId: "interactive", outcome: "Add the meaningful branch choice",
      targets: ["milestone.choice"] } }],
});

test("all successful assignments and native evidence cannot conceal a missed Turn-level goal", () => {
  const packet = makePacket();
  const missing = validateTurnFulfillment(packet, missed(packet));
  assert.equal(missing.verdict, "incomplete");
  assert.equal(missing.findings[0]!.followUp?.assignmentId, "interactive");
  assert.throws(() => validateTurnFulfillment(packet, {
    ...missed(packet), verdict: "complete" }), /unsupported|stale/);
  assert.throws(() => validateTurnFulfillment(packet, {
    ...complete(packet), checks: complete(packet).checks.filter(c => c.objectiveId !== "goal"),
  }), /unsupported|stale/, "the evaluator cannot omit the original requested outcome");
});

test("a fulfilled Turn receives a separate semantic verdict with canonical witnesses", () => {
  const packet = makePacket();
  assert.equal(validateTurnFulfillment(packet, complete(packet)).verdict, "complete");
  assert.throws(() => validateTurnFulfillment(packet, {
    ...complete(packet), checks: complete(packet).checks.map(c =>
      c.objectiveId === "assignment:interactive" ? { ...c, evidence: [] } : c),
  }), /unsupported|stale/, "bare validator success is not plan-level assurance");
});

test("unapproved follow-up scope, forged file witnesses and stale input are rejected", () => {
  const packet = makePacket(), missing = missed(packet);
  assert.throws(() => validateTurnFulfillment(packet, {
    ...missing, digest: "9".repeat(64) }), /unsupported|stale/);
  assert.throws(() => validateTurnFulfillment(packet, {
    ...missing, findings: [{ ...missing.findings[0]!, followUp: {
      assignmentId: "unplanned-specialist", outcome: "Rewrite all canon",
      targets: ["milestone.choice"] } }] }), /unsupported|stale/);
  assert.throws(() => validateTurnFulfillment(packet, {
    ...missing, findings: [{ ...missing.findings[0]!, followUp: {
      assignmentId: "interactive", outcome: "Write an unapproved Milestone",
      targets: ["milestone.unapproved"] } }] }), /unsupported|stale/);
  assert.throws(() => validateTurnFulfillment(packet, {
    ...complete(packet), checks: complete(packet).checks.map(c => ({
      ...c, evidence: [{ path: "events/unrelated.md", line: 12, explanation: "Not in the packet" }] })),
  }), /unsupported|stale/);
  assert.throws(() => validateTurnFulfillment(packet, {
    ...complete(packet), checks: complete(packet).checks.map(c => ({
      ...c, evidence: [{ path: "events/reveal.md", line: 900, explanation: "Nonexistent line" }] })),
  }), /unsupported|stale/);
});

test("final plan-level receipt survives restart; altered source, policy or reviewer status fail closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nt-plan-fulfillment-"));
  const packet = makePacket();
  try {
    mkdirSync(join(dir, "turn-fulfillment"));
    const file = join(dir, "turn-fulfillment", packet.digest + ".json");
    const job = { stateDir: dir } as JobStartResult;
    assert.equal(await readTurnFulfillment(job, packet), null);
    const record = { version: 1, policy: packet.policy, source: packet.source,
      packetDigest: packet.digest, phase: "completed", reviewer: "independent-plan-review",
      verdict: missed(packet) };
    const write = (value: unknown) => writeFileSync(file, JSON.stringify(value));
    write(record);
    assert.equal((await readTurnFulfillment(job, packet))?.verdict?.verdict, "incomplete");
    assert.equal((await readTurnFulfillment({ ...job }, packet))?.verdict?.findings.length, 1);
    write({ ...record, source: { ...record.source, planVersion: 3 } });
    await assert.rejects(readTurnFulfillment(job, packet), /stale|unauthoritative/);
    write({ ...record, policy: "assignment-fidelity/v1" });
    await assert.rejects(readTurnFulfillment(job, packet), /stale|unauthoritative/);
    write({ ...record, verdict: { ...complete(packet), digest: "0".repeat(64) } });
    await assert.rejects(readTurnFulfillment(job, packet), /unsupported|stale/);
    write({ ...record, phase: "reviewing", verdict: undefined });
    assert.equal((await readTurnFulfillment(job, packet))?.phase, "reviewing",
      "an interrupted evaluator must never be retried or mistaken for success");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
