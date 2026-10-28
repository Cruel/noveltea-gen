import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JobStartResult } from "./job.js";
import { trustedHead } from "./revision.js";

function git(job: JobStartResult, ...args: string[]) {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"]) delete env[key];
  return execFileSync("git", args, { cwd: job.worktreeRoot, env, encoding: "utf8" }).trim();
}

/**
 * A deferred capture is a distinct verified commit, not a revision to the
 * preceding specialist's narrative premises. Do not accept arbitrary descendant
 * commits as a safe starting point: every intervening commit must be an exact
 * persisted idea capture with an unchanged original Story source.
 */
export async function verifiedNarrativeChain(job: JobStartResult, source: string, head: string) {
  const trusted = await trustedHead(job);
  git(job, "merge-base", "--is-ancestor", source, head);
  git(job, "merge-base", "--is-ancestor", head, trusted);
  const prefix = (job.storyRelativePath ? job.storyRelativePath + "/" : "") + ".story-inbox/ideas/";
  if (source === head) return head;
  const commits = git(job, "rev-list", "--reverse", source + ".." + head).split("\n").filter(Boolean);
  for (const commit of commits) {
    const parents = git(job, "rev-list", "--parents", "-n", "1", commit).split(" ");
    if (parents.length !== 2) throw new Error("Intervening merge is not an authorized deferred capture.");
    const paths = git(job, "diff-tree", "--no-commit-id", "--name-only", "-r", commit).split("\n").filter(Boolean);
    if (paths.length !== 1 || !paths[0]!.startsWith(prefix) ||
        !/^[a-z][a-z0-9-]*\.yaml$/.test(paths[0]!.slice(prefix.length))) {
      throw new Error("Verified successor changes narrative premises; explicit impact review is required.");
    }
    const additions = git(job, "diff-tree", "--no-commit-id", "--name-only", "--diff-filter=A", "-r", commit)
      .split("\n").filter(Boolean);
    if (additions.length !== 1 || additions[0] !== paths[0]) {
      throw new Error("A deferred capture may only add its own immutable inbox file.");
    }
    const id = paths[0]!.slice(prefix.length, -5);
    const receiptFile = join(dirname(job.worktreeRoot), "ideas", id + ".json");
    if (!existsSync(receiptFile)) throw new Error("Deferred successor lacks its durable capture receipt.");
    const receipt = JSON.parse(readFileSync(receiptFile, "utf8")) as {
      jobId?: string; phase?: string; commitSha?: string; priorHead?: string;
      id?: string; blobDigest?: string; inputDigest?: string;
    };
    const env = { ...process.env };
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"]) delete env[key];
    const content = execFileSync("git", ["show", commit + ":" + paths[0]], {
      cwd: job.worktreeRoot, env,
    });
    if (createHash("sha256").update(content).digest("hex") !== receipt.blobDigest) {
      throw new Error("Deferred successor blob does not match its capture receipt.");
    }
    const message = git(job, "log", "-1", "--format=%B", commit).split("\n");
    if (receipt.jobId !== job.jobId || receipt.id !== id || receipt.phase !== "committed" ||
        receipt.commitSha !== commit || receipt.priorHead !== parents[1] ||
        ![ "NovelTea-Job: " + job.jobId, "NovelTea-Work-Item: idea-capture",
          "NovelTea-Idea: " + id, "NovelTea-Idea-Blob: " + receipt.blobDigest,
          "NovelTea-Idea-Input: " + receipt.inputDigest ].every(line => message.includes(line))) {
      throw new Error("Intervening capture does not match its verified provenance.");
    }
  }
  return head;
}

export async function verifiedNarrativeSuccessor(job: JobStartResult, source: string) {
  return verifiedNarrativeChain(job, source, await trustedHead(job));
}

/** An already completed Interactive slice may be inspected after its own
 * committed Composition successor. That successor must match the exact
 * specialist receipt, never merely be a descendant with plausible trailers. */
export async function verifiedCompositionSuccessor(
  job: JobStartResult, milestone: string, interactiveHead: string,
) {
  const file = join(dirname(job.worktreeRoot), "composition-items",
    milestone.slice("milestone.".length) + ".json");
  if (!existsSync(file)) throw new Error("Interactive successor lacks a verified Composition receipt.");
  const state = JSON.parse(readFileSync(file, "utf8")) as {
    jobId?: string; milestoneId?: string; interactiveHead?: string;
    workItemId?: string; phase?: string; beforeHead?: string;
    commitSha?: string; paths?: string[]; digest?: string; planVersion?: number;
  };
  const before = state.beforeHead ?? interactiveHead;
  if (state.jobId !== job.jobId || state.milestoneId !== milestone ||
      state.interactiveHead !== interactiveHead || state.phase !== "committed" ||
      !state.commitSha || !state.digest || !state.paths?.length || !state.planVersion ||
      state.workItemId !== "composition-" + milestone.slice("milestone.".length)) {
    throw new Error("Composition successor has no exact finished specialist provenance.");
  }
  if (before !== interactiveHead) await verifiedNarrativeChain(job, interactiveHead, before);
  if (git(job, "rev-parse", state.commitSha + "^") !== before) {
    throw new Error("Composition successor parent differs from its verified Interactive baseline.");
  }
  const trailers = git(job, "log", "-1", "--format=%B", state.commitSha).split("\n");
  if (!["NovelTea-Job: " + job.jobId, "NovelTea-Work-Item: " + state.workItemId,
    "NovelTea-Plan-Version: " + state.planVersion, "NovelTea-Composition: " + state.digest]
    .every(line => trailers.includes(line))) {
    throw new Error("Composition successor lacks matching commit provenance.");
  }
  const repoPrefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
  const paths = git(job, "diff-tree", "--no-commit-id", "--name-only", "-r", state.commitSha)
    .split("\n").filter(Boolean).sort();
  if (JSON.stringify(paths) !== JSON.stringify(state.paths.map(p => repoPrefix + p).sort())) {
    throw new Error("Composition successor modified files outside its historical inventory.");
  }
  return verifiedNarrativeChain(job, state.commitSha, await trustedHead(job));
}
