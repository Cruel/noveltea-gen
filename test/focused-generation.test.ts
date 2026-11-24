import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
    // An interrupted creation retains its uncommitted file and cannot silently
    // replay, discard or adopt a changed canonical context on reconnect.
    f.cli("interrupted", ["start"]);
    const crashed = await startStoryJob({ story: f.story, job: "interrupted" }, false);
    const interruptedTask = "Write a conversation between Ada and Neri about rebuilding trust after the storm";
    const interrupted = inferStoryObjective(interruptedTask, catalog, canonical, prior);
    const interruptedPlan = planObjective({ kind: "revision", request: interruptedTask,
      contract: interrupted.contract, base: canonical, sourceJobId: "seed", catalog,
      targetIds: interrupted.targets, allowedPaths: interrupted.writePaths });
    await saveJobTurnPlan(crashed, interruptedPlan);
    await runArchitectureJob({ story: f.story, job: "interrupted", action: "run",
      fixture: true, contract: interrupted.contract, skillsSource: source });
    const interruptedFirst = interrupted.contract.scope.creates![0]!;
    const previousCase = process.env.NT_FOCUS_FIXTURE_CASE;
    process.env.NT_FOCUS_FIXTURE_CASE = "unauthorized-edit";
    try {
      await assert.rejects(runFocusedWorkItem({ story: f.story, job: "interrupted",
        target: interruptedFirst.id, task: interruptedTask, contract: interrupted.contract,
        fixture: true, turnPlanDigest: interruptedPlan.digest, skillsSource: source }),
      /outside its explicit authority/);
    } finally {
      if (previousCase === undefined) delete process.env.NT_FOCUS_FIXTURE_CASE;
      else process.env.NT_FOCUS_FIXTURE_CASE = previousCase;
    }
    assert.equal(existsSync(join(crashed.worktreeStoryRoot, interruptedFirst.path)), true,
      "partial output remains inspectable after a rejected creation");
    assert.equal(git(crashed.worktreeRoot, "rev-parse", "HEAD"), canonical);
    await assert.rejects(runFocusedWorkItem({ story: f.story, job: "interrupted",
      target: interruptedFirst.id, task: interruptedTask, contract: interrupted.contract,
      fixture: true, turnPlanDigest: interruptedPlan.digest, skillsSource: source }),
    /changes requiring explicit reconciliation/);
  } finally {
    if (oldState === undefined) delete process.env.NT_STATE_DIR;
    else process.env.NT_STATE_DIR = oldState;
    if (oldCache === undefined) delete process.env.NT_SKILL_CACHE_DIR;
    else process.env.NT_SKILL_CACHE_DIR = oldCache;
  }
});

