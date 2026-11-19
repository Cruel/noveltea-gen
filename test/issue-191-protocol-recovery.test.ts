import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assignmentVerdictResponseContract } from "../src/narrative-review-specialist.js";
import type { SemanticReviewPacket } from "../src/semantic-assignment-review.js";
import {
  recoverResponseContract, recoverWithOneFreshSession, ProtocolExhaustedError,
  beginProtocolInvocation, refuseReplayedProtocolInvocation,
  type ResponseContractSession,
} from "../src/response-contract-recovery.js";

function conversation(id: string, first: string, next: string[]) {
  const messages: Array<{ role: string; stopReason: string; content: Array<{
    type: string; text: string
  }> }> = [{ role: "assistant", stopReason: "stop",
    content: [{ type: "text", text: first }] }];
  let tools = ["read", "write"];
  const prompts: string[] = [];
  const advertised: string[][] = [];
  const session: ResponseContractSession = {
    sessionId: id,
    sessionManager: { getSessionFile: () => "/tmp/protocol-" + id + ".jsonl" },
    messages, getActiveToolNames: () => tools,
    setActiveToolsByName: value => { tools = [...value]; },
  };
  return {
    session, messages, prompts, advertised,
    prompt: async (feedback: string) => {
      prompts.push(feedback);
      advertised.push([...tools]);
      const answer = next.shift();
      if (answer === undefined) throw Error("Unexpected model call");
      messages.push({ role: "assistant", stopReason: "stop",
        content: [{ type: "text", text: answer }] });
    },
  };
}

const valid = '{"status":"valid"}';
const invalid = '{"status":"no"}';
const validate = (text: string) => text === valid ? [] :
  [{ path: "$.status", expected: "exactly valid" }];
const parse = (text: string) => JSON.parse(text) as { status: string };

