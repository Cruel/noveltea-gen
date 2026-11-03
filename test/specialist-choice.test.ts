import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startStoryJob } from "../src/job.js";
import { parseSpecialistChoice, extractSpecialistChoice, recordSpecialistChoice, inspectSpecialistChoice,
  activeSpecialistChoice, answerSpecialistChoice, verifySpecialistChoice,
  claimSpecialistChoice, completeSpecialistChoice } from "../src/specialist-choice.js";
import { removeTestTree } from "./helpers.js";

const candidate = {
  question: "Should Nia's investigation expose a systemic archival error or a deliberate personal deception?",
  recommendedId: "systemic",
  recommendationReason: "The existing archive mystery is grounded in record-keeping errors and protects Nia's agency.",
  options: [
    { id: "systemic", title: "Systemic catalog error", approach: "Keep the archive error accidental.",
      benefits: "Supports both search routes with distinct clues.", tradeoffs: "Less interpersonal conflict." },
    { id: "personal", title: "Personal deception", approach: "Introduce a human culprit.",
      benefits: "Creates a personal confrontation.", tradeoffs: "May distract from the missing map mystery." },
  ],
};
function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
test("choice parser enforces 2–4 complete options and exactly one recommended ID", () => {
  assert.deepEqual(parseSpecialistChoice(candidate), candidate);
  assert.deepEqual(extractSpecialistChoice('A pause is needed.\n\u0060\u0060\u0060json\n' +
    JSON.stringify({ authorDecisionRequest: candidate, modifiedRecords: [] }, null, 2) +
    '\n\u0060\u0060\u0060')?.authorDecisionRequest, candidate);
  assert.equal(extractSpecialistChoice('No pending creative decision.'), null);
  assert.throws(() => extractSpecialistChoice('Malformed {"authorDecisionRequest":not-json}'), /valid JSON/);
  assert.equal(parseSpecialistChoice({ ...candidate, options: [...candidate.options, {
    id: "third", title: "A third option", approach: "Different approach", benefits: "Distinct benefit",
    tradeoffs: "Distinct risk",
  }] }).options.length, 3);
  assert.throws(() => parseSpecialistChoice({ ...candidate, options: [candidate.options[0]] }), /2–4/);
  assert.throws(() => parseSpecialistChoice({ ...candidate, options: [candidate.options[0], ...candidate.options,
    candidate.options[1], candidate.options[0]] }), /2–4/);
  assert.throws(() => parseSpecialistChoice({ ...candidate, recommendedId: "invented" }), /Recommended/);
  assert.throws(() => parseSpecialistChoice({ ...candidate, options: [candidate.options[0], candidate.options[0]] }), /unique/);
  assert.throws(() => parseSpecialistChoice({ ...candidate, options: [
    candidate.options[0], { ...candidate.options[1], tradeoffs: "" },
  ] }), /trade-offs/);
});
test("author answer survives restart; only the original session, HEAD and draft bytes can resume", {
  timeout: 35_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "nt-specialist-choice-"));
  const old = { state: process.env.NT_STATE_DIR, cache: process.env.NT_GIT_CACHE_DIR };
  process.env.NT_STATE_DIR = join(root, "state");
  process.env.NT_GIT_CACHE_DIR = join(root, "cache");
  try {
    const story = join(root, "repo", "story");
    mkdirSync(join(story, "creative-direction"), { recursive: true });
    writeFileSync(join(story, "creative-direction", "foundation.md"), "# protected baseline\n");
    git(join(root, "repo"), "init", "-q");
    git(join(root, "repo"), "config", "user.name", "Test");
    git(join(root, "repo"), "config", "user.email", "test@example.invalid");
    git(join(root, "repo"), "add", ".");
    git(join(root, "repo"), "commit", "-qm", "Baseline");
    const job = await startStoryJob({ story, job: randomUUID() });
    const dir = join(job.stateDir, "character-world-sessions", "character");
    mkdirSync(dir, { recursive: true });
    const sessionId = randomUUID(), sessionFile = join(dir, "test.jsonl");
    writeFileSync(sessionFile, [
      JSON.stringify({ type: "session", id: sessionId, cwd: job.worktreeStoryRoot }),
      JSON.stringify({ type: "message", message: { role: "user", content: "Choose a path." } }),
      JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "stop",
        content: [{ type: "text", text: JSON.stringify({ authorDecisionRequest: candidate,
          modifiedRecords: [] }) }] } }),
    ].join("\n") + "\n");
    const dirtyFile = join(job.worktreeStoryRoot, "characters", "nia.md");
    mkdirSync(join(job.worktreeStoryRoot, "characters"));
    writeFileSync(dirtyFile, "---\nid: character.nia\n---\nA draft awaiting direction.");
    const receipt = await recordSpecialistChoice(job, "character-foundations", candidate,
      sessionId, sessionFile);
    writeFileSync(join(job.stateDir, "character-world.json"), JSON.stringify({
      jobId: job.jobId, threadId: job.threadId,
      units: [{ id: "world-foundations", phase: "committed" },
        { id: "character-foundations", phase: "awaiting-author", authorChoiceId: receipt.id }],
    }));
    assert.equal((await activeSpecialistChoice(job))?.id, receipt.id);
    assert.equal((await verifySpecialistChoice(job, receipt.id, "awaiting-author")).phase, "awaiting-author");
    await assert.rejects(() => answerSpecialistChoice(job, receipt.id, "f".repeat(64),
      { kind: "option", optionId: "systemic", note: "" }, "user:owner"), /stale/);
    await assert.rejects(() => answerSpecialistChoice(job, receipt.id, receipt.proposalSha256,
      { kind: "option", optionId: "unknown", note: "" }, "user:owner"), /Invalid/);
    await assert.rejects(() => answerSpecialistChoice(job, receipt.id, receipt.proposalSha256,
      { kind: "custom", text: " ", note: "" }, "user:owner"), /Invalid/);
    await assert.rejects(() => answerSpecialistChoice(job, receipt.id, receipt.proposalSha256,
      { kind: "option", optionId: "systemic", note: "" }, "model:agent"), /identity/);
    // A different revision/draft or modified transcript cannot reuse consent.
    writeFileSync(dirtyFile, "A different draft");
    await assert.rejects(() => answerSpecialistChoice(job, receipt.id, receipt.proposalSha256,
      { kind: "option", optionId: "systemic", note: "" }, "user:owner"), /changed/);
    writeFileSync(dirtyFile, "---\nid: character.nia\n---\nA draft awaiting direction.");
    const actual = await answerSpecialistChoice(job, receipt.id, receipt.proposalSha256,
      { kind: "custom", text: "Keep the mystery about record-keeping, but add a personal consequence.", note: "" }, "user:owner");
    assert.equal(actual.phase, "answered");
    assert.equal(actual.answer?.kind, "custom");
    assert.equal((await inspectSpecialistChoice(job, receipt.id)).answer?.principal, "user:owner");
    await assert.rejects(() => answerSpecialistChoice(job, receipt.id, receipt.proposalSha256,
      { kind: "option", optionId: "personal", note: "" }, "user:owner"), /required author boundary/);
    const claimed = await claimSpecialistChoice(job, receipt.id);
    assert.equal(claimed.sessionId, sessionId);
    assert.equal((await inspectSpecialistChoice(job, receipt.id)).phase, "resuming");
    await assert.rejects(() => claimSpecialistChoice(job, receipt.id), /required author boundary/);
    await completeSpecialistChoice(job, receipt.id);
    assert.equal((await inspectSpecialistChoice(job, receipt.id)).phase, "consumed");
    assert.equal(existsSync(dirtyFile), true, "Author decision never resets an uncommitted Story draft");
  } finally {
    if (old.state === undefined) delete process.env.NT_STATE_DIR;
    else process.env.NT_STATE_DIR = old.state;
    if (old.cache === undefined) delete process.env.NT_GIT_CACHE_DIR;
    else process.env.NT_GIT_CACHE_DIR = old.cache;
    removeTestTree(root);
  }
});
