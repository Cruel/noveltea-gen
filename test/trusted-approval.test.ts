import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { startStoryJob } from "../src/job.js";
import { inspectTrustedApproval, requestTrustedApproval } from "../src/trusted-approval.js";
import { removeTestTree } from "./helpers.js";
import { verifyAuthorEvidence } from "../src/author-evidence.js";

const root = mkdtempSync(join(tmpdir(), "nt-trusted-approval-"));
after(() => removeTestTree(root));
const principal = "uid:" + process.getuid!() + ":" + userInfo().username;
function decide(x: {story: string; state: string}, id: string, digest: string, action = "APPROVE") {
  return spawnSync("script", ["-q", "-e", "-c",
    [process.execPath, "--import", "tsx", resolve("src/cli.ts"),
      "job", "approval", "decide", "--story", x.story, "--job", "draft", "--id", id].join(" "),
    "/dev/null"],
  { input: action + " " + digest + "\n", encoding: "utf8",
    env: { ...process.env, NT_STATE_DIR: x.state }, timeout: 30000 });
}
function git(dir: string, ...args: string[]) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}
async function setup(name: string) {
  const repo = join(root, name), story = join(repo, "story"), state = join(root, name + "-state");
  mkdirSync(story, { recursive: true });
  writeFileSync(join(story, "README.md"), "No canonical Story change from approval.\n");
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Author");
  git(repo, "config", "user.email", "author@example.test");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "baseline");
  const base = git(repo, "rev-parse", "HEAD");
  const old = process.env.NT_STATE_DIR;
  process.env.NT_STATE_DIR = state;
  try {
    const job = await startStoryJob({ story, job: "draft" });
    const plan = { version: 1, contract: { scope: { kind: "partial", depth: "architecture",
      targets: ["arc.truth"], branches: [] }, constraints: [],
      envelope: { presentation: "classic", hardLimits: [], preferences: [] } }, items: [] };
    const contract = { ...plan.contract, constraints: ["witness survives"] };
    const digest = createHash("sha256").update(JSON.stringify({ plan, head: base, contract })).digest("hex");
    const architectureFile = join(job.stateDir, "architecture.json");
    writeFileSync(architectureFile, JSON.stringify({
      format: 1, jobId: job.jobId, threadId: job.threadId, baseSha: job.baseSha,
      expectedHead: base, phase: "ready", plan,
      proposal: { digest, baselineHead: base, version: 2, contract },
    }));
    return { repo, story, state, job, digest, architectureFile, base };
  } finally {
    if (old === undefined) delete process.env.NT_STATE_DIR; else process.env.NT_STATE_DIR = old;
  }
}

test("trusted CLI approval is bound, checkpointed, durable and idempotent across graph restarts", async () => {
  const x = await setup("restart");
  const request = { id: "approval-one", kind: "plan" as const };
  const first = await requestTrustedApproval(x.job, request);
  assert.equal(first.phase, "awaiting-controller");
  assert.equal(first.proposalSha256, x.digest);
  assert.equal(first.jobId, x.job.jobId);
  assert.equal(first.threadId, x.job.threadId);
  assert.equal(first.baseSha, x.base);
  assert.equal(first.verifiedHead, x.base);
  assert.equal((await requestTrustedApproval(x.job, request)).nonce, first.nonce);
  const applied = decide(x, first.id, x.digest);
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  const decided = await inspectTrustedApproval(x.job, first.id);
  assert.equal(decided.phase, "recorded");
  if (decided.phase !== "recorded") throw new Error("not recorded");
  assert.equal(decided.source, "trusted-cli");
  assert.equal(decided.principal, principal);
  assert.equal(decided.nonce, first.nonce);
  // A controller decision, not a committed key or a caller's payload, is authority.
  const evidence = verifyAuthorEvidence(x.job, { receiptId: decided.id, nonce: decided.nonce });
  assert.equal(evidence.payload.kind, "plan");
  assert.equal(evidence.payload.proposalSha256, x.digest);
  assert.throws(() => verifyAuthorEvidence(x.job, { receiptId: decided.id, nonce: "00000000-0000-0000-0000-000000000000" }), /nonce|receipt/i);
  const replay = decide(x, first.id, x.digest, "REJECT");
  assert.equal(replay.status, 0, replay.stdout + replay.stderr);
  assert.deepEqual(await inspectTrustedApproval(x.job, first.id), decided);
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), x.base);
  assert.equal(git(x.job.worktreeRoot, "status", "--porcelain"), "");
});

