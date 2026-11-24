/** Optional forensic check of the original #173 Choice rejection.
 * Historical review evidence must survive refusal of the retired execution
 * entrypoint. Current positive repair runs use the R14C Generation child. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { startStoryJob } from "../src/job.js";
import { inspectRecoveryCheckpoints } from "../src/recovery-checkpoints.js";
import { readIndependentReview } from "../src/checkpoint-assurance.js";

const root = process.env.NT_TEST_PRESERVED_FORK_REVIEW_ROOT;
const sha = "9029a67593f5974252a768f5cc0ff2d8d3b7c10c";
const jobId = "8b2f83f3-1b68-4891-aac6-74557b088350";
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

test(
  "S14 #173 historical Choice rejection remains inspectable but cannot authorize standalone repair",
  {
    skip:
      process.env.NT_ISSUE_173_LIVE_REPAIR !== "1" &&
      "Set NT_ISSUE_173_LIVE_REPAIR=1 to verify preserved historical evidence (no model calls)",
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
    const refused = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "job",
      "repair", "run", "--story", job.storyRoot, "--job", jobId, "--commit", sha],
      { encoding: "utf8", timeout: 30000 });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /retired.*Generation/i);
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
    assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), originalHead);
    assert.equal(git(job.worktreeRoot, "status", "--porcelain", "--untracked-files=all"), "");
  },
);
