import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { startStoryJob, type JobStartResult } from "./job.js";
import { withStoryJobLock } from "./job-lock.js";
import { trustedHead } from "./revision.js";
import { loadSkillConfig } from "./skills.js";
import { preflightPiAssignment } from "./job-pi-policy.js";
import { createSkillSnapshot, openSkillSnapshot, type SkillSnapshot } from "./snapshot.js";
import { validateStoryJob, type ValidationResult } from "./validator.js";
import { verifyPlanHistory, type Plan } from "./architecture.js";
import { isFocusedScope, resolveFocusedScope } from "./focused-scope.js";
import type { PlanHistoryStep } from "./plan-continuity.js";
import { deferredCompletionObligations } from "./ideas.js";
import type { auditIdeasUnderJobLock } from "./idea-placement.js";
import { processAuthorUpdatesAtBoundary, processAuthorUpdatesAfterWork } from "./author-updates.js";
import { reviewNarrative, repairNarrativeProse, type ReviewAssignment, type EditorialVerdict,
  type EditorialFinding } from "./narrative-review-specialist.js";

type Diagnostic = { path?: string; line?: number; code: string; message: string };
type RecordItem = { path: string; metadata: Record<string, unknown> & {
  id: string; type: string; status: string; arcs?: string[]; events?: string[] } };
