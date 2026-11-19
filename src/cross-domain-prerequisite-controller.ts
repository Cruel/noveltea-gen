/** Trusted prerequisite admission before Composition's external Pi writer.
 *
 * A canonical Milestone route, an already signed Event field grant and exact
 * reviewed Choice checkpoint are all mandatory. No specialist's claim can
 * create an additional record owner, change the Turn goal or bypass review.
 * Call under the original job writer lease.
 */
import { existsSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "./git-read-cache.js";
import { readTurnEvidence } from "./turn-plan-evidence.js";
import { inspectRecoveryCheckpoints } from "./recovery-checkpoints.js";
import { readEventMilestoneRepairGrant } from "./event-milestone-repair.js";
import { inspectCompositionPrerequisite,
  type CloseoutProposal, type CompositionPrerequisiteInput } from "./cross-domain-prerequisite.js";
import { admitPrerequisiteRepair, inspectRepairLedger } from "./repair-ledger.js";
import { assertCompletedSelectiveRevalidation } from "./selective-revalidation-work.js";
import { validateStoryJob } from "./validator.js";
import { trustedHead } from "./revision.js";
import type { JobStartResult } from "./job.js";
import type { CompletionContract } from "./architecture.js";

export interface CompositionBoundaryRequest {
  contract: CompletionContract; task: string; turnPlanDigest?: string;
  validatorSource?: string; skillsSource?: string; fixture?: boolean;
}
export type CompositionBoundaryDecision =
  | { kind: "ready" }
  | { kind: "refuse"; reason: string }
  | { kind: "author-required"; reason: string }
  | { kind: "repair"; proposal: CloseoutProposal; repairId: string; turnDigest: string };

async function readReceipt(job: JobStartResult, folder: string, milestone: string) {
  const file = join(job.stateDir, folder, milestone.slice("milestone.".length) + ".json");
  if (!existsSync(file)) throw Error("Cross-domain prerequisite has no original specialist receipt.");
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512_000)
    throw Error("Cross-domain prerequisite source receipt is unsafe.");
  return JSON.parse(await readFile(file, "utf8")) as Record<string, any>;
}
function ancestor(job: JobStartResult, old: string, head: string) {
  const env = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"])
    delete env[name];
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", old, head],
      { cwd: job.worktreeRoot, env, stdio: "pipe" });
    return true;
  } catch { return false; }
}

/** Pinned and source-bound controller decision. This must be rerun after any
 * writer/reviewer outcome; a saved open finding is never an access token. */
