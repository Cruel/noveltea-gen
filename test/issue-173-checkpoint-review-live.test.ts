/** Opt-in source-bound review of the preserved #173 Luna Choice checkpoint.
 * Offline preflight uses zero model tokens. Live mode invokes only the
 * independent read-only reviewer; it never replays the Choice writer.
 * Source Job, Git HEAD and checked-out Story bytes must remain unchanged.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startStoryJob } from "../src/job.js";
import { inspectRecoveryCheckpoints } from "../src/recovery-checkpoints.js";
import { prepareSemanticReview, runPiAssignmentReview } from "../src/semantic-assignment-review.js";
import { withStoryJobLock } from "../src/job-lock.js";
import { createSkillSnapshot } from "../src/snapshot.js";
import { readIndependentReview } from "../src/checkpoint-assurance.js";
import {
  createControllerServer,
  SandboxController,
  type ControllerConfig,
} from "../web/src/sandbox-controller.js";
import { SandboxClient } from "../src/sandbox-client.js";

const root = process.env.NT_TEST_PRESERVED_FORK_REVIEW_ROOT;
const sha = "9029a67593f5974252a768f5cc0ff2d8d3b7c10c";
const sourceJob = "8b2f83f3-1b68-4891-aac6-74557b088350";
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

async function context() {
  assert.ok(root, "Specify the preserved certification root");
  const manifest = JSON.parse(readFileSync(join(root, "certification-source.json"), "utf8")) as {
    storyRoot: string;
  };
  const job = await startStoryJob({ story: manifest.storyRoot, job: sourceJob }, false);
  const checkpoint = (await inspectRecoveryCheckpoints(job)).find((p) => p.commitSha === sha);
  assert.ok(checkpoint?.eligible && checkpoint.assurance, checkpoint?.reason ?? "No eligible checkpoint");
  assert.equal(checkpoint.workItem, "interactive-choice-accounts-tested");
  assert.equal(checkpoint.assurance.reviewSelection.status, "required-pending");
  git(job.worktreeRoot, "merge-base", "--is-ancestor", sha, "HEAD");
  const packet = await prepareSemanticReview(job, [checkpoint]);
  assert.equal(packet.items.length, 1);
  assert.equal(packet.items[0]!.reviewedWorkItem, checkpoint.workItem);
  return { job, checkpoint, packet };
}

test(
  "S14 #173 preserved pending Choice review is reproducible without Pi",
  {
    skip: !root && "Set NT_TEST_PRESERVED_FORK_REVIEW_ROOT",
  },
  async () => {
    const { job, checkpoint, packet } = await context();
    assert.equal(packet.items[0]!.assurance.commitSha, sha);
    assert.ok(packet.items[0]!.diff.includes("choice-points/response-to-passengers.md"));
    assert.ok(packet.items[0]!.unitOutcome.includes("Choice-point unit"));
    const original = readFileSync(join(job.stateDir, "recovery-checkpoints", sha + ".json"), "utf8");
    assert.equal(original.includes(checkpoint.proofDigest), true);
    git(job.worktreeRoot, "merge-base", "--is-ancestor", sha, "HEAD");
  },
);

test(
  "S14 #173 live independent Choice reviewer seals a source-bound verdict, without replaying writer",
  {
    skip:
      process.env.NT_ISSUE_173_LIVE_REVIEW !== "1" &&
      "Explicit NT_ISSUE_173_LIVE_REVIEW=1 required for a paid Luna review",
  },
  async () => {
    const { job, checkpoint } = await context();
    const before = {
      head: git(job.worktreeRoot, "rev-parse", "HEAD"),
      status: git(job.worktreeRoot, "status", "--porcelain", "--untracked-files=all"),
      checkpoint: readFileSync(join(job.stateDir, "recovery-checkpoints", sha + ".json"), "utf8"),
    };
    // Avoid Linux AF_UNIX path length limits for deeply nested preserved runs.
    const controllerDir = mkdtempSync(join(tmpdir(), "nt173-review-"));
    const config: ControllerConfig = {
      socket: join(controllerDir, "controller.sock"),
      token: readFileSync(join(root!, "controller-token"), "utf8").trim(),
      appVolume: join(root!, "app"),
      stateVolume: join(root!, "state"),
      cacheVolume: join(root!, "cache"),
      containerState: join(root!, "state"),
      containerCache: join(root!, "cache"),
      image: process.env.NT_TEST_SANDBOX_IMAGE ?? "noveltea-sandbox:local",
    };
    const prior = Object.fromEntries(
      ["NT_SANDBOX_SOCKET", "NT_SANDBOX_TOKEN_FILE", "NT_REQUIRE_SANDBOX_TOOLS"].map((name) => [
        name,
        process.env[name],
      ]),
    );
    const controller = new SandboxController(config);
    const server = createControllerServer(controller);
    let result: Awaited<ReturnType<typeof runPiAssignmentReview>>;
    try {
      server.listen(config.socket);
      await once(server, "listening");
      process.env.NT_SANDBOX_SOCKET = config.socket;
      process.env.NT_SANDBOX_TOKEN_FILE = join(root!, "controller-token");
      process.env.NT_REQUIRE_SANDBOX_TOOLS = "1";
      const client = new SandboxClient();
      assert.equal((await client.acquire(job.jobId)).status, "running");
      const snapshot = await createSkillSnapshot({
        discovery: "explicit-only",
        novelteaSkills: process.env.NT_STUDIO_SKILLS_SOURCE!,
        skillDirs: [],
        requiredSkills: ["nt-narrative-review", "nt-catalog"],
      });
      assert.ok(snapshot);
      result = await withStoryJobLock(job, "independent-assignment-review", () =>
        runPiAssignmentReview(job, [checkpoint], {
          snapshot,
          provider: "openai",
          model: "gpt-6-luna",
          reviewer: "independent-pi-assignment-review",
          onSession: async (file) => {
            console.error("Independent review session:", file);
          },
        }),
      );
    } finally {
      try {
        await controller.dispose(job.jobId);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(controllerDir, { recursive: true, force: true });
        for (const [key, value] of Object.entries(prior)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    }
    const review = await readIndependentReview(job, checkpoint.assurance!);
    assert.ok(["passed", "failed"].includes(review.status));
    assert.equal(result.verdict.verdict === "pass", review.status === "passed");
    assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), before.head);
    assert.equal(git(job.worktreeRoot, "status", "--porcelain", "--untracked-files=all"), before.status);
    assert.equal(
      readFileSync(join(job.stateDir, "recovery-checkpoints", sha + ".json"), "utf8"),
      before.checkpoint,
      "The reviewer may seal its decision, never rewrite the original checkpoint",
    );
    console.error(
      "S14 #173 REPLAY REVIEW:",
      JSON.stringify({
        commitSha: sha,
        verdict: review.status,
        findings: result.verdict.findings,
      }),
    );
  },
);
