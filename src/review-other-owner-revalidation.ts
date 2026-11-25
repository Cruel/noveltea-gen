/** Revalidate already-reviewed consumers after a separately authorized
 * existing-record prerequisite correction. The original GenerationInventory
 * remains the one causal DAG; no guessed dependency list or passed verdicts. */
import type { JobStartResult } from "./job.js";
import type { CompletionContract } from "./architecture.js";
import type { GenerationInventory } from "./generation-plan.js";
import { reviewOtherOwners, type ReviewDependencyRequest } from "./review-repair-amendment.js";
import { executionId } from "./checkpoint-assurance.js";
import { dependencyDigest, dependencyGit, inspectDependencyPlan, dependencyTurn } from "./dependency-state.js";
import { inspectRecoveryCheckpoints } from "./recovery-checkpoints.js";
import { assertCompletedOtherOwnerRevalidation, revalidateAfterReviewedCorrection } from "./selective-revalidation-work.js";

/** Review coverage is never inferred from the supporting commit alone. A
 * completed, authenticated dependent-revalidation receipt is required. */
export async function hasCompletedOtherOwnerDependentRevalidation(job: JobStartResult,
  source: { baseSha: string; successorSha: string; turnDigest: string; path: string }): Promise<boolean> {
  try {
    await assertCompletedOtherOwnerRevalidation(job, source);
    return true;
  } catch { return false; }
}

/** Recover the gap between a verified other-owner supporting commit and
 * dependent revalidation. This runs at the safe author-intake boundary BEFORE
 * inventory reconciliation can grant downstream writer authority. Both the
 * original failed checkpoint and the supporting commit remain immutable.
 * An interrupted revalidation uses its existing receipt, never a new writer. */
export async function settlePendingOtherOwnerRevalidations(input: {
  job: JobStartResult; inventory: GenerationInventory | undefined;
  contract: CompletionContract; task: string; provider: string; model: string;
  skillsSource?: string; validatorSource?: string;
}) {
  const plan = await inspectDependencyPlan(input.job);
  for (const request of plan?.reviewRequests ?? []) {
    if (request.classification !== "other-owner") continue;
    const entries = plan!.entries.filter(entry => entry.reviewSourceSha === request.sourceSha);
    if (!entries.length) continue; // The supporting grant has not completed.
    if (entries.length !== 1)
      throw Error("Other-owner supporting receipt is not unique.");
    const entry = entries[0]!;
    // Work not yet reviewed by the supporting owner stays under the original
    // dependency controller. Do not preempt its authorized work-item recovery.
    if (entry.phase !== "verified") continue;
    if (!entry.commitSha || !request.otherOwnerPath ||
        entry.originalReview?.verdict !== "pass" || entry.review?.verdict !== "pass")
      throw Error("Verified other-owner support lacks both independent reviews.");
    const source = { baseSha: request.sourceSha, successorSha: entry.commitSha,
      turnDigest: request.turnDigest, path: request.otherOwnerPath };
    if (await hasCompletedOtherOwnerDependentRevalidation(input.job, source)) continue;
    // Verification may only proceed through the same source-bound original
    // revalidation receipt. Any corrupt or unsafe in-flight reviewer remains
    // blocked by its own reconciliation checks.
    await revalidateOtherOwnerPrerequisite({ ...input, request });
  }
}

/** The final Turn verdict must never use an other-owner positive rereview
 * without the separately sealed dependent revalidation. An interrupted
 * reviewer can be resumed through its persisted workflow, not marked done. */
export async function assertOtherOwnerGenerationCompletion(job: JobStartResult) {
  const plan = await inspectDependencyPlan(job);
  for (const request of plan?.reviewRequests ?? []) {
    if (request.classification !== "other-owner") continue;
    const entries = plan!.entries.filter(entry => entry.reviewSourceSha === request.sourceSha);
    const entry = entries[0];
    if (entries.length !== 1 || entry?.phase !== "verified" || !entry.commitSha ||
        !request.otherOwnerPath || entry.originalReview?.verdict !== "pass" ||
        entry.review?.verdict !== "pass")
      throw Error("Turn completion has an unresolved cross-specialist prerequisite.");
    await assertCompletedOtherOwnerRevalidation(job, {
      baseSha: request.sourceSha, successorSha: entry.commitSha,
      turnDigest: request.turnDigest, path: request.otherOwnerPath,
    });
  }
}

