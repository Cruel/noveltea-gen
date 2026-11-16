/** Saved, offline #173 review-context regression. No Pi or Story writes. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { startStoryJob } from "../src/job.js";
import { inspectRecoveryCheckpoints } from "../src/recovery-checkpoints.js";
import { prepareSemanticReview } from "../src/semantic-assignment-review.js";

const root = process.env.NT_TEST_PRESERVED_FORK_REVIEW_ROOT;
test("a repaired Choice reviewer sees BOTH sealed outcome Event consumers", {
  skip: !root && "Set NT_TEST_PRESERVED_FORK_REVIEW_ROOT",
}, async () => {
  const source = JSON.parse(readFileSync(join(root!, "certification-source.json"), "utf8")) as {
    storyRoot: string;
  };
  const job = await startStoryJob({ story: source.storyRoot,
    job: "123663dd-304a-48ec-be82-a9dc44b65309" }, false);
  const sha = "7a8a70cffcfd9831d57ceaa4c36d1955b7dfd9c5";
  const point = (await inspectRecoveryCheckpoints(job)).find(p => p.commitSha === sha);
  assert.ok(point?.eligible);
  const packet = await prepareSemanticReview(job, [point]);
  const context = packet.items[0]!.canonicalContext;
  assert.ok(context.some(record => record.path === "events/share-bounded-account.md"));
  assert.ok(context.some(record => record.path === "events/keep-report-narrow.md"),
    "Reviewers must see the preexisting, read-only narrow-report consequence.");
  assert.ok(packet.items[0]!.readOnlyPaths.includes("events/keep-report-narrow.md"),
    "A reviewer context dependency must not add writer permission.");
});
