import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { removeTestTree } from "./helpers.js";
import { withJobModelRuntime } from "../src/model-runtime.js";
import { requiredOrchestratorSkillReads } from "../src/story-skill-policy.js";
import { boundedPinnedSources } from "../src/bounded-specialist-prompt.js";
import { fixtureSandboxClient, scriptedModel, scriptedReadCalls, scriptedStoryRuntime, scriptedText } from "./c03-scripted-story-helpers.js";
import { createGenerationGraph, parseGenerationContract } from "../src/generation.js";
import { reconcileInventory, nextExecutionItem } from "../src/generation-plan.js";
import { authorizePendingAmendment } from "../src/pending-work-amendments.js";
import { reconcilePendingWork } from "../src/pending-work.js";
import { emptyPendingState, savePendingState, verifyPinnedPendingWork,
  omissionContext } from "../src/pending-work-state.js";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { inspectDependencyPlan, sourceDigest, recordDependency, saveDependencyPlan } from "../src/dependency-state.js";
import { advanceFocusedDependency } from "../src/dependency-work.js";
import { withStoryJobLock } from "../src/job-lock.js";
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
    const scripted = args[0] === "generate" && env.NT_TEST_FOCUSED_CLI === "1";
    const r = spawnSync(process.execPath, ["--import", "tsx", resolve(scripted
      ? "test/support/scripted-focused-cli.ts" : "src/cli.ts"),
      "job", ...args, "--story", story, "--job", job], {
      encoding: "utf8", env, timeout: 240_000, maxBuffer: 32 * 1024 * 1024,
    });
    if (!success) { assert.notEqual(r.status, 0); return r.stderr; }
    assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
  };
  return { repo, story, env, contract, cli, contractPath };
}

/** Canonical author-owned baseline only: no Generation state, fake Review
 * verdicts, or historical specialist receipts are imported. */
function seedArchiveWitness(story: string) {
  cpSync(resolve("test/fixtures/archive-witness"), story, { recursive: true });
  git(story, "add", ".");
  git(story, "commit", "-qm", "Author-provided archive witness Story");
}

