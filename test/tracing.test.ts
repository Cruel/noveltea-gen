import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { withRunTree } from "langsmith/traceable";
import { Client, RunTree } from "langsmith";
import langsmithExtension from "@langchain/langsmith-pi-extension";
import { getCurrentRunTree } from "langsmith/singletons/traceable";
import { createProjectResourceLoader } from "../src/pi.js";
import { openStoryProject } from "../src/project.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  provenanceMetadata, tracingEnabled, piTraceExtensions, directTraceOutput,
  traceDirectModel,
} from "../src/tracing.js";
import { runCoordinator, WORKER_DESTINATION, DIRECT_WORKER_DESTINATION } from "../src/graph.js";

const exampleSnapshot = {
  id: "a".repeat(64), digest: "a".repeat(64), path: "/tmp/secret-skills-snapshot",
  commit: "b".repeat(40), branch: "main", detached: false, dirty: true,
};

test("only explicit tracing opt-in permits cloud and requires a key", () => {
  assert.equal(tracingEnabled(false, { LANGSMITH_TRACING: "true", TRACE_TO_LANGSMITH: "true" }), false);
  assert.throws(() => tracingEnabled(true, {}), /LANGSMITH_API_KEY/);
  assert.equal(tracingEnabled(true, { LANGSMITH_API_KEY: "test-key" }), true);
  assert.deepEqual(piTraceExtensions(false, {}), []);
});

