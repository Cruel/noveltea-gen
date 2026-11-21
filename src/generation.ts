import { assertNativeVersion } from './native-cli-version.js';
import { execFileSync } from "node:child_process";
import { readRecoveryFork, verifyReadyRecoveryFork, resolvedInheritedRecoveryReviews } from "./recovery-fork-state.js";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { load, persist } from "./ideas.js";
import { runIdeaPlacement, scheduleIdeasAtBoundary } from "./idea-placement.js";
import { AdaptiveRecoveryRequired, type AdaptiveRecovery } from "./adaptive-protocol.js";
import { diagnoseUnknownCompletion, inspectUnknownRecoveryStatus, unknownCompletionCase,
  unknownDiagnosisDisposition, type UnknownRecoveryStatus } from "./unknown-recovery-diagnostic.js";
import { assessGenerationOperation, operationChecks, type GenerationOperationRecovery,
  type Operation } from "./generation-operation-recovery.js";
import { ProtocolExhaustedError } from "./response-contract-recovery.js";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { z } from "zod";
import { parseContract, runArchitectureJob, verifyPlanHistory, type CompletionContract } from "./architecture.js";
import { runFoundationJob } from "./foundation.js";
import { reusableExistingFoundation } from "./foundation-readiness.js";
import { runCharacterWorldJob } from "./character-world.js";
import { runEventWorkItem } from "./event-work.js";
import { routeEventPrerequisite } from "./event-prerequisite-routing.js";
import { inspectCausalAmendment } from "./causal-amendment-controller.js";
import type { CausalAmendment, CausalDiscovery } from "./causal-amendment.js";
import { runInteractiveWorkItem } from "./interactive-work.js";
import { readEventOnlyOmission, type EventOnlyRef } from "./interactive-event-only.js";
import { runCompositionWorkItem } from "./composition-work.js";
import { preflightCompositionBoundary } from "./cross-domain-prerequisite-controller.js";
import { advanceCrossDomainCloseout } from "./cross-domain-closeout-work.js";
import { runNarrativeReview } from "./narrative-review.js";
import { runFocusedWorkItem } from "./focused-work.js";
import { advanceFocusedDependency } from "./dependency-work.js";
import { reconcilePendingWork } from "./pending-work.js";
import { canonicalPreviousAdaptiveInventory, reconcileAdaptiveWork } from "./adaptive-work.js";
import { currentSteeringBoundary } from "./steering-boundary.js";
import { proposeSteeringAmendment, readSteeringPlan, saveSteeringAmendment,
  steeringForAssignment, steeringSourceIsAncestor } from "./steering-amendments.js";
import { dependencyGit } from "./dependency-state.js";
import { readPendingState, verifyPinnedPendingWork } from "./pending-work-state.js";
import { inspectDependencyPlan, dependencyDigest, verifyDependencyHistory,
  type DependencyHistoryPin } from "./dependency-state.js";
import { isFocusedScope } from "./focused-scope.js";
import { processAuthorUpdatesAfterWork } from "./author-updates.js";
import { startStoryJob, type JobStartResult } from "./job.js";
import { withStoryGenerationLock, withStoryJobLock } from "./job-lock.js";
import { claimServerGeneration, ensureNotServerOwned } from "./generation-owner.js";
import { readJobControl } from "./job-control.js";
import { inspectJobReport, type JobReport } from "./job-report.js";
import { trustedHead } from "./revision.js";
import { inspectRecoveryCheckpoints, reconcileRecoveryCheckpoints } from "./recovery-checkpoints.js";
import { sealReviewedOmissionBatch } from "./recovery-review-batch.js";
import { blockedByRequiredReview, executionId, resolvedCheckpointReviews,
  IndependentReviewGateError, assertNativeReviewDependencies } from "./checkpoint-assurance.js";
import { assessTurnFulfillment } from "./turn-fulfillment.js";
import { readTurnEvidence } from "./turn-plan-evidence.js";
import { readReviewTurnEvidence } from "./fork-review-turn.js";
import { openSkillSnapshot, type SkillSnapshot } from "./snapshot.js";
import { loadSkillConfig } from "./skills.js";
import { hasStoryOrchestratorSelection, loadSelectedStoryOrchestrator,
  selectStoryOrchestrator, type StoryOrchestratorReceipt,
  type StoryOrchestratorSelection } from "./orchestrator-selection.js";
import { runPinnedObjectivePlanner, restoreCheckpointedObjectivePlanning,
  type OrchestratorPlanningReceipt } from "./orchestrator-planner.js";
import { validateStoryJob } from "./validator.js";
import { hasPlanContinuity } from "./plan-continuity.js";
import { generationStages, reconcileInventory, nextExecutionItem, withCausalEventPriority, adaptiveDispatchTask,
  authorizedInventoryComplete,
  type GenerationStage as Stage,
  type GenerationEvidence, type GenerationInventory, type ExecutionItem } from "./generation-plan.js";
export { generationStages, type GenerationEvidence } from "./generation-plan.js";

export interface GenerationRequest {
  story: string; job: string; task: string; contract: CompletionContract;
  fixture: boolean; skillsSource?: string; validatorSource?: string;
  provider?: string; model?: string; turnPlanDigest?: string;
  /** New controller admission only. Absent means a pre-cutover pinned generation. */
  orchestrationPolicy?: "explicit" | "fixture-legacy";
}
export interface GenerationOptions {
  story: string; job: string; action: "start" | "resume" | "inspect";
  task?: string; contract?: unknown; fixture?: boolean; skillsSource?: string;
  validatorSource?: string; provider?: string; model?: string; pauseAfter?: Stage;
}
type Status = "running" | "paused" | "blocked" | "cancelled" | "completed";
export interface IdeaTask { id: string; action: "place" | "reassess"; signature: string; priorHead: string }
export interface IdeaResult { status: string; commitSha?: string; reason?: string }
export interface IdeaAttempt { signature: string; action: IdeaTask["action"]; status: string; reason?: string; commitSha?: string }
export interface IdeaHistoryEntry extends IdeaAttempt { id: string }
export interface GenerationEscalation {
  kind: "protected-approval" | "dependency-replan" | "targeted-repair";
  sources: Array<{ source: string; message: string; repair: string }>;
  requiresTrustedApproval: boolean;
  action: string;
}
function reviewEscalation(report: JobReport, inventory: GenerationInventory | null): GenerationEscalation | null {
  const sources = [
    ...(report.evidence.scope?.diagnostics ?? inventory?.audit?.diagnostics ?? [])
      .filter(d => d.severity === "blocking" &&
        !(d.code === "unfulfilled-obligation" &&
          report.evidence.deferredIdeas.scopedOutstanding.includes(d.source))).map(d =>
        ({ source: d.source, message: d.message, repair: d.repair })),
    ...report.evidence.editorial.findings.filter(f => f.severity === "blocking").map(f =>
      ({ source: String(f.source), message: String(f.message), repair: String(f.repair) })),
    ...report.generation.planFulfillment.findings.map(f => ({ source: f.objectiveId,
      message: f.message, repair: f.followUp ? "turn-follow-up" : "architecture" })),
    ...(inventory?.items ?? []).filter(i => i.status === "blocked" && i.stage !== "review" &&
      i.blockingReason && !i.blockingReason.startsWith("Blocked dependency:")).map(i =>
      ({ source: i.id, message: i.blockingReason!, repair: "architecture" })),
  ];
  if (!sources.length) return null;
  const turnIncomplete = report.generation.planFulfillment.status === "incomplete";
  const protectedChange = sources.some(s => s.repair === "protected");
  const replan = sources.some(s => ["architecture", "event", "interactive"].includes(s.repair));
  return {
    kind: protectedChange ? "protected-approval" : replan ? "dependency-replan" : "targeted-repair",
    sources, requiresTrustedApproval: protectedChange || replan || turnIncomplete,
    action: turnIncomplete
      ? "The final Turn reviewer identified missing whole-plan objectives. Preserve verified work; authorize a new bounded follow-up specialist assignment at the current Story HEAD, or explicitly approve a versioned plan revision for out-of-scope requirements. No proposed repair grants write authority."
      : protectedChange
      ? "Protected decisions cannot be edited automatically. Obtain exact trusted-controller authorization through the existing revision/approval workflow."
      : replan
        ? "Affect only the listed source/dependency scope. Propose and obtain a controller-approved architecture/scope revision with explicit carry-forward, or authorize a bounded targeted repair; do not widen coverage automatically."
        : "The narrative reviewer exhausted or could not use its original-writer bounded repair path. Inspect the blocked review and authorize a targeted repair.",
  };
}
const REPAIR_STEERING_BOUNDARY = "Author steering queued after independently reviewed correction";
const MAX_IDEA_ATTEMPTS = 3;
const ideaDispatchFile = (job: JobStartResult) => join(job.stateDir, "generation-idea-dispatch.json");
function selectIdeaTask(s: State, head: string, tasks: Awaited<ReturnType<typeof scheduleIdeasAtBoundary>>["tasks"],
  next: ExecutionItem | null): IdeaTask | null {
  if (!s.inventory || !s.inventory.items.some(i => i.stage === "architecture" && i.status === "verified") ||
      isFocusedScope(s.request.contract)) return null;
  const scope = new Set(s.inventory.audit?.scopedRecords ?? s.request.contract.scope.targets);
  for (const task of tasks) {
    if (!task.eligible || !task.candidates.length ||
        s.request.contract.scope.kind !== "full-story" && !task.scopeIds.some(id => scope.has(id))) continue;
    const action = task.status === "dormant" ? "place" : task.reviewRequired ? "reassess" : null;
    if (!action || action === "place" && task.candidates.length < 2 && next?.stage !== "review" && next !== null) continue;
    const attempted = s.ideaHistory.filter(h => h.id === task.id);
    if (attempted.length >= MAX_IDEA_ATTEMPTS || attempted.some(a => a.signature === task.signature)) continue;
    return { id: task.id, action, signature: task.signature, priorHead: head };
  }
  return null;
}
/** External graph invocation, distinct from persisted internal checkpoint state.
 * Studio uses this to mark mandatory author inputs as required. The stable
 * state channels below remain available to replay/resume independently. */
export const GenerationInputSchema = z.object({
  request: z.object({
    story: z.string().trim().min(1),
    job: z.string().trim().min(1),
    task: z.string().trim().min(1),
    contract: z.object({
      scope: z.object({
        kind: z.enum(["full-story", "partial"]),
        depth: z.enum(["architecture", "interactive", "composition"]).optional(),
        preset: z.enum(["architecture-outline", "interactive-development", "full-composition"]).optional(),
        targets: z.array(z.string()),
        branches: z.array(z.string()),
        supportingTargets: z.array(z.string()).optional(),
        creates: z.array(z.object({
          id: z.string(), path: z.string(), title: z.string(),
          references: z.array(z.string()), dependsOn: z.array(z.string()),
        })).optional(),
      }).refine(scope => scope.depth !== undefined || scope.preset !== undefined,
        "Provide scope.depth or scope.preset"),
      constraints: z.array(z.string()),
      envelope: z.object({
        presentation: z.string().trim().min(1),
        hardLimits: z.array(z.string()),
        preferences: z.array(z.string()),
      }),
    }),
    fixture: z.boolean().optional(),
    skillsSource: z.string().optional(),
    validatorSource: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    turnPlanDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    orchestrationPolicy: z.enum(["explicit", "fixture-legacy"]).optional(),
  }),
  pauseAfter: z.enum(generationStages).nullable().optional(),
});

