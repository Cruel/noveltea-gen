import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startStoryJob, type JobStartResult } from "../src/job.js";
import { parseSpecialistChoice, activeSpecialistChoice, answerSpecialistChoice,
  claimSpecialistChoice, completeSpecialistChoice, recordSpecialistChoice,
  inspectSpecialistChoice } from "../src/specialist-choice.js";
import { changedRepairPaths, disagreementQuestion, repairFeedback,
  readRejectedRepairOrigin, prepareRejectedRepairFeedback, repairReviewOutcome, type RepairReceipt } from "../src/rejected-review-repair.js";
import type { RecoveryCheckpoint } from "../src/recovery-checkpoints.js";
import { readIndependentReview } from "../src/checkpoint-assurance.js";
import { removeTestTree } from "./helpers.js";
import { buildEventConsequenceProof, eventConsequenceProofDigest } from "../src/event-consequence-proof.js";

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

test("saved Autonomous Event findings replay as immutable source-bound repair feedback", {
  skip: !process.env.NT_TEST_EVENT_REPAIR_STATE && "set NT_TEST_EVENT_REPAIR_STATE to private #162 Autonomous state",
}, async t => {
  const directory = process.env.NT_TEST_EVENT_REPAIR_STATE!;
  const job = JSON.parse(readFileSync(join(directory, "job.json"), "utf8")) as JobStartResult;
  // Read-only replay: no receipt, Story, session or checkpoint is rewritten.
  for (const source of ["12ab1bd53395e5c1ccd6e1ad82e0645f207ec11b",
    "26ba3fe4a49b2bbfff17e54e43ef10a1316b7502",
    "2707cb7b658557f759b35fa31d13fbb27b508bf6",
    "d37f6753e4bb9e97b249ad7d973a2428d1c21c3b"]) {
    const state = JSON.parse(readFileSync(join(directory, "review-repairs", source + ".json"), "utf8")) as RepairReceipt;
    const point = JSON.parse(readFileSync(join(directory, "recovery-checkpoints", source + ".json"), "utf8")) as RecoveryCheckpoint;
    const original = (await readIndependentReview(job, point.assurance!)).result!;
    const successorPoint = JSON.parse(readFileSync(join(directory, "recovery-checkpoints",
      state.repairedCommitSha + ".json"), "utf8")) as RecoveryCheckpoint;
    const successor = (await readIndependentReview(job, successorPoint.assurance!)).result!;
    const draft = { ...state, phase: "reviewing" as const, findings: original.findings };
    const feedback = await prepareRejectedRepairFeedback(job, draft);
    assert.deepEqual(feedback.findings, original.findings);
    assert.ok(feedback.offendingSources.every(s => s.commitSha === source && s.text.length > 0));
    assert.ok(feedback.context.every(c => c.writable === feedback.allowedPaths.includes(c.path)));
    const completed = repairReviewOutcome(draft, successor);
    assert.deepEqual(completed.findings, original.findings);
    assert.deepEqual(completed.successorFindings, successor.findings);
    assert.deepEqual(completed.origin, state.origin);
    assert.equal(completed.phase, successor.status === "passed" ? "passed" : "failed");
    t.diagnostic(`source=${source} successor=${state.repairedCommitSha} phase=${completed.phase}`);
  }
});

test("negative Event rereview preserves source findings while reporting exact successor blockers", () => {
  const state = rejected();
  state.phase = "reviewing";
  state.repairedCommitSha = "d".repeat(40);
  const before = structuredClone(state);
  const review = { version: 1 as const, status: "failed" as const, reviewer: "independent",
    source: { ...state.source, commitSha: state.repairedCommitSha },
    findings: [{ path: "events/absence.md", line: 24,
      message: "The newly asserted past observation has no identified witness.",
      requiredCorrection: "Deliver the witness account before the disappearance inference." }],
    evidence: "Pinned successor source" };
  const failed = repairReviewOutcome(state, review);
  assert.equal(failed.phase, "failed");
  assert.deepEqual(failed.findings, before.findings);
  assert.deepEqual(failed.successorFindings, review.findings);
  assert.deepEqual(state, before);
  assert.equal(repairReviewOutcome({ ...state, attempts: 20 }, review).phase, "failed",
    "failed semantic review does not count toward a fixed allowance");
  const blocked = repairReviewOutcome(state, review, true);
  assert.equal(blocked.phase, "blocked");
  assert.match(blocked.failure!, /did not converge/);
  assert.deepEqual(blocked.successorFindings, review.findings);
  assert.throws(() => repairReviewOutcome(state, { ...review,
    source: { ...review.source, commitSha: sha } }), /successor/);
  const passed = repairReviewOutcome(state, { ...review, status: "passed", findings: [] });
  assert.equal(passed.phase, "passed");
  assert.deepEqual(passed.findings, before.findings);
});

