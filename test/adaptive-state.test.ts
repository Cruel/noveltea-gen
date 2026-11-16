import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobStartResult } from "../src/job.js";
import { pendingDigest } from "../src/pending-work-amendments.js";
import { createSkillSnapshot } from "../src/snapshot.js";
import { assertAdaptiveFallbackAllowed, reconcileAdaptiveWork } from "../src/adaptive-work.js";
import type { GenerationRequest } from "../src/generation.js";
import type { Plan } from "../src/architecture.js";
import type { GenerationInventory } from "../src/generation-plan.js";
import { emptyAdaptiveState, readAdaptiveState,
  beginAdaptiveAttempt, settleAdaptiveAttempt, assertAdaptiveSettled } from "../src/adaptive-state.js";

const turn = "a".repeat(64);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nt-adaptive-state-"));
  const git = (...args: string[]) => execFileSync("git", args, {
    cwd: root, encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(root, "README.md"), "baseline\n");
  git("add", "."); git("commit", "-qm", "initial");
  const sha = git("rev-parse", "HEAD");
  const branch = git("symbolic-ref", "--short", "HEAD");
  const job = { stateDir: root, worktreeRoot: root, baseSha: sha,
    threadId: "thread", jobId: "job", branch } as JobStartResult;
  return { root, job, git, sha };
}
test("inspection of a Story without adaptive history does not enter planning or create receipts", async () => {
  const f = fixture();
  const previousFlag = process.env.NT_ADAPTIVE_PLANNING;
  process.env.NT_ADAPTIVE_PLANNING = "1";
  try {
    const contract: Plan["contract"] = { scope: { kind: "full-story", depth: "composition", targets: [], branches: [] },
      constraints: [], envelope: { presentation: "VN", hardLimits: [], preferences: [] } };
    const request = { story: f.root, job: "job", task: "Develop the Story", fixture: false,
      orchestrationPolicy: "explicit", turnPlanDigest: turn, contract } as GenerationRequest;
    const inventory: GenerationInventory = { version: 1, planVersion: 1, headSha: f.sha, items: [], rationale: "Inspection" };
    const result = await reconcileAdaptiveWork({ job: f.job, request,
      plan: { version: 1, contract, items: [] }, inventory,
      validation: { contract: "noveltea-validator/v1", status: "passed", exitCode: 0,
        jobId: f.job.jobId, baseSha: f.sha, worktreeStoryRoot: f.root,
        validator: { contract: "noveltea-validator/v1", implementation: "native-cli", version: "fixture" } },
      completed: [], graphThreadId: "thread:generation",
      allowAmend: false });
    assert.deepEqual(result, { inventory, order: null, version: null });
    assert.equal(await readAdaptiveState(f.job, turn, 1), null);
  } finally {
    if (previousFlag === undefined) delete process.env.NT_ADAPTIVE_PLANNING;
    else process.env.NT_ADAPTIVE_PLANNING = previousFlag;
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("rejected adaptive proposals block restart instead of falling back to old assignments", async () => {
  const f = fixture();
  try {
    const state = emptyAdaptiveState(f.job, turn, 1);
    const signature = pendingDigest({ source: f.sha });
    await beginAdaptiveAttempt(f.job, state, f.sha, signature);
    await settleAdaptiveAttempt(f.job, state, signature, "rejected");
    const restored = (await readAdaptiveState(f.job, turn, 1))!;
    assert.throws(() => assertAdaptiveSettled(restored), /Rejected adaptive/);
    await assert.rejects(beginAdaptiveAttempt(f.job, restored, f.sha, signature), /Rejected adaptive/);
    await assert.rejects(assertAdaptiveFallbackAllowed(f.job, turn, 1, null), /Rejected adaptive/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("adaptive controller history is Thread-bound, durable, source-ancestral and refuses interrupted planner replay", async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, "skills", "test"), { recursive: true });
    writeFileSync(join(f.root, "skills/test/SKILL.md"), "---\\nname: test\\n---\\nfixture");
    f.git("add", "."); f.git("commit", "-qm", "Fixture pinned skill");
    const snapshot = await createSkillSnapshot({ discovery: "explicit-only",
      novelteaSkills: f.root, skillDirs: [], requiredSkills: [] });
    assert.ok(snapshot);
    const state = emptyAdaptiveState(f.job, turn, 1);
    assert.equal(await readAdaptiveState(f.job, turn, 1), null);
    await assertAdaptiveFallbackAllowed(f.job, turn, 1, null);
    const one = pendingDigest({ head: f.sha, version: 1 });
    assert.equal(await beginAdaptiveAttempt(f.job, state, f.sha, one), true);
    const interrupted = (await readAdaptiveState(f.job, turn, 1))!;
    assert.throws(() => assertAdaptiveSettled(interrupted), /Interrupted adaptive orchestrator/);
    await assert.rejects(assertAdaptiveFallbackAllowed(f.job, turn, 1, null),
      /Interrupted adaptive orchestrator/);
    await assert.rejects(beginAdaptiveAttempt(f.job, interrupted, f.sha, one),
      /Interrupted adaptive orchestrator/);
    await settleAdaptiveAttempt(f.job, state, one, "unchanged");
    assert.equal(await beginAdaptiveAttempt(f.job, state, f.sha, one), false,
      "already-settled source cannot be silently replanned");
    const two = pendingDigest({ head: f.sha, version: 2 });
    assert.equal(await beginAdaptiveAttempt(f.job, state, f.sha, two), true);
    const body = { schema: "noveltea-adaptive-assignments/v1" as const,
      sourceSha: f.sha, turnDigest: turn, beforeVersion: 1, afterVersion: 2,
      inventoryDigest: "b".repeat(64), planVersion: 1, reason: "causally sound",
      actions: [], order: ["review"], carried: [], omissions: [] };
    const entry = { ...body, digest: pendingDigest(body) };
    mkdirSync(join(f.root, "adaptive-planning-sessions"), { recursive: true });
    const sessionFile = join(f.root, "adaptive-planning-sessions", "test.jsonl");
    writeFileSync(sessionFile, JSON.stringify({ role: "assistant", text: "proposal" }) + "\\n");
    const { createHash } = await import("node:crypto");
    const session = { sessionFile,
      sessionSha256: createHash("sha256").update(readFileSync(sessionFile)).digest("hex"),
      snapshotId: snapshot.id, provider: "openai", model: "fixture",
      skillReads: [join(snapshot.path, "skills/test/SKILL.md")],
      proposalDigest: pendingDigest({ sourceSha: f.sha, turnDigest: turn,
        beforeVersion: 1, reason: entry.reason, actions: entry.actions, order: entry.order }),
    };
    await settleAdaptiveAttempt(f.job, state, two, "admitted", entry, session);
    const restored = await readAdaptiveState(f.job, turn, 1);
    assert.equal(restored?.version, 2);
    await assert.rejects(assertAdaptiveFallbackAllowed(f.job, turn, 1, null),
      /sealed adaptive amendment/);
    await assert.rejects(assertAdaptiveFallbackAllowed(f.job, turn, 1, 2),
      /cannot revert/);
    assert.deepEqual(restored?.entries, [entry]);
    writeFileSync(join(f.root, "README.md"), "next\n");
    f.git("add", "."); f.git("commit", "-qm", "after independent work");
    assert.equal((await readAdaptiveState(f.job, turn, 1))?.entries[0]?.sourceSha, f.sha,
      "verified descendant commits do not erase the original amendment provenance");
    writeFileSync(sessionFile, "tampered transcript");
    await assert.rejects(readAdaptiveState(f.job, turn, 1), /transcript changed/);
    writeFileSync(sessionFile, JSON.stringify({ role: "assistant", text: "proposal" }) + "\\n");
    await assert.rejects(readAdaptiveState({ ...f.job, threadId: "other" }, turn, 1),
      /identity|source/);
    await assert.rejects(readAdaptiveState(f.job, "c".repeat(64), 1), /identity|source/);
    await assert.rejects(readAdaptiveState(f.job, turn, 2), /identity|source/);
    const saved = JSON.parse(readFileSync(join(f.root, "adaptive-plan.json"), "utf8"));
    saved.entries[0].actions.push({ kind: "omit", item: "interactive:milestone.fake" });
    writeFileSync(join(f.root, "adaptive-plan.json"), JSON.stringify(saved));
    await assert.rejects(readAdaptiveState(f.job, turn, 1), /digest|altered/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
