import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { startStoryJob, canonicalDestination, type JobStartResult } from "./job.js";
import type { Plan } from "./architecture.js";
import type { ScopeAudit } from "./narrative-review.js";
import { auditIdeasUnderJobLock } from "./idea-placement.js";
import { runAuthorAction } from "./author-updates.js";
import { previewStoryMerge } from "./merge-preview.js";

type Outcome = "completed" | "paused" | "blocked" | "failed";
type IntegrationStatus = "mergeable" | "conflicts" | "not assessed";
type Json = Record<string, unknown>;
export interface WorkItemStatus {
  id: string; kind: string; status: string; targets: string[];
  commitSha?: string; reason?: string; receipt: string;
}
export interface JobReportOptions {
  story: string; job: string; preview?: boolean; fixture?: boolean;
  validatorSource?: string; skillsSource?: string;
  provider?: string; model?: string; thinking?: "low" | "high";
}
function git(cwd: string, ...args: string[]): string {
  const env = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[name];
  return execFileSync("git", args, { cwd, env, encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 }).trim();
}
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const obj = (v: unknown): Json | undefined => v && typeof v === "object" && !Array.isArray(v) ? v as Json : undefined;
const arr = (v: unknown): Json[] => Array.isArray(v) ? v.map(obj).filter((v): v is Json => !!v) : [];
const string = (v: unknown) => typeof v === "string" ? v : undefined;
const list = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
function inside(root: string, path: string) {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}
async function receipt(path: string, job: JobStartResult): Promise<Json | undefined> {
  let s;
  try { s = await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!s.isFile() || s.isSymbolicLink()) throw new Error("Unsafe job report receipt: " + path);
  const data = obj(JSON.parse(await readFile(path, "utf8")));
  if (!data || (data.jobId !== undefined && data.jobId !== job.jobId) ||
      (data.threadId !== undefined && data.threadId !== job.threadId) ||
      (data.branch !== undefined && data.branch !== job.branch) ||
      (data.baseSha !== undefined && data.baseSha !== job.baseSha))
    throw new Error("Job report receipt identity mismatch: " + path);
  return data;
}
function item(id: string, kind: string, phase: unknown, targets: string[], path: string,
  commitSha?: unknown, reason?: unknown): WorkItemStatus {
  return { id, kind, status: string(phase) ?? "unknown", targets,
    ...(string(commitSha) ? { commitSha: string(commitSha) } : {}),
    ...(string(reason) || list(reason).length ? { reason: string(reason) ?? list(reason).join("; ") } : {}),
    receipt: path };
}
function workItemReceipts(path: string, items: Json[], kind: string, target: string): WorkItemStatus[] {
  return items.map((r, i) => item(string(r.id) ?? kind + "-" + (i + 1), kind, r.phase, [target],
    path, r.commitSha, r.failure ?? r.conflicts));
}
async function workItems(job: JobStartResult, plan: Plan | undefined, arch?: Json) {
  const root = job.stateDir;
  const statuses: WorkItemStatus[] = [];
  const foundation = await receipt(join(root, "foundation.json"), job);
  if (foundation) statuses.push(item("foundation", "creative-direction", foundation.stage,
    foundation.target ? [String(foundation.target)] : [], "foundation.json",
    foundation.commitSha, foundation.stage === "awaiting-author" ? "Author discovery input required." : undefined));
  if (plan) for (const p of plan.items) statuses.push(item(
    p.id, p.kind, p.status, p.targetIds, "architecture.json", p.verifiedSha, p.blockingReason));
  if (arch && !plan) statuses.push(item("architecture", "architecture", arch.phase, [],
    "architecture.json", arch.expectedHead));
  const cw = await receipt(join(root, "character-world.json"), job);
  if (cw) statuses.push(...workItemReceipts("character-world.json", arr(cw.units), "foundation", "world/characters"));
  for (const [folder, kind] of [["event-items", "event"], ["interactive-items", "interactive"],
    ["composition-items", "composition"]] as const) {
    let paths: string[];
    try { paths = (await readdir(join(root, folder))).filter(name => /^[a-z0-9-]+\.json$/.test(name)).sort(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const name of paths) {
      const path = folder + "/" + name;
      const record = await receipt(join(root, path), job);
      if (!record) continue;
      const target = string(record.milestoneId) ?? name.replace(/\.json$/, "");
      if (kind === "interactive") statuses.push(...workItemReceipts(path, arr(record.units), kind, target));
      else statuses.push(item(string(record.workItemId) ?? kind + ":" + target,
        kind, record.phase, [target], path, record.commitSha, record.failure ?? record.conflicts));
    }
  }
  let revisions: string[] = [];
  try { revisions = (await readdir(join(root, "revisions")))
    .filter(name => /^[a-z][a-z0-9-]*\.json$/.test(name) && name !== "verified-head.json").sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  for (const name of revisions) {
    const r = await receipt(join(root, "revisions", name), job);
    if (!r || !r.workItemId || !["proposed", "committed"].includes(String(r.status))) continue;
    statuses.push(item(String(r.workItemId), "revision", r.status, string(r.target) ? [String(r.target)] : [],
      "revisions/" + name, r.commitSha,
      r.status === "proposed" ? "Explicit author approval and editorial review required." : undefined));
  }
  return statuses;
}
async function authorEvidence(job: JobStartResult) {
  const budget = await receipt(join(job.stateDir, "pi-budget.json"), job);
  // Reuse the message ledger's own identity/digest checks, including queued
  // messages that have no acknowledgement receipt yet. Only summary IDs and
  // statuses survive; original author payloads never enter report output.
  const updates = await runAuthorAction({ story: job.storyRoot, job: job.jobId, action: "inspect" }) as {
    status: string; records: Array<{
      message: { id: string }; acknowledgement: { phase: string };
    }>;
  };
  const pending = updates.records.filter(x => x.acknowledgement.phase !== "applied")
    .map(x => ({ id: x.message.id, phase: x.acknowledgement.phase,
      action: "Author must review or resume this update." }));
  return { executionControl: updates.status,
    budgetPause: obj(budget?.pause)?.reason ?? null, pending };
}
function safeIdeaView(audit: Awaited<ReturnType<typeof auditIdeasUnderJobLock>>) {
  return { status: audit.status, reviewed: audit.reviewed.map(x => ({
    id: x.id, status: x.status, binding: x.binding, scopeIds: x.scopeIds,
    currentRealizations: x.currentRealizations, stale: x.stale, verdict: x.verdict,
  })), outstanding: audit.outstanding };
}
function statusOf(review: Json | undefined, audit: ScopeAudit | undefined, plan: Plan | undefined,
  head: string, author: Awaited<ReturnType<typeof authorEvidence>>, blockers: string[],
  ideas: { status: "ready" | "unverified"; outstanding: string[] }, contractOk: boolean): Outcome {
  if (author.executionControl === "cancelled") return "failed";
  if (author.executionControl === "paused" || author.budgetPause || author.pending.some(x =>
    x.phase === "queued" || x.phase === "awaiting-author"))
    return "paused";
  if (review?.phase === "blocked" || blockers.some(x => x.startsWith("Recovery:")) ||
    (review?.phase === "completed" && !contractOk) ||
    blockers.some(x => x.startsWith("Review:")) ||
    (review?.phase === "completed" && audit?.deterministic !== "passed"))
    return "blocked";
  if (review?.phase === "completed" && review?.worker === "pi" &&
      obj(review.editorial)?.verdict === "pass" && audit?.deterministic === "passed" &&
      contractOk && review.headSha === head && ideas.status === "ready" && ideas.outstanding.length === 0 && blockers.length === 0)
    return "completed";
  if (review?.phase === "reviewing" || review?.phase === "repairing") return "blocked";
  if (review?.phase === "completed" && review?.worker === "fixture") return "paused";
  if (!plan || review?.phase === undefined) return "paused";
  return blockers.length ? "blocked" : "paused";
}
/** Author-facing read-only view. Never copy the private author inbox or raw message payloads. */
export async function inspectJobReport(input: JobReportOptions) {
  const job = await startStoryJob({ story: input.story, job: input.job }, false);
  const root = job.stateDir;
  const arch = await receipt(join(root, "architecture.json"), job);
  const plan = obj(arch?.plan) as unknown as Plan | undefined;
  const review = await receipt(join(root, "narrative-review.json"), job);
  const audit = obj(review?.audit) as unknown as ScopeAudit | undefined;
  const author = await authorEvidence(job);
  const statuses = await workItems(job, plan, arch);
  if (review) statuses.push(item("review-scope", "narrative-review", review.phase,
    plan?.contract.scope.targets ?? [], "narrative-review.json", review.headSha, review.failure));
  const head = job.headSha;
  const contractOk = !!plan && !!review && review.planVersion === plan.version &&
    review.contractDigest === digest(plan.contract);
  const reviewCurrent = !!review && review.headSha === head && contractOk &&
    audit?.headSha === head && audit.contractVersion === plan?.version;
  let ideas: Omit<ReturnType<typeof safeIdeaView>, "status"> & { status: "ready" | "unverified" };
  try { ideas = safeIdeaView(await auditIdeasUnderJobLock(job)); }
  catch { ideas = { status: "unverified", reviewed: [], outstanding: [] }; }
  const blockers: string[] = [];
  for (const pending of author.pending) blockers.push("Author update " + pending.id +
    " requires action (" + pending.phase + ").");
  for (const revision of statuses.filter(x => x.kind === "revision" && x.status === "proposed"))
    blockers.push("Author revision approval required for " + revision.id + ".");
  if (!plan) blockers.push("No approved, versioned scope contract.");
  if (["writing", "authored"].includes(string(arch?.phase) ?? "") ||
    statuses.some(x => x.receipt !== "architecture.json" &&
      ["writing", "authored", "blocked"].includes(x.status))) {
    blockers.push("Recovery: an unfinished or blocked specialist needs inspection before generation can proceed.");
  }
  if (!review) blockers.push("Completion review has not been run.");
  if (review && !reviewCurrent) blockers.push("Review: receipt does not match the current verified Story revision and scope contract.");
  if (review?.failure) blockers.push("Review: " + String(review.failure));
  for (const d of audit?.diagnostics ?? []) if (d.severity === "blocking") blockers.push(d.code + ": " + d.message);
  for (const o of audit?.outstanding ?? []) blockers.push("Outstanding: " + o.id + ": " + o.message);
  for (const f of (arr(obj(review?.editorial)?.findings))) if (f.severity === "blocking")
    blockers.push("Editorial: " + String(f.message));
  // The original architecture DAG can retain an old blocked/pending scheduling
  // placeholder after later committed specialists satisfy that obligation.
  // Keep historical work-item reasons, but let the current scoped audit decide
  // whether a live blocker still exists.
  if (ideas.status === "unverified") blockers.push("Deferred idea audit could not be verified.");
  // Out-of-scope dormant ideas are reported to the author, but do not block scoped completion.
  const clean = git(job.worktreeRoot, "status", "--porcelain=v1", "--untracked-files=all") === "";
  if (!clean) blockers.push("Generation worktree has uncommitted or untracked changes.");
  const scopeIds = new Set(audit?.scopedRecords ?? []);
  const scopedIdeaIds = ideas.reviewed.filter(idea =>
    idea.binding && idea.verdict !== "previously-reviewed" &&
    (plan?.contract.scope.kind === "full-story" ||
      idea.scopeIds.some(id => scopeIds.has(id)))).map(idea => idea.id);
  if (scopedIdeaIds.length) blockers.push("Binding in-scope deferred ideas remain unresolved: " + scopedIdeaIds.join(", "));
  const outcome = statusOf(review, audit, plan, head, author, blockers,
    { status: ideas.status, outstanding: scopedIdeaIds }, contractOk && reviewCurrent);
  // Scope fulfillment describes the verified committed Story, not whether the
  // coordinator is presently paused or the target branch can integrate it.
  const scopeFulfillment = reviewCurrent && (audit?.deterministic === "blocked" ||
    review?.phase === "blocked") ? "blocked" :
    reviewCurrent && review?.phase === "completed" && review.worker === "pi" &&
      obj(review.editorial)?.verdict === "pass" && audit?.deterministic === "passed" &&
      ideas.status === "ready" && scopedIdeaIds.length === 0 && clean && !review.failure
      ? "complete-in-scope" : "unverified";
  // Git history is the authority for completed work, not a guessed receipt phase.
  const commits = git(job.worktreeRoot, "log", "--reverse", "--format=%H%x09%s", job.baseSha + ".." + head)
    .split("\n").filter(Boolean).map(line => {
      const [sha, ...rest] = line.split("\t");
      return { sha, subject: rest.join("\t") };
    });
  const evidence = {
    scope: audit ? { current: reviewCurrent, deterministic: audit.deterministic, scopedRecords: audit.scopedRecords,
      scopedPaths: audit.scopedPaths, diagnostics: audit.diagnostics,
      outstanding: audit.outstanding, routeCoverage: audit.routeCoverage,
      unrelatedDiagnostics: audit.unrelatedDiagnostics,
      globalCatalog: audit.globalCatalog, headSha: audit.headSha } : null,
    readiness: audit?.globalCatalog?.readiness ?? null,
    logicalUnverified: audit?.diagnostics.filter(x => x.severity === "uncertain") ?? [],
    protection: { status: reviewCurrent ? audit?.protection ?? "unverified" : "unverified",
      source: "narrative-review.json", verifiedHead: reviewCurrent ? head : null },
    editorial: reviewCurrent && review?.worker === "pi" ? {
      verdict: obj(review.editorial)?.verdict ?? "unverified",
      findings: arr(obj(review.editorial)?.findings),
      evidence: list(obj(review.editorial)?.evidence),
    } : { verdict: "unverified", findings: [], evidence: [] },
    deferredIdeas: { ...ideas, scopedOutstanding: scopedIdeaIds },
    authorApprovals: { executionControl: author.executionControl, budgetPause: author.budgetPause,
      pending: author.pending, required: author.pending.length > 0 || scopedIdeaIds.length > 0 ||
        statuses.some(x => x.kind === "revision" && x.status === "proposed") ||
        (audit?.protection !== "checked") },
    notes: ["A canonical validator or fixture-only review cannot certify editorial quality.",
      "Report evidence is tied to the recorded revisions and becomes stale when HEAD or the plan changes."],
  };
  let integration: { status: IntegrationStatus; targetHead: string; preview: unknown; reason?: string } = {
    status: "not assessed", targetHead: git(job.gitRoot, "rev-parse", "HEAD"),
    preview: null, reason: "Use --preview to construct and review a disposable merge candidate.",
  };
  if (input.preview) {
    const candidate = await previewStoryMerge(input);
    const constructed = candidate.candidate.status === "constructed";
    const conflicts = candidate.status === "conflicts-found";
    integration = {
      status: conflicts ? "conflicts" : constructed &&
        candidate.status === "compatible-for-author-review"
        ? "mergeable" : "not assessed",
      targetHead: candidate.target.head,
      preview: candidate,
      ...(constructed && !conflicts && candidate.narrative.status !== "pass"
        ? { reason: "Candidate constructed, but independent narrative compatibility is not verified." } : {}),
    };
  }
  const storyId = "story-" + createHash("sha256")
    .update(JSON.stringify([job.gitRoot, job.storyRelativePath])).digest("hex").slice(0, 24);
  return { schema: "noveltea-job-report/v1" as const, identity: {
    storyId, storyRoot: job.storyRoot, jobId: job.jobId, threadId: job.threadId,
    branch: job.branch, worktreeRoot: job.worktreeRoot, worktreeStoryRoot: job.worktreeStoryRoot,
    baseSha: job.baseSha, headSha: head, clean,
  }, plan: plan ? { version: plan.version, scope: plan.contract.scope, contract: plan.contract,
    phase: arch?.phase ?? "unknown", receipt: "architecture.json" } : null,
  generation: { status: outcome, scopeFulfillment,
    review: review ? { phase: review.phase, headSha: review.headSha,
      worker: review.worker, current: reviewCurrent } : null,
    blockers, author },
  workItems: statuses, commits, evidence, integration };
}
export type JobReport = Awaited<ReturnType<typeof inspectJobReport>>;
export function formatJobReport(report: JobReport): string {
  const preview = obj(report.integration.preview);
  const conflicts = [
    ...arr(obj(preview?.candidate)?.conflicts),
    ...arr(preview?.issues),
  ];
  const p: string[] = [
    "# NovelTea Story job report", "",
    "Story: " + report.identity.storyId + " (" + report.identity.storyRoot + ")",
    "Job: " + report.identity.jobId + " (" + report.identity.threadId + ")",
    "Branch: " + report.identity.branch,
    "Generation HEAD: " + report.identity.headSha,
    "Generation base: " + report.identity.baseSha,
    "Outcome: " + report.generation.status,
    "Scope fulfillment: " + report.generation.scopeFulfillment,
    "Integration: " + report.integration.status + " (target " + report.integration.targetHead + ")",
    "Scope contract: " + (report.plan ? "version " + report.plan.version +
      ", " + report.plan.scope.kind + " at " + report.plan.scope.depth : "not established"), "",
    "## Blockers and approvals", "",
    ...(report.generation.blockers.length ? report.generation.blockers.map(x => "- " + x) : ["- None reported"]),
    "Author action required: " + (report.evidence.authorApprovals.required ? "yes" : "no"), "",
    "## Work items", "",
    ...report.workItems.map(x => "- " + x.id + " [" + x.kind + "]: " + x.status +
      (x.commitSha ? " @ " + x.commitSha : "") + (x.reason ? " — " + x.reason : "")), "",
    "## Git commits", "",
    ...report.commits.map(x => "- " + x.sha + " " + x.subject), "",
    "## Verification", "",
    "Deterministic: " + (report.evidence.scope?.deterministic ?? "unverified"),
    "Protection: " + report.evidence.protection.status,
    "Editorial: " + report.evidence.editorial.verdict,
    "Deferred idea audit: " + report.evidence.deferredIdeas.status,
    "Deferred binding IDs: " + (report.evidence.deferredIdeas.outstanding.join(", ") || "none"),
    "Unverified logical conditions: " + report.evidence.logicalUnverified.length,
    ...report.evidence.logicalUnverified.map(x => "- " + x.source + ": " + x.message),
    "Readiness: " + JSON.stringify(report.evidence.readiness), "",
    "## Structural and progression evidence", "",
    ...((report.evidence.scope?.diagnostics ?? []).map(x =>
      "- " + x.severity + " " + x.code + " @ " + x.source + ": " + x.message)),
    ...((report.evidence.scope?.outstanding ?? []).map(x => "- Outstanding " + x.id + ": " + x.message)),
    "Route evidence: " + JSON.stringify(report.evidence.scope?.routeCoverage ?? "unverified"), "",
    "## Editorial findings", "",
    ...report.evidence.editorial.findings.map(x =>
      "- " + String(x.severity) + " @ " + String(x.source) + ": " + String(x.message)),
    ...report.evidence.editorial.evidence.map(x => "- Evidence: " + x),
    "## Deferred idea fulfillment", "",
    ...report.evidence.deferredIdeas.reviewed.map(x => "- " + x.id + ": " + x.verdict +
      " (" + (x.scopeIds.join(", ") || "no scope") + ")"),
    "In-scope outstanding: " + (report.evidence.deferredIdeas.scopedOutstanding.join(", ") || "none"), "",
    "## Integration evidence", "",
    report.integration.reason ?? "",
    ...conflicts.flatMap(c => [
      "- " + String(c.path ?? "unknown") + " (" + list(c.ids).join(", ") + "): " + String(c.summary ?? "Conflict"),
      ...list(c.evidence).map(x => "  - Evidence: " + x),
      "  - Uncertainty: " + String(c.uncertainty ?? "unverified"),
      ...list(c.options).map(x => "  - Reconciliation option: " + x),
    ]),
    "", "This report is evidence for author review, not permission to merge or override protected decisions.", "",
  ];
  return p.join("\n");
}
export async function exportJobReport(job: JobStartResult, path: string, content: string) {
  const dest = await canonicalDestination(path);
  if (inside(job.gitRoot, dest) || inside(job.worktreeRoot, dest))
    throw new Error("Report export must be outside the author checkout and generation worktree.");
  // Exclusive creation avoids unexpected overwrites or following an existing symlink.
  await writeFile(dest, content, { flag: "wx", mode: 0o600 });
  return dest;
}
