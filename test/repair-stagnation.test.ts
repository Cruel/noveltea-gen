import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectRepairStagnation, type RepairReceipt } from "../src/rejected-review-repair.js";
import { removeTestTree } from "./helpers.js";
import type { JobStartResult } from "../src/job.js";
import type { IndependentReviewResult } from "../src/checkpoint-assurance.js";

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
test("unchanged rejected source is no-progress; restoring an old rejected revision is oscillation", t => {
  const root = mkdtempSync(join(tmpdir(), "nt-repair-stagnation-"));
  t.after(() => removeTestTree(root));
  mkdirSync(join(root, "story", "events"), { recursive: true });
  git(root, "init", "-q");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.test");
  const event = join(root, "story/events/absence.md");
  const other = join(root, "story/events/other.md");
  writeFileSync(event, "The source-less inference.\n");
  writeFileSync(other, "A second Event.\n");
  git(root, "add", "."); git(root, "commit", "-qm", "Original failed source");
  const initial = git(root, "rev-parse", "HEAD");
  writeFileSync(other, "A revised but unrelated Event.\n");
  git(root, "add", "."); git(root, "commit", "-qm", "Unrelated edit");
  const unrelated = git(root, "rev-parse", "HEAD");
  const job = { worktreeRoot: root, storyRelativePath: "story" } as JobStartResult;
  const state = {
    rootFailureSha: initial, sourceCommitSha: initial, repairedCommitSha: unrelated,
    findings: [{ path: "events/absence.md", kind: "continuity",
      message: "The inference is unsupported." }],
  } as RepairReceipt;
  const review = { status: "failed", findings: [{ path: "events/absence.md", kind: "continuity",
    message: "Still unsupported." }] } as IndependentReviewResult;
  assert.equal(detectRepairStagnation(job, state, review), "no-progress");

  writeFileSync(event, "A corrected account from the caretaker.\n");
  git(root, "add", "."); git(root, "commit", "-qm", "First attempted fix");
  const changed = git(root, "rev-parse", "HEAD");
  writeFileSync(event, "The source-less inference.\n");
  git(root, "add", "."); git(root, "commit", "-qm", "Reverted fix");
  const reverted = git(root, "rev-parse", "HEAD");
  assert.equal(detectRepairStagnation(job, { ...state, sourceCommitSha: changed,
    repairedCommitSha: reverted }, review), "oscillation");
  assert.equal(detectRepairStagnation(job, { ...state, sourceCommitSha: changed,
    repairedCommitSha: reverted }, { ...review, status: "passed", findings: [] }), null);
});
