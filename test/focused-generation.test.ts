import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { removeTestTree } from "./helpers.js";
import { parseGenerationContract } from "../src/generation.js";
import { startStoryJob } from "../src/job.js";
import { validateStoryJob } from "../src/validator.js";
import { runArchitectureJob, type CompletionContract } from "../src/architecture.js";
import { runFocusedWorkItem } from "../src/focused-work.js";
import { inspectRecoveryCheckpoints } from "../src/recovery-checkpoints.js";
import type { CanonicalScopeRecord } from "../src/focused-scope.js";
import { planObjective } from "../web/src/lib/turn-plan.js";
import { inferStoryObjective } from "../web/src/lib/story-revision-plan.js";
import { saveJobTurnPlan } from "../web/src/lib/turn-plan-receipt.server.js";

const source = resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills");
const available = existsSync(join(source, "src/cli.ts"));
const root = mkdtempSync(join(tmpdir(), "nt-focused-generation-"));
after(() => removeTestTree(root));
function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
}
function fixture(name: string) {
  const repo = join(root, name), story = join(repo, "story");
  mkdirSync(story, { recursive: true });
  writeFileSync(join(story, ".gitkeep"), "");
  git(repo, "init", "-q"); git(repo, "config", "user.name", "Author");
  git(repo, "config", "user.email", "author@example.test");
  git(repo, "add", "."); git(repo, "commit", "-qm", "Author baseline");
  const env = { ...process.env, NT_STATE_DIR: join(root, name + "-state"),
    NT_SKILL_CACHE_DIR: join(root, "skills"),  };
  const contractPath = join(root, name + "-scope.json");
  const contract = (targets: string[], depth: string, branches: string[] = []) => {
    writeFileSync(contractPath, JSON.stringify({
      scope: { kind: "partial", depth, targets, branches }, constraints: [],
      envelope: { presentation: "Visual novel", hardLimits: [], preferences: [] },
    }));
  };
  const cli = (job: string, args: string[], success = true) => {
    const r = spawnSync(process.execPath, ["--import", "tsx", resolve("src/cli.ts"),
      "job", ...args, "--story", story, "--job", job], {
      encoding: "utf8", env, timeout: 240_000, maxBuffer: 32 * 1024 * 1024,
    });
    if (!success) { assert.notEqual(r.status, 0); return r.stderr; }
    assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
  };
  return { repo, story, env, contract, cli, contractPath };
}

