/** Source-bound controller disposition for non-specialist Turn boundaries.
 * The generation graph checkpoints assessment before this disposition is
 * executed. No receipt here grants a new writer invocation or author consent. */
import { isDeepStrictEqual } from "node:util";
import { join, relative, sep } from "node:path";
import { readFile } from "node:fs/promises";
import { authenticateSealedProtocolFailure, type SealedProtocolFailure } from "./response-contract-recovery.js";
import type { JobStartResult } from "./job.js";
import { trustedHead } from "./revision.js";
import type { AssignmentFailureProof } from "./assignment-metadata-recovery.js";

export type Operation = "scheduling" | "adaptive-admission" | "author-update-intake" |
  "idea-integration" | "idea-verification" | "specialist-dispatch" |
  "specialist-result" | "dependency-amendment" | "independent-review" |
  "commit-verification" | "completion-verification" | "resume-reconciliation";
export const operationChecks: Record<Operation, string> = {
  scheduling: "generation-scheduling.v1",
  "adaptive-admission": "adaptive-admission.v1",
  "author-update-intake": "author-update-intake.v1",
  "idea-integration": "idea-dispatch.v1",
  "idea-verification": "idea-placement-provenance.v1",
  "specialist-dispatch": "specialist-dispatch.v1",
  "specialist-result": "specialist-result.v1",
  "dependency-amendment": "dependency-amendment.v1",
  "independent-review": "independent-assignment-review.v1",
  "commit-verification": "committed-work-verification.v1",
  "completion-verification": "generation-completion.v1",
  "resume-reconciliation": "generation-resume-reconciliation.v1",
};
export interface GenerationOperationRecovery {
  version: 1;
  operation: Operation; check: string; checkVersion: 1;
  phase: "assessment" | "fenced" | "continued";
  outcome: "exception" | "returned-failure";
  safeAction: "reconcile-original-operation" | "continue-independent";
  source: {
    jobId: string; threadId: string; turnDigest: string | null;
    planVersion: number | null; headSha: string | null;
  };
  evidence: {
    reference: "generation-checkpoint" | "author-updates" | "generation-idea-dispatch" |
      "specialist-receipt" | "dependency-plan" | "review-checkpoints" |
      "completion-report" | "generation-checkpoints";
    assignmentId?: string; resultStatus?: string;
    /** Settled original child failure at its unpublished draft source. */
    assignmentFailure?: { sourceHeadSha: string; proof: AssignmentFailureProof };
    blueprintAssessment?: import("./blueprint-reassessment.js").BlueprintAssessmentRef;
    interactiveDomain?: "choice" | "puzzle";
    closeout?: { milestoneId: string; proposalDigest: string; repairId: string };
    /** Original settled Event no-write report, never a replacement Event writer lease. */
    eventNoWrite?: { milestoneId: string; expectedHead: string; reportDigest: string };
    /** Original final report and eligible checkpoint captured by the controller. */
    completion?: { checkpoint: string; reportStatus: string; scopeStatus: string; planStatus: string };
    /** Settled Interactive contradiction from the original pinned specialist Pi session. */
    interactiveNoWrite?: { milestoneId: string; expectedHead: string; reportDigest: string;
      domain: "choice" | "puzzle" };
    /** Original settled World/Character no-write report; never a replacement writer grant. */
    foundationsNoWrite?: { domain: "world" | "character"; expectedHead: string; reportDigest: string };
    /** Controller-captured verifier input; its source and correction baseline are not model claims. */
    verifier?: { assignmentId: string; stage: string; resultStatus: string;
      resultHeadSha: string; failureHeadSha: string;
      checkpointWorkItem: string; checkpointDigest: string;
      planVersion: number | null; correctionDigest: string; };
    /** A completed, exhausted non-specialist response, not an uncertain writer. */
    protocolFailure?: SealedProtocolFailure;
    failureKind?: "protocol" | "integrity";
    ideaId?: string; action?: "place" | "reassess"; signature?: string;
    priorHead?: string;
    /** A known verifier fix can expose a *new* admission failure, not
     * another failure of the fixed response format contract. */
    previousCheck?: string; previousCheckVersion?: number; previousSignature?: string;
  };
  reason: string;
  nextAction: string;
}

