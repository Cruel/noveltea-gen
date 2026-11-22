import assert from "node:assert/strict";
import test from "node:test";
import {
  admitRecovery,
  decideRecovery,
  emptyRecoveryLifecycle,
  finishRecovery,
  deferRecoveryForIndependentWork,
  selectPendingRecovery,
  resumePausedRecovery,
  recoveryAdmission,
  recoveryCaseId,
  recordRecoveryOutcome,
  verifyRecoveryCheckpoint,
} from "../src/generation-recovery-lifecycle.js";
import type { RecoveryCase, RecoveryOrigin, RecoveryEvidence } from "../src/generation-recovery-contract.js";

const source = "a".repeat(40);
const digest = "b".repeat(64);
const evidence: RecoveryEvidence = { store: "graph-checkpoint", ref: "original-task-9" };
const origin: RecoveryOrigin = {
  jobId: "job-1",
  jobThreadId: "thread-1",
  graphThreadId: "thread-1:generation",
  turnDigest: digest,
  planVersion: 2,
  sourceHeadSha: source,
  assignmentId: "event-1",
  operation: "specialist-result",
  check: "specialist-result.v1",
  checkVersion: 1,
  failureAnchor: {
    store: "graph-checkpoint",
    ref: "original-task-9",
    failedCheckInstanceId: "returned-failure",
  },
};
const trusted = async () => true;
async function admitted(o: RecoveryOrigin = origin, kind: RecoveryCase["kind"] = "semantic") {
  return recoveryAdmission({
    origin: o,
    kind,
    observation: "returned-failure",
    effect: "settled-no-write",
    evidence: [evidence],
    authenticate: trusted,
  });
}
function caseOf(a: Awaited<ReturnType<typeof admitted>>): RecoveryCase {
  assert.equal(a.outcome, "admitted");
  if (a.outcome !== "admitted") throw Error("not admitted");
  return a.case;
}

test("C02 original failure identity excludes new evidence, cause, classification and order", async () => {
  const first = caseOf(await admitted());
  assert.match(first.id, /^[a-f0-9]{64}$/);
  assert.equal(first.id, recoveryCaseId(origin));
  assert.equal(
    first.id,
    caseOf(await admitted({ ...origin, failureAnchor: { ...origin.failureAnchor } }, "infrastructure")).id,
  );
  const changed = caseOf(await admitted({ ...origin, sourceHeadSha: "c".repeat(40) }));
  assert.notEqual(first.id, changed.id, "a different original source is different identity");
  assert.notEqual(
    first.id,
    recoveryCaseId({
      ...origin,
      failureAnchor: {
        ...origin.failureAnchor,
        failedCheckInstanceId: "another-real-execution",
      },
    }),
  );
});

test("C02 repeated failure and source revision cannot drop or reset unresolved case", async () => {
  const first = caseOf(await admitted());
  const second = caseOf(await admitted({ ...origin, sourceHeadSha: "c".repeat(40) }));
  let state = admitRecovery(emptyRecoveryLifecycle(), { outcome: "admitted", case: first });
  state = admitRecovery(state, { outcome: "admitted", case: first });
  assert.equal(state.pending.length, 0);
  assert.equal(state.active?.id, first.id);
  state = admitRecovery(state, { outcome: "admitted", case: second });
  assert.equal(state.active?.id, first.id, "original obligation and first attempt persist");
  assert.equal(state.pending.length, 0, "changed-HEAD reinspection is not another entitlement");
});

