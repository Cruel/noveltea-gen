import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRecoveryDiagnosticProposal } from "../src/recovery-diagnostic-proposal.js";
import { authorizeDiagnosticStrategy, diagnosticPacket, terminalDiagnosticDecision } from "../src/generation-diagnostic-controller.js";
import type { OperationDiagnosisCase } from "../src/unknown-recovery-diagnostic.js";
import { recoveryCaseId, decideRecovery, emptyRecoveryLifecycle,
  recoveryAdmission, admitRecovery } from "../src/generation-recovery-lifecycle.js";
import type { RecoveryCase, RecoveryDecision, RecoveryOrigin } from "../src/generation-recovery-contract.js";
import type { GenerationGraphState } from "../src/generation.js";

const signature = "a".repeat(64), proofRef = "graph-checkpoint:original-task:" + "b".repeat(64);
const admitted = { signature, proofRef };
const example = { schema: "noveltea-recovery-diagnostic-proposal/v1" as const,
  signature, sourceRef: proofRef, category: "infrastructure" as const,
  diagnosis: "Original scheduling check failed after read-only inspection.",
  strategy: "reconcile-original" as const, owner: null, scopeRef: null,
  prerequisites: [],
  uncertainty: "The original read-only scheduling error may recur." };

test("C05 typed read-only diagnostic accepts only exact source-bound strategy JSON", () => {
  assert.deepEqual(parseRecoveryDiagnosticProposal(JSON.stringify(example), admitted), example);
  for (const strategy of ["local-repair", "dependency-plan", "blueprint-or-work-plan-amend",
    "review-adjudication", "reconcile-original", "no-write-omission-review",
    "resource-or-author-pause", "unsafe"]) {
    assert.equal(parseRecoveryDiagnosticProposal(JSON.stringify({ ...example, strategy }), admitted).strategy,
      strategy);
  }
  for (const invalid of [
    { ...example, signature: "c".repeat(64) },
    { ...example, sourceRef: "unverified-file" },
    { ...example, strategy: "approve-and-write" },
    { ...example, category: "approved" },
    { ...example, owner: "  " },
    { ...example, prerequisites: Array(9).fill("new writer") },
    { ...example, diagnosis: "" },
    { ...example, uncertainty: "x".repeat(900) },
    { ...example, approved: true },
    { ...example, diagnosis: "embedded\ncontrol-character" },
  ]) assert.throws(() => parseRecoveryDiagnosticProposal(JSON.stringify(invalid), admitted));
  assert.throws(() => parseRecoveryDiagnosticProposal("not JSON", admitted));
  assert.throws(() => parseRecoveryDiagnosticProposal("x".repeat(5100), admitted));
});

const origin: RecoveryOrigin = {
  jobId: "job-242", jobThreadId: "thread-242", graphThreadId: "thread-242:generation",
  turnDigest: "d".repeat(64), planVersion: 2,
  sourceHeadSha: "e".repeat(40), assignmentId: null,
  operation: "scheduling", check: "generation-scheduling.v1", checkVersion: 1,
  failureAnchor: { store: "graph-checkpoint", ref: "thread-242:original", failedCheckInstanceId: "check-242" },
};
const evidence = [{ store: "graph-checkpoint" as const, ref: "thread-242:original" }];
const c: RecoveryCase = { schema: "noveltea-generation-recovery-case/v1", id: recoveryCaseId(origin),
  origin, kind: "infrastructure", observation: "exception", effect: "writer-effects-uncertain", evidence };
const diagnostic: Extract<RecoveryDecision, { action: "diagnostic" }> = {
  schema: "noveltea-generation-recovery-decision/v1", caseId: c.id,
  checkedSourceHeadSha: origin.sourceHeadSha,
  evidence: [...evidence, { store: "graph-checkpoint", ref: "thread-242:original", digest: "b".repeat(64) }],
  action: "diagnostic", adapter: "unknown-diagnostic", mode: "read-only", attemptRef: null,
};
const state = { active: null, result: null, ideaTask: null, crossDomainCloseout: null,
  causalAmendment: null, escalation: null, planVersion: origin.planVersion,
  request: { job: origin.jobId, turnPlanDigest: origin.turnDigest },
  inventory: { headSha: origin.sourceHeadSha },
} as unknown as GenerationGraphState;

