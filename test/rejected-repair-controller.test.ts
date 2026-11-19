import assert from "node:assert/strict";
import { test } from "node:test";
import { driveRejectedRepairCycle, type RepairCycleOps, type RepairCycleState } from "../src/rejected-repair-controller.js";
import { createGenerationGraph } from "../src/generation.js";
import { reviewBoundedAssignments } from "../src/semantic-assignment-review.js";
import type { JobStartResult } from "../src/job.js";

type State = RepairCycleState & { assignmentVersion?: number; attempts?: number };
const original = "a".repeat(40), corrected = "b".repeat(40), second = "c".repeat(40);
const choice = { id: "owner-choice", phase: "awaiting-author" as const, proposalSha256: "f".repeat(64),
  question: { kind: "alternatives" as const, question: "Correct the rejected draft or revise the outcome?",
    options: [
      { id: "correct", title: "Correct", approach: "Edit original files", benefits: "No new scope", tradeoffs: "Another try" },
      { id: "revise", title: "Revise", approach: "Request a new outcome", benefits: "Resolves dispute", tradeoffs: "Author input" },
    ] } };
function defaultOps(init: State, log: string[]): { ops: RepairCycleOps<State>; get(): State; set(v: State): void } {
  let current = init;
  return {
    get: () => current,
    set: v => { current = v; },
    ops: {
      begin: async () => current,
      inspect: async sha => {
        assert.equal(sha, current.sourceCommitSha, "restart must use the same source receipt");
        return current;
      },
      correct: async sha => {
        log.push("original-writer:" + sha);
        assert.equal(current.phase, "ready");
        return current = { ...current, phase: "validating", attempts: (current.attempts ?? 0) + 1 };
      },
      choice: async () => choice,
      consume: async () => { log.push("owner-answer"); return current = { ...current, phase: "ready", assignmentVersion: 2 }; },
      validate: async sha => {
        assert.equal(sha, current.sourceCommitSha);
        log.push("native-validate");
        return current = { ...current, phase: "awaiting-checkpoint" };
      },
      commit: async () => {
        log.push("new-signed-checkpoint");
        return current = { ...current, phase: "reviewing", repairedCommitSha: corrected };
      },
      reviewStatus: async () => "required-pending",
      rereview: async () => { log.push("independent-read-only-review"); },
      finishReview: async () => { log.push("seal-independent-verdict"); return current = { ...current, phase: "passed" }; },
      nextFailure: async () => { throw Error("Unexpected failed correction"); },
      adjudicate: async () => { throw Error("Unexpected dispute adjudication"); },
    },
  };
}

test("the production graph retains one review-to-verification-to-scheduling path", async () => {
  const graph = await createGenerationGraph().getGraphAsync();
  for (const name of ["specialist_dispatch", "independent_assignment_review",
    "verify_committed_work", "author_update_intake"])
    assert.ok(graph.nodes[name], "Missing production node " + name);
  for (const [source, target] of [
    ["specialist_dispatch", "independent_assignment_review"],
    ["independent_assignment_review", "verify_committed_work"],
    ["verify_committed_work", "author_update_intake"],
  ]) assert.ok(graph.edges.some(edge => edge.source === source && edge.target === target),
    "Recovery must resume the existing graph at " + source + " -> " + target);
});

test("rejection -> same writer -> actual correction -> native validation -> distinct reviewer -> verified completion", async () => {
  const log: string[] = [];
  const { ops } = defaultOps({ phase: "ready", sourceCommitSha: original }, log);
  const done = await driveRejectedRepairCycle(ops);
  assert.equal(done.next, "completed");
  assert.deepEqual(log, [
    "original-writer:" + original, "native-validate", "new-signed-checkpoint",
    "independent-read-only-review", "seal-independent-verdict",
  ]);
  assert.equal(done.state.repairedCommitSha, corrected);
});