export async function revalidateOtherOwnerPrerequisite(input: {
  job: JobStartResult;
  request: ReviewDependencyRequest;
  inventory: GenerationInventory | undefined;
  contract: CompletionContract;
  task: string;
  provider: string;
  model: string;
  skillsSource?: string;
  validatorSource?: string;
}) {
  const { job, request, inventory } = input;
  const path = request.otherOwnerPath;
  if (request.classification !== "other-owner" || !path || !inventory ||
      inventory.planVersion !== request.basePlanVersion ||
      inventory.items.some(item => item.status === "verified" && !item.verifiedSha))
    throw Error("Other-owner revalidation has no authenticated original execution inventory.");
  dependencyGit(job, "merge-base", "--is-ancestor", inventory.headSha, request.sourceSha);
  const turn = await dependencyTurn(job);
  const owners = reviewOtherOwners(turn, request.originalAssignmentId, path, request.otherOwnerCheckpoint);
  if (owners.length !== 1 || turn.digest !== request.turnDigest)
    throw Error("Other-owner revalidation cannot reconstruct exactly one original writer.");
  const checkpoints = (await inspectRecoveryCheckpoints(job)).filter(point =>
    point.eligible && point.assurance?.turnDigest === request.turnDigest &&
    point.assurance.assignmentId === owners[0]!.id);
  const producer = request.otherOwnerCheckpoint;
  const upstream = inventory.items.filter(item => item.status === "verified" &&
    checkpoints.some(point => point.commitSha === item.verifiedSha) &&
    (!producer || item.id === executionId(producer.workItem)));
  if (producer && upstream.length === 1 && upstream[0]?.verifiedSha)
    dependencyGit(job, "merge-base", "--is-ancestor", producer.commitSha, upstream[0].verifiedSha);
  if (upstream.length !== 1 || !upstream[0]?.verifiedSha)
    throw Error("Prerequisite's previous reviewed owner has no unique completed inventory node.");
  dependencyGit(job, "merge-base", "--is-ancestor", upstream[0].verifiedSha, request.sourceSha);
  const plan = await inspectDependencyPlan(job);
  const entries = plan?.entries.filter(entry => entry.reviewSourceSha === request.sourceSha);
  const entry = entries?.[0];
  if (entries?.length !== 1 || entry?.phase !== "verified" ||
      !entry.commitSha || entry.review?.verdict !== "pass" ||
      entry.originalReview?.verdict !== "pass" ||
      entry.amendment?.assignment.authority.existingPaths.length !== 1 ||
      entry.amendment.assignment.authority.existingPaths[0] !== path ||
      entry.amendment.sourceSha !== request.sourceSha)
    throw Error("Other-owner revalidation lacks a verified supporting work and both independent reviews.");
  dependencyGit(job, "merge-base", "--is-ancestor", entry.commitSha, dependencyGit(job, "rev-parse", "HEAD"));
  await revalidateAfterReviewedCorrection({
    job, otherOwnerPath: path,
    // This graph snapshot precedes the failed original review's checkpoint.
    // Its still-pending original item must not be reclassified as verified.
    inventory: { ...inventory, headSha: request.sourceSha },
    correction: {
      version: 1, planVersion: request.basePlanVersion,
      baseSha: request.sourceSha, successorSha: entry.commitSha,
      upstreamItemId: upstream[0].id,
      predecessorCommitSha: upstream[0].verifiedSha,
      turnDigest: request.turnDigest,
      reviewDigest: dependencyDigest({
        sourceSha: request.sourceSha, commitSha: entry.commitSha,
        support: entry.review, original: entry.originalReview,
      }),
      changedPaths: [path], permittedPaths: [path],
    },
    contract: input.contract, task: input.task, provider: input.provider, model: input.model,
    skillsSource: input.skillsSource, validatorSource: input.validatorSource,
  });
  await assertCompletedOtherOwnerRevalidation(job, {
    baseSha: request.sourceSha, successorSha: entry.commitSha,
    turnDigest: request.turnDigest, path,
  });
}