// The fork bundle is a fixture at the already-admitted boundary (as in
// plan-continuity-fork.test.ts). The child request, native catalog, controller
// approval and ledger are real; the inherited entry must not become a grant.
test("fork with inherited dependency 8 admits its first new support in the child ledger", {
  skip: !available, timeout: 60_000,
}, async () => {
  const f = fixture("fork-dependency-allowance");
  seedArchiveWitness(f.story);
  const oldState = process.env.NT_STATE_DIR;
  process.env.NT_STATE_DIR = f.env.NT_STATE_DIR;
  try {
    const parent = await startStoryJob({ story: f.story, job: "parent" });
    const { forkDigest, readRecoveryFork } = await import("../src/recovery-fork-state.js");
    const { recordDependency, approveDependency, inspectDependencyPlan, dependencyVersionBase, sourceDigest } =
      await import("../src/dependency-state.js");
    const target = "event.disclose-ledger", path = "events/disclose-ledger.md";
    const ownTarget = "authored-content.disclosure-scene", ownPath = "authored-content/disclosure-scene.md";
    const contract: CompletionContract = { scope: { kind: "partial", depth: "composition",
      targets: [ownTarget], branches: [] }, constraints: [],
      envelope: { presentation: "Visual novel", hardLimits: [], preferences: [] } };
    const inheritedId = "dependency:8:character.ada";
    const bundle = { version: 2, childId: "child", sourceJobId: parent.jobId,
      sourceBaseSha: parent.baseSha, storyRoot: parent.storyRoot,
      toolchain: { graphSchema: "noveltea-generation/v1",
        runtime: { continuationSchema: "noveltea-fork/v2", nodeVersion: process.version },
        validator: { implementation: "native-cli", contract: "noveltea-validator/v1", version: parent.validatorVersion },
        skills: { id: "a".repeat(64) } },
      checkpoint: { commitSha: parent.baseSha, workItem: inheritedId, completedWorkItems: [inheritedId] },
      reviewCoverage: [{ workItem: inheritedId, commitSha: parent.baseSha, status: "passed" }],
      contract, receipts: {}, commits: {}, completedStages: [] };
    const bundleSha256 = forkDigest(bundle);
    const child = await startStoryJob({ story: f.story, job: "child", pinnedBaseSha: parent.baseSha,
      recoveryFork: { sourceJobId: parent.jobId, sourceBaseSha: parent.baseSha,
        commitSha: parent.baseSha, bundleSha256 } });
    writeFileSync(join(child.stateDir, "recovery-fork.json"), JSON.stringify(bundle));
    writeFileSync(join(child.stateDir, "recovery-fork-ready"), bundleSha256 + "\n");
    assert.equal(readRecoveryFork(child)?.checkpoint.completedWorkItems[0], inheritedId);
    assert.equal(dependencyVersionBase(child), 9);
    assert.equal(await inspectDependencyPlan(child), null);
    const native = await validateStoryJob(child, source, { ...child, baseSha: child.baseSha });
    assert.equal(native.status, "passed");
    const catalog = (native.report as { records: CanonicalScopeRecord[] }).records;
    const turn = planObjective({ kind: "revision", request: "Clarify the proof in the disclosure scene", contract,
      base: child.baseSha, sourceJobId: "parent", catalog, targetIds: [ownTarget], allowedPaths: [ownPath] });
    await saveJobTurnPlan(child, turn);
    const bytes = readFileSync(join(child.worktreeStoryRoot, path), "utf8");
    const report = { sourceSha: child.baseSha, turnDigest: turn.digest, assignmentId: "focus:" + ownTarget,
      obligation: turn.objective.obligations[0], missing: "Clarify the Event evidence needed by the disclosure scene",
      affectedIds: [ownTarget, target], sources: [{ path, sha256: sourceDigest(bytes), quote: "id: " + target }],
      likelySpecialist: "nt-event-design", authorDecisionRequired: false };
    const { plan, entry } = await recordDependency(child, report, false);
    assert.equal(plan.version, 9);
    await approveDependency(child, plan, entry, { sourceSha: child.baseSha, reportDigest: entry.reportDigest,
      target, specialist: report.likelySpecialist, outcome: report.missing, reason: "The scene consumes this Event." });
    const reopened = await startStoryJob({ story: f.story, job: "child" }, false);
    const saved = (await inspectDependencyPlan(reopened))!;
    assert.equal(saved.version, 10);
    assert.equal(saved.entries.length, 1);
    assert.equal(saved.entries[0]?.phase, "authorized");
    assert.equal(saved.entries[0]?.amendment?.assignment.id, "dependency:9:" + target);
    assert.deepEqual(saved.entries[0]?.amendment?.assignment.authority.existingPaths, [path]);
    assert.equal(git(child.worktreeRoot, "rev-parse", "HEAD"), child.baseSha);
    assert.equal(await inspectDependencyPlan(parent), null);
    assert.equal(readRecoveryFork(reopened)?.checkpoint.completedWorkItems[0], inheritedId);
  } finally {
    if (oldState === undefined) delete process.env.NT_STATE_DIR; else process.env.NT_STATE_DIR = oldState;
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
  seedArchiveWitness(f.story);
  Object.assign(f.env, { NT_TEST_FOCUSED_CLI: "1", NT_TEST_SCRIPTED_MODEL_LOG: f.contractPath + ".model-calls" });
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
    const log = f.contractPath + "." + name + ".model-calls";
    Object.assign(f.env, { NT_TEST_SCRIPTED_MODEL_LOG: log });
    const job = f.cli(name, ["start"]);
    f.contract([id as string], depth as string, branches as string[]);
    if (index === 1) {
      const preset = JSON.parse(readFileSync(f.contractPath, "utf8"));
      delete preset.scope.depth;
      preset.scope.preset = "architecture-outline";
      writeFileSync(f.contractPath, JSON.stringify(preset));
    }
    const result = f.cli(name, ["generate", "start", "--task", "Clarify the witness's motivation",
      "--contract", f.contractPath, "--provider", scriptedModel.provider, "--model", scriptedModel.id, "--skills-source", source]);
    assert.equal(result.status, "completed", result.reason + "\n" + readFileSync(log, "utf8"));
    assert.equal(result.request.fixture, false);
    assert.match(result.request.turnPlanDigest, /^[a-f0-9]{64}$/);
    const calls = readFileSync(log, "utf8");
    assert.equal(calls.trim().split("\n").map(line => JSON.parse(line)).filter(call => call.kind === "writer").length, 3);
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
    assert.equal(f.cli(name, ["generate", "resume"]).status, "completed");
    assert.equal(readFileSync(log, "utf8"), calls, "Completed restart must not call planner, writer or reviewer");
    assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), head);
  }
  const combined = f.cli("combined", ["start"]);
  const combinedLog = f.contractPath + ".combined.model-calls";
  Object.assign(f.env, { NT_TEST_SCRIPTED_MODEL_LOG: combinedLog });
  f.contract(["event.disclose-ledger", "character.ada"], "interactive");
  const first = f.cli("combined", ["generate", "start", "--task", "Link the Event and protagonist",
    "--contract", f.contractPath, "--provider", scriptedModel.provider, "--model", scriptedModel.id, "--skills-source", source, "--pause-after", "focus"]);
  assert.equal(first.status, "paused");
  assert.equal(first.inventory.items.filter((i: any) => i.stage === "focus" && i.status === "verified").length, 1);
  const continued = f.cli("combined", ["generate", "resume"]);
  assert.equal(continued.status, "completed", JSON.stringify(continued));
  assert.equal(continued.inventory.items.filter((i: any) => i.stage === "focus" && i.status === "verified").length, 2);
  assert.deepEqual(git(combined.worktreeRoot, "diff", "--name-only", canonical, "HEAD").split("\n"),
    ["story/characters/ada.md", "story/events/disclose-ledger.md"]);
  assert.equal(git(combined.worktreeRoot, "rev-list", "--count", canonical + "..HEAD"), "2");
  const afterResume = git(combined.worktreeRoot, "rev-parse", "HEAD");
  const calls = readFileSync(combinedLog, "utf8");
  const invocations = calls.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(invocations.filter(call => call.kind === "planner").length, 2);
  assert.equal(invocations.filter(call => call.kind === "writer").length, 6);
  assert.equal(invocations.filter(call => call.kind === "writer" && call.command === "resume").length, 3);
  assert.equal(f.cli("combined", ["generate", "resume"]).status, "completed");
  assert.equal(readFileSync(combinedLog, "utf8"), calls);
  assert.equal(git(combined.worktreeRoot, "rev-parse", "HEAD"), afterResume);
});

test("R07 focused commit before checkpoint finalization resumes without replay", {
  skip: !available, timeout: 120_000,
}, () => {
  const f = fixture("r07-focus-crash");
  seedArchiveWitness(f.story);
  const log = f.contractPath + ".model-calls";
  Object.assign(f.env, { NT_TEST_FOCUSED_CLI: "1", NT_TEST_SCRIPTED_MODEL_LOG: log });
  const job = f.cli("focused", ["start"]);
  f.contract(["character.ada"], "architecture");
  const env = f.env as NodeJS.ProcessEnv;
  env.NT_TEST_FOCUS_CRASH_AFTER_INTENT = "1";
  f.cli("focused", ["generate", "start", "--task", "Clarify Ada's motivation",
    "--contract", f.contractPath, "--provider", scriptedModel.provider, "--model", scriptedModel.id, "--skills-source", source, "--pause-after", "focus"], false);
  assert.match(readFileSync(log, "utf8"), /Injected post-intent publication interruption/);
  const head = git(job.worktreeRoot, "rev-parse", "HEAD");
  delete env.NT_TEST_FOCUS_CRASH_AFTER_INTENT;
  const resumed = f.cli("focused", ["generate", "resume"]);
  assert.ok(["paused", "completed"].includes(resumed.status), JSON.stringify({reason:resumed.reason,lifecycle:resumed.recoveryLifecycle,operation:resumed.operationRecovery, sources:resumed.recoverySources}) + "\n" + readFileSync(log, "utf8"));
  const calls = readFileSync(log, "utf8").trim().split("\n").filter(l => l.startsWith("{")).map(l => JSON.parse(l));
  assert.equal(calls.filter(c => c.kind === "writer").length, 3, "Original writer cannot replay after durable intent");
  assert.equal(resumed.inventory.items.find((i: any) => i.id === "focus:character.ada")?.status, "verified");
  assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), head);
  assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "");
  assert.ok(resumed.recoveryCheckpoints.some((p: any) =>
    p.workItem === "focus:character.ada" && p.commitSha === head && p.eligible));
});

