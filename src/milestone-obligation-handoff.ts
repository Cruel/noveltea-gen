/** Source-bound handoff of reviewed Milestone promises. Canonical Story records and
 * independent stage reviews, not this private plan, establish fulfillment. */
import { execFileSync } from "./git-read-cache.js";
import type { JobStartResult } from "./job.js";
import type { EventAssignment } from "./event-specialist.js";
import { eventCompletionDigest } from "./event-work.js";
import { readReviewedMilestoneBlueprint, type MilestoneBlueprint,
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
  design: MilestoneBlueprint;
  eventHead: string;
  eventIds: string[];
  milestoneState: "complete" | "partial-choice-pending";
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
export async function reviewedMilestoneHandoff(job: JobStartResult,
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
  const design = await readReviewedMilestoneBlueprint(job, pin, source.assignment);
  return { pin, design, eventHead: source.commitSha,
    eventIds: [...source.validation.eventIds],
    milestoneState };
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