test("C02 distinct authenticated failures serialize with original assignment identity", async () => {
  const first = caseOf(await admitted());
  const second = caseOf(
    await admitted({
      ...origin,
      failureAnchor: {
        ...origin.failureAnchor,
        failedCheckInstanceId: "different-invocation",
      },
    }),
  );
  let state = admitRecovery(emptyRecoveryLifecycle(), { outcome: "admitted", case: first });
  state = admitRecovery(state, { outcome: "admitted", case: second });
  assert.equal(state.active?.id, first.id);
  assert.deepEqual(
    state.pending.map((c) => c.id),
    [second.id],
  );
  state = decideRecovery(state, {
    schema: "noveltea-generation-recovery-decision/v1",
    caseId: first.id,
    checkedSourceHeadSha: source,
    evidence: [evidence],
    action: "reconcile-effects",
    adapter: "original-specialist",
    originalRef: evidence,
  });
  assert.equal(state.phase, "reconciling");
  state = recordRecoveryOutcome(
    state,
    { status: "verified", caseId: first.id, sourceHeadSha: source, assurance: evidence },
    true,
  );
  assert.equal(state.phase, "resolved");
  state = finishRecovery(state);
  assert.equal(state.active?.id, second.id);
  assert.equal(state.phase, "assessing");
});

test("C02 no model attempt is inferred from assessment, prepared or missing Pi start proof", async () => {
  const first = caseOf(await admitted());
  let state = admitRecovery(emptyRecoveryLifecycle(), { outcome: "admitted", case: first });
  state = decideRecovery(state, {
    schema: "noveltea-generation-recovery-decision/v1",
    caseId: first.id,
    checkedSourceHeadSha: source,
    evidence: [evidence],
    action: "diagnostic",
    adapter: "unknown-diagnostic",
    mode: "read-only",
    attemptRef: null,
  });
  assert.equal(state.phase, "diagnosing");
  assert.equal(state.attempt, null);
  state = recordRecoveryOutcome(
    state,
    {
      status: "started",
      caseId: first.id,
      attempt: {
        id: "try-1",
        caseId: first.id,
        invocationId: "invocation-1",
        purpose: "diagnosis",
        mode: "read-only",
        phase: "prepared",
        startedRef: null,
        settledRef: null,
      },
    },
    true,
  );
  assert.equal(state.attempt?.phase, "prepared");
  assert.throws(
    () =>
      recordRecoveryOutcome(
        state,
        {
          status: "started",
          caseId: first.id,
          attempt: { ...state.attempt!, phase: "started", startedRef: evidence },
        },
        false,
      ),
    /authentication/,
  );
  state = recordRecoveryOutcome(
    state,
    {
      status: "started",
      caseId: first.id,
      attempt: {
        ...state.attempt!,
        phase: "started",
        startedRef: { store: "pi-session", ref: "original-start" },
      },
    },
    true,
  );
  assert.equal(state.attempt?.phase, "started");
  assert.throws(
    () =>
      recordRecoveryOutcome(
        state,
        {
          status: "started",
          caseId: first.id,
          attempt: { ...state.attempt!, invocationId: "different-invocation", phase: "started" },
        },
        true,
      ),
    /original invocation/,
  );
});

test("C02 no trusted case from missing original check, bad anchors or corrupted state", async () => {
  const bad = await recoveryAdmission({
    origin: {
      ...origin,
      failureAnchor: {
        ...origin.failureAnchor,
        ref: "",
      },
    },
    kind: "integrity",
    observation: "exception",
    effect: "writer-effects-uncertain",
    evidence: [evidence],
    authenticate: trusted,
  });
  assert.equal(bad.outcome, "fenced");
  const rejected = await recoveryAdmission({
    origin,
    kind: "semantic",
    observation: "exception",
    effect: "no-effects",
    evidence: [evidence],
    authenticate: async () => false,
  });
  assert.equal(rejected.outcome, "fenced");
  const state = admitRecovery(emptyRecoveryLifecycle(), rejected);
  assert.equal(state.active, null);
  assert.equal(state.phase, "fenced");
  assert.equal(state.inspectionFences.length, 1);
  assert.throws(
    () =>
      decideRecovery(state, {
        schema: "noveltea-generation-recovery-decision/v1",
        caseId: "invented",
        checkedSourceHeadSha: source,
        evidence: [evidence],
        action: "diagnostic",
        adapter: "unknown-diagnostic",
        mode: "read-only",
        attemptRef: null,
      }),
    /fenced/,
  );
});

