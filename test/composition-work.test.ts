import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { removeTestTree } from "./helpers.js";
import { parseSpecialistJson } from "../src/composition-specialist.js";

const root = mkdtempSync(join(tmpdir(), "nt-composition-"));
after(() => {
  if (process.env.NT_LIVE_COMPOSITION === "1" && process.env.NT_KEEP_FAILED_LIVE === "1") {
    process.stderr.write("Live composition fixtures preserved: " + root + "\n");
  } else removeTestTree(root);
});
const source = resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills");
const available = existsSync(join(source, "src/cli.ts"));
function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function setup(name: string) {
  const repo = join(root, name), story = join(repo, "story");
  mkdirSync(join(story, "creative-direction"), { recursive: true });
  writeFileSync(join(story, "creative-direction/foundation.md"), `---
schema: '0.1'
type: creative-direction
id: creative-direction.foundation
title: "The missing witness"
status: draft
decisions:
  - id: loyalty
    statement: "The player can protect a friend or demand accountability"
    origin: user
    authority: user-protected
premise: "A witness disappears before an archive inquiry"
central_conflict: "Expose a concealed ledger or preserve loyalty"
genre: "Mystery"
tone: "Intimate and uneasy"
player_experience: "Investigation and consequential conversations"
scope: "Two Characters and a single archive background"
---

Ada questions Neri about the missing witness and a disputed custody ledger.
`);
  git(repo, "init", "-q"); git(repo, "config", "user.name", "Author");
  git(repo, "config", "user.email", "author@example.test");
  git(repo, "add", "."); git(repo, "commit", "-qm", "Initial Story");
  const original = git(repo, "rev-parse", "HEAD");
  const env = { ...process.env, NT_STATE_DIR: join(root, name + "-state"),
    NT_CONFIG_FILE: join(root, "missing-config.json"), NT_SKILL_CACHE_DIR: join(root, "skills"),
    NT_VALIDATOR_CACHE_DIR: join(root, "validators") };
  function cli(args: string[], fixtureCase = "") {
    return spawnSync(process.execPath, ["--import", "tsx", resolve("src/cli.ts"), "job", ...args,
      "--story", story, "--job", "draft"], { encoding: "utf8",
      timeout: process.env.NT_LIVE_COMPOSITION === "1" ? 1_000_000 : 120_000,
      maxBuffer: 24 * 1024 * 1024, env: { ...env, NT_COMPOSITION_FIXTURE_CASE: fixtureCase,
        NT_TEST_INTERACTIVE_SEND_AFTER_CHOICE: process.env.NT_TEST_INTERACTIVE_SEND_AFTER_CHOICE ?? "" } });
  }
  const start = cli(["start"]);
  assert.equal(start.status, 0, start.stderr);
  const job = JSON.parse(start.stdout);
  const contract = join(root, name + "-contract.json");
  writeFileSync(contract, JSON.stringify({
    scope: { kind: "partial", depth: "composition",
      targets: ["arc.truth", "milestone.disclosure"], branches: ["protect", "challenge"] },
    constraints: ["Confrontation and protection remain possible"],
    envelope: { presentation: "Visual novel", hardLimits: ["Reuse archive backdrop"],
      preferences: ["Two Characters"] },
  }));
  function prepare() {
    for (const args of [
      ["architecture", "run", "--fixture", "--contract", contract, "--skills-source", source],
      ["foundations", "run", "--fixture", "--skills-source", source],
      ["event", "run", "--fixture", "--milestone", "milestone.disclosure", "--skills-source", source],
      ["interactive", "run", "--fixture", "--milestone", "milestone.disclosure", "--skills-source", source],
    ]) {
      const result = cli(args);
      assert.equal(result.status, 0, result.stderr);
    }
    return git(job.worktreeRoot, "rev-parse", "HEAD");
  }
  const run = (variant = "") => cli(["composition", "run", "--fixture", "--milestone",
    "milestone.disclosure", "--skills-source", source], variant);
  const inspect = () => cli(["composition", "inspect", "--milestone", "milestone.disclosure"]);
  return { repo, original, job, cli, prepare, run, inspect };
}

test("parses a complete nested manifest despite commentary or fenced JSON", () => {
  const manifest = JSON.stringify({ modifiedRecords: ["authored-content/disclosure.md"],
    architecturalConflicts: [], laterObligations: [{ kind: "prose", detail: 'quote "safe"' }] });
  const input = "Completed.\n\n" + "```json\n" + manifest + "\n```";
  assert.deepEqual(parseSpecialistJson(input).modifiedRecords, ["authored-content/disclosure.md"]);
  assert.equal(parseSpecialistJson('review: {"verdict":"pass","sourceEvidence":["event.x"],"concerns":[]}').verdict, "pass");
  assert.throws(() => parseSpecialistJson('No JSON was returned'), /no parseable JSON/);
});

