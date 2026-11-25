import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createSkillSnapshot } from "../src/snapshot.js";
import { boundedPinnedSources } from "../src/bounded-specialist-prompt.js";
import { authorMilestoneCloseout } from "../src/cross-domain-closeout-specialist.js";
import { withStoryJobLock } from "../src/job-lock.js";
import { withJobModelRuntime } from "../src/model-runtime.js";
import { fixtureSandboxClient, scriptedModel, scriptedReadCalls,
  scriptedStoryRuntime, scriptedText } from "./c03-scripted-story-helpers.js";
import { removeTestTree } from "./helpers.js";
import { admitPrerequisiteRepair, submitPrerequisiteRepair,
  settlePrerequisiteRepair } from "../src/repair-ledger.js";
import { verifyCrossDomainCloseoutSuccessor, closeoutReviewDigest,
  verifyLegacyCloseoutReviewTranscript, recoveredCloseoutReview,
  inspectPublishedCloseoutCommit, inspectInterruptedCloseoutCommit } from "../src/cross-domain-closeout-work.js";
import { reviewNarrative, type ReviewAssignment } from "../src/narrative-review-specialist.js";
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
    baseSha: before, validatorVersion: "0.1.0",
    worktreeRoot: root, worktreeStoryRoot: story,
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
test("#240: a genuine scripted Pi correction starts, edits only its bounded Milestone and settles in one original session", async t => {
  const f = await setup(t);
  // The disposable fixture keeps private Pi transcripts and the skill cache
  // under its Git root. They are not canonical Story content.
  writeFileSync(join(f.root, ".git", "info", "exclude"),
    "/state/\n/skill-cache/\n");
  const checkout = resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills");
  const snapshot = await createSkillSnapshot({ discovery: "explicit-only",
    novelteaSkills: checkout, skillDirs: [],
    requiredSkills: ["nt-event-design", "nt-catalog"] });
  assert.ok(snapshot);
  // The prebuilt signed fixture closeout is not a model execution. Return to
  // the actual before-HEAD and require Pi to perform the edit with its own
  // authenticated tool invocation rather than accepting the fixture's bytes.
  git(f.root, "reset", "--hard", f.before);
  assert.equal(readFileSync(f.target, "utf8"), original);
  const cleanup = fixtureSandboxClient(f.job.jobId, f.job.worktreeStoryRoot);
  t.after(cleanup);
  const mandatory = boundedPinnedSources("nt-event-design").map(path => "skill://" + path);
  const { runtime, observed } = await scriptedStoryRuntime(index => {
    if (index === 0) return {
      content: scriptedReadCalls([...mandatory, f.path], index), reason: "toolUse",
    };
    if (index === 1) return {
      content: [{
        type: "toolCall", id: "bounded-milestone-original-edit", name: "edit",
        arguments: { path: f.path, edits: [{
          oldText: "completeness: partial\\nfulfillment:\\n  any_of: []".replace(/\\n/g, "\n"),
          newText: "completeness: complete\\nfulfillment:\\n  any_of:\\n    - [event.setup]".replace(/\\n/g, "\n"),
        }] },
      }], reason: "toolUse",
    };
    if (index === 2) return {
      content: scriptedText({ verdict: "pass",
        evidence: [f.path + ":5"],
        reason: "The existing reachable Event now proves the original Milestone." }),
      reason: "stop",
    };
    throw Error("A bounded source-backed correction cannot require another Pi turn.");
  });
  let originalSession = "";
  const verified = await withJobModelRuntime(runtime, () =>
    withStoryJobLock(f.job, "test-original-milestone-closeout", () => authorMilestoneCloseout(
      f.job, snapshot, f.proposal, [f.path], scriptedModel.provider, scriptedModel.id,
      async file => { originalSession = file; },
      async () => readFileSync(f.target, "utf8") === completed ? [] :
        [{ kind: "requirement", path: f.path, code: "closeout-incomplete" }],
    )));
  assert.equal(verified.sessionFile, originalSession);
  assert.deepEqual(verified.evidence, [f.path + ":5"]);
  assert.equal(readFileSync(f.target, "utf8"), completed);
  assert.equal(observed.length, 3, "One independent bounded Pi session, not retried authoring");
  assert.ok(observed[0]?.tools.includes("read") &&
    observed[0]?.tools.includes("edit") &&
    !observed[0]?.tools.includes("write"),
    "The Event closeout never receives general file-write tools");
  const transcript = readFileSync(originalSession, "utf8");
  assert.match(transcript, /bounded-milestone-original-edit/);
  assert.equal(git(f.root, "rev-parse", "HEAD"), f.before,
    "The correcting agent may edit only; controller still owns the Git commit");
  assert.match(git(f.root, "status", "--porcelain"), /milestones\/choice-enacted\.md/);
  git(f.root, "add", "--", "story/" + f.path);
  git(f.root, "commit", "-qm", [
    "Finish source-bound Milestone", "",
    "NovelTea-Job: " + f.job.jobId,
    "NovelTea-Work-Item: prerequisite-choice-enacted",
    "NovelTea-Plan-Version: 2",
    "NovelTea-Prerequisite: " + f.proposal.digest,
  ].join("\n"));
  const corrected = git(f.root, "rev-parse", "HEAD");
  const reviewSnapshot = await createSkillSnapshot({ discovery: "explicit-only",
    novelteaSkills: checkout, skillDirs: [],
    requiredSkills: ["nt-narrative-review", "nt-catalog"] });
  assert.ok(reviewSnapshot);
  const reviewSources = [...boundedPinnedSources("nt-narrative-review"),
    "nt-catalog/references/glossary.md"].map(path => "skill://" + path);
  const { runtime: reviewerRuntime, observed: reviewerCalls } =
    await scriptedStoryRuntime(index => {
      if (index === 0) return {
        content: scriptedReadCalls([...reviewSources, f.path], index),
        reason: "toolUse",
      };
      if (index === 1) return {
        content: scriptedText({ verdict: "pass", findings: [],
          evidence: [f.path + ":5"] }), reason: "stop",
      };
      throw Error("The original independent reviewer must not run another turn.");
    });
  const assignment: ReviewAssignment = {
    contract: {}, planVersion: 2, scopeIds: [f.proposal.milestoneId],
    paths: [f.path], routes: [], milestoneRoutes: [], puzzleRoutes: [],
    outstanding: [], uncertainties: [],
    specialistAssignments: [{ id: "prerequisite:" + f.proposal.milestoneId,
      specialist: "nt-event-design", outcome: "Verify the exact Milestone field amendment",
      targets: [f.proposal.milestoneId],
      authority: { recordTypes: ["milestone"], existingPaths: [f.path],
        mayCreate: false } }],
  };
  let independentSession = "";
  const review = await withJobModelRuntime(reviewerRuntime, () =>
    withStoryJobLock(f.job, "test-independent-original-closeout-review", () =>
      reviewNarrative({ ...f.job, headSha: corrected }, reviewSnapshot, assignment,
        scriptedModel.provider, scriptedModel.id, undefined,
        async file => { independentSession = file; })));
  assert.equal(review.verdict, "pass");
  assert.deepEqual(review.evidence, [f.path + ":5"]);
  assert.equal(reviewerCalls.length, 2);
  assert.ok(reviewerCalls.every(call => !call.tools.includes("write") &&
    !call.tools.includes("edit") && !call.tools.includes("bash")),
  "Independent reviewer receives no mutating Story tools");
  assert.notEqual(independentSession, originalSession,
    "Independent Review must never reuse the original author's conversation");
  assert.match(readFileSync(independentSession, "utf8"), /c03-read-0/);
  assert.equal(git(f.root, "status", "--porcelain"), "");
});