test("C02 author control, integrity and uncertain effects cannot become writer grants", async () => {
  const first = caseOf(await admitted());
  let state = admitRecovery(emptyRecoveryLifecycle(), { outcome: "admitted", case: first });
  const pause = decideRecovery(state, {
    schema: "noveltea-generation-recovery-decision/v1",
    caseId: first.id,
    checkedSourceHeadSha: source,
    evidence: [evidence],
    action: "pause",
    reason: "protected-approval",
  });
  assert.equal(pause.phase, "paused");
  assert.throws(
    () =>
      recordRecoveryOutcome(
        pause,
        { status: "verified", caseId: first.id, sourceHeadSha: source, assurance: evidence },
        true,
      ),
    /paused/,
  );
  state = decideRecovery(state, {
    schema: "noveltea-generation-recovery-decision/v1",
    caseId: first.id,
    checkedSourceHeadSha: source,
    evidence: [evidence],
    action: "integrity-fence",
    reason: "ambiguous-writer",
    requiredInspection: "Inspect original session",
  });
  assert.equal(state.phase, "fenced");
});

test("C02 conflicting claims for one failure anchor fence without overwriting the first Turn", async () => {
  const first = caseOf(await admitted());
  const poisoned = caseOf(await admitted({ ...origin, planVersion: 3 }));
  const state = admitRecovery(admitRecovery(emptyRecoveryLifecycle(), { outcome: "admitted", case: first }), {
    outcome: "admitted",
    case: poisoned,
  });
  assert.equal(state.active?.id, first.id);
  assert.equal(state.phase, "fenced");
  assert.equal(state.inspectionFences[0]?.reason, "conflicting-cases");
  const threadChanged = caseOf(await admitted({ ...origin, graphThreadId: "forged-graph-thread" }));
  const threadConflict = admitRecovery(
    admitRecovery(emptyRecoveryLifecycle(), { outcome: "admitted", case: first }),
    { outcome: "admitted", case: threadChanged },
  );
  assert.equal(threadConflict.inspectionFences[0]?.reason, "conflicting-cases");
});

test("C02 independently verified no-write work keeps unresolved obligation pending", async () => {
  const first = caseOf(await admitted());
  const second = caseOf(
    await admitted({
      ...origin,
      failureAnchor: {
        ...origin.failureAnchor,
        failedCheckInstanceId: "independent-original-check",
      },
    }),
  );
  let state = admitRecovery(emptyRecoveryLifecycle(), { outcome: "admitted", case: first });
  state = admitRecovery(state, { outcome: "admitted", case: second });
  state = decideRecovery(state, {
    schema: "noveltea-generation-recovery-decision/v1",
    caseId: first.id,
    checkedSourceHeadSha: source,
    evidence: [evidence],
    action: "continue-independent",
    inventoryRef: evidence,
    blockedAssignmentId: "event-1",
  });
  assert.throws(
    () =>
      recordRecoveryOutcome(
        state,
        { status: "verified", caseId: first.id, sourceHeadSha: source, assurance: evidence },
        true,
      ),
    /independent/,
  );
  state = deferRecoveryForIndependentWork(state);
  assert.equal(state.phase, "idle");
  assert.equal(state.active, null);
  assert.equal(state.pending.length, 2);
  state = selectPendingRecovery(state, (item) => item.id === second.id);
  assert.equal(state.active?.id, second.id);
  assert.equal(state.pending[0]?.id, first.id);
});