test("bounded conversation creation commits only canonical new support with preserved source Story", {
  skip: !available, timeout: 300_000,
}, async () => {
  const f = fixture("focused-conversation-creation");
  f.cli("seed", ["start"]);
  f.contract(["arc.truth", "milestone.disclosure"], "composition", ["protect", "challenge"]);
  const seeded = f.cli("seed", ["generate", "start", "--task", "Seed a witness mystery",
    "--contract", f.contractPath, "--fixture", "--skills-source", source]);
  assert.equal(seeded.reason, "editorial-unverified");
  git(f.repo, "merge", "--ff-only", seeded.report.identity.branch);
  const canonical = git(f.repo, "rev-parse", "HEAD");
  f.cli("conversation", ["start"]);
  const oldState = process.env.NT_STATE_DIR, oldCache = process.env.NT_SKILL_CACHE_DIR;
  process.env.NT_STATE_DIR = f.env.NT_STATE_DIR;
  process.env.NT_SKILL_CACHE_DIR = f.env.NT_SKILL_CACHE_DIR;
  try {
    const job = await startStoryJob({ story: f.story, job: "conversation" }, false);
    assert.equal(job.baseSha, canonical);
    const before = await validateStoryJob(job, source, { ...job, baseSha: canonical });
    assert.equal(before.status, "passed");
    const catalog = (before.report as { records: CanonicalScopeRecord[] }).records;
    const prior = JSON.parse(readFileSync(f.contractPath, "utf8")) as CompletionContract;
    const task = "Write a conversation between Ada and Neri about rebuilding trust after the forgotten promise";
    const preview = inferStoryObjective(task, catalog, canonical, prior);
    assert.equal(preview.clarification, null);
    assert.ok(preview.contract.scope.creates?.length);
    assert.equal(preview.reviewRequired, true);
    const plan = planObjective({ kind: "revision", request: task, contract: preview.contract,
      base: canonical, sourceJobId: "seed", catalog,
      targetIds: preview.targets, allowedPaths: preview.writePaths });
    await saveJobTurnPlan(job, plan);
    const architecture = await runArchitectureJob({ story: f.story, job: "conversation",
      action: "run", fixture: true, contract: preview.contract, skillsSource: source });
    assert.equal(architecture.status, "architecture-committed");
    const created = preview.contract.scope.creates!;
    for (const item of created) {
      const result = await runFocusedWorkItem({ story: f.story, job: "conversation",
        target: item.id, task, contract: preview.contract, fixture: true,
        turnPlanDigest: plan.digest, skillsSource: source });
      assert.equal(result.status, "focused-committed");
      const after = await runFocusedWorkItem({ story: f.story, job: "conversation",
        target: item.id, task, contract: preview.contract, fixture: true,
        turnPlanDigest: plan.digest, skillsSource: source });
      assert.equal(after.headSha, result.headSha, "completed assignment replays must be idempotent");
    }
    const checkpoints = (await inspectRecoveryCheckpoints(job)).filter(p =>
      p.workItem.startsWith("focus:"));
    assert.equal(checkpoints.length, created.length);
    for (const item of created) {
      const point = checkpoints.find(p => p.workItem === "focus:" + item.id)!;
      assert.equal(point.eligible, true, point.reason ?? "checkpoint eligible");
      assert.equal(point.assurance?.assignmentId, "focus:" + item.id);
      assert.deepEqual(point.assurance?.changedPaths, [item.path]);
      assert.deepEqual(point.dependencies["focus:" + item.id], ["global-architecture",
        ...item.dependsOn.map(id => "focus:" + id)]);
      if (item.id.startsWith("event.")) {
        assert.equal(point.assurance?.reviewSelection.status, "required-pending",
          "a new causal Event must wait for independent semantic review in production");
        assert.equal(point.semanticReview, "required-pending",
          "fixture validation does not manufacture an independent reviewer pass");
      }
    }
    const final = git(job.worktreeRoot, "rev-parse", "HEAD");
    const changed = git(job.worktreeRoot, "diff", "--name-only", canonical, final)
      .split("\n").filter(Boolean).map(path => path.replace(/^story\//, "")).sort();
    assert.deepEqual(changed, preview.writePaths);
    const verified = await validateStoryJob(job, source, { ...job, baseSha: canonical });
    assert.equal(verified.status, "passed");
    const after = (verified.report as { records: CanonicalScopeRecord[] }).records;
    for (const create of created) {
      const record = after.find(item => item.metadata.id === create.id);
      assert.equal(record?.path, create.path);
    }
    assert.equal(git(f.repo, "rev-parse", "HEAD"), canonical);
    assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "");
  } finally {
    if (oldState === undefined) delete process.env.NT_STATE_DIR;
    else process.env.NT_STATE_DIR = oldState;
    if (oldCache === undefined) delete process.env.NT_SKILL_CACHE_DIR;
    else process.env.NT_SKILL_CACHE_DIR = oldCache;
  }
});

test("completion contract accepts typed deep targets, presets, and rejects ambiguous or invalid scope", () => {
  const input = { scope: { kind: "partial", preset: "interactive-development",
    targets: ["event.disclose-ledger", "character.ada"], branches: ["protect"] },
    constraints: [], envelope: { presentation: "Narrative game", hardLimits: [], preferences: [] } };
  const parsed = parseGenerationContract(input);
  assert.equal(parsed.scope.depth, "interactive");
  assert.equal(parsed.scope.preset, undefined);
  assert.deepEqual(parsed.scope.targets, ["event.disclose-ledger", "character.ada"]);
  assert.throws(() => parseGenerationContract({ ...input,
    scope: { ...input.scope, targets: ["event.NONCANONICAL"] } }), /Invalid completion contract/);
  assert.throws(() => parseGenerationContract({ ...input,
    scope: { ...input.scope, depth: "architecture" } }), /Invalid completion contract/);
  assert.equal(parseGenerationContract({ ...input,
    scope: { kind: "partial", preset: "architecture-outline", targets: ["character.ada"], branches: [] } }).scope.depth, "architecture");
  assert.equal(parseGenerationContract({ ...input,
    scope: { kind: "partial", preset: "full-composition", targets: ["authored-content.disclosure-scene"], branches: [] } }).scope.depth, "composition");
  assert.throws(() => parseGenerationContract({ ...input,
    scope: { kind: "partial", depth: "architecture", targets: ["event.disclose-ledger"], branches: [] } }),
    /compatible narrative depth/);
  assert.throws(() => parseGenerationContract({ ...input,
    scope: { kind: "partial", depth: "composition", targets: ["arc.truth", "event.disclose-ledger"], branches: [] } }),
    /Mixed Arc\/Milestone/);
});

test("public scoped generation revises Event, Character, Choice, Puzzle and branch-aware prose independently", {
  skip: !available, timeout: 300_000,
}, () => {
  const f = fixture("scoped-records");
  f.cli("seed", ["start"]);
  f.contract(["arc.truth", "milestone.disclosure"], "composition", ["protect", "challenge"]);
  const baseline = f.cli("seed", ["generate", "start", "--task", "Create a branching witness mystery",
    "--contract", f.contractPath, "--fixture", "--skills-source", source]);
  assert.equal(baseline.reason, "editorial-unverified");
  git(f.repo, "merge", "--ff-only", baseline.report.identity.branch);
  const canonical = git(f.repo, "rev-parse", "HEAD");
  const authored = ["events/disclose-ledger.md", "characters/ada.md", "authored-content/disclosure-scene.md",
    "choice-points/loyalty.md", "puzzles/ledger-proof.md"];
  for (const [index, [id, depth, branches]] of [
    ["event.disclose-ledger", "interactive", []],
    ["character.ada", "architecture", []],
    ["authored-content.disclosure-scene", "composition", ["protect"]],
    ["choice-point.loyalty", "interactive", ["challenge"]],
    ["puzzle.ledger-proof", "interactive", []],
  ].entries()) {
    const name = "focus-" + index;
    const job = f.cli(name, ["start"]);
    f.contract([id as string], depth as string, branches as string[]);
    if (index === 1) {
      const preset = JSON.parse(readFileSync(f.contractPath, "utf8"));
      delete preset.scope.depth;
      preset.scope.preset = "architecture-outline";
      writeFileSync(f.contractPath, JSON.stringify(preset));
    }
    const result = f.cli(name, ["generate", "start", "--task", "Clarify the witness's motivation",
      "--contract", f.contractPath, "--fixture", "--skills-source", source]);
    assert.equal(result.status, "blocked", JSON.stringify(result));
    assert.equal(result.reason, "editorial-unverified", JSON.stringify(result));
    const targeted = result.inventory.items.find((item: any) => item.stage === "focus");
    assert.equal(targeted.status, "verified", JSON.stringify(result.inventory));
    assert.equal(targeted.milestone, id);
    assert.equal(result.inventory.items.filter((item: any) =>
      ["event", "foundations", "interactive", "composition"].includes(item.stage)).length, 0);
    const changed = git(job.worktreeRoot, "diff", "--name-only", canonical, "HEAD")
      .split("\n").filter(Boolean);
    assert.deepEqual(changed, ["story/" + authored[index]], JSON.stringify(result));
    assert.equal(git(f.repo, "rev-parse", "HEAD"), canonical);
    const head = git(job.worktreeRoot, "rev-parse", "HEAD");
    assert.equal(f.cli(name, ["generate", "resume"]).status, "blocked");
    assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), head);
  }
  const combined = f.cli("combined", ["start"]);
  f.contract(["event.disclose-ledger", "character.ada"], "interactive");
  const first = f.cli("combined", ["generate", "start", "--task", "Link the Event and protagonist",
    "--contract", f.contractPath, "--fixture", "--skills-source", source, "--pause-after", "focus"]);
  assert.equal(first.status, "paused");
  assert.equal(first.inventory.items.filter((i: any) => i.stage === "focus" && i.status === "verified").length, 1);
  const continued = f.cli("combined", ["generate", "resume"]);
  assert.equal(continued.reason, "editorial-unverified", JSON.stringify(continued));
  assert.equal(continued.inventory.items.filter((i: any) => i.stage === "focus" && i.status === "verified").length, 2);
  assert.deepEqual(git(combined.worktreeRoot, "diff", "--name-only", canonical, "HEAD").split("\n"),
    ["story/characters/ada.md", "story/events/disclose-ledger.md"]);
  assert.equal(git(combined.worktreeRoot, "rev-list", "--count", canonical + "..HEAD"), "2");
  const afterResume = git(combined.worktreeRoot, "rev-parse", "HEAD");
  f.cli("combined", ["generate", "resume"]);
  assert.equal(git(combined.worktreeRoot, "rev-parse", "HEAD"), afterResume);
});

