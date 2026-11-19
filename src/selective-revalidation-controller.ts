/** Trusted projection of already-reviewed Story work onto a *new* upstream
 * revision. The only work dependency graph is GenerationInventory. Original
 * native checkpoints, their mandatory reviews and the original Turn are
 * reauthenticated before any prior result is carried forward.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "./git-read-cache.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobStartResult } from "./job.js";
import type { GenerationInventory, ExecutionItem } from "./generation-plan.js";
import { inspectRecoveryCheckpoints, type RecoveryInspection } from "./recovery-checkpoints.js";
import { inspectCheckpointReview } from "./checkpoint-assurance.js";
import { readReviewTurnEvidence } from "./fork-review-turn.js";
import { planSelectiveRevalidation, type ReviewedUpstreamCorrection,
  type ReviewedConsumerEvidence, type SelectiveRevalidationPlan } from "./selective-revalidation.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const PATH = /^[a-z][a-z0-9-]*\/[a-z0-9._-]+\.md$/;
const recordPath = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every(path => typeof path === "string" && PATH.test(path))
    ? value : null;
function ancestor(job: JobStartResult, old: string, current: string) {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"])
    delete env[key];
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", old, current],
      { cwd: job.worktreeRoot, env, stdio: "pipe" });
    return true;
  } catch { return false; }
}
function workItems(item: ExecutionItem): string[] {
  if (item.stage === "architecture") return ["global-architecture"];
  if (item.stage === "foundation") return ["foundation"];
  if (item.stage === "foundations") return ["character-foundations", "world-foundations"];
  if (!item.milestone || !/^milestone\.[a-z][a-z0-9-]*$/.test(item.milestone))
    return [];
  const slug = item.milestone.slice(10);
  if (item.stage === "event") return ["event-" + slug];
  if (item.stage === "interactive")
    return ["interactive-choice-" + slug, "interactive-puzzle-" + slug];
  if (item.stage === "choice") return ["interactive-choice-" + slug];
  if (item.stage === "puzzle") return ["interactive-puzzle-" + slug];
  if (item.stage === "composition") return ["composition-" + slug];
  return [];
}
async function sourceReceipt(job: JobStartResult, item: ExecutionItem,
  point: RecoveryInspection): Promise<string[] | null> {
  // These are independently written and sealed origin work receipts. Historical
  // read-only context cannot be inferred from the latest mutable Story tree.
  const slug = item.milestone?.slice(10);
  const read = async (path: string): Promise<Record<string, any> | null> => {
    try {
      const parsed = JSON.parse(await readFile(join(job.stateDir, path), "utf8"));
      return parsed.jobId === job.jobId ? parsed as Record<string, any> : null;
    } catch { return null; }
  };
  if (point.workItem.startsWith("event-")) {
    const entry = await read("event-items/" + point.workItem.slice(6) + ".json");
    if (!entry || entry.commitSha !== point.commitSha ||
        entry.planVersion !== item.planVersion) return null;
    const sources = recordPath(entry.assignment?.sourcePaths);
    const written = recordPath(entry.paths);
    return sources && written ? [...new Set([...sources, ...written])] : null;
  }
  if (point.workItem.startsWith("interactive-")) {
    const entry = slug ? await read("interactive-items/" + slug + ".json") : null;
    const index = point.workItem.includes("-choice-") ? 0 : 1;
    const unit = entry?.units?.[index];
    if (!entry || !unit || unit.commitSha !== point.commitSha ||
        entry.planVersion !== item.planVersion || !entry.eventHead) return null;
    const written = recordPath(unit.paths);
    const event = await read("event-items/" + slug + ".json");
    const eventSources = recordPath(event?.assignment?.sourcePaths);
    const eventPaths = recordPath(event?.paths);
    // A Choice or Puzzle consumes its reviewed Event/Milestone source. The
    // field-only Milestone correction changes the premise of BOTH consumers.
    return written && eventSources && eventPaths && event?.commitSha === entry.eventHead
      ? [...new Set([...written, ...eventSources, ...eventPaths])]
      : null;
  }
  if (point.workItem.startsWith("composition-")) {
    const entry = slug ? await read("composition-items/" + slug + ".json") : null;
    if (!entry || entry.commitSha !== point.commitSha ||
        entry.planVersion !== item.planVersion ||
        !recordPath(entry.paths)?.length) return null;
    // Current Composition receipts record written Authored Content paths, not
    // all Story sources the writer/reviewer consumed. Treating the output list
    // as an exhaustive read set would silently carry forward prose that still
    // depends on an altered upstream Event. Classify as UNKNOWN until a
    // native/pinned source-consumption receipt actually exists.
    return null;
  }
  // Unknown source instrumentation is not evidence of independence. World,
  // Character, baseline Foundation and synthetic stages are handled by their
  // ordinary verified dependencies; absent explicit read receipts are UNKNOWN.
  return null;
}

export interface AuthenticatedSelectiveImpact {
  plan: SelectiveRevalidationPlan;
  /** Original immutable checkpoints that require a fresh independent review. */
  originalPoints: Record<string, RecoveryInspection[]>;
  /** Original authenticated, *passed* reviewer proofs; no summaries invented. */
  reviewedSources: Record<string, ReviewedConsumerEvidence>;
}

