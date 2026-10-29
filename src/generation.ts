import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { parseContract, runArchitectureJob, verifyPlanHistory, type CompletionContract } from "./architecture.js";
import { runFoundationJob } from "./foundation.js";
import { runCharacterWorldJob } from "./character-world.js";
import { runEventWorkItem } from "./event-work.js";
import { runInteractiveWorkItem } from "./interactive-work.js";
import { runCompositionWorkItem } from "./composition-work.js";
import { runNarrativeReview } from "./narrative-review.js";
import { runFocusedWorkItem } from "./focused-work.js";
import { isFocusedScope } from "./focused-scope.js";
import { processAuthorUpdatesAfterWork } from "./author-updates.js";
import { startStoryJob, type JobStartResult } from "./job.js";
import { withStoryGenerationLock, withStoryJobLock } from "./job-lock.js";
import { readJobControl } from "./job-control.js";
import { inspectJobReport } from "./job-report.js";
import { trustedHead } from "./revision.js";
import { validateStoryJob } from "./validator.js";
import { hasPlanContinuity } from "./plan-continuity.js";
import { generationStages, reconcileInventory, nextExecutionItem, type GenerationStage as Stage,
  type GenerationEvidence, type GenerationInventory, type ExecutionItem } from "./generation-plan.js";
export { generationStages, type GenerationEvidence } from "./generation-plan.js";

