/**
 * C01 design contract for the single generation-graph recovery lifecycle.
 *
 * This file is deliberately type-only. C02 will implement the persisted
 * checkpoint adapter; no value in this shape is a write/approval grant.
 * Git, Pi transcripts, Review cycles and the Repair ledger remain authoritative.
 * See docs/generation-recovery-contract.md (#238).
 */
export type RecoveryOrigin = Readonly<{
  jobId: string;
  /** The LangGraph Thread, not a replacement Thread created on recovery. */
  graphThreadId: string;
  /** Original job Thread identity, checked separately from the graph cursor. */
  jobThreadId: string;
  /** Trusted original Turn and source; missing proof belongs in an inspection fence. */
  turnDigest: string;
  planVersion: number | null;
  sourceHeadSha: string;
  assignmentId: string | null;
  /** Stable name of the original operation and its versioned failed check. */
  operation: string;
  check: string;
  checkVersion: number;
  /** Authenticated original failed-check execution, NOT a graph resume ordinal. */
  failureAnchor: RecoveryFailureAnchor;
}>;

export type RecoveryEvidence = Readonly<{
  /** Only an identifier: the authority lives in the existing receipt store. */
  store:
    | "graph-checkpoint"
    | "specialist-receipt"
    | "response-contract"
    | "review-checkpoint"
    | "repair-ledger"
    | "dependency-plan"
    | "author-updates"
    | "idea-placement"
    | "completion-report"
    | "pi-session"
    | "git";
  ref: string;
  digest?: string;
}>;

/** Canonical identity anchor from the ORIGINAL failure receipt or task checkpoint.
 * A later observation/response/changed HEAD never replaces this anchor. */
export type RecoveryFailureAnchor = Readonly<{
  store: RecoveryEvidence["store"];
  ref: string;
  /** Stable original operation/check invocation, authenticated by that store. */
  failedCheckInstanceId: string;
}>;

/** Unsafe provenance is NOT an admitted case or a RecoveryDecision. Retain all
 * available proof for read-only inspection without inventing a case ID. */
export type RecoveryInspectionFence = Readonly<{
  schema: "noveltea-generation-recovery-inspection-fence/v1";
  reason:
    | "untrusted-source"
    | "untrusted-receipt"
    | "ambiguous-writer"
    | "conflicting-cases"
    | "missing-original-failure";
  observedOrigin: Readonly<Partial<RecoveryOrigin>>;
  evidence: readonly RecoveryEvidence[];
  /** May be null when the graph never admitted the original operation. */
  checkpointRef: RecoveryEvidence | null;
  requiredInspection: string;
}>;

export type RecoveryAdmission =
  | Readonly<{ outcome: "admitted"; case: RecoveryCase }>
  | Readonly<{ outcome: "fenced"; fence: RecoveryInspectionFence }>;

export type RecoveryCase = Readonly<{
  schema: "noveltea-generation-recovery-case/v1";
  /** Digest of canonical original-failure identity/anchor ONLY. Later evidence,
   * classification, graph replay and revised source MUST NOT reset entitlement. */
  id: string;
  origin: RecoveryOrigin;
  kind:
    | "semantic"
    | "protocol"
    | "infrastructure"
    | "authorization"
    | "resource"
    | "execution-control"
    | "integrity";
  /** A returned negative outcome must not be confused with a thrown error. */
  observation:
    | "exception"
    | "returned-failure"
    | "preflight-refusal"
    | "failed-review"
    | "incomplete-inventory"
    | "reconciliation";
  effect: "no-effects" | "read-only" | "settled-no-write" | "verified-commit" | "writer-effects-uncertain";
  /** Admission proof, immutable; subsequent observations belong to linked
   * receipts/decisions, never the canonical original-failure identity. */
  evidence: readonly RecoveryEvidence[];
  /** A related, earlier case is a link, not copied work history. */
  causedByCaseId?: string;
}>;

type RecoveryDecisionBase = Readonly<{
  schema: "noveltea-generation-recovery-decision/v1";
  caseId: string;
  /** Revalidate this HEAD/check against trusted stores before effects. */
  checkedSourceHeadSha: string | null;
  evidence: readonly RecoveryEvidence[];
}>;

/** Precisely one selected controller disposition; none of these is an
 * autonomous right to write or to count a model call as executed. */