test("source-linked repair feedback remains scoped and cannot silently expand protected authority", () => {
  const state = rejected();
  const feedback = repairFeedback(state);
  assert.deepEqual(feedback.allowedPaths, ["characters/nia.md"]);
  assert.equal(feedback.attempt, 2);
  assert.equal(Object.hasOwn(feedback, "maxAttempts"), false);
  assert.equal(feedback.assignment.outcome, "Give Nia a coherent reason to wait");
  const question = parseSpecialistChoice(disagreementQuestion(state));
  assert.equal(question.kind, "alternatives");
  assert.deepEqual(question.options?.map(option => option.id), ["correct", "revise"]);
  assert.equal(question.recommendedId, "correct");
  assert.match(question.options![1]!.tradeoffs, /source-bound/);
  assert.equal(state.phase, "ready", "A choice prompt never changes an immutable failed verdict");
});

test("Event repair receives the exact committed offending line and read-only causal sources", async t => {
  const root = mkdtempSync(join(tmpdir(), "nt-event-repair-source-"));
  t.after(() => removeTestTree(root));
  mkdirSync(join(root, "story/events"), { recursive: true });
  mkdirSync(join(root, "story/milestones"));
  writeFileSync(join(root, "story/events/absence.md"), "# Absence\nThe empty assigned room proves a disappearance.\n");
  writeFileSync(join(root, "story/milestones/absence.md"), "Establish a credible absence, not its cause.\n");
  git(root, "init", "-q"); git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.test");
  git(root, "add", "."); git(root, "commit", "-qm", "Rejected source");
  const sourceCommitSha = git(root, "rev-parse", "HEAD");
  const state = rejected();
  state.sourceCommitSha = sourceCommitSha;
  state.source = { ...state.source, commitSha: sourceCommitSha };
  state.allowedPaths = ["events/absence.md"];
  state.origin.workItem = "event-absence";
  state.findings = [{ path: "events/absence.md", line: 2, kind: "continuity",
    message: "Expectation is not last-known presence.",
    requiredCorrection: "Present a sourced witness account before the inference, preserving uncertainty.",
    affectedPaths: ["events/absence.md"] }];
  mkdirSync(join(root, ".git/event-items"));
  writeFileSync(join(root, ".git/event-items/absence.json"), JSON.stringify({ assignment: {
    sourcePaths: ["events/absence.md", "milestones/absence.md"],
  } }));
  const before = structuredClone(state);
  const job = { worktreeRoot: root, storyRelativePath: "story", stateDir: join(root, ".git") } as JobStartResult;
  // Later/dirty bytes must never be substituted for the failed review's source.
  writeFileSync(join(root, "story/events/absence.md"), "Unreviewed replacement.\n");
  const feedback = await prepareRejectedRepairFeedback(job, state);
  assert.equal(feedback.offendingSources[0]!.text, "The empty assigned room proves a disappearance.");
  assert.equal(feedback.offendingSources[0]!.line, 2);
  assert.equal(feedback.offendingSources[0]!.commitSha, sourceCommitSha);
  assert.match(feedback.causalGrounding!, /witness claim/);
  assert.match(feedback.causalGrounding!, /within this Event/);
  assert.deepEqual(feedback.context.map(c => [c.path, c.writable]), [
    ["events/absence.md", true], ["milestones/absence.md", false],
  ]);
  assert.match(feedback.context[1]!.content, /not its cause/);
  assert.deepEqual(state, before, "Preparing feedback must not mutate the failed verdict or authority");
  const corrected = "# Absence\nThe caretaker tells the player: I spoke with the visitor here before supper; I did not see where they went.\nThe player inspects the now-empty room.\nOnly then does the player infer a credible unexplained absence, not harm or a culprit.\n";
  writeFileSync(join(root, "story/events/absence.md"), corrected);
  assert.deepEqual(changedRepairPaths(job, state), ["events/absence.md"]);
  git(root, "add", "story/events/absence.md");
  git(root, "commit", "-qm", "Deliver sourced evidence before inference");
  assert.notEqual(git(root, "rev-parse", "HEAD"), sourceCommitSha);
  assert.equal((await prepareRejectedRepairFeedback(job, state)).offendingSources[0]!.text,
    "The empty assigned room proves a disappearance.", "A corrected commit never rewrites the failed source");
  assert.equal(readFileSync(join(root, "story/milestones/absence.md"), "utf8"),
    "Establish a credible absence, not its cause.\n");
  state.findings[0]!.line = 99;
  await assert.rejects(prepareRejectedRepairFeedback(job, state), /source line/);
  state.findings[0]!.line = 2;
  state.findings[0]!.affectedPaths!.push(".story-inbox/ideas/private.md");
  await assert.rejects(prepareRejectedRepairFeedback(job, state), /canonical|unsafe/i);
});