test("#240: authored closeout reconciles exactly one already-published original commit without writer replay", async t => {
  const f = await setup(t);
  // The original Pi session and authored-byte digest were durable before Git
  // committed, but the process crashed before persisting phase=committed.
  const interrupted = { ...f.state, phase: "authored" as const,
    commitSha: undefined, validation: undefined, review: undefined,
    reviewDigest: undefined, reviewerSessionDigest: undefined,
    reviewerSessionFile: undefined };
  // Test fixture keeps private session/ledger state inside its temporary
  // Git root; a real job keeps those files outside the Story worktree.
  writeFileSync(join(f.root, ".git", "info", "exclude"), "/state/\n/skill-cache/\n");
  const originalSession = readFileSync(interrupted.sessionFile, "utf8");
  const originalHead = git(f.root, "rev-parse", "HEAD");
  assert.equal(await inspectPublishedCloseoutCommit(f.job, interrupted), f.after);
  assert.equal(await inspectPublishedCloseoutCommit(f.job, interrupted), f.after,
    "Reinspect cannot stage, commit or re-invoke an already-authored writer");
  assert.equal(readFileSync(interrupted.sessionFile, "utf8"), originalSession);
  assert.equal(git(f.root, "rev-parse", "HEAD"), originalHead);
  assert.equal(git(f.root, "status", "--porcelain"), "");
  await assert.rejects(inspectPublishedCloseoutCommit(f.job, {
    ...interrupted, writerSessionDigest: "f".repeat(64),
  }), /original settled writer receipt/);
  await assert.rejects(inspectPublishedCloseoutCommit(f.job, {
    ...interrupted, authoredDigest: "f".repeat(64),
  }), /signed source or authored bytes/);
  await assert.rejects(inspectPublishedCloseoutCommit(f.job, {
    ...interrupted, phase: "writing" as const,
  }), /original settled writer receipt/);
});

