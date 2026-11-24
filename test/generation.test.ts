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
import { renderFoundation } from "../src/demo.js";
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
import { createGenerationGraph, dispatchGenerationAssignment } from "../src/generation.js";
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
  if ((process.env.NT_LIVE_GENERATION === "1" ||
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
    const result = spawnSync(process.execPath, [...cliEntry(),
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

test("parent integrates eligible deferred ideas through the dedicated placement workflow and preserves source intent", { skip: !available }, () => {
  const f = setup("ideas-parent");
  const file = join(root, "ideas-parent-idea.json");
  const original = "The archive bell proves someone visited after midnight.";
  writeFileSync(file, JSON.stringify({
    id: "archive-bell", kind: "event-concept",
    source: { kind: "author-onboarding", reference: "opening-notes" },
    original,
    requirements: {
      meaning: [{ text: "The bell establishes the timeline", binding: true }],
      wording: [], participants: [],
    },
    identities: { known: [], unresolved: [] },
    prerequisites: ["milestone.disclosure"],
    placement: { scopeIds: ["arc.truth"], flexible: true, earliest: "event" },
    upstreamConstraints: [],
  }));
  const captured = f.cli(["ideas", "capture", "--file", file]);
  const paused = f.cli([...f.start, "--pause-after", "event"]);
  assert.equal(paused.status, "paused");
  assert.equal(paused.ideaHistory?.length ?? 0, 0, "safe-boundary pause precedes idea scheduling");
  const result = f.cli(["generate", "resume"]);
  assert.equal(result.status, "blocked", JSON.stringify(result));
  assert.ok(result.ideaHistory.some((entry: any) => entry.id === "archive-bell" &&
    entry.status === "integrated-editorial-unverified"));
  const inbox = JSON.parse(readFileSync(join(f.job.worktreeRoot, ".story-inbox/ideas/archive-bell.yaml"), "utf8"));
  assert.equal(inbox.original, original);
  assert.equal(inbox.lifecycle.status, "integrated");
  assert.ok(inbox.lifecycle.placements[0].alternatives.length >= 2);
  assert.equal(inbox.lifecycle.placements[0].verified, "fixture-unverified");
  const target = inbox.lifecycle.placements[0].recordIds[0];
  assert.ok(readFileSync(join(f.job.worktreeStoryRoot, target.replace(".", "s/") + ".md"), "utf8").includes(original));
  assert.deepEqual(result.report.evidence.deferredIdeas.scopedOutstanding, ["archive-bell"]);
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.initial);
  assert.notEqual(captured.commitSha, git(f.job.worktreeRoot, "rev-parse", "HEAD"));
  const history = result.ideaHistory;
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  assert.deepEqual(f.cli(["generate", "resume"]).ideaHistory, history);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
});

test("later canonical development triggers a bounded persisted idea reassessment", { skip: !available }, () => {
  const f = setup("ideas-reassessment");
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope.targets = ["arc.truth", "milestone.disclosure", "milestone.reckoning"];
  writeFileSync(f.contract, JSON.stringify(contract));
  const file = join(root, "ideas-reassessment.json");
  writeFileSync(file, JSON.stringify({
    id: "bell-revisit", kind: "event-concept",
    source: { kind: "author-onboarding", reference: "draft-notes" },
    original: "A bell echoes from the locked archive.",
    requirements: { meaning: [{ text: "A bell explains the chronology", binding: true }],
      wording: [], participants: [] },
    identities: { known: [], unresolved: [] },
    prerequisites: ["milestone.disclosure"],
    placement: { scopeIds: ["arc.truth"], flexible: true, earliest: "event" },
    upstreamConstraints: [],
  }));
  f.cli(["ideas", "capture", "--file", file]);
  f.cli([...f.start, "--pause-after", "event"]);
  const second = f.cli(["generate", "resume", "--pause-after", "event"]);
  assert.equal(second.status, "paused", JSON.stringify(second));
  assert.ok(second.ideaHistory.some((h: any) => h.action === "place"));
  const done = f.cli(["generate", "resume"]);
  assert.equal(done.status, "blocked", JSON.stringify(done));
  const steps = done.ideaHistory.filter((h: any) => h.id === "bell-revisit");
  assert.equal(steps[0].action, "place");
  assert.ok(steps.length >= 2 && steps.length <= 3, "reconsideration is bounded");
  assert.ok(steps.slice(1).every((h: any) => h.action === "reassess" &&
    h.status === "reassessed-editorial-unverified"));
  const inbox = JSON.parse(readFileSync(join(f.job.worktreeRoot, ".story-inbox/ideas/bell-revisit.yaml"), "utf8"));
  assert.equal(inbox.lifecycle.placements.length, steps.length);
  assert.ok(inbox.lifecycle.placements.slice(1).every((p: any) => p.action === "reassessed"));
  const checkpoint = done.ideaHistory;
  assert.deepEqual(f.cli(["generate", "inspect"]).ideaHistory, checkpoint);
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.initial);
});

test("rejected placement remains dormant, blocks binding completion, and is not blindly retried", { skip: !available }, async () => {
  const f = setup("ideas-rejected");
  f.env.NT_IDEA_FIXTURE_REJECT = "rejected-concept";
  const file = join(root, "ideas-rejected.json");
  writeFileSync(file, JSON.stringify({
    id: "rejected-concept", kind: "event-concept",
    source: { kind: "author-onboarding", reference: "editor-notes" },
    original: "An unverified clue should not be forced into a scene.",
    requirements: { meaning: [{ text: "The clue must be causal", binding: true }],
      wording: [], participants: [] },
    identities: { known: [], unresolved: [] }, prerequisites: ["milestone.disclosure"],
    placement: { scopeIds: ["arc.truth"], flexible: true, earliest: "event" },
    upstreamConstraints: [],
  }));
  f.cli(["ideas", "capture", "--file", file]);
  const result = f.cli(f.start);
  assert.equal(result.status, "blocked", JSON.stringify(result));
  assert.ok(result.ideaHistory.some((h: any) => h.id === "rejected-concept" &&
    h.status === "deferred"));
  const deferred = result.recoveryInspection;
  assert.equal(deferred?.phase, "idle");
  assert.equal(deferred?.active, null);
  assert.equal(deferred?.pending.length, 1,
    "the original unresolved idea must remain queued rather than being marked verified");
  assert.equal(deferred.pending[0].operation, "idea-integration");
  const saver = SqliteSaver.fromConnString(result.checkpointPath);
  try {
    const graph = createGenerationGraph(saver, "cli");
    const state = (await graph.getState({ configurable: { thread_id: result.threadId } })).values;
    const source = state.recoverySources.find((item: any) => item.caseId === deferred.pending[0].caseId);
    assert.ok(source, "the pending case retains its original evidence");
    assert.equal(source.input.operation, "idea-integration");
    assert.equal(source.input.outcome, "returned-failure");
    assert.equal(source.input.check, "idea-dispatch.v1");
    assert.equal(source.input.checkVersion, 1);
    assert.equal(source.input.safeAction, "continue-independent");
    assert.equal(source.input.source.jobId, "single");
    assert.equal(source.input.evidence.ideaId, "rejected-concept");
    assert.equal(source.input.evidence.resultStatus, "deferred");
  } finally { saver.db.close() }
  const inbox = JSON.parse(readFileSync(join(f.job.worktreeRoot, ".story-inbox/ideas/rejected-concept.yaml"), "utf8"));
  assert.equal(inbox.lifecycle.status, "dormant");
  assert.deepEqual(inbox.lifecycle.placements, []);
  assert.deepEqual(result.report.evidence.deferredIdeas.scopedOutstanding, ["rejected-concept"]);
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  assert.deepEqual(f.cli(["generate", "resume"]).ideaHistory, result.ideaHistory);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
});

function captureRecoveryIdea(f: ReturnType<typeof setup>, id: string) {
  const file = join(root, id + "-recovery-idea.json");
  writeFileSync(file, JSON.stringify({
    id, kind: "event-concept",
    source: { kind: "author-onboarding", reference: "source-notes" },
    original: "The bell establishes the archive visitor's arrival.",
    requirements: { meaning: [{ text: "The bell establishes the chronology", binding: true }],
      wording: [], participants: [] },
    identities: { known: [], unresolved: [] },
    prerequisites: ["milestone.disclosure"],
    placement: { scopeIds: ["arc.truth"], flexible: true, earliest: "event" },
    upstreamConstraints: [],
  }));
  f.cli(["ideas", "capture", "--file", file]);
}



test("C02 later native-verified foundation commit discharges an original no-write assignment without redispatch", {
  skip: !available, timeout: 120_000,
}, async () => {
  const f = setup("c02-later-specialist-correction");
  const paused = f.cli([...f.start, "--pause-after", "foundation"]);
  assert.equal(paused.status, "paused");
  const item = paused.inventory.items.find((work: any) => work.id === "foundation");
  assert.equal(item?.status, "verified");
  const correctedHead = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const original = {
    jobId: f.job.jobId, jobThreadId: f.job.threadId, graphThreadId: paused.threadId,
    turnDigest: "b".repeat(64), planVersion: null, sourceHeadSha: f.initial,
    assignmentId: "foundation", operation: "specialist-dispatch",
    check: "specialist-dispatch.v1", checkVersion: 1,
    failureAnchor: { store: "graph-checkpoint" as const,
      ref: paused.threadId + ":original-no-write", failedCheckInstanceId: "original-dispatch" },
  };
  const admission = await recoveryAdmission({
    origin: original, kind: "semantic", observation: "returned-failure",
    effect: "settled-no-write", evidence: [{ store: "graph-checkpoint",
      ref: original.failureAnchor.ref }], authenticate: async () => true,
  });
  assert.equal(admission.outcome, "admitted");
  if (admission.outcome !== "admitted") throw Error("missing original fixture case");
  const sourceRecord = { channel: "operationRecovery" as const, caseId: admission.case.id,
    input: { operation: "specialist-dispatch", outcome: "exception",
      safeAction: "continue-independent",
      evidence: { reference: "specialist-receipt", assignmentId: "foundation",
        priorHead: f.initial } } };
  const verified = await inspectDeferredCorrection(f.job, admission.case, sourceRecord, {
    inventory: paused.inventory, ideaHistory: [], fixture: true,
  });
  assert.equal(verified?.correction.store, "review-checkpoint",
    JSON.stringify({ item, points: (await inspectRecoveryCheckpoints(f.job)).map(p =>
      ({ workItem: p.workItem, sha: p.commitSha, review: p.semanticReview, eligible: p.eligible })) }));
  assert.equal(verified?.correctedHeadSha, correctedHead);
  assert.equal(await inspectDeferredCorrection(f.job, admission.case, {
    ...sourceRecord, input: { ...sourceRecord.input,
      evidence: { reference: "specialist-receipt", assignmentId: "foundation" } },
  }, { inventory: paused.inventory, ideaHistory: [], fixture: true }), null,
  "The historical continue-independent hint cannot replace original no-write source proof");
  const withheld = await inspectDeferredCorrection(f.job, admission.case, sourceRecord, {
    inventory: { ...paused.inventory, items: paused.inventory.items.map((work: any) =>
      work.id === "foundation" ? { ...work, status: "blocked" } : work) },
    ideaHistory: [], fixture: true,
  });
  assert.equal(withheld, null, "an unverified assignment cannot satisfy the original failure");
  const tampered = await inspectDeferredCorrection(f.job, admission.case, sourceRecord, {
    inventory: paused.inventory, ideaHistory: [], fixture: true,
  }, { ...verified!, correctedHeadSha: "f".repeat(40) });
  assert.equal(tampered, null, "restart cannot accept a forged correction SHA");
});

test("C02 production deferred idea later placement discharges its original case across graph restart", {
  skip: !available, timeout: 120_000,
}, async () => {
  const f = setup("c02-deferred-later-idea");
  captureRecoveryIdea(f, "later-bell");
  f.env.NT_IDEA_FIXTURE_REJECT = "later-bell";
  const deferred = f.cli(f.start);
  assert.equal(deferred.status, "blocked");
  assert.equal(deferred.recoveryInspection?.pending.length, 1);
  const originalCase = deferred.recoveryInspection.pending[0].caseId;
  const originalHead = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  delete f.env.NT_IDEA_FIXTURE_REJECT;
  const plan = f.cli(["ideas", "plan"]);
  const task = plan.tasks.find((entry: any) => entry.id === "later-bell");
  assert.ok(task?.candidates?.length, "later correction requires a real eligible placement target");
  const placed = f.cli(["ideas", "place", "--fixture", "--id", "later-bell",
    "--target", task.candidates[0].id, "--skills-source", source]);
  assert.match(placed.status, /integrated/);
  const correctedHead = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  assert.notEqual(correctedHead, originalHead);
  const previous = Object.fromEntries(Object.keys(f.env).map(key => [key, process.env[key]]));
  Object.assign(process.env, f.env);
  const saver = SqliteSaver.fromConnString(deferred.checkpointPath);
  try {
    const graph = createGenerationGraph(saver, "cli");
    const cfg = { configurable: { thread_id: deferred.threadId } };
    const saved = await graph.getState(cfg);
    const resolved = await graph.invoke({ request: saved.values.request },
      { ...cfg, recursionLimit: 10000, interruptAfter: ["author_update_intake"] });
    assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), correctedHead,
      "Deferred resolution must not replay an original writer or commit before parent intake");
    assert.equal(resolved.inventory?.headSha, correctedHead,
      "Parent intake reconciles the corrected HEAD before any downstream dispatch");
    assert.equal(resolved.status, "running");
    assert.equal(resolved.recoveryLifecycle?.pending.length, 0);
    assert.equal(resolved.recoveryLifecycle?.discharged.length, 1);
    assert.equal(resolved.recoveryLifecycle?.discharged[0]?.case.id, originalCase);
    assert.equal(resolved.recoveryLifecycle?.discharged[0]?.correctedHeadSha, correctedHead);
    const restarted = await inspectModernGenerationRecovery(f.job, saver, deferred.threadId);
    assert.deepEqual(restarted, resolved.recoveryLifecycle,
      "the persisted original case and later placement must both reauthenticate on restart");
    await graph.updateState(cfg, { recoveryLifecycle: {
      ...resolved.recoveryLifecycle!,
      discharged: [{ ...resolved.recoveryLifecycle!.discharged[0]!,
        correctedHeadSha: "f".repeat(40) }],
    } }, "schedule");
    const tampered = await inspectModernGenerationRecovery(f.job, saver, deferred.threadId);
    assert.equal(tampered?.phase, "fenced", "an invented later correction cannot clear completion");
    assert.equal(tampered?.active, null);
  } finally {
    saver.db.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("production start assesses thrown author-update intake and restart cannot replay it", { skip: !available }, () => {
  const f = setup("recovery-author-intake");
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
  const repaired = f.cli(["generate", "resume"]);
  assert.equal(repaired.operationRecovery?.phase, "continued",
    JSON.stringify({ reason: repaired.reason, recovery: repaired.recoveryInspection }));
  assert.equal(repaired.operationRecovery?.operation, "author-update-intake");
});

test("C02 current-format checkpoint tampering cannot grant a new recovery or writer attempt", { skip: !available }, async () => {
  const f = setup("recovery-current-tamper");
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

test("production resume assesses failed scheduling without repeating completed work", { skip: !available }, () => {
  const f = setup("recovery-schedule");
  captureRecoveryIdea(f, "schedule-bell");
  const paused = f.cli([...f.start, "--pause-after", "event"]);
  assert.equal(paused.status, "paused");
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  writeFileSync(join(f.job.stateDir, "idea-placement-tasks.json"),
    JSON.stringify({ version: 999, jobId: "single", history: [] }));
  const result = f.cli(["generate", "resume"]);
  assert.equal(result.status, "blocked");
  assert.equal(result.operationRecovery?.operation, "scheduling");
  assert.equal(result.operationRecovery?.phase, "fenced");
  assert.equal(result.operationRecovery?.source.headSha, head);
  assert.equal(result.operationRecovery?.evidence.reference, "generation-checkpoint");
  assert.match(result.operationRecovery?.reason ?? "", /schedule receipt|provenance/i);
  assert.deepEqual(f.cli(["generate", "inspect"]).operationRecovery, result.operationRecovery);
  assert.deepEqual(f.cli(["generate", "resume"]).operationRecovery, result.operationRecovery);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
  // Restore only the exact original controller schedule shape; no write
  // operation is authorized merely because the earlier failure is gone.
  writeFileSync(join(f.job.stateDir, "idea-placement-tasks.json"),
    JSON.stringify({ version: 1, jobId: "single", history: [] }));
  const repaired = f.cli(["generate", "resume"]);
  assert.equal(repaired.operationRecovery?.phase, "continued",
    "a restored read-only schedule receipt unblocks the same persisted Turn");
  assert.equal(repaired.operationRecovery?.source.headSha, head);
});

test("unknown original idea dispatch is fenced on resume without restarting a writer", { skip: !available }, () => {
  const f = setup("recovery-idea-dispatch");
  captureRecoveryIdea(f, "dispatch-bell");
  const paused = f.cli([...f.start, "--pause-after", "event"]);
  assert.equal(paused.status, "paused");
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const file = join(f.job.stateDir, "generation-idea-dispatch.json");
  const receipt = { jobId: "different-job", task: { id: "dispatch-bell" }, phase: "running" };
  writeFileSync(file, JSON.stringify(receipt));
  const result = f.cli(["generate", "resume"]);
  assert.equal(result.status, "blocked");
  assert.equal(result.operationRecovery?.operation, "idea-integration");
  assert.equal(result.operationRecovery?.phase, "fenced");
  assert.equal(result.operationRecovery?.evidence.ideaId, "dispatch-bell");
  assert.equal(result.operationRecovery?.evidence.reference, "generation-idea-dispatch");
  assert.match(result.operationRecovery?.nextAction ?? "", /never dispatch it again/i);
  const settledHead = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  assert.equal(git(f.job.worktreeRoot, "merge-base", "--is-ancestor", head, settledHead), "");
  assert.deepEqual(f.cli(["generate", "inspect"]).operationRecovery, result.operationRecovery);
  assert.deepEqual(f.cli(["generate", "resume"]).operationRecovery, result.operationRecovery);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), receipt);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), settledHead);
});

test("amended Event objective reaches production but an unamended parent fails closed without replay", { skip: !available }, async () => {
  const f = setup("adaptive-dispatch");
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope = { kind: "full-story", depth: "composition", targets: [], branches: [] };
  writeFileSync(f.contract, JSON.stringify(contract));
  const first = f.cli([...f.start, "--pause-after", "foundations"]);
  assert.equal(first.status, "paused", JSON.stringify(first));
  const selected = first.inventory.items.find((item: any) =>
    item.id === "event:milestone.disclosure");
  assert.equal(selected?.status, "pending");
  const outcome = "Expose both the ledger's time discrepancy and the witness's independent testimony.";
  const milestonePath = "milestones/disclosure.md";
  const bytes = readFileSync(join(f.job.worktreeStoryRoot, milestonePath));
  const fullHash = createHash("sha256").update(bytes).digest("hex");
  const projectedHash = createHash("sha256")
    .update(milestoneFulfillmentProjection(bytes.toString("utf8"))).digest("hex");
  const architecture = JSON.parse(readFileSync(join(f.job.stateDir, "architecture.json"), "utf8")).plan;
  const pending = first.inventory.items.filter((item: any) => item.status === "pending")
    .map((item: any) => item.id);
  const turnDigest = "b".repeat(64);
  const proposal = {
    sourceSha: first.inventory.headSha, turnDigest, beforeVersion: 1,
    reason: "Native Milestone needs two concrete, independently testable evidence sources.",
    actions: [{ kind: "narrow" as const, item: selected.id,
      sourcePath: milestonePath, sourceHash: projectedHash, outcome }],
    order: pending,
  };
  const admitted = admitAdaptiveAssignments({
    proposal, inventory: first.inventory, plan: architecture, turnDigest, version: 1,
    verifiedSource: true,
    records: [{ path: milestonePath, metadata: { id: selected.milestone,
      type: "milestone", status: "draft" } }],
    sourceHashes: { [milestonePath]: fullHash },
    milestoneSourceHashes: { [milestonePath]: projectedHash },
    protectedPaths: [], typedEdges: [], authorTargets: [],
    planning: { choice_frequency: "frequent", puzzle_emphasis: "none",
      choice_points: { min: 2, max: 10 } },
    carried: first.inventory.items.filter((item: any) => item.status === "verified")
      .map((item: any) => ({ id: item.id, sha: item.verifiedSha })),
    omissionProofs: [],
  });
  const refined = applyAdaptiveAssignments(first.inventory, admitted).items.find((item: any) =>
    item.id === selected.id)!;
  const request = { story: f.story, job: "single",
    task: "A missing archive witness; invent unspecified details",
    contract, fixture: true, skillsSource: source };
  // The child-process CLI uses a private state/config root. The in-process
  // dispatcher must use that same job rather than the host developer's state.
  const keys = ["NT_STATE_DIR", "NT_CONFIG_FILE", "NT_SKILL_CACHE_DIR", "NT_EVENT_FIXTURE_CASE"] as const;
  const prior = keys.map(key => process.env[key]);
  let dispatched: { status: string; headSha?: string };
  try {
    for (const key of keys) process.env[key] = f.env[key];
    process.env.NT_EVENT_FIXTURE_CASE = "alternative-routes";
    dispatched = await dispatchGenerationAssignment({ request, active: refined });
  } finally {
    keys.forEach((key, index) => {
      if (prior[index] === undefined) delete process.env[key];
      else process.env[key] = prior[index];
    });
  }
  assert.equal(dispatched.status, "event-cluster-committed");
  const receipt = JSON.parse(readFileSync(join(f.job.stateDir, "event-items/disclosure.json"), "utf8"));
  assert.match(receipt.assignment.authorTask, /CONTROLLER-ADMITTED ASSIGNMENT REFINEMENT/);
  assert.match(receipt.assignment.authorTask, /ledger's time discrepancy/);
  assert.deepEqual(receipt.validation.eventIds.sort(), ["event.disclose-ledger", "event.inspect-ledger"],
    "one Event assignment can deliver two native-verified causal Events when justified");
  const commit = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const resumed = f.cli(["generate", "resume", "--pause-after", "event"]);
  assert.equal(resumed.status, "blocked",
    "the parent never signed the externally refined Event task; it cannot inherit that authority");
  assert.match(resumed.reason, /Event author objective changed after its source-bound Milestone planning admission/);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), commit,
    "a mismatched parent cannot replay or overwrite the independently verified Event commit");
  assert.equal(resumed.inventory.items.find((i: any) =>
    i.id === "event:milestone.disclosure")?.status, "blocked");
  assert.ok(resumed.recoveryCheckpoints.some((point: any) =>
    point.workItem === "event-disclosure" && point.commitSha === commit && point.eligible));
  const replayed = f.cli(["generate", "resume", "--pause-after", "event"]);
  assert.equal(replayed.status, "blocked", "a restart must not reset a mismatched objective failure");
  assert.match(replayed.reason, /Event author objective changed/);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), commit,
    "repeated resume cannot reinterpret an external signed task as this parent's own");
});

async function sealFixtureGenerationCheckpoint(f: ReturnType<typeof setup>, workItem: string) {
    const old = Object.fromEntries(Object.keys(f.env).map(key => [key, process.env[key]]));
    Object.assign(process.env, f.env);
    try {
      const job = await startStoryJob({ story: f.story, job: f.job.jobId }, false);
      const point = (await inspectRecoveryCheckpoints(job)).filter(p =>
        p.eligible && p.workItem === workItem).at(-1);
      assert.ok(point?.assurance, "Missing native-validated " + workItem);
      if (point.semanticReview === "not-required" || point.semanticReview === "passed") return;
      assert.equal(point.semanticReview, "required-pending", workItem);
      await reviewBoundedAssignments(job, [point], async packet => ({
        sourceDigest: packet.sourceDigest, verdict: "pass" as const,
        findings: [], evidence: packet.items.map(item => {
          if (workItem === "event-disclosure" && process.env.NT_MILESTONE_BLUEPRINT_FIXTURE_CASE === "historical-knowledge" &&
              (!process.env.NT_BLUEPRINT_SPECIALIST_FIXTURE ||
                process.env.NT_BLUEPRINT_SPECIALIST_FIXTURE === "disagree")) {
            const path = "events/disclose-ledger.md";
            const lines = item.canonicalContext.find(source => source.path === path)!.content.split("\n");
            const index = lines.findIndex(s => s.startsWith("Neri opens the original"));
            assert.ok(index > 0);
            const receipt = JSON.parse(readFileSync(join(job.stateDir, "event-items/disclosure.json"), "utf8"));
            return { path, line: index + 1, explanation: "The reviewed Event is valid. The private plan misstates Ada's access.",
              commitSha: item.assurance.commitSha, assignmentId: item.assignment.id,
              blueprintChallenge: { pinDigest: process.env.NT_BLUEPRINT_CORRECTION_FIXTURE_CHALLENGE === "wrong-pin"
                ? "0".repeat(64) : receipt.blueprintPin.digest, sourceQuote: lines[index]!.trim(), field: "events/0/knowledge",
                before: "Ada never sees the original signed transfer ledger.", proposed: "Ada sees the original ledger and checks it against the daily register." } };
          }
          return {
          commitSha: item.assurance.commitSha, assignmentId: item.assignment.id,
          path: item.assurance.changedPaths[0]!, line: 1,
          explanation: "Deterministic fixture structural review, never a live Pi verdict.",
        }; }),
      }), "deterministic-prerequisite-fixture", true);
    } finally {
      for (const [key, value] of Object.entries(old)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
}

function certificationActivityJournal(): { store: StudioStore; journal: Array<{
  id: number; kind: string; stage: string | null; milestone: string | null;
  filesJson: string; status: string | null; createdAt: string
}> } {
  const journal: Array<{ id: number; kind: string; stage: string | null;
    milestone: string | null; filesJson: string; status: string | null;
    createdAt: string }> = [];
  const store = { persistence: { generation: { events: {
    after: async (_owner: string, _job: string, after: number, limit: number) =>
      journal.filter(row => row.id > after).slice(0, limit),
    append: async (_owner: string, _job: string, row: Omit<typeof journal[number], "id">) => {
      journal.push({ ...row, id: journal.length + 1 });
    },
  } } } } as unknown as StudioStore;
  return { store, journal };
}

for (const defect of ["interactive", "knowledge", "rejected", "tampered", "specialist", "specialist-tampered", "specialist-disputed",
  "specialist-restart", "specialist-wrong-path", "specialist-receipt-tamper",
  "specialist-model-tamper"]) test("actual generation graph resumes Event-only Composition after historical " + defect + " correction (#229/#231 fixture)", { skip: !available }, async () => {
  const f = setup("generation-event-only-no-write-" + defect);
  f.env.NT_MILESTONE_BLUEPRINT_FIXTURE_CASE = "historical-" + (defect === "rejected" ? "interactive" :
    ["tampered", "specialist", "specialist-tampered", "specialist-disputed",
      "specialist-restart", "specialist-wrong-path", "specialist-receipt-tamper",
      "specialist-model-tamper"].includes(defect) ? "knowledge" : defect);
  if (defect.startsWith("specialist"))
    f.env.NT_BLUEPRINT_SPECIALIST_FIXTURE = ["specialist", "specialist-restart",
      "specialist-receipt-tamper", "specialist-model-tamper"].includes(defect)
      ? "knowledge" : defect === "specialist-disputed" ? "disagree" :
      defect === "specialist-wrong-path" ? "wrong-path" : "wrong-pin";
  if (defect === "specialist-disputed") f.env.NT_BLUEPRINT_CORRECTION_FIXTURE_VERDICT = "revise";
  if (defect === "rejected") f.env.NT_BLUEPRINT_CORRECTION_FIXTURE_VERDICT = "revise";
  if (defect === "tampered") f.env.NT_BLUEPRINT_CORRECTION_FIXTURE_CHALLENGE = "wrong-pin";
  for (const key of ["NT_ARCHITECTURE_FIXTURE_CASE", "NT_EVENT_FIXTURE_CASE",
    "NT_INTERACTIVE_FIXTURE_CASE", "NT_COMPOSITION_FIXTURE_CASE"])
    f.env[key] = "event-only";
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope = { kind: "full-story", depth: "composition", targets: [], branches: [] };
  writeFileSync(f.contract, JSON.stringify(contract));
  const task = "An observational mystery where Ada uncovers and validates the concealed archive ledger.";
  f.start[3] = task;
  saveFixtureTurn(f.job, contract, task,
    ["Carry forward the Event evidence and real conversational consequence, without fabricated mechanics."]);
  const seal = (workItem: string) => sealFixtureGenerationCheckpoint(f, workItem);
  const foundation = f.cli([...f.start, "--pause-after", "foundation"]);
  assert.equal(foundation.status, "paused", JSON.stringify(foundation));
  await seal("foundation");
  const architecture = f.cli(["generate", "resume", "--pause-after", "architecture"]);
  assert.equal(architecture.status, "paused", JSON.stringify(architecture));
  await seal("global-architecture");
  const firstWorld = f.cli(["foundations", "run", "--fixture", "--skills-source", source], false);
  assert.match(firstWorld, /review|independent/i);
  await seal("world-foundations");
  const foundations = f.cli(["foundations", "run", "--fixture", "--skills-source", source]);
  assert.equal(foundations.status, "foundations-committed");
  await seal("character-foundations");
  const first = f.cli(["generate", "resume", "--pause-after", "event"]);
  assert.equal(first.status, "paused", JSON.stringify(first));
  if (defect === "tampered") {
    const pinnedHead = git(f.job.worktreeRoot, "rev-parse", "HEAD");
    const pinned = readFileSync(join(f.job.stateDir, "milestone-blueprints/disclosure.json"), "utf8");
    await assert.rejects(seal("event-disclosure"), /Semantic reviewer lacks assignment-specific, source-linked evidence/);
    assert.equal(readFileSync(join(f.job.stateDir, "milestone-blueprints/disclosure.json"), "utf8"), pinned);
    assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), pinnedHead);
    assert.equal(existsSync(join(f.job.stateDir, "interactive-items/disclosure.json")), false);
    return;
  }
  await seal("event-disclosure");
  const eventHead = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const eventFile = join(f.job.stateDir, "event-items/disclosure.json");
  const originalEvent = readFileSync(eventFile, "utf8");
  const activeFile = join(f.job.stateDir, "milestone-blueprints/disclosure.json");
  const original = JSON.parse(readFileSync(activeFile, "utf8"));
  // An original verifier snapshots its already-reviewed specialist effect
  // BEFORE any later independently approved correction. Tests never invent
  // the later correction digest or a substitute writer result.
  const originalTurn = JSON.parse(readFileSync(join(f.job.stateDir, "turn-plan.json"), "utf8"));
  const originalEventAssignment = { id: "event:milestone.disclosure",
    stage: "event" as const, milestone: "milestone.disclosure" };
  const originalEventResult = { status: "event-cluster-committed", headSha: eventHead };
  const originalPlanVersion = JSON.parse(readFileSync(join(f.job.stateDir,
    "architecture.json"), "utf8")).plan.version as number;
  const originalVerifier = ["interactive", "knowledge"].includes(defect)
    ? await captureVerificationFailure(f.job, originalTurn.digest,
        originalEventAssignment, originalEventResult, originalPlanVersion) : null;
  if (originalVerifier) {
    const untouched = await verifyCorrectedOriginalResult(f.job, originalTurn.digest,
      originalEventAssignment, originalEventResult, originalVerifier, originalPlanVersion);
    assert.equal(untouched.eligible, false,
      "unchanged verifier inputs cannot retry the original failure");
    assert.match(untouched.reason, /no new authenticated corrective evidence/);
  }
  if (defect === "specialist-receipt-tamper" || defect === "specialist-model-tamper") {
    const edited = JSON.parse(originalEvent);
    if (defect === "specialist-receipt-tamper")
      edited.blueprintChallenge.proposed = "An unrelated and unapproved new claim.";
    else edited.model = "tampered-model";
    writeFileSync(eventFile, JSON.stringify(edited, null, 2) + "\n");
    const blocked = f.cli(["generate", "resume", "--pause-after", "composition"]);
    assert.equal(blocked.status, "blocked");
    assert.match(blocked.reason, /Blueprint|model|provenance|identity|review/i);
    assert.deepEqual(JSON.parse(readFileSync(activeFile, "utf8")), original);
    assert.equal(existsSync(join(f.job.stateDir, "milestone-blueprint-history",
      "disclosure-" + original.lineage.reviewCycleId + ".json")), false);
    assert.equal(existsSync(join(f.job.stateDir, "interactive-items/disclosure.json")), false);
    assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), eventHead);
    return;
  }
  if (defect === "interactive" || defect === "specialist-restart") {
    if (defect === "interactive") assert.ok(original.draft.downstream.some((entry: any) => entry.owner === "interactive"));
    if (defect === "interactive") {
      const refused = f.cli(["interactive", "run", "--milestone", "milestone.disclosure", "--fixture", "--skills-source", source], false);
      assert.match(refused, /No current reviewed Event, protected Turn scope or planning owner/);
      assert.deepEqual(JSON.parse(readFileSync(activeFile, "utf8")), original, "a challenge alone cannot archive approval");
    }
    f.env.NT_BLUEPRINT_CORRECTION_FIXTURE_INTERRUPT = "archived";
    const interrupted = f.cli(["generate", "resume", "--pause-after", "composition"]);
    assert.equal(interrupted.status, "paused", interrupted.reason);
    assert.match(interrupted.reason, /interruption after original Blueprint archival/);
    assert.equal(existsSync(activeFile), false);
    assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), eventHead);
    const pending = f.cli(["approval-revisions", "inspect"]);
    assert.equal(pending.total, 1, "the incident is durable before semantic correction resumes");
    assert.equal(pending.records[0].disposition, "awaiting-review");
    assert.equal(pending.records[0].severity,
      defect === "specialist-restart" ? "warning" : "info");
    // Resume the actual interrupted receipt, without simulating an obsolete schema.
    delete f.env.NT_BLUEPRINT_CORRECTION_FIXTURE_INTERRUPT;
  }
  let resumed = f.cli(["generate", "resume", "--pause-after",
    defect === "interactive" ? "interactive" : "composition"]);
  if (defect === "interactive") {
    assert.equal(resumed.status, "paused", JSON.stringify(resumed));
    assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), eventHead,
      "a corrected Interactive omission does not rewrite the historically approved Event");
    const turn = JSON.parse(readFileSync(join(f.job.stateDir, "turn-plan.json"), "utf8"));
    const active = "interactive:milestone.disclosure";
    const planVersion = JSON.parse(readFileSync(join(f.job.stateDir, "interactive-items/disclosure.json"), "utf8")).planVersion;
    const assessed = await assessGenerationOperation({ job: f.job, threadId: f.job.threadId,
      turnDigest: turn.digest, planVersion: planVersion,
      operation: "specialist-dispatch", outcome: "exception",
      reason: "The previous dependent assignment failed without a writer commit.",
      safeAction: "continue-independent",
      evidence: { reference: "specialist-receipt", assignmentId: active,
        priorHead: eventHead },
    });
    const proof = await inspectBlockedOriginalThreadCorrection(f.job, f.job.threadId, {
      status: "blocked", graphThreadId: f.job.threadId,
      request: { job: f.job.jobId, task: f.start[3], fixture: true,
        contract: { scope: { kind: "full-story" } }, turnPlanDigest: turn.digest },
      planVersion: planVersion,
      inventory: { headSha: eventHead, items: [{ id: active, status: "blocked" }] },
      active: null, failures: { [active]: assessed.reason },
      operationRecovery: { ...assessed, phase: "continued" },
    });
    assert.equal(proof.eligible, true, proof.reason);
    assert.equal(proof.assignmentId, active,
      "only the exact settled no-write dependent failure can be cleared");
    // Resume through the current-format CLI and original sealed no-write
    // specialist receipt. No historical graph schema is reconstructed.
    resumed = f.cli(["generate", "resume", "--pause-after", "composition"]);
  }
  if (defect === "specialist-tampered" || defect === "specialist-wrong-path") {
    assert.equal(resumed.status, "blocked");
    assert.match(resumed.reason, /Blueprint challenge is not bound to the reviewed (Event|specialist) source/);
    assert.deepEqual(JSON.parse(readFileSync(activeFile, "utf8")), original);
    assert.equal(existsSync(join(f.job.stateDir, "milestone-blueprint-history",
      "disclosure-" + original.lineage.reviewCycleId + ".json")), false);
    assert.equal(existsSync(join(f.job.stateDir, "interactive-items/disclosure.json")), false);
    assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), eventHead);
    assert.equal(readFileSync(eventFile, "utf8"), originalEvent);
    assert.equal(f.cli(["approval-revisions", "inspect"]).total, 0,
      "unverified model challenges must not forge admin warnings");
    return;
  }
  if (defect === "rejected" || defect === "specialist-disputed") {
    assert.equal(resumed.status, "blocked");
    assert.match(resumed.reason, /rejected the exact authorized patch/);
    const rejected = JSON.parse(readFileSync(activeFile, "utf8"));
    assert.equal(rejected.rounds.at(-1).review.status, "revise");
    assert.equal(rejected.approvedDigest, undefined);
    assert.equal(existsSync(join(f.job.stateDir, "interactive-items/disclosure.json")), false);
    assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), eventHead);
    assert.equal(readFileSync(eventFile, "utf8"), originalEvent);
    assert.equal(f.cli(["event", "inspect", "--milestone", "milestone.disclosure"]).milestoneBlueprint.digest, original.approvedDigest);
    const pendingIncident = f.cli(["approval-revisions", "inspect", "--severity",
      defect === "specialist-disputed" ? "warning" : "info"]);
    assert.equal(pendingIncident.total, 1);
    assert.equal(pendingIncident.records[0].disposition, "awaiting-review",
      "negative review must not falsely settle the incident");
    return;
  }
  assert.equal(resumed.status, "paused", JSON.stringify(resumed));
  const corrected = JSON.parse(readFileSync(activeFile, "utf8"));
  assert.notEqual(corrected.lineage.reviewCycleId, original.lineage.reviewCycleId);
  assert.deepEqual(corrected.supersedes.original, JSON.parse(originalEvent).blueprintPin);
  assert.deepEqual(JSON.parse(readFileSync(join(f.job.stateDir, "milestone-blueprint-history",
    "disclosure-" + original.lineage.reviewCycleId + ".json"), "utf8")), original);
  assert.equal(corrected.rounds.length, 1);
  assert.equal(corrected.rounds[0].review.status, "pass");
  if (defect === "interactive") assert.deepEqual(corrected.draft.events, original.draft.events);
  else assert.equal(corrected.draft.events[0].knowledge, "Ada sees the original ledger and checks it against the daily register.");
  assert.equal(corrected.draft.downstream.some((entry: any) => entry.owner === "interactive"), false);
  const turn = JSON.parse(readFileSync(join(f.job.stateDir, "turn-plan.json"), "utf8"));
  const ledgerFile = join(f.job.stateDir, "repair-ledgers", turn.digest + ".json");
  const ledgerOriginal = readFileSync(ledgerFile, "utf8");
  const repaired = JSON.parse(ledgerOriginal);
  if (originalVerifier) {
    const checked = await verifyCorrectedOriginalResult(f.job, originalTurn.digest,
      originalEventAssignment, originalEventResult, originalVerifier, originalPlanVersion);
    assert.equal(checked.eligible, false,
      "once later work advances HEAD, the old verifier is historical and must not retry");
    if (defect === "interactive")
      assert.match(checked.reason, /HEAD advanced without exact signed carry-forward/);
    if (defect === "knowledge")
      assert.match(checked.reason, /affects the completed specialist/,
        "a material Event revision must revalidate the old Event, not skip it");
    if (defect === "interactive") {
      const tampered = await verifyCorrectedOriginalResult(f.job, originalTurn.digest,
        originalEventAssignment, originalEventResult,
        { ...originalVerifier, checkpointDigest: "f".repeat(64) }, originalPlanVersion);
      assert.equal(tampered.eligible, false,
        "a forged or altered original checkpoint digest is not retry authority");
      assert.match(tampered.reason, /checkpoint.*changed/);
    }
  }
  assert.deepEqual(repaired.blueprintRepairs[0].affected, {
    event: defect === "knowledge" || defect.startsWith("specialist"),
    interactive: true, composition: true, completion: true,
  }, "only the owners dependent on the corrected plan must be revalidated");
  if (defect === "interactive") {
    repaired.blueprintRepairs[0].affected.interactive = false;
    writeFileSync(ledgerFile, JSON.stringify(repaired));
    assert.match(f.cli(["composition", "inspect", "--milestone", "milestone.disclosure"], false),
      /selective dependent impact|Blueprint supersession/,
      "altered selective carry-forward must not bypass the authenticated successor");
    writeFileSync(ledgerFile, ledgerOriginal);
  }
  assert.equal(readFileSync(eventFile, "utf8"), originalEvent);
  const revisions = f.cli(["approval-revisions", "inspect"]);
  assert.equal(revisions.total, 1);
  const incident = revisions.records[0];
  assert.equal(incident.disposition, "corrected");
  assert.equal(incident.cause, defect === "interactive" ? "newly-discovered-constraint" : "unclassified");
  assert.equal(incident.severity, defect === "interactive" ? "info" : "warning");
  assert.equal(incident.trigger.kind, defect === "interactive" ? "event-only" : "combined",
    "a source-backed challenge and the Event-only disposition have distinct authenticated origins");
  if (defect.startsWith("specialist")) {
    assert.deepEqual(incident.trigger.fields, ["events/0/knowledge"]);
    assert.deepEqual(incident.trigger.sourcePaths, ["events/disclose-ledger.md"]);
    assert.equal(incident.trigger.reviewDigest, null);
  }
  assert.equal(incident.originalApproval.model, "fixture");
  assert.equal(incident.originalApproval.reviewerId, "fixture");
  assert.equal(incident.successorApproval.reviewerId, "fixture");
  assert.equal(incident.original.digest, original.approvedDigest);
  assert.equal(incident.successor.digest, corrected.approvedDigest);
  if (["interactive", "knowledge", "specialist"].includes(defect)) {
    // #235: Actual graph-produced approval correction reaches the same trusted
    // Studio activity boundary used for author-directed Architecture changes.
    // Neither its model challenge nor an ordinary rerun can mint a second ID.
    const { store, journal } = certificationActivityJournal();
    await syncApprovalRevisionActivity(store, "certification-owner", f.job.jobId, f.job);
    const activity = await listGenerationEvents(store, "certification-owner", f.job.jobId, 0);
    assert.equal(activity.length, 1);
    assert.deepEqual(activity[0]?.detail?.approvalRevision, {
      id: incident.id, scope: "milestone", milestoneId: "milestone.disclosure",
      cause: incident.cause, severity: incident.severity, disposition: "corrected",
    }, "historical post-approval cause/severity must reach operator activity, not Chat");
    await syncApprovalRevisionActivity(store, "certification-owner", f.job.jobId, f.job);
    assert.equal(journal.length, 1, "restart must not duplicate an already corrected incident");
  }
  const ledger = await inspectRepairLedger(f.job, incident.turnDigest);
  const repair = ledger.blueprintRepairs![0]!;
  await recordBlueprintRepair(f.job, incident.turnDigest, repair);
  assert.equal(f.cli(["approval-revisions", "inspect"]).records[0].id, incident.id,
    "replaying the current receipt preserves its correction authority");
  assert.equal((await inspectRepairLedger(f.job, incident.turnDigest)).blueprintRepairs?.length, 1,
    "repeated reconciliation never appends another incident");
  if (defect === "knowledge") {
    const ledgerFile = join(f.job.stateDir, "repair-ledgers", incident.turnDigest + ".json");
    const originalLedger = readFileSync(ledgerFile, "utf8");
    const tampered = JSON.parse(originalLedger);
    tampered.blueprintRepairs[0].incident.cause = "newly-discovered-constraint";
    tampered.blueprintRepairs[0].incident.severity = "info";
    writeFileSync(ledgerFile, JSON.stringify(tampered));
    try {
      assert.match(f.cli(["approval-revisions", "inspect", "--severity", "warning"], false),
        /classification or triggering evidence changed/,
        "internally consistent info labels cannot hide a source-bound warning");
    } finally { writeFileSync(ledgerFile, originalLedger); }
    assert.equal(f.cli(["approval-revisions", "inspect"]).records[0].severity, "warning");
  }
  await assert.rejects(recordBlueprintRepair(f.job, incident.turnDigest, { ...repair,
    incident: { ...repair.incident!, cause: "approval-escape", severity: "warning" } }),
  /Conflicting Milestone Blueprint repair authority/);
  assert.deepEqual(incident.affectedWork,
    ["interactive:milestone.disclosure", "composition:milestone.disclosure"]);
  assert.equal(f.cli(["approval-revisions", "inspect", "--id", incident.id]).total, 1);
  assert.equal(f.cli(["approval-revisions", "inspect", "--severity",
    incident.severity === "warning" ? "info" : "warning"]).total, 0);
  const report = f.cli(["report"]);
  assert.equal(report.evidence.approvalRevisions.total, 1,
    "read-only operator activity must survive into a later report");
  assert.equal(report.evidence.approvalRevisions.records[0].id, incident.id);
  if (defect === "knowledge") {
    const linked = JSON.parse(originalEvent);
    linked.expectedHead = "0".repeat(40);
    writeFileSync(eventFile, JSON.stringify(linked));
    assert.match(f.cli(["approval-revisions", "inspect"], false), /Event\/approval proof mismatch/);
    writeFileSync(eventFile, originalEvent);
    assert.equal(f.cli(["approval-revisions", "inspect"]).records[0].id, incident.id);
    const historyFile = join(f.job.stateDir, "milestone-blueprint-history",
      "disclosure-" + original.lineage.reviewCycleId + ".json");
    const archived = readFileSync(historyFile, "utf8");
    unlinkSync(historyFile);
    assert.match(f.cli(["approval-revisions", "inspect"], false), /Missing reviewed historical Milestone Blueprint/);
    writeFileSync(historyFile, archived);
    assert.equal(f.cli(["approval-revisions", "inspect"]).records[0].id, incident.id);
  }
  assert.ok(git(f.job.worktreeRoot, "log", "-1", "--format=%B", eventHead)
    .includes("NovelTea-Milestone-Blueprint: " + original.approvedDigest));
  const omission = JSON.parse(readFileSync(join(f.job.stateDir,
    "interactive-items/disclosure.json"), "utf8"));
  assert.deepEqual(omission.units.map((unit: any) => unit.phase),
    ["not-applicable", "not-applicable"]);
  assert.equal(omission.correctedBlueprintPin.digest, corrected.approvedDigest);
  assert.deepEqual(JSON.parse(readFileSync(join(f.job.stateDir, "composition-items/disclosure.json"), "utf8")).correctedBlueprintPin,
    omission.correctedBlueprintPin);
  assert.equal(omission.worker, "fixture", "fixture proof is not independent live Pi judgment");
  assert.equal(omission.units[0].beforeHead, eventHead);
  assert.equal(omission.units[1].beforeHead, eventHead);
  assert.ok(omission.units.every((unit: any) => !unit.commitSha));
  assert.equal(resumed.inventory.items.find((item: any) =>
    item.id === "interactive:milestone.disclosure")?.status, "verified");
  assert.equal(resumed.inventory.items.find((item: any) =>
    item.id === "composition:milestone.disclosure")?.status, "verified");
  assert.equal(resumed.inventory.items.find((item: any) => item.stage === "review")?.status,
    "pending", "omission does not waive the final Story-wide reviewer");
  const composed = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD^"), eventHead,
    "Composition is the next Git commit, with no Choice or Puzzle writer commit");
  // Final fulfillment cannot rely on a claimed Composition commit alone.
  // The actual recovery checkpoint needs its separate semantic verdict.
  const atComposition = { ...f.job, headSha: composed };
  const handoff = await reviewedMilestoneHandoff(atComposition, JSON.parse(originalEvent));
  assert.ok(handoff?.supersedes);
  const checkpoints = await inspectRecoveryCheckpoints(atComposition);
  await assert.doesNotReject(assertMilestoneStageClosure(atComposition, handoff, "composition", checkpoints));
  await assert.rejects(assertMilestoneStageClosure(atComposition, handoff, "composition",
    checkpoints.filter(point => point.workItem !== "composition-disclosure")),
  /eligible independently reviewed checkpoint/,
  "A forged Composition receipt without its real checkpoint cannot complete the Turn");
  await assert.rejects(assertMilestoneStageClosure(atComposition, handoff, "composition",
    checkpoints.map(point => point.workItem === "composition-disclosure"
      ? { ...point, semanticReview: "required-pending" } as typeof point : point)),
  /eligible independently reviewed checkpoint/,
  "An outstanding independent stage review cannot be treated as completed");
  const inspected = f.cli(["generate", "inspect"]);
  assert.equal(inspected.status, "paused");
  assert.equal(inspected.inventory.items.find((item: any) =>
    item.id === "interactive:milestone.disclosure")?.status, "verified");
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), composed);
  assert.deepEqual(inspected.recoveryCheckpoints.find((point: any) =>
    point.workItem === "composition-disclosure")?.omittedWorkItems
    ?.map((entry: any) => entry.workItem),
  ["interactive-choice-disclosure", "interactive-puzzle-disclosure"]);
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.initial);
  if (defect === "interactive") {
    const historicalIncident = f.cli(["approval-revisions", "inspect"]).records[0];
    const eventSource = join(f.job.worktreeStoryRoot, "events/disclose-ledger.md");
    writeFileSync(eventSource, readFileSync(eventSource, "utf8") +
      "\nAn independently authorized future revision adds a new clue.\n");
    git(f.job.worktreeRoot, "add", "story/events/disclose-ledger.md");
    git(f.job.worktreeRoot, "commit", "-qm", "Later source revision after original omission review");
    const laterHead = git(f.job.worktreeRoot, "rev-parse", "HEAD");
    assert.notEqual(laterHead, composed);
    assert.equal((await validateStoryJob(f.job)).status, "passed",
      "the later committed Story edit must remain native-valid");
    // This fixture simulates the trusted controller publication of the newly
    // validated later revision without giving the new commit a false specialist
    // checkpoint or independent reviewer approval.
    const publishedHead = join(f.job.stateDir, "revisions/verified-head.json");
    const priorHead = JSON.parse(readFileSync(publishedHead, "utf8"));
    assert.equal(priorHead.headSha, composed);
    writeFileSync(publishedHead, JSON.stringify({ ...priorHead, headSha: laterHead,
      workItemId: "fixture-later-source-revision" }));
    const omissionSeal = JSON.parse(readFileSync(join(f.job.stateDir,
      "interactive-event-only/disclosure.json"), "utf8"));
    await assert.rejects(readEventOnlyOmission(f.job, "milestone.disclosure", {
      nonce: omissionSeal.nonce, digest: omissionSeal.digest,
    }), /canonical evidence changed/,
    "live omission admission still refuses changed Story files");
    assert.deepEqual(f.cli(["approval-revisions", "inspect"]).records[0], historicalIncident,
      "historical warning must remain inspectable after later committed source edits");
    unlinkSync(activeFile);
    assert.match(f.cli(["composition", "inspect", "--milestone", "milestone.disclosure"], false), /active controller-approved Blueprint/);
    assert.equal(f.cli(["event", "inspect", "--milestone", "milestone.disclosure"]).milestoneBlueprint.digest, original.approvedDigest);
  }
});

test("#213 narrative-led full-Story handoff keeps omitted mechanics distinct from a completed Story", {
  skip: !available,
}, async () => {
  const f = setup("cert-213-narrative");
  for (const key of ["NT_ARCHITECTURE_FIXTURE_CASE", "NT_EVENT_FIXTURE_CASE",
    "NT_INTERACTIVE_FIXTURE_CASE", "NT_COMPOSITION_FIXTURE_CASE"])
    f.env[key] = "event-only";
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope = { kind: "full-story", depth: "composition", targets: [], branches: [] };
  writeFileSync(f.contract, JSON.stringify(contract));
  const objective = "Resolve the missing archive witness using two dated records, "
    + "without inventing a formal Puzzle or exposing their identity.";
  f.start[3] = objective;
  saveFixtureTurn(f.job, contract, objective, [
    "Deliver player-facing prose and verifiable independent records without forced custom mechanics.",
  ]);
  assert.equal(f.cli([...f.start, "--pause-after", "foundation"]).status, "paused");
  await sealFixtureGenerationCheckpoint(f, "foundation");
  assert.equal(f.cli(["generate", "resume", "--pause-after", "architecture"]).status, "paused");
  await sealFixtureGenerationCheckpoint(f, "global-architecture");
  assert.match(f.cli(["foundations", "run", "--fixture", "--skills-source", source], false),
    /review|independent/i);
  await sealFixtureGenerationCheckpoint(f, "world-foundations");
  assert.equal(f.cli(["foundations", "run", "--fixture", "--skills-source", source]).status,
    "foundations-committed");
  await sealFixtureGenerationCheckpoint(f, "character-foundations");
  assert.equal(f.cli(["generate", "resume", "--pause-after", "event"]).status, "paused");
  await sealFixtureGenerationCheckpoint(f, "event-disclosure");
  const composed = f.cli(["generate", "resume", "--pause-after", "composition"]);
  assert.equal(composed.status, "paused", JSON.stringify(composed));
  const item = JSON.parse(readFileSync(join(f.job.stateDir,
    "interactive-items/disclosure.json"), "utf8"));
  assert.deepEqual(item.units.map((unit: any) => unit.phase),
    ["not-applicable", "not-applicable"]);
  assert.ok(item.units.every((unit: any) => !unit.commitSha));
  const originalHead = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  for (let attempt = 0; attempt < 2; attempt++) {
    const inspect = f.cli(["generate", "inspect"]);
    assert.equal(inspect.status, "paused");
    assert.equal(inspect.nextStage, "review");
    assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), originalHead);
  }
  const final = f.cli(["generate", "resume"]);
  assert.notEqual(final.status, "completed",
    "structural fixture checks cannot replace independent Story-level review");
  assert.equal(final.report.generation.planFulfillment.status === "passed", false);
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.initial);
});

test("#230 genuinely Interactive production fixture preserves required Choices, native routes and review", {
  skip: !available,
}, async () => {
  const f = setup("cert-213-choices");
  f.env.NT_EVENT_FIXTURE_CASE = "alternative-routes";
  f.env.NT_INTERACTIVE_FIXTURE_CASE = "two-choices";
  f.env.NT_MILESTONE_BLUEPRINT_FIXTURE_CASE = "historical-interactive";
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope = { kind: "full-story", depth: "composition", targets: [], branches: [] };
  contract.constraints.push("Two decisions must change later trust or disclosed knowledge; "
    + "the source evidence remains inspectable on both routes.");
  writeFileSync(f.contract, JSON.stringify(contract));
  const first = f.cli([...f.start, "--pause-after", "interactive"]);
  assert.equal(first.status, "paused", JSON.stringify(first));
  const interactive = JSON.parse(readFileSync(join(f.job.stateDir,
    "interactive-items/disclosure.json"), "utf8"));
  assert.equal(interactive.units[0].phase, "committed");
  assert.equal(interactive.correctedBlueprintPin, undefined,
    "A genuine Interactive owner cannot be silently removed by an Event-only omission");
  assert.ok(JSON.parse(readFileSync(join(f.job.stateDir, "milestone-blueprints/disclosure.json"), "utf8"))
    .draft.downstream.some((entry: any) => entry.owner === "interactive"));
  assert.deepEqual(interactive.units[0].validation.choices.map((c: any) => c.id).sort(),
    ["choice-point.loyalty", "choice-point.testimony"]);
  assert.equal(interactive.units[1].phase, "committed");
  const routes = first.inventory.audit.routeCoverage.milestones.filter(
    (m: any) => m.milestone === "milestone.disclosure");
  assert.ok(routes.length >= 2);
  assert.ok(routes.every((r: any) => r.status === "reachable"),
    "diverging routes must have native-reachable evidence");
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const atInteractive = { ...f.job, headSha: head };
  const sourceReceipt = JSON.parse(readFileSync(join(f.job.stateDir, "event-items/disclosure.json"), "utf8"));
  const handoff = await reviewedMilestoneHandoff(atInteractive, sourceReceipt);
  assert.ok(handoff);
  const checkpoints = await inspectRecoveryCheckpoints(atInteractive);
  await assert.rejects(assertMilestoneStageClosure(atInteractive, handoff, "interactive", checkpoints),
    /eligible independently reviewed checkpoint/,
    "Required Choice work cannot be carried forward with pending semantic review");
  assert.equal(checkpoints.some(point => point.workItem === "interactive-choice-disclosure" &&
    point.eligible && ["passed", "not-required"].includes(point.semanticReview)), false,
  "This legacy structural fixture has no independently reviewed Choice checkpoint; no synthetic approval is allowed");
  await assert.rejects(assertMilestoneStageClosure(atInteractive, handoff, "interactive",
    checkpoints.filter(point => point.workItem !== "interactive-choice-disclosure")),
  /eligible independently reviewed checkpoint/,
  "The final gate cannot accept fabricated Choice work after a genuine interactive Blueprint");
  const inspect = f.cli(["generate", "inspect"]);
  assert.equal(inspect.status, "paused");
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
  const finished = f.cli(["generate", "resume"]);
  assert.equal(finished.status, "blocked", JSON.stringify(finished));
  assert.equal(finished.reason, "editorial-unverified");
  assert.equal(finished.report.generation.planFulfillment.status === "passed", false);
  const after = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  assert.equal(f.cli(["generate", "resume"]).status, "blocked");
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), after);
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.initial);
});

test("stale original Turn after a reviewed World checkpoint fails closed instead of retrying foundations forever", { skip: !available }, async () => {
  const f = setup("stale-turn-world-checkpoint");
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope = { kind: "full-story", depth: "composition", targets: [], branches: [] };
  writeFileSync(f.contract, JSON.stringify(contract));
  const task = "Create an archive mystery with a protected Story foundation.";
  f.start[3] = task;
  saveFixtureTurn(f.job, contract, task, ["Preserve the original authenticated Turn."]);
  assert.equal(f.cli([...f.start, "--pause-after", "foundation"]).status, "paused");
  await sealFixtureGenerationCheckpoint(f, "foundation");
  assert.equal(f.cli(["generate", "resume", "--pause-after", "architecture"]).status, "paused");
  await sealFixtureGenerationCheckpoint(f, "global-architecture");
  const firstWorld = f.cli(["foundations", "run", "--fixture", "--skills-source", source], false);
  assert.match(firstWorld, /review|independent/i);
  await sealFixtureGenerationCheckpoint(f, "world-foundations");
  const worldHead = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const file = join(f.job.stateDir, "turn-plan.json");
  const changed = JSON.parse(readFileSync(file, "utf8"));
  changed.originalRequest = "A different, unapproved objective";
  const { digest: _saved, ...body } = changed;
  changed.digest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  writeFileSync(file, JSON.stringify(changed));
  const run = spawnSync(process.execPath, [...cliEntry(), "job", "generate", "resume",
    "--pause-after", "event", "--story", f.story, "--job", "single"], {
    encoding: "utf8", env: f.env, timeout: 25_000, maxBuffer: 24 * 1024 * 1024,
  });
  assert.equal(run.status, 0, run.stderr || run.error?.message);
  const result = JSON.parse(run.stdout);
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /original.*Turn|stale|corrupt|source base/i);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), worldHead,
    "neither a Character writer nor a planner may replay after Turn drift");
  const receipt = JSON.parse(readFileSync(join(f.job.stateDir, "character-world.json"), "utf8"));
  assert.equal(receipt.units[0].phase, "committed");
  assert.equal(receipt.units[1].phase, "pending");
});

test("one authorized Choice assignment can certify multiple meaningful Choices within a Milestone", { skip: !available }, () => {
  const f = setup("multi-choice-bundle");
  f.env.NT_INTERACTIVE_FIXTURE_CASE = "two-choices";
  const paused = f.cli([...f.start, "--pause-after", "interactive"]);
  assert.equal(paused.status, "paused", JSON.stringify(paused));
  const receipt = JSON.parse(readFileSync(join(f.job.stateDir, "interactive-items/disclosure.json"), "utf8"));
  assert.equal(receipt.units[0].phase, "committed");
  assert.deepEqual(receipt.units[0].validation.choices.map((choice: any) => choice.id).sort(),
    ["choice-point.loyalty", "choice-point.testimony"]);
  const choices = paused.recoveryCheckpoints.filter((p: any) =>
    p.workItem === "interactive-choice-disclosure" && p.eligible);
  assert.equal(choices.length, 1, "a source-bounded Choice cluster requires only one independently reviewed commit");
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const again = f.cli(["generate", "inspect"]);
  assert.equal(again.status, "paused");
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
});

/**
 * Run the actual compiled production graph from an already committed fixture
 * Foundation. Only the external Pi transport/review boundary is deterministic:
 * the graph's verification, author boundary and next specialist are real.
 * This is a routing regression, not a substitute for a live Pi certification.
 */
async function runFixtureRecoveryGraph(
  name: string, refused: boolean | "exception" | "diagnostic" | "exception-diagnostic" | "exception-actionable",
  controlAfterSelection?: "paused" | "cancelled" | "budget",
  corruptCompletedAttempt: false | "invocation" | "original-proof" = false,
) {
  const f = setup(name);
  saveFixtureTurn(f.job, JSON.parse(readFileSync(f.contract, "utf8")), f.start[3]!,
    ["Retain the approved archive witness objective and its causal requirements."]);
  const paused = f.cli([...f.start, "--pause-after", "foundation"]);
  assert.equal(paused.status, "paused", JSON.stringify(paused));
  // The deterministic mock replaces the negative-review transport, not the
  // graph's mandatory source assurance. Keep the independently sealed fixture
  // proof real or the scheduler must refuse to carry this Foundation forward.
  await sealFixtureGenerationCheckpoint(f, "foundation");
  const before = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const foundation = paused.inventory.items.find((item: { id: string }) => item.id === "foundation");
  assert.ok(foundation, "Recovery needs the already authored Foundation assignment");
  const log: string[] = [];
  // Persist the controller's phase across repeated graph boundary entry:
  // an already sealed repair is reconciled, never written a second time.
  const original = { sourceCommitSha: before };
  let repair = { ...original, phase: refused ? "needs-plan" : "ready",
    repairedCommitSha: undefined as string | undefined };
  const set = (phase: typeof repair.phase, repairedCommitSha?: string) =>
    repair = { ...repair, phase, repairedCommitSha };
  const priorEnv = Object.fromEntries(Object.keys(f.env).map(key => [key, process.env[key]]));
  Object.assign(process.env, f.env);
  const saver = SqliteSaver.fromConnString(paused.checkpointPath);
  try {
    const graph = createGenerationGraph(saver, "cli", async state => {
      if (state.active?.id !== "foundation") return {}; // Later fixture stages require no Pi review.
      assert.equal(state.active?.id, "foundation");
      assert.equal(state.result?.headSha, before);
      if (refused === "exception" || refused === "exception-diagnostic" || refused === "exception-actionable") {
        log.push("review-transport-failed");
        throw Error("Injected review transport failure");
      }
      const { driveRejectedRepairCycle } = await import("../src/rejected-repair-controller.js");
      const outcome = await driveRejectedRepairCycle({
        begin: async () => repair,
        inspect: async sourceSha => {
          assert.equal(sourceSha, original.sourceCommitSha);
          return repair;
        },
        correct: async () => {
          log.push("original-session-correction");
          return set("validating");
        },
        choice: async () => { throw Error("No author question is expected"); },
        consume: async () => { throw Error("No author response is expected"); },
        validate: async () => {
          log.push("native-validation");
          return set("awaiting-checkpoint");
        },
        commit: async () => {
          log.push("correction-proof-publication");
          return set("reviewing", before);
        },
        reviewStatus: async () => "required-pending" as const,
        rereview: async () => { log.push("fresh-independent-review"); },
        finishReview: async () => {
          log.push("independent-verdict");
          return set("passed", before);
        },
        nextFailure: async () => { throw Error("Unexpected rejected correction"); },
        adjudicate: async () => { throw Error("Unexpected dispute"); },
      });
      if (outcome.next === "controller-replan") {
        log.push("refuse-other-owner-write");
        return { status: "blocked" as const, reason: "Outside original specialist authority",
          escalation: {
            kind: "dependency-replan" as const, requiresTrustedApproval: false,
            sources: [{ source: "characters/witness.md", message: "Another owner must correct this record",
              repair: "controller-amendment" }],
            action: "Require a separate authenticated controller assignment",
          } };
      }
      assert.equal(outcome.next, "completed");
      return { result: state.result };
    });
    const config = { configurable: { thread_id: paused.threadId } };
    const transport = refused === "diagnostic" || refused === "exception-diagnostic" ||
      refused === "exception-actionable"
      ? await (await import("./scripted-recovery-model.js")).scriptedRecoveryModel(
          refused === "exception-actionable" ? "reconcile-original" : "unsafe") : null;
    const initial = (await graph.getState(config)).values;
    if (transport) await (await import("../src/job-pi-policy.js")).configurePiPolicy(f.job, { version: 1,
      profile: { provider: transport.model.provider, model: transport.model.id }, limits: { modelCalls: 2 } });
    await graph.updateState(config, {
      ...(transport ? { request: { ...initial.request, fixture: false, provider: transport.model.provider, model: transport.model.id,
        turnPlanDigest: JSON.parse(readFileSync(join(f.job.stateDir, "turn-plan.json"), "utf8")).digest } } : {}),
      active: foundation, result: { status: "committed", headSha: before },
      status: "running", reason: null, completedStages: [], pauseAfter: "architecture",
    }, "specialist_dispatch");
    if (refused) {
      const admitted = await graph.invoke(null, { ...config, interruptBefore: ["assess_recovery"] });
      assert.equal(admitted.recoveryLifecycle.active?.origin.operation, "independent-review");
      assert.equal(admitted.recoveryLifecycle.active?.observation,
        ["exception", "exception-diagnostic", "exception-actionable"].includes(String(refused)) ? "exception" : "returned-failure");
      assert.equal(admitted.recoveryLifecycle.attempt, null, "A refusal is not a correction attempt");
      const selected = await graph.invoke(null, { ...config, interruptAfter: ["assess_recovery"] });
      assert.equal(selected.recoveryLifecycle.decision?.caseId, admitted.recoveryLifecycle.active?.id);
      assert.equal(selected.recoveryLifecycle.decision?.checkedSourceHeadSha, before);
      assert.equal(selected.recoveryLifecycle.assessorPending, true);
      if (transport) assert.equal(selected.recoveryLifecycle.decision?.action, "diagnostic");
      if (controlAfterSelection === "budget") {
        await (await import("../src/job-pi-policy.js")).configurePiPolicy(f.job, { version: 1,
          profile: { provider: transport!.model.provider, model: transport!.model.id },
          limits: { modelCalls: 0 } });
      } else if (controlAfterSelection) await setJobControl(f.job, controlAfterSelection);
      assert.deepEqual(log, [refused === "exception" || refused === "exception-diagnostic" ||
        refused === "exception-actionable" ? "review-transport-failed" : "refuse-other-owner-write"]);
    }
    let next = transport ? await (await import("../src/model-runtime.js")).withJobModelRuntime(transport.rt,
      () => createGenerationGraph(saver, "cli").invoke(null,
        refused === "exception-actionable" ? { ...config, interruptAfter: ["assess_recovery"] } : config)) :
      await graph.invoke(null, config);
    if (refused === "exception-actionable" && transport) {
      assert.equal(next.recoveryLifecycle.decision?.action, "reconcile-effects",
        JSON.stringify({ status: next.status, reason: next.reason, lifecycle: next.recoveryLifecycle }));
      assert.equal(next.recoveryLifecycle.attempt?.phase, "settled");
      assert.equal(transport.calls.length, 1);
      assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, paused.threadId),
        next.recoveryLifecycle);
      const resolved = await createGenerationGraph(saver, "cli").invoke(null,
        { ...config, interruptAfter: ["assess_recovery"] });
      assert.equal(resolved.recoveryLifecycle.active, null,
        JSON.stringify({ status: resolved.status, reason: resolved.reason, lifecycle: resolved.recoveryLifecycle }));
      assert.equal(resolved.recoveryLifecycle.phase, "idle");
      assert.equal(resolved.status, "running");
      assert.equal(transport.calls.length, 1, "No second Pi diagnosis or reviewer on C05 reconciliation");
      assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, paused.threadId),
        resolved.recoveryLifecycle);
      assert.deepEqual((await graph.getState(config)).next, ["author_update_intake"],
        "After authenticated source repair, the original generation graph resumes");
      next = resolved;
    }
    if (controlAfterSelection && transport) {
      assert.equal(next.status, controlAfterSelection === "budget" ? "paused" : controlAfterSelection);
      assert.equal(next.recoveryLifecycle.decision?.action, "pause");
      assert.equal(next.recoveryLifecycle.decision?.reason, controlAfterSelection === "budget" ? "budget" :
        controlAfterSelection === "paused" ? "author-pause" : "cancelled");
      assert.equal(next.recoveryLifecycle.attempt, null);
      assert.equal(transport.calls.length, 0, "Author control prevents dispatch of the selected model action");
      assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, paused.threadId), next.recoveryLifecycle);
      if (controlAfterSelection === "paused" || controlAfterSelection === "budget") {
        if (controlAfterSelection === "budget") {
          await (await import("../src/job-pi-policy.js")).configurePiPolicy(f.job, { version: 1,
            profile: { provider: transport.model.provider, model: transport.model.id },
            limits: { modelCalls: 2 } });
        } else await setJobControl(f.job, "running");
        next = await (await import("../src/model-runtime.js")).withJobModelRuntime(transport.rt,
          () => createGenerationGraph(saver, "cli").invoke({ request: next.request }, config));
      } else {
        const restart = await createGenerationGraph(saver, "cli").invoke({ request: next.request }, config);
        assert.equal(restart.status, "cancelled");
        assert.equal(transport.calls.length, 0);
      }
    }
    if (transport && controlAfterSelection !== "cancelled" && refused !== "exception-actionable") {
      assert.equal(next.recoveryLifecycle.decision?.action, "diagnostic-stop", next.reason ?? undefined);
      assert.equal(next.recoveryLifecycle.attempt?.phase, "settled");
      assert.equal(next.recoveryLifecycle.attempt?.caseId, next.recoveryLifecycle.active?.id);
      assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, paused.threadId), next.recoveryLifecycle);
      if (corruptCompletedAttempt) {
        const signature = next.recoveryLifecycle.attempt?.settledRef?.ref;
        assert.ok(signature);
        if (corruptCompletedAttempt === "invocation") {
          const marker = join(f.job.stateDir, "unknown-diagnostics", signature + ".started.json");
          const stored = JSON.parse(readFileSync(marker, "utf8"));
          writeFileSync(marker, JSON.stringify({ ...stored, invocationId: "forged-invocation" }) + "\n");
        } else {
          const sourceProof = next.recoveryLifecycle.decision?.evidence.at(-1);
          assert.equal(sourceProof?.store, "review-checkpoint",
            "Original diagnostic used the reviewed committed Foundation proof");
          const originalProof = join(f.job.stateDir, "foundation.json");
          const saved = JSON.parse(readFileSync(originalProof, "utf8"));
          writeFileSync(originalProof, JSON.stringify({ ...saved, authoredSha256: "0".repeat(64) }));
        }
        assert.equal((await inspectModernGenerationRecovery(f.job, saver, paused.threadId))?.inspectionFences.length, 1,
          "Read-only inspection rejects a forged invocation receipt");
        const restart = await createGenerationGraph(saver, "cli").invoke({ request: next.request }, config);
        assert.equal(restart.status, "blocked");
        assert.ok(restart.recoveryLifecycle.inspectionFences.length,
          "Direct production graph reentry must independently authenticate the sealed attempt");
      } else {
        const restart = await createGenerationGraph(saver, "cli").invoke({ request: next.request }, config);
        assert.deepEqual(restart.recoveryLifecycle.attempt, next.recoveryLifecycle.attempt);
      }
      assert.equal(transport.calls.length, 1); assert.equal((await inspectPiPolicy(f.job)).budget.modelCalls, 1);
    }
    if (refused === "exception-actionable" && next.recoveryLifecycle.active === null) {
      assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, paused.threadId),
        next.recoveryLifecycle,
        "C07 original independently reviewed Review transport recovery must survive restart");
    }
    assert.equal(git(f.repo, "rev-parse", "HEAD"), f.initial,
      "The author's original Story repository must not be rewritten");
    assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
    return { f, next, before, log };
  } finally {
    saver.db.close();
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("#240 original staged Event is authentically authored by a scripted Pi agent", {
  skip: !available, timeout: 120_000,
}, async () => {
  const f = setup("c03-original-pi-event");
  f.env.NT_ARCHITECTURE_FIXTURE_CASE = "decision-choice";
  f.env.NT_INTERACTIVE_FIXTURE_CASE = "two-choices";
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope = { kind: "full-story", depth: "composition", targets: [], branches: [] };
  writeFileSync(f.contract, JSON.stringify(contract));
  saveFixtureTurn(f.job, contract, f.start[3]!, [
    "Release and withhold must produce independently evidenced Choice consequences.",
  ]);
  assert.equal(f.cli([...f.start, "--pause-after", "foundation"]).status, "paused");
  await sealFixtureGenerationCheckpoint(f, "foundation");
  assert.equal(f.cli(["generate", "resume", "--pause-after", "architecture"]).status, "paused");
  await sealFixtureGenerationCheckpoint(f, "global-architecture");
  assert.match(f.cli(["foundations", "run", "--fixture", "--skills-source", source], false),
    /review|independent/i);
  await sealFixtureGenerationCheckpoint(f, "world-foundations");
  assert.equal(f.cli(["foundations", "run", "--fixture", "--skills-source", source]).status, "foundations-committed");
  await sealFixtureGenerationCheckpoint(f, "character-foundations");
  const saved = Object.fromEntries(["NT_STATE_DIR", "NT_CONFIG_FILE", "NT_SKILL_CACHE_DIR",
    "NT_SANDBOX_SOCKET", "NT_SANDBOX_TOKEN_FILE",
    "NT_ARCHITECTURE_FIXTURE_CASE"].map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    NT_STATE_DIR: f.env.NT_STATE_DIR,
    NT_CONFIG_FILE: f.env.NT_CONFIG_FILE,
    NT_SKILL_CACHE_DIR: f.env.NT_SKILL_CACHE_DIR,
    NT_ARCHITECTURE_FIXTURE_CASE: f.env.NT_ARCHITECTURE_FIXTURE_CASE,
  });
  const restoreSandbox = fixtureSandboxClient(f.job.jobId, f.job.worktreeStoryRoot);
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
          limits: "The release and withhold consequences still need Choice authorship" }],
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
    const { runtime, observed } = await scriptedStoryRuntime((index, context) => {
      if ([0, 2, 4].includes(index)) return {
        content: scriptedReadCalls(readSources, index), reason: "toolUse",
      };
      if (index === 1) return { content: scriptedText(plan), reason: "stop" };
      if (index === 3) return {
        content: scriptedText({ schema: "noveltea-milestone-blueprint-review/v5",
          status: "pass", findings: [], prior: [] }), reason: "stop",
      };
      if (index === 5) return { content: [{ type: "toolCall",
        id: "original-c03-event-authoring", name: "write",
        arguments: { path: "events/disclose-ledger.md", content: authored.replace("value: knows", "value: known") } }],
        reason: "toolUse" };
      if (index === 6 || index === 8) return {
        content: scriptedText({ modifiedRecords: ["events/disclose-ledger.md"],
          architecturalConflicts: [], laterObligations: [
            "Formal Choice Point binding must enact the protect and challenge outcomes for this Milestone before fulfillment.",
          ] }), reason: "stop",
      };
      if (index === 7) {
        assert.match(JSON.stringify(context.messages), /SOURCE-BOUND STORY CORRECTION/);
        return { content: [{ type: "toolCall", id: "r07-event-native-correction", name: "edit",
          arguments: { path: "events/disclose-ledger.md", edits: [
            { oldText: "value: known", newText: "value: knows" },
          ] } }], reason: "toolUse" };
      }
      index -= 2;
      const storyPaths = () => git(f.job.worktreeRoot, "ls-files", "--", "story/")
        .split("\n").filter(p => p.endsWith(".md")).map(p => p.slice("story/".length));
      if (index === 7) return {
        content: scriptedReadCalls([
          ...boundedPinnedSources("nt-event-design").map(path => "skill://" + path),
          ...storyPaths(),
        ], index), reason: "toolUse",
      };
      if (index === 8) return {
        content: [{
          type: "toolCall", id: "c03-original-approved-closeout", name: "edit",
          arguments: { path: "milestones/disclosure.md", edits: [
            { oldText: "completeness: partial", newText: "completeness: complete" },
            { oldText: "fulfillment: {any_of: []}",
              newText: "fulfillment:\n  any_of:\n    - [event.disclose-ledger]" },
          ] },
        }], reason: "toolUse",
      };
      if (index === 9) return {
        content: scriptedText({ verdict: "pass",
          evidence: ["milestones/disclosure.md:11", "events/disclose-ledger.md:25",
            "choice-points/loyalty.md:10"],
          reason: "The reviewed protect/challenge Choice produces reachable Event consequences and binds the existing Milestone." }),
        reason: "stop",
      };
      // A passed closeout can invalidate previously reviewed downstream
      // assumptions. Every affected dependent gets its OWN fresh independent
      // read-only reviewer; do not pre-seal or skip those later verdicts.
      if (index >= 10 && index < 60 && index % 2 === 0) return {
        content: scriptedReadCalls([
          ...boundedPinnedSources("nt-narrative-review").map(path => "skill://" + path),
          "skill://nt-catalog/references/glossary.md", ...storyPaths(),
        ], index), reason: "toolUse",
      };
      if (index >= 11 && index < 60 && index % 2 === 1) {
        const prompt = context.messages
          .filter((message): message is { role: "user"; content: Array<{ type?: string; text?: string }> } =>
            message && typeof message === "object" && "role" in message &&
            message.role === "user" && "content" in message && Array.isArray(message.content))
          .flatMap(message => message.content.map(p => p.text ?? ""))
          .findLast(message => message.includes("ASSIGNMENT:\n"));
        if (!prompt) throw Error("Independent reviewer did not receive its actual pinned source assignment.");
        const assignment = JSON.parse(prompt.slice(prompt.lastIndexOf("ASSIGNMENT:\n") +
          "ASSIGNMENT:\n".length)) as {
            specialistAssignments?: Array<{ authority: { existingPaths: string[] } }>;
            routes: Array<{ event: string; step: string; branch: string }>;
            milestoneRoutes: Array<{ milestone: string; alternative: number }>;
            puzzleRoutes: Array<{ puzzle: string; event: string }>;
          };
        const evidence = [
          ...(assignment.specialistAssignments ?? []).flatMap(a =>
            a.authority.existingPaths.map(path => path + ":11")),
          ...assignment.routes.map(r => r.event + "#" + r.step + "/" + r.branch +
            ": events/" + r.event.slice(6) + ".md:23"),
          ...assignment.milestoneRoutes.map(r => r.milestone + "#" + r.alternative +
            ": milestones/disclosure.md:11"),
          ...assignment.puzzleRoutes.map(r => r.puzzle + "/" + r.event +
            ": puzzles/ledger-proof.md:14"),
        ];
        return { content: scriptedText({ verdict: "pass", findings: [], evidence }),
          reason: "stop" };
      }
      throw Error("The original Pi Event/Closeout protocol exceeded its predetermined responses at call " +
        index + "; recent prompts: " + JSON.stringify(context.messages.slice(-2)).slice(0, 2300));
    });
    const receipt = await withJobModelRuntime(runtime, () =>
      runEventWorkItem({ story: f.story, job: "single", action: "run",
        milestone: "milestone.disclosure", fixture: false, skillsSource: source,
        provider: scriptedModel.provider, model: scriptedModel.id }));
    assert.equal(receipt.status, "event-cluster-committed", JSON.stringify(receipt));
    const event = JSON.parse(readFileSync(join(f.job.stateDir, "event-items/disclosure.json"), "utf8"));
    assert.equal(event.worker, "pi");
    assert.equal(event.validation.milestoneState, "partial-choice-pending");
    assert.equal(observed.length, 9, "Original bounded Blueprint and corrected Event Pi conversations actually settled");
    assert.equal(event.invocationProof.ordinal, 1);
    assert.ok(observed.some(call => call.tools.includes("write")));
    assert.match(git(f.job.worktreeRoot, "show", "-s", "--format=%B", "HEAD"),
      /NovelTea-Event-Consequence:/);
    assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
    await sealFixtureGenerationCheckpoint(f, "event-disclosure");
    const interactive = ["interactive", "run", "--milestone", "milestone.disclosure",
      "--fixture", "--skills-source", source];
    assert.match(f.cli(interactive, false), /review|independent/i);
    await sealFixtureGenerationCheckpoint(f, "interactive-choice-disclosure");
    const nextUnit = f.cli(interactive);
    assert.match(nextUnit.status, /interactive|committed|pending/i);
    const point = (await inspectRecoveryCheckpoints(f.job)).find(p =>
      p.workItem === "interactive-puzzle-disclosure");
    if (point?.semanticReview === "required-pending") {
      await sealFixtureGenerationCheckpoint(f, "interactive-puzzle-disclosure");
      assert.equal(f.cli(interactive).status, "interactive-slice-committed");
    }
    const { preflightCompositionBoundary } =
      await import("../src/cross-domain-prerequisite-controller.js");
    const turn = JSON.parse(readFileSync(join(f.job.stateDir, "turn-plan.json"), "utf8"));
    const arch = JSON.parse(readFileSync(join(f.job.stateDir, "architecture.json"), "utf8"));
    const decision = await preflightCompositionBoundary(f.job, {
      story: f.story, job: "single", contract, task: f.start[3]!, fixture: false,
      turnPlanDigest: turn.digest, skillsSource: source,
      provider: scriptedModel.provider, model: scriptedModel.id,
    }, "milestone.disclosure", arch.plan.version);
    assert.equal(decision.kind, "repair", JSON.stringify(decision));
    // Enter the ACTUAL persistent production graph from the reviewed canonical
    // source. No dummy correction/approval and no fake next-stage task.
    const saver = SqliteSaver.fromConnString(join(f.job.stateDir, "generation.sqlite"));
    try {
      const graph = createGenerationGraph(saver, "cli");
      const config = { configurable: { thread_id: f.job.threadId + ":generation" },
        recursionLimit: 10000 };
      const initial = (await graph.getState(config)).values;
      assert.ok(initial.request);
      // Carry forward ONLY independently sealed actual earlier stage commits.
      // The saved graph paused at Architecture while those later work items
      // were completed through their original domain CLIs.
      const sealed = await inspectRecoveryCheckpoints(f.job);
      const completedStages = [...initial.completedStages];
      for (const [item,stage,status] of [
        ["character-foundations", "foundations", "foundations-committed"],
        ["event-disclosure", "event", "event-cluster-committed"],
        ["interactive-puzzle-disclosure", "interactive", "interactive-slice-committed"],
      ] as const) {
        const point = sealed.find(p => p.workItem === item);
        assert.ok(point?.eligible && point.semanticReview === "passed",
          "Original independently reviewed stage is not available: " + item);
        completedStages.push({ stage, ...(stage === "foundations" ? {} :
          { milestone: "milestone.disclosure" }), status,
          headSha: point.commitSha, planVersion: point.planVersion ?? arch.plan.version });
      }
      await graph.updateState(config, {
        completedStages,
        request: { ...initial.request, fixture: false,
          provider: scriptedModel.provider, model: scriptedModel.id,
          turnPlanDigest: turn.digest },
        status: "running", reason: null, active: null, result: null,
        pauseAfter: null, planVersion: arch.plan.version,
      }, "schedule");
      const admitted = await graph.invoke(null, { ...config,
        interruptBefore: ["assess_recovery"] });
      assert.equal(admitted.recoveryLifecycle.active?.origin.operation,
        "dependency-amendment", JSON.stringify({
          status: admitted.status, reason: admitted.reason,
          active: admitted.active, inventory: admitted.inventory,
          recovery: admitted.recoveryLifecycle, crossDomainCloseout: admitted.crossDomainCloseout,
        }));
      assert.ok(admitted.crossDomainCloseout);
      assert.equal(admitted.recoveryLifecycle.attempt, null);
      assert.equal(admitted.active?.stage, "composition");
      const beforeSelectionCalls = observed.length;
      const selected = await graph.invoke(null, { ...config,
        interruptAfter: ["assess_recovery"] });
      assert.equal(selected.recoveryLifecycle.decision?.action, "plan-amendment",
        JSON.stringify({ status: selected.status, reason: selected.reason,
          decision: selected.recoveryLifecycle.decision,
          recovery: selected.recoveryLifecycle }));
      assert.equal(selected.recoveryLifecycle.decision?.adapter, "cross-domain-closeout");
      assert.equal(selected.recoveryLifecycle.assessorPending, true);
      assert.equal(selected.recoveryLifecycle.attempt, null);
      assert.equal(observed.length, beforeSelectionCalls,
        "Recovery selection must checkpoint without starting a model or writer");
      const corrected = await withJobModelRuntime(runtime, () =>
        graph.invoke(null, { ...config, interruptAfter: ["assess_recovery"] }));
      const partialFile = join(f.job.stateDir, "prerequisite-items/disclosure.json");
      const partialReceipt = existsSync(partialFile) ?
        JSON.parse(readFileSync(partialFile, "utf8")) : null;
      const dependentFile = partialReceipt?.commitSha && join(f.job.stateDir,
        "revalidation-items", partialReceipt.commitSha + ".json");
      const dependent = dependentFile && existsSync(dependentFile) ?
        JSON.parse(readFileSync(dependentFile, "utf8")) : null;
      assert.equal(corrected.status, "running", JSON.stringify({
        status: corrected.status, reason: corrected.reason,
        receipt: partialReceipt && {
          phase: partialReceipt.phase, failure: partialReceipt.failure,
          commitSha: partialReceipt.commitSha, review: partialReceipt.review,
          reviewerSessionFile: partialReceipt.reviewerSessionFile,
        }, dependent: dependent && {
          state: dependent.state, failure: dependent.failure,
          reviewing: dependent.reviewing, results: dependent.results?.map(
            (r: { itemId: string; status: string; verdict: unknown }) => ({
              itemId: r.itemId, status: r.status, verdict: r.verdict,
            })),
        }, modelCalls: observed.length,
        activeRecovery: corrected.recoveryLifecycle.active,
        decision: corrected.recoveryLifecycle.decision,
      }));
      assert.equal(corrected.recoveryLifecycle.active, null);
      assert.equal(corrected.recoveryLifecycle.phase, "idle",
        "The original active case resolves after independently passed correction");
      assert.equal(corrected.recoveryLifecycle.pending.length, 0);
      const successor = git(f.job.worktreeRoot, "rev-parse", "HEAD");
      assert.notEqual(successor, decision.proposal.sourceSha);
      const closeout = JSON.parse(readFileSync(join(f.job.stateDir,
        "prerequisite-items/disclosure.json"), "utf8"));
      assert.equal(closeout.phase, "verified");
      assert.equal(closeout.review?.verdict, "pass");
      assert.equal(closeout.commitSha, successor);
      const revalidation = JSON.parse(readFileSync(join(f.job.stateDir,
        "revalidation-items", successor + ".json"), "utf8"));
      assert.equal(revalidation.state, "completed");
      assert.ok(revalidation.results.length >= 2,
        "Both the original Foundation and Interactive dependents require separate revalidation");
      assert.equal(new Set(revalidation.results.map((entry: { sessionFile: string }) =>
        entry.sessionFile)).size, revalidation.results.length,
      "Each independently sealed dependent verdict must own a distinct immutable Pi transcript");
      for (const item of revalidation.results as Array<{
        status: string; sessionFile: string; sessionDigest: string;
      }>) {
        assert.equal(item.status, "passed");
        assert.equal(createHash("sha256").update(readFileSync(item.sessionFile)).digest("hex"),
          item.sessionDigest, "An independently sealed dependent transcript must not change later");
      }
      assert.equal(corrected.recoveryLifecycle.discharged.at(-1)?.disposition,
        "active-verified", "C07 keeps the original resolved case and reviewed successor in one lifecycle");
      assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, config.configurable.thread_id),
        corrected.recoveryLifecycle,
        "C07 restart must reauthenticate the writer, independent Review and every dependent transcript");
      assert.ok(observed.length >= beforeSelectionCalls + 7 &&
        (observed.length - beforeSelectionCalls - 5) % 2 === 0,
        "One bounded writer, its independent reviewer and fresh read-only affected-dependent reviews must settle");
      const afterCorrectionCalls = observed.length;
      const beforeReplayBudget = (await inspectPiPolicy(f.job)).budget.modelCalls;
      // Emulate a process dying after the original Event owner's commit,
      // independent Review and dependent revalidation were published but
      // before the parent assessor checkpoint became durable. Reapply ONLY
      // the previously persisted selected graph state: receipts/Git remain
      // authoritative, and replay must not dispatch a replacement writer.
      await graph.updateState(config, selected, "assess_recovery");
      assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver,
        config.configurable.thread_id), selected.recoveryLifecycle,
        "The original selected case must remain admissible after its verified Git successor");
      const replayed = await withJobModelRuntime(runtime, () => graph.invoke(null, {
        ...config, interruptAfter: ["assess_recovery"],
      }));
      assert.equal(replayed.status, "running", replayed.reason ?? undefined);
      assert.equal(replayed.recoveryLifecycle.active, null);
      assert.deepEqual(replayed.recoveryLifecycle.discharged,
        corrected.recoveryLifecycle.discharged,
        "Replayed correction must record the same single original disposition");
      assert.equal(observed.length, afterCorrectionCalls,
        "Crash replay must not repeat the corrective writer or any Pi reviewer");
      assert.equal((await inspectPiPolicy(f.job)).budget.modelCalls, beforeReplayBudget,
        "Crash replay must not double-meter the same original corrective Pi invocation");
      assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), successor,
        "Crash replay must not create a duplicate Git commit");
      const reentered = await graph.invoke(null, { ...config,
        interruptBefore: ["specialist_dispatch"] });
      assert.equal(reentered.active?.stage, "composition", JSON.stringify({
        status: reentered.status, reason: reentered.reason,
        active: reentered.active, inventory: reentered.inventory?.items
          ?.map((item: { id: string; status: string; blockingReason?: string }) => ({
            id: item.id, status: item.status, reason: item.blockingReason,
          })),
      }));
      assert.equal(reentered.active?.milestone, "milestone.disclosure");
      assert.equal(reentered.status, "running", JSON.stringify({
        status: reentered.status, reason: reentered.reason,
        recovery: reentered.recoveryLifecycle, active: reentered.active,
        operationRecovery: reentered.operationRecovery,
      }));
      assert.equal(observed.length, afterCorrectionCalls,
        "Graph reentry cannot replay the original closeout writer or its independent reviewer");
      assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), successor);
    } finally { saver.db.close(); }
  } finally {
    restoreSandbox();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("#240 production closeout cannot promote a fixture Event to a Pi-owned review grant", {
  skip: !available, timeout: 120_000,
}, async () => {
  const f = setup("c03-closeout-full-graph");
  f.env.NT_EVENT_FIXTURE_CASE = "decision-pending";
  f.env.NT_INTERACTIVE_FIXTURE_CASE = "two-choices";
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope = { kind: "full-story", depth: "composition", targets: [], branches: [] };
  writeFileSync(f.contract, JSON.stringify(contract));
  saveFixtureTurn(f.job, contract, f.start[3]!,
    ["Retain original Event decisions and close Milestone only after authored Choice outcomes."]);
  assert.equal(f.cli([...f.start, "--pause-after", "foundation"]).status, "paused");
  await sealFixtureGenerationCheckpoint(f, "foundation");
  assert.equal(f.cli(["generate", "resume", "--pause-after", "architecture"]).status, "paused");
  await sealFixtureGenerationCheckpoint(f, "global-architecture");
  assert.match(f.cli(["foundations", "run", "--fixture", "--skills-source", source], false),
    /review|independent/i);
  await sealFixtureGenerationCheckpoint(f, "world-foundations");
  assert.equal(f.cli(["foundations", "run", "--fixture", "--skills-source", source]).status, "foundations-committed");
  await sealFixtureGenerationCheckpoint(f, "character-foundations");
  const eventStop = f.cli(["generate", "resume", "--pause-after", "event"]);
  assert.equal(eventStop.status, "paused", JSON.stringify(eventStop));
  await sealFixtureGenerationCheckpoint(f, "event-disclosure");
  const handoff = f.cli(["generate", "resume", "--pause-after", "interactive"]);
  assert.equal(handoff.status, "blocked");
  assert.match(handoff.reason, /separately sealed independent semantic Review/);
  assert.notEqual(handoff.operationRecovery?.operation, "specialist-result",
    "A legitimate fixture Review handoff cannot be recast as a failed writer");
  const interactive = ["interactive", "run", "--milestone", "milestone.disclosure",
    "--fixture", "--skills-source", source];
  assert.match(f.cli(interactive, false), /review|independent/i);
  await sealFixtureGenerationCheckpoint(f, "interactive-choice-disclosure");
  const continued = f.cli(["generate", "resume", "--pause-after", "interactive"]);
  assert.notEqual(continued.operationRecovery?.operation, "specialist-result",
    "A sealed Choice review must reenter the original unfinished Puzzle, not fence recovery");
  const puzzlePoint = (await inspectRecoveryCheckpoints(f.job))
    .find(point => point.workItem === "interactive-puzzle-disclosure");
  assert.ok(puzzlePoint, JSON.stringify({
    status: continued.status, reason: continued.reason,
    nextStage: continued.nextStage, operationRecovery: continued.operationRecovery,
  }));
  if (puzzlePoint?.semanticReview === "required-pending") {
    await sealFixtureGenerationCheckpoint(f, "interactive-puzzle-disclosure");
    const resumed = f.cli(["generate", "resume", "--pause-after", "composition"]);
    assert.notEqual(resumed.operationRecovery?.operation, "specialist-result",
      "Sealed Puzzle review must not manufacture another recovery or replay Choice");
    assert.ok(resumed.status === "paused" || resumed.status === "blocked");
  }
  const { preflightCompositionBoundary } =
    await import("../src/cross-domain-prerequisite-controller.js");
  const eventFile = join(f.job.stateDir, "event-items/disclosure.json");
  const event = JSON.parse(readFileSync(eventFile, "utf8"));
  assert.equal(event.validation.milestoneState, "partial-choice-pending");
  const turn = JSON.parse(readFileSync(join(f.job.stateDir, "turn-plan.json"), "utf8"));
  const before = await inspectRecoveryCheckpoints(f.job);
  const eventCheckpoint = before.find(point => point.workItem === "event-disclosure");
  assert.ok(eventCheckpoint?.eligible && eventCheckpoint.semanticReview === "passed");
  assert.equal(eventCheckpoint.assurance?.turnDigest, turn.digest);
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  // A structural fixture's independently sealed original checkpoint cannot
  // become a production-Pi Event merely by changing its saved worker field.
  writeFileSync(eventFile, JSON.stringify({ ...event, worker: "pi" }));
  const boundary = await preflightCompositionBoundary(f.job, {
    story: f.story, job: "single", contract, task: f.start[3]!, fixture: false,
    turnPlanDigest: turn.digest, skillsSource: source,
  }, "milestone.disclosure", event.planVersion);
  assert.equal(boundary.kind, "refuse", JSON.stringify(boundary));
  assert.match(boundary.reason, /independently reviewed|Turn-bound|checkpoint/);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
  assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
  const after = await inspectRecoveryCheckpoints(f.job);
  assert.equal(after.some(point => point.workItem === "event-disclosure" &&
    point.eligible && point.semanticReview === "passed"), false,
  "Changing the worker invalidates the original independently sealed Event checkpoint");
});

test("R09 production graph authenticates exhausted idea selection without replay", {
  skip: !available, timeout: 100_000,
}, async () => {
  const f = setup("r09-idea-protocol");
  captureRecoveryIdea(f, "r09-bell");
  const paused = f.cli([...f.start, "--pause-after", "event"]);
  assert.equal(paused.status, "paused");
  saveFixtureTurn(f.job, JSON.parse(readFileSync(f.contract, "utf8")), f.start[3]!,
    ["Retain the original approved scope."]);
  const turnDigest = JSON.parse(readFileSync(join(f.job.stateDir, "turn-plan.json"), "utf8")).digest;
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const task = f.cli(["ideas", "plan"]).tasks.find((entry: any) => entry.id === "r09-bell");
  assert.ok(task?.candidates?.length);
  const previous = Object.fromEntries(Object.keys(f.env).map(key => [key, process.env[key]]));
  Object.assign(process.env, f.env);
  const saver = SqliteSaver.fromConnString(paused.checkpointPath);
  const restore = fixtureSandboxClient(f.job.jobId, f.job.worktreeStoryRoot);
  try {
    const scripted = await scriptedStoryRuntime((index, context) => {
      if (index === 0) {
        const messages = context.messages as Array<{role: string; content: unknown}>;
        const decoded = messages.filter(m => m.role === "user").map(m => JSON.stringify(m.content))
          .join("\n").replaceAll("\\n", "\n");
        const paths = decoded.split("READ ALL EXACT FILE PATHS FIRST:\n")[1]!
          .split("\nRead-only independent semantic assessment")[0]!.split("\n");
        return { content: scriptedReadCalls(paths, index), reason: "toolUse" };
      }
      assert.ok(index <= 3, "must not dispatch a replacement planner or writer");
      return { content: scriptedText("{not JSON"), reason: "stop" };
    });
    const graph = createGenerationGraph(saver, "cli");
    const cfg = { configurable: { thread_id: paused.threadId } };
    const values = (await graph.getState(cfg)).values;
    await graph.updateState(cfg, {
      request: { ...values.request, fixture: false, turnPlanDigest: turnDigest,
        provider: scriptedModel.provider, model: scriptedModel.id },
      status: "running", active: null, result: null, ideaResult: null,
      ideaTask: { id: task.id, action: "place", signature: task.signature, priorHead: head },
      escalation: null, causalAmendment: null, pauseAfter: null,
    }, "author_update_intake");
    const admitted = await withJobModelRuntime(scripted.runtime,
      () => graph.invoke(null, { ...cfg, interruptBefore: ["assess_recovery"] }));
    assert.equal(admitted.recoveryLifecycle.active?.origin.operation, "idea-integration",
      JSON.stringify({ status: admitted.status, reason: admitted.reason, recovery: admitted.recoveryLifecycle }));
    assert.equal(admitted.recoveryLifecycle.active?.kind, "protocol");
    const stopped = await graph.invoke(null, cfg);
    assert.equal(stopped.status, "blocked");
    assert.equal(stopped.recoveryLifecycle.decision?.action, "exhausted");
    assert.equal(scripted.calls(), 4);
    assert.deepEqual(scripted.observed[2]!.tools, []);
    assert.deepEqual(scripted.observed[3]!.tools, []);
    assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, paused.threadId), stopped.recoveryLifecycle);
    const restarted = await graph.invoke({ request: stopped.request }, cfg);
    assert.equal(restarted.recoveryLifecycle.decision?.action, "exhausted");
    assert.equal(scripted.calls(), 4);
    assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
    assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
  } finally {
    restore();
    saver.db.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("C03 production graph diagnoses a source-authenticated unknown scheduling exception once", {
  skip: !available, timeout: 100_000,
}, async () => {
  const f = setup("c03-source-bound-scheduling");
  captureRecoveryIdea(f, "c03-pending-idea");
  const paused = f.cli([...f.start, "--pause-after", "event"]);
  assert.equal(paused.status, "paused");
  saveFixtureTurn(f.job, JSON.parse(readFileSync(f.contract, "utf8")), f.start[3]!,
    ["Retain the original schedule and resolve all previously authorized work."]);
  const turnDigest = JSON.parse(readFileSync(join(f.job.stateDir, "turn-plan.json"), "utf8")).digest;
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  writeFileSync(join(f.job.stateDir, "idea-placement-tasks.json"),
    JSON.stringify({ version: 999, jobId: "single", history: [] }));
  const previous = Object.fromEntries(Object.keys(f.env).map(key => [key, process.env[key]]));
  Object.assign(process.env, f.env);
  const saver = SqliteSaver.fromConnString(paused.checkpointPath);
  try {
    const transport = await (await import("./scripted-recovery-model.js")).scriptedRecoveryModel();
    await (await import("../src/job-pi-policy.js")).configurePiPolicy(f.job, { version: 1,
      profile: { provider: transport.model.provider, model: transport.model.id },
      limits: { modelCalls: 2 } });
    const graph = createGenerationGraph(saver, "cli");
    const cfg = { configurable: { thread_id: paused.threadId } };
    const values = (await graph.getState(cfg)).values;
    await graph.updateState(cfg, {
      request: { ...values.request, fixture: false, turnPlanDigest: turnDigest,
        provider: undefined, model: undefined },
      status: "running", active: null, result: null, ideaTask: null,
      escalation: null, causalAmendment: null, pauseAfter: null,
    }, "schedule");
    const admitted = await graph.invoke(null, { ...cfg, interruptBefore: ["assess_recovery"] });
    assert.equal(admitted.recoveryLifecycle.active?.origin.operation, "scheduling",
      JSON.stringify({ status: admitted.status, reason: admitted.reason,
        recovery: admitted.recoveryLifecycle.active, inventory: admitted.inventory,
      }));
    assert.equal(admitted.recoveryLifecycle.active?.observation, "exception");
    assert.equal(admitted.recoveryLifecycle.attempt, null);
    const selected = await graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] });
    assert.equal(selected.recoveryLifecycle.decision?.action, "diagnostic",
      JSON.stringify({ status: selected.status, reason: selected.reason,
        recovery: selected.recoveryLifecycle, inventory: selected.inventory,
      }));
    assert.equal(selected.recoveryLifecycle.decision?.evidence.at(-1)?.store, "graph-checkpoint");
    assert.equal(selected.recoveryLifecycle.assessorPending, true);
    assert.equal(transport.calls.length, 0);
    const completed = await (await import("../src/model-runtime.js")).withJobModelRuntime(transport.rt,
      () => graph.invoke(null, cfg));
    assert.equal(completed.recoveryLifecycle.decision?.action, "diagnostic-stop",
      JSON.stringify({ status: completed.status, reason: completed.reason, lifecycle: completed.recoveryLifecycle }));
    assert.equal(completed.recoveryLifecycle.attempt?.phase, "settled");
    assert.equal(transport.calls.length, 1);
    assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, paused.threadId),
      completed.recoveryLifecycle);
    const restarted = await graph.invoke({ request: completed.request }, cfg);
    assert.equal(restarted.status, "blocked");
    assert.equal(restarted.recoveryLifecycle.decision?.action, "diagnostic-stop");
    assert.equal(transport.calls.length, 1);
    // The sealed diagnosis binds the original inventory as well as the failed
    // graph task. Neither changing an unrelated item nor replaying the saved
    // model opinion may silently reauthenticate a new scheduling case.
    await graph.updateState(cfg, { inventory: {
      ...restarted.inventory, items: [...restarted.inventory.items,
        { ...restarted.inventory.items[0], id: "forged-new-composition-item" }],
    } }, "schedule");
    const tampered = await inspectModernGenerationRecovery(f.job, saver, paused.threadId);
    assert.equal(tampered?.phase, "fenced");
    assert.equal(tampered?.inspectionFences.length, 1);
    assert.equal(transport.calls.length, 1);
    assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
    assert.equal(git(f.job.worktreeRoot, "status", "--porcelain", "--untracked-files=all"), "");
  } finally {
    saver.db.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

for (const live of [false, true] as const)
test(live
  ? "C08 opt-in real Pi scheduling diagnosis settles its original attempt, verifies and resumes the original Thread"
  : "C05 unfamiliar scheduling failure is resolved by source-bound recheck and resumes generation", {
  skip: !available || (live && process.env.NT_LIVE_RECOVERY_C08 !== "1"),
  timeout: live ? 300_000 : 100_000,
}, async () => {
  const f = setup(live ? "c08-live-recovery-reconciliation" : "c05-source-bound-reconciliation");
  captureRecoveryIdea(f, "c05-transient-idea");
  const paused = f.cli([...f.start, "--pause-after", "event"]);
  assert.equal(paused.status, "paused");
  saveFixtureTurn(f.job, JSON.parse(readFileSync(f.contract, "utf8")), f.start[3]!,
    ["Preserve existing verified checkpoints and reconcile any transient scheduler failure."]);
  const turn = JSON.parse(readFileSync(join(f.job.stateDir, "turn-plan.json"), "utf8"));
  const digest = turn.digest;
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const tasksFile = join(f.job.stateDir, "idea-placement-tasks.json");
  const originalTasks = existsSync(tasksFile) ? readFileSync(tasksFile) : null;
  writeFileSync(tasksFile, JSON.stringify({ version: 999, jobId: "single", history: [] }));
  const previous = Object.fromEntries(Object.keys(f.env).map(key => [key, process.env[key]]));
  Object.assign(process.env, f.env);
  const saver = SqliteSaver.fromConnString(paused.checkpointPath);
  const restoreSandbox = live ? () => {} : fixtureSandboxClient(f.job.jobId, f.job.worktreeStoryRoot);
  try {
    // Build the actual current-format planner proof for the disposable
    // fixture's original Turn before injecting the scheduler failure.
    const transport = live ? null : await scriptedStoryRuntime((index, context) => {
      if (index === 0) return { content: scriptedReadCalls(requiredOrchestratorSkillReads("autonomous")
        .map(path => "skill://" + path), 0), reason: "toolUse" };
      if (index === 1) return { content: scriptedText({ sourceSha: f.job.baseSha,
        turnDigest: digest, assignments: turn.assignments.map((a: { id: string }) => ({
          id: a.id, reason: "Perform the source-bound author objective." })) }), reason: "stop" };
      assert.equal(index, 2, "No additional diagnostic invocation is authorized");
      const serialized = JSON.stringify(context.messages);
      const signature = serialized.match(/signature=([0-9a-f]{64})/)?.[1];
      const sourceRef = serialized.match(/sourceRef=([^;]+); category=/)?.[1];
      assert.ok(signature && sourceRef);
      return { content: scriptedText({ schema: "noveltea-recovery-diagnostic-proposal/v1",
        signature, sourceRef, category: "infrastructure",
        diagnosis: "The original read-only operation should reconcile against sealed receipts.",
        strategy: "reconcile-original", owner: null, scopeRef: null, prerequisites: [],
        uncertainty: "No authenticated writer scope for this failure." }), reason: "stop" };
    });
    const provider = live ? (process.env.NT_RECOVERY_PI_PROVIDER ?? "openai-codex") : scriptedModel.provider;
    const model = live ? (process.env.NT_RECOVERY_PI_MODEL ?? "gpt-6-luna") : scriptedModel.id;
    await (await import("../src/job-pi-policy.js")).configurePiPolicy(f.job, { version: 1,
      profile: { provider, model }, limits: { modelCalls: 12 } });
    const runtime = transport?.runtime ?? await (await import("../src/model-runtime.js")).createJobModelRuntime();
    unlinkSync(join(f.job.stateDir, "orchestrator-selection.json"));
    const selection = await selectStoryOrchestrator(f.job, paused.threadId,
      { task: f.start[3]!, kind: turn.contract.scope.kind, turnPlanDigest: digest }, source);
    const { runPinnedObjectivePlanner } = await import("../src/orchestrator-planner.js");
    const planning = await withJobModelRuntime(runtime,
      () => runPinnedObjectivePlanner(f.job, selection, turn, provider, model));
    const priorCalls = (await inspectPiPolicy(f.job)).budget.modelCalls;
    const graph = createGenerationGraph(saver, "cli");
    const cfg = { configurable: { thread_id: paused.threadId } };
    const values = (await graph.getState(cfg)).values;
    await graph.updateState(cfg, {
      request: { ...values.request, fixture: false, turnPlanDigest: digest,
        provider: undefined, model: undefined },
      orchestratorSnapshotId: selection.receipt.skillSnapshot.id,
      orchestratorOrder: planning.proposal!.assignments.map(a => a.id),
      orchestratorPlanningDigest: planning.digest,
      status: "running", active: null, result: null, ideaTask: null,
      escalation: null, causalAmendment: null, pauseAfter: null,
    }, "schedule");
    const admitted = await graph.invoke(null, { ...cfg, interruptBefore: ["assess_recovery"] });
    assert.equal(admitted.recoveryLifecycle.active?.origin.operation, "scheduling");
    const selected = await graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] });
    assert.equal(selected.recoveryLifecycle.decision?.action, "diagnostic");
    const proposed = await withJobModelRuntime(runtime,
      () => graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] }));
    assert.equal(proposed.recoveryLifecycle.attempt?.phase, "settled",
      "Only a real settled external Pi invocation, not a selected intent, qualifies");
    if (live) {
      const attempt = proposed.recoveryLifecycle.attempt!;
      assert.equal(attempt.purpose, "diagnosis");
      assert.equal(attempt.mode, "read-only");
      assert.equal(attempt.startedRef?.store, "pi-session");
      assert.equal(attempt.settledRef?.store, "response-contract");
      assert.equal((await inspectPiPolicy(f.job)).budget.modelCalls, priorCalls + 1,
        "One real diagnosis response must be metered exactly once");
    }
    assert.equal(proposed.recoveryLifecycle.decision?.action, "reconcile-effects",
      JSON.stringify({ status: proposed.status, reason: proposed.reason, lifecycle: proposed.recoveryLifecycle }));
    assert.equal(proposed.recoveryLifecycle.assessorPending, true);
    if (transport) assert.equal(transport.calls(), 3);
    assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, paused.threadId),
      proposed.recoveryLifecycle);

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
    if (transport) assert.equal(transport.calls(), 3);
    else assert.equal((await inspectPiPolicy(f.job)).budget.modelCalls, priorCalls + 1,
      "Read-only independent recheck must not consume another external Pi call");
    assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head,
      "Neither the diagnosis nor original read-only reconciliation can commit");
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

test("C03 production graph sends an authenticated settled Event no-write to one actual read-only Pi diagnosis", {
  skip: !available,
}, async () => {
  const f = setup("c03-event-no-write-assessor");
  f.env.NT_EVENT_FIXTURE_CASE = "no-write-protected";
  const blocked = f.cli(f.start);
  assert.equal(blocked.status, "blocked");
  const file = join(f.job.stateDir, "event-items/disclosure.json");
  const original = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(original.phase, "prerequisite-reported");
  assert.equal(original.worker, "fixture");
  assert.equal(original.reroutedFrom, undefined);
  const active = blocked.inventory.items.find((x: { id: string }) =>
    x.id === "event:milestone.disclosure");
  assert.ok(active);
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  assert.equal(blocked.inventory.headSha, head);

  // Convert only the deterministic Event transport into a signed Pi-format
  // original session. The original real graph, receipt verifier and the
  // diagnostic Pi transport execute normally; no second Event writer exists.
  const directory = join(f.job.stateDir, "event-sessions", "event-disclosure");
  mkdirSync(directory, { recursive: true });
  const sessionFile = join(directory, "no-write.jsonl");
  const sessionId = "c03-event-no-write-session";
  const transcript = JSON.stringify({ type: "session", id: sessionId }) + "\n" +
    JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "stop",
      content: [{ type: "text", text: "No in-scope Event write is authorized." }] } }) + "\n";
  writeFileSync(sessionFile, transcript);
  const digest = createHash("sha256").update(transcript).digest("hex");
  const assignmentDigest = createHash("sha256")
    .update(JSON.stringify(original.assignment)).digest("hex");
  // The fixture's original protected request is NOT diagnosable. Substitute
  // a separately source-signed, nonprotected semantic no-write to exercise
  // the genuine unknown-strategy lane, not to bypass author approval.
  const conflicts = ["Canonical continuity cannot be established from the current sources."];
  const obligations: string[] = [];
  const payload = { jobId: original.jobId, workItemId: original.workItemId,
    expectedHead: original.expectedHead, planDigest: original.planDigest,
    sessionSha256: digest, sessionId, assignmentDigest, snapshotId: original.snapshot.id,
    sessionFile, worker: "pi" as const, conflicts, obligations,
    ...(original.causalDiscovery ? { causalDiscovery: original.causalDiscovery } : {}) };
  const reportDigest = eventPrerequisiteReportDigest(payload);
  const revised = { ...original, worker: "pi", sessionFile, conflicts, obligations,
    prerequisite: { expectedHead: original.expectedHead,
      sessionSha256: digest, sessionId, assignmentDigest,
      snapshotId: original.snapshot.id, sessionFile, worker: "pi", reportDigest } };
  writeFileSync(file, JSON.stringify(revised, null, 2) + "\n");
  saveFixtureTurn(f.job, JSON.parse(readFileSync(f.contract, "utf8")), f.start[3]!,
    ["The original source and its unresolved continuity obligation must remain unchanged."]);
  const turnDigest = JSON.parse(readFileSync(join(f.job.stateDir, "turn-plan.json"), "utf8")).digest;
  const previous = Object.fromEntries(Object.keys(f.env).map(key => [key, process.env[key]]));
  Object.assign(process.env, f.env);
  const saver = SqliteSaver.fromConnString(blocked.checkpointPath);
  try {
    const transport = await (await import("./scripted-recovery-model.js")).scriptedRecoveryModel();
    await (await import("../src/job-pi-policy.js")).configurePiPolicy(f.job, { version: 1,
      profile: { provider: transport.model.provider, model: transport.model.id },
      limits: { modelCalls: 2 } });
    const graph = createGenerationGraph(saver, "cli");
    const cfg = { configurable: { thread_id: blocked.threadId } };
    const values = (await graph.getState(cfg)).values;
    await graph.updateState(cfg, { request: { ...values.request,
      fixture: false, turnPlanDigest: turnDigest, provider: undefined, model: undefined },
      status: "running", active, result: null, failures: {}, escalation: null,
      causalAmendment: null, pauseAfter: null }, "author_update_intake");
    const admitted = await graph.invoke(null, { ...cfg, interruptBefore: ["assess_recovery"] });
    assert.equal(admitted.recoveryLifecycle.active?.origin.operation, "specialist-result");
    assert.equal(admitted.recoveryLifecycle.active?.observation, "returned-failure");
    assert.equal(admitted.recoveryLifecycle.attempt, null);
    assert.equal(admitted.recoveryLifecycle.phase, "assessing");
    const selected = await graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] });
    assert.equal(selected.recoveryLifecycle.decision?.action, "diagnostic",
      JSON.stringify({ case: selected.recoveryLifecycle.active, source: selected.recoverySources,
        inventory: selected.inventory, failures: selected.failures,
        causalAmendment: selected.causalAmendment, receipt: revised }, null, 2));
    assert.equal(selected.recoveryLifecycle.decision?.evidence.at(-1)?.digest, reportDigest);
    assert.equal(selected.recoveryLifecycle.assessorPending, true);
    assert.equal(transport.calls.length, 0, "A checkpointed decision is not a model call");
    const completed = await (await import("../src/model-runtime.js")).withJobModelRuntime(transport.rt,
      () => graph.invoke(null, cfg));
    assert.equal(completed.recoveryLifecycle.decision?.action, "diagnostic-stop");
    assert.equal(completed.recoveryLifecycle.attempt?.phase, "settled");
    assert.equal(transport.calls.length, 1);
    assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, blocked.threadId),
      completed.recoveryLifecycle);
    const restarted = await graph.invoke({ request: completed.request }, cfg);
    assert.equal(restarted.status, "blocked");
    assert.equal(restarted.recoveryLifecycle.decision?.action, "diagnostic-stop");
    assert.equal(transport.calls.length, 1, "No second Pi session or Event dispatch on restart");
    writeFileSync(file, JSON.stringify({ ...revised, prerequisite: {
      ...revised.prerequisite, reportDigest: "f".repeat(64),
    } }, null, 2) + "\n");
    const inspected = await inspectModernGenerationRecovery(f.job, saver, blocked.threadId);
    assert.equal(inspected?.inspectionFences.length, 1,
      "Saved settled diagnostic requires the immutable ORIGINAL Event no-write source");
    const tamperedRestart = await graph.invoke({ request: completed.request }, cfg);
    assert.equal(tamperedRestart.status, "blocked");
    assert.ok(tamperedRestart.recoveryLifecycle.inspectionFences.length);
    assert.equal(transport.calls.length, 1, "Changed original Event proof cannot start another diagnosis");
    assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
    assert.equal(git(f.job.worktreeRoot, "status", "--porcelain", "--untracked-files=all"), "");
  } finally {
    saver.db.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("generation start and read-only inspect preserve invalid corrective evidence without replay", {
  skip: !available,
}, async () => {
  const f = setup("correction-inspect-unsafe");
  saveFixtureTurn(f.job, JSON.parse(readFileSync(f.contract, "utf8")), f.start[3]!,
    ["Retain the original archive witness obligation during independent review."]);
  const paused = f.cli([...f.start, "--pause-after", "foundation"]);
  assert.equal(paused.status, "paused");
  const previous = Object.fromEntries(Object.keys(f.env).map(key => [key, process.env[key]]));
  Object.assign(process.env, f.env);
  let sourceSha: string;
  try {
    const job = await startStoryJob({ story: f.story, job: "single" }, false);
    const checkpoints = await inspectRecoveryCheckpoints(job);
    const point = checkpoints.find(item => item.eligible && item.workItem === "foundation");
    assert.ok(point?.assurance, JSON.stringify({
      checkpoints: checkpoints.map(item => ({
        workItem: item.workItem, eligible: item.eligible, reason: item.reason,
        review: item.semanticReview,
      })), completed: paused.completedStages, status: paused.status,
    }));
    sourceSha = point.commitSha;
    await reviewBoundedAssignments(job, [point], async packet => {
      const item = packet.items[0]!;
      const path = item.assurance.changedPaths[0]!;
      return { sourceDigest: packet.sourceDigest, verdict: "fail" as const,
        findings: [{
          commitSha: item.assurance.commitSha, assignmentId: item.assignment.id,
          path, line: 1, kind: "missing-requirement" as const,
          message: "The original premise lacks a causal witness.",
          requiredCorrection: "Establish a specific witness in the existing Foundation.",
          affectedPaths: [path],
        }], evidence: [] };
    }, "deterministic-negative-review-fixture", true);
    assert.equal((await inspectRecoveryCheckpoints(job)).find(item =>
      item.commitSha === sourceSha)?.semanticReview, "failed");
    const receiptDir = join(job.stateDir, "review-repairs");
    mkdirSync(receiptDir, { recursive: true });
    // A plausible phase is not evidence. A missing/invalid sealed source must
    // surface an integrity blocker; inspection must never invoke the writer.
    writeFileSync(join(receiptDir, sourceSha + ".json"), JSON.stringify({
      version: 1, jobId: job.jobId, threadId: job.threadId,
      sourceCommitSha: sourceSha, phase: "prepared", attempts: 0,
    }));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const first = f.cli(["generate", "inspect"]);
  assert.equal(first.correctiveAssignment?.sourceCommitSha, sourceSha!);
  assert.equal(first.correctiveAssignment?.phase, "integrity-blocked");
  const second = f.cli(["generate", "inspect"]);
  assert.deepEqual(second.correctiveAssignment, first.correctiveAssignment);
  for (let restart = 0; restart < 2; restart++) {
    const resumed = f.cli(["generate", "resume", "--pause-after", "foundation"]);
    assert.notEqual(resumed.status, "completed", "Invalid correction evidence cannot complete the Turn");
    assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head,
      "A restart must not create a replacement correction commit");
  }
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
  assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.initial);
});

test("production generation graph routes bounded correction, independent review and next specialist without replay", {
  skip: !available,
}, async () => {
  const { f, next, before, log } = await runFixtureRecoveryGraph("repair-graph-success", false);
  assert.deepEqual(log, [
    "original-session-correction", "native-validation", "correction-proof-publication",
    "fresh-independent-review", "independent-verdict",
  ]);
  assert.equal(next.status, "paused", JSON.stringify(next));
  assert.deepEqual(next.completedStages.map((stage: { stage: string }) => stage.stage),
    ["foundation", "architecture"], "Graph must dispatch subsequent authorized work");
  assert.notEqual(git(f.job.worktreeRoot, "rev-parse", "HEAD"), before,
    "Subsequent specialist makes its own distinct fixture commit");
  assert.equal(next.completedStages[0]?.headSha, before,
    "Original completed Foundation is carried forward, not written again");
});

test("production generation graph refuses another owner's recovery without advancing work", {
  skip: !available,
}, async () => {
  const { f, next, before, log } = await runFixtureRecoveryGraph("repair-graph-refusal", true);
  assert.deepEqual(log, ["refuse-other-owner-write"]);
  assert.equal(next.status, "blocked");
  assert.equal(next.escalation?.kind, "dependency-replan");
  assert.match(next.reason!, /Outside original specialist authority/);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), before,
    "No unauthorized source mutation or downstream dispatch is allowed");
  assert.deepEqual(next.completedStages, []);
});

test("C03 production Review steering handoff is routed by a checkpointed flag, never the reason string", {
  skip: !available,
}, async () => {
  const f = setup("c03-typed-review-steering");
  saveFixtureTurn(f.job, JSON.parse(readFileSync(f.contract, "utf8")), f.start[3]!,
    ["Keep the original approved Story objective while processing live author steering."]);
  const paused = f.cli([...f.start, "--pause-after", "foundation"]);
  assert.equal(paused.status, "paused");
  await sealFixtureGenerationCheckpoint(f, "foundation");
  const foundation = paused.inventory.items.find((item: { id: string }) => item.id === "foundation");
  assert.ok(foundation);
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const before = Object.fromEntries(Object.keys(f.env).map(key => [key, process.env[key]]));
  Object.assign(process.env, f.env);
  const saver = SqliteSaver.fromConnString(paused.checkpointPath);
  try {
    const graph = createGenerationGraph(saver, "cli", async s => ({
      reviewSteeringHandoff: true,
      reason: "An arbitrary display message that is NOT a graph route selector.",
      result: s.result,
    }));
    const cfg = { configurable: { thread_id: paused.threadId } };
    await graph.updateState(cfg, {
      status: "running", reason: null, active: foundation,
      result: { status: "committed", headSha: head }, pauseAfter: null,
    }, "specialist_dispatch");
    const handed = await graph.invoke(null, {
      ...cfg, interruptBefore: ["author_update_intake"],
    });
    assert.equal(handed.reviewSteeringHandoff, true);
    assert.equal((await graph.getState(cfg)).next[0], "author_update_intake",
      "The typed post-Review handoff must take precedence over another reviewer dispatch");
    assert.equal(handed.recoveryLifecycle.active, null);
    const resumed = await graph.invoke(null, {
      ...cfg, interruptBefore: ["independent_assignment_review"],
    });
    assert.equal(resumed.reviewSteeringHandoff, false,
      "The original author-intake node consumes the pending typed handoff exactly once");
    assert.equal(resumed.reason, null);
    assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
  } finally {
    saver.db.close();
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("C03 production Review author-only refusal stays a nonsemantic stop while an ordinary refusal enters assessment", {
  skip: !available,
}, async () => {
  const outcomes = [
    { name: "protected", requiresTrustedApproval: true, expected: "author-only" },
    { name: "unprotected", requiresTrustedApproval: false, expected: "assessment" },
  ] as const;
  for (const scenario of outcomes) {
    const f = setup("c03-review-refusal-" + scenario.name);
    saveFixtureTurn(f.job, JSON.parse(readFileSync(f.contract, "utf8")), f.start[3]!,
      ["Retain the original protected objective and independent semantic Review."]);
    const paused = f.cli([...f.start, "--pause-after", "foundation"]);
    assert.equal(paused.status, "paused");
    await sealFixtureGenerationCheckpoint(f, "foundation");
    const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
    const foundation = paused.inventory.items.find((item: { id: string }) => item.id === "foundation");
    assert.ok(foundation);
    const previous = Object.fromEntries(Object.keys(f.env).map(key => [key, process.env[key]]));
    Object.assign(process.env, f.env);
    const saver = SqliteSaver.fromConnString(paused.checkpointPath);
    try {
      const graph = createGenerationGraph(saver, "cli", async () => ({
        status: "blocked" as const,
        ...(scenario.requiresTrustedApproval ? { nonsemanticStop: "author-boundary" as const } : {}),
        reason: "Original independent Review cannot authorize a protected source change.",
        escalation: { kind: scenario.requiresTrustedApproval ? "protected-approval" as const :
          "dependency-replan" as const, requiresTrustedApproval: scenario.requiresTrustedApproval,
          sources: [], action: "Requires an independently authorized amendment" },
      }));
      const cfg = { configurable: { thread_id: paused.threadId } };
      await graph.updateState(cfg, {
        status: "running", reason: null, active: foundation,
        result: { status: "committed", headSha: head },
        pauseAfter: null,
      }, "specialist_dispatch");
      const examined = await graph.invoke(null, { ...cfg, interruptBefore: ["assess_recovery"] });
      assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
      if (scenario.expected === "author-only") {
        assert.equal(examined.status, "blocked");
        assert.equal(examined.recoveryLifecycle.active, null);
        assert.equal(examined.recoveryLifecycle.attempt, null);
        assert.equal(examined.recoverySources.length, 0);
      } else {
        assert.equal(examined.recoveryLifecycle.active?.origin.operation, "independent-review");
        assert.equal(examined.recoveryLifecycle.phase, "assessing");
        assert.equal(examined.recoveryLifecycle.attempt, null);
      }
    } finally {
      saver.db.close();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }
});

test("authenticated owner refusal executes a read-only diagnostic once across assessor restart", { skip: !available }, async () => {
  const { f, next, before, log } = await runFixtureRecoveryGraph("owner-refusal-diagnostic", "diagnostic");
  assert.equal(next.status, "blocked");
  assert.deepEqual(log, ["refuse-other-owner-write"]);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), before);
});

test("author control after selected diagnostic is durable and cannot start an unapproved model", { skip: !available }, async () => {
  const paused = await runFixtureRecoveryGraph("diagnostic-paused-after-selection", "diagnostic", "paused");
  assert.equal(paused.next.recoveryLifecycle.decision?.action, "diagnostic-stop",
    "After author resumes, the original selected diagnosis runs exactly once");
  const cancelled = await runFixtureRecoveryGraph("diagnostic-cancelled-after-selection", "diagnostic", "cancelled");
  assert.equal(cancelled.next.status, "cancelled");
  assert.equal(cancelled.next.recoveryLifecycle.decision?.reason, "cancelled");
});

test("tampered settled diagnostic cannot pass direct production-graph restart", { skip: !available }, async () => {
  await runFixtureRecoveryGraph("tampered-diagnostic-restart", "diagnostic", undefined, "invocation");
});

test("saved diagnostic stop refuses altered original review proof without new Pi invocation", { skip: !available }, async () => {
  await runFixtureRecoveryGraph("tampered-diagnostic-proof", "diagnostic", undefined, "original-proof");
});

test("saved diagnostic selection obeys budget pause and same-case resume", { skip: !available }, async () => {
  const resumed = await runFixtureRecoveryGraph("budget-before-diagnostic", "diagnostic", "budget");
  assert.equal(resumed.next.recoveryLifecycle.decision?.action, "diagnostic-stop");
});

test("C03 independently reviewed original commit permits one read-only Pi diagnosis after Review transport exception", {
  skip: !available,
}, async () => {
  const { f, next, before, log } = await runFixtureRecoveryGraph(
    "review-exception-source-bound-diagnostic", "exception-diagnostic");
  assert.equal(next.status, "blocked");
  assert.equal(next.recoveryLifecycle.decision?.action, "diagnostic-stop");
  assert.equal(next.recoveryLifecycle.attempt?.phase, "settled");
  assert.deepEqual(log, ["review-transport-failed"]);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), before,
    "The original specialist writer is not replayed after Review infrastructure failure");
});

test("C05 original independently reviewed result is reconciled after unfamiliar Review transport failure", {
  skip: !available, timeout: 100_000,
}, async () => {
  const { f, next, before, log } = await runFixtureRecoveryGraph(
    "c05-review-accepted-original", "exception-actionable");
  assert.equal(next.status, "running");
  assert.equal(next.recoveryLifecycle.phase, "idle");
  assert.equal(next.recoveryLifecycle.active, null);
  assert.deepEqual(log, ["review-transport-failed"]);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), before);
});

test("C05 contradictory independently passed final report admits one read-only Pi diagnosis, never a Story pass", {
  skip: !available, timeout: 120_000,
}, async () => {
  const f = setup("c05-final-report-contradiction");
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  saveFixtureTurn(f.job, contract, f.start[3]!, [
    "Preserve verified source and independently validate the final scope.",
  ]);
  const turnFile = join(f.job.stateDir, "turn-plan.json");
  const turn = JSON.parse(readFileSync(turnFile, "utf8"));
  const foundation = f.cli([...f.start, "--pause-after", "foundation"]);
  assert.equal(foundation.status, "paused");
  await sealFixtureGenerationCheckpoint(f, "foundation");
  const architecture = f.cli(["generate", "resume", "--pause-after", "architecture"]);
  assert.equal(architecture.status, "paused", architecture.reason ?? undefined);
  await sealFixtureGenerationCheckpoint(f, "global-architecture");
  assert.match(f.cli(["foundations", "run", "--fixture", "--skills-source", source], false),
    /review|independent/i);
  await sealFixtureGenerationCheckpoint(f, "world-foundations");
  assert.equal(f.cli(["foundations", "run", "--fixture", "--skills-source", source]).status,
    "foundations-committed");
  await sealFixtureGenerationCheckpoint(f, "character-foundations");
  const event = f.cli(["generate", "resume", "--pause-after", "event"]);
  assert.equal(event.status, "paused", event.reason ?? undefined);
  await sealFixtureGenerationCheckpoint(f, "event-disclosure");
  const interactive = f.cli(["generate", "resume", "--pause-after", "interactive"]);
  assert.ok(["paused", "blocked"].includes(interactive.status),
    interactive.reason ?? undefined);
  let progressed = interactive;
  for (let attempt = 0; attempt < 4 && progressed.status === "blocked"; attempt++) {
    const points = await inspectRecoveryCheckpoints(f.job);
    const pending = points.filter(p => p.eligible && p.semanticReview === "required-pending" &&
      ["interactive-choice-disclosure", "interactive-puzzle-disclosure"].includes(p.workItem));
    assert.ok(pending.length, "Interactive recovery cannot skip an unproven dependency");
    for (const p of pending) await sealFixtureGenerationCheckpoint(f, p.workItem);
    progressed = f.cli(["generate", "resume", "--pause-after", "interactive"]);
  }
  assert.equal(progressed.status, "paused", progressed.reason ?? undefined);
  const pendingInteractive = (await inspectRecoveryCheckpoints(f.job)).filter(p =>
    p.eligible && p.semanticReview === "required-pending" &&
    ["interactive-choice-disclosure", "interactive-puzzle-disclosure"].includes(p.workItem));
  for (const p of pendingInteractive) await sealFixtureGenerationCheckpoint(f, p.workItem);
  const composition = f.cli(["generate", "resume", "--pause-after", "composition"]);
  assert.equal(composition.status, "paused", composition.reason ?? undefined);
  await sealFixtureGenerationCheckpoint(f, "composition-disclosure");
  const fixture = f.cli(["generate", "resume"]);
  assert.equal(fixture.status, "blocked", JSON.stringify({
    status: fixture.status, reason: fixture.reason, inventory: fixture.inventory,
  }));

  const reviewFile = join(f.job.stateDir, "narrative-review.json");
  if (existsSync(reviewFile)) unlinkSync(reviewFile);
  const previous = Object.fromEntries(Object.keys(f.env).map(k => [k, process.env[k]]));
  Object.assign(process.env, f.env);
  const releaseSandbox = fixtureSandboxClient(f.job.jobId, f.job.worktreeStoryRoot);
  const storyPaths = () => git(f.job.worktreeRoot, "ls-files", "--", "story/")
    .split("\n").filter(path => path.endsWith(".md")).map(path => path.slice(6));
  try {
    const { runtime, observed } = await scriptedStoryRuntime((index, ctx) => {
      if (index === 0) return {
        content: scriptedReadCalls([
          ...boundedPinnedSources("nt-narrative-review").map(path => "skill://" + path),
          "skill://nt-catalog/references/glossary.md", ...storyPaths(),
        ], index), reason: "toolUse",
      };
      if (index === 1) {
        const prompt = ctx.messages.filter((m): m is {
          role: string; content: Array<{ text?: string }>;
        } => !!m && typeof m === "object" && "role" in m &&
          m.role === "user" && "content" in m && Array.isArray(m.content))
          .flatMap(m => m.content.map(c => c.text ?? ""))
          .findLast(text => text.includes("ASSIGNMENT:\n"));
        assert.ok(prompt, "Independent final reviewer must receive its pinned assignment");
        const a = JSON.parse(prompt.slice(prompt.lastIndexOf("ASSIGNMENT:\n") +
          "ASSIGNMENT:\n".length)) as {
            routes: Array<{ event: string; step: string; branch: string }>;
            milestoneRoutes: Array<{ milestone: string; alternative: number }>;
            puzzleRoutes: Array<{ puzzle: string; event: string }>;
          };
        return { content: scriptedText({ verdict: "pass", findings: [], evidence: [
          ...storyPaths().map(p => p + ":1"),
          ...a.routes.map(r => r.event + "#" + r.step + "/" + r.branch +
            ": events/disclosure.md:1"),
          ...a.milestoneRoutes.map(r => r.milestone + "#" + r.alternative +
            ": milestones/disclosure.md:1"),
          ...a.puzzleRoutes.map(r => r.puzzle + "/" + r.event +
            ": events/disclosure.md:1"),
        ] }), reason: "stop" };
      }
      if (index === 2) return {
        content: scriptedReadCalls([
          ...boundedPinnedSources("nt-narrative-review").map(path => "skill://" + path),
          "skill://nt-catalog/references/glossary.md", ...storyPaths(),
        ], index), reason: "toolUse",
      };
      if (index === 3) {
        const user = ctx.messages.filter((m): m is { role: string; content: Array<{ text?: string }> } =>
          !!m && typeof m === "object" && "role" in m &&
          m.role === "user" && "content" in m && Array.isArray(m.content))
          .flatMap(m => m.content.map(c => c.text ?? ""))
          .findLast(s => s.includes("PLAN-LEVEL PACKET:\n"));
        assert.ok(user);
        const packet = JSON.parse(user.slice(user.lastIndexOf("PLAN-LEVEL PACKET:\n") +
          "PLAN-LEVEL PACKET:\n".length)) as {
          digest: string; objectives: Array<{id:string; text:string}>;
          canonical: Array<{path:string;content:string}>;
        };
        const pathFor = (id: string) =>
          id.includes("milestone-plan:") && (id.includes(":event:") || id.includes(":local-event:")) ? "events/disclose-ledger.md" :
          id.includes("milestone-plan:") && id.includes(":interactive:") ? "choice-points/loyalty.md" :
          id.includes("milestone-plan:") && id.includes(":composition:") ? "authored-content/disclosure-scene.md" :
          id.includes("architecture") ? "arcs/truth.md" :
          id.includes("interactive") || id.includes("branch") ? "choice-points/loyalty.md" :
          "authored-content/disclosure-scene.md";
        const checks = packet.objectives.map(o => {
          const path = pathFor(o.id);
          assert.ok(packet.canonical.some(c => c.path === path), "Source witness missing: " + path);
          return { objectiveId: o.id, fulfilled: true,
            evidence: [{ path, line: 1, explanation: "Canonical source supports " + o.text }] };
        });
        return { content: scriptedText({ digest: packet.digest, verdict: "complete",
          checks, findings: [] }), reason: "stop" };
      }
      if (index === 4) {
        const text = JSON.stringify(ctx.messages);
        const signature = text.match(/signature=([0-9a-f]{64})/)?.[1];
        const sourceRef = text.match(/sourceRef=([^;]+); category=/)?.[1];
        assert.ok(signature && sourceRef);
        return { content: scriptedText({
          schema: "noveltea-recovery-diagnostic-proposal/v1", signature, sourceRef,
          category: "invalid-assignment",
          diagnosis: "The final Pi report passed but the original Graph inventory remains incomplete.",
          strategy: "unsafe", owner: null, scopeRef: null,
          prerequisites: ["Reconcile the original inventory against independent source proofs"],
          uncertainty: "No independent proof yet permits promotion of the incomplete assignment.",
        }), reason: "stop" };
      }
      throw Error("Unexpected model invocation after read-only diagnostic: " + index);
    });
    await (await import("../src/job-pi-policy.js")).configurePiPolicy(f.job, {
      version: 1, profile: { provider: scriptedModel.provider, model: scriptedModel.id },
      limits: { modelCalls: 5 },
    });
    const reviewed = await withJobModelRuntime(runtime, () =>
      (async () => {
        const { runNarrativeReview } = await import("../src/narrative-review.js");
        return runNarrativeReview({ story: f.story, job: "single", action: "run",
          fixture: false, skillsSource: source, turnPlanDigest: turn.digest,
          provider: scriptedModel.provider, model: scriptedModel.id });
      })());
    assert.equal(reviewed.worker, "pi");
    assert.equal(reviewed.status, "complete-in-scope",
      JSON.stringify({status:reviewed.status,failure:reviewed.failure,editorial:reviewed.editorial}));
    const { inspectJobReport } = await import("../src/job-report.js");
    const preliminary = await inspectJobReport({ story: f.story, job: "single" });
    const { assessTurnFulfillment } = await import("../src/turn-fulfillment.js");
    const { reviewTurnCompleteness } = await import("../src/narrative-review-specialist.js");
    const { createSkillSnapshot } = await import("../src/snapshot.js");
    const reviewSnapshot = await createSkillSnapshot({ discovery: "explicit-only",
      novelteaSkills: source, skillDirs: [], requiredSkills: ["nt-narrative-review", "nt-catalog"] });
    assert.ok(reviewSnapshot);
    const currentJob = await startStoryJob({ story: f.story, job: "single" }, false);
    const { withStoryJobLock } = await import("../src/job-lock.js");
    const turnResult = await withJobModelRuntime(runtime, () =>
      withStoryJobLock(currentJob, "generation-final-turn-review", () =>
        assessTurnFulfillment(currentJob, preliminary, "independent-pi-turn-completeness",
          (packet, onSession) => reviewTurnCompleteness(currentJob, reviewSnapshot, packet,
            scriptedModel.provider, scriptedModel.id, undefined, onSession))));
    assert.equal(turnResult?.phase, "completed");
    assert.equal(turnResult.verdict?.verdict, "complete");
    const report = await inspectJobReport({ story: f.story, job: "single" });
    assert.equal(report.generation.status, "completed", JSON.stringify(report.generation));

    const saver = SqliteSaver.fromConnString(join(f.job.stateDir, "generation.sqlite"));
    try {
      const graph = createGenerationGraph(saver, "cli");
      const config = { configurable: { thread_id: f.job.threadId + ":generation" } };
      const saved = (await graph.getState(config)).values;
      assert.ok(saved.inventory && !saved.inventory.items.every((i: any) => i.status === "verified"),
        "The original Graph still has an unverified review assignment.");
      await graph.updateState(config, {
        request: { ...saved.request, fixture: false, turnPlanDigest: turn.digest,
          provider: scriptedModel.provider, model: scriptedModel.id },
        status: "running", active: null, result: null, pauseAfter: null,
        escalation: null, causalAmendment: null,
      }, "author_update_intake");
      const admitted = await graph.invoke(null, { ...config, interruptBefore: ["assess_recovery"] });
      assert.equal(admitted.recoveryLifecycle.active?.origin.operation, "completion-verification",
        JSON.stringify({ status: admitted.status, reason: admitted.reason,
          case: admitted.recoveryLifecycle.active }));
      assert.equal(admitted.recoveryLifecycle.active?.observation, "returned-failure");
      const selected = await graph.invoke(null, { ...config, interruptAfter: ["assess_recovery"] });
      assert.equal(selected.recoveryLifecycle.decision?.action, "diagnostic");
      assert.equal(observed.length, 4, "No diagnosis before its authenticated admission");
      const diagnosed = await withJobModelRuntime(runtime, () => graph.invoke(null, config));
      assert.equal(diagnosed.recoveryLifecycle.decision?.action, "diagnostic-stop",
        JSON.stringify({ status: diagnosed.status, reason: diagnosed.reason,
          lifecycle: diagnosed.recoveryLifecycle }));
      assert.equal(diagnosed.recoveryLifecycle.attempt?.phase, "settled");
      assert.equal(diagnosed.status, "blocked", "Diagnostic cannot waive the Graph inventory gate");
      assert.equal(observed.length, 5);
      assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, config.configurable.thread_id),
        diagnosed.recoveryLifecycle);
      const restarted = await graph.invoke({ request: diagnosed.request }, config);
      assert.equal(restarted.status, "blocked");
      assert.equal(observed.length, 5, "Saved completion diagnosis cannot run a second Pi call");
      // A forged prior positive Review cannot keep a historical diagnostic
      // authoritative. Inspection must recheck the exact original reviewer
      // evidence, fence the saved case, and refuse an additional model call.
      const beforeReview = readFileSync(reviewFile, "utf8");
      const forgedReview = JSON.parse(beforeReview);
      forgedReview.editorial.verdict = "block";
      writeFileSync(reviewFile, JSON.stringify(forgedReview));
      const fenced = await inspectModernGenerationRecovery(f.job, saver, config.configurable.thread_id);
      assert.equal(fenced?.phase, "fenced");
      assert.ok(fenced?.inspectionFences.length);
      assert.equal(observed.length, 5);
      writeFileSync(reviewFile, beforeReview);
      assert.equal(git(f.job.worktreeRoot, "status", "--porcelain", "--untracked-files=all"), "");
    } finally { saver.db.close(); }
  } finally {
    releaseSandbox();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("C03 Review exception diagnostic refuses altered original independently reviewed commit proof", {
  skip: !available,
}, async () => {
  const { next } = await runFixtureRecoveryGraph(
    "review-exception-altered-original-proof", "exception-diagnostic",
    undefined, "original-proof");
  assert.equal(next.status, "blocked");
  assert.equal(next.recoveryLifecycle.decision?.action, "diagnostic-stop",
    "The sealed original diagnosis remains historical, never re-invoked");
});

test("review transport exception reaches the same assessor without retrying the writer", { skip: !available }, async () => {
  const { f, next, before, log } = await runFixtureRecoveryGraph("review-transport-exception", "exception");
  assert.equal(next.status, "blocked");
  assert.deepEqual(log, ["review-transport-failed"]);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), before);
});

test("C02 production graph preserves authenticated author controls and same-case resumption", {
  skip: !available,
}, async () => {
  for (const control of ["paused", "cancelled"] as const) {
    const f = setup("c02-original-author-" + control);
    const initial = f.cli([...f.start, "--pause-after", "foundation"]);
    assert.equal(initial.status, "paused");
    const foundation = initial.inventory.items.find((item: { id: string }) => item.id === "foundation");
    assert.ok(foundation);
    const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
    const prior = Object.fromEntries(Object.keys(f.env).map(key => [key, process.env[key]]));
    Object.assign(process.env, f.env);
    const saver = SqliteSaver.fromConnString(initial.checkpointPath);
    try {
      const graph = createGenerationGraph(saver, "cli");
      const cfg = { configurable: { thread_id: initial.threadId } };
      await graph.updateState(cfg, {
        status: "running", active: foundation,
        result: { status: "in-progress", headSha: head }, pauseAfter: null,
      }, "independent_assignment_review");
      const admitted = await graph.invoke(null, { ...cfg, interruptBefore: ["assess_recovery"] });
      assert.equal(admitted.recoveryLifecycle.phase, "assessing");
      const originalCase = admitted.recoveryLifecycle.active?.id;
      assert.ok(originalCase);
      await setJobControl(f.job, control);
      const stopped = await graph.invoke(null, cfg);
      assert.equal(stopped.status, control);
      assert.equal(stopped.recoveryLifecycle.phase, "paused");
      assert.equal(stopped.recoveryLifecycle.decision?.action, "pause");
      assert.equal(stopped.recoveryLifecycle.decision?.reason,
        control === "cancelled" ? "cancelled" : "author-pause");
      assert.equal(stopped.recoveryLifecycle.active?.id, originalCase);
      assert.equal(stopped.recoveryLifecycle.inspectionFences.length, 0,
        "an authenticated author control is never source-integrity corruption");
      if (control === "paused") {
        await setJobControl(f.job, "running");
        const resumed = await graph.invoke({ request: stopped.request },
          { ...cfg, interruptBefore: ["assess_recovery"] });
        assert.equal(resumed.status, "running");
        assert.equal(resumed.recoveryLifecycle.phase, "assessing");
        assert.equal(resumed.recoveryLifecycle.active?.id, originalCase);
      }
      assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
    } finally {
      saver.db.close();
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }
});

test("#225 unaccepted specialist result reaches assessment and remains fenced across inspect/resume", {
  skip: !available,
}, async () => {
  const f = setup("recovery-unaccepted-specialist-result");
  const paused = f.cli([...f.start, "--pause-after", "foundation"]);
  assert.equal(paused.status, "paused");
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
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
});

test("#225 thrown independent reviewer fails closed without another specialist or reviewer", {
  skip: !available,
}, async () => {
  const f = setup("recovery-independent-review-exception");
  const paused = f.cli([...f.start, "--pause-after", "foundation"]);
  assert.equal(paused.status, "paused");
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const foundation = paused.inventory.items.find((item: { id: string }) => item.id === "foundation");
  assert.ok(foundation);
  const previous = Object.fromEntries(Object.keys(f.env).map(key => [key, process.env[key]]));
  Object.assign(process.env, f.env);
  const saver = SqliteSaver.fromConnString(paused.checkpointPath);
  let reviewerCalls = 0;
  let result: any;
  try {
    const graph = createGenerationGraph(saver, "cli", async () => {
      reviewerCalls++;
      throw Error("Injected reviewer transport failure");
    });
    const config = { configurable: { thread_id: paused.threadId } };
    await graph.updateState(config, {
      status: "running", active: foundation,
      result: { status: "committed", headSha: head }, pauseAfter: null,
    }, "specialist_dispatch");
    result = await graph.invoke(null, config);
    assert.equal(reviewerCalls, 1, "the assessment must not retry a read-only review without an original receipt");
    assert.equal(result.status, "blocked");
    assert.equal(currentOperationRecovery(result)?.operation, "independent-review");
    assert.equal(currentOperationRecovery(result)?.phase, "fenced");
    assert.match(currentOperationRecovery(result)?.reason ?? "", /reviewer transport failure/);
    const again = await graph.invoke(result, config);
    assert.equal(again.status, "blocked");
    assert.equal(reviewerCalls, 1, "repeated invocation may not start a new reviewer");
  } finally {
    saver.db.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.deepEqual(f.cli(["generate", "inspect"]).operationRecovery, currentOperationRecovery(result));
  assert.equal(f.cli(["generate", "resume"]).status, "blocked");
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
});

test("#225 dirty effect after a settled specialist cannot bypass commit verification or replay", {
  skip: !available,
}, async () => {
  const f = setup("recovery-dirty-active-specialist");
  const paused = f.cli([...f.start, "--pause-after", "foundation"]);
  assert.equal(paused.status, "paused");
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const receiptPath = join(f.job.stateDir, "foundation.json");
  const originalReceipt = readFileSync(receiptPath, "utf8");
  const foundation = paused.inventory.items.find((item: { id: string }) => item.id === "foundation");
  assert.ok(foundation);
  const draft = join(f.job.worktreeStoryRoot, "unreconciled-draft.md");
  writeFileSync(draft, "Preserve this ambiguous writer effect.");
  const previous = Object.fromEntries(Object.keys(f.env).map(key => [key, process.env[key]]));
  Object.assign(process.env, f.env);
  const saver = SqliteSaver.fromConnString(paused.checkpointPath);
  let result: any;
  try {
    const graph = createGenerationGraph(saver, "cli");
    const config = { configurable: { thread_id: paused.threadId } };
    // Re-enter dispatch with the already completed Foundation receipt and
    // an ambiguous new dirty effect. The shared child may reuse the settled
    // submission, but commit verification must fence the dirty worktree.
    await graph.updateState(config, {
      status: "running", active: foundation, result: null, pauseAfter: null,
    }, "author_update_intake");
    result = await graph.invoke(null, config);
  } finally {
    saver.db.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.equal(result.status, "blocked");
  assert.equal(currentOperationRecovery(result)?.operation, "commit-verification");
  assert.equal(currentOperationRecovery(result)?.phase, "fenced");
  assert.equal(readFileSync(draft, "utf8"), "Preserve this ambiguous writer effect.");
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
  unlinkSync(draft);
  assert.deepEqual(f.cli(["generate", "inspect"]).operationRecovery, currentOperationRecovery(result));
  assert.deepEqual(f.cli(["generate", "resume"]).operationRecovery, currentOperationRecovery(result));
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
  assert.equal(readFileSync(receiptPath, "utf8"), originalReceipt, "The original writer receipt must not be rewritten");
});

test("#225 untrusted completion preflight is assessed, not treated as complete or retried", {
  skip: !available,
}, async () => {
  const f = setup("recovery-completion-preflight");
  const paused = f.cli([...f.start, "--pause-after", "foundation"]);
  assert.equal(paused.status, "paused");
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
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
});

test("#225 failed dependency amendment is assessed without dispatching another writer", {
  skip: !available,
}, async () => {
  const f = setup("recovery-dependency-amendment");
  const paused = f.cli([...f.start, "--pause-after", "foundation"]);
  assert.equal(paused.status, "paused");
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
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
});

test("single-Milestone generation checkpoints foundation then resumes all specialists in a new process", { skip: !available }, () => {
  const f = setup("complete");
  const paused = f.cli([...f.start, "--pause-after", "foundation"]);
  assert.equal(paused.status, "paused", JSON.stringify(paused));
  assert.equal(paused.nextStage, "architecture");
  const selected = paused.orchestrationSelection;
  assert.equal(selected.schema, "noveltea-orchestrator-selection/v1");
  assert.equal(selected.role, "orchestrator");
  assert.equal(selected.skillName, "nt-story-orchestrate");
  assert.equal(selected.objectiveKind, "partial");
  assert.equal(selected.storySourceSha, f.initial);
  assert.equal(selected.graphThreadId, f.job.threadId + ":generation");
  assert.equal(selected.skillSnapshot.commit, git(source, "rev-parse", "HEAD"));
  assert.equal(selected.skillSnapshot.id, selected.skillSnapshot.digest);
  assert.equal(selected.skillEntrypointSha256, createHash("sha256").update(
    readFileSync(join(selected.skillSnapshot.path, selected.skillEntrypoint))).digest("hex"));
  assert.deepEqual(JSON.parse(readFileSync(join(f.job.stateDir, "orchestrator-selection.json"), "utf8")), selected);
  assert.ok(existsSync(join(dirname(f.job.worktreeRoot), "generation.sqlite")));
  const foundationHead = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  assert.notEqual(foundationHead, f.initial);
  const inspected = f.cli(["generate", "inspect"]);
  assert.equal(inspected.status, "paused");
  assert.deepEqual(inspected.orchestrationSelection, selected);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), foundationHead);
  const result = f.cli(["generate", "resume"]);
  assert.equal(result.status, "blocked", JSON.stringify(result));
  assert.equal(result.reason, "editorial-unverified");
  assert.deepEqual(result.orchestrationSelection, selected);
  assert.equal(result.report.generation.review.phase, "completed");
  assert.equal(result.report.evidence.scope.deterministic, "passed");
  assert.equal(result.completedStages.length, 7);
  const finalHead = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  assert.equal(f.cli(["generate", "resume"]).reason, "editorial-unverified");
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), finalHead);
  assert.match(readFileSync(join(f.job.worktreeStoryRoot, "authored-content/disclosure-scene.md"), "utf8"), /Ada/);
  assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.initial);
  assert.equal(git(f.repo, "status", "--porcelain"), "");
});

test("a committed Interactive checkpoint ignores later diagnostics but rejects altered verified evidence", {
  skip: !available,
}, () => {
  const f = setup("committed-interactive-diagnostic");
  const result = f.cli(f.start);
  const checkpoint = result.recoveryCheckpoints.find((point: any) =>
    point.workItem === "interactive-choice-disclosure");
  assert.ok(checkpoint?.eligible, JSON.stringify(result.recoveryCheckpoints));
  const originalHead = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const path = join(f.job.stateDir, "interactive-items/disclosure.json");
  const original = readFileSync(path, "utf8");
  const receipt = JSON.parse(original);
  const unit = receipt.units.find((item: any) =>
    item.id === "interactive-choice-disclosure");
  assert.equal(unit?.phase, "committed");
  unit.failure = "Error: Controller scheduling failed after the validated commit.";
  writeFileSync(path, JSON.stringify(receipt));
  const inspect = () => f.cli(["generate", "inspect"]).recoveryCheckpoints.find(
    (point: any) => point.commitSha === checkpoint.commitSha);
  assert.ok(inspect()?.eligible, "An after-the-fact diagnostic cannot change an immutable proof.");
  unit.validation.status = "failed";
  writeFileSync(path, JSON.stringify(receipt));
  assert.equal(inspect()?.eligible, false,
    "Actual validation evidence is still covered by the checkpoint proof.");
  writeFileSync(path, original);
  assert.ok(inspect()?.eligible);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), originalHead,
    "No diagnostic or receipt inspection can regenerate the specialist.");
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.initial);
});

test("generation rejects a lost orchestrator selection after checkpoint without repinning or replay", { skip: !available }, () => {
  const f = setup("missing-orchestrator-selection");
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
});

test("inspection rejects a different valid pinned method and never displays its forged provenance", { skip: !available }, () => {
  const f = setup("swapped-orchestrator-snapshot");
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
  const other = next.cli([...next.start.slice(0, -1), changedSource, "--pause-after", "foundation"]);
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
});

test("independent World and Character checkpoints survive restart and reconcile a lost finalization without writer replay", { skip: !available }, () => {
  const f = setup("threads-checkpoints");
  const paused = f.cli([...f.start, "--pause-after", "foundations"]);
  assert.equal(paused.status, "paused", JSON.stringify(paused));
  const points = paused.recoveryCheckpoints as Array<{
    workItem: string; commitSha: string; eligible: boolean; nextWorkItem: string | null;
    completedWorkItems: string[]; remainingWorkItems: string[];
  }>;
  const world = points.find(point => point.workItem === "world-foundations");
  const character = points.find(point => point.workItem === "character-foundations");
  assert.ok(world?.eligible, JSON.stringify(points));
  assert.ok(character?.eligible, JSON.stringify(points));
  assert.notEqual(world.commitSha, character.commitSha);
  assert.equal(world.nextWorkItem, "character-foundations");
  assert.ok(world.completedWorkItems.includes("world-foundations"));
  assert.ok(!world.completedWorkItems.includes("character-foundations"));
  assert.ok(world.remainingWorkItems.includes("character-foundations"));
  assert.ok(character.completedWorkItems.includes("character-foundations"));
  assert.equal(character.nextWorkItem, "event-disclosure");
  const headBefore = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const worldFile = join(f.job.stateDir, "recovery-checkpoints", world.commitSha + ".json");
  assert.ok(existsSync(worldFile));
  // Simulate a SIGKILL after specialist/verified-head receipt publication but
  // before recovery-point finalization. A read must not synthesize a point.
  unlinkSync(worldFile);
  const incomplete = f.cli(["generate", "inspect"]).recoveryCheckpoints as Array<{
    workItem: string; commitSha: string; eligible: boolean; reason: string | null;
  }>;
  assert.ok(incomplete.some(point => point.commitSha === world.commitSha &&
    !point.eligible && /incomplete/.test(point.reason ?? "")));
  const resumed = f.cli(["generate", "resume", "--pause-after", "event"]);
  assert.ok(existsSync(worldFile), "resume reconciles from the original specialist receipt");
  const repaired = (resumed.recoveryCheckpoints as typeof points).find(point => point.commitSha === world.commitSha);
  assert.ok(repaired?.eligible, JSON.stringify(resumed.recoveryCheckpoints));
  assert.equal(repaired.nextWorkItem, "character-foundations");
  const commits = git(f.job.worktreeRoot, "log", "--format=%B", headBefore)
    .split("NovelTea-Work-Item: world-foundations").length - 1;
  assert.equal(commits, 1, "recovery never invokes World writer or duplicates its commit");
  const restarted = f.cli(["generate", "inspect"]);
  assert.ok((restarted.recoveryCheckpoints as typeof points).some(point =>
    point.commitSha === world.commitSha && point.eligible));
  const savedPoint = readFileSync(worldFile, "utf8");
  // Altered continuation must not become a branchable checkpoint.
  const forged = JSON.parse(savedPoint);
  forged.nextWorkItem = "event-invented";
  writeFileSync(worldFile, JSON.stringify(forged));
  const tampered = f.cli(["generate", "inspect"]).recoveryCheckpoints as typeof points;
  assert.ok(tampered.some(point => point.commitSha === world.commitSha && !point.eligible));
  writeFileSync(worldFile, savedPoint);
  const invented = JSON.parse(savedPoint);
  invented.completedWorkItems.push("repair-" + "f".repeat(40));
  writeFileSync(worldFile, JSON.stringify(invented));
  assert.ok((f.cli(["generate", "inspect"]).recoveryCheckpoints as typeof points).some(point =>
    point.commitSha === world.commitSha && !point.eligible),
    "A fabricated repair is not a legitimate historical completed work item.");
  writeFileSync(worldFile, savedPoint);
  // A self-consistent hash inside an edited checkpoint is not authorization:
  // the independently saved intent and controller plan must match exactly.
  const rewritten = JSON.parse(savedPoint);
  rewritten.plan.contract.constraints = ["Unauthorised substitute author constraint"];
  rewritten.planDigest = createHash("sha256").update(JSON.stringify(rewritten.plan)).digest("hex");
  writeFileSync(worldFile, JSON.stringify(rewritten));
  const untrustedPlan = f.cli(["generate", "inspect"]).recoveryCheckpoints as typeof points;
  assert.ok(untrustedPlan.some(point => point.commitSha === world.commitSha && !point.eligible),
    "rehashing a modified plan must never authenticate it");
  writeFileSync(worldFile, savedPoint);
  // Validator evidence in the original specialist receipt is authoritative.
  const receiptPath = join(f.job.stateDir, "character-world.json");
  const savedReceipt = readFileSync(receiptPath, "utf8");
  const invalid = JSON.parse(savedReceipt);
  invalid.units[0].validation.status = "failed";
  writeFileSync(receiptPath, JSON.stringify(invalid));
  const invalidReceipt = f.cli(["generate", "inspect"]).recoveryCheckpoints as typeof points;
  assert.ok(invalidReceipt.some(point => point.commitSha === world.commitSha && !point.eligible));
  writeFileSync(receiptPath, savedReceipt);
  // A later uncommitted draft never adds an eligible checkpoint. Earlier
  // immutable points remain valid and independently inspectable.
  const draft = join(f.job.worktreeStoryRoot, "characters", "unfinished-draft.md");
  writeFileSync(draft, "unfinished draft");
  const dirty = f.cli(["generate", "inspect"]).recoveryCheckpoints as typeof points;
  assert.ok(dirty.find(point => point.commitSha === world.commitSha)?.eligible);
  assert.ok(dirty.find(point => point.commitSha === character.commitSha)?.eligible);
  assert.ok(!dirty.some(point => point.commitSha === headBefore &&
    ![world.commitSha, character.commitSha].includes(point.commitSha)));
  unlinkSync(draft);
});

for (const unit of ["world-foundations", "character-foundations"] as const)
test(`crash after ${unit} commit before finalization never replays writer or grants an incomplete point`, { skip: !available }, () => {
  const f = setup("threads-crash-" + unit);
  f.env.NT_RECOVERY_FIXTURE_CRASH_AFTER_INTENT = unit;
  const crashed = f.cli([...f.start, "--pause-after", "foundations"]);
  assert.equal(crashed.status, "blocked", JSON.stringify(crashed));
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  assert.match(git(f.job.worktreeRoot, "log", "-1", "--format=%B"), new RegExp("NovelTea-Work-Item: " + unit));
  assert.ok(crashed.recoveryCheckpoints.some((p: any) => p.commitSha === head && !p.eligible));
  const before = JSON.parse(readFileSync(join(f.job.stateDir, "character-world.json"), "utf8"));
  if (unit === "world-foundations") assert.equal(before.units[1].phase, "pending");
  delete f.env.NT_RECOVERY_FIXTURE_CRASH_AFTER_INTENT;
  const reconciled = f.cli(["generate", "resume", "--pause-after", "foundations"]);
  assert.ok(reconciled.recoveryCheckpoints.some((p: any) =>
    p.commitSha === head && p.workItem === unit && p.eligible));
  const after = JSON.parse(readFileSync(join(f.job.stateDir, "character-world.json"), "utf8"));
  assert.deepEqual(after.units[0], before.units[0], "World receipt is retained across restart");
  if (unit === "character-foundations") assert.deepEqual(after.units[1], before.units[1]);
  assert.equal(git(f.job.worktreeRoot, "rev-list", "--count", f.initial + "..HEAD").trim(),
    String(reconciled.recoveryCheckpoints.filter((p: any) => p.eligible).length));
  assert.equal(reconciled.status, "paused", JSON.stringify({ reason: reconciled.reason, nextStage: reconciled.nextStage, operationRecovery: reconciled.operationRecovery, active: reconciled.selectedWorkItem, pendingNodes: reconciled.pendingNodes }));
});

test("multi-Milestone generation develops every selected cluster across process restarts", { skip: !available }, () => {
  const f = setup("multi");
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope.targets = ["arc.truth", "milestone.disclosure", "milestone.reckoning"];
  writeFileSync(f.contract, JSON.stringify(contract));
  const foundations = f.cli([...f.start, "--pause-after", "foundations"]);
  assert.equal(foundations.status, "paused", JSON.stringify(foundations));
  const character = foundations.recoveryCheckpoints.find((p: any) =>
    p.workItem === "character-foundations" && p.eligible);
  assert.ok(character, JSON.stringify(foundations.recoveryCheckpoints));
  assert.deepEqual(character.dependencies["event-disclosure"], ["character-foundations"]);
  assert.deepEqual(character.dependencies["event-reckoning"], ["character-foundations"]);
  assert.equal(character.nextWorkItem, "event-disclosure",
    "aggregate composition/review plans must not create cyclic Event prerequisites");
  const paused = f.cli(["generate", "resume", "--pause-after", "composition"]);
  assert.equal(paused.status, "paused", JSON.stringify(paused));
  assert.equal(paused.nextStage, "event");
  const firstHead = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const result = f.cli(["generate", "resume"]);
  assert.equal(result.status, "blocked", JSON.stringify(result));
  assert.equal(result.reason, "editorial-unverified");
  assert.equal(result.inventory.items.filter((i: any) => i.stage === "composition" && i.status === "verified").length, 2);
  assert.notEqual(git(f.job.worktreeRoot, "rev-parse", "HEAD"), firstHead);
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  f.cli(["generate", "resume"]);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.initial);
});

function plannedCluster(story: string, arc: string, milestone: string) {
  const direction = join(story, "creative-direction/foundation.md");
  if (!existsSync(direction)) {
    mkdirSync(dirname(direction), { recursive: true });
    writeFileSync(direction, `---\nschema: '0.1'\ntype: creative-direction\nid: creative-direction.foundation\ntitle: "The Archive Mystery"\nstatus: draft\ndecisions: []\npremise: "A missing witness challenges an archivist to investigate a hidden truth."\ncentral_conflict: "The archivist must choose between truth and protecting witnesses."\ngenre: "Mystery"\ntone: "Suspenseful"\nplayer_experience: "A dialogue-led investigation with meaningful choices."\nscope: "A small town and its archive."\n---\n\n# Foundation\n\nAn investigator discovers the cost of secrecy.\n`);
  }
  for (const [folder, slug, type, fields] of [
    ["arcs", arc, "arc", 'dramatic_question: "Will loyalty survive?"\ncharacters: []'],
    ["milestones", milestone, "milestone", `completeness: partial\nchange: "The witness accepts responsibility"\narcs: [arc.${arc}]\nfulfillment: {any_of: []}`],
  ]) {
    mkdirSync(join(story, folder!), { recursive: true });
    writeFileSync(join(story, folder!, slug + ".md"), `---\nschema: '0.1'\ntype: ${type}\nid: ${type}.${slug}\ntitle: "${slug}"\nstatus: draft\ndecisions: []\n${fields}\n---\n\nThe witness must choose between silence and accountability.\n`);
  }
}

test("full-Story scope discovers multiple canonical Arc clusters rather than stopping at the first", { skip: !available }, () => {
  const f = setup("full", story => plannedCluster(story, "justice", "reckoning"));
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope = { kind: "full-story", depth: "composition", targets: [], branches: [] };
  writeFileSync(f.contract, JSON.stringify(contract));
  const result = f.cli(f.start);
  assert.equal(result.reason, "editorial-unverified", JSON.stringify(result));
  assert.equal(result.orchestrationSelection.skillName, "nt-story-orchestrate");
  assert.equal(result.orchestrationSelection.objectiveKind, "full-story");
  assert.deepEqual(result.inventory.items.filter((i: any) => i.stage === "composition").map((i: any) => [i.milestone, i.status]),
    [["milestone.disclosure", "verified"], ["milestone.reckoning", "verified"]]);
  assert.equal(result.inventory.audit.deterministic, "passed");
});

test("bounded partial Arc expands its Milestones but leaves an unfinished optional Arc untouched", { skip: !available }, () => {
  const f = setup("partial-arc", story => {
    plannedCluster(story, "truth", "reckoning");
    plannedCluster(story, "optional", "deferred");
  });
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope.targets = ["arc.truth"];
  writeFileSync(f.contract, JSON.stringify(contract));
  const result = f.cli(f.start);
  assert.equal(result.reason, "editorial-unverified", JSON.stringify(result));
  assert.equal(result.inventory.items.filter((i: any) => i.stage === "composition" && i.status === "verified").length, 2);
  assert.ok(!result.inventory.items.some((i: any) => i.milestone === "milestone.deferred"));
  assert.equal(git(f.job.worktreeRoot, "diff", f.initial, "HEAD", "--", "story/milestones/deferred.md"), "");
});

test("alternative Milestone routes retain separately owned Event-design prose obligations", { skip: !available }, () => {
  const f = setup("alternatives");
  f.env.NT_EVENT_FIXTURE_CASE = "alternative-routes";
  const result = f.cli(f.start);
  assert.equal(result.reason, "editorial-unverified", JSON.stringify(result));
  const routes = result.inventory.audit.routeCoverage.milestones.filter((m: any) =>
    m.milestone === "milestone.disclosure");
  assert.deepEqual(routes.map((r: any) => r.status), ["reachable", "reachable"]);
  assert.equal(result.inventory.audit.deterministic, "passed");
  assert.ok(existsSync(join(f.job.worktreeStoryRoot, "authored-content/inspect-ledger-scene.md")));
});

function plannedDependencyInventory(f: ReturnType<typeof setup>, edit: (items: any[]) => void) {
  const file = join(dirname(f.job.worktreeRoot), "architecture.json");
  const architecture = JSON.parse(readFileSync(file, "utf8"));
  // Model typed dependencies in memory. Editing the already-committed
  // controller receipt in place would be an unauthorized replan and must not
  // be used as a fixture for a production recovery checkpoint.
  edit(architecture.plan.items);
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const validated = spawnSync(process.execPath, [...cliEntry(),
    "job", "validate", "--story", f.story, "--job", "single"], {
    encoding: "utf8", env: f.env, timeout: 90000, maxBuffer: 32 * 1024 * 1024,
  });
  assert.ok(validated.status === 0 || validated.status === 2, validated.stderr);
  return reconcileInventory(architecture.plan, JSON.parse(validated.stdout), head, [
    { stage: "foundation", headSha: head, status: "committed" },
    { stage: "architecture", headSha: head, status: "architecture-committed", planVersion: 1 },
    { stage: "foundations", headSha: head, status: "foundations-committed", planVersion: 1 },
  ], {});
}

test("source-bound Architecture order schedules the earliest causal Event before alphabetical resolution", { skip: !available }, () => {
  const f = setup("causal-event-order");
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope.targets = ["arc.truth", "milestone.disclosure", "milestone.reckoning"];
  writeFileSync(f.contract, JSON.stringify(contract));
  f.cli([...f.start, "--pause-after", "architecture"]);
  const inventory = plannedDependencyInventory(f, () => {});
  assert.deepEqual(inventory.items.filter(i => i.stage === "event").map(i => i.id),
    ["event:milestone.disclosure", "event:milestone.reckoning"],
    "The canonical inventory and carry-forward identity remain unchanged");
  const causal = withCausalEventPriority({ items: [
    { kind: "realization", targetIds: ["milestone.reckoning"] },
    { kind: "realization", targetIds: ["milestone.disclosure"] },
  ] } as any, ["foundation", "architecture", "foundations", "event", "interactive", "composition"]);
  assert.deepEqual(causal.slice(3, 6),
    ["event:milestone.reckoning", "event:milestone.disclosure", "event"]);
  assert.equal(nextExecutionItem(inventory, causal)?.id, "event:milestone.reckoning");
  assert.equal(nextExecutionItem(inventory)?.id, "event:milestone.disclosure");
  assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
});

test("a new typed cross-Milestone dependency changes the next runnable work item", { skip: !available }, () => {
  const f = setup("dependency");
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope.targets = ["arc.truth", "milestone.disclosure", "milestone.reckoning"];
  writeFileSync(f.contract, JSON.stringify(contract));
  const paused = f.cli([...f.start, "--pause-after", "architecture"]);
  assert.equal(paused.status, "paused");
  const inventory = plannedDependencyInventory(f, items => {
    const disclosure = items.find(i => i.targetIds.includes("milestone.disclosure") && i.kind === "realization");
    const reckoning = items.find(i => i.targetIds.includes("milestone.reckoning") && i.kind === "realization");
    assert.ok(disclosure && reckoning, "typed plan contains both realization obligations");
    disclosure.dependencies.push(reckoning.id);
  });
  assert.deepEqual(inventory.items.find(i => i.id === "event:milestone.disclosure")?.dependencies,
    ["foundations", "architecture", "event:milestone.reckoning"]);
  assert.equal(nextExecutionItem(inventory)?.id, "event:milestone.reckoning");
  assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
});

test("an unknown typed dependency blocks its cluster without silently dropping it", { skip: !available }, () => {
  const f = setup("unknown-dependency");
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope.targets = ["arc.truth", "milestone.disclosure", "milestone.reckoning"];
  writeFileSync(f.contract, JSON.stringify(contract));
  f.cli([...f.start, "--pause-after", "architecture"]);
  const inventory = plannedDependencyInventory(f, items => {
    const disclosure = items.find(i => i.targetIds.includes("milestone.disclosure") && i.kind === "realization");
    assert.ok(disclosure);
    disclosure.dependencies.push("nonexistent-dependency");
  });
  assert.match(inventory.items.find(i => i.id === "event:milestone.disclosure")?.blockingReason ?? "",
    /nonexistent-dependency/);
  assert.equal(inventory.items.find(i => i.id === "event:milestone.reckoning")?.status, "pending");
  assert.equal(nextExecutionItem(inventory)?.id, "event:milestone.reckoning");
  assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
});

test("cyclic typed dependencies block their work without dispatch", { skip: !available }, () => {
  const f = setup("cycle");
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope.targets = ["arc.truth", "milestone.disclosure", "milestone.reckoning"];
  writeFileSync(f.contract, JSON.stringify(contract));
  f.cli([...f.start, "--pause-after", "architecture"]);
  const inventory = plannedDependencyInventory(f, items => {
    const disclosure = items.find(i => i.targetIds.includes("milestone.disclosure") && i.kind === "realization");
    const reckoning = items.find(i => i.targetIds.includes("milestone.reckoning") && i.kind === "realization");
    assert.ok(disclosure && reckoning);
    disclosure.dependencies.push(reckoning.id);
    reckoning.dependencies.push(disclosure.id);
  });
  assert.match(inventory.items.find(i => i.id === "event:milestone.disclosure")?.blockingReason ?? "", /Cyclic/);
  assert.match(inventory.items.find(i => i.id === "event:milestone.reckoning")?.blockingReason ?? "", /Cyclic/);
  assert.equal(inventory.items.filter(i => i.stage === "event" && i.status === "verified").length, 0);
  assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
});

test("clean Event no-write prerequisite is blocked for typed plan approval without replay or new grants", { skip: !available }, () => {
  const f = setup("event-prerequisite-report");
  Object.assign(f.env, { NT_EVENT_FIXTURE_CASE: "no-write-prerequisite" });
  const first = f.cli(f.start);
  assert.equal(first.status, "blocked");
  const item = first.inventory.items.find((i: any) => i.id === "event:milestone.disclosure");
  assert.equal(item.status, "blocked");
  assert.match(item.blockingReason, /Clean no-write Event prerequisite report/);
  assert.match(item.blockingReason, /controller-approved bounded architecture\/work-plan revision/);
  assert.equal(first.inventory.items.find((i: any) => i.id === "interactive:milestone.disclosure").status,
    "blocked", "A Choice unit must not bypass its original Event prerequisite");
  const receiptPath = join(f.job.stateDir, "event-items/disclosure.json");
  const receipt = readFileSync(receiptPath, "utf8");
  assert.equal(JSON.parse(receipt).phase, "prerequisite-reported");
  const before = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const resumed = f.cli(["generate", "resume"]);
  assert.equal(resumed.status, "blocked");
  assert.equal(readFileSync(receiptPath, "utf8"), receipt,
    "The same completed no-write specialist must not be invoked twice");
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), before);
  assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
  assert.equal(resumed.inventory.version, first.inventory.version);
});

test("#212: a source-grounded upstream contradiction produces a sealed causal amendment, never a write grant", { skip: !available }, () => {
  const f = setup("causal-no-write");
  Object.assign(f.env, { NT_EVENT_FIXTURE_CASE: "no-write-causal" });
  const first = f.cli(f.start);
  assert.equal(first.status, "paused", first.reason);
  assert.equal(first.nextStage, null, "Pending causal amendment must not dispatch unrelated work");
  const proposal = first.causalAmendment;
  assert.equal(proposal?.schema, "noveltea-causal-amendment/v1", JSON.stringify(first));
  assert.equal(proposal.authority, "proposal-only");
  assert.equal(proposal.authorApprovalRequired, true);
  assert.equal(proposal.source.milestoneId, "milestone.disclosure");
  assert.equal(proposal.source.reportDigest.length, 64);
  assert.ok(proposal.affected.includes("event:milestone.disclosure"));
  assert.ok(proposal.affected.includes("interactive:milestone.disclosure"));
  assert.deepEqual(proposal.carryForward, [], "Legacy fixtures have no independent review assurance.");
  assert.ok(!proposal.carryForward.includes("event:milestone.disclosure"));
  const file = join(f.job.stateDir, "event-items/disclosure.json");
  const original = readFileSync(file, "utf8");
  assert.equal(JSON.parse(original).phase, "prerequisite-reported");
  const sha = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const again = f.cli(["generate", "resume"]);
  assert.equal(again.status, "paused", again.reason);
  assert.equal(again.nextStage, null);
  assert.deepEqual(again.causalAmendment, proposal);
  for (const [change, denied] of [
    [(receipt: any) => { receipt.jobId = "other-job"; }, /identity mismatch|source-bound|another job/i],
    [(receipt: any) => { receipt.planVersion++; }, /source-bound|plan/i],
    [(receipt: any) => { receipt.causalDiscovery.proposedCorrection = "Retcon all canon"; }, /sealed no-write source/i],
  ] as const) {
    const tampered = JSON.parse(original);
    change(tampered);
    writeFileSync(file, JSON.stringify(tampered));
    const attempt = spawnSync(process.execPath, [...cliEntry(), "job", "generate", "resume",
      "--story", f.story, "--job", "single"], {
      encoding: "utf8", env: f.env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    if (attempt.status === 0) {
      const result = JSON.parse(attempt.stdout);
      assert.equal(result.status, "blocked", result.reason);
      assert.match(result.reason, /causal|plan|source-bound|receipt|no-write/i);
    } else assert.match(attempt.stderr, denied);
    writeFileSync(file, original);
  }
  assert.equal(readFileSync(file, "utf8"), original);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), sha);
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.initial);
  assert.equal(git(f.job.worktreeRoot, "status", "--porcelain", "--untracked-files=all"), "");
});

test("#212: two independently ready Milestones do not advance HEAD while a causal amendment awaits disposition", { skip: !available }, () => {
  const f = setup("causal-two-ready");
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope.targets.push("milestone.reckoning");
  writeFileSync(f.contract, JSON.stringify(contract));
  Object.assign(f.env, { NT_EVENT_FIXTURE_CASE: "no-write-causal",
    NT_ARCHITECTURE_FIXTURE_CASE: "causal" });
  const first = f.cli(f.start);
  assert.equal(first.status, "paused", first.reason);
  assert.equal(first.nextStage, null);
  assert.ok(first.causalAmendment, "A failed original Event must remain approvable");
  assert.equal(first.causalAmendment.source.milestoneId, "milestone.disclosure");
  const independent = first.inventory.items.find((i: any) => i.id === "event:milestone.reckoning");
  assert.equal(independent?.status, "pending", "The other Milestone really is ready, not transitively blocked.");
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const second = f.cli(["generate", "resume"]);
  assert.equal(second.status, "paused", second.reason);
  assert.equal(second.nextStage, null);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
  assert.deepEqual(second.causalAmendment, first.causalAmendment);
  assert.equal(existsSync(join(f.job.stateDir, "event-items/reckoning.json")), false,
    "Independent Event must not run before author disposition.");
});

test("#212: exact author-signed causal replan revises only the contradicted Milestone", { skip: !available }, () => {
  const f = setup("causal-approved");
  Object.assign(f.env, { NT_EVENT_FIXTURE_CASE: "no-write-causal",
    NT_ARCHITECTURE_FIXTURE_CASE: "causal" });
  const blocked = f.cli(f.start);
  const candidate = blocked.causalAmendment;
  assert.equal(candidate.authority, "proposal-only", JSON.stringify(blocked));
  assert.match(f.cli(["architecture", "propose", "--contract", f.contract,
    "--causal-digest", "0".repeat(64)], false), /Causal replan|source-bound/);
  const proposed = f.cli(["architecture", "propose", "--contract", f.contract,
    "--causal-digest", candidate.digest]);
  const sig = authorApproval(f.story, "single", f.env, root,
    { ...proposed.authorSigningRequest, reason: "Approve exactly one correction to the contradictory ledger chronology." }).file;
  const approved = f.cli(["architecture", "approve", "--proposal", proposed.proposal.digest,
    "--approval", sig]);
  assert.equal(approved.plan.version, 2);
  assert.deepEqual(approved.plan.causalAmendment, candidate);
  const before = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const authored = f.cli(["architecture", "run", "--fixture", "--skills-source", source]);
  assert.equal(authored.plan.version, 2);
  assert.equal(authored.plan.items[0].status, "verified");
  assert.notEqual(authored.headSha, before);
  assert.deepEqual(git(f.job.worktreeRoot, "diff", "--name-only", before, authored.headSha)
    .split("\n"), ["story/milestones/disclosure.md"]);
  assert.match(readFileSync(join(f.job.worktreeStoryRoot, "milestones/disclosure.md"), "utf8"),
    /disputed timestamp/);
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.initial);
});

test("#233: authenticated author-directed Architecture change is visible in operator incident inspection", {
  skip: !available,
}, async () => {
  const f = setup("approved-author-incident");
  const original = JSON.parse(readFileSync(f.contract, "utf8"));
  original.scope = { kind: "full-story", depth: "composition", targets: [], branches: [] };
  writeFileSync(f.contract, JSON.stringify(original));
  saveFixtureTurn(f.job, original, f.start[3]!,
    ["The witness can be questioned without exposing confidential sources."]);
  const first = f.cli([...f.start, "--pause-after", "foundation"]);
  assert.equal(first.status, "paused", JSON.stringify(first));
  await sealFixtureGenerationCheckpoint(f, "foundation");
  const architecture = f.cli(["generate", "resume", "--pause-after", "architecture"]);
  assert.equal(architecture.status, "paused", JSON.stringify(architecture));
  await sealFixtureGenerationCheckpoint(f, "global-architecture");
  assert.equal(f.cli(["approval-revisions", "inspect"]).total, 0,
    "an approved Architecture with no later revision is not an incident");
  for (const key of ["NT_ARCHITECTURE_FIXTURE_CASE", "NT_EVENT_FIXTURE_CASE",
    "NT_INTERACTIVE_FIXTURE_CASE", "NT_COMPOSITION_FIXTURE_CASE"]) f.env[key] = "event-only";
  f.cli(["foundations", "run", "--fixture", "--skills-source", source], false);
  await sealFixtureGenerationCheckpoint(f, "world-foundations");
  f.cli(["foundations", "run", "--fixture", "--skills-source", source]);
  await sealFixtureGenerationCheckpoint(f, "character-foundations");
  const realized = f.cli(["generate", "resume", "--pause-after", "event"]);
  assert.equal(realized.status, "paused", JSON.stringify(realized));
  await sealFixtureGenerationCheckpoint(f, "event-disclosure");
  const authoredEventHead = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  assert.notEqual(authoredEventHead, architecture.inventory.headSha,
    "a real authored Event must follow the originally approved Architecture");
  const revisedFile = join(root, "approved-author-incident-v2.json");
  writeFileSync(revisedFile, JSON.stringify({
    ...original,
    constraints: [...original.constraints, "The author additionally requires a second ethical consequence"],
  }));
  const proposed = f.cli(["architecture", "propose", "--contract", revisedFile]);
  const signed = authorApproval(f.story, "single", f.env, root,
    { ...proposed.authorSigningRequest,
      reason: "I explicitly authorize this new author-directed ethical consequence in the signed scope." });
  const accepted = f.cli(["architecture", "approve", "--proposal", proposed.proposal.digest,
    "--approval", signed.file]);
  assert.equal(accepted.plan.version, 2);
  const incidents = f.cli(["approval-revisions", "inspect"]);
  assert.equal(incidents.total, 1, JSON.stringify(incidents));
  const incident = incidents.records[0];
  assert.equal(incident.kind, "architecture-author-revision");
  assert.equal(incident.cause, "author-directed");
  assert.equal(incident.severity, "info");
  assert.equal(incident.trigger.kind, "author-plan-revision");
  assert.equal(incident.triggeringSourceSha, authoredEventHead);
  assert.equal(incident.disposition, "carried-forward");
  assert.equal(incident.original.sourceSha, architecture.inventory.headSha);
  assert.equal(incident.successor, null,
    "a carried-forward Architecture commit is not an independently reviewed new successor");
  assert.equal(incident.successorApproval, null);
  assert.equal(f.cli(["approval-revisions", "inspect", "--cause", "author-directed"]).total, 1);
  assert.equal(f.cli(["approval-revisions", "inspect", "--severity", "warning"]).total, 0);
  const secondContract = join(root, "approved-author-incident-v3.json");
  const v2Contract = JSON.parse(readFileSync(revisedFile, "utf8"));
  writeFileSync(secondContract, JSON.stringify({
    ...v2Contract,
    constraints: [...v2Contract.constraints,
      "The author additionally requires a witnessed reconciliation before the final reveal"],
  }));
  const secondProposal = f.cli(["architecture", "propose", "--contract", secondContract]);
  const secondSignature = authorApproval(f.story, "single", f.env, root, {
    ...secondProposal.authorSigningRequest,
    reason: "I separately authorize the witnessed reconciliation in the revised completion contract.",
  });
  const secondApproval = f.cli(["architecture", "approve", "--proposal", secondProposal.proposal.digest,
    "--approval", secondSignature.file]);
  assert.equal(secondApproval.plan.version, 3);
  const both = f.cli(["approval-revisions", "inspect"]);
  assert.equal(both.total, 2, JSON.stringify(both));
  assert.equal(new Set(both.records.map((record: any) => record.id)).size, 2,
    "each separately signed replan must retain a unique incident ID");
  const second = both.records.find((record: any) => record.original.version === 2);
  assert.ok(second, "second signed replan must retain its own distinct incident ID");
  assert.notEqual(second.id, incident.id);
  assert.equal(second.disposition, "awaiting-review",
    "a new pending v3 Architecture is not an independently reviewed successor");
  assert.equal(second.successor, null);
  assert.equal(second.cause, "author-directed");
  assert.equal(second.original.sourceSha, architecture.inventory.headSha);
  assert.deepEqual(second.originalApproval, incident.originalApproval,
    "signed carry-forward must retain the original v1 independent review, not invent a v2 approval");
  assert.deepEqual(both.records.find((record: any) => record.id === incident.id), incident,
    "later signed replans must not alter the first historical incident");
  assert.equal(f.cli(["approval-revisions", "inspect", "--id", incident.id]).total, 1);
  assert.equal(f.cli(["approval-revisions", "inspect", "--id", second.id]).total, 1);
  // Exercise the REAL Studio incident-sync boundary, including event payload
  // validation, duplicate replay and the subsequent finished activity. An
  // owner-scoped in-memory events port avoids creating unrelated auth state.
  const { store, journal } = certificationActivityJournal();
  await syncApprovalRevisionActivity(store, "author-fixture", f.job.jobId, f.job);
  const activity = await listGenerationEvents(store, "author-fixture", f.job.jobId, 0);
  assert.equal(activity.length, 2);
  const firstActivity = activity.find(row => row.detail?.approvalRevision?.id === incident.id);
  const secondActivity = activity.find(row => row.detail?.approvalRevision?.id === second.id);
  assert.ok(secondActivity, "Studio must publish both signed replans");
  assert.deepEqual(firstActivity?.detail?.approvalRevision, {
    id: incident.id, scope: "story", milestoneId: null,
    cause: "author-directed", severity: "info", disposition: "carried-forward",
  }, "Studio must represent signed Story-wide Architecture without inventing a Milestone");
  assert.deepEqual(secondActivity?.detail?.approvalRevision, {
    id: second.id, scope: "story", milestoneId: null,
    cause: "author-directed", severity: "info", disposition: "awaiting-review",
  });
  await syncApprovalRevisionActivity(store, "author-fixture", f.job.jobId, f.job);
  assert.equal(journal.length, 2, "restart must not append duplicate incidents");
  await appendGenerationEvent(store, "author-fixture", f.job.jobId,
    { kind: "finished", status: "completed" });
  assert.equal((await listGenerationEvents(store, "author-fixture", f.job.jobId, 0))[2]?.kind,
    "finished", "incident syncing cannot prevent generation from finishing");
});

for (const stage of ["foundations", "event"] as const) test(
  "#237: actual parent verifier fences an uncarried reviewed " + stage +
  " result, then resumes only after signed reauthorization", { skip: !available }, async () => {
  const f = setup("verifier-real-architecture-carry-" + stage);
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope = { kind: "full-story", depth: "composition", targets: [], branches: [] };
  writeFileSync(f.contract, JSON.stringify(contract));
  saveFixtureTurn(f.job, contract, f.start[3]!,
    ["The original Foundations must survive only an explicitly signed author carry-forward."]);
  const first = f.cli([...f.start, "--pause-after", "foundation"]);
  assert.equal(first.status, "paused");
  await sealFixtureGenerationCheckpoint(f, "foundation");
  const architecture = f.cli(["generate", "resume", "--pause-after", "architecture"]);
  assert.equal(architecture.status, "paused");
  await sealFixtureGenerationCheckpoint(f, "global-architecture");
  f.cli(["foundations", "run", "--fixture", "--skills-source", source], false);
  await sealFixtureGenerationCheckpoint(f, "world-foundations");
  const completed = f.cli(["foundations", "run", "--fixture", "--skills-source", source]);
  assert.equal(completed.status, "foundations-committed");
  await sealFixtureGenerationCheckpoint(f, "character-foundations");
  if (stage === "event") {
    const foundationBoundary = f.cli(["generate", "resume", "--pause-after", "foundations"]);
    assert.equal(foundationBoundary.status, "paused", foundationBoundary.reason ?? undefined);
  }
  let originalHead = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const originalStatus = stage === "foundations" ? "foundations-committed" : "event-cluster-committed";
  const carryForward = stage === "foundations" ? ["foundations"]
    : ["foundations", "event:milestone.disclosure"];
  const beforeCalls = (await inspectPiPolicy(f.job)).budget.modelCalls;
  // Continue an ACTUAL previously created parent Thread from a copied
  // persisted checkpoint, not a manually assembled blocked graph state.
  const webDb = join(f.job.stateDir, "web-generation.sqlite");
  copyFileSync(join(f.job.stateDir, "generation.sqlite"), webDb);
  const selectionPath = join(f.job.stateDir, "orchestrator-selection.json");
  const originalSelection = readFileSync(selectionPath, "utf8");
  const originalTurn = JSON.parse(readFileSync(join(f.job.stateDir, "turn-plan.json"), "utf8"));
  // The CLI fixture predates source-bound Turn selection. Pin its existing
  // disposable selection once before resuming the graph with that Turn.
  const selectedTurn = JSON.stringify({ ...JSON.parse(originalSelection),
    turnPlanDigest: originalTurn.digest });
  writeFileSync(selectionPath, selectedTurn);
  const resumeOriginalCliArchitecture = () => {
    writeFileSync(selectionPath, originalSelection);
    try { return f.cli(["generate", "resume", "--pause-after", "architecture"]); }
    finally { writeFileSync(selectionPath, selectedTurn); }
  };
  const keys = ["NT_STATE_DIR", "NT_CONFIG_FILE", "NT_SKILL_CACHE_DIR"] as const;
  const previousEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) if (f.env[key]) process.env[key] = f.env[key];
  const threadId = f.job.threadId + ":generation";
  const config = { configurable: { thread_id: threadId } };
  const saver = SqliteSaver.fromConnString(webDb);
  try {
    const graph = createGenerationGraph(saver, "cli");
    const prior = await graph.getState(config);
    assert.equal(prior.values.status, "paused");
    const originalRequest = { ...prior.values.request,
      turnPlanDigest: originalTurn.digest };
    if (stage === "event") {
      // The parent itself must dispatch the Event; a direct CLI Event has a
      // different signed task and is correctly rejected as a substitution.
      const dispatched = await graph.invoke({ request: originalRequest }, {
        ...config, interruptBefore: ["independent_assignment_review"] });
      assert.equal(dispatched.active?.stage, "event", dispatched.reason ?? undefined);
      await sealFixtureGenerationCheckpoint(f, "event-disclosure");
    }
    const awaiting = await graph.invoke(stage === "event" ? null :
      { request: originalRequest }, {
      ...config, interruptBefore: ["verify_committed_work"] });
    originalHead = awaiting.result?.headSha ?? originalHead;
    assert.equal(awaiting.active?.stage, stage,
      "this must stop after the real specialist has returned: " +
        JSON.stringify({ status: awaiting.status, reason: awaiting.reason,
          next: (await graph.getState(config)).next, operationRecovery: awaiting.operationRecovery }));
    assert.equal(awaiting.result?.status, originalStatus);
    assert.equal(awaiting.result?.headSha, originalHead);
    assert.ok((await graph.getState(config)).next.includes("verify_committed_work"));

    // A real author-signed v2 plan intentionally omits old Foundations from
    // its carry-forward list. That is a genuine production verifier failure.
    const v2Path = join(root, "verifier-real-architecture-v2.json");
    writeFileSync(v2Path, JSON.stringify(contract));
    const v2Proposal = f.cli(["architecture", "propose", "--contract", v2Path]);
    const v2Signature = authorApproval(f.story, "single", f.env, root,
      { ...v2Proposal.authorSigningRequest,
        reason: "Approve a revised original-Turn Architecture without carrying prior Foundations." });
    const v2 = f.cli(["architecture", "approve", "--proposal", v2Proposal.proposal.digest,
      "--approval", v2Signature.file]);
    assert.equal(v2.plan.version, 2);
    assert.ok(!carryForward.some(id => v2.history.at(-1)?.carryForward?.includes(id)));
    const revisedV2 = resumeOriginalCliArchitecture();
    assert.equal(revisedV2.status, "paused", revisedV2.reason ?? undefined);
    await sealFixtureGenerationCheckpoint(f, "global-architecture");
    const sourceAtFailure = git(f.job.worktreeRoot, "rev-parse", "HEAD");
    assert.equal(sourceAtFailure, originalHead,
      "a signed plan-only revision must not invent a new Architecture Git commit");
    // The actual graph-owned verifier must capture the original result and
    // failure baseline itself. No test-originated assessment is injected.
    const checkpointedFailure = await graph.invoke(null, config);
    const failed = { ...checkpointedFailure,
      ...projectRecovery({ recoveryLifecycle: checkpointedFailure.recoveryLifecycle,
        recoverySources: checkpointedFailure.recoverySources }) };
    assert.equal(failed.status, "blocked", failed.reason);
    assert.equal(failed.operationRecovery?.operation, "commit-verification");
    assert.equal(failed.operationRecovery?.phase, "fenced");
    assert.equal(failed.operationRecovery?.evidence?.reference, "review-checkpoints");
    assert.match(failed.operationRecovery?.reason ?? "", /original completed specialist.*not authorized/i,
      "the real parent verifier must detect missing signed carry-forward, not a synthetic error");
    assert.equal(failed.operationRecovery?.evidence?.verifier?.resultHeadSha, originalHead);
    assert.equal(failed.operationRecovery?.evidence?.verifier?.failureHeadSha, sourceAtFailure);
    assert.equal(failed.active?.stage, stage);
    assert.equal(failed.result?.headSha, originalHead);
    assert.equal((await inspectPiPolicy(f.job)).budget.modelCalls, beforeCalls);
    assert.equal((await inspectBlockedOriginalThreadCorrection(f.job, threadId,
      failed)).eligible, false, "unchanged invalid approval remains fenced");

    // A second, independent signed author revision explicitly reauthorizes
    // the unchanged historically reviewed Foundations work.
    const carry = join(root, "verifier-real-foundations-carry.json");
    writeFileSync(carry, JSON.stringify(carryForward));
    const v3Path = join(root, "verifier-real-architecture-v3.json");
    writeFileSync(v3Path, JSON.stringify(contract));
    const v3Proposal = f.cli(["architecture", "propose", "--contract", v3Path,
      "--carry-forward", carry]);
    const v3Signature = authorApproval(f.story, "single", f.env, root,
      { ...v3Proposal.authorSigningRequest, reason: "Restore exact reviewed Foundations under the unchanged original Turn." });
    const v3 = f.cli(["architecture", "approve", "--proposal", v3Proposal.proposal.digest,
      "--approval", v3Signature.file]);
    assert.equal(v3.plan.version, 3);
    assert.deepEqual(v3.history.at(-1).carryForward, carryForward);
    const revisedV3 = resumeOriginalCliArchitecture();
    assert.equal(revisedV3.status, "paused", revisedV3.reason ?? undefined);
    await sealFixtureGenerationCheckpoint(f, "global-architecture");
    const correctedHead = git(f.job.worktreeRoot, "rev-parse", "HEAD");
    assert.equal(correctedHead, sourceAtFailure,
      "the second signed plan-only revision must preserve the original reviewed work");
    const expected = await inspectBlockedOriginalThreadCorrection(f.job, threadId, failed);
    assert.equal(expected.eligible, true, expected.reason);
    for (let restart = 0; restart < 2; restart++) {
      assert.deepEqual(await inspectBlockedOriginalThreadCorrection(f.job, threadId, failed), expected,
        "repeated read-only admission cannot mutate the original operation");
    }
    const refuse = async (altered: any, reason: string) =>
      assert.equal((await inspectBlockedOriginalThreadCorrection(f.job,
        threadId, altered)).eligible, false, reason);
    await refuse({ ...failed, graphThreadId: threadId + ":other" }, "Wrong Thread cannot recover");
    await refuse({ ...failed, result: null }, "Lost original completed result remains fenced");
    await refuse({ ...failed, result: { ...failed.result, headSha: "f".repeat(40) } },
      "Wrong original result HEAD cannot recover");
    await refuse({ ...failed, request: { ...failed.request, model: "substituted-model" } },
      "Changed selected model cannot recover");
    await refuse({ ...failed, completedStages: [...failed.completedStages,
      { stage, milestone: failed.active.milestone, headSha: originalHead }] },
      "Already acknowledged work cannot be counted twice");
    await refuse({ ...failed, recoverySources: failed.recoverySources.map((source: any) =>
      source.caseId !== failed.recoveryLifecycle.active?.id ? source : {
        ...source, input: { ...source.input,
          evidence: { ...source.input.evidence,
            verifier: { ...source.input.evidence.verifier, checkpointDigest: "f".repeat(64) } },
        },
      }) },
    "Tampered checkpoint digest cannot grant recovery");
    const reviewFile = join(f.job.stateDir, "independent-reviews", originalHead + ".json");
    const savedReview = readFileSync(reviewFile, "utf8");
    try {
      const damaged = JSON.parse(savedReview);
      damaged.status = "failed";
      writeFileSync(reviewFile, JSON.stringify(damaged));
      await refuse(failed, "Tampered original independent review cannot recover");
    } finally { writeFileSync(reviewFile, savedReview); }
    const draft = join(f.job.worktreeRoot, "untracked-original-verifier.txt");
    writeFileSync(draft, "An unreviewed writer draft");
    try { await refuse(failed, "Dirty original Story cannot recover"); }
    finally { unlinkSync(draft); }
    await setJobControl(f.job, "paused");
    try { await refuse(failed, "Author pause has priority over recovery"); }
    finally { await setJobControl(f.job, "running"); }
    assert.equal((await inspectPiPolicy(f.job)).budget.modelCalls, beforeCalls);
    assert.equal(await safeToResume(f.job, threadId, JSON.stringify(failed.request),
      false, "blocked"), "resume");
    // The real Studio SQLite queue must admit the SAME naturally blocked
    // graph Thread exactly once through its owner-scoped compare-and-swap.
    // Neither a fabricated request nor a second worker can consume this
    // verified recovery. The graph resumes only after the worker claims it.
    const queue = stage === "event" ? await openKyselyFeatureFixture("sqlite") : null;
    let queueWorker: { owner: string; at: string; request: string } | null = null;
    try {
      if (queue) {
        const owner = await queue.owner();
        const repo = "verifier-repo", story = "verifier-story";
        const at = "2026-11-22T12:00:00Z", later = "2026-11-22T13:00:00Z";
        const request = JSON.stringify(failed.request);
        await queue.records.insert("repositories", { id: repo, ownerUserId: owner,
          provider: "github", providerRepositoryId: repo, name: "Cert/Verifier",
          createdAt: at });
        await queue.records.insert("stories", { id: story, ownerUserId: owner,
          repositoryId: repo, directory: "story", title: "Verifier",
          sourceCommitSha: f.initial, createdAt: at });
        assert.equal(await queue.generation.jobs.register(owner, f.job.jobId,
          story, "Original verifier recovery", f.initial, at), true);
        await queue.generation.queue.enqueue(owner, f.job.jobId, "start", "prepared",
          at, request, threadId);
        assert.equal((await queue.generation.queue.claim("original-worker", 1, at))?.jobId, f.job.jobId);
        assert.equal(await queue.generation.jobs.start(owner, f.job.jobId,
          threadId, request, "original-worker", at), true);
        assert.equal(await queue.generation.jobs.finish(owner, f.job.jobId,
          threadId, "blocked", false, "original-worker", later), true);
        assert.equal(await queue.generation.queue.finish(f.job.jobId, "original-worker",
          true, later), true);
        const saved = { status: "blocked", request, thread: threadId };
        await assert.rejects(queue.generation.queue.reconcileAndEnqueue(owner,
          f.job.jobId, "resume", saved, false, later),
          /lacks verified original-Thread recovery/);
        await assert.rejects(queue.generation.queue.reconcileAndEnqueue(owner,
          f.job.jobId, "resume", { ...saved, thread: threadId + ":other" },
          false, later, true, "approved-work"),
          /verified checkpoint/);
        await queue.generation.queue.reconcileAndEnqueue(owner, f.job.jobId,
          "resume", saved, false, later, true, "approved-work");
        assert.equal((await queue.generation.queue.record(f.job.jobId))?.resumeKind,
          "approved-work");
        await assert.rejects(queue.generation.queue.reconcileAndEnqueue(owner,
          f.job.jobId, "resume", saved, false, later, true, "approved-work"),
          /verified checkpoint/, "a duplicate resume cannot enqueue another worker");
        const claimed = await queue.generation.queue.claim("recovery-worker", 1, later);
        assert.equal(claimed?.resumeKind, "approved-work");
        assert.equal((await queue.generation.jobs.state(owner, f.job.jobId))?.threadId,
          threadId);
        assert.equal(await queue.generation.jobs.start(owner, f.job.jobId,
          threadId, request, "recovery-worker", later), true);
        queueWorker = { owner, at: later, request };
      }
    // The very same persisted Thread is restarted in production server mode.
    const architectureReceipt = JSON.parse(readFileSync(
      join(f.job.stateDir, "architecture.json"), "utf8"));
    assert.equal(JSON.stringify(architectureReceipt.history?.find((h: any) =>
      h.plan.version === failed.planVersion)?.plan.contract),
    JSON.stringify(failed.request.contract),
    "the original request must equal its historical approved plan: " +
      JSON.stringify({ request: failed.request.contract,
        earlier: architectureReceipt.history?.find((h: any) =>
          h.plan.version === failed.planVersion)?.plan.contract,
        current: architectureReceipt.plan.contract }));
    const server = createGenerationGraph(saver, "server");
    const restored = await server.invoke({ request: failed.request }, {
      ...config, interruptAfter: ["verify_committed_work"] });
    assert.equal(currentOperationRecovery(restored), null, restored.reason ?? undefined);
    assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, threadId),
      restored.recoveryLifecycle,
      "C07 restored commit verifier must authenticate the original reviewed source and signed carry-forward");
    assert.equal(restored.completedStages.filter((entry: any) =>
      entry.stage === stage && entry.headSha === originalHead).length, 1);
    assert.equal(restored.result, null);
    assert.equal((await inspectPiPolicy(f.job)).budget.modelCalls, beforeCalls);
    assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), correctedHead);
    assert.equal((await server.getState(config)).values.graphThreadId, threadId);
    // This disposable fixture was started by the CLI. After Studio has
    // recovered the verifier, ordinary subsequent scheduling belongs to its
    // original CLI owner; server takeover would correctly be prohibited.
    const originalOwner = createGenerationGraph(saver, "cli");
    const subsequent = await originalOwner.invoke({ request: restored.request }, {
      ...config, interruptBefore: ["specialist_dispatch"] });
    assert.equal(subsequent.status, "running",
      "original verifier must continue to a normally authorized dependent, not re-dispatch itself: " +
      String(subsequent.reason));
    assert.ok(subsequent.active && subsequent.active.id !== failed.active.id,
      "the controller must select subsequent authorized work, not repeat the original specialist");
    assert.equal(subsequent.completedStages.filter((entry: any) =>
      entry.stage === stage && entry.headSha === originalHead).length, 1);
    assert.equal((await inspectPiPolicy(f.job)).budget.modelCalls, beforeCalls,
      "next safe boundary does not repeat a reviewer, writer or planner call");
    assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), correctedHead);
    if (queue && queueWorker) {
      assert.equal(await queue.generation.jobs.finish(queueWorker.owner, f.job.jobId,
        threadId, "paused", false, "recovery-worker", queueWorker.at), true);
      assert.equal(await queue.generation.queue.finish(f.job.jobId,
        "recovery-worker", true, queueWorker.at), true);
      assert.equal((await queue.generation.queue.record(f.job.jobId))?.phase, "finished");
    }
    } finally { await queue?.close(); }
    // A cancelled historical job never gains a second admission even after
    // its earlier source/approval checks happened to pass.
    await setJobControl(f.job, "cancelled");
    await refuse(failed, "Cancellation remains terminal across repeated inspection");
  } finally {
    saver.db.close();
    writeFileSync(selectionPath, originalSelection);
    for (const key of keys) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  }
});

test("#212: certified predecessor is carried across approval, corrected source gets a fresh Event and Blueprint", { skip: !available }, async () => {
  const f = setup("causal-reviewed-continuation");
  Object.assign(f.env, { NT_EVENT_FIXTURE_CASE: "no-write-causal",
    NT_ARCHITECTURE_FIXTURE_CASE: "causal" });
  saveFixtureTurn(f.job, JSON.parse(readFileSync(f.contract, "utf8")), f.start[3]!,
    ["A signed ledger chronology must be reconciled with independent access evidence."]);
  const first = f.cli([...f.start, "--pause-after", "foundation"]);
  assert.equal(first.status, "paused", JSON.stringify(first));
  await sealFixtureGenerationCheckpoint(f, "foundation");
  const architecture = f.cli(["generate", "resume", "--pause-after", "architecture"]);
  assert.equal(architecture.status, "paused", JSON.stringify(architecture));
  await sealFixtureGenerationCheckpoint(f, "global-architecture");
  f.cli(["foundations", "run", "--fixture", "--skills-source", source], false);
  await sealFixtureGenerationCheckpoint(f, "world-foundations");
  f.cli(["foundations", "run", "--fixture", "--skills-source", source]);
  await sealFixtureGenerationCheckpoint(f, "character-foundations");
  // #237: A completed Foundations specialist can retain its reviewed original
  // source across a later independently signed Architecture carry-forward.
  const originalFoundationsHead = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const originalTurn = JSON.parse(readFileSync(join(f.job.stateDir, "turn-plan.json"), "utf8"));
  const originalFoundationsAssignment = { id: "foundations", stage: "foundations" as const };
  const originalFoundationsResult = { status: "foundations-committed", headSha: originalFoundationsHead };
  const originalFoundationsProof = await captureVerificationFailure(f.job, originalTurn.digest,
    originalFoundationsAssignment, originalFoundationsResult, 1);
  const originalWebThread = f.job.threadId + ":generation:web";
  const originalVerifierAssessment = await assessGenerationOperation({
    job: f.job, threadId: originalWebThread, turnDigest: originalTurn.digest,
    planVersion: 1, operation: "commit-verification", outcome: "exception",
    reason: "Original dependent prerequisites lacked a signed controller transition.",
    evidence: { reference: "review-checkpoints", assignmentId: "foundations",
      verifier: originalFoundationsProof },
  });
  assert.equal((await verifyCorrectedOriginalResult(f.job, originalTurn.digest,
    originalFoundationsAssignment, originalFoundationsResult, originalFoundationsProof, 1)).eligible,
    false, "An unchanged verifier cannot be retried without a new signed correction.");
  const blocked = f.cli(["generate", "resume"]);
  const candidate = blocked.causalAmendment;
  assert.equal(blocked.status, "paused", blocked.reason);
  assert.ok(candidate?.carryForward.includes("foundations"), JSON.stringify(candidate));
  assert.equal(f.cli(["approval-revisions", "inspect"]).total, 0,
    "A proposed model challenge without controller approval is not a revision.");
  const carry = join(root, "causal-reviewed-carry.json");
  writeFileSync(carry, JSON.stringify(candidate.carryForward));
  const proposed = f.cli(["architecture", "propose", "--contract", f.contract,
    "--causal-digest", candidate.digest, "--carry-forward", carry]);
  const signature = authorApproval(f.story, "single", f.env, root,
    { ...proposed.authorSigningRequest, reason: "Authorize the exact one-Milestone correction and independently reviewed carry-forward." });
  const authorized = f.cli(["architecture", "approve", "--proposal", proposed.proposal.digest,
    "--approval", signature.file]);
  assert.equal(authorized.plan.version, 2);
  assert.deepEqual(authorized.history.at(-1).carryForward, ["foundations"]);
  const pending = f.cli(["approval-revisions", "inspect", "--milestone", "milestone.disclosure"]);
  assert.equal(pending.total, 1, JSON.stringify(pending));
  const incident = pending.records[0];
  assert.equal(incident.kind, "architecture-causal-amendment");
  assert.equal(incident.cause, "unclassified", "Later evidence does not prove a historical approval escape.");
  assert.equal(incident.severity, "warning");
  assert.equal(incident.disposition, "awaiting-review");
  assert.deepEqual(incident.affectedWork, candidate.affected);
  assert.equal(incident.original.version, 1);
  assert.equal(incident.originalApproval.commitSha, architecture.inventory.headSha);
  assert.equal(incident.successorApproval, null);
  assert.equal(f.cli(["approval-revisions", "inspect", "--id", incident.id]).total, 1);
  const corrected = f.cli(["generate", "resume", "--pause-after", "architecture"]);
  assert.equal(corrected.status, "paused", JSON.stringify(corrected));
  assert.equal(f.cli(["approval-revisions", "inspect"]).records[0].disposition, "awaiting-review",
    "A corrected canonical commit is not independent approval.");
  await sealFixtureGenerationCheckpoint(f, "global-architecture");
  const reviewedRevision = f.cli(["approval-revisions", "inspect"]);
  assert.equal(reviewedRevision.total, 1, JSON.stringify(reviewedRevision));
  assert.equal(reviewedRevision.records[0].id, incident.id);
  assert.equal(reviewedRevision.records[0].disposition, "corrected");
  assert.equal(reviewedRevision.records[0].originalReviewDigest, incident.originalReviewDigest,
    "Historical reviewer evidence remains immutable.");
  assert.notEqual(reviewedRevision.records[0].successor.sourceSha, incident.original.sourceSha);
  const verifiedFoundations = await verifyCorrectedOriginalResult(f.job, originalTurn.digest,
    originalFoundationsAssignment, originalFoundationsResult, originalFoundationsProof, 1);
  assert.equal(verifiedFoundations.eligible, true, verifiedFoundations.reason);
  assert.notEqual(git(f.job.worktreeRoot, "rev-parse", "HEAD"), originalFoundationsHead,
    "a signed revised Architecture may advance HEAD while carrying the earlier Foundations");
  const forgedFoundations = await verifyCorrectedOriginalResult(f.job, originalTurn.digest,
    originalFoundationsAssignment, originalFoundationsResult,
    { ...originalFoundationsProof, planVersion: 2 }, 1);
  assert.equal(forgedFoundations.eligible, false, "the original plan version cannot be reassigned");
  // Current-format verifier recovery and signed carry-forward are certified
  // through the actual graph in #237 above. Do not assemble a blocked graph
  // by injecting the retired operationRecovery checkpoint channel here.
  const resumed = f.cli(["generate", "resume", "--pause-after", "event"]);
  assert.equal(resumed.status, "paused", JSON.stringify(resumed));
  assert.equal(resumed.inventory.items.find((item: any) =>
    item.id === "event:milestone.disclosure").status, "verified");
  const eventHistory = join(f.job.stateDir, "event-causal-history",
    "disclosure-" + candidate.source.reportDigest + ".json");
  assert.equal(JSON.parse(readFileSync(eventHistory, "utf8")).phase, "prerequisite-reported");
  const event = JSON.parse(readFileSync(join(f.job.stateDir, "event-items/disclosure.json"), "utf8"));
  assert.equal(event.phase, "committed");
  const obsolete = await verifyCorrectedOriginalResult(f.job, originalTurn.digest,
    originalFoundationsAssignment, originalFoundationsResult, originalFoundationsProof, 1);
  assert.equal(obsolete.eligible, false,
    "a later Event commit cannot revive the older Foundations verifier after signed carry-forward");
  assert.match(obsolete.reason, /later work cannot revive/);
  assert.equal(event.planVersion, 2);
  assert.notEqual(event.expectedHead, candidate.source.sha);
  assert.deepEqual(f.cli(["approval-revisions", "inspect"]).records[0], reviewedRevision.records[0],
    "Restart and dependent Event work must not rewrite a settled Architecture incident.");
  const historicalEventPath = join(f.job.stateDir, "event-causal-history",
    "disclosure-" + candidate.source.reportDigest + ".json");
  const historicalEvent = readFileSync(historicalEventPath, "utf8");
  const forged = JSON.parse(historicalEvent);
  forged.causalDiscovery.proposedCorrection = "Invent a new ending";
  writeFileSync(historicalEventPath, JSON.stringify(forged));
  assert.match(f.cli(["approval-revisions", "inspect"], false),
    /altered or stale Event causal evidence|no-write report changed/i);
  writeFileSync(historicalEventPath, historicalEvent);
  const signedArchitecture = join(f.job.stateDir, "architecture.json");
  const authentic = readFileSync(signedArchitecture, "utf8");
  const mismatched = JSON.parse(authentic);
  mismatched.history[0].causalAmendment.source.sha = "0".repeat(40);
  writeFileSync(signedArchitecture, JSON.stringify(mismatched));
  assert.match(f.cli(["approval-revisions", "inspect"], false),
    /history lacks matching controller authorization|approved plan revision|identity/i);
  writeFileSync(signedArchitecture, authentic);
  const missingHistory = JSON.parse(authentic);
  delete missingHistory.history;
  writeFileSync(signedArchitecture, JSON.stringify(missingHistory));
  assert.match(f.cli(["approval-revisions", "inspect"], false),
    /lost its historical signed plan evidence/i,
    "A committed correction cannot discard its signed revision history.");
  writeFileSync(signedArchitecture, authentic);
  assert.equal(f.cli(["approval-revisions", "inspect"]).records[0].id, incident.id);
  const originalReviewFile = join(f.job.stateDir, "independent-reviews",
    incident.original.sourceSha + ".json");
  const sealedOriginalReview = readFileSync(originalReviewFile, "utf8");
  const corruptedReview = JSON.parse(sealedOriginalReview);
  corruptedReview.status = "failed";
  writeFileSync(originalReviewFile, JSON.stringify(corruptedReview));
  assert.match(f.cli(["approval-revisions", "inspect"], false),
    /untrustworthy historical checkpoint|lost its historical approved checkpoint/i,
    "A tampered original review must not silently remove a historical warning.");
  writeFileSync(originalReviewFile, sealedOriginalReview);
  const originalCheckpointFile = join(f.job.stateDir, "recovery-checkpoints",
    incident.original.sourceSha + ".json");
  const originalCheckpoint = readFileSync(originalCheckpointFile, "utf8");
  unlinkSync(originalCheckpointFile);
  assert.match(f.cli(["approval-revisions", "inspect"], false),
    /lost its historical approved checkpoint/i,
    "Deleting original approval evidence must not silently hide the warning.");
  writeFileSync(originalCheckpointFile, originalCheckpoint);
  assert.equal(f.cli(["approval-revisions", "inspect"]).records[0].id, incident.id);
  const originalPlan = join(f.job.stateDir, "milestone-blueprint-history");
  assert.equal(existsSync(originalPlan), true);

  // The immutable Foundations receipt is still v1. Requiring it to match
  // only the immediately preceding Architecture v2 would strand v3.
  const foundationPath = join(f.job.stateDir, "character-world.json");
  const foundationV1 = readFileSync(foundationPath, "utf8");
  const nextProposal = f.cli(["architecture", "propose", "--contract", f.contract,
    "--carry-forward", carry]);
  const nextSignature = authorApproval(f.story, "single", f.env, root, {
    ...nextProposal.authorSigningRequest,
    reason: "Retain the independently reviewed v1 foundations through a second scoped amendment.",
  });
  const nextApproved = f.cli(["architecture", "approve", "--proposal",
    nextProposal.proposal.digest, "--approval", nextSignature.file]);
  assert.equal(nextApproved.plan.version, 3);
  assert.ok(nextApproved.history.slice(-2).every((step: any) =>
    step.carryForward.includes("foundations")));
  f.cli(["architecture", "run", "--fixture", "--skills-source", source]);
  const reused = f.cli(["foundations", "run", "--fixture", "--skills-source", source]);
  assert.equal(f.cli(["approval-revisions", "inspect"]).records[0].id, incident.id,
    "Later approved plan versions cannot erase the settled incident.");
  assert.equal(reused.status, "foundations-committed");
  assert.equal(reused.planVersion, 1, "The original v1 receipt remains historically authoritative.");
  assert.equal(readFileSync(foundationPath, "utf8"), foundationV1,
    "The originally reviewed foundation receipt must not be rewritten to v2 or v3.");
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.initial);
  assert.equal(git(f.job.worktreeRoot, "status", "--porcelain", "--untracked-files=all"), "");
});

test("clean no-write Event report authorizes one new bounded Event setup without changing Choice grants", { skip: !available }, () => {
  const f = setup("event-prerequisite-reassign");
  Object.assign(f.env, { NT_EVENT_FIXTURE_CASE: "no-write-once" });
  const result = f.cli(f.start);
  const event = result.inventory.items.find((i: any) => i.id === "event:milestone.disclosure");
  assert.equal(event.status, "verified", JSON.stringify(event));
  const receiptPath = join(f.job.stateDir, "event-items/disclosure.json");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(receipt.phase, "committed");
  assert.equal(receipt.reroutedFrom?.length, 64);
  assert.equal(receipt.reroutedTask?.includes("Do not bind Choice outcomes"), true);
  const archive = join(f.job.stateDir, "event-prerequisite-history",
    "disclosure-" + receipt.reroutedFrom + ".json");
  const original = JSON.parse(readFileSync(archive, "utf8"));
  assert.equal(original.phase, "prerequisite-reported");
  assert.equal(original.prerequisite.reportDigest, receipt.reroutedFrom);
  assert.deepEqual(original.claimedPaths, []);
  assert.equal(original.expectedHead, receipt.expectedHead);
  assert.equal(result.inventory.items.find((i: any) => i.id === "interactive:milestone.disclosure")?.status,
    "verified", "Authorized downstream Choice work resumes only after a real Event commit");
  const before = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  f.cli(["generate", "resume"]);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), before);
  assert.equal(readFileSync(receiptPath, "utf8"), JSON.stringify(receipt, null, 2) + "\n",
    "A restart cannot repeat the original no-write report or Event writer");
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.initial,
    "The source author's checkout stays unmodified");
});

test("S14 #173: clean unmet access evidence gets one authorized Event reassignment, then Choice can proceed", {
  skip: !available,
}, () => {
  const f = setup("event-local-access-evidence");
  Object.assign(f.env, { NT_EVENT_FIXTURE_CASE: "no-write-evidence-once" });
  const result = f.cli(f.start);
  const stage = result.inventory.items.find((i: any) => i.id === "event:milestone.disclosure");
  assert.equal(stage?.status, "verified", JSON.stringify(stage));
  const receiptPath = join(f.job.stateDir, "event-items/disclosure.json");
  const raw = readFileSync(receiptPath, "utf8");
  const receipt = JSON.parse(raw);
  assert.equal(receipt.phase, "committed");
  assert.match(receipt.reroutedTask, /IN-SCOPE EVENT EVIDENCE/);
  const originalPath = join(f.job.stateDir, "event-prerequisite-history",
    "disclosure-" + receipt.reroutedFrom + ".json");
  const original = JSON.parse(readFileSync(originalPath, "utf8"));
  assert.equal(original.phase, "prerequisite-reported");
  assert.deepEqual(original.claimedPaths, []);
  assert.deepEqual(original.obligations, []);
  assert.equal(original.prerequisite.reportDigest, receipt.reroutedFrom);
  assert.equal(result.inventory.items.find((i: any) =>
    i.id === "interactive:milestone.disclosure")?.status, "verified",
    "Downstream Choice must wait for a real, verified Event commit.");
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  f.cli(["generate", "resume"]);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
  assert.equal(readFileSync(receiptPath, "utf8"), raw, "The original no-write turn cannot be replayed.");
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.initial);
  assert.equal(git(f.job.worktreeRoot, "status", "--porcelain", "--untracked-files=all"), "");
});

test("S14 #173: competing-account evidence no-write gets one Event-local retry without replay", {
  skip: !available,
}, () => {
  const f = setup("event-local-competing-accounts");
  Object.assign(f.env, { NT_EVENT_FIXTURE_CASE: "no-write-accounts-once" });
  const result = f.cli(f.start);
  assert.equal(result.inventory.items.find((i: any) =>
    i.id === "event:milestone.disclosure")?.status, "verified");
  const receiptPath = join(f.job.stateDir, "event-items/disclosure.json");
  const saved = readFileSync(receiptPath, "utf8");
  const receipt = JSON.parse(saved);
  assert.equal(receipt.phase, "committed");
  assert.match(receipt.reroutedTask, /independent observation/);
  assert.match(receipt.reroutedTask, /new on-page testimony/);
  const previous = JSON.parse(readFileSync(join(f.job.stateDir,
    "event-prerequisite-history/disclosure-" + receipt.reroutedFrom + ".json"), "utf8"));
  assert.equal(previous.phase, "prerequisite-reported");
  assert.deepEqual(previous.claimedPaths, []);
  assert.deepEqual(previous.obligations, []);
  assert.match(previous.conflicts[0], /sources establish neither/);
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  f.cli(["generate", "resume"]);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
  assert.equal(readFileSync(receiptPath, "utf8"), saved);
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.initial);
});

test("rerouted Event task and original receipt remain immutable across recovery", { skip: !available }, () => {
  const f = setup("event-prerequisite-immutable");
  Object.assign(f.env, { NT_EVENT_FIXTURE_CASE: "no-write-once" });
  const first = f.cli(f.start);
  assert.equal(first.inventory.items.find((i: any) => i.id === "event:milestone.disclosure")?.status,
    "verified");
  const file = join(f.job.stateDir, "event-items/disclosure.json");
  const saved = readFileSync(file, "utf8");
  const current = JSON.parse(saved);
  const eventArgs = ["event", "run", "--fixture", "--milestone", "milestone.disclosure",
    "--skills-source", source];
  writeFileSync(file, JSON.stringify({ ...current, reroutedTask: "Change all protected records." }));
  assert.match(f.cli(eventArgs, false), /task changed/);
  writeFileSync(file, saved);
  const history = join(f.job.stateDir, "event-prerequisite-history",
    "disclosure-" + current.reroutedFrom + ".json");
  const original = readFileSync(history, "utf8");
  const tampered = JSON.parse(original);
  tampered.conflicts = ["Different report"];
  writeFileSync(history, JSON.stringify(tampered));
  assert.match(f.cli(eventArgs, false), /Event no-write report changed or does not match its sealed source/);
  writeFileSync(history, original);
  const recovered = f.cli(eventArgs);
  assert.equal(recovered.status, "event-cluster-committed");
});

test("second no-write report and protected prerequisite remain honestly blocked", { skip: !available }, () => {
  for (const variant of ["no-write-prerequisite", "no-write-protected"]) {
    const f = setup("event-prerequisite-" + variant);
    Object.assign(f.env, { NT_EVENT_FIXTURE_CASE: variant });
    const first = f.cli(f.start);
    assert.equal(first.status, "blocked");
    const receiptPath = join(f.job.stateDir, "event-items/disclosure.json");
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    assert.equal(receipt.phase, "prerequisite-reported");
    assert.equal(Boolean(receipt.reroutedFrom), variant === "no-write-prerequisite",
      JSON.stringify({ variant, status: first.status, reason: first.reason,
        phase: receipt.phase, failure: receipt.failure }));
    assert.equal(first.inventory.items.find((i: any) => i.id === "interactive:milestone.disclosure")?.status,
      "blocked");
    const before = git(f.job.worktreeRoot, "rev-parse", "HEAD");
    const resumed = f.cli(["generate", "resume"]);
    assert.equal(resumed.status, "blocked");
    assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), before);
    assert.equal(git(f.job.worktreeRoot, "status", "--porcelain", "--untracked-files=all"), "");
    assert.equal(readFileSync(receiptPath, "utf8"), JSON.stringify(receipt, null, 2) + "\n");
  }
});

test("C04 Review strategy demands the original sealed failed Pi cycle before any correction attempt", { skip: !available }, async () => {
  const f = setup("c04-original-review-gate");
  saveFixtureTurn(f.job, JSON.parse(readFileSync(f.contract, "utf8")), f.start[3]!,
    ["Do not let an independent reviewer authorize its own writer or erase a negative finding."]);
  const paused = f.cli([...f.start, "--pause-after", "foundation"]);
  assert.equal(paused.status, "paused");
  const prior = Object.fromEntries(Object.keys(f.env).map(key => [key, process.env[key]]));
  Object.assign(process.env, f.env);
  try {
    const job = await startStoryJob({ story: f.story, job: "single" }, false);
    const point = (await inspectRecoveryCheckpoints(job)).find(p =>
      p.eligible && p.workItem === "foundation");
    assert.ok(point?.assurance);
    const { packet, verdict } = await reviewBoundedAssignments(job, [point], async p => {
      const item = p.items[0]!;
      const path = item.assurance.changedPaths[0]!;
      return { sourceDigest: p.sourceDigest, verdict: "fail" as const, findings: [{
        commitSha: item.assurance.commitSha, assignmentId: item.assignment.id,
        path, line: 1, kind: "missing-requirement" as const,
        message: "The source-bound witness is still absent.",
        requiredCorrection: "Correct the existing source's witness evidence.",
        affectedPaths: [path],
      }], evidence: [] };
    }, "independent-pi-assignment-review", true);
    const origin = {
      jobId: job.jobId, jobThreadId: job.threadId,
      graphThreadId: job.threadId + ":generation", turnDigest: point.assurance.turnDigest,
      planVersion: point.planVersion, sourceHeadSha: point.commitSha,
      assignmentId: "foundation", operation: "independent-review",
      check: "independent-assignment-review.v1", checkVersion: 1,
      failureAnchor: { store: "graph-checkpoint", ref: "original-review-task",
        failedCheckInstanceId: "original-review-check" },
    } as RecoveryCase["origin"];
    const failure = { id: "a".repeat(64), origin, observation: "returned-failure",
      kind: "semantic", effect: "read-only", evidence: [{
        store: "graph-checkpoint", ref: "original-review-task" }] } as RecoveryCase;
    const state = {
      request: { ...paused.request, job: job.jobId, fixture: false,
        turnPlanDigest: point.assurance.turnDigest },
      planVersion: point.planVersion,
      active: { id: "foundation" }, result: { status: "committed", headSha: point.commitSha },
      escalation: null, recoverySources: [{ caseId: failure.id, channel: "operationRecovery",
        input: { operation: "independent-review", outcome: "returned-failure",
          evidence: { reference: "review-checkpoints", assignmentId: "foundation" } } }],
    } as unknown as GenerationGraphState;
    assert.equal(await originalFailedReviewProof(job, state, failure), null,
      "Even a plausible stored negative verdict cannot impersonate an invoked reviewer");
    assert.equal(await selectOperationStrategy(job, state, failure), null);
    const sessionId = "c04-independent-review";
    const sessionFile = join(job.stateDir, "review-sessions", "assignment-fidelity", "c04-original.jsonl");
    mkdirSync(join(job.stateDir, "review-sessions", "assignment-fidelity"), { recursive: true });
    writeFileSync(sessionFile, JSON.stringify({ type: "session", id: sessionId }) + "\n");
    const method = { id: "b".repeat(64), path: join(job.stateDir, "pinned-review-skills") } as SkillSnapshot;
    const cycle = await bindPostcommitReviewCycle(job, packet, method,
      "openai", "gpt-6", undefined, { id: sessionId, file: sessionFile });
    assert.ok(cycle);
    appendFileSync(sessionFile, JSON.stringify({ type: "message", message: {
      role: "assistant", stopReason: "stop",
      content: [{ type: "text", text: JSON.stringify(verdict) }],
    } }) + "\n");
    await acceptPostcommitReviewRound(job, packet, verdict, cycle);
    const selected = await selectOperationStrategy(job, state, failure);
    assert.equal(selected?.action, "known-correction");
    assert.equal(selected?.action === "known-correction" ? selected.adapter : null, "review-cycle");
    assert.equal(selected?.evidence.at(-1)?.store, "review-checkpoint");
    assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), point.commitSha,
      "Strategy selection alone cannot mutate Story or start a correction writer");
    const saver = SqliteSaver.fromConnString(paused.checkpointPath);
    try {
      let correctionCalls = 0;
      const graph = createGenerationGraph(saver, "cli", async (s, authorized) => {
        if (!authorized) return { operationRecovery: await assessGenerationOperation({
          job, threadId: paused.threadId, turnDigest: s.request.turnPlanDigest ?? undefined,
          planVersion: s.planVersion, operation: "independent-review",
          outcome: "returned-failure", reason: "Original independent failed review",
          evidence: { reference: "review-checkpoints", assignmentId: "foundation" },
        }) };
        correctionCalls++;
        return { result: s.result,
          reason: "A mock adapter claims progress without a corrective Pi/Review receipt." };
      });
      const cfg = { configurable: { thread_id: paused.threadId } };
      const initial = (await graph.getState(cfg)).values;
      await graph.updateState(cfg, {
        status: "running", reason: null, active: paused.inventory.items.find((i: { id: string }) =>
          i.id === "foundation"), result: { status: "committed", headSha: point.commitSha },
        request: { ...initial.request, fixture: false, turnPlanDigest: point.assurance.turnDigest },
        planVersion: point.planVersion, pauseAfter: null,
      }, "specialist_dispatch");
      const admitted = await graph.invoke(null, { ...cfg, interruptBefore: ["assess_recovery"] });
      assert.equal(admitted.recoveryLifecycle.active?.origin.operation, "independent-review");
      assert.equal(admitted.recoveryLifecycle.attempt, null);
      assert.equal(correctionCalls, 0);
      const approved = await graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] });
      assert.equal(approved.recoveryLifecycle.decision?.action, "known-correction");
      assert.equal(approved.recoveryLifecycle.decision?.adapter, "review-cycle");
      assert.equal(approved.recoveryLifecycle.assessorPending, true);
      assert.equal(correctionCalls, 0, "Controller decision checkpoints before any correction agent");
      assert.deepEqual(await inspectModernGenerationRecovery(job, saver, paused.threadId),
        approved.recoveryLifecycle, "Restart inspection authenticates the source-selected Review correction");
      const execution = await graph.invoke(null, { ...cfg,
        interruptBefore: ["independent_assignment_review"] });
      assert.equal(execution.recoveryLifecycle.assessorPending, false);
      assert.equal(execution.recoveryLifecycle.phase, "correcting");
      assert.equal(correctionCalls, 0, "Assessor executes no replacement writer or reviewer");
      const stopped = await graph.invoke(null, {
        ...cfg, interruptAfter: ["independent_assignment_review"],
      });
      assert.equal(stopped.status, "blocked");
      assert.match(stopped.reason ?? "", /original committed Pi writer identity/i,
        "The checkpointed Review child must reject a fixture writer before dispatching a correction");
      assert.equal(correctionCalls, 0, "A forged fixture writer cannot enter the old correction callback");
      assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), point.commitSha);
      assert.equal(stopped.recoveryLifecycle.discharged.length, 0);
      assert.equal(stopped.recoveryLifecycle.active?.id, admitted.recoveryLifecycle.active?.id);
    } finally {
      saver.db.close();
    }
    const reviewFile = join(job.stateDir, "independent-reviews", point.commitSha + ".json");
    const reviewBytes = readFileSync(reviewFile, "utf8");
    const falsified = JSON.parse(reviewBytes);
    falsified.findings[0].message = "A plausible but unreviewed new semantic finding.";
    writeFileSync(reviewFile, JSON.stringify(falsified));
    assert.equal(await originalFailedReviewProof(job, state, failure), null,
      "A mutated verdict cannot borrow a valid independent Pi cycle and old transcript");
    writeFileSync(reviewFile, reviewBytes);
    const originalBytes = readFileSync(sessionFile, "utf8");
    writeFileSync(sessionFile, originalBytes.replace(
      '"id":"c04-independent-review"', '"id":"forged-independent-review"'));
    await assert.rejects(originalFailedReviewProof(job, state, failure), /transcript|identity|session/i,
      "Tampered reviewer session must invalidate the selected original operation");
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});


for (const accepted of [true, false]) test(
  "R14H original parent adaptive planner " + (accepted ? "reconciles accepted effect" : "refuses rejected proposal"),
  { skip: !available, timeout: 180_000 }, async () => {
  const f = setup("r14h-adaptive-" + accepted, story => {
    mkdirSync(join(story, "creative-direction"), { recursive: true });
    writeFileSync(join(story, "creative-direction/foundation.md"), [
      "---", "schema: '0.1'", "type: creative-direction", "id: creative-direction.foundation",
      'title: "The archive witness"', "status: approved", "decisions: []",
      'premise: "A witness disappeared after a disputed ledger transfer"',
      'central_conflict: "Verify the ledger before the later disclosure choice"',
      'genre: "Mystery"', 'tone: "Investigative"',
      'player_experience: "Source-grounded investigation followed by consequential disclosure"',
      'scope: "A short dialogue-led Story with two characters"',
      "planning:", "  choice_frequency: none", "  puzzle_emphasis: none",
      "---", "", "The opening must establish the verified transfer before later player decisions.", "",
    ].join("\n"));
  });
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope = { kind: "full-story", depth: "composition", targets: [], branches: [] };
  contract.constraints = ["Preserve all original verified facts and author decisions."];
  writeFileSync(f.contract, JSON.stringify(contract));
  saveFixtureTurn(f.job, contract, f.start[3]!, ["Preserve the source-bound original Story objective."]);
  const paused = f.cli([...f.start, "--pause-after", "architecture"]);
  assert.equal(paused.status, "paused", JSON.stringify(paused));
  await sealFixtureGenerationCheckpoint(f, "global-architecture");
  const turn = JSON.parse(readFileSync(join(f.job.stateDir, "turn-plan.json"), "utf8"));
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const env = Object.fromEntries([...Object.keys(f.env), "NT_ADAPTIVE_PLANNING"].map(key => [key, process.env[key]]));
  Object.assign(process.env, f.env, { NT_ADAPTIVE_PLANNING: "1" });
  const restoreSandbox = fixtureSandboxClient(f.job.jobId, f.job.worktreeStoryRoot);
  const saver = SqliteSaver.fromConnString(paused.checkpointPath);
  try {
    const { runtime, observed } = await scriptedStoryRuntime((i, context) => {
      if (i === 0 || i === 2) return { content: scriptedReadCalls(requiredOrchestratorSkillReads("autonomous")
        .map(path => "skill://" + path), i), reason: "toolUse" };
      if (i === 1) return { content: scriptedText({ sourceSha: f.job.baseSha, turnDigest: turn.digest,
        assignments: turn.assignments.map((a: {id:string}) => ({ id:a.id, reason:"Preserve the original approved objective." })) }), reason: "stop" };
      if (i === 3) {
        const prompt = context.messages.flatMap(m => m.role === "user" && Array.isArray(m.content) ?
          m.content.filter(c => c.type === "text").map(c => c.text) : []).findLast(t => t.includes("Only currently pending IDs:"));
        const pending = JSON.parse(prompt!.match(/Only currently pending IDs: (\[[^\n]*\])/)![1]!);
        const target = "milestones/disclosure.md";
        const hash = createHash("sha256").update(milestoneFulfillmentProjection(
          readFileSync(join(f.job.worktreeStoryRoot, target), "utf8"))).digest("hex");
        return { content: scriptedText({ sourceSha: head, turnDigest: turn.digest, beforeVersion: 1,
          reason: "Keep the original milestone work bounded to independently verifiable evidence.",
          actions: [{ kind: "narrow", item: "event:milestone.disclosure", sourcePath: target,
            sourceHash: accepted ? hash : "0".repeat(64), outcome: "Verify the original archive evidence and preserve the existing causal objective." }],
          order: pending }), reason: "stop" };
      }
      assert.equal(i, 4, "No new writer or planner may run while resolving the original parent check");
      const serialized = JSON.stringify(context.messages);
      const signature = serialized.match(/signature=([a-f0-9]{64})/)?.[1];
      const sourceRef = serialized.match(/sourceRef=([^;]+); category=/)?.[1];
      assert.ok(signature && sourceRef);
      return { content: scriptedText({ schema: "noveltea-recovery-diagnostic-proposal/v1",
        signature, sourceRef, category: "infrastructure",
        diagnosis: "Reconcile only the original sealed adaptive controller admission; do not invent a plan.",
        strategy: "reconcile-original", owner: null, scopeRef: null, prerequisites: [],
        uncertainty: "A rejected original proposal cannot be admitted." }), reason: "stop" };
    });
    const graph = createGenerationGraph(saver, "cli");
    const cfg = { configurable: { thread_id: paused.threadId }, recursionLimit: 10000 };
    const values = (await graph.getState(cfg)).values;
    const selectedFile = join(f.job.stateDir, "orchestrator-selection.json");
    if (existsSync(selectedFile)) unlinkSync(selectedFile);
    const selected = await selectStoryOrchestrator(f.job, paused.threadId,
      { task: f.start[3]!, kind: "full-story", turnPlanDigest: turn.digest }, source);
    const { runPinnedObjectivePlanner } = await import("../src/orchestrator-planner.js");
    const planning = await withJobModelRuntime(runtime, () =>
      runPinnedObjectivePlanner(f.job, selected, turn, scriptedModel.provider, scriptedModel.id));
    const initial = { request: { ...values.request, fixture: false, orchestrationPolicy: "explicit" as const,
        provider: scriptedModel.provider, model: scriptedModel.id, turnPlanDigest: turn.digest },
      orchestratorSnapshotId: selected.receipt.skillSnapshot.id,
      orchestratorOrder: planning.proposal!.assignments.map(a => a.id),
      orchestratorPlanningDigest: planning.digest, status: "running" as const,
      inventory: values.inventory, active: null, result: null, ideaTask: null, escalation: null,
      causalAmendment: null, pauseAfter: null, adaptiveVersion: null, pendingOrder: null };
    await graph.updateState(cfg, initial, "schedule");
    const first = await withJobModelRuntime(runtime, () => graph.invoke(null, {
      ...cfg, interruptAfter: ["author_update_intake"] }));
    assert.equal(observed.length, 4, JSON.stringify(first));
    const ledger = join(f.job.stateDir, "adaptive-plan.json");
    const originalBytes = readFileSync(ledger, "utf8");
    assert.equal(JSON.parse(originalBytes).attempts.at(-1).phase, accepted ? "admitted" : "rejected");
    if (accepted) {
      assert.equal(first.adaptiveVersion, 2);
      // A stale physical parent checkpoint predates the sealed accepted
      // receipt; a disabled rollout refuses fallback until the original
      // planner effect is independently restored. No new model effect.
      process.env.NT_ADAPTIVE_PLANNING = "0";
      await graph.updateState(cfg, initial, "schedule");
      const failure = await graph.invoke(null, { ...cfg, interruptBefore: ["assess_recovery"] });
      assert.equal(failure.recoveryLifecycle.active?.origin.operation, "adaptive-admission", JSON.stringify(failure));
      process.env.NT_ADAPTIVE_PLANNING = "1";
    } else assert.equal(first.recoveryLifecycle.active?.origin.operation, "adaptive-admission");
    const chosen = await graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] });
    assert.equal(chosen.recoveryLifecycle.decision?.action, "diagnostic", JSON.stringify(chosen));
    const diagnosed = await withJobModelRuntime(runtime, () => graph.invoke(null, {
      ...cfg, interruptAfter: ["assess_recovery"] }));
    assert.equal(diagnosed.recoveryLifecycle.decision?.action, accepted ? "reconcile-effects" : "diagnostic-stop",
      JSON.stringify(diagnosed));
    assert.equal(observed.length, 5);
    assert.deepEqual(observed.at(-1)!.tools, []);
    if (accepted) {
      const resumed = await graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] });
      assert.equal(resumed.recoveryLifecycle.active, null, JSON.stringify(resumed));
      assert.equal(resumed.adaptiveVersion, 2);
      assert.equal(resumed.recoveryLifecycle.discharged.at(-1)?.case.id, diagnosed.recoveryLifecycle.active?.id);
      assert.deepEqual((await graph.getState(cfg)).next, ["author_update_intake"]);
      assert.ok(resumed.active);
      assert.deepEqual(resumed.inventory, first.inventory);
      assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, paused.threadId), resumed.recoveryLifecycle);
    } else {
      assert.equal(diagnosed.status, "blocked");
      assert.equal(diagnosed.recoveryLifecycle.discharged.length, 0);
    }
    assert.equal(observed.length, 5);
    assert.equal(readFileSync(ledger, "utf8"), originalBytes);
    assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
  } finally {
    saver.db.close(); restoreSandbox();
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

for (const mode of ["event-only", "required-interactive", "story-wide-required", "event-only-complete", "event-only-incomplete", "event-only-postcommit", "composition-productive", "composition-stalled", "composition-cancel", "composition-budget"] as const)
test(mode === "event-only-complete"
  ? "#244 C07 original-Thread Event-only correction reaches reviewed Composition and completed Turn"
  : mode === "event-only-postcommit"
    ? "R14E Composition separately rejected postcommit Review resumes original writer and reviewer"
  : mode.startsWith("composition-")
    ? "R14E Composition " + mode.slice(12) + " shared correction and control"
  : mode === "event-only-incomplete"
    ? "R13 verified original-Thread corrections cannot waive a negative final Turn objective"
    : "#243 C06 original-Thread historical Choice " + mode + " uses independently authenticated owner correction", {
  skip: !available, timeout: 180_000,
}, async () => {
  const mandatory = mode === "required-interactive";
  const storyWide = mode === "story-wide-required";
  const incomplete = mode === "event-only-incomplete";
  const postcommit = mode === "event-only-postcommit";
  const productive = mode === "composition-productive";
  const stalled = mode === "composition-stalled";
  const cancel = mode === "composition-cancel";
  const budgetPause = mode === "composition-budget";
  const closeout = mode === "event-only-complete" || incomplete || postcommit || productive || stalled || cancel || budgetPause;
  const badClaims = [
    "Ada quietly recalls the secret archive key she has never discovered.",
    "Ada already knows the hidden courier code without ever hearing it.",
    "Ada remembers the private confession she has never witnessed.",
  ];
  const fixes = [
    "Ada knows only what the two signed records establish.",
    "Ada asks whether the courier code can be learned later.",
    "Ada waits for testimony before drawing any further conclusion.",
  ];
  const f = setup("c06-original-negative-choice-" + mode, story => {
    mkdirSync(join(story, "creative-direction"), { recursive: true });
    writeFileSync(join(story, "creative-direction/foundation.md"), [
      "---", "schema: '0.1'", "type: creative-direction",
      "id: creative-direction.foundation", 'title: "The archive witness"',
      "status: approved", "decisions: []",
      'premise: "A witness disappeared after a disputed ledger transfer"',
      'central_conflict: "Verify the ledger before the later disclosure choice"',
      'genre: "Mystery"', 'tone: "Investigative"',
      'player_experience: "Source-grounded investigation followed by consequential disclosure"',
      'scope: "A short dialogue-led Story with two characters"',
      "planning:", "  choice_frequency: " + (storyWide ? "frequent" : "none"),
      "  puzzle_emphasis: none",
      "---", "",
      "The opening must establish the verified transfer before later player decisions.",
      "",
    ].join("\n"));
  });
  for (const key of ["NT_ARCHITECTURE_FIXTURE_CASE", "NT_EVENT_FIXTURE_CASE",
    "NT_INTERACTIVE_FIXTURE_CASE", "NT_COMPOSITION_FIXTURE_CASE"])
    f.env[key] = "event-only";
  f.env.NT_ADAPTIVE_PLANNING = "1";
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope = { kind: "full-story", depth: "composition", targets: [], branches: [] };
  contract.constraints = mandatory
    ? ["The player must choose at this Milestone to release or withhold the evidence, with genuinely different consequences."]
    : storyWide ? ["The Story must include consequential player Choices; the only Interactive Milestone cannot be dropped without another approved owner."]
    : ["A later consequential disclosure Choice remains possible, without requiring one at every Milestone."];
  writeFileSync(f.contract, JSON.stringify(contract));
  const task = closeout
    ? "Verify the falsified transfer credit from the signed primary ledger; show the corroborated discovery without inventing a player choice."
    : "First verify a falsified transfer credit from signed records, then allow later player decisions.";
  f.start[3] = task;
  saveFixtureTurn(f.job, contract, task, mandatory
    ? ["Implement the playable release/withhold decision at this Milestone; retain the original evidence."]
    : storyWide ? ["The Story-wide Interaction profile requires a consequential Choice somewhere, not just observed evidence."]
    : ["Verify the source evidence at the opening, and retain Story-wide consequential interaction for later." ]);
  // This seeded Story already has a complete Creative Direction; generation
  // legitimately reuses its original Foundation rather than authoring a new one.
  const architecture = f.cli([...f.start, "--pause-after", "architecture"]);
  assert.equal(architecture.status, "paused", JSON.stringify({ status: architecture.status,
    reason: architecture.reason }), "the original Architecture must pause before downstream work");
  await sealFixtureGenerationCheckpoint(f, "global-architecture");
  assert.match(f.cli(["foundations", "run", "--fixture", "--skills-source", source], false),
    /review|independent/i);
  await sealFixtureGenerationCheckpoint(f, "world-foundations");
  assert.equal(f.cli(["foundations", "run", "--fixture", "--skills-source", source]).status, "foundations-committed");
  await sealFixtureGenerationCheckpoint(f, "character-foundations");
  const env = Object.fromEntries(Object.keys(f.env).map(key => [key, process.env[key]]));
  Object.assign(process.env, f.env);
  const restoreSandbox = fixtureSandboxClient(f.job.jobId, f.job.worktreeStoryRoot);
  try {
    const milestoneFile = join(f.job.worktreeStoryRoot, "milestones/disclosure.md");
    const milestone = readFileSync(milestoneFile, "utf8");
    assert.match(milestone, /fulfillment: \{any_of: \[\]\}/);
    const completed = milestone.replace("completeness: partial\n", "")
      .replace("fulfillment: {any_of: []}",
        "fulfillment:\n  any_of:\n    - [event.disclose-ledger]");
    const authored = [
      "---", "schema: '0.1'", "type: event", "id: event.disclose-ledger",
      'title: "disclose-ledger"', "status: draft", "decisions: []",
      "participants: [character.ada, character.neri]", "arcs: [arc.truth]",
      'consequences: ["Ada verifies an original signed ledger and recognizes concealed attribution"]',
      "after: []", "prerequisites:", "  any_of:",
      "    - completed: []", "      not_completed: []", "      conditions:",
      "        - kind: knowledge", "          character: character.neri",
      "          fact: fact.evidence-concealed", "          value: knows",
      "steps:", "  - id: disclose", "    branches:",
      "      - id: inspect", "        conditions: []", "        effects:",
      "          - kind: knowledge", "            character: character.ada",
      "            fact: fact.evidence-concealed", "            value: knows",
      "          - kind: relationship", "            relationship: relationship.ada-neri",
      "            value: trusting", "---", "",
      "Neri opens the signed transfer ledger on the archive table. Ada inspects its dated entries ",
      "against a separate register and verifies that the missing witness was transferred. ",
      "She learns Neri deliberately concealed the attribution and takes the corroborating source ",
      "into custody. The evidence is observed before any later player disclosure decision.",
      "",
    ].join("\n");
    const blueprint = { schema: "noveltea-milestone-blueprint/v1",
      milestoneId: "milestone.disclosure",
      events: [{ id: "disclose-ledger", purpose: "Validate the transfer record from primary evidence",
        dependsOn: [], participants: ["character.ada", "character.neri"],
        evidence: [{ anchorPath: "milestones/disclosure.md",
          source: "Neri's original signed record and the independent register",
          observation: "Ada checks dated entries across both authentic records",
          access: "Neri opens the ledger in the archive while Ada is present",
          establishes: "The witness was transferred and the attribution deliberately hidden",
          limits: "A later disclosure decision belongs to a separate player-facing scene" }],
        knowledge: "Ada verifies the transfer record and understands the concealment",
        routes: [] }],
      downstream: [{ owner: "interactive",
        obligation: mandatory
          ? "Implement the required local release/withhold Choice and both consequential results."
          : "Evaluate whether local formal Choice is justified; a consequential disclosure remains later." },
      { owner: "composition",
        obligation: "Present the actual source comparison and preserve later meaningful interaction." }] };
    const reads = [...boundedPinnedSources("nt-event-design").map(p => "skill://" + p),
      "milestones/disclosure.md"];
    const { runtime, observed } = await scriptedStoryRuntime((i, ctx) => {
      if (incomplete && i >= 22) {
        const text = JSON.stringify(ctx.messages);
        const signature = text.match(/signature=([0-9a-f]{64})/)?.[1];
        const sourceRef = text.match(/sourceRef=([^;]+); category=/)?.[1];
        if (signature && sourceRef) {
          assert.match(text, /original evidence objective lacks a sufficient payoff/);
          return { content: scriptedText({
            schema: "noveltea-recovery-diagnostic-proposal/v1", signature, sourceRef,
            category: "invalid-assignment", diagnosis: "The final independent reviewer retained the unmet original goal.",
            strategy: "unsafe", owner: null, scopeRef: null,
            prerequisites: ["Obtain a separately authorized source-bound follow-up assignment"],
            uncertainty: "No approved follow-up assignment currently exists.",
          }), reason: "stop" };
        }
      }
      if ([0, 2, 4].includes(i))
        return { content: scriptedReadCalls(reads, i), reason: "toolUse" };
      if (i === 1) return { content: scriptedText(blueprint), reason: "stop" };
      if (i === 3) return { content: scriptedText({
        schema: "noveltea-milestone-blueprint-review/v5",
        status: "pass", findings: [], prior: [] }), reason: "stop" };
      if (i === 5) return { content: [
        { type: "toolCall", id: "c06-event-write", name: "write",
          arguments: { path: "events/disclose-ledger.md", content: authored } },
        { type: "toolCall", id: "c06-fulfillment-write", name: "write",
          arguments: { path: "milestones/disclosure.md", content: completed } },
      ], reason: "toolUse" };
      if (i === 6) return { content: scriptedText({
        modifiedRecords: ["events/disclose-ledger.md", "milestones/disclosure.md"],
        architecturalConflicts: [], laterObligations: [
          "A consequential player Choice may be authored at a later Milestone, after the ledger is verified.",
        ] }), reason: "stop" };
      if (i === 7) {
        const prompt = (ctx.messages as any[]).filter(m => m.role === "user")
          .flatMap(m => m.content.map((c: any) => c.text ?? ""))
          .findLast((s: string) => s.includes("INDEPENDENT EVENT-ONLY OMISSION REVIEW"));
        assert.ok(prompt, "C06 must invoke the genuine independent Event-only reviewer");
        const blocks = prompt.match(/PINNED REFERENCES:\n([\s\S]*?)\nSTORY PATHS:\n([\s\S]*?)\nASSIGNMENT:\n/);
        assert.ok(blocks, "Independent omission reviewer must list actual pinned skills and Story paths");
        const paths = [...new Set([...blocks[1]!.trim().split("\n"),
          ...blocks[2]!.trim().split("\n")].filter(Boolean))];
        return { content: scriptedReadCalls(paths, i), reason: "toolUse" };
      }
      if (i === 8 && mandatory) return { content: scriptedText({ verdict: "block",
        findings: [{ severity: "blocking", dimension: "obligation",
          source: "milestones/disclosure.md:11",
          message: "The original author explicitly requires a playable local release/withhold decision, which the observed Event alone does not implement.",
          repair: "interactive" }], evidence: [],
      }), reason: "stop" };
      if (i === 8) return { content: scriptedText({ verdict: "pass", findings: [],
        evidence: ["milestones/disclosure.md:11 source-bound observed credit",
          "events/disclose-ledger.md:23 primary signed ledger",
          "event.disclose-ledger#disclose/inspect: events/disclose-ledger.md:24",
          "milestone.disclosure#0: milestones/disclosure.md:11"],
      }), reason: "stop" };
      if (i === 9 || i === 11) return { content: scriptedReadCalls(
        [...reads, "events/disclose-ledger.md"], i), reason: "toolUse" };
      if (i === 10) return { content: scriptedText({ ...blueprint,
        downstream: blueprint.downstream.filter(x => x.owner !== "interactive"),
      }), reason: "stop" };
      if (i === 12) return { content: scriptedText({
        schema: "noveltea-milestone-blueprint-review/v5",
        status: "pass", findings: [], prior: [],
      }), reason: "stop" };
      if (closeout) {
        const currentStory = () => git(f.job.worktreeRoot, "ls-files", "--", "story/")
          .split("\n").filter(p => p.endsWith(".md")).map(p => p.slice(6));
        if (i === 13) return { content: scriptedReadCalls([
          ...boundedPinnedSources("nt-narrative-composition").map(p => "skill://" + p),
          "skill://nt-catalog/references/glossary.md", ...currentStory(),
        ], i), reason: "toolUse" };
        if (i === 14) return { content: [{ type: "toolCall", id: "c07-real-pi-composition",
          name: "write", arguments: { path: "authored-content/disclose-ledger-scene.md",
            content: ["---", "schema: '0.1'", "type: authored-content",
              "id: authored-content.disclose-ledger-scene",
              "title: \"The signed transfer\"", "status: draft", "decisions: []",
              "events: [event.disclose-ledger]", "revelations: []", "---", "",
              "## Observed discovery", "",
              "Neri opens the preserved transfer ledger on the archive table. Ada compares each dated entry against the independent register and checks the witness attribution. The two signed sources match: the witness was transferred, but Neri concealed who authorized the movement. Ada takes the corroborated record into custody and explains the discovery. Ada quietly recalls the secret archive key she has never discovered. No player Choice or confession beyond the witnessed evidence is enacted.", "",
            ].concat(productive ? badClaims.slice(1) : []).concat(postcommit ? Array.from({length: 150}, (_, n) =>
              "Ada verifies signed ledger entry " + (n + 1) + " against the independent register.") : []).join("\n") + "\n" } }], reason: "toolUse" };
        if (i === 15) return { content: scriptedText({
          modifiedRecords: ["authored-content/disclose-ledger-scene.md"],
          architecturalConflicts: [], laterObligations: [],
        }), reason: "stop" };
        if (i === 16) return { content: scriptedReadCalls([
          ...boundedPinnedSources("nt-narrative-composition").map(p => "skill://" + p),
          "skill://nt-catalog/references/glossary.md",
          ...currentStory(), "authored-content/disclose-ledger-scene.md",
        ], i), reason: "toolUse" };
        if ((productive || stalled) && i >= 17 && i <= (productive ? 29 : 26)) {
          const path = "authored-content/disclose-ledger-scene.md";
          const manifest = { modifiedRecords: [path], architecturalConflicts: [], laterObligations: [] };
          if (stalled && i === 26) {
            const messages = JSON.stringify(ctx.messages);
            const signature = messages.match(/signature=([0-9a-f]{64})/)?.[1];
            const sourceRef = messages.match(/sourceRef=([^;]+); category=/)?.[1];
            assert.ok(signature && sourceRef);
            assert.match(messages, /assignmentDefects/);
            return { content: scriptedText({ schema: "noveltea-recovery-diagnostic-proposal/v1",
              signature, sourceRef, category: "defect", diagnosis: "The original writer retained the impossible knowledge in two attempted repairs.",
              strategy: "review-adjudication", owner: null, scopeRef: null, prerequisites: [],
              uncertainty: "No currently authorized successor." }), reason: "stop" };
          }
          const round = Math.floor((i - 17) / 4);
          const phase = (i - 17) % 4;
          if (phase === 0) {
            const pass = productive && round === 3;
            const claim = badClaims[productive ? Math.min(round, 2) : 0]!;
            return { content: scriptedText({
              schema: "noveltea-composition-review/v2", status: pass ? "pass" : "revise",
              findings: pass ? [] : [{ path, reason: "Ada asserts unearned knowledge.",
                correction: "Ground this claim in witnessed sources.",
                requirement: { source: "policy", quote: "Shared entry must not assume unavailable route-specific clues" },
                evidence: { path, quote: claim }, origin: round === 0 ? "initial" : productive ? "overlooked" : "continuing" }],
              prior: Array.from({ length: round }, (_, n) => ({ round: n, findingIndex: 0,
                status: productive ? "resolved" : "persisting", reason: productive ? "The unsupported claim was removed." : "The unsupported claim remains.",
                evidence: { path, quote: productive ? fixes[n]! : badClaims[0]! } })),
              sourceEvidence: pass ? ["event.disclose-ledger#disclose/inspect: signed ledger and independent register corroborate the transfer"] : [],
            }), reason: "stop" };
          }
          if (phase === 1) {
            assert.match(JSON.stringify(ctx.messages), /SOURCE-BOUND STORY CORRECTION/);
            return { content: [{ type: "toolCall", id: "r14e-progress-" + i, name: "edit",
              arguments: { path, edits: [{
                oldText: productive ? badClaims[round]! : round === 0 ? "Neri opens the preserved transfer ledger" : "Neri examines the preserved transfer ledger",
                newText: productive ? fixes[round]! : round === 0 ? "Neri examines the preserved transfer ledger" : "Neri handles the preserved transfer ledger",
              }] } }], reason: "toolUse" };
          }
          if (phase === 2) return { content: scriptedText(manifest), reason: "stop" };
          return { content: scriptedReadCalls([...boundedPinnedSources("nt-narrative-composition").map(p => "skill://" + p),
            "skill://nt-catalog/references/glossary.md", ...currentStory(), path], i), reason: "toolUse" };
        }
        if (i === 17) return { content: scriptedText({
          schema: "noveltea-composition-review/v2", status: "revise",
          findings: [{ path: "authored-content/disclose-ledger-scene.md", reason: "Ada recalls unearned knowledge.",
            correction: "Remove the secret key claim and ground her knowledge in the verified ledger.",
            requirement: { source: "policy", quote: "Shared entry must not assume unavailable route-specific clues" },
            evidence: { path: "authored-content/disclose-ledger-scene.md",
              quote: "Ada quietly recalls the secret archive key she has never discovered." }, origin: "initial" }],
          prior: [], sourceEvidence: [],
        }), reason: "stop" };
        if (i === 18) {
          assert.match(JSON.stringify(ctx.messages), /SOURCE-BOUND STORY CORRECTION/);
          return { content: [{ type: "toolCall", id: "r07-composition-revise", name: "edit",
            arguments: { path: "authored-content/disclose-ledger-scene.md", edits: [{
              oldText: "Ada quietly recalls the secret archive key she has never discovered.",
              newText: "Ada knows only what the two signed records establish.",
            }] } }], reason: "toolUse" };
        }
        if (i === 19) return { content: scriptedText({
          modifiedRecords: ["authored-content/disclose-ledger-scene.md"],
          architecturalConflicts: [], laterObligations: [],
        }), reason: "stop" };
        if (i === 20) {
          assert.match(JSON.stringify(ctx.messages), /CONTINUE YOUR SAME INDEPENDENT READ-ONLY COMPOSITION REVIEW/);
          return { content: scriptedReadCalls([
            ...boundedPinnedSources("nt-narrative-composition").map(p => "skill://" + p),
            "skill://nt-catalog/references/glossary.md",
            ...currentStory(), "authored-content/disclose-ledger-scene.md",
          ], i), reason: "toolUse" };
        }
        if (i === 21) return { content: scriptedText({
          schema: "noveltea-composition-review/v2", status: "pass",
          findings: [], prior: [{ round: 0, findingIndex: 0, status: "resolved",
            reason: "The revised prose confines Ada to the signed records.",
            evidence: { path: "authored-content/disclose-ledger-scene.md",
              quote: "Ada knows only what the two signed records establish." } }],
          sourceEvidence: ["event.disclose-ledger#disclose/inspect: signed ledger and independent register corroborate the transfer"],
        }), reason: "stop" };
        const reviewPath = "authored-content/disclose-ledger-scene.md";
        const repairQuote = "Ada points to the matching signatures before explaining the corroborated transfer.";
        if (postcommit && (i === 22 || i === 26))
          return { content: scriptedReadCalls(boundedPinnedSources("nt-narrative-review").map(p => "skill://" + p), i), reason: "toolUse" };
        if (postcommit && (i === 23 || i === 27)) {
          const messages = ctx.messages as Array<{ content: Array<{ type: string; text?: string }> }>;
          const prompt = messages.flatMap(m => Array.isArray(m.content) ? m.content : [])
            .map(c => c.text ?? "").findLast(t => t.includes("\nIMMUTABLE REVIEW PACKET\n"));
          assert.ok(prompt, "Postcommit reviewer has immutable packet, not the precommit editorial prompt");
          const packet = JSON.parse(prompt.split("\nIMMUTABLE REVIEW PACKET\n")[1]!);
          const item = packet.items[0];
          const ref = { commitSha: item.assurance.commitSha, assignmentId: item.assignment.id, path: reviewPath, line: 1 };
          return { content: scriptedText({ sourceDigest: packet.sourceDigest, verdict: i === 23 ? "fail" : "pass",
            findings: i === 23 ? [{ ...ref, kind: "missing-requirement", message: "The corroboration needs explicit visible payoff.",
              requiredCorrection: repairQuote, affectedPaths: [reviewPath] }] : [],
            evidence: i === 27 ? [{ ...ref, explanation: repairQuote }] : [],
            ...(i === 27 ? { progressDiagnosis: { status: "material", reason: "Added visible corroboration.",
              evidence: { path: reviewPath, quote: repairQuote, change: "added" } } } : {}),
          }), reason: "stop" };
        }
        if (postcommit && i === 24) return { content: [{ type: "toolCall", id: "r14e-composition-repair",
          name: "edit", arguments: { path: reviewPath, edits: [{ oldText: "Ada knows only what the two signed records establish.",
            newText: "Ada knows only what the two signed records establish. " + repairQuote }] } }], reason: "toolUse" };
        if (postcommit && i === 25) return { content: scriptedText("Made the visible corroboration explicit."), reason: "stop" };
        if (i >= 22 && i < 40 && i % 2 === 0) return {
          content: scriptedReadCalls([
            ...boundedPinnedSources("nt-narrative-review").map(p => "skill://" + p),
            "skill://nt-catalog/references/glossary.md", ...currentStory(),
          ], i), reason: "toolUse",
        };
        if (i >= 23 && i < 40 && i % 2 === 1) {
          const user = (ctx.messages as any[]).filter(m => m.role === "user")
            .flatMap(m => m.content.map((p: { text?: string }) => p.text ?? ""))
            .findLast((p: string) => p.includes("ASSIGNMENT:\n"));
          const planPrompt = (ctx.messages as any[]).filter(m => m.role === "user")
            .flatMap(m => m.content.map((part: { text?: string }) => part.text ?? ""))
            .findLast((text: string) => text.includes("PLAN-LEVEL PACKET:\n"));
          if (planPrompt) {
            const packet = JSON.parse(planPrompt.slice(planPrompt.lastIndexOf("PLAN-LEVEL PACKET:\n") +
              "PLAN-LEVEL PACKET:\n".length)) as {
                digest: string; objectives: Array<{ id: string; text: string }>;
                canonical: Array<{ path: string }>;
              };
            const objectivePath = (id: string) => {
              if (id === "delivery:architecture" || id.includes(":architecture:"))
                return "arcs/truth.md";
              if (["delivery:composition", "delivery:complete-story", "delivery:payoff"].includes(id) ||
                  id.includes(":composition:"))
                return "authored-content/disclose-ledger-scene.md";
              if (id === "delivery:interactive" || id.startsWith("delivery:branch:") ||
                  id.includes(":interactive:") || id.includes(":event:") ||
                  id.includes(":local-event:"))
                return "events/disclose-ledger.md";
              return "authored-content/disclose-ledger-scene.md";
            };
            const missing = incomplete ? packet.objectives.find(objective => objective.id === "goal") : undefined;
            if (incomplete) assert.ok(missing, "Final Review must check the original Turn goal");
            return { content: scriptedText({ digest: packet.digest, verdict: incomplete ? "incomplete" : "complete",
              checks: packet.objectives.map(objective => ({ objectiveId: objective.id,
                fulfilled: objective.id !== missing?.id, evidence: objective.id === missing?.id ? [] : [{
                  path: packet.canonical.some(path => path.path === objectivePath(objective.id))
                    ? objectivePath(objective.id) : packet.canonical[0]!.path,
                  line: 1, explanation: "Original source satisfies " + objective.text,
                }],
              })), findings: missing ? [{ objectiveId: missing.id,
                message: "The original evidence objective lacks a sufficient payoff in the final Story.",
                followUp: null }] : [] }), reason: "stop" };
          }
          assert.ok(user, "The independent reviewer must receive its original source-bound assignment");
          const assignment = JSON.parse(user.slice(user.lastIndexOf("ASSIGNMENT:\n") +
            "ASSIGNMENT:\n".length)) as {
              specialistAssignments?: Array<{ authority: { existingPaths: string[] } }>;
              routes: Array<{ event: string; step: string; branch: string }>;
              milestoneRoutes: Array<{ milestone: string; alternative: number }>;
              puzzleRoutes: Array<{ puzzle: string; event: string }>;
            };
          return { content: scriptedText({ verdict: "pass", findings: [], evidence: [
            ...currentStory().map(path => path + ":11"),
            ...(assignment.specialistAssignments ?? []).flatMap(a =>
              a.authority.existingPaths.map(path => path + ":11")),
            ...assignment.routes.map(r => r.event + "#" + r.step + "/" + r.branch +
              ": events/disclose-ledger.md:23"),
            ...assignment.milestoneRoutes.map(r => r.milestone + "#" + r.alternative +
              ": milestones/disclosure.md:11"),
            ...assignment.puzzleRoutes.map(r => r.puzzle + "/" + r.event +
              ": events/disclose-ledger.md:23"),
          ] }), reason: "stop" };
        }
      }
      throw Error("Unscripted #243 independent correction turn: " + i + " " +
        JSON.stringify(ctx.messages.slice(-2)).slice(0, 1400));
    });
    const authoredEvent = await withJobModelRuntime(runtime, () => runEventWorkItem({
      story: f.story, job: "single", action: "run", milestone: "milestone.disclosure",
      fixture: false, skillsSource: source,
      provider: scriptedModel.provider, model: scriptedModel.id,
    }));
    assert.equal(authoredEvent.status, "event-cluster-committed");
    assert.equal(observed.length, 7);
    await sealFixtureGenerationCheckpoint(f, "event-disclosure");
    const event = JSON.parse(readFileSync(join(f.job.stateDir, "event-items/disclosure.json"), "utf8"));
    const arch = JSON.parse(readFileSync(join(f.job.stateDir, "architecture.json"), "utf8"));
    const turn = JSON.parse(readFileSync(join(f.job.stateDir, "turn-plan.json"), "utf8"));
    const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
    const skill = await createSkillSnapshot({ discovery: "explicit-only",
      novelteaSkills: source, skillDirs: [], requiredSkills: [
        "nt-interactive-narrative", "nt-catalog" ] });
    assert.ok(skill);
    const session = join(f.job.stateDir, "interactive-sessions", "interactive-disclosure",
      "choice", "historical-negative.jsonl");
    mkdirSync(dirname(session), { recursive: true });
    const conflict = [
      "An earlier approved downstream task presumes an unearned local player decision despite a completed evidence observation.",
    ];
    const obligations = ["Preserve a consequential later player disclosure Choice after this reviewed opening."];
    const piText = JSON.stringify({ modifiedRecords: [], architecturalConflicts: conflict,
      laterObligations: obligations });
    const bytes = [JSON.stringify({ type: "session", id: "c06-legacy-original" }),
      JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "stop",
        content: [{ type: "text", text: piText }] } }), ""].join("\n");
    writeFileSync(session, bytes);
    const h = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
    const receipt: any = {
      version: 1, jobId: f.job.jobId, baseSha: f.job.baseSha,
      workItemId: "interactive-disclosure", milestoneId: "milestone.disclosure",
      planVersion: arch.plan.version, planDigest: h(JSON.stringify(arch.plan)),
      eventHead: event.commitSha, worker: "pi",
      provider: scriptedModel.provider, model: scriptedModel.id,
      snapshot: skill,
      eventSource: { headSha: event.commitSha, snapshotId: event.snapshot.id,
        eventIds: event.validation.eventIds,
        milestoneState: event.validation.milestoneState ?? "complete", missingObligations: [] },
      units: [{ id: "interactive-choice-disclosure", domain: "choice", phase: "conflicted",
        beforeHead: head, paths: [], claimedPaths: [],
        conflicts: conflict, obligations, skillReads: [],
        piSessionFile: session, piSessionSha256: h(bytes) },
      { id: "interactive-puzzle-disclosure", domain: "puzzle", phase: "pending" }],
    };
    receipt.units[0].digest = h(JSON.stringify({
      jobId: receipt.jobId, worker: receipt.worker, workItemId: receipt.workItemId,
      milestoneId: receipt.milestoneId, baseSha: receipt.baseSha,
      planVersion: receipt.planVersion, planDigest: receipt.planDigest,
      eventHead: receipt.eventHead, provider: receipt.provider, model: receipt.model,
      thinking: null, eventSource: receipt.eventSource, head,
      snapshotId: skill.id, unitId: receipt.units[0].id,
      paths: [], conflicts: conflict, obligations, skillReads: [],
      piSessionFile: session, piSessionSha256: h(bytes),
    }));
    const path = join(f.job.stateDir, "interactive-items/disclosure.json");
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(receipt, null, 2));
    const oldNegative = await inspectInteractiveConflict(f.job, "milestone.disclosure");
    assert.equal(oldNegative.reportDigest, receipt.units[0].digest);
    const inspected = await runInteractiveWorkItem({
      story: f.story, job: "single", action: "inspect", milestone: "milestone.disclosure" });
    assert.equal(inspected.status, "interactive-conflict-reported");
    assert.equal(observed.length, 7, "historical negative is inspected without launching another Pi writer");
    const validation = await validateStoryJob(f.job, source, { ...f.job, baseSha: head });
    const records = (validation.report as any).records as Array<{ path: string;
      metadata: { type: string; status: string; id: string; decisions?: unknown[]; planning?: unknown } }>;
    const hashes = Object.fromEntries(records.map(r => [r.path,
      h(readFileSync(join(f.job.worktreeStoryRoot, r.path)))]));
    const checkpoints = await inspectRecoveryCheckpoints(f.job);
    const completedStages: any[] = [];
    completedStages.push(...architecture.completedStages.filter((e: any) => e.stage === "foundation"));
    for (const [workItem, stage, status] of [
      ["global-architecture", "architecture", "architecture-committed"],
      ["character-foundations", "foundations", "foundations-committed"],
      ["event-disclosure", "event", "event-cluster-committed"],
    ] as const) {
      const p = checkpoints.find(x => x.workItem === workItem && x.eligible);
      assert.ok(p, "Missing authenticated " + workItem);
      completedStages.push({ stage, status, headSha: p.commitSha,
        ...(stage === "event" ? { milestone: "milestone.disclosure" } : {}) });
    }
    const nativeInventory = reconcileInventory(arch.plan, validation, head, completedStages, {});
    assert.equal(nativeInventory.items.find(i => i.id === "interactive:milestone.disclosure")?.status,
      "pending");
    const order = nativeInventory.items.filter(i => i.status === "pending").map(i => i.id);
    const proposal = { sourceSha: head, turnDigest: turn.digest, beforeVersion: 1,
      reason: "The original reviewed Event establishes what is observable before any later disclosure decision.",
      actions: [{ kind: "narrow" as const, item: "interactive:milestone.disclosure",
        sourcePath: "milestones/disclosure.md", sourceHash: hashes["milestones/disclosure.md"],
        outcome: "Only authorize a local Choice if independently justified by the observed evidence." }],
      order };
    const admission = {
      proposal, inventory: nativeInventory, plan: arch.plan,
      turnDigest: turn.digest, version: 1,
      verifiedSource: true, records, sourceHashes: hashes,
      milestoneSourceHashes: hashes, protectedPaths: records.filter(r =>
        r.metadata.type === "creative-direction" || r.metadata.decisions?.length).map(r => r.path),
      typedEdges: [], authorTargets: [],
      planning: parseStoryPlanning(records.find(r => r.metadata.type === "creative-direction")!.metadata.planning),
      carried: nativeInventory.items.filter(i => i.status === "verified")
        .map(i => ({ id: i.id, sha: i.verifiedSha! })),
      omissionProofs: [],
    };
    const amendment = admitAdaptiveAssignments(admission);
    const narrowed = applyAdaptiveAssignments(nativeInventory, amendment);
    const state = emptyAdaptiveState(f.job, turn.digest, arch.plan.version);
    const budget = reviewArchitectureMetrics(nativeStoryMetrics(f.job),
      records, (validation.report as any).contractRevision, head);
    const signature = pendingDigest({ source: head, planVersion: arch.plan.version,
      turn: turn.digest, metricSources: budget.sourceRevisionsDigest });
    await beginAdaptiveAttempt(f.job, state, head, signature);
    const selected = await createSkillSnapshot({ discovery: "explicit-only",
      novelteaSkills: source, skillDirs: [], requiredSkills: ["nt-story-orchestrate", "nt-catalog"] });
    assert.ok(selected);
    const adaptiveFile = join(f.job.stateDir, "adaptive-planning-sessions", "historical.jsonl");
    mkdirSync(dirname(adaptiveFile), { recursive: true });
    const adaptiveBytes = JSON.stringify({ role: "assistant", text: "Original admitted narrow assignment" }) + "\n";
    writeFileSync(adaptiveFile, adaptiveBytes);
    await settleAdaptiveAttempt(f.job, state, signature, "admitted", amendment, {
      sessionFile: adaptiveFile, sessionSha256: h(adaptiveBytes),
      snapshotId: selected.id, provider: scriptedModel.provider, model: scriptedModel.id,
      skillReads: [join(selected.path, "skills/nt-story-orchestrate/SKILL.md")],
      proposalDigest: pendingDigest(proposal),
    });
    // Rebuild the fixture-only null-Turn method pin as a properly selected
    // source-bound production method BEFORE creating the historical failure.
    // A real production Turn selects this exact identity on initial admission;
    // the fixture CLI deliberately did not have a Turn digest.
    const selectedFile = join(f.job.stateDir, "orchestrator-selection.json");
    const previousMethod = JSON.parse(readFileSync(selectedFile, "utf8"));
    assert.ok(previousMethod.turnPlanDigest === null || previousMethod.turnPlanDigest === turn.digest);
    if (previousMethod.turnPlanDigest === null) unlinkSync(selectedFile);
    const originalMethod = await selectStoryOrchestrator(f.job,
      f.job.threadId + ":generation", { task, kind: "full-story",
        turnPlanDigest: turn.digest }, source);
    assert.equal(originalMethod.receipt.turnPlanDigest, turn.digest);
    // A budget pause re-enters through START, not a suspended child task.
    // Seed the actual original objective-planning receipt before testing
    // that path; the earlier fixture-only setup did not run the planner.
    const planning = budgetPause ? await (async () => {
      const { runtime: plannerRuntime } = await scriptedStoryRuntime((index) => {
        if (index === 0) return { content: scriptedReadCalls(requiredOrchestratorSkillReads("autonomous")
          .map(path => "skill://" + path), index), reason: "toolUse" };
        assert.equal(index, 1);
        return { content: scriptedText({ sourceSha: turn.source.verifiedSha, turnDigest: turn.digest,
          assignments: turn.assignments.map((a: { id: string }) => ({ id: a.id,
            reason: "Perform the original approved objective in causal order." })) }), reason: "stop" };
      });
      const { runPinnedObjectivePlanner } = await import("../src/orchestrator-planner.js");
      return withJobModelRuntime(plannerRuntime, () => runPinnedObjectivePlanner(f.job, originalMethod,
        turn, scriptedModel.provider, scriptedModel.id));
    })() : null;
    let saver = SqliteSaver.fromConnString(join(f.job.stateDir, "generation.sqlite"));
    try {
      let graph = createGenerationGraph(saver, "cli");
      const cfg = { configurable: { thread_id: f.job.threadId + ":generation" }, recursionLimit: 10000 };
      const initial = (await graph.getState(cfg)).values;
      assert.ok(initial.request);
      await graph.updateState(cfg, {
        request: { ...initial.request, task, contract, fixture: false,
          provider: scriptedModel.provider, model: scriptedModel.id,
          turnPlanDigest: turn.digest, orchestrationPolicy: "explicit" },
        ...(planning ? { orchestratorSnapshotId: originalMethod.receipt.skillSnapshot.id,
          orchestratorOrder: planning.proposal!.assignments.map(a => a.id),
          orchestratorPlanningDigest: planning.digest } : {}),
        completedStages, inventory: narrowed, adaptiveVersion: 2,
        planVersion: arch.plan.version, status: "running", reason: null,
        active: narrowed.items.find(i => i.id === "interactive:milestone.disclosure"),
        result: null, pauseAfter: null, failures: {},
      }, "author_update_intake");
      const admitted = await graph.invoke(null, { ...cfg, interruptBefore: ["assess_recovery"] });
      assert.equal(admitted.recoveryLifecycle.active?.origin.operation,
        "specialist-result", JSON.stringify({ status: admitted.status, reason: admitted.reason,
          recovery: admitted.recoveryLifecycle }));
      assert.equal(admitted.inventory.items.find((i: { id: string }) =>
        i.id === "interactive:milestone.disclosure")?.status, "blocked");
      const firstDecision = await graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] });
      assert.equal(firstDecision.recoveryLifecycle.decision?.action, "plan-amendment");
      assert.equal(firstDecision.recoveryLifecycle.decision?.adapter, "dependency-work");
      assert.equal(firstDecision.recoveryLifecycle.assessorPending, true);
      assert.equal(observed.length, 7, "selection never starts the Choice specialist or a replacement reviewer");
      if (mandatory || storyWide) {
        const stopped = await withJobModelRuntime(runtime, () => graph.invoke(null,
          { ...cfg, interruptAfter: ["assess_recovery"] }));
        assert.equal(stopped.status, "blocked");
        assert.equal(stopped.escalation?.kind, "dependency-replan");
        assert.equal(stopped.escalation?.requiresTrustedApproval, false);
        assert.ok(stopped.escalation?.sources.some((s: { source: string; repair: string }) =>
          s.source === "milestone.disclosure" && s.repair === "interactive"),
          "a genuine mandatory local Choice must be routed to its typed plan owner, not omitted");
        assert.equal(stopped.recoveryLifecycle.active?.id,
          firstDecision.recoveryLifecycle.active?.id);
        assert.notEqual(stopped.recoveryLifecycle.decision?.action, "integrity-fence");
        assert.equal(observed.length, mandatory ? 9 : 7,
          "a binding Story-wide quota is source-proven; it needs no speculative omission reviewer");
        assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
        assert.equal(JSON.parse(readFileSync(path, "utf8")).units[0].phase, "conflicted",
          "required Choice remains blocked, never superseded by an unreviewed omission");
        const refusalPath = join(f.job.stateDir, "interactive-event-only/disclosure.json");
        if (mandatory) {
          const refusal = JSON.parse(readFileSync(refusalPath, "utf8"));
          assert.equal(refusal.phase, "declined");
          assert.equal(refusal.payload.decision, "retain-interactive");
        } else assert.equal(existsSync(refusalPath), false,
          "a binding original Story-wide Choice promise must refuse omission before asking a new Pi reviewer");
        assert.equal((await inspectInteractiveConflict(f.job, "milestone.disclosure")).reportDigest,
          oldNegative.reportDigest);
        assert.equal((await inspectModernGenerationRecovery(f.job, saver, cfg.configurable.thread_id))?.active?.id,
          stopped.recoveryLifecycle.active?.id);
        if (mandatory) {
          const refusedAgain = await withJobModelRuntime(runtime, () => runInteractiveWorkItem({
            story: f.story, job: "single", action: "review-omission",
            milestone: "milestone.disclosure", fixture: false,
            generationObjective: task, turnPlanDigest: turn.digest,
            skillsSource: source, provider: scriptedModel.provider,
            model: scriptedModel.id,
          }));
          assert.equal(refusedAgain.status, "omission-not-justified");
          assert.equal(observed.length, 9,
            "a repeated independently refused omission cannot start a replacement reviewer");
        }
        return;
      }
      const corrected = await withJobModelRuntime(runtime, () => graph.invoke(null,
        { ...cfg, interruptAfter: ["assess_recovery"] }));
      assert.equal(corrected.status, "running", JSON.stringify({ status: corrected.status,
        reason: corrected.reason, lifecycle: corrected.recoveryLifecycle,
        calls: observed.slice(7).map(x => ({ tools: x.tools,
          prompt: JSON.stringify(x.messages.slice(-2)).slice(0, 650) })) }));
      assert.equal(corrected.recoveryLifecycle.active, null);
      assert.equal(corrected.adaptiveVersion, 3);
      assert.equal(corrected.inventory.items.find((i: { id: string }) =>
        i.id === "interactive:milestone.disclosure")?.status, "verified");
      assert.equal(corrected.completedStages.filter((e: { stage: string; milestone?: string }) =>
        e.stage === "interactive" && e.milestone === "milestone.disclosure").length, 1);
      assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head,
        "no Choice/Puzzle commit was invented while resolving the original contradiction");
      const savedPlan = JSON.parse(readFileSync(join(f.job.stateDir, "adaptive-plan.json"), "utf8"));
      assert.equal(savedPlan.entries.length, 1);
      assert.equal(savedPlan.supersessions.length, 1);
      assert.equal(savedPlan.supersessions[0].originalAmendmentDigest, amendment.digest);
      const activeReceipt = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(activeReceipt.units[0].phase, "not-applicable");
      assert.equal(activeReceipt.units[1].phase, "not-applicable");
      assert.ok(activeReceipt.supersededNegative);
      assert.equal((await inspectInteractiveConflict(f.job, "milestone.disclosure", true)).reportDigest,
        oldNegative.reportDigest, "original negative remains independently reauthenticatable");
      assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, cfg.configurable.thread_id),
        corrected.recoveryLifecycle,
        "C07 graph restart must authenticate the resolved original case and actual Event-only omission");
      assert.equal(corrected.recoveryLifecycle.discharged.at(-1)?.disposition, "active-verified");
      const oldFile = join(f.job.stateDir, activeReceipt.supersededNegative.relative);
      const oldBytes = readFileSync(oldFile, "utf8");
      try {
        const altered = JSON.parse(oldBytes);
        altered.units[0].conflicts[0] = "A forged different historical contradiction.";
        writeFileSync(oldFile, JSON.stringify(altered));
        await assert.rejects(inspectInteractiveConflict(f.job, "milestone.disclosure", true),
          /historical|original|changed|source/i);
      } finally { writeFileSync(oldFile, oldBytes); }
      const reviewPath = join(f.job.stateDir, "interactive-event-only/disclosure.json");
      const reviewBytes = readFileSync(reviewPath, "utf8");
      try {
        const altered = JSON.parse(reviewBytes);
        altered.payload.sourceHashes["milestones/disclosure.md"] = "f".repeat(64);
        writeFileSync(reviewPath, JSON.stringify(altered));
        await assert.rejects(readEventOnlyOmission(f.job, "milestone.disclosure",
          activeReceipt.units[0].eventOnly), /identity|digest|source/i,
          "a forged independent no-write source cannot authorize the old failed assignment");
        assert.equal((await inspectModernGenerationRecovery(f.job, saver, cfg.configurable.thread_id))?.phase,
          "fenced", "C07 cannot reenter with a tampered independently reviewed omission");
      } finally { writeFileSync(reviewPath, reviewBytes); }
      assert.equal((await inspectInteractiveConflict(f.job, "milestone.disclosure", true)).reportDigest,
        oldNegative.reportDigest);
      const originalPiBytes = readFileSync(session, "utf8");
      try {
        writeFileSync(session, originalPiBytes.replace(
          "An earlier approved downstream task presumes an unearned local",
          "An unrelated forged downstream author task presumes an unearned local"));
        await assert.rejects(inspectInteractiveConflict(f.job, "milestone.disclosure", true),
          /session|original|transcript|changed/i,
          "changing the original settled Pi transcript must invalidate its historical owner proof");
      } finally { writeFileSync(session, originalPiBytes); }
      const reentered = await withJobModelRuntime(runtime, () => graph.invoke(null,
        { ...cfg, interruptBefore: ["specialist_dispatch"] }));
      assert.equal(reentered.status, "running", JSON.stringify({ status: reentered.status,
        reason: reentered.reason, recovery: reentered.recoveryLifecycle }));
      assert.equal(reentered.active?.stage, "composition",
        "the same original Thread must resume only its real downstream Composition assignment");
      assert.equal(reentered.active?.milestone, "milestone.disclosure");
      const { preflightCompositionBoundary } =
        await import("../src/cross-domain-prerequisite-controller.js");
      const compositionAdmission = await preflightCompositionBoundary(f.job,
        reentered.request, "milestone.disclosure", arch.plan.version);
      assert.equal(compositionAdmission.kind, "ready",
        "the real Composition admission must recheck and accept the revised Blueprint and no-write proof");
      const finalProjection = projectAdaptiveFinal((await readAdaptiveState(
        f.job, turn.digest, arch.plan.version))!);
      assert.equal(finalProjection.source.version, 3);
      assert.equal(finalProjection.plannedWork.find((item: { id: string }) =>
        item.id === "interactive:milestone.disclosure")?.status, "reviewed-omission");
      assert.ok(finalProjection.objectives.some((item: { text: string }) =>
        item.text.includes("remaining Story-wide Choice/Puzzle promises")),
        "the final Turn reviewer must still check whole-Story interaction and causal obligations");
      assert.equal(reentered.inventory.items.find((i: { id: string }) =>
        i.id === "interactive:milestone.disclosure")?.status, "verified");
      assert.equal(observed.length, 13,
        "retrying the original graph must not start another Choice/Blueprint/reviewer Pi call");
      if (closeout) {
        if (!incomplete && !postcommit && !productive && !stalled) {
          const receiptFile = join(f.job.stateDir, "composition-items/disclosure.json");
          const sourceHead = git(f.job.worktreeRoot, "rev-parse", "HEAD");
          let identity: string[] | undefined;
          const priorUsage = (await inspectPiPolicy(f.job)).budget.modelCalls;
          for (const cut of [
            { channel: "correction", ordinal: 0, calls: 18 },
            { channel: "submission", ordinal: 1, calls: 20 },
            { channel: "submission", status: "composition-authored", calls: 22 },
            { channel: "submission", status: "composition-committed", calls: 22 },
          ]) {
            const abort = new AbortController();
            const originalPut = saver.put.bind(saver);
            const originalWrites = saver.putWrites.bind(saver);
            const crash = Error("Composition child checkpoint loss: " + cut.channel + ":" + cut.calls);
            let crashed = false;
            saver.put = async (...args) => { if (crashed) throw crash; return originalPut(...args); };
            saver.putWrites = async (config, writes, taskId) => {
              if (crashed) throw crash;
              const entry = writes.find(([channel]) => channel === cut.channel)?.[1] as
                { receiptRef?: string; rejectedReceiptRef?: string; status?: string } | undefined;
              const ref = entry?.receiptRef ?? entry?.rejectedReceiptRef;
              if (config.configurable?.checkpoint_ns?.includes("assignment-") && observed.length === cut.calls &&
                  (cut.status ? entry?.status === cut.status : ref?.split(":")[1] === String(cut.ordinal))) {
                crashed = true; abort.abort(crash); throw crash;
              }
              return originalWrites(config, writes, taskId);
            };
            await assert.rejects(withJobModelRuntime(runtime, () => graph.invoke(null,
              { ...cfg, signal: abort.signal, durability: "sync" })));
            assert.ok(crashed, "Reached the actual nested Composition checkpoint");
            assert.equal(observed.length, cut.calls, "No duplicate or premature Pi turn");
            const saved = JSON.parse(readFileSync(receiptFile, "utf8"));
            const actual = [saved.assignmentKey, saved.writerSessionId, saved.sessionFile, saved.reviewSessionFile];
            assert.ok(actual.every(Boolean));
            if (identity) assert.deepEqual(actual, identity);
            identity = actual;
            if (cut.status !== "composition-committed") assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), sourceHead);
            else assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), saved.commitSha);
            saver.db.close();
            saver = SqliteSaver.fromConnString(join(f.job.stateDir, "generation.sqlite"));
            graph = createGenerationGraph(saver, "cli");
            assert.equal((await inspectPiPolicy(f.job)).budget.modelCalls, priorUsage + cut.calls - 13,
              "Checkpoint loss must not double charge writer or reviewer");
            if (cut.calls === 18 && cancel) {
              await setJobControl(f.job, "cancelled");
              const stopped = await withJobModelRuntime(runtime, () => graph.invoke(null, cfg));
              assert.equal(stopped.status, "cancelled");
              assert.equal(observed.length, 18);
              assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), sourceHead);
              return;
            }
            if (cut.calls === 18 && budgetPause) {
              const { configurePiPolicy } = await import("../src/job-pi-policy.js");
              const policy = await inspectPiPolicy(f.job);
              await configurePiPolicy(f.job, { ...policy.policy, limits: { ...policy.policy.limits, modelCalls: policy.budget.modelCalls } });
              const paused = await withJobModelRuntime(runtime, () => graph.invoke(null, cfg));
              assert.equal(paused.status, "paused", JSON.stringify({ reason: paused.reason, recovery: paused.recoveryLifecycle }));
              assert.equal(observed.length, 18);
              assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), sourceHead);
              await configurePiPolicy(f.job, { ...policy.policy, limits: { ...policy.policy.limits, modelCalls: policy.budget.modelCalls + 100 } });
              // Resume through the parent; the original settled rejection must be reused.
              const resumed = await withJobModelRuntime(runtime, () => graph.invoke({ request: paused.request }, { ...cfg, interruptBefore: ["independent_assignment_review"] }));
              assert.equal(resumed.result?.status, "composition-committed", JSON.stringify({reason: resumed.reason, recovery: resumed.recoveryLifecycle}));
              assert.equal(observed.length, 22);
              const result = JSON.parse(readFileSync(receiptFile, "utf8"));
              assert.deepEqual([result.assignmentKey, result.writerSessionId, result.sessionFile, result.reviewSessionFile], identity);
              assert.equal((await inspectPiPolicy(f.job)).budget.modelCalls, priorUsage + 9);
              return;
            }
          }
        }
        const composed = await withJobModelRuntime(runtime, () => graph.invoke(null,
          { ...cfg, interruptBefore: [postcommit || stalled ? "assess_recovery" : "independent_assignment_review"] }));
        if (stalled) {
          assert.equal(observed.length, 26, JSON.stringify({reason: composed.reason, recovery: composed.recoveryLifecycle}));
          assert.equal(composed.recoveryLifecycle.active?.origin.operation, "specialist-result");
          const caseId = composed.recoveryLifecycle.active!.id;
          const saved = JSON.parse(readFileSync(join(f.job.stateDir, "composition-items/disclosure.json"), "utf8"));
          assert.equal(saved.phase, "writing");
          assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), saved.beforeHead);
          const decision = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] }));
          assert.equal(decision.recoveryLifecycle.decision?.action, "diagnostic");
          assert.equal(observed.length, 26);
          const stopped = await withJobModelRuntime(runtime, () => graph.invoke(null, cfg));
          assert.equal(stopped.status, "blocked");
          assert.equal(stopped.recoveryLifecycle.active?.id, caseId);
          assert.equal(stopped.recoveryLifecycle.decision?.action, "diagnostic-stop", JSON.stringify(stopped.recoveryLifecycle));
          assert.equal(observed.length, 27);
          assert.ok(!observed.at(-1)!.tools.includes("write") && !observed.at(-1)!.tools.includes("edit"));
          assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), saved.beforeHead);
          const resumed = await withJobModelRuntime(runtime, () => graph.invoke({ request: stopped.request }, cfg));
          assert.equal(resumed.status, "blocked");
          assert.equal(resumed.recoveryLifecycle.active?.id, caseId);
          assert.equal(observed.length, 27);
          return;
        }
        assert.equal(composed.result?.status, "composition-committed", JSON.stringify({
          status: composed.status, reason: composed.reason, result: composed.result,
          lifecycle: composed.recoveryLifecycle, modelCalls: observed.length,
        }));
        assert.equal(composed.active?.stage, "composition");
        const composition = JSON.parse(readFileSync(join(f.job.stateDir, "composition-items/disclosure.json"), "utf8"));
        assert.equal(composition.invocationProof.ordinal, productive ? 3 : 1);
        assert.equal(composition.reviewPin.round, productive ? 3 : 1);
        if (productive) for (const fix of fixes) assert.ok(readFileSync(join(f.job.worktreeStoryRoot, "authored-content/disclose-ledger-scene.md"), "utf8").includes(fix));
        assert.match(readFileSync(join(f.job.worktreeStoryRoot, "authored-content/disclose-ledger-scene.md"), "utf8"),
          /Ada knows only what the two signed records establish/);
        if (!postcommit) assert.equal(composed.recoveryLifecycle.active, null);
        assert.equal((await inspectInteractiveConflict(f.job,
          "milestone.disclosure", true)).expectedHead, head,
          "Historical Pi no-write source remains its original HEAD after later Composition");
        if (!postcommit) assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver,
          cfg.configurable.thread_id), composed.recoveryLifecycle,
          "After subsequent Composition, C07 must authenticate the historical no-write correction against actual signed successor commits");
        if (postcommit) {
          const original = (await inspectRecoveryCheckpoints(f.job)).find(p => p.commitSha === composition.commitSha);
          assert.equal(original?.semanticReview, "failed", JSON.stringify({ reason: composed.reason, calls: observed.length }));
          const failed = composed;
          assert.equal(failed.recoveryLifecycle.active?.origin.operation, "independent-review", JSON.stringify({reason: failed.reason, calls: observed.length}));
          assert.equal(observed.length, 24);
          const selected = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] }));
          assert.equal(selected.recoveryLifecycle.decision?.action, "known-correction");
          const abort = new AbortController();
          const put = saver.put.bind(saver), putWrites = saver.putWrites.bind(saver);
          let crashed = false;
          const error = Error("Lost Composition postcommit repair output");
          saver.put = async (...args) => { if (crashed) throw error; return put(...args); };
          saver.putWrites = async (config, writes, taskId) => {
            if (crashed) throw error;
            const submission = writes.find(([channel]) => channel === "submission")?.[1] as { status?: string } | undefined;
            if (config.configurable?.checkpoint_ns?.includes("assignment-") && submission?.status === "repair-round" && observed.length === 26) {
              crashed = true; abort.abort(error); throw error;
            }
            return putWrites(config, writes, taskId);
          };
          await assert.rejects(withJobModelRuntime(runtime, () => graph.invoke(null, {
            ...cfg, interruptAfter: ["independent_assignment_review"], signal: abort.signal, durability: "sync" })));
          assert.ok(crashed, "Reached the actual postcommit correction child publication");
          assert.equal(observed.length, 26);
          const successor = git(f.job.worktreeRoot, "rev-parse", "HEAD");
          assert.notEqual(successor, composition.commitSha);
          saver.db.close();
          saver = SqliteSaver.fromConnString(join(f.job.stateDir, "generation.sqlite"));
          graph = createGenerationGraph(saver, "cli");
          const passed = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["independent_assignment_review"] }));
          assert.equal(passed.result?.headSha, successor, JSON.stringify({reason: passed.reason, calls: observed.length, lifecycle: passed.recoveryLifecycle}));
          assert.equal(observed.length, 28);
          await assertSubunitReviewSessions(f.job, {commitSha: composition.commitSha, piSessionFile: composition.sessionFile}, successor);
          assert.match(readFileSync(join(f.job.worktreeStoryRoot, "authored-content/disclose-ledger-scene.md"), "utf8"), /Ada points to the matching signatures/);
          assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
        }
        const finalGate = await withJobModelRuntime(runtime, () => graph.invoke(null,
          { ...cfg, interruptBefore: ["completion_decision"] }));
        assert.equal(finalGate.status, "running", JSON.stringify({
          status: finalGate.status, reason: finalGate.reason,
          active: finalGate.active, recovery: finalGate.recoveryLifecycle,
          inventory: finalGate.inventory?.items.map((item: any) => ({
            id: item.id, status: item.status, reason: item.blockingReason,
          })), calls: observed.length,
        }));
        assert.equal(finalGate.recoveryLifecycle.active, null);
        const final = await withJobModelRuntime(runtime, () => graph.invoke(null,
          incomplete ? { ...cfg, interruptBefore: ["assess_recovery"] } : cfg));
        if (incomplete) {
          const report = await (await import("../src/job-report.js")).inspectJobReport(final.request);
          assert.equal(report.generation.planFulfillment.status, "incomplete");
          assert.equal(report.generation.planFulfillment.findings[0]?.objectiveId, "goal");
          assert.notEqual(final.status, "completed");
          assert.equal(final.recoveryLifecycle.active?.origin.operation, "completion-verification");
          assert.ok(final.inventory?.items.every((item: any) => item.status === "verified"));
          assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), finalGate.inventory?.headSha);
          assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver,
            cfg.configurable.thread_id), final.recoveryLifecycle);
          const caseId = final.recoveryLifecycle.active?.id;
          const beforeDiagnostic = observed.length;
          const stopped = await withJobModelRuntime(runtime, () => graph.invoke(null, cfg));
          assert.equal(stopped.status, "blocked");
          assert.equal(stopped.recoveryLifecycle.active?.id, caseId);
          assert.equal(stopped.recoveryLifecycle.decision?.action, "diagnostic-stop",
            JSON.stringify({ reason: stopped.reason, recovery: stopped.recoveryLifecycle }));
          assert.equal(stopped.recoveryLifecycle.attempt?.phase, "settled");
          assert.equal(observed.length, beforeDiagnostic + 1);
          assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver,
            cfg.configurable.thread_id), stopped.recoveryLifecycle);
          const restarted = await withJobModelRuntime(runtime, () => graph.invoke({ request: stopped.request }, cfg));
          assert.equal(restarted.status, "blocked");
          assert.equal(restarted.recoveryLifecycle.active?.id, caseId);
          assert.equal(observed.length, beforeDiagnostic + 1, "The negative objective cannot replay Review or diagnosis");
          assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), finalGate.inventory?.headSha);
          const folder = join(f.job.stateDir, "turn-fulfillment");
          const receipt = readdirSync(folder).map(name => join(folder, name)).find(path => {
            const saved = JSON.parse(readFileSync(path, "utf8"));
            return saved.verdict?.verdict === "incomplete";
          });
          assert.ok(receipt);
          const original = readFileSync(receipt, "utf8");
          try {
            const altered = JSON.parse(original);
            altered.verdict.findings[0].message = "A different finding";
            writeFileSync(receipt, JSON.stringify(altered));
            const fenced = await inspectModernGenerationRecovery(f.job, saver, cfg.configurable.thread_id);
            assert.equal(fenced?.phase, "fenced");
            assert.ok(fenced?.inspectionFences.length, "Altered final finding invalidates the sealed diagnosis");
            assert.equal(observed.length, beforeDiagnostic + 1);
          } finally { writeFileSync(receipt, original); }
          return;
        }
        assert.equal(final.status, "completed", JSON.stringify({
          status: final.status, reason: final.reason,
          recovery: final.recoveryLifecycle, calls: observed.length,
          inventory: final.inventory?.items.map((item: any) => ({ id: item.id,
            status: item.status, reason: item.blockingReason })),
        }));
        assert.equal(final.recoveryLifecycle.active, null);
        assert.ok(final.inventory?.items.every((item: any) => item.status === "verified"));
        assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver,
          cfg.configurable.thread_id), final.recoveryLifecycle);
      }
    } finally { saver.db.close(); }
  } finally {
    restoreSandbox();
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("C04 real Pi World negative selects source-bound owner strategy in the original production graph", { skip: !available }, async () => {
  const f = setup("c04-world-owner-pi");
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  saveFixtureTurn(f.job, contract, f.start[3]!, [
    "World Foundations may not rewrite an independently approved Architecture prerequisite.",
  ]);
  assert.equal(f.cli([...f.start, "--pause-after", "foundation"]).status, "paused");
  await sealFixtureGenerationCheckpoint(f, "foundation");
  const paused = f.cli(["generate", "resume", "--pause-after", "architecture"]);
  assert.equal(paused.status, "paused", JSON.stringify(paused));
  await sealFixtureGenerationCheckpoint(f, "global-architecture");
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
      const initial = (await graph.getState(cfg)).values;
      const item = paused.inventory.items.find((i: { id: string }) => i.id === "foundations");
      assert.ok(item);
      await graph.updateState(cfg, {
        status: "running", reason: null, active: item, result: null, pauseAfter: null,
        request: { ...initial.request, fixture: false, turnPlanDigest: turnDigest,
          provider: scriptedModel.provider, model: scriptedModel.id },
      }, "author_update_intake");
      const admitted = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptBefore: ["assess_recovery"] }));
      assert.equal(admitted.recoveryLifecycle.active?.origin.operation, "specialist-result",
        JSON.stringify({ status: admitted.status, reason: admitted.reason,
          recovery: admitted.recoveryLifecycle, sources: admitted.recoverySources,
          active: admitted.active, result: admitted.result }));
      assert.equal(admitted.recoveryLifecycle.active?.observation, "returned-failure");
      assert.equal(admitted.recoveryLifecycle.attempt, null);
      const selected = await graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] });
      assert.equal(selected.recoveryLifecycle.decision?.action, "plan-amendment");
      assert.equal(selected.recoveryLifecycle.decision?.adapter, "dependency-work");
      assert.equal(selected.recoveryLifecycle.decision?.owner, "architecture");
      assert.equal(selected.recoveryLifecycle.assessorPending, true);
      assert.deepEqual(await inspectModernGenerationRecovery(f.job, saver, paused.threadId),
        selected.recoveryLifecycle,
        "A saved owner correction must authenticate the original Pi and source on restart");
      assert.equal(observed.length, 2, "Selection does not invoke any model or replacement writer");
      const stopped = await graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] });
      assert.equal(stopped.status, "blocked");
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

for (const needsCharacter of [false, true]) test("R14D Event native correction and negative Review recover in the original SQLite assignment" + (needsCharacter ? " with Character support" : ""), {
  skip: !available, timeout: 120_000,
}, async () => {
  const f = setup("r14d-event-rounds" + (needsCharacter ? "-character" : ""));
  f.env.NT_ARCHITECTURE_FIXTURE_CASE = "decision-choice";
  f.env.NT_INTERACTIVE_FIXTURE_CASE = "two-choices";
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope = { kind: "full-story", depth: "composition", targets: [], branches: [] };
  writeFileSync(f.contract, JSON.stringify(contract));
  if (needsCharacter) f.start[3] += " Include Mara, the central night witness, in the disclosure Event.";
  saveFixtureTurn(f.job, contract, f.start[3]!, [
    "Release and withhold must produce independently evidenced Choice consequences.",
    ...(needsCharacter ? ["Characters include Mara, a required night witness who participates in the disclosure Event."] : []),
  ]);
  if (needsCharacter) {
    // The generic fixture Turn lacks a Character-creation owner. Use the
    // real authority shape required for the full-Story support grant.
    const file = join(f.job.stateDir, "turn-plan.json");
    const { digest: _digest, ...body } = JSON.parse(readFileSync(file, "utf8"));
    const foundations = body.assignments.find((a: { id: string }) => a.id === "foundations");
    foundations.specialist = "nt-worldbuilding + nt-character-development";
    foundations.authority.recordTypes = ["character", "world-entity"];
    writeFileSync(file, JSON.stringify({ ...body, digest: createHash("sha256").update(JSON.stringify(body)).digest("hex") }, null, 2));
  }
  assert.equal(f.cli([...f.start, "--pause-after", "foundation"]).status, "paused");
  await sealFixtureGenerationCheckpoint(f, "foundation");
  assert.equal(f.cli(["generate", "resume", "--pause-after", "architecture"]).status, "paused");
  await sealFixtureGenerationCheckpoint(f, "global-architecture");
  assert.match(f.cli(["foundations", "run", "--fixture", "--skills-source", source], false),
    /review|independent/i);
  await sealFixtureGenerationCheckpoint(f, "world-foundations");
  assert.equal(f.cli(["foundations", "run", "--fixture", "--skills-source", source]).status, "foundations-committed");
  await sealFixtureGenerationCheckpoint(f, "character-foundations");
  const paused = f.cli(["generate", "resume", "--pause-after", "foundations"]);
  assert.equal(paused.status, "paused", JSON.stringify(paused));
  const saved = Object.fromEntries(["NT_STATE_DIR", "NT_CONFIG_FILE", "NT_SKILL_CACHE_DIR",
    "NT_SANDBOX_SOCKET", "NT_SANDBOX_TOKEN_FILE",
    "NT_ARCHITECTURE_FIXTURE_CASE"].map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    NT_STATE_DIR: f.env.NT_STATE_DIR,
    NT_CONFIG_FILE: f.env.NT_CONFIG_FILE,
    NT_SKILL_CACHE_DIR: f.env.NT_SKILL_CACHE_DIR,
    NT_ARCHITECTURE_FIXTURE_CASE: f.env.NT_ARCHITECTURE_FIXTURE_CASE,
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
          limits: "The release and withhold consequences still need Choice authorship" }],
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
    const requiredCorrection = needsCharacter ? "Create a missing Character record for Mara and add her to Event participants; deliver her required on-screen witness dialogue." : quote;
    const supportPath = "characters/mara.md";
    const character = "---\nschema: '0.1'\ntype: character\nid: character.mara\ntitle: Mara\nstatus: draft\ndecisions: []\nmotivation: Protect the witness and testify truthfully\ninitial_knowledge: []\n---\n\nMara is the archive night witness. She is willing to testify to preserve the ledger and protect the witness.\n";
    const corrected = needsCharacter ? authored.replace("participants: [character.ada, character.neri]", "participants: [character.ada, character.neri, character.mara]") : authored;
    const manifest = { modifiedRecords: [path], architecturalConflicts: [], laterObligations: [
      "Formal Choice Point binding must enact the protect and challenge outcomes for this Milestone before fulfillment.",
    ] };
    const { runtime, observed } = await scriptedStoryRuntime((index, context) => {
      if ([0, 2, 4].includes(index)) return { content: scriptedReadCalls(readSources, index), reason: "toolUse" };
      if (index === 1) return { content: scriptedText(plan), reason: "stop" };
      if (index === 3) return { content: scriptedText({ schema: "noveltea-milestone-blueprint-review/v5",
        status: "pass", findings: [], prior: [] }), reason: "stop" };
      const write = (content: string) => ({ content: [{ type: "toolCall" as const,
        id: "r14d-event-" + index, name: "write", arguments: { path, content } }], reason: "toolUse" as const });
      if (index === 5) return write(authored.replace("value: knows", "value: known"));
      if (index === 6 || index === 8) return { content: scriptedText(manifest), reason: "stop" };
      if (index === 7) {
        assert.match(JSON.stringify(context.messages), /SOURCE-BOUND STORY CORRECTION/);
        return write(authored);
      }
      if (index === 9) return { content: scriptedReadCalls(boundedPinnedSources("nt-narrative-review").map(p => "skill://" + p), index), reason: "toolUse" };
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
        const assignment = JSON.parse(prompt.split("\nASSIGNMENT:\n")[1]!);
        if (index === 16) return { content: scriptedReadCalls(prompt.split("PINNED REFERENCES:\n")[1]!.split("\nSTORY PATHS:")[0]!.split("\n").filter(p => p.startsWith("skill://")).concat(assignment.paths), index), reason: "toolUse" };
        return { content: scriptedText({ verdict: "pass", findings: [], evidence: [supportPath + ":1: Mara has a source-grounded role as required."] }), reason: "stop" };
      }
      const correctionIndex = needsCharacter ? 18 : 11;
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
            requiredCorrection, affectedPaths: [path] }] : [],
          evidence: index !== 10 ? [{ ...ref, explanation: quote }] : [],
          ...(index !== 10 ? { progressDiagnosis: { status: "material", reason: "Added visible observation.",
            evidence: { path, quote, change: "added" } } } : {}),
        }), reason: "stop" };
      }
      throw Error("Unexpected Event assignment call " + index);
    });
    let graph = createGenerationGraph(saver, "cli");
    const cfg = { configurable: { thread_id: paused.threadId }, recursionLimit: 1000 };
    const initial = (await graph.getState(cfg)).values;
    const item = paused.inventory.items.find((entry: { id: string }) => entry.id === "event:milestone.disclosure");
    assert.ok(item);
    const turnDigest = JSON.parse(readFileSync(join(f.job.stateDir, "turn-plan.json"), "utf8")).digest;
    await graph.updateState(cfg, { status: "running", reason: null, active: item, result: null, pauseAfter: null,
      request: { ...initial.request, fixture: false, turnPlanDigest: turnDigest, provider: scriptedModel.provider, model: scriptedModel.id },
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
    await crashAtSubmission("writer-round", 9, { interruptBefore: ["assess_recovery"] });
    const failed = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptBefore: ["assess_recovery"] }));
    assert.equal(failed.recoveryLifecycle.active?.origin.operation, "independent-review", JSON.stringify({ reason: failed.reason, recovery: failed.recoveryLifecycle, calls: observed.length }));
    assert.equal(observed.length, 11);
    const event = JSON.parse(readFileSync(join(f.job.stateDir, "event-items/disclosure.json"), "utf8"));
    assert.equal(event.invocationProof.ordinal, 1);
    const selected = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["assess_recovery"] }));
    assert.equal(selected.recoveryLifecycle.decision?.action, "known-correction", JSON.stringify(selected.recoveryLifecycle));
    await assertSubunitReviewAuthority(f.job, selected, "event-disclosure", "interactive-choice-disclosure", event.assignmentKey);
    if (needsCharacter) {
      const suspended = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptBefore: ["dependency_amendment"] }));
      assert.ok(suspended.reviewPrerequisite, JSON.stringify({ reason: suspended.reason, lifecycle: suspended.recoveryLifecycle, calls: observed.length }));
      assert.equal(suspended.reviewPrerequisite.suspension.pendingPhase, "review");
      assert.equal(suspended.reviewPrerequisite.suspension.owner, "nt-character-development");
      assert.equal(suspended.reviewPrerequisite.suspension.assignmentKey, event.assignmentKey);
      assert.equal(observed.length, 11);
      await crashAtSubmission("focused-committed", 16, { interruptAfter: ["dependency_amendment"] });
      const supportHead = git(f.job.worktreeRoot, "rev-parse", "HEAD");
      assert.equal(git(f.job.worktreeRoot, "diff", "--name-only", event.commitSha, supportHead), "story/" + supportPath);
      const supported = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["dependency_amendment"] }));
      assert.ok(supported.reviewPrerequisite?.supportRef, JSON.stringify({ reason: supported.reason, lifecycle: supported.recoveryLifecycle, calls: observed.length }));
      assert.deepEqual(supported.reviewPrerequisite.identity, suspended.reviewPrerequisite.identity);
      assert.equal(observed.length, 18);
      assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), supportHead);
    }
    await crashAtSubmission("repair-round", needsCharacter ? 20 : 13, { interruptAfter: ["independent_assignment_review"] });
    const successor = git(f.job.worktreeRoot, "rev-parse", "HEAD");
    assert.notEqual(successor, event.commitSha);
    const passed = await withJobModelRuntime(runtime, () => graph.invoke(null, { ...cfg, interruptAfter: ["independent_assignment_review"] }));
    assert.equal(passed.result?.headSha, successor, JSON.stringify({ reason: passed.reason, recovery: passed.recoveryLifecycle, calls: observed.length }));
    assert.equal(observed.length, needsCharacter ? 21 : 14);
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
    assert.equal(next.active?.stage, "interactive");
    assert.equal(observed.length, needsCharacter ? 21 : 14);
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
  saveFixtureTurn(f.job, contract, f.start[3]!, ["Keep the original archive mystery objective."]);
  const turnDigest = JSON.parse(readFileSync(join(f.job.stateDir, "turn-plan.json"), "utf8")).digest;
  let paused: any;
  if (studio) {
    // Seed only the already validated prerequisite commits on the eventual
    // server Thread. The real writer starts after authenticated server claim.
    const checkpointPath = join(f.job.stateDir, "web-generation.sqlite");
    const threadId = f.job.threadId + ":generation:web";
    const seedSaver = SqliteSaver.fromConnString(checkpointPath);
    const seedGraph = createGenerationGraph(seedSaver, "server");
    const cfg = { configurable: { thread_id: threadId }, recursionLimit: 1000 };
    const before = Object.fromEntries(Object.keys(f.env).map(key => [key, process.env[key]]));
    Object.assign(process.env, f.env);
    try {
      const request = { story: f.story, job: f.job.jobId, task: f.start[3]!, contract,
        fixture: true, skillsSource: source, turnPlanDigest: turnDigest, orchestrationPolicy: "explicit" as const };
      const foundation = await seedGraph.invoke({ request, pauseAfter: "foundation" }, cfg);
      assert.equal(foundation.status, "paused", foundation.reason ?? "");
      await sealFixtureGenerationCheckpoint(f, "foundation");
      const architecture = await seedGraph.invoke({ request, pauseAfter: "architecture" }, cfg);
      assert.equal(architecture.status, "paused", architecture.reason ?? "");
      paused = { ...architecture, checkpointPath, threadId };
      await sealFixtureGenerationCheckpoint(f, "global-architecture");
      // Deterministic prerequisite fixture only: replace the fixture transport
      // request with the real scripted Pi request before Studio admission.
      // Both checkpoints retain the same web Thread; no production owner changes.
      unlinkSync(join(f.job.stateDir, "generation-server-owner.json"));
    } finally {
      seedSaver.db.close();
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  } else {
    assert.equal(f.cli([...f.start, "--pause-after", "foundation"]).status, "paused");
    await sealFixtureGenerationCheckpoint(f, "foundation");
    paused = f.cli(["generate", "resume", "--pause-after", "architecture"]);
    assert.equal(paused.status, "paused");
    await sealFixtureGenerationCheckpoint(f, "global-architecture");
  }
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
    const request = { ...initial.request, fixture: false, turnPlanDigest: turnDigest,
      provider: scriptedModel.provider, model: scriptedModel.id };
    if (studio) await studio.admit(request, paused.threadId);
    await graph.updateState(cfg, { status: "running", reason: null, active: item, result: null, pauseAfter: null,
      request,
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
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  saveFixtureTurn(f.job, contract, f.start[3]!, ["Keep the original archive mystery objective."]);
  assert.equal(f.cli([...f.start, "--pause-after", "foundation"]).status, "paused");
  await sealFixtureGenerationCheckpoint(f, "foundation");
  const paused = f.cli(["generate", "resume", "--pause-after", "architecture"]);
  assert.equal(paused.status, "paused");
  await sealFixtureGenerationCheckpoint(f, "global-architecture");
  const turnDigest = JSON.parse(readFileSync(join(f.job.stateDir, "turn-plan.json"), "utf8")).digest;
  const paths = ["world-entities/archive.md", "facts/evidence-concealed.md"];
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
    const initial = (await graph.getState(cfg)).values;
    const item = paused.inventory.items.find((entry: { id: string }) => entry.id === "foundations");
    await graph.updateState(cfg, { status: "running", reason: null, active: item, result: null, pauseAfter: null,
      request: { ...initial.request, fixture: false, turnPlanDigest: turnDigest, provider: scriptedModel.provider, model: scriptedModel.id },
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
    assert.equal((await inspectPiPolicy(f.job)).budget.modelCalls, observed.length,
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

test("C04 production graph admits settled World contradiction and never dispatches Character", { skip: !available }, () => {
  const f = setup("c04-world-negative-graph");
  Object.assign(f.env, { NT_FOUNDATIONS_FIXTURE_CASE: "world-conflict" });
  const initial = f.cli(f.start);
  assert.equal(initial.status, "blocked");
  const recovery = currentOperationRecovery(initial);
  assert.equal(recovery?.operation, "specialist-result");
  assert.equal(recovery?.outcome, "returned-failure");
  assert.equal(recovery?.evidence.resultStatus, "foundations-conflict-reported");
  assert.equal(recovery?.evidence.foundationsNoWrite?.domain, "world");
  assert.equal(initial.inventory.items.find((i: { id: string }) => i.id === "foundations").status, "blocked");
  const original = join(f.job.stateDir, "character-world.json");
  const saved = readFileSync(original, "utf8");
  const before = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const resumed = f.cli(["generate", "resume"]);
  assert.equal(resumed.status, "blocked");
  assert.equal(readFileSync(original, "utf8"), saved);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), before);
  assert.equal(JSON.parse(saved).units[1].phase, "pending",
    "A World contradiction must not turn Character into an automatic replacement writer");
});

test("C04 production graph admits Character's settled contradiction without replaying the committed World", { skip: !available }, () => {
  const f = setup("c04-character-negative-graph");
  Object.assign(f.env, { NT_FOUNDATIONS_FIXTURE_CASE: "character-conflict" });
  const initial = f.cli(f.start);
  assert.equal(initial.status, "blocked");
  const recovery = currentOperationRecovery(initial);
  assert.equal(recovery?.operation, "specialist-result");
  assert.equal(recovery?.outcome, "returned-failure");
  assert.equal(recovery?.evidence.resultStatus, "foundations-conflict-reported");
  assert.equal(recovery?.evidence.foundationsNoWrite?.domain, "character");
  const receiptFile = join(f.job.stateDir, "character-world.json");
  const saved = readFileSync(receiptFile, "utf8");
  const world = JSON.parse(saved).units[0];
  assert.equal(world.phase, "committed");
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  assert.equal(world.commitSha, head);
  const resumed = f.cli(["generate", "resume"]);
  assert.equal(resumed.status, "blocked");
  assert.equal(readFileSync(receiptFile, "utf8"), saved);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
});

test("C04 production graph admits a settled Choice contradiction as specialist-result and never replays the writer", { skip: !available }, () => {
  const f = setup("c04-choice-negative");
  Object.assign(f.env, { NT_INTERACTIVE_FIXTURE_CASE: "choice-conflict" });
  const result = f.cli(f.start);
  assert.equal(result.status, "blocked");
  const op = currentOperationRecovery(result);
  assert.equal(op?.operation, "specialist-result");
  assert.equal(op?.outcome, "returned-failure");
  assert.equal(op?.evidence.resultStatus, "interactive-conflict-reported");
  assert.equal(op?.evidence.interactiveNoWrite?.domain, "choice");
  const original = join(f.job.stateDir, "interactive-items/disclosure.json");
  const saved = readFileSync(original, "utf8");
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const again = f.cli(["generate", "resume"]);
  assert.equal(again.status, "blocked");
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
  assert.equal(readFileSync(original, "utf8"), saved, "Negative report is never replayed or rewritten");
  assert.equal(git(f.job.worktreeRoot, "status", "--porcelain", "--untracked-files=all"), "");
});

test("R06 production graph preserves a required Puzzle contradiction after the committed Choice", { skip: !available }, () => {
  const f = setup("r06-puzzle-negative");
  Object.assign(f.env, { NT_INTERACTIVE_FIXTURE_CASE: "puzzle-no-write" });
  const result = f.cli(f.start);
  assert.equal(result.status, "blocked");
  const op = currentOperationRecovery(result);
  assert.equal(op?.operation, "specialist-result");
  assert.equal(op?.outcome, "returned-failure");
  assert.equal(op?.evidence.interactiveNoWrite?.domain, "puzzle");
  const original = join(f.job.stateDir, "interactive-items/disclosure.json");
  const saved = readFileSync(original, "utf8");
  const receipt = JSON.parse(saved);
  assert.equal(receipt.units[0].phase, "committed");
  assert.equal(receipt.units[1].phase, "conflicted");
  assert.equal(result.inventory.headSha, receipt.units[0].beforeHead,
    "The composite inventory is still pinned to the original pre-Choice source");
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  assert.equal(op?.evidence.interactiveNoWrite?.expectedHead, head);
  assert.equal(f.cli(["generate", "resume"]).status, "blocked");
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
  assert.equal(readFileSync(original, "utf8"), saved);
});

for (const domain of ["choice", "puzzle"] as const) test(`R06 ${domain} commit before checkpoint finalization resumes without replay`, { skip: !available }, () => {
  const f = setup("r06-crash-" + domain);
  const id = "interactive-" + domain + "-disclosure";
  f.env.NT_RECOVERY_FIXTURE_CRASH_AFTER_INTENT = id;
  const crashed = f.cli([...f.start, "--pause-after", "interactive"]);
  assert.equal(crashed.status, "blocked", JSON.stringify(crashed));
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  assert.ok(crashed.recoveryCheckpoints.some((p: any) => p.commitSha === head && !p.eligible));
  const file = join(f.job.stateDir, "interactive-items/disclosure.json");
  const before = JSON.parse(readFileSync(file, "utf8"));
  delete f.env.NT_RECOVERY_FIXTURE_CRASH_AFTER_INTENT;
  const resumed = f.cli(["generate", "resume", "--pause-after", "interactive"]);
  assert.equal(resumed.status, "paused", JSON.stringify({ reason: resumed.reason, operationRecovery: resumed.operationRecovery }));
  assert.ok(resumed.recoveryCheckpoints.some((p: any) => p.commitSha === head && p.workItem === id && p.eligible));
  const after = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(after.units[0].commitSha, before.units[0].commitSha);
  if (domain === "puzzle") assert.equal(after.units[1].commitSha, head);
  assert.equal(after.units[1].phase, "committed");
  assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
});

for (const domain of ["event", "composition"] as const) test(`R07 ${domain} commit before checkpoint finalization resumes without replay`, { skip: !available }, () => {
  const f = setup("r07-crash-" + domain);
  const id = domain + "-disclosure";
  f.env.NT_RECOVERY_FIXTURE_CRASH_AFTER_INTENT = id;
  const crashed = f.cli([...f.start, "--pause-after", domain]);
  assert.equal(crashed.status, "blocked", JSON.stringify({ reason: crashed.reason }));
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  assert.ok(crashed.recoveryCheckpoints.some((p: any) => p.commitSha === head && !p.eligible));
  const file = join(f.job.stateDir, domain + "-items/disclosure.json");
  const before = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(before.commitSha, head);
  delete f.env.NT_RECOVERY_FIXTURE_CRASH_AFTER_INTENT;
  const resumed = f.cli(["generate", "resume", "--pause-after", domain]);
  assert.equal(resumed.status, "paused", JSON.stringify({ reason: resumed.reason, operationRecovery: resumed.operationRecovery }));
  assert.ok(resumed.recoveryCheckpoints.some((p: any) => p.commitSha === head && p.workItem === id && p.eligible));
  const after = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(after.commitSha, before.commitSha);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
  assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
});

test("R14C Choice and Puzzle native and independent Review corrections preserve their distinct original assignments", { skip: !available, timeout: 120_000 }, async () => {
  // The fixture supplies valid native record bytes, not the authority or
  // recovery behavior of the production writer under test.
  async function prepare(name: string) {
    const f = setup(name);
    f.env.NT_EVENT_FIXTURE_CASE = "decision-pending";
    const contract = JSON.parse(readFileSync(f.contract, "utf8"));
    contract.scope = { kind: "full-story", depth: "composition", targets: [], branches: [] };
    writeFileSync(f.contract, JSON.stringify(contract));
    saveFixtureTurn(f.job, contract, f.start[3]!, ["The player must make a consequential local Choice."]);
    assert.equal(f.cli([...f.start, "--pause-after", "foundation"]).status, "paused");
    await sealFixtureGenerationCheckpoint(f, "foundation");
    assert.equal(f.cli(["generate", "resume", "--pause-after", "architecture"]).status, "paused");
    await sealFixtureGenerationCheckpoint(f, "global-architecture");
    assert.match(f.cli(["foundations", "run", "--fixture", "--skills-source", source], false), /review|independent/i);
    await sealFixtureGenerationCheckpoint(f, "world-foundations");
    assert.equal(f.cli(["foundations", "run", "--fixture", "--skills-source", source]).status, "foundations-committed");
    await sealFixtureGenerationCheckpoint(f, "character-foundations");
    const paused = f.cli(["generate", "resume", "--pause-after", "event"]);
    assert.equal(paused.status, "paused");
    await sealFixtureGenerationCheckpoint(f, "event-disclosure");
    return { f, paused };
  }
  const template = (await prepare("r14c-interactive-template")).f;
  const fixture = template.cli(["generate", "resume", "--pause-after", "interactive"]);
  assert.equal(fixture.status, "blocked");
  await sealFixtureGenerationCheckpoint(template, "interactive-choice-disclosure");
  const fixturePuzzle = template.cli(["generate", "resume", "--pause-after", "interactive"]);
  assert.ok(["paused", "blocked"].includes(fixturePuzzle.status), JSON.stringify(fixturePuzzle));
  const saved = JSON.parse(readFileSync(join(template.job.stateDir, "interactive-items/disclosure.json"), "utf8"));
  const records = saved.units.map((u: { commitSha: string }) => {
    const paths = git(template.job.worktreeRoot, "diff-tree", "--no-commit-id", "--name-only", "-r", u.commitSha).split("\n")
      .map(path => path.replace(/^story\//, ""));
    return Object.fromEntries(paths.map(path => [path, git(template.job.worktreeRoot, "show", u.commitSha + ":story/" + path) + "\n"]));
  }) as Record<string, string>[];
  const { f, paused } = await prepare("r14c-interactive-real");
  const turnDigest = JSON.parse(readFileSync(join(f.job.stateDir, "turn-plan.json"), "utf8")).digest;
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
    const initial = (await graph.getState(cfg)).values;
    const item = paused.inventory.items.find((entry: { id: string }) => entry.id === "interactive:milestone.disclosure");
    assert.ok(item);
    await graph.updateState(cfg, { status: "running", reason: null, active: item, result: null, pauseAfter: null,
      request: { ...initial.request, fixture: false, turnPlanDigest: turnDigest, provider: scriptedModel.provider, model: scriptedModel.id },
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
    // This fixture Event has no production field grant. The repaired Choice
    // and Puzzle pass the Review gate, but must NOT waive that separate owner.
    assert.deepEqual(await preflight(), { kind: "refuse", reason: "Original Event has no signed selected Milestone field grant." });
    const next = await withJobModelRuntime(runtime, () => graph.invoke(null,
      { ...cfg, interruptBefore: ["specialist_dispatch", "assess_recovery"] }));
    assert.equal(next.inventory?.items.find(i => i.id === item.id)?.status, "verified", JSON.stringify({ reason: next.reason, active: next.active, recovery: next.recoveryLifecycle }));
    assert.equal(next.recoveryLifecycle.active?.origin.operation, "dependency-amendment", JSON.stringify({ reason: next.reason, recovery: next.recoveryLifecycle, active: next.active }));
    assert.equal(next.recoveryLifecycle.active?.origin.assignmentId, "composition:milestone.disclosure");
    assert.equal(next.recoveryLifecycle.active?.observation, "returned-failure");
    assert.equal(next.escalation?.kind, "dependency-replan");
    assert.equal(next.inventory?.items.find(i => i.id === "composition:milestone.disclosure")?.status !== "verified", true);
    assert.equal(next.request.turnPlanDigest, turnDigest);
    assert.equal(observed.length, 20);
    assert.equal((await inspectPiPolicy(f.job)).budget.modelCalls, observed.length,
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
  f.env.NT_EVENT_FIXTURE_CASE = "decision-pending";
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope = { kind: "full-story", depth: "composition", targets: [], branches: [] };
  writeFileSync(f.contract, JSON.stringify(contract));
  saveFixtureTurn(f.job, contract, f.start[3]!, ["The player must make a consequential local Choice."]);
  assert.equal(f.cli([...f.start, "--pause-after", "foundation"]).status, "paused");
  await sealFixtureGenerationCheckpoint(f, "foundation");
  assert.equal(f.cli(["generate", "resume", "--pause-after", "architecture"]).status, "paused");
  await sealFixtureGenerationCheckpoint(f, "global-architecture");
  assert.match(f.cli(["foundations", "run", "--fixture", "--skills-source", source], false), /review|independent/i);
  await sealFixtureGenerationCheckpoint(f, "world-foundations");
  assert.equal(f.cli(["foundations", "run", "--fixture", "--skills-source", source]).status, "foundations-committed");
  await sealFixtureGenerationCheckpoint(f, "character-foundations");
  assert.equal(f.cli(["generate", "resume", "--pause-after", "event"]).status, "paused");
  await sealFixtureGenerationCheckpoint(f, "event-disclosure");
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
    const again = await withJobModelRuntime(runtime, () => runInteractiveWorkItem(opts));
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

test("a clean local cluster block does not stop independent work or spin on resume", { skip: !available }, () => {
  const f = setup("local-block", story => plannedCluster(story, "z-optional", "aaa-optional"));
  Object.assign(f.env, { NT_FOUNDATIONS_FIXTURE_CASE: "one-arc-only" });
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope = { kind: "full-story", depth: "composition", targets: [], branches: [] };
  writeFileSync(f.contract, JSON.stringify(contract));
  const result = f.cli(f.start);
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /linked Character foundations/);
  assert.equal(result.inventory.items.find((i: any) => i.id === "event:milestone.aaa-optional").status, "blocked");
  assert.equal(result.inventory.items.find((i: any) => i.id === "composition:milestone.disclosure").status, "verified");
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const resumed = f.cli(["generate", "resume"]);
  assert.equal(resumed.status, "blocked");
  assert.equal(resumed.inventory.version, result.inventory.version,
    "unchanged local blockers should not be re-dispatched on every resume");
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
  assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
});

test("a controller-approved later scope revision adds a cluster without repeating unaffected commits", { skip: !available }, () => {
  const f = setup("replan", story => plannedCluster(story, "truth", "reckoning"));
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope.targets = ["milestone.disclosure"];
  writeFileSync(f.contract, JSON.stringify(contract));
  const first = f.cli([...f.start, "--pause-after", "composition"]);
  assert.equal(first.status, "paused", first.reason);
  const carriedIds = ["foundations", "event:milestone.disclosure", "interactive:milestone.disclosure", "composition:milestone.disclosure"];
  const carriedCommits = Object.fromEntries(carriedIds.map(id =>
    [id, first.inventory.items.find((i: any) => i.id === id).verifiedSha]));
  const beforeAmendment = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  contract.scope.targets = ["arc.truth"];
  writeFileSync(f.contract, JSON.stringify(contract));
  const carry = join(root, "carry.json");
  writeFileSync(carry, JSON.stringify(["foundations", "event:milestone.disclosure", "interactive:milestone.disclosure", "composition:milestone.disclosure"]));
  const proposal = f.cli(["architecture", "propose", "--contract", f.contract, "--carry-forward", carry]);
  const payload = { ...proposal.authorSigningRequest, reason: "Test author approves the second Milestone and retains the reviewed first cluster." };
  const evidence = authorApproval(f.story, "single", f.env, root, payload).file;
  f.cli(["architecture", "approve", "--proposal", proposal.proposal.digest, "--approval", evidence]);
  const pending = f.cli(["generate", "inspect"]);
  assert.equal(pending.inventory.planVersion, 2);
  assert.deepEqual(pending.inventory.items.map((i: any) => i.id), ["foundation", "architecture"],
    "Historical carry-forward candidates must not authorize dispatch before Architecture commits");
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), beforeAmendment);
  const result = f.cli(["generate", "resume"]);
  assert.equal(result.reason, "editorial-unverified", JSON.stringify(result));
  assert.equal(result.inventory.planVersion, 2);
  for (const id of carriedIds)
    assert.equal(result.inventory.items.find((i: any) => i.id === id).verifiedSha, carriedCommits[id],
      "The new plan must retain the exact signed predecessor for " + id);
  assert.equal(result.inventory.items.find((i: any) => i.id === "composition:milestone.reckoning").status, "verified");
  assert.equal(git(f.job.worktreeRoot, "log", "--format=%B").split("NovelTea-Work-Item: composition-disclosure").length - 1, 1);
});

test("approved scope expansion activates an early deferred idea without replaying prior specialist commits", { skip: !available }, () => {
  const f = setup("idea-replan", story => plannedCluster(story, "truth", "reckoning"));
  const idea = join(root, "idea-replan.json");
  writeFileSync(idea, JSON.stringify({
    id: "replan-witness", kind: "event-concept",
    source: { kind: "author-onboarding", reference: "plot-notes" },
    original: "The witness finally admits why they hid the ledger.",
    requirements: { meaning: [{ text: "The witness explains their earlier secrecy", binding: true }],
      wording: [], participants: [] },
    identities: { known: [], unresolved: [] },
    prerequisites: ["milestone.reckoning"],
    placement: { scopeIds: ["arc.truth"], flexible: true, earliest: "event" },
    upstreamConstraints: [],
  }));
  f.cli(["ideas", "capture", "--file", idea]);
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope.targets = ["milestone.disclosure"];
  writeFileSync(f.contract, JSON.stringify(contract));
  const first = f.cli([...f.start, "--pause-after", "composition"]);
  assert.equal(first.status, "paused", JSON.stringify(first));
  assert.equal(first.ideaHistory.length, 0, "idea waits for the authorized second Milestone");
  const oldCommit = first.inventory.items.find((i: any) => i.id === "composition:milestone.disclosure").verifiedSha;
  contract.scope.targets = ["arc.truth"];
  writeFileSync(f.contract, JSON.stringify(contract));
  const carry = join(root, "idea-replan-carry.json");
  writeFileSync(carry, JSON.stringify(["foundations", "event:milestone.disclosure",
    "interactive:milestone.disclosure", "composition:milestone.disclosure"]));
  const proposal = f.cli(["architecture", "propose", "--contract", f.contract, "--carry-forward", carry]);
  const payload = { ...proposal.authorSigningRequest, reason: "Authorize a second Milestone and keep the first." };
  const evidence = authorApproval(f.story, "single", f.env, root, payload).file;
  f.cli(["architecture", "approve", "--proposal", proposal.proposal.digest, "--approval", evidence]);
  const result = f.cli(["generate", "resume"]);
  assert.equal(result.status, "blocked", JSON.stringify(result));
  assert.equal(result.inventory.planVersion, 2);
  assert.equal(result.inventory.items.find((i: any) => i.id === "composition:milestone.disclosure").verifiedSha, oldCommit);
  assert.ok(result.ideaHistory.some((h: any) => h.id === "replan-witness" &&
    h.status === "integrated-editorial-unverified"), JSON.stringify(result.ideaHistory));
  assert.equal(result.report.evidence.deferredIdeas.scopedOutstanding.includes("replan-witness"), true);
  const finalHead = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  assert.equal(f.cli(["generate", "resume"]).status, "blocked");
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), finalHead);
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.initial);
});

test("generation honors author pause, questions, cancellation and cumulative budgets without dispatching", { skip: !available }, () => {
  const f = setup("controls");
  f.cli(["author", "control", "--state", "paused"]);
  const authorPause = f.cli(f.start);
  assert.equal(authorPause.status, "paused");
  assert.equal(authorPause.operationRecovery, null, "normal author pause is not an operational failure");
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), f.initial);
  f.cli(["author", "control", "--state", "running"]);
  f.cli(["pi", "configure", "--max-steps", "0"]);
  assert.equal(f.cli(["generate", "resume"]).status, "paused");
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), f.initial);
  f.cli(["pi", "configure", "--max-steps", "50"]);
  assert.equal(f.cli(["generate", "resume", "--pause-after", "foundation"]).nextStage, "architecture");
  const message = join(root, "question.json");
  writeFileSync(message, JSON.stringify({ id: "ask", kind: "question", payload: { question: "May the witness lie?" } }));
  f.cli(["author", "send", "--file", message]);
  const question = f.cli(["generate", "resume"]);
  assert.equal(question.status, "blocked");
  assert.equal(question.operationRecovery, null, "a waiting Author Question is not an operational failure");
  assert.match(question.reason, /awaiting-author/);
  const response = join(root, "answer.json");
  writeFileSync(response, JSON.stringify({ type: "answer", messageId: "ask", answer: "Yes" }));
  f.cli(["author", "resume", "--file", response]);
  assert.equal(f.cli(["generate", "resume", "--pause-after", "architecture"]).nextStage, "foundations");
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  f.cli(["author", "control", "--state", "cancelled"]);
  const cancelled = f.cli(["generate", "resume"]);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.operationRecovery, null, "explicit cancellation is not a failure");
  // A cancelled Pi writer can leave these bytes after its checkpoint. Neither
  // inspect nor resume may reopen dispatch or mistake dirty recovery for a
  // generic scheduling failure on the terminal job.
  const partial = join(f.job.worktreeStoryRoot, "interrupted-specialist.md");
  writeFileSync(partial, "Original unfinished specialist work");
  assert.equal(f.cli(["generate", "inspect"]).status, "cancelled");
  assert.equal(f.cli(["generate", "resume"]).status, "cancelled");
  assert.equal(readFileSync(partial, "utf8"), "Original unfinished specialist work");
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
});

test("generation preserves unexpected edits and rejects new contracts on resume", { skip: !available }, () => {
  const f = setup("dirty");
  f.cli([...f.start, "--pause-after", "foundation"]);
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const path = join(f.job.worktreeStoryRoot, "author-notes.txt");
  writeFileSync(path, "Preserve my unfinished work");
  const result = f.cli(["generate", "resume"]);
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /clean|unexpected|dirty/i);
  assert.equal(readFileSync(path, "utf8"), "Preserve my unfinished work");
  const inspection = f.cli(["generate", "inspect"]);
  assert.equal(inspection.status, "blocked");
  assert.match(inspection.reason, /clean|unexpected|dirty/i);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
  assert.match(f.cli(["generate", "resume", "--contract", f.contract], false), /pinned/);
  assert.match(f.cli(f.start, false), /already exists/);
});

test("inspection detects dirty work after a saved pause without advancing checkpoints", { skip: !available }, () => {
  const f = setup("inspect-drift");
  f.cli([...f.start, "--pause-after", "foundation"]);
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  writeFileSync(join(f.job.worktreeStoryRoot, "new.txt"), "Do not overwrite");
  const inspection = f.cli(["generate", "inspect"]);
  assert.equal(inspection.status, "blocked");
  assert.equal(inspection.checkpointStatus, "paused");
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
});

test("parent restart reconciles a specialist commit made before receipt/checkpoint publication", { skip: !available }, async () => {
  const f = setup("recovery");
  const paused = f.cli([...f.start, "--pause-after", "foundation"]);
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const file = join(dirname(f.job.worktreeRoot), "foundation.json");
  const receipt = JSON.parse(readFileSync(file, "utf8"));
  receipt.stage = "writing";
  delete receipt.commitSha;
  writeFileSync(file, JSON.stringify(receipt));
  // Simulate a crash window: Git committed, while the parent still schedules
  // foundation and the specialist's final receipt has not been published.
  const saver = SqliteSaver.fromConnString(paused.checkpointPath);
  try {
    const graph = createGenerationGraph(saver);
    await graph.updateState({ configurable: { thread_id: paused.threadId } },
      { cursor: 0, completedStages: [], result: null,
        active: { ...paused.inventory.items.find((i: any) => i.id === "foundation"), status: "pending" } });
  } finally { saver.db.close(); }
  const recovered = f.cli(["generate", "resume", "--pause-after", "foundation"]);
  assert.equal(recovered.status, "paused", JSON.stringify(recovered));
  assert.equal(recovered.completedStages[0].headSha, head);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).stage, "committed");
});

test("R01 obsolete Generation entry is fenced before any model or Git effect", {
  skip: !available, timeout: 120_000,
}, async () => {
  const f = setup("r01-reject-obsolete");
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope = { kind: "full-story", depth: "composition", targets: [], branches: [] };
  writeFileSync(f.contract, JSON.stringify(contract));
  const args = f.start.filter(arg => arg !== "--fixture");
  assert.match(f.cli(args, false), /authenticated Turn plan/);
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

for (const scenario of ["cli", "server", "author-pause", "protocol-exhausted", "nonconverging", "nonconverging-continue", "nonconverging-continue-crash", "nonconverging-continue-budget", "nonconverging-continue-tamper", "nonconverging-continue-transcript", "nonconverging-continue-uncertain", "nonconverging-continue-foreign-file", "nonconverging-continue-cancel", "nonconverging-unsafe", "nonconverging-foreign", "review-rejected", "review-converges", "review-stalled", "review-dispute", "review-stalled-continue", "review-scope", "review-session-unavailable", "review-reviewer-unavailable", "review-protected", "review-native", "review-native-steer", "review-native-protected", "review-native-protocol", "review-native-stall", "review-crash-rounds", "crash-rounds", "crash-grant-tamper", "crash-assignment-tamper", "crash-cancel"] as const)
test("R01 production Foundation enters checkpointed child before scripted Pi; native Git and independent Review remain authoritative (" + scenario + ")", {
  skip: !available, timeout: 240_000,
}, async () => {
  const owner = scenario === "cli" ? "cli" : "server";
  const diagnosticContinue = scenario.startsWith("nonconverging-continue");
  const terminal = scenario === "protocol-exhausted" || scenario.startsWith("nonconverging");
  const realReview = scenario.startsWith("review-");
  const crashRounds = scenario.startsWith("crash-");
  const actualReviewer = realReview || crashRounds || diagnosticContinue;
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
      if (actualReviewer && i === 9)
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
      if (scenario === "review-native-stall" && (i === 13 || i === 14))
        return { content: scriptedText(report), reason: "stop" };
      if (scenario === "review-native-stall" && i === 15) {
        const serialized = JSON.stringify(context.messages);
        const signature = serialized.match(/signature=([a-f0-9]{64});/)?.[1];
        const sourceRef = serialized.match(/sourceRef=([^;]+); category=/)?.[1];
        assert.ok(signature && sourceRef);
        assert.match(serialized, /assignmentDefects/);
        return { content: scriptedText({ schema: "noveltea-recovery-diagnostic-proposal/v1",
          signature, sourceRef, category: "defect", diagnosis: "The native correction did not converge.",
          strategy: "review-adjudication", owner: null, scopeRef: null, prerequisites: [],
          uncertainty: "No currently admitted successor correction." }), reason: "stop" };
      }
      if (nativeRepair && i === 13) {
        assert.match(JSON.stringify(context.messages.at(-1)), /Native|native diagnostics/);
        return { content: [{ type: "toolCall", name: "write", id: "r14b-native-repair",
          arguments: { path: target, content: authored + "\nThe witness took a ledger from the archive before the theft.\n" } }], reason: "toolUse" };
      }
      if (nativeRepair && i === 14) return { content: scriptedText(report), reason: "stop" };
      const revisionIndex = nativeRepair && i >= 15 ? i - 2 : stalled && i >= 19 ? i - 2 : i;
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
      if (actualReviewer && (i === 10 || diagnosticContinue && i === 12 || revising && correctionStep === 2 || dispute && i === 13 || scopeRevision && i === 15)) {
        const messages = context.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
        const prompt = messages.flatMap(m => Array.isArray(m.content) ? m.content : [])
          .map(c => c.text ?? "").findLast(text => text.includes("\nIMMUTABLE REVIEW PACKET\n"));
        assert.ok(prompt, "Original reviewer receives the source-bound packet");
        const packet = JSON.parse(prompt.split("\nIMMUTABLE REVIEW PACKET\n")[1]!);
        const item = packet.items[0];
        const pass = diagnosticContinue || crashRounds || reviewCrash && correction === 1 || correction === 3 || dispute && i === 13 || scopeRevision && i === 15;
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
      let reviewCalls = 0;
      let reviewerError: string | null = null;
      const makeGraph = () => createGenerationGraph(saver, owner, actualReviewer ? undefined : async s => {
        const job = await startStoryJob({ story: f.story, job: "single" }, false);
        const point = (await inspectRecoveryCheckpoints(job)).find(p =>
          p.eligible && p.workItem === "foundation");
        assert.ok(point?.assurance, "The child cannot verify without its native/Git Foundation receipt");
        if (point.semanticReview === "required-pending") {
          reviewCalls++;
          await reviewBoundedAssignments(job, [point], async packet => ({
            sourceDigest: packet.sourceDigest, verdict: "pass" as const, findings: [],
            evidence: packet.items.map(item => ({
              commitSha: item.assurance.commitSha, assignmentId: item.assignment.id,
              path: item.assurance.changedPaths[0]!, line: 1,
              explanation: "Independent deterministic reviewer checked the original source-bound Foundation.",
            })),
          }), "deterministic-r01-independent-review", true).catch(error => {
            reviewerError = String(error); throw error;
          });
        }
        return { result: s.result };
      });
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
        assert.equal(reviewCalls, 0);
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
        result: first.result, calls: observed.length, reviewCalls, reviewerError,
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
      const expectedReviews = actualReviewer ? 0 : 1;
      const expectedCalls = actualReviewer ? 13 : 11;
      assert.equal(reviewCalls, expectedReviews);
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
      if (actualReviewer) {
        assert.ok(observed.slice(-2).every(call => !call.tools.includes("write") && !call.tools.includes("edit")));
        const { inspectPiPolicy } = await import("../src/job-pi-policy.js");
        const policy = await inspectPiPolicy(f.job);
        assert.equal(policy.budget.modelCalls, expectedCalls);
      }
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
      assert.equal(reviewCalls, expectedReviews);
      assert.equal(git(f.job.worktreeRoot, "rev-list", "--count", f.initial + "..HEAD"), "1");
      // Only the controller's original next edges may accept the child result.
      const next = await withJobModelRuntime(runtime, () =>
        graph.invoke(null, { ...config, interruptAfter: ["verify_committed_work"] }));
      assert.equal(observed.length, expectedCalls, "Parent verification cannot repeat the Foundation writer");
      assert.equal(reviewCalls, expectedReviews, "Already-sealed review must not require another reviewer");
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
}, () => {
  assert.ok(available);
  const f = setup("live-idea-parent");
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
  const args = [...f.start];
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
}, () => {
  assert.ok(available);
  const f = setup("live");
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
  const prepared = spawnSync(process.execPath, [...studioEntry,
    "--story", f.story, "--job", "single", "--task", "A scoped mystery", "--contract", f.contract, "--fixture"],
  { encoding: "utf8", env: f.env, timeout: 30_000 });
  assert.equal(prepared.status, 0, prepared.stderr);
  const input = JSON.parse(prepared.stdout);
  assert.equal(input.request.story, f.story);
  assert.equal(input.request.fixture, true);
  assert.equal(input.request.contract.scope.targets[1], "milestone.disclosure");
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
