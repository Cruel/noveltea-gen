import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { removeTestTree } from "./helpers.js";
import { nativeExecutable } from "../src/validator.js";

const sandbox = mkdtempSync(join(tmpdir(), "nt-merge-preview-"));
after(() => removeTestTree(sandbox));
const cli = resolve("src/cli.ts");
function git(cwd: string, ...args: string[]) {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}
function commit(cwd: string, message: string) {
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", message);
}
function fixture(name: string) {
  const root = join(sandbox, name);
  mkdirSync(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "preview@example.test");
  git(root, "config", "user.name", "Preview Test");
  return root;
}
function run(args: string[], name: string) {
  const child = spawnSync(process.execPath, ["--import", "tsx", cli, "job", ...args], {
    cwd: resolve("."), encoding: "utf8", timeout: 60_000,
    env: { ...process.env, NT_STATE_DIR: join(sandbox, "state-" + name) },
  });
  return { status: child.status, stderr: child.stderr,
    result: child.stdout.trim() ? JSON.parse(child.stdout) : undefined };
}
const fixtureRoot = resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills", "fixtures/reference-story");
let nativeAvailable = false;
try { nativeAvailable = existsSync(nativeExecutable()); } catch { /* Native CLI unavailable in offline CI. */ }
const available = nativeAvailable && existsSync(join(fixtureRoot, "creative-direction/last-bell.md"));
const nativeTest = available ? test : test.skip;
function setup(name: string) {
  const root = fixture(name);
  cpSync(fixtureRoot, join(root, "story"), { recursive: true });
  const direction = join(root, "story/creative-direction/last-bell.md");
  writeFileSync(direction, readFileSync(direction, "utf8").replace(
    "origin: agent\n    authority: delegated", "origin: user\n    authority: user-protected"));
  commit(root, "Baseline");
  const original = git(root, "rev-parse", "HEAD");
  const started = run(["start", "--story", join(root, "story"), "--job", "draft"], name);
  assert.equal(started.status, 0, started.stderr);
  const job = started.result;
  const preview = () => run(["merge", "preview", "--story", join(root, "story"), "--job", "draft",
    "--fixture"], name);
  return { root, original, job, preview };
}
function edit(root: string, path: string, value: string) {
  writeFileSync(join(root, "story", path), value);
  commit(root, "Story update");
}
function append(root: string, path: string, prose: string) {
  const file = join(root, "story", path);
  edit(root, path, readFileSync(file, "utf8") + "\n" + prose + "\n");
}
function change(root: string, path: string, before: string, after: string) {
  const file = join(root, "story", path);
  const previous = readFileSync(file, "utf8");
  assert.ok(previous.includes(before), path + ": expected text missing");
  edit(root, path, previous.replace(before, after));
}

nativeTest("clean preview preserves author checkout, generation branch and previous target revision", () => {
  const { root, original, job, preview } = setup("clean");
  append(job.worktreeRoot, "events/find-cut-strap.md", "Additional scene details from the generator.");
  append(root, "revelations/ivos-secret.md", "Additional ending details from the author.");
  const head = git(root, "rev-parse", "HEAD");
  const generation = git(job.worktreeRoot, "rev-parse", "HEAD");
  writeFileSync(join(root, "local-note.txt"), "unsaved author work\n");
  writeFileSync(join(root, "story/notes.md"), "uncommitted Story content is not a merge input\n");
  const before = git(root, "status", "--porcelain");
  const result = preview();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.result.candidate.status, "constructed");
  assert.equal(result.result.target.head, head);
  assert.equal(result.result.generation.base, original);
  assert.equal(result.result.generation.head, generation);
  assert.equal(result.result.target.drift.length, 1);
  assert.ok(result.result.target.uncommittedStoryChangesIgnored.some((p: string) => p.includes("notes.md")));
  assert.equal(result.result.validation.status, "passed", JSON.stringify(result.result.validation));
  assert.equal(result.result.narrative.status, "unverified");
  assert.equal(git(root, "status", "--porcelain"), before);
  assert.equal(git(root, "rev-parse", "HEAD"), head);
  assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), generation);
  assert.equal(readFileSync(join(root, "local-note.txt"), "utf8"), "unsaved author work\n");
  assert.equal(git(root, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 2);
});

