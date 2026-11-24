import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { removeTestTree } from "./helpers.js";

const root = mkdtempSync(join(tmpdir(), "nt-job-restart-"));
after(() => removeTestTree(root));
const skills = resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills");
const available = existsSync(join(skills, "src/cli.ts"));
const cliPath = resolve("src/cli.ts");
type Outcome = ReturnType<typeof spawnSync>;

function git(cwd: string, ...args: string[]) {
  const out = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout.trim();
}
function setup(name: string) {
  const repo = join(root, name);
  const story = join(repo, "story");
  mkdirSync(join(story, "creative-direction"), { recursive: true });
  writeFileSync(join(story, "creative-direction/foundation.md"), `---
schema: '0.1'
type: creative-direction
id: creative-direction.foundation
title: "The missing witness"
status: draft
decisions: []
premise: "The witness vanishes before an inquiry"
central_conflict: "Truth or loyalty"
genre: "Mystery"
tone: "Intimate"
player_experience: "Consequential investigation"
scope: "Small dialogue-led adventure"
---

A witness disappears. The inquiry challenges a friendship.
`);
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Author");
  git(repo, "config", "user.email", "author@example.test");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "Author's original Story");
  const base = git(repo, "rev-parse", "HEAD");
  const contract = join(root, name + "-contract.json");
  writeFileSync(contract, JSON.stringify({
    scope: { kind: "partial", depth: "architecture", targets: [], branches: [] },
    constraints: ["Respect author decisions"],
    envelope: { presentation: "Dialogue-led", hardLimits: [], preferences: ["Small cast"] },
  }));
  const stateRoot = join(root, name + "-state");
  const config = join(root, name + "-config.json");
  writeFileSync(config, JSON.stringify({ novelteaSkills: skills,
    skillDiscovery: "explicit-only", skillDirs: [], requiredSkills: ["nt-catalog"] }));
  function cli(...args: string[]): Outcome {
    return spawnSync(process.execPath, ["--import", "tsx", cliPath, "job", ...args,
      "--story", story, "--job", "draft"], {
      encoding: "utf8", timeout: 90000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, NT_CONFIG_FILE: config,
        NT_GIT_CACHE_DIR: name === "handoff" ? join(root, "evictable-cache") : undefined,
        NT_STATE_DIR: stateRoot, NT_SKILL_CACHE_DIR: join(root, "skills-cache"),
         },
    });
  }
  const created = cli("start");
  assert.equal(created.status, 0, created.stderr);
  const job = JSON.parse(created.stdout) as {
    jobId: string; threadId: string; branch: string; stateDir: string;
    worktreeRoot: string; worktreeStoryRoot: string; baseSha: string;
  };
  const receiptFile = join(job.stateDir, "architecture.json");
  const readReceipt = () => JSON.parse(readFileSync(receiptFile, "utf8"));
  const saveReceipt = (receipt: unknown) => writeFileSync(receiptFile, JSON.stringify(receipt, null, 2));
  const authored = () => {
    const r = cli("architecture", "run", "--contract", contract, "--fixture", "--skills-source", skills);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout) as { headSha: string; plan: { items: Array<{ verifiedSha?: string }> } };
  };
  return { repo, story, contract, base, cli, job, readReceipt, saveReceipt, authored };
}
function expectOk(out: Outcome) {
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout);
}
function count(jobRoot: string, base: string) {
  return Number(git(jobRoot, "rev-list", "--count", base + "..HEAD"));
}
function digest(path: string) {
  return createHash("sha256").update(readFileSync(path, "utf8")).digest("hex");
}

test("separate-process handoff and resume accept exactly one architecture commit", { skip: !available }, () => {
  const x = setup("handoff");
  assert.ok(x.job.worktreeRoot.startsWith(join(root, "evictable-cache")));
  assert.ok(x.job.stateDir.startsWith(join(root, "handoff-state", "jobs")));
  const handoff = expectOk(x.cli("architecture", "run", "--mode", "collaborative", "--fixture"));
  assert.equal(handoff.status, "awaiting-author");
  assert.equal(git(x.job.worktreeRoot, "status", "--porcelain"), "");
  const completed = expectOk(x.cli("architecture", "run", "--mode", "collaborative", "--fixture",
    "--contract", x.contract, "--skills-source", skills));
  assert.equal(completed.status, "complete-in-scope");
  assert.equal(count(x.job.worktreeRoot, x.base), 1);
  const receipt = x.readReceipt();
  assert.equal(receipt.branch, x.job.branch);
  assert.equal(receipt.worktreeRoot, x.job.worktreeRoot);
  assert.equal(receipt.threadId, x.job.threadId);
  assert.equal(receipt.expectedHead, completed.headSha);
  assert.equal(JSON.parse(readFileSync(join(x.job.stateDir, "job.json"), "utf8")).validatorVersion, x.job.validatorVersion);
  assert.equal(existsSync(join(x.job.stateDir, "architecture.json")), true);
  assert.equal(existsSync(join(x.job.worktreeRoot, "architecture.json")), false);
  const replay = expectOk(x.cli("architecture", "run", "--mode", "collaborative", "--fixture"));
  assert.equal(replay.headSha, completed.headSha);
  assert.equal(count(x.job.worktreeRoot, x.base), 1);
  assert.equal(git(x.repo, "rev-parse", "HEAD"), x.base);
});

