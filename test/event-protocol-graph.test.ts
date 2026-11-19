/** Deterministic real-Pi Event graph certification. The authenticated model
 * transport is scripted; Story writes still use the production rootless sandbox
 * and the actual writer -> native validation -> Git commit handoff. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
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
  type SimpleStreamOptions,
  type TranscriptContext,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {
  createControllerServer,
  SandboxController,
  type ControllerConfig,
} from "../web/src/sandbox-controller.js";
import { boundedPinnedSources } from "../src/bounded-specialist-prompt.js";
import { runEventWorkItem } from "../src/event-work.js";
import { withJobModelRuntime } from "../src/model-runtime.js";
import { removeTestTree } from "./helpers.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const model: Model = {
  id: "scripted-recovery",
  name: "Scripted response recovery",
  provider: "certification",
  api: "certification-script",
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
function scriptProvider(
  eventRecord: string,
  onCall: (observation: { index: number; toolNames: string[]; messages: readonly unknown[] }) => void,
): Provider {
  let index = 0;
  const respond = (_model: Model, context: TranscriptContext, options?: SimpleStreamOptions) => {
    const stream = createAssistantMessageEventStream();
    const at = index++;
    // Pi's normalized transcript carries the actual tool declarations through
    // system messages, not the old `options.tools` request field.
    const active = new Set<string>();
    for (const message of context.messages) {
      if (message.role !== "system") continue;
      for (const tool of message.toolsAdded ?? []) active.add(tool.name);
      for (const tool of message.toolsRemoved ?? []) active.delete(tool.name);
    }
    onCall({ index: at, toolNames: [...active], messages: context.messages });
    const call = (id: string, name: string, args: Record<string, any>): ToolCall => ({
      type: "toolCall",
      id: "certification-" + id,
      name,
      arguments: args,
    });
    const content: AssistantMessage["content"] =
      at === 0
        ? [
            ...boundedPinnedSources("nt-event-design").map((path, i) =>
              call("skill-" + i, "read", { path: "skill://" + path }),
            ),
            call("write-event", "write", { path: "events/disclose-ledger.md", content: eventRecord }),
            call("bind-milestone", "edit", {
              path: "milestones/disclosure.md",
              edits: [
                { oldText: "completeness: partial\n", newText: "" },
                {
                  oldText: "fulfillment: {any_of: []}",
                  newText: "fulfillment: {any_of: [[event.disclose-ledger]]}",
                },
              ],
            }),
          ]
        : at === 1
          ? [{ type: "text", text: '{"modifiedRecords": [' }]
          : at === 2
            ? [
                {
                  type: "text",
                  text: JSON.stringify({
                    modifiedRecords: ["events/disclose-ledger.md", "milestones/disclosure.md"],
                    architecturalConflicts: [],
                    laterObligations: [
                      "Player-facing prose and alternate branch details require composition and editorial review.",
                    ],
                  }),
                },
              ]
            : [{ type: "text", text: "Unexpected extra model invocation" }];
    const reason = at === 0 ? "toolUse" : "stop";
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
      stream.push({ type: "start", partial: message });
      for (let i = 0; i < content.length; i++) {
        const item = content[i]!;
        if (item.type === "toolCall") {
          stream.push({ type: "toolcall_start", contentIndex: i, partial: message });
          stream.push({ type: "toolcall_end", contentIndex: i, toolCall: item, partial: message });
        } else if (item.type === "text") {
          stream.push({ type: "text_start", contentIndex: i, partial: message });
          stream.push({ type: "text_end", contentIndex: i, content: item.text, partial: message });
        }
      }
      stream.push({ type: "done", reason, message });
      stream.end(message);
    });
    return stream;
  };
  return {
    id: model.provider,
    name: "Local deterministic certification",
    auth: {
      apiKey: {
        name: "Scripted test credential",
        check: async () => ({ type: "api_key", source: "local deterministic runtime" }),
        resolve: async () => ({ auth: { apiKey: "scripted-local-only" } }),
      },
    },
    getModels: () => [model],
    stream: respond,
    streamSimple: respond,
  };
}

function dockerReady() {
  try {
    const security = JSON.parse(
      execFileSync("docker", ["info", "--format", "{{json .SecurityOptions}}"], {
        encoding: "utf8",
        timeout: 8_000,
      }),
    ) as string[];
    if (!security.some((flag) => /(^|=)rootless$/.test(flag))) return false;
    execFileSync("docker", ["image", "inspect", "noveltea-sandbox:local"], {
      stdio: "ignore",
      timeout: 8_000,
    });
    return true;
  } catch {
    return false;
  }
}
const available = dockerReady() && existsSync(resolve("../noveltea-skills/skills/nt-event-design/SKILL.md"));

test(
  "real sandboxed Event graph corrects malformed Pi report in the original session without replaying edits",
  {
    skip: !available && "needs rootless Docker, noveltea-sandbox:local and local noveltea-skills",
    timeout: 720_000,
  },
  async () => {
    const source = resolve("../noveltea-skills");
    const temp = mkdtempSync(join(tmpdir(), "nt-event-protocol-graph-"));
    const originalEnv = Object.fromEntries(
      [
        "NT_STATE_DIR",
        "NT_GIT_CACHE_DIR",
        "NT_CONFIG_FILE",
        "NT_SKILL_CACHE_DIR",
        "NT_SANDBOX_SOCKET",
        "NT_SANDBOX_TOKEN_FILE",
        "NT_REQUIRE_SANDBOX_TOOLS",
        "NT_REQUIRE_USER_PI_RUNTIME",
      ].map((key) => [key, process.env[key]]),
    );
    let controller: SandboxController | undefined;
    let liveJobId: string | undefined;
    let server: ReturnType<typeof createControllerServer> | undefined;
    const git = (dir: string, ...args: string[]) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
    try {
      const app = join(temp, "app"),
        state = join(temp, "state"),
        cache = join(temp, "cache"),
        socketDir = join(temp, "controller");
      for (const path of [app, state, cache, socketDir]) mkdirSync(path, { recursive: true });
      const owner = "event-protocol-owner",
        repositoryId = "event-protocol-fixture";
      const scoped = join(cache, hash(owner), hash("github:" + repositoryId));
      const repo = join(scoped, "base"),
        story = join(repo, "story");
      mkdirSync(join(story, "creative-direction"), { recursive: true });
      writeFileSync(
        join(story, "creative-direction/foundation.md"),
        `---
schema: '0.1'
type: creative-direction
id: creative-direction.foundation
title: "The vanished witness"
status: draft
decisions:
  - id: player-choice
    statement: "The player must be able to protect or challenge a trusted friend"
    origin: user
    authority: user-protected
premise: "A witness vanishes, leaving evidence at a small archive"
central_conflict: "Expose a concealment or protect a friend"
genre: "Mystery"
tone: "Intimate and tense"
player_experience: "Consequential investigative conversations"
scope: "Two Characters, one reusable archive setting"
---

Ada and Neri disagree about whether a concealed ledger should be revealed.
`,
      );
      git(repo, "init", "-q");
      git(repo, "config", "user.name", "Author");
      git(repo, "config", "user.email", "author@example.test");
      git(repo, "add", ".");
      git(repo, "commit", "-qm", "Original Creative Direction");
      const baseline = git(repo, "rev-parse", "HEAD");
      const realId = randomUUID(),
        templateId = randomUUID();
      liveJobId = realId;
      const db = new DatabaseSync(join(app, "studio.sqlite"));
      try {
        db.exec(`CREATE TABLE studio_sessions (id TEXT, owner_user_id TEXT, story_id TEXT, source_commit_sha TEXT, generation_config_json TEXT);
        CREATE TABLE stories (id TEXT, owner_user_id TEXT, repository_id TEXT, directory TEXT);
        CREATE TABLE repositories (id TEXT, owner_user_id TEXT, provider TEXT, provider_repository_id TEXT);`);
        db.prepare("INSERT INTO repositories VALUES (?,?,?,?)").run("repo-id", owner, "github", repositoryId);
        db.prepare("INSERT INTO stories VALUES (?,?,?,?)").run("story-id", owner, "repo-id", "story");
        for (const id of [realId, templateId])
          db.prepare("INSERT INTO studio_sessions VALUES (?,?,?,?,?)").run(
            id,
            owner,
            "story-id",
            baseline,
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
        NT_GIT_CACHE_DIR: scoped,
        NT_CONFIG_FILE: join(temp, "absent.json"),
        NT_SKILL_CACHE_DIR: join(temp, "skills"),
        NT_SANDBOX_SOCKET: config.socket,
        NT_SANDBOX_TOKEN_FILE: tokenFile,
        NT_REQUIRE_SANDBOX_TOOLS: "1",
        NT_REQUIRE_USER_PI_RUNTIME: "1",
      });
      const cli = (id: string, ...args: string[]) => {
        const child = spawnSync(
          process.execPath,
          ["--import", "tsx", resolve("src/cli.ts"), "job", ...args, "--story", story, "--job", id],
          {
            encoding: "utf8",
            timeout: 150_000,
            maxBuffer: 20 * 1024 * 1024,
            env: { ...process.env, NT_REQUIRE_USER_PI_RUNTIME: "0" },
          },
        );
        assert.equal(child.status, 0, child.stderr || child.stdout);
        return JSON.parse(child.stdout);
      };
      const contract = join(temp, "contract.json");
      writeFileSync(
        contract,
        JSON.stringify({
          scope: {
            kind: "partial",
            depth: "interactive",
            targets: ["arc.truth", "milestone.disclosure"],
            branches: ["trust", "confrontation"],
          },
          constraints: ["Preserve the player's choice to protect or challenge their friend"],
          envelope: {
            presentation: "Dialogue-led visual novel",
            hardLimits: ["Reuse the archive setting"],
            preferences: ["Two principal Characters"],
          },
        }),
      );
      const prepare = (id: string) => {
        const job = cli(id, "start");
        assert.equal(
          cli(id, "architecture", "run", "--fixture", "--skills-source", source, "--contract", contract)
            .status,
          "architecture-committed",
        );
        assert.equal(
          cli(id, "foundations", "run", "--fixture", "--skills-source", source).status,
          "foundations-committed",
        );
        return job;
      };
      const template = prepare(templateId);
      assert.equal(
        cli(
          templateId,
          "event",
          "run",
          "--fixture",
          "--milestone",
          "milestone.disclosure",
          "--skills-source",
          source,
        ).status,
        "event-cluster-committed",
      );
      const eventRecord = readFileSync(join(template.worktreeStoryRoot, "events/disclose-ledger.md"), "utf8");
      const job = prepare(realId);
      const firstHead = git(job.worktreeRoot, "rev-parse", "HEAD");
      const initialMilestone = readFileSync(join(job.worktreeStoryRoot, "milestones/disclosure.md"), "utf8");

      const observed: Array<{ index: number; toolNames: string[]; messages: readonly unknown[] }> = [];
      const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
      runtime.registerNativeProvider(scriptProvider(eventRecord, (call) => observed.push(call)));
      await runtime.refresh({ allowNetwork: false });
      assert.ok(runtime.getModel(model.provider, model.id));
      assert.ok((await runtime.getAvailable(model.provider)).some((value) => value.id === model.id));

      const outcome = await withJobModelRuntime(runtime, () =>
        runEventWorkItem({
          story,
          job: realId,
          action: "run",
          milestone: "milestone.disclosure",
          skillsSource: source,
          provider: model.provider,
          model: model.id,
        }),
      );
      assert.equal(outcome.status, "event-cluster-committed");
      assert.equal(outcome.validation.status, "passed");
      assert.equal(observed.length, 3, "one tool-use reply, one malformed response, one correction");
      assert.ok(observed[0]!.toolNames.includes("write"));
      assert.ok(observed[0]!.toolNames.includes("edit"));
      assert.deepEqual(observed[2]!.toolNames, [], "correction must expose no tools in actual Pi");
      const correctionContext = JSON.stringify(observed[2]!.messages);
      assert.match(correctionContext, /RESPONSE-CONTRACT CORRECTION ONLY/);
      assert.match(correctionContext, /modifiedRecords/);
      assert.match(
        correctionContext,
        /\\"modifiedRecords\\": \[/,
        "the invalid original response must remain in the same Pi conversation",
      );
      const authorCalls = (
        observed[2]!.messages as Array<{
          role: string;
          content?: Array<{ type: string; name?: string }>;
        }>
      ).flatMap((message) =>
        message.role === "assistant"
          ? (message.content ?? []).filter((item) => item.type === "toolCall")
          : [],
      );
      assert.equal(authorCalls.filter((item) => item.name === "write").length, 1);
      assert.equal(authorCalls.filter((item) => item.name === "edit").length, 1);
      assert.equal(
        readFileSync(join(job.worktreeStoryRoot, "events/disclose-ledger.md"), "utf8"),
        eventRecord,
        "correction must not re-author the Event record",
      );
      assert.notEqual(
        readFileSync(join(job.worktreeStoryRoot, "milestones/disclosure.md"), "utf8"),
        initialMilestone,
      );
      assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "");
      assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD^"), firstHead);
      assert.equal(git(repo, "rev-parse", "HEAD"), baseline);
      const receipt = JSON.parse(
        readFileSync(join(job.stateDir, "protocol-recovery/event-event-disclosure-0.json"), "utf8"),
      );
      assert.equal(receipt.status, "accepted");
      assert.equal(receipt.attempts, 2);
      assert.equal(receipt.contract, "specialist.changed-paths.v1");
      assert.equal(receipt.sessionFile, outcome.sessionFile);
      assert.ok(
        readFileSync(receipt.sessionFile, "utf8").includes("RESPONSE-CONTRACT CORRECTION ONLY"),
        "the correction is persisted in the original Pi session transcript",
      );
      assert.deepEqual(
        outcome.consequenceProof.diagnostics,
        [],
        "source-bound Event consequence assurance must follow correction",
      );
      assert.ok(outcome.paths.includes("events/disclose-ledger.md"));
      assert.ok(outcome.paths.includes("milestones/disclosure.md"));
      assert.match(git(job.worktreeRoot, "log", "-1", "--format=%B"), /NovelTea-Work-Item: event-disclosure/);
      const replay = await withJobModelRuntime(runtime, () =>
        runEventWorkItem({
          story,
          job: realId,
          action: "run",
          milestone: "milestone.disclosure",
          skillsSource: source,
          provider: model.provider,
          model: model.id,
        }),
      );
      assert.equal(replay.headSha, outcome.headSha);
      assert.equal(observed.length, 3, "replayed graph must not invoke Pi again");
    } finally {
      if (controller && liveJobId) controller.dispose(liveJobId);
      if (server) await new Promise<void>((done) => server!.close(() => done()));
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      removeTestTree(temp);
    }
  },
);
