import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, after } from "node:test";
import { removeTestTree } from "./helpers.js";
import { startStoryJob } from "../src/job.js";
import { withStoryJobLock } from "../src/job-lock.js";
import { runCancellableStoryTurn } from "../src/story-interruption.js";
import { observePiTurnSettlement, observePiTurnLifecycle } from "../src/live-pi-registry.js";

const root = mkdtempSync(join(tmpdir(), "nt-interrupt-"));
after(() => removeTestTree(root));
const cli = resolve("src/cli.ts");
function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function setup(name: string) {
  const repo = join(root, name), story = join(repo, "story");
  mkdirSync(story, { recursive: true });
  writeFileSync(join(story, "README.md"), "Original author checkout\n");
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Author");
  git(repo, "config", "user.email", "author@example.test");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "Trusted baseline");
  const state = join(root, name + "-state");
  const run = (...args: string[]) => spawnSync(process.execPath,
    ["--import", "tsx", cli, "job", ...args, "--story", story, "--job", "draft"], {
      cwd: resolve("."), encoding: "utf8", timeout: 45000,
      env: { ...process.env, NT_STATE_DIR: state },
    });
  const start = run("start");
  assert.equal(start.status, 0, start.stderr);
  const job = JSON.parse(start.stdout) as { worktreeRoot: string; worktreeStoryRoot: string };
  return { repo, story, state, job, run };
}
function startSlowWorker(x: ReturnType<typeof setup>, mode: "cancel" | "pause" | "unavailable") {
  const code = `
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startStoryJob } from "./src/job.ts";
import { withStoryJobLock } from "./src/job-lock.ts";
import { runCancellableStoryTurn } from "./src/story-interruption.ts";
import { processAuthorUpdatesAtBoundary } from "./src/author-updates.ts";
import { execFileSync } from "node:child_process";
const job = await startStoryJob({story: ${JSON.stringify(x.story)}, job: "draft"}, false);
await withStoryJobLock(job, "slow-${mode}-fixture", async () => {
  let rejectTurn = () => {}, settled = false, turnTimer;
  const session = {
    sessionId: "deterministic-fixture-session",
    messages: [],
    sessionManager: { getSessionFile: () => join(job.worktreeRoot, "../fixture-session.jsonl") },
    get isStreaming() { return !settled; },
    abort: async () => {
      if (${JSON.stringify(mode)} === "unavailable") throw new Error("provider cannot abort");
      await new Promise(r => setTimeout(r, 350));
      settled = true;
      session.messages.push({ role: "assistant", stopReason: "aborted" });
      clearTimeout(turnTimer);
      rejectTurn(new Error("cooperatively-aborted"));
    },
    waitForIdle: async () => {
      while (!settled) await new Promise(r => setTimeout(r, 20));
    },
  };
  try {
    await runCancellableStoryTurn(session, async () => {
      await writeFile(join(job.worktreeStoryRoot, "unfinished.md"), "Partial specialist edit\\n");
      process.stdout.write("ACTIVE\\n");
      await new Promise((resolve, reject) => {
        rejectTurn = reject;
        turnTimer = setTimeout(() => { settled = true; resolve(true); },
          ${mode === "cancel" ? 10000 : 2600});
      });
    });
    if (${JSON.stringify(mode)} === "pause") {
      execFileSync("git", ["add", "--", "story/unfinished.md"], { cwd: job.worktreeRoot });
      execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
        "commit", "-m", "Completed earlier work"], { cwd: job.worktreeRoot });
      try {
        await processAuthorUpdatesAtBoundary(job);
        process.stdout.write("UNEXPECTED-SECOND-WORK\\n");
      } catch (error) { process.stdout.write("PAUSED-AT-BOUNDARY\\n"); }
    } else {
      process.stdout.write("UNEXPECTED-COMMIT\\n");
    }
  } catch (error) {
    process.stdout.write("STOP:" + error.name + "\\n");
  }
});
`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", code], {
    cwd: resolve("."), env: { ...process.env, NT_STATE_DIR: x.state },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "", errors = "";
  child.stdout!.on("data", chunk => { output += chunk.toString(); });
  child.stderr!.on("data", chunk => { errors += chunk.toString(); });
  const ready = new Promise<void>((resolveReady, reject) => {
    const onData = () => {
      if (output.includes("ACTIVE\n")) { child.stdout!.off("data", onData); resolveReady(); }
    };
    child.stdout!.on("data", onData);
    child.once("exit", code => {
      if (!output.includes("ACTIVE\n")) reject(new Error("Worker exited before active: " + code + " " + errors));
    });
  });
  const done = new Promise<{ code: number | null; output: string; errors: string }>(resolveDone =>
    child.once("exit", code => resolveDone({ code, output, errors })));
  return { child, ready, done };
}
async function settle(worker: { child: ChildProcess; done: Promise<{ code: number | null; output: string; errors: string }> }) {
  const watchdog = setTimeout(() => worker.child.kill("SIGKILL"), 11000);
  try { return await worker.done; } finally { clearTimeout(watchdog); }
}
function json(result: ReturnType<ReturnType<typeof setup>["run"]>) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("cancel reaches an active cross-process specialist, preserves HEAD/partial edits and never releases a live writer", async () => {
  const x = setup("cancel");
  // An earlier independent commit remains untouched by a later cancelled turn.
  writeFileSync(join(x.job.worktreeStoryRoot, "prior.md"), "Earlier accepted work\n");
  git(x.job.worktreeRoot, "add", "story/prior.md");
  git(x.job.worktreeRoot, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "commit", "-m", "Earlier completed work");
  const before = git(x.job.worktreeRoot, "rev-parse", "HEAD");
  const worker = startSlowWorker(x, "cancel");
  try {
    await worker.ready;
    const locked = x.run("author", "process");
    assert.notEqual(locked.status, 0, "another writer must not acquire the active lease");
    assert.match(locked.stderr, /already owned|simultaneous writes/);
    const control = json(x.run("author", "control", "--state", "cancelled"));
    assert.equal(control.status, "cancelled");
    assert.match(control.activeSpecialist?.status ?? "", /cancellation-requested|cooperative-aborted/);
    const end = await settle(worker);
    assert.equal(end.code, 0, end.errors);
    assert.match(end.output, /STOP:StoryCancelledError/);
    assert.doesNotMatch(end.output, /UNEXPECTED-COMMIT/);
    assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), before);
    assert.equal(readFileSync(join(x.job.worktreeStoryRoot, "unfinished.md"), "utf8"), "Partial specialist edit\n");
    assert.equal(git(x.repo, "show", "HEAD:story/README.md"), "Original author checkout");
    const inspection = json(x.run("author", "inspect")).activeSpecialist;
    assert.equal(inspection.phase, "cooperative-aborted");
    assert.equal(inspection.expectedHead, before);
    assert.equal(inspection.actualHead, before);
    assert.ok(inspection.dirtyFiles.some((f: string) => f.includes("unfinished.md")));
    assert.equal(inspection.piSessionId, "deterministic-fixture-session");
    assert.equal(existsSync(join(x.job.worktreeRoot, "../.story-job-running")), false);
    assert.equal(json(x.run("author", "control", "--state", "cancelled")).status, "cancelled");
    assert.notEqual(x.run("author", "control", "--state", "running").status, 0);
  } finally { worker.child.kill("SIGKILL"); }
});

