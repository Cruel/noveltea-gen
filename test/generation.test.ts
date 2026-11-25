import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test as nodeTest } from "node:test";
import { generationWeight, selectGenerationShard } from "./generation-shards.js";
import { removeTestTree } from "./helpers.js";
import { authorApproval } from "./approval-controller.js";
import { saveFixtureTurn } from "./puzzle-obligation-fixtures.js";
import { planWholeStory } from "../web/src/lib/turn-plan.js";
import { saveJobTurnPlan } from "../web/src/lib/turn-plan-receipt.server.js";
import { requiredOrchestratorSkillReads } from "../src/story-skill-policy.js";
import { fixtureSandboxClient, scriptedModel, scriptedReadCalls,
  scriptedStoryRuntime, scriptedText } from "./c03-scripted-story-helpers.js";
import { boundedPinnedSources } from "../src/bounded-specialist-prompt.js";
import { runEventTestAssignment as runEventWorkItem } from "./event-round-fixture.js";
import { runInteractiveWorkItem, inspectInteractiveConflict } from "../src/interactive-work.js";
import { createSkillSnapshot } from "../src/snapshot.js";
import { emptyAdaptiveState, beginAdaptiveAttempt, settleAdaptiveAttempt, readAdaptiveState } from "../src/adaptive-state.js";
import { projectAdaptiveFinal } from "../src/adaptive-final-review.js";
import { pendingDigest } from "../src/pending-work-amendments.js";
import { selectStoryOrchestrator } from "../src/orchestrator-selection.js";
import { parseStoryPlanning } from "../src/story-planning.js";
import { nativeStoryMetrics, reviewArchitectureMetrics } from "../src/story-metrics.js";
import { renderFoundation } from "../src/foundation-record.js";
import { withJobModelRuntime } from "../src/model-runtime.js";
import { startStoryJob } from "../src/job.js";
import { validateStoryJob } from "../src/validator.js";
import { inspectRecoveryCheckpoints } from "../src/recovery-checkpoints.js";
import { reviewedMilestoneHandoff } from "../src/milestone-obligation-handoff.js";
import { inspectBlockedOriginalThreadCorrection } from "../src/original-thread-continuation.js";
import { captureVerificationFailure, verifyCorrectedOriginalResult } from "../src/commit-verification-continuation.js";
import { assessGenerationOperation } from "../src/generation-operation-recovery.js";
import { originalFailedReviewProof, selectOperationStrategy } from "../src/generation-operation-strategy.js";
import { bindPostcommitReviewCycle, acceptPostcommitReviewRound } from "../src/postcommit-review-cycle.js";
import type { GenerationGraphState } from "../src/generation.js";
import type { RecoveryCase } from "../src/generation-recovery-contract.js";
import type { SkillSnapshot } from "../src/snapshot.js";
import { safeToResume } from "../web/src/lib/generation-controls.server.js";
import { inspectPiPolicy } from "../src/job-pi-policy.js";
import { setJobControl } from "../src/job-control.js";
import { assertMilestoneStageClosure } from "../src/turn-fulfillment.js";
import { reviewBoundedAssignments } from "../src/semantic-assignment-review.js";
import { eventPrerequisiteReportDigest } from "../src/event-prerequisite-auth.js";
import { inspectRepairLedger, recordBlueprintRepair } from "../src/repair-ledger.js";
import { appendGenerationEvent, syncApprovalRevisionActivity,
  listGenerationEvents } from "../web/src/lib/generation-progress.server.js";
import type { StudioStore } from "../web/src/persistence/store.js";
import { openKyselyFeatureFixture } from "../web/test/support/studio-database.js";
import { readEventOnlyOmission } from "../src/interactive-event-only.js";
import { createGenerationGraph } from "../src/generation.js";
import { admitAdaptiveAssignments, applyAdaptiveAssignments } from "../src/adaptive-assignments.js";
import { milestoneFulfillmentProjection } from "../src/milestone-field-scope.js";
import { reconcileInventory, nextExecutionItem, withCausalEventPriority } from "../src/generation-plan.js";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { projectRecovery } from "../src/generation-recovery-graph.js";
import { inspectModernGenerationRecovery } from "../src/generation-recovery-inspection.js";
import { inspectDeferredCorrection } from "../src/generation-recovery-resolution.js";
import { recoveryAdmission } from "../src/generation-recovery-lifecycle.js";

// This file deliberately runs its scenarios serially: many fixtures change
// process-wide environment and Pi transport. CI partitions the registered
// top-level cases, not their shared mutable process state.
const scenarios: { name: string; options: nodeTest.TestOptions; run: nodeTest.TestFn }[] = [];
function test(name: string, options: nodeTest.TestOptions | nodeTest.TestFn, run?: nodeTest.TestFn) {
  scenarios.push(typeof options === "function" ? { name, options: {}, run: options } : { name, options, run: run! });
}

const root = mkdtempSync(join(tmpdir(), "nt-generation-"));
after(() => {
  if (process.env.NT_TEST_KEEP_GENERATION === "1" || (process.env.NT_LIVE_GENERATION === "1" ||
    process.env.NT_LIVE_GENERATION_IDEA === "1" ||
    process.env.NT_LIVE_RECOVERY_C08 === "1") && process.env.NT_KEEP_FAILED_LIVE === "1")
    console.error("Preserved disposable generation evidence: " + root);
  else removeTestTree(root);
});
const source = resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills");
const available = existsSync(join(source, "src/cli.ts"));
/** Read the current graph's nonpersisted domain projection for assertions.
 * CLI inspect projects it for display, but LangGraph never stores old channels. */
function currentOperationRecovery(output: any) {
  if (output.operationRecovery !== undefined) return output.operationRecovery;
  if (!output.recoveryLifecycle || !output.recoverySources) return null;
  return projectRecovery({ recoveryLifecycle: output.recoveryLifecycle,
    recoverySources: output.recoverySources }).operationRecovery;
}
function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
// All scenarios share one immutable seed object database, not one writable
// repository. Each local --shared clone retains its own refs, index, checkout
// and worktree registry, so mutation and crash-recovery tests cannot leak
// state across scenarios. Avoid Git init/config/add/commit for every empty case.
let seedSha: string | undefined;
let compiledEntry: readonly string[] | undefined;
function cliEntry(): readonly string[] {
  // The test still starts a fresh process for each public CLI invocation.
  // Compile the current checkout only once rather than reloading the TS
  // transpiler in every child. Explicit opt-out aids source-level debugging.
  if (process.env.NT_GENERATION_TEST_SOURCE_CLI === "1")
    return ["--import", "tsx", resolve("src/cli.ts")];
  if (!compiledEntry) {
    const build = spawnSync(process.execPath, [resolve("node_modules/typescript/bin/tsc"),
      "-p", resolve("tsconfig.json")], { encoding: "utf8", timeout: 120_000 });
    assert.equal(build.status, 0, build.stderr || build.stdout || "Unable to build generation test CLI.");
    compiledEntry = [resolve("dist/cli.js")];
  }
  return compiledEntry;
}
function prepareSeed(): string {
  if (seedSha) return seedSha;
  const template = join(root, "template-repo");
  const story = join(template, "story");
  mkdirSync(story, { recursive: true });
  writeFileSync(join(story, ".gitkeep"), "");
  git(template, "init", "-q");
  git(template, "config", "user.name", "Author");
  git(template, "config", "user.email", "author@example.test");
  git(template, "add", ".");
  git(template, "commit", "-qm", "Initial Story");
  writeFileSync(join(root, "config.json"),
    JSON.stringify({ novelteaSkills: source, skillDiscovery: "explicit-only" }));
  seedSha = git(template, "rev-parse", "HEAD");
  return seedSha;
}
function setup(name: string, seed?: (story: string) => void) {
  const base = prepareSeed();
  cliEntry();
  const repo = join(root, name), story = join(repo, "story");
  git(root, "clone", "-q", "--shared", "-c", "user.name=Author",
    "-c", "user.email=author@example.test", join(root, "template-repo"), repo);
  if (seed) {
    seed(story);
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "Initial Story");
  }
  const initial = seed ? git(repo, "rev-parse", "HEAD") : base;
  const env = { ...process.env, NT_STATE_DIR: join(root, name + "-state"),
    NT_CONFIG_FILE: join(root, "config.json"), NT_SKILL_CACHE_DIR: join(root, "skills") };
  function cli(args: string[], success = true) {
    const scripted = (env as NodeJS.ProcessEnv).NT_TEST_SCRIPTED_ARCHIVE === "1"
      ? "test/support/scripted-archive-cli.ts"
      : (env as NodeJS.ProcessEnv).NT_TEST_SCRIPTED_FOUNDATION === "1"
        ? "test/support/scripted-foundation-cli.ts" : null;
    const entry = args[0] === "generate" && scripted ? ["--import", "tsx", resolve(scripted)] : cliEntry();
    const result = spawnSync(process.execPath, [...entry,
      "job", ...args, "--story", story, "--job", "single"], {
      encoding: "utf8", env, timeout: process.env.NT_LIVE_GENERATION === "1" ||
        process.env.NT_LIVE_GENERATION_IDEA === "1" ? 1_800_000 : 240_000, maxBuffer: 32 * 1024 * 1024 });
    if (!success) { assert.notEqual(result.status, 0); return result.stderr; }
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
  }
  const job = cli(["start"]);
  const contract = join(root, name + "-contract.json");
  writeFileSync(contract, JSON.stringify({ scope: { kind: "partial", depth: "composition",
    targets: ["arc.truth", "milestone.disclosure"], branches: ["protect", "challenge"] },
    constraints: ["The player can protect or challenge the witness"],
    envelope: { presentation: "Dialogue-led visual novel", hardLimits: [], preferences: [] } }));
  const start = ["generate", "start", "--task", "A missing archive witness; invent unspecified details",
    "--contract", contract, "--fixture", "--skills-source", source];
  return { repo, story, initial, cli, job, start, contract, env };
}

/** Migrate tests that stop at Foundation to the ordinary authenticated CLI.
 * A test-owned Turn is pinned once before starting the actual subprocess. */
async function useScriptedFoundationCli(f: ReturnType<typeof setup>) {
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope = { kind: "full-story", depth: "composition", targets: [], branches: [] };
  writeFileSync(f.contract, JSON.stringify(contract));
  await saveJobTurnPlan(f.job, planWholeStory(f.start[3]!, contract, f.job.baseSha));
  f.start.splice(f.start.indexOf("--fixture"), 1);
  f.start.push("--provider", scriptedModel.provider, "--model", scriptedModel.id);
  Object.assign(f.env, { NT_TEST_SCRIPTED_FOUNDATION: "1", NT_TEST_SCRIPTED_MODEL_LOG: f.contract + ".model-calls" });
}

async function useScriptedArchiveCli(f: ReturnType<typeof setup>) {
  await useScriptedFoundationCli(f);
  Object.assign(f.env, { NT_TEST_SCRIPTED_ARCHIVE: "1" });
}

test("R14K canonical archive baseline executes Foundation, Blueprint, Architecture and World/Character with actual current Turn", {
  skip: !available, timeout: 120_000,
}, async () => {
  const f = setup("r14k-archive-baseline");
  await useScriptedArchiveCli(f);
  const log = f.contract + ".model-calls";
  const first = f.cli([...f.start, "--pause-after", "foundation"]);
  assert.equal(first.status, "paused", first.reason + "\n" + readFileSync(log, "utf8"));
  const architecture = f.cli(["generate", "resume", "--pause-after", "architecture"]);
  assert.equal(architecture.status, "paused", architecture.reason + "\n" + readFileSync(log, "utf8"));
  const foundations = f.cli(["generate", "resume", "--pause-after", "foundations"]);
  assert.equal(foundations.status, "paused", foundations.reason + "\n" + readFileSync(log, "utf8"));
  const points = foundations.recoveryCheckpoints.filter((point: any) => point.eligible);
  assert.deepEqual(points.map((point: any) => point.workItem).sort(),
    ["character-foundations", "foundation", "global-architecture", "world-foundations"]);
  assert.ok(points.every((point: any) => point.assurance && ["passed", "not-required"].includes(point.semanticReview)));
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const calls = readFileSync(log, "utf8");
  assert.equal(f.cli(["generate", "inspect"]).status, "paused");
  assert.equal(readFileSync(log, "utf8"), calls);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
  assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.initial);
});

test("R14K archive production Event prerequisites use current local plan and native field grant", {
  skip: !available, timeout: 120_000,
}, async () => {
  const f = setup("r14k-archive-events");
  await useScriptedArchiveCli(f);
  const log = f.contract + ".model-calls";
  const run = f.cli([...f.start, "--pause-after", "event"]);
  assert.equal(run.status, "paused", run.reason + "\n" + readFileSync(log, "utf8"));
  const point = run.recoveryCheckpoints.find((p: any) => p.workItem === "event-disclosure");
  assert.ok(point?.eligible && point.assurance?.turnDigest === run.request.turnPlanDigest);
  assert.equal(point.semanticReview, "passed");
  const receipt = JSON.parse(readFileSync(join(f.job.stateDir, "event-items/disclosure.json"), "utf8"));
  assert.equal(receipt.worker, "pi");
  const { readEventMilestoneRepairGrant } = await import("../src/event-milestone-repair.js");
  const turn = JSON.parse(readFileSync(join(f.job.stateDir, "turn-plan.json"), "utf8"));
  assert.deepEqual(await readEventMilestoneRepairGrant(f.job, point,
    turn.assignments.find((a: any) => a.id === "event"), "deferred-choice-closeout"),
    { id: "milestone.disclosure", path: "milestones/disclosure.md" });
});

test("R14K current archive reaches actual reviewed Composition and Turn fulfillment", {
  skip: !available, timeout: 240_000,
}, async () => {
  const f = setup("r14k-current-archive-complete");
  await useScriptedArchiveCli(f);
  const result = f.cli(f.start);
  assert.equal(result.status, "completed", JSON.stringify({ reason: result.reason, active: result.active, escalation: result.escalation, recovery: result.recovery }) +
    "\n" + readFileSync(f.contract + ".model-calls", "utf8"));
  assert.equal(result.recoveryLifecycle?.active ?? null, null);
  assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
  // Event-only prose has no additional assignment Review requirement; its
  // actual independent Composition reviewer remains mandatory for the commit.
  const receipt = JSON.parse(readFileSync(join(f.job.stateDir, "composition-items/reckoning.json"), "utf8"));
  assert.ok(receipt.reviewPin && receipt.reviewSessionFile);
  assert.notEqual(receipt.sessionFile, receipt.reviewSessionFile);
  const points = result.recoveryCheckpoints as Awaited<ReturnType<typeof inspectRecoveryCheckpoints>>;
  for (const workItem of ["composition-disclosure", "composition-reckoning"])
    assert.ok(points.some(p => p.workItem === workItem && p.eligible && p.semanticReview === (workItem === "composition-reckoning" ? "not-required" : "passed")), JSON.stringify(points.map(p => ({ workItem: p.workItem, eligible: p.eligible, semanticReview: p.semanticReview, reason: p.reason }))));
});

for (const mode of ["composition", "choice", "puzzle", "blueprint", "blueprint-consumer", "composition-multi", "composition-choice", "composition-puzzle"] as const) test((mode.startsWith("blueprint") ? "R08 " : "R07 ") + mode + " suspends for independently verified upstream owner and continues original writer", {
  skip: !available, timeout: 240_000,
}, async () => {
  const multi = mode === "composition-multi";
  const stage = mode.startsWith("composition") ? "composition" : mode.startsWith("blueprint") ? "blueprint" : mode;
  const f = setup("r07-" + mode + "-writer");
  await useScriptedArchiveCli(f);
  if (stage === "blueprint") Object.assign(f.env, { NT_TEST_SCRIPTED_EARLY_ACCOUNT: "1" });
  const paused = f.cli([...f.start, "--pause-after", stage === "composition" ? "interactive" : "event"]);
  assert.equal(paused.status, "paused", paused.reason);
  const old = Object.fromEntries(Object.keys(f.env).map(key => [key, process.env[key]]));
  Object.assign(process.env, f.env);
  const saver = SqliteSaver.fromConnString(paused.checkpointPath);
  const restoreSandbox = fixtureSandboxClient(f.job.jobId, f.job.worktreeStoryRoot);
  try {
    const graph = createGenerationGraph(saver, "cli");
    const cfg = { configurable: { thread_id: paused.threadId }, recursionLimit: 1000 };
    const turn = JSON.parse(readFileSync(join(f.job.stateDir, "turn-plan.json"), "utf8"));
    const { archiveStages, earlyAccountOverreach } = await import("./support/scripted-archive-stages.js");
    const ordinary = archiveStages(f.job, turn);
    const blueprint = stage === "blueprint";
    const initialCalls = (await inspectPiPolicy(f.job)).budget.modelCalls;
    let target = blueprint ? "event.disclose-ledger" : "character.neri";
    let path = blueprint ? "events/disclose-ledger.md" : "characters/neri.md";
    let specialist = blueprint ? "nt-event-design" : "nt-character-development";
    if (mode === "composition-choice") {
      target = "choice-point.loyalty"; path = "choice-points/loyalty.md"; specialist = "nt-interactive-narrative";
    } else if (mode === "composition-puzzle") {
      target = "puzzle.ledger-proof"; path = "puzzles/ledger-proof.md"; specialist = "nt-interactive-narrative";
    }
    const milestone = blueprint ? "milestone.reckoning" : "milestone.disclosure";
    const milestonePath = "milestones/" + milestone.slice(10) + ".md";
    let correction = blueprint ? "Remove the premature inquiry acceptance from the earlier Event; preserve only the ledger discovery and its original routes." :
      "Make Neri's firsthand authentication of the original signature explicit.";
    if (mode === "composition-choice") correction = "Make the distinct consequences of protecting and challenging the witness explicit.";
    if (mode === "composition-puzzle") correction = "Make the independently observable seal a necessary part of ledger authentication.";
    if (blueprint) assert.ok(readFileSync(join(f.job.worktreeStoryRoot, path), "utf8").includes(earlyAccountOverreach));
    let second = false;
    const linkedInteraction = mode === "composition-choice" || mode === "composition-puzzle";
    const linkedEvent = mode === "composition-puzzle" ? "decode-ledger" : "disclose-ledger";
    const witnesses = () => linkedInteraction ? [milestonePath, "arcs/truth.md", "events/" + linkedEvent + ".md", path] :
      second ? [milestonePath, "arcs/truth.md", "characters/neri.md", path] : [milestonePath, "arcs/truth.md", path];
    const finding = () => ({ targetId: target, obligationIndex: 0, missing: correction,
      affectedIds: [milestone, "arc.truth", ...(second ? ["character.neri"] : []), ...(linkedInteraction ? ["event." + linkedEvent] : []), target], sources: witnesses().map(p => ({
        path: p, quote: blueprint && p === path ? earlyAccountOverreach : readFileSync(join(f.job.worktreeStoryRoot, p), "utf8").split("\n").find(l => l.startsWith("id:"))!,
      })), likelySpecialist: specialist, authorDecisionRequired: false });
    let negative = false, planned = false, written = false, supported = false;
    const runtime = await scriptedStoryRuntime((index, context) => {
      const messages = context.messages as Array<{ role: string; content: string | Array<{ text?: string }> }>;
      const prompt = messages.filter(m => m.role === "user").flatMap(m =>
        typeof m.content === "string" ? [m.content] : m.content.map(c => c.text ?? "")).at(-1) ?? "";
      const stop = (v: unknown) => ({ content: scriptedText(v), reason: "stop" as const });
      const read = (paths: string[]) => ({ content: scriptedReadCalls(paths, index), reason: "toolUse" as const });
      const skills = (name: string) => boundedPinnedSources(name).map(p => "skill://" + p);
      if (blueprint && !supported && prompt.includes("READ-ONLY LOCAL MILESTONE BLUEPRINT")) {
        const value = ordinary(index, context);
        if (value.reason === "stop") {
          assert.equal(value.content[0]?.type, "text");
          const design = JSON.parse((value.content[0] as { text: string }).text);
          assert.equal(design.milestoneId, milestone);
          return stop({ ...design, upstreamCorrection: finding() });
        }
        return value;
      }
      if (!blueprint && prompt.includes(stage === "composition" ? "You are a pinned nt-narrative-composition author" : stage === "choice" ? "Complete exactly ONE Choice unit" : "Assess exactly ONE Puzzle unit") && (!prompt.includes("AUTHENTICATED VERIFIED PREREQUISITE") || second) && !supported) {
        const tail = prompt.split(stage === "composition" ? "\nASSIGNMENT:\n" : "\nAUTHORIZED ASSIGNMENT\n")[1]!;
        const assign = JSON.parse(tail.slice(0, tail.lastIndexOf("}") + 1));
        assert.equal(assign.milestoneId, "milestone.disclosure");
        if (!negative) { negative = true; return read(stage === "composition" ? [...new Set([...skills("nt-narrative-composition"),
          "skill://nt-catalog/references/glossary.md", ...assign.sourcePaths])] : skills(stage === "choice" ? "nt-interactive-narrative" : "nt-puzzle-design")); }
        return stop({ modifiedRecords: [], architecturalConflicts: [correction], laterObligations: [],
          dependencyFinding: finding() });
      }
      if (prompt.includes("dependency") && prompt.includes("nt-story-orchestrate") && !supported && !written) {
        if (!planned) { planned = true; return read(["nt-story-orchestrate/SKILL.md", "nt-story-orchestrate/references/planning.md",
          "nt-catalog/SKILL.md", "nt-catalog/references/records.md", "nt-catalog/references/authority-and-validation.md"].map(p => "skill://" + p).concat(path)); }
        return stop({ target, specialist, outcome: correction, reason: "Correct the existing canonical predecessor." });
      }
      if (planned && !supported && prompt.includes(specialist) && !prompt.includes("IMMUTABLE REVIEW PACKET") && !prompt.includes("MILESTONE PLAN REVIEW")) {
        if (!written) { written = true; return read(skills(specialist)); }
        const before = readFileSync(join(f.job.worktreeStoryRoot, path), "utf8");
        if (blueprint ? before.includes(earlyAccountOverreach) : !before.includes(correction)) return { content: [{ type: "toolCall", name: "edit", id: "comp-support-edit",
          arguments: { path, edits: [{ oldText: before, newText: blueprint ? before.replace("\n" + earlyAccountOverreach + "\n", "") : before + "\n" + correction + "\n" }] } }], reason: "toolUse" };
        return stop({ modifiedRecords: [path], architecturalConflicts: [], laterObligations: [] });
      }
      if (written && !supported && prompt.includes("IMMUTABLE REVIEW PACKET")) {
        const packet = JSON.parse(prompt.split("\nIMMUTABLE REVIEW PACKET\n")[1]!);
        if (!messages.some(m => m.role === "toolResult" && JSON.stringify(m.content).includes("nt-narrative-review"))) {
          // The review packet may use a prior session; its next phase is determined by this packet's own tool reads.
          const marker = messages.filter(m => m.role === "assistant").length;
          if (!marker || !JSON.stringify(messages).includes("skill://nt-narrative-review/SKILL.md"))
            return read(skills("nt-narrative-review"));
        }
        const item = packet.items[0];
        supported = true;
        return stop({ sourceDigest: packet.sourceDigest, verdict: "pass", findings: [],
          evidence: [{ commitSha: item.assurance.commitSha, assignmentId: item.assignment.id, path, line: 1,
            explanation: "Verified the bounded canonical owner correction." }] });
      }
      return ordinary(index, context);
    });
    let initialInventory = paused.inventory;
    if (mode === "blueprint-consumer") {
      const earlier = initialInventory.items.find((entry: {id: string}) => entry.id === "interactive:milestone.disclosure");
      assert.ok(earlier && earlier.status === "pending");
      assert.ok(earlier.dependencies.every((id: string) =>
        initialInventory.items.some((i: {id: string; status: string}) => i.id === id && i.status === "verified")));
      await graph.updateState(cfg, { status: "running", reason: null, active: earlier, result: null, pauseAfter: null }, "author_update_intake");
      const consumed = await withJobModelRuntime(runtime.runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["verify_committed_work"] }));
      assert.equal(consumed.inventory?.items.find(i => i.id === earlier.id)?.status, "verified", JSON.stringify({reason: consumed.reason, recovery: consumed.recoverySources}));
      initialInventory = consumed.inventory!;
    }
    const item = initialInventory.items.find((entry: { id: string }) => entry.id === (blueprint ? "event" : stage === "composition" ? "composition" : "interactive") + ":" + milestone);
    assert.ok(item);
    await graph.updateState(cfg, { status: "running", reason: null, active: item, result: null, pauseAfter: null }, "author_update_intake");
    const suspended = await withJobModelRuntime(runtime.runtime, () => graph.invoke(null, { ...cfg, interruptBefore: ["dependency_amendment"] }));
    assert.ok(suspended.focusedPrerequisite?.writerSource, JSON.stringify({ reason: suspended.reason, recovery: suspended.recoverySources, active: suspended.active }));
    const receipt = () => {
      const r = JSON.parse(readFileSync(join(f.job.stateDir, blueprint ? "event-items/reckoning.json" : stage === "composition" ? "composition-items/disclosure.json" : "interactive-items/disclosure.json"), "utf8"));
      return blueprint || stage === "composition" ? r : r.units[stage === "choice" ? 0 : 1];
    };
    const original = receipt();
    assert.equal(suspended.focusedPrerequisite!.writerSource!.stage, blueprint ? "event" : stage);
    if (blueprint) {
      assert.equal(suspended.focusedPrerequisite!.writerSource!.origin, "blueprint");
      assert.equal(original.sessionFile, undefined);
      assert.equal(original.phase, "ready");
      assert.ok(original.blueprintPin);
    }
    const verified = await withJobModelRuntime(runtime.runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["dependency_amendment"] }));
    assert.ok(verified.focusedPrerequisite?.supportRef, JSON.stringify({ reason: verified.reason, recovery: verified.recoverySources }));
    const support = (await (await import("../src/dependency-state.js")).inspectDependencyPlan(f.job))!.entries.find(entry =>
      entry.writerSource?.sealDigest === suspended.focusedPrerequisite!.writerSource!.sealDigest)!;
    assert.ok(support.commitSha);
    assert.deepEqual(git(f.job.worktreeRoot, "diff-tree", "--no-commit-id", "--name-only", "-r", support.commitSha).trim().split("\n"),
      [(f.job.storyRelativePath ? f.job.storyRelativePath + "/" : "") + path]);
    const revalidated = JSON.parse(readFileSync(join(f.job.stateDir, "revalidation-items", support.commitSha + ".json"), "utf8"));
    assert.equal(revalidated.state, "completed");
    assert.ok(revalidated.proposal.unaffected.includes("foundation"));
    assert.ok(!revalidated.results.some((entry: {itemId: string}) => revalidated.proposal.unaffected.includes(entry.itemId)));
    if (stage === "composition" && !linkedInteraction) {
      assert.ok(revalidated.results.some((entry: {itemId: string; status: string}) =>
        entry.itemId === "event:milestone.disclosure" && entry.status === "passed"));
    }
    if (mode === "blueprint-consumer") {
      assert.equal(support.writerSource?.producer.workItem, "interactive-choice-disclosure");
      assert.equal(revalidated.proposal.upstreamItemId, "event:milestone.disclosure");
      assert.ok(revalidated.results.some((r: {itemId: string; status: string}) =>
        r.itemId === "interactive:milestone.disclosure" && r.status === "passed"));
    }
    if (blueprint) {
      const source = suspended.focusedPrerequisite!.writerSource!;
      const archive = join(f.job.stateDir, "event-writer-prerequisites", milestone.slice(10) + "-" + source.sealDigest + ".json");
      const bytes = readFileSync(archive, "utf8");
      const forged = JSON.parse(bytes);
      forged.blueprintPin.sourceSha = support.commitSha;
      const { inspectWriterDependency } = await import("../src/writer-dependency.js");
      try {
        writeFileSync(archive, JSON.stringify(forged));
        await assert.rejects(inspectWriterDependency(f.job, source), /exact original|approved design|prerequisite/i);
      } finally { writeFileSync(archive, bytes); }
      await inspectWriterDependency(f.job, source);
    }
    if (multi) {
      second = true;
      target = "fact.evidence-concealed";
      path = "facts/evidence-concealed.md";
      specialist = "nt-worldbuilding";
      correction = "Establish the signed transfer record as independent proof of the concealed ledger entry.";
      negative = planned = written = supported = false;
      const suspendedAgain = await withJobModelRuntime(runtime.runtime, () => graph.invoke(null, { ...cfg, interruptBefore: ["dependency_amendment"] }));
      assert.ok(suspendedAgain.focusedPrerequisite?.writerSource, JSON.stringify({reason: suspendedAgain.reason, recovery: suspendedAgain.recoverySources}));
      const secondPin = suspendedAgain.focusedPrerequisite!;
      assert.deepEqual(secondPin.identity, suspended.focusedPrerequisite!.identity);
      assert.equal(secondPin.writerSource!.predecessor?.supportRef, verified.focusedPrerequisite!.supportRef);
      assert.equal(secondPin.writerSource!.producer.workItem, "world-foundations");
      assert.equal(receipt().writerSessionId, original.writerSessionId);
      const secondSupport = await withJobModelRuntime(runtime.runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["dependency_amendment"] }));
      assert.ok(secondSupport.focusedPrerequisite?.supportRef, JSON.stringify({reason: secondSupport.reason, recovery: secondSupport.recoverySources}));
      const ledger = (await (await import("../src/dependency-state.js")).inspectDependencyPlan(f.job))!;
      const entries = ledger.entries.filter(entry => entry.writerSource);
      assert.equal(entries.length, 2);
      assert.ok(entries.every(entry => entry.phase === "verified" && entry.review?.verdict === "pass"));
      assert.equal(entries[1]!.report.sourceSha, verified.inventory!.headSha);
      assert.equal(receipt().writerSessionId, original.writerSessionId);
      const secondCommit = entries[1]!.commitSha!;
      assert.equal(git(f.job.worktreeRoot, "diff-tree", "--no-commit-id", "--name-only", "-r", secondCommit), "story/" + path);
      const review = JSON.parse(readFileSync(join(f.job.stateDir, "revalidation-items", secondCommit + ".json"), "utf8"));
      assert.equal(review.state, "completed");
      assert.ok(review.results.some((r: {itemId: string; status: string}) => r.itemId === "event:milestone.disclosure" && r.status === "passed"));
    }
    const result = await withJobModelRuntime(runtime.runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["specialist_dispatch"] }));
    assert.equal(result.result?.status, blueprint ? "event-cluster-committed" : stage === "composition" ? "composition-committed" : stage === "choice" ? "review-handoff" : "interactive-slice-committed", JSON.stringify({ reason: result.reason, recovery: result.recoverySources }));
    const current = receipt();
    if (blueprint) {
      assert.ok(current.sessionId);
      assert.notDeepEqual(current.blueprintPin, original.blueprintPin);
      assert.ok(!readFileSync(join(f.job.worktreeStoryRoot, path), "utf8").includes(earlyAccountOverreach));
      assert.equal(current.blueprintPin.sourceSha, verified.inventory?.headSha);
      assert.equal(support.review?.verdict, "pass");
      const next = await withJobModelRuntime(runtime.runtime, () => graph.invoke(null, { ...cfg, interruptBefore: ["specialist_dispatch"] }));
      assert.equal(next.inventory?.items.find(i => i.id === item.id)?.status, "verified", next.reason ?? "");
      assert.ok(next.active && next.active.id !== item.id, "The corrected Blueprint must continue through parent verification to ordinary work");
      assert.equal(next.recoveryLifecycle.active, null);
      assert.equal((await inspectPiPolicy(f.job)).budget.modelCalls, initialCalls + runtime.observed.length);
    } else assert.equal(stage === "composition" ? current.writerSessionId : current.piSessionId, stage === "composition" ? original.writerSessionId : original.piSessionId);
    assert.equal(current.phase, "committed");
    assert.equal(current.assignmentKey, original.assignmentKey);
    if (stage === "composition") { assert.ok(current.reviewPin); assert.notEqual(current.sessionFile, current.reviewSessionFile); }
    else assert.ok(current.invocationProof);
    assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
  } finally {
    saver.db.close();
    restoreSandbox();
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

for (const producerMode of ["ordinary", "repaired", "repaired-sibling", "supported"] as const) test("R07 integrated Event, Interactive and Composition carry cross-owner support through ordinary scheduling" + (producerMode === "ordinary" ? "" : " with " + producerMode + " producer"), {
  skip: !available, timeout: 480_000,
}, async () => {
  const f = setup("r07-integrated-writer-" + producerMode);
  await useScriptedArchiveCli(f);
  const paused = f.cli([...f.start, "--pause-after", "foundations"]);
  assert.equal(paused.status, "paused", paused.reason);
  const old = Object.fromEntries(Object.keys(f.env).map(key => [key, process.env[key]]));
  Object.assign(process.env, f.env);
  const saver = SqliteSaver.fromConnString(paused.checkpointPath);
  const restoreSandbox = fixtureSandboxClient(f.job.jobId, f.job.worktreeStoryRoot);
  try {
    const graph = createGenerationGraph(saver, "cli");
    const cfg = { configurable: { thread_id: paused.threadId }, recursionLimit: 1000 };
    const turn = JSON.parse(readFileSync(join(f.job.stateDir, "turn-plan.json"), "utf8"));
    const repairedSibling = producerMode === "repaired-sibling";
    const repaired = producerMode === "repaired" || repairedSibling;
    const ordinary = (await import("./support/scripted-archive-stages.js")).archiveStages(f.job, turn, false, false, repairedSibling);
    const milestone = repaired ? "milestone.reckoning" : "milestone.disclosure";
    const repairedPath = "events/redacted-account.md";
    const targetPath = repairedSibling ? "events/verify-register.md" : repairedPath;
    const targetId = repairedSibling ? "event.verify-register" : "event.redacted-account";
    const repairedQuote = "The inquiry verifies the visible signatures before accepting the redacted account.";
    let rejectedEventHead = "", repairedEventHead = "";
    const cases = repaired ? [{ stage: "composition", prompt: "You are a pinned nt-narrative-composition author",
      target: targetId, path: targetPath, specialist: "nt-event-design",
      correction: "Ada states the exact matching dates before the inquiry accepts the redacted account.",
      witnesses: ["milestones/reckoning.md", "arcs/truth.md", targetPath],
      ids: [milestone, "arc.truth", targetId], writer: "nt-narrative-composition" }] : [
      { stage: "event", prompt: "Author exactly ONE Event-design cluster", target: "character.neri",
        path: "characters/neri.md", specialist: "nt-character-development",
        correction: "Neri personally authenticates the signed archive register.",
        witnesses: ["milestones/disclosure.md", "arcs/truth.md", "characters/neri.md"],
        ids: [milestone, "arc.truth", "character.neri"], writer: "nt-event-design" },
      { stage: "choice", prompt: "Complete exactly ONE Choice unit", target: "fact.evidence-concealed",
        path: "facts/evidence-concealed.md", specialist: "nt-worldbuilding",
        correction: "The signed transfer record independently corroborates the concealed entry.",
        witnesses: ["milestones/disclosure.md", "arcs/truth.md", "characters/neri.md", "facts/evidence-concealed.md"],
        ids: [milestone, "arc.truth", "character.neri", "fact.evidence-concealed"], writer: "nt-interactive-narrative" },
      { stage: "composition", prompt: "You are a pinned nt-narrative-composition author", target: "event.disclose-ledger",
        path: "events/disclose-ledger.md", specialist: "nt-event-design",
        correction: "Show the visible seal on the already recovered ledger before offering the two consequential choices.",
        witnesses: ["milestones/disclosure.md", "arcs/truth.md", "events/disclose-ledger.md"],
        ids: [milestone, "arc.truth", "event.disclose-ledger"], writer: "nt-narrative-composition" },
    ];
    if (producerMode === "supported") cases[1] = { ...cases[1]!, target: "character.neri",
      path: "characters/neri.md", specialist: "nt-character-development",
      correction: "Neri explains why the signed register is independent of his account.",
      witnesses: ["milestones/disclosure.md", "arcs/truth.md", "characters/neri.md"],
      ids: [milestone, "arc.truth", "character.neri"] };
    let current = 0, negative = false, planned = false, written = false, supported = false;
    const runtime = await scriptedStoryRuntime((index, context) => {
      const messages = context.messages as Array<{ role: string; content: string | Array<{ text?: string }> }>;
      const prompt = messages.filter(m => m.role === "user").flatMap(m =>
        typeof m.content === "string" ? [m.content] : m.content.map(c => c.text ?? "")).at(-1) ?? "";
      const stop = (v: unknown) => ({ content: scriptedText(v), reason: "stop" as const });
      const read = (paths: string[]) => ({ content: scriptedReadCalls(paths, index), reason: "toolUse" as const });
      const skills = (name: string) => boundedPinnedSources(name).map(p => "skill://" + p);
      if (repaired) {
        if (prompt.includes("Continue your ORIGINAL specialist Pi session to correct a rejected draft.") && rejectedEventHead && !repairedEventHead) {
          const old = readFileSync(join(f.job.worktreeStoryRoot, repairedPath), "utf8");
          if (!old.includes(repairedQuote)) return { reason: "toolUse", content: [{
            type: "toolCall", name: "edit", id: "repaired-producer-edit", arguments: {
              path: repairedPath, edits: [{ oldText: old, newText: old + "\n" + repairedQuote + "\n" }] } }] };
          return stop("Clarified the original Event's evidence.");
        }
        if (prompt.includes("IMMUTABLE REVIEW PACKET") && !repairedEventHead) {
          const packet = JSON.parse(prompt.split("\nIMMUTABLE REVIEW PACKET\n")[1]!);
          const item = packet.items[0];
          if (item.reviewedWorkItem === "event-reckoning" || rejectedEventHead &&
              item.reviewedWorkItem === "repair-" + rejectedEventHead) {
            if (!messages.some(m => m.role === "toolResult" && JSON.stringify(m.content).includes("nt-narrative-review")))
              return read(skills("nt-narrative-review"));
            const ref = { commitSha: item.assurance.commitSha, assignmentId: item.assignment.id, path: repairedPath, line: 1 };
            if (!rejectedEventHead) {
              rejectedEventHead = item.assurance.commitSha;
              return stop({ sourceDigest: packet.sourceDigest, verdict: "fail", evidence: [],
                findings: [{ ...ref, kind: "missing-requirement", message: "The visible signatures are not yet explicit.",
                  requiredCorrection: repairedQuote, affectedPaths: [repairedPath] }] });
            }
            repairedEventHead = item.assurance.commitSha;
            assert.ok(readFileSync(join(f.job.worktreeStoryRoot, repairedPath), "utf8").includes(repairedQuote));
            return stop({ sourceDigest: packet.sourceDigest, verdict: "pass", findings: [],
              evidence: [{ ...ref, explanation: "The signatures are explicit." }],
              progressDiagnosis: { status: "material", reason: "Added visible signatures.",
                evidence: { path: repairedPath, quote: repairedQuote, change: "added" } } });
          }
        }
      }
      const c = cases[current];
      if (!c || supported) return ordinary(index, context);
      if (prompt.includes(c.prompt) && !prompt.includes("AUTHENTICATED VERIFIED PREREQUISITE")) {
        const tail = prompt.split(c.stage === "composition" ? "\nASSIGNMENT:\n" : "\nAUTHORIZED ASSIGNMENT\n")[1]!;
        const assignment = JSON.parse(tail.slice(0, tail.lastIndexOf("}") + 1));
        if (assignment.milestoneId !== milestone) return ordinary(index, context);
        if (!negative) {
          negative = true;
          return read(c.stage === "composition" ? [...new Set([...skills(c.writer), "skill://nt-catalog/references/glossary.md", ...assignment.sourcePaths])] :
            c.stage === "event" ? [...skills(c.writer), assignment.milestonePath] : skills(c.writer));
        }
        return stop({ modifiedRecords: [], architecturalConflicts: [c.correction], laterObligations: [],
          dependencyFinding: { targetId: c.target, obligationIndex: 0, missing: c.correction, affectedIds: c.ids,
            sources: c.witnesses.map(p => ({ path: p, quote: repaired && p === repairedPath ? repairedQuote : readFileSync(join(f.job.worktreeStoryRoot, p), "utf8").split("\n").find(l => l.startsWith("id:"))! })),
            likelySpecialist: c.specialist, authorDecisionRequired: false } });
      }
      if (negative && !written && prompt.includes("dependency") && prompt.includes("nt-story-orchestrate")) {
        if (!planned) { planned = true; return read(["nt-story-orchestrate/SKILL.md", "nt-story-orchestrate/references/planning.md",
          "nt-catalog/SKILL.md", "nt-catalog/references/records.md", "nt-catalog/references/authority-and-validation.md"].map(p => "skill://" + p).concat(c.path)); }
        return stop({ target: c.target, specialist: c.specialist, outcome: c.correction, reason: "Correct the existing verified upstream owner." });
      }
      if (planned && prompt.includes(c.specialist) && !prompt.includes("IMMUTABLE REVIEW PACKET") && !prompt.includes("MILESTONE PLAN REVIEW")) {
        if (!written) { written = true; return read(skills(c.specialist)); }
        const before = readFileSync(join(f.job.worktreeStoryRoot, c.path), "utf8");
        if (!before.includes(c.correction)) return { content: [{ type: "toolCall", name: "edit", id: "integrated-support-" + current,
          arguments: { path: c.path, edits: [{ oldText: before, newText: before + "\n" + c.correction + "\n" }] } }], reason: "toolUse" };
        return stop({ modifiedRecords: [c.path], architecturalConflicts: [], laterObligations: [] });
      }
      if (written && prompt.includes("IMMUTABLE REVIEW PACKET")) {
        const packet = JSON.parse(prompt.split("\nIMMUTABLE REVIEW PACKET\n")[1]!);
        if (!messages.some(m => m.role === "toolResult")) return read(skills("nt-narrative-review"));
        const item = packet.items[0];
        supported = true;
        return stop({ sourceDigest: packet.sourceDigest, verdict: "pass", findings: [],
          evidence: [{ commitSha: item.assurance.commitSha, assignmentId: item.assignment.id, path: c.path, line: 1,
            explanation: "The independently inspected upstream source establishes the missing evidence." }] });
      }
      return ordinary(index, context);
    });
    const readReceipt = (stage: string) => {
      if (stage === "choice") return JSON.parse(readFileSync(join(f.job.stateDir, "interactive-items/disclosure.json"), "utf8")).units[0];
      return JSON.parse(readFileSync(join(f.job.stateDir, stage + "-items/" + milestone.slice(10) + ".json"), "utf8"));
    };
    await graph.updateState(cfg, { status: "running", reason: null, pauseAfter: null }, "schedule");
    const originals: Array<{ key: string; session: string }> = [];
    for (const c of cases) {
      const suspended = await withJobModelRuntime(runtime.runtime, () => graph.invoke(null, { ...cfg, interruptBefore: ["dependency_amendment"] }));
      assert.equal(suspended.focusedPrerequisite?.writerSource?.stage, c.stage, JSON.stringify({reason: suspended.reason, recovery: suspended.recoverySources, active: suspended.active}));
      if (repaired) {
        assert.ok(rejectedEventHead && repairedEventHead);
        const source = suspended.focusedPrerequisite!.writerSource!;
        assert.equal(source.producer.workItem, "event-reckoning");
        assert.equal(source.producer.commitSha, rejectedEventHead);
        assert.equal(source.producer.verifiedCommitSha, repairedEventHead);
        const { verifiedPathProducer, inspectWriterDependency } = await import("../src/writer-dependency.js");
        await assert.rejects(() => verifiedPathProducer(f.job, turn.digest, rejectedEventHead, targetPath), /independently verified/);
        if (repairedSibling) {
          const prefix = f.job.storyRelativePath + "/";
          assert.equal(git(f.job.worktreeRoot, "log", "-1", "--format=%H", repairedEventHead, "--", prefix + targetPath), rejectedEventHead);
          assert.equal(git(f.job.worktreeRoot, "ls-tree", rejectedEventHead, "--", prefix + targetPath),
            git(f.job.worktreeRoot, "ls-tree", repairedEventHead, "--", prefix + targetPath));
          assert.equal(git(f.job.worktreeRoot, "diff", "--name-only", rejectedEventHead, repairedEventHead), prefix + repairedPath);
          assert.equal((await verifiedPathProducer(f.job, turn.digest, repairedEventHead, targetPath)).verifiedCommitSha, repairedEventHead);
        }
        const proof = join(f.job.stateDir, "review-repairs", "proofs", rejectedEventHead + ".json");
        const raw = readFileSync(proof, "utf8");
        try {
          writeFileSync(proof, JSON.stringify({ ...JSON.parse(raw), sourceReviewDigest: "0".repeat(64) }));
          await assert.rejects(() => inspectWriterDependency(f.job, source));
        } finally { writeFileSync(proof, raw); }
        const sealed = await inspectWriterDependency(f.job, source);
        assert.equal(sealed.report.sources.find(s => s.path === targetPath)?.quote,
          repairedSibling ? "id: " + targetId : repairedQuote);
      }
      const original = readReceipt(c.stage);
      originals.push({ key: original.assignmentKey, session: original.sessionId ?? original.piSessionId ?? original.writerSessionId });
      const verified = await withJobModelRuntime(runtime.runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["dependency_amendment"] }));
      assert.ok(verified.focusedPrerequisite?.supportRef, JSON.stringify({reason: verified.reason, recovery: verified.recoverySources}));
      const entry = (await (await import("../src/dependency-state.js")).inspectDependencyPlan(f.job))!.entries.find(e => e.writerSource?.sealDigest === suspended.focusedPrerequisite?.writerSource?.sealDigest)!;
      assert.equal(entry.phase, "verified"); assert.equal(entry.review?.verdict, "pass");
      assert.ok(readFileSync(join(f.job.worktreeStoryRoot, c.path), "utf8").includes(c.correction));
      const revalidated = JSON.parse(readFileSync(join(f.job.stateDir, "revalidation-items", entry.commitSha + ".json"), "utf8"));
      assert.equal(revalidated.state, "completed");
      if (c.stage === "composition" && !repaired) {
        assert.equal(entry.writerSource?.producer.workItem, "interactive-choice-disclosure");
        assert.equal(revalidated.proposal.upstreamItemId, "event:" + milestone);
        assert.ok(revalidated.results.some((r: {itemId: string; status: string}) => r.itemId === "interactive:" + milestone && r.status === "passed"));
        const omitted = "milestone.reckoning";
        const omission = JSON.parse(readFileSync(join(f.job.stateDir, "interactive-items/reckoning.json"), "utf8")).units[0].eventOnly;
        const { readEventOnlyOmission, readHistoricalEventOnlyOmission } = await import("../src/interactive-event-only.js");
        const reviewPath = join(f.job.stateDir, "revalidation-items", entry.commitSha + ".json");
        const originalReview = readFileSync(reviewPath, "utf8");
        assert.ok(revalidated.results.some((r: {itemId: string; status: string}) => r.itemId === "interactive:" + omitted && r.status === "passed"));
        await readEventOnlyOmission(f.job, omitted, omission);
        try {
          writeFileSync(reviewPath, JSON.stringify({ ...revalidated,
            results: revalidated.results.filter((r: {itemId: string}) => r.itemId !== "interactive:" + omitted) }));
          await readHistoricalEventOnlyOmission(f.job, omitted, omission);
          await assert.rejects(() => readEventOnlyOmission(f.job, omitted, omission), /independent revalidation|affected|Review/);
        } finally { writeFileSync(reviewPath, originalReview); }
        await readEventOnlyOmission(f.job, omitted, omission);
      }
      if (repaired) assert.equal(revalidated.proposal.upstreamItemId, "event:" + milestone);
      if (producerMode === "supported" && c.stage === "choice") assert.equal(entry.writerSource?.producer.workItem, "character-foundations");
      assert.ok(!revalidated.results.some((r: { itemId: string }) => revalidated.proposal.unaffected.includes(r.itemId)));
      const result = await withJobModelRuntime(runtime.runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["specialist_dispatch"] }));
      assert.equal(result.result?.status, c.stage === "event" ? "event-cluster-committed" : c.stage === "choice" ? "review-handoff" : "composition-committed", JSON.stringify({reason: result.reason, recovery: result.recoverySources}));
      const after = readReceipt(c.stage);
      assert.equal(after.phase, "committed");
      assert.equal(after.assignmentKey, originals.at(-1)!.key);
      assert.equal(after.sessionId ?? after.piSessionId ?? after.writerSessionId, originals.at(-1)!.session);
      current++; negative = planned = written = supported = false;
    }
    const done = await withJobModelRuntime(runtime.runtime, () => graph.invoke(null, { ...cfg, interruptBefore: ["specialist_dispatch"] }));
    assert.equal(done.inventory?.items.find(i => i.id === "composition:" + milestone)?.status, "verified");
    assert.ok(done.active && done.active.id !== "composition:" + milestone);
    assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
    const ledger = (await (await import("../src/dependency-state.js")).inspectDependencyPlan(f.job))!;
    assert.equal(ledger.entries.filter(e => e.writerSource).length, cases.length);
  } finally {
    saver.db.close(); restoreSandbox();
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

for (const mode of ["native", "independent", "support"] as const) test("R07 retained Choice " + mode +
    " corrects the original owner and preserves the RecoveryCase", {
  skip: !available, timeout: 240_000,
}, async () => {
  const independent = mode !== "native", needsSupport = mode === "support";
  const f = setup("r07-retained-choice-" + mode);
  await useScriptedArchiveCli(f);
  if (independent) f.env.NT_TEST_SCRIPTED_COMPLETE_CHOICE_EVENT = "1";
  // Use the same authenticated, user-approved Creative Direction handoff
  // as Studio. An ordinary CLI draft intentionally cannot enable adaptive planning.
  const snapshot = await createSkillSnapshot({ discovery: "explicit-only", novelteaSkills: source,
    skillDirs: [], requiredSkills: ["nt-story-discovery", "nt-catalog"] });
  assert.ok(snapshot);
  const foundation = {
    id: "foundation", title: "The Archive Witness",
    premise: "Ada investigates a missing archive witness and Neri's concealed ledger.",
    central_conflict: "Ada must prove concealment without exposing a witness.",
    genre: "Mystery", tone: "Intimate and suspenseful",
    player_experience: "Compare sources and make a consequential decision.",
    scope: "One archive, Ada and Neri, and two causal turning points.",
    planning: parseStoryPlanning({ choice_frequency: "occasional", puzzle_emphasis: "hybrid" }),
    decisions: [{ id: "author-brief", statement: f.start[3]!, origin: "user" as const, authority: "user-protected" as const }],
    body: "# The Archive Witness\n\nAda compares the signed ledger with the daily register and decides whether to protect or challenge Neri.",
  };
  await (await import("../src/chat-approved-foundation.js")).pinChatApprovedFoundation(f.job, {
    jobId: f.job.jobId, sourceSha: f.job.baseSha, firstTurnId: "retained-choice-author-approval",
    scope: "whole-story", originalObjective: f.start[3]!, proposalDigest: pendingDigest(foundation),
    skillId: snapshot.id, foundation, creativeMode: "autonomous",
    provider: scriptedModel.provider, model: scriptedModel.id,
  });
  const paused = f.cli([...f.start, "--pause-after", "event"]);
  assert.equal(paused.status, "paused", paused.reason);
  const old = Object.fromEntries([...Object.keys(f.env), "NT_ADAPTIVE_PLANNING"].map(key => [key, process.env[key]]));
  Object.assign(process.env, f.env, { NT_ADAPTIVE_PLANNING: "1" });
  const restoreSandbox = fixtureSandboxClient(f.job.jobId, f.job.worktreeStoryRoot);
  let saver = SqliteSaver.fromConnString(paused.checkpointPath);
  try {
    let graph = createGenerationGraph(saver, "cli");
    const cfg = { configurable: { thread_id: paused.threadId }, recursionLimit: 1000 };
    const turn = JSON.parse(readFileSync(join(f.job.stateDir, "turn-plan.json"), "utf8"));
    const { archiveStages } = await import("./support/scripted-archive-stages.js");
    const { requiredOrchestratorSkillReads } = await import("../src/story-skill-policy.js");
    const ordinary = archiveStages(f.job, turn);
    const milestone = "milestone.disclosure", assignmentId = "interactive:" + milestone;
    const receiptPath = join(f.job.stateDir, "interactive-items/disclosure.json");
    const receipt = () => JSON.parse(readFileSync(receiptPath, "utf8"));
    let previous = "", phase = 0, plans = 0, negatives = 0, omissionReviews = 0;
    let supported = false, planned = false, written = false;
    const supportPath = "characters/neri.md";
    const missing = "Clarify the witness's firsthand authentication of the signed record.";
    const witnesses = ["milestones/disclosure.md", "arcs/truth.md", supportPath];
    const skills = (name: string) => boundedPinnedSources(name).map(p => "skill://" + p);
    const scripted = await scriptedStoryRuntime((index, context) => {
      const messages = context.messages as Array<{ role: string; content: string | Array<{ text?: string }> }>;
      const prompt = messages.filter(m => m.role === "user").flatMap(m =>
        typeof m.content === "string" ? [m.content] : m.content.map(c => c.text ?? "")).at(-1) ?? "";
      if (previous !== prompt) { previous = prompt; phase = 0; }
      const step = phase++;
      const stop = (v: unknown) => ({ content: scriptedText(v), reason: "stop" as const });
      const read = (paths: string[]) => ({ content: scriptedReadCalls(paths, index), reason: "toolUse" as const });
      if (prompt.includes("You are the pinned NovelTea Story orchestrator at a verified safe boundary")) {
        if (!step) return read(requiredOrchestratorSkillReads(turn.creativePolicy?.mode ?? "autonomous").map(p => "skill://" + p));
        const source = prompt.match(/sourceSha=([a-f0-9]{40}), turnDigest=([a-f0-9]{64}), beforeVersion=([0-9]+)/)!;
        const pending = JSON.parse(prompt.match(/Only currently pending IDs: (\[[^\n]*\])/)![1]!) as string[];
        const projection = JSON.parse(prompt.match(/Native Milestone immutable planning\/body projections eligible for narrowing[^\n]*?: (\[[^\n]*\])/)![1]!) as Array<{milestone: string; path: string; sha256: string}>;
        const selected = projection.find(p => p.milestone === milestone)!;
        const actions = plans++ === 0 ? [{ kind: "narrow", item: assignmentId, sourcePath: selected.path,
          sourceHash: selected.sha256, outcome: "Implement the required consequential protect-or-challenge decision in the approved local design." }] : [];
        return stop({ sourceSha: source[1], turnDigest: source[2], beforeVersion: Number(source[3]),
          reason: "Retain the original pending owner and verified dependency order.", actions,
          order: pending.includes(assignmentId) ? [assignmentId, ...pending.filter(id => id !== assignmentId)] : pending });
      }
      if (prompt.includes("INDEPENDENT EVENT-ONLY OMISSION REVIEW")) {
        if (!step) {
          const assignment = JSON.parse(prompt.split("\nASSIGNMENT:\n")[1]!);
          if (assignment.omission.assignmentId === assignmentId) omissionReviews++;
          const references = prompt.split("PINNED REFERENCES:\n")[1]!.split("\nSTORY PATHS:")[0]!.split("\n");
          const paths = assignment.paths;
          return read([...references, ...paths]);
        }
        return stop({ verdict: "block", findings: [{ severity: "blocking", dimension: "player-agency",
          source: JSON.parse(prompt.split("\nASSIGNMENT:\n")[1]!).paths.find((path: string) => path.startsWith("milestones/")) + ":1", message: "The independently approved local decision remains necessary.",
          repair: "interactive" }], evidence: [] });
      }
      if (prompt.includes("Complete exactly ONE Choice unit") && !prompt.includes("AUTHENTICATED RETAINED INTERACTION") && !prompt.includes("AUTHENTICATED VERIFIED PREREQUISITE")) {
        if (!step) return read(boundedPinnedSources("nt-interactive-narrative").map(p => "skill://" + p));
        negatives++;
        return stop({ modifiedRecords: [], architecturalConflicts: ["The original local decision remains unimplemented."],
          laterObligations: ["Retain the approved protect-or-challenge Choice."] });
      }
      if (needsSupport && !supported && prompt.includes("Complete exactly ONE Choice unit") && prompt.includes("AUTHENTICATED RETAINED INTERACTION")) {
        if (!step) return read(skills("nt-interactive-narrative"));
        return stop({ modifiedRecords: [], architecturalConflicts: [missing], laterObligations: [],
          dependencyFinding: { targetId: "character.neri", obligationIndex: 0, missing,
            affectedIds: [milestone, "arc.truth", "character.neri"], sources: witnesses.map(p => ({path: p,
              quote: readFileSync(join(f.job.worktreeStoryRoot, p), "utf8").split("\n").find(l => l.startsWith("id:"))!})),
            likelySpecialist: "nt-character-development", authorDecisionRequired: false } });
      }
      if (needsSupport && !supported && prompt.includes("dependency") && prompt.includes("nt-story-orchestrate") && !written) {
        if (!planned) { planned = true; return read(["nt-story-orchestrate/SKILL.md", "nt-story-orchestrate/references/planning.md",
          "nt-catalog/SKILL.md", "nt-catalog/references/records.md", "nt-catalog/references/authority-and-validation.md"].map(p => "skill://" + p).concat(supportPath)); }
        return stop({ target: "character.neri", specialist: "nt-character-development", outcome: missing, reason: "Correct the existing upstream witness." });
      }
      if (needsSupport && planned && !supported && prompt.includes("nt-character-development") && !prompt.includes("IMMUTABLE REVIEW PACKET")) {
        if (!written) { written = true; return read(skills("nt-character-development")); }
        const before = readFileSync(join(f.job.worktreeStoryRoot, supportPath), "utf8");
        if (!before.includes(missing)) return { content: [{ type: "toolCall", name: "edit", id: "retained-support-edit",
          arguments: { path: supportPath, edits: [{ oldText: before, newText: before + "\n" + missing + "\n" }] } }], reason: "toolUse" };
        return stop({ modifiedRecords: [supportPath], architecturalConflicts: [], laterObligations: [] });
      }
      if (needsSupport && written && !supported && prompt.includes("IMMUTABLE REVIEW PACKET")) {
        const packet = JSON.parse(prompt.split("\nIMMUTABLE REVIEW PACKET\n")[1]!);
        if (!step) return read(skills("nt-narrative-review"));
        const item = packet.items[0]; supported = true;
        return stop({ sourceDigest: packet.sourceDigest, verdict: "pass", findings: [],
          evidence: [{ commitSha: item.assurance.commitSha, assignmentId: item.assignment.id, path: supportPath, line: 1,
            explanation: "Verified the source-bound witness correction." }] });
      }
      return ordinary(index, context);
    });
    await graph.updateState(cfg, { status: "running", reason: null, pauseAfter: null, active: null, result: null }, "schedule");
    const rejected = await withJobModelRuntime(scripted.runtime, () => graph.invoke(null, { ...cfg, interruptBefore: ["assess_recovery"] }));
    assert.equal(rejected.recoveryLifecycle.active?.origin.assignmentId, assignmentId, JSON.stringify({ reason: rejected.reason, active: rejected.active, recovery: rejected.recoveryLifecycle, sources: rejected.recoverySources }));
    assert.equal(rejected.recoveryLifecycle.active?.origin.operation, "specialist-result");
    assert.ok(rejected.adaptiveVersion && rejected.adaptiveVersion > 1, JSON.stringify({plans, reason: rejected.reason, request: rejected.request}));
    assert.equal(negatives, 1);
    const original = receipt().units[0];
    assert.equal(original.phase, "conflicted");
    const selected = await withJobModelRuntime(scripted.runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] }));
    assert.equal(selected.recoveryLifecycle.decision?.action, "plan-amendment", JSON.stringify({ reason: selected.reason, recovery: selected.recoveryLifecycle }));
    assert.equal(selected.recoveryLifecycle.decision?.adapter, "adaptive-work");
    const before = (await graph.getState(cfg)).values;
    const caseId = selected.recoveryLifecycle.active!.id;
    let result = await withJobModelRuntime(scripted.runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] }));
    if (needsSupport) {
      assert.equal(result.recoveryLifecycle.active?.id, caseId);
      assert.ok(result.focusedPrerequisite?.writerSource, JSON.stringify({reason: result.reason, recovery: result.recoveryLifecycle}));
      result = await withJobModelRuntime(scripted.runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] }));
      assert.equal(result.recoveryLifecycle.active?.id, caseId);
      assert.ok(result.focusedPrerequisite?.supportRef, JSON.stringify({reason: result.reason, recovery: result.recoveryLifecycle}));
      assert.ok(supported);
      result = await withJobModelRuntime(scripted.runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] }));
    }
    assert.equal(result.recoveryLifecycle.active, null, JSON.stringify({ reason: result.reason, recovery: result.recoveryLifecycle }));
    assert.equal(result.result?.status, "review-handoff");
    assert.equal(result.active?.id, assignmentId);
    const corrected = receipt().units[0];
    assert.equal(corrected.phase, "committed");
    assert.equal(corrected.assignmentKey, original.assignmentKey);
    assert.equal(corrected.piSessionId, original.piSessionId);
    assert.equal(corrected.retainedChoice.caseId, caseId);
    assert.equal(corrected.retainedChoice.reportDigest, original.digest);
    assert.equal(result.recoveryLifecycle.discharged.at(-1)?.case.id, caseId);
    assert.equal(negatives, 1);
    assert.equal(omissionReviews, independent ? 1 : 0);
    if (independent) assert.ok(corrected.retainedChoice.reviewDigest);
    else assert.equal(corrected.retainedChoice.decline, "native-required");
    if (needsSupport) assert.ok(corrected.writerContinuation?.supportRef);
    const head = corrected.commitSha;
    assert.equal((await inspectRecoveryCheckpoints(f.job)).find(p => p.commitSha === head)?.semanticReview, "passed");
    assert.equal(receipt().units[1].phase, "pending");
    const charges = (await inspectPiPolicy(f.job)).budget.modelCalls;
    // Simulate a crash after native publication and independent Review, but
    // before the assessor's parent checkpoint. No new model effect is permitted.
    saver.db.close();
    saver = SqliteSaver.fromConnString(paused.checkpointPath);
    graph = createGenerationGraph(saver, "cli");
    await graph.updateState(cfg, before, "assess_recovery");
    const replay = await withJobModelRuntime(scripted.runtime, () => graph.invoke(null, { ...cfg, interruptBefore: ["author_update_intake"] }));
    assert.equal(replay.recoveryLifecycle.active, null, JSON.stringify({reason: replay.reason, recovery: replay.recoveryLifecycle}));
    assert.equal(replay.recoveryLifecycle.discharged.at(-1)?.case.id, caseId);
    assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
    assert.equal((await inspectPiPolicy(f.job)).budget.modelCalls, charges);
    assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
  } finally {
    saver.db.close();
    restoreSandbox();
    for (const [key, value] of Object.entries(old)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

function captureRecoveryIdea(f: ReturnType<typeof setup>, id: string, prerequisites = ["milestone.disclosure"]) {
  const file = join(root, id + "-recovery-idea.json");
  writeFileSync(file, JSON.stringify({
    id, kind: "event-concept",
    source: { kind: "author-onboarding", reference: "source-notes" },
    original: "The bell establishes the archive visitor's arrival.",
    requirements: { meaning: [{ text: "The bell establishes the chronology", binding: true }],
      wording: [], participants: [] },
    identities: { known: [], unresolved: [] },
    prerequisites,
    placement: { scopeIds: ["arc.truth"], flexible: true, earliest: "event" },
    upstreamConstraints: [],
  }));
  f.cli(["ideas", "capture", "--file", file]);
}

test("production start assesses thrown author-update intake and restart cannot replay it", { skip: !available }, async () => {
  const f = setup("recovery-author-intake");
  await useScriptedArchiveCli(f);
  const folder = join(f.job.stateDir, "author-updates", "messages");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "broken.json"), "not valid JSON");
  const initial = f.cli(f.start);
  assert.equal(initial.status, "blocked");
  assert.equal(initial.operationRecovery?.operation, "author-update-intake");
  assert.equal(initial.operationRecovery?.phase, "fenced");
  assert.equal(initial.operationRecovery?.outcome, "exception");
  assert.equal(initial.operationRecovery?.source.jobId, "single");
  assert.equal(initial.operationRecovery?.evidence.reference, "author-updates");
  assert.equal(initial.operationRecovery?.check, "author-update-intake.v1");
  assert.equal(initial.operationRecovery?.checkVersion, 1);
  assert.match(initial.operationRecovery?.nextAction ?? "", /reconcile.*intake/i);
  const inspected = f.cli(["generate", "inspect"]);
  assert.deepEqual(inspected.operationRecovery, initial.operationRecovery);
  const resumed = f.cli(["generate", "resume"]);
  assert.deepEqual(resumed.operationRecovery, initial.operationRecovery);
  assert.equal(resumed.status, "blocked");
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), f.initial);
  unlinkSync(join(folder, "broken.json"));
  const repaired = f.cli(["generate", "resume", "--pause-after", "foundation"]);
  assert.equal(repaired.operationRecovery?.phase, "continued",
    JSON.stringify({ reason: repaired.reason, recovery: repaired.recoveryInspection }));
  assert.equal(repaired.operationRecovery?.operation, "author-update-intake");
});

test("C02 current-format checkpoint tampering cannot grant a new recovery or writer attempt", { skip: !available }, async () => {
  const f = setup("recovery-current-tamper");
  await useScriptedFoundationCli(f);
  const folder = join(f.job.stateDir, "author-updates", "messages");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "bad.json"), "not valid JSON");
  const initial = f.cli(f.start);
  assert.equal(initial.status, "blocked");
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const before = (await inspectPiPolicy(f.job)).budget.modelCalls;
  const saver = SqliteSaver.fromConnString(initial.checkpointPath);
  try {
    const graph = createGenerationGraph(saver, "cli");
    const cfg = { configurable: { thread_id: f.job.threadId + ":generation" } };
    const saved = await graph.getState(cfg);
    const state = saved.values as { recoveryLifecycle: import("../src/generation-recovery-contract.js").RecoveryLifecycle };
    assert.ok(state.recoveryLifecycle);
    const verified = await inspectModernGenerationRecovery(f.job, saver, cfg.configurable.thread_id);
    assert.deepEqual(verified, state.recoveryLifecycle,
      "the original unmodified current-format checkpoint remains inspectable");
    await graph.updateState(cfg, {
      recoveryLifecycle: { ...state.recoveryLifecycle, phase: "correcting", decision: null },
    }, "schedule");
    const fenced = await inspectModernGenerationRecovery(f.job, saver, cfg.configurable.thread_id);
    assert.equal(fenced?.phase, "fenced");
    assert.equal(fenced?.active, null);
    assert.ok(fenced?.inspectionFences.length);
  } finally { saver.db.close(); }
  const resumed = f.cli(["generate", "resume"]);
  assert.equal(resumed.status, "blocked");
  assert.equal(resumed.nextStage, null);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
  assert.equal((await inspectPiPolicy(f.job)).budget.modelCalls, before,
    "a forged current-case phase cannot charge or replay the original specialist");
});

test("C05 unfamiliar scheduling failure is resolved by source-bound recheck and resumes generation", {
  skip: !available, timeout: 120_000,
}, async () => {
  const f = setup("c05-source-bound-reconciliation");
  await useScriptedArchiveCli(f);
  const paused = f.cli([...f.start, "--pause-after", "event"]);
  assert.equal(paused.status, "paused");
  captureRecoveryIdea(f, "recovery-bell");
  const turn = JSON.parse(readFileSync(join(f.job.stateDir, "turn-plan.json"), "utf8"));
  const digest = turn.digest;
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const tasksFile = join(f.job.stateDir, "idea-placement-tasks.json");
  const originalTasks = existsSync(tasksFile) ? readFileSync(tasksFile) : null;
  writeFileSync(tasksFile, JSON.stringify({ version: 999, jobId: "single", history: [] }));
  const previous = Object.fromEntries(Object.keys(f.env).map(key => [key, process.env[key]]));
  Object.assign(process.env, f.env);
  const saver = SqliteSaver.fromConnString(paused.checkpointPath);
  const restoreSandbox = fixtureSandboxClient(f.job.jobId, f.job.worktreeStoryRoot);
  try {
    const priorCalls = (await inspectPiPolicy(f.job)).budget.modelCalls;
    const graph = createGenerationGraph(saver, "cli");
    const cfg = { configurable: { thread_id: paused.threadId } };
    const values = (await graph.getState(cfg)).values;
    await graph.updateState(cfg, {
      status: "running", active: null, result: null, ideaTask: null,
      escalation: null, causalAmendment: null, pauseAfter: null,
    }, "schedule");
    const admitted = await graph.invoke(null, { ...cfg, interruptBefore: ["assess_recovery"] });
    assert.equal(admitted.recoveryLifecycle.active?.origin.operation, "scheduling");
    const selected = await graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] });
    assert.equal(selected.recoveryLifecycle.decision?.action, "reconcile-effects");
    assert.equal((await inspectPiPolicy(f.job)).budget.modelCalls, priorCalls);

    // The injected transient private scheduling failure disappears. This is
    // NOT an authorized Story correction; recovery must still independently
    // rerun the original read-only check before any ordinary scheduling.
    if (originalTasks) writeFileSync(tasksFile, originalTasks);
    else unlinkSync(tasksFile);
    const reconciled = await graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] });
    assert.equal(reconciled.recoveryLifecycle.active, null,
      JSON.stringify({ status: reconciled.status, reason: reconciled.reason,
        lifecycle: reconciled.recoveryLifecycle }));
    assert.equal(reconciled.recoveryLifecycle.phase, "idle");
    assert.equal(reconciled.status, "running");
    assert.deepEqual((await graph.getState(cfg)).next, ["author_update_intake"],
      "The original graph resumes after independently verified read-only reconciliation");
    assert.equal((await inspectPiPolicy(f.job)).budget.modelCalls, priorCalls,
      "Read-only independent recheck must not consume another external Pi call");
    assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head,
      "Original read-only reconciliation cannot commit");
    assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, paused.threadId),
      reconciled.recoveryLifecycle);
  } finally {
    restoreSandbox();
    saver.db.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

for (const mode of ["foreign-dispatch", "unverified-result", "deferred", "deferred-two"] as const)
test("C08 parent Idea dispatch and verification authenticate the original task " + mode, {
  skip: !available, timeout: 120_000,
}, async () => {
  const f = setup("c08-idea-" + mode);
  await useScriptedArchiveCli(f);
  const paused = f.cli([...f.start, "--pause-after", "interactive"]);
  assert.equal(paused.status, "paused", paused.reason);
  captureRecoveryIdea(f, "c08-bell", []);
  if (mode === "deferred-two") captureRecoveryIdea(f, "c08-second-bell", []);
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const old = Object.fromEntries(Object.keys(f.env).map(key => [key, process.env[key]]));
  Object.assign(process.env, f.env);
  const saver = SqliteSaver.fromConnString(paused.checkpointPath);
  const restoreSandbox = fixtureSandboxClient(f.job.jobId, f.job.worktreeStoryRoot);
  try {
    const graph = createGenerationGraph(saver, "cli");
    const cfg = { configurable: { thread_id: paused.threadId }, recursionLimit: 1000 };
    const calls = (await inspectPiPolicy(f.job)).budget.modelCalls;
    const runtime = await scriptedStoryRuntime((index, context) => {
      assert.equal(mode === "foreign-dispatch", false, "A foreign dispatch receipt cannot invoke Pi");
      if (mode === "deferred-two" && index >= 2) index -= 2;
      if (index === 0) {
        const messages = context.messages as Array<{role: string; content: unknown}>;
        const prompt = messages.filter(m => m.role === "user").map(m => JSON.stringify(m.content)).join("\n").replaceAll("\\n", "\n");
        const paths = prompt.split("READ ALL EXACT FILE PATHS FIRST:\n")[1]!
          .split("\nRead-only independent semantic assessment")[0]!.split("\n");
        return { content: scriptedReadCalls(paths, index), reason: "toolUse" };
      }
      assert.equal(index, 1, "No writer may be dispatched from a blocked selection");
      return { content: scriptedText({ verdict: "block", target: null, evidence: [],
        reason: "No suitable candidate preserves the causal context." }), reason: "stop" };
    });
    const selected = await withJobModelRuntime(runtime.runtime, () => graph.invoke(
      { request: paused.request, pauseAfter: null }, { ...cfg, interruptAfter: ["author_update_intake"] }));
    assert.equal(selected.status, "running", selected.reason ?? "");
    assert.ok(mode === "deferred-two" ? ["c08-bell", "c08-second-bell"].includes(selected.ideaTask?.id ?? "") : selected.ideaTask?.id === "c08-bell", JSON.stringify({ task: selected.ideaTask, active: selected.active }));
    assert.equal(selected.ideaTask?.priorHead, head);
    assert.equal((await inspectPiPolicy(f.job)).budget.modelCalls, calls);
    const file = join(f.job.stateDir, "generation-idea-dispatch.json");
    if (mode === "foreign-dispatch") {
      const receipt = { jobId: "different-job", task: selected.ideaTask, phase: "running" };
      writeFileSync(file, JSON.stringify(receipt));
      const result = await withJobModelRuntime(runtime.runtime, () => graph.invoke(null, cfg));
      assert.equal(result.status, "blocked", result.reason ?? "");
      assert.equal(result.recoveryLifecycle.active?.origin.operation, "idea-integration");
      assert.equal(result.recoveryLifecycle.phase, "fenced");
      assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), receipt);
      assert.equal(runtime.calls(), 0);
    } else {
      const returned = await withJobModelRuntime(runtime.runtime, () => graph.invoke(null, {
        ...cfg, interruptAfter: ["idea_integration"],
      }));
      assert.equal(returned.ideaResult?.status, "deferred", JSON.stringify(returned.ideaResult));
      assert.equal(runtime.calls(), 2);
      assert.ok(runtime.observed.every(call => !call.tools.includes("write") && !call.tools.includes("edit")));
      if (mode === "unverified-result") {
        await graph.updateState(cfg, { ideaResult: { status: "integrated", commitSha: "f".repeat(40) } }, "idea_integration");
        const rejected = await withJobModelRuntime(runtime.runtime, () => graph.invoke(null, cfg));
        assert.equal(rejected.status, "blocked");
        assert.equal(rejected.recoveryLifecycle.active?.origin.operation, "idea-verification");
        assert.equal(rejected.recoveryLifecycle.phase, "fenced");
      } else {
        const deferred = await withJobModelRuntime(runtime.runtime, () => graph.invoke(null, {
          ...cfg, interruptAfter: ["assess_recovery"],
        }));
        const original = deferred.recoveryLifecycle.active ?? deferred.recoveryLifecycle.pending[0];
        assert.equal(original?.origin.operation, "idea-integration");
        assert.ok(deferred.recoveryLifecycle.decision?.action === "continue-independent" ||
          deferred.recoveryLifecycle.deferredCaseIds?.includes(original!.id),
          "A deferred Idea permits independent work without resolving its original obligation");
        assert.equal(deferred.ideaHistory.at(-1)?.status, "deferred");
        assert.equal(deferred.recoveryLifecycle.discharged.length, 0);
        assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, paused.threadId), deferred.recoveryLifecycle);
        if (mode === "deferred-two") {
          // Let the existing scheduler defer the second real Idea, then enter
          // its next ordinary specialist boundary, without manually inserting
          // either Case or invoking a different scheduler.
          const next = await withJobModelRuntime(runtime.runtime, () => graph.invoke(null, {
            ...cfg, interruptBefore: ["specialist_dispatch"],
          }));
          assert.equal(next.recoveryLifecycle.active, null, JSON.stringify(next.recoveryLifecycle));
          assert.equal(next.recoveryLifecycle.pending.length, 2, JSON.stringify(next.recoveryLifecycle));
          assert.equal(new Set(next.recoveryLifecycle.pending.map(c => c.id)).size, 2);
          assert.ok(next.recoveryLifecycle.pending.some(c => c.id === original!.id));
          assert.equal(next.recoveryLifecycle.deferredCaseIds?.length, 2);
          assert.equal(next.recoveryLifecycle.discharged.length, 0);
          assert.equal(next.ideaHistory.filter(h => h.status === "deferred").length, 2);
          assert.ok(next.active);
          assert.equal(next.status, "running");
          assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, paused.threadId), next.recoveryLifecycle);
          assert.equal(runtime.calls(), 4);

          const { runIdeaPlacement } = await import("../src/idea-placement.js");
          const placementRuntime = await scriptedStoryRuntime((_index, context) => {
            const messages = context.messages as Array<{role: string; content: Array<{ type: string; text?: string; name?: string }>}>;
            const prompt = messages.findLast(m => m.role === "user")!.content.map(c => c.text).join("");
            const packet = JSON.parse(prompt.slice(prompt.lastIndexOf("\nASSIGNMENT:\n") + "\nASSIGNMENT:\n".length)
              .replace(/^INDEPENDENT FULFILLMENT REVIEW[^\n]*\n/, ""));
            const path = packet.target.path;
            const assistants = messages.filter(m => m.role === "assistant");
            if (!assistants.length) {
              const reads = prompt.split("READ ALL EXACT FILE PATHS FIRST:\n")[1]!
                .split(/\n(?:Edit ONLY|Read-only independent)/)[0]!.split("\n");
              return { content: scriptedReadCalls(reads, _index), reason: "toolUse" };
            }
            if (prompt.includes("\nEdit ONLY") && assistants.length === 1)
              return { content: [{ type: "toolCall", id: "place-" + packet.ideaId, name: "write",
                arguments: { path, content: readFileSync(join(f.job.worktreeStoryRoot, path), "utf8") +
                  "\nThe archive bell marks the visitor's arrival before the testimony (" + packet.ideaId + ").\n" } }], reason: "toolUse" };
            return { content: scriptedText({ verdict: "pass", evidence: [path + ":1"],
              reason: "The arrival bell now establishes the chronology." }), reason: "stop" };
          });
          const placement = { story: f.job.storyRoot, job: f.job.jobId, skillsSource: source,
            provider: scriptedModel.provider, model: scriptedModel.id };
          const tasks = (await runIdeaPlacement({ ...placement, action: "plan" })).tasks!;
          const checkpoint = () => withJobModelRuntime(runtime.runtime, () => graph.invoke(
            { request: paused.request, pauseAfter: null }, { ...cfg, interruptBefore: ["idea_integration", "specialist_dispatch"] }));
          const discharged = [];
          for (const pending of next.recoveryLifecycle.pending) {
            const ideaId = next.recoverySources.find(s => s.caseId === pending.id)!.input.evidence!.ideaId as string;
            const target = tasks.find(task => task.id === ideaId)?.candidates[0]?.id;
            assert.ok(target);
            const placed = await withJobModelRuntime(placementRuntime.runtime, () =>
              runIdeaPlacement({ ...placement, action: "place", id: ideaId, target }));
            assert.equal(placed.status, "integrated");
            const progressed = await checkpoint();
            assert.equal(progressed.status, "running", JSON.stringify({ reason: progressed.reason,
              operation: progressed.operationRecovery, lifecycle: progressed.recoveryLifecycle }));
            discharged.push({ id: pending.id, head: placed.commitSha });
            assert.deepEqual(progressed.recoveryLifecycle.discharged.map(d => ({ id: d.case.id, head: d.correctedHeadSha })).sort((a, b) => a.id.localeCompare(b.id)),
              [...discharged].sort((a, b) => a.id.localeCompare(b.id)));
            assert.deepEqual(progressed.recoveryLifecycle.pending.map(c => c.id),
              next.recoveryLifecycle.pending.filter(c => !discharged.some(d => d.id === c.id)).map(c => c.id));
            assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, paused.threadId), progressed.recoveryLifecycle);
          }
          const firstId = next.recoverySources.find(s => s.caseId === discharged[0]!.id)!.input.evidence!.ideaId as string;
          const reassessed = await withJobModelRuntime(placementRuntime.runtime, () =>
            runIdeaPlacement({ ...placement, action: "reassess", id: firstId, record: true }));
          assert.equal(reassessed.status, "reassessed");
          const final = await checkpoint();
          const inspected = await inspectModernGenerationRecovery(f.job, saver, paused.threadId);
          assert.deepEqual(inspected.discharged, final.recoveryLifecycle.discharged,
            "A later verified Idea reassessment must not erase the first Case's historical discharge");
          assert.equal(inspected.inspectionFences.length, 0);
          assert.equal(placementRuntime.calls(), 12);
          assert.equal((await inspectPiPolicy(f.job)).budget.modelCalls - calls, 16);
          assert.equal(runtime.calls(), 4);
          assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
          assert.equal(git(f.repo, "rev-parse", "HEAD"), f.initial);
          return;
        }
      }
      assert.equal(runtime.calls(), mode === "deferred-two" ? 4 : 2, "Verification cannot replay the model or start an Idea writer");
    }
    assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
    assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
    assert.equal(git(f.repo, "rev-parse", "HEAD"), f.initial);
  } finally {
    restoreSandbox();
    saver.db.close();
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});


test("#225 unaccepted specialist result reaches assessment and remains fenced across inspect/resume", {
  skip: !available,
}, async () => {
  const f = setup("recovery-unaccepted-specialist-result");
  await useScriptedArchiveCli(f);
  const paused = f.cli([...f.start, "--pause-after", "foundation"]);
  assert.equal(paused.status, "paused");
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const calls = readFileSync(f.contract + ".model-calls", "utf8");
  const foundation = paused.inventory.items.find((item: { id: string }) => item.id === "foundation");
  assert.ok(foundation);
  const previous = Object.fromEntries(Object.keys(f.env).map(key => [key, process.env[key]]));
  Object.assign(process.env, f.env);
  const saver = SqliteSaver.fromConnString(paused.checkpointPath);
  let result: any;
  try {
    const graph = createGenerationGraph(saver, "cli");
    const config = { configurable: { thread_id: paused.threadId } };
    // The original worker has returned, but its result is not an admitted
    // completed status. Verify the production checkpoint edge, not a private
    // operation-classifier unit test.
    await graph.updateState(config, {
      status: "running", active: foundation,
      result: { status: "in-progress", headSha: head }, pauseAfter: null,
    }, "independent_assignment_review");
    result = await graph.invoke(null, config);
  } finally {
    saver.db.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.equal(result.status, "blocked");
  assert.equal(currentOperationRecovery(result)?.operation, "specialist-result");
  assert.equal(currentOperationRecovery(result)?.outcome, "returned-failure");
  assert.equal(currentOperationRecovery(result)?.phase, "fenced");
  assert.equal(currentOperationRecovery(result)?.evidence.assignmentId, "foundation");
  assert.equal(result.completedStages.length, paused.completedStages.length,
    "an unaccepted worker result must not become a verified checkpoint");
  const inspected = f.cli(["generate", "inspect"]);
  assert.deepEqual(inspected.operationRecovery, currentOperationRecovery(result));
  for (let attempt = 0; attempt < 2; attempt++) {
    const resumed = f.cli(["generate", "resume"]);
    assert.equal(resumed.status, "blocked");
    assert.deepEqual(resumed.operationRecovery, currentOperationRecovery(result));
  }
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
  assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.initial);
  assert.equal(readFileSync(f.contract + ".model-calls", "utf8"), calls,
    "Unaccepted or unauthenticated effects cannot dispatch another model.");
});

test("#225 untrusted completion preflight is assessed, not treated as complete or retried", {
  skip: !available,
}, async () => {
  const f = setup("recovery-completion-preflight");
  await useScriptedArchiveCli(f);
  const paused = f.cli([...f.start, "--pause-after", "foundation"]);
  assert.equal(paused.status, "paused");
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const calls = readFileSync(f.contract + ".model-calls", "utf8");
  const corrupted = join(f.job.stateDir, "architecture.json");
  assert.ok(!existsSync(corrupted));
  writeFileSync(corrupted, "{broken planning receipt");
  const previous = Object.fromEntries(Object.keys(f.env).map(key => [key, process.env[key]]));
  Object.assign(process.env, f.env);
  const saver = SqliteSaver.fromConnString(paused.checkpointPath);
  let result: any;
  try {
    const graph = createGenerationGraph(saver, "cli");
    const config = { configurable: { thread_id: paused.threadId } };
    await graph.updateState(config, {
      status: "running", active: null, result: null, pauseAfter: null,
    }, "author_update_intake");
    result = await graph.invoke(null, config);
  } finally {
    saver.db.close();
    unlinkSync(corrupted);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.equal(result.status, "blocked");
  assert.equal(currentOperationRecovery(result)?.operation, "completion-verification");
  assert.equal(currentOperationRecovery(result)?.phase, "fenced");
  assert.equal(result.completedStages.length, paused.completedStages.length);
  assert.deepEqual(f.cli(["generate", "inspect"]).operationRecovery, currentOperationRecovery(result));
  assert.deepEqual(f.cli(["generate", "resume"]).operationRecovery, currentOperationRecovery(result));
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
  assert.equal(readFileSync(f.contract + ".model-calls", "utf8"), calls,
    "Unaccepted or unauthenticated effects cannot dispatch another model.");
});

test("#225 failed dependency amendment is assessed without dispatching another writer", {
  skip: !available,
}, async () => {
  const f = setup("recovery-dependency-amendment");
  await useScriptedArchiveCli(f);
  const paused = f.cli([...f.start, "--pause-after", "foundation"]);
  assert.equal(paused.status, "paused");
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const calls = readFileSync(f.contract + ".model-calls", "utf8");
  const active = { ...paused.inventory.items.find((item: { id: string }) => item.id === "foundation"),
    id: "focus:missing.target", stage: "focus", milestone: "missing.target" };
  const previous = Object.fromEntries(Object.keys(f.env).map(key => [key, process.env[key]]));
  Object.assign(process.env, f.env);
  const saver = SqliteSaver.fromConnString(paused.checkpointPath);
  let result: any;
  try {
    const graph = createGenerationGraph(saver, "cli");
    const config = { configurable: { thread_id: paused.threadId } };
    await graph.updateState(config, {
      status: "running", active, result: { status: "dependency-required" }, pauseAfter: null,
    }, "specialist_dispatch");
    result = await graph.invoke(null, config);
  } finally {
    saver.db.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.equal(result.status, "blocked");
  assert.equal(currentOperationRecovery(result)?.operation, "dependency-amendment");
  assert.equal(currentOperationRecovery(result)?.phase, "fenced");
  assert.equal(currentOperationRecovery(result)?.evidence.assignmentId, active.id);
  assert.deepEqual(f.cli(["generate", "inspect"]).operationRecovery, currentOperationRecovery(result));
  assert.deepEqual(f.cli(["generate", "resume"]).operationRecovery, currentOperationRecovery(result));
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.initial);
  assert.equal(readFileSync(f.contract + ".model-calls", "utf8"), calls,
    "Unaccepted or unauthenticated effects cannot dispatch another model.");
});

test("generation rejects a lost orchestrator selection after checkpoint without repinning or replay", { skip: !available }, async () => {
  const f = setup("missing-orchestrator-selection");
  await useScriptedFoundationCli(f);
  const paused = f.cli([...f.start, "--pause-after", "foundation"]);
  assert.equal(paused.status, "paused", JSON.stringify(paused));
  const initialPin = paused.orchestrationSelection.skillSnapshot.id;
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const receiptPath = join(f.job.stateDir, "orchestrator-selection.json");
  unlinkSync(receiptPath);
  const resumed = f.cli(["generate", "resume"]);
  assert.equal(resumed.status, "blocked");
  assert.match(resumed.reason, /orchestrator receipt is missing|selection receipt is missing/i);
  assert.equal(existsSync(receiptPath), false, "a lost pin must not be replaced");
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head,
    "no specialist can run after missing source-bound selection");
  assert.notEqual(initialPin, "", "checkpoint originally recorded an immutable pin");
  assert.equal(readFileSync(f.contract + ".model-calls", "utf8").trim().split("\n").length, 8);
});

test("inspection rejects a different valid pinned method and never displays its forged provenance", { skip: !available }, async () => {
  const f = setup("swapped-orchestrator-snapshot");
  await useScriptedFoundationCli(f);
  const paused = f.cli([...f.start, "--pause-after", "foundation"]);
  assert.equal(paused.status, "paused", JSON.stringify(paused));
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");

  const changedSource = join(root, "second-method-checkout");
  git(root, "clone", "-q", source, changedSource);
  const entry = join(changedSource, "skills/nt-story-orchestrate/SKILL.md");
  writeFileSync(entry, readFileSync(entry, "utf8") + "\nTest method revision\n");
  git(changedSource, "add", ".");
  git(changedSource, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "commit", "-qm", "Revise portable method");
  const next = setup("other-orchestrator-snapshot");
  await useScriptedFoundationCli(next);
  next.start[next.start.indexOf("--skills-source") + 1] = changedSource;
  const other = next.cli([...next.start, "--pause-after", "foundation"]);
  assert.equal(other.status, "paused", JSON.stringify(other));
  assert.notEqual(other.orchestrationSelection.skillSnapshot.id,
    paused.orchestrationSelection.skillSnapshot.id);

  const receiptPath = join(f.job.stateDir, "orchestrator-selection.json");
  const forged = JSON.parse(readFileSync(receiptPath, "utf8"));
  forged.skillSnapshot = other.orchestrationSelection.skillSnapshot;
  forged.skillEntrypointSha256 = other.orchestrationSelection.skillEntrypointSha256;
  writeFileSync(receiptPath, JSON.stringify(forged));
  const inspected = f.cli(["generate", "inspect"]);
  assert.equal(inspected.status, "blocked");
  assert.match(inspected.reason, /Pinned orchestrator snapshot changed/);
  assert.equal(inspected.orchestrationSelection, null, "a mismatched receipt is not trusted provenance");
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
  const resumed = f.cli(["generate", "resume"]);
  assert.equal(resumed.status, "blocked");
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
  assert.equal(readFileSync(f.contract + ".model-calls", "utf8").trim().split("\n").length, 8);
  assert.equal(readFileSync(next.contract + ".model-calls", "utf8").trim().split("\n").length, 8);
});

test("C04 real Pi World negative selects source-bound owner strategy in the original production graph", { skip: !available }, async () => {
  const f = setup("c04-world-owner-pi");
  await useScriptedArchiveCli(f);
  const log = f.contract + ".model-calls";
  assert.equal(f.cli([...f.start, "--pause-after", "foundation"]).status, "paused");
  const paused = f.cli(["generate", "resume", "--pause-after", "architecture"]);
  assert.equal(paused.status, "paused", paused.reason + "\n" + readFileSync(log, "utf8"));
  const turnDigest = JSON.parse(readFileSync(join(f.job.stateDir, "turn-plan.json"), "utf8")).digest;
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const sources = ["nt-worldbuilding/SKILL.md", "nt-catalog/SKILL.md",
    "nt-catalog/references/records.md", "nt-catalog/references/progression.md",
    "nt-catalog/references/authority-and-validation.md",
    "nt-catalog/references/glossary.md"].map(p => "skill://" + p);
  const { runtime, observed } = await scriptedStoryRuntime(i => {
    if (i === 0) return { content: scriptedReadCalls(sources, i), reason: "toolUse" };
    if (i === 1) return { content: scriptedText({ modifiedRecords: [],
      architecturalConflicts: ["The approved Architecture assigned this upstream dependency to a separate owner; World cannot retcon it."],
      laterObligations: ["Use the original Orchestrator owner-plan amendment"] }), reason: "stop" };
    throw Error("Original Pi World contradiction cannot trigger another writer call");
  });
  const before = Object.fromEntries(Object.keys(f.env).map(key => [key, process.env[key]]));
  Object.assign(process.env, f.env);
  const restoreSandbox = fixtureSandboxClient(f.job.jobId, f.job.worktreeStoryRoot);
  try {
    const saver = SqliteSaver.fromConnString(paused.checkpointPath);
    try {
      const graph = createGenerationGraph(saver, "cli");
      const cfg = { configurable: { thread_id: paused.threadId } };
      const item = paused.inventory.items.find((i: { id: string }) => i.id === "foundations");
      assert.ok(item);
      await graph.updateState(cfg, {
        status: "running", reason: null, active: item, result: null, pauseAfter: null,
      }, "author_update_intake");
      const admitted = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptBefore: ["assess_recovery"] }));
      assert.equal(admitted.recoveryLifecycle.active?.origin.operation, "specialist-result",
        JSON.stringify({ status: admitted.status, reason: admitted.reason,
          recovery: admitted.recoveryLifecycle, sources: admitted.recoverySources,
          active: admitted.active, result: admitted.result }));
      assert.equal(admitted.recoveryLifecycle.active?.observation, "returned-failure");
      assert.equal(admitted.recoveryLifecycle.attempt, null);
      const selected = await graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] });
      assert.equal(selected.recoveryLifecycle.decision?.action, "strategy-unresolved");
      assert.equal(selected.recoveryLifecycle.decision?.reason, "unsupported-implementation");
      assert.equal(selected.recoveryLifecycle.assessorPending, false);
      assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, paused.threadId),
        selected.recoveryLifecycle,
        "A saved owner correction must authenticate the original Pi and source on restart");
      assert.equal(observed.length, 2, "Selection does not invoke any model or replacement writer");
      const stopped = await graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] });
      assert.equal(stopped.status, "blocked");
      assert.equal(stopped.recoveryLifecycle.decision?.action, "strategy-unresolved");
      assert.equal(stopped.recoveryLifecycle.decision?.reason, "unsupported-implementation");
      assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, paused.threadId), stopped.recoveryLifecycle);
      assert.equal(stopped.escalation?.kind, "dependency-replan");
      assert.equal(stopped.escalation?.requiresTrustedApproval, false,
        "In-objective owner routing is not automatically an author-only protected change");
      assert.equal(stopped.recoveryLifecycle.active?.id, admitted.recoveryLifecycle.active?.id);
      assert.equal(stopped.recoveryLifecycle.attempt, null);
      assert.equal(observed.length, 2);
      assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
    } finally { saver.db.close(); }
  } finally {
    restoreSandbox();
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

for (const nativeDiagnosis of [false, true]) test("C04 typed Character prerequisite supports reviewed World and resumes the original assignment" + (nativeDiagnosis ? " with native diagnosis" : ""), {
  skip: !available, timeout: 240_000,
}, async () => {
  const f = setup("c04-character-world-support" + (nativeDiagnosis ? "-diagnosis" : ""));
  await useScriptedArchiveCli(f);
  const paused = f.cli([...f.start, "--pause-after", "architecture"]);
  assert.equal(paused.status, "paused", paused.reason);
  const old = Object.fromEntries(Object.keys(f.env).map(key => [key, process.env[key]]));
  Object.assign(process.env, f.env);
  let saver = SqliteSaver.fromConnString(paused.checkpointPath);
  const restoreSandbox = fixtureSandboxClient(f.job.jobId, f.job.worktreeStoryRoot);
  try {
    let graph = createGenerationGraph(saver, "cli");
    const cfg = { configurable: { thread_id: paused.threadId }, recursionLimit: 1000 };
    const turn = JSON.parse(readFileSync(join(f.job.stateDir, "turn-plan.json"), "utf8"));
    const { archiveStages } = await import("./support/scripted-archive-stages.js");
    const ordinary = archiveStages(f.job, turn);
    const target = "fact.evidence-concealed", path = "facts/evidence-concealed.md";
    const correction = "The signed ledger entry is already visible to Ada when she enters the archive.";
    const receipt = () => JSON.parse(readFileSync(join(f.job.stateDir, "character-world.json"), "utf8"));
    const skills = (name: string) => boundedPinnedSources(name).map(p => "skill://" + p);
    let negative = false, planned = false, written = false, supported = false;
    let diagnosedSupport = false;
    let cleanSupport = "";
    const runtime = await scriptedStoryRuntime((index, context) => {
      const messages = context.messages as Array<{ role: string; content: string | Array<{ text?: string }> }>;
      const prompt = messages.filter(m => m.role === "user").flatMap(m =>
        typeof m.content === "string" ? [m.content] : m.content.map(c => c.text ?? "")).at(-1) ?? "";
      const stop = (v: unknown) => ({ content: scriptedText(v), reason: "stop" as const });
      const read = (paths: string[]) => ({ content: scriptedReadCalls(paths, index), reason: "toolUse" as const });
      if (prompt.includes("assigned ONE bounded canonical Story work item") && prompt.includes('"domain": "character"') && !supported) {
        assert.match(readFileSync(join(f.job.worktreeStoryRoot, path), "utf8"), /id: fact\.evidence-concealed # canonical record identity/);
        if (!negative) { negative = true; return read([...new Set([...skills("nt-character-development"), "skill://nt-catalog/references/glossary.md", path])]); }
        return stop({ modifiedRecords: [], architecturalConflicts: [correction], laterObligations: [],
          dependencyFinding: { targetId: target, obligationIndex: 1, missing: correction, affectedIds: [target],
            sources: [{ path, quote: readFileSync(join(f.job.worktreeStoryRoot, path), "utf8").split("\n").find(l => l.startsWith("id:"))! }],
            likelySpecialist: "nt-worldbuilding", authorDecisionRequired: false } });
      }
      if (prompt.includes("dependency") && prompt.includes("nt-story-orchestrate") && !supported && !written) {
        if (!planned) { planned = true; return read(["nt-story-orchestrate/SKILL.md", "nt-story-orchestrate/references/planning.md",
          "nt-catalog/SKILL.md", "nt-catalog/references/records.md", "nt-catalog/references/authority-and-validation.md"].map(p => "skill://" + p).concat(path)); }
        return stop({ target, specialist: "nt-worldbuilding", outcome: correction, reason: "Correct the existing World prerequisite for honest initial knowledge." });
      }
      if (nativeDiagnosis && written && !supported) {
        if (prompt.includes("local-repair: owner=dependency:")) {
          const raw = JSON.stringify(context.messages);
          const signature = raw.match(/signature=([a-f0-9]{64})/)?.[1];
          const sourceRef = raw.match(/sourceRef=([^;]+); category=/)?.[1];
          const owner = raw.match(/local-repair: owner=(dependency:[0-9]+:fact\.evidence-concealed)/)?.[1];
          assert.ok(signature && sourceRef && owner);
          diagnosedSupport = true;
          return stop({ schema: "noveltea-recovery-diagnostic-proposal/v1", signature, sourceRef,
            category: "defect", diagnosis: "Remove the unsupported metadata field, retaining the World correction.",
            strategy: "local-repair", owner, scopeRef: sourceRef, prerequisites: [],
            uncertainty: "Native validation and independent Review remain required." });
        }
        if (prompt.includes("INDEPENDENT DIAGNOSTIC FOLLOW-UP") && readFileSync(join(f.job.worktreeStoryRoot, path), "utf8").includes("unsupported_field:"))
          return { content: [{ type: "toolCall", name: "edit", id: "world-diagnostic-successor", arguments: { path, edits: [{ oldText: readFileSync(join(f.job.worktreeStoryRoot, path), "utf8"), newText: cleanSupport }] } }], reason: "toolUse" };
        if (cleanSupport && !prompt.includes("IMMUTABLE REVIEW PACKET"))
          return stop({ modifiedRecords: [path], architecturalConflicts: [], laterObligations: [] });
      }
      if (planned && !supported && prompt.includes("nt-worldbuilding") && !prompt.includes("IMMUTABLE REVIEW PACKET")) {
        if (!written) { written = true; return read(skills("nt-worldbuilding")); }
        const before = readFileSync(join(f.job.worktreeStoryRoot, path), "utf8");
        if (!before.includes(correction)) {
          cleanSupport = before + "\n" + correction + "\n";
          return { content: [{ type: "toolCall", name: "edit", id: "world-support-edit",
            arguments: { path, edits: [{ oldText: before, newText: nativeDiagnosis
              ? cleanSupport.replace("id: " + target, "id: " + target + "\nunsupported_field: true") : cleanSupport }] } }], reason: "toolUse" };
        }
        return stop({ modifiedRecords: [path], architecturalConflicts: [], laterObligations: [] });
      }
      if (written && !supported && prompt.includes("IMMUTABLE REVIEW PACKET")) {
        const packet = JSON.parse(prompt.split("\nIMMUTABLE REVIEW PACKET\n")[1]!);
        if (!messages.some(m => m.role === "toolResult" && JSON.stringify(m.content).includes("nt-narrative-review"))) return read(skills("nt-narrative-review"));
        const item = packet.items[0];
        supported = true;
        return stop({ sourceDigest: packet.sourceDigest, verdict: "pass", findings: [],
          evidence: [{ commitSha: item.assurance.commitSha, assignmentId: item.assignment.id, path, line: 1,
            explanation: "Verified the bounded World prerequisite." }] });
      }
      const reply = ordinary(index, context);
      if (prompt.includes('"domain": "world"') && prompt.includes("BOUND ASSIGNMENT:")) {
        for (const item of reply.content) {
          if (item.type === "toolCall" && item.name === "write" && item.arguments.path === path &&
              typeof item.arguments.content === "string")
            item.arguments.content = item.arguments.content.replace("id: " + target,
              "id: " + target + " # canonical record identity");
        }
      }
      return reply;
    });
    const item = paused.inventory.items.find((i: { id: string }) => i.id === "foundations");
    assert.ok(item);
    const initialCalls = (await inspectPiPolicy(f.job)).budget.modelCalls;
    await graph.updateState(cfg, { status: "running", reason: null, active: item, result: null, pauseAfter: null }, "author_update_intake");
    const suspended = await withJobModelRuntime(runtime.runtime, () => graph.invoke(null, { ...cfg, interruptBefore: ["dependency_amendment"] }));
    assert.ok(suspended.focusedPrerequisite?.writerSource, JSON.stringify({ reason: suspended.reason, recovery: suspended.recoverySources }));
    const original = receipt();
    assert.equal(original.units[1].phase, "conflicted");
    assert.equal(suspended.focusedPrerequisite!.writerSource!.producer.workItem, "world-foundations");
    assert.equal(suspended.focusedPrerequisite!.writerSource!.stage, "character");
    let verified = await withJobModelRuntime(runtime.runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["dependency_amendment"] }));
    if (nativeDiagnosis) {
      assert.ok(verified.recoveryLifecycle.active, JSON.stringify({ reason: verified.reason, lifecycle: verified.recoveryLifecycle }));
      const failedCase = verified.recoveryLifecycle.active.id;
      const selected = await withJobModelRuntime(runtime.runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] }));
      assert.equal(selected.recoveryLifecycle.decision?.action, "diagnostic", JSON.stringify(selected.recoveryLifecycle));
      const diagnosed = await withJobModelRuntime(runtime.runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] }));
      assert.equal(diagnosed.recoveryLifecycle.decision?.action, "plan-amendment", JSON.stringify(diagnosed.recoveryLifecycle));
      assert.equal(diagnosed.recoveryLifecycle.active?.id, failedCase);
      assert.equal(diagnosedSupport, true);
      assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, paused.threadId), diagnosed.recoveryLifecycle);
      saver.db.close(); saver = SqliteSaver.fromConnString(paused.checkpointPath); graph = createGenerationGraph(saver, "cli");
      verified = await withJobModelRuntime(runtime.runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] }));
      assert.ok(verified.recoveryLifecycle.discharged.some(e => e.case.id === failedCase), JSON.stringify({reason: verified.reason, lifecycle: verified.recoveryLifecycle}));
      assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, paused.threadId), verified.recoveryLifecycle);
    }
    assert.ok(verified.focusedPrerequisite?.supportRef, JSON.stringify({ reason: verified.reason, recovery: verified.recoverySources }));
    const ledger = (await (await import("../src/dependency-state.js")).inspectDependencyPlan(f.job))!;
    const support = ledger.entries.find(e => e.writerSource)!;
    assert.equal(support.phase, "verified");
    assert.equal(support.review?.verdict, "pass");
    assert.equal(git(f.job.worktreeRoot, "diff-tree", "--no-commit-id", "--name-only", "-r", support.commitSha!), "story/" + path);
    const revalidated = JSON.parse(readFileSync(join(f.job.stateDir, "revalidation-items", support.commitSha + ".json"), "utf8"));
    assert.equal(revalidated.state, "completed");
    assert.equal(revalidated.proposal.upstreamItemId, "foundations");
    assert.ok(revalidated.proposal.unaffected.includes("foundation"));
    assert.ok(!revalidated.results.some((r: { itemId: string }) => revalidated.proposal.unaffected.includes(r.itemId)));
    const source = suspended.focusedPrerequisite!.writerSource!;
    const archive = join(f.job.stateDir, "character-writer-prerequisites", source.sealDigest + ".json");
    const bytes = readFileSync(archive, "utf8");
    const { inspectWriterDependency } = await import("../src/writer-dependency.js");
    const forged = JSON.parse(bytes);
    forged.units[1].dependencyFinding.missing = "Invent another unsupported correction";
    const calls = (await inspectPiPolicy(f.job)).budget.modelCalls;
    try {
      writeFileSync(archive, JSON.stringify(forged));
      await assert.rejects(inspectWriterDependency(f.job, source), /original accepted Pi response|digest changed/);
    } finally { writeFileSync(archive, bytes); }
    await inspectWriterDependency(f.job, source);
    assert.equal((await inspectPiPolicy(f.job)).budget.modelCalls, calls);
    // Reopen the actual SQLite checkpoint after support and before the
    // original writer re-enters; no graph instance or in-memory approval survives.
    saver.db.close();
    saver = SqliteSaver.fromConnString(paused.checkpointPath);
    graph = createGenerationGraph(saver, "cli");
    const next = await withJobModelRuntime(runtime.runtime, () => graph.invoke(null, { ...cfg, interruptBefore: ["specialist_dispatch"] }));
    // Resume the suspended child and stop before the next ordinary assignment.
    const finished = await withJobModelRuntime(runtime.runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["verify_committed_work"] }));
    const current = receipt();
    assert.equal(current.units[0].commitSha, original.units[0].commitSha);
    assert.equal(current.units[1].phase, "committed", JSON.stringify({ reason: finished.reason, recovery: finished.recoverySources, next: next.reason }));
    assert.equal(current.units[1].assignmentKey, original.units[1].assignmentKey);
    assert.deepEqual(current.units[1].assignment, original.units[1].assignment);
    assert.equal(current.units[1].piSessionFile, original.units[1].piSessionFile);
    assert.equal(current.units[1].piSessionId, original.units[1].piSessionId);
    assert.equal(finished.inventory?.items.find(i => i.id === "foundations")?.status, "verified");
    const scheduled = await withJobModelRuntime(runtime.runtime, () => graph.invoke(null, { ...cfg, interruptBefore: ["specialist_dispatch"] }));
    assert.ok(scheduled.active && scheduled.active.id !== item.id, JSON.stringify({ reason: scheduled.reason, active: scheduled.active, recovery: scheduled.recoverySources }));
    assert.equal(scheduled.focusedPrerequisite, null);
    assert.equal(scheduled.recoveryLifecycle.active, null);
    await inspectWriterDependency(f.job, source);
    assert.equal((await inspectPiPolicy(f.job)).budget.modelCalls, initialCalls + runtime.observed.length);
    assert.equal((await (await import("../src/dependency-state.js")).inspectDependencyPlan(f.job))!.entries.filter(e => e.writerSource).length, 1);
    assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
  } finally {
    saver.db.close(); restoreSandbox();
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

/** R14C negative controls use a real admitted Case and its sealed Review.
 * A different owner or plan cannot borrow that Case or the native source. */
async function assertSubunitReviewAuthority(job: Awaited<ReturnType<typeof startStoryJob>>,
  state: GenerationGraphState, workItem: string, other: string, assignmentKey: string) {
  const c = state.recoveryLifecycle.active!;
  const d = state.recoveryLifecycle.decision!;
  assert.equal(d.action, "known-correction");
  const { authenticateOperationReviewProof } = await import("../src/generation-operation-strategy.js");
  assert.equal(await authenticateOperationReviewProof(job, state, c, d), true);
  const head = git(job.worktreeRoot, "rev-parse", "HEAD");
  const calls = (await inspectPiPolicy(job)).budget.modelCalls;
  const { executeReviewRound } = await import("../src/rejected-review-repair.js");
  await assert.rejects(executeReviewRound(job, { rootSha: c.origin.sourceHeadSha, caseId: c.id,
    assignmentKey, workItem: other }, { phase: "admit", sourceSha: c.origin.sourceHeadSha },
    { skillsSource: source, provider: scriptedModel.provider, model: scriptedModel.id }), /Foreign repair source/);
  assert.equal(await authenticateOperationReviewProof(job,
    { ...state, planVersion: (state.planVersion ?? 0) + 1 }, c, d), false);
  assert.equal(await authenticateOperationReviewProof(job, state,
    { ...c, origin: { ...c.origin, assignmentId: other } }, d), false);
  const point = (await inspectRecoveryCheckpoints(job)).find(p => p.commitSha === c.origin.sourceHeadSha)!;
  assert.equal(point.workItem, workItem);
  assert.equal(point.semanticReview, "failed");
  assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), head);
  assert.equal((await inspectPiPolicy(job)).budget.modelCalls, calls);
}

async function assertSubunitReviewSessions(job: Awaited<ReturnType<typeof startStoryJob>>,
  unit: { commitSha: string; piSessionFile: string }, successor: string) {
  const points = await inspectRecoveryCheckpoints(job);
  const original = points.find(p => p.commitSha === unit.commitSha)!;
  const corrected = points.find(p => p.commitSha === successor)!;
  assert.equal(original.semanticReview, "failed");
  assert.equal(corrected.semanticReview, "passed");
  const { inspectPostcommitReviewCycle } = await import("../src/postcommit-review-cycle.js");
  const cycle = await inspectPostcommitReviewCycle(job, original.commitSha, original.assurance!.assignmentDigest);
  assert.ok(cycle);
  assert.deepEqual(cycle.rounds.map(r => r.commitSha), [original.commitSha, successor]);
  assert.notEqual(cycle.reviewer.file, unit.piSessionFile);
  const { readRepairCommitProof } = await import("../src/checkpoint-assurance.js");
  const proof = await readRepairCommitProof(job, corrected.workItem);
  assert.equal(proof.sessionFile, unit.piSessionFile);
  assert.equal(proof.rootFailureSha, original.commitSha);
  return cycle.reviewer.file;
}

for (const mode of ["review", "support", "support-negative", "other-owner", "other-owner-world", "writer-other-owner", "future-choice", "scene-evidence", "settled-no-write", "stale-choice-finding", "diagnosis", "binding-diagnosis", "prospective", "prospective-multi", "prospective-paused", "prospective-refused", "prospective-unauthorized", "prospective-review-negative", "prospective-review-outside", "prospective-review-stalled", "prospective-review-stalled-continue", "prospective-review-author", "prospective-review-native-protocol", "prospective-review-native-diagnosis", "prospective-writer-native-diagnosis", "source-recovery", "source-diagnostic-stop", "source-provider-pause"] as const) test("R14D Event native correction and negative Review recover in the original SQLite assignment " + mode, {
  // Allow for native/Git checkpoint and diagnostic work on shared test hosts.
  skip: !available,
  timeout: mode.startsWith("source-") || mode.startsWith("prospective-") ? 480_000 :
    ["prospective", "writer-other-owner", "support", "support-negative"].includes(mode) ? 240_000 : 120_000,
}, async () => {
  const blueprintStop = mode === "source-diagnostic-stop";
  const blueprintPause = mode === "source-provider-pause";
  const sourceRecovery = mode === "source-recovery" || blueprintStop || blueprintPause;
  const settledNoWrite = mode === "settled-no-write" || mode === "stale-choice-finding";
  const refused = mode === "prospective-refused";
  const unauthorized = mode === "prospective-unauthorized";
  const negativeSupport = mode === "prospective-review-negative";
  const outsideSupport = mode === "prospective-review-outside";
  const stalledSupport = mode === "prospective-review-stalled" || mode === "prospective-review-stalled-continue";
  const continueSupport = mode === "prospective-review-stalled-continue";
  const authorSupport = mode === "prospective-review-author";
  const writerDiagnosis = mode === "prospective-writer-native-diagnosis";
  const nativeDiagnosis = mode === "prospective-review-native-diagnosis";
  const nativeSupport = mode === "prospective-review-native-protocol" || nativeDiagnosis;
  const partialPause = mode === "prospective-paused";
  const multi = mode === "prospective-multi" || partialPause || refused || unauthorized || negativeSupport || outsideSupport || stalledSupport || authorSupport || nativeSupport || writerDiagnosis;
  const prospective = mode === "prospective" || sourceRecovery || multi;
  const negativeReviewSupport = mode === "support-negative";
  const writerOwner = mode === "writer-other-owner";
  const worldOwner = mode === "other-owner-world";
  const otherOwner = mode === "other-owner" || worldOwner || writerOwner;
  const needsCharacter = mode === "support" || negativeReviewSupport;
  const bindingDiagnosis = mode === "binding-diagnosis";
  const diagnosis = mode === "diagnosis" || bindingDiagnosis;
  const f = setup("r14d-event-rounds-" + mode);
  if (needsCharacter) f.start[3] += " Include Mara, the central night witness, in the disclosure Event.";
  if (multi) f.env.NT_TEST_SCRIPTED_MULTI_ARC = "1";
  await useScriptedArchiveCli(f);
  const log = f.contract + ".model-calls";
  assert.equal(f.cli([...f.start, "--pause-after", "foundation"]).status, "paused");
  assert.equal(f.cli(["generate", "resume", "--pause-after", "architecture"]).status, "paused");
  const paused = f.cli(["generate", "resume", "--pause-after", "foundations"]);
  assert.equal(paused.status, "paused", paused.reason + "\n" + readFileSync(log, "utf8"));
  const initialCalls = (await inspectPiPolicy(f.job)).budget.modelCalls;
  const saved = Object.fromEntries(["NT_STATE_DIR", "NT_CONFIG_FILE", "NT_SKILL_CACHE_DIR",
    "NT_SANDBOX_SOCKET", "NT_SANDBOX_TOKEN_FILE",
    ].map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    NT_STATE_DIR: f.env.NT_STATE_DIR,
    NT_CONFIG_FILE: f.env.NT_CONFIG_FILE,
    NT_SKILL_CACHE_DIR: f.env.NT_SKILL_CACHE_DIR,
  });
  const restoreSandbox = fixtureSandboxClient(f.job.jobId, f.job.worktreeStoryRoot);
  let saver = SqliteSaver.fromConnString(paused.checkpointPath);
  try {
    const readSources = [...boundedPinnedSources("nt-event-design").map(p => "skill://" + p),
      "milestones/disclosure.md"];
    const plan = { schema: "noveltea-milestone-blueprint/v1", milestoneId: "milestone.disclosure",
      events: [{ id: "disclose-ledger", purpose: "The witness presents the concealed record",
        dependsOn: [], participants: ["character.ada", "character.neri"],
        evidence: [{ anchorPath: "milestones/disclosure.md",
          source: "A transfer record Neri can physically present",
          observation: "Ada sees the ledger and the prospective release decision",
          access: "Neri has the preserved original, Ada is present",
          establishes: "The witness knows where the evidence is kept",
          limits: "The release and withhold consequences still need Choice authorship", characterSources: [] }],
        knowledge: "Ada sees the ledger; only a future player choice determines its release",
        routes: [] }],
      downstream: [{ owner: "interactive",
        obligation: "Implement the release or withhold Choice and preserve both outcomes" },
      { owner: "composition", obligation: "Present evidence and the implemented Choice consequences" }],
    };
    const authored = [
      "---", "schema: '0.1'", "type: event", "id: event.disclose-ledger",
      'title: "disclose-ledger"', "status: draft", "decisions: []",
      "participants: [character.ada, character.neri]", "arcs: [arc.truth]",
      'consequences: ["Neri presents a pending opportunity to release or withhold the ledger"]',
      "after: []", "prerequisites:", "  any_of:", "    - completed: []",
      "      not_completed: []", "      conditions:",
      "        - kind: knowledge", "          character: character.neri",
      "          fact: fact.evidence-concealed", "          value: knows",
      "steps:", "  - id: decision-offered", "    branches:",
      "      - id: protect", "        conditions: []", "        effects: []",
      "      - id: challenge", "        conditions: []", "        effects: []",
      "---", "", "Neri offers Ada the choice to protect him or challenge his concealment of the ledger. The player has not yet made that choice.", "",
    ].join("\n");
    const path = "events/disclose-ledger.md";
    const quote = needsCharacter ? "Mara steps forward and identifies Neri's signature from the night shift." :
      "Ada studies Neri's signature on the ledger before the player must decide.";
    const requiredCorrection = worldOwner ? "Clarify the provenance of the concealed ledger as a verifiable Fact." : otherOwner ? "Establish Neri’s firsthand understanding of the ledger signature in his existing Character profile." : needsCharacter ? "Create a missing Character record for Mara and add her to Event participants; deliver her required on-screen witness dialogue." : quote;
    const supportPath = worldOwner ? "facts/evidence-concealed.md" : otherOwner ? "characters/neri.md" : "characters/mara.md";
    const supportTarget = worldOwner ? "fact.evidence-concealed" : "character.neri";
    const supportSpecialist = worldOwner ? "nt-worldbuilding" : "nt-character-development";
    const character = "---\nschema: '0.1'\ntype: character\nid: character.mara\ntitle: Mara\nstatus: draft\ndecisions: []\nmotivation: Protect the witness and testify truthfully\ninitial_knowledge: []\n---\n\nMara is the archive night witness. She is willing to testify to preserve the ledger and protect the witness.\n";
    const corrected = needsCharacter ? authored.replace("participants: [character.ada, character.neri]", "participants: [character.ada, character.neri, character.mara]") : authored;
    const manifest = { modifiedRecords: [path], architecturalConflicts: [], laterObligations: [
      "Formal Choice Point binding must enact the protect and challenge outcomes for this Milestone before fulfillment.",
    ] };
    const invalidDraft = bindingDiagnosis ? authored : authored.replace("value: knows", "value: known");
    const invalidManifest = bindingDiagnosis ? { ...manifest, laterObligations: [] } : manifest;
    if (prospective) {
      plan.events[0]!.participants.push("character.mara");
      Object.assign(plan.events[0]!.evidence[0]!, { anchorPath: "arcs/truth.md",
        characterSources: [{ id: "character.mara", availability: "prospective",
          role: "The archive night witness identifies the ledger signature." }] });
    }
    if (stalledSupport || nativeDiagnosis || writerDiagnosis) Object.assign(plan.events[0]!.evidence[0]!, { anchorPath: "milestones/disclosure.md" });
    if (multi && !stalledSupport && !nativeDiagnosis && !writerDiagnosis) {
      plan.events[0]!.participants.push("character.oren");
      Object.assign(plan.events[0]!.evidence[0]!, { anchorPath: "milestones/disclosure.md",
        characterSources: [
          { id: "character.mara", availability: "prospective", role: "Mara identifies the ledger signature." },
          { id: "character.oren", availability: "prospective", role: "Oren verifies the witness safety agreement." },
        ] });
    }
    const proposal = (round: number) => {
      const candidate = structuredClone(plan);
      if (round === 0) {
        candidate.events[0]!.participants = ["character.ada"];
        candidate.events[0]!.evidence[0]!.characterSources = [{ id: "character.neri", availability: "existing",
          role: "Subject of the witness's account of the signature." }];
      } else if (round < 4) candidate.events[0]!.evidence[0]!.characterSources[0]!.availability = "existing";
      return candidate;
    };
    const proposalEvidence = (round: number) => JSON.stringify(proposal(round).events[0]!.evidence);
    const { runtime, observed } = await scriptedStoryRuntime((index, context) => {
      if (sourceRecovery && index < 22) {
        const raw = JSON.stringify(context.messages);
        if (index === 16) {
          assert.match(raw, /FRESH INDEPENDENT READ-ONLY MILESTONE REVIEW DIAGNOSTIC/);
          return { content: scriptedReadCalls(readSources, index), reason: "toolUse" };
        }
        if (index === 17) {
          const messages = context.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
          const prompt = messages.filter(m => m.role === "user").flatMap(m => m.content ?? []).map(c => c.text ?? "").findLast(t => t.includes("FRESH INDEPENDENT READ-ONLY MILESTONE REVIEW DIAGNOSTIC"))!;
          const task = JSON.parse(prompt.split("\nTASK: ")[1]!.split("\nAPPROVED CONTRACT: ")[0]!);
          return { content: scriptedText({ schema: "noveltea-milestone-diagnosis/v1", action: blueprintStop ? "escalate" : "continue",
            explanation: "The actual witness is required but has not yet been realized; keep the original prospective role.",
            assessments: [{ kind: "material", reason: "The witness availability contradicts the authorized source inventory.",
              requirement: { source: "task", quote: task.slice(0, 100) },
              evidence: { eventId: "disclose-ledger", field: "evidence", quote: proposalEvidence(3) } }] }), reason: "stop" };
        }
        assert.ok(!blueprintStop || index < 18, "A sealed escalation does not authorize another writer or reviewer");
        const i = index >= 18 ? index - 2 : index;
        const round = Math.floor(i / 4);
        if (i % 4 === 0 || i % 4 === 2) {
          if (i % 4 === 2 && round < 4) assert.match(raw, /CONTROLLER SOURCE FINDINGS/);
          if (round === 4 && i % 4 === 0) assert.match(raw, /INDEPENDENT DIAGNOSTIC ADVICE/);
          return { content: scriptedReadCalls(readSources, index), reason: "toolUse" };
        }
        if (i % 4 === 1) return { content: scriptedText(proposal(round)), reason: "stop" };
        return { content: scriptedText({ schema: "noveltea-milestone-blueprint-review/v5",
          status: round === 4 ? "pass" : "revise",
          findings: round === 4 ? [] : [{ eventId: "disclose-ledger", anchorPath: "milestones/disclosure.md",
            requirement: "The actual material witness must be declared with valid availability and participation.",
            reason: round === 0 ? "The subject is mistaken for the actual witness." : "Mara is not in the authorized existing inventory.",
            correction: round === 0 ? "Identify the actual witness." : "Declare the necessary witness prospective.",
            evidence: { field: "evidence", quote: proposalEvidence(round), repair: "replace" } }],
          prior: Array.from({ length: round }, (_, j) => ({
            round: j, findingIndex: 0, status: j === 0 || round === 4 ? "resolved" : "persisting",
            reason: j === 0 || round === 4 ? "The actual material relationship was corrected." : "The unavailable witness is still claimed to exist.",
            evidence: { kind: j === 0 || round === 4 ? "revised" : "current" },
          })) }), reason: "stop" };
      }
      if (sourceRecovery) index -= 18;
      if (multi && index >= 4) {
        const messages = context.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
        const prompt = messages.filter(m => m.role === "user").flatMap(m => m.content ?? []).map(c => c.text ?? "").at(-1)!;
        const read = (paths: string[]) => ({ content: scriptedReadCalls(paths, index), reason: "toolUse" as const });
        const stop = (value: unknown) => ({ content: scriptedText(value), reason: "stop" as const });
        if (stalledSupport && index >= 11 && index <= (continueSupport ? 21 : 18)) {
          if (index === 17) {
            assert.match(prompt, /INDEPENDENT POSTCOMMIT DIAGNOSTIC/);
            return read(boundedPinnedSources("nt-narrative-review").map(p => "skill://" + p));
          }
          if (index === 18) {
            const sourceDigest = prompt.match(/sourceDigest: ([a-f0-9]{64});/)?.[1];
            assert.ok(sourceDigest);
            const packet = JSON.parse(prompt.split("IMMUTABLE SOURCE AND REQUIREMENTS: ")[1]!.split("\nORIGINAL ASSIGNMENT OUTCOME:")[0]!);
            return stop({ schema: "noveltea-postcommit-diagnosis/v1", sourceDigest,
              action: continueSupport ? "continue" : "replace",
              explanation: "The original witness obligation remains unresolved.",
              assessments: [{ kind: "cosmetic", reason: "The witness evidence remains insufficient.",
                requirement: { quote: packet.items[0].assignment.outcome.slice(0, 60) },
                evidence: { path: supportPath, quote: "Mara is the archive night witness." } }] });
          }
          if ([11, 14, 19].includes(index)) {
            assert.match(prompt, /SOURCE-LINKED REVIEW FEEDBACK/);
            const addition = index === 11 ? "Mara wears a dark coat." : index === 14 ? "Mara wears a blue coat." :
              "Mara witnessed Neri sign the concealed ledger and can identify the signature.";
            return { content: [{ type: "toolCall", id: "support-stall-repair-" + index, name: "write",
              arguments: { path: supportPath, content: character + "\n" + addition + "\n" } }], reason: "toolUse" };
          }
          if ([12, 15, 20].includes(index)) return stop("Revised the supporting Character.");
          const packet = JSON.parse(prompt.split("\nIMMUTABLE REVIEW PACKET\n")[1]!);
          const item = packet.items[0];
          const ref = { commitSha: item.assurance.commitSha, assignmentId: item.assignment.id, path: supportPath, line: 1 };
          const pass = index === 21;
          return stop({ sourceDigest: packet.sourceDigest, verdict: pass ? "pass" : "fail",
            findings: pass ? [] : [{ ...ref, kind: "continuity", message: "The supporting Character does not establish the required prospective witness role.",
              requiredCorrection: "Establish the prospective witness role.", affectedPaths: [supportPath] }],
            evidence: pass ? [{ ...ref, explanation: "The original witness obligation is now established." }] : [],
            progressDiagnosis: pass ? { status: "material", reason: "The exact causal witness evidence is present.",
              evidence: { path: supportPath, quote: "Mara witnessed Neri sign the concealed ledger and can identify the signature.", change: "added" } }
              : { status: "stalled", reason: "The clothing change does not establish the witness evidence.", evidence: null } });
        }
        if (continueSupport && index >= 22) throw Error("The resumed scheduler must not replay support or invoke a writer before its checkpoint.");
        if (writerDiagnosis && index >= 9) {
          const paths = ["arcs/archive-account.md", supportPath];
          if (index === 9 || index === 10) return stop({ modifiedRecords: paths, architecturalConflicts: [], laterObligations: [] });
          if (index === 11) {
            const raw = JSON.stringify(context.messages);
            const signature = raw.match(/signature=([a-f0-9]{64})/)?.[1];
            const sourceRef = raw.match(/sourceRef=([^;]+); category=/)?.[1];
            const owner = raw.match(/local-repair: owner=(dependency:[0-9]+:character\.mara)/)?.[1];
            assert.ok(signature && sourceRef && owner);
            return stop({ schema: "noveltea-recovery-diagnostic-proposal/v1", signature, sourceRef,
              category: "defect", diagnosis: "Remove the unsupported metadata field, preserving the original Character scope.",
              strategy: "local-repair", owner, scopeRef: sourceRef, prerequisites: [],
              uncertainty: "Native validation and independent Review remain required." });
          }
          if (index === 12) return { content: [{ type: "toolCall", id: "support-writer-diagnostic-successor", name: "write",
            arguments: { path: supportPath, content: character } }], reason: "toolUse" };
          if (index === 13) return stop({ modifiedRecords: paths, architecturalConflicts: [], laterObligations: [] });
          if (index === 14) return read(boundedPinnedSources("nt-narrative-review").map(p => "skill://" + p));
          if (index === 15) {
            const packet = JSON.parse(prompt.split("\nIMMUTABLE REVIEW PACKET\n")[1]!);
            const item = packet.items[0];
            return stop({ sourceDigest: packet.sourceDigest, verdict: "pass", findings: [],
              evidence: [{ commitSha: item.assurance.commitSha, assignmentId: item.assignment.id, path: supportPath, line: 1,
                explanation: "The original required witness role is established." }] });
          }
          throw Error("Supporting writer diagnosis must return to ordinary Event scheduling: " + index);
        }
        if (nativeDiagnosis && index >= 11) {
          if ([11, 13, 15].includes(index)) return { content: [{ type: "toolCall", id: "native-stall-" + index, name: "write",
            arguments: { path: supportPath, content: character.replace("motivation:", "unsupported_field: true\nmotivation:") + "\nMara identifies the signature. Round " + index + ".\n" } }], reason: "toolUse" };
          if (index === 12) return stop("Corrected the role but produced invalid metadata.");
          if ([14, 16].includes(index)) return stop({ modifiedRecords: [supportPath], architecturalConflicts: [], laterObligations: [] });
          if (index === 17) {
            const raw = JSON.stringify(context.messages);
            const signature = raw.match(/signature=([a-f0-9]{64})/)?.[1];
            const sourceRef = raw.match(/sourceRef=([^;]+); category=/)?.[1];
            assert.ok(signature && sourceRef);
            const owner = raw.match(/local-repair: owner=(dependency:[0-9]+:character\.mara)/)?.[1] ?? "dependency:1:character.mara";
            return stop({ schema: "noveltea-recovery-diagnostic-proposal/v1", signature, sourceRef,
              category: "defect", diagnosis: "Remove the unsupported metadata field, retaining the witness role.",
              strategy: "local-repair", owner, scopeRef: sourceRef,
              prerequisites: [], uncertainty: "Native validation and independent Review remain required." });
          }
          if (index === 18) return { content: [{ type: "toolCall", id: "native-diagnostic-successor", name: "write",
            arguments: { path: supportPath, content: character + "\nMara witnessed Neri sign the concealed ledger and can identify the signature.\n" } }], reason: "toolUse" };
          if (index === 19) return stop({ modifiedRecords: [supportPath], architecturalConflicts: [], laterObligations: [] });
          if (index === 20) {
            const packet = JSON.parse(prompt.split("\nIMMUTABLE REVIEW PACKET\n")[1]!);
            const item = packet.items[0];
            return stop({ sourceDigest: packet.sourceDigest, verdict: "pass", findings: [],
              evidence: [{ commitSha: item.assurance.commitSha, assignmentId: item.assignment.id, path: supportPath, line: 1,
                explanation: "The required witness role is now established." }] });
          }
          throw Error("Native diagnosis must return to ordinary Event scheduling: " + index);
        }
        if (nativeSupport && index >= 11) {
          if (index === 11) return { content: [{ type: "toolCall", id: "support-invalid-repair", name: "write",
            arguments: { path: supportPath, content: character.replace("motivation:", "unsupported_field: true\nmotivation:") + "\nMara identifies the signature.\n" } }], reason: "toolUse" };
          if (index === 12) return stop("Corrected the role but produced invalid metadata.");
          if (index <= 15) return stop("Still not a structured report.");
          throw Error("Native protocol failure must not replay the writer: " + index);
        }
        if (authorSupport && index === 11)
          return stop("The author must confirm whether the witness can identify the signature.");
        if (authorSupport && index >= 12) index -= 1;
        if ((negativeSupport || authorSupport) && index >= 11 && index <= 13) {
          if (index === 11) {
            assert.match(prompt, /SOURCE-LINKED REVIEW FEEDBACK/);
            return { content: [{ type: "toolCall", id: "support-review-repair", name: "write",
              arguments: { path: supportPath, content: character + "\nMara witnessed Neri sign the concealed ledger and can identify the signature.\n" } }], reason: "toolUse" };
          }
          if (index === 12) return stop("Established the prospective witness role.");
          const packet = JSON.parse(prompt.split("\nIMMUTABLE REVIEW PACKET\n")[1]!);
          const item = packet.items[0];
          return stop({ sourceDigest: packet.sourceDigest, verdict: "pass", findings: [],
            evidence: [{ commitSha: item.assurance.commitSha, assignmentId: item.assignment.id, path: supportPath, line: 1,
              explanation: "The original witness obligation is now established." }] });
        }
        if ((negativeSupport || authorSupport) && index >= 14) index -= 3;
        if (index < 18) {
          const turn = index < 11 ? 0 : 1;
          const step = (index - 4) % 7;
          const target = turn ? "character.oren" : "character.mara";
          const targetPath = "characters/" + target.slice(10) + ".md";
          const arcPath = turn ? "arcs/witness-safety.md" : "arcs/archive-account.md";
          const title = turn ? "Oren" : "Mara";
          if (step === 0) {
            assert.match(prompt, /READ-ONLY dependency orchestrator/);
            assert.match(prompt, /arc.truth/); assert.match(prompt, /arc.safety/);
            return read(prompt.split("First read these pinned methods:\n")[1]!.split("\n\nInspect")[0]!.split("\n")
              .concat("milestones/disclosure.md", "arcs/archive-account.md", "arcs/witness-safety.md"));
          }
          if (step === 1) {
            if (refused) return stop({ rejected: true, reason: "No uniquely necessary Arc is established by the cited evidence." });
            const report = JSON.parse(prompt.split("\nDependency evidence: ")[1]!);
            return stop({ target, specialist: "nt-character-development", title,
              arcIds: [unauthorized ? "arc.foreign" : turn ? "arc.safety" : "arc.truth"], outcome: report.missing,
              reason: "This role is required by the approved Milestone and belongs to the selected enclosing Arc." });
          }
          if (step === 2) return read(["nt-character-development/SKILL.md", "nt-catalog/SKILL.md",
            "nt-catalog/references/records.md"].map(p => "skill://" + p));
          if (step === 3) {
            const arc = readFileSync(join(f.job.worktreeStoryRoot, arcPath), "utf8");
            const next = arc.replace(/characters: \[([^\]]+)\]/, "characters: [$1, " + target + "]")
              .replace(/(characters:\n(?:  - [^\n]+\n)+)/, "$1  - " + target + "\n");
            assert.notEqual(next, arc);
            return { content: [
              { type: "toolCall", id: "multi-character-" + turn, name: "write", arguments: { path: targetPath, content: writerDiagnosis ? character.replace("motivation:", "unsupported_field: true\nmotivation:") :
                  turn ? character.replaceAll("Mara", "Oren").replace("character.mara", target) : character } },
              { type: "toolCall", id: "multi-arc-" + turn, name: "write", arguments: { path: arcPath, content: next } },
            ], reason: "toolUse" };
          }
          if (step === 4) return stop({ modifiedRecords: [arcPath, targetPath], architecturalConflicts: [], laterObligations: [] });
          if (step === 5) return read(boundedPinnedSources("nt-narrative-review").map(p => "skill://" + p));
          const packet = JSON.parse(prompt.split("\nIMMUTABLE REVIEW PACKET\n")[1]!);
          const item = packet.items[0];
          const ref = { commitSha: item.assurance.commitSha, assignmentId: item.assignment.id, path: targetPath, line: 1 };
          if (outsideSupport && turn === 0) return stop({ sourceDigest: packet.sourceDigest, verdict: "fail",
            findings: [{ ...ref, path: arcPath, kind: "continuity", message: "The Arc narrative needs a different authorial direction.",
              requiredCorrection: "Rewrite the Arc premise.", affectedPaths: [arcPath] }], evidence: [] });
          if ((negativeSupport || stalledSupport || authorSupport || nativeSupport) && turn === 0) return stop({ sourceDigest: packet.sourceDigest, verdict: "fail",
            findings: [{ ...ref, kind: "continuity", message: "The supporting Character does not establish the required prospective witness role.",
              requiredCorrection: "Establish the prospective witness role.", affectedPaths: [targetPath] }], evidence: [] });
          return stop({ sourceDigest: packet.sourceDigest, verdict: "pass", findings: [],
            evidence: [{ ...ref, explanation: "Required prospective role." }] });
        }
        if (index === 18) {
          assert.match(prompt, /character.mara/); assert.match(prompt, /character.oren/);
          return read(readSources);
        }
        if (index === 19) return { content: [{ type: "toolCall", id: "multi-event", name: "write", arguments: {
          path, content: authored.replace("participants: [character.ada, character.neri]", "participants: [character.ada, character.neri, character.mara, character.oren]")
            .replace("arcs: [arc.truth]", "arcs: [arc.truth, arc.safety]") + "\n" + quote + " Oren confirms the witness safety agreement.\n",
        } }], reason: "toolUse" };
        if (index === 20) return stop(manifest);
        if (index === 21) return read(boundedPinnedSources("nt-narrative-review").map(p => "skill://" + p));
        if (index === 22) {
          const packet = JSON.parse(prompt.split("\nIMMUTABLE REVIEW PACKET\n")[1]!);
          const item = packet.items[0];
          return stop({ sourceDigest: packet.sourceDigest, verdict: "pass", findings: [],
            evidence: [{ commitSha: item.assurance.commitSha, assignmentId: item.assignment.id, path, line: 1,
              explanation: "Both verified prospective witnesses participate in the Event." }] });
        }
        throw Error("Unexpected multi prospective call " + index);
      }
      if (prospective && index >= 4) {
        const messages = context.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
        const raw = JSON.stringify(messages);
        if (index === 4) return { content: scriptedReadCalls(["nt-character-development/SKILL.md", "nt-catalog/SKILL.md",
          "nt-catalog/references/records.md"].map(p => "skill://" + p), index), reason: "toolUse" };
        if (index === 5) {
          const arc = readFileSync(join(f.job.worktreeStoryRoot, "arcs/truth.md"), "utf8");
          const next = arc.replace(/characters: \[([^\]]+)\]/, "characters: [$1, character.mara]")
            .replace(/(characters:\n(?:  - [^\n]+\n)+)/, "$1  - character.mara\n");
          assert.notEqual(next, arc);
          return { content: [
            { type: "toolCall", id: "prospective-character", name: "write", arguments: { path: supportPath, content: character } },
            { type: "toolCall", id: "prospective-arc-link", name: "write", arguments: { path: "arcs/truth.md", content: next } },
          ], reason: "toolUse" };
        }
        if (index === 6) return { content: scriptedText({ modifiedRecords: ["arcs/truth.md", supportPath], architecturalConflicts: [], laterObligations: [] }), reason: "stop" };
        if (index === 7) return { content: scriptedReadCalls(boundedPinnedSources("nt-narrative-review").map(p => "skill://" + p), index), reason: "toolUse" };
        if (index === 8) {
          const prompt = messages.filter(m => m.role === "user").flatMap(m => m.content ?? []).map(c => c.text ?? "").at(-1)!;
          const packet = JSON.parse(prompt.split("\nIMMUTABLE REVIEW PACKET\n")[1]!);
          const item = packet.items[0];
          return { content: scriptedText({ sourceDigest: packet.sourceDigest, verdict: "pass", findings: [],
            evidence: [{ commitSha: item.assurance.commitSha, assignmentId: item.assignment.id, path: supportPath, line: 1,
              explanation: "Mara provides the prospective witness role." }] }), reason: "stop" };
        }
        if (index === 9) {
          assert.match(raw, /character.mara/);
          return { content: scriptedReadCalls(readSources, index), reason: "toolUse" };
        }
        if (index === 10) return { content: [{ type: "toolCall", id: "prospective-event", name: "write", arguments: {
          path, content: authored.replace("participants: [character.ada, character.neri]", "participants: [character.ada, character.neri, character.mara]") + "\n" + quote + "\n",
        } }], reason: "toolUse" };
        if (index === 11) return { content: scriptedText(manifest), reason: "stop" };
        if (index === 12) return { content: scriptedReadCalls(boundedPinnedSources("nt-narrative-review").map(p => "skill://" + p), index), reason: "toolUse" };
        if (index === 13) {
          const prompt = messages.flatMap(m => m.content ?? []).map(c => c.text ?? "").findLast(t => t.includes("\nIMMUTABLE REVIEW PACKET\n"))!;
          const packet = JSON.parse(prompt.split("\nIMMUTABLE REVIEW PACKET\n")[1]!);
          const item = packet.items[0];
          return { content: scriptedText({ sourceDigest: packet.sourceDigest, verdict: "pass", findings: [],
            evidence: [{ commitSha: item.assurance.commitSha, assignmentId: item.assignment.id, path, line: 1,
              explanation: "Verified prospective witness." }] }), reason: "stop" };
        }
        throw Error("Unexpected prospective call " + index);
      }
      if ([0, 2, 4].includes(index)) return { content: scriptedReadCalls(readSources, index), reason: "toolUse" };
      if (index === 1) return { content: scriptedText(plan), reason: "stop" };
      if (index === 3) return { content: scriptedText({ schema: "noveltea-milestone-blueprint-review/v5",
        status: "pass", findings: [], prior: [] }), reason: "stop" };
      const write = (content: string) => ({ content: [{ type: "toolCall" as const,
        id: "r14d-event-" + index, name: "write", arguments: { path, content } }], reason: "toolUse" as const });
      if (writerOwner) {
        if (index === 5) return { content: scriptedText({ modifiedRecords: [], architecturalConflicts: [requiredCorrection],
          laterObligations: [], dependencyFinding: { targetId: supportTarget, obligationIndex: 0, missing: requiredCorrection,
            affectedIds: ["milestone.disclosure", "arc.truth", supportTarget],
            sources: ["milestones/disclosure.md", "arcs/truth.md", supportPath].map(path => ({
              path, quote: readFileSync(join(f.job.worktreeStoryRoot, path), "utf8").split("\n").find(l => l.startsWith("id:"))!,
            })), likelySpecialist: supportSpecialist, authorDecisionRequired: false } }), reason: "stop" };
        if (index === 6) return { content: scriptedReadCalls([
          "nt-story-orchestrate/SKILL.md", "nt-story-orchestrate/references/planning.md",
          "nt-catalog/SKILL.md", "nt-catalog/references/records.md", "nt-catalog/references/authority-and-validation.md",
        ].map(p => "skill://" + p).concat(supportPath), index), reason: "toolUse" };
        if (index === 7) return { content: scriptedText({ target: supportTarget, specialist: supportSpecialist,
          outcome: requiredCorrection, reason: "The original Event uses this existing typed prerequisite." }), reason: "stop" };
        if (index === 8) return { content: scriptedReadCalls([supportSpecialist + "/SKILL.md", "nt-catalog/SKILL.md",
          "nt-catalog/references/records.md"].map(p => "skill://" + p), index), reason: "toolUse" };
        if (index === 9) {
          const before = readFileSync(join(f.job.worktreeStoryRoot, supportPath), "utf8");
          return { content: [{ type: "toolCall", id: "writer-support", name: "edit",
            arguments: { path: supportPath, edits: [{ oldText: before, newText: before + "\nNeri personally verified the concealed ledger signature during his night shift.\n" }] } }], reason: "toolUse" };
        }
        if (index === 10) return { content: scriptedText({ modifiedRecords: [supportPath], architecturalConflicts: [], laterObligations: [] }), reason: "stop" };
        if ([11, 20].includes(index)) return { content: scriptedReadCalls(boundedPinnedSources("nt-narrative-review").map(p => "skill://" + p), index), reason: "toolUse" };
        if ([12, 21].includes(index)) {
          const messages = context.messages as Array<{ content: Array<{ type: string; text?: string }> }>;
          const prompt = messages.flatMap(m => Array.isArray(m.content) ? m.content : [])
            .map(c => c.text ?? "").findLast(t => t.includes("\nIMMUTABLE REVIEW PACKET\n"))!;
          const packet = JSON.parse(prompt.split("\nIMMUTABLE REVIEW PACKET\n")[1]!);
          const item = packet.items[0];
          return { content: scriptedText({ sourceDigest: packet.sourceDigest, verdict: "pass", findings: [],
            evidence: [{ commitSha: item.assurance.commitSha, assignmentId: item.assignment.id,
              path: index === 12 ? supportPath : path, line: 1, explanation: "Verified bounded assignment." }] }), reason: "stop" };
        }
        if ([13, 15, 17].includes(index)) {
          if (index === 17) assert.match(JSON.stringify(context.messages), /AUTHENTICATED VERIFIED PREREQUISITE/);
          return { content: scriptedReadCalls(readSources, index), reason: "toolUse" };
        }
        if (index === 14) return { content: scriptedText(plan), reason: "stop" };
        if (index === 16) return { content: scriptedText({ schema: "noveltea-milestone-blueprint-review/v5", status: "pass", findings: [], prior: [] }), reason: "stop" };
        if (index === 18) return write(authored);
        if (index === 19) return { content: scriptedText(manifest), reason: "stop" };
        throw Error("Unexpected writer prerequisite call " + index);
      }
      if (mode === "future-choice" || mode === "scene-evidence" || settledNoWrite) {
        if (index === 5) return { content: scriptedReadCalls(["milestones/disclosure.md"], index), reason: "toolUse" };
        if (index === 6) {
          const receipt = JSON.parse(readFileSync(join(f.job.stateDir, "event-items/disclosure.json"), "utf8"));
          const pinDigest = mode === "stale-choice-finding" ? "f".repeat(64) : receipt.blueprintPin.digest;
          return { content: scriptedText({ modifiedRecords: [], architecturalConflicts: [mode === "scene-evidence"
            ? plan.events[0]!.evidence[0]!.establishes : plan.downstream[0]!.obligation], laterObligations: [],
            ...(mode === "future-choice" || mode === "stale-choice-finding" ? { blueprintFinding: { kind: "downstream", pinDigest, downstreamIndex: 0 } } :
              mode === "scene-evidence" ? { blueprintFinding: { kind: "scene-evidence", pinDigest, eventId: "disclose-ledger", evidenceIndex: 0 } } : {}) }), reason: "stop" };
        }
        if (index === 7) assert.match(JSON.stringify(context.messages), mode === "scene-evidence" ? /event-planned-evidence/ : /event-future-interaction/);
      }
      if (index === 5) return write(invalidDraft);
      if (diagnosis && index >= 7) {
        if (index === 7 || index === 9) {
          if (bindingDiagnosis) assert.match(JSON.stringify(context.messages), /event-missing-binding/);
          return write(invalidDraft + "\nRepeated unresolved defect.\n");
        }
        if (index === 6 || index === 8 || index === 10)
          return { content: scriptedText(invalidManifest), reason: "stop" };
        if (index === 13) return { content: scriptedText(manifest), reason: "stop" };
        if (index === 11) {
          const raw = JSON.stringify(context.messages);
          const signature = raw.match(/signature=([a-f0-9]{64})/)?.[1];
          const sourceRef = raw.match(/sourceRef=([^;]+); category=/)?.[1];
          assert.ok(signature && sourceRef);
          if (bindingDiagnosis) {
            assert.match(raw, /event-missing-binding/);
            assert.match(raw, /local-repair: owner=event:milestone.disclosure/);
          }
          return { content: scriptedText({ schema: "noveltea-recovery-diagnostic-proposal/v1", signature, sourceRef,
            category: bindingDiagnosis ? "invalid-assignment" : "defect", diagnosis: bindingDiagnosis
              ? "The Event is structurally sound but the manifest omitted the current Milestone's outstanding formal Choice binding. Restore that precise handoff without claiming fulfillment."
              : "The Event knowledge condition must use the valid enum value knows.",
            strategy: "local-repair", owner: "event:milestone.disclosure",
            scopeRef: bindingDiagnosis ? "Only the original Milestone binding, preserving its body and decisions" : sourceRef,
            prerequisites: bindingDiagnosis ? ["Run story_validate and report the cumulative manifest.", "Independent semantic Review must verify narrative sufficiency."] : [],
            uncertainty: "The native validator must verify the exact original Event correction." }), reason: "stop" };
        }
        if (index === 12) return write(authored);
        if (index === 14) return { content: scriptedReadCalls(boundedPinnedSources("nt-narrative-review").map(p => "skill://" + p), index), reason: "toolUse" };
        if (index === 15) {
          const messages = context.messages as Array<{ content: Array<{ type: string; text?: string }> }>;
          const prompt = messages.flatMap(m => Array.isArray(m.content) ? m.content : [])
            .map(c => c.text ?? "").findLast(t => t.includes("\nIMMUTABLE REVIEW PACKET\n"));
          assert.ok(prompt);
          const packet = JSON.parse(prompt.split("\nIMMUTABLE REVIEW PACKET\n")[1]!);
          const item = packet.items[0];
          return { content: scriptedText({ sourceDigest: packet.sourceDigest, verdict: "pass", findings: [],
            evidence: [{ commitSha: item.assurance.commitSha, assignmentId: item.assignment.id, path, line: 1,
              explanation: bindingDiagnosis ? "Source-grounded decision setup with the exact outstanding formal Choice handoff." : "Valid knowledge condition and exact bounded Event." }] }), reason: "stop" };
        }
        throw Error("Unexpected diagnostic Event call " + index);
      }
      if (index === 6 || index === 8) return { content: scriptedText(index === 6 && bindingDiagnosis ? invalidManifest : manifest), reason: "stop" };
      if (index === 7) {
        assert.match(JSON.stringify(context.messages), /SOURCE-BOUND STORY CORRECTION/);
        return write(authored);
      }
      if (index === 9) return { content: scriptedReadCalls(boundedPinnedSources("nt-narrative-review").map(p => "skill://" + p), index), reason: "toolUse" };
      if (otherOwner && index >= 11) {
        const messages = context.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
        const prompt = messages.filter(m => m.role === "user").flatMap(m => m.content ?? []).map(c => c.text ?? "").at(-1)!;
        if (index === 11) {
          assert.match(prompt, /OUT_OF_AUTHORITY:/);
          return { content: scriptedText("OUT_OF_AUTHORITY: " + supportPath), reason: "stop" };
        }
        if (index === 12) return { content: scriptedReadCalls([
          "nt-story-orchestrate/SKILL.md", "nt-story-orchestrate/references/planning.md",
          "nt-catalog/SKILL.md", "nt-catalog/references/records.md", "nt-catalog/references/authority-and-validation.md",
        ].map(p => "skill://" + p).concat(supportPath), index), reason: "toolUse" };
        if (index === 13) return { content: scriptedText({ target: supportTarget, specialist: supportSpecialist,
          outcome: requiredCorrection, reason: "The original Event uses this existing typed prerequisite." }), reason: "stop" };
        if (index === 14) return { content: scriptedReadCalls([supportSpecialist + "/SKILL.md", "nt-catalog/SKILL.md",
          "nt-catalog/references/records.md"].map(p => "skill://" + p), index), reason: "toolUse" };
        if (index === 15) {
          const before = readFileSync(join(f.job.worktreeStoryRoot, supportPath), "utf8");
          return { content: [{ type: "toolCall", id: "existing-neri", name: "edit",
            arguments: { path: supportPath, edits: [{ oldText: before, newText: before +
              (worldOwner ? "\nThe signed transfer record verifies the concealment independently of testimony.\n" :
              "\nNeri personally verified the concealed ledger signature during his night shift.\n") }] } }], reason: "toolUse" };
        }
        if (index === 16) return { content: scriptedText({ modifiedRecords: [supportPath], architecturalConflicts: [], laterObligations: [] }), reason: "stop" };
        if (index === 17) return { content: scriptedReadCalls(boundedPinnedSources("nt-narrative-review").map(p => "skill://" + p), index), reason: "toolUse" };
        if (index === 18) {
          const packet = JSON.parse(prompt.split("\nIMMUTABLE REVIEW PACKET\n")[1]!);
          const item = packet.items[0];
          return { content: scriptedText({ sourceDigest: packet.sourceDigest, verdict: "pass", findings: [],
            evidence: [{ commitSha: item.assurance.commitSha, assignmentId: item.assignment.id, path: supportPath, line: 1,
              explanation: "The original typed prerequisite is now established." }] }), reason: "stop" };
        }
        if (prompt.includes("You are the independent nt-narrative-review editor")) {
          const assignment = JSON.parse(prompt.split("\nASSIGNMENT:\n")[1]!);
          if (index === 19) return { content: scriptedReadCalls(prompt.split("PINNED REFERENCES:\n")[1]!.split("\nSTORY PATHS:")[0]!
            .split("\n").filter(p => p.startsWith("skill://")).concat(assignment.paths), index), reason: "toolUse" };
          return { content: scriptedText({ verdict: "pass", findings: [], evidence: assignment.paths.map((p: string) =>
            p + ":1: The original Event is now grounded in the verified supporting record.") }), reason: "stop" };
        }
        throw Error("Unexpected whole-Story other-owner prompt " + index + ": " + prompt.slice(0, 800));
      }
      if (negativeReviewSupport && index >= 18 && index <= 20) {
        if (index === 18) {
          assert.match(JSON.stringify(context.messages), /SOURCE-LINKED REVIEW FEEDBACK/);
          return { content: [{ type: "toolCall", id: "r14d-review-support-correction", name: "write",
            arguments: { path: supportPath, content: character + "\nMara witnessed the ledger signature firsthand and can identify it.\n" } }], reason: "toolUse" };
        }
        if (index === 19) return { content: scriptedText("Established the witness's firsthand evidence."), reason: "stop" };
        const messages = context.messages as Array<{ content: Array<{ text?: string }> }>;
        const prompt = messages.flatMap(m => m.content ?? []).map(c => c.text ?? "").findLast(t => t.includes("\nIMMUTABLE REVIEW PACKET\n"))!;
        const packet = JSON.parse(prompt.split("\nIMMUTABLE REVIEW PACKET\n")[1]!);
        const item = packet.items[0];
        return { content: scriptedText({ sourceDigest: packet.sourceDigest, verdict: "pass", findings: [],
          evidence: [{ commitSha: item.assurance.commitSha, assignmentId: item.assignment.id, path: supportPath, line: 1,
            explanation: "The Character can now establish the signature from firsthand evidence." }] }), reason: "stop" };
      }
      if (needsCharacter && index >= 11 && index <= 17) {
        if (index === 11) return { content: scriptedReadCalls([
          "nt-story-orchestrate/SKILL.md", "nt-story-orchestrate/references/planning.md",
          "nt-catalog/SKILL.md", "nt-catalog/references/records.md", "nt-catalog/references/authority-and-validation.md",
        ].map(p => "skill://" + p).concat(path, "characters/ada.md", "characters/neri.md"), index), reason: "toolUse" };
        if (index === 12) return { content: scriptedText({ target: "character.mara", specialist: "nt-character-development",
          title: "Mara", outcome: requiredCorrection, reason: "The original Turn explicitly requires this distinct night witness." }), reason: "stop" };
        if (index === 13) return { content: scriptedReadCalls(["nt-character-development/SKILL.md", "nt-catalog/SKILL.md",
          "nt-catalog/references/records.md"].map(p => "skill://" + p), index), reason: "toolUse" };
        if (index === 14) return { content: [{ type: "toolCall", id: "r14d-character", name: "write", arguments: { path: supportPath, content: character } }], reason: "toolUse" };
        if (index === 15) return { content: scriptedText({ modifiedRecords: [supportPath], architecturalConflicts: [], laterObligations: [] }), reason: "stop" };
        const messages = context.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
        const prompt = messages.filter(m => m.role === "user").flatMap(m => m.content ?? []).map(c => c.text ?? "").at(-1)!;
        const packet = JSON.parse(prompt.split("\nIMMUTABLE REVIEW PACKET\n")[1]!);
        const item = packet.items[0];
        assert.match(item.assignment.id, /^dependency:/);
        if (index === 16) return { content: scriptedReadCalls(boundedPinnedSources("nt-narrative-review").map(p => "skill://" + p), index), reason: "toolUse" };
        const ref = { commitSha: item.assurance.commitSha, assignmentId: item.assignment.id, path: supportPath, line: 1 };
        return { content: scriptedText({ sourceDigest: packet.sourceDigest, verdict: negativeReviewSupport ? "fail" : "pass",
          findings: negativeReviewSupport ? [{ ...ref, kind: "continuity", message: "The witness's firsthand evidence is unclear.",
            requiredCorrection: "Establish her firsthand knowledge of the ledger signature in the existing Character.", affectedPaths: [supportPath] }] : [],
          evidence: negativeReviewSupport ? [] : [{ ...ref, explanation: "Mara has a source-grounded role as required." }] }), reason: "stop" };
      }
      const correctionIndex = needsCharacter ? negativeReviewSupport ? 21 : 18 : 11;
      if (index === correctionIndex) return write(corrected + "\n" + quote + "\n");
      if (index === correctionIndex + 1) return { content: scriptedText("Clarified the source-linked observation."), reason: "stop" };
      if (index === 10 || index === correctionIndex + 2) {
        const messages = context.messages as Array<{ content: Array<{ type: string; text?: string }> }>;
        const prompt = messages.flatMap(m => Array.isArray(m.content) ? m.content : [])
          .map(c => c.text ?? "").findLast(t => t.includes("\nIMMUTABLE REVIEW PACKET\n"));
        assert.ok(prompt);
        const packet = JSON.parse(prompt.split("\nIMMUTABLE REVIEW PACKET\n")[1]!);
        const item = packet.items[0];
        const ref = { commitSha: item.assurance.commitSha, assignmentId: item.assignment.id, path, line: 1 };
        return { content: scriptedText({ sourceDigest: packet.sourceDigest, verdict: index === 10 ? "fail" : "pass",
          findings: index === 10 ? [{ ...ref, kind: "missing-requirement", message: "The visible evidence is insufficiently explicit.",
            requiredCorrection, affectedPaths: otherOwner ? [path, supportPath] : [path] }] : [],
          evidence: index !== 10 ? [{ ...ref, explanation: quote }] : [],
          ...(index !== 10 ? { progressDiagnosis: { status: "material", reason: "Added visible observation.",
            evidence: { path, quote, change: "added" } } } : {}),
        }), reason: "stop" };
      }
      throw Error("Unexpected Event assignment call " + index);
    });
    let graph = createGenerationGraph(saver, "cli");
    const cfg = { configurable: { thread_id: paused.threadId }, recursionLimit: 1000 };
    const item = paused.inventory.items.find((entry: { id: string }) => entry.id === "event:milestone.disclosure");
    assert.ok(item);
    const turnDigest = JSON.parse(readFileSync(join(f.job.stateDir, "turn-plan.json"), "utf8")).digest;
    await graph.updateState(cfg, { status: "running", reason: null, active: item, result: null, pauseAfter: null,
    }, "author_update_intake");
    async function crashAtSubmission(status: string, calls: number, options: { interruptBefore?: string[]; interruptAfter?: string[] }) {
      const abort = new AbortController();
      const put = saver.put.bind(saver);
      const putWrites = saver.putWrites.bind(saver);
      let crashed = false;
      const error = Error("R14D injected SQLite loss after " + status);
      saver.put = async (...args) => {
        if (crashed) throw error;
        return put(...args);
      };
      saver.putWrites = async (config, writes, task) => {
        if (crashed) throw error;
        const submission = writes.find(([channel]) => channel === "submission")?.[1] as { status?: string } | undefined;
        if (config.configurable?.checkpoint_ns?.includes("assignment-") && submission?.status === status && observed.length === calls) {
          crashed = true;
          abort.abort(error);
          throw error;
        }
        return putWrites(config, writes, task);
      };
      await assert.rejects(withJobModelRuntime(runtime, async () => {
        const result = await graph.invoke(null, { ...cfg, ...options, signal: abort.signal, durability: "sync" });
        throw Error("Missing intended checkpoint loss: " + JSON.stringify({ reason: result.reason,
          status: result.status, recovery: result.recoveryLifecycle, calls: observed.length,
          }));
      }), err => { if (!crashed) throw err; return true; });
      assert.ok(crashed);
      assert.equal(observed.length, calls);
      saver.db.close();
      saver = SqliteSaver.fromConnString(paused.checkpointPath);
      graph = createGenerationGraph(saver, "cli");
    }
    if (writerOwner) {
      const suspended = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptBefore: ["dependency_amendment"] }));
      assert.ok(suspended.focusedPrerequisite?.writerSource, JSON.stringify({ reason: suspended.reason, lifecycle: suspended.recoveryLifecycle, calls: observed.length }));
      assert.equal(suspended.focusedPrerequisite.suspension.pendingPhase, "writer");
      assert.equal(observed.length, 6);
      const original = JSON.parse(readFileSync(join(f.job.stateDir, "event-items/disclosure.json"), "utf8"));
      assert.equal(original.phase, "prerequisite-reported");
      await crashAtSubmission("focused-committed", 11, { interruptAfter: ["dependency_amendment"] });
      const supported = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["dependency_amendment"] }));
      assert.ok(supported.focusedPrerequisite?.supportRef, JSON.stringify({ reason: supported.reason, lifecycle: supported.recoveryLifecycle, calls: observed.length }));
      assert.deepEqual(supported.focusedPrerequisite.identity, suspended.focusedPrerequisite.identity);
      const { inspectDependencyPlan } = await import("../src/dependency-state.js");
      const entry = (await inspectDependencyPlan(f.job))!.entries[0]!;
      assert.equal(entry.phase, "verified");
      assert.equal(entry.writerSource?.producer.workItem, "character-foundations");
      const rebound = JSON.parse(readFileSync(join(f.job.stateDir, "event-items/disclosure.json"), "utf8"));
      assert.equal(rebound.expectedHead, entry.commitSha);
      assert.equal(rebound.sessionId, original.sessionId);
      assert.equal(rebound.assignmentKey, original.assignmentKey);
      const after = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["specialist_dispatch"] }));
      assert.equal(after.result?.status, "event-cluster-committed", JSON.stringify({ reason: after.reason, lifecycle: after.recoveryLifecycle, sources: after.recoverySources, calls: observed.length }));
      const committed = JSON.parse(readFileSync(join(f.job.stateDir, "event-items/disclosure.json"), "utf8"));
      assert.equal(committed.sessionId, original.sessionId);
      assert.equal(committed.assignmentKey, original.assignmentKey);
      assert.notDeepEqual(committed.blueprintPin, original.blueprintPin);
      assert.equal(committed.blueprintPin.sourceSha, entry.commitSha);
      const next = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptBefore: ["specialist_dispatch"] }));
      assert.equal(next.inventory?.items.find(i => i.id === item.id)?.status, "verified");
      assert.equal(next.active?.id, "event:milestone.reckoning");
      assert.equal(observed.length, 22);
      assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
      return;
    }
    if (settledNoWrite) {
      const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
      await crashAtSubmission("event-prerequisite-reported", 7, { interruptBefore: ["assess_recovery"] });
      const failed = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptBefore: ["assess_recovery"] }));
      assert.equal(observed.length, 7, "Settled prose naming a future Choice cannot open another session");
      assert.equal(failed.recoveryLifecycle.active?.origin.operation, "specialist-result", JSON.stringify(failed.reason));
      assert.equal(failed.recoveryLifecycle.active?.origin.assignmentId, item.id);
      assert.equal(failed.inventory?.items.find(i => i.id === item.id)?.status, "blocked");
      assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
      const receipt = JSON.parse(readFileSync(join(f.job.stateDir, "event-items/disclosure.json"), "utf8"));
      assert.equal(receipt.phase, "prerequisite-reported");
      assert.equal(receipt.invocationProof.ordinal, 0);
      const { inspectEventNoWrite, authenticateSettledEventNoWrite } = await import("../src/event-work.js");
      const original = await inspectEventNoWrite(f.job, receipt.milestoneId, head, receipt.planVersion);
      // Causal approval/replay and historical inspection use this very same
      // immutable invocation gate, rather than trusting the sealed digest.
      assert.deepEqual(await authenticateSettledEventNoWrite(f.job, receipt), original.prerequisite);
      await assert.rejects(authenticateSettledEventNoWrite(f.job, { ...receipt, invocationProof: undefined }),
        /settled invocation proof/);
      await assert.rejects(authenticateSettledEventNoWrite(f.job, { ...receipt,
        causalDiscovery: { sourcePath: "milestones/disclosure.md", sourceQuote: "fake quote",
          violatedObligation: "fake obligation", proposedCorrection: "fake amendment" } }),
        /differs from the original settled response/);
      assert.deepEqual(original.conflicts, [plan.downstream[0]!.obligation]);
      const recoveryCase = failed.recoveryLifecycle.active!;
      const decision = await selectOperationStrategy(f.job, failed, recoveryCase);
      assert.equal(decision?.action, "diagnostic");
      assert.equal(decision?.evidence.at(-1)?.digest, receipt.prerequisite.reportDigest);
      const assessed = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] }));
      assert.deepEqual(assessed.recoveryLifecycle.decision, decision);
      assert.equal(assessed.recoveryLifecycle.active?.id, recoveryCase.id);
      // Even a self-consistent receipt and graph pin cannot replace the actual
      // settled writer invocation. The diagnostic must reauthenticate it.
      const receiptFile = join(f.job.stateDir, "event-items/disclosure.json");
      writeFileSync(receiptFile, JSON.stringify({ ...receipt, invocationProof: undefined }));
      await assert.rejects(selectOperationStrategy(f.job, failed, recoveryCase), /settled invocation proof/);
      writeFileSync(receiptFile, JSON.stringify({ ...receipt,
        conflicts: ["A substituted upstream requirement"] }));
      await assert.rejects(inspectEventNoWrite(f.job, receipt.milestoneId, head, receipt.planVersion),
        /differs from the original settled response/);
      writeFileSync(receiptFile, JSON.stringify(receipt));
      assert.deepEqual(await selectOperationStrategy(f.job, failed, recoveryCase), decision);
      assert.equal(observed.length, 7, "Inspection never starts another model call");
      return;
    }
    if (prospective) {
      const offset = sourceRecovery ? 18 : 0;
      let blueprintCaseId: string | undefined;
      if (sourceRecovery) {
        const originalHead = git(f.job.worktreeRoot, "rev-parse", "HEAD");
        const original = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptBefore: ["assess_recovery"] }));
        const c = original.recoveryLifecycle.active;
        assert.equal(c?.kind, "semantic", "Well-formed witness/source defects must reach substantive recovery, not format exhaustion or an integrity fence");
        assert.ok(c);
        assert.equal(observed.length, 16, JSON.stringify({ reason: original.reason, lifecycle: original.recoveryLifecycle }));
        blueprintCaseId = c.id;
        assert.equal(c.origin.assignmentId, item.id);
        assert.equal(c.origin.sourceHeadSha, originalHead);
        assert.equal(original.recoveryLifecycle.attempt, null);
        const blueprintFile = join(f.job.stateDir, "milestone-blueprints/disclosure.json");
        const before = JSON.parse(readFileSync(blueprintFile, "utf8"));
        assert.deepEqual(before.rounds.map((r: any) => r.review.status), ["revise", "revise", "revise", "revise"]);
        assert.equal(before.rounds[1].draftDigest, before.rounds[3].draftDigest);
        const decision = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] }));
        assert.equal(decision.recoveryLifecycle.active?.id, c.id);
        assert.equal(decision.recoveryLifecycle.decision?.action, "known-correction");
        assert.equal(decision.recoveryLifecycle.decision?.adapter, "review-cycle");
        assert.equal(observed.length, 16);
        saver.db.close();
        saver = SqliteSaver.fromConnString(paused.checkpointPath);
        graph = createGenerationGraph(saver, "cli");
        if (blueprintPause) {
          const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
          const unavailable = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
          const unavailableResult = await withJobModelRuntime(unavailable, () => graph.invoke(null, cfg));
          assert.equal(unavailableResult.status, "paused", unavailableResult.reason ?? "");
          assert.equal(unavailableResult.recoveryLifecycle.decision?.reason, "provider-unavailable");
          assert.equal(unavailableResult.recoveryLifecycle.active?.id, c.id);
          assert.equal((await inspectPiPolicy(f.job)).budget.modelCalls - initialCalls, 16);
          assert.deepEqual(JSON.parse(readFileSync(blueprintFile, "utf8")), before,
            "A provider absence before Pi session admission must preserve the verified revision boundary");
          saver.db.close();
          saver = SqliteSaver.fromConnString(paused.checkpointPath);
          graph = createGenerationGraph(saver, "cli");
          const selectedAgain = await withJobModelRuntime(runtime, () => graph.invoke({ request: paused.request, pauseAfter: null },
            { ...cfg, interruptAfter: ["assess_recovery"] }));
          assert.deepEqual(selectedAgain.recoveryLifecycle.decision, decision.recoveryLifecycle.decision);
        }
        const settled = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] }));
        if (blueprintStop) {
          assert.equal(settled.status, "blocked");
          assert.equal(settled.recoveryLifecycle.decision?.action, "exhausted", settled.reason ?? "");
          assert.equal(settled.recoveryLifecycle.decision?.reason, "nonconverging");
          assert.equal(settled.recoveryLifecycle.active?.id, c.id);
          assert.equal(settled.recoveryLifecycle.discharged.length, 0);
          assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, paused.threadId), settled.recoveryLifecycle);
          const stopped = JSON.parse(readFileSync(blueprintFile, "utf8"));
          assert.deepEqual(stopped.rounds, before.rounds);
          assert.equal(stopped.diagnostics[0]?.diagnosis.action, "escalate");
          assert.equal(stopped.approvedDigest, undefined);
          assert.equal(observed.length, 18);
          assert.equal((await inspectPiPolicy(f.job)).budget.modelCalls - initialCalls, 18);
          assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), originalHead);
          assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
          return;
        }
        assert.ok(settled.recoveryLifecycle.discharged.some(d => d.case.id === c.id),
          JSON.stringify({ reason: settled.reason, lifecycle: settled.recoveryLifecycle, calls: observed.length }));
        assert.equal(observed.length, 22);
        const after = JSON.parse(readFileSync(blueprintFile, "utf8"));
        assert.equal(after.writer.id, before.writer.id);
        assert.equal(after.reviewer.id, before.reviewer.id);
        assert.equal(after.assignmentKey, before.assignmentKey);
        assert.equal(after.phase, "approved");
        assert.equal(after.diagnostics.length, 1);
        assert.deepEqual(after.rounds.map((r: any) => r.review.status), ["revise", "revise", "revise", "revise", "pass"]);
        assert.equal(settled.recoveryLifecycle.discharged.filter(d => d.case.id === c.id).length, 1);
        assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), originalHead);
        assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
        assert.ok(observed.every(o => !o.tools.some(t => ["write", "edit", "bash"].includes(t))));
        assert.ok(observed.every(o => !JSON.stringify(o.messages).includes("FORMAT CORRECTION")));
      }
      const failed = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptBefore: ["assess_recovery"] }));
      assert.equal(failed.recoveryLifecycle.active?.origin.assignmentId, item.id, JSON.stringify({ reason: failed.reason, lifecycle: failed.recoveryLifecycle, calls: observed.length }));
      assert.equal(observed.length, 4 + offset);
      if (blueprintCaseId) {
        assert.notEqual(failed.recoveryLifecycle.active?.id, blueprintCaseId);
        assert.equal(failed.recoveryLifecycle.discharged.filter(d => d.case.id === blueprintCaseId).length, 1);
      }
      const before = JSON.parse(readFileSync(join(f.job.stateDir, "event-items/disclosure.json"), "utf8"));
      assert.equal(before.blueprintPrerequisite.blockers[0].characterId, "character.mara");
      assert.equal(before.sessionFile, undefined);
      const chosen = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] }));
      assert.equal(chosen.recoveryLifecycle.decision?.adapter, "dependency-work");
      if (refused || unauthorized || outsideSupport) {
        const blocked = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] }));
        assert.equal(blocked.status, "blocked");
        assert.equal(blocked.recoveryLifecycle.active?.id, failed.recoveryLifecycle.active?.id);
        assert.equal(blocked.recoveryLifecycle.decision?.action, "strategy-unresolved",
          "Authenticated prerequisite ambiguity or refusal must remain unresolved, not become an integrity fence");
        assert.equal(blocked.recoveryLifecycle.decision?.reason,
          outsideSupport ? "support-review-negative" : unauthorized ? "authorization-refused" : "planning-needed", JSON.stringify(blocked.recoveryLifecycle));
        assert.equal(blocked.recoveryLifecycle.inspectionFences.length, 0);
        assert.equal(blocked.recoveryLifecycle.discharged.length, failed.recoveryLifecycle.discharged.length);
        assert.equal(observed.length, outsideSupport ? 11 : 6);
        const { inspectDependencyPlan } = await import("../src/dependency-state.js");
        const entries = (await inspectDependencyPlan(f.job))!.entries;
        assert.equal(entries.length, 1);
        assert.equal(entries[0]!.phase, "rejected");
        if (outsideSupport) {
          assert.ok(entries[0]!.amendment);
          assert.equal(entries[0]!.review?.verdict, "block");
          assert.equal(entries[0]!.commitSha, entries[0]!.supportRootSha);
          assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), entries[0]!.supportRootSha);
        } else {
          assert.equal(entries[0]!.amendment, undefined);
          assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), before.expectedHead);
        }
        assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, paused.threadId), blocked.recoveryLifecycle);
        saver.db.close();
        saver = SqliteSaver.fromConnString(paused.checkpointPath);
        graph = createGenerationGraph(saver, "cli");
        const resumed = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg }));
        assert.equal(resumed.recoveryLifecycle.active?.id, blocked.recoveryLifecycle.active?.id);
        assert.deepEqual(resumed.recoveryLifecycle.decision, blocked.recoveryLifecycle.decision);
        assert.equal(observed.length, outsideSupport ? 11 : 6);
        const session = outsideSupport ? entries[0]!.reviewerSession! : entries[0]!.planner!.sessionFile;
        appendFileSync(session, "\n");
        const inspected = await inspectModernGenerationRecovery(f.job, saver, paused.threadId);
        assert.ok(inspected?.inspectionFences.length, JSON.stringify(inspected));
        // A terminal graph has no pending tasks; a real resume supplies the
        // persisted state at START (the same route used by resumeGeneration).
        const tampered = await withJobModelRuntime(runtime, () => graph.invoke({ ...resumed, pauseAfter: null }, { ...cfg }));
        assert.equal(tampered.status, "blocked");
        assert.equal(tampered.recoveryLifecycle.active?.id, blocked.recoveryLifecycle.active?.id);
        assert.ok(tampered.recoveryLifecycle.inspectionFences.length);
        assert.equal(observed.length, outsideSupport ? 11 : 6);
        return;
      }
      if (writerDiagnosis) {
        const selected = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] }));
        assert.equal(selected.recoveryLifecycle.active?.id, failed.recoveryLifecycle.active?.id);
        assert.equal(selected.recoveryLifecycle.decision?.action, "diagnostic", JSON.stringify({ reason: selected.reason, calls: observed.length }));
        const diagnosed = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] }));
        assert.equal(diagnosed.recoveryLifecycle.decision?.action, "plan-amendment", JSON.stringify(diagnosed.recoveryLifecycle));
        assert.equal(diagnosed.recoveryLifecycle.active?.id, failed.recoveryLifecycle.active?.id);
        assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, paused.threadId), diagnosed.recoveryLifecycle);
        saver.db.close(); saver = SqliteSaver.fromConnString(paused.checkpointPath); graph = createGenerationGraph(saver, "cli");
        const supported = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptBefore: ["specialist_dispatch"] }));
        assert.ok(supported.recoveryLifecycle.discharged.some(c => c.case.id === failed.recoveryLifecycle.active?.id), JSON.stringify({ reason: supported.reason, lifecycle: supported.recoveryLifecycle, calls: observed.length }));
        assert.equal(observed.length, 16);
        assert.equal((await inspectPiPolicy(f.job)).budget.modelCalls, initialCalls + observed.length);
        const entries = (await (await import("../src/dependency-state.js")).inspectDependencyPlan(f.job))!.entries;
        assert.equal(entries.length, 1);
        assert.equal(entries[0]!.phase, "verified");
        assert.equal(entries[0]!.review?.verdict, "pass");
        assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
        assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, paused.threadId), supported.recoveryLifecycle);
        const diagnosisRef = diagnosed.recoveryLifecycle.attempt!.settledRef!.ref;
        const marker = JSON.parse(readFileSync(join(f.job.stateDir, "unknown-diagnostics", diagnosisRef + ".started.json"), "utf8"));
        const transcript = readFileSync(marker.sessionFile);
        writeFileSync(marker.sessionFile, Buffer.concat([transcript, Buffer.from("\n")]));
        const fenced = await inspectModernGenerationRecovery(f.job, saver, paused.threadId);
        assert.ok(fenced.inspectionFences.length, "Historical discharge cannot waive its original diagnosis transcript");
        writeFileSync(marker.sessionFile, transcript);
        assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, paused.threadId), supported.recoveryLifecycle);
        assert.equal(observed.length, 16);
        return;
      }
      if (nativeDiagnosis) {
        const selected = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] }));
        assert.equal(selected.recoveryLifecycle.active?.id, failed.recoveryLifecycle.active?.id);
        assert.equal(selected.recoveryLifecycle.decision?.action, "diagnostic", JSON.stringify({ reason: selected.reason, calls: observed.length }));
        const diagnosed = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] }));
        assert.equal(diagnosed.recoveryLifecycle.decision?.action, "plan-amendment", "A supported native Review diagnosis must admit the original repair: " + JSON.stringify(diagnosed.recoveryLifecycle));
        assert.equal(diagnosed.recoveryLifecycle.active?.id, failed.recoveryLifecycle.active?.id);
        assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, paused.threadId), diagnosed.recoveryLifecycle);
        const { configurePiPolicy } = await import("../src/job-pi-policy.js");
        const beforeBudget = await inspectPiPolicy(f.job);
        await configurePiPolicy(f.job, { ...beforeBudget.policy, limits: { ...beforeBudget.policy.limits, modelCalls: beforeBudget.budget.modelCalls } });
        const exhausted = await withJobModelRuntime(runtime, () => graph.invoke(null, cfg));
        assert.equal(exhausted.status, "paused", JSON.stringify({reason: exhausted.reason, lifecycle: exhausted.recoveryLifecycle}));
        assert.equal(exhausted.recoveryLifecycle.decision?.reason, "budget");
        assert.equal(exhausted.recoveryLifecycle.active?.id, failed.recoveryLifecycle.active?.id);
        assert.equal(observed.length, 18);
        assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, paused.threadId), exhausted.recoveryLifecycle);
        await configurePiPolicy(f.job, { ...beforeBudget.policy, limits: { ...beforeBudget.policy.limits, modelCalls: beforeBudget.budget.modelCalls + 20 } });
        saver.db.close();
        saver = SqliteSaver.fromConnString(paused.checkpointPath);
        graph = createGenerationGraph(saver, "cli");
        const supported = await withJobModelRuntime(runtime, () => graph.invoke({ ...exhausted, pauseAfter: null }, { ...cfg, interruptBefore: ["specialist_dispatch"] }));
        assert.ok(supported.recoveryLifecycle.discharged.some(c => c.case.id === failed.recoveryLifecycle.active?.id),
          JSON.stringify({ reason: supported.reason, lifecycle: supported.recoveryLifecycle, calls: observed.length }));
        assert.equal(observed.length, 21);
        assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, paused.threadId), supported.recoveryLifecycle);
        const entries = (await (await import("../src/dependency-state.js")).inspectDependencyPlan(f.job))!.entries;
        assert.equal(entries.length, 1);
        assert.equal(entries[0]!.phase, "verified");
        assert.equal(entries[0]!.review?.verdict, "pass");
        assert.notEqual(entries[0]!.supportRootSha, entries[0]!.commitSha);
        assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
        return;
      }
      if (nativeSupport) {
        const blocked = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] }));
        assert.equal(blocked.recoveryLifecycle.active?.id, failed.recoveryLifecycle.active?.id);
        assert.equal(blocked.recoveryLifecycle.decision?.action, "exhausted", JSON.stringify({ reason: blocked.reason, lifecycle: blocked.recoveryLifecycle, calls: observed.length }));
        assert.equal(blocked.recoveryLifecycle.decision?.reason, "protocol-exhausted");
        assert.deepEqual(blocked.recoveryLifecycle.inspectionFences, []);
        assert.equal(observed.length, 16);
        assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, paused.threadId), blocked.recoveryLifecycle);
        saver.db.close();
        saver = SqliteSaver.fromConnString(paused.checkpointPath);
        graph = createGenerationGraph(saver, "cli");
        const resumed = await withJobModelRuntime(runtime, () => graph.invoke({ ...blocked, pauseAfter: null }, cfg));
        assert.deepEqual(resumed.recoveryLifecycle, blocked.recoveryLifecycle);
        assert.equal(observed.length, 16);
        return;
      }
      if (authorSupport) {
        const waiting = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] }));
        assert.equal(waiting.status, "paused", JSON.stringify({ reason: waiting.reason, lifecycle: waiting.recoveryLifecycle, calls: observed.length }));
        assert.equal(waiting.recoveryLifecycle.decision?.reason, "author-choice");
        assert.equal(waiting.recoveryLifecycle.active?.id, failed.recoveryLifecycle.active?.id);
        assert.equal(observed.length, 12);
        const { activeSpecialistChoice, answerSpecialistChoice } = await import("../src/specialist-choice.js");
        const { withStoryJobLock } = await import("../src/job-lock.js");
        const choice = await activeSpecialistChoice(f.job);
        assert.ok(choice);
        await withStoryJobLock(f.job, "test-supporting-review-choice", () =>
          answerSpecialistChoice(f.job, choice.id, choice.proposalSha256,
            { kind: "option", optionId: "correct", note: "" }, "user:cli"));
        saver.db.close();
        saver = SqliteSaver.fromConnString(paused.checkpointPath);
        graph = createGenerationGraph(saver, "cli");
        const supported = await withJobModelRuntime(runtime, () => graph.invoke({ ...waiting, pauseAfter: null },
          { ...cfg, interruptBefore: ["specialist_dispatch"] }));
        assert.ok(supported.recoveryLifecycle.discharged?.some(c => c.case.id === failed.recoveryLifecycle.active?.id),
          JSON.stringify({ reason: supported.reason, lifecycle: supported.recoveryLifecycle, calls: observed.length }));
        assert.equal(observed.length, 22);
        assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, paused.threadId), supported.recoveryLifecycle);
        return;
      }
      if (stalledSupport) {
        const selected = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] }));
        assert.equal(selected.recoveryLifecycle.active?.id, failed.recoveryLifecycle.active?.id);
        assert.equal(selected.recoveryLifecycle.decision?.action, "plan-amendment", JSON.stringify(selected.recoveryLifecycle));
        assert.equal(selected.recoveryLifecycle.decision?.supportReview?.assessment.kind, "diagnostic");
        assert.equal(observed.length, 17, "The parent must checkpoint selection before diagnostic inference");
        assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, paused.threadId), selected.recoveryLifecycle);
        saver.db.close();
        saver = SqliteSaver.fromConnString(paused.checkpointPath);
        graph = createGenerationGraph(saver, "cli");
        const assessed = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] }));
        assert.equal(observed.length, 19);
        assert.equal(assessed.recoveryLifecycle.active?.id, failed.recoveryLifecycle.active?.id);
        assert.deepEqual(assessed.recoveryLifecycle.inspectionFences, []);
        if (!continueSupport) {
          assert.equal(assessed.status, "blocked");
          assert.equal(assessed.recoveryLifecycle.decision?.action, "exhausted");
          assert.equal(assessed.recoveryLifecycle.decision?.reason, "nonconverging");
          assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, paused.threadId), assessed.recoveryLifecycle);
          const restarted = await withJobModelRuntime(runtime, () => graph.invoke({ ...assessed, pauseAfter: null }, cfg));
          assert.deepEqual(restarted.recoveryLifecycle, assessed.recoveryLifecycle);
          assert.equal(observed.length, 19);
          return;
        }
        const supported = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] }));
        const discharge = supported.recoveryLifecycle.discharged.find(c => c.case.id === failed.recoveryLifecycle.active?.id);
        assert.ok(discharge, "Supported diagnostic continuation must verify and discharge the original Case, not stop at advice: " +
          JSON.stringify({ reason: supported.reason, lifecycle: supported.recoveryLifecycle, calls: observed.length }));
        assert.equal(discharge.disposition, "active-verified");
        const [entry] = (await (await import("../src/dependency-state.js")).inspectDependencyPlan(f.job))!.entries;
        assert.equal(entry?.phase, "verified");
        assert.equal(entry.commitSha, discharge.correctedHeadSha);
        assert.ok(entry.supportRootSha && entry.supportRootSha !== entry.commitSha);
        const history = await inspectRecoveryCheckpoints(f.job);
        assert.equal(history.find(p => p.commitSha === entry.supportRootSha)?.semanticReview, "failed");
        assert.equal(history.find(p => p.commitSha === entry.commitSha)?.semanticReview, "passed");
        assert.equal(observed.length, 22);
        const after = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptBefore: ["specialist_dispatch"] }));
        assert.equal(after.active?.id, "event:milestone.disclosure");
        assert.equal(after.recoveryLifecycle.active, null);
        assert.equal(observed.length, 22);
        assert.equal((await inspectPiPolicy(f.job)).budget.modelCalls, initialCalls + observed.length);
        return;
      }
      const headReceiptPath = join(f.job.stateDir, "revisions", "verified-head.json");
      const priorHeadReceipt = readFileSync(headReceiptPath, "utf8");
      await crashAtSubmission("focused-committed", multi ? 9 : 7 + offset, { interruptAfter: ["assess_recovery"] });
      // Reproduce the durable Git/publication gap using the real committed
      // child and its settled Pi receipt, not a manufactured writer effect.
      const publishedHeadReceipt = readFileSync(headReceiptPath, "utf8");
      writeFileSync(headReceiptPath, priorHeadReceipt);
      try {
        const inspected = await inspectModernGenerationRecovery(f.job, saver, paused.threadId);
        assert.equal(inspected?.active?.id, failed.recoveryLifecycle.active?.id);
        assert.equal(inspected?.inspectionFences.length, 0, JSON.stringify(inspected));
        assert.equal(inspected?.decision?.adapter, "dependency-work");
        writeFileSync(headReceiptPath, JSON.stringify({ ...JSON.parse(priorHeadReceipt), jobId: "foreign" }));
        assert.ok((await inspectModernGenerationRecovery(f.job, saver, paused.threadId))?.inspectionFences.length,
          "An unpublished writer effect cannot legitimize a foreign verified-HEAD receipt");
      } finally { writeFileSync(headReceiptPath, publishedHeadReceipt); }

      if (negativeSupport) {
        await crashAtSubmission("repair-round", 13, { interruptAfter: ["assess_recovery"] });
        assert.equal(observed.length, 13);
        const inspected = await inspectModernGenerationRecovery(f.job, saver, paused.threadId);
        assert.equal(inspected?.active?.id, failed.recoveryLifecycle.active?.id);
        assert.equal(inspected?.inspectionFences.length, 0, JSON.stringify(inspected));
      }

      let resumeInput: Parameters<typeof graph.invoke>[0] = null;
      if (partialPause) {
        const putWrites = saver.putWrites.bind(saver);
        let pausedAfterSupport = false;
        saver.putWrites = async (config, writes, task) => {
          const result = await putWrites(config, writes, task);
          if (!pausedAfterSupport && config.configurable?.checkpoint_ns?.includes("assignment-") &&
              writes.some(([channel, value]) => channel === "outcome" &&
                (value as { status?: string } | undefined)?.status === "verified") && observed.length === 11) {
            pausedAfterSupport = true;
            await setJobControl(f.job, "paused");
          }
          return result;
        };
        const stopped = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg }));
        assert.ok(pausedAfterSupport);
        assert.equal(stopped.status, "paused", JSON.stringify({ reason: stopped.reason, lifecycle: stopped.recoveryLifecycle }));
        assert.equal(stopped.recoveryLifecycle.active?.id, failed.recoveryLifecycle.active?.id);
        assert.equal(stopped.recoveryLifecycle.decision?.resumeRef?.store, "dependency-plan");
        assert.equal(observed.length, 11);
        assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, paused.threadId), stopped.recoveryLifecycle);
        await setJobControl(f.job, "running");
        saver.db.close();
        saver = SqliteSaver.fromConnString(paused.checkpointPath);
        graph = createGenerationGraph(saver, "cli");
        resumeInput = { ...stopped, pauseAfter: null };
      }
      let supported = await withJobModelRuntime(runtime, () => graph.invoke(resumeInput, { ...cfg, interruptAfter: ["assess_recovery"] }));
      if (partialPause && supported.recoveryLifecycle.assessorPending)
        supported = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] }));
      assert.ok(supported.recoveryLifecycle.discharged?.some(c => c.case.id === failed.recoveryLifecycle.active?.id),
        JSON.stringify({ reason: supported.reason, lifecycle: supported.recoveryLifecycle, calls: observed.length }));
      const { inspectDependencyPlan } = await import("../src/dependency-state.js");
      const entries = (await inspectDependencyPlan(f.job))!.entries;
      assert.equal(entries.length, multi ? 2 : 1);
      assert.ok(entries.every(e => e.phase === "verified"));
      if (multi) {
        assert.deepEqual(entries.map(e => e.amendment!.assignment.authority.existingPaths),
          [["arcs/archive-account.md"], ["arcs/witness-safety.md"]]);
        assert.deepEqual(entries.map(e => e.blueprintSource?.target), ["character.mara", "character.oren"]);
        assert.ok(entries.every(e => e.planner && e.report.affectedIds.includes("milestone.disclosure") &&
          e.report.sources.some(source => source.path === "milestones/disclosure.md")));
      }
      if (negativeSupport) {
        const first = entries[0]!;
        assert.ok(first.supportRootSha && first.commitSha !== first.supportRootSha);
        const points = await inspectRecoveryCheckpoints(f.job);
        assert.equal(points.find(p => p.commitSha === first.supportRootSha)?.semanticReview, "failed");
        assert.equal(points.find(p => p.commitSha === first.commitSha)?.semanticReview, "passed");
        assert.equal(git(f.job.worktreeRoot, "rev-parse", first.commitSha + "^"), first.supportRootSha);
        const ledgerPath = join(f.job.stateDir, "dependency-plan.json");
        const originalLedger = readFileSync(ledgerPath, "utf8");
        const { saveDependencyPlan } = await import("../src/dependency-state.js");
        const forged = (await inspectDependencyPlan(f.job))!;
        forged.entries[0]!.review!.evidence = ["characters/mara.md:1: Forged successful Review."];
        try {
          await saveDependencyPlan(f.job, forged);
          await assert.rejects(inspectDependencyPlan(f.job), /Supporting Review differs from its completed independent transcript/);
        } finally { writeFileSync(ledgerPath, originalLedger); }
        const session = first.reviewerSession!;
        const transcript = readFileSync(session);
        try {
          appendFileSync(session, "\n");
          await assert.rejects(inspectDependencyPlan(f.job), /Supporting review lost its independently sealed transcript/);
        } finally { writeFileSync(session, transcript); }

      }
      const support = entries.at(-1)!;
      if (mode === "prospective") {
        const { collectRecoveryFork, prepareRecoveryFork } = await import("../src/recovery-fork.js");
        const { inheritedReviewedCheckpoint, readRecoveryFork } = await import("../src/recovery-fork-state.js");
        const { dependencyVersionBase } = await import("../src/dependency-state.js");
        const { prepareReplacementTurn } = await import("../web/src/lib/replacement-turn.server.js");
        const { archiveStages } = await import("./support/scripted-archive-stages.js");
        const parent = await startStoryJob({story: f.job.storyRoot, job: f.job.jobId}, false);
        const point = (await inspectRecoveryCheckpoints(parent)).find(p => p.commitSha === support.commitSha)!;
        assert.ok(point.eligible && point.semanticReview === "passed");
        const supportId = support.amendment!.assignment.id;
        const path = "dependency-items/" + supportId + ".json";
        const receiptBytes = readFileSync(join(parent.stateDir, path), "utf8");
        const ledgerBytes = readFileSync(join(parent.stateDir, "dependency-plan.json"), "utf8");
        const parentTurn = JSON.parse(readFileSync(join(parent.stateDir, "turn-plan.json"), "utf8"));
        const bundle = await collectRecoveryFork(parent, "verified-support-continuation", point.commitSha,
          parentTurn.contract, source, "same-thread");
        assert.equal(bundle.reviewCoverage?.find(r => r.workItem === supportId)?.status, "passed");
        assert.equal(bundle.receipts[path]?.workItemId, supportId);
        assert.equal(bundle.receipts[path]?.piSessionFile, undefined);
        const child = await prepareRecoveryFork(parent, bundle);
        assert.equal(child.baseSha, support.commitSha);
        assert.ok(inheritedReviewedCheckpoint(child, supportId, point.commitSha));
        const { verifiedNarrativeChain } = await import("../src/job-successor.js");
        assert.equal(await verifiedNarrativeChain(child, point.parentSha, point.commitSha), point.commitSha);
        assert.equal(dependencyVersionBase(child), 2);
        assert.equal(existsSync(join(child.stateDir, "dependency-plan.json")), false);
        assert.equal(existsSync(join(child.stateDir, path)), false);
        assert.equal(readFileSync(join(parent.stateDir, path), "utf8"), receiptBytes);
        assert.equal(readFileSync(join(parent.stateDir, "dependency-plan.json"), "utf8"), ledgerBytes);
        const task = paused.request.task;
        const turn = await prepareReplacementTurn(child, {version: 1, headSha: child.baseSha,
          task, contract: bundle.contract, limits: {steps: 100}, model: {provider: scriptedModel.provider, id: scriptedModel.id}}, parent.jobId, parentTurn.creativePolicy);
        const childRuntime = await scriptedStoryRuntime(archiveStages(child, turn));
        const childSaver = SqliteSaver.fromConnString(join(child.stateDir, "continuation-test.sqlite"));
        const childSandbox = fixtureSandboxClient(child.jobId, child.worktreeStoryRoot);
        try {
          const next = await withJobModelRuntime(childRuntime.runtime, () => createGenerationGraph(childSaver, "cli").invoke({
            request: {...paused.request, job: child.jobId, turnPlanDigest: turn.digest}, pauseAfter: "event",
          }, {configurable: {thread_id: child.threadId + ":generation"}, recursionLimit: 1000}));
          assert.equal(next.status, "paused", JSON.stringify({reason: next.reason, recovery: next.recoverySources}));
          const childPoints = await inspectRecoveryCheckpoints(child);
          const event = childPoints.find(p => p.eligible && p.workItem === "event-disclosure")!;
          assert.ok(event, JSON.stringify(childPoints));
          assert.equal(event.parentSha, point.commitSha);
          assert.ok(event.completedWorkItems.includes(supportId));
          assert.equal(git(child.worktreeRoot, "log", "--format=%B", child.baseSha + "..HEAD").includes("NovelTea-Work-Item: " + supportId), false);
          assert.equal(readRecoveryFork(child)?.commits[supportId]?.sha, point.commitSha);
          const nested = await collectRecoveryFork(child, "verified-support-nested", event.commitSha, bundle.contract, source, "same-thread");
          assert.equal(nested.commits[supportId]?.sha, point.commitSha);
          assert.equal(nested.reviewCoverage?.find(r => r.workItem === supportId)?.status, "passed");
        } finally { childSandbox(); childSaver.db.close(); }
      }
      const rebound = JSON.parse(readFileSync(join(f.job.stateDir, "event-items/disclosure.json"), "utf8"));
      assert.equal(rebound.expectedHead, support.commitSha);
      assert.deepEqual(rebound.blueprintPin, before.blueprintPin);
      assert.equal(rebound.sessionFile, undefined);
      assert.equal(observed.length, multi ? 18 + (negativeSupport ? 3 : 0) : 9 + offset);
      saver.db.close();
      saver = SqliteSaver.fromConnString(paused.checkpointPath);
      graph = createGenerationGraph(saver, "cli");
      const after = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["specialist_dispatch"] }));
      assert.equal(after.result?.status, "event-cluster-committed", JSON.stringify({ reason: after.reason, lifecycle: after.recoveryLifecycle, calls: observed.length }));
      assert.equal(observed.length, multi ? 23 + (negativeSupport ? 3 : 0) : 14 + offset);
      const committedEvent = JSON.parse(readFileSync(join(f.job.stateDir, "event-items/disclosure.json"), "utf8"));
      const { historicalMilestoneHandoff } = await import("../src/milestone-obligation-handoff.js");
      const handoff = await historicalMilestoneHandoff(f.job, committedEvent);
      assert.deepEqual(handoff?.pin, before.blueprintPin);
      assert.equal(handoff?.eventHead, after.result.headSha);
      assert.notEqual(committedEvent.expectedHead, handoff?.pin.sourceSha);
      await assert.rejects(historicalMilestoneHandoff(f.job, { ...committedEvent,
        assignment: { ...committedEvent.assignment, blueprintSource: undefined } }));
      await assert.rejects(historicalMilestoneHandoff(f.job, { ...committedEvent,
        blueprintPin: { ...committedEvent.blueprintPin, sourceSha: committedEvent.expectedHead } }));
      if (multi) {
        const calls = observed.length;
        const next = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptBefore: ["specialist_dispatch"] }));
        assert.equal(next.inventory?.items.find(i => i.id === item.id)?.status, "verified",
          JSON.stringify({ reason: next.reason, recovery: next.recoveryLifecycle }));
        assert.equal(next.recoveryLifecycle.active, null);
        assert.ok(next.active && next.active.id !== item.id, "The verified original Event must rejoin ordinary scheduling");
        assert.equal(observed.length, calls);
        assert.equal((await inspectPiPolicy(f.job)).budget.modelCalls, initialCalls + calls);
      }
      assert.ok(existsSync(join(f.job.worktreeStoryRoot, supportPath)));
      if (mode === "prospective") {
        const { archiveStages } = await import("./support/scripted-archive-stages.js");
        const turn = JSON.parse(readFileSync(join(f.job.stateDir, "turn-plan.json"), "utf8"));
        const ordinary = await scriptedStoryRuntime(archiveStages(f.job, turn));
        const calls = (await inspectPiPolicy(f.job)).budget.modelCalls;
        const complete = await withJobModelRuntime(ordinary.runtime, () => graph.invoke(null, cfg));
        assert.equal(complete.status, "completed", JSON.stringify({ reason: complete.reason,
          active: complete.active, recovery: complete.recoveryLifecycle.active }));
        assert.equal(complete.request.turnPlanDigest, turnDigest);
        assert.equal((await inspectPiPolicy(f.job)).budget.modelCalls, calls + ordinary.observed.length);
        for (const stage of ["event", "interactive", "composition"]) assert.equal(
          complete.inventory?.items.find(i => i.id === stage + ":milestone.disclosure")?.status, "verified");
        const history = git(f.job.worktreeRoot, "log", "--format=%B", "--fixed-strings", "--grep=NovelTea-Work-Item: event-disclosure");
        assert.equal(history.split("\n").filter(line => line === "NovelTea-Work-Item: event-disclosure").length, 1);
      }
      if (blueprintCaseId) assert.equal(after.recoveryLifecycle.discharged.filter(d => d.case.id === blueprintCaseId).length, 1);
      assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
      return;
    }
    if (diagnosis) {
      const failed = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptBefore: ["assess_recovery"] }));
      assert.equal(failed.recoveryLifecycle.active?.origin.assignmentId, item.id, JSON.stringify({ reason: failed.reason, lifecycle: failed.recoveryLifecycle, calls: observed.length }));
      assert.equal(observed.length, 11);
      const original = JSON.parse(readFileSync(join(f.job.stateDir, "event-items/disclosure.json"), "utf8"));
      const chosen = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] }));
      assert.equal(chosen.recoveryLifecycle.decision?.action, "diagnostic", JSON.stringify({ reason: chosen.reason, lifecycle: chosen.recoveryLifecycle, sources: chosen.recoverySources }));
      const admitted = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] }));
      assert.equal(admitted.recoveryLifecycle.decision?.adapter, "assignment-diagnostic", JSON.stringify(admitted.recoveryLifecycle));
      saver.db.close();
      saver = SqliteSaver.fromConnString(paused.checkpointPath);
      graph = createGenerationGraph(saver, "cli");
      await crashAtSubmission("writer-round", 14, { interruptAfter: ["assess_recovery"] });
      const passed = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] }));
      assert.ok(passed.recoveryLifecycle.discharged?.some(c => c.case.id === failed.recoveryLifecycle.active?.id),
        JSON.stringify({ reason: passed.reason, lifecycle: passed.recoveryLifecycle, calls: observed.length }));
      const receipt = JSON.parse(readFileSync(join(f.job.stateDir, "event-items/disclosure.json"), "utf8"));
      assert.equal(receipt.sessionId, original.sessionId);
      assert.equal(receipt.assignmentKey, original.assignmentKey);
      assert.equal(receipt.invocationProof.ordinal, 3);
      assert.equal(observed.length, 16);
      assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
      const next = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptBefore: ["specialist_dispatch"] }));
      assert.equal(next.active?.id, "event:milestone.reckoning");
      assert.equal(next.inventory?.items.find(i => i.id === "interactive:milestone.disclosure")?.status, "pending");
      assert.equal(next.inventory?.items.find(i => i.id === "event:milestone.disclosure")?.status, "verified");
      assert.equal(observed.length, 16);
      return;
    }
    await crashAtSubmission("writer-round", 9, { interruptBefore: ["assess_recovery"] });
    const failed = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptBefore: ["assess_recovery"] }));
    assert.equal(failed.recoveryLifecycle.active?.origin.operation, "independent-review", JSON.stringify({ reason: failed.reason, recovery: failed.recoveryLifecycle, calls: observed.length }));
    assert.equal(observed.length, 11);
    const event = JSON.parse(readFileSync(join(f.job.stateDir, "event-items/disclosure.json"), "utf8"));
    assert.equal(event.invocationProof.ordinal, 1);
    const selected = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] }));
    assert.equal(selected.recoveryLifecycle.decision?.action, "known-correction", JSON.stringify(selected.recoveryLifecycle));
    await assertSubunitReviewAuthority(f.job, selected, "event-disclosure", "interactive-choice-disclosure", event.assignmentKey);
    if (otherOwner) {
      const suspended = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptBefore: ["dependency_amendment"] }));
      assert.ok(suspended.reviewPrerequisite, JSON.stringify({ reason: suspended.reason, lifecycle: suspended.recoveryLifecycle, calls: observed.length }));
      const { inspectDependencyPlan } = await import("../src/dependency-state.js");
      const request = (await inspectDependencyPlan(f.job))!.reviewRequests![0]!;
      assert.equal(request.otherOwnerPath, supportPath);
      assert.equal(request.otherOwnerCheckpoint?.assignmentId, "foundations");
      assert.equal(request.otherOwnerCheckpoint?.workItem, worldOwner ? "world-foundations" : "character-foundations");
      assert.equal(suspended.reviewPrerequisite.suspension.owner, supportSpecialist);
      const original = (await inspectRecoveryCheckpoints(f.job)).find(p => p.commitSha === request.otherOwnerCheckpoint?.commitSha);
      assert.ok(original?.eligible && original.assurance?.changedPaths.includes(supportPath));
      await crashAtSubmission("focused-committed", 17, { interruptAfter: ["dependency_amendment"] });
      const supportHead = git(f.job.worktreeRoot, "rev-parse", "HEAD");
      const supported = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["dependency_amendment"] }));
      assert.ok(supported.reviewPrerequisite?.supportRef, JSON.stringify({ reason: supported.reason, calls: observed.length }));
      assert.deepEqual(supported.reviewPrerequisite.identity, suspended.reviewPrerequisite.identity);
      assert.equal(git(f.job.worktreeRoot, "diff", "--name-only", event.commitSha, supportHead), "story/" + supportPath);
      const next = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptBefore: ["specialist_dispatch"] }));
      assert.equal(next.inventory?.items.find(i => i.id === item.id)?.status, "verified", JSON.stringify({ reason: next.reason, lifecycle: next.recoveryLifecycle, calls: observed.length }));
      assert.equal(next.active?.id, "event:milestone.reckoning");
      assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), supportHead);
      assert.equal((await inspectDependencyPlan(f.job))!.entries[0]!.phase, "verified");
      assert.equal((await inspectRecoveryCheckpoints(f.job)).find(p => p.commitSha === event.commitSha)?.semanticReview, "failed");
      assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
      assert.equal(next.request.turnPlanDigest, turnDigest);
      assert.equal(next.recoveryLifecycle.discharged.filter(d => d.case.id === failed.recoveryLifecycle.active?.id).length, 1);
      return;
    }
    if (needsCharacter) {
      const suspended = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptBefore: ["dependency_amendment"] }));
      assert.ok(suspended.reviewPrerequisite, JSON.stringify({ reason: suspended.reason, lifecycle: suspended.recoveryLifecycle, calls: observed.length }));
      assert.equal(suspended.reviewPrerequisite.suspension.pendingPhase, "review");
      assert.equal(suspended.reviewPrerequisite.suspension.owner, "nt-character-development");
      assert.equal(suspended.reviewPrerequisite.suspension.assignmentKey, event.assignmentKey);
      assert.equal(observed.length, 11);
      // The original correction child, not only its parent's later projection,
      // must checkpoint the bounded prerequisite rather than an unresolved failure.
      const outcomes: unknown[] = [];
      for await (const tuple of saver.list({ configurable: { thread_id: cfg.configurable.thread_id } })) {
        const ns = tuple.config.configurable?.checkpoint_ns ?? "";
        if (!ns.includes("assignment-") || !ns.includes("-correction")) continue;
        const outcome = tuple.checkpoint.channel_values.outcome as
          import("../src/generation-assignment-lifecycle.js").AssignmentOutcome | undefined;
        if (outcome?.assignmentKey === event.assignmentKey) outcomes.push(outcome);
      }
      assert.ok(outcomes.length > 0, "Original correction outcome must be persisted");
      for (const outcome of outcomes) assert.deepEqual(outcome, suspended.reviewPrerequisite.suspension);
      await crashAtSubmission("focused-committed", 16, { interruptAfter: ["dependency_amendment"] });
      const supportHead = git(f.job.worktreeRoot, "rev-parse", "HEAD");
      assert.equal(git(f.job.worktreeRoot, "diff", "--name-only", event.commitSha, supportHead), "story/" + supportPath);
      const supported = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["dependency_amendment"] }));
      assert.ok(supported.reviewPrerequisite?.supportRef, JSON.stringify({ reason: supported.reason, lifecycle: supported.recoveryLifecycle, calls: observed.length }));
      assert.deepEqual(supported.reviewPrerequisite.identity, suspended.reviewPrerequisite.identity);
      assert.equal(observed.length, negativeReviewSupport ? 21 : 18);
      const supportEntry = (await (await import("../src/dependency-state.js")).inspectDependencyPlan(f.job))!.entries[0]!;
      assert.equal(supportEntry.supportRootSha, supportHead);
      assert.equal(supportEntry.phase, "reviewing", "The dependent's original Review remains unresolved");
      assert.equal(supportEntry.review?.verdict, "pass");
      const points = await inspectRecoveryCheckpoints(f.job);
      assert.equal(points.find(p => p.commitSha === supportHead)?.semanticReview, negativeReviewSupport ? "failed" : "passed");
      assert.equal(points.find(p => p.commitSha === supportEntry.commitSha)?.semanticReview, "passed");
      assert.equal(points.find(p => p.commitSha === event.commitSha)?.semanticReview, "failed");
      assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), supportEntry.commitSha);
      if (negativeReviewSupport) {
        assert.notEqual(supportEntry.commitSha, supportHead);
        assert.equal(git(f.job.worktreeRoot, "rev-parse", supportEntry.commitSha + "^"), supportHead);
        assert.equal(git(f.job.worktreeRoot, "diff", "--name-only", supportHead, supportEntry.commitSha!), "story/" + supportPath);
      }
    }
    await crashAtSubmission("repair-round", needsCharacter ? negativeReviewSupport ? 23 : 20 : 13, { interruptAfter: ["independent_assignment_review"] });
    const successor = git(f.job.worktreeRoot, "rev-parse", "HEAD");
    assert.notEqual(successor, event.commitSha);
    const passed = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["independent_assignment_review"] }));
    assert.equal(passed.result?.headSha, successor, JSON.stringify({ reason: passed.reason, recovery: passed.recoveryLifecycle, calls: observed.length }));
    assert.equal(observed.length, needsCharacter ? negativeReviewSupport ? 24 : 21 : 14);
    await assertSubunitReviewSessions(f.job, { commitSha: event.commitSha, piSessionFile: event.sessionFile }, successor);
    if (needsCharacter) {
      const { inspectDependencyPlan } = await import("../src/dependency-state.js");
      const entry = (await inspectDependencyPlan(f.job))!.entries[0]!;
      assert.equal(entry.phase, "verified");
      assert.equal(entry.eventRepair?.commitSha, successor);
      assert.equal(git(f.job.worktreeRoot, "diff", "--name-only", entry.commitSha!, successor), "story/" + path);
    }
    assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
    assert.ok(readFileSync(join(f.job.worktreeStoryRoot, path), "utf8").includes(quote));
    const next = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptBefore: ["specialist_dispatch"] }));
    assert.equal(next.inventory?.items.find(i => i.id === item.id)?.status, "verified", JSON.stringify({ reason: next.reason, active: next.active, recovery: next.recoveryLifecycle }));
    assert.equal(next.active?.id, "event:milestone.reckoning");
      assert.equal(next.inventory?.items.find(i => i.id === "interactive:milestone.disclosure")?.status, "pending");
      assert.equal(next.inventory?.items.find(i => i.id === "event:milestone.disclosure")?.status, "verified");
    assert.equal(observed.length, needsCharacter ? negativeReviewSupport ? 24 : 21 : 14);
  } finally {
    saver.db.close();
    restoreSandbox();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

for (const mode of ["crash", "public-cli", "studio"] as const) test("R14I production World question resumes the same child and Pi session " + mode, { skip: !available, timeout: 120_000 }, async () => {
  const f = setup("r14i-world-question-" + mode);
  let studio: Awaited<ReturnType<typeof import("./generation-author-studio-fixture.js").prepareAuthorStudio>> | null = null;
  if (mode === "studio") {
    const { prepareAuthorStudio } = await import("./generation-author-studio-fixture.js");
    Object.assign(f.env, { NT_GIT_CACHE_DIR: join(root, "r14i-studio-cache"),
      PI_OFFLINE: "1", NT_PI_CREDENTIAL_KEY: Buffer.alloc(32, 9).toString("base64"),
      NT_REQUIRE_USER_PI_RUNTIME: "1" });
    const prior = Object.fromEntries(Object.keys(f.env).map(key => [key, process.env[key]]));
    Object.assign(process.env, f.env);
    try { studio = await prepareAuthorStudio(root, f.repo, f.initial, f.start[3]!); }
    finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
    f.job = studio.job;
    f.story = studio.job.storyRoot;
    f.cli = (args: string[], success = true) => {
      const result = spawnSync(process.execPath, [...cliEntry(), "job", ...args, "--story", f.story, "--job", f.job.jobId],
        { encoding: "utf8", env: f.env, timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
      if (!success) { assert.notEqual(result.status, 0); return result.stderr; }
      assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
    };
  }
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope = { kind: "full-story", depth: "composition", targets: [], branches: [] };
  writeFileSync(f.contract, JSON.stringify(contract));
  let paused: any;
  if (studio) {
    const turn = planWholeStory(f.start[3]!, contract, f.job.baseSha);
    await saveJobTurnPlan(f.job, turn);
    const checkpointPath = join(f.job.stateDir, "web-generation.sqlite");
    const threadId = f.job.threadId + ":generation:web";
    const seedSaver = SqliteSaver.fromConnString(checkpointPath);
    const seedGraph = createGenerationGraph(seedSaver, "server");
    const cfg = { configurable: { thread_id: threadId }, recursionLimit: 1000 };
    const before = Object.fromEntries(Object.keys(f.env).map(key => [key, process.env[key]]));
    Object.assign(process.env, f.env);
    const restore = fixtureSandboxClient(f.job.jobId, f.job.worktreeStoryRoot);
    try {
      const { archiveStages } = await import("./support/scripted-archive-stages.js");
      const { runtime } = await scriptedStoryRuntime(archiveStages(f.job, turn));
      const request = { story: f.story, job: f.job.jobId, task: f.start[3]!, contract,
        fixture: false, skillsSource: source, turnPlanDigest: turn.digest, orchestrationPolicy: "explicit" as const,
        provider: scriptedModel.provider, model: scriptedModel.id };
      // Claim the actual current server request once; every prerequisite uses
      // that same Thread and model profile. Never remove/recreate the owner.
      await studio.admit(request, threadId);
      const foundation = await withJobModelRuntime(runtime, () =>
        seedGraph.invoke({ request, pauseAfter: "foundation" }, cfg));
      assert.equal(foundation.status, "paused", foundation.reason ?? "");
      const architecture = await withJobModelRuntime(runtime, () =>
        seedGraph.invoke({ request, pauseAfter: "architecture" }, cfg));
      assert.equal(architecture.status, "paused", architecture.reason ?? "");
      paused = { ...architecture, checkpointPath, threadId };
    } finally {
      restore();
      seedSaver.db.close();
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  } else {
    await useScriptedArchiveCli(f);
    assert.equal(f.cli([...f.start, "--pause-after", "foundation"]).status, "paused");
    paused = f.cli(["generate", "resume", "--pause-after", "architecture"]);
    assert.equal(paused.status, "paused", paused.reason + "\n" + readFileSync(f.contract + ".model-calls", "utf8"));
    // The following read-only inspect and paused answer commands use the
    // public CLI without installing a provider in the subprocess.
    delete (f.env as NodeJS.ProcessEnv).NT_TEST_SCRIPTED_ARCHIVE;
    delete (f.env as NodeJS.ProcessEnv).NT_TEST_SCRIPTED_FOUNDATION;
  }
  const turnDigest = JSON.parse(readFileSync(join(f.job.stateDir, "turn-plan.json"), "utf8")).digest;
  const paths = ["world-entities/archive.md", "facts/evidence-concealed.md"];
  const world = "---\nschema: '0.1'\ntype: world-entity\nid: world-entity.archive\ntitle: Archive\nstatus: draft\ndecisions: []\ndescription: A public archive with a restricted ledger\n---\n\nThe custodian guards the sealed ledger.\n";
  const fact = "---\nschema: '0.1'\ntype: fact\nid: fact.evidence-concealed\ntitle: Hidden evidence\nstatus: draft\ndecisions: []\ninitial: true\n---\n\nNeri concealed an entry implicating an official.\n";
  const { runtime, observed } = await scriptedStoryRuntime((i, context) => {
    if (i === 0) return { content: scriptedReadCalls(["nt-worldbuilding/SKILL.md", "nt-catalog/SKILL.md", "nt-catalog/references/records.md", "nt-catalog/references/progression.md", "nt-catalog/references/authority-and-validation.md", "nt-catalog/references/glossary.md"].map(p => "skill://" + p), i), reason: "toolUse" };
    if (i === 1) return { content: scriptedText({ authorDecisionRequest: {
      kind: "free-text", question: "What evidence does the custodian protect in the archive?" },
      modifiedRecords: [] }), reason: "stop" };
    if (i === 2) return { content: [world, fact].map((content, n) => ({
      type: "toolCall" as const, name: "write", id: "r14i-write-" + n,
      arguments: { path: paths[n]!, content },
    })), reason: "toolUse" };
    if (i === 3) return { content: scriptedText({ modifiedRecords: paths,
      architecturalConflicts: [], laterObligations: [] }), reason: "stop" };
    if (i === 4) return { content: scriptedReadCalls(boundedPinnedSources("nt-narrative-review").map(p => "skill://" + p), i), reason: "toolUse" };
    if (i === 5) {
      const messages = context.messages as Array<{ content: Array<{ type: string; text?: string }> }>;
      const prompt = messages.flatMap(m => Array.isArray(m.content) ? m.content : [])
        .map(c => c.text ?? "").findLast(t => t.includes("\nIMMUTABLE REVIEW PACKET\n"));
      assert.ok(prompt);
      const packet = JSON.parse(prompt.split("\nIMMUTABLE REVIEW PACKET\n")[1]!);
      const item = packet.items[0];
      return { content: scriptedText({ sourceDigest: packet.sourceDigest, verdict: "pass", findings: [],
        evidence: [{ commitSha: item.assurance.commitSha, assignmentId: item.assignment.id,
          path: paths[0], line: 1, explanation: "The custodian protects the sealed ledger." }] }), reason: "stop" };
    }
    if (mode !== "crash" && i === 6) return { content: scriptedReadCalls(
      ["nt-character-development/SKILL.md", "nt-catalog/SKILL.md", "nt-catalog/references/records.md",
        "nt-catalog/references/progression.md", "nt-catalog/references/authority-and-validation.md",
        "nt-catalog/references/glossary.md"].map(p => "skill://" + p), i), reason: "toolUse" };
    if (mode !== "crash" && i === 7) return { content: scriptedText({
      authorDecisionRequest: { kind: "free-text", question: "Why does the witness protect the custodian?" },
      modifiedRecords: [] }), reason: "stop" };
    throw Error("Unexpected extra specialist/reviewer call " + i);
  });
  const old = Object.fromEntries(Object.keys(f.env).map(key => [key, process.env[key]]));
  Object.assign(process.env, f.env);
  const restoreSandbox = fixtureSandboxClient(f.job.jobId, f.job.worktreeStoryRoot);
  const { pendingGenerationQuestion, generationQuestionResume } = await import("../src/generation-author-question.js");
  const { answerSpecialistChoice, inspectSpecialistChoice } = await import("../src/specialist-choice.js");
  let saver = SqliteSaver.fromConnString(paused.checkpointPath);
  try {
    let graph = createGenerationGraph(saver, studio ? "server" : "cli");
    const cfg = { configurable: { thread_id: paused.threadId }, recursionLimit: 1000 };
    const initial = (await graph.getState(cfg)).values;
    const item = paused.inventory.items.find((entry: { id: string }) => entry.id === "foundations");
    assert.equal(initial.request.turnPlanDigest, turnDigest);
    assert.equal(initial.request.fixture, false);
    await graph.updateState(cfg, { status: "running", reason: null, active: item, result: null, pauseAfter: null,
    }, "author_update_intake");
    await withJobModelRuntime(runtime, () => graph.invoke(null, cfg));
    assert.equal(observed.length, 2);
    if (studio) {
      const pending = await pendingGenerationQuestion(f.job, saver, await graph.getState(cfg), paused.threadId, "user:" + studio.owner);
      assert.ok(pending);
      const original = pending.choice;
      saver.db.close();
      await studio.resume(original, runtime);
      saver = SqliteSaver.fromConnString(paused.checkpointPath);
      const snapshot = await createGenerationGraph(saver, "server").getState(cfg);
      const next = await pendingGenerationQuestion(f.job, saver, snapshot, paused.threadId, "user:" + studio.owner);
      assert.equal(next?.choice.question.question, "Why does the witness protect the custodian?");
      assert.equal(observed.length, 8);
      assert.equal((await inspectSpecialistChoice(f.job, original.id)).phase, "consumed");
      const unit = JSON.parse(readFileSync(join(f.job.stateDir, "character-world.json"), "utf8")).units[0];
      assert.equal(unit.phase, "committed");
      assert.equal(unit.piSessionId, original.sessionId);
      assert.equal((await inspectRecoveryCheckpoints(f.job)).find(p => p.commitSha === unit.commitSha)?.semanticReview, "passed");
      return;
    }
    let pending = await pendingGenerationQuestion(f.job, saver, await graph.getState(cfg), paused.threadId, "user:cli");
    assert.ok(pending, JSON.stringify({tasks:(await graph.getState(cfg)).tasks, values:(await graph.getState(cfg)).values}));
    assert.equal(pending.choice.phase, "awaiting-author");
    assert.equal(existsSync(join(f.job.stateDir, ".story-job-running")), false);
    const original = pending.choice;
    saver.db.close();
    saver = SqliteSaver.fromConnString(paused.checkpointPath);
    graph = createGenerationGraph(saver, "cli");
    pending = await pendingGenerationQuestion(f.job, saver, await graph.getState(cfg), paused.threadId, "user:cli");
    assert.equal(pending?.choice.id, original.id);
    const response = { kind: "custom" as const, text: "The sealed ledger.", note: "" };
    const receiptPath = join(f.job.stateDir, "specialist-choices", original.id + ".json");
    const originalReceipt = readFileSync(receiptPath, "utf8");
    const snapshotBefore = await graph.getState(cfg);
    await assert.rejects(pendingGenerationQuestion(f.job, saver, snapshotBefore, "wrong-thread", "user:cli"), /original assignment/);
    await assert.rejects(pendingGenerationQuestion(f.job, saver, {
      ...snapshotBefore, values: { ...snapshotBefore.values, planVersion: 999 },
    }, paused.threadId, "user:cli"), /original assignment/);
    if (mode === "public-cli") {
      const inspection = f.cli(["generate", "inspect"]);
      assert.equal(inspection.status, "paused", JSON.stringify(inspection));
      assert.equal(inspection.authorQuestion.id, original.id);
      const answerFile = join(root, "r14i-public-answer.json");
      writeFileSync(answerFile, JSON.stringify({ id: original.id,
        proposalSha256: original.proposalSha256, answer: response }));
      await setJobControl(f.job, "paused");
      const answered = f.cli(["generate", "resume", "--answer", answerFile]);
      assert.equal(answered.status, "paused");
      assert.equal(answered.authorQuestion.phase, "answered");
      const repeat = f.cli(["generate", "resume", "--answer", answerFile]);
      assert.equal(repeat.authorQuestion.phase, "answered");
      await setJobControl(f.job, "running");
    } else {
      await answerSpecialistChoice(f.job, original.id, original.proposalSha256, response, "user:cli");
    }
    const acceptedBytes = readFileSync(receiptPath, "utf8");
    const changed = JSON.parse(acceptedBytes);
    changed.answer.text = "Forged answer";
    writeFileSync(receiptPath, JSON.stringify(changed));
    try { await assert.rejects(pendingGenerationQuestion(f.job, saver, snapshotBefore, paused.threadId, "user:cli"), /immutable accepted receipt/); }
    finally { writeFileSync(receiptPath, acceptedBytes); }
    assert.notEqual(originalReceipt, acceptedBytes);
    assert.equal(observed.length, 2);
    pending = await pendingGenerationQuestion(f.job, saver, await graph.getState(cfg), paused.threadId, "user:cli");
    assert.ok(pending);
    await assert.rejects(pendingGenerationQuestion(f.job, saver, await graph.getState(cfg), paused.threadId, "user:other"), /different author/);
    // Crash after the accepted answer's first substantive Pi turn settled but
    // before its child submission is checkpointed. Reopen the same journal.
    saver.db.close();
    saver = SqliteSaver.fromConnString(paused.checkpointPath);
    graph = createGenerationGraph(saver, "cli");
    pending = await pendingGenerationQuestion(f.job, saver, await graph.getState(cfg), paused.threadId, "user:cli");
    assert.ok(pending);
    if (mode === "public-cli") {
      saver.db.close();
      const { runStoryGeneration } = await import("../src/generation.js");
      const { configurePiPolicy, inspectPiPolicy } = await import("../src/job-pi-policy.js");
      const policy = await inspectPiPolicy(f.job);
      await configurePiPolicy(f.job, { ...policy.policy, limits: { ...policy.policy.limits, modelCalls: policy.budget.modelCalls } });
      const resource = await withJobModelRuntime(runtime, () => runStoryGeneration({ story: f.story, job: "single", action: "resume" }));
      assert.equal(resource.status, "paused", JSON.stringify({reason: resource.reason, authorQuestion: resource.authorQuestion}));
      assert.equal(resource.authorQuestion, null, "An accepted answer is not a new author question during a budget pause");
      assert.equal(observed.length, 2);
      await configurePiPolicy(f.job, { ...policy.policy, limits: { ...policy.policy.limits, modelCalls: policy.budget.modelCalls + 20 } });
      const resumed = await withJobModelRuntime(runtime, () => runStoryGeneration({
        story: f.story, job: "single", action: "resume",
      }));
      saver = SqliteSaver.fromConnString(paused.checkpointPath);
      assert.equal(resumed.status, "paused", JSON.stringify({ reason: resumed.reason, authorQuestion: resumed.authorQuestion, operationRecovery: resumed.operationRecovery, recoverySources: resumed.recoverySources }));
      assert.equal(resumed.authorQuestion?.question.question, "Why does the witness protect the custodian?");
      assert.equal(observed.length, 8);
      assert.equal((await inspectSpecialistChoice(f.job, original.id)).phase, "consumed");
      const unit = JSON.parse(readFileSync(join(f.job.stateDir, "character-world.json"), "utf8")).units[0];
      assert.equal(unit.phase, "committed");
      assert.equal(unit.piSessionId, original.sessionId);
      assert.equal((await inspectRecoveryCheckpoints(f.job)).find(p => p.commitSha === unit.commitSha)?.semanticReview, "passed");
      await setJobControl(f.job, "cancelled");
      const cancelled = await withJobModelRuntime(runtime, () => runStoryGeneration({
        story: f.story, job: "single", action: "resume",
      }));
      assert.equal(cancelled.status, "cancelled");
      assert.equal(cancelled.authorQuestion, null);
      assert.equal(observed.length, 8);
      return;
    }
    const put = saver.put.bind(saver);
    const putWrites = saver.putWrites.bind(saver);
    const abort = new AbortController();
    let crashed = false;
    const error = Error("R14I injected SQLite loss after answered writer settlement");
    saver.put = async (...args) => { if (crashed) throw error; return put(...args); };
    saver.putWrites = async (config, writes, task) => {
      if (crashed) throw error;
      if (config.configurable?.checkpoint_ns?.includes("assignment-") &&
          writes.some(([channel, value]) => channel === "submission" &&
            (value as { status?: string })?.status === "writer-round") && observed.length === 4) {
        crashed = true; abort.abort(error); throw error;
      }
      return putWrites(config, writes, task);
    };
    await assert.rejects(withJobModelRuntime(runtime, () => graph.invoke(generationQuestionResume(pending!),
      { ...cfg, signal: abort.signal, durability: "sync" })));
    assert.ok(crashed);
    assert.equal(observed.length, 4);
    saver.db.close();
    saver = SqliteSaver.fromConnString(paused.checkpointPath);
    graph = createGenerationGraph(saver, "cli");
    // The root may still hold the original interrupt while the child has
    // checkpointed the authenticated answer and started its original turn.
    const snapshot = await graph.getState(cfg);
    const continuation = await pendingGenerationQuestion(f.job, saver, snapshot, paused.threadId, "user:cli");
    assert.equal(continuation?.phase, "continuation");
    await withJobModelRuntime(runtime, () => graph.invoke(generationQuestionResume(continuation!), { ...cfg, interruptAfter: ["specialist_dispatch"] }));
    assert.equal(observed.length, 6);
    const choice = await inspectSpecialistChoice(f.job, original.id);
    assert.equal(choice.phase, "consumed");
    const saved = JSON.parse(readFileSync(join(f.job.stateDir, "character-world.json"), "utf8"));
    assert.equal(saved.units[0].phase, "committed");
    assert.equal(saved.units[0].piSessionId, original.sessionId);
    assert.equal(saved.units[1].phase, "pending");
  } finally {
    saver.db.close();
    restoreSandbox();
    await studio?.close();
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("R05 World and Character metadata and independent Review corrections resume the original Thread in order", { skip: !available, timeout: 120_000 }, async () => {
  const f = setup("r05-world-review");
  await useScriptedArchiveCli(f);
  const log = f.contract + ".model-calls";
  assert.equal(f.cli([...f.start, "--pause-after", "foundation"]).status, "paused");
  const paused = f.cli(["generate", "resume", "--pause-after", "architecture"]);
  assert.equal(paused.status, "paused", paused.reason + "\n" + readFileSync(log, "utf8"));
  const turnDigest = JSON.parse(readFileSync(join(f.job.stateDir, "turn-plan.json"), "utf8")).digest;
  const paths = ["world-entities/archive.md", "facts/evidence-concealed.md"];
  const preludeCalls = readFileSync(log, "utf8").trim().split("\n").length;
  const world = "---\nschema: '0.1'\ntype: world-entity\nid: world-entity.archive\ntitle: Archive\nstatus: draft\ndecisions: []\ndescription: A public archive with a restricted ledger\n---\n\nThe custodian guards the sealed ledger.\n";
  const fact = "---\nschema: '0.1'\ntype: fact\nid: fact.evidence-concealed\ntitle: Hidden evidence\nstatus: draft\ndecisions: []\ninitial: true\n---\n\nNeri concealed an entry implicating an official.\n";
  const reads = (specialist: string) => [specialist + "/SKILL.md", "nt-catalog/SKILL.md",
    "nt-catalog/references/records.md", "nt-catalog/references/progression.md",
    "nt-catalog/references/authority-and-validation.md", "nt-catalog/references/glossary.md"].map(p => "skill://" + p);
  const write = (path: string, content: string, id: string) => ({
    type: "toolCall" as const, name: "write", id, arguments: { path, content },
  });
  const manifest = { modifiedRecords: paths, architecturalConflicts: [], laterObligations: [] };
  const characterPaths = ["characters/ada.md", "characters/neri.md", "relationships/ada-neri.md", "arcs/truth.md"];
  const record = (type: string, id: string, fields: string, body: string) =>
    `---\nschema: '0.1'\ntype: ${type}\nid: ${type}.${id}\ntitle: ${id}\nstatus: draft\ndecisions: []\n${fields}\n---\n\n${body}\n`;
  const ada = record("character", "ada", "motivation: Investigate without condemning a friend\ninitial_knowledge:\n  - fact: fact.evidence-concealed\n    value: disbelieves", "Ada investigates the disappearance.");
  const neri = record("character", "neri", "motivation: Protect a witness\ninitial_knowledge:\n  - fact: fact.evidence-concealed\n    value: knows", "Neri maintains the archive ledger.");
  const relationship = record("relationship", "ada-neri", "characters: [character.ada, character.neri]\ninitial: wary", "The former collaborators distrust each other.");
  const characterManifest = { modifiedRecords: characterPaths, architecturalConflicts: [], laterObligations: [] };
  const { runtime, observed } = await scriptedStoryRuntime((i, context) => {
    if (i === 0) return { content: scriptedReadCalls(reads("nt-worldbuilding"), i), reason: "toolUse" };
    if (i === 1) return { content: [write(paths[0]!, world.replace("description:", "unknown_field: true\ndescription:"), "r05-invalid"), write(paths[1]!, fact, "r05-fact")], reason: "toolUse" };
    if (i === 2 || i === 4) return { content: scriptedText(manifest), reason: "stop" };
    if (i === 3) return { content: [write(paths[0]!, world, "r05-metadata")], reason: "toolUse" };
    if (i === 5) return { content: scriptedReadCalls(boundedPinnedSources("nt-narrative-review").map(p => "skill://" + p), i), reason: "toolUse" };
    if (i === 7) return { content: [write(paths[0]!, world + "\nThe custodian signs each transfer in a register.\n", "r05-review-repair")], reason: "toolUse" };
    if (i === 8) return { content: scriptedText("Clarified the evidence transfer in the archive."), reason: "stop" };
    if (i === 6 || i === 9) {
      const messages = context.messages as Array<{ content: Array<{ type: string; text?: string }> }>;
      const prompt = messages.flatMap(m => Array.isArray(m.content) ? m.content : [])
        .map(c => c.text ?? "").findLast(t => t.includes("\nIMMUTABLE REVIEW PACKET\n"));
      assert.ok(prompt);
      const packet = JSON.parse(prompt.split("\nIMMUTABLE REVIEW PACKET\n")[1]!);
      const item = packet.items[0];
      const ref = { commitSha: item.assurance.commitSha, assignmentId: item.assignment.id, path: paths[0], line: 1 };
      return { content: scriptedText({ sourceDigest: packet.sourceDigest, verdict: i === 6 ? "fail" : "pass",
        findings: i === 6 ? [{ ...ref, kind: "missing-requirement", message: "The transfer provenance is unspecified.",
          requiredCorrection: "Clarify how the custodian records transfers.", affectedPaths: [paths[0]] }] : [],
        evidence: i === 9 ? [{ ...ref, explanation: "The signed register establishes transfer provenance." }] : [],
        ...(i === 9 ? { progressDiagnosis: { status: "material", reason: "The register addresses the source-linked gap.",
          evidence: { path: paths[0], quote: "The custodian signs each transfer in a register.", change: "added" } } } : {}),
      }), reason: "stop" };
    }
    if (i === 10) return { content: scriptedReadCalls(reads("nt-character-development"), i), reason: "toolUse" };
    if (i === 11) return { content: [
      write(characterPaths[0]!, ada, "r05-ada"),
      write(characterPaths[1]!, neri, "r05-neri"), write(characterPaths[2]!, relationship.replace("initial:", "unknown_field: true\ninitial:"), "r05-relationship-invalid"),
      write(characterPaths[3]!, readFileSync(join(f.job.worktreeStoryRoot, characterPaths[3]!), "utf8")
        .replace(/^characters:.*$/m, "characters: [character.ada, character.neri]"), "r05-arc-links"),
    ], reason: "toolUse" };
    if (i === 12 || i === 14) return { content: scriptedText(characterManifest), reason: "stop" };
    if (i === 13) return { content: [write(characterPaths[2]!, relationship, "r05-character-metadata")], reason: "toolUse" };
    if (i === 15) return { content: scriptedReadCalls(boundedPinnedSources("nt-narrative-review").map(p => "skill://" + p), i), reason: "toolUse" };
    if (i === 17) return { content: [write(characterPaths[1]!, neri + "\nNeri fears the official will retaliate against the missing witness.\n", "r05-character-repair")], reason: "toolUse" };
    if (i === 18) return { content: scriptedText("Clarified Neri's motivation."), reason: "stop" };
    if (i === 16 || i === 19) {
      const messages = context.messages as Array<{ content: Array<{ type: string; text?: string }> }>;
      const prompt = messages.flatMap(m => Array.isArray(m.content) ? m.content : [])
        .map(c => c.text ?? "").findLast(t => t.includes("\nIMMUTABLE REVIEW PACKET\n"));
      assert.ok(prompt);
      const packet = JSON.parse(prompt.split("\nIMMUTABLE REVIEW PACKET\n")[1]!);
      const item = packet.items[0];
      const ref = { commitSha: item.assurance.commitSha, assignmentId: item.assignment.id, path: characterPaths[1], line: 1 };
      return { content: scriptedText({ sourceDigest: packet.sourceDigest, verdict: i === 16 ? "fail" : "pass",
        findings: i === 16 ? [{ ...ref, kind: "missing-requirement", message: "Neri's reason for concealment is unspecified.",
          requiredCorrection: "Clarify the reason Neri protects the witness.", affectedPaths: [characterPaths[1]] }] : [],
        evidence: i === 19 ? [{ ...ref, explanation: "The threatened retaliation establishes Neri's motivation." }] : [],
        ...(i === 19 ? { progressDiagnosis: { status: "material", reason: "The fear of retaliation addresses the gap.",
          evidence: { path: characterPaths[1], quote: "Neri fears the official will retaliate against the missing witness.", change: "added" } } } : {}),
      }), reason: "stop" };
    }
    throw Error("Unexpected replacement writer/reviewer: " + i);
  });
  const old = Object.fromEntries(Object.keys(f.env).map(key => [key, process.env[key]]));
  Object.assign(process.env, f.env);
  const restoreSandbox = fixtureSandboxClient(f.job.jobId, f.job.worktreeStoryRoot);
  let saver = SqliteSaver.fromConnString(paused.checkpointPath);
  try {
    let graph = createGenerationGraph(saver, "cli");
    const cfg = { configurable: { thread_id: paused.threadId }, recursionLimit: 1000 };
    const item = paused.inventory.items.find((entry: { id: string }) => entry.id === "foundations");
    await graph.updateState(cfg, { status: "running", reason: null, active: item, result: null, pauseAfter: null,
    }, "author_update_intake");
    async function crashAtSubmission(status: string, calls: number, options: { interruptBefore?: string[]; interruptAfter?: string[] }) {
      const abort = new AbortController();
      const put = saver.put.bind(saver);
      const putWrites = saver.putWrites.bind(saver);
      let crashed = false;
      const error = Error("R14C injected SQLite loss after " + status);
      saver.put = async (...args) => {
        if (crashed) throw error;
        return put(...args);
      };
      saver.putWrites = async (config, writes, task) => {
        if (crashed) throw error;
        const submission = writes.find(([channel]) => channel === "submission")?.[1] as
          { status?: string } | undefined;
        if (config.configurable?.checkpoint_ns?.includes("assignment-") && submission?.status === status) {
          crashed = true;
          abort.abort(error);
          throw error;
        }
        return putWrites(config, writes, task);
      };
      await assert.rejects(withJobModelRuntime(runtime, () => graph.invoke(null, {
        ...cfg, ...options, signal: abort.signal, durability: "sync",
      })), err => { if (!crashed) throw err; return true; });
      assert.ok(crashed, "Actual child SQLite checkpoint must be lost");
      assert.equal(observed.length, calls);
      saver.db.close();
      saver = SqliteSaver.fromConnString(paused.checkpointPath);
      graph = createGenerationGraph(saver, "cli");
    }
    await crashAtSubmission("review-handoff", 5, { interruptBefore: ["assess_recovery"] });
    const firstCommit = git(f.job.worktreeRoot, "rev-parse", "HEAD");
    const firstPoint = (await inspectRecoveryCheckpoints(f.job)).find(p => p.commitSha === firstCommit);
    assert.equal(firstPoint?.workItem, "world-foundations");
    assert.equal(firstPoint?.semanticReview, "required-pending", "No independent Review before the native publication is checkpointed");
    const failed = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptBefore: ["assess_recovery"] }));
    assert.equal(failed.recoveryLifecycle.active?.origin.operation, "independent-review", JSON.stringify({reason: failed.reason, recovery: failed.recoveryLifecycle, calls: observed.length}));
    const original = JSON.parse(readFileSync(join(f.job.stateDir, "character-world.json"), "utf8"));
    assert.equal(original.units[1].phase, "pending");
    assert.equal(original.units[0].invocationProof.ordinal, 1);
    assert.match(original.units[0].assignmentKey, /^[a-f0-9]{64}$/);
    const preceding = (await inspectRecoveryCheckpoints(f.job)).filter(point =>
      ["foundation", "global-architecture"].includes(point.workItem));
    const selected = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] }));
    assert.equal(selected.recoveryLifecycle.decision?.action, "known-correction", JSON.stringify(selected.recoveryLifecycle));
    await assertSubunitReviewAuthority(f.job, selected, "world-foundations", "character-foundations", original.units[0].assignmentKey);
    const corrected = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["independent_assignment_review"] }));
    assert.equal(corrected.recoveryLifecycle.phase, "idle", JSON.stringify({reason: corrected.reason, recovery: corrected.recoveryLifecycle, calls: observed.length}));
    assert.equal(corrected.recoveryLifecycle.discharged.at(-1)?.case.id, selected.recoveryLifecycle.active?.id);
    assert.ok((await graph.getState(cfg)).next.includes("author_update_intake"));
    const correctedHead = git(f.job.worktreeRoot, "rev-parse", "HEAD");
    assert.notEqual(correctedHead, original.units[0].commitSha);
    const worldReviewer = await assertSubunitReviewSessions(f.job, original.units[0], correctedHead);
    assert.equal(corrected.result, null, "Passing World correction is not cluster completion");
    const reviewed = await inspectRecoveryCheckpoints(f.job);
    for (const point of preceding) {
      const retained = reviewed.find(entry => entry.commitSha === point.commitSha);
      assert.equal(retained?.proofDigest, point.proofDigest);
      assert.equal(retained?.semanticReview, point.semanticReview, "Unchanged prerequisite Review remains intact");
    }
    assert.equal(reviewed.find(point => point.commitSha === original.units[0].commitSha)?.semanticReview, "failed");
    assert.equal(reviewed.find(point => point.commitSha === correctedHead)?.semanticReview, "passed");
    assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, paused.threadId), corrected.recoveryLifecycle);
    assert.equal(JSON.parse(readFileSync(join(f.job.stateDir, "character-world.json"), "utf8")).units[1].phase, "pending");
    // Reopen the actual parent and child journal after passing World Review.
    saver.db.close();
    saver = SqliteSaver.fromConnString(paused.checkpointPath);
    graph = createGenerationGraph(saver, "cli");
    const resumed = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptBefore: ["assess_recovery"] }));
    assert.equal(resumed.recoveryLifecycle.active?.origin.operation, "independent-review", JSON.stringify({reason: resumed.reason, recovery: resumed.recoveryLifecycle, sources: resumed.recoverySources.slice(-1), calls: observed.length}));
    const after = JSON.parse(readFileSync(join(f.job.stateDir, "character-world.json"), "utf8"));
    assert.deepEqual(after.units[0], original.units[0]);
    assert.equal(after.units[1].beforeHead, correctedHead);
    assert.equal(after.units[1].phase, "committed");
    assert.equal(after.units[1].invocationProof.ordinal, 1);
    assert.notEqual(after.units[1].assignmentKey, original.units[0].assignmentKey);
    assert.notEqual(after.units[1].piSessionFile, original.units[0].piSessionFile);
    assert.equal(observed.length, 17);
    const characterSelected = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] }));
    assert.equal(characterSelected.recoveryLifecycle.decision?.action, "known-correction", JSON.stringify(characterSelected.recoveryLifecycle));
    await assertSubunitReviewAuthority(f.job, characterSelected, "character-foundations", "world-foundations", after.units[1].assignmentKey);
    await crashAtSubmission("repair-round", 19, { interruptAfter: ["independent_assignment_review"] });
    const repairedCharacterHead = git(f.job.worktreeRoot, "rev-parse", "HEAD");
    assert.notEqual(repairedCharacterHead, after.units[1].commitSha);
    assert.equal((await inspectRecoveryCheckpoints(f.job)).find(p => p.commitSha === repairedCharacterHead)?.semanticReview, "required-pending");
    const characterCorrected = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["independent_assignment_review"] }));
    assert.equal(characterCorrected.recoveryLifecycle.phase, "idle", JSON.stringify({reason: characterCorrected.reason, recovery: characterCorrected.recoveryLifecycle, calls: observed.length}));
    assert.equal(characterCorrected.recoveryLifecycle.discharged.at(-1)?.case.id, characterSelected.recoveryLifecycle.active?.id);
    assert.equal(characterCorrected.result?.status, "foundations-committed");
    assert.equal(characterCorrected.result?.headSha, git(f.job.worktreeRoot, "rev-parse", "HEAD"));
    assert.deepEqual(JSON.parse(readFileSync(join(f.job.stateDir, "character-world.json"), "utf8")), after);
    assert.equal(observed.length, 20);
    assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, paused.threadId), characterCorrected.recoveryLifecycle);
    assert.notEqual(await assertSubunitReviewSessions(f.job, after.units[1], repairedCharacterHead), worldReviewer);
    const next = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptBefore: ["specialist_dispatch"] }));
    assert.equal(next.inventory?.items.find(i => i.id === item.id)?.status, "verified", JSON.stringify({ reason: next.reason, active: next.active, recovery: next.recoveryLifecycle }));
    assert.equal(next.active?.stage, "event");
    assert.equal(next.request.turnPlanDigest, turnDigest);
    assert.equal(observed.length, 20);
    assert.equal((await inspectPiPolicy(f.job)).budget.modelCalls, preludeCalls + observed.length,
      "Restart, refused authority and parent intake cannot charge another model call.");
    assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), repairedCharacterHead);
  } finally {
    saver.db.close();
    restoreSandbox();
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("R14C Choice and Puzzle native and independent Review corrections preserve their distinct original assignments", { skip: !available, timeout: 120_000 }, async () => {
  const { archiveInteractiveRecords: records, archiveStages } = await import("./support/scripted-archive-stages.js");
  const f = setup("r14c-interactive-real");
  await useScriptedArchiveCli(f);
  const log = f.contract + ".model-calls";
  assert.equal(f.cli([...f.start, "--pause-after", "event"]).status, "paused");
  const paused = f.cli(["generate", "resume", "--pause-after", "event"]);
  assert.equal(paused.status, "paused", paused.reason + "\n" + readFileSync(log, "utf8"));
  const preludeCalls = readFileSync(log, "utf8").trim().split("\n").length;
  const turn = JSON.parse(readFileSync(join(f.job.stateDir, "turn-plan.json"), "utf8"));
  const turnDigest = turn.digest;
  const paths = ["choice-points/loyalty.md", "puzzles/ledger-proof.md"];
  const quote = ["The player recognizes the friendship cost before making the selection.",
    "The clue comparison makes the two proof routes intelligible before either is chosen."];
  const write = (path: string, content: string, id: string) => ({
    type: "toolCall" as const, name: "write", id, arguments: { path, content },
  });
  const { runtime, observed } = await scriptedStoryRuntime((i, context) => {
    const n = i < 10 ? 0 : 1, step = i % 10;
    const domain = n === 0 ? "nt-interactive-narrative" : "nt-puzzle-design";
    const path = paths[n]!, bytes = records[n]![path]!;
    assert.ok(bytes, path);
    const manifest = { modifiedRecords: Object.keys(records[n]!), architecturalConflicts: [],
      laterObligations: ["Conditional player-facing prose must be reviewed for choice and clue visibility"] };
    if (step === 0) return { content: scriptedReadCalls(boundedPinnedSources(domain).map(p => "skill://" + p), i), reason: "toolUse" };
    if (step === 1) return { content: Object.entries(records[n]!).map(([p, content], k) =>
      write(p, p === path ? content.replace("status: draft", "status: draft\nunknown_field: true") : content, "r14c-initial-" + i + "-" + k)), reason: "toolUse" };
    if (step === 2 || step === 4) return { content: scriptedText(manifest), reason: "stop" };
    if (step === 3) return { content: [write(path, bytes, "r14c-metadata-" + i)], reason: "toolUse" };
    if (step === 5) return { content: scriptedReadCalls(boundedPinnedSources("nt-narrative-review").map(p => "skill://" + p), i), reason: "toolUse" };
    if (step === 7) return { content: [write(path, bytes + "\n" + quote[n] + "\n", "r14c-review-" + i)], reason: "toolUse" };
    if (step === 8) return { content: scriptedText("Clarified the source-linked obligation."), reason: "stop" };
    if (step === 6 || step === 9) {
      const messages = context.messages as Array<{ content: Array<{ type: string; text?: string }> }>;
      const prompt = messages.flatMap(m => Array.isArray(m.content) ? m.content : [])
        .map(c => c.text ?? "").findLast(t => t.includes("\nIMMUTABLE REVIEW PACKET\n"));
      assert.ok(prompt);
      const packet = JSON.parse(prompt.split("\nIMMUTABLE REVIEW PACKET\n")[1]!);
      const item = packet.items[0];
      const ref = { commitSha: item.assurance.commitSha, assignmentId: item.assignment.id, path, line: 1 };
      return { content: scriptedText({ sourceDigest: packet.sourceDigest, verdict: step === 6 ? "fail" : "pass",
        findings: step === 6 ? [{ ...ref, kind: "missing-requirement", message: "The player-facing evidence is insufficiently explicit.",
          requiredCorrection: quote[n], affectedPaths: [path] }] : [],
        evidence: step === 9 ? [{ ...ref, explanation: quote[n] }] : [],
        ...(step === 9 ? { progressDiagnosis: { status: "material", reason: "The added prose addresses the original gap.",
          evidence: { path, quote: quote[n], change: "added" } } } : {}),
      }), reason: "stop" };
    }
    throw Error("Unexpected Interactive model call " + i);
  });
  const old = Object.fromEntries(Object.keys(f.env).map(key => [key, process.env[key]]));
  Object.assign(process.env, f.env);
  const restoreSandbox = fixtureSandboxClient(f.job.jobId, f.job.worktreeStoryRoot);
  let saver = SqliteSaver.fromConnString(paused.checkpointPath);
  try {
    let graph = createGenerationGraph(saver, "cli");
    const cfg = { configurable: { thread_id: paused.threadId }, recursionLimit: 1000 };
    const item = paused.inventory.items.find((entry: { id: string }) => entry.id === "interactive:milestone.disclosure");
    assert.ok(item);
    await graph.updateState(cfg, { status: "running", reason: null, active: item, result: null, pauseAfter: null,
    }, "author_update_intake");
    async function crashAtSubmission(status: string, calls: number, options: { interruptBefore?: string[]; interruptAfter?: string[] }) {
      const abort = new AbortController();
      const put = saver.put.bind(saver);
      const putWrites = saver.putWrites.bind(saver);
      let crashed = false;
      const error = Error("R14C injected SQLite loss after " + status);
      saver.put = async (...args) => {
        if (crashed) throw error;
        return put(...args);
      };
      saver.putWrites = async (config, writes, task) => {
        if (crashed) throw error;
        const submission = writes.find(([channel]) => channel === "submission")?.[1] as
          { status?: string } | undefined;
        if (config.configurable?.checkpoint_ns?.includes("assignment-") && submission?.status === status) {
          crashed = true;
          abort.abort(error);
          throw error;
        }
        return putWrites(config, writes, task);
      };
      await assert.rejects(withJobModelRuntime(runtime, () => graph.invoke(null, {
        ...cfg, ...options, signal: abort.signal, durability: "sync",
      })), err => { if (!crashed) throw err; return true; });
      assert.ok(crashed, "Actual child SQLite checkpoint must be lost");
      assert.equal(observed.length, calls);
      saver.db.close();
      saver = SqliteSaver.fromConnString(paused.checkpointPath);
      graph = createGenerationGraph(saver, "cli");
    }
    await crashAtSubmission("interactive-choice-committed", 5, { interruptBefore: ["assess_recovery"] });
    const firstCommit = git(f.job.worktreeRoot, "rev-parse", "HEAD");
    const firstPoint = (await inspectRecoveryCheckpoints(f.job)).find(p => p.commitSha === firstCommit);
    assert.equal(firstPoint?.workItem, "interactive-choice-disclosure");
    assert.equal(firstPoint?.semanticReview, "required-pending");
    const original = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptBefore: ["assess_recovery"] }));
    assert.equal(original.recoveryLifecycle.active?.origin.operation, "independent-review", JSON.stringify({reason: original.reason, calls: observed.length}));
    assert.equal(observed.length, 7);
    const choice = JSON.parse(readFileSync(join(f.job.stateDir, "interactive-items/disclosure.json"), "utf8"));
    assert.equal(choice.units[1].phase, "pending");
    assert.equal(choice.units[0].invocationProof.ordinal, 1);
    const decision = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] }));
    assert.equal(decision.recoveryLifecycle.decision?.action, "known-correction");
    await assertSubunitReviewAuthority(f.job, decision, "interactive-choice-disclosure", "interactive-puzzle-disclosure", choice.units[0].assignmentKey);
    const corrected = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["independent_assignment_review"] }));
    assert.equal(corrected.recoveryLifecycle.phase, "idle", JSON.stringify({reason: corrected.reason, calls: observed.length}));
    assert.equal(corrected.result, null);
    assert.equal(observed.length, 10);
    assert.equal(corrected.recoveryLifecycle.discharged.at(-1)?.case.id, decision.recoveryLifecycle.active?.id);
    assert.ok((await graph.getState(cfg)).next.includes("author_update_intake"));
    const choiceHead = git(f.job.worktreeRoot, "rev-parse", "HEAD");
    assert.notEqual(choiceHead, choice.units[0].commitSha);
    const choiceReviewer = await assertSubunitReviewSessions(f.job, choice.units[0], choiceHead);
    saver.db.close();
    saver = SqliteSaver.fromConnString(paused.checkpointPath);
    graph = createGenerationGraph(saver, "cli");
    const negative = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptBefore: ["assess_recovery"] }));
    assert.equal(negative.recoveryLifecycle.active?.origin.operation, "independent-review", JSON.stringify({reason: negative.reason, calls: observed.length}));
    assert.equal(observed.length, 17);
    const both = JSON.parse(readFileSync(join(f.job.stateDir, "interactive-items/disclosure.json"), "utf8"));
    assert.deepEqual(both.units[0], choice.units[0]);
    assert.equal(both.units[1].beforeHead, choiceHead);
    assert.equal(both.units[1].invocationProof.ordinal, 1);
    assert.notEqual(both.units[0].assignmentKey, both.units[1].assignmentKey);
    assert.notEqual(both.units[0].piSessionFile, both.units[1].piSessionFile);
    const selected = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] }));
    assert.equal(selected.recoveryLifecycle.decision?.action, "known-correction");
    await assertSubunitReviewAuthority(f.job, selected, "interactive-puzzle-disclosure", "interactive-choice-disclosure", both.units[1].assignmentKey);
    await crashAtSubmission("repair-round", 19, { interruptAfter: ["independent_assignment_review"] });
    const repairedPuzzleHead = git(f.job.worktreeRoot, "rev-parse", "HEAD");
    assert.notEqual(repairedPuzzleHead, both.units[1].commitSha);
    assert.equal((await inspectRecoveryCheckpoints(f.job)).find(p => p.commitSha === repairedPuzzleHead)?.semanticReview, "required-pending");
    const { preflightCompositionBoundary } = await import("../src/cross-domain-prerequisite-controller.js");
    const preflight = () => preflightCompositionBoundary(f.job, selected.request,
      "milestone.disclosure", selected.planVersion!);
    const unreviewed = await preflight();
    assert.deepEqual(unreviewed, { kind: "refuse", reason: "Deferred Milestone has no fresh independently approved Choice/Puzzle prerequisite." });
    const complete = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["independent_assignment_review"] }));
    assert.equal(complete.recoveryLifecycle.phase, "idle", JSON.stringify({reason: complete.reason, calls: observed.length}));
    assert.equal(complete.recoveryLifecycle.discharged.at(-1)?.case.id, selected.recoveryLifecycle.active?.id);
    assert.equal(complete.result?.status, "interactive-slice-committed");
    assert.equal(observed.length, 20);
    assert.equal(complete.result?.headSha, git(f.job.worktreeRoot, "rev-parse", "HEAD"));
    for (let i = 0; i < 2; i++) assert.ok(readFileSync(join(f.job.worktreeStoryRoot, paths[i]!), "utf8").includes(quote[i]!));
    assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
    assert.notEqual(await assertSubunitReviewSessions(f.job, both.units[1], repairedPuzzleHead), choiceReviewer);
    // The real Event grant permits exactly its selected Milestone closeout;
    // it is not a general writer grant or a Composition completion.
    const closeout = await preflight();
    assert.equal(closeout.kind, "repair", JSON.stringify(closeout));
    const scheduled = await withJobModelRuntime(runtime, () => graph.invoke(null,
      { ...cfg, interruptBefore: ["specialist_dispatch", "assess_recovery"] }));
    assert.equal(scheduled.active?.id, "interactive:milestone.reckoning");
    const omission = await scriptedStoryRuntime(archiveStages(f.job, turn));
    const next = await withJobModelRuntime(omission.runtime, () => graph.invoke(null,
      { ...cfg, interruptBefore: ["assess_recovery"] }));
    assert.equal(omission.observed.length, 2);
    assert.equal(next.inventory?.items.find(i => i.id === item.id)?.status, "verified", JSON.stringify({ reason: next.reason, active: next.active, recovery: next.recoveryLifecycle }));
    assert.equal(next.recoveryLifecycle.active?.origin.operation, "dependency-amendment", JSON.stringify({ reason: next.reason, recovery: next.recoveryLifecycle, active: next.active }));
    assert.equal(next.recoveryLifecycle.active?.origin.assignmentId, "composition:milestone.disclosure");
    assert.equal(next.recoveryLifecycle.active?.observation, "returned-failure");
    assert.equal(next.crossDomainCloseout?.milestoneId, "milestone.disclosure", JSON.stringify({ reason: next.reason, closeout: next.crossDomainCloseout }));
    assert.equal(next.inventory?.items.find(i => i.id === "composition:milestone.disclosure")?.status !== "verified", true);
    assert.equal(next.request.turnPlanDigest, turnDigest);
    assert.equal(observed.length, 20);
    assert.equal((await inspectPiPolicy(f.job)).budget.modelCalls, preludeCalls + observed.length + omission.observed.length,
      "Restart, refused authority and parent intake cannot charge another model call.");
    assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), repairedPuzzleHead);
  } finally {
    saver.db.close();
    restoreSandbox();
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("R06 real Interactive Pi manifest correction preserves the original session and zero-write dependency", {
  skip: !available, timeout: 120_000,
}, async () => {
  const f = setup("r06-original-choice-pi");
  await useScriptedArchiveCli(f);
  const log = f.contract + ".model-calls";
  assert.equal(f.cli([...f.start, "--pause-after", "event"]).status, "paused");
  const paused = f.cli(["generate", "resume", "--pause-after", "event"]);
  assert.equal(paused.status, "paused", paused.reason + "\n" + readFileSync(log, "utf8"));
  const env = Object.fromEntries(Object.keys(f.env).map(key => [key, process.env[key]]));
  Object.assign(process.env, f.env);
  const restoreSandbox = fixtureSandboxClient(f.job.jobId, f.job.worktreeStoryRoot);
  try {
    const { runtime, observed } = await scriptedStoryRuntime(i => {
      if (i === 0) return { content: scriptedReadCalls(
        boundedPinnedSources("nt-interactive-narrative").map(p => "skill://" + p), i), reason: "toolUse" };
      if (i === 1) return { content: scriptedText("malformed output"), reason: "stop" };
      if (i === 2) return { content: scriptedText({ modifiedRecords: [],
        architecturalConflicts: ["The approved local Choice depends on a missing upstream Event effect."],
        laterObligations: ["Preserve the author's required local decision."] }), reason: "stop" };
      throw Error("Original Interactive writer was replayed");
    });
    const turn = JSON.parse(readFileSync(join(f.job.stateDir, "turn-plan.json"), "utf8"));
    const opts = { story: f.story, job: "single", action: "run" as const,
      milestone: "milestone.disclosure", unit: "choice" as const, fixture: false,
      skillsSource: source, provider: scriptedModel.provider, model: scriptedModel.id,
      generationObjective: f.start[3]!, turnPlanDigest: turn.digest };
    const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
    const assignmentKey = "a".repeat(64);
    const initial = await withJobModelRuntime(runtime, () => runInteractiveWorkItem({
      ...opts, round: { assignmentKey, command: { phase: "invoke" } },
    }));
    assert.equal(initial.status, "writer-round");
    assert.equal(initial.round?.status, "settled");
    assert.ok(initial.round);
    await assert.rejects(withJobModelRuntime(runtime, () => runInteractiveWorkItem({
      ...opts, round: { assignmentKey: "b".repeat(64), command: { phase: "verify", proof: initial.round!.proof } },
    })), /Foreign Interactive assignment round/);
    assert.equal(observed.length, 3);
    const result = await withJobModelRuntime(runtime, () => runInteractiveWorkItem({
      ...opts, round: { assignmentKey, command: { phase: "verify", proof: initial.round!.proof } },
    }));
    assert.equal(result.status, "interactive-conflict-reported");
    assert.equal(observed.length, 3);
    assert.equal(observed[2]!.tools.includes("write"), false);
    const original = JSON.parse(readFileSync(join(f.job.stateDir, "interactive-items/disclosure.json"), "utf8"));
    const unit = original.units[0];
    assert.equal(unit.phase, "conflicted");
    assert.equal(unit.invocationProof.ordinal, 0);
    assert.ok(unit.piSessionId);
    const proof = await inspectInteractiveConflict(f.job, "milestone.disclosure");
    assert.equal(proof.reportDigest, unit.digest);
    const receiptFile = join(f.job.stateDir, "interactive-items/disclosure.json");
    const withoutProof = structuredClone(original);
    delete withoutProof.units[0].invocation;
    delete withoutProof.units[0].invocationProof;
    writeFileSync(receiptFile, JSON.stringify(withoutProof));
    await assert.rejects(inspectInteractiveConflict(f.job, "milestone.disclosure"), /settled invocation proof/);
    const foreignGrant = structuredClone(original);
    foreignGrant.units[0].invocation.assignment.sourcePaths = ["events/unrelated.md"];
    writeFileSync(receiptFile, JSON.stringify(foreignGrant));
    await assert.rejects(inspectInteractiveConflict(f.job, "milestone.disclosure"), /settled invocation proof/);
    writeFileSync(receiptFile, JSON.stringify(original));
    assert.deepEqual(await inspectInteractiveConflict(f.job, "milestone.disclosure"), proof);
    const again = await withJobModelRuntime(runtime, () => runInteractiveWorkItem({ ...opts, round: { assignmentKey, command: { phase: "verify", proof: initial.round!.proof } } }));
    assert.equal(again.status, result.status);
    assert.equal(observed.length, 3);
    assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
  } finally {
    restoreSandbox();
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("generation preserves unexpected edits and rejects new contracts on resume", { skip: !available }, async () => {
  const f = setup("dirty");
  await useScriptedFoundationCli(f);
  const paused = f.cli([...f.start, "--pause-after", "foundation"]);
  assert.equal(paused.status, "paused", JSON.stringify(paused));
  const receipt = JSON.parse(readFileSync(join(f.job.stateDir, "foundation.json"), "utf8"));
  assert.equal(receipt.workerMode, "pi");
  assert.ok(receipt.piSessionFile);
  assert.ok(receipt.invocationProof);
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const path = join(f.job.worktreeStoryRoot, "author-notes.txt");
  writeFileSync(path, "Preserve my unfinished work");
  const result = f.cli(["generate", "resume"]);
  assert.equal(result.status, "blocked");
  assert.equal(result.recoveryInspection.phase, "fenced");
  assert.ok(result.recoveryInspection.fences.length, JSON.stringify(result.recoveryInspection));
  assert.equal(readFileSync(path, "utf8"), "Preserve my unfinished work");
  const inspection = f.cli(["generate", "inspect"]);
  assert.equal(inspection.status, "blocked");
  assert.match(inspection.reason, /clean|unexpected|dirty/i);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
  assert.match(f.cli(["generate", "resume", "--contract", f.contract], false), /pinned/);
  assert.match(f.cli(f.start, false), /already exists/);
  assert.equal(readFileSync(f.contract + ".model-calls", "utf8").trim().split("\n").length, 8);
});

test("inspection detects dirty work after a saved pause without advancing checkpoints", { skip: !available }, async () => {
  const f = setup("inspect-drift");
  await useScriptedFoundationCli(f);
  const paused = f.cli([...f.start, "--pause-after", "foundation"]);
  assert.equal(paused.status, "paused", JSON.stringify(paused));
  const receipt = JSON.parse(readFileSync(join(f.job.stateDir, "foundation.json"), "utf8"));
  assert.equal(receipt.workerMode, "pi");
  assert.ok(receipt.piSessionFile);
  assert.ok(receipt.invocationProof);
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  writeFileSync(join(f.job.worktreeStoryRoot, "new.txt"), "Do not overwrite");
  const inspection = f.cli(["generate", "inspect"]);
  assert.equal(inspection.status, "blocked");
  assert.equal(inspection.checkpointStatus, "paused");
  assert.equal(readFileSync(f.contract + ".model-calls", "utf8").trim().split("\n").length, 8);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
});

test("R01 obsolete Generation entry is fenced before any model or Git effect", {
  skip: !available, timeout: 120_000,
}, async () => {
  const f = setup("r01-reject-obsolete");
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope = { kind: "full-story", depth: "composition", targets: [], branches: [] };
  writeFileSync(f.contract, JSON.stringify(contract));
  const args = f.start.filter(arg => arg !== "--fixture");
  assert.match(f.cli(args, false), /authenticated (current-format )?Turn plan/);
  const plan = planWholeStory(f.start[3]!, contract, f.job.baseSha);
  const planPath = join(f.job.stateDir, "turn-plan.json");
  const before = Object.fromEntries(Object.keys(f.env).map(key => [key, process.env[key]]));
  Object.assign(process.env, f.env);
  try {
    const { runtime, observed } = await scriptedStoryRuntime(() => {
      throw Error("Unauthenticated Generation attempted a model effect");
    });
    for (const owner of ["cli", "server"] as const) {
      for (const [name, digest, corrupt] of [
        ["absent", undefined, false],
        ["malformed", "not-a-digest", false],
        ["missing-receipt", plan.digest, false],
        ["wrong-digest", "f".repeat(64), false],
        ["corrupt-receipt", plan.digest, true],
      ] as const) {
        if (existsSync(planPath)) unlinkSync(planPath);
        if (name === "wrong-digest" || corrupt)
          writeFileSync(planPath, JSON.stringify(corrupt ? { ...plan, goal: "tampered" } : plan));
        const saver = SqliteSaver.fromConnString(join(f.job.stateDir, owner + "-" + name + ".sqlite"));
        try {
          const graph = createGenerationGraph(saver, owner);
          const cfg = { configurable: { thread_id: f.job.threadId +
            (owner === "server" ? ":generation:web" : ":generation") } };
          const request = { story: f.story, job: "single", task: f.start[3]!,
            contract, fixture: false, skillsSource: source,
            orchestrationPolicy: "explicit" as const,
            ...(digest === undefined ? {} : { turnPlanDigest: digest }) };
          if (name === "malformed") {
            // LangGraph validates malformed external input before the first node.
            await assert.rejects(withJobModelRuntime(runtime, () =>
              graph.invoke({ request }, cfg)), /turnPlanDigest|invalid_format/);
          } else {
            const output = await withJobModelRuntime(runtime, () =>
              graph.invoke({ request }, cfg));
            assert.equal(output.status, "blocked", owner + "/" + name + ": " + output.reason);
            assert.equal(output.recoveryLifecycle.phase, "fenced");
          }
          assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), f.initial);
          assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
          assert.equal(existsSync(join(f.job.stateDir, "foundation.json")), false);
          assert.equal(existsSync(join(f.job.stateDir, "orchestrator-selection.json")), false);
          assert.equal(existsSync(join(f.job.stateDir, "generation-server-owner.json")), false);
        } finally { saver.db.close(); }
      }
    }
    assert.equal(observed.length, 0);
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

for (const scenario of ["cli", "server", "author-pause", "protocol-exhausted", "nonconverging", "nonconverging-continue", "nonconverging-continue-crash", "nonconverging-continue-budget", "nonconverging-continue-tamper", "nonconverging-continue-transcript", "nonconverging-continue-uncertain", "nonconverging-continue-foreign-file", "nonconverging-continue-cancel", "nonconverging-unsafe", "nonconverging-foreign", "review-rejected", "review-converges", "review-stalled", "review-dispute", "review-stalled-continue", "review-scope", "review-session-unavailable", "review-reviewer-unavailable", "review-protected", "review-native", "review-native-steer", "review-native-protected", "review-native-protocol", "review-native-stall", "review-native-diagnosis", "review-crash-rounds", "crash-rounds", "crash-grant-tamper", "crash-assignment-tamper", "crash-cancel"] as const)
test("R01 production Foundation enters checkpointed child before scripted Pi; native Git and independent Review remain authoritative (" + scenario + ")", {
  skip: !available, timeout: 240_000,
}, async () => {
  const owner = scenario === "cli" ? "cli" : "server";
  const diagnosticContinue = scenario.startsWith("nonconverging-continue");
  const terminal = scenario === "protocol-exhausted" || scenario.startsWith("nonconverging");
  const realReview = scenario.startsWith("review-");
  const crashRounds = scenario.startsWith("crash-");
  const stalled = scenario === "review-stalled" || scenario === "review-stalled-continue";
  const dispute = scenario === "review-dispute";
  const scopeRevision = scenario === "review-scope";
  const nativeRepair = scenario.startsWith("review-native");
  const reviewCrash = scenario === "review-crash-rounds" || nativeRepair;
  const revising = scenario === "review-converges" || stalled || reviewCrash;
  const f = setup("r01-real-foundation-pi-" + scenario);
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope = { kind: "full-story", depth: "composition", targets: [], branches: [] };
  const plan = planWholeStory(f.start[3]!, contract, f.job.baseSha);
  const pinnedDigest = plan.digest;
  writeFileSync(join(f.job.stateDir, "turn-plan.json"), JSON.stringify(plan));
  const before = Object.fromEntries(Object.keys(f.env).map(key => [key, process.env[key]]));
  Object.assign(process.env, f.env);
  const restoreSandbox = fixtureSandboxClient(f.job.jobId, f.job.worktreeStoryRoot);
  try {
    const authored = renderFoundation({
      id: "foundation", title: "The Last Bell",
      premise: "A midnight bell reveals an archive theft.",
      central_conflict: "The archivist must decide whether to expose a witness.",
      genre: "Mystery", tone: "Suspenseful",
      player_experience: "Interview witnesses and resolve a consequential secret.",
      scope: "A small town, a single archive, two major decisions",
      decisions: [
        { id: "author-brief", statement: "A missing archive witness; invent unspecified details",
          origin: "user", authority: "user-protected" },
        { id: "archive-bell", statement: "A bell marks the last known sighting",
          origin: "agent", authority: "delegated" },
      ],
      body: "# The Last Bell\n\nThe archivist hears a bell from a shuttered building. Each interview reveals new evidence; the protagonist may protect the witness or share the truth.",
    });
    const reads = [
      "nt-story-discovery/SKILL.md", "nt-catalog/SKILL.md",
      "nt-catalog/references/records.md",
      "nt-catalog/references/authority-and-validation.md",
      "nt-catalog/references/glossary.md",
    ].map(path => "skill://" + path);
    const { runtime, observed } = await scriptedStoryRuntime((index, context) => {
      if (index === 0) return { content: scriptedReadCalls(requiredOrchestratorSkillReads("autonomous")
        .map(path => "skill://" + path), 0), reason: "toolUse" };
      if (index === 1) return { content: scriptedText({ sourceSha: f.job.baseSha,
        turnDigest: pinnedDigest, assignments: plan.assignments.map(a => ({ id: a.id,
          reason: "Perform the source-bound author objective in causal order." })) }), reason: "stop" };
      const i = index - 2;
      if (i === 0) return { content: scriptedReadCalls(reads, 0), reason: "toolUse" };
      const target = "creative-direction/foundation.md";
      const report = { modifiedRecords: [target], architecturalConflicts: [], laterObligations: [] };
      if (i === 1) return { content: [{
        type: "toolCall", name: "write", id: "r01-real-foundation-write",
        arguments: { path: target, content: authored.replace("central_conflict:", "unsupported_field: true\ncentral_conflict:") },
      }], reason: "toolUse" };
      if (i === 2) return { content: [{
        type: "toolCall", name: "story_validate", id: "r01-foundation-validate", arguments: {},
      }], reason: "toolUse" };
      if (scenario === "protocol-exhausted" && i >= 3 && i <= 5)
        return { content: scriptedText("Malformed report " + i), reason: "stop" };
      if (scenario.startsWith("nonconverging")) {
        if (i === 3 || i === 5 || i === 7) return { content: scriptedText(report), reason: "stop" };
        if (i === 4 || i === 6) return { content: [{
          type: "toolCall", name: "write", id: "r02-repeat-invalid-" + i,
          arguments: { path: target, content: authored.replace("central_conflict:", "unsupported_field: true\ncentral_conflict:") },
        }], reason: "toolUse" };
        if (i === 8) {
          const serialized = JSON.stringify(context.messages);
          const signature = serialized.match(/signature=([0-9a-f]{64})/)?.[1];
          const sourceRef = serialized.match(/sourceRef=([^;]+); category=/)?.[1];
          assert.ok(signature && sourceRef, "Independent assessor receives its own case identity");
          assert.match(serialized, /assignmentDefects/);
          return { content: scriptedText({ schema: "noveltea-recovery-diagnostic-proposal/v1",
            signature, sourceRef, category: "defect",
            diagnosis: "The original metadata correction repeatedly retained the same invalid schema field.",
            strategy: diagnosticContinue || scenario === "nonconverging-foreign" ? "local-repair" :
              scenario === "nonconverging-unsafe" ? "unsafe" : "review-adjudication",
            owner: diagnosticContinue ? "foundation" : scenario === "nonconverging-foreign" ? "composition" : null,
            scopeRef: diagnosticContinue || scenario === "nonconverging-foreign" ? sourceRef : null, prerequisites: [],
            uncertainty: diagnosticContinue ? "Native validation must confirm the exact corrected metadata." : "No currently admitted successor correction." }), reason: "stop" };
        }
        if (diagnosticContinue && i === 9) {
          assert.match(JSON.stringify(context.messages), /INDEPENDENT DIAGNOSTIC FOLLOW-UP/);
          if (scenario === "nonconverging-continue-uncertain") throw Error("Injected transport loss after writer start");
          return { content: [{ type: "toolCall", name: "write", id: "r14h-diagnostic-successor",
            arguments: { path: target, content: authored } }], reason: "toolUse" };
        }
        if (diagnosticContinue && i === 10) return { content: scriptedText(report), reason: "stop" };
        if (diagnosticContinue && i === 11)
          return { content: scriptedReadCalls(boundedPinnedSources("nt-narrative-review")
            .map(path => "skill://" + path), i), reason: "toolUse" };
        if (!diagnosticContinue || i !== 12) throw Error("Nonconverging writer must not replay.");
      }
      if (i === 3) {
        if (scenario === "author-pause") {
          const controlDir = join(f.job.stateDir, "author-updates");
          mkdirSync(controlDir, { recursive: true });
          writeFileSync(join(controlDir, "control.json"), JSON.stringify({
            version: 1, jobId: f.job.jobId, state: "paused",
          }));
        }
        return { content: scriptedText("Malformed report"), reason: "stop" };
      }
      if (i === 4) return { content: scriptedText(report), reason: "stop" };
      if (i === 5 || i === 7) return { content: [{
        type: "toolCall", name: "write", id: "r02-corrective-write-" + i,
        arguments: { path: target, content: i === 5 ? authored.replace("origin: user\n    authority: user-protected", "origin: agent\n    authority: delegated") : authored },
      }, ...(i === 5 ? [{ type: "toolCall" as const, name: "write", id: "r02-foreign-write",
        arguments: { path: "events/foreign.md", content: "Unauthorized" } }] : [])], reason: "toolUse" };
      if (i === 6 || i === 8) return { content: scriptedText(report), reason: "stop" };
      if (i === 9)
        return { content: scriptedReadCalls(boundedPinnedSources("nt-narrative-review")
          .map(path => "skill://" + path), i), reason: "toolUse" };
      if (scopeRevision && i === 11)
        return { content: scriptedText("The author must specify whether the witness is complicit or simply an observer."), reason: "stop" };
      if (scopeRevision && i === 12)
        return { content: [{ type: "toolCall", name: "write", id: "r03-scope-write",
          arguments: { path: target, content: authored + "\nThe witness saw the thief use the stolen key.\n" } }], reason: "toolUse" };
      if (scopeRevision && i === 13)
        return { content: scriptedText("The witness is an observer, as the author directed."), reason: "stop" };
      if (scopeRevision && i === 14)
        return { content: scriptedReadCalls(boundedPinnedSources("nt-narrative-review")
          .map(path => "skill://" + path), i), reason: "toolUse" };
      if (dispute && i === 11)
        return { content: scriptedText("DISPUTE_REVIEW: " + target + ":1 | The source already supports the witness motivation."), reason: "stop" };
      if ((dispute && i === 12) || (stalled && i === 17))
        return { content: scriptedReadCalls(boundedPinnedSources("nt-narrative-review")
          .map(path => "skill://" + path), i), reason: "toolUse" };
      if (stalled && i === 18) {
        const messages = context.messages as Array<{ content: Array<{ type: string; text?: string }> }>;
        const prompt = messages.flatMap(m => Array.isArray(m.content) ? m.content : [])
          .map(c => c.text ?? "").findLast(t => t.includes("INDEPENDENT POSTCOMMIT DIAGNOSTIC"));
        assert.ok(prompt);
        const sourceDigest = prompt.match(/sourceDigest: ([a-f0-9]{64});/)?.[1];
        assert.ok(sourceDigest);
        const packet = JSON.parse(prompt.split("IMMUTABLE SOURCE AND REQUIREMENTS: ")[1]!.split("\nORIGINAL ASSIGNMENT OUTCOME:")[0]!);
        return { content: scriptedText({ schema: "noveltea-postcommit-diagnosis/v1", sourceDigest,
          action: scenario === "review-stalled-continue" ? "continue" : "replace",
          explanation: "The prior two corrections have not resolved the substantive witness obligation.",
          assessments: [{ kind: "cosmetic", reason: "The reviewer has not accepted the actual witness evidence.",
            requirement: { quote: packet.items[0].assignment.outcome.slice(0, 60) },
            evidence: { path: target, quote: "The witness took a ledger from the archive before the theft." } }] }), reason: "stop" };
      }
      if (nativeRepair && i === 11)
        return { content: [{ type: "toolCall", name: "write", id: "r14b-invalid-native-repair",
          arguments: { path: target, content: (scenario === "review-native-protected" ? authored.replace("A missing archive witness; invent unspecified details", "Replace the protected author brief") : authored).replace("central_conflict:", "unsupported_field: true\ncentral_conflict:") + "\nThe witness took a ledger from the archive before the theft.\n" } }], reason: "toolUse" };
      if (nativeRepair && i === 12)
        return { content: scriptedText("Corrected the witness obligation but introduced invalid metadata."), reason: "stop" };
      if (scenario === "review-native-protocol" && i >= 13 && i <= 15)
        return { content: scriptedText("Still not a structured report."), reason: "stop" };
      if ((scenario === "review-native-stall" || scenario === "review-native-diagnosis") && (i === 13 || i === 14))
        return { content: scriptedText(report), reason: "stop" };
      if ((scenario === "review-native-stall" || scenario === "review-native-diagnosis") && i === 15) {
        const serialized = JSON.stringify(context.messages);
        const signature = serialized.match(/signature=([a-f0-9]{64});/)?.[1];
        const sourceRef = serialized.match(/sourceRef=([^;]+); category=/)?.[1];
        assert.ok(signature && sourceRef);
        assert.match(serialized, /assignmentDefects/);
        return { content: scriptedText({ schema: "noveltea-recovery-diagnostic-proposal/v1",
          signature, sourceRef, category: "defect", diagnosis: "The native correction did not converge.",
          strategy: scenario === "review-native-diagnosis" ? "local-repair" : "review-adjudication",
          owner: scenario === "review-native-diagnosis" ? "foundation" : null,
          scopeRef: scenario === "review-native-diagnosis" ? sourceRef : null, prerequisites: [],
          uncertainty: "Native validation and independent Review remain required."  }), reason: "stop" };
      }
      if (scenario === "review-native-diagnosis" && i === 16) {
        assert.match(JSON.stringify(context.messages), /INDEPENDENT DIAGNOSTIC FOLLOW-UP/);
        return { content: [{ type: "toolCall", name: "write", id: "native-review-diagnosed",
          arguments: { path: target, content: authored + "\nThe witness took a ledger from the archive before the theft.\n" } }], reason: "toolUse" };
      }
      if (scenario === "review-native-diagnosis" && i === 17) return { content: scriptedText(report), reason: "stop" };
      if (nativeRepair && i === 13) {
        assert.match(JSON.stringify(context.messages.at(-1)), /Native|native diagnostics/);
        return { content: [{ type: "toolCall", name: "write", id: "r14b-native-repair",
          arguments: { path: target, content: authored + "\nThe witness took a ledger from the archive before the theft.\n" } }], reason: "toolUse" };
      }
      if (nativeRepair && i === 14) return { content: scriptedText(report), reason: "stop" };
      const revisionIndex = scenario === "review-native-diagnosis" && i >= 18 ? i - 5 : nativeRepair && i >= 15 ? i - 2 : stalled && i >= 19 ? i - 2 : i;
      const correction = revisionIndex >= 11 ? Math.floor((revisionIndex - 11) / 3) + 1 : 0;
      const correctionStep = (revisionIndex - 11) % 3;
      const revisions = [
        "The witness took a ledger from the archive before the theft.",
        "The ledger records the stolen archive key at midnight.",
        "The witness must identify who used the stolen key.",
      ];
      if (revising && correction && correctionStep === 0)
        return { content: [{ type: "toolCall", name: "write", id: "r03-writer-" + correction,
          arguments: { path: target, content: authored + "\n" + revisions.slice(0, correction).join("\n") + "\n" } }], reason: "toolUse" };
      if (revising && correction && correctionStep === 1)
        return { content: scriptedText("Corrected the source-linked witness obligation."), reason: "stop" };
      if (i === 10 || diagnosticContinue && i === 12 || revising && correctionStep === 2 || dispute && i === 13 || scopeRevision && i === 15) {
        const messages = context.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
        const prompt = messages.flatMap(m => Array.isArray(m.content) ? m.content : [])
          .map(c => c.text ?? "").findLast(text => text.includes("\nIMMUTABLE REVIEW PACKET\n"));
        assert.ok(prompt, "Original reviewer receives the source-bound packet");
        const packet = JSON.parse(prompt.split("\nIMMUTABLE REVIEW PACKET\n")[1]!);
        const item = packet.items[0];
        const pass = !realReview || diagnosticContinue || crashRounds || reviewCrash && correction === 1 || correction === 3 || dispute && i === 13 || scopeRevision && i === 15;
        const finding = { commitSha: item.assurance.commitSha, assignmentId: item.assignment.id,
          path: target, line: 1, kind: "missing-requirement",
          message: "The witness causal connection still needs the next specific link.",
          requiredCorrection: scenario === "review-protected" ? "Create a new character record and change a protected author decision." : "Specify the witness's concrete causal connection to the archive theft.",
          affectedPaths: [target] };
        return { content: scriptedText({ sourceDigest: packet.sourceDigest, verdict: pass ? "pass" : "fail",
          findings: pass ? [] : [finding],
          evidence: pass ? [{ commitSha: item.assurance.commitSha, assignmentId: item.assignment.id,
            path: target, line: 1, explanation: "The corrected source establishes the required causal connection." }] : [],
          ...(correction && !dispute && !scopeRevision ? { progressDiagnosis: { status: stalled && !pass ? "stalled" : "material",
            reason: stalled && !pass ? "The new source still fails to resolve the material blocker." : "The exact changed line materially addresses the previous causal gap.",
            evidence: stalled && !pass ? null : { path: target, quote: revisions[correction - 1], change: "added" } } } : {}),
        }), reason: "stop" };
      }
      throw Error("R01 writer replayed or called another model unexpectedly: " + i);
    });
    const checkpointFile = join(f.job.stateDir, "r01-generation.sqlite");
    let saver = SqliteSaver.fromConnString(checkpointFile);
    const config = { configurable: { thread_id: f.job.threadId +
      (owner === "server" ? ":generation:web" : ":generation") },
      recursionLimit: 10000 };
    try {
      const makeGraph = () => createGenerationGraph(saver, owner);
      let graph = makeGraph();
      const input = { request: {
        story: f.story, job: "single", task: f.start[3]!,
        contract, turnPlanDigest: pinnedDigest,
        fixture: false, skillsSource: source, validatorSource: source,
        provider: scriptedModel.provider, model: scriptedModel.id,
        orchestrationPolicy: "explicit" as const,
      } };
      const { configurePiPolicy } = await import("../src/job-pi-policy.js");
      if (scenario === "server") await configurePiPolicy(f.job, {
        version: 1, profile: { provider: scriptedModel.provider, model: scriptedModel.id },
        limits: { modelCalls: 7 },
      });
      if (crashRounds) {
        // Lose the actual child write checkpoint, not the worker receipt.
        // Stop the parent as well, as a process failure would; no exception
        // may be classified as a fresh specialist failure by the assessor.
        const cuts = [
          { kind: "submission", ordinal: 0, calls: 7 },
          { kind: "correction", ordinal: 0, calls: 7 },
          { kind: "submission", ordinal: 1, calls: 9 },
        ] as const;
        let sessionId: string | undefined;
        for (const cut of scenario === "crash-rounds" ? cuts : [cuts[1]]) {
          const abort = new AbortController();
          const originalPut = saver.put.bind(saver);
          const originalWrites = saver.putWrites.bind(saver);
          let crashed = false;
          const crashError = Error("Injected checkpoint loss: " + cut.kind + ":" + cut.ordinal);
          saver.put = async (...args) => {
            if (crashed) throw crashError;
            return originalPut(...args);
          };
          saver.putWrites = async (cfg, writes, task) => {
            if (crashed) throw crashError;
            const entry = writes.find(([channel]) => channel === cut.kind)?.[1] as
              { receiptRef?: string; rejectedReceiptRef?: string; status?: string } | undefined;
            const ref = entry?.receiptRef ?? entry?.rejectedReceiptRef;
            if (cfg.configurable?.checkpoint_ns?.includes("assignment-") &&
                ref?.split(":")[1] === String(cut.ordinal)) {
              crashed = true;
              abort.abort(crashError);
              throw crashError;
            }
            return originalWrites(cfg, writes, task);
          };
          await assert.rejects(withJobModelRuntime(runtime, () => graph.invoke(
            sessionId ? null : input, { ...config, signal: abort.signal, durability: "sync" })));
          assert.ok(crashed, "Fault must reach the requested SQLite child boundary: " + cut.kind);
          assert.equal(observed.length, cut.calls, "No next substantive Pi turn before its checkpoint");
          assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), f.initial);
          const state = JSON.parse(readFileSync(join(f.job.stateDir, "foundation.json"), "utf8"));
          if (sessionId) assert.equal(state.piSessionId, sessionId);
          sessionId = state.piSessionId;
          const dir = join(f.job.stateDir, "foundation-invocations", sessionId!);
          assert.ok(existsSync(join(dir, cut.ordinal + ".settled.json")));
          if (cut.kind === "correction")
            assert.ok(existsSync(join(dir, (cut.ordinal + 1) + ".grant.json")));
          assert.ok(!existsSync(join(dir, (cut.ordinal + 1) + ".started.json")));
          // New saver and graph, same persisted Generation thread. Neither
          // model admission nor an in-memory adapter result can survive here.
          saver.db.close();
          saver = SqliteSaver.fromConnString(checkpointFile);
          graph = makeGraph();
        }
      }
      if (crashRounds && scenario !== "crash-rounds") {
        const receiptFile = join(f.job.stateDir, "foundation.json");
        const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
        const grantFile = join(f.job.stateDir, "foundation-invocations", receipt.piSessionId, "1.grant.json");
        if (scenario === "crash-grant-tamper") {
          const grant = JSON.parse(readFileSync(grantFile, "utf8"));
          writeFileSync(grantFile, JSON.stringify({ ...grant, defects: [] }));
        } else if (scenario === "crash-assignment-tamper") {
          writeFileSync(receiptFile, JSON.stringify({ ...receipt, assignmentKey: "f".repeat(64) }));
        } else await setJobControl(f.job, "cancelled");
        const stopped = await withJobModelRuntime(runtime, () => graph.invoke(null, config));
        assert.equal(stopped.status, scenario === "crash-cancel" ? "cancelled" : "blocked",
          JSON.stringify({ reason: stopped.reason, recovery: stopped.recoveryLifecycle }));
        if (scenario !== "crash-cancel")
          assert.ok(stopped.recoveryLifecycle.inspectionFences.length ||
            stopped.recoveryLifecycle.decision?.action === "integrity-fence", JSON.stringify(stopped.recoveryLifecycle));
        assert.equal(observed.length, 7, "No further Pi call on an invalid admission or cancellation");
        assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), f.initial);
        assert.equal(stopped.completedStages.length, 0);
        return;
      }
      // Simulate loss of a persisted child task output after an external effect
      // settled. This aborts the parent as well, then reopens the same database.
      const crashReviewCheckpoint = async (which: "negative" | "writer" | "review" | "native-rejected" | "native-settled",
        initial: typeof input | null, calls: number) => {
        const abort = new AbortController();
        const put = saver.put.bind(saver);
        const putWrites = saver.putWrites.bind(saver);
        let crashed = false;
        const failure = Error("R14B injected SQLite loss at " + which);
        saver.put = async (...args) => {
          if (crashed) throw failure;
          return put(...args);
        };
        saver.putWrites = async (cfg, writes, task) => {
          if (crashed) throw failure;
          const submission = writes.find(([channel]) => channel === "submission")?.[1] as
            { status?: string } | undefined;
          const outcome = writes.find(([channel]) => channel === "outcome")?.[1] as
            { status?: string; dispositionRef?: string } | undefined;
          if (cfg.configurable?.checkpoint_ns?.includes("assignment-") &&
              (which === "negative" ? outcome?.status === "unresolved" && outcome.dispositionRef === "review-checkpoints" :
                which === "writer" ? submission?.status === "repair-round" :
                which === "native-rejected" ? submission?.status === "repair-native-rejected" :
                which === "native-settled" ? submission?.status === "repair-native-round" : outcome?.status === "verified")) {
            crashed = true;
            abort.abort(failure);
            throw failure;
          }
          return putWrites(cfg, writes, task);
        };
        await assert.rejects(withJobModelRuntime(runtime, () => graph.invoke(initial,
          { ...config, signal: abort.signal, durability: "sync" })).then(result => {
            assert.fail("Expected SQLite crash at " + which + ": " + JSON.stringify({
              status: result.status, reason: result.reason, recovery: result.recoveryLifecycle, calls: observed.length,
            }));
          }), error => { if (!crashed) throw error; return true; });
        assert.ok(crashed, "Expected actual child SQLite checkpoint loss: " + which);
        assert.equal(observed.length, calls);
        assert.ok(!existsSync(join(f.job.stateDir, ".story-job")), "Writer lease must not survive settled child effect");
        saver.db.close();
        saver = SqliteSaver.fromConnString(checkpointFile);
        graph = makeGraph();
      };
      if (reviewCrash) {
        await crashReviewCheckpoint("negative", input, 13);
        const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
        assert.equal((await inspectRecoveryCheckpoints(f.job)).find(p => p.commitSha === head)?.semanticReview, "failed");
        assert.equal(git(f.job.worktreeRoot, "rev-list", "--count", f.initial + "..HEAD"), "1");
      }
      let first = await withJobModelRuntime(runtime, () =>
        graph.invoke(crashRounds || reviewCrash ? null : input, { ...config, interruptAfter: ["specialist_dispatch"] }));
      if (realReview) {
        const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
        assert.equal(first.result?.headSha, head,
          "A negative child Review must retain the settled original writer receipt for the assessor");
        assert.equal(first.recoveryLifecycle.phase, "assessing", JSON.stringify(first.recoveryLifecycle));
        const original = first.recoveryLifecycle.active!;
        assert.equal(original.origin.operation, "independent-review");
        assert.equal(original.origin.sourceHeadSha, head);
        assert.equal((await inspectRecoveryCheckpoints(f.job))
          .find(point => point.commitSha === head)?.semanticReview, "failed");
        const selected = await withJobModelRuntime(runtime, () => graph.invoke(null, {
          ...config, interruptAfter: ["assess_recovery"],
        }));
        assert.equal(selected.recoveryLifecycle.active?.id, original.id);
        assert.equal(selected.recoveryLifecycle.decision?.action, "known-correction",
          JSON.stringify(selected.recoveryLifecycle));
        assert.equal(observed.length, 13, "Selection cannot start a new Pi writer");
        if (scenario === "review-session-unavailable" || scenario === "review-reviewer-unavailable") {
          const receipt = JSON.parse(readFileSync(join(f.job.stateDir, "foundation.json"), "utf8"));
          const point = (await inspectRecoveryCheckpoints(f.job)).find(p => p.commitSha === head)!;
          const { inspectPostcommitReviewCycle } = await import("../src/postcommit-review-cycle.js");
          const cycle = await inspectPostcommitReviewCycle(f.job, head, point.assurance!.assignmentDigest);
          const transcript = scenario === "review-reviewer-unavailable" ? cycle!.reviewer.file : receipt.piSessionFile;
          assert.ok(transcript);
          const { renameSync } = await import("node:fs");
          renameSync(transcript, transcript + ".unavailable");
          try {
            const fenced = await withJobModelRuntime(runtime, () => graph.invoke(null, config));
            assert.equal(fenced.status, "blocked");
            assert.ok(fenced.recoveryLifecycle.inspectionFences.length || fenced.recoveryLifecycle.decision?.action === "integrity-fence");
            assert.equal(observed.length, 13, "Missing original session cannot authorize a new writer");
          } finally { renameSync(transcript + ".unavailable", transcript); }
        }
        if (scenario === "review-protected") {
          const stopped = await withJobModelRuntime(runtime, () => graph.invoke(null, config));
          assert.equal(stopped.status, "blocked", JSON.stringify(stopped.recoveryLifecycle));
          assert.equal(stopped.recoveryLifecycle.active?.id, original.id);
          assert.ok(stopped.recoveryLifecycle.decision?.action === "pause" &&
            stopped.recoveryLifecycle.decision.reason === "protected-approval" ||
            stopped.recoveryLifecycle.inspectionFences.length ||
            stopped.recoveryLifecycle.decision?.action === "integrity-fence");
          assert.equal(observed.length, 13, "Protected scope cannot authorize another writer");
          assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
          assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
          assert.ok(!existsSync(join(f.job.stateDir, ".story-job")));
        }
        if (scopeRevision) {
          const paused = await withJobModelRuntime(runtime, () => graph.invoke(null, config));
          assert.equal(paused.status, "paused", JSON.stringify(paused.recoveryLifecycle));
          assert.equal(paused.recoveryLifecycle.decision?.action, "pause");
          assert.equal(observed.length, 14);
          const { activeSpecialistChoice, answerSpecialistChoice } = await import("../src/specialist-choice.js");
          const { withStoryJobLock } = await import("../src/job-lock.js");
          const choice = await activeSpecialistChoice(f.job);
          assert.ok(choice);
          const revisedOutcome = "Establish the archive witness as an observer of the thief's use of the stolen key.";
          await withStoryJobLock(f.job, "test-author-revision", () =>
            answerSpecialistChoice(f.job, choice.id, choice.proposalSha256,
              { kind: "option", optionId: "revise", note: revisedOutcome }, "user:r03"));
          const repaired = await withJobModelRuntime(runtime, () => graph.invoke(input, {
            ...config, interruptAfter: ["independent_assignment_review"],
          }));
          assert.equal(repaired.recoveryLifecycle.phase, "idle",
            JSON.stringify({ reason: repaired.reason, lifecycle: repaired.recoveryLifecycle, calls: observed.length }));
          assert.equal(repaired.recoveryLifecycle.discharged.at(-1)?.case.id, original.id);
          assert.equal(observed.length, 18);
          const points = await inspectRecoveryCheckpoints(f.job);
          const old = points.find(p => p.commitSha === head)!;
          const successor = points.find(p => p.commitSha === repaired.result?.headSha)!;
          const { inspectPostcommitReviewCycle } = await import("../src/postcommit-review-cycle.js");
          const oldCycle = await inspectPostcommitReviewCycle(f.job, head, old.assurance!.assignmentDigest);
          const newCycle = await inspectPostcommitReviewCycle(f.job, head, successor.assurance!.assignmentDigest);
          assert.ok(oldCycle && newCycle && newCycle.predecessor);
          assert.equal(newCycle.predecessor.cycleId, oldCycle.id);
          assert.equal(newCycle.predecessor.failedCommitSha, head);
          assert.notEqual(newCycle.reviewer.id, oldCycle.reviewer.id);
          assert.equal(old.semanticReview, "failed");
          assert.equal(successor.semanticReview, "passed");
          assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, config.configurable.thread_id),
            repaired.recoveryLifecycle);
        }
        if (stalled || dispute) {
          const yielded = await withJobModelRuntime(runtime, () => graph.invoke(null, {
            ...config, interruptAfter: ["independent_assignment_review"],
          }));
          assert.equal(yielded.recoveryLifecycle.phase, "correcting", JSON.stringify(yielded.recoveryLifecycle));
          assert.equal(yielded.recoveryLifecycle.assessorPending, true);
          assert.equal(yielded.recoveryLifecycle.active?.id, original.id);
          const beforeDiagnostic = dispute ? 14 : 19;
          assert.equal(observed.length, beforeDiagnostic, "Child cannot dispatch a nonlocal Review strategy");
          const selection = await withJobModelRuntime(runtime, () => graph.invoke(null, {
            ...config, interruptAfter: ["assess_recovery"],
          }));
          assert.equal(selection.recoveryLifecycle.decision?.action, "known-correction");
          assert.equal(selection.recoveryLifecycle.decision?.action === "known-correction" &&
            selection.recoveryLifecycle.decision.reviewAssessment?.kind, dispute ? "dispute" : "diagnostic");
          assert.equal(selection.recoveryLifecycle.assessorPending, true);
          assert.equal(observed.length, beforeDiagnostic, "Assessment admission must precede the external call");
          assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, config.configurable.thread_id),
            selection.recoveryLifecycle, "Selected reassessment reauthenticates after restart");
          const settled = await withJobModelRuntime(runtime, () => graph.invoke(null, {
            ...config, interruptAfter: ["assess_recovery"],
          }));
          assert.equal(observed.length, beforeDiagnostic + 2);
          assert.ok(observed.slice(-2).every(o => !o.tools.includes("write") && !o.tools.includes("edit")));
          assert.equal(settled.recoveryLifecycle.active?.id, original.id);
          assert.deepEqual(settled.recoveryLifecycle.inspectionFences, []);
          if (scenario === "review-stalled-continue") {
            assert.equal(settled.recoveryLifecycle.decision?.action, "known-correction");
            const repaired = await withJobModelRuntime(runtime, () => graph.invoke(null, {
              ...config, interruptAfter: ["independent_assignment_review"],
            }));
            assert.equal(repaired.recoveryLifecycle.phase, "idle", JSON.stringify(repaired.recoveryLifecycle));
            assert.equal(repaired.recoveryLifecycle.discharged.at(-1)?.case.id, original.id);
            assert.equal(observed.length, 24);
            assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, config.configurable.thread_id),
              repaired.recoveryLifecycle);
          } else {
            assert.equal(settled.status, "blocked", JSON.stringify(settled));
            assert.equal(settled.recoveryLifecycle.decision?.action, "exhausted");
            assert.equal(settled.recoveryLifecycle.decision?.action === "exhausted" &&
              settled.recoveryLifecycle.decision.reason, "nonconverging");
            assert.equal(settled.recoveryLifecycle.discharged.length, 0);
            assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, config.configurable.thread_id),
              settled.recoveryLifecycle);
            const resumed = await withJobModelRuntime(runtime, () => graph.invoke(input, config));
            assert.deepEqual(resumed.recoveryLifecycle, settled.recoveryLifecycle);
            assert.equal(observed.length, beforeDiagnostic + 2, "A settled read-only assessment must not replay");
            assert.equal((await inspectRecoveryCheckpoints(f.job)).find(p => p.commitSha === head)?.semanticReview, "failed");
          }
        }
        if (scenario === "review-native-diagnosis") {
          const yielded = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...config, interruptAfter: ["independent_assignment_review"] }));
          assert.equal(yielded.recoveryLifecycle.assessorPending, true);
          const pending = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...config, interruptAfter: ["assess_recovery"] }));
          assert.equal(pending.recoveryLifecycle.decision?.action, "diagnostic");
          const diagnosed = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...config, interruptAfter: ["assess_recovery"] }));
          assert.equal(diagnosed.recoveryLifecycle.decision?.action, "known-correction");
          assert.ok(diagnosed.recoveryLifecycle.decision?.nativeDiagnostic, JSON.stringify(diagnosed.recoveryLifecycle));
          assert.equal(diagnosed.recoveryLifecycle.active?.id, original.id);
          saver.db.close(); saver = SqliteSaver.fromConnString(checkpointFile); graph = makeGraph();
          const repaired = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...config, interruptAfter: ["verify_committed_work"] }));
          assert.equal(repaired.recoveryLifecycle.discharged.at(-1)?.case.id, original.id, JSON.stringify({reason: repaired.reason, lifecycle: repaired.recoveryLifecycle, calls: observed.length}));
          assert.equal(observed.length, 21);
          assert.equal((await inspectPiPolicy(f.job)).budget.modelCalls, observed.length);
          const points = await inspectRecoveryCheckpoints(f.job);
          assert.equal(points.find(p => p.commitSha === head)?.semanticReview, "failed");
          assert.equal(points.find(p => p.commitSha === git(f.job.worktreeRoot, "rev-parse", "HEAD"))?.semanticReview, "passed");
          assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, config.configurable.thread_id), repaired.recoveryLifecycle);
          const scheduled = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...config, interruptAfter: ["author_update_intake"] }));
          assert.ok(scheduled.completedStages.some(item => item.stage === "foundation"));
          assert.equal(observed.length, 21);
          return;
        }
        if (scenario === "review-native-protocol" || scenario === "review-native-stall") {
          const stopped = await withJobModelRuntime(runtime, () => graph.invoke(null, config));
          assert.equal(stopped.status, "blocked");
          assert.equal(stopped.recoveryLifecycle.active?.id, original.id);
          assert.deepEqual(stopped.recoveryLifecycle.inspectionFences, [], JSON.stringify(stopped.recoveryLifecycle));
          assert.equal(stopped.recoveryLifecycle.decision?.action,
            scenario === "review-native-protocol" ? "exhausted" : "diagnostic-stop", JSON.stringify(stopped.recoveryLifecycle));
          assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
          assert.equal(observed.length, 18);
          assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, config.configurable.thread_id), stopped.recoveryLifecycle);
          const resumed = await withJobModelRuntime(runtime, () => graph.invoke(input, config));
          assert.deepEqual(resumed.recoveryLifecycle, stopped.recoveryLifecycle);
          assert.equal(observed.length, 18);
          return;
        }
        if (scenario === "review-native-protected") {
          const stopped = await withJobModelRuntime(runtime, () => graph.invoke(null, config));
          assert.equal(stopped.status, "blocked");
          assert.equal(stopped.recoveryLifecycle.active?.id, original.id);
          assert.equal(observed.length, 15);
          assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
          assert.match(stopped.reason ?? "", /protected|integrity|evidence/i);
          return;
        }
        if (scenario === "review-converges" || reviewCrash) {
          if (reviewCrash) {
            if (nativeRepair) {
              await crashReviewCheckpoint("native-rejected", null, 15);
              assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
              await crashReviewCheckpoint("native-settled", null, 17);
              assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
            } else await crashReviewCheckpoint("writer", null, 15);
            const successor = git(f.job.worktreeRoot, "rev-parse", "HEAD");
            if (!nativeRepair) {
              assert.equal(git(f.job.worktreeRoot, "rev-list", "--count", head + "..HEAD"), "1");
              assert.equal((await inspectRecoveryCheckpoints(f.job)).find(p => p.commitSha === successor)?.semanticReview, "required-pending");
            }
            await crashReviewCheckpoint("review", null, nativeRepair ? 18 : 16);
            const reviewedHead = git(f.job.worktreeRoot, "rev-parse", "HEAD");
            if (!nativeRepair) assert.equal(reviewedHead, successor);
            assert.equal((await inspectRecoveryCheckpoints(f.job)).find(p => p.commitSha === reviewedHead)?.semanticReview, "passed");
            if (scenario === "review-native-steer") {
              const { sendAuthorUpdate } = await import("../src/author-updates.js");
              const queued = await sendAuthorUpdate(f.job, { id: "r14-author-steer", kind: "change",
                payload: { text: "Change the witness's protected motivation before continuing.",
                  affectedIds: ["creative-direction.foundation"] } });
              assert.equal(queued.phase, "queued");
            }
          }
          const repaired = await withJobModelRuntime(runtime, () => graph.invoke(null, {
            ...config, interruptAfter: ["independent_assignment_review"],
          }));
          assert.equal(repaired.recoveryLifecycle.phase, "idle",
            JSON.stringify({ reason: repaired.reason, status: repaired.status,
              lifecycle: repaired.recoveryLifecycle, calls: observed.slice(13).map(o => ({ tools: o.tools, last: JSON.stringify(o.messages.at(-1)).slice(0, 1400) })) }, null, 2));
          const finalHead = git(f.job.worktreeRoot, "rev-parse", "HEAD");
          assert.equal(repaired.recoveryLifecycle.discharged.at(-1)?.case.id, original.id);
          assert.equal(repaired.result?.headSha, finalHead);
          assert.equal(git(f.job.worktreeRoot, "rev-list", "--count", head + "..HEAD"), reviewCrash ? "1" : "3");
          assert.equal(observed.length, nativeRepair ? 18 : reviewCrash ? 16 : 22);
          const cycle = await (await import("../src/postcommit-review-cycle.js"))
            .inspectPostcommitReviewCycle(f.job, head, (await inspectRecoveryCheckpoints(f.job))
              .find(p => p.commitSha === head)!.assurance!.assignmentDigest);
          assert.equal(cycle?.rounds.length, reviewCrash ? 2 : 4);
          // The actual shared child must checkpoint one admission and one
          // committed submission per repair; native/Git and Review receipts
          // remain the independent authorities for every reference.
          const repairAdmissions = new Set<string>(), repairSubmissions = new Set<string>();
          const originalReceipt = JSON.parse(readFileSync(join(f.job.stateDir, "foundation.json"), "utf8"));
          for await (const tuple of saver.list({ configurable: { thread_id: config.configurable.thread_id } })) {
            const ns = tuple.config.configurable?.checkpoint_ns ?? "";
            if (!ns.includes("assignment-") || !ns.includes("-correction")) continue;
            const { identity, correction, submission } = tuple.checkpoint.channel_values as {
              identity?: import("../src/generation-assignment-lifecycle.js").AssignmentIdentity;
              correction?: { correctionRef: string; rejectedReceiptRef: string };
              submission?: { status: string; receiptRef: string; headSha: string };
            };
            if (identity) {
              const { logicalAssignmentKey } = await import("../src/generation-assignment-lifecycle.js");
              assert.equal(logicalAssignmentKey(identity), originalReceipt.assignmentKey);
              assert.equal(identity.turnDigest, pinnedDigest);
            }
            if (correction?.correctionRef.match(/^[a-f0-9]{40}:[a-f0-9]{64}$/))
              repairAdmissions.add(correction.correctionRef);
            if (submission?.status === "repair-round") {
              const [, source, successor] = submission.receiptRef.split(":");
              const receipt = JSON.parse(readFileSync(join(f.job.stateDir, "review-repairs", source + ".json"), "utf8"));
              assert.equal(receipt.rootFailureSha, head);
              assert.equal(receipt.repairedCommitSha, successor);
              assert.equal(receipt.origin.sessionId, originalReceipt.piSessionId);
              assert.deepEqual(receipt.allowedPaths, ["creative-direction/foundation.md"]);
              assert.equal(receipt.reviewer.sessionFiles[0], cycle!.reviewer.file);
              assert.ok(receipt.findings.length);
              assert.equal(submission.headSha, successor);
              repairSubmissions.add(submission.receiptRef);
            }
          }
          assert.equal(repairAdmissions.size, reviewCrash ? 1 : 3);
          assert.equal(repairSubmissions.size, reviewCrash ? 1 : 3);
          const policy = await inspectPiPolicy(f.job);
          assert.equal(policy.budget.modelCalls, observed.length, "Restart cannot double charge an original session");
          if (nativeRepair) {
            const receipt = JSON.parse(readFileSync(join(f.job.stateDir, "review-repairs", head + ".json"), "utf8"));
            assert.ok(receipt.nativeCorrection?.accepted?.proof);
            assert.equal(receipt.nativeCorrection.defects[0].kind, "metadata");
            assert.equal(receipt.nativeCorrection.defects[0].path, "creative-direction/foundation.md");
            assert.equal(observed[17]!.tools.includes("write"), false);
            assert.ok(observed[15]!.tools.includes("write"));
          } else assert.ok(observed.slice(13).filter((_, i) => i % 3 === 2)
            .every(call => !call.tools.includes("write") && !call.tools.includes("edit")));

          assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, config.configurable.thread_id), repaired.recoveryLifecycle);
          const completed = await withJobModelRuntime(runtime, () => graph.invoke(null, {
            ...config, interruptAfter: ["verify_committed_work"],
          }));
          assert.ok(completed.completedStages.some(item => item.stage === "foundation"));
          assert.equal(observed.length, nativeRepair ? 18 : reviewCrash ? 16 : 22);
          // Resume through the parent's author/plan boundary, not the child's
          // scheduler. The next owner may be admitted, but not invoked here.
          const scheduled = await withJobModelRuntime(runtime, () => graph.invoke(null, {
            ...config, interruptAfter: ["author_update_intake"],
          }));
          if (scenario === "review-native-steer") {
            const { inspectAuthorUpdates } = await import("../src/author-updates.js");
            const receipt = (await inspectAuthorUpdates(f.job)).records.find(r => r.message.id === "r14-author-steer")?.acknowledgement;
            assert.equal(receipt?.phase, "review-required");
            assert.equal(receipt?.pinned?.headSha, finalHead);
            assert.equal(scheduled.status, "blocked", scheduled.reason ?? undefined);
            assert.equal(observed.length, 18);
            assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), finalHead);
            return;
          }
          assert.equal(scheduled.status, "running", scheduled.reason ?? undefined);
          assert.equal(scheduled.active?.stage, "architecture");
          assert.equal(scheduled.request.turnPlanDigest, pinnedDigest);
          assert.equal(scheduled.inventory?.headSha, finalHead);
          assert.ok((await graph.getState(config)).next.includes("specialist_dispatch"));
          assert.equal(observed.length, nativeRepair ? 18 : reviewCrash ? 16 : 22);
        }
        return;
      }
      if (terminal) {
        assert.equal(first.recoveryLifecycle.phase, "assessing", JSON.stringify({
          status: first.status, reason: first.reason, lifecycle: first.recoveryLifecycle,
          calls: observed.length, recoverySources: first.recoverySources }, null, 2));
        assert.equal(first.recoveryLifecycle.active?.kind, scenario === "protocol-exhausted" ? "protocol" : "semantic");
        const caseId = first.recoveryLifecycle.active!.id;
        if (diagnosticContinue) {
          const before = JSON.parse(readFileSync(join(f.job.stateDir, "foundation.json"), "utf8"));
          const terminalFile = join(f.job.stateDir, "foundation-invocations", before.piSessionId, "terminal.json");
          const terminalBytes = readFileSync(terminalFile, "utf8");
          const chosen = await withJobModelRuntime(runtime, () => graph.invoke(null, {
            ...config, interruptAfter: ["assess_recovery"] }));
          assert.equal(chosen.recoveryLifecycle.decision?.action, "diagnostic", JSON.stringify(chosen.recoveryLifecycle));
          const crashAt = async (match: (namespace: string, writes: Array<[string, unknown]>) => boolean,
            calls: number) => {
            const abort = new AbortController();
            const put = saver.put.bind(saver);
            const writes = saver.putWrites.bind(saver);
            const failure = Error("R14H injected SQLite checkpoint loss");
            let crashed = false;
            saver.put = async (...args) => {
              if (crashed) throw failure;
              return put(...args);
            };
            saver.putWrites = async (cfg, entries, task) => {
              if (crashed) throw failure;
              if (match(String(cfg.configurable?.checkpoint_ns ?? ""), entries)) {
                crashed = true; abort.abort(failure); throw failure;
              }
              return writes(cfg, entries, task);
            };
            await assert.rejects(withJobModelRuntime(runtime, () => graph.invoke(null, {
              ...config, interruptAfter: ["assess_recovery"], signal: abort.signal, durability: "sync",
            })));
            assert.ok(crashed, "The actual durable graph boundary must be lost");
            assert.equal(observed.length, calls);
            assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), f.initial);
            saver.db.close();
            saver = SqliteSaver.fromConnString(checkpointFile);
            graph = makeGraph();
          };
          if (scenario === "nonconverging-continue-crash")
            await crashAt((ns, writes) => !ns && writes.some(([channel, value]) =>
              channel === "recoveryLifecycle" &&
              (value as {decision?: {adapter?: string}})?.decision?.adapter === "assignment-diagnostic"), 11);
          const admitted = await withJobModelRuntime(runtime, () => graph.invoke(null, {
            ...config, interruptAfter: ["assess_recovery"] }));
          assert.equal(admitted.recoveryLifecycle.decision?.action, "known-correction", JSON.stringify(admitted));
          assert.equal(admitted.recoveryLifecycle.decision?.adapter, "assignment-diagnostic");
          assert.equal(admitted.recoveryLifecycle.active?.id, caseId);
          assert.equal(admitted.recoveryLifecycle.attempt?.phase, "settled");
          assert.equal(observed.length, 11);
          assert.deepEqual(observed.at(-1)!.tools, []);
          assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, config.configurable.thread_id),
            admitted.recoveryLifecycle);
          const ordinal = JSON.parse(terminalBytes).ordinal + 1;
          const dir = dirname(terminalFile);
          const grantFile = join(dir, ordinal + ".grant.json");
          const startedFile = join(dir, ordinal + ".started.json");
          const settledFile = join(dir, ordinal + ".settled.json");
          if (scenario === "nonconverging-continue-crash" || scenario === "nonconverging-continue-tamper" ||
              scenario === "nonconverging-continue-transcript") {
            await crashAt((ns, writes) => ns.includes("assignment-") &&
              writes.some(([channel, value]) => channel === "correction" &&
                (value as {rejectedReceiptRef?: string})?.rejectedReceiptRef?.split(":")[1] === String(ordinal - 1)), 11);
            assert.ok(existsSync(grantFile));
            assert.ok(!existsSync(startedFile));
            if (scenario !== "nonconverging-continue-crash") {
              if (scenario === "nonconverging-continue-tamper")
                writeFileSync(grantFile, JSON.stringify({ ...JSON.parse(readFileSync(grantFile, "utf8")),
                  diagnostic: "0".repeat(64) }));
              else writeFileSync(before.piSessionFile, readFileSync(before.piSessionFile, "utf8").replace("unsupported_field", "substituted_field"));
              const fenced = await withJobModelRuntime(runtime, () => graph.invoke(null, config));
              assert.equal(fenced.status, "blocked");
              assert.ok(fenced.recoveryLifecycle.inspectionFences.length);
              assert.equal(fenced.recoveryLifecycle.active?.id, caseId);
              assert.equal(observed.length, 11);
              assert.ok(!existsSync(startedFile));
              return;
            }
            await crashAt((ns, writes) => ns.includes("assignment-") &&
              writes.some(([channel, value]) => channel === "submission" &&
                (value as {receiptRef?: string})?.receiptRef?.split(":")[1] === String(ordinal)), 13);
            assert.ok(existsSync(settledFile));
            assert.equal(readFileSync(terminalFile, "utf8"), terminalBytes);
          }
          if (scenario === "nonconverging-continue-budget") {
            await configurePiPolicy(f.job, { version: 1,
              profile: { provider: scriptedModel.provider, model: scriptedModel.id }, limits: { modelCalls: 11 } });
            const paused = await withJobModelRuntime(runtime, () => graph.invoke(null, config));
            assert.equal(paused.status, "paused", JSON.stringify(paused));
            assert.equal(paused.recoveryLifecycle.decision?.action, "pause");
            assert.equal(paused.recoveryLifecycle.decision?.reason, "budget");
            assert.equal(observed.length, 11);
            assert.ok(existsSync(grantFile));
            assert.ok(!existsSync(startedFile));
            assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, config.configurable.thread_id),
              paused.recoveryLifecycle);
            await configurePiPolicy(f.job, { version: 1,
              profile: { provider: scriptedModel.provider, model: scriptedModel.id }, limits: { modelCalls: 50 } });
            const resumed = await withJobModelRuntime(runtime, () => graph.invoke(input, {
              ...config, interruptAfter: ["assess_recovery"] }));
            assert.equal(resumed.recoveryLifecycle.active, null, JSON.stringify(resumed));
            assert.equal(observed.length, 15);
            assert.equal(resumed.recoveryLifecycle.discharged.at(-1)?.case.id, caseId);
            return;
          }
          if (scenario === "nonconverging-continue-foreign-file" || scenario === "nonconverging-continue-cancel") {
            if (scenario === "nonconverging-continue-foreign-file")
              writeFileSync(join(f.job.worktreeStoryRoot, "unrelated.md"), "Unrelated draft");
            else await setJobControl(f.job, "cancelled");
            const stopped = await withJobModelRuntime(runtime, () => graph.invoke(null, config));
            assert.equal(stopped.status, scenario === "nonconverging-continue-cancel" ? "cancelled" : "blocked");
            assert.equal(stopped.recoveryLifecycle.active?.id, caseId);
            assert.equal(observed.length, 11);
            assert.ok(!existsSync(startedFile));
            assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), f.initial);
            return;
          }
          if (scenario === "nonconverging-continue-uncertain") {
            const stopped = await withJobModelRuntime(runtime, () => graph.invoke(null, config));
            assert.equal(stopped.status, "blocked");
            assert.ok(stopped.recoveryLifecycle.inspectionFences.length);
            assert.equal(stopped.recoveryLifecycle.active?.id, caseId);
            assert.ok(existsSync(startedFile));
            assert.ok(!existsSync(settledFile));
            const calls = observed.length;
            assert.equal(calls, 12);
            saver.db.close();
            saver = SqliteSaver.fromConnString(checkpointFile);
            graph = makeGraph();
            const resumed = await withJobModelRuntime(runtime, () => graph.invoke(input, config));
            assert.equal(resumed.status, "blocked");
            assert.equal(resumed.recoveryLifecycle.active?.id, caseId);
            assert.equal(observed.length, calls);
            assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), f.initial);
            return;
          }
          const completed = await withJobModelRuntime(runtime, () => graph.invoke(null, {
            ...config, interruptAfter: ["assess_recovery"] }));
          assert.equal(completed.status, "running", JSON.stringify(completed));
          assert.equal(completed.recoveryLifecycle.active, null, JSON.stringify(completed.recoveryLifecycle));
          assert.equal(completed.recoveryLifecycle.discharged.at(-1)?.case.id, caseId);
          assert.equal(observed.length, 15);
          assert.equal((await inspectPiPolicy(f.job)).budget.modelCalls, 15);
          const after = JSON.parse(readFileSync(join(f.job.stateDir, "foundation.json"), "utf8"));
          assert.equal(after.piSessionId, before.piSessionId);
          assert.equal(after.assignmentKey, before.assignmentKey);
          assert.equal(after.invocationProof.ordinal, JSON.parse(terminalBytes).ordinal + 1);
          assert.equal(readFileSync(terminalFile, "utf8"), terminalBytes);
          const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
          assert.equal(git(f.job.worktreeRoot, "rev-list", "--count", f.initial + "..HEAD"), "1");
          assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
          assert.equal((await inspectRecoveryCheckpoints(f.job)).find(p => p.commitSha === head)?.semanticReview, "passed");
          assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, config.configurable.thread_id),
            completed.recoveryLifecycle);
          const next = await withJobModelRuntime(runtime, () => graph.invoke(null, {
            ...config, interruptAfter: ["verify_committed_work"] }));
          assert.ok(next.completedStages.some(item => item.stage === "foundation"));
          assert.equal(observed.length, 15);
          assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
          return;
        }
        const stopped = await withJobModelRuntime(runtime, () => graph.invoke(null, config));
        assert.equal(stopped.status, "blocked");
        assert.equal(stopped.recoveryLifecycle.active?.id, caseId);
        assert.deepEqual(stopped.recoveryLifecycle.inspectionFences, [], JSON.stringify(stopped.recoveryLifecycle));
        assert.equal(stopped.recoveryLifecycle.decision?.action,
          scenario === "protocol-exhausted" ? "exhausted" : "diagnostic-stop");
        const calls = scenario === "protocol-exhausted" ? 8 : 11;
        assert.equal(observed.length, calls);
        if (scenario === "protocol-exhausted") {
          assert.deepEqual(observed.slice(-2).map(r => r.tools), [[], []]);
          assert.equal(stopped.recoveryLifecycle.attempt, null);
        } else {
          assert.deepEqual(observed.at(-1)!.tools, []);
          assert.equal(stopped.recoveryLifecycle.attempt?.phase, "settled");
        }
        assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), f.initial);
        assert.equal(stopped.completedStages.length, 0);
        assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, config.configurable.thread_id),
          stopped.recoveryLifecycle, "Read-only inspection must reauthenticate the typed stop");
        const resumed = await withJobModelRuntime(runtime, () => graph.invoke(input, config));
        assert.deepEqual(resumed.recoveryLifecycle, stopped.recoveryLifecycle);
        assert.equal(observed.length, calls, "Restart cannot grant another writer or diagnostic");
        const state = JSON.parse(readFileSync(join(f.job.stateDir, "foundation.json"), "utf8"));
        const terminalFile = join(f.job.stateDir, "foundation-invocations", state.piSessionId, "terminal.json");
        const original = readFileSync(terminalFile, "utf8");
        writeFileSync(terminalFile, JSON.stringify({ ...JSON.parse(original), effect: "0".repeat(64) }));
        assert.ok((await inspectModernGenerationRecovery(f.job, saver, config.configurable.thread_id))?.inspectionFences.length,
          "Tampered terminal effect must not retain authenticated exhaustion or diagnosis");
        const fenced = await withJobModelRuntime(runtime, () => graph.invoke(input, config));
        assert.ok(fenced.recoveryLifecycle.inspectionFences.length);
        assert.equal(observed.length, calls);
        return;
      }
      if (scenario === "server" || scenario === "author-pause") {
        assert.equal(first.status, "paused", JSON.stringify({ reason: first.reason, calls: observed.length }));
        assert.equal(observed.length, scenario === "server" ? 7 : 6,
          "Control pauses at the exact submitted response/corrective boundary");
        const receipt = JSON.parse(readFileSync(join(f.job.stateDir, "foundation.json"), "utf8"));
        const sessionId = receipt.piSessionId;
        if (scenario === "server") await configurePiPolicy(f.job, {
          version: 1, profile: { provider: scriptedModel.provider, model: scriptedModel.id },
          limits: { modelCalls: 50 },
        });
        else await setJobControl(f.job, "running");
        first = await withJobModelRuntime(runtime, () =>
          graph.invoke({ ...first, status: "running" }, { ...config, interruptAfter: ["specialist_dispatch"] }));
        assert.equal(JSON.parse(readFileSync(join(f.job.stateDir, "foundation.json"), "utf8")).piSessionId, sessionId,
          "Resume must reopen the original writer session");
      }
      assert.equal(first.active?.stage, "foundation", JSON.stringify({
        status: first.status, reason: first.reason, operationRecovery: first.operationRecovery,
        active: first.active, result: first.result }));
      assert.equal(first.result?.status, "committed", JSON.stringify({ reason: first.reason,
        recovery: currentOperationRecovery(first), active: first.active, status: first.status,
        result: first.result, calls: observed.length,
        points: (await inspectRecoveryCheckpoints(f.job)).map(p => ({
          workItem: p.workItem, eligible: p.eligible, reason: p.reason,
          semanticReview: p.semanticReview, planVersion: p.planVersion,
        })),
        recoveryLifecycle: first.recoveryLifecycle,
        recoverySources: first.recoverySources, nativeFoundation: existsSync(join(f.job.stateDir, "foundation.json"))
          ? JSON.parse(readFileSync(join(f.job.stateDir, "foundation.json"), "utf8")) : null }, null, 2));
      const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
      assert.notEqual(head, f.initial, "The child must commit real Story bytes to Git");
      assert.equal(first.result.headSha, head);
      const expectedCalls = 13;
      assert.equal(observed.length, expectedCalls, "One pinned planning session and one original writer session with distinct corrections settled");
      assert.deepEqual(observed[6]!.tools, [], "Format-only correction must not have tools");
      assert.ok(observed[7]!.tools.includes("write"));
      assert.ok(observed[9]!.tools.includes("write"));
      assert.ok(!observed[7]!.tools.includes("bash"), "Corrective writer has no unscoped shell");
      assert.ok(!existsSync(join(f.job.worktreeStoryRoot, "events/foreign.md")), "Foreign-path write is refused before effect");
      assert.ok(observed[0]!.tools.includes("read"));
      assert.ok(!observed[0]!.tools.includes("write"));
      assert.ok(observed[3]!.tools.includes("write"));
      assert.equal(git(f.job.worktreeRoot, "rev-list", "--count", f.initial + "..HEAD"), "1");
      const points = await inspectRecoveryCheckpoints(f.job);
      assert.equal(points.find(p => p.workItem === "foundation")?.semanticReview, "passed");
      const namespaces = new Set<string>();
      const settledRounds = new Set<number>();
      const correctiveGrants = new Set<number>();
      const foundationReceipt = JSON.parse(readFileSync(join(f.job.stateDir, "foundation.json"), "utf8"));
      const invocations = join(f.job.stateDir, "foundation-invocations", foundationReceipt.piSessionId);
      for await (const tuple of saver.list({ configurable: { thread_id: config.configurable.thread_id } })) {
        const ns = tuple.config.configurable?.checkpoint_ns ?? "";
        namespaces.add(ns);
        if (!ns.includes("assignment-")) continue;
        const { submission, correction } = tuple.checkpoint.channel_values as {
          submission?: { status: string; receiptRef: string };
          correction?: { correctionRef: string; rejectedReceiptRef: string };
        };
        if (submission?.status === "writer-round") {
          const [source, ordinal, digest] = submission.receiptRef.split(":");
          const grant = JSON.parse(readFileSync(join(invocations, ordinal + ".grant.json"), "utf8"));
          const settled = JSON.parse(readFileSync(join(invocations, ordinal + ".settled.json"), "utf8"));
          assert.equal(grant.source, source);
          assert.equal(grant.sessionId, foundationReceipt.piSessionId);
          assert.equal(createHash("sha256").update(JSON.stringify(settled)).digest("hex"), digest);
          settledRounds.add(Number(ordinal));
        }
        if (correction) {
          const ordinal = Number(correction.rejectedReceiptRef.split(":")[1]);
          const grant = JSON.parse(readFileSync(join(invocations, (ordinal + 1) + ".grant.json"), "utf8"));
          assert.equal(createHash("sha256").update(JSON.stringify(grant)).digest("hex"), correction.correctionRef);
          correctiveGrants.add(ordinal);
        }
      }
      assert.deepEqual([...settledRounds].sort(), [0, 1, 2]);
      assert.deepEqual([...correctiveGrants].sort(), [0, 1]);
      assert.ok(observed.slice(-2).every(call => !call.tools.includes("write") && !call.tools.includes("edit")));
      const policy = await inspectPiPolicy(f.job);
      assert.equal(policy.budget.modelCalls, expectedCalls);
      assert.ok(namespaces.size >= 2, "Parent and production Foundation child need distinct SQLite namespaces");
      // Reopen the parent checkpoint immediately before child dispatch after
      // the physical child already reached END. The original Pi/Git/Review
      // effects must be reconciled, not repeated in the new physical task.
      let pendingDispatch: Awaited<ReturnType<typeof graph.getState>> | undefined;
      for await (const snapshot of graph.getStateHistory(config)) {
        if (snapshot.next.includes("specialist_dispatch")) { pendingDispatch = snapshot; break; }
      }
      assert.ok(pendingDispatch, "Missing original parent dispatch checkpoint");
      const replay = await withJobModelRuntime(runtime, () => graph.invoke(null, {
        ...pendingDispatch!.config, recursionLimit: 10000, interruptAfter: ["specialist_dispatch"],
      }));
      assert.equal(replay.result?.headSha, head);
      assert.equal(observed.length, expectedCalls, "Child END before parent publication cannot replay Pi");
      assert.equal(git(f.job.worktreeRoot, "rev-list", "--count", f.initial + "..HEAD"), "1");
      // Only the controller's original next edges may accept the child result.
      const next = await withJobModelRuntime(runtime, () =>
        graph.invoke(null, { ...config, interruptAfter: ["verify_committed_work"] }));
      assert.equal(observed.length, expectedCalls, "Parent verification cannot repeat the Foundation writer");
      assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
      assert.ok(next.completedStages.some((item: { stage: string }) => item.stage === "foundation"),
        "Only the production parent's verified-work node advances completedStages");
    } finally { saver.db.close(); }
  } finally {
    restoreSandbox();
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("opt-in real Pi generation semantically chooses and reviews a deferred idea", {
  skip: process.env.NT_LIVE_GENERATION_IDEA !== "1"
    ? "set NT_LIVE_GENERATION_IDEA=1 for paid semantic placement evaluation" : false,
  timeout: 3_600_000,
}, async () => {
  assert.ok(available);
  const f = setup("live-idea-parent");
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope = { ...contract.scope, kind: "full-story", targets: [], branches: [] };
  writeFileSync(f.contract, JSON.stringify(contract));
  f.start[3] = "Create a small archive mystery with character Ada (character.ada), " +
    "arc.truth and one milestone.disclosure; preserve the protect/challenge choice.";
  await saveJobTurnPlan(f.job, planWholeStory(f.start[3]!, contract, f.job.baseSha));
  const file = join(root, "live-idea-parent.json");
  const original = "The missing witness heard the archive bell after midnight.";
  writeFileSync(file, JSON.stringify({
    id: "witness-bell", kind: "event-concept",
    source: { kind: "author-onboarding", reference: "story-seed" }, original,
    requirements: { meaning: [{ text: "The bell changes the timeline", binding: true }],
      wording: [], participants: [{ text: "character.ada", binding: true }] },
    identities: { known: ["character.ada"], unresolved: [] },
    prerequisites: ["milestone.disclosure"],
    placement: { scopeIds: ["arc.truth"], flexible: true, earliest: "event" },
    upstreamConstraints: [],
  }));
  f.cli(["ideas", "capture", "--file", file]);
  const args = f.start.filter(x => x !== "--fixture");
  if (process.env.NT_PROVIDER) args.push("--provider", process.env.NT_PROVIDER);
  if (process.env.NT_MODEL) args.push("--model", process.env.NT_MODEL);
  const result = f.cli(args);
  const inbox = JSON.parse(readFileSync(join(f.job.worktreeRoot,
    ".story-inbox/ideas/witness-bell.yaml"), "utf8"));
  assert.equal(inbox.original, original);
  const integrated = result.ideaHistory.some((entry: any) => entry.id === "witness-bell" &&
    entry.status === "integrated");
  if (integrated) {
    assert.equal(inbox.lifecycle.placements.at(-1).verified, "pi");
    assert.ok(inbox.lifecycle.placements[0].sessionFiles.length >= 3,
      "selection, craft writing and independent review require distinct pinned sessions");
  } else {
    // A semantic rejection is a valid evaluation outcome; it must not be
    // laundered into a verified canonical realization or completed generation.
    assert.notEqual(result.status, "completed");
    assert.ok(result.reason, "a rejected or interrupted Pi placement needs actionable evidence");
    assert.ok(result.ideaHistory.length > 0 ||
      existsSync(join(dirname(f.job.worktreeRoot), "generation-idea-dispatch.json")),
      "the parent must record attempted Pi selection for inspection");
  }
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.initial);
  console.error(JSON.stringify({ status: result.status, reason: result.reason,
    ideas: result.ideaHistory, escalation: result.escalation }));
});

test("opt-in real Pi single-Milestone generation uses pinned skills and reports honest completion", {
  skip: process.env.NT_LIVE_GENERATION !== "1" ? "set NT_LIVE_GENERATION=1 for paid Pi verification" : false,
  timeout: 3_600_000,
}, async () => {
  assert.ok(available);
  const f = setup("live");
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope = { ...contract.scope, kind: "full-story", targets: [], branches: [] };
  writeFileSync(f.contract, JSON.stringify(contract));
  f.start[3] = "Create a complete small archive mystery with exactly one Milestone; " +
    "let the player protect or challenge the missing witness.";
  await saveJobTurnPlan(f.job, planWholeStory(f.start[3]!, contract, f.job.baseSha));
  const args = f.start.filter(x => x !== "--fixture");
  if (process.env.NT_PROVIDER) args.push("--provider", process.env.NT_PROVIDER);
  if (process.env.NT_MODEL) args.push("--model", process.env.NT_MODEL);
  const first = f.cli([...args, "--pause-after", "foundation"]);
  assert.equal(first.status, "paused", JSON.stringify(first));
  const foundation = JSON.parse(readFileSync(join(dirname(f.job.worktreeRoot), "foundation.json"), "utf8"));
  const calls = readFileSync(foundation.piSessionFile, "utf8").trim().split("\n").map(JSON.parse)
    .flatMap((entry: any) => entry.message?.content ?? []).filter((item: any) => item.type === "toolCall");
  assert.ok(calls.some((item: any) => item.name === "read" && item.arguments?.path?.includes("nt-story-discovery/SKILL.md")));
  assert.ok(calls.some((item: any) => ["write", "edit"].includes(item.name)));
  const result = f.cli(["generate", "resume"]);
  assert.ok(["completed", "blocked", "paused"].includes(result.status));
  if (result.status === "completed") assert.equal(result.report.evidence.editorial.verdict, "pass");
  else assert.ok(result.reason, "A blocked live run must explain what needs reconciliation");
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.initial);
  assert.equal(git(f.repo, "status", "--porcelain"), "");
  console.error(JSON.stringify({ status: result.status, reason: result.reason, completedStages: result.completedStages }));
});

test("Studio exposes production scheduling rather than the retired prototype", async () => {
  const config = JSON.parse(readFileSync(resolve("langgraph.json"), "utf8"));
  assert.equal(config.graphs.noveltea, undefined);
  assert.equal(config.graphs.story_generation, "./src/studio.ts:graph");
  const f = setup("studio-input");
  const studioEntry = process.env.NT_GENERATION_TEST_SOURCE_CLI === "1"
    ? ["--import", "tsx", resolve("src/studio-input.ts")] : [resolve("dist/studio-input.js")];
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope = { ...contract.scope, kind: "full-story", targets: [], branches: [] };
  writeFileSync(f.contract, JSON.stringify(contract));
  const args = [...studioEntry, "--story", f.story, "--job", "single",
    "--task", "A scoped mystery", "--contract", f.contract];
  const runInput = () => spawnSync(process.execPath, args,
    { encoding: "utf8", env: f.env, timeout: 30_000 });
  const unplanned = runInput();
  assert.notEqual(unplanned.status, 0);
  assert.match(unplanned.stderr, /authenticated current-format Turn/);
  const turn = planWholeStory("A scoped mystery", contract, f.job.baseSha);
  await saveJobTurnPlan(f.job, turn);
  const retired = spawnSync(process.execPath, [...args, "--fixture"], { encoding: "utf8", env: f.env });
  assert.notEqual(retired.status, 0);
  assert.match(retired.stderr, /retired/);
  const prepared = runInput();
  assert.equal(prepared.status, 0, prepared.stderr);
  const input = JSON.parse(prepared.stdout);
  assert.equal(input.request.story, f.story);
  assert.equal(input.request.fixture, false);
  assert.deepEqual(input.request.contract, contract);
  assert.equal(input.request.turnPlanDigest, turn.digest);
  assert.equal(input.request.orchestrationPolicy, "explicit");
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), f.initial);
  assert.equal(git(f.repo, "status", "--porcelain"), "");
  const topology = await createGenerationGraph().getGraphAsync();
  for (const node of ["schedule", "author_update_intake", "specialist_dispatch", "verify_committed_work", "completion_decision"])
    assert.ok(topology.nodes[node], node);
});

const shard = process.env.NT_GENERATION_TEST_SHARD;
const selected = shard ? new Set(selectGenerationShard(scenarios.map(s => s.name), shard)) : null;
if (selected) console.info("Generation shard " + shard + ": " + selected.size + "/" + scenarios.length +
  " cases; estimated serial seconds " + [...selected].reduce((sum, name) => sum + generationWeight(name), 0));
for (const scenario of scenarios)
  if (!selected || selected.has(scenario.name)) nodeTest(scenario.name, scenario.options, scenario.run);
