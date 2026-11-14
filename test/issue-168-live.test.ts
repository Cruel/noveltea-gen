/**
 * Opt-in real #168 Event/Milestone correction against the preserved #158 Luna
 * negative checkpoint. An immutable backup is captured BEFORE starting any
 * controller or Pi call; the saved job and Git worktree are restored afterward.
 *
 * NT_TEST_168_LIVE=1 NT_TEST_168_ROOT=/tmp/nt158-... pnpm exec tsx --test test/issue-168-live.test.ts
 *
 * Do not run while another process uses the preserved private job directory.
 * The original negative source, receipt and reviewer transcript are never
 * replaced by a synthetic fixture verdict. Certification evidence is written
 * separately to .local/certification/issue-168-live.json.
 */
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { createControllerServer, SandboxController, type ControllerConfig } from "../web/src/sandbox-controller.js";
import { SandboxClient } from "../src/sandbox-client.js";
import { startStoryJob, type JobStartResult } from "../src/job.js";
import { inspectRecoveryCheckpoints } from "../src/recovery-checkpoints.js";
import { readIndependentReview } from "../src/checkpoint-assurance.js";
import { advanceRejectedRepair, inspectRejectedRepair } from "../src/rejected-review-repair.js";

const sha = "ae7ca52c90b062cc724155d458c42fb0bac53d17";
const hash = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const envNames = ["NT_STATE_DIR", "NT_GIT_CACHE_DIR", "NT_SKILL_CACHE_DIR",
  "NT_CONFIG_FILE", "NT_SANDBOX_SOCKET", "NT_SANDBOX_TOKEN_FILE", "NT_REQUIRE_SANDBOX_TOOLS",
  "NT_REQUIRE_USER_PI_RUNTIME"] as const;

