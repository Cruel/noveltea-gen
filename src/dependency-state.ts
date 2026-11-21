import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "./git-read-cache.js";
import type { JobStartResult } from "./job.js";
import { persist } from "./ideas.js";
import { trustedHead } from "./revision.js";
import { inspectRecoveryCheckpoints } from "./recovery-checkpoints.js";
import { inspectCheckpointReview, readRepairCommitProof } from "./checkpoint-assurance.js";
import { auditEventParticipantCorrection } from "./event-participant-correction.js";
import { deriveReviewDependencyRequest, type EventCharacterRepairGrant,
  type ReviewDependencyRequest } from "./review-repair-amendment.js";
import { readTurnEvidence, type TurnEvidence } from "./turn-plan-evidence.js";
import { validateStoryJob } from "./validator.js";
import type { CanonicalScopeRecord } from "./focused-scope.js";
import { authorizeDependency, authorizeReviewCharacterDependency, authorizeReviewOtherOwnerDependency, parseDependencyReport,
  type DependencyReport, type DependencyProposal, type ReviewCharacterProposal,
  type DependencyAmendment } from "./dependency-amendments.js";
import type { SkillSnapshot } from "./snapshot.js";
import type { EditorialVerdict } from "./narrative-review-specialist.js";

/** A protected other-owner source requires an explicit author decision, not
 * a speculative controller dependency writer. */
export class ProtectedCrossOwnerPrerequisiteError extends Error {
  readonly name = "ProtectedCrossOwnerPrerequisiteError";
  constructor(readonly sourcePath: string) {
    super("Supporting prerequisite " + sourcePath + " has protected decisions; request explicit author authorization.");
  }
}

