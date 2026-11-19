import { execFileSync } from "./git-read-cache.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { JobStartResult } from "./job.js";
import { trustedHead } from "./revision.js";
import { repoPath } from "./ideas.js";

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
  const root = job.stateDir;
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

/** A source-bound independent-review correction may succeed its own rejected
 * specialist. The original negative finding remains sealed; a separate,
 * independently passed successor must prove exact authorized paths and Git
 * ancestry. Ordinary specialist writes are NOT whitelisted by this exception. */
async function verifyIndependentReviewRepairSuccessor(job: JobStartResult, commit: string,
  parent: string, paths: string[], message: string[]) {
  const item = message.find(line => /^NovelTea-Work-Item: repair-[a-f0-9]{40}$/.test(line))
    ?.slice("NovelTea-Work-Item: ".length);
  if (!item)
    throw Error("Independent review correction has no authentic work-item provenance.");
  const sourceSha = item.slice("repair-".length);
  const { readRecoveryFork } = await import("./recovery-fork-state.js");
  const fork = readRecoveryFork(job);
  const inherited = fork?.commits[item];
  if (inherited?.sha === commit) {
    // In a descendant fork the immutable Git trailer names the *original*
    // Job, not the child. Admission already authenticated the source proof
    // and exact failed -> passed reviewer coverage; enforce it again without
    // importing its historic writer permissions into the new Job.
    const proof = fork?.receipts["review-repairs/proofs/" + sourceSha + ".json"];
    const status = fork?.reviewCoverage ?? [];
    const source = status.find(entry => entry.workItem !== item &&
      entry.commitSha === sourceSha);
    const correction = status.find(entry => entry.workItem === item &&
      entry.commitSha === commit);
    const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
    if (!message.includes("NovelTea-Job: " + inherited.jobId) ||
        !proof || proof.version !== 1 || proof.phase !== "committed" ||
        proof.workItemId !== item || proof.sourceCommitSha !== sourceSha ||
        proof.commitSha !== commit || proof.beforeHead !== parent ||
        !message.includes("NovelTea-Review-Repair: " + proof.digest) ||
        !Array.isArray(proof.paths) ||
        JSON.stringify(proof.paths.map((p: string) => prefix + p).sort()) !==
          JSON.stringify([...paths].sort()) ||
        source?.status !== "failed" || correction?.status !== "passed")
      throw Error("Inherited review correction lacks source-bound, independently passed fork evidence.");
    return;
  }
  if (!message.includes("NovelTea-Job: " + job.jobId))
    throw Error("Independent review correction has no authentic work-item provenance.");
  const { readRepairCommitProof, inspectCheckpointReview } = await import("./checkpoint-assurance.js");
  const { inspectRejectedRepair } = await import("./rejected-review-repair.js");
  const { inspectRecoveryCheckpoints } = await import("./recovery-checkpoints.js");
  const proof = await readRepairCommitProof(job, item);
  const receipt = await inspectRejectedRepair(job, sourceSha);
  const checkpoints = await inspectRecoveryCheckpoints(job);
  const point = checkpoints.find(p => p.eligible && p.commitSha === commit);
  const source = checkpoints.find(p => p.eligible && p.commitSha === sourceSha);
  const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
  const expectedPaths = proof.paths.map(path => prefix + path).sort();
  const actualPaths = [...paths].sort();
  const verdict = point ? await inspectCheckpointReview(job, point) : null;
  const originalVerdict = source ? await inspectCheckpointReview(job, source) : null;
  if (receipt.phase !== "passed" || receipt.sourceCommitSha !== sourceSha ||
      receipt.repairedCommitSha !== commit ||
      proof.beforeHead !== parent || proof.commitSha !== commit ||
      proof.sourceCommitSha !== sourceSha ||
      !message.includes("NovelTea-Review-Repair: " + proof.digest) ||
      JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths) ||
      point?.workItem !== item || point.parentSha !== parent ||
      JSON.stringify(point.assurance?.changedPaths.slice().sort()) !==
        JSON.stringify(proof.paths.slice().sort()) ||
      verdict?.status !== "passed" || originalVerdict?.status !== "failed") {
    throw Error("Independent review-repair successor lacks exact validated and passed provenance.");
  }
}