test("focused revisions reject missing existing target IDs and unauthorized file expansion", {
  skip: !available, timeout: 180_000,
}, () => {
  const f = fixture("reject-expansion");
  f.cli("seed", ["start"]);
  f.contract(["arc.truth", "milestone.disclosure"], "composition", ["protect", "challenge"]);
  f.cli("seed", ["generate", "start", "--task", "Seed a mystery", "--contract", f.contractPath,
    "--fixture", "--skills-source", source]);
  const seed = f.cli("seed", ["generate", "inspect"]);
  git(f.repo, "merge", "--ff-only", seed.report.identity.branch);
  const baseline = git(f.repo, "rev-parse", "HEAD");
  f.cli("missing", ["start"]);
  f.contract(["event.not-present"], "interactive");
  const missing = f.cli("missing", ["generate", "start", "--task", "Revise missing Event",
    "--contract", f.contractPath, "--fixture", "--skills-source", source]);
  assert.equal(missing.status, "blocked");
  assert.match(missing.reason, /scope target|authorized target|architecture/i);
  assert.equal(git(f.repo, "rev-parse", "HEAD"), baseline);
  const related = f.cli("related-support", ["start"]);
  f.contract(["event.disclose-ledger"], "interactive");
  const relatedContract = JSON.parse(readFileSync(f.contractPath, "utf8"));
  relatedContract.scope.supportingTargets = ["character.ada"];
  writeFileSync(f.contractPath, JSON.stringify(relatedContract));
  const relatedResult = f.cli("related-support", ["generate", "start", "--task", "Revise the Event and its protagonist",
    "--contract", f.contractPath, "--fixture", "--skills-source", source]);
  assert.equal(relatedResult.reason, "editorial-unverified", JSON.stringify(relatedResult));
  assert.deepEqual(git(related.worktreeRoot, "diff", "--name-only", baseline, "HEAD").split("\n"),
    ["story/characters/ada.md", "story/events/disclose-ledger.md"]);
  const unrelated = f.cli("unrelated-support", ["start"]);
  relatedContract.scope.supportingTargets = ["authored-content.seal-clue"];
  writeFileSync(f.contractPath, JSON.stringify(relatedContract));
  const unrelatedResult = f.cli("unrelated-support", ["generate", "start", "--task", "Revise only this Event",
    "--contract", f.contractPath, "--fixture", "--skills-source", source]);
  assert.equal(unrelatedResult.status, "blocked");
  assert.match(unrelatedResult.reason, /scope expansion|unrelated|scope context/i);
  assert.equal(git(unrelated.worktreeRoot, "rev-parse", "HEAD"), baseline);
  assert.equal(git(unrelated.worktreeRoot, "status", "--porcelain"), "");
  const job = f.cli("out-of-scope", ["start"]);
  f.contract(["event.disclose-ledger"], "interactive");
  f.env.NT_FOCUS_FIXTURE_CASE = "unauthorized-edit";
  const unauthorized = f.cli("out-of-scope", ["generate", "start", "--task", "Revise this Event",
    "--contract", f.contractPath, "--fixture", "--skills-source", source]);
  assert.equal(unauthorized.status, "blocked");
  assert.match(unauthorized.reason, /unauthorized|dirty|preserv|scope/i);
  assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), baseline,
    "neither the selected nor the unauthorized record may be committed");
  assert.match(git(job.worktreeRoot, "status", "--porcelain"), /M /);
  assert.equal(git(f.repo, "rev-parse", "HEAD"), baseline);
});

test("missing target and missing upstream context block without creating or editing unrelated Story", {
  skip: !available, timeout: 90_000,
}, () => {
  const f = fixture("missing-context");
  const job = f.cli("focus", ["start"]);
  f.contract(["event.unknown"], "interactive");
  const result = f.cli("focus", ["generate", "start", "--task", "Revise one Event",
    "--contract", f.contractPath, "--fixture", "--skills-source", source]);
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /missing verified upstream|upstream Creative Direction/i);
  assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), git(f.repo, "rev-parse", "HEAD"));
  assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "");
});
