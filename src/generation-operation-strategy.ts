/** Decisions at the existing assessor only. Original adapters retain every
 * receipt, writer lock, validation, independent review and budget check. */
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
import { inspectCheckpointReview } from "./checkpoint-assurance.js";
import { inspectPostcommitReviewCycle } from "./postcommit-review-cycle.js";
import { readAdaptiveState } from "./adaptive-state.js";
import { inspectRejectedRepair } from "./rejected-review-repair.js";
import { authenticateEventNoWrite, type EventNoWriteSource } from "./event-prerequisite-auth.js";
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
      s.inventory?.headSha === head && c.origin.assignmentId) {
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
  // A settled clean Choice contradiction is different from an interrupted
  // writer or a malformed Pi response. The pinned interactive receipt and
  // original session prove no edits; diagnosis never authorizes a replacement
  // Choice or an upstream Plan mutation.
  if (operation === "specialist-result" && c.observation === "returned-failure" &&
      !s.active && !s.result && !s.causalAmendment &&
      s.inventory?.headSha === head && c.origin.assignmentId) {
    const source = s.recoverySources.find(x => x.caseId === c.id && x.channel === "operationRecovery");
    const op = source?.input as GenerationOperationRecovery | undefined;
    const reported = op?.evidence.interactiveNoWrite;
    if (op?.evidence.resultStatus === "interactive-conflict-reported" &&
        reported?.domain === "choice" && reported.expectedHead === head &&
        op.evidence.assignmentId === c.origin.assignmentId &&
        c.origin.assignmentId === "interactive:" + reported.milestoneId &&
        s.inventory.items.some(item => item.id === c.origin.assignmentId && item.status === "blocked") &&
        s.failures[c.origin.assignmentId]) {
      const { inspectInteractiveConflict } = await import("./interactive-work.js");
      const original = await inspectInteractiveConflict(job, reported.milestoneId);
      if (original.reportDigest === reported.reportDigest &&
          original.expectedHead === head && original.planVersion === s.planVersion &&
          original.worker === (s.request.fixture ? "fixture" : "pi"))
        return { store: "specialist-receipt", ref: original.relative, digest: original.reportDigest };
    }
  }
  if (operation === "adaptive-admission" && planVersion) {
    const state = await readAdaptiveState(job, turnDigest, planVersion);
    const attempt = state?.attempts.at(-1);
    if (attempt?.sourceSha === head && attempt.phase !== "planning" && attempt.session && attempt.effect?.phase === "responded")
      return { store: "response-contract", ref: attempt.signature, digest: attempt.session.sessionSha256 };
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
  // The per-checkpoint result file is mutable private state, not a signature.
  // Reconstruct its accepted verdict from the *original settled Pi transcript*
  // and compare both the review-cycle digest and controller-sealed findings.
  // Later independent correction rounds may append to the same conversation.
  const { prepareSemanticReview, independentReviewResults } =
    await import("./semantic-assignment-review.js");
  const { assignmentVerdictResponseContract } =
    await import("./narrative-review-specialist.js");
  const packet = await prepareSemanticReview(job, [point]);
  if (packet.sourceDigest !== round.packetDigest) return null;
  const transcript = (await readFile(cycle.reviewer.file)).subarray(0, round.transcriptBytes)
    .toString("utf8").trim().split("\n").map(line => JSON.parse(line) as {
      type?: string; message?: { role?: string; stopReason?: string;
        content?: Array<{ type?: string; text?: string }> } });
  const accepted = transcript.filter(r => r.type === "message" && r.message?.role === "assistant" &&
    r.message.stopReason === "stop").at(-1)?.message;
  if (!accepted) return null;
  const text = (accepted.content ?? []).filter(c => c.type === "text")
    .map(c => c.text ?? "").join("\n");
  const verdict = assignmentVerdictResponseContract(packet).parse(text);
  if (verdict.verdict !== "fail" ||
      createHash("sha256").update(JSON.stringify(verdict)).digest("hex") !== round.verdictDigest ||
      !isDeepStrictEqual(independentReviewResults(packet, verdict,
        "independent-pi-assignment-review")[0], reviewed.result))
    return null;
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
      s.escalation.requiresTrustedApproval || s.inventory?.headSha !== c.origin.sourceHeadSha ||
      !c.origin.assignmentId || !s.failures[c.origin.assignmentId] ||
      !s.inventory.items.some(item => item.id === c.origin.assignmentId && item.status === "blocked"))
    return null;
  const source = s.recoverySources.find(x => x.caseId === c.id && x.channel === "operationRecovery");
  const op = source?.input as GenerationOperationRecovery | undefined;
  if (op?.outcome !== "returned-failure" || op.operation !== "specialist-result" ||
      op.evidence.reference !== "specialist-receipt" ||
      op.evidence.assignmentId !== c.origin.assignmentId)
    return null;
  const choice = op.evidence.interactiveNoWrite;
  if (op.evidence.resultStatus === "interactive-conflict-reported" && choice &&
      choice.domain === "choice" && choice.expectedHead === c.origin.sourceHeadSha &&
      c.origin.assignmentId === "interactive:" + choice.milestoneId) {
    const { inspectInteractiveConflict } = await import("./interactive-work.js");
    const original = await inspectInteractiveConflict(job, choice.milestoneId);
    if (original.reportDigest !== choice.reportDigest ||
        original.expectedHead !== c.origin.sourceHeadSha ||
        original.planVersion !== c.origin.planVersion || original.worker !== "pi") return null;
    // The original approved Blueprint belongs to an independently pinned
    // Event review cycle, not to a new Choice plan authored by its reporter.
    const event = JSON.parse(await readFile(join(job.stateDir, "event-items",
      choice.milestoneId.slice(10) + ".json"), "utf8")) as {
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
export async function selectOperationStrategy(job: JobStartResult, s: State, c: RecoveryCase): Promise<RecoveryDecision | null> {
  if (s.request.fixture || !s.request.turnPlanDigest) return null;
  const owner = await originalNoWriteOwnerProof(job, s, c);
  if (owner) {
    await assertSource(job, s, c);
    return { ...base(c, owner.proof), action: "plan-amendment",
      adapter: "dependency-work", owner: owner.owner, scopeRef: owner.proof };
  }
  const reviewProof = await originalFailedReviewProof(job, s, c);
  if (reviewProof) {
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
  const original = await originalFailedReviewProof(job, s, c);
  return !!original && isDeepStrictEqual(original, d.receipt) &&
    isDeepStrictEqual(d.evidence, [...c.evidence, original]);
}
export async function authenticateOperationDiagnosticProof(job: JobStartResult, s: State,
  c: RecoveryCase, d: RecoveryDecision): Promise<boolean> {
  const original = await diagnosticEvidence(job, s, c);
  return !!original && isDeepStrictEqual(original, d.evidence.at(-1)) &&
    isDeepStrictEqual(d.evidence.slice(0, -1), c.evidence);
}
export function diagnosticCaseForDecision(c: RecoveryCase, d: RecoveryDecision) {
  const proof = d.evidence.at(-1);
  if (!proof?.digest || !["repair-ledger", "response-contract", "review-checkpoint",
    "specialist-receipt", "graph-checkpoint"].includes(proof.store))
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
      (d.action !== "diagnostic" &&
        !(d.action === "plan-amendment" && ["cross-domain-closeout", "dependency-work"].includes(d.adapter)) &&
        !(d.action === "known-correction" && d.adapter === "review-cycle"))) return null;
  if (d.action === "plan-amendment" && d.adapter === "dependency-work") {
    await assertSource(job, s, c);
    if (!await authenticateOperationOwnerProof(job, s, c, d))
      throw Error("Owner amendment lost its original negative specialist Pi report");
    // C04 converts the negative report into an authenticated plan-owner
    // correction request. C06 owns supersession of the approved Blueprint /
    // adaptive assignment and its separate author/Review signatures. A C04
    // report must NEVER dispatch another writer or claim plan approval.
    return { recoveryLifecycle: { ...lifecycle, assessorPending: false },
      status: "blocked", reason: "Authenticated specialist contradiction is assigned " +
        "to controller-owned Architecture/Work-plan correction. No source mutation " +
        "or replacement writer is permitted until the original approved scope " +
        "and dependent Review are reverified.",
      escalation: { kind: "dependency-replan", requiresTrustedApproval: false,
        sources: [{ source: d.scopeRef.ref, message: "Source-bound original specialist no-write",
          repair: "controller-authorized Architecture/Work-plan amendment" }],
        action: "Route this exact source to the Orchestrator/Work-plan controller for " +
          "a versioned in-objective assignment correction. Ask the author only if the " +
          "independent scope/protected-decision checks require new authority." } };
  }
  if (d.action === "known-correction") {
    await assertSource(job, s, c);
    if (!await authenticateOperationReviewProof(job, s, c, d))
      throw Error("Original failed Review source no longer matches the saved correction decision");
    // The graph will reenter the existing Review controller with the selected
    // lifecycle. No writer is invoked by assessment itself.
    return { recoveryLifecycle: { ...lifecycle, assessorPending: false }, status: "running" };
  }
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
