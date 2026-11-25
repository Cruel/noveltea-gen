/** The sole production adaptive-planning boundary. Runs under the existing
 * Story writer lock: only native-validated, clean, version-matched source is
 * eligible; pinned Pi remains read-only and cannot authorize its own proposal.
 */
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { JobStartResult } from "./job.js";
import type { Plan } from "./architecture.js";
import type { GenerationInventory, GenerationEvidence, ExecutionItem } from "./generation-plan.js";
import type { GenerationRequest } from "./generation.js";
import { validateStoryJob, type ValidationResult } from "./validator.js";
import { readTurnEvidence } from "./turn-plan-evidence.js";
import { loadSelectedStoryOrchestrator } from "./orchestrator-selection.js";
import { parseStoryPlanning } from "./story-planning.js";
import { nativeStoryMetrics, reviewArchitectureMetrics } from "./story-metrics.js";
import { dependencyGit } from "./dependency-state.js";
import { pendingDigest } from "./pending-work-amendments.js";
import { evaluateAdaptiveProposal, applyAdaptiveAssignments, revalidateAdaptiveAmendment,
  removeAdaptiveOverlays, assertReviewedOmissionDisposition, preservesWholeStoryInteraction,
  type AdaptiveProposal, type AdaptiveAdmission, type AdaptiveAmendment, type AdaptiveOmissionProof } from "./adaptive-assignments.js";
import { emptyAdaptiveState, readAdaptiveState, isProvablyUninvokedAdaptiveAttempt,
  assertAdaptiveSettled, beginAdaptiveAttempt, settleAdaptiveAttempt, saveAdaptiveState,
  bindAdaptiveContext, beginAdaptiveInvocation, completeAdaptiveInvocation,
  admitAdaptiveSupersession, type AdaptiveState, type AdaptiveSupersession } from "./adaptive-state.js";
import { AdaptiveRecoveryRequired, MalformedAdaptiveResponse, recheckAdaptiveResponse, type AdaptiveRecovery, type AdaptiveResponseProof } from "./adaptive-protocol.js";
import { proposeAdaptiveWork, recoverCompletedAdaptiveProposal, InvalidAdaptiveProposalError } from "./adaptive-planner.js";
import { requiredOrchestratorSkillReads } from "./story-skill-policy.js";
import { registerPendingPiSession } from "./job-pi-policy.js";
import { readEventOnlyOmission } from "./interactive-event-only.js";
import { readPuzzleNoWrite } from "./puzzle-obligation.js";
import { reviewedAdaptiveOmissions, authenticateAdaptiveOmission } from "./adaptive-omission.js";
import { inspectInteractiveConflict, runInteractiveWorkItem } from "./interactive-work.js";
import { reviewedMilestoneHandoff, assertMilestoneInteractiveDisposition } from "./milestone-obligation-handoff.js";
import { milestoneFulfillmentProjection } from "./milestone-field-scope.js";
import { inspectRecoveryCheckpoints, type RecoveryInspection } from "./recovery-checkpoints.js";
import { resolvedCheckpointReviews } from "./checkpoint-assurance.js";

const SHA = /^[a-f0-9]{40}$/;
const PATH = /^[a-z][a-z-]*\/[a-z0-9-]+\.md$/;

interface NativeRecord {
  path: string; metadata: { id: string; type: string; status: string;
    decisions?: unknown[]; planning?: unknown };
}
interface NativeReport {
  contractRevision: string; records: NativeRecord[];
  diagnostics: unknown[];
  protection: { status: string; base?: string; changes: unknown[]; warnings: unknown[] };
}
async function verifySource(job: JobStartResult, validation: ValidationResult,
  inventory: GenerationInventory) {
  if (inventory.planVersion === null || !SHA.test(inventory.headSha) ||
      dependencyGit(job, "rev-parse", "HEAD") !== inventory.headSha)
    throw Error("Adaptive planning lost its exact native-validated verified HEAD.");
  const report = validation.report as NativeReport | undefined;
  if (validation.status !== "passed" || !report || !Array.isArray(report.records) ||
      !Array.isArray(report.diagnostics) || report.diagnostics.length ||
      report.protection?.status !== "checked" ||
      report.protection.base !== inventory.headSha || report.protection.changes.length ||
      report.protection.warnings.length)
    throw Error("Adaptive planning requires strict native canonical and protected decision validation.");
  const dirty = dependencyGit(job, "status", "--porcelain=v1", "--untracked-files=all");
  if (dirty) throw Error("Adaptive planning cannot run on a dirty Story worktree.");
  const sourceHashes: Record<string, string> = {};
  const milestoneSourceHashes: Record<string, string> = {};
  if (report.records.length > 2048 || new Set(report.records.map(r => r.path)).size !== report.records.length)
    throw Error("Adaptive Story catalog exceeds a safe unique source inventory.");
  for (const record of report.records) {
    if (!PATH.test(record.path)) throw Error("Adaptive planning received an unsafe native source path.");
    const source = join(job.worktreeStoryRoot, record.path);
    const stat = await lstat(source);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1024 * 1024 ||
        await realpath(source) !== source)
      throw Error("Adaptive planning cannot inspect an unsafe canonical source.");
    const bytes = await readFile(source);
    sourceHashes[record.path] = createHash("sha256").update(bytes).digest("hex");
    if (record.metadata.type === "milestone")
      milestoneSourceHashes[record.path] = createHash("sha256")
        .update(milestoneFulfillmentProjection(bytes.toString("utf8"))).digest("hex");
  }
  return { report, sourceHashes, milestoneSourceHashes };
}
/** Only explicit, verified Architecture realization edges can introduce
 * additional Milestone-to-Milestone Event prerequisites. A model cannot
 * infer cross-owner causal authority from narrative prose or a list order. */
