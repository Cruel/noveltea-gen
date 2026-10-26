import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";

const cli = resolve("src/cli.ts");

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
    cwd: resolve("."),
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
}

test("fixture runs the compiled LangGraph end-to-end without auth or tracing", () => {
  const result = run(["run", "--fixture", "--task", "Hello, graph", "--thread", "fixed-thread"],
    { LANGSMITH_TRACING: "true", LANGCHAIN_TRACING_V2: "true", LANGSMITH_API_KEY: "" });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "completed");
  assert.equal(output.threadId, "fixed-thread");
  assert.match(output.runId, /^[0-9a-f-]{36}$/i);
  assert.equal(output.response, "Fixture coordinator received: Hello, graph");
  assert.equal(output.mode, "fixture");
  assert.equal(output.provider, "openai");
  assert.equal(output.model, "gpt-6-luna");
  assert.equal(output.tracing, false);
});

test("fixture accepts explicitly selected model and provider", () => {
  const result = run(["run", "--fixture", "--task", "Test", "--provider", "anthropic", "--model", "claude-sonnet-4-5"]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.provider, "anthropic");
  assert.equal(output.model, "claude-sonnet-4-5");
});

test("missing task and malformed arguments fail with useful diagnostics", () => {
  const missing = run(["run", "--fixture"]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /--task/);

  const unexpected = run(["run", "--fixture", "--task", "hello", "--unknown"]);
  assert.notEqual(unexpected.status, 0);
  assert.match(unexpected.stderr, /Unknown option.*--unknown/);
});

test("trace upload needs explicit opt-in and credentials", () => {
  const result = run(["run", "--fixture", "--task", "Hello", "--trace"], {
    LANGSMITH_API_KEY: "",
    LANGCHAIN_API_KEY: "",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /LANGSMITH_API_KEY/);
});

test("usage is available without model credentials", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--fixture/);
  assert.match(result.stdout, /--provider/);
});
