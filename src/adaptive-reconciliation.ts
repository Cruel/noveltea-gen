/** Reauthenticate an already accepted parent planner effect. No new plan,
 * model call, or Story permission can be produced by this inspector. */
import { isDeepStrictEqual } from "node:util";
import type { JobStartResult } from "./job.js";
import type { GenerationRequest } from "./generation.js";
import type { RecoveryOrigin, RecoveryEvidence } from "./generation-recovery-contract.js";
import { assertAdaptiveSettled, readAdaptiveState } from "./adaptive-state.js";
import { inspectCompletedAdaptiveProposal } from "./adaptive-planner.js";
import { initialAdaptiveResponse } from "./adaptive-protocol.js";
import { loadSelectedStoryOrchestrator } from "./orchestrator-selection.js";
import { readTurnEvidence } from "./turn-plan-evidence.js";
import { requiredOrchestratorSkillReads } from "./story-skill-policy.js";
import { pendingDigest } from "./pending-work-amendments.js";

export async function inspectSettledAdaptiveReconciliation(job: JobStartResult,
  request: GenerationRequest, origin: RecoveryOrigin, historicalRef?: string):
  Promise<{ receipt: RecoveryEvidence; version: number } | null> {
  if (origin.operation !== "adaptive-admission" || origin.assignmentId !== null ||
      origin.planVersion === null || request.fixture || request.job !== job.jobId ||
      origin.jobId !== job.jobId || origin.jobThreadId !== job.threadId ||
      request.orchestrationPolicy !== "explicit" || request.contract.scope.kind !== "full-story" ||
      request.turnPlanDigest !== origin.turnDigest) return null;
  const state = await readAdaptiveState(job, origin.turnDigest, origin.planVersion);
  if (!state) return null;
  const attempt = historicalRef ? state.attempts.find(a => a.signature === historicalRef) : state.attempts.at(-1);
  if (!attempt || attempt.sourceSha !== origin.sourceHeadSha ||
      attempt.phase !== "admitted" || attempt.malformedResponse ||
      !attempt.session || attempt.effect?.phase !== "responded" || !attempt.effect.invocation ||
      attempt.effect.invocation.file !== attempt.session.sessionFile ||
      attempt.effect.invocation.responseSha256 !== attempt.session.sessionSha256 ||
      attempt.effect.snapshotId !== attempt.session.snapshotId ||
      attempt.effect.provider !== attempt.session.provider || attempt.effect.model !== attempt.session.model) return null;
  if (!historicalRef) assertAdaptiveSettled(state);
  const turn = await readTurnEvidence(job, request.contract, request.task, origin.turnDigest);
  if (!turn || turn.kind !== "full-story" || !turn.objective) return null;
  const selected = await loadSelectedStoryOrchestrator(job, origin.graphThreadId, {
    task: request.task, kind: request.contract.scope.kind, turnPlanDigest: origin.turnDigest,
  });
  const inspected = await inspectCompletedAdaptiveProposal({ job, selected, effect: attempt.effect,
    signature: attempt.signature, required: [...requiredOrchestratorSkillReads(turn.creativePolicy?.mode ?? "autonomous")] });
  const proposal = await initialAdaptiveResponse(job, inspected.text, inspected.ref.file, inspected.ref.id);
  if (proposal.sourceSha !== origin.sourceHeadSha || proposal.turnDigest !== origin.turnDigest ||
      pendingDigest(proposal) !== attempt.session.proposalDigest ||
      !isDeepStrictEqual(inspected.skillReads, attempt.session.skillReads)) return null;
  const entry = state.entries[state.attempts.filter(a => a.phase === "admitted").indexOf(attempt)];
  if (!entry || entry.beforeVersion !== proposal.beforeVersion) return null;
  const version = entry.afterVersion;
  if (!historicalRef && version !== state.version) return null;
  return { receipt: { store: "response-contract", ref: attempt.signature,
    digest: pendingDigest({ attempt, entry, version }) }, version };
}
