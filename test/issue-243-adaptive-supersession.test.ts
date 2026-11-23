/** #243 C06: the original admitted Pi plan and later rejection survive an
 * independently signed controller successor. The successor cannot alter
 * historical receipts or authorize an arbitrary blocked writer. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobStartResult } from "../src/job.js";
import { pendingDigest } from "../src/pending-work-amendments.js";
import { createSkillSnapshot } from "../src/snapshot.js";
import { admitAdaptiveSupersession, assertAdaptiveSettled, beginAdaptiveAttempt,
  emptyAdaptiveState, readAdaptiveState, settleAdaptiveAttempt } from "../src/adaptive-state.js";

const turn = "a".repeat(64);
function setup() {
  const root = mkdtempSync(join(tmpdir(), "nt-c06-plan-"));
  const git = (...args: string[]) => execFileSync("git", args, {
    cwd: root, encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  mkdirSync(join(root, "skills", "test"), { recursive: true });
  writeFileSync(join(root, "skills/test/SKILL.md"), "---\nname: test\n---\nfixture");
  mkdirSync(join(root, "milestones"), { recursive: true });
  writeFileSync(join(root, "milestones/wrong-credit.md"), "Source-grounded incident\n");
  git("add", "."); git("commit", "-qm", "Reviewed source baseline");
  const head = git("rev-parse", "HEAD");
  const job = { stateDir: root, worktreeRoot: root, baseSha: head,
    threadId: "thread", jobId: "job", branch: git("symbolic-ref", "--short", "HEAD") } as JobStartResult;
  return { root, job, head, git };
}

test("#243: versioned source-bound supersession preserves original adaptive proposal and rejected Pi attempt", async () => {
  const f = setup();
  try {
    const snapshot = await createSkillSnapshot({ discovery: "explicit-only",
      novelteaSkills: f.root, skillDirs: [], requiredSkills: [] });
    assert.ok(snapshot);
    const state = emptyAdaptiveState(f.job, turn, 1);
    const signature = pendingDigest({ original: f.head });
    await beginAdaptiveAttempt(f.job, state, f.head, signature);
    const body = { schema: "noveltea-adaptive-assignments/v1" as const,
      sourceSha: f.head, turnDigest: turn, beforeVersion: 1, afterVersion: 2,
      inventoryDigest: "b".repeat(64), planVersion: 1, reason: "original order and task",
      actions: [{ kind: "narrow" as const, item: "interactive:milestone.wrong-credit",
        sourcePath: "milestones/wrong-credit.md", sourceHash: "b".repeat(64),
        outcome: "Evaluate the original observed credit before later player decisions." }],
      order: ["interactive:milestone.wrong-credit", "review"], carried: [], omissions: [] };
    const entry = { ...body, digest: pendingDigest(body) };
    mkdirSync(join(f.root, "adaptive-planning-sessions"), { recursive: true });
    const sessionFile = join(f.root, "adaptive-planning-sessions", "original.jsonl");
    const bytes = JSON.stringify({ role: "assistant", text: "original proposal" }) + "\n";
    writeFileSync(sessionFile, bytes);
    await settleAdaptiveAttempt(f.job, state, signature, "admitted", entry, {
      sessionFile, sessionSha256: createHash("sha256").update(bytes).digest("hex"),
      snapshotId: snapshot.id, provider: "openai", model: "fixture",
      skillReads: [join(snapshot.path, "skills/test/SKILL.md")],
      proposalDigest: pendingDigest({ sourceSha: f.head, turnDigest: turn,
        beforeVersion: 1, reason: entry.reason, actions: entry.actions, order: entry.order }),
    });
    const rejected = pendingDigest({ sameSource: f.head, staleAdaptiveResponse: true });
    await beginAdaptiveAttempt(f.job, state, f.head, rejected);
    await settleAdaptiveAttempt(f.job, state, rejected, "rejected");
    assert.throws(() => assertAdaptiveSettled(state), /Rejected adaptive/);
    const original = structuredClone(state.entries[0]);
    const sup = await admitAdaptiveSupersession(f.job, state, {
      turnDigest: turn, planVersion: 1, sourceSha: f.head,
      assignmentId: "interactive:milestone.wrong-credit",
      originalAmendmentDigest: entry.digest,
      negativeReportDigest: "c".repeat(64),
      omission: { nonce: "aafaba04-d8b8-4fdc-b22e-37df8c98228d", digest: "d".repeat(64) },
      reviewedBlueprint: { milestoneId: "milestone.wrong-credit",
        sourceSha: f.head, digest: "e".repeat(64), cycleId: "review-cycle" },
      rejectedAttemptSignature: rejected,
    });
    assert.equal(sup.beforeVersion, 2);
    assert.equal(sup.afterVersion, 3);
    assert.equal(state.version, 3);
    assert.deepEqual(state.entries[0], original, "old Pi plan remains immutable");
    assert.deepEqual(state.attempts.map(a => a.phase), ["admitted", "rejected"]);
    assert.doesNotThrow(() => assertAdaptiveSettled(state));
    const restored = (await readAdaptiveState(f.job, turn, 1))!;
    assert.equal(restored.version, 3);
    assert.deepEqual(restored.supersessions, [sup]);
    assert.deepEqual(restored.entries[0], original);
    writeFileSync(join(f.root, "milestones/unrelated.md"), "Independent descendant\n");
    f.git("add", "milestones/unrelated.md"); f.git("commit", "-qm", "Unrelated source");
    assert.equal((await readAdaptiveState(f.job, turn, 1))?.version, 3,
      "a verified Git descendant retains original source and supersession history");
    const path = join(f.root, "adaptive-plan.json");
    const saved = JSON.parse(readFileSync(path, "utf8"));
    saved.supersessions[0].negativeReportDigest = "f".repeat(64);
    writeFileSync(path, JSON.stringify(saved));
    await assert.rejects(readAdaptiveState(f.job, turn, 1), /digest|altered/,
      "changing the historical negative source cannot modify the corrected plan");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("#243: an unrelated blocked or duplicated supersession cannot clear rejected adaptive history", async () => {
  const f = setup();
  try {
    const state = emptyAdaptiveState(f.job, turn, 1);
    const sig = pendingDigest({ rejected: f.head });
    await beginAdaptiveAttempt(f.job, state, f.head, sig);
    await settleAdaptiveAttempt(f.job, state, sig, "rejected");
    await assert.rejects(admitAdaptiveSupersession(f.job, state, {
      turnDigest: turn, planVersion: 1, sourceSha: f.head,
      assignmentId: "interactive:milestone.wrong-credit",
      originalAmendmentDigest: "a".repeat(64),
      negativeReportDigest: "b".repeat(64),
      omission: { nonce: "aafaba04-d8b8-4fdc-b22e-37df8c98228d", digest: "c".repeat(64) },
      reviewedBlueprint: { milestoneId: "milestone.wrong-credit",
        sourceSha: f.head, digest: "d".repeat(64), cycleId: "review-cycle" },
      rejectedAttemptSignature: sig,
    }), /original plan/);
    assert.throws(() => assertAdaptiveSettled(state), /Rejected adaptive/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