test("interrupted partial edits block without replaying or losing author modifications", { skip: !available }, () => {
  const x = setup("partial-edit");
  const completed = x.authored();
  const state = x.readReceipt();
  state.phase = "writing";
  state.plan.items[0].status = "writing";
  x.saveReceipt(state);
  const arc = join(x.job.worktreeStoryRoot, "arcs/truth.md");
  appendFileSync(arc, "\nAn author's preserved uncommitted note.\n");
  const before = readFileSync(arc, "utf8");
  const inspected = expectOk(x.cli("architecture", "inspect"));
  assert.equal(inspected.status, "blocked");
  assert.match(inspected.recovery.reason, /Interrupted architecture writer/);
  assert.ok(inspected.recovery.changes.some((entry: string) => entry.includes("arcs/truth.md")));
  for (let i = 0; i < 2; i++) {
    const resume = x.cli("architecture", "run", "--fixture");
    assert.notEqual(resume.status, 0);
    assert.match(resume.stderr, /recovery blocked|Interrupted architecture writer/);
    assert.equal(readFileSync(arc, "utf8"), before);
    assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), completed.headSha);
  }
  assert.equal(count(x.job.worktreeRoot, x.base), 1);
  assert.match(inspected.recovery.candidate.digest, /^[a-f0-9]{64}$/);
  const forgedApproval = x.cli("architecture", "reconcile", "--digest", "0".repeat(64));
  assert.notEqual(forgedApproval.status, 0);
  assert.match(forgedApproval.stderr, /Review digest differs/);
  assert.equal(x.readReceipt().phase, "writing");
  const adopted = expectOk(x.cli("architecture", "reconcile",
    "--digest", inspected.recovery.candidate.digest));
  assert.equal(adopted.status, "authored");
  assert.equal(adopted.recovery.status, "ready");
  assert.deepEqual(x.readReceipt().manuallyReconciled.paths, ["arcs/truth.md"]);
  const committed = expectOk(x.cli("architecture", "run", "--fixture"));
  assert.equal(committed.status, "complete-in-scope");
  assert.equal(count(x.job.worktreeRoot, x.base), 2);
  assert.match(git(x.job.worktreeRoot, "log", "-1", "--format=%B"),
    /NovelTea-Reviewed-Recovery: [a-f0-9]{64}/);
  assert.equal(readFileSync(arc, "utf8"), before);
});

test("commit-before-checkpoint is reconciled using exact paths, blob digest and Git provenance", { skip: !available }, () => {
  const x = setup("post-commit");
  const completed = x.authored();
  const state = x.readReceipt();
  assert.ok(state.contentDigest);
  state.phase = "authored";
  state.expectedHead = x.base;
  state.plan.items[0].status = "writing";
  x.saveReceipt(state);
  const resumed = expectOk(x.cli("architecture", "run", "--fixture"));
  assert.equal(resumed.headSha, completed.headSha);
  assert.equal(resumed.plan.items[0].verifiedSha, completed.headSha);
  assert.equal(count(x.job.worktreeRoot, x.base), 1);
  assert.equal(x.readReceipt().phase, "committed");
  assert.equal(expectOk(x.cli("architecture", "run", "--fixture")).headSha, completed.headSha);
  assert.equal(count(x.job.worktreeRoot, x.base), 1);
});

