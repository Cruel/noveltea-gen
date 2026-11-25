/**
 * Opt-in real Foundation -> Architecture integration against the actual host
 * sandbox controller and rootless Docker. Does not require deployed Studio
 * OAuth or #59's web scheduling: it constructs a disposable, registered
 * Studio job with the exact catalog/worktree identity checked by #51.
 *
 * NT_LIVE_HOSTED_SANDBOX=1: real Pi calls (paid; requires configured Pi auth)
 * NT_LIVE_REVIEW_REPAIR=1: resume a preserved current-format CLI Generation
 * with an independently rejected Foundation (requires NT_TEST_HOSTED_RESUME_DIR)
 * NT_TEST_HOSTED_FIXTURE=1: same Docker/controller plumbing, fixture authors
 * NT_TEST_HOSTED_STAGES=1: extend either mode through Character/World and Event
 * NT_TEST_HOSTED_RESUME_DIR=/tmp/preserved-fixture: recover interrupted live
 * test from its trusted catalog and job state instead of regenerating writers
 * Both opt-ins are disabled in the ordinary unit-test suite.
 */
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { createControllerServer, SandboxController, type ControllerConfig } from "../web/src/sandbox-controller.js";
import { SandboxClient } from "../src/sandbox-client.js";
import { startStoryJob } from "../src/job.js";
import { runArchitectureJob } from "../src/architecture.js";
import { runAuthorAction } from "../src/author-updates.js";
import { inspectTrustedApproval, requestTrustedApproval } from "../src/trusted-approval.js";
import { hasUserProtectedDecision } from "../src/foundation-record.js";
import { inspectRecoveryCheckpoints } from "../src/recovery-checkpoints.js";
import { readIndependentReview } from "../src/checkpoint-assurance.js";
import { inspectRejectedRepair } from "../src/rejected-review-repair.js";
import { removeTestTree } from "./helpers.js";
import { runStoryGeneration } from "../src/generation.js";
import { planWholeStory } from "../web/src/lib/turn-plan.js";
import { saveJobTurnPlan } from "../web/src/lib/turn-plan-receipt.server.js";
import { withJobModelRuntime } from "../src/model-runtime.js";
import { scriptedModel, scriptedStoryRuntime } from "./c03-scripted-story-helpers.js";
import { archiveStages } from "./support/scripted-archive-stages.js";
import { archiveContract } from "./support/current-story-start.js";

