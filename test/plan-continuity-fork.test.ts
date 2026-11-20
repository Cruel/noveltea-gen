import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JobStartResult } from "../src/job.js";
import { forkDigest, readRecoveryFork } from "../src/recovery-fork-state.js";
import { assertFoundationArchitectureContinuity } from "../src/plan-continuity.js";
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
  git(dir, "add", "."); git(dir, "commit", "-qm", "Original foundations");
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
  const job = { jobId: "child", baseSha: forkSha, storyRoot: story,
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
  const tampered = { ...bundle, receipts: {
    ...bundle.receipts, "character-world.json": {
      ...bundle.receipts["character-world.json"], architectureHead: forkSha },
  } };
  writeFileSync(join(stateDir, "recovery-fork.json"), JSON.stringify(tampered));
  assert.throws(() => assertFoundationArchitectureContinuity(job, architecture as any, foundations),
    /immutable job pin/);
});