function architectureCausalEdges(plan: Plan): Array<{ item: string; needs: string }> {
  const byId = new Map(plan.items.map(item => [item.id, item]));
  const edges: Array<{ item: string; needs: string }> = [];
  for (const work of plan.items.filter(i => i.kind === "realization")) {
    const targets = work.targetIds.filter(id => id.startsWith("milestone."));
    for (const prior of work.dependencies) {
      const source = byId.get(prior);
      if (!source || source.kind !== "realization") continue;
      for (const target of targets) for (const need of source.targetIds.filter(id => id.startsWith("milestone."))) {
        if (target !== need) edges.push({ item: "event:" + target, needs: "event:" + need });
      }
    }
  }
  return edges;
}
const reviewedCarry = (inventory: GenerationInventory) =>
  inventory.items.filter(i => i.status === "verified").map(i => {
    if (!SHA.test(i.verifiedSha ?? "")) throw Error("Verified work lacks a trusted Git checkpoint.");
    return { id: i.id, sha: i.verifiedSha! };
  });
/** A marked-complete graph stage alone is not permission to carry a commit.
 * Match the original finalized native/Git checkpoint and its independent
 * review (or an authenticated no-write proof) before preserving it. */
async function reviewedAdaptiveCommit(job: JobStartResult,
  checkpoints: RecoveryInspection[], resolved: Map<string, string>,
  workItem: string, commitSha: string, planVersion: number) {
  const point = checkpoints.find(p => p.eligible && p.workItem === workItem &&
    p.commitSha === commitSha && p.planVersion === planVersion && p.assurance);
  if (!point)
    throw Error("Adaptive completed specialist has no original native-validated recovery checkpoint.");
  const review = resolved.get(point.commitSha) ?? point.semanticReview;
  if (review !== "passed" && review !== "not-required")
    throw Error("Adaptive completed specialist lacks passing original independent review: " + workItem);
}
async function certifySpecialistStage(job: JobStartResult, item: ExecutionItem,
  evidence: GenerationEvidence): Promise<{ workItem: string; commitSha: string } | null> {
  if (!item.milestone || !SHA.test(evidence.headSha) ||
      evidence.milestone !== item.milestone || evidence.stage !== item.stage)
    throw Error("Adaptive completed specialist lacks an exact original checkpoint.");
  dependencyGit(job, "merge-base", "--is-ancestor", evidence.headSha, "HEAD");
  const path = join(job.stateDir, "interactive-items",
    item.milestone.slice("milestone.".length) + ".json");
  if (!existsSync(path)) throw Error("Adaptive specialist checkpoint lost its original interactive receipt.");
  const source = JSON.parse(await readFile(path, "utf8")) as {
    jobId: string; milestoneId: string; planVersion: number; planDigest: string;
    worker: string; eventHead: string; units: Array<{ phase: string; commitSha?: string;
      beforeHead?: string; eventOnly?: Parameters<typeof readEventOnlyOmission>[2];
      noWrite?: Parameters<typeof readPuzzleNoWrite>[2] }>;
  };
  if (source.jobId !== job.jobId || source.milestoneId !== item.milestone ||
      source.planVersion !== evidence.planVersion || source.units?.length !== 2)
    throw Error("Adaptive specialist completion belongs to another authorization.");
  const choice = source.units[0]!, puzzle = source.units[1]!;
  if (choice.eventOnly) {
    if (!puzzle.eventOnly || JSON.stringify(choice.eventOnly) !== JSON.stringify(puzzle.eventOnly) ||
        choice.phase !== "not-applicable" || puzzle.phase !== "not-applicable")
      throw Error("Adaptive omission lost its independently sealed double no-write decision.");
    const proof = await readEventOnlyOmission(job, item.milestone, choice.eventOnly);
    if (proof.reviewHead !== evidence.headSha || proof.planDigest !== source.planDigest)
      throw Error("Adaptive omission no longer applies to the current Event revision.");
    return null;
  }
  if (choice.phase !== "committed" || !choice.commitSha)
    throw Error("Adaptive Choice checkpoint cannot be inferred from an unfinished writer.");
  if (item.stage === "choice") {
    if (choice.commitSha !== evidence.headSha) throw Error("Adaptive Choice evidence points to another commit.");
    return { workItem: "interactive-choice-" + item.milestone.slice(10), commitSha: evidence.headSha };
  } else if (item.stage === "puzzle" || item.stage === "interactive") {
    if (puzzle.phase === "committed") {
      if (puzzle.commitSha !== evidence.headSha)
        throw Error("Adaptive Puzzle evidence points to another commit.");
      return { workItem: "interactive-puzzle-" + item.milestone.slice(10), commitSha: evidence.headSha };
    } else if (puzzle.phase === "not-applicable" && puzzle.noWrite &&
        puzzle.beforeHead === evidence.headSha) {
      const proof = await readPuzzleNoWrite(job, item.milestone, puzzle.noWrite);
      if (proof.choiceHead !== choice.commitSha || proof.unitId !== "interactive-puzzle-" + item.milestone.slice(10) ||
          proof.verifiedHead !== evidence.headSha || proof.planVersion !== item.planVersion ||
          proof.planDigest !== source.planDigest)
        throw Error("Adaptive optional Puzzle proof changed its original source or authorization.");
      return { workItem: "interactive-choice-" + item.milestone.slice(10), commitSha: choice.commitSha };
    } else throw Error("Adaptive Puzzle omitted a required independent disposition.");
  }
  throw Error("Unsupported adaptive interactive checkpoint stage.");
}
export async function restoreCompletedAdaptiveWork(job: JobStartResult,
  inventory: GenerationInventory, completed: GenerationEvidence[]) {
  const checkpoints = (await inspectRecoveryCheckpoints(job)).filter(p => p.eligible && p.assurance);
  const resolved = await resolvedCheckpointReviews(job, checkpoints);
  for (const item of inventory.items) {
    if (item.status !== "pending" || !item.milestone ||
        !["choice", "puzzle", "event", "interactive", "composition"].includes(item.stage)) continue;
    const evidence = [...completed].reverse().find(e => e.stage === item.stage &&
      e.milestone === item.milestone && e.planVersion === item.planVersion);
    if (!evidence) continue;
    if (!SHA.test(evidence.headSha)) throw Error("Adaptive completion lacks a Git source identity.");
    const accepted = item.stage === "event" ? "event-cluster-committed" :
      item.stage === "composition" ? "composition-committed" :
      item.stage === "choice" ? "interactive-choice-committed" : "interactive-slice-committed";
    if (evidence.status !== accepted)
      throw Error("Adaptive completion status differs from the specialist stage.");
    const sealed = ["choice", "puzzle", "interactive"].includes(item.stage)
      ? await certifySpecialistStage(job, item, evidence)
      : { workItem: (item.stage === "event" ? "event-" : "composition-") +
          item.milestone.slice(10), commitSha: evidence.headSha };
    if (sealed) await reviewedAdaptiveCommit(job, checkpoints, resolved,
      sealed.workItem, sealed.commitSha, item.planVersion);
    // No Git commit is fabricated when an independently sealed Event-only
    // outcome supplies the authenticated reviewed no-write disposition.
    item.status = "verified";
    item.verifiedSha = evidence.headSha;
  }
  for (let pass = 0; pass < inventory.items.length; pass++) {
    for (const item of inventory.items) {
      if (item.status === "pending" && item.dependencies.some(dep =>
        inventory.items.some(parent => parent.id === dep && parent.status === "blocked"))) {
        item.status = "blocked";
        item.blockingReason = "Blocked dependency after adaptive reconciliation.";
      }
    }
  }
  return inventory;
}

