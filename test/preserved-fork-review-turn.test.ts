/** Opt-in verification against an EXISTING preserved and authenticated Job.
 * Read-only: never allocates or starts a child, invokes Pi or changes Story.
 * The saved private Story is deliberately not checked into test fixtures. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { startStoryJob } from "../src/job.js";
import { collectRecoveryFork } from "../src/recovery-fork.js";
import { readReviewTurnEvidence, projectReviewTurn } from "../src/fork-review-turn.js";
import { inspectRecoveryCheckpoints } from "../src/recovery-checkpoints.js";

const root = process.env.NT_TEST_PRESERVED_FORK_REVIEW_ROOT;

test(
  "verified historical Character checkpoint admits a review-only original Turn for new Event work",
  {
    skip: !root && "Set NT_TEST_PRESERVED_FORK_REVIEW_ROOT to a saved certification root",
  },
  async () => {
    const saved = JSON.parse(readFileSync(join(root!, "certification-source.json"), "utf8")) as {
      storyRoot: string;
    };
    const source = await startStoryJob(
      { story: saved.storyRoot, job: "a4166778-a74d-4128-a283-95accc8705f1" },
      false,
    );
    const turn = await readReviewTurnEvidence(source);
    assert.ok(turn);
    const original = await collectRecoveryFork(
      source,
      "a47fba52-54f6-43e5-9854-f1bb25a7c99b",
      "b237d8237ce70810a5de89d18d2411b81b2bfee4",
      turn.contract,
      process.env.NT_STUDIO_SKILLS_SOURCE,
    );
    assert.equal(original.reviewTurn?.digest, turn.digest);
    assert.equal(
      original.reviewTurn?.assignments.find((a) => a.id === "event")?.specialist,
      "nt-event-design",
    );
    const child = { jobId: original.childId, baseSha: original.checkpoint.commitSha };
    const review = projectReviewTurn(original.reviewTurn!, child as typeof source);
    assert.notEqual(review.digest, turn.digest);
    assert.equal(review.source.verifiedSha, original.checkpoint.commitSha);
    assert.equal(review.source.jobId, original.childId);
    assert.equal(
      review.assignments.find((a) => a.id === "event")?.outcome,
      turn.assignments.find((a) => a.id === "event")?.outcome,
    );
  },
);

test(
  "preserved legacy fork reproduces the exact unreviewed Event checkpoint bypass",
  {
    skip: !root && "Set NT_TEST_PRESERVED_FORK_REVIEW_ROOT to a saved certification root",
  },
  async () => {
    const saved = JSON.parse(readFileSync(join(root!, "certification-source.json"), "utf8")) as {
      storyRoot: string;
    };
    const child = await startStoryJob(
      { story: saved.storyRoot, job: "86723188-b5aa-4cc9-9169-c034674bac9f" },
      false,
    );
    assert.equal(await readReviewTurnEvidence(child), null);
    const points = (await inspectRecoveryCheckpoints(child)).filter((p) => p.eligible);
    assert.equal(
      points.length,
      3,
      "The original incident, accounts and enacted Choice Events were committed",
    );
    assert.ok(
      points.every((p) => !p.assurance),
      "The historical bug was accepting native commits without independent-review evidence",
    );
    assert.deepEqual(
      points.map((p) => p.workItem),
      ["event-incident-identified", "event-accounts-tested", "event-choice-enacted"],
    );
  },
);