test("native-verified focused Turn restores a source-bound pending omission after restart", {
  skip: !available, timeout: 300_000,
}, async () => {
  const f = fixture("pending-native-restart");
  f.cli("seed", ["start"]);
  f.contract(["arc.truth", "milestone.disclosure"], "composition", ["protect", "challenge"]);
  const seeded = f.cli("seed", ["generate", "start", "--task", "Seed witness mystery",
    "--contract", f.contractPath, "--fixture", "--skills-source", source]);
  git(f.repo, "merge", "--ff-only", seeded.report.identity.branch);
  const characterPath = join(f.story, "characters/ada.md");
  const character = readFileSync(characterPath, "utf8");
  assert.match(character, /^status: draft$/m);
  writeFileSync(characterPath, character.replace(/^status: draft$/m, "status: approved"));
  git(f.repo, "add", "story/characters/ada.md");
  git(f.repo, "commit", "-m", "Verify Ada's existing canonical characterization");
  const base = git(f.repo, "rev-parse", "HEAD");
  f.cli("pending", ["start"]);
  const oldState = process.env.NT_STATE_DIR, oldCache = process.env.NT_SKILL_CACHE_DIR;
  process.env.NT_STATE_DIR = f.env.NT_STATE_DIR;
  process.env.NT_SKILL_CACHE_DIR = f.env.NT_SKILL_CACHE_DIR;
  try {
    const job = await startStoryJob({ story: f.story, job: "pending" }, false);
    const validation = await validateStoryJob(job, source, { ...job, baseSha: base });
    assert.equal(validation.status, "passed", JSON.stringify({
      diagnostics: (validation.report as { diagnostics?: unknown[] })?.diagnostics?.slice(0, 10),
      protection: (validation.report as { protection?: unknown })?.protection,
    }));
    const catalog = (validation.report as { records: CanonicalScopeRecord[] }).records;
    const record = catalog.find(item => item.metadata.id === "character.ada")!;
    assert.ok(record);
    assert.equal(record.metadata.status, "approved");
    const contract: CompletionContract = {
      scope: { kind: "partial", depth: "architecture", targets: ["character.ada"], branches: [] },
      constraints: [], envelope: { presentation: "Visual novel", hardLimits: [], preferences: [] },
    };
    const task = "Ensure Ada's existing motives are coherent";
    const turn = planObjective({ kind: "revision", request: task, contract, base,
      sourceJobId: "seed", catalog, targetIds: ["character.ada"],
      allowedPaths: [record.path] });
    await saveJobTurnPlan(job, turn);
    const architecture = await runArchitectureJob({ story: f.story, job: "pending",
      action: "run", fixture: true, contract, skillsSource: source });
    assert.equal(architecture.status, "complete-in-scope");
    const head = git(job.worktreeRoot, "rev-parse", "HEAD");
    const native = await validateStoryJob(job, source, { ...job, baseSha: head });
    assert.equal(native.status, "passed");
    const initial = reconcileInventory(architecture.plan, native, head, [
      { stage: "foundation", headSha: head, status: "committed" },
      { stage: "architecture", headSha: head, status: "complete-in-scope", planVersion: 1 },
    ], {});
    const id = "focus:character.ada";
    assert.equal(initial.items.find(item => item.id === id)?.status, "pending");
    const hash = sourceDigest(readFileSync(join(job.worktreeStoryRoot, record.path), "utf8"));
    const contextRecords = omissionContext(
      (native.report as { records: CanonicalScopeRecord[] }).records, record.path);
    assert.ok(contextRecords, "approved canon has no protected adjacent record");
    const context = contextRecords.map(item => ({ path: item.path,
      sha256: sourceDigest(readFileSync(join(job.worktreeStoryRoot, item.path), "utf8")) }));
    const hashes = Object.fromEntries([[record.path, hash],
      ...context.map(item => [item.path, item.sha256])]);
    // A fixture-injected proof exercises native source/restart verification,
    // NOT literary certification. Production creates its own proof only after
    // the separate read-only pinned Pi omission review has passed.
    const fixtureProof = { assignmentId: id, sourceSha: head, path: record.path,
      sourceHash: hash, context, evidence: record.path + ":1 fixture witness",
      reviewerSession: "/fixture/omission.jsonl", reviewerSnapshot: "f".repeat(64),
      verdict: "pass" as const };
    const amendment = authorizePendingAmendment({
      proposal: { sourceSha: head, turnDigest: turn.digest, beforeVersion: 1,
        order: ["review"], prune: [id], prerequisites: [],
        reason: "Fixture tests source-bound restoration of an external verdict." },
      inventory: initial, turnDigest: turn.digest, version: 1,
      omissionProofs: [fixtureProof], sourceHashes: hashes,
      authorizedPaths: { [id]: [record.path] },
      protectedPaths: catalog.filter(r => Array.isArray(r.metadata.decisions) &&
        r.metadata.decisions.length > 0).map(r => r.path),
      canonicalEdges: [], reviewed: [
        { id: "foundation", sha: head }, { id: "architecture", sha: head },
      ],
    });
    const state = emptyPendingState(job, turn.digest);
    state.entries.push(amendment); state.version++;
    await savePendingState(job, state);
    await verifyPinnedPendingWork(job, turn.digest, 2);
    const request = { story: job.storyRoot, job: job.jobId, task, contract,
      fixture: true, turnPlanDigest: turn.digest, skillsSource: source };
    const reloaded = await reconcilePendingWork(job, request, initial, null, native, false);
    assert.equal(reloaded.stateVersion, 2);
    assert.equal(reloaded.inventory.items.find(item => item.id === id)?.status, "verified");
    assert.equal(reloaded.inventory.items.find(item => item.id === id)?.omission?.evidence,
      fixtureProof.evidence);
    assert.equal(nextExecutionItem(reloaded.inventory, reloaded.order ?? undefined)?.id, "review");
    assert.deepEqual(git(job.worktreeRoot, "log", "--oneline", base + "..HEAD"), "");
    const second = await reconcilePendingWork(job, request, initial, null, native, false);
    assert.deepEqual(second.inventory, reloaded.inventory);
    // Exercise the real production graph and persisted SQLite checkpoint,
    // not only the pure amendment applier: it must skip the omitted writer.
    const saver = SqliteSaver.fromConnString(join(job.stateDir, "generation.sqlite"));
    try {
      const graph = createGenerationGraph(saver, "cli");
      const graphRequest = { ...request, orchestrationPolicy: "fixture-test" as const };
      const result = await graph.invoke({ request: graphRequest, pauseAfter: "review" },
        { configurable: { thread_id: job.threadId + ":generation" }, recursionLimit: 100 });
      assert.equal(result.status, "paused", result.reason ?? JSON.stringify(result));
      assert.equal(result.inventory.items.find(item => item.id === id)?.status, "verified");
      assert.equal(result.inventory.items.find(item => item.id === id)?.omission?.reviewerSession,
        fixtureProof.reviewerSession);
      assert.equal(result.completedStages.some(stage => stage.stage === "focus"), false);
      assert.equal(result.completedStages.some(stage => stage.stage === "review"), true);
    } finally { saver.db.close(); }
    const resumed = f.cli("pending", ["generate", "resume"]);
    assert.equal(resumed.status, "blocked");
    assert.equal(resumed.inventory.items.find((item: { id: string; omission?: unknown }) =>
      item.id === id)?.omission !== undefined, true);
    const ledger = join(job.stateDir, "pending-work.json");
    renameSync(ledger, ledger + ".missing");
    try {
      const missing = f.cli("pending", ["generate", "resume"]);
      assert.equal(missing.status, "blocked");
      assert.match(missing.reason, /pending-plan amendment history is missing/);
      assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), base);
    } finally { renameSync(ledger + ".missing", ledger); }
    const restored = f.cli("pending", ["generate", "resume"]);
    assert.equal(restored.status, "blocked");
    assert.equal(restored.pendingPlan?.version, 2);
    assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "");
    assert.equal(git(f.repo, "rev-parse", "HEAD"), base);
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