test("composes two outcomes and two alternative puzzle endings into validated content and one isolated commit", { skip: !available }, () => {
  const x = setup("reference");
  const before = x.prepare();
  const run = x.run();
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.status, "composition-committed");
  assert.equal(result.validation.protectionBase, before);
  assert.equal(result.validation.branchReview.status, "passed");
  assert.deepEqual(result.validation.branchReview.outcomes, ["challenge", "protect"]);
  assert.deepEqual(result.validation.branchReview.solutions,
    ["event.decode-ledger", "event.request-testimony"]);
  assert.ok(result.paths.some((p: string) => p.startsWith("authored-content/")));
  const body = readFileSync(join(x.job.worktreeStoryRoot, "authored-content/disclosure-scene.md"), "utf8");
  for (const title of ["## Shared entry", "## Choice wording", "## Protect selected", "## Challenge selected"]) {
    assert.ok(body.includes(title), title);
  }
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD^"), before);
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), result.headSha);
  assert.equal(git(x.job.worktreeRoot, "status", "--porcelain"), "");
  assert.equal(git(x.repo, "rev-parse", "HEAD"), x.original);
  assert.match(git(x.job.worktreeRoot, "log", "-1", "--format=%B"), /NovelTea-Work-Item: composition-disclosure/);
  assert.equal(JSON.parse(x.cli(["validate"]).stdout).status, "passed");
  assert.equal(JSON.parse(x.inspect().stdout).headSha, result.headSha);
  assert.equal(JSON.parse(x.run().stdout).headSha, result.headSha);
});

test("verified deferred capture between Interactive and Composition does not block prose", { skip: !available }, () => {
  const x = setup("capture-between-stages");
  const interactiveHead = x.prepare();
  const file = join(root, "deferred-" + x.job.jobId + "-" + Math.random().toString(36).slice(2) + ".json");
  writeFileSync(file, JSON.stringify({
    kind: "event-concept", source: { kind: "author-continuation", reference: "note" },
    original: "The witness recants in a private interview",
    requirements: { meaning: [{ text: "The recantation changes trust", binding: true }], wording: [], participants: [] },
    identities: { known: [], unresolved: ["witness"] }, prerequisites: [],
    placement: { scopeIds: ["arc.truth"], flexible: true, earliest: "event" }, upstreamConstraints: [],
  }));
  const capture = x.cli(["ideas", "capture", "--file", file]);
  assert.equal(capture.status, 0, capture.stderr);
  const captured = JSON.parse(capture.stdout).commitSha;
  const result = x.run();
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.interactiveHead, interactiveHead);
  assert.equal(data.validation.protectionBase, captured);
  assert.equal(git(x.job.worktreeRoot, "rev-parse", data.headSha + "^"), captured);
});

test("Choice → verified capture → Puzzle → Composition retains exact intermediary provenance", { skip: !available }, () => {
  const x = setup("capture-between-choice-puzzle");
  const payloadFile = join(root, "capture-between-choice-puzzle-message.json");
  writeFileSync(payloadFile, JSON.stringify({ id: "choice-puzzle-interruption", kind: "idea", payload: {
    kind: "event-concept", source: { kind: "author-continuation", reference: "active writing" },
    original: "The witness interrupts the interrogation",
    requirements: { meaning: [{ text: "Interruption challenges trust", binding: true }], wording: [], participants: [] },
    identities: { known: [], unresolved: ["witness"] }, prerequisites: [],
    placement: { scopeIds: ["arc.truth"], flexible: true, earliest: "event" }, upstreamConstraints: [],
  }}));
  const previous = process.env.NT_TEST_INTERACTIVE_SEND_AFTER_CHOICE;
  process.env.NT_TEST_INTERACTIVE_SEND_AFTER_CHOICE = payloadFile;
  try { x.prepare(); }
  finally {
    if (previous === undefined) delete process.env.NT_TEST_INTERACTIVE_SEND_AFTER_CHOICE;
    else process.env.NT_TEST_INTERACTIVE_SEND_AFTER_CHOICE = previous;
  }
  const puzzle = git(x.job.worktreeRoot, "rev-parse", "HEAD");
  const capture = git(x.job.worktreeRoot, "rev-parse", "HEAD^");
  const choice = git(x.job.worktreeRoot, "rev-parse", "HEAD^^");
  assert.match(git(x.job.worktreeRoot, "log", "-1", "--format=%B", capture), /NovelTea-Work-Item: idea-capture/);
  const interactive = JSON.parse(x.cli(["interactive", "inspect", "--milestone", "milestone.disclosure"]).stdout);
  assert.equal(interactive.specialistUnits[0].commitSha, choice);
  assert.equal(interactive.specialistUnits[1].beforeHead, capture);
  assert.equal(interactive.specialistUnits[1].commitSha, puzzle);
  const result = x.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).validation.protectionBase, puzzle);
});

