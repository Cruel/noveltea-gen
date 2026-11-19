import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSkillSnapshot } from "../src/snapshot.js";
import { removeTestTree } from "./helpers.js";
import { admitPrerequisiteRepair, submitPrerequisiteRepair,
  settlePrerequisiteRepair } from "../src/repair-ledger.js";
import { verifyCrossDomainCloseoutSuccessor } from "../src/cross-domain-closeout-work.js";
import { validCloseoutProposal, retryCloseoutProposal,
  type CloseoutProposal } from "../src/cross-domain-prerequisite.js";
import type { JobStartResult } from "../src/job.js";
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
function git(cwd: string, ...args: string[]) {
  const done = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(done.status, 0, done.stderr);
  return done.stdout.trim();
}
const original = `---
id: milestone.choice-enacted
type: milestone
status: draft
completeness: partial
fulfillment:
  any_of: []
decisions: []
---
The audience recognizes the genuine consequence.
`;
const completed = original.replace("completeness: partial", "completeness: complete")
  .replace("any_of: []", "any_of:\n    - [event.setup]");
async function setup(t: import("node:test").TestContext, firstVerdict: "passed" | "failed" = "passed") {
  const root = mkdtempSync(join(tmpdir(), "nt-cross-domain-proof-"));
  const priorCache = process.env.NT_SKILL_CACHE_DIR;
  process.env.NT_SKILL_CACHE_DIR = join(root, "skill-cache");
  t.after(() => {
    if (priorCache === undefined) delete process.env.NT_SKILL_CACHE_DIR;
    else process.env.NT_SKILL_CACHE_DIR = priorCache;
    removeTestTree(root);
  });
  const skills = join(root, "pinned-reviewer");
  mkdirSync(join(skills, "skills", "nt-narrative-review"), { recursive: true });
  writeFileSync(join(skills, "skills", "nt-narrative-review", "SKILL.md"),
    "---\nname: nt-narrative-review\n---\nReview story.\n");
  git(skills, "init", "-q"); git(skills, "config", "user.name", "Test");
  git(skills, "config", "user.email", "test@example.invalid");
  git(skills, "add", "."); git(skills, "commit", "-qm", "Pinned skill");
  const snapshot = await createSkillSnapshot({ discovery: "explicit-only", novelteaSkills: skills,
    skillDirs: [], requiredSkills: ["nt-narrative-review"] });
  assert.ok(snapshot);
  const story = join(root, "story"), stateDir = join(root, "state");
  mkdirSync(join(story, "milestones"), { recursive: true });
  const path = "milestones/choice-enacted.md";
  const target = join(story, path);
  writeFileSync(target, original);
  git(root, "init", "-q"); git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "add", "."); git(root, "commit", "-qm", "Baseline");
  const before = git(root, "rev-parse", "HEAD");
  const body = { version: 1 as const, kind: "unmet-prerequisite" as const,
    owner: "nt-event-design" as const, sourceSha: before,
    milestoneId: "milestone.choice-enacted", sourceEventSha: before,
    choiceCommitSha: before, planVersion: 2, allowedPaths: [path],
    fields: ["completeness", "fulfillment"] as ["completeness", "fulfillment"],
    dependsOn: ["interactive:milestone.choice-enacted"],
    blocks: ["composition:milestone.choice-enacted"] };
  const proposal: CloseoutProposal = { ...body, digest: hash(JSON.stringify(body)) };
  assert.equal(validCloseoutProposal(proposal), true);
  const job = { stateDir, jobId: "job-1", threadId: "thread-1",
    validatorVersion: "0.1.0", worktreeRoot: root, worktreeStoryRoot: story,
    storyRelativePath: "story" } as JobStartResult;
  const turnDigest = "a".repeat(64);
  const admitted = await admitPrerequisiteRepair(job, {
    turnDigest, sourceSha: before, sourceEventSha: before,
    milestoneId: proposal.milestoneId, path, proposalDigest: proposal.digest, planVersion: 2 });
  writeFileSync(target, completed);
  git(root, "add", "--", "story/" + path);
  git(root, "commit", "-qm", `Verified source-bound closeout

NovelTea-Job: job-1
NovelTea-Work-Item: prerequisite-choice-enacted
NovelTea-Plan-Version: 2
NovelTea-Prerequisite: ${proposal.digest}`);
  const after = git(root, "rev-parse", "HEAD");
  await submitPrerequisiteRepair(job, { turnDigest, id: admitted.id,
    sourceSha: before, submittedSha: after, paths: [path] });
  const review = firstVerdict === "passed"
    ? { verdict: "pass", findings: [], evidence: [path + ":5"] }
    : { verdict: "block", findings: [{ severity: "blocking", repair: "event",
      source: path + ":5", message: "Original Milestone is unearned" }], evidence: [path + ":5"] };
  mkdirSync(join(stateDir, "prerequisite-sessions"), { recursive: true });
  mkdirSync(join(stateDir, "review-sessions"), { recursive: true });
  const writerSessionFile = join(stateDir, "prerequisite-sessions", "writer.jsonl");
  const reviewerSessionFile = join(stateDir, "review-sessions", "reviewer.jsonl");
  const writerTranscript = JSON.stringify({ type: "session", id: "writer" }) + "\n" +
    JSON.stringify({ type: "message", role: "assistant", text: "edited milestone" }) + "\n";
  const reviewerTranscript = JSON.stringify({ type: "session", id: "reviewer" }) + "\n" +
    JSON.stringify({ type: "message", role: "assistant", text: "independently passed" }) + "\n";
  writeFileSync(writerSessionFile, writerTranscript);
  writeFileSync(reviewerSessionFile, reviewerTranscript);
  const reviewerSessionDigest = hash(reviewerTranscript);
  const reviewDigest = hash(JSON.stringify({ reviewerSessionDigest,
    proposal: proposal.digest, commitSha: after, ...review }));
  await settlePrerequisiteRepair(job, { turnDigest, id: admitted.id,
    submittedSha: after, reviewDigest, verdict: firstVerdict });
  const state = {
    version: 1, jobId: "job-1", threadId: "thread-1", baseSha: before,
    workItemId: "prerequisite-choice-enacted", turnDigest, repairId: admitted.id,
    proposal, phase: "verified", worker: "pi", provider: "openai", model: "gpt-6-luna",
    validation: { status: "passed", sourceSha: before, validatorVersion: job.validatorVersion },
    authoredDigest: hash(readFileSync(target, "utf8")), commitSha: after,
    review, reviewDigest, reviewerSessionFile, reviewerSessionDigest,
    sessionFile: writerSessionFile, writerSessionDigest: hash(writerTranscript),
    reviewSnapshot: snapshot,
  };
  mkdirSync(join(stateDir, "prerequisite-items"), { recursive: true });
  const receiptFile = join(stateDir, "prerequisite-items", "choice-enacted.json");
  writeFileSync(receiptFile, JSON.stringify(state));
  mkdirSync(join(stateDir, "revisions"), { recursive: true });
  writeFileSync(join(stateDir, "revisions", "verified-head.json"),
    JSON.stringify({ version: 1, jobId: "job-1", headSha: before,
      workItemId: "event-choice-enacted" }));
  const trailers = git(root, "log", "-1", "--format=%B").split("\n");
  return { job, root, target, stateDir, snapshot, turnDigest, admitted,
    proposal, receiptFile, state, before, after, trailers, path };
}
test("verified descendant accepts exactly a signed, reviewed Milestone-only Git successor", async t => {
  const f = await setup(t);
  await verifyCrossDomainCloseoutSuccessor(f.job, f.after, f.before,
    ["story/" + f.path], f.trailers);
});
test("a later passed closeout carries a rejected ancestor without rewriting its negative verdict", async t => {
  const f = await setup(t, "failed");
  const next = retryCloseoutProposal(f.proposal, f.after);
  await admitPrerequisiteRepair(f.job, { turnDigest: f.turnDigest,
    sourceSha: f.after, sourceEventSha: f.before,
    milestoneId: next.milestoneId, path: f.path,
    proposalDigest: next.digest, planVersion: next.planVersion });
  writeFileSync(f.target, completed.replace("event.setup", "event.verified-payoff"));
  git(f.root, "add", "--", "story/" + f.path);
  git(f.root, "commit", "-qm", `Reviewed correction

NovelTea-Job: job-1
NovelTea-Work-Item: prerequisite-choice-enacted
NovelTea-Plan-Version: 2
NovelTea-Prerequisite: ${next.digest}`);
  const final = git(f.root, "rev-parse", "HEAD");
  await submitPrerequisiteRepair(f.job, { turnDigest: f.turnDigest,
    id: f.admitted.id, sourceSha: f.after, submittedSha: final, paths: [f.path] });
  const lastReviewerFile = join(f.stateDir, "review-sessions", "second.jsonl");
  const transcript = JSON.stringify({ type: "session", id: "second" }) + "\n" +
    JSON.stringify({ type: "message", role: "assistant", text: "confirmed corrected outcome" }) + "\n";
  writeFileSync(lastReviewerFile, transcript);
  const lastReview = { verdict: "pass", findings: [], evidence: [f.path + ":5"] };
  const lastReviewDigest = hash(JSON.stringify({ reviewerSessionDigest: hash(transcript),
    proposal: next.digest, commitSha: final, ...lastReview }));
  await settlePrerequisiteRepair(f.job, { turnDigest: f.turnDigest,
    id: f.admitted.id, submittedSha: final, reviewDigest: lastReviewDigest, verdict: "passed" });
  const state: any = { ...f.state, proposal: next, commitSha: final,
    validation: { status: "passed", sourceSha: f.after,
      validatorVersion: f.job.validatorVersion },
    authoredDigest: hash(readFileSync(f.target, "utf8")),
    reviewerSessionFile: lastReviewerFile, reviewerSessionDigest: hash(transcript),
    review: lastReview, reviewDigest: lastReviewDigest,
    history: [{
      proposal: f.proposal, commitSha: f.after, reviewDigest: f.state.reviewDigest,
      review: f.state.review,
      writerSessionDigest: f.state.writerSessionDigest,
      reviewerSessionDigest: f.state.reviewerSessionDigest,
      writerSessionFile: f.state.sessionFile,
      reviewerSessionFile: f.state.reviewerSessionFile,
      reviewSnapshot: f.snapshot, feedback: "original Milestone still unearned",
    }] };
  writeFileSync(f.receiptFile, JSON.stringify(state));
  await verifyCrossDomainCloseoutSuccessor(f.job, f.after, f.before,
    ["story/" + f.path], f.trailers);
  const finalMessage = git(f.root, "log", "-1", "--format=%B").split("\n");
  await verifyCrossDomainCloseoutSuccessor(f.job, final, f.after,
    ["story/" + f.path], finalMessage);
  const corrupted = structuredClone(state);
  corrupted.history[0].reviewDigest = "f".repeat(64);
  writeFileSync(f.receiptFile, JSON.stringify(corrupted));
  await assert.rejects(() => verifyCrossDomainCloseoutSuccessor(f.job, final,
    f.after, ["story/" + f.path], finalMessage), /negative review/);
});
test("a forged reviewed phase, record path or original source hash cannot grant downstream admission", async t => {
  const f = await setup(t);
  const check = () => verifyCrossDomainCloseoutSuccessor(f.job, f.after,
    f.before, ["story/" + f.path], f.trailers);
  for (const tamper of [
    (v: any) => { v.phase = "reviewing"; },
    (v: any) => { v.review.verdict = "block"; },
    (v: any) => { v.proposal.sourceSha = "f".repeat(40); },
    (v: any) => { v.proposal.allowedPaths = ["milestones/other.md"]; },
    (v: any) => { v.authoredDigest = "f".repeat(64); },
    (v: any) => { v.reviewDigest = "f".repeat(64); },
  ]) {
    const state = structuredClone(f.state);
    tamper(state);
    writeFileSync(f.receiptFile, JSON.stringify(state));
    await assert.rejects(check);
  }
  writeFileSync(f.receiptFile, JSON.stringify(f.state));
  await assert.rejects(() => verifyCrossDomainCloseoutSuccessor(f.job, f.after,
    f.before, ["story/events/unknown.md"], f.trailers));
});
