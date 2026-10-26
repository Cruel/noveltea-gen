import assert from "node:assert/strict";
import { test } from "node:test";
import { runCoordinator } from "../src/graph.js";

test("a graph node returns the coordinator's exact response", async () => {
  const calls: unknown[] = [];
  const result = await runCoordinator({
    task: "Please answer",
    threadId: "t1",
    provider: "openai",
    model: "gpt-6-luna",
    invokePi: async (request) => {
      calls.push(request);
      return "The real agent's text";
    },
  });
  assert.equal(result.response, "The real agent's text");
  assert.deepEqual(calls, [{
    task: "Please answer",
    provider: "openai",
    model: "gpt-6-luna",
  }]);
  assert.equal(result.threadId, "t1");
});

test("empty coordinator output is a failed run, not a false success", async () => {
  await assert.rejects(
    () => runCoordinator({
      task: "Prompt", threadId: "t2", provider: "test", model: "test",
      invokePi: async () => "  ",
    }),
    /empty response/,
  );
});

test("model errors propagate rather than returning a fixture response", async () => {
  await assert.rejects(
    () => runCoordinator({
      task: "Prompt", threadId: "t3", provider: "test", model: "test",
      invokePi: async () => { throw new Error("provider denied access"); },
    }),
    /provider denied access/,
  );
});