test("planner/reviewer shared recovery has exactly one fresh session, separate three-reply budgets and durable links", async () => {
  const root = await mkdtemp(join(tmpdir(), "nt-191-fresh-"));
  try {
    const receiptFile = join(root, "review");
    const original = conversation("original", invalid, [invalid, invalid]);
    const fresh = conversation("fresh", invalid, [invalid, valid]);
    let freshStarts = 0;
    const answer = await recoverWithOneFreshSession({
      sourceDigest: "a".repeat(64), receiptFile,
      initial: { session: original.session, prompt: original.prompt,
        contract: "reviewer.assignment-verdict.v1", validate, parse },
      fresh: async () => ({
        session: fresh.session,
        start: async () => { freshStarts++; },
        prompt: fresh.prompt,
        dispose: () => {},
      }),
    });
    assert.deepEqual(answer, { status: "valid" });
    assert.equal(original.prompts.length, 2);
    assert.equal(freshStarts, 1);
    assert.equal(fresh.prompts.length, 2);
    assert.deepEqual(original.advertised, [[], []]);
    assert.deepEqual(fresh.advertised, [[], []]);
    const first = JSON.parse(await readFile(receiptFile + ".initial.json", "utf8"));
    const second = JSON.parse(await readFile(receiptFile + ".fresh.json", "utf8"));
    const allowance = JSON.parse(await readFile(receiptFile + ".fresh-allowance.json", "utf8"));
    assert.equal(first.status, "protocol-exhausted");
    assert.equal(first.attempts, 3);
    assert.equal(second.status, "accepted");
    assert.equal(second.attempts, 3);
    assert.equal(allowance.freshAllowanceConsumed, true);
    assert.equal(allowance.sourceDigest, "a".repeat(64));
    assert.equal(allowance.originalInvocationId, first.invocationId);
    assert.equal(allowance.freshInvocationId, second.invocationId);
    await assert.rejects(recoverWithOneFreshSession({
      sourceDigest: "a".repeat(64), receiptFile,
      initial: { session: original.session, prompt: original.prompt,
        contract: "reviewer.assignment-verdict.v1", validate, parse },
      fresh: async () => { throw Error("Must never make a third session"); },
    }), /requires reconciliation/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fresh exhaustion stops with typed protocol failure and never opens a third session", async () => {
  const root = await mkdtemp(join(tmpdir(), "nt-191-exhaust-"));
  try {
    const first = conversation("first", invalid, [invalid, invalid]);
    const second = conversation("second", invalid, [invalid, invalid]);
    let invoked = 0;
    await assert.rejects(recoverWithOneFreshSession({
      sourceDigest: "b".repeat(64), receiptFile: join(root, "planner"),
      initial: { session: first.session, prompt: first.prompt,
        contract: "orchestrator.work-plan.v1", validate, parse },
      fresh: async () => {
        invoked++;
        return { session: second.session, start: async () => {},
          prompt: second.prompt, dispose: () => {} };
      },
    }), (error: unknown) => {
      assert.ok(error instanceof ProtocolExhaustedError);
      assert.equal(error.contract, "orchestrator.work-plan.v1");
      assert.equal(error.attempts, 3);
      return true;
    });
    assert.equal(invoked, 1);
    assert.equal(first.prompts.length, 2);
    assert.equal(second.prompts.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("persisted start marker prevents duplicate initial reviewer prompt on graph replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "nt-191-start-"));
  try {
    const receiptFile = join(root, "review");
    const first = conversation("started", invalid, []);
    await beginProtocolInvocation({ receiptFile, sourceDigest: "c".repeat(64),
      contract: "reviewer.assignment-verdict.v1", session: first.session });
    await assert.rejects(refuseReplayedProtocolInvocation(receiptFile), /reconciliation/);
    await assert.rejects(beginProtocolInvocation({ receiptFile, sourceDigest: "c".repeat(64),
      contract: "reviewer.assignment-verdict.v1", session: first.session }), /reconciliation/);
    assert.equal(first.prompts.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("independent reviewer retains real FAIL finding across invalid source-line correction", async () => {
  const sha = "a".repeat(40), path = "events/arrival.md", digest = "b".repeat(64);
  const packet = {
    policy: "assignment-fidelity/v1", sourceDigest: digest,
    items: [{ assignment: { id: "event-arrival" },
      assurance: { commitSha: sha, changedPaths: [path] },
      canonicalContext: [{ path, content: "A clue appears.\nThen the scene ends." }] }],
  } as unknown as SemanticReviewPacket;
  const finding = { commitSha: sha, assignmentId: "event-arrival", path, line: 99,
    kind: "missing-requirement", message: "The promised causal consequence is absent.",
    requiredCorrection: "Add the causal response to this missing clue.",
    affectedPaths: [path] };
  const bad = JSON.stringify({ sourceDigest: digest, verdict: "fail",
    findings: [finding], evidence: [] });
  const corrected = JSON.stringify({ sourceDigest: digest, verdict: "fail",
    findings: [{ ...finding, line: 1, message: "This should not overwrite the original finding." }],
    evidence: [] });
  const contract = assignmentVerdictResponseContract(packet);
  const first = conversation("reviewer-negative", bad, [corrected]);
  const verdict = await recoverResponseContract({
    session: first.session, contract: "reviewer.assignment-verdict.v1",
    validate: contract.validate, parse: contract.parse, prompt: first.prompt,
  });
  assert.equal(verdict.verdict, "fail");
  assert.equal(verdict.findings[0]?.line, 1);
  assert.equal(verdict.findings[0]?.message, finding.message);
  assert.deepEqual(first.advertised, [[]]);

  const pass = JSON.stringify({ sourceDigest: digest, verdict: "pass",
    findings: [], evidence: [{ commitSha: sha, assignmentId: "event-arrival",
      path, line: 1, explanation: "Not a legitimate override" }] });
  const freshContract = assignmentVerdictResponseContract(packet);
  const attempt = conversation("reviewer-soften", bad, [pass, pass]);
  await assert.rejects(recoverResponseContract({
    session: attempt.session, contract: "reviewer.assignment-verdict.v1",
    validate: freshContract.validate, parse: freshContract.parse, prompt: attempt.prompt,
  }), (error: unknown) => {
    assert.ok(error instanceof ProtocolExhaustedError);
    assert.match(error.failedPaths.join(","), /verdict/);
    return true;
  });
});