export interface GenerationRequest {
  story: string; job: string; task: string; contract: CompletionContract;
  fixture: boolean; skillsSource?: string; validatorSource?: string;
  provider?: string; model?: string;
}
export interface GenerationOptions {
  story: string; job: string; action: "start" | "resume" | "inspect";
  task?: string; contract?: unknown; fixture?: boolean; skillsSource?: string;
  validatorSource?: string; provider?: string; model?: string; pauseAfter?: Stage;
}
type Status = "running" | "paused" | "blocked" | "cancelled" | "completed";
const Channels = Annotation.Root({
  request: Annotation<GenerationRequest>(),
  cursor: Annotation<number>({ reducer: (_, next) => next, default: () => 0 }),
  completedStages: Annotation<GenerationEvidence[]>({ reducer: (_, next) => next, default: () => [] }),
  status: Annotation<Status>(),
  reason: Annotation<string | null>(),
  result: Annotation<{ status: string; headSha?: string } | null>(),
  planVersion: Annotation<number | null>(),
  pauseAfter: Annotation<Stage | null>(),
  inventory: Annotation<GenerationInventory | null>(),
  active: Annotation<ExecutionItem | null>(),
  failures: Annotation<Record<string, string>>(),
});
type State = typeof Channels.State;
const openJob = (s: State) => startStoryJob({ story: s.request.story, job: s.request.job }, false);
function clean(job: JobStartResult) {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[key];
  if (execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: job.worktreeRoot, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim()) throw new Error("Unexpected dirty job worktree; inspect preserved specialist edits before resuming.");
}
export function parseGenerationContract(value: unknown): CompletionContract {
  const contract = parseContract(value);
  if (contract.scope.kind === "partial" && !contract.scope.targets.length)
    throw new Error("Partial generation requires explicit typed Story record targets.");
  return contract;
}
async function checkPlan(job: JobStartResult, request: GenerationRequest, version: number | null | undefined) {
  const file = join(dirname(job.worktreeRoot), "architecture.json");
  if (!existsSync(file)) {
    if (version != null) throw new Error("Pinned architecture receipt is missing; restore it before resuming.");
    return null;
  }
  const receipt = JSON.parse(await readFile(file, "utf8"));
  verifyPlanHistory(job, receipt);
  if (receipt.plan && (JSON.stringify(receipt.plan.contract) !== JSON.stringify(request.contract) ||
      version != null && receipt.plan.version !== version)) {
    const original = receipt.history.find((entry: any) => entry.plan.version === (version ?? 1));
    if (!original || JSON.stringify(original.plan.contract) !== JSON.stringify(request.contract))
      throw new Error("Stale generation authorization: no signed transition from the pinned completion contract.");
  }
  return receipt;
}
async function reconcile(s: State, job: JobStartResult): Promise<Partial<State>> {
  const receipt = await checkPlan(job, s.request, s.planVersion);
  const plan = receipt?.plan;
  const request = plan ? { ...s.request, contract: plan.contract } : s.request;
  const head = await trustedHead(job);
  // Failed specialists own persistent recovery receipts. Later commits from
  // independent clusters do not permit replay against a changed HEAD.
  // A new authorized plan is the boundary for reconsidering local failures.
  const failures = s.inventory?.planVersion === (plan?.version ?? null) ? s.failures ?? {} : {};
  let completedStages = s.completedStages.filter(e => {
    if (e.stage === "foundation" || !plan) return true;
    if (e.stage === "architecture") return receipt.phase === "committed";
    const version = e.planVersion ?? s.planVersion ?? 1;
    if (e.stage === "review") return version === plan.version && e.headSha === head;
    return hasPlanContinuity(job, receipt, e.milestone ? `${e.stage}:${e.milestone}` : e.stage, version);
  });
  // A focused request starts from committed canonical Story context. Never
  // dispatch whole-Story discovery to fill a missing prerequisite implicitly.
  if (isFocusedScope(request.contract) && !completedStages.some(e => e.stage === "foundation")) {
    const baseline = await validateStoryJob(job, request.validatorSource ?? request.skillsSource,
      { ...job, baseSha: head });
    const report = baseline.report as { readiness?: { design?: { stages?: {
      foundation?: { minimum?: string } } } }; protection?: { status?: string; changes?: unknown[]; warnings?: unknown[] } } | undefined;
    if (baseline.status !== "passed" || report?.readiness?.design?.stages?.foundation?.minimum !== "passed" ||
        report?.protection?.status !== "checked" || report.protection.changes?.length || report.protection.warnings?.length)
      throw new Error("Focused scope is missing verified upstream Creative Direction or protected canonical context. " +
        "Author must supply or authorize prerequisite development; whole-Story foundation will not run automatically.");
    completedStages = [{ stage: "foundation", headSha: head, status: "committed" }, ...completedStages];
  }
  // A signed plan revision may require another architecture unit before downstream work.
  if (plan && receipt.phase !== "committed") {
    const inventory = reconcileInventory(plan, undefined, head, completedStages,
      failures, s.inventory);
    return { request, planVersion: plan.version, completedStages, failures, inventory, active: nextExecutionItem(inventory) ?? null };
  }
  const validation = plan && completedStages.some(e => e.stage === "architecture")
    ? await validateStoryJob(job, request.validatorSource ?? request.skillsSource, { ...job, baseSha: head }) : undefined;
  const inventory = reconcileInventory(plan, validation, head, completedStages, failures, s.inventory);
  return { request, planVersion: plan?.version ?? null, completedStages, failures, inventory, active: nextExecutionItem(inventory) ?? null };
}
async function dispatch(s: State) {
  const input = s.request;
  const milestone = s.active?.milestone!;
  switch (s.active?.stage) {
    case "foundation": return runFoundationJob({ ...input, envelope: JSON.stringify(input.contract.envelope) });
    case "architecture": return runArchitectureJob({ ...input, action: "run" });
    case "foundations": return runCharacterWorldJob({ ...input, action: "run" });
    case "event": return runEventWorkItem({ ...input, milestone, action: "run" });
    case "interactive": return runInteractiveWorkItem({ ...input, milestone, action: "run" });
    case "composition": return runCompositionWorkItem({ ...input, milestone, action: "run" });
    case "focus": return runFocusedWorkItem({ ...input, target: milestone, task: input.task });
    case "review": return runNarrativeReview({ ...input, action: "run" });
    default: throw new Error("Invalid generation stage.");
  }
}
const accepted: Record<Stage, readonly string[]> = {
  foundation: ["committed"], architecture: ["architecture-committed", "complete-in-scope"],
  foundations: ["foundations-committed"], event: ["event-cluster-committed"],
  interactive: ["interactive-slice-committed"], composition: ["composition-committed"],
  focus: ["focused-committed"],
  review: ["complete-in-scope", "editorial-unverified", "blocked"],
};
function blocked(error: unknown): Partial<State> {
  const e = error as { message?: string; name?: string };
  return { status: e.name === "PiBudgetPause" ? "paused" : e.name === "StoryCancelledError" ? "cancelled" : "blocked",
    reason: e.message ?? String(error), result: null };
}
async function authorBoundary(job: JobStartResult): Promise<Partial<State> | null> {
  const updates = await processAuthorUpdatesAfterWork(job);
  if (updates.status === "ready") return null;
  return { status: updates.status === "paused" ? "paused" : updates.status === "cancelled" ? "cancelled" : "blocked",
    reason: updates.blockers.join(", ") + ("error" in updates ? ": " + updates.error : "") };
}
/** The production parent graph. Specialists retain ownership of side effects and recovery. */
export function createGenerationGraph(checkpointer?: SqliteSaver) {
  return new StateGraph(Channels)
    .addNode("schedule", async s => {
      parseGenerationContract(s.request.contract);
      if (!s.request.task?.trim()) throw new Error("Generation requires an explicit objective.");
      return { status: "running" as const, reason: null, failures: s.failures ?? {} };
    })
    .addNode("author_update_intake", async s => {
      const job = await openJob(s);
      return withStoryJobLock(job, "generation-boundary", async () => {
        try {
          const stopped = await authorBoundary(job);
          if (stopped) return stopped;
          const receipt = await checkPlan(job, s.request, s.planVersion);
          // Preserve an in-flight result. For interrupted external effects, only the
          // original specialist may reconcile the dirty/unpublished work boundary.
          if (s.active && (receipt?.plan?.version ?? null) === s.planVersion) {
            if (s.result) return {};
            try { clean(job); await trustedHead(job); } catch { return {}; }
          }
          if (s.result) throw new Error("Plan changed with an unverified dispatch result; reconcile the original assignment first.");
          clean(job);
          return await reconcile(s, job);
        } catch (error) { return blocked(error); }
      });
    })
    .addNode("specialist_dispatch", async s => {
      // A saved dispatch result means the external stage completed before a parent
      // verification checkpoint. Otherwise the stage API reconciles its receipt,
      // including a commit published before its receipt; never invent a new writer.
      if (s.result) return {};
      try { return { result: await dispatch(s) }; }
      catch (error) {
        const stop = blocked(error);
        if (stop.status === "paused" || stop.status === "cancelled") return stop;
        const job = await openJob(s);
        return withStoryJobLock(job, "generation-local-block", async () => {
          try { clean(job); await trustedHead(job); }
          catch { return stop; }
          return { failures: { ...s.failures, [s.active!.id]: stop.reason! }, active: null, result: null };
        });
      }
    })
    .addNode("verify_committed_work", async s => {
      const job = await openJob(s);
      return withStoryJobLock(job, "generation-verification", async () => {
        try {
          clean(job);
          const headSha = await trustedHead(job);
          const receipt = await checkPlan(job, s.request, s.planVersion);
          const planVersion = receipt?.plan?.version ?? null;
          const stage = s.active!.stage;
          if (!s.result || !accepted[stage].includes(s.result.status))
            return { failures: { ...s.failures, [s.active!.id]: s.result?.status ?? "Missing specialist result" },
              active: null, result: null };
          const completedStages = [...s.completedStages, { stage, milestone: s.active?.milestone,
            headSha: s.result.headSha ?? headSha, status: s.result.status, planVersion: planVersion ?? undefined }];
          const next = await reconcile({ ...s, completedStages, active: null, result: null, planVersion }, job);
          return { ...next, cursor: s.cursor + 1, result: null,
            ...(s.pauseAfter === stage ? { status: "paused" as const, reason: "Requested safe-boundary pause" } : {}) };
        } catch (error) { return blocked(error); }
      });
    })
    .addNode("completion_decision", async s => {
      const job = await openJob(s);
      return withStoryJobLock(job, "generation-completion", async () => {
        try {
          clean(job); await trustedHead(job); await checkPlan(job, s.request, s.planVersion);
          const stopped = await authorBoundary(job);
          if (stopped) return stopped;
          const report = await inspectJobReport(s.request);
          const complete = report.generation.status === "completed";
          return { status: complete ? "completed" as const : "blocked" as const,
            reason: complete ? null : s.inventory?.items.filter(i => i.status !== "verified")
              .map(i => i.stage === "review" ? i.blockingReason ?? "Scope remains unverified" : `${i.id}: ${i.blockingReason ?? "Unresolved dependencies"}`).join("; ") ||
              s.completedStages.at(-1)?.status || "Scope remains unverified" };
        } catch (error) { return blocked(error); }
      });
    })
    .addEdge(START, "schedule")
    .addEdge("schedule", "author_update_intake")
    .addConditionalEdges("author_update_intake", s => s.status !== "running" ? END :
      s.active ? "specialist_dispatch" : "completion_decision")
    .addConditionalEdges("specialist_dispatch", s => s.status !== "running" ? END : s.active ? "verify_committed_work" : "author_update_intake")
    .addConditionalEdges("verify_committed_work", s => s.status !== "running" ? END : "author_update_intake")
    .addEdge("completion_decision", END)
    .compile({ checkpointer });
}

