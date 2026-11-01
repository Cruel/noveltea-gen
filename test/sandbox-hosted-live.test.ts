/**
 * Opt-in real Foundation -> Architecture integration against the actual host
 * sandbox controller and rootless Docker. Does not require deployed Studio
 * OAuth or #59's web scheduling: it constructs a disposable, registered
 * Studio job with the exact catalog/worktree identity checked by #51.
 *
 * NT_LIVE_HOSTED_SANDBOX=1: real Pi calls (paid; requires configured Pi auth)
 * NT_TEST_HOSTED_FIXTURE=1: same Docker/controller plumbing, fixture authors
 * NT_TEST_HOSTED_STAGES=1: extend either mode through Character/World and Event
 * Both opt-ins are disabled in the ordinary unit-test suite.
 */
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { createControllerServer, SandboxController, type ControllerConfig } from "../web/src/sandbox-controller.js";
import { SandboxClient } from "../src/sandbox-client.js";
import { startStoryJob } from "../src/job.js";
import { runFoundationJob } from "../src/foundation.js";
import { runArchitectureJob } from "../src/architecture.js";
import { runCharacterWorldJob } from "../src/character-world.js";
import { runEventWorkItem } from "../src/event-work.js";
import { hasUserProtectedDecision } from "../src/foundation-record.js";
import { removeTestTree } from "./helpers.js";