test("trace metadata carries only project/run and pinned Git revision identifiers", () => {
  const metadata = provenanceMetadata({
    runId: "run-id", threadId: "thread-id", projectId: "project-id",
    snapshot: exampleSnapshot,
  });
  assert.deepEqual(metadata, {
    "noveltea.run_id": "run-id", "noveltea.thread_id": "thread-id",
    "noveltea.project_id": "project-id",
    "noveltea.skill_snapshot_id": exampleSnapshot.id,
    "noveltea.skill_digest": exampleSnapshot.digest,
    "noveltea.skill_commit": exampleSnapshot.commit,
    "noveltea.skill_branch": "main",
    "noveltea.skill_dirty": true,
  });
  assert.doesNotMatch(JSON.stringify(metadata), /secret-skills-snapshot|api_key|token|SKILL\.md|skills\//i);
  assert.deepEqual(Object.keys(provenanceMetadata({
    runId: "x", threadId: "y", projectId: "z",
  })).sort(), ["noveltea.project_id", "noveltea.run_id", "noveltea.thread_id"]);
});

test("direct-model span output includes response and usage but strips arbitrary provider data", () => {
  const untrusted = {
    text: "A secret in plain sight.", stopReason: "stop",
    usage: { input: 20, cacheRead: 5, cacheWrite: 2, output: 13, totalTokens: 40 },
    apiKey: "SENSITIVE_KEY", providerHeaders: { Authorization: "SENSITIVE_HEADER" },
  };
  assert.deepEqual(directTraceOutput(untrusted), {
    response: untrusted.text, stop_reason: "stop",
    usage_metadata: {
      input_tokens: 27, output_tokens: 13, total_tokens: 40,
      input_token_details: { cache_read: 5, cache_creation: 2 },
    },
  });
  assert.doesNotMatch(JSON.stringify(directTraceOutput(untrusted)), /SENSITIVE_/);
});

test("disabled direct-model trace never builds an exporter and invokes exactly once", async () => {
  let calls = 0;
  const input = { provider: "test", model: "mock", brief: "a tagline" };
  const result = await traceDirectModel(false, input, async () => {
    calls++;
    return { text: "A mystery.", stopReason: "stop" };
  });
  assert.equal(calls, 1);
  assert.equal(result.text, "A mystery.");
  await assert.rejects(traceDirectModel(false, input, async () => {
    throw new Error("original provider failure");
  }), /original provider failure/);
});

test("disabled Pi resource loader has zero extensions even if global trace config is present", async t => {
  const base = await mkdtemp(join(tmpdir(), "nt-gen-tracing-"));
  t.after(async () => rm(base, { recursive: true, force: true }));
  const project = await openStoryProject(join(base, "story"), true);
  const { loader } = createProjectResourceLoader(project, join(base, "agent"));
  await loader.reload();
  assert.deepEqual(loader.getExtensions().extensions, []);
  const allowed = piTraceExtensions(true, { "noveltea.project_id": project.id });
  assert.equal(allowed.length, 1);
  const { loader: enabled } = createProjectResourceLoader(project, join(base, "agent"),
    true, { discovery: "explicit-only", skillDirs: [], requiredSkills: [] }, allowed);
  await enabled.reload();
  assert.equal(enabled.getExtensions().extensions.length, 1, "only the programmatic LangSmith extension loads");
});

test("both graph branches configure the same safe provenance for downstream traces", async () => {
  for (const destination of [WORKER_DESTINATION, DIRECT_WORKER_DESTINATION]) {
    let observed: Record<string, string | boolean> | undefined;
    const result = await runCoordinator({
      project: { root: "/tmp/trace-project", id: "a".repeat(64) },
      provider: "mock", model: "mock", task: "a mystery", threadId: "trace-test",
      skillSnapshot: exampleSnapshot,
      configureTrace(md) { observed = md; },
      async startPi() { return { piSessionId: "coordinator", handoff: { destination, brief: "a secret" } }; },
      async invokeWorker() { return { piSessionId: "worker", update: { storyNote: "The truth was hidden." } }; },
      async invokeDirectWorker() { return { update: { tagline: "Every secret matters." } }; },
      async resumePi() { return { piSessionId: "coordinator", response: "Done." }; },
    });
    assert.equal(observed?.["noveltea.run_id"], result.runId);
    assert.equal(observed?.["noveltea.project_id"], result.projectId);
    assert.equal(observed?.["noveltea.skill_commit"], exampleSnapshot.commit);
    assert.equal(observed?.["noveltea.skill_snapshot_id"], exampleSnapshot.id);
  }
});

test("direct pi-ai model span is scoped to its LangGraph node and sanitizes provider failures", async () => {
  let observed: { name?: string; parent?: string } = {};
  const client = new Client({ apiKey: "mock", apiUrl: "http://127.0.0.1:1" });
  // Intentionally local-only capture: NO network, even when a child span posts.
  Object.assign(client, { createRun: async () => undefined, updateRun: async () => undefined });
  const parent = new RunTree({ name: "offline-root", run_type: "chain", client, tracingEnabled: true });
  await withRunTree(parent, async () => runCoordinator({
    project: { root: "/tmp/story-offline", id: "a".repeat(64) },
    provider: "test", model: "test", task: "tagline", threadId: "span-parent",
    async startPi() {
      return { piSessionId: "coordinator",
        handoff: { destination: DIRECT_WORKER_DESTINATION, brief: "a tagline" } };
    },
    async invokeWorker() { throw new Error("unexpected worker"); },
    async invokeDirectWorker() {
      const completion = await traceDirectModel(true, {
        provider: "test", model: "mock", brief: "a tagline",
      }, async () => {
        const span = getCurrentRunTree(true);
        observed = { name: span?.name, parent: span?.parent_run?.name };
        return { text: '{"tagline":"Every secret has a price."}', stopReason: "stop" };
      });
      return { update: { tagline: JSON.parse(completion.text).tagline } };
    },
    async resumePi() { return { piSessionId: "coordinator", response: "Done." }; },
  }));
  assert.equal(observed.name, "pi-ai direct model request");
  assert.match(observed.parent ?? "", /runnable_lambda|direct_tagline_worker/,
    "the span must be below the graph node rather than an independent root");

  await assert.rejects(() => traceDirectModel(true, {
    provider: "mock", model: "mock", brief: "a tagline",
  }, async () => { throw new Error("SECRET_PROVIDER_KEY leaked in exception"); }),
  error => error instanceof Error && !error.message.includes("SECRET_PROVIDER_KEY"));
});

test("direct-model error and aborted completions fail their own LLM spans with sanitized usage", async () => {
  const client = new Client({ apiKey: "offline-only", apiUrl: "http://127.0.0.1:1",
    autoBatchTracing: false });
  Object.assign(client, { createRun: async () => undefined, updateRun: async () => undefined });
  const parent = new RunTree({ name: "offline-root", run_type: "chain", client, tracingEnabled: true });
  for (const reason of ["error", "aborted", "length", "toolUse", "SECRET_IN_STOP_REASON"] as const) {
    const safeReason = reason === "SECRET_IN_STOP_REASON" ? "unexpected" : reason;
    await assert.rejects(withRunTree(parent, () => traceDirectModel(true,
      { provider: "test", model: "mock", brief: "a tagline" }, async () => ({
        text: "provider returned unusable output", stopReason: reason,
        usage: { input: 11, output: 3, totalTokens: 14 },
        secret: "MUST_NOT_TRACE_PROVIDER_OBJECT",
      }))), new RegExp(safeReason));
    const span = [...parent.child_runs].reverse().find(run => run.name === "pi-ai direct model request");
    assert.ok(span, "a failed provider completion must still yield an LLM span");
    assert.match(span.error ?? "", new RegExp(safeReason));
    assert.equal(span.outputs?.stop_reason, safeReason);
    assert.deepEqual(span.outputs?.usage_metadata, {
      input_tokens: 11, output_tokens: 3, total_tokens: 14,
      input_token_details: { cache_read: 0, cache_creation: 0 },
    });
    assert.doesNotMatch(JSON.stringify(span), /MUST_NOT_TRACE_PROVIDER_OBJECT|SECRET_IN_STOP_REASON/);
  }
});

test("the Pi extension nests agent, turn, provider, tool, and compaction spans under a node", async () => {
  const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<void>>>();
  const fakePi = {
    on(name: string, fn: (event: any, ctx: any) => Promise<void>) {
      const list = handlers.get(name) ?? [];
      list.push(fn);
      handlers.set(name, list);
    },
    registerCommand() {},
  };
  const recorded: Array<Record<string, any>> = [];
  const client = new Client({ apiKey: "offline-only", apiUrl: "http://127.0.0.1:1",
    autoBatchTracing: false });
  Object.assign(client, {
    createRun: async (run: Record<string, any>) => { recorded.push(run); },
    updateRun: async () => undefined,
    awaitPendingTraceBatches: async () => undefined,
  });
  const parent = new RunTree({
    name: "pi_coordinator", run_type: "chain", client, tracingEnabled: true,
  });
  await langsmithExtension(fakePi as never, {
    config: { enabled: true, api_key: "offline-only", project: "offline" },
    client, getCurrentRunTree: () => parent,
  });
  const ctx = {
    cwd: "/tmp/story", sessionManager: { getSessionId: () => "pi-session-1" },
    ui: { setStatus() {} },
    model: { provider: "test", name: "mock" },
    getContextUsage: () => ({ tokens: 20 }),
  };
  const emit = async (name: string, payload: unknown) => {
    assert.ok(handlers.has(name), `Expected ${name} handler`);
    for (const handler of handlers.get(name)!) await handler(payload, ctx);
  };
  const assistant = {
    role: "assistant", content: [{ type: "text", text: "A reveal." }],
    stopReason: "stop", usage: { input: 10, output: 5, totalTokens: 15 },
  };
  await emit("before_agent_start", { prompt: "An opening mystery", images: [] });
  await emit("turn_start", { turnIndex: 0, timestamp: 1 });
  await emit("before_provider_request", { payload: { messages: [{ role: "user", content: "hi" }] } });
  await emit("message_end", { message: assistant });
  await emit("tool_execution_start", {
    toolName: "delegate_to_worker", toolCallId: "tool-1",
    args: { destination: "story_note_worker", brief: "twist" },
  });
  await emit("tool_execution_end", {
    toolCallId: "tool-1", isError: false,
    result: { content: [{ type: "text", text: "Recorded handoff." }] },
  });
  await emit("turn_end", { turnIndex: 0, message: assistant, toolResults: [] });
  await emit("session_compact", {
    reason: "manual", willRetry: false,
    compactionEntry: { summary: "Condensed context", tokensBefore: 100 },
  });
  await emit("agent_end", { messages: [assistant] });
  await emit("agent_settled", {});
  const root = recorded.find(r => r.name === "Pi agent run");
  const turn = recorded.find(r => r.name === "Pi turn 0");
  const model = recorded.find(r => r.run_type === "llm");
  const tool = recorded.find(r => r.name === "delegate_to_worker");
  const compact = recorded.find(r => String(r.name).startsWith("Context Compaction"));
  assert.ok(root && turn && model && tool && compact, JSON.stringify(recorded.map(r => r.name)));
  assert.equal(root.parent_run_id, parent.id);
  assert.equal(turn.parent_run_id, root.id);
  assert.equal(model.parent_run_id, turn.id);
  assert.equal(tool.parent_run_id, turn.id);
  assert.equal(compact.parent_run_id, root.id);
  assert.ok(!JSON.stringify(recorded.map(({ metadata }) => metadata)).includes("offline-only"),
    "API key must not appear in trace metadata");
});

test("graph-only fixture does not turn on tracing from inherited environment variables", async t => {
  const base = resolve("src/cli.ts");
  const story = await mkdtemp(join(tmpdir(), "nt-gen-no-trace-"));
  t.after(async () => rm(story, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ["--import", "tsx", base, "run",
    "--project", story, "--fixture", "--task", "Trace opt-out"], {
    cwd: resolve("."),
    encoding: "utf8", timeout: 30_000,
    env: { ...process.env, LANGSMITH_TRACING: "true", LANGCHAIN_TRACING_V2: "true",
      TRACE_TO_LANGSMITH: "true", LANGSMITH_API_KEY: "" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).tracing, false);
});
