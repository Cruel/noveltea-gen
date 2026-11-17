import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { originalEventFileDigest } from "../src/interactive-work.js";
import { assertOriginalChoiceRepairEvidence } from "../src/choice-repair-origin.js";
import type { JobStartResult } from "../src/job.js";
import { removeTestTree } from "./helpers.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("a reviewed later Event correction does not corrupt the immutable original Event author digest", () => {
  const repo = mkdtempSync(join(tmpdir(), "nt-event-source-lineage-"));
  try {
    const story = join(repo, "story");
    mkdirSync(join(story, "events"), { recursive: true });
    mkdirSync(join(story, "milestones"), { recursive: true });
    mkdirSync(join(story, "facts"), { recursive: true });
    const event = "events/arrival.md", milestone = "milestones/arrival.v1.md";
    const fact = "facts/arrival-trace.md";
    const firstEvent = "Original on-page observation.\n";
    const firstMilestone = "Original Milestone fulfillment.\n";
    const firstFact = "A source-grounded contemporaneous trace.\n";
    writeFileSync(join(story, event), firstEvent);
    writeFileSync(join(story, milestone), firstMilestone);
    writeFileSync(join(story, fact), firstFact);
    git(repo, "init", "-q");
    git(repo, "config", "user.name", "Test");
    git(repo, "config", "user.email", "test@example.invalid");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "Event original");
    const source = git(repo, "rev-parse", "HEAD");
    const fakeJob = { worktreeRoot: repo, worktreeStoryRoot: story, storyRelativePath: "story" } as JobStartResult;
    const paths = [event, milestone, fact];
    const expected = digest(JSON.stringify([
      [event, digest(firstEvent)], [milestone, digest(firstMilestone)], [fact, digest(firstFact)],
    ]));
    assert.equal(originalEventFileDigest(fakeJob, source, paths), expected);

    // A separately reviewed correction may change exactly this Story source
    // later; that new HEAD is not the original Event-design attestation.
    writeFileSync(join(story, event), "Independently corrected observation.\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "Separate review correction");
    assert.notEqual(git(repo, "rev-parse", "HEAD"), source);
    assert.equal(originalEventFileDigest(fakeJob, source, paths), expected);
    assert.notEqual(originalEventFileDigest(fakeJob, git(repo, "rev-parse", "HEAD"), paths), expected);
    assert.notEqual(originalEventFileDigest(fakeJob, source, paths), digest("tampered receipt"));
    assert.throws(() => originalEventFileDigest(fakeJob, "0".repeat(39), paths), /pinned Git commit/);
    assert.throws(() => originalEventFileDigest(fakeJob, source, ["../outside.md"]), /canonical Event paths/);
  } finally { removeTestTree(repo); }
});

test("second bounded Choice correction authenticates the original root rather than the first repair's SHA", () => {
  const original = "a".repeat(40), firstRepair = "b".repeat(40);
  const unit = {
    id: "interactive-choice-confrontation",
    phase: "committed",
    commitSha: original,
    paths: ["events/confrontation.md", "choice-points/position.md"],
    obligations: ["Preserve both conditional outcome payoffs."],
  };
  // The current rejected SHA is the failed FIRST correction, but the saved
  // Choice author unit remains attached to the original writer's commit.
  assert.notEqual(firstRepair, original);
  assert.doesNotThrow(() => assertOriginalChoiceRepairEvidence(unit, original));
  assert.throws(() => assertOriginalChoiceRepairEvidence(unit, firstRepair), /source-bound original unit/);
  for (const wrong of [
    { ...unit, phase: "writing" },
    { ...unit, commitSha: "c".repeat(40) },
    { ...unit, paths: [] },
    { ...unit, obligations: undefined },
  ]) assert.throws(() => assertOriginalChoiceRepairEvidence(wrong, original), /source-bound original unit/);
});