/** C06 reopens BOTH original authorities: the negative Pi Choice transcript and
 * the positive independent no-write/Blueprint review. A saved signed plan
 * operation without these live source checks cannot make a writer disappear. */
export async function verifyAdaptiveSupersession(job: JobStartResult, plan: Plan,
  successor: AdaptiveSupersession, inventory: GenerationInventory,
  records: NativeRecord[], sourceHashes: Record<string, string>,
  protectedPaths: string[], authorTargets: string[],
  planning: ReturnType<typeof parseStoryPlanning>,
): Promise<AdaptiveOmissionProof> {
  const item = inventory.items.find(i => i.id === successor.assignmentId);
  if (!item || item.stage !== "interactive" || !item.milestone ||
      !["blocked", "verified"].includes(item.status) ||
      item.status === "verified" && item.verifiedSha !== successor.sourceSha ||
      inventory.planVersion !== successor.planVersion)
    throw Error("Adaptive supersession lost its original blocked or independently completed assignment.");
  const negative = await inspectInteractiveConflict(job, item.milestone, true);
  if (negative.worker !== "pi" || negative.reportDigest !== successor.negativeReportDigest ||
      negative.expectedHead !== successor.sourceSha ||
      negative.planVersion !== successor.planVersion)
    throw Error("Adaptive supersession does not match the settled original negative Pi report.");
  const planDigest = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
  const omission = await authenticateAdaptiveOmission(job, item.milestone,
    successor.planVersion, planDigest, records, sourceHashes);
  if (omission.assignmentId !== item.id || omission.sourceSha !== successor.sourceSha ||
      !isDeepStrictEqual(omission.eventOnly, successor.omission))
    throw Error("Adaptive supersession lost its exact independent no-write Review.");
  const event = JSON.parse(await readFile(join(job.stateDir, "event-items",
    item.milestone.slice(10) + ".json"), "utf8"));
  const blueprint = await reviewedMilestoneHandoff(job, event);
  if (!blueprint || !isDeepStrictEqual(blueprint.pin, successor.reviewedBlueprint))
    throw Error("Adaptive supersession no longer matches the reviewed Blueprint correction.");
  assertMilestoneInteractiveDisposition(blueprint, true);
  if (protectedPaths.includes(omission.path) ||
      authorTargets.includes(item.milestone) ||
      authorTargets.some(target => target.startsWith("choice-point.") ||
        target.startsWith("puzzle.")) ||
      !preservesWholeStoryInteraction(inventory.items, item, planning))
    throw Error("Original author Interaction promise or protected Milestone cannot be superseded.");
  return omission;
}

