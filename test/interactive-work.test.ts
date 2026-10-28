import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { removeTestTree } from "./helpers.js";
import { auditInteractivePaths, RepairableInteractiveScopeError, scopeRepairFeedback } from "../src/interactive-work.js";

const root = mkdtempSync(join(tmpdir(), "nt-interactive-work-"));
after(() => removeTestTree(root));
const source = resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills");
const available = existsSync(join(source, "src/cli.ts"));
function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
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
  git(repo, "add", "."); git(repo, "commit", "-qm", "Author's initial Story");
  const baseline = git(repo, "rev-parse", "HEAD");
  const env = { ...process.env, NT_STATE_DIR: join(root, name + "-state"),
    NT_CONFIG_FILE: join(root, "missing-config.json"), NT_SKILL_CACHE_DIR: join(root, "skills"),
    NT_VALIDATOR_CACHE_DIR: join(root, "validators") };
  function cli(args: string[], variant?: string) {
    return spawnSync(process.execPath, ["--import", "tsx", resolve("src/cli.ts"), "job", ...args,
      "--story", story, "--job", "draft"], { encoding: "utf8", timeout: 120_000,
        maxBuffer: 24 * 1024 * 1024, env: { ...env, NT_INTERACTIVE_FIXTURE_CASE: variant ?? "" } });
  }
  const started = cli(["start"]); assert.equal(started.status, 0, started.stderr);
  const job = JSON.parse(started.stdout);
  const contract = join(root, name + "-contract.json");
  writeFileSync(contract, JSON.stringify({
    scope: { kind: "partial", depth: "interactive",
      targets: ["arc.truth", "milestone.disclosure"], branches: ["trust-route", "challenge-route"] },
    constraints: ["The player must choose to defend or challenge a trusted friend"],
    envelope: { presentation: "Visual novel", hardLimits: ["Reuse archive backdrop"],
      preferences: ["Two major Characters", "Clues visible without bespoke animation"] },
  }));
  function prepare() {
    const arch = cli(["architecture", "run", "--fixture", "--contract", contract, "--skills-source", source]);
    assert.equal(arch.status, 0, arch.stderr);
    const foundations = cli(["foundations", "run", "--fixture", "--skills-source", source]);
    assert.equal(foundations.status, 0, foundations.stderr);
    const event = cli(["event", "run", "--fixture", "--milestone", "milestone.disclosure", "--skills-source", source]);
    assert.equal(event.status, 0, event.stderr);
    return JSON.parse(event.stdout).headSha as string;
  }
  const interactive = (variant?: string, milestone = "milestone.disclosure") =>
    cli(["interactive", "run", "--fixture", "--milestone", milestone, "--skills-source", source], variant);
  return { repo, story, baseline, job, cli, prepare, interactive };
}
const inspect = (x: ReturnType<typeof setup>) => {
  const result = x.cli(["interactive", "inspect", "--milestone", "milestone.disclosure"]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};

test("reference adventure authors two independently certified Choice/Puzzle commits", { skip: !available }, () => {
  const x = setup("reference");
  const prior = x.prepare();
  const result = x.interactive();
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.status, "interactive-slice-committed");
  assert.deepEqual(data.specialistUnits.map((u: any) => u.phase), ["committed", "committed"]);
  assert.deepEqual(data.specialistUnits.map((u: any) => u.specialist),
    ["nt-interactive-narrative", "nt-puzzle-design"]);
  const choice = data.specialistUnits[0];
  const puzzle = data.specialistUnits[1];
  assert.equal(choice.validation.protectionBase, prior);
  assert.equal(puzzle.validation.protectionBase, choice.commitSha);
  assert.deepEqual(choice.validation.choices[0].outcomes.map((o: any) => o.name), ["protect", "challenge"]);
  assert.ok(choice.validation.choices[0].outcomes.every((o: any) => o.downstream.includes("event.aftermath")));
  assert.equal(puzzle.validation.puzzles[0].solutions.length, 2);
  assert.ok(puzzle.validation.puzzles[0].solutions.every((s: any) =>
    s.status === "reachable" && s.clueAccess === "reachable" && s.clueIds.length));
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD~2"), prior);
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), data.headSha);
  assert.equal(git(x.job.worktreeRoot, "status", "--porcelain"), "");
  assert.equal(git(x.repo, "rev-parse", "HEAD"), x.baseline);
  assert.match(git(x.job.worktreeRoot, "log", "-2", "--format=%B"), /NovelTea-Work-Item: interactive-choice-disclosure/);
  assert.match(git(x.job.worktreeRoot, "log", "-1", "--format=%B"), /NovelTea-Work-Item: interactive-puzzle-disclosure/);
  const report = x.cli(["validate"]);
  assert.equal(report.status, 0, report.stderr);
  const coverage = JSON.parse(report.stdout).report.coverage;
  assert.ok(coverage.puzzleSolutions[0].solutions.every((s: any) =>
    s.status === "reachable" && s.clueAccess.status === "reachable"));
  const stories = JSON.parse(report.stdout).report.records;
  for (const id of ["authored-content.watermark-clue", "authored-content.seal-clue"]) {
    assert.ok(stories.some((r: any) => r.metadata.id === id));
  }
  assert.equal(inspect(x).headSha, data.headSha);
  const replay = x.interactive();
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(JSON.parse(replay.stdout).headSha, data.headSha);
});

