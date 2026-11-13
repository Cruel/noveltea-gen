import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobStartResult } from "../src/job.js";
import { deliveryCriteria } from "../src/turn-delivery.js";
import { readTurnFulfillment, validateTurnFulfillment, type TurnFulfillmentPacket,
  type TurnFulfillmentVerdict } from "../src/turn-fulfillment.js";

const a = "a".repeat(40), b = "b".repeat(40), h = "c".repeat(64);
const contract = { scope: { kind: "partial" as const, depth: "composition" as const,
  targets: ["milestone.reveal", "milestone.choice"], branches: ["confess", "hide"] },
  constraints: ["The witness chooses whether to confess"],
  envelope: { presentation: "Dialogue-led mystery", hardLimits: [], preferences: [] } };
const criteria = deliveryCriteria("revision", contract);
const makePacket = (): TurnFulfillmentPacket => ({
  policy: "turn-completeness/v1",
  source: { jobId: "child", baseSha: a, headSha: b, turnDigest: h,
    planVersion: 2, planDigest: "d".repeat(64), scopeReviewDigest: "e".repeat(64),
    checkpoints: [{ commitSha: b, assignmentId: "event", proofDigest: "f".repeat(64),
      review: "passed", assignmentDigest: "0".repeat(64) }] },
  originalRequest: "A mystery with a witness reveal AND a meaningful branch choice",
  goal: "A mystery with a witness reveal AND a meaningful branch choice",
  contract, approvedContract: contract, criteria,
  objectives: [
    ...criteria.objectives,
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
  canonical: [
    { path: "arcs/archive.md", content: "Arc\nThe witness controls the archive." },
    { path: "milestones/reveal.md", content: "Milestone\nThe truth is uncovered." },
    { path: "events/reveal.md", content: "Reveal\nThe witness confesses." },
    { path: "authored-content/reveal.md", content: "Scene\nThe witness faces the player." },
  ],
  digest: h,
});
const evidence = () => [{ path: "events/reveal.md", line: 2, explanation: "Witness confession in canon." }];
const complete = (packet: TurnFulfillmentPacket): TurnFulfillmentVerdict => ({
  digest: packet.digest, verdict: "complete",
  checks: packet.objectives.map(o => ({ objectiveId: o.id, fulfilled: true,
    evidence: o.id === "delivery:architecture"
      ? [{ path: "milestones/reveal.md", line: 2, explanation: "Connected narrative Milestone." }]
      : ["delivery:composition", "delivery:complete-story", "delivery:payoff"].includes(o.id)
        ? [{ path: "authored-content/reveal.md", line: 2, explanation: "Player-facing scene." }]
        : evidence() })),
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

test("a complete verdict cannot substitute unrelated metadata or empty lines for delivery evidence", () => {
  const packet = makePacket();
  const completeVerdict = complete(packet);
  const replace = (id: string, path: string, line: number) => ({
    ...completeVerdict,
    checks: completeVerdict.checks.map(c => c.objectiveId === id ? {
      ...c, evidence: [{ path, line, explanation: "This is the delivery proof." }],
    } : c),
  });
  assert.throws(() => validateTurnFulfillment(packet,
    replace("delivery:architecture", "authored-content/reveal.md", 2)), /unsupported|stale/);
  assert.throws(() => validateTurnFulfillment(packet,
    replace("delivery:interactive", "arcs/archive.md", 2)), /unsupported|stale/);
  assert.throws(() => validateTurnFulfillment(packet,
    replace("delivery:composition", "milestones/reveal.md", 2)), /unsupported|stale/);
  assert.throws(() => validateTurnFulfillment(packet,
    replace("delivery:branch:0", "authored-content/reveal.md", 2)), /unsupported|stale/);
  assert.throws(() => validateTurnFulfillment(packet,
    replace("delivery:composition", "authored-content/reveal.md", 9)), /unsupported|stale/);
  const blankProse = { ...packet, canonical: packet.canonical.map(c =>
    c.path === "authored-content/reveal.md" ? { ...c, content: "Scene\\n\\nThe witness faces the player." } : c) };
  assert.throws(() => validateTurnFulfillment(blankProse, completeVerdict), /unsupported|stale/);
  assert.throws(() => validateTurnFulfillment(packet, {
    ...completeVerdict,
    checks: completeVerdict.checks.filter(c => c.objectiveId !== "delivery:interactive"),
  }), /unsupported|stale/);
  assert.throws(() => validateTurnFulfillment({
    ...packet, criteria: { ...packet.criteria, depth: "architecture" },
  }, completeVerdict), /unsupported|stale/);
});

test("an outlined branch has Arc/Milestone evidence without requiring an Event witness", () => {
  const packet = makePacket();
  const outlineContract = { ...contract, scope: { ...contract.scope, depth: "architecture" as const } };
  const outlineCriteria = deliveryCriteria("revision", outlineContract);
  const outline = { ...packet, contract: outlineContract, approvedContract: outlineContract,
    criteria: outlineCriteria, objectives: [...outlineCriteria.objectives,
      ...packet.objectives.filter(o => !o.id.startsWith("delivery:"))] };
  const verdict = complete(outline);
  verdict.checks = verdict.checks.map(c => c.objectiveId.startsWith("delivery:branch:")
    ? { ...c, evidence: [{ path: "milestones/reveal.md", line: 2, explanation: "Branch payoff is outlined." }] }
    : c);
  assert.equal(validateTurnFulfillment(outline, verdict).verdict, "complete");
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
