/** C02 checkpoint mechanics for the C01 generation recovery contract.
 * This module owns only source-linked routing projections. It does not read
 * Pi messages, create Git commits, grant scope, or replace specialist receipts.
 * Every effect-bearing transition requires independent controller proof.
 */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseRecoveryDiagnosticProposal } from "./recovery-diagnostic-proposal.js";
import type {
  RecoveryAdmission,
  RecoveryAdapterOutcome,
  RecoveryAttempt,
  RecoveryCase,
  RecoveryDecision,
  RecoveryEvidence,
  RecoveryInspectionFence,
  RecoveryLifecycle,
  RecoveryDischarge,
  RecoveryOrigin,
} from "./generation-recovery-contract.js";

const schema = "noveltea-generation-recovery/v1" as const;
const hex40 = /^[a-f0-9]{40}$/;
const hex64 = /^[a-f0-9]{64}$/;
const populated = (value: unknown): value is string =>
  typeof value === "string" && !!value.trim() && value.length <= 4096;
const stores = new Set<RecoveryEvidence["store"]>([
  "graph-checkpoint",
  "specialist-receipt",
  "response-contract",
  "review-checkpoint",
  "repair-ledger",
  "dependency-plan",
  "author-updates",
  "idea-placement",
  "completion-report",
  "pi-session",
  "git",
]);

/** The original-failure tuple is versioned and JSON length/escape-delimited.
 * It deliberately excludes current HEAD, evidence order, kind, attempts and
 * reclassification. Never use the current graph cursor as an identity. */
export function recoveryCaseId(origin: RecoveryOrigin): string {
  const a = origin.failureAnchor;
  const tuple = [
    "noveltea-generation-recovery-case/v1",
    origin.jobId,
    origin.jobThreadId,
    origin.graphThreadId,
    origin.turnDigest,
    origin.planVersion,
    origin.sourceHeadSha,
    origin.assignmentId,
    origin.operation,
    origin.check,
    origin.checkVersion,
    a.store,
    a.ref,
    a.failedCheckInstanceId,
  ];
  if (!validOrigin(origin)) throw Error("Untrusted original failure identity");
  return createHash("sha256").update(JSON.stringify(tuple)).digest("hex");
}

function validEvidence(value: unknown): value is RecoveryEvidence {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<RecoveryEvidence>;
  return (
    stores.has(v.store!) &&
    populated(v.ref) &&
    (v.digest === undefined || (typeof v.digest === "string" && hex64.test(v.digest)))
  );
}
function validOrigin(value: unknown): value is RecoveryOrigin {
  if (!value || typeof value !== "object") return false;
  const o = value as Partial<RecoveryOrigin>;
  const a = o.failureAnchor;
  return (
    populated(o.jobId) &&
    populated(o.jobThreadId) &&
    populated(o.graphThreadId) &&
    typeof o.turnDigest === "string" &&
    hex64.test(o.turnDigest) &&
    (o.planVersion === null || (Number.isSafeInteger(o.planVersion) && o.planVersion! >= 1)) &&
    typeof o.sourceHeadSha === "string" &&
    hex40.test(o.sourceHeadSha) &&
    (o.assignmentId === null || populated(o.assignmentId)) &&
    populated(o.operation) &&
    populated(o.check) &&
    Number.isSafeInteger(o.checkVersion) &&
    o.checkVersion! >= 1 &&
    !!a &&
    stores.has(a.store) &&
    populated(a.ref) &&
    populated(a.failedCheckInstanceId)
  );
}
function validCase(c: RecoveryCase): boolean {
  try {
    return (
      c.schema === "noveltea-generation-recovery-case/v1" &&
      Array.isArray(c.evidence) &&
      c.evidence.every(validEvidence) &&
      [
        "semantic",
        "protocol",
        "infrastructure",
        "authorization",
        "resource",
        "execution-control",
        "integrity",
      ].includes(c.kind) &&
      [
        "exception",
        "returned-failure",
        "preflight-refusal",
        "failed-review",
        "incomplete-inventory",
        "reconciliation",
      ].includes(c.observation) &&
      ["no-effects", "read-only", "settled-no-write", "verified-commit", "writer-effects-uncertain"].includes(
        c.effect,
      ) &&
      (!c.causedByCaseId || hex64.test(c.causedByCaseId)) &&
      c.id === recoveryCaseId(c.origin)
    );
  } catch {
    return false;
  }
}

