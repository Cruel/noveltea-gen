import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireGenerationTurn, createGenerationGraph } from "../src/generation.js";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { selectOperationStrategy } from "../src/generation-operation-strategy.js";
import type { GenerationGraphState } from "../src/generation.js";
import type { RecoveryCase } from "../src/generation-recovery-contract.js";
import { planWholeStory } from "../web/src/lib/turn-plan.js";
import { readTurnEvidence } from "../src/turn-plan-evidence.js";
import { verifyTurnPlan } from "../web/src/lib/turn-plan.js";
import { prepareTurnFulfillment } from "../src/turn-fulfillment.js";
import { createHash } from "node:crypto";
import { saveJobTurnPlan } from "../web/src/lib/turn-plan-receipt.server.js";
import { verifiedResumeAdmission } from "../web/src/lib/generation-controls.server.js";
import { preflightCompositionBoundary } from "../src/cross-domain-prerequisite-controller.js";
import type { JobStartResult } from "../src/job.js";
import type { CompositionBoundaryRequest } from "../src/cross-domain-prerequisite-controller.js";

test("R14 Composition prerequisite cannot promote a missing Turn pin to ready", async () => {
  // The proof must be checked before accessing any Git, validator or Pi effect.
  const job = new Proxy({} as JobStartResult, {
    get() { throw Error("Unadmitted prerequisite touched the job"); },
  });
  const request: CompositionBoundaryRequest = {
    task: "Continue the original Story",
    contract: {
      scope: { kind: "full-story", depth: "composition", targets: [], branches: [] },
      constraints: [],
      envelope: { presentation: "Interactive Story", hardLimits: [], preferences: [] },
    },
  };
  for (const fixture of [false, true]) {
    const result = await preflightCompositionBoundary(job, { ...request, fixture },
      "milestone.original", 1);
    assert.equal(result.kind, "refuse");
  }
});

test("obsolete direct live stage commands refuse before opening a Story job", () => {
  for (const args of [
    ["foundation", "--mode", "collaborative"],
    ["foundation", "--mode", "autonomous"],
    ["architecture", "run"],
    ["foundations", "run"], ["event", "run"], ["interactive", "run"],
    ["composition", "run"], ["review", "run"], ["repair", "run"],
    ["ideas", "place"], ["ideas", "reassess", "--record"], ["ideas", "relocate"],
  ]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts",
      "job", ...args, "--story", "/nonexistent-story", "--job", "obsolete"], {
      encoding: "utf8", timeout: 30_000,
    });
    assert.notEqual(result.status, 0, args.join(" "));
    assert.match(result.stderr, /retired.*Generation/i, args.join(" "));
  }
});

test("obsolete production server resume refuses before opening the writer lock", async () => {
  const job = { storyRoot: "/nonexistent-story", jobId: "obsolete",
    stateDir: "/nonexistent-state" } as JobStartResult;
  const request = { story: job.storyRoot, job: job.jobId, task: "Continue",
    fixture: false };
  await assert.rejects(verifiedResumeAdmission(job, "old-thread", JSON.stringify(request), false),
    /authenticated current-format Turn plan/);
});

test("current Turn admission authenticates exact request and source, not a claimed digest", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nt-r14k-turn-"));
  try {
    const job = { storyRoot: "/isolated/story", stateDir, jobId: "current",
      baseSha: "a".repeat(40) } as JobStartResult;
    const contract = {
      scope: { kind: "full-story" as const, depth: "composition" as const, targets: [], branches: [] },
      constraints: [],
      envelope: { presentation: "Interactive Story", hardLimits: [], preferences: [] },
    };
    const task = "Continue the original Story";
    const plan = planWholeStory(task, contract, job.baseSha);
    await saveJobTurnPlan(job, plan);
    const request = { story: job.storyRoot, job: job.jobId, task, contract,
      fixture: false, turnPlanDigest: plan.digest };
    assert.deepEqual(await requireGenerationTurn(job, request), plan);
    await assert.rejects(requireGenerationTurn(job, { ...request, turnPlanDigest: "b".repeat(64) }),
      /corrupt\/stale/);
    await assert.rejects(requireGenerationTurn(job, { ...request, job: "other" }),
      /another Story Job/);
    await assert.rejects(requireGenerationTurn(job, { ...request, task: "Different objective" }),
      /corrupt\/stale/);
    assert.deepEqual(readdirSync(stateDir), ["turn-plan.json"], "admission must not acquire a writer or create receipts");
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});


