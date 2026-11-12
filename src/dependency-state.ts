import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "./git-read-cache.js";
import type { JobStartResult } from "./job.js";
import { persist } from "./ideas.js";
import { trustedHead } from "./revision.js";
import { readTurnEvidence, type TurnEvidence } from "./turn-plan-evidence.js";
import { validateStoryJob } from "./validator.js";
import type { CanonicalScopeRecord } from "./focused-scope.js";
import { authorizeDependency, parseDependencyReport, type DependencyReport,
  type DependencyProposal, type DependencyAmendment } from "./dependency-amendments.js";
import type { SkillSnapshot } from "./snapshot.js";
import type { EditorialVerdict } from "./narrative-review-specialist.js";

export const dependencyDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const sourceDigest = (value: string) => createHash("sha256").update(value).digest("hex");
export interface DependencyEntry {
  report: DependencyReport; reportDigest: string;
  phase: "reported" | "planning" | "authorized" | "reviewing" | "verified" | "rejected";
  amendment?: DependencyAmendment; proposal?: DependencyProposal;
  approval?: { authority: "necessary-dependency/v1"; jobId: string; threadId: string;
    sourceSha: string; amendmentDigest: string };
  planner?: { snapshot: SkillSnapshot; sessionFile: string; skillReads?: string[] };
  commitSha?: string; review?: EditorialVerdict; reviewerSession?: string;
  fixture: boolean;
  rejection?: { reason: string; proposal: unknown };
}
export interface DependencyPlan {
  schema: "noveltea-dependency-plan/v1"; jobId: string; threadId: string;
  turnDigest: string; version: number; entries: DependencyEntry[]; digest: string;
}
const file = (job: JobStartResult) => join(job.stateDir, "dependency-plan.json");
export function dependencyGit(job: JobStartResult, ...args: string[]): string {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"]) delete env[key];
  const output = execFileSync("git", args, { cwd: job.worktreeRoot, env, encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
  return args[0] === "show" ? output : output.trim();
}
export async function dependencyBoundary(job: JobStartResult): Promise<string> {
  if (dependencyGit(job, "status", "--porcelain=v1", "--untracked-files=all"))
    throw Error("Dependency amendment requires a clean safe boundary; preserve interrupted drafts.");
  return trustedHead(job);
}
export async function dependencyTurn(job: JobStartResult): Promise<TurnEvidence> {
  const hint = JSON.parse(await readFile(join(job.stateDir, "turn-plan.json"), "utf8")) as TurnEvidence;
  const plan = await readTurnEvidence(job, hint.contract);
  if (!plan?.objective) throw Error("Dependency amendments require the original source-bound Turn objective.");
  return plan;
}
export async function inspectDependencyPlan(job: JobStartResult): Promise<DependencyPlan | null> {
  if (!existsSync(file(job))) return null;
  const saved = JSON.parse(await readFile(file(job), "utf8")) as DependencyPlan;
  const { digest, ...body } = saved;
  const turn = await dependencyTurn(job);
  if (saved.schema !== "noveltea-dependency-plan/v1" || saved.jobId !== job.jobId ||
      saved.threadId !== job.threadId || saved.turnDigest !== turn.digest ||
      digest !== dependencyDigest(body) || !Array.isArray(saved.entries) || saved.entries.length > 8 ||
      saved.version !== 1 + saved.entries.filter(e => e.amendment).length)
    throw Error("Dependency plan identity, version or source evidence is corrupt.");
  let version = 1;
  const seen = new Set<string>();
  for (const entry of saved.entries) {
    parseDependencyReport(entry.report);
    if (seen.has(entry.reportDigest) || entry.reportDigest !== dependencyDigest(entry.report) ||
        entry.report.turnDigest !== turn.digest || typeof entry.fixture !== "boolean" ||
        !["reported", "planning", "authorized", "reviewing", "verified", "rejected"].includes(entry.phase))
      throw Error("Dependency report provenance is corrupt.");
    seen.add(entry.reportDigest);
    if (entry.amendment) {
      const a = entry.amendment;
      if (a.beforeVersion !== version++ || a.afterVersion !== version || a.turnDigest !== turn.digest ||
          a.sourceSha !== entry.report.sourceSha || a.reportDigest !== entry.reportDigest ||
          a.resumes !== entry.report.assignmentId ||
          JSON.stringify(a.objective) !== JSON.stringify(turn.objective) ||
          entry.approval?.authority !== "necessary-dependency/v1" || entry.approval.jobId !== job.jobId ||
          entry.approval.threadId !== job.threadId || entry.approval.sourceSha !== a.sourceSha ||
          entry.approval.amendmentDigest !== dependencyDigest(a))
        throw Error("Dependency amendment lacks exact controller source-bound authorization.");
    } else if (!["reported", "planning", "rejected"].includes(entry.phase))
      throw Error("Dependency work has no authorized plan amendment.");
    if (entry.phase === "verified" && (!entry.commitSha || !entry.review ||
        entry.review.verdict !== "pass" || (!entry.fixture && !entry.reviewerSession)))
      throw Error("Dependency completion lacks verified work and independent review receipts.");
    if (entry.phase === "verified") {
      const a = entry.amendment!;
      const proof = JSON.parse(await readFile(join(job.stateDir, "dependency-items", a.assignment.id + ".json"), "utf8"));
      if (proof.phase !== "committed" || proof.jobId !== job.jobId || proof.workItemId !== a.assignment.id ||
          proof.commitSha !== entry.commitSha || proof.expectedHead !== a.sourceSha ||
          proof.assignmentDigest !== turn.digest || proof.worker !== (entry.fixture ? "fixture" : "pi") ||
          proof.validation?.status !== "passed" || proof.validation.validatorVersion !== job.validatorVersion ||
          proof.validation.baseSha !== a.sourceSha ||
          JSON.stringify(proof.paths) !== JSON.stringify(a.assignment.authority.existingPaths))
        throw Error("Dependency work receipt is missing or no longer matches its native-validated assignment.");
      const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
      const paths = a.assignment.authority.existingPaths;
      if (dependencyGit(job, "rev-parse", entry.commitSha + "^") !== a.sourceSha ||
          dependencyGit(job, "diff", "--name-only", a.sourceSha, entry.commitSha!).split("\n").join("\n") !==
            paths.map(p => prefix + p).join("\n") ||
          proof.sha256 !== dependencyDigest(paths.map(p => [p,
            sourceDigest(dependencyGit(job, "show", entry.commitSha + ":" + prefix + p))])))
        throw Error("Dependency committed bytes or exact diff differ from the work receipt.");
      dependencyGit(job, "merge-base", "--is-ancestor", entry.commitSha!, "HEAD");
    }
  }
  return saved;
}
export interface DependencyHistoryPin { reportDigest: string; entryDigest: string }
export async function verifyDependencyHistory(job: JobStartResult, pins: DependencyHistoryPin[]) {
  if (!pins.length) return;
  const plan = await inspectDependencyPlan(job);
  for (const pin of pins) {
    const entry = plan?.entries.find(e => e.reportDigest === pin.reportDigest);
    if (!entry || entry.phase !== "verified" || dependencyDigest(entry) !== pin.entryDigest)
      throw Error("Checkpointed dependency authorization history is missing or changed; restore original receipts.");
  }
}

/** Callers hold the existing Story writer lock; sandboxed models cannot access
 * this job-private ledger. Its hash detects corruption, not author consent. */
export async function saveDependencyPlan(job: JobStartResult, plan: DependencyPlan): Promise<void> {
  const { digest: _old, ...body } = plan;
  plan.digest = dependencyDigest(body);
  await persist(file(job), plan);
}
export async function recordDependency(job: JobStartResult, value: unknown, fixture: boolean) {
  const report = parseDependencyReport(value);
  const turn = await dependencyTurn(job);
  const head = await dependencyBoundary(job);
  if (report.sourceSha !== head || report.turnDigest !== turn.digest ||
      !turn.assignments.some(a => a.id === report.assignmentId))
    throw Error("Dependency report has a stale Story or originating assignment.");
  const plan = await inspectDependencyPlan(job) ?? { schema: "noveltea-dependency-plan/v1" as const,
    jobId: job.jobId, threadId: job.threadId, turnDigest: turn.digest, version: 1, entries: [], digest: "" };
  const reportDigest = dependencyDigest(report);
  const prior = plan.entries.find(e => e.reportDigest === reportDigest);
  if (prior) {
    if (prior.fixture !== fixture) throw Error("Dependency worker mode changed.");
    return { plan, entry: prior };
  }
  if (plan.entries.length >= 8 || plan.entries.some(e => e.phase !== "verified"))
    throw Error("Unresolved dependency or amendment limit reached; author reconciliation required.");
  const entry: DependencyEntry = { report, reportDigest, fixture, phase: "reported" };
  plan.entries.push(entry);
  await saveDependencyPlan(job, plan);
  return { plan, entry };
}
export async function approveDependency(job: JobStartResult, plan: DependencyPlan,
  entry: DependencyEntry, proposal: DependencyProposal, validatorSource?: string) {
  const head = await dependencyBoundary(job);
  const turn = await dependencyTurn(job);
  const persisted = await inspectDependencyPlan(job);
  if (!persisted || persisted.digest !== plan.digest || !plan.entries.includes(entry) ||
      !["reported", "planning"].includes(entry.phase) || entry.amendment)
    throw Error("Dependency approval has a stale plan version or is not the pending report.");
  const result = await validateStoryJob(job, validatorSource, { ...job, baseSha: head });
  const report = result.report as { records?: CanonicalScopeRecord[]; protection?: {
    status?: string; base?: string; changes?: unknown[]; warnings?: unknown[] } } | undefined;
  if (result.status !== "passed" || !report?.records || report.protection?.status !== "checked" ||
      report.protection.base !== head || report.protection.changes?.length || report.protection.warnings?.length)
    throw Error("Dependency authorization requires native canonical/protection verification.");
  const sources = [];
  for (const source of entry.report.sources) {
    if (!report.records.some(r => r.path === source.path)) throw Error("Noncanonical dependency evidence path.");
    const full = join(job.worktreeStoryRoot, source.path);
    if (await realpath(full) !== full) throw Error("Unsafe dependency source path.");
    const bytes = await readFile(full, "utf8");
    if (!bytes.includes(source.quote)) throw Error("Dependency evidence quote is absent from Story source.");
    sources.push({ ...source, sha256: sourceDigest(bytes) });
  }
  const amendment = authorizeDependency({ plan: turn, head, report: entry.report,
    reportDigest: entry.reportDigest, proposal, records: report.records, sources, version: plan.version,
    priorAmendments: plan.entries.filter(e => e !== entry && e.amendment)
      .map(e => e.amendment!.assignment) });
  entry.proposal = proposal; entry.amendment = amendment;
  entry.approval = { authority: "necessary-dependency/v1", jobId: job.jobId,
    threadId: job.threadId, sourceSha: head, amendmentDigest: dependencyDigest(amendment) };
  entry.phase = "authorized"; plan.version = amendment.afterVersion;
  await saveDependencyPlan(job, plan);
}
/** Writer admission never accepts an assignment supplied by a model or caller. */
export async function authorizedDependency(job: JobStartResult, assignmentId: string, fixture: boolean) {
  const plan = await inspectDependencyPlan(job);
  const entry = plan?.entries.find(e => e.amendment?.assignment.id === assignmentId);
  if (!entry?.amendment || !entry.approval || entry.fixture !== fixture ||
      !["authorized", "reviewing", "verified"].includes(entry.phase))
    throw Error("Dependency writer lacks a trusted assignment grant.");
  return entry;
}
