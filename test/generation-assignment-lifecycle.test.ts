import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Annotation, Command, END, START, StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { removeTestTree } from "./helpers.js";
import {
  authenticateAssignmentReentry, createAssignmentLifecycleGraph, logicalAssignmentKey,
  type AssignmentAdapter, type AssignmentIdentity, type AssignmentOutcome, type AssignmentPrerequisiteSuspension,
} from "../src/generation-assignment-lifecycle.js";

const dir = mkdtempSync(join(tmpdir(), "nt-r01-child-"));
after(() => removeTestTree(dir));

const identity: AssignmentIdentity = {
  schema: "noveltea-assignment-identity/v1", jobId: "job-one",
  jobThreadId: "turn-1", graphThreadId: "turn-1:generation",
  turnDigest: "a".repeat(64), assignmentId: "foundation",
  planVersion: 1, sourceHeadSha: "b".repeat(40),
  scopeDigest: "c".repeat(64),
};
const key = logicalAssignmentKey(identity);
const verified = (): AssignmentOutcome => ({
  status: "verified", assignmentKey: key,
  evidenceRef: "original-native-checkpoint:foundation",
  reviewRef: "original-review:foundation",
  headSha: "d".repeat(40),
});

function graph(adapter: AssignmentAdapter, name: string) {
  // Parent has the exact channel interface but retains its own scheduling
  // authority. The child is a real LangGraph node, not a fixture-only runner.
  const channels = Annotation.Root({
    identity: Annotation<AssignmentIdentity>(),
    submission: Annotation<{ receiptRef: string; status: string; headSha?: string } | null>(),
    submissionKey: Annotation<string | null>(),
    outcome: Annotation<AssignmentOutcome | null>(),
    continuationRef: Annotation<string | null>(),
    suspension: Annotation<AssignmentPrerequisiteSuspension | null>(),
  });
  const saver = SqliteSaver.fromConnString(join(dir, name + ".sqlite"));
  const child = createAssignmentLifecycleGraph(adapter);
  const parent = new StateGraph(channels)
    .addNode("bounded_assignment", child)
    .addEdge(START, "bounded_assignment")
    .addEdge("bounded_assignment", END)
    .compile({ checkpointer: saver });
  return { parent, saver };
}

test("R01 genuine nested SQLite child dispatches once and returns typed review proof", async () => {
  let dispatched = 0;
  const adapter: AssignmentAdapter = {
    preflight: async () => null,
    invoke: async () => {
      dispatched++;
      return { receiptRef: "original-pi-invocation:1", status: "foundation-committed",
        headSha: "d".repeat(40) };
    },
    verify: async state => {
      assert.equal(state.submission?.receiptRef, "original-pi-invocation:1");
      return verified();
    },
  };
  const { parent } = graph(adapter, "normal");
  const config = { configurable: { thread_id: "generation-a" } };
  const first = await parent.invoke({ identity, submission: null, outcome: null, continuationRef: null }, config);
  assert.equal(first.outcome?.status, "verified");
  assert.equal(dispatched, 1);
  const ended = await parent.getState(config);
  assert.equal(ended.next.length, 0);
  const children = await parent.getState(config, { subgraphs: true });
  assert.equal(children.next.length, 0);
  const second = await parent.getState(config);
  assert.equal(second.values.outcome?.status, "verified");
  assert.equal(dispatched, 1, "inspection never replays Pi");
});

