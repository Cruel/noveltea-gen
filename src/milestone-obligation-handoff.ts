/** Source-bound handoff of reviewed Milestone promises. Canonical Story records and
 * independent stage reviews, not this private plan, establish fulfillment. */
import { isDeepStrictEqual } from "node:util";
import { execFileSync } from "./git-read-cache.js";
import type { JobStartResult } from "./job.js";
import type { EventAssignment } from "./event-specialist.js";
import { eventCompletionDigest, readEventSourceBlueprint } from "./event-work.js";
import { readReviewTurnEvidence } from "./fork-review-turn.js";
import { inspectRepairLedger } from "./repair-ledger.js";
import { assertFutureBlueprintActive, originalBlueprintReviewDigest, readReviewedMilestoneBlueprint, type MilestoneBlueprint,
  type MilestoneBlueprintPin } from "./milestone-blueprint.js";

export interface MilestoneEventSource {
  jobId: string;
  milestoneId: string;
  phase: string;
  commitSha?: string;
  expectedHead?: string;
  snapshot?: { id: string };
  contentDigest?: string;
  obligations?: string[];
  blueprintRequired?: boolean;
  blueprintPin?: MilestoneBlueprintPin;
  assignment?: EventAssignment;
  validation?: { status: string; eventIds: string[];
    milestoneState?: "complete" | "partial-choice-pending" };
}

export interface ReviewedMilestoneHandoff {
  pin: MilestoneBlueprintPin;
  supersedes?: MilestoneBlueprintPin;
  design: MilestoneBlueprint;
  eventHead: string;
  eventIds: string[];
  milestoneState: "complete" | "partial-choice-pending";
  /** Exact consumers whose prior semantic evidence must be reconsidered after supersession. */
  affected?: MilestoneRevisionImpact;
}

export interface MilestoneRevisionImpact {
  event: boolean;
  interactive: boolean;
  composition: boolean;
  completion: boolean;
}

/** Conservative causal projection: an Event contract change propagates to
 * gameplay and prose, whereas a prose-only promise does not invalidate an
 * independently reviewed Event or Choice. No old checkpoint is rewritten. */
export function milestoneRevisionImpact(before: MilestoneBlueprint,
  after: MilestoneBlueprint): MilestoneRevisionImpact {
  if (before.milestoneId !== after.milestoneId || before.schema !== after.schema)
    throw Error("A Milestone correction cannot change its original identity.");
  const owner = (design: MilestoneBlueprint, kind: "event" | "interactive" | "composition") =>
    design.downstream.filter(item => item.owner === kind);
  const event = !isDeepStrictEqual(before.events, after.events) ||
    !isDeepStrictEqual(owner(before, "event"), owner(after, "event"));
  const interactive = event ||
    !isDeepStrictEqual(owner(before, "interactive"), owner(after, "interactive"));
  const composition = interactive ||
    !isDeepStrictEqual(owner(before, "composition"), owner(after, "composition"));
  return { event, interactive, composition,
    completion: !isDeepStrictEqual(before, after) };
}