test("#240: parent graph restart may inspect only the selected unpublished closeout, never promote HEAD", async t => {
  const f = await setup(t);
  writeFileSync(join(f.root, ".git", "info", "exclude"), "/state/\n/skill-cache/\n");
  const originalInventoryDigest = hash("immutable-original-graph-inventory");
  const expected = { milestoneId: f.proposal.milestoneId,
    planVersion: f.proposal.planVersion, sourceSha: f.before,
    proposalDigest: f.proposal.digest, repairId: f.admitted.id,
    originalInventoryDigest };
  // Emulate the actual receipt persisted after the original source-bound
  // writer finished, before the controller received its LangGraph node return.
  const authenticated = { ...f.state, phase: "authored" as const,
    originalInventoryDigest, commitSha: undefined, review: undefined,
    reviewDigest: undefined, validation: undefined };
  writeFileSync(f.receiptFile, JSON.stringify(authenticated));
  assert.equal(await inspectInterruptedCloseoutCommit(f.job, expected), f.after);
  const reviewNotYetPublished = JSON.parse(readFileSync(join(f.stateDir,
    "revisions", "verified-head.json"), "utf8"));
  assert.equal(reviewNotYetPublished.headSha, f.before,
    "The original source stays the only verified HEAD until a new reviewer passes");
  await assert.rejects(inspectInterruptedCloseoutCommit(f.job, {
    ...expected, originalInventoryDigest: "f".repeat(64),
  }), /selected original recovery operation/);
  await assert.rejects(inspectInterruptedCloseoutCommit(f.job, {
    ...expected, proposalDigest: "f".repeat(64),
  }), /selected original recovery operation/);
  const committed = { ...authenticated, phase: "committed" as const,
    commitSha: f.after, validation: f.state.validation };
  writeFileSync(f.receiptFile, JSON.stringify(committed));
  assert.equal(await inspectInterruptedCloseoutCommit(f.job, expected), f.after);
  writeFileSync(f.receiptFile, JSON.stringify({
    ...committed, validation: { ...committed.validation, sourceSha: "f".repeat(40) },
  }));
  await assert.rejects(inspectInterruptedCloseoutCommit(f.job, expected),
    /native validation or writer proof/);
  writeFileSync(f.receiptFile, JSON.stringify({
    ...committed, phase: "reviewing" as const,
  }));
  await assert.rejects(inspectInterruptedCloseoutCommit(f.job, expected),
    /completed reviewer session|pinned original session/i,
    "An uncertain independent reviewer cannot be replayed under the writer exception");
});

