import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JobStartResult } from "../src/job.js";
import { forkDigest, readRecoveryFork } from "../src/recovery-fork-state.js";
import { assertFoundationArchitectureContinuity,
  hasPlanContinuity } from "../src/plan-continuity.js";
import { removeTestTree } from "./helpers.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

test("#212: recovery fork retains v1 foundations under v2 despite intentionally empty child plan history", t => {
  const dir = mkdtempSync(join(tmpdir(), "nt-foundation-fork-"));
  t.after(() => removeTestTree(dir));
  const story = join(dir, "story");
  const stateDir = join(dir, "state");
  mkdirSync(story, { recursive: true });
  mkdirSync(stateDir);
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.invalid");
  writeFileSync(join(story, "architecture.md"), "Original Architecture v1\n");
  git(dir, "add", "."); git(dir, "commit", "-qm", "Reviewed v1 Architecture");
  const originalArchitecture = git(dir, "rev-parse", "HEAD");
  writeFileSync(join(story, "foundations.md"), "Reviewed Character and World v1\n");
  git(dir, "add", "."); git(dir, "commit", "-qm",
    "Original foundations\n\nNovelTea-Work-Item: character-foundations");
  const foundationSha = git(dir, "rev-parse", "HEAD");
  writeFileSync(join(story, "architecture.md"), "Corrected Architecture v2\n");
  git(dir, "add", "."); git(dir, "commit", "-qm", "Approved v2 amendment");
  const forkSha = git(dir, "rev-parse", "HEAD");
  const contract = { scope: { kind: "partial", depth: "composition",
    targets: ["milestone.example"], branches: [] }, constraints: [],
    envelope: { presentation: "Visual novel", hardLimits: [], preferences: [] } };
  const plan = { version: 2, contract, items: [{
    id: "global-architecture", verifiedSha: forkSha, status: "verified",
  }] };
  const bundle = {
    version: 2, childId: "child", sourceJobId: "parent", sourceBaseSha: originalArchitecture,
    storyRoot: story, toolchain: {
      graphSchema: "noveltea-generation/v1",
      runtime: { continuationSchema: "noveltea-fork/v2", nodeVersion: process.version },
      validator: { implementation: "native-cli", contract: "noveltea-validator/v1", version: "1.0.0" },
      skills: { id: "a".repeat(64) },
    },
    checkpoint: { commitSha: forkSha, planDigest: hash(plan),
      workItem: "character-foundations", completedWorkItems: ["character-foundations"] },
    contract, receipts: {
      "character-world.json": { jobId: "parent", planVersion: 1,
        architectureHead: originalArchitecture },
      "architecture.json": { jobId: "parent", phase: "committed",
        plan, history: [], expectedHead: forkSha },
    },
    commits: {}, completedStages: [],
  };
  const bundleDigest = forkDigest(bundle);
  writeFileSync(join(stateDir, "recovery-fork.json"), JSON.stringify(bundle));
  writeFileSync(join(stateDir, "recovery-fork-ready"), bundleDigest + "\n");
  const job = { jobId: "child", threadId: "child-thread",
    baseSha: forkSha, storyRoot: story,
    worktreeRoot: dir, stateDir, recoveryFork: {
      sourceJobId: "parent", sourceBaseSha: originalArchitecture,
      commitSha: forkSha, bundleSha256: bundleDigest,
    } } as JobStartResult;
  assert.equal(readRecoveryFork(job)?.checkpoint.planDigest, hash(plan));
  const architecture = { jobId: "child", phase: "committed",
    plan, history: [], expectedHead: forkSha };
  const foundations = { planVersion: 1, architectureHead: originalArchitecture };
  assert.doesNotThrow(() => assertFoundationArchitectureContinuity(job, architecture as any, foundations),
    "Parent verified the signed history before constructing the immutable child bundle");
  assert.throws(() => assertFoundationArchitectureContinuity(job, architecture as any,
    { ...foundations, architectureHead: forkSha }), /immutable recovery fork source/);
  assert.throws(() => assertFoundationArchitectureContinuity(job,
    { ...architecture, expectedHead: originalArchitecture } as any, foundations),
    /immutable recovery fork source/);
  // Child authorizes a THIRD plan, preserving the original v1 Foundations
  // from its authenticated v2 fork. Only the child v2->v3 approval exists:
  // no parent v1->v2 author ledger was imported or re-signed.
  const childFoundation = { jobId: "child", planVersion: 1,
    architectureHead: originalArchitecture, units: [
      { phase: "committed", commitSha: foundationSha },
      { phase: "committed", commitSha: foundationSha },
    ] };
  writeFileSync(join(stateDir, "character-world.json"), JSON.stringify(childFoundation));
  writeFileSync(join(story, "architecture.md"), "Revised child Architecture v3\n");
  git(dir, "add", "."); git(dir, "commit", "-qm", "Child-approved v3 Architecture");
  const v3Head = git(dir, "rev-parse", "HEAD");
  const v3Contract = { ...contract, constraints: ["Retain independently verified Foundations"] };
  const v3Plan = { ...plan, version: 3, contract: v3Contract,
    items: [{ ...plan.items[0], verifiedSha: v3Head }] };
  function signedChildCarry(carryForward: string[]) {
    const proposal = hash({ plan, head: forkSha, contract: v3Contract, carryForward });
    const receiptId = "approval-" + randomUUID();
    const nonce = randomUUID();
    const payload = { version: 1, kind: "plan", jobId: "child",
      threadId: "child-thread", workItemId: "global-architecture",
      baseSha: forkSha, verifiedHead: forkSha, proposalSha256: proposal,
      planVersion: 3, reason: "The author reviewed and explicitly retained the inherited Foundations." };
    mkdirSync(join(stateDir, "trusted-approvals"), { recursive: true });
    writeFileSync(join(stateDir, "trusted-approvals", receiptId + ".json"),
      JSON.stringify({ version: 1, id: receiptId, nonce, phase: "recorded",
        decision: "approved", source: "trusted-cli", principal: "test-author",
        recordedAt: "2026-11-20T00:00:00Z", jobId: "child",
        threadId: "child-thread", baseSha: forkSha, verifiedHead: forkSha,
        proposalSha256: proposal, workItemId: "global-architecture",
        kind: "plan", payload }));
    return { plan, proposal, approvedContract: v3Contract, verifiedHead: forkSha,
      carryForward, source: "trusted-controller" as const, signed: { receiptId, nonce } };
  }
  const childV3 = { ...architecture, plan: v3Plan,
    expectedHead: v3Head, history: [signedChildCarry(["foundations"])] };
  assert.doesNotThrow(() => assertFoundationArchitectureContinuity(job, childV3 as any,
    foundations), "v3 must use pinned v2 baseline plus the signed child v2->v3 decision");
  assert.throws(() => assertFoundationArchitectureContinuity(job, {
    ...childV3, history: [signedChildCarry([])],
  } as any, foundations), /signed carry-forward/,
  "An unsigned or omitted child carry-forward cannot import parent work.");
  assert.throws(() => assertFoundationArchitectureContinuity(job, {
    ...childV3, history: [{ ...childV3.history[0],
      plan: { ...plan, contract: v3Contract } }],
  } as any, foundations), /not included in a signed carry-forward|Historical plan/,
  "Changing the signed fork baseline must invalidate inherited continuity.");
  // Also support a receipt authored at exactly the fork baseline v2, not
  // only older v1 work. A later v3 signature still owns new authorization.
  const sameVersion = { ...bundle, receipts: {
    ...bundle.receipts, "character-world.json": {
      ...bundle.receipts["character-world.json"],
      planVersion: 2, architectureHead: forkSha },
  } };
  const sameDigest = forkDigest(sameVersion);
  writeFileSync(join(stateDir, "recovery-fork.json"), JSON.stringify(sameVersion));
  writeFileSync(join(stateDir, "recovery-fork-ready"), sameDigest + "\n");
  const sameJob = { ...job, recoveryFork: { ...job.recoveryFork!,
    bundleSha256: sameDigest } };
  writeFileSync(join(stateDir, "character-world.json"), JSON.stringify({
    ...childFoundation, planVersion: 2, architectureHead: forkSha }));
  assert.equal(hasPlanContinuity(sameJob, childV3 as any, "foundations", 2), true);
  assert.doesNotThrow(() => assertFoundationArchitectureContinuity(
    sameJob, childV3 as any, { planVersion: 2, architectureHead: forkSha }));
  assert.throws(() => assertFoundationArchitectureContinuity(
    sameJob, childV3 as any, { planVersion: 2, architectureHead: originalArchitecture }),
    /immutable recovery fork source/);
  writeFileSync(join(stateDir, "recovery-fork.json"), JSON.stringify(bundle));
  writeFileSync(join(stateDir, "recovery-fork-ready"), bundleDigest + "\n");
  const tampered = { ...bundle, receipts: {
    ...bundle.receipts, "character-world.json": {
      ...bundle.receipts["character-world.json"], architectureHead: forkSha },
  } };
  writeFileSync(join(stateDir, "recovery-fork.json"), JSON.stringify(tampered));
  assert.throws(() => assertFoundationArchitectureContinuity(job, architecture as any, foundations),
    /immutable job pin/);
});
