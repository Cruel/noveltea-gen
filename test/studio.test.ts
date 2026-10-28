import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

test("langgraph.json registers only production Story generation", () => {
  const config = JSON.parse(readFileSync(resolve("langgraph.json"), "utf8"));
  assert.deepEqual(config.graphs, { story_generation: "./src/studio.ts:graph" });
  assert.deepEqual(config.dependencies, ["."]);
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
