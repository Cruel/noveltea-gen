import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { removeTestTree } from "./helpers.js";

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
    env: { ...globalThis.process.env, NT_STATE_DIR: join(sandbox, "state-" + name),
      NT_VALIDATOR_CACHE_DIR: join(sandbox, "validator-cache-" + name) },
  });
  return { status: child.status, stderr: child.stderr,
    result: child.stdout.trim() ? JSON.parse(child.stdout) : undefined };
}
function catalogSource() {
  const source = fixture("catalog-source");
  mkdirSync(join(source, "src"));
  writeFileSync(join(source, "package.json"), JSON.stringify({ name: "noveltea-story-catalog" }));
  writeFileSync(join(source, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(join(source, "src/cli.ts"), `
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
const root = process.argv[2];
const read = (path) => existsSync(join(root,path)) ? readFileSync(join(root,path),"utf8") : "";
const files = ["characters/hero.md","events/scene.md","revelations/truth.md"];
const body = files.map(read).join("\\n");
const diagnostics = body.includes("BROKEN_DEP") ? [{path:"events/scene.md",line:3,code:"invalid-reference",message:"Missing Character"}] : [];
const protection = body.includes("PROTECTED_CHANGE") ? [{code:"protected-decision-change",decision:"character.hero#commitment"}] : [];
console.log(JSON.stringify({ records:files.filter(f => read(f)).map(f=>({path:f,metadata:{id:read(f).match(/id: (.*)/)?.[1]??f,type:f.split("/")[0]}})),
  diagnostics, outstanding:[], readiness:{}, coverage:{search:{truncated:false},eventProgress:[],milestoneRoutes:[],branchProgress:[],puzzleSolutions:[]},
  protection:{status:"checked",base:process.argv[process.argv.indexOf("--base")+1],changes:protection,warnings:protection} }));
process.exitCode = diagnostics.length || protection.length ? 1 : 0;
`);
  commit(source, "Catalog fixture");
  return source;
}
const source = catalogSource();
function setup(name: string) {
  const root = fixture(name);
  mkdirSync(join(root, "story"));
  mkdirSync(join(root, "story/characters"));
  mkdirSync(join(root, "story/events"));
  mkdirSync(join(root, "story/revelations"));
  writeFileSync(join(root, "story/characters/hero.md"),
    "---\nid: character.hero\ntype: character\n---\nMotivation: protect the city.\nDetail A: unchanged.\nDetail B: unchanged.\nDetail C: unchanged.\nDetail D: unchanged.\n");
  writeFileSync(join(root, "story/events/scene.md"), "---\nid: event.scene\n---\nOpening.\n");
  writeFileSync(join(root, "story/revelations/truth.md"), "---\nid: revelation.truth\n---\nThe hero knows the secret.\n");
  commit(root, "Baseline");
  const original = git(root, "rev-parse", "HEAD");
  const started = run(["start", "--story", join(root, "story"), "--job", "draft"], name);
  assert.equal(started.status, 0, started.stderr);
  const job = started.result;
  const preview = () => run(["merge", "preview", "--story", join(root, "story"), "--job", "draft",
    "--fixture", "--validator-source", source], name);
  return { root, original, job, preview };
}
function edit(root: string, path: string, value: string) {
  writeFileSync(join(root, "story", path), value);
  commit(root, "Story update");
}

test("clean preview preserves author checkout, generation branch and previous target revision", () => {
  const { root, original, job, preview } = setup("clean");
  edit(job.worktreeRoot, "events/scene.md", "---\nid: event.scene\n---\nGeneration scene.\n");
  edit(root, "revelations/truth.md", "---\nid: revelation.truth\n---\nTarget ending.\n");
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

test("text conflict reports the paths and IDs without claiming validation", () => {
  const { root, job, preview } = setup("text-collision");
  edit(job.worktreeRoot, "characters/hero.md", "---\nid: character.hero\ntype: character\n---\nMotivation: run away.\nDetail A: unchanged.\nDetail B: unchanged.\nDetail C: unchanged.\nDetail D: unchanged.\n");
  edit(root, "characters/hero.md", "---\nid: character.hero\ntype: character\n---\nMotivation: attack the city.\nDetail A: unchanged.\nDetail B: unchanged.\nDetail C: unchanged.\nDetail D: unchanged.\n");
  const result = preview();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.result.candidate.status, "text-conflicts");
  assert.ok(result.result.candidate.conflicts.some((c: { path: string; ids: string[] }) =>
    c.path === "characters/hero.md" && c.ids.includes("character.hero")));
  assert.equal(result.result.validation.status, "not-run");
  assert.equal(result.result.narrative.status, "not-run");
});

test("clean textual merge with broken typed dependency is rejected", () => {
  const { root, job, preview } = setup("broken-typed");
  edit(job.worktreeRoot, "events/scene.md", "---\nid: event.scene\n---\nBROKEN_DEP\n");
  edit(root, "revelations/truth.md", "---\nid: revelation.truth\n---\nChanged ending.\n");
  const result = preview();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.result.candidate.status, "constructed");
  assert.equal(result.result.validation.status, "rejected", JSON.stringify(result.result.validation));
  assert.ok(result.result.validation.diagnostics.some((d: { code: string }) => d.code === "invalid-reference"));
  assert.ok(result.result.issues.some((d: { ids: string[]; evidence: string[]; options: string[] }) =>
    d.ids.includes("event.scene") && d.evidence.length && d.options.length === 3));
});

test("overlapping record changes surface semantic risk even without Git conflict", () => {
  const { root, job, preview } = setup("semantic");
  const name = "characters/hero.md";
  const gen = readFileSync(join(job.worktreeRoot, "story", name), "utf8").replace(
    "Motivation: protect the city.", "Motivation: betray the city.");
  const target = readFileSync(join(root, "story", name), "utf8").replace(
    "Detail D: unchanged.", "Detail D: the hero sacrifices everything to save the city.");
  edit(job.worktreeRoot, name, gen);
  edit(root, name, target);
  const result = preview();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.result.candidate.status, "constructed");
  assert.ok(result.result.narrative.risks.some((r: { ids: string[]; path: string }) =>
    r.path === name && r.ids.includes("character.hero")));
  assert.equal(result.result.narrative.status, "unverified");
});

test("protected-decision changes are blocked and not reconciled automatically", () => {
  const { root, job, preview } = setup("protected");
  edit(job.worktreeRoot, "characters/hero.md", "---\nid: character.hero\ntype: character\n---\nMotivation: PROTECTED_CHANGE\nDetail A: unchanged.\nDetail B: unchanged.\nDetail C: unchanged.\nDetail D: unchanged.\n");
  edit(root, "events/scene.md", "---\nid: event.scene\n---\nTarget event.\n");
  const result = preview();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.result.candidate.status, "constructed");
  assert.equal(result.result.validation.status, "rejected", JSON.stringify(result.result.validation));
  assert.ok(result.result.validation.protectedDecisions.length);
  assert.ok(result.result.issues.some((d: { ids: string[]; options: string[] }) =>
    d.ids.includes("character.hero") && d.options.length === 3));
  assert.equal(git(root, "status", "--porcelain"), "");
});