export async function runStoryGeneration(options: GenerationOptions) {
  const job = await startStoryJob({ story: options.story, job: options.job }, false);
  return withStoryGenerationLock(job, async () => {
    const path = join(dirname(job.worktreeRoot), "generation.sqlite");
    if (options.action !== "start" && !existsSync(path)) throw new Error("No generation run exists; use generate start.");
    const saver = SqliteSaver.fromConnString(path);
    try {
      const graph = createGenerationGraph(saver);
      const config = { configurable: { thread_id: job.threadId + ":generation" }, recursionLimit: 10000 };
      const saved = await graph.getState(config);
      let state = saved.values as State;
      if (options.action === "start") {
        if (state.request) throw new Error("Generation already exists; use resume or inspect, never overwrite its contract.");
        if (!options.task?.trim()) throw new Error("Generation start requires --task and --contract.");
        const request: GenerationRequest = { story: job.storyRoot, job: job.jobId, task: options.task,
          contract: parseGenerationContract(options.contract), fixture: options.fixture ?? false,
          skillsSource: options.skillsSource, validatorSource: options.validatorSource,
          provider: options.provider, model: options.model };
        state = { request, cursor: 0, completedStages: [], status: "running", reason: null, result: null, planVersion: null,
          pauseAfter: options.pauseAfter ?? null, inventory: null, active: null, failures: {} };
      } else {
        if (!state.request) throw new Error("No saved generation request.");
        if (state.request.story !== job.storyRoot || state.request.job !== job.jobId)
          throw new Error("Generation checkpoint belongs to a different Story job.");
        if (options.task !== undefined || options.contract !== undefined || options.fixture !== undefined ||
            options.skillsSource !== undefined || options.validatorSource !== undefined ||
            options.provider !== undefined || options.model !== undefined)
          throw new Error("Resume/inspect use the pinned generation request; new worker inputs are forbidden.");
      }
      const cancelled = await readJobControl(job) === "cancelled";
      const cancellation = {
        status: "cancelled" as const,
        reason: "Author cancelled this Story job; inspect the preserved specialist session, receipt and worktree before reconciliation.",
      };
      if (options.action === "start" && cancelled) {
        throw new Error("Cannot start generation for a terminally cancelled Story job.");
      }
      if (options.action !== "inspect") {
        // A terminal cancellation never re-enters a checkpointed dispatch:
        // an unfinished writer's original session and dirty worktree must
        // remain available for explicit, non-destructive reconciliation.
        state = cancelled ? { ...state, ...cancellation } :
          await graph.invoke({ ...state, pauseAfter: options.pauseAfter ?? null }, config);
      }
      const report = await inspectJobReport({ story: job.storyRoot, job: job.jobId });
      let current: Partial<State> = {};
      if (options.action === "inspect") {
        current = cancelled ? cancellation : await withStoryJobLock(job, "generation-inspect", async () => {
          try {
            clean(job);
            await checkPlan(job, state.request, state.planVersion);
            if (state.cursor > 0) await trustedHead(job);
            if (state.status === "completed" && report.generation.status !== "completed")
              throw new Error("Saved completion is no longer current; inspect the source-linked job report.");
            return await reconcile(state, job);
          } catch (error) { return blocked(error); }
        });
      }
      const visible = { ...state, ...current };
      return { schema: "noveltea-generation/v1", status: current.status ?? state.status,
        reason: current.reason ?? state.reason, checkpointStatus: state.status,
        jobId: job.jobId, threadId: config.configurable.thread_id, checkpointPath: path,
        nextStage: visible.active?.stage ?? (visible.inventory ? nextExecutionItem(visible.inventory)?.stage : undefined) ?? null,
        inventory: visible.inventory, selectedWorkItem: visible.active, completedStages: visible.completedStages,
        pendingNodes: (await graph.getState(config)).next, request: visible.request, report };
    } finally { saver.db.close(); }
  });
}
