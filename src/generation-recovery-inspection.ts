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
import { inspectDeferredCorrection } from "./generation-recovery-resolution.js";
import { git as jobGit } from "./ideas.js";
import type { RecoveryDecision, RecoveryEvidence, RecoveryLifecycle, RecoveryOrigin } from "./generation-recovery-contract.js";
import { verifyRecoveryCheckpoint } from "./generation-recovery-lifecycle.js";
import {
  fixtureTurnIdentity,
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
import { inspectOriginalUnknownDiagnosis, type UnknownRecoveryCase } from "./unknown-recovery-diagnostic.js";
import { inspectBlockedOriginalThreadCorrection } from "./original-thread-continuation.js";

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
    const current = await trustedHead(job);
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
    return sealed.action === decision.recommendation &&
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
  const expectedTurn =
    request.turnPlanDigest ??
    fixtureTurnIdentity({
      jobId: job.jobId,
      jobThreadId: job.threadId,
      graphThreadId: threadId,
      turnDigest: null,
      fixture: request.fixture,
      task: request.task,
      contract: request.contract,
    });
  const sourceFor = (id: string) => originalSources?.find((s) => s.caseId === id);
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
    if (!request.turnPlanDigest && request.fixture) {
      if (origin.turnDigest !== expectedTurn) return false;
      const head = await trustedHead(job);
      if (original.discharged.some(entry => entry.case.id === caseFile.id)) {
        try { jobGit(job, "merge-base", "--is-ancestor", origin.sourceHeadSha, head); return true; }
        catch { return false; }
      }
      return head === origin.sourceHeadSha;
    }
    return authenticateOriginalFailure(job, request, threadId, origin, evidence);
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
        case "reconcile-effects":
          return source.channel === "operationRecovery" && d.originalRef?.ref === active.evidence[0]?.ref;
        case "known-correction":
          return source.channel === "recovery" && d.adapter === "response-contract";
        case "diagnostic":
          return source.channel === "unknownRecovery" && d.mode === "read-only" && d.attemptRef === null;
        case "diagnostic-stop":
          return authenticateDiagnosticStop(job, source, d);
        case "continue-independent":
          return source.channel === "operationRecovery" &&
            source.input.safeAction === "continue-independent" &&
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
          return source.channel === "recovery";
        default:
          return false; // Unsupported active writer scope from a saved claim.
      }
    },
    // A started or settled model invocation requires its ORIGINAL Pi session
    // attestor. No such invocation is re-admitted based on a saved graph
    // counter. The existing specialist's immutable external protocol remains
    // inspectable without calling Pi again.
    authenticateAttempt: async () => false,
    authenticateDischarge: async discharge => {
      const source = sourceFor(discharge.case.id);
      if (!inputsValid || !source) return false;
      try {
        return !!await inspectDeferredCorrection(job, discharge.case, source, {
          inventory: (values.inventory as GenerationInventory | null) ?? null,
          ideaHistory: (values.ideaHistory as IdeaHistoryEntry[] | undefined) ?? [],
          fixture: request.fixture,
        }, discharge);
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
