/** Controller-owned index of submitted corrections, sealed verdicts and
 * authenticated corrective scope. Independent reviewers own semantic
 * continuity; the ledger never matches creative defects by file/category or
 * imposes a fixed number of productive correction rounds.
 *
 * Version 1 entries and prior author grants remain readable for recovery.
 * All mutations run under the existing job writer lease.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JobStartResult } from "./job.js";
import type { IndependentReviewResult } from "./checkpoint-assurance.js";

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const PATH = /^[a-z][a-z0-9-]*\/[a-z0-9._-]+\.md$/;
/** Historical v1 allowance values, used only to authenticate old author grants.
 * New semantic progress is governed by independent review and Pi job budgets. */
export const MAX_LOCAL_CORRECTIONS = 2;
export const MAX_DEPENDENCY_CYCLES = 3;
export const MAX_TURN_CORRECTIONS = 12;
/** A single author continuation grants one more local and Turn attempt.
 * The absolute ceiling remains bounded even after multiple requests. */
export const MAX_AUTHOR_REPAIR_GRANTS = 6;
export const MAX_AUTHOR_GRANTS_PER_ROOT = 2;
export interface AuthorRepairGrant {
  id: string; authorId: string; rootFailureSha: string; sourceSha: string;
  headSha: string; guidance: string; localLimit: number; turnLimit: number;
}
export function turnCorrectionLimit(ledger: RepairLedger): number {
  return MAX_TURN_CORRECTIONS + (ledger.authorGrants?.length ?? 0);
}
export function localCorrectionLimit(ledger: RepairLedger, root: string): number {
  return MAX_LOCAL_CORRECTIONS + (ledger.authorGrants ?? [])
    .filter(grant => grant.rootFailureSha === root).length;
}
export function dependencyCycleLimit(ledger: RepairLedger): number {
  return MAX_DEPENDENCY_CYCLES;
}
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export type RepairFindingInput = IndependentReviewResult["findings"][number];
type Category = NonNullable<RepairFindingInput["kind"]>;
interface ReviewReference { sourceSha: string; reviewDigest: string }
export interface RepairFinding {
  id: string;
  rootFailureSha: string;
  assignmentId: string;
  /** Original approved assignment promise, not mutable reviewer prose. */
  obligation: string;
  category: Category;
  targets: string[];
  status: "open" | "resolved" | "escalated";
  source: ReviewReference;
  /** First correction responsible for a genuinely new downstream finding. */
  causedBy?: string;
  /** New entries are indexed within ONE immutable negative verdict, not across reviews. */
  findingIndex?: number;
  reviewFindingsDigest?: string;
  /** Historical submission references are retained for legacy recovery. */
  attempts: string[];
}
export interface RepairCorrection {
  rootFailureSha: string;
  sourceSha: string;
  changedPaths: string[];
  result?: { successorSha: string; status: "passed" | "failed"; reviewDigest: string };
}
export interface PrerequisiteRepair {
  /** Identity follows the same canonical obligation through changed wording and HEADs. */
  id: string;
  obligation: "milestone-closeout";
  milestoneId: string;
  path: string;
  sourceEventSha: string;
  proposalDigest: string;
  sourceSha: string;
  planVersion: number;
  status: "open" | "resolved";
  /** A genuine new downstream defect cites the originating completed correction. */
  causedBy?: string;
  attempts: Array<{ sourceSha: string; submittedSha: string; paths: string[];
    reviewDigest?: string; verdict?: "passed" | "failed" }>;
}
export type ApprovalRevisionCause = "approval-escape" | "newly-discovered-constraint" |
  "author-directed" | "unclassified";
export type ApprovalRevisionSeverity = "warning" | "info";
export const approvalRevisionSeverity = (cause: ApprovalRevisionCause): ApprovalRevisionSeverity =>
  cause === "approval-escape" || cause === "unclassified" ? "warning" : "info";
/** Classification is an assertion about CONTROLLER-AUTHENTICATED evidence,
 * never about a reviewer's suggested cause. A postapproval Event is not proof
 * that an earlier independent review overlooked a then-visible defect. */