test("verified deferred capture between Event and Interactive remains independent", { skip: !available }, () => {
  const x = setup("capture-between-stages");
  const eventHead = x.prepare();
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
  const result = x.interactive();
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.eventHead, eventHead);
  assert.equal(data.specialistUnits[0].validation.protectionBase, captured);
  assert.equal(git(x.job.worktreeRoot, "rev-parse", data.specialistUnits[0].commitSha + "^"), captured);
});

test("paused Interactive job does not begin Choice work", { skip: !available }, () => {
  const x = setup("paused-interactive");
  x.prepare();
  const pause = x.cli(["author", "control", "--state", "paused"]);
  assert.equal(pause.status, 0, pause.stderr);
  const run = x.interactive();
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /paused|cannot advance/);
  assert.equal(existsSync(join(x.job.worktreeStoryRoot, "choice-points/loyalty.md")), false);
});

test("Choice specialist may author connected player-facing Authored Content", { skip: !available }, () => {
  const x = setup("choice-content");
  x.prepare();
  const result = x.interactive("choice-content");
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.status, "interactive-slice-committed");
  assert.ok(data.specialistUnits[0].paths.includes("authored-content/choice-presentation.md"));
  assert.equal(JSON.parse(x.cli(["validate"]).stdout).status, "passed");
});

test("precise conditional writing obligations qualify when no later Event has been authored", { skip: !available }, () => {
  const x = setup("conditional-writing");
  const prior = x.prepare();
  const result = x.interactive("conditional-writing");
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.status, "interactive-slice-committed");
  const outcomes = data.specialistUnits[0].validation.choices[0].outcomes;
  assert.ok(outcomes.every((o: any) => o.downstream.includes("conditional-writing-obligation")));
  assert.equal(data.specialistUnits[0].validation.protectionBase, prior);
  assert.equal(data.specialistUnits[1].validation.puzzles[0].solutions.length, 2);
});

test("accepts precise conditional payoff obligations naming the Choice Point rather than each slug", { skip: !available }, () => {
  const x = setup("choice-id-obligation");
  const prior = x.prepare();
  const result = x.interactive("choice-id-obligation");
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.status, "interactive-slice-committed");
  const outcomes = data.specialistUnits[0].validation.choices[0].outcomes;
  assert.ok(outcomes.every((o: any) => o.downstream.includes("conditional-writing-obligation")));
  assert.equal(data.specialistUnits[0].validation.protectionBase, prior);
  assert.equal(data.specialistUnits[1].validation.puzzles[0].solutions.length, 2);
});

