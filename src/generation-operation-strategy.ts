/** Decisions at the existing assessor only. Original adapters retain every
 * receipt, writer lock, validation, independent review and budget check. */
import { readBlueprintAssessment } from "./blueprint-reassessment.js";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { authenticateAssignmentFailure, authenticateNonSpecialistProtocolFailure, type GenerationOperationRecovery } from "./generation-operation-recovery.js";
import type { GenerationGraphState } from "./generation.js";
import type { JobStartResult } from "./job.js";
import { git } from "./ideas.js";
import { trustedHead } from "./revision.js";
import { processAuthorUpdatesAfterWork } from "./author-updates.js";
import { readJobControl } from "./job-control.js";
import { withStoryJobLock } from "./job-lock.js";
import { inspectPiPolicy, PiModelUnavailableError } from "./job-pi-policy.js";
import { inspectRecoveryCheckpoints } from "./recovery-checkpoints.js";
import { inspectCheckpointReview } from "./checkpoint-assurance.js";
import { inspectPostcommitReviewCycle } from "./postcommit-review-cycle.js";
import { inspectSettledAdaptiveReconciliation } from "./adaptive-reconciliation.js";
import type { RecoveryDiagnosticProposal } from "./recovery-diagnostic-proposal.js";
import { inspectFoundationDiagnosticFailure } from "./foundation.js";
import { pendingDigest } from "./pending-work-amendments.js";
import { readAdaptiveState } from "./adaptive-state.js";
import { usesSharedAssignmentReview } from "./generation-assignment-lifecycle.js";
import { inspectRejectedRepair, authenticateFoundationReviewHead, inspectFoundationReviewBoundary,
  executeFoundationReviewAssessment, inspectFoundationReviewStop, inspectNativeReviewFailure } from "./rejected-review-repair.js";
import { inspectJobReport } from "./job-report.js";
import { isTrustedFinalVerdictAnomaly } from "./generation-final-verdict.js";
import { authorizedInventoryComplete } from "./generation-plan.js";
import { authenticateEventNoWrite, type EventNoWriteSource } from "./event-prerequisite-auth.js";
import { preflightCompositionBoundary } from "./cross-domain-prerequisite-controller.js";
import { advanceCrossDomainCloseout } from "./cross-domain-closeout-work.js";
import { diagnoseUnknownCompletion, inspectDiagnosticAttempt, inspectOriginalUnknownDiagnosis,
  operationDiagnosisCase, type UnknownRecoveryCase } from "./unknown-recovery-diagnostic.js";
import { assessBoundedAssignmentFailure, decideRecovery, finishVerifiedRecovery, recordRecoveryOutcome } from "./generation-recovery-lifecycle.js";
import { authorizeDiagnosticStrategy, diagnosticPacket, terminalDiagnosticDecision } from "./generation-diagnostic-controller.js";
import type { RecoveryCase, RecoveryDecision, RecoveryEvidence, RecoveryLifecycle, RecoveryAttempt } from "./generation-recovery-contract.js";

type State = GenerationGraphState;
const base = (c: RecoveryCase, proof?: RecoveryEvidence) => ({
  schema: "noveltea-generation-recovery-decision/v1" as const, caseId: c.id,
  checkedSourceHeadSha: c.origin.sourceHeadSha, evidence: proof ? [...c.evidence, proof] : c.evidence,
});
async function originalAssignmentFailure(job: JobStartResult, s: State, c: RecoveryCase) {
  const op = s.recoverySources.find(x => x.caseId === c.id && x.channel === "operationRecovery")?.input as
    GenerationOperationRecovery | undefined;
  if (!op?.evidence.assignmentFailure) {
    if (c.origin.operation !== "independent-review" || !usesSharedAssignmentReview(c.origin.assignmentId)) return null;
    const failure = await inspectNativeReviewFailure(job, c.origin.sourceHeadSha, c.id);
    if (!failure) return null;
    if (!await originalFailedReviewProof(job, s, c))
      throw Error("Original Review native failure lost its admitted source");
    return failure;
  }
  if (c.origin.operation !== "specialist-result" || c.origin.assignmentId !== op.evidence.assignmentId ||
      c.observation !== "returned-failure" || s.active?.id !== c.origin.assignmentId || s.result ||
      !s.inventory || s.request.fixture ||
      s.request.turnPlanDigest !== c.origin.turnDigest || s.planVersion !== c.origin.planVersion ||
      s.request.job !== job.jobId || c.origin.jobThreadId !== job.threadId)
    throw Error("Original settled assignment failure is not the admitted active child.");
  if (s.inventory.headSha !== c.origin.sourceHeadSha) {
    if (s.active.stage !== "interactive" || op.evidence.interactiveDomain !== "puzzle" || !s.active.milestone)
      throw Error("Original assignment failure does not match its admitted inventory source.");
    const { inspectPendingInteractiveInvocation } = await import("./interactive-work.js");
    const original = await inspectPendingInteractiveInvocation(job, s.active.milestone, "puzzle", s.inventory.headSha);
    if (!original || original.unit.beforeHead !== c.origin.sourceHeadSha ||
        original.receipt.units[0]?.beforeHead !== s.inventory.headSha)
      throw Error("Original Puzzle failure does not match the admitted Choice predecessor.");
  }
  const failure = await authenticateAssignmentFailure(job, op.evidence, c.origin.sourceHeadSha);
  if (!failure) throw Error("Original settled assignment failure proof changed.");
  return failure;
}
async function assertSource(job: JobStartResult, s: State, c: RecoveryCase) {
  if (s.request.turnPlanDigest !== c.origin.turnDigest || s.planVersion !== c.origin.planVersion ||
      s.request.job !== c.origin.jobId || job.threadId !== c.origin.jobThreadId ||
      !await originalAssignmentFailure(job, s, c) &&
        (await trustedHead(job) !== c.origin.sourceHeadSha || git(job, "status", "--porcelain=v1", "--untracked-files=all").trim()))
    throw Error("Original Turn, plan, HEAD or writer effects changed before recovery");
}
/** A clean worktree alone doesn't settle a writer. Require the original
 * operation's verified effect, not a reason string or a model's diagnosis. */
