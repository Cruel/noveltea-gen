/** Decisions at the existing assessor only. Original adapters retain every
 * receipt, writer lock, validation, independent review and budget check. */
import { isDeepStrictEqual } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { GenerationOperationRecovery } from "./generation-operation-recovery.js";
import type { GenerationGraphState } from "./generation.js";
import type { JobStartResult } from "./job.js";
import { git } from "./ideas.js";
import { trustedHead } from "./revision.js";
import { processAuthorUpdatesAfterWork } from "./author-updates.js";
import { readJobControl } from "./job-control.js";
import { withStoryJobLock } from "./job-lock.js";
import { inspectPiPolicy } from "./job-pi-policy.js";
import { inspectRecoveryCheckpoints } from "./recovery-checkpoints.js";
import { readAdaptiveState } from "./adaptive-state.js";
import { inspectRejectedRepair } from "./rejected-review-repair.js";
import { preflightCompositionBoundary } from "./cross-domain-prerequisite-controller.js";
import { advanceCrossDomainCloseout } from "./cross-domain-closeout-work.js";
import { diagnoseUnknownCompletion, inspectDiagnosticAttempt, inspectOriginalUnknownDiagnosis,
  operationDiagnosisCase, type UnknownRecoveryCase } from "./unknown-recovery-diagnostic.js";
import { decideRecovery, finishRecovery, recordRecoveryOutcome } from "./generation-recovery-lifecycle.js";
import type { RecoveryCase, RecoveryDecision, RecoveryEvidence, RecoveryLifecycle } from "./generation-recovery-contract.js";

type State = GenerationGraphState;
const base = (c: RecoveryCase, proof?: RecoveryEvidence) => ({
  schema: "noveltea-generation-recovery-decision/v1" as const, caseId: c.id,
  checkedSourceHeadSha: c.origin.sourceHeadSha, evidence: proof ? [...c.evidence, proof] : c.evidence,
});
async function assertSource(job: JobStartResult, s: State, c: RecoveryCase) {
  if (s.request.turnPlanDigest !== c.origin.turnDigest || s.planVersion !== c.origin.planVersion ||
      s.request.job !== c.origin.jobId || job.threadId !== c.origin.jobThreadId ||
      await trustedHead(job) !== c.origin.sourceHeadSha || git(job, "status", "--porcelain=v1", "--untracked-files=all").trim())
    throw Error("Original Turn, plan, HEAD or writer effects changed before recovery");
}
/** A clean worktree alone doesn't settle a writer. Require the original
 * operation's verified effect, not a reason string or a model's diagnosis. */