/** Called by a trusted controller holding the original job's writer lease.
 * The caller must already have audited the new correction Git diff and native
 * validity; this adapter independently checks the original Turn and all
 * historical passed reviews. */
export async function authenticateSelectiveImpact(job: JobStartResult,
  inventory: GenerationInventory, correction: ReviewedUpstreamCorrection,
): Promise<AuthenticatedSelectiveImpact> {
  const turn = await readReviewTurnEvidence(job);
  if (!turn || turn.digest !== correction.turnDigest ||
      turn.source.verifiedSha !== job.baseSha)
    throw Error("Reviewed upstream correction lost its original Turn authority.");
  const checkpoints = (await inspectRecoveryCheckpoints(job)).filter(p =>
    p.eligible && p.assurance?.turnDigest === turn.digest);
  const sources: Record<string, ReviewedConsumerEvidence> = {};
  const originalPoints: Record<string, RecoveryInspection[]> = {};
  for (const item of inventory.items.filter(i => i.status === "verified")) {
    const matches = workItems(item);
    const points = checkpoints.filter(point => matches.includes(point.workItem));
    originalPoints[item.id] = points;
    const historical = ancestor(job, item.verifiedSha ?? "", correction.predecessorCommitSha);
    // A previously author-approved Foundation can be inherited without a
    // fabricated specialist commit. It predates the corrected Event and no
    // native or independent-review obligation was imposed on that baseline.
    if (historical && !points.length &&
        ["foundation", "foundations"].includes(item.stage) &&
        item.verifiedSha === job.baseSha) {
      sources[item.id] = { commitSha: item.verifiedSha,
        reviewDigest: hash({ approvedBaseline: job.baseSha }),
        status: "not-required", sourcePaths: [], sourcePrecedesUpstream: true };
      continue;
    }
    if (!matches.length || points.length !== matches.length ||
        points.some(p => p.planVersion !== correction.planVersion)) continue;
    const files: string[] = [];
    const reviews: string[] = [];
    let accepted = true;
    let unreviewedEarlier = false;
    for (const point of points) {
      const review = await inspectCheckpointReview(job, point);
      if (point.semanticReview !== "passed" || !review ||
          review.status !== "passed" || !review.result) {
        if (historical && point.semanticReview === "not-required" &&
            review?.status === "not-required") {
          unreviewedEarlier = true;
          reviews.push(hash({ noReviewRequired: point.commitSha,
            assurance: point.assurance }));
          continue;
        }
        accepted = false; break;
      }
      const precedesUpstream = ancestor(job, point.commitSha, correction.predecessorCommitSha);
      const referenced = precedesUpstream ? [] : await sourceReceipt(job, item, point);
      if (!referenced) { accepted = false; break; }
      files.push(...referenced);
      reviews.push(hash(review.result));
    }
    if (!accepted) continue;
    sources[item.id] = { commitSha: item.verifiedSha!,
      reviewDigest: hash(reviews), status: unreviewedEarlier ? "not-required" : "passed",
      ...(points.every(p => ancestor(job, p.commitSha,
        correction.predecessorCommitSha)) ? { sourcePrecedesUpstream: true } : {}),
      sourcePaths: [...new Set(files)].sort() };
  }
  const plan = planSelectiveRevalidation({ inventory, correction, reviews: sources });
  return { plan, originalPoints, reviewedSources: sources };
}
