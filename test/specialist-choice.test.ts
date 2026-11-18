import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startStoryJob } from "../src/job.js";
import { parseSpecialistChoice, extractSpecialistChoice, recordSpecialistChoice, inspectSpecialistChoice,
  activeSpecialistChoice, answerSpecialistChoice, verifySpecialistChoice,
  claimSpecialistChoice, completeSpecialistChoice, authorChoiceDirection } from "../src/specialist-choice.js";
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
test("specialist parser bounds options while accepting concise unendorsed alternatives", () => {
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
  assert.throws(() => parseSpecialistChoice({ ...candidate, options: [candidate.options[0]] }), /2–8/);
  assert.equal(parseSpecialistChoice({ question: candidate.question,
    options: candidate.options.map(o => ({ id: o.id, title: o.title })) }).recommendedId, undefined);
  assert.throws(() => parseSpecialistChoice({ ...candidate, options: [candidate.options[0], ...candidate.options,
    candidate.options[1], candidate.options[0]] }), /unique/);
  assert.throws(() => parseSpecialistChoice({ ...candidate, recommendedId: "invented" }), /Recommended/);
  assert.throws(() => parseSpecialistChoice({ ...candidate, options: [candidate.options[0], candidate.options[0]] }), /unique/);
  assert.throws(() => parseSpecialistChoice({ ...candidate, options: [
    candidate.options[0], { ...candidate.options[1], tradeoffs: "" },
  ] }), /bounded optional detail/);
});


test("shared Author Choices accept text, binary/Other and meaningful multi-alternatives without forced recommendations", () => {
  const plain = parseSpecialistChoice({ kind: "free-text",
    question: "What should Nia say when she learns the truth?" });
  assert.equal(plain.kind, "free-text");
  assert.equal(plain.options, undefined);
  const binary = parseSpecialistChoice({ kind: "yes-no",
    question: "Should Nia disclose the evidence to the player?",
    recommendedId: "no", recommendationReason: "The current event withholds the witness identity." });
  assert.equal(binary.kind, "yes-no");
  assert.equal(binary.recommendedId, "no");
  assert.equal(parseSpecialistChoice({ kind: "alternatives", ...candidate,
    context: [{ path: "characters/nia.md", line: 4, description: "Her established motive" }] }).context?.length, 1);
  assert.throws(() => parseSpecialistChoice({ kind: "free-text", ...candidate }), /free-text/);
  assert.throws(() => parseSpecialistChoice({ kind: "yes-no", question: "Can Nia reveal the ledger?",
    recommendedId: "maybe" }), /Yes\/No/);
  assert.throws(() => parseSpecialistChoice({ kind: "alternatives", ...candidate,
    context: [{ path: "../private.json", line: 1, description: "Unsafe context" }] }), /canonical/);
  assert.throws(() => parseSpecialistChoice({ kind: "alternatives", ...candidate,
    options: [candidate.options[0], candidate.options[0]] }), /unique/);
});