async function diagnosticEvidence(job: JobStartResult, s: State, c: RecoveryCase): Promise<RecoveryEvidence | null> {
  const { operation, sourceHeadSha: head, turnDigest, planVersion } = c.origin;
  if (s.request.fixture || !s.request.turnPlanDigest) return null;
  // A negative final objective is an authenticated semantic obligation, not
  // an ambiguous writer effect. Even when new author authority is required,
  // a read-only diagnosis may establish that no authorized remedy exists.
  // Bind the diagnosis to the actual independent final finding, not merely
  // a positive specialist checkpoint or the saved escalation prose.
  if (operation === "completion-verification" && c.observation === "returned-failure" &&
      !s.active && !s.result && !s.ideaTask && !s.causalAmendment && s.escalation &&
      s.inventory?.headSha === head && s.inventory.planVersion === planVersion &&
      authorizedInventoryComplete(s.inventory)) {
    const op = s.recoverySources.find(x => x.caseId === c.id && x.channel === "operationRecovery")
      ?.input as GenerationOperationRecovery | undefined;
    const report = await inspectJobReport(s.request);
    const fulfillment = report.generation.planFulfillment;
    if (fulfillment.status === "incomplete") {
      const point = (await inspectRecoveryCheckpoints(job)).find(p =>
        p.eligible && p.commitSha === head && p.validation.status === "passed" &&
        (p.semanticReview === "passed" || p.semanticReview === "not-required"));
      if (op?.evidence.reference !== "completion-report" || op.source.headSha !== head ||
          op.source.planVersion !== planVersion || op.source.turnDigest !== turnDigest ||
          report.identity.headSha !== head || !report.identity.clean ||
          report.generation.scopeFulfillment !== "complete-in-scope" ||
          fulfillment.headSha !== head || fulfillment.planVersion !== planVersion ||
          fulfillment.assurance !== "semantic" || !fulfillment.findings.length || !point ||
          !fulfillment.findings.every(f => s.escalation!.sources.some(source =>
            source.source === f.objectiveId && source.message === f.message &&
            source.repair === (f.followUp ? "turn-follow-up" : "architecture"))))
        return null;
      return { store: "completion-report", ref: c.origin.failureAnchor.ref,
        digest: createHash("sha256").update(JSON.stringify({ original: op,
          inventory: s.inventory, source: head, fulfillment,
          checkpoint: point.proofDigest })).digest("hex") };
    }
  }
  if (s.escalation?.requiresTrustedApproval) return null;
  const assignmentFailure = await originalAssignmentFailure(job, s, c);
  if (assignmentFailure?.proof.kind === "nonconverging")
    return { store: "specialist-receipt", ref: assignmentFailure.ref,
      digest: assignmentFailure.proof.receiptDigest };
  // The scheduler may fail AFTER a read-only source inspection with no
  // selected writer. A genuine original task/Turn checkpoint is already
  // authenticated by the production graph; bind the diagnostic to the exact
  // saved operation receipt and unchanged inventory. This authorizes ONLY
  // one read-only Pi diagnosis, never retry of the uncertain original task.
  // In-flight writers, idea integrations, active specialists, causal amendments,
  // protected author choices and source movement are not covered.
  if (operation === "scheduling" && c.observation === "exception" &&
      !s.active && !s.result && !s.ideaTask && !s.crossDomainCloseout &&
      !s.causalAmendment && !s.escalation && s.inventory &&
      s.inventory.headSha === head && s.inventory.planVersion === planVersion) {
    const source = s.recoverySources.find(x =>
      x.caseId === c.id && x.channel === "operationRecovery");
    const op = source?.input as GenerationOperationRecovery | undefined;
    if (op?.operation === "scheduling" && op.outcome === "exception" &&
        op.check === c.origin.check && op.checkVersion === c.origin.checkVersion &&
        op.evidence?.reference === "generation-checkpoint" &&
        !op.evidence.assignmentId && !op.evidence.priorHead &&
        !op.evidence.verifier && !op.evidence.closeout &&
        !op.evidence.eventNoWrite && !op.evidence.interactiveNoWrite &&
        !op.evidence.foundationsNoWrite &&
        op.source.jobId === job.jobId && op.source.threadId === c.origin.graphThreadId &&
        op.source.turnDigest === turnDigest && op.source.planVersion === planVersion &&
        op.source.headSha === head) {
      const fingerprint = createHash("sha256").update(JSON.stringify({
        operation: op, inventory: s.inventory,
        failedCheck: c.origin.failureAnchor, source: head,
      })).digest("hex");
      return { store: "graph-checkpoint", ref: c.origin.failureAnchor.ref, digest: fingerprint };
    }
  }
  // A returned Event no-write has an explicit original Pi completion report.
  // Unlike an uncertain specialist exception, it is safe to ASK a read-only
  // diagnostician what is missing; never grant a replacement Event writer.
  if (operation === "specialist-result" && c.observation === "returned-failure" &&
      !s.active && !s.result && !s.causalAmendment &&
      s.inventory?.headSha === head && c.origin.assignmentId?.startsWith("event:")) {
    const source = s.recoverySources.find(x => x.caseId === c.id && x.channel === "operationRecovery");
    const op = source?.input as GenerationOperationRecovery | undefined;
    const report = op?.evidence.eventNoWrite;
    const item = s.inventory.items.find(x => x.id === c.origin.assignmentId);
    if (op?.evidence.resultStatus !== "event-prerequisite-reported" ||
        op.evidence.assignmentId !== c.origin.assignmentId ||
        !report || report.expectedHead !== head || item?.status !== "blocked" ||
        !s.failures[c.origin.assignmentId] ||
        !/^milestone\.[a-z][a-z0-9-]*$/.test(report.milestoneId) ||
        !/^[0-9a-f]{64}$/.test(report.reportDigest) ||
        c.origin.assignmentId !== "event:" + report.milestoneId)
      return null;
    const relative = "event-items/" + report.milestoneId.slice(10) + ".json";
    const original = JSON.parse(await readFile(join(job.stateDir, relative), "utf8")) as
      EventNoWriteSource & { phase?: string; milestoneId?: string; planVersion?: number;
        claimedPaths?: string[] };
    if (original.phase !== "prerequisite-reported" || original.worker !== "pi" ||
        original.milestoneId !== report.milestoneId ||
        original.planVersion !== planVersion || original.jobId !== job.jobId ||
        original.expectedHead !== head || original.claimedPaths?.length ||
        original.prerequisite?.reportDigest !== report.reportDigest)
      return null;
    await authenticateEventNoWrite(job, original);
    return { store: "specialist-receipt", ref: relative, digest: report.reportDigest };
  }
  // A settled clean Interactive contradiction is different from an interrupted
  // writer or a malformed Pi response. A composite Puzzle may have advanced
  // HEAD through its authenticated Choice before the parent inventory updates.
  // Diagnosis never authorizes a replacement writer or upstream Plan mutation.
  if (operation === "specialist-result" && c.observation === "returned-failure" &&
      !s.active && !s.result && !s.causalAmendment &&
      s.inventory && c.origin.assignmentId) {
    const source = s.recoverySources.find(x => x.caseId === c.id && x.channel === "operationRecovery");
    const op = source?.input as GenerationOperationRecovery | undefined;
    const reported = op?.evidence.interactiveNoWrite;
    if (op?.evidence.resultStatus === "interactive-conflict-reported" &&
        reported && reported.expectedHead === head &&
        op.evidence.assignmentId === c.origin.assignmentId &&
        (c.origin.assignmentId === "interactive:" + reported.milestoneId ||
          c.origin.assignmentId === reported.domain + ":" + reported.milestoneId) &&
        s.inventory.items.some(item => item.id === c.origin.assignmentId && item.status === "blocked") &&
        s.failures[c.origin.assignmentId]) {
      const { inspectInteractiveConflict } = await import("./interactive-work.js");
      const original = await inspectInteractiveConflict(job, reported.milestoneId);
      if (original.domain === reported.domain && original.reportDigest === reported.reportDigest &&
          original.expectedHead === head && original.planVersion === s.planVersion &&
          (s.inventory.headSha === head ||
            original.domain === "puzzle" && c.origin.assignmentId === "interactive:" + reported.milestoneId &&
            s.inventory.headSha === original.precedingChoiceSource) &&
          original.worker === (s.request.fixture ? "fixture" : "pi"))
        return { store: "specialist-receipt", ref: original.relative, digest: original.reportDigest };
    }
  }
  if (operation === "adaptive-admission" && planVersion && c.observation === "exception" &&
      !s.active && !s.result && !s.ideaTask && !s.crossDomainCloseout &&
      !s.causalAmendment && !s.escalation) {
    const source = s.recoverySources.find(x => x.caseId === c.id && x.channel === "operationRecovery");
    const op = source?.input as GenerationOperationRecovery | undefined;
    if (op?.operation === "adaptive-admission" && op.outcome === "exception" &&
        op.source.headSha === head && op.source.turnDigest === turnDigest &&
        op.source.planVersion === planVersion &&
        op.evidence.reference === "generation-checkpoint" && !op.evidence.assignmentId &&
        !op.evidence.closeout && !op.evidence.eventNoWrite &&
        !op.evidence.interactiveNoWrite && !op.evidence.verifier) {
      const accepted = await inspectSettledAdaptiveReconciliation(job, s.request, c.origin);
      if (accepted) return accepted.receipt;
      const state = await readAdaptiveState(job, turnDigest, planVersion);
      const attempt = state?.attempts.at(-1);
      if (attempt?.sourceSha === head && ["rejected", "unchanged", "admitted"].includes(attempt.phase) &&
          attempt.session && attempt.effect?.phase === "responded")
        return { store: "response-contract", ref: attempt.signature,
          digest: attempt.session.sessionSha256 };
    }
  }
  // An independently accepted final report can disagree with a stale graph
  // inventory. This is not a pass grant: authenticate the original Pi Review
  // and checkpoint, allow one read-only assessment, and retain the blocked
  // inventory until source-based reconciliation actually succeeds.
  if (operation === "completion-verification" && c.observation === "returned-failure" &&
      !s.active && !s.result && !s.ideaTask && !s.escalation && !s.causalAmendment &&
      s.inventory?.headSha === head && s.inventory.planVersion === planVersion &&
      !authorizedInventoryComplete(s.inventory)) {
    const source = s.recoverySources.find(x => x.caseId === c.id && x.channel === "operationRecovery");
    const op = source?.input as GenerationOperationRecovery | undefined;
    if (op?.evidence.reference === "completion-report" &&
        op.evidence.resultStatus === "completed" && !op.evidence.completion &&
        op.source.headSha === head && op.source.planVersion === planVersion &&
        op.source.turnDigest === turnDigest) {
      const report = await inspectJobReport(s.request);
      const point = (await inspectRecoveryCheckpoints(job)).find(p =>
        p.eligible && p.commitSha === head && p.validation.status === "passed" &&
        (p.semanticReview === "passed" || p.semanticReview === "not-required"));
      if (report.identity.headSha === head && report.identity.clean &&
          report.generation.status === "completed" &&
          report.generation.review?.worker === "pi" && report.generation.review.current &&
          report.evidence.editorial.verdict === "pass" &&
          report.evidence.scope?.deterministic === "passed" &&
          report.evidence.protection.status === "checked" &&
          !report.evidence.authorApprovals.required &&
          !report.evidence.deferredIdeas.scopedOutstanding.length && point) {
        return { store: "completion-report", ref: c.origin.failureAnchor.ref,
          digest: createHash("sha256").update(JSON.stringify({ original: op,
            inventory: s.inventory, source: head, review: report.generation.review,
            checkpoint: point.proofDigest })).digest("hex") };
      }
    }
  }
  if (operation === "completion-verification" && c.observation === "returned-failure" &&
      !s.active && !s.result && !s.ideaTask && !s.escalation && !s.causalAmendment &&
      s.inventory?.headSha === head && s.inventory.planVersion === planVersion &&
      authorizedInventoryComplete(s.inventory)) {
    const source = s.recoverySources.find(x => x.caseId === c.id && x.channel === "operationRecovery");
    const op = source?.input as GenerationOperationRecovery | undefined;
    const original = op?.evidence.completion;
    const report = await inspectJobReport(s.request);
    const point = (await inspectRecoveryCheckpoints(job)).find(p =>
      p.eligible && p.commitSha === head && p.workItem === original?.checkpoint &&
      (p.semanticReview === "passed" || p.semanticReview === "not-required"));
    if (op?.evidence.reference !== "completion-report" || !original || !point ||
        report.identity.headSha !== head || !isTrustedFinalVerdictAnomaly(report) ||
        original.reportStatus !== report.generation.status ||
        original.scopeStatus !== report.generation.scopeFulfillment ||
        original.planStatus !== report.generation.planFulfillment.status)
      return null;
    const digest = createHash("sha256").update(JSON.stringify({
      operation: op, inventory: s.inventory, failedCheck: c.origin.failureAnchor,
      source: head, checkpointProof: point.proofDigest,
    })).digest("hex");
    return { store: "completion-report", ref: c.origin.failureAnchor.ref, digest };
  }
  if (!["independent-review", "completion-verification"].includes(operation)) return null;
  if (operation === "independent-review" &&
      (c.observation !== "returned-failure" && c.observation !== "exception" ||
        !s.active || s.active.id !== c.origin.assignmentId ||
        s.result?.headSha !== head ||
        (c.observation === "returned-failure" && s.escalation?.kind !== "dependency-replan")))
    return null;
  if (operation === "completion-verification" &&
      (c.observation !== "returned-failure" || !s.escalation)) return null;
  const point = (await inspectRecoveryCheckpoints(job)).find(p => p.eligible && p.commitSha === head &&
    p.assurance?.turnDigest === turnDigest && p.validation.status === "passed");
  if (!point?.assurance) return null;
  if (existsSync(join(job.stateDir, "review-repairs", head + ".json"))) {
    const repair = await inspectRejectedRepair(job, head);
    if (repair.phase !== "needs-plan" || !repair.outOfAuthority || point.semanticReview !== "failed") return null;
    return { store: "repair-ledger", ref: head, digest: repair.sourceReviewDigest };
  }
  if (point.semanticReview !== "passed" && point.semanticReview !== "not-required") return null;
  return { store: "review-checkpoint", ref: head, digest: point.proofDigest };
}
/** Reconstruct the settled independent verdict from its authenticated transcript. */
async function authenticateSettledReviewVerdict(job: JobStartResult,
  point: Awaited<ReturnType<typeof inspectRecoveryCheckpoints>>[number],
  result: NonNullable<NonNullable<Awaited<ReturnType<typeof inspectCheckpointReview>>>["result"]>,
  cycle: NonNullable<Awaited<ReturnType<typeof inspectPostcommitReviewCycle>>>,
  round: NonNullable<Awaited<ReturnType<typeof inspectPostcommitReviewCycle>>>["rounds"][number],
  expected: "pass" | "fail"): Promise<boolean> {
  // The per-checkpoint result file is mutable private state, not a signature.
  // Reconstruct its accepted verdict from the *original settled Pi transcript*
  // and compare both the review-cycle digest and controller-sealed findings.
  // Later independent correction rounds may append to the same conversation.
  const { prepareSemanticReview, independentReviewResults } =
    await import("./semantic-assignment-review.js");
  const { assignmentVerdictResponseContract } =
    await import("./narrative-review-specialist.js");
  const packet = await prepareSemanticReview(job, [point]);
  if (packet.sourceDigest !== round.packetDigest) return false;
  const transcript = (await readFile(cycle.reviewer.file)).subarray(0, round.transcriptBytes)
    .toString("utf8").trim().split("\n").map(line => JSON.parse(line) as {
      type?: string; message?: { role?: string; stopReason?: string;
        content?: Array<{ type?: string; text?: string }> } });
  const accepted = transcript.filter(r => r.type === "message" && r.message?.role === "assistant" &&
    r.message.stopReason === "stop").at(-1)?.message;
  if (!accepted) return false;
  const text = (accepted.content ?? []).filter(c => c.type === "text")
    .map(c => c.text ?? "").join("\n");
  const verdict = assignmentVerdictResponseContract(packet).parse(text);
  if (verdict.verdict !== expected ||
      createHash("sha256").update(JSON.stringify(verdict)).digest("hex") !== round.verdictDigest ||
      !isDeepStrictEqual(independentReviewResults(packet, verdict,
        "independent-pi-assignment-review")[0], result))
    return false;
  return true;
}

