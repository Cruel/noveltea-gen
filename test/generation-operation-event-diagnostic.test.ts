/** C03: a genuinely settled Event no-write report reaches an original-case
 * diagnostic, rather than disappearing into a bare blocked inventory. This
 * constructs source-bound Pi and Git fixtures and tests the production
 * selector's independent receipt authentication (not a fake writer grant). */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { eventPrerequisiteReportDigest } from "../src/event-prerequisite-auth.js";
import { selectOperationStrategy, authenticateOperationDiagnosticProof,
  diagnosticCaseForDecision } from "../src/generation-operation-strategy.js";
import { recoveryCaseId } from "../src/generation-recovery-lifecycle.js";
import type { RecoveryCase, RecoveryOrigin } from "../src/generation-recovery-contract.js";
import type { GenerationGraphState } from "../src/generation.js";
import type { GenerationOperationRecovery } from "../src/generation-operation-recovery.js";
import type { JobStartResult } from "../src/job.js";
import { removeTestTree } from "./helpers.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
function git(root: string, ...args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nt-c03-event-no-write-"));
  const repo = join(root, "repo"), story = join(repo, "story");
  const stateDir = join(root, "state"), milestoneId = "milestone.disclosure";
  const assignmentId = "event:" + milestoneId;
  mkdirSync(story, { recursive: true }); mkdirSync(stateDir);
  writeFileSync(join(story, "source.md"), "Previously verified original source.\n");
  git(repo, "init", "-q"); git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.test");
  git(repo, "add", "."); git(repo, "commit", "-qm", "Verified Story source");
  const head = git(repo, "rev-parse", "HEAD"), turnDigest = "a".repeat(64);
  const job = { jobId: "c03-event-no-write", threadId: "c03-event-original",
    baseSha: head, stateDir, worktreeRoot: repo, worktreeStoryRoot: story,
    storyRoot: story, storyRelativePath: "story" } as JobStartResult;
  const workItemId = "event-disclosure";
  const sessionDir = join(stateDir, "event-sessions", workItemId);
  mkdirSync(sessionDir, { recursive: true });
  const sessionFile = join(sessionDir, "original.jsonl");
  const sessionId = "original-event-pi";
  const transcript = JSON.stringify({ type: "session", id: sessionId }) + "\n" +
    JSON.stringify({ type: "message", message: { role: "assistant",
      stopReason: "stop", content: [{ type: "text",
        text: "No Story write: protected evidence remains unavailable." }] } }) + "\n";
  writeFileSync(sessionFile, transcript);
  const assignment = { id: assignmentId, milestoneId };
  const snapshotId = "b".repeat(64), planDigest = "c".repeat(64);
  const conflicts = ["The witness cannot establish the missing Event evidence."];
  const payload = { jobId: job.jobId, workItemId, expectedHead: head,
    planDigest, sessionSha256: sha(transcript), sessionId,
    assignmentDigest: sha(JSON.stringify(assignment)), snapshotId,
    sessionFile, worker: "pi" as const, conflicts, obligations: [] };
  const reportDigest = eventPrerequisiteReportDigest(payload);
  const receipt = { version: 1, jobId: job.jobId, phase: "prerequisite-reported",
    workItemId, milestoneId, planVersion: 2, worker: "pi",
    expectedHead: head, planDigest, assignment, snapshot: { id: snapshotId },
    sessionFile, claimedPaths: [], conflicts, obligations: [],
    prerequisite: { expectedHead: head, sessionSha256: sha(transcript), sessionId,
      assignmentDigest: payload.assignmentDigest, snapshotId, sessionFile,
      worker: "pi", reportDigest } };
  const receiptDir = join(stateDir, "event-items");
  mkdirSync(receiptDir);
  const receiptFile = join(receiptDir, "disclosure.json");
  writeFileSync(receiptFile, JSON.stringify(receipt) + "\n");
  const graphThreadId = job.threadId + ":generation";
  const origin: RecoveryOrigin = { jobId: job.jobId, jobThreadId: job.threadId,
    graphThreadId, turnDigest, planVersion: 2, sourceHeadSha: head,
    assignmentId, operation: "specialist-result", check: "specialist-result.v1",
    checkVersion: 1, failureAnchor: { store: "graph-checkpoint",
      ref: graphThreadId + ":original-failed-task",
      failedCheckInstanceId: "f0352734-619a-4d1a-a515-8ddf75aa2c14" } };
  const c: RecoveryCase = { schema: "noveltea-generation-recovery-case/v1",
    id: recoveryCaseId(origin), origin, kind: "semantic", observation: "returned-failure",
    effect: "writer-effects-uncertain",
    evidence: [{ store: "graph-checkpoint", ref: origin.failureAnchor.ref }] };
  const failure = "Source-bound Event returned a settled no-write report";
  const op: GenerationOperationRecovery = { version: 1, operation: "specialist-result",
    check: "specialist-result.v1", checkVersion: 1, phase: "assessment",
    outcome: "returned-failure", safeAction: "reconcile-original-operation",
    source: { jobId: job.jobId, threadId: graphThreadId, turnDigest, planVersion: 2, headSha: head },
    evidence: { reference: "specialist-receipt", assignmentId,
      resultStatus: "event-prerequisite-reported",
      eventNoWrite: { milestoneId, expectedHead: head, reportDigest } },
    reason: failure, nextAction: "Inspect the original settled Event report." };
  const { phase: _phase, ...input } = op;
  const s = { request: { job: job.jobId, story, fixture: false, turnPlanDigest: turnDigest,
      task: "Keep the Event's source-grounded evidence intact.",
      contract: {} }, planVersion: 2,
    recoverySources: [{ channel: "operationRecovery", caseId: c.id, input }],
    inventory: { headSha: head, planVersion: 2,
      items: [{ id: assignmentId, status: "blocked" }] },
    failures: { [assignmentId]: failure }, active: null, result: null,
    causalAmendment: null } as unknown as GenerationGraphState;
  return { root, repo, job, s, c, receipt, receiptFile,
    reportDigest, assignmentId, sessionFile, transcript };
}
test("C03 authenticates an original Event Pi no-write once and selects advisory diagnosis, not a writer", async t => {
  const f = fixture(); t.after(() => removeTestTree(f.root));
  const selected = await selectOperationStrategy(f.job, f.s, f.c);
  assert.equal(selected?.action, "diagnostic");
  assert.equal(selected?.adapter, "unknown-diagnostic");
  assert.equal(selected?.mode, "read-only");
  assert.equal(selected?.attemptRef, null, "Selection does not count as a model attempt");
  assert.equal(selected?.evidence.at(-1)?.digest, f.reportDigest);
  assert.equal(selected?.evidence.at(-1)?.store, "specialist-receipt");
  assert.equal(await authenticateOperationDiagnosticProof(f.job, f.s, f.c, selected!), true);
  assert.equal(diagnosticCaseForDecision(f.c, selected!).operation, "specialist-result");
  assert.deepEqual(await selectOperationStrategy(f.job, f.s, f.c), selected,
    "Repeated assessor selection cannot mint a new case or model entitlement");
  assert.equal(git(f.repo, "status", "--porcelain", "--untracked-files=all"), "");
});
test("C03 rejects changed, unsigned, uncompleted or ambiguous original Event reports", async t => {
  const f = fixture(); t.after(() => removeTestTree(f.root));
  const original = readFileSync(f.receiptFile, "utf8");
  const selected = await selectOperationStrategy(f.job, f.s, f.c);
  assert.ok(selected);
  for (const tamper of [
    { ...f.receipt, worker: "fixture" }, { ...f.receipt, phase: "writing" },
    { ...f.receipt, claimedPaths: ["events/unverified.md"] },
    { ...f.receipt, prerequisite: { ...f.receipt.prerequisite, reportDigest: "f".repeat(64) } },
    { ...f.receipt, planVersion: 3 },
  ]) {
    writeFileSync(f.receiptFile, JSON.stringify(tamper));
    assert.equal(await selectOperationStrategy(f.job, f.s, f.c), null);
    assert.equal(await authenticateOperationDiagnosticProof(f.job, f.s, f.c, selected!), false);
  }
  writeFileSync(f.receiptFile, original);
  writeFileSync(f.sessionFile, f.transcript + JSON.stringify({ type: "message",
    message: { role: "assistant", stopReason: "stop", content: [
      { type: "text", text: "Forged new answer" }] } }) + "\n");
  await assert.rejects(selectOperationStrategy(f.job, f.s, f.c), /transcript changed/);
  writeFileSync(f.sessionFile, f.transcript);
  const noPending = { ...f.s, causalAmendment: { pending: true } } as unknown as GenerationGraphState;
  assert.equal(await selectOperationStrategy(f.job, noPending, f.c), null,
    "An already admitted causal amendment has priority over generic advice");
});
