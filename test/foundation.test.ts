import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { removeTestTree } from "./helpers.js";

const root = mkdtempSync(join(tmpdir(), "nt-foundation-"));
after(() => removeTestTree(root));
const cli = resolve("src/cli.ts");

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
  mkdirSync(join(source, "src"));
  for (const name of ["nt-story-discovery", "nt-catalog"]) {
    mkdirSync(join(source, "skills", name, "references"), { recursive: true });
    writeFileSync(join(source, "skills", name, "SKILL.md"), "# " + name + "\n");
  }
  for (const name of ["records.md", "authority-and-validation.md", "glossary.md"]) {
    writeFileSync(join(source, "skills/nt-catalog/references", name), "# " + name + "\n");
  }
  writeFileSync(join(source, "package.json"), JSON.stringify({ name: "noveltea-story-catalog" }));
  writeFileSync(join(source, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(join(source, "src/cli.ts"), `
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative } from "node:path";
const story = process.argv[2];
const baseIndex = process.argv.indexOf("--base");
const base = baseIndex < 0 ? execFileSync("git", ["rev-parse", "HEAD"], { cwd: story, encoding: "utf8" }).trim() : process.argv[baseIndex + 1];
const target = join(story, "creative-direction/foundation.md");
const data = existsSync(target) ? readFileSync(target, "utf8") : "";
const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: story, encoding: "utf8" }).trim();
const rel = relative(gitRoot, target).split("\\\\").join("/");
let previous = "";
try { previous = execFileSync("git", ["show", base + ":" + rel], { cwd: story, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
catch {}
const hasBaseline = !!execFileSync("git", ["ls-tree", "-r", "--name-only", base, "--", relative(gitRoot, story)],
  { cwd: gitRoot, encoding: "utf8" }).toString().trim().match(/\\.md/);
const altered = previous.includes("The genre must remain mystery") && !data.includes("The genre must remain mystery");
const diagnostics = data.includes("INVALID") ? [{ path: "creative-direction/foundation.md", line: 3, code: "invalid", message: "Invalid foundation" }] : [];
const report = {
  records: [], diagnostics,
  readiness: { design: { stages: { foundation: { minimum: data ? "passed" : "needs-work" } } } },
  coverage: { unverified: ["editorial-quality"] },
  protection: { status: hasBaseline ? "checked" : "no-baseline", base,
    changes: altered ? [{decision:"creative-direction.foundation#user-genre", kind:"changed"}] : [],
    warnings: altered ? [{code:"protected-decision-change"}] : [],
    impact: { changed: [], moved: [], affected: [] } }
};
if (!hasBaseline && process.argv.includes("--strict-protection")) {
  console.error("Git baseline does not contain Story Markdown files");
  process.exitCode = 2;
} else {
  console.log(JSON.stringify(report));
  process.exitCode = altered || diagnostics.length ? 1 : 0;
}
`);
  git(source, "add", ".");
  git(source, "commit", "-qm", "Skills and validator");
  return source;
}
const source = fixtureCheckout("pinned-source");
function launch(args: string[], name: string) {
  const state = join(root, "state-" + name);
  return spawnSync(process.execPath, ["--import", "tsx", cli, "job", ...args], {
    cwd: resolve("."), encoding: "utf8", timeout: 90000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, NT_STATE_DIR: state, NT_SKILL_CACHE_DIR: join(root, "skills-cache"),
      NT_VALIDATOR_CACHE_DIR: join(root, "validator-cache"),
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

test("public CLI authors a new empty Story in its job branch, without writing source/engine records", () => {
  const { repo, story, baseline } = repository("empty");
  const job = start(story, "empty");
  const { result, data } = foundation(story, "empty",
    "--mode", "autonomous", "--task", "A whodunit with a mysterious archive",
    "--envelope", "A visual novel with two reusable backgrounds");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(data.status, "committed");
  assert.equal(data.validation, "unverified-empty-baseline");
  assert.equal(data.baseSha, baseline);
  assert.equal(data.skillReads.length, 5);
  assert.match(data.commitSha, /^[a-f0-9]{40}$/);
  const authored = readFileSync(join(job.worktreeStoryRoot, "creative-direction/foundation.md"), "utf8");
  assert.match(authored, /origin: user\n    authority: user-protected/);
  assert.match(authored, /origin: agent\n    authority: delegated/);
  assert.match(authored, /two reusable backgrounds/);
  assert.equal(existsSync(join(story, "creative-direction")), false);
  assert.equal(git(repo, "rev-parse", "HEAD"), baseline);
  assert.equal(git(repo, "status", "--porcelain"), "");
  assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "");
  assert.equal(git(job.worktreeRoot, "show", "--format=", "--name-only", "HEAD"),
    "story/creative-direction/foundation.md");
  assert.equal(git(job.worktreeRoot, "log", "-1", "--format=%an <%ae>"),
    "NovelTea Generator <noveltea-gen@users.noreply.github.com>");
  assert.match(git(job.worktreeRoot, "log", "-1", "--format=%B"), /NovelTea-Work-Item: foundation/);
  const replay = foundation(story, "empty");
  assert.equal(replay.result.status, 0, replay.result.stderr);
  assert.equal(replay.data.commitSha, data.commitSha);
  assert.equal(git(job.worktreeRoot, "rev-list", "--count", baseline + "..HEAD"), "1");
});

test("existing protected foundation is preserved and validated against the trusted base", () => {
  const { repo, story, baseline } = repository("existing", true);
  const job = start(story, "existing");
  const { result, data } = foundation(story, "existing",
    "--task", "Continue the existing dialogue-heavy mystery");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(data.validation, "passed");
  const written = readFileSync(join(job.worktreeStoryRoot, "creative-direction/foundation.md"), "utf8");
  assert.match(written, /The genre must remain mystery/);
  assert.match(written, /## Foundation development/);
  assert.equal(git(repo, "rev-parse", "HEAD"), baseline);
  assert.equal(git(job.worktreeRoot, "diff", "--name-only", baseline + "..HEAD"),
    "story/creative-direction/foundation.md");
});

test("collaborative discovery pauses without writes and preserves author response as user-protected", () => {
  const { story } = repository("collaboration");
  const job = start(story, "collab");
  const initial = foundation(story, "collab", "--mode", "collaborative",
    "--task", "An unsettling disappearance", "--envelope", "Single-location visual novel");
  assert.equal(initial.result.status, 0, initial.result.stderr);
  assert.equal(initial.data.status, "awaiting-author");
  assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "");
  assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), job.baseSha);
  const switchedMode = launch(["foundation", "--story", story, "--job", "first",
    "--author-input", "Change the protagonist"], "collab");
  assert.notEqual(switchedMode.status, 0);
  assert.match(switchedMode.stderr, /inputs differ/);
  const switchedModel = foundation(story, "collab", "--model", "another-model");
  assert.notEqual(switchedModel.result.status, 0);
  assert.match(switchedModel.result.stderr, /inputs differ/);
  assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "");
  const completed = foundation(story, "collab",
    "--author-input", "The detective's sibling must be the antagonist");
  assert.equal(completed.result.status, 0, completed.result.stderr);
  assert.equal(completed.data.status, "committed");
  const record = readFileSync(join(job.worktreeStoryRoot, "creative-direction/foundation.md"), "utf8");
  assert.match(record, /detective's sibling must be the antagonist/);
  assert.match(record, /origin: user\n    authority: user-protected/);
  const changedBrief = foundation(story, "collab", "--task", "A totally different request");
  assert.notEqual(changedBrief.result.status, 0);
  assert.match(changedBrief.result.stderr, /inputs differ/);
});

test("unexpected staged or out-of-scope files block the commit and preserve job files", () => {
  for (const [name, path, stage] of [
    ["staged", "creative-direction/foundation.md", true],
    ["outside", "engine-record.md", false],
  ] as const) {
    const { story } = repository(name);
    const job = start(story, name);
    const initial = foundation(story, name, "--mode", "collaborative", "--task", "A story");
    assert.equal(initial.result.status, 0, initial.result.stderr);
    const full = join(job.worktreeStoryRoot, path);
    if (path.includes("/")) mkdirSync(join(job.worktreeStoryRoot, "creative-direction"), { recursive: true });
    writeFileSync(full, "Unexpected data");
    if (stage) git(job.worktreeRoot, "add", "--", "story/creative-direction/foundation.md");
    const attempt = foundation(story, name, "--author-input", "Choose a small cast");
    assert.notEqual(attempt.result.status, 0);
    assert.match(attempt.result.stderr, /unexpected|Unfinished|staged|outside/i);
    assert.equal(readFileSync(full, "utf8"), "Unexpected data");
    assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), job.baseSha);
  }
});


