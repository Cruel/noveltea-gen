/** #206: production reviewer cycle with the actual sandbox, Pi transcript,
 * uncommitted Story worktree, source provenance and review-only privileges. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
  type Provider,
  type TranscriptContext,
  type SimpleStreamOptions,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {
  createControllerServer,
  SandboxController,
  type ControllerConfig,
} from "../web/src/sandbox-controller.js";
import {
  createArchitectureDraftReviewCycle,
  verifyArchitectureDraftReviewPin,
} from "../src/architecture-draft-review.js";
import type { Plan } from "../src/architecture.js";
import { startStoryJob } from "../src/job.js";
import { withStoryJobLock } from "../src/job-lock.js";
import { configurePiPolicy } from "../src/job-pi-policy.js";
import { withJobModelRuntime } from "../src/model-runtime.js";
import { createSkillSnapshot } from "../src/snapshot.js";
import { removeTestTree } from "./helpers.js";

const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const skillsSource = resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills");
const model: Model = {
  id: "scripted-206",
  name: "Scripted Architecture #206",
  provider: "cert-206",
  api: "cert-206-api",
  baseUrl: "http://not-used.invalid",
  input: ["text"],
  reasoning: false,
  contextWindow: 128_000,
  maxTokens: 16_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const usage: AssistantMessage["usage"] = {
  input: 20,
  output: 20,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 40,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const path = "milestones/arrival.md";
const foundation = "The player must have independent transfer evidence and preserve protected witnesses.\n";
const original = "The witness report gives no independent transfer evidence.\n";
const changes = [
  "A guard independently records the date of the transfer.",
  "A second gate register corroborates the guard's entry.",
  "After reconvergence, the player can protect the witness while filing the evidence.",
];
const evidence = (quote: string) => ({ path, quote });
const finding = (quote: string, origin: string) => ({
  path,
  reason: "The current causal proof still needs independent corroboration or route closure.",
  correction: "Improve the specific evidence chain and lasting player consequence within this Milestone.",
  requirement: { source: "foundation", quote: "independent transfer evidence" },
  evidence: evidence(quote),
  origin,
});
const prior = (round: number, quote: string) => ({
  round,
  findingIndex: 0,
  status: "resolved",
  reason: "The updated Milestone provides new testable causal proof.",
  evidence: evidence(quote),
});
const verdicts = [
  { findings: [finding("The witness report gives no independent transfer evidence.", "initial")], prior: [] },
  { findings: [finding(changes[0]!, "introduced")], prior: [prior(0, changes[0]!)] },
  { findings: [finding(changes[1]!, "introduced")], prior: [prior(0, changes[0]!), prior(1, changes[1]!)] },
  { findings: [], prior: [prior(0, changes[0]!), prior(1, changes[1]!), prior(2, changes[2]!)] },
].map((v) => ({
  schema: "noveltea-architecture-draft-review/v2",
  status: v.findings.length ? "revise" : "pass",
  ...v,
}));
const methodReads = [
  "skill://nt-story-architecture/SKILL.md",
  "skill://nt-catalog/SKILL.md",
  "creative-direction/foundation.md",
  path,
];
function promptText(messages: readonly unknown[]) {
  const users = messages.filter(
    (m): m is { role: "user"; content: unknown } =>
      !!m && typeof m === "object" && "role" in m && m.role === "user",
  );
  return JSON.stringify(users.at(-1)?.content ?? "");
}
type Call = { prompt: string; lastRole: string; active: string[]; messages: readonly unknown[] };
function scripted(calls: Call[], options?: { forbidden?: boolean; crash?: boolean; stall?: boolean }): Provider {
  let iteration = 0;
  let crashed = false;
  const stream = (_model: Model, ctx: TranscriptContext, _opts?: SimpleStreamOptions) => {
    const result = createAssistantMessageEventStream();
    const active = new Set<string>();
    for (const m of ctx.messages) {
      if (m.role !== "system") continue;
      for (const t of m.toolsAdded ?? []) active.add(t.name);
      for (const t of m.toolsRemoved ?? []) active.delete(t.name);
    }
    const prompt = promptText(ctx.messages);
    const lastRole = ctx.messages.at(-1)?.role ?? "";
    calls.push({ prompt, lastRole, active: [...active], messages: structuredClone(ctx.messages) });
    if (options?.crash && !crashed) {
      crashed = true;
      throw Error("Simulated interrupted precommit reviewer");
    }
    const reading = lastRole !== "toolResult";
    let content: AssistantMessage["content"];
    let reason: "stop" | "toolUse" = "stop";
    if (reading) {
      const sources = options?.forbidden ? [".story-inbox/ideas/private.yaml"] : methodReads;
      content = sources.map((target): ToolCall => ({
        type: "toolCall",
        id: randomUUID(),
        name: "read",
        arguments: { path: target },
      }));
      reason = "toolUse";
    } else {
      const isDiagnostic = prompt.includes("INDEPENDENT READ-ONLY ARCHITECTURE DIAGNOSTIC");
      const body = options?.stall
        ? isDiagnostic
          ? { schema: "noveltea-architecture-draft-diagnosis/v1", action: "escalate",
            explanation: "The unchanged uncorroborated evidence cannot pass independent review.",
            assessments: [{ kind: "material", reason: "The cited witness report still lacks corroboration.",
              requirement: { source: "foundation", quote: "independent transfer evidence" },
              evidence: evidence(original) }] }
          : { schema: "noveltea-architecture-draft-review/v2", status: "revise",
            findings: [finding(original, iteration ? "continuing" : "initial")],
            prior: Array.from({ length: iteration }, (_, round) => ({
              round, findingIndex: 0, status: "persisting",
              reason: "The same missing independent corroboration remains unresolved.",
              evidence: evidence(original),
            })) }
        : verdicts[iteration]!;
      iteration++;
      content = [{ type: "text", text: JSON.stringify(body) }];
    }
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
      content.forEach((part, i) => {
        if (part.type === "toolCall") {
          result.push({ type: "toolcall_start", contentIndex: i, partial: message });
          result.push({ type: "toolcall_end", contentIndex: i, toolCall: part, partial: message });
        } else if (part.type === "text") {
          result.push({ type: "text_start", contentIndex: i, partial: message });
          result.push({ type: "text_end", contentIndex: i, content: part.text, partial: message });
        }
      });
      result.push({ type: "done", reason, message });
      result.end(message);
    });
    return result;
  };
  return {
    id: model.provider,
    name: "Deterministic Architecture production test",
    auth: {
      apiKey: {
        name: "Local scripted auth",
        check: async () => ({ type: "api_key", source: "test" }),
        resolve: async () => ({ auth: { apiKey: "script-only" } }),
      },
    },
    getModels: () => [model],
    stream,
    streamSimple: stream,
  };
}
function available() {
  try {
    const security = JSON.parse(
      execFileSync("docker", ["info", "--format", "{{json .SecurityOptions}}"], {
        encoding: "utf8",
        timeout: 8000,
      }),
    ) as string[];
    if (!security.some((v) => /(^|=)rootless$/.test(v))) return false;
    execFileSync("docker", ["image", "inspect", "noveltea-sandbox:local"], {
      stdio: "ignore",
      timeout: 8000,
    });
    return existsSync(join(skillsSource, "skills/nt-story-architecture/SKILL.md"));
  } catch {
    return false;
  }
}

test(
  "#206: persistent sandbox reviewer continues three material Arc/Milestone corrections with exact source-bound approval",
  {
    skip: !available() && "Requires rootless sandbox and pinned skills checkout",
    timeout: 240_000,
  },
  async () => {
    const tmp = mkdtempSync(join(tmpdir(), "nt-206-production-"));
    const keys = [
      "NT_STATE_DIR",
      "NT_GIT_CACHE_DIR",
      "NT_SKILL_CACHE_DIR",
      "NT_CONFIG_FILE",
      "NT_SANDBOX_SOCKET",
      "NT_SANDBOX_TOKEN_FILE",
      "NT_REQUIRE_SANDBOX_TOOLS",
    ] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    let server: ReturnType<typeof createControllerServer> | undefined;
    let controller: SandboxController | undefined;
    let jobId: string | undefined;
    const extraJobIds: string[] = [];
    try {
      const app = join(tmp, "app"),
        state = join(tmp, "state"),
        cache = join(tmp, "cache");
      const socketDir = join(tmp, "controller");
      const owner = "protocol-206-owner",
        repositoryId = "protocol-206-repo";
      const scoped = join(cache, sha(owner), sha("github:" + repositoryId));
      const repo = join(scoped, "base"),
        story = join(repo, "story");
      mkdirSync(join(story, "creative-direction"), { recursive: true });
      for (const dir of [app, socketDir, state, cache]) mkdirSync(dir, { recursive: true });
      writeFileSync(join(story, "creative-direction/foundation.md"), foundation);
      const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
      git("init", "-q");
      git("config", "user.name", "Author");
      git("config", "user.email", "author@example.test");
      git("add", ".");
      git("commit", "-qm", "Test original Foundation");
      const baseSha = git("rev-parse", "HEAD");
      jobId = randomUUID();
      const db = new DatabaseSync(join(app, "studio.sqlite"));
      try {
        db.exec(
          "CREATE TABLE studio_sessions (id TEXT, owner_user_id TEXT, story_id TEXT, source_commit_sha TEXT, generation_config_json TEXT);" +
            "CREATE TABLE stories (id TEXT, owner_user_id TEXT, repository_id TEXT, directory TEXT);" +
            "CREATE TABLE repositories (id TEXT, owner_user_id TEXT, provider TEXT, provider_repository_id TEXT);",
        );
        db.prepare("INSERT INTO repositories VALUES (?,?,?,?)").run("repo", owner, "github", repositoryId);
        db.prepare("INSERT INTO stories VALUES (?,?,?,?)").run("story", owner, "repo", "story");
        db.prepare("INSERT INTO studio_sessions VALUES (?,?,?,?,?)").run(
          jobId,
          owner,
          "story",
          baseSha,
          null,
        );
      } finally {
        db.close();
      }
      const token = randomBytes(48).toString("hex");
      const tokenFile = join(socketDir, "controller.token");
      writeFileSync(tokenFile, token + "\n", { mode: 0o600 });
      const config: ControllerConfig = {
        socket: join(socketDir, "controller.sock"),
        token,
        appVolume: app,
        stateVolume: state,
        cacheVolume: cache,
        containerState: state,
        containerCache: cache,
        image: "noveltea-sandbox:local",
      };
      controller = new SandboxController(config);
      server = createControllerServer(controller);
      server.listen(config.socket);
      await once(server, "listening");
      Object.assign(process.env, {
        NT_STATE_DIR: state,
        NT_SKILL_CACHE_DIR: join(tmp, "skills"),
        NT_GIT_CACHE_DIR: scoped,
        NT_SANDBOX_SOCKET: config.socket,
        NT_SANDBOX_TOKEN_FILE: tokenFile,
        NT_REQUIRE_SANDBOX_TOOLS: "1",
        NT_CONFIG_FILE: join(tmp, "absent-config.json"),
      });
      const job = await startStoryJob({ story, job: jobId, worktreeCacheRoot: scoped });
      mkdirSync(join(job.worktreeStoryRoot, "milestones"), { recursive: true });
      const sourceFile = join(job.worktreeStoryRoot, path);
      writeFileSync(sourceFile, original);
      const snapshot = await createSkillSnapshot({
        discovery: "explicit-only",
        novelteaSkills: skillsSource,
        skillDirs: [],
        requiredSkills: ["nt-story-architecture", "nt-catalog"],
      });
      assert.ok(snapshot);
      const plan: Plan = {
        version: 1,
        items: [],
        contract: {
          scope: { kind: "partial", depth: "architecture", targets: [], branches: [] },
          constraints: ["Protect witnesses and give each route enduring consequences"],
          envelope: { presentation: "Mystery", hardLimits: [], preferences: [] },
        },
      };
      const calls: Call[] = [];
      const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
      runtime.registerNativeProvider(scripted(calls));
      await runtime.refresh({ allowNetwork: false });
      const writer = {
        id: "writer-" + randomUUID(),
        file: join(job.stateDir, "architecture-sessions", "writer.jsonl"),
      };
      const run = () =>
        withJobModelRuntime(runtime, () =>
          withStoryJobLock(job, "global-architecture", async () => {
            const cycle = await createArchitectureDraftReviewCycle(
              job,
              snapshot,
              plan,
              model.provider,
              model.id,
              [path],
              writer,
              "",
              undefined,
            );
            try {
              const session = cycle.identity.reviewer;
              assert.notEqual(session.id, writer.id);
              assert.notEqual(session.file, writer.file);
              for (let round = 0; round < 4; round++) {
                const result = await cycle.review();
                assert.equal(result.verdict.status, round === 3 ? "pass" : "revise");
                assert.equal(cycle.identity.reviewer.id, session.id);
                if (round < 3) {
                  assert.equal(result.convergence.reassess, false);
                  writeFileSync(sourceFile, readFileSync(sourceFile, "utf8") + changes[round] + "\n");
                } else {
                  assert.ok(result.pin);
                  await verifyArchitectureDraftReviewPin(
                    job,
                    snapshot,
                    plan,
                    model.provider,
                    model.id,
                    [path],
                    writer,
                    result.pin,
                  );
                  const wrongJob = { ...job, threadId: "different-thread" };
                  await assert.rejects(
                    verifyArchitectureDraftReviewPin(
                      wrongJob,
                      snapshot,
                      plan,
                      model.provider,
                      model.id,
                      [path],
                      writer,
                      result.pin,
                    ),
                    /wrong assignment|lineage/,
                  );
                  await assert.rejects(
                    verifyArchitectureDraftReviewPin(
                      job,
                      { ...snapshot, id: "different-snapshot" },
                      plan,
                      model.provider,
                      model.id,
                      [path],
                      writer,
                      result.pin,
                    ),
                    /wrong assignment|lineage/,
                  );
                  const modified = readFileSync(sourceFile);
                  try {
                    writeFileSync(sourceFile, modified + "Changed after review\n");
                    await assert.rejects(
                      verifyArchitectureDraftReviewPin(
                        job,
                        snapshot,
                        plan,
                        model.provider,
                        model.id,
                        [path],
                        writer,
                        result.pin,
                      ),
                      /differs from exact reviewed Story bytes/,
                    );
                  } finally {
                    writeFileSync(sourceFile, modified);
                  }
                  const pinFile = join(
                    job.stateDir,
                    "architecture-draft-reviews",
                    result.pin.cycleId,
                    "round-1.json",
                  );
                  const receipt = readFileSync(pinFile);
                  try {
                    writeFileSync(
                      pinFile,
                      JSON.stringify({ ...JSON.parse(receipt.toString()), reviewer: writer }),
                    );
                    await assert.rejects(
                      verifyArchitectureDraftReviewPin(
                        job,
                        snapshot,
                        plan,
                        model.provider,
                        model.id,
                        [path],
                        writer,
                        result.pin,
                      ),
                      /wrong or changed reviewer|transcript/,
                    );
                  } finally {
                    writeFileSync(pinFile, receipt);
                  }
                }
              }
              const reviewCalls = calls.filter(
                (call) =>
                  call.prompt.includes("INDEPENDENT READ-ONLY ARCHITECTURE REVIEW") ||
                  call.prompt.includes("INDEPENDENT READ-ONLY early reviewer"),
              );
              assert.ok(reviewCalls.length >= 4);
              assert.ok(
                reviewCalls.every(
                  (c) =>
                    c.active.includes("read") &&
                    !c.active.some((name) => ["write", "edit", "bash", "exec"].includes(name)),
                ),
                "every independent reviewer turn is isolated from writer tools",
              );
              const sealed = JSON.parse(
                readFileSync(
                  join(job.stateDir, "architecture-draft-reviews", cycle.identity.cycleId, "round-3.json"),
                  "utf8",
                ),
              );
              assert.equal(sealed.reviewer.id, session.id);
              assert.equal(sealed.writer.id, writer.id);
              assert.equal(sealed.previousDigest.length, 64);
            } finally {
              cycle.dispose();
            }
          }),
        );
      await configurePiPolicy(job, {
        version: 1,
        profile: { provider: model.provider, model: model.id },
        limits: { steps: 20 },
      });
      await run();
      // The same uncommitted job is still protected from blind replay: a new
      // cycle instance cannot overwrite sealed round zero with a fresh verdict.
      const total = calls.length;
      await assert.rejects(run(), /EEXIST|already exists|wrong|receipt|source/);
      assert.equal(
        calls.length,
        total,
        "admitted original cycle blocks another reviewer BEFORE any model turn",
      );

      // A crash at the unsealed first reviewer turn must preserve its admission,
      // with no replacement reviewer or retry on the same uncommitted assignment.
      // An attempted author-only inbox read must also fail within the sandbox.
      for (const scenario of ["crash", "forbidden"] as const) {
        const id = randomUUID();
        extraJobIds.push(id);
        const db = new DatabaseSync(join(app, "studio.sqlite"));
        try {
          db.prepare("INSERT INTO studio_sessions VALUES (?,?,?,?,?)").run(id, owner, "story", baseSha, null);
        } finally {
          db.close();
        }
        const isolated = await startStoryJob({ story, job: id, worktreeCacheRoot: scoped });
        mkdirSync(join(isolated.worktreeStoryRoot, "milestones"), { recursive: true });
        writeFileSync(join(isolated.worktreeStoryRoot, path), original);
        const attempts: Call[] = [];
        const scriptedRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
        scriptedRuntime.registerNativeProvider(
          scripted(attempts, {
            crash: scenario === "crash",
            forbidden: scenario === "forbidden",
          }),
        );
        await scriptedRuntime.refresh({ allowNetwork: false });
        await configurePiPolicy(isolated, {
          version: 1,
          profile: { provider: model.provider, model: model.id },
          limits: { steps: 10 },
        });
        const originalWriter = {
          id: "writer-" + randomUUID(),
          file: join(isolated.stateDir, "architecture-sessions", "writer.jsonl"),
        };
        const begin = () =>
          withJobModelRuntime(scriptedRuntime, () =>
            withStoryJobLock(isolated, "global-architecture", async () => {
              const cycle = await createArchitectureDraftReviewCycle(
                isolated,
                snapshot,
                plan,
                model.provider,
                model.id,
                [path],
                originalWriter,
              );
              try {
                await cycle.review();
              } finally {
                cycle.dispose();
              }
            }),
          );
        await assert.rejects(begin(), /interrupted|omitted required|invalid|error|preserve/i);
        const reviewRoot = join(isolated.stateDir, "architecture-draft-reviews");
        const cycles = execFileSync("ls", [reviewRoot], { encoding: "utf8" }).trim().split("\n");
        assert.equal(cycles.length, 1);
        const admitted = join(reviewRoot, cycles[0]!, "admitted.json");
        assert.ok(existsSync(admitted), "reviewer admission survives failed first Pi turn");
        assert.equal(existsSync(join(reviewRoot, cycles[0]!, "round-0.json")), false);
        const count = attempts.length;
        await assert.rejects(begin(), /already exists|reconcile original reviewer/i);
        assert.equal(
          attempts.length,
          count,
          "interrupted or forbidden reviewer cannot restart without source reconciliation",
        );
      }

      // A third independent, read-only Pi diagnostic is actually invoked when
      // two consecutive revisions make no source progress. It must not turn
      // a negative precommit review into approval or run the writer again.
      const diagnosticJobId = randomUUID();
      extraJobIds.push(diagnosticJobId);
      const diagnosisDb = new DatabaseSync(join(app, "studio.sqlite"));
      try {
        diagnosisDb.prepare("INSERT INTO studio_sessions VALUES (?,?,?,?,?)")
          .run(diagnosticJobId, owner, "story", baseSha, null);
      } finally { diagnosisDb.close(); }
      const stalledJob = await startStoryJob({
        story, job: diagnosticJobId, worktreeCacheRoot: scoped,
      });
      mkdirSync(join(stalledJob.worktreeStoryRoot, "milestones"), { recursive: true });
      writeFileSync(join(stalledJob.worktreeStoryRoot, path), original);
      const diagnosisCalls: Call[] = [];
      const diagnosticRuntime = await ModelRuntime.create({
        modelsPath: null, refreshOnCreate: false,
      });
      diagnosticRuntime.registerNativeProvider(scripted(diagnosisCalls, { stall: true }));
      await diagnosticRuntime.refresh({ allowNetwork: false });
      await configurePiPolicy(stalledJob, {
        version: 1, profile: { provider: model.provider, model: model.id },
        limits: { steps: 20 },
      });
      await withJobModelRuntime(diagnosticRuntime, () =>
        withStoryJobLock(stalledJob, "global-architecture", async () => {
          const cycle = await createArchitectureDraftReviewCycle(
            stalledJob, snapshot, plan, model.provider, model.id,
            [path], { id: "writer-" + randomUUID(),
              file: join(stalledJob.stateDir, "architecture-sessions", "writer.jsonl") },
          );
          try {
            for (let round = 0; round < 3; round++) {
              const result = await cycle.review();
              assert.equal(result.verdict.status, "revise");
              assert.equal(result.convergence.reassess, round === 2);
            }
            const diagnosis = await cycle.diagnose();
            assert.equal(diagnosis.action, "escalate");
            const sealed = JSON.parse(readFileSync(join(stalledJob.stateDir,
              "architecture-draft-reviews", cycle.identity.cycleId,
              "diagnostic-2.json"), "utf8"));
            assert.equal(sealed.diagnosis.action, "escalate");
            assert.notEqual(sealed.diagnostic.id, sealed.reviewer.id);
            assert.notEqual(sealed.diagnostic.id, sealed.writer.id);
            assert.equal(readFileSync(join(stalledJob.worktreeStoryRoot, path), "utf8"), original);
            assert.equal(diagnosisCalls.some(call =>
              call.prompt.includes("INDEPENDENT READ-ONLY ARCHITECTURE DIAGNOSTIC")), true);
            assert.equal(diagnosisCalls.filter(call =>
              call.prompt.includes("INDEPENDENT READ-ONLY ARCHITECTURE DIAGNOSTIC"))
              .every(call => !call.active.some(tool =>
                ["write", "edit", "bash", "exec"].includes(tool))), true);
          } finally { cycle.dispose(); }
        }),
      );
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      if (controller) for (const id of extraJobIds) await controller.dispose(id);
      if (controller && jobId) await controller.dispose(jobId);
      if (server) await new Promise<void>((done) => server!.close(() => done()));
      await removeTestTree(tmp);
    }
  },
);
