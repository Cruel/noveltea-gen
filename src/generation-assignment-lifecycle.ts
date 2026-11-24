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

export function logicalAssignmentKey(identity: AssignmentIdentity): string {
  const fields = [identity.schema, identity.jobId, identity.jobThreadId,
    identity.graphThreadId, identity.turnDigest, identity.assignmentId,
    identity.planVersion, identity.sourceHeadSha, identity.scopeDigest];
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

/** Dynamic calls from one parent node must not accidentally inherit another
 * assignment's saved child state. The physical parent task namespace remains
 * the restart anchor; add the exact logical assignment and phase to it. */
export function assignmentChildConfig(config: RunnableConfig, identity: AssignmentIdentity,
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

export type AssignmentOutcome =
  | (OutcomeBase & Readonly<{ status: "verified"; reviewRef: string; headSha: string }>)
  | (OutcomeBase & Readonly<{ status: "needs-prerequisite"; suspensionRef: string }>)
  | (OutcomeBase & Readonly<{ status: "awaiting-author"; questionRef: string }>)
  | (OutcomeBase & Readonly<{ status: "paused"; controlRef: string }>)
  | (OutcomeBase & Readonly<{ status: "fenced"; inspectionRef: string }>)
  | (OutcomeBase & Readonly<{ status: "unresolved"; dispositionRef: string }>);

export type AssignmentSubmission = Readonly<{
  /** The original specialist's native/Git receipt; never a graph-only claim. */
  receiptRef: string;
  status: string;
  headSha?: string;
}>;

type LifecycleState = typeof LifecycleChannels.State;

const LifecycleChannels = Annotation.Root({
  identity: Annotation<AssignmentIdentity>(),
  /** The source-backed settled invocation, NOT an in-flight writer token. */
  submission: Annotation<AssignmentSubmission | null>({ reducer: (_, next) => next, default: () => null }),
  /** Binds a saved submission to the exact original assignment tuple. */
  submissionKey: Annotation<string | null>({ reducer: (_, next) => next, default: () => null }),
  outcome: Annotation<AssignmentOutcome | null>({ reducer: (_, next) => next, default: () => null }),
  /** Only a reference into the existing controller-owned history. */
  continuationRef: Annotation<string | null>({ reducer: (_, next) => next, default: () => null }),
});

export type AssignmentAdapter = Readonly<{
  /** Reauthenticate the parent authorization, source and uncertain effects. */
  preflight: (state: LifecycleState, config: RunnableConfig) =>
    Promise<AssignmentOutcome | null>;
  /** Before any model/Git effect, reconcile the original intent and receipts.
   * Repeating this call after a crash MUST NOT repeat an uncertain Pi write. */
  invoke: (state: LifecycleState, config: RunnableConfig) =>
    Promise<AssignmentSubmission | AssignmentOutcome>;
  /** Run native validation and independent read-only Review; return references
   * only to real trusted receipts. Never certify solely from the child state. */
  verify: (state: LifecycleState, config: RunnableConfig) =>
    Promise<AssignmentOutcome>;
  /** Used only for a true pending LangGraph author interrupt. */
  authenticateAnswer?: (state: LifecycleState, answer: unknown) => Promise<boolean>;
  /** Required for any returned-END logical phase reentry. Must check the
   * original suspension, matching Turn/scope/source and supporting receipt. */
  authenticateContinuation?: (state: LifecycleState, config: RunnableConfig) => Promise<boolean>;
}>;

function assertAssignmentOutcome(identity: AssignmentIdentity, outcome: AssignmentOutcome): void {
  if (outcome.assignmentKey !== logicalAssignmentKey(identity) || !outcome.evidenceRef)
    throw Error("Assignment outcome lacks an authenticated original source reference.");
  const ref = outcome.status === "verified" ? outcome.reviewRef :
    outcome.status === "needs-prerequisite" ? outcome.suspensionRef :
    outcome.status === "awaiting-author" ? outcome.questionRef :
    outcome.status === "paused" ? outcome.controlRef :
    outcome.status === "fenced" ? outcome.inspectionRef : outcome.dispositionRef;
  if (typeof ref !== "string" || !ref.trim() ||
      outcome.status === "verified" && !/^[a-f0-9]{40}$/.test(outcome.headSha))
    throw Error("Assignment outcome has no valid typed evidence/commit reference.");
}

export function createAssignmentLifecycleGraph(adapter: AssignmentAdapter) {
  return new StateGraph(LifecycleChannels)
    .addNode("preflight", async (state, config) => {
      const key = logicalAssignmentKey(state.identity);
      if (state.outcome) assertAssignmentOutcome(state.identity, state.outcome);
      if (state.submission && state.submissionKey !== key)
        throw Error("Saved specialist submission belongs to another logical assignment.");
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
      const settled = await adapter.invoke(state, config);
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
      const outcome = await adapter.verify(state, config);
      assertAssignmentOutcome(state.identity, outcome);
      return { outcome };
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
      // The parent must reconcile the author response and re-enter the exact
      // logical assignment. A resumed interrupt is not a writer grant.
      return { outcome: null };
    })
    .addEdge(START, "preflight")
    .addConditionalEdges("preflight",
      state => state.outcome ? state.outcome.status === "awaiting-author" ? "author_gate" : END : "invoke_original",
      ["author_gate", "invoke_original", END])
    .addConditionalEdges("invoke_original",
      state => state.outcome ? state.outcome.status === "awaiting-author" ? "author_gate" : END : "verify_original",
      ["author_gate", "verify_original", END])
    .addConditionalEdges("verify_original",
      state => state.outcome?.status === "awaiting-author" ? "author_gate" : END,
      ["author_gate", END])
    .addEdge("author_gate", END)
    .compile({ checkpointer: true });
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
  if (suspension.status !== "needs-prerequisite" ||
      suspension.assignmentKey !== logicalAssignmentKey(identity) ||
      !suspension.suspensionRef || !continuationRef ||
      !await authenticate({ identity, suspension, continuationRef }))
    throw Error("Logical-assignment re-entry lacks authenticated original support and source.");
  return logicalAssignmentKey(identity);
}
