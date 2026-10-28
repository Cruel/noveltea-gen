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
import { processAuthorUpdatesAfterWork } from "./author-updates.js";
import { startStoryJob, type JobStartResult } from "./job.js";
import { withStoryGenerationLock, withStoryJobLock } from "./job-lock.js";
import { inspectJobReport } from "./job-report.js";
import { trustedHead } from "./revision.js";

export const generationStages = ["foundation", "architecture", "foundations", "event", "interactive", "composition", "review"] as const;
type Stage = typeof generationStages[number];
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
export interface GenerationEvidence { stage: Stage; headSha: string; status: string }
const Channels = Annotation.Root({
  request: Annotation<GenerationRequest>(),
  cursor: Annotation<number>({ reducer: (_, next) => next, default: () => 0 }),
  completedStages: Annotation<GenerationEvidence[]>({ reducer: (_, next) => next, default: () => [] }),
  status: Annotation<Status>(),
  reason: Annotation<string | null>(),
  result: Annotation<{ status: string } | null>(),
  planVersion: Annotation<number | null>(),
  pauseAfter: Annotation<Stage | null>(),
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
  if (contract.scope.kind !== "partial" || contract.scope.targets.filter(x => x.startsWith("milestone.")).length !== 1 ||
      contract.scope.targets.filter(x => x.startsWith("arc.")).length > 1) {
    throw new Error("Generation requires partial scope with exactly one Milestone and at most one Arc; multi-Milestone scheduling is not supported.");
  }
  return contract;
}
function stages(s: State): readonly Stage[] {
  const depth = s.request.contract.scope.depth;
  return depth === "architecture" ? ["foundation", "architecture", "review"] :
    depth === "interactive" ? ["foundation", "architecture", "foundations", "event", "interactive", "review"] : generationStages;
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
      version != null && receipt.plan.version !== version))
    throw new Error("Stale generation authorization: the approved plan differs from this run's pinned completion contract. Inspect and explicitly replan; no writer was replayed.");
  return receipt.plan?.version ?? null;
}
async function dispatch(s: State) {
  const input = s.request;
  const milestone = input.contract.scope.targets.find(x => x.startsWith("milestone."))!;
  switch (stages(s)[s.cursor]) {
    case "foundation": return runFoundationJob({ ...input, envelope: JSON.stringify(input.contract.envelope) });
    case "architecture": return runArchitectureJob({ ...input, action: "run" });
    case "foundations": return runCharacterWorldJob({ ...input, action: "run" });
    case "event": return runEventWorkItem({ ...input, milestone, action: "run" });
    case "interactive": return runInteractiveWorkItem({ ...input, milestone, action: "run" });
    case "composition": return runCompositionWorkItem({ ...input, milestone, action: "run" });
    case "review": return runNarrativeReview({ ...input, action: "run" });
    default: throw new Error("Invalid generation stage.");
  }
}
const accepted: Record<Stage, readonly string[]> = {
  foundation: ["committed"], architecture: ["architecture-committed", "complete-in-scope"],
  foundations: ["foundations-committed"], event: ["event-cluster-committed"],
  interactive: ["interactive-slice-committed"], composition: ["composition-committed"],
  review: ["complete-in-scope", "editorial-unverified", "blocked"],
};
function blocked(error: unknown): Partial<State> {
  const e = error as { message?: string; name?: string };
  return { status: e.name === "PiBudgetPause" ? "paused" : "blocked", reason: e.message ?? String(error), result: null };
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
      return { status: "running" as const, reason: null };
    })
    .addNode("author_update_intake", async s => {
      const job = await openJob(s);
      return withStoryJobLock(job, "generation-boundary", async () => {
        try {
          const stopped = await authorBoundary(job);
          if (stopped) return stopped;
          const planVersion = await checkPlan(job, s.request, s.planVersion);
          return { planVersion };
        } catch (error) { return blocked(error); }
      });
    })
    .addNode("specialist_dispatch", async s => {
      // A saved dispatch result means the external stage completed before a parent
      // verification checkpoint. Otherwise the stage API reconciles its receipt,
      // including a commit published before its receipt; never invent a new writer.
      if (s.result) return {};
      try { return { result: await dispatch(s) }; }
      catch (error) { return blocked(error); }
    })
    .addNode("verify_committed_work", async s => {
      const job = await openJob(s);
      return withStoryJobLock(job, "generation-verification", async () => {
        try {
          clean(job);
          const headSha = await trustedHead(job);
          const planVersion = await checkPlan(job, s.request, s.planVersion);
          const stage = stages(s)[s.cursor]!;
          if (!s.result || !accepted[stage].includes(s.result.status))
            return { status: "blocked" as const, reason: s.result?.status ?? "Missing specialist result", result: null };
          return { cursor: s.cursor + 1, result: null, planVersion,
            completedStages: [...s.completedStages, { stage, headSha, status: s.result.status }],
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
            reason: complete ? null : s.completedStages.at(-1)?.status ?? "Scope remains unverified" };
        } catch (error) { return blocked(error); }
      });
    })
    .addEdge(START, "schedule")
    .addEdge("schedule", "author_update_intake")
    .addConditionalEdges("author_update_intake", s => s.status !== "running" ? END :
      s.cursor >= stages(s).length ? "completion_decision" : "specialist_dispatch")
    .addConditionalEdges("specialist_dispatch", s => s.status !== "running" ? END : "verify_committed_work")
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
      const config = { configurable: { thread_id: job.threadId + ":generation" }, recursionLimit: 100 };
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
          pauseAfter: options.pauseAfter ?? null };
      } else {
        if (!state.request) throw new Error("No saved generation request.");
        if (state.request.story !== job.storyRoot || state.request.job !== job.jobId)
          throw new Error("Generation checkpoint belongs to a different Story job.");
        if (options.task !== undefined || options.contract !== undefined || options.fixture !== undefined ||
            options.skillsSource !== undefined || options.validatorSource !== undefined ||
            options.provider !== undefined || options.model !== undefined)
          throw new Error("Resume/inspect use the pinned generation request; new worker inputs are forbidden.");
      }
      if (options.action !== "inspect") {
        // Always re-enter the safe boundary, even after an interrupted graph node.
        // The saved cursor/result and specialist receipts reconcile external effects.
        state = await graph.invoke({ ...state, pauseAfter: options.pauseAfter ?? null }, config);
      }
      const report = await inspectJobReport({ story: job.storyRoot, job: job.jobId });
      let current: Partial<State> = {};
      if (options.action === "inspect") {
        current = await withStoryJobLock(job, "generation-inspect", async () => {
          try {
            clean(job);
            await checkPlan(job, state.request, state.planVersion);
            if (state.cursor > 0) await trustedHead(job);
            if (state.status === "completed" && report.generation.status !== "completed")
              throw new Error("Saved completion is no longer current; inspect the source-linked job report.");
            return {};
          } catch (error) { return blocked(error); }
        });
      }
      return { schema: "noveltea-generation/v1", status: current.status ?? state.status,
        reason: current.reason ?? state.reason, checkpointStatus: state.status,
        jobId: job.jobId, threadId: config.configurable.thread_id, checkpointPath: path,
        nextStage: stages(state)[state.cursor] ?? null, completedStages: state.completedStages,
        pendingNodes: (await graph.getState(config)).next, request: state.request, report };
    } finally { saver.db.close(); }
  });
}
