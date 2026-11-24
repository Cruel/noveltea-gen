import { parseAuthorAnswer } from "./author-question.js";
import { answerSpecialistChoice } from "./specialist-choice.js";
import { createGenerationQuestionGraph, pendingGenerationQuestion, generationQuestionResume, pendingQuestionBudgetPause } from "./generation-author-question.js";
import { assertNativeVersion } from './native-cli-version.js';
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { subunitRoundProof, subunitWriterResult } from "./generation-writer-round.js";
import { createReviewRoundTransitions } from "./generation-review-round.js";
import { createAssignmentLifecycleGraph, logicalAssignmentKey, assignmentChildConfig, usesSharedAssignmentReview,
  type AssignmentIdentity, type AssignmentOutcome, type AssignmentPrerequisiteSuspension,
  type AssignmentSubmission, type AssignmentCorrection } from "./generation-assignment-lifecycle.js";
import type { ReviewDependencyRequest } from "./review-repair-amendment.js";
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
import { assessGenerationOperation, authenticateAssignmentFailure, isRepeatedUnchangedOperation, nodeFailureSource, operationChecks, type GenerationOperationRecovery,
  type Operation } from "./generation-operation-recovery.js";
import { inspectBlockedOriginalThreadCorrection } from "./original-thread-continuation.js";
import { projectRecoveryInspection, authenticateOriginalFailure,
  inspectModernGenerationRecovery } from "./generation-recovery-inspection.js";
import { selectOperationStrategy, executeOperationStrategy,
  authenticateSealedDiagnosticStop, diagnosticCaseForDecision,
  authenticateOperationDiagnosticProof, authorizeOperationDiagnosticStrategy, authenticateFoundationDiagnosticDecision, authenticateFoundationDiagnosticDischarge, foundationDiagnosticDecisionForLifecycle } from "./generation-operation-strategy.js";
import { inspectSettledAdaptiveReconciliation } from "./adaptive-reconciliation.js";
import { inspectDiagnosticAttempt } from "./unknown-recovery-diagnostic.js";
import { admitRecovery, decideRecovery, dischargePendingRecovery, emptyRecoveryLifecycle, inspectionFence,
  recordRecoveryOutcome, finishVerifiedRecovery, resumePausedRecovery, selectPendingRecovery } from "./generation-recovery-lifecycle.js";
import { inspectDeferredCorrection } from "./generation-recovery-resolution.js";
import { applyDomainRecovery, assertRecoverySources, decideExistingRecovery,
  extractDomainPatch, fixtureTurnIdentity, projectRecovery,
  type DomainRecoveryStatus, type RecoverySource, type RecoveryState } from "./generation-recovery-graph.js";
import type { RecoveryLifecycle, RecoveryOrigin, RecoveryEvidence } from "./generation-recovery-contract.js";
import type { RunnableConfig } from "@langchain/core/runnables";
import { captureVerificationFailure, verifyCorrectedOriginalResult, verifiableResultStatus } from "./commit-verification-continuation.js";
import { authorizedKnownFixDispatch, type KnownFixRequest } from "./known-verifier-fix.js";
import { ProtocolExhaustedError, ProtocolIntegrityBlockedError, ProtocolVerifierRecheckRejectedError } from "./response-contract-recovery.js";
import { originalGraphFailureAnchor } from "./generation-recovery-anchor.js";
import { Annotation, END, START, StateGraph, isGraphBubbleUp } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { z } from "zod";
import { parseContract, runArchitectureJob, verifyPlanHistory, type CompletionContract } from "./architecture.js";
import { runFoundationJob, inspectPendingFoundationInvocation, inspectFoundationFailure } from "./foundation.js";
import { AssignmentNonconvergenceError, AssignmentAuthorPauseError, type AssignmentRoundCommand, type AssignmentRoundResult, type AssignmentInvocationProof } from "./assignment-metadata-recovery.js";
import { reusableExistingFoundation } from "./foundation-readiness.js";
import { runCharacterWorldJob, inspectCharacterWorldFailure, inspectPendingCharacterWorldInvocation, inspectRecoverableCharacterWorldCommit } from "./character-world.js";
import { runEventWorkItem, inspectEventFailure, inspectPendingEventInvocation } from "./event-work.js";
import { routeEventPrerequisite } from "./event-prerequisite-routing.js";
import { inspectCausalAmendment } from "./causal-amendment-controller.js";
import type { CausalAmendment, CausalDiscovery } from "./causal-amendment.js";
import { runInteractiveWorkItem, inspectInteractiveUnit, inspectPendingInteractiveInvocation,
  inspectInteractiveFailure } from "./interactive-work.js";
import type { InteractiveDomain } from "./interactive-specialist.js";
import { readEventOnlyOmission, type EventOnlyRef } from "./interactive-event-only.js";
import { runCompositionWorkItem, inspectCompositionFailure, inspectPendingCompositionInvocation } from "./composition-work.js";
import { preflightCompositionBoundary } from "./cross-domain-prerequisite-controller.js";
import { runNarrativeReview } from "./narrative-review.js";
import { focusedChoiceWorkItem } from "./specialist-choice.js";
import { inspectFocusedPrerequisite, inspectPendingFocusedCommit, inspectPendingFocusedInvocation, inspectFocusedFailure, runFocusedWorkItem } from "./focused-work.js";
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
  provider?: string; model?: string; turnPlanDigest?: string; discoveryHandoffDigest?: string;
  /** Fixtures may omit the model planner, never the shared assignment lifecycle. */
  orchestrationPolicy?: "explicit" | "fixture-test";
}
export interface GenerationOptions {
  story: string; job: string; action: "start" | "resume" | "inspect";
  task?: string; contract?: unknown; fixture?: boolean; skillsSource?: string;
  validatorSource?: string; provider?: string; model?: string; pauseAfter?: Stage;
  answer?: { id: string; proposalSha256: string; answer: unknown };
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
    discoveryHandoffDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    orchestrationPolicy: z.enum(["explicit", "fixture-test"]).optional(),
  }),
  pauseAfter: z.enum(generationStages).nullable().optional(),
  fixPickup: z.object({ id: z.string(), check: z.string(), failedVersion: z.number().int(),
    signature: z.string() }).nullable().optional(),
});

type FocusedPrerequisitePin = {
  identity: AssignmentIdentity; suspension: AssignmentPrerequisiteSuspension;
  supportRef: string | null;
};
type ReviewPrerequisitePin = FocusedPrerequisitePin & {
  recoveryCaseId: string;
  submission: AssignmentSubmission;
};
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
  focusedPrerequisite: Annotation<FocusedPrerequisitePin | null>({ reducer: (_, next) => next, default: () => null }),
  reviewPrerequisite: Annotation<ReviewPrerequisitePin | null>({ reducer: (_, next) => next, default: () => null }),
  /** A sealed source-grounded causal replan request, never write authority. */
  causalAmendment: Annotation<CausalAmendment | null>(),
  /** A controller-admitted prerequisite, before the next dependent dispatch. */
  crossDomainCloseout: Annotation<{ milestoneId: string; planVersion: number;
    sourceSha: string; proposalDigest: string; repairId: string } | null>(),
});
export type GenerationGraphState = typeof Channels.State;
type CoreState = GenerationGraphState;
// Local node observations only; never LangGraph channels or resume authority.
type State = CoreState & DomainRecoveryStatus & { nonsemanticStop?: "author-boundary" | "fixture-verdict";
  reviewAssessmentRequested?: true;
  reviewDependencyRequest?: ReviewDependencyRequest;
  reviewPauseReason?: "author-pause" | "author-choice" | "protected-approval" | "budget" | "provider-unavailable" | "cancelled"; };
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
/** Execution admission, including direct checkpoint re-entry. Fixture identity is
 * isolated from live Pi authority; a missing live Turn is never a fallback. */
