import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, copyFileSync, rmSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { sessionDirectory } from "../src/checkpoint.js";
import { runCoordinator, WORKER_DESTINATION, type CoordinatorOptions } from "../src/graph.js";
import { openStoryProject, type StoryProject } from "../src/project.js";

const cli = resolve("src/cli.ts");

function fixture(t: { after: (fn: () => void) => void }) {
  const base = mkdtempSync(join(tmpdir(), "nt-gen-checkpoint-"));
  const project = join(base, "story");
  mkdirSync(project);
  const state = join(base, "state");
  const env = { ...process.env, NT_STATE_DIR: state };
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const run = (args: string[]) => spawnSync(
    process.execPath, ["--import", "tsx", cli, "run", "--project", project, "--fixture", ...args],
    { cwd: resolve("."), env, encoding: "utf8", timeout: 30_000 },
  );
  return { project, state, env, run };
}

function success(result: ReturnType<ReturnType<typeof fixture>["run"]>) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("restart after handoff preserves thread/session and never reruns coordinator", (t) => {
  const { run, project } = fixture(t);
  const paused = success(run(["--task", "An old manor", "--thread", "story-1", "--pause-after", "handoff"]));
  assert.equal(paused.status, "paused");
  assert.deepEqual(paused.next, ["story_note_worker"]);
  assert.equal(paused.response, undefined);
  const resumed = success(run(["--thread", "story-1", "--resume"]));
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.piSessionId, paused.piSessionId);
  assert.equal(resumed.graphThreadId, paused.graphThreadId);
  assert.match(resumed.response, /An old manor/);
  assert.ok(resumed.workerPiSessionId);
  assert.notEqual(resumed.workerPiSessionId, resumed.piSessionId);
  const again = success(run(["--thread", "story-1", "--resume"]));
  assert.equal(again.workerPiSessionId, resumed.workerPiSessionId);
  assert.equal(again.response, resumed.response);
  const collision = run(["--thread", "story-1", "--task", "Overwrite"]);
  assert.notEqual(collision.status, 0);
  assert.match(collision.stderr, /already has a checkpoint/);
  assert.deepEqual(readdirSync(project), [], "checkpointing must not populate an empty Story root");
});

test("worker checkpoint persists both Pi session histories and skips worker after restart", (t) => {
  const { run } = fixture(t);
  const paused = success(run(["--thread", "post-worker", "--task", "Plot twist", "--pause-after", "worker"]));
  assert.equal(paused.status, "paused");
  assert.deepEqual(paused.next, ["pi_continuation"]);
  assert.ok(paused.workerPiSessionId);
  const result = success(run(["--thread", "post-worker", "--resume"]));
  assert.equal(result.piSessionId, paused.piSessionId);
  assert.equal(result.workerPiSessionId, paused.workerPiSessionId);
  assert.equal(result.status, "completed");
  assert.match(result.response, /Plot twist/);
});

test("direct model branch recovery stores no worker Pi session and never invokes the other worker", (t) => {
  const { run } = fixture(t);
  const paused = success(run([
    "--thread", "direct", "--fixture-direct", "--task", "Promotional slogan",
    "--pause-after", "worker",
  ]));
  assert.deepEqual(paused.next, ["pi_continuation"]);
  assert.equal(paused.handoffDestination, "direct_tagline_worker");
  assert.equal(paused.workerPiSessionId, undefined);
  const resumed = success(run(["--thread", "direct", "--resume"]));
  assert.equal(resumed.tagline, paused.tagline);
  assert.equal(resumed.storyNote, undefined);
  assert.equal(resumed.workerPiSessionId, undefined);
  assert.equal(resumed.piSessionId, paused.piSessionId);
});

