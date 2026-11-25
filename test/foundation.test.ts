import { createSkillSnapshot } from "../src/snapshot.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { removeTestTree } from "./helpers.js";
import { nativeExecutable } from "../src/validator.js";

const root = mkdtempSync(join(tmpdir(), "nt-foundation-"));
after(() => removeTestTree(root));
const cli = resolve("src/cli.ts");
let nativeAvailable = false;
try { nativeAvailable = existsSync(nativeExecutable()); } catch { /* Offline CI does not include native CLI. */ }
const nativeTest = nativeAvailable ? test : test.skip;

function git(root: string, ...args: string[]) {
  const run = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}
function repository(name: string, existing = false) {
  const repo = join(root, name);
  mkdirSync(repo);
  const story = join(repo, "story");
  mkdirSync(story);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.test");
  git(repo, "config", "user.name", "Author");
  writeFileSync(join(repo, "README.txt"), "Author's repository\n");
  if (existing) {
    mkdirSync(join(story, "creative-direction"));
    writeFileSync(join(story, "creative-direction/foundation.md"), `---
schema: '0.1'
type: creative-direction
id: creative-direction.foundation
title: "Existing foundation"
status: draft
decisions:
  - id: user-genre
    statement: "The genre must remain mystery"
    origin: user
    authority: user-protected
  - id: agent-location
    statement: "The story takes place in a library"
    origin: agent
    authority: delegated
premise: "An archivist follows a disappeared colleague's trail"
central_conflict: "Truth or friendship"
genre: "Mystery"
tone: "Intimate"
player_experience: "Dialogue-led"
scope: "Small ensemble"
---

# Existing foundation

Keep these author choices.
`);
  }
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "Author baseline");
  return { repo, story, baseline: git(repo, "rev-parse", "HEAD") };
}
function fixtureCheckout(name: string) {
  const source = join(root, name);
  mkdirSync(source);
  git(source, "init", "-q");
  git(source, "config", "user.name", "Test");
  git(source, "config", "user.email", "test@example.test");
  for (const name of ["nt-story-discovery", "nt-catalog"]) {
    mkdirSync(join(source, "skills", name, "references"), { recursive: true });
    writeFileSync(join(source, "skills", name, "SKILL.md"), "# " + name + "\n");
  }
  for (const name of ["records.md", "authority-and-validation.md", "glossary.md"]) {
    writeFileSync(join(source, "skills/nt-catalog/references", name), "# " + name + "\n");
  }
  git(source, "add", ".");
  git(source, "commit", "-qm", "Pinned skills fixture");
  return source;
}
const source = fixtureCheckout("pinned-source");
function launch(args: string[], name: string) {
  const state = join(root, "state-" + name);
  return spawnSync(process.execPath, ["--import", "tsx", cli, "job", ...args], {
    cwd: resolve("."), encoding: "utf8", timeout: 90000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, NT_STATE_DIR: state, NT_SKILL_CACHE_DIR: join(root, "skills-cache"),
      NT_CONFIG_FILE: join(root, "test-config.json") },
  });
}
writeFileSync(join(root, "test-config.json"), JSON.stringify({
  novelteaSkills: source, skillDiscovery: "explicit-only",
}));
function start(story: string, name: string, id = "first") {
  const result = launch(["start", "--story", story, "--job", id], name);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function foundation(story: string, name: string, ...args: string[]) {
  const result = launch(["foundation", "--story", story, "--job", "first",
    "--fixture", ...args], name);
  return { result, data: result.stdout ? JSON.parse(result.stdout) : undefined };
}

nativeTest("R14A unadmitted standalone Pi Foundation fails before creating writer state", () => {
  const { story, baseline } = repository("model-unavailable");
  const job = start(story, "model-unavailable");
  const attempt = launch(["foundation", "--story", story, "--job", "first",
    "--task", "An uncertain mystery", "--provider", "not-a-provider",
    "--model", "unavailable-model"], "model-unavailable");
  assert.notEqual(attempt.status, 0);
  assert.match(attempt.stderr, /retired.*Generation/i);
  assert.equal(existsSync(join(job.stateDir, "foundation.json")), false);
  assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), baseline);
  assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "");
});

nativeTest("retired collaborative Foundation cannot start or accept standalone author text", () => {
  const { story } = repository("collaboration");
  const job = start(story, "collab");
  for (const args of [
    ["--mode", "collaborative", "--task", "An unsettling disappearance"],
    ["--author-input", "The detective's sibling must be the antagonist"],
  ]) {
    const attempt = foundation(story, "collab", ...args);
    assert.notEqual(attempt.result.status, 0);
    assert.match(attempt.result.stderr, /retired.*Generation/i);
    assert.equal(existsSync(join(job.stateDir, "foundation.json")), false);
    assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "");
    assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), job.baseSha);
  }
});

nativeTest("historical collaborative receipt remains inspectable but cannot resume a writer", async () => {
  const { story, baseline } = repository("historical-discovery");
  const job = start(story, "historical-discovery");
  const oldCache = process.env.NT_SKILL_CACHE_DIR;
  process.env.NT_SKILL_CACHE_DIR = join(root, "skills-cache");
  let snapshot;
  try {
    snapshot = await createSkillSnapshot({ discovery: "explicit-only", novelteaSkills: source,
      skillDirs: [], requiredSkills: ["nt-story-discovery", "nt-catalog"] });
  } finally {
    if (oldCache === undefined) delete process.env.NT_SKILL_CACHE_DIR;
    else process.env.NT_SKILL_CACHE_DIR = oldCache;
  }
  assert.ok(snapshot);
  const path = join(job.stateDir, "foundation.json");
  const receipt = { version: 1, jobId: job.jobId, baseSha: job.baseSha,
    workerMode: "fixture", provider: "fixture", model: "historical",
    snapshot, stage: "awaiting-author", mode: "collaborative",
    questions: "Which decision should be protected?" };
  const historical = JSON.stringify(receipt);
  writeFileSync(path, historical);
  const inspected = foundation(story, "historical-discovery", "--inspect");
  assert.equal(inspected.result.status, 0, inspected.result.stderr);
  assert.equal(inspected.data.questions, receipt.questions);
  assert.match(inspected.data.handoff, /Historical discovery evidence only/);
  const resumed = foundation(story, "historical-discovery");
  assert.notEqual(resumed.result.status, 0);
  assert.match(resumed.result.stderr, /retired.*Generation/i);
  assert.equal(readFileSync(path, "utf8"), historical);
  assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), baseline);
  assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "");
});