test("focused revisions reject missing existing target IDs and unauthorized file expansion", {
  skip: !available, timeout: 180_000,
}, () => {
  const f = fixture("reject-expansion");
  seedArchiveWitness(f.story);
  const log = f.contractPath + ".model-calls";
  Object.assign(f.env, { NT_TEST_FOCUSED_CLI: "1", NT_TEST_SCRIPTED_MODEL_LOG: log });
  const baseline = git(f.repo, "rev-parse", "HEAD");
  f.cli("missing", ["start"]);
  f.contract(["event.not-present"], "interactive");
  const missing = f.cli("missing", ["generate", "start", "--task", "Revise missing Event",
    "--contract", f.contractPath, "--provider", scriptedModel.provider, "--model", scriptedModel.id, "--skills-source", source], false);
  assert.match(missing, /scope target|authorized target|architecture/i);
  assert.equal(existsSync(log), false);
  assert.equal(git(f.repo, "rev-parse", "HEAD"), baseline);
  const related = f.cli("related-support", ["start"]);
  f.contract(["event.disclose-ledger"], "interactive");
  const relatedContract = JSON.parse(readFileSync(f.contractPath, "utf8"));
  relatedContract.scope.supportingTargets = ["character.ada"];
  writeFileSync(f.contractPath, JSON.stringify(relatedContract));
  const relatedResult = f.cli("related-support", ["generate", "start", "--task", "Revise the Event and its protagonist",
    "--contract", f.contractPath, "--provider", scriptedModel.provider, "--model", scriptedModel.id, "--skills-source", source]);
  assert.equal(relatedResult.status, "completed", relatedResult.reason + "\n" + readFileSync(log, "utf8"));
  assert.deepEqual(git(related.worktreeRoot, "diff", "--name-only", baseline, "HEAD").split("\n"),
    ["story/characters/ada.md", "story/events/disclose-ledger.md"]);
  const previousCalls = readFileSync(log, "utf8");
  const unrelated = f.cli("unrelated-support", ["start"]);
  relatedContract.scope.supportingTargets = ["authored-content.seal-clue"];
  writeFileSync(f.contractPath, JSON.stringify(relatedContract));
  const unrelatedResult = f.cli("unrelated-support", ["generate", "start", "--task", "Revise only this Event",
    "--contract", f.contractPath, "--provider", scriptedModel.provider, "--model", scriptedModel.id, "--skills-source", source], false);
  assert.match(unrelatedResult, /scope expansion|unrelated|scope context/i);
  assert.equal(readFileSync(log, "utf8"), previousCalls);
  assert.equal(git(unrelated.worktreeRoot, "rev-parse", "HEAD"), baseline);
  assert.equal(git(unrelated.worktreeRoot, "status", "--porcelain"), "");
  const job = f.cli("out-of-scope", ["start"]);
  f.contract(["event.disclose-ledger"], "interactive");
  f.env.NT_TEST_FOCUS_EXTERNAL_DRIFT = "1";
  const unauthorized = f.cli("out-of-scope", ["generate", "start", "--task", "Revise this Event",
    "--contract", f.contractPath, "--provider", scriptedModel.provider, "--model", scriptedModel.id, "--skills-source", source]);
  assert.equal(unauthorized.status, "blocked");
  assert.match(unauthorized.reason, /unauthorized|dirty|preserv|scope/i);
  assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), baseline,
    "neither the selected nor the unauthorized record may be committed");
  assert.match(git(job.worktreeRoot, "status", "--porcelain"), /M /);
  assert.equal(git(f.repo, "rev-parse", "HEAD"), baseline);
});