test("focused conversation choice binds one original session and rejects agent-requested delegation", async () => {
  const root = mkdtempSync(join(tmpdir(), "nt-focused-choice-"));
  const old = { state: process.env.NT_STATE_DIR, cache: process.env.NT_GIT_CACHE_DIR };
  process.env.NT_STATE_DIR = join(root, "state");
  process.env.NT_GIT_CACHE_DIR = join(root, "cache");
  try {
    const repo = join(root, "repo"), story = join(repo, "story");
    mkdirSync(join(story, "creative-direction"), { recursive: true });
    writeFileSync(join(story, "creative-direction", "foundation.md"), "# Existing foundation\n");
    git(repo, "init", "-q");
    git(repo, "config", "user.name", "Test");
    git(repo, "config", "user.email", "test@example.invalid");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "Source");
    const job = await startStoryJob({ story, job: randomUUID() });
    const target = "authored-content.dialogue";
    const workItem = "focus-" + createHash("sha256").update(target).digest("hex").slice(0, 24);
    const sessionDir = join(job.stateDir, "focused-sessions", target);
    mkdirSync(sessionDir, { recursive: true });
    const sessionId = randomUUID(), sessionFile = join(sessionDir, "original.jsonl");
    writeFileSync(sessionFile, JSON.stringify({ type: "session", id: sessionId,
      cwd: job.worktreeStoryRoot }) + "\n");
    const itemDir = join(job.stateDir, "focused-items");
    mkdirSync(itemDir, { recursive: true });
    const stateFile = join(itemDir, target + ".json");
    const originalState = { jobId: job.jobId, workItemId: "focus:" + target,
      target, choiceWorkItem: workItem, phase: "writing", piSessionFile: sessionFile, piSessionId: sessionId };
    writeFileSync(stateFile, JSON.stringify(originalState));
    const question = parseSpecialistChoice({ ...candidate, allowStudioDecision: true });
    await assert.rejects(recordSpecialistChoice(job, "focus-" + "f".repeat(24), question,
      sessionId, sessionFile), /matching assigned/);
    const receipt = await recordSpecialistChoice(job, workItem, question, sessionId, sessionFile);
    assert.equal(receipt.delegationAllowed, undefined,
      'An untrusted delegation request cannot override a mandatory focused author boundary');
    writeFileSync(stateFile, JSON.stringify({ ...originalState, phase: "awaiting-author",
      authorChoiceId: receipt.id }));
    assert.equal((await activeSpecialistChoice(job))?.id, receipt.id);
    await assert.rejects(answerSpecialistChoice(job, receipt.id, receipt.proposalSha256,
      { kind: "delegate", note: "" }, "user:owner"), /Invalid/);
    await assert.rejects(answerSpecialistChoice(job, receipt.id, "f".repeat(64),
      { kind: "option", optionId: "systemic", note: "" }, "user:owner"), /stale/);
    const reply = await answerSpecialistChoice(job, receipt.id, receipt.proposalSha256,
      { kind: "custom", text: "Use the systemic clues. Delegate the dialogue phrasing and pacing.",
        note: "Preserve the protected foundation." }, "user:owner");
    assert.equal(reply.phase, "answered");
    assert.equal(reply.answer?.kind, "custom");
    assert.equal((await activeSpecialistChoice(job))?.id, reply.id);
    assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "",
      "Answering a question must never write Story files or grant scope");
    const resumed = await claimSpecialistChoice(job, receipt.id);
    assert.equal(resumed.sessionFile, sessionFile);
    assert.equal(authorChoiceDirection(resumed.question, resumed.answer!),
      "Use the systemic clues. Delegate the dialogue phrasing and pacing.\n" +
      "Additional guidance: Preserve the protected foundation.");
    await assert.rejects(claimSpecialistChoice(job, receipt.id), /required author boundary/);
    await completeSpecialistChoice(job, receipt.id);
    assert.equal((await inspectSpecialistChoice(job, receipt.id)).phase, "consumed");
    writeFileSync(stateFile, JSON.stringify({ ...originalState, phase: "committed" }));
    assert.equal(await activeSpecialistChoice(job), null);
  } finally {
    if (old.state === undefined) delete process.env.NT_STATE_DIR;
    else process.env.NT_STATE_DIR = old.state;
    if (old.cache === undefined) delete process.env.NT_GIT_CACHE_DIR;
    else process.env.NT_GIT_CACHE_DIR = old.cache;
    removeTestTree(root);
  }
});

