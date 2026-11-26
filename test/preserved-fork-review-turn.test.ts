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
import { verifyCertifiedRecoveryLineage } from "../src/certification-lineage.js";

const root = process.env.NT_TEST_PRESERVED_FORK_REVIEW_ROOT;

test(
  "reviewed first Event can become the exact source of a second isolated historical fork",
  { skip: !root && "Set NT_TEST_PRESERVED_FORK_REVIEW_ROOT to a saved certification root" },
  async () => {
    const saved = JSON.parse(readFileSync(join(root!, "certification-source.json"), "utf8")) as {
      storyRoot: string;
    };
    const original = await startStoryJob(
      { story: saved.storyRoot, job: "a4166778-a74d-4128-a283-95accc8705f1" },
      false,
    );
    const parent = await startStoryJob(
      { story: saved.storyRoot, job: "9836aacc-99ca-4f58-b101-b010c2887b72" },
      false,
    );
    const lineage = await verifyCertifiedRecoveryLineage(original, parent);
    assert.equal(lineage?.hops.length, 1);
    assert.equal(lineage?.terminalJobId, parent.jobId);
    const checkpoint = (await inspectRecoveryCheckpoints(parent)).find(
      (point) => point.commitSha === "3e753836cc70144c2497add8f5662dad67e7bdea",
    );
    assert.ok(checkpoint?.eligible && checkpoint.assurance);
    assert.equal(checkpoint.semanticReview, "passed");
    const approved = await readReviewTurnEvidence(parent);
    assert.ok(approved);
    const nested = await collectRecoveryFork(
      parent,
      "bcd45d21-8669-4a36-9d96-e2c364187e77",
      checkpoint.commitSha,
      approved.contract,
      process.env.NT_STUDIO_SKILLS_SOURCE,
    );
    assert.equal(nested.checkpoint.commitSha, checkpoint.commitSha);
    assert.equal(nested.sourceJobId, parent.jobId);
    assert.equal(
      nested.reviewTurn?.source.verifiedSha,
      original.baseSha,
      "The original author Turn remains the canonical reviewer evidence",
    );
    assert.equal(
      nested.reviewCoverage.find((entry) => entry.commitSha === checkpoint.commitSha)?.status,
      "passed",
    );
    const projected = projectReviewTurn(nested.reviewTurn!, {
      jobId: nested.childId,
      baseSha: checkpoint.commitSha,
    } as typeof parent);
    assert.equal(projected.source.verifiedSha, checkpoint.commitSha);
    assert.equal(projected.source.jobId, nested.childId);
  },
);

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

// Exact current-format reproduction: a new admitted writer Turn and historical
// no-write Review seals coexist. Read-only checks must consume the original
// projected Turn rather than relabeling the old verdict with new authority.
test("Luna nested continuation retains independently reviewed Event-only omissions after replacement Turn admission", {
  skip: !process.env.NT_TEST_PRESERVED_OMISSION_JOB || !root,
}, async () => {
  const { readInheritedReviewTurn } = await import("../src/fork-review-turn.js");
  const { readRecoveryFork } = await import("../src/recovery-fork-state.js");
  const { readEventOnlyOmission, readHistoricalEventOnlyOmission } = await import("../src/interactive-event-only.js");
  const { collectReviewedOmissionBatch } = await import("../src/recovery-review-batch.js");
  const saved = JSON.parse(readFileSync(join(root!, "certification-source.json"), "utf8"));
  const job = await startStoryJob({story:saved.storyRoot,job:process.env.NT_TEST_PRESERVED_OMISSION_JOB!},false);
  const fork = readRecoveryFork(job)!;
  assert.ok(fork.reviewBatch?.entries.length);
  const inherited = readInheritedReviewTurn(job)!;
  const local = (await readReviewTurnEvidence(job))!;
  assert.notEqual(local.digest, inherited.digest);
  for (const entry of fork.reviewBatch!.entries) {
    const slug = entry.milestoneId.slice(10);
    const receipt = JSON.parse(readFileSync(join(job.stateDir,"interactive-items",slug+".json"),"utf8"));
    const ref = receipt.units[0].eventOnly;
    const historical = await readHistoricalEventOnlyOmission(job,entry.milestoneId,ref);
    assert.equal(historical.turnDigest,inherited.digest);
    assert.deepEqual(await readEventOnlyOmission(job,entry.milestoneId,ref),historical);
  }
  const batch = await collectReviewedOmissionBatch(job,fork.checkpoint);
  assert.deepEqual(batch?.entries.map(e=>e.milestoneId),fork.reviewBatch!.entries.map(e=>e.milestoneId));
  assert.equal(batch?.turnDigest,local.digest);
});