/** The sealed failed independent verdict, not a reviewer string, grants
 * reentry to the ORIGINAL Review/Repair controller after assessor selection.
 * This is read-only and cannot increment a Pi correction attempt. */
export async function originalFailedReviewProof(job: JobStartResult, s: State,
  c: RecoveryCase): Promise<RecoveryEvidence | null> {
  if (c.origin.operation !== "independent-review" ||
      c.observation !== "returned-failure" || s.request.fixture ||
      !s.request.turnPlanDigest || s.escalation?.requiresTrustedApproval ||
      !s.active || !s.result || s.active.id !== c.origin.assignmentId ||
      s.result.headSha !== c.origin.sourceHeadSha ||
      s.planVersion !== c.origin.planVersion)
    return null;
  const source = s.recoverySources.find(r => r.caseId === c.id && r.channel === "operationRecovery");
  const op = source?.input as GenerationOperationRecovery | undefined;
  if (op?.outcome !== "returned-failure" || op.operation !== "independent-review" ||
      op.evidence.reference !== "review-checkpoints" ||
      op.evidence.assignmentId !== s.active.id) return null;
  const point = (await inspectRecoveryCheckpoints(job)).find(p => p.eligible &&
    p.commitSha === c.origin.sourceHeadSha &&
    p.assurance?.turnDigest === c.origin.turnDigest &&
    p.assurance?.reviewSelection.status === "required-pending" &&
    p.semanticReview === "failed" && p.validation.status === "passed");
  if (!point?.assurance) return null;
  const reviewed = await inspectCheckpointReview(job, point);
  if (!reviewed || reviewed.status !== "failed" || reviewed.result?.status !== "failed" ||
      reviewed.result.reviewer !== "independent-pi-assignment-review" ||
      !reviewed.result.findings.length) return null;
  const cycle = await inspectPostcommitReviewCycle(job, point.commitSha, point.assurance.assignmentDigest);
  const round = cycle?.rounds.find(r => r.commitSha === point.commitSha);
  if (!cycle || cycle.turnDigest !== c.origin.turnDigest || !round) return null;
  if (!await authenticateSettledReviewVerdict(job, point, reviewed.result, cycle, round, "fail")) return null;
  return { store: "review-checkpoint", ref: point.commitSha,
    digest: createHash("sha256").update(JSON.stringify({
      assurance: point.assurance, verdict: reviewed.result,
    })).digest("hex") };
}
/** A settled specialist contradiction requests a separately authorized
 * owner/Plan amendment. Selection is not permission to change approved canon;
 * the C06 controller consumes this source-bound input for supersession. */