test("opt-in real canonical catalog validates a fixture-authored empty Story", {
  skip: !existsSync(join(process.env.NT_SKILLS_CHECKOUT || resolve("../noveltea-skills"), "src/cli.ts"))
    ? "noveltea-skills checkout unavailable" : false,
}, () => {
  const canonical = process.env.NT_SKILLS_CHECKOUT || resolve("../noveltea-skills");
  const { story, repo, baseline } = repository("real-catalog");
  const job = start(story, "real-catalog");
  const { result, data } = foundation(story, "real-catalog",
    "--task", "A train mystery set in a single compartment",
    "--skills-source", canonical, "--validator-source", canonical);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(data.status, "committed");
  assert.equal(data.validation, "unverified-empty-baseline");
  assert.equal(git(repo, "rev-parse", "HEAD"), baseline);
  assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "");
});

test("validator rejection leaves agent work uncommitted and does not certify completion", () => {
  const { story } = repository("rejection");
  const job = start(story, "reject");
  const bad = foundation(story, "reject", "--task", "INVALID forbidden fixture");
  assert.notEqual(bad.result.status, 0);
  assert.match(bad.result.stderr, /foundation validation failed|not passing/i);
  assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), job.baseSha);
  assert.match(readFileSync(join(job.worktreeStoryRoot, "creative-direction/foundation.md"), "utf8"), /INVALID/);
});