test("pending author steering yields after sealed failed rereview, never in the middle of a writer", async () => {
  const log: string[] = [];
  const flow = defaultOps({ phase: "ready", sourceCommitSha: original, attempts: 0 }, log);
  let pending = true;
  flow.ops.finishReview = async () => {
    log.push("independent-review-failed");
    const current = { ...flow.get(), phase: "failed" as const };
    flow.set(current);
    return current;
  };
  flow.ops.shouldYieldForSteering = async () => pending;
  flow.ops.nextFailure = async () => {
    log.push("next-original-session-writer");
    const current = { ...flow.get(), phase: "ready" as const, sourceCommitSha: corrected };
    flow.set(current);
    return current;
  };
  const pause = await driveRejectedRepairCycle(flow.ops);
  assert.equal(pause.next, "steering-boundary");
  assert.equal(pause.state.phase, "failed");
  assert.deepEqual(log, ["original-writer:" + original, "native-validate",
    "new-signed-checkpoint", "independent-read-only-review",
    "independent-review-failed"]);
  pending = false;
  flow.ops.finishReview = async () => {
    log.push("independent-review-passed");
    const current = { ...flow.get(), phase: "passed" as const };
    flow.set(current);
    return current;
  };
  const resumed = await driveRejectedRepairCycle(flow.ops);
  assert.equal(resumed.next, "completed");
  assert.equal(log.filter(item => item === "original-writer:" + original).length, 1);
  assert.equal(log.filter(item => item === "original-writer:" + corrected).length, 1);
  assert.equal(log.filter(item => item === "independent-review-failed").length, 1);
});

test("argument-only disagreement never invokes validator or reviewer until trusted Author Choice", async () => {
  const log: string[] = [];
  const state: State = { phase: "ready", sourceCommitSha: original };
  const flow = defaultOps(state, log);
  let answer: "awaiting-author" | "answered" = "awaiting-author";
  let writerCalls = 0;
  flow.ops.correct = async () => {
    writerCalls++;
    log.push("writer-returned-no-file-changes");
    const next: State = writerCalls === 1
      ? { phase: "awaiting-author", sourceCommitSha: original, choiceId: choice.id }
      : { phase: "validating", sourceCommitSha: original,
          choiceId: choice.id, assignmentVersion: 2 };
    flow.set(next);
    return next;
  };
  // The model's rebuttal cannot call finishReview; it only creates a question.
  // The trusted Author Choice receipt controls whether execution proceeds.
  flow.ops.choice = async () => ({ ...choice, phase: answer });
  flow.ops.consume = async () => {
    log.push("authenticated-version-2");
    const next: State = { ...flow.get(), phase: "ready", assignmentVersion: 2 };
    flow.set(next);
    return next;
  };
  const disputed = await driveRejectedRepairCycle(flow.ops);
  assert.equal(disputed.next, "author-choice");
  assert.equal(disputed.choice?.proposalSha256, choice.proposalSha256);
  assert.deepEqual(log, ["writer-returned-no-file-changes"]);
  answer = "answered";
  const resumed = await driveRejectedRepairCycle(flow.ops);
  assert.equal(resumed.next, "completed");
  assert.equal(resumed.state.assignmentVersion, 2);
  assert.deepEqual(log, [
    "writer-returned-no-file-changes", "authenticated-version-2",
    "writer-returned-no-file-changes", "native-validate",
    "new-signed-checkpoint", "independent-read-only-review", "seal-independent-verdict",
  ]);
});

test("two failed independent rereviews exhaust bounded correction without touching independent work", async () => {
  const log: string[] = [];
  const independent = { stage: "choice-point", sha: "d".repeat(40), status: "ready" };
  const flow = defaultOps({ phase: "ready", sourceCommitSha: original, attempts: 0 }, log);
  flow.ops.commit = async () => {
    log.push("commit-correction");
    const next: State = { ...flow.get(), phase: "reviewing",
      repairedCommitSha: flow.get().sourceCommitSha === original ? corrected : second };
    flow.set(next);
    return next;
  };
  flow.ops.finishReview = async () => {
    log.push("review-still-failed");
    const state = flow.get();
    const next: State = { ...state, phase: (state.attempts ?? 0) >= 2 ? "blocked" : "failed" };
    flow.set(next);
    return next;
  };
  flow.ops.nextFailure = async () => {
    log.push("restart-original-session-for-new-source");
    const next: State = { ...flow.get(), phase: "ready", sourceCommitSha: corrected };
    flow.set(next);
    return next;
  };
  const outcome = await driveRejectedRepairCycle(flow.ops);
  assert.equal(outcome.next, "author-escalation");
  assert.equal(outcome.state.phase, "blocked");
  assert.equal(outcome.state.attempts, 2);
  assert.equal(log.filter(event => event.startsWith("original-writer:")).length, 2);
  assert.equal(log.filter(event => event === "review-still-failed").length, 2);
  assert.deepEqual(independent, { stage: "choice-point", sha: "d".repeat(40), status: "ready" },
    "Unrelated work never gains an implicit repair attempt or scope change");
});

