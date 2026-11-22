import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { historicallyVisibleReview } from "../src/milestone-blueprint-correction.js";
import type { JobStartResult } from "../src/job.js";
import { approvalRevisionSeverity, classifyApprovalRevisionCause } from "../src/repair-ledger.js";

const original = "a".repeat(40);
const later = "b".repeat(40);

test("controller-backed post-approval origin classifications have distinct severity", () => {
  const samples = [
    { proof: { kind: "historical-contradiction" as const,
      originalSourceSha: original, verifiedSourceSha: original },
      cause: "approval-escape", severity: "warning" },
    { proof: { kind: "later-constraint" as const,
      originalSourceSha: original, verifiedSourceSha: later },
      cause: "newly-discovered-constraint", severity: "info" },
    { proof: { kind: "author-change" as const,
      originalSourceSha: original, authorizedAuthorChange: true },
      cause: "author-directed", severity: "info" },
    { proof: { kind: "unknown" as const,
      originalSourceSha: original, verifiedSourceSha: later },
      cause: "unclassified", severity: "warning" },
  ];
  for (const { proof, cause, severity } of samples) {
    assert.equal(classifyApprovalRevisionCause(proof), cause);
    assert.equal(approvalRevisionSeverity(cause as Parameters<typeof approvalRevisionSeverity>[0]), severity);
  }
});

test("#233 historical contradiction requires an actual source-line witness at the originally approved SHA", () => {
  const repo = mkdtempSync(join(tmpdir(), "nt-approval-historical-"));
  try {
    const file = "events/existing-event.md";
    const originalQuote = "The sealed archive register already shows the witness entered before the alleged lock.";
    mkdirSync(join(repo, "story/events"), { recursive: true });
    writeFileSync(join(repo, "story", file), originalQuote + "\n");
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.test");
    git("add", ".");
    git("commit", "-qm", "Original source visible at approval");
    const sourceSha = git("rev-parse", "HEAD");
    const job = { worktreeRoot: repo, storyRelativePath: "story" } as JobStartResult;
    const claim = { c: { pinDigest: "f".repeat(64), field: "events/0/knowledge",
      before: "The witness could not enter the archive before locking.",
      proposed: "The register proves an earlier entry.", sourceQuote: originalQuote },
      path: file, line: 1, origin: "reviewer" as const };
    assert.equal(historicallyVisibleReview(job, sourceSha, [claim], false, false), true);
    assert.equal(classifyApprovalRevisionCause({ kind: "historical-contradiction",
      originalSourceSha: sourceSha, verifiedSourceSha: sourceSha }), "approval-escape");
    assert.equal(historicallyVisibleReview(job, sourceSha, [
      { ...claim, c: { ...claim.c, sourceQuote: "Later, unverified model prose" } },
    ], false, false), false);
    assert.equal(historicallyVisibleReview(job, sourceSha, [claim], true, false), false,
      "a new Event-only decision is later evidence, not a historical approval escape");
    assert.equal(historicallyVisibleReview(job, sourceSha, [
      { ...claim, origin: "specialist" },
    ], false, false), false,
    "an unreviewed specialist suggestion cannot classify prior independent approval");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("Pi speculation or an after-approval Event cannot prove an approval escape or author consent", () => {
  assert.equal(classifyApprovalRevisionCause({ kind: "historical-contradiction",
    originalSourceSha: original, verifiedSourceSha: later }), "unclassified");
  assert.equal(classifyApprovalRevisionCause({ kind: "author-change",
    originalSourceSha: original }), "unclassified");
  assert.equal(classifyApprovalRevisionCause({ kind: "later-constraint",
    originalSourceSha: original, verifiedSourceSha: original }), "unclassified");
  assert.throws(() => classifyApprovalRevisionCause({ kind: "historical-contradiction",
    originalSourceSha: "not a SHA", verifiedSourceSha: later }), /Unverifiable/);
});
