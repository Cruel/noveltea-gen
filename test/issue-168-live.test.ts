/** Optional forensic regression for the preserved #158 Event rejection.
 * The pre-cutover receipt is evidence only. R14D tests current authenticated
 * Event native correction, independent rereview and restart separately. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { test } from "node:test";
import { startStoryJob, type JobStartResult } from "../src/job.js";
import { inspectRecoveryCheckpoints } from "../src/recovery-checkpoints.js";
import { readIndependentReview } from "../src/checkpoint-assurance.js";

const sha = "ae7ca52c90b062cc724155d458c42fb0bac53d17";
const hash = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
test("historical #158 Event rejection retains original evidence and refuses standalone repair", {
  skip: process.env.NT_TEST_168_LIVE !== "1" && "Opt in with NT_TEST_168_LIVE=1 and NT_TEST_168_ROOT (read-only evidence check)",
  timeout: 30_000,
}, async () => {
  const root = resolve(process.env.NT_TEST_168_ROOT ?? "");
  assert.notEqual(root, resolve("."), "Supply a preserved private certification root explicitly.");
  assert.match(root, /^\/tmp\/nt158-[a-zA-Z0-9-]+$/, "Refuse a non-#158 root.");
  const state = join(root, "state");
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
  const previous = process.env.NT_STATE_DIR;
  process.env.NT_STATE_DIR = state;
  try {
    const job = await startStoryJob({ story: originalManifest.storyRoot, job: originalManifest.jobId }, false);
    const point = (await inspectRecoveryCheckpoints(job)).find(p => p.commitSha === sha);
    assert.ok(point?.eligible && point.assurance, point?.reason ?? "source checkpoint not found");
    const sealed = await readIndependentReview(job, point.assurance);
    assert.equal(sealed.status, "failed");
    assert.ok(sealed.result?.findings.some(f => f.path === "milestones/notice-absence.md"));
    const refused = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "job", "repair",
      "run", "--story", job.storyRoot, "--job", job.jobId, "--commit", sha],
      { encoding: "utf8", timeout: 20_000 });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /retired.*Generation/i);
    const after = {
      head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: job.worktreeRoot, encoding: "utf8" }).trim(),
      review: hash(readFileSync(join(job.stateDir, "independent-reviews", sha + ".json"))),
      event: hash(readFileSync(join(job.stateDir, "event-items", "notice-absence.json"))),
      session: hash(readFileSync(sourceSessionFile)),
    };
    assert.deepEqual(after, original, "Historical rejection and writer transcript must remain unchanged");
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: job.worktreeRoot, encoding: "utf8" }).trim(), "");
  } finally {
    if (previous === undefined) delete process.env.NT_STATE_DIR; else process.env.NT_STATE_DIR = previous;
  }
});