test("R07 focused commit before checkpoint finalization resumes without replay", {
  skip: !available, timeout: 120_000,
}, () => {
  const f = fixture("r07-focus-crash");
  f.cli("seed", ["start"]);
  f.contract(["arc.truth", "milestone.disclosure"], "composition", ["protect", "challenge"]);
  const seed = f.cli("seed", ["generate", "start", "--task", "Seed a mystery",
    "--contract", f.contractPath, "--fixture", "--skills-source", source]);
  git(f.repo, "merge", "--ff-only", seed.report.identity.branch);
  const job = f.cli("focused", ["start"]);
  f.contract(["character.ada"], "architecture");
  const env = f.env as NodeJS.ProcessEnv;
  env.NT_RECOVERY_FIXTURE_CRASH_AFTER_INTENT = "focus:character.ada";
  const crashed = f.cli("focused", ["generate", "start", "--task", "Clarify Ada's motivation",
    "--contract", f.contractPath, "--fixture", "--skills-source", source, "--pause-after", "focus"]);
  assert.equal(crashed.status, "blocked", crashed.reason);
  const head = git(job.worktreeRoot, "rev-parse", "HEAD");
  delete env.NT_RECOVERY_FIXTURE_CRASH_AFTER_INTENT;
  const resumed = f.cli("focused", ["generate", "resume"]);
  // A resumed fixture may advance to the final editorial gate; the
  // recovered focused assignment itself must be independently verified.
  assert.ok(resumed.status === "paused" || resumed.reason === "editorial-unverified", resumed.reason);
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

test("discovered prerequisite amends a focused plan and survives process restart without duplicate writers", {
  skip: !available, timeout: 300_000,
}, async () => {
  const f = fixture("dependency-amendment");
  f.cli("seed", ["start"]);
  f.contract(["arc.truth", "milestone.disclosure"], "composition", ["protect", "challenge"]);
  const seed = f.cli("seed", ["generate", "start", "--task", "Seed a mystery",
    "--contract", f.contractPath, "--fixture", "--skills-source", source]);
  git(f.repo, "merge", "--ff-only", seed.report.identity.branch);
  const old = { state: process.env.NT_STATE_DIR, cache: process.env.NT_SKILL_CACHE_DIR,
    report: process.env.NT_FOCUS_FIXTURE_DEPENDENCY };
  process.env.NT_STATE_DIR = f.env.NT_STATE_DIR;
  process.env.NT_SKILL_CACHE_DIR = f.env.NT_SKILL_CACHE_DIR;
  try {
    const job = await startStoryJob({ story: f.story, job: "dependency" });
    const native = await validateStoryJob(job, source, { ...job, baseSha: job.baseSha });
    assert.equal(native.status, "passed");
    const catalog = (native.report as { records: CanonicalScopeRecord[] }).records;
    const target = "authored-content.disclosure-scene";
    const contract: CompletionContract = { scope: { kind: "partial", depth: "composition",
      targets: [target], branches: [] }, constraints: [],
      envelope: { presentation: "Visual novel", hardLimits: [], preferences: [] } };
    const task = "Clarify the witness disclosure conversation";
    const turn = planObjective({ kind: "revision", request: task, contract, base: job.baseSha,
      sourceJobId: "seed", catalog, targetIds: [target], allowedPaths: ["authored-content/disclosure-scene.md"] });
    await saveJobTurnPlan(job, turn);
    const eventPath = "events/disclose-ledger.md";
    const bytes = readFileSync(join(job.worktreeStoryRoot, eventPath), "utf8");
    const report = { sourceSha: job.baseSha, turnDigest: turn.digest, assignmentId: "focus:" + target,
      obligation: turn.objective!.obligations[0], missing: "Clarify the causal prerequisite for the witness disclosure",
      affectedIds: [target, "event.disclose-ledger"],
      sources: [{ path: eventPath, sha256: sourceDigest(bytes), quote: "id: event.disclose-ledger" }],
      likelySpecialist: "nt-event-design", authorDecisionRequired: false };
    process.env.NT_FOCUS_FIXTURE_DEPENDENCY = JSON.stringify(report);
    const saver = SqliteSaver.fromConnString(join(job.stateDir, "generation.sqlite"));
    try {
      const graph = createGenerationGraph(saver, "cli");
      const config = { configurable: { thread_id: job.threadId + ":generation" }, recursionLimit: 100 };
      const suspended = await graph.invoke({ request: { story: f.story, job: "dependency", task,
        contract, fixture: true, skillsSource: source, turnPlanDigest: turn.digest,
        orchestrationPolicy: "fixture-test" }, pauseAfter: "focus" },
        { ...config, interruptBefore: ["dependency_amendment"] });
      assert.equal(suspended.result?.status, "dependency-required");
      assert.equal(suspended.focusedPrerequisite?.suspension.status, "needs-prerequisite");
      assert.equal(suspended.focusedPrerequisite?.suspension.owner, "nt-event-design");
      assert.equal(suspended.focusedPrerequisite?.suspension.pendingPhase, "writer");
      assert.equal(suspended.focusedPrerequisite?.supportRef, null);
      assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), job.baseSha);
      const supported = await createGenerationGraph(saver, "cli").invoke(null,
        { ...config, interruptAfter: ["dependency_amendment"] });
      assert.ok(supported.focusedPrerequisite?.supportRef);
      assert.deepEqual(supported.focusedPrerequisite?.identity, suspended.focusedPrerequisite?.identity);
      assert.deepEqual(supported.focusedPrerequisite?.suspension, suspended.focusedPrerequisite?.suspension);
      assert.equal(git(job.worktreeRoot, "rev-list", "--count", job.baseSha + "..HEAD"), "1");
      const result = await createGenerationGraph(saver, "cli").invoke(null, config);
      assert.equal(result.status, "paused", result.reason ?? JSON.stringify(result));
      assert.equal(result.focusedPrerequisite, null);
    } finally { saver.db.close(); }
    const amended = await inspectDependencyPlan(job);
    assert.equal(amended?.version, 2);
    assert.equal(amended?.entries[0]?.phase, "verified");
    assert.equal(amended?.entries[0]?.amendment?.assignment.specialist, "nt-event-design");
    assert.deepEqual(amended?.entries[0]?.amendment?.objective, turn.objective);
    assert.equal(git(job.worktreeRoot, "rev-list", "--count", job.baseSha + "..HEAD"), "2");
    assert.deepEqual(git(job.worktreeRoot, "diff", "--name-only", job.baseSha, "HEAD").split("\n"),
      ["story/authored-content/disclosure-scene.md", "story/events/disclose-ledger.md"]);
    const head = git(job.worktreeRoot, "rev-parse", "HEAD");
    const resumed = f.cli("dependency", ["generate", "resume"]);
    assert.equal(resumed.status, "blocked");
    assert.match(resumed.reason, /editorial-unverified|review/);
    assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), head);
    assert.deepEqual(await inspectDependencyPlan(job), amended);
    const ledgerPath = join(job.stateDir, "dependency-plan.json");
    renameSync(ledgerPath, ledgerPath + ".missing");
    try {
      const missingHistory = f.cli("dependency", ["generate", "resume"]);
      assert.equal(missingHistory.status, "blocked");
      assert.match(missingHistory.reason, /dependency authorization history is missing/);
      assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), head);
    } finally { renameSync(ledgerPath + ".missing", ledgerPath); }
    const final = await validateStoryJob(job, source, { ...job, baseSha: job.baseSha });
    assert.equal(final.status, "passed");
    await assert.rejects(inspectDependencyPlan({ ...job, threadId: "another-thread" }), /identity/);
    await assert.rejects(inspectDependencyPlan({ ...job, jobId: "another-job" }), /identity/);

    // A crash after the planner started must not turn into another model call
    // or writer on restart, even though the original specialist left no edits.
    const interrupted = await startStoryJob({ story: f.story, job: "dependency-interrupted" });
    await saveJobTurnPlan(interrupted, turn);
    await runArchitectureJob({ story: f.story, job: interrupted.jobId, action: "run",
      fixture: true, contract, skillsSource: source });
    const options = { story: f.story, job: interrupted.jobId, target, task, contract,
      fixture: true, turnPlanDigest: turn.digest, skillsSource: source };
    assert.equal((await runFocusedWorkItem(options)).status, "dependency-required");
    await withStoryJobLock(interrupted, "test-crash-boundary", async () => {
      const saved = await recordDependency(interrupted, report, true);
      saved.entry.phase = "planning";
      await saveDependencyPlan(interrupted, saved.plan);
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(advanceFocusedDependency(options), /Interrupted.*no replay/);
      assert.equal(git(interrupted.worktreeRoot, "rev-parse", "HEAD"), interrupted.baseSha);
      assert.equal(git(interrupted.worktreeRoot, "status", "--porcelain"), "");
    }
    assert.equal((await inspectDependencyPlan(interrupted))?.entries[0]?.phase, "planning");

    const rejected = await startStoryJob({ story: f.story, job: "dependency-rejected" });
    await saveJobTurnPlan(rejected, turn);
    await runArchitectureJob({ story: f.story, job: rejected.jobId, action: "run",
      fixture: true, contract, skillsSource: source });
    const stale = { ...report, sources: [{ ...report.sources[0]!, sha256: "f".repeat(64) }] };
    process.env.NT_FOCUS_FIXTURE_DEPENDENCY = JSON.stringify(stale);
    const rejectedOptions = { ...options, job: rejected.jobId };
    assert.equal((await runFocusedWorkItem(rejectedOptions)).status, "dependency-required");
    await assert.rejects(advanceFocusedDependency(rejectedOptions), /stale evidence/);
    assert.equal((await inspectDependencyPlan(rejected))?.entries[0]?.phase, "rejected");
    assert.equal((await inspectDependencyPlan(rejected))?.version, 1);
    await assert.rejects(advanceFocusedDependency(rejectedOptions), /rejected.*no replay/);
    assert.equal(git(rejected.worktreeRoot, "rev-parse", "HEAD"), rejected.baseSha);

    // Tampering with the original typed owner must not grant a supporting
    // writer, even if the altered report still parses as a valid report.
    const owner = await startStoryJob({ story: f.story, job: "dependency-owner" });
    await saveJobTurnPlan(owner, turn);
    await runArchitectureJob({ story: f.story, job: owner.jobId, action: "run",
      fixture: true, contract, skillsSource: source });
    process.env.NT_FOCUS_FIXTURE_DEPENDENCY = JSON.stringify(report);
    const ownerOptions = { ...options, job: owner.jobId };
    assert.equal((await runFocusedWorkItem(ownerOptions)).status, "dependency-required");
    const originalReceipt = join(owner.stateDir, "focused-items", target + ".json");
    const stored = JSON.parse(readFileSync(originalReceipt, "utf8"));
    stored.dependencyReport.likelySpecialist = "nt-character-development";
    writeFileSync(originalReceipt, JSON.stringify(stored));
    await assert.rejects(advanceFocusedDependency(ownerOptions), /lost its original assignment, plan or settled report/);
    assert.equal(await inspectDependencyPlan(owner), null);
    assert.equal(git(owner.worktreeRoot, "rev-parse", "HEAD"), owner.baseSha);
  } finally {
    for (const [key, value] of [["NT_STATE_DIR", old.state], ["NT_SKILL_CACHE_DIR", old.cache],
      ["NT_FOCUS_FIXTURE_DEPENDENCY", old.report]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
  }
});

