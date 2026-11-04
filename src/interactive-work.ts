import { execFileSync } from "node:child_process";
import { commitOrigin, readRecoveryFork } from "./recovery-fork-state.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { authorInteractive, type InteractiveAssignment, type InteractiveDomain, type InteractiveEvidence } from "./interactive-specialist.js";
import { startStoryJob, type JobStartResult } from "./job.js";
import { trustedHead } from "./revision.js";
import { finalizeRecoveryCheckpoint } from "./recovery-checkpoints.js";
import { verifiedNarrativeSuccessor, verifiedCompositionSuccessor } from "./job-successor.js";
import { withStoryJobLock } from "./job-lock.js";
import { fixtureCluster } from "./fixture-cluster.js";
import { assertPlanContinuity } from "./plan-continuity.js";
import { processAuthorUpdatesAtBoundary, processAuthorUpdatesAfterWork } from "./author-updates.js";
import { loadSkillConfig } from "./skills.js";
import { preflightPiAssignment } from "./job-pi-policy.js";
import { createSkillSnapshot, openSkillSnapshot, type SkillSnapshot } from "./snapshot.js";
import { validateStoryJob, type ValidationResult } from "./validator.js";
import type { Plan } from "./architecture.js";

type Phase = "pending" | "writing" | "authored" | "committed";
interface Unit {
  id: string; domain: InteractiveDomain; phase: Phase;
  beforeHead?: string; commitSha?: string; paths?: string[]; digest?: string;
  claimedPaths?: string[]; piSessionFile?: string; skillReads?: string[];
  conflicts?: string[]; obligations?: string[]; failure?: string;
  validation?: { status: "passed"; validatorSha256: string; protectionBase: string;
    choices: ChoiceEvidence[]; puzzles: PuzzleEvidence[]; downstreamObligations: string[]; searchTruncated: boolean };
}
interface Receipt {
  version: 1; jobId: string; baseSha: string; workItemId: string; milestoneId: string;
  planVersion: number; planDigest: string; eventHead: string; worker: "fixture" | "pi";
  provider: string; model: string; thinking?: "low" | "medium" | "high"; snapshot?: SkillSnapshot; units: [Unit, Unit];
}
interface SourceReceipt {
  jobId: string; phase: string; milestoneId: string; commitSha?: string;
  planVersion: number; workItemId: string;
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
  story: string; job: string; action: "run" | "inspect"; milestone: string;
  skillsSource?: string; validatorSource?: string; fixture?: boolean; provider?: string; model?: string; thinking?: "low" | "medium" | "high";
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
function selectAssignment(plan: Plan, report: Report, milestoneId: string): InteractiveAssignment {
  if (plan.contract.scope.depth === "architecture") throw new Error("Completion contract does not authorize interactive work.");
  const architecture = plan.items.find(i => i.id === "global-architecture");
  if (architecture?.status !== "verified" || !architecture.targetIds.includes(milestoneId)) {
    throw new Error("Milestone is outside the verified architecture scope.");
  }
  const records = report.records.filter(r => r.metadata.status !== "superseded");
  const milestone = records.find(r => r.metadata.id === milestoneId && r.metadata.type === "milestone");
  if (!milestone || !milestone.metadata.fulfillment?.any_of?.length ||
      !report.coverage.milestoneRoutes.find(r => r.id === milestoneId)?.routes.some(r => r.status === "reachable")) {
    throw new Error("Interactive design requires a fulfilled, reachable Event-design Milestone.");
  }
  const arcIds = milestone.metadata.arcs as string[];
  if (!arcIds.length || arcIds.some(id => !architecture.targetIds.includes(id))) {
    throw new Error("Milestone references an unauthorized Arc.");
  }
  const eventIds = (milestone.metadata.fulfillment.any_of as string[][]).flat();
  const adjacent = records.filter(r => r.metadata.type === "event" &&
    (r.metadata.arcs as string[]).some(id => arcIds.includes(id)));
  const characters = records.filter(r => r.metadata.type === "arc" && arcIds.includes(r.metadata.id))
    .flatMap(r => r.metadata.characters as string[]);
  const characterIds = [...new Set(characters)].sort();
  if (characterIds.length < 2 || !eventIds.length) throw new Error("Missing Character/World/Event foundations.");
  const references = new Set<string>([...characterIds, ...eventIds, ...arcIds]);
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
    eventIds: [...new Set(adjacent.map(r => r.metadata.id))].sort(),
    sourcePaths: [...new Set(related.map(r => r.path))].sort(),
    authorContract: plan.contract, protectedRouteGates: "immutable-existing-event-prerequisites",
    authorizedPaths: ["events/", "choice-points/", "puzzles/", "authored-content/", "revelations/", "facts/", "relationships/", "narrative-positions/"],
    downstreamRequirements: ["Player-perceivable branch effects", "Later conditional payoff or explicit writing obligations",
      "Independent clue text/fairness and presentation review"] };
}
/** A tracked, unstaged change to an assignment's read-only source may be
 * repaired by the same Pi session. It is never authorized for publication. */