export async function preflightCompositionBoundary(
  job: JobStartResult, request: CompositionBoundaryRequest,
  milestoneId: string, planVersion: number,
): Promise<CompositionBoundaryDecision> {
  const refuse = (reason: string): CompositionBoundaryDecision => ({ kind: "refuse", reason });
  // Existing pre-cutover Turns did not persist the modern objective pin.
  // No additional write authority is granted for those runs: the original
  // Composition, Event, and Interactive validators remain authoritative.
  if (!request.turnPlanDigest) return { kind: "ready" };
  const turn = await readTurnEvidence(job, request.contract, request.task, request.turnPlanDigest);
  if (!turn || turn.kind !== "full-story" || turn.objective?.breadth !== "whole-story" ||
      turn.objective.deliveryDepth !== "composition" ||
      turn.contract.scope.depth !== "composition" || turn.digest !== request.turnPlanDigest)
    return { kind: "author-required", reason:
      "The original Turn has no whole-Story authority for this additional Event/Choice closeout. " +
      "Obtain a separately approved bounded scope amendment; do not synthesize a writer grant." };
  const eventOwner = turn.assignments.find(a => a.id === "event");
  const choiceOwner = turn.assignments.find(a => a.id === "interactive");
  const composition = turn.assignments.find(a => a.id === "composition");
  if (!eventOwner || eventOwner.specialist !== "nt-event-design" ||
      !eventOwner.authority.recordTypes.includes("event") ||
      !choiceOwner || !composition || composition.id !== "composition")
    return refuse("Original Turn has no approved Event, Interactive and Composition owners.");
  const head = await trustedHead(job);
  const event = await readReceipt(job, "event-items", milestoneId);
  const interactive = await readReceipt(job, "interactive-items", milestoneId);
  // Fully realized Event-only Milestones intentionally have no Choice commit.
  // Defer to the existing Composition omission/proof gate rather than treating
  // their valid reviewed omission as an unmet closeout prerequisite.
  if (event.validation?.status === "passed" &&
      event.validation.milestoneState === "complete") return { kind: "ready" };
  const point = (await inspectRecoveryCheckpoints(job)).find(p =>
    p.eligible && p.workItem === "event-" + milestoneId.slice("milestone.".length) &&
    p.commitSha === event.commitSha);
  if (!point || point.semanticReview !== "passed" ||
      point.assurance?.assignmentId !== "event" ||
      point.assurance?.turnDigest !== turn.digest ||
      point.planVersion !== planVersion || !ancestor(job, event.commitSha, head))
    return refuse("Original Event has no independently reviewed, Turn-bound native checkpoint.");
  const grant = await readEventMilestoneRepairGrant(job, point, eventOwner,
    "deferred-choice-closeout");
  if (!grant) return refuse("Original Event has no signed selected Milestone field grant.");
  if (!Array.isArray(interactive.units) || interactive.units.length !== 2 ||
      !ancestor(job, interactive.units[0]?.commitSha ?? "", head) ||
      interactive.units[0]?.commitSha === event.commitSha ||
      (interactive.units[1]?.phase === "committed" &&
        !ancestor(job, interactive.units[1].commitSha ?? "", head)))
    return refuse("Choice/Puzzle source is stale, unreviewed or not on the verified Story branch.");
  // This exact Choice/Puzzle source must have independently passed before
  // the controller may propose a narrower Event-owned correction.
  const checkpoints = await inspectRecoveryCheckpoints(job);
  const choicePoint = checkpoints.find(p => p.eligible && p.commitSha === interactive.units[0].commitSha);
  const puzzle = interactive.units[1]?.phase === "committed"
    ? checkpoints.find(p => p.eligible && p.commitSha === interactive.units[1].commitSha) : null;
  if (!choicePoint || choicePoint.workItem !== "interactive-choice-" + milestoneId.slice(10) ||
      choicePoint.semanticReview !== "passed" ||
      choicePoint.assurance?.turnDigest !== turn.digest ||
      (interactive.units[1]?.phase === "committed" &&
        (!puzzle || puzzle.semanticReview !== "passed" ||
          puzzle.assurance?.turnDigest !== turn.digest)))
    return refuse("Deferred Milestone has no fresh independently approved Choice/Puzzle prerequisite.");
  const checked = await validateStoryJob(job, request.validatorSource ?? request.skillsSource,
    { ...job, baseSha: head });
  const report = checked.report as unknown as CompositionPrerequisiteInput["report"] & {
    diagnostics: unknown[];
    protection: { status: string; base: string; changes: unknown[]; warnings: unknown[] };
  };
  if (report?.protection?.status === "checked" && report.protection.base === head &&
      (report.protection.changes.length || report.protection.warnings.length))
    return { kind: "author-required", reason:
      "Original Story contains protected-authority changes; obtain exact author approval." };
  if (checked.status !== "passed" || !report || !Array.isArray(report.diagnostics) ||
      report.diagnostics.length || report.protection?.status !== "checked" ||
      report.protection.base !== head)
    return refuse("Native Story/protection preflight is not valid at exact current HEAD.");
  if (await trustedHead(job) !== head)
    return refuse("Composition prerequisite source HEAD changed during preflight.");
  const examined = inspectCompositionPrerequisite({
    headSha: head, milestoneId, planVersion, selectedMilestone: grant,
    event: event as unknown as CompositionPrerequisiteInput["event"],
    interactive: interactive as unknown as CompositionPrerequisiteInput["interactive"],
    report,
  });
  const ledger = await inspectRepairLedger(job, turn.digest);
  const prior = ledger.prerequisites?.find(p => p.milestoneId === milestoneId);
  if (examined.kind === "ready") {
    if (prior && (prior.status !== "resolved" || !prior.attempts.some(a =>
      a.verdict === "passed" && ancestor(job, a.submittedSha, head))))
      return refuse("Milestone metadata is complete but the original prerequisite review remains unresolved.");
    if (prior) {
      const lastPassed = [...prior.attempts].reverse().find(a => a.verdict === "passed" &&
        ancestor(job, a.submittedSha, head));
      if (!lastPassed?.reviewDigest) return refuse("Missing independent correction review.");
      try {
        await assertCompletedSelectiveRevalidation(job, lastPassed.submittedSha,
          turn.digest, lastPassed.reviewDigest);
      } catch (error) {
        return refuse("Dependent revalidation is not complete: " + String(error));
      }
    }
    return examined;
  }
  if (examined.kind === "refuse") return examined;
  // Existing protected/approval policy remains authoritative: the proposed
  // exact field change is already part of the original Event scope, not a new
  // author decision or permission to retcon Milestone prose. For other missing
  // prerequisites fail closed until an authenticated expansion is approved.
  if (request.fixture)
    return refuse("Fixture cannot authorize a production dependency closeout.");
  const repair = await admitPrerequisiteRepair(job, {
    turnDigest: turn.digest, milestoneId, path: grant.path,
    sourceEventSha: event.commitSha, proposalDigest: examined.proposal.digest,
    sourceSha: head, planVersion,
  });
  return { kind: "repair", proposal: examined.proposal,
    repairId: repair.id, turnDigest: turn.digest };
}
