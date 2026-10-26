import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

test("langgraph.json references the real coordinator graph through the local Studio entry", () => {
  const config = JSON.parse(readFileSync(resolve("langgraph.json"), "utf8"));
  assert.equal(config.graphs.noveltea, "./src/studio.ts:graph");
  assert.deepEqual(config.dependencies, ["."]);
});

test("Studio input generator canonicalizes an existing Story and does not create Story files", t => {
  const root = mkdtempSync(join(tmpdir(), "nt-studio-input-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [
    "--import", "tsx", resolve("src/studio-input.ts"),
    "--project", root, "--task", "Create a mystery",
    "--provider", "openai", "--model", "gpt-6-luna",
  ], { cwd: resolve("."), encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  const input = JSON.parse(result.stdout);
  assert.equal(input.projectRoot, root);
  assert.equal(input.task, "Create a mystery");
  assert.match(input.projectId, /^[a-f0-9]{64}$/);
  assert.equal(input.executionMode, "pi");
  assert.equal(input.handoff, null);
  assert.equal(input.piSessionId, "");
  assert.equal(input.storyNote, "");
  assert.equal(input.tagline, "");
  if (input.skillSnapshot != null) {
    assert.equal(input.skillSnapshot.id, input.skillSnapshot.digest);
    assert.match(input.skillSnapshot.commit, /^[a-f0-9]{40}$/);
  }
  const wrong = spawnSync(process.execPath, [
    "--import", "tsx", resolve("src/studio-input.ts"), "--project",
    join(root, "missing"), "--task", "new Story",
  ], { cwd: resolve("."), encoding: "utf8", timeout: 30_000 });
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /Invalid Story project/);
});
