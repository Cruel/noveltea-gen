import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { recoverResponseContract, ProtocolExhaustedError } from "../src/response-contract-recovery.js";
import { parseEventManifest } from "../src/event-specialist.js";
import { inspectSpecialistManifest } from "../src/specialist-manifest.js";

function fakeSession(initial: string, corrections: string[]) {
  const messages: Array<{ role: "assistant"; stopReason: "stop"; content: Array<{ type: "text"; text: string } | { type: "toolCall"; name: string }> }> =
    [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: initial }] }];
  let tools = ["read", "write", "edit", "bash", "story_validate"];
  const advertised: string[][] = [];
  const prompts: string[] = [];
  const session = {
    sessionId: "same-pi-session",
    sessionManager: { getSessionFile: () => "/tmp/same-pi-session.jsonl" },
    messages,
    getActiveToolNames: () => [...tools],
    setActiveToolsByName: (names: string[]) => { tools = [...names]; },
  };
  const prompt = async (text: string) => {
    prompts.push(text);
    advertised.push([...tools]);
    const next = corrections.shift();
    if (next === undefined) throw Error("Unexpected protocol prompt");
    messages.push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: next }] });
  };
  return { session, prompt, messages, prompts, advertised, active: () => tools };
}

const good = JSON.stringify({
  modifiedRecords: ["events/arrival.md"], architecturalConflicts: [], laterObligations: [],
});
const badShape = JSON.stringify({
  modifiedRecords: [{ id: "event.arrival", path: "events/arrival.md" }],
  architecturalConflicts: [], laterObligations: [],
});

