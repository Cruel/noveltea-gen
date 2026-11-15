import { createHash } from "node:crypto";
import { execFileSync } from "./git-read-cache.js";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobStartResult } from "./job.js";
import { inspectSpecialistChoice, authorChoiceDirection } from "./specialist-choice.js";
import type { RecoveryCheckpoint } from "./recovery-checkpoints.js";
import { readTurnEvidence, type TurnAssignmentEvidence, type TurnEvidence } from "./turn-plan-evidence.js";

const SHA = /^[a-f0-9]{40}$/;
const digest = (data: unknown) => createHash("sha256").update(JSON.stringify(data)).digest("hex");
const canonicalPath = (path: string) => /^[a-z][a-z0-9-]*(?:\/[a-z0-9._-]+)+\.md$/.test(path) &&
  path.split("/").every(segment => segment !== "." && segment !== ".." && !segment.startsWith("."));
const highImpact = new Set(["event", "revelation", "choice-point", "puzzle"]);
const protectedAdjacent = new Set(["creative-direction", "arc", "milestone", "narrative-position"]);
const directories: Record<string, string> = {
  "creative-direction": "creative-direction", arcs: "arc", milestones: "milestone",
  characters: "character", relationships: "relationship", "world-entities": "world-entity",
  facts: "fact", revelations: "revelation", events: "event",
  "authored-content": "authored-content", "choice-points": "choice-point", puzzles: "puzzle",
  "narrative-positions": "narrative-position",
};

export type SemanticReviewStatus = "not-required" | "required-pending" | "passed" | "failed";
export interface ReviewSelection {
  status: "not-required" | "required-pending";
  reasons: string[];
}
export interface CheckpointAssurance {
  version: 1;
  policyVersion: 1;
  jobId: string;
  baseSha: string;
  commitSha: string;
  parentSha: string;
  workItem: string;
  validationProofDigest: string;
  validatorVersion: string;
  turnDigest: string;
  assignmentId: string;
  assignmentDigest: string;
  assignmentDependencies: string[];
  changedPaths: string[];
  changedRecordTypes: string[];
  addedLines: number;
  removedLines: number;
  diffDigest: string;
  reviewSelection: ReviewSelection;
}
export interface IndependentReviewResult {
  version: 1;
  source: Pick<CheckpointAssurance, "jobId" | "commitSha" | "turnDigest" |
    "assignmentId" | "assignmentDigest" | "diffDigest" | "validationProofDigest">;
  reviewer: string;
  status: "passed" | "failed";
  findings: Array<{ path: string; message: string;
    kind?: "missing-requirement" | "unrequested-change" | "continuity" | "other";
    line?: number; affectedPaths?: string[]; requiredCorrection?: string }>;
  evidence: string;
}
export type CheckpointReview = {
  assurance: CheckpointAssurance;
  status: SemanticReviewStatus;
  result: IndependentReviewResult | null;
};

/** Historical receipts may contain only message/path. Newly structured
 * findings must be complete and bounded. Reviewers grant no permissions. */
function validReviewFinding(f: IndependentReviewResult["findings"][number], paths: string[]) {
  if (!f || !paths.includes(f.path) || typeof f.message !== "string" || !f.message.trim())
    return false;
  const structured = [f.kind, f.line, f.affectedPaths, f.requiredCorrection];
  if (structured.every(v => v === undefined)) return true;
  return ["missing-requirement", "unrequested-change", "continuity", "other"].includes(f.kind ?? "") &&
    Number.isSafeInteger(f.line) && (f.line ?? 0) > 0 &&
    typeof f.requiredCorrection === "string" && f.requiredCorrection.trim().length >= 16 &&
    Array.isArray(f.affectedPaths) && f.affectedPaths.length > 0 &&
    f.affectedPaths.length <= 12 && f.affectedPaths.includes(f.path) &&
    new Set(f.affectedPaths).size === f.affectedPaths.length &&
    f.affectedPaths.every(path => canonicalPath(path));
}