test("unavailable abort retains the writer lock and reports a non-successful interruption", async () => {
  const x = setup("abort-unavailable");
  const worker = startSlowWorker(x, "unavailable");
  try {
    await worker.ready;
    assert.equal(json(x.run("author", "control", "--state", "cancelled")).status, "cancelled");
    const end = await settle(worker);
    assert.equal(end.code, 0, end.errors);
    assert.match(end.output, /STOP:Error/);
    const interruption = json(x.run("author", "inspect")).activeSpecialist;
    assert.equal(interruption.phase, "abort-unavailable");
    assert.match(interruption.error, /provider cannot abort/);
    assert.match(interruption.action, /Inspect the saved Pi session/);
    assert.equal(existsSync(join(x.job.worktreeRoot, "../.story-job-running")), true);
    assert.equal(readFileSync(join(x.job.worktreeStoryRoot, "unfinished.md"), "utf8"), "Partial specialist edit\n");
  } finally { worker.child.kill("SIGKILL"); }
});

test("crashed writer is reported as unconfirmed, never as a successful cancellation", async () => {
  const x = setup("owner-crash");
  const head = git(x.job.worktreeRoot, "rev-parse", "HEAD");
  const worker = startSlowWorker(x, "cancel");
  await worker.ready;
  worker.child.kill("SIGKILL");
  const end = await settle(worker);
  assert.notEqual(end.code, 0);
  const inspection = json(x.run("author", "inspect")).activeSpecialist;
  assert.equal(inspection.phase, "running");
  assert.equal(inspection.status, "owner-exited-without-pi-settlement");
  assert.match(inspection.action, /writer exited without settling Pi/);
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), head);
  assert.equal(existsSync(join(x.job.worktreeRoot, "../.story-job-running")), true);
  assert.equal(readFileSync(join(x.job.worktreeStoryRoot, "unfinished.md"), "utf8"), "Partial specialist edit\n");
});