test("R01 child invoked inside a production-style parent node inherits SQLite checkpointer", async () => {
  let calls = 0;
  const child = createAssignmentLifecycleGraph({
    preflight: async () => null,
    invoke: async () => {
      calls++;
      return { receiptRef: "foundation-pi:1", status: "committed", headSha: "d".repeat(40) };
    },
    verify: async () => verified(),
  });
  const channels = Annotation.Root({
    identity: Annotation<AssignmentIdentity>(),
    submission: Annotation<{ receiptRef: string; status: string; headSha?: string } | null>(),
    outcome: Annotation<AssignmentOutcome | null>(),
    continuationRef: Annotation<string | null>(),
  });
  const saver = SqliteSaver.fromConnString(join(dir, "node-wrapper.sqlite"));
  const parent = new StateGraph(channels)
    .addNode("specialist_dispatch", async (state, config) => child.invoke(state, config))
    .addEdge(START, "specialist_dispatch")
    .addEdge("specialist_dispatch", END)
    .compile({ checkpointer: saver });
  const config = { configurable: { thread_id: "generation-wrapped" } };
  const output = await parent.invoke({ identity, submission: null, outcome: null, continuationRef: null }, config);
  assert.equal(output.outcome?.status, "verified");
  assert.equal(calls, 1);
  const parentSnapshot = await parent.getState(config);
  assert.equal(parentSnapshot.values.outcome?.status, "verified");
  const namespaces = new Set<string>();
  for await (const saved of saver.list({ configurable: { thread_id: "generation-wrapped" } }))
    namespaces.add(saved.config.configurable?.checkpoint_ns ?? "");
  assert.ok(namespaces.size > 1,
    "A nested child must not overwrite the parent SQLite checkpoint namespace: " +
    JSON.stringify([...namespaces]));
});

test("R01 genuine author interrupt resumes same pending child task, not a completed child", async () => {
  let authorChecks = 0;
  const adapter: AssignmentAdapter = {
    preflight: async () => ({ status: "awaiting-author", assignmentKey: key,
      evidenceRef: "original-question-set:q1", questionRef: "q1" }),
    invoke: async () => { throw Error("writer must not be called at author gate"); },
    verify: async () => { throw Error("review must not run before author choice"); },
    authenticateAnswer: async (_state, answer) => {
      authorChecks++;
      return (answer as { questionRef: string })?.questionRef === "q1";
    },
  };
  const { parent } = graph(adapter, "interrupt");
  const config = { configurable: { thread_id: "generation-author" } };
  const initial = await parent.invoke({ identity, submission: null, outcome: null, continuationRef: null }, config);
  assert.equal(initial.outcome, null, "an interrupted child has no completed outcome");
  const snapshot = await parent.getState(config, { subgraphs: true });
  assert.ok(snapshot.next.length > 0);
  const resumed = await parent.invoke(new Command({ resume: { questionRef: "q1" } }), config);
  assert.equal(authorChecks, 1);
  assert.equal(resumed.outcome, null);
  assert.equal((await parent.getState(config)).next.length, 0);
});

test("R01 returned needs-prerequisite is END; re-entry requires authenticated support", async () => {
  const suspension: AssignmentOutcome = {
    status: "needs-prerequisite", assignmentKey: key,
    evidenceRef: "original-no-write:character", suspensionRef: "original-review-negative",
    owner: "nt-character-development", scopeRef: "character:scope", pendingPhase: "writer",
  };
  const { parent } = graph({
    preflight: async () => null,
    invoke: async () => suspension,
    verify: async () => { throw Error("negative result cannot be reviewed as successful"); },
  }, "returned");
  const config = { configurable: { thread_id: "generation-returned" } };
  const returned = await parent.invoke({ identity, submission: null, outcome: null, continuationRef: null }, config);
  assert.equal(returned.outcome?.status, "needs-prerequisite");
  assert.deepEqual((await parent.getState(config)).next, []);
  await assert.rejects(authenticateAssignmentReentry(identity, suspension, "support:sha", async () => false),
    /authenticated original support/);
  assert.equal(await authenticateAssignmentReentry(identity, suspension, "support:sha", async proof =>
    proof.identity.jobId === "job-one" && proof.continuationRef === "support:sha"), key);
  await assert.rejects(authenticateAssignmentReentry(
    { ...identity, graphThreadId: "another-thread" }, suspension, "support:sha", async () => true),
    /authenticated original source|authenticated original support/, "Changed source identity must never inherit original support");
});

