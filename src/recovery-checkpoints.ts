import { execFileSync } from "./git-read-cache.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { startStoryJob, type JobStartResult } from "./job.js";
import { verifyPlanHistory, type Plan } from "./architecture.js";
import { trustedHead } from "./revision.js";
import { readRecoveryFork } from "./recovery-fork-state.js";
import { readChatApprovedFoundation } from "./chat-approved-foundation.js";
import { readPuzzleNoWrite, type PuzzleNoWriteRef } from "./puzzle-obligation.js";
import { checkpointAssurance, inspectCheckpointReview, readRepairCommitProof,
  type CheckpointAssurance, type SemanticReviewStatus } from "./checkpoint-assurance.js";

/**
 * Recovery checkpoints are *logical* continuation records, not copies of a live
 * LangGraph SQLite thread. A specialist can commit while its parent graph node
 * is still running. The next run must reconstruct its own graph from this
 * independently verified boundary, never transplant the parent's live state.
 *
 * The source specialist receipt remains authoritative. Only the controller may
 * finalize a checkpoint; inspection never promotes a Git SHA into evidence.
 */
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const ITEM = /^[a-z][a-z0-9.:-]*$/;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const dir = (job: JobStartResult) => join(job.stateDir, "recovery-checkpoints");
const finalizedFile = (job: JobStartResult, sha: string) => join(dir(job), sha + ".json");
const intentFile = (job: JobStartResult, sha: string) => join(dir(job), sha + ".intent.json");
const cleanEnv = () => {
  const env = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[k];
  return env;
};
function git(job: JobStartResult, ...args: string[]): string {
  return execFileSync("git", args, { cwd: job.worktreeRoot, env: cleanEnv(),
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 }).trim();
}
function isAncestor(job: JobStartResult, ancestor: string, descendant: string) {
  try { git(job, "merge-base", "--is-ancestor", ancestor, descendant); return true; }
  catch { return false; }
}
async function atomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + "." + randomUUID() + ".tmp";
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}
function sourceFor(id: string): { path: string; unit?: string } {
  if (id === "foundation") return { path: "foundation.json" };
  if (id === "global-architecture") return { path: "architecture.json" };
  if (id === "world-foundations" || id === "character-foundations")
    return { path: "character-world.json", unit: id };
  const event = id.match(/^event-([a-z][a-z0-9-]*)$/);
  if (event) return { path: "event-items/" + event[1] + ".json" };
  const interactive = id.match(/^interactive-(choice|puzzle)-([a-z][a-z0-9-]*)$/);
  if (interactive) return { path: "interactive-items/" + interactive[2] + ".json", unit: id };
  const composition = id.match(/^composition-([a-z][a-z0-9-]*)$/);
  if (composition) return { path: "composition-items/" + composition[1] + ".json" };
  const repair = id.match(/^repair-([a-f0-9]{40})$/);
  if (repair) return { path: "review-repairs/proofs/" + repair[1] + ".json" };
  const focus = id.match(/^focus:([a-z][a-z0-9.-]*)$/);
  if (focus) return { path: "focused-items/" + focus[1] + ".json" };
  throw new Error("Unsupported specialist work item: " + id);
}
type Receipt = Record<string, any>;
function proofOf(id: string, receipt: Receipt, sha: string) {
  const item = id === "global-architecture"
    ? { phase: receipt.phase, plan: receipt.plan ? { version: receipt.plan.version,
      architecture: receipt.plan.items?.find((i: Receipt) => i.id === "global-architecture") } : null,
      paths: receipt.paths, contentDigest: receipt.contentDigest, snapshot: receipt.snapshot?.id }
    : id === "foundation"
      ? { phase: receipt.stage, commitSha: receipt.commitSha,
        validation: receipt.validation, authoredSha256: receipt.authoredSha256,
        target: receipt.target, snapshot: receipt.snapshot?.id }
      : receipt.units ? receipt.units.find((unit: Receipt) => unit.id === id) : receipt;
  if (!item || typeof item !== "object") throw new Error("Specialist receipt lacks the exact work item.");
  if (id === "global-architecture") {
    if (item.phase !== "committed" || item.plan?.architecture?.status !== "verified" ||
        item.plan.architecture.verifiedSha !== sha)
      throw new Error("Architecture has no matching verified plan commit.");
  } else if (item.phase !== "committed" || item.commitSha !== sha) {
    throw new Error("Work-item receipt is not independently committed at this SHA.");
  }
  if (id === "foundation") {
    if (item.validation !== "passed" && item.validation !== "unverified-empty-baseline")
      throw new Error("Foundation has no recognized validation evidence.");
  } else if (id !== "global-architecture") {
    // A specialist's recorded proof is mandatory, not merely its self-reported
    // 'committed' phase. Focus uses the verified authored digest instead.
    const evidence = item.validation as { validatorVersion?: string; status?: string;
      branchReview?: { status?: string } } | undefined;
    if (id.startsWith("focus:")) {
      if (!HASH.test(item.sha256 ?? "")) throw new Error("Focused work lacks its pinned content digest.");
    } else if (!evidence || (evidence.status !== "passed" &&
        evidence.branchReview?.status !== "passed" &&
        !(id.startsWith("interactive-") && ("choices" in evidence || "puzzles" in evidence)))) {
      throw new Error("Committed specialist lacks passing validation evidence.");
    }
  }
  // A controller may annotate an already committed Interactive unit with a
  // diagnostic failure after checkpoint finalization (e.g. a later graph
  // scheduling error). That mutable error does not change its pinned Git
  // paths, validation or specialist evidence. Hash only the original
  // committed unit bytes; leave every other field within the immutable proof.
  if (id.startsWith("interactive-") && "failure" in item) {
    const { failure: _diagnostic, ...committed } = item;
    return committed;
  }
  return item;
}
async function receiptProof(job: JobStartResult, id: string, sha: string, archivedArchitecture?: Receipt) {
  const source = sourceFor(id);
  const full = join(job.stateDir, source.path);
  const stat = await lstat(full);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Specialist receipt is not a regular file.");
  const receipt = JSON.parse(await readFile(full, "utf8")) as Receipt;
  if (receipt.jobId !== job.jobId || (receipt.baseSha && receipt.baseSha !== job.baseSha) ||
      (receipt.branch && receipt.branch !== job.branch) ||
      (receipt.worktreeRoot && receipt.worktreeRoot !== job.worktreeRoot) ||
      (receipt.threadId && receipt.threadId !== job.threadId)) {
    throw new Error("Specialist receipt is not bound to this job/branch.");
  }
  // Architecture is a mutable planning receipt. Once a signed replan supersedes
  // it, the per-commit proof captured before that replan remains authoritative.
  const proof = id === "global-architecture" && archivedArchitecture
    ? archivedArchitecture : proofOf(id, receipt, sha);
  if (id === "global-architecture" && archivedArchitecture &&
      (proof.phase !== "committed" || proof.plan?.architecture?.status !== "verified" ||
        proof.plan.architecture.verifiedSha !== sha))
    throw new Error("Archived architecture proof does not certify the original commit.");
  const expectedPaths = (id === "foundation" ? [receipt.target] : proof.paths) as unknown;
  if (!Array.isArray(expectedPaths) || !expectedPaths.length ||
      expectedPaths.some(path => typeof path !== "string" ||
        !/^[a-z][a-z0-9-]*(?:\/[a-z0-9._-]+)+\.md$/.test(path))) {
    throw new Error("Specialist has no bounded committed file inventory.");
  }
  const actual = git(job, "diff-tree", "--no-commit-id", "--name-only", "-r", sha)
    .split("\n").filter(Boolean).sort();
  const expected = expectedPaths.map(path => (job.storyRelativePath ?
    job.storyRelativePath + "/" : "") + path).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error("Specialist commit changed paths outside its verified receipt.");
  const commitMessage = git(job, "log", "-1", "--format=%B", sha).split("\n");
  const trailer = id === "foundation" ? ["NovelTea-Foundation", receipt.authoredSha256] :
    id === "global-architecture" ? ["NovelTea-Architecture", proof.contentDigest] :
    id.endsWith("-foundations") ? ["NovelTea-Foundations", proof.digest] :
    id.startsWith("event-") ? ["NovelTea-Event-Design", receipt.contentDigest] :
    id.startsWith("interactive-") ? ["NovelTea-Interactive", proof.digest] :
    id.startsWith("composition-") ? ["NovelTea-Composition", receipt.digest] :
    id.startsWith("repair-") ? ["NovelTea-Review-Repair", receipt.digest] :
    ["NovelTea-Focused-Digest", receipt.sha256];
  if (!HASH.test(trailer[1] ?? "") || !commitMessage.includes(trailer.join(": ")))
    throw new Error("Specialist content digest differs from the original Git commit.");
  if (id === "foundation" &&
      !commitMessage.includes("NovelTea-Validation: " + proof.validation))
    throw new Error("Foundation validation trailer differs from the verified receipt.");
  return { source: source.path, proofDigest: digest(proof), proof,
    fixture: receipt.worker === "fixture" || receipt.workerMode === "fixture",
    snapshotId: (id === "global-architecture" ? proof.snapshot : receipt.snapshot?.id) as string | undefined,
    planVersion: (id === "global-architecture" ? proof.plan?.version :
      receipt.planVersion ?? receipt.plan?.version ?? null) as number | null };
}
export interface RecoveryCheckpoint {
  version: 1;
  status: "finalized";
  jobId: string; repository: string; story: string; storyRelativePath: string;
  branch: string; graphThread: string; baseSha: string; commitSha: string; parentSha: string;
  workItem: string; stage: string; planVersion: number | null;
  planDigest: string | null; plan: unknown;
  completedWorkItems: string[]; remainingWorkItems: string[];
  /** A sealed omission is a satisfied dependency, not a fabricated Git commit. */
  omittedWorkItems?: Array<{ workItem: string; seal: PuzzleNoWriteRef }>;
  nextWorkItem: string | null; dependencies: Record<string, string[]>;
  validation: { status: "passed" | "unverified-empty-baseline" | "not-verified"; validatorVersion: string };
  source: string; proofDigest: string; snapshotId: string | null;
  /** Controller-derived review selection, sealed with the original native checkpoint. */
  assurance?: CheckpointAssurance | null;
  compatibility: { logicalSchema: "noveltea-recovery/v1"; graphSchema: "noveltea-generation/v1" };
  /** Context references, never transferable approval grants. */
  provenance: { authorApprovals: "source-bound-not-reusable"; authorMessages: "source-bound-not-reusable" };
}
export type RecoveryInspection = RecoveryCheckpoint & { eligible: boolean; reason: string | null;
  semanticReview: SemanticReviewStatus | "untracked" };