test("missing sessions, wrong modes, wrong roots and corrupt databases fail closed", async (t) => {
  const { run, state, project, env } = fixture(t);
  const empty = run(["--thread", "unknown", "--resume"]);
  assert.notEqual(empty.status, 0);
  assert.match(empty.stderr, /no SQLite checkpoint/);
  const paused = success(run(["--thread", "recover", "--task", "Mystery", "--pause-after", "handoff"]));
  const mismatchedMode = spawnSync(
    process.execPath, ["--import", "tsx", cli, "run", "--project", project, "--thread", "recover", "--resume"],
    { cwd: resolve("."), env, encoding: "utf8", timeout: 30_000 },
  );
  assert.notEqual(mismatchedMode.status, 0);
  assert.match(mismatchedMode.stderr, /execution mode/);

  const p = await openStoryProject(project);
  const sessionsDir = join(state, p.id, "fixture-sessions");
  const sessionFiles = readdirSync(sessionsDir).filter((file) => file.includes(paused.piSessionId));
  assert.equal(sessionFiles.length, 1);
  unlinkSync(join(sessionsDir, sessionFiles[0]!));
  const missing = run(["--thread", "recover", "--resume"]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Cannot recover Pi session/);

  const other = join(project, "..", "different-project");
  mkdirSync(other);
  const otherProject = await openStoryProject(other);
  mkdirSync(join(state, otherProject.id), { recursive: true });
  copyFileSync(join(state, p.id, "checkpoints.sqlite"), join(state, otherProject.id, "checkpoints.sqlite"));
  const foreign = spawnSync(process.execPath,
    ["--import", "tsx", cli, "run", "--project", other, "--fixture", "--thread", "recover", "--resume"],
    { cwd: resolve("."), env, encoding: "utf8", timeout: 30_000 });
  assert.notEqual(foreign.status, 0);
  assert.match(foreign.stderr, /no checkpoint for this thread and Story root/i);

  writeFileSync(join(state, p.id, "checkpoints.sqlite"), "not a SQLite database");
  const corrupt = run(["--thread", "recover", "--resume"]);
  assert.notEqual(corrupt.status, 0);
  assert.match(corrupt.stderr, /Cannot read SQLite checkpoint/);
});

test("malformed persisted Pi JSONL history is rejected rather than silently skipped", async (t) => {
  const { run, state } = fixture(t);
  const paused = success(run(["--thread", "bad-jsonl", "--task", "Mystery", "--pause-after", "handoff"]));
  const files = readdirSync(join(state, paused.projectId, "fixture-sessions"));
  const path = join(state, paused.projectId, "fixture-sessions",
    files.find((name) => name.includes(paused.piSessionId))!);
  appendFileSync(path, "{malformed transcript entry}\\n");
  const resumed = run(["--thread", "bad-jsonl", "--resume"]);
  assert.notEqual(resumed.status, 0);
  assert.match(resumed.stderr, /Cannot recover Pi session/);
});

