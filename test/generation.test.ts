import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { removeTestTree } from "./helpers.js";
import { authorApproval } from "./approval-controller.js";
import { saveFixtureTurn } from "./puzzle-obligation-fixtures.js";
import { fixtureSandboxClient, scriptedModel, scriptedReadCalls,
  scriptedStoryRuntime, scriptedText } from "./c03-scripted-story-helpers.js";
import { boundedPinnedSources } from "../src/bounded-specialist-prompt.js";
import { runEventWorkItem } from "../src/event-work.js";
import { runCharacterWorldJob } from "../src/character-world.js";
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
import { createGenerationGraph, dispatchGenerationAssignment, recoveryNode } from "../src/generation.js";
import { admitAdaptiveAssignments, applyAdaptiveAssignments } from "../src/adaptive-assignments.js";
import { milestoneFulfillmentProjection } from "../src/milestone-field-scope.js";
import { reconcileInventory, nextExecutionItem, withCausalEventPriority } from "../src/generation-plan.js";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { projectRecovery } from "../src/generation-recovery-graph.js";
import { inspectModernGenerationRecovery } from "../src/generation-recovery-inspection.js";
import { inspectDeferredCorrection } from "../src/generation-recovery-resolution.js";
import { recoveryAdmission } from "../src/generation-recovery-lifecycle.js";

const root = mkdtempSync(join(tmpdir(), "nt-generation-"));
after(() => {
  if ((process.env.NT_LIVE_GENERATION === "1" ||
    process.env.NT_LIVE_GENERATION_IDEA === "1") && process.env.NT_KEEP_FAILED_LIVE === "1")
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
    const step = recoveryNode("schedule", async () => {
      throw Error("Later placement must not rerun the original failed specialist");
    });
    const resolved = await step(saved.values as never, cfg as never);
    assert.equal(resolved.status, "running");
    assert.equal(resolved.recoveryLifecycle?.pending.length, 0);
    assert.equal(resolved.recoveryLifecycle?.discharged.length, 1);
    assert.equal(resolved.recoveryLifecycle?.discharged[0]?.case.id, originalCase);
    assert.equal(resolved.recoveryLifecycle?.discharged[0]?.correctedHeadSha, correctedHead);
    await graph.updateState(cfg, resolved, "schedule");
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
      const job = await startStoryJob({ story: f.story, job: "single" }, false);
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
    const pendingPath = join(f.job.stateDir, "repair-ledgers", pending.records[0].turnDigest + ".json");
    const historical = JSON.parse(readFileSync(pendingPath, "utf8"));
    delete historical.blueprintRepairs[0].incident;
    writeFileSync(pendingPath, JSON.stringify(historical));
    assert.equal(f.cli(["approval-revisions", "inspect"]).total, 0,
      "pre-#233 admitted repairs remain readable after upgrading");
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
  if (defect === "knowledge") {
    const old = { ...ledger, blueprintRepairs: ledger.blueprintRepairs!.map(value =>
      ({ ...value, incident: undefined })) };
    writeFileSync(join(f.job.stateDir, "repair-ledgers", incident.turnDigest + ".json"), JSON.stringify(old));
    assert.equal(f.cli(["approval-revisions", "inspect"]).total, 0);
    await recordBlueprintRepair(f.job, incident.turnDigest, repair);
    assert.equal(f.cli(["approval-revisions", "inspect"]).records[0].id, incident.id,
      "historical completed repairs can be enriched without changing the correction authority");
  }
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
  name: string, refused: boolean | "exception" | "diagnostic" | "exception-diagnostic",
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
      if (refused === "exception" || refused === "exception-diagnostic") {
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
    const transport = refused === "diagnostic" || refused === "exception-diagnostic"
      ? await (await import("./scripted-recovery-model.js")).scriptedRecoveryModel() : null;
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
        refused === "exception" || refused === "exception-diagnostic" ? "exception" : "returned-failure");
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
      assert.deepEqual(log, [refused === "exception" || refused === "exception-diagnostic"
        ? "review-transport-failed" : "refuse-other-owner-write"]);
    }
    let next = transport ? await (await import("../src/model-runtime.js")).withJobModelRuntime(transport.rt,
      () => createGenerationGraph(saver, "cli").invoke(null, config)) : await graph.invoke(null, config);
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
    if (transport && controlAfterSelection !== "cancelled") {
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
        arguments: { path: "events/disclose-ledger.md", content: authored } }],
        reason: "toolUse" };
      if (index === 6) return {
        content: scriptedText({ modifiedRecords: ["events/disclose-ledger.md"],
          architecturalConflicts: [], laterObligations: [
            "Formal Choice Point binding must enact the protect and challenge outcomes for this Milestone before fulfillment.",
          ] }), reason: "stop",
      };
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
    assert.equal(observed.length, 7, "Original bounded Blueprint and Event Pi conversations actually settled");
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
      assert.ok(observed.length >= beforeSelectionCalls + 7 &&
        (observed.length - beforeSelectionCalls - 5) % 2 === 0,
        "One bounded writer, its independent reviewer and fresh read-only affected-dependent reviews must settle");
      const afterCorrectionCalls = observed.length;
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
    assert.equal(completed.recoveryLifecycle.decision?.action, "diagnostic-stop");
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