export async function originalNoWriteOwnerProof(job: JobStartResult, s: State,
  c: RecoveryCase): Promise<{ owner: string; proof: RecoveryEvidence } | null> {
  if (s.request.fixture || !s.request.turnPlanDigest ||
      c.origin.operation !== "specialist-result" || c.observation !== "returned-failure" ||
      s.active || s.result || s.causalAmendment || s.crossDomainCloseout ||
      s.escalation?.kind !== "dependency-replan" ||
      s.escalation.requiresTrustedApproval || !s.inventory ||
      !c.origin.assignmentId || !s.failures[c.origin.assignmentId] ||
      !s.inventory.items.some(item => item.id === c.origin.assignmentId && item.status === "blocked"))
    return null;
  const source = s.recoverySources.find(x => x.caseId === c.id && x.channel === "operationRecovery");
  const op = source?.input as GenerationOperationRecovery | undefined;
  if (op?.outcome !== "returned-failure" || op.operation !== "specialist-result" ||
      op.evidence.reference !== "specialist-receipt" ||
      op.evidence.assignmentId !== c.origin.assignmentId)
    return null;
  const interactive = op.evidence.interactiveNoWrite;
  if (op.evidence.resultStatus === "interactive-conflict-reported" && interactive &&
      interactive.expectedHead === c.origin.sourceHeadSha &&
      (c.origin.assignmentId === "interactive:" + interactive.milestoneId ||
        c.origin.assignmentId === interactive.domain + ":" + interactive.milestoneId)) {
    const { inspectInteractiveConflict } = await import("./interactive-work.js");
    const original = await inspectInteractiveConflict(job, interactive.milestoneId);
    if (original.domain !== interactive.domain || original.reportDigest !== interactive.reportDigest ||
        original.expectedHead !== c.origin.sourceHeadSha ||
        original.planVersion !== c.origin.planVersion || original.worker !== "pi" ||
        (s.inventory.headSha !== original.expectedHead &&
          !(original.domain === "puzzle" && c.origin.assignmentId === "interactive:" + interactive.milestoneId &&
            s.inventory.headSha === original.precedingChoiceSource))) return null;
    // The original approved Blueprint belongs to an independently pinned
    // Event review cycle, not to a new Choice plan authored by its reporter.
    const event = JSON.parse(await readFile(join(job.stateDir, "event-items",
      interactive.milestoneId.slice(10) + ".json"), "utf8")) as {
        assignment?: import("./event-specialist.js").EventAssignment;
        blueprintPin?: import("./milestone-blueprint.js").MilestoneBlueprintPin };
    if (!event.assignment || !event.blueprintPin) return null;
    const { readReviewedMilestoneBlueprint } = await import("./milestone-blueprint.js");
    await readReviewedMilestoneBlueprint(job, event.blueprintPin, event.assignment);
    return { owner: "architecture", proof: {
      store: "specialist-receipt", ref: original.relative, digest: original.reportDigest } };
  }
  const foundations = op.evidence.foundationsNoWrite;
  if (op.evidence.resultStatus === "foundations-conflict-reported" && foundations &&
      s.inventory.headSha === c.origin.sourceHeadSha &&
      foundations.expectedHead === c.origin.sourceHeadSha &&
      c.origin.assignmentId === "foundations") {
    const { inspectFoundationConflict } = await import("./character-world.js");
    const original = await inspectFoundationConflict(job, foundations.domain);
    if (original.reportDigest !== foundations.reportDigest ||
        original.expectedHead !== c.origin.sourceHeadSha ||
        original.planVersion !== c.origin.planVersion || original.worker !== "pi") return null;
    return { owner: "architecture", proof: {
      store: "specialist-receipt", ref: original.relative, digest: original.reportDigest } };
  }
  return null;
}
export function matchesOriginalCloseout(s: State, c: RecoveryCase, pending: NonNullable<State["crossDomainCloseout"]>): boolean {
  const source = s.recoverySources.find(x => x.caseId === c.id && x.channel === "operationRecovery");
  const evidence = source?.input.evidence as GenerationOperationRecovery["evidence"] | undefined;
  return !!evidence?.closeout && evidence.closeout.repairId === pending.repairId &&
    evidence.closeout.proposalDigest === pending.proposalDigest &&
    evidence.closeout.milestoneId === pending.milestoneId && pending.sourceSha === c.origin.sourceHeadSha &&
    pending.planVersion === c.origin.planVersion && evidence.assignmentId === c.origin.assignmentId;
}
/** The checkpointed negative private Review is not a canonical Git failure.
 * Authenticate the original child and source before admitting only its
 * read-only Blueprint progression in the parent assessor. */
async function originalBlueprintAssessment(job: JobStartResult, s: State, c: RecoveryCase) {
  const op = s.recoverySources.find(x => x.caseId === c.id && x.channel === "operationRecovery")?.input as GenerationOperationRecovery | undefined;
  const ref = op?.evidence.blueprintAssessment;
  if (!ref) return null;
  if (s.request.fixture || c.origin.operation !== "specialist-result" || c.observation !== "returned-failure" ||
      op?.evidence.resultStatus !== "blueprint-assessment" || op.evidence.reference !== "specialist-receipt" ||
      s.active?.id !== c.origin.assignmentId || s.result || s.inventory?.headSha !== c.origin.sourceHeadSha)
    throw Error("Original Blueprint assessment lost its active parent assignment.");
  const proof = await readBlueprintAssessment(job, ref);
  const story = proof.identity.assignmentId === "story-blueprint";
  if (proof.identity.sourceHeadSha !== c.origin.sourceHeadSha ||
      proof.identity.planVersion !== (c.origin.planVersion ?? 1) ||
      proof.identity.turnDigest !== c.origin.turnDigest ||
      (story ? s.active?.stage !== "architecture" :
        s.active?.stage !== "event" || proof.identity.assignmentId !== "milestone-blueprint:" + s.active.milestone))
    throw Error("Original Blueprint assessment does not match its authenticated Turn and scope.");
  await assertSource(job, s, c);
  return { ref, proof, evidence: { store: "specialist-receipt" as const,
    ref: "blueprint-assessments/" + ref.key + "-" + ref.round + ".json", digest: ref.digest } };
}

export async function selectOperationStrategy(job: JobStartResult, s: State, c: RecoveryCase): Promise<RecoveryDecision | null> {
  if (s.request.fixture || !s.request.turnPlanDigest) return null;
  const originalOperation = s.recoverySources.find(x => x.caseId === c.id &&
    x.channel === "operationRecovery")?.input as GenerationOperationRecovery | undefined;
  const blueprint = await originalBlueprintAssessment(job, s, c);
  if (blueprint)
    return { ...base(c, blueprint.evidence), action: "known-correction",
      adapter: "review-cycle", receipt: blueprint.evidence };
  if (originalOperation?.evidence.protocolFailure) {
    const proof = await authenticateNonSpecialistProtocolFailure(job, originalOperation);
    if (!proof || c.kind !== "protocol") throw Error("Original non-specialist protocol evidence changed");
    return { ...base(c, proof), action: "exhausted", reason: "protocol-exhausted", attemptRefs: [proof] };
  }
  if (originalOperation?.evidence.failureKind === "integrity")
    return { ...base(c), action: "integrity-fence", reason: "untrusted-receipt",
      requiredInspection: "Authenticate the original source and invocation; no replacement model call is authorized." };
  const assignmentFailure = await originalAssignmentFailure(job, s, c);
  if (assignmentFailure && assessBoundedAssignmentFailure(assignmentFailure.proof.kind) === "exhausted") {
    const proof = { store: "response-contract" as const, ref: assignmentFailure.ref,
      digest: assignmentFailure.proof.receiptDigest };
    return { ...base(c, proof), action: "exhausted", reason: "protocol-exhausted", attemptRefs: [proof] };
  }
  if (assignmentFailure?.proof.kind === "nonconverging" && c.origin.operation === "independent-review") {
    const proof = { store: "specialist-receipt" as const, ref: assignmentFailure.ref,
      digest: assignmentFailure.proof.receiptDigest };
    await assertSource(job, s, c);
    return { ...base(c, proof), action: "diagnostic", adapter: "unknown-diagnostic", mode: "read-only", attemptRef: null };
  }
  const owner = await originalNoWriteOwnerProof(job, s, c);
  if (owner) {
    await assertSource(job, s, c);
    return { ...base(c, owner.proof), action: "plan-amendment",
      adapter: "dependency-work", owner: owner.owner, scopeRef: owner.proof };
  }
  const reviewProof = await originalFailedReviewProof(job, s, c);
  if (reviewProof) {
    if (!usesSharedAssignmentReview(c.origin.assignmentId) || !await authenticateFoundationReviewHead(job, c.origin.sourceHeadSha))
      await assertSource(job, s, c);
    return { ...base(c, reviewProof), action: "known-correction",
      adapter: "review-cycle", receipt: reviewProof };
  }
  const pending = s.crossDomainCloseout;
  if (pending && matchesOriginalCloseout(s, c, pending) && c.origin.operation === "dependency-amendment" && s.active?.stage === "composition" &&
      pending.milestoneId === s.active.milestone && pending.planVersion === c.origin.planVersion &&
      pending.sourceSha === c.origin.sourceHeadSha && s.active.id === c.origin.assignmentId && !s.result) {
    await assertSource(job, s, c);
    const checked = await preflightCompositionBoundary(job, s.request, pending.milestoneId, pending.planVersion);
    if (checked.kind !== "repair" || checked.repairId !== pending.repairId || checked.proposal.digest !== pending.proposalDigest)
      throw Error("Original prerequisite amendment is no longer verified");
    const scopeRef = { store: "repair-ledger" as const, ref: checked.repairId, digest: checked.proposal.digest };
    return { ...base(c, scopeRef), action: "plan-amendment", adapter: "cross-domain-closeout", owner: "event", scopeRef };
  }
  const proof = await diagnosticEvidence(job, s, c);
  if (!proof) return null;
  await assertSource(job, s, c);
  return { ...base(c, proof), action: "diagnostic", adapter: "unknown-diagnostic", mode: "read-only", attemptRef: null };
}
/** The saved decision may identify a real accepted Pi response yet have lost
 * the ORIGINAL selected source proof (e.g. an altered review/repair receipt).
 * Re-read that proof at the same HEAD; never let checkpoint data rebind it. */