test("C05 model recommendations are admitted only when the original controller adapter is independently eligible", () => {
  const proposal = { ...example, sourceRef: "graph-checkpoint:thread-242:original:" + "b".repeat(64) };
  const approved = authorizeDiagnosticStrategy(state, c, diagnostic, proposal);
  assert.equal(approved?.action, "reconcile-effects");
  if (approved?.action === "reconcile-effects") {
    assert.equal(approved.adapter, "checkpoint-reconciliation");
    assert.equal(approved.originalRef.ref, evidence[0]!.ref);
  }
  assert.equal(authorizeDiagnosticStrategy(state, c, diagnostic, {
    ...proposal, prerequisites: [
      "Recheck the original checkpoint before resuming",
      "Do not invent a new author approval",
    ],
  })?.action, "reconcile-effects",
  "Advisory model prerequisites cannot veto independently authorized read-only verification");
  assert.equal(authorizeDiagnosticStrategy(state, c, diagnostic, {
    ...proposal, prerequisites: ["Additional unverified author approval"],
  })?.action, "reconcile-effects",
  "An unverified model suggestion cannot become an actual approval requirement or write grant");
  assert.equal(authorizeDiagnosticStrategy(state, c, diagnostic, {
    ...proposal, category: "integrity", uncertainty: "Original source requires an independent check.",
  })?.action, "reconcile-effects",
  "A model integrity label cannot veto an independently source-bound read-only recheck");
  for (const kind of ["integrity", "authorization", "resource", "semantic"] as const)
    assert.equal(authorizeDiagnosticStrategy(state, { ...c, kind }, diagnostic, proposal), null,
      "A verified controller category is a safety barrier even if the model suggests reconciliation");
  for (const unsafe of [
    { ...proposal, strategy: "local-repair" as const },
    { ...proposal, owner: "composition" },
    { ...proposal, scopeRef: "all-story" },
  ]) assert.equal(authorizeDiagnosticStrategy(state, c, diagnostic, unsafe), null);
  for (const badState of [
    { ...state, active: { id: "writer-in-flight" } },
    { ...state, inventory: { headSha: "f".repeat(40) } },
    { ...state, escalation: { kind: "protected-approval" } },
    { ...state, causalAmendment: { sourceSha: origin.sourceHeadSha } },
  ]) assert.equal(authorizeDiagnosticStrategy(badState as GenerationGraphState, c, diagnostic, proposal), null);
  assert.equal(authorizeDiagnosticStrategy(state, { ...c,
    origin: { ...origin, operation: "specialist-dispatch" } }, diagnostic, proposal), null);
  assert.equal(authorizeDiagnosticStrategy(state, c, { ...diagnostic, caseId: "f".repeat(64) }, proposal), null);
  assert.equal(authorizeDiagnosticStrategy(state, c, diagnostic, { ...proposal, sourceRef: "unverified" }), null);
  assert.equal(authorizeDiagnosticStrategy({ ...state, planVersion: 3 } as GenerationGraphState,
    c, diagnostic, proposal), null);
  assert.equal(authorizeDiagnosticStrategy({ ...state, request: {job: "another", turnPlanDigest: origin.turnDigest} } as GenerationGraphState,
    c, diagnostic, proposal), null);
});

test("C05 previously passed independent Review transport exception admits original-receipt-only reconciliation", () => {
  const reviewOrigin = { ...origin, operation: "independent-review" as const,
    check: "assignment-review.v1", assignmentId: "composition:milestone.disclosure" };
  const reviewCase = { ...c, origin: reviewOrigin, id: recoveryCaseId(reviewOrigin) };
  const reviewDiagnostic = { ...diagnostic, caseId: reviewCase.id };
  const reviewState = { ...state,
    active: {id: reviewOrigin.assignmentId}, result: {headSha: origin.sourceHeadSha},
    inventory: {headSha: origin.sourceHeadSha, items:[{id:reviewOrigin.assignmentId}]} } as GenerationGraphState;
  const proposal = { ...example, sourceRef: "graph-checkpoint:thread-242:original:" + "b".repeat(64) };
  assert.equal(authorizeDiagnosticStrategy(reviewState, reviewCase, reviewDiagnostic, proposal)?.action,
    "reconcile-effects");
  assert.equal(authorizeDiagnosticStrategy({ ...reviewState, result: {headSha:"f".repeat(40)} },
    reviewCase, reviewDiagnostic, proposal), null);
  assert.equal(authorizeDiagnosticStrategy({ ...reviewState, active: {id: "wrong-owner"} } as GenerationGraphState,
    reviewCase, reviewDiagnostic, proposal), null);
});

