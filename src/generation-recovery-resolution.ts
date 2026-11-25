/** Proof for discharging an original, independently deferred no-write failure.
 * Reads existing specialist/Review and idea-placement authorities only.
 * Never dispatches the failed operation or grants any writer/model scope. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { JobStartResult } from "./job.js";
import type { RecoveryCase, RecoveryDischarge } from "./generation-recovery-contract.js";
import type { RecoverySource } from "./generation-recovery-graph.js";
import { generationStages, type GenerationInventory, type GenerationStage } from "./generation-plan.js";
import type { IdeaHistoryEntry, GenerationRequest } from "./generation.js";
import { inspectCheckpointReview, resolvedCheckpointReviews } from "./checkpoint-assurance.js";
import { inspectPostcommitReviewCycle } from "./postcommit-review-cycle.js";
import { inspectRejectedRepair, sharedFoundationReviewWorkItem } from "./rejected-review-repair.js";
import { inspectRepairLedger } from "./repair-ledger.js";
import { assertCompletedSelectiveRevalidation } from "./selective-revalidation-work.js";
import { readEventOnlyOmission, readHistoricalEventOnlyOmission } from "./interactive-event-only.js";
import { verifiedNarrativeChain } from "./job-successor.js";
import { inspectInteractiveConflict } from "./interactive-work.js";
import { inspectSettledAdaptiveReconciliation } from "./adaptive-reconciliation.js";
import { readAdaptiveState } from "./adaptive-state.js";
import { verifyCompletedAdaptiveResponseCorrection, type AdaptiveRecovery } from "./adaptive-protocol.js";
import { readTurnEvidence } from "./turn-plan-evidence.js";
import { verifyCorrectedOriginalResult } from "./commit-verification-continuation.js";
import { git, load } from "./ideas.js";
import { inspectRecoveryCheckpoints } from "./recovery-checkpoints.js";
import { trustedHead } from "./revision.js";
import { independentObligation, type GenerationOperationRecovery } from "./generation-operation-recovery.js";

/** A multi-round correction resolves only when the terminal successor's
 * exact original-session receipt and the entire failed-root chain verify. */
export async function verifyReviewCycleSuccessor(job: JobStartResult, rootSha: string, head: string) {
  const points = (await inspectRecoveryCheckpoints(job)).filter(p => p.eligible);
  // A separate support commit is not a repair commit of the original owner.
  // Accept its exact successor only when the immutable negative Review is
  // covered by BOTH independent verdicts and required dependent revalidation.
  const { inspectDependencyPlan } = await import("./dependency-state.js");
  const dependency = (await inspectDependencyPlan(job))?.entries.find(e =>
    e.reviewSourceSha === rootSha && e.phase === "verified" && e.originalReview?.verdict === "pass");
  if (dependency?.commitSha) {
    const original = points.find(p => p.commitSha === rootSha && p.semanticReview === "failed" &&
      p.assurance?.turnDigest === dependency.report.turnDigest);
    if (!original || (await resolvedCheckpointReviews(job, points)).get(rootSha) !== "not-required")
      return false;
    if (dependency.commitSha !== head) await verifiedNarrativeChain(job, dependency.commitSha, head);
    return true;
  }
  const successor = points.find(p => p.commitSha === head && p.assurance &&
    p.validation.status === "passed" && p.semanticReview === "passed" &&
    p.workItem.startsWith("repair-"));
  if (!successor) return false;
  const receipt = await inspectRejectedRepair(job, successor.workItem.slice("repair-".length));
  const reviews = await resolvedCheckpointReviews(job, points);
  if (receipt.phase !== "passed" || receipt.repairedCommitSha !== head ||
      receipt.rootFailureSha !== rootSha || reviews.get(rootSha) !== "not-required") return false;
  if (!sharedFoundationReviewWorkItem(receipt.origin.workItem)) return true;
  // A successful new scope must not erase or replace its sealed predecessor.
  // Reauthenticate each cycle and its committed verdicts on restart.
  let cycle = await inspectPostcommitReviewCycle(job, rootSha, successor.assurance!.assignmentDigest);
  if (!cycle || cycle.rounds.at(-1)?.commitSha !== head) return false;
  const seen = new Set<string>();
  while (cycle) {
    if (seen.has(cycle.id)) return false;
    seen.add(cycle.id);
    for (const round of cycle.rounds) {
      const point = points.find(p => p.commitSha === round.commitSha &&
        p.assurance?.assignmentDigest === cycle!.assignmentDigest &&
        p.assurance.turnDigest === cycle!.turnDigest);
      if (!point || point.semanticReview !== (round.commitSha === head ? "passed" : "failed")) return false;
      const review = await inspectCheckpointReview(job, point);
      if (review?.result?.reviewer !== "independent-pi-assignment-review" ||
          JSON.parse(review.result.evidence).sourceDigest !== round.packetDigest) return false;
    }
    if (!cycle.predecessor) return cycle.rounds[0]?.commitSha === rootSha;
    const predecessor = cycle.predecessor;
    const prior = await inspectPostcommitReviewCycle(job, rootSha, predecessor.assignmentDigest);
    if (!prior || prior.id !== predecessor.cycleId || prior.turnDigest !== cycle.turnDigest ||
        prior.reviewer.id === cycle.reviewer.id ||
        prior.rounds.at(-1)?.commitSha !== predecessor.failedCommitSha) return false;
    cycle = prior;
  }
  return false;
}

