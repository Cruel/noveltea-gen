/** Current-format generation recovery inspection and restart authentication.
 * Never upgrades historical checkpoint formats or grants writer authority.
 */
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { JobStartResult } from "./job.js";
import type { GenerationRequest, IdeaHistoryEntry } from "./generation.js";
import type { GenerationInventory } from "./generation-plan.js";
import { inspectActiveRecoveryResolution, inspectDeferredCorrection } from "./generation-recovery-resolution.js";
import { git as jobGit } from "./ideas.js";
import type { RecoveryDecision, RecoveryEvidence, RecoveryLifecycle, RecoveryOrigin } from "./generation-recovery-contract.js";
import { verifyRecoveryCheckpoint } from "./generation-recovery-lifecycle.js";
import {
  assertRecoverySources,
  projectRecovery,
  type RecoverySource,
  type RecoveryState,
} from "./generation-recovery-graph.js";
import { trustedHead } from "./revision.js";
import { readTurnEvidence } from "./turn-plan-evidence.js";
import { verifyPlanHistory } from "./architecture.js";
import { inspectRecoveryCheckpoints } from "./recovery-checkpoints.js";
import { verifyAdaptiveRecoveryProof, type AdaptiveRecovery } from "./adaptive-protocol.js";
import type { GenerationGraphState } from "./generation.js";
import { authenticateOperationDiagnosticProof, authenticateOperationOwnerProof, diagnosticCaseForDecision, matchesOriginalCloseout, selectOperationStrategy, authorizeOperationDiagnosticStrategy, authenticateAssignmentDiagnosticDecision, authenticateAssignmentDiagnosticDischarge, assignmentDiagnosticDecisionForLifecycle } from "./generation-operation-strategy.js";
import { inspectDiagnosticAttempt, inspectOriginalUnknownDiagnosis, type UnknownRecoveryCase } from "./unknown-recovery-diagnostic.js";
import { inspectBlockedOriginalThreadCorrection } from "./original-thread-continuation.js";
import { inspectInterruptedCloseoutCommit } from "./cross-domain-closeout-work.js";
import { originalInventorySnapshotDigest } from "./selective-revalidation.js";
import { independentObligation, authenticateAssignmentFailure, type GenerationOperationRecovery } from "./generation-operation-recovery.js";

const object = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);

export type GenerationRecoveryInspection = Readonly<{
  schema: "noveltea-generation-recovery-inspection/v1";
  /** Current execution state, projected without exposing Pi transcripts. */
  source: "current-lifecycle";
  phase: RecoveryLifecycle["phase"];
  active: null | Readonly<{
    caseId: string;
    kind: string;
    operation: string;
    check: string;
    effect: string;
  }>;
  pending: readonly Readonly<{ caseId: string; operation: string }>[];
  fences: readonly Readonly<{ reason: string; requiredInspection: string }>[];
}>;

export function projectRecoveryInspection(
  lifecycle: RecoveryLifecycle,
  source: GenerationRecoveryInspection["source"] = "current-lifecycle",
): GenerationRecoveryInspection {
  return {
    schema: "noveltea-generation-recovery-inspection/v1",
    source,
    phase: lifecycle.phase,
    active: lifecycle.active
      ? {
          caseId: lifecycle.active.id,
          kind: lifecycle.active.kind,
          operation: lifecycle.active.origin.operation,
          check: lifecycle.active.origin.check,
          effect: lifecycle.active.effect,
        }
      : null,
    pending: lifecycle.pending.map((item) => ({
      caseId: item.id,
      operation: item.origin.operation,
    })),
    fences: lifecycle.inspectionFences.map((f) => ({
      reason: f.reason,
      requiredInspection: f.requiredInspection,
    })),
  };
}

function cleanGitEnv() {
  const env = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"])
    delete env[name];
  return env;
}