export function classifyApprovalRevisionCause(proof: {
  kind: "historical-contradiction" | "later-constraint" | "author-change" | "unknown";
  originalSourceSha: string;
  verifiedSourceSha?: string;
  authorizedAuthorChange?: boolean;
}): ApprovalRevisionCause {
  if (!SHA.test(proof.originalSourceSha) || proof.verifiedSourceSha && !SHA.test(proof.verifiedSourceSha))
    throw Error("Unverifiable post-approval revision origin.");
  if (proof.kind === "historical-contradiction" && proof.verifiedSourceSha === proof.originalSourceSha)
    return "approval-escape";
  if (proof.kind === "later-constraint" && proof.verifiedSourceSha &&
      proof.verifiedSourceSha !== proof.originalSourceSha) return "newly-discovered-constraint";
  if (proof.kind === "author-change" && proof.authorizedAuthorChange === true)
    return "author-directed";
  return "unclassified";
}
export interface BlueprintApprovalProvenance {
  provider: string; model: string; reviewerId: string | null; reviewCycleId: string;
}
export interface BlueprintRevisionIncident {
  id: string; cause: ApprovalRevisionCause; severity: ApprovalRevisionSeverity;
  /** Immutable references only; raw transcripts, quoted prose and credentials stay private. */
  trigger: { kind: "event-only" | "independent-event-review" | "combined";
    fields: string[]; sourcePaths: string[]; reviewDigest: string | null };
  affectedWork: string[];
  originalApproval: BlueprintApprovalProvenance;
  successorApproval?: BlueprintApprovalProvenance;
}
export interface BlueprintRepair {
  owner: "nt-event-design";
  original: import("./milestone-blueprint.js").MilestoneBlueprintPin;
  eventHead: string; sourceSha: string; planDigest: string; evidenceDigest: string; originalReviewDigest: string;
  incident?: BlueprintRevisionIncident;
  successor?: import("./milestone-blueprint.js").MilestoneBlueprintPin;
}
export interface RepairLedger {
  version: 1;
  jobId: string;
  threadId: string;
  turnDigest: string;
  findings: RepairFinding[];
  corrections: RepairCorrection[];
  /** Additive private controller state; pre-existing ledgers remain readable. */
  prerequisites?: PrerequisiteRepair[];
  blueprintRepairs?: BlueprintRepair[];
  authorGrants?: AuthorRepairGrant[];
}
export function totalTurnCorrections(ledger: RepairLedger): number {
  return ledger.corrections.length +
    (ledger.prerequisites ?? []).reduce((total, p) => total + p.attempts.length, 0);
}
interface FindingReport {
  turnDigest: string;
  rootFailureSha: string;
  sourceSha: string;
  reviewDigest: string;
  assignmentId: string;
  obligation: string;
  findings: RepairFindingInput[];
}
interface Submission {
  turnDigest: string;
  rootFailureSha: string;
  sourceSha: string;
  changedPaths: string[];
}
interface Verdict extends FindingReport {
  successorSha: string;
  status: "passed" | "failed";
}
const pathFor = (job: JobStartResult, turnDigest: string) =>
  join(job.stateDir, "repair-ledgers", turnDigest + ".json");

function assertReport(report: FindingReport) {
  if (!DIGEST.test(report.turnDigest) || !DIGEST.test(report.reviewDigest) ||
      !SHA.test(report.sourceSha) || !SHA.test(report.rootFailureSha) ||
      !report.assignmentId.trim() || !report.obligation.trim() ||
      !report.findings.length || report.findings.length > 100)
    throw Error("Repair finding lacks bounded, source-linked identity.");
  for (const finding of report.findings) {
    const targets = finding.affectedPaths ?? [finding.path];
    if (!PATH.test(finding.path) || !Array.isArray(targets) ||
        !targets.length || targets.length > 12 ||
        targets.some(p => !PATH.test(p)) || !targets.includes(finding.path) ||
        new Set(targets).size !== targets.length ||
        !["continuity", "missing-requirement", "unrequested-change", "other"].includes(finding.kind ?? "other"))
      throw Error("Repair finding has unsafe or unverifiable targets.");
  }
}
function shape(finding: RepairFindingInput) {
  return { category: finding.kind ?? "other" as Category,
    targets: [...new Set(finding.affectedPaths ?? [finding.path])].sort() };
}
const provenanceValid = (p: BlueprintApprovalProvenance | undefined, cycle: string) =>
  !!p && p.reviewCycleId === cycle && DIGEST.test(p.reviewCycleId) &&
  typeof p.provider === "string" && p.provider.length > 0 && p.provider.length <= 100 &&
  typeof p.model === "string" && p.model.length > 0 && p.model.length <= 120 &&
  (p.reviewerId === null || typeof p.reviewerId === "string" &&
    p.reviewerId.length > 0 && p.reviewerId.length <= 200);
