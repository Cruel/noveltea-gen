import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { startStoryJob, type JobStartResult } from "./job.js";
import { withStoryJobLock } from "./job-lock.js";
import { trustedHead } from "./revision.js";
import { inspectRecoveryCheckpoints, type RecoveryCheckpoint } from "./recovery-checkpoints.js";
import { validateStoryJob } from "./validator.js";
import { projectReviewTurn, readReviewTurnEvidence } from "./fork-review-turn.js";
import { collectReviewedOmissionBatch, verifySavedReviewBatch } from "./recovery-review-batch.js";
import { readAdaptiveState, assertAdaptiveSettled } from "./adaptive-state.js";
import { hasPlanContinuity } from "./plan-continuity.js";
import { eventCompletionDigest } from "./event-work.js";
import { collectInheritedMilestoneBlueprint } from "./milestone-blueprint.js";
import { assertRecoveryCompatibility, assertRecoveryReceiptCompatibility,
  selectCurrentRecoveryToolchain, RecoveryCompatibilityError } from "./recovery-compatibility.js";
import type { Plan, CompletionContract } from "./architecture.js";
import type { GenerationEvidence } from "./generation-plan.js";
import { forkDigest, readRecoveryFork, resolvedInheritedRecoveryReviews, type RecoveryForkBundle, type SpecialistReceipt } from "./recovery-fork-state.js";