test("a dispute can never re-seal the original negative checkpoint", async () => {
  await assert.rejects(() => reviewBoundedAssignments({} as JobStartResult, [],
    async () => { throw Error("An adjudicator must not run for a seal request."); },
    "independent-adjudicator", true,
    { sourceSha: original, reviewDigest: "b".repeat(64), path: "events/absence.md",
      line: 1, claim: "Original evidence contradicts the negative finding" }),
    /Adjudication may not overwrite or re-seal/);
});

test("one read-only dispute adjudication cannot erase the sealed negative review or replay the writer", async () => {
  const log: string[] = [];
  const flow = defaultOps({ phase: "disputing", sourceCommitSha: original }, log);
  flow.ops.adjudicate = async () => {
    log.push("deterministic-source-check");
    log.push("fresh-independent-adjudicator");
    const settled: State = { phase: "blocked", sourceCommitSha: original };
    flow.set(settled);
    return settled;
  };
  const outcome = await driveRejectedRepairCycle(flow.ops);
  assert.equal(outcome.next, "author-escalation");
  assert.deepEqual(log, ["deterministic-source-check", "fresh-independent-adjudicator"]);
  await driveRejectedRepairCycle(flow.ops);
  assert.equal(log.length, 2, "a sealed dispute result cannot be re-adjudicated on resume");
});

test("an authenticated other-owner report routes to controller rather than reissuing a write", async () => {
  const log: string[] = [];
  const flow = defaultOps({ phase: "needs-plan", sourceCommitSha: original }, log);
  const result = await driveRejectedRepairCycle(flow.ops);
  assert.equal(result.next, "controller-replan");
  assert.deepEqual(log, [], "a different specialist must obtain its own authorization");
});

test("interrupted original writer is not replayed after restart, regardless of available budget", async () => {
  const log: string[] = [];
  const flow = defaultOps({ phase: "repairing", sourceCommitSha: original,
    attempts: 1 }, log);
  const outcome = await driveRejectedRepairCycle(flow.ops);
  assert.equal(outcome.next, "manual-reconcile");
  assert.match(outcome.reason!, /never replay/);
  assert.deepEqual(log, []);
});

test("Turn-wide twelve-correction allowance is not cut short by the transition guard", async () => {
  const log: string[] = [];
  const flow = defaultOps({ phase: "ready", sourceCommitSha: original, attempts: 0 }, log);
  flow.ops.commit = async () => {
    const state = flow.get();
    const next: State = { ...state, phase: "reviewing",
      repairedCommitSha: (state.attempts! % 16).toString(16).repeat(40) };
    flow.set(next);
    return next;
  };
  flow.ops.finishReview = async () => {
    const state = flow.get();
    const next: State = { ...state, phase: state.attempts === 12 ? "passed" : "failed" };
    flow.set(next);
    return next;
  };
  flow.ops.nextFailure = async () => {
    const state = flow.get();
    const next: State = { ...state, phase: "ready", sourceCommitSha: state.repairedCommitSha! };
    flow.set(next);
    return next;
  };
  const result = await driveRejectedRepairCycle(flow.ops);
  assert.equal(result.next, "completed");
  assert.equal(log.filter(step => step.startsWith("original-writer:")).length, 12);
});

test("bounded controller refuses unexpected loops instead of repeatedly calling the model", async () => {
  const log: string[] = [];
  const flow = defaultOps({ phase: "ready", sourceCommitSha: original }, log);
  flow.ops.correct = async () => flow.get(); // illegal non-progress, durable fail closed
  await assert.rejects(() => driveRejectedRepairCycle(flow.ops, 3), /bounded transition/);
  assert.deepEqual(log, []);
});
