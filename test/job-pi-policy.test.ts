import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { withActiveExecutionTime } from "../src/job-active-time.js";
import { parseJobLimits } from "../src/job-limits.js";
import { after, test } from "node:test";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { startStoryJob } from "../src/job.js";
import { openStoryProject } from "../src/project.js";
import { configurePiPolicy, guardPiBudget, inspectPiPolicy, PiBudgetPause, PiModelUnavailableError,
  preparePiContext, piNarrativeGroup, resolvePiModel,
  restoreAcceptedPiReviewContext, type PiPolicy } from "../src/job-pi-policy.js";

const fixtures = mkdtempSync(join(tmpdir(), "nt-gen-pi-policy-"));
after(() => rmSync(fixtures, { recursive: true, force: true }));
const originalState = process.env.NT_STATE_DIR;
process.env.NT_STATE_DIR = join(fixtures, "state");
after(() => { if (originalState === undefined) delete process.env.NT_STATE_DIR;
  else process.env.NT_STATE_DIR = originalState; });

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
let number = 0;
async function fixture() {
  const root = join(fixtures, "repo-" + ++number);
  const story = join(root, "story");
  mkdirSync(story, { recursive: true });
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test Author");
  mkdirSync(join(story, "events"));
  mkdirSync(join(story, "arcs"));
  writeFileSync(join(story, "events", "test.md"), "Initial Event.\n");
  writeFileSync(join(story, "arcs", "test.md"), "Initial Arc.\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "Baseline");
  const job = await startStoryJob({ story, job: "policy" });
  const project = await openStoryProject(job.worktreeStoryRoot);
  return { root, story, job, project };
}
const policy = (overrides: Partial<PiPolicy> = {}): PiPolicy => ({
  version: 1, profile: { provider: "example", model: "required" }, limits: {},
  ...overrides,
});
function runtime(available: string[] = ["required", "fallback"], reasoning = true) {
  return {
    getModel: (provider: string, model: string) => ["required", "fallback"].includes(model)
      ? { provider, id: model, reasoning } : undefined,
    getAvailable: async (_provider: string) => available.map(id => ({ id })),
  } as unknown as ModelRuntime;
}
function options(job: Awaited<ReturnType<typeof fixture>>["job"], step: string,
  paths = ["events/test.md"], group = "event:test") {
  return {
    group, step, paths, snapshot: "snapshot-1",
    provider: "example", model: "required",
    directory: join(dirname(job.worktreeRoot), "event-sessions", step),
  };
}

test("public job Pi CLI configures and inspects a pinned profile and safe budgets", async () => {
  const { story, job } = await fixture();
  const cli = resolve("src/cli.ts");
  const run = (...args: string[]) => spawnSync(process.execPath,
    ["--import", "tsx", cli, "job", "pi", ...args, "--story", story, "--job", "policy"],
    { encoding: "utf8", cwd: resolve("."), env: { ...process.env }, timeout: 30000 });
  const configured = run("configure", "--provider", "example", "--model", "required",
    "--fallback-provider", "example", "--fallback-model", "fallback", "--thinking", "medium",
    "--max-steps", "0", "--max-model-calls", "8", "--max-cost-usd", "2.5");
  assert.equal(configured.status, 0, configured.stderr);
  assert.equal(JSON.parse(configured.stdout).policy.profile.optionalFallback.model, "fallback");
  assert.equal(JSON.parse(configured.stdout).policy.profile.thinking, "medium");
  await assert.rejects(guardPiBudget(job, "event:first"),
    (err: unknown) => err instanceof PiBudgetPause && err.reason === "steps");
  const inspected = run("inspect");
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.equal(JSON.parse(inspected.stdout).budget.pause.reason, "steps");
  assert.equal(JSON.parse(inspected.stdout).budget.steps, 0);
  const resumed = run("configure", "--max-steps", "1");
  assert.equal(resumed.status, 0, resumed.stderr);
  await guardPiBudget(job, "event:first");
  assert.equal((await inspectPiPolicy(job)).budget.steps, 1);
  await guardPiBudget(job, "event:first"); // idempotent across retries
  await assert.rejects(guardPiBudget(job, "event:second"), PiBudgetPause);
  assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "");
  assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), job.baseSha);
});

