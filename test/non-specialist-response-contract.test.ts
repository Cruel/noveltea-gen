import assert from "node:assert/strict";
import { test } from "node:test";
import { adaptiveResponseFailures } from "../src/adaptive-protocol.js";
import { ideaResponseFailures, parseIdeaResponse } from "../src/idea-response-contract.js";
import { recoverResponseContract, ProtocolExhaustedError } from "../src/response-contract-recovery.js";

const proposal = { sourceSha: "source", turnDigest: "turn", beforeVersion: 1,
  reason: "Continue", actions: [], order: [] };
test("adaptive response verifier rejects extra authority claims and unknown action prototypes", () => {
  assert.deepEqual(adaptiveResponseFailures(JSON.stringify(proposal)), []);
  assert.deepEqual(adaptiveResponseFailures(JSON.stringify({ ...proposal, approved: true })),
    [{ path: "$", expected: "no unknown proposal fields" }]);
  assert.deepEqual(adaptiveResponseFailures(JSON.stringify({ ...proposal, actions: [{ kind: "constructor" }] })),
    [{ path: "$.actions[0].kind", expected: "add|split|depend|narrow|omit" }]);
});

function transport(initial: string, corrections: string[]) {
  let tools = ["read", "story_context"];
  const messages = [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: initial }] }];
  let calls = 0;
  const session = { sessionId: "original-idea", sessionManager: { getSessionFile: () => "/tmp/original-idea.jsonl" },
    messages, getActiveToolNames: () => tools, setActiveToolsByName: (names: string[]) => { tools = names; } };
  const prompt = async () => {
    assert.deepEqual(tools, []);
    calls++;
    const text = corrections.shift();
    assert.ok(text);
    messages.push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text }] });
  };
  return { session, prompt, calls: () => calls };
}

test("idea selection repairs malformed output in its original read-only conversation, retaining truthful refusal", async () => {
  const negative = JSON.stringify({ verdict: "block", target: null, evidence: [], reason: "No suitable candidate" });
  const f = transport("{", [negative]);
  const response = await recoverResponseContract({
    ...f, contract: "idea-selection.v1", validate: text => ideaResponseFailures(text, true),
    parse: text => parseIdeaResponse(text, true),
  });
  assert.equal(response.verdict, "block");
  assert.equal(response.target, null);
  assert.equal(f.calls(), 1);
  assert.equal(f.session.sessionId, "original-idea");
  assert.deepEqual(f.session.getActiveToolNames(), ["read", "story_context"]);
});

test("negative fulfillment review is a valid report, not a format failure or an approval", async () => {
  const negative = JSON.stringify({ verdict: "block", evidence: ["events/setup.md:2"], reason: "Binding meaning absent" });
  const f = transport(negative, []);
  const response = await recoverResponseContract({
    ...f, contract: "idea-review.v1", validate: text => ideaResponseFailures(text, false),
    parse: text => parseIdeaResponse(text, false),
  });
  assert.equal(response.verdict, "block");
  assert.equal(f.calls(), 0);
});

test("idea response exhaustion is bounded and cannot manufacture an approval", async () => {
  const f = transport("{}", ["{}", "{}"]);
  await assert.rejects(recoverResponseContract({
    ...f, contract: "idea-review.v1", validate: text => ideaResponseFailures(text, false),
    parse: text => parseIdeaResponse(text, false),
  }), ProtocolExhaustedError);
  assert.equal(f.calls(), 2);
});
