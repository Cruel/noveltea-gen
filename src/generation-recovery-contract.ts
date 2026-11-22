/**
 * C01 design contract for the single generation-graph recovery lifecycle.
 *
 * This file is deliberately type-only. C02 will implement the persisted
 * checkpoint adapter; no value in this shape is a write/approval grant.
 * Git, Pi transcripts, Review cycles and the Repair ledger remain authoritative.
 * See docs/generation-recovery-contract.md (#238).
 */
export type RecoveryOrigin = {
  jobId: string;
  /** The LangGraph Thread, not a replacement Thread created on recovery. */
  graphThreadId: string;
  /** Original job Thread identity, checked separately from the graph cursor. */
  jobThreadId: string;
  turnDigest: string | null;
  planVersion: number | null;
  /** May be null only while evidence cannot establish a trustworthy HEAD. */
  sourceHeadSha: string | null;
  assignmentId: string | null;
  /** Stable name of the original operation and its versioned failed check. */
  operation: string;
  check: string;
  checkVersion: number;
};

export type RecoveryEvidence = {
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
};

export type RecoveryCase = Readonly<{
  schema: "noveltea-generation-recovery-case/v1";
  /** Digest of canonical origin + failure-kind/check + ordered evidence refs.
   * Error prose and graph attempt ordinal MUST NOT affect identity. */
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
  (
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
        reason:
          | "untrusted-source"
          | "untrusted-receipt"
          | "ambiguous-writer"
          | "conflicting-cases"
          | "unsupported-legacy";
        requiredInspection: string;
      }
  );

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
