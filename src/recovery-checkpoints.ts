import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { startStoryJob, type JobStartResult } from "./job.js";
import { trustedHead } from "./revision.js";

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
    const evidence = item.validation as { validatorSha256?: string; status?: string;
      branchReview?: { status?: string } } | undefined;
    if (id.startsWith("focus:")) {
      if (!HASH.test(item.sha256 ?? "")) throw new Error("Focused work lacks its pinned content digest.");
    } else if (!evidence || (evidence.status !== "passed" &&
        evidence.branchReview?.status !== "passed" &&
        !(id.startsWith("interactive-") && ("choices" in evidence || "puzzles" in evidence)))) {
      throw new Error("Committed specialist lacks passing validation evidence.");
    }
  }
  return item;
}
async function receiptProof(job: JobStartResult, id: string, sha: string) {
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
  const proof = proofOf(id, receipt, sha);
  const expectedPaths = (id === "foundation" ? [receipt.target] :
    id === "global-architecture" ? receipt.paths : proof.paths) as unknown;
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
    id === "global-architecture" ? ["NovelTea-Architecture", receipt.contentDigest] :
    id.endsWith("-foundations") ? ["NovelTea-Foundations", proof.digest] :
    id.startsWith("event-") ? ["NovelTea-Event-Design", receipt.contentDigest] :
    id.startsWith("interactive-") ? ["NovelTea-Interactive", proof.digest] :
    id.startsWith("composition-") ? ["NovelTea-Composition", receipt.digest] :
    ["NovelTea-Focused-Digest", receipt.sha256];
  if (!HASH.test(trailer[1] ?? "") || !commitMessage.includes(trailer.join(": ")))
    throw new Error("Specialist content digest differs from the original Git commit.");
  if (id === "foundation" &&
      !commitMessage.includes("NovelTea-Validation: " + proof.validation))
    throw new Error("Foundation validation trailer differs from the verified receipt.");
  return { source: source.path, proofDigest: digest(proof), proof,
    fixture: receipt.worker === "fixture" || receipt.workerMode === "fixture",
    snapshotId: receipt.snapshot?.id as string | undefined,
    planVersion: (receipt.planVersion ?? receipt.plan?.version ?? null) as number | null };
}
export interface RecoveryCheckpoint {
  version: 1;
  status: "finalized";
  jobId: string; repository: string; story: string; storyRelativePath: string;
  branch: string; graphThread: string; baseSha: string; commitSha: string; parentSha: string;
  workItem: string; stage: string; planVersion: number | null;
  planDigest: string | null; plan: unknown;
  completedWorkItems: string[]; remainingWorkItems: string[];
  nextWorkItem: string | null; dependencies: Record<string, string[]>;
  validation: { status: "passed" | "unverified-empty-baseline"; validatorSha256: string };
  source: string; proofDigest: string; snapshotId: string | null;
  compatibility: { logicalSchema: "noveltea-recovery/v1"; graphSchema: "noveltea-generation/v1" };
  /** Context references, never transferable approval grants. */
  provenance: { authorApprovals: "source-bound-not-reusable"; authorMessages: "source-bound-not-reusable" };
}
export type RecoveryInspection = RecoveryCheckpoint & { eligible: boolean; reason: string | null };
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
  if (id.startsWith("focus:")) return "focus";
  throw new Error("Unsupported recovery stage.");
}
async function planFor(job: JobStartResult) {
  const path = join(job.stateDir, "architecture.json");
  if (!existsSync(path)) return null;
  const receipt = JSON.parse(await readFile(path, "utf8")) as Receipt;
  if (receipt.jobId !== job.jobId || !receipt.plan || !Number.isInteger(receipt.plan.version))
    throw new Error("No verified architecture plan is available for continuation.");
  return receipt.plan as { version: number; contract: { scope: {
    depth?: string; kind: string; targets: string[] } }; items: Array<{ id: string; dependencies: string[]; targetIds: string[];
      status?: string; verifiedSha?: string }> };
}
function workPlan(plan: Awaited<ReturnType<typeof planFor>>, committedItem: string): { order: string[]; dependencies: Record<string,string[]> } {
  const order = ["foundation", "global-architecture"];
  const deps: Record<string, string[]> = { foundation: [], "global-architecture": ["foundation"] };
  if (!plan) return { order, dependencies: deps };
  const add = (id: string, dependency: string[]) => {
    if (order.includes(id)) return;
    order.push(id); deps[id] = dependency;
  };
  // A direct specialist command may legitimately extend an architecture-only
  // job. It does not silently upgrade the author-approved parent contract.
  // The recovery inventory extends just far enough to represent that work.
  const stageRank: Record<string, number> = {
    architecture: 0, foundations: 1, event: 2, interactive: 3, composition: 4,
  };
  const requested = stageRank[stageOf(committedItem)] ?? 0;
  const approved = stageRank[plan.contract.scope.depth ?? "composition"] ?? 4;
  const depth = Math.max(approved, requested);
  if (plan.items.some(i => i.id.startsWith("focus-"))) {
    for (const target of plan.contract.scope.targets) add("focus:" + target, ["global-architecture"]);
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
    const planItems = plan.items.filter(i => i.targetIds.includes(milestone));
    const otherMilestoneDeps = planItems.flatMap(i => i.dependencies ?? [])
      .flatMap(dep => plan.items.find(i => i.id === dep)?.targetIds ?? [])
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
function verifiedBaselineStages(job: JobStartResult,
  plan: Awaited<ReturnType<typeof planFor>>, item: string) {
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
function verifyGit(job: JobStartResult, sha: string, parent: string, id: string) {
  if (!SHA.test(sha) || !SHA.test(parent) || !ITEM.test(id) ||
      git(job, "rev-parse", sha + "^{commit}") !== sha ||
      git(job, "rev-parse", sha + "^") !== parent) throw new Error("Recovery commit or parent SHA differs.");
  const trailers = git(job, "log", "-1", "--format=%B", sha).split("\n");
  if (!trailers.includes("NovelTea-Job: " + job.jobId) ||
      !trailers.includes("NovelTea-Work-Item: " + id))
    throw new Error("Git work-item commit provenance differs from the trusted receipt.");
  if (git(job, "symbolic-ref", "--short", "HEAD") !== job.branch ||
      !isAncestor(job, sha, "HEAD"))
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
async function verifyFinal(job: JobStartResult, point: RecoveryCheckpoint) {
  if (point.version !== 1 || point.status !== "finalized" ||
      point.jobId !== job.jobId || point.repository !== job.gitRoot ||
      point.story !== job.storyRoot || point.storyRelativePath !== job.storyRelativePath ||
      point.branch !== job.branch || point.baseSha !== job.baseSha ||
      point.graphThread !== await graphThread(job) ||
      point.compatibility?.logicalSchema !== "noveltea-recovery/v1" ||
      point.compatibility.graphSchema !== "noveltea-generation/v1" ||
      point.validation?.validatorSha256 !== job.validatorSha256 ||
      !HASH.test(point.validation?.validatorSha256 ?? "") ||
      point.provenance?.authorApprovals !== "source-bound-not-reusable" ||
      point.provenance.authorMessages !== "source-bound-not-reusable" ||
      point.stage !== stageOf(point.workItem) ||
      !point.completedWorkItems.includes(point.workItem) ||
      (point.nextWorkItem !== null && !point.remainingWorkItems.includes(point.nextWorkItem))) {
    throw new Error("Recovery checkpoint identity, compatibility, or continuation is invalid.");
  }
  const planned = workPlan(point.plan as Awaited<ReturnType<typeof planFor>>, point.workItem);
  const completed = point.completedWorkItems;
  if (point.planDigest !== (point.plan ? digest(point.plan) : null) ||
      !Array.isArray(completed) || new Set(completed).size !== completed.length ||
      completed.some(id => !planned.order.includes(id)) ||
      JSON.stringify(point.dependencies) !== JSON.stringify(planned.dependencies) ||
      JSON.stringify(point.remainingWorkItems) !== JSON.stringify(
        planned.order.filter(id => !completed.includes(id))) ||
      point.nextWorkItem !== (planned.order.filter(id => !completed.includes(id))
        .find(id => (planned.dependencies[id] ?? []).every(dep => completed.includes(dep))) ?? null)) {
    throw new Error("Recovery continuation inventory or plan has been modified.");
  }
  if (point.workItem === "foundation" ? point.plan !== null : point.plan === null)
    throw new Error("Recovery checkpoint has an invalid stage-specific plan snapshot.");
  const intentPath = intentFile(job, point.commitSha);
  const intentStat = await lstat(intentPath);
  if (!intentStat.isFile() || intentStat.isSymbolicLink())
    throw new Error("Recovery checkpoint intent is not a trusted file.");
  const intent = JSON.parse(await readFile(intentPath, "utf8"));
  const expectedIntent = { version: 1, jobId: job.jobId, commitSha: point.commitSha,
    parentSha: point.parentSha, workItem: point.workItem, proofDigest: point.proofDigest };
  if (JSON.stringify(intent) !== JSON.stringify(expectedIntent))
    throw new Error("Recovery checkpoint was not finalized from its original durable intent.");
  verifyGit(job, point.commitSha, point.parentSha, point.workItem);
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
  const source = await receiptProof(job, point.workItem, point.commitSha);
  if (point.planVersion !== (source.planVersion ?? (point.plan as { version?: number } | null)?.version ?? null) ||
      point.validation.status !== (source.proof.validation === "unverified-empty-baseline"
        ? "unverified-empty-baseline" : "passed") ||
      source.proof.validation?.validatorSha256 &&
        source.proof.validation.validatorSha256 !== point.validation.validatorSha256 ||
      source.source !== point.source || source.proofDigest !== point.proofDigest ||
      source.snapshotId !== (point.snapshotId ?? undefined)) {
    throw new Error("Recovery checkpoint no longer matches its exact trusted specialist receipt.");
  }
}
export async function inspectRecoveryCheckpoints(job: JobStartResult): Promise<RecoveryInspection[]> {
  if (!existsSync(dir(job))) return [];
  const files = (await readdir(dir(job))).filter(name => /^[a-f0-9]{40}\.json$/.test(name)).sort();
  const results: RecoveryInspection[] = [];
  for (const file of files) {
    try {
      const point = await readFinal(job, file.slice(0, 40));
      await verifyFinal(job, point);
      results.push({ ...point, eligible: true, reason: null });
    } catch (error) {
      // Inspectable, never branchable. Do not repair or trust a corrupt record
      // during an owner-scoped read, including a currently dirty specialist.
      results.push({ version: 1, status: "finalized", jobId: job.jobId,
        repository: job.gitRoot, story: job.storyRoot, storyRelativePath: job.storyRelativePath,
        branch: job.branch, graphThread: job.threadId + ":generation", baseSha: job.baseSha,
        commitSha: file.slice(0, 40), parentSha: "", workItem: "unknown", stage: "unknown",
        planVersion: null, planDigest: null, plan: null, completedWorkItems: [], remainingWorkItems: [],
        nextWorkItem: null, dependencies: {}, validation: { status: "passed", validatorSha256: "" },
        source: "", proofDigest: "", snapshotId: null,
        compatibility: { logicalSchema: "noveltea-recovery/v1", graphSchema: "noveltea-generation/v1" },
        provenance: { authorApprovals: "source-bound-not-reusable", authorMessages: "source-bound-not-reusable" },
        eligible: false, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const name of (await readdir(dir(job))).filter(n => /^[a-f0-9]{40}\.intent\.json$/.test(n))) {
    const sha = name.slice(0, 40);
    if (!files.includes(sha + ".json")) {
      results.push({ version: 1, status: "finalized", jobId: job.jobId,
        repository: job.gitRoot, story: job.storyRoot, storyRelativePath: job.storyRelativePath,
        branch: job.branch, graphThread: job.threadId + ":generation", baseSha: job.baseSha,
        commitSha: sha, parentSha: "", workItem: "unknown", stage: "unknown",
        planVersion: null, planDigest: null, plan: null, completedWorkItems: [], remainingWorkItems: [],
        nextWorkItem: null, dependencies: {}, validation: { status: "passed", validatorSha256: "" },
        source: "", proofDigest: "", snapshotId: null,
        compatibility: { logicalSchema: "noveltea-recovery/v1", graphSchema: "noveltea-generation/v1" },
        provenance: { authorApprovals: "source-bound-not-reusable", authorMessages: "source-bound-not-reusable" },
        eligible: false, reason: "Commit finalization is incomplete; reconcile the original receipt." });
    }
  }
  return results.sort((a, b) => a.completedWorkItems.length - b.completedWorkItems.length);
}
/** Runs only under the existing writer lock. Repeating it never replays a Pi writer. */
export async function finalizeRecoveryCheckpoint(job: JobStartResult,
  workItem: string, parentSha: string, commitSha: string) {
  job = await startStoryJob({ story: job.storyRoot, job: job.jobId }, false);
  if (!job.validatorSha256 || !HASH.test(job.validatorSha256))
    throw new Error("Recovery checkpoint requires the pinned native validator identity.");
  // A Git commit plus a specialist JSON receipt is insufficient until the
  // original specialist has also published its trusted verified-head boundary.
  // Historical committed ancestors are valid after a later verified successor.
  const verified = await trustedHead(job);
  if (!isAncestor(job, commitSha, verified))
    throw new Error("Specialist commit is not within the published verified-head chain.");
  verifyGit(job, commitSha, parentSha, workItem);
  const receipt = await receiptProof(job, workItem, commitSha);
  if (receipt.planVersion !== null && (!Number.isInteger(receipt.planVersion) || receipt.planVersion < 1))
    throw new Error("Recovery checkpoint has an invalid plan version.");
  const sourceProof = receipt.proof as Receipt;
  if (sourceProof.validation?.validatorSha256 &&
      sourceProof.validation.validatorSha256 !== job.validatorSha256)
    throw new Error("Specialist validation uses a different pinned validator.");
  const intent = { version: 1, jobId: job.jobId, commitSha, parentSha, workItem, proofDigest: receipt.proofDigest };
  const pending = intentFile(job, commitSha);
  if (existsSync(pending)) {
    const old = JSON.parse(await readFile(pending, "utf8"));
    if (JSON.stringify(old) !== JSON.stringify(intent)) throw new Error("Recovery intent conflict.");
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
  const plan = workItem === "foundation" ? null : await planFor(job);
  const work = workPlan(plan, workItem);
  if (!work.order.includes(workItem))
    throw new Error("Work item does not belong to the authorized continuation plan.");
  const previous = (await inspectRecoveryCheckpoints(job)).filter(p => p.eligible && p.commitSha !== commitSha &&
    isAncestor(job, p.commitSha, commitSha));
  const completed = [...new Set([...verifiedBaselineStages(job, plan, workItem),
    ...previous.flatMap(p => p.completedWorkItems), workItem])];
  const remaining = work.order.filter(id => !completed.includes(id));
  const next = remaining.find(id => (work.dependencies[id] ?? []).every(dep => completed.includes(dep))) ?? null;
  const point: RecoveryCheckpoint = {
    version: 1, status: "finalized", jobId: job.jobId, repository: job.gitRoot, story: job.storyRoot,
    storyRelativePath: job.storyRelativePath, branch: job.branch,
    graphThread: await graphThread(job), baseSha: job.baseSha,
    commitSha, parentSha, workItem, stage: stageOf(workItem),
    planVersion: receipt.planVersion ?? plan?.version ?? null,
    planDigest: plan ? digest(plan) : null, plan,
    completedWorkItems: completed, remainingWorkItems: remaining,
    nextWorkItem: next, dependencies: work.dependencies,
    validation: { status: sourceProof.validation === "unverified-empty-baseline"
      ? "unverified-empty-baseline" : "passed", validatorSha256: job.validatorSha256 },
    source: receipt.source, proofDigest: receipt.proofDigest, snapshotId: receipt.snapshotId ?? null,
    compatibility: { logicalSchema: "noveltea-recovery/v1", graphSchema: "noveltea-generation/v1" },
    provenance: { authorApprovals: "source-bound-not-reusable", authorMessages: "source-bound-not-reusable" },
  };
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