export function selectCheckpointReview(input: {
  workItem: string; paths: string[]; addedLines: number; removedLines: number;
  dependencyCount: number; previousFailure: boolean;
}): ReviewSelection {
  if (!input.paths.length || input.paths.some(path => !canonicalPath(path) ||
      !directories[path.split("/")[0]!]))
    throw new Error("Assurance requires a bounded canonical committed Story diff.");
  const types = [...new Set(input.paths.map(path => directories[path.split("/")[0]!]!))];
  const reasons = [
    ...(types.some(type => protectedAdjacent.has(type)) ? ["architectural-or-protected-adjacent"] : []),
    ...(types.some(type => highImpact.has(type)) ? ["high-impact-record"] : []),
    ...(types.length > 1 ? ["cross-record-types"] : []),
    ...(input.dependencyCount >= 2 ? ["broad-dependencies"] : []),
    ...(input.paths.length >= 4 || input.addedLines + input.removedLines >= 150 ? ["large-diff"] : []),
    ...(input.previousFailure ? ["previous-review-failure"] : []),
  ];
  return { status: reasons.length ? "required-pending" : "not-required", reasons };
}

/** The gate consumes controller review receipts, not the writer's risk claim.
 * Transitive dependents wait; unrelated ready assignments are untouched. */
export function blockedByRequiredReview(
  items: Array<{ id: string; dependencies: string[]; status: string }>,
  reviews: Array<{ assignmentId: string; status: SemanticReviewStatus }>,
): Set<string> {
  const required = new Set(reviews.filter(review =>
    review.status === "required-pending" || review.status === "failed").map(review => review.assignmentId));
  const blocked = new Set<string>();
  for (let pass = 0; pass < items.length; pass++) {
    for (const item of items) {
      if (item.dependencies.some(parent => required.has(parent) || blocked.has(parent))) blocked.add(item.id);
    }
  }
  return blocked;
}

export function unresolvedNativePrerequisites(workItem: string,
  dependencies: Record<string, string[]>,
  reviews: Array<{ workItem: string; status: SemanticReviewStatus }>): string[] {
  const required = new Set(reviews.filter(review => review.status === "required-pending" ||
    review.status === "failed").map(review => review.workItem));
  const visited = new Set<string>();
  const blocked: string[] = [];
  const walk = (item: string) => {
    for (const parent of dependencies[item] ?? []) {
      if (visited.has(parent)) continue;
      visited.add(parent);
      if (required.has(parent)) blocked.push(parent);
      walk(parent);
    }
  };
  walk(workItem);
  return blocked.sort();
}

/** Return a *view* of review coverage after a verified repair. Never rewrite
 * historical immutable failures. A passing repair can supersede only the
 * precise chain of source failures whose immutable proofs it references. */
export async function resolvedCheckpointReviews(job: JobStartResult,
  points: Array<RecoveryCheckpoint & { eligible: boolean; semanticReview: SemanticReviewStatus | "untracked" }>,
): Promise<Map<string, SemanticReviewStatus>> {
  const covered = new Map<string, SemanticReviewStatus>();
  const byCommit = new Map(points.filter(p => p.eligible).map(p => [p.commitSha, p]));
  for (const point of points) {
    if (!point.eligible || point.semanticReview !== "passed" ||
        !point.workItem.startsWith("repair-")) continue;
    const ancestors: string[] = [];
    let source = point;
    const visited = new Set<string>();
    for (;;) {
      if (!source.workItem.startsWith("repair-")) break;
      const proof = await readRepairCommitProof(job, source.workItem);
      if (proof.commitSha !== source.commitSha || visited.has(proof.sourceCommitSha))
        throw Error("Review repair chain contains a conflicting or cyclic source.");
      visited.add(proof.sourceCommitSha);
      const parent = byCommit.get(proof.sourceCommitSha);
      if (!parent || parent.semanticReview !== "failed" ||
          parent.assurance?.assignmentId !== source.assurance?.assignmentId)
        throw Error("Passing repair cannot supersede an unverified or unrelated failure.");
      ancestors.push(parent.commitSha);
      source = parent;
      if (ancestors.length > 2) throw Error("Review repair chain exceeded bounded attempts.");
    }
    for (const ancestor of ancestors) covered.set(ancestor, "not-required");
  }
  // S14: only the shared dependency ledger's *verified* new-Character commit
  // plus two independent passing reviews (Character + Foundations), OR a
  // separately reviewed Event-owner correction after a passing supporting
  // Character review, can cover the originally failed checkpoint.
  // The old independent verdict and checkpoint are
  // never edited, deleted or retroactively marked passed. The dependency
  // inspector authenticates the Turn/owner/grant, exact Git diff and native
  // validation receipt before any coverage is derived from it.
  const { inspectDependencyPlan } = await import("./dependency-state.js");
  const dependencies = await inspectDependencyPlan(job);
  for (const entry of dependencies?.entries ?? []) {
    if (!entry.reviewSourceSha || entry.phase !== "verified" ||
        entry.review?.verdict !== "pass" ||
        !(entry.eventRepair || entry.originalReview?.verdict === "pass") ||
        !entry.reviewerSession ||
        !(entry.eventRepair || entry.originalReviewerSession) || !entry.commitSha)
      continue;
    const source = byCommit.get(entry.reviewSourceSha);
    const request = dependencies?.reviewRequests?.find(r => r.sourceSha === entry.reviewSourceSha);
    if (!source || source.semanticReview !== "failed" || !source.assurance ||
        !request || request.classification !== "new-full-story-record" ||
        source.assurance.assignmentId !== request.originalAssignmentId ||
        request.originalWorkItem !== source.workItem ||
        source.assurance.turnDigest !== request.turnDigest ||
        entry.report.turnDigest !== request.turnDigest ||
        entry.amendment?.resumes !== request.originalAssignmentId ||
        entry.amendment?.assignment.authority.newPaths?.length !== 1 ||
        entry.amendment?.assignment.authority.existingPaths.length !==
          (request.originalWorkItem.startsWith("event-") ? 0 : 1) ||
        entry.amendment.sourceSha !== source.commitSha ||
        (request.originalWorkItem.startsWith("event-")
          ? !entry.eventRepair
          : !entry.originalReview || !entry.originalReviewerSession))
      throw Error("Passing Character dependency cannot supersede an unrelated, stale or unverified negative checkpoint.");
    covered.set(source.commitSha, "not-required");
  }
  return covered;
}

