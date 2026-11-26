/** Logical, commitless recovery boundary for independently sealed Event-only
 * reviews. Nothing here authorizes new Story edits, and every source receipt
 * is reauthenticated before handoff. The bundle's hash is pinned to the
 * child's recovery identity; the original review provenance is not rewritten.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JobStartResult } from "./job.js";
import type { RecoveryCheckpoint } from "./recovery-checkpoints.js";
import type { GenerationInventory } from "./generation-plan.js";
import { readEventOnlyOmission, reviewedOmissionSuccessor, type OmissionRevalidation, type EventOnlyPayload, type EventOnlyRef } from "./interactive-event-only.js";
import { readReviewTurnEvidence } from "./fork-review-turn.js";

const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const SLUG = /^[a-z][a-z0-9-]*$/;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export interface ReviewedOmissionHandoff {
  milestoneId: string;
  sourceSeal: EventOnlyRef;
  sourcePayload: EventOnlyPayload;
  revalidatedSource?: OmissionRevalidation;
  /** Only the two original no-write specialist dispositions, never sessions or grants. */
  sourceReceipt: Record<string, any>;
}
export interface ReviewedOmissionBatch {
  version: 1;
  sourceJobId: string;
  sourceHead: string;
  planDigest: string;
  turnDigest: string;
  entries: ReviewedOmissionHandoff[];
}
const batchDir = (job: JobStartResult) => join(job.stateDir, "recovery-review-batches");
const sourcePath = (job: JobStartResult, slug: string) =>
  join(job.stateDir, "interactive-items", slug + ".json");