test("#240: completed original closeout reviewer can be recovered after phase checkpoint loss without replay", async t => {
  const f = await setup(t);
  writeFileSync(join(f.root, ".git", "info", "exclude"), "/state/\n/skill-cache/\n");
  const sessionDir = join(f.stateDir, "review-sessions", "review");
  mkdirSync(sessionDir, { recursive: true });
  const sessionFile = join(sessionDir, "completed-original.jsonl");
  const sessionId = "original-completed-independent-review";
  const positive = { verdict: "pass", findings: [], evidence: [f.path + ":5"] };
  const transcript = JSON.stringify({ type: "session", id: sessionId }) + "\n" +
    JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "stop",
      content: [{ type: "text", text: JSON.stringify(positive) }] } }) + "\n";
  const sessionSha256 = hash(transcript);
  writeFileSync(sessionFile, transcript);
  const model = "openai/gpt-6-luna:pi-default";
  const group = "narrative:" + f.proposal.planVersion;
  const contextFile = join(f.stateDir, "pi-contexts", hash(group) + ".json");
  mkdirSync(join(f.stateDir, "pi-contexts"), { recursive: true });
  writeFileSync(contextFile, JSON.stringify({ version: 1, group, file: sessionFile,
    sessionId, snapshot: f.snapshot.id, model, sources: {},
    sessionSha256 }) + "\n");
  writeFileSync(join(f.stateDir, "pi-resolution.json"), JSON.stringify({
    version: 1, requested: { provider: "openai", model: "gpt-6-luna" },
    selected: { provider: "openai", model: "gpt-6-luna" }, source: "required",
  }) + "\n");
  writeFileSync(join(f.stateDir, "pi-budget.json"), JSON.stringify({
    version: 1, steps: [], sessions: [sessionFile],
  }) + "\n");
  const expected = { milestoneId: f.proposal.milestoneId,
    planVersion: f.proposal.planVersion, sourceSha: f.before,
    proposalDigest: f.proposal.digest, repairId: f.admitted.id,
    originalInventoryDigest: hash("immutable-graph-inventory") };
  const reviewing = { ...f.state, phase: "reviewing" as const,
    originalInventoryDigest: expected.originalInventoryDigest,
    review: undefined, reviewDigest: undefined, reviewerSessionDigest: undefined,
    reviewerSessionFile: sessionFile };
  writeFileSync(f.receiptFile, JSON.stringify(reviewing));
  const savedHead = readFileSync(join(f.stateDir, "revisions", "verified-head.json"), "utf8");
  assert.equal(await inspectInterruptedCloseoutCommit(f.job, expected), f.after,
    "The exact original completed Pi session qualifies only for review recovery");
  assert.equal(readFileSync(join(f.stateDir, "revisions", "verified-head.json"), "utf8"),
    savedHead, "Inspection cannot publish the unreviewed correction");
  assert.equal(git(f.root, "rev-parse", "HEAD"), f.after);
  const assignment: ReviewAssignment = { contract: {}, planVersion: f.proposal.planVersion,
    scopeIds: [f.proposal.milestoneId], paths: [f.path], routes: [],
    milestoneRoutes: [], puzzleRoutes: [], outstanding: [], uncertainties: [],
    specialistAssignments: [{ id: "prerequisite:" + f.proposal.milestoneId,
      specialist: "nt-event-design", outcome: "Certify the original Milestone",
      targets: [f.proposal.milestoneId],
      authority: { recordTypes: ["milestone"], existingPaths: [f.path], mayCreate: false } }],
  };
  assert.deepEqual(await recoveredCloseoutReview(f.job, sessionFile, sessionSha256, assignment),
    positive, "The actual transcript supplies the editorial verdict without model invocation");
  assert.equal(await inspectInterruptedCloseoutCommit(f.job, expected), f.after,
    "Reinspection remains immutable and cannot restart the reviewer");
  const blockedReview = { verdict: "block", findings: [{
    severity: "blocking", dimension: "continuity", source: f.path + ":5",
    message: "The original Event evidence does not establish the proposed fulfillment.",
    repair: "event",
  }], evidence: [] };
  const blockedTranscript = JSON.stringify({ type: "session", id: sessionId }) + "\n" +
    JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "stop",
      content: [{ type: "text", text: JSON.stringify(blockedReview) }] } }) + "\n";
  writeFileSync(sessionFile, blockedTranscript);
  writeFileSync(contextFile, JSON.stringify({ version: 1, group, file: sessionFile,
    sessionId, snapshot: f.snapshot.id, model, sources: {},
    sessionSha256: hash(blockedTranscript) }) + "\n");
  assert.equal(await inspectInterruptedCloseoutCommit(f.job, expected), f.after);
  const recoveredNegative = await recoveredCloseoutReview(f.job, sessionFile,
    hash(blockedTranscript), assignment);
  assert.equal(recoveredNegative.verdict, "block",
    "Original negative independent verdict remains negative after crash recovery");
  const inconsistentReview = JSON.stringify({ type: "session", id: sessionId }) + "\n" +
    JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "stop",
      content: [{ type: "text", text: JSON.stringify({ ...blockedReview, verdict: "pass" }) }] } }) + "\n";
  writeFileSync(sessionFile, inconsistentReview);
  await assert.rejects(recoveredCloseoutReview(f.job, sessionFile,
    hash(inconsistentReview), assignment), /blocking|verdict/i,
    "A blocking original finding cannot be upgraded to PASS");
  writeFileSync(sessionFile, transcript);
  writeFileSync(contextFile, JSON.stringify({ version: 1, group, file: sessionFile,
    sessionId, snapshot: f.snapshot.id, model, sources: {}, sessionSha256 }) + "\n");
  writeFileSync(sessionFile, transcript + JSON.stringify({ type: "message",
    message: { role: "assistant", stopReason: "stop",
      content: [{ type: "text", text: "forged approval" }] } }) + "\n");
  await assert.rejects(inspectInterruptedCloseoutCommit(f.job, expected),
    /transcript changed|completed reviewer/i);
  writeFileSync(sessionFile, transcript);
  writeFileSync(contextFile, JSON.stringify({ version: 1, group, file: sessionFile,
    sessionId, snapshot: f.snapshot.id, model, sources: {} }) + "\n");
  await assert.rejects(inspectInterruptedCloseoutCommit(f.job, expected),
    /completed Pi context/);
  assert.equal(git(f.root, "status", "--porcelain", "--untracked-files=all"), "",
    "Recovery never edits the source Story");
});