test("rejected Event feedback carries sealed typed slots and read-only sibling Event, never a forged map", async t => {
  const root = mkdtempSync(join(tmpdir(), "nt-event-repair-proof-"));
  t.after(() => removeTestTree(root));
  mkdirSync(join(root, "story/events"), { recursive: true });
  mkdirSync(join(root, "story/milestones"));
  const sourceText = "# Absence\nAda trusts the witness before speaking with them.\n";
  const siblingText = "# Witness\nThe caretaker reports seeing the visitor near the archive.\n";
  const milestoneText = "# Establish absence\nThe player encounters the witness.\n";
  writeFileSync(join(root, "story/events/absence.md"), sourceText);
  writeFileSync(join(root, "story/events/witness.md"), siblingText);
  writeFileSync(join(root, "story/milestones/absence.md"), milestoneText);
  const proof = buildEventConsequenceProof([
    { path: "milestones/absence.md", content: milestoneText,
      metadata: { type: "milestone", id: "milestone.absence" } },
    { path: "events/absence.md", content: sourceText,
      metadata: { type: "event", id: "event.absence", steps: [{
        id: "judgment", branches: [{ id: "accept", conditions: [], effects: [{
          kind: "relationship", relationship: "relationship.ada-caretaker", value: "trusting",
        }] }],
      }] } },
    { path: "events/witness.md", content: siblingText,
      metadata: { type: "event", id: "event.witness", steps: [] } },
  ], "milestone.absence", ["events/absence.md", "events/witness.md"], []);
  git(root, "init", "-q"); git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.test");
  git(root, "add", ".");
  git(root, "commit", "-qm", "Rejected Event source\n\nNovelTea-Event-Consequence: " +
    eventConsequenceProofDigest(proof));
  const sourceCommitSha = git(root, "rev-parse", "HEAD");
  const state = rejected();
  state.sourceCommitSha = sourceCommitSha;
  state.source = { ...state.source, commitSha: sourceCommitSha };
  state.origin.workItem = "event-absence";
  state.allowedPaths = ["events/absence.md"];
  state.findings = [{ path: "events/absence.md", line: 2,
    message: "The trusting relationship is premature.",
    requiredCorrection: "Remove the transition or deliver a believable source first.",
    affectedPaths: ["events/absence.md", "events/witness.md"] }];
  mkdirSync(join(root, ".git/event-items"));
  const receiptPath = join(root, ".git/event-items/absence.json");
  const receipt = { commitSha: sourceCommitSha, consequenceProof: proof,
    assignment: { sourcePaths: ["milestones/absence.md"] } };
  writeFileSync(receiptPath, JSON.stringify(receipt));
  const job = { worktreeRoot: root, storyRelativePath: "story",
    stateDir: join(root, ".git") } as JobStartResult;
  const feedback = await prepareRejectedRepairFeedback(job, state);
  assert.equal(feedback.originalConsequenceProof?.sourceDigest, proof.sourceDigest);
  assert.equal(feedback.originalConsequenceProof?.events.length, 2);
  assert.deepEqual(feedback.context.map(record => [record.path, record.writable]), [
    ["events/absence.md", true], ["events/witness.md", false], ["milestones/absence.md", false],
  ]);
  assert.equal(feedback.offendingSources[0]!.text,
    "Ada trusts the witness before speaking with them.");
  assert.deepEqual(feedback.allowedPaths, ["events/absence.md"]);
  // Uncommitted receipt changes cannot manufacture another semantic conclusion.
  receipt.consequenceProof.events[0]!.observation = "Forged correction";
  writeFileSync(receiptPath, JSON.stringify(receipt));
  const forged = await prepareRejectedRepairFeedback(job, state);
  assert.equal(forged.originalConsequenceProof, undefined);
  assert.deepEqual(forged.allowedPaths, ["events/absence.md"]);
  assert.ok(!forged.context.some(item => item.path === "events/witness.md" && item.writable));
});

