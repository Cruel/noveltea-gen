import assert from "node:assert/strict";
import { test } from "node:test";
import { runCoordinator } from "../src/graph.js";
import type { StoryProject } from "../src/project.js";

const project: StoryProject = { root: "/tmp/story-a", id: "a".repeat(64) };

test("a graph node returns the coordinator response and project-specific Pi session ID", async () => {
  const calls: unknown[] = [];
  const result = await runCoordinator({
    task: "Please answer",
    threadId: "t1",
    provider: "openai",
    model: "gpt-6-luna",
    project,
    invokePi: async (request) => {
      calls.push(request);
      return { response: "The real agent's text", piSessionId: "pi-session" };
    },
  });
  assert.equal(result.response, "The real agent's text");
  assert.equal(result.piSessionId, "pi-session");
  assert.deepEqual(calls, [{
    task: "Please answer",
    provider: "openai",
    model: "gpt-6-luna",
    project,
  }]);
  assert.equal(result.threadId, "t1");
  assert.equal(result.graphThreadId, `${project.id}:t1`);
});

test("empty coordinator output or missing session ID is a failed run", async () => {
  const shared = { task: "Prompt", threadId: "t2", provider: "test", model: "test", project };
  await assert.rejects(
    () => runCoordinator({
      ...shared,
      invokePi: async () => ({ response: " ", piSessionId: "session" }),
    }),
    /empty response/,
  );
  await assert.rejects(
    () => runCoordinator({
      ...shared,
      invokePi: async () => ({ response: "reply", piSessionId: "" }),
    }),
    /session identity/,
  );
});

test("model errors propagate rather than returning a fixture response", async () => {
  await assert.rejects(
    () => runCoordinator({
      task: "Prompt", threadId: "t3", provider: "test", model: "test", project,
      invokePi: async () => { throw new Error("provider denied access"); },
    }),
    /provider denied access/,
  );
});