test("unexpected manual commit, stage drift and active writer lock block safely", { skip: !available }, () => {
  const x = setup("manual-commit");
  const completed = x.authored();
  const extra = join(x.job.worktreeStoryRoot, "arcs/manual.md");
  writeFileSync(extra, "An author's own new record\n");
  git(x.job.worktreeRoot, "add", "story/arcs/manual.md");
  const staged = expectOk(x.cli("architecture", "inspect"));
  assert.equal(staged.status, "blocked");
  assert.match(staged.recovery.reason, /staged content|worktree/);
  assert.notEqual(x.cli("architecture", "run", "--fixture").status, 0);
  assert.ok(existsSync(extra));
  git(x.job.worktreeRoot, "commit", "-qm", "Unrelated manual work");
  const drift = expectOk(x.cli("architecture", "inspect"));
  assert.equal(drift.status, "blocked");
  assert.match(drift.recovery.reason, /HEAD|Git/);
  assert.equal(count(x.job.worktreeRoot, x.base), 2);
  assert.equal(git(x.repo, "rev-parse", "HEAD"), x.base);
  assert.notEqual(git(x.job.worktreeRoot, "rev-parse", "HEAD"), completed.headSha);

  const lock = join(dirname(x.job.worktreeRoot), ".story-job-running");
  mkdirSync(lock);
  writeFileSync(join(lock, "owner.json"), JSON.stringify({
    version: 1, jobId: x.job.jobId, pid: process.pid, host: hostname(),
    nonce: randomUUID(), workItem: "foundation",
  }));
  const competing = x.cli("architecture", "inspect");
  assert.notEqual(competing.status, 0);
  assert.match(competing.stderr, /already owned|simultaneous/);
  rmSync(lock, { recursive: true });
});

test("authored validation failure remains restartable without rerunning the specialist", { skip: !available }, () => {
  const x = setup("failed-validation");
  x.authored();
  const state = x.readReceipt();
  git(x.job.worktreeRoot, "reset", "--mixed", x.base);
  const arc = join(x.job.worktreeStoryRoot, "arcs/truth.md");
  writeFileSync(arc, readFileSync(arc, "utf8").replace("schema: '0.1'", "schema: 'invalid'"));
  state.expectedHead = x.base;
  state.phase = "authored";
  state.plan.items[0].status = "writing";
  state.contentDigest = createHash("sha256").update(JSON.stringify(
    state.paths.map((p: string) => [p, digest(join(x.job.worktreeStoryRoot, p))]),
  )).digest("hex");
  x.saveReceipt(state);
  const before = readFileSync(arc, "utf8");
  for (let i = 0; i < 2; i++) {
    const out = x.cli("architecture", "run", "--fixture");
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /validation|schema|architecture/i);
    assert.equal(readFileSync(arc, "utf8"), before);
    assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), x.base);
  }
  assert.equal(count(x.job.worktreeRoot, x.base), 0);
});

test("An interrupted Architecture receipt without a checkpointed assignment blocks standalone replay", { skip: !available }, () => {
  const x = setup("pi-session");
  const completed = x.authored();
  const state = x.readReceipt();
  state.phase = "writing";
  state.worker = "pi";
  state.piSessionId = randomUUID();
  state.piSessionFile = join(dirname(x.job.worktreeRoot), "architecture-sessions", "missing.jsonl");
  x.saveReceipt(state);
  assert.match(expectOk(x.cli("architecture", "inspect")).recovery.reason, /only the original checkpointed assignment/);
  const failed = x.cli("architecture", "run");
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /only the original checkpointed assignment/);
  assert.equal(count(x.job.worktreeRoot, x.base), 1);
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), completed.headSha);
  assert.deepEqual(x.readReceipt(), state);
  assert.equal(existsSync(state.piSessionFile), false);
  mkdirSync(dirname(state.piSessionFile), { recursive: true });
  writeFileSync(state.piSessionFile, "{not json}\n");
  assert.match(expectOk(x.cli("architecture", "inspect")).recovery.reason, /only the original checkpointed assignment/);
  assert.notEqual(x.cli("architecture", "run").status, 0);
  assert.equal(readFileSync(state.piSessionFile, "utf8"), "{not json}\n");
  assert.deepEqual(x.readReceipt(), state);
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), completed.headSha);
});

test("foundation crash during editing blocks replay and preserves its authored Markdown", { skip: !available }, () => {
  const x = setup("foundation-edit");
  const done = x.cli("foundation", "--fixture", "--mode", "autonomous",
    "--task", "Extend the inquiry", "--skills-source", skills);
  assert.equal(done.status, 0, done.stderr);
  const receiptFile = join(dirname(x.job.worktreeRoot), "foundation.json");
  const state = JSON.parse(readFileSync(receiptFile, "utf8"));
  git(x.job.worktreeRoot, "reset", "--mixed", x.base);
  state.stage = "writing";
  state.writerStarted = true;
  delete state.authoredSha256;
  delete state.commitSha;
  writeFileSync(receiptFile, JSON.stringify(state));
  const authored = join(x.job.worktreeStoryRoot, "creative-direction/foundation.md");
  const original = readFileSync(authored, "utf8");
  const result = x.cli("foundation", "--fixture");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Interrupted foundation writer/);
  assert.equal(readFileSync(authored, "utf8"), original);
  assert.equal(count(x.job.worktreeRoot, x.base), 0);
});