function git(job: JobStartResult, ...args: string[]) {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[key];
  return execFileSync("git", args, { cwd: job.worktreeRoot, env,
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
}
function isAncestor(job: JobStartResult, older: string, newer: string): boolean {
  try { git(job, "merge-base", "--is-ancestor", older, newer); return true; }
  catch (error) {
    if ((error as { status?: number }).status === 1) return false;
    throw Error("Cannot verify reviewed omission Git ancestry.");
  }
}

/** Read-only and safe even after a later writer left unrelated uncommitted
 * files. The source reviews must be ancestors of the selected Git HEAD,
 * with their canonical source bytes still identical at that checkpoint.
 * This also supports older preserved executions without a batch marker. */
export async function collectReviewedOmissionBatch(job: JobStartResult,
  checkpoint: RecoveryCheckpoint): Promise<ReviewedOmissionBatch | null> {
  const dir = join(job.stateDir, "interactive-event-only");
  if (!existsSync(dir)) return null;
  const names = (await readdir(dir)).sort();
  if (names.length > 64 || !SHA.test(checkpoint.commitSha) || !HASH.test(checkpoint.planDigest ?? ""))
    throw Error("Unbounded or incompatible reviewed omission batch.");
  const entries: ReviewedOmissionHandoff[] = [];
  for (const filename of names) {
    if (!filename.endsWith(".json")) continue;
    const slug = filename.slice(0, -5);
    if (!SLUG.test(slug)) throw Error("Unsafe reviewed omission identity.");
    const milestoneId = "milestone." + slug;
    const candidate = JSON.parse(await readFile(join(dir, filename), "utf8")) as {
      phase?: string; eventHead?: string; payload?: EventOnlyPayload;
      nonce?: string; digest?: string;
    };
    if (candidate.phase === "reviewing") {
      if (!SHA.test(candidate.eventHead ?? ""))
        throw Error("Incomplete Event-only review has no authentic source.");
      if (isAncestor(job, candidate.eventHead!, checkpoint.commitSha))
        throw Error("Interrupted independent Event-only review must be reconciled, never replayed.");
      continue;
    }
    if (candidate.phase === "declined") continue;
    if (candidate.phase !== "sealed" || !SHA.test(candidate.payload?.reviewHead ?? ""))
      throw Error("Event-only review receipt has an unrecognized or incomplete disposition.");
    const reviewHead = candidate.payload!.reviewHead;
    if (!isAncestor(job, reviewHead, checkpoint.commitSha)) continue;
    const ref = { nonce: candidate.nonce!, digest: candidate.digest! };
    const payload = await readEventOnlyOmission(job, milestoneId, ref);
    if (payload.reviewMode !== "pi" && payload.reviewMode !== "fixture" ||
        payload.planDigest !== checkpoint.planDigest ||
        payload.planVersion !== checkpoint.planVersion ||
        payload.validatorVersion !== checkpoint.validation.validatorVersion)
      throw Error("Review batch is inconsistent with the selected verified checkpoint.");
    const path = sourcePath(job, slug);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024)
      throw Error("Review batch has an unsafe interactive receipt.");
    const receipt = JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
    const [choice, puzzle] = receipt.units ?? [];
    if (receipt.jobId !== job.jobId || receipt.milestoneId !== milestoneId ||
        receipt.eventHead !== payload.eventHead || receipt.planVersion !== payload.planVersion ||
        receipt.planDigest !== payload.planDigest || receipt.worker !== payload.reviewMode ||
        choice?.phase !== "not-applicable" || puzzle?.phase !== "not-applicable" ||
        !choice?.eventOnly || JSON.stringify(choice.eventOnly) !== JSON.stringify(ref) ||
        JSON.stringify(puzzle?.eventOnly) !== JSON.stringify(ref) ||
        choice.beforeHead !== payload.reviewHead || puzzle.beforeHead !== payload.reviewHead ||
        [choice, puzzle].some(unit => unit.commitSha || unit.paths?.length || unit.claimedPaths?.length))
      throw Error("Review batch contains an unverified or partial no-write disposition.");
    const event = JSON.parse(await readFile(join(job.stateDir, "event-items", slug + ".json"),
      "utf8")) as { jobId: string; commitSha: string; snapshot?: { id: string };
        validation?: { eventIds: string[] } };
    if (event.jobId !== job.jobId || event.commitSha !== payload.eventHead ||
        event.snapshot?.id !== payload.eventSnapshotId ||
        JSON.stringify(event.validation?.eventIds) !== JSON.stringify(payload.eventIds))
      throw Error("Review batch Event source identity was changed.");
    // Read from the selected Git TREE, not from an interrupted writer's
    // worktree, to ensure that the child actually receives the reviewed bytes.
    const changed = Object.entries(payload.sourceHashes).some(([relative,expected])=>
      sha(git(job,"show",checkpoint.commitSha+":"+(job.storyRelativePath?job.storyRelativePath+"/":"")+relative))!==expected);
    const revalidatedSource = changed ? await reviewedOmissionSuccessor(job,payload,ref.digest,checkpoint.commitSha) : null;
    if (changed && !revalidatedSource)
      throw Error("Review batch source differs from the selected committed Story without a transferable revalidation.");
    entries.push({ milestoneId, sourceSeal: ref, sourcePayload: payload,
      ...(revalidatedSource?{revalidatedSource}:{}),sourceReceipt: receipt });
  }
  if (!entries.length) return null;
  const turn = await readReviewTurnEvidence(job);
  // Each entry was independently authenticated above against its own
  // originating Turn (including inherited seals). The batch is attributed
  // to the collecting execution, not a replacement approval of those entries.
  if (!turn)
    throw Error("Review batch lacks the original authenticated Turn.");
  return { version: 1, sourceJobId: job.jobId, sourceHead: checkpoint.commitSha,
    planDigest: checkpoint.planDigest!, turnDigest: turn.digest, entries };
}

/** A single lightweight boundary at a safe transition to Composition. Each
 * marker is immutable and refers to existing individually sealed decisions. */
export async function sealReviewedOmissionBatch(job: JobStartResult,
  checkpoint: RecoveryCheckpoint, inventory: GenerationInventory): Promise<void> {
  const reviewed = inventory.items.filter(item => item.stage === "interactive" &&
    item.status === "verified" && item.omission && item.milestone);
  if (!reviewed.length) return;
  if (git(job, "status", "--porcelain=v1", "-z", "--untracked-files=all") ||
      git(job, "rev-parse", "HEAD").trim() !== checkpoint.commitSha)
    throw Error("Review-batch boundary requires a clean, verified Story HEAD.");
  // A revalidated omission can remain current for this original job, but
  // its original sealed reviewer cannot be transplanted as a new fork
  // review. Keep the old batch immutable; fork admission independently
  // refuses any changed source without transferable exact-byte evidence.
  let revalidated = false;
  for (const item of reviewed) {
    const slug = item.milestone!.slice(10);
    const receipt = JSON.parse(await readFile(sourcePath(job, slug), "utf8"));
    const proof = await readEventOnlyOmission(job, item.milestone!, receipt.units?.[0]?.eventOnly);
    for (const [relative, expected] of Object.entries(proof.sourceHashes)) {
      const treePath = (job.storyRelativePath ? job.storyRelativePath + "/" : "") + relative;
      if (sha(git(job, "show", checkpoint.commitSha + ":" + treePath)) !== expected &&
          !await reviewedOmissionSuccessor(job,proof,receipt.units?.[0]?.eventOnly?.digest,checkpoint.commitSha))
        revalidated = true;
    }
  }
  if (revalidated) return;
  const batch = await collectReviewedOmissionBatch(job, checkpoint);
  if (!batch || reviewed.some(item =>
    !batch.entries.some(entry => entry.milestoneId === item.milestone)))
    throw Error("A verified no-write assignment has no authenticated review-batch receipt.");
  const marker = { version: 1, sourceHead: checkpoint.commitSha,
    sourceJobId: job.jobId, planDigest: batch.planDigest,
    milestones: batch.entries.map(entry => entry.milestoneId), digest: digest(batch) };
  const path = join(batchDir(job), checkpoint.commitSha + "-" + marker.digest + ".json");
  await mkdir(dirname(path), { recursive: true });
  if (existsSync(path)) {
    if (await readFile(path, "utf8") !== JSON.stringify(marker, null, 2) + "\n")
      throw Error("Existing review-batch boundary was altered.");
  } else {
    await writeFile(path, JSON.stringify(marker, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  }
}

/** A saved marker cannot silently claim decisions that were not reviewed.
 * Existing failed executions without markers may still be handoff candidates:
 * the underlying independent sealed receipts are the actual authority. */
export async function verifySavedReviewBatch(job: JobStartResult,
  batch: ReviewedOmissionBatch): Promise<void> {
  const dir = batchDir(job);
  if (!existsSync(dir)) return;
  const prefix = batch.sourceHead + "-";
  const candidates = (await readdir(dir)).filter(name => name.startsWith(prefix));
  if (!candidates.length) return;
  const digestValue = digest(batch);
  if (!candidates.includes(prefix + digestValue + ".json"))
    throw Error("Saved review-batch boundary differs from authenticated original decisions.");
  const path = join(dir, prefix + digestValue + ".json");
  const marker = JSON.parse(await readFile(path, "utf8")) as {
    version?: number; sourceHead?: string; sourceJobId?: string;
    planDigest?: string; milestones?: string[]; digest?: string;
  };
  if (marker.version !== 1 || marker.digest !== digestValue ||
      marker.sourceHead !== batch.sourceHead || marker.sourceJobId !== batch.sourceJobId ||
      marker.planDigest !== batch.planDigest ||
      JSON.stringify(marker.milestones) !==
      JSON.stringify(batch.entries.map(entry => entry.milestoneId)))
    throw Error("Saved review-batch boundary was tampered.");
}