test("required model rejection, explicit fallback, immutable resolution and reasoning capability", async () => {
  const { job } = await fixture();
  await assert.rejects(resolvePiModel(job, runtime([]), "example", "required"),
    (error: unknown) => error instanceof PiModelUnavailableError &&
      /Required Pi model\/capabilities unavailable/.test(error.message));
  assert.equal((await inspectPiPolicy(job)).resolved, undefined);
  await configurePiPolicy(job, policy({ profile: { provider: "example", model: "required",
    optionalFallback: { provider: "example", model: "fallback" } } }));
  const selected = await resolvePiModel(job, runtime(["fallback"]), "example", "required");
  assert.equal(selected.model.id, "fallback");
  assert.equal(selected.resolution.source, "explicit-optional-fallback");
  await assert.rejects(resolvePiModel(job, runtime(["required"]), "example", "required"),
    (error: unknown) => error instanceof PiModelUnavailableError &&
      /Pinned Pi model\/capabilities no longer available/.test(error.message));
  await assert.rejects(configurePiPolicy(job, policy({ profile: { provider: "example", model: "other" } })),
    /pinned/);
  const other = await fixture();
  await configurePiPolicy(other.job, policy({ profile: { provider: "example", model: "required", thinking: "high" } }));
  await assert.rejects(resolvePiModel(other.job, runtime(["required"], false), "example", "required", "high"),
    /Required Pi model\/capabilities unavailable/);
  const configured = await resolvePiModel(other.job, runtime(["required"]), "openai", "gpt-6-luna");
  assert.equal(configured.model.id, "required");
  assert.equal(configured.resolution.thinking, "high");
});

test("a brand-new Story record is not presented as required pre-write context", async () => {
  const { job, project } = await fixture();
  const context = await preparePiContext(job, project,
    options(job, "new-foundation", [], "foundation:write"), runtime());
  assert.doesNotMatch(context.contextNote, /Use story_context with \{\} before writing/);
  assert.match(context.contextNote, /Starting a fresh scoped specialist conversation/);
});