/** Persisted checkpoint JSON is untyped. Reject malformed discriminants even
 * if a caller passes an apparently trusted TypeScript object. */
function validDecision(value: unknown): value is RecoveryDecision {
  if (!value || typeof value !== "object") return false;
  const d = value as RecoveryDecision;
  if (
    d.schema !== "noveltea-generation-recovery-decision/v1" ||
    !hex64.test(d.caseId) ||
    (d.checkedSourceHeadSha !== null &&
      (typeof d.checkedSourceHeadSha !== "string" || !hex40.test(d.checkedSourceHeadSha))) ||
    !Array.isArray(d.evidence) ||
    !d.evidence.every(validEvidence)
  )
    return false;
  switch (d.action) {
    case "known-correction":
      return (
        ["response-contract", "review-cycle", "known-verifier-fix", "native-revalidation", "assignment-diagnostic"].includes(
          d.adapter,
        ) && validEvidence(d.receipt) &&
        (d.reviewAssessment === undefined || d.adapter === "review-cycle" &&
          ["diagnostic", "dispute", "author-revision", "scope"].includes(d.reviewAssessment.kind) &&
          hex40.test(d.reviewAssessment.sourceSha) && hex64.test(d.reviewAssessment.digest))
      );
    case "plan-amendment":
      return (
        populated(d.owner) &&
        validEvidence(d.scopeRef) &&
        [
          "dependency-work",
          "causal-amendment",
          "adaptive-work",
          "review-other-owner",
          "cross-domain-closeout",
        ].includes(d.adapter)
      );
    case "diagnostic":
      return (
        d.adapter === "unknown-diagnostic" &&
        d.mode === "read-only" &&
        (d.attemptRef === null || validEvidence(d.attemptRef))
      );
    case "reconcile-effects":
      return (
        ["original-specialist", "idea-placement", "checkpoint-reconciliation", "response-contract"].includes(
          d.adapter,
        ) && validEvidence(d.originalRef)
      );
    case "continue-independent":
      return validEvidence(d.inventoryRef) && populated(d.blockedAssignmentId);
    case "strategy-unresolved":
      return ["planning-needed", "authorization-refused", "support-review-negative", "unsupported-implementation"].includes(d.reason) &&
        validEvidence(d.scopeRef) && validEvidence(d.receipt) &&
        !!d.scopeRef.digest && !!d.receipt.digest;
    case "diagnostic-stop":
      if (d.disposition !== "operator-intervention" ||
          d.receipt?.store !== "response-contract" || !validEvidence(d.receipt)) return false;
      if (d.proposal) {
        if (d.recommendation !== undefined || d.advisoryCategory !== undefined) return false;
        try {
          const proof = d.evidence.at(-1);
          return !!proof?.digest && !!d.proposal.signature &&
            !!parseRecoveryDiagnosticProposal(JSON.stringify(d.proposal), {
              signature: d.proposal.signature,
              proofRef: [proof.store, proof.ref, proof.digest].join(":"),
            });
        } catch { return false; }
      }
      return ["operator-intervention", "inspect-existing-receipt"].includes(d.recommendation!) &&
        ["software", "unclassified", "resources", "integrity"].includes(d.advisoryCategory!);
    case "pause":
      return (
        [
          "author-choice",
          "protected-approval",
          "author-pause",
          "cancelled",
          "budget",
          "provider-unavailable",
        ].includes(d.reason) &&
        (d.resumeRef === undefined || validEvidence(d.resumeRef))
      );
    case "exhausted":
      return (
        ["protocol-exhausted", "nonconverging", "resource-ceiling"].includes(d.reason) &&
        Array.isArray(d.attemptRefs) &&
        d.attemptRefs.every(validEvidence) &&
        (d.reviewAssessment === undefined || d.reason === "nonconverging" &&
          ["diagnostic", "dispute"].includes(d.reviewAssessment.kind) &&
          hex40.test(d.reviewAssessment.sourceSha) && hex64.test(d.reviewAssessment.digest))
      );
    case "integrity-fence":
      return (
        ["untrusted-source", "untrusted-receipt", "ambiguous-writer", "conflicting-cases"].includes(
          d.reason,
        ) && populated(d.requiredInspection)
      );
    default:
      return false;
  }
}
function validAttempt(value: unknown): value is RecoveryAttempt {
  if (!value || typeof value !== "object") return false;
  const a = value as RecoveryAttempt;
  return (
    populated(a.id) &&
    hex64.test(a.caseId) &&
    populated(a.invocationId) &&
    ["diagnosis", "correction", "protocol"].includes(a.purpose) &&
    ["read-only", "format-only", "bounded-writer"].includes(a.mode) &&
    ["prepared", "started", "settled", "uncertain"].includes(a.phase) &&
    (a.phase === "prepared" || validEvidence(a.startedRef)) &&
    (a.phase !== "settled" || validEvidence(a.settledRef))
  );
}

