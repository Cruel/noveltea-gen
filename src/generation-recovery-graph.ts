/** C02: one graph recovery authority, backed by immutable domain inputs.
 *
 * Domain status objects are reconstructed inside the existing node
 * handler only. They are NEVER graph channels and cannot control routing.
 * Their phase-free original parameters retain each adapter's receipt checks,
 * not a second decision/attempt/approval ledger.
 */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  RecoveryCase,
  RecoveryDecision,
  RecoveryEvidence,
  RecoveryLifecycle,
  RecoveryOrigin,
} from "./generation-recovery-contract.js";
import {
  admitRecovery,
  decideRecovery,
  emptyRecoveryLifecycle,
  finishVerifiedRecovery,
  inspectionFence,
  recoveryAdmission,
  recoveryCaseId,
  recordRecoveryOutcome,
  reassessFencedReadOnlyRecovery,
  reassessFencedVerifiedOriginal,
  deferRecoveryForIndependentWork,
  selectPendingRecovery,
} from "./generation-recovery-lifecycle.js";
import { originalGraphFailureAnchor } from "./generation-recovery-anchor.js";
import { independentObligation, operationChecks, type GenerationOperationRecovery } from "./generation-operation-recovery.js";
import { unknownCompletionCase, type UnknownRecoveryStatus } from "./unknown-recovery-diagnostic.js";
import type { AdaptiveRecovery } from "./adaptive-protocol.js";

