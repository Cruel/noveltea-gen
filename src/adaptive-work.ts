/** The sole production adaptive-planning boundary. Runs under the existing
 * Story writer lock: only native-validated, clean, version-matched source is
 * eligible; pinned Pi remains read-only and cannot authorize its own proposal.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { JobStartResult } from "./job.js";
import type { Plan } from "./architecture.js";
import type { GenerationInventory, GenerationEvidence, ExecutionItem } from "./generation-plan.js";
import type { GenerationRequest } from "./generation.js";
import type { ValidationResult } from "./validator.js";
import { readTurnEvidence } from "./turn-plan-evidence.js";
import { loadSelectedStoryOrchestrator } from "./orchestrator-selection.js";
import { parseStoryPlanning } from "./story-planning.js";
import { nativeStoryMetrics, reviewArchitectureMetrics } from "./story-metrics.js";
import { dependencyGit } from "./dependency-state.js";
import { pendingDigest } from "./pending-work-amendments.js";
import { admitAdaptiveAssignments, applyAdaptiveAssignments, revalidateAdaptiveAmendment,
  removeAdaptiveOverlays,
  type AdaptiveProposal, type AdaptiveAdmission, type AdaptiveAmendment } from "./adaptive-assignments.js";
import { emptyAdaptiveState, readAdaptiveState,
  assertAdaptiveSettled, beginAdaptiveAttempt, settleAdaptiveAttempt } from "./adaptive-state.js";
import { proposeAdaptiveWork, InvalidAdaptiveProposalError } from "./adaptive-planner.js";
import { readEventOnlyOmission } from "./interactive-event-only.js";
import { readPuzzleNoWrite } from "./puzzle-obligation.js";
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
  if (report.records.length > 2048 || new Set(report.records.map(r => r.path)).size !== report.records.length)
    throw Error("Adaptive Story catalog exceeds a safe unique source inventory.");
  for (const record of report.records) {
    if (!PATH.test(record.path)) throw Error("Adaptive planning received an unsafe native source path.");
    const source = join(job.worktreeStoryRoot, record.path);
    const stat = await lstat(source);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1024 * 1024 ||
        await realpath(source) !== source)
      throw Error("Adaptive planning cannot inspect an unsafe canonical source.");
    sourceHashes[record.path] = createHash("sha256").update(await readFile(source)).digest("hex");
  }
  return { report, sourceHashes };
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
  return removeAdaptiveOverlays(previous, state.entries.slice(0, pinnedVersion! - 1));
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
}): Promise<{ inventory: GenerationInventory; order: string[] | null; version: number | null }> {
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
  const turn = await readTurnEvidence(job, request.contract, request.task, request.turnPlanDigest);
  if (!turn || turn.kind !== "full-story" || !turn.objective) {
    await assertAdaptiveFallbackAllowed(job, request.turnPlanDigest, plan.version, input.pinnedVersion);
    return { inventory: original, order: null, version: null };
  }
  const { report, sourceHashes } = await verifySource(job, validation, original);
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
  state ??= emptyAdaptiveState(job, turn.digest, plan.version);
  assertAdaptiveSettled(state);
  const protectedPaths = report.records.filter(r =>
    r.metadata.type === "creative-direction" || (r.metadata.decisions?.length ?? 0) > 0).map(r => r.path);
  const authorized = (inventory: GenerationInventory, proposal: AdaptiveProposal): AdaptiveAdmission => ({
    proposal, inventory, plan, turnDigest: turn.digest, version: proposal.beforeVersion,
    verifiedSource: true, records: report.records, sourceHashes,
    protectedPaths, typedEdges: architectureCausalEdges(plan),
    authorTargets: turn.objective!.requestedTargets,
    planning, carried: reviewedCarry(inventory), omissionProofs: [],
  });
  let effective = original;
  let order: string[] | null = null;
  for (const entry of state.entries) {
    const admission = authorized(effective, {
      sourceSha: effective.headSha, turnDigest: entry.turnDigest,
      beforeVersion: entry.beforeVersion, reason: entry.reason,
      actions: entry.actions, order: entry.order,
    });
    const restored = revalidateAdaptiveAmendment(entry, admission);
    effective = await restoreCompletedAdaptiveWork(job, restored.inventory, completed);
    order = restored.order.filter(id => effective.items.some(i => i.id === id && i.status === "pending"));
  }
  if (state.entries.length < 4 && effective.items.some(i => i.stage === "interactive" &&
      i.status === "pending")) {
    const signature = pendingDigest({
      // One paid planning attempt per canonical Git source. A pure scheduling
      // amendment, a restart, or a commitless no-write decision cannot launch
      // a second Pi turn against unchanged Story evidence.
      source: original.headSha, planVersion: plan.version, turn: turn.digest,
      metricSources: budget.sourceRevisionsDigest,
    });
    if (await beginAdaptiveAttempt(job, state, original.headSha, signature)) {
      // The persisted 'planning' fence is deliberate. An interrupted Pi
      // session is never replaced by another potentially costly/inconsistent
      // proposal on automatic resume.
      let proposed: Awaited<ReturnType<typeof proposeAdaptiveWork>>;
      try {
        proposed = await proposeAdaptiveWork({
          job, selected, turn, inventory: effective, planning, metrics,
          provider: request.provider ?? "openai", model: request.model ?? "gpt-6-luna",
          version: state.version, signature,
          typedEdges: architectureCausalEdges(plan),
        });
      } catch (error) {
        if (error instanceof InvalidAdaptiveProposalError)
          await settleAdaptiveAttempt(job, state, signature, "rejected");
        throw error;
      }
      const p = proposed.proposal;
      const session = {
        sessionFile: proposed.sessionFile,
        sessionSha256: createHash("sha256").update(await readFile(proposed.sessionFile)).digest("hex"),
        snapshotId: selected.receipt.skillSnapshot.id,
        provider: request.provider ?? "openai", model: request.model ?? "gpt-6-luna",
        skillReads: proposed.skillReads, proposalDigest: pendingDigest(p),
      };
      if (!Array.isArray(p.actions) || !Array.isArray(p.order)) {
        await settleAdaptiveAttempt(job, state, signature, "rejected", undefined, session);
        throw Error("Adaptive orchestrator proposal lacks bounded typed assignments.");
      }
      const current = effective.items.filter(i => i.status === "pending").map(i => i.id);
      if (!p.actions.length && JSON.stringify(p.order) === JSON.stringify(current)) {
        await settleAdaptiveAttempt(job, state, signature, "unchanged", undefined, session);
      } else {
        let amendment: AdaptiveAmendment;
        try {
          amendment = admitAdaptiveAssignments(authorized(effective, p));
        } catch (error) {
          await settleAdaptiveAttempt(job, state, signature, "rejected", undefined, session);
          throw Error("Read-only adaptive proposal was rejected by controller: " +
            (error instanceof Error ? error.message : String(error)));
        }
        await settleAdaptiveAttempt(job, state, signature, "admitted", amendment, session);
        effective = applyAdaptiveAssignments(effective, amendment);
        order = amendment.order;
      }
    }
  }
  return { inventory: effective, order, version: state.version };
}
