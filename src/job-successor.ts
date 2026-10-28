import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JobStartResult } from "./job.js";
import { trustedHead } from "./revision.js";

function git(job: JobStartResult, ...args: string[]) {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"]) delete env[key];
  return execFileSync("git", args, { cwd: job.worktreeRoot, env, encoding: "utf8" }).trim();
}

/** Only the completed, independently reviewed scoped prose repair is a
 * permissible narrative-changing successor. Verify its exact parent, paths,
 * Git blob identities and preserved final assessment, even after archiving
 * the review on a later authorized plan revision. */
function verifyReviewRepair(job: JobStartResult, commit: string, parent: string,
  paths: string[], message: string[]) {
  const root = dirname(job.worktreeRoot);
  const history = join(root, "review-history");
  const candidates = [join(root, "narrative-review.json"),
    ...(existsSync(history) ? readdirSync(history).filter(name =>
      /^plan-[0-9]+-head-[a-f0-9]{40,64}\.json$/.test(name)).map(name => join(history, name)) : [])];
  const receipts = candidates.filter(existsSync).map(path =>
    JSON.parse(readFileSync(path, "utf8")) as {
      version?: number; jobId?: string; phase?: string; worker?: string;
      planVersion?: number; headSha?: string; repairPriorHead?: string;
      repairCommitSha?: string; repairPaths?: string[]; repairDigest?: string;
      audit?: { headSha: string; deterministic: string; protection: string };
      editorial?: { verdict: string; evidence: string[] };
    }).filter(receipt => receipt.repairCommitSha === commit);
  if (receipts.length !== 1) throw new Error("Reviewed repair successor lacks a unique durable receipt.");
  const receipt = receipts[0]!;
  if (receipt.version !== 1 || receipt.jobId !== job.jobId || receipt.phase !== "completed" ||
      receipt.worker !== "pi" || receipt.headSha !== commit ||
      receipt.repairPriorHead !== parent || receipt.audit?.headSha !== commit ||
      receipt.audit.deterministic !== "passed" || receipt.audit.protection !== "checked" ||
      receipt.editorial?.verdict !== "pass" || !receipt.editorial.evidence?.length ||
      !receipt.planVersion || !receipt.repairDigest ||
      !Array.isArray(receipt.repairPaths) || !receipt.repairPaths.length) {
    throw new Error("Reviewed prose repair successor lacks passed scope/protection/editorial evidence.");
  }
  const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
  const expected = receipt.repairPaths.map(path => prefix + path).sort();
  if (receipt.repairPaths.some(path => !/^authored-content\/[a-z][a-z0-9-]*\.md$/.test(path)) ||
      JSON.stringify(expected) !== JSON.stringify([...paths].sort()) ||
      !["NovelTea-Job: " + job.jobId, "NovelTea-Work-Item: review-scope-repair",
        "NovelTea-Plan-Version: " + receipt.planVersion,
        "NovelTea-Review-Repair: " + receipt.repairDigest].every(line => message.includes(line))) {
    throw new Error("Reviewed repair successor changed unauthorized files or has invalid commit provenance.");
  }
  const blobs = expected.map(path => git(job, "rev-parse", commit + ":" + path)).join("|");
  if (createHash("sha256").update(blobs).digest("hex") !== receipt.repairDigest)
    throw new Error("Reviewed repair successor commit does not match its certified prose bytes.");
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
    const trailers = git(job, "log", "-1", "--format=%B", commit).split("\n");
    if (trailers.includes("NovelTea-Work-Item: review-scope-repair")) {
      verifyReviewRepair(job, commit, parents[1]!, paths, trailers);
      continue;
    }
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