test("a valid large Unicode question plus answer survives receipt reading and resumption", async () => {
  const root = mkdtempSync(join(tmpdir(), "nt-large-specialist-choice-"));
  const old = { state: process.env.NT_STATE_DIR, cache: process.env.NT_GIT_CACHE_DIR };
  process.env.NT_STATE_DIR = join(root, "state");
  process.env.NT_GIT_CACHE_DIR = join(root, "cache");
  try {
    const repo = join(root, "repo"), story = join(repo, "story");
    mkdirSync(join(story, "creative-direction"), { recursive: true });
    writeFileSync(join(story, "creative-direction", "foundation.md"), "# Existing canon\n");
    git(repo, "init", "-q");
    git(repo, "config", "user.name", "Test");
    git(repo, "config", "user.email", "test@example.invalid");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "Source");
    const job = await startStoryJob({ story, job: randomUUID() });
    const dir = join(job.stateDir, "character-world-sessions", "character");
    mkdirSync(dir, { recursive: true });
    const sessionId = randomUUID(), sessionFile = join(dir, "original.jsonl");
    writeFileSync(sessionFile, JSON.stringify({ type: "session", id: sessionId,
      cwd: job.worktreeStoryRoot }) + "\n");
    const question = {
      question: "Which evidence should this character uncover in the next investigation?",
      options: ["a", "b", "c", "d"].map((id, index) => ({
        id, title: "Lead " + index,
        description: "界".repeat(650), benefits: "界".repeat(650),
        tradeoffs: "界".repeat(650), approach: "界".repeat(650),
      })),
    };
    const receipt = await recordSpecialistChoice(job, "character-foundations",
      question, sessionId, sessionFile);
    const pending = await inspectSpecialistChoice(job, receipt.id);
    assert.equal(pending.phase, "awaiting-author");
    const text = "界".repeat(4000);
    const answered = await answerSpecialistChoice(job, receipt.id, receipt.proposalSha256,
      { kind: "custom", text, note: "Preserve the exact original Story canon." }, "user:owner");
    assert.equal(answered.answer?.kind, "custom");
    assert.ok(Buffer.byteLength(JSON.stringify(answered, null, 2), "utf8") > 24_000,
      "the prior 24 KB reader would reject this valid combined receipt");
    assert.equal((await inspectSpecialistChoice(job, receipt.id)).answer?.kind, "custom");
    assert.equal((await verifySpecialistChoice(job, receipt.id, "answered")).answer?.kind, "custom");
    assert.equal((await claimSpecialistChoice(job, receipt.id)).answer?.kind, "custom");
    await completeSpecialistChoice(job, receipt.id);
    assert.equal((await inspectSpecialistChoice(job, receipt.id)).phase, "consumed");
  } finally {
    if (old.state === undefined) delete process.env.NT_STATE_DIR;
    else process.env.NT_STATE_DIR = old.state;
    if (old.cache === undefined) delete process.env.NT_GIT_CACHE_DIR;
    else process.env.NT_GIT_CACHE_DIR = old.cache;
    removeTestTree(root);
  }
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
    const savedChoiceFile = join(job.stateDir, "specialist-choices", receipt.id + ".json");
    const originalBytes = readFileSync(savedChoiceFile, "utf8");
    const altered = JSON.parse(originalBytes);
    altered.question.options[0].id = "substituted-option";
    writeFileSync(savedChoiceFile, JSON.stringify(altered));
    await assert.rejects(() => inspectSpecialistChoice(job, receipt.id),
      /inconsistent or modified|Recommended solution/, "changed option identities cannot inherit an old response");
    writeFileSync(savedChoiceFile, originalBytes);
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

    // A different Event-design specialist uses the same controller and typed
    // answer path, not a Character-specific RPC or permission shortcut.
    writeFileSync(join(job.stateDir, "character-world.json"), JSON.stringify({
      jobId: job.jobId, threadId: job.threadId,
      units: [{ id: "world-foundations", phase: "committed" },
        { id: "character-foundations", phase: "committed" }],
    }));
    const eventDir = join(job.stateDir, "event-sessions", "event-disclosure");
    mkdirSync(eventDir, { recursive: true });
    const eventSession = randomUUID(), eventFile = join(eventDir, "event.jsonl");
    writeFileSync(eventFile, JSON.stringify({ type: "session", id: eventSession,
      cwd: job.worktreeStoryRoot }) + "\n");
    const binary = parseSpecialistChoice({ kind: "yes-no",
      question: "Should Nia reveal the archive record before confronting the witness?" });
    const event = await recordSpecialistChoice(job, "event-disclosure", binary, eventSession, eventFile);
    const eventItems = join(job.stateDir, "event-items");
    mkdirSync(eventItems);
    writeFileSync(join(eventItems, "disclosure.json"), JSON.stringify({
      jobId: job.jobId, workItemId: "event-disclosure",
      phase: "awaiting-author", authorChoiceId: event.id,
    }));
    assert.equal((await activeSpecialistChoice(job))?.workItem, "event-disclosure");
    await assert.rejects(() => answerSpecialistChoice(job, event.id, event.proposalSha256,
      { kind: "option", optionId: "maybe", note: "" }, "user:owner"), /Invalid/);
    const eventAnswer = await answerSpecialistChoice(job, event.id, event.proposalSha256,
      { kind: "option", optionId: "no", note: "Reveal after the player's choice." }, "user:owner");
    assert.equal(eventAnswer.answer?.kind, "option");
    assert.equal((await verifySpecialistChoice(job, event.id, "answered")).phase, "answered");
    await claimSpecialistChoice(job, event.id);
    await assert.rejects(() => claimSpecialistChoice(job, event.id), /required author boundary/);
    await completeSpecialistChoice(job, event.id);

    // An ordinary Event can request delegation, but only the controller's
    // permitted work-item policy creates signed delegation authority.
    const requested = parseSpecialistChoice({ kind: "yes-no",
      question: "Should the witness conceal the chronology until the final reveal?",
      allowStudioDecision: true });
    const delegated = await recordSpecialistChoice(job, "event-disclosure",
      requested, eventSession, eventFile);
    assert.equal(delegated.delegationAllowed, true);
    writeFileSync(join(eventItems, "disclosure.json"), JSON.stringify({
      jobId: job.jobId, workItemId: "event-disclosure",
      phase: "awaiting-author", authorChoiceId: delegated.id,
    }));
    const delegateFile = join(job.stateDir, "specialist-choices", delegated.id + ".json");
    const originalDelegate = readFileSync(delegateFile, "utf8");
    writeFileSync(delegateFile, JSON.stringify({
      ...JSON.parse(originalDelegate), delegationAllowed: false,
    }));
    await assert.rejects(() => inspectSpecialistChoice(job, delegated.id), /inconsistent|modified/);
    writeFileSync(delegateFile, originalDelegate);
    const resolved = await answerSpecialistChoice(job, delegated.id, delegated.proposalSha256,
      { kind: "delegate", note: " Keep the trusted chronology. " }, "user:owner");
    assert.equal(resolved.answer?.kind, "delegate");
    assert.equal(resolved.answer?.principal, "user:owner");
    assert.match(authorChoiceDirection(resolved.question, resolved.answer!, true),
      /original assignment and existing canon/);
    assert.equal(git(job.worktreeRoot, "status", "--porcelain").includes("creative-direction"), false);
    await assert.rejects(() => answerSpecialistChoice(job, delegated.id,
      delegated.proposalSha256, { kind: "option", optionId: "yes", note: "" }, "user:owner"),
      /required author boundary/);
    await claimSpecialistChoice(job, delegated.id);
    await completeSpecialistChoice(job, delegated.id);

    // Multiple answers may combine distinct option IDs and the author's exact
    // additional text without turning it into a delegation or changing canon.
    const multiQuestion = parseSpecialistChoice({ kind: "multiple-choice",
      question: "Which two investigative threads should the next Event preserve?",
      options: [{ id: "history", title: "History" }, { id: "witness", title: "Witness" }],
      allowStudioDecision: true });
    const multi = await recordSpecialistChoice(job, "event-disclosure",
      multiQuestion, eventSession, eventFile);
    writeFileSync(join(eventItems, "disclosure.json"), JSON.stringify({
      jobId: job.jobId, workItemId: "event-disclosure",
      phase: "awaiting-author", authorChoiceId: multi.id,
    }));
    await assert.rejects(() => answerSpecialistChoice(job, multi.id,
      multi.proposalSha256, { kind: "multiple", optionIds: ["history", "history"],
        note: "" }, "user:owner"), /Invalid/);
    const combined = await answerSpecialistChoice(job, multi.id, multi.proposalSha256,
      { kind: "multiple", optionIds: ["witness", "history"],
        text: "  Keep the mayor's confession private.  ", note: " Two separate clues. " }, "user:owner");
    assert.deepEqual(combined.answer?.kind === "multiple" && combined.answer.optionIds,
      ["witness", "history"]);
    assert.match(authorChoiceDirection(combined.question, combined.answer!, true),
      /"custom":"  Keep the mayor's confession private.  "/);
    assert.equal((await inspectSpecialistChoice(job, multi.id)).answer?.principal, "user:owner");
    await claimSpecialistChoice(job, multi.id);
    await completeSpecialistChoice(job, multi.id);

    // Plain-text questions also use the same bounded authenticated receipt.
    writeFileSync(join(eventItems, "disclosure.json"), JSON.stringify({
      jobId: job.jobId, workItemId: "event-disclosure", phase: "committed",
    }));
    const worldDir = join(job.stateDir, "character-world-sessions", "world");
    mkdirSync(worldDir, { recursive: true });
    const worldSession = randomUUID(), worldFile = join(worldDir, "world.jsonl");
    writeFileSync(worldFile, JSON.stringify({ type: "session", id: worldSession,
      cwd: job.worktreeStoryRoot }) + "\n");
    const textQuestion = parseSpecialistChoice({ kind: "free-text",
      question: "What should the archive's forgotten name mean to the player?" });
    const world = await recordSpecialistChoice(job, "world-foundations",
      textQuestion, worldSession, worldFile);
    writeFileSync(join(job.stateDir, "character-world.json"), JSON.stringify({
      jobId: job.jobId, threadId: job.threadId,
      units: [{ id: "world-foundations", phase: "awaiting-author", authorChoiceId: world.id },
        { id: "character-foundations", phase: "pending" }],
    }));
    assert.equal((await activeSpecialistChoice(job))?.id, world.id);
    await assert.rejects(() => answerSpecialistChoice(job, world.id, world.proposalSha256,
      { kind: "option", optionId: "yes", note: "" }, "user:owner"), /Invalid/);
    const worldAnswer = await answerSpecialistChoice(job, world.id, world.proposalSha256,
      { kind: "custom", text: "It represents a debt that the archivists refuse to name.",
        note: "Keep the meaning ambiguous until the final route." }, "user:owner");
    assert.equal(worldAnswer.answer?.note, "Keep the meaning ambiguous until the final route.");
    assert.equal((await activeSpecialistChoice({ ...job }))?.phase, "answered");
    git(job.worktreeRoot, "add", ".");
    git(job.worktreeRoot, "commit", "-qm", "Unauthorized revision after author answer");
    await assert.rejects(() => verifySpecialistChoice(job, world.id, "answered"),
      /changed/, "new HEAD cannot inherit an answer to the prior Story revision");
  } finally {
    if (old.state === undefined) delete process.env.NT_STATE_DIR;
    else process.env.NT_STATE_DIR = old.state;
    if (old.cache === undefined) delete process.env.NT_GIT_CACHE_DIR;
    else process.env.NT_GIT_CACHE_DIR = old.cache;
    removeTestTree(root);
  }
});
