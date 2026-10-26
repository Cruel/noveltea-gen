import assert from "node:assert/strict";
import { test } from "node:test";
import { createHandoffRecorder, parseWorkerOutput, parseDirectWorkerOutput } from "../src/pi.js";
import { WORKER_DESTINATION, DIRECT_WORKER_DESTINATION } from "../src/graph.js";

test("Pi handoff tool records intent without running a worker", async () => {
  const recorder = createHandoffRecorder();
  assert.equal(recorder.tool.name, "delegate_to_worker");
  const output = await recorder.tool.execute(
    "call-1",
    { destination: WORKER_DESTINATION, brief: "Suggest a twist" },
    undefined, undefined, {} as never,
  );
  assert.match(output.content[0]?.type === "text" ? output.content[0].text : "", /Handoff recorded/);
  assert.deepEqual(recorder.getIntent(), { destination: WORKER_DESTINATION, brief: "Suggest a twist" });
  const direct = createHandoffRecorder();
  await direct.tool.execute("call-2", { destination: DIRECT_WORKER_DESTINATION, brief: "Write tagline" },
    undefined, undefined, {} as never);
  assert.deepEqual(direct.getIntent(), { destination: DIRECT_WORKER_DESTINATION, brief: "Write tagline" });
});

test("Pi handoff tool rejects no call, malformed intent, and repeated calls", async () => {
  assert.throws(() => createHandoffRecorder().getIntent(), /exactly one/);
  const recorder = createHandoffRecorder();
  await recorder.tool.execute("1", { destination: "unexpected", brief: "do work" },
    undefined, undefined, {} as never);
  assert.throws(() => recorder.getIntent(), /unknown destination/);
  await recorder.tool.execute("2", { destination: WORKER_DESTINATION, brief: "second" },
    undefined, undefined, {} as never);
  assert.throws(() => recorder.getIntent(), /exactly one/);
});

test("worker text must be an exact, structured update", () => {
  assert.deepEqual(parseWorkerOutput('{"storyNote":"The cousin did it."}'),
    { storyNote: "The cousin did it." });
  for (const raw of [
    "not JSON", '~~~json\n{"storyNote":"ok"}\n~~~', "{}",
    '["bad"]', '{"storyNote":""}', '{"storyNote":1}',
    '{"storyNote":"ok","response":"unexpected"}',
  ]) {
    assert.throws(() => parseWorkerOutput(raw), /Invalid worker output/);
  }
});

test("direct pi-ai worker text must be an exact, single-field tagline update", () => {
  assert.deepEqual(parseDirectWorkerOutput('{"tagline":"Every secret has a price."}'),
    { tagline: "Every secret has a price." });
  for (const raw of [
    "not JSON", '{}', '["a tagline"]', '{"tagline":""}', '{"tagline":3}',
    '{"storyNote":"wrong field"}', '{"tagline":"fine","storyNote":"inject"}',
    '```json\n{"tagline":"no fences"}\n```',
  ]) {
    assert.throws(() => parseDirectWorkerOutput(raw), /Invalid direct worker output/);
  }
});
