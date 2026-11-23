import { assertNativeVersion } from './native-cli-version.js';
import { execFileSync } from "node:child_process";
import { readRecoveryFork, verifyReadyRecoveryFork, resolvedInheritedRecoveryReviews } from "./recovery-fork-state.js";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { git as jobGit, load, persist } from "./ideas.js";
import { runIdeaPlacement, scheduleIdeasAtBoundary } from "./idea-placement.js";
import { AdaptiveRecoveryRequired, type AdaptiveRecovery } from "./adaptive-protocol.js";
import { inspectUnknownRecoveryStatus, inspectOriginalUnknownDiagnosis,
  type UnknownRecoveryStatus } from "./unknown-recovery-diagnostic.js";
import { assessGenerationOperation, isRepeatedUnchangedOperation, nodeFailureSource, operationChecks, type GenerationOperationRecovery,
  type Operation } from "./generation-operation-recovery.js";
import { inspectBlockedOriginalThreadCorrection } from "./original-thread-continuation.js";
import { projectRecoveryInspection, authenticateOriginalFailure,
  inspectModernGenerationRecovery } from "./generation-recovery-inspection.js";
import { selectOperationStrategy, executeOperationStrategy,
  authenticateSealedDiagnosticStop, diagnosticCaseForDecision,
  authenticateOperationDiagnosticProof } from "./generation-operation-strategy.js";
import { authorizeDiagnosticStrategy } from "./generation-diagnostic-controller.js";
import { inspectDiagnosticAttempt } from "./unknown-recovery-diagnostic.js";
import { admitRecovery, decideRecovery, dischargePendingRecovery, emptyRecoveryLifecycle, inspectionFence,
  finishVerifiedRecovery, recordRecoveryOutcome, resumePausedRecovery } from "./generation-recovery-lifecycle.js";
import { inspectDeferredCorrection } from "./generation-recovery-resolution.js";
import { applyDomainRecovery, assertRecoverySources, decideExistingRecovery,
  extractDomainPatch, fixtureTurnIdentity, projectRecovery,
  type DomainRecoveryStatus, type RecoverySource, type RecoveryState } from "./generation-recovery-graph.js";
import type { RecoveryLifecycle, RecoveryOrigin, RecoveryEvidence } from "./generation-recovery-contract.js";
import type { RunnableConfig } from "@langchain/core/runnables";
import { captureVerificationFailure, verifyCorrectedOriginalResult, verifiableResultStatus } from "./commit-verification-continuation.js";
import { authorizedKnownFixDispatch, type KnownFixRequest } from "./known-verifier-fix.js";
import { ProtocolExhaustedError, ProtocolVerifierRecheckRejectedError } from "./response-contract-recovery.js";
import { originalGraphFailureAnchor } from "./generation-recovery-anchor.js";
import { Annotation, END, START, StateGraph, isGraphBubbleUp } from "@langchain/langgraph";
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
import { isTrustedFinalVerdictAnomaly } from "./generation-final-verdict.js";
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
  fixPickup: z.object({ id: z.string(), check: z.string(), failedVersion: z.number().int(),
    signature: z.string() }).nullable().optional(),
});