/** A second failure at the same checked source cannot mint a new recovery
 * entitlement merely because the error string, locale, or suggested action
 * changed. Only the typed operation, original Thread/Turn/source and sealed
 * failed-check evidence can establish whether the failed operation changed.
 * This is a guard against replay, never proof that a writer may be retried. */
export function isRepeatedUnchangedOperation(
  previous: GenerationOperationRecovery | null | undefined,
  current: Pick<GenerationOperationRecovery, "operation" | "outcome" | "source" | "evidence">,
): boolean {
  return !!previous &&
    previous.version === 1 && previous.phase === "continued" &&
    previous.checkVersion === 1 && previous.check === operationChecks[previous.operation] &&
    previous.operation === current.operation && previous.outcome === current.outcome &&
    !!current.source.headSha && /^[a-f0-9]{40}$/.test(current.source.headSha) &&
    isDeepStrictEqual(previous.source, current.source) &&
    isDeepStrictEqual(previous.evidence, current.evidence);
}

/** The failed operation when a node has no more specific specialist receipt.
 * Returning blocked never certifies a read-only reconciliation or a no-write. */
export const nodeFailureSource = {
  schedule: ["scheduling", "generation-checkpoint"],
  author_update_intake: ["author-update-intake", "author-updates"],
  idea_integration: ["idea-integration", "generation-idea-dispatch"],
  verify_idea_integration: ["idea-verification", "generation-idea-dispatch"],
  specialist_dispatch: ["specialist-dispatch", "specialist-receipt"],
  dependency_amendment: ["dependency-amendment", "dependency-plan"],
  independent_assignment_review: ["independent-review", "review-checkpoints"],
  verify_committed_work: ["commit-verification", "review-checkpoints"],
  completion_decision: ["completion-verification", "completion-report"],
} as const satisfies Record<string, readonly [Operation, GenerationOperationRecovery["evidence"]["reference"]]>;

/** Candidate only. The assessor still checks the actual blocked inventory or
 * verified idea receipt under lock before releasing any independent work. */
export function independentObligation(op: Pick<GenerationOperationRecovery, "operation" | "outcome" | "evidence">,
  head: string | null): string | null {
  if (!head || head !== op.evidence?.priorHead) return null;
  if (op.operation === "specialist-dispatch" && op.outcome === "exception" &&
      op.evidence.reference === "specialist-receipt") return op.evidence.assignmentId || null;
  if (op.operation === "idea-integration" && op.outcome === "returned-failure" &&
      op.evidence.reference === "generation-idea-dispatch" && op.evidence.resultStatus === "deferred" &&
      op.evidence.ideaId) return "idea:" + op.evidence.ideaId;
  return null;
}

/** This authenticates only the original unfinished Foundation, not a clean
 * verified revision, plan amendment, or permission to dispatch a writer. */