test("reachable later conditional steps in the selecting Event count as genuine payoffs", { skip: !available }, () => {
  const x = setup("same-event-payoff");
  const prior = x.prepare();
  const run = x.interactive("same-event-payoff");
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.status, "interactive-slice-committed");
  assert.equal(result.specialistUnits[0].validation.protectionBase, prior);
  const outcomes = result.specialistUnits[0].validation.choices[0].outcomes;
  assert.deepEqual(outcomes.map((o: any) => o.name), ["protect", "challenge"]);
  assert.ok(outcomes.every((o: any) => o.downstream.some((consumer: string) =>
    consumer.startsWith("event.disclose-ledger#later-payoff/"))));
  assert.ok(outcomes.every((o: any) => !o.downstream.includes("conditional-writing-obligation")));
  assert.ok(result.specialistUnits[1].validation.puzzles[0].solutions.length >= 2);
  assert.equal(JSON.parse(x.cli(["validate"]).stdout).status, "passed");
});

test("rejects an outcome with neither a later consumer nor a precise writing obligation", { skip: !available }, () => {
  const x = setup("unpaid-choice");
  const head = x.prepare();
  const invalid = x.interactive("unpaid-choice");
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /lacks a reachable later consumer or specific conditional writing obligation/);
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), head);
  assert.equal(inspect(x).specialistUnits[0].phase, "authored");
});

test("refuses interactive work without a completed Event foundation or authorized target", { skip: !available }, () => {
  const x = setup("missing");
  const missing = x.interactive();
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /requires verified architecture|requires .*Event design/i);
  x.prepare();
  const unknown = x.interactive(undefined, "milestone.unplanned");
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /verified.*Event|authorized|Event-design/i);
});

test("rejection of mutually exclusive ending predicates preserves first specialist draft", { skip: !available }, () => {
  const x = setup("exclusive");
  const prior = x.prepare();
  const result = x.interactive("exclusive-endings");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /impossible|contradictory|canonical/i);
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), prior);
  const data = inspect(x);
  assert.equal(data.specialistUnits[0].phase, "authored");
  assert.equal(data.specialistUnits[1].phase, "pending");
  assert.equal(data.completionEvidence.deterministicChoiceAndPuzzlePaths, false);
});

test("rejects Choice branch state leakage, does not claim completion", { skip: !available }, () => {
  const x = setup("state-leak");
  const head = x.prepare();
  const result = x.interactive("state-leak");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Revelation leaks|branch-exclusive/i);
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), head);
  assert.equal(inspect(x).specialistUnits[0].phase, "authored");
});

test("a new choice cannot bypass a previously committed Event prerequisite route", { skip: !available }, () => {
  const x = setup("bypass");
  const head = x.prepare();
  const result = x.interactive("bypass-gate");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /prerequisite route gate|changed or bypassed/i);
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), head);
  assert.equal(inspect(x).specialistUnits[0].phase, "writing");
  assert.notEqual(git(x.job.worktreeRoot, "status", "--porcelain"), "");
});

test("Puzzle with no independently accessible pre-solution clue is rejected", { skip: !available }, () => {
  const x = setup("unreachable-clue");
  const head = x.prepare();
  const result = x.interactive("unreachable-clue");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unreachable|unverified|pre-solution|canonical/i);
  const data = inspect(x);
  assert.equal(data.specialistUnits[0].phase, "committed");
  assert.notEqual(data.specialistUnits[1].phase, "committed");
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), data.specialistUnits[0].commitSha);
  assert.notEqual(git(x.job.worktreeRoot, "rev-parse", "HEAD"), head);
});