test("C02 paused author control requires authenticated resume and cannot be overwritten by a new decision", async () => {
  const first = caseOf(await admitted());
  let state = admitRecovery(emptyRecoveryLifecycle(), { outcome: "admitted", case: first });
  const pause = {
    schema: "noveltea-generation-recovery-decision/v1" as const,
    caseId: first.id,
    checkedSourceHeadSha: source,
    evidence: [evidence],
    action: "pause" as const,
    reason: "protected-approval" as const,
  };
  state = decideRecovery(state, pause);
  assert.throws(() => decideRecovery(state, pause), /phase/);
  assert.throws(() => resumePausedRecovery(state, false), /authenticated/);
  state = resumePausedRecovery(state, true);
  assert.equal(state.phase, "assessing");
  assert.equal(state.decision, null);
});

test("C02 corrupted modern case and attempted invoke-ID mutation fail closed", async () => {
  const first = caseOf(await admitted());
  const invalid = await verifyRecoveryCheckpoint({
    current: {
      ...emptyRecoveryLifecycle(),
      active: {
        ...first,
        origin: {
          ...first.origin,
          sourceHeadSha: "fake",
        },
      },
      phase: "assessing",
    },
    request: {
      jobId: "job-1",
      jobThreadId: "thread-1",
      graphThreadId: "thread-1:generation",
      turnDigest: digest,
    },
    checkpointRef: evidence,
    authenticate: trusted,
  });
  assert.equal(invalid.phase, "fenced");
  assert.equal(invalid.inspectionFences[0]?.reason, "untrusted-receipt");
  let state = admitRecovery(emptyRecoveryLifecycle(), { outcome: "admitted", case: first });
  state = decideRecovery(state, {
    schema: "noveltea-generation-recovery-decision/v1",
    caseId: first.id,
    checkedSourceHeadSha: source,
    evidence: [evidence],
    action: "diagnostic",
    adapter: "unknown-diagnostic",
    mode: "read-only",
    attemptRef: null,
  });
  const attempt = {
    id: "id",
    invocationId: "inv-1",
    caseId: first.id,
    purpose: "diagnosis" as const,
    mode: "read-only" as const,
    phase: "started" as const,
    startedRef: { store: "pi-session" as const, ref: "original" },
    settledRef: null,
  };
  state = recordRecoveryOutcome(state, { status: "started", caseId: first.id, attempt }, true);
  assert.throws(
    () =>
      recordRecoveryOutcome(
        state,
        {
          status: "started",
          caseId: first.id,
          attempt: { ...attempt, startedRef: { store: "pi-session", ref: "different" } },
        },
        true,
      ),
    /original invocation/,
  );
  assert.throws(
    () =>
      recordRecoveryOutcome(
        state,
        {
          status: "started",
          caseId: first.id,
          attempt: { ...attempt, purpose: "correction", mode: "bounded-writer" },
        },
        true,
      ),
    /original invocation|cannot grant a writer/,
  );
});

test("C02 persisted decisions reject invented action variants before controller authentication", async () => {
  const first = caseOf(await admitted());
  const invalid = await verifyRecoveryCheckpoint({
    current: {
      ...emptyRecoveryLifecycle(),
      active: first,
      phase: "correcting",
      decision: {
        schema: "noveltea-generation-recovery-decision/v1",
        caseId: first.id,
        checkedSourceHeadSha: source,
        evidence: [evidence],
        action: "known-correction",
        adapter: "invented-writer-adapter",
        receipt: evidence,
      },
    },
    request: {
      jobId: origin.jobId,
      jobThreadId: origin.jobThreadId,
      graphThreadId: origin.graphThreadId,
      turnDigest: origin.turnDigest,
    },
    checkpointRef: evidence,
    authenticate: trusted,
    authenticateDecision: async () => true,
  });
  assert.equal(invalid.phase, "fenced");
  assert.equal(invalid.active, null);
  assert.equal(invalid.inspectionFences[0]?.reason, "untrusted-receipt");
});

