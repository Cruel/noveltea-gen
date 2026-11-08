import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { startStoryJob, type JobStartResult } from "./job.js";
import { withStoryJobLock } from "./job-lock.js";
import { inspectRecoveryCheckpoints, type RecoveryCheckpoint } from "./recovery-checkpoints.js";
import { validateStoryJob } from "./validator.js";
import { hasPlanContinuity } from "./plan-continuity.js";
import { assertRecoveryCompatibility, assertRecoveryReceiptCompatibility,
  selectCurrentRecoveryToolchain, RecoveryCompatibilityError } from "./recovery-compatibility.js";
import type { Plan, CompletionContract } from "./architecture.js";
import type { GenerationEvidence } from "./generation-plan.js";
import { forkDigest, readRecoveryFork, type RecoveryForkBundle, type SpecialistReceipt } from "./recovery-fork-state.js";

function git(job: JobStartResult, ...args: string[]) {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[key];
  return execFileSync("git", args, { cwd: job.worktreeRoot, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function cleanEvidence(value: any): any {
  if (Array.isArray(value)) return value.map(cleanEvidence);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/session|authorChoice|approval|signed|proposal|handoff|discovery/i.test(key))
    .map(([key, item]) => [key, cleanEvidence(item)]));
  return value;
}
function stage(id: string): Pick<GenerationEvidence, "stage" | "milestone"> | null {
  if (id === "foundation") return { stage: "foundation" };
  if (id === "global-architecture") return { stage: "architecture" };
  if (id === "character-foundations") return { stage: "foundations" };
  if (id.startsWith("event-")) return { stage: "event", milestone: "milestone." + id.slice(6) };
  if (id.startsWith("interactive-puzzle-")) return { stage: "interactive", milestone: "milestone." + id.slice(19) };
  if (id.startsWith("composition-")) return { stage: "composition", milestone: "milestone." + id.slice(12) };
  if (id.startsWith("focus:")) return { stage: "focus", milestone: id.slice(6) };
  return null;
}
const receiptStage = (path: string) => path === "character-world.json" ? "foundations" :
  path.startsWith("event-items/") ? "event:milestone." + path.slice(12, -5) :
  path.startsWith("interactive-items/") ? "interactive:milestone." + path.slice(18, -5) :
  path.startsWith("composition-items/") ? "composition:milestone." + path.slice(18, -5) : null;

/** Read-only preflight. Call before acquiring/allocating any child resources.
 * Mutable parent SQLite, unfinished receipts, sessions and grants are excluded. */
export async function collectRecoveryFork(parent: JobStartResult, childId: string,
  commitSha: string, contract: CompletionContract, skillsSource?: string): Promise<RecoveryForkBundle> {
  if (!/^[a-f0-9]{40}$/.test(commitSha) || childId === parent.jobId)
    throw new Error("Select a finalized checkpoint and a different child job identity.");
  const points = await inspectRecoveryCheckpoints(parent);
  const selected = points.find(p => p.commitSha === commitSha && p.eligible);
  if (!selected) throw new RecoveryCompatibilityError("invalid-evidence",
    "Checkpoint is not finalized and independently verified.");
  assertRecoveryCompatibility(selected);
  const { eligible: _eligible, reason: _reason, semanticReview: _semanticReview, ...checkpoint } = selected;
  const inherited = readRecoveryFork(parent);
  // Each source reviewer decision is resolved exactly at fork admission. The
  // child retains that versioned status and cannot inherit a later pass.
  const previousCoverage = inherited?.reviewCoverage ?? [];
  const currentCoverage = points.filter(p => p.eligible && p.assurance && (() => {
    try { git(parent, "merge-base", "--is-ancestor", p.commitSha, commitSha); return true; }
    catch { return false; }
  })()).map(p => ({ workItem: p.workItem, commitSha: p.commitSha,
    status: p.semanticReview === "untracked" ? "required-pending" as const : p.semanticReview }));
  const reviewCoverage = [...new Map([...previousCoverage, ...currentCoverage]
    .map(entry => [entry.commitSha, entry])).values()];
  const plan = checkpoint.plan as Plan | null;
  const completed = new Set(checkpoint.completedWorkItems);
  const receipts: RecoveryForkBundle["receipts"] = {};
  const commits: RecoveryForkBundle["commits"] = {};
  for (const id of completed) {
    const point = points.find(p => p.eligible && p.workItem === id && (() => {
      try { git(parent, "merge-base", "--is-ancestor", p.commitSha, commitSha); return true; } catch { return false; }
    })());
    const prior = inherited?.commits[id];
    if (!point && !prior) {
      // A focused/adopted architecture baseline has no generated commit.
      if (["foundation", "global-architecture"].includes(id) && plan?.items.some(i =>
        i.id === "global-architecture" && i.status === "verified" && i.verifiedSha === parent.baseSha)) continue;
      throw new RecoveryCompatibilityError("invalid-evidence",
        "A completed work item has no independently finalized historical proof.");
    }
    const source = point?.source ?? Object.keys(inherited!.receipts).find(path => {
      const receipt = inherited!.receipts[path]!;
      return receipt.units?.some((unit: SpecialistReceipt) => unit.id === id) || receipt.workItemId === id ||
        path === "foundation.json" && id === "foundation" || path === "architecture.json" && id === "global-architecture";
    });
    if (!source) throw new RecoveryCompatibilityError("invalid-evidence",
      "Inherited work has no matching historical specialist receipt.");
    let receipt: SpecialistReceipt;
    try { receipt = JSON.parse(await readFile(join(parent.stateDir, source), "utf8")) as SpecialistReceipt; }
    catch { throw new RecoveryCompatibilityError("invalid-evidence",
      "The historical specialist receipt is missing or cannot be read."); }
    if (receipt.jobId !== parent.jobId) throw new RecoveryCompatibilityError("invalid-evidence",
      "The historical specialist receipt belongs to a different job.");
    // The finalized source checkpoint binds the old skill digest to the
    // authenticated receipt. Reopening the historical skill *files* is not
    // necessary: only the child must have a verified current snapshot.
    if (point && receipt.snapshot?.id !== point.snapshotId)
      throw new RecoveryCompatibilityError("invalid-evidence",
        "Historical specialist skill identity differs from the finalized checkpoint.");
    receipts[source] = cleanEvidence(receipt);
    commits[id] = prior && !point ? prior : { sha: point!.commitSha,
      jobId: parent.jobId, planVersion: point!.planVersion };
  }
  // Keep only the approved plan at the fork boundary, not a later replan and
  // not its job-scoped signed approvals. This is the child's accepted baseline.
  if (plan) {
    const original = JSON.parse(await readFile(join(parent.stateDir, "architecture.json"), "utf8")) as SpecialistReceipt;
    const historical = { ...original, plan, history: original.history.filter((h: SpecialistReceipt) => h.plan.version < plan.version) };
    for (const [path, receipt] of Object.entries(receipts)) {
      const key = receiptStage(path);
      if (key && !hasPlanContinuity(parent, historical as any, key, receipt.planVersion,
        receipt.contractDigest ?? receipt.planDigest, !!receipt.contractDigest))
        throw new RecoveryCompatibilityError("obsolete-checkpoint",
          "Historical work is not authorized by the approved continuation plan.");
    }
    const architecture = plan.items.find(i => i.id === "global-architecture");
    if (!architecture?.verifiedSha) throw new RecoveryCompatibilityError("invalid-evidence",
      "The historical plan lacks verified architecture evidence.");
    receipts["architecture.json"] = { ...cleanEvidence(original), plan, history: [], phase: "committed",
      expectedHead: architecture.verifiedSha, executionHead: commitSha };
    delete receipts["architecture.json"]!.manuallyReconciled;
  }
  for (const receipt of Object.values(receipts)) {
    if (receipt.units) receipt.units = receipt.units.map((unit: SpecialistReceipt) =>
      completed.has(unit.id) ? unit : { id: unit.id, domain: unit.domain, phase: "pending" });
  }
  for (const [source, receipt] of Object.entries(receipts))
    assertRecoveryReceiptCompatibility(source, receipt, completed);
  const completedStages: GenerationEvidence[] = [];
  for (const id of completed) {
    const item = stage(id);
    if (item) completedStages.push({ ...item, headSha: commits[id]?.sha ?? parent.baseSha,
      status: "committed", planVersion: plan?.version });
  }
  const toolchain = await selectCurrentRecoveryToolchain(parent, checkpoint, skillsSource);
  return { version: 2, toolchain, sourceJobId: parent.jobId, sourceBaseSha: parent.baseSha,
    storyRoot: parent.storyRoot, childId, checkpoint: checkpoint as RecoveryCheckpoint,
    reviewCoverage, contract: plan?.contract ?? contract, receipts, commits, completedStages };
}
async function writeOnce(path: string, value: string) {
  if (existsSync(path)) {
    if (await readFile(path, "utf8") !== value) throw new Error("Partial fork artifact conflicts; preserve it for reconciliation.");
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, { flag: "wx", mode: 0o600 });
}
/** Caller owns repository Git/cache admission. Only the child's writer lock is
 * taken, so a running parent remains untouched. Retries never reset a child. */
export async function prepareRecoveryFork(parent: JobStartResult, bundle: RecoveryForkBundle) {
  const pin = { sourceJobId: bundle.sourceJobId, sourceBaseSha: bundle.sourceBaseSha,
    commitSha: bundle.checkpoint.commitSha, bundleSha256: forkDigest(bundle) };
  const child = await startStoryJob({ story: parent.storyRoot, job: bundle.childId,
    pinnedBaseSha: pin.commitSha, recoveryFork: pin, worktreeCacheRoot: parent.cacheRoot,
    sparseStoryOnly: !!parent.cacheRoot });
  return withStoryJobLock(child, "checkpoint-fork-prepare", async () => {
    if (existsSync(join(child.stateDir, "recovery-fork-ready"))) { readRecoveryFork(child); return child; }
    if (child.headSha !== child.baseSha || git(child, "status", "--porcelain"))
      throw new Error("Incomplete fork worktree changed; preserve it for reconciliation.");
    await writeOnce(join(child.stateDir, "recovery-fork.json"), JSON.stringify(bundle, null, 2) + "\n");
    for (const [path, original] of Object.entries(bundle.receipts)) {
      // The sealed source bundle retains historical proofs. A child uses its
      // freshly pinned skills for future work; old writer sessions are not reused.
      const receipt = { ...original, jobId: child.jobId, baseSha: child.baseSha,
        branch: child.branch, worktreeRoot: child.worktreeRoot, threadId: child.threadId,
        ...(original.snapshot ? { snapshot: bundle.toolchain.skills } : {}) };
      await writeOnce(join(child.stateDir, path), JSON.stringify(receipt, null, 2) + "\n");
    }
    await writeOnce(join(child.stateDir, "revisions/verified-head.json"), JSON.stringify({
      version: 1, jobId: child.jobId, headSha: child.baseSha, workItemId: "inherited-checkpoint",
    }, null, 2) + "\n");
    const validation = await validateStoryJob(child);
    const report = validation.report as { protection?: { status?: string; changes?: unknown[]; warnings?: unknown[] };
      contractRevision?: unknown; readiness?: { contractRevision?: unknown } } | undefined;
    if (validation.validator.version !== bundle.toolchain.validator.version ||
        validation.validator.implementation !== "native-cli")
      throw new RecoveryCompatibilityError("changed-tooling",
        "The installed native CLI changed during fork preparation.");
    if (validation.status !== "passed" || !report || !report.contractRevision ||
        report.readiness?.contractRevision !== report.contractRevision ||
        report.protection?.status !== "checked" ||
        report.protection.changes?.length || report.protection.warnings?.length)
      throw new RecoveryCompatibilityError("incompatible-story",
        "The selected historical Story is not compatible with current native validation and protection.");
    await writeOnce(join(child.stateDir, "recovery-fork-ready"), pin.bundleSha256 + "\n");
    return startStoryJob({ story: child.storyRoot, job: child.jobId }, false);
  });
}
