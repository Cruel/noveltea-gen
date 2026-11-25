import { nativeMetadataDefects, assignmentCommittedEffect, type AssignmentDiagnosticAuthorization } from "./assignment-metadata-recovery.js";
import { execFileSync } from "./git-read-cache.js";
import { commitOrigin, readRecoveryFork } from "./recovery-fork-state.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { authorInteractive, interactiveInvocationDirectory, parseInteractiveManifest, type InteractiveAssignment, type InteractiveDomain, type InteractiveEvidence } from "./interactive-specialist.js";
import { inspectAssignmentFailure, verifySettledAssignment, type AssignmentInvocationProof, type AssignmentRoundCommand } from "./assignment-metadata-recovery.js";
import { inspectPiPolicy } from "./job-pi-policy.js";
import { eventCompletionDigest, currentMilestoneChoiceBinding } from "./event-work.js";
import { startStoryJob, type JobStartResult } from "./job.js";
import { trustedHead } from "./revision.js";
import { finalizeRecoveryCheckpoint } from "./recovery-checkpoints.js";
import { assertNativeReviewDependencies } from "./checkpoint-assurance.js";
import { verifiedNarrativeSuccessor, verifiedCompositionSuccessor } from "./job-successor.js";
import { withStoryJobLock, withStoryJobLockOrReuse } from "./job-lock.js";
import { assertPlanContinuity } from "./plan-continuity.js";
import { processAuthorUpdatesAtBoundary, processAuthorUpdatesAfterWork } from "./author-updates.js";
import { loadSkillConfig } from "./skills.js";
import { preflightPiAssignment } from "./job-pi-policy.js";
import { createSkillSnapshot, openSkillSnapshot, type SkillSnapshot } from "./snapshot.js";
import { validateStoryJob, type ValidationResult } from "./validator.js";
import type { Plan } from "./architecture.js";
import type { ExecutionItem } from "./generation-plan.js";
import { preservesWholeStoryInteraction } from "./adaptive-assignments.js";
import { parseStoryPlanning } from "./story-planning.js";
import { puzzleObligation, sealPuzzleNoWrite, readPuzzleNoWrite, puzzleNoWriteSessionDigest,
  type PuzzleNoWriteRef } from "./puzzle-obligation.js";
import { decideEventOnlyOmission, eventOnlySourceCandidate, readEventOnlyOmission, type EventOnlyRef } from "./interactive-event-only.js";
import { historicalMilestoneHandoff, reviewedMilestoneHandoff, consumedCorrection,
  assertMilestoneInteractiveDisposition, type ReviewedMilestoneHandoff } from "./milestone-obligation-handoff.js";
import { correctPendingBlueprint } from "./milestone-blueprint-correction.js";
import type { MilestoneBlueprintPin } from "./milestone-blueprint.js";
import type { EventAssignment } from "./event-specialist.js";

