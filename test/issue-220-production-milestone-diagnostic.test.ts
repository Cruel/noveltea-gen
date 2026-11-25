/** #220 production admission: nonproductive Milestone review invokes a fresh
 * read-only diagnostician, respects the existing Pi budget and replays no
 * original writer or reviewer when the limit is raised. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream, type AssistantMessage,
  type Model, type Provider, type TranscriptContext, type SimpleStreamOptions, type ToolCall,
} from "@earendil-works/pi-ai";
import { createControllerServer, SandboxController,
  type ControllerConfig } from "../web/src/sandbox-controller.js";
import { ensureMilestoneBlueprint, inspectMilestoneBlueprint,
  readReviewedMilestoneBlueprint, type MilestoneBlueprint } from "../src/milestone-blueprint.js";
import { startStoryJob } from "../src/job.js";
import { withStoryJobLock } from "../src/job-lock.js";
import { configurePiPolicy, inspectPiPolicy, PiBudgetPause } from "../src/job-pi-policy.js";
import { withJobModelRuntime } from "../src/model-runtime.js";
import { createSkillSnapshot } from "../src/snapshot.js";
import type { Plan } from "../src/architecture.js";
import type { EventAssignment } from "../src/event-specialist.js";
import { removeTestTree } from "./helpers.js";

const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const skillSource = resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills");
const model: Model = {
  id: "scripted-220", name: "Milestone diagnostic #220",
  provider: "cert-220", api: "cert-220-api",
  baseUrl: "http://not-used.invalid", input: ["text"], reasoning: false,
  contextWindow: 128_000, maxTokens: 16_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const usage: AssistantMessage["usage"] = {
  input: 20, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 40,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const milestoneId = "milestone.sample";
const milestonePath = "milestones/sample.md";
const task = "Design an inspectable Event about the dated gate register without inventing character knowledge";
const contract = { objective: "Only earned Character knowledge from inspectable dated evidence" };
const knowledge = "The guard claims secret knowledge of yesterday without any proof";
const draft: MilestoneBlueprint = {
  schema: "noveltea-milestone-blueprint/v1", milestoneId,
  events: [{
    id: "arrival", purpose: "Inspect the dated gate register", dependsOn: [],
    participants: [], knowledge, routes: [],
    evidence: [{
      anchorPath: milestonePath, source: "The visible gate register",
      observation: "The entry is dated today", access: "The guard can inspect the record",
      establishes: "A dated register entry exists", limits: "No record of yesterday's visit",
    }],
  }],
  downstream: [{ owner: "composition", obligation: "Present the dated entry in the player-facing scene" }],
};
const finding = {
  eventId: "arrival", anchorPath: milestonePath,
  requirement: "Knowledge must be earned from inspectable evidence",
  reason: "The draft asserts secret knowledge without any supporting record",
  correction: "Remove unsupported yesterday knowledge and ground the guard in the dated entry",
  evidence: { field: "knowledge", quote: knowledge, repair: "replace" },
};
const diagnosticAnswer = {
  schema: "noveltea-milestone-diagnosis/v1", action: "escalate",
  explanation: "Two nonproductive revisions leave the same unsupported assertion in place",
  assessments: [{
    kind: "material", reason: "The current knowledge field has not earned the asserted fact",
    requirement: { source: "contract", quote: "earned Character knowledge" },
    evidence: { eventId: "arrival", field: "knowledge", quote: knowledge },
  }],
};
type Call = { prompt: string; lastRole: string; tools: string[] };
function promptText(messages: readonly unknown[]) {
  const users = messages.filter((item): item is { role: "user"; content: unknown } =>
    !!item && typeof item === "object" && "role" in item && item.role === "user");
  return JSON.stringify(users.at(-1)?.content ?? "");
}
function scripted(
  calls: Call[],
  diagnosticAction: "escalate" | "replace" | "continue" = "escalate",
  twoDistinctCases = false,
  downstreamCorrection = false,
  productive = false,
  omitReads = false,
): Provider {
  let reviewerRound = 0;
  let writerRound = 0;
  let pendingReadRole: "writer" | "reviewer" | null = null;
  const omitted = new Set<string>();
  const correctedKnowledge = "The guard can verify only the dated gate register entry";
  const falseOwner = "No Choice or Puzzle is required for this current Milestone";
  const falseDownstream: MilestoneBlueprint = {
    ...draft,
    downstream: [{ owner: "interactive", obligation: falseOwner }, ...draft.downstream],
  };
  const ownerFinding = {
    anchorPath: milestonePath,
    requirement: "Only positively required current-Milestone Interactive work has an Interactive owner",
    reason: "The declared Interactive owner is a negative instruction, not required work",
    correction: "Remove the false Interactive owner and retain required Composition work",
    evidence: { target: "downstream", index: 0, field: "obligation", quote: falseOwner, repair: "replace" },
  };
  const materialChanges = [
    { field: "knowledge", before: knowledge, after: correctedKnowledge },
    { field: "purpose", before: "Infer the clerk's location from an undated mark.", after: "Compare the register and its dated entry." },
    { field: "evidence", before: JSON.stringify([{ ...draft.events[0]!.evidence[0]!, establishes: "Yesterday's visit is proved by a mark without a date." }]),
      after: JSON.stringify(draft.events[0]!.evidence) },
  ] as const;
  const productiveDraft = (round: number) => {
    const event = { ...draft.events[0]! };
    for (const [index, change] of materialChanges.entries()) {
      const value = index < round ? change.after : change.before;
      if (change.field === "evidence") event.evidence = JSON.parse(value);
      else event[change.field] = value;
    }
    return { ...draft, events: [event] };
  };
  const productiveReview = (round: number) => ({
    schema: "noveltea-milestone-blueprint-review/v5",
    status: round === 3 ? "pass" : "revise",
    findings: round === 3 ? [] : [{ ...finding,
      requirement: "Only source-grounded " + materialChanges[round]!.field,
      reason: "An unsupported claim remains in " + materialChanges[round]!.field,
      correction: "Replace the unsupported claim with observable register evidence.",
      evidence: { field: materialChanges[round]!.field, quote: materialChanges[round]!.before, repair: "replace" } }],
    prior: materialChanges.slice(0, round).map((change, index) => ({
      round: index, findingIndex: 0, status: "resolved", reason: "The specific unsupported source claim was replaced.",
      evidence: { kind: "revised", eventId: "arrival", field: change.field, before: change.before, after: change.after },
    })),
  });
  const reads = ["skill://nt-event-design/SKILL.md", "skill://nt-catalog/SKILL.md", milestonePath];
  const stream = (_model: Model, ctx: TranscriptContext, _opts?: SimpleStreamOptions) => {
    const result = createAssistantMessageEventStream();
    const prompt = promptText(ctx.messages);
    const lastRole = ctx.messages.at(-1)?.role ?? "";
    const tools = new Set<string>();
    for (const entry of ctx.messages) {
      if (entry.role !== "system") continue;
      for (const tool of entry.toolsAdded ?? []) tools.add(tool.name);
      for (const name of entry.toolsRemoved ?? []) tools.delete(name);
    }
    calls.push({ prompt, lastRole, tools: [...tools] });
    const isDiagnostic = prompt.includes("FRESH INDEPENDENT READ-ONLY MILESTONE REVIEW DIAGNOSTIC");
    const isReplacement = prompt.includes("FRESH INDEPENDENT REPLACEMENT REVIEWER");
    const isCorrection = prompt.includes("READ-ONLY MILESTONE SOURCE-READ CORRECTION");
    const isReview = prompt.includes("INDEPENDENT READ-ONLY MILESTONE PLAN REVIEW") || isCorrection && pendingReadRole === "reviewer";
    const isWriter = prompt.includes("READ-ONLY LOCAL MILESTONE BLUEPRINT") || isCorrection && pendingReadRole === "writer";

    if (!isDiagnostic && !isReview && !isWriter)
      throw Error("Unexpected Milestone Pi prompt: " + prompt.slice(0, 200));
    let content: AssistantMessage["content"];
    let reason: "stop" | "toolUse" = "stop";
    if (lastRole !== "toolResult") {
      const role = isReview ? "reviewer" : "writer";
      if (isCorrection) {
        assert.ok(pendingReadRole);
        assert.match(prompt, /skill:\/\/nt-catalog\/SKILL.md/);
        assert.ok(!tools.has("write") && !tools.has("edit") && !tools.has("bash"));
      }
      const missing = omitReads && !isDiagnostic && !isReplacement && !isCorrection && !omitted.has(role);
      if (missing) { omitted.add(role); pendingReadRole = role; }
      const readPaths = isCorrection ? [reads[1]!] : missing ? reads.filter(path => path !== reads[1]) : reads;
      content = readPaths.map((path): ToolCall => ({
        type: "toolCall",
        id: randomUUID(),
        name: "read",
        arguments: { path },
      }));
      reason = "toolUse";
    } else if (omitReads && !isCorrection && pendingReadRole && (isWriter || isReview)) {
      // A complete-looking reply without its mandatory skill read is not accepted.
      content = [{ type: "text", text: JSON.stringify(isWriter ? draft : productiveReview(reviewerRound)) }];
    } else if (isDiagnostic) {
      content = [{ type: "text", text: JSON.stringify({ ...diagnosticAnswer, action: diagnosticAction }) }];
    } else if (isReplacement) {
      content = [
        {
          type: "text",
          text: JSON.stringify({
            schema: "noveltea-milestone-blueprint-review/v5",
            status: "pass",
            findings: [],
            prior: [],
          }),
        },
      ];
    } else if (isReview) {
      if (productive) {
        content = [{ type: "text", text: JSON.stringify(productiveReview(reviewerRound++)) }];
      } else if (downstreamCorrection) {
        content = [
          {
            type: "text",
            text: JSON.stringify({
              schema: "noveltea-milestone-blueprint-review/v5",
              status: reviewerRound === 0 ? "revise" : "pass",
              findings: reviewerRound === 0 ? [ownerFinding] : [],
              prior:
                reviewerRound === 0
                  ? []
                  : [
                      {
                        round: 0,
                        findingIndex: 0,
                        status: "resolved",
                        reason: "The false Interactive owner is gone; Composition remains required",
                        evidence: {
                          target: "downstream",
                          kind: "removed",
                          index: 0,
                          field: "obligation",
                          before: falseOwner,
                        },
                      },
                    ],
            }),
          },
        ];
        reviewerRound++;
      } else {
        const resolved = diagnosticAction === "continue" && reviewerRound >= (twoDistinctCases ? 5 : 3);
        const prior = Array.from({ length: reviewerRound }, (_, round) => ({
          round,
          findingIndex: 0,
          status: resolved ? "resolved" : "persisting",
          reason: resolved
            ? "The unsupported claim is replaced by verifiable knowledge"
            : "Original unsupported knowledge remains verbatim and unverified",
          evidence: resolved
            ? {
                kind: "revised",
                eventId: "arrival",
                field: "knowledge",
                before: knowledge,
                after: correctedKnowledge,
              }
            : { kind: "current", eventId: "arrival", field: "knowledge", quote: knowledge },
        }));
        content = [
          {
            type: "text",
            text: JSON.stringify({
              schema: "noveltea-milestone-blueprint-review/v5",
              status: resolved ? "pass" : "revise",
              findings: resolved ? [] : [finding],
              prior,
            }),
          },
        ];
        reviewerRound++;
      }
    } else {
      if (productive) {
        content = [{ type: "text", text: JSON.stringify(productiveDraft(writerRound++)) }];
      } else if (downstreamCorrection) {
        content = [{ type: "text", text: JSON.stringify(writerRound++ === 0 ? falseDownstream : draft) }];
      } else {
        const corrected = diagnosticAction === "continue" && writerRound >= (twoDistinctCases ? 5 : 3);
        const distinctEvidence = twoDistinctCases && writerRound >= 3;
        writerRound++;
        content = [
          {
            type: "text",
            text: JSON.stringify(
              corrected
                ? {
                    ...draft,
                    events: [
                      {
                        ...draft.events[0]!,
                        purpose: distinctEvidence
                          ? draft.events[0]!.purpose + " A second gate document is disputed."
                          : draft.events[0]!.purpose,
                        knowledge: correctedKnowledge,
                      },
                    ],
                  }
                : distinctEvidence
                  ? {
                      ...draft,
                      events: [
                        {
                          ...draft.events[0]!,
                          purpose: draft.events[0]!.purpose + " A second gate document is disputed.",
                        },
                      ],
                    }
                  : draft,
            ),
          },
        ];
      }
    }
    if (isCorrection && lastRole === "toolResult") pendingReadRole = null;
    const message: AssistantMessage = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content,
      usage,
      stopReason: reason,
      timestamp: Date.now(),
    };
    queueMicrotask(() => {
      result.push({ type: "start", partial: message });
      content.forEach((part, index) => {
        if (part.type === "toolCall") {
          result.push({ type: "toolcall_start", contentIndex: index, partial: message });
          result.push({ type: "toolcall_end", contentIndex: index, toolCall: part, partial: message });
        } else if (part.type === "text") {
          result.push({ type: "text_start", contentIndex: index, partial: message });
          result.push({ type: "text_end", contentIndex: index, content: part.text, partial: message });
        }
      });
      result.push({ type: "done", reason, message });
      result.end(message);
    });
    return result;
  };
  return {
    id: model.provider,
    name: "Deterministic Milestone diagnostic test provider",
    auth: {
      apiKey: {
        name: "Test auth",
        check: async () => ({ type: "api_key", source: "test" }),
        resolve: async () => ({ auth: { apiKey: "scripted-local" } }),
      },
    },
    getModels: () => [model],
    stream,
    streamSimple: stream,
  };
}
function available() {
  try {
    const security = JSON.parse(execFileSync("docker",
      ["info", "--format", "{{json .SecurityOptions}}"],
      { encoding: "utf8", timeout: 8000 })) as string[];
    if (!security.some(value => /(^|=)rootless$/.test(value))) return false;
    execFileSync("docker", ["image", "inspect", "noveltea-sandbox:local"],
      { stdio: "ignore", timeout: 8000 });
    return existsSync(join(skillSource, "skills/nt-event-design/SKILL.md"));
  } catch { return false; }
}

test("#220: three stalled Milestone reviews actually dispatch a fresh independent diagnostician within the job budget", {
  skip: !available() && "Requires rootless sandbox and pinned skills",
  timeout: 240_000,
}, async () => {
  const tmp = mkdtempSync(join(tmpdir(), "nt-220-production-"));
  const keys = ["NT_STATE_DIR", "NT_GIT_CACHE_DIR", "NT_SKILL_CACHE_DIR",
    "NT_CONFIG_FILE", "NT_SANDBOX_SOCKET", "NT_SANDBOX_TOKEN_FILE",
    "NT_REQUIRE_SANDBOX_TOOLS", "NT_REQUIRE_USER_PI_RUNTIME"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  let controller: SandboxController | undefined;
  let server: ReturnType<typeof createControllerServer> | undefined;
  let jobId: string | undefined;
  let replacementJobId: string | undefined;
  let productiveJobId: string | undefined;
  let continuationJobId: string | undefined;
  let secondCaseJobId: string | undefined;
  let downstreamJobId: string | undefined;
  try {
    const app = join(tmp, "app"), state = join(tmp, "state"), cache = join(tmp, "cache"),
      socketDir = join(tmp, "controller");
    for (const dir of [app, state, cache, socketDir]) mkdirSync(dir, { recursive: true });
    const owner = "protocol-220-owner", repository = "protocol-220-repository";
    const scoped = join(cache, sha(owner), sha("github:" + repository));
    const repo = join(scoped, "base"), story = join(repo, "story");
    mkdirSync(join(story, "milestones"), { recursive: true });
    const source = `---
schema: '0.1'
type: milestone
id: milestone.sample
title: "A dated gate register"
status: draft
decisions: []
arcs: []
completeness: partial
fulfillment: {any_of: []}
---

The guard finds a dated register, but no evidence of a prior visit.
`;
    writeFileSync(join(story, milestonePath), source);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    git("init", "-q"); git("config", "user.name", "Test");
    git("config", "user.email", "test@example.test");
    git("add", "."); git("commit", "-qm", "Verified Story");
    const head = git("rev-parse", "HEAD");
    jobId = randomUUID();
    const db = new DatabaseSync(join(app, "studio.sqlite"));
    try {
      db.exec("CREATE TABLE studio_sessions (id TEXT, owner_user_id TEXT, story_id TEXT, source_commit_sha TEXT, generation_config_json TEXT);" +
        "CREATE TABLE stories (id TEXT, owner_user_id TEXT, repository_id TEXT, directory TEXT);" +
        "CREATE TABLE repositories (id TEXT, owner_user_id TEXT, provider TEXT, provider_repository_id TEXT);");
      db.prepare("INSERT INTO repositories VALUES (?,?,?,?)").run("repo", owner, "github", repository);
      db.prepare("INSERT INTO stories VALUES (?,?,?,?)").run("story", owner, "repo", "story");
      db.prepare("INSERT INTO studio_sessions VALUES (?,?,?,?,?)").run(jobId, owner, "story", head, null);
    } finally { db.close(); }
    const token = randomBytes(48).toString("hex"),
      tokenFile = join(socketDir, "controller.token");
    writeFileSync(tokenFile, token + "\n", { mode: 0o600 });
    const config: ControllerConfig = {
      socket: join(socketDir, "controller.sock"), token, appVolume: app,
      stateVolume: state, cacheVolume: cache,
      containerState: state, containerCache: cache, image: "noveltea-sandbox:local",
    };
    controller = new SandboxController(config);
    server = createControllerServer(controller);
    server.listen(config.socket);
    await once(server, "listening");
    Object.assign(process.env, {
      NT_STATE_DIR: state, NT_GIT_CACHE_DIR: scoped,
      NT_SKILL_CACHE_DIR: join(tmp, "skills"),
      NT_CONFIG_FILE: join(tmp, "unused-config.json"),
      NT_SANDBOX_SOCKET: config.socket, NT_SANDBOX_TOKEN_FILE: tokenFile,
      NT_REQUIRE_SANDBOX_TOOLS: "1", NT_REQUIRE_USER_PI_RUNTIME: "1",
    });
    const job = await startStoryJob({ story, job: jobId, worktreeCacheRoot: scoped });
    const snapshot = await createSkillSnapshot({
      discovery: "explicit-only", novelteaSkills: skillSource,
      skillDirs: [], requiredSkills: ["nt-event-design", "nt-catalog"],
    });
    assert.ok(snapshot);
    const plan = { version: 1, contract, items: [{
      id: "global-architecture", status: "verified", targetIds: [milestoneId],
    }] } as unknown as Plan;
    const assignment = { milestoneId, milestonePath, sourcePaths: [milestonePath],
      characterIds: [] } as unknown as EventAssignment;
    const calls: Call[] = [];
    const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(scripted(calls));
    await runtime.refresh({ allowNetwork: false });
    // Run the real sandbox-backed Blueprint adapter inside a persistent
    // parent node, as Event admission does. Discard the first child
    // checkpoint after a settled writer and after a negative Review.
    const dbPath = join(job.stateDir, "blueprint-assignment.sqlite");
    const graphConfig = { configurable: { thread_id: job.threadId + ":blueprint-test" },
      recursionLimit: 10000, durability: "sync" as const };
    const channels = Annotation.Root({ result: Annotation<unknown>() });
    let started = false;
    let saver = SqliteSaver.fromConnString(dbPath);
    const graph = () => new StateGraph(channels)
      .addNode("event_admission", async () => ({
        result: await ensureMilestoneBlueprint(job, plan, assignment, snapshot,
          model.provider, model.id, task, head, false),
      }))
      .addEdge(START, "event_admission")
      .addEdge("event_admission", END)
      .compile({ checkpointer: saver });
    let parent = graph();
    const run = async (signal?: AbortSignal) => {
      try {
        return await withJobModelRuntime(runtime, () =>
          withStoryJobLock(job, "event-sample", () =>
            parent.invoke(started ? null : { result: null }, { ...graphConfig, signal })));
      } finally { started = true; }
    };
    const restart = () => {
      saver.db.close();
      saver = SqliteSaver.fromConnString(dbPath);
      parent = graph();
    };
    await configurePiPolicy(job, {
      version: 1, profile: { provider: model.provider, model: model.id },
      limits: { modelCalls: 12 },
    });
    for (const boundary of ["draft", "negative-review"] as const) {
      const abort = new AbortController();
      const originalPut = saver.put.bind(saver);
      const originalWrites = saver.putWrites.bind(saver);
      let lost = false;
      const failure = Error("Injected Blueprint checkpoint loss: " + boundary);
      saver.put = async (...args) => {
        if (lost) throw failure;
        return originalPut(...args);
      };
      saver.putWrites = async (cfg, writes, taskId) => {
        if (lost) throw failure;
        const child = cfg.configurable?.checkpoint_ns?.includes("assignment-");
        const submission = writes.find(([key]) => key === "submission")?.[1] as
          { status?: string; receiptRef?: string } | undefined;
        if (child && (boundary === "draft"
          ? submission?.status === "milestone-blueprint-draft" && submission.receiptRef?.startsWith("0:")
          : writes.some(([key, value]) => key === "correction" && value))) {
          lost = true;
          abort.abort(failure);
          throw failure;
        }
        return originalWrites(cfg, writes, taskId);
      };
      await assert.rejects(run(abort.signal), (error: unknown) => { if (!lost) throw error; return true; });
      assert.ok(lost, "Must discard actual Blueprint checkpoint at " + boundary);
      const record = JSON.parse(readFileSync(join(job.stateDir, "milestone-blueprints", "sample.json"), "utf8"));
      assert.equal(record.phase, boundary === "draft" ? "draft" : "revision");
      assert.equal(record.rounds.length, boundary === "draft" ? 0 : 1);
      assert.equal(calls.length, boundary === "draft" ? 2 : 4,
        "Only the exact writer and reviewer may settle before the injected loss");
      restart();
    }
    await assert.rejects(run(), (error: unknown) =>
      error instanceof PiBudgetPause && error.reason === "modelCalls");
    const waiting = await inspectMilestoneBlueprint(job, milestoneId);
    assert.equal(waiting?.phase, "revision");
    assert.equal(waiting?.rounds, 3);
    assert.equal(waiting?.diagnostic, null);
    assert.equal(calls.filter(call =>
      call.prompt.includes("FRESH INDEPENDENT READ-ONLY MILESTONE REVIEW DIAGNOSTIC")).length, 0,
    "no diagnostician was dispatched across a budget boundary");
    await configurePiPolicy(job, {
      version: 1, profile: { provider: model.provider, model: model.id },
      limits: { modelCalls: 24 },
    });
    await assert.rejects(run(), /escalation/);
    const inspection = await inspectMilestoneBlueprint(job, milestoneId);
    assert.equal(inspection?.phase, "stopped");
    assert.equal(inspection?.rounds, 3);
    assert.equal(inspection?.lastVerdict, "revise");
    assert.equal(inspection?.diagnostic?.trigger, "stagnation");
    assert.equal(inspection?.diagnostic?.action, "escalate");
    const sealed = JSON.parse(readFileSync(join(job.stateDir, "milestone-blueprints",
      "sample.json"), "utf8")) as {
        writer: { id: string; file: string };
        reviewer: { id: string; file: string };
        diagnostics: Array<{ session: { id: string; file: string } }>;
      };
    assert.notEqual(sealed.writer.id, sealed.reviewer.id);
    assert.notEqual(sealed.diagnostics[0]?.session.id, sealed.writer.id);
    assert.notEqual(sealed.diagnostics[0]?.session.id, sealed.reviewer.id);
    assert.notEqual(sealed.diagnostics[0]?.session.file, sealed.reviewer.file);
    assert.equal(calls.filter(call =>
      call.prompt.includes("INDEPENDENT READ-ONLY MILESTONE PLAN REVIEW") &&
      call.lastRole === "toolResult").length, 3);
    const diagnosed = calls.filter(call =>
      call.prompt.includes("FRESH INDEPENDENT READ-ONLY MILESTONE REVIEW DIAGNOSTIC"));
    assert.equal(diagnosed.filter(call => call.lastRole === "toolResult").length, 1);
    assert.ok(diagnosed.every(call =>
      !call.tools.some(tool => ["write", "edit", "bash", "exec"].includes(tool))));
    const count = calls.length;
    await assert.rejects(run(), /escalation/);
    assert.equal(calls.length, count, "stopped review never dispatches more Pi work");
    saver.db.close();
    assert.equal(git("status", "--porcelain"), "", "canonical source repo stays unchanged");
    assert.equal(execFileSync("git", ["status", "--porcelain"],
      { cwd: job.worktreeRoot, encoding: "utf8" }).trim(), "",
    "Milestone diagnostic and reviews must never mutate the job Story");

    // A fresh replacement reviewer can independently PASS the existing source,
    // but the diagnostic itself remains advice; all old negatives stay sealed.
    replacementJobId = randomUUID();
    const replacementDb = new DatabaseSync(join(app, "studio.sqlite"));
    try {
      replacementDb.prepare("INSERT INTO studio_sessions VALUES (?,?,?,?,?)")
        .run(replacementJobId, owner, "story", head, null);
    } finally { replacementDb.close(); }
    const replacementJob = await startStoryJob({
      story, job: replacementJobId, worktreeCacheRoot: scoped,
    });
    const replacementCalls: Call[] = [];
    const replacementRuntime = await ModelRuntime.create({
      modelsPath: null, refreshOnCreate: false,
    });
    replacementRuntime.registerNativeProvider(scripted(replacementCalls, "replace"));
    await replacementRuntime.refresh({ allowNetwork: false });
    await configurePiPolicy(replacementJob, {
      version: 1, profile: { provider: model.provider, model: model.id },
      limits: { modelCalls: 24 },
    });
    // Lose the actual child checkpoint at the independently diagnosed reviewer
    // transition and at its verified pin, not just a simulated adapter return.
    const replacementPath = join(replacementJob.stateDir, "replacement-assignment.sqlite");
    let replacementSaver = SqliteSaver.fromConnString(replacementPath);
    const replacementChannels = Annotation.Root({
      result: Annotation<Awaited<ReturnType<typeof ensureMilestoneBlueprint>> | null>(),
    });
    const replacementGraph = () => new StateGraph(replacementChannels)
      .addNode("event_admission", async () => ({
        result: await ensureMilestoneBlueprint(replacementJob, plan, assignment, snapshot,
          model.provider, model.id, task, head, false),
      }))
      .addEdge(START, "event_admission")
      .addEdge("event_admission", END)
      .compile({ checkpointer: replacementSaver });
    let replacementParent = replacementGraph();
    let replacementStarted = false;
    const replace = (signal?: AbortSignal) => withJobModelRuntime(replacementRuntime, () =>
      withStoryJobLock(replacementJob, "event-sample", () =>
        replacementParent.invoke(replacementStarted ? null : {result: null}, {
          configurable: {thread_id: replacementJob.threadId + ":blueprint-replacement"},
          recursionLimit: 10000, durability: "sync", signal,
        })));
    for (const boundary of ["replacement", "pin"] as const) {
      const abort = new AbortController();
      const originalPut = replacementSaver.put.bind(replacementSaver);
      const originalWrites = replacementSaver.putWrites.bind(replacementSaver);
      const failure = Error("Injected replacement checkpoint loss: " + boundary);
      let lost = false;
      replacementSaver.put = async (...args) => {
        if (lost) throw failure;
        return originalPut(...args);
      };
      replacementSaver.putWrites = async (cfg, writes, taskId) => {
        if (lost) throw failure;
        const child = cfg.configurable?.checkpoint_ns?.includes("assignment-");
        const submission = writes.find(([key]) => key === "submission")?.[1] as
          {status?: string; receiptRef?: string} | undefined;
        const outcome = writes.find(([key]) => key === "outcome")?.[1] as {status?: string} | undefined;
        if (child && (boundary === "replacement"
          ? submission?.status === "milestone-blueprint-draft" && submission.receiptRef?.startsWith("3:")
          : outcome?.status === "verified")) {
          lost = true; abort.abort(failure); throw failure;
        }
        return originalWrites(cfg, writes, taskId);
      };
      await assert.rejects(replace(abort.signal), (error: unknown) => { if (!lost) throw error; return true; });
      assert.ok(lost, "Must lose actual " + boundary + " checkpoint");
      replacementStarted = true;
      assert.equal(replacementCalls.filter(call =>
        call.prompt.includes("FRESH INDEPENDENT READ-ONLY MILESTONE REVIEW DIAGNOSTIC") &&
        call.lastRole === "toolResult").length, 1);
      replacementSaver.db.close();
      replacementSaver = SqliteSaver.fromConnString(replacementPath);
      replacementParent = replacementGraph();
    }
    const replacementCompleted = await replace();
    replacementSaver.db.close();
    const result = replacementCompleted.result!;
    assert.ok(result);
    assert.equal(result.blueprint.milestoneId, milestoneId);
    assert.equal((await readReviewedMilestoneBlueprint(replacementJob,
      result.pin, assignment)).milestoneId, milestoneId);
    const replaced = await inspectMilestoneBlueprint(replacementJob, milestoneId);
    assert.equal(replaced?.phase, "approved");
    assert.equal(replaced?.lastVerdict, "pass");
    assert.equal(replaced?.diagnostic?.action, "replace");
    assert.equal(replaced?.rounds, 4);
    const replacementReceipt = JSON.parse(readFileSync(join(replacementJob.stateDir,
      "milestone-blueprints", "sample.json"), "utf8")) as {
        reviewer: { id: string; file: string };
        reviewerHistory: Array<{ session: { id: string; file: string } }>;
        rounds: Array<{ review: { status: string } }>;
      };
    assert.deepEqual(replacementReceipt.rounds.map(round => round.review.status),
      ["revise", "revise", "revise", "pass"]);
    assert.equal(replacementReceipt.reviewerHistory.length, 1);
    assert.notEqual(replacementReceipt.reviewer.id,
      replacementReceipt.reviewerHistory[0]?.session.id);
    assert.notEqual(replacementReceipt.reviewer.file,
      replacementReceipt.reviewerHistory[0]?.session.file);
    assert.equal(replacementCalls.filter(call =>
      call.prompt.includes("FRESH INDEPENDENT READ-ONLY MILESTONE REVIEW DIAGNOSTIC") &&
      call.lastRole === "toolResult").length, 1);
    assert.equal(replacementCalls.filter(call =>
      call.prompt.includes("FRESH INDEPENDENT REPLACEMENT REVIEWER") &&
      call.lastRole === "toolResult").length, 1);
    assert.equal(execFileSync("git", ["status", "--porcelain"],
      { cwd: replacementJob.worktreeRoot, encoding: "utf8" }).trim(), "");

    // Three real material corrections in the original read-only sessions.
    productiveJobId = randomUUID();
    const productiveDb = new DatabaseSync(join(app, "studio.sqlite"));
    try { productiveDb.prepare("INSERT INTO studio_sessions VALUES (?,?,?,?,?)")
      .run(productiveJobId, owner, "story", head, null); } finally { productiveDb.close(); }
    const productiveJob = await startStoryJob({ story, job: productiveJobId, worktreeCacheRoot: scoped });
    const productiveCalls: Call[] = [];
    const productiveRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    productiveRuntime.registerNativeProvider(scripted(productiveCalls, "escalate", false, false, true, true));
    await productiveRuntime.refresh({ allowNetwork: false });
    await configurePiPolicy(productiveJob, { version: 1, profile: { provider: model.provider, model: model.id },
      limits: { modelCalls: 30 } });
    const material = await withJobModelRuntime(productiveRuntime, () =>
      withStoryJobLock(productiveJob, "event-sample", () => ensureMilestoneBlueprint(productiveJob,
        plan, assignment, snapshot, model.provider, model.id, task, head, false)));
    const materialReceipt = JSON.parse(readFileSync(join(productiveJob.stateDir, "milestone-blueprints", "sample.json"), "utf8"));
    assert.deepEqual(materialReceipt.rounds.map((r: any) => r.review.status), ["revise", "revise", "revise", "pass"]);
    assert.equal(new Set(materialReceipt.rounds.map((r: any) => r.draftDigest)).size, 4);
    assert.equal(materialReceipt.reviewerHistory?.length ?? 0, 0);
    assert.equal(materialReceipt.diagnostics?.length ?? 0, 0);
    assert.deepEqual(await readReviewedMilestoneBlueprint(productiveJob, material.pin, assignment), material.blueprint);
    assert.equal(productiveCalls.filter(c => c.prompt.includes("READ-ONLY LOCAL MILESTONE BLUEPRINT") && c.lastRole === "toolResult").length, 4);
    assert.equal(productiveCalls.filter(c => c.prompt.includes("READ-ONLY MILESTONE SOURCE-READ CORRECTION") && c.lastRole === "toolResult").length, 2);
    assert.ok(materialReceipt.writer.id !== materialReceipt.reviewer.id);
    assert.equal(productiveCalls.filter(c => c.prompt.includes("INDEPENDENT READ-ONLY MILESTONE PLAN REVIEW") && c.lastRole === "toolResult").length, 4);

    // A CONTINUE diagnosis must retain the exact original reviewer and writer
    // identities. One real field-specific correction then receives a v4 PASS
    // without allowing the diagnosis to assert its own approval.
    continuationJobId = randomUUID();
    const continuationDb = new DatabaseSync(join(app, "studio.sqlite"));
    try {
      continuationDb.prepare("INSERT INTO studio_sessions VALUES (?,?,?,?,?)")
        .run(continuationJobId, owner, "story", head, null);
    } finally { continuationDb.close(); }
    const continuingJob = await startStoryJob({
      story, job: continuationJobId, worktreeCacheRoot: scoped,
    });
    const continuingCalls: Call[] = [];
    const continuingRuntime = await ModelRuntime.create({
      modelsPath: null, refreshOnCreate: false,
    });
    continuingRuntime.registerNativeProvider(scripted(continuingCalls, "continue"));
    await continuingRuntime.refresh({ allowNetwork: false });
    await configurePiPolicy(continuingJob, {
      version: 1, profile: { provider: model.provider, model: model.id },
      limits: { modelCalls: 24 },
    });
    const continueRun = () => withJobModelRuntime(continuingRuntime, () =>
      withStoryJobLock(continuingJob, "event-sample", () =>
        ensureMilestoneBlueprint(continuingJob, plan, assignment, snapshot,
          model.provider, model.id, task, head, false)));
    const continuedResult = await continueRun();
    assert.equal((await readReviewedMilestoneBlueprint(continuingJob,
      continuedResult.pin, assignment)).milestoneId, milestoneId);
    const continued = await inspectMilestoneBlueprint(continuingJob, milestoneId);
    assert.equal(continued?.phase, "approved");
    assert.equal(continued?.rounds, 4);
    assert.equal(continued?.diagnostic?.action, "continue");
    const continuingReceipt = JSON.parse(readFileSync(join(continuingJob.stateDir,
      "milestone-blueprints", "sample.json"), "utf8")) as {
        writer: { id: string };
        reviewer: { id: string };
        reviewerHistory?: unknown[];
        rounds: Array<{ review: { status: string } }>;
      };
    assert.deepEqual(continuingReceipt.rounds.map(round => round.review.status),
      ["revise", "revise", "revise", "pass"]);
    assert.equal(continuingReceipt.reviewerHistory, undefined);
    assert.notEqual(continuingReceipt.writer.id, continuingReceipt.reviewer.id);
    assert.equal(continuingCalls.filter(call =>
      call.prompt.includes("READ-ONLY LOCAL MILESTONE BLUEPRINT") &&
      call.lastRole === "toolResult").length, 4);
    assert.equal(continuingCalls.filter(call =>
      call.prompt.includes("INDEPENDENT READ-ONLY MILESTONE PLAN REVIEW") &&
      call.lastRole === "toolResult").length, 4);
    assert.equal(continuingCalls.filter(call =>
      call.prompt.includes("FRESH INDEPENDENT READ-ONLY MILESTONE REVIEW DIAGNOSTIC") &&
      call.lastRole === "toolResult").length, 1);
    assert.equal(execFileSync("git", ["status", "--porcelain"],
      { cwd: continuingJob.worktreeRoot, encoding: "utf8" }).trim(), "");

    // The first CONTINUE produces a different still-negative evidence state.
    // A second independent diagnosis also recommends CONTINUE; its writer
    // turn must execute before unchanged-round stagnation is considered again.
    secondCaseJobId = randomUUID();
    const secondDb = new DatabaseSync(join(app, "studio.sqlite"));
    try {
      secondDb.prepare("INSERT INTO studio_sessions VALUES (?,?,?,?,?)")
        .run(secondCaseJobId, owner, "story", head, null);
    } finally { secondDb.close(); }
    const secondJob = await startStoryJob({
      story, job: secondCaseJobId, worktreeCacheRoot: scoped,
    });
    const secondCalls: Call[] = [];
    const secondRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    secondRuntime.registerNativeProvider(scripted(secondCalls, "continue", true));
    await secondRuntime.refresh({ allowNetwork: false });
    await configurePiPolicy(secondJob, {
      version: 1, profile: { provider: model.provider, model: model.id },
      limits: { modelCalls: 48 },
    });
    const secondRun = () => withJobModelRuntime(secondRuntime, () =>
      withStoryJobLock(secondJob, "event-sample", () =>
        ensureMilestoneBlueprint(secondJob, plan, assignment, snapshot,
          model.provider, model.id, task, head, false)));
    await secondRun();
    const secondReceipt = JSON.parse(readFileSync(join(secondJob.stateDir,
      "milestone-blueprints", "sample.json"), "utf8")) as {
        phase: string; rounds: unknown[]; diagnostics: Array<{ diagnosis: { action: string } }>;
      };
    assert.equal(secondReceipt.phase, "approved");
    assert.equal(secondReceipt.diagnostics.length, 2,
      "two distinct stalled evidence states each receive one fresh diagnosis");
    assert.deepEqual(secondReceipt.diagnostics.map(d => d.diagnosis.action),
      ["continue", "continue"]);
    assert.equal(secondReceipt.rounds.length, 6,
      "the original writer receives its turn after the second diagnosis");
    assert.equal(secondCalls.filter(call =>
      call.prompt.includes("FRESH INDEPENDENT READ-ONLY MILESTONE REVIEW DIAGNOSTIC") &&
      call.lastRole === "toolResult").length, 2);

      // #227: the independent reviewer rejects a false Interactive owner, then
      // continues the SAME sealed review session after the planner removes it.
      // The Story source/HEAD is never mutated by provisional planning.
      downstreamJobId = randomUUID();
      const downstreamDb = new DatabaseSync(join(app, "studio.sqlite"));
      try {
        downstreamDb
          .prepare("INSERT INTO studio_sessions VALUES (?,?,?,?,?)")
          .run(downstreamJobId, owner, "story", head, null);
      } finally {
        downstreamDb.close();
      }
      const downstreamJob = await startStoryJob({
        story,
        job: downstreamJobId,
        worktreeCacheRoot: scoped,
      });
      const downstreamCalls: Call[] = [];
      const downstreamRuntime = await ModelRuntime.create({
        modelsPath: null,
        refreshOnCreate: false,
      });
      downstreamRuntime.registerNativeProvider(scripted(downstreamCalls, "escalate", false, true));
      await downstreamRuntime.refresh({ allowNetwork: false });
      await configurePiPolicy(downstreamJob, {
        version: 1,
        profile: { provider: model.provider, model: model.id },
        // Two source-reading turns each for the initial writer and independent
        // reviewer. Stop after the first negative verdict, before correction.
        limits: { modelCalls: 4 },
      });
      const downstreamRun = () =>
        withJobModelRuntime(downstreamRuntime, () =>
          withStoryJobLock(downstreamJob, "event-sample", () =>
            ensureMilestoneBlueprint(
              downstreamJob,
              plan,
              assignment,
              snapshot,
              model.provider,
              model.id,
              task,
              head,
              false,
            ),
          ),
        );
      await assert.rejects(downstreamRun(), (error: unknown) =>
        error instanceof PiBudgetPause && error.reason === "modelCalls");
      const rejected = await inspectMilestoneBlueprint(downstreamJob, milestoneId);
      assert.equal(rejected?.phase, "revision");
      assert.equal(rejected?.rounds, 1);
      assert.equal(rejected?.lastVerdict, "revise",
        "the original false Interactive owner must not pass initial independent review");
      const deniedFile = join(downstreamJob.stateDir, "milestone-blueprints", "sample.json");
      const deniedReceipt = JSON.parse(readFileSync(deniedFile, "utf8")) as {
        writer: { id: string }; reviewer: { id: string }; rounds: Array<{
          draft: MilestoneBlueprint; review: { findings: unknown[] };
        }>;
      };
      assert.notEqual(deniedReceipt.writer.id, deniedReceipt.reviewer.id);
      assert.equal(deniedReceipt.rounds[0]?.draft.downstream[0]?.owner, "interactive");
      assert.equal(deniedReceipt.rounds[0]?.review.findings.length, 1);
      const callsBeforeRestart = downstreamCalls.length;
      assert.equal((await inspectPiPolicy(downstreamJob)).budget.modelCalls, 4);
      assert.equal(execFileSync("git", ["status", "--porcelain"], {
        cwd: downstreamJob.worktreeRoot, encoding: "utf8",
      }).trim(), "", "initial rejected plan cannot authorize a canonical Event writer");
      await configurePiPolicy(downstreamJob, {
        version: 1, profile: { provider: model.provider, model: model.id },
        limits: { modelCalls: 12 },
      });
      const downstreamApproved = await downstreamRun();
      assert.equal(downstreamCalls.length - callsBeforeRestart, 4,
        "resume performs one source-reading correction and one rereview, not a replacement operation");
      assert.equal((await inspectPiPolicy(downstreamJob)).budget.modelCalls, 8,
        "raising a budget preserves all four original model responses");
      assert.deepEqual(downstreamApproved.blueprint.downstream, draft.downstream);
      assert.deepEqual(
        (await readReviewedMilestoneBlueprint(downstreamJob, downstreamApproved.pin, assignment)).downstream,
        draft.downstream,
      );
      const downstreamFile = join(downstreamJob.stateDir, "milestone-blueprints", "sample.json");
      const downstreamSealed = readFileSync(downstreamFile, "utf8");
      const record = JSON.parse(downstreamSealed) as {
        phase: string;
        reviewer: { id: string };
        reviewerHistory?: unknown[];
        rounds: Array<{
          draft: MilestoneBlueprint;
          review: {
            schema: string;
            status: string;
            findings: unknown[];
          };
        }>;
      };
      assert.equal(record.phase, "approved");
      assert.deepEqual(
        record.rounds.map((round) => round.review.status),
        ["revise", "pass"],
      );
      assert.equal(record.rounds[0]?.review.schema, "noveltea-milestone-blueprint-review/v5");
      assert.deepEqual(record.rounds[0]?.review.findings[0], {
        anchorPath: milestonePath,
        requirement: "Only positively required current-Milestone Interactive work has an Interactive owner",
        reason: "The declared Interactive owner is a negative instruction, not required work",
        correction: "Remove the false Interactive owner and retain required Composition work",
        evidence: {
          target: "downstream",
          index: 0,
          field: "obligation",
          quote: "No Choice or Puzzle is required for this current Milestone",
          repair: "replace",
        },
      });
      assert.equal(record.reviewerHistory, undefined, "reviewer never replaced");
      assert.equal(record.reviewer.id, deniedReceipt.reviewer.id,
        "post-pause correction retains the initial independent reviewer");
      assert.equal(JSON.parse(downstreamSealed).writer.id, deniedReceipt.writer.id,
        "post-pause correction retains the original planner");
      assert.equal(
        downstreamCalls.filter(
          (call) =>
            call.prompt.includes("INDEPENDENT READ-ONLY MILESTONE PLAN REVIEW") &&
            call.lastRole === "toolResult",
        ).length,
        2,
      );
      const completedCalls = downstreamCalls.length;
      assert.equal((await downstreamRun()).pin.digest, downstreamApproved.pin.digest);
      assert.equal(
        downstreamCalls.length,
        completedCalls,
        "restart must reuse the exact reviewed approval without model replay",
      );
      const forged = JSON.parse(downstreamSealed) as typeof record;
      forged.rounds[0]!.draft.downstream[0]!.obligation = "A forged earlier claim";
      writeFileSync(downstreamFile, JSON.stringify(forged));
      await assert.rejects(
        readReviewedMilestoneBlueprint(downstreamJob, downstreamApproved.pin, assignment),
        /evidence changed|sealed|provenance|cited downstream/,
      );
      writeFileSync(downstreamFile, downstreamSealed);
      assert.equal(
        execFileSync("git", ["status", "--porcelain"], {
          cwd: downstreamJob.worktreeRoot,
          encoding: "utf8",
        }).trim(),
        "",
      );
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    if (controller && downstreamJobId) await controller.dispose(downstreamJobId);
    if (controller && secondCaseJobId) await controller.dispose(secondCaseJobId);
    if (controller && continuationJobId) await controller.dispose(continuationJobId);
    if (controller && productiveJobId) await controller.dispose(productiveJobId);
    if (controller && replacementJobId) await controller.dispose(replacementJobId);
    if (controller && jobId) await controller.dispose(jobId);
    if (server) await new Promise<void>(done => server!.close(() => done()));
    await removeTestTree(tmp);
  }
});