export async function authenticateOperationOwnerProof(job: JobStartResult, s: State,
  c: RecoveryCase, d: RecoveryDecision): Promise<boolean> {
  if (d.action !== "plan-amendment" || d.adapter !== "dependency-work" ||
      d.owner !== "architecture") return false;
  const original = await originalNoWriteOwnerProof(job, s, c);
  return !!original && original.owner === d.owner &&
    isDeepStrictEqual(original.proof, d.scopeRef) &&
    isDeepStrictEqual(d.evidence, [...c.evidence, original.proof]);
}
export async function authenticateOperationReviewProof(job: JobStartResult, s: State,
  c: RecoveryCase, d: RecoveryDecision): Promise<boolean> {
  if (d.action !== "known-correction" || d.adapter !== "review-cycle") return false;
  try {
  const blueprint = await originalBlueprintAssessment(job, s, c);
  if (blueprint) return !d.reviewAssessment && isDeepStrictEqual(d.receipt, blueprint.evidence) &&
    isDeepStrictEqual(d.evidence, [...c.evidence, blueprint.evidence]);
  const original = await originalFailedReviewProof(job, s, c);
  if (!original || !isDeepStrictEqual(original, d.receipt) ||
      !isDeepStrictEqual(d.evidence, [...c.evidence, original])) return false;
  if (!d.reviewAssessment) return true;
  return usesSharedAssignmentReview(c.origin.assignmentId) &&
    isDeepStrictEqual(d.reviewAssessment,
      await inspectFoundationReviewBoundary(job, c.origin.sourceHeadSha, d.reviewAssessment));
  } catch { return false; }
}
export async function authenticateFoundationReviewExhaustion(job: JobStartResult, s: State,
  c: RecoveryCase, d: RecoveryDecision): Promise<boolean> {
  if (d.action !== "exhausted" || d.reason !== "nonconverging" || !d.reviewAssessment ||
      !usesSharedAssignmentReview(c.origin.assignmentId) || c.origin.operation !== "independent-review") return false;
  try {
  const original = await originalFailedReviewProof(job, s, c);
  const terminal = await inspectFoundationReviewStop(job, c.origin.sourceHeadSha, d.reviewAssessment);
  return !!original && !!terminal && isDeepStrictEqual(d.attemptRefs, [terminal]) &&
    isDeepStrictEqual(d.evidence, [...c.evidence, original, terminal]);
  } catch { return false; }
}

export async function authenticateOperationDiagnosticProof(job: JobStartResult, s: State,
  c: RecoveryCase, d: RecoveryDecision): Promise<boolean> {
  const original = await diagnosticEvidence(job, s, c);
  return !!original && isDeepStrictEqual(original, d.evidence.at(-1)) &&
    isDeepStrictEqual(d.evidence.slice(0, -1), c.evidence);
}
/** A diagnostic may only select this bounded, existing Foundation writer
 * adapter. Owner, scope, source, defect and actual prerequisites are checked
 * independently; prose is never a writer grant. */
function foundationDiagnosticDecision(c: RecoveryCase,
  diagnostic: RecoveryDecision, proposal: RecoveryDiagnosticProposal): RecoveryDecision | null {
  const proof = diagnostic.evidence.at(-1);
  if (c.origin.operation !== "specialist-result" || c.origin.assignmentId !== "foundation" ||
      c.kind !== "semantic" || c.observation !== "returned-failure" ||
      proposal.strategy !== "local-repair" || proposal.category !== "defect" ||
      proposal.owner !== "foundation" || proposal.scopeRef !== proposal.sourceRef ||
      proposal.prerequisites.length || !proof?.digest || proof.store !== "specialist-receipt" ||
      proposal.sourceRef !== [proof.store, proof.ref, proof.digest].join(":") ||
      !isDeepStrictEqual(diagnostic.evidence.slice(0, -1), c.evidence) ||
      diagnostic.caseId !== c.id || diagnostic.checkedSourceHeadSha !== c.origin.sourceHeadSha)
    return null;
  return { ...base(c, proof), action: "known-correction", adapter: "assignment-diagnostic", receipt: proof };
}

function foundationDiagnosticDefects(failure: { defects: readonly import("./assignment-metadata-recovery.js").AssignmentDefect[] }) {
  return failure.defects.length > 0 && failure.defects.every(d =>
    d.path.startsWith("creative-direction/") &&
    (d.kind === "metadata" && ["schema", "yaml", "frontmatter"].includes(d.code) ||
     d.kind === "provenance" && d.code === "missing-author-provenance"));
}

/** A pause retains the original diagnostic decision's receipt, not a new
 * writer allowance. The actual proposal/attempt is re-read on resumption. */
export function foundationDiagnosticDecisionForLifecycle(l: RecoveryLifecycle): RecoveryDecision | null {
  const d = l.decision;
  if (l.active?.origin.operation !== "specialist-result" ||
      l.active.origin.assignmentId !== "foundation" || l.attempt?.purpose !== "diagnosis") return null;
  if (d?.action === "known-correction" && d.adapter === "assignment-diagnostic") return d;
  if (d?.action === "pause" && d.resumeRef?.store === "specialist-receipt" &&
      isDeepStrictEqual(d.resumeRef, d.evidence.at(-1)))
    return { ...base(l.active, d.resumeRef), action: "known-correction",
      adapter: "assignment-diagnostic", receipt: d.resumeRef };
  return null;
}

/** Re-read the exact diagnosis, not its graph projection, and reauthenticate
 * the original terminal and any already admitted successor. */