test("completed related sessions fork the saved prefix into their own work-item transcripts", async () => {
  const { job, project } = await fixture();
  const first = await preparePiContext(job, project, options(job, "first"), runtime());
  first.manager.appendMessage({ role: "user", content: "Persisted context marker", timestamp: Date.now() });
  const file = first.manager.getSessionFile()!;
  await first.beforeTurn(file);
  await first.completed(file, first.manager.getSessionId());
  const second = await preparePiContext(job, project, options(job, "second"), runtime());
  assert.notEqual(second.manager.getSessionId(), first.manager.getSessionId());
  assert.match(second.manager.getSessionFile()!, /event-sessions\/second\//);
  assert.match(readFileSync(second.manager.getSessionFile()!, "utf8"), /Persisted context marker/);
  assert.match(second.contextNote, /Continuing a related specialist conversation/);
  await second.beforeTurn(second.manager.getSessionFile()!);
  await second.completed(second.manager.getSessionFile()!, second.manager.getSessionId());
  const reopened = await startStoryJob({ story: job.storyRoot, job: "policy" }, false);
  assert.equal(reopened.baseSha, job.baseSha);
  assert.equal((await inspectPiPolicy(reopened)).budget.steps, 2);
  assert.equal(git(reopened.worktreeRoot, "rev-parse", "HEAD"), job.baseSha);
});

test("one Blueprint review cycle retains its independent Pi transcript across correction rounds", async () => {
  const { job, project } = await fixture();
  const directory = join(job.stateDir, "architecture-blueprint-review-sessions");
  const review = () => ({
    ...options(job, "blueprint-review-cycle:scope-pinned", [],
      "blueprint-review-cycle:scope-pinned"), directory,
  });
  const first = await preparePiContext(job, project, review(), runtime());
  first.manager.appendMessage({
    role: "user", content: "Prior review confidential finding", timestamp: Date.now(),
  });
  const firstFile = first.manager.getSessionFile()!;
  await first.completed(firstFile, first.manager.getSessionId());
  const second = await preparePiContext(job, project, review(), runtime());
  const secondFile = second.manager.getSessionFile()!;
  assert.equal(second.manager.getSessionId(), first.manager.getSessionId());
  assert.equal(secondFile, firstFile);
  assert.match(secondFile, /architecture-blueprint-review-sessions\//);
  assert.match(second.contextNote, /Continuing a related specialist conversation/);
  assert.match(readFileSync(secondFile, "utf8"), /Prior review confidential finding/,
    "same reviewer must retain its earlier findings");
  second.manager.appendMessage({
    role: "user", content: "Second independent review", timestamp: Date.now(),
  });
  await second.completed(secondFile, second.manager.getSessionId());
  const third = await preparePiContext(job, project, review(), runtime());
  assert.equal(third.manager.getSessionId(), second.manager.getSessionId());
  assert.equal(third.manager.getSessionFile(), secondFile);
  assert.match(readFileSync(secondFile, "utf8"), /Second independent review/);
});


test("#210 accepted protocol-fresh FAIL restores context and continues the same reviewer on corrected commit", async () => {
  const { job, project } = await fixture();
  const cycleId = "a".repeat(64);
  const snapshot = "snapshot-1";
  const directory = join(job.stateDir, "review-sessions", "assignment-fidelity", "protocol-fresh");
  const group = "assignment-fidelity:" + cycleId + ":protocol-fresh";
  const base = { group, paths: [], snapshot, provider: "example", model: "required",
    directory };
  // Exact crash window: response and protocol receipt already accepted, but
  // preparePiContext.completed() never ran. Nothing has written a context receipt.
  const first = await preparePiContext(job, project,
    { ...base, step: "assignment-fidelity:initial:protocol-fresh" }, runtime());
  first.manager.appendMessage({ role: "user",
    content: "Review the immutable first packet", timestamp: Date.now() });
  first.manager.appendMessage({ role: "assistant", content: [{
    type: "text", text: "FAIL: unsupported Character knowledge; correct this exact Event",
  }], stopReason: "stop", timestamp: Date.now() });
  const session = { file: first.manager.getSessionFile()!, id: first.manager.getSessionId() };
  const contextReceipt = join(job.stateDir, "pi-contexts", createHash("sha256")
    .update(group).digest("hex") + ".json");
  assert.equal(existsSync(contextReceipt), false, "the accepted fallback has no saved context");
  await assert.rejects(preparePiContext(job, project,
    { ...base, step: "assignment-fidelity:corrected", resumeSession: session },
    runtime()), /Cannot resume sealed Pi session/);
  await restoreAcceptedPiReviewContext(job, project,
    { cycleId, snapshot, session });
  const saved = readFileSync(contextReceipt, "utf8");
  assert.match(saved, /protocol-fresh/);
  // A second recovery cannot rewrite a previously sealed context receipt.
  await restoreAcceptedPiReviewContext(job, project, { cycleId, snapshot, session });
  assert.equal(readFileSync(contextReceipt, "utf8"), saved);
  const resumed = await preparePiContext(job, project,
    { ...base, step: "assignment-fidelity:corrected", resumeSession: session },
    runtime());
  assert.equal(resumed.manager.getSessionId(), session.id);
  assert.equal(resumed.manager.getSessionFile(), session.file);
  assert.match(readFileSync(session.file, "utf8"), /unsupported Character knowledge/);
  resumed.manager.appendMessage({ role: "user",
    content: "Re-review the corrected source-bound packet", timestamp: Date.now() });
  resumed.manager.appendMessage({ role: "assistant", content: [{
    type: "text", text: "PASS: the originally rejected knowledge is now limited",
  }], stopReason: "stop", timestamp: Date.now() });
  await resumed.completed(session.file, session.id);
  const third = await preparePiContext(job, project,
    { ...base, step: "assignment-fidelity:next-correction", resumeSession: session },
    runtime());
  assert.equal(third.manager.getSessionId(), session.id);
  assert.match(readFileSync(session.file, "utf8"), /originally rejected knowledge is now limited/);
  await assert.rejects(restoreAcceptedPiReviewContext(job, project,
    { cycleId, snapshot: "changed-snapshot", session }), /conflicts with an existing Pi context/);
  await assert.rejects(restoreAcceptedPiReviewContext(job, project,
    { cycleId, snapshot, session: { ...session, id: "forged" } }),
    /transcript identity differs/);
});

test("changed source versions supersede prior context and significant redesign restarts", async () => {
  const { job, project } = await fixture();
  const paths = ["events/test.md", "arcs/test.md"];
  const first = await preparePiContext(job, project, options(job, "first", paths), runtime());
  first.manager.appendMessage({ role: "user", content: "OUTDATED MEMORY", timestamp: Date.now() });
  await first.completed(first.manager.getSessionFile()!, first.manager.getSessionId());
  writeFileSync(join(job.worktreeStoryRoot, "events", "test.md"), "Revised Event.\n");
  git(job.worktreeRoot, "add", ".");
  git(job.worktreeRoot, "commit", "-qm", "Updated Event");
  const second = await preparePiContext(job, project, options(job, "second", paths), runtime());
  assert.match(second.contextNote, /Changed\/new source paths/);
  assert.match(second.contextNote, /events\/test.md/);
  assert.match(second.contextNote, /OUTDATED MEMORY|Continuing a related specialist conversation/);
  await second.completed(second.manager.getSessionFile()!, second.manager.getSessionId());
  writeFileSync(join(job.worktreeStoryRoot, "arcs", "test.md"), "Major architecture redesign.\n");
  git(job.worktreeRoot, "add", ".");
  git(job.worktreeRoot, "commit", "-qm", "Replan Arc");
  const third = await preparePiContext(job, project, options(job, "third", paths), runtime());
  assert.match(third.contextNote, /Starting a fresh scoped specialist conversation/);
  third.manager.appendMessage({ role: "user", content: "New clean context", timestamp: Date.now() });
  assert.doesNotMatch(readFileSync(third.manager.getSessionFile()!, "utf8"), /OUTDATED MEMORY/);
});

test("Pi tracks successfully read Story sources beyond the initial assignment manifest", async () => {
  const { job, project } = await fixture();
  const first = await preparePiContext(job, project, options(job, "first"), runtime());
  first.manager.appendMessage({ role: "assistant", content: [{
    type: "toolCall", id: "read-arc-1", name: "read", arguments: { path: "arcs/test.md" },
  }], stopReason: "toolUse", timestamp: Date.now() } as Parameters<typeof first.manager.appendMessage>[0]);
  first.manager.appendMessage({ role: "toolResult", toolCallId: "read-arc-1",
    toolName: "read", content: [{ type: "text", text: "Initial Arc." }],
    isError: false, timestamp: Date.now() } as Parameters<typeof first.manager.appendMessage>[0]);
  await first.completed(first.manager.getSessionFile()!, first.manager.getSessionId());
  writeFileSync(join(job.worktreeStoryRoot, "arcs", "test.md"), "Changed after original read.\n");
  git(job.worktreeRoot, "add", ".");
  git(job.worktreeRoot, "commit", "-qm", "Arc revision");
  const second = await preparePiContext(job, project, options(job, "second"), runtime());
  assert.match(second.contextNote, /arcs\/test.md/);
  assert.match(second.contextNote, /Starting a fresh scoped specialist conversation/);
});

test("forked Pi transcripts do not double-charge already counted model calls", async () => {
  const { job, project } = await fixture();
  const first = await preparePiContext(job, project, options(job, "first"), runtime());
  first.manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "First model turn" }],
    api: "openai-completions", provider: "example", model: "required",
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
      cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.2 } },
    stopReason: "stop", timestamp: Date.now() } as Parameters<typeof first.manager.appendMessage>[0]);
  await first.completed(first.manager.getSessionFile()!, first.manager.getSessionId());
  const second = await preparePiContext(job, project, options(job, "second"), runtime());
  await second.completed(second.manager.getSessionFile()!, second.manager.getSessionId());
  const result = (await inspectPiPolicy(job)).budget;
  assert.equal(result.modelCalls, 1);
  assert.ok(Math.abs(result.costUsd - 0.2) < 0.001);
});