test("paused Composition job does not start writing", { skip: !available }, () => {
  const x = setup("paused-composition");
  x.prepare();
  const pause = x.cli(["author", "control", "--state", "paused"]);
  assert.equal(pause.status, 0, pause.stderr);
  const run = x.run();
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /paused|cannot advance/);
  assert.equal(existsSync(join(x.job.worktreeStoryRoot, "authored-content/disclosure-scene.md")), false);
});

test("refuses branch-exclusive revelation leaked in shared prose", { skip: !available }, () => {
  const x = setup("leak");
  const prior = x.prepare();
  const run = x.run("shared-leak");
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /shared|exclusive|revelation|leak/i);
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), prior);
  assert.equal(JSON.parse(x.inspect().stdout).phase, "authored");
});

test("refuses omitted choice branch even if canonical validator passes", { skip: !available }, () => {
  const x = setup("missing");
  const prior = x.prepare();
  const run = x.run("missing-branch");
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /missing|branch|section/i);
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), prior);
});

test("does not presume optional Puzzle discovery on shared Choice entry", { skip: !available }, () => {
  const x = setup("optional-clue");
  const prior = x.prepare();
  const result = x.run("shared-optional-clue");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /optional discovery|shared prose|clue/i);
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), prior);
});

test("refuses missing Puzzle solution ending even when all Events are reachable", { skip: !available }, () => {
  const x = setup("missing-ending");
  const prior = x.prepare();
  const result = x.run("missing-ending");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing.*ending|missing.*solution|missing separate playable Event coverage/i);
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), prior);
});

test("refuses missing distinct protect/challenge aftermath presentation", { skip: !available }, () => {
  const x = setup("missing-aftermath");
  const prior = x.prepare();
  const run = x.run("missing-aftermath");
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /missing separate playable Event coverage|aftermath/i);
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), prior);
});

test("refuses unauthorised edits to Event or protected prose", { skip: !available }, () => {
  const x = setup("scope");
  const prior = x.prepare();
  const run = x.run("event-retcon");
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /unauthorized|scope|Event|read-only/i);
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), prior);
});

test("cannot compose before a verified interactive cluster", { skip: !available }, () => {
  const x = setup("missing-interactive");
  const run = x.run();
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /interactive|verified|committed/i);
});

test("opt-in real Pi composition and independent reviewer read the pinned skill and saved prose", {
  skip: process.env.NT_LIVE_COMPOSITION !== "1" ? "requires NT_LIVE_COMPOSITION=1" : false,
  timeout: 1_200_000,
}, () => {
  const x = setup("live-composition");
  const prior = x.prepare();
  const args = ["composition", "run", "--milestone", "milestone.disclosure", "--skills-source", source];
  if (process.env.NT_PROVIDER) args.push("--provider", process.env.NT_PROVIDER);
  if (process.env.NT_MODEL) args.push("--model", process.env.NT_MODEL);
  if (["low", "high"].includes(process.env.NT_THINKING ?? ""))
    args.push("--thinking", process.env.NT_THINKING!);
  const run = x.cli(args);
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.status, "composition-committed");
  assert.equal(result.validation.protectionBase, prior);
  assert.equal(result.validation.branchReview.reviewer, "independent-pi");
  assert.ok(result.validation.branchReview.sourceEvidence.length >= 2);
  for (const file of [result.sessionFile, result.reviewSessionFile]) {
    assert.ok(existsSync(file));
    const messages = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
    const calls = messages.flatMap((m: any) => m.message?.content ?? [])
      .filter((c: any) => c.type === "toolCall");
    const reads = calls.filter((c: any) => c.name === "read")
      .map((c: any) => c.arguments?.path);
    assert.ok(reads.some((path: string) => path?.includes("nt-narrative-composition/SKILL.md")));
    assert.ok(reads.some((path: string) => path?.includes("authored-content/disclosure-scene.md") ||
      path?.includes("events/disclose-ledger.md")));
    if (file === result.reviewSessionFile)
      assert.ok(!calls.some((c: any) => ["write", "edit", "bash"].includes(c.name)));
  }
  assert.equal(git(x.job.worktreeRoot, "status", "--porcelain"), "");
  assert.equal(git(x.repo, "rev-parse", "HEAD"), x.original);
});