export class IndependentReviewGateError extends Error {
  readonly name = "IndependentReviewGateError";
}
/** Multi-unit World/Character and Choice/Puzzle specialists stop at an exact
 * verified checkpoint rather than write past its mandatory independent review. */
export async function assertNativeReviewDependencies(job: JobStartResult, nextWorkItem: string) {
  const { inspectRecoveryCheckpoints } = await import("./recovery-checkpoints.js");
  const { readRecoveryFork, resolvedInheritedRecoveryReviews } = await import("./recovery-fork-state.js");
  const current = (await inspectRecoveryCheckpoints(job)).filter(point => point.eligible);
  const fork = readRecoveryFork(job);
  const resolved = await resolvedCheckpointReviews(job, current);
  const dependencies = current.at(-1)?.dependencies ?? fork?.checkpoint.dependencies ?? {};
  const statuses = [
    ...resolvedInheritedRecoveryReviews(fork?.reviewCoverage ?? []),
    ...current.filter(point => point.assurance).map(point => ({ workItem: point.workItem,
      status: resolved.get(point.commitSha) ??
        (point.semanticReview === "untracked" ? "required-pending" as const : point.semanticReview) })),
  ];
  const pending = unresolvedNativePrerequisites(nextWorkItem, dependencies, statuses);
  if (pending.length) throw new IndependentReviewGateError("Required independent review is pending or failed for prerequisite " +
    pending.join(", ") + "; do not start or replay a dependent specialist.");
}

export interface RepairCommitProof {
  version: 1; jobId: string; threadId: string; branch: string; baseSha: string;
  phase: "committed"; worker: "pi"; workItemId: string; sourceCommitSha: string;
  rootFailureSha: string; sourceReviewDigest: string; originalReviewDigest: string;
  assignmentId: string; assignmentDigest: string; assignmentRevision?: {
    version: number; assignment: TurnAssignmentEvidence; choiceId: string;
    proposalSha256: string; principal: string; direction: string; digest: string };
  beforeHead: string; commitSha: string; paths: string[]; digest: string;
  validation: { status: "passed"; validatorVersion: string; proofDigest: string };
  sessionFile: string; sessionSha256: string; sessionId: string;
  provider: string; model: string; snapshot: { id: string; path: string };
  planVersion: number;
  /** Digest of the controller-derived source-bound correction overlay. */
  repairPlanDigest?: string;
}
/** Repair provenance is a separate immutable source, never the mutable
 * controller attempt state or a model's proposed new scope. */