type Witness = { event: string; step: string; branch: string; status: string; witness?: string[] };
interface Catalog {
  records: RecordItem[];
  diagnostics: Diagnostic[];
  outstanding: Array<{ id: string; path: string; requiredBy: string; code: string; message: string }>;
  readiness?: unknown;
  protection: { status: string; base?: string; changes: unknown[]; warnings: unknown[] };
  coverage: { search: { truncated: boolean };
    eventProgress: Array<{ id: string; status: string; witness?: string[] }>;
    milestoneRoutes: Array<{ id: string; routes: Array<{
      alternative: number; status: string; witness?: string[] }> }>;
    branchProgress: Witness[];
    puzzleSolutions: Array<{ id: string; solutions: Array<{
      event: string; status: string; clueAccess: { status: string } }> }> };
}
export interface ScopedDiagnostic {
  severity: "blocking" | "uncertain"; code: string; source: string; message: string;
  repair: "composition" | "interactive" | "event" | "architecture" | "protected";
}
export interface ScopeAudit {
  version: 1;
  contractVersion: number;
  headSha: string;
  scopedRecords: string[];
  scopedPaths: string[];
  requestedBranches: string[];
  diagnostics: ScopedDiagnostic[];
  unrelatedDiagnostics: number;
  outstanding: Array<{ id: string; message: string }>;
  routeCoverage: { representative: boolean; truncated: boolean;
    events: Array<{ id: string; status: string; witness: string[] }>;
    milestones: ReviewAssignment["milestoneRoutes"];
    branches: ReviewAssignment["routes"]; puzzles: ReviewAssignment["puzzleRoutes"] };
  globalCatalog: { status: ValidationResult["status"]; readiness: unknown;
    diagnostics: number; outstanding: number };
  protection: "checked" | "unverified";
  deterministic: "passed" | "blocked";
  assignment: ReviewAssignment;
}
interface Receipt {
  version: 1; jobId: string; branch: string; threadId: string; baseSha: string;
  planVersion: number; contractDigest: string; headSha: string; snapshot?: SkillSnapshot;
  worker: "pi" | "fixture"; provider: string; model: string; thinking?: "low" | "high";
  phase: "pending" | "reviewing" | "repairing" | "completed" | "blocked";
  attempts: number; seen: string[]; sessionFiles: string[]; audit?: ScopeAudit;
  ideaAudit?: Awaited<ReturnType<typeof auditIdeasUnderJobLock>>;
  repairPriorHead?: string; repairPaths?: string[]; repairDigest?: string;
  repairCommitSha?: string; editorial?: EditorialVerdict; failure?: string;
}
export interface NarrativeReviewOptions {
  story: string; job: string; action: "run" | "inspect";
  fixture?: boolean; skillsSource?: string; validatorSource?: string;
  provider?: string; model?: string; thinking?: "low" | "high";
}
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const fileFor = (job: JobStartResult) => join(dirname(job.worktreeRoot), "narrative-review.json");
function git(job: JobStartResult, ...args: string[]) {
  const env = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[k];
  return execFileSync("git", args, { cwd: job.worktreeRoot, env, encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 }).trim();
}
async function save(file: string, data: Receipt) {
  const tmp = file + "." + randomUUID() + ".tmp";
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await rename(tmp, file);
}
function clean(job: JobStartResult, head: string) {
  if (git(job, "rev-parse", "HEAD") !== head ||
      git(job, "symbolic-ref", "--short", "HEAD") !== job.branch ||
      git(job, "status", "--porcelain=v1", "--untracked-files=all")) {
    throw new Error("Review requires the expected clean verified Story branch; preserve unexpected edits for reconciliation.");
  }
}
function ids(record: RecordItem, field: string): string[] {
  const v = record.metadata[field];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
function reportFrom(result: ValidationResult): Catalog {
  const r = result.report as unknown as Catalog | undefined;
  if (!r || !Array.isArray(r.records) || !Array.isArray(r.diagnostics) ||
      !Array.isArray(r.outstanding) || !Array.isArray(r.coverage?.eventProgress) ||
      !Array.isArray(r.coverage?.branchProgress) ||
      !Array.isArray(r.coverage?.milestoneRoutes) ||
      !Array.isArray(r.coverage?.puzzleSolutions) || !r.protection)
    throw new Error("Pinned canonical validator did not return required completion/progression evidence.");
  return r;
}
function problem(code: string, source: string, message: string,
  repair: ScopedDiagnostic["repair"], uncertain = false): ScopedDiagnostic {
  return { severity: uncertain ? "uncertain" : "blocking", code, source, message, repair };
}
/** Scope ownership comes from canonical record relationships, not the global
 * catalog readiness flag. Unknown graph relationships are conservatively unverified. */
export function auditNarrativeScope(plan: Plan, result: ValidationResult, headSha: string,
  deferred: Array<{ id: string; scopeIds: string[]; message: string }> = []): ScopeAudit {
  const report = reportFrom(result);
  const contract = plan.contract;
  const active = report.records.filter(r => r.metadata.status !== "superseded");
  const lookup = new Map(active.map(r => [r.metadata.id, r]));
  const scope = contract.scope;
  const focused = isFocusedScope(contract);
  const knownTargets = [...scope.targets, ...(scope.supportingTargets ?? [])].filter(id => lookup.has(id));
  const focusedIds = focused ? new Set([...scope.targets, ...(scope.supportingTargets ?? [])]) : undefined;
  let focusedError: string | undefined;
  if (focused) {
    try { resolveFocusedScope(active, contract); }
    catch (error) { focusedError = String(error); }
  }
  const inScope = new Set(scope.kind === "full-story" ? active
    .filter(r => ["arc", "milestone"].includes(r.metadata.type)).map(r => r.metadata.id)
    : knownTargets);
  const diagnostics: ScopedDiagnostic[] = [];
  if (focusedError) diagnostics.push(problem("scope-context-unverified", "scope", focusedError, "architecture"));
  for (const missing of [...scope.targets, ...(scope.supportingTargets ?? [])].filter(id => !lookup.has(id)))
    diagnostics.push(problem("scope-target-missing", missing, "Declared target is not in the current Story.", "architecture"));
  // Expand from requested Arc/Milestone to its generated Event/interactive/
  // prose cluster; do not turn an unrelated incomplete Arc into a blocker.
  const arcs = new Set([...inScope].filter(id => id.startsWith("arc.")));
  for (const id of [...inScope]) {
    const r = lookup.get(id);
    if (r?.metadata.type === "milestone") ids(r, "arcs").forEach(a => arcs.add(a));
  }
  const milestoneIds = new Set(active.filter(r => r.metadata.type === "milestone" &&
    (scope.kind === "full-story" || inScope.has(r.metadata.id) ||
      (arcs.size > 0 && ids(r, "arcs").some(a => inScope.has(a))))).map(r => r.metadata.id));
  milestoneIds.forEach(id => inScope.add(id));
  const milestoneEvents = new Set<string>();
  for (const id of milestoneIds) {
    const fulfillment = lookup.get(id)?.metadata.fulfillment as { any_of?: unknown } | undefined;
    if (Array.isArray(fulfillment?.any_of)) for (const alternative of fulfillment.any_of)
      if (Array.isArray(alternative)) alternative.forEach(event => {
        if (typeof event === "string") milestoneEvents.add(event);
      });
  }
  const arcRequested = scope.kind === "full-story" || [...arcs].some(a => inScope.has(a));
  const focusedEvents = new Set(focused ? active.filter(r => focusedIds?.has(r.metadata.id))
    .flatMap(r => [...ids(r, "events"), ...ids(r, "solutions")]) : []);
  const eventRecords = active.filter(r => {
    if (r.metadata.type !== "event") return false;
    if (inScope.has(r.metadata.id)) return true;
    if (focused) return focusedEvents.has(r.metadata.id) ||
      active.some(target => focusedIds?.has(target.metadata.id) &&
        JSON.stringify(r.metadata.steps ?? []).includes(target.metadata.id));
    return scope.kind === "full-story" || milestoneEvents.has(r.metadata.id) ||
      (arcRequested && ids(r, "arcs").some(a => arcs.has(a)));
  });
  const events = new Set(eventRecords.map(r => r.metadata.id));
  eventRecords.forEach(r => inScope.add(r.metadata.id));
  const referenced = new Set<string>();
  const scanIds = (v: unknown): void => {
    if (typeof v === "string" && lookup.has(v)) referenced.add(v);
    else if (Array.isArray(v)) v.forEach(scanIds);
    else if (v && typeof v === "object") Object.values(v).forEach(scanIds);
  };
  eventRecords.forEach(r => scanIds(r.metadata));
  const extra = active.filter(r => {
    if (["choice-point", "puzzle", "authored-content"].includes(r.metadata.type)) {
      return inScope.has(r.metadata.id) || (!focused && (scope.kind === "full-story" ||
        referenced.has(r.metadata.id) || ids(r, "events").some(e => events.has(e)) ||
        ids(r, "solutions").some(e => events.has(e))));
    }
    return false;
  });
  extra.forEach(r => inScope.add(r.metadata.id));
  // Any character, relationship, fact, revelation, or world record supplying
  // these Events belongs in independent review context (not automatically a
  // completion target). The editor must see the actual premises it evaluates.
  const context = new Set([...inScope]);
  for (const r of [...eventRecords, ...extra]) {
    const scan = (v: unknown): void => {
      if (typeof v === "string" && lookup.has(v)) context.add(v);
      else if (Array.isArray(v)) v.forEach(scan);
      else if (v && typeof v === "object") Object.values(v).forEach(scan);
    };
    Object.entries(r.metadata).filter(([k]) => !["decisions", "body"].includes(k))
      .forEach(([, v]) => scan(v));
  }
  active.filter(r => r.metadata.type === "creative-direction").forEach(r => context.add(r.metadata.id));
  const paths = [...new Set([...context].map(id => lookup.get(id)?.path).filter((p): p is string => !!p))].sort();
  const scopedPaths = new Set([...inScope].map(id => lookup.get(id)?.path).filter(Boolean));
  const reportProblems = report.diagnostics.filter(d => !d.path || scopedPaths.has(d.path));
  for (const d of reportProblems)
    diagnostics.push(problem(d.code, d.path ? d.path + ":" + (d.line ?? 1) : "catalog",
      d.message, "architecture"));
  const outstanding = report.outstanding.filter(o => focused ? focusedIds?.has(o.id) :
    inScope.has(o.id) || scopedPaths.has(o.path) || inScope.has(o.requiredBy))
    .map(o => ({ id: o.id, message: o.message }));
  for (const idea of deferred.filter(idea => scope.kind === "full-story" ||
    idea.scopeIds.some(id => inScope.has(id) || arcs.has(id)))) {
    outstanding.push({ id: idea.id, message: idea.message });
  }
  if (contract.scope.depth !== "architecture") for (const o of outstanding)
    diagnostics.push(problem("unfulfilled-obligation", o.id, o.message, "event"));
  const milestoneRoutes = report.coverage.milestoneRoutes.filter(m => milestoneIds.has(m.id))
    .flatMap(m => m.routes.map(r => ({ milestone: m.id, alternative: r.alternative,
      status: r.status, witness: r.witness ?? [] })));
  const selectedEvents = report.coverage.eventProgress.filter(e => events.has(e.id))
    .map(e => ({ id: e.id, status: e.status, witness: e.witness ?? [] }));
  const branchRecords = report.coverage.branchProgress.filter(b => events.has(b.event));
  const routes = branchRecords.map(b => ({ event: b.event, step: b.step, branch: b.branch,
    status: b.status, witness: b.witness ?? [] }));
  const puzzles = report.coverage.puzzleSolutions.filter(p => inScope.has(p.id))
    .flatMap(p => p.solutions.map(s => ({ puzzle: p.id, event: s.event,
      status: s.status, clueAccess: s.clueAccess.status })));
  if (scope.depth !== "architecture") {
    if (!focused && (!milestoneIds.size || !eventRecords.length))
      diagnostics.push(problem("unrealized-scope", "scope",
        "Requested interactive/composition scope lacks a realized Milestone and Event route.", "event"));
    for (const milestone of milestoneIds) {
      if (!milestoneRoutes.some(route => route.milestone === milestone && route.status === "reachable"))
        diagnostics.push(problem("milestone-unfulfilled", milestone,
          "Milestone lacks a reachable fulfillment alternative.", "event"));
    }
    for (const route of milestoneRoutes.filter(r => r.status !== "reachable"))
      diagnostics.push(problem("milestone-route-unreachable", route.milestone + "#" + route.alternative,
        "Milestone alternative " + route.status, "event", route.status !== "impossible"));
    for (const e of selectedEvents.filter(e => e.status !== "reachable"))
      diagnostics.push(problem("event-unreachable", e.id, "Event access " + e.status, "event",
        e.status !== "unreachable"));
    for (const b of routes.filter(b => b.status !== "reachable"))
      diagnostics.push(problem("branch-unreachable", b.event + "#" + b.step + "/" + b.branch,
        "Branch access " + b.status, "interactive", b.status !== "unreachable"));
    for (const p of puzzles.filter(p => p.status !== "reachable" || p.clueAccess !== "reachable"))
      diagnostics.push(problem("puzzle-unfair", p.puzzle + "/" + p.event,
        "Solution " + p.status + "; clue access " + p.clueAccess, "interactive",
        p.status !== "unreachable" && p.clueAccess !== "unreachable"));
    const choices = active.filter(record => record.metadata.type === "choice-point" &&
      (!focused || referenced.has(record.metadata.id) || focusedIds?.has(record.metadata.id)));
    const hasRequestedRoute = (outcome: string) => {
      const owned = choices.filter(choice => ids(choice, "outcomes").includes(outcome));
      if (!owned.length) return routes.some(route =>
        route.branch === outcome && route.status === "reachable");
      return routes.some(route => {
        if (route.status !== "reachable") return false;
        const event = lookup.get(route.event);
        const steps = event?.metadata.steps as Array<{ id: string; branches: Array<{
          id: string; effects?: Array<Record<string, unknown>>;
          conditions?: Array<Record<string, unknown>> }> }> | undefined;
        const selected = steps?.find(step => step.id === route.step)?.branches
          .find(branch => branch.id === route.branch);
        return [...(selected?.effects ?? []), ...(selected?.conditions ?? [])].some(effect =>
          effect.kind === "outcome" && effect.value === outcome &&
          owned.some(choice => choice.metadata.id === effect.choice_point));
      });
    };
    for (const branch of scope.branches.filter(b => !hasRequestedRoute(b)))
      diagnostics.push(problem("requested-branch-missing", branch,
        "Requested Choice/branch lacks a representative reachable witness.", "interactive"));
    if (report.coverage.search.truncated)
      diagnostics.push(problem("progression-truncated", "coverage",
        "Bounded progression search is truncated; branch completeness is unverified.", "interactive", true));
  }
  if (scope.depth === "composition" && (!focused || eventRecords.length)) {
    if (!eventRecords.length) diagnostics.push(problem("no-events", "scope",
      "Composition scope contains no Event realizations.", "event"));
    for (const e of eventRecords) {
      const content = extra.filter(r => r.metadata.type === "authored-content" &&
        ids(r, "events").includes(e.metadata.id));
      if (!content.length) diagnostics.push(problem("missing-prose", e.metadata.id,
        "No authored player-facing prose is linked to this Event.", "composition"));
    }
  }
  const protectedChecked = report.protection.status === "checked" &&
    report.protection.base === headSha && !report.protection.changes.length &&
    !report.protection.warnings.length;
  if (!protectedChecked) diagnostics.push(problem("protected-authority-unverified", "protection",
    "Protected-decision verification did not pass against the exact reviewed head.", "protected"));
  const assignment: ReviewAssignment = {
    contract, planVersion: plan.version, scopeIds: [...inScope].sort(), paths,
    routes, milestoneRoutes, puzzleRoutes: puzzles, outstanding,
    uncertainties: diagnostics.filter(d => d.severity === "uncertain").map(d => d.message),
  };
  return {
    version: 1, contractVersion: plan.version, headSha,
    scopedRecords: [...inScope].sort(), scopedPaths: [...scopedPaths].filter((p): p is string => !!p).sort(),
    requestedBranches: scope.branches, diagnostics,
    unrelatedDiagnostics: report.diagnostics.length - reportProblems.length,
    outstanding, routeCoverage: { representative: true, truncated: !!report.coverage.search.truncated,
      events: selectedEvents, milestones: milestoneRoutes, branches: routes, puzzles },
    globalCatalog: { status: result.status, readiness: report.readiness,
      diagnostics: report.diagnostics.length, outstanding: report.outstanding.length },
    protection: protectedChecked ? "checked" : "unverified",
    deterministic: diagnostics.length ? "blocked" : "passed", assignment,
  };
}
function output(job: JobStartResult, state: Receipt | undefined) {
  if (!state) return { status: "not-started", jobId: job.jobId };
  const status = state.phase === "completed" && state.audit?.deterministic === "passed" &&
    state.editorial?.verdict === "pass" && state.worker === "pi" ? "complete-in-scope"
    : state.phase === "reviewing" || state.phase === "repairing" ? "blocked-recovery"
    : state.phase === "completed" && state.audit?.deterministic === "passed" && state.worker === "fixture"
      ? "editorial-unverified" : state.phase === "pending" ? "pending" : "blocked";
  return { status, jobId: job.jobId, branch: job.branch, planVersion: state.planVersion,
    headSha: state.headSha, attempts: state.attempts, audit: state.audit,
    ideaAudit: state.ideaAudit, editorial: state.editorial ?? { verdict: "unverified" }, sessionFiles: state.sessionFiles,
    failure: state.failure, worker: state.worker };
}
function repairable(audit: ScopeAudit, findings: EditorialFinding[]) {
  return audit.deterministic === "passed" && findings.length > 0 &&
    findings.filter(f => f.severity === "blocking").every(f => f.repair === "composition");
}
interface RepairOrigin {
  paths: string[]; sessionFile: string; snapshot: SkillSnapshot;
  provider: string; model: string; thinking?: "low" | "high";
}
/** Select only the original, completed Composition writer for the affected
 * canonical prose. No matching transcript means escalation, not a new writer. */
async function repairOrigin(job: JobStartResult, audit: ScopeAudit, findings: EditorialFinding[],
  planVersion: number): Promise<RepairOrigin | null> {
  const milestones = audit.scopedRecords.filter(id => id.startsWith("milestone."));
  const stateRoot = dirname(job.worktreeRoot);
  const candidates: RepairOrigin[] = [];
  for (const milestone of milestones) {
    const file = join(stateRoot, "composition-items", milestone.slice("milestone.".length) + ".json");
    if (!existsSync(file)) continue;
    const data = JSON.parse(await readFile(file, "utf8")) as {
      phase?: string; jobId?: string; milestoneId?: string; planVersion?: number;
      worker?: string; paths?: string[]; sessionFile?: string; snapshot?: SkillSnapshot;
      provider?: string; model?: string; thinking?: "low" | "high";
    };
    if (data.phase !== "committed" || data.worker !== "pi" || data.jobId !== job.jobId ||
        data.planVersion !== planVersion || data.milestoneId !== milestone ||
        !data.paths?.length || !data.sessionFile || !data.snapshot ||
        !data.provider || !data.model) continue;
    const paths = data.paths.filter(p => p.startsWith("authored-content/") &&
      audit.scopedPaths.includes(p)).sort();
    if (!paths.length) continue;
    const prefix = join(stateRoot, "composition-sessions", "composition-" + milestone.slice(10), "write") + "/";
    if (!data.sessionFile.startsWith(prefix) || !data.sessionFile.endsWith(".jsonl") ||
        await realpath(data.sessionFile) !== data.sessionFile ||
        !(await lstat(data.sessionFile)).isFile()) continue;
    if (await openSkillSnapshot(data.snapshot.id) !== data.snapshot.path) continue;
    candidates.push({ paths, sessionFile: data.sessionFile, snapshot: data.snapshot,
      provider: data.provider, model: data.model, thinking: data.thinking });
  }
  const matching = candidates.filter(c => findings.filter(f => f.severity === "blocking")
    .every(f => c.paths.some(p => f.source === p || f.source.startsWith(p + ":"))));
  return matching.length === 1 ? matching[0]! : null;
}
function changed(job: JobStartResult): string[] {
  const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
  return git(job, "status", "--porcelain=v1", "--untracked-files=all")
    .split("\n").filter(Boolean).map(s => s.slice(3)).map(p => p.startsWith(prefix) ? p.slice(prefix.length) : p);
}
async function publishVerifiedHead(job: JobStartResult, prior: string, head: string) {
  const file = join(dirname(job.worktreeRoot), "revisions", "verified-head.json");
  await mkdir(dirname(file), { recursive: true });
  if (existsSync(file)) {
    const state = JSON.parse(await readFile(file, "utf8")) as { version: number; jobId: string; headSha: string };
    if (state.version !== 1 || state.jobId !== job.jobId ||
      (state.headSha !== prior && state.headSha !== head))
      throw new Error("Review repair cannot replace an unrelated verified-head receipt.");
    if (state.headSha === head) return;
  }
  const tmp = file + "." + randomUUID() + ".tmp";
  await writeFile(tmp, JSON.stringify({ version: 1, jobId: job.jobId, headSha: head,
    workItemId: "review-scope-repair" }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await rename(tmp, file);
}

export async function runNarrativeReview(input: NarrativeReviewOptions) {
  const job = await startStoryJob({ story: input.story, job: input.job }, false);
  if (input.action === "inspect") {
    const file = fileFor(job);
    const state: Receipt | undefined = existsSync(file) ? JSON.parse(await readFile(file, "utf8")) : undefined;
    if (!state) return output(job, state);
    const planFile = join(dirname(job.worktreeRoot), "architecture.json");
    const plan = existsSync(planFile) ? (JSON.parse(await readFile(planFile, "utf8")) as {
      plan?: Plan }).plan : undefined;
    const current = await trustedHead(job);
    if (current !== state.headSha || plan?.version !== state.planVersion ||
      digest(JSON.stringify(plan?.contract)) !== state.contractDigest)
      return { ...output(job, state), status: "stale-review" };
    return output(job, state);
  }
  return withStoryJobLock(job, "review-scope", async () => {
    await processAuthorUpdatesAtBoundary(job);
    const { scheduleIdeasAtBoundary } = await import("./idea-placement.js");
    await scheduleIdeasAtBoundary(job, "final-review");
    const file = fileFor(job);
    const archFile = join(dirname(job.worktreeRoot), "architecture.json");
    if (!existsSync(archFile)) throw new Error("Narrative review requires an approved architecture plan.");
    const arch = JSON.parse(await readFile(archFile, "utf8")) as {
      jobId: string; phase: string; plan?: Plan; history: Array<PlanHistoryStep & { reason: string }> };
    if (arch.jobId !== job.jobId || arch.phase !== "committed" || !arch.plan)
      throw new Error("Narrative review requires a committed, versioned scope plan.");
    verifyPlanHistory(job, arch);
    const plan = arch.plan;
    const contractDigest = digest(JSON.stringify(plan.contract));
    let state: Receipt | undefined = existsSync(file) ? JSON.parse(await readFile(file, "utf8")) : undefined;
    if (state && (state.version !== 1 || state.jobId !== job.jobId ||
      state.threadId !== job.threadId || state.branch !== job.branch ||
      state.baseSha !== job.baseSha))
      throw new Error("Narrative review receipt does not match the original Story job identity.");
    const head = await trustedHead(job);
    clean(job, head);
    if (state && (state.headSha !== head || state.planVersion !== plan.version ||
      state.contractDigest !== contractDigest)) {
      if (state.phase === "reviewing" || state.phase === "repairing")
        throw new Error("Interrupted narrative review cannot be superseded without manual reconciliation.");
      const history = join(dirname(file), "review-history");
      await mkdir(history, { recursive: true });
      const archived = join(history, `plan-${state.planVersion}-head-${state.headSha}.json`);
      if (existsSync(archived)) throw new Error("Narrative review history already contains this epoch; inspect before overwriting.");
      await rename(file, archived);
      state = undefined;
    }
    if (state) {
      if (state.phase === "reviewing" || state.phase === "repairing")
        throw new Error("Interrupted narrative review/repair preserved; inspect the session before manual reconciliation.");
      if (state.phase === "completed" || state.phase === "blocked") return output(job, state);
      if (Boolean(input.fixture) !== (state.worker === "fixture"))
        throw new Error("Review mode differs from the persisted reviewer.");
    } else {
      state = { version: 1, jobId: job.jobId, branch: job.branch, threadId: job.threadId,
        baseSha: job.baseSha, planVersion: plan.version, contractDigest,
        headSha: head, worker: input.fixture ? "fixture" : "pi",
        provider: input.provider ?? "openai", model: input.model ?? "gpt-6-luna",
        thinking: input.thinking, phase: "pending", attempts: 0, seen: [], sessionFiles: [] };
      await save(file, state);
    }
    const s = state;
    const { auditIdeasUnderJobLock } = await import("./idea-placement.js");
    s.ideaAudit = await auditIdeasUnderJobLock(job);
    await save(file, s);
    const config = input.skillsSource
      ? { discovery: "explicit-only" as const, novelteaSkills: input.skillsSource, skillDirs: [], requiredSkills: [] }
      : s.snapshot
        ? { discovery: "explicit-only" as const, novelteaSkills: undefined, skillDirs: [], requiredSkills: [] }
        : await loadSkillConfig(undefined, false);
    if (!s.snapshot) {
      const snapshot = await createSkillSnapshot({ ...config,
        novelteaSkills: input.skillsSource ?? config.novelteaSkills,
        requiredSkills: ["nt-narrative-review", "nt-narrative-composition", "nt-catalog"] });
      if (!snapshot) throw new Error("Narrative review requires pinned review and composition skills.");
      s.snapshot = snapshot; await save(file, s);
    }
    if (await openSkillSnapshot(s.snapshot.id) !== s.snapshot.path)
      throw new Error("Narrative review skill snapshot identity changed.");
    const validate = async (baseline: string) => validateStoryJob(
      await startStoryJob({ story: input.story, job: input.job }, false),
      input.validatorSource ?? input.skillsSource ?? config.novelteaSkills,
      { ...job, baseSha: baseline });
    const deferred = await deferredCompletionObligations(job);
    const Channels = Annotation.Root({ receipt: Annotation<Receipt>() });
    const graph = new StateGraph(Channels)
      .addNode("scope_validation_and_editorial_review", async ({ receipt }) => {
        const reviewer = async (audit: ScopeAudit) => {
          await preflightPiAssignment(job,
            "narrative-review:" + audit.assignment.planVersion + ":" + job.headSha,
            receipt.worker === "pi" ? { provider: receipt.provider, model: receipt.model,
              thinking: receipt.thinking } : undefined);
          receipt.phase = "reviewing"; await save(file, receipt);
          if (receipt.worker === "fixture") {
            const issues = audit.diagnostics.filter(d => d.severity === "blocking").map(d => ({
              severity: "blocking" as const, dimension: "obligation" as const,
              source: d.source.includes(":") ? d.source : "scope.md:1",
              message: d.message, repair: d.repair,
            }));
            return { verdict: issues.length ? "block" as const : "pass" as const,
              findings: issues, evidence: ["fixture structural review only; NO literary attestation"] };
          }
          return reviewNarrative(job, receipt.snapshot!, audit.assignment,
            receipt.provider, receipt.model, receipt.thinking,
            async session => { receipt.sessionFiles.push(session); await save(file, receipt); });
        };
        let audit = auditNarrativeScope(plan, await validate(receipt.headSha), receipt.headSha, deferred);
        receipt.audit = audit;
        if (audit.deterministic === "blocked") {
          receipt.phase = "blocked"; receipt.failure = "Objective scoped validation/coverage is not complete.";
          await save(file, receipt);
          return { receipt };
        }
        let editorial = await reviewer(audit);
        receipt.editorial = editorial; await save(file, receipt);
        // A fixture never certifies editorial quality or performs model-authored repair.
        while (receipt.worker === "pi" && editorial.verdict === "block" &&
          repairable(audit, editorial.findings) && receipt.attempts < 2) {
          const origin = await repairOrigin(job, audit, editorial.findings, plan.version);
          if (!origin) {
            receipt.failure = "Editorial repair requires an original committed Composition writer session and owned prose paths; escalate otherwise.";
            break;
          }
          const allowed = origin.paths;
          const priorHead = receipt.headSha;
          await preflightPiAssignment(job, "narrative-repair:" + job.headSha,
            { provider: origin.provider, model: origin.model, thinking: origin.thinking });
          receipt.phase = "repairing"; receipt.attempts++; await save(file, receipt);
          const before = digest(allowed.map(p => git(job, "hash-object", "--", join(job.worktreeStoryRoot, p))).join("|"));
          try {
            await repairNarrativeProse(job, origin.snapshot, audit.assignment,
              editorial.findings, allowed, origin.provider, origin.model, origin.thinking,
              origin.sessionFile,
              async session => { receipt.sessionFiles.push(session); await save(file, receipt); },
              async () => {
                const paths = changed(job);
                if (paths.some(p => !allowed.includes(p)))
                  throw new Error("Editorial repair changed an unauthorized Story record.");
                if (!paths.length) throw new Error("Editorial repair produced no prose change.");
              });
            const paths = changed(job);
            if (paths.some(p => !allowed.includes(p)) || !paths.length)
              throw new Error("Editorial repair exceeded authorized Authored Content.");
            const after = digest(allowed.map(p => git(job, "hash-object", "--", join(job.worktreeStoryRoot, p))).join("|"));
            if (after === before || receipt.seen.includes(after))
              throw new Error("Editorial repair stagnated or oscillated between prior drafts.");
            receipt.seen.push(after);
            audit = auditNarrativeScope(plan, await validate(priorHead), priorHead, deferred);
            receipt.audit = audit;
            // Never certify invalid text; preserve the exact draft for inspection.
            if (audit.deterministic !== "passed") throw new Error("Repaired prose failed canonical scoped revalidation.");
            editorial = await reviewer(audit);
            receipt.editorial = editorial;
            await save(file, receipt);
            if (editorial.verdict !== "pass" && !repairable(audit, editorial.findings))
              throw new Error("Editorial repair requires architectural/protected escalation.");
            if (editorial.verdict === "pass") {
              if (git(job, "rev-parse", "HEAD") !== priorHead ||
                  git(job, "symbolic-ref", "--short", "HEAD") !== job.branch ||
                  git(job, "diff", "--cached", "--name-only")) {
                throw new Error("Story review branch or index changed during repair.");
              }
              const finalPaths = changed(job);
              if (!finalPaths.length || finalPaths.some(p => !allowed.includes(p)))
                throw new Error("Final review repair changed unauthorized Story paths.");
              receipt.repairPriorHead = priorHead;
              receipt.repairPaths = finalPaths;
              receipt.repairDigest = after;
              await save(file, receipt);
              const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
              git(job, "add", "--", ...finalPaths.map(p => prefix + p));
              git(job, "-c", "user.name=NovelTea Generator",
                "-c", "user.email=noveltea-gen@users.noreply.github.com", "commit",
                "-m", [`Repair independently reviewed scoped prose [${job.jobId}]`, "",
                  `NovelTea-Job: ${job.jobId}`, "NovelTea-Work-Item: review-scope-repair",
                  `NovelTea-Plan-Version: ${plan.version}`, `NovelTea-Review-Repair: ${after}`].join("\n"));
              receipt.headSha = git(job, "rev-parse", "HEAD");
              receipt.repairCommitSha = receipt.headSha;
              await save(file, receipt);
              await publishVerifiedHead(job, priorHead, receipt.headSha);
              clean(job, receipt.headSha);
              audit = auditNarrativeScope(plan, await validate(receipt.headSha), receipt.headSha, deferred);
              receipt.audit = audit;
              if (audit.deterministic !== "passed")
                throw new Error("Post-commit scoped repair validation failed; preserve commit for review.");
            }
          } catch (error) {
            receipt.phase = "blocked"; receipt.failure = String(error); await save(file, receipt);
            throw error;
          }
        }
        receipt.editorial = editorial;
        receipt.phase = editorial.verdict === "pass" ? "completed" : "blocked";
        if (editorial.verdict === "block") receipt.failure =
          receipt.failure ?? "Independent editorial review blocked completion; protected/architectural changes require escalation or repair budget was exhausted.";
        await save(file, receipt);
        return { receipt };
      }).addEdge(START, "scope_validation_and_editorial_review")
      .addEdge("scope_validation_and_editorial_review", END).compile();
    const final = await graph.invoke({ receipt: s });
    const authorUpdates = await processAuthorUpdatesAfterWork(job);
    const current = await trustedHead(job);
    const latest = JSON.parse(await readFile(archFile, "utf8")) as { plan?: Plan };
    const stale = current !== final.receipt.headSha ||
      latest.plan?.version !== final.receipt.planVersion ||
      digest(JSON.stringify(latest.plan?.contract)) !== final.receipt.contractDigest;
    return { ...output(job, final.receipt), ...(stale ? { status: "stale-review" } : {}), authorUpdates };
  });
}