function incidentValid(r: BlueprintRepair, job: JobStartResult, turnDigest: string) {
  const i = r.incident;
  if (!i) return true; // Historic #229 repairs remain readable.
  return i.id === digest({ jobId: job.jobId, threadId: job.threadId, turnDigest,
    original: r.original, evidenceDigest: r.evidenceDigest }) &&
    ["approval-escape", "newly-discovered-constraint", "author-directed", "unclassified"].includes(i.cause) &&
    i.severity === approvalRevisionSeverity(i.cause) &&
    provenanceValid(i.originalApproval, r.original.cycleId) &&
    (!i.successorApproval || !!r.successor && provenanceValid(i.successorApproval, r.successor.cycleId)) &&
    (!!r.successor === !!i.successorApproval) &&
    !!i.trigger && ["event-only", "independent-event-review", "combined"].includes(i.trigger.kind) &&
    Array.isArray(i.trigger.fields) && i.trigger.fields.length <= 12 &&
    i.trigger.fields.every(f => typeof f === "string" && f.length <= 100 &&
      /^(events|downstream)\/[a-z0-9/-]+$/.test(f)) &&
    Array.isArray(i.trigger.sourcePaths) && i.trigger.sourcePaths.length > 0 &&
    i.trigger.sourcePaths.length <= 24 && new Set(i.trigger.sourcePaths).size === i.trigger.sourcePaths.length &&
    i.trigger.sourcePaths.every(p => typeof p === "string" && PATH.test(p)) &&
    (i.trigger.reviewDigest === null || DIGEST.test(i.trigger.reviewDigest)) &&
    Array.isArray(i.affectedWork) && i.affectedWork.length > 0 &&
    i.affectedWork.length <= 12 && new Set(i.affectedWork).size === i.affectedWork.length &&
    i.affectedWork.every(v => typeof v === "string" && /^[-a-z0-9:.]{1,120}$/.test(v));
}
function validateLedger(job: JobStartResult, turnDigest: string, raw: RepairLedger) {
  if (raw.version !== 1 || raw.jobId !== job.jobId || raw.threadId !== job.threadId ||
      raw.turnDigest !== turnDigest || !Array.isArray(raw.findings) ||
      !Array.isArray(raw.corrections) || raw.findings.length > 512 ||
      (raw.blueprintRepairs !== undefined && (!Array.isArray(raw.blueprintRepairs) ||
        raw.blueprintRepairs.length > 512 || new Set(raw.blueprintRepairs.map(r => r.original.milestoneId)).size !== raw.blueprintRepairs.length ||
        raw.blueprintRepairs.some(r => r.owner !== "nt-event-design" || !SHA.test(r.eventHead) ||
          !SHA.test(r.sourceSha) || !DIGEST.test(r.planDigest) || !DIGEST.test(r.evidenceDigest) || !DIGEST.test(r.originalReviewDigest) ||
          !/^milestone\.[a-z][a-z0-9-]*$/.test(r.original.milestoneId) ||
          !SHA.test(r.original.sourceSha) || !DIGEST.test(r.original.digest) || !DIGEST.test(r.original.cycleId) ||
          !incidentValid(r, job, turnDigest) ||
          r.successor && (r.successor.milestoneId !== r.original.milestoneId || r.successor.sourceSha !== r.sourceSha ||
            !DIGEST.test(r.successor.digest) || !DIGEST.test(r.successor.cycleId) || r.successor.digest === r.original.digest ||
            r.successor.cycleId === r.original.cycleId)))) ||
      (raw.prerequisites !== undefined && (!Array.isArray(raw.prerequisites) ||
        raw.prerequisites.length > 512 ||
        new Set(raw.prerequisites.map(p => p.id)).size !== raw.prerequisites.length ||
        raw.prerequisites.some(p => !DIGEST.test(p.id) ||
          p.obligation !== "milestone-closeout" ||
          !/^milestone\.[a-z][a-z0-9-]*$/.test(p.milestoneId) ||
          !/^milestones\/[a-z0-9._-]+\.md$/.test(p.path) ||
          !SHA.test(p.sourceEventSha) || !SHA.test(p.sourceSha) ||
          !DIGEST.test(p.proposalDigest) || !Number.isSafeInteger(p.planVersion) ||
          p.planVersion < 1 || !["open", "resolved"].includes(p.status) ||
          (p.causedBy !== undefined && !SHA.test(p.causedBy)) ||
          !Array.isArray(p.attempts) ||
          p.attempts.some(a => !SHA.test(a.sourceSha) || !SHA.test(a.submittedSha) ||
            !Array.isArray(a.paths) || !a.paths.length ||
            a.paths.some(path => !PATH.test(path)) ||
            (a.verdict !== undefined && (!["passed", "failed"].includes(a.verdict) ||
              !DIGEST.test(a.reviewDigest ?? ""))))))) ||
      (raw.authorGrants !== undefined && (!Array.isArray(raw.authorGrants) ||
        raw.authorGrants.length > MAX_AUTHOR_REPAIR_GRANTS ||
        new Set(raw.authorGrants.map(grant => grant.id)).size !== raw.authorGrants.length ||
        raw.authorGrants.some((grant, index) =>
          !DIGEST.test(grant.id) || !grant.authorId || grant.authorId.length > 180 ||
          !SHA.test(grant.rootFailureSha) || !SHA.test(grant.sourceSha) ||
          !SHA.test(grant.headSha) || !grant.guidance.trim() ||
          grant.guidance.length > 1200 ||
          grant.localLimit !== MAX_LOCAL_CORRECTIONS +
            raw.authorGrants!.slice(0, index + 1).filter(g => g.rootFailureSha === grant.rootFailureSha).length ||
          grant.turnLimit !== MAX_TURN_CORRECTIONS + index + 1 ||
          grant.id !== digest({ authorId: grant.authorId,
            rootFailureSha: grant.rootFailureSha, sourceSha: grant.sourceSha,
            headSha: grant.headSha, guidance: grant.guidance,
            localLimit: grant.localLimit, turnLimit: grant.turnLimit }) ||
          raw.authorGrants!.filter(g => g.rootFailureSha === grant.rootFailureSha).length >
            MAX_AUTHOR_GRANTS_PER_ROOT))) ||
      new Set(raw.findings.map(f => f.id)).size !== raw.findings.length ||
      new Set(raw.corrections.map(c => c.rootFailureSha + ":" + c.sourceSha)).size !== raw.corrections.length ||
      raw.findings.some(f => !DIGEST.test(f.id) || !SHA.test(f.rootFailureSha) ||
        !f.assignmentId || !f.obligation || !["open", "resolved", "escalated"].includes(f.status) ||
        !SHA.test(f.source?.sourceSha) || !DIGEST.test(f.source?.reviewDigest) ||
        !Array.isArray(f.targets) || !f.targets.length || f.targets.some(p => !PATH.test(p)) ||
        (f.findingIndex !== undefined && (!Number.isSafeInteger(f.findingIndex) ||
          f.findingIndex < 0 || f.findingIndex >= 100 ||
          !DIGEST.test(f.reviewFindingsDigest ?? "") ||
          f.id !== digest({ root: f.rootFailureSha, assignment: f.assignmentId,
            sourceSha: f.source.sourceSha, reviewDigest: f.source.reviewDigest,
            index: f.findingIndex }))) ||
        (f.findingIndex === undefined && f.reviewFindingsDigest !== undefined) ||
        !Array.isArray(f.attempts) || f.attempts.some(s => !SHA.test(s))) ||
      raw.corrections.some(c => !SHA.test(c.rootFailureSha) || !SHA.test(c.sourceSha) ||
        !Array.isArray(c.changedPaths) || !c.changedPaths.length ||
        c.changedPaths.some(p => !PATH.test(p)) ||
        (c.result && (!SHA.test(c.result.successorSha) ||
          !DIGEST.test(c.result.reviewDigest) ||
          !["passed", "failed"].includes(c.result.status)))))
    throw Error("Repair ledger identity, bounds, or receipts are inconsistent.");
  return raw;
}
export async function inspectRepairLedger(job: JobStartResult, turnDigest: string): Promise<RepairLedger> {
  if (!DIGEST.test(turnDigest)) throw Error("Invalid Turn identity for repair ledger.");
  const path = pathFor(job, turnDigest);
  if (!existsSync(path))
    return { version: 1, jobId: job.jobId, threadId: job.threadId,
      turnDigest, findings: [], corrections: [] };
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256_000)
    throw Error("Unsafe repair ledger file.");
  return validateLedger(job, turnDigest, JSON.parse(await readFile(path, "utf8")) as RepairLedger);
}
async function save(job: JobStartResult, ledger: RepairLedger) {
  validateLedger(job, ledger.turnDigest, ledger);
  const file = pathFor(job, ledger.turnDigest);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + "." + randomUUID() + ".tmp";
  await writeFile(tmp, JSON.stringify(ledger, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await rename(tmp, file);
}
/** Called by the locked Blueprint correction controller after authenticating
 * the finding, and again after authenticating the independent approval. */
export async function recordBlueprintRepair(job: JobStartResult, turn: string, grant: BlueprintRepair) {
  const ledger = await inspectRepairLedger(job, turn);
  const repairs = ledger.blueprintRepairs ??= [];
  const prior = repairs.find(r => r.original.milestoneId === grant.original.milestoneId);
  if (prior) {
    // The original grant and any existing incident are immutable. Historical
    // #229 records can acquire their FIRST warning on authenticated replay;
    // never replace or reclassify an already recorded incident.
    const core = (value: BlueprintRepair) => ({ ...value, successor: undefined, incident: undefined });
    const initialIncident = (value?: BlueprintRevisionIncident) => value &&
      ({ ...value, successorApproval: undefined });
    if (JSON.stringify(core(prior)) !== JSON.stringify(core(grant)) ||
        prior.successor && JSON.stringify(prior.successor) !== JSON.stringify(grant.successor) ||
        prior.incident && JSON.stringify(initialIncident(prior.incident)) !==
          JSON.stringify(initialIncident(grant.incident)) ||
        prior.incident?.successorApproval &&
          JSON.stringify(prior.incident.successorApproval) !== JSON.stringify(grant.incident?.successorApproval) ||
        !prior.incident && prior.successor && grant.incident && !grant.incident.successorApproval)
      throw Error("Conflicting Milestone Blueprint repair authority.");
    const enriched = !prior.incident && !!grant.incident;
    if (enriched) prior.incident = grant.incident;
    if (!grant.successor || prior.successor) {
      if (enriched) await save(job, ledger);
      return;
    }
    prior.successor = grant.successor;
    if (grant.incident?.successorApproval) prior.incident!.successorApproval = grant.incident.successorApproval;
  } else {
    if (grant.successor) throw Error("Unadmitted Milestone Blueprint supersession.");
    repairs.push(grant);
  }
  await save(job, ledger);
}
/** Read-only operator projection of the SAME controller Repair ledger. The
 * original Event approval and independently reviewed successor are rechecked
 * before returning metadata. No quoted source, private transcripts or model
 * narrative is exported, and warnings are never scheduling gates. */
export async function inspectApprovalRevisionIncidents(job: JobStartResult, filter: {
  cause?: ApprovalRevisionCause; severity?: ApprovalRevisionSeverity;
  milestoneId?: string; id?: string; limit?: number; offset?: number;
} = {}) {
  if (filter.limit !== undefined && (!Number.isSafeInteger(filter.limit) || filter.limit < 1 || filter.limit > 100) ||
      filter.offset !== undefined && (!Number.isSafeInteger(filter.offset) || filter.offset < 0 || filter.offset > 100_000) ||
      filter.cause !== undefined && !["approval-escape", "newly-discovered-constraint", "author-directed", "unclassified"].includes(filter.cause) ||
      filter.severity !== undefined && !["warning", "info"].includes(filter.severity) ||
      filter.milestoneId !== undefined && !/^milestone\.[a-z][a-z0-9-]*$/.test(filter.milestoneId) ||
      filter.id !== undefined && !DIGEST.test(filter.id)) throw Error("Invalid approval-revision inspection filter.");
  const dir = join(job.stateDir, "repair-ledgers");
  let files: string[];
  try { files = (await readdir(dir)).filter(name => DIGEST.test(name.slice(0, -5)) && name.endsWith(".json")).sort(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") files = [];
    else throw error;
  }
  if (files.length > 1000) throw Error("Too many Repair ledgers for bounded operator inspection.");
  const records: Array<{ id: string; turnDigest: string; jobId: string; threadId: string;
    original: BlueprintRepair["original"]; originalReviewDigest: string;
    eventHead: string; triggeringSourceSha: string; cause: ApprovalRevisionCause;
    severity: ApprovalRevisionSeverity; trigger: BlueprintRevisionIncident["trigger"];
    originalApproval: BlueprintApprovalProvenance; successor: BlueprintRepair["successor"] | null;
    successorApproval: BlueprintApprovalProvenance | null;
    affectedWork: string[]; disposition: "corrected" | "awaiting-review" }> = [];
  for (const file of files) {
    const turnDigest = file.slice(0, -5);
    const ledger = await inspectRepairLedger(job, turnDigest);
    for (const repair of ledger.blueprintRepairs ?? []) {
      const incident = repair.incident;
      if (!incident || filter.cause && incident.cause !== filter.cause ||
          filter.severity && incident.severity !== filter.severity ||
          filter.milestoneId && repair.original.milestoneId !== filter.milestoneId ||
          filter.id && incident.id !== filter.id) continue;
      const eventPath = join(job.stateDir, "event-items", repair.original.milestoneId.slice(10) + ".json");
      const stat = await lstat(eventPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256_000)
        throw Error("Unverifiable Event approval link for post-approval incident.");
      const event = JSON.parse(await readFile(eventPath, "utf8")) as {
        jobId: string; threadId?: string; milestoneId: string; commitSha: string;
        expectedHead: string; blueprintPin: BlueprintRepair["original"];
        assignment: import("./event-specialist.js").EventAssignment;
      };
      if (event.jobId !== job.jobId || event.threadId && event.threadId !== job.threadId ||
          event.milestoneId !== repair.original.milestoneId || event.commitSha !== repair.eventHead ||
          event.expectedHead !== repair.original.sourceSha ||
          JSON.stringify(event.blueprintPin) !== JSON.stringify(repair.original) || !event.assignment)
        throw Error("Post-approval incident Event/approval proof mismatch.");
      const { milestoneBlueprintApprovalProvenance, originalBlueprintReviewDigest } =
        await import("./milestone-blueprint.js");
      const before = await milestoneBlueprintApprovalProvenance(job, repair.original, event.assignment);
      if (JSON.stringify(before) !== JSON.stringify(incident.originalApproval) ||
          await originalBlueprintReviewDigest(job, repair.original) !== repair.originalReviewDigest)
        throw Error("Post-approval incident original review proof mismatch.");
      if (repair.successor) {
        const after = await milestoneBlueprintApprovalProvenance(job, repair.successor, event.assignment);
        if (JSON.stringify(after) !== JSON.stringify(incident.successorApproval))
          throw Error("Post-approval incident successor review proof mismatch.");
      }
      records.push({ id: incident.id, turnDigest, jobId: job.jobId, threadId: job.threadId,
        original: repair.original, originalReviewDigest: repair.originalReviewDigest,
        eventHead: repair.eventHead, triggeringSourceSha: repair.sourceSha,
        cause: incident.cause, severity: incident.severity, trigger: incident.trigger,
        originalApproval: incident.originalApproval, successor: repair.successor ?? null,
        successorApproval: incident.successorApproval ?? null,
        affectedWork: incident.affectedWork,
        disposition: repair.successor ? "corrected" : "awaiting-review" });
    }
  }
  records.sort((a, b) => a.id.localeCompare(b.id));
  return { total: records.length, offset: filter.offset ?? 0,
    records: records.slice(filter.offset ?? 0, (filter.offset ?? 0) + (filter.limit ?? 50)) };
}

/** Only the authenticated Studio control adapter may request post-stop
 * guidance under the job writer lease. Historic allowance metadata is kept
 * for compatibility, never used to gate ordinary semantic progress. */
export async function authorizeRepairGuidance(job: JobStartResult, input: {
  turnDigest: string; authorId: string; rootFailureSha: string; sourceSha: string;
  headSha: string; guidance: string;
}): Promise<AuthorRepairGrant> {
  if (!DIGEST.test(input.turnDigest) || !SHA.test(input.rootFailureSha) ||
      !SHA.test(input.sourceSha) || !SHA.test(input.headSha) ||
      !input.authorId || input.authorId.length > 180 ||
      input.guidance !== input.guidance.trim() || !input.guidance.trim() ||
      input.guidance.length > 1200 ||
      /[\u0000-\u001f\u007f]/.test(input.guidance))
    throw Error("Invalid bounded author guidance or source identity.");
  const ledger = await inspectRepairLedger(job, input.turnDigest);
  const unresolved = ledger.findings.filter(f =>
    f.rootFailureSha === input.rootFailureSha && f.status === "open");
  if (!unresolved.length || !unresolved.some(f => f.source.sourceSha === input.headSha) ||
      !ledger.corrections.some(c => c.rootFailureSha === input.rootFailureSha &&
        c.sourceSha === input.sourceSha && c.result?.successorSha === input.headSha &&
        c.result.status === "failed") ||
      ledger.corrections.some(c => c.rootFailureSha === input.rootFailureSha && !c.result))
    throw Error("Author continuation requires the exact independently rejected correction source.");
  const grants = ledger.authorGrants ?? (ledger.authorGrants = []);
  const same = grants.find(grant => grant.authorId === input.authorId &&
    grant.rootFailureSha === input.rootFailureSha && grant.sourceSha === input.sourceSha &&
    grant.headSha === input.headSha && grant.guidance === input.guidance);
  if (same) {
    if (ledger.corrections.some(c => c.rootFailureSha === input.rootFailureSha &&
      c.sourceSha === same.headSha))
      throw Error("The previously authorized correction has already been submitted.");
    return same;
  }
  if (grants.length >= MAX_AUTHOR_REPAIR_GRANTS ||
      grants.filter(grant => grant.rootFailureSha === input.rootFailureSha).length >=
        MAX_AUTHOR_GRANTS_PER_ROOT)
    throw Error("Explicit repair allowance ceiling reached; a new reviewed Turn is required.");
  // A fresh semantic correction does not need an allowance. This explicit
  // source-bound grant only enables author steering after a genuine safe stop.
  const localLimit = localCorrectionLimit(ledger, input.rootFailureSha) + 1;
  const turnLimit = turnCorrectionLimit(ledger) + 1;
  const grant = { ...input, localLimit, turnLimit,
    id: digest({ authorId: input.authorId, rootFailureSha: input.rootFailureSha,
      sourceSha: input.sourceSha, headSha: input.headSha,
      guidance: input.guidance, localLimit, turnLimit }) };
  grants.push(grant);
  await save(job, ledger);
  return grant;
}

/** One index entry per observation in an authenticated, immutable review.
 * The source/review/index is identity ONLY for recovery and UI presentation.
 * Distinct creative findings in the same file remain distinct, and a reviewer
 * may reframe, combine or replace them on the next changed source. */
function recordFindings(ledger: RepairLedger, report: FindingReport, causedBy?: string) {
  const existing = ledger.findings.filter(f =>
    f.rootFailureSha === report.rootFailureSha && f.assignmentId === report.assignmentId);
  const onSource = existing.filter(f => f.source.sourceSha === report.sourceSha);
  const fingerprint = digest(report.findings);
  if (onSource.length) {
    if (onSource.some(f => f.source.reviewDigest !== report.reviewDigest ||
        (f.reviewFindingsDigest && f.reviewFindingsDigest !== fingerprint)) ||
        (onSource.some(f => f.findingIndex !== undefined) &&
          onSource.length !== report.findings.length))
      throw Error("Conflicting sealed review for one repair source.");
    if (onSource.some(f => f.status !== "open"))
      throw Error("Previously resolved review source cannot reopen a finding.");
    // Pre-v2 records may have combined same-shape defects. Preserve these
    // immutable historical entries; only newly sealed reviews get per-index
    // execution references.
    return onSource;
  }
  for (const f of existing) if (f.status === "open") f.status = "resolved";
  const active = report.findings.map((item, index): RepairFinding => ({
    id: digest({ root: report.rootFailureSha, assignment: report.assignmentId,
      sourceSha: report.sourceSha, reviewDigest: report.reviewDigest, index }),
    rootFailureSha: report.rootFailureSha, assignmentId: report.assignmentId,
    obligation: report.obligation, ...shape(item),
    status: "open", source: { sourceSha: report.sourceSha, reviewDigest: report.reviewDigest },
    findingIndex: index, reviewFindingsDigest: fingerprint,
    ...(causedBy ? { causedBy } : {}), attempts: [],
  }));
  ledger.findings.push(...active);
  return active;
}

/** This is an independently sourced prerequisite finding, not a fabricated
 * negative reviewer verdict. Only call after checking native evidence, the
 * original Turn and its signed Event Milestone field grant. */
export async function admitPrerequisiteRepair(job: JobStartResult, input: {
  turnDigest: string; milestoneId: string; path: string; sourceEventSha: string;
  proposalDigest: string; sourceSha: string; planVersion: number; causedBy?: string;
}): Promise<PrerequisiteRepair> {
  if (!DIGEST.test(input.turnDigest) || !DIGEST.test(input.proposalDigest) ||
      !SHA.test(input.sourceSha) || !SHA.test(input.sourceEventSha) ||
      !/^milestone\.[a-z][a-z0-9-]*$/.test(input.milestoneId) ||
      !/^milestones\/[a-z0-9._-]+\.md$/.test(input.path) ||
      !Number.isSafeInteger(input.planVersion) || input.planVersion < 1 ||
      (input.causedBy !== undefined && !SHA.test(input.causedBy)))
    throw Error("Prerequisite repair lacks authenticated source and owner identity.");
  const ledger = await inspectRepairLedger(job, input.turnDigest);
  const id = digest({ turnDigest: input.turnDigest, obligation: "milestone-closeout",
    milestoneId: input.milestoneId, path: input.path });
  const entries = ledger.prerequisites ?? (ledger.prerequisites = []);
  let item = entries.find(p => p.id === id);
  if (item && (item.milestoneId !== input.milestoneId ||
      item.path !== input.path || item.sourceEventSha !== input.sourceEventSha ||
      item.causedBy !== input.causedBy))
    throw Error("Prerequisite repair changed its canonical owner or origin.");
  // Execution-resource budgets, not semantic retry counts, govern another
  // independently reviewed narrow prerequisite correction.
  if (!item) {
    item = { id, obligation: "milestone-closeout", milestoneId: input.milestoneId,
      path: input.path, sourceEventSha: input.sourceEventSha,
      proposalDigest: input.proposalDigest, sourceSha: input.sourceSha,
      planVersion: input.planVersion, status: "open", attempts: [],
      ...(input.causedBy ? { causedBy: input.causedBy } : {}) };
    entries.push(item);
  } else if (item.sourceSha === input.sourceSha &&
      item.proposalDigest !== input.proposalDigest) {
    throw Error("Conflicting prerequisite proposal for one verified Story source.");
  } else if (item.sourceSha !== input.sourceSha) {
    if (item.attempts.some(a => !a.verdict))
      throw Error("Unsettled dependency repair cannot be replanned at a new HEAD.");
    item.sourceSha = input.sourceSha; item.proposalDigest = input.proposalDigest;
    item.planVersion = input.planVersion;
  }
  await save(job, ledger);
  return item;
}

/** A completed, changed and controller-audited specialist submission counts
 * once, even when later independent review rejects it. Uncertain calls do not. */
export async function submitPrerequisiteRepair(job: JobStartResult, input: {
  turnDigest: string; id: string; sourceSha: string; submittedSha: string; paths: string[];
}) {
  const ledger = await inspectRepairLedger(job, input.turnDigest);
  const finding = ledger.prerequisites?.find(p => p.id === input.id);
  if (!finding || finding.status !== "open" || !SHA.test(input.sourceSha) ||
      !SHA.test(input.submittedSha) || input.sourceSha === input.submittedSha ||
      input.paths.length !== 1 || input.paths[0] !== finding.path)
    throw Error("Dependency repair submission is not a bounded authorized edit.");
  const existing = finding.attempts.find(a => a.submittedSha === input.submittedSha);
  if (existing) {
    if (existing.sourceSha !== input.sourceSha ||
        JSON.stringify(existing.paths) !== JSON.stringify(input.paths))
      throw Error("Conflicting prerequisite correction submission.");
    return finding;
  }
  if (finding.sourceSha !== input.sourceSha ||
      finding.attempts.some(a => !a.verdict))
    throw Error("Stale or unsettled prerequisite correction.");
  finding.attempts.push({ sourceSha: input.sourceSha, submittedSha: input.submittedSha,
    paths: input.paths });
  await save(job, ledger);
  return finding;
}

/** A new independent verdict, not the writer's assessment, settles the cycle. */
export async function settlePrerequisiteRepair(job: JobStartResult, input: {
  turnDigest: string; id: string; submittedSha: string; reviewDigest: string;
  verdict: "passed" | "failed";
}) {
  if (!DIGEST.test(input.reviewDigest) || !SHA.test(input.submittedSha))
    throw Error("Prerequisite review lacks a sealed independent source.");
  const ledger = await inspectRepairLedger(job, input.turnDigest);
  const finding = ledger.prerequisites?.find(p => p.id === input.id);
  const attempt = finding?.attempts.find(a => a.submittedSha === input.submittedSha);
  if (!finding || !attempt) throw Error("Prerequisite review has no submitted correction.");
  if (attempt.verdict) {
    if (attempt.verdict !== input.verdict || attempt.reviewDigest !== input.reviewDigest)
      throw Error("Conflicting independent prerequisite verdict.");
    return finding;
  }
  attempt.verdict = input.verdict; attempt.reviewDigest = input.reviewDigest;
  if (input.verdict === "passed") finding.status = "resolved";
  await save(job, ledger);
  return finding;
}

/** Register sealed negative review at initial admission or after rereview.
 * Repeating a restart with the same source and review is idempotent. */
export async function admitRepairFinding(job: JobStartResult, report: FindingReport) {
  assertReport(report);
  const ledger = await inspectRepairLedger(job, report.turnDigest);
  const existing = ledger.findings.filter(f => f.rootFailureSha === report.rootFailureSha);
  if (existing.length && existing[0]!.assignmentId !== report.assignmentId)
    throw Error("Repair root switched its originally authorized assignment.");
  recordFindings(ledger, report);
  await save(job, ledger);
  return ledger;
}
/** A later independent reviewer may expose a *new* defect in work that was
 * legitimately passed at its historical source. The earlier PASS stays
 * immutable. The new finding is owned by the original assignment, and its
 * causal predecessor is the actual completed upstream correction. */
export async function admitCausalRevalidationFinding(job: JobStartResult,
  report: FindingReport & { causedBy: string }) {
  assertReport(report);
  if (!SHA.test(report.causedBy) || report.causedBy !== report.sourceSha)
    throw Error("Downstream revalidation has no authentic causal correction source.");
  const ledger = await inspectRepairLedger(job, report.turnDigest);
  const existing = ledger.findings.filter(f => f.rootFailureSha === report.rootFailureSha);
  if (existing.length && existing.some(f => f.assignmentId !== report.assignmentId))
    throw Error("Causal revalidation changed its originally assigned owner.");
  // Retain immutable previous negative reviews; the new review independently
  // owns its current semantic findings, even when paths/categories coincide.
  recordFindings(ledger, report, report.causedBy);
  await save(job, ledger);
  return ledger;
}
/** A model/provider failure or an interrupted Pi turn never enters here.
 * The completed writer must have submitted actual owned changed paths first. */
export async function submitRepairCorrection(job: JobStartResult, input: Submission) {
  const { turnDigest, rootFailureSha, sourceSha, changedPaths } = input;
  if (!SHA.test(rootFailureSha) || !SHA.test(sourceSha) || !Array.isArray(changedPaths) ||
      !changedPaths.length || changedPaths.some(path => !PATH.test(path)))
    throw Error("Correction has no bounded submitted source changes.");
  const ledger = await inspectRepairLedger(job, turnDigest);
  const previous = ledger.corrections.find(c =>
    c.rootFailureSha === rootFailureSha && c.sourceSha === sourceSha);
  if (previous) {
    if (JSON.stringify(previous.changedPaths) !== JSON.stringify(changedPaths))
      throw Error("Repair has a conflicting submission for one source revision.");
    return ledger;
  }
  const active = ledger.findings.filter(f => f.rootFailureSha === rootFailureSha &&
    f.source.sourceSha === sourceSha && f.status === "open");
  if (!active.length) throw Error("A repair submission has no admitted sealed finding.");
  if (ledger.corrections.some(c => c.rootFailureSha === rootFailureSha && !c.result))
    throw Error("A previous submitted correction still requires independent review.");
  ledger.corrections.push({ rootFailureSha, sourceSha, changedPaths });
  active.forEach(f => f.attempts.push(sourceSha));
  await save(job, ledger);
  return ledger;
}
/** Only an independently sealed successor verdict resolves a submitted
 * correction. Its current findings are independent of older semantic labels. */
export async function settleRepairReview(job: JobStartResult, report: Verdict) {
  if (!SHA.test(report.successorSha) || !["passed", "failed"].includes(report.status) ||
      report.status === "passed" && report.findings.length)
    throw Error("Repair review verdict has invalid successor evidence.");
  if (report.status === "failed") assertReport(report);
  const ledger = await inspectRepairLedger(job, report.turnDigest);
  const correction = ledger.corrections.find(c =>
    c.rootFailureSha === report.rootFailureSha && c.sourceSha === report.sourceSha);
  if (!correction) throw Error("Independent verdict lacks a submitted correction.");
  const result = { successorSha: report.successorSha,
    status: report.status, reviewDigest: report.reviewDigest };
  if (correction.result) {
    if (JSON.stringify(correction.result) !== JSON.stringify(result))
      throw Error("Conflicting independent verdict for a submitted correction.");
    return ledger;
  }
  correction.result = result;
  const former = ledger.findings.filter(f => f.rootFailureSha === report.rootFailureSha &&
    f.status === "open");
  const active = report.status === "failed"
    ? recordFindings(ledger, { ...report, sourceSha: report.successorSha }, report.sourceSha)
    : [];
  const retained = new Set(active.map(f => f.id));
  former.forEach(f => { if (!retained.has(f.id)) f.status = "resolved"; });
  await save(job, ledger);
  return ledger;
}
