import { execFileSync } from "node:child_process";
import { readRecoveryFork, verifyReadyRecoveryFork } from "./recovery-fork-state.js";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { load, persist } from "./ideas.js";
import { runIdeaPlacement, scheduleIdeasAtBoundary } from "./idea-placement.js";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { z } from "zod";
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
import { claimServerGeneration, ensureNotServerOwned } from "./generation-owner.js";
import { readJobControl } from "./job-control.js";
import { inspectJobReport, type JobReport } from "./job-report.js";
import { trustedHead } from "./revision.js";
import { inspectRecoveryCheckpoints, reconcileRecoveryCheckpoints } from "./recovery-checkpoints.js";
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
export interface IdeaTask { id: string; action: "place" | "reassess"; signature: string; priorHead: string }
export interface IdeaResult { status: string; commitSha?: string; reason?: string }
export interface IdeaAttempt { signature: string; action: IdeaTask["action"]; status: string; reason?: string; commitSha?: string }
export interface IdeaHistoryEntry extends IdeaAttempt { id: string }
export interface GenerationEscalation {
  kind: "protected-approval" | "dependency-replan" | "targeted-repair";
  sources: Array<{ source: string; message: string; repair: string }>;
  requiresTrustedApproval: boolean;
  action: string;
}
function reviewEscalation(report: JobReport, inventory: GenerationInventory | null): GenerationEscalation | null {
  const sources = [
    ...(report.evidence.scope?.diagnostics ?? inventory?.audit?.diagnostics ?? [])
      .filter(d => d.severity === "blocking" &&
        !(d.code === "unfulfilled-obligation" &&
          report.evidence.deferredIdeas.scopedOutstanding.includes(d.source))).map(d =>
        ({ source: d.source, message: d.message, repair: d.repair })),
    ...report.evidence.editorial.findings.filter(f => f.severity === "blocking").map(f =>
      ({ source: String(f.source), message: String(f.message), repair: String(f.repair) })),
    ...(inventory?.items ?? []).filter(i => i.status === "blocked" && i.stage !== "review" &&
      i.blockingReason && !i.blockingReason.startsWith("Blocked dependency:")).map(i =>
      ({ source: i.id, message: i.blockingReason!, repair: "architecture" })),
  ];
  if (!sources.length) return null;
  const protectedChange = sources.some(s => s.repair === "protected");
  const replan = sources.some(s => ["architecture", "event", "interactive"].includes(s.repair));
  return {
    kind: protectedChange ? "protected-approval" : replan ? "dependency-replan" : "targeted-repair",
    sources, requiresTrustedApproval: protectedChange || replan,
    action: protectedChange
      ? "Protected decisions cannot be edited automatically. Obtain exact trusted-controller authorization through the existing revision/approval workflow."
      : replan
        ? "Affect only the listed source/dependency scope. Propose and obtain a controller-approved architecture/scope revision with explicit carry-forward, or authorize a bounded targeted repair; do not widen coverage automatically."
        : "The narrative reviewer exhausted or could not use its original-writer bounded repair path. Inspect the blocked review and authorize a targeted repair.",
  };
}
const MAX_IDEA_ATTEMPTS = 3;
const ideaDispatchFile = (job: JobStartResult) => join(job.stateDir, "generation-idea-dispatch.json");
function selectIdeaTask(s: State, head: string, tasks: Awaited<ReturnType<typeof scheduleIdeasAtBoundary>>["tasks"],
  next: ExecutionItem | null): IdeaTask | null {
  if (!s.inventory || !s.inventory.items.some(i => i.stage === "architecture" && i.status === "verified") ||
      isFocusedScope(s.request.contract)) return null;
  const scope = new Set(s.inventory.audit?.scopedRecords ?? s.request.contract.scope.targets);
  for (const task of tasks) {
    if (!task.eligible || !task.candidates.length ||
        s.request.contract.scope.kind !== "full-story" && !task.scopeIds.some(id => scope.has(id))) continue;
    const action = task.status === "dormant" ? "place" : task.reviewRequired ? "reassess" : null;
    if (!action || action === "place" && task.candidates.length < 2 && next?.stage !== "review" && next !== null) continue;
    const attempted = s.ideaHistory.filter(h => h.id === task.id);
    if (attempted.length >= MAX_IDEA_ATTEMPTS || attempted.some(a => a.signature === task.signature)) continue;
    return { id: task.id, action, signature: task.signature, priorHead: head };
  }
  return null;
}
/** External graph invocation, distinct from persisted internal checkpoint state.
 * Studio uses this to mark mandatory author inputs as required. The stable
 * state channels below remain available to replay/resume independently. */