test("obsolete CLI Generation start does not claim SQLite ownership or mutate Git", () => {
  const root = mkdtempSync(join(tmpdir(), "nt-r14k-cli-"));
  try {
    const story = join(root, "story");
    mkdirSync(story);
    writeFileSync(join(story, ".gitkeep"), "");
    function git(...args: string[]) {
      const r = spawnSync("git", ["-C", story, ...args], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    }
    git("init", "-q");
    git("config", "user.name", "Author");
    git("config", "user.email", "author@example.test");
    git("add", ".");
    git("commit", "-qm", "Initial Story");
    const contract = join(root, "contract.json");
    writeFileSync(contract, JSON.stringify({
      scope: { kind: "full-story", depth: "composition", targets: [], branches: [] },
      constraints: [], envelope: { presentation: "Interactive Story", hardLimits: [], preferences: [] },
    }));
    function cli(...args: string[]) {
      return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "job", ...args,
        "--story", story, "--job", "obsolete"], {
        encoding: "utf8", timeout: 30_000,
        env: { ...process.env, NT_STATE_DIR: join(root, "state") },
      });
    }
    const started = cli("start");
    assert.equal(started.status, 0, started.stderr);
    const job = JSON.parse(started.stdout) as JobStartResult;
    const before = readdirSync(job.stateDir).sort();
    const head = git("rev-parse", "HEAD");
    const refused = cli("generate", "start", "--task", "Continue", "--contract", contract);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /authenticated current-format Turn plan/);
    assert.deepEqual(readdirSync(job.stateDir).sort(), before);
    assert.equal(git("rev-parse", "HEAD"), head);
    assert.equal(git("status", "--porcelain"), "");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("historical Turn receipts cannot grant final fulfillment or current execution", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nt-r14k-fulfillment-"));
  try {
    const job = { jobId: "historical", storyRoot: "/isolated/story", stateDir,
      baseSha: "a".repeat(40), headSha: "b".repeat(40) } as JobStartResult;
    const contract = {
      scope: { kind: "full-story" as const, depth: "composition" as const, targets: [], branches: [] },
      constraints: [], envelope: { presentation: "Interactive Story", hardLimits: [], preferences: [] },
    };
    const context = { headSha: job.headSha, baseSha: job.baseSha, planVersion: 1, contract,
      scopeCurrent: true, scopeComplete: true, editorialPass: true, scopedPaths: [] };
    await assert.rejects(prepareTurnFulfillment(job, context), /authenticated current-format Turn/);
    const { objective: _old, digest: _digest, ...body } = planWholeStory("Original Story", contract, job.baseSha);
    const digest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    writeFileSync(join(stateDir, "turn-plan.json"), JSON.stringify({ ...body, digest }));
    await assert.rejects(prepareTurnFulfillment(job, context), /authenticated current-format Turn/);
    await assert.rejects(readTurnEvidence(job, contract, body.originalRequest, digest),
      /current-format Turn objective/);
    assert.throws(() => verifyTurnPlan({ ...body, digest }), /Invalid persisted Turn plan/);
    for (const fixture of [true, false])
      await assert.rejects(requireGenerationTurn(job, { story: job.storyRoot, job: job.jobId,
        task: body.originalRequest, contract, fixture, turnPlanDigest: digest }), /current-format Turn objective/);
    assert.deepEqual(readdirSync(stateDir), ["turn-plan.json"]);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test("current-format SQLite resume refuses a missing or foreign server owner before pending effects", async () => {
  const root = mkdtempSync(join(tmpdir(), "nt-r14k-owner-"));
  const previous = process.env.NT_STATE_DIR;
  process.env.NT_STATE_DIR = join(root, "state");
  let saver: SqliteSaver | undefined;
  try {
    const story = join(root, "story");
    mkdirSync(story);
    writeFileSync(join(story, ".gitkeep"), "");
    const git = (...args: string[]) => {
      const r = spawnSync("git", ["-C", story, ...args], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    git("init", "-q");
    git("config", "user.name", "Author");
    git("config", "user.email", "author@example.test");
    git("add", ".");
    git("commit", "-qm", "Initial Story");
    const started = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts",
      "job", "start", "--story", story, "--job", "current"], { encoding: "utf8" });
    assert.equal(started.status, 0, started.stderr);
    const job = JSON.parse(started.stdout) as JobStartResult;
    const contract = {
      scope: { kind: "full-story" as const, depth: "composition" as const, targets: [], branches: [] },
      constraints: [], envelope: { presentation: "Interactive Story", hardLimits: [], preferences: [] },
    };
    const task = "An isolated Story";
    const plan = planWholeStory(task, contract, job.baseSha);
    await saveJobTurnPlan(job, plan);
    const request = { story: job.storyRoot, job: job.jobId, task, contract,
      fixture: true, turnPlanDigest: plan.digest, orchestrationPolicy: "fixture-test" as const };
    const thread = job.threadId + ":generation:web";
    const config = { configurable: { thread_id: thread }, recursionLimit: 100 };
    const db = join(job.stateDir, "web-generation.sqlite");
    saver = SqliteSaver.fromConnString(db);
    let graph = createGenerationGraph(saver, "server");
    await graph.invoke({ request }, { ...config, interruptAfter: ["schedule"] });
    const snapshot = await graph.getState(config);
    assert.equal(snapshot.values.status, "running", snapshot.values.reason ?? "");
    assert.deepEqual(snapshot.next, ["author_update_intake"]);
    const ownerFile = join(job.stateDir, "generation-server-owner.json");
    const owner = readFileSync(ownerFile, "utf8");
    const before = git("rev-parse", "HEAD");
    // Resume through the real pending SQLite task rather than through START.
    saver.db.close();
    saver = SqliteSaver.fromConnString(db);
    graph = createGenerationGraph(saver, "server");
    unlinkSync(ownerFile);
    const stopped = await graph.invoke(null, config);
    assert.equal(stopped.status, "blocked", stopped.reason ?? "");
    assert.match(stopped.reason ?? "", /lost its original owner receipt/);
    assert.equal(stopped.recoveryLifecycle.inspectionFences.length, 1);
    assert.equal(git("rev-parse", "HEAD"), before);
    assert.equal(git("status", "--porcelain"), "");
    assert.ok(!readdirSync(job.stateDir).includes("foundation.json"));
    // The original claim is historical evidence, not a grant to another owner.
    writeFileSync(ownerFile, owner);
    const other = createGenerationGraph(saver, "cli");
    const refused = await other.invoke({ request }, {
      configurable: { thread_id: thread + ":foreign" }, recursionLimit: 100 });
    assert.equal(refused.status, "blocked", refused.reason ?? "");
    assert.match(refused.reason ?? "", /server-owned/);
    assert.equal(readFileSync(ownerFile, "utf8"), owner);
    assert.equal(git("rev-parse", "HEAD"), before);
    assert.ok(!readdirSync(job.stateDir).includes("foundation.json"));
  } finally {
    saver?.db.close();
    if (previous === undefined) delete process.env.NT_STATE_DIR; else process.env.NT_STATE_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("integrity assessment cannot be skipped by changing current Turn transport", async () => {
  const turnDigest = "a".repeat(64);
  const c = { id: "case", origin: { sourceHeadSha: "b".repeat(40), turnDigest },
    evidence: [] } as unknown as RecoveryCase;
  for (const fixture of [false, true]) {
    const state = { request: { fixture, turnPlanDigest: turnDigest },
      recoverySources: [{ caseId: c.id, channel: "operationRecovery",
        input: { evidence: { failureKind: "integrity" } } }] } as unknown as GenerationGraphState;
    const decision = await selectOperationStrategy({} as JobStartResult, state, c);
    assert.equal(decision?.action, "integrity-fence");
  }
});


test("legacy structural fixture cannot acquire an ambient or already bound model runtime", async () => {
  const { createJobModelRuntime, withJobModelRuntime, withoutJobModelRuntime } = await import("../src/model-runtime.js");
  const { runtime, observed } = await (await import("./c03-scripted-story-helpers.js")).scriptedStoryRuntime(() => {
    throw Error("Fixture may not call Pi");
  });
  await withoutJobModelRuntime(async () => {
    await assert.rejects(createJobModelRuntime(), /forbidden in a structural fixture/);
    assert.throws(() => withJobModelRuntime(runtime, async () => {}), /forbidden in a structural fixture/);
  });
  await withJobModelRuntime(runtime, async () => {
    await withoutJobModelRuntime(async () => {
      await assert.rejects(createJobModelRuntime(), /forbidden in a structural fixture/);
    });
    assert.equal(await createJobModelRuntime(), runtime, "The outer authenticated transport is retained");
  });
  assert.equal(observed.length, 0);
});