test("Pi usage exposes token breakdown and missing price provenance from one deduplicated transcript", async () => {
  const { job } = await fixture();
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const manager = SessionManager.create(job.worktreeStoryRoot,
    join(dirname(job.worktreeRoot), "event-sessions", "metered"));
  const turn = (usage: object) => manager.appendMessage({ role: "assistant",
    content: [{ type: "text", text: "Completed" }], api: "openai-completions",
    provider: "example", model: "required", usage, stopReason: "stop",
    timestamp: Date.now() } as Parameters<typeof manager.appendMessage>[0]);
  turn({ input: 12, output: 6, cacheRead: 4, cacheWrite: 2,
    totalTokens: 24, cost: { total: 0.25 } });
  turn({ input: 2, output: 3, cacheRead: 0, cacheWrite: 0,
    totalTokens: 5 });
  await guardPiBudget(job, "first", manager.getSessionFile()!);
  const summary = (await inspectPiPolicy(job)).budget;
  assert.equal(summary.modelCalls, 2);
  assert.equal(summary.costUsd, 0.25);
  assert.equal(summary.unpricedCalls, 1);
  assert.deepEqual(summary.tokens,
    { input: 14, output: 9, cacheRead: 4, cacheWrite: 2, total: 29 });
  assert.equal(summary.unknownTokenCalls, 0);
});

