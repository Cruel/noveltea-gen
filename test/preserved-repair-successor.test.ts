/** Opt-in, read-only regression against a privately preserved certified Luna
 * repair. Never mutate real Story worktrees or sealed review receipts. */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { startStoryJob } from "../src/job.js";
import { verifiedNarrativeChain } from "../src/job-successor.js";
import { inspectRejectedRepair } from "../src/rejected-review-repair.js";
import { readReviewTurnEvidence } from "../src/fork-review-turn.js";
import { collectRecoveryFork } from "../src/recovery-fork.js";
import { inspectRecoveryCheckpoints, finalizeRecoveryCheckpoint } from "../src/recovery-checkpoints.js";
import { puzzleObligation } from "../src/puzzle-obligation.js";
import type { Plan } from "../src/architecture.js";

const root = process.env.NT_TEST_PRESERVED_FORK_REVIEW_ROOT;
const original = "2127e9afd42d43f22a4efef05109ee2ca7d29754";
const repaired = "1f030a7f345ee0e73cdc47919d16aff45dec5002";
const priorEvent = "42451fbf1231c0854cbb9c3c419465db3f4ece0c";
const inheritedEvent = "e3de2c884d54398e18e90de05731da3513d9b826";

test(
  "S14 #173 inherited approved Story Turn keeps formal Puzzles optional without a local Turn grant",
  {
    skip: !root && "Set NT_TEST_PRESERVED_FORK_REVIEW_ROOT to the saved run",
  },
  async () => {
    const source = JSON.parse(readFileSync(join(root!, "certification-source.json"), "utf8")) as {
      storyRoot: string;
    };
    const job = await startStoryJob(
      { story: source.storyRoot, job: "09532e4b-8905-4040-86c2-cf2cc14a5172" },
      false,
    );
    assert.equal(
      existsSync(join(job.stateDir, "turn-plan.json")),
      false,
      "Fork must not manufacture local author approval or writer authority.",
    );
    const original = await readReviewTurnEvidence(job);
    assert.ok(original?.objective);
    const saved = JSON.parse(readFileSync(join(job.stateDir, "architecture.json"), "utf8")) as {
      plan: Plan;
    };
    for (const slug of ["accounts-tested", "choice-enacted"]) {
      const event = JSON.parse(readFileSync(join(job.stateDir, "event-items", slug + ".json"), "utf8")) as {
        obligations?: string[];
        validation?: { eventIds?: string[] };
      };
      const requirement = await puzzleObligation(
        job,
        saved.plan,
        [],
        event.validation?.eventIds ?? [],
        event.obligations ?? [],
      );
      assert.equal(
        requirement.required,
        false,
        slug +
          " must not inherit a mandatory formal Puzzle from a deferred stage: " +
          JSON.stringify(requirement.reasons),
      );
      assert.equal(
        requirement.turnDigest,
        original.digest,
        "Optional-Puzzle proof must bind to the child-projected immutable original Turn.",
      );
    }
  },
);

test(
  "historical fork checkpoint accepts a source-bound, already completed review repair",
  {
    skip: !root && "Set NT_TEST_PRESERVED_FORK_REVIEW_ROOT to the saved run",
  },
  async () => {
    const source = JSON.parse(readFileSync(join(root!, "certification-source.json"), "utf8")) as {
      storyRoot: string;
    };
    const job = await startStoryJob(
      { story: source.storyRoot, job: "8b2f83f3-1b68-4891-aac6-74557b088350" },
      false,
    );
    const checkpointSha = "9029a67593f5974252a768f5cc0ff2d8d3b7c10c";
    const file = join(job.stateDir, "recovery-checkpoints", checkpointSha + ".json");
    const before = readFileSync(file, "utf8");
    const points = await inspectRecoveryCheckpoints(job);
    const point = points.find((entry) => entry.commitSha === checkpointSha);
    assert.ok(point?.eligible, point?.reason ?? "The verified Choice checkpoint was not found.");
    assert.ok(point.completedWorkItems.includes("repair-" + original));
    assert.equal(point.workItem, "interactive-choice-accounts-tested");
    assert.equal(point.validation.status, "passed");
    const resumed = await finalizeRecoveryCheckpoint(job, point.workItem, point.parentSha, checkpointSha);
    assert.equal(
      resumed.commitSha,
      checkpointSha,
      "Idempotent finalization must reuse the original specialist commit, not dispatch Pi.",
    );
    assert.equal(
      readFileSync(file, "utf8"),
      before,
      "Inspection and restart must not rewrite the saved checkpoint.",
    );
    const turn = await readReviewTurnEvidence(job);
    assert.ok(turn);
    const fork = await collectRecoveryFork(
      job,
      "599be32f-45a7-4aec-9f55-97bdbd97aef1",
      checkpointSha,
      turn.contract,
      process.env.NT_STUDIO_SKILLS_SOURCE,
    );
    assert.equal(fork.checkpoint.commitSha, checkpointSha);
    assert.ok(fork.checkpoint.completedWorkItems.includes("repair-" + original));
    assert.equal(
      fork.reviewCoverage.find((entry) => entry.commitSha === checkpointSha)?.status,
      "failed",
      "The original negative verdict must remain visible on a fork of the pre-repair checkpoint.",
    );
    assert.equal(readFileSync(file, "utf8"), before, "Preparing a fork cannot rewrite the source evidence.");
  },
);

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
