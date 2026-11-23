import { execFileSync } from "./git-read-cache.js";
import { commitOrigin, readRecoveryFork } from "./recovery-fork-state.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { authorInteractive, parseInteractiveManifest, type InteractiveAssignment, type InteractiveDomain, type InteractiveEvidence } from "./interactive-specialist.js";
import { eventCompletionDigest, currentMilestoneChoiceBinding } from "./event-work.js";
import { startStoryJob, type JobStartResult } from "./job.js";
import { trustedHead } from "./revision.js";
import { finalizeRecoveryCheckpoint } from "./recovery-checkpoints.js";
import { assertNativeReviewDependencies } from "./checkpoint-assurance.js";
import { verifiedNarrativeSuccessor, verifiedCompositionSuccessor } from "./job-successor.js";
import { withStoryJobLock, withStoryJobLockOrReuse } from "./job-lock.js";
import { fixtureCluster } from "./fixture-cluster.js";
import { assertPlanContinuity } from "./plan-continuity.js";
import { processAuthorUpdatesAtBoundary, processAuthorUpdatesAfterWork } from "./author-updates.js";
import { loadSkillConfig } from "./skills.js";
import { preflightPiAssignment } from "./job-pi-policy.js";
import { createSkillSnapshot, openSkillSnapshot, type SkillSnapshot } from "./snapshot.js";
import { validateStoryJob, type ValidationResult } from "./validator.js";
import type { Plan } from "./architecture.js";
import { puzzleObligation, sealPuzzleNoWrite, readPuzzleNoWrite, puzzleNoWriteSessionDigest,
  type PuzzleNoWriteRef } from "./puzzle-obligation.js";
import { decideEventOnlyOmission, readEventOnlyOmission, type EventOnlyRef } from "./interactive-event-only.js";
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
  conflicts?: string[]; obligations?: string[]; failure?: string;
  noWrite?: PuzzleNoWriteRef;
  /** Original settled negative report; never a new writer lease. */
  piSessionSha256?: string;
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
export interface InteractiveOptions {
  story: string; job: string; action: "run" | "inspect" | "review-omission"; milestone: string;
  skillsSource?: string; validatorSource?: string; fixture?: boolean; provider?: string; model?: string; task?: string; thinking?: "low" | "medium" | "high";
  /** Production graph can checkpoint Choice and Puzzle independently; the
   * persisted two-unit receipt and original writer/review gates are shared. */
  unit?: InteractiveDomain;
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
      milestoneId, String(milestone!.metadata.change ?? "")))
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
function choiceConflictReportDigest(receipt: Receipt, choice: Unit,
  sessionPath: string | null, sessionHash: string | null) {
  return digest(JSON.stringify({
    jobId: receipt.jobId, worker: receipt.worker,
    workItemId: receipt.workItemId, milestoneId: receipt.milestoneId,
    baseSha: receipt.baseSha, planVersion: receipt.planVersion,
    planDigest: receipt.planDigest, eventHead: receipt.eventHead,
    provider: receipt.provider, model: receipt.model,
    thinking: receipt.thinking ?? null, eventSource: receipt.eventSource ?? null,
    head: choice.beforeHead, snapshotId: receipt.snapshot?.id,
    unitId: choice.id, paths: choice.claimedPaths, conflicts: choice.conflicts,
    obligations: choice.obligations, skillReads: choice.skillReads,
    piSessionFile: sessionPath, piSessionSha256: sessionHash,
  }));
}
/** Reauthenticate a settled Choice contradiction at the original unchanged
 * HEAD. The negative report is evidence, never an authority to revise canon. */
