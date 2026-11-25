/** Reconstruct the original Event's selected-Milestone field grant. Only the
 * native-typed, source-hashed Event consequence proof sealed in the original
 * Git commit can identify the selected record; filenames do not supply IDs.
 * This does not confer general Milestone or new-record authority. */
import { inheritedReviewedCheckpoint, readRecoveryFork } from "./recovery-fork-state.js";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { execFileSync } from "./git-read-cache.js";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { eventConsequenceProofDigest, type EventConsequenceProof } from "./event-consequence-proof.js";
import type { JobStartResult } from "./job.js";
import type { RecoveryCheckpoint } from "./recovery-checkpoints.js";
import type { TurnAssignmentEvidence } from "./turn-plan-evidence.js";
import type { EventMilestoneRepairGrant } from "./review-repair-amendment.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const canonicalMilestone = /^milestones\/[a-z0-9][a-z0-9._-]*\.md$/;

export async function readEventMilestoneRepairGrant(job: JobStartResult,
  point: RecoveryCheckpoint, original: TurnAssignmentEvidence,
  purpose: "rejected-review" | "deferred-choice-closeout" = "rejected-review",
): Promise<EventMilestoneRepairGrant | undefined> {
  if (!point.workItem.startsWith("event-")) return undefined;
  const slug = point.workItem.slice(6);
  const id = "milestone." + slug;
  if (!/^[a-z][a-z0-9-]*$/.test(slug) ||
      original.id !== "event" || original.specialist !== "nt-event-design" ||
      (original.targets.length > 0 && !original.targets.includes(id)) ||
      !original.authority.recordTypes.includes("event"))
    throw Error("Event repair has no original selected Milestone assignment.");
  const path = join(job.stateDir, "event-items", slug + ".json");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512_000)
    throw Error("Unsafe original Event repair receipt.");
  const receipt = JSON.parse(await readFile(path, "utf8")) as {
    version?: number; jobId?: string; baseSha?: string; workItemId?: string;
    worker?: string; phase?: string; commitSha?: string; expectedHead?: string;
    planVersion?: number; milestoneId?: string; paths?: string[];
    validation?: { status?: string }; assignment?: { milestoneId?: string;
      milestonePath?: string; workItemId?: string; sourcePaths?: string[] };
    consequenceProof?: EventConsequenceProof;
  };
  if (point.jobId !== job.jobId) {
    // The current Turn independently authorizes the bounded Event owner;
    // the old immutable proof only identifies the selected source fields.
    const inherited = inheritedReviewedCheckpoint(job, point.workItem, point.commitSha);
    const originalReceipt = readRecoveryFork(job)?.receipts["event-items/" + slug + ".json"];
    if (purpose !== "deferred-choice-closeout" || !inherited ||
        !isDeepStrictEqual(inherited.proof, point) ||
        !originalReceipt || !isDeepStrictEqual(originalReceipt.consequenceProof, receipt.consequenceProof) ||
        !isDeepStrictEqual(originalReceipt.assignment, receipt.assignment))
      throw Error("Inherited Event source differs from its independently reviewed fork evidence.");
  }
  const proof = receipt.consequenceProof;
  const selected = proof?.milestone;
  if (receipt.version !== 1 || receipt.jobId !== job.jobId ||
      receipt.baseSha !== job.baseSha || receipt.workItemId !== point.workItem ||
      receipt.worker !== "pi" || receipt.phase !== "committed" ||
      receipt.commitSha !== point.commitSha || receipt.expectedHead !== point.parentSha ||
      receipt.planVersion !== point.planVersion || receipt.validation?.status !== "passed" ||
      receipt.milestoneId !== id || receipt.assignment?.milestoneId !== id ||
      receipt.assignment?.workItemId !== point.workItem ||
      !selected || selected.id !== id ||
      !canonicalMilestone.test(selected.path) ||
      receipt.assignment.milestonePath !== selected.path ||
      !receipt.assignment.sourcePaths?.includes(selected.path) ||
      (purpose === "rejected-review" &&
        (!receipt.paths?.includes(selected.path) ||
          !point.assurance?.changedPaths.includes(selected.path))) ||
      proof?.version !== 1 || !Array.isArray(proof.sourceHashes))
    throw Error("Event repair lacks its original verified typed Milestone field grant.");

  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"])
    delete env[key];
  const git = (...args: string[]) => execFileSync("git", args, {
    cwd: job.worktreeRoot, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 128 * 1024,
  });
  const source = job.storyRelativePath ? job.storyRelativePath + "/" + selected.path : selected.path;
  const entry = git("ls-tree", "-z", point.commitSha, "--", source);
  const match = entry.match(/^100644 blob ([a-f0-9]{40})\t[^\0]+\0$/);
  if (!match ||
      !git("log", "-1", "--format=%B", point.commitSha).split("\n")
        .includes("NovelTea-Event-Consequence: " + eventConsequenceProofDigest(proof)) ||
      !proof.sourceHashes.some(item => item.path === selected.path &&
        item.sha256 === sha256(git("cat-file", "blob", match[1]!))))
    throw Error("Event repair Milestone path/typed ID differs from the signed native source.");
  return { id, path: selected.path };
}