/** Shared bounded-assignment assessment before domain-specific execution.
 * Adapters authenticate the original check and diagnostic receipts; this policy
 * does not grant a model invocation, invent a Job, or waive a failed check. */
export function assessBoundedAssignmentFailure(
  observation: "protocol-exhausted" | "nonconverging" | "reviewer-drift",
  diagnosis?: "continue" | "stop" | "disputed" | "replace-reviewer",
): "exhausted" | "diagnostic" | "known-correction" | "integrity-fence" | "replace-reviewer" {
  if (observation === "protocol-exhausted") return "exhausted";
  if (!diagnosis) return "diagnostic";
  // Only a domain-authenticated dispute with an exact negative predecessor
  // can request replacement. Admission is not a passing verdict.
  if (diagnosis === "replace-reviewer") return "replace-reviewer";
  if (observation === "reviewer-drift" || diagnosis === "disputed") return "integrity-fence";
  return diagnosis === "continue" ? "known-correction" : "exhausted";
}

export function emptyRecoveryLifecycle(): RecoveryLifecycle {
  return {
    schema,
    active: null,
    pending: [],
    discharged: [],
    inspectionFences: [],
    phase: "idle",
    decision: null,
    attempt: null,
  };
}

export function inspectionFence(
  reason: RecoveryInspectionFence["reason"],
  observedOrigin: Partial<RecoveryOrigin>,
  evidence: readonly RecoveryEvidence[],
  checkpointRef: RecoveryEvidence | null,
  requiredInspection: string,
): RecoveryInspectionFence {
  return {
    schema: "noveltea-generation-recovery-inspection-fence/v1",
    reason,
    observedOrigin,
    evidence,
    checkpointRef,
    requiredInspection,
  };
}

type AdmissionInput = {
  origin: RecoveryOrigin;
  kind: RecoveryCase["kind"];
  observation: RecoveryCase["observation"];
  effect: RecoveryCase["effect"];
  evidence: readonly RecoveryEvidence[];
  causedByCaseId?: string;
  /** Must authenticate the ORIGINAL task/check and its immutable receipt,
   * job/Thread/Turn/HEAD, not a caller-supplied or reinspection-only digest. */
  authenticate: (origin: RecoveryOrigin, evidence: readonly RecoveryEvidence[]) => Promise<boolean>;
};
export async function recoveryAdmission(input: AdmissionInput): Promise<RecoveryAdmission> {
  const observed = input.origin;
  const checkpointRef =
    observed?.failureAnchor &&
    stores.has(observed.failureAnchor.store) &&
    populated(observed.failureAnchor.ref)
      ? { store: observed.failureAnchor.store, ref: observed.failureAnchor.ref }
      : null;
  const fence = (reason: RecoveryInspectionFence["reason"]) => ({
    outcome: "fenced" as const,
    fence: inspectionFence(
      reason,
      observed ?? {},
      input.evidence ?? [],
      checkpointRef,
      "Authenticate the original failed-check invocation, checkpoint, source HEAD and Turn before replay.",
    ),
  });
  if (!validOrigin(observed)) return fence("missing-original-failure");
  if (!Array.isArray(input.evidence) || !input.evidence.every(validEvidence))
    return fence("untrusted-receipt");
  try {
    if (!(await input.authenticate(observed, input.evidence))) return fence("untrusted-source");
  } catch {
    return fence("untrusted-source");
  }
  const c: RecoveryCase = {
    schema: "noveltea-generation-recovery-case/v1",
    id: recoveryCaseId(observed),
    origin: observed,
    kind: input.kind,
    observation: input.observation,
    effect: input.effect,
    evidence: input.evidence,
    ...(input.causedByCaseId ? { causedByCaseId: input.causedByCaseId } : {}),
  };
  if (!validCase(c)) return fence("untrusted-receipt");
  return { outcome: "admitted", case: c };
}