for (const scenario of ["review", "writer", "support-no-write", "nested", "writer-native-diagnosis", "review-native-diagnosis", "writer-review-assessment", "review-review-assessment"] as const)
test("R04 cross-owner prerequisite " + scenario + " uses the original logical assignment", {
  skip: !available, timeout: 300_000,
}, async () => {
  const f = fixture("r04-prerequisite-" + scenario);
  const nativeDiagnosis = scenario.endsWith("-native-diagnosis");
  const reviewAssessment = scenario.endsWith("-review-assessment");
  const recoveringSupport = nativeDiagnosis || reviewAssessment;
  const writer = scenario === "writer" || scenario === "nested" || scenario === "writer-native-diagnosis" || scenario === "writer-review-assessment";
  const nested = scenario === "nested";
  seedArchiveWitness(f.story);
  f.contract(["arc.truth", "milestone.disclosure"], "composition", ["protect", "challenge"]);
  const oldState = process.env.NT_STATE_DIR, oldCache = process.env.NT_SKILL_CACHE_DIR;
  process.env.NT_STATE_DIR = f.env.NT_STATE_DIR;
  process.env.NT_SKILL_CACHE_DIR = f.env.NT_SKILL_CACHE_DIR;
  try {
    const job = await startStoryJob({ story: f.story, job: "r04-review" });
    const native = await validateStoryJob(job, source, { ...job, baseSha: job.baseSha });
    const catalog = (native.report as { records: CanonicalScopeRecord[] }).records;
    const event = "event.disclose-ledger", character = "character.ada";
    const eventPath = "events/disclose-ledger.md", characterPath = "characters/ada.md";
    const targets = writer ? [event] : [character, event];
    const contract: CompletionContract = { scope: { kind: "partial", depth: "interactive",
      targets, branches: [] }, constraints: [],
      envelope: { presentation: "Visual novel", hardLimits: [], preferences: [] } };
    const task = "Clarify Ada's reason to disclose the ledger in her profile and the Event.";
    const turn = planObjective({ kind: "revision", request: task, contract, base: job.baseSha,
      sourceJobId: "seed", catalog, targetIds: targets,
      allowedPaths: writer ? [eventPath] : [characterPath, eventPath] });
    await saveJobTurnPlan(job, turn);
    const correction = "Explain in Ada's Character profile why she discloses the ledger.";
    const fact = "fact.evidence-concealed", factPath = "facts/evidence-concealed.md";
    const factCorrection = "Clarify the source evidence of the concealment in the World Fact.";
    let nestedYield = false, factWrites = 0;
    let nestedOrigin: { phase: string; piSessionId: string; piSessionFile: string; assignmentKey: string } | undefined;
    const restore = fixtureSandboxClient(job.jobId, job.worktreeStoryRoot);
    let saver = SqliteSaver.fromConnString(join(job.stateDir, "generation.sqlite"));
    let originalNegative = false, repairYield = false, supportWrites = 0, originalReviews = 0;
    let writerYield = false, originalWrites = 0, localCorrections = 0;
    let supportQuestion = false;
    let cleanSupport = "";
    let diagnosticCalls = 0;
    let supportRepairs = 0;
    let supportReviews = 0;
    const supportEvidence = "Ada discloses the ledger to protect the witness from a false accusation.";
    let lastPrompt = "", step = 0;
    try {
      const { runtime, calls } = await scriptedStoryRuntime((index, context) => {
        const messages = context.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> | string }>;
        const prompt = messages.filter(m => m.role === "user").flatMap(m =>
          typeof m.content === "string" ? [m.content] : m.content.map(c => c.text ?? "")).at(-1) ?? "";
        if (prompt !== lastPrompt) { lastPrompt = prompt; step = 0; }
        const phase = step++;
        const read = (paths: string[]) => ({ content: scriptedReadCalls(paths, index), reason: "toolUse" as const });
        const stop = (value: unknown) => ({ content: scriptedText(value), reason: "stop" as const });
        if (index === 0) return read(requiredOrchestratorSkillReads(turn.creativePolicy?.mode ?? "autonomous").map(p => "skill://" + p));
        if (index === 1) return stop({ sourceSha: job.baseSha, turnDigest: turn.digest,
          assignments: turn.assignments.map(a => ({ id: a.id, reason: "Perform the authorized linked revision." })) });
        if (prompt.includes("READ-ONLY dependency orchestrator")) {
          const factRequest = nested && prompt.includes(factCorrection);
          if (!phase) return read(["nt-story-orchestrate/SKILL.md", "nt-story-orchestrate/references/planning.md",
            "nt-catalog/SKILL.md", "nt-catalog/references/records.md", "nt-catalog/references/authority-and-validation.md"]
            .map(p => "skill://" + p).concat(factRequest ? factPath : characterPath));
          if (factRequest) return stop({ target: fact, specialist: "nt-worldbuilding", outcome: factCorrection,
            reason: "Ada's typed initial knowledge identifies this canonical Fact." });
          return stop({ target: character, specialist: "nt-character-development", outcome: correction,
            reason: "The sealed Event finding identifies Ada's missing motivation in her owned Character record." });
        }
        if (reviewAssessment && prompt.includes("INDEPENDENT POSTCOMMIT DIAGNOSTIC")) {
          if (!phase) return read(boundedPinnedSources("nt-narrative-review").map(p => "skill://" + p));
          const sourceDigest = prompt.match(/sourceDigest: ([a-f0-9]{64});/)?.[1];
          const packet = JSON.parse(prompt.split("IMMUTABLE SOURCE AND REQUIREMENTS: ")[1]!.split("\nORIGINAL ASSIGNMENT OUTCOME:")[0]!);
          assert.ok(sourceDigest);
          diagnosticCalls++;
          return stop({ schema: "noveltea-postcommit-diagnosis/v1", sourceDigest, action: "continue",
            explanation: "The original motivation obligation remains unresolved.",
            assessments: [{ kind: "cosmetic", reason: "The revisions do not establish the motivation.",
              requirement: { quote: packet.items[0].assignment.outcome.slice(0, 60) },
              evidence: { path: characterPath, quote: "Ada wears a blue coat." } }] });
        }
        if (reviewAssessment && prompt.includes("SOURCE-LINKED REVIEW FEEDBACK") &&
            prompt.includes("AUTHORIZED FILES: " + characterPath)) {
          if (phase === 0) {
            supportRepairs++;
            const old = readFileSync(join(job.worktreeStoryRoot, characterPath), "utf8");
            const next = cleanSupport + "\n" + (supportRepairs === 1 ? "Ada wears a dark coat." :
              supportRepairs === 2 ? "Ada wears a blue coat." : supportEvidence) + "\n";
            return { reason: "toolUse", content: [{ type: "toolCall", id: "r04-support-review-repair-" + index, name: "edit",
              arguments: { path: characterPath, edits: [{ oldText: old, newText: next }] } }] };
          }
          return stop("Revised the supporting Character profile.");
        }
        if (prompt.includes("IMMUTABLE REVIEW PACKET")) {
          if (!phase) return read(boundedPinnedSources("nt-narrative-review").map(p => "skill://" + p));
          const packet = JSON.parse(prompt.split("\nIMMUTABLE REVIEW PACKET\n")[1]!);
          const item = packet.items[0];
          const path = item.assurance.changedPaths[0];
          if (reviewAssessment && item.assignment.id.startsWith("dependency:") && path === characterPath) {
            supportReviews++;
            const pass = supportRepairs === 3;
            const ref = { commitSha: item.assurance.commitSha, assignmentId: item.assignment.id, path, line: 1 };
            return stop({ sourceDigest: packet.sourceDigest, verdict: pass ? "pass" : "fail",
              findings: pass ? [] : [{ ...ref, kind: "continuity", message: "Ada's motivation remains unsupported.",
                requiredCorrection: correction, affectedPaths: [characterPath] }],
              evidence: pass ? [{ ...ref, explanation: "The source establishes the required motivation." }] : [],
              ...(supportRepairs ? { progressDiagnosis: pass ? { status: "material",
                reason: "The motivation is established.", evidence: { path, quote: supportEvidence, change: "added" } } :
                { status: "stalled", reason: "A cosmetic change cannot establish motivation.", evidence: null } } : {}) });
          }
          const fail = !writer && path === eventPath && !originalNegative;
          if (fail) originalNegative = true;
          return stop({ sourceDigest: packet.sourceDigest, verdict: fail ? "fail" : "pass",
            findings: fail ? [{ commitSha: item.assurance.commitSha, assignmentId: item.assignment.id,
              path, line: 1, kind: "continuity", message: "Ada's motivation lacks source support.",
              requiredCorrection: correction, affectedPaths: [eventPath, characterPath] }] : [],
            evidence: fail ? [] : [{ commitSha: item.assurance.commitSha, assignmentId: item.assignment.id,
              path, line: 1, explanation: "The scoped canonical change fulfills the assignment." }] });
        }
        if (prompt.includes("You are the independent nt-narrative-review editor")) {
          const assignment = JSON.parse(prompt.split("\nASSIGNMENT:\n")[1]!);
          if (!phase) return read(prompt.split("PINNED REFERENCES:\n")[1]!.split("\nSTORY PATHS:")[0]!
            .split("\n").filter(p => p.startsWith("skill://")).concat(assignment.paths));
          if (prompt.includes("POST-DEPENDENCY REASSESSMENT")) originalReviews++;
          return stop({ verdict: "pass", findings: [],
            evidence: assignment.paths.map((p: string) => p + ":1: The current canonical source establishes the required motivation.") });
        }
        if (prompt.includes("OUT_OF_AUTHORITY:") && !prompt.includes("revision specialist. FIRST")) {
          repairYield = true;
          return stop("OUT_OF_AUTHORITY: " + characterPath);
        }
        if (nativeDiagnosis && cleanSupport && !prompt.includes("IMMUTABLE REVIEW PACKET")) {
          if (prompt.includes("local-repair: owner=dependency:")) {
            const raw = JSON.stringify(context.messages);
            const signature = raw.match(/signature=([a-f0-9]{64})/)?.[1];
            const sourceRef = raw.match(/sourceRef=([^;]+); category=/)?.[1];
            const owner = raw.match(/local-repair: owner=(dependency:[0-9]+:character\.ada)/)?.[1];
            assert.ok(signature && sourceRef && owner);
            diagnosticCalls++;
            return stop({ schema: "noveltea-recovery-diagnostic-proposal/v1", signature, sourceRef,
              category: "defect", diagnosis: "Remove the invalid metadata field without broadening the original scope.",
              strategy: "local-repair", owner, scopeRef: sourceRef, prerequisites: [],
              uncertainty: "Require native validation and independent Review." });
          }
          if (prompt.includes("INDEPENDENT DIAGNOSTIC FOLLOW-UP") &&
              readFileSync(join(job.worktreeStoryRoot, characterPath), "utf8").includes("unsupported_field:"))
            return { reason: "toolUse", content: [{ type: "toolCall", id: "r04-diagnosed-support", name: "edit",
              arguments: { path: characterPath, edits: [{ oldText: readFileSync(join(job.worktreeStoryRoot, characterPath), "utf8"), newText: cleanSupport }] } }] };
          if (prompt.includes("SOURCE-BOUND STORY CORRECTION") && !prompt.includes("focused-manifest-path-mismatch"))
            return stop({ modifiedRecords: [characterPath], architecturalConflicts: [], laterObligations: [] });
        }
        if (prompt.includes("SOURCE-BOUND STORY CORRECTION") &&
            prompt.includes("focused-manifest-path-mismatch")) {
          localCorrections++;
          return stop({ modifiedRecords: [eventPath], architecturalConflicts: [], laterObligations: [] });
        }
        if (prompt.includes("revision specialist. FIRST")) {
          const path = prompt.includes("Only edit these PREEXISTING canonical Markdown files:\n" + eventPath) ? eventPath :
            prompt.includes("Only edit these PREEXISTING canonical Markdown files:\n" + factPath) ? factPath : characterPath;
          const support = prompt.includes("THIS IS A SEPARATELY AUTHORIZED SUPPORTING ASSIGNMENT");
          const skill = path === eventPath ? "nt-event-design" : path === factPath ? "nt-worldbuilding" : "nt-character-development";
          if (!phase) return read([skill + "/SKILL.md", "nt-catalog/SKILL.md", "nt-catalog/references/records.md",
            ...(path === eventPath ? ["nt-catalog/references/progression.md"] : [])].map(p => "skill://" + p));
          if (phase === 1) {
            if (scenario === "support-no-write" && support) return stop({ modifiedRecords: [], architecturalConflicts: [], laterObligations: [] });
            if (nested && support && path === characterPath && !nestedYield) {
              nestedYield = true;
              return { reason: "toolUse", content: [{ type: "toolCall", id: "r04-nested-prerequisite", name: "report_dependency",
                arguments: { obligationIndex: 0, missing: factCorrection, affectedIds: [character, fact],
                  sources: [{ path: factPath, quote: "id: fact.evidence-concealed" }],
                  likelySpecialist: "nt-worldbuilding", authorDecisionRequired: false } }] };
            }
            if (support && !supportQuestion && !recoveringSupport && (!nested || path === factPath)) {
              supportQuestion = true;
              return stop({ modifiedRecords: [], architecturalConflicts: [], laterObligations: [],
                authorDecisionRequest: { kind: "free-text", question: "Which motive should Ada disclose to protect the witness?" } });
            }
            if (writer && !support && !writerYield) {
              writerYield = true;
              return { reason: "toolUse", content: [{ type: "toolCall", id: "r04-prerequisite", name: "report_dependency",
                arguments: { obligationIndex: 0, missing: correction, affectedIds: [event, character],
                  sources: [{ path: characterPath, quote: "id: character.ada" }],
                  likelySpecialist: "nt-character-development", authorDecisionRequired: false } }] };
            }
            if (path === factPath) factWrites++;
            else if (support) supportWrites++; else if (path === eventPath) originalWrites++;
            const old = readFileSync(join(job.worktreeStoryRoot, path), "utf8");
            const content = old + "\n" +
                (path === factPath ? "The concealment is evidenced by the archived transfer record." : support ? "Ada discloses the ledger to protect the witness from a false accusation." :
                  "Ada hesitates before giving the witness her account of the ledger.") + "\n";
            if (recoveringSupport && support) cleanSupport = reviewAssessment ? old : content;
            return { reason: "toolUse", content: [{ type: "toolCall", id: "r04-edit-" + index, name: "edit",
              arguments: { path, edits: [{ oldText: old, newText: reviewAssessment && support ? old + "\nAda wears a grey coat.\n" : nativeDiagnosis && support
                ? content.replace("id: " + character, "id: " + character + "\nunsupported_field: true") : content }] } }] };
          }
          if (nested && support && path === characterPath && supportWrites === 0) return stop({ modifiedRecords: [], architecturalConflicts: [], laterObligations: [] });
          return stop({ modifiedRecords: writer && writerYield && !support ? [] : [path], architecturalConflicts: [], laterObligations: [] });
        }
        throw Error("Unexpected R04 model prompt: " + prompt.slice(0, 1000));
      });
      const config = { configurable: { thread_id: job.threadId + ":generation" }, recursionLimit: 100 };
      const invoke = (input: Parameters<ReturnType<typeof createGenerationGraph>["invoke"]>[0],
        options: typeof config & { interruptBefore?: string[]; interruptAfter?: string[] }) =>
        withJobModelRuntime(runtime, () => createGenerationGraph(saver, "cli").invoke(input, options));
      const initialRequest = { request: { story: f.story, job: job.jobId, task, contract,
        fixture: false, skillsSource: source, turnPlanDigest: turn.digest, provider: scriptedModel.provider,
        model: scriptedModel.id }, pauseAfter: null };
      type Input = Parameters<ReturnType<typeof createGenerationGraph>["invoke"]>[0];
      async function crashAt(input: Input, boundary: string, match: (namespace: string, writes: Array<[string, unknown]>) => boolean,
        options: { interruptBefore?: string[]; interruptAfter?: string[] }) {
        const abort = new AbortController();
        const error = Error("R14D injected SQLite loss after " + boundary);
        const put = saver.put.bind(saver);
        const putWrites = saver.putWrites.bind(saver);
        let crashed = false;
        saver.put = async (...args) => {
          if (crashed) throw error;
          return put(...args);
        };
        saver.putWrites = async (cfg, writes, task) => {
          if (crashed) throw error;
          if (match(String(cfg.configurable?.checkpoint_ns ?? ""), writes)) {
            crashed = true;
            abort.abort(error);
            throw error;
          }
          return putWrites(cfg, writes, task);
        };
        await assert.rejects(withJobModelRuntime(runtime, async () => {
          const result = await createGenerationGraph(saver, "cli").invoke(input, {
            ...config, ...options, signal: abort.signal, durability: "sync",
          });
          throw Error("Missing intended crash: " + JSON.stringify({ reason: result.reason, status: result.status, factWrites, supportWrites, recoverySources: result.recoverySources }));
        }), err => { if (!crashed) throw err; return true; });
        assert.ok(crashed, "Expected actual SQLite output loss: " + boundary);
        assert.equal(existsSync(join(job.stateDir, ".story-job")), false);
        saver.db.close();
        saver = SqliteSaver.fromConnString(join(job.stateDir, "generation.sqlite"));
      }
      if (writer) {
        await crashAt(initialRequest, "returned no-write child outcome", (ns, writes) =>
          !ns && writes.some(([channel, value]) => channel === "focusedPrerequisite" &&
            !!value && (value as { supportRef?: string }).supportRef === null),
        { interruptBefore: ["dependency_amendment"] });
      }
      const suspended = await invoke(writer ? null : initialRequest,
        { ...config, interruptBefore: ["dependency_amendment"] });
      const pin = writer ? suspended.focusedPrerequisite : suspended.reviewPrerequisite;
      assert.ok(pin, JSON.stringify({ reason: suspended.reason, status: suspended.status }));
      assert.equal(pin.suspension.pendingPhase, writer ? "writer" : "review");
      assert.equal(pin.suspension.owner, "nt-character-development");
      assert.equal(originalNegative, !writer);
      assert.equal(repairYield, !writer);
      const originalHead = git(job.worktreeRoot, "rev-parse", "HEAD");
      const receiptPath = join(job.stateDir, "focused-items", event + ".json");
      const originalReceipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      let supportInput: Parameters<ReturnType<typeof createGenerationGraph>["invoke"]>[0] = null;
      if (scenario !== "support-no-write" && !recoveringSupport) {
        const { pendingGenerationQuestion, generationQuestionResume } = await import("../src/generation-author-question.js");
        const { answerSpecialistChoice, focusedChoiceWorkItem } = await import("../src/specialist-choice.js");
        await invoke(null, { ...config, interruptAfter: ["dependency_amendment"] });
        const graph = createGenerationGraph(saver, "cli");
        const snapshot = await graph.getState(config);
        const pending = await pendingGenerationQuestion(job, saver, snapshot, config.configurable.thread_id, "user:cli");
        assert.ok(pending, JSON.stringify({ reason: snapshot.values.reason, supportQuestion }));
        const entry = (await inspectDependencyPlan(job))!.entries.at(-1)!;
        const questionTarget = nested ? fact : character;
        assert.equal(pending.choice.assignment?.identity.assignmentId, entry.amendment!.assignment.id);
        assert.equal(pending.choice.workItem, focusedChoiceWorkItem(questionTarget, entry.amendment!.assignment.id));
        assert.notEqual(pending.choice.workItem, focusedChoiceWorkItem(questionTarget));
        assert.equal(supportWrites, 0);
        assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), originalHead);
        await assert.rejects(pendingGenerationQuestion(job, saver, {
          ...snapshot, values: { ...snapshot.values, planVersion: 999 },
        }, config.configurable.thread_id, "user:cli"), /original assignment|dependency admission/);
        if (nested) {
          await assert.rejects(pendingGenerationQuestion(job, saver, {
            ...snapshot, values: { ...snapshot.values, focusedPrerequisite: null },
          }, config.configurable.thread_id, "user:cli"), /dependency admission/);
        }
        const session = pending.choice.sessionId;
        await answerSpecialistChoice(job, pending.choice.id, pending.choice.proposalSha256,
          { kind: "custom", text: "Protect the witness from false accusation.", note: "" }, "user:cli");
        saver.db.close();
        saver = SqliteSaver.fromConnString(join(job.stateDir, "generation.sqlite"));
        const reopened = await pendingGenerationQuestion(job, saver,
          await createGenerationGraph(saver, "cli").getState(config), config.configurable.thread_id, "user:cli");
        assert.ok(reopened);
        assert.equal(reopened.choice.sessionId, session);
        supportInput = generationQuestionResume(reopened);
      }
      if (nested) {
        await crashAt(supportInput, "nested support commit before parent support reentry", (ns, writes) =>
          ns.includes("assignment-") && writes.some(([channel, value]) => channel === "submission" &&
            (value as { status?: string; receiptRef?: string } | undefined)?.status === "focused-committed" &&
            (value as { receiptRef?: string }).receiptRef?.endsWith(fact) === true),
          { interruptAfter: ["dependency_amendment"] });
        const ledger = (await inspectDependencyPlan(job))!;
        assert.equal(ledger.entries.length, 2);
        assert.equal(ledger.entries[1]!.parent?.reportDigest, ledger.entries[0]!.reportDigest);
        nestedOrigin = JSON.parse(readFileSync(join(job.stateDir, "dependency-items",
          ledger.entries[0]!.amendment!.assignment.id + ".json"), "utf8"));
        assert.equal(nestedOrigin.phase, "waiting-dependency");
        assert.equal(factWrites, 1);
        assert.equal(supportWrites, 0);
        assert.equal(originalWrites, 0);
      } else if (writer && !recoveringSupport) {
        await crashAt(supportInput, "support commit before original child reentry", (ns, writes) =>
          ns.includes("assignment-") && writes.some(([channel, value]) => channel === "submission" &&
            (value as { status?: string; receiptRef?: string } | undefined)?.status === "focused-committed" &&
            (value as { receiptRef?: string }).receiptRef?.startsWith("dependency:") === true),
        { interruptAfter: ["dependency_amendment"] });
        assert.equal(supportWrites, 1);
        assert.equal(originalWrites, 0);
        assert.equal(git(job.worktreeRoot, "rev-list", "--count", originalHead + "..HEAD"), "1");
      }
      let supported = await invoke(writer ? null : supportInput, { ...config, interruptAfter: ["dependency_amendment"] });
      if (reviewAssessment) {
        const c = supported.recoveryLifecycle.active;
        assert.ok(c, JSON.stringify({reason: supported.reason, lifecycle: supported.recoveryLifecycle}));
        if (!writer) assert.equal(c.id, suspended.recoveryLifecycle.active?.id);
        if (supported.recoveryLifecycle.decision?.action !== "plan-amendment")
          supported = await invoke(null, { ...config, interruptAfter: ["assess_recovery"] });
        assert.equal(supported.recoveryLifecycle.decision?.action, "plan-amendment", JSON.stringify(supported.recoveryLifecycle));
        assert.equal(supported.recoveryLifecycle.decision?.supportReview?.assessment.kind, "diagnostic");
        assert.equal(supportRepairs, 2);
        assert.equal(diagnosticCalls, 0);
        const { inspectModernGenerationRecovery } = await import("../src/generation-recovery-inspection.js");
        assert.deepEqual(await inspectModernGenerationRecovery(job, saver, config.configurable.thread_id), supported.recoveryLifecycle);
        saver.db.close(); saver = SqliteSaver.fromConnString(join(job.stateDir, "generation.sqlite"));
        const assessed = await invoke(null, { ...config, interruptAfter: ["assess_recovery"] });
        assert.equal(assessed.recoveryLifecycle.active?.id, c.id);
        assert.equal(diagnosticCalls, 1);
        supported = await invoke(null, { ...config, interruptAfter: ["assess_recovery"] });
        assert.equal(supportRepairs, 3, JSON.stringify({reason: supported.reason, lifecycle: supported.recoveryLifecycle}));
        assert.equal(supportReviews, 4);
        if (writer) assert.ok(supported.recoveryLifecycle.discharged.some(d => d.case.id === c.id), JSON.stringify(supported.recoveryLifecycle));
        else assert.equal(supported.recoveryLifecycle.active?.id, c.id);
        assert.deepEqual(await inspectModernGenerationRecovery(job, saver, config.configurable.thread_id), supported.recoveryLifecycle);
        const entry = (await inspectDependencyPlan(job))!.entries[0]!;
        assert.equal(entry.review?.verdict, "pass");
        assert.equal((await inspectRecoveryCheckpoints(job)).find(p => p.commitSha === entry.supportRootSha)?.semanticReview, "failed");
      }
      if (nativeDiagnosis) {
        const c = supported.recoveryLifecycle.active;
        assert.ok(c, JSON.stringify({ reason: supported.reason, lifecycle: supported.recoveryLifecycle }));
        if (!writer) assert.equal(c.id, suspended.recoveryLifecycle.active?.id);
        if (supported.recoveryLifecycle.decision?.action !== "diagnostic")
          supported = await invoke(null, { ...config, interruptAfter: ["assess_recovery"] });
        assert.equal(supported.recoveryLifecycle.decision?.action, "diagnostic", JSON.stringify(supported.recoveryLifecycle));
        const diagnosed = await invoke(null, { ...config, interruptAfter: ["assess_recovery"] });
        assert.equal(diagnosed.recoveryLifecycle.decision?.action, "plan-amendment", JSON.stringify(diagnosed.recoveryLifecycle));
        assert.equal(diagnosed.recoveryLifecycle.active?.id, c.id);
        assert.equal(diagnosticCalls, 1);
        const { inspectModernGenerationRecovery } = await import("../src/generation-recovery-inspection.js");
        assert.deepEqual(await inspectModernGenerationRecovery(job, saver, config.configurable.thread_id), diagnosed.recoveryLifecycle);
        saver.db.close(); saver = SqliteSaver.fromConnString(join(job.stateDir, "generation.sqlite"));
        supported = await invoke(null, { ...config, interruptAfter: ["assess_recovery"] });
        if (writer) assert.ok(supported.recoveryLifecycle.discharged.some(d => d.case.id === c.id),
          JSON.stringify({reason: supported.reason, lifecycle: supported.recoveryLifecycle}));
        else assert.equal(supported.recoveryLifecycle.active?.id, c.id);
        assert.deepEqual(await inspectModernGenerationRecovery(job, saver, config.configurable.thread_id), supported.recoveryLifecycle);
      }
      if (scenario === "support-no-write") {
        assert.equal(supportWrites, 0);
        assert.equal(originalReviews, 0);
        assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), originalHead);
        assert.ok(supported.reviewPrerequisite);
        assert.equal(supported.reviewPrerequisite.supportRef, null);
        assert.notEqual((await inspectDependencyPlan(job))!.entries[0]!.phase, "verified");
        const before = calls();
        const stopped = await invoke(null, config);
        assert.equal(stopped.status, "blocked", stopped.reason ?? "");
        assert.equal(calls(), before);
        return;
      }
      const supportPin = writer ? supported.focusedPrerequisite : supported.reviewPrerequisite;
      assert.ok(supportPin?.supportRef, JSON.stringify({ reason: supported.reason, status: supported.status }));
      assert.deepEqual(supportPin.identity, pin.identity);
      if (nested) {
        const ledger = (await inspectDependencyPlan(job))!;
        assert.equal(ledger.entries.length, 2);
        assert.ok(ledger.entries.every(e => e.phase === "verified"));
        assert.deepEqual(supported.dependencyHistory.map(p => p.reportDigest).sort(),
          ledger.entries.map(e => e.reportDigest).sort(), "Parent must pin every nested supporting receipt");
        assert.equal(factWrites, 1);
        const resumed = JSON.parse(readFileSync(join(job.stateDir, "dependency-items",
          ledger.entries[0]!.amendment!.assignment.id + ".json"), "utf8"));
        assert.equal(resumed.piSessionId, nestedOrigin!.piSessionId);
        assert.equal(resumed.piSessionFile, nestedOrigin!.piSessionFile);
        assert.equal(resumed.assignmentKey, nestedOrigin!.assignmentKey);
        assert.equal(resumed.expectedHead, ledger.entries[1]!.commitSha);
        assert.equal(git(job.worktreeRoot, "rev-parse", ledger.entries[0]!.commitSha! + "^"), ledger.entries[1]!.commitSha);
        assert.equal(git(job.worktreeRoot, "rev-list", "--count", originalHead + "..HEAD"), "2");
      }
      assert.equal(supportWrites, 1);
      assert.equal(originalReviews, 0);
      if (writer) {
        const resumed = await invoke(null, { ...config, interruptBefore: ["completion_decision", "specialist_dispatch"] });
        // The first dispatch boundary is the exact original continuation.
        assert.ok(resumed.focusedPrerequisite?.supportRef);
        await crashAt(null, "settled Focused correction", (ns, writes) =>
          ns.includes("assignment-") && localCorrections === 1 && writes.some(([channel, value]) =>
            channel === "submission" && (value as { status?: string } | undefined)?.status === "writer-round"),
        { interruptAfter: ["verify_committed_work"] });
        assert.equal(originalWrites, 1);
        assert.equal(localCorrections, 1);
        const finished = await invoke(null, { ...config, interruptAfter: ["verify_committed_work"] });
        assert.equal(localCorrections, 1, "Original correction must not be invoked again");
        assert.equal(finished.focusedPrerequisite, null, finished.reason ?? "");
        assert.equal(originalWrites, 1);
        const finalReceipt = JSON.parse(readFileSync(receiptPath, "utf8"));
        assert.ok(originalReceipt.piSessionFile && originalReceipt.piSessionId);
        assert.equal(finalReceipt.piSessionFile, originalReceipt.piSessionFile);
        assert.equal(finalReceipt.piSessionId, originalReceipt.piSessionId);
        assert.equal(finalReceipt.assignmentKey, pin.suspension.assignmentKey);
        assert.deepEqual(finalReceipt.paths, originalReceipt.paths);
        assert.equal(finalReceipt.invocationProof.ordinal, 1);
        assert.equal(git(job.worktreeRoot, "rev-list", "--count", job.baseSha + "..HEAD"), nested ? "3" : reviewAssessment ? "5" : "2");
        assert.equal((await inspectDependencyPlan(job))!.entries[0]!.phase, "verified");
        return;
      }
      const resumed = await invoke(null, { ...config, interruptAfter: ["independent_assignment_review"] });
      assert.equal(resumed.reviewPrerequisite, null, JSON.stringify({ status: resumed.status, reason: resumed.reason, lifecycle: resumed.recoveryLifecycle, originalReviews, calls: calls() }));
      assert.equal(originalReviews, 1);
      const ledger = await inspectDependencyPlan(job);
      const entry = ledger!.entries[0]!;
      assert.equal(entry.phase, "verified");
      assert.equal(entry.originalReview?.verdict, "pass");
      assert.ok(entry.originalReviewerSession);
      assert.notEqual(entry.originalReviewerSession, entry.reviewerSession);
      assert.equal((await inspectRecoveryCheckpoints(job)).find(p => p.commitSha === entry.reviewSourceSha)?.semanticReview, "failed");
      const head = git(job.worktreeRoot, "rev-parse", "HEAD");
      const before = calls();
      await invoke(null, { ...config, interruptBefore: ["completion_decision", "specialist_dispatch"] });
      assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), head);
      assert.equal(calls(), before);
      assert.equal(supportWrites, 1);
    } finally { saver.db.close(); restore(); }
  } finally {
    if (oldState === undefined) delete process.env.NT_STATE_DIR; else process.env.NT_STATE_DIR = oldState;
    if (oldCache === undefined) delete process.env.NT_SKILL_CACHE_DIR; else process.env.NT_SKILL_CACHE_DIR = oldCache;
  }
});

test("missing target and missing upstream context block without creating or editing unrelated Story", {
  skip: !available, timeout: 90_000,
}, () => {
  const f = fixture("missing-context");
  const log = f.contractPath + ".model-calls";
  Object.assign(f.env, { NT_TEST_FOCUSED_CLI: "1", NT_TEST_SCRIPTED_MODEL_LOG: log });
  const job = f.cli("focus", ["start"]);
  f.contract(["event.unknown"], "interactive");
  const result = f.cli("focus", ["generate", "start", "--task", "Revise one Event",
    "--contract", f.contractPath, "--provider", scriptedModel.provider, "--model", scriptedModel.id, "--skills-source", source], false);
  assert.match(result, /missing.*canonical scope target|missing verified upstream|upstream Creative Direction|Expected one non-superseded Creative Direction/i);
  assert.equal(existsSync(log), false);
  assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), git(f.repo, "rev-parse", "HEAD"));
  assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "");
});
