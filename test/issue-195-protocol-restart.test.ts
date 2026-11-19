import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginProtocolInvocation, recoverResponseContract, inspectCompletedProtocolResponse,
  type ResponseContractSession,
} from "../src/response-contract-recovery.js";

const sourceDigest = "a".repeat(64);
const accepted = '{"status":"valid"}';
const invalid = '{"status":"invalid"}';
const contract = "reviewer.assignment-verdict.v1";
const validate = (text: string) => text === accepted ? [] :
  [{ path: "$.status", expected: "valid" }];
const parse = (text: string) => JSON.parse(text) as { status: string };

function transcript(id: string, messages: Array<{ role: string; content: string; stopReason?: string }>) {
  return [
    JSON.stringify({ type: "session", id }),
    ...messages.map(message => JSON.stringify({
      type: "message", message: { ...message,
        content: [{ type: "text", text: message.content }] },
    })),
  ].join("\n") + "\n";
}

test("a completed original protocol reply is recovered twice without a model call", async t => {
  const root = await mkdtemp(join(tmpdir(), "nt-195-protocol-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const receiptFile = join(root, "review");
  const sessionFile = join(root, "sessions", "review.jsonl");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(root, "sessions"));
  await writeFile(sessionFile, transcript("original", []));
  const messages: Array<{ role: string; stopReason: string; content: Array<{ type: string; text: string }> }> =
    [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: accepted }] }];
  const session: ResponseContractSession = {
    sessionId: "original", sessionManager: { getSessionFile: () => sessionFile }, messages,
    getActiveToolNames: () => [], setActiveToolsByName: () => {},
  };
  await beginProtocolInvocation({ receiptFile, sourceDigest, contract, session });
  await writeFile(sessionFile, transcript("original", [
    { role: "user", content: "Review exact committed source" },
    { role: "assistant", content: accepted, stopReason: "stop" },
  ]));
  await recoverResponseContract({ contract, session, validate, parse,
    prompt: async () => { throw Error("Unexpected correction"); },
    receiptFile: receiptFile + ".initial.json" });
  for (let i = 0; i < 2; i++) {
    const result = await inspectCompletedProtocolResponse({
      receiptFile, sourceDigest, contract, sessionRoots: [join(root, "sessions")],
      validate, parse,
    });
    assert.deepEqual(result, { status: "valid" });
  }
  assert.equal(JSON.parse(await readFile(receiptFile + ".initial.json", "utf8")).attempts, 1);
  await writeFile(sessionFile, transcript("original", [
    { role: "user", content: "Review exact committed source" },
    { role: "assistant", content: invalid, stopReason: "stop" },
  ]));
  await assert.rejects(inspectCompletedProtocolResponse({
    receiptFile, sourceDigest, contract, sessionRoots: [join(root, "sessions")],
    validate, parse,
  }), /integrity-blocked|differs|hash/i);
});

test("crash after a completed first reply but before its receipt can finalize, never replay the prompt", async t => {
  const root = await mkdtemp(join(tmpdir(), "nt-195-start-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const receiptFile = join(root, "review");
  const sessionFile = join(root, "original.jsonl");
  await writeFile(sessionFile, transcript("original", []));
  const session: ResponseContractSession = {
    sessionId: "original", sessionManager: { getSessionFile: () => sessionFile }, messages: [],
    getActiveToolNames: () => [], setActiveToolsByName: () => {},
  };
  await beginProtocolInvocation({ receiptFile, sourceDigest, contract, session });
  await writeFile(sessionFile, transcript("original", [
    { role: "user", content: "Review pinned source" },
    { role: "assistant", content: accepted, stopReason: "stop" },
  ]));
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(await inspectCompletedProtocolResponse({
      receiptFile, sourceDigest, contract, sessionRoots: [root], validate, parse,
    }), { status: "valid" });
  }
  const saved = await readFile(receiptFile + ".initial.json", "utf8");
  assert.equal(JSON.parse(saved).status, "accepted");
  await assert.rejects(inspectCompletedProtocolResponse({
    receiptFile, sourceDigest: "b".repeat(64), contract,
    sessionRoots: [root], validate, parse,
  }), /integrity-blocked|source/i);
});

test("crashed format-only correction refuses tool activity without spending an attempt", async t => {
  const root = await mkdtemp(join(tmpdir(), "nt-195-protocol-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const receiptFile = join(root, "review");
  const sessionFile = join(root, "original.jsonl");
  await writeFile(sessionFile, transcript("original", []));
  const messages = [{ role: "assistant", stopReason: "stop", content: [
    { type: "text", text: invalid },
  ] }];
  const session: ResponseContractSession = {
    sessionId: "original", sessionManager: { getSessionFile: () => sessionFile },
    messages, getActiveToolNames: () => [], setActiveToolsByName: () => {},
  };
  await beginProtocolInvocation({ receiptFile, sourceDigest, contract, session });
  await assert.rejects(recoverResponseContract({
    contract, session, validate, parse, receiptFile: receiptFile + ".initial.json",
    prompt: async () => { throw Error("Simulated model interruption"); },
  }), /Simulated model interruption/);
  const record = (message: unknown) => JSON.stringify({ type: "message", message }) + "\n";
  await writeFile(sessionFile, JSON.stringify({ type: "session", id: "original" }) + "\n" +
    record({ role: "user", content: [{ type: "text", text: "Original review" }] }) +
    record({ role: "assistant", stopReason: "stop",
      content: [{ type: "text", text: invalid }] }) +
    record({ role: "user", content: [{ type: "text", text: "Correction only" }] }) +
    record({ role: "assistant", stopReason: "toolUse", content: [
      { type: "toolCall", id: "unexpected", name: "write",
        arguments: { path: "events/other.md", content: "unauthorized" } }] }) +
    record({ role: "toolResult", toolCallId: "unexpected" }) +
    record({ role: "assistant", stopReason: "stop",
      content: [{ type: "text", text: accepted }] }));
  for (let restart = 0; restart < 2; restart++)
    await assert.rejects(inspectCompletedProtocolResponse({
      receiptFile, sourceDigest, contract, sessionRoots: [root], validate, parse,
    }), /integrity-blocked.*unexpected tool/);
  const pending = JSON.parse(await readFile(receiptFile + ".initial.json", "utf8"));
  assert.equal(pending.attempts, 1);
  assert.equal(pending.status, "correction-pending");
});

test("incomplete or ambiguous protocol replies fail closed twice without spending another attempt", async t => {
  const root = await mkdtemp(join(tmpdir(), "nt-195-unknown-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const receiptFile = join(root, "review");
  const sessionFile = join(root, "original.jsonl");
  await writeFile(sessionFile, transcript("original", []));
  const session: ResponseContractSession = {
    sessionId: "original", sessionManager: { getSessionFile: () => sessionFile }, messages: [],
    getActiveToolNames: () => [], setActiveToolsByName: () => {},
  };
  await beginProtocolInvocation({ receiptFile, sourceDigest, contract, session });
  await writeFile(sessionFile, transcript("original", [
    { role: "user", content: "Review pinned source" },
    { role: "assistant", content: invalid, stopReason: "stop" },
  ]));
  for (let i = 0; i < 2; i++)
    await assert.rejects(inspectCompletedProtocolResponse({
      receiptFile, sourceDigest, contract, sessionRoots: [root], validate, parse,
    }), /requires reconciliation|incomplete|integrity-blocked/i);
  assert.equal(await readFile(receiptFile + ".started.json", "utf8") !== "", true);
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(receiptFile + ".initial.json"), false);
});
