/** A production graph run from a fixture-authored Architecture checkpoint.
 * Only the model transport is scripted during planning and protocol recovery. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { runArchitectureJob, type CompletionContract } from "../src/architecture.js";
import { createGenerationGraph, runStoryGeneration } from "../src/generation.js";
import { configurePiPolicy, inspectPiPolicy } from "../src/job-pi-policy.js";
import { readAdaptiveState, saveAdaptiveState } from "../src/adaptive-state.js";
import { setJobControl } from "../src/job-control.js";
import { startStoryJob } from "../src/job.js";
import { withJobModelRuntime } from "../src/model-runtime.js";
import { inspectRecoveryCheckpoints } from "../src/recovery-checkpoints.js";
import { reviewBoundedAssignments } from "../src/semantic-assignment-review.js";
import { requiredOrchestratorSkillReads } from "../src/story-skill-policy.js";
import { planWholeStory } from "../web/src/lib/turn-plan.js";

export async function exerciseAdaptiveRecoveryGraph(input: {
  exhaust: boolean; preCallStop?: boolean; completedStop?: boolean; tamperCompleted?: boolean;
  preCallRefusal?: "head" | "model" | "pause" | "cancel";
  story: string; id: string; task: string; source: string; scoped: string; contract: CompletionContract;
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
    if ((input.preCallStop || input.completedStop) && i === 3) {
      const messages = calls[i]!.messages as Array<{ role: string; content?: Array<{ text?: string }> }>;
      const content = messages.filter(m => m.role === "user").flatMap(m => m.content ?? []).map(c => c.text).join("\n");
      const match = content.match(/Only currently pending IDs: (\[[^\n]*\])/);
      assert.ok(match, "the resumed operation retains original pending source");
      return JSON.stringify({ sourceSha: point.commitSha, turnDigest: turn.digest, beforeVersion: 1,
        reason: "Preserve the original verified plan without a second operation", actions: [],
        order: JSON.parse(match[1]!) });
    }
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
    if (input.completedStop) {
      // The parent graph checkpoint has not yet published this operation's
      // reconciliation. Preserve and restore the exact PRE-node state rather
      // than retaining an inventory from an already completed node.
      const originalGraphState = structuredClone((await graph.getState(config)).values);
      const first = await withJobModelRuntime(rt, () =>
        graph.invoke(null, { ...config, interruptAfter: ["author_update_intake"] }));
      assert.equal(first.status, "running", first.reason ?? undefined);
      assert.equal(calls.length, 4);
      const before = (await readAdaptiveState(job, turn.digest, 1))!;
      assert.equal(before.attempts.length, 1);
      assert.equal(before.attempts[0]?.phase, "unchanged");
      assert.equal(before.attempts[0]?.effect?.phase, "responded");
      // C02 no longer accepts a caller-invented legacy operationRecovery
      // disposition. The actual immutable adaptive attempt/response receipt is
      // the only eligible original effect in this before-parent-checkpoint
      // crash simulation. Replay is checked against that receipt below.
      const usage = (await inspectPiPolicy(job)).budget.modelCalls;
      // Deterministically simulate a crash AFTER the original Pi response
      // was checkpointed but BEFORE the parent admitted its disposition.
      // Reopen exactly that persisted attempt, never a new operation.
      before.attempts[0]!.phase = "planning";
      delete before.attempts[0]!.session;
      if (input.tamperCompleted) {
        const session = before.attempts[0]!.effect!.invocation!.file;
        writeFileSync(session, readFileSync(session, "utf8")
          .replace("Preserve the original verified plan without a second operation",
            "A substituted response must not become an authorized plan"));
      } else {
        // Exercise the earlier crash window: terminal response exists, but
        // the effect's completion hash was not checkpointed yet.
        before.attempts[0]!.effect!.phase = "invoking";
        delete before.attempts[0]!.effect!.invocation!.responseSha256;
      }
      await saveAdaptiveState(job, before);
      await graph.updateState(config, originalGraphState, "schedule");
      saver.db.close(); saver = SqliteSaver.fromConnString(file);
      graph = createGenerationGraph(saver, "cli");
      for (let restart = 0; restart < 2; restart++) {
        const inspected = await runStoryGeneration({ action: "inspect", story, job: id });
        assert.notEqual(inspected.status, "completed");
        assert.equal(calls.length, 4, "inspection cannot perform original or replacement model calls");
        assert.equal((await inspectPiPolicy(job)).budget.modelCalls, usage);
      }
      const resumed = await withJobModelRuntime(rt, () =>
        graph.invoke({ request }, { ...config, interruptAfter: ["author_update_intake"] }));
      assert.equal(calls.length, 4, "the resumed graph cannot invoke Pi again");
      assert.equal((await inspectPiPolicy(job)).budget.modelCalls, usage);
      const after = (await readAdaptiveState(job, turn.digest, 1))!;
      assert.equal(after.attempts.length, 1);
      if (input.tamperCompleted) {
        assert.equal(resumed.recoveryLifecycle?.active?.origin.operation, "adaptive-admission");
        assert.equal(resumed.recoveryLifecycle?.phase, "assessing",
          "tampered original evidence must reach the existing operation assessor first");
        assert.equal(after.attempts[0]?.phase, "planning");
        const selected = await withJobModelRuntime(rt, () =>
          graph.invoke(null, { ...config, interruptAfter: ["assess_recovery"] }));
        assert.equal(selected.recoveryLifecycle?.decision?.action, "reconcile-effects");
        assert.equal(selected.recoveryLifecycle?.assessorPending, true,
          "Selected no-replay reconciliation must checkpoint before inspecting external effects");
        const assessed = await withJobModelRuntime(rt, () =>
          graph.invoke(null, { ...config, interruptAfter: ["assess_recovery"] }));
        assert.equal(assessed.status, "blocked", "tampered original Pi evidence must be fenced");
        assert.equal(assessed.recoveryLifecycle?.phase, "fenced");
        assert.equal(calls.length, 4, "assessing tampered evidence cannot create another Pi call");
      } else {
        assert.equal(resumed.status, "running", resumed.reason ?? undefined);
        assert.equal(after.attempts[0]?.phase, "unchanged",
          "an authenticated original terminal response must settle without a replacement call");
        assert.equal(after.attempts[0]?.effect?.phase, "responded");
        assert.ok(resumed.active, "the original verified assignments are schedulable");
      }
      return;
    }
    if (input.preCallStop) {
      const before = await inspectPiPolicy(job);
      // Admission is durable, but the first adaptive Pi preflight is stopped
      // BEFORE any external planner session. The same Thread must resume it.
      await configurePiPolicy(job, { ...before.policy, limits: {
        ...before.policy.limits, modelCalls: before.budget.modelCalls,
      } });
      const stopped = await withJobModelRuntime(rt, () =>
        graph.invoke(null, { ...config, interruptAfter: ["author_update_intake"] }));
      assert.equal(stopped.status, "paused", stopped.reason ?? undefined);
      assert.equal(calls.length, 2, "budget pause must precede the first adaptive Pi call");
      const receipt = (await readAdaptiveState(job, turn.digest, 1))!;
      assert.equal(receipt.attempts.length, 1);
      assert.equal(receipt.attempts[0]?.effect?.phase, "prepared");
      for (let restart = 0; restart < 3; restart++) {
        const report = await runStoryGeneration({ action: "inspect", story, job: id });
        assert.notEqual(report.status, "completed");
        assert.equal(calls.length, 2, "read-only inspection must never dispatch");
        assert.equal((await readAdaptiveState(job, turn.digest, 1))?.attempts[0]?.effect?.phase, "prepared");
      }
      const foreign = join(job.worktreeStoryRoot, "unpublished-adaptive.txt");
      writeFileSync(foreign, "An unrelated writer left uncommitted work.\n");
      try {
        const dirty = await runStoryGeneration({ action: "inspect", story, job: id });
        assert.equal(dirty.status, "blocked", "a dirty worktree must never authorize adaptive recovery");
        assert.equal(calls.length, 2);
      } finally { unlinkSync(foreign); }
      await configurePiPolicy(job, before.policy);
      if (input.preCallRefusal) {
        if (input.preCallRefusal === "head") {
          // A new commit can leave all canonical file bytes unchanged while
          // invalidating the signed source revision for the original attempt.
          execFileSync("git", ["commit", "--allow-empty", "-qm", "Unrelated head movement"],
            { cwd: job.worktreeRoot });
        } else if (input.preCallRefusal === "model") {
          const changed = (await readAdaptiveState(job, turn.digest, 1))!;
          changed.attempts[0]!.effect!.model = "substituted-model";
          await saveAdaptiveState(job, changed);
        } else await setJobControl(job, input.preCallRefusal === "cancel" ? "cancelled" : "paused");
        saver.db.close(); saver = SqliteSaver.fromConnString(file);
        graph = createGenerationGraph(saver, "cli");
        const refused = await withJobModelRuntime(rt, () =>
          runStoryGeneration({ action: "resume", story, job: id }));
        assert.ok(refused.status === "blocked" || refused.status === "paused" ||
          refused.status === "cancelled", "unsafe pre-call source/control must not dispatch");
        assert.equal(calls.length, 2, "source and author control refusal must precede Pi");
        assert.equal((await readAdaptiveState(job, turn.digest, 1))?.attempts[0]?.phase, "planning",
          "a refused operation retains its original fence");
        return;
      }
      saver.db.close(); saver = SqliteSaver.fromConnString(file);
      graph = createGenerationGraph(saver, "cli");
      const resumed = await withJobModelRuntime(rt, () =>
        graph.invoke({ request }, { ...config, interruptAfter: ["author_update_intake"] }));
      assert.equal(resumed.status, "running", resumed.reason ?? undefined);
      assert.equal(calls.length, 4, "same operation invokes exactly one adaptive Pi session");
      const restored = (await readAdaptiveState(job, turn.digest, 1))!;
      assert.equal(restored.attempts.length, 1);
      assert.equal(restored.attempts[0]?.phase, "unchanged");
      assert.equal(restored.attempts[0]?.effect?.phase, "responded");
      assert.ok(resumed.active, "original pending assignment order is still schedulable");
      const recorded = (await inspectPiPolicy(job)).budget.modelCalls;
      assert.equal(recorded, before.budget.modelCalls + 2,
        "one original adaptive call with its verified skill reads consumes exactly two model responses");
      for (let restart = 0; restart < 2; restart++) {
        await runStoryGeneration({ action: "inspect", story, job: id });
        assert.equal(calls.length, 4, "completed original planner cannot restart");
        assert.equal((await inspectPiPolicy(job)).budget.modelCalls, recorded,
          "repeated inspections cannot re-charge Pi usage");
      }
      return;
    }
    const assessed = await withJobModelRuntime(rt, () => graph.invoke(null, { ...config, interruptAfter: ["assess_recovery"] }));
    assert.equal(assessed.recoveryLifecycle?.phase, "correcting", assessed.reason ?? undefined);
    assert.equal(assessed.recoveryLifecycle?.decision?.action, "known-correction");
    assert.equal(assessed.recoveryLifecycle?.active?.origin.sourceHeadSha, point.commitSha);
    assert.equal(assessed.recoveryLifecycle?.assessorPending, true,
      "The original same-session corrective adapter must remain scheduled after the decision checkpoint");
    assert.equal(calls.length, 4);
    saver.db.close(); saver = SqliteSaver.fromConnString(file); graph = createGenerationGraph(saver, "cli");
    const inspect = await runStoryGeneration({ action: "inspect", story, job: id });
    assert.equal(inspect.recoveryInspection?.phase, "correcting", inspect.reason ?? undefined);
    assert.equal(inspect.recoveryInspection?.active?.operation, "adaptive-planner");
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
      assert.equal(recovered.recoveryLifecycle?.decision?.action, "exhausted", recovered.reason ?? undefined);
      assert.equal(recovered.recoveryLifecycle?.phase, "fenced");
      for (const action of ["inspect", "resume", "resume"] as const) {
        const report = await withJobModelRuntime(rt, () => runStoryGeneration({ action, story, job: id }));
        assert.equal(report.recoveryInspection?.phase, "fenced");
        assert.equal(report.recoveryInspection?.active?.operation, "adaptive-planner");
        assert.equal(report.status, "blocked");
        assert.equal(calls.length, 6, "restart cannot replenish a protocol allowance");
      }
      return;
    }
    assert.equal(recovered.recoveryLifecycle?.phase, "idle", recovered.reason ?? undefined);
    assert.equal(recovered.recoveryLifecycle?.active, null);
    assert.equal(recovered.status, "running");
    assert.ok(recovered.active, "normal scheduling continues");
    assert.equal(calls.length, 5);
    assert.equal((await runStoryGeneration({ action: "inspect", story, job: id })).recoveryInspection, null,
      "The settled same-session protocol must leave no active recovery case");
    assert.equal(calls.length, 5);
  } finally { saver.db.close(); if (previous === undefined) delete process.env.NT_ADAPTIVE_PLANNING;
    else process.env.NT_ADAPTIVE_PLANNING = previous; }
}
