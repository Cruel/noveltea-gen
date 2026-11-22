/** Read-only reconciliation of a completed specialist result at a failed parent
 * verification boundary. This adapter never dispatches a model or grants work.
 * The same proof is required by Studio admission and the LangGraph entrypoint. */
import { createHash } from "node:crypto";
import type { JobStartResult } from "./job.js";
import { inspectRecoveryCheckpoints } from "./recovery-checkpoints.js";
import { executionId } from "./checkpoint-assurance.js";
import { inspectRepairLedger, inspectApprovalRevisionIncidents } from "./repair-ledger.js";
import { reviewedMilestoneHandoff } from "./milestone-obligation-handoff.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { GenerationOperationRecovery } from "./generation-operation-recovery.js";
import type { GenerationStage } from "./generation-plan.js";
import { verifyPlanHistory } from "./architecture.js";
import { hasPlanContinuity } from "./plan-continuity.js";
import { trustedHead } from "./revision.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export type VerifierInput = NonNullable<GenerationOperationRecovery["evidence"]["verifier"]>;
export type VerifiedResult = { status?: string; headSha?: string } | null | undefined;
export type VerifierAssignment = { id: string; stage: GenerationStage; milestone?: string } | null | undefined;

export const verifiableResultStatus: Record<GenerationStage, readonly string[]> = {
  foundation: ["committed"], architecture: ["architecture-committed", "complete-in-scope"],
  foundations: ["foundations-committed"], event: ["event-cluster-committed"],
  interactive: ["interactive-slice-committed"], choice: ["interactive-choice-committed"],
  puzzle: ["interactive-slice-committed"], composition: ["composition-committed"],
  focus: ["focused-committed"], review: ["complete-in-scope"],
};

/** A valid checkpoint is a specialist proof, not a mutable graph completion flag.
 * Commitless/no-write results require their own specialist adapter and cannot
 * pretend to have a new Git checkpoint. */
async function reviewedWork(job: JobStartResult, assignment: VerifierAssignment,
  result: VerifiedResult) {
  if (!assignment?.id || !result?.headSha ||
      !verifiableResultStatus[assignment.stage]?.includes(result.status ?? ""))
    throw Error("The original verifier has no accepted completed assignment/result.");
  const checkpoints = (await inspectRecoveryCheckpoints(job)).filter(p =>
    p.eligible && p.commitSha === result.headSha &&
    executionId(p.workItem) === assignment.id &&
    (!p.assurance || ["passed", "not-required"].includes(p.semanticReview)));
  if (checkpoints.length !== 1)
    throw Error("Original result lacks a unique, independently verified and reviewed checkpoint.");
  const point = checkpoints[0]!;
  if (point.assurance && point.semanticReview !== "passed" &&
      point.semanticReview !== "not-required")
    throw Error("The original specialist's independent review has not passed.");
  return { workItem: point.workItem, proofDigest: hash({
    source: point.commitSha, workItem: point.workItem,
    proofDigest: point.proofDigest, assurance: point.assurance,
    completedWorkItems: point.completedWorkItems,
  }) };
}

/** Source-bound changes relevant to this assignment, not an arbitrary new
 * timestamp, error message or changed file. The Repair ledger authenticates
 * historical revisions; the existing Milestone handoff rechecks current
 * independent approval and supersession. */