test("proposal, baseline and nonce changes reject stale or replayed decisions", async () => {
  const x = await setup("stale");
  const first = await requestTrustedApproval(x.job, { id: "approval-stale", kind: "plan" });
  const plan = JSON.parse(readFileSync(x.architectureFile, "utf8"));
  const nextContract = { ...plan.proposal.contract, constraints: ["new bounded scope"] };
  const nextDigest = createHash("sha256").update(JSON.stringify({
    plan: plan.plan, head: x.base, contract: nextContract,
  })).digest("hex");
  writeFileSync(x.architectureFile, JSON.stringify({
    ...plan, proposal: { ...plan.proposal, contract: nextContract, digest: nextDigest },
  }));
  const stale = decide(x, first.id, x.digest);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stdout + stale.stderr, /stale|proposal/i);
  await assert.rejects(
    requestTrustedApproval(x.job, { id: first.id, kind: "plan" }),
    /already binds/i,
  );
  const different = await requestTrustedApproval(x.job, { id: "approval-new", kind: "plan" });
  assert.equal(different.proposalSha256, nextDigest);
  writeFileSync(x.architectureFile, JSON.stringify({ ...plan,
    proposal: { ...plan.proposal, baselineHead: "c".repeat(40) } }));
  const wrongHead = decide(x, different.id, different.proposalSha256);
  assert.notEqual(wrongHead.status, 0);
  assert.match(wrongHead.stdout + wrongHead.stderr, /current verified|stale/i);
  await assert.rejects(requestTrustedApproval(x.job, { id: "invalid-proof", kind: "plan", changeId: "a".repeat(64) }), /without a change/);
});

test("protected-decision receipts bind exact change without mutating the revision proposal", async () => {
  const x = await setup("protected");
  const workItemId = "change-witness", changeId = "c".repeat(64), proposalSha256 = "d".repeat(64);
  mkdirSync(join(x.job.stateDir, "revisions"), { recursive: true });
  writeFileSync(join(x.job.stateDir, "revisions", workItemId + ".json"), JSON.stringify({
    version: 1, jobId: x.job.jobId, baseSha: x.base, workItemId, verifiedHead: x.base,
    status: "proposed", proposalSha256, changes: [{ id: changeId, decision: "creative-direction.foundation#witness" }], approvals: [],
  }));
  await assert.rejects(requestTrustedApproval(x.job,
    { id: "wrong-change", kind: "decision", workItemId, changeId: "e".repeat(64) }), /does not match/i);
  const staged = await requestTrustedApproval(x.job,
    { id: "correct-change", kind: "decision", workItemId, changeId });
  const terminal = decide(x, staged.id, proposalSha256, "REJECT");
  assert.equal(terminal.status, 0, terminal.stdout + terminal.stderr);
  const recorded = await inspectTrustedApproval(x.job, staged.id);
  assert.equal(recorded.phase, "recorded");
  assert.equal(recorded.proposalSha256, proposalSha256);
  assert.equal(recorded.changeId, changeId);
  // Recording consent does not mutate or automatically publish the revision proposal.
  const legacy = JSON.parse(readFileSync(join(x.job.stateDir, "revisions", workItemId + ".json"), "utf8"));
  assert.deepEqual(legacy.approvals, []);
});

test("unattended CLI cannot act as trusted approving principal", async () => {
  const x = await setup("unattended");
  const staged = await requestTrustedApproval(x.job, { id: "approval-no-tty", kind: "plan" });
  const result = spawnSync(process.execPath,
    ["--import", "tsx", resolve("src/cli.ts"), "job", "approval", "decide",
      "--story", x.story, "--job", "draft", "--id", staged.id],
    { encoding: "utf8", env: { ...process.env, NT_STATE_DIR: x.state }, timeout: 30000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /interactive authenticated local terminal/);
  assert.equal((await inspectTrustedApproval(x.job, staged.id)).phase, "awaiting-controller");
});

test("retired signature-only CLI flag is rejected instead of silently granting approval", async () => {
  const x = await setup("legacy-flag");
  const before = await requestTrustedApproval(x.job, { id: "approval-legacy", kind: "plan" });
  const attempt = spawnSync(process.execPath,
    ["--import", "tsx", resolve("src/cli.ts"), "job", "architecture", "approve",
      "--story", x.story, "--job", "draft", "--proposal", x.digest,
      "--signed-evidence", join(x.repo, "fake-signature.json")],
    { encoding: "utf8", env: { ...process.env, NT_STATE_DIR: x.state }, timeout: 30000 });
  assert.notEqual(attempt.status, 0);
  assert.match(attempt.stderr, /--signed-evidence|Unknown|Invalid|option/i);
  assert.equal((await inspectTrustedApproval(x.job, before.id)).phase, "awaiting-controller");
});
