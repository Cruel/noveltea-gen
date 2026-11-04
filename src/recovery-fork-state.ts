import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { JobStartResult } from "./job.js";
import type { RecoveryCheckpoint } from "./recovery-checkpoints.js";
import type { GenerationEvidence } from "./generation-plan.js";
import type { CompletionContract } from "./architecture.js";
import { openSkillSnapshot } from "./snapshot.js";
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
  contract: CompletionContract;
  receipts: Record<string, SpecialistReceipt>;
  commits: Record<string, { sha: string; jobId: string; planVersion: number | null }>;
  completedStages: GenerationEvidence[];
}
export const forkDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function regular(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Fork evidence must be a regular controller-owned file.");
  return readFileSync(path, "utf8");
}
export function readRecoveryFork(job: JobStartResult, requireReady = true): RecoveryForkBundle | null {
  if (!job.recoveryFork) return null;
  const bundle = JSON.parse(regular(join(job.stateDir, "recovery-fork.json"))) as RecoveryForkBundle;
  const pin = job.recoveryFork;
  if (bundle.version !== 2 || bundle.toolchain?.graphSchema !== "noveltea-generation/v1" ||
      bundle.toolchain?.runtime?.continuationSchema !== "noveltea-fork/v2" ||
      typeof bundle.toolchain?.runtime?.nodeVersion !== "string" ||
      bundle.toolchain?.validator?.implementation !== "native-cli" ||
      !/^[a-f0-9]{64}$/.test(bundle.toolchain?.validator?.sha256 ?? "") ||
      !/^[a-f0-9]{64}$/.test(bundle.toolchain?.skills?.id ?? "") ||
      bundle.childId !== job.jobId || bundle.storyRoot !== job.storyRoot ||
      bundle.sourceJobId !== pin.sourceJobId || bundle.sourceBaseSha !== pin.sourceBaseSha ||
      bundle.checkpoint.commitSha !== job.baseSha || pin.commitSha !== job.baseSha ||
      forkDigest(bundle) !== pin.bundleSha256 ||
      (requireReady && regular(join(job.stateDir, "recovery-fork-ready")).trim() !== pin.bundleSha256)) {
    throw new Error("Fork continuation is incomplete or differs from its immutable job pin.");
  }
  return bundle;
}

/** A prepared fork cannot start under altered pins, obsolete graph state or
 * a disappearing skill snapshot. No source parent resources are modified. */
export async function verifyReadyRecoveryFork(job: JobStartResult): Promise<void> {
  if (!job.recoveryFork) return;
  let bundle: RecoveryForkBundle;
  try {
    bundle = readRecoveryFork(job)!;
    const file = join(job.stateDir, "validator.json");
    const pin = JSON.parse(regular(file)) as RecoveryToolchain["validator"];
    if (bundle.toolchain.runtime.nodeVersion !== process.version ||
        job.validatorSha256 !== bundle.toolchain.validator.sha256 ||
        pin.sha256 !== bundle.toolchain.validator.sha256 ||
        pin.executable !== bundle.toolchain.validator.executable ||
        pin.contract !== bundle.toolchain.validator.contract ||
        createHash("sha256").update(readFileSync(pin.executable)).digest("hex") !== pin.sha256 ||
        await openSkillSnapshot(bundle.toolchain.skills.id) !== bundle.toolchain.skills.path)
      throw new Error("pinned tool identities changed");
  } catch {
    throw new RecoveryCompatibilityError("changed-tooling",
      "The prepared Thread's validator, skills, or continuation bundle are missing or changed.");
  }
}
/** Only original inherited commits can use their source identity. New commits
 * must always use this job's own trailers and its own author permissions. */
export function commitOrigin(job: JobStartResult, workItem: string, sha: string) {
  const entry = readRecoveryFork(job)?.commits[workItem];
  return entry?.sha === sha ? entry : { jobId: job.jobId, sha, planVersion: null };
}
export function forkSourceSummary(job: JobStartResult) {
  const fork = readRecoveryFork(job);
  return fork ? { jobId: fork.sourceJobId, commitSha: fork.checkpoint.commitSha,
    completedWorkItems: fork.checkpoint.completedWorkItems,
    remainingWorkItems: fork.checkpoint.remainingWorkItems, nextWorkItem: fork.checkpoint.nextWorkItem,
    dependencies: Object.fromEntries(fork.checkpoint.remainingWorkItems.map(id =>
      [id, fork.checkpoint.dependencies[id] ?? []])) } : null;
}