export async function inspectInteractiveConflict(job: JobStartResult, milestoneId: string,
  allowHistoricalDescendant = false) {
  if (!validMilestone.test(milestoneId)) throw Error("Invalid Interactive conflict Milestone");
  const relative = "interactive-items/" + milestoneId.slice(10) + ".json";
  let receipt = JSON.parse(await readFile(join(job.stateDir, relative), "utf8")) as Receipt;
  if (receipt.supersededNegative) {
    const ref = receipt.supersededNegative;
    const historical = "interactive-negative-history/" + milestoneId.slice(10) + ".json";
    if (ref.relative !== historical || !/^[0-9a-f]{64}$/.test(ref.digest))
      throw Error("Original Choice negative history reference is invalid.");
    const prior = JSON.parse(await readFile(join(job.stateDir, historical), "utf8")) as Receipt;
    if (prior.supersededNegative || digest(JSON.stringify(prior)) !== ref.digest ||
        prior.jobId !== receipt.jobId || prior.eventHead !== receipt.eventHead ||
        prior.milestoneId !== receipt.milestoneId || prior.planDigest !== receipt.planDigest)
      throw Error("Archived original Choice contradiction was changed after supersession.");
    receipt = prior;
  }
  const choice = receipt.units?.[0];
  const puzzle = receipt.units?.[1];
  const architecture = JSON.parse(await readFile(join(job.stateDir, "architecture.json"), "utf8")) as {
    jobId?: string; phase?: string; plan?: Plan };
  const head = await trustedHead(job);
  if (receipt.jobId !== job.jobId || receipt.milestoneId !== milestoneId ||
      architecture.jobId !== job.jobId || architecture.phase !== "committed" ||
      !architecture.plan || architecture.plan.version !== receipt.planVersion ||
      digest(JSON.stringify(architecture.plan)) !== receipt.planDigest ||
      !puzzle || puzzle.domain !== "puzzle" || puzzle.phase !== "pending" ||
      !!puzzle.beforeHead || !!puzzle.commitSha || !!puzzle.paths?.length ||
      !["pi", "fixture"].includes(receipt.worker) || !receipt.snapshot?.id ||
      !choice || choice.phase !== "conflicted" || choice.domain !== "choice" ||
      choice.id !== "interactive-choice-" + milestoneId.slice(10) ||
      !choice.beforeHead || choice.beforeHead !== head && !allowHistoricalDescendant ||
      !receipt.eventHead || !receipt.planDigest || !receipt.planVersion ||
      choice.paths?.length || choice.claimedPaths?.length || choice.commitSha ||
      !choice.conflicts?.length || !choice.conflicts.every(x => !!x.trim()) ||
      !Array.isArray(choice.obligations) ||
      (receipt.worker === "pi" && (!choice.piSessionFile || !choice.piSessionSha256)) ||
      (receipt.worker === "fixture" && (choice.piSessionFile || choice.piSessionSha256)) ||
      !choice.digest || dirty(job).length)
    throw Error("Original Choice no-write source or receipts cannot be authenticated");
  const directory = join(job.stateDir, "interactive-sessions", receipt.workItemId, "choice");
  const sessionPath = receipt.worker === "pi" ? await realpath(choice.piSessionFile!) : null;
  if (sessionPath && (!sessionPath.startsWith(directory + "/") ||
      choice.piSessionFile !== sessionPath || !sessionPath.endsWith(".jsonl")))
    throw Error("Original Choice session is outside its assigned directory");
  const sessionStat = sessionPath ? await lstat(sessionPath) : null;
  if (sessionStat && (!sessionStat.isFile() || sessionStat.size > 64 * 1024 * 1024))
    throw Error("Original Choice Pi session is not a bounded regular file");
  const sessionBytes = sessionPath ? await readFile(sessionPath) : null;
  const sessionHash = sessionBytes ? digest(sessionBytes) : null;
  if ((choice.piSessionSha256 ?? null) !== sessionHash) throw Error("Original Choice Pi session changed");
  if (sessionBytes) {
    const records = sessionBytes.toString("utf8").trim().split("\n").map(line =>
      JSON.parse(line) as { type?: string; id?: string;
        message?: { role?: string; stopReason?: string;
          content?: Array<{ type?: string; text?: string }> } });
    if (records[0]?.type !== "session" || !records[0].id)
      throw Error("Original Choice Pi session lost its identity");
    const messages = records.filter(r => r.type === "message" && r.message?.role === "assistant")
      .map(r => r.message!);
    const last = messages.at(-1);
    if (!last || last.stopReason !== "stop")
      throw Error("Original Choice Pi report lacks a settled final assistant response");
    const reported = parseInteractiveManifest((last.content ?? [])
      .filter(c => c.type === "text").map(c => c.text ?? "").join("\n"), "choice");
    if (reported.paths.length ||
        JSON.stringify(reported.conflicts) !== JSON.stringify(choice.conflicts) ||
        JSON.stringify(reported.obligations) !== JSON.stringify(choice.obligations))
      throw Error("Original Choice report differs from the settled Pi transcript");
  }
  const event = JSON.parse(await readFile(join(job.stateDir,
    "event-items", milestoneId.slice(10) + ".json"), "utf8")) as SourceReceipt;
  if (event.jobId !== receipt.jobId || event.milestoneId !== milestoneId ||
      event.phase !== "committed" || event.commitSha !== receipt.eventHead ||
      event.planVersion !== receipt.planVersion)
    throw Error("Original Choice source no longer matches its verified Event receipt");
  git(job, "merge-base", "--is-ancestor", receipt.eventHead, choice.beforeHead);
  if (allowHistoricalDescendant) git(job, "merge-base", "--is-ancestor", choice.beforeHead, head);
  const reportHash = choiceConflictReportDigest(receipt, choice, sessionPath, sessionHash);
  if (choice.digest !== reportHash) throw Error("Original Choice negative report digest changed");
  // Historical inspection authenticates the original no-write revision,
  // not the later descendant currently at HEAD. A post-recovery Composition
  // commit must not rewrite the negative Pi report's source identity.
  return { relative, reportDigest: reportHash, expectedHead: choice.beforeHead,
    worker: receipt.worker, planVersion: receipt.planVersion,
    milestoneId, unitId: choice.id, conflicts: choice.conflicts,
    obligations: choice.obligations!, piSessionFile: sessionPath };
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
    worktreeStoryRoot: job.worktreeStoryRoot, headSha: receipt.units[1].commitSha ??
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
    specialistUnits: receipt.units.map(u => ({ ...u, specialist: u.domain === "choice"
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
async function fixtureAuthor(job: JobStartResult, domain: InteractiveDomain,
  assignment: InteractiveAssignment): Promise<InteractiveEvidence> {
  const variant = process.env.NT_INTERACTIVE_FIXTURE_CASE ?? "reference";
  const cluster = fixtureCluster(assignment.milestoneId);
  const paths: string[] = [];
  const add = async (folder: string, slug: string, type: string, metadata: string, body: string) => {
    slug = cluster.slug(slug); metadata = cluster.text(metadata);
    const path = folder + "/" + slug + ".md";
    await mkdir(dirname(join(job.worktreeStoryRoot, path)), { recursive: true });
    await writeFile(join(job.worktreeStoryRoot, path),
      `---\nschema: '0.1'\ntype: ${type}\nid: ${type}.${slug}\ntitle: "${slug}"\nstatus: draft\ndecisions: []\n${metadata}\n---\n\n${body}\n`,
      { flag: "wx" });
    paths.push(path);
    return path;
  };
  const rewrite = async (path: string, fn: (s: string) => string) => {
    path = cluster.path(path);
    const target = join(job.worktreeStoryRoot, path);
    await writeFile(target, cluster.text(fn(await readFile(target, "utf8"))));
    paths.push(path);
  };
  const arc = assignment.arcIds[0]!;
  const event = assignment.eventIds.includes(cluster.text("event.disclose-ledger"))
    ? cluster.path("events/disclose-ledger.md") : "events/" + assignment.eventIds[0]!.slice(6) + ".md";
  if (domain === "choice" && variant === "choice-conflict") {
    return { modifiedRecords: [], conflicts: [
      "The approved Event-only source has no causal Choice point; inventing a Choice would contradict its outcome."
    ], obligations: ["Request a controller-approved Milestone Blueprint correction before new Choice work."],
    skillReads: [] };
  }
  if (domain === "puzzle" && variant === "puzzle-no-write") {
    return { modifiedRecords: [], conflicts: [
      "The original Turn promises branch consequences and fair-play clues, not a formal Puzzle. " +
      "No existing route presents a single independently solvable Puzzle goal with two proved solution Events."
    ], obligations: ["Preserve fair-play clue continuity and distinct authored endings in Composition."],
    skillReads: [] };
  }
  if (domain === "choice") {
    await add("choice-points", "loyalty", "choice-point",
      'prompt: "Protect Neri or challenge the concealment?"\noutcomes: [protect, challenge]',
      "Protecting the friend preserves intimacy, while challenging the concealment risks the friendship in exchange for accountability.");
    if (variant === "two-choices") await add("choice-points", "testimony", "choice-point",
      'prompt: "Disclose the independent witness or protect their anonymity?"\noutcomes: [tell, withhold]',
      "The witness's identity can corroborate the evidence, but disclosure could endanger them.");
    const delayedEffect = ["downstream-effect-only", "downstream-no-effect"].includes(variant);
    const selectorConditions = (outcome: "protect" | "challenge") =>
      variant === "self-conditioned-selection"
        ? `\n          - kind: outcome\n            choice_point: choice-point.loyalty\n            value: ${outcome}`
        : " []";
    if (!delayedEffect) await add("revelations", "ledger-secret", "revelation",
      "fact: fact.evidence-concealed",
      "If Ada challenges Neri, the ledger detail is exposed to the player within that branch.");
    if (variant === "choice-content") {
      await add("authored-content", "choice-presentation", "authored-content",
        `events: [event.disclose-ledger]
revelations: [revelation.ledger-secret]`,
        "Ada can protect Neri and preserve trust, or confront the concealment and weaken their alliance. The actual ledger detail appears after the challenge.");
    }
    await rewrite(event, text => {
      const begin = text.indexOf("steps:");
      const end = text.indexOf("\n---", begin);
      if (begin < 0 || end < 0) throw new Error("Fixture expected existing complete Event steps.");
      const leak = variant === "state-leak";
      return text.slice(0, begin) +
        `steps:\n` + (leak ? `  - id: premature\n    branches:\n      - id: shared\n        conditions: []\n        effects:\n          - kind: revealed\n            revelation: revelation.ledger-secret\n            value: true\n` : "") + `  - id: admit\n    branches:\n      - id: disclose\n        conditions:${selectorConditions("protect")}\n        effects:\n          - kind: outcome\n            choice_point: choice-point.loyalty\n            value: protect\n          - kind: relationship\n            relationship: relationship.ada-neri\n            value: trusting\n          - kind: knowledge\n            character: character.ada\n            fact: fact.evidence-concealed\n            value: knows` +
        `\n      - id: challenge\n        conditions:${selectorConditions("challenge")}\n        effects:\n          - kind: outcome\n            choice_point: choice-point.loyalty\n            value: challenge\n          - kind: relationship\n            relationship: relationship.ada-neri\n            value: wary\n          - kind: knowledge\n            character: character.ada\n            fact: fact.evidence-concealed\n            value: knows\n          - kind: revealed\n            revelation: revelation.ledger-secret\n            value: true` +
        (variant === "same-event-payoff" ? `
  - id: later-payoff
    branches:
      - id: protect-follow-through
        conditions:
          - kind: outcome
            choice_point: choice-point.loyalty
            value: protect
        effects:
          - kind: relationship
            relationship: relationship.ada-neri
            value: trusting
      - id: challenge-follow-through
        conditions:
          - kind: outcome
            choice_point: choice-point.loyalty
            value: challenge
        effects:
          - kind: relationship
            relationship: relationship.ada-neri
            value: estranged` : "") +
        (variant === "two-choices" ? `
  - id: testimony-choice
    branches:
      - id: tell
        conditions: []
        effects:
          - kind: outcome
            choice_point: choice-point.testimony
            value: tell
          - kind: relationship
            relationship: relationship.ada-neri
            value: wary
      - id: withhold
        conditions: []
        effects:
          - kind: outcome
            choice_point: choice-point.testimony
            value: withhold
          - kind: relationship
            relationship: relationship.ada-neri
            value: trusting
  - id: testimony-payoff
    branches:
      - id: disclosure-consequence
        conditions:
          - kind: outcome
            choice_point: choice-point.testimony
            value: tell
        effects:
          - kind: relationship
            relationship: relationship.ada-neri
            value: estranged
      - id: secrecy-consequence
        conditions:
          - kind: outcome
            choice_point: choice-point.testimony
            value: withhold
        effects:
          - kind: relationship
            relationship: relationship.ada-neri
            value: trusting` : "") +
        text.slice(end);
    });
    if (delayedEffect) await rewrite(event, text => {
      const start = text.indexOf("steps:");
      const end = text.indexOf("\n---", start);
      if (start < 0 || end < 0) throw Error("Fixture has no Event step frontmatter.");
      return text.slice(0, start) + `steps:
  - id: decision
    branches:
      - id: protect
        conditions: []
        effects:
          - kind: outcome
            choice_point: choice-point.loyalty
            value: protect
      - id: challenge
        conditions: []
        effects:
          - kind: outcome
            choice_point: choice-point.loyalty
            value: challenge` + text.slice(end);
    });
    if (!["conditional-writing", "choice-id-obligation", "unpaid-choice", "same-event-payoff"].includes(variant)) await add("events", "aftermath", "event",
      `participants: [character.ada, character.neri]\narcs: [${arc}]\nconsequences: ["A choice changes how Ada and Neri collaborate afterward"]\nafter: []\nprerequisites:\n  any_of:\n    - completed: [${cluster.text("event.disclose-ledger")}]\n      not_completed: []\nsteps:\n  - id: consequence\n    branches:\n      - id: protect-response\n        conditions:\n          - kind: outcome\n            choice_point: choice-point.loyalty\n            value: protect\n        effects:\n          - kind: relationship\n            relationship: relationship.ada-neri\n            value: trusting\n      - id: challenge-response\n        conditions:\n          - kind: outcome\n            choice_point: choice-point.loyalty\n            value: challenge\n        effects:\n          - kind: relationship\n            relationship: relationship.ada-neri\n            value: estranged`,
      "If Ada protects Neri, they continue investigating as trusted collaborators. If she challenges Neri, the confrontation leaves their alliance damaged.");
    if (variant === "downstream-no-effect") {
      await rewrite("events/aftermath.md", text => text
        .replace(/effects:\n          - kind: relationship\n            relationship: relationship\.ada-neri\n            value: trusting/, "effects: []")
        .replace(/effects:\n          - kind: relationship\n            relationship: relationship\.ada-neri\n            value: estranged/, "effects: []"));
    }
    if (variant === "bypass-gate") {
      await rewrite(event, s => s.replace("prerequisites:\n  any_of:",
        "prerequisites:\n  any_of:\n    - completed: []\n      not_completed: []"));
    }
    if (variant === "protected-retcon") {
      const protectedPath = assignment.sourcePaths.find(path => path.startsWith("creative-direction/"))!;
      await rewrite(protectedPath, text => text.replace(
        "The player can protect a friend or demand accountability",
        "The player can never protect a friend"));
    }
    if (variant === "exclusive-endings") {
      // This route illegally demands two mutually exclusive outcomes at once.
      await add("events", "impossible-ending", "event",
        `participants: [character.ada]\narcs: [${arc}]\nconsequences: ["Both exclusive decisions somehow hold simultaneously"]\nafter: []\nprerequisites:\n  any_of:\n    - completed: [event.aftermath]\n      not_completed: []\n      conditions:\n        - kind: outcome\n          choice_point: choice-point.loyalty\n          value: protect\n        - kind: outcome\n          choice_point: choice-point.loyalty\n          value: challenge\nsteps: []`,
        "This invalid Event incorrectly requires protecting and challenging at the same time.");
    }
  } else {
    const common = `participants: [character.ada]\narcs: [${arc}]\nconsequences:`;
    await add("events", "discover-mark", "event",
      `${common}\n  - "Ada notices a distinctive watermark in an earlier archive note"\nafter: []\nprerequisites:\n  any_of:\n    - completed: [event.aftermath]\n      not_completed: []\nsteps: []`,
      "Ada can inspect a faded margin without solving the cipher. A visible watermark provides a clue to the document's origin.");
    await add("events", "discover-seal", "event",
      `${common}\n  - "Ada finds the custodian's seal impressed in a separate record"\nafter: []\nprerequisites:\n  any_of:\n    - completed: [event.aftermath]\n      not_completed: []\nsteps: []`,
      "A comparison record reveals a seal that could authenticate the ledger independently of the watermark.");
    if (["conditional-writing", "choice-id-obligation", "same-event-payoff"].includes(variant)) {
      for (const name of ["discover-mark", "discover-seal"]) {
        await rewrite("events/" + name + ".md", s =>
          s.replace("completed: [event.aftermath]", "completed: [event.disclose-ledger]"));
      }
    }
    await add("authored-content", "watermark-clue", "authored-content",
      "events: [event.discover-mark]\nrevelations: []",
      "In the margin, a crescent-shaped watermark repeats the mark on the custody register. Players can use this visible mark before attempting to decode the ledger.");
    await add("authored-content", "seal-clue", "authored-content",
      "events: [event.discover-seal]\nrevelations: []",
      "The brass seal on the custodian record matches the ledger's stamped cover. Its owner can confirm the missing witness's access before any solution is attempted.");
    await add("revelations", "puzzle-evidence", "revelation",
      "fact: fact.evidence-concealed",
      "Once either Puzzle solution is performed, the player sees the proof of the concealed entry.");
    await add("events", "decode-ledger", "event",
      `${common}\n  - "Ada uses the watermark key to decode the concealed ledger entry"\nafter: []\nprerequisites:\n  any_of:\n    - completed: [event.discover-mark]\n      not_completed: [event.request-testimony]\nsteps:\n  - id: decipher\n    branches:\n      - id: decode\n        conditions: []\n        effects:\n          - kind: revealed\n            revelation: revelation.puzzle-evidence\n            value: true\n          - kind: relationship\n            relationship: relationship.ada-neri\n            value: trusting`,
      "The watermark identifies a cipher key. Ada decodes the record and gains documentary proof, drawing Neri back toward cooperation.");
    await add("events", "request-testimony", "event",
      `${common}\n  - "Ada confronts the custodian with the seal and obtains witness testimony"\nafter: []\nprerequisites:\n  any_of:\n    - completed: [event.discover-seal]\n      not_completed: [event.decode-ledger]\nsteps:\n  - id: verify\n    branches:\n      - id: testimony\n        conditions: []\n        effects:\n          - kind: revealed\n            revelation: revelation.puzzle-evidence\n            value: true\n          - kind: relationship\n            relationship: relationship.ada-neri\n            value: wary`,
      "The seal gives Ada leverage to question the custodian. The verbal confirmation exposes the concealment but leaves the relationship tense.");
    await add("puzzles", "ledger-proof", "puzzle",
      'objective: "Verify that the ledger hides a concealed entry through documentary decoding or corroborated testimony"\nclues: [authored-content.watermark-clue, authored-content.seal-clue]\nsolutions: [event.decode-ledger, event.request-testimony]',
      "Players can notice a watermark or seal, infer either the cipher key or its custodian, and then choose a method. A mistaken guess yields a comparison prompt, with hints escalating from noticing the mark to matching its source and finally trying the cipher or testimony route.");
    if (variant === "puzzle-weak-custody") {
      // #167 negative: all native reachability/clue gates pass, but one
      // "solution" establishes only custody, not the Puzzle objective.
      await rewrite("events/request-testimony.md", s => s
        .replace("Ada confronts the custodian with the seal and obtains witness testimony",
          "Ada verifies the ledger seal but cannot identify a concealed entry")
        .replace("The seal gives Ada leverage to question the custodian. The verbal confirmation exposes the concealment but leaves the relationship tense.",
          "The custodian authenticates the seal and handling interval, but cannot confirm that any ledger entry was concealed. The relationship remains tense.")
        .replace(/          - kind: revealed\n            revelation: revelation\.puzzle-evidence\n            value: true\n/, ""));
    }
    if (variant === "unreachable-clue") {
      await rewrite("authored-content/watermark-clue.md", s =>
        s.replace("events: [event.discover-mark]", "events: [event.decode-ledger]"));
      await rewrite("authored-content/seal-clue.md", s =>
        s.replace("events: [event.discover-seal]", "events: [event.request-testimony]"));
      // Duplicate modifiedRecords is invalid; the fixture reports unique paths below.
    }
    if (variant === "unverified-solution") {
      await rewrite("events/request-testimony.md", s =>
        s.replace("not_completed: [event.decode-ledger]", "not_completed: [event.decode-ledger]\n      unverified: \"The custodian happens to be willing to testify\""));
    }
  }
  if (variant === "mismatch" && domain === "choice") paths.push("choice-points/not-written.md");
  return { modifiedRecords: [...new Set(paths)], conflicts: [], skillReads: [],
    obligations: variant === "conditional-writing" && domain === "choice"
      ? ["Future Events must consume relationship.ada-neri state (trusting vs wary) as conditional payoffs from the two routes"]
      : variant === "choice-id-obligation" && domain === "choice"
        ? ["Future Events must check choice-point.loyalty outcome for conditional consequences of the two routes"]
        : ["Conditional player-facing prose must be reviewed for choice and clue visibility"] };
}
export async function runInteractiveWorkItem(input: InteractiveOptions) {
  if (!validMilestone.test(input.milestone)) throw new Error("--milestone requires an exact typed Milestone ID.");
  const job = await startStoryJob({ story: input.story, job: input.job }, false);
  const root = job.stateDir;
  const file = join(root, "interactive-items", input.milestone.slice(10) + ".json");
  if (input.action === "inspect" && !existsSync(file)) throw new Error("No interactive work item receipt.");
  // Adaptive admission may request a no-write review from the already locked
  // generation boundary. The probe must never dispatch a specialist writer.
  const execute = async () => {
    if (input.action === "review-omission" && input.unit)
      throw Error("Adaptive omission review applies to a whole interactive assignment.");
    if (input.action === "run") await processAuthorUpdatesAtBoundary(job);
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
        if (!omission) return { status: "omission-not-justified", headSha: head,
          milestoneId: input.milestone };
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
      if (input.action === "review-omission" || !input.fixture ||
          process.env.NT_INTERACTIVE_FIXTURE_CASE === "event-only") {
        if (!input.fixture)
          await assertNativeReviewDependencies(job, "interactive-choice-" + input.milestone.slice(10));
        const head = await trustedHead(job);
        const baseline = reportOf(await validateStoryJob(job, input.validatorSource ??
          input.skillsSource, { ...job, baseSha: head }), head);
        const omission = await decideEventOnlyOmission(job, architecture.plan, baseline,
          input.milestone, event.commitSha, event.validation.eventIds, event.snapshot.id,
          event.obligations ?? [], {
            fixture: !!input.fixture, skillsSource: input.skillsSource,
            provider: input.provider ?? "openai", model: input.model ?? "gpt-6-luna",
            blueprint: await historicalMilestoneHandoff(job, event),
          });
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
            eventHead: event.commitSha, eventSource, worker: input.fixture ? "fixture" : "pi",
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
        eventHead: event.commitSha, eventSource, worker: input.fixture ? "fixture" : "pi",
        provider: input.provider ?? "openai", model: input.model ?? "gpt-6-luna", thinking: input.thinking,
        units: [{ id: "interactive-choice-" + input.milestone.slice(10), domain: "choice", phase: "pending" },
          { id: "interactive-puzzle-" + input.milestone.slice(10), domain: "puzzle", phase: "pending" }] };
      await persist(file, receipt);
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
      if (receipt.units[0].phase === "conflicted")
        await inspectInteractiveConflict(job, input.milestone);
      return output(job, receipt, input.unit);
    }
    if (readRecoveryFork(job) && receipt.units.some(unit => unit.phase === "pending") &&
        receipt.units.every(unit => unit.phase === "pending" && !unit.beforeHead ||
          unit.phase === "committed" && commitOrigin(job, unit.id, unit.commitSha!).jobId !== job.jobId)) {
      receipt.worker = input.fixture ? "fixture" : "pi";
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
    const Channels = Annotation.Root({ receipt: Annotation<Receipt>() });
    const graph = new StateGraph(Channels)
      .addNode("choice_design", async ({ receipt }) => { await executeUnit(receipt.units[0]!, receipt); return { receipt }; })
      .addNode("puzzle_design", async ({ receipt }) => { await executeUnit(receipt.units[1]!, receipt); return { receipt }; })
      .addConditionalEdges(START, () => input.unit === "puzzle" ? "puzzle_design" : "choice_design")
      .addConditionalEdges("choice_design", ({ receipt }) =>
        input.unit === "choice" || receipt.units[0].phase === "conflicted" ? END : "puzzle_design")
      .addEdge("puzzle_design", END).compile();
    async function executeUnit(unit: Unit, state: Receipt) {
      const index = state.units.indexOf(unit);
      if (unit.phase === "pending") await processAuthorUpdatesAtBoundary(job);
      const sourceHead = index ? state.units[0]!.commitSha : state.eventHead;
      const before = unit.beforeHead ?? (unit.phase === "pending" && sourceHead
        ? await verifiedNarrativeSuccessor(job, sourceHead) : sourceHead);
      if (!before) throw new Error("Puzzle specialist is blocked until the Choice work item is committed.");
      if (unit.beforeHead && unit.beforeHead !== before) throw new Error("Interactive unit authority head changed.");
      if (unit.phase === "conflicted") {
        if (unit.domain !== "choice") throw Error("Only Choice has an unresolved no-write contradiction");
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
      if (unit.phase === "writing") {
        throw new Error("Interrupted interactive specialist; inspect the preserved uncommitted Story and Pi transcript.");
      }
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
      const baseline = reportOf(await validate(before), before);
      const selected = selectAssignment(architecture.plan!, baseline, state.milestoneId,
        state.eventSource ?? eventSource, milestoneBlueprint);
      const puzzleDecision = unit.domain === "puzzle"
        ? await puzzleObligation(job, architecture.plan!, baseline.records,
            selected.eventIds, eventSource.missingObligations) : undefined;
      const assign = { ...selected,
        ...(puzzleDecision ? { puzzleObligation: puzzleDecision } : {}),
        ...(input.task ? { authorTask: input.task } : {}) };
      if (unit.phase === "pending") {
        await preflightPiAssignment(job, "interactive:" + assign.workItemId + ":" + unit.domain,
          state.worker === "pi" ? { provider: state.provider, model: state.model, thinking: state.thinking } : undefined);
        unit.phase = "writing";
        unit.beforeHead = before;
        await persist(file, state);
        try {
          const verifyDraft = async (evidence: InteractiveEvidence) => {
            if (unit.domain === "choice" && evidence.modifiedRecords.length === 0) {
              if (!evidence.conflicts.length) throw Error("Choice negative report has no explicit conflict");
              assertHead(job, before);
              if (dirty(job).length)
                throw Error("Negative Choice report disagrees with the actual Story worktree");
              // A truthful claim remains negative until controller review;
              // the author cannot fill the missing Choice with an invented one.
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
                assign.eventIds, eventSource.missingObligations);
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
              if (!feedback) throw new Error("Unresolved interactive architectural conflict: " +
                evidence.conflicts.join("; "));
              // A model's "architectural conflict" label is not a grant.
              // Independently reverify this job, baseline and exact pinned
              // Git protection before returning any in-scope correction.
              await assertSafeInteractiveRepair(job, before, validate);
              return feedback;
            }
            if (report.diagnostics.length) return report.diagnostics.slice(0, 24).map(d =>
              `${d.path}:${d.line ?? 1}:${d.column ?? 1} ${d.code}: ${d.message}`);
            if (checked.status !== "passed") throw new Error("Canonical validator rejected interactive draft without diagnostics.");
            try {
              await checkOutput(job, baseline, report, assign, { ...unit, paths }, evidence.obligations);
              if (unit.domain === "puzzle") verifyChoice(report, state.units[0]!.paths ?? [], assign,
                state.units[0]!.obligations ?? []);
              return [];
            } catch (error) { return [String(error)]; }
          };
          let evidence: InteractiveEvidence;
          if (state.worker === "fixture") {
            evidence = await fixtureAuthor(job, unit.domain, assign);
          } else {
            evidence = await authorInteractive(job, state.snapshot!, unit.domain, assign, state.provider, state.model, state.thinking,
              async session => { unit.piSessionFile = session; await persist(file, state); }, verifyDraft);
          }
          unit.claimedPaths = evidence.modifiedRecords;
          unit.conflicts = evidence.conflicts;
          unit.obligations = evidence.obligations;
          unit.skillReads = evidence.skillReads;
          unit.piSessionFile = evidence.piSessionFile ?? unit.piSessionFile;
          if (unit.domain === "choice" && evidence.modifiedRecords.length === 0) {
            if (!evidence.conflicts.length || !state.snapshot?.id ||
                (state.worker === "pi" && !unit.piSessionFile))
              throw Error("Choice no-write has no original completed worker and pinned assignment");
            assertHead(job, before);
            if (dirty(job).length) throw Error("Choice negative report left Story edits");
            const sessionPath = unit.piSessionFile ? await realpath(unit.piSessionFile) : null;
            const directory = join(job.stateDir, "interactive-sessions", state.workItemId, "choice");
            if (sessionPath && (!sessionPath.startsWith(directory + "/") ||
                unit.piSessionFile !== sessionPath || !sessionPath.endsWith(".jsonl")))
              throw Error("Choice no-write session is outside its original assignment");
            unit.piSessionSha256 = sessionPath ? digest(await readFile(sessionPath)) : undefined;
            unit.paths = [];
            unit.digest = choiceConflictReportDigest(state, unit,
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
              assign.eventIds, eventSource.missingObligations);
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
        // Deterministic fixture seam: model an author message received while
        // Choice was running, before the Puzzle boundary drains it.
        if (state.worker === "fixture" && index === 0 &&
            process.env.NT_TEST_INTERACTIVE_SEND_AFTER_CHOICE) {
          const { runAuthorAction } = await import("./author-updates.js");
          await runAuthorAction({ story: job.storyRoot, job: job.jobId,
            action: "send", file: process.env.NT_TEST_INTERACTIVE_SEND_AFTER_CHOICE });
        }
      } catch (error) {
        unit.failure = String(error);
        await persist(file, state);
        throw error;
      }
    }
    const result = await graph.invoke({ receipt });
    if (result.receipt.units[0].phase === "conflicted") {
      // No next-stage or deferred-idea authorization follows a negative
      // original assignment. The generation controller owns its disposition.
      await inspectInteractiveConflict(job, input.milestone);
      return output(job, result.receipt, input.unit);
    }
    const authorUpdates = await processAuthorUpdatesAfterWork(job);
    const { scheduleIdeasAtBoundary } = await import("./idea-placement.js");
    await scheduleIdeasAtBoundary(job, "interactive-work");
    return { ...output(job, result.receipt, input.unit), authorUpdates };
  };
  if (input.action === "review-omission")
    return withStoryJobLockOrReuse(job, "interactive-" + input.milestone.slice(10),
      ["generation-boundary", "generation-verification", "generation-idea-verification",
        "generation-c06-interactive-supersession"],
      execute);
  return withStoryJobLock(job, "interactive-" + input.milestone.slice(10), execute);
}
