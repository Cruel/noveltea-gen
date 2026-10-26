import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, statSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  sanitizeTrace, startLocalTrace, recordLocalGraph, readLocalTrace, formatLocalTrace, latestLocalTrace,
} from "../src/local-trace.js";

const cli = resolve("src/cli.ts");

test("local tracing records all graph branches without cloud credentials or hosted tracing", t => {
  for (const direct of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), "nt-local-spans-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const traceDir = join(root, "traces");
    const projectRoot = join(root, "story");
    const env = {
      ...process.env, NT_LOCAL_TRACE_DIR: traceDir, NT_STATE_DIR: join(root, "state"),
      LANGSMITH_TRACING: "true", LANGCHAIN_TRACING_V2: "true", TRACE_TO_LANGSMITH: "true",
      LANGSMITH_API_KEY: "", NT_API_KEY: "SYNTHETIC_DEV_SECRET_999999",
    };
    const command = spawnSync(process.execPath, [
      "--import", "tsx", cli, "run", "--project", projectRoot, "--create-project",
      "--fixture", ...(direct ? ["--fixture-direct"] : []), "--trace-local",
      "--task", "Use SYNTHETIC_DEV_SECRET_999999 in a synthetic test",
    ], { cwd: resolve("."), env, encoding: "utf8", timeout: 30_000 });
    assert.equal(command.status, 0, command.stderr);
    const output = JSON.parse(command.stdout);
    assert.equal(output.tracing, false, "local tracing must not enable cloud");
    assert.ok(output.localTrace?.startsWith(traceDir));
    assert.equal(statSync(output.localTrace).mode & 0o777, 0o600);
    const file = readFileSync(output.localTrace, "utf8");
    assert.doesNotMatch(file, /SYNTHETIC_DEV_SECRET_999999/, "local trace must redact configured credentials");
    assert.match(file, /\[REDACTED\]/);

    const viewing = spawnSync(process.execPath, [
      "--import", "tsx", resolve("src/trace-show.ts"), "--json",
    ], { cwd: resolve("."), env, encoding: "utf8", timeout: 30_000 });
    assert.equal(viewing.status, 0, viewing.stderr);
    const { spans } = JSON.parse(viewing.stdout);
    const names = spans.map((s: { name: string }) => s.name);
    for (const expected of ["NovelTea LangGraph execution", "LangGraph", "pi_coordinator", "pi_continuation"]) {
      assert.ok(names.includes(expected), `Missing ${expected}: ${names.join(",")}`);
    }
    assert.ok(names.includes(direct ? "direct_tagline_worker" : "story_note_worker"));
    assert.ok(!names.includes(direct ? "story_note_worker" : "direct_tagline_worker"));
    assert.ok(spans.every((s: { end_time?: string | number }) => s.end_time),
      "all callback updates must be flushed before returning the CLI result");
    const graph = spans.find((s: { name: string }) => s.name === "LangGraph");
    const rootSpan = spans.find((s: { name: string }) => s.name === "NovelTea LangGraph execution");
    assert.equal(graph.parent_run_id, rootSpan.id);
    assert.match(spans.map((s: { name: string }) => s.name).join(" "), /pi_coordinator/);
  }
});

test("local event writer merges SDK create and update spans and generates a deterministic tree", async t => {
  const dir = mkdtempSync(join(tmpdir(), "nt-local-events-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const previous = process.env.NT_LOCAL_TRACE_DIR;
  process.env.NT_LOCAL_TRACE_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.NT_LOCAL_TRACE_DIR;
    else process.env.NT_LOCAL_TRACE_DIR = previous;
  });
  const recorder = await startLocalTrace();
  try {
    const result = await recordLocalGraph(recorder, async () => "ok", {
      projectId: "a".repeat(64), threadId: "local-thread",
    });
    assert.equal(result, "ok");
  } finally {
    await recorder.close();
  }
  const spans = await readLocalTrace(recorder.file);
  assert.equal(spans.length, 1);
  assert.equal(spans[0]?.name, "NovelTea LangGraph execution");
  assert.ok(spans[0]?.end_time);
  assert.match(formatLocalTrace(spans), /OK \[chain\] NovelTea LangGraph execution/);
  assert.equal(await latestLocalTrace(dir), recorder.file);
  assert.equal(statSync(recorder.file).mode & 0o777, 0o600);
});

test("local trace writes error records, closes safely and preserves original exceptions", async t => {
  const dir = mkdtempSync(join(tmpdir(), "nt-local-errors-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const previous = process.env.NT_LOCAL_TRACE_DIR;
  process.env.NT_LOCAL_TRACE_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.NT_LOCAL_TRACE_DIR;
    else process.env.NT_LOCAL_TRACE_DIR = previous;
  });
  const recorder = await startLocalTrace();
  try {
    await assert.rejects(() => recordLocalGraph(recorder, async () => {
      throw new Error("Synthetic worker failed");
    }, { projectId: "a".repeat(64), threadId: "fail" }), /Synthetic worker failed/);
  } finally {
    await recorder.close();
  }
  const spans = await readLocalTrace(recorder.file);
  assert.equal(spans.length, 1);
  assert.match(spans[0]?.error ?? "", /Synthetic worker failed/);
  assert.match(formatLocalTrace(spans), /ERROR \[chain\]/);
});

test("local sanitizer removes known credentials and protects against circular and oversized payloads", () => {
  const cyclic: Record<string, unknown> = {
    authorization: "Bearer should-never-appear",
    apiKey: "highly-secret",
    messages: [{ content: "secret-marker-abc and harmless" }],
    token_usage: { total_tokens: 11 },
  };
  cyclic.circular = cyclic;
  const result = sanitizeTrace(cyclic, { TRACE_API_KEY: "secret-marker-abc" });
  const text = JSON.stringify(result);
  assert.doesNotMatch(text, /should-never-appear|highly-secret|secret-marker-abc/);
  assert.match(text, /\[REDACTED\]/);
  assert.match(text, /\[CIRCULAR\]/);
  assert.match(text, /harmless/);
  assert.match(text, /total_tokens/);
});
