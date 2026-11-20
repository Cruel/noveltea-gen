/** #202: deterministic model replies through the production Blueprint admission,
 * read-only Pi sessions, source checks, correction and immutable approval. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream, type AssistantMessage, type Model,
  type Provider, type TranscriptContext, type SimpleStreamOptions, type ToolCall,
} from "@earendil-works/pi-ai";
import { createControllerServer, SandboxController, type ControllerConfig } from "../web/src/sandbox-controller.js";
import { createReviewedBlueprint, readApprovedBlueprint, type BlueprintReview } from "../src/architecture-blueprint.js";
import { blueprintDigest } from "../src/architecture-blueprint-patch.js";
import { captureBlueprintReplay } from "../src/execution-replay-blueprint.js";
import type { Plan } from "../src/architecture.js";
import { startStoryJob } from "../src/job.js";
import { withStoryJobLock } from "../src/job-lock.js";
import { configurePiPolicy, inspectPiPolicy, PiBudgetPause } from "../src/job-pi-policy.js";
import { withJobModelRuntime } from "../src/model-runtime.js";
import { createSkillSnapshot } from "../src/snapshot.js";
import { removeTestTree } from "./helpers.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const model: Model = {
  id: "scripted-202", name: "Scripted Blueprint #202", provider: "cert-202",
  api: "cert-202-api", baseUrl: "http://not-used.invalid", input: ["text"],
  reasoning: false, contextWindow: 128_000, maxTokens: 16_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const usage: AssistantMessage["usage"] = {
  input: 20, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 40,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const foundation = "A missing clerk was secretly sheltered. Prove the truth from dated records without exposing the protected witness.\n";
const task = "Plan a source-grounded mystery with independent proof of the missing clerk's refuge";
const answer = {
  question: "Where did the clerk go?",
  answer: "The clerk reached a secure shelter through the service gate.",
  mechanism: "A shelter operator opened a documented service gate to admit the clerk.",
  responsibility: "The shelter operator registered the clerk under a protected alias.",
  motive: "The operator prevented a creditor from discovering the clerk's refuge.",
  misdirection: { signal: "A copied town departure entry",
    falseInference: "The clerk left town by train",
    actualExplanation: "The entry copied the shelter's protective registration" },
  proof: { directTest: "Read the service gate's dated entry log",
    corroboration: "Compare the independent guard shift register",
    refusalFallback: "Both records remain available without witness testimony",
    beatIds: ["archive"] },
};
const header = {
  schema: "noveltea-causal-outline-header/v1", premise: "Protect a missing clerk",
  beatIds: ["arrival", "archive"],
  resolution: { question: "Where did the clerk go?",
    conclusion: "The shelter's two independent records establish the clerk's safe arrival",
    supportedBy: ["archive"], uncertainty: "The source's identity remains protected" },
  causalAnswer: answer,
};
const beats = [
  { id: "arrival", purpose: "Find the first dated trail", dependsOn: [],
    change: "A dated departure entry establishes when the clerk went missing", decisions: [] },
  { id: "archive", purpose: "Check the independent shelter evidence", dependsOn: ["arrival"],
    change: "The dated gate and shift logs confirm entry without witness testimony", decisions: [] },
];
const evidence = [
  { id: "arrival", observations: [{ source: "town register",
    observable: "A departure entry was entered at dusk", supports: "The clerk departed",
    limits: "Does not independently corroborate the departure" }] },
  { id: "archive", observations: [{ source: "shelter gate ledger",
    observable: "An entry records a protected arrival at dusk",
    supports: "The clerk entered the shelter", limits: "Does not independently prove motive" }] },
];
const obligation = {
  id: "proof-without-exposure", category: "route", source: "foundation",
  quote: "without exposing the protected witness",
  question: "Can players resolve the disappearance without exposing the witness?",
  proof: "Match the dated service-gate and shift logs",
  route: "Independent records remain available when testimony is refused",
  beatIds: ["arrival", "archive"],
};
const negative: BlueprintReview = {
  schema: "noveltea-blueprint-review/v2", status: "revise", prior: [],
  findings: [{ beatId: "arrival", origin: "initial",
    requirement: { source: "foundation", quote: "Prove the truth from dated records" },
    evidence: { beatId: "arrival", quote: "A departure entry was entered at dusk" },
    reason: "The arrival timeline relies on an uncorroborated town entry.",
    correction: "Append an independent dated shift record corroborating arrival." }],
};
const progress = (round: number, beatId: "arrival" | "archive", quote: string) => ({
  round, findingIndex: 0, status: "resolved" as const,
  reason: "Independently inspectable new records resolve this exact prior blocker.",
  evidence: { beatId, quote },
});
const progress0 = progress(0, "arrival", "Guard signed a separate dusk service-gate patrol entry");
const progress1 = progress(1, "archive", "Guard ledger separately records a protected arrival");
const progress2 = progress(2, "archive", "Registrar ledger connects the independent shift and gate entries");
const negative1: BlueprintReview = { schema: "noveltea-blueprint-review/v2",
  status: "revise",
  prior: [progress0],
  findings: [{ beatId: "archive", origin: "overlooked",
    requirement: { source: "foundation", quote: "Prove the truth from dated records" },
    evidence: { beatId: "archive", quote: "An entry records a protected arrival at dusk" },
    reason: "The arrival's gate log is not independently cross-checked.",
    correction: "Add a separate guard ledger entry to the archive beat." }],
};
const negative2: BlueprintReview = { schema: "noveltea-blueprint-review/v2",
  status: "revise", prior: [progress0, progress1],
  findings: [{ beatId: "archive", origin: "introduced",
    requirement: { source: "foundation", quote: "Prove the truth from dated records" },
    evidence: { beatId: "archive", quote: "Guard ledger separately records a protected arrival" },
    reason: "The newly introduced record needs a linking registrar entry.",
    correction: "Add the registrar's independent link between both dated logs." }],
};
const positive: BlueprintReview = { schema: "noveltea-blueprint-review/v2",
  status: "pass", findings: [], prior: [progress0, progress1, progress2] };
const stillBlocked = (round: number) => ({
  round, findingIndex: 0, status: "persisting" as const,
  reason: "The timeline still relies on the same uncorroborated source.",
  evidence: { beatId: "arrival", quote: "A departure entry was entered at dusk" },
});
const stalled1: BlueprintReview = { schema: "noveltea-blueprint-review/v2",
  status: "revise", prior: [stillBlocked(0)], findings: [
    { ...negative.findings[0]!, origin: "continuing" },
  ] };
const stalled2: BlueprintReview = { schema: "noveltea-blueprint-review/v2",
  status: "revise", prior: [stillBlocked(0), stillBlocked(1)], findings: [
    { ...negative.findings[0]!, origin: "continuing" },
  ] };
const oldChange = beats[0]!.change;
const noisyChange = oldChange + " with decorative, irrelevant additional descriptive words";
const stalledPatches = [
  { kind: "replace", findingBeatId: "arrival",
    path: "beats/arrival/change", expected: oldChange, value: noisyChange },
  { kind: "replace", findingBeatId: "arrival",
    path: "beats/arrival/change", expected: noisyChange, value: oldChange },
];
const corrections = [
  { kind: "append-observation", findingBeatId: "arrival",
    beatId: "arrival", value: { source: "independent guard shift log",
      observable: progress0.evidence.quote,
      supports: "Corroborates arrival timing independently of the town entry",
      limits: "Does not disclose the protected source identity" } },
  { kind: "append-observation", findingBeatId: "archive",
    beatId: "archive", value: { source: "independent patrol log",
      observable: progress1.evidence.quote,
      supports: "Corroborates the initial gate evidence independently",
      limits: "Still does not determine who completed the registration" } },
  { kind: "append-observation", findingBeatId: "archive",
    beatId: "archive", value: { source: "independent registrar archive",
      observable: progress2.evidence.quote,
      supports: "Proves the causal chain between the dated sources",
      limits: "Does not expose the protected witness" } },
];
const readCalls = (): ToolCall[] => [
  "skill://nt-story-architecture/SKILL.md",
  "skill://nt-catalog/SKILL.md",
  "creative-direction/foundation.md",
].map((path, i) => ({ type: "toolCall", id: "source-read-" + randomUUID() + "-" + i,
  name: "read", arguments: { path } }));
const asText = (s: string): AssistantMessage["content"] => [{ type: "text", text: s }];
function promptText(messages: readonly unknown[]): string {
  const users = messages.filter((m): m is { role: "user"; content: unknown } =>
    !!m && typeof m === "object" && "role" in m && m.role === "user");
  return JSON.stringify(users.at(-1)?.content ?? "");
}
type Call = { prompt: string; tools: string[]; messages: readonly unknown[]; lastRole: string };
function scripted(calls: Call[], scenario: "productive" | "stalled" = "productive"): Provider {
  let reviewerRound = 0;
  let writerRound = 0;
  let protocolRepaired = false;
  const verdicts = scenario === "productive"
    ? [negative, negative1, negative2, positive]
    : [negative, stalled1, stalled2];
  const writerPatches = scenario === "productive" ? corrections : stalledPatches;
  const stream = (_model: Model, ctx: TranscriptContext, _options?: SimpleStreamOptions) => {
    const result = createAssistantMessageEventStream();
    const active = new Set<string>();
    for (const m of ctx.messages) {
      if (m.role !== "system") continue;
      for (const t of m.toolsAdded ?? []) active.add(t.name);
      for (const t of m.toolsRemoved ?? []) active.delete(t.name);
    }
    const prompt = promptText(ctx.messages);
    const lastRole = ctx.messages.at(-1)?.role ?? "";
    const reviewer = prompt.includes("INDEPENDENT, READ-ONLY CAUSAL ARCHITECTURE BLUEPRINT REVIEWER");
    calls.push({ prompt, tools: [...active], messages: structuredClone(ctx.messages), lastRole });
    const needRead = (prompt.includes("READ-ONLY CAUSAL STORY ARCHITECT") || reviewer) &&
      lastRole !== "toolResult";
    let content: AssistantMessage["content"];
    let reason: "stop" | "toolUse" = "stop";
    if (needRead) { content = readCalls(); reason = "toolUse"; }
    else if (prompt.includes("READ-ONLY CAUSAL STORY ARCHITECT")) content = asText(JSON.stringify(header));
    else if (prompt.includes("READ-ONLY CAUSAL BEAT DETAIL STAGE"))
      content = asText(beats.map(v => JSON.stringify(v)).join("\n"));
    else if (prompt.includes("READ-ONLY CAUSAL BLUEPRINT EVIDENCE STAGE"))
      content = asText(evidence.map(v => JSON.stringify(v)).join("\n"));
    else if (prompt.includes("READ-ONLY SOURCE-GROUNDED CAUSAL OBLIGATION INVENTORY"))
      content = asText(JSON.stringify(obligation));
    else if (reviewer) {
      const round = reviewerRound++;
      // Round 2 intentionally violates the response contract once. Its
      // correction must not count as a new semantic revision.
      content = asText(JSON.stringify(scenario === "productive" && round === 2
        ? { schema: "noveltea-blueprint-review/v2", status: "revise", findings: [], prior: [] }
        : verdicts[round]));
    } else if (prompt.includes("CONTROLLER REJECTED YOUR REVIEW PROTOCOL")) {
      assert.equal(protocolRepaired, false);
      protocolRepaired = true;
      content = asText(JSON.stringify(negative2));
    } else if (prompt.includes("INDEPENDENT CAUSAL REVIEW.") ||
        prompt.includes("RESUME AT VERIFIED CAUSAL BLUEPRINT WRITER BOUNDARY.")) {
      const match = /BASE DIGEST: ([a-f0-9]{64}) REVIEW DIGEST: ([a-f0-9]{64})/.exec(prompt);
      assert.ok(match, "the controller must give the exact previous source/verdict digests");
      const correction = writerPatches[writerRound++];
      assert.ok(correction, "writer must only perform the authorized corrections");
      content = asText([
        JSON.stringify({ schema: "noveltea-blueprint-patch/v1",
          baseDigest: match[1], reviewDigest: match[2] }),
        JSON.stringify(correction),
      ].join("\n"));
    } else throw Error("Unexpected scripted Blueprint Pi prompt: " + prompt.slice(0, 160));
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider,
      model: model.id, content, usage, stopReason: reason, timestamp: Date.now() };
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
    id: model.provider, name: "Deterministic Blueprint certification",
    auth: { apiKey: { name: "Local scripted auth",
      check: async () => ({ type: "api_key", source: "test" }),
      resolve: async () => ({ auth: { apiKey: "local-script-only" } }) } },
    getModels: () => [model], stream, streamSimple: stream,
  };
}
function available() {
  try {
    const security = JSON.parse(execFileSync("docker", ["info", "--format", "{{json .SecurityOptions}}"],
      { encoding: "utf8", timeout: 8000 })) as string[];
    if (!security.some(v => /(^|=)rootless$/.test(v))) return false;
    execFileSync("docker", ["image", "inspect", "noveltea-sandbox:local"],
      { stdio: "ignore", timeout: 8000 });
    return existsSync(resolve("../noveltea-skills/skills/nt-story-architecture/SKILL.md"));
  } catch { return false; }
}

test("#202/#203: production Blueprint review converges after three revisions, protocol repair and a safe budget resume", {
  skip: !available() && "Requires registered rootless sandbox and local noveltea-skills",
  timeout: 240_000,
}, async () => {
  const tmp = mkdtempSync(join(tmpdir(), "nt-202-production-"));
  const id = randomUUID();
  const keys = ["NT_STATE_DIR", "NT_GIT_CACHE_DIR", "NT_SKILL_CACHE_DIR",
    "NT_CONFIG_FILE", "NT_SANDBOX_SOCKET", "NT_SANDBOX_TOKEN_FILE",
    "NT_REQUIRE_SANDBOX_TOOLS", "NT_REQUIRE_USER_PI_RUNTIME"] as const;
  const old = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  let controller: SandboxController | undefined;
  let stalledJobId: string | undefined;
  let server: ReturnType<typeof createControllerServer> | undefined;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  try {
    const app = join(tmp, "app"), state = join(tmp, "state"), cache = join(tmp, "cache");
    const socketDir = join(tmp, "controller"), source = resolve("../noveltea-skills");
    for (const dir of [app, state, cache, socketDir]) mkdirSync(dir, { recursive: true });
    const owner = "protocol-202-owner", repositoryId = "protocol-202-repo";
    const scoped = join(cache, hash(owner), hash("github:" + repositoryId));
    const repo = join(scoped, "base"), story = join(repo, "story");
    mkdirSync(join(story, "creative-direction"), { recursive: true });
    writeFileSync(join(story, "creative-direction/foundation.md"), foundation);
    git(repo, "init", "-q"); git(repo, "config", "user.name", "Author");
    git(repo, "config", "user.email", "author@example.test");
    git(repo, "add", "."); git(repo, "commit", "-qm", "Source Story");
    const baseSha = git(repo, "rev-parse", "HEAD");
    const db = new DatabaseSync(join(app, "studio.sqlite"));
    try {
      db.exec("CREATE TABLE studio_sessions (id TEXT, owner_user_id TEXT, story_id TEXT, source_commit_sha TEXT, generation_config_json TEXT);" +
        "CREATE TABLE stories (id TEXT, owner_user_id TEXT, repository_id TEXT, directory TEXT);" +
        "CREATE TABLE repositories (id TEXT, owner_user_id TEXT, provider TEXT, provider_repository_id TEXT);");
      db.prepare("INSERT INTO repositories VALUES (?,?,?,?)").run("repo", owner, "github", repositoryId);
      db.prepare("INSERT INTO stories VALUES (?,?,?,?)").run("story", owner, "repo", "story");
      db.prepare("INSERT INTO studio_sessions VALUES (?,?,?,?,?)").run(id, owner, "story", baseSha, null);
    } finally { db.close(); }
    writeFileSync(join(tmp, "skills-config.json"), JSON.stringify({
      novelteaSkills: source, skillDiscovery: "explicit-only", requiredSkills: [], skillDirs: [],
    }));
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
      NT_STATE_DIR: state, NT_GIT_CACHE_DIR: scoped, NT_SKILL_CACHE_DIR: join(tmp, "skills"),
      NT_CONFIG_FILE: join(tmp, "skills-config.json"),
      NT_SANDBOX_SOCKET: config.socket, NT_SANDBOX_TOKEN_FILE: tokenFile,
      NT_REQUIRE_SANDBOX_TOOLS: "1", NT_REQUIRE_USER_PI_RUNTIME: "1",
    });
    const job = await startStoryJob({ story, job: id, worktreeCacheRoot: scoped });
    const plan: Plan = {
      version: 1, items: [], contract: {
        scope: { kind: "full-story", depth: "architecture", targets: [], branches: [] },
        constraints: [], envelope: { presentation: "text", hardLimits: [], preferences: [] },
      },
    };
    const snapshot = await createSkillSnapshot({
      discovery: "explicit-only", novelteaSkills: source, skillDirs: [],
      requiredSkills: ["nt-story-architecture", "nt-catalog"],
    });
    assert.ok(snapshot);
    const calls: Call[] = [];
    const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(scripted(calls));
    await runtime.refresh({ allowNetwork: false });
    const create = () => withJobModelRuntime(runtime, () =>
      withStoryJobLock(job, "global-architecture", () =>
        createReviewedBlueprint(job, snapshot, plan, model.provider, model.id, task, baseSha)));
    await configurePiPolicy(job, { version: 1,
      profile: { provider: model.provider, model: model.id }, limits: { modelCalls: 7 } });
    await assert.rejects(create(), (error: unknown) =>
      error instanceof PiBudgetPause && error.reason === "modelCalls",
      "seven scripted planner/review calls must pause BEFORE the next writer turn");
    assert.equal((await inspectPiPolicy(job)).budget.pause?.reason, "modelCalls");
    const directory = join(job.stateDir, "architecture-blueprints");
    assert.ok(existsSync(join(directory, "plan-1-pause-1-writer.json")));
    assert.equal(existsSync(join(directory, "plan-1-approved.json")), false);
    await configurePiPolicy(job, { version: 1,
      profile: { provider: model.provider, model: model.id }, limits: { modelCalls: 8 } });
    await assert.rejects(create(), (error: unknown) =>
      error instanceof PiBudgetPause && error.reason === "modelCalls",
      "the completed writer patch should pause before a new reviewer turn");
    assert.ok(existsSync(join(directory, "plan-1-pause-1-review.json")));
    assert.ok(existsSync(join(directory, "plan-1-draft-1.json")),
      "paused review must retain the completed, verified patch");
    assert.equal(existsSync(join(directory, "plan-1-verdict-1.json")), false,
      "no new verdict was started when the budget paused");
    assert.equal((await inspectPiPolicy(job)).budget.modelCalls, 8);
    await configurePiPolicy(job, { version: 1,
      profile: { provider: model.provider, model: model.id }, limits: { modelCalls: 60 } });
    const pausedWriter = JSON.parse(readFileSync(join(directory,
      "plan-1-pause-1-review.json"), "utf8")).pin as { plannerSessionFile: string };
    const pausedTranscript = readFileSync(pausedWriter.plannerSessionFile);
    try {
      writeFileSync(pausedWriter.plannerSessionFile, Buffer.concat([
        pausedTranscript, Buffer.from('{"type":"message","message":{"role":"user","content":"Unsealed replay"}}\\n'),
      ]));
      await assert.rejects(create(), /session changed after its safe budget pause/,
        "a post-pause writer turn must never be replayed as if the writer were idle");
    } finally { writeFileSync(pausedWriter.plannerSessionFile, pausedTranscript); }
    const pin = await create();
    assert.equal(pin.schema, "noveltea-approved-blueprint/v4");
    assert.equal(pin.draftVersion, 3, "three productive corrections must pass without fixed attempt exhaustion");
    assert.equal((await inspectPiPolicy(job)).budget.pause, undefined);
    assert.notEqual(pin.plannerSessionId, pin.reviewerSessionId);
    assert.notEqual(pin.plannerSessionFile, pin.reviewerSessionFile);
    const receipt = (index: number) => JSON.parse(readFileSync(
      join(directory, "plan-1-review-session-" + index + ".json"), "utf8"));
    const first = receipt(0), second = receipt(1);
    for (let i = 1; i <= 3; i++) {
      assert.equal(receipt(i).sessionId, first.sessionId);
      assert.equal(receipt(i).sessionFile, first.sessionFile);
      assert.equal(receipt(i).cycleId, pin.reviewCycleId);
      assert.ok(receipt(i).transcriptBytes > receipt(i - 1).transcriptBytes);
      assert.equal(JSON.parse(readFileSync(join(directory,
        "plan-1-convergence-" + i + ".json"), "utf8")).productive, true);
    }
    assert.equal(hash(readFileSync(pin.reviewerSessionFile).subarray(
      0, first.transcriptBytes).toString("utf8")), first.transcriptDigest);
    for (const [i, verdict] of [negative, negative1, negative2, positive].entries())
      assert.deepEqual(JSON.parse(readFileSync(join(directory,
        "plan-1-verdict-" + i + ".json"), "utf8")), verdict);
    const reviews = calls.filter(c =>
      c.prompt.includes("INDEPENDENT, READ-ONLY CAUSAL ARCHITECTURE BLUEPRINT REVIEWER"));
    assert.equal(reviews.length, 8, "all four semantic rounds must reread source before verdict");
    assert.equal(reviews.filter(c => c.lastRole === "toolResult").length, 4);
    assert.equal(calls.filter(c =>
      c.prompt.includes("CONTROLLER REJECTED YOUR REVIEW PROTOCOL")).length, 1,
      "malformed structured review receives bounded protocol correction, not another semantic round");
    assert.match(reviews[2]!.prompt, /PREVIOUS VERIFIED VERDICT/);
    assert.match(reviews[2]!.prompt, /EXACT SOURCE CHANGES/);
    assert.match(reviews[2]!.prompt, /CONTINUING YOUR EXISTING INDEPENDENT REVIEW CYCLE/);
    assert.match(JSON.stringify(reviews[2]!.messages), /uncorroborated town entry/,
      "second review must retain the first verdict and the same session analysis");
    for (const review of reviews) {
      assert.ok(review.tools.includes("read"), "pinned source reads use the real sandbox tool");
      assert.ok(review.tools.every(name => !["write", "edit", "bash", "exec"].includes(name)),
        "the reviewer must never be granted Story mutation tools");
    }
    assert.equal((await readApprovedBlueprint(job, plan, snapshot,
      model.provider, model.id, task, baseSha))?.pin.reviewCycleId, pin.reviewCycleId);
    const replay = captureBlueprintReplay(directory, 1, 3, "blueprint-review-verdict",
      join(tmp, "iteration-3-review-replay.json"));
    assert.ok(replay, "offline replay must accept a third productive correction");
    const count = calls.length;
    assert.deepEqual(await create(), pin, "approved replay never invokes Pi again");
    assert.equal(calls.length, count);
    await assert.rejects(readApprovedBlueprint(
      { ...job, threadId: "different-thread" }, plan, snapshot,
      model.provider, model.id, task, baseSha), /stale|scope|bound/);
    await assert.rejects(readApprovedBlueprint(job, { ...plan,
      contract: { ...plan.contract, constraints: ["Unauthorized scope change"] } },
    snapshot, model.provider, model.id, task, baseSha), /stale|scope|bound/);
    const receiptFile = join(directory, "plan-1-review-session-1.json");
    const receiptBytes = readFileSync(receiptFile);
    try {
      writeFileSync(receiptFile, JSON.stringify({ ...second, sessionId: pin.plannerSessionId }));
      await assert.rejects(readApprovedBlueprint(job, plan, snapshot,
        model.provider, model.id, task, baseSha), /review provenance|session/);
    } finally { writeFileSync(receiptFile, receiptBytes); }
    const foundationFile = join(job.worktreeStoryRoot, "creative-direction/foundation.md");
    try {
      writeFileSync(foundationFile, foundation + "Unexpected change to authorized Story source.\\n");
      await assert.rejects(readApprovedBlueprint(job, plan, snapshot,
        model.provider, model.id, task, baseSha), /proof obligations.*approved sources/);
    } finally { writeFileSync(foundationFile, foundation); }
    const originalTranscript = readFileSync(pin.reviewerSessionFile);
    try {
      const tampered = Buffer.from(originalTranscript);
      tampered[first.transcriptBytes - 5] = tampered[first.transcriptBytes - 5] === 65 ? 66 : 65;
      writeFileSync(pin.reviewerSessionFile, tampered);
      await assert.rejects(readApprovedBlueprint(job, plan, snapshot,
        model.provider, model.id, task, baseSha), /transcript changed/);
    } finally { writeFileSync(pin.reviewerSessionFile, originalTranscript); }
    assert.equal((await readApprovedBlueprint(job, plan, snapshot,
      model.provider, model.id, task, baseSha))?.pin.draftVersion, 3);
    assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "",
      "blueprint review cannot mutate canonical Story");
    assert.equal(git(repo, "rev-parse", "HEAD"), baseSha);

    // A separate real Job/Thread through the same production controller:
    // two valid writer patches first add cosmetic text, then return exactly
    // to the old draft. Both negative reviews remain source-grounded; the
    // controller must request reassessment without creating any approval.
    stalledJobId = randomUUID();
    const db2 = new DatabaseSync(join(app, "studio.sqlite"));
    try {
      db2.prepare("INSERT INTO studio_sessions VALUES (?,?,?,?,?)")
        .run(stalledJobId, owner, "story", baseSha, null);
    } finally { db2.close(); }
    const stuck = await startStoryJob({
      story, job: stalledJobId, worktreeCacheRoot: scoped,
    });
    const stuckCalls: Call[] = [];
    const stuckRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    stuckRuntime.registerNativeProvider(scripted(stuckCalls, "stalled"));
    await stuckRuntime.refresh({ allowNetwork: false });
    await assert.rejects(() => withJobModelRuntime(stuckRuntime, () =>
      withStoryJobLock(stuck, "global-architecture", () =>
        createReviewedBlueprint(stuck, snapshot, plan, model.provider, model.id, task, baseSha))),
    /requires independent reassessment after two nonproductive corrections/);
    const stuckDir = join(stuck.stateDir, "architecture-blueprints");
    assert.equal(existsSync(join(stuckDir, "plan-1-approved.json")), false);
    assert.equal(JSON.parse(readFileSync(join(stuckDir, "plan-1-convergence-1.json"),
      "utf8")).stalled, 1);
    const end = JSON.parse(readFileSync(join(stuckDir, "plan-1-convergence-2.json"), "utf8"));
    assert.equal(end.stalled, 2);
    assert.equal(end.oscillating, true);
    assert.equal(stuckCalls.filter(c =>
      c.prompt.includes("INDEPENDENT, READ-ONLY CAUSAL ARCHITECTURE BLUEPRINT REVIEWER") &&
      c.lastRole === "toolResult").length, 3);
    assert.equal(git(stuck.worktreeRoot, "status", "--porcelain"), "");
  } finally {
    for (const key of keys) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
    if (controller && stalledJobId) await controller.dispose(stalledJobId);
    if (controller) await controller.dispose(id);
    if (server) await new Promise<void>(done => server!.close(() => done()));
    await removeTestTree(tmp);
  }
});