const Channels = Annotation.Root({
  recovery: Annotation<AdaptiveRecovery | null>({ reducer: (_, next) => next, default: () => null }),
  unknownRecovery: Annotation<UnknownRecoveryStatus | null>({ reducer: (_, next) => next, default: () => null }),
  operationRecovery: Annotation<GenerationOperationRecovery | null>({ reducer: (_, next) => next, default: () => null }),
  request: Annotation<GenerationRequest>(),
  cursor: Annotation<number>({ reducer: (_, next) => next, default: () => 0 }),
  completedStages: Annotation<GenerationEvidence[]>({ reducer: (_, next) => next, default: () => [] }),
  status: Annotation<Status>(),
  reason: Annotation<string | null>(),
  result: Annotation<{ status: string; headSha?: string } | null>(),
  planVersion: Annotation<number | null>(),
  pauseAfter: Annotation<Stage | null>(),
  inventory: Annotation<GenerationInventory | null>(),
  active: Annotation<ExecutionItem | null>(),
  failures: Annotation<Record<string, string>>(),
  ideaTask: Annotation<IdeaTask | null>(),
  ideaResult: Annotation<IdeaResult | null>(),
  ideaHistory: Annotation<IdeaHistoryEntry[]>({ reducer: (_, next) => next, default: () => [] }),
  escalation: Annotation<GenerationEscalation | null>(),
  /** Independently checkpointed identity prevents reselecting after receipt loss. */
  orchestratorSnapshotId: Annotation<string | null>(),
  /** Only a dependency-safe preference over the same pinned assignments. */
  orchestratorOrder: Annotation<string[] | null>(),
  /** Exact model proposal, rationale and transcript identity across replay. */
  orchestratorPlanningDigest: Annotation<string | null>(),
  /** Source-bound changes to remaining, never already-authored, assignments. */
  pendingOrder: Annotation<string[] | null>(),
  pendingVersion: Annotation<number | null>(),
  /** Pin the same Studio/CLI graph Thread as the method-selection receipt. */
  graphThreadId: Annotation<string | null>(),
  adaptiveVersion: Annotation<number | null>(),
  dependencyHistory: Annotation<DependencyHistoryPin[]>({ reducer: (_, next) => next, default: () => [] }),
  /** A sealed source-grounded causal replan request, never write authority. */
  causalAmendment: Annotation<CausalAmendment | null>(),
  /** A controller-admitted prerequisite, before the next dependent dispatch. */
  crossDomainCloseout: Annotation<{ milestoneId: string; planVersion: number;
    sourceSha: string; proposalDigest: string; repairId: string } | null>(),
});
type State = typeof Channels.State;
const openJob = async (s: Pick<State, "request">) => {
  const job = await startStoryJob({ story: s.request.story, job: s.request.job }, false);
  assertNativeVersion(job.validatorVersion);
  return job;
};
function clean(job: JobStartResult) {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[key];
  if (execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: job.worktreeRoot, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim()) throw new Error("Unexpected dirty job worktree; inspect preserved specialist edits before resuming.");
}
export function parseGenerationContract(value: unknown): CompletionContract {
  const contract = parseContract(value);
  if (contract.scope.kind === "partial" && !contract.scope.targets.length)
    throw new Error("Partial generation requires explicit typed Story record targets.");
  return contract;
}
async function checkPlan(job: JobStartResult, request: GenerationRequest, version: number | null | undefined) {
  if (request.turnPlanDigest) {
    const path = join(job.stateDir, "turn-plan.json");
    const contract = existsSync(path)
      ? (JSON.parse(await readFile(path, "utf8")) as { contract: CompletionContract }).contract
      : request.contract;
    await readTurnEvidence(job, contract, request.task, request.turnPlanDigest);
  }
  const file = join(job.stateDir, "architecture.json");
  if (!existsSync(file)) {
    if (version != null) throw new Error("Pinned architecture receipt is missing; restore it before resuming.");
    return null;
  }
  const receipt = JSON.parse(await readFile(file, "utf8"));
  verifyPlanHistory(job, receipt);
  if (receipt.plan && (JSON.stringify(receipt.plan.contract) !== JSON.stringify(request.contract) ||
      version != null && receipt.plan.version !== version)) {
    const original = receipt.history.find((entry: any) => entry.plan.version === (version ?? 1));
    if (!original || JSON.stringify(original.plan.contract) !== JSON.stringify(request.contract))
      throw new Error("Stale generation authorization: no controller-approved transition from the pinned completion contract.");
  }
  return receipt;
}
/** The original source-bound Architecture order affects only ready-item
 * selection, never the canonical inventory, Git ancestry or carry-forward
 * checkpoint identity. Later amended plans retain their own controller order. */
function causalDispatchPriority(receipt: {
  worker?: string; milestoneOrder?: string[];
  plan?: import('./architecture.js').Plan;
} | null, preferred?: readonly string[]): readonly string[] | undefined {
  if (receipt?.worker !== 'pi' || !receipt.plan || !Array.isArray(receipt.milestoneOrder))
    return preferred;
  const actual = receipt.plan.items.filter(item => item.kind === 'realization')
    .flatMap(item => item.targetIds.filter(id => id.startsWith('milestone.')));
  if (actual.length !== receipt.milestoneOrder.length ||
      new Set(actual).size !== actual.length ||
      actual.some((id, index) => id !== receipt.milestoneOrder![index]))
    return preferred; // Later controller-approved scopes cannot inherit a stale order.
  return withCausalEventPriority(receipt.plan, preferred);
}
/**
 * The parent graph can checkpoint a failure after a child has committed and
 * published its trusted receipt. Clear only that failure when the *current*
 * Git HEAD is independently branchable and the next specialist has never
 * started. This does not repair, discard, or repeat an interrupted writer.
 */
async function reconciledFailures(job: JobStartResult, failures: Record<string, string>,
  previousInventoryHead?: string | null) {
  if (!Object.keys(failures).length) return failures;
  const currentHead = await trustedHead(job);
  // Clearing a failed assignment at the SAME observed HEAD creates an
  // unbounded dispatch/failure/reconcile loop. Only a NEW externally settled
  // commit since the previous controller inventory may remove this failure;
  // the exact checkpoint below still must prove the specialist identity.
  const finalizedFixtureWorldCrash = failures.foundations ===
    "Injected recovery crash after Git commit and before checkpoint finalization.";
  // A fixture World crash is the one supported exception: the same HEAD
  // changes from ineligible to eligible when the original native receipt is
  // finalized by checkpoint reconciliation. It cannot authorize a new writer.
  if ((!previousInventoryHead || previousInventoryHead === currentHead) &&
      !finalizedFixtureWorldCrash) return failures;
  const point = (await inspectRecoveryCheckpoints(job))
    .find(record => record.eligible && record.commitSha === currentHead);
  if (!point) return failures;
  const retryable = (key: string) => {
    if (key === "foundation" && point.workItem === "foundation" ||
        key === "architecture" && point.workItem === "global-architecture") return true;
    if (key.startsWith("event:milestone.") &&
        point.workItem === "event-" + key.slice("event:milestone.".length)) return true;
    if (key.startsWith("composition:milestone.") &&
        point.workItem === "composition-" + key.slice("composition:milestone.".length)) return true;
    if (key.startsWith("focus:") && key === point.workItem) return true;
    if (key === "foundations" && ["world-foundations", "character-foundations"].includes(point.workItem)) {
      const path = join(job.stateDir, "character-world.json");
      if (!existsSync(path)) return false;
      return readFile(path, "utf8").then(raw => {
        const receipt = JSON.parse(raw) as { jobId?: string; units?: Array<{
          id: string; phase: string; commitSha?: string; beforeHead?: string }> };
        if (receipt.jobId !== job.jobId || receipt.units?.[0]?.id !== "world-foundations" ||
            receipt.units[1]?.id !== "character-foundations" ||
            receipt.units[0].phase !== "committed") return false;
        if (point.workItem === "world-foundations") return receipt.units[0].commitSha === currentHead &&
          receipt.units[1].phase === "pending" && !receipt.units[1].beforeHead;
        return receipt.units[1].phase === "committed" && receipt.units[1].commitSha === currentHead;
      }).catch(() => false);
    }
    if (key.startsWith("interactive:milestone.") &&
        point.workItem.startsWith("interactive-")) {
      const slug = key.slice("interactive:milestone.".length);
      if (!["interactive-choice-" + slug, "interactive-puzzle-" + slug].includes(point.workItem)) return false;
      const path = join(job.stateDir, "interactive-items", slug + ".json");
      if (!existsSync(path)) return false;
      return readFile(path, "utf8").then(raw => {
        const receipt = JSON.parse(raw) as { jobId?: string; units?: Array<{
          id: string; phase: string; commitSha?: string; beforeHead?: string }> };
        if (receipt.jobId !== job.jobId || receipt.units?.[0]?.phase !== "committed") return false;
        if (point.workItem === "interactive-choice-" + slug)
          return receipt.units[0].commitSha === currentHead &&
            receipt.units[1]?.phase === "pending" && !receipt.units[1].beforeHead;
        return receipt.units[1]?.phase === "committed" &&
          receipt.units[1].commitSha === currentHead;
      }).catch(() => false);
    }
    return false;
  };
  const next = { ...failures };
  for (const key of Object.keys(next)) {
    // A World checkpoint before Character is normally retryable only after
    // an independently verified review handoff. The one deterministic fixture
    // crash injected AFTER the exact Git commit is also recoverable when the
    // matching fixture receipt and finalized checkpoint are independently
    // authenticated. No live Pi interruption or arbitrary failure qualifies.
    const fixturePostCommitCrash = key === "foundations" && point.workItem === "world-foundations" &&
      next[key] === "Injected recovery crash after Git commit and before checkpoint finalization." &&
      await readFile(join(job.stateDir, "character-world.json"), "utf8")
        .then(raw => (JSON.parse(raw) as { worker?: string }).worker === "fixture")
        .catch(() => false);
    if (key === "foundations" && !fixturePostCommitCrash &&
        !/(?:required independent (?:specialist )?review is pending|independent (?:specialist )?review (?:is )?required|await(?:s|ing) (?:an? )?independent (?:specialist )?review)/i.test(next[key]!)) continue;
    if (await retryable(key)) delete next[key];
  }
  return next;
}
/** Apply only exact verified controller review receipts. A pending/failed
 * specialist review blocks its transitive dependents, not independent work. */
async function reviewGatedInventory(job: JobStartResult, inventory: GenerationInventory) {
  const checkpoints = (await inspectRecoveryCheckpoints(job)).filter(point =>
    point.eligible && point.assurance);
  const inherited = resolvedInheritedRecoveryReviews(readRecoveryFork(job)?.reviewCoverage ?? []);
  const resolved = await resolvedCheckpointReviews(job, checkpoints);
  const decisions = [
    ...inherited.map(point => ({ assignmentId: executionId(point.workItem), status: point.status })),
    ...checkpoints.filter(point => !point.workItem.startsWith("repair-"))
      .map(point => ({ assignmentId: executionId(point.workItem),
      status: resolved.get(point.commitSha) ??
        (point.semanticReview === "untracked" ? "required-pending" as const : point.semanticReview) })),
  ];
  const blocked = blockedByRequiredReview(inventory.items, decisions);
  if (!blocked.size) return inventory;
  return { ...inventory, items: inventory.items.map(item =>
    blocked.has(item.id) && item.status === "pending" ? {
      ...item, status: "blocked" as const,
      blockingReason: "Required independent specialist review is pending or failed for a dependency.",
    } : item) };
}
async function reconcile(s: State, job: JobStartResult, allowAmend = true): Promise<Partial<State>> {
  await verifyPinnedPendingWork(job, s.request.turnPlanDigest, s.pendingVersion);
  const receipt = await checkPlan(job, s.request, s.planVersion);
  const plan = receipt?.plan;
  const request = plan ? { ...s.request, contract: plan.contract } : s.request;
  const head = await trustedHead(job);
  if (s.causalAmendment && plan?.version === s.causalAmendment.source.planVersion) {
    if (!s.inventory || head !== s.causalAmendment.source.sha ||
        s.inventory.planVersion !== plan.version)
      throw Error("Pending causal amendment is stale; reconcile before scheduling an upstream writer.");
    const sealed = await inspectCausalAmendment(job, {
      sourceSha: head, reportDigest: s.causalAmendment.source.reportDigest,
      milestoneId: s.causalAmendment.source.milestoneId,
      inventory: s.inventory, plan,
      validatorSource: s.request.validatorSource ?? s.request.skillsSource,
    });
    if (!isDeepStrictEqual(sealed, s.causalAmendment))
      throw Error("Checkpointed causal amendment differs from its source-bound Event report.");
    // Other ready Milestones must not advance HEAD while an amendment awaits
    // author disposition against this exact source revision.
    return { request, status: "paused",
      reason: "Source-bound causal amendment awaits author disposition at " + head +
        ". Approve its exact digest or reconcile the sealed proposal before Story work resumes.",
      active: null, ideaTask: null, result: null };
  }
  // Failed specialists own persistent recovery receipts. Later commits from
  // independent clusters do not permit replay against a changed HEAD.
  // A new authorized plan is the boundary for reconsidering local failures.
  const failures = await reconciledFailures(job,
    s.inventory?.planVersion === (plan?.version ?? null) ? s.failures ?? {} : {},
    s.inventory?.headSha);
  const inherited = readRecoveryFork(job)?.completedStages ?? [];
  const evidence = [...inherited.filter(old => !s.completedStages.some(current =>
    current.stage === old.stage && current.milestone === old.milestone)), ...s.completedStages];
  let completedStages = evidence.filter(e => {
    if (e.stage === "foundation" || !plan) return true;
    if (e.stage === "architecture") return receipt.phase === "committed";
    const version = e.planVersion ?? s.planVersion ?? 1;
    if (e.stage === "review") return version === plan.version && e.headSha === head;
    const stage = e.stage === "choice" || e.stage === "puzzle" ? "interactive" : e.stage;
    return hasPlanContinuity(job, receipt, e.milestone ? `${stage}:${e.milestone}` : stage, version);
  });
  // A commitless Event-only disposition must be reauthenticated at every
  // scheduler restart, including forks. Completed graph stage flags alone are
  // not authority to skip required Choice/Puzzle writers.
  for (const item of completedStages.filter(e => e.stage === "interactive" && e.milestone)) {
    const slug = item.milestone!.slice("milestone.".length);
    const path = join(job.stateDir, "interactive-items", slug + ".json");
    if (!existsSync(path)) throw Error("Checkpointed interactive work lost its saved specialist receipt.");
    const saved = JSON.parse(await readFile(path, "utf8")) as {
      eventHead?: string; planDigest?: string; worker?: string; planVersion?: number; units?: Array<{
        phase?: string; beforeHead?: string; commitSha?: string; eventOnly?: EventOnlyRef }>;
    };
    if (saved.units?.[0]?.phase === "not-applicable" || saved.units?.[0]?.eventOnly) {
      if (!saved.units[0]?.eventOnly ||
          saved.units[0].phase !== "not-applicable" ||
          saved.units[1]?.phase !== "not-applicable" ||
          JSON.stringify(saved.units[0].eventOnly) !== JSON.stringify(saved.units[1]?.eventOnly) ||
          saved.units.some(unit => unit.commitSha))
        throw Error("Checkpointed Event-only omission has a missing or fabricated specialist unit.");
      const proof = await readEventOnlyOmission(job, item.milestone!, saved.units[0].eventOnly);
      if (proof.eventHead !== saved.eventHead || proof.planDigest !== saved.planDigest ||
          proof.reviewMode !== saved.worker || proof.planVersion !== saved.planVersion ||
          proof.reviewHead !== saved.units[0].beforeHead ||
          proof.reviewHead !== saved.units[1]?.beforeHead || item.headSha !== proof.reviewHead)
        throw Error("Checkpointed Event-only omission no longer matches its original Story revision.");
    }
  }
  // A new full-Story Turn on a verified existing Story preserves its already
  // approved Creative Direction. The original author's canon is not a license
  // for a new discovery interview or a speculative replacement writer.
  // A pinned Chat handoff or unfinished foundation receipt always takes
  // precedence over this read-only reuse test.
  if (!isFocusedScope(request.contract) &&
      !completedStages.some(e => e.stage === "foundation") &&
      !existsSync(join(job.stateDir, "foundation.json")) &&
      !existsSync(join(job.stateDir, "chat-approved-foundation.json"))) {
    const baseline = await validateStoryJob(job, request.validatorSource ?? request.skillsSource,
      { ...job, baseSha: head });
    if (await reusableExistingFoundation(job, baseline))
      completedStages = [{ stage: "foundation", headSha: head, status: "committed" }, ...completedStages];
  }
  // A focused request starts from committed canonical Story context. Never
  // dispatch whole-Story discovery to fill a missing prerequisite implicitly.
  if (isFocusedScope(request.contract) && !completedStages.some(e => e.stage === "foundation")) {
    const baseline = await validateStoryJob(job, request.validatorSource ?? request.skillsSource,
      { ...job, baseSha: head });
    const report = baseline.report as { readiness?: { design?: { stages?: {
      foundation?: { minimum?: string } } } }; protection?: { status?: string; changes?: unknown[]; warnings?: unknown[] } } | undefined;
    if (baseline.status !== "passed" || report?.readiness?.design?.stages?.foundation?.minimum !== "passed" ||
        report?.protection?.status !== "checked" || report.protection.changes?.length || report.protection.warnings?.length)
      throw new Error("Focused scope is missing verified upstream Creative Direction or protected canonical context. " +
        "Author must supply or authorize prerequisite development; whole-Story foundation will not run automatically.");
    completedStages = [{ stage: "foundation", headSha: head, status: "committed" }, ...completedStages];
  }
  // A controller-approved plan revision may require another architecture unit before downstream work.
  if (plan && receipt.phase !== "committed") {
    if ((s.adaptiveVersion ?? 1) > 1)
      throw Error("An amended adaptive plan cannot be silently replaced by unfinished Architecture; reconcile its verified checkpoints.");
    const inventory = await reviewGatedInventory(job, reconcileInventory(plan, undefined, head,
      completedStages, failures, s.inventory));
    return { request, planVersion: plan.version, completedStages, failures, inventory,
      active: nextExecutionItem(inventory,
        causalDispatchPriority(receipt, s.pendingOrder ?? s.orchestratorOrder ?? undefined)) ?? null };
  }
  const validation = plan && completedStages.some(e => e.stage === "architecture")
    ? await validateStoryJob(job, request.validatorSource ?? request.skillsSource, { ...job, baseSha: head }) : undefined;
  const canonicalPrevious = await canonicalPreviousAdaptiveInventory(job,
    request.turnPlanDigest, plan?.version ?? null, s.inventory, s.adaptiveVersion);
  const inventory = await reviewGatedInventory(job,
    reconcileInventory(plan, validation, head, completedStages, failures, canonicalPrevious));
  const pending = await reconcilePendingWork(job, request, inventory, canonicalPrevious, validation, allowAmend);
  let adaptive: Awaited<ReturnType<typeof reconcileAdaptiveWork>> | null = null;
  try {
    if (plan && validation && receipt.phase === "committed") adaptive = await reconcileAdaptiveWork({
      job, request, plan, validation, inventory: pending.inventory, completed: completedStages,
      graphThreadId: s.graphThreadId, pinnedVersion: s.adaptiveVersion, allowAmend, recovery: s.recovery });
  } catch (error) {
    if (error instanceof AdaptiveRecoveryRequired) {
      const same = s.recovery?.signature === error.decision.signature;
      if (same && s.recovery?.phase === "protocol-exhausted") return {
        status: "blocked", active: null, reason: "protocol-exhausted: the original adaptive response allowance is spent.",
      };
      const recovery = same && !allowAmend ? s.recovery : error.decision;
      return { request, planVersion: plan!.version, completedStages, failures, active: null, recovery,
        reason: !allowAmend && s.reason ? s.reason : "Adaptive planner response requires original-session protocol correction." };
    }
    if (error instanceof ProtocolExhaustedError && s.recovery?.phase === "authorized" && error.contract === s.recovery.check)
      return { request, completedStages, planVersion: plan!.version, active: null,
        status: "blocked", reason: error.message, recovery: { ...s.recovery, phase: "protocol-exhausted" } };
    throw error;
  }
  if (s.recovery && s.recovery.phase !== "completed" && !adaptive?.recovered)
    throw Error("Unsettled adaptive correction lost its recovery evidence; scheduling refused");
  const effective = adaptive?.inventory ?? pending.inventory;
  const pendingOrder = adaptive?.order ?? pending.order ?? s.pendingOrder ?? null;
  return { request, planVersion: plan?.version ?? null, completedStages, failures,
    ...(plan?.version !== s.causalAmendment?.source.planVersion ? { causalAmendment: null } : {}),
    ...(adaptive?.recovered && s.recovery?.phase === "authorized" ?
      { recovery: { ...s.recovery, phase: "completed" as const }, reason: null } : {}),
    inventory: effective, pendingOrder, pendingVersion: pending.stateVersion,
    adaptiveVersion: adaptive?.version ?? s.adaptiveVersion ?? null,
    active: nextExecutionItem(effective,
      causalDispatchPriority(receipt, pendingOrder ?? s.orchestratorOrder ?? undefined)) ?? null };
}
/** The DB receipt and the private graph amendment must never diverge. A
 * missing file after an applied receipt cannot silently restore the old plan;
 * an unacknowledged file cannot be dispatched before crash reconciliation. */
