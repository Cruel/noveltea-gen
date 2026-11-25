/** Just-in-time, private Milestone planning at the verified Event boundary.
 * These receipts describe obligations, never canonical records or new write grants. */
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "./git-read-cache.js";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { authenticateBlueprintGrant, requestBlueprintAssessment, type BlueprintAssessmentGrant } from "./blueprint-reassessment.js";
import { getConfig } from "@langchain/langgraph";
import { createAssignmentLifecycleGraph, assignmentChildConfig, logicalAssignmentKey,
  type AssignmentIdentity, type AssignmentSubmission, type AssignmentOutcome } from "./generation-assignment-lifecycle.js";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import type { JobStartResult } from "./job.js";
import { readRecoveryFork } from "./recovery-fork-state.js";
import type { Plan } from "./architecture.js";
import type { EventAssignment } from "./event-specialist.js";
import type { SkillSnapshot } from "./snapshot.js";
import { openStoryProject } from "./project.js";
import { createProjectResourceLoader } from "./pi.js";
import { createJobModelRuntime } from "./model-runtime.js";
import { preparePiContext, PiBudgetPause } from "./job-pi-policy.js";
import { selectSandboxPiTools, SANDBOX_READ_ONLY_TOOLS } from "./sandbox-pi-tools.js";
import { promptStorySpecialist } from "./story-interruption.js";
import { reportControllerReviewPhase } from "./controller-review-phase.js";
import { recoverResponseContract, type ResponseContractFailure } from "./response-contract-recovery.js";
import { completedPinnedSkillReads } from "./pinned-skill-reads.js";
import { assertReviewCycleSession, reviewCycleId, reviewRoundProgress } from "./review-cycle.js";
import { milestoneDiagnosticDecision, milestoneDiagnosticEvidence, milestoneDiagnosticFingerprint,
  milestoneDiagnosticTrigger, parseMilestoneDiagnosis,
  type MilestoneDiagnosis, type MilestoneDiagnosticTrigger } from "./milestone-review-diagnostic.js";