/** An original failed-check invocation is one obligation even when a later
 * observer sees it at a new HEAD. Distinct genuine invocations are queued.
 * No case, decision, started attempt or pending incident is overwritten. */
function sameAnchor(a: RecoveryCase, b: RecoveryCase): boolean {
  return (
    a.origin.jobId === b.origin.jobId && isDeepStrictEqual(a.origin.failureAnchor, b.origin.failureAnchor)
  );
}
function sameFailure(a: RecoveryCase, b: RecoveryCase): boolean {
  return (
    sameAnchor(a, b) &&
    a.origin.jobThreadId === b.origin.jobThreadId &&
    a.origin.graphThreadId === b.origin.graphThreadId &&
    a.origin.turnDigest === b.origin.turnDigest &&
    a.origin.planVersion === b.origin.planVersion &&
    a.origin.assignmentId === b.origin.assignmentId &&
    a.origin.operation === b.origin.operation &&
    a.origin.check === b.origin.check &&
    a.origin.checkVersion === b.origin.checkVersion
  );
}
export function admitRecovery(state: RecoveryLifecycle, admission: RecoveryAdmission): RecoveryLifecycle {
  if (admission.outcome === "fenced") {
    const fences = state.inspectionFences.some((f) => isDeepStrictEqual(f, admission.fence))
      ? state.inspectionFences
      : [...state.inspectionFences, admission.fence];
    return { ...state, inspectionFences: fences, phase: "fenced" };
  }
  const item = admission.case;
  if (!validCase(item)) throw Error("Invalid or fabricated recovery case identity");
  const incumbent = [state.active, ...state.pending, ...state.discharged.map(entry => entry.case)]
    .filter((c): c is RecoveryCase => !!c)
    .find((c) => sameAnchor(c, item));
  if (incumbent && !sameFailure(incumbent, item))
    return admitRecovery(state, {
      outcome: "fenced",
      fence: inspectionFence(
        "conflicting-cases",
        item.origin,
        item.evidence,
        { store: item.origin.failureAnchor.store, ref: item.origin.failureAnchor.ref },
        "The same original failure anchor claims inconsistent Turn, plan, assignment or check provenance.",
      ),
    });
  if (incumbent) return state; // Preserve original source, decision and attempts.
  if (state.inspectionFences.length) return { ...state, pending: [...state.pending, item], phase: "fenced" };
  if (!state.active) return { ...state, active: item, phase: "assessing", decision: null, attempt: null };
  return { ...state, pending: [...state.pending, item] };
}

function phaseForDecision(decision: RecoveryDecision): RecoveryLifecycle["phase"] {
  switch (decision.action) {
    case "known-correction":
    case "plan-amendment":
      return "correcting";
    case "diagnostic":
      return "diagnosing";
    case "reconcile-effects":
      return "reconciling";
    case "continue-independent":
      return "assessing"; // Pending obligation cannot be discharged.
    case "pause":
      return "paused";
    case "exhausted":
    case "integrity-fence":
    case "strategy-unresolved":
    case "diagnostic-stop":
      return "fenced";
  }
}
/** Decision admission is not an adapter execution or writer grant. */
export function decideRecovery(state: RecoveryLifecycle, decision: RecoveryDecision): RecoveryLifecycle {
  if (state.inspectionFences.length || state.phase === "fenced")
    throw Error("Recovery is fenced; verify original provenance before decision admission");
  if (!state.active || decision.caseId !== state.active.id || !validDecision(decision))
    throw Error("Recovery decision does not match authenticated active case");
  if (decision.checkedSourceHeadSha !== null && !hex40.test(decision.checkedSourceHeadSha))
    throw Error("Recovery decision has invalid checked source");
  if (
    state.phase !== "assessing" &&
    state.phase !== "reconciling" &&
    state.phase !== "diagnosing" &&
    state.phase !== "correcting"
  )
    throw Error("Recovery decision cannot supersede verified or terminal phase");
  // A decision cannot retroactively claim a model attempt merely by pointing
  // at an unchecked Pi receipt.
  if (
    decision.action === "diagnostic" &&
    decision.attemptRef &&
    (!state.attempt ||
      state.attempt.phase === "prepared" ||
      !isDeepStrictEqual(decision.attemptRef, state.attempt.startedRef))
  )
    throw Error("Diagnostic decision cannot invent a started model invocation");
  // Reentry must preserve previously admitted action and model attempt.
  if (
    state.attempt &&
    state.attempt.phase !== "settled" &&
    state.decision &&
    !isDeepStrictEqual(state.decision, decision)
  )
    throw Error("An original started invocation cannot be replaced by another decision");
  return { ...state, decision, phase: phaseForDecision(decision) };
}