test("related Arc work reuses the cache-compatible prefix without sharing an unrelated Arc", async () => {
  const { job, project } = await fixture();
  const role = "event";
  const groupA = piNarrativeGroup(role, ["arcs/test.md", "events/test.md"], "milestone.first");
  const groupAgain = piNarrativeGroup(role, ["arcs/test.md", "events/another.md"], "milestone.second");
  const groupOther = piNarrativeGroup(role, ["arcs/other.md"], "milestone.third");
  assert.equal(groupA, groupAgain);
  assert.notEqual(groupA, groupOther);
  const first = await preparePiContext(job, project, options(job, "first", ["arcs/test.md"], groupA), runtime());
  first.manager.appendMessage({ role: "user", content: "Arc-specific historical plan", timestamp: Date.now() });
  await first.completed(first.manager.getSessionFile()!, first.manager.getSessionId());
  const second = await preparePiContext(job, project, options(job, "second", ["arcs/test.md"], groupAgain), runtime());
  assert.match(second.contextNote, /Continuing a related specialist conversation/);
  assert.match(readFileSync(second.manager.getSessionFile()!, "utf8"), /Arc-specific historical plan/);
  const unrelated = await preparePiContext(job, project, options(job, "third", ["arcs/other.md"], groupOther), runtime());
  assert.match(unrelated.contextNote, /Starting a fresh scoped specialist conversation/);
});

test("nested review does not budget-pause inside the uncommitted authoring step", async () => {
  const { job, project } = await fixture();
  await configurePiPolicy(job, policy({ limits: { steps: 1 } }));
  const writer = await preparePiContext(job, project, options(job, "write"), runtime());
  writer.manager.appendMessage({ role: "user", content: "uncommitted active writer", timestamp: Date.now() });
  await assert.rejects(preparePiContext(job, project, options(job, "review"), runtime()), PiBudgetPause);
  const review = await preparePiContext(job, project, {
    ...options(job, "review", [], "composition:review"), insideWriter: true,
  }, runtime());
  await review.beforeTurn();
  assert.equal((await inspectPiPolicy(job)).budget.steps, 1);
});

test("cost budgets pause if Pi returns usage but omits the call price", async () => {
  const { job } = await fixture();
  await configurePiPolicy(job, policy({ limits: { costUsd: 1 } }));
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const manager = SessionManager.create(job.worktreeStoryRoot, join(dirname(job.worktreeRoot), "unpriced"));
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Unpriced call" }],
    api: "openai-completions", provider: "example", model: "required",
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
    stopReason: "stop", timestamp: Date.now() } as Parameters<typeof manager.appendMessage>[0]);
  await assert.rejects(guardPiBudget(job, "step:second", manager.getSessionFile()!),
    (e: unknown) => e instanceof PiBudgetPause && e.reason === "cost-unavailable");
});

