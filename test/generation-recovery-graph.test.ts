import assert from "node:assert/strict";
import test from "node:test";
import {
  applyDomainRecovery,
  assertRecoverySources,
  decideExistingRecovery,
  extractDomainPatch,
  projectRecovery,
  type RecoveryState,
} from "../src/generation-recovery-graph.js";
import { emptyRecoveryLifecycle, selectPendingRecovery } from "../src/generation-recovery-lifecycle.js";
import { unknownCompletionCase } from "../src/unknown-recovery-diagnostic.js";
import type { GenerationOperationRecovery } from "../src/generation-operation-recovery.js";
import { recoveryNode } from "../src/generation.js";

const graphThreadId = "job-thread-1:generation";
const turn = "a".repeat(64);
const head = "b".repeat(40);
const assignment = "event:milestone.disclosure";
const id = {
  jobId: "job-1",
  jobThreadId: "job-thread-1",
  graphThreadId,
  turnDigest: turn,
  fixture: false,
  task: "Build the approved story",
  contract: { scope: { kind: "partial" } },
};
const cfg = (uuid: string) => ({
  configurable: {
    thread_id: graphThreadId,
    __pregel_task_id: uuid,
    checkpoint_map: { "": "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
  },
  metadata: {
    thread_id: graphThreadId,
    langgraph_node: "verify_committed_work",
    langgraph_checkpoint_ns: "verify_committed_work:" + uuid,
  },
});
const one = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const two = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const operation: GenerationOperationRecovery = {
  version: 1,
  operation: "commit-verification",
  check: "committed-work-verification.v1",
  checkVersion: 1,
  phase: "assessment",
  outcome: "exception",
  safeAction: "reconcile-original-operation",
  source: { jobId: id.jobId, threadId: graphThreadId, turnDigest: turn, planVersion: 2, headSha: head },
  evidence: { reference: "review-checkpoints", assignmentId: assignment },
  reason: "Original verified result cannot be adopted",
  nextAction: "Revalidate the original commit and review",
};
const empty = (): RecoveryState => ({ recoveryLifecycle: emptyRecoveryLifecycle(), recoverySources: [] });
const trusted = async () => true;
const admit = (state: RecoveryState = empty(), uuid = one) =>
  applyDomainRecovery(state, { operationRecovery: operation }, cfg(uuid), id, trusted);

test("C02 production bridge has only one phase, and never serializes domain status channels", async () => {
  const state = await admit();
  assert.equal(state.recoveryLifecycle.phase, "assessing");
  assert.equal(state.recoveryLifecycle.active?.origin.operation, "commit-verification");
  assert.equal(state.recoverySources.length, 1);
  assert.equal(Object.hasOwn(state.recoverySources[0]?.input ?? {}, "phase"), false);
  assert.equal(projectRecovery(state).operationRecovery?.phase, "assessment");
  assertRecoverySources(state);
  const decision = decideExistingRecovery(state);
  assert.equal(decision.decision?.action, "reconcile-effects");
  assert.equal(decision.phase, "reconciling");
  assert.equal(decision.active?.id, state.recoveryLifecycle.active?.id);
});

test("C02 a settled original failure cannot be re-admitted after its active slot is cleared", async () => {
  const original = await admit();
  const settled = { recoveryLifecycle: emptyRecoveryLifecycle(), recoverySources: original.recoverySources };
  const replay = await admit(settled, one);
  assert.equal(replay.recoveryLifecycle.phase, "idle");
  assert.equal(replay.recoveryLifecycle.active, null);
  assert.equal(replay.recoveryLifecycle.pending.length, 0);
  assert.equal(
    replay.recoverySources.length,
    1,
    "historical phase-free source tombstone prevents resetting the original model/Review budget",
  );
  const distinct = await admit(settled, two);
  assert.equal(distinct.recoveryLifecycle.phase, "assessing");
  assert.equal(distinct.recoveryLifecycle.active?.origin.operation, "commit-verification");
  assert.notEqual(
    distinct.recoveryLifecycle.active?.id,
    original.recoveryLifecycle.active?.id,
    "a genuinely distinct LangGraph failed check remains separately reviewable",
  );
});

test("C02 distinct failed checks queue in arrival order without replacing an active source", async () => {
  const first = await admit();
  const second = await admit(first, two);
  assert.equal(second.recoveryLifecycle.active?.id, first.recoveryLifecycle.active?.id);
  assert.equal(second.recoveryLifecycle.pending.length, 1);
  assert.equal(second.recoverySources.length, 2);
  assert.notEqual(second.recoveryLifecycle.pending[0]?.id, first.recoveryLifecycle.active?.id);
  assert.equal(second.recoveryLifecycle.attempt, null);
  assertRecoverySources(second);
});

test("C02 reassessment of the identical failed task is idempotent, not a fresh invocation", async () => {
  const original = await admit();
  const repeated = await admit(original, one);
  assert.equal(repeated.recoveryLifecycle.active?.id, original.recoveryLifecycle.active?.id);
  assert.equal(repeated.recoveryLifecycle.pending.length, 0);
  assert.equal(repeated.recoverySources.length, 1);
});

test("C02 untrusted source, changed Turn, and missing original task refuse to mint cases", async () => {
  const bad = [
    { config: cfg(one), identity: { ...id, turnDigest: "f".repeat(64) }, accept: trusted },
    { config: { ...cfg(one), configurable: { thread_id: graphThreadId } }, identity: id, accept: trusted },
    { config: cfg(one), identity: id, accept: async () => false },
  ];
  for (const item of bad) {
    const result = await applyDomainRecovery(
      empty(),
      { operationRecovery: operation },
      item.config,
      item.identity,
      item.accept,
    );
    assert.equal(result.recoveryLifecycle.active, null);
    assert.equal(result.recoveryLifecycle.phase, "fenced");
    assert.ok(result.recoveryLifecycle.inspectionFences.length > 0);
  }
});

test("C02 an existing original writer cannot be reported as reconciled without its receipt", async () => {
  const admitted = await admit();
  const decision = decideExistingRecovery(admitted);
  const original = { ...admitted, recoveryLifecycle: decision };
  const result = await applyDomainRecovery(
    original,
    {
      operationRecovery: { ...operation, phase: "continued" },
    },
    cfg(one),
    id,
    trusted,
  );
  assert.equal(result.recoveryLifecycle.phase, "fenced");
  assert.equal(result.recoveryLifecycle.inspectionFences[0]?.reason, "untrusted-receipt");
  assert.equal(result.recoveryLifecycle.active?.id, admitted.recoveryLifecycle.active?.id);
});

test("C02 original source with authenticated reconciliation enters verifying but cannot claim a commit", async () => {
  const admitted = await admit();
  const original = { ...admitted, recoveryLifecycle: decideExistingRecovery(admitted) };
  const result = await applyDomainRecovery(
    original,
    {
      operationRecovery: { ...operation, phase: "continued" },
    },
    cfg(one),
    id,
    trusted,
    {
      originalEffect: { store: "review-checkpoint", ref: "original-review" },
    },
  );
  assert.equal(result.recoveryLifecycle.phase, "verifying");
  assert.equal(result.recoveryLifecycle.active?.id, original.recoveryLifecycle.active?.id);
  assert.equal(result.recoveryLifecycle.attempt, null);
  assert.equal(projectRecovery(result).operationRecovery?.phase, "continued");
});

test("C02 failed re-verification fences the original case instead of throwing or replaying", async () => {
  const admitted = await admit();
  const original = { ...admitted, recoveryLifecycle: decideExistingRecovery(admitted) };
  const reconciled = await applyDomainRecovery(
    original,
    {
      operationRecovery: { ...operation, phase: "continued" },
    },
    cfg(one),
    id,
    trusted,
    {
      originalEffect: { store: "review-checkpoint", ref: "original-review" },
    },
  );
  assert.equal(reconciled.recoveryLifecycle.phase, "verifying");
  const failedAgain = await applyDomainRecovery(
    reconciled,
    {
      operationRecovery: { ...operation, phase: "fenced" },
    },
    cfg(two),
    id,
    trusted,
  );
  assert.equal(failedAgain.recoveryLifecycle.phase, "fenced");
  assert.equal(failedAgain.recoveryLifecycle.active?.id, admitted.recoveryLifecycle.active?.id);
  assert.equal(failedAgain.recoveryLifecycle.inspectionFences[0]?.reason, "untrusted-receipt");
  assert.equal(failedAgain.recoveryLifecycle.attempt, null);
});

test("C05 legacy completion-only channel cannot mint a second active recovery case", async () => {
  const first = await admit();
  const unknown = {
    case: unknownCompletionCase({
      jobId: id.jobId,
      threadId: id.jobThreadId,
      turnDigest: turn,
      planVersion: 2,
      sourceSha: head,
      checkpoint: assignment,
      reportStatus: "blocked",
      scopeStatus: "incomplete",
      planStatus: "incomplete",
    }),
    phase: "assessment" as const,
  };
  const second = await applyDomainRecovery(first, { unknownRecovery: unknown }, cfg(two), id, trusted);
  assert.equal(second.recoveryLifecycle.active?.id, first.recoveryLifecycle.active?.id);
  assert.equal(second.recoveryLifecycle.pending.length, 0);
  assert.equal(second.recoverySources.length, 1,
    "historical unknownRecovery is inspection-only; use C03 operationRecovery for new cases");
});


test("C02 authenticated author pause and cancellation retain their distinct lifecycle dispositions", async () => {
  const admitted = await admit();
  const controller = { ...admitted, recoveryLifecycle: decideExistingRecovery(admitted) };
  for (const control of ["paused", "cancelled"] as const) {
    const stopped = await applyDomainRecovery(controller, {
      operationRecovery: { ...operation, phase: "fenced" },
    }, cfg(one), id, trusted, { authorControl: control });
    assert.equal(stopped.recoveryLifecycle.phase, "paused");
    assert.equal(stopped.recoveryLifecycle.decision?.action, "pause");
    if (stopped.recoveryLifecycle.decision?.action === "pause")
      assert.equal(stopped.recoveryLifecycle.decision.reason,
        control === "cancelled" ? "cancelled" : "author-pause");
    assert.equal(stopped.recoveryLifecycle.inspectionFences.length, 0);
  }
});

test("a continuation hint cannot turn an uncertain verifier result into independent work", async () => {
  const hinted = { ...operation, safeAction: "continue-independent" as const };
  const admitted = await applyDomainRecovery(empty(), { operationRecovery: hinted }, cfg(one), id, trusted);
  assert.equal(decideExistingRecovery(admitted).decision?.action, "reconcile-effects");
});

test("C02 verified independent no-write progress keeps the failed obligation pending", async () => {
  const noWrite = { ...operation, operation: "specialist-dispatch" as const,
    check: "specialist-dispatch.v1", safeAction: "continue-independent" as const,
    evidence: { reference: "specialist-receipt" as const, assignmentId: assignment, priorHead: head } };
  const admitted = await applyDomainRecovery(empty(), { operationRecovery: noWrite }, cfg(one), id, trusted);
  const decided = decideExistingRecovery(admitted);
  assert.equal(decided.decision?.action, "continue-independent");
  const continued = await applyDomainRecovery({ ...admitted, recoveryLifecycle: decided },
    { operationRecovery: { ...noWrite, phase: "continued" } }, cfg(one), id, trusted,
    { originalEffect: { store: "specialist-receipt", ref: "original-reviewed-no-write" } });
  assert.equal(continued.recoveryLifecycle.active, null);
  assert.equal(continued.recoveryLifecycle.pending.length, 1);
  assert.equal(continued.recoveryLifecycle.phase, "idle");
  assert.equal(selectPendingRecovery(continued.recoveryLifecycle, () => false).phase, "idle");
  const selected = selectPendingRecovery(continued.recoveryLifecycle, () => true);
  assert.equal(selected.phase, "assessing");
  assert.equal(selected.active?.id, admitted.recoveryLifecycle.active?.id);
  assert.equal(selected.pending.length, 0);
});

test("C02 deferred idea no-write stays unresolved without inventing an assignment", async () => {
  const deferred = {
    ...operation, operation: "idea-integration" as const,
    check: "idea-dispatch.v1", outcome: "returned-failure" as const,
    safeAction: "continue-independent" as const,
    evidence: { reference: "generation-idea-dispatch" as const,
      ideaId: "archive-bell", resultStatus: "deferred", priorHead: head },
  };
  const admitted = await applyDomainRecovery(empty(), { operationRecovery: deferred }, cfg(one), id, trusted);
  assert.equal(admitted.recoveryLifecycle.active?.origin.assignmentId, null);
  const decision = decideExistingRecovery(admitted);
  assert.equal(decision.decision?.action, "continue-independent");
  if (decision.decision?.action === "continue-independent")
    assert.equal(decision.decision.blockedAssignmentId, "idea:archive-bell");
  const continued = await applyDomainRecovery({ ...admitted, recoveryLifecycle: decision },
    { operationRecovery: { ...deferred, phase: "continued" } }, cfg(one), id, trusted,
    { originalEffect: { store: "specialist-receipt", ref: "original-deferred-idea" } });
  assert.equal(continued.recoveryLifecycle.active, null);
  assert.equal(continued.recoveryLifecycle.pending.length, 1);
  assert.equal(continued.recoveryLifecycle.phase, "idle");
  assertRecoverySources(continued);
});

test("C05 injected legacy advisory status cannot claim a real Pi attempt or authority", async () => {
  const unknown = { case: unknownCompletionCase({
    jobId: id.jobId, threadId: id.jobThreadId, turnDigest: turn,
    planVersion: 2, sourceSha: head, checkpoint: assignment,
    reportStatus: "blocked", scopeStatus: "incomplete", planStatus: "incomplete",
  }), phase: "assessment" as const };
  const claimed = await applyDomainRecovery(empty(), { unknownRecovery: unknown }, cfg(one), id, trusted,
    { diagnosis: { receipt: { store: "response-contract", ref: unknown.case.signature },
      recommendation: "inspect-existing-receipt", advisoryCategory: "unclassified" } });
  assert.equal(claimed.recoveryLifecycle.active, null);
  assert.equal(claimed.recoveryLifecycle.decision, null);
  assert.equal(claimed.recoveryLifecycle.attempt, null);
  assert.deepEqual(claimed.recoverySources, []);
});

test("C02 production recovery wrapper prevents completion with an active or deferred case", async () => {
  const admitted = await admit();
  const complete = recoveryNode("completion_decision", async () => ({ status: "completed" }));
  for (const state of [
    admitted,
    { ...admitted, recoveryLifecycle: {
      ...admitted.recoveryLifecycle,
      active: null,
      pending: [admitted.recoveryLifecycle.active!],
      phase: "idle" as const,
    } },
  ]) {
    const outcome = await complete({ ...state, request: { fixture: true } } as never, {} as never);
    assert.equal(outcome.status, "blocked");
    assert.match(outcome.reason ?? "", /Unresolved recovery cases/);
  }
  const unchanged = recoveryNode("completion_decision", async () => ({}));
  const inherited = await unchanged({ ...admitted, status: "completed", request: { fixture: true } } as never, {} as never);
  assert.equal(inherited.status, "blocked",
    "a missing status patch must not preserve an earlier completed flag with pending recovery");
});

test("assessor without the original job cannot checkpoint a checked-HEAD decision", async () => {
  const admitted = await admit();
  let calls = 0;
  const assess = recoveryNode("assess_recovery", async () => {
    calls += 1;
    return { status: "running" };
  });
  const first = await assess(admitted as never, {} as never);
  assert.equal(first.status, "blocked");
  assert.equal(first.recoveryLifecycle?.decision, null);
  assert.equal(first.recoveryLifecycle?.inspectionFences.length, 1);
  assert.equal(calls, 0);
});
test("C02 wrapped node responses remove all retired writable graph fields", () => {
  const patch = extractDomainPatch(
    {
      operationRecovery: null,
      recovery: null,
      unknownRecovery: null,
    },
    { status: "running", operationRecovery: operation, recovery: null, unknownRecovery: null },
  );
  assert.deepEqual(Object.keys(patch.rest), ["status"]);
  assert.equal(patch.domain.operationRecovery?.check, "committed-work-verification.v1");
});
