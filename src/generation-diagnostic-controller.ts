/** C05 diagnosis-to-adapter admission. This is a pure controller projection;
 * the original C03 assessor and source-specific adapters own every effect. */
import { isDeepStrictEqual } from "node:util";
import type { GenerationGraphState } from "./generation.js";
import type { RecoveryCase, RecoveryDecision, RecoveryEvidence } from "./generation-recovery-contract.js";
import type { RecoveryDiagnosticProposal } from "./recovery-diagnostic-proposal.js";
import type { DiagnosticPacket, OperationDiagnosisCase } from "./unknown-recovery-diagnostic.js";

const base = (c: RecoveryCase, evidence: readonly RecoveryEvidence[]) => ({
  schema: "noveltea-generation-recovery-decision/v1" as const,
  caseId: c.id, checkedSourceHeadSha: c.origin.sourceHeadSha, evidence,
});

/** No free-form model text enters this packet. Its source proof is an already
 * verified operation/Review/receipt; author-only inbox is never queried. */
export function diagnosticPacket(s: GenerationGraphState, c: RecoveryCase,
  target: OperationDiagnosisCase): DiagnosticPacket {
  const assignment = s.inventory?.items.find(x => x.id === c.origin.assignmentId);
  return {
    jobId: c.origin.jobId, jobThreadId: c.origin.jobThreadId,
    graphThreadId: c.origin.graphThreadId, turnDigest: c.origin.turnDigest,
    originalObjective: s.request.task.slice(0, 3000),
    approvedScope: { kind: s.request.contract.scope.kind,
      depth: s.request.contract.scope.depth ?? s.request.contract.scope.preset,
      targets: s.request.contract.scope.targets.slice(0, 24).map(x => x.slice(0, 120)),
      constraints: s.request.contract.constraints.slice(0, 16).map(x => x.slice(0, 260)) },
    verifiedHistory: s.completedStages.slice(-12).map(x => ({
      headSha: x.headSha, stage: x.stage, milestone: x.milestone ?? null,
      planVersion: x.planVersion ?? null, status: x.status })),

    assignment: assignment ? { id: assignment.id, stage: assignment.stage,
      dependencies: assignment.dependencies.slice(0, 16), status: assignment.status,
      blockingReason: assignment.blockingReason?.slice(0, 700) ?? null } : null,
    planVersion: c.origin.planVersion,
    failedOperation: c.origin.operation, failedCheck: c.origin.check,
    originalSource: c.origin.sourceHeadSha, sourceProof: target.proofRef,
    inventory: s.inventory ? { headSha: s.inventory.headSha,
      items: s.inventory.items.slice(0, 24).map(i => ({ id: i.id.slice(0, 160), status: i.status,
        stage: i.stage, dependencies: i.dependencies.slice(0, 8).map(x => x.slice(0, 160)) })) } : null,
    existingFindings: { escalation: s.escalation ? { kind: s.escalation.kind,
      requiresTrustedApproval: s.escalation.requiresTrustedApproval,
      sources: s.escalation.sources.slice(0, 8).map(x => ({ source: x.source.slice(0, 160),
        message: x.message.slice(0, 320), repair: x.repair.slice(0, 120) })),
      action: s.escalation.action.slice(0, 500) } : null,
      failure: c.origin.assignmentId ? s.failures[c.origin.assignmentId]?.slice(0, 1200) ?? null : null },
    previousAttempts: s.recoveryLifecycle.attempt ? [{ id: s.recoveryLifecycle.attempt.id,
      phase: s.recoveryLifecycle.attempt.phase }] : [],
    availableAdapters: ["scheduling", "independent-review"].includes(c.origin.operation) &&
      c.observation === "exception" ? ["checkpoint-reconciliation"] : [],
  };
}

/** A proposal is not authority. Admit only original no-write scheduling
 * reconciliation or an already independently accepted reviewer receipt;
 * never replay the reviewer/writer from model advice. Actual resolution
 * still requires the source-specific original check and verifier. */
export function authorizeDiagnosticStrategy(s: GenerationGraphState, c: RecoveryCase,
  diagnostic: Extract<RecoveryDecision, { action: "diagnostic" }>,
  proposal: RecoveryDiagnosticProposal): RecoveryDecision | null {
  if (proposal.strategy !== "reconcile-original" ||
      !["infrastructure", "protocol"].includes(proposal.category) ||
      proposal.prerequisites.length !== 0 || c.observation !== "exception" ||
      s.ideaTask || s.crossDomainCloseout || s.causalAmendment || s.escalation ||
      proposal.owner !== null || proposal.scopeRef !== null ||
      s.inventory?.headSha !== c.origin.sourceHeadSha ||
      s.planVersion !== c.origin.planVersion ||
      s.request.job !== c.origin.jobId ||
      s.request.turnPlanDigest !== c.origin.turnDigest ||
      diagnostic.caseId !== c.id ||
      diagnostic.checkedSourceHeadSha !== c.origin.sourceHeadSha ||
      !isDeepStrictEqual(diagnostic.evidence.slice(0, -1), c.evidence))
    return null;
  const proof = diagnostic.evidence.at(-1);
  if (!proof?.digest || proposal.sourceRef !==
      [proof.store, proof.ref, proof.digest].join(":")) return null;
  const scheduling = c.origin.operation === "scheduling" && !s.active && !s.result;
  const review = c.origin.operation === "independent-review" &&
    !!s.active && s.active.id === c.origin.assignmentId &&
    !!s.result && s.result.headSha === c.origin.sourceHeadSha &&
    !!s.inventory?.items.some(i => i.id === s.active?.id);
  if (!scheduling && !review) return null;
  return { ...base(c, diagnostic.evidence), action: "reconcile-effects",
    adapter: "checkpoint-reconciliation", originalRef: c.evidence[0]! };
}

export function terminalDiagnosticDecision(c: RecoveryCase,
  diagnostic: Extract<RecoveryDecision, { action: "diagnostic" }>,
  receipt: RecoveryEvidence, proposal: RecoveryDiagnosticProposal): RecoveryDecision {
  return { ...base(c, diagnostic.evidence), action: "diagnostic-stop",
    disposition: "operator-intervention", receipt, proposal };
}
