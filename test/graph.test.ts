import assert from "node:assert/strict";
import { test } from "node:test";
import {
  runCoordinator, WORKER_DESTINATION, validateHandoff, validateWorkerReply,
  type CoordinatorOptions,
} from "../src/graph.js";
import type { StoryProject } from "../src/project.js";

const project: StoryProject = { root: "/tmp/story-a", id: "a".repeat(64) };
const base = { task: "Develop a murder mystery", threadId: "t1", provider: "test", model: "fixture", project };

function harness(overrides: Partial<CoordinatorOptions> = {}) {
  const calls: Array<{ stage: string; input: unknown }> = [];
  let sessionAlive = false;
  return {
    calls,
    options: {
      ...base,
      startPi: async (input) => {
        calls.push({ stage: "coordinator-start", input });
        sessionAlive = true;
        return {
          piSessionId: "coordinator-session",
          handoff: { destination: WORKER_DESTINATION, brief: "Propose a twist" },
        };
      },
      invokeWorker: async (input) => {
        calls.push({ stage: "worker", input });
        return { piSessionId: "worker-session", update: { storyNote: "The detective is the culprit." } };
      },
      resumePi: async (input) => {
        calls.push({ stage: "coordinator-resume", input });
        assert.equal(sessionAlive, true, "original coordinator session must still exist");
        return { piSessionId: "coordinator-session", response: "Use the detective twist." };
      },
      ...overrides,
    } satisfies CoordinatorOptions,
  };
}

test("handoff is selected by Pi, graph projects state and resumes the original conversation", async () => {
  const { options, calls } = harness();
  const output = await runCoordinator(options);
  assert.equal(output.response, "Use the detective twist.");
  assert.equal(output.storyNote, "The detective is the culprit.");
  assert.equal(output.piSessionId, "coordinator-session");
  assert.equal(output.workerPiSessionId, "worker-session");
  assert.equal(output.handoffDestination, WORKER_DESTINATION);
  assert.equal(output.graphThreadId, `${project.id}:t1`);
  assert.deepEqual(calls.map(x => x.stage), ["coordinator-start", "worker", "coordinator-resume"]);
  assert.deepEqual(calls[1]?.input, {
    project, provider: "test", model: "fixture",
    work: { brief: "Propose a twist", storyNote: "" },
  });
  assert.deepEqual(calls[2]?.input, {
    storyNote: "The detective is the culprit.",
    workerPiSessionId: "worker-session",
  });
});

test("unknown, malformed, duplicate and extra-key handoffs never execute workers", async () => {
  const invalid = [
    null, undefined, { destination: "other_worker", brief: "x" },
    { destination: WORKER_DESTINATION, brief: "" },
    { destination: WORKER_DESTINATION, brief: 123 },
    { destination: WORKER_DESTINATION, brief: "valid", extra: "secret" },
    [{ destination: WORKER_DESTINATION, brief: "one" }, { destination: WORKER_DESTINATION, brief: "two" }],
  ];
  for (const handoff of invalid) {
    const { options, calls } = harness({ startPi: async () => ({ piSessionId: "coordinator", handoff }) });
    await assert.rejects(() => runCoordinator(options), /handoff|destination|brief/i);
    assert.equal(calls.length, 0, "invalid request must not execute a worker");
  }
  assert.deepEqual(validateHandoff({ destination: WORKER_DESTINATION, brief: "A note" }),
    { destination: WORKER_DESTINATION, brief: "A note" });
});

test("malformed worker results cannot be merged or reported successful", async () => {
  const invalid = [
    {}, null, { piSessionId: "worker", update: { storyNote: "" } },
    { piSessionId: "worker", update: { storyNote: 1 } },
    { piSessionId: "worker", update: { storyNote: "ok", task: "inject" } },
    { piSessionId: "worker", update: { storyNote: "ok" }, extra: true },
    { piSessionId: "coordinator-session", update: { storyNote: "ok" } },
  ];
  for (const workerReply of invalid) {
    const { options, calls } = harness({
      invokeWorker: async () => workerReply as never,
    });
    await assert.rejects(() => runCoordinator(options), /worker|session|storyNote|update/i);
    assert.deepEqual(calls.map(c => c.stage), ["coordinator-start"]);
  }
  assert.deepEqual(validateWorkerReply({ piSessionId: "w", update: { storyNote: "changed" } }, "c"),
    { piSessionId: "w", update: { storyNote: "changed" } });
});

test("coordinator session mismatches, invalid final responses and errors fail closed", async () => {
  for (const resumed of [
    { response: "ok", piSessionId: "wrong" },
    { response: " ", piSessionId: "coordinator-session" },
  ]) {
    const { options } = harness({ resumePi: async () => resumed });
    await assert.rejects(() => runCoordinator(options), /coordinator|response|session/i);
  }
  const { options } = harness({ invokeWorker: async () => { throw new Error("worker failed"); } });
  await assert.rejects(() => runCoordinator(options), /worker failed/);
});

test("missing start-session identity and no handoff fail rather than return a response", async () => {
  const { options } = harness({ startPi: async () => ({
    piSessionId: "", handoff: { destination: WORKER_DESTINATION, brief: "ok" },
  }) });
  await assert.rejects(() => runCoordinator(options), /session identity/i);
});