nativeTest("text conflict reports the paths and IDs without claiming validation", () => {
  const { root, job, preview } = setup("text-collision");
  const motivation = "Keep the departing fleet safe and earn the right to repair the harbor machinery again.";
  change(job.worktreeRoot, "characters/mara.md", motivation, "Abandon the harbor and flee alone.");
  change(root, "characters/mara.md", motivation, "Confront the city leadership openly.");
  const result = preview();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.result.candidate.status, "text-conflicts");
  assert.ok(result.result.candidate.conflicts.some((c: { path: string; ids: string[] }) =>
    c.path === "characters/mara.md" && c.ids.includes("character.mara")));
  assert.equal(result.result.validation.status, "not-run");
  assert.equal(result.result.narrative.status, "not-run");
});

nativeTest("clean textual merge with broken typed dependency is rejected", () => {
  const { root, job, preview } = setup("broken-typed");
  change(job.worktreeRoot, "events/find-cut-strap.md",
    "participants: [character.mara]", "participants: [character.missing]");
  append(root, "revelations/ivos-secret.md", "Changed ending details.");
  const result = preview();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.result.candidate.status, "constructed");
  assert.equal(result.result.validation.status, "rejected", JSON.stringify(result.result.validation));
  assert.ok(result.result.validation.diagnostics.some((d: { code: string }) => /reference/.test(d.code)));
  assert.ok(result.result.issues.some((d: { ids: string[]; evidence: string[]; options: string[] }) =>
    d.ids.includes("event.find-cut-strap") && d.evidence.length && d.options.length === 3));
});

nativeTest("overlapping record changes surface semantic risk even without Git conflict", () => {
  const { root, job, preview } = setup("semantic");
  const name = "characters/mara.md";
  const gen = readFileSync(join(job.worktreeRoot, "story", name), "utf8").replace(
    "Keep the departing fleet safe and earn the right to repair the harbor machinery again.",
    "Protect the harbor while concealing her doubts.");
  const target = readFileSync(join(root, "story", name), "utf8").replace(
    "responsibility remains", "guilt and responsibility remain");
  edit(job.worktreeRoot, name, gen);
  edit(root, name, target);
  const result = preview();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.result.candidate.status, "constructed");
  assert.ok(result.result.narrative.risks.some((r: { ids: string[]; path: string }) =>
    r.path === name && r.ids.includes("character.mara")));
  assert.equal(result.result.narrative.status, "unverified");
});

nativeTest("protected-decision changes are blocked and not reconciled automatically", () => {
  const { root, job, preview } = setup("protected");
  change(job.worktreeRoot, "creative-direction/last-bell.md",
    "repair rather than revenge", "revenge rather than repair");
  append(root, "events/find-cut-strap.md", "Target event narrative detail.");
  const result = preview();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.result.candidate.status, "constructed");
  assert.equal(result.result.validation.status, "rejected", JSON.stringify(result.result.validation));
  assert.ok(result.result.validation.protectedDecisions.length);
  assert.ok(result.result.issues.some((d: { ids: string[]; options: string[] }) =>
    d.ids.includes("creative-direction.last-bell") && d.options.length === 3));
  assert.equal(git(root, "status", "--porcelain"), "");
});

nativeTest("repeat preview incorporates target changes without stale caching or source mutations", () => {
  const { root, job, preview } = setup("advance");
  append(job.worktreeRoot, "events/find-cut-strap.md", "Generation scene detail.");
  const first = preview();
  append(root, "revelations/ivos-secret.md", "New target ending detail.");
  const second = preview();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.notEqual(first.result.target.head, second.result.target.head);
  assert.equal(first.result.target.drift.length, 0);
  assert.equal(second.result.target.drift.length, 1);
  assert.equal(git(root, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 2);
});

nativeTest("canonical validator assesses a real combined Story from both revisions", {
  skip: !existsSync(join(resolve("../noveltea-skills"), "fixtures/reference-story/creative-direction/last-bell.md"))
    ? "NovelTea canonical checkout is unavailable" : false,
}, () => {
  const name = "canonical-combined";
  const root = fixture(name);
  const story = join(root, "story");
  cpSync(fixtureRoot, story, { recursive: true });
  commit(root, "Reference Story baseline");
  const started = run(["start", "--story", story, "--job", "draft"], name);
  assert.equal(started.status, 0, started.stderr);
  const job = started.result;
  const change = (cwd: string, path: string, line: string) => {
    const full = join(cwd, "story", path);
    writeFileSync(full, readFileSync(full, "utf8") + "\\n" + line + "\\n");
    commit(cwd, "Narrative detail");
  };
  change(job.worktreeRoot, "characters/mara.md", "Mara remembers the lighthouse at low tide.");
  change(root, "world-entities/tide-well.md", "The well remains accessible at dusk.");
  const originalHead = git(root, "rev-parse", "HEAD");
  const generatedHead = git(job.worktreeRoot, "rev-parse", "HEAD");
  const preview = run(["merge", "preview", "--story", story, "--job", "draft",
    "--fixture"], name);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(preview.result.candidate.status, "constructed");
  assert.equal(preview.result.validation.status, "passed", JSON.stringify(preview.result.validation));
  assert.equal(preview.result.validation.results.length, 2);
  assert.ok(preview.result.candidate.affected.some((file: { path: string; ids: string[] }) =>
    file.path === "characters/mara.md" && file.ids.includes("character.mara")));
  assert.equal(preview.result.narrative.status, "unverified");
  assert.equal(git(root, "rev-parse", "HEAD"), originalHead);
  assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), generatedHead);
  assert.equal(git(root, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 2);
});