export async function authenticateFoundationDiagnosticDecision(job: JobStartResult,
  c: RecoveryCase, source: GenerationOperationRecovery, d: RecoveryDecision,
  expectedAttempt?: RecoveryAttempt | null, historicalHead?: string) {
  if (d.action !== "known-correction" || d.adapter !== "assignment-diagnostic" ||
      c.origin.jobId !== job.jobId || c.origin.jobThreadId !== job.threadId ||
      source.source.jobId !== job.jobId || source.source.threadId !== c.origin.graphThreadId ||
      source.operation !== "specialist-result" || source.evidence.assignmentId !== "foundation" ||
      source.outcome !== "returned-failure" || source.source.headSha !== c.origin.sourceHeadSha ||
      source.source.turnDigest !== c.origin.turnDigest || source.source.planVersion !== c.origin.planVersion ||
      source.evidence.assignmentFailure?.proof.kind !== "nonconverging" ||
      source.evidence.assignmentFailure.sourceHeadSha !== c.origin.sourceHeadSha ||
      source.evidence.assignmentFailure.proof.receiptDigest !== d.receipt.digest)
    return null;
  const target = diagnosticCaseForDecision(c, d);
  const proposal = await inspectOriginalUnknownDiagnosis(job, target);
  if (!("strategy" in proposal) || !isDeepStrictEqual(d, foundationDiagnosticDecision(c, d, proposal))) return null;
  const attempt = await inspectDiagnosticAttempt(job, target, c.id);
  if (attempt.phase !== "settled" || attempt.mode !== "read-only" ||
      (expectedAttempt !== undefined && !isDeepStrictEqual(attempt, expectedAttempt))) return null;
  const authorization = { terminalDigest: d.receipt.digest!,
    decisionDigest: pendingDigest({ decision: d, attempt, proposal }), advice: proposal.diagnosis };
  const terminal = await inspectFoundationDiagnosticFailure(job, c.origin.sourceHeadSha,
    source.evidence.assignmentFailure.proof, authorization, historicalHead);
  if (!terminal || terminal.ref !== d.receipt.ref || !foundationDiagnosticDefects(terminal)) return null;
  return { terminal, authorization };
}

export async function authenticateFoundationDiagnosticDischarge(job: JobStartResult, c: RecoveryCase,
  source: GenerationOperationRecovery, correction: RecoveryEvidence, head: string): Promise<boolean> {
  if (correction.store !== "specialist-receipt" || c.origin.assignmentId !== "foundation" ||
      !source.evidence.assignmentFailure || head === c.origin.sourceHeadSha) return false;
  const proof = { store: "specialist-receipt" as const, ref: correction.ref,
    digest: source.evidence.assignmentFailure.proof.receiptDigest };
  const d = { ...base(c, proof), action: "known-correction" as const, adapter: "assignment-diagnostic" as const, receipt: proof };
  const original = await authenticateFoundationDiagnosticDecision(job, c, source, d, undefined, head);
  if (!original || correction.digest !== original.authorization.decisionDigest ||
      original.terminal.invocationProof?.ordinal !== original.terminal.proof.ordinal + 1) return false;
  const point = (await inspectRecoveryCheckpoints(job)).find(p => p.eligible &&
    p.workItem === "foundation" && p.commitSha === head && p.parentSha === c.origin.sourceHeadSha &&
    p.validation.status === "passed" && p.semanticReview === "passed" &&
    p.assurance?.turnDigest === c.origin.turnDigest && p.planVersion === c.origin.planVersion);
  if (!point?.assurance) return false;
  const reviewed = await inspectCheckpointReview(job, point);
  if (reviewed?.status !== "passed" || reviewed.result?.status !== "passed" ||
      reviewed.result.reviewer !== "independent-pi-assignment-review") return false;
  const cycle = await inspectPostcommitReviewCycle(job, head, point.assurance.assignmentDigest);
  const round = cycle?.rounds.find(r => r.commitSha === head);
  return !!cycle && cycle.turnDigest === c.origin.turnDigest && !!round &&
    cycle.reviewer.id !== original.terminal.sessionId &&
    await authenticateSettledReviewVerdict(job, point, reviewed.result, cycle, round, "pass");
}

/** The proposal cannot select an adaptive reconciliation unless the original
 * controller admission and the actual Pi transcript independently agree. */
export async function authorizeOperationDiagnosticStrategy(job: JobStartResult, s: State, c: RecoveryCase,
  diagnostic: Extract<RecoveryDecision, { action: "diagnostic" }>, proposal: RecoveryDiagnosticProposal) {
  const local = foundationDiagnosticDecision(c, diagnostic, proposal);
  if (local) {
    const original = await originalAssignmentFailure(job, s, c);
    if (!original || original.proof.kind !== "nonconverging" ||
        !foundationDiagnosticDefects(original) || original.ref !== local.evidence.at(-1)?.ref ||
        original.proof.receiptDigest !== local.evidence.at(-1)?.digest) return null;
    return local;
  }
  const adaptive = c.origin.operation === "adaptive-admission" ?
    await inspectSettledAdaptiveReconciliation(job, s.request, c.origin) : null;
  return authorizeDiagnosticStrategy(s, c, diagnostic, proposal, adaptive?.receipt);
}

export function diagnosticCaseForDecision(c: RecoveryCase, d: RecoveryDecision) {
  const proof = d.evidence.at(-1);
  if (!proof?.digest || !["repair-ledger", "response-contract", "review-checkpoint",
    "specialist-receipt", "graph-checkpoint", "completion-report"].includes(proof.store))
    throw Error("Operation diagnosis has no settled effect reference");
  return operationDiagnosisCase(c, [proof.store, proof.ref, proof.digest].join(":"));
}
/** A persisted diagnostic stop is not self-authenticating. Direct graph
 * reentry must verify the ORIGINAL Pi session and accepted response, just as
 * read-only CLI inspection does, before preserving the terminal disposition. */
export async function authenticateSealedDiagnosticStop(job: JobStartResult, s: State,
  lifecycle: RecoveryLifecycle): Promise<boolean> {
  const c = lifecycle.active, d = lifecycle.decision;
  if (!c || d?.action !== "diagnostic-stop" || !lifecycle.attempt ||
      d.disposition !== "operator-intervention") return false;
  const source = s.recoverySources.find(x => x.caseId === c.id);
  if (source?.channel === "operationRecovery" &&
      !await authenticateOperationDiagnosticProof(job, s, c, d)) return false;
  const target = source?.channel === "operationRecovery" ? diagnosticCaseForDecision(c, d) :
    source?.channel === "unknownRecovery" ? (source.input as { case?: UnknownRecoveryCase }).case : null;
  if (!target) return false;
  const sealed = await inspectOriginalUnknownDiagnosis(job, target);
  const attempt = await inspectDiagnosticAttempt(job, target, c.id);
  return isDeepStrictEqual(attempt, lifecycle.attempt) &&
    d.receipt.store === "response-contract" && d.receipt.ref === target.signature &&
    ("proposal" in d && d.proposal ? "strategy" in sealed && isDeepStrictEqual(d.proposal, sealed) :
      "action" in sealed && d.recommendation === sealed.action && d.advisoryCategory === sealed.category);
}