type Channel = "operationRecovery" | "recovery" | "unknownRecovery";
export type DomainRecoveryStatus = {
  operationRecovery: GenerationOperationRecovery | null;
  recovery: AdaptiveRecovery | null;
  unknownRecovery: UnknownRecoveryStatus | null;
};
export type RecoverySource = Readonly<{
  channel: Channel;
  caseId: string;
  /** The original domain input with NO domain routing phase. */
  input: Record<string, unknown>;
}>;
export type RecoveryState = Readonly<{
  recoveryLifecycle: RecoveryLifecycle;
  recoverySources: readonly RecoverySource[];
}>;
type NodeConfig = { configurable?: Record<string, unknown>; metadata?: Record<string, unknown> };
type Identity = {
  jobId: string;
  jobThreadId: string;
  graphThreadId: string;
  turnDigest: string | null;
  fixture: boolean;
  task: string;
  contract: unknown;
};
type AdmissionTrust = (origin: RecoveryOrigin, evidence: readonly RecoveryEvidence[]) => Promise<boolean>;
// The old field remains recognizable to historical checkpoint readers, but
// no new unknownRecovery admission may be minted by the current graph.
const channels: readonly Channel[] = ["operationRecovery", "recovery", "unknownRecovery"];
const object = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
const strip = (x: Record<string, unknown>): Record<string, unknown> => {
  const { phase: _phase, ...rest } = x;
  return rest;
};
export function fixtureTurnIdentity(input: Identity): string | null {
  // Fixtures have no user Turn or Pi authority. Stable source identity is
  // derived only for fixture graph certification, never for live execution.
  if (!input.fixture || input.turnDigest !== null) return null;
  return createHash("sha256")
    .update(
      JSON.stringify([
        "noveltea-fixture-turn/v1",
        input.jobId,
        input.jobThreadId,
        input.graphThreadId,
        input.task,
        input.contract,
      ]),
    )
    .digest("hex");
}
function originalInput(channel: Channel, input: RecoverySource): boolean {
  return input.channel === channel && !Object.hasOwn(input.input, "phase");
}
export function projectRecovery(state: RecoveryState): DomainRecoveryStatus {
  const p: DomainRecoveryStatus = { operationRecovery: null, recovery: null, unknownRecovery: null };
  const c = state.recoveryLifecycle.active;
  if (!c) return p;
  const s = state.recoverySources.find((item) => item.caseId === c.id);
  if (!s || !originalInput(s.channel, s)) return p;
  const phase = state.recoveryLifecycle.phase;
  const d = state.recoveryLifecycle.decision;
  if (s.channel === "operationRecovery")
    p.operationRecovery = {
      ...s.input,
      phase:
        phase === "verifying" || phase === "resolved"
          ? "continued"
          : phase === "fenced" || phase === "paused"
            ? "fenced"
            : "assessment",
    } as unknown as GenerationOperationRecovery;
  if (s.channel === "recovery")
    p.recovery = {
      ...s.input,
      phase:
        phase === "correcting"
          ? "authorized"
          : phase === "verifying" || phase === "resolved"
            ? "completed"
            : phase === "fenced" && d?.action === "exhausted"
              ? "protocol-exhausted"
              : "assessment",
    } as unknown as AdaptiveRecovery;
  if (s.channel === "unknownRecovery")
    p.unknownRecovery = {
      ...s.input,
      phase: d?.action === "diagnostic-stop" ? "operator-intervention" :
        phase === "paused" ? "resource-limit" : phase === "fenced" ? "unsafe-evidence" : "assessment",
      ...(d?.action === "diagnostic-stop"
        ? { recommendation: d.recommendation, advisoryCategory: d.advisoryCategory } : {}),
    } as unknown as UnknownRecoveryStatus;
  return p;
}
function originalMatchesCase(s: RecoverySource, c: RecoveryCase): boolean {
  if (s.caseId !== c.id || !originalInput(s.channel, s)) return false;
  if (s.channel === "operationRecovery") {
    const op = s.input as unknown as Omit<GenerationOperationRecovery, "phase">;
    return (
      op.version === 1 &&
      op.checkVersion === 1 &&
      op.operation === c.origin.operation &&
      op.check === c.origin.check &&
      operationChecks[op.operation] === op.check &&
      !!op.source &&
      op.source.jobId === c.origin.jobId &&
      op.source.threadId === c.origin.graphThreadId &&
      // A non-Pi fixture's original operation has no signed Turn. Its
      // lifecycle uses a deterministic, request-bound fixture fingerprint
      // instead; live admission still requires the exact original Turn.
      (op.source.turnDigest === c.origin.turnDigest || op.source.turnDigest === null) &&
      op.source.planVersion === c.origin.planVersion &&
      op.source.headSha === c.origin.sourceHeadSha &&
      (op.evidence?.assignmentId ?? null) === c.origin.assignmentId &&
      op.outcome === c.observation &&
      (!op.evidence.failureKind || op.evidence.failureKind === c.kind) &&
      (op.evidence.assignmentFailure === undefined ||
        op.operation === "specialist-result" && op.outcome === "returned-failure" &&
        op.evidence.assignmentFailure.sourceHeadSha === c.origin.sourceHeadSha &&
        op.evidence.assignmentFailure.proof.kind === op.evidence.resultStatus &&
        c.kind === (op.evidence.assignmentFailure.proof.kind === "protocol-exhausted" ? "protocol" : "semantic"))
    );
  }
  if (s.channel === "recovery") {
    const a = s.input as unknown as Omit<AdaptiveRecovery, "phase">;
    return (
      a.operation === "adaptive-planner" &&
      a.failedPhase === "completed-response" &&
      a.check === c.origin.check &&
      a.checkVersion === c.origin.checkVersion &&
      a.jobId === c.origin.jobId &&
      a.threadId === c.origin.jobThreadId &&
      a.turnDigest === c.origin.turnDigest &&
      a.sourceSha === c.origin.sourceHeadSha &&
      a.planVersion === c.origin.planVersion &&
      /^[a-f0-9]{64}$/.test(a.signature) &&
      !!a.proof?.file &&
      !!a.proof?.id &&
      /^[a-f0-9]{64}$/.test(a.proof.sha256)
    );
  }
  const u = s.input as unknown as Omit<UnknownRecoveryStatus, "phase">;
  const record = u.case;
  if (
    !record ||
    record.jobId !== c.origin.jobId ||
    record.threadId !== c.origin.jobThreadId ||
    record.turnDigest !== c.origin.turnDigest ||
    record.sourceSha !== c.origin.sourceHeadSha ||
    record.planVersion !== c.origin.planVersion ||
    record.operation !== c.origin.operation ||
    record.check !== c.origin.check ||
    record.checkVersion !== c.origin.checkVersion
  )
    return false;
  try {
    return isDeepStrictEqual(
      record,
      unknownCompletionCase({
        jobId: record.jobId,
        threadId: record.threadId,
        turnDigest: record.turnDigest,
        planVersion: record.planVersion,
        sourceSha: record.sourceSha,
        checkpoint: record.checkpoint,
        reportStatus: record.reportStatus,
        scopeStatus: record.scopeStatus,
        planStatus: record.planStatus,
      }),
    );
  } catch {
    return false;
  }
}
export function assertRecoverySources(state: RecoveryState): void {
  const cases = [state.recoveryLifecycle.active, ...state.recoveryLifecycle.pending,
    ...state.recoveryLifecycle.discharged.map(entry => entry.case)].filter(
    (c): c is RecoveryCase => !!c,
  );
  const ids = new Set<string>();
  for (const s of state.recoverySources) {
    if (!originalInput(s.channel, s) || ids.has(s.caseId))
      throw Error("Duplicate or mutable original recovery input.");
    ids.add(s.caseId);
  }
  for (const c of cases) {
    const s = state.recoverySources.find((p) => p.caseId === c.id);
    if (!s || !originalMatchesCase(s, c)) throw Error("Missing original source-bound recovery input.");
  }
}
function derive(
  channel: Channel,
  raw: Record<string, unknown>,
  identity: Identity,
  anchor: RecoveryOrigin["failureAnchor"],
): {
  origin: RecoveryOrigin;
  input: Record<string, unknown>;
  kind: RecoveryCase["kind"];
  observation: RecoveryCase["observation"];
  effect: RecoveryCase["effect"];
} | null {
  const turn = identity.turnDigest ?? fixtureTurnIdentity(identity);
  if (!turn || raw.phase !== "assessment") return null;
  const common = {
    jobId: identity.jobId,
    jobThreadId: identity.jobThreadId,
    graphThreadId: identity.graphThreadId,
    turnDigest: turn,
    failureAnchor: anchor,
  };
  if (channel === "operationRecovery") {
    const op = raw as unknown as GenerationOperationRecovery;
    if (
      op.version !== 1 ||
      !(op.operation in operationChecks) ||
      op.check !== operationChecks[op.operation] ||
      op.checkVersion !== 1 ||
      op.source?.jobId !== identity.jobId ||
      op.source.threadId !== identity.graphThreadId ||
      op.source.turnDigest !== identity.turnDigest ||
      !/^[a-f0-9]{40}$/.test(op.source.headSha ?? "") ||
      !["exception", "returned-failure"].includes(op.outcome)
    )
      return null;
    return {
      origin: {
        ...common,
        sourceHeadSha: op.source.headSha!,
        planVersion: op.source.planVersion,
        operation: op.operation,
        check: op.check,
        checkVersion: op.checkVersion,
        assignmentId: op.evidence?.assignmentId ?? null,
      },
      input: strip(raw),
      kind: op.evidence.assignmentFailure?.proof.kind === "protocol-exhausted"
        ? "protocol" : op.evidence.failureKind ?? (op.outcome === "exception" ? "infrastructure" : "semantic"),
      observation: op.outcome,
      effect: "writer-effects-uncertain",
    };
  }
  if (channel === "recovery") {
    const a = raw as unknown as AdaptiveRecovery;
    if (
      a.operation !== "adaptive-planner" ||
      a.check !== "adaptive-plan.v1" ||
      a.checkVersion !== 1 ||
      a.failedPhase !== "completed-response" ||
      a.jobId !== identity.jobId ||
      a.threadId !== identity.jobThreadId ||
      a.turnDigest !== identity.turnDigest
    )
      return null;
    return {
      origin: {
        ...common,
        sourceHeadSha: a.sourceSha,
        planVersion: a.planVersion,
        operation: a.operation,
        check: a.check,
        checkVersion: a.checkVersion,
        assignmentId: null,
      },
      input: strip(raw),
      kind: "protocol",
      observation: "returned-failure",
      effect: "read-only",
    };
  }
  const u = raw as unknown as UnknownRecoveryStatus;
  const c = u.case;
  if (
    !c ||
    c.jobId !== identity.jobId ||
    c.threadId !== identity.jobThreadId ||
    c.turnDigest !== identity.turnDigest ||
    c.check !== "generation-fulfillment" ||
    !isDeepStrictEqual(
      c,
      unknownCompletionCase({
        jobId: c.jobId,
        threadId: c.threadId,
        turnDigest: c.turnDigest,
        planVersion: c.planVersion,
        sourceSha: c.sourceSha,
        checkpoint: c.checkpoint,
        reportStatus: c.reportStatus,
        scopeStatus: c.scopeStatus,
        planStatus: c.planStatus,
      }),
    )
  )
    return null;
  return {
    origin: {
      ...common,
      sourceHeadSha: c.sourceSha,
      planVersion: c.planVersion,
      operation: c.operation,
      check: c.check,
      checkVersion: c.checkVersion,
      assignmentId: null,
    },
    input: strip(raw),
    kind: "integrity",
    observation: "incomplete-inventory",
    effect: "read-only",
  };
}
function fence(l: RecoveryLifecycle, reason: string): RecoveryLifecycle {
  return admitRecovery(l, {
    outcome: "fenced",
    fence: inspectionFence(
      "untrusted-receipt",
      l.active?.origin ?? {},
      l.active?.evidence ?? [],
      l.active
        ? { store: l.active.origin.failureAnchor.store, ref: l.active.origin.failureAnchor.ref }
        : null,
      reason,
    ),
  });
}
/** A transition mismatch is itself a recovery event, not permission to
 * abandon the persisted case by throwing out of the parent graph. */