async function assertSteeringReceipts(job: JobStartResult, turnDigest: string,
  pendingMessages?: Set<string>): Promise<void> {
  const adapter = currentSteeringBoundary();
  if (!adapter) return;
  const saved = await readSteeringPlan(job, turnDigest);
  const receipts = await adapter.receipts(job);
  for (const receipt of receipts) {
    const entry = saved?.entries.find(item => item.messageId === receipt.messageId);
    if (!entry || entry.digest !== receipt.amendmentDigest ||
        entry.sourceSha !== receipt.sourceSha)
      throw Error('A committed steering amendment is missing or mismatched after restart; preserve the Story for reconciliation.');
  }
  if (saved?.entries.some(entry => !receipts.some(row => row.messageId === entry.messageId) &&
      !pendingMessages?.has(entry.messageId)))
    throw Error('An unacknowledged steering amendment has lost its author message; manual reconciliation is required.');
  if (pendingMessages === undefined && saved?.entries.some(entry =>
    !receipts.some(row => row.messageId === entry.messageId)))
    throw Error('A pending steering receipt must settle before another writer can dispatch.');
}

/** The only plan-affecting steering intake: an idle, locked, native-verified
 * generation boundary. The active Pi writer has already settled, and neither
 * a delivered SDK message nor an unsent queued steer grants new write scope. */
async function applyLiveSteeringAtBoundary(job: JobStartResult, request: GenerationRequest,
  inventory: GenerationInventory | null): Promise<Partial<State> | null> {
  const adapter = currentSteeringBoundary();
  if (!adapter || !request.turnPlanDigest || !inventory ||
      !inventory.items.some(item => item.stage === "architecture" && item.status === "verified"))
    return null;
  const inputs = await adapter.pending(job);
  await assertSteeringReceipts(job, request.turnPlanDigest,
    new Set(inputs.map(input => input.messageId)));
  if (!inputs.length) return null;
  const head = await trustedHead(job);
  if (head !== inventory.headSha)
    throw Error("Steering boundary inventory changed before author direction was admitted.");
  const turn = await readTurnEvidence(job, request.contract, request.task, request.turnPlanDigest);
  if (!turn?.objective) throw Error("Live steering requires a pinned objective and Turn plan.");
  const validation = await validateStoryJob(job, request.validatorSource ?? request.skillsSource,
    { ...job, baseSha: head });
  const report = validation.report as { records?: import("./focused-scope.js").CanonicalScopeRecord[];
    diagnostics?: unknown[]; protection?: { status?: string; base?: string;
      changes?: unknown[]; warnings?: unknown[] } } | undefined;
  if (validation.status !== "passed" || !Array.isArray(report?.records) ||
      !Array.isArray(report.diagnostics) || report.diagnostics.length ||
      report.protection?.status !== "checked" || report.protection.base !== head ||
      report.protection.changes?.length || report.protection.warnings?.length)
    throw Error("Live steering cannot amend an unverified canonical or protected Story boundary.");
  for (const input of inputs) {
    const isAncestor = input.submittedHead === null ||
      steeringSourceIsAncestor(job, input.submittedHead, head);
    const diff = isAncestor && input.submittedHead && input.submittedHead !== head
      ? dependencyGit(job, "diff", "--name-only", input.submittedHead, head, "--")
        .split("\n").filter(Boolean).map(path => job.storyRelativePath &&
          path.startsWith(job.storyRelativePath + "/")
          ? path.slice(job.storyRelativePath.length + 1) : path)
      : [];
    const prior = await readSteeringPlan(job, turn.digest);
    const proposed = proposeSteeringAmendment({
      steering: input, jobId: job.jobId, threadId: input.threadId,
      headSha: head, inventory, turn, catalog: report.records,
      changedSinceSubmission: diff, prior,
    });
    const decision = isAncestor ? proposed.decision : {
      messageId: input.messageId, content: input.content, kind: "review-required" as const,
      sourceSha: head, amendmentDigest: null,
      reason: "Steering submission does not belong to the current verified Story ancestry.",
    };
    if (isAncestor && proposed.amendment)
      await saveSteeringAmendment(job, turn, proposed.amendment);
    await adapter.settle(job, decision);
    if (decision.kind === "review-required")
      return { status: "paused", reason: "Author approval required for live steering: " +
        decision.reason + " The original scope and verified work remain preserved." };
  }
  return null;
}

async function dispatch(s: Pick<State, "request" | "active">) {
  const input = s.request;
  // Pre-cutover jobs retain their exact historical dispatch path. Modern
  // pinned Turns load their saved amendment even on CLI recovery, so bypassing
  // the Studio adapter can never silently discard applied author steering.
  const turnDigest = input.turnPlanDigest;
  const steering = turnDigest
    ? await (async () => {
      const job = await openJob(s);
      await assertSteeringReceipts(job, turnDigest);
      return steeringForAssignment(job, turnDigest, s.active!.id, await trustedHead(job));
    })()
    : "";
  const guidedTask = adaptiveDispatchTask(steering ? input.task + "\n\nSAFE-BOUNDARY AUTHOR PLAN AMENDMENT:\n" + steering : input.task, s.active!);
  const milestone = s.active?.milestone!;
  switch (s.active?.stage) {
    case "foundation": return runFoundationJob({ ...input, envelope: JSON.stringify(input.contract.envelope) });
    case "architecture": return runArchitectureJob({ ...input, action: "run" });
    case "foundations": return runCharacterWorldJob({ ...input, steering, action: "run" });
    case "event": return runEventWorkItem({ ...input, task: guidedTask, milestone, action: "run" });
    case "interactive": return runInteractiveWorkItem({ ...input, task: guidedTask, milestone, action: "run" });
    case "choice": return runInteractiveWorkItem({ ...input, task: guidedTask, milestone, action: "run", unit: "choice" });
    case "puzzle": return runInteractiveWorkItem({ ...input, task: guidedTask, milestone, action: "run", unit: "puzzle" });
    case "composition": return runCompositionWorkItem({ ...input, task: guidedTask, milestone, action: "run" });
    case "focus": return runFocusedWorkItem({ ...input, target: milestone, task: input.task, steering });
    case "review": return runNarrativeReview({ ...input, action: "run" });
    default: throw new Error("Invalid generation stage.");
  }
}
/** Test seam for exercising the real specialist dispatcher without introducing
 * a fixture-only authority path into the production scheduler. */
export async function dispatchGenerationAssignment(s: { request: GenerationRequest; active: ExecutionItem }):
  Promise<{ status: string; headSha?: string }> {
  return dispatch(s);
}
const accepted: Record<Stage, readonly string[]> = {
  foundation: ["committed"], architecture: ["architecture-committed", "complete-in-scope"],
  foundations: ["foundations-committed"], event: ["event-cluster-committed"],
  interactive: ["interactive-slice-committed"], choice: ["interactive-choice-committed"],
  puzzle: ["interactive-slice-committed"], composition: ["composition-committed"],
  focus: ["focused-committed"],
  review: ["complete-in-scope", "editorial-unverified", "blocked"],
};
async function operationFailure(s: State, job: JobStartResult, operation: Operation,
  error: unknown, evidence: GenerationOperationRecovery["evidence"],
  outcome: GenerationOperationRecovery["outcome"] = "exception",
  safeAction?: GenerationOperationRecovery["safeAction"],
  graphThreadId?: string): Promise<Partial<State>> {
  // Execution controls remain resumable controls, not recovery incidents.
  if (error instanceof Error && ["PiBudgetPause", "FoundationAuthorRequiredError",
    "SpecialistChoiceRequiredError", "StoryCancelledError"].includes(error.name))
    return blocked(error);
  const reason = error instanceof Error ? error.message : String(error);
  const operationRecovery = await assessGenerationOperation({ job,
    threadId: s.graphThreadId ?? graphThreadId ?? job.threadId + ":generation",
    turnDigest: s.request.turnPlanDigest, planVersion: s.planVersion, operation,
    outcome, reason, evidence, safeAction });
  return { operationRecovery, reason: "Assessing " + operation + " failure; no new writer has been authorized." };
}
function blocked(error: unknown): Partial<State> {
  const e = error as { message?: string; name?: string };
  return { status: ["PiBudgetPause", "FoundationAuthorRequiredError", "SpecialistChoiceRequiredError"].includes(e.name ?? "") ? "paused" :
    e.name === "StoryCancelledError" ? "cancelled" : "blocked",
    reason: e.message ?? String(error), result: null };
}
async function authorBoundary(job: JobStartResult, s: State): Promise<Partial<State> | null> {
  const updates = await processAuthorUpdatesAfterWork(job);
  if ("error" in updates) {
    if (["PiBudgetPause", "FoundationAuthorRequiredError", "SpecialistChoiceRequiredError",
      "StoryCancelledError"].includes(updates.errorName ?? ""))
      return blocked({ name: updates.errorName, message: updates.error });
    return operationFailure(s, job, "author-update-intake",
      updates.error, { reference: "author-updates" });
  }
  if (updates.status === "ready") return null;
  return { status: updates.status === "paused" ? "paused"
    : updates.status === "cancelled" ? "cancelled" : "blocked",
    reason: updates.blockers.join(", ") };
}