export type RecoveryDecision = RecoveryDecisionBase &
  Readonly<
    | {
        action: "known-correction";
        adapter: "response-contract" | "review-cycle" | "known-verifier-fix" | "native-revalidation";
        receipt: RecoveryEvidence;
      }
    | {
        action: "plan-amendment";
        owner: string;
        scopeRef: RecoveryEvidence;
        adapter:
          | "dependency-work"
          | "causal-amendment"
          | "adaptive-work"
          | "review-other-owner"
          | "cross-domain-closeout";
      }
    | {
        action: "diagnostic";
        adapter: "unknown-diagnostic";
        mode: "read-only";
        /** Must be verified as STARTED and SETTLED before fulfilling the attempt invariant. */
        attemptRef: RecoveryEvidence | null;
      }
    | {
        action: "reconcile-effects";
        adapter: "original-specialist" | "idea-placement" | "checkpoint-reconciliation" | "response-contract";
        originalRef: RecoveryEvidence;
      }
    | { action: "continue-independent"; inventoryRef: RecoveryEvidence; blockedAssignmentId: string }
    | { action: "diagnostic-stop"; disposition: "operator-intervention" }
    | {
        action: "pause";
        reason:
          | "author-choice"
          | "protected-approval"
          | "author-pause"
          | "cancelled"
          | "budget"
          | "provider-unavailable";
        resumeRef?: RecoveryEvidence;
      }
    | {
        action: "exhausted";
        reason: "protocol-exhausted" | "nonconverging" | "resource-ceiling";
        attemptRefs: readonly RecoveryEvidence[];
      }
    | {
        action: "integrity-fence";
        reason: "untrusted-source" | "untrusted-receipt" | "ambiguous-writer" | "conflicting-cases";
        requiredInspection: string;
      }
  >;

/** An invocation index, not a copy of Pi responses, call budget or repair history.
 * The first failed specialist, scheduled task, and assessment are never
 * correction attempts. An invocation is counted as a correction-agent attempt
 * only when startedRef proves the diagnostic/corrective model actually ran. */
export type RecoveryAttempt = Readonly<{
  id: string;
  caseId: string;
  /** Unique source-bound invocation, stable across restart, NOT a retry reset. */
  invocationId: string;
  purpose: "diagnosis" | "correction" | "protocol";
  mode: "read-only" | "format-only" | "bounded-writer";
  phase: "prepared" | "started" | "settled" | "uncertain";
  startedRef: RecoveryEvidence | null;
  settledRef: RecoveryEvidence | null;
}>;

/** A normalized result of an EXISTING authority-specific adapter. C02/C03
 * implement its dispatch, not this type-only C01 specification. */
export type RecoveryAdapterOutcome =
  | Readonly<{ status: "prepared"; caseId: string; admission: RecoveryEvidence }>
  | Readonly<{ status: "reconciled"; caseId: string; originalEffect: RecoveryEvidence }>
  | Readonly<{ status: "started"; caseId: string; attempt: RecoveryAttempt }>
  | Readonly<{ status: "verified"; caseId: string; sourceHeadSha: string; assurance: RecoveryEvidence }>
  | Readonly<{ status: "stopped"; caseId: string; decision: RecoveryDecision }>;

/** Checkpoint data for C02, not a second side-effect or semantic issue ledger. */
export type RecoveryLifecycle = Readonly<{
  schema: "noveltea-generation-recovery/v1";
  /** Oldest eligible case owns the mutation lane; other cases stay pending. */
  active: RecoveryCase | null;
  pending: readonly RecoveryCase[];
  /** No caseId or decision exists for an unauthenticated admission. These
   * inspection-only fences block mutation and survive resume independently. */
  inspectionFences: readonly RecoveryInspectionFence[];
  /** The decision is durable before invoking the original assessor. Routing
   * reads this flag, never a user-visible reason or a second graph channel. */
  assessorPending?: boolean;
  phase:
    | "idle"
    | "assessing"
    | "reconciling"
    | "diagnosing"
    | "correcting"
    | "verifying"
    | "paused"
    | "fenced"
    | "resolved";
  decision: RecoveryDecision | null;
  /** The receipt is evidence of execution; phase alone never counts an agent attempt. */
  attempt: RecoveryAttempt | null;
}>;