const sha = (value: unknown) => createHash("sha256").update(
  typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const HASH = /^[a-f0-9]{64}$/;
const MILESTONE = /^milestone\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const REQUIRED = ["nt-event-design/SKILL.md", "nt-catalog/SKILL.md"] as const;
type Owner = "event" | "interactive" | "composition";
import { parseWriterDependencyFinding, type WriterDependencyFinding } from "./dependency-amendments.js";

export interface MilestoneBlueprint {
  upstreamCorrection?: WriterDependencyFinding;
  schema: "noveltea-milestone-blueprint/v1";
  milestoneId: string;
  events: Array<{
    id: string; purpose: string; dependsOn: string[];
    evidence: Array<{ anchorPath: string; source: string; observation: string;
      access: string; establishes: string; limits: string;
      /** Material Character sources, not a claim that a planned record exists. */
      characterSources?: Array<{ id: string; availability: "existing" | "prospective"; role: string }> }>;
    participants: string[]; knowledge: string;
    routes: Array<{ condition: string; consequence: string }>;
  }>;
  downstream: Array<{ owner: Owner; obligation: string }>;
}
type MilestoneEvent = MilestoneBlueprint["events"][number];
type MilestoneField = Exclude<keyof MilestoneEvent, "id">;
const MILESTONE_FIELDS: readonly MilestoneField[] =
  ["purpose", "knowledge", "dependsOn", "participants", "evidence", "routes"];
type MilestoneFindingBase = {
  anchorPath: string; requirement: string; reason: string; correction: string;
};
type MilestoneFinding = MilestoneFindingBase & (
  | { eventId: string; evidence?: {
      field: MilestoneField; quote: string; repair?: "replace" | "extend" } }
  | { eventId?: never; evidence: { target: "downstream"; index: number;
      field: "owner" | "obligation"; quote: string; repair: "replace" | "extend" } }
  | { eventId?: never; evidence: { target: "missing-downstream"; owner: Owner;
      quote: string; repair: "extend" } }
);
type EventPriorEvidence =
  | { kind: "revised" | "added"; eventId: string; field: MilestoneField;
      before: string; after: string }
  | { kind: "removed"; eventId: string; field: MilestoneField; before: string }
  | { kind: "current"; eventId: string; field: MilestoneField; quote: string };
type DownstreamPriorEvidence =
  | { target: "downstream"; eventId?: never; index: number; field: "owner" | "obligation";
      kind: "revised" | "added"; before: string; after: string }
  | { target: "downstream"; eventId?: never; index: number; field: "owner" | "obligation";
      kind: "removed"; before: string }
  | { target: "downstream"; eventId?: never; index: number; field: "owner" | "obligation";
      kind: "current"; quote: string }
  | { target: "missing-downstream"; eventId?: never; owner: Owner;
      kind: "added"; before: string; after: string }
  | { target: "missing-downstream"; eventId?: never; owner: Owner;
      kind: "current"; quote: string }
  | { target: "missing-downstream"; owner: "interactive"; eventId: string;
      kind: "not-required"; field: "purpose" | "routes"; before: string; after: string };
type MilestonePriorEvidence = EventPriorEvidence | DownstreamPriorEvidence;
export interface MilestoneBlueprintReview {
  /** Historical v1–v4 reviews replay under their original sealed methodology. */
  schema: "noveltea-milestone-blueprint-review/v1" |
    "noveltea-milestone-blueprint-review/v2" |
    "noveltea-milestone-blueprint-review/v3" | "noveltea-milestone-blueprint-review/v4" |
    "noveltea-milestone-blueprint-review/v5";
  status: "pass" | "revise";
  findings: MilestoneFinding[];
  prior?: Array<{ round: number; findingIndex: number;
    status: "resolved" | "improved" | "persisting" | "regressed";
    reason: string; evidence: { eventId: string; quote: string } | MilestonePriorEvidence }>;
}

function milestoneFieldText(event: MilestoneEvent, field: MilestoneField): string {
  const value = event[field];
  return typeof value === "string" ? value : JSON.stringify(value);
}
/** Exact whole-field values may be short (e.g. [] or ["key"]), while
 * excerpts must contain at least eight characters to avoid vague citations. */
function milestoneFieldQuote(event: MilestoneEvent, field: MilestoneField, quote: string): boolean {
  const value = event[field];
  if (quote === "[]") return Array.isArray(value) && value.length === 0;
  const serialized = milestoneFieldText(event, field);
  return !!quote && (quote === serialized ||
    quote.length >= 8 && serialized.includes(quote));
}
/** Citation admission and claim retention are different checks: a short,
 * valid whole-field quote remains present when other text is appended.
 * For an exact whole-array citation, retained members still count after an
 * array grows, while an empty array ceases to exist once populated. */
function milestoneFieldRetainsQuote(original: MilestoneEvent, current: MilestoneEvent,
  field: MilestoneField, quote: string): boolean {
  if (!quote) return false;
  const oldValue = original[field];
  const newValue = current[field];
  if (Array.isArray(oldValue) && Array.isArray(newValue) &&
      quote === JSON.stringify(oldValue)) {
    if (!oldValue.length) return newValue.length === 0;
    return oldValue.every(item => newValue.some(next =>
      JSON.stringify(next) === JSON.stringify(item)));
  }
  return milestoneFieldText(current, field).includes(quote);
}
const milestoneEvent = (draft: MilestoneBlueprint, id: string) =>
  draft.events.find(event => event.id === id);

/** v5 downstream findings cite an exact current entry, or the exact complete
 * collection when an obligation is missing. Indexes bind the rejected source;
 * a correction can move entries, but cannot preserve a rejected claim. */
function downstreamQuote(item: MilestoneBlueprint["downstream"][number],
  field: "owner" | "obligation", quote: string): boolean {
  const value = item[field];
  return !!quote && (quote === value || quote.length >= 8 && value.includes(quote));
}
function downstreamCorrectionEvidence(
  p: NonNullable<MilestoneBlueprintReview["prior"]>[number],
  finding: MilestoneFinding, original: MilestoneBlueprint,
  current: MilestoneBlueprint,
): boolean {
  const claim = finding.evidence;
  const proof = p.evidence;
  if (!claim || !("target" in claim) || !("target" in proof) ||
      claim.target !== proof.target) return false;
  if (claim.target === "missing-downstream") {
    if (proof.target !== "missing-downstream" || claim.owner !== proof.owner)
      return false;
    if (proof.kind === "not-required") {
      const before = milestoneEvent(original, proof.eventId);
      const after = milestoneEvent(current, proof.eventId);
      // A missing Interactive owner can be resolved by removing an implied
      // current-stage decision, not by manufacturing unnecessary downstream work.
      // A completely unchanged draft still needs independent diagnosis/replacement.
      return claim.owner === "interactive" && proof.owner === "interactive" &&
        !original.downstream.some(item => item.owner === "interactive") &&
        !current.downstream.some(item => item.owner === "interactive") &&
        !!before && !!after && ["purpose", "routes"].includes(proof.field) &&
        proof.before === milestoneFieldText(before, proof.field) &&
        proof.after === milestoneFieldText(after, proof.field) &&
        proof.before !== proof.after;
    }
    if (proof.kind === "current") return proof.quote === JSON.stringify(current.downstream);
    if (proof.kind !== "added" ||
        proof.before !== JSON.stringify(original.downstream)) return false;
    const added = current.downstream.find(item => JSON.stringify(item) === proof.after);
    return !!added && added.owner === claim.owner &&
      !original.downstream.some(item => JSON.stringify(item) === proof.after);
  }
  if (proof.target !== "downstream" || claim.index !== proof.index ||
      claim.field !== proof.field) return false;
  const rejected = original.downstream[claim.index];
  if (!rejected || !downstreamQuote(rejected, claim.field, claim.quote)) return false;
  if (proof.kind === "current") return current.downstream.some(item =>
    downstreamQuote(item, claim.field, proof.quote) && proof.quote === claim.quote);
  if (proof.before !== claim.quote) return false;
  // A field-owner correction must change the owner count, not merely rewrite
  // the same entry's obligation. Other independently valid owner entries may
  // remain; Composition may already be present when an owner is revised.
  if (claim.field === "owner") {
    const ownerCount = (design: MilestoneBlueprint, quote: string) =>
      design.downstream.filter(item => downstreamQuote(item, "owner", quote)).length;
    const retained = current.downstream.some(item =>
      JSON.stringify(item) === JSON.stringify(rejected));
    if (retained || ownerCount(current, claim.quote) >= ownerCount(original, claim.quote))
      return false;
    return proof.kind === "removed" ||
      (proof.kind === "revised" &&
        ["event", "interactive", "composition"].includes(proof.after) &&
        ownerCount(current, proof.after) > ownerCount(original, proof.after));
  }
  if (proof.kind === "removed")
    return !current.downstream.some(item =>
      JSON.stringify(item) === JSON.stringify(rejected) ||
      downstreamQuote(item, "obligation", claim.quote));
  if (proof.kind === "added" && (claim.repair !== "extend" ||
      current.downstream.some(item => JSON.stringify(item) === JSON.stringify(rejected))))
    return false; // An unchanged defective entry cannot be laundered by a duplicate extension.
  const repaired = current.downstream.some(item =>
    downstreamQuote(item, claim.field, proof.after) &&
    (proof.kind === "added"
      ? downstreamQuote(item, claim.field, claim.quote)
      : !downstreamQuote(item, claim.field, claim.quote)));
  return repaired && !original.downstream.some(item =>
    downstreamQuote(item, claim.field, proof.after)) &&
    (proof.kind === "added" || !current.downstream.some(item =>
      downstreamQuote(item, claim.field, claim.quote)));
}

function milestoneCorrectionEvidence(p: NonNullable<MilestoneBlueprintReview["prior"]>[number],
  finding: MilestoneFinding, original: MilestoneBlueprint, current: MilestoneBlueprint,
  legacyReplay = false,
): boolean {
  if (finding.evidence && "target" in finding.evidence)
    return downstreamCorrectionEvidence(p, finding, original, current);
  const evidence = p.evidence;
  if (!finding.eventId || !("kind" in evidence) || "target" in evidence ||
      evidence.eventId !== finding.eventId ||
      !(MILESTONE_FIELDS as readonly string[]).includes(evidence.field))
    return false;
  const source = milestoneEvent(original, finding.eventId);
  if (!source) return false;
  const before = milestoneFieldText(source, evidence.field);
  // New v3 findings bind the repair to the very field and quote that were
  // independently rejected, so unrelated Event or field edits cannot launder a PASS.
  if (finding.evidence && !("target" in finding.evidence) &&
      (finding.evidence.field !== evidence.field ||
       (evidence.kind === "current"
         ? finding.evidence.quote !== evidence.quote
         : finding.evidence.quote !== evidence.before)))
    return false;
  if (evidence.kind === "removed")
    return milestoneFieldQuote(source, evidence.field, evidence.before) &&
      !milestoneEvent(current, finding.eventId);
  const target = milestoneEvent(current, finding.eventId);
  if (!target) return false;
  const after = milestoneFieldText(target, evidence.field);
  if (evidence.kind === "revised" || evidence.kind === "added") {
    // An additive repair is permitted only if the ORIGINAL rejected finding
    // expressly classified the defect as an omission. A later reviewer may
    // not reinterpret a removal-required claim as a benign omission.
    if (evidence.kind === "added" && !legacyReplay &&
        finding.evidence?.repair !== "extend") return false;
    if (!milestoneFieldQuote(source, evidence.field, evidence.before) ||
        !milestoneFieldQuote(target, evidence.field, evidence.after) ||
        milestoneFieldQuote(source, evidence.field, evidence.after) || before === after)
      return false;
    // Replacement removes the quoted defect. An omission correction may
    // instead RETAIN valid text, provided new field-specific evidence appears.
    return evidence.kind === "added"
      ? milestoneFieldRetainsQuote(source, target, evidence.field, evidence.before)
      : !milestoneFieldRetainsQuote(source, target, evidence.field, evidence.before);
  }
  return evidence.kind === "current" &&
    milestoneFieldRetainsQuote(source, target, evidence.field, evidence.quote);
}

/** Require changed, source-bound evidence against EACH rejected target before
 * admitting a new independent PASS, not just an unrelated global draft diff. */
export function milestonePassCorrections(draft: MilestoneBlueprint,
  previous: readonly Round[], review: MilestoneBlueprintReview): boolean {
  if (review.status !== "pass" || !previous.length) return true;
  if (!["noveltea-milestone-blueprint-review/v3",
        "noveltea-milestone-blueprint-review/v4",
        "noveltea-milestone-blueprint-review/v5"].includes(review.schema)) return true; // sealed legacy
  return previous.every((round, index) => independentFindings(round).every((finding, findingIndex) => {
    const proof = review.prior?.find(p => p.round === index && p.findingIndex === findingIndex);
    return proof?.status === "resolved" &&
      milestoneCorrectionEvidence(proof, finding, round.draft, draft,
        review.schema === "noveltea-milestone-blueprint-review/v3") &&
      "kind" in proof.evidence && proof.evidence.kind !== "current";
  }));
}
interface Lineage {
  jobId: string; threadId: string; baseSha: string; executionHead: string;
  milestoneId: string; planVersion: number; planDigest: string;
  contractDigest: string; sourceDigest: string; snapshotId: string;
  provider: string; model: string; taskDigest: string; reviewCycleId: string;
}
type Phase = "admitted" | "planning" | "draft" | "reviewing" | "revision" |
  "diagnosing" | "stopped" | "approved";
interface SessionSeal {
  id: string; file: string; bytes: number; digest: string;
}
interface Round { draft: MilestoneBlueprint; review: MilestoneBlueprintReview;
  draftDigest: string; reviewDigest: string;
  /** Only present when the controller vetoes an actual independent PASS.
   * The effective rejection is not attributed to the independent reviewer. */
  reviewerVerdict?: MilestoneBlueprintReview }

/** Controller vetoes are checked by the controller on every draft, not
 * masqueraded as independent review findings requiring a particular repair.
 * Either side of a source relationship may be changed to resolve it. */
function independentFindings(round: Round | undefined): readonly MilestoneFinding[] {
  return round?.reviewerVerdict?.findings ?? round?.review.findings ?? [];
}

/** Reconstruct nonprogress entirely from sealed rounds, including after a restart.
 * Cosmetic rewrites, oscillation, and newly discovered issues alone cannot
 * reset the two-correction reassessment threshold. */
export function milestoneReviewStagnation(rounds: readonly Round[], assignment?: SourceScope): number {
  let stalled = 0;
  for (let i = 1; i < rounds.length; i++) {
    const prior = rounds[i - 1]!;
    const current = rounds[i]!;
    const nextControllerFindings = prior.reviewerVerdict && assignment
      ? milestoneBlueprintSourceFindings(current.draft, assignment) : null;
    const resolvedControllerFinding = nextControllerFindings && assignment &&
      milestoneBlueprintSourceFindings(prior.draft, assignment).some(old =>
        !nextControllerFindings.some(next =>
          old.category === next.category && old.eventId === next.eventId &&
          old.offendingId === next.offendingId && old.expected === next.expected));
    const material = !!resolvedControllerFinding || (current.review.prior ?? []).some(p => {
      if (p.status !== "resolved" && p.status !== "improved") return false;
      const source = rounds[p.round];
      const finding = independentFindings(source)[p.findingIndex];
      if (!finding) return false;
      if (finding.evidence && "target" in finding.evidence) {
        return current.review.schema === "noveltea-milestone-blueprint-review/v5" &&
          "kind" in p.evidence && p.evidence.kind !== "current" &&
          milestoneCorrectionEvidence(p, finding, source!.draft, current.draft) &&
          (sha(prior.draft.downstream) !== sha(current.draft.downstream) ||
            p.evidence.kind === "not-required" && sha(prior.draft.events) !== sha(current.draft.events));
      }
      if (!finding.eventId || p.evidence.eventId !== finding.eventId) return false;
      if (current.review.schema === "noveltea-milestone-blueprint-review/v3" ||
          current.review.schema === "noveltea-milestone-blueprint-review/v4" ||
          current.review.schema === "noveltea-milestone-blueprint-review/v5") {
        if (!source || !milestoneCorrectionEvidence(p, finding, source.draft, current.draft,
          current.review.schema === "noveltea-milestone-blueprint-review/v3") ||
            !("kind" in p.evidence) || "target" in p.evidence) return false;
        const proof = p.evidence as EventPriorEvidence;
        const before = milestoneEvent(prior.draft, finding.eventId);
        const after = milestoneEvent(current.draft, finding.eventId);
        if (proof.kind === "removed") return !!before && !after;
        if (!["revised", "added"].includes(proof.kind) || !before || !after ||
            !("before" in proof) || !("after" in proof)) return false;
        const original = milestoneEvent(source.draft, finding.eventId);
        return !!original &&
          milestoneFieldRetainsQuote(original, before, proof.field, proof.before) &&
          (proof.kind === "added"
            ? milestoneFieldRetainsQuote(original, after, proof.field, proof.before)
            : !milestoneFieldRetainsQuote(original, after, proof.field, proof.before)) &&
          milestoneFieldQuote(after, proof.field, proof.after) &&
          !milestoneFieldRetainsQuote(after, before, proof.field, proof.after);
      }
      // Older sealed v2 reviews retain their historical convergence policy.
      if ("kind" in p.evidence) return false;
      const before = milestoneEvent(prior.draft, finding.eventId);
      const after = milestoneEvent(current.draft, finding.eventId);
      const legacy = p.evidence as { eventId: string; quote: string };
      return !!before && !!after && sha(before) !== sha(after) &&
        JSON.stringify(after).includes(legacy.quote) &&
        !JSON.stringify(before).includes(legacy.quote);
    });
    // The Milestone parser separately verifies a passing verdict and its
    // rejected-field corrections; this reconstruction accounts for negative
    // review progress only, from exactly the same sealed source evidence.
    stalled = reviewRoundProgress({
      previousDigests: rounds.slice(0, i).map(round => round.draftDigest),
      draftDigest: current.draftDigest, material,
      regressed: (current.review.prior ?? []).some(p => p.status === "regressed"),
      stalledBefore: stalled, status: "revise",
    }).stalled;
  }
  return stalled;
}
interface DiagnosticReceipt {
  schema: "noveltea-milestone-diagnostic-receipt/v1";
  round: number; trigger: MilestoneDiagnosticTrigger;
  evidenceDigest: string; caseFingerprint: string;
  sources: { task: string; contract: unknown };
  diagnosis: MilestoneDiagnosis; session: SessionSeal;
}
export interface Supersession { original: MilestoneBlueprintPin; eventHead: string; turnDigest: string; evidenceDigest: string; originalReviewDigest: string }
interface Receipt {
  supersedes?: Supersession;
  schema: "noveltea-milestone-plan-receipt/v1";
  lineage: Lineage; phase: Phase; rounds: Round[];
  draft?: MilestoneBlueprint; writer?: SessionSeal; reviewer?: SessionSeal;
  approvedDigest?: string;
  diagnostics?: DiagnosticReceipt[];
  reviewerRole?: "reviewer" | "replacement";
  reviewerHistory?: Array<{ role: "reviewer" | "replacement"; session: SessionSeal }>;
  /** Each replacement starts a fresh independently adjudicated verdict lineage. */
  reviewStart?: number;
  reviewStarts?: number[];
  stopReason?: string;
  assignmentKey?: string;
}
export interface MilestoneBlueprintPin {
  milestoneId: string; sourceSha: string; digest: string; cycleId: string;
}
/** A fork's immutable, admission-verified proof of an inherited reviewed plan.
 * This carries only the approved design, never a replayable Pi conversation. */
export interface InheritedMilestoneBlueprint {
  pin: MilestoneBlueprintPin;
  design: MilestoneBlueprint;
  sourceDigest: string;
}
function fileFor(job: JobStartResult, id: string) {
  if (!MILESTONE.test(id)) throw Error("Invalid Milestone Blueprint target identifier.");
  return join(job.stateDir, "milestone-blueprints", id.slice("milestone.".length) + ".json");
}
function diagnosticFileFor(job: JobStartResult, id: string, cycleId: string,
  round: number) {
  if (!MILESTONE.test(id) || !HASH.test(cycleId) ||
      !Number.isSafeInteger(round) || round < 0)
    throw Error("Invalid Milestone diagnostic lineage.");
  return join(job.stateDir, "milestone-blueprint-diagnostics",
    id.slice("milestone.".length) + "-" + cycleId + "-" + round + ".json");
}
async function readSealedDiagnosis(job: JobStartResult, receipt: Receipt,
  round: number): Promise<DiagnosticReceipt | null> {
  const path = diagnosticFileFor(job, receipt.lineage.milestoneId,
    receipt.lineage.reviewCycleId, round);
  if (!existsSync(path)) return null;
  if (await realpath(path) !== path || !(await lstat(path)).isFile())
    throw Error("Milestone diagnosis is not an immutable private file.");
  return JSON.parse(await readFile(path, "utf8")) as DiagnosticReceipt;
}
async function sealDiagnosis(job: JobStartResult, receipt: Receipt,
  diagnosis: DiagnosticReceipt): Promise<void> {
  const path = diagnosticFileFor(job, receipt.lineage.milestoneId,
    receipt.lineage.reviewCycleId, diagnosis.round);
  await mkdir(dirname(path), { recursive: true });
  // An already-present diagnosis is evidence to reconcile, NEVER an invitation
  // to replace its assessment with another model response.
  await writeFile(path, JSON.stringify(diagnosis, null, 2) + "\n",
    { flag: "wx", mode: 0o600 });
}
function historicalFileFor(job: JobStartResult, pin: MilestoneBlueprintPin) {
  if (!MILESTONE.test(pin.milestoneId) || !HASH.test(pin.cycleId))
    throw Error("Invalid archived Milestone Blueprint pin.");
  return join(job.stateDir, "milestone-blueprint-history",
    pin.milestoneId.slice("milestone.".length) + "-" + pin.cycleId + ".json");
}

function git(job: JobStartResult, ...args: string[]) {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"])
    delete env[key];
  return execFileSync("git", args, { cwd: job.worktreeRoot, env,
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
}
const canonicalGitPath = (job: JobStartResult, path: string) =>
  job.storyRelativePath ? job.storyRelativePath + "/" + path : path;
async function sourceDigest(job: JobStartResult, paths: string[], head: string) {
  if (!/^[a-f0-9]{40}$/.test(head) || !paths.length ||
      paths.some(p => !/^[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*\.md$/.test(p)) ||
      new Set(paths).size !== paths.length)
    throw Error("Milestone planning requires bounded canonical source paths and a verified SHA.");
  return sha(paths.slice().sort().map(path => ({
    path, digest: sha(git(job, "show", head + ":" + canonicalGitPath(job, path))),
  })));
}
function string(value: unknown, max = 1200): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= max;
}
function strings(value: unknown, max = 12): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every(x => string(x, 150));
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function exact(value: unknown, fields: string[]): value is Record<string, unknown> {
  return object(value) && Object.keys(value).sort().join("|") === fields.sort().join("|");
}
function parse(text: string): unknown {
  const trimmed = text.trim().replace(/^\`\`\`(?:json)?\s*\n/i, "").replace(/\n\`\`\`\s*$/, "");
  if (Buffer.byteLength(trimmed) > 18000) throw Error("Milestone plan exceeds its private planning budget.");
  return JSON.parse(trimmed) as unknown;
}
class MilestoneContractError extends Error {
  constructor(readonly path: string, readonly expected: string) { super(path + ": " + expected); }
}
function invalid(path: string, expected: string): never { throw new MilestoneContractError(path, expected); }
/** All historical identifiers are controller-generated, never inferred by a model. */
export function milestoneReviewFindingIndex(previous: readonly Round[]) {
  return previous.flatMap((round, i) => independentFindings(round).map((finding, j) => ({
    round: i, findingIndex: j, ...(finding.eventId ? { eventId: finding.eventId } : {}),
    evidence: finding.evidence,
  })));
}
function milestoneReviewContract(draft: MilestoneBlueprint, assignment: Pick<EventAssignment, "milestonePath" | "sourcePaths">,
  previous: readonly Round[]) {
  return "Round and findingIndex are ZERO-BASED. The first review is round 0. " +
    "Controller veto findings are independently rechecked by the controller, not included as prior reviewer identities. " +
    "Use each of these EXACT prior identities once, with its original Event ID or downstream target and field: " +
    JSON.stringify(milestoneReviewFindingIndex(previous)) +
    ". Current provisional Event IDs: " + JSON.stringify(draft.events.map(e => e.id)) +
    ". Valid Event fields: " + MILESTONE_FIELDS.join(", ") +
    ". Use a provisional Event ID, not a canonical event.* record ID. " +
    "For prior findings use compact evidence selectors: {kind:'revised|added|removed|current'} for Events; " +
    "downstream revised/added additionally specify index of the NEW downstream entry. " +
    "For a missing Interactive owner corrected by revising away an implied choice use " +
    "{kind:'not-required',eventId:retained revised Event ID,field:'purpose|routes'}. " +
    "Controller binds the original rejected identity, before and after values. Do not repeat escaped field arrays. " +
    "Current canonical source paths: " + JSON.stringify(assignment.sourcePaths) + ".";
}
export function parseMilestoneBlueprint(text: string, assignment: Pick<EventAssignment,
  "milestoneId" | "milestonePath" | "sourcePaths" | "characterIds">,
  policy: "admission" | "sealed-replay" | "review-draft" | "sealed-rejected" = "admission"): MilestoneBlueprint {
  let raw: unknown;
  try { raw = parse(text); } catch { throw Error("Milestone planner returned invalid or oversized JSON."); }
  if (!exact(raw, ["schema", "milestoneId", "events", "downstream",
        ...(object(raw) && "upstreamCorrection" in raw ? ["upstreamCorrection"] : [])]) ||
      raw.schema !== "noveltea-milestone-blueprint/v1" || raw.milestoneId !== assignment.milestoneId ||
      !Array.isArray(raw.events) || raw.events.length < 1 || raw.events.length > 5 ||
      !Array.isArray(raw.downstream) || raw.downstream.length < 1 || raw.downstream.length > 10)
    throw Error("Invalid bounded Milestone Blueprint or target identity.");
  const seen = new Set<string>();
  for (const [i, event] of raw.events.entries()) {
    const path = "events[" + i + "]";
    if (!exact(event, ["id", "purpose", "dependsOn", "evidence", "participants", "knowledge", "routes"]))
      invalid(path, "expected exactly id, purpose, dependsOn, evidence, participants, knowledge, routes");
    if (typeof event.id !== "string" || !/^[a-z][a-z0-9-]{0,60}$/.test(event.id) || seen.has(event.id))
      invalid(path + ".id", "expected a unique provisional slug (not a canonical event.* ID)");
    if (!string(event.purpose)) invalid(path + ".purpose", "expected nonempty bounded text");
    if (!string(event.knowledge)) invalid(path + ".knowledge", "expected one nonempty bounded STRING, not an array/object");
    if (!strings(event.dependsOn, 4))
      invalid(path + ".dependsOn", "expected at most four provisional Event ID strings");
    if (!strings(event.participants, 12) || new Set(event.participants).size !== event.participants.length ||
        event.participants.some(id => !/^character\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id)))
      invalid(path + ".participants", "expected at most twelve unique typed Character IDs");
    if (!Array.isArray(event.evidence) || !event.evidence.length || event.evidence.length > 8)
      invalid(path + ".evidence", "expected 1–8 concrete evidence entries");
    if (!Array.isArray(event.routes) || event.routes.length > 5)
      invalid(path + ".routes", "expected 0–5 route objects");
    seen.add(String(event.id));
    for (const [j, e] of event.evidence.entries()) {
      if (!exact(e, ["anchorPath", "source", "observation", "access", "establishes", "limits",
          ...(object(e) && "characterSources" in e ? ["characterSources"] : [])]) ||
          !string(e.anchorPath, 300) ||
          ![e.source, e.observation, e.access, e.establishes, e.limits]
            .every(value => string(value)))
        invalid(path + ".evidence[" + j + "]", "expected exact anchorPath, source, observation, access, establishes, limits; bounded nonempty strings and a canonical anchor from " + JSON.stringify(assignment.sourcePaths));
      if ((policy === "admission" || policy === "review-draft") && !("characterSources" in e))
        invalid(path + ".evidence[" + j + "].characterSources",
          "required explicit material Character source array; use [] for non-Character evidence");
      if ("characterSources" in e) {
        const sourcePath = path + ".evidence[" + j + "].characterSources";
        if (!Array.isArray(e.characterSources) || e.characterSources.length > 12)
          invalid(sourcePath, "expected at most twelve material Character sources");
        for (const source of e.characterSources) {
          if (!exact(source, ["id", "availability", "role"]) ||
              typeof source.id !== "string" || !/^character\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(source.id) ||
              !string(source.role, 400) ||
              (source.availability !== "existing" && source.availability !== "prospective"))
            invalid(sourcePath, "expected typed Character ID, existing|prospective availability and bounded material evidence role");
        }
      }
    }
    for (const [j, route] of event.routes.entries())
      if (!exact(route, ["condition", "consequence"]) ||
          !string(route.condition) || !string(route.consequence))
        invalid(path + ".routes[" + j + "]", "expected exactly nonempty bounded condition and consequence strings");
  }
  for (const [i, item] of raw.downstream.entries())
    if (!exact(item, ["owner", "obligation"]) ||
        typeof item.owner !== "string" ||
        !["event", "interactive", "composition"].includes(item.owner) ||
        !string(item.obligation))
      invalid("downstream[" + i + "]", "Milestone downstream obligation needs exact owner (event, interactive or composition) and nonempty obligation");
  if (raw.upstreamCorrection !== undefined) {
    const finding = parseWriterDependencyFinding(raw.upstreamCorrection);
    if (!finding.affectedIds.includes(assignment.milestoneId) ||
        finding.sources.some(s => !assignment.sourcePaths.includes(s.path)))
      throw Error("Milestone upstream correction must cite the selected source scope.");
  }
  const draft = raw as unknown as MilestoneBlueprint;
  if (policy === "admission" || policy === "sealed-replay")
    assertMilestoneSources(draft, assignment);
  return draft;
}
/** A well-shaped rejected proposal is evidence, not an authorized plan.
 * Reconstruct findings exclusively from the submitted draft and trusted assignment.
 * Never infer who actually provided testimony from the subject's name or role prose. */
type SourceScope = Pick<EventAssignment, "milestoneId" | "milestonePath" | "sourcePaths" | "characterIds">;
export interface MilestoneSourceFinding {
  category: "source" | "authority" | "semantic";
  path: string;
  offendingId: string;
  eventId?: string;
  expected: string;
  trustedContext: { sourcePaths: string[]; characterIds: string[] };
  submittedContext?: { participants: string[]; earlierEvents: string[] };
}
export function milestoneBlueprintSourceFindings(draft: MilestoneBlueprint, assignment: SourceScope): MilestoneSourceFinding[] {
  const findings: MilestoneSourceFinding[] = [];
  const context = { sourcePaths: assignment.sourcePaths, characterIds: assignment.characterIds };
  const earlierEvents: string[] = [];
  for (const [i, event] of draft.events.entries()) {
    const path = "events[" + i + "]";
    const report = (category: MilestoneSourceFinding["category"], field: string, offendingId: string, expected: string) =>
      findings.push({ category, path: path + field, offendingId, eventId: event.id, expected,
        trustedContext: context, submittedContext: { participants: event.participants, earlierEvents: [...earlierEvents] } });
    for (const [j, dependency] of event.dependsOn.entries())
      if (!earlierEvents.includes(dependency))
        report("semantic", ".dependsOn[" + j + "]", dependency, "Dependency must identify an earlier provisional Event.");
    const declared = new Map<string, string>();
    for (const [j, evidence] of event.evidence.entries()) {
      const field = ".evidence[" + j + "]";
      if (!assignment.sourcePaths.includes(evidence.anchorPath))
        report("authority", field + ".anchorPath", evidence.anchorPath, "Use an authorized canonical anchor from the original source scope.");
      const local = new Set<string>();
      for (const [k, source] of (evidence.characterSources ?? []).entries()) {
        const sourceField = field + ".characterSources[" + k + "]";
        if (!event.participants.includes(source.id))
          report("source", sourceField + ".id", source.id, "Declare actual material providers, not merely evidence subjects. Verify whether this Character provides evidence or should be removed, and include actual providers in participants.");
        if (source.availability === "existing" && !assignment.characterIds.includes(source.id))
          report("authority", sourceField + ".availability", source.id, "Existing Character must belong to the authorized inventory; a genuinely needed unrealized provider may be prospective.");
        if (local.has(source.id) || (declared.has(source.id) && declared.get(source.id) !== source.availability))
          report("source", sourceField + ".id", source.id, "Character source declarations must be unique per evidence and have consistent availability within the Event.");
        local.add(source.id);
        declared.set(source.id, source.availability);
      }
    }
    for (const [j, participant] of event.participants.entries())
      if (!assignment.characterIds.includes(participant) && declared.get(participant) !== "prospective")
        report("source", ".participants[" + j + "]", participant, "Unknown Character requires a prospective material source declaration.");
    earlierEvents.push(event.id);
  }
  if (!draft.downstream.some(item => item.owner === "composition"))
    findings.push({ category: "semantic", path: "downstream", offendingId: "composition",
      expected: "Milestone plan must identify the downstream Composition owner.", trustedContext: context });
  return findings;
}
export class MilestoneSourceError extends Error {
  constructor(readonly findings: readonly MilestoneSourceFinding[]) {
    super(findings[0]!.path + ": " + findings[0]!.expected);
    this.name = "MilestoneSourceError";
  }
}
function assertMilestoneSources(draft: MilestoneBlueprint, assignment: SourceScope) {
  const findings = milestoneBlueprintSourceFindings(draft, assignment);
  if (findings.length)
    throw new MilestoneSourceError(findings);
}
/** Reuse the existing correction cycle for a controller-vetoed PASS, while
 * retaining the actual independent response as separate transcript evidence.
 * Group exact field targets; the full typed findings remain reconstructible
 * from the same sealed draft and assignment (and are sent to the planner). */
function controllerReviewDisposition(draft: MilestoneBlueprint, assignment: SourceScope,
  verdict: MilestoneBlueprintReview): MilestoneBlueprintReview {
  if (verdict.status !== "pass") return verdict;
  const sources = milestoneBlueprintSourceFindings(draft, assignment);
  if (!sources.length) return verdict;
  const findings: MilestoneFinding[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const event = source.eventId && milestoneEvent(draft, source.eventId);
    const field = source.path.match(/^events\[\d+\]\.(dependsOn|participants|evidence)/)?.[1] as MilestoneField | undefined;
    const key = source.eventId + ":" + field;
    if (seen.has(key)) continue;
    seen.add(key);
    const base = { anchorPath: assignment.milestonePath,
      requirement: "Controller source validation: " + source.path,
      reason: "Independent PASS conflicts with the deterministic source finding for " + source.offendingId,
      correction: source.expected };
    if (event && field) {
      const exactId = JSON.stringify(source.offendingId);
      const serialized = milestoneFieldText(event, field);
      const anchor = '"anchorPath":' + exactId;
      const quote = exactId.length >= 8 && serialized.includes(exactId) ? exactId :
        field === "evidence" && serialized.includes(anchor) ? anchor : serialized;
      findings.push({ ...base, eventId: event.id, evidence: { field, quote, repair: "replace" } });
    } else if (source.path === "downstream") findings.push({ ...base,
      evidence: { target: "missing-downstream", owner: "composition",
        quote: JSON.stringify(draft.downstream), repair: "extend" } });
  }
  return { ...verdict, status: "revise", findings: findings.slice(0, 12) };
}
function sourceFindingFeedback(draft: MilestoneBlueprint, assignment: SourceScope): string {
  const findings = milestoneBlueprintSourceFindings(draft, assignment);
  return findings.length ? "\nCONTROLLER SOURCE FINDINGS (data, not new authority): " + JSON.stringify(findings) +
    "\nCorrect the material relationships from the original canonical sources, not merely JSON syntax. Do not infer providers from subjects, invent canon, or add participants solely to satisfy a field check. An independent Review must reject any unresolved controller finding and cite the exact defective Event field or missing downstream obligation." : "";
}

/** Readiness is separate from narrative validity. Only dependencies consumed
 * by this Event are checked; later Interactive/Composition work stays prospective. */
export function milestoneCharacterPrerequisites(design: MilestoneBlueprint,
  assignment: Pick<EventAssignment, "characterIds">) {
  return design.events.flatMap(event => event.evidence.flatMap((evidence, index) =>
    (evidence.characterSources ?? []).filter(source =>
      !assignment.characterIds.includes(source.id)).map(source => ({
        eventId: event.id, evidenceIndex: index, anchorPath: evidence.anchorPath,
        characterId: source.id, role: source.role, owner: "nt-character-development" as const,
      }))));
}

/** Compact wire evidence is not a second review contract. Reconstruct the
 * exact v5 proof from sealed original findings and the current draft, then
 * apply the existing field-specific validation. Explicit conflicting values
 * are never overwritten. */
function bindCompactReviewEvidence(raw: unknown, draft: MilestoneBlueprint,
  previous: readonly Round[]) {
  if (!object(raw) || raw.schema !== "noveltea-milestone-blueprint-review/v5") return;
  if (Array.isArray(raw.findings)) for (const item of raw.findings) {
    if (!object(item) || !object(item.evidence)) continue;
    const e = item.evidence;
    if (e.target === "missing-downstream" &&
        exact(e, ["target", "owner", "repair"]))
      e.quote = JSON.stringify(draft.downstream);
  }
  if (!Array.isArray(raw.prior)) return;
  for (const item of raw.prior) {
    if (!object(item) || !object(item.evidence) ||
        !Number.isSafeInteger(item.round) || !Number.isSafeInteger(item.findingIndex)) continue;
    const original = previous[item.round as number];
    const finding = independentFindings(original)[item.findingIndex as number];
    const claim = finding?.evidence, e = item.evidence;
    if (!claim || !original || typeof e.kind !== "string") continue;
    if ("target" in claim && claim.target === "missing-downstream") {
      if (e.kind === "not-required" && exact(e, ["kind", "eventId", "field"])) {
        const before = milestoneEvent(original.draft, String(e.eventId));
        const after = milestoneEvent(draft, String(e.eventId));
        if (claim.owner === "interactive" && before && after &&
            (e.field === "routes" || e.field === "purpose"))
          item.evidence = { target: "missing-downstream", owner: claim.owner, kind: e.kind,
            eventId: e.eventId, field: e.field, before: milestoneFieldText(before, e.field),
            after: milestoneFieldText(after, e.field) };
      } else if (e.kind === "current" && exact(e, ["kind"])) {
        item.evidence = { target: claim.target, owner: claim.owner, kind: e.kind,
          quote: JSON.stringify(draft.downstream) };
      } else if (e.kind === "added" && exact(e, ["kind", "index"]) &&
          Number.isSafeInteger(e.index) && draft.downstream[e.index as number]) {
        item.evidence = { target: claim.target, owner: claim.owner, kind: e.kind,
          before: JSON.stringify(original.draft.downstream),
          after: JSON.stringify(draft.downstream[e.index as number]) };
      }
    } else if ("target" in claim && claim.target === "downstream") {
      const base = { target: claim.target, index: claim.index, field: claim.field, kind: e.kind };
      if (e.kind === "current" && exact(e, ["kind"]))
        item.evidence = { ...base, quote: claim.quote };
      else if (e.kind === "removed" && exact(e, ["kind"]))
        item.evidence = { ...base, before: claim.quote };
      else if (["revised", "added"].includes(e.kind) && exact(e, ["kind", "index"]) &&
          Number.isSafeInteger(e.index) && draft.downstream[e.index as number])
        item.evidence = { ...base, before: claim.quote,
          after: draft.downstream[e.index as number]![claim.field] };
    } else if (!("target" in claim) && finding.eventId) {
      const base = { eventId: finding.eventId, field: claim.field, kind: e.kind };
      const current = milestoneEvent(draft, finding.eventId);
      if (e.kind === "current" && exact(e, ["kind"]))
        item.evidence = { ...base, quote: claim.quote };
      else if (e.kind === "removed" && exact(e, ["kind"]))
        item.evidence = { ...base, before: claim.quote };
      else if (["revised", "added"].includes(e.kind) && exact(e, ["kind"]) && current)
        item.evidence = { ...base, before: claim.quote,
          after: milestoneFieldText(current, claim.field) };
    }
  }
}

export function parseMilestoneBlueprintReview(text: string, draft: MilestoneBlueprint,
  assignment: Pick<EventAssignment, "milestonePath" | "sourcePaths">,
  previous: readonly Round[] = [],
  policy: "admission" | "sealed-replay" = "admission"): MilestoneBlueprintReview {
  let raw: unknown;
  try { raw = parse(text); } catch (error) {
    invalid("$", "Independent Milestone review returned invalid JSON: " +
      (error instanceof Error ? error.message.slice(0, 240) : "syntax error") +
      ". Rebuild a compact JSON object without copying escaped evidence arrays.");
  }
  bindCompactReviewEvidence(raw, draft, previous);
  const version = object(raw) ? raw.schema : null;
  const fifth = version === "noveltea-milestone-blueprint-review/v5";
  const strict = fifth || version === "noveltea-milestone-blueprint-review/v4";
  const modern = strict || version === "noveltea-milestone-blueprint-review/v3";
  const hasPrior = modern || version === "noveltea-milestone-blueprint-review/v2";
  if (!["noveltea-milestone-blueprint-review/v1",
        "noveltea-milestone-blueprint-review/v2",
        "noveltea-milestone-blueprint-review/v3",
        "noveltea-milestone-blueprint-review/v4",
        "noveltea-milestone-blueprint-review/v5"].includes(String(version)) ||
      !exact(raw, hasPrior ? ["schema", "status", "findings", "prior"] :
        ["schema", "status", "findings"]) ||
      !["pass", "revise"].includes(String(raw.status)) ||
      !Array.isArray(raw.findings) || raw.findings.length > 12 ||
      (raw.status === "pass") !== (raw.findings.length === 0))
    throw Error("Independent Milestone review needs an explicit source-bound verdict.");
  for (const [i, item] of raw.findings.entries()) {
    const path = "findings[" + i + "]";
    if (!object(item) || !assignment.sourcePaths.includes(String(item.anchorPath)) ||
        ![item.requirement, item.reason, item.correction].every(v => string(v)))
      invalid(path, "expected canonical source anchorPath from " + JSON.stringify(assignment.sourcePaths) + ", and bounded nonempty requirement, reason and correction");
    const evidence = item.evidence;
    if (fifth && object(evidence) && evidence.target === "downstream") {
      const index = evidence.index;
      const field = evidence.field;
      if (!exact(item, ["anchorPath", "requirement", "reason", "correction", "evidence"]) ||
          item.anchorPath !== assignment.milestonePath ||
          !exact(evidence, ["target", "index", "field", "quote", "repair"]) ||
          !Number.isSafeInteger(index) || (index as number) < 0 ||
          !["owner", "obligation"].includes(String(field)) ||
          !["replace", "extend"].includes(String(evidence.repair)) ||
          (field === "owner" && evidence.repair !== "replace") ||
          typeof evidence.quote !== "string" ||
          !draft.downstream[index as number] ||
          !downstreamQuote(draft.downstream[index as number]!,
            field as "owner" | "obligation", evidence.quote))
        invalid(path + ".evidence", "Invalid cited downstream field: expected target downstream, zero-based index from current downstream entries " + JSON.stringify(draft.downstream.map((_, i) => i)) + ", owner|obligation field and its exact quote, repair replace|extend (owner must replace), anchorPath " + assignment.milestonePath);
      continue;
    }
    if (fifth && object(evidence) && evidence.target === "missing-downstream") {
      if (!exact(item, ["anchorPath", "requirement", "reason", "correction", "evidence"]) ||
          item.anchorPath !== assignment.milestonePath ||
          !exact(evidence, ["target", "owner", "quote", "repair"]) ||
          typeof evidence.owner !== "string" ||
          !["event", "interactive", "composition"].includes(evidence.owner) ||
          evidence.repair !== "extend" ||
          evidence.quote !== JSON.stringify(draft.downstream))
        invalid(path + ".evidence", "expected target missing-downstream, owner event|interactive|composition, quote equal to the exact CURRENT serialized downstream array, repair extend, anchorPath " + assignment.milestonePath);
      continue;
    }
    const event = draft.events.find(e => e.id === item.eventId);
    if (!event) invalid(path + ".eventId", "expected an exact current provisional Event ID: " + JSON.stringify(draft.events.map(e => e.id)));
    if (modern && (!object(evidence) || !MILESTONE_FIELDS.includes(evidence.field as MilestoneField)))
      invalid(path + ".evidence.field", "expected one of " + MILESTONE_FIELDS.join(", ") + "; canonical Event record fields such as consequences are not Blueprint fields");
    if (!exact(item, modern
          ? ["eventId", "anchorPath", "requirement", "reason", "correction", "evidence"]
          : ["eventId", "anchorPath", "requirement", "reason", "correction"]) ||
        !event ||
        (modern && (!exact(evidence,
            strict ? ["field", "quote", "repair"] : ["field", "quote"]) ||
          !MILESTONE_FIELDS.includes(evidence.field as MilestoneField) ||
          strict && !["replace", "extend"].includes(String(evidence.repair)) ||
          typeof evidence.quote !== "string" ||
          !milestoneFieldQuote(event, evidence.field as MilestoneField,
            evidence.quote))))
      invalid(path + ".evidence", "Independent Milestone review finding has no cited defective Event field: use exact keys field, quote" + (strict ? ", repair" : "") + "; cite the selected current field verbatim (whole value or 8+ characters) with repair replace|extend");
  }
  // Replay sealed historical reviews independently; new reviewer sessions
  // must emit v5, including source-bound downstream/omission findings.
  if (policy === "admission" && !fifth &&
      !(version === "noveltea-milestone-blueprint-review/v1" && !previous.length &&
        raw.status === "pass" && raw.findings.length === 0))
    throw Error("New Milestone review requires v5 source-bound findings.");
  if (hasPrior) {
    const review = raw as unknown as MilestoneBlueprintReview;
    const count = previous.reduce((total, round) => total + independentFindings(round).length, 0);
    if (!Array.isArray(review.prior) || review.prior.length !== count)
      invalid("prior", "Milestone review must account for every prior material finding exactly once: " + JSON.stringify(milestoneReviewFindingIndex(previous)));
    const seen = new Set<string>();
    for (const [i, p] of review.prior.entries()) {
      const path = "prior[" + i + "]";
      if (!object(p)) invalid(path, "expected an object with round, findingIndex, status, reason, evidence");
      const key = p.round + ":" + p.findingIndex;
      const source = previous[p.round];
      const original = independentFindings(source)[p.findingIndex];
      if (!Number.isSafeInteger(p.round) || !Number.isSafeInteger(p.findingIndex) ||
          seen.has(key) || !source || !original ||
          !["resolved", "improved", "persisting", "regressed"].includes(p.status) ||
          !string(p.reason) || !object(p.evidence) ||
          (original.evidence && "target" in original.evidence
            ? !fifth || !("target" in p.evidence) ||
              p.evidence.target !== original.evidence.target
            : p.evidence.eventId !== original.eventId))
        invalid(path, "Milestone previous finding assessment lacks source-bound identity. Round and findingIndex are ZERO-BASED; valid original identifiers and fields: " + JSON.stringify(milestoneReviewFindingIndex(previous)) + ". Preserve the original target/Event ID, use resolved|improved|persisting|regressed and a nonempty reason.");
      if (modern) {
        const proof = p.evidence as MilestonePriorEvidence;
        const keys = "target" in proof && proof.target === "missing-downstream"
          ? proof.kind === "not-required"
            ? ["target", "owner", "kind", "eventId", "field", "before", "after"]
            : proof.kind === "added"
            ? ["target", "owner", "kind", "before", "after"]
            : ["target", "owner", "kind", "quote"]
          : "target" in proof && proof.target === "downstream"
            ? proof.kind === "revised" || proof.kind === "added"
              ? ["target", "index", "field", "kind", "before", "after"]
              : proof.kind === "removed"
                ? ["target", "index", "field", "kind", "before"]
                : ["target", "index", "field", "kind", "quote"]
            : proof.kind === "revised" || proof.kind === "added"
              ? ["kind", "eventId", "field", "before", "after"]
              : proof.kind === "removed"
                ? ["kind", "eventId", "field", "before"]
                : ["kind", "eventId", "field", "quote"];
        if (!exact(proof, keys) ||
            !milestoneCorrectionEvidence(p, original, source.draft, draft,
              !strict && policy === "sealed-replay") ||
            ((p.status === "resolved" || p.status === "improved")
              ? proof.kind === "current"
              : proof.kind !== "current"))
          invalid(path + ".evidence", "Milestone finding correction needs a change to its rejected field or verified Event removal. " +
            "Use compact evidence {kind:'revised|added|removed|current'} for an Event finding; " +
            "for a downstream replacement/addition include index of the NEW entry. " +
            "For a missing Interactive owner resolved by removing an implied choice, use " +
            "{kind:'not-required',eventId:retained revised Event ID,field:'purpose|routes'}. " +
            "Resolved/improved cannot use current, and persisting/regressed require current. " +
            "The controller binds the original rejected field and current exact evidence; do not copy long escaped JSON. " +
            "Original identity: " + JSON.stringify({round:p.round,findingIndex:p.findingIndex,eventId:original.eventId,
              target:original.evidence && "target" in original.evidence ? original.evidence.target : undefined}) +
            ". Full evidence keys if explicitly supplied: " + keys.join(", "));
      } else {
        const proof = p.evidence as { eventId: string; quote: string };
        const event = original.eventId
          ? milestoneEvent(draft, original.eventId) : undefined;
        if (!exact(proof, ["eventId", "quote"]) ||
            !string(proof.quote) || proof.quote.length < 8 ||
            !event || !JSON.stringify(event).includes(proof.quote))
          throw Error("Milestone previous finding assessment lacks exact current Event evidence.");
      }
      seen.add(key);
    }
    if (review.status === "pass" && review.prior.some(p => p.status !== "resolved"))
      invalid("status", "Milestone reviewer cannot pass with unresolved historical blockers; all prior statuses must be resolved and findings empty");
    if (review.status === "pass" && previous.length &&
        policy === "admission" && !fifth)
      throw Error("New Milestone approval requires v5 correction evidence.");
    if (modern && !milestonePassCorrections(draft, previous, review))
      throw Error("Milestone pass has no verified correction of the rejected Event claim.");
  }
  return raw as unknown as MilestoneBlueprintReview;
}
async function persist(path: string, receipt: Receipt) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + "." + randomUUID() + ".tmp";
  await writeFile(temporary, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}
async function load(job: JobStartResult, id: string): Promise<Receipt | null> {
  const path = fileFor(job, id);
  if (!existsSync(path)) return null;
  if (await realpath(path) !== path || !(await lstat(path)).isFile())
    throw Error("Milestone planning receipt is not a safe private file.");
  return JSON.parse(await readFile(path, "utf8")) as Receipt;
}
async function seal(session: { sessionId: string; sessionManager: { getSessionFile(): string | undefined } }): Promise<SessionSeal> {
  const file = session.sessionManager.getSessionFile();
  if (!file) throw Error("Milestone planning requires a persistent Pi transcript.");
  const bytes = await readFile(file);
  return { id: session.sessionId, file, bytes: bytes.length, digest: sha(bytes.toString("utf8")) };
}
async function verifySeal(job: JobStartResult, sealValue: SessionSeal,
  role: "writer" | "reviewer" | "diagnostic" | "replacement") {
  const dir = join(job.stateDir, "milestone-blueprint-sessions", role);
  if (!sealValue || !string(sealValue.id) ||
      typeof sealValue.file !== "string" || !sealValue.file.startsWith(dir + sep) ||
      !existsSync(sealValue.file) || await realpath(sealValue.file) !== sealValue.file ||
      !(await lstat(sealValue.file)).isFile())
    throw Error("Milestone plan has missing or unsafe " + role + " Pi provenance.");
  const bytes = await readFile(sealValue.file);
  const first = JSON.parse(bytes.toString("utf8").split("\n")[0] ?? "{}") as { type?: string; id?: string };
  if (first.type !== "session" || first.id !== sealValue.id ||
      sealValue.bytes !== bytes.length || sealValue.digest !== sha(bytes.toString("utf8")))
    throw Error("Milestone plan " + role + " transcript changed after sealing.");
}
/** A post-approval grant must cite actual independent answers, not just a
 * self-consistent set of hashes copied into a private planning receipt. Pi
 * retains earlier answers in JSONL across compaction and protocol retries. */
async function assertBlueprintReplies(session: SessionSeal, expected: string[],
  normalize?: (text: string, index: number) => unknown) {
  let matched = 0, last: string | undefined;
  for (const line of (await readFile(session.file, "utf8")).split("\n")) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line);
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    last = undefined;
    if (["error", "aborted", "toolUse"].includes(entry.message.stopReason)) continue;
    const text = entry.message.content.filter((c: { type: string }) => c.type === "text")
      .map((c: { text: string }) => c.text).join("");
    try {
      last = sha(parse(text));
      if (last !== expected[matched] && normalize && matched < expected.length)
        last = sha(normalize(text, matched));
    } catch { continue; } // e.g. the original protocol-error response
    if (last === expected[matched]) matched++;
  }
  if (!expected.length || matched !== expected.length || last !== expected.at(-1))
    throw Error("Milestone Blueprint history differs from the sealed Pi answers.");
}
function validateReceiptShape(value: Receipt, id: string) {
  if (value?.schema !== "noveltea-milestone-plan-receipt/v1" ||
      !MILESTONE.test(id) || value.lineage?.milestoneId !== id ||
      !["admitted", "planning", "draft", "reviewing", "revision", "diagnosing", "stopped", "approved"].includes(value.phase) ||
      !Array.isArray(value.rounds) ||
      (value.reviewStart !== undefined &&
        (!Number.isSafeInteger(value.reviewStart) || value.reviewStart < 1 || value.reviewStart > value.rounds.length)) ||
      (value.reviewStarts !== undefined &&
        (!Array.isArray(value.reviewStarts) ||
          value.reviewStarts.at(-1) !== value.reviewStart ||
          value.reviewStarts.some((start, index) =>
            !Number.isSafeInteger(start) || start < 1 ||
            start > value.rounds.length ||
            (index > 0 && start <= value.reviewStarts![index - 1]!) ||
            !value.diagnostics?.some(d => d.diagnosis.action === "replace" &&
              d.round === start - 1)))) ||
      (value.reviewerRole === "replacement" &&
        (value.reviewStart === undefined || !value.reviewerHistory?.length ||
          !value.diagnostics?.some(d => d.diagnosis.action === "replace" &&
            d.round === value.reviewStart! - 1))) ||
      (value.phase === "stopped" && !string(value.stopReason)))
    throw Error("Invalid private Milestone Blueprint receipt.");
}
function pinOf(value: Receipt): MilestoneBlueprintPin {
  if (value.phase !== "approved" || !value.draft || !HASH.test(value.approvedDigest ?? "") ||
      value.approvedDigest !== sha(value.draft) ||
      value.rounds.at(-1)?.draftDigest !== value.approvedDigest ||
      value.rounds.at(-1)?.review.status !== "pass")
    throw Error("Milestone Blueprint has no approved independent source-bound review.");
  return { milestoneId: value.lineage.milestoneId, sourceSha: value.lineage.executionHead,
    digest: value.approvedDigest, cycleId: value.lineage.reviewCycleId };
}
function assertRounds(value: Receipt, assignment: Pick<EventAssignment,
  "milestoneId" | "milestonePath" | "sourcePaths" | "characterIds">) {
  for (const [index, round] of value.rounds.entries()) {
    const draft = parseMilestoneBlueprint(JSON.stringify(round.draft), assignment,
      round.review.status === "pass" ? "sealed-replay" : "sealed-rejected");
    const boundaries = value.reviewStarts ?? (value.reviewStart === undefined
      ? [] : [value.reviewStart]);
    const start = boundaries.filter(boundary => boundary <= index).at(-1) ?? 0;
    const previous = value.rounds.slice(start, index);
    const review = parseMilestoneBlueprintReview(JSON.stringify(round.review), draft,
      assignment, previous, "sealed-replay");
    if (round.reviewerVerdict) {
      const actual = parseMilestoneBlueprintReview(JSON.stringify(round.reviewerVerdict), draft,
        assignment, previous, "sealed-replay");
      if (actual.status !== "pass" || review.status !== "revise" ||
          sha(controllerReviewDisposition(draft, assignment, actual)) !== sha(review))
        throw Error("Milestone controller veto differs from the sealed reviewer and source findings.");
    }
    if (round.draftDigest !== sha(draft) || round.reviewDigest !== sha(review))
      throw Error("Milestone review evidence changed after its sealed verdict.");
  }
  if (value.draft && sha(parseMilestoneBlueprint(JSON.stringify(value.draft), assignment,
      value.phase === "approved" ? "sealed-replay" : "sealed-rejected")) !==
      sha(value.draft)) throw Error("Milestone planning draft changed.");
}
/** Verify durable independent advice against the sealed negative review and
 * original job/Thread/plan/contract lineage before applying any routing. */
async function assertDiagnostics(job: JobStartResult, receipt: Receipt) {
  let previousRound = -1;
  for (const record of receipt.diagnostics ?? []) {
    const round = receipt.rounds[record.round];
    const sources = record.sources;
    if (!sources || sha(sources.task) !== receipt.lineage.taskDigest ||
        sha(sources.contract) !== receipt.lineage.contractDigest ||
        record.schema !== "noveltea-milestone-diagnostic-receipt/v1" ||
        !round || round.review.status !== "revise" ||
        record.round <= previousRound || record.round >= receipt.rounds.length ||
        !["stagnation", "review-depth"].includes(record.trigger) ||
        record.evidenceDigest !== milestoneDiagnosticEvidence(receipt.lineage.reviewCycleId,
          receipt.rounds.slice(0, record.round + 1), sources) ||
        record.caseFingerprint !== milestoneDiagnosticFingerprint(receipt.lineage.reviewCycleId,
          round.draft, round.review.findings, sources))
      throw Error("Milestone diagnosis changed its sealed review or source evidence.");
    const sealed = await readSealedDiagnosis(job, receipt, record.round);
    if (!sealed || JSON.stringify(sealed) !== JSON.stringify(record))
      throw Error("Milestone diagnostic disposition differs from immutable source evidence.");
    const parsed = parseMilestoneDiagnosis(JSON.stringify(record.diagnosis), round.draft, sources);
    if (JSON.stringify(parsed) !== JSON.stringify(record.diagnosis))
      throw Error("Milestone diagnosis changed its independent disposition.");
    await verifySeal(job, record.session, "diagnostic");
    if ([receipt.writer?.id, receipt.reviewer?.id,
        ...(receipt.reviewerHistory ?? []).map(h => h.session.id),
        ...(receipt.diagnostics ?? []).filter(d => d !== record).map(d => d.session.id)]
      .includes(record.session.id))
      throw Error("Milestone diagnosis reused a writer or reviewer session.");
    previousRound = record.round;
  }
  for (const history of receipt.reviewerHistory ?? [])
    await verifySeal(job, history.session, history.role);
}

async function runMilestoneDiagnosis(job: JobStartResult, snapshot: SkillSnapshot,
  assignment: EventAssignment, provider: string, model: string, task: string,
  receipt: Receipt, contract: unknown, trigger: MilestoneDiagnosticTrigger,
): Promise<DiagnosticReceipt> {
  const last = receipt.rounds.at(-1)!;
  const index = receipt.rounds.length - 1;
  let session: Awaited<ReturnType<typeof sessionFor>>;
  try {
    session = await sessionFor(job, snapshot, assignment, provider, model,
      "diagnostic", receipt.lineage.reviewCycleId + ":" + index);
  } catch (error) {
    if (error instanceof PiBudgetPause) {
      // Only admission failed: no diagnostic prompt has been dispatched.
      receipt.phase = "revision";
      await persist(fileFor(job, assignment.milestoneId), receipt);
    }
    throw error;
  }
  try {
    if ([receipt.writer?.id, receipt.reviewer?.id,
        ...(receipt.reviewerHistory ?? []).map(h => h.session.id),
        ...(receipt.diagnostics ?? []).map(d => d.session.id)].includes(session.session.sessionId))
      throw Error("Milestone diagnostician reused an original Pi session.");
    const start = session.session.messages.length;
    await reportControllerReviewPhase("diagnosing", { milestone: assignment.milestoneId, activity: "blueprint-diagnosis", role: "diagnostic", round: index });
    await promptStorySpecialist(session.session, session.context.contextNote +
      "FRESH INDEPENDENT READ-ONLY MILESTONE REVIEW DIAGNOSTIC. " +
      "Read skill://nt-event-design/SKILL.md and skill://nt-catalog/SKILL.md and the exact selected " +
      "Milestone and supporting canonical sources. You are NOT the original " +
      "reviewer; do not presume the previous verdict right or wrong. Judge " +
      "whether the current-stage defect is material, deferred to downstream work, " +
      "cosmetic, reviewer drift or outside the authorized scope. " +
      "Your diagnosis NEVER approves a draft, erases a review verdict, changes " +
      "protected decisions, grants writing authority or overrides budgets. " +
      "Recommend continue (writer/reviewer keep distinct original conversations), " +
      "replace (new read-only independent reviewer must actually review), " +
      "split (requires separately authorized replanning), or escalate (safe stop). " +
      "\nTRIGGER: " + trigger +
      "\nSOURCE MILESTONE: " + assignment.milestoneId +
      "\nTASK: " + JSON.stringify(task) +
      "\nAPPROVED CONTRACT: " + JSON.stringify(contract) +
      "\nHISTORICAL SEALED REVIEWS: " + JSON.stringify(receipt.rounds.map((r, i) =>
        ({ round: i, draftDigest: r.draftDigest, review: r.review,
          ...(r.reviewerVerdict ? { reviewerVerdict: r.reviewerVerdict, controllerVeto: true } : {}) }))) +
      "\nCURRENT EXACT DRAFT: " + JSON.stringify(last.draft) + sourceFindingFeedback(last.draft, assignment) +
      "\\nReturn ONLY strict JSON {schema:'noveltea-milestone-diagnosis/v1'," +
      "action:'continue|replace|split|escalate',explanation:string," +
      "assessments:[{kind:'material|deferred|cosmetic|scope',reason:string," +
      "requirement:{source:'task|contract',quote:exact accepted 8+ character substring}," +
      "evidence: ONE of {eventId:current provisional Event id,field:'purpose|dependsOn|" +
      "evidence|participants|knowledge|routes',quote:exact current field text}, " +
      "{target:'downstream',index:current entry index,field:'owner|obligation'," +
      "quote:current field text}, or {target:'missing-downstream'," +
      "owner:'event|interactive|composition',quote:exact JSON serialized " +
      "current downstream array}}]}. Every assessment must cite exact CURRENT " +
      "Event or downstream evidence and an existing accepted task or contract; " +
      "never introduce requirements or return a PASS.");
    await correctMissingReads(session, start, snapshot, assignment);
    const diagnosis = await correctMilestoneContract(session, job, assignment, "diagnostic",
      raw => parseMilestoneDiagnosis(raw, last.draft, { task, contract }),
      "Use exact current Event IDs and fields " + MILESTONE_FIELDS.join(", ") +
      "; cite a current source field, or the original downstream owner/entry. Never approve a plan.", index);
    await session.context.completed(session.session.sessionManager.getSessionFile()!,
      session.session.sessionId);
    const result: DiagnosticReceipt = {
      schema: "noveltea-milestone-diagnostic-receipt/v1", round: index, trigger,
      evidenceDigest: milestoneDiagnosticEvidence(receipt.lineage.reviewCycleId,
        receipt.rounds, { task, contract }),
      caseFingerprint: milestoneDiagnosticFingerprint(receipt.lineage.reviewCycleId,
        last.draft, last.review.findings, { task, contract }),
      sources: { task, contract }, diagnosis, session: await seal(session.session),
    };
    await sealDiagnosis(job, receipt, result);
    return result;
  } finally { session.session.dispose(); }
}

/** Reconcile one immutable diagnosis before taking any trusted action.
 * A restart that finds the sealed result uses this exact path without another
 * Pi prompt, reviewer verdict, writer attempt, or budget debit. */
async function applyMilestoneDiagnosis(job: JobStartResult, receipt: Receipt,
  diagnostic: DiagnosticReceipt): Promise<void> {
  if (receipt.diagnostics?.some(d => d.round === diagnostic.round))
    throw Error("Milestone diagnostic result was already dispatched.");
  const next = { ...receipt,
    diagnostics: [...(receipt.diagnostics ?? []), diagnostic] };
  await assertDiagnostics(job, next);
  const decision = milestoneDiagnosticDecision(diagnostic.diagnosis.action, false);
  receipt.diagnostics = next.diagnostics;
  if (decision.kind === "replace") {
    if (!receipt.reviewer)
      throw Error("Milestone reviewer replacement lacks sealed original provenance.");
    receipt.reviewerHistory = [...(receipt.reviewerHistory ?? []),
      { role: receipt.reviewerRole ?? "reviewer", session: receipt.reviewer }];
    receipt.reviewer = undefined;
    receipt.reviewerRole = "replacement";
    receipt.reviewStart = receipt.rounds.length;
    receipt.reviewStarts = [...(receipt.reviewStarts ?? []), receipt.reviewStart];
    receipt.phase = "draft";
  } else if (decision.kind === "stop") {
    receipt.phase = "stopped";
    receipt.stopReason = decision.reason;
  } else {
    receipt.phase = "revision";
  }
  await persist(fileFor(job, receipt.lineage.milestoneId), receipt);
}

async function lineage(job: JobStartResult, plan: Plan, assignment: EventAssignment,
  snapshot: SkillSnapshot, provider: string, model: string, task: string, head: string): Promise<Lineage> {
  const sources = await sourceDigest(job, assignment.sourcePaths, head);
  const binding = { jobId: job.jobId, threadId: job.threadId, baseSha: job.baseSha,
    executionHead: head, milestoneId: assignment.milestoneId, planVersion: plan.version,
    planDigest: sha(plan), contractDigest: sha(plan.contract), sourceDigest: sources,
    snapshotId: snapshot.id, provider, model, taskDigest: sha(task) };
  return { ...binding, reviewCycleId: cycleFor(binding) };
}
function cycleFor(binding: Omit<Lineage, "reviewCycleId">) {
  return reviewCycleId({ ...binding,
    taskDigest: sha([binding.taskDigest, binding.milestoneId,
      binding.sourceDigest, binding.planDigest]) });
}
function assertLineage(actual: Lineage, expected: Lineage) {
  if (!actual || JSON.stringify(actual) !== JSON.stringify(expected))
    throw Error("Milestone Blueprint is stale or bound to another source, assignment, model or Thread.");
}

function plannerPrompt(assignment: EventAssignment, task: string, earlier?: Round, diagnosis?: MilestoneDiagnosis) {
  return "READ-ONLY LOCAL MILESTONE BLUEPRINT. Read skill://nt-event-design/SKILL.md and skill://nt-catalog/SKILL.md " +
    "skills and the current selected Milestone, its Arc and relevant Character/World sources. " +
    "Do NOT write Story files, claim new canonical records already exist or change protected decisions. " +
    "Design 1–5 causally ordered provisional Events ONLY for " + assignment.milestoneId + ". " +
    "The selected canonical Milestone's change and explicit limits are the exact stopping boundary. " +
    "Read relevant already-authored Events before designing: treat their completed occurrences as context or prerequisites, " +
    "never enact them again. Do not realize a later Milestone's reveal, confrontation, rescue or decision merely because it is described in the Arc. " +
    "An inspection performed by the player alone may have participants: []; do not invent NPC attendance. " +
    "For each Event state concrete inspectable evidence, source, access/custody, " +
    "what it actually establishes and its uncertainty; Character knowledge/state, local branch " +
    "conditions and lasting consequences. The Event knowledge field MUST be ONE " +
    "nonempty STRING summarizing who learns what and why, NEVER an array, object, " +
    "list of structured state transitions or nested fact mappings. Participants " +
    "MUST include all material Character participants, including testimony, witness or informant sources. " +
    "Do not confuse the Character being discussed with the one providing the evidence. " +
    "Use the exact CHARACTER IDS below for existing authorized Characters. Reuse a realized Character for the same witness role instead of inventing a duplicate. If the intended evidence needs an additional " +
    "Character not in that inventory, declare a typed character.slug as prospective and include it in participants. " +
    "For every evidence entry include characterSources: [{id,availability:'existing|prospective',role}] " +
    "for all material Character sources, or [] for non-Character sources. A prospective Character is a required " +
    "predecessor, NOT authority for Event to author it or proof of existing canon. Do not remove valid narrative evidence " +
    "merely because its required Character is not yet realized. dependsOn " +
    "MUST use only earlier provisional Event slugs. " +
    "Evidence anchorPath MUST be an existing sourcePaths " +
    "canonical record, not a proposed Event path. Name downstream owners for required " +
    "CURRENT-MILESTONE work, including all Composition delivery and any genuinely necessary " +
    "Choice/Puzzle implementation. A positive interactive owner REQUIRES Interactive work " +
    "for this Milestone: NEVER assign that owner for a claim that no Choice/Puzzle is needed, " +
    "for optional possibilities, or for an idea belonging to a different Milestone. " +
    "An NPC stating their own wishes, consent, preferences or intentions is not a formal player Choice. " +
    "The current rescue, discovery or testimony can be complete even when a subsequent Milestone owns the response decision. " +
    "An Event-only Milestone with no current Interactive obligation must still own Composition. " +
    "Unknown future Events remain provisional, not verified canon. " +
    "No unrelated Milestone or protected-canon changes. Return ONLY one JSON object " +
    "{schema:'noveltea-milestone-blueprint/v1',milestoneId,events:[{id,purpose,dependsOn," +
    "evidence:[{anchorPath,source,observation,access,establishes,limits,characterSources:[{id,availability,role}]}],participants,knowledge," +
    "routes:[{condition,consequence}]}],downstream:[{owner:'event|interactive|composition',obligation}]}. " +
    "An Event id is a provisional slug, not a canonical event.* ID. " +
    (assignment.dependencyObligations ? "If already-realized upstream canon contradicts this Milestone's required delivery, preserve the intended local design and append upstreamCorrection: " +
      JSON.stringify({ obligationIndex: 0, targetId: "event.earlier", missing: "exact correction of existing canon", affectedIds: [assignment.milestoneId, "arc.related", "event.earlier"], sources: [{path: "canonical/path.md", quote: "exact contradictory source quote"}], likelySpecialist: "nt-event-design", authorDecisionRequired: false }) +
      ". Cite an existing earlier owned record and its typed source relation. Do not report future planned delivery. A passing design with this finding does NOT authorize Event writing until the upstream correction is independently verified. Original delivery obligations: " + JSON.stringify(assignment.dependencyObligations) + ". " : "") +
    "SOURCE PATHS: " + JSON.stringify(assignment.sourcePaths) +
    "\nCHARACTER IDS: " + JSON.stringify(assignment.characterIds) +
    "\nAUTHOR OBJECTIVE: " + task +
    (earlier ? "\nSAME REVIEW CYCLE: Revise the previous provisional plan to resolve material findings, " +
      "without inventing protected authority. Preserve provisional Event IDs for revisions; replace/remove only if substantively necessary so the independent reviewer can cite original identity. PRIOR PLAN: " + JSON.stringify(earlier.draft) +
      (earlier.reviewerVerdict ? "\nCONTROLLER VETO OF INDEPENDENT PASS: " : "\nINDEPENDENT REVIEW: ") + JSON.stringify(earlier.review) + sourceFindingFeedback(earlier.draft, assignment) : "") +
    (diagnosis ? "\nINDEPENDENT DIAGNOSTIC ADVICE (not approval or authority): " + JSON.stringify(diagnosis) : "");
}
function reviewerPrompt(assignment: EventAssignment, draft: MilestoneBlueprint, prior: Round[],
  task: string, contract: unknown) {
  return "INDEPENDENT READ-ONLY MILESTONE PLAN REVIEW. Read skill://nt-event-design/SKILL.md and " +
    "skill://nt-catalog/SKILL.md and the selected canonical Milestone/Arc/Character/World sources. " +
    "An NPC expressing wishes, consent or preferences is not itself a formal player Choice; reject an Interactive owner assigned only for a later Milestone response. " +
    "Assess ONLY whether this PROVISIONAL local plan can plausibly support future Event " +
    "implementation: all material Event and downstream plan fields, including causality, concrete " +
    "inspectable sources and access/custody, earned Character knowledge, branching consequences, " +
    "complete required current-Milestone Choice/Puzzle obligations and Composition delivery. " +
    "A positive interactive owner means REQUIRED work for THIS Milestone, never a declaration " +
    "that none is needed, an optional idea, or work deferred to another Milestone. " +
    "Legitimate Event-only Milestones need no interactive owner; do not fabricate a Choice. " +
    "A Story-wide Interaction profile is not a per-Milestone quota. An investigative commitment or player-directed inspection alone is not a consequential Choice. " +
    "Check each proposed Event against the selected Milestone's exact canonical change and limits, and relevant already-authored Event records. " +
    "Reject duplicated prior/later occurrences, advancement beyond this Milestone's promised knowledge or outcomes, and unsupported prerequisites. " +
    "An inspection performed only by the player can legitimately have participants: []. " +
    (draft.upstreamCorrection ? "Independently inspect the exact existing canonical sources in upstreamCorrection. PASS only if the proposed correction is necessary to deliver the original objective and is not prospective downstream work; the controller must independently authorize and verify that correction before any Event writer. " : "") +
    "Verify EVERY material witness, informant, testimony provider or other Character evidence source " +
    "is explicitly declared in characterSources and participants. The subject of a statement is not automatically its provider. " +
    "Reject a missing declaration by citing the evidence field; " +
    "do not reject a sound design just because a declared prospective Character is unrealized. " +
    "A prospective Character must be necessary for the selected Milestone, and must be authored by its own authorized owner before Event. " +
    "Do not insist on canon or playable prose not yet authored, and do not call a future stage's " +
    "obligation a current-stage blocker. Flag actual unsupported, contradictory or missing " +
    "obligations with a CURRENT canonical anchorPath. Preserve prior findings and assess the " +
    "new draft, distinguishing resolved blockers and regressions. Assess EACH prior " +
    "finding by exact ZERO-BASED round and findingIndex, including distinct findings on the same " +
    "Event/source path. A NEW Event finding cites its eventId and defective FIELD " +
    "with its exact whole value or an 8+ character excerpt. A downstream finding instead " +
    "cites the exact current entry index, owner|obligation field and quote, with anchorPath " +
    "equal to the selected canonical Milestone path. A genuinely MISSING downstream " +
    "requirement instead cites target:'missing-downstream', the required owner and the " +
    "controller-bound current downstream array (omit quote for this target). " +
    "These findings do NOT invent an eventId. An empty Event array " +
    "must be cited exactly as '[]'; a short dependency list such as [\"key\"] " +
    "must be cited as its exact whole value. Do not cite just an Event path. " +
    "For EACH NEW finding, decide now whether repair MUST replace an invalid " +
    "claim (repair:'replace') or may extend a valid but incomplete field " +
    "(repair:'extend'). This decision is SEALED with the negative finding; " +
    "later rounds CANNOT reinterpret a replace finding as extend. " +
    "For each historical finding return its zero-based round and findingIndex, status and reason. " +
    "Use compact evidence selectors, NOT repeated exact JSON strings: for an Event finding " +
    "{kind:'revised|added|removed|current'}; the controller binds the original field and current exact value. " +
    "For a downstream entry replacement/addition use {kind:'revised|added',index:NEW entry index}; " +
    "for removal/current use {kind:'removed|current'}. For a missing downstream owner use " +
    "{kind:'added',index:NEW entry index} or {kind:'current'}. If an Interactive omission finding was " +
    "addressed by revising away the implied player choice, use {kind:'not-required',eventId:retained revised Event ID," +
    "field:'purpose|routes'} and explain why the selected canonical Milestone does not need a Choice/Puzzle. " +
    "This is not permission to waive an unchanged material defect. Resolved/improved cannot use current. " +
    "A replacement Event may be added, but deleting the rejected ID must be verifiable. " +
    "A concise pass has no findings and every prior finding resolved; revise reports material blockers. " +
    "Return ONLY JSON {schema:'noveltea-milestone-blueprint-review/v5',status:'pass|revise',findings:[EITHER " +
    "{eventId,anchorPath,requirement,reason,correction," +
    "evidence:{field:'purpose|knowledge|dependsOn|participants|evidence|routes',quote,repair:'replace|extend'}} OR " +
    "{anchorPath,requirement,reason,correction," +
    "evidence:{target:'downstream',index,field:'owner|obligation',quote,repair:'replace|extend'}} OR " +
    "{anchorPath,requirement,reason,correction,evidence:{target:'missing-downstream',owner:'event|interactive|composition',repair:'extend'}}]," +
    "prior:[{round,findingIndex,status:'resolved|improved|persisting|regressed',reason,evidence: compact selector above}]}. " +
    "SOURCE PATHS: " + JSON.stringify(assignment.sourcePaths) +
    "\nAUTHOR OBJECTIVE: " + JSON.stringify(task) +
    "\nAPPROVED CONTRACT: " + JSON.stringify(contract) +
    "\nPREVIOUS SEALED REVIEWS: " + JSON.stringify(prior.map((r, round) => ({ round, draftDigest: r.draftDigest,
      review: r.review, ...(r.reviewerVerdict ? { reviewerVerdict: r.reviewerVerdict, controllerVeto: true } : {}) }))) + "\nEXACT REVIEW CONTRACT: " + milestoneReviewContract(draft, assignment, prior) + "\nCURRENT PLAN: " + JSON.stringify(draft) + sourceFindingFeedback(draft, assignment);
}
async function sessionFor(job: JobStartResult, snapshot: SkillSnapshot, assignment: EventAssignment,
  provider: string, model: string,
  role: "writer" | "reviewer" | "diagnostic" | "replacement", cycleId: string,
  resume?: SessionSeal) {
  const project = await openStoryProject(job.worktreeStoryRoot);
  const { loader, settingsManager } = createProjectResourceLoader(project, undefined, true, {
    discovery: "explicit-only", novelteaSkills: snapshot.path, skillDirs: [],
    requiredSkills: ["nt-event-design", "nt-catalog"],
  });
  await loader.reload();
  const { skills, diagnostics } = loader.getSkills();
  if (diagnostics.some(d => d.type === "error") ||
      !["nt-event-design", "nt-catalog"].every(name => skills.some(s =>
        s.name === name && s.filePath.startsWith(join(snapshot.path, "skills") + sep))))
    throw Error("Milestone planning requires pinned Event and catalog skills.");
  const runtime = await createJobModelRuntime();
  const context = await preparePiContext(job, project, {
    group: "milestone-blueprint:" + role + ":" + cycleId,
    step: "milestone-blueprint:" + role + ":" + assignment.milestoneId +
      (role === "diagnostic" || role === "replacement" ? ":" + cycleId : ""),
    paths: assignment.sourcePaths, snapshot: snapshot.id,
    provider, model, directory: join(job.stateDir, "milestone-blueprint-sessions", role),
    ...(resume ? { resumeSession: { file: resume.file, id: resume.id } } : {}),
  }, runtime);
  await context.beforeTurn(context.manager.getSessionFile() ?? undefined);
  const safeTools = await selectSandboxPiTools(job, snapshot, skills, undefined, "read-only", "specialist");
  const { session } = await createAgentSession({
    cwd: project.root, modelRuntime: runtime, model: context.model,
    thinkingLevel: context.thinking, resourceLoader: loader, settingsManager,
    sessionManager: context.manager, customTools: safeTools ?? [],
    noTools: "all", tools: [...SANDBOX_READ_ONLY_TOOLS],
  });
  if (context.thinking && session.thinkingLevel !== context.thinking) {
    session.dispose();
    throw Error("Milestone Blueprint session changed pinned thinking effort.");
  }
  if (resume && (session.sessionId !== resume.id || session.sessionManager.getSessionFile() !== resume.file)) {
    session.dispose();
    throw Error("Milestone Blueprint original Pi conversation was replaced.");
  }
  return { session, context, project };
}
function lastText(session: { messages: any[]; getLastAssistantText(): string | undefined }) {
  const last = [...session.messages].reverse().find(m => m.role === "assistant");
  if (!last || ["aborted", "error"].includes(last.stopReason))
    throw Error("Milestone Blueprint Pi session interrupted; inspect the original transcript.");
  return session.getLastAssistantText() ?? "";
}
export function missingMilestoneBlueprintReads(messages: Parameters<typeof completedPinnedSkillReads>[0],
  project: string, snapshot: SkillSnapshot, assignment: Pick<EventAssignment, "milestonePath">, sources: string[] = []) {
  const reads = completedPinnedSkillReads(messages, project, snapshot.path);
  const missingSkills = REQUIRED.filter(path => !reads.includes(join(snapshot.path, "skills", path)))
    .map(path => "skill://" + path);
  const missingSources = [...new Set([assignment.milestonePath, ...sources])]
    .filter(path => !reads.includes(join(project, path)));
  return [...missingSkills, ...missingSources];
}

function verifyReads(messages: Parameters<typeof completedPinnedSkillReads>[0],
  project: string, snapshot: SkillSnapshot, assignment: EventAssignment, sources: string[] = []) {
  const missing = missingMilestoneBlueprintReads(messages, project, snapshot, assignment, sources);
  if (missing.length)
    throw Error("Milestone Blueprint missing successful mandatory reads: " + missing.join(", "));
}

/** Missing source evidence is a correctable response defect, not permission to
 * replace the planner/reviewer. Keep the exact round and original read-only tools. */
async function correctMissingReads(original: Awaited<ReturnType<typeof sessionFor>>, start: number,
  snapshot: SkillSnapshot, assignment: EventAssignment, sources: string[] = []) {
  lastText(original.session); // Never prompt again after an interrupted response.
  const missing = missingMilestoneBlueprintReads(original.session.messages.slice(start),
    original.project.root, snapshot, assignment, sources);
  if (missing.length) {
    await original.context.beforeTurn(original.session.sessionManager.getSessionFile());
    await reportControllerReviewPhase("correcting", { milestone: assignment.milestoneId, activity: "source-read-correction" });
    await promptStorySpecialist(original.session,
      "READ-ONLY MILESTONE SOURCE-READ CORRECTION. The previous response omitted successful mandatory reads. " +
      "Use the read tool with each EXACT address below. skill:// addresses are stable pinned skills; " +
      "do not use absolute snapshot paths or search outside the Story. " +
      "Reassess your previous response using those sources and return the complete original JSON contract. " +
      "Keep the same assignment and reviewer role; no writing, new approval, or scope change. Missing reads: " +
      JSON.stringify(missing));
    lastText(original.session);
  }
  verifyReads(original.session.messages.slice(start), original.project.root, snapshot, assignment, sources);
}

async function correctMilestoneContract<T>(original: Awaited<ReturnType<typeof sessionFor>>,
  job: JobStartResult, assignment: EventAssignment, role: "planner" | "reviewer" | "diagnostic",
  parse: (raw: string) => T, guidance: string, round?: number) {
  const session = original.session;
  const responseOrdinal = session.messages.filter(m => m.role === "assistant" && m.stopReason === "stop").length;
  let failuresForActivity: ResponseContractFailure[] = [];
  return recoverResponseContract({
    session, contract: "milestone-blueprint." + role + ".v1",
    receiptFile: join(job.stateDir, "milestone-protocol", session.sessionId + "-" + responseOrdinal + ".json"),
    validate: raw => {
      try { parse(raw); return []; }
      catch (error) {
        const failure: ResponseContractFailure = error instanceof MilestoneContractError
          ? { path: error.path, expected: error.expected }
          : { path: "$", expected: error instanceof Error ? error.message : "exact source-bound JSON" };
        failuresForActivity = [failure];
        return failuresForActivity;
      }
    },
    parse,
    beforeCorrection: async () => {
      await original.context.beforeTurn(session.sessionManager.getSessionFile());
      await reportControllerReviewPhase("correcting", { milestone: assignment.milestoneId,
        activity: "protocol-correction", round, role,
        reason: failuresForActivity.map(f => f.path + ": " + f.expected).join("; ").slice(0, 1000) });
    },
    feedback: failures => "READ-ONLY MILESTONE " + role.toUpperCase() + " FORMAT CORRECTION. " +
      "Keep the original substantive analysis and source scope. No tools, edits, fabricated evidence or manufactured approval. " +
      "Return ONE complete exact JSON response. Validation errors: " + JSON.stringify(failures) + "\n" + guidance,
    prompt: feedback => promptStorySpecialist(session, feedback),
  });
}

/** Safe read-only status for a paused or completed local plan. This is not approval. */
export async function assertFutureBlueprintActive(job: JobStartResult, pin: MilestoneBlueprintPin, supersedes?: Supersession) {
  const current = await load(job, pin.milestoneId);
  if (existsSync(historicalFileFor(job, pin))) throw Error("An archived Blueprint cannot supply active obligations.");
  if (!current && !supersedes && job.recoveryFork) return;
  if (!current || JSON.stringify(pinOf(current)) !== JSON.stringify(pin) ||
      JSON.stringify(current.supersedes) !== JSON.stringify(supersedes))
    throw Error("Pending Milestone obligations lack the active controller-approved Blueprint version.");
}

export async function inspectMilestoneBlueprint(job: JobStartResult, milestoneId: string) {
  const receipt = await load(job, milestoneId);
  if (!receipt) return null;
  validateReceiptShape(receipt, milestoneId);
  await assertDiagnostics(job, receipt);
  if (receipt.lineage.jobId !== job.jobId || receipt.lineage.threadId !== job.threadId ||
      receipt.lineage.baseSha !== job.baseSha)
    throw Error("Milestone Blueprint inspection found an unrelated job or Thread.");
  return { phase: receipt.phase, milestoneId, sourceSha: receipt.lineage.executionHead,
    cycleId: receipt.lineage.reviewCycleId, rounds: receipt.rounds.length,
    digest: receipt.phase === "approved" ? pinOf(receipt).digest : undefined,
    lastVerdict: receipt.rounds.at(-1)?.review.status ?? null,
    diagnostic: receipt.diagnostics?.at(-1) ? {
      round: receipt.diagnostics.at(-1)!.round,
      trigger: receipt.diagnostics.at(-1)!.trigger,
      action: receipt.diagnostics.at(-1)!.diagnosis.action,
      explanation: receipt.diagnostics.at(-1)!.diagnosis.explanation,
    } : null,
    ...(receipt.supersedes ? { supersedes: receipt.supersedes } : {}),
    stopReason: receipt.stopReason ?? null };
}

/** Inspect a sealed plan (including at a later committed Event head) without
 * treating its private proposal as a canonical Story source. */
export async function readReviewedMilestoneBlueprint(job: JobStartResult,
  pin: MilestoneBlueprintPin, assignment: Pick<EventAssignment,
    "milestoneId" | "milestonePath" | "sourcePaths" | "characterIds" | "blueprintSource">,
  expected?: Pick<Lineage, "provider" | "model" | "planDigest" | "contractDigest" | "snapshotId">,
): Promise<MilestoneBlueprint> {
  const archived = historicalFileFor(job, pin);
  // An unfinished or damaged replacement must not obscure the immutable
  // original review used by the Event commit.
  let record = existsSync(archived) ? null : await load(job, pin.milestoneId);
  if (record?.lineage.reviewCycleId !== pin.cycleId) {
    if (!existsSync(archived)) {
      // A same-Thread continuation inherits an authenticated historical Event,
      // not the parent's mutable Pi transcript or job-local plan receipt.
      // Its immutable fork bundle carries a design that was independently
      // verified during admission; rebind it ONLY to that Event's exact pin,
      // assignment sources and immutable source Git commit.
      const bundle = job.recoveryFork ? readRecoveryFork(job) : null;
      const inherited = bundle?.milestoneBlueprints?.find(item =>
        item.pin.milestoneId === pin.milestoneId && item.pin.cycleId === pin.cycleId);
      const originalEvent = Object.entries(bundle?.receipts ?? {}).some(([path, source]) =>
        path.startsWith("event-items/") &&
        JSON.stringify(source.blueprintPin) === JSON.stringify(pin) &&
        JSON.stringify(source.assignment) === JSON.stringify(assignment));
      if (expected || !inherited || !originalEvent) throw Error("Missing reviewed historical Milestone Blueprint.");
      if (JSON.stringify(inherited.pin) !== JSON.stringify(pin) ||
          inherited.pin.digest !== sha(inherited.design) ||
          inherited.sourceDigest !== await sourceDigest(job,
            assignment.blueprintSource?.sourceSha === pin.sourceSha
              ? assignment.blueprintSource.sourcePaths : assignment.sourcePaths, pin.sourceSha))
        throw Error("Inherited Milestone Blueprint differs from its verified Event source.");
      // The original sealed receipt already passed independent review and
      // historical schema replay at fork admission and again at preparation.
      // Re-parsing it as a NEW draft could silently invalidate legacy approvals.
      return inherited.design;
    }
    const info = await lstat(archived);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(archived) !== archived)
      throw Error("Archived Milestone Blueprint is not a safe immutable private receipt.");
    record = JSON.parse(await readFile(archived, "utf8")) as Receipt;
  }
  if (!record) throw Error("Missing reviewed Milestone Blueprint.");
  if (assignment.blueprintSource?.sourceSha === pin.sourceSha)
    assignment = await (await import("./event-work.js")).authenticateReboundBlueprint(job, pin, assignment);
  validateReceiptShape(record, pin.milestoneId);
  if (record.lineage.jobId !== job.jobId || record.lineage.threadId !== job.threadId ||
      record.lineage.baseSha !== job.baseSha || record.lineage.executionHead !== pin.sourceSha ||
      record.lineage.reviewCycleId !== pin.cycleId ||
      expected && Object.entries(expected).some(([k, v]) => record.lineage[k as keyof Lineage] !== v) ||
      cycleFor(record.lineage) !== record.lineage.reviewCycleId)
    throw Error("Milestone Blueprint pin belongs to another job, Thread or source.");
  if (record.lineage.sourceDigest !== await sourceDigest(job, assignment.sourcePaths, pin.sourceSha))
    throw Error("Milestone Blueprint source record digest changed.");
  assertRounds(record, assignment);
  await assertDiagnostics(job, record);
  const actual = pinOf(record);
  if (JSON.stringify(actual) !== JSON.stringify(pin))
    throw Error("Event consumed a stale or altered Milestone Blueprint approval.");
  if (!record.writer || !record.reviewer) {
    if (record.lineage.provider !== "fixture" || record.lineage.model !== "fixture")
      throw Error("Real Milestone plan has no independent reviewer sessions.");
  } else {
    assertReviewCycleSession({ id: record.writer.id, file: record.writer.file },
      { id: record.reviewer.id, file: record.reviewer.file });
    await verifySeal(job, record.writer, "writer");
    await verifySeal(job, record.reviewer, record.reviewerRole ?? "reviewer");
    if (expected || record.supersedes || record.rounds.some(r => r.reviewerVerdict || milestoneBlueprintSourceFindings(r.draft, assignment).length)) {
      const starts = record.reviewStarts ?? (record.reviewStart ? [record.reviewStart] : []);
      await assertBlueprintReplies(record.writer, record.rounds.filter((_, i) => !starts.includes(i)).map(r => r.draftDigest));
      const reviewers = [...(record.reviewerHistory ?? []).map(h => h.session), record.reviewer];
      if (reviewers.length !== starts.length + 1) throw Error("Incomplete Blueprint reviewer lineage.");
      for (const [index, session] of reviewers.entries()) {
        const rounds = record.rounds.slice(index ? starts[index - 1] : 0, starts[index]);
        await assertBlueprintReplies(session, rounds.map(r => r.reviewerVerdict ? sha(r.reviewerVerdict) : r.reviewDigest),
          (text, round) => parseMilestoneBlueprintReview(text, rounds[round]!.draft,
            assignment, record!.rounds.slice(0, (index ? starts[index - 1]! : 0) + round), "sealed-replay"));
      }
    }
  }
  return record.draft!;
}

/** Bounded provenance from the authenticated private approval, never the
 * transcript path, raw verdict or any model-produced free text. */
export async function milestoneBlueprintApprovalProvenance(job: JobStartResult,
  pin: MilestoneBlueprintPin, assignment: EventAssignment) {
  await readReviewedMilestoneBlueprint(job, pin, assignment);
  const path = existsSync(historicalFileFor(job, pin)) ? historicalFileFor(job, pin) : fileFor(job, pin.milestoneId);
  const record = JSON.parse(await readFile(path, "utf8")) as Receipt;
  return { provider: record.lineage.provider, model: record.lineage.model,
    reviewerId: record.reviewer?.id ?? (record.lineage.provider === "fixture" ? "fixture" : null),
    reviewCycleId: record.lineage.reviewCycleId };
}

/** Hash the whole original cycle, not just the material draft in the Git
 * trailer. The caller has authenticated its rounds, source and Pi seals. */
export async function originalBlueprintReviewDigest(job: JobStartResult, pin: MilestoneBlueprintPin) {
  const archived = historicalFileFor(job, pin);
  const file = existsSync(archived) ? archived : fileFor(job, pin.milestoneId);
  if (await realpath(file) !== file || !(await lstat(file)).isFile()) throw Error("Unsafe original Blueprint approval.");
  const bytes = await readFile(file, "utf8");
  if (JSON.stringify(pinOf(JSON.parse(bytes) as Receipt)) !== JSON.stringify(pin)) throw Error("Wrong original Blueprint approval.");
  return createHash("sha256").update(bytes).digest("hex");
}

/** Transfer only the authenticated design/commit binding into a sealed fork.
 * The original reviewer transcripts are verified before collection and are
 * never represented as a child review or a new authoring grant. */
export async function collectInheritedMilestoneBlueprint(job: JobStartResult,
  pin: MilestoneBlueprintPin, assignment: Pick<EventAssignment,
    "milestoneId" | "milestonePath" | "sourcePaths" | "characterIds" | "blueprintSource">,
): Promise<InheritedMilestoneBlueprint> {
  const design = await readReviewedMilestoneBlueprint(job, pin, assignment);
  // The existing fork format carries a single historical Event pin. Never
  // export it as pending authority after correction without the successor.
  const { readReviewTurnEvidence } = await import("./fork-review-turn.js");
  const turn = await readReviewTurnEvidence(job);
  if (turn && (await (await import("./repair-ledger.js")).inspectRepairLedger(job, turn.digest))
      .blueprintRepairs?.some(repair => repair.original.milestoneId === pin.milestoneId))
    throw Error("Cannot fork pending obligations without the complete Blueprint supersession history.");
  await assertFutureBlueprintActive(job, pin);
  return { pin, design, sourceDigest: await sourceDigest(job, assignment.blueprintSource?.sourceSha === pin.sourceSha
    ? assignment.blueprintSource.sourcePaths : assignment.sourcePaths, pin.sourceSha) };
}

/** After a signed upstream correction, preserve the original whole review
 * cycle before admitting a fresh plan. Never silently mutate a reviewed plan
 * into one about new source bytes. The archive is read-only and source-pinned. */
export async function archiveReviewedMilestoneBlueprint(job: JobStartResult,
  pin: MilestoneBlueprintPin, assignment: EventAssignment) {
  await readReviewedMilestoneBlueprint(job, pin, assignment);
  const active = fileFor(job, pin.milestoneId);
  const archived = historicalFileFor(job, pin);
  if (existsSync(archived)) {
    if (existsSync(active)) {
      const current = await load(job, pin.milestoneId);
      if (current?.lineage.reviewCycleId === pin.cycleId)
        throw Error("Two active copies of the same archived Milestone Blueprint exist.");
    }
    return;
  }
  if (!existsSync(active)) throw Error("Original approved Milestone Blueprint was lost before archival.");
  await mkdir(dirname(archived), { recursive: true });
  await rename(active, archived);
}

/** Must be called at the one Event admission boundary under the existing writer lock.
 * No other Milestone receives a plan until its own Event is reached. */
export async function ensureMilestoneBlueprint(job: JobStartResult, plan: Plan,
  assignment: EventAssignment, snapshot: SkillSnapshot, provider: string, model: string,
  task: string, head: string, fixture: boolean,
  correction?: { candidate: MilestoneBlueprint; supersedes: Supersession; sources: string[];
    exactPatch: boolean; accepts: (draft: MilestoneBlueprint) => boolean },
  parentAssignmentKey?: string, parentTurnDigest?: string, assessment?: BlueprintAssessmentGrant,
): Promise<{ blueprint: MilestoneBlueprint; pin: MilestoneBlueprintPin }> {
  if (fixture) throw Error("Obsolete Blueprint fixture execution is retired.");
  if (!MILESTONE.test(assignment.milestoneId) || !plan.items.some(i =>
      i.id === "global-architecture" && i.status === "verified" &&
      i.targetIds.includes(assignment.milestoneId)))
    throw Error("Milestone Blueprint target lacks verified Architecture authority.");
  if (!/^[a-f0-9]{40}$/.test(head) || git(job, "rev-parse", "HEAD").trim() !== head ||
      git(job, "status", "--porcelain").trim())
    throw Error("Milestone planning requires a clean, current verified canonical source.");
  const binding = await lineage(job, plan, assignment, snapshot,
    provider, model, task, head);
  const config = getConfig();
  const checkpointed = !!config?.configurable?.__pregel_checkpointer;
  if ((parentAssignmentKey && !HASH.test(parentAssignmentKey)) ||
      (parentTurnDigest && (!HASH.test(parentTurnDigest) || !parentAssignmentKey || !checkpointed)))
    throw Error("Milestone Blueprint lacks its checkpointed parent assignment.");
  const identity: AssignmentIdentity = {
    schema: "noveltea-assignment-identity/v1", jobId: job.jobId, jobThreadId: job.threadId,
    graphThreadId: checkpointed ? String(config!.configurable!.thread_id) : job.threadId,
    turnDigest: correction?.supersedes.turnDigest ?? parentTurnDigest ?? null,
    assignmentId: "milestone-blueprint:" + assignment.milestoneId,
    planVersion: plan.version, sourceHeadSha: head,
    scopeDigest: sha({ binding, parentAssignmentKey: parentAssignmentKey ?? null,
      supersedes: correction?.supersedes ?? null }),
  };
  const key = logicalAssignmentKey(identity);
  if (assessment) await authenticateBlueprintGrant(job, assessment, identity, parentAssignmentKey);
  const file = fileFor(job, assignment.milestoneId);
  let loaded = await load(job, assignment.milestoneId);
  if (loaded) {
    validateReceiptShape(loaded, assignment.milestoneId);
    assertLineage(loaded.lineage, binding);
    if (JSON.stringify(loaded.supersedes) !== JSON.stringify(correction?.supersedes))
      throw Error("Blueprint replacement belongs to a different correction grant.");
    assertRounds(loaded, assignment);
    await assertDiagnostics(job, loaded);
    if (loaded.phase === "approved") {
      if (loaded.assignmentKey !== key) throw Error("Approved Milestone Blueprint belongs to another assignment.");
      const pin = pinOf(loaded);
      return { blueprint: await readReviewedMilestoneBlueprint(job, pin, assignment, binding), pin };
    }
    if (loaded.phase === "planning" || loaded.phase === "reviewing")
      throw Error("Interrupted Milestone Blueprint Pi session; inspect original transcripts before recovery.");
    if (loaded.phase === "diagnosing") {
      const recovered = await readSealedDiagnosis(job, loaded, loaded.rounds.length - 1);
      if (!recovered)
        throw Error("Interrupted Milestone diagnostic has no sealed answer; preserve original transcript for reconciliation.");
      await applyMilestoneDiagnosis(job, loaded, recovered);
    }
    if (loaded.phase === "stopped")
      throw Error(loaded.stopReason ?? "Milestone diagnostic review safely stopped execution.");
    if (loaded.assignmentKey !== key)
      throw Error("Unfinished Milestone Blueprint does not belong to this admitted assignment.");
    if (loaded.writer) await verifySeal(job, loaded.writer, "writer");
    if (loaded.reviewer) await verifySeal(job, loaded.reviewer, loaded.reviewerRole ?? "reviewer");
  } else {
    loaded = { schema: "noveltea-milestone-plan-receipt/v1",
      lineage: binding, phase: "admitted", rounds: [], assignmentKey: key, ...(correction ? { supersedes: correction.supersedes } : {}) };
    await persist(file, loaded);
  }
  let receipt: Receipt = loaded;
  const checkCandidate = (draft: MilestoneBlueprint) => {
    if (correction && !correction.accepts(draft))
      throw Error("Correction changed material outside the exact authorized Blueprint patch.");
    return draft;
  };
  // Each graph transition runs at most one substantive writer or reviewer
  // turn. The receipt is the authority; the checkpoint only carries its
  // source-bound reference. A crash after publication reuses that receipt.
  const assertSource = async () => {
    if (git(job, "rev-parse", "HEAD").trim() !== head ||
        git(job, "status", "--porcelain").trim() ||
        await sourceDigest(job, assignment.sourcePaths, head) !== binding.sourceDigest)
      throw Error("Milestone Blueprint source changed before its next effect.");
    const current = await load(job, assignment.milestoneId);
    if (!current || current.assignmentKey !== key)
      throw Error("Milestone Blueprint lost its original assignment receipt.");
    validateReceiptShape(current, assignment.milestoneId);
    assertLineage(current.lineage, binding);
    if (JSON.stringify(current.supersedes) !== JSON.stringify(correction?.supersedes))
      throw Error("Milestone Blueprint correction grant changed.");
    assertRounds(current, assignment);
    await assertDiagnostics(job, current);
    if (current.writer) await verifySeal(job, current.writer, "writer");
    if (current.reviewer) await verifySeal(job, current.reviewer, current.reviewerRole ?? "reviewer");
    if (!["admitted", "planning", "reviewing"].includes(current.phase)) {
      const starts = current.reviewStarts ?? (current.reviewStart ? [current.reviewStart] : []);
      const drafts = current.rounds.filter((_, index) => !starts.includes(index)).map(r => r.draftDigest);
      if (current.phase === "draft" && current.reviewStart !== current.rounds.length && current.draft)
        drafts.push(sha(current.draft));
      if (!current.writer) throw Error("Settled Milestone Blueprint lacks its writer.");
      await assertBlueprintReplies(current.writer, drafts);
      const reviewers = [...(current.reviewerHistory ?? []).map(h => h.session),
        ...(current.reviewer ? [current.reviewer] : [])];
      if (reviewers.length !== starts.length + (current.reviewer ? 1 : 0))
        throw Error("Incomplete Milestone Blueprint reviewer lineage.");
      const identities = new Set([current.writer.id]);
      for (const [index, session] of reviewers.entries()) {
        if (identities.has(session.id)) throw Error("Milestone Blueprint reused a reviewer identity.");
        identities.add(session.id);
        const rounds = current.rounds.slice(index ? starts[index - 1] : 0, starts[index]);
        await assertBlueprintReplies(session, rounds.map(r => r.reviewerVerdict ? sha(r.reviewerVerdict) : r.reviewDigest),
          (text, round) => parseMilestoneBlueprintReview(text, rounds[round]!.draft,
            assignment, current.rounds.slice(0, (index ? starts[index - 1]! : 0) + round), "sealed-replay"));
      }
      for (const diagnostic of current.diagnostics ?? [])
        await assertBlueprintReplies(diagnostic.session, [sha(diagnostic.diagnosis)]);
    }
    receipt = current;
  };
  const draftSubmission = (round: number, draft: MilestoneBlueprint): AssignmentSubmission => ({
    status: "milestone-blueprint-draft",
    receiptRef: round + ":" + sha({ key, round, draftDigest: sha(draft) }), headSha: head,
  });
  const submittedRound = (submission: AssignmentSubmission): number => {
    const round = Number(submission.receiptRef.split(":")[0]);
    const draft = receipt.rounds[round]?.draft ??
      (round === receipt.rounds.length ? receipt.draft : undefined);
    if (!Number.isSafeInteger(round) || round < 0 || !draft ||
        JSON.stringify(submission) !== JSON.stringify(draftSubmission(round, draft)))
      throw Error("Milestone Blueprint checkpoint lost its exact settled draft.");
    return round;
  };
  const correctionGrant = (round: number) => sha({ key, round,
    rejected: receipt.rounds[round]?.reviewDigest,
    diagnostic: receipt.diagnostics?.find(d => d.round === round) ?? null });
  const stopped = (): AssignmentOutcome => ({
    status: "unresolved", assignmentKey: key, evidenceRef: sha(receipt),
    dispositionRef: receipt.stopReason ?? "Milestone Blueprint unresolved",
  });
  const verifyApproved = async (): Promise<AssignmentOutcome> => {
    const pin = pinOf(receipt);
    await readReviewedMilestoneBlueprint(job, pin, assignment, binding);
    return { status: "verified", assignmentKey: key, evidenceRef: sha(pin),
      headSha: head, reviewRef: receipt.rounds.at(-1)!.reviewDigest };
  };
  const writeDraft = async (): Promise<AssignmentSubmission> => {
    if (receipt.phase !== "admitted" && receipt.phase !== "revision")
      throw Error("Milestone Blueprint writer has no admitted revision.");

    const previousPhase = receipt.phase;
    // Seal ambiguity BEFORE the SDK may create a Pi transcript. A crash in
    // the creation-to-start gap cannot be mistaken for an unstarted planner.
    receipt.phase = "planning";
    await persist(file, receipt);
    let writer: Awaited<ReturnType<typeof sessionFor>>;
    try {
      writer = await sessionFor(job, snapshot, assignment, provider, model,
        "writer", binding.reviewCycleId, receipt.writer);
    } catch (error) {
      if (error instanceof PiBudgetPause) {
        // sessionFor preflights budget before creating the Pi SDK session.
        receipt.phase = previousPhase;
        await persist(file, receipt);
      }
      throw error;
    }
    try {
      const start = writer.session.messages.length;
      await reportControllerReviewPhase(previousPhase === "revision" ? "correcting" : "planning",
        { milestone: assignment.milestoneId, activity: previousPhase === "revision" ? "substantive-correction" : "blueprint-planning", role: "planner", round: receipt.rounds.length });
      await promptStorySpecialist(writer.session, writer.context.contextNote +
        plannerPrompt(assignment, task, receipt.rounds.at(-1),
          receipt.diagnostics?.at(-1)?.round === receipt.rounds.length - 1
            ? receipt.diagnostics.at(-1)?.diagnosis : undefined));
      await correctMissingReads(writer, start, snapshot, assignment, correction?.sources);
      const draft = await correctMilestoneContract(writer, job, assignment, "planner",
        raw => parseMilestoneBlueprint(raw, assignment, "review-draft"),
        "Return schema noveltea-milestone-blueprint/v1 with milestoneId " + assignment.milestoneId +
        ", events (id, purpose, dependsOn, evidence, participants, knowledge, routes), downstream (owner, obligation). " +
        "Preserve retained provisional Event IDs, source citations, and earlier Event dependencies. Knowledge is a string.", receipt.rounds.length);
      await writer.context.completed(writer.session.sessionManager.getSessionFile()!, writer.session.sessionId);
      receipt.writer = await seal(writer.session);
      receipt.draft = checkCandidate(draft);
      receipt.phase = "draft";
      await persist(file, receipt);
    } finally { writer.session.dispose(); }

    return draftSubmission(receipt.rounds.length, receipt.draft!);
  };
  const settleReview = async (verdict: MilestoneBlueprintReview, draft: MilestoneBlueprint) => {
    const review = controllerReviewDisposition(draft, assignment, verdict);
    if (review.status === "pass") assertMilestoneSources(draft, assignment);
    receipt.rounds.push({ draft, review,
      draftDigest: sha(draft), reviewDigest: sha(review),
      ...(review !== verdict ? { reviewerVerdict: verdict } : {}) });

    if (review.status === "pass") {
      receipt.approvedDigest = sha(draft);
      receipt.phase = "approved";
    } else if (correction?.exactPatch) {
      receipt.phase = "stopped";
      receipt.stopReason = "Independent reviewer rejected the exact authorized patch; a different correction needs controller reassessment.";
    } else receipt.phase = "revision";
    await persist(file, receipt);
  };
  const reviewDraft = async () => {

    if (receipt.phase !== "draft" || !receipt.draft || !receipt.writer)
      throw Error("Milestone Blueprint is not at a sealed review boundary.");
    // The initial reviewer is also an ambiguous admission if interrupted
    // between Pi session creation and its first durable start receipt.
    receipt.phase = "reviewing";
    await persist(file, receipt);
    let reviewer: Awaited<ReturnType<typeof sessionFor>>;
    try {
      reviewer = await sessionFor(job, snapshot, assignment, provider, model,
        receipt.reviewerRole ?? "reviewer",
        binding.reviewCycleId + (receipt.reviewerRole === "replacement"
          ? ":" + receipt.reviewStart : ""), receipt.reviewer);
    } catch (error) {
      if (error instanceof PiBudgetPause) {
        receipt.phase = "draft";
        await persist(file, receipt);
      }
      throw error;
    }
    try {
      assertReviewCycleSession({ id: receipt.writer.id, file: receipt.writer.file },
        { id: reviewer.session.sessionId,
          file: reviewer.session.sessionManager.getSessionFile() ?? "" },
        receipt.reviewer ? { id: receipt.reviewer.id, file: receipt.reviewer.file } : undefined);
      if (correction) {
        const old = JSON.parse(await readFile(historicalFileFor(job, correction.supersedes.original), "utf8")) as Receipt;
        if (!old.reviewer) throw Error("Historical approval lacks the original reviewer identity.");
        assertReviewCycleSession(old.reviewer, { id: reviewer.session.sessionId,
          file: reviewer.session.sessionManager.getSessionFile() ?? "" });
      }
      const start = reviewer.session.messages.length;
      const reviewHistory = receipt.rounds.slice(receipt.reviewStart ?? 0);
      await reportControllerReviewPhase("reviewing", { milestone: assignment.milestoneId,
        activity: "blueprint-review", role: "reviewer", round: reviewHistory.length });
      await promptStorySpecialist(reviewer.session, reviewer.context.contextNote +
        (receipt.reviewerRole === "replacement" && !reviewHistory.length
          ? "FRESH INDEPENDENT REPLACEMENT REVIEWER. Previous negative verdicts and " +
            "diagnostic advice are history, not approval or authority. Independently " +
            "evaluate the current exact draft and original accepted source scope. " +
            "Your verdict must meet the full current v5 review contract. " : "") +
        reviewerPrompt(assignment, receipt.draft, reviewHistory, task, plan.contract));
      await correctMissingReads(reviewer, start, snapshot, assignment, correction?.sources);
      const verdict = await correctMilestoneContract(reviewer, job, assignment, "reviewer", raw => {
        const parsed = parseMilestoneBlueprintReview(raw, receipt.draft!, assignment, reviewHistory);
        if (parsed.schema !== "noveltea-milestone-blueprint-review/v5")
          invalid("schema", "expected noveltea-milestone-blueprint-review/v5");
        return parsed;
      }, milestoneReviewContract(receipt.draft!, assignment, reviewHistory), reviewHistory.length);
      await reviewer.context.completed(reviewer.session.sessionManager.getSessionFile()!, reviewer.session.sessionId);
      receipt.reviewer = await seal(reviewer.session);
      const previousRound = reviewHistory.at(-1);
      if (verdict.status === "pass" && previousRound?.review.status === "revise" &&
          (previousRound.draftDigest === sha(receipt.draft) ||
            !milestonePassCorrections(receipt.draft, reviewHistory, verdict)))
        throw Error("Milestone reviewer cannot approve without repairing the exact rejected material field.");
      await settleReview(verdict, receipt.draft);
      await reportControllerReviewPhase("reviewed", { milestone: assignment.milestoneId, activity: "blueprint-review",
        role: "reviewer", round: reviewHistory.length, verdict: verdict.status, findings: verdict.findings.length,
        reason: verdict.findings.map(f => f.reason).join("; ").slice(0, 1000) });
    } finally { reviewer.session.dispose(); }
  };
  const assessNegative = async (round: number) => {
    if (receipt.phase !== "revision" || round !== receipt.rounds.length - 1)
      throw Error("Milestone Blueprint diagnosis lacks its sealed negative Review.");
    const reviewStart = receipt.reviewStart ?? 0;
    const active = receipt.rounds.slice(reviewStart);
    const diagnosedAt = (receipt.diagnostics ?? []).filter(d => d.round >= reviewStart)
      .map(d => d.round + 1 - reviewStart);
    const trigger = milestoneDiagnosticTrigger(active, diagnosedAt, milestoneReviewStagnation(active, assignment));
    const continuationDue = receipt.diagnostics?.at(-1)?.diagnosis.action === "continue" &&
      receipt.diagnostics.at(-1)!.round === round;
    if (!trigger || continuationDue) return;
    const last = receipt.rounds[round]!;
    if (parentTurnDigest && !assessment) {
      if (!receipt.writer || !receipt.reviewer)
        throw Error("Milestone Blueprint assessment lacks independent settled sessions.");
      await requestBlueprintAssessment(job, { schema: "noveltea-blueprint-assessment/v1",
        identity, parentAssignmentKey: parentAssignmentKey!, round, draftDigest: last.draftDigest,
        reviewDigest: last.reviewDigest, trigger, writer: receipt.writer, reviewer: receipt.reviewer,
        context: { plan, snapshot, provider, model, task, assignment, cycleId: binding.reviewCycleId } });
    }
    const fingerprint = milestoneDiagnosticFingerprint(binding.reviewCycleId,
      last.draft, last.review.findings, { task, contract: plan.contract });
    if ((receipt.diagnostics ?? []).some(d => d.caseFingerprint === fingerprint)) {
      receipt.phase = "stopped";
      receipt.stopReason = milestoneDiagnosticDecision("continue", true).reason;
      await persist(file, receipt);
      return;
    }
    receipt.phase = "diagnosing";
    await persist(file, receipt);
    const diagnostic = await runMilestoneDiagnosis(job, snapshot, assignment,
      provider, model, task, receipt, plan.contract, trigger);
    await applyMilestoneDiagnosis(job, receipt, diagnostic);
  };
  const child = createAssignmentLifecycleGraph({
    preflight: async state => {
      if (logicalAssignmentKey(state.identity) !== key)
        throw Error("Milestone Blueprint checkpoint belongs to another assignment.");
      await assertSource();
      return null;
    },
    invoke: async () => {
      await assertSource();
      if (receipt.phase === "admitted") return writeDraft();
      if (receipt.phase === "draft") return draftSubmission(receipt.rounds.length, receipt.draft!);
      if (receipt.phase === "revision" || receipt.phase === "approved")
        return draftSubmission(receipt.rounds.length - 1, receipt.rounds.at(-1)!.draft);
      if (receipt.phase === "stopped") return stopped();
      throw Error("Interrupted Milestone Blueprint has no settled writer receipt.");
    },
    verify: async state => {
      await assertSource();
      const round = submittedRound(state.submission!);
      if (round === receipt.rounds.length && receipt.phase === "draft")
        await reviewDraft();
      if (round !== receipt.rounds.length - 1)
        throw Error("Milestone Blueprint review advanced beyond its original submission.");
      if (receipt.phase === "approved") return verifyApproved();
      if (receipt.phase === "stopped") return stopped();
      if (receipt.phase === "revision") { await assessNegative(round); await assertSource(); }
      if ((receipt.phase as Phase) === "stopped") return stopped();
      if (receipt.phase === "draft" && receipt.reviewStart === receipt.rounds.length)
        return { submission: draftSubmission(receipt.rounds.length, receipt.draft!), reviewPending: true as const };
      if (receipt.phase !== "revision")
        throw Error("Milestone Blueprint negative Review has no settled continuation.");
      return { correctionRef: correctionGrant(round), rejectedReceiptRef: state.submission!.receiptRef };
    },
    correct: async state => {
      await assertSource();
      const round = submittedRound(state.submission!);
      if (round !== receipt.rounds.length - 1 || state.correction!.correctionRef !== correctionGrant(round))
        throw Error("Milestone Blueprint correction lacks its original negative Review grant.");
      if (receipt.phase === "draft" && receipt.reviewStart !== receipt.rounds.length)
        return draftSubmission(receipt.rounds.length, receipt.draft!);
      return writeDraft();
    },
  }, checkpointed);
  const finished = await child.invoke({ identity, submission: null, submissionKey: null,
    outcome: null, continuationRef: null }, checkpointed
    ? { ...assignmentChildConfig(config!, identity), durability: "sync" }
    : { recursionLimit: 10000 });
  if (finished.outcome?.status !== "verified")
    throw Error(receipt.stopReason ?? "Milestone Blueprint did not produce an independently approved pin.");
  await assertSource();
  const pin = pinOf(receipt);
  if (finished.outcome.evidenceRef !== sha(pin))
    throw Error("Milestone Blueprint child returned a foreign approval.");
  return { blueprint: await readReviewedMilestoneBlueprint(job, pin, assignment, binding), pin };
}

/** Locate the exact current or archived pin of an assessed assignment. */
export async function readAssessmentMilestoneApproval(job: JobStartResult, assignment: EventAssignment,
  cycleId: string, sourceHead: string, key: string, digest?: string) {
  if (!HASH.test(cycleId) || !HASH.test(key) || !HASH.test(digest ?? "")) return false;
  const historical = historicalFileFor(job, { milestoneId: assignment.milestoneId, cycleId, sourceSha: sourceHead, digest: "" });
  const record = existsSync(historical)
    ? JSON.parse(await readFile(historical, "utf8")) as Receipt
    : await load(job, assignment.milestoneId);
  if (!record || record.phase !== "approved" || record.assignmentKey !== key ||
      record.lineage.reviewCycleId !== cycleId || record.lineage.executionHead !== sourceHead) return false;
  const pin = pinOf(record);
  if (sha(pin) !== digest) return false;
  await readReviewedMilestoneBlueprint(job, pin, assignment, record.lineage);
  return true;
}