export const GenerationInputSchema = z.object({
  request: z.object({
    story: z.string().trim().min(1),
    job: z.string().trim().min(1),
    task: z.string().trim().min(1),
    contract: z.object({
      scope: z.object({
        kind: z.enum(["full-story", "partial"]),
        depth: z.enum(["architecture", "interactive", "composition"]).optional(),
        preset: z.enum(["architecture-outline", "interactive-development", "full-composition"]).optional(),
        targets: z.array(z.string()),
        branches: z.array(z.string()),
        supportingTargets: z.array(z.string()).optional(),
      }).refine(scope => scope.depth !== undefined || scope.preset !== undefined,
        "Provide scope.depth or scope.preset"),
      constraints: z.array(z.string()),
      envelope: z.object({
        presentation: z.string().trim().min(1),
        hardLimits: z.array(z.string()),
        preferences: z.array(z.string()),
      }),
    }),
    fixture: z.boolean().optional(),
    skillsSource: z.string().optional(),
    validatorSource: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
  }),
  pauseAfter: z.enum(generationStages).nullable().optional(),
});

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
  ideaTask: Annotation<IdeaTask | null>(),
  ideaResult: Annotation<IdeaResult | null>(),
  ideaHistory: Annotation<IdeaHistoryEntry[]>({ reducer: (_, next) => next, default: () => [] }),
  escalation: Annotation<GenerationEscalation | null>(),
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
  const file = join(job.stateDir, "architecture.json");
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
      throw new Error("Stale generation authorization: no controller-approved transition from the pinned completion contract.");
  }
  return receipt;
}
/**
 * The parent graph can checkpoint a failure after a child has committed and
 * published its trusted receipt. Clear only that failure when the *current*
 * Git HEAD is independently branchable and the next specialist has never
 * started. This does not repair, discard, or repeat an interrupted writer.
 */
