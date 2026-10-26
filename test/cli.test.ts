import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";

const cli = resolve("src/cli.ts");
const root = mkdtempSync(join(tmpdir(), "nt-gen-cli-"));
after(() => rmSync(root, { recursive: true, force: true }));

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
    cwd: resolve("."),
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
}

test("fixture runs compiled LangGraph with an explicit project, no auth or tracing", () => {
  const result = run(["run", "--project", root, "--fixture", "--task", "Hello, graph",
    "--thread", "fixed-thread"], {
    LANGSMITH_TRACING: "true", LANGCHAIN_TRACING_V2: "true", LANGSMITH_API_KEY: "",
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "completed");
  assert.equal(output.threadId, "fixed-thread");
  assert.equal(output.projectRoot, root);
  assert.match(output.projectId, /^[a-f0-9]{64}$/);
  assert.equal(output.graphThreadId, `${output.projectId}:fixed-thread`);
  assert.match(output.piSessionId, /^[0-9a-f-]{36}$/i);
  assert.match(output.runId, /^[0-9a-f-]{36}$/i);
  assert.equal(output.response, "Fixture coordinator received: Hello, graph; worker note: A secret in the opening scene changes everything.");
  assert.equal(output.handoffDestination, "story_note_worker");
  assert.equal(output.storyNote, "A secret in the opening scene changes everything.");
  assert.notEqual(output.workerPiSessionId, output.piSessionId);
  assert.match(output.workerPiSessionId, /^[0-9a-f-]{36}$/i);
  assert.equal(output.mode, "fixture");
  assert.equal(output.provider, "openai");
  assert.equal(output.model, "gpt-6-luna");
  assert.equal(output.tracing, false);
});

test("direct fixture routes to only the tagline worker through the public CLI", () => {
  const result = run(["run", "--project", root, "--fixture", "--fixture-direct",
    "--task", "Write a slogan"]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.handoffDestination, "direct_tagline_worker");
  assert.equal(output.tagline, "Every secret has a final chapter.");
  assert.equal(output.response, "Fixture coordinator received: Write a slogan; direct tagline: Every secret has a final chapter.");
  assert.equal(output.workerPiSessionId, undefined);
  assert.equal(output.storyNote, undefined);
  assert.ok(output.piSessionId);
});

test("direct fixture selection is forbidden in live mode", () => {
  const result = run(["run", "--project", root, "--fixture-direct", "--task", "a tagline"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--fixture-direct requires --fixture/);
});

test("fixture accepts explicitly selected model and provider", () => {
  const result = run(["run", "--project", root, "--fixture", "--task", "Test",
    "--provider", "anthropic", "--model", "claude-sonnet-4-5"]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.provider, "anthropic");
  assert.equal(output.model, "claude-sonnet-4-5");
});

test("CLI requires a project and never silently creates one", () => {
  const missingProject = run(["run", "--fixture", "--task", "hello"]);
  assert.notEqual(missingProject.status, 0);
  assert.match(missingProject.stderr, /--project/);
  const nonexistent = join(root, "not-created");
  const noCreation = run(["run", "--project", nonexistent, "--fixture", "--task", "hello"]);
  assert.notEqual(noCreation.status, 0);
  assert.match(noCreation.stderr, /--create-project/);
  assert.equal(existsSync(nonexistent), false);
});

test("CLI explicitly creates an empty project, preserving existing files", () => {
  const newlyCreated = join(root, "new-story");
  const created = run(["run", "--project", newlyCreated, "--create-project", "--fixture", "--task", "hello"]);
  assert.equal(created.status, 0, created.stderr);
  assert.equal(JSON.parse(created.stdout).projectRoot, newlyCreated);
  assert.deepEqual(readdirSync(newlyCreated), []);
  const file = join(newlyCreated, "preserve.txt");
  writeFileSync(file, "keep existing work");
  const rerun = run(["run", "--project", newlyCreated, "--create-project", "--fixture", "--task", "hello"]);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(readFileSync(file, "utf8"), "keep existing work");
});

test("the same thread name is namespaced per project and does not resume another root", () => {
  const first = run(["run", "--project", root, "--fixture", "--task", "hi", "--thread", "shared"]);
  const second = run(["run", "--project", join(root, "other-thread-story"), "--create-project", "--fixture",
    "--task", "hi", "--thread", "shared"]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const a = JSON.parse(first.stdout);
  const b = JSON.parse(second.stdout);
  assert.equal(a.threadId, b.threadId);
  assert.notEqual(a.projectId, b.projectId);
  assert.notEqual(a.graphThreadId, b.graphThreadId);
  assert.notEqual(a.piSessionId, b.piSessionId);
});

test("missing task and malformed arguments fail with useful diagnostics", () => {
  const missing = run(["run", "--project", root, "--fixture"]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /--task/);
  const unexpected = run(["run", "--project", root, "--fixture", "--task", "hello", "--unknown"]);
  assert.notEqual(unexpected.status, 0);
  assert.match(unexpected.stderr, /Unknown option.*--unknown/);
});

test("trace upload needs explicit opt-in and credentials", () => {
  const result = run(["run", "--project", root, "--fixture", "--task", "Hello", "--trace"],
    { LANGSMITH_API_KEY: "", LANGCHAIN_API_KEY: "" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /LANGSMITH_API_KEY/);
});

test("usage is available without model credentials", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--fixture/);
  assert.match(result.stdout, /--project/);
});