test("#240: original reviewed and independently published closeout reconcile after checkpoint loss", async t => {
  const f = await setup(t);
  writeFileSync(join(f.root, ".git", "info", "exclude"), "/state/\n/skill-cache/\n");
  const originalInventoryDigest = hash("reviewed-and-published-inventory");
  const expected = { milestoneId: f.proposal.milestoneId,
    planVersion: f.proposal.planVersion, sourceSha: f.before,
    proposalDigest: f.proposal.digest, repairId: f.admitted.id,
    originalInventoryDigest };
  const state = { ...f.state, originalInventoryDigest };
  writeFileSync(f.receiptFile, JSON.stringify({ ...state, phase: "reviewed" }));
  assert.equal(await inspectInterruptedCloseoutCommit(f.job, expected), f.after,
    "Original settled independent verdict is enough to resume missing ledger settlement");
  const verifiedHeadFile = join(f.stateDir, "revisions", "verified-head.json");
  const originalHeadReceipt = readFileSync(verifiedHeadFile, "utf8");
  const verified = { ...state, phase: "verified" };
  writeFileSync(f.receiptFile, JSON.stringify(verified));
  assert.equal(await inspectInterruptedCloseoutCommit(f.job, expected), f.after,
    "Verified but not yet published remains recoverable, not a new writer");
  writeFileSync(verifiedHeadFile, JSON.stringify({
    version: 1, jobId: f.job.jobId, headSha: f.after,
    workItemId: state.workItemId,
  }));
  assert.equal(await inspectInterruptedCloseoutCommit(f.job, expected), f.after,
    "Published commit before parent checkpoint remains the SAME recovered closeout");
  assert.equal(git(f.root, "rev-parse", "HEAD"), f.after);
  const tampered = { ...verified, reviewDigest: "f".repeat(64) };
  writeFileSync(f.receiptFile, JSON.stringify(tampered));
  await assert.rejects(inspectInterruptedCloseoutCommit(f.job, expected),
    /original independent verdict/);
  writeFileSync(f.receiptFile, JSON.stringify(verified));
  writeFileSync(join(f.stateDir, "repair-ledgers", f.turnDigest + ".json"),
    JSON.stringify({ version: 1, prerequisites: [] }));
  await assert.rejects(inspectInterruptedCloseoutCommit(f.job, expected),
    /resolved independent Review ledger|Repair ledger identity/);
  assert.equal(git(f.root, "status", "--porcelain", "--untracked-files=all"), "");
  // No session, writer invocation, original source or HEAD mutation occurred.
  writeFileSync(verifiedHeadFile, originalHeadReceipt);
});