export async function executeOperationStrategy(job: JobStartResult, s: State, lifecycle: RecoveryLifecycle): Promise<Partial<State> | null> {
  const c = lifecycle.active!, d = lifecycle.decision!;
  if (!lifecycle.assessorPending || !d || !c || !s.recoverySources.some(x => x.caseId === c.id && x.channel === "operationRecovery") ||
      (d.action !== "diagnostic" &&
        !(d.action === "plan-amendment" && ["cross-domain-closeout", "dependency-work"].includes(d.adapter)) &&
        !(d.action === "known-correction" && d.adapter === "review-cycle"))) return null;
  if (d.action === "known-correction") {
    const original = s.recoverySources.find(x => x.caseId === c.id && x.channel === "operationRecovery")?.input as GenerationOperationRecovery | undefined;
    if (original?.evidence.blueprintAssessment) {
      const settled = { ...lifecycle, assessorPending: false };
      const stop = (decision: RecoveryDecision, reason: string, status: State["status"]) =>
        ({ recoveryLifecycle: decideRecovery(settled, decision), reason, status });
      try {
        const source = await originalBlueprintAssessment(job, s, c);
        if (!source || !isDeepStrictEqual(await selectOperationStrategy(job, s, c), d))
          throw Error("Blueprint reassessment has no original source-bound decision.");
        const control = await readJobControl(job);
        if (control !== "running")
          return stop({ ...base(c), action: "pause", reason: control === "cancelled" ? "cancelled" : "author-pause", resumeRef: d.receipt },
            "Author control precedes Blueprint reassessment.", control);
        const author = await withStoryJobLock(job, "blueprint-reassessment-author-intake", () => processAuthorUpdatesAfterWork(job));
        if ("error" in author) throw Error("Blueprint reassessment could not authenticate author intake.");
        if (author.status !== "ready")
          return stop({ ...base(c), action: "pause", reason: author.status === "cancelled" ? "cancelled" : "author-pause", resumeRef: d.receipt },
            "Author intake precedes Blueprint reassessment.", author.status === "cancelled" ? "cancelled" : "paused");
        await assertSource(job, s, c);
        const round = { assignmentKey: source.proof.parentAssignmentKey, command: { phase: "invoke" as const } };
        const blueprintAssessment = { caseId: c.id, ref: source.ref };
        const result = source.proof.identity.assignmentId === "story-blueprint"
          ? await (await import("./architecture.js")).runArchitectureJob({ ...s.request, action: "run", round, blueprintAssessment })
          : await (async () => {
              const milestone = s.active!.milestone!;
              const event = JSON.parse(await readFile(join(job.stateDir, "event-items", milestone.slice(10) + ".json"), "utf8"));
              return (await import("./event-work.js")).runEventWorkItem({ ...s.request, action: "run",
                milestone, task: event.blueprintTask, round, blueprintAssessment });
            })();
        if (result.status !== "blueprint-approved" || !("blueprintPin" in result) || !result.blueprintPin ||
            await trustedHead(job) !== c.origin.sourceHeadSha || git(job, "status", "--porcelain").trim())
          throw Error("Blueprint reassessment did not settle an independently approved, unchanged source.");
        return { recoveryLifecycle: finishVerifiedRecovery(settled, { status: "verified", caseId: c.id,
          sourceHeadSha: c.origin.sourceHeadSha, assurance: { store: "specialist-receipt",
            ref: source.proof.identity.assignmentId === "story-blueprint"
              ? "architecture-blueprints/plan-" + source.proof.identity.planVersion + "-approved.json"
              : "milestone-blueprints/" + s.active!.milestone!.slice(10) + ".json",
            digest: createHash("sha256").update(JSON.stringify(result.blueprintPin)).digest("hex") } }, true),
          reason: null, status: "running" };
      } catch (error) {
        if (error instanceof PiModelUnavailableError || error instanceof Error && error.name === "PiBudgetPause")
          return stop({ ...base(c), action: "pause",
            reason: error instanceof PiModelUnavailableError ? "provider-unavailable" : "budget", resumeRef: d.receipt },
            error.message, "paused");
        if (error instanceof Error && error.name === "StoryCancelledError")
          return stop({ ...base(c), action: "pause", reason: "cancelled", resumeRef: d.receipt }, error.message, "cancelled");
        return stop({ ...base(c), action: "integrity-fence", reason: "untrusted-receipt",
          requiredInspection: "Inspect the original negative Blueprint, independent diagnosis, and exact settled sessions; no canonical writer was authorized." },
          error instanceof Error ? error.message : String(error), "blocked");
      }
    }
    const foundation = usesSharedAssignmentReview(c.origin.assignmentId);
    try {
    if (!foundation || !await authenticateFoundationReviewHead(job, c.origin.sourceHeadSha))
      await assertSource(job, s, c);
    if (!await authenticateOperationReviewProof(job, s, c, d))
      throw Error("Original failed Review source no longer matches the saved correction decision");
    if (foundation) {
      // A returned child boundary is not a new failure or a dispatch grant.
      // First checkpoint the exact selected assessment, then execute only it.
      const stop = (decision: RecoveryDecision, reason: string, status: State["status"]) =>
        ({ recoveryLifecycle: { ...decideRecovery(lifecycle, decision), assessorPending: false }, reason, status });
      const control = await readJobControl(job);
      if (control !== "running")
        return stop({ ...base(c), action: "pause", reason: control === "cancelled" ? "cancelled" : "author-pause" },
          "Author control precedes Review reassessment.", control);
      if (d.reviewAssessment) {
        try {
          const result = await withStoryJobLock(job, "assess-foundation-review", () =>
            executeFoundationReviewAssessment(job, c.origin.sourceHeadSha, d.reviewAssessment!));
          if (result.stop && assessBoundedAssignmentFailure("nonconverging", "stop") === "exhausted")
            return stop({ ...base(c, d.receipt), evidence: [...c.evidence, d.receipt, result.stop],
              action: "exhausted", reason: "nonconverging", attemptRefs: [result.stop],
              reviewAssessment: d.reviewAssessment }, result.reason ?? "Review requires a new authorized strategy.", "blocked");
          if (result.protectedApproval)
            return stop({ ...base(c, d.receipt), action: "pause", reason: "protected-approval", resumeRef: d.receipt },
              result.reason!, "blocked");
          const { reviewAssessment: _selected, ...ordinary } = d;
          return { recoveryLifecycle: { ...decideRecovery(lifecycle, ordinary), assessorPending: false },
            reason: null, status: "running" };
        } catch (error) {
          if (error instanceof PiModelUnavailableError || error instanceof Error && error.name === "PiBudgetPause")
            return stop({ ...base(c, d.receipt), action: "pause",
              reason: error instanceof PiModelUnavailableError ? "provider-unavailable" : "budget", resumeRef: d.receipt },
              error.message, "paused");
          throw error;
        }
      }
      if (await inspectNativeReviewFailure(job, c.origin.sourceHeadSha, c.id)) {
        const selected = await selectOperationStrategy(job, s, c);
        if (selected?.action === "exhausted") return stop(selected, "Original Review native response protocol exhausted.", "blocked");
        if (selected?.action !== "diagnostic") throw Error("Review native terminal has no shared assessment");
        return { recoveryLifecycle: { ...decideRecovery(lifecycle, selected), assessorPending: true },
          status: "running", reason: null };
      }
      const boundary = await inspectFoundationReviewBoundary(job, c.origin.sourceHeadSha);
      if (boundary)
        return { recoveryLifecycle: { ...decideRecovery(lifecycle, { ...d, reviewAssessment: boundary }),
          assessorPending: true }, status: "running", reason: null };
    }
    // The graph reenters the original assignment child after shared admission.
    return { recoveryLifecycle: { ...lifecycle, assessorPending: false }, status: "running" };
    } catch (error) {
      if (!foundation) throw error;
      return { recoveryLifecycle: { ...decideRecovery(lifecycle, {
        ...base(c), action: "integrity-fence", reason: "untrusted-receipt",
        requiredInspection: "Reconcile the original writer/reviewer session and exact Review assessment; do not replay uncertain effects.",
      }), assessorPending: false }, status: "blocked",
        reason: error instanceof Error ? error.message : String(error) };
    }
  }
  const settled = { ...lifecycle, assessorPending: false };
  const stop = (decision: RecoveryDecision, reason: string, status: State["status"] = "blocked"): Partial<State> => ({
    recoveryLifecycle: decideRecovery(settled, decision), reason, status,
  });
  try {
    const control = await readJobControl(job);
    if (control !== "running") return stop({ ...base(c), action: "pause", reason: control === "paused" ? "author-pause" : "cancelled" }, "Author control precedes corrective work.", control);
    const originalDraft = await originalAssignmentFailure(job, s, c);
    // No author-update mutation may run against an uncommitted rejected
    // draft. A settled original failure permits ONLY a tool-free diagnostic;
    // ordinary author intake remains mandatory before any successor writer.
    if (originalDraft) {
      if (d.action !== "diagnostic" || originalDraft.proof.kind !== "nonconverging")
        throw Error("Unfinished assignment permits only independent read-only diagnosis.");
    } else {
      const author = await withStoryJobLock(job, "recovery-author-intake", () => processAuthorUpdatesAfterWork(job));
      if ("error" in author) throw Error("Author receipts could not be authenticated");
      if (author.status !== "ready") return stop({ ...base(c), action: "pause", reason: author.status === "cancelled" ? "cancelled" :
        author.status === "paused" ? "author-pause" : "author-choice" }, "Author boundary precedes corrective work.", author.status === "cancelled" ? "cancelled" : "paused");
    }
    if (d.action === "plan-amendment" && d.adapter === "dependency-work") {
      await assertSource(job, s, c);
      if (!await authenticateOperationOwnerProof(job, s, c, d))
        throw Error("Owner correction lost the original negative specialist Pi report.");
      const original = s.recoverySources.find(x => x.caseId === c.id &&
        x.channel === "operationRecovery")?.input as GenerationOperationRecovery | undefined;
      const source = original?.evidence.interactiveNoWrite;
      if (source?.domain === "choice" && c.origin.assignmentId === "interactive:" + source.milestoneId &&
          s.inventory && s.inventory.headSha === c.origin.sourceHeadSha &&
          s.inventory.items.some(i => i.id === c.origin.assignmentId && i.status === "blocked") &&
          s.failures[c.origin.assignmentId]) {
        const architecture = JSON.parse(await readFile(join(job.stateDir, "architecture.json"), "utf8")) as {
          jobId?: string; phase?: string; plan?: import("./architecture.js").Plan };
        if (architecture.jobId !== job.jobId || architecture.phase !== "committed" ||
            architecture.plan?.version !== s.planVersion)
          throw Error("The original approved Architecture plan is missing from C06.");
        const { resolveAdaptiveNoWriteSupersession } = await import("./adaptive-work.js");
        const result = await withStoryJobLock(job, "generation-c06-interactive-supersession", () =>
          resolveAdaptiveNoWriteSupersession({ job, request: s.request, plan: architecture.plan!,
            inventory: s.inventory!, assignmentId: c.origin.assignmentId!,
            pinnedVersion: s.adaptiveVersion }));
        if (result.outcome === "corrected" && result.proof && result.sourceSha && result.version) {
          const proof = result.proof;
          const priorFailures = { ...s.failures };
          delete priorFailures[c.origin.assignmentId];
          const inventory = { ...s.inventory, items: s.inventory.items.map(item =>
            item.id === c.origin.assignmentId ? { ...item,
              status: "verified" as const, verifiedSha: result.sourceSha,
              omission: { reason: "Independently reviewed C06 source-bound no-write supersession",
                evidence: proof.evidence, reviewerSession: proof.reviewerSession },
              blockingReason: undefined } : item) };
          const completedStages = [...s.completedStages.filter(e =>
            !(e.stage === "interactive" && e.milestone === source.milestoneId)), {
            stage: "interactive" as const, milestone: source.milestoneId,
            headSha: result.sourceSha, status: "interactive-slice-committed",
            planVersion: s.planVersion!,
          }];
          const settled = { ...lifecycle, assessorPending: false };
          return { recoveryLifecycle: finishVerifiedRecovery(settled,
            { status: "verified", caseId: c.id, sourceHeadSha: result.sourceSha,
              assurance: { store: "specialist-receipt",
                ref: "interactive-event-only/" + source.milestoneId.slice(10) + ".json",
                digest: proof.eventOnly?.digest } }, true),
            inventory, failures: priorFailures, completedStages, adaptiveVersion: result.version,
            active: null, result: null, escalation: null, status: "running", reason: null };
        }
        if (result.outcome === "declined") return {
          recoveryLifecycle: { ...lifecycle, assessorPending: false }, status: "blocked",
          reason: (result.decline === "protected-author" ?
            "The original author explicitly requires the targeted Choice/Puzzle. " :
            result.decline === "story-wide-obligation" ?
            "The original Story-wide Interaction profile still requires consequential gameplay. " :
            "Independent omission Review retained this Milestone's required Choice/Puzzle. ") +
            "The original no-write specialist and author commitments are preserved; " +
            "a separate source-backed owner correction is required.",
          escalation: { kind: "dependency-replan",
            requiresTrustedApproval: result.decline === "protected-author",
            sources: [{ source: source.milestoneId,
              message: result.decline === "independent-review" ?
                "Source-bound independent Review retained the mandatory local Interactive obligation" :
                "Authenticated author/Story-wide scope retains the missing Interactive obligation",
              repair: "interactive" }],
            action: "Have the Interactive plan owner correct the cited missing Choice/Puzzle " +
              "within the authenticated original author objective, or obtain a separately " +
              "reviewed prerequisite amendment before dispatch. Do not replay the original " +
              "negative Choice session or substitute an invented no-write approval." } };
      }
      return { recoveryLifecycle: { ...lifecycle, assessorPending: false },
        status: "blocked", reason: "Authenticated no-write requires an independently " +
          "reviewed Architecture or Work-plan amendment; no new writer scope was granted.",
        escalation: { kind: "dependency-replan", requiresTrustedApproval: false,
          sources: [{ source: d.scopeRef.ref, message: "Original source-bound no-write",
            repair: "controller-authorized Architecture/Work-plan amendment" }],
          action: "Review original prerequisites and independently approve a bounded owner correction." } };
    }
    if (d.action === "plan-amendment") {
      const pending = s.crossDomainCloseout!;
      if (!matchesOriginalCloseout(s, c, pending) ||
          !isDeepStrictEqual(d.evidence, [...c.evidence, d.scopeRef]) ||
          d.scopeRef.digest !== pending.proposalDigest || d.scopeRef.ref !== pending.repairId ||
          pending.sourceSha !== c.origin.sourceHeadSha || pending.planVersion !== c.origin.planVersion ||
          pending.milestoneId !== s.active?.milestone || s.active?.id !== c.origin.assignmentId)
        throw Error("Saved prerequisite correction differs from original admission");
      const { policy } = await inspectPiPolicy(job);
      const result = await advanceCrossDomainCloseout({ ...s.request,
        provider: s.request.provider ?? policy.profile.provider,
        model: s.request.model ?? policy.profile.model,
        originalInventory: s.inventory ?? undefined,
        milestoneId: pending.milestoneId, planVersion: pending.planVersion, expected: pending });
      if (result.status !== "verified" || !result.headSha) throw Error("Prerequisite has no verified successor");
      return { recoveryLifecycle: finishVerifiedRecovery(settled, { status: "verified", caseId: c.id,
        sourceHeadSha: result.headSha, assurance: { store: "repair-ledger", ref: pending.repairId } }, true),
        crossDomainCloseout: null, active: null, result: null, reason: null, status: "running" };
    }
    return await withStoryJobLock(job, "assess-original-operation-diagnostic", async () => {
      if (!isDeepStrictEqual(await selectOperationStrategy(job, s, c), d)) throw Error("Original diagnosis source changed");
      const target = diagnosticCaseForDecision(c, d);
      const { policy } = await inspectPiPolicy(job);
      const packet = diagnosticPacket(s, c, target);
      if (originalDraft) {
        packet.existingFindings = {
          original: packet.existingFindings, assignmentDefects: originalDraft.defects,
          observation: "Repeated source-bound native/provenance correction did not converge; draft remains uncommitted.",
        };
        if (c.origin.assignmentId === "foundation" && c.origin.operation === "specialist-result" &&
            foundationDiagnosticDefects(originalDraft))
          packet.availableAdapters = ["local-repair: owner=foundation, scopeRef=exact sourceRef; only original native defects, no other owner or new prerequisites"];
      }
      await diagnoseUnknownCompletion(job, target, s.request.provider ?? policy.profile.provider,
        s.request.model ?? policy.profile.model, packet);
      await assertSource(job, s, c);
      // Reinspect the original completed Pi conversation rather than accept
      // a model's in-memory return as a strategy or invocation receipt.
      const diagnosis = await inspectOriginalUnknownDiagnosis(job, target);
      const attempt = await inspectDiagnosticAttempt(job, target, c.id);
      const counted = recordRecoveryOutcome(settled, { status: "started", caseId: c.id, attempt }, true);
      if ("strategy" in diagnosis) {
        const controller = await authorizeOperationDiagnosticStrategy(job, s, c, d, diagnosis);
        if (controller) return { status: "running", reason: null,
          recoveryLifecycle: { ...decideRecovery(counted, controller), assessorPending: true } };
        return { status: "blocked", reason: "The read-only diagnosis has no presently authenticated corrective adapter. Original source and recommendation are preserved for plan/Review escalation.",
          recoveryLifecycle: decideRecovery(counted,
            terminalDiagnosticDecision(c, d, attempt.settledRef!, diagnosis)) };
      }
      return { status: "blocked", reason: "Historical read-only advisory diagnosis; no write or approval was granted.",
        recoveryLifecycle: decideRecovery(counted, { ...base(c), evidence: d.evidence, action: "diagnostic-stop", disposition: "operator-intervention",
          receipt: attempt.settledRef!, recommendation: diagnosis.action, advisoryCategory: diagnosis.category }) };
    });
  } catch (error) {
    if (error instanceof PiModelUnavailableError)
      return stop({ ...base(c), action: "pause", reason: "provider-unavailable" },
        error.message + "; pinned model and original source remain unchanged.", "paused");
    if (error instanceof Error && error.name === "PiBudgetPause") return stop({ ...base(c), action: "pause", reason: "budget" }, error.message, "paused");
    if (error instanceof Error && error.name === "StoryCancelledError") return stop({ ...base(c), action: "pause", reason: "cancelled" }, error.message, "cancelled");
    return stop({ ...base(c), action: "integrity-fence", reason: "untrusted-receipt", requiredInspection: "Reconcile original adapter effects before any retry." },
      "Original adapter source, invocation or completion could not be verified; preserve receipts and do not replay.");
  }
}
