import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { removeTestTree } from "./helpers.js";
import { saveFixtureTurn } from "./puzzle-obligation-fixtures.js";
import { startStoryJob } from "../src/job.js";
import type { GenerationInventory, ExecutionItem } from "../src/generation-plan.js";
import { restoreCompletedAdaptiveWork } from "../src/adaptive-work.js";
import { inspectRecoveryCheckpoints } from "../src/recovery-checkpoints.js";
import { reviewBoundedAssignments } from "../src/semantic-assignment-review.js";
import { readPuzzleNoWrite } from "../src/puzzle-obligation.js";
import { auditInteractivePaths, checkOutput, selectAssignment,
  RepairableInteractiveGateError, RepairableInteractiveScopeError,
  scopeRepairFeedback, runInteractiveWorkItem } from "../src/interactive-work.js";

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
     };
  function cli(args: string[], variant?: string, eventVariant?: string) {
    return spawnSync(process.execPath, ["--import", "tsx", resolve("src/cli.ts"), "job", ...args,
      "--story", story, "--job", "draft"], { encoding: "utf8", timeout: 120_000,
        maxBuffer: 24 * 1024 * 1024, env: { ...env, NT_INTERACTIVE_FIXTURE_CASE: variant ?? "",
          NT_EVENT_FIXTURE_CASE: eventVariant ?? "" } });
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
  function prepare(eventVariant?: string) {
    const arch = cli(["architecture", "run", "--fixture", "--contract", contract, "--skills-source", source]);
    assert.equal(arch.status, 0, arch.stderr);
    const foundations = cli(["foundations", "run", "--fixture", "--skills-source", source]);
    assert.equal(foundations.status, 0, foundations.stderr);
    const event = cli(["event", "run", "--fixture", "--milestone", "milestone.disclosure", "--skills-source", source], undefined, eventVariant);
    assert.equal(event.status, 0, event.stderr);
    return JSON.parse(event.stdout).headSha as string;
  }
  const interactive = (variant?: string, milestone = "milestone.disclosure") =>
    cli(["interactive", "run", "--fixture", "--milestone", milestone, "--skills-source", source], variant);
  const saveTurn = (request: string, obligations: string[]) =>
    saveFixtureTurn(job, JSON.parse(readFileSync(contract, "utf8")), request, obligations);
  const seal = async (workItem: string) => {
    const old = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    Object.assign(process.env, env);
    try {
      const current = await startStoryJob({ story, job: "draft" }, false);
      const point = (await inspectRecoveryCheckpoints(current)).find(p => p.eligible && p.workItem === workItem);
      assert.ok(point?.assurance, "Missing fixture checkpoint " + workItem);
      if (point.semanticReview === "not-required") return;
      assert.equal(point.semanticReview, "required-pending");
      await reviewBoundedAssignments(current, [point], async packet => ({
        sourceDigest: packet.sourceDigest, verdict: "pass" as const, findings: [],
        evidence: packet.items.map(item => ({
          commitSha: item.assurance.commitSha, assignmentId: item.assignment.id,
          path: item.assurance.changedPaths[0]!, line: 1,
          explanation: "Deterministic fixture: source- and native-validated prerequisite.",
        })),
      }), "deterministic-prerequisite-fixture", true);
    } finally {
      for (const [key, value] of Object.entries(old)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };
  const prepareWithTurn = async (request: string, obligations: string[]) => {
    const original = JSON.parse(readFileSync(contract, "utf8"));
    writeFileSync(contract, JSON.stringify({ ...original,
      scope: { kind: "full-story", depth: "composition", targets: [], branches: [] } }));
    saveTurn(request, obligations);
    const arch = cli(["architecture", "run", "--fixture", "--contract", contract, "--skills-source", source]);
    assert.equal(arch.status, 0, arch.stderr);
    await seal("global-architecture");
    const first = cli(["foundations", "run", "--fixture", "--skills-source", source]);
    assert.notEqual(first.status, 0, "World prerequisite must require independent review");
    await seal("world-foundations");
    const foundations = cli(["foundations", "run", "--fixture", "--skills-source", source]);
    assert.equal(foundations.status, 0, foundations.stderr);
    await seal("character-foundations");
    const event = cli(["event", "run", "--fixture", "--milestone", "milestone.disclosure", "--skills-source", source]);
    assert.equal(event.status, 0, event.stderr);
    await seal("event-disclosure");
    return JSON.parse(event.stdout).headSha as string;
  };
  const interactiveWithChoiceReview = async (variant: string) => {
    const first = interactive(variant);
    assert.notEqual(first.status, 0, "Choice must pause for its selected independent checkpoint review");
    await seal("interactive-choice-disclosure");
    return interactive(variant);
  };
  return { repo, story, baseline, job, env, cli, prepare, interactive, saveTurn, prepareWithTurn, seal,
    interactiveWithChoiceReview };
}
const inspect = (x: ReturnType<typeof setup>) => {
  const result = x.cli(["interactive", "inspect", "--milestone", "milestone.disclosure"]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};

test("adaptive Choice/Puzzle dispatch uses one original receipt, never replays Choice, and rejects a premature Puzzle",
  { skip: !available }, async () => {
    const x = setup("adaptive-split");
    x.prepare();
    const prior = Object.fromEntries(Object.keys(x.env).map(k => [k, process.env[k]]));
    Object.assign(process.env, x.env);
    try {
      const options = { story: x.story, job: "draft", fixture: true,
        milestone: "milestone.disclosure", action: "run" as const, skillsSource: source };
      await assert.rejects(runInteractiveWorkItem({ ...options, unit: "puzzle" }),
        /cannot start before its original Choice receipt/);
      const choice = await runInteractiveWorkItem({ ...options, unit: "choice" });
      assert.equal(choice.status, "interactive-choice-committed");
      const before = choice.headSha;
      assert.equal(choice.specialistUnits[0]?.phase, "committed");
      assert.equal(choice.specialistUnits[1]?.phase, "pending");
      const repeated = await runInteractiveWorkItem({ ...options, unit: "choice" });
      assert.equal(repeated.headSha, before, "already committed Choice cannot be repeated");
      const puzzle = await runInteractiveWorkItem({ ...options, unit: "puzzle" });
      assert.equal(puzzle.status, "interactive-slice-committed");
      assert.equal(puzzle.specialistUnits[0]?.commitSha, before);
      assert.equal(inspect(x).status, "interactive-slice-committed");
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

test("adaptive recovery authenticates actual Choice checkpoint and mandatory independent review",
  { skip: !available }, async () => {
    const x = setup("adaptive-checkpoint-recovery");
    await x.prepareWithTurn("Write a consequential mystery with playable Choices and reviewed endings.", [
      "The player faces distinct supported decisions with downstream consequences.",
      "Every promised Choice must remain independently reviewed.",
    ]);
    const prior = Object.fromEntries(Object.keys(x.env).map(k => [k, process.env[k]]));
    Object.assign(process.env, x.env);
    try {
      const milestone = "milestone.disclosure";
      const choice = await runInteractiveWorkItem({ story: x.story, job: "draft",
        action: "run", milestone, fixture: true, skillsSource: source, unit: "choice" });
      const job = await startStoryJob({ story: x.story, job: "draft" }, false);
      const item: ExecutionItem = { id: "choice:" + milestone, stage: "choice", milestone,
        kind: "realization", targetIds: [milestone], dependencies: [], plannedItems: [],
        skills: ["nt-interactive-narrative"], checks: ["native-validated"],
        authorization: { source: "explicit-author-cli", planVersion: 1, paths: [] },
        planVersion: 1, status: "pending" };
      const original: GenerationInventory = { version: 1, planVersion: 1, headSha: choice.headSha,
        items: [item], rationale: "Adaptive pending original Choice" };
      const completed = [{ stage: "choice" as const, milestone, planVersion: 1,
        headSha: choice.headSha, status: "interactive-choice-committed" }];
      await assert.rejects(restoreCompletedAdaptiveWork(job, structuredClone(original), completed),
        /independent review/i);
      await x.seal("interactive-choice-disclosure");
      const restored = await restoreCompletedAdaptiveWork(job, structuredClone(original), completed);
      assert.equal(restored.items[0]?.status, "verified");
      assert.equal(restored.items[0]?.verifiedSha, choice.headSha);
      await assert.rejects(restoreCompletedAdaptiveWork(job, structuredClone(original), [
        { ...completed[0]!, headSha: "0".repeat(40) } ]),
      /checkpoint|commit|evidence|ancestor|source/i);
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

test("interactive CLI accepts and persists medium thinking for both specialist stages", { skip: !available }, () => {
  const x = setup("medium-thinking");
  x.prepare();
  const result = x.cli(["interactive", "run", "--fixture", "--milestone", "milestone.disclosure",
    "--skills-source", source, "--thinking", "medium"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).thinking, "medium");
  assert.equal(inspect(x).thinking, "medium");
});

test("optional Puzzle can conclude with a sealed no-write receipt after a real Choice commit", { skip: !available }, async () => {
  const x = setup("choice-only-no-write");
  await x.prepareWithTurn("Create a fair-play mystery with an enacted Choice and meaningfully different endings.", [
    "Branch effects must be perceivable and consequential.",
    "Present fair-play clues and independently review the mystery payoff and distinct endings.",
  ]);
  const result = await x.interactiveWithChoiceReview("puzzle-no-write");
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "interactive-slice-committed");
  assert.deepEqual(output.specialistUnits.map((u: any) => u.phase), ["committed", "not-applicable"]);
  assert.equal(output.completionEvidence.deterministicChoicePathAndOptionalPuzzle, true);
  assert.equal(output.completionEvidence.deterministicChoiceAndPuzzlePaths, false);
  assert.equal(output.completionEvidence.puzzleDisposition, "not-applicable");
  assert.equal(output.headSha, output.specialistUnits[0].commitSha);
  assert.equal(output.specialistUnits[1].beforeHead, output.headSha);
  assert.equal(output.specialistUnits[1].paths.length, 0);
  assert.ok(output.specialistUnits[1].noWrite.digest);
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD^"),
    output.specialistUnits[0].beforeHead);
  assert.match(git(x.job.worktreeRoot, "log", "-1", "--format=%B"),
    /NovelTea-Work-Item: interactive-choice-disclosure/);
  assert.equal(git(x.job.worktreeRoot, "status", "--porcelain"), "");
  const seal = JSON.parse(readFileSync(join(x.job.stateDir, "interactive-no-write/disclosure.json"), "utf8"));
  assert.equal(seal.payload.decision, "not-applicable");
  assert.equal(seal.payload.choiceHead, output.headSha);
  assert.equal(seal.payload.piSessionSha256, null, "Fixture writes cannot masquerade as real Pi transcripts");
  assert.equal(seal.payload.report.modifiedRecords.length, 0);
  await assert.rejects(readPuzzleNoWrite({
    ...x.job, threadId: "root:foreign-thread",
  }, "milestone.disclosure", output.specialistUnits[1].noWrite),
  /source\/owner\/digest/, "A sealed omission cannot be reused by another Thread");
  assert.ok(seal.payload.report.architecturalConflicts[0].includes("two proved solution Events"));
  assert.equal(JSON.parse(x.interactive("puzzle-no-write").stdout).headSha, output.headSha);
  assert.equal(inspect(x).headSha, output.headSha);
});

test("approved player-solving obligation blocks a no-write Puzzle report", { skip: !available }, async () => {
  const x = setup("required-puzzle-no-write");
  await x.prepareWithTurn("The player must solve the mystery using two different puzzle methods.", [
    "Players must solve the mystery with a genuinely solvable Puzzle.",
  ]);
  const result = await x.interactiveWithChoiceReview("puzzle-no-write");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Puzzle|no-write/i);
  const receipt = JSON.parse(readFileSync(join(x.job.stateDir, "interactive-items/disclosure.json"), "utf8"));
  assert.notEqual(receipt.units[1].phase, "not-applicable");
  assert.equal(existsSync(join(x.job.stateDir, "interactive-no-write/disclosure.json")), false);
});

test("optional Puzzle proof rejects stale source, mismatched owner and dirty Story", { skip: !available }, async () => {
  const cases = ["source-head", "turn-source", "owner", "sealed-digest", "dirty-story"] as const;
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  for (const variant of cases) {
    const x = setup("no-write-tamper-" + variant);
    await x.prepareWithTurn("A mystery with fair-play clues and divergent choice consequences.", [
      "Review the enacted Choice and distinct written outcomes.",
    ]);
    const result = await x.interactiveWithChoiceReview("puzzle-no-write");
    assert.equal(result.status, 0, result.stderr);
    const path = join(x.job.stateDir, "interactive-items/disclosure.json");
    const receipt = JSON.parse(readFileSync(path, "utf8"));
    if (variant === "source-head") receipt.units[1].beforeHead = receipt.eventHead;
    else if (variant === "turn-source") {
      const sourcePath = join(x.job.stateDir, "turn-plan.json");
      const turn = JSON.parse(readFileSync(sourcePath, "utf8"));
      turn.originalRequest += " Now the player must solve a formal Puzzle.";
      const { digest: _old, ...body } = turn;
      turn.digest = hash(body);
      writeFileSync(sourcePath, JSON.stringify(turn));
    } else if (variant === "owner") {
      const sealPath = join(x.job.stateDir, "interactive-no-write/disclosure.json");
      const seal = JSON.parse(readFileSync(sealPath, "utf8"));
      seal.payload.threadId = "another-thread";
      seal.digest = hash(seal.payload);
      receipt.units[1].noWrite.digest = seal.digest;
      writeFileSync(sealPath, JSON.stringify(seal));
    } else if (variant === "sealed-digest") receipt.units[1].noWrite.digest = "0".repeat(64);
    else {
      mkdirSync(join(x.job.worktreeStoryRoot, "authored-content"), { recursive: true });
      writeFileSync(join(x.job.worktreeStoryRoot, "authored-content/dirt.md"), "Untracked, unapproved source");
    }
    if (["source-head", "owner", "sealed-digest"].includes(variant))
      writeFileSync(path, JSON.stringify(receipt));
    const replay = x.interactive("puzzle-no-write");
    assert.notEqual(replay.status, 0, variant);
    assert.match(replay.stderr, /head|seal|dirty|source|mismatch|receipt|assurance/i);
  }
});

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
  const objective = readFileSync(join(x.job.worktreeStoryRoot, "puzzles/ledger-proof.md"), "utf8");
  assert.match(objective, /concealed entry through documentary decoding or corroborated testimony/);
  for (const path of ["events/decode-ledger.md", "events/request-testimony.md"]) {
    const content = readFileSync(join(x.job.worktreeStoryRoot, path), "utf8");
    assert.match(content, /revealed/);
    assert.match(content, /revelation\.puzzle-evidence/);
  }
  assert.equal(inspect(x).headSha, data.headSha);
  const replay = x.interactive();
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(JSON.parse(replay.stdout).headSha, data.headSha);
});

test("native Puzzle structure cannot certify a weaker alternate solution as semantically equivalent", { skip: !available }, () => {
  const x = setup("puzzle-weak-custody");
  x.prepare();
  const result = x.interactive("puzzle-weak-custody");
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.status, "interactive-slice-committed");
  assert.equal(data.specialistUnits[1].validation.puzzles[0].solutions.length, 2);
  assert.ok(data.specialistUnits[1].validation.puzzles[0].solutions.every((s: any) =>
    s.status === "reachable" && s.clueAccess === "reachable"),
    "Structural reachability does not establish editorial equivalence");
  const objective = readFileSync(join(x.job.worktreeStoryRoot, "puzzles/ledger-proof.md"), "utf8");
  const weaker = readFileSync(join(x.job.worktreeStoryRoot, "events/request-testimony.md"), "utf8");
  assert.match(objective, /concealed entry/);
  assert.match(weaker, /cannot confirm that any ledger entry was concealed/);
  assert.doesNotMatch(weaker, /kind: revealed/);
  assert.equal(JSON.parse(x.cli(["validate"]).stdout).status, "passed");
  // A separate, sealed independent semantic review must FAIL this mismatch.
  // The native validator's PASSED result is not a literary approval.
});

test("staged Event→Choice preserves partial Milestone and original immutable prerequisite gate", { skip: !available }, () => {
  const x = setup("staged-event-choice");
  const eventHead = x.prepare("decision-pending");
  const original = readFileSync(join(x.job.worktreeStoryRoot, "events/disclose-ledger.md"), "utf8");
  const milestone = readFileSync(join(x.job.worktreeStoryRoot, "milestones/disclosure.md"), "utf8");
  const run = x.interactive();
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.status, "interactive-slice-committed");
  assert.equal(result.eventSource.headSha, eventHead);
  assert.equal(result.eventSource.milestoneState, "partial-choice-pending");
  assert.match(result.eventSource.missingObligations.join(";"), /Choice Point binding/);
  assert.deepEqual(result.eventSource.eventIds, ["event.disclose-ledger"]);
  const updated = readFileSync(join(x.job.worktreeStoryRoot, "events/disclose-ledger.md"), "utf8");
  const gate = (text: string) => text.split("prerequisites:")[1]!.split("steps:")[0]!;
  assert.equal(gate(updated), gate(original));
  assert.equal(readFileSync(join(x.job.worktreeStoryRoot, "milestones/disclosure.md"), "utf8"), milestone,
    "The Choice owner must not silently close a partial Milestone");
  const choices = result.specialistUnits[0].validation.choices[0].outcomes;
  assert.deepEqual(choices.map((o: any) => o.name), ["protect", "challenge"]);
  assert.ok(choices.every((o: any) => o.downstream.includes("event.aftermath")));
  assert.equal(git(x.job.worktreeRoot, "status", "--porcelain"), "");
});

test("stale Event-source receipt cannot authorize Choice edits", { skip: !available }, () => {
  const x = setup("stale-event-source");
  const eventHead = x.prepare("decision-pending");
  const file = join(x.job.stateDir, "event-items/disclosure.json");
  const corrupted = JSON.parse(readFileSync(file, "utf8"));
  corrupted.validation.eventIds = ["event.unrelated"];
  writeFileSync(file, JSON.stringify(corrupted));
  const denied = x.interactive();
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /Missing or unreachable verified|sealed Event work evidence|Event source/);
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), eventHead);
  assert.equal(existsSync(join(x.job.worktreeStoryRoot, "choice-points/loyalty.md")), false);
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

test("Choice may enact its first justified typed effects only in reachable downstream Events", { skip: !available }, () => {
  const x = setup("downstream-effect-only");
  const prior = x.prepare();
  const result = x.interactive("downstream-effect-only");
  assert.equal(result.status, 0, result.stderr);
  const choice = JSON.parse(result.stdout).specialistUnits[0];
  assert.equal(choice.validation.protectionBase, prior);
  const outcomes = choice.validation.choices[0].outcomes;
  assert.deepEqual(outcomes.map((o: any) => o.name), ["protect", "challenge"]);
  assert.ok(outcomes.every((o: any) => o.downstream.includes("event.aftermath")));
  assert.ok(outcomes.every((o: any) => JSON.parse(o.consequence).every((effect: any) =>
    effect.kind !== "outcome")));
  assert.notEqual(outcomes[0].consequence, outcomes[1].consequence,
    "Distinct consequential state appears after, not at, Choice selection");
  assert.equal(JSON.parse(x.cli(["validate"]).stdout).status, "passed");
});

test("native rejects self-conditioned Choice selectors, but accepts unguarded selectors with conditional consumers", { skip: !available }, () => {
  const x = setup("self-conditioned-selection");
  const head = x.prepare();
  const rejected = x.interactive("self-conditioned-selection");
  assert.notEqual(rejected.status, 0, "The native invalid Choice cannot become a commit.");
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), head);
  const invalid = JSON.parse(x.cli(["validate"]).stdout);
  assert.equal(invalid.status, "rejected");
  assert.ok(invalid.report.diagnostics.some((d: any) =>
    d.code === "impossible-branch" && d.path === "events/disclose-ledger.md"),
    "Outcome predicates cannot require an outcome before the first assignment.");
  const eventPath = join(x.job.worktreeStoryRoot, "events/disclose-ledger.md");
  const authored = readFileSync(eventPath, "utf8");
  const correctSelector = (text: string, id: string, outcome: string) =>
    text.replace(
      `- id: ${id}\n        conditions:\n          - kind: outcome\n            choice_point: choice-point.loyalty\n            value: ${outcome}\n        effects:`,
      `- id: ${id}\n        conditions: []\n        effects:`,
    );
  const fixed = correctSelector(
    correctSelector(authored, "disclose", "protect"), "challenge", "challenge");
  assert.notEqual(fixed, authored);
  assert.match(fixed, /- id: disclose\n        conditions: \[\]/);
  assert.match(fixed, /- id: challenge\n        conditions: \[\]/);
  writeFileSync(eventPath, fixed);
  const valid = JSON.parse(x.cli(["validate"]).stdout);
  assert.equal(valid.status, "passed", JSON.stringify(valid.report.diagnostics));
});

