/** Exact, read-only disposition for a blocked original Thread after a
 * source-authenticated approved-work correction or verifier reconciliation.
 * This is neither a fork nor a writer grant; Studio admission and the
 * production graph independently check the same proof. */
import { lstat, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { JobStartResult } from "./job.js";
import { trustedHead } from "./revision.js";
import { inspectRecoveryCheckpoints } from "./recovery-checkpoints.js";
import { inspectRepairLedger, inspectApprovalRevisionIncidents } from "./repair-ledger.js";
import { reviewedMilestoneHandoff, type MilestoneEventSource } from "./milestone-obligation-handoff.js";
import { readAdaptiveState, assertAdaptiveSettled, isProvablyUninvokedAdaptiveAttempt,
  type AdaptiveState } from "./adaptive-state.js";
import { loadSelectedStoryOrchestrator } from "./orchestrator-selection.js";
import { inspectPiPolicy } from "./job-pi-policy.js";
import { validateStoryJob } from "./validator.js";
import { readEventOnlyOmission, type EventOnlyRef } from "./interactive-event-only.js";
import { operationChecks, type GenerationOperationRecovery } from "./generation-operation-recovery.js";
import { verifyCorrectedOriginalResult } from "./commit-verification-continuation.js";
import { readJobControl } from "./job-control.js";
import type { GenerationStage } from "./generation-plan.js";

export type BlockedOriginalThreadState = {
  status?: string;
  request?: { job: string; task: string; fixture?: boolean; contract: { scope: { kind: 'partial' | 'full-story' } };
    turnPlanDigest?: string; provider?: string; model?: string };
  graphThreadId?: string | null;
  planVersion?: number | null;
  adaptiveVersion?: number | null;
  orchestratorSnapshotId?: string | null;
  active?: { id: string; stage: GenerationStage; milestone?: string } | null;
  failures?: Record<string, string>;
  result?: { status?: string; headSha?: string } | null;
  completedStages?: Array<{ stage: string; milestone?: string; headSha?: string }>;
  inventory?: { headSha: string; items: Array<{ id: string; status: string }> } | null;
  ideaTask?: unknown; ideaResult?: unknown;
  recovery?: { phase: string } | null;
  unknownRecovery?: { phase: string } | null;
  operationRecovery?: GenerationOperationRecovery | null;
};

/** Decide exactly one parent/receipt transition AFTER readAdaptiveState has
 * authenticated every saved amendment, original session, and Pi effect.
 * No new planner session is possible from this read-only inspection. */
export function inspectSettledAdaptiveVersion(adaptive: AdaptiveState, parentVersion: number,
  head: string, snapshotId: string | null | undefined): { eligible: boolean; reason: string } {
  const refuse = (reason: string) => ({ eligible: false, reason });
  if (!Number.isSafeInteger(parentVersion) || parentVersion < 1 ||
      adaptive.version < parentVersion || adaptive.version > parentVersion + 1)
    return refuse("Original adaptive operation has an unexpected receipt-version transition.");
  const atSource = adaptive.attempts.filter(attempt => attempt.sourceSha === head);
  const attempt = atSource.at(-1);
  if (!attempt?.effect || attempt.effect.snapshotId !== snapshotId)
    return refuse("The original adaptive effect is missing or not snapshot-bound.");
  if (isProvablyUninvokedAdaptiveAttempt(attempt) &&
      adaptive.version === parentVersion && atSource.length === 1)
    return { eligible: true, reason: "Original adaptive operation was proven never invoked; resume its pinned attempt." };
  if ((attempt.phase === "admitted" || attempt.phase === "unchanged") &&
      attempt.effect.phase === "responded" && attempt.session) {
    assertAdaptiveSettled(adaptive);
    const last = adaptive.entries.at(-1);
    if (attempt.phase === "admitted" && adaptive.version === parentVersion + 1 &&
        last?.beforeVersion === parentVersion && last.sourceSha === head &&
        adaptive.attempts.filter(a => a.phase === "admitted").at(-1) === attempt)
      return { eligible: true, reason: "Original completed adaptive amendment has an authenticated admission receipt." };
    if (attempt.phase === "unchanged" && adaptive.version === parentVersion)
      return { eligible: true, reason: "Original completed no-change adaptive response is authenticated; resume without another planner call." };
  }
  return refuse("Adaptive Pi effects are unfinished or ambiguous; no new model call is permitted.");
}

/** A corrected approval is relevant only to an original blocked *dependent*
 * assignment, whose controller failure was sealed at the exact source. Merely
 * finding an unrelated successful correction in the job is insufficient. */
export async function inspectBlockedOriginalThreadCorrection(
  job: JobStartResult, threadId: string, saved: BlockedOriginalThreadState,
): Promise<{ eligible: boolean; reason: string; assignmentId?: string }> {
  const refuse = (reason: string) => ({ eligible: false, reason });
  const request = saved.request;
  const active = saved.active;
  const op = saved.operationRecovery;
  const commitVerifier = op?.operation === "commit-verification";
  if (saved.status !== "blocked" || !request?.turnPlanDigest ||
      saved.graphThreadId !== threadId || request.job !== job.jobId ||
      (saved.result && !commitVerifier) || saved.ideaTask || saved.ideaResult ||
      (!saved.inventory && saved.operationRecovery?.operation !== "adaptive-admission") ||
      saved.unknownRecovery || saved.recovery && saved.recovery.phase !== "completed")
    return refuse("The blocked graph is not an idle, source-bound recovery handoff.");
  if (!op || !["fenced", "continued"].includes(op.phase) ||
      op.version !== 1 || op.checkVersion !== 1 || op.check !== operationChecks[op.operation] ||
      op.source.jobId !== job.jobId || op.source.threadId !== threadId ||
      op.source.turnDigest !== request.turnPlanDigest ||
      op.source.planVersion !== (saved.planVersion ?? null))
    return refuse("No exact controller recovery disposition exists for this blocked operation.");

  if (await readJobControl(job) !== "running")
    return refuse("Author execution control must be running before recovery.");
  // Admission and graph entry share this source gate. A dirty/untracked draft
  // cannot be hidden behind an otherwise valid historical checkpoint.
  const gitEnv = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR",
    "GIT_INDEX_FILE", "GIT_PREFIX"]) delete gitEnv[key];
  if (execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: job.worktreeRoot, env: gitEnv, encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()) return refuse("Original Thread contains uncommitted Story edits; reconcile the writer first.");
  const head = await trustedHead(job);
  // A specialist result may have advanced HEAD beyond the inventory built
  // immediately before its dispatch. That old inventory is expected here:
  // only the failed verifier's result/checkpoint may authenticate the new HEAD.
  if ((!commitVerifier && ((saved.inventory && saved.inventory.headSha !== head) ||
        op.source.headSha !== head)) ||
      (commitVerifier && op.source.headSha !== saved.result?.headSha))
    return refuse("The blocked source or controller recovery head changed.");
  const pi = await inspectPiPolicy(job);
  if (request.provider && request.provider !== pi.policy.profile.provider ||
      request.model && request.model !== pi.policy.profile.model)
    return refuse("Original Pi provider/model differs from the pinned execution policy.");
  if (pi.budget.pause)
    return refuse("Resource budget is still paused; increase the permitted limits first.");
  if (saved.orchestratorSnapshotId) {
    const selection = await loadSelectedStoryOrchestrator(job, threadId, {
      task: request.task, kind: request.contract.scope.kind,
      turnPlanDigest: request.turnPlanDigest,
    });
    if (selection.receipt.skillSnapshot.id !== saved.orchestratorSnapshotId)
      return refuse("The original selected orchestrator snapshot changed.");
  }
  const adaptive = saved.planVersion != null
    ? await readAdaptiveState(job, request.turnPlanDigest, saved.planVersion) : null;
  if (adaptive) {
    if (saved.adaptiveVersion != null && saved.adaptiveVersion > adaptive.version ||
        adaptive.attempts.some(attempt => attempt.effect &&
          (attempt.effect.provider !== pi.policy.profile.provider ||
           attempt.effect.model !== pi.policy.profile.model)))
      return refuse("Original adaptive model or admitted version differs from its recovery proof.");
  }
  // A proven pre-invocation adaptive attempt can enter its original recovery
  // branch once. Invoking/legacy receipts remain ambiguous; a completed
  // response must first be admitted and authenticated by readAdaptiveState.
  if (op.operation === "adaptive-admission") {
    if (op.phase !== "fenced" || op.safeAction !== "reconcile-original-operation" ||
        op.evidence.reference !== "generation-checkpoint" || active ||
        !adaptive || saved.planVersion == null)
      return refuse("Original adaptive operation lacks a settled recovery identity.");
    // The authenticated original effect may have settled exactly one signed
    // amendment or an unchanged response after the parent checkpoint.
    return inspectSettledAdaptiveVersion(adaptive, saved.adaptiveVersion ?? 1,
      head, saved.orchestratorSnapshotId);
  }
  if (commitVerifier) {
    if (op.phase !== "fenced" || op.outcome !== "exception" ||
        op.safeAction !== "reconcile-original-operation" ||
        op.evidence.reference !== "review-checkpoints" ||
        !op.evidence.verifier || !active || !saved.result ||
        !saved.result.headSha ||
        !saved.inventory || !saved.inventory.items.some(item => item.id === active.id &&
          (item.status === "pending" || item.status === "blocked")) ||
        saved.completedStages?.some(stage => stage.stage === active.stage &&
          stage.milestone === active.milestone) ||
        op.evidence.assignmentId !== active.id)
      return refuse("The failed verifier has no complete, unused original result and controller-captured input.");
    if (adaptive) {
      if (adaptive.attempts.some(attempt => attempt.phase === "planning")) {
        const settled = inspectSettledAdaptiveVersion(adaptive, saved.adaptiveVersion ?? adaptive.version,
          head, saved.orchestratorSnapshotId);
        if (!settled.eligible)
          return refuse("Original adaptive effect must settle before verifier recovery: " + settled.reason);
      } else assertAdaptiveSettled(adaptive);
    } else if (saved.adaptiveVersion != null && saved.adaptiveVersion > 1)
      return refuse("Original admitted adaptive work is missing its authenticated receipts.");
    const proof = await verifyCorrectedOriginalResult(job, request.turnPlanDigest,
      active, saved.result, op.evidence.verifier, op.source.planVersion);
    if (!proof.eligible) return proof;
    const validation = await validateStoryJob(job);
    if (validation.status !== "passed")
      return refuse("Native validation does not pass the unchanged original specialist commit.");
    return proof;
  }
  if (adaptive) assertAdaptiveSettled(adaptive);
  const assignmentId = op.evidence.assignmentId;
  const item = saved.inventory!.items.find(entry => entry.id === assignmentId);
  const milestone = item?.id.match(/^(?:interactive|composition):(milestone\.[a-z][a-z0-9-]*)$/)?.[1];
  const settledNoWriteFailure = op.operation === "specialist-dispatch" &&
    op.phase === "continued" && op.safeAction === "continue-independent" &&
    !active && !!item && item.status === "blocked" &&
    saved.failures?.[assignmentId!] === op.reason && op.evidence.priorHead === head;
  // A fenced reviewer/commit verifier with an active but unsettled writer
  // is not interchangeable with a no-write specialist failure. Resuming it
  // would route back to specialist_dispatch and might reissue a Pi call.
  // Keep that case fenced for its own original-operation reconciliation.
  if (!milestone || !["interactive", "composition"].includes(item?.id.split(":")[0] ?? "") ||
      !settledNoWriteFailure)
    return refuse("No settled no-write dependent assignment matches this correction.");

  const ledger = await inspectRepairLedger(job, request.turnPlanDigest);
  const repair = ledger.blueprintRepairs?.find(entry => entry.original.milestoneId === milestone);
  if (!repair?.successor || repair.sourceSha !== head)
    return refuse("The blocked Milestone has no completed correction at this exact source.");
  const incidents = await inspectApprovalRevisionIncidents(job, {
    milestoneId: milestone, limit: 100,
  });
  if (!incidents.records.some(incident => incident.turnDigest === request.turnPlanDigest &&
      incident.disposition === "corrected" && incident.triggeringSourceSha === head &&
      incident.successor?.digest === repair.successor?.digest))
    return refuse("The successor has no authenticated historical approval and warning evidence.");

  const eventPath = join(job.stateDir, "event-items", milestone.slice("milestone.".length) + ".json");
  const stat = await lstat(eventPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256_000)
    return refuse("The original Event work item is not a safe recovery source.");
  const event = JSON.parse(await readFile(eventPath, "utf8")) as MilestoneEventSource;
  const handoff = await reviewedMilestoneHandoff(job, event);
  if (!handoff?.supersedes || handoff.pin.digest !== repair.successor.digest ||
      (item!.id.startsWith("interactive:") && !handoff.affected?.interactive) ||
      (item!.id.startsWith("composition:") && !handoff.affected?.composition))
    return refuse("Reviewed Blueprint obligations do not affect the blocked assignment.");
  const point = (await inspectRecoveryCheckpoints(job)).find(p =>
    p.eligible && p.commitSha === repair.eventHead && p.workItem ===
      "event-" + milestone.slice("milestone.".length) && p.semanticReview === "passed");
  if (!point) return refuse("Original Event independent review is no longer eligible.");
  const native = await validateStoryJob(job);
  if (native.status !== "passed")
    return refuse("The pinned native validator did not pass the corrected Story source.");
  // The independent-failure disposition protects *other* assignments. It is
  // not authority to call the failed Pi specialist again. Only an already
  // sealed, independently reviewed, commitless Event-only Interactive result
  // can be re-entered; its inspect path cannot invoke a writer or reviewer.
  // Composition and required Choice/Puzzle work retain their original fence.
  if (!item!.id.startsWith("interactive:") ||
      handoff.design.downstream.some(entry => entry.owner === "interactive"))
    return refuse("The original dependent writer has no verified no-call continuation.");
  // Read the original Interactive receipt with the already verified Job
  // identity; the caller must not resolve a different state root or run the
  // specialist's state machine merely to inspect an immutable no-write proof.
  const expectedPlanVersion = saved.planVersion;
  try {
    const savedPath = join(job.stateDir, "interactive-items", milestone.slice(10) + ".json");
    const stat = await lstat(savedPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256_000)
      throw Error("Unsafe saved Interactive receipt.");
    const saved = JSON.parse(await readFile(savedPath, "utf8")) as {
      version: number; jobId: string; baseSha: string; milestoneId: string;
      planVersion: number; planDigest: string; eventHead: string;
      correctedBlueprintPin?: typeof repair.successor;
      worker: "fixture" | "pi";
      units: Array<{ phase: string; beforeHead?: string; eventOnly?: EventOnlyRef;
        commitSha?: string; paths?: string[]; claimedPaths?: string[] }>;
    };
    const [choice, puzzle] = saved.units ?? [];
    if (saved.version !== 1 || saved.jobId !== job.jobId ||
        saved.baseSha !== job.baseSha || saved.milestoneId !== milestone ||
        saved.eventHead !== repair.eventHead ||
        saved.planVersion !== expectedPlanVersion ||
        JSON.stringify(saved.correctedBlueprintPin) !== JSON.stringify(repair.successor) ||
        saved.worker !== (request.fixture ? "fixture" : "pi") ||
        !choice?.eventOnly || !puzzle?.eventOnly ||
        choice.phase !== "not-applicable" || puzzle.phase !== "not-applicable" ||
        choice.beforeHead !== head || puzzle.beforeHead !== head ||
        JSON.stringify(choice.eventOnly) !== JSON.stringify(puzzle.eventOnly) ||
        choice.commitSha || puzzle.commitSha || choice.paths?.length || puzzle.paths?.length ||
        choice.claimedPaths?.length || puzzle.claimedPaths?.length)
      throw Error("Original Interactive no-write receipt changed.");
    const omission = await readEventOnlyOmission(job, milestone, choice.eventOnly, {
      eventHead: repair.eventHead, planDigest: saved.planDigest,
      eventSnapshotId: (event as { snapshot?: { id?: string } }).snapshot?.id ?? "",
      validatorVersion: job.validatorVersion,
    });
    if (omission.reviewHead !== head || omission.planVersion !== saved.planVersion ||
        omission.reviewMode !== (request.fixture ? "fixture" : "pi"))
      throw Error("Original omission review changed after correction.");
  } catch {
    return refuse("A completed, independently reviewed no-write Interactive receipt is required before retrying the original specialist.");
  }
  return { eligible: true, reason: "Original reviewed no-write Interactive result can be reconciled without another model call.",
    assignmentId };
}
