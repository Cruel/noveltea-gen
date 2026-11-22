/** #228: deterministic write-ahead adaptive operation boundaries and original
 * completed-session reconciliation; no network or Pi model invocation. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { JobStartResult } from "../src/job.js";
import type { StoryOrchestratorSelection } from "../src/orchestrator-selection.js";
import { createSkillSnapshot } from "../src/snapshot.js";
import { pendingDigest } from "../src/pending-work-amendments.js";
import { beginAdaptiveAttempt, beginAdaptiveInvocation, bindAdaptiveContext,
  completeAdaptiveInvocation, emptyAdaptiveState, readAdaptiveState,
  assertAdaptiveSettled, isProvablyUninvokedAdaptiveAttempt, settleAdaptiveAttempt } from "../src/adaptive-state.js";
import { recoverCompletedAdaptiveProposal } from "../src/adaptive-planner.js";
import { inspectPiPolicy, guardPiBudget, registerPendingPiSession, recordPiSession } from "../src/job-pi-policy.js";

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const turn = "a".repeat(64);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nt-adaptive-original-"));
  const repo = join(root, "repo"), story = join(repo, "story"), stateDir = join(root, "state");
  mkdirSync(story, { recursive: true }); mkdirSync(stateDir);
  mkdirSync(join(repo, "skills", "nt-catalog"), { recursive: true });
  writeFileSync(join(repo, "skills", "nt-catalog", "SKILL.md"),
    "---\nname: nt-catalog\n---\nOriginal pinned method\n");
  writeFileSync(join(story, "README.txt"), "Original Story context\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("add", "."); git("commit", "-qm", "original source");
  const head = git("rev-parse", "HEAD");
  const job = { stateDir, worktreeRoot: repo, worktreeStoryRoot: story,
    storyRelativePath: "story", baseSha: head, jobId: "job", threadId: "thread",
    branch: git("branch", "--show-current") } as JobStartResult;
  return { root, repo, story, stateDir, job, head, git };
}
async function setup(f: ReturnType<typeof fixture>) {
  const snapshot = (await createSkillSnapshot({ discovery: "explicit-only",
    novelteaSkills: f.repo, skillDirs: [], requiredSkills: [] }))!;
  const signature = sha("one original planning operation");
  const state = emptyAdaptiveState(f.job, turn, 1);
  const profile = { snapshotId: snapshot.id, provider: "openai", model: "test-model" };
  await beginAdaptiveAttempt(f.job, state, f.head, signature, profile);
  const contextDigest = sha("original sources, omissions and inventory");
  const sessionFile = join(f.stateDir, "adaptive-planning-sessions", "original.jsonl");
  const selected = { receipt: { skillSnapshot: snapshot } } as StoryOrchestratorSelection;
  return { state, signature, contextDigest, sessionFile, selected, snapshot };
}

test("#228: pre-call crash is provably uninvoked and stable across repeated reads; legacy is fenced", async () => {
  const f = fixture();
  try {
    const { state, signature, contextDigest, sessionFile } = await setup(f);
    const prepared = (await readAdaptiveState(f.job, turn, 1))!;
    assert.equal(prepared.attempts[0]?.effect?.phase, "prepared");
    assert.equal(prepared.attempts[0]?.effect?.invocation, undefined);
    assert.equal(isProvablyUninvokedAdaptiveAttempt(prepared.attempts[0]), true);
    assert.throws(() => assertAdaptiveSettled(prepared), /Interrupted adaptive/);
    for (let restart = 0; restart < 3; restart++) {
      assert.equal((await readAdaptiveState(f.job, turn, 1))?.attempts[0]?.effect?.phase, "prepared");
      assert.equal(readFileSync(join(f.stateDir, "adaptive-plan.json"), "utf8").includes("invoking"), false);
    }
    await bindAdaptiveContext(f.job, state, signature, contextDigest);
    await bindAdaptiveContext(f.job, state, signature, contextDigest);
    await assert.rejects(bindAdaptiveContext(f.job, state, signature, sha("changed")),
      /context|phase/i);
    assert.equal((await readAdaptiveState(f.job, turn, 1))?.attempts[0]?.effect?.contextDigest,
      contextDigest);
    // Pi has not created its JSONL yet. This is safe only while prepared:
    // after the write-ahead invocation marker, even absence stays fenced.
    await beginAdaptiveInvocation(f.job, state, signature, sessionFile, "none", "Original work");
    assert.equal((await readAdaptiveState(f.job, turn, 1))?.attempts[0]?.effect?.phase, "invoking");
    assert.equal(isProvablyUninvokedAdaptiveAttempt(state.attempts[0]), false,
      "a started original model invocation is not an inspect-only prepared effect");
    assert.equal((await readAdaptiveState(f.job, turn, 1))?.attempts[0]?.effect?.invocation?.prefixBytes, 0);
    const legacy = emptyAdaptiveState(f.job, turn, 1);
    legacy.attempts.push({ signature, sourceSha: f.head, phase: "planning" });
    assert.equal(isProvablyUninvokedAdaptiveAttempt(legacy.attempts[0]), false);
    assert.throws(() => assertAdaptiveSettled(legacy), /Interrupted/);
    // A ledger replay must not turn a legacy no-session receipt into proof.
    await assert.rejects(beginAdaptiveInvocation(f.job, legacy, signature, sessionFile, "none"),
      /prepared/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("#228: an original uncreated Pi transcript reserves usage before the first prompt", async () => {
  const f = fixture();
  try {
    const manager = SessionManager.create(f.story, join(f.stateDir, "adaptive-planning-sessions"));
    const file = manager.getSessionFile()!;
    assert.ok(file);
    await registerPendingPiSession(f.job, file);
    assert.equal((await inspectPiPolicy(f.job)).budget.modelCalls, 0);
    await assert.rejects(guardPiBudget(f.job, "another-model-operation"),
      /Unsettled original Pi invocation usage/i);
    const append = (message: unknown) => manager.appendMessage(
      message as Parameters<SessionManager["appendMessage"]>[0]);
    append({ role: "user", content: [{ type: "text", text: "Original work" }] });
    append({ role: "assistant", stopReason: "stop",
      content: [{ type: "text", text: "Original response" }],
      usage: { input: 12, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 17,
        cost: { total: 0.01 } } });
    assert.equal((await inspectPiPolicy(f.job)).budget.modelCalls, 1,
      "the pending registered transcript contributes actual usage after Pi writes it");
    await recordPiSession(f.job, file);
    await recordPiSession(f.job, file);
    assert.equal((await inspectPiPolicy(f.job)).budget.modelCalls, 1,
      "settlement does not charge a repeated model call");
    await guardPiBudget(f.job, "next-authorized-model-operation");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("#228: started Pi effects are fenced until the original completed transcript proves its terminal response", async () => {
  const f = fixture();
  try {
    const { state, signature, contextDigest, selected, snapshot } = await setup(f);
    await bindAdaptiveContext(f.job, state, signature, contextDigest);
    const manager = SessionManager.create(f.story, join(f.stateDir, "adaptive-planning-sessions"));
    const id = manager.getSessionId();
    const sessionFile = manager.getSessionFile()!;
    assert.ok(sessionFile);
    await beginAdaptiveInvocation(f.job, state, signature, sessionFile, id, "Original work");
    assert.equal((await readAdaptiveState(f.job, turn, 1))?.attempts[0]?.effect?.phase, "invoking");
    await assert.rejects(beginAdaptiveInvocation(f.job, state, signature, sessionFile, id, "Original work"),
      /prepared|phase/);
    const recover = () => recoverCompletedAdaptiveProposal({
      job: f.job, selected, effect: state.attempts[0]!.effect!, signature,
      required: ["nt-catalog/SKILL.md"],
    });
    await assert.rejects(recover(), /ambiguous|interrupted|missing/i,
      "the mere existence of a session file is not proof of invocation or completion");
    // A terminal reply on the same persisted session is enough to reconcile
    // the original response, never enough to authorize new Story writes.
    const proposal = { sourceSha: f.head, turnDigest: turn, beforeVersion: 1,
      reason: "Original causal order is unchanged", actions: [], order: [] };
    const append = (message: unknown) => manager.appendMessage(
      message as Parameters<SessionManager["appendMessage"]>[0]);
    append({ role: "user", content: [{ type: "text", text: "Original work" }] });
    append({ role: "assistant", stopReason: "toolUse",
      content: [{ type: "toolCall", id: "skill-read", name: "read",
        arguments: { path: "skill://nt-catalog/SKILL.md" } }] });
    append({ role: "toolResult", toolCallId: "skill-read", isError: false,
      content: [{ type: "text", text: "Pinned method" }] });
    append({ role: "assistant", stopReason: "stop", provider: "openai", model: "test-model",
      content: [{ type: "text", text: JSON.stringify(proposal) }] });
    writeFileSync(join(f.stateDir, "pi-resolution.json"), JSON.stringify({
      version: 1, requested: { provider: "openai", model: "test-model" },
      selected: { provider: "openai", model: "test-model" }, source: "required",
    }));
    const originalSession = readFileSync(sessionFile, "utf8");
    writeFileSync(sessionFile, originalSession.replace("Original work", "Substituted work"));
    await assert.rejects(recover(), /prompt changed/i,
      "a same-ID but substituted original user prompt cannot authenticate a completed response");
    writeFileSync(sessionFile, originalSession);
    const recovered = await recover();
    assert.deepEqual(recovered.proposal, proposal);
    assert.deepEqual(recovered.skillReads, [join(snapshot.path, "skills", "nt-catalog", "SKILL.md")]);
    assert.equal((await inspectPiPolicy(f.job)).budget.modelCalls, 0,
      "recovery only registers the original transcript, never simulates an extra call");
    assert.equal((await readAdaptiveState(f.job, turn, 1))?.attempts.length, 1);
    await completeAdaptiveInvocation(f.job, state, signature, sessionFile, id);
    assert.deepEqual((await recover()).proposal, proposal, "a repeated resume reads the same sealed response");
    // A modified response, stray follow-up or changed session is not accepted.
    writeFileSync(sessionFile, readFileSync(sessionFile, "utf8") + JSON.stringify({
      type: "message", message: { role: "user", content: [{ type: "text", text: "new request" }] } }) + "\n");
    await assert.rejects(recover(), /changed|truncated/);
    const valid = readFileSync(sessionFile, "utf8").split("\n").slice(0, -2).join("\n") + "\n";
    writeFileSync(sessionFile, valid);
    await settleAdaptiveAttempt(f.job, state, signature, "unchanged");
    assert.equal((await readAdaptiveState(f.job, turn, 1))?.attempts[0]?.phase, "unchanged");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