export const dependencyDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const sourceDigest = (value: string) => createHash("sha256").update(value).digest("hex");
export interface DependencyEntry {
  report: DependencyReport; reportDigest: string;
  /** The separate Event owner's reviewed correction; not part of the Character
   * specialist's new-record write grant. */
  eventRepair?: { sourceSha: string; commitSha: string; proofDigest: string };
  phase: "reported" | "planning" | "authorized" | "reviewing" | "verified" | "rejected";
  amendment?: DependencyAmendment; proposal?: DependencyProposal;
  approval?: { authority: "necessary-dependency/v1"; jobId: string; threadId: string;
    sourceSha: string; amendmentDigest: string };
  planner?: { snapshot: SkillSnapshot; sessionFile: string; skillReads?: string[] };
  commitSha?: string; review?: EditorialVerdict; reviewerSession?: string;
  fixture: boolean;
  /** Exact sealed negative review which generated a supporting work report. */
  reviewSourceSha?: string;
  originalReview?: EditorialVerdict; originalReviewerSession?: string;
  rejection?: { reason: string; proposal: unknown };
}
export interface DependencyPlan {
  schema: "noveltea-dependency-plan/v1"; jobId: string; threadId: string;
  turnDigest: string; version: number; entries: DependencyEntry[];
  /** Sealed findings awaiting a separate verified plan amendment. These are
   * never writer authorization and do not consume an amendment version. */
  reviewRequests?: ReviewDependencyRequest[];
  digest: string;
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
      (saved.reviewRequests !== undefined && (!Array.isArray(saved.reviewRequests) ||
        saved.reviewRequests.length > 8 ||
        new Set(saved.reviewRequests.map(r => r.sourceSha)).size !== saved.reviewRequests.length)) ||
      saved.version !== 1 + saved.entries.filter(e => e.amendment).length)
    throw Error("Dependency plan identity, version or source evidence is corrupt.");
  // A pending review request belongs to the original sealed negative verdict,
  // not to later model statements or a mutable Story catalog. Reconstruct its
  // exact digest on every read and keep it outside the writer grant list.
  if (saved.reviewRequests?.length) {
    const checkpoints = (await inspectRecoveryCheckpoints(job)).filter(p => p.eligible && p.assurance);
    for (const request of saved.reviewRequests) {
      const point = checkpoints.find(p => p.commitSha === request.sourceSha);
      const original = turn.assignments.find(a => a.id === request.originalAssignmentId);
      if (!point?.assurance || !original || request.turnDigest !== turn.digest ||
          request.basePlanVersion !== point.planVersion)
        throw Error("Review dependency lost its original checkpoint, plan version or Turn assignment.");
      if (request.otherOwnerPath)
        dependencyGit(job, "merge-base", "--is-ancestor", turn.source.verifiedSha, point.commitSha);
      const sealed = await inspectCheckpointReview(job, point);
      const repair = request.otherOwnerPath
        ? await (await import("./rejected-review-repair.js")).inspectRejectedRepair(job, request.sourceSha)
        : null;
      if (repair && (repair.phase !== "needs-plan" ||
          repair.outOfAuthority?.path !== request.otherOwnerPath ||
          repair.outOfAuthority?.sourceSha !== request.sourceSha ||
          repair.outOfAuthority?.reviewDigest !== request.reviewDigest))
        throw Error("Cross-specialist report lost its original sealed no-write repair.");
      if (sealed?.status !== "failed" || !sealed.result ||
          JSON.stringify(deriveReviewDependencyRequest({ assurance: point.assurance,
            review: sealed.result, original, turn,
            planVersion: request.basePlanVersion,
            originWorkItem: point.workItem,
            ...(repair ? { otherOwnerPath: repair.outOfAuthority!.path } : {}) })) !== JSON.stringify(request))
        throw Error("Review dependency differs from immutable source, ownership or scope.");
    }
  }
  let version = 1;
  const seen = new Set<string>();
  for (const entry of saved.entries) {
    parseDependencyReport(entry.report);
    if (seen.has(entry.reportDigest) || entry.reportDigest !== dependencyDigest(entry.report) ||
        entry.report.turnDigest !== turn.digest || typeof entry.fixture !== "boolean" ||
        !["reported", "planning", "authorized", "reviewing", "verified", "rejected"].includes(entry.phase))
      throw Error("Dependency report provenance is corrupt.");
    if (entry.reviewSourceSha) {
      const review = saved.reviewRequests?.find(r => r.sourceSha === entry.reviewSourceSha);
      if (!review || review.turnDigest !== entry.report.turnDigest ||
          review.originalAssignmentId !== entry.report.assignmentId ||
          review.sourceSha !== entry.report.sourceSha ||
          !["new-full-story-record", "other-owner"].includes(review.classification) ||
          review.action !== "controller-amendment-required" ||
          entry.fixture)
        throw Error("Supporting review-dependency report is not linked to the sealed source.");
    }
    if (entry.originalReview && (!entry.reviewSourceSha ||
        entry.originalReview.verdict !== "pass" || !entry.originalReviewerSession))
      throw Error("Suspended original goal lacks independent positive rereview.");
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
        entry.review.verdict !== "pass" || (!entry.fixture && !entry.reviewerSession) ||
        entry.reviewSourceSha && !(entry.eventRepair
          ? /^[a-f0-9]{40}$/.test(entry.eventRepair.sourceSha) &&
            /^[a-f0-9]{40}$/.test(entry.eventRepair.commitSha) &&
            /^[a-f0-9]{64}$/.test(entry.eventRepair.proofDigest)
          : entry.originalReview && entry.originalReviewerSession)))
      throw Error("Dependency completion lacks verified work and independent review receipts.");
    if (entry.phase === "verified" && entry.eventRepair) {
      const request = saved.reviewRequests?.find(r => r.sourceSha === entry.reviewSourceSha);
      const correction = entry.eventRepair;
      const proof = await readRepairCommitProof(job, "repair-" + correction.sourceSha);
      const first = await readRepairCommitProof(job, "repair-" + request!.sourceSha);
      const points = (await inspectRecoveryCheckpoints(job)).filter(p => p.eligible);
      const point = points.find(p => p.commitSha === correction.commitSha);
      const sealed = point && await inspectCheckpointReview(job, point);
      const eventPath = request?.findings[0]?.path;
      const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
      if (!request?.originalWorkItem.startsWith("event-") ||
          request.findings.length !== 1 || !eventPath?.startsWith("events/") ||
          proof.sourceCommitSha !== correction.sourceSha ||
          proof.rootFailureSha !== request.sourceSha ||
          !entry.commitSha || first.beforeHead !== entry.commitSha ||
          (correction.sourceSha !== request.sourceSha &&
            (first.commitSha !== correction.sourceSha ||
              proof.beforeHead !== first.commitSha)) ||
          proof.commitSha !== correction.commitSha || proof.digest !== correction.proofDigest ||
          !point || sealed?.status !== "passed" ||
          proof.assignmentId !== request.originalAssignmentId ||
          !entry.commitSha || proof.beforeHead === request.sourceSha ||
          dependencyGit(job, "diff", "--name-only", entry.commitSha, correction.commitSha) !==
            prefix + eventPath)
        throw Error("Event dependency completion lacks a sealed, separately owned correction and passing review.");
      dependencyGit(job, "merge-base", "--is-ancestor", entry.commitSha, correction.commitSha);
      auditEventParticipantCorrection(
        dependencyGit(job, "show", entry.commitSha + ":" + prefix + eventPath),
        dependencyGit(job, "show", correction.commitSha + ":" + prefix + eventPath),
        entry.amendment!.assignment.targets[0]!);
    }
    if (entry.phase === "verified") {
      const a = entry.amendment!;
      const proof = JSON.parse(await readFile(join(job.stateDir, "dependency-items", a.assignment.id + ".json"), "utf8"));
      const authorizedPaths = [...a.assignment.authority.existingPaths,
        ...(a.assignment.authority.newPaths ?? [])].sort();
      if (proof.phase !== "committed" || proof.jobId !== job.jobId || proof.workItemId !== a.assignment.id ||
          proof.commitSha !== entry.commitSha || proof.expectedHead !== a.sourceSha ||
          proof.assignmentDigest !== turn.digest || proof.worker !== (entry.fixture ? "fixture" : "pi") ||
          proof.validation?.status !== "passed" || proof.validation.validatorVersion !== job.validatorVersion ||
          proof.validation.baseSha !== a.sourceSha ||
          JSON.stringify(proof.paths) !== JSON.stringify(authorizedPaths))
        throw Error("Dependency work receipt is missing or no longer matches its native-validated assignment.");
      const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
      const paths = authorizedPaths;
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
/** Durable read-only plan request for an out-of-lease independent review.
 * It does not authorize a path, change the Turn objective or retry a writer. */
export async function recordReviewDependency(job: JobStartResult, request: ReviewDependencyRequest) {
  const turn = await dependencyTurn(job);
  const head = await dependencyBoundary(job);
  if (request.turnDigest !== turn.digest)
    throw Error("Review dependency lost its original sealed Turn.");
  const plan = await inspectDependencyPlan(job) ?? {
    schema: "noveltea-dependency-plan/v1" as const,
    jobId: job.jobId, threadId: job.threadId, turnDigest: turn.digest,
    version: 1, entries: [], reviewRequests: [], digest: "",
  };
  const previous = plan.reviewRequests?.find(r => r.sourceSha === request.sourceSha);
  if (previous) {
    if (JSON.stringify(previous) !== JSON.stringify(request))
      throw Error("Review dependency request changed at the same source SHA.");
    if (head !== request.sourceSha) {
      const entry = plan.entries.find(e => e.reviewSourceSha === request.sourceSha);
      if (entry?.phase === "verified" && entry.eventRepair?.commitSha === head)
        return request; // inspectDependencyPlan already attested the final Event repair.
      if (request.classification === "other-owner" && entry?.phase === "verified" && entry.commitSha) {
        const { verifiedNarrativeChain } = await import("./job-successor.js");
        await verifiedNarrativeChain(job, entry.commitSha, head);
        return request; // Independently reviewed later commits are not a replay of the prerequisite.
      }
      const proofPath = entry?.amendment && join(job.stateDir, "dependency-items",
        entry.amendment.assignment.id + ".json");
      if (!entry || !entry.amendment || !proofPath || !existsSync(proofPath) ||
          !["authorized", "reviewing", "verified"].includes(entry.phase))
        throw Error("Review dependency HEAD advanced without an authenticated supporting-work receipt.");
      const proof = JSON.parse(await readFile(proofPath, "utf8"));
      if (proof.phase !== "committed" || proof.commitSha !== head ||
          proof.expectedHead !== request.sourceSha ||
          proof.workItemId !== entry.amendment.assignment.id ||
          proof.assignmentDigest !== request.turnDigest)
        throw Error("Review dependency successor differs from the exact authorized Git receipt.");
    }
    return request;
  }
  if (head !== request.sourceSha)
    throw Error("New review dependency requires the exact reviewed Story HEAD.");
  if ((plan.reviewRequests?.length ?? 0) >= 8 || plan.entries.some(e => e.phase !== "verified"))
    throw Error("Unresolved amendment budget reached; retain review for controlled reconciliation.");
  plan.reviewRequests ??= [];
  plan.reviewRequests.push(request);
  await saveDependencyPlan(job, plan);
  // The next load independently verifies the full sealed review, rather than
  // trusting even our own state-writer's representation.
  await inspectDependencyPlan(job);
  return request;
}

/** Adapt a sealed missing-Character review to the SAME dependency-plan
 * report/entry/version mechanism used by focused work. Source facts come
 * from native-validated canon and actual source line, not reviewer prose.
 * Nothing here creates a file, approves an Arc edit or starts a writer. */
export async function registerReviewDependency(
  job: JobStartResult, request: ReviewDependencyRequest, validatorSource?: string,
) {
  const foundations = request.originalWorkItem === "character-foundations";
  const event = /^event-[a-z][a-z0-9-]*$/.test(request.originalWorkItem);
  const existingOwner = request.classification === "other-owner" && !!request.otherOwnerPath;
  if (!["new-full-story-record", "other-owner"].includes(request.classification) ||
      request.action !== "controller-amendment-required" ||
      request.findings.length !== 1 ||
      !(existingOwner || foundations && /^arcs\/[a-z][a-z0-9-]*\.md$/.test(request.findings[0]!.path) ||
        event && /^events\/[a-z][a-z0-9-]*\.md$/.test(request.findings[0]!.path)))
    throw Error("Review dependency cannot be safely reduced to one scoped Character prerequisite.");
  const saved = await inspectDependencyPlan(job);
  if (!saved?.reviewRequests?.some(r => JSON.stringify(r) === JSON.stringify(request)))
    throw Error("Review dependency has not been sealed into the shared work plan.");
  const head = await dependencyBoundary(job);
  const prior = saved.entries.find(e => e.reviewSourceSha === request.sourceSha);
  if (prior) {
    if (prior.phase === "verified" && prior.eventRepair?.commitSha === head)
      return { plan: saved, entry: prior };
    if (existingOwner && prior.phase === "verified" && prior.commitSha && head !== request.sourceSha) {
      const { verifiedNarrativeChain } = await import("./job-successor.js");
      await verifiedNarrativeChain(job, prior.commitSha, head);
      return { plan: saved, entry: prior };
    }
    if (head !== request.sourceSha) {
      const path = prior.amendment && join(job.stateDir, "dependency-items",
        prior.amendment.assignment.id + ".json");
      if (!path || !existsSync(path) ||
          !["authorized", "reviewing", "verified"].includes(prior.phase))
        throw Error("Review dependency advanced without a completed owned writer.");
      const proof = JSON.parse(await readFile(path, "utf8"));
      if (proof.phase !== "committed" || proof.expectedHead !== request.sourceSha ||
          proof.commitSha !== head)
        throw Error("Review dependency cannot resume from a substituted supporting commit.");
    }
    return { plan: saved, entry: prior };
  }
  if (head !== request.sourceSha)
    throw Error("New review dependency requires its original negative checkpoint HEAD.");
  const original = await dependencyTurn(job);
  if (!original.objective || (!existingOwner && original.kind !== "full-story") ||
      original.digest !== request.turnDigest)
    throw Error("Review dependency lost the whole-Story objective.");
  if (event && !existingOwner) {
    // Reviewer prose cannot convert an invented Event into a genuine
    // prerequisite. Authenticate the original committed Event writer and
    // Pi session BEFORE any new Character path is allocated.
    const point = (await inspectRecoveryCheckpoints(job)).find(p =>
      p.eligible && p.commitSha === request.sourceSha &&
      p.workItem === request.originalWorkItem &&
      p.assurance?.assignmentId === request.originalAssignmentId);
    if (!point) throw Error("Missing source-bound Event owner checkpoint.");
    const { readRejectedRepairOrigin } = await import("./rejected-review-repair.js");
    const origin = await readRejectedRepairOrigin(job, point);
    const receipt = JSON.parse(await readFile(join(job.stateDir, "event-items",
      request.originalWorkItem.slice("event-".length) + ".json"), "utf8")) as {
      milestoneId?: string; workItemId?: string; commitSha?: string;
      phase?: string; worker?: string; paths?: string[];
    };
    if (origin.workItem !== request.originalWorkItem ||
        receipt.workItemId !== request.originalWorkItem ||
        receipt.milestoneId !== "milestone." + request.originalWorkItem.slice("event-".length) ||
        receipt.commitSha !== request.sourceSha ||
        receipt.phase !== "committed" || receipt.worker !== "pi" ||
        !receipt.paths?.includes(request.findings[0]!.path))
      throw Error("Event Character dependency lacks the original signed Event writer and exact owned source.");
  }
  const validation = await validateStoryJob(job, validatorSource, { ...job, baseSha: head });
  const report = validation.report as { records?: CanonicalScopeRecord[]; diagnostics?: unknown[];
    protection?: { status?: string; base?: string; changes?: unknown[]; warnings?: unknown[] } } | undefined;
  if (validation.status !== "passed" || !report?.records ||
      report.protection?.status !== "checked" || report.protection.base !== head ||
      report.protection.changes?.length || report.protection.warnings?.length)
    throw Error("Review dependency requires a clean native-verifiable canonical source.");
  const finding = request.findings[0]!;
  const sourceRecord = report.records.find(r => r.path === (existingOwner ? request.otherOwnerPath : finding.path) &&
    (existingOwner || r.metadata.type === (foundations ? "arc" : "event")) &&
    r.metadata.status !== "superseded");
  if (!sourceRecord ||
      !(existingOwner ? !!original.assignments.find(a => a.id !== request.originalAssignmentId &&
          a.authority.existingPaths.includes(sourceRecord.path)) :
        foundations ? /^arc\.[a-z][a-z0-9-]*$/.test(sourceRecord.metadata.id) :
        /^event\.[a-z][a-z0-9-]*$/.test(sourceRecord.metadata.id) &&
        Array.isArray(sourceRecord.metadata.participants) &&
        new Set(sourceRecord.metadata.participants).size ===
          sourceRecord.metadata.participants.length))
    throw Error("Review dependency cited source lacks verified canonical type, participants or ID.");
  if (existingOwner && sourceRecord.metadata.decisions !== undefined &&
      (!Array.isArray(sourceRecord.metadata.decisions) || sourceRecord.metadata.decisions.length))
    throw new ProtectedCrossOwnerPrerequisiteError(sourceRecord.path);
  const file = join(job.worktreeStoryRoot, sourceRecord.path);
  if (await realpath(file) !== file)
    throw Error("Review dependency source is symlinked.");
  const content = await readFile(file, "utf8");
  const line = existingOwner ? content.split(/\r?\n/).find(x => x.trim()) :
    content.split(/\r?\n/)[finding.line - 1];
  if (!line?.trim()) throw Error("Review dependency lost its exact cited source line.");
  const obligation = existingOwner ? original.objective.obligations[0] :
    original.objective.obligations.find(x => /\bcharacters\b/i.test(x));
  if (!obligation) throw Error("Original approved Turn has no relevant prerequisite obligation.");
  const reportValue: DependencyReport = {
    sourceSha: head, turnDigest: request.turnDigest,
    assignmentId: request.originalAssignmentId, obligation,
    missing: finding.requiredCorrection, affectedIds: [sourceRecord.metadata.id],
    sources: [{ path: sourceRecord.path, sha256: sourceDigest(content), quote: line.trim() }],
    likelySpecialist: existingOwner ? (await import("./focused-specialist.js")).focusedSpecialist(sourceRecord.metadata.id) :
      "nt-character-development", authorDecisionRequired: false,
  };
  const { plan, entry } = await recordDependency(job, reportValue, false);
  if (entry.reviewSourceSha && entry.reviewSourceSha !== request.sourceSha)
    throw Error("Dependency report has mismatched review identity.");
  if (!entry.reviewSourceSha) {
    entry.reviewSourceSha = request.sourceSha;
    await saveDependencyPlan(job, plan);
  }
  return { plan, entry };
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
  const priorAmendments = plan.entries.filter(e => e !== entry && e.amendment)
    .map(e => e.amendment!.assignment);
  const request = entry.reviewSourceSha ? plan.reviewRequests?.find(r =>
    r.sourceSha === entry.reviewSourceSha) : undefined;
  const amendment = request?.classification === "other-owner"
    ? authorizeReviewOtherOwnerDependency({ plan: turn, head, request,
        proposal, reportDigest: entry.reportDigest, records: report.records,
        version: plan.version, priorAmendments })
    : request
    ? authorizeReviewCharacterDependency({ plan: turn, head, request,
        proposal: proposal as ReviewCharacterProposal,
        reportDigest: entry.reportDigest, records: report.records, version: plan.version,
        priorAmendments })
    : authorizeDependency({ plan: turn, head, report: entry.report,
        reportDigest: entry.reportDigest, proposal, records: report.records, sources, version: plan.version,
        priorAmendments });
  entry.proposal = proposal; entry.amendment = amendment;
  entry.approval = { authority: "necessary-dependency/v1", jobId: job.jobId,
    threadId: job.threadId, sourceSha: head, amendmentDigest: dependencyDigest(amendment) };
  entry.phase = "authorized"; plan.version = amendment.afterVersion;
  await saveDependencyPlan(job, plan);
}
/** A read-only view of the verified Character specialist prerequisite.
 * The Event specialist never receives the Character writer's path grant.
 * This source-bound field grant is used only with the original failed review. */
export async function inspectReviewEventSupport(
  job: JobStartResult, failedSourceSha: string,
): Promise<EventCharacterRepairGrant | null> {
  const plan = await inspectDependencyPlan(job);
  const request = plan?.reviewRequests?.find(r => r.sourceSha === failedSourceSha);
  if (!request?.originalWorkItem.startsWith("event-") ||
      request.classification !== "new-full-story-record" ||
      request.action !== "controller-amendment-required" ||
      request.findings.length !== 1) return null;
  const entry = plan?.entries.find(e => e.reviewSourceSha === failedSourceSha);
  if (!entry || !["reviewing", "verified"].includes(entry.phase)) return null;
  const assignment = entry.amendment?.assignment;
  const path = request.findings[0]!.path;
  const target = assignment?.targets[0];
  if (!entry.commitSha || entry.review?.verdict !== "pass" ||
      !entry.reviewerSession || !assignment ||
      assignment.specialist !== "nt-character-development" ||
      JSON.stringify(assignment.authority.recordTypes) !== JSON.stringify(["character"]) ||
      assignment.authority.existingPaths.length !== 0 ||
      assignment.authority.newPaths?.length !== 1 ||
      assignment.authority.newPaths[0] !== "characters/" + target?.slice(10) + ".md" ||
      !/^character\.[a-z][a-z0-9-]*$/.test(target ?? "") ||
      !/^events\/[a-z][a-z0-9-]*\.md$/.test(path) ||
      entry.amendment!.sourceSha !== failedSourceSha ||
      entry.amendment!.resumes !== request.originalAssignmentId)
    throw Error("Event Character support lacks an exact approved and independently reviewed Character creation.");
  const proof = JSON.parse(await readFile(join(job.stateDir, "dependency-items",
    assignment.id + ".json"), "utf8"));
  const newPath = assignment.authority.newPaths[0]!;
  const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
  if (proof.phase !== "committed" || proof.jobId !== job.jobId ||
      proof.commitSha !== entry.commitSha || proof.expectedHead !== failedSourceSha ||
      proof.workItemId !== assignment.id || proof.worker !== "pi" ||
      proof.assignmentDigest !== request.turnDigest ||
      proof.validation?.status !== "passed" ||
      proof.validation.validatorVersion !== job.validatorVersion ||
      proof.validation.baseSha !== failedSourceSha ||
      JSON.stringify(proof.paths) !== JSON.stringify(assignment.authority.newPaths) ||
      dependencyGit(job, "rev-parse", entry.commitSha + "^") !== failedSourceSha ||
      dependencyGit(job, "diff", "--name-only", failedSourceSha, entry.commitSha) !==
        prefix + newPath ||
      proof.sha256 !== dependencyDigest([[newPath,
        sourceDigest(dependencyGit(job, "show", entry.commitSha + ":" + prefix + newPath))]]))
    throw Error("Event Character support has no exact native-validated specialist receipt.");
  // The lease is re-attested while an Event correction may have a dirty
  // draft. Validate the verified Git head here; the actual writer admission
  // separately requires a completely clean boundary.
  const head = await trustedHead(job);
  if (dependencyGit(job, "rev-parse", "HEAD") !== head)
    throw Error("Event Character support is not on the trusted Story HEAD.");
  dependencyGit(job, "merge-base", "--is-ancestor", entry.commitSha, head);
  return { id: target!, path, failedSourceSha, supportingCommitSha: entry.commitSha };
}

/** Advance only after the separate original Event owner has a passing
 * source-linked corrective checkpoint. Never rewrite the negative verdict. */
export async function finalizeReviewEventDependency(job: JobStartResult, failedSourceSha: string) {
  const grant = await inspectReviewEventSupport(job, failedSourceSha);
  if (!grant) return false;
  const plan = (await inspectDependencyPlan(job))!;
  const entry = plan.entries.find(e => e.reviewSourceSha === failedSourceSha)!;
  if (entry.phase === "verified") return true;
  const { inspectRejectedRepair } = await import("./rejected-review-repair.js");
  let repairedSource = failedSourceSha;
  let repairedCommit: string | undefined;
  // The existing bounded repair controller permits a second attempt only
  // after an independently failed successor. Both negative verdicts survive.
  for (let attempt = 0; attempt < 2; attempt++) {
    const repair = await inspectRejectedRepair(job, repairedSource);
    if (repair.phase === "passed") {
      repairedCommit = repair.repairedCommitSha;
      break;
    }
    if (repair.phase !== "failed" || !repair.repairedCommitSha) return false;
    repairedSource = repair.repairedCommitSha;
  }
  if (!repairedCommit) return false;
  const proof = await readRepairCommitProof(job, "repair-" + repairedSource);
  const point = (await inspectRecoveryCheckpoints(job)).find(p =>
    p.eligible && p.commitSha === repairedCommit);
  const sealed = point && await inspectCheckpointReview(job, point);
  const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
  if (point?.semanticReview !== "passed" || sealed?.status !== "passed" ||
      proof.rootFailureSha !== failedSourceSha || proof.commitSha !== repairedCommit ||
      JSON.stringify(proof.paths) !== JSON.stringify([grant.path]) ||
      dependencyGit(job, "diff", "--name-only", grant.supportingCommitSha, repairedCommit) !==
        prefix + grant.path ||
      await dependencyBoundary(job) !== repairedCommit)
    throw Error("Suspended Event correction is not separately source-bound, reviewed and clean.");
  auditEventParticipantCorrection(
    dependencyGit(job, "show", grant.supportingCommitSha + ":" + prefix + grant.path),
    dependencyGit(job, "show", repairedCommit + ":" + prefix + grant.path), grant.id);
  entry.eventRepair = { sourceSha: repairedSource,
    commitSha: repairedCommit, proofDigest: proof.digest };
  entry.phase = "verified";
  await saveDependencyPlan(job, plan);
  await inspectDependencyPlan(job);
  return true;
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