type Phase = "pending" | "writing" | "authored" | "committed" | "not-applicable" | "conflicted";
interface Unit {
  id: string; domain: InteractiveDomain; phase: Phase;
  beforeHead?: string; commitSha?: string; paths?: string[]; digest?: string;
  claimedPaths?: string[]; piSessionFile?: string; skillReads?: string[];
  assignmentKey?: string;
  piSessionId?: string; invocationProof?: AssignmentInvocationProof;
  /** Native pre-writer baseline and exact original assignment, bound to the first grant. */
  invocation?: { baseline: Report; assignment: InteractiveAssignment; sourceDigest: string };
  conflicts?: string[]; obligations?: string[]; failure?: string;
  noWrite?: PuzzleNoWriteRef;
  /** Original settled negative report; never a new writer lease. */
  piSessionSha256?: string;
  piSessionBytes?: number;
  dependencyFinding?: import("./dependency-amendments.js").WriterDependencyFinding;
  writerContinuation?: import("./writer-dependency.js").WriterContinuation;
  retainedChoice?: RetainedChoiceContinuation;
  eventOnly?: EventOnlyRef;
  validation?: { status: "passed"; validatorVersion: string; protectionBase: string;
    choices: ChoiceEvidence[]; puzzles: PuzzleEvidence[]; downstreamObligations: string[]; searchTruncated: boolean };
}
interface Receipt {
  version: 1; jobId: string; baseSha: string; workItemId: string; milestoneId: string;
  planVersion: number; planDigest: string; eventHead: string; worker: "fixture" | "pi";
  provider: string; model: string; thinking?: "low" | "medium" | "high"; snapshot?: SkillSnapshot;
  correctedBlueprintPin?: MilestoneBlueprintPin;
  /** Immutable historical negative Choice receipt, archived before a reviewed
   * no-write correction replaces this active dependent disposition. */
  supersededNegative?: { relative: string; digest: string };
  eventSource?: InteractiveAssignment["eventSource"]; units: [Unit, Unit];
}
interface SourceReceipt {
  jobId: string; phase: string; milestoneId: string; commitSha?: string;
  planVersion: number; workItemId: string; snapshot?: SkillSnapshot;
  paths?: string[]; contentDigest?: string; obligations?: string[];
  blueprintRequired?: boolean; blueprintPin?: MilestoneBlueprintPin;
  assignment?: EventAssignment;
  validation?: { status: "passed"; eventIds: string[];
    milestoneState?: "complete" | "partial-choice-pending" };
}
interface ArchitectureReceipt { jobId: string; phase: string; expectedHead: string; plan?: Plan }
type Status = "reachable" | "impossible" | "unverified" | "incomplete";
interface RecordItem { path: string; metadata: Record<string, any> & { id: string; type: string; status: string } }
interface Report {
  records: RecordItem[];
  diagnostics: Array<{ path: string; code: string; line?: number; column?: number; message: string }>;
  outstanding: Array<{ id: string; path: string; field: string; requiredBy: string }>;
  protection: { status: string; base?: string; changes: unknown[]; warnings: unknown[] };
  coverage: {
    search: { truncated: boolean };
    eventProgress: Array<{ id: string; status: Status; witness?: string[] }>;
    branchProgress: Array<{ event: string; step: string; branch: string; status: Status; witness?: string[] }>;
    milestoneRoutes: Array<{ id: string; routes: Array<{ status: Status; witness?: string[] }> }>;
    puzzleSolutions: Array<{ id: string; solutions: Array<{ event: string; status: Status;
      witness?: string[]; clueAccess: { status: Status; availableClues: string[]; witness?: string[] } }> }>;
    narrativeState: Array<{ id: string; status: Status; state: Array<{ status: string }> }>;
  };
}
interface ChoiceEvidence {
  id: string; outcomes: Array<{ name: string; event: string; step: string; branch: string;
    consequence: string; downstream: string[] }>;
}
interface PuzzleEvidence { id: string; solutions: Array<{ event: string; status: Status; clueAccess: Status; clueIds: string[] }> }
export interface RetainedChoiceContinuation {
  caseId: string; reportDigest: string; originalHead: string; sessionSha256: string;
  turnDigest: string; planVersion: number; adaptiveVersion: number; amendmentDigest: string;
  blueprintDigest: string; decline: "protected-author" | "story-wide-obligation" | "native-required" | "independent-review";
  reviewDigest?: string;
}
export interface InteractiveOptions {
  story: string; job: string; action: "run" | "inspect" | "review-omission"; milestone: string;
  skillsSource?: string; validatorSource?: string; fixture?: boolean; provider?: string; model?: string; task?: string; thinking?: "low" | "medium" | "high";
  /** Production graph can checkpoint Choice and Puzzle independently; the
   * persisted two-unit receipt and original writer/review gates are shared. */
  unit?: InteractiveDomain;
  round?: { assignmentKey: string; command: AssignmentRoundCommand; retainedChoice?: RetainedChoiceContinuation };
  /** The composite parent owns the boundary between independently reviewed units. */
  deferBoundary?: boolean;
  interactionInventory?: ExecutionItem[];
  generationObjective?: string; turnPlanDigest?: string;
}
const validMilestone = /^milestone\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function git(job: JobStartResult, ...args: string[]) {
  const env = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[k];
  return execFileSync("git", args, { cwd: job.worktreeRoot, env, encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function dirty(job: JobStartResult) {
  const env = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[k];
  return execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { cwd: job.worktreeRoot, env, encoding: "utf8" }).split("\0").filter(Boolean);
}
const repoPath = (job: JobStartResult, path: string) => job.storyRelativePath
  ? job.storyRelativePath + "/" + path : path;
async function persist(file: string, value: unknown) {
  await mkdir(dirname(file), { recursive: true });
  const temp = file + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await rename(temp, file);
}
function assertHead(job: JobStartResult, expected: string) {
  if (git(job, "rev-parse", "HEAD") !== expected || git(job, "symbolic-ref", "--short", "HEAD") !== job.branch) {
    throw new Error("Interactive Story head or branch changed; inspect before continuing.");
  }
}
function reportOf(result: ValidationResult, head: string): Report {
  const report = result.report as unknown as Report | undefined;
  if (result.status !== "passed" || !report || report.diagnostics?.length ||
      !Array.isArray(report.records) || !Array.isArray(report.outstanding) ||
      report.protection?.status !== "checked" || report.protection.changes.length ||
      report.protection.warnings.length || !report.coverage ||
      !Array.isArray(report.coverage.branchProgress) || !Array.isArray(report.coverage.puzzleSolutions)) {
    throw new Error("Interactive canonical validator/protection failed against verified " + head + ": " +
      JSON.stringify(result).slice(0, 9000));
  }
  return report;
}
export function selectAssignment(plan: Plan, report: Report, milestoneId: string,
  eventSource?: InteractiveAssignment["eventSource"],
  milestoneBlueprint?: ReviewedMilestoneHandoff): InteractiveAssignment {
  if (plan.contract.scope.depth === "architecture") throw new Error("Completion contract does not authorize interactive work.");
  const architecture = plan.items.find(i => i.id === "global-architecture");
  if (architecture?.status !== "verified" || !architecture.targetIds.includes(milestoneId)) {
    throw new Error("Milestone is outside the verified architecture scope.");
  }
  const records = report.records.filter(r => r.metadata.status !== "superseded");
  const milestone = records.find(r => r.metadata.id === milestoneId && r.metadata.type === "milestone");
  const staged = eventSource?.milestoneState === "partial-choice-pending" &&
    milestone?.metadata.completeness === "partial" &&
    Array.isArray(milestone.metadata.fulfillment?.any_of) &&
    milestone.metadata.fulfillment.any_of.length === 0 &&
    eventSource.missingObligations.length > 0 && eventSource.eventIds.length > 0;
  // Older independently reviewed Event receipts can predate the controller's
  // nondecision-vs-future-Choice distinction. Do NOT dispatch another Pi
  // specialist to manufacture a Choice to satisfy their stale "partial"
  // marker. The Event's selected Milestone needs a separately authorized,
  // source-bound completeness/fulfillment reconciliation instead.
  if (staged && !currentMilestoneChoiceBinding(eventSource!.missingObligations,
      milestoneId, String(milestone!.metadata.change ?? ""), milestoneBlueprint?.design))
    throw new Error("Historical nondecision Event was left partial for a later Story Choice, " +
      "not a Choice obligation on " + milestoneId + ". Reconcile the selected Event " +
      "Milestone's fulfillment/completeness with native validation and independent " +
      "review; do not invent an Interactive Choice or silently mark this unit complete.");
  if (!milestone || !staged && (!milestone.metadata.fulfillment?.any_of?.length ||
      !report.coverage.milestoneRoutes.find(r => r.id === milestoneId)?.routes.some(r => r.status === "reachable"))) {
    throw new Error("Interactive design requires a verified reachable Event cluster or an explicitly staged Choice obligation.");
  }
  if (eventSource?.milestoneState === "partial-choice-pending" && !staged)
    throw new Error("Staged Event source no longer matches the original partial Milestone and Choice obligations.");
  const arcIds = milestone.metadata.arcs as string[];
  if (!arcIds.length || arcIds.some(id => !architecture.targetIds.includes(id))) {
    throw new Error("Milestone references an unauthorized Arc.");
  }
  const eventIds = staged ? eventSource!.eventIds : (milestone.metadata.fulfillment.any_of as string[][]).flat();
  const adjacent = records.filter(r => r.metadata.type === "event" &&
    (r.metadata.arcs as string[]).some(id => arcIds.includes(id)));
  const characters = records.filter(r => r.metadata.type === "arc" && arcIds.includes(r.metadata.id))
    .flatMap(r => r.metadata.characters as string[]);
  const characterIds = [...new Set(characters)].sort();
  if (characterIds.length < 2 || !eventIds.length || eventIds.some(id =>
    !adjacent.some(event => event.metadata.id === id &&
      report.coverage.eventProgress.some(progress => progress.id === id && progress.status === "reachable"))))
    throw new Error("Missing or unreachable verified Character/World/Event foundations.");
  const references = new Set<string>([...characterIds, ...eventIds, ...arcIds]);
  // Existing Puzzles may use these Events without being referenced back by
  // the Events. Include them and their clues in the editable/context inventory.
  for (const puzzle of records.filter(r => r.metadata.type === "puzzle" &&
      (r.metadata.solutions as string[] ?? []).some(id =>
        adjacent.some(event => event.metadata.id === id)))) {
    references.add(puzzle.metadata.id);
    for (const clue of (puzzle.metadata.clues as string[] ?? [])) references.add(clue);
  }
  for (const event of adjacent) {
    references.add(event.metadata.id);
    for (const id of event.metadata.participants as string[]) references.add(id);
    const walk = (value: unknown): void => {
      if (typeof value === "string" && /^(?:fact|relationship|revelation|choice-point)\./.test(value)) references.add(value);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") Object.values(value).forEach(walk);
    };
    walk(event.metadata.steps);
    walk(event.metadata.prerequisites);
  }
  const related = records.filter(r => r.metadata.type === "creative-direction" ||
    r.metadata.type === "world-entity" ||
    r.metadata.id === milestoneId || references.has(r.metadata.id) ||
    r.metadata.type === "fact" && records.some(c => characterIds.includes(c.metadata.id) &&
      (c.metadata.initial_knowledge as Array<{ fact: string }> ?? []).some(k => k.fact === r.metadata.id)) ||
    r.metadata.type === "relationship" && (r.metadata.characters as string[] ?? []).every(id => characterIds.includes(id)));
  return { workItemId: "interactive-" + milestoneId.slice(10), milestoneId, arcIds, characterIds,
    factIds: related.filter(r => r.metadata.type === "fact").map(r => r.metadata.id),
    eventIds: [...new Set(staged ? eventIds : adjacent.map(r => r.metadata.id))].sort(),
    ...(eventSource ? { eventSource } : {}),
    ...(milestoneBlueprint ? { milestoneBlueprint } : {}),
    sourcePaths: [...new Set(related.map(r => r.path))].sort(),
    authorContract: plan.contract, protectedRouteGates: "immutable-existing-event-prerequisites",
    authorizedPaths: ["events/", "choice-points/", "puzzles/", "authored-content/", "revelations/", "facts/", "relationships/", "narrative-positions/"],
    downstreamRequirements: [...(staged ? eventSource!.missingObligations : []),
      "Player-perceivable branch effects", "Later conditional payoff or explicit writing obligations",
      "Independent clue text/fairness and presentation review"] };
}
/** A tracked, unstaged change to an assignment's read-only source may be
 * repaired by the same Pi session. It is never authorized for publication. */
export class RepairableInteractiveGateError extends Error {
  constructor(readonly paths: string[]) {
    super("Original Event prerequisite route gate was changed or bypassed: " + paths.join(", "));
  }
}
export class RepairableInteractiveScopeError extends Error {
  constructor(readonly paths: string[]) {
    super("Unauthorized interactive specialist file(s): " + paths.join(", "));
  }
}
export function prerequisitesText(text: string) {
  const lines = text.split("\n");
  if (lines[0] !== "---") throw new Error("Existing Event is missing canonical frontmatter.");
  const end = lines.indexOf("---", 1);
  if (end < 0) throw new Error("Existing Event has unclosed frontmatter.");
  const begin = lines.findIndex((line, i) => i > 0 && i < end && /^prerequisites:/.test(line));
  if (begin < 0) throw new Error("Existing Event has no prerequisite gate.");
  let next = begin + 1;
  while (next < end && (/^[ \t]/.test(lines[next]!) || lines[next]!.trim() === "")) next++;
  return lines.slice(begin, next).join("\n");
}
export async function auditInteractivePaths(job: JobStartResult, assign: InteractiveAssignment,
  domain: InteractiveDomain, claimed: string[]) {
  const paths: string[] = [];
  const readOnlyEdits: string[] = [];
  const gateEdits: string[] = [];
  const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
  const changes = dirty(job);
  // Check EVERY change before offering any soft repair: staged/deleted/renamed
  // files, out-of-Story writes and symlink destinations are hard failures.
  // An earlier benign read-only edit must never hide a later hard violation.
  for (const entry of changes) {
    if (!["??", " M"].includes(entry.slice(0, 2))) {
      throw new Error("Interactive specialist staged, deleted or renamed files: " + entry);
    }
    const path = entry.slice(3);
    if (!path.startsWith(prefix)) throw new Error("Interactive specialist wrote outside Story: " + path);
    const local = path.slice(prefix.length);
    const pathOnDisk = join(job.worktreeStoryRoot, local);
    if (await realpath(pathOnDisk) !== pathOnDisk || !(await lstat(pathOnDisk)).isFile()) {
      throw new Error("Unsafe interactive Story file: " + local);
    }
  }
  for (const entry of changes) {
    const local = entry.slice(3).slice(prefix.length);
    const type = local.split("/")[0]!;
    const knownSource = entry.startsWith(" M") && assign.sourcePaths.includes(local);
    if (!/^(events|choice-points|puzzles|authored-content|revelations|facts|relationships|narrative-positions)\/[a-z][a-z0-9-]*\.md$/.test(local)) {
      if (knownSource && /^(creative-direction|arcs|characters|milestones|world-entities)\/[a-z][a-z0-9-]*\.md$/.test(local)) {
        readOnlyEdits.push(local);
        continue;
      }
      throw new Error("Unauthorized interactive specialist file: " + local);
    }
    if (domain === "choice" && type === "puzzles" ||
        domain === "puzzle" && type === "choice-points") {
      throw new Error("Interactive specialist cannot write another specialist\'s Choice/Puzzle records: " + local);
    }
    if (entry.startsWith(" M")) {
      if (!assign.sourcePaths.includes(local)) {
        throw new Error("Interactive specialist edited unrelated source: " + local);
      }
      if (!["events", "choice-points", "revelations", "puzzles", "authored-content"].includes(type)) {
        readOnlyEdits.push(local);
        continue;
      }
      if (type === "events") {
        const oldText = git(job, "show", "HEAD:" + repoPath(job, local));
        const newText = await readFile(join(job.worktreeStoryRoot, local), "utf8");
        if (prerequisitesText(oldText) !== prerequisitesText(newText)) {
          gateEdits.push(local); // Complete the scan before offering repair.
        }
      }
    }
    paths.push(local);
  }
  if (readOnlyEdits.length) throw new RepairableInteractiveScopeError(readOnlyEdits.sort());
  if (gateEdits.length) throw new RepairableInteractiveGateError(gateEdits.sort());
  paths.sort();
  if (!paths.length || claimed.length !== paths.length ||
      JSON.stringify([...new Set(claimed)].sort()) !== JSON.stringify(paths)) {
    throw new Error("Interactive specialist manifest differs from actual Git files: " +
      JSON.stringify({ actual: paths, claimed }));
  }
  // Edits to an existing linked Event or clue can complete an already
  // established Choice/Puzzle without rewriting its canonical definition.
  // checkOutput verifies the assigned domain from the final catalog instead.
  return paths;
}
/** A repair attempt must never bypass the pinned Git protection decision,
 * even when the immediate complaint is just an incomplete file manifest. */
async function assertSafeInteractiveRepair(job: JobStartResult, before: string,
  validate: (head: string) => Promise<ValidationResult>) {
  assertHead(job, before);
  const checked = await validate(before);
  const report = checked.report as unknown as Report | undefined;
  if (checked.jobId !== job.jobId || checked.worktreeStoryRoot !== job.worktreeStoryRoot ||
      checked.baseSha !== before ||
      !["passed", "rejected"].includes(checked.status) ||
      report?.protection?.status !== "checked" || report.protection.base !== before ||
      !Array.isArray(report.protection.changes) || report.protection.changes.length ||
      !Array.isArray(report.protection.warnings) || report.protection.warnings.length) {
    throw new Error("Interactive repair refused: unverified or protected Story changes, or mismatched job identity.");
  }
}
/** A writer's conflict report is not proof that its own draft is unrepairable.
 * The native validator may identify defects entirely within the already-audited
 * writable files (for example an outcome that tests itself before selection).
 * Only those source-local diagnostics may be returned for an in-session retry;
 * a cross-owner diagnostic never expands the writer's grant. */
export function interactiveConflictRepairFeedback(
  conflicts: readonly string[], changedPaths: readonly string[],
  diagnostics: readonly Report["diagnostics"][number][],
): string[] | undefined {
  if (!conflicts.length || !diagnostics.length ||
      !diagnostics.every(item => changedPaths.includes(item.path) &&
        item.code && item.message)) return undefined;
  return [
    ...diagnostics.slice(0, 24).map(item =>
      `${item.path}:${item.line ?? 1}:${item.column ?? 1} ${item.code}: ${item.message}`),
    "These native errors concern only files already within your audited write grant. " +
      "Correct the reachable selecting step and any other actual defects in those files " +
      "using the SAME Pi session; do not edit existing Event prerequisite gates, " +
      "read-only records, or protected author decisions. Do not make an outcome " +
      "condition depend on that outcome's own first assignment. " +
      "Revalidate before clearing architecturalConflicts. If a genuine dependency " +
      "outside your grant remains, report it unchanged; this feedback grants no new scope.",
  ];
}
/** Only offer repair when the job identity and pinned Git protection prove
 * the out-of-scope edit did not alter protected author decisions. Nothing is
 * reverted or authorized by the graph on the agent's behalf. */
export async function scopeRepairFeedback(job: JobStartResult, before: string, error: unknown,
  validate: (head: string) => Promise<ValidationResult>): Promise<string[] | undefined> {
  if (!(error instanceof RepairableInteractiveScopeError ||
        error instanceof RepairableInteractiveGateError)) return undefined;
  await assertSafeInteractiveRepair(job, before, validate);
  if (error instanceof RepairableInteractiveGateError) return [error.message +
    ". Existing Event prerequisites are immutable, including every completed/not_completed alternative. " +
    "Read the original Event files at the exact pinned HEAD and restore ONLY the " +
    "prerequisites YAML blocks on these paths byte-for-byte using authorized read/edit tools; " +
    "do not use git checkout, restore, reset, add or commit. Do not change your writer's " +
    "scope or invent a new prerequisite to make the route appear reachable. " +
    "Retain your other legitimate Choice/Outcome edits where allowed. Remove any newly " +
    "invented reference to a Choice Point until that record exists, or create the actual " +
    "authorized Choice Point first. Inspect the full changed-file inventory and rerun " +
    "native validation; this correction is NOT a grant to rewrite the entry gate."];
  return [error.message + ". These are READ-ONLY context records, not editable targets. " +
    "Restore ONLY these files to their exact, pre-work-item Git HEAD contents using read/edit/write; " +
    "do not use git checkout, restore, reset, add or commit. Compare each with git diff -- <path> " +
    "to confirm there is no remaining change. Preserve all authorized edits. " +
    "Do not include restored files in modifiedRecords. If the design truly needs these edits, " +
    "leave them unchanged at HEAD and report the proposed change as a later obligation or conflict."];
}
async function interactiveEffect(job: JobStartResult, before: string) {
  assertHead(job, before);
  const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
  const paths: string[] = [];
  for (const entry of dirty(job)) {
    const path = entry.slice(3);
    if (!["??", " M"].includes(entry.slice(0, 2)) || !path.startsWith(prefix))
      throw Error("Interactive invocation has an unsafe Git effect");
    const local = path.slice(prefix.length);
    if (!/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*\.md$/.test(local))
      throw Error("Interactive invocation has an unsafe path");
    const absolute = join(job.worktreeStoryRoot, local);
    if (await realpath(absolute) !== absolute || !(await lstat(absolute)).isFile())
      throw Error("Interactive invocation has an unsafe file");
    paths.push(local);
  }
  return paths.length ? fileDigest(job, paths.sort()) : null;
}
async function interactiveSourceDigest(job: JobStartResult, receipt: Receipt, unit: Unit,
    baseline: Report, assignment: InteractiveAssignment) {
  const { resolved } = await inspectPiPolicy(job);
  if (!resolved || !receipt.snapshot || !unit.beforeHead)
    throw Error("Original Interactive invocation lacks pinned model/source");
  return digest(JSON.stringify({ job: job.jobId, thread: job.threadId, base: job.baseSha,
    branch: job.branch, plan: receipt.planDigest, planVersion: receipt.planVersion,
    head: unit.beforeHead, unit: unit.id, assignmentKey: unit.assignmentKey, eventSource: receipt.eventSource,
    ...(unit.writerContinuation ? { writerContinuation: unit.writerContinuation } : {}),
    ...(unit.retainedChoice ? { retainedChoice: unit.retainedChoice } : {}),
    blueprint: receipt.correctedBlueprintPin, snapshot: receipt.snapshot.id,
    worker: receipt.worker, provider: receipt.provider, model: receipt.model,
    selected: resolved.selected, thinking: resolved.thinking, validator: job.validatorVersion,
    turn: await readFile(join(job.stateDir, "turn-plan.json"), "utf8").catch(e => {
      if (e.code === "ENOENT") return null; throw e;
    }), baseline, assignment }));
}
async function fileDigest(job: JobStartResult, paths: string[]) {
  return digest(JSON.stringify(await Promise.all(paths.map(async path =>
    [path, digest(await readFile(join(job.worktreeStoryRoot, path)))]))));
}
/** Original Event authorship is sealed at its own commit, not at a later
 * verified successor. Independent corrections and Choice bindings can
 * legitimately change the same Event file after its original source commit.
 * The caller separately verifies every intervening native/Git checkpoint and
 * independent verdict via verifiedNarrativeSuccessor. Never use an arbitrary
 * unreviewed current version as the original Event digest. */
export function originalEventFileDigest(job: JobStartResult, sourceSha: string, paths: string[]): string {
  if (!/^[a-f0-9]{40}$/.test(sourceSha) || !paths.length ||
      paths.some(path => !/^(?:events|milestones|arcs|facts|revelations|relationships)\/[a-z][a-z0-9._-]*\.md$/.test(path)))
    throw Error("Original Event digest requires a pinned Git commit and canonical Event paths.");
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"])
    delete env[key];
  return digest(JSON.stringify(paths.map(path => [path, digest(execFileSync("git",
    ["show", sourceSha + ":" + repoPath(job, path)], { cwd: job.worktreeRoot,
      env, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }))])));
}
function findEventRecords(report: Report) {
  return report.records.filter(r => r.metadata.type === "event" && r.metadata.status !== "superseded");
}
function selectEffects(event: RecordItem) {
  return (event.metadata.steps as Array<{ id: string; branches: Array<{ id: string; conditions: Array<Record<string, any>>; effects: Array<Record<string, any>> }> }> ?? [])
    .flatMap(step => step.branches.map(branch => ({ event: event.metadata.id,
      step: step.id, branch: branch.id, conditions: branch.conditions, effects: branch.effects })));
}
function checkProgress(original: Report, candidate: Report, milestoneId: string, paths: string[] = []) {
  const oldMilestone = original.coverage.milestoneRoutes.find(m => m.id === milestoneId);
  const nowMilestone = candidate.coverage.milestoneRoutes.find(m => m.id === milestoneId);
  if (oldMilestone?.routes.some(r => r.status === "reachable") &&
      !nowMilestone?.routes.some(r => r.status === "reachable")) {
    throw new Error("The previously fulfilled Milestone lost all reachable routes.");
  }
  for (const previous of original.coverage.eventProgress.filter(p => p.status === "reachable")) {
    const current = candidate.coverage.eventProgress.find(p => p.id === previous.id);
    if (current?.status !== "reachable") {
      throw new Error("Previously reachable Event became impossible/unverified: " + previous.id);
    }
  }
  for (const previous of original.coverage.branchProgress.filter(p => p.status === "reachable")) {
    const previousPath = original.records.find(r => r.metadata.id === previous.event)?.path;
    // Interactive design may replace the internal steps of an explicitly
    // authorized Event, provided its entry gate and entire Event stay live.
    if (previousPath && paths.includes(previousPath)) continue;
    const current = candidate.coverage.branchProgress.find(p => p.event === previous.event &&
      p.step === previous.step && p.branch === previous.branch);
    if (current?.status !== "reachable") {
      throw new Error("Previously reachable branch lost its reachability: " + previous.event + "#" + previous.step + "/" + previous.branch);
    }
  }
  for (const previous of original.coverage.puzzleSolutions) {
    const current = candidate.coverage.puzzleSolutions.find(p => p.id === previous.id);
    for (const solution of previous.solutions.filter(s => s.status === "reachable" && s.clueAccess.status === "reachable")) {
      const now = current?.solutions.find(s => s.event === solution.event);
      if (now?.status !== "reachable" || now.clueAccess.status !== "reachable") {
        throw new Error("Previously certified Puzzle solution/clue lost its route: " + previous.id + "/" + solution.event);
      }
    }
  }
}
function verifyChoice(report: Report, paths: string[], assign: InteractiveAssignment, obligations: string[]): ChoiceEvidence[] {
  const records = report.records.filter(r => r.metadata.status !== "superseded");
  // An Arc may contain several Milestones. Merely appearing in the broad
  // read-only context must not pull a previous Milestone's Choice into the
  // current work item's verification receipt.
  const affectedEvents = findEventRecords(report).filter(event =>
    paths.includes(event.path) || records.some(content =>
      paths.includes(content.path) && content.metadata.type === "authored-content" &&
      (content.metadata.events as string[] ?? []).includes(event.metadata.id)));
  const affectedChoices = new Set(affectedEvents.flatMap(selectEffects)
    .flatMap(branch => branch.effects.filter(effect => effect.kind === "outcome")
      .map(effect => effect.choice_point as string)));
  const choiceRecords = records.filter(r => r.metadata.type === "choice-point" &&
    (paths.includes(r.path) ||
      assign.sourcePaths.includes(r.path) && affectedChoices.has(r.metadata.id)));
  if (!choiceRecords.length) throw new Error("No authored Choice Point in interactive work item.");
  const events = findEventRecords(report);
  const branches = events.flatMap(selectEffects);
  return choiceRecords.map(record => {
    const outcomes = record.metadata.outcomes as string[];
    if (record.metadata.completeness === "partial" || outcomes.length < 2) {
      throw new Error("Choice Point must declare two or more finished outcomes: " + record.metadata.id);
    }
    const evidence = outcomes.map(outcome => {
      const candidates = branches.filter(branch => branch.effects.some(effect =>
        effect.kind === "outcome" && effect.choice_point === record.metadata.id && effect.value === outcome));
      const witness = candidates.find(branch => report.coverage.branchProgress.some(p =>
        p.event === branch.event && p.step === branch.step && p.branch === branch.branch && p.status === "reachable"));
      if (!witness) throw new Error("Choice Point outcome is not selected by a reachable Event branch: " +
        record.metadata.id + "/" + outcome);
      const linked = branches.filter(branch =>
        !(branch.event === witness.event && branch.step === witness.step) &&
        branch.conditions.some(c => c.kind === "outcome" &&
          c.choice_point === record.metadata.id && c.value === outcome) &&
        report.coverage.branchProgress.some(p => p.event === branch.event && p.step === branch.step &&
          p.branch === branch.branch && p.status === "reachable"));
      const prerequisiteConsumers = events.filter(event =>
        event.metadata.id !== witness.event &&
        event.metadata.prerequisites.any_of.some((alt: any) =>
          (alt.conditions as Array<Record<string, any>> ?? []).some(c => c.kind === "outcome" &&
            c.choice_point === record.metadata.id && c.value === outcome)) &&
        report.coverage.eventProgress.some(e => e.id === event.metadata.id && e.status === "reachable"));
      const origin = events.find(e => e.metadata.id === witness.event)!;
      const order = (origin.metadata.steps as Array<{ id: string }>).findIndex(s => s.id === witness.step);
      const conditionalNextSteps = linked.filter(b => b.event === witness.event &&
        (origin.metadata.steps as Array<{ id: string }>).findIndex(s => s.id === b.step) > order);
      // The first justified state change may be in a separate reachable,
      // outcome-gated Event. Never force an invented relationship/knowledge
      // effect into the original selecting branch solely for certification.
      const conditionalConsumers = [
        ...linked.filter(b => b.event !== witness.event),
        ...branches.filter(b => prerequisiteConsumers.some(e => e.metadata.id === b.event) &&
          report.coverage.branchProgress.some(p => p.event === b.event &&
            p.step === b.step && p.branch === b.branch && p.status === "reachable")),
      ];
      const consequences = new Map([witness, ...conditionalNextSteps, ...conditionalConsumers]
        .map(b => [b.event + "#" + b.step + "/" + b.branch, b]));
      const effects = [...consequences.values()].flatMap(b =>
        b.effects.filter(e => e.kind !== "outcome"));
      if (!effects.length) {
        throw new Error("Choice outcome lacks a consequential typed effect at selection or in a later conditional step: " +
          record.metadata.id + "/" + outcome + " at " + witness.event + "#" + witness.step + "/" + witness.branch +
          ". Add only a causally justified effect in the authorized selection or reachable later " +
          "outcome-conditioned Event/step; " +
          "an arbitrary Relationship severity or invented Fact is not a valid payoff.");
      }
      // A later reachable conditional step within the selecting Event is a
      // genuine payoff, just like a conditional consumer in another Event.
      // Earlier steps (or other branches of the selection step) are not.
      const downstream = [...new Set([
        ...linked.filter(b => b.event !== witness.event).map(b => b.event),
        ...conditionalNextSteps.map(b => b.event + "#" + b.step + "/" + b.branch),
        ...prerequisiteConsumers.map(e => e.metadata.id),
      ])];
      if (!downstream.length) {
        const typedRefs = effects.flatMap(effect => ["relationship", "fact", "revelation", "character"]
          .map(key => effect[key]).filter((value): value is string => typeof value === "string"));
        const typedValues = effects.map(effect => String(effect.value));
        const explicit = obligations.some(o =>
          /conditional|future|later/i.test(o) &&
          ((o.includes(record.metadata.id) && (/outcome/i.test(o) || o.includes(outcome))) ||
           (typedRefs.some(ref => o.includes(ref)) && typedValues.some(value => o.includes(value)))));
        if (!explicit) throw new Error("Choice outcome lacks a reachable later consumer or specific conditional writing obligation: " +
          record.metadata.id + "/" + outcome + " selected at " + witness.event + "#" + witness.step + "/" + witness.branch +
          ". Add a justified reachable later step/Event conditioned on this exact outcome, or name the " +
          "Choice/outcome, typed effect and future conditional consumer in laterObligations; do not change an " +
          "immutable original Event prerequisite gate.");
        if (explicit) downstream.push("conditional-writing-obligation");
      }
      return { name: outcome, event: witness.event, step: witness.step,
        branch: witness.branch, consequence: JSON.stringify(effects), downstream };
    });
    if (new Set(evidence.map(o => o.consequence)).size < 2) {
      throw new Error("Choice Point outcomes have indistinguishable typed consequences: " + record.metadata.id);
    }
    // Revealing the same Fact AFTER either choice is legitimate. What must
    // not occur is revealing a branch-exclusive Fact in an earlier SHARED
    // step and then claiming the player's choice controls that reveal.
    for (const event of events) {
      const steps = event.metadata.steps as Array<{ id: string }>;
      const earliest = steps.findIndex(step => branches.some(b => b.event === event.metadata.id &&
        b.step === step.id && b.effects.some(e => e.kind === "outcome" && e.choice_point === record.metadata.id)));
      if (earliest < 0) continue;
      const beforeChoice = branches.filter(b => b.event === event.metadata.id &&
        steps.findIndex(s => s.id === b.step) < earliest);
      const afterChoice = branches.filter(b => b.event === event.metadata.id &&
        steps.findIndex(s => s.id === b.step) >= earliest);
      const conditional = new Set(afterChoice.flatMap(b => b.effects.filter(e => e.kind === "revealed" &&
        e.value === true).map(e => e.revelation)));
      if (beforeChoice.some(b => b.effects.some(e => e.kind === "revealed" && e.value === true &&
          conditional.has(e.revelation)))) {
        throw new Error("Branch-exclusive Revelation leaks into a shared pre-choice step: " + record.metadata.id);
      }
    }
    return { id: record.metadata.id, outcomes: evidence };
  });
}
/** A bounded independent-review repair must preserve the original Choice
 * specialist's executable payoff contract, not merely native YAML validity.
 * This is a read-only check on the repaired Story; it confers no new writer
 * authority and uses the same outcome/conditional-consumer rules as Choice. */
export function verifyRepairedChoicePayoff(
  report: unknown,
  originalPaths: string[],
  originalObligations: string[],
): void {
  const evidence = verifyChoice(
    report as Report, originalPaths,
    { sourcePaths: originalPaths } as InteractiveAssignment, originalObligations,
  );
  if (!evidence.length) throw Error("Repaired Choice has no surviving verified outcome.");
}

function verifyPuzzle(report: Report, paths: string[], assign: InteractiveAssignment): PuzzleEvidence[] {
  const records = report.records.filter(r => r.metadata.status !== "superseded");
  const changedRecordIds = new Set(records.filter(r => paths.includes(r.path))
    .map(r => r.metadata.id));
  const authored = records.filter(r => r.metadata.type === "puzzle" &&
    (paths.includes(r.path) || assign.sourcePaths.includes(r.path) &&
      [...(r.metadata.solutions as string[] ?? []), ...(r.metadata.clues as string[] ?? [])]
        .some(id => changedRecordIds.has(id))));
  if (!authored.length) throw new Error("No authored Puzzle in interactive work item.");
  const byId = new Map(records.map(record => [record.metadata.id, record]));
  return authored.map(record => {
    const solutionIds = record.metadata.solutions as string[];
    const clueIds = record.metadata.clues as string[];
    if (record.metadata.completeness === "partial" || solutionIds.length < 2 || clueIds.length < 2) {
      throw new Error("Puzzle must have two complete solution Events and substantive clue sources: " + record.metadata.id);
    }
    for (const clueId of clueIds) {
      const clue = byId.get(clueId);
      if (clue?.metadata.type !== "authored-content" || !clue.metadata.events?.length ||
          (clue.metadata.events as string[]).every(id => solutionIds.includes(id))) {
        throw new Error("Puzzle clue is not linked to a distinct pre-solution discovery Event: " + clueId);
      }
    }
    const proof = report.coverage.puzzleSolutions.find(p => p.id === record.metadata.id);
    if (!proof || proof.solutions.length !== solutionIds.length ||
        proof.solutions.some(s => s.status !== "reachable" || s.clueAccess.status !== "reachable" ||
          !s.clueAccess.availableClues.length)) {
      throw new Error("Puzzle has an unreachable/unverified solution or a missing pre-solution clue: " +
        record.metadata.id + ": " + JSON.stringify(proof?.solutions));
    }
    for (const clue of clueIds) {
      if (!proof.solutions.some(s => s.clueAccess.availableClues.includes(clue))) {
        throw new Error("Puzzle declares a clue with no proven opportunity before any solution: " + clue);
      }
    }
    const eventRecords = solutionIds.map(id => byId.get(id));
    if (eventRecords.some(e => e?.metadata.type !== "event" || e.metadata.completeness === "partial")) {
      throw new Error("Puzzle solution must be a complete Event, not just a declared ID.");
    }
    // Existing solution Events and playable clues are valid evidence when
    // their canonical state and reachability still pass; a scoped edit need
    // not touch all four records or create duplicate replacements.
    if (new Set(eventRecords.map(e => JSON.stringify({ consequences: e!.metadata.consequences,
      steps: e!.metadata.steps }))).size < 2) {
      throw new Error("Alternative Puzzle solution Events must have distinct narrative consequences.");
    }
    return { id: record.metadata.id, solutions: proof.solutions.map(s => ({
      event: s.event, status: s.status, clueAccess: s.clueAccess.status, clueIds: s.clueAccess.availableClues,
    })) };
  });
}
export async function checkOutput(job: JobStartResult, previous: Report, report: Report, assign: InteractiveAssignment,
  unit: Unit, obligations: string[]) {
  if (!unit.paths || unit.paths.some(path => !report.records.some(r => r.path === path &&
      r.metadata.status !== "superseded"))) {
    throw new Error("Interactive specialist authored files absent from the canonical Story catalog.");
  }
  checkProgress(previous, report, assign.milestoneId, unit.paths);
  const authored = report.records.filter(r => unit.paths!.includes(r.path));
  const allEffects = findEventRecords(report).flatMap(selectEffects).flatMap(b => b.effects);
  for (const revelation of authored.filter(r => r.metadata.type === "revelation")) {
    if (!allEffects.some(e => e.kind === "revealed" && e.revelation === revelation.metadata.id && e.value === true)) {
      throw new Error("Authored Revelation lacks an executable, timed revealed effect: " + revelation.metadata.id);
    }
  }
  for (const position of authored.filter(r => r.metadata.type === "narrative-position")) {
    const state = report.coverage.narrativeState.find(r => r.id === position.metadata.id);
    if (!state || state.status !== "reachable" || state.state.some(s => s.status === "unverified")) {
      throw new Error("Narrative Position contains unverified state or is not reachable: " + position.metadata.id);
    }
  }
  if (authored.some(r => r.metadata.type === "event" &&
      ((r.metadata.arcs as string[]).some(id => !assign.arcIds.includes(id)) ||
      (r.metadata.participants as string[]).some(id => !assign.characterIds.includes(id))))) {
    throw new Error("Interactive Event references unrelated Arcs or Characters.");
  }
  if (unit.domain === "choice") {
    const choices = verifyChoice(report, unit.paths, assign, obligations);
    if (!choices.some(choice => choice.outcomes.some(outcome =>
      assign.eventIds.includes(outcome.event)))) {
      throw new Error("Choice Point has no reachable outcome in the assigned Event cluster.");
    }
    return { choices, puzzles: [] };
  }
  return { choices: [], puzzles: verifyPuzzle(report, unit.paths, assign) };
}
async function publishHead(job: JobStartResult, before: string, after: string, id: string) {
  if (commitOrigin(job, id, after).jobId !== job.jobId) return;
  const file = join(job.stateDir, "revisions", "verified-head.json");
  await mkdir(dirname(file), { recursive: true });
  if (existsSync(file)) {
    const saved = JSON.parse(await readFile(file, "utf8")) as { version: number; jobId: string; headSha: string };
    if (saved.version !== 1 || saved.jobId !== job.jobId ||
        (saved.headSha !== before && saved.headSha !== after)) {
      throw new Error("Last verified Story head changed outside this interactive work item.");
    }
    if (saved.headSha === after) {
      await finalizeRecoveryCheckpoint(job, id, before, after);
      return;
    }
  }
  await persist(file, { version: 1, jobId: job.jobId, headSha: after, workItemId: id });
  await finalizeRecoveryCheckpoint(job, id, before, after);
}
function verifyCommit(job: JobStartResult, receipt: Receipt, unit: Unit, parent: string, sha: string) {
  if (!unit.digest || !unit.paths || git(job, "rev-parse", sha + "^") !== parent) {
    throw new Error("Interactive commit parent or receipt is unverified.");
  }
  const message = git(job, "log", "-1", "--format=%B", sha);
  if (!message.split("\n").includes("NovelTea-Job: " + commitOrigin(job, unit.id, sha).jobId) ||
      !message.includes("NovelTea-Interactive: " + unit.digest) ||
      !message.includes("NovelTea-Work-Item: " + unit.id + "\n") ||
      !message.includes("NovelTea-Plan-Version: " + receipt.planVersion + "\n")) {
    throw new Error("Interactive commit lacks correct work-item provenance.");
  }
  const treePaths = git(job, "diff-tree", "--no-commit-id", "--name-only", "-r", sha)
    .split("\n").filter(Boolean).sort();
  if (JSON.stringify(treePaths) !== JSON.stringify(unit.paths.map(p => repoPath(job, p)).sort())) {
    throw new Error("Interactive commit includes unauthorized files.");
  }
}
/** One immutable provenance digest for the negative result, not for an
 * independent approval or a permission to edit. */
function interactiveConflictReportDigest(receipt: Receipt, negative: Unit,
  sessionPath: string | null, sessionHash: string | null) {
  return digest(JSON.stringify({
    jobId: receipt.jobId, worker: receipt.worker,
    workItemId: receipt.workItemId, milestoneId: receipt.milestoneId,
    baseSha: receipt.baseSha, planVersion: receipt.planVersion,
    planDigest: receipt.planDigest, eventHead: receipt.eventHead,
    provider: receipt.provider, model: receipt.model,
    thinking: receipt.thinking ?? null, eventSource: receipt.eventSource ?? null,
    head: negative.beforeHead, snapshotId: receipt.snapshot?.id,
    unitId: negative.id, paths: negative.claimedPaths, conflicts: negative.conflicts,
    obligations: negative.obligations, skillReads: negative.skillReads,
    piSessionFile: sessionPath, piSessionSha256: sessionHash,
    ...(negative.dependencyFinding ? { dependencyFinding: negative.dependencyFinding, piSessionBytes: negative.piSessionBytes } : {}),
  }));
}
/** Reauthenticate a settled Interactive contradiction at the original unchanged
 * HEAD. The negative report is evidence, never an authority to revise canon. */
export async function inspectInteractiveConflict(job: JobStartResult, milestoneId: string,
  allowHistoricalDescendant = false, writerArchive?: string) {
  if (!validMilestone.test(milestoneId)) throw Error("Invalid Interactive conflict Milestone");
  const relative = "interactive-items/" + milestoneId.slice(10) + ".json";
  if (writerArchive && (await realpath(writerArchive) !== writerArchive || !(await lstat(writerArchive)).isFile()))
    throw Error("Unsafe archived Interactive contradiction.");
  let receipt = JSON.parse(await readFile(writerArchive ?? join(job.stateDir, relative), "utf8")) as Receipt;
  if (receipt.supersededNegative) {
    const ref = receipt.supersededNegative;
    const historical = "interactive-negative-history/" + milestoneId.slice(10) + ".json";
    if (ref.relative !== historical || !/^[0-9a-f]{64}$/.test(ref.digest))
      throw Error("Original Interactive negative history reference is invalid.");
    const prior = JSON.parse(await readFile(join(job.stateDir, historical), "utf8")) as Receipt;
    if (prior.supersededNegative || digest(JSON.stringify(prior)) !== ref.digest ||
        prior.jobId !== receipt.jobId || prior.eventHead !== receipt.eventHead ||
        prior.milestoneId !== receipt.milestoneId || prior.planDigest !== receipt.planDigest)
      throw Error("Archived original Choice contradiction was changed after supersession.");
    receipt = prior;
  }
  const [choice, puzzle] = receipt.units ?? [];
  const negative = choice?.phase === "conflicted" ? choice :
    puzzle?.phase === "conflicted" ? puzzle : undefined;
  const domain = negative?.domain;
  const precedingUnitValid = receipt.units?.length === 2 &&
    choice?.domain === "choice" && puzzle?.domain === "puzzle" &&
    choice.id === "interactive-choice-" + milestoneId.slice(10) &&
    puzzle.id === "interactive-puzzle-" + milestoneId.slice(10) &&
    (negative === choice
      ? puzzle.phase === "pending" && !puzzle.beforeHead && !puzzle.commitSha && !puzzle.paths?.length
      : choice.phase === "committed" && !!choice.beforeHead && !!choice.commitSha);
  const architecture = JSON.parse(await readFile(join(job.stateDir, "architecture.json"), "utf8")) as {
    jobId?: string; phase?: string; plan?: Plan };
  const head = await trustedHead(job);
  if (receipt.jobId !== job.jobId || receipt.milestoneId !== milestoneId ||
      architecture.jobId !== job.jobId || architecture.phase !== "committed" ||
      !architecture.plan || architecture.plan.version !== receipt.planVersion ||
      digest(JSON.stringify(architecture.plan)) !== receipt.planDigest ||
      !precedingUnitValid ||
      !["pi", "fixture"].includes(receipt.worker) || !receipt.snapshot?.id ||
      !negative || negative.phase !== "conflicted" ||
      negative.id !== "interactive-" + domain + "-" + milestoneId.slice(10) ||
      !negative.beforeHead || negative.beforeHead !== head && !allowHistoricalDescendant ||
      !receipt.eventHead || !receipt.planDigest || !receipt.planVersion ||
      negative.paths?.length || negative.claimedPaths?.length || negative.commitSha ||
      !negative.conflicts?.length || !negative.conflicts.every(x => !!x.trim()) ||
      !Array.isArray(negative.obligations) ||
      (receipt.worker === "pi" && (!negative.piSessionFile || !negative.piSessionSha256)) ||
      (receipt.worker === "fixture" && (negative.piSessionFile || negative.piSessionSha256)) ||
      !negative.digest || !writerArchive && dirty(job).length)
    throw Error("Original Interactive no-write source or receipts cannot be authenticated");
  const directory = join(job.stateDir, "interactive-sessions", receipt.workItemId, negative.domain);
  const sessionPath = receipt.worker === "pi" ? await realpath(negative.piSessionFile!) : null;
  if (sessionPath && (!sessionPath.startsWith(directory + "/") ||
      negative.piSessionFile !== sessionPath || !sessionPath.endsWith(".jsonl")))
    throw Error("Original Interactive session is outside its assigned directory");
  const sessionStat = sessionPath ? await lstat(sessionPath) : null;
  if (sessionStat && (!sessionStat.isFile() || sessionStat.size > 64 * 1024 * 1024))
    throw Error("Original Interactive Pi session is not a bounded regular file");
  const fullBytes = sessionPath ? await readFile(sessionPath) : null;
  if (writerArchive && (!fullBytes || !Number.isSafeInteger(negative.piSessionBytes) || negative.piSessionBytes! <= 0 || negative.piSessionBytes! > fullBytes.length))
    throw Error("Archived Interactive prerequisite lacks its bounded transcript prefix");
  const sessionBytes = writerArchive ? fullBytes!.subarray(0, negative.piSessionBytes) : fullBytes;
  const sessionHash = sessionBytes ? digest(sessionBytes) : null;
  if ((negative.piSessionSha256 ?? null) !== sessionHash) throw Error("Original Interactive Pi session changed");
  if (sessionBytes) {
    const records = sessionBytes.toString("utf8").trim().split("\n").map(line =>
      JSON.parse(line) as { type?: string; id?: string;
        message?: { role?: string; stopReason?: string;
          content?: Array<{ type?: string; text?: string }> } });
    if (records[0]?.type !== "session" || !records[0].id)
      throw Error("Original Interactive Pi session lost its identity");
    const messages = records.filter(r => r.type === "message" && r.message?.role === "assistant")
      .map(r => r.message!);
    const last = messages.at(-1);
    if (!last || last.stopReason !== "stop")
      throw Error("Original Interactive Pi report lacks a settled final assistant response");
    const reported = parseInteractiveManifest((last.content ?? [])
      .filter(c => c.type === "text").map(c => c.text ?? "").join("\n"), negative.domain);
    if (!negative.invocation || !negative.invocationProof || !negative.piSessionId ||
        !negative.piSessionFile || negative.invocationProof.sourceDigest !== negative.invocation.sourceDigest ||
        negative.invocation.sourceDigest !== await interactiveSourceDigest(job, receipt, negative,
          negative.invocation.baseline, negative.invocation.assignment))
      throw Error("Original Interactive contradiction lacks its settled invocation proof");
    const response = await verifySettledAssignment({ proof: negative.invocationProof,
      directory: interactiveInvocationDirectory(job, receipt.workItemId, negative.domain, negative.piSessionId, (negative.writerContinuation || negative.retainedChoice) ? negative.invocation.sourceDigest : undefined),
      sessionId: negative.piSessionId, sessionFile: negative.piSessionFile,
      sessionRoots: [directory], effect: null, historical: !!writerArchive });
    if (JSON.stringify(parseInteractiveManifest(JSON.stringify(response), negative.domain)) !== JSON.stringify(reported) ||
        reported.paths.length ||
        JSON.stringify(reported.conflicts) !== JSON.stringify(negative.conflicts) ||
        JSON.stringify(reported.obligations) !== JSON.stringify(negative.obligations) ||
        JSON.stringify(reported.dependencyFinding) !== JSON.stringify(negative.dependencyFinding))
      throw Error("Original Interactive report differs from the settled Pi transcript");
  }
  const event = JSON.parse(await readFile(join(job.stateDir,
    "event-items", milestoneId.slice(10) + ".json"), "utf8")) as SourceReceipt;
  if (event.jobId !== receipt.jobId || event.milestoneId !== milestoneId ||
      event.phase !== "committed" || event.commitSha !== receipt.eventHead ||
      event.planVersion !== receipt.planVersion)
    throw Error("Original Interactive source no longer matches its verified Event receipt");
  git(job, "merge-base", "--is-ancestor", receipt.eventHead, negative.beforeHead);
  if (negative.domain === "puzzle") {
    verifyCommit(job, receipt, choice!, choice!.beforeHead!, choice!.commitSha!);
    git(job, "merge-base", "--is-ancestor", choice!.commitSha!, negative.beforeHead);
    if (writerArchive) {
      const point = await (await import("./recovery-checkpoints.js")).inspectHistoricalRecoveryCheckpoint(job, choice!.commitSha!);
      if (point.workItem !== choice!.id || !["passed", "not-required"].includes(point.semanticReview))
        throw Error("Archived Puzzle prerequisite lost its independently reviewed Choice");
    } else await assertNativeReviewDependencies(job, negative.id);
  }
  if (allowHistoricalDescendant) git(job, "merge-base", "--is-ancestor", negative.beforeHead, head);
  const reportHash = interactiveConflictReportDigest(receipt, negative, sessionPath, sessionHash);
  if (negative.digest !== reportHash) throw Error("Original Interactive negative report digest changed");
  // Historical inspection authenticates the original no-write revision,
  // not the later descendant currently at HEAD. A post-recovery Composition
  // commit must not rewrite the negative Pi report's source identity.
  return { relative, reportDigest: reportHash, expectedHead: negative.beforeHead,
    worker: receipt.worker, planVersion: receipt.planVersion,
    milestoneId, domain: negative.domain, unitId: negative.id,
    precedingChoiceSource: negative.domain === "puzzle" ? choice!.beforeHead : undefined,
    conflicts: negative.conflicts,
    obligations: negative.obligations!, piSessionFile: sessionPath };
}
function interactiveWriterArchive(job: JobStartResult, milestone: string, domain: InteractiveDomain, sealDigest: string) {
  if (!validMilestone.test(milestone) || !["choice", "puzzle"].includes(domain) || !/^[a-f0-9]{64}$/.test(sealDigest))
    throw Error("Invalid Interactive prerequisite archive identity");
  return join(job.stateDir, "interactive-writer-prerequisites", milestone.slice(10) + "-" + domain + "-" + sealDigest + ".json");
}
/** Preserve the settled negative in its original invocation directory.  The
 * retained obligation must already exist in the independently approved
 * Milestone design and the original adaptive assignment; no scope expansion. */
async function retainedChoiceEvidence(job: JobStartResult, milestone: string,
    pin: RetainedChoiceContinuation, original: Receipt) {
  const unit = original.units[0];
  const { readAdaptiveState } = await import("./adaptive-state.js");
  const adaptive = await readAdaptiveState(job, pin.turnDigest, pin.planVersion);
  if (!adaptive || adaptive.version < pin.adaptiveVersion ||
      !adaptive.entries.some(entry => entry.digest === pin.amendmentDigest &&
        entry.afterVersion <= pin.adaptiveVersion && entry.order.includes("interactive:" + milestone)))
    throw Error("Retained Choice lacks its original adaptive assignment.");
  const event = JSON.parse(await readFile(join(job.stateDir, "event-items", milestone.slice(10) + ".json"), "utf8")) as SourceReceipt;
  const blueprint = await historicalMilestoneHandoff(job, event);
  if (!blueprint || blueprint.pin.digest !== pin.blueprintDigest ||
      !blueprint.design.downstream.some(item => item.owner === "interactive") ||
      !unit.assignmentKey || !unit.invocation?.assignment || unit.writerContinuation || unit.retainedChoice ||
      original.planVersion !== pin.planVersion || unit.beforeHead !== pin.originalHead ||
      unit.digest !== pin.reportDigest || unit.piSessionSha256 !== pin.sessionSha256 ||
      original.worker !== "pi" || !unit.piSessionFile || !unit.piSessionId)
    throw Error("Retained Choice is not an in-scope original approved Interactive obligation.");
  const { readReviewTurnEvidence } = await import("./fork-review-turn.js");
  const turn = await readReviewTurnEvidence(job);
  if (!turn || turn.digest !== pin.turnDigest || !turn.objective ||
      pin.decline === "protected-author" && !turn.objective.requestedTargets.some(id =>
        id === milestone || id.startsWith("choice-point.") || id.startsWith("puzzle.")))
    throw Error("Retained Choice lost its original author requirements.");
  if (pin.decline === "independent-review") {
    const review = await (await import("./interactive-event-only.js")).inspectDeclinedEventOnlyReview(job, milestone, {
      eventHead: original.eventHead, reviewHead: pin.originalHead, planDigest: original.planDigest,
      planVersion: pin.planVersion, turnDigest: pin.turnDigest, eventSnapshotId: event.snapshot!.id,
    });
    if (!review || review.digest !== pin.reviewDigest)
      throw Error("Retained Choice independent omission Review changed.");
  } else if (pin.reviewDigest) throw Error("A deterministic retained obligation cannot claim an independent verdict.");
  if (pin.decline === "native-required" &&
      (!event.validation || eventOnlySourceCandidate(unit.invocation.baseline, milestone, event.validation.eventIds)))
    throw Error("Retained Choice native eligibility decline is not authenticated by its original source.");
  return unit;
}

export async function inspectRetainedChoiceContinuation(job: JobStartResult, milestone: string) {
  const saved = await inspectInteractiveUnit(job, milestone, "choice");
  const pin = saved?.unit.retainedChoice;
  if (!pin) return null;
  const archive = interactiveWriterArchive(job, milestone, "choice", pin.reportDigest);
  const negative = await inspectInteractiveConflict(job, milestone, true, archive);
  const original = JSON.parse(await readFile(archive, "utf8")) as Receipt;
  const unit = await retainedChoiceEvidence(job, milestone, pin, original);
  if (saved.unit.writerContinuation) {
    const { authenticateWriterContinuation, inspectWriterDependency, assertWriterAssignmentRoot, verifiedWriterSupport } = await import("./writer-dependency.js");
    const continuation = saved.unit.writerContinuation;
    const source = await authenticateWriterContinuation(job, continuation, "choice", milestone, unit.assignmentKey);
    const prerequisite = await inspectWriterDependency(job, source);
    await assertWriterAssignmentRoot(job, prerequisite, pin.originalHead);
    await verifiedWriterSupport(job, source, continuation.reportDigest, continuation.supportRef, saved.unit.beforeHead);
  } else if (saved.unit.beforeHead !== pin.originalHead) throw Error("Retained Choice source changed without verified support.");
  if (negative.domain !== "choice" || negative.reportDigest !== pin.reportDigest ||
      saved.unit.assignmentKey !== unit.assignmentKey || saved.unit.piSessionId !== unit.piSessionId ||
      saved.unit.piSessionFile !== unit.piSessionFile ||
      saved.receipt.planDigest !== original.planDigest || saved.receipt.eventHead !== original.eventHead ||
      !/^[a-f0-9]{64}$/.test(pin.caseId))
    throw Error("Retained Choice continuation lost its exact original assignment/session.");
  return { pin, original, saved, assignmentKey: unit.assignmentKey! };
}

export async function prepareRetainedChoiceContinuation(job: JobStartResult, milestone: string, input: {
  caseId: string; reportDigest: string; turnDigest: string; adaptiveVersion: number;
  decline: RetainedChoiceContinuation["decline"];
}) {
  const previous = await inspectRetainedChoiceContinuation(job, milestone);
  if (previous) {
    if (previous.pin.caseId !== input.caseId || previous.pin.reportDigest !== input.reportDigest ||
        previous.pin.decline !== input.decline || previous.pin.turnDigest !== input.turnDigest ||
        previous.pin.adaptiveVersion !== input.adaptiveVersion)
      throw Error("Original retained Choice correction changed.");
    return previous.pin;
  }
  const negative = await inspectInteractiveConflict(job, milestone);
  const saved = await inspectInteractiveUnit(job, milestone, "choice");
  if (!saved || negative.domain !== "choice" || negative.reportDigest !== input.reportDigest ||
      !saved.unit.piSessionSha256 || !saved.unit.piSessionFile || !saved.unit.assignmentKey)
    throw Error("Retained Choice has no settled original writer.");
  const original = saved.receipt;
  const adaptive = await (await import("./adaptive-state.js")).readAdaptiveState(job, input.turnDigest, original.planVersion);
  if (adaptive) (await import("./adaptive-state.js")).assertAdaptiveSettled(adaptive);
  const amendment = adaptive?.entries.filter(entry => entry.afterVersion <= input.adaptiveVersion &&
    entry.order.includes("interactive:" + milestone)).at(-1);
  if (!adaptive || adaptive.version !== input.adaptiveVersion || !amendment)
    throw Error("Retained Choice original adaptive version is unavailable.");
  const event = JSON.parse(await readFile(join(job.stateDir, "event-items", milestone.slice(10) + ".json"), "utf8")) as SourceReceipt;
  const blueprint = await historicalMilestoneHandoff(job, event);
  if (!blueprint) throw Error("Retained Choice has no approved local design.");
  const review = input.decline === "independent-review" ?
    await (await import("./interactive-event-only.js")).inspectDeclinedEventOnlyReview(job, milestone, {
      eventHead: original.eventHead, reviewHead: negative.expectedHead, planDigest: original.planDigest,
      planVersion: original.planVersion, turnDigest: input.turnDigest, eventSnapshotId: event.snapshot!.id,
    }) : null;
  const pin: RetainedChoiceContinuation = { ...input, originalHead: negative.expectedHead,
    sessionSha256: saved.unit.piSessionSha256, planVersion: original.planVersion,
    amendmentDigest: amendment.digest, blueprintDigest: blueprint.pin.digest,
    ...(review ? { reviewDigest: review.digest } : {}) };
  await retainedChoiceEvidence(job, milestone, pin, original);
  // Legacy negative reports did not record the prefix length; it can be
  // recovered only before appending to the authenticated original transcript.
  const historic = structuredClone(original);
  historic.units[0].piSessionBytes = (await readFile(saved.unit.piSessionFile)).length;
  const archive = interactiveWriterArchive(job, milestone, "choice", pin.reportDigest);
  if (existsSync(archive)) {
    if (JSON.stringify(JSON.parse(await readFile(archive, "utf8"))) !== JSON.stringify(historic))
      throw Error("Retained Choice original negative history changed.");
  } else await persist(archive, historic);
  const { invocation, invocationProof, conflicts, obligations, paths, claimedPaths, digest: _digest, failure,
    piSessionSha256, piSessionBytes, dependencyFinding, ...rest } = saved.unit;
  original.units[0] = { ...rest, phase: "pending", retainedChoice: pin };
  await persist(join(job.stateDir, "interactive-items", milestone.slice(10) + ".json"), original);
  return pin;
}

export async function inspectRetainedChoiceCompletion(job: JobStartResult, milestone: string,
    expected: { caseId: string; reportDigest: string; turnDigest: string; sourceHead: string; planVersion: number | null }) {
  const retained = await inspectRetainedChoiceContinuation(job, milestone);
  if (!retained || retained.pin.caseId !== expected.caseId || retained.pin.reportDigest !== expected.reportDigest ||
      retained.pin.turnDigest !== expected.turnDigest || retained.pin.planVersion !== expected.planVersion ||
      retained.pin.originalHead !== expected.sourceHead || retained.saved.unit.phase !== "committed" ||
      !retained.saved.unit.commitSha || !retained.saved.unit.invocationProof)
    return null;
  const { receipt, unit } = retained.saved;
  if (!unit.invocation || !unit.paths || !unit.digest || !unit.piSessionId || !unit.piSessionFile ||
      unit.invocation.sourceDigest !== await interactiveSourceDigest(job, receipt, unit, unit.invocation.baseline, unit.invocation.assignment))
    throw Error("Retained Choice correction invocation lost its original source.");
  const parent = unit.beforeHead!;
  verifyCommit(job, receipt, unit, parent, unit.commitSha!);
  await verifySettledAssignment({ proof: unit.invocationProof!, sessionId: unit.piSessionId, sessionFile: unit.piSessionFile,
    directory: interactiveInvocationDirectory(job, receipt.workItemId, "choice", unit.piSessionId, unit.invocation.sourceDigest),
    sessionRoots: [join(job.stateDir, "interactive-sessions", receipt.workItemId, "choice")],
    effect: assignmentCommittedEffect(job, parent, unit.commitSha!, unit.paths, unit.digest), historical: true });
  const point = await (await import("./recovery-checkpoints.js")).inspectHistoricalRecoveryCheckpoint(job, retained.saved.unit.commitSha);
  if (point.workItem !== retained.saved.unit.id || git(job, "rev-parse", retained.saved.unit.commitSha + "^") !== parent ||
      point.assurance?.turnDigest !== expected.turnDigest || retained.saved.receipt.planVersion !== expected.planVersion ||
      retained.saved.unit.validation?.status !== "passed" || point.semanticReview !== "passed")
    return null;
  return { head: retained.saved.unit.commitSha, ref: "interactive-items/" + milestone.slice(10) + ".json",
    digest: digest(JSON.stringify({ pin: retained.pin, original: retained.original.units[0].digest,
      commit: retained.saved.unit.commitSha, assurance: point.assurance, proof: point.proofDigest })) };
}

export async function inspectInteractiveWriterDependency(job: JobStartResult, milestone: string,
    domain: InteractiveDomain, sealDigest: string) {
  const archive = interactiveWriterArchive(job, milestone, domain, sealDigest);
  const historical = existsSync(archive);
  const proof = await inspectInteractiveConflict(job, milestone, historical, historical ? archive : undefined);
  const file = historical ? archive : join(job.stateDir, proof.relative);
  const receipt = JSON.parse(await readFile(file, "utf8")) as Receipt;
  const unit = receipt.units[domain === "choice" ? 0 : 1];
  if (receipt.baseSha !== job.baseSha || proof.domain !== domain || proof.reportDigest !== sealDigest ||
      receipt.worker !== "pi" || !unit.assignmentKey || !unit.dependencyFinding || !unit.invocation?.assignment.dependencyObligations)
    throw Error("Interactive prerequisite lost its exact original typed writer report");
  return { stage: domain, milestoneId: milestone, workItemId: unit.id, planVersion: receipt.planVersion, sealDigest,
    assignmentKey: unit.assignmentKey, head: proof.expectedHead, sourcePaths: unit.invocation.assignment.sourcePaths,
    obligations: unit.invocation.assignment.dependencyObligations, finding: unit.dependencyFinding,
    predecessor: (await import("./writer-dependency.js")).writerPredecessor(unit.writerContinuation) };
}
export async function archiveInteractiveWriterDependency(job: JobStartResult, milestone: string, domain: InteractiveDomain, sealDigest: string) {
  const original = await inspectInteractiveWriterDependency(job, milestone, domain, sealDigest);
  const archive = interactiveWriterArchive(job, milestone, domain, sealDigest);
  if (!existsSync(archive)) await persist(archive, (await inspectInteractiveUnit(job, milestone, domain))!.receipt);
  return original;
}
export async function rebindInteractiveAfterWriterDependency(job: JobStartResult,
    source: import("./writer-dependency.js").WriterDependencySource, reportDigest: string, supportRef: string) {
  if ((source.stage !== "choice" && source.stage !== "puzzle") || !source.milestoneId) throw Error("Invalid Interactive prerequisite stage");
  const { verifiedWriterSupport, assertWriterReentry, writerContinuationBinding } = await import("./writer-dependency.js");
  const entry = await verifiedWriterSupport(job, source, reportDigest, supportRef);
  const archive = interactiveWriterArchive(job, source.milestoneId, source.stage, source.sealDigest);
  const archived = JSON.parse(await readFile(archive, "utf8")) as Receipt;
  const saved = await inspectInteractiveUnit(job, source.milestoneId, source.stage);
  if (!saved) throw Error("Missing suspended Interactive writer");
  const index = source.stage === "choice" ? 0 : 1;
  const original = archived.units[index];
  const binding = writerContinuationBinding(reportDigest, supportRef, entry.report.sourceSha, original.piSessionSha256!);
  if (saved.unit.writerContinuation?.reportDigest === reportDigest) {
    assertWriterReentry({ ...saved.unit, sessionId: saved.unit.piSessionId, sessionFile: saved.unit.piSessionFile },
      { assignmentKey: original.assignmentKey, sessionId: original.piSessionId, sessionFile: original.piSessionFile }, binding);
    return;
  }
  if (dirty(job).length || JSON.stringify(saved.receipt) !== JSON.stringify(archived))
    throw Error("Interactive prerequisite changed before reentry");
  const { invocation, invocationProof, conflicts, obligations, paths, claimedPaths, digest: _digest, failure,
    piSessionSha256, piSessionBytes, dependencyFinding, ...rest } = saved.unit;
  saved.receipt.units[index] = { ...rest, phase: "pending", beforeHead: await trustedHead(job), writerContinuation: binding };
  await persist(join(job.stateDir, "interactive-items", source.milestoneId.slice(10) + ".json"), saved.receipt);
}
function completed(receipt: Receipt) {
  return (receipt.units[0].phase === "committed" &&
    ["committed", "not-applicable"].includes(receipt.units[1].phase)) ||
    (receipt.units[0].phase === "not-applicable" &&
      receipt.units[1].phase === "not-applicable" &&
      !!receipt.units[0].eventOnly &&
      JSON.stringify(receipt.units[0].eventOnly) === JSON.stringify(receipt.units[1].eventOnly));
}
function output(job: JobStartResult, receipt: Receipt, unit?: InteractiveDomain) {
  const choiceDone = receipt.units[0].phase === "committed" ||
    receipt.units[0].phase === "not-applicable" && completed(receipt);
  const conflict = receipt.units.find(u => u.phase === "conflicted");
  return { status: conflict ? "interactive-conflict-reported" :
    unit === "choice" ? choiceDone ? "interactive-choice-committed" : "in-progress"
    : completed(receipt) ? "interactive-slice-committed" : "in-progress",
    ...(conflict ? { prerequisite: { milestoneId: receipt.milestoneId,
      expectedHead: conflict.beforeHead!, reportDigest: conflict.digest!,
      domain: conflict.domain }, conflicts: conflict.conflicts ?? [],
      obligations: conflict.obligations ?? [] } : {}),
    jobId: job.jobId, milestoneId: receipt.milestoneId,
    worktreeStoryRoot: job.worktreeStoryRoot, headSha: conflict?.beforeHead ?? receipt.units[1].commitSha ??
      (receipt.units[1].phase === "not-applicable" ? receipt.units[1].beforeHead :
        receipt.units[0].commitSha) ?? receipt.eventHead,
    eventHead: receipt.eventHead, eventSource: receipt.eventSource,
    milestoneState: receipt.eventSource?.milestoneState === "partial-choice-pending"
      ? receipt.units[0].phase === "committed"
        ? "choice-bound-milestone-awaiting-authorized-closeout"
        : "choice-binding-pending-milestone-partial"
      : "event-route-fulfilled",
    workItemId: receipt.workItemId, planVersion: receipt.planVersion,
    thinking: receipt.thinking ?? "configured-default",
    specialistUnits: receipt.units.map(({ invocation: _invocation, ...u }) => ({ ...u, specialist: u.domain === "choice"
      ? "nt-interactive-narrative" : "nt-puzzle-design" })),
    completionEvidence: { deterministicChoiceAndPuzzlePaths: receipt.units.every(u => u.phase === "committed"),
      deterministicChoicePathAndOptionalPuzzle: receipt.units[0].phase === "committed" && completed(receipt),
      eventOnlyDisposition: receipt.units[0].eventOnly ? "sealed-no-write" : "not-selected",
      eventOnlyReview: receipt.units[0].eventOnly
        ? receipt.worker === "fixture" ? "fixture-structural-only" : "independent-pi"
        : "not-applicable",
      puzzleDisposition: receipt.units[1].phase === "not-applicable" ? "not-applicable" :
        receipt.units[1].phase === "committed" ? "committed" : "pending",
      playerPerceptionAndFairness: "unverified", conditionalWriting: "must-review",
      engineImplementation: "not-started", fullStory: false }, skillSnapshot: receipt.snapshot?.id };
}

/** Read-only receipt projection used to identify the original child before
 * invoking it. The domain adapter still authenticates all native/Git effects. */
export async function inspectInteractiveUnit(job: JobStartResult, milestone: string, domain: InteractiveDomain) {
  if (!validMilestone.test(milestone)) throw Error("Invalid Interactive milestone");
  const path = join(job.stateDir, "interactive-items", milestone.slice(10) + ".json");
  if (!existsSync(path)) return null;
  const receipt = JSON.parse(await readFile(path, "utf8")) as Receipt;
  const unit = receipt.units?.[domain === "choice" ? 0 : 1];
  if (receipt.jobId !== job.jobId || receipt.baseSha !== job.baseSha ||
      receipt.milestoneId !== milestone || receipt.workItemId !== "interactive-" + milestone.slice(10) ||
      unit?.domain !== domain || unit.id !== "interactive-" + domain + "-" + milestone.slice(10))
    throw Error("Interactive child receipt identity changed");
  return { receipt, unit };
}

/** Routing proof for the exact unfinished child; never an authorization to
 * run a new Pi session or treat its draft as a verified source. */
export async function inspectPendingInteractiveInvocation(job: JobStartResult, milestone: string,
    domain: InteractiveDomain, sourceHead?: string) {
  const original = await inspectInteractiveUnit(job, milestone, domain);
  if (!original) return null;
  const { receipt, unit } = original;
  if (receipt.worker !== "pi" || unit.phase !== "writing" && unit.phase !== "authored" ||
      !unit.invocation || !unit.beforeHead ||
      sourceHead && sourceHead !== unit.beforeHead && sourceHead !== receipt.units[0].beforeHead)
    return null;
  const { baseline, assignment, sourceDigest } = unit.invocation;
  if (await interactiveSourceDigest(job, receipt, unit, baseline, assignment) !== sourceDigest ||
      await openSkillSnapshot(receipt.snapshot!.id) !== receipt.snapshot!.path)
    throw Error("Original Interactive invocation source changed");
  if (git(job, "rev-parse", "HEAD") === unit.beforeHead) {
    await interactiveEffect(job, unit.beforeHead);
  } else {
    if (unit.phase !== "authored" || dirty(job).length) throw Error("Unrecognized Interactive writer effect");
    verifyCommit(job, receipt, unit, unit.beforeHead, git(job, "rev-parse", "HEAD"));
    if (!unit.paths || await fileDigest(job, unit.paths) !== unit.digest || !unit.invocationProof ||
        !unit.piSessionId || !unit.piSessionFile || unit.invocationProof.sourceDigest !== sourceDigest)
      throw Error("Interrupted Interactive commit lacks its original settled effect");
    await verifySettledAssignment({ proof: unit.invocationProof,
      directory: interactiveInvocationDirectory(job, receipt.workItemId, domain, unit.piSessionId, (unit.writerContinuation || unit.retainedChoice) ? unit.invocation?.sourceDigest : undefined),
      sessionId: unit.piSessionId, sessionFile: unit.piSessionFile,
      sessionRoots: [join(job.stateDir, "interactive-sessions", receipt.workItemId, domain)], effect: unit.digest! });
  }
  if (!unit.piSessionFile || !unit.piSessionId) {
    if (dirty(job).length || unit.phase !== "writing") throw Error("Interactive draft lacks original session");
  } else {
    const directory = join(job.stateDir, "interactive-sessions", receipt.workItemId, domain);
    if (!unit.piSessionFile.startsWith(directory + "/") ||
        await realpath(unit.piSessionFile) !== unit.piSessionFile ||
        !(await lstat(unit.piSessionFile)).isFile())
      throw Error("Original Interactive Pi transcript is unsafe");
    const first = JSON.parse((await readFile(unit.piSessionFile, "utf8")).split("\n")[0]!);
    if (first.type !== "session" || first.id !== unit.piSessionId)
      throw Error("Original Interactive session identity changed");
  }
  return original;
}

export async function inspectInteractiveFailure(job: JobStartResult, milestone: string,
    domain: InteractiveDomain, sourceHead: string, diagnostic?: AssignmentDiagnosticAuthorization, historicalHead?: string) {
  const original = await inspectInteractiveUnit(job, milestone, domain);
  if (!original) return null;
  const { receipt, unit } = original;
  if (receipt.worker !== "pi" || unit.beforeHead !== sourceHead || !unit.assignmentKey ||
      !unit.invocation || !unit.piSessionId || !unit.piSessionFile ||
      (!diagnostic ? unit.phase !== "writing" : !["writing", "authored", "committed"].includes(unit.phase))) return null;
  const { baseline, assignment, sourceDigest } = unit.invocation;
  if (await interactiveSourceDigest(job, receipt, unit, baseline, assignment) !== sourceDigest ||
      await openSkillSnapshot(receipt.snapshot!.id) !== receipt.snapshot!.path)
    throw Error("Original Interactive diagnostic source changed");
  const directory = interactiveInvocationDirectory(job, receipt.workItemId, domain, unit.piSessionId, (unit.writerContinuation || unit.retainedChoice) ? unit.invocation?.sourceDigest : undefined);
  const options = { directory, sourceDigest, sessionId: unit.piSessionId, sessionFile: unit.piSessionFile,
    sessionRoots: [join(job.stateDir, "interactive-sessions", receipt.workItemId, domain)] };
  const head = historicalHead ?? git(job, "rev-parse", "HEAD");
  let effect: string | null;
  if (head === sourceHead && !historicalHead) {
    if (!await inspectPendingInteractiveInvocation(job, milestone, domain, sourceHead)) return null;
    effect = await interactiveEffect(job, sourceHead);
  } else {
    if (!diagnostic || !unit.paths || !unit.digest || !unit.invocationProof ||
        !["authored", "committed"].includes(unit.phase) ||
        historicalHead && (unit.phase !== "committed" || unit.commitSha !== head) ||
        !historicalHead && dirty(job).length) return null;
    verifyCommit(job, receipt, unit, sourceHead, head);
    effect = assignmentCommittedEffect(job, sourceHead, head, unit.paths, unit.digest);
    await verifySettledAssignment({ ...options, proof: unit.invocationProof, effect, historical: !!historicalHead });
  }
  const terminal = await inspectAssignmentFailure({ ...options, effect, diagnostic });
  return terminal && { ...terminal, ref: "interactive-invocations/" + receipt.workItemId + "/" +
    domain + "/" + unit.piSessionId + "/terminal.json", workItem: unit.id,
    assignmentKey: unit.assignmentKey, invocationProof: unit.invocationProof, sessionId: unit.piSessionId };
}

export async function runInteractiveWorkItem(input: InteractiveOptions) {
  if (input.fixture && input.action !== "inspect") throw Error("Structural fixture execution is retired; use an authenticated Generation assignment.");
  if (!validMilestone.test(input.milestone)) throw new Error("--milestone requires an exact typed Milestone ID.");
  if (input.action === "run" && !input.round) throw Error("Interactive execution requires its checkpointed assignment child.");
  const job = await startStoryJob({ story: input.story, job: input.job }, false);
  const root = job.stateDir;
  const file = join(root, "interactive-items", input.milestone.slice(10) + ".json");
  if (input.action === "inspect" && !existsSync(file)) throw new Error("No interactive work item receipt.");
  // Adaptive admission may request a no-write review from the already locked
  // generation boundary. The probe must never dispatch a specialist writer.
  const execute = async () => {
    if (input.action === "review-omission" && input.unit)
      throw Error("Adaptive omission review applies to a whole interactive assignment.");
    // A started original draft owns reconciliation before author-update intake.
    const inFlight = existsSync(file) && (JSON.parse(await readFile(file, "utf8")) as Receipt)
      .units?.some(u => u.phase === "writing" || u.phase === "authored");
    if (input.action === "run" && !inFlight) await processAuthorUpdatesAtBoundary(job);
    if (!existsSync(join(root, "architecture.json")) || !existsSync(join(root, "character-world.json")) ||
        !existsSync(join(root, "event-items", input.milestone.slice(10) + ".json"))) {
      throw new Error("Interactive design requires verified architecture, foundations and Event design for the Milestone.");
    }
    const architecture = JSON.parse(await readFile(join(root, "architecture.json"), "utf8")) as ArchitectureReceipt;
    const event = JSON.parse(await readFile(join(root, "event-items", input.milestone.slice(10) + ".json"), "utf8")) as SourceReceipt;
    if (architecture.jobId !== job.jobId || architecture.phase !== "committed" || !architecture.plan ||
        architecture.plan.contract.scope.depth === "architecture" ||
        event.jobId !== job.jobId || event.phase !== "committed" || event.milestoneId !== input.milestone ||
        !event.commitSha) {
      throw new Error("Interactive work item requires the same authorized, fully committed Event-design Milestone.");
    }
    assertPlanContinuity(job, architecture, "event:" + input.milestone, event.planVersion);
    if (!event.snapshot?.id || !event.validation || event.validation.status !== "passed" ||
        !event.validation.eventIds?.length || !event.paths?.length || !event.contentDigest ||
        !git(job, "log", "-1", "--format=%B", event.commitSha)
          .includes("NovelTea-Work-Item: " + event.workItemId + "\n") ||
        !git(job, "log", "-1", "--format=%B", event.commitSha)
          .includes("NovelTea-Event-Design: " + event.contentDigest) ||
        JSON.stringify(git(job, "diff-tree", "--no-commit-id", "--name-only", "-r", event.commitSha)
          .split("\n").filter(Boolean).sort()) !==
          JSON.stringify(event.paths.map(p => repoPath(job, p)).sort())) {
      throw new Error("Source Event-design commit lacks original, sealed Event work evidence.");
    }
    if (event.validation.milestoneState &&
        !git(job, "log", "-1", "--format=%B", event.commitSha).includes(
          "NovelTea-Event-Completion: " + eventCompletionDigest({
            milestoneId: event.milestoneId, expectedHead: git(job, "rev-parse", event.commitSha + "^"),
            snapshotId: event.snapshot.id, contentDigest: event.contentDigest,
            eventIds: event.validation.eventIds,
            milestoneState: event.validation.milestoneState, obligations: event.obligations ?? [],
          }))) {
      throw new Error("Event source and deferred obligations changed after their original sealed commit.");
    }
    let milestoneBlueprint: ReviewedMilestoneHandoff | undefined;
    const eventSource: NonNullable<InteractiveAssignment["eventSource"]> = {
      headSha: event.commitSha, snapshotId: event.snapshot.id,
      eventIds: event.validation.eventIds,
      milestoneState: event.validation.milestoneState ?? "complete",
      missingObligations: event.validation.milestoneState === "partial-choice-pending"
        ? event.obligations ?? [] : [],
    };
    try { git(job, "merge-base", "--is-ancestor", event.commitSha, "HEAD"); }
    catch { throw new Error("Story branch has diverged from the committed Event-design stage."); }
    const planDigest = digest(JSON.stringify(architecture.plan));
    let receipt: Receipt;
    if (existsSync(file)) {
      receipt = JSON.parse(await readFile(file, "utf8")) as Receipt;
      if (receipt.version !== 1 || receipt.jobId !== job.jobId || receipt.baseSha !== job.baseSha ||
          receipt.milestoneId !== input.milestone || receipt.eventHead !== event.commitSha ||
          receipt.eventSource && JSON.stringify(receipt.eventSource) !== JSON.stringify(eventSource) ||
          receipt.units?.length !== 2 || receipt.units[0]?.domain !== "choice" ||
          receipt.units[1]?.domain !== "puzzle") {
        throw new Error("Interactive receipt differs from the verified Story plan and Event foundation.");
      }
      assertPlanContinuity(job, architecture, "interactive:" + input.milestone,
        receipt.planVersion, receipt.planDigest);
      if (input.action === "review-omission" && receipt.units[0]?.phase === "conflicted") {
        // C06: never overwrite the negative model report as if it had passed.
        // Authenticate its original Pi session, ask a separate independent
        // reviewer, and retain the original receipt in immutable history.
        const negative = await inspectInteractiveConflict(job, input.milestone);
        if (negative.worker !== "pi" || negative.reportDigest !== receipt.units[0].digest ||
            negative.expectedHead !== await trustedHead(job) ||
            receipt.units[1]?.phase !== "pending")
          throw Error("Postconflict omission lacks settled original Choice evidence.");
        await verifiedNarrativeSuccessor(job, event.commitSha);
        const head = await trustedHead(job);
        const baseline = reportOf(await validateStoryJob(job, input.validatorSource ??
          input.skillsSource, { ...job, baseSha: head }), head);
        const omission = await decideEventOnlyOmission(job, architecture.plan, baseline,
          input.milestone, event.commitSha, event.validation.eventIds, event.snapshot.id,
          event.obligations ?? [], { fixture: false, skillsSource: input.skillsSource,
            provider: input.provider ?? "openai", model: input.model ?? "gpt-6-luna",
            blueprint: await historicalMilestoneHandoff(job, event) });
        if (!omission) {
          const decline = await (await import("./interactive-event-only.js")).inspectDeclinedEventOnlyReview(job, input.milestone, {
            eventHead: event.commitSha, reviewHead: head, planDigest: receipt.planDigest,
            planVersion: receipt.planVersion, turnDigest: input.turnPlanDigest!, eventSnapshotId: event.snapshot.id,
          });
          return { status: "omission-not-justified", headSha: head, milestoneId: input.milestone,
            omissionDecline: decline ? "independent-review" as const : "native-required" as const };
        }
        await correctPendingBlueprint(job, architecture.plan, event, {
          head, fixture: false, omission, protectionBase: baseline.protection.base,
          objective: input.generationObjective, turnDigest: input.turnPlanDigest,
          native: baseline,
        });
        milestoneBlueprint = await reviewedMilestoneHandoff(job, event);
        assertMilestoneInteractiveDisposition(milestoneBlueprint, true);
        const original = structuredClone(receipt);
        const historical = "interactive-negative-history/" + input.milestone.slice(10) + ".json";
        const historyPath = join(root, historical);
        await mkdir(dirname(historyPath), { recursive: true });
        if (existsSync(historyPath)) {
          const stored = JSON.parse(await readFile(historyPath, "utf8")) as Receipt;
          if (digest(JSON.stringify(stored)) !== digest(JSON.stringify(original)))
            throw Error("Original Choice history changed across interrupted supersession.");
        } else await writeFile(historyPath, JSON.stringify(original, null, 2) + "\n",
          { flag: "wx", mode: 0o600 });
        const unit = (domain: InteractiveDomain): Unit => ({
          id: "interactive-" + domain + "-" + input.milestone.slice(10), domain,
          phase: "not-applicable", beforeHead: head, paths: [], claimedPaths: [], eventOnly: omission,
        });
        receipt = { ...receipt, correctedBlueprintPin: consumedCorrection(milestoneBlueprint),
          supersededNegative: { relative: historical, digest: digest(JSON.stringify(original)) },
          units: [unit("choice"), unit("puzzle")] };
        await persist(file, receipt);
        return output(job, receipt, input.unit);
      }
      if (input.action === "review-omission" &&
          !(receipt.units[0]?.phase === "not-applicable" &&
            receipt.units[1]?.phase === "not-applicable" && receipt.units[0]?.eventOnly))
        throw Error("An interactive specialist receipt already exists; reconcile it, never replace it with an omission.");
    } else {
      if (input.action !== "run" && input.action !== "review-omission")
        throw new Error("No saved interactive work item.");
      if (input.unit === "puzzle") throw new Error("A Puzzle assignment cannot start before its original Choice receipt.");
      if (dirty(job).length) throw new Error("Interactive design requires a clean verified Story worktree.");
      await verifiedNarrativeSuccessor(job, event.commitSha);
      if (originalEventFileDigest(job, event.commitSha, event.paths) !== event.contentDigest)
        throw new Error("The sealed original Event source does not match its authored commit.");
      // An observational Milestone may already be fulfilled by its reviewed
      // Event. The controller, not a forced Choice author, asks an independent
      // reviewer whether both interactive assignments are genuinely optional.
      // Fixtures exercise provenance only and never claim literary certification.
      {
        await assertNativeReviewDependencies(job, "interactive-choice-" + input.milestone.slice(10));
        const head = await trustedHead(job);
        const baseline = reportOf(await validateStoryJob(job, input.validatorSource ??
          input.skillsSource, { ...job, baseSha: head }), head);
        const direction = baseline.records.find(r => r.metadata.type === "creative-direction" && r.metadata.status === "approved");
        const planning = direction?.metadata.planning ? parseStoryPlanning(direction.metadata.planning) : null;
        const admitted = input.interactionInventory?.find(i => i.milestone === input.milestone &&
          ["interactive", "choice"].includes(i.stage));
        const preserves = !planning || !admitted || preservesWholeStoryInteraction(
          input.interactionInventory!.filter(i => i.milestone !== input.milestone || i.id === admitted.id), admitted, planning);
        const omission = preserves ? await decideEventOnlyOmission(job, architecture.plan, baseline,
          input.milestone, event.commitSha, event.validation.eventIds, event.snapshot.id,
          event.obligations ?? [], {
            fixture: !!input.fixture, skillsSource: input.skillsSource,
            provider: input.provider ?? "openai", model: input.model ?? "gpt-6-luna",
            blueprint: await historicalMilestoneHandoff(job, event),
          }) : null;
        await correctPendingBlueprint(job, architecture.plan, event, {
          head, fixture: !!input.fixture, omission, protectionBase: baseline.protection.base,
          objective: input.generationObjective, turnDigest: input.turnPlanDigest,
          native: baseline,
        });
        milestoneBlueprint = await reviewedMilestoneHandoff(job, event);
        if (omission) {
          assertMilestoneInteractiveDisposition(milestoneBlueprint, true);
          const unit = (domain: InteractiveDomain): Unit => ({
            id: "interactive-" + domain + "-" + input.milestone.slice(10), domain,
            phase: "not-applicable", beforeHead: head, paths: [],
            claimedPaths: [], eventOnly: omission,
          });
          receipt = { version: 1, jobId: job.jobId, baseSha: job.baseSha,
            workItemId: "interactive-" + input.milestone.slice(10),
            milestoneId: input.milestone, planVersion: architecture.plan.version, planDigest,
            eventHead: event.commitSha, eventSource, worker: "pi",
            correctedBlueprintPin: consumedCorrection(milestoneBlueprint),
            provider: input.provider ?? "openai", model: input.model ?? "gpt-6-luna",
            thinking: input.thinking, units: [unit("choice"), unit("puzzle")] };
          await persist(file, receipt);
          return output(job, receipt, input.unit);
        }
      }
      // The independently reviewed Event does not warrant skipping gameplay.
      // Leave the interactive assignment available to its original writers.
      if (input.action === "review-omission")
        return { status: "omission-not-justified", headSha: await trustedHead(job),
          milestoneId: input.milestone };
      milestoneBlueprint ??= await reviewedMilestoneHandoff(job, event);
      receipt = { version: 1, jobId: job.jobId, baseSha: job.baseSha,
        correctedBlueprintPin: consumedCorrection(milestoneBlueprint),
        workItemId: "interactive-" + input.milestone.slice(10),
        milestoneId: input.milestone, planVersion: architecture.plan.version, planDigest,
        eventHead: event.commitSha, eventSource, worker: "pi",
        provider: input.provider ?? "openai", model: input.model ?? "gpt-6-luna", thinking: input.thinking,
        units: [{ id: "interactive-choice-" + input.milestone.slice(10), domain: "choice", phase: "pending" },
          { id: "interactive-puzzle-" + input.milestone.slice(10), domain: "puzzle", phase: "pending" }] };
      await persist(file, receipt);
    }
    if (input.action === "run" && input.round) {
      if (!input.unit) throw Error("Checkpointed Interactive round requires an exact subunit.");
      const selected = receipt.units[input.unit === "choice" ? 0 : 1];
      if (selected.assignmentKey && selected.assignmentKey !== input.round.assignmentKey)
        throw Error("Foreign Interactive assignment round.");
      if (selected.invocationProof && input.round.command.phase !== "invoke" &&
          (input.round.command.phase !== "verify" ||
           JSON.stringify(input.round.command.proof) !== JSON.stringify(selected.invocationProof)))
        throw Error("Interactive round differs from its accepted invocation proof.");
    }
    milestoneBlueprint ??= await reviewedMilestoneHandoff(job, event);
    if (JSON.stringify(receipt.correctedBlueprintPin) !== JSON.stringify(consumedCorrection(milestoneBlueprint)))
      throw Error("Interactive receipt lost its consumed Blueprint supersession.");
    if (receipt.units[0].phase === "not-applicable" || receipt.units[0].eventOnly) {
      const first = receipt.units[0], second = receipt.units[1];
      if (first.phase !== "not-applicable" || second.phase !== "not-applicable" ||
          !first.eventOnly || JSON.stringify(first.eventOnly) !== JSON.stringify(second.eventOnly) ||
          first.beforeHead !== second.beforeHead || !first.beforeHead ||
          first.paths?.length || second.paths?.length ||
          first.claimedPaths?.length || second.claimedPaths?.length ||
          first.commitSha || second.commitSha || receipt.planDigest !== planDigest)
        throw Error("Event-only omission receipt is not a complete, commitless controller decision.");
      assertMilestoneInteractiveDisposition(milestoneBlueprint, true);
      const proof = await readEventOnlyOmission(job, input.milestone, first.eventOnly, {
        eventHead: event.commitSha, planDigest, eventSnapshotId: event.snapshot.id,
        validatorVersion: job.validatorVersion });
      if (proof.reviewMode !== receipt.worker || proof.reviewHead !== first.beforeHead ||
          proof.planVersion !== receipt.planVersion ||
          JSON.stringify(proof.eventIds) !== JSON.stringify(event.validation.eventIds))
        throw Error("Event-only receipt misrepresents its original specialist/reviewer provenance.");
      if (dirty(job).length) throw Error("Event-only omission cannot resume a dirty Story worktree.");
      return output(job, receipt, input.unit);
    }
    if (input.action === "inspect") {
      if (receipt.units.some(unit => unit.phase === "conflicted"))
        await inspectInteractiveConflict(job, input.milestone);
      return output(job, receipt, input.unit);
    }
    if (readRecoveryFork(job) && receipt.units.some(unit => unit.phase === "pending") &&
        receipt.units.every(unit => unit.phase === "pending" && !unit.beforeHead ||
          unit.phase === "committed" && commitOrigin(job, unit.id, unit.commitSha!).jobId !== job.jobId)) {
      receipt.worker = "pi";
      receipt.provider = input.provider ?? "openai";
      receipt.model = input.model ?? "gpt-6-luna";
      await persist(file, receipt);
    }
    if (Boolean(input.fixture) !== (receipt.worker === "fixture") ||
        input.provider && input.provider !== receipt.provider ||
        input.model && input.model !== receipt.model || input.thinking && input.thinking !== receipt.thinking) {
      throw new Error("Interactive worker selection differs from saved assignment.");
    }
    const config = input.skillsSource
      ? { discovery: "explicit-only" as const, novelteaSkills: input.skillsSource, skillDirs: [], requiredSkills: [] }
      : receipt.snapshot
        ? { discovery: "explicit-only" as const, novelteaSkills: undefined, skillDirs: [], requiredSkills: [] }
        : await loadSkillConfig(undefined, false);

    if (!receipt.snapshot) {
      const snapshot = await createSkillSnapshot({ ...config,
        novelteaSkills: input.skillsSource ?? config.novelteaSkills,
        discovery: "explicit-only", requiredSkills: ["nt-interactive-narrative", "nt-puzzle-design", "nt-catalog"] });
      if (!snapshot) throw new Error("Interactive design requires pinned NovelTea skills.");
      receipt.snapshot = snapshot;
      await persist(file, receipt);
    }
    if (await openSkillSnapshot(receipt.snapshot.id) !== receipt.snapshot.path) {
      throw new Error("Interactive skill snapshot path does not match its immutable pin.");
    }
    const validate = async (head: string) => validateStoryJob(
      await startStoryJob({ story: input.story, job: input.job }, false),
      input.validatorSource ?? input.skillsSource ?? config.novelteaSkills, { ...job, baseSha: head });
    async function executeUnit(unit: Unit, state: Receipt) {
      const index = state.units.indexOf(unit);
      if (unit.retainedChoice && ["pending", "writing"].includes(unit.phase)) {
        const retained = await inspectRetainedChoiceContinuation(job, state.milestoneId);
        if (!retained || unit.domain !== "choice" || !input.round ||
            input.round.assignmentKey !== retained.assignmentKey ||
            JSON.stringify(input.round.retainedChoice) !== JSON.stringify(retained.pin))
          throw Error("Retained Choice has no original parent recovery admission.");
      }
      if (unit.writerContinuation && ["pending", "writing"].includes(unit.phase)) {
        const source = await (await import("./writer-dependency.js")).authenticateWriterContinuation(job, unit.writerContinuation, unit.domain, state.milestoneId, input.round?.assignmentKey);
        const archive = JSON.parse(await readFile(interactiveWriterArchive(job, state.milestoneId, unit.domain, source.sealDigest), "utf8")) as Receipt;
        const original = archive.units[index]!;
        if (original.assignmentKey !== unit.assignmentKey || original.piSessionId !== unit.piSessionId || original.piSessionFile !== unit.piSessionFile || original.piSessionSha256 !== unit.writerContinuation.sessionSha256)
          throw Error("Interactive continuation lost its original writer");
      }
      if (unit.phase === "pending") await processAuthorUpdatesAtBoundary(job);
      const sourceHead = index ? state.units[0]!.commitSha : state.eventHead;
      const before = unit.beforeHead ?? (unit.phase === "pending" && sourceHead
        ? await verifiedNarrativeSuccessor(job, sourceHead) : sourceHead);
      if (!before) throw new Error("Puzzle specialist is blocked until the Choice work item is committed.");
      if (unit.beforeHead && unit.beforeHead !== before) throw new Error("Interactive unit authority head changed.");
      if (unit.phase === "conflicted") {
        await inspectInteractiveConflict(job, state.milestoneId);
        return; // No second Pi invocation after a settled negative result.
      }
      if (unit.phase === "not-applicable") {
        if (index !== 1 || unit.domain !== "puzzle" || !unit.beforeHead ||
            unit.paths?.length !== 0 || unit.claimedPaths?.length !== 0)
          throw new Error("Invalid optional Puzzle state; no writer replay allowed.");
        const proof = await readPuzzleNoWrite(job, state.milestoneId, unit.noWrite);
        if (proof.unitId !== unit.id || proof.eventHead !== state.eventHead ||
            proof.choiceHead !== state.units[0]!.commitSha || proof.verifiedHead !== before ||
            proof.planDigest !== state.planDigest || proof.planVersion !== state.planVersion ||
            proof.snapshotId !== state.snapshot?.id || proof.worker !== state.worker ||
            proof.provider !== state.provider || proof.model !== state.model ||
            proof.piSessionFile !== (unit.piSessionFile ?? null) ||
            JSON.stringify(proof.report.architecturalConflicts) !== JSON.stringify(unit.conflicts) ||
            JSON.stringify(proof.report.laterObligations) !== JSON.stringify(unit.obligations) ||
            JSON.stringify(proof.skillReads) !== JSON.stringify(unit.skillReads))
          throw new Error("Optional Puzzle no-write source, worker, or specialist report mismatches its seal.");
        if (dirty(job).length) throw new Error("Optional Puzzle no-write state has a dirty Story.");
        const current = git(job, "rev-parse", "HEAD");
        if (current !== before) {
          try { await verifiedNarrativeSuccessor(job, before); }
          catch { await verifiedCompositionSuccessor(job, state.milestoneId, before); }
        }
        return;
      }
      if (unit.phase === "committed") {
        if (!unit.commitSha) throw new Error("Committed unit lacks a verifiable commit SHA.");
        verifyCommit(job, state, unit, before, unit.commitSha);
        const current = git(job, "rev-parse", "HEAD");
        const expected = index ? unit.commitSha : state.units[1]!.commitSha ?? unit.commitSha;
        if (dirty(job).length) throw new Error("Interactive committed Story worktree is dirty.");
        if (current !== expected) {
          try {
            await verifiedNarrativeSuccessor(job, expected);
          } catch (error) {
            // A fully committed Interactive slice may now have separately
            // verified Composition as its successor, without replaying Choice/Puzzle.
            if (!completed(state)) throw error;
            await verifiedCompositionSuccessor(job, state.milestoneId,
              state.units[1]!.commitSha ?? state.units[1]!.beforeHead!);
          }
        }
        if (current === unit.commitSha) await publishHead(job, before, unit.commitSha, unit.id);
        return;
      }
      if (index > 0) await assertNativeReviewDependencies(job, unit.id);
      if (unit.phase === "writing" && (state.worker !== "pi" || !unit.invocation))
        throw new Error("Interrupted Interactive specialist lacks current-format invocation evidence; preserve its effects.");
      const current = git(job, "rev-parse", "HEAD");
      const recovering = unit.phase === "authored" && current !== before;
      if (recovering && (!unit.paths || !unit.digest || dirty(job).length ||
          git(job, "rev-parse", "HEAD^") !== before ||
          !git(job, "log", "-1", "--format=%B").includes("NovelTea-Interactive: " + unit.digest))) {
        throw new Error("Unrecognized interrupted interactive commit; reconcile manually.");
      }
      if (!recovering) {
        assertHead(job, before);
        if (unit.phase === "pending" && dirty(job).length) throw new Error("Interactive writer requires a clean Story boundary.");
      }
      const baseline = unit.invocation?.baseline ?? reportOf(await validate(before), before);
      const selected = selectAssignment(architecture.plan!, baseline, state.milestoneId,
        state.eventSource ?? eventSource, milestoneBlueprint);
      const puzzleDecision = unit.domain === "puzzle"
        ? await puzzleObligation(job, architecture.plan!, baseline.records,
            selected.eventIds, [...eventSource.missingObligations,
              ...(milestoneBlueprint?.design.downstream.filter(o => o.owner === "interactive").map(o => o.obligation) ?? [])]) : undefined;
      // A Story-wide minimum is not a demand for a Puzzle at every milestone.
      // Preserve the last admitted opportunity if the canonical minimum is not met.
      if (puzzleDecision && input.interactionInventory) {
        const direction = baseline.records.find(r => r.metadata.type === "creative-direction" && r.metadata.status === "approved");
        const planning = direction?.metadata.planning ? parseStoryPlanning(direction.metadata.planning) : null;
        const minimum = planning ? Math.max(planning.puzzle_count?.min ?? 0,
          ["custom", "hybrid"].includes(planning.puzzle_emphasis ?? "none") ? 1 : 0) : 0;
        const existing = baseline.records.filter(r => r.metadata.type === "puzzle" && r.metadata.status !== "superseded").length;
        const otherPending = input.interactionInventory.filter(i => i.milestone !== input.milestone &&
          ["interactive", "puzzle"].includes(i.stage) && i.status === "pending" && !i.omission).length;
        if (minimum > existing + otherPending) {
          puzzleDecision.required = true;
          puzzleDecision.reasons.push("Approved Story-wide Puzzle minimum requires this remaining admitted opportunity.");
        }
      }
      const assign = { ...selected,
        ...(puzzleDecision ? { puzzleObligation: puzzleDecision } : {}),
        ...(input.task ? { authorTask: input.task } : {}),
        ...(unit.invocation ? { dependencyObligations: unit.invocation.assignment.dependencyObligations } : input.turnPlanDigest ?
          { dependencyObligations: (await (await import("./dependency-state.js")).dependencyTurn(job)).objective?.obligations } : {}) };
      if (state.worker === "pi" && ["pending", "writing"].includes(unit.phase)) {
        if (!input.round || !/^[a-f0-9]{64}$/.test(input.round.assignmentKey) ||
            unit.assignmentKey && unit.assignmentKey !== input.round.assignmentKey ||
            !unit.assignmentKey && (unit.phase !== "pending" || input.round.command.phase !== "invoke"))
          throw Error("Interactive Pi writer requires its original checkpointed assignment round.");
        unit.assignmentKey = input.round.assignmentKey;
      }
      if (unit.phase === "pending") {
        await preflightPiAssignment(job, "interactive:" + assign.workItemId + ":" + unit.domain,
          state.worker === "pi" ? { provider: state.provider, model: state.model, thinking: state.thinking } : undefined);
        unit.phase = "writing";
        unit.beforeHead = before;
        if (state.worker === "pi") unit.invocation = { baseline, assignment: assign,
          sourceDigest: await interactiveSourceDigest(job, state, unit, baseline, assign) };
        await persist(file, state);
      }
      const authorizeInvocation = async () => {
        assertHead(job, before);
        if (!unit.invocation || JSON.stringify(assign) !== JSON.stringify(unit.invocation.assignment) ||
            await interactiveSourceDigest(job, state, unit, baseline, assign) !== unit.invocation.sourceDigest ||
            await openSkillSnapshot(state.snapshot!.id) !== state.snapshot!.path)
          throw Error("Original Interactive assignment, native baseline, or model source changed");
        await interactiveEffect(job, before);
      };
      if (unit.phase === "writing") {
        try {
          const verifyDraft = async (evidence: InteractiveEvidence) => {
            if (evidence.modifiedRecords.length === 0 &&
                (evidence.dependencyFinding || unit.domain === "choice" || puzzleDecision?.required !== false)) {
              if (!evidence.conflicts.length) throw Error("Interactive negative report has no explicit conflict");
              assertHead(job, before);
              if (dirty(job).length)
                throw Error("Negative Interactive report disagrees with the actual Story worktree");
              // A truthful claim remains negative until controller review;
              // the writer cannot fill the missing interaction with an invented one.
              return [];
            }
            if (unit.domain === "puzzle" && evidence.modifiedRecords.length === 0) {
              if (puzzleDecision?.required !== false || !evidence.conflicts.length)
                throw new Error("Required Puzzle has no solvable output; the approved goal remains blocked.");
              assertHead(job, before);
              if (dirty(job).length)
                throw new Error("No-write Puzzle report disagrees with the actual dirty Story tree.");
              const checked = reportOf(await validate(before), before);
              const current = await puzzleObligation(job, architecture.plan!, checked.records,
                assign.eventIds, [...eventSource.missingObligations,
                  ...(milestoneBlueprint?.design.downstream.filter(o => o.owner === "interactive").map(o => o.obligation) ?? [])]);
              if (current.required || current.turnDigest !== puzzleDecision.turnDigest)
                throw new Error("Puzzle source obligation changed before optional no-write decision.");
              verifyChoice(checked, state.units[0]!.paths ?? [], assign,
                state.units[0]!.obligations ?? []);
              return [];
            }
            let paths: string[];
            try {
              paths = await auditInteractivePaths(job, assign, unit.domain, evidence.modifiedRecords);
            } catch (error) {
              // A safe, in-scope draft may have an incomplete self-reported
              // file inventory. Give Pi the actual diff to correct its
              // manifest, but never repair unauthorized files automatically.
              if (String(error).includes("manifest differs from actual Git files")) {
                await assertSafeInteractiveRepair(job, before, validate);
                return [String(error) + " Re-report ALL currently modified Story-relative files, not only the last edit."];
              }
              const feedback = await scopeRepairFeedback(job, before, error, validate);
              if (feedback) return feedback;
              throw error;
            }
            assertHead(job, before);
            const checked = await validate(before);
            const report = checked.report as unknown as Report | undefined;
            if (report?.protection?.status !== "checked" || report.protection.changes.length ||
                report.protection.warnings.length) {
              throw new Error("Interactive draft has protected/unverified changes; no automatic retcon allowed.");
            }
            if (evidence.conflicts.length) {
              const feedback = interactiveConflictRepairFeedback(
                evidence.conflicts, paths, report.diagnostics);
              if (!feedback) {
                await assertSafeInteractiveRepair(job, before, validate);
                return ["The draft reports an unresolved architectural conflict. Restore only your audited changes to their original source and submit a truthful no-write dependency report, or resolve the conflict entirely within the existing assignment. Do not change another owner's records."];
              }
              // A model's "architectural conflict" label is not a grant.
              // Independently reverify this job, baseline and exact pinned
              // Git protection before returning any in-scope correction.
              await assertSafeInteractiveRepair(job, before, validate);
              return feedback;
            }
            if (report.diagnostics.length) {
              if (report.diagnostics.every(d => ["schema", "yaml", "frontmatter"].includes(d.code) && paths.includes(d.path)))
                return nativeMetadataDefects(checked, { jobId: job.jobId, baseSha: before,
                  worktreeStoryRoot: job.worktreeStoryRoot, validatorVersion: job.validatorVersion, paths });
              return report.diagnostics.slice(0, 24).map(d =>
                `${d.path}:${d.line ?? 1}:${d.column ?? 1} ${d.code}: ${d.message}`);
            }
            if (checked.status !== "passed") throw new Error("Canonical validator rejected interactive draft without diagnostics.");
            try {
              await checkOutput(job, baseline, report, assign, { ...unit, paths }, evidence.obligations);
              if (unit.domain === "puzzle") verifyChoice(report, state.units[0]!.paths ?? [], assign,
                state.units[0]!.obligations ?? []);
              return [];
            } catch (error) { return [String(error)]; }
          };
          let evidence: InteractiveEvidence;

            await authorizeInvocation();
            const authored = await authorInteractive(job, state.snapshot!, unit.domain, assign, state.provider, state.model, state.thinking,
              async (session, id) => {
                if (unit.piSessionFile && (unit.piSessionFile !== session || unit.piSessionId !== id))
                  throw Error("Interactive invocation session changed");
                unit.piSessionFile = session; unit.piSessionId = id; await persist(file, state);
              }, verifyDraft, { sourceDigest: unit.invocation!.sourceDigest,
                sessionFile: unit.piSessionFile, sessionId: unit.piSessionId, continuation: unit.writerContinuation ?? unit.retainedChoice,
                authorize: authorizeInvocation, effect: () => interactiveEffect(job, before) }, input.round!.command);
            if ("round" in authored) return authored.round;
            evidence = authored;
            unit.invocationProof = evidence.invocationProof;
            if (!unit.invocationProof || !unit.piSessionId || !unit.piSessionFile)
              throw Error("Interactive result lacks its original settled invocation");
            await verifySettledAssignment({ proof: unit.invocationProof,
              directory: interactiveInvocationDirectory(job, state.workItemId, unit.domain, unit.piSessionId, (unit.writerContinuation || unit.retainedChoice) ? unit.invocation?.sourceDigest : undefined),
              sessionId: unit.piSessionId, sessionFile: unit.piSessionFile,
              sessionRoots: [join(job.stateDir, "interactive-sessions", state.workItemId, unit.domain)],
              effect: await interactiveEffect(job, before) });

          unit.claimedPaths = evidence.modifiedRecords;
          unit.conflicts = evidence.conflicts;
          unit.obligations = evidence.obligations;
          unit.skillReads = evidence.skillReads;
          unit.piSessionFile = evidence.piSessionFile ?? unit.piSessionFile;
          if (evidence.modifiedRecords.length === 0 &&
              (evidence.dependencyFinding || unit.domain === "choice" || puzzleDecision?.required !== false)) {
            if (!evidence.conflicts.length || !state.snapshot?.id ||
                (state.worker === "pi" && !unit.piSessionFile))
              throw Error("Interactive no-write has no original completed worker and pinned assignment");
            assertHead(job, before);
            if (dirty(job).length) throw Error("Interactive negative report left Story edits");
            const sessionPath = unit.piSessionFile ? await realpath(unit.piSessionFile) : null;
            const directory = join(job.stateDir, "interactive-sessions", state.workItemId, unit.domain);
            if (sessionPath && (!sessionPath.startsWith(directory + "/") ||
                unit.piSessionFile !== sessionPath || !sessionPath.endsWith(".jsonl")))
              throw Error("Interactive no-write session is outside its original assignment");
            const transcript = sessionPath ? await readFile(sessionPath) : undefined;
            unit.piSessionSha256 = transcript ? digest(transcript) : undefined;
            unit.piSessionBytes = transcript?.length;
            if (evidence.dependencyFinding) unit.dependencyFinding = evidence.dependencyFinding;
            unit.paths = [];
            unit.digest = interactiveConflictReportDigest(state, unit,
              sessionPath, unit.piSessionSha256 ?? null);
            unit.phase = "conflicted";
            delete unit.failure;
            await persist(file, state);
            await inspectInteractiveConflict(job, state.milestoneId);
            return;
          }
          if (unit.domain === "puzzle" && evidence.modifiedRecords.length === 0) {
            if (puzzleDecision?.required !== false || !puzzleDecision.turnDigest ||
                !evidence.conflicts.length || !state.snapshot?.id)
              throw new Error("Cannot classify the approved Puzzle obligation as optional.");
            assertHead(job, before);
            if (dirty(job).length) throw new Error("No-write Puzzle left dirty Story files.");
            const checked = reportOf(await validate(before), before);
            const current = await puzzleObligation(job, architecture.plan!, checked.records,
              assign.eventIds, [...eventSource.missingObligations,
                ...(milestoneBlueprint?.design.downstream.filter(o => o.owner === "interactive").map(o => o.obligation) ?? [])]);
            if (current.required || current.turnDigest !== puzzleDecision.turnDigest)
              throw new Error("Puzzle no-write source changed since initial assessment.");
            verifyChoice(checked, state.units[0]!.paths ?? [], assign,
              state.units[0]!.obligations ?? []);
            unit.noWrite = await sealPuzzleNoWrite(job, {
              version: 1, decision: "not-applicable", jobId: job.jobId, threadId: job.threadId,
              branch: job.branch, baseSha: job.baseSha, milestoneId: state.milestoneId,
              unitId: unit.id, eventHead: state.eventHead,
              choiceHead: state.units[0]!.commitSha!, verifiedHead: before,
              planVersion: state.planVersion, planDigest: state.planDigest,
              turnDigest: current.turnDigest!, snapshotId: state.snapshot.id,
              worker: state.worker, provider: state.provider, model: state.model,
              piSessionFile: unit.piSessionFile ?? null,
              piSessionSha256: state.worker === "pi" && unit.piSessionFile
                ? puzzleNoWriteSessionDigest(job, unit.id, unit.piSessionFile) : null,
              report: { modifiedRecords: [], architecturalConflicts: evidence.conflicts,
                laterObligations: evidence.obligations }, skillReads: evidence.skillReads,
            });
            unit.paths = []; unit.phase = "not-applicable";
            delete unit.failure;
            await persist(file, state);
            return;
          }
          unit.paths = await auditInteractivePaths(job, assign, unit.domain, evidence.modifiedRecords);
          unit.digest = await fileDigest(job, unit.paths);
          unit.phase = "authored";
          await persist(file, state);
          if (unit.conflicts?.length) throw new Error("Specialist reported unresolved interactive conflicts.");
        } catch (error) {
          unit.failure = String(error);
          await persist(file, state);
          throw error;
        }
      }
      try {
        if (!unit.paths || !unit.digest ||
            await fileDigest(job, unit.paths) !== unit.digest || unit.conflicts?.length) {
          throw new Error("Interactive files differ from their audited manifest or have unresolved conflicts.");
        }
        if (state.worker === "pi") {
          if (!unit.invocation || !unit.invocationProof || !unit.piSessionId || !unit.piSessionFile ||
              await interactiveSourceDigest(job, state, unit, baseline, assign) !== unit.invocation.sourceDigest ||
              unit.invocationProof.sourceDigest !== unit.invocation.sourceDigest)
            throw Error("Interactive authored effect lacks its original invocation proof");
          await verifySettledAssignment({ proof: unit.invocationProof,
            directory: interactiveInvocationDirectory(job, state.workItemId, unit.domain, unit.piSessionId, (unit.writerContinuation || unit.retainedChoice) ? unit.invocation?.sourceDigest : undefined),
            sessionId: unit.piSessionId, sessionFile: unit.piSessionFile,
            sessionRoots: [join(job.stateDir, "interactive-sessions", state.workItemId, unit.domain)],
            effect: unit.digest });
        }
        const checked = await validate(before);
        const report = reportOf(checked, before);
        const evidence = await checkOutput(job, baseline, report, assign, unit, unit.obligations ?? []);
        if (unit.domain === "puzzle") evidence.choices = verifyChoice(report, state.units[0]!.paths ?? [], assign,
          state.units[0]!.obligations ?? []);
        if (!recovering) {
          assertHead(job, before);
          const currentPaths = await auditInteractivePaths(job, assign, unit.domain, unit.claimedPaths ?? []);
          if (JSON.stringify(currentPaths) !== JSON.stringify(unit.paths)) {
            throw new Error("Interactive files changed after independent validation.");
          }
          git(job, "add", "--", ...unit.paths.map(path => repoPath(job, path)));
          git(job, "-c", "user.name=NovelTea Generator",
            "-c", "user.email=noveltea-gen@users.noreply.github.com",
            "commit", "-m", `Develop ${unit.domain} alternatives [${job.jobId}]\n\nNovelTea-Job: ${job.jobId}\nNovelTea-Work-Item: ${unit.id}\nNovelTea-Plan-Version: ${state.planVersion}\nNovelTea-Interactive: ${unit.digest}`);
        }
        if (dirty(job).length) throw new Error("Interactive commit left untracked or staged Story files.");
        const sha = git(job, "rev-parse", "HEAD");
        verifyCommit(job, state, unit, before, sha);
        unit.commitSha = sha;
        unit.phase = "committed";
        unit.validation = { status: "passed", validatorVersion: checked.validator.version,
          protectionBase: before, ...evidence, downstreamObligations: unit.obligations ?? [],
          searchTruncated: report.coverage.search.truncated };
        delete unit.failure;
        await persist(file, state);
        await publishHead(job, before, sha, unit.id);
      } catch (error) {
        unit.failure = String(error);
        await persist(file, state);
        throw error;
      }
    }
    // The production parent checkpoints each subunit using the shared child.
    // The standalone domain command is only a serial adapter over the same receipts.
    if (input.unit !== "puzzle") {
      const round = await executeUnit(receipt.units[0]!, receipt);
      if (round) return { ...output(job, receipt, input.unit), status: "writer-round", round };
    }
    if (input.unit !== "choice" && receipt.units[0].phase !== "conflicted") {
      const round = await executeUnit(receipt.units[1]!, receipt);
      if (round) return { ...output(job, receipt, input.unit), status: "writer-round", round };
    }
    if (receipt.units.some(unit => unit.phase === "conflicted")) {
      // No next-stage or deferred-idea authorization follows a negative
      // original assignment. The generation controller owns its disposition.
      await inspectInteractiveConflict(job, input.milestone);
      return output(job, receipt, input.unit);
    }
    if (input.deferBoundary) return output(job, receipt, input.unit);
    const authorUpdates = await processAuthorUpdatesAfterWork(job);
    const { scheduleIdeasAtBoundary } = await import("./idea-placement.js");
    await scheduleIdeasAtBoundary(job, "interactive-work");
    return { ...output(job, receipt, input.unit), authorUpdates };
  };
  if (input.action === "review-omission")
    return withStoryJobLockOrReuse(job, "interactive-" + input.milestone.slice(10),
      ["generation-boundary", "generation-verification", "generation-idea-verification",
        "generation-c06-interactive-supersession"],
      execute);
  return withStoryJobLock(job, "interactive-" + input.milestone.slice(10), execute);
}