export async function requireGenerationTurn(job: JobStartResult, request: GenerationRequest,
  admitted = false) {
  const { readDiscoveryHandoff } = await import("./discovery-generation-handoff.js");
  const handoff = await readDiscoveryHandoff(job);
  if (handoff || request.discoveryHandoffDigest) {
    if (!handoff || request.discoveryHandoffDigest !== handoff.digest ||
        handoff.turnPlanDigest !== request.turnPlanDigest ||
        handoff.originalObjective !== request.task || handoff.model.provider !== request.provider ||
        handoff.model.id !== request.model || request.fixture)
      throw Error("Generation request differs from its authenticated Discovery handoff.");
  }
  if (request.orchestrationPolicy !== undefined && request.orchestrationPolicy !== "explicit" &&
      request.orchestrationPolicy !== "fixture-test")
    throw Error("Obsolete Generation execution format; inspect or start a current Turn.");
  if (request.orchestrationPolicy === "fixture-test" && !request.fixture)
    throw Error("Fixture-only orchestration cannot authorize production execution.");
  const digest = request.turnPlanDigest;
  if (request.fixture === true && digest === undefined) return null;
  if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))
    throw Error("Generation requires an authenticated current-format Turn plan digest.");
  const path = join(job.stateDir, "turn-plan.json");
  // An already admitted Turn can have a separately authenticated amended
  // Work-plan contract; its original immutable Turn remains the source pin.
  const contract = admitted && existsSync(join(job.stateDir, "architecture.json")) && existsSync(path)
    ? (JSON.parse(await readFile(path, "utf8")) as { contract: CompletionContract }).contract
    : request.contract;
  const turn = await readTurnEvidence(job, contract, request.task, digest);
  if (!turn) throw Error("Generation requires the original authenticated Turn receipt.");
  if (!request.fixture && !turn.objective)
    throw Error("Generation requires a current-format Turn objective; obsolete execution is refused.");
  return turn;
}
async function checkPlan(job: JobStartResult, request: GenerationRequest, version: number | null | undefined) {
  await requireGenerationTurn(job, request, true);
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
    // While an approved Architecture amendment is pending, keep historical
    // downstream evidence as candidates, not execution authority. The inventory
    // below exposes only Foundation and Architecture until the new plan commits.
    // Dropping these candidates here permanently loses signed carry-forward,
    // because hasPlanContinuity deliberately requires a committed plan.
    const version = e.planVersion ?? s.planVersion ?? 1;
    if (e.stage === "review") return receipt.phase === "committed" && version === plan.version && e.headSha === head;
    const stage = e.stage === "choice" || e.stage === "puzzle" ? "interactive" : e.stage;
    return receipt.phase !== "committed" ||
      hasPlanContinuity(job, receipt, e.milestone ? `${stage}:${e.milestone}` : stage, version);
  });
  // A commitless Event-only disposition must be reauthenticated at every
  // scheduler restart, including forks. Completed graph stage flags alone are
  // not authority to skip required Choice/Puzzle writers.
  for (const item of completedStages.filter(e => receipt?.phase === "committed" &&
      e.stage === "interactive" && e.milestone)) {
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

async function dispatch(s: Pick<State, "request" | "active"> & Partial<Pick<State, "inventory">>, unit?: InteractiveDomain | "world" | "character", round?: { assignmentKey: string; command: AssignmentRoundCommand }) {
  const foundationUnit = unit === "world" || unit === "character" ? unit : undefined;
  const interactiveUnit = unit === "choice" || unit === "puzzle" ? unit : undefined;
  const input = s.request;
  // Authenticated Turns load their saved amendment even on CLI recovery.
  // Isolated fixture transports have no live author steering authority.
  const turnDigest = input.turnPlanDigest;
  const steering = turnDigest
    ? await (async () => {
      const job = await openJob(s);
      await assertSteeringReceipts(job, turnDigest);
      // Foundation has its own pinned objective; no new steering authority
      // can be derived from its unfinished draft or a moving worktree.
      if (s.active?.stage === "foundation") return "";
      if (interactiveUnit && s.active?.milestone) {
        const pending = await inspectPendingInteractiveInvocation(job, s.active.milestone, interactiveUnit);
        if (pending) return steeringForAssignment(job, turnDigest, s.active.id, pending.unit.beforeHead!);
      }
      if (s.active?.stage === "focus" && s.active.milestone) {
        const pending = await inspectPendingFocusedCommit(job, s.active.milestone) ??
          await inspectPendingFocusedInvocation(job, s.active.milestone);
        if (pending) return steeringForAssignment(job, turnDigest, s.active.id, pending.expectedHead);
      }
      if (s.active?.milestone && ["event", "composition"].includes(s.active.stage)) {
        const pending = s.active.stage === "event"
          ? await inspectPendingEventInvocation(job, s.active.milestone)
          : await inspectPendingCompositionInvocation(job, s.active.milestone);
        if (pending) {
          const sourceHead = "expectedHead" in pending ? pending.expectedHead : pending.beforeHead!;
          return steeringForAssignment(job, turnDigest, s.active.id, sourceHead);
        }
      }
      const head = await trustedHead(job).catch(async error => {
        if (s.active?.stage !== "foundations" || !await inspectRecoverableCharacterWorldCommit(job)) throw error;
        return jobGit(job, "rev-parse", "HEAD^");
      });
      return steeringForAssignment(job, turnDigest, s.active!.id, head);
    })()
    : "";
  const guidedTask = adaptiveDispatchTask(steering ? input.task + "\n\nSAFE-BOUNDARY AUTHOR PLAN AMENDMENT:\n" + steering : input.task, s.active!);
  const milestone = s.active?.milestone!;
  switch (s.active?.stage) {
    case "foundation": throw Error("Foundation dispatch requires the checkpointed assignment child.");
    case "architecture": throw Error("Architecture requires its checkpointed assignment child.");
    case "foundations": return runCharacterWorldJob({ ...input, steering, action: "run", unit: foundationUnit, round });
    case "event": return runEventWorkItem({ ...input, task: guidedTask, milestone, action: "run", round });
    case "interactive": case "choice": case "puzzle": return runInteractiveWorkItem({ ...input,
      generationObjective: input.task, task: guidedTask, milestone, action: "run",
      unit: interactiveUnit ?? (s.active.stage === "interactive" ? undefined : s.active.stage),
      deferBoundary: s.active.stage === "interactive" && interactiveUnit === "choice",
      interactionInventory: s.inventory?.items, round });
    case "composition": return runCompositionWorkItem({ ...input, task: guidedTask, milestone, action: "run" });
    case "focus": return runFocusedWorkItem({ ...input, target: milestone, task: input.task, steering, round });
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
/**
 * R01 production slice: only the atomic Creative Direction/Foundation writer
 * enters the reusable checkpointed child. Composite work items retain their
 * existing independent per-subunit review boundaries until their own migration.
 * The parent still owns RecoveryLifecycle, plan reconciliation, inventory and
 * author-update intake. The original foundation.json, Git and review receipts
 * remain the only authorities for external effects.
 */
async function runFoundationAssignmentChild(
  s: State, config: RunnableConfig,
  reviewBoundary: (state: State, correctionSelected?: boolean) => Promise<Partial<State>>,
  correctionSelected = false,
  diagnostic?: NonNullable<Awaited<ReturnType<typeof authenticateFoundationDiagnosticDecision>>>,
): Promise<Partial<State>> {
  if (s.active?.stage !== "foundation" || !s.inventory)
    throw Error("R01 child requires the parent-admitted Foundation assignment.");
  const job = await openJob(s);
  const graphThreadId = config.configurable?.thread_id;
  if (typeof graphThreadId !== "string" || graphThreadId !== s.graphThreadId)
    throw Error("Foundation child lacks its exact authenticated parent graph Thread.");
  // Parent reconciliation can refresh inventory HEAD after an original Git
  // effect but before the original assignment is recorded complete. Recover
  // the immutable source from the eligible native receipt, not refreshed HEAD.
  const correction = correctionSelected ? s.recoveryLifecycle.active : null;
  const diagnosisCase = diagnostic ? s.recoveryLifecycle.active : null;
  const continuation = correction?.id ?? diagnosisCase?.id ?? null;
  const published = (await inspectRecoveryCheckpoints(job)).find(p =>
    p.eligible && p.workItem === "foundation" &&
    p.commitSha === (correction?.origin.sourceHeadSha ?? s.inventory!.headSha) &&
    p.planVersion === (s.planVersion ?? null) && p.validation.status === "passed" &&
    (s.request.fixture || p.assurance?.turnDigest === s.request.turnPlanDigest));
  const interruptedCommit = !published && s.active.verifiedSha === s.inventory.headSha &&
    jobGit(job, "rev-parse", "HEAD") === s.inventory.headSha &&
    await inspectOriginalSpecialistCommitForResume(s, job);
  const sourceHead = published?.parentSha ?? (interruptedCommit
    ? jobGit(job, "rev-parse", "HEAD^") : s.inventory.headSha);
  const { status: _status, verifiedSha: _verified, blockingReason: _blocked, ...assignmentScope } = s.active;
  const scopeDigest = createHash("sha256").update(JSON.stringify({
    task: s.request.task, contract: s.request.contract, active: assignmentScope,
    planVersion: s.planVersion, turnDigest: s.request.turnPlanDigest ?? null,
  })).digest("hex");
  const identity: AssignmentIdentity = {
    schema: "noveltea-assignment-identity/v1", jobId: job.jobId,
    jobThreadId: job.threadId, graphThreadId,
    turnDigest: s.request.turnPlanDigest ?? fixtureTurnIdentity({
      jobId: job.jobId, jobThreadId: job.threadId, graphThreadId,
      turnDigest: null, fixture: s.request.fixture, task: s.request.task, contract: s.request.contract,
    }),
    assignmentId: s.active.id, planVersion: s.planVersion,
    sourceHeadSha: sourceHead, scopeDigest,
  };
  const key = logicalAssignmentKey(identity);
  let reviewPatch: Partial<State> | null = null;
  const outcome = (status: AssignmentOutcome["status"], evidenceRef: string,
    extra: Record<string, string>): AssignmentOutcome =>
    ({ status, assignmentKey: key, evidenceRef, ...extra }) as AssignmentOutcome;
  const authenticateCorrection = async () => {
    if (!correction || !published || !s.result ||
        s.result.headSha !== published.commitSha || s.recoveryLifecycle.phase !== "correcting" ||
        s.recoveryLifecycle.assessorPending || correction.origin.assignmentId !== identity.assignmentId)
      return false;
    const { authenticateOperationReviewProof } = await import("./generation-operation-strategy.js");
    return !!s.recoveryLifecycle.decision &&
      await authenticateOperationReviewProof(job, s, correction, s.recoveryLifecycle.decision);
  };
  const authenticateDiagnosis = async () => {
    const source = diagnosisCase && s.recoverySources.find(x => x.caseId === diagnosisCase.id && x.channel === "operationRecovery");
    const decision = s.recoveryLifecycle.decision;
    if (!diagnosisCase || !source || !decision || !diagnostic ||
        s.recoveryLifecycle.phase !== "correcting" || diagnosisCase.origin.assignmentId !== identity.assignmentId)
      return false;
    const current = await authenticateFoundationDiagnosticDecision(job, diagnosisCase,
      source.input as unknown as GenerationOperationRecovery, decision, s.recoveryLifecycle.attempt);
    return !!current && current.terminal.assignmentKey === key &&
      isDeepStrictEqual(current.authorization, diagnostic.authorization);
  };
  const preflight = async () => {
    const control = await readJobControl(job);
    if (control === "cancelled") {
      if (correction) return outcome("unresolved", "job-control", { dispositionRef: "cancelled" });
      const error = Error("Original Turn was cancelled before Foundation dispatch.");
      error.name = "StoryCancelledError"; throw error;
    }
    if (control === "paused")
      return outcome("paused", "job-control", { controlRef: correction ? "author-pause:job-control" : "job-control" });
    // The original specialist owns dirty/authored-byte reconciliation. A
    // crash after model completion may leave its authenticated target dirty;
    // a blanket clean-worktree gate here would prevent safe verification.
    await checkPlan(job, s.request, s.planVersion);
    if (s.request.turnPlanDigest) await assertSteeringReceipts(job, s.request.turnPlanDigest);
    if (diagnostic) {
      if (!await authenticateDiagnosis()) throw Error("Foundation diagnostic correction lost its original assignment admission.");
      return null;
    }
    if (correctionSelected) {
      if (!await authenticateCorrection())
        throw Error("Foundation correction lacks its original admitted Review case.");
      return null;
    }
    const currentHead = jobGit(job, "rev-parse", "HEAD");
    if (currentHead !== sourceHead) {
      // Two distinct crash windows: committed Git before the Foundation
      // receipt was finalized (inspectOriginalSpecialistCommitForResume),
      // and finalized native receipt before the parent task was checkpointed
      // (the already-published recovery checkpoint). Both remain bound to
      // the original source parent and *same* work-item identity.
      const finalized = (await inspectRecoveryCheckpoints(job)).some(point =>
        point.eligible && point.workItem === "foundation" &&
        point.commitSha === currentHead && point.parentSha === sourceHead &&
        point.planVersion === (s.planVersion ?? null) &&
        point.validation.status === "passed");
      if (!finalized && !await inspectOriginalSpecialistCommitForResume(s, job))
        throw Error("Foundation source advanced without an authenticated original commit.");
    } else if (!existsSync(join(job.stateDir, "foundation.json"))) {
      if (await trustedHead(job) !== sourceHead)
        throw Error("Foundation source does not match the admitted parent HEAD.");
      clean(job);
    }
    return null;
  };
  const roundRef = (proof: AssignmentInvocationProof) =>
    [proof.sourceDigest, proof.ordinal, proof.settlementDigest].join(":");
  const roundProof = (submission: AssignmentSubmission): AssignmentInvocationProof => {
    const [sourceDigest, ordinal, settlementDigest, extra] = submission.receiptRef.split(":");
    if (submission.status !== "writer-round" || extra !== undefined ||
        !/^[a-f0-9]{64}$/.test(sourceDigest ?? "") || !/^(0|[1-9][0-9]*)$/.test(ordinal ?? "") ||
        !/^[a-f0-9]{64}$/.test(settlementDigest ?? "") || !Number.isSafeInteger(Number(ordinal)))
      throw new ProtocolIntegrityBlockedError("Invalid checkpointed Foundation writer round reference.");
    return { sourceDigest: sourceDigest!, ordinal: Number(ordinal), settlementDigest: settlementDigest! };
  };
  const runRound = async (command: AssignmentRoundCommand): Promise<AssignmentSubmission | AssignmentOutcome | AssignmentCorrection> => {
    // Foundation's own started/settled Pi and Git receipt reconciliation
    // prevents duplicate model turns, charges and commits after a crash.
    try {
      const stopped = await preflight();
      if (stopped) return stopped;
      const result = await runFoundationJob({ ...s.request, envelope: JSON.stringify(s.request.contract.envelope),
        round: { assignmentKey: key, command: diagnostic ? { ...command, diagnostic: diagnostic.authorization } : command } });
      if ("round" in result && result.round) {
        const ref = roundRef(result.round.proof);
        if (result.round.status === "correction")
          return { correctionRef: result.round.grantDigest, rejectedReceiptRef: ref };
        return { receiptRef: ref, status: "writer-round" };
      }
      if (!result.status)
        throw Error("Foundation returned no settled specialist status.");
      return { receiptRef: "foundation.json", status: result.status, headSha: result.headSha };
    } catch (error) {
      if (error instanceof AssignmentAuthorPauseError)
        return outcome("paused", "job-control", { controlRef: "job-control" });
      if (!(error instanceof ProtocolExhaustedError || error instanceof AssignmentNonconvergenceError))
        throw error;
      const terminal = await inspectFoundationFailure(job, sourceHead);
      const kind = error instanceof ProtocolExhaustedError ? "protocol-exhausted" : "nonconverging";
      if (!terminal || terminal.proof.kind !== kind)
        throw Error("Original assignment terminal receipt does not match its typed failure.");
      return outcome("unresolved", terminal.proof.receiptDigest, { dispositionRef: kind });
    }
  };
  const assertChildIdentity = (saved: AssignmentIdentity, continuationRef: string | null) => {
    if (logicalAssignmentKey(saved) !== key || continuationRef !== continuation)
      throw new ProtocolIntegrityBlockedError("Foundation checkpoint belongs to another admitted logical assignment.");
  };
  const invokeRound = async (command: AssignmentRoundCommand) => {
    const result = await runRound(command);
    if ("correctionRef" in result) throw Error("Foundation invocation cannot select its own correction.");
    return result;
  };
  const verifyCommitted = async (submission: AssignmentSubmission): Promise<AssignmentOutcome> => {
    const candidate: State = { ...s,
      result: { status: submission.status, headSha: submission.headSha } };
    if (!accepted.foundation.includes(submission.status))
      return outcome("unresolved", submission.receiptRef,
        { dispositionRef: "foundation.json" });
    try {
      reviewPatch = await reviewBoundary(candidate, false);
    } catch (error) {
      // Review runs within the shared child, but its original failed check
      // is STILL independent-review, never the adjacent specialist writer.
      // Admit it through the existing RecoveryLifecycle with its original
      // source and receipt, not a second child-local recovery case.
      reviewPatch = await operationFailure(candidate, job, "independent-review",
        error, { reference: "review-checkpoints", assignmentId: identity.assignmentId });
      return outcome("unresolved", "review-checkpoints",
        { dispositionRef: "review-checkpoints" });
    }
    if (reviewPatch.status === "paused")
      return outcome("paused", "review-checkpoints", { controlRef: "review-checkpoints" });
    if (reviewPatch.reviewAssessmentRequested)
      return outcome("unresolved", "review-checkpoints", { dispositionRef: "assess-review" });
    if (reviewPatch.status === "blocked" || reviewPatch.status === "cancelled" ||
        reviewPatch.escalation || reviewPatch.operationRecovery || reviewPatch.recovery ||
        reviewPatch.unknownRecovery)
      return outcome("unresolved", "review-checkpoints", { dispositionRef: "review-checkpoints" });
    if (reviewPatch.reviewSteeringHandoff)
      return outcome("paused", "author-updates", { controlRef: "author-updates" });
    const actual = reviewPatch.result === undefined ? candidate.result : reviewPatch.result;
    if (!actual || !accepted.foundation.includes(actual.status) || !actual.headSha)
      return outcome("unresolved", "review-checkpoints",
        { dispositionRef: "review-checkpoints" });
    try {
      const head = await trustedHead(job);
      if (actual.headSha !== head)
        throw Error("Original Foundation result differs from independently reviewed Git HEAD.");
      const points = (await inspectRecoveryCheckpoints(job)).filter(p => p.eligible);
      const reviews = await resolvedCheckpointReviews(job, points);
      const reviewed = points.find(p => p.workItem === "foundation" &&
        p.commitSha === head && p.parentSha === sourceHead &&
        (s.request.fixture
          ? p.validation.status === "passed"
          : p.assurance?.turnDigest === s.request.turnPlanDigest &&
            ["passed", "not-required"].includes(reviews.get(p.commitSha) ?? p.semanticReview)));
      if (!reviewed) {
        reviewPatch = await operationFailure(candidate, job, "independent-review",
          "Foundation has no authenticated passing independent Review.",
          { reference: "review-checkpoints", assignmentId: identity.assignmentId }, "returned-failure");
        return outcome("unresolved", "review-checkpoints",
          { dispositionRef: "review-checkpoints" });
      }
      return outcome("verified", "recovery-checkpoints:" + head,
        { headSha: head, reviewRef: "review-checkpoints:" + head });
    } catch (error) {
      // The child must not relabel source/commit verification failures as a
      // specialist-write error merely because verification is nested.
      reviewPatch = await operationFailure(candidate, job, "commit-verification",
        error, { reference: "generation-checkpoints", assignmentId: identity.assignmentId });
      return outcome("unresolved", "recovery-checkpoints",
        { dispositionRef: "generation-verification" });
    }
  };
  const runReviewRound = async (command: import("./rejected-review-repair.js").ReviewRoundCommand) => {
    if (!correction || !published)
      throw new ProtocolIntegrityBlockedError("Review round lacks the original admitted Case.");
    const stopped = await preflight();
    if (stopped) return stopped;
    const { executeReviewRound, ReviewDependencyRequiredError } = await import("./rejected-review-repair.js");
    try {
      return await executeReviewRound(job, {
        rootSha: correction.origin.sourceHeadSha, caseId: correction.id, assignmentKey: key, workItem: "foundation",
      }, command, { skillsSource: s.request.skillsSource, provider: s.request.provider,
        model: s.request.model, canYieldForSteering: async () =>
          !!s.request.turnPlanDigest && !!s.inventory?.items.some(item =>
            item.stage === "architecture" && item.status === "verified") &&
          (await checkPlan(job, s.request, s.planVersion))?.plan?.version === s.planVersion });
    } catch (error) {
      if (error instanceof ReviewDependencyRequiredError &&
          error.request.action === "author-approval-required")
        return outcome("paused", error.request.digest,
          { controlRef: "protected-approval:" + error.request.digest });
      const reason = error instanceof Error && (error.name === "PiBudgetPause" ? "budget" :
        error.name === "PiModelUnavailableError" ? "provider-unavailable" :
        error.name === "SpecialistChoiceRequiredError" ? "author-choice" :
        error.name === "AssignmentAuthorPauseError" ? "author-pause" :
        error.name === "StoryCancelledError" ? "cancelled" : null);
      if (reason) {
        return reason === "cancelled" ? outcome("unresolved", command.sourceSha, { dispositionRef: "cancelled" })
          : outcome("paused", command.sourceSha, { controlRef: reason + ":" + command.sourceSha });
      }
      throw error;
    }
  };
  const reviewRounds = createReviewRoundTransitions({
    originalHead: correction?.origin.sourceHeadSha ?? sourceHead,
    originalReceipt: "foundation.json",
    run: runReviewRound, outcome,
    verifySuccessor: async successor => {
      const head = await trustedHead(job);
      const { verifyReviewCycleSuccessor } = await import("./generation-recovery-resolution.js");
      return head === successor && await verifyReviewCycleSuccessor(job, correction!.origin.sourceHeadSha, head);
    },
  });
  const child = createAssignmentLifecycleGraph({
    authenticateContinuation: async state =>
      state.continuationRef === continuation &&
      (diagnostic ? await authenticateDiagnosis() : await authenticateCorrection()),
    preflight: async state => { assertChildIdentity(state.identity, state.continuationRef); return preflight(); },
    invoke: async state => { assertChildIdentity(state.identity, state.continuationRef); return invokeRound({ phase: "invoke" }); },
    correct: async state => {
      assertChildIdentity(state.identity, state.continuationRef);
      if (correction) return reviewRounds.correct(state.submission!, state.correction!);
      return invokeRound({ phase: "correct", proof: roundProof(state.submission!),
        grantDigest: state.correction!.correctionRef });
    },
    verify: async state => {
      assertChildIdentity(state.identity, state.continuationRef);
      let submission = state.submission!;
      if (correction) return reviewRounds.verify(submission);
      const stopped = await preflight();
      if (stopped) return stopped;
      if (submission.status === "writer-round") {
        const verified = await runRound({ phase: "verify", proof: roundProof(submission) });
        if ("assignmentKey" in verified || "correctionRef" in verified) return verified;
        if (verified.status === "writer-round") throw Error("Foundation verification did not settle the round.");
        submission = verified;
      }
      return { outcome: await verifyCommitted(submission), submission };
    },
  });
  // LangGraph passes the parent's persistent SQLite checkpointer to the
  // nested graph. No standalone child scheduler, database, or recovery ledger.
  const finished = await child.invoke({
    identity, submission: diagnostic ? {
      receiptRef: roundRef(diagnostic.terminal.invocationProof ?? diagnostic.terminal.successorProof ?? {
        sourceDigest: diagnostic.terminal.proof.sourceDigest, ordinal: diagnostic.terminal.proof.ordinal,
        settlementDigest: diagnostic.terminal.settlementDigest!,
      }), status: "writer-round",
    } : correction && s.result
      ? { receiptRef: "foundation.json", status: s.result.status, headSha: s.result.headSha } : null,
    submissionKey: correction || diagnostic ? key : null,
    outcome: null, continuationRef: continuation,
  }, { ...assignmentChildConfig(config, identity, correction || diagnostic ? "correction" : "original"), durability: "sync" });
  if (!finished.outcome)
    throw Error("Foundation child has a genuine pending author interrupt; return to parent control.");
  if (finished.outcome.assignmentKey !== key)
    throw new ProtocolIntegrityBlockedError("Foundation child returned a foreign assignment.");
  // A completed child does not self-authorize a parent Work-plan change.
  // The existing independent-assignment and commit-verification parent nodes
  // will independently reauthenticate the review, Git and plan before advancing.
  const reviewedState = reviewPatch as Partial<State> | null;
  if (correction && finished.outcome.status === "unresolved" &&
      finished.outcome.dispositionRef === "assess-review") {
    // The callback projection is not persisted. Rebuild a returned child
    // handoff after a crash from its actual original Repair/Review receipts.
    const assessment = await (await import("./rejected-review-repair.js")).inspectFoundationReviewBoundary(job,
        correction.origin.sourceHeadSha);
    if (!assessment || assessment.digest !== finished.outcome.evidenceRef)
      throw new ProtocolIntegrityBlockedError("Returned Foundation assessment lost its exact original boundary.");
    return { reviewAssessmentRequested: true, reason: "Assessing the sealed Foundation Review boundary.",
      result: s.result };
  }
  if (correction && finished.outcome.status === "unresolved" &&
      finished.outcome.dispositionRef.startsWith("repair-native:")) {
    const terminal = await (await import("./rejected-review-repair.js")).inspectNativeReviewFailure(job,
      correction.origin.sourceHeadSha, correction.id);
    if (!terminal || terminal.proof.receiptDigest !== finished.outcome.evidenceRef ||
        finished.outcome.dispositionRef !== "repair-native:" + terminal.proof.kind)
      throw new ProtocolIntegrityBlockedError("Returned Review native terminal lost its original evidence.");
    return { reviewAssessmentRequested: true, reason: "Assessing the sealed Review native correction terminal.",
      result: s.result };
  }
  if (finished.outcome.status === "verified")
    return { ...reviewedState,
      result: { status: correction ? s.result!.status : finished.submission!.status, headSha: finished.outcome.headSha } };
  if (diagnostic) {
    if (finished.outcome.status === "paused")
      return { status: "paused", reason: "Original diagnostic successor is suspended at its writer or Review boundary." };
    throw new ProtocolIntegrityBlockedError("Diagnostic successor remains unresolved; inspect original native and independent Review receipts.");
  }
  if (correction) {
    if (finished.outcome.status === "paused") {
      if (finished.outcome.controlRef === "author-updates")
        return { reviewSteeringHandoff: true, reason: REPAIR_STEERING_BOUNDARY, result: s.result };
      const reason = finished.outcome.controlRef.split(":")[0];
      if (reason === "protected-approval") {
        const digest = finished.outcome.controlRef.split(":")[1];
        const request = (await inspectDependencyPlan(job))?.reviewRequests?.find(r =>
          r.digest === digest && r.turnDigest === identity.turnDigest &&
          r.originalAssignmentId === identity.assignmentId && r.action === "author-approval-required");
        if (!request || request.originalWorkItem !== "foundation")
          throw new ProtocolIntegrityBlockedError("Protected Foundation Review request lost its original source.");
        return { status: "blocked", reviewPauseReason: "protected-approval",
          reason: "Foundation Review requires explicit author approval of a separately authorized scope.",
          result: s.result };
      }
      if (reason === "author-choice" || reason === "author-pause" || reason === "budget" || reason === "provider-unavailable")
        return { status: "paused", reviewPauseReason: reason, reason: "Original Foundation Review correction paused.", result: s.result };
    }
    if (finished.outcome.status === "unresolved" && finished.outcome.dispositionRef === "cancelled")
      return { status: "cancelled", reviewPauseReason: "cancelled", reason: "Original Foundation Review was cancelled.", result: s.result };
    throw new ProtocolIntegrityBlockedError("Original Foundation Review correction is unresolved; inspect the sealed original Case and repair receipts.");
  }
  // The negative verdict can survive the physical child while its local
  // projection does not. Reconstruct the same failure from the original
  // independent checkpoint, never misclassify it as a new writer failure.
  if (!reviewedState && finished.outcome.status === "unresolved" &&
      finished.outcome.dispositionRef === "review-checkpoints" && finished.submission?.headSha) {
    const head = finished.submission.headSha;
    const failed = (await inspectRecoveryCheckpoints(job)).find(p =>
      p.eligible && p.workItem === "foundation" && p.commitSha === head && p.semanticReview === "failed");
    if (failed) {
      const candidate = { ...s, result: { status: finished.submission.status, headSha: head } };
      return { ...await operationFailure(candidate, job, "independent-review",
        "Original independently reviewed assignment has source-linked negative findings.",
        { reference: "review-checkpoints", assignmentId: identity.assignmentId }, "returned-failure"),
        result: candidate.result };
    }
  }
  // Preserve an actual existing Review/RecoveryLifecycle disposition. An
  // empty reviewer patch is NOT proof of completion: it must not return {}
  // to the parent and cause the same Foundation writer to be selected again.
  if (reviewedState && (reviewedState.status || reviewedState.operationRecovery ||
      reviewedState.recovery || reviewedState.unknownRecovery ||
      reviewedState.escalation || reviewedState.reviewSteeringHandoff || reviewedState.reviewAssessmentRequested))
    return { ...reviewedState, result: finished.submission
      ? { status: finished.submission.status, headSha: finished.submission.headSha }
      : reviewedState.result };
  if (finished.outcome.status === "paused")
    return { status: "paused", reason: "Original Foundation child is suspended; inspect controller-owned control and review receipts." };
  if (finished.outcome.status === "unresolved" &&
      ["protocol-exhausted", "nonconverging"].includes(finished.outcome.dispositionRef)) {
    const terminal = await inspectFoundationFailure(job, sourceHead);
    if (!terminal || terminal.proof.kind !== finished.outcome.dispositionRef ||
        terminal.proof.receiptDigest !== finished.outcome.evidenceRef)
      throw Error("Original child terminal failure no longer matches its independently verified source.");
    return operationFailure(s, job, "specialist-result",
      terminal.proof.kind === "protocol-exhausted" ? "Original specialist report protocol exhausted." :
        "Original scoped Story metadata/provenance corrections did not converge; independent diagnosis required.",
      { reference: "specialist-receipt", assignmentId: identity.assignmentId,
        resultStatus: terminal.proof.kind, assignmentFailure: { sourceHeadSha: sourceHead, proof: terminal.proof } },
      "returned-failure");
  }
  return operationFailure(s, job, "specialist-result",
    "Original Foundation child returned a nonverified result; inspect the exact native/review receipt.",
    { reference: "specialist-receipt", assignmentId: s.active.id,
      resultStatus: finished.submission?.status ?? finished.outcome.status }, "returned-failure");
}

/** The selected diagnostic continuation uses the original Foundation child,
 * not generic specialist dispatch. Its verified native/Git/Review result is
 * the only discharge authority. */
async function runFoundationDiagnosticRecovery(s: State, config: RunnableConfig,
  reviewBoundary: (state: State, correctionSelected?: boolean) => Promise<Partial<State>>): Promise<Partial<State>> {
  const lifecycle = s.recoveryLifecycle;
  const c = lifecycle.active;
  const d = lifecycle.decision;
  const source = c && s.recoverySources.find(x => x.caseId === c.id && x.channel === "operationRecovery");
  const fence = (reason: string): Partial<State> => ({
    status: "blocked", reason, recoveryLifecycle: { ...admitRecovery(lifecycle, { outcome: "fenced",
      fence: inspectionFence("untrusted-receipt", c?.origin ?? {}, c?.evidence ?? [],
        c?.evidence[0] ?? null, reason) }), assessorPending: false },
  });
  const pause = (reason: "cancelled" | "author-pause" | "budget" | "provider-unavailable", message: string): Partial<State> => {
    if (d?.action !== "known-correction") return fence("Diagnostic control lacks its selected decision.");
    return { status: reason === "cancelled" ? "cancelled" : "paused", reason: message,
      recoveryLifecycle: { ...decideRecovery(lifecycle, {
        schema: d.schema, caseId: d.caseId, checkedSourceHeadSha: d.checkedSourceHeadSha,
        evidence: d.evidence, action: "pause", reason, resumeRef: d.receipt,
      }), assessorPending: false } };
  };
  try {
    if (!c || !d || d.action !== "known-correction" || d.adapter !== "assignment-diagnostic" ||
        !lifecycle.assessorPending || lifecycle.phase !== "correcting" || !source ||
        s.active?.id !== "foundation" || s.result || !s.inventory ||
        s.inventory.headSha !== c.origin.sourceHeadSha || s.planVersion !== c.origin.planVersion ||
        config.configurable?.thread_id !== c.origin.graphThreadId)
      return fence("Diagnostic successor has no exact original parent admission.");
    const job = await openJob(s);
    const operation = source.input as unknown as GenerationOperationRecovery;
    const original = await authenticateFoundationDiagnosticDecision(job, c, operation, d, lifecycle.attempt);
    if (!original || !await authenticateOriginalFailure(job, s.request, c.origin.graphThreadId, c.origin, c.evidence, true))
      return fence("Diagnostic successor lost its original failure, scope or Pi evidence.");
    const control = await readJobControl(job);
    if (control !== "running")
      return pause(control === "cancelled" ? "cancelled" : "author-pause", "Author control precedes diagnostic correction.");
    const updated = await runFoundationAssignmentChild(s, config, reviewBoundary, false, original);
    if (updated.status === "paused" || updated.status === "cancelled")
      return pause(updated.status === "cancelled" ? "cancelled" : "author-pause",
        updated.reason ?? "Original diagnostic correction is suspended.");
    const head = await trustedHead(job);
    const receipt: RecoveryEvidence = { store: "specialist-receipt", ref: original.terminal.ref,
      digest: original.authorization.decisionDigest };
    if (updated.result?.headSha !== head ||
        !await authenticateFoundationDiagnosticDischarge(job, c, operation, receipt, head))
      return fence("Diagnostic successor lacks passing native Git and independent Review evidence.");
    return { ...updated, operationRecovery: null, status: "running", reason: null,
      recoveryLifecycle: finishVerifiedRecovery(lifecycle, { status: "verified", caseId: c.id,
        sourceHeadSha: head, assurance: receipt }, true) };
  } catch (error) {
    if ((error != null && isGraphBubbleUp(error)) || config.signal?.aborted) throw error;
    if (error instanceof Error && ["PiBudgetPause", "PiModelUnavailableError", "AssignmentAuthorPauseError"].includes(error.name))
      return pause(error.name === "PiBudgetPause" ? "budget" :
        error.name === "PiModelUnavailableError" ? "provider-unavailable" : "author-pause", error.message);
    if (error instanceof Error && error.name === "StoryCancelledError")
      return pause("cancelled", error.message);
    return fence("Diagnostic successor is unresolved: " + (error instanceof Error ? error.message : String(error)));
  }
}

/** Canonical Architecture enters the shared assignment lifecycle; the private
 * Story Blueprint remains an independently reviewed input, never a Git effect. */
async function runArchitectureAssignmentChild(
  s: State, config: RunnableConfig,
  reviewBoundary: (state: State, correctionSelected?: boolean) => Promise<Partial<State>>,
  correctionSelected = false,
): Promise<Partial<State>> {
  if (s.active?.stage !== "architecture" || !s.inventory ||
      config.configurable?.thread_id !== s.graphThreadId || !s.graphThreadId)
    throw Error("Architecture child requires its original parent assignment and Thread.");
  const job = await openJob(s);
  const saved = await checkPlan(job, s.request, s.planVersion);
  const version = s.planVersion ?? 1;
  const correction = correctionSelected ? s.recoveryLifecycle.active : null;
  const points = (await inspectRecoveryCheckpoints(job)).filter(p => p.eligible);
  const original = points.find(p => p.workItem === "global-architecture" &&
    p.planVersion === version && p.validation.status === "passed" &&
    p.commitSha === (correction?.origin.sourceHeadSha ?? saved?.expectedHead) &&
    (s.request.fixture || p.assurance?.turnDigest === s.request.turnPlanDigest));
  const sourceHead = original?.parentSha ?? saved?.executionHead ??
    (saved?.phase !== "committed" ? saved?.expectedHead : undefined) ?? s.inventory.headSha;
  if (!correction && sourceHead !== s.inventory.headSha &&
      original?.commitSha !== s.inventory.headSha)
    throw Error("Architecture receipt source differs from its parent inventory.");
  const identity: AssignmentIdentity = {
    schema: "noveltea-assignment-identity/v1", jobId: job.jobId,
    jobThreadId: job.threadId, graphThreadId: s.graphThreadId,
    turnDigest: s.request.turnPlanDigest ?? fixtureTurnIdentity({
      jobId: job.jobId, jobThreadId: job.threadId, graphThreadId: s.graphThreadId,
      turnDigest: null, fixture: s.request.fixture, task: s.request.task, contract: s.request.contract,
    }),
    assignmentId: s.active.id, planVersion: version, sourceHeadSha: sourceHead,
    scopeDigest: createHash("sha256").update(JSON.stringify({
      task: s.request.task, contract: s.request.contract, version,
    })).digest("hex"),
  };
  const key = logicalAssignmentKey(identity);
  const receiptRef = "architecture.json";
  const outcome = (status: AssignmentOutcome["status"], evidenceRef: string,
    extra: Record<string, string>): AssignmentOutcome =>
    ({ status, assignmentKey: key, evidenceRef, ...extra }) as AssignmentOutcome;
  const authenticateCorrection = async () => {
    if (!correction || !original || s.result?.headSha !== original.commitSha ||
        correction.origin.assignmentId !== identity.assignmentId ||
        s.recoveryLifecycle.phase !== "correcting" || s.recoveryLifecycle.assessorPending ||
        !s.recoveryLifecycle.decision) return false;
    return (await import("./generation-operation-strategy.js")).authenticateOperationReviewProof(
      job, s, correction, s.recoveryLifecycle.decision);
  };
  let reviewPatch: Partial<State> | undefined;
  const preflight = async () => {
      const control = await readJobControl(job);
      if (control === "cancelled") {
        const error = Error("Original Turn was cancelled before Architecture dispatch.");
        error.name = "StoryCancelledError"; throw error;
      }
      if (control === "paused")
        return outcome("paused", "job-control", { controlRef: "job-control" });
      const current = await checkPlan(job, s.request, s.planVersion);
      if (current?.plan && current.plan.version !== version)
        throw Error("Architecture assignment cannot execute under a superseded plan version.");
      if (s.request.turnPlanDigest) await assertSteeringReceipts(job, s.request.turnPlanDigest);
      if (correctionSelected && !await authenticateCorrection())
        throw Error("Architecture correction lacks the original independent Review proof.");
      if (!correctionSelected && !saved && await trustedHead(job) !== sourceHead)
        throw Error("Architecture source differs from its parent assignment.");
      return null;
  };
  const runRound = async (command: AssignmentRoundCommand): Promise<AssignmentSubmission | AssignmentOutcome | AssignmentCorrection> => {
    // Architecture's own started/settled Pi and Git receipt reconciliation
    // prevents duplicate model turns, charges and commits after a crash.
    try {
      const stopped = await preflight();
      if (stopped) return stopped;
      const result = await runArchitectureJob({ ...s.request, action: "run",
        round: { assignmentKey: key, command } });
      if (!result.status && !("round" in result && result.round))
        throw Error("Architecture returned no settled specialist status.");
      return subunitWriterResult(result as { status: string; headSha?: string; round?: AssignmentRoundResult }, receiptRef);
    } catch (error) {
      if (error instanceof AssignmentAuthorPauseError)
        return outcome("paused", "job-control", { controlRef: "job-control" });
      if (!(error instanceof ProtocolExhaustedError || error instanceof AssignmentNonconvergenceError))
        throw error;
      const terminal = await (await import("./architecture.js")).inspectArchitectureFailure(job, sourceHead);
      const kind = error instanceof ProtocolExhaustedError ? "protocol-exhausted" : "nonconverging";
      if (!terminal || terminal.proof.kind !== kind)
        throw Error("Original assignment terminal receipt does not match its typed failure.");
      return outcome("unresolved", terminal.proof.receiptDigest, { dispositionRef: kind });
    }
  };
  const assertChildIdentity = (saved: AssignmentIdentity, continuationRef: string | null) => {
    if (logicalAssignmentKey(saved) !== key || continuationRef !== (correction?.id ?? null))
      throw new ProtocolIntegrityBlockedError("Architecture checkpoint belongs to another admitted logical assignment.");
  };
  const invokeRound = async (command: AssignmentRoundCommand) => {
    const result = await runRound(command);
    if ("correctionRef" in result) throw Error("Architecture invocation cannot select its own correction.");
    return result;
  };
  const verifyCommitted = async (submission: AssignmentSubmission): Promise<AssignmentOutcome> => {
      if (submission.receiptRef !== receiptRef || !submission.headSha ||
          !accepted.architecture.includes(submission.status))
        return outcome("unresolved", receiptRef, { dispositionRef: receiptRef });
      const candidate = { ...s, result: { status: submission.status, headSha: submission.headSha } };
      let disposition: "commit" | "adopted" = "commit";
      try {
        if (!correction) disposition = await (await import("./architecture.js")).verifyArchitectureAssignmentResult(
          job, s.request, version, sourceHead, submission.headSha);
        if (disposition === "commit" && !correction &&
            !(await inspectRecoveryCheckpoints(job)).some(p => p.eligible &&
              p.workItem === "global-architecture" && p.planVersion === version &&
              p.commitSha === submission.headSha && p.parentSha === sourceHead &&
              p.validation.status === "passed" &&
              (s.request.fixture || p.assurance?.turnDigest === s.request.turnPlanDigest)))
          throw Error("Architecture commit lacks its original native checkpoint.");
      } catch (error) {
        reviewPatch = await operationFailure(candidate, job, "commit-verification", error,
          { reference: "generation-checkpoints", assignmentId: identity.assignmentId });
        return outcome("unresolved", receiptRef, { dispositionRef: "generation-verification" });
      }
      try {
        reviewPatch = await reviewBoundary(candidate, correctionSelected);
      } catch (error) {
        reviewPatch = await operationFailure(candidate, job, "independent-review", error,
          { reference: "review-checkpoints", assignmentId: identity.assignmentId });
        return outcome("unresolved", receiptRef, { dispositionRef: "review-checkpoints" });
      }
      if (reviewPatch.status === "paused" || reviewPatch.reviewSteeringHandoff)
        return outcome("paused", receiptRef, { controlRef: "review-checkpoints" });
      if (reviewPatch.reviewAssessmentRequested || reviewPatch.reviewDependencyRequest ||
          reviewPatch.status || reviewPatch.operationRecovery || reviewPatch.recovery ||
          reviewPatch.unknownRecovery || reviewPatch.escalation)
        return outcome("unresolved", receiptRef, { dispositionRef: "review-checkpoints" });
      const head = await trustedHead(job);
      if (correction) {
        if (!await (await import("./generation-recovery-resolution.js"))
          .verifyReviewCycleSuccessor(job, correction.origin.sourceHeadSha, head))
          throw Error("Architecture correction lacks its independently passing successor.");
      } else if (disposition === "commit" && !s.request.fixture) {
        const current = (await inspectRecoveryCheckpoints(job)).filter(p => p.eligible);
        const reviews = await resolvedCheckpointReviews(job, current);
        const point = current.find(p => p.commitSha === submission.headSha);
        if (!point || !["passed", "not-required"].includes(reviews.get(point.commitSha) ?? point.semanticReview))
          throw Error("Architecture commit lacks independently passing Review.");
      }
      return outcome("verified", receiptRef, { headSha: head,
        reviewRef: disposition === "adopted" ? receiptRef : "review-checkpoints:" + head });
  };
  const child = createAssignmentLifecycleGraph({
    authenticateContinuation: async state => state.continuationRef === correction?.id && await authenticateCorrection(),
    preflight: async state => { assertChildIdentity(state.identity, state.continuationRef); return preflight(); },
    invoke: async state => { assertChildIdentity(state.identity, state.continuationRef); return invokeRound({ phase: "invoke" }); },
    correct: async state => {
      assertChildIdentity(state.identity, state.continuationRef);
      if (correction) throw Error("Postcommit Review cannot authorize a precommit writer.");
      return invokeRound({ phase: "correct", proof: subunitRoundProof(state.submission!), grantDigest: state.correction!.correctionRef });
    },
    verify: async state => {
      assertChildIdentity(state.identity, state.continuationRef);
      let submission = state.submission!;
      if (submission.status === "writer-round") {
        const verified = await runRound({ phase: "verify", proof: subunitRoundProof(submission) });
        if ("assignmentKey" in verified || "correctionRef" in verified) return verified;
        if (verified.status === "writer-round") throw Error("Architecture verification did not settle the round.");
        submission = verified;
      }
      return { outcome: await verifyCommitted(submission), submission };
    },
  });
  const finished = await child.invoke({
    identity, submission: correction && s.result
      ? { receiptRef, status: s.result.status, headSha: s.result.headSha } : null,
    submissionKey: correction ? key : null, outcome: null, continuationRef: correction?.id ?? null,
  }, { ...assignmentChildConfig(config, identity, correction ? "correction" : "original"), durability: "sync" });
  if (!finished.outcome || finished.outcome.assignmentKey !== key)
    throw Error("Architecture child returned no authenticated outcome.");
  if (finished.outcome.status === "verified")
    return { ...reviewPatch, result: { status: finished.submission!.status,
      headSha: s.request.fixture ? finished.submission!.headSha : finished.outcome.headSha } };
  if (finished.submission && reviewPatch)
    return { ...reviewPatch, result: { status: finished.submission.status,
      headSha: finished.submission.headSha } };
  if (finished.submission && (finished.outcome.status === "paused" ||
      finished.outcome.status === "unresolved" && finished.outcome.dispositionRef === "review-checkpoints")) {
    const candidate = { ...s, result: { status: finished.submission.status, headSha: finished.submission.headSha } };
    // A crash after the child END loses the in-memory patch, not the sealed
    // verdict. Reconcile the original Review rather than invoking the writer.
    if (!reviewPatch && !correctionSelected) reviewPatch = await reviewBoundary(candidate);
    if (!reviewPatch && correctionSelected) {
      if (await (await import("./rejected-review-repair.js")).inspectFoundationReviewBoundary(job,
        correction!.origin.sourceHeadSha))
        reviewPatch = { reviewAssessmentRequested: true, reason: "Assessing the sealed Architecture Review boundary." };
      else throw Error("Architecture correction handoff requires reconciliation of its original Review.");
    }
    if (reviewPatch) return { ...reviewPatch, result: candidate.result };
  }
  if (finished.outcome.status === "paused")
    return { status: "paused", reason: "Original Architecture assignment is suspended." };
  if (finished.outcome.status === "unresolved" &&
      ["protocol-exhausted", "nonconverging"].includes(finished.outcome.dispositionRef)) {
    const terminal = await (await import("./architecture.js")).inspectArchitectureFailure(job, sourceHead);
    if (!terminal || terminal.proof.receiptDigest !== finished.outcome.evidenceRef)
      throw Error("Original Architecture terminal proof changed.");
    return operationFailure(s, job, "specialist-result", "Original Architecture assignment exhausted its bounded correction.",
      { reference: "specialist-receipt", assignmentId: identity.assignmentId, resultStatus: terminal.proof.kind,
        assignmentFailure: { sourceHeadSha: sourceHead, proof: terminal.proof } }, "returned-failure");
  }
  return operationFailure(s, job, "specialist-result", "Architecture returned an unverified result.",
    { reference: "specialist-receipt", assignmentId: identity.assignmentId,
      resultStatus: finished.submission?.status ?? finished.outcome.status }, "returned-failure");
}

function subunitReviewTransitions(s: State, job: JobStartResult, identity: AssignmentIdentity,
  ref: string, correction: State["recoveryLifecycle"]["active"],
  preflight: () => Promise<AssignmentOutcome | null>,
  outcome: (status: AssignmentOutcome["status"], evidenceRef: string, extra: Record<string, string>) => AssignmentOutcome) {
  return createReviewRoundTransitions({
    originalHead: correction?.origin.sourceHeadSha ?? identity.sourceHeadSha, originalReceipt: ref,
    outcome,
    run: async command => {
      if (!correction) throw new ProtocolIntegrityBlockedError("Subunit Review lacks its original admitted Case.");
      const stopped = await preflight();
      if (stopped) return stopped;
      const { executeReviewRound, ReviewDependencyRequiredError } = await import("./rejected-review-repair.js");
      try {
        return await executeReviewRound(job, {
          rootSha: correction.origin.sourceHeadSha, caseId: correction.id,
          assignmentKey: logicalAssignmentKey(identity), workItem: identity.assignmentId,
        }, command, { skillsSource: s.request.skillsSource, provider: s.request.provider,
          model: s.request.model, canYieldForSteering: async () =>
            !!s.request.turnPlanDigest && (await checkPlan(job, s.request, s.planVersion))?.plan?.version === s.planVersion });
      } catch (error) {
        if (error instanceof ReviewDependencyRequiredError) {
          return error.request.action === "author-approval-required"
            ? outcome("paused", error.request.digest, { controlRef: "protected-approval:" + error.request.digest })
            : outcome("unresolved", error.request.digest, { dispositionRef: "review-prerequisite" });
        }
        const reason = error instanceof Error && (error.name === "PiBudgetPause" ? "budget" :
          error.name === "PiModelUnavailableError" ? "provider-unavailable" :
          error.name === "SpecialistChoiceRequiredError" ? "author-choice" :
          error.name === "AssignmentAuthorPauseError" ? "author-pause" :
          error.name === "StoryCancelledError" ? "cancelled" : null);
        if (reason) return reason === "cancelled"
          ? outcome("unresolved", command.sourceSha, { dispositionRef: "cancelled" })
          : outcome("paused", command.sourceSha, { controlRef: reason + ":" + command.sourceSha });
        throw error;
      }
    },
    verifySuccessor: async successor => {
      const { verifyReviewCycleSuccessor } = await import("./generation-recovery-resolution.js");
      return await trustedHead(job) === successor &&
        await verifyReviewCycleSuccessor(job, correction!.origin.sourceHeadSha, successor);
    },
  });
}

/** Reconstruct parent projections from sealed Review boundaries, including
 * after a physical child checkpoint was restored without its local callbacks. */
async function subunitReviewStop(s: State, job: JobStartResult, identity: AssignmentIdentity,
  correction: NonNullable<State["recoveryLifecycle"]["active"]>, outcome: AssignmentOutcome): Promise<Partial<State>> {
  const originalReview = (await inspectRecoveryCheckpoints(job)).find(p =>
    p.eligible && p.commitSha === correction.origin.sourceHeadSha && p.workItem === identity.assignmentId);
  if (!originalReview?.assurance || originalReview.assurance.turnDigest !== identity.turnDigest)
    throw new ProtocolIntegrityBlockedError("Subunit Review stop lacks its original sealed assignment.");
  const originalAssignmentId = originalReview.assurance.assignmentId;
  if (outcome.status === "unresolved") {
    if (outcome.dispositionRef === "assess-review") {
      const boundary = await (await import("./rejected-review-repair.js")).inspectFoundationReviewBoundary(job, correction.origin.sourceHeadSha);
      if (!boundary || boundary.digest !== outcome.evidenceRef)
        throw new ProtocolIntegrityBlockedError("Subunit Review assessment lost its original boundary.");
      return { reviewAssessmentRequested: true, result: s.result, reason: "Assessing the sealed subunit Review boundary." };
    }
    if (outcome.dispositionRef.startsWith("repair-native:")) {
      const terminal = await (await import("./rejected-review-repair.js")).inspectNativeReviewFailure(job, correction.origin.sourceHeadSha, correction.id);
      if (!terminal || terminal.proof.receiptDigest !== outcome.evidenceRef ||
          outcome.dispositionRef !== "repair-native:" + terminal.proof.kind)
        throw new ProtocolIntegrityBlockedError("Subunit Review native terminal lost its original evidence.");
      return { reviewAssessmentRequested: true, result: s.result, reason: "Assessing the sealed subunit native terminal." };
    }
    if (outcome.dispositionRef === "cancelled")
      return { status: "cancelled", reviewPauseReason: "cancelled", result: s.result };
    if (outcome.dispositionRef === "review-prerequisite") {
      const request = (await inspectDependencyPlan(job))?.reviewRequests?.find(r =>
        r.digest === outcome.evidenceRef && r.turnDigest === identity.turnDigest &&
        r.originalAssignmentId === originalAssignmentId && r.originalWorkItem === identity.assignmentId &&
        r.action === "controller-amendment-required");
      if (!request) throw new ProtocolIntegrityBlockedError("Subunit Review prerequisite lost its original authority.");
      return { reviewDependencyRequest: request, result: s.result };
    }
  }
  if (outcome.status === "paused") {
    if (outcome.controlRef === "author-updates")
      return { reviewSteeringHandoff: true, reason: REPAIR_STEERING_BOUNDARY, result: s.result };
    const reason = outcome.controlRef.split(":")[0];
    if (reason === "protected-approval") {
      const request = (await inspectDependencyPlan(job))?.reviewRequests?.find(r =>
        r.digest === outcome.evidenceRef && r.turnDigest === identity.turnDigest &&
        r.originalAssignmentId === originalAssignmentId && r.originalWorkItem === identity.assignmentId &&
        r.action === "author-approval-required");
      if (!request) throw new ProtocolIntegrityBlockedError("Subunit protected approval lost its original source.");
      return { status: "blocked", reviewPauseReason: "protected-approval", result: s.result,
        reason: "Subunit Review requires explicit author approval of a separately authorized scope." };
    }
    if (reason === "author-choice" || reason === "author-pause" || reason === "budget" || reason === "provider-unavailable")
      return { status: "paused", reviewPauseReason: reason, result: s.result };
  }
  throw new ProtocolIntegrityBlockedError("Original subunit Review did not produce independently verified coverage.");
}

/** World and Character each enter the shared lifecycle with their own original
 * source and independently receipted writer. The parent composite assignment
 * remains incomplete at the World Review boundary. */
async function runCharacterWorldAssignmentChild(
  s: State, config: RunnableConfig,
  reviewBoundary: (state: State, correctionSelected?: boolean) => Promise<Partial<State>>,
  correctionSelected = false,
): Promise<Partial<State>> {
  if (s.active?.stage !== "foundations" || !s.inventory)
    throw Error("World/Character child requires the admitted composite assignment.");
  const job = await openJob(s);
  const graphThreadId = config.configurable?.thread_id;
  if (typeof graphThreadId !== "string" || graphThreadId !== s.graphThreadId)
    throw Error("World/Character child lacks its authenticated parent Thread.");
  const correction = correctionSelected ? s.recoveryLifecycle.active : null;
  const receiptPath = join(job.stateDir, "character-world.json");
  const saved = existsSync(receiptPath) ? JSON.parse(await readFile(receiptPath, "utf8")) as {
    jobId: string; planVersion: number; startHead?: string; architectureHead: string;
    units: { id: string; domain: "world" | "character"; phase: string; beforeHead?: string; commitSha?: string; assignmentKey?: string }[];
  } : null;
  if (saved && (saved.jobId !== job.jobId || saved.planVersion !== s.planVersion ||
      saved.units?.length !== 2 || saved.units[0]?.id !== "world-foundations" ||
      saved.units[1]?.id !== "character-foundations"))
    throw Error("World/Character receipt differs from its original assignment.");
  const points = (await inspectRecoveryCheckpoints(job)).filter(p => p.eligible);
  const original = correction ? points.find(p => p.commitSha === correction.origin.sourceHeadSha &&
    ["world-foundations", "character-foundations"].includes(p.workItem)) : undefined;
  if (correction && !original) throw Error("Correction lacks its original World/Character source.");
  let domain: "world" | "character" = "world";
  if (original) domain = original.workItem === "world-foundations" ? "world" : "character";
  else if (saved?.units[0]?.phase === "committed") {
    // An unreviewed World commit is still the original child, never a grant
    // for Character. A started Character must retain its exact prior source.
    try {
      const world = saved.units[0];
      const published = points.some(point => point.workItem === world.id && point.commitSha === world.commitSha);
      const fork = readRecoveryFork(job);
      // The immutable fork bundle also carries native-verified fixture commits
      // which have no semantic Review entry. Production dependencies still
      // pass the independent Review gate below before Character can start.
      const inherited = fork?.checkpoint.completedWorkItems.includes(world.id) &&
        fork.commits[world.id]?.sha === world.commitSha &&
        (s.request.fixture || fork.reviewCoverage?.some(point =>
          point.workItem === world.id && point.commitSha === world.commitSha));
      if (!published && !inherited)
        throw new IndependentReviewGateError("World checkpoint must be finalized before Character dispatch.");
      await assertNativeReviewDependencies(job, "character-foundations");
      domain = "character";
    } catch (error) {
      if (!(error instanceof IndependentReviewGateError)) throw error;
      if (saved.units[1]?.phase !== "pending")
        throw Error("Character started without a verified World Review.");
    }
  }
  const workItem = domain + "-foundations";
  const unit = saved?.units[domain === "world" ? 0 : 1];
  const sourceHead = original?.parentSha ?? unit?.beforeHead ??
    (domain === "world" ? saved?.startHead ?? saved?.architectureHead : undefined) ??
    await trustedHead(job);
  const { status: _status, verifiedSha: _verified, blockingReason: _blocked, ...assignmentScope } = s.active;
  const identity: AssignmentIdentity = {
    schema: "noveltea-assignment-identity/v1", jobId: job.jobId,
    jobThreadId: job.threadId, graphThreadId,
    turnDigest: s.request.turnPlanDigest ?? fixtureTurnIdentity({
      jobId: job.jobId, jobThreadId: job.threadId, graphThreadId,
      turnDigest: null, fixture: s.request.fixture, task: s.request.task, contract: s.request.contract,
    }),
    assignmentId: workItem, planVersion: s.planVersion, sourceHeadSha: sourceHead,
    scopeDigest: createHash("sha256").update(JSON.stringify({
      task: s.request.task, contract: s.request.contract, assignmentScope, workItem,
    })).digest("hex"),
  };
  const key = logicalAssignmentKey(identity);
  const ref = "character-world.json#" + workItem;
  const resultStatus = domain === "world" ? "review-handoff" : "foundations-committed";
  const outcome = (status: AssignmentOutcome["status"], evidenceRef: string,
    extra: Record<string, string>): AssignmentOutcome =>
    ({ status, assignmentKey: key, evidenceRef, ...extra }) as AssignmentOutcome;
  let reviewPatch: Partial<State> | null = null;
  const authenticateCorrection = async () => {
    if (!correction || !original || !s.result ||
        s.result.headSha !== original.commitSha || s.recoveryLifecycle.phase !== "correcting" ||
        s.recoveryLifecycle.assessorPending || correction.origin.assignmentId !== s.active!.id ||
        !s.recoveryLifecycle.decision) return false;
    return (await import("./generation-operation-strategy.js")).authenticateOperationReviewProof(
      job, s, correction, s.recoveryLifecycle.decision);
  };
  const preflight = async (): Promise<AssignmentOutcome | null> => {
      const currentPlan = await checkPlan(job, s.request, s.planVersion);
      if (currentPlan?.plan?.version !== s.planVersion)
        throw new ProtocolIntegrityBlockedError("Subunit round cannot use a stale plan; reconcile at parent intake.");
      if (s.request.turnPlanDigest) await assertSteeringReceipts(job, s.request.turnPlanDigest);
      const control = await readJobControl(job);
      if (control === "cancelled") {
        const error = Error("Original Turn was cancelled before World/Character dispatch.");
        error.name = "StoryCancelledError"; throw error;
      }
      if (control === "paused") return outcome("paused", "job-control", { controlRef: correction ? "author-pause:job-control" : "job-control" });
      if (correction) {
        if (unit?.assignmentKey !== key || !await authenticateCorrection())
          throw new ProtocolIntegrityBlockedError("Original World/Character correction lacks its original assignment key or sealed Review.");
      } else {
        if (domain === "character") await assertNativeReviewDependencies(job, workItem);
        const current = existsSync(receiptPath) ? JSON.parse(await readFile(receiptPath, "utf8")) as typeof saved : null;
        const originalUnit = current?.units[domain === "world" ? 0 : 1];
        if (originalUnit?.beforeHead ? originalUnit.beforeHead !== sourceHead : await trustedHead(job) !== sourceHead)
          throw new ProtocolIntegrityBlockedError("World/Character source advanced before the original invocation.");
      }
      return null;
  };
  const runRound = async (command: AssignmentRoundCommand) => {
      try {
        const stopped = await preflight();
        if (stopped) return stopped;
        return subunitWriterResult(await dispatch(s, domain, { assignmentKey: key, command }), ref);
      } catch (error) {
        if (error instanceof AssignmentAuthorPauseError)
          return outcome("paused", "job-control", { controlRef: "job-control" });
        if (!(error instanceof ProtocolExhaustedError || error instanceof AssignmentNonconvergenceError))
          throw error;
        const terminal = await inspectCharacterWorldFailure(job, sourceHead);
        const kind = error instanceof ProtocolExhaustedError ? "protocol-exhausted" : "nonconverging";
        if (!terminal || terminal.proof.kind !== kind)
          throw Error("World/Character terminal receipt differs from the original failed invocation.");
        return outcome("unresolved", terminal.proof.receiptDigest, { dispositionRef: kind });
      }
  };
  const invokeRound = async (command: AssignmentRoundCommand) => {
    const result = await runRound(command);
    if ("correctionRef" in result) throw new ProtocolIntegrityBlockedError("Writer cannot admit its own correction.");
    return result;
  };
  const reviewRounds = subunitReviewTransitions(s, job, identity, ref, correction, preflight, outcome);
  const assertIdentity = (state: { identity: AssignmentIdentity; continuationRef: string | null }) => {
    if (logicalAssignmentKey(state.identity) !== key || state.continuationRef !== (correction?.id ?? null))
      throw new ProtocolIntegrityBlockedError("World/Character checkpoint belongs to another assignment.");
  };
  const verifyCommitted = async (submission: AssignmentSubmission): Promise<AssignmentOutcome> => {
      if (submission.status !== resultStatus || !submission.headSha)
        return outcome("unresolved", ref, { dispositionRef: submission.status });
      const native = (await inspectRecoveryCheckpoints(job)).find(p => p.eligible &&
        p.commitSha === submission.headSha && p.workItem === workItem && p.parentSha === sourceHead &&
        p.planVersion === s.planVersion && p.validation.status === "passed");
      if (!native || !s.request.fixture && native.assurance?.turnDigest !== s.request.turnPlanDigest)
        throw Error("World/Character submission lost its original native/source checkpoint.");
      const candidate: State = { ...s, result: { status: submission.status, headSha: submission.headSha } };
      try {
        reviewPatch = await reviewBoundary(candidate, false);
      } catch (error) {
        reviewPatch = await operationFailure(candidate, job, "independent-review", error,
          { reference: "review-checkpoints", assignmentId: s.active!.id });
      }
      if (reviewPatch.status === "paused" || reviewPatch.reviewSteeringHandoff)
        return outcome("paused", "review-checkpoints", { controlRef: "review-checkpoints" });
      if (reviewPatch.reviewAssessmentRequested)
        return outcome("unresolved", "review-checkpoints", { dispositionRef: "assess-review" });
      if (reviewPatch.reviewDependencyRequest)
        return outcome("unresolved", reviewPatch.reviewDependencyRequest.digest,
          { dispositionRef: "review-prerequisite" });
      if (reviewPatch.status === "blocked" || reviewPatch.status === "cancelled" ||
          reviewPatch.escalation || reviewPatch.operationRecovery || reviewPatch.recovery ||
          reviewPatch.unknownRecovery)
        return outcome("unresolved", "review-checkpoints", { dispositionRef: "review-checkpoints" });
      const head = await trustedHead(job);
      const eligible = (await inspectRecoveryCheckpoints(job)).filter(p => p.eligible);
      const point = eligible.find(p => p.commitSha === submission.headSha)!;
      const resolved = await resolvedCheckpointReviews(job, eligible);
      if (!s.request.fixture && !["passed", "not-required"].includes(resolved.get(point.commitSha) ?? point.semanticReview))
        throw Error("World/Character submission lacks its independently passing Review.");
      if (head !== point.commitSha) throw Error("World/Character submission differs from verified HEAD.");
      if (domain === "world") {
        try { await assertNativeReviewDependencies(job, "character-foundations"); }
        catch (error) {
          if (!s.request.fixture || !(error instanceof IndependentReviewGateError)) throw error;
          return outcome("unresolved", ref, { dispositionRef: "fixture-verdict" });
        }
      }
      return outcome("verified", "recovery-checkpoints:" + head,
        { headSha: head, reviewRef: "review-checkpoints:" + head });
  };
  const child = (correction ? createAssignmentLifecycleGraph :
    createGenerationQuestionGraph.bind(null, job, identity, workItem))({
    authenticateContinuation: async state => state.continuationRef === correction?.id && await authenticateCorrection(),
    preflight: async state => { assertIdentity(state); return preflight(); },
    invoke: async state => { assertIdentity(state); return invokeRound({ phase: "invoke" }); },
    correct: async state => {
      assertIdentity(state);
      return correction ? reviewRounds.correct(state.submission!, state.correction!) : invokeRound({ phase: "correct", proof: subunitRoundProof(state.submission!), grantDigest: state.correction!.correctionRef });
    },
    verify: async state => {
      assertIdentity(state);
      let submission = state.submission!;
      if (correction) return reviewRounds.verify(submission);
      const stopped = await preflight();
      if (stopped) return stopped;
      if (submission.status === "writer-round") {
        const verified = await runRound({ phase: "verify", proof: subunitRoundProof(submission) });
        if ("assignmentKey" in verified || "correctionRef" in verified) return verified;
        if (verified.status === "writer-round") throw Error("World/Character verification did not settle the round.");
        submission = verified;
        if (submission.status === resultStatus && submission.headSha)
          return { submission, reviewPending: true as const };
      }
      return { submission, outcome: await verifyCommitted(submission) };
    },
  });
  const finished = await child.invoke({
    identity, submission: correction && s.result
      ? { receiptRef: ref, status: s.result.status, headSha: s.result.headSha } : null,
    submissionKey: correction ? key : null, outcome: null, continuationRef: correction?.id ?? null,
  }, { ...assignmentChildConfig(config, identity, correction ? "correction" : "original"), durability: "sync" });
  if (!finished.outcome || finished.outcome.assignmentKey !== key)
    throw Error("World/Character child did not settle its original assignment.");
  const patch = reviewPatch as Partial<State> | null;
  const result = finished.submission
    ? { status: finished.submission.status, headSha: finished.submission.headSha } : null;
  if (finished.outcome.status === "verified")
    return { ...patch, result: domain === "world" ? null :
      { status: resultStatus, headSha: finished.outcome.headSha } };
  if (correction) return subunitReviewStop(s, job, identity, correction, finished.outcome);
  if (patch && (patch.status || patch.operationRecovery || patch.recovery || patch.unknownRecovery ||
      patch.escalation || patch.reviewSteeringHandoff || patch.reviewDependencyRequest))
    return { ...patch, result };
  if (finished.outcome.status === "paused")
    return { status: "paused", result, reason: "Original World/Character child is suspended." };
  if (finished.outcome.status === "unresolved" &&
      ["protocol-exhausted", "nonconverging"].includes(finished.outcome.dispositionRef)) {
    const terminal = await inspectCharacterWorldFailure(job, sourceHead);
    if (!terminal || terminal.proof.kind !== finished.outcome.dispositionRef ||
        terminal.proof.receiptDigest !== finished.outcome.evidenceRef)
      throw Error("World/Character terminal failure lost its original invocation proof.");
    return operationFailure(s, job, "specialist-result",
      terminal.proof.kind === "protocol-exhausted" ? "Original specialist report protocol exhausted." :
        "Original scoped Story metadata corrections did not converge; independent diagnosis required.",
      { reference: "specialist-receipt", assignmentId: s.active.id, resultStatus: terminal.proof.kind,
        assignmentFailure: { sourceHeadSha: sourceHead, proof: terminal.proof } }, "returned-failure");
  }
  // These are settled source-linked handoffs, not writer failures.
  if (finished.outcome.status === "unresolved" && finished.outcome.dispositionRef === "fixture-verdict")
    return { result };
  if (result?.status === "foundations-conflict-reported") {
    const report = await (await import("./character-world.js")).inspectFoundationConflict(job, domain);
    if (report.expectedHead !== sourceHead || report.planVersion !== s.planVersion ||
        report.worker !== (s.request.fixture ? "fixture" : "pi"))
      throw Error("Original World/Character no-write report differs from its admitted source.");
    const failure = "Original " + report.domain + " Foundation returned a settled, clean architectural contradiction: " +
      report.conflicts.join("; ") + ". Controller/Architecture owns prerequisite rescoping.";
    const assessed = await operationFailure(s, job, "specialist-result", failure,
      { reference: "specialist-receipt", assignmentId: s.active.id,
        resultStatus: result.status, foundationsNoWrite: { domain: report.domain,
          expectedHead: report.expectedHead, reportDigest: report.reportDigest } }, "returned-failure");
    return { ...assessed, failures: { ...s.failures, [s.active.id]: failure },
      inventory: blockedAssignmentInventory(s, failure), active: null, result: null,
      escalation: { kind: "dependency-replan", requiresTrustedApproval: false,
        sources: report.conflicts.map(message => ({ source: workItem + "@" + sourceHead,
          message, repair: "controller-plan-review" })),
        action: "Review the original Architecture and settled World/Character report before authorizing an amendment." } };
  }
  // Re-attest a returned Review handoff from the durable source on replay,
  // rather than reclassifying a previously committed writer as an error.
  if (result?.status === resultStatus) {
    if (finished.outcome.status === "unresolved" && finished.outcome.dispositionRef === "review-checkpoints")
      return { ...await reviewBoundary({ ...s, result }, false), result };
    return { result };
  }
  throw Error("World/Character child returned an unsupported disposition.");
}

/** Event and Composition use the existing native work-item receipts as their
 * effect authorities. The child is entered before dispatch; it never grants
 * a new owner or substitutes a successful checkpoint for independent Review. */
async function runNarrativeAssignmentChild(s: State, config: RunnableConfig,
  reviewBoundary: (state: State, correctionSelected?: boolean) => Promise<Partial<State>>,
  correctionSelected = false,
  reroute?: { reportDigest: string; sourceSha: string; task: string }): Promise<Partial<State>> {
  const job = await openJob(s);
  const active = s.active;
  const graphThreadId = config.configurable?.thread_id;
  if (!active?.milestone || !s.inventory ||
      !["event", "composition", "focus"].includes(active.stage) ||
      reroute && (active.stage !== "event" || reroute.sourceSha !== s.inventory.headSha || correctionSelected) ||
      typeof graphThreadId !== "string" || graphThreadId !== s.graphThreadId ||
      s.planVersion === null || !s.request.turnPlanDigest && !s.request.fixture)
    throw Error("Narrative child lacks its admitted Turn, assignment and plan.");
  const turnDigest = s.request.turnPlanDigest ?? fixtureTurnIdentity({
    jobId: job.jobId, jobThreadId: job.threadId, graphThreadId, turnDigest: null,
    fixture: s.request.fixture, task: s.request.task, contract: s.request.contract,
  });
  const correction = correctionSelected ? s.recoveryLifecycle.active : null;
  const points = await inspectRecoveryCheckpoints(job);
  const root = correction && points.find(p => p.eligible &&
    p.commitSha === correction.origin.sourceHeadSha && executionId(p.workItem) === active.id);
  if (correctionSelected && (!correction || !root || !s.result ||
      correction.origin.assignmentId !== active.id))
    throw Error("Narrative correction lacks its original native and Review receipts.");
  const focusSource = active.stage === "focus" && s.request.turnPlanDigest
    ? await inspectFocusedPrerequisite(job, active.milestone, s.request.turnPlanDigest, s.request.fixture, s.planVersion) : null;
  const pendingEvent = active.stage === "event" && !reroute && !correction
    ? await inspectPendingEventInvocation(job, active.milestone) : null;
  const sourceHead = focusSource?.report.sourceSha ?? (root ? root.parentSha : pendingEvent?.expectedHead ?? s.inventory.headSha);
  const workItem = active.stage === "focus" ? active.id : active.stage + "-" + active.milestone.slice(10);
  const { status: _status, verifiedSha: _verified, blockingReason: _blocked, ...scope } = active;
  const identity: AssignmentIdentity = {
    schema: "noveltea-assignment-identity/v1", jobId: job.jobId, jobThreadId: job.threadId,
    graphThreadId, turnDigest, assignmentId: workItem, planVersion: s.planVersion,
    sourceHeadSha: sourceHead, scopeDigest: dependencyDigest({ scope, task: s.request.task, contract: s.request.contract,
      ...(reroute ? { reroute } : {}) }),
  };
  const key = logicalAssignmentKey(identity);
  const ref = active.stage === "focus" ? "focused-items/" + active.milestone + ".json" :
    active.stage + "-items/" + active.milestone.slice(10) + ".json";
  const milestone = active.milestone;
  const inspect = async () => active.stage === "event"
    ? runEventWorkItem({ ...s.request, milestone, action: "inspect" })
    : active.stage === "composition"
      ? runCompositionWorkItem({ ...s.request, milestone, action: "inspect" }) : null;
  const inspectTerminal = () => active.stage === "event" ? inspectEventFailure(job, milestone, sourceHead)
    : active.stage === "composition" ? inspectCompositionFailure(job, milestone, sourceHead) : null;
  const authenticateCorrection = async () => !!correction && !!s.recoveryLifecycle.decision &&
    await (await import("./generation-operation-strategy.js")).authenticateOperationReviewProof(
      job, s, correction, s.recoveryLifecycle.decision);
  let result: Awaited<ReturnType<typeof dispatch>> | undefined;
  let patch: Partial<State> | undefined;
  const disposition = (status: "unresolved" | "paused", evidence: string): AssignmentOutcome =>
    status === "unresolved" ? { status, assignmentKey: key, evidenceRef: ref, dispositionRef: evidence } :
      { status, assignmentKey: key, evidenceRef: ref, controlRef: evidence };
  const preflight = async () => {
    await checkPlan(job, s.request, s.planVersion);
    const control = await readJobControl(job);
    if (control === "cancelled") {
      const error = Error("Original narrative assignment cancelled");
      error.name = "StoryCancelledError"; throw error;
    }
    if (control !== "running") return disposition("paused", correction ? "author-pause:job-control" : "job-control");
    if (correction && !await authenticateCorrection())
      throw Error("Narrative correction lost its authenticated original Review case.");
    if (s.request.turnPlanDigest) await assertSteeringReceipts(job, s.request.turnPlanDigest);
    return null;
  };
  const assertIdentity = (saved: AssignmentIdentity, continuationRef: string | null) => {
    if (logicalAssignmentKey(saved) !== key || continuationRef !== (correction?.id ?? null))
      throw new ProtocolIntegrityBlockedError("Narrative checkpoint belongs to another admitted logical assignment.");
  };
  const runRound = async (command: AssignmentRoundCommand): Promise<AssignmentSubmission | AssignmentOutcome | AssignmentCorrection> => {
    const stopped = await preflight();
    if (stopped) return stopped;
    try {
      const round = active.stage === "event" ? { assignmentKey: key, command } : undefined;
      result = reroute ? await runEventWorkItem({ ...s.request, action: "run", milestone,
        task: reroute.task, reroute, round }) : await dispatch(s, undefined, round);
      return subunitWriterResult(result as { status: string; headSha?: string; round?: AssignmentRoundResult }, ref);
    } catch (error) {
      if (error instanceof AssignmentAuthorPauseError) return disposition("paused", "job-control");
      if (!(error instanceof ProtocolExhaustedError || error instanceof AssignmentNonconvergenceError)) throw error;
      const terminal = await inspectTerminal();
      if (!terminal) throw error;
      patch = await operationFailure(s, job, "specialist-result", error,
        { reference: "specialist-receipt", assignmentId: active.id, resultStatus: terminal.proof.kind,
          assignmentFailure: { sourceHeadSha: sourceHead, proof: terminal.proof } }, "returned-failure");
      return disposition("unresolved", terminal.proof.receiptDigest);
    }
  };
  const invokeRound = async (command: AssignmentRoundCommand) => {
    const invoked = await runRound(command);
    if ("correctionRef" in invoked) throw new ProtocolIntegrityBlockedError("Event invocation cannot admit its own correction.");
    return invoked;
  };
  const checkpointedReview = !!correction && active.stage !== "composition";
  const reviewRounds = subunitReviewTransitions(s, job, identity, ref, correction, preflight,
    (status, evidenceRef, extra) => ({ status, assignmentKey: key, evidenceRef, ...extra }) as AssignmentOutcome);
  const child = (correction ? createAssignmentLifecycleGraph :
    createGenerationQuestionGraph.bind(null, job, identity, workItem))({
    authenticateContinuation: async state => state.continuationRef === correction?.id && await authenticateCorrection(),
    preflight: async state => {
      assertIdentity(state.identity, state.continuationRef);
      return preflight();
    },
    invoke: async state => {
      assertIdentity(state.identity, state.continuationRef);
      return invokeRound({ phase: "invoke" });
    },
    correct: async state => {
      assertIdentity(state.identity, state.continuationRef);
      if (checkpointedReview) return reviewRounds.correct(state.submission!, state.correction!);
      if (active.stage !== "event" || correction)
        throw new ProtocolIntegrityBlockedError("Writer correction has no original Event assignment.");
      return invokeRound({ phase: "correct", proof: subunitRoundProof(state.submission!),
        grantDigest: state.correction!.correctionRef });
    },
    verify: async state => {
      assertIdentity(state.identity, state.continuationRef);
      const stopped = await preflight();
      if (stopped) return stopped;
      let submission = state.submission!;
      if (checkpointedReview) return reviewRounds.verify(submission);
      if (submission.status === "writer-round") {
        if (active.stage !== "event" || correction)
          throw new ProtocolIntegrityBlockedError("Foreign Event round submission.");
        const verified = await runRound({ phase: "verify", proof: subunitRoundProof(submission) });
        if ("assignmentKey" in verified || "correctionRef" in verified) return verified;
        if (verified.status === "writer-round")
          throw new ProtocolIntegrityBlockedError("Event verification did not settle the original round.");
        submission = verified;
        if (accepted[active.stage].includes(submission.status) && submission.headSha)
          return { submission, reviewPending: true as const };
      }
      return { submission, outcome: await verifyCommitted(submission) };
    },
  });
  const verifyCommitted = async (submission: AssignmentSubmission): Promise<AssignmentOutcome> => {
      if (submission.receiptRef !== ref) throw Error("Narrative submission belongs to another work item.");
      if (!correction && !accepted[active.stage].includes(submission.status)) {
        // Preserve the full original negative report for the existing parent
        // prerequisite/assessment boundary, without certifying it as success.
        return disposition("unresolved", submission.status);
      }
      const native = (await inspectRecoveryCheckpoints(job)).find(p => p.eligible &&
        p.workItem === workItem && p.commitSha === (root ? root.commitSha : submission.headSha) &&
        p.parentSha === (root ? root.parentSha : sourceHead) && p.validation.status === "passed" &&
        p.planVersion === s.planVersion &&
        (s.request.fixture || p.assurance?.turnDigest === s.request.turnPlanDigest));
      if (!native) throw Error("Narrative child lacks its original native-validated checkpoint.");
      const candidate = correction ? s.result! : { status: submission.status, headSha: submission.headSha };
      patch = await reviewBoundary({ ...s, result: candidate }, correctionSelected);
      if (patch.status === "paused") return disposition("paused", "review-checkpoints");
      if (patch.status || patch.operationRecovery || patch.reviewAssessmentRequested ||
          patch.reviewSteeringHandoff || patch.escalation || patch.reviewDependencyRequest)
        return disposition("unresolved", "review-checkpoints:" + native.commitSha);
      const head = await trustedHead(job);
      const refreshed = (await inspectRecoveryCheckpoints(job)).filter(p => p.eligible);
      const reviews = await resolvedCheckpointReviews(job, refreshed);
      const current = refreshed.find(p => p.commitSha === native.commitSha);
      if (current && s.request.fixture && current.assurance &&
          !["passed", "not-required"].includes(reviews.get(current.commitSha) ?? current.semanticReview))
        return disposition("unresolved", "review-checkpoints:" + current.commitSha);
      if (!current || !(s.request.fixture && !current.assurance) &&
          !["passed", "not-required"].includes(reviews.get(current.commitSha) ?? current.semanticReview))
        throw Error("Narrative child did not settle its mandatory independent Review.");
      return { status: "verified", assignmentKey: key, evidenceRef: ref,
        reviewRef: "review-checkpoints:" + native.commitSha, headSha: head };
  };
  const finished = await child.invoke({ identity,
    submission: correction && s.result ? { receiptRef: ref, status: s.result.status, headSha: s.result.headSha } : null,
    submissionKey: correction ? key : null, outcome: null, continuationRef: correction?.id ?? null },
    { ...assignmentChildConfig(config, identity, correction ? "correction" : "original"), durability: "sync" });
  if (!finished.outcome || finished.outcome.assignmentKey !== key)
    throw Error("Narrative child returned without an authenticated disposition.");
  if (checkpointedReview && correction) {
    if (finished.outcome.status !== "verified")
      return subunitReviewStop(s, job, identity, correction, finished.outcome);
    if (await trustedHead(job) !== finished.outcome.headSha)
      throw new ProtocolIntegrityBlockedError("Narrative Review successor changed.");
    return { result: { ...s.result!, headSha: finished.outcome.headSha } };
  }
  const submission = finished.submission;
  const candidate = correction ? s.result : submission && submission.status !== "writer-round"
    ? { status: submission.status, headSha: submission.headSha } : null;
  if (patch && (patch.status || patch.operationRecovery || patch.reviewAssessmentRequested ||
      patch.reviewSteeringHandoff || patch.escalation || patch.reviewDependencyRequest))
    return { ...patch, result: candidate ?? null };
  if (finished.outcome.status === "paused") return { status: "paused",
    reason: "Original narrative assignment suspended at a safe boundary.", result: candidate ?? null };
  if ((!submission || submission.status === "writer-round") && finished.outcome.status === "unresolved") {
    const terminal = await inspectTerminal();
    if (terminal && terminal.proof.receiptDigest === finished.outcome.dispositionRef)
      return operationFailure(s, job, "specialist-result", Error("Original narrative assignment " + terminal.proof.kind),
        { reference: "specialist-receipt", assignmentId: active.id, resultStatus: terminal.proof.kind,
          assignmentFailure: { sourceHeadSha: sourceHead, proof: terminal.proof } }, "returned-failure");
  }
  if (!submission || !candidate) throw Error("Narrative child lost its original work item receipt.");
  if (finished.outcome.status === "unresolved") {
    if (!correction && !accepted[active.stage].includes(submission.status)) {
      const saved = result ?? await inspect();
      if (!saved || saved.status !== submission.status || saved.headSha !== submission.headSha)
        throw Error("Original narrative failure no longer matches its work-item receipt.");
      return { result: saved };
    }
    // The checkpoint can outlive the callback-local projection. Reopen the
    // original Review and reconstruct its parent-owned disposition.
    return { ...await reviewBoundary({ ...s, result: candidate }, correctionSelected), result: candidate };
  }
  if (finished.outcome.status !== "verified") throw Error("Narrative child has no verified result.");
  const head = await trustedHead(job);
  if (head !== finished.outcome.headSha)
    throw Error("Narrative child result no longer matches verified HEAD.");
  return { ...patch, result: { ...candidate, headSha: head } };
}

/** A focused assignment returns a settled prerequisite to its parent at END.
 * Neither this child nor the suspended writer can authorize supporting work. */
async function runFocusedAssignmentChild(s: State, config: RunnableConfig,
  reviewBoundary: (state: State, correctionSelected?: boolean) => Promise<Partial<State>>,
): Promise<Partial<State>> {
  const job = await openJob(s);
  const active = s.active;
  const graphThreadId = config.configurable?.thread_id;
  const turnDigest = s.request.turnPlanDigest;
  if (!active || active.stage !== "focus" || !active.milestone || !s.inventory ||
      !turnDigest || typeof graphThreadId !== "string" || graphThreadId !== s.graphThreadId ||
      s.planVersion === null)
    throw Error("Focused child lacks the exact admitted Turn and plan.");
  const target = active.milestone;
  const planVersion = s.planVersion;
  const pin = s.focusedPrerequisite;
  const prior = await inspectFocusedPrerequisite(job, target, turnDigest, s.request.fixture, planVersion);
  const pending = await inspectPendingFocusedCommit(job, target) ?? await inspectPendingFocusedInvocation(job, target);
  const { status: _status, verifiedSha: _sha, blockingReason: _reason, ...scope } = active;
  const identity: AssignmentIdentity = {
    schema: "noveltea-assignment-identity/v1", jobId: job.jobId, jobThreadId: job.threadId,
    graphThreadId, turnDigest, assignmentId: active.id, planVersion,
    sourceHeadSha: prior?.report.sourceSha ?? pending?.expectedHead ?? s.inventory.headSha,
    scopeDigest: dependencyDigest({ scope, task: s.request.task, contract: s.request.contract }),
  };
  const key = logicalAssignmentKey(identity);
  if (pin && logicalAssignmentKey(pin.identity) !== key)
    throw Error("Suspended focused assignment no longer matches the admitted scope.");
  const suspensionOf = (original: NonNullable<typeof prior>): AssignmentPrerequisiteSuspension => ({
    status: "needs-prerequisite", assignmentKey: key, evidenceRef: original.seal.reportDigest,
    suspensionRef: dependencyDigest(original.seal), owner: original.report.likelySpecialist,
    scopeRef: original.seal.reportDigest, pendingPhase: "writer",
  });
  const authenticate = async () => {
    if (!pin?.supportRef) return false;
    const original = await inspectFocusedPrerequisite(job, target, turnDigest, s.request.fixture, planVersion);
    const entry = (await inspectDependencyPlan(job))?.entries.find(e => e.reportDigest === pin.suspension.evidenceRef);
    if (!original || !isDeepStrictEqual(suspensionOf(original), pin.suspension) ||
        !entry?.amendment || entry.phase !== "verified" || dependencyDigest(entry) !== pin.supportRef ||
        entry.amendment.resumes !== active.id || entry.amendment.assignment.specialist !== pin.suspension.owner)
      return false;
    const head = await trustedHead(job);
    if (head === entry.commitSha) return true;
    return original.phase === "committed" && (await inspectRecoveryCheckpoints(job)).some(p =>
      p.eligible && p.workItem === active.id && p.parentSha === entry.commitSha && p.commitSha === head);
  };
  const preflight = async () => {
    await checkPlan(job, s.request, planVersion);
    await assertSteeringReceipts(job, turnDigest);
    const control = await readJobControl(job);
    if (control === "cancelled") { const error = Error("Focused assignment cancelled."); error.name = "StoryCancelledError"; throw error; }
    if (control === "paused") return { status: "paused", assignmentKey: key, evidenceRef: active.id,
      controlRef: "job-control" } as AssignmentOutcome;
    if (pin && !await authenticate()) throw Error("Focused continuation has no authenticated support.");
    if (!pin && prior?.phase === "waiting-dependency") return suspensionOf(prior);
    return null;
  };
  const runRound = async (command: AssignmentRoundCommand): Promise<AssignmentSubmission | AssignmentOutcome | AssignmentCorrection> => {
    const stopped = await preflight();
    if (stopped) return stopped;
    let result: Awaited<ReturnType<typeof dispatch>>;
    try {
      result = await dispatch(s, undefined, { assignmentKey: key, command });
    } catch (error) {
      if (error instanceof AssignmentAuthorPauseError) return { status: "paused", assignmentKey: key,
        evidenceRef: active.id, controlRef: "job-control" };
      if (!(error instanceof ProtocolExhaustedError || error instanceof AssignmentNonconvergenceError)) throw error;
      const failureHead = pin ? (await inspectPendingFocusedInvocation(job, target))?.expectedHead : identity.sourceHeadSha;
      const terminal = failureHead && await inspectFocusedFailure(job, target, failureHead);
      if (!terminal) throw error;
      return { status: "unresolved", assignmentKey: key, evidenceRef: terminal.proof.receiptDigest,
        dispositionRef: terminal.proof.kind };
    }
    if (result.status === "dependency-required") {
      const original = await inspectFocusedPrerequisite(job, target, turnDigest, s.request.fixture, planVersion);
      if (!original || original.phase !== "waiting-dependency" ||
          original.report.sourceSha !== identity.sourceHeadSha)
        throw Error("Focused no-write result lost its sealed original report.");
      return suspensionOf(original);
    }
    return subunitWriterResult(result as { status: string; headSha?: string; round?: AssignmentRoundResult }, active.id);
  };
  const invokeRound = async (command: AssignmentRoundCommand) => {
    const result = await runRound(command);
    if ("correctionRef" in result) throw new ProtocolIntegrityBlockedError("Focused writer cannot admit its own correction.");
    return result;
  };
  let patch: Partial<State> | undefined;
  const child = createGenerationQuestionGraph(job, identity, focusedChoiceWorkItem(target), {
    preflight: async state => {
      if (logicalAssignmentKey(state.identity) !== key || state.continuationRef !== (pin?.supportRef ?? null))
        throw new ProtocolIntegrityBlockedError("Focused checkpoint belongs to another assignment.");
      return preflight();
    },
    authenticateContinuation: async state =>
      state.continuationRef === pin?.supportRef && await authenticate(),
    invoke: async () => invokeRound({ phase: "invoke" }),
    reenterWriter: async () => invokeRound({ phase: "invoke" }),
    correct: async state => invokeRound({ phase: "correct", proof: subunitRoundProof(state.submission!),
      grantDigest: state.correction!.correctionRef }),
    verify: async state => {
      const stopped = await preflight();
      if (stopped) return stopped;
      let submission = state.submission!;
      if (submission.status === "writer-round") {
        const verified = await runRound({ phase: "verify", proof: subunitRoundProof(submission) });
        if ("assignmentKey" in verified || "correctionRef" in verified) return verified;
        if (verified.status !== "focused-committed" || !verified.headSha)
          throw new ProtocolIntegrityBlockedError("Focused round did not settle its original commit.");
        return { submission: verified, reviewPending: true as const };
      }
      const candidate = { ...s, result: { status: submission.status, headSha: submission.headSha } };
      patch = await reviewBoundary(candidate);
      const actual = patch.result === undefined ? candidate.result : patch.result;
      const head = await trustedHead(job);
      const points = (await inspectRecoveryCheckpoints(job)).filter(p => p.eligible);
      const reviews = await resolvedCheckpointReviews(job, points);
      if (!patch.status && !patch.operationRecovery && !patch.recovery && !patch.unknownRecovery &&
          !patch.escalation && !patch.reviewSteeringHandoff && actual?.headSha === head &&
          accepted.focus.includes(actual.status) && points.some(p =>
            p.workItem === active.id && p.commitSha === head && p.validation.status === "passed" &&
            (s.request.fixture || p.assurance?.turnDigest === turnDigest &&
              ["passed", "not-required"].includes(reviews.get(p.commitSha) ?? p.semanticReview))))
        return { status: "verified", assignmentKey: key, evidenceRef: active.id,
          headSha: head, reviewRef: "review-checkpoints:" + head };
      return { status: "unresolved", assignmentKey: key, evidenceRef: active.id,
        dispositionRef: "review-checkpoints" };
    },
  }, async head => !!pin && await authenticate() && await trustedHead(job) === head);
  const finished = await child.invoke({ identity, submission: null, submissionKey: null,
    outcome: null, continuationRef: pin?.supportRef ?? null, suspension: pin?.suspension ?? null }, { ...assignmentChildConfig(config, identity), durability: "sync" });
  if (finished.outcome?.status === "needs-prerequisite")
    return { result: { status: "dependency-required" },
      focusedPrerequisite: { identity, suspension: finished.outcome, supportRef: null } };
  if (finished.outcome?.status === "paused") return { status: "paused",
    reason: "Original Focused assignment suspended at a safe boundary." };
  if (finished.outcome?.status === "unresolved" &&
      ["protocol-exhausted", "nonconverging"].includes(finished.outcome.dispositionRef)) {
    const sourceHeadSha = (await inspectPendingFocusedInvocation(job, target))?.expectedHead ?? identity.sourceHeadSha;
    const terminal = await inspectFocusedFailure(job, target, sourceHeadSha);
    if (!terminal || terminal.proof.receiptDigest !== finished.outcome.evidenceRef)
      throw new ProtocolIntegrityBlockedError("Focused terminal lost its original invocation proof.");
    return operationFailure(s, job, "specialist-result", "Original Focused correction did not settle.",
      { reference: "specialist-receipt", assignmentId: active.id, resultStatus: terminal.proof.kind,
        assignmentFailure: { sourceHeadSha, proof: terminal.proof } }, "returned-failure");
  }
  if (!finished.submission) throw Error("Focused child returned without its original submission.");
  const result = { status: finished.submission.status, headSha: finished.submission.headSha };
  if (!patch && finished.outcome?.status === "unresolved") patch = await reviewBoundary({ ...s, result });
  // The parent reattests review and native completion; unresolved review keeps
  // its original submitted receipt rather than restarting the writer.
  return { ...patch, result: patch?.result === undefined ? result : patch.result,
    focusedPrerequisite: null };
}

/** Recover the original submitted work and exact negative Review from the
 * existing receipt stores. No dependency grant is derived from graph state. */
async function reviewPrerequisiteIdentity(s: State, config: RunnableConfig,
  request: ReviewDependencyRequest): Promise<ReviewPrerequisitePin> {
  const job = await openJob(s);
  const active = s.recoveryLifecycle.active;
  const graphThreadId = config.configurable?.thread_id;
  if (!active || active.origin.operation !== "independent-review" ||
      s.recoveryLifecycle.phase !== "correcting" || s.recoveryLifecycle.assessorPending ||
      s.recoveryLifecycle.decision?.action !== "known-correction" ||
      s.recoveryLifecycle.decision.adapter !== "review-cycle" ||
      !s.active || !s.result || s.request.fixture ||
      s.active.id !== active.origin.assignmentId || s.result.headSha !== active.origin.sourceHeadSha ||
      active.origin.sourceHeadSha !== request.sourceSha ||
      s.request.turnPlanDigest !== request.turnDigest || s.planVersion !== request.basePlanVersion ||
      typeof graphThreadId !== "string" || graphThreadId !== s.graphThreadId ||
      request.action !== "controller-amendment-required")
    throw Error("Review prerequisite lacks the original admitted Review case, Turn or plan.");
  const { authenticateOperationReviewProof } = await import("./generation-operation-strategy.js");
  if (!await authenticateOperationReviewProof(job, s, active, s.recoveryLifecycle.decision))
    throw Error("Review prerequisite lost its original failed reviewer proof.");
  const plan = await inspectDependencyPlan(job);
  if (!plan?.reviewRequests?.some(r => isDeepStrictEqual(r, request)))
    throw Error("Review prerequisite request is not sealed in the controller ledger.");
  const point = (await inspectRecoveryCheckpoints(job)).find(p => p.eligible &&
    p.commitSha === request.sourceSha && p.semanticReview === "failed" &&
    p.assurance?.assignmentDigest === request.originalAssignmentDigest);
  const turn = await readTurnEvidence(job, s.request.contract, s.request.task, request.turnDigest);
  if (!point?.assurance || !turn) throw Error("Review prerequisite lost its native checkpoint and Turn.");
  const owners = request.otherOwnerPath ? turn.assignments.filter(a => a.id !== request.originalAssignmentId &&
    (a.authority.existingPaths.includes(request.otherOwnerPath!) ||
      a.authority.newPaths?.includes(request.otherOwnerPath!))) : [];
  const owner = request.classification === "new-full-story-record" ? "nt-character-development" :
    request.classification === "other-owner" && owners.length === 1 ? owners[0]!.specialist : null;
  if (!owner) throw Error("Review prerequisite does not have a unique authorized owner.");
  const migrated = /^(?:event-|focus:)/.test(request.originalWorkItem);
  const { status: _status, verifiedSha: _verified, blockingReason: _blocked, ...scope } = s.active;
  const focusSource = migrated && s.active.stage === "focus" && s.active.milestone
    ? await inspectFocusedPrerequisite(job, s.active.milestone, request.turnDigest, false, request.basePlanVersion) : null;
  const identity: AssignmentIdentity = {
    schema: "noveltea-assignment-identity/v1", jobId: job.jobId, jobThreadId: job.threadId,
    graphThreadId, turnDigest: request.turnDigest, assignmentId: migrated ? request.originalWorkItem : s.active.id,
    planVersion: request.basePlanVersion, sourceHeadSha: focusSource?.report.sourceSha ?? point.parentSha,
    scopeDigest: migrated ? dependencyDigest({ scope, task: s.request.task, contract: s.request.contract }) : request.originalAssignmentDigest,
  };
  const suspension: AssignmentPrerequisiteSuspension = {
    status: "needs-prerequisite", assignmentKey: logicalAssignmentKey(identity),
    evidenceRef: request.reviewDigest, suspensionRef: request.digest,
    owner, scopeRef: request.scopeDigest, pendingPhase: "review",
  };
  return { identity, suspension, supportRef: null, recoveryCaseId: active.id,
    submission: { receiptRef: "review-checkpoints:" + request.sourceSha,
      status: s.result.status, headSha: request.sourceSha } };
}

async function authenticatedReviewPrerequisite(s: State, config: RunnableConfig) {
  const pin = s.reviewPrerequisite;
  if (!pin) throw Error("No suspended original Review assignment.");
  const job = await openJob(s);
  const request = (await inspectDependencyPlan(job))?.reviewRequests?.find(r =>
    r.digest === pin.suspension.suspensionRef);
  if (!request) throw Error("Suspended Review lost its original dependency request.");
  const original = await reviewPrerequisiteIdentity(s, config, request);
  if (!isDeepStrictEqual({ ...pin, supportRef: null }, original))
    throw Error("Suspended Review checkpoint differs from the exact original source and owner.");
  return { job, request, pin };
}

/** A returned-END Review continuation is a logical reentry, not a
 * Command(resume) interrupt. The original writer submission is immutable. */
async function runReviewPrerequisiteChild(s: State, config: RunnableConfig,
  request: ReviewDependencyRequest, initial: ReviewPrerequisitePin): Promise<Partial<State>> {
  const job = await openJob(s);
  const key = logicalAssignmentKey(initial.identity);
  const { inspectReviewSupport, continueReviewDependency } = await import("./dependency-work.js");
  const eventSource = request.classification === "new-full-story-record" &&
    request.originalWorkItem.startsWith("event-");
  const correction = s.recoveryLifecycle.active!;
  const outcome = (status: AssignmentOutcome["status"], evidenceRef: string, extra: Record<string, string>) =>
    ({ status, assignmentKey: key, evidenceRef, ...extra }) as AssignmentOutcome;
  const authenticate = async () => {
    const verified = await reviewPrerequisiteIdentity(s, config, request);
    if (!isDeepStrictEqual({ ...initial, supportRef: null }, verified)) return false;
    if (!initial.supportRef) return true;
    const support = await inspectReviewSupport(job, request);
    return support.ref === initial.supportRef && support.entry.amendment?.assignment.specialist === initial.suspension.owner;
  };
  const preflight = async () => {
    if (!await authenticate()) throw Error("Original Review prerequisite is not authenticated.");
    await checkPlan(job, s.request, s.planVersion);
    const control = await readJobControl(job);
    if (control === "paused") return outcome("paused", "job-control", { controlRef: "author-pause:job-control" });
    if (control === "cancelled") return outcome("unresolved", "job-control", { dispositionRef: "cancelled" });
    return null;
  };
  const reviewRounds = subunitReviewTransitions(s, job, initial.identity, initial.submission.receiptRef,
    correction, preflight, outcome);
  const child = createAssignmentLifecycleGraph({
    preflight: async state => {
      if (logicalAssignmentKey(state.identity) !== key || state.continuationRef !== initial.supportRef)
        throw new ProtocolIntegrityBlockedError("Review prerequisite checkpoint changed.");
      return preflight();
    },
    authenticateContinuation: async state =>
      state.continuationRef === initial.supportRef && await authenticate(),
    invoke: async () => { throw Error("Review prerequisite must not replay its original writer."); },
    correct: async state => {
      if (!eventSource || !initial.supportRef) throw Error("No original Event corrective grant.");
      return reviewRounds.correct(state.submission!, state.correction!);
    },
    verify: async state => {
      if (!initial.supportRef) return initial.suspension;
      const support = await inspectReviewSupport(job, request);
      if (support.ref !== initial.supportRef) throw Error("Supporting assignment proof changed.");
      if (eventSource && support.entry.phase !== "verified")
        return reviewRounds.verify(state.submission!);
      if (!eventSource) await continueReviewDependency(job, request, initial.supportRef);
      if (request.classification === "other-owner") {
        const { revalidateOtherOwnerPrerequisite } = await import("./review-other-owner-revalidation.js");
        const { policy } = await (await import("./job-pi-policy.js")).inspectPiPolicy(job);
        await withStoryJobLock(job, "other-owner-dependent-revalidation", () =>
          revalidateOtherOwnerPrerequisite({
            job, request, inventory: s.inventory ?? undefined,
            contract: s.request.contract, task: s.request.task,
            provider: s.request.provider ?? policy.profile.provider,
            model: s.request.model ?? policy.profile.model, skillsSource: s.request.skillsSource,
            validatorSource: s.request.validatorSource,
          }));
      }
      const head = await trustedHead(job);
      const { verifyReviewCycleSuccessor } = await import("./generation-recovery-resolution.js");
      if (!await verifyReviewCycleSuccessor(job, request.sourceSha, head))
        throw Error("Supporting work does not independently cover the original failed Review and affected dependents.");
      return { status: "verified", assignmentKey: key, evidenceRef: request.digest,
        reviewRef: initial.supportRef, headSha: head };
    },
  });
  const finished = await child.invoke({ identity: initial.identity, submission: initial.submission,
    submissionKey: key, outcome: null, continuationRef: initial.supportRef,
    suspension: initial.supportRef ? initial.suspension : null },
    { ...assignmentChildConfig(config, initial.identity, "correction"), durability: "sync" });
  if (finished.outcome?.status === "needs-prerequisite")
    return { reviewPrerequisite: initial };
  if (finished.outcome && finished.outcome.status !== "verified")
    return subunitReviewStop(s, job, initial.identity, correction, finished.outcome);
  if (finished.outcome?.status !== "verified" || !initial.supportRef ||
      finished.outcome.assignmentKey !== key)
    throw Error("Original Review prerequisite child did not return authenticated coverage.");
  if (eventSource) {
    const { finalizeReviewEventDependency } = await import("./dependency-state.js");
    if (!await withStoryJobLock(job, "event-dependency-review-completion", () =>
      finalizeReviewEventDependency(job, request.sourceSha)))
      throw new ProtocolIntegrityBlockedError("Original Event repair did not settle the supporting dependency.");
  }
  // Re-attest even when the child END result was restored from SQLite.
  const head = await trustedHead(job);
  const { verifyReviewCycleSuccessor } = await import("./generation-recovery-resolution.js");
  if (head !== finished.outcome.headSha || !await verifyReviewCycleSuccessor(job, request.sourceSha, head))
    throw Error("Returned Review child has no current verified successor.");
  const entry = (await inspectReviewSupport(job, request)).entry;
  const dependencyHistory = [...s.dependencyHistory.filter(p => p.reportDigest !== entry.reportDigest),
    { reportDigest: entry.reportDigest, entryDigest: dependencyDigest(entry) }];
  let result: State["result"] = { ...s.result!, headSha: head };
  if (s.result?.status === "review-handoff") {
    const next = s.active?.stage === "foundations" ? "character-foundations" :
      s.active && ["interactive", "choice", "puzzle"].includes(s.active.stage) && s.active.milestone
        ? "interactive-" + (s.active.stage === "choice" ? "choice" : "puzzle") +
          "-" + s.active.milestone.slice(10) : null;
    if (!next) throw Error("Review continuation has no original pending specialist unit.");
    await assertNativeReviewDependencies(job, next);
    result = null;
  }
  return { reviewPrerequisite: null, dependencyHistory, result, escalation: null };
}

/** Each native Interactive subunit has its own original source and nested
 * assignment lifecycle. The parent alone handles negative results and plan
 * amendments; neither Choice nor Puzzle can certify the other. */
async function runInteractiveAssignmentChildren(s: State, config: RunnableConfig,
    reviewBoundary: (state: State, correctionSelected?: boolean) => Promise<Partial<State>>,
    correctionSelected = false): Promise<Partial<State>> {
  if (!s.active?.milestone || !s.inventory ||
      !["interactive", "choice", "puzzle"].includes(s.active.stage))
    throw Error("Interactive child requires its original parent assignment");
  const job = await openJob(s);
  const active = s.active;
  const milestone = active.milestone!;
  const graphThreadId = config.configurable?.thread_id;
  if (typeof graphThreadId !== "string" || graphThreadId !== s.graphThreadId)
    throw Error("Interactive child lacks original graph Thread identity");
  await checkPlan(job, s.request, s.planVersion);
  const correction = correctionSelected ? s.recoveryLifecycle.active : null;
  let correctionDomain: InteractiveDomain | undefined;
  if (correction) {
    const root = (await inspectRecoveryCheckpoints(job)).find(p => p.eligible &&
      p.commitSha === correction.origin.sourceHeadSha);
    correctionDomain = root?.workItem === "interactive-choice-" + milestone.slice(10) ? "choice" :
      root?.workItem === "interactive-puzzle-" + milestone.slice(10) ? "puzzle" : undefined;
    if (!correctionDomain || !s.result || correction.origin.assignmentId !== active.id)
      throw Error("Interactive correction lacks the original reviewed subunit");
  }
  const pending = !correction && active.stage === "interactive" &&
    await inspectPendingInteractiveInvocation(job, milestone, "puzzle", s.inventory.headSha);
  if (pending) await assertNativeReviewDependencies(job, pending.unit.id);
  let choiceReviewed = false;
  if (!correction && !pending && active.stage === "interactive") {
    const choice = await inspectInteractiveUnit(job, milestone, "choice");
    if (choice?.unit.phase === "committed" && choice.unit.commitSha) {
      const points = (await inspectRecoveryCheckpoints(job)).filter(p => p.eligible);
      const point = points.find(p => p.workItem === choice.unit.id && p.commitSha === choice.unit.commitSha);
      const reviews = await resolvedCheckpointReviews(job, points);
      if (point && (s.request.fixture && !point.assurance ||
          ["passed", "not-required"].includes(reviews.get(point.commitSha) ?? point.semanticReview))) {
        await assertNativeReviewDependencies(job, "interactive-puzzle-" + milestone.slice(10));
        choiceReviewed = true;
      }
    }
  }
  const domains: InteractiveDomain[] = correctionDomain ? [correctionDomain] :
    active.stage === "interactive" ? (pending || choiceReviewed ? ["puzzle"] : ["choice", "puzzle"]) : [active.stage as InteractiveDomain];
  for (const domain of domains) {
    const original = await inspectInteractiveUnit(job, milestone, domain);
    const sourceHead = original?.unit.beforeHead ?? await trustedHead(job);
    const workItem = "interactive-" + domain + "-" + milestone.slice(10);
    const { status: _status, verifiedSha: _verified, blockingReason: _blocked, ...scope } = active;
    const identity: AssignmentIdentity = {
      schema: "noveltea-assignment-identity/v1", jobId: job.jobId, jobThreadId: job.threadId,
      graphThreadId, turnDigest: s.request.turnPlanDigest ?? fixtureTurnIdentity({
        jobId: job.jobId, jobThreadId: job.threadId, graphThreadId, turnDigest: null,
        fixture: s.request.fixture, task: s.request.task, contract: s.request.contract,
      }), assignmentId: workItem, planVersion: s.planVersion, sourceHeadSha: sourceHead,
      scopeDigest: createHash("sha256").update(JSON.stringify({
        scope, domain, task: s.request.task, contract: s.request.contract,
      })).digest("hex"),
    };
    const key = logicalAssignmentKey(identity);
    const ref = "interactive-items/" + milestone.slice(10) + ".json#" + workItem;
    let patch: Partial<State> | undefined;
    let result: Awaited<ReturnType<typeof runInteractiveWorkItem>> | undefined;
    const outcome = (status: AssignmentOutcome["status"], extra: Record<string, string> = {}): AssignmentOutcome =>
      ({ status, assignmentKey: key, evidenceRef: ref, ...extra }) as AssignmentOutcome;
    const authenticateCorrection = async () => !!correction && !!s.recoveryLifecycle.decision &&
      await (await import("./generation-operation-strategy.js")).authenticateOperationReviewProof(
        job, s, correction, s.recoveryLifecycle.decision);
    const preflight = async (): Promise<AssignmentOutcome | null> => {
        const currentPlan = await checkPlan(job, s.request, s.planVersion);
        if (currentPlan?.plan?.version !== s.planVersion)
          throw new ProtocolIntegrityBlockedError("Subunit round cannot use a stale plan; reconcile at parent intake.");
        if (s.request.turnPlanDigest) await assertSteeringReceipts(job, s.request.turnPlanDigest);
        const control = await readJobControl(job);
        if (control === "cancelled") { const e = Error("Original Interactive assignment cancelled"); e.name = "StoryCancelledError"; throw e; }
        if (control !== "running") return outcome("paused", { controlRef: correction ? "author-pause:job-control" : "job-control" });
        if (correction && (original?.unit.assignmentKey !== key || !await authenticateCorrection()))
          throw new ProtocolIntegrityBlockedError("Interactive child correction lacks its original assignment key or admitted Review case");
        const saved = await inspectInteractiveUnit(job, milestone, domain);
        if (saved?.unit.beforeHead && saved.unit.beforeHead !== sourceHead)
          throw Error("Interactive child source changed");
        if (!correction && !saved?.unit.beforeHead && await trustedHead(job) !== sourceHead)
          throw Error("Interactive child lacks its original verified HEAD");
        return null;
    };
    const runRound = async (command: AssignmentRoundCommand) => {
        try {
          const stopped = await preflight();
          if (stopped) return stopped;
          result = await dispatch(s, domain, { assignmentKey: key, command }) as typeof result;
          if (!result) throw Error("Interactive child returned no original receipt");
          return subunitWriterResult(result, ref);
        } catch (error) {
          // Budget/provider pauses have their own durable policy evidence and
          // reason. Let the parent handle them without collapsing them into
          // a job-control pause or finalizing an unfinished child.
          if (error instanceof AssignmentAuthorPauseError)
            return outcome("paused", { controlRef: correction ? "author-pause:job-control" : "job-control" });
          if (!(error instanceof ProtocolExhaustedError || error instanceof AssignmentNonconvergenceError)) throw error;
          const terminal = await inspectInteractiveFailure(job, milestone, domain, sourceHead);
          if (!terminal) throw Error("Interactive terminal failure lacks authenticated original effects");
          patch = await operationFailure(s, job, "specialist-result", error,
            { reference: "specialist-receipt", assignmentId: active.id, resultStatus: terminal.proof.kind,
              assignmentFailure: { sourceHeadSha: sourceHead, proof: terminal.proof }, interactiveDomain: domain },
            "returned-failure");
          return outcome("unresolved", { dispositionRef: terminal.proof.receiptDigest });
        }
    };
    const invokeRound = async (command: AssignmentRoundCommand) => {
      const result = await runRound(command);
      if ("correctionRef" in result) throw new ProtocolIntegrityBlockedError("Writer cannot admit its own correction.");
      return result;
    };
    const reviewRounds = subunitReviewTransitions(s, job, identity, ref, correction, preflight,
      (status, evidenceRef, extra) => ({ ...outcome(status, extra), evidenceRef }));
    const assertIdentity = (state: { identity: AssignmentIdentity; continuationRef: string | null }) => {
      if (logicalAssignmentKey(state.identity) !== key || state.continuationRef !== (correction?.id ?? null))
        throw new ProtocolIntegrityBlockedError("Interactive checkpoint belongs to another assignment.");
    };
    const verifyCommitted = async (submission: AssignmentSubmission): Promise<AssignmentOutcome> => {
        const saved = await inspectInteractiveUnit(job, milestone, domain);
        if (!saved || submission.receiptRef !== ref ||
            saved.unit.beforeHead !== sourceHead)
          throw Error("Interactive child submission lost its exact original receipt");
        const { unit, receipt } = saved;
        if (unit.phase === "conflicted")
          return outcome("unresolved", { dispositionRef: unit.digest! });
        if (unit.phase === "not-applicable") {
          // Reopen the existing authoritative no-write seal, never synthesize a commit.
          const inspected = await runInteractiveWorkItem({ ...s.request, milestone, unit: domain, action: "inspect" });
          if (unit.eventOnly) await readEventOnlyOmission(job, milestone, unit.eventOnly);
          else {
            const { readPuzzleNoWrite } = await import("./puzzle-obligation.js");
            const proof = await readPuzzleNoWrite(job, milestone, unit.noWrite);
            if (proof.unitId !== unit.id || proof.choiceHead !== receipt.units[0].commitSha ||
                proof.verifiedHead !== unit.beforeHead || proof.planDigest !== receipt.planDigest)
              throw Error("Interactive omission does not match original source");
          }
          if (!inspected.headSha) throw Error("Interactive omission has no verified source");
          return outcome("verified", { headSha: unit.beforeHead!, reviewRef: ref });
        }
        if (unit.phase !== "committed" || !unit.commitSha)
          throw Error("Interactive child has no committed native result");
        const points = (await inspectRecoveryCheckpoints(job)).filter(p => p.eligible);
        const point = points.find(p => p.workItem === workItem && p.commitSha === unit.commitSha &&
          p.parentSha === sourceHead && p.validation.status === "passed" &&
          p.planVersion === s.planVersion &&
          (s.request.fixture || p.assurance?.turnDigest === s.request.turnPlanDigest));
        if (!point) {
          // A fork carries historical native checkpoints in its immutable
          // admission bundle, not in the child's local checkpoint journal.
          const fork = readRecoveryFork(job);
          const historical = fork?.commits[workItem];
          const originalUnit = fork?.receipts[ref.split("#")[0]!]?.units?.find(
            (entry: { id: string }) => entry.id === workItem);
          const inheritedReview = resolvedInheritedRecoveryReviews(fork?.reviewCoverage ?? [])
            .find(entry => entry.workItem === workItem && entry.commitSha === unit.commitSha);
          if (correction || !fork?.checkpoint.completedWorkItems.includes(workItem) ||
              historical?.sha !== unit.commitSha || historical.planVersion !== s.planVersion ||
              originalUnit?.phase !== "committed" || originalUnit.commitSha !== unit.commitSha ||
              originalUnit.beforeHead !== sourceHead || originalUnit.digest !== unit.digest ||
              (!(s.request.fixture && !inheritedReview) &&
                !["passed", "not-required"].includes(inheritedReview?.status ?? "")))
            throw Error("Interactive child lacks independently verified native checkpoint");
          return outcome("verified", { headSha: await trustedHead(job), reviewRef: "recovery-fork:" + unit.commitSha });
        }
        const covered = await resolvedCheckpointReviews(job, points);
        const pending = !(s.request.fixture && !point.assurance) &&
          !["passed", "not-required"].includes(covered.get(point.commitSha) ?? point.semanticReview);
        const candidate: State = { ...s, result: correction ? s.result :
          { status: active.stage === "interactive" && domain === "choice"
              ? "review-handoff" : submission.status, headSha: unit.commitSha } };
        if (pending && s.request.fixture)
          return outcome("needs-prerequisite", { suspensionRef: "review-checkpoints:" + unit.commitSha,
            owner: "nt-narrative-review", scopeRef: identity.scopeDigest, pendingPhase: "review" });
        if (pending || correction) {
          patch = await reviewBoundary(candidate, false);
          if (patch.status === "paused") return outcome("paused", { controlRef: "review-checkpoints" });
          if (patch.status === "blocked" || patch.status === "cancelled" || patch.operationRecovery ||
              patch.reviewAssessmentRequested || patch.reviewSteeringHandoff || patch.escalation || patch.reviewDependencyRequest)
            return outcome("unresolved", { dispositionRef: "review-checkpoints:" + unit.commitSha });
        }
        const refreshed = (await inspectRecoveryCheckpoints(job)).filter(p => p.eligible);
        const reviews = await resolvedCheckpointReviews(job, refreshed);
        const current = refreshed.find(p => p.commitSha === unit.commitSha);
        if (!current || !(s.request.fixture && !current.assurance) &&
            !["passed", "not-required"].includes(reviews.get(unit.commitSha) ?? current.semanticReview))
          throw Error("Interactive child did not settle its mandatory independent Review");
        return outcome("verified", { headSha: await trustedHead(job), reviewRef: "review-checkpoints:" + unit.commitSha });
    };
    const child = createAssignmentLifecycleGraph({
      authenticateContinuation: async state => state.continuationRef === correction?.id && await authenticateCorrection(),
      preflight: async state => { assertIdentity(state); return preflight(); },
      invoke: async state => { assertIdentity(state); return invokeRound({ phase: "invoke" }); },
      correct: async state => {
        assertIdentity(state);
        return correction ? reviewRounds.correct(state.submission!, state.correction!) : invokeRound({ phase: "correct", proof: subunitRoundProof(state.submission!), grantDigest: state.correction!.correctionRef });
      },
      verify: async state => {
        assertIdentity(state);
        let submission = state.submission!;
        if (correction) return reviewRounds.verify(submission);
        const stopped = await preflight();
        if (stopped) return stopped;
        if (submission.status === "writer-round") {
          const verified = await runRound({ phase: "verify", proof: subunitRoundProof(submission) });
          if ("assignmentKey" in verified || "correctionRef" in verified) return verified;
          if (verified.status === "writer-round") throw Error("Interactive verification did not settle the round.");
          submission = verified;
          const unit = (await inspectInteractiveUnit(job, milestone, domain))?.unit;
          if (unit?.phase === "committed" && submission.headSha === unit.commitSha)
            return { submission, reviewPending: true as const };
        }
        return { submission, outcome: await verifyCommitted(submission) };
      },
    });
    const finished = await child.invoke({ identity,
      submission: correction && s.result ? { receiptRef: ref, status: s.result.status, headSha: s.result.headSha } : null,
      submissionKey: correction ? key : null, outcome: null, continuationRef: correction?.id ?? null },
      { ...assignmentChildConfig(config, identity, correction ? "correction" : "original"), durability: "sync" });
    if (!finished.outcome || finished.outcome.assignmentKey !== key)
      throw Error("Interactive child returned no authenticated outcome");
    const settled = finished.outcome;
    if (correction) {
      if (settled.status !== "verified") return subunitReviewStop(s, job, identity, correction, settled);
      return { result: s.result?.status === "review-handoff" ? null : { ...s.result!, headSha: settled.headSha } };
    }
    if (patch && (patch.operationRecovery || patch.status || patch.reviewAssessmentRequested ||
        patch.reviewSteeringHandoff || patch.escalation || patch.reviewDependencyRequest)) {
      const candidate = finished.submission && { status: active.stage === "interactive" && domain === "choice"
        ? "review-handoff" : finished.submission.status, headSha: finished.submission.headSha };
      return { ...patch, result: correction ? s.result : candidate ?? null };
    }
    if (settled.status === "paused") return { status: "paused", reason: "Original Interactive assignment suspended at a safe boundary." };
    if (settled.status === "unresolved") {
      const saved = await inspectInteractiveUnit(job, milestone, domain);
      if (saved?.unit.phase === "conflicted")
        return { result: await runInteractiveWorkItem({ ...s.request, milestone, unit: domain, action: "inspect" }) };
      // Child checkpoint replay must reconstruct the original terminal proof
      // rather than interpreting a missing callback projection as success.
      const terminal = await inspectInteractiveFailure(job, milestone, domain, sourceHead);
      if (terminal) return operationFailure(s, job, "specialist-result", terminal.proof.kind,
        { reference: "specialist-receipt", assignmentId: active.id, resultStatus: terminal.proof.kind,
          assignmentFailure: { sourceHeadSha: sourceHead, proof: terminal.proof }, interactiveDomain: domain },
        "returned-failure");
      if (finished.submission) {
        const candidate = { status: active.stage === "interactive" && domain === "choice"
          ? "review-handoff" : finished.submission.status, headSha: finished.submission.headSha };
        return { ...await reviewBoundary({ ...s, result: correction ? s.result : candidate }, correctionSelected),
          result: correction ? s.result : candidate };
      }
      throw Error("Interactive child returned an unauthenticated unresolved disposition");
    }
    if (settled.status === "needs-prerequisite") {
      const inspected = await runInteractiveWorkItem({ ...s.request, milestone, unit: domain, action: "inspect" });
      if (inspected.status === "interactive-conflict-reported") return { result: inspected };
      return { result: { status: "review-handoff", headSha: finished.submission?.headSha } };
    }
    if (settled.status !== "verified") throw Error("Interactive child cannot advance without verified disposition");

    if (domain === "choice" && domains.length === 2 && (await inspectInteractiveUnit(job, milestone, domain))?.unit.phase === "committed")
      return { result: { status: "review-handoff", headSha: settled.headSha } };
    if (domain === domains.at(-1)) {
      const inspected = await runInteractiveWorkItem({ ...s.request, milestone,
        unit: active.stage === "interactive" ? undefined : domain, action: "inspect" });
      return { result: { ...inspected, headSha: await trustedHead(job) } };
    }
  }
  throw Error("Interactive child returned without a completed assignment");
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
  if (error instanceof Error && ["PiBudgetPause", "PiModelUnavailableError", "FoundationAuthorRequiredError",
    "SpecialistChoiceRequiredError", "StoryCancelledError"].includes(error.name))
    return blocked(error);
  if (error instanceof ProtocolExhaustedError && error.proof)
    evidence = { ...evidence, failureKind: "protocol", protocolFailure: error.proof };
  else if (error instanceof ProtocolIntegrityBlockedError)
    evidence = { ...evidence, failureKind: "integrity" };
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
  return { status: ["PiBudgetPause", "PiModelUnavailableError", "FoundationAuthorRequiredError", "SpecialistChoiceRequiredError", "AssignmentAuthorPauseError"].includes(e.name ?? "") ? "paused" :
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
        if (s.active.stage === "foundation")
          throw new ProtocolIntegrityBlockedError("Foundation corrections must use the checkpointed assignment child.");
        const progress = await advanceRejectedRepair(job, point.commitSha, {
          skillsSource: s.request.skillsSource, provider: s.request.provider,
          model: s.request.model,
          sharedAssessment: usesSharedAssignmentReview(s.active.id),
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
        if (progress.next === "assess-review")
          return { reviewAssessmentRequested: true, reason: "Assessing the sealed Foundation Review boundary." };
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
            await withStoryJobLock(job, "other-owner-prerequisite-evidence", () =>
              recordReviewDependency(job, request));
            // No owner approval or support work inside the original Review.
            return { reviewDependencyRequest: request };
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
          ...(usesSharedAssignmentReview(s.active.id) && progress.next === "author-choice" ?
            { reviewPauseReason: "author-choice" as const } : {}),
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
    if (correctionSelected && usesSharedAssignmentReview(s.active?.id) && error instanceof Error) {
      const reason = error.name === "PiBudgetPause" ? "budget" :
        error.name === "PiModelUnavailableError" ? "provider-unavailable" :
        error.name === "StoryCancelledError" ? "cancelled" :
        error.name === "SpecialistChoiceRequiredError" ? "author-choice" : null;
      if (reason) return { status: reason === "cancelled" ? "cancelled" : "paused",
        reviewPauseReason: reason, reason: error.message };
    }
    if (error instanceof (await import("./rejected-review-repair.js")).ReviewDependencyRequiredError) {
      const request = error.request;
      if (request.action === "controller-amendment-required" &&
          request.classification === "new-full-story-record") {
        // The parent admits the separate Character grant only after the
        // original Review returns its typed prerequisite at END.
        return { reviewDependencyRequest: request };
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
async function pendingInteractiveForResume(s: State, job: JobStartResult) {
  if (!s.active?.milestone || s.result || !s.inventory ||
      !["interactive", "choice", "puzzle"].includes(s.active.stage)) return null;
  const domains: InteractiveDomain[] = s.active.stage === "interactive" ? ["puzzle", "choice"] : [s.active.stage as InteractiveDomain];
  for (const domain of domains) {
    const original = await inspectPendingInteractiveInvocation(job, s.active.milestone, domain, s.inventory.headSha);
    if (original) return original;
  }
  return null;
}

async function pendingNarrativeForResume(s: State, job: JobStartResult) {
  if (!s.active?.milestone || s.result || !s.inventory) return null;
  return s.active.stage === "event"
    ? inspectPendingEventInvocation(job, s.active.milestone, s.inventory.headSha)
    : s.active.stage === "composition"
      ? inspectPendingCompositionInvocation(job, s.active.milestone, s.inventory.headSha)
      : s.active.stage === "focus" ? await inspectPendingFocusedCommit(job, s.active.milestone) ??
        await inspectPendingFocusedInvocation(job, s.active.milestone) : null;
}

async function inspectOriginalSpecialistCommitForResume(
  s: State, job: JobStartResult,
): Promise<boolean> {
  if (!s.active || s.result || !s.inventory) return false;
  clean(job);
  if (s.active.stage === "architecture") return (await import("./architecture.js")).inspectRecoverableArchitectureCommit(job, s.inventory.headSha);
  if (s.active.stage === "foundation") {
    const { inspectRecoverableFoundationCommit } = await import("./foundation.js");
    return inspectRecoverableFoundationCommit(job);
  }
  if (["interactive", "choice", "puzzle"].includes(s.active.stage) && s.active.milestone) {
    const pending = await pendingInteractiveForResume(s, job);
    if (pending?.unit.phase === "authored") return true;
    const head = await trustedHead(job);
    const points = await inspectRecoveryCheckpoints(job);
    const domains = s.active.stage === "interactive" ? ["choice", "puzzle"] : [s.active.stage];
    return points.some(p => p.eligible && p.commitSha === head && p.validation.status === "passed" &&
      p.planVersion === s.planVersion && domains.some(d => p.workItem === "interactive-" + d + "-" + s.active!.milestone!.slice(10)));
  }
  if (["event", "composition", "focus"].includes(s.active.stage)) {
    const pending = await pendingNarrativeForResume(s, job);
    if (pending?.phase === "authored") return true;
    const head = await trustedHead(job);
    const id = s.active.stage === "focus" ? s.active.id : s.active.stage + "-" + s.active.milestone!.slice(10);
    return !!pending && pending.phase === "committed" &&
      (await inspectRecoveryCheckpoints(job)).some(p => p.eligible &&
        p.workItem === id && p.commitSha === head && p.planVersion === s.planVersion);
  }
  if (s.active.stage !== "foundations") return false;
  return inspectRecoverableCharacterWorldCommit(job);
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
  assignmentEvidence?: GenerationOperationRecovery["evidence"],
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
  if (assignmentEvidence?.assignmentFailure) {
    if (historicalSource || origin.operation !== "specialist-result" ||
        origin.assignmentId !== assignmentEvidence.assignmentId ||
        !await authenticateAssignmentFailure(job, assignmentEvidence, origin.sourceHeadSha)) return false;
    return authenticateOriginalFailure(job, request, graphThreadId, origin, evidence, true);
  }
  return authenticateOriginalFailure(job, request, graphThreadId, origin, evidence);
}
function assignmentFailureEvidence(state: RecoveryState, origin: RecoveryOrigin) {
  const source = state.recoverySources.find(x => x.caseId === state.recoveryLifecycle.active?.id &&
    x.channel === "operationRecovery");
  const op = source?.input as GenerationOperationRecovery | undefined;
  return op?.operation === origin.operation && (op.evidence.assignmentId ?? null) === origin.assignmentId
    ? op.evidence : undefined;
}
async function recoverySourceHead(job: JobStartResult, state: RecoveryState, origin: RecoveryOrigin) {
  const evidence = assignmentFailureEvidence(state, origin);
  if (evidence?.assignmentFailure)
    return await authenticateAssignmentFailure(job, evidence, origin.sourceHeadSha) ? origin.sourceHeadSha : null;
  if (origin.operation === "independent-review" && usesSharedAssignmentReview(origin.assignmentId) &&
      await (await import("./rejected-review-repair.js")).authenticateFoundationReviewHead(job, origin.sourceHeadSha))
    return origin.sourceHeadSha;
  return trustedHead(job);
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
    // Authenticate before *any* node can run an effect, including a pending
    // child/parent task resumed directly from SQLite rather than via START.
    try {
      if (!state.request) throw Error("Missing Generation request.");
      if (state.inventory && state.inventory.invalidationVersion !== 1)
        throw Error("Obsolete Generation inventory cannot authorize execution.");
      if (state.request.fixture !== true || state.request.turnPlanDigest !== undefined ||
          state.request.orchestrationPolicy !== undefined &&
          state.request.orchestrationPolicy !== "explicit" && state.request.orchestrationPolicy !== "fixture-test")
        await requireGenerationTurn(await openJob(state), state.request, !!state.graphThreadId);
    } catch (error) {
      return { status: "blocked", reason: error instanceof Error ? error.message : String(error),
        recoveryLifecycle: admitRecovery(prior.recoveryLifecycle, { outcome: "fenced",
          fence: inspectionFence("untrusted-source", {}, [], null,
            "Inspect the original Turn receipt; obsolete Generation execution cannot resume.") }) };
    }
    try { assertRecoverySources(prior); }
    catch {
      return { status: "blocked", reason: "Recovery source inputs are missing or contradictory.",
        recoveryLifecycle: admitRecovery(prior.recoveryLifecycle, { outcome: "fenced",
          fence: inspectionFence("untrusted-receipt", {}, [], null,
            "Restore original recovery source receipts; never replay an uncertain writer.") }) };
    }
    if (prior.recoveryLifecycle.inspectionFences.length)
      return { status: "blocked", reason: state.reason ?? "Original recovery requires inspection.", recoveryLifecycle: prior.recoveryLifecycle };
    if (prior.recoveryLifecycle.decision?.action === "diagnostic-stop" ||
        prior.recoveryLifecycle.decision?.action === "exhausted" &&
        !!prior.recoveryLifecycle.active && (prior.recoveryLifecycle.decision.reviewAssessment ||
          prior.recoveryLifecycle.active.origin.operation === "independent-review" && prior.recoveryLifecycle.decision.reason === "protocol-exhausted" ||
          assignmentFailureEvidence(prior, prior.recoveryLifecycle.active.origin)?.assignmentFailure ||
          assignmentFailureEvidence(prior, prior.recoveryLifecycle.active.origin)?.protocolFailure)) {
      const active = prior.recoveryLifecycle.active;
      try {
        const job = await openJob(state);
        const thread = config.configurable?.thread_id;
        if (!active || typeof thread !== "string" ||
            await recoverySourceHead(job, prior, active.origin) !== active.origin.sourceHeadSha ||
            !await authenticateRecoveryOrigin(job, state.request, thread,
              active.origin, active.evidence, false, assignmentFailureEvidence(prior, active.origin)) ||
            !(prior.recoveryLifecycle.decision?.action === "exhausted"
              ? prior.recoveryLifecycle.decision.reviewAssessment
                ? await (await import("./generation-operation-strategy.js")).authenticateFoundationReviewExhaustion(job, state as State, active, prior.recoveryLifecycle.decision)
                : isDeepStrictEqual(prior.recoveryLifecycle.decision, await selectOperationStrategy(job, state as State, active))
              : await authenticateSealedDiagnosticStop(job, state as State, prior.recoveryLifecycle)))
          throw Error("Original diagnostic or invocation receipt is no longer authenticated.");
        return { status: "blocked", reason: state.reason ?? "Original authenticated recovery remains unresolved; inspect its terminal receipt.",
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
    if (node === "schedule" && prior.recoveryLifecycle.phase === "paused" &&
        prior.recoveryLifecycle.decision?.action === "pause" &&
        foundationDiagnosticDecisionForLifecycle(prior.recoveryLifecycle)) {
      const c = prior.recoveryLifecycle.active!;
      const d = foundationDiagnosticDecisionForLifecycle(prior.recoveryLifecycle)!;
      try {
        const job = await openJob(state);
        const source = prior.recoverySources.find(x => x.caseId === c.id && x.channel === "operationRecovery");
        const control = await readJobControl(job);
        if (control !== "running")
          return { status: control, reason: "Author control precedes original diagnostic resumption.", recoveryLifecycle: prior.recoveryLifecycle };
        if (!source || config.configurable?.thread_id !== c.origin.graphThreadId ||
            !await authenticateFoundationDiagnosticDecision(job, c, source.input as unknown as GenerationOperationRecovery,
              d, prior.recoveryLifecycle.attempt) ||
            !await authenticateOriginalFailure(job, state.request, c.origin.graphThreadId, c.origin, c.evidence, true))
          throw Error("Paused diagnostic successor lost its exact original authorization");
        return { status: "running", reason: null, recoveryLifecycle: {
          ...decideRecovery(resumePausedRecovery(prior.recoveryLifecycle, true), d), assessorPending: true } };
      } catch {
        return { status: "blocked", reason: "Paused diagnostic successor requires original receipt inspection.",
          recoveryLifecycle: { ...admitRecovery(prior.recoveryLifecycle, { outcome: "fenced",
            fence: inspectionFence("untrusted-receipt", c.origin, c.evidence, c.evidence[0]!,
              "Reconcile the original diagnostic and writer receipts before resumption.") }), assessorPending: false } };
      }
    }
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
            await recoverySourceHead(job, prior, active.origin) === active.origin.sourceHeadSha &&
            await authenticateRecoveryOrigin(job, state.request, graphThreadId,
              active.origin, active.evidence, false, assignmentFailureEvidence(prior, active.origin))) {
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
          for (const pending of prior.recoveryLifecycle.pending.filter(item =>
            prior.recoveryLifecycle.deferredCaseIds?.includes(item.id))) {
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
        // Do not short-circuit the parent boundary: after a discharge the
        // next authorized assignment and any queued author update must still
        // be reconciled before choosing a graph edge.
        const selected = selectPendingRecovery(lifecycle, item => !lifecycle.deferredCaseIds?.includes(item.id));
        if (selected.active)
          return { recoveryLifecycle: selected, status: "running", reason: null };
        prior = { ...prior, recoveryLifecycle: selected };
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
        if (typeof graphThread !== "string" || await recoverySourceHead(job, prior, active.origin) !== active.origin.sourceHeadSha ||
            !await authenticateRecoveryOrigin(job, state.request, graphThread, active.origin, active.evidence,
              false, assignmentFailureEvidence(prior, active.origin)))
          throw Error("Original failure source no longer matches the selected Turn and current HEAD.");
        const strategy = prior.recoverySources.some(x => x.caseId === active.id && x.channel === "operationRecovery")
          ? await withStoryJobLock(job, "assess-source-bound-operation", () => selectOperationStrategy(job, state, active)) : null;
        const selected = strategy ? decideRecovery(prior.recoveryLifecycle, strategy) : decideExistingRecovery(prior);
        const terminal = strategy?.action === "exhausted" || strategy?.action === "integrity-fence";
        return { recoveryLifecycle: { ...selected, assessorPending: !terminal },
          status: terminal ? "blocked" : "running",
          ...(terminal ? { reason: strategy.action === "exhausted"
            ? "Original response protocol exhausted; its invocation and source are preserved."
            : strategy.requiredInspection } : {}) };
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
    if (node === "assess_recovery" && prior.recoveryLifecycle.assessorPending &&
        prior.recoveryLifecycle.decision?.action === "known-correction" &&
        prior.recoveryLifecycle.decision.adapter === "assignment-diagnostic")
      return execute({ ...state, ...prior, ...projectRecovery(prior) } as State, config) as Promise<Partial<CoreState>>;
    const local = { ...state, ...prior, ...projectRecovery(prior) } as State;
    const outcome = await observeNodeOutcome(node, local, config, execute);
    if (node === "independent_assignment_review" &&
        (outcome.reviewAssessmentRequested || outcome.reviewPauseReason)) {
      const active = prior.recoveryLifecycle.active;
      const decision = prior.recoveryLifecycle.decision;
      const job = await openJob(local);
      try {
      const { authenticateOperationReviewProof } = await import("./generation-operation-strategy.js");
      const { inspectFoundationReviewBoundary, authenticateFoundationReviewHead, inspectNativeReviewFailure } = await import("./rejected-review-repair.js");
      if (!active || !usesSharedAssignmentReview(active.origin.assignmentId) ||
          decision?.action !== "known-correction" || decision.adapter !== "review-cycle" ||
          !await authenticateOperationReviewProof(job, local, active, decision) ||
          !await authenticateFoundationReviewHead(job, active.origin.sourceHeadSha))
        throw Error("Foundation Review handoff lost its original admitted source.");
      if (outcome.reviewPauseReason) {
        return { status: outcome.status, reason: outcome.reason,
          recoveryLifecycle: { ...decideRecovery(prior.recoveryLifecycle, {
            schema: "noveltea-generation-recovery-decision/v1", caseId: active.id,
            checkedSourceHeadSha: active.origin.sourceHeadSha, evidence: decision.evidence,
            action: "pause", reason: outcome.reviewPauseReason, resumeRef: decision.receipt,
          }), assessorPending: false } };
      }
      if (!await inspectFoundationReviewBoundary(job, active.origin.sourceHeadSha) &&
          !await inspectNativeReviewFailure(job, active.origin.sourceHeadSha, active.id))
        throw Error("Foundation Review handoff has no authenticated reassessment boundary.");
      return { status: "running", reason: outcome.reason,
        recoveryLifecycle: { ...prior.recoveryLifecycle, assessorPending: true } };
      } catch (error) {
        return { status: "blocked", reason: error instanceof Error ? error.message : String(error),
          recoveryLifecycle: admitRecovery(prior.recoveryLifecycle, { outcome: "fenced",
            fence: inspectionFence("untrusted-receipt", active?.origin ?? {}, active?.evidence ?? [],
              active ? { store: active.origin.failureAnchor.store, ref: active.origin.failureAnchor.ref } : null,
              "Authenticate the original Foundation Review handoff before continuing.") }) };
      }
    }
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
      authenticateRecoveryOrigin(job, local.request, graphThreadId, origin, evidence, false,
        domain.operationRecovery?.operation === origin.operation && (domain.operationRecovery.evidence.assignmentId ?? null) === origin.assignmentId
          ? domain.operationRecovery.evidence : assignmentFailureEvidence(prior, origin));
    const current = prior.recoveryLifecycle.active;
    const assurance: { originalEffect?: RecoveryEvidence;
      verifiedHead?: string; verifiedReceipt?: RecoveryEvidence;
      authorControl?: "paused" | "cancelled";
      diagnosis?: { recommendation: "operator-intervention" | "inspect-existing-receipt";
        advisoryCategory: "software" | "unclassified" | "resources" | "integrity";
        receipt: RecoveryEvidence } } = {};
    if (current && node === "independent_assignment_review" && domain.operationRecovery === null &&
        prior.recoveryLifecycle.phase === "correcting" &&
        current.origin.operation === "independent-review" &&
        prior.recoveryLifecycle.decision?.action === "known-correction" &&
        prior.recoveryLifecycle.decision.adapter === "review-cycle") {
      const { authenticateOperationReviewProof } = await import("./generation-operation-strategy.js");
      const { verifyReviewCycleSuccessor } = await import("./generation-recovery-resolution.js");
      const head = await trustedHead(job);
      if (await authenticateOperationReviewProof(job, local, current, prior.recoveryLifecycle.decision) &&
          await verifyReviewCycleSuccessor(job, current.origin.sourceHeadSha, head)) {
        assurance.verifiedHead = head;
        assurance.verifiedReceipt = { store: "review-checkpoint", ref: head };
      }
    }
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
                await authorizeOperationDiagnosticStrategy(job, state as State, current, original, proposal)) ||
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
          } else if (current.origin.operation === "adaptive-admission") {
            const accepted = await inspectSettledAdaptiveReconciliation(job, state.request, current.origin);
            if (!accepted || !isDeepStrictEqual(accepted.receipt, original.evidence.at(-1)) ||
                rest.adaptiveVersion !== accepted.version ||
                (rest.inventory as State["inventory"])?.headSha !== head ||
                rest.planVersion !== current.origin.planVersion)
              throw Error("Original adaptive reconciliation has no verified restored inventory");
            receipt = accepted.receipt;
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
            (["foundation", "foundations", "interactive", "choice", "puzzle", "event", "composition", "focus"].includes(s.active.stage)) &&
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
        // The first handoff checkpoint is also an author boundary: don't
        // dispatch an objective planner before durable author controls and
        // pending protected updates have been reconciled on the same job.
        if (request.discoveryHandoffDigest && !s.graphThreadId) {
          await requireGenerationTurn(job, request);
          const stopped = await withStoryJobLock(job, "generation-boundary",
            () => authorBoundary(job, { ...s, request } as State));
          if (stopped) return stopped;
        }
        // The trusted controller selects a METHOD, not a worker or write grant.
        // Every real Turn uses the pinned method; only isolated fixture
        // transports may omit model planning.
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
        } else if (!request.fixture || request.orchestrationPolicy === "explicit") {
          const checkout = request.skillsSource ?? process.env.NT_STUDIO_SKILLS_SOURCE ??
            (await loadSkillConfig()).novelteaSkills;
          if (!checkout) throw new Error(
            "Explicit Studio orchestration requires a trusted NovelTea skills checkout; " +
            "nt-story-generate cannot be substituted.");
          selection = await selectStoryOrchestrator(job, graphThreadId, sourceIdentity, checkout);
          orchestratorSnapshotId = selection.receipt.skillSnapshot.id;
        }
        if (s.orchestratorSnapshotId && orchestratorSnapshotId !== s.orchestratorSnapshotId)
          throw new Error("Pinned orchestrator snapshot changed during generation resume.");
        let orchestratorOrder: string[] | null = null;
        let orchestratorPlanningDigest: string | null = null;
        if (selection && request.turnPlanDigest && !request.fixture) {
          const plan = await readTurnEvidence(job, request.contract, request.task, request.turnPlanDigest);
          if (!plan) throw new Error("A selected objective lacks the controller's pinned Turn plan.");
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
      if (s.recoveryLifecycle.decision?.action === "known-correction" &&
          s.recoveryLifecycle.decision.adapter === "assignment-diagnostic")
        return runFoundationDiagnosticRecovery(s, config, reviewBoundary);
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
        if (op.operation === "adaptive-admission" && op.outcome === "exception" &&
            s.recoveryLifecycle.decision?.action === "reconcile-effects" &&
            s.recoveryLifecycle.attempt?.purpose === "diagnosis" &&
            s.recoveryLifecycle.attempt.phase === "settled") {
          try {
            return await withStoryJobLock(job, "generation-adaptive-reconciliation", async () => {
              clean(job);
              const current = s.recoveryLifecycle.active;
              const decision = s.recoveryLifecycle.decision;
              if (!current || decision?.action !== "reconcile-effects" ||
                  await trustedHead(job) !== current.origin.sourceHeadSha)
                throw Error("Original adaptive source changed");
              const original = await selectOperationStrategy(job, s, current);
              if (original?.action !== "diagnostic") throw Error("Original adaptive diagnosis is no longer eligible");
              const target = diagnosticCaseForDecision(current, original);
              const proposal = await inspectOriginalUnknownDiagnosis(job, target);
              if (!("strategy" in proposal) || !isDeepStrictEqual(decision,
                  await authorizeOperationDiagnosticStrategy(job, s, current, original, proposal)) ||
                  !isDeepStrictEqual(s.recoveryLifecycle.attempt, await inspectDiagnosticAttempt(job, target, current.id)))
                throw Error("Original adaptive diagnosis or authorization changed");
              const accepted = await inspectSettledAdaptiveReconciliation(job, s.request, current.origin);
              if (!accepted || process.env.NT_ADAPTIVE_PLANNING !== "1")
                throw Error("Original adaptive planner has no eligible accepted effect");
              // Rebuild the inventory from the original native source and
              // sealed amendment. The false flag forbids new planner calls.
              const next = await reconcile(s, job, false);
              if (next.operationRecovery || next.recovery || next.escalation ||
                  next.status === "blocked" || next.status === "paused" ||
                  next.adaptiveVersion !== accepted.version ||
                  next.planVersion !== current.origin.planVersion ||
                  next.inventory?.headSha !== current.origin.sourceHeadSha)
                throw Error("Original adaptive plan cannot be restored");
              return { ...next, status: "running" as const, reason: null, operationRecovery: null };
            });
          } catch (error) {
            return fence("Adaptive reconciliation remains unresolved: " +
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
          // A pending original Foundation invocation may have a dirty,
          // unverified draft. Only its existing child is allowed to reconcile
          // that effect; no author edits or new assignment can run here.
          if (!s.result && s.inventory && (s.active?.stage === "foundation" &&
              await inspectPendingFoundationInvocation(job, s.inventory.headSha) ||
              s.active?.stage === "architecture" &&
              (await (await import("./architecture.js")).inspectPendingArchitectureInvocation(job, s.inventory.headSha) ||
               await (await import("./architecture.js")).inspectRecoverableArchitectureCommit(job, s.inventory.headSha)) ||
              s.active?.stage === "foundations" &&
              (await inspectPendingCharacterWorldInvocation(job, s.inventory.headSha) ||
               await inspectRecoverableCharacterWorldCommit(job) && !await trustedHead(job).catch(() => null)) ||
               await pendingInteractiveForResume(s, job) || await pendingNarrativeForResume(s, job))) {
            await checkPlan(job, s.request, s.planVersion);
            const control = await readJobControl(job);
            if (control !== "running") return { status: control === "cancelled" ? "cancelled" : "paused",
              reason: "Author control precedes original assignment reconciliation." };
            return { status: "running" as const, reason: null };
          }
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
            if (["foundation", "architecture", "interactive", "choice", "puzzle", "event", "composition", "focus"].includes(s.active.stage) &&
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
      const fixture = s.request.fixture && process.env.NT_LIVE_GENERATION_IDEA === "1"
        ? false : s.request.fixture;
      let reconciling = false;
      let resuming = false;
      try {
        // External Git and Pi effects cannot be replayed merely because the
        // LangGraph checkpoint was interrupted. A private receipt fences repeats.
        if (existsSync(file)) {
          const saved = JSON.parse(await readFile(file, "utf8")) as {
            jobId: string; task: IdeaTask; phase: string; result?: IdeaResult; effectContract?: string; effectPhase?: string;
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
            if (saved.phase !== "running" || saved.effectContract !== "idea-protocol.v1" ||
                !["prepared", "read-only"].includes(saved.effectPhase ?? "") || fixture)
              throw new Error("Interrupted automated idea selection/writer; inspect its Pi session, placement receipt and Git worktree before manual reconciliation.");
            // Reenter only the original clean-source task. The placement adapter
            // reconstructs a sealed read-only result, never repeats a started writer.
            resuming = true;
            reconciling = saved.effectPhase === "read-only";
          }
          if (!resuming && saved.phase !== "verified")
            throw new Error("Previous automated idea dispatch has not been verified; reconcile it manually.");
        }
        if (await trustedHead(job) !== task.priorHead) throw new Error("Idea selection's verified Git base changed.");
        if (!resuming) await persist(file, { jobId: job.jobId, task, phase: "running",
          ...(!fixture ? { effectContract: "idea-protocol.v1", effectPhase: "prepared" } : {}) });
        const result = await runIdeaPlacement({ ...s.request,
          // Opt-in integration evaluation uses real pinned Pi placement.
          fixture, expectedHead: task.priorHead,
          reconcileReadOnly: reconciling,
          beforeRead: fixture ? undefined : () => persist(file, { jobId: job.jobId, task,
            phase: "running", effectContract: "idea-protocol.v1", effectPhase: "read-only" }),
          beforeWrite: fixture ? undefined : () => persist(file, { jobId: job.jobId, task,
            phase: "running", effectContract: "idea-protocol.v1", effectPhase: "writer" }),
          action: task.action, id: task.id,
          ...(task.action === "place" ? { autoSelect: true } : { record: true }) }) as IdeaResult;
        await persist(file, { jobId: job.jobId, task, phase: "returned", result });
        return { ideaResult: result };
      } catch (error) {
        if (error instanceof ProtocolExhaustedError && error.proof && existsSync(file)) {
          const saved = JSON.parse(await readFile(file, "utf8"));
          if (saved.jobId === job.jobId && saved.phase === "running" &&
              isDeepStrictEqual(saved.task, task))
            await persist(file, { ...saved, protocolFailure: error.proof });
        }
        return operationFailure(s, job, "idea-integration", error,
          { reference: "generation-idea-dispatch", ideaId: task.id, action: task.action,
            signature: task.signature, priorHead: task.priorHead });
      }
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
    .addNode("specialist_dispatch", recoveryNode("specialist_dispatch", async (s, config) => {
      if (s.crossDomainCloseout || s.reviewPrerequisite || s.focusedPrerequisite &&
          (s.active?.stage !== "focus" || s.active.id !== s.focusedPrerequisite.identity.assignmentId))
        throw Error("Unassessed prerequisite cannot authorize specialist dispatch.");
      // Every admitted Foundation assignment uses the shared child. A missing
      // production Turn proof is fenced by the common execution boundary.
      if (s.active?.stage === "foundation" && !s.result) {
        try { return await runFoundationAssignmentChild(s, config, reviewBoundary); }
        catch (error) {
          if (!(error instanceof ProtocolIntegrityBlockedError)) throw error;
          return operationFailure(s, await openJob(s), "specialist-dispatch", error,
            { reference: "specialist-receipt", assignmentId: s.active.id });
        }
      }
      // A saved dispatch result means the external stage completed before a parent
      // verification checkpoint. Otherwise the stage API reconciles its receipt,
      // including a commit published before its receipt; never invent a new writer.
      if (s.result) return {};
      try {
        if (s.active?.stage === "architecture")
          return await runArchitectureAssignmentChild(s, config, reviewBoundary);
        if (s.active?.stage === "foundations")
          return await runCharacterWorldAssignmentChild(s, config, reviewBoundary);
        if (s.active?.stage === "focus" && s.request.turnPlanDigest)
          return runFocusedAssignmentChild(s, config, reviewBoundary);
        let result;
        if (s.active && ["interactive", "choice", "puzzle"].includes(s.active.stage)) {
          const child = await runInteractiveAssignmentChildren(s, config, reviewBoundary);
          if (!child.result || child.status || child.operationRecovery || child.reviewAssessmentRequested ||
              child.reviewSteeringHandoff || child.escalation || child.reviewDependencyRequest || child.result.status === "review-handoff") return child;
          result = child.result;
        } else if (s.active && ["event", "composition", "focus"].includes(s.active.stage)) {
          const child = await runNarrativeAssignmentChild(s, config, reviewBoundary);
          if (!child.result || child.status || child.operationRecovery || child.reviewAssessmentRequested ||
              child.reviewSteeringHandoff || child.escalation || child.reviewDependencyRequest) return child;
          result = child.result;
        } else result = await dispatch(s);
        if (result.status === "interactive-conflict-reported") {
          const evidence = result as typeof result & { prerequisite?: {
            milestoneId: string; expectedHead: string; reportDigest: string; domain: string };
            conflicts?: string[]; obligations?: string[] };
          const report = evidence.prerequisite;
          if (!report || report.domain !== "choice" && report.domain !== "puzzle" ||
              s.active?.stage !== report.domain && s.active?.stage !== "interactive" ||
              !s.active.milestone || s.active.milestone !== report.milestoneId ||
              s.active.id !== report.domain + ":" + report.milestoneId &&
              s.active.id !== "interactive:" + report.milestoneId ||
              !/^[0-9a-f]{64}$/.test(report.reportDigest) ||
              !evidence.conflicts?.length)
            throw Error("Interactive negative result lacks its original bounded assignment and report");
          const job = await openJob(s);
          const { inspectInteractiveConflict } = await import("./interactive-work.js");
          const original = await inspectInteractiveConflict(job, report.milestoneId);
          if (original.domain !== report.domain || original.expectedHead !== report.expectedHead ||
              original.reportDigest !== report.reportDigest ||
              original.worker !== (s.request.fixture ? "fixture" : "pi") ||
              original.planVersion !== s.planVersion ||
              JSON.stringify(original.conflicts) !== JSON.stringify(evidence.conflicts) ||
              JSON.stringify(original.obligations) !== JSON.stringify(evidence.obligations))
            throw Error("Interactive contradiction no longer matches its sealed Pi source");
          const failure = "Original " + original.domain + " returned a settled no-write architectural contradiction: " +
            original.conflicts.join("; ") + ". Deferred obligations: " +
            original.obligations.join("; ") +
            ". Controller-owned Repair must inspect the original Blueprint and assignment before authorizing another owner.";
          const assessment = await operationFailure(s, job, "specialist-result", failure,
            { reference: "specialist-receipt", assignmentId: s.active.id,
              resultStatus: result.status, interactiveNoWrite: {
                milestoneId: report.milestoneId, expectedHead: report.expectedHead,
                reportDigest: report.reportDigest, domain: original.domain } }, "returned-failure");
          return { ...assessment, failures: { ...s.failures, [s.active.id]: failure },
            inventory: blockedAssignmentInventory(s, failure), active: null, result: null,
            escalation: { kind: "dependency-replan" as const, requiresTrustedApproval: false,
              sources: original.conflicts.slice(0, 8).map(message => ({
                source: report.milestoneId + "@" + report.expectedHead,
                message, repair: "controller-plan-review" })),
              action: "Independently review the original approved Milestone Blueprint, " +
                "Interactive assignment and sealed negative Pi report. Propose a separate, " +
                "source-authenticated owner/plan amendment if warranted; no replacement " +
                "Interactive writer, protected decision or new specialist scope is authorized." } };
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
            const child = await runNarrativeAssignmentChild(s, config, reviewBoundary, false,
              { reportDigest: route.reportDigest,
                sourceSha: evidence.prerequisite.expectedHead, task: route.task });
            if (!child.result || child.status || child.operationRecovery || child.reviewAssessmentRequested ||
                child.reviewSteeringHandoff || child.escalation || child.reviewDependencyRequest ||
                child.result.status !== "event-prerequisite-reported") return child;
            result = child.result;
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
        if (isGraphBubbleUp(error)) throw error;
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
            if (!sameHead && ["foundation", "foundations", "interactive", "choice", "puzzle", "event", "composition", "focus"].includes(s.active?.stage ?? ""))
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
    .addNode("dependency_amendment", recoveryNode("dependency_amendment", async (s, config) => {
      try {
        const job = await openJob(s);
        const stopped = await withStoryJobLock(job, "dependency-author-boundary", () => authorBoundary(job, s));
        if (stopped) return { ...stopped, result: s.result };
        if (s.reviewPrerequisite) {
          const { request, pin } = await authenticatedReviewPrerequisite(s, config);
          const { advanceReviewDependency, inspectReviewSupport } = await import("./dependency-work.js");
          await advanceReviewDependency({ ...s.request, turnPlanDigest: request.turnDigest, request }, config);
          const supported = await inspectReviewSupport(job, request);
          if (supported.entry.amendment?.assignment.specialist !== pin.suspension.owner)
            throw Error("Supporting Review assignment has the wrong owner.");
          return { reviewPrerequisite: { ...pin, supportRef: supported.ref } };
        }
        if (s.active?.stage !== "focus" || !s.active.milestone)
          throw Error("Dependency amendment is not bound to a focused assignment.");
        const pin = s.focusedPrerequisite;
        if (!pin || pin.identity.assignmentId !== s.active.id || pin.identity.planVersion !== s.planVersion ||
            pin.identity.turnDigest !== s.request.turnPlanDigest || pin.identity.jobId !== job.jobId ||
            pin.identity.jobThreadId !== job.threadId ||
            pin.identity.graphThreadId !== config.configurable?.thread_id)
          throw Error("Dependency amendment has no checkpointed original assignment suspension.");
        const original = await inspectFocusedPrerequisite(job, s.active.milestone,
          s.request.turnPlanDigest!, s.request.fixture, s.planVersion!);
        const { status: _status, verifiedSha: _sha, blockingReason: _reason, ...scope } = s.active;
        if (!original || original.phase !== "waiting-dependency" ||
            original.report.sourceSha !== pin.identity.sourceHeadSha ||
            pin.identity.scopeDigest !== dependencyDigest({ scope, task: s.request.task, contract: s.request.contract }) ||
            dependencyDigest(original.seal) !== pin.suspension.suspensionRef ||
            original.seal.reportDigest !== pin.suspension.evidenceRef ||
            pin.suspension.scopeRef !== original.seal.reportDigest ||
            pin.suspension.owner !== original.report.likelySpecialist || pin.suspension.pendingPhase !== "writer" ||
            pin.suspension.assignmentKey !== logicalAssignmentKey(pin.identity))
          throw Error("Dependency amendment lost the original sealed no-write report.");
        const resolved = await advanceFocusedDependency({ ...s.request, target: s.active.milestone }, config);
        const entry = (await inspectDependencyPlan(job))?.entries.find(e => e.reportDigest === resolved.reportDigest);
        if (!entry || entry.phase !== "verified") throw Error("Dependency amendment lost its completion evidence.");
        return { result: null, focusedPrerequisite: { ...pin, supportRef: dependencyDigest(entry) },
          dependencyHistory: [...(s.dependencyHistory ?? []).filter(p =>
          p.reportDigest !== entry.reportDigest), { reportDigest: entry.reportDigest, entryDigest: dependencyDigest(entry) }] };
      } catch (error) {
        const stop = blocked(error);
        if (stop.status !== "blocked") return { ...stop, result: s.result };
        // The original negative Review already owns the active RecoveryCase.
        // A failed support effect cannot replace it or start an assessor loop.
        // The shared observation boundary fences the exact failed support task.
        if (s.reviewPrerequisite) throw error;
        return operationFailure(s, await openJob(s), "dependency-amendment", error,
          { reference: "dependency-plan", assignmentId: s.active?.id });
      }
    }))
    .addNode("independent_assignment_review", recoveryNode("independent_assignment_review", async (s, config) => {
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
      let reviewed: Partial<State>;
      if (s.reviewPrerequisite) {
        const { request, pin } = await authenticatedReviewPrerequisite(s, config);
        reviewed = await runReviewPrerequisiteChild(s, config, request, pin);
      } else {
        // A crash after recording the original request but before the parent
        // checkpoint must recover the returned-END suspension, not the writer.
        const job = correction ? await openJob(s) : null;
        const originalRequest = job && (await inspectDependencyPlan(job))?.reviewRequests?.find(r =>
          r.sourceSha === selected.active?.origin.sourceHeadSha &&
          r.action === "controller-amendment-required");
        reviewed = originalRequest ? { reviewDependencyRequest: originalRequest } :
          correction && s.active?.stage === "architecture"
            ? await runArchitectureAssignmentChild(s, config, reviewBoundary, true)
            : correction && s.active?.stage === "foundation"
            ? await runFoundationAssignmentChild(s, config, reviewBoundary, true)
            : correction && s.active?.stage === "foundations"
              ? await runCharacterWorldAssignmentChild(s, config, reviewBoundary, true)
              : correction && s.active && ["interactive", "choice", "puzzle"].includes(s.active.stage)
                ? await runInteractiveAssignmentChildren(s, config, reviewBoundary, true)
                : correction && s.active && ["event", "composition", "focus"].includes(s.active.stage)
                  ? await runNarrativeAssignmentChild(s, config, reviewBoundary, true)
                  : await reviewBoundary(s, correction);
        if (reviewed.reviewDependencyRequest) {
          const request = reviewed.reviewDependencyRequest;
          return runReviewPrerequisiteChild(s, config, request,
            await reviewPrerequisiteIdentity(s, config, request));
        }
      }
      if (correction) {
        if (reviewed.reviewAssessmentRequested) return reviewed;
        if (reviewed.reviewSteeringHandoff)
          return reviewed; // Preserve original Review-to-author intake boundary.
        if (reviewed.status === "paused" || reviewed.status === "cancelled" ||
            reviewed.status === "blocked")
          return reviewed; // Retain original correction decision and receipts.
        const job = await openJob(s);
        const head = await trustedHead(job);
        const { verifyReviewCycleSuccessor } = await import("./generation-recovery-resolution.js");
        if (!await verifyReviewCycleSuccessor(job, selected.active!.origin.sourceHeadSha, head))
          return { status: "blocked" as const,
            reason: "Original failed independent Review has no independently passing corrective successor." };
        return { ...reviewed, operationRecovery: null, status: "running" as const, reason: null };
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
              if (stage !== "foundations") {
                const points = (await inspectRecoveryCheckpoints(job)).filter(p => p.eligible);
                const point = points.find(p => p.commitSha === s.result!.headSha &&
                  p.workItem.startsWith("interactive-"));
                const reviews = await resolvedCheckpointReviews(job, points);
                if (!point || point.assurance && !["passed", "not-required"].includes(reviews.get(point.commitSha) ?? point.semanticReview))
                  throw new IndependentReviewGateError("Original Interactive subunit Review is pending.");
              }
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
      routeAfterOperationAssessment(s, "author_update_intake"),
      [END, "assess_recovery", "author_update_intake"])
    .addConditionalEdges("author_update_intake", s => routeAfterOperationAssessment(s,
      s.status !== "running" ? END :
      s.ideaTask ? "idea_integration" :
      s.reviewPrerequisite && !s.reviewPrerequisite.supportRef ||
        s.result?.status === "dependency-required" ? "dependency_amendment" :
      s.active && s.result && s.recoveryLifecycle.active?.origin.operation === "commit-verification" &&
        s.recoveryLifecycle.phase === "verifying" ? "verify_committed_work" :
      s.active && s.result ? "independent_assignment_review" :
      s.active ? "specialist_dispatch" : "completion_decision"), [END, "assess_recovery", "idea_integration", "dependency_amendment", "independent_assignment_review", "verify_committed_work", "specialist_dispatch", "completion_decision"])
    .addConditionalEdges("idea_integration", s => routeAfterOperationAssessment(s,
      s.status !== "running" ? END : "verify_idea_integration"), [END, "assess_recovery", "verify_idea_integration"])
    .addConditionalEdges("verify_idea_integration", s => routeAfterOperationAssessment(s,
      s.status !== "running" ? END : "author_update_intake"), [END, "assess_recovery", "author_update_intake"])
    .addConditionalEdges("specialist_dispatch", s => routeAfterOperationAssessment(s,
      s.status !== "running" ? END :
      s.result?.status === "dependency-required" ? "dependency_amendment" :
      s.active && (s.result || s.active.stage !== "foundations") ? "independent_assignment_review" : "author_update_intake"), [END, "assess_recovery", "dependency_amendment", "independent_assignment_review", "author_update_intake"])
    .addConditionalEdges("dependency_amendment", s => routeAfterOperationAssessment(s,
      s.status !== "running" ? END : "author_update_intake"), [END, "assess_recovery", "author_update_intake"])
    .addConditionalEdges("independent_assignment_review", s => routeAfterOperationAssessment(s,
      s.status !== "running" ? END :
      s.reviewPrerequisite && !s.reviewPrerequisite.supportRef ? "dependency_amendment" :
      s.reviewSteeringHandoff ? "author_update_intake" :
      s.result ? "verify_committed_work" : s.active && ["foundations", "interactive"].includes(s.active.stage) ? "author_update_intake" : "specialist_dispatch"), [END, "assess_recovery", "dependency_amendment", "author_update_intake", "verify_committed_work", "specialist_dispatch"])
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
      let pendingQuestion = await pendingGenerationQuestion(job, saver, saved, config.configurable.thread_id, "user:cli");
      if (options.answer && (options.action !== "resume" || pendingQuestion?.phase !== "interrupt"))
        throw Error("An answer requires the original pending Generation question.");
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
        const contract = parseGenerationContract(options.contract);
        const turn = await readTurnEvidence(job, contract, options.task);
        if (!options.fixture && !turn)
          throw Error("Generation start requires a prepared authenticated Turn plan; obsolete unplanned CLI execution is not supported.");
        const request: GenerationRequest = { story: job.storyRoot, job: job.jobId, task: options.task,
          contract, fixture: options.fixture ?? false,
          ...(turn ? { turnPlanDigest: turn.digest } : {}),
          skillsSource: options.skillsSource, validatorSource: options.validatorSource,
          provider: options.provider, model: options.model,
          orchestrationPolicy: options.fixture && !options.skillsSource ? "fixture-test" : "explicit" };
        state = { request, recoveryLifecycle: emptyRecoveryLifecycle(), recoverySources: [],
          recovery: null, unknownRecovery: null, operationRecovery: null, fixPickup: null,
          cursor: 0, completedStages: [], status: "running", reason: null,
          reviewSteeringHandoff: false, result: null, planVersion: null,
          pauseAfter: options.pauseAfter ?? null, inventory: null, active: null, failures: {},
          ideaTask: null, ideaResult: null, ideaHistory: [], escalation: null,
          orchestratorSnapshotId: null, orchestratorOrder: null, orchestratorPlanningDigest: null,
          pendingOrder: null, pendingVersion: null, graphThreadId: null, adaptiveVersion: null,
          dependencyHistory: [], focusedPrerequisite: null, reviewPrerequisite: null,
          crossDomainCloseout: null, causalAmendment: null };
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
      let answerBudgetPause: string | null = null;
      if (options.action !== "inspect") {
        try { await requireGenerationTurn(job, state.request, !!state.graphThreadId); }
        catch (error) { state = { ...state, ...blocked(error) }; preflightStopped = true; }
      }
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
      if (options.action === "resume" && !cancelled && !preflightStopped && !selectedCloseout && !pendingQuestion &&
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
          if (pendingQuestion && options.answer) {
            const answer = options.answer;
            if (answer.id !== pendingQuestion.choice.id ||
                answer.proposalSha256 !== pendingQuestion.choice.proposalSha256)
              throw Error("Answer does not identify the pending question.");
            await withStoryJobLock(job, "generation-author-answer", () =>
              answerSpecialistChoice(job, answer.id, answer.proposalSha256,
                parseAuthorAnswer(pendingQuestion!.choice.question, answer.answer, pendingQuestion!.choice.delegationAllowed === true),
                "user:cli"));
            pendingQuestion = await pendingGenerationQuestion(job, saver, saved, config.configurable.thread_id, "user:cli");
          }
          if (pendingQuestion && await readJobControl(job) === "running")
            answerBudgetPause = await pendingQuestionBudgetPause(job, pendingQuestion);
          const outcome = answerBudgetPause ? { ...state, status: "paused" as const, reason: answerBudgetPause } : pendingQuestion
            ? (pendingQuestion.phase === "continuation" || pendingQuestion.choice.phase === "answered") && await readJobControl(job) === "running"
              ? await graph.invoke(generationQuestionResume(pendingQuestion), config)
              : state
            : await graph.invoke({ ...state, pauseAfter: options.pauseAfter ?? null }, config);
          state = { ...outcome, ...projectRecovery({
            recoveryLifecycle: outcome.recoveryLifecycle,
            recoverySources: outcome.recoverySources,
          }) };
        }
      }
      pendingQuestion = await pendingGenerationQuestion(job, saver, await graph.getState(config),
        config.configurable.thread_id, "user:cli");
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
          pendingQuestion?.phase === "interrupt" ? { status: "paused", reason: "Specialist Author Question is pending." } :
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
      if (pendingQuestion?.phase === "interrupt" && !cancelled && !preflightStopped && !selectionFailure) {
        const budget = pendingQuestion.choice.phase === "answered" ? (await (await import("./job-pi-policy.js")).inspectPiPolicy(job)).budget : null;
        answerBudgetPause ??= budget?.pause ? "Pi budget exhausted at safe boundary: " + budget.pause.reason + ". Increase the job budget and resume." : null;
        current = { status: "paused", reason: answerBudgetPause ?? "Specialist Author Question is pending." };
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
        authorQuestion: !cancelled && !answerBudgetPause && pendingQuestion?.phase === "interrupt" ? {
          id: pendingQuestion.choice.id, proposalSha256: pendingQuestion.choice.proposalSha256,
          phase: pendingQuestion.choice.phase, question: pendingQuestion.choice.question,
          delegationAllowed: pendingQuestion.choice.delegationAllowed === true,
        } : null,
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