async function correctionDigest(job: JobStartResult, turnDigest: string,
  assignment: VerifierAssignment, planVersion: number | null) {
  const ledger = await inspectRepairLedger(job, turnDigest);
  const revisions: unknown[] = [];
  let signedCarry = false;
  for (const repair of ledger.blueprintRepairs ?? []) {
    if (!repair.successor || !repair.incident ||
        !assignment?.milestone || repair.original.milestoneId !== assignment.milestone) continue;
    // A correction that invalidates the already-completed result is not
    // permission to carry that result forward. It needs independent selective
    // revalidation through the existing stage-specific correction lifecycle.
    const stage = assignment.stage === "choice" || assignment.stage === "puzzle"
      ? "interactive" : assignment.stage;
    if (!repair.affected || stage === "event" && repair.affected.event ||
        stage === "interactive" && repair.affected.interactive ||
        stage === "composition" && repair.affected.composition ||
        stage === "review" && repair.affected.completion)
      throw Error("Correction affects the completed specialist; targeted revalidation is required.");
    const event = JSON.parse(await readFile(join(job.stateDir, "event-items",
      repair.original.milestoneId.slice("milestone.".length) + ".json"), "utf8"));
    const handoff = await reviewedMilestoneHandoff(job, event);
    if (!handoff || handoff.pin.digest !== repair.successor.digest ||
        handoff.eventHead !== repair.eventHead || !handoff.supersedes)
      throw Error("Corrected Milestone obligations lost independently approved lineage.");
    const inspected = await inspectApprovalRevisionIncidents(job, {
      milestoneId: repair.original.milestoneId, limit: 100 });
    if (!inspected.records.some(incident => incident.id === repair.incident!.id &&
        incident.disposition === "corrected" &&
        incident.successor?.digest === repair.successor!.digest))
      throw Error("Corrected approval lacks durable, independently inspected incident evidence.");
    revisions.push({ id: repair.incident.id, successor: repair.successor,
      affected: repair.affected, source: repair.sourceSha });
  }
  // A separately signed Architecture replan can carry forward unchanged
  // reviewed work without another Git commit. Its exact historical specialist
  // receipt and each intervening controller signature are verified by the
  // existing plan-continuity adapter; a new plan version by itself is NOT a
  // correction or an authority to reuse the old result.
  if (planVersion !== null && planVersion >= 1) {
    const architecture = JSON.parse(await readFile(join(job.stateDir, "architecture.json"),
      "utf8"));
    verifyPlanHistory(job, architecture);
    if (architecture.plan?.version > planVersion) {
      const stage = assignment?.stage === "choice" || assignment?.stage === "puzzle"
        ? "interactive" : assignment?.stage;
      const id = stage === "foundations" ? "foundations" :
        ["event", "interactive", "composition"].includes(stage ?? "") && assignment?.milestone
          ? stage + ":" + assignment.milestone : null;
      if (!id || !hasPlanContinuity(job, architecture, id, planVersion))
        throw Error("Signed Architecture revision does not carry forward the original reviewed assignment.");
      // The corrected Architecture checkpoint itself must still be the
      // current source. A later unrelated specialist commit makes an old
      // blocked parent verifier stale, even when the carry-forward remains
      // valid historical provenance.
      const head = await trustedHead(job);
      const checkpoint = (await inspectRecoveryCheckpoints(job)).find(point =>
        point.eligible && point.commitSha === head &&
        point.workItem === "global-architecture" &&
        point.planVersion === architecture.plan.version &&
        (!point.assurance || ["passed", "not-required"].includes(point.semanticReview)));
      if (!checkpoint)
        throw Error("Signed carry-forward requires the current reviewed Architecture checkpoint; later work cannot revive an old verifier.");
      signedCarry = true;
      revisions.push({ kind: "signed-architecture-carry", id,
        sourceVersion: planVersion, verifiedVersion: architecture.plan.version,
        lineage: architecture.history?.map((step: { proposal: string; carryForward?: string[] }) =>
          ({ proposal: step.proposal, carried: step.carryForward })) });
    }
  }
  return { digest: hash(revisions), signedCarry };
}

export async function captureVerificationFailure(job: JobStartResult, turnDigest: string,
  assignment: VerifierAssignment, result: VerifiedResult,
  planVersion: number | null): Promise<VerifierInput> {
  const checkpoint = await reviewedWork(job, assignment, result);
  return { assignmentId: assignment!.id, stage: assignment!.stage,
    resultStatus: result!.status!, resultHeadSha: result!.headSha!,
    checkpointWorkItem: checkpoint.workItem, checkpointDigest: checkpoint.proofDigest,
    planVersion, correctionDigest: (await correctionDigest(job, turnDigest, assignment, planVersion)).digest };
}

export async function verifyCorrectedOriginalResult(job: JobStartResult,
  turnDigest: string, assignment: VerifierAssignment, result: VerifiedResult,
  evidence: VerifierInput, planVersion: number | null): Promise<{ eligible: boolean; reason: string }> {
  const refuse = (reason: string) => ({ eligible: false, reason });
  if (!assignment || !result || evidence.assignmentId !== assignment.id ||
      evidence.stage !== assignment.stage || evidence.resultStatus !== result.status ||
      evidence.resultHeadSha !== result.headSha ||
      evidence.planVersion !== planVersion)
    return refuse("Checkpointed verifier input differs from the original completed specialist.");
  try {
    const checkpoint = await reviewedWork(job, assignment, result);
    if (evidence.checkpointWorkItem !== checkpoint.workItem ||
        evidence.checkpointDigest !== checkpoint.proofDigest)
      throw Error("Original reviewed checkpoint or specialist receipt changed.");
    const corrected = await correctionDigest(job, turnDigest, assignment, planVersion);
    if (corrected.digest === evidence.correctionDigest)
      throw Error("The original failed verifier has no new authenticated corrective evidence.");
    if (await trustedHead(job) !== result.headSha && !corrected.signedCarry)
      throw Error("Story HEAD advanced without exact signed carry-forward of the original specialist.");
    return { eligible: true,
      reason: "Original completed specialist and reviewed correction are authenticated; retry its parent verifier without writer or reviewer replay." };
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  }
}