test("R01 returned-END child re-enters a later authenticated logical phase, never Command(resume)", async () => {
  const suspension: AssignmentOutcome = {
    status: "needs-prerequisite", assignmentKey: key,
    evidenceRef: "original-no-write:foundation", suspensionRef: "review:blocked",
    owner: "nt-worldbuilding", scopeRef: "world:scope", pendingPhase: "writer",
  };
  let invocations = 0;
  const support = "source-bound-correction:original-review:head";
  const { parent } = graph({
    preflight: async state => state.continuationRef ? null : suspension,
    authenticateContinuation: async state =>
      state.continuationRef === support && state.identity.sourceHeadSha === identity.sourceHeadSha,
    invoke: async () => { throw Error("returned child must never repeat initial writer"); },
    reenterWriter: async () => {
      invocations++;
      return { receiptRef: "original-foundation:continued", status: "committed",
        headSha: "d".repeat(40) };
    },
    verify: async () => verified(),
  }, "logical-reentry");
  const config = { configurable: { thread_id: "generation-reentry" } };
  const first = await parent.invoke({
    identity, submission: null, outcome: null, continuationRef: null,
  }, config);
  assert.equal(first.outcome?.status, "needs-prerequisite");
  assert.deepEqual((await parent.getState(config)).next, []);
  assert.equal(invocations, 0, "Original no-write result must not start a replacement Pi writer");
  const authorizedKey = await authenticateAssignmentReentry(identity, suspension, support,
    async ({ continuationRef, identity: requested }) =>
      continuationRef === support && requested.sourceHeadSha === identity.sourceHeadSha);
  assert.equal(authorizedKey, key);
  const continued = await parent.invoke({
    identity, submission: null, outcome: null, continuationRef: support, suspension,
  }, config);
  assert.equal(continued.outcome?.status, "verified");
  assert.equal(continued.outcome?.assignmentKey, first.outcome?.assignmentKey,
    "Continuation stays in the same logical assignment, not a fresh case");
  assert.equal(invocations, 1);
  assert.deepEqual((await parent.getState(config)).next, [],
    "A returned-END child is a new phase; no pending interrupt is resumed");
  await assert.rejects(parent.invoke({
    identity, submission: null, outcome: null, continuationRef: "forged-support", suspension,
  }, { configurable: { thread_id: "generation-reentry-foreign" } }),
  /authenticated original support/);
  assert.equal(invocations, 1, "Invalid continuation cannot dispatch a model");
});

test("R04 returned review suspension retains its original submission and never invokes the writer again", async () => {
  const negative: AssignmentPrerequisiteSuspension = {
    status: "needs-prerequisite", assignmentKey: key, evidenceRef: "original-negative-review",
    suspensionRef: "original-review-cycle", owner: "nt-event-design",
    scopeRef: "events/source.md", pendingPhase: "review",
  };
  const original = { receiptRef: "original-native-commit", status: "committed",
    headSha: "d".repeat(40) };
  let writes = 0, reviews = 0;
  const { parent, saver } = graph({
    preflight: async () => null,
    invoke: async () => { writes++; return original; },
    authenticateContinuation: async s => s.continuationRef === "verified-support" &&
      s.suspension?.evidenceRef === negative.evidenceRef,
    verify: async s => {
      reviews++;
      assert.deepEqual(s.submission, original);
      return s.continuationRef ? verified() : negative;
    },
  }, "r04-review");
  const config = { configurable: { thread_id: "generation-review-reentry" } };
  try {
    const first = await parent.invoke({ identity, submission: null, submissionKey: null,
      outcome: null, continuationRef: null, suspension: null }, config);
    assert.deepEqual(first.outcome, negative);
    assert.deepEqual((await parent.getState(config)).next, []);
    const bad = { identity, submission: null, submissionKey: null, outcome: null,
      continuationRef: "verified-support", suspension: negative };
    await assert.rejects(parent.invoke(bad, { configurable: { thread_id: "review-missing-submission" } }),
      /exact original pending phase/);
    const final = await parent.invoke({ ...bad, submission: first.submission, submissionKey: key }, config);
    assert.equal(final.outcome?.status, "verified");
    assert.equal(writes, 1);
    assert.equal(reviews, 2);
  } finally { saver.db.close(); }
});

