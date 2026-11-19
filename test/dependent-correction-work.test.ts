import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JobStartResult } from "../src/job.js";
import type { GenerationInventory, ExecutionItem } from "../src/generation-plan.js";
import { createSkillSnapshot } from "../src/snapshot.js";
import { proposeDependentCorrection, planSelectiveRevalidation } from "../src/selective-revalidation.js";
import { auditDependentCorrectionDraft, inspectDependentCorrection,
  verifyDependentCorrectionSuccessor, verifiedPiSession } from "../src/dependent-correction-work.js";
import { removeTestTree } from "./helpers.js";

const hash = (value: unknown) => createHash("sha256").update(
  typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const digest = (c: string) => c.repeat(64);
function git(dir: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
async function setup(t: import("node:test").TestContext) {
  const root = mkdtempSync(join(tmpdir(), "nt-original-owner-repair-"));
  const old = process.env.NT_SKILL_CACHE_DIR;
  process.env.NT_SKILL_CACHE_DIR = join(root, "cache");
  t.after(() => {
    if (old === undefined) delete process.env.NT_SKILL_CACHE_DIR;
    else process.env.NT_SKILL_CACHE_DIR = old;
    removeTestTree(root);
  });
  const skillsDir = join(root, "skills");
  mkdirSync(join(skillsDir, "skills", "nt-narrative-review"), { recursive: true });
  writeFileSync(join(skillsDir, "skills", "nt-narrative-review", "SKILL.md"),
    "---\nname: nt-narrative-review\n---\nReview actual Story sources.\n");
  git(skillsDir, "init", "-q");
  git(skillsDir, "config", "user.name", "Fixture");
  git(skillsDir, "config", "user.email", "fixture@example.invalid");
  git(skillsDir, "add", ".");
  git(skillsDir, "commit", "-qm", "Pinned skills");
  const snapshot = await createSkillSnapshot({ discovery: "explicit-only",
    novelteaSkills: skillsDir, skillDirs: [], requiredSkills: ["nt-narrative-review"] });
  assert.ok(snapshot);
  const repo = join(root, "story");
  mkdirSync(join(repo, "events"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Fixture");
  git(repo, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(repo, "events", "choice.md"), "# Reviewed original\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "Historically reviewed Choice");
  const historicalSha = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "events", "upstream.md"), "# Reviewed upstream correction\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "Upstream correction");
  const sourceSha = git(repo, "rev-parse", "HEAD");
  const stateDir = join(root, "state");
  const job = { jobId: "job-a", threadId: "thread-a", stateDir,
    worktreeRoot: repo, worktreeStoryRoot: repo, branch: "main" } as JobStartResult;
  const upstream = { id: "event:milestone.alpha", stage: "event",
    status: "verified", verifiedSha: historicalSha,
    dependencies: [], planVersion: 2, milestone: "milestone.alpha",
  } as ExecutionItem;
  const dependent = { id: "interactive:milestone.alpha", stage: "interactive",
    status: "verified", verifiedSha: historicalSha,
    dependencies: [upstream.id], planVersion: 2, milestone: "milestone.alpha",
  } as ExecutionItem;
  const inventory = { version: 1, headSha: historicalSha,
    planVersion: 2, items: [upstream, dependent], rationale: "Original reviewed Story" } as GenerationInventory;
  const turnDigest = digest("b");
  const plan = planSelectiveRevalidation({ inventory,
    correction: { version: 1, planVersion: 2, baseSha: historicalSha,
      successorSha: sourceSha, predecessorCommitSha: historicalSha,
      upstreamItemId: upstream.id, turnDigest, reviewDigest: digest("c"),
      changedPaths: ["events/upstream.md"], permittedPaths: ["events/upstream.md"] },
    reviews: {
      [upstream.id]: { commitSha: historicalSha, reviewDigest: digest("d"),
        status: "passed", sourcePaths: ["events/upstream.md"] },
      [dependent.id]: { commitSha: historicalSha, reviewDigest: digest("e"),
        status: "passed", sourcePaths: ["events/upstream.md"] },
    } });
  const proposal = proposeDependentCorrection({ plan, item: dependent,
    originalCommitSha: historicalSha, assignmentId: "interactive",
    specialist: "nt-interactive-narrative",
    originalReviewDigest: digest("e"), revalidationReviewDigest: digest("f"),
    currentHeadSha: sourceSha, ownerPaths: ["events/choice.md"],
    blockingPaths: ["events/choice.md"], originalObligation: "Resolve the Choice outcome." });
  writeFileSync(join(repo, "events", "choice.md"), "# Corrected original Choice\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", [
    "Correct previously reviewed Choice", "",
    "NovelTea-Job: job-a",
    "NovelTea-Work-Item: dependent-repair-" + historicalSha,
    "NovelTea-Plan-Version: 2",
    "NovelTea-Dependent-Native: " + digest("2"),
    "NovelTea-Dependent-Correction: " + proposal.digest,
  ].join("\n"));
  const commitSha = git(repo, "rev-parse", "HEAD");
  const oldSession = join(stateDir, "interactive-sessions", "original.jsonl");
  const writerSession = join(stateDir, "dependent-correction-sessions", proposal.digest, "writer.jsonl");
  const reviewerSession = join(stateDir, "review-sessions", "narrative", "review", "reviewer.jsonl");
  for (const file of [oldSession, writerSession, reviewerSession])
    mkdirSync(join(file, ".."), { recursive: true });
  const transcript = (id: string) => JSON.stringify({ type: "session", id }) + "\n" +
    JSON.stringify({ type: "message", content: "Actual independently inspected source line" }) + "\n";
  writeFileSync(oldSession, transcript("original"));
  writeFileSync(writerSession, transcript("corrective-writer"));
  writeFileSync(reviewerSession, transcript("independent-review"));
  const review = { verdict: "pass" as const, findings: [], evidence: ["events/choice.md:1"] };
  const reviewerSessionDigest = hash(transcript("independent-review"));
  const reviewDigest = hash({ proposal: proposal.digest, source: commitSha,
    transcript: reviewerSessionDigest, review });
  const state = {
    version: 1, jobId: job.jobId, threadId: job.threadId, turnDigest, proposal,
    phase: "verified", currentSourceSha: commitSha,
    originalCheckpointProofDigest: digest("a"),
    originalSessionDigest: hash(transcript("original")),
    origin: { workItem: "interactive-choice-alpha", sessionFile: oldSession,
      sessionId: "original", provider: "openai", model: "gpt-6", snapshot },
    snapshot,
    attempts: [{
      sourceSha, commitSha, paths: ["events/choice.md"],
      draftDigest: hash([["events/choice.md", git(repo, "diff", "--binary",
        sourceSha, commitSha, "--", "events/choice.md")]]), validationDigest: digest("2"),
      writerSession, writerSessionDigest: hash(transcript("corrective-writer")),
      reviewerSession, reviewerSessionDigest, reviewDigest, review,
    }],
  };
  const receiptFile = join(stateDir, "dependent-corrections", proposal.digest + ".json");
  mkdirSync(join(receiptFile, ".."), { recursive: true });
  const save = (s: unknown) => writeFileSync(receiptFile, JSON.stringify(s));
  save(state);
  return { job, plan, proposal, state, save, repo, root, commitSha, historicalSha,
    writerSession, reviewerSession, oldSession, transcript };
}
test("a reviewed dependent successor preserves original commit and verifies real Git path and sessions", async t => {
  const x = await setup(t);
  const saved = await inspectDependentCorrection(x.job, x.proposal, x.plan);
  assert.equal(saved?.attempts[0]?.commitSha, x.commitSha);
  assert.equal(saved?.phase, "verified");
  assert.equal(await verifiedPiSession(x.job, x.writerSession, x.oldSession),
    hash(x.transcript("corrective-writer")));
  // A private receipt alone never substitutes for native/reviewer/Turn history.
  await assert.rejects(() => verifyDependentCorrectionSuccessor(
    x.job, x.commitSha, x.state.attempts[0].sourceSha, ["events/choice.md"],
    git(x.repo, "log", "-1", "--format=%B").split("\n")), /checkpoint|review|original|source/i);
});
test("already-reviewed Choice correction may not rewrite a previous Event prerequisite gate", async t => {
  const x = await setup(t);
  const storyFile = join(x.repo, "events", "choice.md");
  const original = `---
type: event
id: event.choice
prerequisites:
  any_of:
    - conditions: []
status: draft
---
# Actual original Choice consequence
`;
  writeFileSync(storyFile, original);
  git(x.repo, "add", ".");
  git(x.repo, "commit", "-qm", "Canonical Choice prerequisite baseline");
  const source = git(x.repo, "rev-parse", "HEAD");
  writeFileSync(storyFile, original.replace("conditions: []",
    "conditions: [{kind: outcome, choice_point: choice.alpha, value: yes}]"));
  await assert.rejects(
    auditDependentCorrectionDraft(x.job, x.proposal, source), /prerequisite route/);
  writeFileSync(storyFile, original.replace("Actual original Choice consequence",
    "Corrected, source-bound Choice consequence"));
  assert.deepEqual(await auditDependentCorrectionDraft(x.job, x.proposal, source),
    ["events/choice.md"]);
  git(x.repo, "add", ".");
  await assert.rejects(
    auditDependentCorrectionDraft(x.job, x.proposal, source), /staged|unrelated/);
});
test("forged scope, changed source and transcript alteration fail closed before carry-forward", async t => {
  const x = await setup(t);
  for (const mutate of [
    (s: any) => { s.phase = "reviewing"; s.attempts[0].paths = ["characters/fake.md"]; },
    (s: any) => { s.attempts[0].reviewDigest = digest("f"); },
    (s: any) => { s.attempts[0].draftDigest = digest("f"); },
    (s: any) => { s.attempts[0].sourceSha = x.historicalSha; },
    (s: any) => { s.attempts[0].commitSha = x.historicalSha; },
    (s: any) => { s.proposal.authorizedPaths = ["characters/fake.md"]; },
    (s: any) => { s.originalCheckpointProofDigest = "forged"; },
    (s: any) => { s.currentSourceSha = x.historicalSha; },
  ]) {
    const altered = structuredClone(x.state);
    mutate(altered);
    x.save(altered);
    await assert.rejects(() => inspectDependentCorrection(x.job, x.proposal, x.plan));
  }
  x.save(x.state);
  writeFileSync(x.reviewerSession, x.transcript("tampered-review"));
  await assert.rejects(() => inspectDependentCorrection(x.job, x.proposal, x.plan),
    /provenance|reviewer/i);
});
