import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
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

test("opt-in two real Pi specialists author and certify Character/World foundations", {
  skip: process.env.NT_LIVE_FOUNDATIONS !== "1" ? "set NT_LIVE_FOUNDATIONS=1 for live Pi certification" : false,
  timeout: 720_000,
}, async () => {
  const source = resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills");
  assert.ok(existsSync(join(source, "skills/nt-character-development/SKILL.md")));
  assert.ok(existsSync(join(source, "skills/nt-worldbuilding/SKILL.md")));
  const security = JSON.parse(execFileSync("docker", ["info", "--format", "{{json .SecurityOptions}}"], {
    encoding: "utf8",
  })) as string[];
  assert.ok(security.some(flag => /(^|=)rootless$/.test(flag)), "Live foundations require rootless Docker");
  assert.equal(execFileSync("docker", ["info", "--format", "{{.CgroupVersion}}/{{.CgroupDriver}}"], {
    encoding: "utf8",
  }).trim(), "2/systemd");
  const image = process.env.NT_TEST_SANDBOX_IMAGE ?? "noveltea-sandbox:local";
  assert.match(execFileSync("docker", ["image", "inspect", image, "--format", "{{.Id}}"], {
    encoding: "utf8",
  }).trim(), /^sha256:[a-f0-9]{64}$/);

  const temp = mkdtempSync(join(tmpdir(), "nt-foundations-live-"));
  function git(cwd: string, ...args: string[]) {
    const run = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  }
  const sourceStatus = git(source, "status", "--porcelain");
  const jobId = randomUUID();
  let controller: SandboxController | undefined;
  let server: ReturnType<typeof createControllerServer> | undefined;
  let completed = false;
  try {
    const app = join(temp, "app"), state = join(temp, "state");
    const cache = join(temp, "cache"), socketDir = join(temp, "controller");
    for (const path of [app, state, cache, socketDir]) mkdirSync(path, { recursive: true });
    const owner = "foundations-cert-owner", repositoryId = "foundations-cert-fixture";
    const scoped = join(cache, hash(owner), hash("github:" + repositoryId));
    const repo = join(scoped, "base");
    const story = join(repo, "story");
    mkdirSync(join(story, "creative-direction"), { recursive: true });
    writeFileSync(join(story, "creative-direction/foundation.md"), `---
schema: '0.1'
type: creative-direction
id: creative-direction.foundation
title: "The missing witness"
status: draft
decisions:
  - id: loyalty
    statement: "The player must have a meaningful choice to protect or challenge a friend"
    origin: user
    authority: user-protected
premise: "An archivist investigates a vanished witness"
central_conflict: "Expose concealed evidence or preserve a friendship"
genre: "Mystery"
tone: "Tense and intimate"
player_experience: "Dialogue-led investigative decisions"
scope: "Small cast, one reusable archive location"
---

A ledger implicates a trusted member of the community, threatening a close friendship.
`);
    git(repo, "init", "-q"); git(repo, "config", "user.name", "Author");
    git(repo, "config", "user.email", "author@example.test");
    git(repo, "add", "."); git(repo, "commit", "-qm", "Creative Direction");
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
      NT_SKILL_CACHE_DIR: join(temp, "skills"),
      NT_CONFIG_FILE: join(temp, "missing-config.json"),
      NT_SANDBOX_SOCKET: config.socket, NT_SANDBOX_TOKEN_FILE: tokenFile,
      NT_REQUIRE_SANDBOX_TOOLS: "1" };
    const cli = async (...args: string[]) => {
      const child = spawn(process.execPath, ["--import", "tsx", resolve("src/cli.ts"),
        "job", ...args, "--story", story, "--job", jobId], {
        cwd: resolve("."), env, timeout: 640_000,
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
    writeFileSync(contract, JSON.stringify({
      scope: { kind: "partial", depth: "architecture",
        targets: ["arc.truth", "milestone.disclosure"], branches: ["trust-path", "confrontation-path"] },
      constraints: ["Preserve the author's explicit loyalty choice"],
      envelope: { presentation: "Dialogue-led visual novel",
        hardLimits: ["One reused archive setting"], preferences: ["Two major Characters"] },
    }));
    const arch = await cli("architecture", "run", "--fixture", "--contract", contract, "--skills-source", source);
    assert.equal(arch.status, "architecture-committed");
    const args = ["foundations", "run", "--skills-source", source];
    if (process.env.NT_PROVIDER) args.push("--provider", process.env.NT_PROVIDER);
    if (process.env.NT_MODEL) args.push("--model", process.env.NT_MODEL);
    const generated = await cli(...args);
    assert.equal(generated.status, "foundations-committed");
    assert.equal(generated.items.length, 2);
    assert.ok(generated.items.every((item: any) => item.skillReads.length === 6));
    for (const unit of generated.items) {
      const messages = readFileSync(unit.piSessionFile, "utf8").trim().split("\n").map(JSON.parse);
      const calls = messages.flatMap((m: any) => m.message?.content ?? []).filter((c: any) => c.type === "toolCall");
      const reads = calls.filter((c: any) => c.name === "read").map((c: any) => c.arguments?.path);
      const snapshotRoot = unit.skillReads[0].slice(0, unit.skillReads[0].lastIndexOf("/skills/"));
      const canonicalReads = reads.map((p: string) =>
        canonicalPinnedReadPath(p, job.worktreeStoryRoot, snapshotRoot));
      assert.ok(unit.skillReads.every((p: string) => canonicalReads.includes(p)),
        "Pi must read its pinned skill sources");
      assert.ok(calls.some((c: any) => c.name === "write" || c.name === "edit"), "Pi must author directly");
      assert.ok(unit.paths.length > 0);
      assert.match(unit.commitSha, /^[a-f0-9]{40}$/);
      assert.equal(unit.validation.status, "passed");
    }
    const validated = await cli("validate");
    assert.equal(validated.status, "passed");
    const records = validated.report.records;
    assert.ok(records.filter((r: any) => r.metadata.type === "character").length >= 2);
    assert.ok(records.some((r: any) => r.metadata.type === "relationship"));
    assert.ok(records.some((r: any) => r.metadata.type === "fact"));
    assert.ok(records.some((r: any) => r.metadata.type === "world-entity"));
    assert.equal(records.filter((r: any) => r.metadata.type === "event").length, 0);
    assert.equal(git(repo, "rev-parse", "HEAD"), baseline);
    assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "");
    completed = true;
  } finally {
    if (controller) await controller.dispose(jobId);
    if (server) await new Promise<void>(done => server!.close(() => done()));
    assert.equal(git(source, "status", "--porcelain"), sourceStatus);
    if (!completed && process.env.NT_KEEP_FAILED_LIVE === "1") {
      process.stderr.write("Preserved failed live Story job for inspection: " + temp + "\n");
    } else {
      removeTestTree(temp);
    }
  }
});