test("read-only Milestone edits get bounded scope feedback, without being authorized", { skip: !available }, async () => {
  const x = setup("scope-feedback");
  const prior = x.prepare();
  const milestone = join(x.job.worktreeStoryRoot, "milestones/disclosure.md");
  const original = readFileSync(milestone, "utf8");
  writeFileSync(milestone, original.replace("The hidden evidence becomes a shared responsibility",
    "Unauthorized new Milestone objective"));
  mkdirSync(join(x.job.worktreeStoryRoot, "choice-points"), { recursive: true });
  writeFileSync(join(x.job.worktreeStoryRoot, "choice-points/example.md"), "Safe uncommitted draft\n");
  const assignment = { sourcePaths: ["events/disclose-ledger.md", "milestones/disclosure.md"] } as any;
  const inventory = ["choice-points/example.md", "milestones/disclosure.md"];
  let violation: RepairableInteractiveScopeError | undefined;
  try { await auditInteractivePaths(x.job, assignment, "choice", inventory); }
  catch (e) { if (e instanceof RepairableInteractiveScopeError) violation = e; else throw e; }
  assert.ok(violation);
  assert.deepEqual(violation.paths, ["milestones/disclosure.md"]);
  const protectedReport = (changes: unknown[] = [], warnings: unknown[] = [], base = prior) =>
    ({ status: "passed", jobId: x.job.jobId, worktreeStoryRoot: x.job.worktreeStoryRoot,
      baseSha: prior, report: { protection: { status: "checked", base, changes, warnings } } }) as any;
  const feedback = await scopeRepairFeedback(x.job, prior, violation, async () => protectedReport());
  assert.match(feedback!.join("\n"), /Unauthorized interactive specialist file/);
  assert.match(feedback!.join("\n"), /Restore ONLY these files/);
  assert.match(feedback!.join("\n"), /do not use git checkout/);
  assert.equal(readFileSync(milestone, "utf8").includes("Unauthorized new Milestone objective"), true,
    "Graph must not silently revert the unauthorized edit");
  await assert.rejects(scopeRepairFeedback(x.job, prior, violation,
    async () => protectedReport([{decision:"protected"}])), /protected Story changes/);
  await assert.rejects(scopeRepairFeedback(x.job, prior, violation,
    async () => protectedReport([], [], "a".repeat(40))), /protected Story changes/);
  await assert.rejects(scopeRepairFeedback(x.job, prior, violation,
    async () => ({ ...protectedReport(), status: "unverified" })), /protected Story changes/);
  writeFileSync(milestone, original);
  assert.deepEqual(await auditInteractivePaths(x.job, assignment, "choice", ["choice-points/example.md"]),
    ["choice-points/example.md"]);
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), prior);
  // A staged change is never softened merely because another path is an
  // otherwise-repairable read-only Milestone edit.
  writeFileSync(milestone, original.replace("The hidden evidence becomes a shared responsibility",
    "Unauthorized new Milestone objective"));
  git(x.job.worktreeRoot, "add", "--", "story/choice-points/example.md");
  await assert.rejects(auditInteractivePaths(x.job, assignment, "choice", inventory),
    /staged, deleted or renamed/);
});

test("rejects forged manifests and author-protected retcons before Choice commits", { skip: !available }, () => {
  const retcon = setup("protected-retcon");
  const head = retcon.prepare();
  const changed = retcon.interactive("protected-retcon");
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /Unauthorized interactive specialist file/);
  assert.equal(git(retcon.job.worktreeRoot, "rev-parse", "HEAD"), head);
  const mismatch = setup("mismatch");
  const before = mismatch.prepare();
  const falseClaim = mismatch.interactive("mismatch");
  assert.notEqual(falseClaim.status, 0);
  assert.match(falseClaim.stderr, /manifest differs from actual Git files/);
  assert.equal(git(mismatch.job.worktreeRoot, "rev-parse", "HEAD"), before);
  assert.equal(inspect(mismatch).specialistUnits[0].phase, "writing");
});

test("unverified solution route is not mistaken for proven playability", { skip: !available }, () => {
  const x = setup("unverified");
  x.prepare();
  const result = x.interactive("unverified-solution");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unverified|reachable|Puzzle|canonical/i);
  const data = inspect(x);
  assert.equal(data.specialistUnits[0].phase, "committed");
  assert.notEqual(data.specialistUnits[1].phase, "committed");
});