/** A native-validated checkpoint does not complete a dependent assignment
 * until its selected independent semantic review is sealed. The reviewer is
 * read-only; the rejected original writer gets only a bounded repair lease.
 * Preserve s.result across pauses, otherwise LangGraph could replay the
 * already-committed specialist on resume. */
async function independentAssignmentBoundary(s: State): Promise<Partial<State>> {
  if (s.request.fixture || !s.result || !s.active ||
      s.result.status !== "review-handoff" &&
      !accepted[s.active.stage].includes(s.result.status)) return {};
  const job = await openJob(s);
  try {
    // A fork does not inherit author approval grants, but it MUST retain the
    // exact source Turn's read-only review criteria. Legacy forks that lost
    // them are unsafe to advance beyond a committed specialist checkpoint.
    if (job.recoveryFork && !await readReviewTurnEvidence(job))
      throw Error("Recovered real-Pi Story lost its original independent-review Turn; " +
        "no downstream specialist may start until a new verified continuation is prepared.");
    const { runPiAssignmentReview } = await import("./semantic-assignment-review.js");
    const { advanceRejectedRepair } = await import("./rejected-review-repair.js");
    const { createSkillSnapshot } = await import("./snapshot.js");
    const { loadSkillConfig } = await import("./skills.js");
    const { inspectPiPolicy } = await import("./job-pi-policy.js");
    const history = await inspectRecoveryCheckpoints(job);
    if (job.recoveryFork && history.some(point => point.eligible && !point.assurance))
      throw Error("Recovered Story has a native-verified specialist checkpoint without " +
        "independent-review assurance; do not dispatch Choice or other dependent work.");
    const points = history
      .filter(point => point.eligible && point.assurance &&
        point.assurance.reviewSelection.status === "required-pending")
      .sort((a, b) => a.completedWorkItems.length - b.completedWorkItems.length);
    const effective = await resolvedCheckpointReviews(job, points);
    if (s.result.status === "review-handoff" && !points.length)
      throw Error("A specialist paused at a mandatory review handoff without a reviewable checkpoint.");
    for (const point of points) {
      if (effective.get(point.commitSha) === "not-required" ||
          point.semanticReview === "passed") continue;
      if (point.semanticReview === "required-pending") {
        const config = s.request.skillsSource
          ? { discovery: "explicit-only" as const, novelteaSkills: s.request.skillsSource,
              skillDirs: [], requiredSkills: [] }
          : await loadSkillConfig(undefined, false);
        const snapshot = await createSkillSnapshot({
          ...config, requiredSkills: ["nt-narrative-review", "nt-catalog"] });
        if (!snapshot) throw Error("Mandatory semantic review lacks pinned narrative-review skills.");
        const { policy } = await inspectPiPolicy(job);
        await withStoryJobLock(job, "independent-assignment-review", () =>
          runPiAssignmentReview(job, [point], {
            snapshot, provider: s.request.provider ?? policy.profile.provider,
            model: s.request.model ?? policy.profile.model,
            thinking: policy.profile.thinking === "low" || policy.profile.thinking === "high"
              ? policy.profile.thinking : undefined,
            reviewer: "independent-pi-assignment-review", onSession: async () => {},
          }));
      }
      const reviewed = (await inspectRecoveryCheckpoints(job))
        .find(saved => saved.eligible && saved.commitSha === point.commitSha);
      if (!reviewed || reviewed.semanticReview === "required-pending")
        throw Error("Independent semantic reviewer did not seal a source-linked decision.");
      if (reviewed.semanticReview === "failed") {
        const progress = await advanceRejectedRepair(job, point.commitSha, {
          skillsSource: s.request.skillsSource, provider: s.request.provider,
          model: s.request.model,
          canYieldForSteering: async () => !!s.request.turnPlanDigest &&
            !!s.inventory?.items.some(item => item.stage === "architecture" &&
              item.status === "verified") && !!s.active && !!s.result &&
            (await checkPlan(job, s.request, s.planVersion))?.plan?.version === s.planVersion,
        });
        if (progress.next === "completed") {
          const { finalizeReviewEventDependency } = await import("./dependency-state.js");
          await withStoryJobLock(job, "event-dependency-review-completion", () =>
            finalizeReviewEventDependency(job, point.commitSha));
        }
        if (progress.next === "steering-boundary")
          return { reason: REPAIR_STEERING_BOUNDARY };
        if (progress.next === "controller-replan" && progress.state.outOfAuthority) {
          try {
            const source = await (await import("./checkpoint-assurance.js")).inspectCheckpointReview(job, point);
            const turn = await readTurnEvidence(job, s.request.contract, s.request.task,
              s.request.turnPlanDigest);
            const original = turn?.assignments.find(a => a.id === point.assurance?.assignmentId);
            if (source?.status !== "failed" || !source.result || !point.assurance ||
                !original || !turn || !s.request.turnPlanDigest)
              throw Error("Cross-owner correction lacks the original reviewed Turn and assignment.");
            // A later reviewed Event is a descendant, not necessarily the
            // immediate child, of this Turn's original source. Verify its
            // ancestry from Git before admitting the cross-owner source.
            dependencyGit(job, "merge-base", "--is-ancestor",
              turn.source.verifiedSha, point.commitSha);
            const { deriveReviewDependencyRequest } = await import("./review-repair-amendment.js");
            const request = deriveReviewDependencyRequest({
              assurance: point.assurance, review: source.result, original, turn,
              planVersion: point.planVersion!, originWorkItem: point.workItem,
              otherOwnerPath: progress.state.outOfAuthority.path,
            });
            if (request.action !== "controller-amendment-required" ||
                request.classification !== "other-owner")
              return { status: "blocked", reason: "Protected or unapproved prerequisite requires " +
                "an explicit author-approved source-bound amendment; no unrelated writer may dispatch.",
                escalation: {
                  kind: "protected-approval" as const, requiresTrustedApproval: true,
                  sources: request.findings.map(f => ({ source: f.path,
                    message: f.defect, repair: f.requiredCorrection })),
                  action: "Obtain explicit author authority for the protected objective or scope change.",
                } };
            const { recordReviewDependency } = await import("./dependency-state.js");
            const { advanceReviewDependency } = await import("./dependency-work.js");
            const { settleOtherOwnerPrerequisite } = await import("./review-other-owner-controller.js");
            await settleOtherOwnerPrerequisite({
              admit: async () => {
                await withStoryJobLock(job, "other-owner-prerequisite-admission", () =>
                  recordReviewDependency(job, request));
              },
              support: () => advanceReviewDependency({
                story: s.request.story, job: s.request.job, task: s.request.task,
                contract: s.request.contract, skillsSource: s.request.skillsSource,
                validatorSource: s.request.validatorSource, provider: s.request.provider,
                model: s.request.model, turnPlanDigest: request.turnDigest, request,
              }),
              independentlyCovered: async () => {
                const checkpoints = (await inspectRecoveryCheckpoints(job)).filter(point => point.eligible);
                const reviewed = await resolvedCheckpointReviews(job, checkpoints);
                return reviewed.get(request.sourceSha) === "not-required";
              },
            });
            // The corrected upstream source may have been consumed by earlier
            // already-reviewed specialists. The existing selective reviewer
            // rechecks only impacted/unknown consumers and carries proven
            // independent checkpoints forward without replaying their writers.
            const { revalidateOtherOwnerPrerequisite } = await import("./review-other-owner-revalidation.js");
            const { policy } = await (await import("./job-pi-policy.js")).inspectPiPolicy(job);
            await withStoryJobLock(job, "other-owner-dependent-revalidation", () =>
              revalidateOtherOwnerPrerequisite({
                job, request, inventory: s.inventory ?? undefined,
                contract: s.request.contract, task: s.request.task,
                provider: s.request.provider ?? policy.profile.provider,
                model: s.request.model ?? policy.profile.model,
                skillsSource: s.request.skillsSource,
                validatorSource: s.request.validatorSource,
              }));
            if (s.result.status === "review-handoff") {
              const next = s.active.stage === "foundations" ? "character-foundations" :
                ["interactive", "choice", "puzzle"].includes(s.active.stage) && s.active.milestone
                  ? "interactive-" + (s.active.stage === "choice" ? "choice" : "puzzle") +
                    "-" + s.active.milestone.slice(10) : null;
              if (!next) throw Error("Cross-owner review handoff has no original specialist.");
              await assertNativeReviewDependencies(job, next);
              return { result: null, escalation: null };
            }
            return { result: { ...s.result, headSha: await trustedHead(job) },
              escalation: null };
          } catch (error) {
            if (error instanceof Error && error.name === "SpecialistChoiceRequiredError")
              return { status: "paused", escalation: null,
                reason: "The separately authorized supporting specialist is awaiting an authenticated Author Choice; the original negative review remains sealed." };
            const { ProtectedCrossOwnerPrerequisiteError } = await import("./dependency-state.js");
            const protectedChange = error instanceof ProtectedCrossOwnerPrerequisiteError;
            return { status: "blocked",
              reason: "Cross-owner prerequisite remains unresolved: " +
                (error instanceof Error ? error.message : String(error)),
              escalation: { kind: protectedChange ? "protected-approval" as const : "dependency-replan" as const,
                requiresTrustedApproval: protectedChange,
                sources: [{ source: progress.state.outOfAuthority.path,
                  message: progress.state.failure ?? "Other-owner supporting work needed",
                  repair: "controller-amendment" }],
                action: protectedChange
                  ? "Obtain the author\'s explicit approval of this exact protected decision before another specialist writes."
                  : "Inspect the existing source-bound plan, specialist receipt and independent " +
                    "review; reconcile interrupted effects without replaying a claimed writer.",
              } };
          }
        }
        if (progress.next !== "completed") return {
          ...(progress.next === "controller-replan" ? { escalation: {
            kind: "dependency-replan" as const, requiresTrustedApproval: false,
            sources: progress.state.outOfAuthority ? [{
              source: progress.state.outOfAuthority.path,
              message: progress.state.failure ?? "A supporting record is outside the original writer lease.",
              repair: "controller-amendment",
            }] : [],
            action: "Assess the source-linked other-owner dependency against the original Turn " +
              "and propose a separately controller-authorized bounded assignment; " +
              "do not replay the original writer or expand its file permissions.",
          } } : {}),
          status: progress.next === "author-choice" ? "paused" : "blocked",
          reason: progress.next === "author-choice"
            ? "Independent reviewer rejected the specialist draft; the original writer disputes correction. An authenticated Author Choice is pending."
            : progress.next === "author-escalation"
              ? progress.state.failure ?? "Bounded original-session corrections did not pass independent rereview. Author-led scope review is required."
              : progress.next === "controller-replan"
                ? progress.state.failure ?? "Another specialist must provide a separately authorized prerequisite."
                : "Interrupted original-session correction is preserved for manual recovery.",
        };
      }
    }
    if (s.result.status === "review-handoff") {
      const next = s.active.stage === "foundations" ? "character-foundations" :
        ["interactive", "choice", "puzzle"].includes(s.active.stage) && s.active.milestone
          ? "interactive-" + (s.active.stage === "choice" ? "choice" : "puzzle") +
            "-" + s.active.milestone.slice(10) : null;
      if (!next) throw Error("Unexpected multi-specialist review handoff.");
      await assertNativeReviewDependencies(job, next);
      return { result: null }; // Re-enter only the unfinished specialist unit.
    }
    return { result: { ...s.result, headSha: await trustedHead(job) } };
  } catch (error) {
    if (error instanceof (await import("./rejected-review-repair.js")).ReviewDependencyRequiredError) {
      const request = error.request;
      if (request.action === "controller-amendment-required" &&
          request.classification === "new-full-story-record") {
        // A routine Character omission already falls under the approved
        // whole-Story objective. This controller-authorized dependency path
        // must not ask the author to reapprove that creative choice.
        try {
          const { advanceReviewCharacterDependency } = await import("./dependency-work.js");
          const progress = await advanceReviewCharacterDependency({
            story: s.request.story, job: s.request.job, task: s.request.task,
            contract: s.request.contract, skillsSource: s.request.skillsSource,
            validatorSource: s.request.validatorSource,
            provider: s.request.provider, model: s.request.model,
            turnPlanDigest: request.turnDigest, request,
          });
          if (progress.status === "dependency-support-verified") {
            // Event-owned participant/prose correction is a SECOND, bounded
            // original-specialist operation. The Character assignment gives
            // it no write authority; the sealed failure remains negative
            // until the Event repair's new independent checkpoint passes.
            const { advanceRejectedRepair } = await import("./rejected-review-repair.js");
            const repair = await advanceRejectedRepair(job, request.sourceSha, {
              skillsSource: s.request.skillsSource, provider: s.request.provider,
              model: s.request.model,
            });
            if (repair.next === "completed") {
              const { finalizeReviewEventDependency } = await import("./dependency-state.js");
              await withStoryJobLock(job, "event-dependency-review-completion", () =>
                finalizeReviewEventDependency(job, request.sourceSha));
            } else return {
              status: repair.next === "author-choice" ? "paused" : "blocked",
              reason: repair.next === "author-choice"
                ? "The separate Event correction awaits an authenticated saved Author Choice."
                : "The original Event failure remains sealed; its bounded Event-owner correction " +
                  "requires manual reconciliation before Story generation can continue.",
              escalation: repair.next === "author-choice" ? null : {
                kind: "dependency-replan", requiresTrustedApproval: false,
                sources: request.findings.map(f => ({
                  source: f.path + ":" + f.line, message: f.defect, repair: f.requiredCorrection,
                })),
                action: "Inspect the separate Event repair receipt and original Pi session. " +
                  "Do not replay an interrupted writer or expand its single-Event authority.",
              },
            };
          } else if (progress.status !== "dependency-verified")
            throw Error("New supporting Character has not completed its mandatory independent reviews.");
          if (s.result?.status === "review-handoff") {
            await assertNativeReviewDependencies(job, "character-foundations");
            return { result: null, escalation: null };
          }
          return { result: s.result ? { ...s.result, headSha: await trustedHead(job) } : null,
            escalation: null };
        } catch (dependencyError) {
          // A supporting specialist may legitimately ask a protected author
          // question. Preserve its authenticated, paused choice instead of
          // misreporting it as a terminal dependency failure.
          if (dependencyError instanceof Error &&
              dependencyError.name === "SpecialistChoiceRequiredError")
            return { status: "paused",
              reason: "Supporting Character work is awaiting its saved authenticated Author Choice; the original negative review remains sealed.",
              escalation: null };
          return { status: "blocked",
            reason: "The original negative review remains sealed. Supporting Character amendment: " +
              (dependencyError instanceof Error ? dependencyError.message : String(dependencyError)),
            escalation: {
              kind: "dependency-replan",
              sources: request.findings.map(f => ({
                source: f.path + ":" + f.line, message: f.defect, repair: f.requiredCorrection,
              })),
              requiresTrustedApproval: false,
              action: "Inspect the exact source-bound dependency plan and specialist/review receipts. " +
                "A failed or interrupted new Character/Arc-link assignment needs explicit bounded " +
                "reconciliation; do not replay its author or broaden the original failed repair lease.",
            },
          };
        }
      }
      const requiresTrustedApproval = request.action === "author-approval-required";
      return {
        // A protected/scope expansion has no authenticated Author Choice to
        // resume yet. Expose an actionable blocked escalation, never a
        // misleading paused Thread with no saved question or answer path.
        status: "blocked",
        reason: error.message,
        escalation: {
          kind: requiresTrustedApproval ? "protected-approval" : "dependency-replan",
          sources: request.findings.map(f => ({
            source: f.path + ":" + f.line, message: f.defect, repair: f.requiredCorrection,
          })),
          requiresTrustedApproval,
          action: requiresTrustedApproval
            ? "Obtain a source-bound, explicit author-approved scope/protected decision amendment. No original specialist replay or new path is authorized."
            : "A necessary supporting Character/other-owner assignment must be planned and controller-authorized from the sealed review and original whole-Story objective. Authenticate the proposed exact ID/path, owner, Arc-link fields, current HEAD and plan version; then independently review supporting work and the suspended goal. Reviewer prose alone cannot grant writes.",
        },
      };
    }
    return { status: "blocked", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** The production parent graph. Specialists retain ownership of side effects and recovery. */
export function createGenerationGraph(
  checkpointer?: SqliteSaver, executionOwner: "server" | "cli" = "server",
  // Deterministic transport-boundary substitution for graph-level tests.
  // Production callers always use the real sealed review/repair adapter.
  reviewBoundary: (state: State) => Promise<Partial<State>> = independentAssignmentBoundary,
) {
  return new StateGraph(Channels, { input: GenerationInputSchema })
    .addNode("schedule", async (s, config) => {
      // A new graph invocation must not re-enter a fenced or not-yet-assessed
      // external operation. The original checkpoint remains inspectable.
      if (s.operationRecovery?.phase === "fenced") return {
        status: "blocked" as const, reason: s.operationRecovery.nextAction };
      if (s.operationRecovery?.phase === "assessment") return { status: "running" as const };
      const input = GenerationInputSchema.shape.request.safeParse(s.request);
      if (!input.success) return blocked(new Error("Invalid generation request: " +
        input.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")));
      try {
        const contract = parseGenerationContract(input.data.contract);
        const request = { ...input.data, fixture: input.data.fixture ?? false, contract };
        const job = await openJob({ ...s, request } as State);
        await verifyReadyRecoveryFork(job);
        await verifyDependencyHistory(job, s.dependencyHistory ?? []);
        await verifyPinnedPendingWork(job, request.turnPlanDigest, s.pendingVersion);
        const fork = readRecoveryFork(job);
        if (fork && JSON.stringify(request.contract) !== JSON.stringify(fork.contract))
          throw new Error("Fork continuation must retain its approved completion contract; use an explicit plan revision after starting.");
        const graphThreadId = config.configurable?.thread_id as string | undefined;
        if (!graphThreadId?.trim()) throw new Error("Generation requires a durable graph Thread identity.");
        if (executionOwner === "cli") ensureNotServerOwned(job);
        else await claimServerGeneration(job, graphThreadId, request);
        // The trusted controller selects a METHOD, not a worker or write grant.
        // Requests without a policy were checkpointed before this cutover and
        // retain their original legacy plan path; never silently upgrade them.
        const sourceIdentity = {
          task: request.task, kind: request.contract.scope.kind,
          turnPlanDigest: request.turnPlanDigest,
        };
        const hasSelection = await hasStoryOrchestratorSelection(job);
        if (s.orchestratorSnapshotId && !hasSelection)
          throw new Error("Previously selected orchestrator receipt is missing; restore its original pin before resuming.");
        let orchestratorSnapshotId: string | null = null;
        let selection: StoryOrchestratorSelection | null = null;
        if (hasSelection) {
          selection = await loadSelectedStoryOrchestrator(job, graphThreadId, sourceIdentity);
          orchestratorSnapshotId = selection.receipt.skillSnapshot.id;
        } else if (request.orchestrationPolicy === "explicit") {
          const checkout = request.skillsSource ?? process.env.NT_STUDIO_SKILLS_SOURCE ??
            (await loadSkillConfig()).novelteaSkills;
          if (!checkout) throw new Error(
            "Explicit Studio orchestration requires a trusted NovelTea skills checkout; " +
            "nt-story-generate cannot be substituted.");
          selection = await selectStoryOrchestrator(job, graphThreadId, sourceIdentity, checkout);
          orchestratorSnapshotId = selection.receipt.skillSnapshot.id;
        } else if (request.orchestrationPolicy === "fixture-legacy" && !request.fixture) {
          throw new Error("Legacy fixture orchestration cannot run a real Pi writer.");
        } else if (!request.orchestrationPolicy && !request.fixture && !s.cursor &&
                   !s.completedStages?.length) {
          throw new Error("Untagged real-Pi orchestration is not permitted for a new workflow. " +
            "Restore a verified legacy checkpoint or select the pinned orchestrator explicitly.");
        }
        if (s.orchestratorSnapshotId && orchestratorSnapshotId !== s.orchestratorSnapshotId)
          throw new Error("Pinned orchestrator snapshot changed during generation resume.");
        let orchestratorOrder: string[] | null = null;
        let orchestratorPlanningDigest: string | null = null;
        if (selection && request.turnPlanDigest && !request.fixture) {
          const plan = await readTurnEvidence(job, request.contract, request.task, request.turnPlanDigest);
          if (!plan) throw new Error("A selected objective lacks the controller's pinned Turn plan.");
          // A previously started, pre-#149 Turn retains its original receipt and
          // stage graph; it must not acquire a new Pi planning step on resume.
          if (plan.objective) {
            const { inspectPiPolicy } = await import("./job-pi-policy.js");
            const { policy } = await inspectPiPolicy(job);
            const provider = request.provider ?? policy.profile.provider;
            const model = request.model ?? policy.profile.model;
            if (s.orchestratorPlanningDigest && !s.orchestratorOrder)
              throw new Error("Checkpointed orchestrator receipt digest has no assignment order; model replay refused.");
            const receipt = s.orchestratorOrder
              ? await restoreCheckpointedObjectivePlanning(job, selection, plan, provider, model,
                  s.orchestratorPlanningDigest, s.orchestratorOrder)
              : await runPinnedObjectivePlanner(job, selection, plan, provider, model);
            orchestratorOrder = receipt.proposal!.assignments.map(a => a.id);
            orchestratorPlanningDigest = receipt.digest;
          }
        }
        if (s.orchestratorOrder && JSON.stringify(s.orchestratorOrder) !== JSON.stringify(orchestratorOrder))
          throw new Error("Pinned orchestration assignment order changed during resume.");
        if (s.orchestratorPlanningDigest && s.orchestratorPlanningDigest !== orchestratorPlanningDigest)
          throw new Error("Pinned orchestration planning receipt changed during resume.");
        if (s.graphThreadId && s.graphThreadId !== graphThreadId)
          throw Error("Graph Thread changed after original orchestration admission.");
        return { request, graphThreadId, orchestratorSnapshotId, orchestratorOrder, orchestratorPlanningDigest,
          status: "running" as const, reason: null, failures: s.failures ?? {} };
      } catch (error) {
        try { return await operationFailure(s, await openJob(s), "scheduling", error,
          { reference: "generation-checkpoint" }, "exception", undefined,
          config.configurable?.thread_id as string | undefined); }
        catch { return blocked(error); }
      }
    })
    .addNode("assess_recovery", async (s, config) => {
      if (s.unknownRecovery?.phase === "assessment") {
        const target = s.unknownRecovery.case;
        if (!target) return blocked(Error("Unknown recovery has no authenticated failure case."));
        const job = await openJob(s);
        const verify = () => withStoryJobLock(job, "unknown-recovery-proof", async () => {
          clean(job);
          if (await trustedHead(job) !== target.sourceSha ||
              target.jobId !== job.jobId || target.threadId !== job.threadId ||
              target.turnDigest !== (s.request.turnPlanDigest ?? null) ||
              target.planVersion !== s.planVersion)
            throw Error("Unfamiliar failure no longer has trusted Turn/source identity.");
          await checkPlan(job, s.request, s.planVersion);
          const checkpoint = (await inspectRecoveryCheckpoints(job)).find(point =>
            point.eligible && point.commitSha === target.sourceSha &&
            point.workItem === target.checkpoint &&
            (point.semanticReview === "passed" || point.semanticReview === "not-required"));
          if (!checkpoint || !s.inventory || !authorizedInventoryComplete(s.inventory))
            throw Error("Unfamiliar failure lacks an eligible verified/reviewed checkpoint.");
          const current = await inspectJobReport(s.request);
          const same = unknownCompletionCase({
            jobId: job.jobId, threadId: job.threadId,
            turnDigest: s.request.turnPlanDigest ?? null, planVersion: s.planVersion!,
            sourceSha: target.sourceSha, checkpoint: checkpoint.workItem,
            reportStatus: current.generation.status,
            scopeStatus: current.generation.scopeFulfillment,
            planStatus: current.generation.planFulfillment.status,
          });
          if (same.signature !== target.signature || current.generation.status === "completed" ||
              reviewEscalation(current, s.inventory))
            throw Error("Unfamiliar failure state changed or has a deterministic recovery route.");
        });
        let proofTrusted = false;
        try {
          const control = await readJobControl(job);
          if (control === "cancelled") return { status: "cancelled" as const,
            reason: "Author cancelled; diagnostic model work was not started." };
          if (control === "paused") return { status: "paused" as const,
            reason: "Author pause precedes unfamiliar-failure diagnosis." };
          await verify();
          proofTrusted = true;
          const { policy } = await (await import("./job-pi-policy.js")).inspectPiPolicy(job);
          const diagnosis = await withStoryJobLock(job, "generation-unknown-diagnostic", () =>
            diagnoseUnknownCompletion(job, target,
              s.request.provider ?? policy.profile.provider,
              s.request.model ?? policy.profile.model));
          proofTrusted = false;
          await verify();
          proofTrusted = true;
          return { status: "blocked" as const,
            reason: "Operator intervention required: unfamiliar generation completion check " +
              "remains unresolved; the read-only diagnosis cannot waive verification or dispatch work.",
            unknownRecovery: { case: target, phase: unknownDiagnosisDisposition(diagnosis),
              recommendation: diagnosis.action, advisoryCategory: diagnosis.category } };
        } catch (error) {
          const stop = blocked(error);
          const resourceLimit = (error as Error)?.name === "PiBudgetPause";
          const unsafe = !proofTrusted ||
            (error as { code?: string })?.code === "integrity-blocked";
          return { ...stop, unknownRecovery: {
            case: target, phase: resourceLimit ? "resource-limit" as const :
              unsafe ? "unsafe-evidence" as const : "operator-intervention" as const },
            reason: resourceLimit ? stop.reason :
              unsafe
                ? "Unsafe or incomplete unfamiliar-failure evidence; operator inspection is required. " +
                  "Do not repeat the diagnostic against unchanged proof."
                : "Operator intervention required: the bounded, read-only unknown-failure diagnosis " +
                  "did not produce a verified recommendation. Do not replay the model or writer." };
        }
      }
      const op = s.operationRecovery;
      if (op?.phase === "assessment") {
        const fence = (reason: string): Partial<State> => ({
          status: "blocked", operationRecovery: { ...op, phase: "fenced" },
          reason: reason + " " + op.nextAction,
        });
        const job = await openJob(s).catch(() => null);
        if (!job || op.version !== 1 || op.check !== operationChecks[op.operation] ||
            op.checkVersion !== 1 || op.source.jobId !== s.request.job ||
            op.source.threadId !== (s.graphThreadId ?? config.configurable?.thread_id) ||
            op.source.turnDigest !== (s.request.turnPlanDigest ?? null) ||
            op.source.planVersion !== (s.planVersion ?? null))
          return fence("Controller recovery source identity is missing or mismatched.");
        if (op.safeAction !== "continue-independent") return fence(op.reason);
        try {
          await withStoryJobLock(job, "generation-operation-assessment", async () => {
            clean(job);
            const head = await trustedHead(job);
            const last = s.ideaHistory.at(-1);
            if (op.operation !== "idea-integration" || op.outcome !== "returned-failure" ||
                op.evidence.reference !== "generation-idea-dispatch" ||
                op.evidence.resultStatus !== "deferred" ||
                op.source.headSha !== head || op.evidence.priorHead !== head ||
                last?.id !== op.evidence.ideaId || last?.action !== op.evidence.action ||
                last?.signature !== op.evidence.signature || last?.status !== "deferred" ||
                last?.commitSha || s.ideaTask)
              throw Error("Deferred idea source/head or completed verification does not match its assessment.");
            const file = ideaDispatchFile(job);
            if (!existsSync(file)) throw Error("Deferred idea's original dispatch receipt is missing.");
            const saved = JSON.parse(await readFile(file, "utf8")) as {
              jobId?: string; phase?: string; task?: IdeaTask; result?: IdeaResult;
            };
            if (saved.jobId !== job.jobId || saved.phase !== "verified" ||
                saved.task?.id !== op.evidence.ideaId ||
                saved.task?.action !== op.evidence.action ||
                saved.task?.signature !== op.evidence.signature ||
                saved.task?.priorHead !== head || saved.result?.status !== "deferred" ||
                saved.result.commitSha ||
                !(await load(job)).some(idea => idea.id === saved.task?.id))
              throw Error("Deferred idea cannot continue without its exact committed inbox and original verified no-write result.");
          });
          return { operationRecovery: { ...op, phase: "continued" as const }, reason: null };
        } catch (error) {
          return fence("Independent continuation proof was not verified: " +
            (error instanceof Error ? error.message : String(error)));
        }
      }
      const r = s.recovery;
      if (!r || r.phase !== "assessment" || r.operation !== "adaptive-planner" ||
          r.failedPhase !== "completed-response" || r.planVersion !== s.planVersion ||
          r.check !== "adaptive-plan.v1" || r.checkVersion !== 1 || r.jobId !== s.request.job ||
          r.turnDigest !== s.request.turnPlanDigest)
        return blocked(Error("Unrecognized or unbound adaptive recovery decision"));
      // This checkpoint records intent, not authority to reuse a session. Intake
      // rechecks author controls and the adapter authenticates source and proof.
      return { recovery: { ...r, phase: "authorized" as const }, reason: "Correcting the original adaptive planner response." };
    })
    .addNode("author_update_intake", async s => {
      const job = await openJob(s);
      return withStoryJobLock(job, "generation-boundary", async () => {
        try {
          const stopped = await authorBoundary(job, s);
          if (stopped) return stopped;
          const receipt = await checkPlan(job, s.request, s.planVersion);
          // Preserve an in-flight result. For interrupted external effects, only the
          // original specialist may reconcile the dirty/unpublished work boundary.
          if (s.ideaTask) return {};
          if (s.active && (receipt?.plan?.version ?? null) === s.planVersion) {
            if (s.result) {
              // A failed correction may have reached a *reviewed*, clean
              // checkpoint while author steering was queued during its Pi
              // turn. Do not wait through the whole correction loop. Process
              // the message here before re-entering the same original review.
              const adapter = currentSteeringBoundary();
              if (adapter && s.request.turnPlanDigest &&
                  (await adapter.pending(job)).length) {
                clean(job);
                const head = await trustedHead(job);
                const reviewed = (await inspectRecoveryCheckpoints(job)).some(point =>
                  point.eligible && point.commitSha === head &&
                  point.workItem.startsWith("repair-") &&
                  point.semanticReview === "failed");
                if (reviewed) {
                  const updated = await reconcile(s, job, false);
                  const boundary = await applyLiveSteeringAtBoundary(job, s.request,
                    updated.inventory ?? null);
                  if (boundary) return boundary;
                }
              }
              return s.reason === REPAIR_STEERING_BOUNDARY ? { reason: null } : {};
            }
            try { clean(job); await trustedHead(job); } catch { return {}; }
          }
          if (s.result) throw new Error("Plan changed with an unverified dispatch result; reconcile the original assignment first.");
          clean(job);
          const next = await reconcile(s, job);
          if (next.status === "paused" || next.status === "blocked" || next.recovery?.phase === "assessment") return next;
          const boundary = await applyLiveSteeringAtBoundary(job, s.request, next.inventory ?? null);
          if (boundary) return { ...next, ...boundary, ideaTask: null, escalation: null };
          const head = await trustedHead(job);
          // Existing Event/Choice ownership and its native fulfillment contract
          // are checked before allocating any Composition model context. A
          // saved closeout proposal is a graph routing decision, never a lease;
          // the separate node re-authenticates the entire source under lock.
          if (next.active?.stage === "composition" && next.active.milestone &&
              next.planVersion && next.request?.turnPlanDigest && !next.request.fixture) {
            const decision = await preflightCompositionBoundary(job, next.request,
              next.active.milestone, next.planVersion);
            if (decision.kind === "author-required") return {
              ...next, status: "paused" as const, reason: decision.reason,
              escalation: { kind: "protected-approval" as const,
                requiresTrustedApproval: true,
                sources: [{ source: next.active.milestone, message: decision.reason,
                  repair: "protected" }],
                action: "Request the original author’s approval through the existing scope/decision workflow." },
            };
            if (decision.kind === "refuse") return {
              ...next, status: "blocked" as const,
              reason: "Composition prerequisite preflight refused: " + decision.reason,
              escalation: { kind: "dependency-replan" as const,
                requiresTrustedApproval: false,
                sources: [{ source: next.active.milestone, message: decision.reason,
                  repair: "event" }],
                action: "Inspect original Event/Choice proofs and authorize only a verified " +
                  "bounded prerequisite amendment. Do not dispatch Composition or fabricate fulfillment." },
            };
            if (decision.kind === "repair") return { ...next,
              crossDomainCloseout: { milestoneId: next.active.milestone,
                planVersion: next.planVersion, sourceSha: decision.proposal.sourceSha,
                proposalDigest: decision.proposal.digest, repairId: decision.repairId },
              ideaTask: null, escalation: null };
          }
          // A single logical boundary after independently reviewed, commitless
          // omissions. No fabricated Git commit, no repeated Pi calls, and no
          // unrelated writer draft may be included in the handoff.
          if (next.active?.stage === "composition" && next.inventory) {
            const inherited = readRecoveryFork(job);
            const checkpoint = (await inspectRecoveryCheckpoints(job))
              .find(point => point.eligible && point.commitSha === head) ??
              (inherited?.checkpoint.commitSha === head && job.baseSha === head
                ? inherited.checkpoint : null);
            if (checkpoint) await sealReviewedOmissionBatch(job, checkpoint, next.inventory);
          }
          // An independently approved focused revision grants only its listed
          // existing files. Do not dispatch unrelated deferred idea integrations
          // merely because their work is pending at this Story boundary.
          const scheduled = isFocusedScope(next.request?.contract ?? s.request.contract)
            ? { tasks: [] } : await scheduleIdeasAtBoundary(job, "parent-generation");
          const selected = selectIdeaTask({ ...s, ...next } as State, head, scheduled.tasks,
            next.active ?? null);
          return { ...next, crossDomainCloseout: null, ideaTask: selected, escalation: null };
        } catch (error) { return operationFailure(s, job, "scheduling", error,
          { reference: "generation-checkpoint" }); }
      });
    })
    .addNode("idea_integration", async s => {
      if (s.ideaResult) return {};
      const task = s.ideaTask!;
      const job = await openJob(s);
      const file = ideaDispatchFile(job);
      try {
        // External Git and Pi effects cannot be replayed merely because the
        // LangGraph checkpoint was interrupted. A private receipt fences repeats.
        if (existsSync(file)) {
          const saved = JSON.parse(await readFile(file, "utf8")) as {
            jobId: string; task: IdeaTask; phase: string; result?: IdeaResult;
          };
          if (saved.jobId !== job.jobId) throw new Error("Idea dispatch receipt belongs to another job.");
          if (JSON.stringify(saved.task) === JSON.stringify(task)) {
            if (saved.result) return { ideaResult: saved.result };
            const ideas = await withStoryJobLock(job, "idea-dispatch-reconciliation", () => load(job));
            const last = ideas.find(i => i.id === task.id)?.lifecycle.placements.at(-1);
            if (last?.priorHead === task.priorHead &&
                (last.action === "integrated" && task.action === "place" ||
                 last.action === "reassessed" && task.action === "reassess")) {
              const entryFile = join(job.stateDir, "idea-placements",
                task.id + "-" + last.revision + ".json");
              const receipt = JSON.parse(await readFile(entryFile, "utf8")) as {
                priorHead: string; commitSha: string;
              };
              const commitSha = await trustedHead(job);
              if (receipt.priorHead !== task.priorHead || receipt.commitSha !== commitSha)
                throw new Error("Automated idea recovery requires the exact verified placement commit, not a later unrelated HEAD.");
              const result = { status: last.action === "integrated"
                ? last.verified === "pi" ? "integrated" : "integrated-editorial-unverified"
                : last.verified === "pi" ? "reassessed" : "reassessed-editorial-unverified", commitSha };
              await persist(file, { ...saved, phase: "returned", result });
              return { ideaResult: result };
            }
            throw new Error("Interrupted automated idea selection/writer; inspect its Pi session, placement receipt and Git worktree before manual reconciliation.");
          }
          if (saved.phase !== "verified")
            throw new Error("Previous automated idea dispatch has not been verified; reconcile it manually.");
        }
        if (await trustedHead(job) !== task.priorHead) throw new Error("Idea selection's verified Git base changed.");
        await persist(file, { jobId: job.jobId, task, phase: "running" });
        const result = await runIdeaPlacement({ ...s.request,
          // Opt-in integration evaluation: fixture Story generation with real
          // pinned Pi placement/semantic review, never a fixture-only attestation.
          fixture: s.request.fixture && process.env.NT_LIVE_GENERATION_IDEA === "1"
            ? false : s.request.fixture,
          action: task.action, id: task.id,
          ...(task.action === "place" ? { autoSelect: true } : { record: true }) }) as IdeaResult;
        await persist(file, { jobId: job.jobId, task, phase: "returned", result });
        return { ideaResult: result };
      } catch (error) { return operationFailure(s, job, "idea-integration", error,
        { reference: "generation-idea-dispatch", ideaId: task.id, action: task.action,
          signature: task.signature, priorHead: task.priorHead }); }
    })
    .addNode("verify_idea_integration", async s => {
      const job = await openJob(s);
      return withStoryJobLock(job, "generation-idea-verification", async () => {
        try {
          clean(job);
          const head = await trustedHead(job);
          const task = s.ideaTask!, result = s.ideaResult!;
          const expected = task.action === "place"
            ? ["integrated", "integrated-editorial-unverified"]
            : ["reassessed", "reassessed-editorial-unverified"];
          if (!expected.includes(result.status) && result.status !== "deferred" ||
              expected.includes(result.status) && !result.commitSha)
            return operationFailure(s, job, "idea-verification",
              "Idea placement returned an unverified status/commit pair: " + result.status,
              { reference: "generation-idea-dispatch", ideaId: task.id, action: task.action,
                signature: task.signature, priorHead: task.priorHead, resultStatus: result.status },
              "returned-failure");
          if (result.status === "deferred" && result.commitSha)
            throw Error("Deferred idea cannot claim a committed writer revision.");
          if (result.commitSha && head !== result.commitSha)
            throw new Error("Idea integration commit differs from the verified Story HEAD.");
          if (result.commitSha) {
            const idea = (await load(job)).find(i => i.id === task.id);
            const last = idea?.lifecycle.placements.at(-1);
            if (last?.priorHead !== task.priorHead ||
                (task.action === "place" ? last.action !== "integrated" : last.action !== "reassessed"))
              throw new Error("Idea integration result lacks matching committed provenance.");
          } else if (head !== task.priorHead)
            throw new Error("Deferred idea result changed Git without a verified integration commit.");
          const history = [...s.ideaHistory, { id: task.id, action: task.action,
            signature: task.signature, status: result.status,
            ...(result.reason ? { reason: result.reason } : {}),
            ...(result.commitSha ? { commitSha: result.commitSha } : {}) }];
          await persist(ideaDispatchFile(job), { jobId: job.jobId, task, phase: "verified", result });
          if (result.status === "deferred") {
            // Record the decision BEFORE attempting any other scheduling/model
            // operation. The assessor checks the no-write provenance and the
            // next intake rebuilds dependencies from the verified HEAD.
            const decision = await operationFailure(s, job, "idea-integration",
              result.reason ?? "Deferred by placement review",
              { reference: "generation-idea-dispatch", ideaId: task.id,
                action: task.action, signature: task.signature, priorHead: task.priorHead,
                resultStatus: result.status }, "returned-failure", "continue-independent");
            return { ideaTask: null, ideaResult: null, ideaHistory: history,
              active: null, cursor: s.cursor + 1, ...decision };
          }
          const next = await reconcile({ ...s, ideaHistory: history, active: null, result: null }, job);
          return { ...next, ideaTask: null, ideaResult: null, ideaHistory: history,
            cursor: s.cursor + 1 };
        } catch (error) { return operationFailure(s, job, "idea-verification", error,
          { reference: "generation-idea-dispatch", ideaId: s.ideaTask?.id,
            action: s.ideaTask?.action, signature: s.ideaTask?.signature,
            priorHead: s.ideaTask?.priorHead, resultStatus: s.ideaResult?.status }); }
      });
    })
    .addNode("specialist_dispatch", async s => {
      if (s.crossDomainCloseout) {
        try {
          const pending = s.crossDomainCloseout;
          if (!s.active || s.active.stage !== "composition" ||
              s.active.milestone !== pending.milestoneId ||
              s.planVersion !== pending.planVersion || s.result)
            throw Error("Prerequisite correction lost its pinned Composition source.");
          const job = await openJob(s);
          const stopped = await withStoryJobLock(job, "cross-domain-author-boundary",
            () => authorBoundary(job, s));
          if (stopped) return stopped;
          const result = await advanceCrossDomainCloseout({ ...s.request,
            originalInventory: s.inventory ?? undefined,
            milestoneId: pending.milestoneId, planVersion: pending.planVersion,
            expected: { sourceSha: pending.sourceSha,
              proposalDigest: pending.proposalDigest, repairId: pending.repairId } });
          if (result.status !== "verified")
            throw Error("Prerequisite lacks independent correction review.");
          // No separate recovery graph: re-enter the original controller
          // inventory and recheck native Milestone readiness before Composition.
          return { crossDomainCloseout: null, active: null, result: null,
            reason: null, escalation: null };
        } catch (error) { return blocked(error); }
      }
      // A saved dispatch result means the external stage completed before a parent
      // verification checkpoint. Otherwise the stage API reconciles its receipt,
      // including a commit published before its receipt; never invent a new writer.
      if (s.result) return {};
      try {
        let result = await dispatch(s);
        if (result.status === "event-prerequisite-reported") {
          let evidence = result as typeof result & {
            prerequisite?: { reportDigest: string; expectedHead: string };
            conflicts?: string[]; obligations?: string[]; reroutedFrom?: string;
            causalDiscovery?: CausalDiscovery;
          };
          if (!evidence.prerequisite || !/^[a-f0-9]{64}$/.test(evidence.prerequisite.reportDigest))
            throw Error("A no-write Event dependency report lacks a sealed source receipt.");
          const job = await openJob(s);
          const route = routeEventPrerequisite({
            milestone: s.active!.milestone!, activeStage: s.active!.stage,
            expectedHead: evidence.prerequisite.expectedHead,
            verifiedHead: await trustedHead(job), reportDigest: evidence.prerequisite.reportDigest,
            conflicts: evidence.conflicts ?? [], obligations: evidence.obligations ?? [],
            alreadyRerouted: !!evidence.reroutedFrom,
          });
          if (route.kind === "event-setup") {
            // Same authorized Event assignment, one new task and a fresh
            // settled Pi session. The original source receipt is archived;
            // no Choice/ending grant or dependency inversion is introduced.
            result = await runEventWorkItem({ ...s.request, action: "run",
              milestone: s.active!.milestone!, task: route.task,
              reroute: { reportDigest: route.reportDigest,
                sourceSha: evidence.prerequisite.expectedHead, task: route.task } });
            if (result.status !== "event-prerequisite-reported") return { result };
            evidence = result as typeof evidence;
          }
          const failure = "Clean no-write Event prerequisite report " +
            evidence.prerequisite!.reportDigest + " at " + evidence.prerequisite!.expectedHead +
            ": " + [...evidence.conflicts ?? [], ...evidence.obligations ?? []].join("; ") +
            ". " + (route.kind === "event-setup"
              ? "An independently bounded Event-setup reassignment also reported no edits; "
              : route.reason + " ") +
            "The original settled session is preserved; no unauthorized Choice or upstream work " +
            "was dispatched. Obtain a controller-approved bounded architecture/work-plan revision.";
          if (route.kind === "replan-required" && evidence.causalDiscovery && s.inventory) {
            const receipt = await checkPlan(job, s.request, s.planVersion);
            if (!receipt?.plan) throw Error("Causal replan lacks its verified Architecture plan.");
            const causalAmendment = await withStoryJobLock(job, "causal-amendment-admission", () =>
              inspectCausalAmendment(job, {
                sourceSha: evidence.prerequisite!.expectedHead,
                reportDigest: evidence.prerequisite!.reportDigest,
                milestoneId: s.active!.milestone!, inventory: s.inventory!,
                plan: receipt.plan,
                validatorSource: s.request.validatorSource ?? s.request.skillsSource,
              }));
            return { failures: { ...s.failures, [s.active!.id]: failure },
              causalAmendment, active: null, result: null };
          }
          return { failures: { ...s.failures, [s.active!.id]: failure }, active: null, result: null };
        }
        return { result };
      } catch (error) {
        const stop = blocked(error);
        if (stop.status === "paused" || stop.status === "cancelled") return stop;
        const job = await openJob(s);
        if (error instanceof IndependentReviewGateError) {
          return withStoryJobLock(job, "generation-review-handoff", async () => {
            clean(job);
            const headSha = await trustedHead(job);
            return { result: { status: "review-handoff", headSha } };
          });
        }
        return withStoryJobLock(job, "generation-local-block", async () => {
          try { clean(job); await trustedHead(job); }
          catch { return stop; }
          return { failures: { ...s.failures, [s.active!.id]: stop.reason! }, active: null, result: null };
        });
      }
    })
    .addNode("dependency_amendment", async s => {
      try {
        if (s.active?.stage !== "focus" || !s.active.milestone)
          throw Error("Dependency amendment is not bound to a focused assignment.");
        const job = await openJob(s);
        const stopped = await withStoryJobLock(job, "dependency-author-boundary", () => authorBoundary(job, s));
        if (stopped) return stopped;
        const resolved = await advanceFocusedDependency({ ...s.request, target: s.active.milestone });
        const entry = (await inspectDependencyPlan(job))?.entries.find(e => e.reportDigest === resolved.reportDigest);
        if (!entry || entry.phase !== "verified") throw Error("Dependency amendment lost its completion evidence.");
        return { result: null, dependencyHistory: [...(s.dependencyHistory ?? []).filter(p =>
          p.reportDigest !== entry.reportDigest), { reportDigest: entry.reportDigest, entryDigest: dependencyDigest(entry) }] };
      } catch (error) { return blocked(error); }
    })
    .addNode("independent_assignment_review", reviewBoundary)
    .addNode("verify_committed_work", async s => {
      const job = await openJob(s);
      return withStoryJobLock(job, "generation-verification", async () => {
        try {
          clean(job);
          const headSha = await trustedHead(job);
          const receipt = await checkPlan(job, s.request, s.planVersion);
          const planVersion = receipt?.plan?.version ?? null;
          const stage = s.active!.stage;
          if (!s.result || !accepted[stage].includes(s.result.status))
            return { failures: { ...s.failures, [s.active!.id]: s.result?.status ?? "Missing specialist result" },
              active: null, result: null };
          const completedStages = [...s.completedStages, { stage, milestone: s.active?.milestone,
            headSha: s.result.headSha ?? headSha, status: s.result.status, planVersion: planVersion ?? undefined }];
          const next = await reconcile({ ...s, completedStages, active: null, result: null, planVersion }, job);
          // A newly verified specialist has just reached a safe boundary. The
          // next assignment must not become in-flight until author steering and
          // other boundary updates have been reconciled by author_update_intake.
          // Preserve the in-flight guard there for genuinely interrupted writers.
          return { ...next, active: null, cursor: s.cursor + 1, result: null,
            ...(s.pauseAfter === stage ? { status: "paused" as const, reason: "Requested safe-boundary pause" } : {}) };
        } catch (error) { return blocked(error); }
      });
    })
    .addNode("completion_decision", async s => {
      const job = await openJob(s);
      try {
        const preflight = await withStoryJobLock(job, "generation-completion-preflight", async () => {
          clean(job); await trustedHead(job); await checkPlan(job, s.request, s.planVersion);
          // A saved graph inventory is NOT a completion credential. Rebuild
          // the latest authorized assignments and all omission/review proofs
          // without invoking the model before accepting a final Story verdict.
          // Changed or missing amendments may not fall back to Architecture.
          if ((s.adaptiveVersion ?? 1) > 1) {
            const restored = await reconcile(s, job, false);
            if (restored.adaptiveVersion !== s.adaptiveVersion ||
                !isDeepStrictEqual(restored.inventory?.items, s.inventory?.items))
              throw Error("Final Story completion lost the exact authenticated adaptive assignments; reconcile their checkpoints.");
          }
          const stopped = await authorBoundary(job, s);
          return stopped ? { stopped, report: null } :
            { stopped: null, report: await inspectJobReport(s.request) };
        });
        if (preflight.stopped) return preflight.stopped;
        const preliminary = preflight.report!;
        // The independent reviewer has no write tools or authority, but its
        // cancellable Pi turn must retain the same per-Story lease until settled.
        // Its source-bound receipt independently checks HEAD and approvals.
        if (preliminary.generation.scopeFulfillment === "complete-in-scope" &&
            preliminary.generation.planFulfillment.status === "required") {
          const record = JSON.parse(await readFile(join(job.stateDir, "narrative-review.json"),
            "utf8")) as { worker: "fixture" | "pi"; provider: string; model: string;
              thinking?: "low" | "high"; snapshot?: SkillSnapshot };
          if (record.worker !== "pi" || !record.snapshot ||
              await openSkillSnapshot(record.snapshot.id) !== record.snapshot.path)
            throw new Error("Independent Turn completeness requires the pinned real Pi reviewer, not a fixture.");
          const { reviewTurnCompleteness } = await import("./narrative-review-specialist.js");
          await withStoryJobLock(job, "independent-turn-completeness", () =>
            assessTurnFulfillment(job, preliminary, "independent-turn-completeness/v1",
              (packet, onSession) => reviewTurnCompleteness(job, record.snapshot!, packet,
                record.provider, record.model, record.thinking, onSession)));
        }
        return await withStoryJobLock(job, "generation-completion", async () => {
          clean(job); await trustedHead(job); await checkPlan(job, s.request, s.planVersion);
          const stopped = await authorBoundary(job, s);
          if (stopped) return stopped;
          // A positive other-owner prerequisite rereview alone does not
          // certify its already-authored dependents. This final gate reopens
          // the immutable completed selective-review receipt after restart.
          const { assertOtherOwnerGenerationCompletion } = await import("./review-other-owner-revalidation.js");
          await assertOtherOwnerGenerationCompletion(job);
          const report = await inspectJobReport(s.request);
          const complete = report.generation.status === "completed" && authorizedInventoryComplete(s.inventory);
          const escalation = complete ? null : reviewEscalation(report, s.inventory);
          // A trusted but unexplained final failure has ONE advisory diagnosis
          // opportunity. Known incomplete assignments, required author decisions,
          // resource pauses and unverified writes never reach the model.
          if (!complete && !escalation && !s.request.fixture && s.planVersion &&
              authorizedInventoryComplete(s.inventory) &&
              !report.evidence.deferredIdeas.scopedOutstanding.length) {
            const headSha = await trustedHead(job);
            const checkpoint = (await inspectRecoveryCheckpoints(job)).find(point =>
              point.eligible && point.commitSha === headSha &&
              (point.semanticReview === "passed" || point.semanticReview === "not-required"));
            if (!checkpoint) return { status: "blocked" as const,
              reason: "Unsafe completion evidence: no eligible verified/reviewed checkpoint; operator inspection required.",
              unknownRecovery: { case: null, phase: "unsafe-evidence" as const } };
            const target = unknownCompletionCase({
              jobId: job.jobId, threadId: job.threadId,
              turnDigest: s.request.turnPlanDigest ?? null, planVersion: s.planVersion,
              sourceSha: headSha, checkpoint: checkpoint.workItem,
              reportStatus: report.generation.status,
              scopeStatus: report.generation.scopeFulfillment,
              planStatus: report.generation.planFulfillment.status,
            });
            if (s.unknownRecovery?.case?.signature === target.signature) {
              return ["assessment", "resource-limit"].includes(s.unknownRecovery.phase)
                ? { status: "running" as const, reason: "Assessing the original unfamiliar failure.",
                    unknownRecovery: { ...s.unknownRecovery, phase: "assessment" as const } }
                : { status: "blocked" as const,
                    reason: "Unchanged unfamiliar failure has already received its one-time diagnosis or unsafe stop. Operator intervention is required.",
                    unknownRecovery: s.unknownRecovery };
            }
            return { status: "running" as const,
              reason: "Assessing an unfamiliar final verification failure without Story write authority.",
              unknownRecovery: { case: target, phase: "assessment" as const } };
          }
          const details = s.inventory?.items.filter(i => i.status !== "verified")
            .map(i => i.stage === "review" ? i.blockingReason ?? "Scope remains unverified" :
              `${i.id}: ${i.blockingReason ?? "Unresolved dependencies"}`).join("; ");
          const unfulfilledIdeas = report.evidence.deferredIdeas.scopedOutstanding;
          const budgeted = s.ideaHistory.filter(h => unfulfilledIdeas.includes(h.id) &&
            s.ideaHistory.filter(other => other.id === h.id).length >= MAX_IDEA_ATTEMPTS);
          return {
            // Needing a *proposal* is blocked; only a real outstanding author
            // approval interrupt or execution control may report paused.
            status: complete ? "completed" as const : "blocked" as const,
            ...(complete ? { unknownRecovery: null } : {}),
            escalation,
            reason: complete ? null : [details || s.completedStages.at(-1)?.status ||
              "Scope remains unverified",
              ...(unfulfilledIdeas.length ? ["Binding deferred ideas unresolved: " + unfulfilledIdeas.join(", ")] : []),
              ...(budgeted.length ? ["Automated idea reassessment limit reached; author review required."] : []),
              ...(escalation ? [escalation.action] : [])].join("; "),
          };
        });
      } catch (error) { return blocked(error); }
    })
    .addEdge(START, "schedule")
    .addConditionalEdges("schedule", s => s.operationRecovery?.phase === "assessment" ? "assess_recovery" :
      s.status !== "running" ? END : "author_update_intake", [END, "assess_recovery", "author_update_intake"])
    .addConditionalEdges("assess_recovery", s => s.status !== "running" ? END : "author_update_intake", [END, "author_update_intake"])
    .addConditionalEdges("author_update_intake", s => s.operationRecovery?.phase === "assessment" ? "assess_recovery" :
      s.status !== "running" ? END :
      s.recovery?.phase === "assessment" ? "assess_recovery" :
      s.ideaTask ? "idea_integration" : s.active && s.result ? "independent_assignment_review" :
      s.active ? "specialist_dispatch" : "completion_decision", [END, "assess_recovery", "idea_integration", "independent_assignment_review", "specialist_dispatch", "completion_decision"])
    .addConditionalEdges("idea_integration", s => s.operationRecovery?.phase === "assessment" ? "assess_recovery" :
      s.status !== "running" ? END : "verify_idea_integration", [END, "assess_recovery", "verify_idea_integration"])
    .addConditionalEdges("verify_idea_integration", s => s.operationRecovery?.phase === "assessment" ? "assess_recovery" :
      s.status !== "running" ? END :
      s.recovery?.phase === "assessment" ? "assess_recovery" : "author_update_intake")
    .addConditionalEdges("specialist_dispatch", s => s.operationRecovery?.phase === "assessment" ? "assess_recovery" :
      s.status !== "running" ? END :
      s.result?.status === "dependency-required" ? "dependency_amendment" :
      s.active ? "independent_assignment_review" : "author_update_intake", [END, "assess_recovery", "dependency_amendment", "independent_assignment_review", "author_update_intake"])
    .addConditionalEdges("dependency_amendment", s => s.operationRecovery?.phase === "assessment" ? "assess_recovery" :
      s.status !== "running" ? END : "author_update_intake", [END, "assess_recovery", "author_update_intake"])
    .addConditionalEdges("independent_assignment_review", s => s.operationRecovery?.phase === "assessment" ? "assess_recovery" :
      s.status !== "running" ? END :
      s.reason === REPAIR_STEERING_BOUNDARY ? "author_update_intake" :
      s.result ? "verify_committed_work" : "specialist_dispatch", [END, "assess_recovery", "author_update_intake", "verify_committed_work", "specialist_dispatch"])
    .addConditionalEdges("verify_committed_work", s => s.operationRecovery?.phase === "assessment" ? "assess_recovery" :
      s.status !== "running" ? END :
      s.recovery?.phase === "assessment" ? "assess_recovery" : "author_update_intake")
    .addConditionalEdges("completion_decision", s => s.operationRecovery?.phase === "assessment" ||
      s.status === "running" && s.unknownRecovery?.phase === "assessment" ? "assess_recovery" : END,
      ["assess_recovery", END])
    .compile({ checkpointer });
}

export async function runStoryGeneration(options: GenerationOptions) {
  const job = await startStoryJob({ story: options.story, job: options.job }, false);
  assertNativeVersion(job.validatorVersion);
  return withStoryGenerationLock(job, async () => {
    ensureNotServerOwned(job);
    const path = join(job.stateDir, "generation.sqlite");
    if (options.action !== "start" && !existsSync(path)) throw new Error("No generation run exists; use generate start.");
    const saver = SqliteSaver.fromConnString(path);
    try {
      const graph = createGenerationGraph(saver, "cli");
      const config = { configurable: { thread_id: job.threadId + ":generation" }, recursionLimit: 10000 };
      const saved = await graph.getState(config);
      let state = saved.values as State;
      if (options.action === "start") {
        if (state.request) throw new Error("Generation already exists; use resume or inspect, never overwrite its contract.");
        if (!options.task?.trim()) throw new Error("Generation start requires --task and --contract.");
        const request: GenerationRequest = { story: job.storyRoot, job: job.jobId, task: options.task,
          contract: parseGenerationContract(options.contract), fixture: options.fixture ?? false,
          skillsSource: options.skillsSource, validatorSource: options.validatorSource,
          provider: options.provider, model: options.model,
          orchestrationPolicy: options.fixture && !options.skillsSource ? "fixture-legacy" : "explicit" };
        state = { request, recovery: null, unknownRecovery: null, operationRecovery: null,
          cursor: 0, completedStages: [], status: "running", reason: null, result: null, planVersion: null,
          pauseAfter: options.pauseAfter ?? null, inventory: null, active: null, failures: {},
          ideaTask: null, ideaResult: null, ideaHistory: [], escalation: null,
          orchestratorSnapshotId: null, orchestratorOrder: null, orchestratorPlanningDigest: null,
          pendingOrder: null, pendingVersion: null, graphThreadId: null, adaptiveVersion: null,
          dependencyHistory: [], crossDomainCloseout: null, causalAmendment: null };
      } else {
        if (!state.request) throw new Error("No saved generation request.");
        if (state.request.story !== job.storyRoot || state.request.job !== job.jobId)
          throw new Error("Generation checkpoint belongs to a different Story job.");
        if (options.task !== undefined || options.contract !== undefined || options.fixture !== undefined ||
            options.skillsSource !== undefined || options.validatorSource !== undefined ||
            options.provider !== undefined || options.model !== undefined)
          throw new Error("Resume/inspect use the pinned generation request; new worker inputs are forbidden.");
      }
      const cancelled = await readJobControl(job) === "cancelled";
      const cancellation = {
        status: "cancelled" as const,
        reason: "Author cancelled this Story job; inspect the preserved specialist session, receipt and worktree before reconciliation.",
      };
      if (options.action === "start" && cancelled) {
        throw new Error("Cannot start generation for a terminally cancelled Story job.");
      }
      if (options.action === "resume" && !cancelled) {
        // Reconcile independently committed work items without ever replaying
        // their external Pi writer. The parent graph may still be mid-node.
        await withStoryJobLock(job, "generation-checkpoint-reconciliation", () =>
          reconcileRecoveryCheckpoints(job));
      }
      if (options.action !== "inspect") {
        // A terminal cancellation never re-enters a checkpointed dispatch:
        // an unfinished writer's original session and dirty worktree must
        // remain available for explicit, non-destructive reconciliation.
        state = cancelled ? { ...state, ...cancellation } :
          await graph.invoke({ ...state, pauseAfter: options.pauseAfter ?? null }, config);
      }
      // A broken intake receipt can also make the composite job report fail.
      // Do not lose the already checkpointed recovery decision during inspect:
      // retain the typed failure and explicitly mark the report unavailable.
      const report = await inspectJobReport({ story: job.storyRoot, job: job.jobId })
        .catch(error => {
          if (state.operationRecovery?.phase === "fenced" ||
              state.operationRecovery?.phase === "assessment") return null;
          throw error;
        });
      // Inspect as well as resume must attest the checkpointed method identity.
      // An otherwise valid receipt from a different snapshot is not this
      // Thread's selected methodology, and corrupt receipts remain diagnosable.
      let orchestrationSelection: StoryOrchestratorReceipt | null = null;
      let orchestrationPlanning: OrchestratorPlanningReceipt | null = null;
      let selectionFailure: Error | null = null;
      try {
        if (await hasStoryOrchestratorSelection(job)) {
          const selected = await loadSelectedStoryOrchestrator(job, config.configurable.thread_id, {
            task: state.request.task, kind: state.request.contract.scope.kind,
            turnPlanDigest: state.request.turnPlanDigest,
          });
          if (state.orchestratorSnapshotId &&
              selected.receipt.skillSnapshot.id !== state.orchestratorSnapshotId)
            throw new Error("Pinned orchestrator snapshot changed since the generation checkpoint.");
          orchestrationSelection = selected.receipt;
          if (state.orchestratorOrder) {
            if (!state.request.turnPlanDigest || state.request.fixture)
              throw new Error("Checkpointed model planning lacks its real-Pi Turn authority.");
            const plan = await readTurnEvidence(job, state.request.contract,
              state.request.task, state.request.turnPlanDigest);
            if (!plan) throw new Error("Checkpointed objective plan lacks its Turn receipt.");
            const { inspectPiPolicy } = await import("./job-pi-policy.js");
            const { policy } = await inspectPiPolicy(job);
            orchestrationPlanning = await restoreCheckpointedObjectivePlanning(job, selected, plan,
              state.request.provider ?? policy.profile.provider,
              state.request.model ?? policy.profile.model,
              state.orchestratorPlanningDigest, state.orchestratorOrder);
          }
        } else if (state.orchestratorSnapshotId) {
          throw new Error("Pinned orchestrator selection receipt is missing; restore it before inspection.");
        }
      } catch (error) {
        selectionFailure = error instanceof Error ? error : new Error(String(error));
      }
      let current: Partial<State> = {};
      if (options.action === "inspect") {
        current = selectionFailure ? blocked(selectionFailure) : cancelled ? cancellation :
          state.operationRecovery?.phase === "fenced" || state.operationRecovery?.phase === "assessment"
            ? { status: "blocked", reason: state.operationRecovery.nextAction } :
          await withStoryJobLock(job, "generation-inspect", async () => {
            try {
              clean(job);
              await verifyDependencyHistory(job, state.dependencyHistory ?? []);
              await checkPlan(job, state.request, state.planVersion);
              if (state.cursor > 0) await trustedHead(job);
              if (state.status === "completed" && report?.generation.status !== "completed")
                throw new Error("Saved completion is no longer current; inspect the source-linked job report.");
              return await reconcile(state, job, false);
            } catch (error) { return blocked(error); }
          });
      } else if (selectionFailure) {
        current = blocked(selectionFailure);
      }
      const visible = { ...state, ...current };
      const recoveryCheckpoints = await inspectRecoveryCheckpoints(job);
      // Inspection is strictly read-only. Report the last source-bound
      // corrective assignment (including an unsafe/missing proof) without
      // advancing its writer, Git publication, attempt ledger or reviewer.
      const rejected = [...recoveryCheckpoints].reverse().find(point =>
        point.eligible && point.semanticReview === "failed" &&
        (point.commitSha === visible.result?.headSha ||
          existsSync(join(job.stateDir, "review-repairs", point.commitSha + ".json"))));
      let correctiveAssignment: {
        sourceCommitSha: string; phase: string; attempts?: number;
        repairedCommitSha?: string; evidence?: string;
      } | null = null;
      if (rejected) {
        const sourceCommitSha = rejected.commitSha;
        const receipt = join(job.stateDir, "review-repairs", sourceCommitSha + ".json");
        if (!existsSync(receipt)) {
          correctiveAssignment = { sourceCommitSha, phase: "not-admitted" };
        } else {
          try {
            const { inspectRejectedRepair, inspectPreparedRepairDispatch } =
              await import("./rejected-review-repair.js");
            const repair = await inspectRejectedRepair(job, sourceCommitSha);
            if (repair.phase === "prepared")
              await inspectPreparedRepairDispatch(job, sourceCommitSha);
            correctiveAssignment = { sourceCommitSha, phase: repair.phase,
              attempts: repair.attempts, repairedCommitSha: repair.repairedCommitSha,
              evidence: repair.phase === "prepared" ? "unstarted-verified" :
                repair.phase === "repairing" ? "writer-effects-uncertain" :
                repair.phase === "awaiting-checkpoint" ? "commit-reconciliation-required" :
                "receipt-verified" };
          } catch (error) {
            correctiveAssignment = { sourceCommitSha, phase: "integrity-blocked",
              evidence: error instanceof Error ? error.message : String(error) };
          }
        }
      }
      return { schema: "noveltea-generation/v1", status: current.status ?? state.status,
        reason: current.reason ?? state.reason, checkpointStatus: state.status,
        jobId: job.jobId, threadId: config.configurable.thread_id, checkpointPath: path,
        nextStage: visible.operationRecovery?.phase === "fenced" ||
          visible.operationRecovery?.phase === "assessment" ||
          visible.causalAmendment && visible.planVersion === visible.causalAmendment.source.planVersion ? null :
          visible.ideaTask ? "idea-integration" : visible.active?.stage ??
          (visible.inventory ? nextExecutionItem(visible.inventory,
            visible.pendingOrder ?? visible.orchestratorOrder ?? undefined)?.stage : undefined) ?? null,
        recovery: visible.recovery ?? null, operationRecovery: visible.operationRecovery ?? null,
        unknownRecovery: await inspectUnknownRecoveryStatus(job, visible.unknownRecovery ?? null),
        correctiveAssignment,
        inventory: visible.inventory, selectedWorkItem: visible.active, completedStages: visible.completedStages,
        ideaTask: visible.ideaTask, ideaHistory: visible.ideaHistory,
        recoveryCheckpoints,
        orchestrationSelection, orchestrationPlanning,
        dependencyPlan: await inspectDependencyPlan(job),
        causalAmendment: visible.causalAmendment ?? null,
        pendingPlan: state.request.turnPlanDigest
          ? await readPendingState(job, state.request.turnPlanDigest) : null,
        escalation: visible.escalation ?? (!report || state.status === "completed" ? null :
          reviewEscalation(report, visible.inventory ?? null)),
        pendingNodes: (await graph.getState(config)).next, request: visible.request,
        report, reportUnavailable: report === null };
    } finally { saver.db.close(); }
  });
}