for (const scenario of ["review", "writer", "support-no-write"] as const)
test("R04 cross-owner prerequisite " + scenario + " uses the original logical assignment", {
  skip: !available, timeout: 300_000,
}, async () => {
  const f = fixture("r04-prerequisite-" + scenario);
  f.cli("seed", ["start"]);
  f.contract(["arc.truth", "milestone.disclosure"], "composition", ["protect", "challenge"]);
  const seed = f.cli("seed", ["generate", "start", "--task", "Seed a mystery",
    "--contract", f.contractPath, "--fixture", "--skills-source", source]);
  git(f.repo, "merge", "--ff-only", seed.report.identity.branch);
  const oldState = process.env.NT_STATE_DIR, oldCache = process.env.NT_SKILL_CACHE_DIR;
  process.env.NT_STATE_DIR = f.env.NT_STATE_DIR;
  process.env.NT_SKILL_CACHE_DIR = f.env.NT_SKILL_CACHE_DIR;
  try {
    const job = await startStoryJob({ story: f.story, job: "r04-review" });
    const native = await validateStoryJob(job, source, { ...job, baseSha: job.baseSha });
    const catalog = (native.report as { records: CanonicalScopeRecord[] }).records;
    const event = "event.disclose-ledger", character = "character.ada";
    const eventPath = "events/disclose-ledger.md", characterPath = "characters/ada.md";
    const targets = scenario === "writer" ? [event] : [character, event];
    const contract: CompletionContract = { scope: { kind: "partial", depth: "interactive",
      targets, branches: [] }, constraints: [],
      envelope: { presentation: "Visual novel", hardLimits: [], preferences: [] } };
    const task = "Clarify Ada's reason to disclose the ledger in her profile and the Event.";
    const turn = planObjective({ kind: "revision", request: task, contract, base: job.baseSha,
      sourceJobId: "seed", catalog, targetIds: targets,
      allowedPaths: scenario === "writer" ? [eventPath] : [characterPath, eventPath] });
    await saveJobTurnPlan(job, turn);
    const correction = "Explain in Ada's Character profile why she discloses the ledger.";
    const restore = fixtureSandboxClient(job.jobId, job.worktreeStoryRoot);
    let saver = SqliteSaver.fromConnString(join(job.stateDir, "generation.sqlite"));
    let originalNegative = false, repairYield = false, supportWrites = 0, originalReviews = 0;
    let writerYield = false, originalWrites = 0, localCorrections = 0;
    let supportQuestion = false;
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
          if (!phase) return read(["nt-story-orchestrate/SKILL.md", "nt-story-orchestrate/references/planning.md",
            "nt-catalog/SKILL.md", "nt-catalog/references/records.md", "nt-catalog/references/authority-and-validation.md"]
            .map(p => "skill://" + p).concat(characterPath));
          return stop({ target: character, specialist: "nt-character-development", outcome: correction,
            reason: "The sealed Event finding identifies Ada's missing motivation in her owned Character record." });
        }
        if (prompt.includes("IMMUTABLE REVIEW PACKET")) {
          if (!phase) return read(boundedPinnedSources("nt-narrative-review").map(p => "skill://" + p));
          const packet = JSON.parse(prompt.split("\nIMMUTABLE REVIEW PACKET\n")[1]!);
          const item = packet.items[0];
          const path = item.assurance.changedPaths[0];
          const fail = scenario !== "writer" && path === eventPath && !originalNegative;
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
        if (prompt.includes("SOURCE-BOUND STORY CORRECTION") &&
            prompt.includes("focused-manifest-path-mismatch")) {
          localCorrections++;
          return stop({ modifiedRecords: [eventPath], architecturalConflicts: [], laterObligations: [] });
        }
        if (prompt.includes("revision specialist. FIRST")) {
          const path = prompt.includes("Only edit these PREEXISTING canonical Markdown files:\n" + eventPath) ? eventPath : characterPath;
          const support = prompt.includes("THIS IS A SEPARATELY AUTHORIZED SUPPORTING ASSIGNMENT");
          const skill = path === eventPath ? "nt-event-design" : "nt-character-development";
          if (!phase) return read([skill + "/SKILL.md", "nt-catalog/SKILL.md", "nt-catalog/references/records.md",
            ...(path === eventPath ? ["nt-catalog/references/progression.md"] : [])].map(p => "skill://" + p));
          if (phase === 1) {
            if (scenario === "support-no-write" && support) return stop({ modifiedRecords: [], architecturalConflicts: [], laterObligations: [] });
            if (support && !supportQuestion) {
              supportQuestion = true;
              return stop({ modifiedRecords: [], architecturalConflicts: [], laterObligations: [],
                authorDecisionRequest: { kind: "free-text", question: "Which motive should Ada disclose to protect the witness?" } });
            }
            if (scenario === "writer" && !support && !writerYield) {
              writerYield = true;
              return { reason: "toolUse", content: [{ type: "toolCall", id: "r04-prerequisite", name: "report_dependency",
                arguments: { obligationIndex: 0, missing: correction, affectedIds: [event, character],
                  sources: [{ path: characterPath, quote: "id: character.ada" }],
                  likelySpecialist: "nt-character-development", authorDecisionRequired: false } }] };
            }
            if (support) supportWrites++; else if (path === eventPath) originalWrites++;
            const old = readFileSync(join(job.worktreeStoryRoot, path), "utf8");
            return { reason: "toolUse", content: [{ type: "toolCall", id: "r04-edit-" + index, name: "edit",
              arguments: { path, edits: [{ oldText: old, newText: old + "\n" +
                (support ? "Ada discloses the ledger to protect the witness from a false accusation." :
                  "Ada hesitates before giving the witness her account of the ledger.") + "\n" }] } }] };
          }
          return stop({ modifiedRecords: scenario === "writer" && writerYield && !support ? [] : [path], architecturalConflicts: [], laterObligations: [] });
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
        await assert.rejects(withJobModelRuntime(runtime, () => createGenerationGraph(saver, "cli").invoke(input, {
          ...config, ...options, signal: abort.signal, durability: "sync",
        })), err => { if (!crashed) throw err; return true; });
        assert.ok(crashed, "Expected actual SQLite output loss: " + boundary);
        assert.equal(existsSync(join(job.stateDir, ".story-job")), false);
        saver.db.close();
        saver = SqliteSaver.fromConnString(join(job.stateDir, "generation.sqlite"));
      }
      if (scenario === "writer") {
        await crashAt(initialRequest, "returned no-write child outcome", (ns, writes) =>
          !ns && writes.some(([channel, value]) => channel === "focusedPrerequisite" &&
            !!value && (value as { supportRef?: string }).supportRef === null),
        { interruptBefore: ["dependency_amendment"] });
      }
      const suspended = await invoke(scenario === "writer" ? null : initialRequest,
        { ...config, interruptBefore: ["dependency_amendment"] });
      const pin = scenario === "writer" ? suspended.focusedPrerequisite : suspended.reviewPrerequisite;
      assert.ok(pin, JSON.stringify({ reason: suspended.reason, status: suspended.status }));
      assert.equal(pin.suspension.pendingPhase, scenario === "writer" ? "writer" : "review");
      assert.equal(pin.suspension.owner, "nt-character-development");
      assert.equal(originalNegative, scenario !== "writer");
      assert.equal(repairYield, scenario !== "writer");
      const originalHead = git(job.worktreeRoot, "rev-parse", "HEAD");
      const receiptPath = join(job.stateDir, "focused-items", event + ".json");
      const originalReceipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      let supportInput: Parameters<ReturnType<typeof createGenerationGraph>["invoke"]>[0] = null;
      if (scenario !== "support-no-write") {
        const { pendingGenerationQuestion, generationQuestionResume } = await import("../src/generation-author-question.js");
        const { answerSpecialistChoice, focusedChoiceWorkItem } = await import("../src/specialist-choice.js");
        await invoke(null, { ...config, interruptAfter: ["dependency_amendment"] });
        const graph = createGenerationGraph(saver, "cli");
        const snapshot = await graph.getState(config);
        const pending = await pendingGenerationQuestion(job, saver, snapshot, config.configurable.thread_id, "user:cli");
        assert.ok(pending, JSON.stringify({ reason: snapshot.values.reason, supportQuestion }));
        const entry = (await inspectDependencyPlan(job))!.entries[0]!;
        assert.equal(pending.choice.assignment?.identity.assignmentId, entry.amendment!.assignment.id);
        assert.equal(pending.choice.workItem, focusedChoiceWorkItem(character, entry.amendment!.assignment.id));
        assert.notEqual(pending.choice.workItem, focusedChoiceWorkItem(character));
        assert.equal(supportWrites, 0);
        assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), originalHead);
        await assert.rejects(pendingGenerationQuestion(job, saver, {
          ...snapshot, values: { ...snapshot.values, planVersion: 999 },
        }, config.configurable.thread_id, "user:cli"), /original assignment|dependency admission/);
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
      if (scenario === "writer") {
        await crashAt(supportInput, "support commit before original child reentry", (ns, writes) =>
          ns.includes("assignment-") && writes.some(([channel, value]) => channel === "submission" &&
            (value as { status?: string; receiptRef?: string } | undefined)?.status === "focused-committed" &&
            (value as { receiptRef?: string }).receiptRef?.startsWith("dependency:") === true),
        { interruptAfter: ["dependency_amendment"] });
        assert.equal(supportWrites, 1);
        assert.equal(originalWrites, 0);
        assert.equal(git(job.worktreeRoot, "rev-list", "--count", originalHead + "..HEAD"), "1");
      }
      const supported = await invoke(scenario === "writer" ? null : supportInput, { ...config, interruptAfter: ["dependency_amendment"] });
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
      const supportPin = scenario === "writer" ? supported.focusedPrerequisite : supported.reviewPrerequisite;
      assert.ok(supportPin?.supportRef, JSON.stringify({ reason: supported.reason, status: supported.status }));
      assert.deepEqual(supportPin.identity, pin.identity);
      assert.equal(supportWrites, 1);
      assert.equal(originalReviews, 0);
      if (scenario === "writer") {
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
        assert.equal(git(job.worktreeRoot, "rev-list", "--count", job.baseSha + "..HEAD"), "2");
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
  const job = f.cli("focus", ["start"]);
  f.contract(["event.unknown"], "interactive");
  const result = f.cli("focus", ["generate", "start", "--task", "Revise one Event",
    "--contract", f.contractPath, "--fixture", "--skills-source", source]);
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /missing verified upstream|upstream Creative Direction/i);
  assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), git(f.repo, "rev-parse", "HEAD"));
  assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "");
});
