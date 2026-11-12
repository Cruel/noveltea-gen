/**
 * Opt-in real Foundation -> Architecture integration against the actual host
 * sandbox controller and rootless Docker. Does not require deployed Studio
 * OAuth or #59's web scheduling: it constructs a disposable, registered
 * Studio job with the exact catalog/worktree identity checked by #51.
 *
 * NT_LIVE_HOSTED_SANDBOX=1: real Pi calls (paid; requires configured Pi auth)
 * NT_LIVE_REVIEW_REPAIR=1: actual independent semantic rejection, original-session
 * Foundation correction, native validation, immutable Git receipt and Pi rereview
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
import { runFoundationJob } from "../src/foundation.js";
import { runArchitectureJob } from "../src/architecture.js";
import { runAuthorAction } from "../src/author-updates.js";
import { inspectTrustedApproval, requestTrustedApproval } from "../src/trusted-approval.js";
import { runCharacterWorldJob } from "../src/character-world.js";
import { runEventWorkItem } from "../src/event-work.js";
import { hasUserProtectedDecision } from "../src/foundation-record.js";
import { planWholeStory } from "../web/src/lib/turn-plan.js";
import { saveJobTurnPlan } from "../web/src/lib/turn-plan-receipt.server.js";
import { inspectRecoveryCheckpoints } from "../src/recovery-checkpoints.js";
import { createSkillSnapshot } from "../src/snapshot.js";
import { readIndependentReview } from "../src/checkpoint-assurance.js";
import type { RecoveryCheckpoint } from "../src/recovery-checkpoints.js";
import { runPiAssignmentReview } from "../src/semantic-assignment-review.js";
import { withStoryJobLock } from "../src/job-lock.js";
import { advanceRejectedRepair, inspectRejectedRepair } from "../src/rejected-review-repair.js";
import { removeTestTree } from "./helpers.js";

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

    if (repair && !resumeDir) {
      const contract = {
        scope: { kind: "full-story" as const, depth: "composition" as const,
          targets: [], branches: [] }, constraints: [],
        envelope: { presentation: "Dialogue-led visual novel", hardLimits: [], preferences: [] },
      };
      // The writer deliberately omits one binding author requirement below.
      // The real reviewer must detect the defect from the committed diff.
      const request = "Write a midnight train mystery. The archivist must learn from a green ticket " +
        "that the missing passenger departed at 11:47 PM; preserve this causal clue in Creative Direction.";
      const plan = planWholeStory(request, contract, job.baseSha, job.jobId);
      plan.assignments[0]!.outcome = "Establish a coherent Creative Direction in which the archivist " +
        "learns from a green ticket that the missing passenger departed at exactly 11:47 PM. " +
        "Preserve user-protected decisions and include this specific causal clue in the prose.";
      const { digest: _old, ...planBody } = plan;
      plan.digest = hash(JSON.stringify(planBody));
      await saveJobTurnPlan(job, plan);
    }

    if (!resumeDir || repair) {
      const foundation = resumeDir
        ? JSON.parse(readFileSync(join(job.stateDir, "foundation.json"), "utf8")) as {
          stage: string; piSessionFile: string; skillReads: string[]; commitSha: string;
        }
        : await runFoundationJob({
          story, job: id, task: "Write an intimate mystery about an archivist on a stranded midnight train. Invent unspecified details.",
          envelope: "Dialogue-led visual novel; a small cast and two reusable locations; no fixed ending count.",
          skillsSource: source, validatorSource: source,
          provider: process.env.NT_PROVIDER, model: process.env.NT_MODEL, fixture: !live,
        });
      assert.equal("stage" in foundation ? foundation.stage : foundation.status, "committed");
      assert.ok((foundation as { skillReads?: unknown[] }).skillReads?.length! >= 5);
      const foundationFile = join(job.worktreeStoryRoot, "creative-direction/foundation.md");
      assert.ok(hasUserProtectedDecision(readFileSync(foundationFile, "utf8")));

      if (repair) {
        const point = resumeDir
          ? JSON.parse(readFileSync(join(job.stateDir, "recovery-checkpoints",
            foundation.commitSha + ".json"), "utf8")) as RecoveryCheckpoint
          : (await inspectRecoveryCheckpoints(job)).find(point =>
            point.eligible && point.workItem === "foundation")!;
        assert.equal(point.assurance?.reviewSelection.status, "required-pending");
        let findings: Array<{ requiredCorrection?: string; affectedPaths?: string[] }>;
        if (resumeDir) {
          const savedReview = await readIndependentReview(job, point.assurance!);
          assert.equal(savedReview.status, "failed");
          findings = savedReview.result!.findings;
        } else {
          const reviewerSnapshot = await createSkillSnapshot({
            discovery: "explicit-only", novelteaSkills: source,
            skillDirs: [], requiredSkills: ["nt-narrative-review", "nt-catalog"],
          });
          assert.ok(reviewerSnapshot);
          const firstReview = await withStoryJobLock(job, "independent-assignment-review", () =>
            runPiAssignmentReview(job, [point], {
              snapshot: reviewerSnapshot, provider: process.env.NT_PROVIDER ?? "openai",
              model: process.env.NT_MODEL ?? "gpt-6-luna",
              reviewer: "independent-pi-assignment-review", onSession: async () => {},
            }));
          assert.equal(firstReview.verdict.verdict, "fail",
            JSON.stringify({ reason: "Reviewer should catch omitted 11:47 green-ticket clue",
              verdict: firstReview.verdict }));
          findings = firstReview.verdict.findings;
        }
        assert.ok(findings.some(f => f.requiredCorrection &&
          f.affectedPaths?.includes("creative-direction/foundation.md")));
        const result = await advanceRejectedRepair(job, point!.commitSha, {
          skillsSource: source, provider: process.env.NT_PROVIDER ?? "openai",
          model: process.env.NT_MODEL ?? "gpt-6-luna",
        });
        assert.equal(result.next, "completed", JSON.stringify(result));
        const receipt = await inspectRejectedRepair(job, point!.commitSha);
        assert.equal(receipt.phase, "passed");
        assert.equal(receipt.origin.sessionFile, foundation.piSessionFile,
          "Correction must reopen the original Foundation writer session");
        assert.ok(receipt.repairedCommitSha && receipt.repairedCommitSha !== point!.commitSha);
        const completed = (await inspectRecoveryCheckpoints(job)).find(p =>
          p.commitSha === receipt.repairedCommitSha);
        assert.equal(completed?.semanticReview, "passed");
        assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), receipt.repairedCommitSha);
        const repairedText = readFileSync(foundationFile, "utf8");
        assert.match(repairedText, /green ticket/i);
        assert.match(repairedText, /11:47/);
        assert.ok(hasUserProtectedDecision(repairedText));
        console.error("LIVE_REPAIR_CERTIFICATION " + JSON.stringify({
          firstReview: "fail", findings,
          originalCommit: point!.commitSha, repairedCommit: receipt.repairedCommitSha,
          amendmentDigest: receipt.planAmendment.digest,
          reviewerSessions: receipt.reviewer?.sessionFiles.length,
        }));
      } else {
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
      }
    }
    if (includeStages && !repair) {
      const foundations = await runCharacterWorldJob({ story, job: id, action: "run", fixture: !live,
        skillsSource: source, validatorSource: source,
        provider: process.env.NT_PROVIDER, model: process.env.NT_MODEL });
      assert.equal(foundations.status, "foundations-committed", JSON.stringify(foundations));
      // Real specialists choose canonical IDs themselves; never require fixture names.
      const markdown = (directory: string) => readdirSync(join(job.worktreeStoryRoot, directory))
        .filter(name => /^[a-z][a-z0-9-]*\.md$/.test(name));
      assert.ok(markdown("characters").length >= 2);
      assert.ok(markdown("world-entities").length >= 1);
      const event = await runEventWorkItem({ story, job: id, action: "run", fixture: !live,
        milestone: "milestone.disclosure", skillsSource: source, validatorSource: source,
        provider: process.env.NT_PROVIDER, model: process.env.NT_MODEL });
      assert.equal(event.status, "event-cluster-committed", JSON.stringify(event));
      assert.ok(markdown("events").length >= 1);
      // No model shell access to the host is necessary for either specialist.
      assert.equal((await client.inspect(id)).status, "running");
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
