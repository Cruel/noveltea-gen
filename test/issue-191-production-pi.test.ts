import { archiveStages } from "./support/scripted-archive-stages.js";
/** #191: deterministic Pi transport over the REAL registered rootless sandbox.
 * Exercises the production orchestrator and independent assignment reviewer
 * adapters, pinned skill reads, actual Pi session transcripts and Git source. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { createGenerationGraph } from "../src/generation.js";
import {
  createAssistantMessageEventStream, type AssistantMessage, type Model,
  type Provider, type TranscriptContext, type SimpleStreamOptions, type ToolCall,
} from "@earendil-works/pi-ai";
import { createControllerServer, SandboxController, type ControllerConfig } from "../web/src/sandbox-controller.js";
import { startStoryJob } from "../src/job.js";
import { exerciseAdaptiveRecoveryGraph } from "./adaptive-protocol-scenario.js";
import { runFoundationJob } from "../src/foundation.js";
import { planWholeStory } from "../web/src/lib/turn-plan.js";
import { selectStoryOrchestrator } from "../src/orchestrator-selection.js";
import { runPinnedObjectivePlanner } from "../src/orchestrator-planner.js";
import { runPiAssignmentReview, prepareSemanticReview } from "../src/semantic-assignment-review.js";
import { inspectRecoveryCheckpoints } from "../src/recovery-checkpoints.js";
import { beginRejectedRepair, claimRejectedRepair, inspectPreparedRepairDispatch,
  markRejectedRepairStarted, reconcileCompletedRepairWriter,
  validateRejectedRepairDraft, commitRejectedRepairDraft, reconcileUnpublishedRepairCommit,
  inspectRejectedRepair } from "../src/rejected-review-repair.js";
import { inspectRepairLedger } from "../src/repair-ledger.js";
import { createSkillSnapshot } from "../src/snapshot.js";
import { boundedPinnedSources } from "../src/bounded-specialist-prompt.js";
import { withJobModelRuntime } from "../src/model-runtime.js";
import { withStoryJobLock } from "../src/job-lock.js";
import { removeTestTree } from "./helpers.js";

const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const model: Model = {
  id: "scripted-191", name: "Scripted #191", provider: "cert-191", api: "cert-191-api",
  baseUrl: "http://not-used.invalid", input: ["text"], reasoning: false,
  contextWindow: 128_000, maxTokens: 16_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const usage: AssistantMessage["usage"] = {
  input: 20, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 40,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
type Script = (index: number, context: TranscriptContext) => { content: AssistantMessage["content"]; reason: "stop" | "toolUse" };
function scripted(script: Script, observed: Array<{ tools: string[]; messages: readonly unknown[] }>): Provider {
  let index = 0;
  const stream = (_model: Model, ctx: TranscriptContext, _options?: SimpleStreamOptions) => {
    const result = createAssistantMessageEventStream();
    const active = new Set<string>();
    for (const m of ctx.messages) {
      if (m.role !== "system") continue;
      for (const t of m.toolsAdded ?? []) active.add(t.name);
      for (const t of m.toolsRemoved ?? []) active.delete(t.name);
    }
    observed.push({ tools: [...active], messages: ctx.messages });
    const { content, reason } = script(index++, ctx);
    const message: AssistantMessage = {
      role: "assistant", api: model.api, provider: model.provider,
      model: model.id, content, usage, stopReason: reason, timestamp: Date.now(),
    };
    queueMicrotask(() => {
      result.push({ type: "start", partial: message });
      content.forEach((c, i) => {
        if (c.type === "toolCall") {
          result.push({ type: "toolcall_start", contentIndex: i, partial: message });
          result.push({ type: "toolcall_end", contentIndex: i, toolCall: c, partial: message });
        } else if (c.type === "text") {
          result.push({ type: "text_start", contentIndex: i, partial: message });
          result.push({ type: "text_end", contentIndex: i, content: c.text, partial: message });
        }
      });
      result.push({ type: "done", reason, message });
      result.end(message);
    });
    return result;
  };
  return {
    id: model.provider, name: "Local scripted protocol certification",
    auth: { apiKey: { name: "Local scripted auth", check: async () =>
      ({ type: "api_key", source: "test" }), resolve: async () =>
      ({ auth: { apiKey: "local-script-only" } }) } },
    getModels: () => [model], stream, streamSimple: stream,
  };
}
const readCalls = (refs: readonly string[]): ToolCall[] => refs.map((path, i) => ({
  type: "toolCall", id: "protocol-read-" + i, name: "read",
  arguments: { path: "skill://" + path },
}));
const text = (value: string): AssistantMessage["content"] => [{ type: "text", text: value }];
async function runtimeFor(script: Script, calls: Array<{ tools: string[]; messages: readonly unknown[] }>) {
  const rt = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
  rt.registerNativeProvider(scripted(script, calls));
  await rt.refresh({ allowNetwork: false });
  return rt;
}
function dockerAvailable() {
  try {
    const security = JSON.parse(execFileSync("docker", ["info", "--format", "{{json .SecurityOptions}}"],
      { encoding: "utf8", timeout: 8000 })) as string[];
    if (!security.some(f => /(^|=)rootless$/.test(f))) return false;
    execFileSync("docker", ["image", "inspect", "noveltea-sandbox:local"], { stdio: "ignore", timeout: 8000 });
    return true;
  } catch { return false; }
}
const source = resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills");
const available = dockerAvailable() &&
  existsSync(join(source, "skills/nt-story-orchestrate/SKILL.md"));

test("production planner and adaptive recovery use original Pi sessions against pinned Story source", {
  skip: !available && "Requires registered rootless sandbox and local noveltea-skills",
  timeout: 240_000,
}, async () => {
  const tmp = mkdtempSync(join(tmpdir(), "nt-191-production-"));
  const id = randomUUID();
  const old = Object.fromEntries([
    "NT_STATE_DIR", "NT_GIT_CACHE_DIR", "NT_SKILL_CACHE_DIR", "NT_CONFIG_FILE",
    "NT_SANDBOX_SOCKET", "NT_SANDBOX_TOKEN_FILE", "NT_REQUIRE_SANDBOX_TOOLS",
    "NT_REQUIRE_USER_PI_RUNTIME",
  ].map(k => [k, process.env[k]]));
  let controller: SandboxController | undefined;
  let secondLiveId: string | undefined;
  const adaptiveIds = Array.from({ length: 10 }, () => randomUUID());
  let server: ReturnType<typeof createControllerServer> | undefined;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  try {
    const app = join(tmp, "app"), state = join(tmp, "state"), cache = join(tmp, "cache");
    const socketDir = join(tmp, "controller");
    for (const dir of [app, state, cache, socketDir]) mkdirSync(dir, { recursive: true });
    const owner = "protocol-test-owner", repositoryId = "protocol-test-repo";
    const scoped = join(cache, sha(owner), sha("github:" + repositoryId));
    const repo = join(scoped, "base"), story = join(repo, "story");
    mkdirSync(story, { recursive: true });
    writeFileSync(join(story, "README.txt"), "Disposable Story root\n");
    git(repo, "init", "-q"); git(repo, "config", "user.name", "Author");
    git(repo, "config", "user.email", "author@example.test");
    git(repo, "add", "."); git(repo, "commit", "-qm", "Source Story");
    const baseline = git(repo, "rev-parse", "HEAD");
    const db = new DatabaseSync(join(app, "studio.sqlite"));
    try {
      db.exec("CREATE TABLE studio_sessions (id TEXT, owner_user_id TEXT, story_id TEXT, source_commit_sha TEXT, generation_config_json TEXT);" +
        "CREATE TABLE stories (id TEXT, owner_user_id TEXT, repository_id TEXT, directory TEXT);" +
        "CREATE TABLE repositories (id TEXT, owner_user_id TEXT, provider TEXT, provider_repository_id TEXT);");
      db.prepare("INSERT INTO repositories VALUES (?,?,?,?)").run("repo", owner, "github", repositoryId);
      db.prepare("INSERT INTO stories VALUES (?,?,?,?)").run("story", owner, "repo", "story");
      db.prepare("INSERT INTO studio_sessions VALUES (?,?,?,?,?)").run(id, owner, "story", baseline, null);
    } finally { db.close(); }
    writeFileSync(join(tmp, "skills-config.json"), JSON.stringify({ novelteaSkills: source,
      skillDiscovery: "explicit-only", requiredSkills: [], skillDirs: [] }));
    const token = randomBytes(48).toString("hex");
    const tokenFile = join(socketDir, "controller.token");
    writeFileSync(tokenFile, token + "\n", { mode: 0o600 });
    const config: ControllerConfig = {
      socket: join(socketDir, "controller.sock"), token, appVolume: app,
      stateVolume: state, cacheVolume: cache, containerState: state,
      containerCache: cache, image: "noveltea-sandbox:local",
    };
    controller = new SandboxController(config);
    server = createControllerServer(controller);
    server.listen(config.socket);
    await once(server, "listening");
    Object.assign(process.env, {
      NT_STATE_DIR: state, NT_GIT_CACHE_DIR: scoped,
      NT_SKILL_CACHE_DIR: join(tmp, "skills"), NT_CONFIG_FILE: join(tmp, "skills-config.json"),
      NT_SANDBOX_SOCKET: config.socket, NT_SANDBOX_TOKEN_FILE: tokenFile,
      NT_REQUIRE_SANDBOX_TOOLS: "1", NT_REQUIRE_USER_PI_RUNTIME: "1",
    });
    const job = await startStoryJob({ story, job: id, worktreeCacheRoot: scoped });
    const contract = {
      scope: { kind: "full-story" as const, depth: "composition" as const,
        targets: [], branches: [] }, constraints: [],
      envelope: { presentation: "Dialogue mystery", hardLimits: [], preferences: [] },
    };
    const task = "Create a bounded mystery Story with a verified causal foundation";
    const plan = planWholeStory(task, contract, baseline, job.jobId);
    writeFileSync(join(job.stateDir, "turn-plan.json"), JSON.stringify(plan));
    const selection = await selectStoryOrchestrator(job, job.threadId + ":generation", {
      task, kind: "full-story", turnPlanDigest: plan.digest,
    }, source);
    const expectedPlan = {
      sourceSha: baseline, turnDigest: plan.digest,
      assignments: plan.assignments.map(a => ({ id: a.id, reason: "Trusted bounded assignment" })),
    };
    const plannerCalls: Array<{ tools: string[]; messages: readonly unknown[] }> = [];
    const plannerRuntime = await runtimeFor(i => {
      if (i === 0) return {
        content: readCalls([
          "nt-story-orchestrate/SKILL.md", "nt-story-orchestrate/references/planning.md",
          "nt-catalog/SKILL.md", "nt-catalog/references/records.md",
          "nt-catalog/references/progression.md",
          "nt-catalog/references/authority-and-validation.md",
        ]), reason: "toolUse",
      };
      if (i === 1) return { content: text("{ not-json"), reason: "stop" };
      if (i === 2) return { content: text(JSON.stringify(expectedPlan)), reason: "stop" };
      throw Error("Planner exceeded bounded scripted calls.");
    }, plannerCalls);
    const receipt = await withJobModelRuntime(plannerRuntime, () =>
      runPinnedObjectivePlanner(job, selection, plan, model.provider, model.id));
    assert.deepEqual(receipt.proposal, expectedPlan);
    assert.equal(plannerCalls.length, 3);
    assert.deepEqual(plannerCalls[2]!.tools, [], "planner format correction must have no tools");
    assert.match(JSON.stringify(plannerCalls[2]!.messages), /RESPONSE-CONTRACT CORRECTION ONLY/);
    assert.equal((await withJobModelRuntime(plannerRuntime, () =>
      runPinnedObjectivePlanner(job, selection, plan, model.provider, model.id))).digest, receipt.digest);
    assert.equal(plannerCalls.length, 3, "planner restart must not re-invoke Pi");
    const protocolPlan = JSON.parse(readFileSync(join(job.stateDir,
      "objective-plan-protocol.initial.json"), "utf8"));
    assert.equal(protocolPlan.status, "accepted");
    assert.equal(protocolPlan.attempts, 2);
    assert.equal(protocolPlan.sessionFile, receipt.sessionFile);
    // #195: simulate Graph losing its completed planner transition before
    // publishing phase=planned. The original Pi transcript and acceptance
    // receipt, not a new model invocation, must restore the same checkpoint.
    const planningFile = join(job.stateDir, "objective-planning.json");
    const { digest: _oldDigest, proposal: _oldProposal,
      skillReads: _oldReads, ...originalPlanning } = receipt;
    const interrupted = { ...originalPlanning, phase: "planning" as const };
    writeFileSync(planningFile, JSON.stringify({ ...interrupted, digest: sha(JSON.stringify(interrupted)) }));
    for (let restart = 0; restart < 2; restart++) {
      const restored = await withJobModelRuntime(plannerRuntime, () =>
        runPinnedObjectivePlanner(job, selection, plan, model.provider, model.id));
      assert.deepEqual(restored.proposal, expectedPlan);
      assert.equal(restored.digest, receipt.digest);
      assert.equal(plannerCalls.length, 3, "Graph resume cannot repeat the original planner");
    }

    // The production LangGraph schedule node must admit a NEW model planner,
    // exhaust its original three replies, and use exactly one source-pinned
    // fresh Pi conversation. No other generation node is executed.
    const secondId = randomUUID();
    secondLiveId = secondId;
    const secondDb = new DatabaseSync(join(app, "studio.sqlite"));
    try {
      secondDb.prepare("INSERT INTO studio_sessions VALUES (?,?,?,?,?)").run(
        secondId, owner, "story", baseline, null);
    } finally { secondDb.close(); }
    const secondJob = await startStoryJob({ story, job: secondId, worktreeCacheRoot: scoped });
    const secondPlan = planWholeStory(task, contract, baseline, secondJob.jobId);
    writeFileSync(join(secondJob.stateDir, "turn-plan.json"), JSON.stringify(secondPlan));
    const expectedSecond = {
      sourceSha: baseline, turnDigest: secondPlan.digest,
      assignments: secondPlan.assignments.map(a => ({
        id: a.id, reason: "Exact source-pinned complete assignment",
      })),
    };
    const fallbackCalls: Array<{ tools: string[]; messages: readonly unknown[] }> = [];
    const fallbackRuntime = await runtimeFor(i => {
      if (i === 0 || i === 4) return { content: readCalls([
        "nt-story-orchestrate/SKILL.md", "nt-story-orchestrate/references/planning.md",
        "nt-catalog/SKILL.md", "nt-catalog/references/records.md",
        "nt-catalog/references/progression.md",
        "nt-catalog/references/authority-and-validation.md",
      ]), reason: "toolUse" };
      if ([1, 2, 3].includes(i)) return { content: text("invalid schema"),
        reason: "stop" };
      if (i === 5) return { content: text(JSON.stringify(expectedSecond)), reason: "stop" };
      throw Error("Planner opened an unapproved third conversation.");
    }, fallbackCalls);
    const saver = SqliteSaver.fromConnString(join(secondJob.stateDir, "graph-191.sqlite"));
    try {
      const graph = createGenerationGraph(saver, "cli");
      const thread = secondJob.threadId + ":generation";
      const input = { request: {
        story, job: secondId, task, contract, fixture: false,
        skillsSource: source, provider: model.provider, model: model.id,
        turnPlanDigest: secondPlan.digest, orchestrationPolicy: "explicit" as const,
      } };
      const result = await withJobModelRuntime(fallbackRuntime, () =>
        graph.invoke(input, { configurable: { thread_id: thread },
          interruptAfter: ["schedule"] }));
      assert.equal(result.status, "running", JSON.stringify(result));
      assert.deepEqual(result.orchestratorOrder, secondPlan.assignments.map(a => a.id));
      assert.equal(fallbackCalls.length, 6);
      assert.deepEqual(fallbackCalls[2]!.tools, []);
      assert.deepEqual(fallbackCalls[3]!.tools, []);
      assert.ok(fallbackCalls[4]!.tools.includes("read"),
        "fresh planner must inspect immutable pinned methods");
      assert.ok(!fallbackCalls[5]!.tools.includes("write"),
        "fresh planner never acquires writer authority");
      const planRoot = join(secondJob.stateDir, "objective-plan-protocol");
      const originalReceipt = JSON.parse(readFileSync(planRoot + ".initial.json", "utf8"));
      const freshReceipt = JSON.parse(readFileSync(planRoot + ".fresh.json", "utf8"));
      const allowance = JSON.parse(readFileSync(planRoot + ".fresh-allowance.json", "utf8"));
      assert.equal(originalReceipt.attempts, 3);
      assert.equal(originalReceipt.status, "protocol-exhausted");
      assert.equal(freshReceipt.attempts, 1);
      assert.equal(freshReceipt.status, "accepted");
      assert.equal(allowance.freshAllowanceConsumed, true);
      assert.notEqual(originalReceipt.sessionFile, freshReceipt.sessionFile);
      const checkpoint = await graph.getState({ configurable: { thread_id: thread } });
      assert.equal(checkpoint.values.orchestratorPlanningDigest, result.orchestratorPlanningDigest);
      const rerun = await withJobModelRuntime(fallbackRuntime, () =>
        graph.getState({ configurable: { thread_id: thread } }));
      assert.equal(rerun.values.orchestratorPlanningDigest, result.orchestratorPlanningDigest);
      assert.equal(fallbackCalls.length, 6, "graph checkpoint inspection cannot replay model calls");
      // #195: lose the terminal planner receipt after a completed fresh
      // fallback. Reconcile both Pi sessions, preserving the single allowance.
      const secondSelection = await selectStoryOrchestrator(secondJob, thread, {
        task, kind: "full-story", turnPlanDigest: secondPlan.digest,
      }, source);
      const planFile = join(secondJob.stateDir, "objective-planning.json");
      const planned = JSON.parse(readFileSync(planFile, "utf8"));
      const { digest: _digest, proposal: _proposal,
        skillReads: _skillReads, ...beforePublication } = planned;
      const interrupted = { ...beforePublication, phase: "planning" };
      writeFileSync(planFile, JSON.stringify({
        ...interrupted, digest: sha(JSON.stringify(interrupted)),
      }));
      for (let restart = 0; restart < 2; restart++) {
        const restored = await withJobModelRuntime(fallbackRuntime, () =>
          runPinnedObjectivePlanner(secondJob, secondSelection, secondPlan,
            model.provider, model.id));
        assert.deepEqual(restored.proposal, expectedSecond);
        assert.equal(fallbackCalls.length, 6);
        assert.equal(restored.sessionFile, freshReceipt.sessionFile);
      }
    } finally { saver.db.close(); }

    // Adaptive planning consumes author-approved planning metadata. Bootstrap
    // from an actual author-owned source commit, not a fabricated approval
    // or a specialist claiming its own draft was approved.
    mkdirSync(join(story, "creative-direction"), { recursive: true });
    const approvedDirection = readFileSync(resolve("test/fixtures/archive-witness/creative-direction/foundation.md"), "utf8")
      .replace(/^status: draft$/m, 'status: approved\nplanning: {choice_frequency: occasional, puzzle_emphasis: none}');
    writeFileSync(join(story, "creative-direction", "foundation.md"), approvedDirection);
    git(repo, "add", "."); git(repo, "commit", "-qm", "Author-approved planning baseline");
    for (const [index, adaptiveId] of adaptiveIds.entries()) {
      const db218 = new DatabaseSync(join(app, "studio.sqlite"));
      try { db218.prepare("INSERT INTO studio_sessions VALUES (?,?,?,?,?)").run(
        adaptiveId, owner, "story", git(repo, "rev-parse", "HEAD"), null); } finally { db218.close(); }
      const calls: Array<{ tools: string[]; messages: readonly unknown[] }> = [];
      await exerciseAdaptiveRecoveryGraph({ story, id: adaptiveId, source, task, contract, scoped,
        provider: model.provider, model: model.id, calls, exhaust: index === 1,
        preCallStop: index === 2 || index >= 5 && index <= 8,
        completedStop: index === 3 || index === 4, tamperCompleted: index === 4,
        rejectProposal: index === 9,
        preCallRefusal: index >= 5 && index <= 8
          ? (["head", "model", "pause", "cancel"] as const)[index - 5] : undefined,
        bootstrap: (job, turn, observed) => runtimeFor(archiveStages(job, turn, true), observed),
        runtime: script => runtimeFor(i => {
          const next = script(i);
          return Array.isArray(next) ? { content: readCalls(next), reason: "toolUse" } :
            { content: text(next), reason: "stop" };
        }, calls),
      });
    }
  } finally {
    for (const adaptiveId of adaptiveIds) controller?.dispose(adaptiveId);
    if (controller && secondLiveId) controller.dispose(secondLiveId);
    if (controller) controller.dispose(id);
    if (server) await new Promise<void>(done => server!.close(() => done()));
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    removeTestTree(tmp);
  }
});