/** Evidence is verified by an *external* source authority, never by merely
 * presenting the new status in a graph update. */
export function recordRecoveryOutcome(
  state: RecoveryLifecycle,
  outcome: RecoveryAdapterOutcome,
  authenticated: boolean,
): RecoveryLifecycle {
  if (!authenticated) throw Error("Recovery adapter outcome lacks original-source authentication");
  if (
    !state.active ||
    outcome.caseId !== state.active.id ||
    state.inspectionFences.length ||
    ["fenced", "paused", "idle", "resolved"].includes(state.phase)
  )
    throw Error("Recovery outcome is paused, fenced, resolved or source-mismatched");
  if (outcome.status === "prepared") {
    if (!validEvidence(outcome.admission)) throw Error("Invalid recovery admission evidence");
    return state;
  }
  if (outcome.status === "started") {
    const attempt = outcome.attempt;
    if (attempt.caseId !== state.active.id || !validAttempt(attempt))
      throw Error("Missing original Pi invocation or invalid attempt evidence");
    if (
      state.attempt &&
      (state.attempt.id !== attempt.id ||
        state.attempt.invocationId !== attempt.invocationId ||
        state.attempt.caseId !== attempt.caseId ||
        state.attempt.purpose !== attempt.purpose ||
        state.attempt.mode !== attempt.mode ||
        (state.attempt.startedRef && !isDeepStrictEqual(state.attempt.startedRef, attempt.startedRef)) ||
        (state.attempt.settledRef && !isDeepStrictEqual(state.attempt.settledRef, attempt.settledRef)))
    )
      throw Error("Attempt would replace the original invocation");
    if (
      state.decision?.action === "diagnostic" &&
      (attempt.purpose !== "diagnosis" || attempt.mode !== "read-only")
    )
      throw Error("Diagnostic recovery cannot grant a writer invocation");
    if (
      (state.attempt &&
        ["started", "settled", "uncertain"].includes(state.attempt.phase) &&
        attempt.phase === "prepared") ||
      (state.attempt?.phase === "settled" && attempt.phase !== "settled")
    )
      throw Error("Attempt cannot reset a previously started or settled invocation");
    return { ...state, attempt };
  }
  if (outcome.status === "stopped") return decideRecovery(state, outcome.decision);
  if (outcome.status === "reconciled") {
    if (!validEvidence(outcome.originalEffect)) throw Error("Invalid original-effect proof");
    return { ...state, phase: "verifying" };
  }
  if (outcome.status === "verified") {
    if (!hex40.test(outcome.sourceHeadSha) || !validEvidence(outcome.assurance) || !state.decision)
      throw Error("Missing decision or verified Git/native/Review assurance");
    if (state.attempt && state.attempt.phase !== "settled" && state.attempt.phase !== "prepared")
      throw Error("Original in-flight invocation must settle before verified recovery");
    if (
      state.decision.action === "continue-independent" ||
      state.decision.action === "exhausted" ||
      state.decision.action === "pause" ||
      state.decision.action === "integrity-fence" ||
      state.decision.action === "strategy-unresolved" ||
      state.decision.action === "diagnostic-stop"
    )
      throw Error("A stopped or independent action cannot discharge a source obligation");
    return { ...state, phase: "resolved" };
  }
  return state;
}
/** Advance only after independently verified resolution. A pending case
 * retains its own source and is reassessed before dispatch. */
export function finishRecovery(state: RecoveryLifecycle): RecoveryLifecycle {
  if (state.phase !== "resolved" || !state.active || state.inspectionFences.length)
    throw Error("Recovery has not been independently resolved");
  const index = state.pending.findIndex(item => !state.deferredCaseIds?.includes(item.id));
  const next = state.pending[index];
  return {
    ...state,
    active: next ?? null,
    pending: state.pending.filter((_, i) => i !== index),
    phase: next ? "assessing" : "idle",
    decision: null,
    attempt: null,
    assessorPending: false,
  };
}

/** One verified disposition is the only active-case exit into the original
 * scheduler. The original case, exact successor HEAD and source receipt remain
 * in the SAME lifecycle for restart authentication and attempt deduplication.
 * The existing native/Review/owner adapter must authenticate before calling. */