nativeTest("private deferred author text is never included in merge-preview evidence", () => {
  const { root, job, preview } = setup("private-idea-conflict");
  const path = ".story-inbox/ideas/secret.yaml";
  const privateDir = join(root, ".story-inbox", "ideas");
  mkdirSync(privateDir, { recursive: true });
  const privateWords = "Private motivation: the author wrote a secret never for workers";
  const baseline = [
    'id: secret',
    'original: "' + privateWords + '"',
    'target: original',
    ...Array.from({ length: 12 }, (_, i) => "filler" + i + ": unchanged"),
    'generation: original',
  ].join("\n") + "\n";
  writeFileSync(join(root, path), baseline);
  commit(root, "Private author capture");
  // This private capture was made on the target after the job forked. To make
  // a genuine three-way overlap on the same path, first bring it into the job
  // branch as an independent file.
  const authored = baseline.replace("target: original", "target: target-authored");
  const generated = baseline.replace("generation: original", "generation: generated");
  mkdirSync(join(job.worktreeRoot, ".story-inbox", "ideas"), { recursive: true });
  writeFileSync(join(job.worktreeRoot, ".story-inbox", "ideas", "secret.yaml"), generated);
  commit(job.worktreeRoot, "Generated independently");
  writeFileSync(join(root, path), authored);
  commit(root, "Author changed private capture");
  const result = preview();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.result.candidate.status, "text-conflicts");
  assert.ok(!JSON.stringify(result.result).includes(privateWords));
});

nativeTest("opt-in independent Pi reviewer reports a genuine cross-record contradiction", {
  skip: process.env.NT_LIVE_MERGE_PREVIEW !== "1"
    ? "Set NT_LIVE_MERGE_PREVIEW=1 to test independent Pi editorial reasoning" : false,
  timeout: 1_200_000,
}, () => {
  const { root, job } = setup("live-contradiction");
  append(job.worktreeRoot, "events/find-cut-strap.md",
    "Mara publicly reveals the secret at the opening.");
  append(root, "revelations/ivos-secret.md",
    "Mara never discovers or learns the secret at any point.");
  const authorHead = git(root, "rev-parse", "HEAD");
  const generationHead = git(job.worktreeRoot, "rev-parse", "HEAD");
  const args = ["--import", "tsx", cli, "job", "merge", "preview", "--story", join(root, "story"),
    "--job", "draft", "--skills-source", resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills")];
  if (process.env.NT_PROVIDER) args.push("--provider", process.env.NT_PROVIDER);
  if (process.env.NT_MODEL) args.push("--model", process.env.NT_MODEL);
  if (["low", "high"].includes(process.env.NT_THINKING ?? ""))
    args.push("--thinking", process.env.NT_THINKING!);
  const child = spawnSync(process.execPath, args, {
    cwd: resolve("."), encoding: "utf8", timeout: 900_000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, NT_STATE_DIR: join(sandbox, "state-live-contradiction"),
      NT_SKILL_CACHE_DIR: join(sandbox, "skill-cache-live-contradiction") },
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const preview = JSON.parse(child.stdout);
  assert.equal(preview.candidate.status, "constructed");
  assert.equal(preview.narrative.status, "block", preview.narrative.reason);
  assert.ok(preview.narrative.findings.some((f: { severity: string }) => f.severity === "blocking"));
  assert.ok(preview.narrative.evidence.some((e: string) => /\.md:[1-9]/.test(e)));
  assert.ok(preview.narrative.sessionFile);
  assert.equal(git(root, "rev-parse", "HEAD"), authorHead);
  assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), generationHead);
  assert.equal(git(root, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 2);
});