function git(job: JobStartResult, ...args: string[]): string {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"])
    delete env[key];
  return execFileSync("git", args, { cwd: job.worktreeRoot, env,
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** The Event's immutable commit and original assignment provide the ONLY
 * valid authority for this handoff. Old pre-Blueprint Events remain legacy. */
export async function historicalMilestoneHandoff(job: JobStartResult,
  source: MilestoneEventSource): Promise<ReviewedMilestoneHandoff | undefined> {
  if (source.jobId !== job.jobId || source.phase !== "committed" ||
      !source.commitSha || !source.validation || source.validation.status !== "passed")
    throw Error("Milestone obligations require an authenticated, validated Event source.");
  if (!source.blueprintPin) {
    // Removing the saved flag/pin is not a migration path for a new Event.
    // Its immutable commit records whether a Blueprint was actually used.
    const committed = git(job, "log", "-1", "--format=%B", source.commitSha);
    if (source.blueprintRequired || committed.split("\n").some(line =>
      line.startsWith("NovelTea-Milestone-Blueprint: ")))
      throw Error("Required Milestone Blueprint obligations are missing from the Event source.");
    return undefined;
  }
  const pin = source.blueprintPin;
  const milestoneState = source.validation.milestoneState;
  if (!milestoneState || !source.expectedHead || !source.snapshot?.id ||
      !source.contentDigest || !Array.isArray(source.obligations) ||
      git(job, "rev-parse", source.commitSha + "^") !== source.expectedHead ||
      !git(job, "log", "-1", "--format=%B", source.commitSha).split("\n").includes(
        "NovelTea-Event-Completion: " + eventCompletionDigest({
          milestoneId: source.milestoneId, expectedHead: source.expectedHead,
          snapshotId: source.snapshot.id, contentDigest: source.contentDigest,
          eventIds: source.validation.eventIds, milestoneState,
          obligations: source.obligations,
        })))
    throw Error("Reviewed Milestone Event state is not bound to the original committed completion.");
  if (!source.assignment || pin.milestoneId !== source.milestoneId ||
      source.assignment.milestoneId !== source.milestoneId ||
      !git(job, "log", "-1", "--format=%B", source.commitSha).split("\n")
        .includes("NovelTea-Milestone-Blueprint: " + pin.digest))
    throw Error("Milestone Blueprint is not linked to the original committed Event assignment.");
  git(job, "merge-base", "--is-ancestor", pin.sourceSha, source.commitSha);
  const design = await readEventSourceBlueprint(job, pin, source.assignment, source.expectedHead);
  const consumed = source.assignment.milestoneBlueprint;
  if (consumed && (consumed.digest !== pin.digest || JSON.stringify(consumed.design) !== JSON.stringify(design)))
    throw Error("Event assignment differs from the original reviewed Blueprint.");
  return { pin, design, eventHead: source.commitSha,
    eventIds: [...source.validation.eventIds],
    milestoneState };
}

/** Pending assignments consume only the current approved successor. Always
 * authenticate the Event against its original pin first, never against HEAD. */
export async function reviewedMilestoneHandoff(job: JobStartResult, source: MilestoneEventSource): Promise<ReviewedMilestoneHandoff | undefined> {
  const historical = await historicalMilestoneHandoff(job, source);
  if (!historical || !source.assignment) return historical;
  const turn = await readReviewTurnEvidence(job);
  const repair = turn && (await inspectRepairLedger(job, turn.digest)).blueprintRepairs?.find(r =>
    r.original.milestoneId === source.milestoneId);
  if (!repair) {
    await assertFutureBlueprintActive(job, historical.pin);
    return historical;
  }
  if (repair.eventHead !== historical.eventHead || JSON.stringify(repair.original) !== JSON.stringify(historical.pin) || !repair.successor)
    throw Error("Milestone Blueprint correction is unresolved or has a different historical Event source.");
  git(job, "merge-base", "--is-ancestor", historical.eventHead, repair.sourceSha);
  git(job, "merge-base", "--is-ancestor", repair.sourceSha, "HEAD");
  if (await originalBlueprintReviewDigest(job, historical.pin) !== repair.originalReviewDigest)
    throw Error("Original Blueprint review history changed after supersession.");
  await assertFutureBlueprintActive(job, repair.successor, { original: repair.original, eventHead: repair.eventHead,
    turnDigest: turn!.digest, evidenceDigest: repair.evidenceDigest, originalReviewDigest: repair.originalReviewDigest });
  const design = await readReviewedMilestoneBlueprint(job, repair.successor, source.assignment);
  const affected = milestoneRevisionImpact(historical.design, design);
  if (!affected.completion || repair.affected && JSON.stringify(repair.affected) !== JSON.stringify(affected))
    throw Error("Blueprint supersession lost its authenticated selective dependent impact.");
  return { ...historical, design, pin: repair.successor, supersedes: historical.pin, affected };
}

export function consumedCorrection(handoff?: ReviewedMilestoneHandoff) {
  return handoff?.supersedes ? handoff.pin : undefined;
}

/** An omission is not authorization to discard promises assigned to an
 * interactive specialist. Neither a different Puzzle quota nor a writer's
 * assertion of optionality may override that reviewed owner link. */
export function assertMilestoneInteractiveDisposition(
  handoff: ReviewedMilestoneHandoff | undefined, eventOnly: boolean): void {
  if (eventOnly && handoff?.design.downstream.some(item => item.owner === "interactive"))
    throw Error("Event-only omission leaves reviewed interactive Milestone obligations without an owner.");
}

/** Controller-owned deterministic closure: only real reachable canonical Event
 * routes fulfill a Milestone. The independent reviewer judges whether those
 * routes also discharge the plan's semantic evidence/Choice/prose promises. */
export function assertMilestoneCanonicalClosure(
  handoff: ReviewedMilestoneHandoff | undefined,
  milestoneId: string,
  records: ReadonlyArray<{ metadata: Record<string, any> }>,
  routes: ReadonlyArray<{ id: string; routes: Array<{ status: string }> }>,
): void {
  if (!handoff) return; // Explicit historical pre-Blueprint Event.
  if (handoff.design.milestoneId !== milestoneId)
    throw Error("Milestone closeout references the wrong reviewed local plan.");
  const milestone = records.find(record => record.metadata.id === milestoneId &&
    record.metadata.type === "milestone" && record.metadata.status !== "superseded");
  const alternatives: unknown = milestone?.metadata.fulfillment?.any_of;
  const coverage = routes.find(item => item.id === milestoneId)?.routes;
  // Canonical schema permits omitted completeness for a fully specified
  // Milestone; only explicit partial status marks deferred authorization.
  if (milestone?.metadata.completeness === "partial" ||
      !Array.isArray(alternatives) || !alternatives.length ||
      !coverage?.length || coverage.length !== alternatives.length ||
      coverage.some(route => route.status !== "reachable"))
    throw Error("Reviewed Milestone has unresolved canonical fulfillment routes; a Blueprint promise is not closeout.");
}
