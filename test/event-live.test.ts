/** Focused Event-only real Pi probe. Its registered rootless Docker controller
 * matches production sandbox authority; no unsafe local writer fallback. */
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createControllerServer, SandboxController, type ControllerConfig } from "../web/src/sandbox-controller.js";
import { canonicalPinnedReadPath } from "../src/pinned-skill-reads.js";
import { removeTestTree } from "./helpers.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

test("opt-in real pinned nt-event-design authors a causal, verified Milestone cluster", {
  skip: process.env.NT_LIVE_EVENT !== "1" ? "set NT_LIVE_EVENT=1 for live Pi certification" : false,
  timeout: 720_000,
}, async () => {
  const source = resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills");
  assert.ok(existsSync(join(source, "skills/nt-event-design/SKILL.md")));
  const security = JSON.parse(execFileSync("docker", ["info", "--format", "{{json .SecurityOptions}}"], {
    encoding: "utf8",
  })) as string[];
  assert.ok(security.some(flag => /(^|=)rootless$/.test(flag)), "Live Event requires rootless Docker");
  assert.equal(execFileSync("docker", ["info", "--format", "{{.CgroupVersion}}/{{.CgroupDriver}}"], {
    encoding: "utf8",
  }).trim(), "2/systemd");
  const image = process.env.NT_TEST_SANDBOX_IMAGE ?? "noveltea-sandbox:local";
  assert.match(execFileSync("docker", ["image", "inspect", image, "--format", "{{.Id}}"], {
    encoding: "utf8",
  }).trim(), /^sha256:[a-f0-9]{64}$/);

  const temp = mkdtempSync(join(tmpdir(), "nt-event-live-"));
  const git = (dir: string, ...args: string[]) => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const skillSourceStatus = git(source, "status", "--porcelain");
  let completed = false;
  const jobId = randomUUID();
  let controller: SandboxController | undefined;
  let server: ReturnType<typeof createControllerServer> | undefined;
  try {
    const app = join(temp, "app");
    const state = join(temp, "state");
    const cache = join(temp, "cache");
    const socketDir = join(temp, "controller");
    for (const path of [app, state, cache, socketDir]) mkdirSync(path, { recursive: true });
    const owner = "focused-event-owner", repositoryId = "focused-event-fixture";
    const scoped = join(cache, hash(owner), hash("github:" + repositoryId));
    const repo = join(scoped, "base");
    const story = join(repo, "story");
    mkdirSync(join(story, "creative-direction"), { recursive: true });
    writeFileSync(join(story, "creative-direction/foundation.md"), `---
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

Ada and Neri disagree about whether a concealed ledger should be revealed. The player controls the degree of confrontation.
`);
    git(repo, "init", "-q"); git(repo, "config", "user.name", "Author");
    git(repo, "config", "user.email", "author@example.test");
    git(repo, "add", "."); git(repo, "commit", "-qm", "Original Creative Direction");
    const baseline = git(repo, "rev-parse", "HEAD");

    const db = new DatabaseSync(join(app, "studio.sqlite"));
    try {
      db.exec(`CREATE TABLE studio_sessions (id TEXT, owner_user_id TEXT, story_id TEXT, source_commit_sha TEXT, generation_config_json TEXT);
        CREATE TABLE stories (id TEXT, owner_user_id TEXT, repository_id TEXT, directory TEXT);
        CREATE TABLE repositories (id TEXT, owner_user_id TEXT, provider TEXT, provider_repository_id TEXT);`);
      db.prepare("INSERT INTO repositories VALUES (?,?,?,?)")
        .run("repo-id", owner, "github", repositoryId);
      db.prepare("INSERT INTO stories VALUES (?,?,?,?)")
        .run("story-id", owner, "repo-id", "story");
      db.prepare("INSERT INTO studio_sessions VALUES (?,?,?,?,?)")
        .run(jobId, owner, "story-id", baseline, null);
    } finally { db.close(); }

    const token = randomBytes(48).toString("hex");
    const tokenFile = join(socketDir, "controller.token");
    writeFileSync(tokenFile, token + "\n", { mode: 0o600 });
    const config: ControllerConfig = {
      socket: join(socketDir, "controller.sock"), token,
      appVolume: app, stateVolume: state, cacheVolume: cache,
      containerState: state, containerCache: cache, image,
    };
    controller = new SandboxController(config);
    server = createControllerServer(controller);
    server.listen(config.socket);
    await once(server, "listening");

    const env = { ...process.env, NT_STATE_DIR: state, NT_GIT_CACHE_DIR: scoped,
      NT_CONFIG_FILE: join(temp, "absent.json"), NT_SKILL_CACHE_DIR: join(temp, "skills"),
      NT_SANDBOX_SOCKET: config.socket, NT_SANDBOX_TOKEN_FILE: tokenFile,
      NT_REQUIRE_SANDBOX_TOOLS: "1" };
    const cli = async (...args: string[]) => {
      const child = spawn(process.execPath, ["--import", "tsx", resolve("src/cli.ts"),
        "job", ...args, "--story", story, "--job", jobId], {
        cwd: resolve("."), env, timeout: 650_000,
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk.toString(); });
      child.stderr.on("data", chunk => { stderr += chunk.toString(); });
      const [code] = await once(child, "close");
      assert.equal(code, 0, stderr || stdout);
      return JSON.parse(stdout);
    };
    const job = await cli("start");
    const contract = join(temp, "contract.json");
    writeFileSync(contract, JSON.stringify({ scope: {
      kind: "partial", depth: "interactive",
      targets: ["arc.truth", "milestone.disclosure"], branches: ["trust", "confrontation"],
    }, constraints: ["Preserve the player's choice to protect or challenge their friend"],
    envelope: { presentation: "Dialogue-led visual novel", hardLimits: ["Reuse the archive setting"],
      preferences: ["Two principal Characters", "No bespoke Room assets"] } }));
    const arch = await cli("architecture", "run", "--fixture", "--skills-source", source, "--contract", contract);
    assert.equal(arch.status, "architecture-committed");
    const foundations = await cli("foundations", "run", "--fixture", "--skills-source", source);
    assert.equal(foundations.status, "foundations-committed");
    const args = ["event", "run", "--milestone", "milestone.disclosure", "--skills-source", source];
    if (process.env.NT_PROVIDER) args.push("--provider", process.env.NT_PROVIDER);
    if (process.env.NT_MODEL) args.push("--model", process.env.NT_MODEL);
    const generated = await cli(...args);
    assert.equal(generated.status, "event-cluster-committed");
    assert.ok(generated.paths.some((p: string) => p.startsWith("events/")));
    assert.equal(generated.validation.status, "passed");
    assert.ok(generated.validation.eventProgress.every((p: any) => p.status === "reachable"));
    if (generated.validation.milestoneState === "partial-choice-pending") {
      assert.deepEqual(generated.validation.routes, []);
      assert.ok(generated.obligations.some((o: string) => /choice/i.test(o)));
      assert.ok(generated.consequenceProof.laterObligations.some((o: string) => /choice/i.test(o)));
    } else {
      assert.ok(generated.validation.routes.some((p: any) => p.status === "reachable"));
    }
    assert.deepEqual(generated.consequenceProof.diagnostics, []);
    assert.equal(generated.consequenceProof.milestone.id, "milestone.disclosure");
    assert.equal(generated.validation.protectionBase, foundations.headSha);
    assert.equal(generated.skillReads.length, 5);
    const messages = readFileSync(generated.sessionFile, "utf8").trim().split("\n").map(JSON.parse);
    const calls = messages.flatMap((m: any) => m.message?.content ?? [])
      .filter((item: any) => item.type === "toolCall");
    const reads = calls.filter((c: any) => c.name === "read").map((c: any) => c.arguments?.path);
    const snapshotRoot = generated.skillReads[0].slice(0,
      generated.skillReads[0].lastIndexOf("/skills/"));
    const canonicalReads = reads.map((p: string) =>
      canonicalPinnedReadPath(p, job.worktreeStoryRoot, snapshotRoot));
    assert.ok(generated.skillReads.every((p: string) => canonicalReads.includes(p)));
    assert.ok(calls.some((c: any) => ["write", "edit"].includes(c.name)));
    const report = await cli("validate");
    assert.equal(report.status, "passed");
    if (generated.validation.milestoneState === "complete")
      assert.equal(report.report.coverage.milestoneRoutes
        .find((m: any) => m.id === "milestone.disclosure").routes.some((r: any) => r.status === "reachable"), true);
    assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "");
    assert.equal(git(repo, "rev-parse", "HEAD"), baseline);
    assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), generated.headSha);
    assert.match(git(job.worktreeRoot, "log", "-1", "--format=%B"), /NovelTea-Work-Item: event-disclosure/);
    completed = true;
  } finally {
    if (controller) controller.dispose(jobId);
    if (server) await new Promise<void>(done => server!.close(() => done()));
    assert.equal(git(source, "status", "--porcelain"), skillSourceStatus);
    if (!completed && process.env.NT_KEEP_FAILED_LIVE === "1")
      process.stderr.write("Preserved failed Event Pi job: " + temp + "\n");
    else removeTestTree(temp);
  }
});
