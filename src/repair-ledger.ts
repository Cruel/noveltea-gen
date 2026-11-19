/** Thin, controller-owned index of substantive specialist repair findings.
 *
 * The job's sealed review/checkpoint receipts remain the source of truth for
 * semantic verdicts and Git revisions. This file only joins their identities
 * across paraphrased reviews and accounts for completed correction submissions
 * in the original Turn. All mutations run under the existing job writer lease.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JobStartResult } from "./job.js";
import type { IndependentReviewResult } from "./checkpoint-assurance.js";

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const PATH = /^[a-z][a-z0-9-]*\/[a-z0-9._-]+\.md$/;
export const MAX_LOCAL_CORRECTIONS = 2;
export const MAX_TURN_CORRECTIONS = 12;
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
  attempts: string[];
}
export interface RepairCorrection {
  rootFailureSha: string;
  sourceSha: string;
  changedPaths: string[];
  result?: { successorSha: string; status: "passed" | "failed"; reviewDigest: string };
}
export interface RepairLedger {
  version: 1;
  jobId: string;
  threadId: string;
  turnDigest: string;
  findings: RepairFinding[];
  corrections: RepairCorrection[];
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
function sameShape(left: RepairFinding, right: ReturnType<typeof shape>) {
  return left.category === right.category &&
    JSON.stringify(left.targets) === JSON.stringify(right.targets);
}
function validateLedger(job: JobStartResult, turnDigest: string, raw: RepairLedger) {
  if (raw.version !== 1 || raw.jobId !== job.jobId || raw.threadId !== job.threadId ||
      raw.turnDigest !== turnDigest || !Array.isArray(raw.findings) ||
      !Array.isArray(raw.corrections) || raw.findings.length > 512 ||
      raw.corrections.length > MAX_TURN_CORRECTIONS ||
      new Set(raw.findings.map(f => f.id)).size !== raw.findings.length ||
      new Set(raw.corrections.map(c => c.rootFailureSha + ":" + c.sourceSha)).size !== raw.corrections.length ||
      raw.findings.some(f => !DIGEST.test(f.id) || !SHA.test(f.rootFailureSha) ||
        !f.assignmentId || !f.obligation || !["open", "resolved", "escalated"].includes(f.status) ||
        !SHA.test(f.source?.sourceSha) || !DIGEST.test(f.source?.reviewDigest) ||
        !Array.isArray(f.targets) || !f.targets.length || f.targets.some(p => !PATH.test(p)) ||
        !Array.isArray(f.attempts) || f.attempts.length > MAX_TURN_CORRECTIONS ||
        f.attempts.some(s => !SHA.test(s))) ||
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
/** Match by controller-authenticated obligation/category/affected records, not
 * by the reviewer's mutable wording, source commit, or line number. Multiple
 * same-shape defects share the stricter correction allowance: a review cannot
 * reset its budget by splitting or recombining prose findings. Each full
 * original finding remains available in its immutable review receipt. */
function recordFindings(ledger: RepairLedger, report: FindingReport, causedBy?: string) {
  const existing = ledger.findings.filter(f =>
    f.rootFailureSha === report.rootFailureSha && f.assignmentId === report.assignmentId);
  const active: RepairFinding[] = [];
  for (const f of report.findings) {
    const key = shape(f);
    // Defect splitting/merging must not replenish the correction budget.
    const matches = existing.filter(prev => sameShape(prev, key));
    let selected = matches[0];
    if (!selected) {
      selected = {
        id: digest({ root: report.rootFailureSha, assignment: report.assignmentId,
          category: key.category, targets: key.targets,
          ordinal: ledger.findings.length }),
        rootFailureSha: report.rootFailureSha, assignmentId: report.assignmentId,
        obligation: report.obligation, category: key.category, targets: key.targets,
        status: "open", source: { sourceSha: report.sourceSha, reviewDigest: report.reviewDigest },
        ...(causedBy ? { causedBy } : {}), attempts: [],
      };
      ledger.findings.push(selected);
      existing.push(selected);
    } else if (selected.source.sourceSha === report.sourceSha &&
        selected.source.reviewDigest !== report.reviewDigest) {
      throw Error("Conflicting sealed review for one repair source.");
    }
    selected.source = { sourceSha: report.sourceSha, reviewDigest: report.reviewDigest };
    selected.status = "open";
    if (!active.some(finding => finding.id === selected.id)) active.push(selected);
  }
  return active;
}
function ensureRoom(ledger: RepairLedger, findings: RepairFinding[]) {
  if (ledger.corrections.length >= MAX_TURN_CORRECTIONS)
    throw Error("Turn correction ceiling exhausted; preserve verified work and findings.");
  if (findings.some(f => f.attempts.length >= MAX_LOCAL_CORRECTIONS))
    throw Error("Local corrections exhausted for a source-linked Repair finding.");
}

/** Register sealed negative review at initial admission or after rereview.
 * Repeating a restart with the same source and review is idempotent. */
export async function admitRepairFinding(job: JobStartResult, report: FindingReport) {
  assertReport(report);
  const ledger = await inspectRepairLedger(job, report.turnDigest);
  const existing = ledger.findings.filter(f => f.rootFailureSha === report.rootFailureSha);
  if (existing.length && existing[0]!.assignmentId !== report.assignmentId)
    throw Error("Repair root switched its originally authorized assignment.");
  const findings = recordFindings(ledger, report);
  await save(job, ledger); // Also preserve findings when admission is exhausted.
  ensureRoom(ledger, findings);
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
  ensureRoom(ledger, active);
  ledger.corrections.push({ rootFailureSha, sourceSha, changedPaths });
  active.forEach(f => f.attempts.push(sourceSha));
  await save(job, ledger);
  return ledger;
}
/** Only the independent sealed successor verdict resolves a finding. A
 * different damaged target becomes a causally linked new finding, not a reset
 * of the previous finding's attempts or the Turn-wide ceiling. */
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