test("failed or canceled worker leaves committed handoff retryable without repeating coordinator", async (t) => {
  const { project, state } = fixture(t);
  const oldStateDir = process.env.NT_STATE_DIR;
  process.env.NT_STATE_DIR = state;
  t.after(() => {
    if (oldStateDir === undefined) delete process.env.NT_STATE_DIR;
    else process.env.NT_STATE_DIR = oldStateDir;
  });
  const root: StoryProject = await openStoryProject(project);
  let coordinatorCalls = 0;
  let workerCalls = 0;
  const startPi: CoordinatorOptions["startPi"] = async () => {
    coordinatorCalls += 1;
    const manager = SessionManager.create(root.root, sessionDirectory(root, "fixture"));
    manager.appendMessage({ role: "user", content: "Coordinator prompt", timestamp: Date.now() });
    return {
      piSessionId: manager.getSessionId(),
      piSessionFile: manager.getSessionFile(),
      handoff: { destination: WORKER_DESTINATION, brief: "Propose a twist" },
    };
  };
  const options: CoordinatorOptions = {
    task: "Uncover a secret", provider: "test", model: "test", project: root,
    threadId: "retry", startPi,
    invokeWorker: async () => { workerCalls++; throw new Error("worker unavailable"); },
    invokeDirectWorker: async () => { throw new Error("wrong worker"); },
    resumePi: async () => ({ piSessionId: "unused", response: "unused" }),
    persistence: { mode: "fixture", pauseAfter: "handoff" },
  };
  const paused = await runCoordinator(options);
  assert.equal(paused.status, "paused");
  assert.equal(coordinatorCalls, 1);

  for (const message of ["worker unavailable", "worker canceled"]) {
    const attempted: CoordinatorOptions = {
      ...options,
      persistence: { mode: "fixture", resume: true },
      restorePi: async () => {},
      invokeWorker: async () => {
        workerCalls++;
        if (message === "worker canceled") {
          throw new DOMException(message, "AbortError");
        }
        throw new Error(message);
      },
    };
    await assert.rejects(() => runCoordinator(attempted), new RegExp(message));
    assert.equal(coordinatorCalls, 1);
  }
  assert.equal(workerCalls, 2);
  let restoredId = "";
  let configuredTrace: Record<string, string | boolean> | undefined;
  const done = await runCoordinator({
    ...options, persistence: { mode: "fixture", resume: true },
    configureTrace: (metadata) => { configuredTrace = metadata; },
    restorePi: async ({ coordinator }) => {
      assert.equal(configuredTrace?.["noveltea.project_id"], root.id,
        "restored Pi must receive trace provenance before session construction");
      restoredId = coordinator.id;
    },
    invokeWorker: async () => {
      workerCalls++;
      const manager = SessionManager.create(root.root, sessionDirectory(root, "fixture"));
      manager.appendMessage({ role: "user", content: "Worker prompt", timestamp: Date.now() });
      return { piSessionId: manager.getSessionId(), piSessionFile: manager.getSessionFile(),
        update: { storyNote: "The missing key is in the attic." } };
    },
    resumePi: async (update) => ({
      piSessionId: restoredId,
      response: update.destination === WORKER_DESTINATION ? update.storyNote : "wrong worker",
    }),
  });
  assert.equal(done.status, "completed");
  assert.equal(done.storyNote, "The missing key is in the attic.");
  assert.equal(workerCalls, 3);
  assert.equal(coordinatorCalls, 1);
});

test("malformed Pi handoff cannot become a recoverable committed worker transition", async (t) => {
  const { project, state } = fixture(t);
  const oldStateDir = process.env.NT_STATE_DIR;
  process.env.NT_STATE_DIR = state;
  t.after(() => {
    if (oldStateDir === undefined) delete process.env.NT_STATE_DIR;
    else process.env.NT_STATE_DIR = oldStateDir;
  });
  const root = await openStoryProject(project);
  let workerCalls = 0;
  const invalid: CoordinatorOptions = {
    task: "Story", threadId: "bad-handoff", provider: "test", model: "test", project: root,
    persistence: { mode: "fixture", pauseAfter: "handoff" },
    startPi: async () => {
      const manager = SessionManager.create(root.root, sessionDirectory(root, "fixture"));
      manager.appendMessage({ role: "user", content: "Attempted handoff", timestamp: Date.now() });
      return { piSessionId: manager.getSessionId(), piSessionFile: manager.getSessionFile(),
        handoff: { destination: "pi_continuation", brief: "bypass worker" } };
    },
    invokeWorker: async () => { workerCalls++; throw new Error("must not run"); },
    invokeDirectWorker: async () => { workerCalls++; throw new Error("must not run"); },
    resumePi: async () => { throw new Error("must not resume"); },
  };
  await assert.rejects(() => runCoordinator(invalid), /Invalid Pi handoff/);
  assert.equal(workerCalls, 0);
  await assert.rejects(() => runCoordinator({ ...invalid, persistence: { mode: "fixture", resume: true } }),
    /Invalid Pi handoff|lacks a persisted coordinator/);
  assert.equal(workerCalls, 0);
});