async function diagnosticEvidence(job: JobStartResult, s: State, c: RecoveryCase): Promise<RecoveryEvidence | null> {
  const { operation, sourceHeadSha: head, turnDigest, planVersion } = c.origin;
  if (s.request.fixture || !s.request.turnPlanDigest || s.escalation?.requiresTrustedApproval) return null;
  if (operation === "adaptive-admission" && planVersion) {
    const state = await readAdaptiveState(job, turnDigest, planVersion);
    const attempt = state?.attempts.at(-1);
    if (attempt?.sourceSha === head && attempt.phase !== "planning" && attempt.session && attempt.effect?.phase === "responded")
      return { store: "response-contract", ref: attempt.signature, digest: attempt.session.sessionSha256 };
  }
  if (c.observation !== "returned-failure" || !["independent-review", "completion-verification"].includes(operation)) return null;
  if (operation === "independent-review" && (!s.active || s.active.id !== c.origin.assignmentId ||
      s.result?.headSha !== head || s.escalation?.kind !== "dependency-replan")) return null;
  if (operation === "completion-verification" && !s.escalation) return null;
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
export function matchesOriginalCloseout(s: State, c: RecoveryCase, pending: NonNullable<State["crossDomainCloseout"]>): boolean {
  const source = s.recoverySources.find(x => x.caseId === c.id && x.channel === "operationRecovery");
  const evidence = source?.input.evidence as GenerationOperationRecovery["evidence"] | undefined;
  return evidence?.closeout?.repairId === pending.repairId && evidence.closeout.proposalDigest === pending.proposalDigest &&
    evidence.closeout.milestoneId === pending.milestoneId && pending.sourceSha === c.origin.sourceHeadSha &&
    pending.planVersion === c.origin.planVersion && evidence.assignmentId === c.origin.assignmentId;
}
export async function selectOperationStrategy(job: JobStartResult, s: State, c: RecoveryCase): Promise<RecoveryDecision | null> {
  if (s.request.fixture || !s.request.turnPlanDigest) return null;
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
export async function authenticateOperationDiagnosticProof(job: JobStartResult, s: State,
  c: RecoveryCase, d: RecoveryDecision): Promise<boolean> {
  const original = await diagnosticEvidence(job, s, c);
  return !!original && isDeepStrictEqual(original, d.evidence.at(-1)) &&
    isDeepStrictEqual(d.evidence.slice(0, -1), c.evidence);
}
export function diagnosticCaseForDecision(c: RecoveryCase, d: RecoveryDecision) {
  const proof = d.evidence.at(-1);
  if (!proof?.digest || !["repair-ledger", "response-contract", "review-checkpoint"].includes(proof.store))
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
    d.recommendation === sealed.action && d.advisoryCategory === sealed.category;
}

export async function executeOperationStrategy(job: JobStartResult, s: State, lifecycle: RecoveryLifecycle): Promise<Partial<State> | null> {
  const c = lifecycle.active!, d = lifecycle.decision!;
  if (!lifecycle.assessorPending || !d || !c || !s.recoverySources.some(x => x.caseId === c.id && x.channel === "operationRecovery") ||
      (d.action !== "diagnostic" && !(d.action === "plan-amendment" && d.adapter === "cross-domain-closeout"))) return null;
  const settled = { ...lifecycle, assessorPending: false };
  const stop = (decision: RecoveryDecision, reason: string, status: State["status"] = "blocked"): Partial<State> => ({
    recoveryLifecycle: decideRecovery(settled, decision), reason, status,
  });
  try {
    const control = await readJobControl(job);
    if (control !== "running") return stop({ ...base(c), action: "pause", reason: control === "paused" ? "author-pause" : "cancelled" }, "Author control precedes corrective work.", control);
    const author = await withStoryJobLock(job, "recovery-author-intake", () => processAuthorUpdatesAfterWork(job));
    if ("error" in author) throw Error("Author receipts could not be authenticated");
    if (author.status !== "ready") return stop({ ...base(c), action: "pause", reason: author.status === "cancelled" ? "cancelled" :
      author.status === "paused" ? "author-pause" : "author-choice" }, "Author boundary precedes corrective work.", author.status === "cancelled" ? "cancelled" : "paused");
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
      return { recoveryLifecycle: finishRecovery(recordRecoveryOutcome(settled, { status: "verified", caseId: c.id,
        sourceHeadSha: result.headSha, assurance: { store: "repair-ledger", ref: pending.repairId } }, true)),
        crossDomainCloseout: null, active: null, result: null, reason: null, status: "running" };
    }
    return await withStoryJobLock(job, "assess-original-operation-diagnostic", async () => {
      if (!isDeepStrictEqual(await selectOperationStrategy(job, s, c), d)) throw Error("Original diagnosis source changed");
      const target = diagnosticCaseForDecision(c, d);
      const { policy } = await inspectPiPolicy(job);
      await diagnoseUnknownCompletion(job, target, s.request.provider ?? policy.profile.provider, s.request.model ?? policy.profile.model);
      await assertSource(job, s, c);
      const diagnosis = await inspectOriginalUnknownDiagnosis(job, target);
      const attempt = await inspectDiagnosticAttempt(job, target, c.id);
      const counted = recordRecoveryOutcome(settled, { status: "started", caseId: c.id, attempt }, true);
      return { status: "blocked", reason: "Read-only diagnosis completed; inspect the original operation receipts. No write or approval was granted.",
        recoveryLifecycle: decideRecovery(counted, { ...base(c), evidence: d.evidence, action: "diagnostic-stop", disposition: "operator-intervention",
          receipt: attempt.settledRef!, recommendation: diagnosis.action, advisoryCategory: diagnosis.category }) };
    });
  } catch (error) {
    if (error instanceof Error && error.name === "PiBudgetPause") return stop({ ...base(c), action: "pause", reason: "budget" }, error.message, "paused");
    if (error instanceof Error && error.name === "StoryCancelledError") return stop({ ...base(c), action: "pause", reason: "cancelled" }, error.message, "cancelled");
    return stop({ ...base(c), action: "integrity-fence", reason: "untrusted-receipt", requiredInspection: "Reconcile original adapter effects before any retry." },
      "Original adapter source, invocation or completion could not be verified; preserve receipts and do not replay.");
  }
}
