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
  assert.equal(input.skillSnapshot, null, "Studio pins its actual snapshot at workflow start");
  const wrong = spawnSync(process.execPath, [
    "--import", "tsx", resolve("src/studio-input.ts"), "--project",
    join(root, "missing"), "--task", "new Story",
  ], { cwd: resolve("."), encoding: "utf8", timeout: 30_000 });
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /Invalid Story project/);
});

test("Studio selects and persists a fresh snapshot per graph invocation, including changed checkout sources", async t => {
  const { createStudioAdapters } = await import("../src/studio-runtime.js");
  const { createCoordinatorGraph, WORKER_DESTINATION } = await import("../src/graph.js");
  const { openStoryProject } = await import("../src/project.js");
  const root = mkdtempSync(join(tmpdir(), "nt-studio-snapshot-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const story = await openStoryProject(root);
  const a = { id: "a".repeat(64), digest: "a".repeat(64), path: "/snapshot/A",
    commit: "1".repeat(40), branch: "main", detached: false, dirty: false };
  const b = { ...a, id: "b".repeat(64), digest: "b".repeat(64),
    path: "/snapshot/B", commit: "2".repeat(40) };
  let captures = 0;
  const pinned: string[] = [];
  const traced: string[] = [];
  const graph = createCoordinatorGraph(createStudioAdapters(async () => {
    const snapshot = [a, b][captures++]!;
    return { snapshot, pi: {
      pinSkillSnapshot(selected) { pinned.push(selected?.id ?? "none"); },
      configureTrace(metadata) { traced.push(String(metadata["noveltea.skill_snapshot_id"])); },
      async startPi() { return { piSessionId: `studio-${captures}`,
        handoff: { destination: WORKER_DESTINATION, brief: "premise" } }; },
      async invokeWorker() { return { piSessionId: `worker-${captures}`, update: { storyNote: "A twist." } }; },
      async invokeDirectWorker() { throw new Error("wrong branch"); },
      async resumePi() { return { piSessionId: `studio-${captures}`, response: "The twist is in." }; },
    } };
  }));
  const run = (stale: typeof a | null) => graph.invoke({
    task: "A locked room", provider: "test", model: "fixture", projectRoot: story.root,
    projectId: story.id, executionMode: "pi", storyNote: "", tagline: "",
    piSessionId: "", workerPiSessionId: "", response: "", skillSnapshot: stale,
  });
  const first = await run(null);
  // A developer may paste a stale state, but Studio must override it with
  // the snapshot it actually installs into Pi on this invocation.
  const second = await run(a);
  assert.equal(first.skillSnapshot?.id, a.id);
  assert.equal(second.skillSnapshot?.id, b.id);
  assert.equal(second.skillSnapshot?.commit, b.commit);
  assert.deepEqual(pinned, [a.id, b.id]);
  assert.deepEqual(traced, [a.id, b.id]);
  assert.equal(captures, 2);
  assert.equal(second.response, "The twist is in.");
});