test("repair context refuses inbox paths, symlink blobs, missing sources and oversized packets", async t => {
  const root = mkdtempSync(join(tmpdir(), "nt-repair-context-boundary-"));
  t.after(() => removeTestTree(root));
  mkdirSync(join(root, "story/characters"), { recursive: true });
  writeFileSync(join(root, "story/characters/nia.md"), "Nia waits.\n");
  symlinkSync("nia.md", join(root, "story/characters/link.md"));
  writeFileSync(join(root, "story/characters/large.md"), "x".repeat(128 * 1024 + 1));
  git(root, "init", "-q"); git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.test");
  git(root, "add", "."); git(root, "commit", "-qm", "Pinned boundary cases");
  const state = rejected();
  state.sourceCommitSha = git(root, "rev-parse", "HEAD");
  state.origin.workItem = "focus:character.nia";
  const job = { worktreeRoot: root, storyRelativePath: "story" } as JobStartResult;
  for (const path of [".story-inbox/ideas/secret.md", "characters/../../secret.md",
    "characters/missing.md", "characters/link.md", "characters/large.md"]) {
    state.findings = [{ path, line: 1, message: "Do not read unsafe sources." }];
    await assert.rejects(prepareRejectedRepairFeedback(job, state));
  }
  state.findings = Array.from({ length: 33 }, (_, i) => ({ path: `characters/person-${i}.md`, message: "Too many sources." }));
  await assert.rejects(prepareRejectedRepairFeedback(job, state), /unbounded/);
});

test("repair feedback cannot present protected changed context as a writable target", () => {
  const state = rejected();
  state.allowedPaths = ["events/clue.md", "milestones/clue.md"];
  state.planAmendment = { assignment: { authority: { existingPaths: ["events/clue.md"] } } } as RepairReceipt["planAmendment"];
  assert.deepEqual(repairFeedback(state).allowedPaths, ["events/clue.md"]);
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

test("rejected Foundation review restores its exact Pi writer, not discovery or Chat approval", async t => {
  const root = mkdtempSync(join(tmpdir(), "nt-foundation-repair-origin-"));
  t.after(() => removeTestTree(root));
  const job = { jobId: "repair-foundation", stateDir: root } as JobStartResult;
  const directory = join(root, "foundation-sessions");
  mkdirSync(directory, { recursive: true });
  const id = randomUUID(), file = join(directory, "original.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", id }) + "\n");
  const point = { workItem: "foundation", commitSha: sha,
    assurance: { changedPaths: ["creative-direction/foundation.md"] } } as RecoveryCheckpoint;
  const receipt = { jobId: job.jobId, workerMode: "pi", stage: "committed",
    validation: "passed", target: "creative-direction/foundation.md",
    commitSha: sha, piSessionId: id, piSessionFile: file,
    discoverySessionFile: join(root, "foundation-discovery-sessions", "discovery.jsonl"),
    snapshot: { id: "snapshot", path: "/snapshot" }, provider: "openai", model: "gpt-test" };
  const store = (value: object) => writeFileSync(join(root, "foundation.json"), JSON.stringify(value));
  store(receipt);
  const origin = await readRejectedRepairOrigin(job, point);
  assert.equal(origin.sessionFile, file);
  assert.equal(origin.workItem, "foundation");
  assert.equal(origin.provider, "openai");
  await assert.rejects(readRejectedRepairOrigin(job, { ...point, assurance: {
    changedPaths: ["creative-direction/other.md"] } } as RecoveryCheckpoint), /original committed Pi writer/);
  for (const change of [{ workerMode: "fixture" }, { chatApprovalDigest: "approved" },
    { stage: "writing" }, { commitSha: "b".repeat(40) },
    { piSessionFile: receipt.discoverySessionFile }, { piSessionId: randomUUID() }]) {
    store({ ...receipt, ...change });
    await assert.rejects(readRejectedRepairOrigin(job, point),
      /original committed Pi writer|transcript|header|session/);
  }
  store(receipt);
  writeFileSync(file, "corrupted\n");
  await assert.rejects(readRejectedRepairOrigin(job, point), /JSON|session|header/);
});

test("Foundation can correct only its previously committed Creative Direction, never another protected record", t => {
  const root = mkdtempSync(join(tmpdir(), "nt-foundation-review-scope-"));
  t.after(() => removeTestTree(root));
  const directory = join(root, "story", "creative-direction");
  mkdirSync(directory, { recursive: true });
  const target = join(directory, "foundation.md"), other = join(directory, "other.md");
  writeFileSync(target, "Original Foundation.\n");
  writeFileSync(other, "Other protected decision.\n");
  git(root, "init", "-q");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.test");
  git(root, "add", ".");
  git(root, "commit", "-qm", "Baseline");
  const job = { worktreeRoot: root, storyRelativePath: "story" } as JobStartResult;
  const state = { ...rejected(), allowedPaths: ["creative-direction/foundation.md"],
    origin: { ...rejected().origin, workItem: "foundation" } };
  writeFileSync(target, "Foundation with a newly established causal premise.\n");
  assert.deepEqual(changedRepairPaths(job, state), ["creative-direction/foundation.md"]);
  writeFileSync(other, "Changed protected decision.\n");
  assert.throws(() => changedRepairPaths(job, state), /protected|unrelated|authorize/);
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
