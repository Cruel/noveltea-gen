/** Opt-in #173 bounded original-session Choice repair after the exact saved
 * reviewer failure. Uses the same registered rootless sandbox as Studio.
 * Never starts a new Choice writer or replaces prior Git/review evidence.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createControllerServer,
  SandboxController,
  type ControllerConfig,
} from "../web/src/sandbox-controller.js";
import { SandboxClient } from "../src/sandbox-client.js";
import { startStoryJob } from "../src/job.js";
import { inspectRecoveryCheckpoints } from "../src/recovery-checkpoints.js";
import { readIndependentReview } from "../src/checkpoint-assurance.js";
import { advanceRejectedRepair, inspectRejectedRepair } from "../src/rejected-review-repair.js";

const root = process.env.NT_TEST_PRESERVED_FORK_REVIEW_ROOT;
const sha = "9029a67593f5974252a768f5cc0ff2d8d3b7c10c";
const jobId = "8b2f83f3-1b68-4891-aac6-74557b088350";
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

test(
  "S14 #173 failed Choice review receives bounded original-session repair and independent rereview",
  {
    skip:
      process.env.NT_ISSUE_173_LIVE_REPAIR !== "1" &&
      "Set NT_ISSUE_173_LIVE_REPAIR=1 for the paid, sandboxed original-session correction",
    timeout: 900_000,
  },
  async () => {
    assert.ok(root, "A private preserved certification root is required");
    const source = JSON.parse(readFileSync(join(root, "certification-source.json"), "utf8")) as {
      storyRoot: string;
    };
    const job = await startStoryJob({ story: source.storyRoot, job: jobId }, false);
    const sourcePoint = (await inspectRecoveryCheckpoints(job)).find((p) => p.commitSha === sha);
    assert.ok(sourcePoint?.eligible && sourcePoint.assurance);
    const negative = await readIndependentReview(job, sourcePoint.assurance);
    assert.equal(negative.status, "failed", "A repair requires a sealed real independent rejection");
    assert.ok(
      negative.result?.findings.some(
        (f) =>
          f.path === "events/share-bounded-account.md" &&
          f.affectedPaths?.includes("choice-points/response-to-passengers.md"),
      ),
    );
    const originalHead = git(job.worktreeRoot, "rev-parse", "HEAD");
    assert.equal(originalHead, sha, "Do not try to repair from a newer or dirty source");
    assert.equal(git(job.worktreeRoot, "status", "--porcelain", "--untracked-files=all"), "");
    const savedSourceCheckpoint = readFileSync(
      join(job.stateDir, "recovery-checkpoints", sha + ".json"),
      "utf8",
    );
    const savedNegative = readFileSync(join(job.stateDir, "independent-reviews", sha + ".json"), "utf8");
    const temporary = mkdtempSync(join(tmpdir(), "nt173-repair-"));
    const config: ControllerConfig = {
      socket: join(temporary, "controller.sock"),
      token: readFileSync(join(root, "controller-token"), "utf8").trim(),
      appVolume: join(root, "app"),
      stateVolume: join(root, "state"),
      cacheVolume: join(root, "cache"),
      containerState: join(root, "state"),
      containerCache: join(root, "cache"),
      image: process.env.NT_TEST_SANDBOX_IMAGE ?? "noveltea-sandbox:local",
    };
    const tracked = ["NT_SANDBOX_SOCKET", "NT_SANDBOX_TOKEN_FILE", "NT_REQUIRE_SANDBOX_TOOLS"];
    const prior = Object.fromEntries(tracked.map((key) => [key, process.env[key]]));
    const controller = new SandboxController(config);
    const server = createControllerServer(controller);
    let next: Awaited<ReturnType<typeof advanceRejectedRepair>>;
    try {
      server.listen(config.socket);
      await once(server, "listening");
      process.env.NT_SANDBOX_SOCKET = config.socket;
      process.env.NT_SANDBOX_TOKEN_FILE = join(root, "controller-token");
      process.env.NT_REQUIRE_SANDBOX_TOOLS = "1";
      assert.equal((await new SandboxClient().acquire(jobId)).status, "running");
      next = await advanceRejectedRepair(job, sha, {
        skillsSource: process.env.NT_STUDIO_SKILLS_SOURCE,
        provider: "openai",
        model: "gpt-6-luna",
      });
    } finally {
      try {
        await controller.dispose(jobId);
      } finally {
        await new Promise<void>((done) => server.close(() => done()));
        rmSync(temporary, { recursive: true, force: true });
        for (const [key, value] of Object.entries(prior)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    }
    const receipt = await inspectRejectedRepair(job, sha);
    const latest = (await inspectRecoveryCheckpoints(job)).find(
      (p) => p.commitSha === receipt.repairedCommitSha,
    );
    console.error(
      "S14 #173 LIVE REPAIR",
      JSON.stringify({
        next: next.next,
        phase: receipt.phase,
        repairedCommitSha: receipt.repairedCommitSha,
        reviewStatus: latest?.semanticReview,
        findings: receipt.successorFindings,
      }),
    );
    assert.equal(
      readFileSync(join(job.stateDir, "recovery-checkpoints", sha + ".json"), "utf8"),
      savedSourceCheckpoint,
      "Original checkpoint cannot be rewritten by the repair",
    );
    assert.equal(
      readFileSync(join(job.stateDir, "independent-reviews", sha + ".json"), "utf8"),
      savedNegative,
      "Original negative verdict cannot be rewritten by the repair",
    );
    assert.equal(next.next, "completed", "Unresolved review correction remains blocked");
    assert.equal(receipt.phase, "passed");
    assert.equal(latest?.eligible, true);
    assert.equal(latest?.semanticReview, "passed");
    assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), receipt.repairedCommitSha);
  },
);