/** C07: authenticate a previously verified ACTIVE case after its controller
 * has returned to the original scheduler. No model, author approval, or write
 * is performed here. The saved lifecycle carries only links to the EXISTING
 * source authorities, and a later unrelated HEAD must descend from the
 * correction, not replace the original failed-check provenance. */
export async function inspectActiveRecoveryResolution(
  job: JobStartResult, original: RecoveryCase, source: RecoverySource,
  resolution: RecoveryDischarge,
  state: { request: GenerationRequest; inventory: GenerationInventory | null },
  /** Only inspection may supply the independently authenticated published parent. */
  publishedParent?: string,
): Promise<boolean> {
  if (resolution.disposition !== "active-verified" ||
      resolution.case.id !== original.id || source.caseId !== original.id ||
      !isDeepStrictEqual(resolution.case, original)) return false;
  const head = publishedParent ?? await trustedHead(job);
  git(job, "merge-base", "--is-ancestor", original.origin.sourceHeadSha, resolution.correctedHeadSha);
  git(job, "merge-base", "--is-ancestor", resolution.correctedHeadSha, head);
  const { correction, correctedHeadSha } = resolution;
  if (source.channel === "operationRecovery" && original.origin.operation === "specialist-result") {
    const negative = (source.input as unknown as GenerationOperationRecovery).evidence?.interactiveNoWrite;
    if (negative?.domain === "choice" && correction.store === "specialist-receipt" &&
        correction.ref === "interactive-items/" + negative.milestoneId.slice(10) + ".json" &&
        original.origin.assignmentId === "interactive:" + negative.milestoneId) {
      const completed = await (await import("./interactive-work.js")).inspectRetainedChoiceCompletion(job,
        negative.milestoneId, { caseId: original.id, reportDigest: negative.reportDigest,
          turnDigest: original.origin.turnDigest, sourceHead: original.origin.sourceHeadSha,
          planVersion: original.origin.planVersion });
      return !!completed && completed.head === correctedHeadSha && completed.digest === correction.digest;
    }
    const readiness = (source.input as unknown as GenerationOperationRecovery).evidence?.eventBlueprintPrerequisite;
    if (readiness) {
      if (correction.store !== "dependency-plan" || correction.ref !== readiness.reportDigest ||
          original.origin.assignmentId !== "event:" + readiness.milestoneId ||
          original.origin.sourceHeadSha !== readiness.expectedHead || original.origin.planVersion !== readiness.planVersion)
        return false;
      const { inspectBlueprintPredecessorCompletion } = await import("./event-work.js");
      const completed = await inspectBlueprintPredecessorCompletion(job, readiness.milestoneId, readiness.reportDigest);
      const event = JSON.parse(await readFile(join(job.stateDir, "event-items", readiness.milestoneId.slice(10) + ".json"), "utf8"));
      return isDeepStrictEqual(completed.original.report, readiness) &&
        completed.head === correctedHeadSha && completed.digest === correction.digest &&
        event.expectedHead === correctedHeadSha && event.blueprintSource?.reportDigest === readiness.reportDigest;
    }
    const ref = (source.input as unknown as GenerationOperationRecovery).evidence?.blueprintAssessment;
    if (ref) {
      if (correctedHeadSha !== original.origin.sourceHeadSha) return false;
      const { readBlueprintAssessment, verifyBlueprintAssessmentResolution } = await import("./blueprint-reassessment.js");
      const proof = await readBlueprintAssessment(job, ref);
      if (proof.identity.turnDigest !== original.origin.turnDigest ||
          proof.identity.planVersion !== (original.origin.planVersion ?? 1)) return false;
      return verifyBlueprintAssessmentResolution(job, ref, correction, correctedHeadSha);
    }
  }
  const checkpoints = await inspectRecoveryCheckpoints(job);
  if (correction.store === "specialist-receipt" && source.channel === "operationRecovery" &&
      original.origin.operation === "specialist-result" &&
      (source.input as unknown as GenerationOperationRecovery).evidence.assignmentFailure)
    return (await import("./generation-operation-strategy.js")).authenticateAssignmentDiagnosticDischarge(job, original,
      source.input as unknown as GenerationOperationRecovery, correction, correctedHeadSha);
  if (correction.store === "review-checkpoint" && correction.ref === correctedHeadSha) {
    if (original.origin.operation === "independent-review" &&
        original.observation === "returned-failure")
      return verifyReviewCycleSuccessor(job, original.origin.sourceHeadSha, correctedHeadSha);
    const point = checkpoints.find(p => p.eligible && p.commitSha === correctedHeadSha &&
      p.validation.status === "passed" &&
      (p.semanticReview === "passed" || p.semanticReview === "not-required"));
    if (!point) return false;
    if (original.origin.operation === "commit-verification" &&
        source.channel === "operationRecovery" && original.origin.assignmentId) {
      const operation = source.input as unknown as GenerationOperationRecovery;
      const verifier = operation.evidence?.verifier;
      if (operation.operation !== "commit-verification" || !verifier ||
          verifier.assignmentId !== original.origin.assignmentId ||
          verifier.resultHeadSha !== correctedHeadSha ||
          verifier.failureHeadSha !== original.origin.sourceHeadSha ||
          verifier.planVersion !== original.origin.planVersion ||
          !generationStages.includes(verifier.stage as GenerationStage)) return false;
      const assignment = { id: verifier.assignmentId, stage: verifier.stage as GenerationStage,
        ...(verifier.assignmentId.includes(":") ?
          { milestone: verifier.assignmentId.slice(verifier.assignmentId.indexOf(":") + 1) } : {}) };
      return (await verifyCorrectedOriginalResult(job, original.origin.turnDigest,
        assignment, { status: verifier.resultStatus, headSha: verifier.resultHeadSha },
        verifier, original.origin.planVersion)).eligible;
    }
    return original.origin.operation === "independent-review" &&
      original.observation === "exception" && original.origin.sourceHeadSha === correctedHeadSha;
  }
  if (correction.store === "repair-ledger" &&
      original.origin.operation === "dependency-amendment" &&
      correction.ref && original.origin.assignmentId?.startsWith("composition:milestone.")) {
    const milestone = original.origin.assignmentId.slice("composition:".length);
    const receipt = JSON.parse(await readFile(join(job.stateDir, "prerequisite-items",
      milestone.slice(10) + ".json"), "utf8")) as {
      jobId?: string; phase?: string; repairId?: string; commitSha?: string;
      reviewDigest?: string; review?: { verdict?: string };
    };
    if (receipt.jobId !== job.jobId || receipt.phase !== "verified" ||
        receipt.repairId !== correction.ref || receipt.commitSha !== correctedHeadSha ||
        receipt.review?.verdict !== "pass" || !receipt.reviewDigest) return false;
    const ledger = await inspectRepairLedger(job, original.origin.turnDigest);
    const supported = ledger.prerequisites?.some(entry => entry.id === correction.ref &&
      entry.status === "resolved" && entry.attempts.some(a =>
        a.submittedSha === correctedHeadSha && a.verdict === "passed" &&
        a.reviewDigest === receipt.reviewDigest));
    if (!supported) return false;
    await assertCompletedSelectiveRevalidation(job, correctedHeadSha,
      original.origin.turnDigest, receipt.reviewDigest, true);
    return true;
  }
  if (correction.store === "specialist-receipt" &&
      original.origin.operation === "specialist-result" &&
      source.channel === "operationRecovery" &&
      original.origin.assignmentId?.startsWith("interactive:milestone.")) {
    const milestone = original.origin.assignmentId.slice("interactive:".length);
    if (correction.ref !== "interactive-event-only/" + milestone.slice(10) + ".json" ||
        correctedHeadSha !== original.origin.sourceHeadSha ||
        state.inventory?.items.find(item => item.id === original.origin.assignmentId)?.status !== "verified")
      return false;
    const originalInput = source.input as unknown as GenerationOperationRecovery;
    const negative = originalInput.evidence?.interactiveNoWrite;
    if (!negative || negative.domain !== "choice" || negative.milestoneId !== milestone || negative.expectedHead !== correctedHeadSha)
      return false;
    const conflict = await inspectInteractiveConflict(job, milestone, true);
    if (conflict.domain !== "choice" || conflict.reportDigest !== negative.reportDigest || conflict.worker !== "pi") return false;
    const saved = JSON.parse(await readFile(join(job.stateDir,
      "interactive-items", milestone.slice(10) + ".json"), "utf8")) as {
      units?: Array<{ phase?: string; eventOnly?: { nonce: string; digest: string } }>;
    };
    const [choice, puzzle] = saved.units ?? [];
    if (choice?.phase !== "not-applicable" || puzzle?.phase !== "not-applicable" ||
        !choice.eventOnly || !isDeepStrictEqual(choice.eventOnly, puzzle.eventOnly) ||
        correction.digest !== choice.eventOnly.digest) return false;
    if (head === correctedHeadSha) await readEventOnlyOmission(job, milestone, choice.eventOnly);
    else {
      await verifiedNarrativeChain(job, correctedHeadSha, head);
      await readHistoricalEventOnlyOmission(job, milestone, choice.eventOnly);
    }
    const adaptive = await readAdaptiveState(job, original.origin.turnDigest,
      original.origin.planVersion!);
    return !!adaptive?.supersessions?.some(entry => entry.assignmentId === original.origin.assignmentId &&
      entry.sourceSha === correctedHeadSha && isDeepStrictEqual(entry.omission, choice.eventOnly));
  }
  if (correction.store === "response-contract" && source.channel === "recovery" &&
      original.origin.operation === "adaptive-planner") {
    const input = source.input as unknown as AdaptiveRecovery;
    if (correction.ref !== input.proof.file || correctedHeadSha !== original.origin.sourceHeadSha)
      return false;
    return verifyCompletedAdaptiveResponseCorrection(job, { ...input, phase: "assessment" });
  }
  if (correction.store === "response-contract" && source.channel === "operationRecovery" &&
      original.origin.operation === "adaptive-admission" && correctedHeadSha === original.origin.sourceHeadSha) {
    const accepted = await inspectSettledAdaptiveReconciliation(job, state.request, original.origin, correction.ref);
    return !!accepted && isDeepStrictEqual(accepted.receipt, correction);
  }
  if (correction.store === "graph-checkpoint" && source.channel === "operationRecovery" &&
      original.origin.operation === "scheduling" && correctedHeadSha === original.origin.sourceHeadSha &&
      correction.ref === original.origin.failureAnchor.ref && state.request.turnPlanDigest) {
    return !!await readTurnEvidence(job, state.request.contract, state.request.task,
      state.request.turnPlanDigest);
  }
  return false;
}

