import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { JobStartResult } from "./job.js";
import type { RecoveryCheckpoint } from "./recovery-checkpoints.js";
import type { SemanticReviewStatus } from "./checkpoint-assurance.js";
import type { GenerationEvidence } from "./generation-plan.js";
import type { CompletionContract } from "./architecture.js";
import type { TurnEvidence } from "./turn-plan-evidence.js";
import type { ReviewedOmissionBatch } from "./recovery-review-batch.js";
import type { InheritedMilestoneBlueprint } from "./milestone-blueprint.js";
import { openSkillSnapshot } from "./snapshot.js";
import { assertNativeVersion } from "./native-cli-version.js";
import { RecoveryCompatibilityError, type RecoveryToolchain } from "./recovery-compatibility.js";

// Heterogeneous specialist receipts are retained as evidence, not executable
// sessions or approval grants. Their existing stage adapters remain authoritative.
export type SpecialistReceipt = Record<string, any>;
export interface RecoveryForkBundle {
  version: 2;
  toolchain: RecoveryToolchain;
  sourceJobId: string;
  sourceBaseSha: string;
  storyRoot: string;
  childId: string;
  checkpoint: RecoveryCheckpoint;
  /** Status pinned at fork admission; later parent reviews cannot silently
   * authorize writes in this independently versioned child Thread. */
  reviewCoverage?: Array<{ workItem: string; commitSha: string; status: SemanticReviewStatus }>;
  contract: CompletionContract;
  /** Original controller-verified author Turn, REVIEW-ONLY. It is never
   * copied into child turn-plan.json and grants no new authoring authority. */
  reviewTurn?: TurnEvidence;
  receipts: Record<string, SpecialistReceipt>;
  commits: Record<string, { sha: string; jobId: string; planVersion: number | null; proof?: RecoveryCheckpoint }>;
  completedStages: GenerationEvidence[];
  /** Source-verified, same-Thread no-write decisions; no Git commits or author grants. */
  reviewBatch?: ReviewedOmissionBatch;
  /** Authenticated historical Event plans only; no live reviewer sessions or grants. */
  milestoneBlueprints?: InheritedMilestoneBlueprint[];
}
export const forkDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function regular(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Fork evidence must be a regular controller-owned file.");
  return readFileSync(path, "utf8");
}
/** Review repairs have immutable, independently verified commits, but are not
 * normal plan work items. A repair may be inherited only when it points to a
 * recorded failed review rooted in a completed specialist, however many
 * productive independently reviewed revisions were needed. The entire
 * coverage ledger remains bound by the immutable bundle digest. */
export function validRecoveryReviewCoverage(
  coverage: RecoveryForkBundle["reviewCoverage"],
  completed: string[],
  required?: { commitSha: string; workItem: string },
): boolean {
  if (coverage === undefined) return required === undefined;
  if (!Array.isArray(coverage)) return false;
  const byCommit = new Map(coverage.map(item => [item.commitSha, item]));
  if (byCommit.size !== coverage.length ||
      coverage.some(item => !/^[a-f0-9]{40}$/.test(item.commitSha) ||
        !["not-required", "required-pending", "passed", "failed"].includes(item.status)))
    return false;
  const completedSet = new Set(completed);
  for (const item of coverage) {
    let cursor = item;
    const seen = new Set<string>();
    while (!completedSet.has(cursor.workItem)) {
      const sourceSha = /^repair-([a-f0-9]{40})$/.exec(cursor.workItem)?.[1];
      if (!sourceSha || seen.has(sourceSha)) return false;
      seen.add(sourceSha);
      const source = byCommit.get(sourceSha);
      if (!source || source.status !== "failed") return false;
      cursor = source;
    }
  }
  return !required || coverage.some(item =>
    item.commitSha === required.commitSha && item.workItem === required.workItem);
}
/** Compute dependency-gate status from immutable inherited verdicts. Only a
 * passing, proof-bound repair whose source was a recorded failure can
 * supersede that source; callers retain the original verdict ledger intact. */