export class RepairableInteractiveScopeError extends Error {
  constructor(readonly paths: string[]) {
    super("Unauthorized interactive specialist file(s): " + paths.join(", "));
  }
}
function prerequisitesText(text: string) {
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
          throw new Error("Original Event prerequisite route gate was changed or bypassed: " + local);
        }
      }
    }
    paths.push(local);
  }
  if (readOnlyEdits.length) throw new RepairableInteractiveScopeError(readOnlyEdits.sort());
  paths.sort();
  if (!paths.length || claimed.length !== paths.length ||
      JSON.stringify([...new Set(claimed)].sort()) !== JSON.stringify(paths)) {
    throw new Error("Interactive specialist manifest differs from actual Git files: " +
      JSON.stringify({ actual: paths, claimed }));
  }
  if (!paths.some(path => path.startsWith(domain === "choice" ? "choice-points/" : "puzzles/"))) {
    throw new Error("Interactive specialist must author its assigned Choice Point/Puzzle.");
  }
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
/** Only offer repair when the job identity and pinned Git protection prove
 * the out-of-scope edit did not alter protected author decisions. Nothing is
 * reverted or authorized by the graph on the agent's behalf. */
export async function scopeRepairFeedback(job: JobStartResult, before: string, error: unknown,
  validate: (head: string) => Promise<ValidationResult>): Promise<string[] | undefined> {
  if (!(error instanceof RepairableInteractiveScopeError)) return undefined;
  await assertSafeInteractiveRepair(job, before, validate);
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
  if (!nowMilestone?.routes.some(r => r.status === "reachable")) {
    throw new Error("The previously fulfilled Milestone lost all reachable routes.");
  }
  if (oldMilestone && oldMilestone.routes.some(r => r.status === "reachable") &&
      !nowMilestone.routes.some(r => r.status === "reachable")) {
    throw new Error("Interactive edits destroyed a verified Milestone path.");
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
  const choiceRecords = records.filter(r => r.metadata.type === "choice-point" && paths.includes(r.path));
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
      const effects = [...witness.effects.filter(e => e.kind !== "outcome"),
        ...conditionalNextSteps.flatMap(b => b.effects.filter(e => e.kind !== "outcome"))];
      if (!effects.length) {
        throw new Error("Choice outcome lacks a consequential typed effect at selection or in a later conditional step: " +
          record.metadata.id + "/" + outcome);
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
          record.metadata.id + "/" + outcome);
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
function verifyPuzzle(report: Report, paths: string[]): PuzzleEvidence[] {
  const records = report.records.filter(r => r.metadata.status !== "superseded");
  const authored = records.filter(r => r.metadata.type === "puzzle" && paths.includes(r.path));
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
    if (eventRecords.filter(e => paths.includes(e!.path)).length < 2 ||
        clueIds.filter(id => paths.includes(byId.get(id)!.path)).length < 2) {
      throw new Error("Puzzle work item must actually author two solution Events and two pre-solution clue records.");
    }
    if (new Set(eventRecords.map(e => JSON.stringify({ consequences: e!.metadata.consequences,
      steps: e!.metadata.steps }))).size < 2) {
      throw new Error("Alternative Puzzle solution Events must have distinct narrative consequences.");
    }
    return { id: record.metadata.id, solutions: proof.solutions.map(s => ({
      event: s.event, status: s.status, clueAccess: s.clueAccess.status, clueIds: s.clueAccess.availableClues,
    })) };
  });
}
async function checkOutput(job: JobStartResult, previous: Report, report: Report, assign: InteractiveAssignment,
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
    if (!choices.some(choice => choice.outcomes.some(outcome => unit.paths!.some(path =>
      report.records.some(r => r.path === path && r.metadata.id === outcome.event))))) {
      throw new Error("Choice specialist did not modify an Event that actually selects a Choice outcome.");
    }
    return { choices, puzzles: [] };
  }
  return { choices: [], puzzles: verifyPuzzle(report, unit.paths) };
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
function output(job: JobStartResult, receipt: Receipt) {
  return { status: receipt.units.every(u => u.phase === "committed") ? "interactive-slice-committed" : "in-progress",
    jobId: job.jobId, milestoneId: receipt.milestoneId,
    worktreeStoryRoot: job.worktreeStoryRoot, headSha: receipt.units[1].commitSha ??
      receipt.units[0].commitSha ?? receipt.eventHead,
    eventHead: receipt.eventHead, workItemId: receipt.workItemId, planVersion: receipt.planVersion,
    thinking: receipt.thinking ?? "configured-default",
    specialistUnits: receipt.units.map(u => ({ ...u, specialist: u.domain === "choice"
      ? "nt-interactive-narrative" : "nt-puzzle-design" })),
    completionEvidence: { deterministicChoiceAndPuzzlePaths: receipt.units.every(u => u.phase === "committed"),
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
  if (domain === "choice") {
    await add("choice-points", "loyalty", "choice-point",
      'prompt: "Protect Neri or challenge the concealment?"\noutcomes: [protect, challenge]',
      "Protecting the friend preserves intimacy, while challenging the concealment risks the friendship in exchange for accountability.");
    await add("revelations", "ledger-secret", "revelation",
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
        `steps:\n` + (leak ? `  - id: premature\n    branches:\n      - id: shared\n        conditions: []\n        effects:\n          - kind: revealed\n            revelation: revelation.ledger-secret\n            value: true\n` : "") + `  - id: admit\n    branches:\n      - id: disclose\n        conditions: []\n        effects:\n          - kind: outcome\n            choice_point: choice-point.loyalty\n            value: protect\n          - kind: relationship\n            relationship: relationship.ada-neri\n            value: trusting\n          - kind: knowledge\n            character: character.ada\n            fact: fact.evidence-concealed\n            value: knows` +
        `\n      - id: challenge\n        conditions: []\n        effects:\n          - kind: outcome\n            choice_point: choice-point.loyalty\n            value: challenge\n          - kind: relationship\n            relationship: relationship.ada-neri\n            value: wary\n          - kind: knowledge\n            character: character.ada\n            fact: fact.evidence-concealed\n            value: knows\n          - kind: revealed\n            revelation: revelation.ledger-secret\n            value: true` +
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
        text.slice(end);
    });
    if (!["conditional-writing", "choice-id-obligation", "unpaid-choice", "same-event-payoff"].includes(variant)) await add("events", "aftermath", "event",
      `participants: [character.ada, character.neri]\narcs: [${arc}]\nconsequences: ["A choice changes how Ada and Neri collaborate afterward"]\nafter: []\nprerequisites:\n  any_of:\n    - completed: [${cluster.text("event.disclose-ledger")}]\n      not_completed: []\nsteps:\n  - id: consequence\n    branches:\n      - id: protect-response\n        conditions:\n          - kind: outcome\n            choice_point: choice-point.loyalty\n            value: protect\n        effects:\n          - kind: relationship\n            relationship: relationship.ada-neri\n            value: trusting\n      - id: challenge-response\n        conditions:\n          - kind: outcome\n            choice_point: choice-point.loyalty\n            value: challenge\n        effects:\n          - kind: relationship\n            relationship: relationship.ada-neri\n            value: estranged`,
      "If Ada protects Neri, they continue investigating as trusted collaborators. If she challenges Neri, the confrontation leaves their alliance damaged.");
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
      'objective: "Prove who concealed the ledger record"\nclues: [authored-content.watermark-clue, authored-content.seal-clue]\nsolutions: [event.decode-ledger, event.request-testimony]',
      "Players can notice a watermark or seal, infer either the cipher key or its custodian, and then choose a method. A mistaken guess yields a comparison prompt, with hints escalating from noticing the mark to matching its source and finally trying the cipher or testimony route.");
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
  return withStoryJobLock(job, "interactive-" + input.milestone.slice(10), async () => {
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
    if (!git(job, "log", "-1", "--format=%B", event.commitSha)
      .includes("NovelTea-Work-Item: " + event.workItemId + "\n")) {
      throw new Error("Source Event-design commit does not match its verified work-item provenance.");
    }
    try { git(job, "merge-base", "--is-ancestor", event.commitSha, "HEAD"); }
    catch { throw new Error("Story branch has diverged from the committed Event-design stage."); }
    const planDigest = digest(JSON.stringify(architecture.plan));
    let receipt: Receipt;
    if (existsSync(file)) {
      receipt = JSON.parse(await readFile(file, "utf8")) as Receipt;
      if (receipt.version !== 1 || receipt.jobId !== job.jobId || receipt.baseSha !== job.baseSha ||
          receipt.milestoneId !== input.milestone || receipt.eventHead !== event.commitSha ||
          receipt.units?.length !== 2 || receipt.units[0]?.domain !== "choice" ||
          receipt.units[1]?.domain !== "puzzle") {
        throw new Error("Interactive receipt differs from the verified Story plan and Event foundation.");
      }
      assertPlanContinuity(job, architecture, "interactive:" + input.milestone,
        receipt.planVersion, receipt.planDigest);
    } else {
      if (input.action !== "run") throw new Error("No saved interactive work item.");
      if (dirty(job).length) throw new Error("Interactive design requires a clean verified Story worktree.");
      await verifiedNarrativeSuccessor(job, event.commitSha);
      receipt = { version: 1, jobId: job.jobId, baseSha: job.baseSha,
        workItemId: "interactive-" + input.milestone.slice(10),
        milestoneId: input.milestone, planVersion: architecture.plan.version, planDigest,
        eventHead: event.commitSha, worker: input.fixture ? "fixture" : "pi",
        provider: input.provider ?? "openai", model: input.model ?? "gpt-6-luna", thinking: input.thinking,
        units: [{ id: "interactive-choice-" + input.milestone.slice(10), domain: "choice", phase: "pending" },
          { id: "interactive-puzzle-" + input.milestone.slice(10), domain: "puzzle", phase: "pending" }] };
      await persist(file, receipt);
    }
    if (input.action === "inspect") return output(job, receipt);
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
      .addEdge(START, "choice_design").addEdge("choice_design", "puzzle_design")
      .addEdge("puzzle_design", END).compile();
    async function executeUnit(unit: Unit, state: Receipt) {
      const index = state.units.indexOf(unit);
      if (unit.phase === "pending") await processAuthorUpdatesAtBoundary(job);
      const sourceHead = index ? state.units[0]!.commitSha : state.eventHead;
      const before = unit.beforeHead ?? (unit.phase === "pending" && sourceHead
        ? await verifiedNarrativeSuccessor(job, sourceHead) : sourceHead);
      if (!before) throw new Error("Puzzle specialist is blocked until the Choice work item is committed.");
      if (unit.beforeHead && unit.beforeHead !== before) throw new Error("Interactive unit authority head changed.");
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
            if (!state.units.every(saved => saved.phase === "committed")) throw error;
            await verifiedCompositionSuccessor(job, state.milestoneId, state.units[1]!.commitSha!);
          }
        }
        if (current === unit.commitSha) await publishHead(job, before, unit.commitSha, unit.id);
        return;
      }
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
      const assign = selectAssignment(architecture.plan!, baseline, state.milestoneId);
      if (unit.phase === "pending") {
        await preflightPiAssignment(job, "interactive:" + assign.workItemId + ":" + unit.domain,
          state.worker === "pi" ? { provider: state.provider, model: state.model, thinking: state.thinking } : undefined);
        unit.phase = "writing";
        unit.beforeHead = before;
        await persist(file, state);
        try {
          const verifyDraft = async (evidence: InteractiveEvidence) => {
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
            if (evidence.conflicts.length) throw new Error("Unresolved interactive architectural conflict: " + evidence.conflicts.join("; "));
            const checked = await validate(before);
            const report = checked.report as unknown as Report | undefined;
            if (report?.protection?.status !== "checked" || report.protection.changes.length ||
                report.protection.warnings.length) {
              throw new Error("Interactive draft has protected/unverified changes; no automatic retcon allowed.");
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
        unit.validation = { status: "passed", validatorSha256: checked.validator.sha256,
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
    const authorUpdates = await processAuthorUpdatesAfterWork(job);
    const { scheduleIdeasAtBoundary } = await import("./idea-placement.js");
    await scheduleIdeasAtBoundary(job, "interactive-work");
    return { ...output(job, result.receipt), authorUpdates };
  });
}