export interface DeferredResolutionState {
  inventory: GenerationInventory | null;
  ideaHistory: readonly IdeaHistoryEntry[];
  /** Fixtures have deterministic, request-bound non-Pi proof only. */
  fixture: boolean;
}

/** Returns exact, source-linked existing receipts or null. A later verified
 * correction is NOT a reentry ticket for the original failed specialist. */
export async function inspectDeferredCorrection(
  job: JobStartResult, original: RecoveryCase, source: RecoverySource,
  state: DeferredResolutionState,
  expected?: RecoveryDischarge,
  publishedParent?: string,
): Promise<RecoveryDischarge | null> {
  if (source.caseId !== original.id || source.channel !== "operationRecovery" ||
      !["specialist-dispatch", "idea-integration"].includes(original.origin.operation) ||
      !independentObligation(source.input as unknown as GenerationOperationRecovery,
        original.origin.sourceHeadSha))
    return null;
  const head = publishedParent ?? await trustedHead(job);
  // Original provenance remains immutable even when later work changes HEAD.
  git(job, "merge-base", "--is-ancestor", original.origin.sourceHeadSha, head);
  let discharge: RecoveryDischarge | null = null;
  if (original.origin.operation === "specialist-dispatch") {
    const assignment = original.origin.assignmentId;
    const evidence = source.input.evidence as { assignmentId?: string } | undefined;
    const item = state.inventory?.items.find(entry => entry.id === assignment);
    if (!assignment || evidence?.assignmentId !== assignment ||
        item?.status !== "verified" || !item.verifiedSha) return null;
    const point = (await inspectRecoveryCheckpoints(job)).find(entry =>
      entry.eligible && entry.workItem === assignment &&
      entry.commitSha === item.verifiedSha &&
      (entry.semanticReview === "passed" || entry.semanticReview === "not-required" ||
        entry.stage === "foundation" && entry.semanticReview === "untracked" &&
          entry.validation.status === "passed"));
    if (!point || point.commitSha === original.origin.sourceHeadSha) return null;
    git(job, "merge-base", "--is-ancestor", original.origin.sourceHeadSha, point.commitSha);
    discharge = { case: original, correction: { store: "review-checkpoint", ref: point.commitSha },
      correctedHeadSha: point.commitSha };
  } else {
    const evidence = source.input.evidence as {
      ideaId?: string; signature?: string; action?: string; resultStatus?: string
    } | undefined;
    if (!evidence?.ideaId || evidence.resultStatus !== "deferred" ||
        !state.ideaHistory.some(entry =>
          entry.id === evidence.ideaId && entry.signature === evidence.signature &&
          entry.action === evidence.action && entry.status === "deferred"))
      return null;
    // load authenticates the immutable inbox capture, every placement
    // transition and its exact committed Git/Pi/receipt provenance.
    const idea = (await load(job)).find(entry => entry.id === evidence.ideaId);
    if (idea?.lifecycle.status !== "integrated") return null;
    // A new discharge uses current verified coverage. Restart must verify
    // the exact historical placement which discharged the original Case,
    // not substitute a newer reassessment or relocation for that effect.
    const candidates = expected ? idea.lifecycle.placements : idea.lifecycle.placements.slice(-1);
    for (const placement of candidates) {
      if (!["integrated", "reassessed", "relocated"].includes(placement.action) ||
          placement.verified !== "pi") continue;
      const file = join(job.stateDir, "idea-placements", idea.id + "-" + placement.revision + ".json");
      const receipt = JSON.parse(await readFile(file, "utf8")) as {
        jobId?: string; ideaId?: string; revision?: number; commitSha?: string;
      };
      if (receipt.jobId !== job.jobId || receipt.ideaId !== idea.id ||
          receipt.revision !== placement.revision || !receipt.commitSha) return null;
      if (expected && receipt.commitSha !== expected.correctedHeadSha) continue;
      if (receipt.commitSha === original.origin.sourceHeadSha) return null;
      git(job, "merge-base", "--is-ancestor", original.origin.sourceHeadSha, receipt.commitSha);
      git(job, "merge-base", "--is-ancestor", receipt.commitSha, head);
      discharge = { case: original,
        correction: { store: "idea-placement", ref: idea.id + ":" + receipt.commitSha },
        correctedHeadSha: receipt.commitSha };
      break;
    }
  }
  return expected && !isDeepStrictEqual(discharge, expected) ? null : discharge;
}
