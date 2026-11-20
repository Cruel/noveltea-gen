import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assignmentVerdictResponseContract } from "../src/narrative-review-specialist.js";
import { configurePiPolicy, guardPiBudget, PiBudgetPause } from "../src/job-pi-policy.js";
import type { JobStartResult } from "../src/job.js";
import type { SemanticReviewPacket } from "../src/semantic-assignment-review.js";
import {
  recoverResponseContract, recoverWithOneFreshSession, ProtocolExhaustedError,
  beginProtocolInvocation, refuseReplayedProtocolInvocation,
  inspectResumableProtocolExhaustion, resumeExhaustedFreshProtocol,
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

test("#210 exhausted reviewer budget pause admits no fallback until limit increases, then resumes without original replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "nt-210-fresh-budget-"));
  try {
    const receiptFile = join(root, "review");
    const originalFile = join(root, "original.jsonl");
    const digest = "d".repeat(64);
    const contract = "reviewer.assignment-verdict.v1";
    const original = conversation("original-budget", invalid, [invalid, invalid]);
    original.session.sessionManager.getSessionFile = () => originalFile;
    const message = (text: string) => JSON.stringify({ type: "message", message: {
      role: "assistant", stopReason: "stop", content: [{ type: "text", text }],
    } }) + "\n";
    await writeFile(originalFile, JSON.stringify({ type: "session", id: original.session.sessionId }) + "\n");
    await beginProtocolInvocation({ receiptFile, sourceDigest: digest,
      contract, session: original.session });
    await appendFile(originalFile, message(invalid));
    const originalPrompt = async (instruction: string) => {
      await original.prompt(instruction);
      await appendFile(originalFile, message(invalid));
    };
    const job = { stateDir: root } as JobStartResult;
    await configurePiPolicy(job, { version: 1,
      profile: { provider: "script", model: "script-model" }, limits: { steps: 0 } });
    let freshStarts = 0;
    let freshAllocations = 0;
    const makeFresh = async () => {
      freshAllocations++;
      const name = "fresh-" + freshAllocations;
      const file = join(root, name + ".jsonl");
      const fresh = conversation(name, valid, []);
      fresh.session.sessionManager.getSessionFile = () => file;
      await writeFile(file, JSON.stringify({ type: "session", id: name }) + "\n");
      return {
        session: fresh.session,
        admit: () => guardPiBudget(job, "assignment-fidelity:fresh"),
        start: async () => {
          freshStarts++;
          await appendFile(file, message(valid));
        },
        prompt: fresh.prompt, dispose: () => {},
      };
    };
    await assert.rejects(recoverWithOneFreshSession({
      receiptFile, sourceDigest: digest,
      initial: { session: original.session, prompt: originalPrompt,
        contract, validate, parse },
      fresh: makeFresh,
    }), (error: unknown) => error instanceof PiBudgetPause && error.reason === "steps");
    assert.equal(original.prompts.length, 2);
    assert.equal(freshStarts, 0, "fallback had NO model call before budget admission");
    assert.equal(existsSync(receiptFile + ".fresh-allowance.json"), false);
    const first = JSON.parse(await readFile(receiptFile + ".initial.json", "utf8"));
    assert.equal(first.status, "protocol-exhausted");
    await inspectResumableProtocolExhaustion({ receiptFile, sourceDigest: digest,
      contract, sessionRoots: [root], validate });
    await configurePiPolicy(job, { version: 1,
      profile: { provider: "script", model: "script-model" }, limits: { steps: 1 } });
    const result = await resumeExhaustedFreshProtocol({
      receiptFile, sourceDigest: digest, contract, sessionRoots: [root],
      validate, parse, fresh: makeFresh,
    });
    assert.deepEqual(result, { status: "valid" });
    assert.equal(original.prompts.length, 2, "original exhausted replies cannot rerun");
    assert.equal(freshStarts, 1);
    assert.equal(freshAllocations, 2, "only unadmitted fallback allocation is discarded");
    const allowance = JSON.parse(await readFile(receiptFile + ".fresh-allowance.json", "utf8"));
    assert.equal(allowance.freshSessionId, "fresh-2");
    await assert.rejects(resumeExhaustedFreshProtocol({
      receiptFile, sourceDigest: digest, contract, sessionRoots: [root],
      validate, parse, fresh: makeFresh,
    }), /already admitted/);
    assert.equal(freshStarts, 1);
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
