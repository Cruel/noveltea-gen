import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertCompletedSelectiveRevalidation } from "../src/selective-revalidation-work.js";
import { planSelectiveRevalidation, originalInventorySnapshotDigest } from "../src/selective-revalidation.js";
import { createSkillSnapshot } from "../src/snapshot.js";
import { admitCausalRevalidationFinding } from "../src/repair-ledger.js";
import { removeTestTree } from "./helpers.js";
import type { JobStartResult } from "../src/job.js";
import type { GenerationInventory, ExecutionItem } from "../src/generation-plan.js";

const sha = (character: string) => character.repeat(40);
const sum = (character: string) => character.repeat(64);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function fixture(t: import("node:test").TestContext) {
  const root = mkdtempSync(join(tmpdir(), "nt-revalidate-"));
  const previousCache = process.env.NT_SKILL_CACHE_DIR;
  process.env.NT_SKILL_CACHE_DIR = join(root, "cache");
  t.after(() => {
    if (previousCache === undefined) delete process.env.NT_SKILL_CACHE_DIR;
    else process.env.NT_SKILL_CACHE_DIR = previousCache;
    removeTestTree(root);
  });
  const skills = join(root, "skills-origin");
  mkdirSync(join(skills, "skills", "nt-narrative-review"), { recursive: true });
  writeFileSync(join(skills, "skills", "nt-narrative-review", "SKILL.md"),
    "---\nname: nt-narrative-review\n---\nReview canonical sources.\n");
  for (const args of [
    ["init", "-q"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"],
    ["add", "."], ["commit", "-qm", "Pinned reviewer"],
  ]) {
    const r = spawnSync("git", args, { cwd: skills, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  }
  const snapshot = await createSkillSnapshot({ discovery: "explicit-only", novelteaSkills: skills,
    skillDirs: [], requiredSkills: ["nt-narrative-review"] });
  assert.ok(snapshot);
  const stateDir = join(root, "state");
  const repo = join(root, "story");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "README.md"), "Verified correction boundary");
  for (const args of [
    ["init", "-q", "-b", "main"], ["config", "user.name", "Test"],
    ["config", "user.email", "test@example.invalid"], ["add", "."],
    ["commit", "-qm", "Reviewed correction"],
  ]) {
    const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  }
  const next = spawnSync("git", ["rev-parse", "HEAD"],
    { cwd: repo, encoding: "utf8" });
  assert.equal(next.status, 0);
  const successorSha = next.stdout.trim(), upstreamSha = sha("1");
  const job = { jobId: "job-a", threadId: "thread-a", stateDir,
    worktreeRoot: repo, worktreeStoryRoot: repo, storyRelativePath: "", branch: "main",
    baseSha: successorSha } as JobStartResult;
  const turnDigest = sum("a");
  const primary = {
    id: "event:milestone.alpha", stage: "event", milestone: "milestone.alpha",
    status: "verified", verifiedSha: sha("3"), dependencies: [], planVersion: 2,
  } as ExecutionItem;
  const dependent = {
    id: "interactive:milestone.alpha", stage: "interactive", milestone: "milestone.alpha",
    status: "verified", verifiedSha: sha("4"), dependencies: [primary.id], planVersion: 2,
  } as ExecutionItem;
  const inventory: GenerationInventory = { version: 1, planVersion: 2,
    headSha: upstreamSha, rationale: "Original immutable reviewed inventory", items: [primary, dependent] };
  const reviewDigest = sum("d");
  const plan = planSelectiveRevalidation({
    inventory,
    correction: {
      version: 1, planVersion: 2, upstreamItemId: primary.id,
      baseSha: upstreamSha, successorSha, predecessorCommitSha: primary.verifiedSha!,
      turnDigest, reviewDigest, changedPaths: ["milestones/alpha.md"],
      permittedPaths: ["milestones/alpha.md"],
    },
    reviews: {
      [primary.id]: { commitSha: primary.verifiedSha!, reviewDigest: sum("c"),
        status: "passed", sourcePaths: ["milestones/alpha.md"] },
      [dependent.id]: { commitSha: dependent.verifiedSha!, reviewDigest: sum("e"),
        status: "passed", sourcePaths: ["milestones/alpha.md"] },
    },
  });
  assert.deepEqual(plan.affected, [dependent.id]);
  const reviewerFile = join(stateDir, "review-sessions", "narrative", "review", "reviewer.jsonl");
  mkdirSync(join(reviewerFile, ".."), { recursive: true });
  const transcript = JSON.stringify({ type: "session", id: "independent-revalidation" }) + "\n" +
    JSON.stringify({ type: "message", message: { role: "assistant",
      content: [{ type: "text", text: "Accepted revised source at Milestone line 9" }] } }) + "\n";
  writeFileSync(reviewerFile, transcript);
  const sessionDigest = createHash("sha256").update(transcript).digest("hex");
  const verdict = { verdict: "pass", findings: [], evidence: ["milestones/alpha.md:9"] };
  const reviewerDigest = hash({ verdict, sessionDigest, source: successorSha, item: dependent.id });
  const record = {
    itemId: dependent.id, sourceSha: successorSha, status: "passed",
    reviewerDigest, originalCommitSha: dependent.verifiedSha!,
    originalReviewDigest: sum("e"), sessionFile: reviewerFile,
    sessionDigest, verdict,
  };
  const result = { ...record, digest: hash(record) };
  const state = { version: 1, jobId: job.jobId, threadId: job.threadId,
    turnDigest, proposal: plan, snapshot, provider: "openai", model: "gpt-6-luna",
    originalInventoryDigest: originalInventorySnapshotDigest(inventory),
    state: "completed", finalHead: successorSha, results: [result] };
  const receiptFile = join(stateDir, "revalidation-items", successorSha + ".json");
  const upstreamFile = join(stateDir, "prerequisite-items", "alpha.json");
  mkdirSync(join(stateDir, "revalidation-items"), { recursive: true });
  mkdirSync(join(stateDir, "revisions"), { recursive: true });
  writeFileSync(join(stateDir, "revisions", "verified-head.json"),
    JSON.stringify({ version: 1, jobId: job.jobId, headSha: successorSha,
      workItemId: "prerequisite-alpha" }));
  mkdirSync(join(stateDir, "prerequisite-items"), { recursive: true });
  writeFileSync(upstreamFile, JSON.stringify({ jobId: job.jobId,
    phase: "verified", commitSha: successorSha, reviewDigest,
    originalInventoryDigest: state.originalInventoryDigest }));
  const save = (value: unknown) => writeFileSync(receiptFile, JSON.stringify(value));
  save(state);
  return { job, plan, state, save, reviewerFile, transcript, upstreamFile, successorSha, turnDigest, reviewDigest };
}
test("completed read-only dependent review proves later Composition may resume", async t => {
  const f = await fixture(t);
  const checked = await assertCompletedSelectiveRevalidation(
    f.job, f.successorSha, f.turnDigest, f.reviewDigest);
  assert.equal(checked.digest, f.plan.digest);
});
test("an incomplete, forged, stale, missing or interrupted reviewer never carries forward", async t => {
  const f = await fixture(t);
  for (const mutation of [
    (s: any) => { s.state = "reviewing"; },
    (s: any) => { s.finalHead = sha("f"); },
    (s: any) => { delete s.finalHead; },
    (s: any) => { s.correctiveAssignment = { digest: sum("f") }; },
    (s: any) => { s.state = "completed"; s.results = []; },
    (s: any) => { s.results[0].verdict.evidence = ["events/fabricated.md:999"]; },
    (s: any) => { s.results[0].reviewerDigest = sum("f"); },
    (s: any) => { s.results[0].digest = sum("f"); },
    (s: any) => { s.proposal.digest = sum("f"); },
    (s: any) => { s.results[0].sourceSha = sha("f"); },
    (s: any) => { s.originalInventoryDigest = sum("f"); },
    (s: any) => { s.results[0].status = "failed"; },
  ]) {
    const changed = structuredClone(f.state);
    mutation(changed);
    f.save(changed);
    await assert.rejects(assertCompletedSelectiveRevalidation(
      f.job, f.successorSha, f.turnDigest, f.reviewDigest));
  }
  f.save(f.state);
  await assert.rejects(() => assertCompletedSelectiveRevalidation(
    f.job, sha("f"), f.turnDigest, f.reviewDigest));
  await assert.rejects(() => assertCompletedSelectiveRevalidation(
    f.job, f.successorSha, f.turnDigest, sum("f")));
  writeFileSync(f.reviewerFile, f.transcript.replace("Accepted revised source", "Fabricated review source"));
  await assert.rejects(() => assertCompletedSelectiveRevalidation(
    f.job, f.successorSha, f.turnDigest, f.reviewDigest), /transcript/i);
});
test("unresolved new causal finding blocks the previously completed dependent review", async t => {
  const f = await fixture(t);
  await admitCausalRevalidationFinding(f.job, {
    turnDigest: f.turnDigest, rootFailureSha: sha("4"),
    sourceSha: f.successorSha, reviewDigest: sum("e"),
    causedBy: f.successorSha, assignmentId: "interactive",
    obligation: "Previously reviewed Choice no longer supports the original outcome.",
    findings: [{ path: "choice-points/changed.md",
      kind: "continuity", message: "Outcome contradicted the new Milestone.",
      affectedPaths: ["choice-points/changed.md"] }],
  });
  await assert.rejects(() => assertCompletedSelectiveRevalidation(
    f.job, f.successorSha, f.turnDigest, f.reviewDigest), /unresolved/i);
});