export function finishVerifiedRecovery(
  state: RecoveryLifecycle,
  outcome: Extract<RecoveryAdapterOutcome, { status: "verified" }>,
  authenticated: boolean,
): RecoveryLifecycle {
  const verified = recordRecoveryOutcome(state, outcome, authenticated);
  const original = verified.active!;
  if (verified.discharged.some(entry => sameAnchor(entry.case, original)))
    throw Error("Verified recovery would duplicate an original failure disposition");
  // An independently deferred case must remain pending until the original
  // and later correction receipts prove discharge at the parent boundary.
  const completed = finishRecovery(verified);
  return { ...completed, discharged: [...completed.discharged, {
    case: original, correction: outcome.assurance, correctedHeadSha: outcome.sourceHeadSha,
    disposition: "active-verified" as const,
  }] };
}

/** Independent work may proceed, but the unresolved case stays pending and
 * completion must remain gated. No correction entitlement is consumed. */
export function deferRecoveryForIndependentWork(state: RecoveryLifecycle): RecoveryLifecycle {
  if (
    !state.active ||
    state.decision?.action !== "continue-independent" ||
    state.inspectionFences.length ||
    state.phase !== "assessing" ||
    state.attempt
  )
    throw Error("Independent continuation requires proved no-write routing");
  return {
    ...state,
    active: null,
    pending: [...state.pending, state.active],
    deferredCaseIds: [...(state.deferredCaseIds ?? []), state.active.id],
    phase: "idle",
    decision: null,
    attempt: null,
    assessorPending: false,
  };
}

/** A later independently verified specialist/idea correction discharges the
 * original deferred case without selecting, reassessing or replaying its
 * failed operation. Authentication belongs to the original receipt owners. */
export function dischargePendingRecovery(
  state: RecoveryLifecycle, discharge: RecoveryDischarge, authenticated: boolean,
): RecoveryLifecycle {
  if (!authenticated || state.active || state.phase !== "idle" ||
      state.inspectionFences.length || state.attempt || state.decision ||
      !validCase(discharge.case) || !validEvidence(discharge.correction) ||
      !hex40.test(discharge.correctedHeadSha))
    throw Error("Deferred resolution requires independently verified original and correction receipts");
  const pending = state.pending.find(c => c.id === discharge.case.id);
  if (!pending || !state.deferredCaseIds?.includes(pending.id) || !isDeepStrictEqual(pending, discharge.case) ||
      state.discharged.some(entry => entry.case.id === discharge.case.id))
    throw Error("A deferred resolution cannot replace an unrelated or discharged obligation");
  return { ...state, pending: state.pending.filter(c => c.id !== pending.id),
    deferredCaseIds: state.deferredCaseIds.filter(id => id !== pending.id),
    discharged: [...state.discharged, discharge] };
}

/** The scheduler supplies a current-source eligibility predicate. Merely
 * observing a new HEAD never licenses retrying an old failed specialist. */
export function selectPendingRecovery(
  state: RecoveryLifecycle,
  eligible: (item: RecoveryCase) => boolean,
): RecoveryLifecycle {
  if (state.active || state.phase !== "idle" || state.inspectionFences.length)
    throw Error("Cannot select a pending case while a mutation lane is owned or fenced");
  const index = state.pending.findIndex(eligible);
  if (index < 0) return state;
  const caseFile = state.pending[index]!;
  return {
    ...state,
    active: caseFile,
    pending: state.pending.filter((_, i) => i !== index),
    ...(state.deferredCaseIds ? { deferredCaseIds: state.deferredCaseIds.filter(id => id !== caseFile.id) } : {}),
    phase: "assessing",
    decision: null,
    attempt: null,
    assessorPending: false,
  };
}

/** A previously fenced ORIGINAL read-only check may be reassessed after
 * independently authenticated repair, without new writer or Pi entitlement.
 * Exhausted protocols, missing provenance and attempted invocations are
 * never eligible for this path. The caller MUST already have verified the
 * original source and proved that no writer can be retried by reassessment. */
export function reassessFencedReadOnlyRecovery(
  state: RecoveryLifecycle,
  authenticated: boolean,
): RecoveryLifecycle {
  if (
    !authenticated ||
    state.phase !== "fenced" ||
    !state.active ||
    !!state.attempt ||
    state.inspectionFences.length ||
    state.decision?.action !== "integrity-fence" ||
    !["scheduling", "author-update-intake"].includes(state.active.origin.operation)
  )
    throw Error("Fenced recovery cannot be reexamined without the original read-only source proof");
  return { ...state, phase: "assessing", decision: null };
}