/** Only actual, source-bound narrative specialist checkpoints whose independent
 * review requirement is satisfied may appear between two immutable work-item
 * boundaries. A matching trailer or an arbitrary descendant SHA is never
 * sufficient. Recovery-fork coverage is pinned before child admission. */
async function verifyReviewedSpecialistSuccessor(job: JobStartResult, commit: string,
  parent: string, paths: string[], message: string[]): Promise<boolean> {
  const workItem = message.find(line =>
    /^NovelTea-Work-Item: (?:event-|interactive-(?:choice|puzzle)-|composition-)[a-z0-9-]+$/.test(line))
    ?.slice("NovelTea-Work-Item: ".length);
  if (!workItem) return false;
  const { readRecoveryFork, resolvedInheritedRecoveryReviews } =
    await import("./recovery-fork-state.js");
  const fork = readRecoveryFork(job);
  const inherited = fork?.commits[workItem];
  const originJob = inherited?.sha === commit ? inherited.jobId : job.jobId;
  if (!message.includes("NovelTea-Job: " + originJob))
    throw Error("Reviewed narrative successor has incorrect Job provenance.");
  const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
  const localPaths = paths.map(p => {
    if (!p.startsWith(prefix) || !/^[-a-z]+\/[a-z0-9._-]+\.md$/.test(p.slice(prefix.length)))
      throw Error("Reviewed narrative successor changed a noncanonical Story path.");
    return p.slice(prefix.length);
  }).sort();
  if (!localPaths.length)
    throw Error("Reviewed narrative successor changed no canonical records.");
  if (inherited?.sha === commit) {
    const decision = resolvedInheritedRecoveryReviews(fork!.reviewCoverage ?? []).find(entry =>
      entry.workItem === workItem && entry.commitSha === commit);
    if (!decision || !["passed", "not-required"].includes(decision.status))
      throw Error("Inherited narrative successor lacks passed, source-bound review coverage.");
    return true;
  }
  const { inspectRecoveryCheckpoints } = await import("./recovery-checkpoints.js");
  const { resolvedCheckpointReviews } = await import("./checkpoint-assurance.js");
  const checkpoints = await inspectRecoveryCheckpoints(job);
  const point = checkpoints.find(item => item.eligible && item.commitSha === commit);
  if (!point || point.workItem !== workItem || point.parentSha !== parent ||
      !point.assurance ||
      JSON.stringify([...point.assurance.changedPaths].sort()) !== JSON.stringify(localPaths))
    throw Error("Narrative successor lacks an exact authorized recovery checkpoint and diff.");
  const resolved = await resolvedCheckpointReviews(job, checkpoints);
  const review = resolved.get(commit) ?? point.semanticReview;
  if (review !== "passed" && review !== "not-required")
    throw Error("Narrative successor's mandatory independent review is still pending or failed.");
  return true;
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
  const prefix = repoPath(job, ".story-inbox/ideas") + "/";
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
    if (trailers.some(line => /^NovelTea-Work-Item: repair-[a-f0-9]{40}$/.test(line))) {
      await verifyIndependentReviewRepairSuccessor(job, commit, parents[1]!, paths, trailers);
      continue;
    }
    if (trailers.some(line => /^NovelTea-Work-Item: prerequisite-[a-z][a-z0-9-]*$/.test(line))) {
      const { verifyCrossDomainCloseoutSuccessor } = await import("./cross-domain-closeout-work.js");
      await verifyCrossDomainCloseoutSuccessor(job, commit, parents[1]!, paths, trailers);
      continue;
    }
    if (await verifyReviewedSpecialistSuccessor(job, commit, parents[1]!, paths, trailers))
      continue;
    if (trailers.includes("NovelTea-Work-Item: idea-placement")) {
      const { verifyPlacementSuccessor } = await import("./idea-placement.js");
      await verifyPlacementSuccessor(job, commit, parents[1]!, paths, trailers);
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
    const receiptFile = join(job.stateDir, "ideas", id + ".json");
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
  const file = join(job.stateDir, "composition-items",
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