interface RecoveryIntent {
  version: 2; jobId: string; commitSha: string; parentSha: string; workItem: string;
  proofDigest: string; planDigest: string | null; architectureProof: Receipt | null;
}
async function readIntent(job: JobStartResult, sha: string): Promise<RecoveryIntent> {
  const path = intentFile(job, sha);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("Recovery checkpoint intent is not a trusted file.");
  const intent = JSON.parse(await readFile(path, "utf8")) as RecoveryIntent;
  if (intent.version !== 2 || intent.jobId !== job.jobId || intent.commitSha !== sha ||
      !HASH.test(intent.proofDigest) ||
      (intent.planDigest !== null && !HASH.test(intent.planDigest)) ||
      (intent.workItem === "global-architecture" ? !intent.architectureProof : intent.architectureProof !== null))
    throw new Error("Recovery intent lacks its original commit and plan evidence.");
  return intent;
}
async function graphThread(job: JobStartResult) {
  const path = join(job.stateDir, "generation-server-owner.json");
  if (!existsSync(path)) return job.threadId + ":generation";
  const owner = JSON.parse(await readFile(path, "utf8")) as {
    schema?: string; jobId?: string; threadId?: string; requestSha256?: string;
  };
  if (owner.schema !== "noveltea-generation-owner/v1" ||
      owner.jobId !== job.jobId || owner.threadId !== job.threadId + ":generation:web" ||
      !HASH.test(owner.requestSha256 ?? "")) {
    throw new Error("Parent generation ownership receipt has an incompatible identity.");
  }
  return owner.threadId;
}
function stageOf(id: string) {
  if (["foundation", "global-architecture"].includes(id)) return id === "foundation" ? "foundation" : "architecture";
  if (id.endsWith("-foundations")) return "foundations";
  if (id.startsWith("event-")) return "event";
  if (id.startsWith("interactive-")) return "interactive";
  if (id.startsWith("composition-")) return "composition";
  if (/^repair-[a-f0-9]{40}$/.test(id)) return "repair";
  if (id.startsWith("focus:")) return "focus";
  throw new Error("Unsupported recovery stage.");
}
async function planFor(job: JobStartResult, requiredDigest?: string | null) {
  const path = join(job.stateDir, "architecture.json");
  if (!existsSync(path)) return null;
  const receipt = JSON.parse(await readFile(path, "utf8")) as Receipt;
  if (receipt.jobId !== job.jobId || receipt.baseSha !== job.baseSha ||
      (receipt.branch && receipt.branch !== job.branch) ||
      (receipt.threadId && receipt.threadId !== job.threadId) ||
      !receipt.plan || !Number.isInteger(receipt.plan.version))
    throw new Error("No job-bound architecture plan is available for continuation.");
  verifyPlanHistory(job, receipt as Parameters<typeof verifyPlanHistory>[1]);
  // Approved transitions archive the *prior* plan with signed controller
  // evidence. Checkpoint reads must match the original plan version, never a
  // newly authorized (and potentially broader) replacement plan.
  const candidates = [receipt.plan, ...receipt.history.map((entry: Receipt) => entry.plan)];
  const selected = requiredDigest === undefined ? receipt.plan :
    candidates.find((candidate: Receipt) => digest(candidate) === requiredDigest);
  if (!selected || !Number.isInteger(selected.version))
    throw new Error("Checkpoint plan differs from controller-authorized plan history.");
  return selected as Plan;
}
function workPlan(plan: Awaited<ReturnType<typeof planFor>>, committedItem: string,
  historicalRepairs: readonly string[] = []): { order: string[]; dependencies: Record<string,string[]> } {
  const order = ["foundation", "global-architecture"];
  const deps: Record<string, string[]> = { foundation: [], "global-architecture": ["foundation"] };
  const add = (id: string, dependency: string[]) => {
    if (order.includes(id)) return;
    order.push(id); deps[id] = dependency;
  };
  // A passed, source-bound correction is a real completed work item, not a
  // new specialist assignment. Keep its exact identity in subsequent derived
  // inventories; verifyFinal separately authenticates inherited baselines and
  // original same-Job Git history, so this cannot fabricate a completion.
  for (const id of historicalRepairs) {
    if (!/^repair-[a-f0-9]{40}$/.test(id))
      throw Error("Historical review repair has an invalid work-item identity.");
    // Historic repairs are completed provenance, not executable plan tasks.
    // Existing finalized checkpoints never inserted them in the dependency
    // map; only a repair's own checkpoint has that executable work item.
    if (id === committedItem) add(id, []);
    else if (!order.includes(id)) order.push(id);
  }
  if (!plan) {
    if (stageOf(committedItem) === "repair") add(committedItem, []);
    return { order, dependencies: deps };
  }
  // A direct specialist command may legitimately extend an architecture-only
  // job. It does not silently upgrade the author-approved parent contract.
  // The recovery inventory extends just far enough to represent that work.
  const stageRank: Record<string, number> = {
    architecture: 0, foundations: 1, event: 2, interactive: 3, composition: 4,
  };
  const requested = stageRank[stageOf(committedItem)] ?? 0;
  // A repair is a distinct verified correction, not a fabricated completion
  // of an unrelated specialist or a replacement for the rejected checkpoint.
  if (stageOf(committedItem) === "repair") add(committedItem, []);
  const approved = stageRank[plan.contract.scope.depth ?? "composition"] ?? 4;
  const depth = Math.max(approved, requested);
  if (plan.items.some(i => i.id.startsWith("focus-"))) {
    for (const target of plan.contract.scope.targets) {
      const create = plan.contract.scope.creates?.find(item => item.id === target);
      add("focus:" + target, ["global-architecture",
        ...(create?.dependsOn.map(id => "focus:" + id) ?? [])]);
    }
    add("review", plan.contract.scope.targets.map(target => "focus:" + target));
    return { order, dependencies: deps };
  }
  if (depth === 0) {
    add("review", ["global-architecture"]);
    return { order, dependencies: deps };
  }
  add("world-foundations", ["global-architecture"]);
  add("character-foundations", ["world-foundations"]);
  if (depth === 1) {
    add("review", ["character-foundations"]);
    return { order, dependencies: deps };
  }
  const milestones = [...new Set(plan.items.flatMap(i => i.targetIds)
    .filter(id => id.startsWith("milestone.")))].sort();
  for (const milestone of milestones) {
    const slug = milestone.slice("milestone.".length);
    const event = "event-" + slug, choice = "interactive-choice-" + slug, puzzle = "interactive-puzzle-" + slug;
    // Only realization work items have executable Event prerequisites. Aggregate
    // composition/review placeholders depend on *all* Milestones and must not
    // become invented Event-to-Event barriers (or cycles).
    const planItems = plan.items.filter(i => i.kind === "realization" && i.targetIds.includes(milestone));
    const otherMilestoneDeps = planItems.flatMap(i => i.dependencies ?? [])
      .flatMap(dep => { const item = plan.items.find(i => i.id === dep);
        return item?.kind === "realization" ? item.targetIds : []; })
      .filter(id => id.startsWith("milestone.") && id !== milestone)
      .map(id => "event-" + id.slice("milestone.".length));
    add(event, ["character-foundations", ...new Set(otherMilestoneDeps)]);
    if (depth >= 3) { add(choice, [event]); add(puzzle, [choice]); }
    if (depth >= 4) add("composition-" + slug, [puzzle]);
  }
  add("review", milestones.map(milestone => (depth >= 4 ? "composition-" :
    depth >= 3 ? "interactive-puzzle-" : "event-") + milestone.slice("milestone.".length)));
  return { order, dependencies: deps };
}
/** No-write decisions remain independently proven and never become completed Git work. */
async function verifyOmissions(job: JobStartResult,
  entries: RecoveryCheckpoint["omittedWorkItems"], head: string): Promise<Set<string>> {
  const omissions = new Set<string>();
  if (entries === undefined) return omissions;
  if (!Array.isArray(entries) || entries.length > 64)
    throw new Error("Recovery Puzzle omissions are not a bounded controller inventory.");
  for (const entry of entries) {
    const match = /^interactive-puzzle-([a-z][a-z0-9-]*)$/.exec(entry?.workItem ?? "");
    if (!match || omissions.has(entry.workItem))
      throw new Error("Invalid or duplicate Puzzle omission in recovery checkpoint.");
    const milestone = "milestone." + match[1]!;
    const proof = await readPuzzleNoWrite(job, milestone, entry.seal);
    const path = join(job.stateDir, "interactive-items", match[1] + ".json");
    const source = JSON.parse(await readFile(path, "utf8")) as {
      planDigest?: string; units?: Array<{
        id: string; phase: string; commitSha?: string; beforeHead?: string;
        noWrite?: PuzzleNoWriteRef }>;
    };
    const choice = source.units?.[0], puzzle = source.units?.[1];
    if (proof.unitId !== entry.workItem || proof.choiceHead !== choice?.commitSha ||
        proof.verifiedHead !== puzzle?.beforeHead ||
        source.planDigest !== proof.planDigest ||
        puzzle?.phase !== "not-applicable" ||
        JSON.stringify(puzzle.noWrite) !== JSON.stringify(entry.seal) ||
        !isAncestor(job, proof.choiceHead, proof.verifiedHead) ||
        !isAncestor(job, proof.verifiedHead, head) ||
        !git(job, "log", "-1", "--format=%B", proof.choiceHead)
          .split("\n").includes("NovelTea-Work-Item: interactive-choice-" + match[1])) {
      throw new Error("Recovery Puzzle omission differs from its sealed Choice checkpoint.");
    }
    omissions.add(entry.workItem);
  }
  return omissions;
}
function verifiedBaselineStages(job: JobStartResult,
  plan: Awaited<ReturnType<typeof planFor>>, item: string) {
  const fork = readRecoveryFork(job);
  if (fork) return fork.checkpoint.completedWorkItems;
  if (!plan || item === "foundation") return [];
  const arch = plan.items.find(entry => entry.id === "global-architecture");
  if (arch?.status !== "verified" || arch.verifiedSha !== job.baseSha) return [];
  // The original author-created Story is already a verified foundation and
  // architecture; it may have no generator commit for either stage. Mark them
  // as a baseline handoff, never invent either Git commit.
  const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
  const files = git(job, "ls-tree", "-r", "--name-only", job.baseSha, "--",
    job.storyRelativePath || ".").split("\n");
  return files.some(path => path.startsWith(prefix + "creative-direction/") && path.endsWith(".md"))
    ? ["foundation", "global-architecture"] : [];
}
function verifyGit(job: JobStartResult, sha: string, parent: string, id: string,
  verifiedHead: string, checkedBranch = false) {
  if (!SHA.test(sha) || !SHA.test(parent) || !ITEM.test(id) ||
      git(job, "rev-parse", sha + "^{commit}") !== sha ||
      git(job, "rev-parse", sha + "^") !== parent) throw new Error("Recovery commit or parent SHA differs.");
  const trailers = git(job, "log", "-1", "--format=%B", sha).split("\n");
  if (!trailers.includes("NovelTea-Job: " + job.jobId) ||
      !trailers.includes("NovelTea-Work-Item: " + id))
    throw new Error("Git work-item commit provenance differs from the trusted receipt.");
  if ((!checkedBranch && git(job, "symbolic-ref", "--short", "HEAD") !== job.branch) ||
      !isAncestor(job, sha, verifiedHead))
    throw new Error("Recovery commit is not reachable on its original branch.");
  const changed = git(job, "diff-tree", "--no-commit-id", "--name-only", "-r", sha)
    .split("\n").filter(Boolean);
  const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
  if (!changed.length || changed.some(path => !path.startsWith(prefix) || path.slice(prefix.length).startsWith(".story-inbox/")))
    throw new Error("Recovery commit contains no authorized Story work-item files.");
}
async function readFinal(job: JobStartResult, sha: string): Promise<RecoveryCheckpoint> {
  const path = finalizedFile(job, sha);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error("Recovery record is not a regular file.");
  return JSON.parse(await readFile(path, "utf8")) as RecoveryCheckpoint;
}
async function verifyFinal(job: JobStartResult, point: RecoveryCheckpoint,
  inspectionHead?: string) {
  const parentGraphThread = await graphThread(job);
  // The exact-approved Chat Foundation is committed before the parent's first
  // generation queue admission. Its checkpoint was sealed with the original
  // pre-admission graph identity. A later :generation:web owner cannot rewrite
  // that historical receipt; allow only this source-bound whole-Story handoff.
  const preGraphFoundation = point.workItem === "foundation" &&
    point.graphThread === job.threadId + ":generation" &&
    parentGraphThread === job.threadId + ":generation:web";
  const approvedFoundation = preGraphFoundation ? await readChatApprovedFoundation(job) : null;
  const foundationReceipt = preGraphFoundation && existsSync(join(job.stateDir, "foundation.json"))
    ? JSON.parse(await readFile(join(job.stateDir, "foundation.json"), "utf8")) as {
      commitSha?: string; authoredSha256?: string; stage?: string
    } : null;
  const earlyChatFoundation = preGraphFoundation &&
    approvedFoundation?.scope === "whole-story" &&
    approvedFoundation.firstTurnId === job.jobId &&
    approvedFoundation.authoredSha256 === foundationReceipt?.authoredSha256 &&
    foundationReceipt.stage === "committed" &&
    foundationReceipt.commitSha === point.commitSha;
  if (point.version !== 1 || point.status !== "finalized" ||
      point.jobId !== job.jobId || point.repository !== job.gitRoot ||
      point.story !== job.storyRoot || point.storyRelativePath !== job.storyRelativePath ||
      point.branch !== job.branch || point.baseSha !== job.baseSha ||
      (point.graphThread !== parentGraphThread && !earlyChatFoundation) ||
      point.compatibility?.logicalSchema !== "noveltea-recovery/v1" ||
      point.compatibility.graphSchema !== "noveltea-generation/v1" ||
      point.validation?.validatorVersion !== job.validatorVersion ||
      !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(point.validation?.validatorVersion ?? "") ||
      point.provenance?.authorApprovals !== "source-bound-not-reusable" ||
      point.provenance.authorMessages !== "source-bound-not-reusable" ||
      point.stage !== stageOf(point.workItem) ||
      !point.completedWorkItems.includes(point.workItem) ||
      (point.nextWorkItem !== null && !point.remainingWorkItems.includes(point.nextWorkItem))) {
    throw new Error("Recovery checkpoint identity, compatibility, or continuation is invalid.");
  }
  const planned = workPlan(point.plan as Awaited<ReturnType<typeof planFor>>, point.workItem,
    point.completedWorkItems.filter(id => id.startsWith("repair-")));
  const completed = point.completedWorkItems;
  const omissions = await verifyOmissions(job, point.omittedWorkItems, point.commitSha);
  const remaining = planned.order.filter(id => !completed.includes(id) && !omissions.has(id));
  const next = remaining.find(id => (planned.dependencies[id] ?? []).every(
    dep => completed.includes(dep) || omissions.has(dep))) ?? null;
  if (!["passed", "unverified-empty-baseline"].includes(point.validation.status) ||
      point.planDigest !== (point.plan ? digest(point.plan) : null) ||
      !Array.isArray(completed) || new Set(completed).size !== completed.length ||
      completed.some(id => !planned.order.includes(id)) ||
      [...omissions].some(id => !planned.order.includes(id) || completed.includes(id)) ||
      JSON.stringify(point.dependencies) !== JSON.stringify(planned.dependencies) ||
      JSON.stringify(point.remainingWorkItems) !== JSON.stringify(remaining) ||
      point.nextWorkItem !== next) {
    throw new Error("Recovery continuation inventory or plan has been modified.");
  }
  // A Foundation correction can be committed and independently reviewed
  // before Architecture has authored any plan. The repair proof must bind it
  // to an actual previously finalized Foundation (not an arbitrary no-plan
  // specialist). Its own plan version is independently checked below against
  // the original controller-owned repair proof.
  let initialFoundationRepair = false;
  if (point.plan === null && point.workItem.startsWith("repair-")) {
    const proof = await readRepairCommitProof(job, point.workItem);
    const original = JSON.parse(await readFile(join(job.stateDir, "recovery-checkpoints",
      proof.sourceCommitSha + ".json"), "utf8")) as RecoveryCheckpoint;
    initialFoundationRepair = original.workItem === "foundation" && original.plan === null;
  }
  if (point.plan === null
    ? point.workItem !== "foundation" && !initialFoundationRepair
    : (point.plan as Plan).version !== point.planVersion)
    throw new Error("Recovery checkpoint plan version differs from its committed specialist.");
  const intent = await readIntent(job, point.commitSha);
  if (intent.parentSha !== point.parentSha || intent.workItem !== point.workItem ||
      intent.proofDigest !== point.proofDigest || intent.planDigest !== point.planDigest)
    throw new Error("Recovery checkpoint was not finalized from its original durable intent.");
  // Both the immutable commit intent and the controller-owned Architecture
  // receipt/history must authorize these *exact* plan bytes. Rehashing a
  // tampered checkpoint cannot change either independent source of evidence.
  if (point.plan !== null) {
    const authorized = await planFor(job, point.planDigest);
    if (digest(authorized) !== point.planDigest || digest(point.plan) !== digest(authorized))
      throw new Error("Checkpoint plan does not match original controller authorization.");
  }
  // A multi-checkpoint inspection establishes the verified HEAD and branch
  // before scanning, and rechecks both afterwards. Direct checks stay live.
  const verified = inspectionHead ?? await trustedHead(job);
  verifyGit(job, point.commitSha, point.parentSha, point.workItem, verified,
    inspectionHead !== undefined);
  // The completed inventory must reflect real prior commits, never a future
  // specialist invented in the checkpoint JSON. Unknown revision/inbox commits
  // do not become completed narrative work items.
  const historical = new Set(git(job, "log", "--format=%B%x00",
    job.baseSha + ".." + point.commitSha).split("\0").flatMap(message => {
      const lines = message.split("\n");
      if (!lines.includes("NovelTea-Job: " + job.jobId)) return [];
      const item = lines.find(line => line.startsWith("NovelTea-Work-Item: "))?.slice(20);
      return item && planned.order.includes(item) ? [item] : [];
    }));
  const synthetic = verifiedBaselineStages(job,
    point.plan as Awaited<ReturnType<typeof planFor>>, point.workItem);
  const recorded = completed.filter(id => !synthetic.includes(id));
  if (synthetic.some(id => !completed.includes(id)) ||
      JSON.stringify([...historical].sort()) !== JSON.stringify([...recorded].sort()))
    throw new Error("Completed recovery work items differ from the actual Git commit chain.");
  const source = await receiptProof(job, point.workItem, point.commitSha,
    intent.architectureProof ?? undefined);
  if (point.workItem === "global-architecture") {
    const plan = point.plan as Plan;
    const architecture = plan.items.find(item => item.id === "global-architecture");
    if (intent.architectureProof?.plan?.version !== plan.version ||
        !architecture ||
        digest(intent.architectureProof?.plan?.architecture) !== digest(architecture) ||
        architecture.verifiedSha !== point.commitSha)
      throw new Error("Historical Architecture proof differs from the authorized plan commit.");
  }
  const review = await inspectCheckpointReview(job, point);
  // An exact author-approved Foundation was finalized *before* Story Chat
  // created its Turn plan. Its immutable checkpoint correctly has no Turn
  // review-selection receipt. A later plan must not retroactively manufacture
  // an assurance or make that same historical commit unusable. Only the
  // independently verified original Chat handoff above permits this absence;
  // later specialist checkpoints still require their own original reviews.
  if (!review && !earlyChatFoundation && await checkpointAssurance(job, point))
    throw new Error("Turn checkpoint lacks its required original review-selection receipt.");
  if (point.planVersion !== (source.planVersion ?? (point.plan as { version?: number } | null)?.version ?? null) ||
      point.validation.status !== (source.proof.validation === "unverified-empty-baseline"
        ? "unverified-empty-baseline" : "passed") ||
      source.proof.validation?.validatorVersion &&
        source.proof.validation.validatorVersion !== point.validation.validatorVersion ||
      source.source !== point.source || source.proofDigest !== point.proofDigest ||
      source.snapshotId !== (point.snapshotId ?? undefined)) {
    throw new Error("Recovery checkpoint no longer matches its exact trusted specialist receipt.");
  }
}
function nonBranchable(job: JobStartResult, sha: string, reason: string): RecoveryInspection {
  return { version: 1, status: "finalized", jobId: job.jobId,
    repository: job.gitRoot, story: job.storyRoot, storyRelativePath: job.storyRelativePath,
    branch: job.branch, graphThread: job.threadId + ":generation", baseSha: job.baseSha,
    commitSha: sha, parentSha: "", workItem: "unknown", stage: "unknown",
    planVersion: null, planDigest: null, plan: null, completedWorkItems: [], remainingWorkItems: [],
    nextWorkItem: null, dependencies: {}, validation: { status: "not-verified", validatorVersion: "" },
    source: "", proofDigest: "", snapshotId: null,
    compatibility: { logicalSchema: "noveltea-recovery/v1", graphSchema: "noveltea-generation/v1" },
    provenance: { authorApprovals: "source-bound-not-reusable", authorMessages: "source-bound-not-reusable" },
    eligible: false, reason, semanticReview: "untracked" };
}
export async function inspectRecoveryCheckpoints(job: JobStartResult): Promise<RecoveryInspection[]> {
  if (!existsSync(dir(job))) return [];
  const files = (await readdir(dir(job))).filter(name => /^[a-f0-9]{40}\.json$/.test(name)).sort();
  const results: RecoveryInspection[] = [];
  // The sealed history may contain many immutable checkpoints. Check the
  // mutable HEAD/branch at both boundaries of a multi-point scan instead of
  // spawning two Git identity queries per checkpoint. Receipt and intent
  // bytes are still read and authenticated individually on every inspection.
  let head: string | undefined;
  let boundaryError: unknown;
  if (files.length > 2) {
    try {
      head = await trustedHead(job);
      if (git(job, "symbolic-ref", "--short", "HEAD") !== job.branch)
        throw new Error("Recovery inspection branch identity changed.");
    } catch (error) {
      boundaryError = error;
    }
  }
  for (const file of files) {
    try {
      if (boundaryError) throw boundaryError;
      const point = await readFinal(job, file.slice(0, 40));
      await verifyFinal(job, point, head);
      const review = point.assurance ? await inspectCheckpointReview(job, point) : null;
      results.push({ ...point, eligible: true, reason: null,
        semanticReview: review?.status ?? "untracked" });
    } catch (error) {
      // Inspectable, never branchable. Do not repair or trust a corrupt record
      // during an owner-scoped read, including a currently dirty specialist.
      results.push(nonBranchable(job, file.slice(0, 40), error instanceof Error ? error.message : String(error)));
    }
  }
  if (head !== undefined) {
    try {
      if (await trustedHead(job) !== head ||
          git(job, "symbolic-ref", "--short", "HEAD") !== job.branch)
        throw new Error("Recovery HEAD or branch moved during checkpoint inspection.");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      for (let i = 0; i < results.length; i++)
        results[i] = nonBranchable(job, results[i]!.commitSha, reason);
    }
  }
  for (const name of (await readdir(dir(job))).filter(n => /^[a-f0-9]{40}\.intent\.json$/.test(n))) {
    const sha = name.slice(0, 40);
    if (!files.includes(sha + ".json")) {
      results.push(nonBranchable(job, sha, "Commit finalization is incomplete; reconcile the original receipt."));
    }
  }
  return results.sort((a, b) => a.completedWorkItems.length - b.completedWorkItems.length);
}
/** Runs only under the existing writer lock. Repeating it never replays a Pi writer. */
export async function finalizeRecoveryCheckpoint(job: JobStartResult,
  workItem: string, parentSha: string, commitSha: string) {
  job = await startStoryJob({ story: job.storyRoot, job: job.jobId }, false);
  if (!job.validatorVersion || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(job.validatorVersion))
    throw new Error("Recovery checkpoint requires the pinned native validator identity.");
  // A Git commit plus a specialist JSON receipt is insufficient until the
  // original specialist has also published its trusted verified-head boundary.
  // Historical committed ancestors are valid after a later verified successor.
  const verified = await trustedHead(job);
  if (!isAncestor(job, commitSha, verified))
    throw new Error("Specialist commit is not within the published verified-head chain.");
  verifyGit(job, commitSha, parentSha, workItem, verified);
  const pending = intentFile(job, commitSha);
  // After a crash an approved replan may have replaced Architecture\x27s mutable
  // receipt. Recover only the original intent\x27s plan and commit evidence.
  const previousIntent = existsSync(pending) ? await readIntent(job, commitSha) : null;
  if (previousIntent && (previousIntent.parentSha !== parentSha || previousIntent.workItem !== workItem))
    throw new Error("Recovery intent conflicts with the original Git work item.");
  const plan = workItem === "foundation" ? null : await planFor(job, previousIntent?.planDigest);
  const receipt = await receiptProof(job, workItem, commitSha,
    previousIntent?.architectureProof ?? undefined);
  if (receipt.planVersion !== null && (!Number.isInteger(receipt.planVersion) || receipt.planVersion < 1))
    throw new Error("Recovery checkpoint has an invalid plan version.");
  const sourceProof = receipt.proof as Receipt;
  if (sourceProof.validation?.validatorVersion &&
      sourceProof.validation.validatorVersion !== job.validatorVersion)
    throw new Error("Specialist validation uses a different pinned validator.");
  const intent: RecoveryIntent = { version: 2, jobId: job.jobId, commitSha, parentSha, workItem,
    proofDigest: receipt.proofDigest, planDigest: plan ? digest(plan) : null,
    architectureProof: workItem === "global-architecture" ? sourceProof : null };
  if (previousIntent) {
    if (JSON.stringify(previousIntent) !== JSON.stringify(intent)) throw new Error("Recovery intent conflict.");
  } else await atomic(pending, intent);
  // Deterministic crash-boundary certification. Fixture receipts only; a live
  // Pi worker must never be interrupted by test fault injection.
  if (receipt.fixture && process.env.NT_RECOVERY_FIXTURE_CRASH_AFTER_INTENT === workItem)
    throw new Error("Injected recovery crash after Git commit and before checkpoint finalization.");
  if (existsSync(finalizedFile(job, commitSha))) {
    const point = await readFinal(job, commitSha);
    await verifyFinal(job, point);
    return point;
  }
  const previous = (await inspectRecoveryCheckpoints(job)).filter(p => p.eligible && p.commitSha !== commitSha &&
    isAncestor(job, p.commitSha, commitSha));
  const baseline = verifiedBaselineStages(job, plan, workItem);
  const history = [...baseline, ...previous.flatMap(p => p.completedWorkItems)];
  const work = workPlan(plan, workItem, history.filter(id => id.startsWith("repair-")));
  if (!work.order.includes(workItem))
    throw new Error("Work item does not belong to the authorized continuation plan.");
  const completed = [...new Set([...baseline,
    ...previous.flatMap(p => p.completedWorkItems).filter(id => work.order.includes(id)), workItem])];
  const omissions = previous.flatMap(p => p.omittedWorkItems ?? []);
  if (workItem.startsWith("composition-")) {
    const slug = workItem.slice("composition-".length);
    const source = JSON.parse(await readFile(
      join(job.stateDir, "interactive-items", slug + ".json"), "utf8")) as {
      units?: Array<{ phase?: string; noWrite?: PuzzleNoWriteRef }> };
    if (source.units?.[1]?.phase === "not-applicable") {
      if (!source.units[1].noWrite) throw new Error("Composition omitted Puzzle without a controller seal.");
      omissions.push({ workItem: "interactive-puzzle-" + slug, seal: source.units[1].noWrite });
    }
  }
  const unique = [...new Map(omissions.map(entry => [entry.workItem, entry])).values()];
  if (unique.length !== omissions.length)
    throw new Error("Recovery attempted to duplicate an optional Puzzle no-write decision.");
  const omitted = await verifyOmissions(job, unique, commitSha);
  const remaining = work.order.filter(id => !completed.includes(id) && !omitted.has(id));
  const next = remaining.find(id => (work.dependencies[id] ?? []).every(dep =>
    completed.includes(dep) || omitted.has(dep))) ?? null;
  const point: RecoveryCheckpoint = {
    version: 1, status: "finalized", jobId: job.jobId, repository: job.gitRoot, story: job.storyRoot,
    storyRelativePath: job.storyRelativePath, branch: job.branch,
    graphThread: await graphThread(job), baseSha: job.baseSha,
    commitSha, parentSha, workItem, stage: stageOf(workItem),
    planVersion: receipt.planVersion ?? plan?.version ?? null,
    planDigest: plan ? digest(plan) : null, plan,
    completedWorkItems: completed, remainingWorkItems: remaining,
    ...(unique.length ? { omittedWorkItems: unique } : {}),
    nextWorkItem: next, dependencies: work.dependencies,
    validation: { status: sourceProof.validation === "unverified-empty-baseline"
      ? "unverified-empty-baseline" : "passed", validatorVersion: job.validatorVersion },
    source: receipt.source, proofDigest: receipt.proofDigest, snapshotId: receipt.snapshotId ?? null,
    compatibility: { logicalSchema: "noveltea-recovery/v1", graphSchema: "noveltea-generation/v1" },
    provenance: { authorApprovals: "source-bound-not-reusable", authorMessages: "source-bound-not-reusable" },
  };
  point.assurance = await checkpointAssurance(job, point);
  await atomic(finalizedFile(job, commitSha), point);
  await verifyFinal(job, point);
  return point;
}
/** Crash repair consults persisted specialist receipts, not a writer or a live graph. */
export async function reconcileRecoveryCheckpoints(job: JobStartResult) {
  const commits = git(job, "rev-list", "--reverse", job.baseSha + "..HEAD").split("\n").filter(Boolean);
  for (const sha of commits) {
    const trailers = git(job, "log", "-1", "--format=%B", sha).split("\n");
    const item = trailers.find(t => t.startsWith("NovelTea-Work-Item: "))?.slice(20);
    if (!item || !ITEM.test(item)) continue;
    try {
      const parent = git(job, "rev-parse", sha + "^");
      await finalizeRecoveryCheckpoint(job, item, parent, sha);
    } catch {
      // A missing, incomplete or unverified specialist receipt is not a
      // recoverable checkpoint; other already-finalized points remain readable.
    }
  }
  return inspectRecoveryCheckpoints(job);
}