/** C01 selects this original, source-bound corrective adapter, not an ad hoc
 * scheduler fallback. The old negative Interactive receipt and original
 * adaptive Pi response survive the new reviewed version unmodified. */
export async function resolveAdaptiveNoWriteSupersession(input: {
  job: JobStartResult; request: GenerationRequest; plan: Plan;
  inventory: GenerationInventory; assignmentId: string;
  pinnedVersion: number | null;
}): Promise<{ outcome: "corrected" | "declined"; version?: number;
  sourceSha?: string; proof?: AdaptiveOmissionProof;
  decline?: "protected-author" | "story-wide-obligation" | "native-required" | "independent-review" }> {
  const { job, request, plan, inventory, assignmentId } = input;
  if (request.fixture || !request.turnPlanDigest ||
      request.orchestrationPolicy !== "explicit" || plan.contract.scope.kind !== "full-story" ||
      process.env.NT_ADAPTIVE_PLANNING !== "1" ||
      !assignmentId.startsWith("interactive:milestone.") ||
      !input.pinnedVersion || input.pinnedVersion <= 1)
    throw Error("C06 corrective amendment has no original full-Story adaptive authority.");
  const head = inventory.headSha;
  const item = inventory.items.find(i => i.id === assignmentId);
  if (!item || item.status !== "blocked" || item.stage !== "interactive" || !item.milestone ||
      head !== dependencyGit(job, "rev-parse", "HEAD"))
    throw Error("C06 correction requires the original failed pending Interactive assignment and unchanged HEAD.");
  const turn = await readTurnEvidence(job, request.contract, request.task, request.turnPlanDigest);
  if (!turn || !turn.objective || turn.kind !== "full-story")
    throw Error("C06 correction lost the protected original author objective.");
  const validation = await validateStoryJob(job, request.validatorSource ?? request.skillsSource,
    { ...job, baseSha: head });
  const { report, sourceHashes } = await verifySource(job, validation, inventory);
  const direction = report.records.find(r => r.metadata.type === "creative-direction" &&
    r.metadata.status === "approved");
  if (!direction?.metadata.planning) throw Error("Missing approved Story Interaction profile.");
  const planning = parseStoryPlanning(direction.metadata.planning);
  const protectedPaths = report.records.filter(r =>
    r.metadata.type === "creative-direction" || (r.metadata.decisions?.length ?? 0) > 0).map(r => r.path);
  const negative = await inspectInteractiveConflict(job, item.milestone, true);
  if (negative.worker !== "pi" || negative.expectedHead !== head)
    throw Error("Original Choice no-write is not a settled, unchanged Pi specialist report.");
  const state = await readAdaptiveState(job, turn.digest, plan.version);
  if (!state || state.version < input.pinnedVersion)
    throw Error("C06 original adaptive plan/version is missing.");
  const old = state.entries.filter(entry => entry.order.includes(assignmentId) &&
    entry.afterVersion <= input.pinnedVersion!).at(-1);
  if (!old) throw Error("C06 has no historical source-bound narrow/reorder assignment to supersede.");
  const existing = state.supersessions?.find(s => s.assignmentId === assignmentId);
  if (existing) {
    const proof = await verifyAdaptiveSupersession(job, plan, existing, inventory, report.records,
      sourceHashes, protectedPaths, turn.objective.requestedTargets, planning);
    return { outcome: "corrected", version: state.version, sourceSha: existing.sourceSha, proof };
  }
  if (state.version !== input.pinnedVersion)
    throw Error("C06 adaptive source advanced without an authenticated corrective supersession.");
  const rejected = state.attempts.filter(a => a.phase === "rejected");
  if (rejected.some(a => a.sourceSha !== head) || rejected.length > 1 ||
      state.attempts.some(a => a.phase === "planning"))
    throw Error("C06 cannot replace an unrelated or interrupted original planner response.");
  // An authenticated unmet author/Story-wide gameplay requirement is NOT
  // corrupt recovery evidence. Preserve the original failed writer and route
  // to its correct owner; no independent omission reviewer may waive it.
  if (turn.objective.requestedTargets.includes(item.milestone) ||
      turn.objective.requestedTargets.some(id => id.startsWith("choice-point.") || id.startsWith("puzzle.")))
    return { outcome: "declined", decline: "protected-author" };
  if (!preservesWholeStoryInteraction(inventory.items, item, planning))
    return { outcome: "declined", decline: "story-wide-obligation" };
  const reviewed = await runInteractiveWorkItem({
    story: job.storyRoot, job: job.jobId, action: "review-omission",
    milestone: item.milestone, fixture: false, generationObjective: request.task,
    turnPlanDigest: request.turnPlanDigest,
    skillsSource: request.skillsSource, validatorSource: request.validatorSource,
    provider: request.provider, model: request.model,
  });
  if (reviewed.status === "omission-not-justified") {
    if (!("omissionDecline" in reviewed) || !reviewed.omissionDecline)
      throw Error("Original settled Choice omission has no authenticated decline classification.");
    return { outcome: "declined", decline: reviewed.omissionDecline };
  }
  if (reviewed.status !== "interactive-slice-committed" || reviewed.headSha !== head)
    throw Error("C06 received no independently completed, commitless correction.");
  const newValidation = await validateStoryJob(job, request.validatorSource ?? request.skillsSource,
    { ...job, baseSha: head });
  const after = await verifySource(job, newValidation, inventory);
  if (pendingDigest(after.sourceHashes) !== pendingDigest(sourceHashes))
    throw Error("C06 reviewed correction changed canonical source without authorization.");
  const active = JSON.parse(await readFile(join(job.stateDir,
    "interactive-items", item.milestone.slice(10) + ".json"), "utf8")) as {
      units?: Array<{ eventOnly?: import("./interactive-event-only.js").EventOnlyRef }>;
    };
  const eventOnly = active.units?.[0]?.eventOnly;
  const event = JSON.parse(await readFile(join(job.stateDir,
    "event-items", item.milestone.slice(10) + ".json"), "utf8"));
  const blueprint = await reviewedMilestoneHandoff(job, event);
  if (!eventOnly || !blueprint)
    throw Error("C06 omission or reviewed successor Blueprint is absent.");
  const unsigned = { turnDigest: turn.digest, planVersion: plan.version,
    sourceSha: head, assignmentId, originalAmendmentDigest: old.digest,
    negativeReportDigest: negative.reportDigest, omission: eventOnly,
    reviewedBlueprint: blueprint.pin,
    ...(rejected.length ? { rejectedAttemptSignature: rejected[0]!.signature } : {}) };
  const candidate: AdaptiveSupersession = { ...unsigned,
    schema: "noveltea-adaptive-supersession/v1",
    beforeVersion: state.version, afterVersion: state.version + 1,
    digest: "" };
  const proof = await verifyAdaptiveSupersession(job, plan, candidate, inventory, report.records,
    sourceHashes, protectedPaths, turn.objective.requestedTargets, planning);
  await admitAdaptiveSupersession(job, state, unsigned);
  return { outcome: "corrected", version: state.version, sourceSha: head, proof };
}