export function resolvedInheritedRecoveryReviews(
  coverage: NonNullable<RecoveryForkBundle["reviewCoverage"]>,
): NonNullable<RecoveryForkBundle["reviewCoverage"]> {
  const byCommit = new Map(coverage.map(entry => [entry.commitSha, entry]));
  const covered = new Set<string>();
  for (const entry of coverage) {
    if (entry.status !== "passed" || !entry.workItem.startsWith("repair-")) continue;
    let current = entry;
    const sources: string[] = [];
    const seen = new Set<string>();
    while (true) {
      const sourceSha = /^repair-([a-f0-9]{40})$/.exec(current.workItem)?.[1];
      if (!sourceSha) break;
      if (seen.has(sourceSha)) break;
      seen.add(sourceSha);
      const source = byCommit.get(sourceSha);
      if (!source || source.status !== "failed") break;
      sources.push(source.commitSha);
      current = source;
    }
    if (!current.workItem.startsWith("repair-")) sources.forEach(sha => covered.add(sha));
  }
  return coverage.map(entry => covered.has(entry.commitSha)
    ? { ...entry, status: "not-required" as const } : entry);
}
export function readRecoveryFork(job: JobStartResult, requireReady = true): RecoveryForkBundle | null {
  if (!job.recoveryFork) return null;
  const bundle = JSON.parse(regular(join(job.stateDir, "recovery-fork.json"))) as RecoveryForkBundle;
  const pin = job.recoveryFork;
  if (bundle.version !== 2 || bundle.toolchain?.graphSchema !== "noveltea-generation/v1" ||
      bundle.toolchain?.runtime?.continuationSchema !== "noveltea-fork/v2" ||
      typeof bundle.toolchain?.runtime?.nodeVersion !== "string" ||
      bundle.toolchain?.validator?.implementation !== "native-cli" ||
      !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(bundle.toolchain?.validator?.version ?? "") ||
      !/^[a-f0-9]{64}$/.test(bundle.toolchain?.skills?.id ?? "") ||
      bundle.childId !== job.jobId || bundle.storyRoot !== job.storyRoot ||
      bundle.sourceJobId !== pin.sourceJobId || bundle.sourceBaseSha !== pin.sourceBaseSha ||
      bundle.checkpoint.commitSha !== job.baseSha || pin.commitSha !== job.baseSha ||
      forkDigest(bundle) !== pin.bundleSha256 ||
      (bundle.reviewBatch !== undefined && (
        bundle.reviewBatch.version !== 1 ||
        bundle.reviewBatch.sourceJobId !== bundle.sourceJobId ||
        bundle.reviewBatch.sourceHead !== bundle.checkpoint.commitSha ||
        bundle.reviewBatch.planDigest !== bundle.checkpoint.planDigest ||
        !Array.isArray(bundle.reviewBatch.entries) ||
        !bundle.reviewBatch.entries.length || bundle.reviewBatch.entries.length > 64 ||
        new Set(bundle.reviewBatch.entries.map(entry => entry.milestoneId)).size !==
          bundle.reviewBatch.entries.length)) ||
      !validRecoveryReviewCoverage(bundle.reviewCoverage, bundle.checkpoint.completedWorkItems,
        bundle.checkpoint.assurance ? { commitSha: bundle.checkpoint.commitSha,
          workItem: bundle.checkpoint.workItem } : undefined) ||
      (requireReady && regular(join(job.stateDir, "recovery-fork-ready")).trim() !== pin.bundleSha256)) {
    throw new Error("Fork continuation is incomplete or differs from its immutable job pin.");
  }
  return bundle;
}

/** Read-only native/Review evidence sealed by fork admission. Never publishes
 * a local checkpoint or authorizes replay of an inherited writer. */
