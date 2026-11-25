// A production Generation subprocess with scripted Pi transport. All native,
// Git, planner, ownership, child assignment and review gates are unchanged.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { planWholeStory } from "../../web/src/lib/turn-plan.js";
import { saveJobTurnPlan } from "../../web/src/lib/turn-plan-receipt.server.js";
import { scriptedModel } from "../c03-scripted-story-helpers.js";
import type { JobStartResult } from "../../src/job.js";
import type { CompletionContract } from "../../src/architecture.js";

export const archiveContract: CompletionContract = {
  scope: { kind: "full-story", depth: "composition", targets: [], branches: [] },
  constraints: ["The player can protect or challenge the witness"],
  envelope: { presentation: "Dialogue-led visual novel", hardLimits: [], preferences: [] },
};

export async function startCurrentStory(job: JobStartResult, env: NodeJS.ProcessEnv,
  stage: string, task = "A missing archive witness; invent unspecified details",
  contract = archiveContract, archive = true) {
  const file = join(job.stateDir, "test-contract.json");
  writeFileSync(file, JSON.stringify(contract));
  await saveJobTurnPlan(job, planWholeStory(task, contract, job.baseSha));
  const result = spawnSync(process.execPath,
    ["--import", "tsx", resolve(archive ? "test/support/scripted-archive-cli.ts" : "test/support/scripted-foundation-cli.ts"),
      "job", "generate", "start", "--story", job.storyRoot, "--job", job.jobId,
      "--task", task, "--contract", file, "--skills-source", resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills"),
      "--provider", scriptedModel.provider, "--model", scriptedModel.id, "--pause-after", stage],
    { env: { ...env, NT_TEST_SCRIPTED_MODEL_LOG: join(job.stateDir, "test-model-calls.jsonl") },
      encoding: "utf8", timeout: 240000, maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "paused", JSON.stringify({ reason: output.reason, recovery: output.recoveryInspection }));
  return output;
}