/** The previous LangGraph inventory may contain controller-approved aliases
 * absent from the base Architecture. Undo only those overlays represented by
 * an already checkpointed plan version BEFORE canonical prerequisite-drift
 * detection; do not turn a new old-style dependency into a false review block. */
export async function canonicalPreviousAdaptiveInventory(
  job: JobStartResult, turnDigest: string | undefined, planVersion: number | null,
  previous: GenerationInventory | null, pinnedVersion: number | null,
): Promise<GenerationInventory | null> {
  if ((pinnedVersion ?? 1) <= 1 || !previous) return previous;
  if (!turnDigest || !planVersion)
    throw Error("Checkpointed adaptive assignments lost their original Turn or Architecture authority.");
  const state = await readAdaptiveState(job, turnDigest, planVersion);
  if (!state || state.version < pinnedVersion!)
    throw Error("Checkpointed adaptive plan history is missing; no unreviewed writer replay.");
  return removeAdaptiveOverlays(previous,
    state.entries.filter(entry => entry.afterVersion <= pinnedVersion!));
}

/** A controller-admitted plan can be sealed before LangGraph checkpoints its
 * version. Even when the feature flag is later disabled or the graph state
 * predates the receipt, that committed private history fences old scheduling.
 * Only an empty, fully settled receipt is eligible for legacy fallback. */
export async function assertAdaptiveFallbackAllowed(
  job: JobStartResult, turnDigest: string | undefined,
  planVersion: number, pinnedVersion: number | null | undefined,
): Promise<void> {
  if ((pinnedVersion ?? 1) > 1)
    throw Error("An amended Story cannot revert to the original scheduler.");
  if (!existsSync(join(job.stateDir, "adaptive-plan.json"))) return;
  if (!turnDigest)
    throw Error("A persisted adaptive plan lost its original authenticated Turn.");
  const state = await readAdaptiveState(job, turnDigest, planVersion);
  if (state) {
    assertAdaptiveSettled(state);
    if (state.entries.length)
      throw Error("A sealed adaptive amendment exists even though the graph checkpoint predates it; no fallback allowed.");
  }
}