test("foundation reviewed partial edit resumes without invoking a second writer", { skip: !available }, () => {
  const x = setup("foundation-review");
  const done = x.cli("foundation", "--fixture", "--mode", "autonomous",
    "--task", "Extend the inquiry", "--skills-source", skills);
  assert.equal(done.status, 0, done.stderr);
  const receiptFile = join(dirname(x.job.worktreeRoot), "foundation.json");
  const state = JSON.parse(readFileSync(receiptFile, "utf8"));
  git(x.job.worktreeRoot, "reset", "--mixed", x.base);
  state.stage = "writing";
  state.writerStarted = true;
  delete state.authoredSha256;
  delete state.commitSha;
  writeFileSync(receiptFile, JSON.stringify(state));
  const authored = join(x.job.worktreeStoryRoot, "creative-direction/foundation.md");
  const original = readFileSync(authored, "utf8");
  const inspected = expectOk(x.cli("foundation", "--fixture", "--inspect"));
  assert.equal(inspected.status, "blocked");
  assert.equal(inspected.recovery.candidate.digest, digest(authored));
  assert.notEqual(x.cli("foundation", "--fixture", "--reconcile-digest", "0".repeat(64)).status, 0);
  assert.equal(readFileSync(authored, "utf8"), original);
  const accepted = expectOk(x.cli("foundation", "--fixture",
    "--reconcile-digest", inspected.recovery.candidate.digest));
  assert.equal(accepted.status, "authored");
  const resumed = expectOk(x.cli("foundation", "--fixture"));
  assert.equal(resumed.status, "committed");
  assert.equal(count(x.job.worktreeRoot, x.base), 1);
  assert.equal(readFileSync(authored, "utf8"), original);
  assert.match(git(x.job.worktreeRoot, "log", "-1", "--format=%B"),
    /NovelTea-Reviewed-Recovery: [a-f0-9]{64}/);
  assert.equal(expectOk(x.cli("foundation", "--fixture")).commitSha, resumed.commitSha);
});

test("foundation commit before receipt is recovered exactly once", { skip: !available }, () => {
  const x = setup("foundation-commit");
  const committed = expectOk(x.cli("foundation", "--fixture", "--mode", "autonomous",
    "--task", "Extend the inquiry", "--skills-source", skills));
  const receiptFile = join(dirname(x.job.worktreeRoot), "foundation.json");
  const state = JSON.parse(readFileSync(receiptFile, "utf8"));
  assert.match(state.authoredSha256, /^[a-f0-9]{64}$/);
  state.stage = "writing";
  delete state.commitSha;
  delete state.validation;
  writeFileSync(receiptFile, JSON.stringify(state));
  const resumed = expectOk(x.cli("foundation", "--fixture"));
  assert.equal(resumed.status, "committed");
  assert.equal(resumed.commitSha, committed.commitSha);
  assert.equal(count(x.job.worktreeRoot, x.base), 1);
  assert.equal(expectOk(x.cli("foundation", "--fixture")).commitSha, committed.commitSha);
  assert.equal(count(x.job.worktreeRoot, x.base), 1);
});

test("completed foundation inspection detects later unverified Git changes", { skip: !available }, () => {
  const x = setup("foundation-drift");
  const done = expectOk(x.cli("foundation", "--fixture", "--mode", "autonomous",
    "--task", "Extend the inquiry", "--skills-source", skills));
  assert.equal(expectOk(x.cli("foundation", "--fixture", "--inspect")).status, "committed");
  const target = join(x.job.worktreeStoryRoot, "creative-direction/foundation.md");
  appendFileSync(target, "\nUncommitted human note\n");
  const before = readFileSync(target, "utf8");
  const inspected = expectOk(x.cli("foundation", "--fixture", "--inspect"));
  assert.equal(inspected.status, "blocked");
  assert.match(inspected.recovery.reason, /uncommitted or staged/);
  assert.equal(readFileSync(target, "utf8"), before);
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), done.headSha);
});

test("a dead process lock is archived before cross-process recovery", { skip: !available }, () => {
  const x = setup("dead-lock");
  x.authored();
  const jobRoot = dirname(x.job.worktreeRoot);
  const nonce = randomUUID();
  const lock = join(jobRoot, ".story-job-running");
  mkdirSync(lock);
  writeFileSync(join(lock, "owner.json"), JSON.stringify({
    version: 1, jobId: x.job.jobId, pid: 999999999, host: hostname(),
    nonce, workItem: "global-architecture",
  }));
  assert.equal(expectOk(x.cli("architecture", "inspect")).status, "complete-in-scope");
  assert.equal(existsSync(lock), false);
  assert.ok(readdirSync(jobRoot).includes(".story-job-stale-" + nonce));
});