test("repeat preview incorporates target changes without stale caching or source mutations", () => {
  const { root, job, preview } = setup("advance");
  edit(job.worktreeRoot, "events/scene.md", "---\nid: event.scene\n---\nGeneration scene.\n");
  const first = preview();
  edit(root, "revelations/truth.md", "---\nid: revelation.truth\n---\nNew target ending.\n");
  const second = preview();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.notEqual(first.result.target.head, second.result.target.head);
  assert.equal(first.result.target.drift.length, 0);
  assert.equal(second.result.target.drift.length, 1);
  assert.equal(git(root, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 2);
});

test("canonical validator assesses a real combined Story from both revisions", {
  skip: !existsSync(join(resolve("../noveltea-skills"), "fixtures/reference-story/creative-direction/last-bell.md"))
    ? "NovelTea canonical checkout is unavailable" : false,
}, () => {
  const name = "canonical-combined";
  const root = fixture(name);
  const story = join(root, "story");
  cpSync(join(resolve("../noveltea-skills"), "fixtures/reference-story"), story, { recursive: true });
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
    "--fixture", "--validator-source", resolve("../noveltea-skills")], name);
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

test("opt-in independent Pi reviewer reports a genuine cross-record contradiction", {
  skip: process.env.NT_LIVE_MERGE_PREVIEW !== "1"
    ? "Set NT_LIVE_MERGE_PREVIEW=1 to test independent Pi editorial reasoning" : false,
  timeout: 1_200_000,
}, () => {
  const { root, job } = setup("live-contradiction");
  edit(job.worktreeRoot, "events/scene.md",
    "---\nid: event.scene\n---\nThe hero publicly reveals the secret at the opening.\n");
  edit(root, "revelations/truth.md",
    "---\nid: revelation.truth\n---\nThe hero never discovers or learns the secret at any point.\n");
  const authorHead = git(root, "rev-parse", "HEAD");
  const generationHead = git(job.worktreeRoot, "rev-parse", "HEAD");
  const args = ["--import", "tsx", cli, "job", "merge", "preview", "--story", join(root, "story"),
    "--job", "draft", "--validator-source", source,
    "--skills-source", resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills")];
  if (process.env.NT_PROVIDER) args.push("--provider", process.env.NT_PROVIDER);
  if (process.env.NT_MODEL) args.push("--model", process.env.NT_MODEL);
  if (["low", "high"].includes(process.env.NT_THINKING ?? ""))
    args.push("--thinking", process.env.NT_THINKING!);
  const child = spawnSync(process.execPath, args, {
    cwd: resolve("."), encoding: "utf8", timeout: 900_000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, NT_STATE_DIR: join(sandbox, "state-live-contradiction"),
      NT_VALIDATOR_CACHE_DIR: join(sandbox, "validator-cache-live-contradiction"),
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
