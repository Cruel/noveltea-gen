/**
 * Checkpointable, bounded Generation assignment lifecycle (R01).
 *
 * This graph owns no Story scheduler, authorizations, RecoveryLifecycle, Pi
 * transcript, Git receipt, or review ledger. It checkpoints references to the
 * receipts owned by the production adapters, and returns a typed outcome to
 * the trusted Generation parent. An END result is a logical suspension, NOT
 * a pending LangGraph interrupt; only a live author_gate uses Command(resume).
 */
import { createHash } from "node:crypto";
import { Annotation, END, interrupt, START, StateGraph } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";

export type AssignmentIdentity = Readonly<{
  schema: "noveltea-assignment-identity/v1";
  jobId: string;
  jobThreadId: string;
  graphThreadId: string;
  turnDigest: string | null;
  assignmentId: string;
  planVersion: number | null;
  sourceHeadSha: string;
  scopeDigest: string;
}>;

/** Review cycles migrated to the common assessor. Native work-item IDs and
 * parent execution assignment IDs are distinct, so both forms are explicit. */
export function usesSharedAssignmentReview(workItem: string | undefined | null): boolean {
  return ["foundation", "foundations", "world-foundations", "character-foundations", "architecture", "global-architecture"].includes(workItem ?? "") ||
    /^interactive-(?:choice|puzzle)-[a-z][a-z0-9-]*$/.test(workItem ?? "") ||
    /^(?:interactive|choice|puzzle|event|composition):milestone\.[a-z][a-z0-9-]*$/.test(workItem ?? "") ||
    /^(?:event|composition)-[a-z][a-z0-9-]*$/.test(workItem ?? "") ||
    /^focus:[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(workItem ?? "");
}
/** Cutover registry: only lanes with the actual bounded Review adapter are
 * admitted here; the older policy registry alone is not proof of migration. */
export function usesCheckpointedReviewRounds(workItem: string): boolean {
  return ["foundation", "world-foundations", "character-foundations", "global-architecture"].includes(workItem) ||
    /^(?:interactive-(?:choice|puzzle)|event|composition)-[a-z][a-z0-9-]*$/.test(workItem) ||
    /^focus:[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(workItem);
}
/** Studio Discovery precedes any Generation job or Git write grant. */
export type DiscoveryAssignmentIdentity = Readonly<{
  schema: "noveltea-discovery-assignment/v1";
  graphThreadId: string;
  operationId: number;
  scopeDigest: string;
}>;

type LifecycleIdentity = AssignmentIdentity | DiscoveryAssignmentIdentity;

export function logicalAssignmentKey(identity: LifecycleIdentity): string {
  const fields = identity.schema === "noveltea-discovery-assignment/v1"
    ? [identity.schema, identity.graphThreadId, identity.operationId, identity.scopeDigest]
    : [identity.schema, identity.jobId, identity.jobThreadId,
    identity.graphThreadId, identity.turnDigest, identity.assignmentId,
    identity.planVersion, identity.sourceHeadSha, identity.scopeDigest];
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

/** Dynamic calls from one parent node must not accidentally inherit another
 * assignment's saved child state. The physical parent task namespace remains
 * the restart anchor; add the exact logical assignment and phase to it. */
export function assignmentChildConfig(config: RunnableConfig, identity: LifecycleIdentity,
  phase: "original" | "correction" = "original"): RunnableConfig {
  const parent = config.configurable?.checkpoint_ns;
  if (typeof parent !== "string" || !parent)
    throw Error("Assignment child requires its checkpointed parent task namespace.");
  return { ...config, configurable: { ...config.configurable,
    checkpoint_id: undefined,
    // checkpointer:true strips task-id suffixes after colons. Keep the
    // logical key in the namespace name, not in its stripped task suffix.
    checkpoint_ns: parent + "|assignment-" + logicalAssignmentKey(identity) + "-" + phase,
  } };
}

type OutcomeBase = Readonly<{
  assignmentKey: string;
  /** Existing authenticated Pi/Git/review/RecoveryCase reference, not a copy. */
  evidenceRef: string;
}>;

export type AssignmentOutcome<I extends LifecycleIdentity = AssignmentIdentity> =
  | (OutcomeBase & Readonly<{ status: "verified"; reviewRef: string }> &
      (I extends DiscoveryAssignmentIdentity ? Readonly<{ sourceDigest: string }> : Readonly<{ headSha: string }>))
  | AssignmentPrerequisiteSuspension
  | (OutcomeBase & Readonly<{ status: "awaiting-author"; questionRef: string; resumePhase: "writer" | "review" | "correction" }>)
  | (OutcomeBase & Readonly<{ status: "paused"; controlRef: string }>)
  | (OutcomeBase & Readonly<{ status: "fenced"; inspectionRef: string }>)
  | (OutcomeBase & Readonly<{ status: "unresolved"; dispositionRef: string }>);

/** Internal authorized correction, not a terminal parent outcome. */
export type AssignmentCorrection = Readonly<{
  correctionRef: string;
  rejectedReceiptRef: string;
}>;

export type AssignmentPrerequisiteSuspension = OutcomeBase & Readonly<{
  status: "needs-prerequisite";
  /** Authenticated original failure/report, with owner and exact bounded scope. */
  suspensionRef: string;
  owner: string;
  scopeRef: string;
  pendingPhase: "writer" | "review";
}>;

export type AssignmentSubmission = Readonly<{
  /** The original specialist's native/Git receipt; never a graph-only claim. */
  receiptRef: string;
  status: string;
  headSha?: string;
}>;

function lifecycleChannels<I extends LifecycleIdentity>() {
  return Annotation.Root({
  identity: Annotation<I>(),
  /** The source-backed settled invocation, NOT an in-flight writer token. */
  submission: Annotation<AssignmentSubmission | null>({ reducer: (_, next) => next, default: () => null }),
  /** Binds a saved submission to the exact original assignment tuple. */
  submissionKey: Annotation<string | null>({ reducer: (_, next) => next, default: () => null }),
  outcome: Annotation<AssignmentOutcome<I> | null>({ reducer: (_, next) => next, default: () => null }),
  /** Only a reference into the existing controller-owned history. */
  continuationRef: Annotation<string | null>({ reducer: (_, next) => next, default: () => null }),
  /** Original returned-END suspension, not an author interrupt or a new assignment. */
  suspension: Annotation<AssignmentPrerequisiteSuspension | null>({ reducer: (_, next) => next, default: () => null }),
  authorAnswerRef: Annotation<unknown>({ reducer: (_, next) => next, default: () => null }),
  authorResumePhase: Annotation<"writer" | "review" | "correction" | null>({ reducer: (_, next) => next, default: () => null }),
  correction: Annotation<AssignmentCorrection | null>({ reducer: (_, next) => next, default: () => null }),
  });
}
type LifecycleState<I extends LifecycleIdentity> = ReturnType<typeof lifecycleChannels<I>>["State"];

/** Verification may publish a native commit after the checkpointed Pi round.
 * Keep its actual committed receipt alongside the outcome for parent replay. */
export type AssignmentVerifiedSubmission<I extends LifecycleIdentity> = Readonly<{
  submission: AssignmentSubmission;
} & ({ outcome: AssignmentOutcome<I> } | { correction: AssignmentCorrection } | { reviewPending: true } | { publicationPending: true })>;

export type AssignmentAdapter<I extends LifecycleIdentity = AssignmentIdentity> = Readonly<{
  /** Reauthenticate the parent authorization, source and uncertain effects. */
  preflight: (state: LifecycleState<I>, config: RunnableConfig) =>
    Promise<AssignmentOutcome<I> | null>;
  /** Before any model/Git effect, reconcile the original intent and receipts.
   * Repeating this call after a crash MUST NOT repeat an uncertain Pi write. */
  invoke: (state: LifecycleState<I>, config: RunnableConfig) =>
    Promise<AssignmentSubmission | AssignmentOutcome<I>>;
  /** Run native validation and independent read-only Review; return references
   * only to real trusted receipts. Never certify solely from the child state. */
  verify: (state: LifecycleState<I>, config: RunnableConfig) =>
    Promise<AssignmentOutcome<I> | AssignmentCorrection | AssignmentVerifiedSubmission<I>>;
  /** Reconcile the exact rejected submission and authorized correction before
   * a new model attempt. The adapter retains original external receipts. */
  correct?: (state: LifecycleState<I>, config: RunnableConfig) =>
    Promise<AssignmentSubmission | AssignmentOutcome<I>>;
  /** Used only for a true pending LangGraph author interrupt. */
  authenticateAnswer?: (state: LifecycleState<I>, answer: unknown) => Promise<boolean>;
  /** Required for any returned-END logical phase reentry. Must check the
   * original suspension, matching Turn/scope/source and supporting receipt. */
  authenticateContinuation?: (state: LifecycleState<I>, config: RunnableConfig) => Promise<boolean>;
  /** Continue a settled no-write writer at its original Pi session. Never
   * substitute the initial invocation for a returned-END continuation. */
  reenterWriter?: (state: LifecycleState<I>, config: RunnableConfig) =>
    Promise<AssignmentSubmission | AssignmentOutcome<I>>;
}>;

function assertAssignmentOutcome(identity: LifecycleIdentity, outcome: AssignmentOutcome<LifecycleIdentity>): void {
  const nonempty = (value: unknown): value is string => typeof value === "string" && !!value.trim();
  if (!outcome || typeof outcome !== "object" ||
      outcome.assignmentKey !== logicalAssignmentKey(identity) || !nonempty(outcome.evidenceRef))
    throw Error("Assignment outcome lacks an authenticated original source reference.");
  // Check the runtime union at the receipt/checkpoint boundary. A cast or a
  // persisted object with an unknown discriminant must not fall through to
  // the unresolved case, and another outcome's fields cannot confer a
  // contradictory permission or continuation.
  const common = ["assignmentKey", "evidenceRef", "status"];
  let fields: string[];
  switch (outcome.status) {
    case "verified":
      fields = ["reviewRef", identity.schema === "noveltea-discovery-assignment/v1" ? "sourceDigest" : "headSha"];
      break;
    case "needs-prerequisite":
      fields = ["suspensionRef", "owner", "scopeRef", "pendingPhase"];
      break;
    case "awaiting-author":
      fields = ["questionRef", "resumePhase"];
      break;
    case "paused":
      fields = ["controlRef"];
      break;
    case "fenced":
      fields = ["inspectionRef"];
      break;
    case "unresolved":
      fields = ["dispositionRef"];
      break;
    default:
      throw Error("Assignment outcome has an unknown disposition.");
  }
  const expected = new Set([...common, ...fields]);
  if (Object.keys(outcome).length !== expected.size ||
      Object.keys(outcome).some(field => !expected.has(field)))
    throw Error("Assignment outcome has contradictory or missing typed fields.");
  const ref = outcome.status === "verified" ? outcome.reviewRef :
    outcome.status === "needs-prerequisite" ? outcome.suspensionRef :
    outcome.status === "awaiting-author" ? outcome.questionRef :
    outcome.status === "paused" ? outcome.controlRef :
    outcome.status === "fenced" ? outcome.inspectionRef : outcome.dispositionRef;
  if (outcome.status === "needs-prerequisite" &&
      (!nonempty(outcome.owner) || !nonempty(outcome.scopeRef) ||
       !["writer", "review"].includes(outcome.pendingPhase)))
    throw Error("Prerequisite suspension lacks its bounded owner, scope or pending phase.");
  if (outcome.status === "awaiting-author" && !["writer", "review", "correction"].includes(outcome.resumePhase))
    throw Error("Author question lacks its original continuation phase.");
  if (!nonempty(ref) ||
      outcome.status === "verified" && (identity.schema === "noveltea-discovery-assignment/v1"
        ? !("sourceDigest" in outcome) || outcome.sourceDigest !== identity.scopeDigest
        : !("headSha" in outcome) || typeof outcome.headSha !== "string" || !/^[a-f0-9]{40}$/.test(outcome.headSha)))
    throw Error("Assignment outcome has no valid typed evidence/commit reference.");
}

export function createAssignmentLifecycleGraph<I extends LifecycleIdentity = AssignmentIdentity>(adapter: AssignmentAdapter<I>,
  checkpointer: true | false = true) {
  return new StateGraph(lifecycleChannels<I>())
    .addNode("preflight", async (state, config) => {
      const key = logicalAssignmentKey(state.identity);
      if (state.outcome) assertAssignmentOutcome(state.identity, state.outcome);
      if (state.submission && state.submissionKey !== key)
        throw Error("Saved specialist submission belongs to another logical assignment.");
      if (state.suspension) {
        assertAssignmentOutcome(state.identity, state.suspension);
        if (state.suspension.status !== "needs-prerequisite" || !state.continuationRef ||
            (state.suspension.pendingPhase === "review" && !state.submission) ||
            (state.suspension.pendingPhase === "writer" && (!adapter.reenterWriter || state.submission)))
          throw Error("Prerequisite continuation lacks its exact original pending phase.");
      }
      if (state.continuationRef !== null &&
          (!state.continuationRef ||
           !adapter.authenticateContinuation ||
           !await adapter.authenticateContinuation(state, config)))
        throw Error("Logical-assignment re-entry lacks authenticated original support and source.");
      const outcome = await adapter.preflight(state, config);
      if (outcome) {
        assertAssignmentOutcome(state.identity, outcome);
        return { outcome };
      }
      // A persisted success is a reference, not authority. Re-attest its
      // settled submission before returning it to a new physical parent task.
      if (state.outcome?.status === "verified") {
        if (!state.submission) throw Error("Verified assignment lost its original submission reference.");
        return { outcome: null };
      }
      return {};
    })
    .addNode("invoke_original", async (state, config) => {
      if (state.submission || state.outcome) return {};
      const settled = state.suspension?.pendingPhase === "writer"
        ? await adapter.reenterWriter!(state, config) : await adapter.invoke(state, config);
      if ("assignmentKey" in settled) {
        assertAssignmentOutcome(state.identity, settled);
        return { outcome: settled };
      }
      if (!settled.receiptRef || !settled.status)
        throw Error("An assignment cannot checkpoint an unreceipted writer result.");
      return { submission: settled, submissionKey: logicalAssignmentKey(state.identity) };
    })
    .addNode("verify_original", async (state, config) => {
      if (state.outcome || !state.submission) return {};
      if (state.submissionKey !== logicalAssignmentKey(state.identity))
        throw Error("Verification cannot use a foreign assignment submission.");
      const verified = await adapter.verify(state, config);
      if ("submission" in verified) {
        if (!verified.submission.receiptRef || !verified.submission.status)
          throw Error("Verification lost the committed submission receipt.");
        if ("correction" in verified) {
          if (!adapter.correct || !verified.correction.correctionRef ||
              verified.correction.rejectedReceiptRef !== verified.submission.receiptRef)
            throw Error("Correction lacks its verified successor submission.");
          return { submission: verified.submission, correction: verified.correction };
        }
        if ("publicationPending" in verified) {
          if (!verified.publicationPending || verified.submission.receiptRef !== state.submission.receiptRef ||
              verified.submission.status === state.submission.status || verified.submission.headSha)
            throw Error("Publication requires the checkpointed verified draft reference.");
          return { submission: verified.submission, correction: null, outcome: null };
        }
        if ("reviewPending" in verified) {
          if (!verified.reviewPending || verified.submission.receiptRef === state.submission.receiptRef ||
              !/^[a-f0-9]{40}$/.test(verified.submission.headSha ?? ""))
            throw Error("Independent Review requires a distinct native-verified submission.");
          return { submission: verified.submission, correction: null, outcome: null };
        }
        assertAssignmentOutcome(state.identity, verified.outcome);
        return { outcome: verified.outcome, submission: verified.submission, correction: null };
      }
      const outcome = verified;
      if ("correctionRef" in outcome) {
        if (!adapter.correct || !outcome.correctionRef ||
            outcome.rejectedReceiptRef !== state.submission.receiptRef)
          throw Error("Correction lacks its original rejected submission.");
        return { correction: outcome };
      }
      assertAssignmentOutcome(state.identity, outcome);
      return { outcome, correction: null };
    })
    .addNode("correct_original", async (state, config) => {
      if (!adapter.correct || !state.correction || !state.submission ||
          state.correction.rejectedReceiptRef !== state.submission.receiptRef ||
          state.submissionKey !== logicalAssignmentKey(state.identity))
        throw Error("Correction cannot replay without its source-bound original submission.");
      const settled = await adapter.correct(state, config);
      if ("assignmentKey" in settled) {
        assertAssignmentOutcome(state.identity, settled);
        return { outcome: settled, correction: settled.status === "awaiting-author" ? state.correction : null };
      }
      if (!settled.receiptRef || !settled.status)
        throw Error("An assignment cannot checkpoint an unreceipted correction.");
      return { submission: settled, submissionKey: logicalAssignmentKey(state.identity), correction: null };
    })
    .addNode("author_gate", async state => {
      if (state.outcome?.status !== "awaiting-author") return {};
      const response: unknown = interrupt({
        kind: "assignment-author-question",
        assignmentKey: state.outcome.assignmentKey,
        questionRef: state.outcome.questionRef,
      });
      if (!adapter.authenticateAnswer ||
          !await adapter.authenticateAnswer(state, response))
        throw Error("Author answer is not authenticated for this pending assignment.");
      const phase = state.outcome.resumePhase;
      if (phase === "review" && !state.submission ||
          phase === "correction" && (!state.submission || !state.correction))
        throw Error("Author question lost its original pending Review/correction.");
      // The domain receipt owns the original session and the next admission.
      // A new writer turn after an answer must settle its own invocation.
      return { outcome: null, authorResumePhase: phase, authorAnswerRef: response,
        ...(phase === "writer" ? { submission: null, submissionKey: null, correction: null } : {}) };
    })
    .addEdge(START, "preflight")
    .addConditionalEdges("preflight",
      state => state.outcome ? state.outcome.status === "awaiting-author" ? "author_gate" : END : "invoke_original",
      ["author_gate", "invoke_original", END])
    .addConditionalEdges("invoke_original",
      state => state.outcome ? state.outcome.status === "awaiting-author" ? "author_gate" : END : "verify_original",
      ["author_gate", "verify_original", END])
    .addConditionalEdges("verify_original",
      state => state.outcome?.status === "awaiting-author" ? "author_gate" : state.correction ? "correct_original" :
        !state.outcome && state.submission ? "verify_original" : END,
      ["correct_original", "verify_original", "author_gate", END])
    .addConditionalEdges("correct_original",
      state => state.outcome ? state.outcome.status === "awaiting-author" ? "author_gate" : END : "verify_original",
      ["author_gate", "verify_original", END])
    .addConditionalEdges("author_gate",
      state => state.authorResumePhase === "writer" ? "invoke_original" :
        state.authorResumePhase === "review" ? "verify_original" : "correct_original",
      ["invoke_original", "verify_original", "correct_original"])
    .compile({ checkpointer });
}

/** A returned child already reached END. Re-enter the same logical assignment
 * only through independently authenticated support, never Command(resume).
 * The original source and case identity remain unchanged. */
export async function authenticateAssignmentReentry(
  identity: AssignmentIdentity, suspension: AssignmentOutcome,
  continuationRef: string, authenticate: (input: {
    identity: AssignmentIdentity; suspension: AssignmentOutcome;
    continuationRef: string;
  }) => Promise<boolean>,
): Promise<string> {
  assertAssignmentOutcome(identity, suspension);
  if (suspension.status !== "needs-prerequisite" ||
      suspension.assignmentKey !== logicalAssignmentKey(identity) ||
      !suspension.suspensionRef || !continuationRef ||
      !await authenticate({ identity, suspension, continuationRef }))
    throw Error("Logical-assignment re-entry lacks authenticated original support and source.");
  return logicalAssignmentKey(identity);
}