test("C05 bounded diagnostic packet carries authenticated original scope without author-only inbox", () => {
  const source = { ...state,
    request: { task: "Original objective ".repeat(800), contract: {
      scope: { kind: "partial", depth: "interactive", targets: Array(40).fill("milestone.one"),
        branches: [] }, constraints: Array(30).fill("Keep original protected decision") } },
    completedStages: [{ headSha: origin.sourceHeadSha, stage: "event", status: "verified" }],
    failures: {}, recoveryLifecycle: { attempt: null },
    inventory: { headSha: origin.sourceHeadSha, items: Array(40).fill(null).map((_, i) => ({
      id: "event:milestone." + i, stage: "event", dependencies: ["foundation"], status: "verified",
    })) },
    authorOnlyInbox: "PRIVATE_AUTHOR_MESSAGE_DO_NOT_DISCLOSE",
  } as unknown as GenerationGraphState;
  const packet = diagnosticPacket(source, c,
    { proofRef } as OperationDiagnosisCase);
  assert.equal(packet.jobId, origin.jobId);
  assert.equal(packet.graphThreadId, origin.graphThreadId);
  assert.equal(packet.sourceProof, proofRef);
  assert.equal(packet.planVersion, origin.planVersion);
  assert.equal(packet.originalObjective.length, 3000);
  assert.equal((packet.inventory as {items: unknown[]}).items.length, 24);
  assert.equal((packet.approvedScope as {targets: string[]}).targets.length, 24);
  assert.deepEqual(packet.verifiedHistory, [{ headSha: origin.sourceHeadSha,
    stage: "event", milestone: null, planVersion: null, status: "verified" }]);
  assert.doesNotMatch(JSON.stringify(packet), /PRIVATE_AUTHOR_MESSAGE_DO_NOT_DISCLOSE/);
});

test("C05 unsupported advice is a typed sealed STOP, never an authorized writer", async () => {
  const proposal = { ...example, strategy: "unsafe" as const,
    sourceRef: "graph-checkpoint:thread-242:original:" + "b".repeat(64) };
  const stop = terminalDiagnosticDecision(c, diagnostic,
    { store: "response-contract", ref: signature }, proposal);
  assert.equal(stop.action, "diagnostic-stop");
  const admission = await recoveryAdmission({ origin, kind: c.kind, observation: c.observation,
    effect: c.effect, evidence, authenticate: async () => true });
  const lifecycle = decideRecovery(admitRecovery(emptyRecoveryLifecycle(), admission), diagnostic);
  const terminal = decideRecovery(lifecycle, stop);
  assert.equal(terminal.phase, "fenced");
  assert.equal(terminal.decision?.action, "diagnostic-stop");
  assert.equal(terminal.attempt, null, "The proposal cannot claim an invoked Pi model");
  const forged = { ...proposal, sourceRef: "untrusted" };
  assert.throws(() => decideRecovery(lifecycle, terminalDiagnosticDecision(c, diagnostic,
    { store: "response-contract", ref: signature }, forged)));
});

test("R14H only the independently accepted original adaptive effect can select reconciliation", () => {
  const adaptiveOrigin = { ...origin, operation: "adaptive-admission" };
  const adaptiveCase = { ...c, origin: adaptiveOrigin, id: recoveryCaseId(adaptiveOrigin) };
  const proof = { store: "response-contract" as const, ref: "a".repeat(64), digest: "c".repeat(64) };
  const selected = { ...diagnostic, caseId: adaptiveCase.id, evidence: [...evidence, proof] };
  const proposal = { ...example, sourceRef: [proof.store, proof.ref, proof.digest].join(":") };
  assert.equal(authorizeDiagnosticStrategy(state, adaptiveCase, selected, proposal), null);
  assert.equal(authorizeDiagnosticStrategy(state, adaptiveCase, selected, proposal,
    { ...proof, digest: "f".repeat(64) }), null);
  assert.equal(authorizeDiagnosticStrategy(state, adaptiveCase, selected, proposal, proof)?.action,
    "reconcile-effects");
  assert.equal(authorizeDiagnosticStrategy(state, adaptiveCase, selected,
    { ...proposal, strategy: "local-repair" }, proof), null);
  assert.equal(authorizeDiagnosticStrategy({ ...state, planVersion: 3 }, adaptiveCase, selected,
    proposal, proof), null);
});
