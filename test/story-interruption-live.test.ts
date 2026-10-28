import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { removeTestTree } from "./helpers.js";

const enabled = process.env.NT_LIVE_CANCEL === "1";
const cli = resolve("src/cli.ts");

test("opt-in live Pi specialist cooperatively aborts without publishing unfinished work", {
  skip: enabled ? false : "set NT_LIVE_CANCEL=1 with Pi credentials and NT_SKILLS_CHECKOUT",
  timeout: 300_000,
}, async () => {
  const source = resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills");
  assert.ok(existsSync(join(source, "skills/nt-story-discovery/SKILL.md")));
  const temp = mkdtempSync(join(tmpdir(), "nt-live-cancel-"));
  after(() => removeTestTree(temp));
  const repo = join(temp, "author"), story = join(repo, "story");
  mkdirSync(story, { recursive: true });
  writeFileSync(join(repo, "README.txt"), "Trusted author's repo\n");
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q"); git("config", "user.name", "Author");
  git("config", "user.email", "author@example.test");
  git("add", "."); git("commit", "-qm", "Original author baseline");
  const base = git("rev-parse", "HEAD");
  const env = { ...process.env, NT_STATE_DIR: join(temp, "state"),
    NT_SKILL_CACHE_DIR: join(temp, "skills-cache"),
    NT_VALIDATOR_CACHE_DIR: join(temp, "validator-cache") };
  const cmd = (...args: string[]) => {
    const result = spawnSync(process.execPath, ["--import", "tsx", cli, "job", ...args], {
      cwd: resolve("."), env, encoding: "utf8", timeout: 45000,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const job = cmd("start", "--story", story, "--job", "live-cancel");
  const head = git("-C", job.worktreeRoot, "rev-parse", "HEAD");
  const args = ["--import", "tsx", cli, "job", "foundation", "--story", story,
    "--job", "live-cancel", "--task",
    "Develop a dialogue-driven mystery about a forgotten witness on a remote island. " +
    "Invent the character motivations, conflicts, scope and central creative direction.",
    "--skills-source", source, "--validator-source", source];
  if (process.env.NT_PROVIDER) args.push("--provider", process.env.NT_PROVIDER);
  if (process.env.NT_MODEL) args.push("--model", process.env.NT_MODEL);
  const worker = spawn(process.execPath, args, { cwd: resolve("."), env,
    stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", exited = false;
  worker.stdout!.on("data", value => { stdout += value.toString(); });
  worker.stderr!.on("data", value => { stderr += value.toString(); });
  const done = new Promise<void>(resolveDone => worker.once("exit", () => {
    exited = true; resolveDone();
  }));
  try {
    const receiptPath = join(dirname(job.worktreeRoot), "active-specialist.json");
    const deadline = Date.now() + 180_000;
    while (!existsSync(receiptPath) && !exited && Date.now() < deadline)
      await new Promise(r => setTimeout(r, 100));
    assert.ok(existsSync(receiptPath) && !exited,
      "Live Pi must reach an active turn before cancellation. " + stderr + stdout);
    const before = JSON.parse(readFileSync(receiptPath, "utf8"));
    assert.equal(before.phase, "running");
    assert.ok(before.piSessionFile);
    assert.equal(cmd("author", "control", "--story", story, "--job", "live-cancel",
      "--state", "cancelled").status, "cancelled");
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([done, new Promise((_, reject) => {
        watchdog = setTimeout(() =>
          reject(new Error("Pi cooperative abort remained unresponsive; inspect lock and session")), 75_000);
      })]);
    } finally { if (watchdog) clearTimeout(watchdog); }
    const inspect = cmd("author", "inspect", "--story", story, "--job", "live-cancel");
    assert.equal(inspect.status, "cancelled");
    assert.equal(inspect.activeSpecialist.phase, "cooperative-aborted");
    assert.equal(inspect.activeSpecialist.actualHead, head);
    assert.ok(existsSync(before.piSessionFile));
    assert.equal(git("rev-parse", "HEAD"), base);
    assert.equal(git("-C", job.worktreeRoot, "rev-parse", "HEAD"), head);
    const recovery = cmd("foundation", "--inspect", "--story", story, "--job", "live-cancel");
    assert.match(recovery.recovery.reason, /Interrupted writer/);
    assert.ok(!existsSync(join(dirname(job.worktreeRoot), ".story-job-running")));
  } finally {
    if (!exited) worker.kill("SIGTERM");
    await Promise.race([done, new Promise<void>(resolveDone => setTimeout(resolveDone, 2000))]);
  }
});
