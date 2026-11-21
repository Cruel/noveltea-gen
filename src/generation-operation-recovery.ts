/** Source-bound controller disposition for non-specialist Turn boundaries.
 * The generation graph checkpoints assessment before this disposition is
 * executed. No receipt here grants a new writer invocation or author consent. */
import type { JobStartResult } from "./job.js";
import { trustedHead } from "./revision.js";

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
    ideaId?: string; action?: "place" | "reassess"; signature?: string;
    priorHead?: string;
    /** A known verifier fix can expose a *new* admission failure, not
     * another failure of the fixed response format contract. */
    previousCheck?: string; previousCheckVersion?: number; previousSignature?: string;
  };
  reason: string;
  nextAction: string;
}

export async function assessGenerationOperation(input: {
  job: JobStartResult; threadId: string; turnDigest?: string;
  planVersion?: number | null; operation: Operation;
  outcome: GenerationOperationRecovery["outcome"];
  reason: string; evidence: GenerationOperationRecovery["evidence"];
  safeAction?: GenerationOperationRecovery["safeAction"];
}): Promise<GenerationOperationRecovery> {
  // An unsafe Git head is evidence to fence, not an excuse to invent a base.
  const headSha = await trustedHead(input.job).catch(() => null);
  const noWriteIdea = input.operation === "idea-integration" &&
    input.evidence.resultStatus === "deferred";
  const settledSpecialistFailure = input.operation === "specialist-dispatch" &&
    input.outcome === "exception" && input.evidence.reference === "specialist-receipt" &&
    !!input.evidence.assignmentId;
  const safeAction = input.safeAction === "continue-independent" && headSha &&
    headSha === input.evidence.priorHead && (noWriteIdea || settledSpecialistFailure)
    ? "continue-independent" : "reconcile-original-operation";
  return {
    version: 1, operation: input.operation,
    check: operationChecks[input.operation], checkVersion: 1, phase: "assessment",
    outcome: input.outcome, safeAction,
    source: { jobId: input.job.jobId, threadId: input.threadId,
      turnDigest: input.turnDigest ?? null, planVersion: input.planVersion ?? null, headSha },
    evidence: input.evidence, reason: input.reason,
    nextAction: safeAction === "continue-independent"
      ? noWriteIdea
        ? "Keep the deferred idea outstanding. Continue only dependency-independent work from the same verified Story HEAD; reconsider placement when eligible source evidence changes."
        : "Keep the failed operation blocked. Continue only verified dependency-independent work at the same Story HEAD; never replay the original specialist or infer a successful review."
      : input.operation === "adaptive-admission"
        ? "The original response passed its fixed format verifier but failed a distinct controller admission check. Inspect that new failure with the original fix proof; do not replay the planner."
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