test("#225 dirty in-flight specialist cannot be redispatched on resume", {
  skip: !available,
}, async () => {
  const f = setup("recovery-dirty-active-specialist");
  const paused = f.cli([...f.start, "--pause-after", "foundation"]);
  assert.equal(paused.status, "paused");
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
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
    // Resume at the actual specialist-dispatch boundary. Scheduling has
    // already authenticated the selected work item; a dirty writer must
    // fail inside its own original operation, never be redispatched.
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
  assert.equal(currentOperationRecovery(result)?.operation, "specialist-dispatch");
  assert.equal(currentOperationRecovery(result)?.phase, "fenced");
  assert.equal(readFileSync(draft, "utf8"), "Preserve this ambiguous writer effect.");
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
  unlinkSync(draft);
  assert.deepEqual(f.cli(["generate", "inspect"]).operationRecovery, currentOperationRecovery(result));
  assert.deepEqual(f.cli(["generate", "resume"]).operationRecovery, currentOperationRecovery(result));
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
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

test("crash after World commit before finalization never replays writer or grants an incomplete point", { skip: !available }, () => {
  const f = setup("threads-crash");
  f.env.NT_RECOVERY_FIXTURE_CRASH_AFTER_INTENT = "world-foundations";
  const crashed = f.cli([...f.start, "--pause-after", "foundations"]);
  assert.equal(crashed.status, "blocked", JSON.stringify(crashed));
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  assert.match(git(f.job.worktreeRoot, "log", "-1", "--format=%B"), /NovelTea-Work-Item: world-foundations/);
  assert.ok(crashed.recoveryCheckpoints.some((p: any) => p.commitSha === head && !p.eligible));
  delete f.env.NT_RECOVERY_FIXTURE_CRASH_AFTER_INTENT;
  const reconciled = f.cli(["generate", "resume", "--pause-after", "foundations"]);
  assert.ok(reconciled.recoveryCheckpoints.some((p: any) =>
    p.commitSha === head && p.workItem === "world-foundations" && p.eligible));
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
      assert.match(stopped.reason ?? "", /no independently passing corrective successor/i,
        "A forged adapter-success return cannot discharge an uncorrected original Review");
      assert.equal(correctionCalls, 1, "Only the selected original Review adapter is entered");
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
    const produced = await withJobModelRuntime(runtime, () => runCharacterWorldJob({
      story: f.story, job: "single", action: "run", fixture: false,
      task: f.start[3]!, turnPlanDigest: turnDigest,
      skillsSource: source, provider: scriptedModel.provider, model: scriptedModel.id }));
    assert.equal(produced.status, "foundations-conflict-reported");
    assert.equal(observed.length, 2);
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
      const admitted = await graph.invoke(null, { ...cfg, interruptBefore: ["assess_recovery"] });
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
  const oldCommit = first.inventory.items.find((i: any) => i.id === "composition:milestone.disclosure").verifiedSha;
  contract.scope.targets = ["arc.truth"];
  writeFileSync(f.contract, JSON.stringify(contract));
  const carry = join(root, "carry.json");
  writeFileSync(carry, JSON.stringify(["foundations", "event:milestone.disclosure", "interactive:milestone.disclosure", "composition:milestone.disclosure"]));
  const proposal = f.cli(["architecture", "propose", "--contract", f.contract, "--carry-forward", carry]);
  const payload = { ...proposal.authorSigningRequest, reason: "Test author approves the second Milestone and retains the reviewed first cluster." };
  const evidence = authorApproval(f.story, "single", f.env, root, payload).file;
  f.cli(["architecture", "approve", "--proposal", proposal.proposal.digest, "--approval", evidence]);
  const result = f.cli(["generate", "resume"]);
  assert.equal(result.reason, "editorial-unverified", JSON.stringify(result));
  assert.equal(result.inventory.planVersion, 2);
  assert.equal(result.inventory.items.find((i: any) => i.id === "composition:milestone.disclosure").verifiedSha, oldCommit);
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