async function reconciledFailures(job: JobStartResult, failures: Record<string, string>) {
  if (!Object.keys(failures).length) return failures;
  const currentHead = await trustedHead(job);
  const point = (await inspectRecoveryCheckpoints(job))
    .find(record => record.eligible && record.commitSha === currentHead);
  if (!point) return failures;
  const retryable = (key: string) => {
    if (key === "foundation" && point.workItem === "foundation" ||
        key === "architecture" && point.workItem === "global-architecture") return true;
    if (key.startsWith("event:milestone.") &&
        point.workItem === "event-" + key.slice("event:milestone.".length)) return true;
    if (key.startsWith("composition:milestone.") &&
        point.workItem === "composition-" + key.slice("composition:milestone.".length)) return true;
    if (key.startsWith("focus:") && key === point.workItem) return true;
    if (key === "foundations" && ["world-foundations", "character-foundations"].includes(point.workItem)) {
      const path = join(job.stateDir, "character-world.json");
      if (!existsSync(path)) return false;
      return readFile(path, "utf8").then(raw => {
        const receipt = JSON.parse(raw) as { jobId?: string; units?: Array<{
          id: string; phase: string; commitSha?: string; beforeHead?: string }> };
        if (receipt.jobId !== job.jobId || receipt.units?.[0]?.id !== "world-foundations" ||
            receipt.units[1]?.id !== "character-foundations" ||
            receipt.units[0].phase !== "committed") return false;
        if (point.workItem === "world-foundations") return receipt.units[0].commitSha === currentHead &&
          receipt.units[1].phase === "pending" && !receipt.units[1].beforeHead;
        return receipt.units[1].phase === "committed" && receipt.units[1].commitSha === currentHead;
      }).catch(() => false);
    }
    if (key.startsWith("interactive:milestone.") &&
        point.workItem.startsWith("interactive-")) {
      const slug = key.slice("interactive:milestone.".length);
      if (!["interactive-choice-" + slug, "interactive-puzzle-" + slug].includes(point.workItem)) return false;
      const path = join(job.stateDir, "interactive-items", slug + ".json");
      if (!existsSync(path)) return false;
      return readFile(path, "utf8").then(raw => {
        const receipt = JSON.parse(raw) as { jobId?: string; units?: Array<{
          id: string; phase: string; commitSha?: string; beforeHead?: string }> };
        if (receipt.jobId !== job.jobId || receipt.units?.[0]?.phase !== "committed") return false;
        if (point.workItem === "interactive-choice-" + slug)
          return receipt.units[0].commitSha === currentHead &&
            receipt.units[1]?.phase === "pending" && !receipt.units[1].beforeHead;
        return receipt.units[1]?.phase === "committed" &&
          receipt.units[1].commitSha === currentHead;
      }).catch(() => false);
    }
    return false;
  };
  const next = { ...failures };
  for (const key of Object.keys(next)) if (await retryable(key)) delete next[key];
  return next;
}
async function reconcile(s: State, job: JobStartResult): Promise<Partial<State>> {
  const receipt = await checkPlan(job, s.request, s.planVersion);
  const plan = receipt?.plan;
  const request = plan ? { ...s.request, contract: plan.contract } : s.request;
  const head = await trustedHead(job);
  // Failed specialists own persistent recovery receipts. Later commits from
  // independent clusters do not permit replay against a changed HEAD.
  // A new authorized plan is the boundary for reconsidering local failures.
  const failures = await reconciledFailures(job,
    s.inventory?.planVersion === (plan?.version ?? null) ? s.failures ?? {} : {});
  const inherited = readRecoveryFork(job)?.completedStages ?? [];
  const evidence = [...inherited.filter(old => !s.completedStages.some(current =>
    current.stage === old.stage && current.milestone === old.milestone)), ...s.completedStages];
  let completedStages = evidence.filter(e => {
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
  // A controller-approved plan revision may require another architecture unit before downstream work.
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
  return { status: ["PiBudgetPause", "FoundationAuthorRequiredError", "SpecialistChoiceRequiredError"].includes(e.name ?? "") ? "paused" :
    e.name === "StoryCancelledError" ? "cancelled" : "blocked",
    reason: e.message ?? String(error), result: null };
}
async function authorBoundary(job: JobStartResult): Promise<Partial<State> | null> {
  const updates = await processAuthorUpdatesAfterWork(job);
  if (updates.status === "ready") return null;
  return { status: updates.status === "paused" ? "paused" : updates.status === "cancelled" ? "cancelled" : "blocked",
    reason: updates.blockers.join(", ") + ("error" in updates ? ": " + updates.error : "") };
}
/** The production parent graph. Specialists retain ownership of side effects and recovery. */
export function createGenerationGraph(checkpointer?: SqliteSaver, executionOwner: "server" | "cli" = "server") {
  return new StateGraph(Channels, { input: GenerationInputSchema })
    .addNode("schedule", async (s, config) => {
      const input = GenerationInputSchema.shape.request.safeParse(s.request);
      if (!input.success) return blocked(new Error("Invalid generation request: " +
        input.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")));
      try {
        const contract = parseGenerationContract(input.data.contract);
        const request = { ...input.data, fixture: input.data.fixture ?? false, contract };
        const job = await openJob({ ...s, request } as State);
        await verifyReadyRecoveryFork(job);
        const fork = readRecoveryFork(job);
        if (fork && JSON.stringify(request.contract) !== JSON.stringify(fork.contract))
          throw new Error("Fork continuation must retain its approved completion contract; use an explicit plan revision after starting.");
        if (executionOwner === "cli") ensureNotServerOwned(job);
        else await claimServerGeneration(job, config.configurable?.thread_id as string | undefined, request);
        return { request,
          status: "running" as const, reason: null, failures: s.failures ?? {} };
      } catch (error) { return blocked(error); }
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
          if (s.ideaTask) return {};
          if (s.active && (receipt?.plan?.version ?? null) === s.planVersion) {
            if (s.result) return {};
            try { clean(job); await trustedHead(job); } catch { return {}; }
          }
          if (s.result) throw new Error("Plan changed with an unverified dispatch result; reconcile the original assignment first.");
          clean(job);
          const next = await reconcile(s, job);
          const head = await trustedHead(job);
          const scheduled = await scheduleIdeasAtBoundary(job, "parent-generation");
          const selected = selectIdeaTask({ ...s, ...next } as State, head, scheduled.tasks,
            next.active ?? null);
          return { ...next, ideaTask: selected, escalation: null };
        } catch (error) { return blocked(error); }
      });
    })
    .addNode("idea_integration", async s => {
      if (s.ideaResult) return {};
      const task = s.ideaTask!;
      const job = await openJob(s);
      const file = ideaDispatchFile(job);
      try {
        // External Git and Pi effects cannot be replayed merely because the
        // LangGraph checkpoint was interrupted. A private receipt fences repeats.
        if (existsSync(file)) {
          const saved = JSON.parse(await readFile(file, "utf8")) as {
            jobId: string; task: IdeaTask; phase: string; result?: IdeaResult;
          };
          if (saved.jobId !== job.jobId) throw new Error("Idea dispatch receipt belongs to another job.");
          if (JSON.stringify(saved.task) === JSON.stringify(task)) {
            if (saved.result) return { ideaResult: saved.result };
            const ideas = await withStoryJobLock(job, "idea-dispatch-reconciliation", () => load(job));
            const last = ideas.find(i => i.id === task.id)?.lifecycle.placements.at(-1);
            if (last?.priorHead === task.priorHead &&
                (last.action === "integrated" && task.action === "place" ||
                 last.action === "reassessed" && task.action === "reassess")) {
              const entryFile = join(job.stateDir, "idea-placements",
                task.id + "-" + last.revision + ".json");
              const receipt = JSON.parse(await readFile(entryFile, "utf8")) as {
                priorHead: string; commitSha: string;
              };
              const commitSha = await trustedHead(job);
              if (receipt.priorHead !== task.priorHead || receipt.commitSha !== commitSha)
                throw new Error("Automated idea recovery requires the exact verified placement commit, not a later unrelated HEAD.");
              const result = { status: last.action === "integrated"
                ? last.verified === "pi" ? "integrated" : "integrated-editorial-unverified"
                : last.verified === "pi" ? "reassessed" : "reassessed-editorial-unverified", commitSha };
              await persist(file, { ...saved, phase: "returned", result });
              return { ideaResult: result };
            }
            throw new Error("Interrupted automated idea selection/writer; inspect its Pi session, placement receipt and Git worktree before manual reconciliation.");
          }
          if (saved.phase !== "verified")
            throw new Error("Previous automated idea dispatch has not been verified; reconcile it manually.");
        }
        if (await trustedHead(job) !== task.priorHead) throw new Error("Idea selection's verified Git base changed.");
        await persist(file, { jobId: job.jobId, task, phase: "running" });
        const result = await runIdeaPlacement({ ...s.request,
          // Opt-in integration evaluation: fixture Story generation with real
          // pinned Pi placement/semantic review, never a fixture-only attestation.
          fixture: s.request.fixture && process.env.NT_LIVE_GENERATION_IDEA === "1"
            ? false : s.request.fixture,
          action: task.action, id: task.id,
          ...(task.action === "place" ? { autoSelect: true } : { record: true }) }) as IdeaResult;
        await persist(file, { jobId: job.jobId, task, phase: "returned", result });
        return { ideaResult: result };
      } catch (error) { return blocked(error); }
    })
    .addNode("verify_idea_integration", async s => {
      const job = await openJob(s);
      return withStoryJobLock(job, "generation-idea-verification", async () => {
        try {
          clean(job);
          const head = await trustedHead(job);
          const task = s.ideaTask!, result = s.ideaResult!;
          if (result.commitSha && head !== result.commitSha)
            throw new Error("Idea integration commit differs from the verified Story HEAD.");
          if (result.commitSha) {
            const idea = (await load(job)).find(i => i.id === task.id);
            const last = idea?.lifecycle.placements.at(-1);
            if (last?.priorHead !== task.priorHead ||
                (task.action === "place" ? last.action !== "integrated" : last.action !== "reassessed"))
              throw new Error("Idea integration result lacks matching committed provenance.");
          } else if (head !== task.priorHead)
            throw new Error("Deferred idea result changed Git without a verified integration commit.");
          const history = [...s.ideaHistory, { id: task.id, action: task.action,
            signature: task.signature, status: result.status,
            ...(result.reason ? { reason: result.reason } : {}),
            ...(result.commitSha ? { commitSha: result.commitSha } : {}) }];
          await persist(ideaDispatchFile(job), { jobId: job.jobId, task, phase: "verified", result });
          const next = await reconcile({ ...s, ideaHistory: history, active: null, result: null }, job);
          return { ...next, ideaTask: null, ideaResult: null, ideaHistory: history,
            cursor: s.cursor + 1 };
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
          const escalation = complete ? null : reviewEscalation(report, s.inventory);
          const details = s.inventory?.items.filter(i => i.status !== "verified")
            .map(i => i.stage === "review" ? i.blockingReason ?? "Scope remains unverified" :
              `${i.id}: ${i.blockingReason ?? "Unresolved dependencies"}`).join("; ");
          const unfulfilledIdeas = report.evidence.deferredIdeas.scopedOutstanding;
          const budgeted = s.ideaHistory.filter(h => unfulfilledIdeas.includes(h.id) &&
            s.ideaHistory.filter(other => other.id === h.id).length >= MAX_IDEA_ATTEMPTS);
          return {
            // Needing a *proposal* is blocked; only a real outstanding author
            // approval interrupt or execution control may report paused.
            status: complete ? "completed" as const : "blocked" as const,
            escalation,
            reason: complete ? null : [details || s.completedStages.at(-1)?.status ||
              "Scope remains unverified",
              ...(unfulfilledIdeas.length ? ["Binding deferred ideas unresolved: " + unfulfilledIdeas.join(", ")] : []),
              ...(budgeted.length ? ["Automated idea reassessment limit reached; author review required."] : []),
              ...(escalation ? [escalation.action] : [])].join("; "),
          };
        } catch (error) { return blocked(error); }
      });
    })
    .addEdge(START, "schedule")
    .addConditionalEdges("schedule", s => s.status !== "running" ? END : "author_update_intake")
    .addConditionalEdges("author_update_intake", s => s.status !== "running" ? END :
      s.ideaTask ? "idea_integration" : s.active ? "specialist_dispatch" : "completion_decision")
    .addConditionalEdges("idea_integration", s => s.status !== "running" ? END : "verify_idea_integration")
    .addConditionalEdges("verify_idea_integration", s => s.status !== "running" ? END : "author_update_intake")
    .addConditionalEdges("specialist_dispatch", s => s.status !== "running" ? END : s.active ? "verify_committed_work" : "author_update_intake")
    .addConditionalEdges("verify_committed_work", s => s.status !== "running" ? END : "author_update_intake")
    .addEdge("completion_decision", END)
    .compile({ checkpointer });
}

export async function runStoryGeneration(options: GenerationOptions) {
  const job = await startStoryJob({ story: options.story, job: options.job }, false);
  return withStoryGenerationLock(job, async () => {
    ensureNotServerOwned(job);
    const path = join(job.stateDir, "generation.sqlite");
    if (options.action !== "start" && !existsSync(path)) throw new Error("No generation run exists; use generate start.");
    const saver = SqliteSaver.fromConnString(path);
    try {
      const graph = createGenerationGraph(saver, "cli");
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
          pauseAfter: options.pauseAfter ?? null, inventory: null, active: null, failures: {},
          ideaTask: null, ideaResult: null, ideaHistory: [], escalation: null };
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
      if (options.action === "resume" && !cancelled) {
        // Reconcile independently committed work items without ever replaying
        // their external Pi writer. The parent graph may still be mid-node.
        await withStoryJobLock(job, "generation-checkpoint-reconciliation", () =>
          reconcileRecoveryCheckpoints(job));
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
        nextStage: visible.ideaTask ? "idea-integration" : visible.active?.stage ??
          (visible.inventory ? nextExecutionItem(visible.inventory)?.stage : undefined) ?? null,
        inventory: visible.inventory, selectedWorkItem: visible.active, completedStages: visible.completedStages,
        ideaTask: visible.ideaTask, ideaHistory: visible.ideaHistory,
        recoveryCheckpoints: await inspectRecoveryCheckpoints(await startStoryJob({ story: job.storyRoot, job: job.jobId }, false)),
        escalation: visible.escalation ?? (state.status === "completed" ? null : reviewEscalation(report, visible.inventory ?? null)),
        pendingNodes: (await graph.getState(config)).next, request: visible.request, report };
    } finally { saver.db.close(); }
  });
}