test("C02 modern resolved state requires independently authenticated completion, not a saved phase", async () => {
  const c = caseOf(await admitted());
  const request = {
    jobId: origin.jobId,
    jobThreadId: origin.jobThreadId,
    graphThreadId: origin.graphThreadId,
    turnDigest: origin.turnDigest,
  };
  const decision = {
    schema: "noveltea-generation-recovery-decision/v1" as const,
    caseId: c.id,
    checkedSourceHeadSha: source,
    evidence: [evidence],
    action: "reconcile-effects" as const,
    adapter: "original-specialist" as const,
    originalRef: evidence,
  };
  const resolved = { ...emptyRecoveryLifecycle(), active: c, decision, phase: "resolved" as const };
  const unproved = await verifyRecoveryCheckpoint({
    current: resolved,
    request,
    checkpointRef: evidence,
    authenticate: trusted,
    authenticateDecision: trusted,
  });
  assert.equal(unproved.phase, "fenced");
  assert.equal(unproved.active, null);
  const verified = await verifyRecoveryCheckpoint({
    current: resolved,
    request,
    checkpointRef: evidence,
    authenticate: trusted,
    authenticateDecision: trusted,
    authenticateCompletion: async (state) => state.active?.id === c.id && state.decision?.caseId === c.id,
  });
  assert.equal(verified.phase, "resolved");
  assert.equal(verified.active?.id, c.id);
  const verifying = { ...resolved, phase: "verifying" as const };
  const unprovedVerification = await verifyRecoveryCheckpoint({
    current: verifying,
    request,
    checkpointRef: evidence,
    authenticate: trusted,
    authenticateDecision: trusted,
    authenticateCompletion: async () => true,
  });
  assert.equal(
    unprovedVerification.phase,
    "fenced",
    "completed-review attestation cannot stand in for original-effect settlement",
  );
  const checkedVerification = await verifyRecoveryCheckpoint({
    current: verifying,
    request,
    checkpointRef: evidence,
    authenticate: trusted,
    authenticateDecision: trusted,
    authenticateVerification: async (state) => state.active?.id === c.id,
  });
  assert.equal(
    checkedVerification.phase,
    "verifying",
    "a reconciled original writer can resume verification without a completed review",
  );
  const missingDecision = await verifyRecoveryCheckpoint({
    current: { ...resolved, decision: null },
    request,
    checkpointRef: evidence,
    authenticate: trusted,
    authenticateCompletion: async () => true,
  });
  assert.equal(missingDecision.phase, "fenced");
});

test("C02 modern checkpoint rejects incompatible phases and duplicate original cases", async () => {
  const c = caseOf(await admitted());
  const request = {
    jobId: origin.jobId,
    jobThreadId: origin.jobThreadId,
    graphThreadId: origin.graphThreadId,
    turnDigest: origin.turnDigest,
  };
  const effectDecision = {
    schema: "noveltea-generation-recovery-decision/v1" as const,
    caseId: c.id,
    checkedSourceHeadSha: source,
    evidence: [evidence],
    action: "reconcile-effects" as const,
    adapter: "original-specialist" as const,
    originalRef: evidence,
  };
  for (const modern of [
    { ...emptyRecoveryLifecycle(), active: c, pending: [c], phase: "assessing" as const },
    { ...emptyRecoveryLifecycle(), active: c, pending: [c, c], phase: "assessing" as const },
    { ...emptyRecoveryLifecycle(), active: c, phase: "paused" as const, decision: effectDecision },
    { ...emptyRecoveryLifecycle(), active: c, phase: "diagnosing" as const, decision: effectDecision },
    { ...emptyRecoveryLifecycle(), active: c, phase: "fenced" as const, decision: effectDecision },
    { ...emptyRecoveryLifecycle(), active: c, phase: "idle" as const },
    { ...emptyRecoveryLifecycle(), phase: "correcting" as const },
  ]) {
    const inspected = await verifyRecoveryCheckpoint({
      current: modern,
      request,
      checkpointRef: evidence,
      authenticate: trusted,
      authenticateDecision: trusted,
      authenticateCompletion: trusted,
    });
    assert.equal(inspected.phase, "fenced");
    assert.equal(inspected.active, null);
  }
});