function safelyTransition(l: RecoveryLifecycle, transition: () => RecoveryLifecycle): RecoveryLifecycle {
  try {
    return transition();
  } catch {
    return fence(l, "Original recovery phase/decision/outcome cannot be verified.");
  }
}
export function decideExistingRecovery(state: RecoveryState): RecoveryLifecycle {
  assertRecoverySources(state);
  const c = state.recoveryLifecycle.active;
  if (!c || state.recoveryLifecycle.phase !== "assessing") return state.recoveryLifecycle;
  const source = state.recoverySources.find((x) => x.caseId === c.id);
  if (!source) return fence(state.recoveryLifecycle, "Original operation input is missing");
  const base = {
    schema: "noveltea-generation-recovery-decision/v1" as const,
    caseId: c.id,
    checkedSourceHeadSha: c.origin.sourceHeadSha,
    evidence: c.evidence,
  };
  const independent = source.channel === "operationRecovery" &&
    independentObligation(source.input as unknown as GenerationOperationRecovery, c.origin.sourceHeadSha);
  let decision: RecoveryDecision;
  if (source.channel === "recovery")
    decision = { ...base, action: "known-correction", adapter: "response-contract", receipt: c.evidence[0]! };
  else if (source.channel === "unknownRecovery")
    decision = {
      ...base,
      action: "diagnostic",
      adapter: "unknown-diagnostic",
      mode: "read-only",
      attemptRef: null,
    };
  else if (independent)
    decision = { ...base, action: "continue-independent",
      inventoryRef: c.evidence[0]!, blockedAssignmentId: independent };
  else
    decision = {
      ...base,
      action: "reconcile-effects",
      adapter:
        source.input.operation === "idea-integration"
          ? "idea-placement"
          : source.input.operation === "resume-reconciliation"
            ? "checkpoint-reconciliation"
            : "original-specialist",
      originalRef: c.evidence[0]!,
    };
  return decideRecovery(state.recoveryLifecycle, decision);
}
/** Only patches actually issued by the domain node are considered. A copied
 * state does not re-admit an original failure as a new invocation. */
