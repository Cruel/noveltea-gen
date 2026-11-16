/** Opt-in, read-only regression against a privately preserved certified Luna
 * repair. Never mutate real Story worktrees or sealed review receipts. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { startStoryJob } from "../src/job.js";
import { verifiedNarrativeChain } from "../src/job-successor.js";
import { inspectRejectedRepair } from "../src/rejected-review-repair.js";
import { readReviewTurnEvidence } from "../src/fork-review-turn.js";
import { collectRecoveryFork } from "../src/recovery-fork.js";

const root = process.env.NT_TEST_PRESERVED_FORK_REVIEW_ROOT;
const original = "2127e9afd42d43f22a4efef05109ee2ca7d29754";
const repaired = "1f030a7f345ee0e73cdc47919d16aff45dec5002";
const priorEvent = "42451fbf1231c0854cbb9c3c419465db3f4ece0c";
const inheritedEvent = "e3de2c884d54398e18e90de05731da3513d9b826";

test(
  "S14 #173: nested fork authenticates original Job's passed repair trailer",
  {
    skip: !root && "Set NT_TEST_PRESERVED_FORK_REVIEW_ROOT to the saved run",
  },
  async () => {
    const source = JSON.parse(readFileSync(join(root!, "certification-source.json"), "utf8")) as {
      storyRoot: string;
    };
    const child = await startStoryJob(
      { story: source.storyRoot, job: "e47c3254-bd92-4bd3-9341-97798bd079c8" },
      false,
    );
    assert.equal(
      await verifiedNarrativeChain(child, inheritedEvent, repaired),
      repaired,
      "Inherited reviewed work and the source Job's separately passed repair remain valid.",
    );
  },
);

test(
  "S14 #173: only exact independently passed original-session Choice repair is an allowed successor",
  {
    skip: !root && "Set NT_TEST_PRESERVED_FORK_REVIEW_ROOT to the saved run",
  },
  async () => {
    const source = JSON.parse(readFileSync(join(root!, "certification-source.json"), "utf8")) as {
      storyRoot: string;
    };
    const job = await startStoryJob(
      { story: source.storyRoot, job: "5b23db8c-12d5-4979-b5b2-8060742115cb" },
      false,
    );
    const repair = await inspectRejectedRepair(job, original);
    assert.equal(repair.phase, "passed");
    assert.equal(repair.repairedCommitSha, repaired);
    assert.equal(await verifiedNarrativeChain(job, original, repaired), repaired);
    assert.equal(
      await verifiedNarrativeChain(job, priorEvent, repaired),
      repaired,
      "Reviewed Choice plus exact passed correction is safe to traverse.",
    );
    assert.equal(
      await verifiedNarrativeChain(job, inheritedEvent, repaired),
      repaired,
      "Reviewed inherited Event and reviewed successor commits cannot trigger false impact blocks.",
    );
    const originalTurn = await readReviewTurnEvidence(job);
    assert.ok(originalTurn);
    const fork = await collectRecoveryFork(
      job,
      "a58367ce-64d9-49e2-ac58-fd57bf48fccc",
      repaired,
      originalTurn.contract,
      process.env.NT_STUDIO_SKILLS_SOURCE,
    );
    assert.equal(fork.checkpoint.commitSha, repaired);
    assert.equal(fork.checkpoint.workItem, "repair-" + original);
    assert.equal(fork.reviewCoverage.find((item) => item.commitSha === original)?.status, "failed");
    assert.equal(fork.reviewCoverage.find((item) => item.commitSha === repaired)?.status, "passed");
    assert.ok(fork.reviewTurn && fork.reviewTurn.assignments.some((a) => a.id === "interactive"));
    assert.equal(fork.completedStages.filter((stage) => stage.stage === "foundation").length, 1);
  },
);