test("#240: only original parent, exact owned paths and source-bound trailers can reconcile an interrupted closeout", async t => {
  const f = await setup(t);
  const original = { ...f.state, phase: "authored" as const,
    commitSha: undefined, validation: undefined };
  writeFileSync(join(f.root, ".git", "info", "exclude"), "/state/\n/skill-cache/\n");
  // The current HEAD is now a descendant, not the exact committed operation.
  git(f.root, "commit", "--allow-empty", "-qm", "Other author touched the branch");
  await assert.rejects(inspectPublishedCloseoutCommit(f.job, original),
    /original parent or bounded file inventory/);

  git(f.root, "reset", "--hard", f.before);
  writeFileSync(f.target, completed);
  // Reuse the original metadata but add a forbidden unrelated file to the
  // same Git commit: even matching trailers cannot widen the Event grant.
  mkdirSync(join(f.root, "story", "events"), { recursive: true });
  writeFileSync(join(f.root, "story", "events", "unrelated.md"), "Unauthorised change\n");
  git(f.root, "add", "--", "story/");
  git(f.root, "commit", "-qm", f.trailers.join("\n"));
  await assert.rejects(inspectPublishedCloseoutCommit(f.job, original),
    /original parent or bounded file inventory/);

  git(f.root, "reset", "--hard", f.before);
  writeFileSync(f.target, completed);
  git(f.root, "add", "--", "story/");
  git(f.root, "commit", "-qm", "Unrelated commit lacking signed prerequisite trailers");
  await assert.rejects(inspectPublishedCloseoutCommit(f.job, original),
    /original signed source or authored bytes/);

  git(f.root, "reset", "--hard", f.before);
  const unauthorized = completed.replace("The audience recognizes the genuine consequence.",
    "The Story now claims an entirely different protected outcome.");
  writeFileSync(f.target, unauthorized);
  git(f.root, "add", "--", "story/");
  git(f.root, "commit", "-qm", f.trailers.join("\n"));
  await assert.rejects(inspectPublishedCloseoutCommit(f.job, {
    ...original, authoredDigest: hash(unauthorized),
  }), /frontmatter|field|body|scope|protected/i,
    "A matching commit, digest and trailers still cannot change Milestone prose");
});

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
  // An already rejected historical review may have stored an advisory
  // diagnosis before that field entered the digest. Its original negative
  // ledger evidence remains valid, but cannot authorize another retry now.
  const historical = structuredClone(state);
  historical.history[0].review.progressDiagnosis = {
    status: "stalled", reason: "Historic diagnosis predates digest inclusion",
    evidence: null };
  writeFileSync(f.receiptFile, JSON.stringify(historical));
  await verifyCrossDomainCloseoutSuccessor(f.job, final, f.after,
    ["story/" + f.path], finalMessage);
  const corrupted = structuredClone(state);
  corrupted.history[0].reviewDigest = "f".repeat(64);
  writeFileSync(f.receiptFile, JSON.stringify(corrupted));
  await assert.rejects(() => verifyCrossDomainCloseoutSuccessor(f.job, final,
    f.after, ["story/" + f.path], finalMessage), /negative review/);
});

