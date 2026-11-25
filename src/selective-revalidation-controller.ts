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
import { inheritedReviewedCheckpoint, readRecoveryFork } from "./recovery-fork-state.js";
import { inspectCheckpointReview } from "./checkpoint-assurance.js";
import { readHistoricalEventOnlyOmission, type EventOnlyPayload } from "./interactive-event-only.js";
import { readReviewTurnEvidence } from "./fork-review-turn.js";
import { verifyPlanHistory } from "./architecture.js";
import { isFocusedScope } from "./focused-scope.js";
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
  if (item.stage === "focus" && item.milestone && item.id === "focus:" + item.milestone)
    return [item.id];
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
  const fork = readRecoveryFork(job);
  const read = async (path: string, inherited = point.jobId !== job.jobId): Promise<Record<string, any> | null> => {
    if (inherited) return fork?.receipts[path] ?? null;
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
    const event = await read("event-items/" + slug + ".json",
      fork?.commits["event-" + slug]?.sha === entry.eventHead);
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
  originalOmissions: Record<string, EventOnlyPayload>;
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
  const checkpoints = (await inspectRecoveryCheckpoints(job, "historical")).filter(p =>
    p.eligible && p.assurance?.turnDigest === turn.digest);
  const inheritedProofs = Object.entries(readRecoveryFork(job)?.commits ?? {}).flatMap(([id, entry]) => {
    const inherited = inheritedReviewedCheckpoint(job, id, entry.sha);
    return inherited && !checkpoints.some(p => p.workItem === id)
      ? [inherited] : [];
  });
  // These are original read-only proofs in the sealed fork bundle, not local
  // checkpoint publications or a continuation grant to the old writer.
  checkpoints.push(...inheritedProofs.map(entry => ({
    ...entry.proof, eligible: true, reason: null,
    semanticReview: entry.status,
  } as RecoveryInspection)));
  const sources: Record<string, ReviewedConsumerEvidence> = {};
  const originalPoints: Record<string, RecoveryInspection[]> = {};
  const originalOmissions: Record<string, EventOnlyPayload> = {};
  for (const item of inventory.items.filter(i => i.status === "verified")) {
    // The writer-support controller may cite the independently reviewed
    // World checkpoint while Character is still suspended. Only that exact
    // historical subunit is a completed source, not the composite assignment.
    const partialWorld = item.stage === "foundations" && item.id === correction.upstreamItemId &&
      item.verifiedSha === correction.predecessorCommitSha &&
      checkpoints.some(p => p.workItem === "world-foundations" && p.commitSha === item.verifiedSha && p.semanticReview === "passed") &&
      !checkpoints.some(p => p.workItem === "character-foundations" && ancestor(job, p.commitSha, correction.baseSha));
    const matches = partialWorld ? ["world-foundations"] : workItems(item);
    let points = checkpoints.filter(point => matches.includes(point.workItem));
    // A repaired upstream Event is still the same inventory assignment.
    // Authenticate its exact passing successor; never promote the failed
    // original Review or infer a replacement from the current worktree.
    if (item.id === correction.upstreamItemId && item.stage === "event" &&
        points.length === 1 && points[0]!.semanticReview === "failed" &&
        item.verifiedSha === correction.predecessorCommitSha) {
      const original = points[0]!;
      const successor = checkpoints.find(p => p.commitSha === item.verifiedSha &&
        p.planVersion === item.planVersion && p.semanticReview === "passed" &&
        p.workItem.startsWith("repair-"));
      const { verifyReviewCycleSuccessor } = await import("./generation-recovery-resolution.js");
      if (successor && await verifyReviewCycleSuccessor(job, original.commitSha, successor.commitSha))
        points = [successor];
    }
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
    // A focused revision adopts verified Architecture without writing a new
    // commit. Its persisted plan receipt, not an invented reviewer, proves
    // that this baseline predates the corrected owner.
    if (historical && !points.length && item.stage === "architecture" &&
        item.verifiedSha === job.baseSha && isFocusedScope(turn.contract)) {
      const receipt = JSON.parse(await readFile(join(job.stateDir, "architecture.json"), "utf8"));
      verifyPlanHistory(job, receipt);
      if (receipt.jobId !== job.jobId || receipt.threadId !== job.threadId ||
          receipt.baseSha !== job.baseSha || receipt.phase !== "committed" ||
          receipt.expectedHead !== job.baseSha || receipt.paths?.length ||
          receipt.plan?.version !== correction.planVersion ||
          JSON.stringify(receipt.plan.contract) !== JSON.stringify(turn.contract) ||
          receipt.plan.items[0]?.verifiedSha !== job.baseSha)
        throw Error("Focused Architecture baseline lost its verified plan receipt.");
      sources[item.id] = { commitSha: item.verifiedSha,
        reviewDigest: hash({ focusedArchitecture: receipt.plan }),
        status: "not-required", sourcePaths: [], sourcePrecedesUpstream: true };
      continue;
    }
    // A reviewed Event-only omission owns no Git write. Authenticate the
    // original two commitless units and the original source hashes instead of
    // treating the missing specialist checkpoint as a missing writer.
    if (item.stage === "interactive" && item.milestone && !points.length) {
      const receipt = JSON.parse(await readFile(join(job.stateDir, "interactive-items",
        item.milestone.slice(10) + ".json"), "utf8"));
      const [choice, puzzle] = receipt.units ?? [];
      if (choice?.phase === "not-applicable" && puzzle?.phase === "not-applicable" &&
          choice.eventOnly && JSON.stringify(choice.eventOnly) === JSON.stringify(puzzle.eventOnly) &&
          choice.beforeHead === puzzle.beforeHead && !choice.commitSha && !puzzle.commitSha &&
          !choice.paths?.length && !puzzle.paths?.length &&
          !choice.claimedPaths?.length && !puzzle.claimedPaths?.length &&
          receipt.jobId === job.jobId && receipt.worker === "pi" &&
          receipt.planVersion === item.planVersion) {
        const proof = await readHistoricalEventOnlyOmission(job, item.milestone, choice.eventOnly);
        if (proof.reviewMode !== "pi" || proof.reviewHead !== choice.beforeHead ||
            proof.reviewHead !== item.verifiedSha || proof.turnDigest !== turn.digest ||
            proof.planVersion !== item.planVersion || proof.planDigest !== receipt.planDigest ||
            proof.eventHead !== receipt.eventHead)
          throw Error("Commitless dependent has no authenticated original review.");
        originalOmissions[item.id] = proof;
        sources[item.id] = { commitSha: proof.reviewHead, reviewDigest: choice.eventOnly.digest,
          status: "passed", sourcePaths: Object.keys(proof.sourceHashes).sort() };
        continue;
      }
    }
    // Foundation precedes creation of the work plan. Its exact Turn-bound
    // finalized native/Review checkpoint may legitimately have no version.
    // Never treat an unbound or later Foundation as historical evidence.
    const prePlanFoundation = item.stage === "foundation" && historical &&
      points.length === 1 && points[0]!.planVersion === null &&
      points[0]!.commitSha === item.verifiedSha &&
      points[0]!.validation.status === "passed" &&
      points[0]!.assurance?.turnDigest === turn.digest;
    if (!matches.length || points.length !== matches.length ||
        (!prePlanFoundation && points.some(p => p.planVersion !== correction.planVersion))) continue;
    const files: string[] = [];
    const reviews: string[] = [];
    let accepted = true;
    let unreviewedEarlier = false;
    for (const point of points) {
      const inherited = inheritedProofs.find(entry => entry.proof.commitSha === point.commitSha);
      if (inherited) {
        const precedes = ancestor(job, point.commitSha, correction.predecessorCommitSha);
        const referenced = precedes ? [] : await sourceReceipt(job, item, point);
        if (!referenced || inherited.status !== "passed" && !precedes) {
          accepted = false; break;
        }
        files.push(...referenced);
        reviews.push(inherited.reviewDigest);
        continue;
      }
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
  return { plan, originalPoints, reviewedSources: sources, originalOmissions };
}