export function extractDomainPatch(
  before: DomainRecoveryStatus,
  output: Record<string, unknown>,
): {
  domain: Partial<DomainRecoveryStatus>;
  rest: Record<string, unknown>;
} {
  const domain: Partial<DomainRecoveryStatus> = {};
  const rest = { ...output };
  for (const key of channels) {
    if (Object.hasOwn(rest, key) && rest[key] !== undefined && !isDeepStrictEqual(rest[key], before[key]))
      (domain as Record<string, unknown>)[key] = rest[key];
    delete rest[key];
  }
  delete rest.recoveryLifecycle;
  delete rest.recoverySources;
  return { domain, rest };
}
export async function applyDomainRecovery(
  state: RecoveryState,
  update: Partial<DomainRecoveryStatus>,
  config: NodeConfig,
  identity: Identity,
  authenticate: AdmissionTrust,
  assurance: {
    originalEffect?: RecoveryEvidence;
    verifiedHead?: string;
    verifiedReceipt?: RecoveryEvidence;
    authorControl?: "paused" | "cancelled";
    diagnosis?: { recommendation: "operator-intervention" | "inspect-existing-receipt";
      advisoryCategory: "software" | "unclassified" | "resources" | "integrity"; receipt: RecoveryEvidence };
  } = {},
): Promise<RecoveryState> {
  let l = state.recoveryLifecycle ?? emptyRecoveryLifecycle();
  const sources = [...(state.recoverySources ?? [])];
  // Capture every new failure even when another case already owns the lane.
  for (const channel of channels) {
    if (channel === "unknownRecovery") continue; // C05: historical inspect only.
    const raw = update[channel];
    if (!object(raw) || raw.phase !== "assessment") continue;
    const check =
      channel === "operationRecovery"
        ? (raw.check as string)
        : channel === "recovery"
          ? "adaptive-plan.v1"
          : "generation-fulfillment";
    const anchor = originalGraphFailureAnchor(config, check);
    // Source-local payload is NOT the original failed-check identity. Two
    // distinct LangGraph invocations can fail with byte-identical operation
    // inputs and must remain two independently reviewable obligations.
    const priorInput = sources.find((x) => x.channel === channel && isDeepStrictEqual(x.input, strip(raw)));
    // A *fenced read-only* operation can reassess its original obligation
    // after independently verified source repair, even when the scheduling
    // node itself re-runs under a new LangGraph task ID. This is NEVER a
    // reusable writer or model attempt.
    if (
      priorInput &&
      channel === "operationRecovery" &&
      l.active?.id === priorInput.caseId &&
      l.phase === "fenced" &&
      !l.inspectionFences.length &&
      l.active.observation === "exception" &&
      ["scheduling", "author-update-intake"].includes(l.active.origin.operation)
    ) {
      let verified = false;
      try {
        verified = await authenticate(l.active.origin, l.active.evidence);
      } catch {
        /* Preserve the original fence and attempt history. */
      }
      if (verified) l = reassessFencedReadOnlyRecovery(l, true);
      continue;
    }
    const existing = sources.find(
      (x) =>
        x.channel === channel &&
        isDeepStrictEqual(x.input, strip(raw)) &&
        [l.active, ...l.pending].some(
          (c) => c?.id === x.caseId && (anchor ? isDeepStrictEqual(c.origin.failureAnchor, anchor) : true),
        ),
    );
    if (existing) continue;
    if (!anchor) {
      l = fence(l, "Missing original executing LangGraph task and parent checkpoint");
      continue;
    }
    let d: ReturnType<typeof derive> = null;
    try {
      d = derive(channel, raw, identity, anchor);
    } catch {
      /* invalid input */
    }
    if (!d) {
      l = fence(l, "Original failure has invalid Job, Thread, Turn or check");
      continue;
    }
    // A resolved case's phase/decision/attempt are removed by finishRecovery,
    // but the immutable original source identity stays as a tombstone.
    // Replaying the exact same failed-check task must NEVER consume another
    // diagnosis allowance, issue another writer or reset a settled case.
    const caseId = recoveryCaseId(d.origin);
    const priorCase = sources.find((s) => s.caseId === caseId);
    if (priorCase) {
      if (priorCase.channel !== channel || !isDeepStrictEqual(priorCase.input, d.input))
        l = fence(l, "Original failed-check identity conflicts with a prior settled case");
      continue;
    }
    const admission = await recoveryAdmission({
      origin: d.origin,
      kind: d.kind,
      observation: d.observation,
      effect: d.effect,
      evidence: [{ store: "graph-checkpoint", ref: anchor.ref }],
      authenticate,
    });
    l = admitRecovery(l, admission);
    if (admission.outcome === "admitted") {
      const input = { channel, caseId: admission.case.id, input: d.input };
      if (sources.some((x) => x.caseId === input.caseId && !isDeepStrictEqual(x, input)))
        l = fence(l, "Conflicting original operation inputs");
      else if (!sources.some((x) => x.caseId === input.caseId)) sources.push(input);
    }
  }
  const c = l.active;
  const s = c && sources.find((x) => x.caseId === c.id);
  if (c && !s) l = fence(l, "Missing original source");
  if (c && s && !l.inspectionFences.length) {
    const raw = update[s.channel];
    if (raw === null) {
      if (!assurance.verifiedHead || !assurance.verifiedReceipt || !l.decision)
        l = fence(l, "Missing independently verified completion receipt");
      else
        l = safelyTransition(l, () =>
          finishVerifiedRecovery(l, {
            status: "verified", caseId: c.id, sourceHeadSha: assurance.verifiedHead!,
            assurance: assurance.verifiedReceipt!,
          }, true),
        );
    } else if (object(raw)) {
      if (raw.phase === "continued") {
        if (!assurance.originalEffect)
          l = fence(l, "Original operation reconciliation was not authenticated");
        else {
          // The ORIGINAL schedule/verifier just reauthenticated the source
          // and effect under its existing job lock. A historical fence may
          // be reconsidered, but a Pi attempt is never reset or repeated.
          if (l.phase === "fenced" && l.decision?.action === "integrity-fence") {
            try {
              l = reassessFencedVerifiedOriginal(l, true);
              l = decideExistingRecovery({ recoveryLifecycle: l, recoverySources: sources });
            } catch {
              l = fence(l, "Original fenced effect has no verified safe continuation");
            }
          }
          if (!l.inspectionFences.length && l.phase !== "fenced")
            l = safelyTransition(l, () =>
              l.decision?.action === "continue-independent"
                ? deferRecoveryForIndependentWork(l)
                : recordRecoveryOutcome(
                    l,
                    { status: "reconciled", caseId: c.id, originalEffect: assurance.originalEffect! },
                    true,
                  ),
            );
        }
      } else if (raw.phase === "completed") {
        if (!assurance.verifiedHead || !assurance.verifiedReceipt || !l.decision)
          l = fence(l, "Protocol completion has no original source and verified effect receipt");
        else
          l = safelyTransition(l, () =>
            finishVerifiedRecovery(l, {
              status: "verified", caseId: c.id, sourceHeadSha: assurance.verifiedHead!,
              assurance: assurance.verifiedReceipt!,
            }, true),
          );
      } else if (raw.phase === "fenced" && assurance.authorControl) {
        l = l.decision
          ? safelyTransition(l, () =>
              decideRecovery(l, {
                schema: "noveltea-generation-recovery-decision/v1",
                caseId: c.id,
                checkedSourceHeadSha: c.origin.sourceHeadSha,
                evidence: c.evidence,
                action: "pause",
                reason: assurance.authorControl === "cancelled" ? "cancelled" : "author-pause",
              }),
            )
          : fence(l, "Author control was not checked before recovery admission");
      } else if (raw.phase === "operator-intervention") {
        l = l.decision && assurance.diagnosis
          ? safelyTransition(l, () => decideRecovery(l, {
              schema: "noveltea-generation-recovery-decision/v1",
              caseId: c.id,
              checkedSourceHeadSha: c.origin.sourceHeadSha,
              evidence: c.evidence,
              action: "diagnostic-stop",
              disposition: "operator-intervention",
              ...assurance.diagnosis!,
            }))
          : fence(l, "A diagnostic stop has no authenticated original Pi diagnosis receipt");
      } else if (raw.phase === "fenced" || raw.phase === "unsafe-evidence") {
        l = l.decision
          ? safelyTransition(l, () =>
              decideRecovery(l, {
                schema: "noveltea-generation-recovery-decision/v1",
                caseId: c.id,
                checkedSourceHeadSha: c.origin.sourceHeadSha,
                evidence: c.evidence,
                action: "integrity-fence",
                reason: "untrusted-receipt",
                requiredInspection: "Verify original adapter receipts and current source before any replay.",
              }),
            )
          : fence(l, "Original recovery was fenced before a controller decision");
      } else if (raw.phase === "protocol-exhausted") {
        l = l.decision
          ? safelyTransition(l, () =>
              decideRecovery(l, {
                schema: "noveltea-generation-recovery-decision/v1",
                caseId: c.id,
                checkedSourceHeadSha: c.origin.sourceHeadSha,
                evidence: c.evidence,
                action: "exhausted",
                reason: "protocol-exhausted",
                attemptRefs: [],
              }),
            )
          : fence(l, "Original protocol exhausted before controller decision");
      } else if (raw.phase === "resource-limit") {
        l = l.decision
          ? safelyTransition(l, () =>
              decideRecovery(l, {
                schema: "noveltea-generation-recovery-decision/v1",
                caseId: c.id,
                checkedSourceHeadSha: c.origin.sourceHeadSha,
                evidence: c.evidence,
                action: "pause",
                reason: "budget",
              }),
            )
          : fence(l, "Original resource pause is not admitted");
      }
    }
  }
  return { recoveryLifecycle: l, recoverySources: sources };
}