export async function authenticateAssignmentFailure(job: JobStartResult,
  evidence: GenerationOperationRecovery["evidence"], sourceHead: string) {
  const failure = evidence.assignmentFailure;
  if (!failure || failure.sourceHeadSha !== sourceHead ||
      evidence.reference !== "specialist-receipt" ||
      evidence.resultStatus !== failure.proof.kind) return null;
  const assignment = evidence.assignmentId;
  const original = ["foundation", "foundations"].includes(assignment ?? "") && !evidence.interactiveDomain
    ? await (assignment === "foundation" ? (await import("./foundation.js")).inspectFoundationFailure : (await import("./character-world.js")).inspectCharacterWorldFailure)(job, sourceHead).catch(() => null)
    : await (async () => {
      if (assignment === "architecture" && !evidence.interactiveDomain)
        return (await import("./architecture.js")).inspectArchitectureFailure(job, sourceHead).catch(() => null);
      const event = /^event:(milestone\.[a-z][a-z0-9-]*)$/.exec(assignment ?? "");
      if (event && !evidence.interactiveDomain)
        return (await import("./event-work.js")).inspectEventFailure(job, event[1]!, sourceHead).catch(() => null);
      const focus = /^focus:([a-z][a-z-]*\.[a-z][a-z0-9-]*)$/.exec(assignment ?? "");
      if (focus && !evidence.interactiveDomain)
        return (await import("./focused-work.js")).inspectFocusedFailure(job, focus[1]!, sourceHead).catch(() => null);
      const composition = /^composition:(milestone\.[a-z][a-z0-9-]*)$/.exec(assignment ?? "");
      if (composition && !evidence.interactiveDomain)
        return (await import("./composition-work.js")).inspectCompositionFailure(job, composition[1]!, sourceHead).catch(() => null);
      const match = /^(interactive|choice|puzzle):(milestone\.[a-z][a-z0-9-]*)$/.exec(assignment ?? "");
      const domain = evidence.interactiveDomain;
      if (!match || !domain || match[1] !== "interactive" && match[1] !== domain) return null;
      return (await import("./interactive-work.js")).inspectInteractiveFailure(job, match[2]!, domain, sourceHead).catch(() => null);
    })();
  return original && isDeepStrictEqual(original.proof, failure.proof) ? original : null;
}

/** Validate the original domain receipt before the shared assessor can
 * report protocol exhaustion. No model response can create an entitlement. */
export async function authenticateNonSpecialistProtocolFailure(job: JobStartResult,
  op: GenerationOperationRecovery) {
  const proof = op.evidence.protocolFailure;
  if (!proof || op.source.jobId !== job.jobId || op.source.headSha !== await trustedHead(job)) return null;
  const path = relative(job.stateDir, proof.receiptFile).split(sep).join("/");
  if (op.operation === "idea-integration" && /^idea-protocol\/[a-f0-9]{64}$/.test(path) &&
      ["idea-selection.v1", "idea-review.v1", "idea-writer.v1"].includes(proof.contract)) {
    const saved = JSON.parse(await readFile(join(job.stateDir, "generation-idea-dispatch.json"), "utf8"));
    if (saved.jobId !== job.jobId || saved.phase !== "running" ||
        saved.task?.id !== op.evidence.ideaId || saved.task?.action !== op.evidence.action ||
        saved.task?.signature !== op.evidence.signature || saved.task?.priorHead !== op.source.headSha ||
        !isDeepStrictEqual(saved.protocolFailure, proof)) return null;
    const root = join(job.stateDir, "idea-placement-sessions");
    await authenticateSealedProtocolFailure(proof, [root]);
  } else if (op.operation === "independent-review" && op.evidence.reference === "specialist-receipt" &&
      proof.contract === "architecture.draft-review.v2" && op.evidence.assignmentId === "architecture") {
    if (!await (await import("./architecture.js")).authenticateArchitectureReviewerFailure(job, op.source.headSha!, proof)) return null;
  } else if (op.operation === "independent-review" && op.evidence.reference === "specialist-receipt" &&
      proof.contract === "composition.draft-review.v2") {
    const match = /^composition:(milestone\.[a-z][a-z0-9-]*)$/.exec(op.evidence.assignmentId ?? "");
    if (!match || !await (await import("./composition-work.js")).authenticateCompositionReviewerFailure(job, match[1]!, op.source.headSha!, proof)) return null;
  } else if (proof.contract === "dependency.proposal.v1" &&
      /^dependency-sessions\/[a-f0-9]{64}\/plan\/response$/.test(path)) {
    const { inspectDependencyPlan } = await import("./dependency-state.js");
    const plan = await inspectDependencyPlan(job);
    const entry = plan?.entries.find(e => path === "dependency-sessions/" + e.reportDigest + "/plan/response");
    if (!entry || entry.phase !== "planning" || entry.report.sourceSha !== op.source.headSha ||
        plan?.turnDigest !== op.source.turnDigest || !entry.planner) return null;
    if (await authenticateSealedProtocolFailure(proof, [join(job.stateDir, path, "..")]) !== entry.planner.sessionFile)
      return null;
  } else return null;
  return { store: "response-contract" as const, ref: path, digest: proof.transcriptDigest };
}