test("failed durable Pi steering acknowledgement retains writer lease and reports non-success", async () => {
  const x = setup("steering-ack-failure");
  const originalStateDir = process.env.NT_STATE_DIR;
  process.env.NT_STATE_DIR = x.state;
  try {
    const job = await startStoryJob({ story: x.story, job: "draft" }, false);
    observePiTurnSettlement(async () => { throw new Error("DB unavailable during acknowledgement"); });
    await assert.rejects(withStoryJobLock(job, "steering-ack-failure", async () => {
      const session = {
        sessionId: "steering-ack-session",
        sessionManager: { getSessionFile: () => undefined },
        messages: [],
        isStreaming: false,
        async steer() { return "queued" as const; },
        async followUp() { return "queued" as const; },
        async abort() {}, async waitForIdle() {},
      };
      await runCancellableStoryTurn(session, async () => {});
    }), /acknowledgement could not be persisted/);
    const inspection = json(x.run("author", "inspect")).activeSpecialist;
    assert.equal(inspection.phase, "provider-failed");
    assert.match(inspection.error, /steering acknowledgement/);
    assert.equal(existsSync(join(job.stateDir, ".story-job-running")), true,
      "an uncertain delivery cannot release the exclusive writer lease");
  } finally {
    observePiTurnSettlement(undefined);
    if (originalStateDir === undefined) delete process.env.NT_STATE_DIR;
    else process.env.NT_STATE_DIR = originalStateDir;
  }
});

test("failed asynchronous Pi registration retains the writer lease before running the SDK", async () => {
  const x = setup("steering-registration-failure");
  const priorStateDir = process.env.NT_STATE_DIR;
  process.env.NT_STATE_DIR = x.state;
  let attempted = false;
  try {
    const job = await startStoryJob({ story: x.story, job: "draft" }, false);
    observePiTurnLifecycle(async (_, phase) => {
      if (phase === "registered") throw new Error("durable turn registration unavailable");
    });
    await assert.rejects(withStoryJobLock(job, "steering-registration-failure", async () => {
      const session = {
        sessionId: "registration-failure-session",
        sessionManager: { getSessionFile: () => undefined },
        messages: [],
        isStreaming: false,
        async steer() { return "queued" as const; },
        async followUp() { return "queued" as const; },
        async abort() {}, async waitForIdle() {},
      };
      await runCancellableStoryTurn(session, async () => { attempted = true; });
    }), /Cannot register Pi turn durably; writer lock retained/);
    assert.equal(attempted, false, "never start an SDK turn without a durable ownership fence");
    assert.equal(existsSync(join(job.stateDir, ".story-job-running")), true,
      "registration failure must preserve the exclusive writer lease");
    const inspection = json(x.run("author", "inspect")).activeSpecialist;
    assert.equal(inspection.phase, "running", "unsettled Pi receipt remains available for inspection");
  } finally {
    observePiTurnLifecycle(undefined);
    if (priorStateDir === undefined) delete process.env.NT_STATE_DIR;
    else process.env.NT_STATE_DIR = priorStateDir;
  }
});

test("paused control finishes the active turn and prevents the next work item at its safe boundary", async () => {
  const x = setup("pause");
  const worker = startSlowWorker(x, "pause");
  try {
    await worker.ready;
    assert.equal(json(x.run("author", "control", "--state", "paused")).status, "paused");
    const end = await settle(worker);
    assert.equal(end.code, 0, end.errors);
    assert.match(end.output, /PAUSED-AT-BOUNDARY/);
    assert.doesNotMatch(end.output, /STOP:|UNEXPECTED-SECOND-WORK/);
    assert.equal(json(x.run("author", "inspect")).activeSpecialist.phase, "completed");
    assert.equal(git(x.job.worktreeRoot, "rev-list", "--count", "HEAD^..HEAD"), "1");
    assert.equal(git(x.job.worktreeRoot, "status", "--porcelain"), "");
    assert.equal(json(x.run("author", "inspect")).status, "paused");
    assert.equal(json(x.run("author", "control", "--state", "running")).status, "running");
  } finally { worker.child.kill("SIGKILL"); }
});