test("#211: closeout progress diagnosis is sealed; older reviewed receipts retain their original digest", () => {
  const reviewerSessionDigest = "a".repeat(64);
  const proposal = "b".repeat(64);
  const commitSha = "c".repeat(40);
  const review = { verdict: "block" as const, findings: [{
    severity: "blocking" as const, dimension: "continuity" as const,
    source: "milestones/choice-enacted.md:7", repair: "event" as const,
    message: "The witness has no evidence.",
  }], evidence: [] };
  const old = hash(JSON.stringify({ reviewerSessionDigest,
    proposal, commitSha, verdict: review.verdict,
    findings: review.findings, evidence: review.evidence }));
  assert.equal(closeoutReviewDigest({ reviewerSessionDigest, proposal, commitSha, review }), old);
  const progressDiagnosis = { status: "material" as const,
    reason: "The new confession is source-grounded.",
    evidence: { path: "milestones/choice-enacted.md",
      quote: "New observed contradiction", change: "added" as const } };
  const sealed = closeoutReviewDigest({ reviewerSessionDigest, proposal, commitSha,
    review: { ...review, progressDiagnosis } });
  assert.notEqual(sealed, old);
  assert.equal(closeoutReviewDigest({ reviewerSessionDigest, proposal, commitSha,
    review: { ...review, progressDiagnosis } }, false), old,
    "Historical review proof remains independently recognizable without granting retries.");
  assert.notEqual(sealed, closeoutReviewDigest({ reviewerSessionDigest, proposal, commitSha,
    review: { ...review, progressDiagnosis: { ...progressDiagnosis, status: "stalled" } } }));
});
test("#211: an in-flight legacy reviewed closeout resumes from its pinned transcript without model replay", async t => {
  const f = await setup(t, "failed");
  const diagnosis = { status: "material" as const,
    reason: "The corrected Milestone now contains explicitly reachable Event evidence.",
    evidence: { path: f.path, quote: "event.setup", change: "added" as const } };
  const review = { verdict: "block" as const, findings: [{
    severity: "blocking" as const, dimension: "continuity" as const,
    source: f.path + ":5", message: "Unresolved downstream witness contradiction",
    repair: "event" as const }], evidence: [f.path + ":5"],
    progressDiagnosis: diagnosis };
  const assignment: ReviewAssignment = {
    contract: {}, planVersion: 2, scopeIds: ["milestone.choice-enacted"],
    paths: [f.path], routes: [], milestoneRoutes: [], puzzleRoutes: [],
    outstanding: [], uncertainties: [], progressScope: {
      previousSha: f.before, currentSha: f.after,
      priorFindings: [{ severity: "blocking", source: f.path + ":5",
        message: "Missing Event evidence" }],
      added: [{ path: f.path, line: "    - [event.setup]" }], removed: [],
    },
  };
  const sessionId = "reviewer";
  const raw = { verdict: review.verdict, findings: review.findings,
    evidence: review.evidence, progressDiagnosis: review.progressDiagnosis };
  const transcript = JSON.stringify({ type: "session", id: sessionId }) + "\n" +
    JSON.stringify({ type: "message", message: { role: "assistant",
      stopReason: "stop", content: [{ type: "text", text: JSON.stringify(raw) }] } }) + "\n";
  writeFileSync(f.state.reviewerSessionFile, transcript);
  const sessionSha = hash(transcript);
  const legacy = closeoutReviewDigest({
    reviewerSessionDigest: sessionSha, proposal: f.proposal.digest,
    commitSha: f.after, review,
  }, false);
  const current = closeoutReviewDigest({
    reviewerSessionDigest: sessionSha, proposal: f.proposal.digest,
    commitSha: f.after, review,
  });
  assert.notEqual(current, legacy, "The old digest omitted material progress advice.");
  await verifyLegacyCloseoutReviewTranscript(f.job, f.state.reviewerSessionFile,
    sessionSha, review, assignment);
  await assert.rejects(verifyLegacyCloseoutReviewTranscript(f.job,
    f.state.reviewerSessionFile, sessionSha,
    { ...review, progressDiagnosis: { status: "stalled",
      reason: "Forged status that must not authorize the original retry.", evidence: null } },
    assignment), /differs from the pinned independent reviewer transcript/);
  await assert.rejects(verifyLegacyCloseoutReviewTranscript(f.job,
    f.state.reviewerSessionFile, "f".repeat(64), review, assignment),
    /unchanged original reviewer transcript/);
  writeFileSync(f.state.reviewerSessionFile, transcript.replace("event.setup", "event.invented"));
  await assert.rejects(verifyLegacyCloseoutReviewTranscript(f.job,
    f.state.reviewerSessionFile, sessionSha, review, assignment),
    /unchanged original reviewer transcript/);
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
