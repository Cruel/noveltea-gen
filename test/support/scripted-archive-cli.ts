import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startStoryJob } from "../../src/job.js";
import { readTurnEvidence, type TurnEvidence } from "../../src/turn-plan-evidence.js";
import { withJobModelRuntime } from "../../src/model-runtime.js";
import { fixtureSandboxClient, scriptedModel, scriptedStoryRuntime } from "../c03-scripted-story-helpers.js";
import { archiveStages } from "./scripted-archive-stages.js";
const args = process.argv.slice(2);
assert.deepEqual(args.slice(0, 2), ["job", "generate"]);
assert.ok(!args.includes("--fixture"));
const arg = (name: string) => args[args.indexOf(name) + 1]!;
const job = await startStoryJob({ story: arg("--story"), job: arg("--job") }, false);
const hint = JSON.parse(readFileSync(join(job.stateDir, "turn-plan.json"), "utf8")) as TurnEvidence;
const plan = await readTurnEvidence(job, hint.contract, hint.originalRequest, hint.digest);
assert.ok(plan && plan.kind === "full-story");
if (args[2] === "start") {
  assert.equal(arg("--provider"), scriptedModel.provider);
  assert.equal(arg("--model"), scriptedModel.id);
}
const reply = archiveStages(job, plan);
const { runtime } = await scriptedStoryRuntime((index, context) => {
  const log = process.env.NT_TEST_SCRIPTED_MODEL_LOG;
  assert.ok(log);
  try {
    const response = reply(index, context);
    appendFileSync(log, JSON.stringify({ command: args[2], index, tools: response.content.map(c => c.type === "toolCall" ? c.name : "text") }) + "\n");
    return response;
  } catch (error) {
    appendFileSync(log, String(error) + "\n");
    throw error;
  }
});
fixtureSandboxClient(job.jobId, job.worktreeStoryRoot);
await withJobModelRuntime(runtime, () => import("../../src/cli.js"));