export function inheritedReviewedCheckpoint(job: JobStartResult, workItem: string, sha: string) {
  const fork = readRecoveryFork(job);
  const entry = fork?.commits[workItem];
  const proof = entry?.proof;
  const coverage = resolvedInheritedRecoveryReviews(fork?.reviewCoverage ?? []);
  const review = coverage.find(r => r.workItem === workItem && r.commitSha === sha);
  if (!fork?.checkpoint.completedWorkItems.includes(workItem) || entry?.sha !== sha ||
      !proof || proof.commitSha !== sha || proof.workItem !== workItem ||
      proof.jobId !== entry.jobId || proof.planVersion !== entry.planVersion ||
      proof.validation.status !== "passed" || !proof.assurance ||
      proof.assurance.commitSha !== sha || proof.assurance.jobId !== entry.jobId ||
      !review || !["passed", "not-required"].includes(review.status)) return null;
  return { proof, status: review.status, reviewDigest: forkDigest({ proof, review }) };
}

/** A prepared fork cannot start under altered pins, obsolete graph state or
 * a disappearing skill snapshot. No source parent resources are modified. */
export async function verifyReadyRecoveryFork(job: JobStartResult): Promise<void> {
  if (!job.recoveryFork) return;
  let bundle: RecoveryForkBundle;
  try {
    bundle = readRecoveryFork(job)!;
  } catch {
    throw new RecoveryCompatibilityError("invalid-evidence",
      "The prepared continuation bundle is missing or differs from its immutable recovery proof.");
  }
  try {
    assertNativeVersion(job.validatorVersion);
  } catch {
    throw new RecoveryCompatibilityError("changed-tooling",
      "The installed native validator differs from the version pinned for this continuation.");
  }
  if (bundle.toolchain.runtime.nodeVersion !== process.version)
    throw new RecoveryCompatibilityError("changed-tooling",
      "The Node.js runtime version differs from the version used to prepare this continuation.");
  if (job.validatorVersion !== bundle.toolchain.validator.version ||
      bundle.toolchain.validator.contract !== "noveltea-validator/v1")
    throw new RecoveryCompatibilityError("invalid-evidence",
      "The continuation validator pin differs from the immutable recovery bundle.");
  let snapshotPath: string;
  try {
    snapshotPath = await openSkillSnapshot(bundle.toolchain.skills.id);
  } catch {
    throw new RecoveryCompatibilityError("missing-tooling",
      "The pinned NovelTea skills snapshot is missing or could not be verified.");
  }
  if (snapshotPath !== bundle.toolchain.skills.path)
    throw new RecoveryCompatibilityError("changed-tooling",
      "The web and agent services use different skills-snapshot cache directories. Correct the deployment configuration before retrying.");
}
/** Only original inherited commits can use their source identity. New commits
 * must always use this job's own trailers and its own author permissions. */
export function commitOrigin(job: JobStartResult, workItem: string, sha: string) {
  const entry = readRecoveryFork(job)?.commits[workItem];
  return entry?.sha === sha ? entry : { jobId: job.jobId, sha, planVersion: null };
}
export function forkSourceSummary(job: JobStartResult) {
  const fork = readRecoveryFork(job);
  if (!fork) return null;
  const omitted = new Set(fork.reviewBatch?.entries.flatMap(entry => {
    const slug = entry.milestoneId.slice(10);
    return ["interactive-choice-" + slug, "interactive-puzzle-" + slug];
  }) ?? []);
  const completed = new Set([...fork.checkpoint.completedWorkItems, ...omitted]);
  // An author-supplied Foundation is an accepted prerequisite of an already
  // verified Architecture, even when it has no generator-owned Git commit.
  if (completed.has("global-architecture")) completed.add("foundation");
  const remainingWorkItems = fork.checkpoint.remainingWorkItems.filter(id => !completed.has(id));
  const nextWorkItem = remainingWorkItems.find(id =>
    (fork.checkpoint.dependencies[id] ?? []).every(dep => completed.has(dep))) ?? null;
  return { jobId: fork.sourceJobId, commitSha: fork.checkpoint.commitSha,
    completedWorkItems: fork.checkpoint.completedWorkItems, remainingWorkItems, nextWorkItem,
    dependencies: Object.fromEntries(remainingWorkItems.map(id =>
      [id, fork.checkpoint.dependencies[id] ?? []])) };
}