function git(job: JobStartResult, ...args: string[]) {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[key];
  return execFileSync("git", args, { cwd: job.worktreeRoot, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
/** Authenticate the original Event completion before child allocation. The
 * new execution's snapshot is not evidence about an inherited commit. */
export function assertInheritedEventCompletion(job: JobStartResult, receipt: SpecialistReceipt) {
  const head = receipt.commitSha;
  const state = receipt.validation;
  if (!head || !state || state.status !== "passed" || !receipt.snapshot?.id ||
      !receipt.contentDigest || !receipt.expectedHead || !Array.isArray(receipt.obligations))
    throw new RecoveryCompatibilityError("invalid-evidence", "Inherited Event lacks its original completion evidence.");
  if (state.milestoneState && (git(job, "rev-parse", head + "^") !== receipt.expectedHead ||
      !git(job, "log", "-1", "--format=%B", head).split("\n").includes("NovelTea-Event-Completion: " +
        eventCompletionDigest({ milestoneId: receipt.milestoneId, expectedHead: receipt.expectedHead,
          snapshotId: receipt.snapshot.id, contentDigest: receipt.contentDigest, eventIds: state.eventIds,
          milestoneState: state.milestoneState, obligations: receipt.obligations }))))
    throw new RecoveryCompatibilityError("invalid-evidence", "Inherited Event completion differs from its original sealed commit.");
}
function cleanEvidence(value: any): any {
  if (Array.isArray(value)) return value.map(cleanEvidence);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/session|authorChoice|approval|signed|proposal|handoff|discovery|^blueprint(?:Task)?$/i.test(key))
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

/** A new Thread cannot import an admitted adaptive assignment inventory using
 * a v2 bundle that carries only original Architecture and historical writers.
 * A checkpoint from before amendment admission is still independently reusable. */
export async function assertAdaptiveForkBoundary(parent: JobStartResult, commitSha: string) {
  if (!existsSync(join(parent.stateDir, "adaptive-plan.json"))) return;
  const reviewTurn = await readReviewTurnEvidence(parent);
  const sourcePlan = JSON.parse(await readFile(join(parent.stateDir, "architecture.json"),
    "utf8")) as { plan?: Plan };
  if (!reviewTurn || !sourcePlan.plan)
    throw new RecoveryCompatibilityError("invalid-evidence",
      "Fork source lost the original Turn/Architecture authority for adaptive work.");
  const adaptive = await readAdaptiveState(parent, reviewTurn.digest, sourcePlan.plan.version);
  if (!adaptive) throw new RecoveryCompatibilityError("invalid-evidence",
    "Fork source has missing adaptive plan provenance.");
  assertAdaptiveSettled(adaptive);
  for (const amendment of adaptive.entries) {
    try { git(parent, "merge-base", "--is-ancestor", amendment.sourceSha, commitSha); }
    catch (error) {
      if ((error as { status?: number }).status === 1) continue;
      // Missing commits, repository corruption or an unreadable Git history
      // cannot masquerade as an eligible pre-amendment recovery point.
      throw new RecoveryCompatibilityError("invalid-evidence",
        "Unable to authenticate adaptive amendment ancestry at the requested checkpoint.");
    } // Fork from BEFORE amendment authorization, without its grants.
    throw new RecoveryCompatibilityError("invalid-evidence",
      "An amended Story checkpoint cannot be forked into a new Thread without " +
      "an authenticated adaptive-plan and independent-review handoff; " +
      "use same-Thread restart or an earlier pre-amendment checkpoint.");
  }
}

/** Read-only preflight. Call before acquiring/allocating any child resources.
 * Mutable parent SQLite, unfinished receipts, sessions and grants are excluded. */
export async function collectRecoveryFork(parent: JobStartResult, childId: string,
  commitSha: string, contract: CompletionContract, skillsSource?: string,
  mode: "isolated" | "same-thread" = "isolated"): Promise<RecoveryForkBundle> {
  if (!/^[a-f0-9]{40}$/.test(commitSha) || childId === parent.jobId)
    throw new Error("Select a finalized checkpoint and a different child job identity.");
  const points = await inspectRecoveryCheckpoints(parent);
  const inherited = readRecoveryFork(parent);
  // A valid prior continuation can finish multiple independent no-write
  // reviews without producing its own Git commit. The incoming checkpoint is
  // still the authenticated Git anchor, but ONLY while this execution's
  // verified HEAD and immutable fork pin remain exactly at that commit.
  const inheritedAnchor = inherited?.checkpoint.commitSha === commitSha &&
    parent.baseSha === commitSha && git(parent, "rev-parse", "HEAD") === commitSha &&
    await trustedHead(parent) === commitSha;
  const selected = points.find(p => p.commitSha === commitSha && p.eligible) ??
    (inheritedAnchor ? { ...inherited!.checkpoint, eligible: true, reason: null,
      semanticReview: inherited!.reviewCoverage?.find(entry =>
        entry.commitSha === commitSha)?.status ?? "untracked" } : null);
  if (!selected) throw new RecoveryCompatibilityError("invalid-evidence",
    "Checkpoint is not finalized and independently verified.");
  // A fork is an independent Thread, not a restart of the original adaptive
  // graph. The existing v2 bundle transfers committed specialists and original
  // review criteria, but does NOT transfer authenticated amended assignment
  // history or independently sealed no-write authority. Reject a checkpoint
  // at/after amendment admission instead of quietly rescheduling the fixed
  // Architecture inventory in the child. Pre-amendment checkpoints remain
  // independently reusable without inheriting unpublished plan changes.
  await assertAdaptiveForkBoundary(parent, commitSha);
  // Commitless Event-only reviews can cross ONLY a same-Thread execution
  // boundary, after independent source, transcript and plan authentication.
  // Isolated diagnostic forks must not inherit the other Thread's review.
  const reviewBatch = mode === "same-thread"
    ? await collectReviewedOmissionBatch(parent, selected) : null;
  if (reviewBatch) await verifySavedReviewBatch(parent, reviewBatch);
  if (mode !== "same-thread" && selected.omittedWorkItems?.some(entry =>
      entry.workItem.startsWith("interactive-choice-")))
    throw new RecoveryCompatibilityError("invalid-evidence",
      "Event-only omissions are source-bound to the original Thread; " +
      "an isolated fork cannot inherit them.");
  if (mode === "same-thread" && selected.omittedWorkItems?.some(entry =>
      entry.workItem.startsWith("interactive-choice-") &&
      !reviewBatch?.entries.some(review =>
        entry.workItem === "interactive-choice-" + review.milestoneId.slice(10))))
    throw new RecoveryCompatibilityError("invalid-evidence",
      "The source checkpoint has an Event-only omission without a transferable reviewed handoff.");
  assertRecoveryCompatibility(selected);
  const { eligible: _eligible, reason: _reason, semanticReview: _semanticReview, ...checkpoint } = selected;
  const parentReviewTurn = await readReviewTurnEvidence(parent);
  // The same original, controller-verified Turn may supply review criteria in
  // a successor Thread; it is NOT transplanted into child turn-plan.json and
  // never conveys approvals or authoring grants. Every parent checkpoint with
  // assurance must match that review-only Turn before a fork is admitted.
  // New checkpoints from a current child are attributable to its own Turn.
  // For an unchanged inherited anchor, retain the sealed ancestor's exact
  // review identity rather than silently relabeling the old effect.
  const reviewTurn = inheritedAnchor
    ? inherited!.reviewTurn
    : parentReviewTurn?.digest === selected.assurance?.turnDigest &&
        existsSync(join(parent.stateDir, "turn-plan.json"))
      ? parentReviewTurn
      : inherited?.reviewTurn ?? parentReviewTurn;
  if (selected.assurance && (!reviewTurn ||
      (inheritedAnchor
        ? inherited!.checkpoint.assurance?.turnDigest !== selected.assurance.turnDigest
        : parentReviewTurn?.digest !== selected.assurance.turnDigest)))
    throw new RecoveryCompatibilityError("invalid-evidence",
      "Historical independent review has lost its original authorized Turn evidence.");
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
  // Supporting effects are completed historical work, not transferable grants.
  // Require the original support ledger to be settled at the selected Git
  // boundary (including a verified repair successor, if one was needed).
  const supportPlan = points.some(p => p.eligible && p.workItem.startsWith("dependency:") &&
    completed.has(p.workItem)) ? await (await import("./dependency-state.js")).inspectDependencyPlan(parent) : null;
  const resolvedCoverage = resolvedInheritedRecoveryReviews(reviewCoverage);
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
    // Inherited support has only sealed historical evidence, no child writer
    // receipt. Reuse the original pinned bytes on another continuation.
    const inheritedSupport = !point && id.startsWith("dependency:") && prior;
    try { receipt = inheritedSupport ? inherited!.receipts[source]! :
      JSON.parse(await readFile(join(parent.stateDir, source), "utf8")) as SpecialistReceipt; }
    catch { throw new RecoveryCompatibilityError("invalid-evidence",
      "The historical specialist receipt is missing or cannot be read."); }
    if (!receipt || receipt.jobId !== (inheritedSupport ? prior.jobId : parent.jobId)) throw new RecoveryCompatibilityError("invalid-evidence",
      "The historical specialist receipt belongs to a different job.");
    // The finalized source checkpoint binds the old skill digest to the
    // authenticated receipt. Reopening the historical skill *files* is not
    // necessary: only the child must have a verified current snapshot.
    if ((point ?? prior?.proof)?.snapshotId && receipt.snapshot?.id !== (point ?? prior?.proof)?.snapshotId)
      throw new RecoveryCompatibilityError("invalid-evidence",
        "Historical specialist skill identity differs from the finalized checkpoint.");
    if (source.startsWith("event-items/")) assertInheritedEventCompletion(parent, receipt);
    if (id.startsWith("dependency:")) {
      const support = point ? supportPlan?.entries.find(e => e.amendment?.assignment.id === id) : undefined;
      const sha = point?.commitSha ?? prior?.sha;
      if (!sha || !resolvedCoverage.some(r => r.workItem === id && r.commitSha === sha &&
          ["passed", "not-required"].includes(r.status)) ||
          (point && (!support || support.phase !== "verified" || support.review?.verdict !== "pass" ||
            (support.supportRootSha ?? support.commitSha) !== sha || !support.commitSha ||
            !reviewCoverage.some(r => r.commitSha === support.commitSha && r.status === "passed"))))
        throw new RecoveryCompatibilityError("invalid-evidence",
          "Supporting checkpoint lacks independently verified completed prerequisite work.");
    }
    receipts[source] = cleanEvidence(receipt);
    commits[id] = prior && !point ? prior : { sha: point!.commitSha,
      jobId: parent.jobId, planVersion: point!.planVersion, proof: (() => {
        const { eligible: _e, reason: _r, semanticReview: _s, ...proof } = point!;
        return proof;
      })() };
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
  // Preserve reviewed just-in-time Milestone plans for inherited Events.
  // Admission authenticates the exact original reviewer/session proof before
  // sealing only its approved design and original Git source in the bundle.
  const milestoneBlueprints: NonNullable<RecoveryForkBundle["milestoneBlueprints"]> = [];
  for (const [path, receipt] of Object.entries(receipts)) {
    if (!path.startsWith("event-items/") || !receipt.blueprintPin) continue;
    if (!receipt.assignment) throw new RecoveryCompatibilityError("invalid-evidence",
      "Inherited Event lost the original reviewed Milestone assignment.");
    const evidence = await collectInheritedMilestoneBlueprint(parent,
      receipt.blueprintPin, receipt.assignment);
    if (milestoneBlueprints.some(previous =>
      previous.pin.milestoneId === evidence.pin.milestoneId &&
      previous.pin.cycleId === evidence.pin.cycleId)) continue;
    milestoneBlueprints.push(evidence);
  }
  const completedStages: GenerationEvidence[] = [];
  for (const id of completed) {
    const item = stage(id);
    if (item) completedStages.push({ ...item, headSha: commits[id]?.sha ?? parent.baseSha,
      status: "committed", planVersion: plan?.version });
  }
  // An omitted Choice/Puzzle pair is a satisfied dependency but never a
  // fabricated specialist Git commit. Its new child receipt is separately
  // projected and reauthenticated against the immutable bundle at admission.
  for (const reviewed of reviewBatch?.entries ?? [])
    completedStages.push({ stage: "interactive", milestone: reviewed.milestoneId,
      headSha: reviewed.sourcePayload.reviewHead, status: "interactive-slice-committed",
      planVersion: reviewed.sourcePayload.planVersion });
  const toolchain = await selectCurrentRecoveryToolchain(parent, checkpoint, skillsSource);
  return { version: 2, toolchain, sourceJobId: parent.jobId, sourceBaseSha: parent.baseSha,
    storyRoot: parent.storyRoot, childId, checkpoint: checkpoint as RecoveryCheckpoint,
    reviewCoverage, contract: plan?.contract ?? contract,
    ...(reviewTurn ? { reviewTurn } : {}), receipts, commits, completedStages,
    ...(reviewBatch ? { reviewBatch } : {}),
    ...(milestoneBlueprints.length ? { milestoneBlueprints } : {}) };
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
  if (bundle.reviewBatch) {
    const original = await collectReviewedOmissionBatch(parent,bundle.checkpoint);
    if (JSON.stringify(original)!==JSON.stringify(bundle.reviewBatch))
      throw new RecoveryCompatibilityError("invalid-evidence",
        "Reviewed omission sources changed between fork admission and preparation.");
    await verifySavedReviewBatch(parent,bundle.reviewBatch);
  }

  for (const [path, receipt] of Object.entries(bundle.receipts))
    if (path.startsWith("event-items/")) assertInheritedEventCompletion(parent, receipt);
  const inheritedEvents = Object.entries(bundle.receipts).filter(([path, receipt]) =>
    path.startsWith("event-items/") && !!receipt.blueprintPin);
  const blueprints = bundle.milestoneBlueprints ?? [];
  if (blueprints.length !== inheritedEvents.length || blueprints.length > 64)
    throw new RecoveryCompatibilityError("invalid-evidence",
      "Inherited Event and independently reviewed Milestone Blueprint counts differ.");
  for (const [_, receipt] of inheritedEvents) {
    const proof = blueprints.find(entry =>
      JSON.stringify(entry.pin) === JSON.stringify(receipt.blueprintPin));
    if (!proof || !receipt.assignment) throw new RecoveryCompatibilityError("invalid-evidence",
      "Inherited Event lost its source-bound Milestone Blueprint proof.");
    const original = await collectInheritedMilestoneBlueprint(parent,
      receipt.blueprintPin, receipt.assignment);
    if (JSON.stringify(original) !== JSON.stringify(proof))
      throw new RecoveryCompatibilityError("invalid-evidence",
        "Milestone Blueprint was altered between fork admission and preparation.");
  }
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
      // Completed support is review evidence only. Never materialize a
      // previous Turn's focused writer receipt in the live child directory.
      if (path.startsWith("dependency-items/")) continue;
      // The sealed source bundle retains historical proofs. A child uses its
      // freshly pinned skills for future work; old writer sessions are not reused.
      const receipt = { ...original, jobId: child.jobId, baseSha: child.baseSha,
        branch: child.branch, worktreeRoot: child.worktreeRoot, threadId: child.threadId };
      await writeOnce(join(child.stateDir, path), JSON.stringify(receipt, null, 2) + "\n");
    }
    if (bundle.reviewBatch) {
      if (!bundle.reviewTurn) throw Error("Review batch has no original authorized Turn.");
      const reviewTurn = projectReviewTurn(bundle.reviewTurn, child);
      const hash = (value: unknown) => createHash("sha256")
        .update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
      for (const entry of bundle.reviewBatch.entries) {
        const slug = entry.milestoneId.slice("milestone.".length);
        const old = entry.sourcePayload;
        const originalSession = old.reviewerSession;
        const destination = originalSession
          ? join(child.stateDir, "review-sessions", "review", "inherited-" + slug + ".jsonl") : null;
        if (originalSession && destination) {
          const transcript = await readFile(originalSession, "utf8");
          if (hash(transcript) !== old.reviewerSessionSha256)
            throw Error("Original Event-only independent reviewer transcript has changed.");
          await writeOnce(destination, transcript);
        }
        const payload = { ...old, jobId: child.jobId, threadId: child.threadId,
          branch: child.branch, baseSha: child.baseSha, turnDigest: reviewTurn.digest,
          reviewerSession: destination };
        const ref = { nonce: entry.sourceSeal.nonce, digest: hash(payload) };
        const seal = { phase: "sealed", ...ref, payload, inherited: {
          sourceJobId: bundle.sourceJobId, sourceSeal: entry.sourceSeal,
          sourcePayloadDigest: hash(old) } };
        await writeOnce(join(child.stateDir, "interactive-event-only", slug + ".json"),
          JSON.stringify(seal, null, 2) + "\n");
        const source = entry.sourceReceipt;
        const receipt = { ...source, jobId: child.jobId, baseSha: child.baseSha,
          branch: child.branch, threadId: child.threadId, worktreeRoot: child.worktreeRoot,
          units: source.units.map((unit: Record<string, any>) => ({
            ...unit, eventOnly: ref })) };
        await writeOnce(join(child.stateDir, "interactive-items", slug + ".json"),
          JSON.stringify(receipt, null, 2) + "\n");
      }
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
