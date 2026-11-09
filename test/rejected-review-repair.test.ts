import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startStoryJob, type JobStartResult } from "../src/job.js";
import { parseSpecialistChoice, activeSpecialistChoice, answerSpecialistChoice,
  claimSpecialistChoice, completeSpecialistChoice, recordSpecialistChoice,
  inspectSpecialistChoice } from "../src/specialist-choice.js";
import { changedRepairPaths, disagreementQuestion, repairFeedback,
  type RepairReceipt } from "../src/rejected-review-repair.js";
import { removeTestTree } from "./helpers.js";

const sha = "a".repeat(40);
function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function rejected(): RepairReceipt {
  return {
    version: 1, jobId: "job", threadId: "thread", rootFailureSha: sha,
    sourceCommitSha: sha, sourceReviewDigest: "b".repeat(64),
    originalReviewDigest: "b".repeat(64),
    originalSource: {} as RepairReceipt["source"],
    source: {} as RepairReceipt["source"],
    findings: [{ path: "characters/nia.md",
      message: "Nia's reason for waiting is missing from the assigned result." }],
    assignment: { id: "focus:character.nia", specialist: "nt-character-development",
      outcome: "Give Nia a coherent reason to wait", targets: ["character.nia"],
      dependsOn: [], discovery: "canonical-story-read-only",
      authority: { recordTypes: ["character"], existingPaths: ["characters/nia.md"], mayCreate: false } },
    allowedPaths: ["characters/nia.md"], attempts: 1, phase: "ready",
    baselineHead: sha, sessionSha256: "c".repeat(64),
    origin: {} as RepairReceipt["origin"],
  };
}

test("source-linked repair feedback remains scoped and cannot silently expand protected authority", () => {
  const state = rejected();
  const feedback = repairFeedback(state);
  assert.deepEqual(feedback.allowedPaths, ["characters/nia.md"]);
  assert.equal(feedback.attempt, 2);
  assert.equal(feedback.maxAttempts, 2);
  assert.equal(feedback.assignment.outcome, "Give Nia a coherent reason to wait");
  const question = parseSpecialistChoice(disagreementQuestion(state));
  assert.equal(question.kind, "alternatives");
  assert.deepEqual(question.options?.map(option => option.id), ["correct", "revise"]);
  assert.equal(question.recommendedId, "correct");
  assert.match(question.options![1]!.tradeoffs, /source-bound/);
  assert.equal(state.phase, "ready", "A choice prompt never changes an immutable failed verdict");
});

test("a correction is a real owned Git diff, not an explanation or unrelated creative change", t => {
  const root = mkdtempSync(join(tmpdir(), "nt-rejected-repair-diff-"));
  t.after(() => removeTestTree(root));
  const story = join(root, "story"), dir = join(story, "characters");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(story, "creative-direction"), { recursive: true });
  mkdirSync(join(story, "events"), { recursive: true });
  const target = join(dir, "nia.md");
  writeFileSync(target, "Nia waits.\n");
  writeFileSync(join(story, "creative-direction", "canon.md"), "Protected.\n");
  writeFileSync(join(story, "events", "reveal.md"), "Revelation.\n");
  git(root, "init", "-q");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.test");
  git(root, "add", ".");
  git(root, "commit", "-qm", "Baseline");
  const job = { worktreeRoot: root, storyRelativePath: "story" } as JobStartResult;
  const state = rejected();
  assert.deepEqual(changedRepairPaths(job, state), [],
    "Explanations with no actual changed records cannot be treated as correction");
  writeFileSync(target, "Nia waits because she promised to keep the witness safe.\n");
  assert.deepEqual(changedRepairPaths(job, state), ["characters/nia.md"]);
  writeFileSync(join(story, "events", "reveal.md"), "An unrelated Event changed.\n");
  assert.throws(() => changedRepairPaths(job, state), /protected|unrelated|authorize/);
  writeFileSync(join(story, "events", "reveal.md"), "Revelation.\n");
  writeFileSync(join(story, "creative-direction", "canon.md"), "Retcon protected.\n");
  assert.throws(() => changedRepairPaths(job, state), /protected|unrelated|authorize/);
  writeFileSync(join(story, "creative-direction", "canon.md"), "Protected.\n");
  git(root, "add", "story/characters/nia.md");
  assert.throws(() => changedRepairPaths(job, state), /staged|unsafe/);
});

test("rejected-work disagreement uses normal authenticated Author Choice, persists across restart", {
  timeout: 35_000,
}, async t => {
  const root = mkdtempSync(join(tmpdir(), "nt-rejected-repair-author-"));
  const old = { state: process.env.NT_STATE_DIR, cache: process.env.NT_GIT_CACHE_DIR };
  process.env.NT_STATE_DIR = join(root, "state");
  process.env.NT_GIT_CACHE_DIR = join(root, "cache");
  t.after(() => {
    if (old.state === undefined) delete process.env.NT_STATE_DIR;
    else process.env.NT_STATE_DIR = old.state;
    if (old.cache === undefined) delete process.env.NT_GIT_CACHE_DIR;
    else process.env.NT_GIT_CACHE_DIR = old.cache;
    removeTestTree(root);
  });
  const story = join(root, "repo", "story");
  mkdirSync(join(story, "creative-direction"), { recursive: true });
  writeFileSync(join(story, "creative-direction", "foundation.md"), "Foundation.\n");
  const repo = join(root, "repo");
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.test");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "Baseline");
  const job = await startStoryJob({ story, job: randomUUID() });
  const sessionDir = join(job.stateDir, "character-world-sessions", "character");
  mkdirSync(sessionDir, { recursive: true });
  const sessionId = randomUUID(), sessionFile = join(sessionDir, "original.jsonl");
  writeFileSync(sessionFile, JSON.stringify({ type: "session", id: sessionId,
    cwd: job.worktreeStoryRoot }) + "\n");
  const dir = join(job.stateDir, "review-repairs");
  mkdirSync(dir, { recursive: true });
  const state = { version: 1, jobId: job.jobId, threadId: job.threadId,
    sourceCommitSha: sha, phase: "repairing", origin: { sessionId, sessionFile } };
  const statePath = join(dir, sha + ".json");
  writeFileSync(statePath, JSON.stringify(state));
  const question = disagreementQuestion(rejected());
  const receipt = await recordSpecialistChoice(job, "repair-" + sha,
    question, sessionId, sessionFile);
  writeFileSync(statePath, JSON.stringify({ ...state,
    phase: "awaiting-author", choiceId: receipt.id }));
  assert.equal((await activeSpecialistChoice(job))?.id, receipt.id);
  await assert.rejects(answerSpecialistChoice(job, receipt.id, receipt.proposalSha256,
    { kind: "option", optionId: "revise", note: "Nia now waits without a motive." },
    "model:writer"), /identity/);
  const answered = await answerSpecialistChoice(job, receipt.id, receipt.proposalSha256,
    { kind: "option", optionId: "revise",
      note: "Preserve Nia's established motive but change how her hesitation is expressed." },
    "user:owner");
  assert.equal(answered.answer?.principal, "user:owner");
  assert.equal((await activeSpecialistChoice({ ...job }))?.phase, "answered");
  assert.equal((await inspectSpecialistChoice(job, receipt.id)).question.options?.length, 2);
  await claimSpecialistChoice(job, receipt.id);
  await completeSpecialistChoice(job, receipt.id);
  assert.equal((await inspectSpecialistChoice(job, receipt.id)).phase, "consumed");
  assert.equal(readFileSync(statePath, "utf8").includes('"phase":"awaiting-author"'), true,
    "A choice receipt does not itself mutate writer scope or source review.");
});