const Channels = Annotation.Root({
  /** Sole recovery phase, decision, pending-case and invocation authority. */
  recoveryLifecycle: Annotation<RecoveryLifecycle>({ reducer: (_, next) => next, default: emptyRecoveryLifecycle }),
  /** Original domain inputs sans phase. Only their specialist receipt stores
   * authorize effects; this is not another graph-level recovery controller. */
  recoverySources: Annotation<readonly RecoverySource[]>({ reducer: (_, next) => next, default: () => [] }),
  fixPickup: Annotation<KnownFixRequest | null>({ reducer: (_, next) => next, default: () => null }),
  request: Annotation<GenerationRequest>(),
  cursor: Annotation<number>({ reducer: (_, next) => next, default: () => 0 }),
  completedStages: Annotation<GenerationEvidence[]>({ reducer: (_, next) => next, default: () => [] }),
  status: Annotation<Status>(),
  reason: Annotation<string | null>(),
  /** One-shot author-intake handoff after an independently reviewed correction.
   * Graph routing must never use a user-facing reason string as authority. */
  reviewSteeringHandoff: Annotation<boolean>({ reducer: (_, next) => next, default: () => false }),
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
export type GenerationGraphState = typeof Channels.State;
type CoreState = GenerationGraphState;
// Local node observations only; never LangGraph channels or resume authority.
type State = CoreState & DomainRecoveryStatus & { nonsemanticStop?: "author-boundary" | "fixture-verdict" };
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
    if (s.fixPickup && (!s.recovery || !authorizedKnownFixDispatch(s.fixPickup,
      job.jobId, job.threadId)))
      throw Error("Known-fix recheck lacks a verified Studio agent dispatch");
    if (plan && validation && receipt.phase === "committed") adaptive = await reconcileAdaptiveWork({
      job, request, plan, validation, inventory: pending.inventory, completed: completedStages,
      graphThreadId: s.graphThreadId, pinnedVersion: s.adaptiveVersion, allowAmend, recovery: s.recovery,
      fixRecheck: allowAmend && !!s.fixPickup });
  } catch (error) {
    if (error instanceof AdaptiveRecoveryRequired) {
      const same = s.recovery?.signature === error.decision.signature;
      if (same && s.recovery?.phase === "protocol-exhausted" && !s.fixPickup) return {
        status: "blocked", active: null, reason: "protocol-exhausted: the original adaptive response allowance is spent.",
      };
      const recovery = same && !allowAmend ? s.recovery : error.decision;
      return { request, planVersion: plan!.version, completedStages, failures, active: null, recovery,
        reason: !allowAmend && s.reason ? s.reason : "Adaptive planner response requires original-session protocol correction." };
    }
    if (error instanceof ProtocolExhaustedError && s.recovery?.phase === "authorized" && error.contract === s.recovery.check)
      return { request, completedStages, planVersion: plan!.version, active: null,
        status: "blocked", reason: error.message, recovery: { ...s.recovery, phase: "protocol-exhausted" } };
    if (s.fixPickup && error instanceof ProtocolVerifierRecheckRejectedError)
      return { request, active: null, status: "blocked", fixPickup: null,
        reason: "protocol-exhausted: original response still fails this deployed verifier fix; no writer was started." };
    if (s.fixPickup) {
      // The fixed verifier accepted the original bytes. A subsequent
      // admission/source failure is a *different* check and must have its own
      // assessment, linked to that successful read-only recheck.
      const assessed = await operationFailure(s, job, "adaptive-admission", error, {
        reference: "generation-checkpoint", previousCheck: s.fixPickup.check,
        previousCheckVersion: s.fixPickup.failedVersion,
        previousSignature: s.fixPickup.signature,
      });
      return { ...assessed, request, active: null, fixPickup: null };
    }
    // An interrupted or corrupt adaptive planner is not a generic scheduler
    // failure. Assess/fence its ORIGINAL session before any other dispatch;
    // a resource pause remains resumable through operationFailure().
    return { ...await operationFailure(s, job, "adaptive-admission", error,
      { reference: "generation-checkpoint" }), request, active: null };
  }
  if (s.recovery && s.recovery.phase !== "completed" && !adaptive?.recovered)
    throw Error("Unsettled adaptive correction lost its recovery evidence; scheduling refused");
  const effective = adaptive?.inventory ?? pending.inventory;
  const pendingOrder = adaptive?.order ?? pending.order ?? s.pendingOrder ?? null;
  return { request, planVersion: plan?.version ?? null, completedStages, failures,
    ...(plan?.version !== s.causalAmendment?.source.planVersion ? { causalAmendment: null } : {}),
    ...(adaptive?.recovered && (s.recovery?.phase === "authorized" ||
        s.recovery?.phase === "protocol-exhausted" && s.fixPickup) ?
      { recovery: { ...s.recovery, phase: "completed" as const }, fixPickup: null, reason: null } : {}),
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
    case "interactive": case "choice": case "puzzle": return runInteractiveWorkItem({ ...input,
      generationObjective: input.task, task: guidedTask, milestone, action: "run",
      unit: s.active.stage === "interactive" ? undefined : s.active.stage });
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
  ...verifiableResultStatus,
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
  const previous = s.operationRecovery;
  // A completed read-only assessment must not restart the same deterministically
  // failing operation on unchanged evidence. A new failure or verified source
  // change gets its own assessment, but no graph invocation can spin forever.
  if (previous && isRepeatedUnchangedOperation(previous, {
    operation, outcome, evidence,
    source: { jobId: job.jobId,
      threadId: s.graphThreadId ?? graphThreadId ?? job.threadId + ":generation",
      planVersion: s.planVersion ?? null, turnDigest: s.request.turnPlanDigest ?? null,
      headSha: await trustedHead(job).catch(() => null) },
  }))
    return { status: "blocked", operationRecovery: { ...previous, phase: "fenced" },
      reason: reason + " The same recovery check failed again on unchanged evidence; " +
        "inspect the original operation before another attempt." };
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
  return { nonsemanticStop: "author-boundary", status: updates.status === "paused" ? "paused"
    : updates.status === "cancelled" ? "cancelled" : "blocked",
    reason: updates.blockers.join(", ") };
}

/** A native-validated checkpoint does not complete a dependent assignment
 * until its selected independent semantic review is sealed. The reviewer is
 * read-only; the rejected original writer gets only a bounded repair lease.
 * Preserve s.result across pauses, otherwise LangGraph could replay the
 * already-committed specialist on resume. */
async function independentAssignmentBoundary(s: State, correctionSelected = false): Promise<Partial<State>> {
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
        if (!correctionSelected ||
            s.recoveryLifecycle.active?.origin.sourceHeadSha !== point.commitSha) {
          // C04: the original independent verdict is a settled semantic
          // failure. Admit it to C01 BEFORE an original-session corrective
          // Pi call. The assessor must select the existing Review/Repair
          // controller rather than permitting this node to self-dispatch.
          return operationFailure(s, job, "independent-review",
            "Original independently reviewed assignment has source-linked negative findings.",
            { reference: "review-checkpoints", assignmentId: s.active.id },
            "returned-failure");
        }
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
          return { reviewSteeringHandoff: true, reason: REPAIR_STEERING_BOUNDARY };
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
              return { nonsemanticStop: "author-boundary" as const,
                status: "blocked", reason: "Protected or unapproved prerequisite requires " +
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
        ...(requiresTrustedApproval ? { nonsemanticStop: "author-boundary" as const } : {}),
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
    return operationFailure(s, job, "independent-review", error,
      { reference: "review-checkpoints", assignmentId: s.active?.id });
  }
}

/** The *only* exception to a fenced writer is authenticated reconciliation
 * of its already committed original work item. Foundation has its own exact
 * Git trailer/content/session proof; World uses a finalized native checkpoint
 * and the original Character/World receipt. This is never permission for a
 * new session, replacement writer or unrelated specialist. */
async function inspectOriginalSpecialistCommitForResume(
  s: State, job: JobStartResult,
): Promise<boolean> {
  if (!s.active || s.result || !s.inventory) return false;
  clean(job);
  if (s.active.stage === "foundation") {
    const { inspectRecoverableFoundationCommit } = await import("./foundation.js");
    return inspectRecoverableFoundationCommit(job);
  }
  if (s.active.stage !== "foundations") return false;
  const head = await trustedHead(job);
  const point = (await inspectRecoveryCheckpoints(job)).find(p =>
    p.eligible && p.commitSha === head && p.workItem === "world-foundations");
  if (!point) throw Error("No eligible World checkpoint at the original committed HEAD.");
  const inspection = await runCharacterWorldJob({ ...s.request, action: "inspect" });
  if (!("recovery" in inspection) || !inspection.recovery)
    throw Error("World receipt has no independent recovery inspection.");
  if (inspection.recovery.status !== "ready" &&
      inspection.recovery.status !== "recoverable-commit")
    throw Error("World receipt is not recoverable: " + inspection.recovery.reason);
  return true;
}

/** A clean failed specialist may be recorded as blocked without giving the
 * scheduler authority to replay it. Its dependent assignments are blocked in
 * the visible inventory; independently verified work stays intact. This is
 * bookkeeping only: the recovery assessor still fences the original operation. */
function blockedAssignmentInventory(s: State, reason: string): GenerationInventory | null {
  if (!s.active || !s.inventory) return s.inventory;
  const blockedIds = new Set([s.active.id]);
  const items = s.inventory.items.map(item => ({ ...item }));
  for (let pass = 0; pass < items.length; pass++) {
    let changed = false;
    for (const item of items) {
      if (blockedIds.has(item.id) || item.dependencies.some(id => blockedIds.has(id))) {
        if (!blockedIds.has(item.id)) { blockedIds.add(item.id); changed = true; }
        item.status = "blocked";
        item.blockingReason = item.id === s.active.id ? reason :
          "Blocked dependency: " + item.dependencies.filter(id => blockedIds.has(id)).join(", ");
        delete item.verifiedSha;
      }
    }
    if (!changed) break;
  }
  return { ...s.inventory, items };
}

/** Every graph edge defers to an unresolved checkpointed operation
 * assessment before routing to another stage or specialist. */
function routeAfterOperationAssessment(s: CoreState, normal: string): string {
  return (s.recoveryLifecycle.phase === "assessing" || s.recoveryLifecycle.assessorPending) && !!s.recoveryLifecycle.active
    ? "assess_recovery" : normal;
}

/** Execute existing ownership/receipt logic with local domain projections.
 * No old recovery status is checkpointed: only the C01 lifecycle and
 * phase-free original inputs are returned to LangGraph. */
/** Every node exit (including unchanged domain recovery) must uphold this gate.
 * Typed lifecycle state, not a reason string, owns the completion decision. */
export function gateRecoveryOutput(
  rest: Record<string, unknown>,
  lifecycle: RecoveryLifecycle,
  priorStatus?: string,
  priorReason?: string | null,
): Record<string, unknown> {
  if (lifecycle.phase === "fenced" || lifecycle.inspectionFences.length) {
    rest.status = "blocked";
    rest.reason ??= priorReason ?? "Original recovery is fenced; source-linked inspection required.";
  } else if ((rest.status ?? priorStatus) === "completed" &&
      (lifecycle.active || lifecycle.pending.length)) {
    rest.status = "blocked";
    rest.reason = "Unresolved recovery cases prevent completion.";
  }
  return rest;
}
async function authenticateRecoveryOrigin(
  job: JobStartResult, request: GenerationRequest, graphThreadId: string,
  origin: RecoveryOrigin, evidence: readonly RecoveryEvidence[],
  historicalSource = false,
): Promise<boolean> {
  if (origin.jobId !== job.jobId || origin.graphThreadId !== graphThreadId ||
      origin.jobThreadId !== job.threadId) return false;
  if (request.fixture && request.turnPlanDigest == null) {
    const identity = { jobId: job.jobId, jobThreadId: job.threadId, graphThreadId,
      turnDigest: null, fixture: true, task: request.task, contract: request.contract };
    return origin.turnDigest === fixtureTurnIdentity(identity) &&
      evidence.length === 1 && evidence[0]?.store === "graph-checkpoint" &&
      evidence[0].ref === origin.failureAnchor.ref &&
      await (async () => {
        const head = await trustedHead(job);
        if (!historicalSource) return head === origin.sourceHeadSha;
        try { jobGit(job, "merge-base", "--is-ancestor", origin.sourceHeadSha, head); return true; }
        catch { return false; }
      })();
  }
  return authenticateOriginalFailure(job, request, graphThreadId, origin, evidence);
}
type GenerationNode = keyof typeof nodeFailureSource | "assess_recovery";

async function observeNodeOutcome(node: GenerationNode, s: State, config: RunnableConfig,
  execute: (s: State, config: RunnableConfig) => Promise<Partial<State>>): Promise<Partial<State>> {
  let result: Partial<State>;
  let observation: GenerationOperationRecovery["outcome"] = "returned-failure";
  try { result = await execute(s, config); }
  catch (error) {
    if ((error != null && isGraphBubbleUp(error)) || config.signal?.aborted) throw error;
    observation = "exception";
    const stop = blocked(error ?? Error("Graph operation threw without an error value"));
    result = { status: stop.status, reason: stop.reason };
  }
  const { nonsemanticStop, ...observed } = result;
  if (result.status !== "blocked" || nonsemanticStop || result.operationRecovery || result.unknownRecovery || result.recovery ||
      s.recoveryLifecycle.phase === "fenced" || s.recoveryLifecycle.phase === "paused") return observed;
  const source = node === "assess_recovery" ? null : nodeFailureSource[node];
  const graphThreadId = config.configurable?.thread_id;
  if (source && !s.recoveryLifecycle.active) {
    const job = await openJob(s).catch(() => null);
    if (job) {
      const [operation, reference] = source;
      const assessed = await operationFailure(s, job, operation, result.reason ?? "Unresolved graph operation",
        { reference, assignmentId: s.active?.id }, observation, undefined, graphThreadId);
      return { ...result, ...assessed, status: "running" };
    }
  }
  // No source can be admitted, or the adapter itself failed while reconciling
  // an active case. Preserve both the original obligation and the failed task.
  const operation = source?.[0] ?? s.recoveryLifecycle.active?.origin.operation;
  const check = source ? operationChecks[source[0]] : s.recoveryLifecycle.active?.origin.check;
  const anchor = check && originalGraphFailureAnchor(config, check);
  return { ...result, recoveryLifecycle: admitRecovery(s.recoveryLifecycle, { outcome: "fenced",
    fence: inspectionFence("untrusted-source", { jobId: s.request?.job, graphThreadId, operation, check }, [],
      anchor ? { store: anchor.store, ref: anchor.ref } : null,
      "Inspect the original graph task, Story source and unresolved effects before resuming.") }) };
}

export function recoveryNode(
  node: GenerationNode,
  execute: (s: State, config: RunnableConfig) => Promise<Partial<State>>,
) {
  return async (state: CoreState, config: RunnableConfig): Promise<Partial<CoreState>> => {
    let prior: RecoveryState = {
      recoveryLifecycle: state.recoveryLifecycle ?? emptyRecoveryLifecycle(),
      recoverySources: state.recoverySources ?? [],
    };
    try { assertRecoverySources(prior); }
    catch {
      return { status: "blocked", reason: "Recovery source inputs are missing or contradictory.",
        recoveryLifecycle: admitRecovery(prior.recoveryLifecycle, { outcome: "fenced",
          fence: inspectionFence("untrusted-receipt", {}, [], null,
            "Restore original recovery source receipts; never replay an uncertain writer.") }) };
    }
    if (prior.recoveryLifecycle.inspectionFences.length)
      return { status: "blocked", reason: state.reason ?? "Original recovery requires inspection.", recoveryLifecycle: prior.recoveryLifecycle };
    if (prior.recoveryLifecycle.decision?.action === "diagnostic-stop") {
      const active = prior.recoveryLifecycle.active;
      try {
        const job = await openJob(state);
        const thread = config.configurable?.thread_id;
        if (!active || typeof thread !== "string" ||
            await trustedHead(job) !== active.origin.sourceHeadSha ||
            !await authenticateRecoveryOrigin(job, state.request, thread,
              active.origin, active.evidence) ||
            !await authenticateSealedDiagnosticStop(job, state as State, prior.recoveryLifecycle))
          throw Error("Original diagnostic or invocation receipt is no longer authenticated.");
        return { status: "blocked", reason: state.reason ?? "Original read-only diagnosis requires operator intervention.",
          recoveryLifecycle: prior.recoveryLifecycle };
      } catch {
        return { status: "blocked", reason: "Sealed original diagnostic or its invocation cannot be authenticated.",
          recoveryLifecycle: admitRecovery(prior.recoveryLifecycle, { outcome: "fenced",
            fence: inspectionFence("untrusted-receipt", active?.origin ?? {}, active?.evidence ?? [],
              active ? { store: active.origin.failureAnchor.store,
                ref: active.origin.failureAnchor.ref } : null,
              "Inspect the original Pi session, protocol result and recovery decision before restart.") }) };
      }
    }
    // Resuming via START must reconcile a checkpointed action before schedule
    // can select more work (including after an uncheckpointed adapter return).
    if (node === "schedule" && prior.recoveryLifecycle.assessorPending && !prior.recoveryLifecycle.inspectionFences.length)
      return { status: "running", recoveryLifecycle: prior.recoveryLifecycle };
    // A cancelled Turn is final: a new START cannot reinterpret a checkpointed
    // cancellation as a recoverable graph error or dispatch another agent.
    if (node === "schedule" && prior.recoveryLifecycle.phase === "paused" &&
        prior.recoveryLifecycle.decision?.action === "pause" &&
        prior.recoveryLifecycle.decision.reason === "cancelled")
      return { status: "cancelled", recoveryLifecycle: prior.recoveryLifecycle };
    // A genuine author pause is not an integrity failure and cannot be
    // silently cleared. Resuming the same case requires current author control
    // and the same original authenticated source/Thread; cancellation is final.
    if (node === "schedule" && prior.recoveryLifecycle.phase === "paused" &&
        prior.recoveryLifecycle.decision?.action === "pause" &&
        ["author-pause", "budget", "author-choice", "provider-unavailable"].includes(prior.recoveryLifecycle.decision.reason) &&
        prior.recoveryLifecycle.active) {
      try {
        const job = await openJob(state);
        const graphThreadId = config.configurable?.thread_id as string | undefined;
        const active = prior.recoveryLifecycle.active;
        if (graphThreadId && await readJobControl(job) === "running" &&
            await trustedHead(job) === active.origin.sourceHeadSha &&
            await authenticateRecoveryOrigin(job, state.request, graphThreadId,
              active.origin, active.evidence)) {
          return { status: "running", reason: null,
            recoveryLifecycle: resumePausedRecovery(prior.recoveryLifecycle, true) };
        }
      } catch { /* Preserve the original paused case on untrusted source. */ }
    }
    // An original no-write operation stays unresolved during independent
    // work. LATER verified specialist/idea receipts discharge its same case
    // directly; selecting it for the original assessor would repeat the
    // blocked-HEAD check and could never succeed after correction.
    if ((node === "schedule" || node === "author_update_intake") &&
        prior.recoveryLifecycle.phase === "idle" && !prior.recoveryLifecycle.active &&
        prior.recoveryLifecycle.pending.length) {
      try {
        const job = await openJob(state);
        const control = await readJobControl(job);
        if (control === "paused" || control === "cancelled")
          return { status: control, reason: "Author execution control precedes deferred resolution." };
        const graphThreadId = config.configurable?.thread_id as string | undefined;
        if (!graphThreadId) throw Error("Missing original graph Thread");
        const lifecycle = await withStoryJobLock(job, "generation-deferred-recovery-proof", async () => {
          if (await readJobControl(job) !== "running")
            return prior.recoveryLifecycle;
          let next = prior.recoveryLifecycle;
          for (const pending of prior.recoveryLifecycle.pending) {
            const source = prior.recoverySources.find(item => item.caseId === pending.id);
            if (!source || !await authenticateRecoveryOrigin(job, state.request, graphThreadId,
              pending.origin, pending.evidence, true))
              throw Error("Original deferred failure provenance cannot be authenticated");
            const correction = await inspectDeferredCorrection(job, pending, source, {
              inventory: state.inventory, ideaHistory: state.ideaHistory,
              fixture: state.request.fixture,
            });
            if (correction) next = dischargePendingRecovery(next, correction, true);
          }
          return next;
        });
        if (lifecycle !== prior.recoveryLifecycle)
          return { recoveryLifecycle: lifecycle, status: "running", reason: null };
      } catch {
        return { status: "blocked",
          reason: "Deferred recovery source or correction evidence cannot be authenticated.",
          recoveryLifecycle: admitRecovery(prior.recoveryLifecycle, { outcome: "fenced",
            fence: inspectionFence("untrusted-receipt", {}, [], null,
              "Inspect original failed operation and later correction receipts.") }) };
      }
    }
    if (node === "assess_recovery" && prior.recoveryLifecycle.phase === "assessing" &&
        prior.recoveryLifecycle.active && !prior.recoveryLifecycle.decision) {
      try {
        const active = prior.recoveryLifecycle.active;
        const job = await openJob(state);
        const graphThread = config.configurable?.thread_id;
        if (typeof graphThread !== "string" || await trustedHead(job) !== active.origin.sourceHeadSha ||
            !await authenticateRecoveryOrigin(job, state.request, graphThread, active.origin, active.evidence))
          throw Error("Original failure source no longer matches the selected Turn and current HEAD.");
        const strategy = prior.recoverySources.some(x => x.caseId === active.id && x.channel === "operationRecovery") &&
          await withStoryJobLock(job, "assess-source-bound-operation", () => selectOperationStrategy(job, state, active));
        const selected = strategy ? decideRecovery(prior.recoveryLifecycle, strategy) : decideExistingRecovery(prior);
        return { recoveryLifecycle: { ...selected, assessorPending: true },
          status: "running" };
      } catch {
        return { status: "blocked", reason: "The original failure cannot admit a recovery decision.",
          recoveryLifecycle: admitRecovery(prior.recoveryLifecycle, { outcome: "fenced",
            fence: inspectionFence("untrusted-receipt", prior.recoveryLifecycle.active.origin,
              prior.recoveryLifecycle.active.evidence,
              { store: "graph-checkpoint", ref: prior.recoveryLifecycle.active.origin.failureAnchor.ref },
              "Authenticate the exact original failed-check and domain receipt.") }) };
      }
    }
    // A known response-contract correction executes inside the original
    // adaptive planner/session on author_update_intake, not inside the old
    // assessor callback. The C02 decision is already checkpointed; invoking
    // the legacy assessment again would reject its own "authorized" projection
    // as an unknown new decision and permanently fence a valid correction.
    if (node === "assess_recovery" && prior.recoveryLifecycle.assessorPending &&
        prior.recoveryLifecycle.decision?.action === "known-correction" &&
        prior.recoveryLifecycle.decision.adapter === "response-contract" &&
        prior.recoverySources.some(x => x.caseId === prior.recoveryLifecycle.active?.id && x.channel === "recovery"))
      return { status: "running", reason: null,
        recoveryLifecycle: { ...prior.recoveryLifecycle, assessorPending: false } };
    if (node === "assess_recovery" && prior.recoveryLifecycle.assessorPending &&
        (["diagnostic", "plan-amendment"].includes(prior.recoveryLifecycle.decision?.action ?? "") ||
          prior.recoveryLifecycle.decision?.action === "known-correction" &&
          prior.recoveryLifecycle.decision.adapter === "review-cycle") &&
        prior.recoverySources.some(x => x.caseId === prior.recoveryLifecycle.active?.id && x.channel === "operationRecovery")) {
      const job = await openJob(state);
      const action = await executeOperationStrategy(job, state, prior.recoveryLifecycle);
      if (action) return action;
    }
    const local = { ...state, ...projectRecovery(prior) } as State;
    const outcome = await observeNodeOutcome(node, local, config, execute);
    if (outcome.recoveryLifecycle?.inspectionFences.length) return {
      status: "blocked", reason: outcome.reason, recoveryLifecycle: outcome.recoveryLifecycle,
    };
    const { domain, rest } = extractDomainPatch(projectRecovery(prior), outcome as Record<string, unknown>);
    if (node === "assess_recovery" && !Object.hasOwn(rest, "reason")) rest.reason = null;
    if (!Object.keys(domain).length) {
      const next = node === "assess_recovery" && prior.recoveryLifecycle.assessorPending
        ? { ...prior.recoveryLifecycle, assessorPending: false } : prior.recoveryLifecycle;
      return { ...gateRecoveryOutput(rest, next, state.status,
        state.causalAmendment ? "Original source-bound causal amendment receipt requires validation." :
          state.reason), recoveryLifecycle: next } as Partial<CoreState>;
    }
    const job = await openJob(local);
    const graphThreadId = config.configurable?.thread_id as string | undefined ??
      local.graphThreadId ?? job.threadId + ":generation";
    const identity = { jobId: job.jobId, jobThreadId: job.threadId, graphThreadId,
      turnDigest: local.request.turnPlanDigest ?? null,
      fixture: local.request.fixture, task: local.request.task, contract: local.request.contract };
    const authenticate = (origin: RecoveryOrigin, evidence: readonly RecoveryEvidence[]) =>
      authenticateRecoveryOrigin(job, local.request, graphThreadId, origin, evidence);
    const current = prior.recoveryLifecycle.active;
    const assurance: { originalEffect?: RecoveryEvidence;
      verifiedHead?: string; verifiedReceipt?: RecoveryEvidence;
      authorControl?: "paused" | "cancelled";
      diagnosis?: { recommendation: "operator-intervention" | "inspect-existing-receipt";
        advisoryCategory: "software" | "unclassified" | "resources" | "integrity";
        receipt: RecoveryEvidence } } = {};
    if (current && domain.unknownRecovery?.phase === "operator-intervention") {
      try {
        const previous = projectRecovery(prior).unknownRecovery?.case;
        const claimed = domain.unknownRecovery.case;
        if (previous && claimed && isDeepStrictEqual(previous, claimed) &&
            await authenticate(current.origin, current.evidence)) {
          const diagnosis = await inspectOriginalUnknownDiagnosis(job, previous);
          if ("action" in diagnosis && domain.unknownRecovery.recommendation === diagnosis.action &&
              domain.unknownRecovery.advisoryCategory === diagnosis.category) {
            assurance.diagnosis = { receipt: { store: "response-contract", ref: previous.signature },
              recommendation: diagnosis.action, advisoryCategory: diagnosis.category };
          }
        }
      } catch { /* Unproven original diagnosis is an inspection fence, never a saved stop. */ }
    }
    if (current && domain.operationRecovery?.phase === "fenced" &&
        (rest.status === "paused" || rest.status === "cancelled") &&
        await authenticate(current.origin, current.evidence) &&
        await readJobControl(job) === rest.status)
      assurance.authorControl = rest.status;
    // Existing assessor performs the *original* receipt check under the job
    // lock. Read-only reconciliation is not new writer/admission authority.
    if (current && (node === "assess_recovery" || node === "schedule") &&
        domain.operationRecovery?.phase === "continued" &&
        await authenticate(current.origin, current.evidence)) {
      assurance.originalEffect = current.evidence[0];
    }
    // A C05 proposal alone never closes a case. Only the same original
    // read-only operation, independently re-executed above and reattested
    // here against its settled Pi transcript, can discharge the failed check.
    if (current && node === "assess_recovery" && domain.operationRecovery === null &&
        prior.recoveryLifecycle.decision?.action === "reconcile-effects" &&
        prior.recoveryLifecycle.attempt?.purpose === "diagnosis" &&
        prior.recoveryLifecycle.attempt.phase === "settled") {
      try {
        await withStoryJobLock(job, "generation-c05-resolution-proof", async () => {
          const previous = prior.recoveryLifecycle.decision!;
          const original = await selectOperationStrategy(job, state as State, current);
          if (original?.action !== "diagnostic" ||
              !await authenticateOperationDiagnosticProof(job, state as State, current, original))
            throw Error("Original diagnostic admission is no longer eligible");
          const target = diagnosticCaseForDecision(current, original);
          const proposal = await inspectOriginalUnknownDiagnosis(job, target);
          if (!("strategy" in proposal) || !isDeepStrictEqual(previous,
                authorizeDiagnosticStrategy(state as State, current, original, proposal)) ||
              !isDeepStrictEqual(prior.recoveryLifecycle.attempt,
                await inspectDiagnosticAttempt(job, target, current.id)))
            throw Error("Original diagnostic proposal or Pi attempt changed");
          clean(job);
          const head = await trustedHead(job);
          if (head !== current.origin.sourceHeadSha) throw Error("Original Story revision changed");
          await checkPlan(job, state.request, state.planVersion);
          let receipt: RecoveryEvidence;
          if (current.origin.operation === "scheduling") {
            if (!state.request.turnPlanDigest ||
                !await readTurnEvidence(job, state.request.contract,
                  state.request.task, state.request.turnPlanDigest))
              throw Error("Original author objective proof is missing");
            receipt = original.evidence.at(-1)!;
          } else if (current.origin.operation === "independent-review") {
            const point = (await inspectRecoveryCheckpoints(job)).find(p =>
              p.eligible && p.commitSha === head && p.workItem === state.active?.id &&
              p.validation.status === "passed" && p.semanticReview === "passed" &&
              p.assurance?.turnDigest === state.request.turnPlanDigest);
            if (!point || state.result?.headSha !== head)
              throw Error("Original independent Review pass cannot be reauthenticated");
            receipt = { store: "review-checkpoint", ref: point.commitSha,
              digest: point.proofDigest };
          } else throw Error("No authenticated read-only resolution adapter");
          assurance.verifiedHead = head;
          assurance.verifiedReceipt = receipt;
        });
      } catch { /* Missing source/adapter proof is fenced by applyDomainRecovery. */ }
    }
    if (current && domain.recovery?.phase === "completed") {
      try {
        const { verifyAdaptiveRecoveryProof } = await import("./adaptive-protocol.js");
        const source = projectRecovery(prior).recovery;
        if (source && await authenticate(current.origin, current.evidence)) {
          await verifyAdaptiveRecoveryProof(job, source);
          const head = await trustedHead(job);
          assurance.verifiedHead = head;
          assurance.verifiedReceipt = { store: "response-contract", ref: source.proof.file };
        }
      } catch { /* Fail-closed in applyDomainRecovery. */ }
    }
    if (current && node === "verify_committed_work" &&
        domain.operationRecovery === null && prior.recoveryLifecycle.phase === "verifying") {
      const head = await trustedHead(job);
      if ((await inspectRecoveryCheckpoints(job)).some(point =>
        point.eligible && point.commitSha === head &&
        (point.semanticReview === "passed" || point.semanticReview === "not-required"))) {
        assurance.verifiedHead = head;
        assurance.verifiedReceipt = { store: "review-checkpoint", ref: head };
      }
    }
    const mapped = await applyDomainRecovery(prior, domain, config as never,
      identity, authenticate, assurance);
    const lifecycle = node === "assess_recovery" && prior.recoveryLifecycle.assessorPending
      ? { ...mapped.recoveryLifecycle, assessorPending: false } : mapped.recoveryLifecycle;
    return { ...gateRecoveryOutput(rest, lifecycle, state.status,
      state.causalAmendment ? "Original source-bound causal amendment receipt requires validation." :
        state.reason), recoveryLifecycle: lifecycle,
      recoverySources: mapped.recoverySources } as Partial<CoreState>;
  };
}

/** The production parent graph. Specialists retain ownership of side effects and recovery. */
export function createGenerationGraph(
  checkpointer?: SqliteSaver, executionOwner: "server" | "cli" = "server",
  // Deterministic transport-boundary substitution for graph-level tests.
  // Production callers always use the real sealed review/repair adapter.
  reviewBoundary: (state: State, correctionSelected?: boolean) => Promise<Partial<State>> = independentAssignmentBoundary,
) {
  return new StateGraph(Channels, { input: GenerationInputSchema })
    .addNode("schedule", recoveryNode("schedule", async (s, config) => {
      // A blocked original Thread may resume only when its CURRENT controller
      // proof verifies the specific unfinished operation. Recheck at graph
      // entry: an HTTP admission never grants an independent writer.
      if (executionOwner === "server" && s.status === "blocked" &&
          (s.operationRecovery?.phase === "fenced" ||
           s.operationRecovery?.phase === "continued")) {
        const job = await openJob(s).catch(() => null);
        const threadId = config.configurable?.thread_id as string | undefined;
        if (job && threadId) {
          const verified = await inspectBlockedOriginalThreadCorrection(job, threadId, s)
            .catch(() => null);
          if (verified?.eligible) {
            const failures = { ...s.failures };
            if (verified.assignmentId) delete failures[verified.assignmentId];
            return { status: "running" as const, reason: null, failures,
              ...(verified.assignmentId ? { active: null, result: null } : {}),
              operationRecovery: { ...s.operationRecovery, phase: "continued" as const } };
          }
        }
      }
      // A new graph invocation must not re-enter a fenced or not-yet-assessed
      // external operation. The original checkpoint remains inspectable.
      if (s.operationRecovery?.phase === "fenced") {
        const op = s.operationRecovery;
        // Read-only scheduling/intake may be rechecked against reconciled
        // receipts. An uncertain idea writer remains permanently fenced until
        // its original dispatch is explicitly reconciled.
        return op.outcome === "exception" &&
          (op.operation === "scheduling" || op.operation === "author-update-intake") ?
          { status: "running" as const, operationRecovery: { ...op, phase: "assessment" as const } } :
          op.operation === "specialist-dispatch" && op.outcome === "exception" && s.active &&
            (s.active.stage === "foundation" || s.active.stage === "foundations") &&
            !s.result ?
          await (async () => {
            const job = await openJob(s);
            // A specialist may have committed before publishing its parent
            // checkpoint. Reconcile that same original receipt before any
            // further scheduling; never manufacture a fresh writer lease.
            const settled = await inspectOriginalSpecialistCommitForResume(s, job)
              .catch(() => false);
            return { status: "running" as const,
              operationRecovery: { ...op, phase: settled ? "continued" as const : "assessment" as const } };
          })() :
          { status: "blocked" as const, reason: op.reason + " " + op.nextAction };
      }
      if (s.operationRecovery?.phase === "assessment") return { status: "running" as const };
      if (s.fixPickup) {
        const r = s.recovery, f = s.fixPickup;
        if (!r || !authorizedKnownFixDispatch(f, s.request?.job ?? "", r.threadId) ||
            executionOwner !== "server" || s.status !== "blocked" || !s.orchestratorOrder ||
            !s.orchestratorPlanningDigest || !s.orchestratorSnapshotId ||
            !s.graphThreadId || r.planVersion !== s.planVersion ||
            r.phase !== "protocol-exhausted" ||
            r.check !== f.check || r.checkVersion !== f.failedVersion ||
            r.signature !== f.signature || r.jobId !== s.request?.job ||
            r.turnDigest !== s.request?.turnPlanDigest || !/^[a-z0-9][a-z0-9.-]{0,100}$/.test(f.id))
          return blocked(Error("Known-fix pickup has no exact blocked verifier and Turn proof"));
      }
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
    }))
    .addNode("assess_recovery", recoveryNode("assess_recovery", async (s, config) => {
      // Historical v1 unknownRecovery receipts remain inspectable, not executable.
      // Only the shared source-bound C03 operation lane can start a new diagnosis.
      if (s.unknownRecovery?.phase === "assessment")
        return { status: "blocked" as const,
          reason: "Legacy completion-only diagnosis is inspection-only; reconcile the original receipt." };
      const op = s.operationRecovery;
      if (op?.phase === "assessment") {
        const fence = (reason: string): Partial<State> => ({
          status: "blocked", operationRecovery: { ...op, phase: "fenced" },
          reason: op.reason + " " + reason + " " + op.nextAction,
        });
        const job = await openJob(s).catch(() => null);
        if (!job || op.version !== 1 || op.check !== operationChecks[op.operation] ||
            op.checkVersion !== 1 || op.source.jobId !== s.request.job ||
            op.source.threadId !== (s.graphThreadId ?? config.configurable?.thread_id) ||
            op.source.turnDigest !== (s.request.turnPlanDigest ?? null) ||
            op.source.planVersion !== (s.planVersion ?? null))
          return fence("Controller recovery source identity is missing or mismatched.");
        // All assessment routes, including read-only reviewer failures, obey
        // the same durable author controls before considering any continuation.
        try {
          const control = await readJobControl(job);
          if (control === "cancelled" || control === "paused")
            return { status: control, reason: "Author control takes precedence over recovery.",
              operationRecovery: { ...op, phase: "fenced" as const } };
        } catch (error) {
          return fence("Author control is unavailable or untrusted: " + String(error));
        }
        if (s.recoveryLifecycle.decision?.action === "reconcile-effects" && op.outcome === "exception" &&
            (op.operation === "scheduling" || op.operation === "author-update-intake")) {
          try {
            await withStoryJobLock(job, "generation-read-only-reconciliation", async () => {
              clean(job);
              const head = await trustedHead(job);
              if (!op.source.headSha || head !== op.source.headSha)
                throw Error("Scheduling/intake source changed; original operation cannot be replayed.");
              await verifyDependencyHistory(job, s.dependencyHistory ?? []);
              await verifyPinnedPendingWork(job, s.request.turnPlanDigest, s.pendingVersion);
              await checkPlan(job, s.request, s.planVersion);
              if (op.operation === "scheduling" &&
                  s.request.orchestrationPolicy === "explicit" && s.request.turnPlanDigest) {
                const turn = await readTurnEvidence(job, s.request.contract,
                  s.request.task, s.request.turnPlanDigest);
                if (!turn || turn.objective && (!s.orchestratorOrder ||
                    !s.orchestratorPlanningDigest || !s.orchestratorSnapshotId))
                  throw Error("Original objective planning has no sealed graph result; do not skip its reconciliation.");
              }
              if (op.operation === "author-update-intake") {
                const updates = await processAuthorUpdatesAfterWork(job);
                if ("error" in updates || updates.status !== "ready")
                  throw Error("Author intake still has an unresolved message or acknowledgement.");
              } else if (!isFocusedScope(s.request.contract)) {
                // This is the original read-only scheduling operation, not an
                // idea placement or a new Pi writer invocation.
                await scheduleIdeasAtBoundary(job, "parent-generation");
              }
            });
            // After the original read-only check succeeds, discharge only a
            // settled C05 diagnostic proposal. The wrapper independently
            // authenticates its Pi attempt and original source once more.
            if (s.recoveryLifecycle.attempt?.purpose === "diagnosis" &&
                s.recoveryLifecycle.attempt.phase === "settled")
              return { status: "running" as const, reason: null, operationRecovery: null };
            return { status: "running" as const, reason: null,
              operationRecovery: { ...op, phase: "continued" as const } };
          } catch (error) {
            return fence("Read-only recovery remains unresolved: " +
              (error instanceof Error ? error.message : String(error)));
          }
        }
        if (op.operation === "independent-review" && op.outcome === "exception" &&
            s.recoveryLifecycle.decision?.action === "reconcile-effects" &&
            s.recoveryLifecycle.attempt?.purpose === "diagnosis" &&
            s.recoveryLifecycle.attempt.phase === "settled") {
          try {
            await withStoryJobLock(job, "generation-review-reconciliation", async () => {
              clean(job);
              const head = await trustedHead(job);
              if (head !== op.source.headSha || !s.active ||
                  op.evidence.assignmentId !== s.active.id || s.result?.headSha !== head)
                throw Error("Original independent Review source or assignment changed.");
              await checkPlan(job, s.request, s.planVersion);
              const point = (await inspectRecoveryCheckpoints(job)).find(p =>
                p.eligible && p.commitSha === head && p.workItem === s.active!.id &&
                p.validation.status === "passed" && p.semanticReview === "passed" &&
                p.assurance?.turnDigest === s.request.turnPlanDigest);
              if (!point) throw Error("No independently sealed original Review pass exists for the failed assignment.");
            });
            return { status: "running" as const, reason: null, operationRecovery: null };
          } catch (error) {
            return fence("Original Review reconciliation lacks independent pass evidence: " + String(error));
          }
        }
        if (op.operation === "specialist-dispatch" &&
            s.recoveryLifecycle.decision?.action === "reconcile-effects" && op.outcome === "exception") {
          try {
            if (await inspectOriginalSpecialistCommitForResume(s, job))
              return { status: "running" as const, reason: null,
                operationRecovery: { ...op, phase: "continued" as const } };
          } catch (error) {
            return fence("Original specialist commit recovery was not authenticated: " +
              (error instanceof Error ? error.message : String(error)));
          }
        }
        if (s.recoveryLifecycle.decision?.action !== "continue-independent") {
          const head = await trustedHead(job).catch(() => null);
          if (!head || op.source.headSha !== head)
            return fence("Original Story HEAD is missing or changed; execution is not authorized.");
          return fence(op.reason);
        }
        try {
          if (op.operation === "specialist-dispatch") {
            await withStoryJobLock(job, "generation-independent-specialist-failure", async () => {
              clean(job);
              const head = await trustedHead(job);
              const assignment = op.evidence.assignmentId;
              const item = s.inventory?.items.find(i => i.id === assignment);
              if (!assignment || !item || item.status !== "blocked" ||
                  s.inventory?.headSha !== head || op.source.headSha !== head ||
                  op.evidence.priorHead !== head || s.failures[assignment] !== op.reason ||
                  s.active || s.result || item.verifiedSha || !s.inventory)
                throw Error("Original no-write specialist failure lacks its exact blocked inventory and unchanged HEAD.");
            });
            return { operationRecovery: { ...op, phase: "continued" as const }, reason: null };
          }
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
    }))
    .addNode("author_update_intake", recoveryNode("author_update_intake", async s => {
      const job = await openJob(s);
      return withStoryJobLock(job, "generation-boundary", async () => {
        try {
          const stopped = await authorBoundary(job, s);
          if (stopped) return stopped;
          // The completed result was authenticated by both Studio and graph
          // entry. No model-backed review or planning before verifier retry.
          if (s.operationRecovery?.operation === "commit-verification" &&
              s.operationRecovery.phase === "continued" && s.active && s.result)
            return {};
          const receipt = await checkPlan(job, s.request, s.planVersion);
          // A verified other-owner correction is not review coverage until
          // impacted dependents have been revalidated. Resume this persisted
          // read-only operation before even considering another writer.
          const { settlePendingOtherOwnerRevalidations } =
            await import("./review-other-owner-revalidation.js");
          const { policy } = await (await import("./job-pi-policy.js")).inspectPiPolicy(job);
          try {
            await settlePendingOtherOwnerRevalidations({
              job, inventory: s.inventory ?? undefined, contract: s.request.contract,
              task: s.request.task, provider: s.request.provider ?? policy.profile.provider,
              model: s.request.model ?? policy.profile.model,
              skillsSource: s.request.skillsSource, validatorSource: s.request.validatorSource,
            });
          } catch (error) {
            return operationFailure(s, job, "independent-review", error,
              { reference: "review-checkpoints", assignmentId: s.active?.id });
          }
          // Preserve an in-flight result. For interrupted external effects, only the
          // original specialist may reconcile the dirty/unpublished work boundary.
          if (s.ideaTask) return {};
          if (s.active && !s.result &&
              s.operationRecovery?.operation === "specialist-dispatch" &&
              s.operationRecovery.phase === "continued") {
            // The assessor has proven a committed original specialist can
            // reconcile. The specialist must reauthenticate its own receipt
            // immediately before any operation; no new writer is admitted.
            if (await inspectOriginalSpecialistCommitForResume(s, job)) return {};
            return operationFailure(s, job, "specialist-dispatch",
              "Original committed specialist reconciliation proof disappeared.",
              { reference: "specialist-receipt", assignmentId: s.active.id });
          }
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
              return s.reviewSteeringHandoff ?
                { reviewSteeringHandoff: false, reason: null } : {};
            }
            // A Foundation may have committed its exact authored bytes
            // before publishing the final receipt. The ORIGINAL Foundation
            // worker can reauthenticate and finalize that commit; generic
            // trustedHead deliberately refuses incomplete receipts, so do
            // not misclassify this narrow crash window as an untrusted source
            // or start a replacement writer.
            if (s.active.stage === "foundation" &&
                await inspectOriginalSpecialistCommitForResume(s, job))
              return { status: "running" as const, reason: null };
            try { clean(job); await trustedHead(job); }
            catch (error) {
              return operationFailure(s, job, "specialist-dispatch", error,
                { reference: "specialist-receipt", assignmentId: s.active.id });
            }
          }
          if (s.result) throw new Error("Plan changed with an unverified dispatch result; reconcile the original assignment first.");
          clean(job);
          const next = await reconcile(s, job);
          if (next.status === "paused" || next.status === "blocked" ||
              next.recovery?.phase === "assessment" ||
              next.operationRecovery?.phase === "assessment") return next;
          const boundary = await applyLiveSteeringAtBoundary(job, s.request, next.inventory ?? null);
          if (boundary) return { ...next, ...boundary, ideaTask: null, escalation: null };
          const head = await trustedHead(job);
          // Existing Event/Choice ownership and its native fulfillment contract
          // are checked before allocating any Composition model context. A
          // saved closeout proposal is a graph routing decision, never a lease;
          // the separate node re-authenticates the entire source under lock.
          if (next.active?.stage === "composition" && next.active.milestone &&
              next.planVersion && next.request?.turnPlanDigest && !next.request.fixture) {
            let decision: Awaited<ReturnType<typeof preflightCompositionBoundary>>;
            try {
              decision = await preflightCompositionBoundary(job, next.request,
                next.active.milestone, next.planVersion);
            } catch (error) {
              return operationFailure(s, job, "dependency-amendment", error,
                { reference: "dependency-plan", assignmentId: next.active.id });
            }
            if (decision.kind === "author-required") return {
              ...next, status: "paused" as const, reason: decision.reason,
              escalation: { kind: "protected-approval" as const,
                requiresTrustedApproval: true,
                sources: [{ source: next.active.milestone, message: decision.reason,
                  repair: "protected" }],
                action: "Request the original author’s approval through the existing scope/decision workflow." },
            };
            if (decision.kind === "refuse") {
              const failure = "Composition prerequisite preflight refused: " + decision.reason;
              return {
                ...next,
                ...await operationFailure({ ...s, ...next }, job, "dependency-amendment",
                  failure, { reference: "dependency-plan", assignmentId: next.active.id,
                    resultStatus: "preflight-refused" }, "returned-failure"),
                escalation: { kind: "dependency-replan" as const,
                  requiresTrustedApproval: false,
                  sources: [{ source: next.active.milestone, message: decision.reason,
                    repair: "event" }],
                  action: "Inspect original Event/Choice proofs and authorize only a verified " +
                    "bounded prerequisite amendment. Do not dispatch Composition or fabricate fulfillment." },
              };
            }
            if (decision.kind === "repair") return { ...next,
              ...await operationFailure({ ...s, ...next }, job, "dependency-amendment", "Verified Composition prerequisite requires its source-bound owner.",
                { reference: "dependency-plan", assignmentId: next.active.id, closeout: {
                  milestoneId: next.active.milestone, proposalDigest: decision.proposal.digest, repairId: decision.repairId } }, "returned-failure"),
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
            if (checkpoint) {
              try { await sealReviewedOmissionBatch(job, checkpoint, next.inventory); }
              catch (error) {
                return operationFailure(s, job, "independent-review", error,
                  { reference: "review-checkpoints", assignmentId: next.active.id });
              }
            }
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
    }))
    .addNode("idea_integration", recoveryNode("idea_integration", async s => {
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
    }))
    .addNode("verify_idea_integration", recoveryNode("verify_idea_integration", async s => {
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
    }))
    .addNode("specialist_dispatch", recoveryNode("specialist_dispatch", async s => {
      if (s.crossDomainCloseout) throw Error("Unassessed prerequisite cannot authorize specialist dispatch.");
      // A saved dispatch result means the external stage completed before a parent
      // verification checkpoint. Otherwise the stage API reconciles its receipt,
      // including a commit published before its receipt; never invent a new writer.
      if (s.result) return {};
      try {
        let result = await dispatch(s);
        if (result.status === "interactive-conflict-reported") {
          const evidence = result as typeof result & { prerequisite?: {
            milestoneId: string; expectedHead: string; reportDigest: string; domain: string };
            conflicts?: string[]; obligations?: string[] };
          const report = evidence.prerequisite;
          if (!report || report.domain !== "choice" ||
              s.active?.stage !== "choice" && s.active?.stage !== "interactive" ||
              !s.active.milestone || s.active.milestone !== report.milestoneId ||
              s.active.id !== "choice:" + report.milestoneId &&
              s.active.id !== "interactive:" + report.milestoneId ||
              !/^[0-9a-f]{64}$/.test(report.reportDigest) ||
              !evidence.conflicts?.length)
            throw Error("Choice negative result lacks its original bounded assignment and report");
          const job = await openJob(s);
          const { inspectInteractiveConflict } = await import("./interactive-work.js");
          const original = await inspectInteractiveConflict(job, report.milestoneId);
          if (original.expectedHead !== report.expectedHead ||
              original.reportDigest !== report.reportDigest ||
              original.worker !== (s.request.fixture ? "fixture" : "pi") ||
              original.planVersion !== s.planVersion ||
              JSON.stringify(original.conflicts) !== JSON.stringify(evidence.conflicts) ||
              JSON.stringify(original.obligations) !== JSON.stringify(evidence.obligations))
            throw Error("Interactive contradiction no longer matches its sealed Pi source");
          const failure = "Original Choice returned a settled no-write architectural contradiction: " +
            original.conflicts.join("; ") + ". Deferred obligations: " +
            original.obligations.join("; ") +
            ". Controller-owned Repair must inspect the original Blueprint and assignment before authorizing another owner.";
          const assessment = await operationFailure(s, job, "specialist-result", failure,
            { reference: "specialist-receipt", assignmentId: s.active.id,
              resultStatus: result.status, interactiveNoWrite: {
                milestoneId: report.milestoneId, expectedHead: report.expectedHead,
                reportDigest: report.reportDigest, domain: "choice" } }, "returned-failure");
          return { ...assessment, failures: { ...s.failures, [s.active.id]: failure },
            inventory: blockedAssignmentInventory(s, failure), active: null, result: null,
            escalation: { kind: "dependency-replan" as const, requiresTrustedApproval: false,
              sources: original.conflicts.slice(0, 8).map(message => ({
                source: report.milestoneId + "@" + report.expectedHead,
                message, repair: "controller-plan-review" })),
              action: "Independently review the original approved Milestone Blueprint, " +
                "Choice assignment and sealed negative Pi report. Propose a separate, " +
                "source-authenticated owner/plan amendment if warranted; no replacement " +
                "Choice, protected decision or new specialist scope is authorized." } };
        }
        if (result.status === "foundations-conflict-reported") {
          const evidence = result as typeof result & {
            prerequisite?: { domain: "world" | "character"; expectedHead: string; reportDigest: string };
            conflicts?: string[]; obligations?: string[] };
          if (!evidence.prerequisite || s.active?.stage !== "foundations" ||
              s.active.id !== "foundations" || !evidence.conflicts?.length ||
              !/^[0-9a-f]{64}$/.test(evidence.prerequisite.reportDigest))
            throw Error("Foundation semantic conflict lacks its original bounded assignment");
          const job = await openJob(s);
          const { inspectFoundationConflict } = await import("./character-world.js");
          const report = await inspectFoundationConflict(job, evidence.prerequisite.domain);
          if (report.reportDigest !== evidence.prerequisite.reportDigest ||
              report.expectedHead !== evidence.prerequisite.expectedHead ||
              report.planVersion !== s.planVersion ||
              report.worker !== (s.request.fixture ? "fixture" : "pi") ||
              JSON.stringify(report.conflicts) !== JSON.stringify(evidence.conflicts) ||
              JSON.stringify(report.obligations) !== JSON.stringify(evidence.obligations))
            throw Error("Foundation no-write report differs from its original settled specialist");
          const failure = "Original " + report.domain + " Foundation returned a settled, clean architectural contradiction: " +
            report.conflicts.join("; ") + ". Controller/Architecture owns prerequisite rescoping; " +
            "neither Foundation writer may receive an expanded lease.";
          const assessed = await operationFailure(s, job, "specialist-result", failure,
            { reference: "specialist-receipt", assignmentId: s.active.id,
              resultStatus: result.status, foundationsNoWrite: {
                domain: report.domain, expectedHead: report.expectedHead,
                reportDigest: report.reportDigest } }, "returned-failure");
          return { ...assessed, failures: { ...s.failures, [s.active.id]: failure },
            inventory: blockedAssignmentInventory(s, failure), active: null, result: null,
            escalation: { kind: "dependency-replan" as const, requiresTrustedApproval: false,
              sources: report.conflicts.map(message => ({
                source: report.domain + "-foundations@" + report.expectedHead,
                message, repair: "controller-plan-review" })),
              action: "Review the original approved Architecture/Turn assignment and the " +
                "settled World/Character specialist report before separately authorizing an owner or plan amendment." } };
        }
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
          // A genuinely settled production Event no-write is a recoverable
          // semantic failure, not a harmless skipped cluster. The original
          // session/report remains the effect authority. Admit the exact
          // failed specialist-result check before removing the active writer
          // and keep the failed objective in the inventory; a diagnostic
          // never grants another Event, Choice or Composition writer.
          const originalFailure = s.request.fixture ? {} :
            await operationFailure(s, job, "specialist-result", failure,
              { reference: "specialist-receipt", assignmentId: s.active!.id,
                resultStatus: "event-prerequisite-reported", eventNoWrite: {
                  milestoneId: s.active!.milestone!, expectedHead: evidence.prerequisite!.expectedHead,
                  reportDigest: evidence.prerequisite!.reportDigest,
                } }, "returned-failure");
          return { ...originalFailure, failures: { ...s.failures, [s.active!.id]: failure },
            inventory: blockedAssignmentInventory(s, failure),
            active: null, result: null };
        }
        // A failed or unexpected specialist *result* is as consequential as
        // an exception: do not silently sideline the assignment and dispatch
        // another writer without checkpointing a recovery decision.
        if (result.status !== "dependency-required" &&
            !accepted[s.active!.stage].includes(result.status))
          return operationFailure(s, await openJob(s), "specialist-result",
            "Unexpected specialist result: " + result.status,
            { reference: "specialist-receipt", assignmentId: s.active!.id,
              resultStatus: result.status }, "returned-failure");
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
        const assessment = await operationFailure(s, job, "specialist-dispatch", error,
          { reference: "specialist-receipt", assignmentId: s.active?.id });
        // The failure may belong only to this cluster. Record it as blocked
        // for inspection without claiming the active writer is replayable.
        try {
          return await withStoryJobLock(job, "generation-failed-specialist-inventory", async () => {
            clean(job); await trustedHead(job);
            const sameHead = s.inventory?.headSha === await trustedHead(job);
            if (!sameHead && (s.active?.stage === "foundation" ||
                              s.active?.stage === "foundations"))
              return assessment; // Original commit can be reconciled only by its pinned specialist.
            const safeAction = sameHead ? "continue-independent" as const : undefined;
            const assessed = safeAction ? await operationFailure(s, job,
              "specialist-dispatch", error,
              { reference: "specialist-receipt", assignmentId: s.active!.id,
                priorHead: s.inventory!.headSha }, "exception", safeAction) : assessment;
            return { ...assessed, failures: { ...s.failures, [s.active!.id]: stop.reason! },
              inventory: blockedAssignmentInventory(s, stop.reason!),
              active: null, result: null };
          });
        } catch { return assessment; }
      }
    }))
    .addNode("dependency_amendment", recoveryNode("dependency_amendment", async s => {
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
      } catch (error) {
        const stop = blocked(error);
        if (stop.status !== "blocked") return stop;
        return operationFailure(s, await openJob(s), "dependency-amendment", error,
          { reference: "dependency-plan", assignmentId: s.active?.id });
      }
    }))
    .addNode("independent_assignment_review", recoveryNode("independent_assignment_review", async s => {
      const selected = s.recoveryLifecycle;
      const correction = selected.phase === "correcting" &&
        !selected.assessorPending && selected.active?.origin.operation === "independent-review" &&
        selected.decision?.action === "known-correction" &&
        selected.decision.adapter === "review-cycle";
      if (correction) {
        const job = await openJob(s);
        const { authenticateOperationReviewProof } =
          await import("./generation-operation-strategy.js");
        if (!await authenticateOperationReviewProof(job, s, selected.active!, selected.decision!))
          throw Error("Saved Review correction lost its original failed verdict");
      }
      const reviewed = await reviewBoundary(s, correction);
      if (correction) {
        if (reviewed.reviewSteeringHandoff)
          return reviewed; // Preserve original Review-to-author intake boundary.
        if (reviewed.status === "paused" || reviewed.status === "cancelled" ||
            reviewed.status === "blocked")
          return reviewed; // Retain original correction decision and receipts.
        const job = await openJob(s);
        const head = await trustedHead(job);
        const points = (await inspectRecoveryCheckpoints(job)).filter(p => p.eligible);
        const { resolvedCheckpointReviews } = await import("./checkpoint-assurance.js");
        const statuses = await resolvedCheckpointReviews(job, points);
        const original = selected.active!;
        // A passing successor alone is not proof that the original rejected
        // writer was actually corrected. Walk the source-linked repair chain,
        // requiring the terminal original-session repair receipt and its
        // independently reviewed, exact committed successor.
        const successor = points.find(p => p.commitSha === head && p.assurance &&
          p.workItem.startsWith("repair-") &&
          ["passed", "not-required"].includes(statuses.get(p.commitSha) ?? p.semanticReview));
        let repairVerified = false;
        if (successor) {
          const sourceSha = successor.workItem.slice("repair-".length);
          const { inspectRejectedRepair } = await import("./rejected-review-repair.js");
          const receipt = await inspectRejectedRepair(job, sourceSha);
          repairVerified = receipt.phase === "passed" && receipt.repairedCommitSha === head &&
            receipt.rootFailureSha === original.origin.sourceHeadSha;
        }
        const verified = repairVerified &&
          statuses.get(original.origin.sourceHeadSha) === "not-required";
        if (!verified)
          return { status: "blocked" as const,
            reason: "Original failed independent Review has no independently passing corrective successor." };
        return { ...reviewed,
          recoveryLifecycle: finishVerifiedRecovery(selected, {
            status: "verified", caseId: original.id, sourceHeadSha: head,
            assurance: { store: "review-checkpoint", ref: head },
          }, true), status: "running" as const, reason: null };
      }
      // A trusted negative Review disposition must reach the same typed
      // assessment as a thrown reviewer failure. Keep the existing persistent
      // Review cycle and original writer receipts; do not retry that writer.
      if (reviewed.status === "blocked" && reviewed.escalation?.kind === "dependency-replan" &&
          !reviewed.nonsemanticStop && s.active && s.result) {
        const assessed = await operationFailure(s, await openJob(s), "independent-review",
          reviewed.reason ?? "Unresolved source-linked independent review",
          { reference: "review-checkpoints", assignmentId: s.active.id }, "returned-failure");
        return { ...reviewed, ...assessed };
      }
      return reviewed;
    }))
    .addNode("verify_committed_work", recoveryNode("verify_committed_work", async s => {
      const job = await openJob(s);
      return withStoryJobLock(job, "generation-verification", async () => {
        try {
          clean(job);
          const headSha = await trustedHead(job);
          const receipt = await checkPlan(job, s.request, s.planVersion);
          const planVersion = receipt?.plan?.version ?? null;
          const stage = s.active!.stage;
          // A fixture-only multi-specialist handoff has no independent Pi
          // reviewer. It must stop for separately sealed semantic review,
          // not fabricate a failed specialist-result recovery case. Real Pi
          // runs keep their existing reviewer/reentry path unchanged.
          if (s.request.fixture && s.result?.status === "review-handoff") {
            const next = stage === "foundations" ? "character-foundations" :
              ["interactive", "choice", "puzzle"].includes(stage) && s.active?.milestone
                ? "interactive-" + (stage === "choice" ? "choice" : "puzzle") +
                  "-" + s.active.milestone.slice(10) : null;
            if (!next) throw Error("Fixture Review handoff has no original specialist.");
            try {
              await assertNativeReviewDependencies(job, next);
            } catch (error) {
              if (!(error instanceof IndependentReviewGateError)) throw error;
              return { nonsemanticStop: "fixture-verdict" as const, status: "blocked" as const,
                reason: "Fixture specialist is awaiting a separately sealed independent " +
                  "semantic Review. A structural fixture handoff is not a failed writer " +
                  "or an authorization to waive the original Review." };
            }
            // The original checkpoint's review is now independently sealed.
            // Return to the SAME original specialist for its unfinished unit.
            // The specialist itself reauthenticates the earlier commit before
            // authoring any dependent Choice/Puzzle/Character work.
            return { result: null, status: "running" as const, reason: null };
          }
          if (!s.result || !accepted[stage].includes(s.result.status))
            return operationFailure(s, job, "specialist-result",
              "Missing or unaccepted specialist result: " + (s.result?.status ?? "absent"),
              { reference: "specialist-receipt", assignmentId: s.active!.id,
                resultStatus: s.result?.status ?? "absent" }, "returned-failure");
          // A result authored under v1 never inherits v2's permissions just
          // because an author signed a new plan while verification was pending.
          const completedStages = [...s.completedStages, { stage, milestone: s.active?.milestone,
            headSha: s.result.headSha ?? headSha, status: s.result.status,
            planVersion: s.planVersion ?? planVersion ?? undefined }];
          if (s.operationRecovery?.operation === "commit-verification" &&
              s.operationRecovery.phase === "continued") {
            const proof = s.request.turnPlanDigest && s.operationRecovery.evidence.verifier &&
              await verifyCorrectedOriginalResult(job, s.request.turnPlanDigest,
                s.active, s.result, s.operationRecovery.evidence.verifier, s.planVersion);
            if (!proof || !proof.eligible ||
                s.operationRecovery.source.headSha !==
                  s.operationRecovery.evidence.verifier?.failureHeadSha)
              throw Error("Original verifier reconciliation changed after admission: " +
                (proof ? proof.reason : "original input is unavailable"));
            // Recheck the *actual* verifier's dependency and plan invariants
            // without starting a pending reviewer/planner or giving a writer a
            // new lease. A newly approved correction is not, by itself, proof
            // that the failed verifier's prerequisite was satisfied.
            const rechecked = await reconcile({ ...s, completedStages,
              // The original request stays pinned until recovery succeeds.
              // Inside the verifier use ONLY the newly author-signed current
              // contract, not an unsanctioned substitute or the stale v1
              // request paired with a v3 plan version.
              request: { ...s.request,
                contract: receipt?.plan?.contract ?? s.request.contract },
              active: null, result: null, planVersion }, job, false);
            const verified = rechecked.inventory?.items.find(item =>
              item.id === s.active!.id);
            const retained = rechecked.completedStages?.some(entry =>
              entry.stage === stage && entry.milestone === s.active?.milestone &&
              entry.headSha === s.result?.headSha);
            if (!retained || verified?.status !== "verified" ||
                rechecked.status === "blocked" || rechecked.status === "paused" ||
                rechecked.operationRecovery?.phase === "assessment" ||
                rechecked.recovery?.phase === "assessment")
              throw Error("Corrected verifier did not independently revalidate the original completed result.");
            // This step acknowledges only the original already-reviewed
            // result. New adaptive proposals or dependent reviewers run
            // later through the normal author-intake boundary.
            return { request: rechecked.request, completedStages, active: null,
              result: null, planVersion, operationRecovery: null, cursor: s.cursor + 1,
              ...(s.pauseAfter === stage
                ? { status: "paused" as const, reason: "Requested safe-boundary pause" }
                : { status: "running" as const, reason: null }) };
          }
          const next = await reconcile({ ...s, completedStages, active: null, result: null, planVersion }, job);
          // A real verifier must never report successful completion when a
          // signed plan change discarded the just-reviewed original work.
          // This is detected at the normal production boundary, not solely
          // when attempting an eventual recovery.
          const retained = next.completedStages?.some(entry =>
            entry.stage === stage && entry.milestone === s.active?.milestone &&
            entry.headSha === (s.result?.headSha ?? headSha));
          const verified = next.inventory?.items.find(item => item.id === s.active!.id);
          if (verifiableResultStatus[stage].includes(s.result.status) &&
              (!retained || verified?.status !== "verified"))
            throw Error("The original completed specialist is not authorized by the current reviewed plan; revalidate or explicitly carry it forward.");
          // A newly verified specialist has just reached a safe boundary. The
          // next assignment must not become in-flight until author steering and
          // other boundary updates have been reconciled by author_update_intake.
          // Preserve the in-flight guard there for genuinely interrupted writers.
          return { ...next, active: null, cursor: s.cursor + 1, result: null,
            ...(s.pauseAfter === stage ? { status: "paused" as const, reason: "Requested safe-boundary pause" } : {}) };
        } catch (error) {
          const stop = blocked(error);
          if (stop.status !== "blocked") return stop;
          // Capture verified original inputs at failure, never from user or
          // model prose. Missing checkpoint provenance remains safely fenced.
          const verifier = s.request.turnPlanDigest ? await captureVerificationFailure(job,
            s.request.turnPlanDigest, s.active, s.result, s.planVersion).catch(() => null) : null;
          return operationFailure(s, job, "commit-verification", error,
            { reference: "review-checkpoints", assignmentId: s.active?.id,
              ...(verifier ? { verifier } : {}) });
        }
      });
    }))
    .addNode("completion_decision", recoveryNode("completion_decision", async s => {
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
          if (report.generation.status === "completed" && !authorizedInventoryComplete(s.inventory))
            return operationFailure(s, job, "completion-verification",
              "The completion report claims success without a complete authenticated assignment inventory.",
              { reference: "completion-report", resultStatus: report.generation.status }, "returned-failure");
          const escalation = complete ? null : reviewEscalation(report, s.inventory);
          // Unknown final-verdict anomalies now use the SAME C03 case lane as
          // specialist/Review/admission failures. Preserve the original report
          // tuple and verified checkpoint; never issue a second diagnosis because
          // the report merely rewrote its error prose.
          if (!complete && !escalation && !s.request.fixture && s.planVersion &&
              authorizedInventoryComplete(s.inventory) && isTrustedFinalVerdictAnomaly(report)) {
            const headSha = await trustedHead(job);
            const checkpoint = (await inspectRecoveryCheckpoints(job)).find(point =>
              point.eligible && point.commitSha === headSha &&
              (point.semanticReview === "passed" || point.semanticReview === "not-required"));
            if (!checkpoint) return { status: "blocked" as const,
              reason: "Unsafe final-verdict evidence: no eligible verified/reviewed checkpoint." };
            return operationFailure(s, job, "completion-verification",
              "Authenticated final-verdict anomaly requires general recovery assessment.",
              { reference: "completion-report", resultStatus: report.generation.status,
                completion: { checkpoint: checkpoint.workItem,
                  reportStatus: report.generation.status,
                  scopeStatus: report.generation.scopeFulfillment,
                  planStatus: report.generation.planFulfillment.status } },
              "returned-failure");
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
            ...(s.request.fixture && !complete ? { nonsemanticStop: "fixture-verdict" as const } : {}),
            escalation,
            reason: complete ? null : [details || s.completedStages.at(-1)?.status ||
              "Scope remains unverified",
              ...(unfulfilledIdeas.length ? ["Binding deferred ideas unresolved: " + unfulfilledIdeas.join(", ")] : []),
              ...(budgeted.length ? ["Automated idea reassessment limit reached; author review required."] : []),
              ...(escalation ? [escalation.action] : [])].join("; "),
          };
        });
      } catch (error) {
        const stop = blocked(error);
        if (stop.status !== "blocked") return stop;
        return operationFailure(s, job, "completion-verification", error,
          { reference: "completion-report" });
      }
    }))
    .addEdge(START, "schedule")
    .addConditionalEdges("schedule", s => routeAfterOperationAssessment(s,
      s.status !== "running" ? END : "author_update_intake"), [END, "assess_recovery", "author_update_intake"])
    .addConditionalEdges("assess_recovery", s => s.status !== "running" ? END :
      s.recoveryLifecycle.assessorPending ? "assess_recovery" : "author_update_intake",
      [END, "assess_recovery", "author_update_intake"])
    .addConditionalEdges("author_update_intake", s => routeAfterOperationAssessment(s,
      s.status !== "running" ? END :
      s.ideaTask ? "idea_integration" :
      s.active && s.result && s.recoveryLifecycle.active?.origin.operation === "commit-verification" &&
        s.recoveryLifecycle.phase === "verifying" ? "verify_committed_work" :
      s.active && s.result ? "independent_assignment_review" :
      s.active ? "specialist_dispatch" : "completion_decision"), [END, "assess_recovery", "idea_integration", "independent_assignment_review", "verify_committed_work", "specialist_dispatch", "completion_decision"])
    .addConditionalEdges("idea_integration", s => routeAfterOperationAssessment(s,
      s.status !== "running" ? END : "verify_idea_integration"), [END, "assess_recovery", "verify_idea_integration"])
    .addConditionalEdges("verify_idea_integration", s => routeAfterOperationAssessment(s,
      s.status !== "running" ? END : "author_update_intake"), [END, "assess_recovery", "author_update_intake"])
    .addConditionalEdges("specialist_dispatch", s => routeAfterOperationAssessment(s,
      s.status !== "running" ? END :
      s.result?.status === "dependency-required" ? "dependency_amendment" :
      s.active ? "independent_assignment_review" : "author_update_intake"), [END, "assess_recovery", "dependency_amendment", "independent_assignment_review", "author_update_intake"])
    .addConditionalEdges("dependency_amendment", s => routeAfterOperationAssessment(s,
      s.status !== "running" ? END : "author_update_intake"), [END, "assess_recovery", "author_update_intake"])
    .addConditionalEdges("independent_assignment_review", s => routeAfterOperationAssessment(s,
      s.status !== "running" ? END :
      s.reviewSteeringHandoff ? "author_update_intake" :
      s.result ? "verify_committed_work" : "specialist_dispatch"), [END, "assess_recovery", "author_update_intake", "verify_committed_work", "specialist_dispatch"])
    .addConditionalEdges("verify_committed_work", s => routeAfterOperationAssessment(s,
      s.status !== "running" ? END : "author_update_intake"), [END, "assess_recovery", "author_update_intake"])
    .addConditionalEdges("completion_decision", s => routeAfterOperationAssessment(s, END),
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
      const persisted = saved.values as CoreState;
      const checkedModern = options.action === "start" ? null :
        await inspectModernGenerationRecovery(job, saver, config.configurable.thread_id);
      const untrustedModern = !!checkedModern &&
        !isDeepStrictEqual(checkedModern, persisted.recoveryLifecycle);
      const normalized = untrustedModern ? {
        recoveryLifecycle: checkedModern!, recoverySources: [],
      } : {
        recoveryLifecycle: persisted.recoveryLifecycle ?? emptyRecoveryLifecycle(),
        recoverySources: persisted.recoverySources ?? [],
      };
      let state: State = { ...persisted, ...normalized, ...projectRecovery(normalized) };
      if (options.action === "start") {
        if (state.request) throw new Error("Generation already exists; use resume or inspect, never overwrite its contract.");
        if (!options.task?.trim()) throw new Error("Generation start requires --task and --contract.");
        const request: GenerationRequest = { story: job.storyRoot, job: job.jobId, task: options.task,
          contract: parseGenerationContract(options.contract), fixture: options.fixture ?? false,
          skillsSource: options.skillsSource, validatorSource: options.validatorSource,
          provider: options.provider, model: options.model,
          orchestrationPolicy: options.fixture && !options.skillsSource ? "fixture-legacy" : "explicit" };
        state = { request, recoveryLifecycle: emptyRecoveryLifecycle(), recoverySources: [],
          recovery: null, unknownRecovery: null, operationRecovery: null, fixPickup: null,
          cursor: 0, completedStages: [], status: "running", reason: null,
          reviewSteeringHandoff: false, result: null, planVersion: null,
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
      let preflightStopped = untrustedModern;
      if (untrustedModern) {
        state = { ...state, status: "blocked", reason:
          "Saved modern recovery source/decision/attempt failed authenticated checkpoint inspection; " +
          "preserve original external receipts and do not resume the writer." };
      }
      if (options.action === "resume" && !cancelled && state.orchestratorSnapshotId) {
        // This check must precede graph.invoke, not merely decorate its final
        // report: a swapped but otherwise valid snapshot cannot dispatch a
        // writer while inspection subsequently reports the mismatch.
        try {
          const pinned = await loadSelectedStoryOrchestrator(job,
            config.configurable.thread_id, {
              task: state.request.task, kind: state.request.contract.scope.kind,
              turnPlanDigest: state.request.turnPlanDigest,
            });
          if (pinned.receipt.skillSnapshot.id !== state.orchestratorSnapshotId)
            throw Error("Pinned orchestrator snapshot changed since the generation checkpoint.");
        } catch (error) {
          state = { ...state, ...blocked(error) };
          preflightStopped = true;
        }
      }
      const selectedCloseout = state.recoveryLifecycle.active &&
        state.recoveryLifecycle.assessorPending &&
        state.recoveryLifecycle.decision?.action === "plan-amendment" &&
        state.recoveryLifecycle.decision.adapter === "cross-domain-closeout";
      if (options.action === "resume" && !cancelled && !preflightStopped && !selectedCloseout &&
          (state.operationRecovery?.phase !== "fenced" ||
           state.operationRecovery.operation === "specialist-dispatch")) {
        // The selected original closeout owns an unpublished Git successor
        // until its independent review is settled. Generic checkpoint
        // reconciliation must not inspect that pending commit as unrelated
        // work or dispatch another specialist before the original adapter.
        // Reconcile independently committed work items without ever replaying
        // their external Pi writer. An unsuccessful pre-graph reconciliation
        // must be checkpointed as an assessment before the graph can dispatch.
        try {
          await withStoryJobLock(job, "generation-checkpoint-reconciliation", () =>
            reconcileRecoveryCheckpoints(job));
        } catch (error) {
          const stop = blocked(error);
          if (stop.status !== "blocked") {
            state = { ...state, ...stop };
            preflightStopped = true;
          } else {
            // This failure happened BEFORE the next LangGraph task began;
            // there is no original failed-task anchor to authenticate.
            // Do not manufacture a C01 case or silently drop the legacy
            // operationFailure update when the new graph filters old fields.
            // Preserve the last persisted checkpoint, require operator
            // reconciliation of the exact original external effects.
            state = { ...state, status: "blocked",
              reason: "Pre-graph checkpoint reconciliation failed before a verifiable " +
                "LangGraph failed-check task began. Inspect original checkpoint effects: " +
                (error instanceof Error ? error.message : String(error)) };
            preflightStopped = true;
          }
        }
      }
      if (options.action !== "inspect") {
        // A terminal cancellation never re-enters a checkpointed dispatch:
        // an unfinished writer's original session and dirty worktree must
        // remain available for explicit, non-destructive reconciliation.
        if (cancelled) state = { ...state, ...cancellation };
        else if (!preflightStopped) {
          const outcome = await graph.invoke({ ...state, pauseAfter: options.pauseAfter ?? null }, config);
          state = { ...outcome, ...projectRecovery({
            recoveryLifecycle: outcome.recoveryLifecycle,
            recoverySources: outcome.recoverySources,
          }) };
        }
      }
      // A broken intake receipt can also make the composite job report fail.
      // Do not lose the already checkpointed recovery decision during inspect:
      // retain the typed failure and explicitly mark the report unavailable.
      const report = await inspectJobReport({ story: job.storyRoot, job: job.jobId })
        .catch(error => {
          if (state.recoveryLifecycle.inspectionFences.length ||
              state.operationRecovery?.phase === "fenced" ||
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
          untrustedModern ? { status: "blocked", reason: state.reason } :
          state.operationRecovery?.phase === "fenced" || state.operationRecovery?.phase === "assessment"
            ? { status: "blocked", reason: state.operationRecovery.reason + " " + state.operationRecovery.nextAction } :
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
      const recoveryInspection = visible.recoveryLifecycle &&
        (visible.recoveryLifecycle.active || visible.recoveryLifecycle.pending.length ||
          visible.recoveryLifecycle.inspectionFences.length)
        ? projectRecoveryInspection(visible.recoveryLifecycle)
        : null;
      return { schema: "noveltea-generation/v1", status: current.status ?? state.status,
        reason: current.reason ?? state.reason, checkpointStatus: state.status,
        jobId: job.jobId, threadId: config.configurable.thread_id, checkpointPath: path,
        nextStage: untrustedModern || visible.recoveryLifecycle.inspectionFences.length > 0 ||
          visible.operationRecovery?.phase === "fenced" ||
          visible.operationRecovery?.phase === "assessment" ||
          visible.causalAmendment && visible.planVersion === visible.causalAmendment.source.planVersion ? null :
          visible.ideaTask ? "idea-integration" : visible.active?.stage ??
          (visible.inventory ? nextExecutionItem(visible.inventory,
            visible.pendingOrder ?? visible.orchestratorOrder ?? undefined)?.stage : undefined) ?? null,
        recovery: visible.recovery ?? null, operationRecovery: visible.operationRecovery ?? null,
        unknownRecovery: await inspectUnknownRecoveryStatus(job, visible.unknownRecovery ?? null),
        recoveryInspection,
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
