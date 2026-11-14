/**
 * #170: opt-in real Luna replay of the saved missing-Character Event failure.
 * The ORIGINAL rejected source and every Pi session are backed up before any
 * controller/model call and restored afterwards; certification never replaces
 * the sealed reviewer with a synthetic verdict.
 *
 * NT_TEST_170_LIVE=1 NT_TEST_170_ROOT=/tmp/nt158-... pnpm exec tsx --test test/issue-170-live.test.ts
 *
 * Do not run while a second process uses the preserved private job.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createControllerServer, SandboxController, type ControllerConfig } from "../web/src/sandbox-controller.js";
import { SandboxClient } from "../src/sandbox-client.js";
import { startStoryJob, type JobStartResult } from "../src/job.js";
import { inspectRecoveryCheckpoints } from "../src/recovery-checkpoints.js";
import { readIndependentReview } from "../src/checkpoint-assurance.js";
import { advanceRejectedRepair, ReviewDependencyRequiredError } from "../src/rejected-review-repair.js";
import { advanceReviewCharacterDependency } from "../src/dependency-work.js";
import { finalizeReviewEventDependency, inspectDependencyPlan } from "../src/dependency-state.js";
import { readTurnEvidence } from "../src/turn-plan-evidence.js";
import { withStoryJobLock } from "../src/job-lock.js";

const sha = "b5803f40fb92c402d1a852f0baf102233b7ba1c1";
const jobId = "0b58a215-d3b6-4545-a7e0-8d09dcebbfe4";
const hash = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const envNames = ["NT_STATE_DIR", "NT_GIT_CACHE_DIR", "NT_SKILL_CACHE_DIR",
  "NT_CONFIG_FILE", "NT_SANDBOX_SOCKET", "NT_SANDBOX_TOKEN_FILE",
  "NT_REQUIRE_SANDBOX_TOOLS", "NT_REQUIRE_USER_PI_RUNTIME"] as const;

test("saved #170 failure gets real Luna Character support, original Event-owner repair and two positive reviews", {
  skip: process.env.NT_TEST_170_LIVE !== "1" &&
    "Set NT_TEST_170_LIVE=1 and NT_TEST_170_ROOT to the preserved private job root",
  timeout: 1_200_000,
}, async () => {
  const root = resolve(process.env.NT_TEST_170_ROOT ?? "");
  assert.match(root, /^\/tmp\/nt158-[a-zA-Z0-9-]+$/, "Refuse a non-#158 private root.");
  const state = join(root, "state"), cache = join(root, "cache"), app = join(root, "app");
  const jobNames = readdirSync(join(state, "jobs"));
  assert.equal(jobNames.length, 1, "Require exactly the original isolated job");
  const stateDir = join(state, "jobs", jobNames[0]!);
  const saved = JSON.parse(readFileSync(join(stateDir, "job.json"), "utf8")) as JobStartResult;
  assert.equal(saved.jobId, jobId, "Never replay a different Story under this issue number");
  const sourceReview = readFileSync(join(stateDir, "independent-reviews", sha + ".json"));
  const sourceEvent = readFileSync(join(stateDir, "event-items", "discovery.json"));
  const sourceSessionFile = JSON.parse(sourceEvent.toString("utf8")).sessionFile as string;
  assert.ok(sourceSessionFile && existsSync(sourceSessionFile), "Require the original Event Pi session");
  const sourceSession = readFileSync(sourceSessionFile);
  const originalHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: saved.worktreeRoot, encoding: "utf8" }).trim();
  assert.equal(originalHead, sha, "The saved worktree must still have the rejected Event as HEAD");
  assert.equal(execFileSync("git", ["status", "--porcelain"], {
    cwd: saved.worktreeRoot, encoding: "utf8" }).trim(), "");
  const original = { head: originalHead, review: hash(sourceReview), event: hash(sourceEvent),
    session: hash(sourceSession) };
  const backup = mkdtempSync(join(tmpdir(), "nt170-preserved-backup-"));
  for (const name of ["state", "cache", "app"]) {
    cpSync(join(root, name), join(backup, name), { recursive: true, preserveTimestamps: true });
  }
  console.error("ISSUE170_PRESERVED_BACKUP " + backup);

  const priorEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  const socket = join(root, "controller", "issue-170-" + randomUUID() + ".sock");
  const tokenFile = join(root, "controller-token");
  const config: ControllerConfig = {
    socket, token: readFileSync(tokenFile, "utf8").trim(),
    appVolume: app, stateVolume: state, cacheVolume: cache,
    containerState: state, containerCache: cache,
    image: process.env.NT_TEST_SANDBOX_IMAGE ?? "noveltea-sandbox:local",
  };
  let controller: SandboxController | undefined;
  let server: ReturnType<typeof createControllerServer> | undefined;
  let cleanupError: unknown;
  let outcome: Record<string, unknown> = {
    sourceSha: sha, jobId, original, backup, model: "openai/gpt-6-luna",
    status: "not-run",
  };
  try {
    process.env.NT_STATE_DIR = state;
    process.env.NT_GIT_CACHE_DIR = saved.cacheRoot!;
    process.env.NT_SKILL_CACHE_DIR = join(root, "snapshots");
    process.env.NT_CONFIG_FILE = join(root, "local-config.json");
    process.env.NT_SANDBOX_SOCKET = socket;
    process.env.NT_SANDBOX_TOKEN_FILE = tokenFile;
    process.env.NT_REQUIRE_SANDBOX_TOOLS = "1";
    delete process.env.NT_REQUIRE_USER_PI_RUNTIME;
    const job = await startStoryJob({ story: saved.storyRoot, job: jobId }, false);
    const point = (await inspectRecoveryCheckpoints(job)).find(p => p.commitSha === sha);
    assert.ok(point?.eligible && point.assurance, point?.reason ?? "source checkpoint missing");
    assert.equal(point.semanticReview, "failed");
    const negative = await readIndependentReview(job, point.assurance);
    assert.equal(negative.status, "failed");
    assert.ok(negative.result?.findings.some(f => f.path === "events/discovery.md"));
    const hint = JSON.parse(readFileSync(join(stateDir, "turn-plan.json"), "utf8"));
    const turn = await readTurnEvidence(job, hint.contract);
    assert.ok(turn?.objective && turn.kind === "full-story");
    controller = new SandboxController(config);
    server = createControllerServer(controller);
    server.listen(socket);
    await once(server, "listening");
    assert.equal((await new SandboxClient().acquire(jobId)).status, "running");
    const options = { skillsSource: resolve("../noveltea-skills"),
      provider: "openai", model: "gpt-6-luna" };
    let request: ReviewDependencyRequiredError["request"] | undefined;
    try {
      await advanceRejectedRepair(job, sha, options);
    } catch (error) {
      if (!(error instanceof ReviewDependencyRequiredError)) throw error;
      request = error.request;
    }
    assert.ok(request, "The rejected Event must route to a separately authorized Character writer");
    assert.equal(request.classification, "new-full-story-record");
    assert.equal(request.action, "controller-amendment-required");
    const support = await advanceReviewCharacterDependency({
      story: saved.storyRoot, job: jobId, task: turn.goal, contract: turn.contract,
      skillsSource: options.skillsSource, provider: options.provider, model: options.model,
      turnPlanDigest: turn.digest, request,
    });
    assert.equal(support.status, "dependency-support-verified",
      "Independent Character review does not automatically approve the still-failed Event");
    const corrected = await advanceRejectedRepair(job, sha, options);
    assert.equal(corrected.next, "completed",
      "The original Event specialist must correct only its authorized Event and pass new review");
    const finalized = await withStoryJobLock(job, "issue-170-live-finalize", () =>
      finalizeReviewEventDependency(job, sha));
    assert.equal(finalized, true);
    const ledger = await inspectDependencyPlan(job);
    const entry = ledger?.entries.find(e => e.reviewSourceSha === sha);
    assert.equal(entry?.phase, "verified");
    assert.equal(entry?.review?.verdict, "pass");
    assert.ok(entry?.reviewerSession && entry.eventRepair?.commitSha);
    const finalHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: saved.worktreeRoot, encoding: "utf8" }).trim();
    assert.equal(finalHead, entry.eventRepair.commitSha);
    assert.equal(execFileSync("git", ["status", "--porcelain"], {
      cwd: saved.worktreeRoot, encoding: "utf8" }).trim(), "");
    await assert.rejects(inspectDependencyPlan({ ...job, threadId: "root:other" }),
      /identity|version|source/, "A disconnected foreign Thread must not inherit this grant");
    const reopened = await startStoryJob({ story: saved.storyRoot, job: jobId }, false);
    assert.equal((await inspectDependencyPlan(reopened))?.digest, ledger!.digest,
      "The independently checked ledger must survive a disconnected reopen");
    assert.equal((await advanceReviewCharacterDependency({
      story: saved.storyRoot, job: jobId, task: turn.goal, contract: turn.contract,
      skillsSource: options.skillsSource, provider: options.provider, model: options.model,
      turnPlanDigest: turn.digest, request,
    })).status, "dependency-verified", "Restart must not replay a completed Character writer");
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: saved.worktreeRoot, encoding: "utf8" }).trim(), finalHead,
      "Restart cannot duplicate or replay a committed writer");
    assert.equal((await readIndependentReview(job, point.assurance)).status, "failed",
      "The original independently rejected verdict must stay immutable");
    outcome = { ...outcome, status: "passed", sourceDigest: request.digest,
      CharacterCommit: entry.commitSha, eventCommit: finalHead,
      CharacterReviewer: !!entry.reviewerSession, eventRereview: "passed",
      restart: "same commit; no duplicate", crossThread: "refused" };
  } catch (error) {
    outcome = { ...outcome, status: "failed",
      error: error instanceof Error ? error.stack ?? error.message : String(error) };
    throw error;
  } finally {
    if (controller) {
      try { await controller.dispose(jobId); } catch (error) { cleanupError = error; }
    }
    if (server) {
      try { await new Promise<void>(done => server!.close(() => done())); }
      catch (error) { cleanupError ??= error; }
    }
    for (const name of envNames) {
      const prior = priorEnv[name];
      if (prior === undefined) delete process.env[name];
      else process.env[name] = prior;
    }
    const reportDir = resolve(".local/certification");
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(join(reportDir, "issue-170-live.json"), JSON.stringify(outcome, null, 2) + "\n");
    if (!cleanupError) {
      for (const name of ["state", "cache", "app"]) {
        rmSync(join(root, name), { recursive: true, force: true });
        cpSync(join(backup, name), join(root, name), { recursive: true, preserveTimestamps: true });
      }
      const restored = {
        head: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: saved.worktreeRoot, encoding: "utf8" }).trim(),
        review: hash(readFileSync(join(stateDir, "independent-reviews", sha + ".json"))),
        event: hash(readFileSync(join(stateDir, "event-items", "discovery.json"))),
        session: hash(readFileSync(sourceSessionFile)),
      };
      assert.deepEqual(restored, original, "The original failed job and transcripts were not restored");
      console.error("ISSUE170_RESTORED_ORIGINAL " + JSON.stringify(restored));
    } else {
      console.error("ISSUE170_PRESERVED_BACKUP_AVAILABLE " + backup);
      throw cleanupError;
    }
    console.error("ISSUE170_CERT_RESULT " + JSON.stringify(outcome));
  }
});