/** An original source-bound verifier or specialist may prove it has already
 * reconciled its effects AFTER an older fence. This is never a lease: only
 * the already authenticated original effect can advance to verification.
 * The caller must verify the original receipt and source under the job lock.
 */
export function reassessFencedVerifiedOriginal(
  state: RecoveryLifecycle,
  authenticatedOriginalEffect: boolean,
): RecoveryLifecycle {
  if (
    !authenticatedOriginalEffect ||
    state.phase !== "fenced" ||
    !state.active ||
    !!state.attempt ||
    state.inspectionFences.length ||
    state.decision?.action !== "integrity-fence" ||
    !["commit-verification", "specialist-dispatch", "adaptive-admission"].includes(
      state.active.origin.operation,
    )
  )
    throw Error("Fenced original operation cannot acquire a new dispatch from a checkpoint phase");
  return { ...state, phase: "assessing", decision: null };
}

/** An actual typed controller resume is required after author/resource pause;
 * calling decideRecovery directly on a paused state cannot grant a lease. */
export function resumePausedRecovery(state: RecoveryLifecycle, authenticated: boolean): RecoveryLifecycle {
  if (
    !authenticated ||
    state.phase !== "paused" ||
    state.decision?.action !== "pause" ||
    state.decision.reason === "cancelled" ||
    !state.active ||
    state.inspectionFences.length
  )
    throw Error("Paused recovery needs authenticated author/resource resumption");
  return { ...state, phase: "assessing", decision: null };
}

type CurrentRecoveryReader = {
  current: unknown;
  request: { jobId: string; jobThreadId: string; graphThreadId: string; turnDigest: string | null };
  checkpointRef: RecoveryEvidence | null;
  authenticate: (origin: RecoveryOrigin, evidence: readonly RecoveryEvidence[]) => Promise<boolean>;
  authenticateAttempt?: (attempt: RecoveryAttempt) => Promise<boolean>;
  authenticateDecision?: (decision: RecoveryDecision) => Promise<boolean>;
  authenticateVerification?: (lifecycle: RecoveryLifecycle) => Promise<boolean>;
  authenticateCompletion?: (lifecycle: RecoveryLifecycle) => Promise<boolean>;
  authenticateDischarge?: (discharge: RecoveryDischarge) => Promise<boolean>;
};
/** Checkpointed routing phases must agree with the single selected
 * disposition. A forged phase can never turn a fence or pause into an
 * executable adapter, even if the decision fields themselves parse. */
function validLifecyclePhase(value: RecoveryLifecycle): boolean {
  const { active, phase, decision, pending, inspectionFences } = value;
  if (!active) {
    return (
      !decision && !value.attempt && (phase === "idle" || (phase === "fenced" && inspectionFences.length > 0))
    );
  }
  const unique = [active, ...pending];
  if (unique.some((c, i) => unique.findIndex((other) => sameAnchor(other, c)) !== i)) return false;
  if (inspectionFences.length) return phase === "fenced";
  switch (phase) {
    case "idle":
      return false;
    case "assessing":
      return !decision || decision.action === "continue-independent";
    case "reconciling":
      return decision?.action === "reconcile-effects";
    case "diagnosing":
      return decision?.action === "diagnostic";
    case "correcting":
      return decision?.action === "known-correction" || decision?.action === "plan-amendment";
    case "verifying":
    case "resolved":
      return (
        !!decision &&
        !["pause", "exhausted", "integrity-fence", "continue-independent", "diagnostic-stop", "strategy-unresolved"].includes(decision.action)
      );
    case "paused":
      return decision?.action === "pause";
    case "fenced":
      return decision?.action === "integrity-fence" || decision?.action === "exhausted" ||
        decision?.action === "diagnostic-stop" || decision?.action === "strategy-unresolved";
  }
}
/** Authenticate the current checkpoint, not an old schema.
 * Missing original proof preserves the observed state only as a read-only
 * inspection fence. A saved phase or Pi attempt never grants capabilities.
 */