test("shared protocol recovery corrects invalid JSON and schema in one Pi session without writer tools", async () => {
  const f = fakeSession('{"modifiedRecords":[', [badShape, good]);
  const tmp = await mkdtemp(join(tmpdir(), "nt-response-contract-"));
  try {
    const result = await recoverResponseContract({
      session: f.session, validate: inspectSpecialistManifest, parse: parseEventManifest,
      contract: "specialist.changed-paths.v1", receiptFile: join(tmp, "event.json"),
      prompt: f.prompt,
    });
    assert.deepEqual(result, parseEventManifest(good));
    assert.deepEqual(f.advertised, [[], []]);
    assert.equal(f.session.sessionId, "same-pi-session");
    assert.equal(f.messages.length, 3);
    assert.deepEqual(f.active(), ["read", "write", "edit", "bash", "story_validate"]);
    assert.match(f.prompts[0]!, /\$\.JSON/);
    assert.match(f.prompts[1]!, /\$\.modifiedRecords/);
    const receipt = JSON.parse(await readFile(join(tmp, "event.json"), "utf8"));
    assert.equal(receipt.status, "accepted");
    assert.equal(receipt.attempts, 3);
    assert.equal(receipt.sessionId, "same-pi-session");
    assert.equal(receipt.contract, "specialist.changed-paths.v1");
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test("non-manifest prerequisite reporting uses the shared no-write schema retry", async () => {
  const f = fakeSession("{ broken", [
    JSON.stringify({ verdict: "pass", evidence: ["events/setup.md:12"], reason: "Verified" }),
  ]);
  const result = await recoverResponseContract({
    session: f.session, contract: "prerequisite.milestone-closeout.v1",
    schema: "Required keys: verdict, evidence, reason.",
    validate: text => {
      try {
        const value = JSON.parse(text) as { verdict?: string };
        return value.verdict === "pass" ? [] : [{ path: "$.verdict", expected: "pass" }];
      } catch { return [{ path: "$.JSON", expected: "valid JSON object" }]; }
    },
    parse: text => JSON.parse(text) as { verdict: string },
    prompt: f.prompt,
  });
  assert.equal(result.verdict, "pass");
  assert.deepEqual(f.advertised, [[]]);
  assert.match(f.prompts[0]!, /verdict, evidence, reason/);
  assert.doesNotMatch(f.prompts[0]!, /modifiedRecords/);
});
test("valid first response never prompts or consumes a correction", async () => {
  const f = fakeSession(good, []);
  const result = await recoverResponseContract({
    session: f.session, validate: inspectSpecialistManifest, parse: parseEventManifest,
    contract: "specialist.changed-paths.v1", prompt: f.prompt,
  });
  assert.deepEqual(result, parseEventManifest(good));
  assert.equal(f.prompts.length, 0);
});

test("two invalid corrections exhaust with typed protocol result and unchanged tool policy", async () => {
  const f = fakeSession(badShape, [badShape, badShape]);
  const tmp = await mkdtemp(join(tmpdir(), "nt-response-exhaust-"));
  try {
    await assert.rejects(recoverResponseContract({
      session: f.session, validate: inspectSpecialistManifest, parse: parseEventManifest,
      contract: "specialist.changed-paths.v1", receiptFile: join(tmp, "event.json"),
      prompt: f.prompt,
    }), (error: unknown) => {
      assert.ok(error instanceof ProtocolExhaustedError);
      assert.equal(error.attempts, 3);
      assert.equal(error.contract, "specialist.changed-paths.v1");
      assert.deepEqual(error.failedPaths, ["$.modifiedRecords"]);
      assert.doesNotMatch(error.message, /event\.arrival/);
      return true;
    });
    assert.equal(f.prompts.length, 2);
    assert.deepEqual(f.advertised, [[], []]);
    const receipt = JSON.parse(await readFile(join(tmp, "event.json"), "utf8"));
    assert.equal(receipt.status, "protocol-exhausted");
    assert.equal(receipt.attempts, 3);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test("semantic refusal after valid JSON does not become a format retry", async () => {
  const f = fakeSession(good, []);
  await assert.rejects(recoverResponseContract({
    session: f.session, validate: inspectSpecialistManifest,
    parse: () => { throw Error("Native verification rejected the actual Story"); },
    contract: "specialist.changed-paths.v1", prompt: f.prompt,
  }), /Native verification/);
  assert.equal(f.prompts.length, 0);
});

test("format correction preserves already-authored Story bytes and checks each additional model admission", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "nt-response-canon-"));
  const storyFile = join(tmp, "arrival.md");
  const canonical = "---\\ntype: event\\n---\\nThe train arrives.\\n";
  await writeFile(storyFile, canonical);
  const f = fakeSession(badShape, [badShape, good]);
  let admissions = 0;
  try {
    const result = await recoverResponseContract({
      session: f.session, validate: inspectSpecialistManifest, parse: parseEventManifest,
      contract: "specialist.changed-paths.v1", prompt: async text => {
        assert.equal(await readFile(storyFile, "utf8"), canonical);
        await f.prompt(text);
      },
      beforeCorrection: async () => {
        admissions++;
        assert.equal(await readFile(storyFile, "utf8"), canonical);
      },
    });
    assert.equal(admissions, 2);
    assert.equal(await readFile(storyFile, "utf8"), canonical);
    assert.deepEqual(result.modifiedRecords, ["events/arrival.md"]);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test("budget refusal preserves the response receipt; replay cannot reset protocol attempts", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "nt-response-replay-"));
  const receiptFile = join(tmp, "event.json");
  const f = fakeSession(badShape, [good]);
  try {
    await assert.rejects(recoverResponseContract({
      session: f.session, validate: inspectSpecialistManifest, parse: parseEventManifest,
      contract: "specialist.changed-paths.v1", prompt: f.prompt, receiptFile,
      beforeCorrection: async () => { throw Error("Pi budget exhausted"); },
    }), /budget exhausted/);
    assert.equal(f.prompts.length, 0);
    const state = JSON.parse(await readFile(receiptFile, "utf8"));
    assert.equal(state.status, "invalid-response");
    assert.equal(state.attempts, 1);
    await assert.rejects(recoverResponseContract({
      session: f.session, validate: inspectSpecialistManifest, parse: parseEventManifest,
      contract: "specialist.changed-paths.v1", prompt: f.prompt, receiptFile,
    }), /requires reconciliation/);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test("model response values, secrets and internal stacks never enter correction feedback", async () => {
  const secret = "private-token-must-not-be-repeated";
  const f = fakeSession('{"modifiedRecords":["' + secret + '"', [good]);
  await recoverResponseContract({
    session: f.session, validate: inspectSpecialistManifest, parse: parseEventManifest,
    contract: "specialist.changed-paths.v1", prompt: f.prompt,
  });
  assert.doesNotMatch(f.prompts[0]!, /private-token|Error:|at .*\.ts:/);
  assert.match(f.prompts[0]!, /\$\.JSON/);
});

test("a provider turn without a new response is not miscounted as a failed schema answer", async () => {
  const f = fakeSession("{ broken", []);
  await assert.rejects(recoverResponseContract({
    session: f.session, validate: inspectSpecialistManifest, parse: parseEventManifest,
    contract: "specialist.changed-paths.v1",
    prompt: async () => {},
  }), /no assistant response/);
  assert.equal(f.messages.length, 1);
  assert.deepEqual(f.active(), ["read", "write", "edit", "bash", "story_validate"]);
});

test("any attempted tool call in a format-only reply fails closed", async () => {
  const f = fakeSession("{ broken", [good]);
  const prompt = async (text: string) => {
    await f.prompt(text);
    f.messages.at(-1)!.content.push({ type: "toolCall", name: "write" });
  };
  await assert.rejects(recoverResponseContract({
    session: f.session, validate: inspectSpecialistManifest, parse: parseEventManifest,
    contract: "specialist.changed-paths.v1", prompt,
  }), /protocol correction attempted a tool/);
});