export async function readRepairCommitProof(job: JobStartResult, workItem: string): Promise<RepairCommitProof> {
  const match = workItem.match(/^repair-([a-f0-9]{40})$/);
  if (!match) throw Error("Not a repair work item.");
  const path = join(job.stateDir, "review-repairs", "proofs", match[1] + ".json");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128_000)
    throw Error("Unsafe verified review-repair proof.");
  const proof = JSON.parse(await readFile(path, "utf8")) as RepairCommitProof;
  if (proof.version !== 1 || proof.phase !== "committed" || proof.worker !== "pi" ||
      proof.jobId !== job.jobId || proof.threadId !== job.threadId ||
      proof.baseSha !== job.baseSha || proof.branch !== job.branch ||
      proof.workItemId !== workItem || proof.sourceCommitSha !== match[1] ||
      !SHA.test(proof.rootFailureSha) || !SHA.test(proof.commitSha) ||
      !SHA.test(proof.beforeHead) || !/^[a-f0-9]{64}$/.test(proof.digest) ||
      !/^[a-f0-9]{64}$/.test(proof.sourceReviewDigest) ||
      !/^[a-f0-9]{64}$/.test(proof.originalReviewDigest) ||
      !/^[a-f0-9]{64}$/.test(proof.assignmentDigest) ||
      !/^[a-f0-9]{64}$/.test(proof.validation?.proofDigest) ||
      proof.validation?.status !== "passed" ||
      proof.validation.validatorVersion !== job.validatorVersion ||
      !Array.isArray(proof.paths) || !proof.paths.length ||
      proof.paths.some(path => !canonicalPath(path)) ||
      !Number.isSafeInteger(proof.planVersion) || proof.planVersion < 1 ||
      (proof.repairPlanDigest !== undefined && !/^[a-f0-9]{64}$/.test(proof.repairPlanDigest)))
    throw Error("Review-repair proof has invalid identity or validation binding.");
  const source = JSON.parse(await readFile(join(job.stateDir, "recovery-checkpoints",
    proof.sourceCommitSha + ".json"), "utf8")) as RecoveryCheckpoint;
  if (source.jobId !== job.jobId || source.commitSha !== proof.sourceCommitSha ||
      !source.assurance || proof.paths.some(path => !source.assurance!.changedPaths.includes(path)) ||
      !gitAncestor(job, source.commitSha, proof.beforeHead))
    throw Error("Review repair exceeds the original rejected, validated source.");
  const review = await readIndependentReview(job, source.assurance);
  if (review.status !== "failed" || !review.result ||
      digest(review.result) !== proof.sourceReviewDigest ||
      source.assurance.assignmentId !== proof.assignmentId ||
      source.assurance.workItem !== source.workItem ||
      proof.beforeHead !== git(job, "rev-parse", proof.commitSha + "^").trim())
    throw Error("Review repair is not based on a sealed failed independent verdict.");
  return proof;
}
export async function repairReviewAssignment(job: JobStartResult,
  workItem: string, original: TurnAssignmentEvidence): Promise<TurnAssignmentEvidence> {
  if (!workItem.startsWith("repair-")) return original;
  const proof = await readRepairCommitProof(job, workItem);
  if (proof.assignmentId !== original.id) throw Error("Repair assignment differs from the original specialist.");
  if (!proof.assignmentRevision) {
    if (proof.assignmentDigest !== digest(original))
      throw Error("Repair assignment changed without authenticated author direction.");
    return original;
  }
  const revision = proof.assignmentRevision;
  const choice = await inspectSpecialistChoice(job, revision.choiceId);
  const direction = choice.answer && authorChoiceDirection(choice.question, choice.answer);
  const expected = { version: revision.version, assignment: revision.assignment,
    choiceId: revision.choiceId, proposalSha256: revision.proposalSha256,
    principal: revision.principal, direction: revision.direction };
  if (revision.version !== 2 || !choice.answer || choice.phase !== "consumed" ||
      choice.proposalSha256 !== revision.proposalSha256 ||
      choice.answer.principal !== revision.principal ||
      direction !== revision.direction || revision.digest !== digest(expected) ||
      revision.assignment.id !== original.id ||
      JSON.stringify(revision.assignment.authority) !== JSON.stringify(original.authority) ||
      JSON.stringify(revision.assignment.targets) !== JSON.stringify(original.targets) ||
      JSON.stringify(revision.assignment.dependsOn) !== JSON.stringify(original.dependsOn) ||
      proof.assignmentDigest !== digest(revision.assignment))
    throw Error("Repair assignment revision lacks a trusted, exact author choice.");
  return revision.assignment;
}
function assignmentId(workItem: string): string {
  if (workItem === "foundation") return "foundation";
  if (workItem === "global-architecture") return "architecture";
  if (workItem === "world-foundations" || workItem === "character-foundations") return "foundations";
  if (workItem.startsWith("event-")) return "event";
  if (workItem.startsWith("interactive-")) return "interactive";
  if (workItem.startsWith("composition-")) return "composition";
  if (workItem.startsWith("focus:")) return workItem;
  throw new Error("No Turn assignment corresponds to the verified work item.");
}
export function executionId(workItem: string): string {
  if (workItem === "global-architecture") return "architecture";
  if (workItem.endsWith("-foundations")) return "foundations";
  if (workItem.startsWith("event-")) return "event:milestone." + workItem.slice(6);
  if (workItem.startsWith("interactive-choice-")) return "interactive:milestone." + workItem.slice(19);
  if (workItem.startsWith("interactive-puzzle-")) return "interactive:milestone." + workItem.slice(19);
  if (workItem.startsWith("composition-")) return "composition:milestone." + workItem.slice(12);
  return workItem;
}
function gitAncestor(job: JobStartResult, ancestor: string, descendant: string): boolean {
  try { git(job, "merge-base", "--is-ancestor", ancestor, descendant); return true; }
  catch { return false; }
}
function cleanGitEnv() {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[key];
  return env;
}
function git(job: JobStartResult, ...args: string[]) {
  return execFileSync("git", args, { cwd: job.worktreeRoot, env: cleanGitEnv(),
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
}
async function turnEvidence(job: JobStartResult): Promise<TurnEvidence | null> {
  const path = join(job.stateDir, "turn-plan.json");
  if (!existsSync(path)) return null;
  // The contract is only a lookup hint. readTurnEvidence verifies the immutable
  // plan hash, source SHA, assignments, and original controller-owned receipt.
  const hint = JSON.parse(await readFile(path, "utf8")) as TurnEvidence;
  return readTurnEvidence(job, hint.contract);
}
function exactDiff(job: JobStartResult, parentSha: string, commitSha: string) {
  if (!SHA.test(parentSha) || !SHA.test(commitSha))
    throw new Error("Assurance requires exact Git commit identities.");
  const lines = git(job, "diff", "--numstat", "--no-ext-diff", parentSha, commitSha).trim().split("\n").filter(Boolean);
  const paths: string[] = [];
  let addedLines = 0, removedLines = 0;
  for (const line of lines) {
    const [inserted, deleted, full] = line.split("\t");
    const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
    if (!full?.startsWith(prefix) || !canonicalPath(full.slice(prefix.length)) ||
        !/^\d+$/.test(inserted ?? "") || !/^\d+$/.test(deleted ?? ""))
      throw new Error("Assurance refuses noncanonical or binary committed changes.");
    paths.push(full.slice(prefix.length));
    addedLines += Number(inserted);
    removedLines += Number(deleted);
  }
  if (!paths.length) throw new Error("Assurance cannot certify an empty specialist diff.");
  const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
  const changes = git(job, "diff", "--name-status", "--no-renames", "--no-ext-diff",
    parentSha, commitSha).split("\n").filter(Boolean).map(line => {
    const [status, name, extra] = line.split("\t");
    if (extra || (status !== "A" && status !== "M") || !name?.startsWith(prefix) ||
        !canonicalPath(name.slice(prefix.length)))
      throw new Error("Assurance refuses noncanonical, deleted or moved specialist files.");
    return { path: name.slice(prefix.length), status };
  });
  if (changes.length !== paths.length ||
      JSON.stringify(changes.map(c => c.path).sort()) !== JSON.stringify([...paths].sort()))
    throw new Error("Assurance requires matching Git path and change-kind evidence.");
  return { paths: paths.sort(), changes, addedLines, removedLines,
    diffDigest: createHash("sha256").update(git(job, "diff", "--binary", "--no-ext-diff",
      parentSha, commitSha)).digest("hex") };
}
function assertAuthority(assignment: TurnAssignmentEvidence,
  changes: Array<{ path: string; status: string }>, plan: TurnEvidence, repair: boolean) {
  if (plan.kind !== "revision") return;
  if (changes.some(({ path, status }) =>
      !assignment.authority.recordTypes.includes(directories[path.split("/")[0]!]!) ||
      (assignment.authority.existingPaths.includes(path) ? status !== "M" :
        (assignment.authority.newPaths ?? []).includes(path) ?
          status !== (repair ? "M" : "A") : true)))
    throw new Error("Specialist Git diff exceeds the controller-authorized create/edit assignment.");
}

/** Only invoked after native validation, receipt identity, and Git ancestry
 * verification. No assurance is manufactured for old/unplanned CLI jobs. */
export async function checkpointAssurance(job: JobStartResult,
  point: RecoveryCheckpoint): Promise<CheckpointAssurance | null> {
  const turn = await turnEvidence(job);
  if (!turn) return null;
  const proof = point.workItem.startsWith("repair-")
    ? await readRepairCommitProof(job, point.workItem) : null;
  const id = proof?.assignmentId ?? assignmentId(point.workItem);
  const original = turn.assignments.find(item => item.id === id);
  const assignment = original ? await repairReviewAssignment(job, point.workItem, original) : null;
  if (!assignment || point.baseSha !== turn.source.verifiedSha || point.jobId !== job.jobId)
    throw new Error("Checkpoint has no original, source-bound specialist assignment.");
  const diff = exactDiff(job, point.parentSha, point.commitSha);
  assertAuthority(assignment, diff.changes, turn, !!proof);
  if (proof && (proof.commitSha !== point.commitSha || proof.beforeHead !== point.parentSha ||
      JSON.stringify([...proof.paths].sort()) !== JSON.stringify(diff.paths)))
    throw Error("Repair checkpoint differs from the recorded authorized correction.");
  const types = [...new Set(diff.paths.map(path => directories[path.split("/")[0]!]!))].sort();
  // A previous failed independent review is a durable, exact-commit receipt,
  // never a suggestion supplied by the model that wrote this diff.
  // Failure history is observed at selection time. Its controller-derived
  // snapshot remains unchanged if an earlier independent review later fails.
  const previousFailure = point.assurance
    ? point.assurance.reviewSelection.reasons.includes("previous-review-failure")
    : (await Promise.all((await readAssuranceHistory(job)).filter(entry =>
      entry.commitSha !== point.commitSha && gitAncestor(job, entry.commitSha, point.parentSha))
      .map(async entry => (await readIndependentReview(job, entry)).status))).includes("failed");
  const selection = selectCheckpointReview({ workItem: point.workItem, paths: diff.paths,
    addedLines: diff.addedLines, removedLines: diff.removedLines,
    dependencyCount: assignment.dependsOn.length, previousFailure: !!proof || previousFailure });
  return { version: 1, policyVersion: 1, jobId: job.jobId, baseSha: job.baseSha,
    commitSha: point.commitSha, parentSha: point.parentSha, workItem: point.workItem,
    validationProofDigest: point.proofDigest, validatorVersion: point.validation.validatorVersion,
    turnDigest: turn.digest, assignmentId: id, assignmentDigest: digest(assignment),
    assignmentDependencies: [...assignment.dependsOn], changedPaths: diff.paths,
    changedRecordTypes: types, addedLines: diff.addedLines, removedLines: diff.removedLines,
    diffDigest: diff.diffDigest, reviewSelection: selection };
}
function reviewPath(job: JobStartResult, sha: string) {
  return join(job.stateDir, "independent-reviews", sha + ".json");
}
async function readAssuranceHistory(job: JobStartResult): Promise<CheckpointAssurance[]> {
  // The immutable recovery records are authoritative. We do not infer
  // "passed" from a Git commit, a reviewer's text, or missing history.
  const { readdir } = await import("node:fs/promises");
  const directory = join(job.stateDir, "recovery-checkpoints");
  if (!existsSync(directory)) return [];
  const result: CheckpointAssurance[] = [];
  for (const name of (await readdir(directory)).filter(n => /^[a-f0-9]{40}\.json$/.test(n))) {
    const record = JSON.parse(await readFile(join(directory, name), "utf8")) as RecoveryCheckpoint;
    if (record.assurance && record.commitSha === name.slice(0, 40) && record.jobId === job.jobId)
      result.push(record.assurance);
  }
  return result;
}
const sourceOf = (a: CheckpointAssurance): IndependentReviewResult["source"] => ({
  jobId: a.jobId, commitSha: a.commitSha, turnDigest: a.turnDigest,
  assignmentId: a.assignmentId, assignmentDigest: a.assignmentDigest,
  diffDigest: a.diffDigest, validationProofDigest: a.validationProofDigest,
});
export async function readIndependentReview(job: JobStartResult,
  assurance: CheckpointAssurance): Promise<{ status: SemanticReviewStatus; result: IndependentReviewResult | null }> {
  const path = reviewPath(job, assurance.commitSha);
  if (!existsSync(path)) return { status: assurance.reviewSelection.status, result: null };
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Independent review receipt must be a regular file.");
  const result = JSON.parse(await readFile(path, "utf8")) as IndependentReviewResult;
  if (assurance.reviewSelection.status !== "required-pending" ||
      result.version !== 1 || JSON.stringify(result.source) !== JSON.stringify(sourceOf(assurance)) ||
      !["passed", "failed"].includes(result.status) ||
      !result.reviewer?.trim() || !result.evidence?.trim() ||
      !Array.isArray(result.findings) ||
      result.findings.some(f => !validReviewFinding(f, assurance.changedPaths)) ||
      (result.status === "passed" && result.findings.length !== 0) ||
      (result.status === "failed" && result.findings.length === 0))
    throw new Error("Independent review is stale, unauthoritative, or malformed.");
  return { status: result.status, result };
}
/** Review service entrypoint for #112. It may only seal an actual independent
 * result for the exact previously validated assignment and diff. */
export async function sealIndependentReview(job: JobStartResult, point: RecoveryCheckpoint,
  result: IndependentReviewResult): Promise<void> {
  const assurance = point.assurance;
  const { inspectRecoveryCheckpoints } = await import("./recovery-checkpoints.js");
  const finalized = (await inspectRecoveryCheckpoints(job)).some(saved =>
    saved.eligible && saved.commitSha === point.commitSha &&
    saved.proofDigest === point.proofDigest &&
    JSON.stringify(saved.assurance) === JSON.stringify(assurance));
  if (!assurance || !finalized || !await inspectCheckpointReview(job, point) ||
      assurance.reviewSelection.status !== "required-pending" ||
      JSON.stringify(sourceOf(assurance)) !== JSON.stringify(result.source))
    throw new Error("A review cannot approve an unvalidated or changed assignment.");
  const { status, result: prior } = await readIndependentReview(job, assurance);
  if (prior) {
    if (JSON.stringify(prior) !== JSON.stringify(result))
      throw new Error("Independent review is already sealed for a different result.");
    return;
  }
  if (status !== "required-pending") throw new Error("This checkpoint does not require semantic review.");
  if (!["passed", "failed"].includes(result.status) ||
      !result.reviewer?.trim() || !result.evidence?.trim() ||
      !Array.isArray(result.findings) ||
      result.findings.some(f => !validReviewFinding(f, assurance.changedPaths)) ||
      (result.status === "passed" && result.findings.length !== 0) ||
      (result.status === "failed" && result.findings.length === 0))
    throw new Error("Independent review lacks source-linked actionable evidence.");
  await mkdir(join(job.stateDir, "independent-reviews"), { recursive: true });
  try {
    await writeFile(reviewPath(job, assurance.commitSha), JSON.stringify(result, null, 2) + "\n",
      { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = (await readIndependentReview(job, assurance)).result;
    if (JSON.stringify(existing) !== JSON.stringify(result))
      throw new Error("Concurrent independent review already sealed a different result.");
  }
}
export async function inspectCheckpointReview(job: JobStartResult,
  point: RecoveryCheckpoint): Promise<CheckpointReview | null> {
  if (!point.assurance) return null;
  const expected = await checkpointAssurance(job, point);
  if (!expected || JSON.stringify(expected) !== JSON.stringify(point.assurance))
    throw new Error("Checkpoint assurance differs from controller selection or exact Git diff.");
  const outcome = await readIndependentReview(job, point.assurance);
  return { assurance: point.assurance, ...outcome };
}
