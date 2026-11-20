import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JobStartResult } from "../src/job.js";
import { admitRepairFinding, inspectRepairLedger, submitRepairCorrection,
  settleRepairReview, authorizeRepairGuidance, totalTurnCorrections,
  localCorrectionLimit, turnCorrectionLimit, type RepairFindingInput } from "../src/repair-ledger.js";
import { removeTestTree } from "./helpers.js";

const sha = (char: string) => char.repeat(40);
const digest = (char: string) => char.repeat(64);
const turnDigest = digest("a");
const original = sha("1");
const finding = (message = "Missing independent witness", path = "events/absence.md"): RepairFindingInput =>
  ({ path, kind: "continuity", affectedPaths: [path], message,
    requiredCorrection: "Identify the witness without inventing a source." });
function fixture(t: import("node:test").TestContext): JobStartResult {
  const stateDir = mkdtempSync(join(tmpdir(), "nt-repair-ledger-"));
  t.after(() => removeTestTree(stateDir));
  return { stateDir, jobId: "job-1", threadId: "thread-1" } as JobStartResult;
}
const source = (sourceSha = original, reviewDigest = digest("b"),
  findings: RepairFindingInput[] = [finding()], rootFailureSha = original) => ({
  turnDigest, rootFailureSha, sourceSha, reviewDigest, assignmentId: "event",
  obligation: "Create an evidence-backed Event", findings,
});
const submit = (job: JobStartResult, sourceSha: string, rootFailureSha = original) =>
  submitRepairCorrection(job, { turnDigest, rootFailureSha, sourceSha,
    changedPaths: ["events/absence.md"] });

test("four completed independently reviewed revisions retain separate findings rather than stop at two", async t => {
  const job = fixture(t);
  let current = original;
  await admitRepairFinding(job, source());
  for (let i = 0; i < 4; i++) {
    await submit(job, current);
    const next = sha(String(i + 2));
    const findings = [finding("Issue observed in round " + i)];
    const failed = i < 3;
    await settleRepairReview(job, {
      ...source(current, digest(String(i + 2)), failed ? findings : []),
      successorSha: next, status: failed ? "failed" : "passed",
    });
    if (failed) await admitRepairFinding(job, source(next, digest(String(i + 2)), findings));
    current = next;
  }
  const ledger = await inspectRepairLedger(job, turnDigest);
  assert.equal(totalTurnCorrections(ledger), 4);
  assert.equal(ledger.findings.length, 4);
  assert.equal(ledger.findings.every(f => f.status === "resolved"), true);
  assert.deepEqual(ledger.findings.map(f => f.attempts.length), [1, 1, 1, 1]);
  assert.equal(new Set(ledger.findings.map(f => f.id)).size, 4);
});

test("authenticated author steering is source-bound and idempotent, not an ordinary repair allowance", async t => {
  const job = fixture(t);
  await admitRepairFinding(job, source());
  await submit(job, original);
  await settleRepairReview(job, {
    ...source(original, digest("c"), [finding("Still unresolved")]),
    successorSha: sha("2"), status: "failed",
  });
  const request = { turnDigest, rootFailureSha: original, sourceSha: original,
    headSha: sha("2"), authorId: "owner-1",
    guidance: "Identify the original witness in the authorized Event only." };
  for (let retry = 0; retry < 2; retry++) {
    const grant = await authorizeRepairGuidance(job, request);
    assert.equal(grant.headSha, sha("2"));
    assert.equal(grant.localLimit, 3, "legacy grant metadata stays inspectable");
    assert.equal(grant.turnLimit, 13);
  }
  const ledger = await inspectRepairLedger(job, turnDigest);
  assert.equal(ledger.authorGrants?.length, 1);
  assert.equal(localCorrectionLimit(ledger, original), 3);
  assert.equal(turnCorrectionLimit(ledger), 13);
  await admitRepairFinding(job, source(sha("2"), digest("c"), [finding("Still unresolved")]));
  await submit(job, sha("2"));
  await assert.rejects(() => authorizeRepairGuidance(job, request),
    /exact independently rejected|previously authorized correction has already been submitted/);
  assert.equal((await inspectRepairLedger(job, turnDigest)).corrections.length, 2);
});

test("author steering requires settled exact rejected source and never an unsettled writer", async t => {
  const job = fixture(t);
  await admitRepairFinding(job, source());
  const request = { turnDigest, rootFailureSha: original, sourceSha: original,
    headSha: sha("2"), authorId: "owner-1", guidance: "Correct cited witness." };
  await assert.rejects(() => authorizeRepairGuidance(job, request), /exact independently rejected/);
  await submit(job, original);
  await assert.rejects(() => authorizeRepairGuidance(job, request), /exact independently rejected/);
  await settleRepairReview(job, { ...source(original, digest("c"), [finding("Still unresolved")]),
    successorSha: sha("2"), status: "failed" });
  await assert.rejects(() => authorizeRepairGuidance(job, { ...request, headSha: sha("3") }),
    /exact independently rejected/);
  await assert.rejects(() => authorizeRepairGuidance(job, {
    ...request, guidance: "unsafe\nchange" }), /Invalid bounded author guidance/);
  assert.equal((await authorizeRepairGuidance(job, request)).sourceSha, original);
});

