/** Revalidate already-reviewed consumers after a separately authorized
 * existing-record prerequisite correction. The original GenerationInventory
 * remains the one causal DAG; no guessed dependency list or passed verdicts. */
import type { JobStartResult } from "./job.js";
import type { CompletionContract } from "./architecture.js";
import type { GenerationInventory } from "./generation-plan.js";
import type { ReviewDependencyRequest } from "./review-repair-amendment.js";
import { dependencyDigest, dependencyGit, inspectDependencyPlan, dependencyTurn } from "./dependency-state.js";
import { inspectRecoveryCheckpoints } from "./recovery-checkpoints.js";
import { revalidateAfterReviewedCorrection } from "./selective-revalidation-work.js";

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
  const owners = turn.assignments.filter(a => a.id !== request.originalAssignmentId &&
    a.authority.existingPaths.includes(path));
  if (owners.length !== 1 || turn.digest !== request.turnDigest)
    throw Error("Other-owner revalidation cannot reconstruct exactly one original writer.");
  const checkpoints = (await inspectRecoveryCheckpoints(job)).filter(point =>
    point.eligible && point.assurance?.turnDigest === request.turnDigest &&
    point.assurance.assignmentId === owners[0]!.id);
  const upstream = inventory.items.filter(item => item.status === "verified" &&
    checkpoints.some(point => point.commitSha === item.verifiedSha));
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
    job,
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
}
