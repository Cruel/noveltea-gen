/** Authenticate independent Event-only omission reviews for the one production
 * adaptive controller. Never infer an omission from a specialist's no-write
 * prose, native record counts, or an unreviewed model proposal.
 *
 * The regular interactive receipt is the authority consumed by Composition
 * and recovery. An adaptive amendment only *references* that receipt.
 */
import { existsSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobStartResult } from "./job.js";
import type { GenerationInventory } from "./generation-plan.js";
import type { GenerationRequest } from "./generation.js";
import { readEventOnlyOmission, type EventOnlyRef } from "./interactive-event-only.js";
import { runInteractiveWorkItem } from "./interactive-work.js";
import { preservesWholeStoryInteraction, type AdaptiveOmissionProof } from "./adaptive-assignments.js";
import type { StoryPlanning } from "./story-planning.js";

const MILESTONE = /^milestone\.[a-z][a-z0-9-]*$/;
const HASH = /^[0-9a-f]{64}$/;
type RecordItem = { path: string; metadata: { id: string; type: string; status: string;
  events?: string[]; solutions?: string[] } };

interface InteractiveOmissionReceipt {
  jobId: string; milestoneId: string; eventHead: string; planVersion: number;
  planDigest: string; worker: "pi" | "fixture"; eventSource?: { eventIds: string[] };
  units: Array<{ phase: string; beforeHead?: string; commitSha?: string;
    paths?: string[]; claimedPaths?: string[]; eventOnly?: EventOnlyRef }>;
}

async function authenticate(job: JobStartResult, milestone: string, planVersion: number,
  planDigest: string, records: RecordItem[], sourceHashes: Record<string, string>): Promise<AdaptiveOmissionProof> {
  if (!MILESTONE.test(milestone)) throw Error("Unsafe adaptive omission assignment identity.");
  const path = join(job.stateDir, "interactive-items", milestone.slice("milestone.".length) + ".json");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024)
    throw Error("Adaptive omission interactive receipt is unsafe.");
  const receipt = JSON.parse(await readFile(path, "utf8")) as InteractiveOmissionReceipt;
  const [choice, puzzle] = receipt.units ?? [];
  if (receipt.jobId !== job.jobId || receipt.milestoneId !== milestone ||
      receipt.planVersion !== planVersion || receipt.planDigest !== planDigest ||
      receipt.worker !== "pi" ||
      !choice?.eventOnly || !puzzle?.eventOnly ||
      JSON.stringify(choice.eventOnly) !== JSON.stringify(puzzle.eventOnly) ||
      choice.phase !== "not-applicable" || puzzle.phase !== "not-applicable" ||
      choice.beforeHead !== puzzle.beforeHead ||
      [choice, puzzle].some(unit => unit.commitSha || unit.paths?.length || unit.claimedPaths?.length))
    throw Error("Adaptive omission needs both original, commitless interactive dispositions.");
  // This authenticates the original reviewer transcript, pinned skills, Turn,
  // Git ancestry, and every relevant canonical source byte at current HEAD.
  const reviewed = await readEventOnlyOmission(job, milestone, choice.eventOnly);
  if (reviewed.reviewMode !== "pi" || !reviewed.reviewerSession ||
      !reviewed.reviewerSnapshotId || !HASH.test(reviewed.reviewerSnapshotId) ||
      reviewed.reviewHead !== choice.beforeHead ||
      reviewed.planVersion !== planVersion || reviewed.eventHead !== receipt.eventHead ||
      reviewed.planDigest !== receipt.planDigest ||
      JSON.stringify(reviewed.eventIds) !== JSON.stringify(receipt.eventSource?.eventIds))
    throw Error("Adaptive omission lost independently verified Event-only reviewer provenance.");
  // A newly linked Choice/Puzzle is relevant drift even if every originally
  // hashed source file is unchanged; unrelated verified work is not.
  const newLocalMechanic = records.find(r => r.metadata.status !== "superseded" &&
    (r.metadata.type === "choice-point" && r.metadata.events?.some(id => reviewed.eventIds.includes(id)) ||
      r.metadata.type === "puzzle" && r.metadata.solutions?.some(id => reviewed.eventIds.includes(id))) &&
    !Object.hasOwn(reviewed.sourceHashes, r.path));
  if (newLocalMechanic)
    throw Error("Reviewed Event-only omission has a newly linked Choice/Puzzle source requiring bounded reassessment: " +
      newLocalMechanic.path);
  const record = records.find(r => r.metadata.type === "milestone" &&
    r.metadata.status !== "superseded" && r.metadata.id === milestone);
  if (!record || !HASH.test(sourceHashes[record.path] ?? "") ||
      reviewed.sourceHashes[record.path] !== sourceHashes[record.path])
    throw Error("Adaptive omission Milestone source changed or is no longer canonical.");
  const evidence = reviewed.evidence.find(line => line.includes(record.path + ":"));
  if (!evidence || evidence.length > 2000)
    throw Error("Adaptive omission reviewer did not cite an actual Milestone source line.");
  return {
    assignmentId: "interactive:" + milestone, sourceSha: reviewed.reviewHead,
    path: record.path, sourceHash: sourceHashes[record.path]!, evidence,
    reviewerSession: reviewed.reviewerSession,
    reviewerSnapshot: reviewed.reviewerSnapshotId,
    eventOnly: choice.eventOnly,
  };
}