export async function reconcileAdaptiveWork(input: {
  job: JobStartResult; request: GenerationRequest; plan: Plan;
  inventory: GenerationInventory; validation: ValidationResult;
  completed: GenerationEvidence[]; graphThreadId: string | null;
  pinnedVersion?: number | null;
  /** Inspection restores authenticated history but must never start a Pi turn. */
  allowAmend?: boolean;
  recovery?: AdaptiveRecovery | null;
  /** A deployed verifier fix authorizes rechecking the exhausted original response only. */
  fixRecheck?: boolean;
}): Promise<{ inventory: GenerationInventory; order: string[] | null; version: number | null; recovered?: boolean }> {
  const { job, request, plan, validation, completed } = input;
  const original = input.inventory;
  // #177 rollout remains opt-in until a completed real-Pi Story run certifies
  // adaptive author-goal fulfillment and no-Puzzle / choice-heavy outcomes.
  // A Thread pinned to an amendment cannot fall back when the flag changes.
  if (process.env.NT_ADAPTIVE_PLANNING !== "1") {
    await assertAdaptiveFallbackAllowed(job, request.turnPlanDigest, plan.version, input.pinnedVersion);
    return { inventory: original, order: null, version: null };
  }
  if (!request.turnPlanDigest || request.fixture || request.orchestrationPolicy !== "explicit" ||
      plan.contract.scope.kind !== "full-story" || !input.graphThreadId) {
    await assertAdaptiveFallbackAllowed(job, request.turnPlanDigest, plan.version, input.pinnedVersion);
    return { inventory: original, order: null, version: null };
  }
  if (input.allowAmend === false && (input.pinnedVersion ?? 1) <= 1 &&
      !existsSync(join(job.stateDir, "adaptive-plan.json")))
    return { inventory: original, order: null, version: null };
  const turn = await readTurnEvidence(job, request.contract, request.task, request.turnPlanDigest);
  if (!turn || turn.kind !== "full-story" || !turn.objective) {
    await assertAdaptiveFallbackAllowed(job, request.turnPlanDigest, plan.version, input.pinnedVersion);
    return { inventory: original, order: null, version: null };
  }
  const { report, sourceHashes, milestoneSourceHashes } = await verifySource(job, validation, original);
  const direction = report.records.find(r => r.metadata.type === "creative-direction" &&
    r.metadata.status === "approved");
  if (!direction || !Object.hasOwn(direction.metadata, "planning")) {
    await assertAdaptiveFallbackAllowed(job, request.turnPlanDigest, plan.version, input.pinnedVersion);
    return { inventory: original, order: null, version: null };
  }
  const planning = parseStoryPlanning(direction.metadata.planning);
  const metrics = nativeStoryMetrics(job);
  const budget = reviewArchitectureMetrics(metrics, report.records, report.contractRevision, original.headSha);
  if (budget.requiresAuthorDirection.length)
    throw Error("Adaptive Story planning exceeds original hard Production budget: " +
      budget.requiresAuthorDirection.join("; ") + ". Preserve scope and obtain exact author direction.");
  const selected = await loadSelectedStoryOrchestrator(job, input.graphThreadId, {
    task: request.task, kind: request.contract.scope.kind, turnPlanDigest: request.turnPlanDigest,
  });
  let state = await readAdaptiveState(job, turn.digest, plan.version);
  if (input.pinnedVersion && (!state || state.version < input.pinnedVersion))
    throw Error("Checkpointed adaptive amendment is missing or stale; restore original receipt.");
  if (input.recovery && input.recovery.phase !== "completed") {
    const pinned = state?.attempts.find(a => a.signature === input.recovery!.signature);
    if (!pinned || pinned.sourceSha !== original.headSha ||
        !isDeepStrictEqual(pinned.malformedResponse, input.recovery.proof))
      throw Error("Checkpointed adaptive correction lost its original response; do not replay the planner");
  }
  state ??= emptyAdaptiveState(job, turn.digest, plan.version);
  const interrupted = state.attempts.find(a => a.phase === "planning");
  const originalAttempt = interrupted?.effect && !interrupted.malformedResponse ? interrupted : null;
  const format = interrupted?.malformedResponse ? interrupted : null;
  // Legacy receipts without a write-ahead effect phase remain ambiguous. A
  // prepared original is never replayed in inspection; only the controller
  // execution boundary can verify and continue the SAME operation.
  const recoverable = !!originalAttempt && (input.allowAmend !== false ||
    isProvablyUninvokedAdaptiveAttempt(originalAttempt));
  assertAdaptiveSettled(interrupted && (format || recoverable)
    ? { ...state, attempts: state.attempts.filter(a => a !== interrupted) } : state);
  if (originalAttempt && (originalAttempt.effect!.snapshotId !== selected.receipt.skillSnapshot.id ||
      originalAttempt.effect!.provider !== (request.provider ?? "openai") ||
      originalAttempt.effect!.model !== (request.model ?? "gpt-6-luna")))
    throw Error("Interrupted adaptive planner changed its original model or snapshot.");
  const expectedSignature = pendingDigest({ source: original.headSha, planVersion: plan.version,
    turn: turn.digest, metricSources: budget.sourceRevisionsDigest });
  const decision = (proof: AdaptiveResponseProof): AdaptiveRecovery => ({
    operation: "adaptive-planner", failedPhase: "completed-response", check: "adaptive-plan.v1", checkVersion: 1,
    action: "correct-original-response", phase: "assessment", jobId: job.jobId, threadId: job.threadId,
    turnDigest: turn.digest, planVersion: plan.version, sourceSha: original.headSha, signature: expectedSignature, proof,
  });
  if (interrupted) {
    if (interrupted.signature !== expectedSignature || interrupted.sourceSha !== original.headSha)
      throw Error("Unsettled adaptive operation no longer matches the verified source");
    if (format) {
      const required = decision(format.malformedResponse!);
      const phase = input.fixRecheck ? "protocol-exhausted" : "authorized";
      if (input.allowAmend === false || !isDeepStrictEqual(input.recovery, { ...required, phase }))
        throw new AdaptiveRecoveryRequired(required);
    } else if (input.recovery && input.recovery.phase !== "completed")
      throw Error("Unrelated adaptive protocol recovery cannot authorize the original Pi operation.");
  }
  const protectedPaths = report.records.filter(r =>
    r.metadata.type === "creative-direction" || (r.metadata.decisions?.length ?? 0) > 0).map(r => r.path);
  let omissionProofs = await reviewedAdaptiveOmissions({
    job, request, inventory: original, records: report.records, sourceHashes,
    saved: state.entries.flatMap(entry => entry.omissions),
    allowReview: false, authorTargets: turn.objective.requestedTargets,
    planning, protectedPaths,
    planDigest: createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
  });
  const authorized = (inventory: GenerationInventory, proposal: AdaptiveProposal): AdaptiveAdmission => ({
    proposal, inventory, plan, turnDigest: turn.digest, version: proposal.beforeVersion,
    verifiedSource: true, records: report.records, sourceHashes, milestoneSourceHashes,
    protectedPaths, typedEdges: architectureCausalEdges(plan),
    authorTargets: turn.objective!.requestedTargets,
    planning, carried: reviewedCarry(inventory), omissionProofs,
    authenticatedProofAncestors: omissionProofs.filter(proof =>
      proof.sourceSha !== inventory.headSha).map(proof => proof.sourceSha),
  });
  let effective = original;
  let order: string[] | null = null;
  const mutations = [...state.entries.map(entry => ({ kind: "proposal" as const, entry })),
    ...(state.supersessions ?? []).map(entry => ({ kind: "supersession" as const, entry }))]
    .sort((a, b) => a.entry.beforeVersion - b.entry.beforeVersion);
  for (const mutation of mutations) {
    if (mutation.kind === "supersession") {
      const proof = await verifyAdaptiveSupersession(job, plan, mutation.entry,
        effective, report.records, sourceHashes, protectedPaths,
        turn.objective.requestedTargets, planning);
      const item = effective.items.find(i => i.id === mutation.entry.assignmentId)!;
      if (item.status !== "verified")
        throw Error("Authenticated adaptive supersession lost the independently completed no-write stage.");
      item.omission = { reason: "Controller-reviewed original Choice no-write supersession",
        evidence: proof.evidence, reviewerSession: proof.reviewerSession };
      order = (order as string[] | null)?.filter((id: string) => id !== item.id) ?? null;
      continue;
    }
    const entry = mutation.entry;
    const admission = authorized(effective, {
      sourceSha: effective.headSha, turnDigest: entry.turnDigest,
      beforeVersion: entry.beforeVersion, reason: entry.reason,
      actions: entry.actions, order: entry.order,
    });
    const restored = revalidateAdaptiveAmendment(entry, admission);
    effective = await restoreCompletedAdaptiveWork(job, restored.inventory, completed);
    order = restored.order.filter(id => effective.items.some(i => i.id === id && i.status === "pending"));
  }
  const eligible = state.entries.length < 4 && effective.items.some(i =>
    ["event", "interactive", "choice", "puzzle", "composition"].includes(i.stage) && i.status === "pending");
  if (interrupted && !eligible) throw Error("Unsettled adaptive correction lost its pending assignment scope");
  if (input.allowAmend !== false && eligible) {
    const signature = expectedSignature;
    if (interrupted || await beginAdaptiveAttempt(job, state, original.headSha, signature, {
      snapshotId: selected.receipt.skillSnapshot.id, provider: request.provider ?? "openai",
      model: request.model ?? "gpt-6-luna",
    })) {
      // Only a new, persisted controller attempt may make another independent
      // review request. Pure restarts or unchanged source HEADs never consume
      // an extra model turn; interrupted review retains its original fence.
      omissionProofs = await reviewedAdaptiveOmissions({
        job, request, inventory: effective, records: report.records, sourceHashes,
        saved: state.entries.flatMap(entry => entry.omissions),
        allowReview: interrupted ? "restore-candidates" : true, authorTargets: turn.objective.requestedTargets,
        planning, protectedPaths,
        planDigest: createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
      });
      // The persisted 'planning' fence is deliberate. An interrupted Pi
      // session is never replaced by another potentially costly/inconsistent
      // proposal on automatic resume.
      // Reconciliation can change its human-readable inventory rationale
      // without changing a single assignment. Bind the original Pi operation
      // to the evidence and actual writer authorization, not scheduler prose.
      const { rationale: _rationale, ...authorization } = effective;
      const contextDigest = pendingDigest({ inventory: authorization, omissionProofs, sourceHashes });
      // Historical format corrections pinned the full inventory, including
      // its rationale. Accept that old proof only when it still matches
      // exactly; never rewrite the original receipt during recheck.
      const legacyContextDigest = pendingDigest({ inventory: effective, omissionProofs, sourceHashes });
      const matchesContext = (digest: string | undefined) =>
        !digest || digest === contextDigest || digest === legacyContextDigest;
      if (interrupted && (!matchesContext(format?.recoveryContext) ||
          !matchesContext(originalAttempt?.effect?.contextDigest)))
        throw Error("Interrupted adaptive operation lost its original source or omission evidence");
      if (!format && (!interrupted || originalAttempt?.effect?.phase === "prepared"))
        await bindAdaptiveContext(job, state, signature, contextDigest);
      let proposed: Awaited<ReturnType<typeof proposeAdaptiveWork>>;
      try {
        proposed = input.fixRecheck && format && input.recovery
          ? await recheckAdaptiveResponse(job, input.recovery, selected.receipt.skillSnapshot.path)
          : originalAttempt && originalAttempt.effect?.phase !== "prepared"
          ? await recoverCompletedAdaptiveProposal({
              job, selected, effect: originalAttempt.effect!, signature,
              required: [...requiredOrchestratorSkillReads(turn.creativePolicy?.mode ?? "autonomous")],
            })
          : await proposeAdaptiveWork({
          job, selected, turn, inventory: effective, planning, metrics,
          provider: request.provider ?? "openai", model: request.model ?? "gpt-6-luna",
          version: state.version, signature, recovery: format ? input.recovery! : undefined,
          onInvocation: async (file, id, prompt) => {
            await beginAdaptiveInvocation(job, state, signature, file, id, prompt);
            await registerPendingPiSession(job, file);
          },
          onCompleted: (file, id) => completeAdaptiveInvocation(job, state, signature, file, id),
          typedEdges: architectureCausalEdges(plan),
          omissionCandidates: omissionProofs.filter(proof => effective.items.some(item =>
            item.id === proof.assignmentId && item.status === "pending"))
            .map(proof => ({ assignmentId: proof.assignmentId,
              sourcePath: proof.path, evidence: proof.evidence })),
          sourceEvidence: report.records.filter(r =>
            r.metadata.type === "milestone" && r.metadata.status !== "superseded" &&
            milestoneSourceHashes[r.path])
            .map(r => ({ milestone: r.metadata.id, path: r.path,
              sha256: milestoneSourceHashes[r.path]! })),
        });
      } catch (error) {
        if (error instanceof MalformedAdaptiveResponse && !format) {
          const attempt = state.attempts.find(a => a.signature === signature)!;
          attempt.malformedResponse = error.proof;
          attempt.recoveryContext = contextDigest;
          await saveAdaptiveState(job, state);
          throw new AdaptiveRecoveryRequired(decision(error.proof));
        }
        if (error instanceof InvalidAdaptiveProposalError)
          await settleAdaptiveAttempt(job, state, signature, "rejected");
        throw error;
      }
      if (originalAttempt?.effect?.phase === "invoking") {
        // Crash after a terminal Pi reply but before the effect checkpoint:
        // authenticate its original session, then seal the response hash.
        await completeAdaptiveInvocation(job, state, signature, proposed.sessionFile,
          originalAttempt.effect.invocation!.id);
      }
      const p = proposed.proposal;
      const session = {
        sessionFile: proposed.sessionFile,
        sessionSha256: createHash("sha256").update(await readFile(proposed.sessionFile)).digest("hex"),
        snapshotId: selected.receipt.skillSnapshot.id,
        provider: request.provider ?? "openai", model: request.model ?? "gpt-6-luna",
        skillReads: proposed.skillReads, proposalDigest: pendingDigest(p),
      };
      if (!p || !Array.isArray(p.actions) || !Array.isArray(p.order)) {
        await settleAdaptiveAttempt(job, state, signature, "rejected", undefined, session);
        throw Error("Adaptive orchestrator proposal lacks bounded typed assignments.");
      }
      let amendment: AdaptiveAmendment | null;
      try {
        // A read-only session is not an atomic source snapshot. Recheck the
        // native-validated files and clean HEAD before admitting even a no-op.
        const after = await verifySource(job, validation, original);
        if (pendingDigest(after.sourceHashes) !== pendingDigest(sourceHashes))
          throw Error("Adaptive source bytes changed during planning.");
        assertReviewedOmissionDisposition(p, effective, omissionProofs);
        amendment = evaluateAdaptiveProposal(authorized(effective, p));
      } catch (error) {
        await settleAdaptiveAttempt(job, state, signature, "rejected", undefined, session);
        throw Error("Read-only adaptive proposal was rejected by controller: " +
          (error instanceof Error ? error.message : String(error)));
      }
      if (!amendment) {
        await settleAdaptiveAttempt(job, state, signature, "unchanged", undefined, session);
      } else {
        await settleAdaptiveAttempt(job, state, signature, "admitted", amendment, session);
        effective = applyAdaptiveAssignments(effective, amendment);
        order = amendment.order;
      }
    }
  }
  const recovered = state.attempts.some(a => a.signature === input.recovery?.signature &&
    !!a.malformedResponse && (a.phase === "admitted" || a.phase === "unchanged"));
  return { inventory: effective, order, version: state.version, recovered };
}