test("outcome-only selection with no later typed consequence remains rejected", { skip: !available }, () => {
  const x = setup("downstream-no-effect");
  const head = x.prepare();
  const invalid = x.interactive("downstream-no-effect");
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /lacks a consequential typed effect at selection/);
  assert.match(invalid.stderr, /outcome-conditioned Event\/step/);
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), head);
});

test("rejects an outcome with neither a later consumer nor a precise writing obligation", { skip: !available }, () => {
  const x = setup("unpaid-choice");
  const head = x.prepare();
  const invalid = x.interactive("unpaid-choice");
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /lacks a reachable later consumer or specific conditional writing obligation/);
  assert.match(invalid.stderr, /selected at event\.disclose-ledger#/);
  assert.match(invalid.stderr, /conditioned on this exact outcome/);
  assert.match(invalid.stderr, /immutable original Event prerequisite gate/);
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

test("a touched Event prerequisite gate receives only source-preserving original-session correction feedback", { skip: !available }, async () => {
  const x = setup("gate-correction-feedback");
  const prior = x.prepare();
  const path = "events/disclose-ledger.md";
  const file = join(x.job.worktreeStoryRoot, path);
  const original = readFileSync(file, "utf8");
  writeFileSync(file, original.replace("prerequisites:\n",
    "prerequisites:\n  # no unauthorized gate adjustment may be published\n"));
  const assign = { sourcePaths: [path] } as any;
  let error: unknown;
  try { await auditInteractivePaths(x.job, assign, "choice", [path]); }
  catch (cause) { error = cause; }
  assert.ok(error instanceof RepairableInteractiveGateError);
  assert.deepEqual(error.paths, [path]);
  const protection = (changes: unknown[] = []) => ({
    status: "passed", jobId: x.job.jobId, worktreeStoryRoot: x.job.worktreeStoryRoot,
    baseSha: prior, report: { protection: { status: "checked", base: prior,
      changes, warnings: [] } },
  }) as any;
  const feedback = await scopeRepairFeedback(x.job, prior, error, async () => protection());
  assert.match(feedback!.join(" "), /restore ONLY the prerequisites YAML blocks/);
  assert.match(feedback!.join(" "), /byte-for-byte/);
  assert.match(feedback!.join(" "), /NOT a grant to rewrite/);
  assert.notEqual(readFileSync(file, "utf8"), original,
    "The controller must not silently revert a writer's illegal edit");
  await assert.rejects(scopeRepairFeedback(x.job, prior, error,
    async () => protection([{ kind: "retcon" }])), /protected Story changes/);
  writeFileSync(file, original);
  assert.equal(git(x.job.worktreeRoot, "status", "--porcelain"), "");
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

test("existing Choice/Puzzle may be certified after a linked Event-only edit", { skip: !available }, async () => {
  const x = setup("revise-existing-interactive");
  x.prepare();
  const originalRun = x.interactive();
  assert.equal(originalRun.status, 0, originalRun.stderr);
  const validated = x.cli(["validate"]);
  assert.equal(validated.status, 0, validated.stderr);
  const report = JSON.parse(validated.stdout).report;
  const architecture = JSON.parse(x.cli(["architecture", "inspect"]).stdout);
  const assignment = selectAssignment(architecture.plan, report, "milestone.disclosure");
  assert.ok(assignment.sourcePaths.some(p => p.startsWith("choice-points/")));
  assert.ok(assignment.sourcePaths.some(p => p.startsWith("puzzles/")));
  for (const domain of ["choice", "puzzle"] as const) {
    const path = domain === "choice" ? "events/disclose-ledger.md" : "events/decode-ledger.md";
    const target = join(x.job.worktreeStoryRoot, path);
    const originalText = readFileSync(target, "utf8");
    writeFileSync(target, originalText + "\nThe response is delivered with more care.\n");
    const paths = await auditInteractivePaths(x.job, assignment, domain, [path]);
    assert.deepEqual(paths, [path]);
    const unit = { domain, paths } as any;
    const result = await checkOutput(x.job, report, report, assignment, unit, []);
    if (domain === "choice") assert.ok(result.choices.length);
    else assert.ok(result.puzzles.length);
    writeFileSync(target, originalText);
  }
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