export async function verifyRecoveryCheckpoint(input: CurrentRecoveryReader): Promise<RecoveryLifecycle> {
  let state = emptyRecoveryLifecycle();
  const value = input.current as RecoveryLifecycle;
  const cases = [value?.active, ...(Array.isArray(value?.pending) ? value.pending : []),
    ...(Array.isArray(value?.discharged) ? value.discharged.map(entry => entry?.case) : [])].filter(
    (c): c is RecoveryCase => !!c,
  );
  const structural =
    value?.schema === schema &&
    Array.isArray(value.pending) &&
    Array.isArray(value.discharged) &&
    Array.isArray(value.inspectionFences) &&
    value.active !== undefined &&
    (value.assessorPending === undefined || typeof value.assessorPending === "boolean") &&
    (!value.assessorPending || (!!value.active && !!value.decision &&
      (["reconciling", "diagnosing", "correcting"].includes(value.phase) ||
        (value.phase === "assessing" && value.decision.action === "continue-independent")))) &&
    value.decision !== undefined &&
    value.attempt !== undefined &&
    value.pending.every(validCase) &&
    (value.deferredCaseIds === undefined || (Array.isArray(value.deferredCaseIds) &&
      new Set(value.deferredCaseIds).size === value.deferredCaseIds.length &&
      value.deferredCaseIds.every(id => value.pending.some(c => c.id === id)))) &&
    value.discharged.every(entry => entry && validCase(entry.case) &&
      validEvidence(entry.correction) && hex40.test(entry.correctedHeadSha) &&
      (entry.disposition === undefined || entry.disposition === "active-verified")) &&
    new Set([...value.pending, ...(value.active ? [value.active] : []),
      ...value.discharged.map(entry => entry.case)].map(c => c.id)).size ===
      value.pending.length + (value.active ? 1 : 0) + value.discharged.length &&
    [...value.pending, ...(value.active ? [value.active] : []),
      ...value.discharged.map(entry => entry.case)].every((c, i, all) =>
        all.findIndex(other => sameAnchor(other, c)) === i) &&
    (value.active === null || validCase(value.active)) &&
    value.inspectionFences.every(
      (f) =>
        f?.schema === "noveltea-generation-recovery-inspection-fence/v1" &&
        Array.isArray(f.evidence) &&
        f.evidence.every(validEvidence),
    ) &&
    (!value.decision || (value.active?.id === value.decision.caseId && validDecision(value.decision))) &&
    (!value.attempt || (value.active?.id === value.attempt.caseId && validAttempt(value.attempt))) &&
    (!["reconciling", "diagnosing", "correcting", "verifying", "paused", "resolved"].includes(value.phase) ||
      !!value.decision) &&
    [
      "idle",
      "assessing",
      "reconciling",
      "diagnosing",
      "correcting",
      "verifying",
      "paused",
      "fenced",
      "resolved",
    ].includes(value.phase) &&
    (value.active !== null ||
      value.phase === "idle" ||
      (value.phase === "fenced" && value.inspectionFences.length > 0)) &&
    (value.active === null || value.phase !== "idle") &&
    (value.phase === "fenced" || !value.inspectionFences.length) &&
    validLifecyclePhase(value);
  let authenticated = structural;
  if (authenticated) {
    for (const c of cases) {
      if (
        c.origin.jobId !== input.request.jobId ||
        c.origin.jobThreadId !== input.request.jobThreadId ||
        c.origin.graphThreadId !== input.request.graphThreadId ||
        c.origin.turnDigest !== input.request.turnDigest ||
        !(await input.authenticate(c.origin, c.evidence))
      ) {
        authenticated = false;
        break;
      }
    }
    if (
      value.attempt &&
      value.attempt.phase !== "prepared" &&
      !(await input.authenticateAttempt?.(value.attempt))
    )
      authenticated = false;
    if (value.decision && !(await input.authenticateDecision?.(value.decision))) authenticated = false;
    for (const discharge of value.discharged)
      if (!(await input.authenticateDischarge?.(discharge))) authenticated = false;
    if (value.phase === "verifying" && !(await input.authenticateVerification?.(value)))
      authenticated = false;
    if (value.phase === "resolved" && !(await input.authenticateCompletion?.(value))) authenticated = false;
  }
  if (authenticated) state = value;
  else
    state = admitRecovery(state, {
      outcome: "fenced",
      fence: inspectionFence(
        "untrusted-receipt",
        {},
        [],
        input.checkpointRef,
        "Inspect original graph, Pi and source receipts before accepting this checkpoint.",
      ),
    });
  return state;
}