export async function authenticateOriginalFailure(
  job: JobStartResult,
  request: GenerationRequest,
  graphThreadId: string,
  origin: RecoveryOrigin,
  evidence: readonly RecoveryEvidence[],
  authenticatedUnpublishedHead = false,
): Promise<boolean> {
  if (
    origin.jobId !== job.jobId ||
    origin.jobThreadId !== job.threadId ||
    origin.graphThreadId !== graphThreadId ||
    origin.turnDigest !== request.turnPlanDigest ||
    evidence.length !== 1 ||
    evidence[0]?.store !== "graph-checkpoint" ||
    evidence[0].ref !== origin.failureAnchor.ref ||
    origin.failureAnchor.store !== "graph-checkpoint" ||
    !origin.failureAnchor.ref.startsWith(graphThreadId + ":") ||
    !request.turnPlanDigest
  )
    return false;
  try {
    // A source that is neither HEAD nor an ancestor cannot be silently
    // reinterpreted as the pinned failed operation. This proves lineage only,
    // not that an uncertain child writer settled.
    // Only the selected cross-domain adapter or the exact settled original
    // Foundation failure may present an authenticated unpublished source.
    // The original writer/effect proof must be checked separately BEFORE
    // passing true here. This never makes a dirty draft a trusted revision.
    const current = authenticatedUnpublishedHead
      ? jobGit(job, "rev-parse", "HEAD") : await trustedHead(job);
    execFileSync("git", ["merge-base", "--is-ancestor", origin.sourceHeadSha, current], {
      cwd: job.worktreeRoot,
      env: cleanGitEnv(),
      stdio: "ignore",
    });
    await readTurnEvidence(job, request.contract, request.task, request.turnPlanDigest);
    // A plan version may be historical after a signed amendment. Existence
    // alone never transfers the old approval or grants a new attempt.
    if (origin.planVersion !== null) {
      const path = join(job.stateDir, "architecture.json");
      if (!existsSync(path)) return false;
      const receipt = JSON.parse(await readFile(path, "utf8")) as Parameters<typeof verifyPlanHistory>[1];
      verifyPlanHistory(job, receipt);
      if (
        receipt.plan?.version !== origin.planVersion &&
        !receipt.history?.some((h) => h.plan?.version === origin.planVersion)
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Restart gate for the original sealed unknown-failure diagnosis. A
 * controller's checked disposition is never accepted as its own Pi receipt. */
export async function authenticateDiagnosticStop(
  job: JobStartResult, source: RecoverySource,
  decision: Extract<RecoveryDecision, { action: "diagnostic-stop" }>,
): Promise<boolean> {
  if (source.channel !== "unknownRecovery" ||
      decision.disposition !== "operator-intervention" ||
      decision.receipt?.store !== "response-contract")
    return false;
  const originalCase = (source.input as { case?: UnknownRecoveryCase }).case;
  if (!originalCase || decision.receipt.ref !== originalCase.signature) return false;
  try {
    const sealed = await inspectOriginalUnknownDiagnosis(job, originalCase);
    return "action" in sealed && sealed.action === decision.recommendation &&
      sealed.category === decision.advisoryCategory;
  } catch { return false; }
}

export async function inspectModernGenerationRecovery(
  job: JobStartResult,
  saver: SqliteSaver,
  threadId: string,
): Promise<RecoveryLifecycle | null> {
  const cfg = { configurable: { thread_id: threadId } };
  const saved = await saver.getTuple(cfg);
  if (!saved) return null;
  const values = saved.checkpoint.channel_values as Record<string, unknown>;
  if (values.recoveryLifecycle == null) return null;
  const request = values.request as GenerationRequest | undefined;
  if (!request || request.job !== job.jobId || request.story !== job.storyRoot)
    throw Error("Modern recovery has a different immutable Job or Story identity.");
  const originalSources = values.recoverySources as readonly RecoverySource[] | undefined;
  const original = values.recoveryLifecycle as RecoveryLifecycle;
  const state: RecoveryState = {
    recoveryLifecycle: original,
    recoverySources: originalSources ?? [],
  };
  let inputsValid = true;
  try {
    assertRecoverySources(state);
  } catch {
    inputsValid = false;
  }
  const expectedTurn = request.turnPlanDigest ?? null;
  const sourceFor = (id: string) => originalSources?.find((s) => s.caseId === id);
  // A proven publication gap does not make the unpublished successor a
  // verified revision. Historical cases must still be checked against its
  // last published parent, and the active child must reconcile its own effect.
  let supportBase: Promise<string | null> | undefined;
  const interruptedSupportBase = () => supportBase ??= (async () => {
    const active = original.active, decision = original.decision;
    if (!inputsValid || !active || !original.assessorPending ||
        decision?.action !== "plan-amendment" || decision.adapter !== "dependency-work") return null;
    const source = sourceFor(active.id);
    const readiness = source?.channel === "operationRecovery"
      ? (source.input as unknown as GenerationOperationRecovery).evidence.eventBlueprintPrerequisite : undefined;
    if (!readiness) return null;
    try {
      const { inspectInterruptedBlueprintSupport } = await import("./dependency-work.js");
      if (!await authenticateOperationOwnerProof(job, values as GenerationGraphState, active, decision)) return null;
      return await inspectInterruptedBlueprintSupport(job, readiness, threadId);
    } catch { return null; }
  })();
  const authenticate = async (origin: RecoveryOrigin, evidence: readonly RecoveryEvidence[]) => {
    if (
      !inputsValid ||
      origin.graphThreadId !== threadId ||
      origin.jobId !== job.jobId ||
      origin.jobThreadId !== job.threadId ||
      origin.turnDigest !== expectedTurn ||
      evidence.length !== 1 ||
      evidence[0]?.store !== "graph-checkpoint" ||
      evidence[0].ref !== origin.failureAnchor.ref ||
      !origin.failureAnchor.ref.startsWith(threadId + ":")
    )
      return false;
    const caseFile = [original.active, ...(original.pending ?? []),
      ...original.discharged.map(entry => entry.case)].find(
      (c) =>
        c?.origin?.failureAnchor?.ref === origin.failureAnchor.ref &&
        c.origin.failureAnchor.failedCheckInstanceId === origin.failureAnchor.failedCheckInstanceId,
    );
    if (!caseFile || !sourceFor(caseFile.id)) return false;
    const old = origin.failureAnchor.ref.slice(threadId.length + 1);
    const checkpoint = await saver.getTuple({ configurable: { thread_id: threadId, checkpoint_id: old } });
    if (!checkpoint) return false;
    // A completed original *task* must be observable. A fabricated checkpoint
    // ID, valid-looking case digest, or arbitrary source HEAD is insufficient.
    const taskId = origin.failureAnchor.failedCheckInstanceId.match(
      /(?:^|:)([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?=:|$)/i,
    )?.[1];
    if (!taskId) return false;
    const pending = checkpoint.pendingWrites ?? [];
    const originalLifecycle = pending.some(
      ([task, channel, result]) =>
        task === taskId &&
        channel === "recoveryLifecycle" &&
        object(result) &&
        ((result.active as { id?: string } | undefined)?.id === caseFile.id ||
          (Array.isArray(result.pending) &&
            result.pending.some((c: { id?: string }) => c.id === caseFile.id))),
    );
    const originalSource = pending.some(
      ([task, channel, result]) =>
        task === taskId &&
        channel === "recoverySources" &&
        Array.isArray(result) &&
        result.some((s: RecoverySource) => isDeepStrictEqual(s, sourceFor(caseFile.id))),
    );
    const originalTask = originalLifecycle && originalSource;
    if (!originalTask) return false;
    const source = sourceFor(caseFile.id)!;
    if (source.channel === "recovery") {
      try {
        await verifyAdaptiveRecoveryProof(job, {
          ...source.input,
          phase: "assessment",
        } as unknown as AdaptiveRecovery);
      } catch {
        return false;
      }
    }
    const operation = source.channel === "operationRecovery" ? source.input as unknown as GenerationOperationRecovery : null;
    if (operation?.evidence.assignmentFailure) {
      if (origin.operation !== "specialist-result" || origin.assignmentId !== operation.evidence.assignmentId ||
          operation.outcome !== "returned-failure") return false;
      const discharge = original.discharged.find(entry => entry.case.id === caseFile.id);
      const selected = original.active?.id === caseFile.id ? assignmentDiagnosticDecisionForLifecycle(original) : null;
      const authenticated = selected ? !!await authenticateAssignmentDiagnosticDecision(job, caseFile, operation,
        selected, original.attempt) :
        discharge?.correction.store === "specialist-receipt" ?
          await authenticateAssignmentDiagnosticDischarge(job, caseFile, operation, discharge.correction, discharge.correctedHeadSha) :
          !!await authenticateAssignmentFailure(job, operation.evidence, origin.sourceHeadSha);
      if (!authenticated) return false;
      return authenticateOriginalFailure(job, request, threadId, origin, evidence, true);
    }
    if (await authenticateOriginalFailure(job, request, threadId, origin, evidence))
      return true;
    const base = await interruptedSupportBase();
    if (base) {
      try {
        jobGit(job, "merge-base", "--is-ancestor", origin.sourceHeadSha, base);
        return authenticateOriginalFailure(job, request, threadId, origin, evidence, true);
      } catch { return false; }
    }
    const selected = original.active?.id === caseFile.id && original.assessorPending &&
      original.decision?.action === "plan-amendment" &&
      original.decision.adapter === "cross-domain-closeout";
    if (!selected) return false;
    const graphState = values as GenerationGraphState;
    const pendingCloseout = graphState.crossDomainCloseout;
    if (!pendingCloseout || !graphState.inventory ||
        !matchesOriginalCloseout(graphState, caseFile, pendingCloseout))
      return false;
    // A Git child before independent review is NOT generally trusted. The
    // only exception is replaying the precise already-selected original
    // closeout adapter, after its writer session, field-only commit, parent
    // and pinned inventory have all been independently authenticated.
    try {
      const published = await inspectInterruptedCloseoutCommit(job, {
        ...pendingCloseout,
        milestoneId: pendingCloseout.milestoneId,
        originalInventoryDigest: originalInventorySnapshotDigest(graphState.inventory),
      });
      if (published !== jobGit(job, "rev-parse", "HEAD")) return false;
      return authenticateOriginalFailure(job, request, threadId, origin, evidence, true);
    } catch { return false; }
  };
  const checked = await verifyRecoveryCheckpoint({
    current: original,
    request: {
      jobId: job.jobId,
      jobThreadId: job.threadId,
      graphThreadId: threadId,
      turnDigest: expectedTurn,
    },
    checkpointRef: { store: "graph-checkpoint", ref: threadId + ":" + saved.checkpoint.id },
    authenticate,
    authenticateDecision: async (d) => {
      const active = original.active;
      if (
        !active ||
        !inputsValid ||
        d.caseId !== active.id ||
        d.checkedSourceHeadSha !== active.origin.sourceHeadSha
      )
        return false;
      const source = sourceFor(active.id);
      if (!source) return false;
      switch (d.action) {
        case "reconcile-effects": {
          if (source.channel !== "operationRecovery" || d.originalRef?.ref !== active.evidence[0]?.ref)
            return false;
          if (original.attempt?.purpose !== "diagnosis") return true;
          // A model-derived reconciliation is valid only if the controller
          // can still derive the EXACT adapter from its original sealed Pi
          // proposal and independently authenticated failed-check source.
          try {
            const selected = await selectOperationStrategy(job, values as GenerationGraphState, active);
            if (selected?.action !== "diagnostic") return false;
            const target = diagnosticCaseForDecision(active, selected);
            const proposed = await inspectOriginalUnknownDiagnosis(job, target);
            return "strategy" in proposed && isDeepStrictEqual(d,
              await authorizeOperationDiagnosticStrategy(job, values as GenerationGraphState, active, selected, proposed));
          } catch { return false; }
        }
        case "known-correction":
          if (source.channel === "recovery") return d.adapter === "response-contract";
          if (source.channel === "operationRecovery" && d.adapter === "assignment-diagnostic")
            return !!await authenticateAssignmentDiagnosticDecision(job, active,
              source.input as unknown as GenerationOperationRecovery, d, original.attempt);
          if (source.channel !== "operationRecovery" || d.adapter !== "review-cycle") return false;
          return await (await import("./generation-operation-strategy.js"))
            .authenticateOperationReviewProof(job, values as GenerationGraphState, active, d);
        case "plan-amendment": {
          const graphState = values as GenerationGraphState;
          if (d.adapter === "dependency-work" || d.adapter === "adaptive-work")
            return source.channel === "operationRecovery" &&
              await (await import("./generation-operation-strategy.js"))
                .authenticateOperationOwnerProof(job, graphState, active, d);
          const pending = graphState.crossDomainCloseout;
          return d.adapter === "cross-domain-closeout" && d.owner === "event" && !!pending &&
            matchesOriginalCloseout(graphState, active, pending) && d.scopeRef.store === "repair-ledger" &&
            d.scopeRef.ref === pending.repairId && d.scopeRef.digest === pending.proposalDigest &&
            isDeepStrictEqual(d.evidence, [...active.evidence, d.scopeRef]);
        }
        case "diagnostic":
          if (source.channel === "operationRecovery") return isDeepStrictEqual(d,
            await selectOperationStrategy(job, values as GenerationGraphState, active).catch(() => null));
          return source.channel === "unknownRecovery" && d.mode === "read-only" && d.attemptRef === null;
        case "strategy-unresolved":
          return source.channel === "operationRecovery" &&
            await (await import("./generation-operation-strategy.js"))
              .authenticateUnresolvedStrategy(job, values as GenerationGraphState, active, d);
        case "diagnostic-stop":
          if (source.channel === "operationRecovery") {
            try {
              const target = diagnosticCaseForDecision(active, d);
              const sealed = await inspectOriginalUnknownDiagnosis(job, target);
              return !!original.attempt && await authenticateOperationDiagnosticProof(job,
                values as GenerationGraphState, active, d) &&
                d.receipt.ref === target.signature &&
                ("strategy" in sealed ? isDeepStrictEqual(d.proposal, sealed) :
                  d.recommendation === sealed.action && d.advisoryCategory === sealed.category) &&
                d.disposition === "operator-intervention";
            } catch { return false; }
          }
          return authenticateDiagnosticStop(job, source, d);
        case "continue-independent":
          return source.channel === "operationRecovery" &&
            independentObligation(source.input as unknown as GenerationOperationRecovery,
              active.origin.sourceHeadSha) ===
              d.blockedAssignmentId &&
            d.blockedAssignmentId === (active.origin.assignmentId ??
              (source.input.operation === "idea-integration" &&
                typeof (source.input.evidence as { ideaId?: unknown } | undefined)?.ideaId === "string"
                  ? "idea:" + (source.input.evidence as { ideaId: string }).ideaId
                  : null)) &&
            d.inventoryRef.ref === active.evidence[0]?.ref;
        case "integrity-fence":
        case "pause":
          return true; // Never a write permission.
        case "exhausted":
          if (d.supportReview) return source.channel === "operationRecovery" &&
            await (await import("./generation-operation-strategy.js")).authenticateSupportingReviewExhaustion(job,
              values as GenerationGraphState, active, d);
          if (d.reviewAssessment) return source.channel === "operationRecovery" &&
            await (await import("./generation-operation-strategy.js")).authenticateFoundationReviewExhaustion(job,
              values as GenerationGraphState, active, d);
          return source.channel === "recovery" ||
            source.channel === "operationRecovery" &&
            !!((source.input as unknown as GenerationOperationRecovery).evidence.assignmentFailure ||
              (source.input as unknown as GenerationOperationRecovery).evidence.protocolFailure ||
              d.reason === "protocol-exhausted") &&
            isDeepStrictEqual(d, await selectOperationStrategy(job, values as GenerationGraphState, active).catch(() => null));
        default:
          return false; // Unsupported active writer scope from a saved claim.
      }
    },
    // A started or settled model invocation requires its ORIGINAL Pi session
    // attestor. No such invocation is re-admitted based on a saved graph
    // counter. The existing specialist's immutable external protocol remains
    // inspectable without calling Pi again.
    authenticateAttempt: async attempt => {
      const { active, decision } = original;
      if (!active || !decision || !(["diagnostic-stop", "reconcile-effects"].includes(decision.action) ||
          !!assignmentDiagnosticDecisionForLifecycle(original)) ||
          attempt.caseId !== active.id || attempt.purpose !== "diagnosis") return false;
      const source = sourceFor(active.id);
      const target = source?.channel === "operationRecovery" ? diagnosticCaseForDecision(active, decision) :
        source?.channel === "unknownRecovery" ? source.input.case as UnknownRecoveryCase : null;
      if (!target) return false;
      try { return isDeepStrictEqual(attempt, await inspectDiagnosticAttempt(job, target, active.id)); }
      catch { return false; }
    },
    authenticateDischarge: async discharge => {
      const source = sourceFor(discharge.case.id);
      if (!inputsValid || !source) return false;
      try {
        if (discharge.disposition === "active-verified")
          return await inspectActiveRecoveryResolution(job, discharge.case, source,
            discharge, { request, inventory: (values.inventory as GenerationInventory | null) ?? null },
            await interruptedSupportBase() ?? undefined);
        return !!await inspectDeferredCorrection(job, discharge.case, source, {
          inventory: (values.inventory as GenerationInventory | null) ?? null,
          ideaHistory: (values.ideaHistory as IdeaHistoryEntry[] | undefined) ?? [],
          fixture: request.fixture,
        }, discharge, await interruptedSupportBase() ?? undefined);
      } catch { return false; }
    },
    authenticateVerification: async (l) => {
      const c = l.active;
      if (!c || !inputsValid || !sourceFor(c.id)) return false;
      if (c.origin.operation === "scheduling" || c.origin.operation === "author-update-intake")
        return (await trustedHead(job)) === c.origin.sourceHeadSha;
      if (
        c.origin.operation !== "specialist-dispatch" &&
        c.origin.operation !== "commit-verification" &&
        c.origin.operation !== "adaptive-admission"
      )
        return false;
      try {
        const old = projectRecovery(state);
        return (
          await inspectBlockedOriginalThreadCorrection(job, threadId, {
            ...(values as Parameters<typeof inspectBlockedOriginalThreadCorrection>[2]),
            status: "blocked",
            operationRecovery: old.operationRecovery,
            recovery: old.recovery,
            unknownRecovery: old.unknownRecovery,
            recoveryLifecycle: undefined,
            recoverySources: undefined,
          })
        ).eligible;
      } catch {
        return false;
      }
    },
    authenticateCompletion: async (l) => {
      const c = l.active;
      if (!c || !inputsValid || !sourceFor(c.id)) return false;
      try {
        const head = await trustedHead(job);
        return (await inspectRecoveryCheckpoints(job)).some(
          (p) =>
            p.eligible &&
            p.commitSha === head &&
            (p.semanticReview === "passed" || p.semanticReview === "not-required"),
        );
      } catch {
        return false;
      }
    },
  });
  return checked;
}
