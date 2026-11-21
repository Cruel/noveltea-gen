/** A production graph run from a fixture-authored Architecture checkpoint.
 * Only the model transport is scripted during planning and protocol recovery. */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { runArchitectureJob, type CompletionContract } from "../src/architecture.js";
import { createGenerationGraph, runStoryGeneration } from "../src/generation.js";
import { configurePiPolicy, inspectPiPolicy } from "../src/job-pi-policy.js";
import { startStoryJob } from "../src/job.js";
import { withJobModelRuntime } from "../src/model-runtime.js";
import { inspectRecoveryCheckpoints } from "../src/recovery-checkpoints.js";
import { reviewBoundedAssignments } from "../src/semantic-assignment-review.js";
import { requiredOrchestratorSkillReads } from "../src/story-skill-policy.js";
import { planWholeStory } from "../web/src/lib/turn-plan.js";

export async function exerciseAdaptiveRecoveryGraph(input: {
  exhaust: boolean; story: string; id: string; task: string; source: string; scoped: string; contract: CompletionContract;
  provider: string; model: string; calls: Array<{ tools: string[]; messages: readonly unknown[] }>;
  runtime(script: (index: number) => string | string[]): Promise<ModelRuntime>;
}) {
  const { story, id, task, source, contract, provider, model, calls } = input;
  const job = await startStoryJob({ story, job: id, worktreeCacheRoot: input.scoped });
  const turn = planWholeStory(task, contract, job.baseSha, id);
  writeFileSync(join(job.stateDir, "turn-plan.json"), JSON.stringify(turn));
  await runArchitectureJob({ action: "run", story, job: id, task, contract, fixture: true, skillsSource: source });
  const point = (await inspectRecoveryCheckpoints(job)).find(p => p.workItem === "global-architecture" && p.eligible);
  assert.ok(point?.assurance);
  if (point.semanticReview === "required-pending") await reviewBoundedAssignments(job, [point], async packet => ({
    sourceDigest: packet.sourceDigest, verdict: "pass", findings: [], evidence: packet.items.map(item => ({
      commitSha: item.assurance.commitSha, assignmentId: item.assignment.id, path: item.assurance.changedPaths[0]!,
      line: 1, explanation: "Deterministic Architecture prerequisite only; not a live certification.",
    })),
  }), "adaptive-protocol-fixture", true);
  const config = { configurable: { thread_id: job.threadId + ":generation" } };
  const reads = [...requiredOrchestratorSkillReads("autonomous")];
  const rt = await input.runtime(i => {
    if (i === 0 || i === 2) return reads;
    if (i === 1) return JSON.stringify({ sourceSha: job.baseSha, turnDigest: turn.digest,
      assignments: turn.assignments.map(a => ({ id: a.id, reason: "Verified scoped assignment" })) });
    if (i === 3) return '{"sourceSha":';
    assert.ok(i === 4 || (input.exhaust && i === 5), "no planner replacement or writer replay");
    assert.deepEqual(calls[i]!.tools, []);
    const messages = calls[i]!.messages as Array<{ role: string; content?: Array<{ text?: string }> }>;
    const content = messages.filter(m => m.role === "user").flatMap(m => m.content ?? []).map(c => c.text).join("\n");
    assert.match(content, /Contract failures: \$/);
    if (input.exhaust) return "not JSON";
    const match = content.match(/Only currently pending IDs: (\[[^\n]*\])/);
    assert.ok(match, "original adaptive proposal context must still be present");
    return JSON.stringify({ sourceSha: point.commitSha, turnDigest: turn.digest, beforeVersion: 1,
      reason: "Preserve the approved pending order", actions: [], order: JSON.parse(match[1]!) });
  });
  const previous = process.env.NT_ADAPTIVE_PLANNING;
  process.env.NT_ADAPTIVE_PLANNING = "1";
  const file = join(job.stateDir, "generation.sqlite");
  let saver = SqliteSaver.fromConnString(file);
  try {
    let graph = createGenerationGraph(saver, "cli");
    const request = { story, job: id, task, contract, fixture: false, skillsSource: source, provider, model,
      turnPlanDigest: turn.digest, orchestrationPolicy: "explicit" as const };
    const start = await withJobModelRuntime(rt, () => graph.invoke({ request }, { ...config, interruptAfter: ["schedule"] }));
    assert.equal(start.status, "running", start.reason ?? undefined);
    await graph.updateState(config, { completedStages: [
      { stage: "foundation", status: "committed", headSha: job.baseSha },
      { stage: "architecture", status: "architecture-committed", headSha: point.commitSha, planVersion: 1 },
    ], planVersion: 1 }, "schedule");
    const assessed = await withJobModelRuntime(rt, () => graph.invoke(null, { ...config, interruptAfter: ["assess_recovery"] }));
    assert.equal(assessed.recovery?.phase, "authorized", assessed.reason ?? undefined);
    assert.equal(assessed.recovery.sourceSha, point.commitSha);
    assert.equal(calls.length, 4);
    saver.db.close(); saver = SqliteSaver.fromConnString(file); graph = createGenerationGraph(saver, "cli");
    const inspect = await runStoryGeneration({ action: "inspect", story, job: id });
    assert.equal(inspect.recovery?.phase, "authorized", inspect.reason ?? undefined);
    assert.equal(calls.length, 4);
    // Hit a real job budget after the first unsuccessful correction. Raising
    // that budget on restart must not buy two more responses (or a new session).
    const { policy, budget } = await inspectPiPolicy(job);
    if (input.exhaust) await configurePiPolicy(job, { ...policy, limits: { ...policy.limits, modelCalls: budget.modelCalls + 1 } });
    let recovered = await withJobModelRuntime(rt, () => graph.invoke(null, { ...config, interruptAfter: ["author_update_intake"] }));
    if (input.exhaust) {
      assert.equal(recovered.status, "paused", recovered.reason ?? undefined);
      assert.equal(calls.length, 5);
      await configurePiPolicy(job, policy);
      saver.db.close(); saver = SqliteSaver.fromConnString(file); graph = createGenerationGraph(saver, "cli");
      recovered = await withJobModelRuntime(rt, () => graph.invoke({ request }, { ...config, interruptAfter: ["author_update_intake"] }));
      assert.equal(recovered.status, "blocked");
      assert.equal(recovered.recovery?.phase, "protocol-exhausted", recovered.reason ?? undefined);
      for (const action of ["inspect", "resume", "resume"] as const) {
        const report = await withJobModelRuntime(rt, () => runStoryGeneration({ action, story, job: id }));
        assert.equal(report.recovery?.phase, "protocol-exhausted");
        assert.equal(report.status, "blocked");
        assert.equal(calls.length, 6, "restart cannot replenish a protocol allowance");
      }
      return;
    }
    assert.equal(recovered.recovery?.phase, "completed", recovered.reason ?? undefined);
    assert.equal(recovered.status, "running");
    assert.ok(recovered.active, "normal scheduling continues");
    assert.equal(calls.length, 5);
    assert.equal((await runStoryGeneration({ action: "inspect", story, job: id })).recovery?.phase, "completed");
    assert.equal(calls.length, 5);
  } finally { saver.db.close(); if (previous === undefined) delete process.env.NT_ADAPTIVE_PLANNING;
    else process.env.NT_ADAPTIVE_PLANNING = previous; }
}