test("submitted correction is idempotent and a conflicting replay fails closed", async t => {
  const job = fixture(t);
  await admitRepairFinding(job, source());
  const first = await submit(job, original);
  const again = await submit(job, original);
  assert.deepEqual(again, first);
  assert.equal(again.corrections.length, 1);
  await assert.rejects(() => submitRepairCorrection(job, {
    turnDigest, rootFailureSha: original, sourceSha: original,
    changedPaths: ["events/unrelated.md"],
  }), /conflicting submission/);
  await assert.rejects(() => submitRepairCorrection(job, {
    turnDigest, rootFailureSha: original, sourceSha: sha("2"),
    changedPaths: ["events/absence.md"],
  }), /no admitted sealed finding/);
});

test("same path/category distinct current reviewer issues remain independently indexed", async t => {
  const job = fixture(t);
  await admitRepairFinding(job, source());
  await submit(job, original);
  const newFindings = [finding("No witness"), finding("No independently dated entry")];
  await settleRepairReview(job, { ...source(original, digest("c"), newFindings),
    successorSha: sha("2"), status: "failed" });
  const saved = await admitRepairFinding(job, source(sha("2"), digest("c"), newFindings));
  assert.equal(saved.findings.length, 3);
  const active = saved.findings.filter(f => f.status === "open");
  assert.equal(active.length, 2);
  assert.deepEqual(active.map(f => f.findingIndex), [0, 1]);
  assert.notEqual(active[0]!.id, active[1]!.id);
  await assert.rejects(() => admitRepairFinding(job,
    source(sha("2"), digest("c"), [finding("Unsealed alternate claim")])),
  /Conflicting sealed review/);
});

test("new causal defect does not reopen an unrelated completed finding", async t => {
  const job = fixture(t);
  const first = await admitRepairFinding(job, source());
  await submit(job, original);
  const introduced = finding("A new contradictory consequence", "events/other.md");
  await settleRepairReview(job, { ...source(original, digest("c"), [introduced]),
    successorSha: sha("2"), status: "failed" });
  const saved = await inspectRepairLedger(job, turnDigest);
  assert.equal(saved.findings.length, 2);
  assert.equal(saved.findings[0]!.status, "resolved");
  assert.equal(saved.findings[1]!.causedBy, original);
  assert.notEqual(saved.findings[1]!.id, first.findings[0]!.id);
});

test("historical v1 same-file findings and attempts remain usable without rewriting legacy IDs", async t => {
  const job = fixture(t);
  const recorded = await admitRepairFinding(job, source());
  const file = join(job.stateDir, "repair-ledgers", turnDigest + ".json");
  const legacy = structuredClone(recorded);
  const priorId = digest("e");
  legacy.findings[0]!.id = priorId;
  delete legacy.findings[0]!.findingIndex;
  delete legacy.findings[0]!.reviewFindingsDigest;
  writeFileSync(file, JSON.stringify(legacy));
  assert.equal((await inspectRepairLedger(job, turnDigest)).findings[0]!.id, priorId);
  await submit(job, original);
  await settleRepairReview(job, { ...source(original, digest("c"),
    [finding("A newly surfaced issue")]), successorSha: sha("2"), status: "failed" });
  const restored = await inspectRepairLedger(job, turnDigest);
  assert.equal(restored.findings[0]!.id, priorId);
  assert.equal(restored.findings[0]!.status, "resolved");
  assert.equal(restored.findings[1]!.findingIndex, 0);
  await admitRepairFinding(job, source(sha("2"), digest("c"),
    [finding("A newly surfaced issue")]));
  assert.equal((await inspectRepairLedger(job, turnDigest)).corrections.length, 1);
});

test("a tampered indexed observation cannot exchange its sealed identity", async t => {
  const job = fixture(t);
  await admitRepairFinding(job, source(original, digest("b"),
    [finding("First defect"), finding("Second defect")]));
  const file = join(job.stateDir, "repair-ledgers", turnDigest + ".json");
  const saved = JSON.parse(readFileSync(file, "utf8")) as Awaited<ReturnType<typeof inspectRepairLedger>>;
  saved.findings[0]!.findingIndex = 1;
  writeFileSync(file, JSON.stringify(saved));
  await assert.rejects(() => inspectRepairLedger(job, turnDigest),
    /Repair ledger identity/);
});

test("thirteen independent source corrections do not exhaust a Turn semantic ceiling", async t => {
  const job = fixture(t);
  for (let i = 0; i < 13; i++) {
    const root = i.toString(16).padStart(40, "0");
    const path = "events/round-" + i + ".md";
    await admitRepairFinding(job, source(root, digest("b"),
      [finding("Missing witness", path)], root));
    await submitRepairCorrection(job, { turnDigest, rootFailureSha: root,
      sourceSha: root, changedPaths: [path] });
  }
  const ledger = await inspectRepairLedger(job, turnDigest);
  assert.equal(ledger.corrections.length, 13);
  assert.equal(totalTurnCorrections(ledger), 13);
});