test("R01 crash windows reuse settled original invocation/Git/reviewer receipts without a second model charge", async () => {
  for (const phase of ["before-invocation", "post-model", "post-commit", "post-child-before-parent"] as const) {
    const saver = SqliteSaver.fromConnString(join(dir, "crash-" + phase + ".sqlite"));
    const config = { configurable: { thread_id: "generation-crash-" + phase } };
    let calls = 0, commits = 0, reviews = 0, failed = false;
    let savedModel: string | null = null;
    let savedCommit: string | null = null;
    let savedReview: string | null = null;
    let fault = phase;
    const channels = Annotation.Root({
      identity: Annotation<AssignmentIdentity>(),
      submission: Annotation<{ receiptRef: string; status: string; headSha?: string } | null>(),
      outcome: Annotation<AssignmentOutcome | null>(),
      continuationRef: Annotation<string | null>(),
    });
    const makeParent = () => {
      const child = createAssignmentLifecycleGraph({
        preflight: async () => {
          if (fault === "before-invocation") {
            fault = "none" as typeof phase;
            failed = true;
            throw Error("Injected crash before model invocation");
          }
          return null;
        },
        invoke: async () => {
          // This acts as the real external Pi/Git receipt reconciler: the
          // effect is recorded before its graph callback can be acknowledged.
          if (!savedModel) { calls++; savedModel = "original-pi:" + key; }
          if (fault === "post-model") {
            fault = "none" as typeof phase;
            failed = true;
            throw Error("Injected crash after Pi completion, before LangGraph checkpoint");
          }
          if (!savedCommit) { commits++; savedCommit = "d".repeat(40); }
          if (fault === "post-commit") {
            fault = "none" as typeof phase;
            failed = true;
            throw Error("Injected crash after Git commit, before LangGraph checkpoint");
          }
          return { receiptRef: savedModel, status: "committed", headSha: savedCommit };
        },
        verify: async state => {
          assert.equal(state.submission?.receiptRef, savedModel,
            "Review requires the exact original settled invocation");
          assert.equal(state.submission?.headSha, savedCommit);
          if (!savedReview) { reviews++; savedReview = "review:" + savedCommit; }
          return { ...verified(), evidenceRef: savedModel!,
            reviewRef: savedReview, headSha: savedCommit! };
        },
      });
      return new StateGraph(channels)
        .addNode("specialist_dispatch", async (state, cfg) => {
          const returned = await child.invoke(state, cfg);
          if (fault === "post-child-before-parent") {
            fault = "none" as typeof phase;
            failed = true;
            throw Error("Injected crash after nested END, before parent checkpoint");
          }
          return returned;
        })
        .addEdge(START, "specialist_dispatch")
        .addEdge("specialist_dispatch", END)
        .compile({ checkpointer: saver });
    };
    let parent = makeParent();
    const initial = { identity, submission: null, outcome: null, continuationRef: null };
    await assert.rejects(() => parent.invoke(initial, config), /Injected crash/, phase);
    assert.ok(failed, "Fault injection must reach the intended boundary");
    // A new compiled graph simulates process restart over the exact same
    // persisted SQLite, independently of the external Pi/Git proof store.
    parent = makeParent();
    const restored = await parent.invoke(null, config);
    assert.equal(restored.outcome?.status, "verified", phase);
    assert.equal(calls, 1, phase + ": never repeat an uncertain Pi request");
    assert.equal(commits, 1, phase + ": never create a second Git commit");
    assert.equal(reviews, 1, phase + ": never repeat a sealed independent review");
    assert.equal((await parent.getState(config)).next.length, 0);
    assert.equal((await parent.invoke(initial, { configurable: {
      thread_id: "generation-crash-" + phase + "-inspect",
    } })).outcome?.status, "verified");
    assert.equal(calls, 1, phase + ": inspecting existing external receipts needs no new model");
    saver.db.close();
  }
});