test("live Luna corrects the sealed #158 Event and selected Milestone, then gets independent rereview", {
  skip: process.env.NT_TEST_168_LIVE !== "1" && "Opt in with NT_TEST_168_LIVE=1 and NT_TEST_168_ROOT",
  timeout: 900_000,
}, async () => {
  const root = resolve(process.env.NT_TEST_168_ROOT ?? "");
  assert.notEqual(root, resolve("."), "Supply a preserved private certification root explicitly.");
  assert.match(root, /^\/tmp\/nt158-[a-zA-Z0-9-]+$/, "Refuse a non-#158 root.");
  const state = join(root, "state");
  const cache = join(root, "cache");
  const app = join(root, "app");
  const jobNames = readdirSync(join(state, "jobs"));
  assert.equal(jobNames.length, 1);
  const originalManifest = JSON.parse(readFileSync(join(state, "jobs", jobNames[0]!, "job.json"), "utf8")) as
    JobStartResult;
  assert.equal(originalManifest.jobId, "2ff1be92-83b8-40b9-9e7a-ced9efb0abb9");
  const sourceReview = readFileSync(join(state, "jobs", jobNames[0]!, "independent-reviews",
    sha + ".json"));
  const sourceEvent = readFileSync(join(state, "jobs", jobNames[0]!, "event-items",
    "notice-absence.json"));
  const sourceSessionFile = JSON.parse(sourceEvent.toString("utf8")).sessionFile as string;
  const sourceSession = readFileSync(sourceSessionFile);
  const originalHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: originalManifest.worktreeRoot, encoding: "utf8" }).trim();
  assert.equal(originalHead, sha);
  assert.equal(execFileSync("git", ["status", "--porcelain"], {
    cwd: originalManifest.worktreeRoot, encoding: "utf8" }).trim(), "");
  const original = {
    head: originalHead, review: hash(sourceReview), event: hash(sourceEvent), session: hash(sourceSession),
  };
  const archive = mkdtempSync(join(tmpdir(), "nt168-preserved-backup-"));
  // Keep this recoverable backup even when the live session, controller or
  // process crashes. Never unlink it as part of a failed test.
  for (const name of ["state", "cache", "app"]) {
    cpSync(join(root, name), join(archive, name), { recursive: true, preserveTimestamps: true });
  }
  console.error("ISSUE168_PRESERVED_BACKUP " + archive);

  const priorEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  const nested = originalManifest.cacheRoot!;
  const socket = join(root, "controller", "issue-168-" + randomUUID() + ".sock");
  const tokenFile = join(root, "controller-token");
  const config: ControllerConfig = {
    socket, token: readFileSync(tokenFile, "utf8").trim(), appVolume: app, stateVolume: state,
    cacheVolume: cache, containerState: state, containerCache: cache,
    image: process.env.NT_TEST_SANDBOX_IMAGE ?? "noveltea-sandbox:local",
  };
  let controller: SandboxController | undefined;
  let server: ReturnType<typeof createControllerServer> | undefined;
  let failure: unknown;
  let outcome: Record<string, unknown> = { sourceCommit: sha, backup: archive,
    originalEvidence: original, model: "openai/gpt-6-luna", status: "not-run" };
  try {
    process.env.NT_STATE_DIR = state;
    process.env.NT_GIT_CACHE_DIR = nested;
    process.env.NT_SKILL_CACHE_DIR = join(root, "snapshots");
    process.env.NT_CONFIG_FILE = join(root, "local-config.json");
    process.env.NT_REQUIRE_SANDBOX_TOOLS = "1";
    delete process.env.NT_REQUIRE_USER_PI_RUNTIME;
    process.env.NT_SANDBOX_SOCKET = socket;
    process.env.NT_SANDBOX_TOKEN_FILE = tokenFile;
    const job = await startStoryJob({
      story: originalManifest.storyRoot, job: originalManifest.jobId,
    }, false);
    const point = (await inspectRecoveryCheckpoints(job)).find(p => p.commitSha === sha);
    assert.ok(point?.eligible, point?.reason ?? "source checkpoint not found");
    assert.equal(point.semanticReview, "failed");
    const sealed = await readIndependentReview(job, point.assurance!);
    assert.equal(sealed.status, "failed");
    assert.ok(sealed.result?.findings.some(f => f.path === "milestones/notice-absence.md"));
    controller = new SandboxController(config);
    server = createControllerServer(controller);
    server.listen(socket);
    await once(server, "listening");
    const client = new SandboxClient();
    assert.equal((await client.acquire(job.jobId)).status, "running");
    const result = await advanceRejectedRepair(job, sha, {
      skillsSource: resolve("../noveltea-skills"),
      provider: "openai", model: "gpt-6-luna",
    });
    const receipt = await inspectRejectedRepair(job, sha);
    const checkpoints = await inspectRecoveryCheckpoints(job);
    const successor = checkpoints.find(p => p.commitSha === receipt.repairedCommitSha);
    const review = successor?.assurance
      ? await readIndependentReview(job, successor.assurance) : null;
    const eventModified = receipt.paths?.includes("events/notice-absence.md") ?? false;
    const milestoneModified = receipt.paths?.includes("milestones/notice-absence.md") ?? false;
    outcome = { ...outcome, status: receipt.phase, result,
      repairedCommit: receipt.repairedCommitSha, attempts: receipt.attempts,
      changedPaths: receipt.paths, eventModified, milestoneModified,
      freshRereview: review?.status, originalVerdict: sealed.status,
      successorFindings: receipt.successorFindings,
      successorReview: review?.result, nativeValidation: successor?.validation,
      nativeProofDigest: receipt.validationProof, correctionPatch: receipt.repairedCommitSha
        ? execFileSync("git", ["diff", sha, receipt.repairedCommitSha,
          "--", "story/milestones/notice-absence.md"], {
            cwd: job.worktreeRoot, encoding: "utf8" }) : null,
      reviewerSessions: receipt.reviewer?.sessionFiles.length };
    assert.equal(result.next, "completed", JSON.stringify(result));
    assert.equal(receipt.phase, "passed", JSON.stringify(receipt));
    assert.equal(successor?.eligible, true, successor?.reason ?? "no successor checkpoint");
    assert.equal(successor?.semanticReview, "passed");
    assert.equal(review?.status, "passed");
    assert.ok(receipt.repairedCommitSha && receipt.repairedCommitSha !== sha);
    assert.ok((receipt.paths?.length ?? 0) > 0);
    assert.ok((receipt.reviewer?.sessionFiles.length ?? 0) > 0);
  } catch (error) {
    failure = error;
    outcome = { ...outcome, status: "failed", error: error instanceof Error ?
      error.stack ?? error.message : String(error) };
    throw error;
  } finally {
    let cleanupError: unknown;
    if (controller) {
      try { await controller.dispose(originalManifest.jobId); }
      catch (error) { cleanupError = error; }
    }
    if (server) {
      try { await new Promise<void>(done => server!.close(() => done())); }
      catch (error) { cleanupError ??= error; }
    }
    for (const name of envNames) {
      const value = priorEnv[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    const reportDir = resolve(".local/certification");
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(join(reportDir, "issue-168-live.json"), JSON.stringify(outcome, null, 2) + "\n");
    // The test owns this short-lived job invocation. Refuse to overwrite any
    // original state while a possible Docker writer remains active.
    if (!cleanupError) {
      for (const name of ["state", "cache", "app"]) {
        rmSync(join(root, name), { recursive: true, force: true });
        cpSync(join(archive, name), join(root, name), { recursive: true, preserveTimestamps: true });
      }
      const restored = {
        head: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: originalManifest.worktreeRoot, encoding: "utf8" }).trim(),
        review: hash(readFileSync(join(state, "jobs", jobNames[0]!, "independent-reviews",
          sha + ".json"))),
        event: hash(readFileSync(join(state, "jobs", jobNames[0]!, "event-items",
          "notice-absence.json"))),
        session: hash(readFileSync(sourceSessionFile)),
      };
      assert.deepEqual(restored, original, "Original Luna job/evidence was not restored.");
      console.error("ISSUE168_RESTORED_ORIGINAL " + JSON.stringify(restored));
    } else {
      console.error("ISSUE168_BACKUP_AVAILABLE " + archive);
      throw cleanupError;
    }
    if (failure) console.error("ISSUE168_CERT_FAILURE " + String(failure));
    console.error("ISSUE168_CERT_RESULT " + JSON.stringify(outcome));
  }
});