test("model-call and cost limits use persisted Pi transcript usage and resume without resetting counters", async () => {
  const { job } = await fixture();
  await configurePiPolicy(job, policy({ limits: { modelCalls: 1, costUsd: 0.4 } }));
  const first = await guardPiBudget(job, "step:first");
  assert.equal(first, undefined);
  // Pi's durable transcript contains the actual provider usage and cost.
  const dir = join(dirname(job.worktreeRoot), "event-sessions", "usage");
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const manager = SessionManager.create(job.worktreeStoryRoot, dir);
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Done" }],
    api: "openai-completions", provider: "example", model: "required",
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0,
      totalTokens: 15, cost: { input: 0.3, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.5 } },
    stopReason: "stop", timestamp: Date.now() } as Parameters<typeof manager.appendMessage>[0]);
  await assert.rejects(guardPiBudget(job, "step:second", manager.getSessionFile()!), PiBudgetPause);
  const inspected = await inspectPiPolicy(job);
  assert.ok(inspected.budget.modelCalls >= 1);
  assert.ok(inspected.budget.costUsd >= 0.5);
  await configurePiPolicy(job, policy({ limits: { modelCalls: 2, costUsd: 1 } }));
  await guardPiBudget(job, "step:second");
  assert.equal((await inspectPiPolicy(job)).budget.steps, 2);
  assert.equal(new PiBudgetPause("steps", inspected.budget).name, "PiBudgetPause");
});

test("active generation time is cumulative across runs but excludes author-approval waiting", async () => {
  const { job } = await fixture();
  await configurePiPolicy(job, policy({ limits: { activeSeconds: 0.2 } }));
  // A first real execution segment runs normally and is durably accounted.
  await withActiveExecutionTime(job, async () => {
    await guardPiBudget(job, "step:one");
    await delay(80);
  });
  const first = (await inspectPiPolicy(job)).budget.activeSeconds;
  assert.ok(first >= 0.07 && first < 0.2, String(first));
  const before = readFileSync(join(job.stateDir, "pi-active-time.json"), "utf8");
  assert.ok(JSON.parse(before).elapsedMs > 0);
  // The worker has returned to an author decision and is no longer running.
  await delay(270);
  assert.ok(Math.abs((await inspectPiPolicy(job)).budget.activeSeconds - first) < 0.01,
    "approval waiting must not consume an active-time budget");
  // A subsequent worker invocation (possibly after process restart) reads the
  // accumulated durable meter rather than resetting the job's budget.
  await withActiveExecutionTime(job, async () => {
    await delay(165);
    await assert.rejects(guardPiBudget(job, "step:two"),
      (error: unknown) => error instanceof PiBudgetPause && error.reason === "activeSeconds");
  });
  const exhausted = await inspectPiPolicy(job);
  assert.equal(exhausted.budget.pause?.reason, "activeSeconds");
  assert.ok(exhausted.budget.activeSeconds >= 0.2);
  await configurePiPolicy(job, policy({ limits: { activeSeconds: 2 } }));
  await guardPiBudget(job, "step:two");
  assert.ok((await inspectPiPolicy(job)).budget.activeSeconds >= exhausted.budget.activeSeconds);
});

test("job ceilings reject invalid, injected or nonfinite resource authority", async () => {
  assert.deepEqual(parseJobLimits({ cpu: 1.5, memoryMiB: 1024, pids: 256,
    activeSeconds: 10 }), { cpu: 1.5, memoryMiB: 1024, pids: 256, activeSeconds: 10 });
  for (const limits of [{ cpu: 0 }, { memoryMiB: 1 }, { pids: 2 }, { activeSeconds: -1 },
    { activeSeconds: NaN }, { cpu: Infinity }, { cpu: 65 }, { memoryMiB: "512" },
    { pids: 200, privileged: true }]) {
    assert.throws(() => parseJobLimits(limits), /Budget limit|Unsupported job budget/);
  }
  const { job } = await fixture();
  await assert.rejects(configurePiPolicy(job,
    policy({ limits: { pids: 200, privileged: true } as PiPolicy["limits"] })),
    /Unsupported job budget/);
});
