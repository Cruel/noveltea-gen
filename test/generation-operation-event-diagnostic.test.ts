/** C03: a report digest and transcript alone are not an original settled
 * Event assignment. The positive production path is exercised in R14D;
 * these fixtures verify rejection and the independent scheduling diagnostic. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
  const assignment = { id: assignmentId, milestoneId, workItemId };
  const snapshotId = "b".repeat(64), planDigest = "c".repeat(64);
  const conflicts = ["The witness cannot establish the missing Event evidence."];
  const payload = { jobId: job.jobId, workItemId, expectedHead: head,
    planDigest, sessionSha256: sha(transcript), sessionId,
    assignmentDigest: sha(JSON.stringify(assignment)), snapshotId,
    sessionFile, worker: "pi" as const, conflicts, obligations: [] };
  const reportDigest = eventPrerequisiteReportDigest(payload);
  const receipt = { version: 1, jobId: job.jobId, baseSha: head, phase: "prerequisite-reported",
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
test("C03 refuses a digest-only Event report without original settled assignment evidence", async t => {
  const f = fixture(); t.after(() => removeTestTree(f.root));
  await assert.rejects(selectOperationStrategy(f.job, f.s, f.c), /settled invocation proof/);
  assert.equal(git(f.repo, "status", "--porcelain", "--untracked-files=all"), "");
});
test("C03 source-bound unknown scheduling exception selects exactly one read-only diagnosis", async t => {
  const f = fixture(); t.after(() => removeTestTree(f.root));
  const origin: RecoveryOrigin = { ...f.c.origin,
    operation: "scheduling", check: "generation-scheduling.v1", assignmentId: null };
  const c: RecoveryCase = { ...f.c, id: recoveryCaseId(origin), origin,
    kind: "infrastructure", observation: "exception" };
  const operation: GenerationOperationRecovery = {
    ...f.s.recoverySources[0]!.input as GenerationOperationRecovery,
    operation: "scheduling", check: "generation-scheduling.v1",
    outcome: "exception", evidence: { reference: "generation-checkpoint" },
  };
  const { phase: _phase, ...input } = operation;
  const s = { ...f.s,
    recoverySources: [{ channel: "operationRecovery" as const, caseId: c.id, input }],
    inventory: { ...f.s.inventory, items: [
      { id: "composition:milestone.disclosure", stage: "composition", status: "pending" },
    ] },
    active: null, result: null, ideaTask: null, crossDomainCloseout: null,
    causalAmendment: null, escalation: null,
  } as unknown as GenerationGraphState;
  const decision = await selectOperationStrategy(f.job, s, c);
  assert.equal(decision?.action, "diagnostic");
  assert.equal(decision?.adapter, "unknown-diagnostic");
  assert.equal(decision?.mode, "read-only");
  assert.equal(decision?.attemptRef, null);
  assert.equal(decision?.evidence.at(-1)?.store, "graph-checkpoint");
  assert.equal(decision?.evidence.at(-1)?.ref, origin.failureAnchor.ref);
  assert.equal(await authenticateOperationDiagnosticProof(f.job, s, c, decision!), true);
  assert.deepEqual(await selectOperationStrategy(f.job, s, c), decision,
    "Selection is an original-case checkpoint, not a model attempt");
  assert.equal(diagnosticCaseForDecision(c, decision!).operation, "scheduling");
  const unsafe = async (next: Partial<GenerationGraphState>, why: string) =>
    assert.equal(await selectOperationStrategy(f.job, { ...s, ...next }, c), null, why);
  await unsafe({ active: { id: "foundation", stage: "foundation" } } as any,
    "Cannot diagnose unknown operations while the original writer is active");
  await unsafe({ ideaTask: { id: "unknown-in-flight-idea" } } as any,
    "An unresolved external idea task takes precedence");
  await unsafe({ escalation: { requiresTrustedApproval: true } } as any,
    "Protected author decision takes precedence");
  await unsafe({ crossDomainCloseout: { sourceSha: f.c.origin.sourceHeadSha } } as any,
    "A pending owner amendment takes precedence");
  await unsafe({ inventory: { ...s.inventory, headSha: "f".repeat(40) } },
    "An altered source inventory cannot grant diagnosis");
  const tampered = { ...s, recoverySources: [{
    channel: "operationRecovery" as const, caseId: c.id,
    input: { ...input, evidence: { ...input.evidence, assignmentId: f.assignmentId } },
  }] } as GenerationGraphState;
  assert.equal(await selectOperationStrategy(f.job, tampered, c), null);
  const changedInventory = { ...s, inventory: { ...s.inventory, items: [] } };
  assert.equal(await authenticateOperationDiagnosticProof(f.job, changedInventory, c, decision!), false,
    "An already selected diagnostic cannot rebind its immutable original inventory");
});

test("C03 rejects changed, unsigned or ambiguous original Event reports", async t => {
  const f = fixture(); t.after(() => removeTestTree(f.root));
  for (const tamper of [
    { ...f.receipt, worker: "fixture" }, { ...f.receipt, phase: "writing" },
    { ...f.receipt, claimedPaths: ["events/unverified.md"] },
    { ...f.receipt, prerequisite: { ...f.receipt.prerequisite, reportDigest: "f".repeat(64) } },
    { ...f.receipt, planVersion: 3 },
  ]) {
    writeFileSync(f.receiptFile, JSON.stringify(tamper));
    assert.equal(await selectOperationStrategy(f.job, f.s, f.c), null);
  }
  writeFileSync(f.receiptFile, JSON.stringify(f.receipt));
  const noPending = { ...f.s, causalAmendment: { pending: true } } as unknown as GenerationGraphState;
  assert.equal(await selectOperationStrategy(f.job, noPending, f.c), null,
    "An already admitted causal amendment has priority over generic advice");
});