/** Reopen all historical receipts before any dispatch. At new live safe
 * boundaries, run only the independent omission preflight; if it declines,
 * leave the original Choice/Puzzle specialist step untouched. */
export async function reviewedAdaptiveOmissions(input: {
  job: JobStartResult; request: GenerationRequest; inventory: GenerationInventory;
  records: RecordItem[]; sourceHashes: Record<string, string>;
  saved: AdaptiveOmissionProof[]; allowReview: boolean | "restore-candidates"; authorTargets: string[];
  planning: StoryPlanning; protectedPaths: string[]; planDigest: string;
}): Promise<AdaptiveOmissionProof[]> {
  const { job, request, inventory, records, sourceHashes, saved } = input;
  if (!inventory.planVersion) return [];
  const proofs: AdaptiveOmissionProof[] = [];
  const originals = new Map<string, AdaptiveOmissionProof>();
  for (const prior of saved) {
    if (originals.has(prior.assignmentId) && JSON.stringify(originals.get(prior.assignmentId)) !== JSON.stringify(prior))
      throw Error("Adaptive omission history has conflicting independent reviewer receipts.");
    originals.set(prior.assignmentId, prior);
  }
  for (const [id, original] of originals) {
    const milestone = id.startsWith("interactive:") ? id.slice("interactive:".length) : "";
    const authenticated = await authenticate(job, milestone, inventory.planVersion,
      input.planDigest, records, sourceHashes);
    if (!original.eventOnly || JSON.stringify(authenticated) !== JSON.stringify(original))
      throw Error("Previously admitted adaptive omission differs from its independently sealed source.");
    proofs.push(authenticated);
  }
  if (!input.allowReview) return proofs;
  for (const item of inventory.items) {
    if (item.stage !== "interactive" || item.status !== "pending" || !item.milestone ||
        originals.has(item.id) || !item.dependencies.every(dep =>
          inventory.items.some(parent => parent.id === dep && parent.status === "verified")) ||
        input.authorTargets.includes(item.milestone) ||
        input.authorTargets.some(target => target.startsWith("choice-point.") ||
          target.startsWith("puzzle.")) ||
        !preservesWholeStoryInteraction(inventory.items, item, input.planning)) continue;
    const milestone = records.find(record => record.metadata.id === item.milestone &&
      record.metadata.type === "milestone" && record.metadata.status !== "superseded");
    if (!milestone || input.protectedPaths.includes(milestone.path)) continue;
    // An earlier review-only preflight may have sealed a genuine omission
    // before the planner checkpointed it. Recover that exact proof, never
    // rerun its reviewer. Ordinary saved Choice/Puzzle work is not optional.
    const file = join(job.stateDir, "interactive-items", item.milestone.slice("milestone.".length) + ".json");
    if (existsSync(file)) {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024)
        throw Error("Unsafe saved interactive work while checking adaptive omission.");
      const receipt = JSON.parse(await readFile(file, "utf8")) as InteractiveOmissionReceipt;
      if (receipt.units?.[0]?.eventOnly || receipt.units?.[1]?.eventOnly)
        proofs.push(await authenticate(job, item.milestone, inventory.planVersion,
          input.planDigest, records, sourceHashes));
      continue;
    }
    if (input.allowReview === "restore-candidates") continue;
    const reviewed = await runInteractiveWorkItem({
      story: job.storyRoot, job: job.jobId, action: "review-omission",
      milestone: item.milestone, fixture: false,
      skillsSource: request.skillsSource, validatorSource: request.validatorSource,
      provider: request.provider, model: request.model,
    });
    if (reviewed.status === "omission-not-justified") continue;
    if (reviewed.status !== "interactive-slice-committed")
      throw Error("Adaptive omission preflight did not settle into a reviewed no-write receipt.");
    proofs.push(await authenticate(job, item.milestone, inventory.planVersion,
      input.planDigest, records, sourceHashes));
  }
  return proofs;
}
