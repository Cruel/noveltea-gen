import assert from "node:assert/strict";
import { test } from "node:test";
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