const live = process.env.NT_LIVE_HOSTED_SANDBOX === "1";
const fixture = process.env.NT_TEST_HOSTED_FIXTURE === "1";
const includeStages = process.env.NT_TEST_HOSTED_STAGES === "1";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("registered rootless Docker controller supports Foundation through Event stages", {
  skip: !(live || fixture) ? "Set NT_LIVE_HOSTED_SANDBOX=1 for paid Pi or NT_TEST_HOSTED_FIXTURE=1 for plumbing-only smoke" : false,
  timeout: 900_000,
}, async () => {
  const source = resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills");
  assert.ok(existsSync(join(source, "skills/nt-story-architecture/SKILL.md")),
    "Set NT_SKILLS_CHECKOUT to the canonical noveltea-skills checkout");
  assert.ok(existsSync(join(source, "src/cli.ts")), "Canonical validator checkout is missing");
  const dockerInfo = execFileSync("docker", ["info", "--format", "{{json .SecurityOptions}}"], { encoding: "utf8" });
  assert.ok((JSON.parse(dockerInfo) as string[]).some(flag => /(^|=)rootless$/.test(flag)),
    "The sandbox test requires ROOTLESS Docker");
  assert.equal(execFileSync("docker", ["info", "--format", "{{.CgroupVersion}}/{{.CgroupDriver}}"],
    { encoding: "utf8" }).trim(), "2/systemd");
  const image = process.env.NT_TEST_SANDBOX_IMAGE ?? "noveltea-sandbox:local";
  assert.match(execFileSync("docker", ["image", "inspect", image, "--format", "{{.Id}}"],
    { encoding: "utf8" }).trim(), /^sha256:[a-f0-9]{64}$/);

  const temporary = mkdtempSync(join(tmpdir(), "nt-hosted-pi-live-"));
  const app = join(temporary, "app"), state = join(temporary, "state"), cache = join(temporary, "cache");
  const socketDir = join(temporary, "controller");
  for (const path of [app, state, cache, socketDir]) mkdirSync(path);
  const tokenFile = join(socketDir, "controller.token");
  const token = randomBytes(48).toString("hex");
  writeFileSync(tokenFile, token + "\n", { mode: 0o600 });
  const id = randomUUID();
  const owner = "sandbox-integration-owner";
  const providerRepo = "integration-fixture-repository";
  const scoped = join(cache, hash(owner), hash("github:" + providerRepo));
  const repository = join(scoped, "base");
  const story = join(repository, "story");
  mkdirSync(story, { recursive: true });
  const originalEnv = Object.fromEntries(
    ["NT_STATE_DIR", "NT_GIT_CACHE_DIR", "NT_SKILL_CACHE_DIR", "NT_VALIDATOR_CACHE_DIR",
      "NT_SANDBOX_SOCKET", "NT_SANDBOX_TOKEN_FILE", "NT_REQUIRE_SANDBOX_TOOLS",
      "NT_CONFIG_FILE"].map(key => [key, process.env[key]])
  );
  let controller: SandboxController | undefined;
  let server: ReturnType<typeof createControllerServer> | undefined;
  let passed = false;
  let cleanupFailure: unknown;
  try {
    git(repository, "init", "-q");
    git(repository, "config", "user.name", "Sandbox Test Author");
    git(repository, "config", "user.email", "sandbox@example.test");
    writeFileSync(join(repository, "README.txt"), "Disposable author baseline\n");
    git(repository, "add", ".");
    git(repository, "commit", "-qm", "Author baseline");
    const base = git(repository, "rev-parse", "HEAD");

    process.env.NT_STATE_DIR = state;
    process.env.NT_GIT_CACHE_DIR = scoped;
    process.env.NT_SKILL_CACHE_DIR = join(state, "skill-snapshots");
    process.env.NT_VALIDATOR_CACHE_DIR = join(state, "validator-cache");
    process.env.NT_CONFIG_FILE = join(temporary, "skill-config.json");
    writeFileSync(process.env.NT_CONFIG_FILE, JSON.stringify({
      novelteaSkills: source, skillDiscovery: "explicit-only", requiredSkills: ["nt-catalog"], skillDirs: [],
    }));

    const job = await startStoryJob({ story, job: id, worktreeCacheRoot: scoped });
    assert.equal(job.baseSha, base);
    assert.equal(job.jobId, id);

    // Fixture the only trusted catalog fields needed to register this job.
    const db = new DatabaseSync(join(app, "studio.sqlite"));
    try {
      db.exec(`CREATE TABLE studio_sessions (id TEXT, owner_user_id TEXT, story_id TEXT, source_commit_sha TEXT);
        CREATE TABLE stories (id TEXT, owner_user_id TEXT, repository_id TEXT, directory TEXT);
        CREATE TABLE repositories (id TEXT, owner_user_id TEXT, provider TEXT, provider_repository_id TEXT);`);
      db.prepare("INSERT INTO repositories VALUES (?,?,?,?)").run("repo-id", owner, "github", providerRepo);
      db.prepare("INSERT INTO stories VALUES (?,?,?,?)").run("story-id", owner, "repo-id", "story");
      db.prepare("INSERT INTO studio_sessions VALUES (?,?,?,?)").run(id, owner, "story-id", base);
    } finally { db.close(); }

    const config: ControllerConfig = {
      socket: join(socketDir, "controller.sock"), token, appVolume: app,
      stateVolume: state, cacheVolume: cache, image,
      // Host-only integration fixture: both the test worker and controller
      // see the same absolute paths. Compose uses /var/lib/noveltea instead.
      containerState: state, containerCache: cache,
    };
    controller = new SandboxController(config);
    server = createControllerServer(controller);
    server.listen(config.socket);
    await once(server, "listening");

    process.env.NT_REQUIRE_SANDBOX_TOOLS = "1";
    process.env.NT_SANDBOX_SOCKET = config.socket;
    process.env.NT_SANDBOX_TOKEN_FILE = tokenFile;
    const client = new SandboxClient();
    assert.equal((await client.acquire(id)).status, "running");
    const emitted: string[] = [];
    const code = await client.execute(id, ["sh", "-c",
      "test ! -e /story/.git && test ! -e /story/.story-inbox && test ! -e /run/secrets && pwd"],
      (_stream, value) => emitted.push(value));
    assert.equal(code, 0);
    assert.equal(emitted.join("").trim(), "/story");

    const foundation = await runFoundationJob({
      story, job: id, task: "Write an intimate mystery about an archivist on a stranded midnight train. Invent unspecified details.",
      envelope: "Dialogue-led visual novel; a small cast and two reusable locations; no fixed ending count.",
      skillsSource: source, validatorSource: source,
      provider: process.env.NT_PROVIDER, model: process.env.NT_MODEL, fixture: !live,
    });
    assert.equal(foundation.status, "committed", JSON.stringify(foundation));
    assert.equal((foundation as { skillReads?: unknown[] }).skillReads?.length, 5);
    const foundationFile = join(job.worktreeStoryRoot, "creative-direction/foundation.md");
    assert.ok(hasUserProtectedDecision(readFileSync(foundationFile, "utf8")));

    const architecture = await runArchitectureJob({
      story, job: id, action: "run", fixture: !live,
      provider: process.env.NT_PROVIDER, model: process.env.NT_MODEL,
      skillsSource: source, validatorSource: source,
      contract: {
        scope: includeStages
          ? { kind: "partial", depth: "interactive", targets: ["arc.truth", "milestone.disclosure"],
              branches: ["trust-route", "confrontation-route"] }
          : { kind: "partial", depth: "architecture", targets: [], branches: [] },
        constraints: ["Preserve the archivist and stranded train mystery"],
        envelope: { presentation: "Dialogue-led visual novel",
          hardLimits: ["Small cast", "Two reusable locations"], preferences: [] },
      },
    });
    assert.equal(architecture.status, includeStages ? "architecture-committed" : "complete-in-scope", JSON.stringify(architecture));
    assert.ok(existsSync(join(job.worktreeStoryRoot, "arcs")));
    assert.ok(existsSync(join(job.worktreeStoryRoot, "milestones")));
    assert.ok((architecture as { skillReads?: unknown[] }).skillReads?.length === 6 || !live,
      "Real Architecture Pi must read all pinned skill references");
    if (includeStages) {
      const foundations = await runCharacterWorldJob({ story, job: id, action: "run", fixture: !live,
        skillsSource: source, validatorSource: source,
        provider: process.env.NT_PROVIDER, model: process.env.NT_MODEL });
      assert.equal(foundations.status, "foundations-committed", JSON.stringify(foundations));
      assert.ok(existsSync(join(job.worktreeStoryRoot, "characters/ada.md")));
      assert.ok(existsSync(join(job.worktreeStoryRoot, "world-entities/archive.md")));
      const event = await runEventWorkItem({ story, job: id, action: "run", fixture: !live,
        milestone: "milestone.disclosure", skillsSource: source, validatorSource: source,
        provider: process.env.NT_PROVIDER, model: process.env.NT_MODEL });
      assert.equal(event.status, "event-cluster-committed", JSON.stringify(event));
      assert.ok(existsSync(join(job.worktreeStoryRoot, "events/disclose-ledger.md")));
      // No model shell access to the host is necessary for either specialist.
      assert.equal((await client.inspect(id)).status, "running");
    }
    assert.equal(git(repository, "rev-parse", "HEAD"), base);
    assert.equal(git(repository, "status", "--porcelain"), "");
    assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "");
    assert.equal((await client.inspect(id)).status, "running");
    passed = true;
  } finally {
    if (controller) {
      try { controller.dispose(id); } catch (error) {
        // Never silently remove persistent data while an unknown container
        // may still be writing. Leave the fixture for operator inspection.
        passed = false;
        cleanupFailure = error;
      }
    }
    if (server) {
      await new Promise<void>(done => server!.close(() => done()));
    }
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (passed && process.env.NT_KEEP_FAILED_LIVE !== "1") removeTestTree(temporary);
    else console.error("Sandbox integration data preserved for inspection:", temporary);
    if (cleanupFailure) throw cleanupFailure;
  }
});