export async function assessGenerationOperation(input: {
  job: JobStartResult; threadId: string; turnDigest?: string;
  planVersion?: number | null; operation: Operation;
  outcome: GenerationOperationRecovery["outcome"];
  reason: string; evidence: GenerationOperationRecovery["evidence"];
  safeAction?: GenerationOperationRecovery["safeAction"];
}): Promise<GenerationOperationRecovery> {
  // An unsafe Git head is evidence to fence, not an excuse to invent a base.
  const assignmentFailure = input.evidence.assignmentFailure;
  const headSha = assignmentFailure && input.operation === "specialist-result" &&
      input.outcome === "returned-failure"
    ? await authenticateAssignmentFailure(input.job, input.evidence, assignmentFailure.sourceHeadSha)
      ? assignmentFailure.sourceHeadSha : null
    : await trustedHead(input.job).catch(() => null);
  const safeAction = input.safeAction === "continue-independent" && independentObligation(input, headSha)
    ? "continue-independent" : "reconcile-original-operation";
  return {
    version: 1, operation: input.operation,
    check: operationChecks[input.operation], checkVersion: 1, phase: "assessment",
    outcome: input.outcome, safeAction,
    source: { jobId: input.job.jobId, threadId: input.threadId,
      turnDigest: input.turnDigest ?? null, planVersion: input.planVersion ?? null, headSha },
    evidence: input.evidence, reason: input.reason,
    nextAction: safeAction === "continue-independent"
      ? input.operation === "idea-integration"
        ? "Keep the deferred idea outstanding. Continue only dependency-independent work from the same verified Story HEAD; reconsider placement when eligible source evidence changes."
        : "Keep the failed operation blocked. Continue only verified dependency-independent work at the same Story HEAD; never replay the original specialist or infer a successful review."
      : input.operation === "adaptive-admission"
        ? input.evidence.previousCheck
          ? "The original response passed its fixed format verifier but failed a distinct controller admission check. Inspect that new failure with the original fix proof; do not replay the planner."
          : "Inspect the original adaptive operation, Pi transcript, resource ledger and pinned Story source. Ambiguous or altered evidence must remain fenced; never replay the planner or dispatch a writer."
      : input.operation === "author-update-intake"
        ? "Inspect the original author message and acknowledgement receipts. Reconcile that intake before any writer or scheduler replay."
        : input.operation === "idea-integration" || input.operation === "idea-verification"
          ? "Inspect the exact idea dispatch and placement receipts, Pi session and Git worktree. Reconcile or fence the original writer; never dispatch it again from a new selection."
          : input.operation === "specialist-dispatch" || input.operation === "specialist-result"
            ? "Reconcile the original specialist receipt, committed HEAD and Pi session. Preserve ambiguous edits; only a proven unstarted operation may dispatch again."
          : input.operation === "dependency-amendment" || input.operation === "independent-review"
            ? "Revalidate the original assignment, dependency and independent-review receipts before any dependent writer proceeds. Do not treat a failed review as approval."
          : input.operation === "commit-verification" || input.operation === "completion-verification"
            ? "Recheck the original native, independent-review and affected-dependent proofs at the pinned Story HEAD. Do not declare completion or repeat a writer."
          : input.operation === "resume-reconciliation"
            ? "Inspect the original checkpoint and source-bound specialist effects; resolve the ambiguous resume before dispatching any work."
          : "Inspect the original controller checkpoint and Story proofs. Reconcile the failed scheduler operation before dispatching more work.",
  };
}