const repair = process.env.NT_LIVE_REVIEW_REPAIR === "1";
const live = process.env.NT_LIVE_HOSTED_SANDBOX === "1" || repair;
const fixture = process.env.NT_TEST_HOSTED_FIXTURE === "1";
const includeStages = process.env.NT_TEST_HOSTED_STAGES === "1";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test(repair
  ? "real Pi reviewer rejects, repairs and rereviews an exact Foundation assignment"
  : "registered rootless Docker controller supports Foundation through Event stages", {
  skip: !(live || fixture) ? "Set NT_LIVE_HOSTED_SANDBOX=1 or NT_LIVE_REVIEW_REPAIR=1 for paid Pi; NT_TEST_HOSTED_FIXTURE=1 for plumbing-only smoke" : false,
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

  const resumeDir = process.env.NT_TEST_HOSTED_RESUME_DIR;
  if (repair) assert.ok(resumeDir, "Supply a preserved current-format Generation with a failed Foundation Review.");
  const temporary = resumeDir ? resolve(resumeDir) : mkdtempSync(join(tmpdir(), "nt-hosted-pi-live-"));
  const app = join(temporary, "app"), state = join(temporary, "state"), cache = join(temporary, "cache");
  const socketDir = join(temporary, "controller");
  for (const path of [app, state, cache, socketDir]) mkdirSync(path, { recursive: true });
  const tokenFile = join(socketDir, "controller.token");
  const token = resumeDir ? readFileSync(tokenFile, "utf8").trim() : randomBytes(48).toString("hex");
  if (!resumeDir) writeFileSync(tokenFile, token + "\n", { mode: 0o600 });
  const id = resumeDir
    ? (JSON.parse(readFileSync(join(state, "jobs", readdirSync(join(state, "jobs"))[0]!, "job.json"), "utf8")) as { jobId: string }).jobId
    : randomUUID();
  const owner = "sandbox-integration-owner";
  const providerRepo = "integration-fixture-repository";
  const scoped = join(cache, hash(owner), hash("github:" + providerRepo));
  const repository = join(scoped, "base");
  const story = join(repository, "story");
  mkdirSync(story, { recursive: true });
  const originalEnv = Object.fromEntries(
    ["NT_STATE_DIR", "NT_GIT_CACHE_DIR", "NT_SKILL_CACHE_DIR",
      "NT_SANDBOX_SOCKET", "NT_SANDBOX_TOKEN_FILE", "NT_REQUIRE_SANDBOX_TOOLS",
      "NT_CONFIG_FILE"].map(key => [key, process.env[key]])
  );
  let controller: SandboxController | undefined;
  let server: ReturnType<typeof createControllerServer> | undefined;
  let passed = false;
  let cleanupFailure: unknown;
  try {
    if (!resumeDir) {
      git(repository, "init", "-q");
      git(repository, "config", "user.name", "Sandbox Test Author");
      git(repository, "config", "user.email", "sandbox@example.test");
      writeFileSync(join(repository, "README.txt"), "Disposable author baseline\n");
      git(repository, "add", ".");
      git(repository, "commit", "-qm", "Author baseline");
    }
    const base = git(repository, "rev-parse", "HEAD");

    process.env.NT_STATE_DIR = state;
    process.env.NT_GIT_CACHE_DIR = scoped;
    process.env.NT_SKILL_CACHE_DIR = join(state, "skill-snapshots");
    process.env.NT_CONFIG_FILE = join(temporary, "skill-config.json");
    if (!resumeDir) writeFileSync(process.env.NT_CONFIG_FILE, JSON.stringify({
      novelteaSkills: source, skillDiscovery: "explicit-only", requiredSkills: ["nt-catalog"], skillDirs: [],
    }));

    const job = await startStoryJob({ story, job: id, worktreeCacheRoot: scoped });
    assert.equal(job.baseSha, base);
    assert.equal(job.jobId, id);

    // Fixture the only trusted catalog fields needed to register this job.
    if (!resumeDir) {
      const db = new DatabaseSync(join(app, "studio.sqlite"));
      try {
        db.exec(`CREATE TABLE studio_sessions (id TEXT, owner_user_id TEXT, story_id TEXT, source_commit_sha TEXT, generation_config_json TEXT);
          CREATE TABLE stories (id TEXT, owner_user_id TEXT, repository_id TEXT, directory TEXT);
          CREATE TABLE repositories (id TEXT, owner_user_id TEXT, provider TEXT, provider_repository_id TEXT);`);
        db.prepare("INSERT INTO repositories VALUES (?,?,?,?)").run("repo-id", owner, "github", providerRepo);
        db.prepare("INSERT INTO stories VALUES (?,?,?,?)").run("story-id", owner, "repo-id", "story");
        db.prepare("INSERT INTO studio_sessions VALUES (?,?,?,?,?)").run(id, owner, "story-id", base, null);
      } finally { db.close(); }
    }

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

    if (repair) {
      // Do not synthesize a new writer, Turn, or negative Review for this
      // historical job. Resume only the original authenticated CLI graph.
      const point = (await inspectRecoveryCheckpoints(job)).find(p =>
        p.eligible && p.workItem === "foundation" && p.semanticReview === "failed");
      assert.ok(point?.assurance, "Preserved source must have an independently rejected Foundation");
      const savedReview = await readIndependentReview(job, point.assurance);
      assert.equal(savedReview.status, "failed");
      assert.ok(savedReview.result?.findings.some(f => f.requiredCorrection &&
        f.affectedPaths?.includes("creative-direction/foundation.md")));
      const before = await runStoryGeneration({ story, job: id, action: "inspect" });
      assert.ok(before.recoveryInspection?.active, "Original failed Generation case is required");
      assert.equal(before.operationRecovery?.source.headSha, point.commitSha);
      const result = await runStoryGeneration({ story, job: id, action: "resume" });
      assert.ok(["paused", "completed"].includes(result.status), JSON.stringify(result));
      const receipt = await inspectRejectedRepair(job, point.commitSha);
      assert.equal(receipt.phase, "passed");
      const foundation = JSON.parse(readFileSync(join(job.stateDir, "foundation.json"), "utf8"));
      assert.equal(receipt.origin.sessionFile, foundation.piSessionFile);
      assert.ok(receipt.repairedCommitSha && receipt.repairedCommitSha !== point.commitSha);
      const completed = (await inspectRecoveryCheckpoints(job)).find(p => p.commitSha === receipt.repairedCommitSha);
      assert.equal(completed?.semanticReview, "passed");
      const repairedText = readFileSync(join(job.worktreeStoryRoot, "creative-direction/foundation.md"), "utf8");
      assert.match(repairedText, /green ticket/i);
      assert.match(repairedText, /11:47/);
      assert.ok(hasUserProtectedDecision(repairedText));
    }
    if (!repair) {
      const task = "A missing archive witness; invent unspecified details";
      const contract = archiveContract;
      const turn = planWholeStory(task, contract, job.baseSha);
      if (!resumeDir) await saveJobTurnPlan(job, turn);
      const generate = () => runStoryGeneration(resumeDir
        ? { story, job: id, action: "resume", pauseAfter: includeStages ? "event" : "architecture" }
        : { story, job: id, action: "start", task, contract,
          skillsSource: source, validatorSource: source,
          provider: live ? process.env.NT_PROVIDER : scriptedModel.provider,
          model: live ? process.env.NT_MODEL : scriptedModel.id,
          pauseAfter: includeStages ? "event" : "architecture" });
      const generated = live ? await generate() : await withJobModelRuntime(
        (await scriptedStoryRuntime(archiveStages(job, turn))).runtime, generate);
      assert.equal(generated.status, "paused", JSON.stringify(generated));
      const points = await inspectRecoveryCheckpoints(job);
      assert.ok(points.some(p => p.workItem === "foundation" && p.eligible));
      assert.ok(points.some(p => p.workItem === "global-architecture" && p.eligible));
      assert.ok(hasUserProtectedDecision(readFileSync(join(job.worktreeStoryRoot,
        "creative-direction/foundation.md"), "utf8")));
      if (includeStages) {
        assert.ok(points.some(p => p.workItem.startsWith("event-") && p.eligible));
        assert.equal((await client.inspect(id)).status, "running");
      }
    }
    if (!resumeDir && !repair) {
      // Exercise a genuine suspended author-update interrupt against the same
      // job that Pi (or its deterministic fixture) just authored.
      const current = await runArchitectureJob({ story, job: id, action: "inspect" });
      assert.ok(current.plan);
      const updated = {
        ...current.plan.contract,
        constraints: [...current.plan.contract.constraints, "Retain the archivist's agency"],
      };
      const proposed = await runArchitectureJob({ story, job: id, action: "propose", contract: updated });
      assert.ok(proposed.proposal);
      const proposal = proposed.proposal.digest;
      const messageId = "approval-boundary";
      const messageFile = join(temporary, "approval-message.json");
      writeFileSync(messageFile, JSON.stringify({
        id: messageId, kind: "approval", payload: { requestType: "plan", proposalSha256: proposal },
      }));
      await runAuthorAction({ story, job: id, action: "send", file: messageFile });
      const pending = await runAuthorAction({ story, job: id, action: "process" }) as {
        status: string; blockers: string[];
      };
      assert.equal(pending.status, "blocked");
      assert.ok(pending.blockers.some(value => value.includes(messageId)));

      // The request is real and pending in the trusted controller ledger.
      const approvalId = "sandbox-probe";
      const receipt = await requestTrustedApproval(job, { id: approvalId, kind: "plan" });
      assert.equal(receipt.phase, "awaiting-controller");
      const receiptPath = join(job.stateDir, "trusted-approvals", approvalId + ".json");

      // This is the same isolated execution primitive offered to Pi's bash
      // tool. Even with exact host paths, Pi cannot see the approval ledger,
      // controller credentials, private socket, job state, or Docker socket.
      const inaccessible = [receiptPath, job.stateDir, tokenFile, config.socket,
        join(app, "studio.sqlite"), "/var/run/docker.sock", "/run/docker.sock",
        "/story/.git", "/story/.story-inbox"];
      const probeOutput: string[] = [];
      const probe = await client.execute(id, ["sh", "-c",
        'for path in "$@"; do if test -e "$path" || test -S "$path"; then echo "exposed:$path" >&2; exit 41; fi; done; echo isolated',
        "nt-isolation-probe", ...inaccessible], (_stream, value) => probeOutput.push(value));
      assert.equal(probe, 0, probeOutput.join(""));
      assert.equal(probeOutput.join("").trim(), "isolated");
      assert.equal((await inspectTrustedApproval(job, approvalId)).phase, "awaiting-controller");
      const interrupted = await runAuthorAction({ story, job: id, action: "inspect" }) as {
        records: Array<{ acknowledgement: { phase: string } }>;
      };
      assert.equal(interrupted.records[0]?.acknowledgement.phase, "awaiting-author");

      // A trusted OS terminal can resolve the interrupt; sandbox tools cannot.
      // This is scripted consent solely for a disposable test job, not a real
      // author's decision or a model-accessible approval mechanism.
      const argv = [process.execPath, "--import", "tsx", resolve("src/cli.ts"),
        "job", "approval", "decide", "--story", story, "--job", id, "--id", approvalId];
      const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
      const terminal = spawnSync("script",
        ["-q", "-e", "-c", argv.map(shellQuote).join(" "), "/dev/null"],
        { input: "APPROVE " + proposal + "\n", encoding: "utf8", timeout: 30000 });
      assert.equal(terminal.status, 0, terminal.stdout + terminal.stderr);
      const approved = await inspectTrustedApproval(job, approvalId);
      assert.equal(approved.phase, "recorded");
      if (approved.phase !== "recorded") throw new Error("Approval was not recorded.");
      assert.equal(approved.source, "trusted-cli");
      const responseFile = join(temporary, "approval-response.json");
      writeFileSync(responseFile, JSON.stringify({ type: "decision", messageId,
        approval: { receiptId: approvalId, nonce: receipt.nonce } }));
      const resumed = await runAuthorAction({ story, job: id, action: "resume", file: responseFile }) as {
        phase: string;
      };
      assert.equal(resumed.phase, "applied");
      assert.equal((await runArchitectureJob({ story, job: id, action: "inspect" })).plan?.version, 2);
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
