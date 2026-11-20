import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { removeTestTree } from "./helpers.js";
import type { JobStartResult } from "../src/job.js";
import { repairProgressScope, validateEditorialRepairDiagnosis,
  productiveEditorialRepair } from "../src/editorial-repair-progress.js";
import { checkEditorialVerdict, type ReviewAssignment } from "../src/narrative-review-specialist.js";

const git = (dir: string, ...args: string[]) => execFileSync("git", args,
  { cwd: dir, encoding: "utf8" }).trim();
test("#211: both correction loops require source-grounded review progress, not changed commit identity", t => {
  const root = mkdtempSync(join(tmpdir(), "nt-editorial-convergence-"));
  t.after(() => removeTestTree(root));
  const story = join(root, "story"), dir = join(story, "events");
  mkdirSync(dir, { recursive: true });
  git(root, "init", "-q");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.invalid");
  const path = "events/ledger.md";
  writeFileSync(join(dir, "ledger.md"), "The chronology contradicts the witness.\n");
  git(root, "add", "."); git(root, "commit", "-qm", "Original defective chronology");
  const first = git(root, "rev-parse", "HEAD");
  // A cosmetic commit changes HEAD without resolving the historical blocker.
  writeFileSync(join(dir, "ledger.md"), "The chronology still contradicts the witness.\n");
  git(root, "add", "."); git(root, "commit", "-qm", "Cosmetic rewording");
  const second = git(root, "rev-parse", "HEAD");
  const job = { worktreeRoot: root, storyRelativePath: "story" } as JobStartResult;
  const original = [{ severity: "blocking", source: path + ":1",
    message: "The timeline is inconsistent with what the witness could observe." }];
  const scope = repairProgressScope(job, first, second, [path], original);
  const assignment: ReviewAssignment = { contract: {}, planVersion: 1,
    scopeIds: ["event.ledger"], paths: [path], routes: [], milestoneRoutes: [],
    puzzleRoutes: [], outstanding: [], uncertainties: [], progressScope: scope };
  const blocked = { verdict: "block", findings: [{ severity: "blocking",
    dimension: "continuity", source: path + ":1",
    message: original[0]!.message, repair: "event" }], evidence: [] };
  assert.throws(() => checkEditorialVerdict(blocked, assignment),
    /Source-grounded editorial convergence diagnosis/);
  const stagnant = checkEditorialVerdict({ ...blocked,
    progressDiagnosis: { status: "stalled", reason: "The original contradiction is still present.", evidence: null },
  }, assignment);
  assert.equal(productiveEditorialRepair(stagnant.progressDiagnosis, true), false,
    "A new SHA with unresolved same defect must stop the next automatic correction.");
  const claimed = { status: "material",
    reason: "A new fragment resolves the inconsistent timeline.",
    evidence: { path, quote: "Unsupported proof from previous canon" } };
  assert.throws(() => validateEditorialRepairDiagnosis(claimed, scope),
    /newly added canonical citation/);
  // Independent reviewer may allow additional source-grounded corrections
  // when there is a genuine cited change, without a hard attempt quota.
  const added = { status: "material",
    reason: "The new line clarifies that the witness timeline is uncertain.",
    evidence: { path, quote: "still contradicts the witness" } };
  const progressing = checkEditorialVerdict({ ...blocked,
    progressDiagnosis: added }, assignment);
  assert.equal(productiveEditorialRepair(progressing.progressDiagnosis, true), true);
  assert.equal(productiveEditorialRepair(undefined, false), true);
});
