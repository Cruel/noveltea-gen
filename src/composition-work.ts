import { execFileSync } from "./git-read-cache.js";
import { commitOrigin } from "./recovery-fork-state.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { assignmentCommittedEffect, type AssignmentDiagnosticAuthorization, assignmentDraftEffect, nativeMetadataDefects, verifySettledAssignment, inspectAssignmentFailure, type AssignmentInvocationProof, type AssignmentRoundCommand, type AssignmentRoundResult } from "./assignment-metadata-recovery.js";
import { authorComposition, compositionInvocationDirectory, createCompositionReviewCycle, verifyCompositionReviewPin,
  type CompositionReviewPin, type CompositionAssignment,
  type CompositionEvidence, type SemanticReview } from "./composition-specialist.js";
import { startStoryJob, type JobStartResult } from "./job.js";
import { trustedHead } from "./revision.js";
import { finalizeRecoveryCheckpoint } from "./recovery-checkpoints.js";
import { verifiedNarrativeSuccessor, verifiedNarrativeChain } from "./job-successor.js";
import { withStoryJobLock } from "./job-lock.js";
import { assertPlanContinuity } from "./plan-continuity.js";
import { processAuthorUpdatesAtBoundary, processAuthorUpdatesAfterWork } from "./author-updates.js";
import { loadSkillConfig } from "./skills.js";
import { preflightPiAssignment } from "./job-pi-policy.js";
import { createSkillSnapshot, openSkillSnapshot, type SkillSnapshot } from "./snapshot.js";
import { validateStoryJob, type ValidationResult } from "./validator.js";
import type { Plan } from "./architecture.js";
import { reviewedMilestoneHandoff, consumedCorrection, assertMilestoneInteractiveDisposition,
  type ReviewedMilestoneHandoff } from "./milestone-obligation-handoff.js";
import type { MilestoneBlueprintPin } from "./milestone-blueprint.js";
import type { EventAssignment } from "./event-specialist.js";
import { puzzleObligation, readPuzzleNoWrite,
  type PuzzleNoWriteRef } from "./puzzle-obligation.js";
import { readEventOnlyOmission, type EventOnlyRef } from "./interactive-event-only.js";

interface RecordItem { path: string; metadata: Record<string, any> & { id: string; type: string; status: string } }
interface Report {
  records: RecordItem[];
  diagnostics: Array<{ path: string; line?: number; column?: number; code: string; message: string }>;
  protection: { status: string; base: string; changes: unknown[]; warnings: unknown[] };
  coverage: { search: { truncated: boolean };
    eventProgress: Array<{ id: string; status: string; witness?: string[] }>;
    branchProgress: Array<{ event: string; step: string; branch: string; status: string; witness?: string[] }>;
    milestoneRoutes: Array<{ id: string; routes: Array<{ status: string }> }>;
    puzzleSolutions: Array<{ id: string; solutions: Array<{ event: string; status: string;
      clueAccess: { status: string } }> }> };
}
interface EventSourceReceipt {
  jobId: string; milestoneId: string; phase: string; paths?: string[]; commitSha?: string;
  snapshot?: SkillSnapshot; validation?: { status: string; eventIds: string[];
    milestoneState?: "complete" | "partial-choice-pending" };
  blueprintRequired?: boolean; blueprintPin?: MilestoneBlueprintPin;
  assignment?: EventAssignment;
}
interface InteractiveReceipt {
  correctedBlueprintPin?: MilestoneBlueprintPin;
  jobId: string; milestoneId: string; planVersion: number; planDigest: string;
  eventHead?: string; baseSha?: string; worker?: string; provider?: string; model?: string;
  snapshot?: SkillSnapshot; eventSource?: { eventIds: string[]; missingObligations: string[] };
  units: Array<{ id: string; phase: string; commitSha?: string; beforeHead?: string;
    digest?: string; paths?: string[]; claimedPaths?: string[]; noWrite?: PuzzleNoWriteRef;
    eventOnly?: EventOnlyRef;
    conflicts?: string[]; obligations?: string[]; skillReads?: string[]; piSessionFile?: string;
    validation?: { choices?: Array<{ id: string; outcomes: Array<{ name: string; event: string; step: string; branch: string }> }>;
      puzzles?: Array<{ id: string; solutions: Array<{ event: string; status: string; clueAccess: string }> }> } }>;
}
interface ArchReceipt { jobId: string; phase: string; plan?: Plan }
interface ReviewEvidence { status: "passed"; outcomes: string[]; solutions: string[];
  sourceEvidence: string[]; reviewer: "independent-pi" | "fixture-structural-only"; sessionFile?: string }
interface Receipt {
  correctedBlueprintPin?: MilestoneBlueprintPin;
  version: 1; jobId: string; baseSha: string; milestoneId: string; workItemId: string;
  planVersion: number; planDigest: string; interactiveHead: string;
  worker: "fixture" | "pi"; provider: string; model: string; thinking?: "low" | "high";
  snapshot?: SkillSnapshot; phase: "pending" | "writing" | "authored" | "committed";
  beforeHead?: string; paths?: string[]; claimedPaths?: string[]; digest?: string;
  commitSha?: string; sessionFile?: string; writerSessionId?: string; reviewSessionFile?: string;
  reviewedDigest?: string; reviewedEvidence?: SemanticReview; reviewPin?: CompositionReviewPin;
  assignmentKey?: string;
  invocationSource?: string; invocationAssignment?: CompositionAssignment; invocationProof?: AssignmentInvocationProof;
  invocationBaseline?: Report;
  authorTask?: string;
  skillReads?: string[]; obligations?: string[]; conflicts?: string[]; failure?: string;
  validation?: { protectionBase: string; validatorVersion: string; branchReview: ReviewEvidence;
    eventCoverage: Array<{ id: string; witness: string[] }> };
}
export interface CompositionOptions {
  story: string; job: string; action: "run" | "inspect"; milestone: string;
  skillsSource?: string; validatorSource?: string; fixture?: boolean;
  provider?: string; model?: string; task?: string; thinking?: "low" | "high";
  round?: { assignmentKey: string; command: AssignmentRoundCommand; publish?: true };
}
const milestonePattern = /^milestone\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
function compositionInvocationSource(job: JobStartResult, receipt: Receipt) {
  return hash(JSON.stringify({ job: job.jobId, thread: job.threadId, base: receipt.baseSha,
    workItem: receipt.workItemId, assignmentKey: receipt.assignmentKey, head: receipt.beforeHead, interactiveHead: receipt.interactiveHead,
    planVersion: receipt.planVersion, plan: receipt.planDigest, assignment: receipt.invocationAssignment,
    baseline: receipt.invocationBaseline,
    snapshot: receipt.snapshot?.id, provider: receipt.provider, model: receipt.model, thinking: receipt.thinking }));
}
function compositionInvocationOptions(job: JobStartResult, receipt: Receipt) {
  if (!receipt.assignmentKey || !receipt.invocationSource || receipt.invocationSource !== compositionInvocationSource(job, receipt) ||
      !receipt.sessionFile || !receipt.writerSessionId)
    throw Error("Composition invocation receipt lost its original source or session");
  return { directory: compositionInvocationDirectory(job, receipt.workItemId, receipt.writerSessionId, receipt.invocationSource),
    sourceDigest: receipt.invocationSource, sessionId: receipt.writerSessionId, sessionFile: receipt.sessionFile,
    sessionRoots: [join(job.stateDir, "composition-sessions", receipt.workItemId, "write")] };
}
export async function inspectPendingCompositionInvocation(job: JobStartResult, milestone: string, sourceHead?: string) {
  if (!milestonePattern.test(milestone)) return null;
  const path = join(job.stateDir, "composition-items", milestone.slice(10) + ".json");
  if (!existsSync(path)) return null;
  const r = JSON.parse(await readFile(path, "utf8")) as Receipt;
  if (!["writing", "authored", "committed"].includes(r.phase) || !r.beforeHead ||
      sourceHead && r.beforeHead !== sourceHead) return null;
  if (r.jobId !== job.jobId || r.baseSha !== job.baseSha || r.milestoneId !== milestone ||
      r.workItemId !== "composition-" + milestone.slice(10)) throw Error("Composition pending receipt identity changed");
  if (r.worker === "pi") {
    if (!r.assignmentKey || !r.invocationAssignment || !r.invocationBaseline || !r.snapshot ||
        r.invocationSource !== compositionInvocationSource(job, r) ||
        await openSkillSnapshot(r.snapshot.id) !== r.snapshot.path)
      throw Error("Original Composition invocation source changed");
    if (r.sessionFile || r.writerSessionId) {
      const options = compositionInvocationOptions(job, r);
      if (!options.sessionFile.startsWith(options.sessionRoots[0]! + "/") ||
          await realpath(options.sessionFile) !== options.sessionFile ||
          !(await lstat(options.sessionFile)).isFile())
        throw Error("Original Composition session is unsafe");
    } else if (changes(job).length || r.phase !== "writing") throw Error("Original Composition draft lacks a session");
  }
  const head = git(job, "rev-parse", "HEAD");
  if (head === r.beforeHead) await assignmentDraftEffect(job, head);
  else {
    if (!["authored", "committed"].includes(r.phase) || changes(job).length ||
        !r.paths || await fileDigest(job, r.paths) !== r.digest)
      return null;
    verifyCommit(job, r, head);
    if (r.worker === "pi") {
      if (!r.invocationProof) throw Error("Original Composition commit lacks settled writer proof");
      await verifySettledAssignment({ ...compositionInvocationOptions(job, r), proof: r.invocationProof, effect: r.digest! });
      if (!r.reviewPin || !r.reviewedEvidence || r.reviewedDigest !== r.digest)
        throw Error("Original Composition commit lacks its independent editorial proof");
      const verdict = await verifyCompositionReviewPin(job, r.snapshot!, r.invocationAssignment!, r.provider, r.model,
        r.beforeHead, r.planVersion, r.planDigest, { id: r.writerSessionId!, file: r.sessionFile! }, r.paths, r.reviewPin);
      assertCompositionReviewerMatch(verdict, r.reviewedEvidence);
    }
  }
  return r;
}
/** Authenticate the original writer and precommit review against the immutable
 * Git commit, even after the original writer appends a repair turn. */
export async function verifyCompositionReviewOrigin(job: JobStartResult, point: {
  workItem: string; commitSha: string; parentSha: string; planVersion: number | null;
  assurance?: { changedPaths: string[] } | null;
}) {
  const r = JSON.parse(await readFile(join(job.stateDir, "composition-items", point.workItem.slice(12) + ".json"), "utf8")) as Receipt;
  if (r.jobId !== job.jobId || r.baseSha !== job.baseSha || r.worker !== "pi" ||
      r.workItemId !== point.workItem || r.phase !== "committed" || r.commitSha !== point.commitSha ||
      r.beforeHead !== point.parentSha || r.planVersion !== point.planVersion ||
      !r.paths || !r.digest || !r.invocationProof || !r.invocationAssignment || !r.snapshot ||
      !r.reviewPin || !r.reviewedEvidence || r.reviewedDigest !== r.digest ||
      !isDeepStrictEqual([...r.paths].sort(), [...(point.assurance?.changedPaths ?? [])].sort()) ||
      await openSkillSnapshot(r.snapshot.id) !== r.snapshot.path)
    throw Error("Review repair lost its original Composition receipt");
  verifyCommit(job, r, point.commitSha);
  const sources = Object.fromEntries(r.paths.map(path => [path, rawGit(job, "show", point.commitSha + ":" + repoPath(job, path))]));
  if (hash(JSON.stringify(r.paths.map(path => [path, hash(sources[path]!)]))) !== r.digest)
    throw Error("Original Composition commit bytes changed");
  await verifySettledAssignment({ ...compositionInvocationOptions(job, r), proof: r.invocationProof,
    effect: r.digest, historical: true });
  const verdict = await verifyCompositionReviewPin(job, r.snapshot, r.invocationAssignment, r.provider, r.model,
    r.beforeHead, r.planVersion, r.planDigest, { id: r.writerSessionId!, file: r.sessionFile! },
    r.paths, r.reviewPin, sources);
  if (verdict.sessionFile !== r.reviewSessionFile) throw Error("Original Composition reviewer identity changed");
  assertCompositionReviewerMatch(verdict, r.reviewedEvidence);
}
export async function inspectCompositionFailure(job: JobStartResult, milestone: string, sourceHead: string,
  diagnostic?: AssignmentDiagnosticAuthorization, historicalHead?: string) {
  if (!milestonePattern.test(milestone)) return null;
  const receipt = JSON.parse(await readFile(join(job.stateDir, "composition-items", milestone.slice(10) + ".json"), "utf8")) as Receipt;
  if (receipt.jobId !== job.jobId || receipt.milestoneId !== milestone ||
      receipt.workItemId !== "composition-" + milestone.slice(10) || receipt.beforeHead !== sourceHead ||
      (!diagnostic ? receipt.phase !== "writing" : !["writing", "authored", "committed"].includes(receipt.phase)) ||
      receipt.worker !== "pi" || !receipt.assignmentKey) return null;
  const options = compositionInvocationOptions(job, receipt);
  const head = historicalHead ?? git(job, "rev-parse", "HEAD");
  let effect: string | null;
  if (head === sourceHead && !historicalHead) {
    if (!await inspectPendingCompositionInvocation(job, milestone, sourceHead)) return null;
    effect = await assignmentDraftEffect(job, sourceHead);
  } else {
    if (!diagnostic || !receipt.paths || !receipt.digest || !receipt.invocationProof ||
        (receipt.phase !== "authored" && receipt.phase !== "committed") ||
        (historicalHead && (receipt.phase !== "committed" || receipt.commitSha !== head))) return null;
    verifyCommit(job, receipt, head);
    effect = assignmentCommittedEffect(job, sourceHead, head, receipt.paths, receipt.digest);
    if (!historicalHead && !await inspectPendingCompositionInvocation(job, milestone, sourceHead)) return null;
    await verifySettledAssignment({ ...options, proof: receipt.invocationProof, effect, historical: !!historicalHead });
  }
  const terminal = await inspectAssignmentFailure({ ...options, effect, diagnostic });
  return terminal && { ...terminal, ref: options.directory + "/terminal.json", workItem: receipt.workItemId,
    assignmentKey: receipt.assignmentKey, invocationProof: receipt.invocationProof, sessionId: receipt.writerSessionId! };
}
/** The publication gate compares sealed semantic fields, not JSON key insertion order. */
export function assertCompositionReviewerMatch(verified: SemanticReview,
  copied: SemanticReview | undefined): void {
  if (!copied || !isDeepStrictEqual(verified, copied))
    throw Error("Composition copied reviewer receipt differs from its sealed independent verdict.");
}
function rawGit(job: JobStartResult, ...args: string[]) {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[key];
  return execFileSync("git", args, { cwd: job.worktreeRoot, env, encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}
const git = (job: JobStartResult, ...args: string[]) => rawGit(job, ...args).trim();
// Porcelain XY status is position-sensitive: trimming would turn " M" into "M"
// and misclassify an authorized unstaged edit as a staged change.
const changes = (job: JobStartResult) =>
  rawGit(job, "status", "--porcelain=v1", "--untracked-files=all", "-z").split("\0").filter(Boolean);
const repoPath = (job: JobStartResult, path: string) =>
  job.storyRelativePath ? job.storyRelativePath + "/" + path : path;
async function save(file: string, data: unknown) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = file + "." + randomUUID() + ".tmp";
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await rename(tmp, file);
}
function assertHead(job: JobStartResult, head: string) {
  if (git(job, "rev-parse", "HEAD") !== head || git(job, "symbolic-ref", "--short", "HEAD") !== job.branch)
    throw new Error("Composition Story branch or verified head changed.");
}
function verified(result: ValidationResult, base: string): Report {
  const r = result.report as unknown as Report | undefined;
  if (result.status !== "passed" || !r || r.diagnostics?.length ||
      !Array.isArray(r.records) || r.protection?.status !== "checked" ||
      r.protection.base !== base || r.protection.changes.length ||
      r.protection.warnings.length || r.coverage?.search?.truncated ||
      !Array.isArray(r.coverage?.branchProgress))
    throw new Error("Composition validator/protection/coverage failed against verified " + base + ": " +
      JSON.stringify(result).slice(0, 7500));
  return r;
}
/** A model's claim that optional testimony needs a new Event is not itself
 * an architectural blocker to an already independently reviewed Event-only
 * Milestone. Keep the writer in the same bounded repair loop, and let the
 * independent editorial reviewer audit what was actually written. This never
 * accepts unearned dialogue, waives validation, or authorizes an Event edit.
 */
export function optionalDialogueDeferralFeedback(
  assignment: Pick<CompositionAssignment, "eventOnly">,
  conflicts: readonly string[],
): string | null {
  if (!assignment.eventOnly || !conflicts.length || conflicts.length > 2 ||
      conflicts.some(text => !/\b(?:optional|voluntary|willing|testimony|conversation|refus\w*|withdraw\w*)\b/i.test(text) ||
        !/\b(?:branch\w*|routes?|effects?|unwritten|unbound|not (?:implemented|declared)|missing)\b/i.test(text) ||
        /\b(?:author.protected|protected canon|unreachable|impossible|retcon|contradiction|required testimony|mandatory testimony|required witness account|mandatory witness account)\b/i.test(text)))
    return null;
  return "EVENT_ONLY_OPTIONAL_DIALOGUE: This is a reviewed Event-only Milestone. " +
    "A merely POSSIBLE witness account, consent, refusal or withdrawal mentioned in " +
    "the Event body is not a typed, enacted local outcome. Re-read the verified " +
    "Event steps and the selected Milestone. Complete only the mandatory playable " +
    "action, independent evidence, and unpressured dialogue OFFER in this Event. " +
    "Do not impersonate consent, testimony, trust, refusal, withdrawal or publication. " +
    "If the OPTIONAL account requires a separately authorized conditional Event, " +
    "put the exact missing routing/effects in laterObligations, NOT architecturalConflicts. " +
    "Do not erase an actual local required or protected narrative conflict: if " +
    "this Milestone cannot be fulfilled without the missing branch, keep the " +
    "architecturalConflict. Native structural checks and independent editorial " +
    "review will reject any unearned prose. SOURCE CONCERNS: " +
    JSON.stringify(conflicts).slice(0, 2200);
}
export function selectAssignment(plan: Plan, r: Report, source: InteractiveReceipt,
  eventSource: EventSourceReceipt, milestoneId: string,
  milestoneBlueprint?: ReviewedMilestoneHandoff): CompositionAssignment {
  const arch = plan.items.find(i => i.id === "global-architecture");
  if (plan.contract.scope.depth !== "composition" || arch?.status !== "verified" ||
      !arch.targetIds.includes(milestoneId)) throw new Error("Scope does not authorize composition.");
  const records = r.records.filter(record => record.metadata.status !== "superseded");
  const milestone = records.find(record => record.metadata.id === milestoneId);
  if (!milestone) throw new Error("Missing planned Milestone.");
  const arcs: string[] = milestone.metadata.arcs;
  const ownedPaths = new Set([...(eventSource.paths ?? []), ...source.units.flatMap(unit => unit.paths ?? [])]);
  const fulfillment = (milestone.metadata.fulfillment?.any_of as string[][] | undefined)?.flat() ?? [];
  const eventRecords = records.filter(record => record.metadata.type === "event" &&
    (ownedPaths.has(record.path) || fulfillment.includes(record.metadata.id)));
  const eventIds = eventRecords.map(record => record.metadata.id);
  const choices = source.units[0]?.validation?.choices ?? [];
  const puzzles = source.units[1]?.validation?.puzzles ?? [];
  // A newly published formal interaction linked to these Events invalidates
  // the old no-write premise. Composition must not silently bypass it.
  if (source.units[0]?.eventOnly && records.some(record =>
      record.metadata.type === "choice-point" &&
        (record.metadata.events as string[] ?? []).some(id => eventIds.includes(id)) ||
      record.metadata.type === "puzzle" &&
        (record.metadata.solutions as string[] ?? []).some(id => eventIds.includes(id))))
    throw Error("Event-only omission is stale: a linked Choice or Puzzle now requires interactive review.");
  if ((!choices.length && !source.units[0]?.eventOnly) ||
      (!puzzles.length && source.units[1]?.phase !== "not-applicable"))
    throw new Error("Interactive source lacks proven Choice or required Puzzle evidence.");
  const choicePoints = choices.map(c => {
    const record = records.find(x => x.metadata.type === "choice-point" && x.metadata.id === c.id);
    const outcomes = record?.metadata.outcomes as string[] | undefined;
    if (!outcomes?.length || outcomes.length !== c.outcomes.length ||
        c.outcomes.some(o => !outcomes.includes(o.name) || !eventIds.includes(o.event) ||
          !r.coverage.branchProgress.some(b => b.event === o.event && b.step === o.step &&
            b.branch === o.branch && b.status === "reachable")))
      throw new Error("Choice witnesses are absent or not reachable: " + c.id);
    return { id: c.id, outcomes: [...outcomes], events: [...new Set(c.outcomes.map(o => o.event))] };
  });
  const puzzleSolutions = puzzles.map(p => {
    const record = records.find(x => x.metadata.type === "puzzle" && x.metadata.id === p.id);
    const solutions = record?.metadata.solutions as string[] | undefined;
    if (!solutions || solutions.length < 2 || solutions.some(id =>
        !eventIds.includes(id) || !p.solutions.some(s => s.event === id && s.status === "reachable" &&
          s.clueAccess === "reachable") ||
        !r.coverage.puzzleSolutions.find(q => q.id === p.id)?.solutions.some(s =>
          s.event === id && s.status === "reachable" && s.clueAccess.status === "reachable")))
      throw new Error("Puzzle solution/clue witness missing or unverified: " + p.id);
    return { id: p.id, eventIds: [...solutions] };
  });
  // All linked Events need player-facing coverage, including later conditional
  // payoffs. Existing Puzzle clue content already realizes discovery Events.
  const requiredSources = [...new Set(eventIds)].sort();
  const consequential = new Set([...choicePoints.flatMap(c => c.events),
    ...puzzleSolutions.flatMap(p => p.eventIds)]);
  const composeTargets = requiredSources.filter(id => consequential.has(id) ||
    (eventRecords.find(x => x.metadata.id === id)?.metadata.steps as Array<{
      branches: Array<{ conditions: Array<{ kind: string; value?: string }> }>
    }> ?? []).some(step => step.branches.some(branch =>
      branch.conditions.some(condition => condition.kind === "outcome"))) ||
    !records.some(x => x.metadata.type === "authored-content" &&
      (x.metadata.events as string[]).includes(id)));
  const clues = new Set(records.filter(x => x.metadata.type === "puzzle")
    .flatMap(x => x.metadata.clues as string[] ?? []));
  const allowedExistingContent = records.filter(x => x.metadata.type === "authored-content" &&
    !clues.has(x.metadata.id) && (x.metadata.events as string[]).some(id =>
      requiredSources.includes(id))).map(x => x.path);
  const branchWitnesses = r.coverage.branchProgress.filter(b => requiredSources.includes(b.event) &&
    b.status === "reachable").map(b => ({
      event: b.event, step: b.step, branch: b.branch, witness: b.witness ?? [],
    }));
  // The assignment supplies bounded source evidence, not blanket read/write
  // permission. Include all route-bearing records, participant voice, nearby
  // knowledge/relationships and conditional clues, but not unrelated Arcs.
  const participantIds = new Set(eventRecords.flatMap(e => e.metadata.participants as string[]));
  const relevantIds = new Set([...eventIds, ...arcs, milestoneId,
    ...choicePoints.map(c => c.id), ...puzzleSolutions.map(p => p.id)]);
  const factIds = new Set<string>();
  for (const event of eventRecords) {
    const inspect = (v: unknown): void => {
      if (typeof v === "string" && v.startsWith("fact.")) factIds.add(v);
      else if (Array.isArray(v)) v.forEach(inspect);
      else if (v && typeof v === "object") Object.values(v).forEach(inspect);
    };
    inspect(event.metadata.steps);
    inspect(event.metadata.prerequisites);
  }
  for (const character of records.filter(x => participantIds.has(x.metadata.id)))
    for (const entry of character.metadata.initial_knowledge as Array<{ fact: string }> ?? [])
      factIds.add(entry.fact);
  const clueIds = new Set(records.filter(x => puzzleSolutions.some(p => p.id === x.metadata.id))
    .flatMap(x => x.metadata.clues as string[] ?? []));
  const selected = records.filter(x => x.metadata.type === "creative-direction" ||
    relevantIds.has(x.metadata.id) || participantIds.has(x.metadata.id) ||
    factIds.has(x.metadata.id) || clueIds.has(x.metadata.id) ||
    x.metadata.type === "relationship" &&
      (x.metadata.characters as string[]).some(id => participantIds.has(id)) ||
    x.metadata.type === "revelation" && factIds.has(x.metadata.fact) ||
    x.metadata.type === "authored-content" &&
      (x.metadata.events as string[]).some(id => eventIds.includes(id)) ||
    x.metadata.type === "narrative-position" && eventIds.includes(x.metadata.event) ||
    x.metadata.type === "world-entity");
  return { milestoneId, workItemId: "composition-" + milestoneId.slice(10),
    ...(milestoneBlueprint ? { milestoneBlueprint } : {}),
    authorContract: plan.contract, eventOnly: !!source.units[0]?.eventOnly,
    eventIds, composeTargets, choicePoints, puzzleSolutions,
    branchWitnesses, requiredSources, allowedExistingContent,
    sourcePaths: [...new Set(selected.map(x => x.path))].sort(),
    mandatoryReads: [...new Set(selected.filter(x => ["creative-direction", "arc", "milestone",
      "event", "character", "relationship", "fact", "revelation", "choice-point", "puzzle",
      "authored-content"].includes(x.metadata.type))
      .map(x => x.path))].sort() };
}
export async function auditCompositionPaths(job: JobStartResult, assign: CompositionAssignment,
  claimed: string[]) {
  const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
  const paths: string[] = [];
  for (const change of changes(job)) {
    if (!["??", " M"].includes(change.slice(0, 2)))
      throw new Error("Composition specialist staged/removed/renamed a Story file: " + change);
    const name = change.slice(3);
    if (!name.startsWith(prefix)) throw new Error("Composition specialist wrote outside Story: " + name);
    const path = name.slice(prefix.length);
    if (!/^authored-content\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.md$/.test(path))
      throw new Error("Unauthorized composition edit to read-only Event/Story canon: " + path);
    if (change.startsWith(" M") && !assign.allowedExistingContent.includes(path))
      throw new Error("Composition edited unrelated or protected Authored Content: " + path);
    const target = join(job.worktreeStoryRoot, path);
    if (await realpath(target) !== target || !(await lstat(target)).isFile())
      throw new Error("Unsafe composition Story path: " + path);
    paths.push(path);
  }
  paths.sort();
  if (!paths.length || new Set(claimed).size !== claimed.length ||
      JSON.stringify(paths) !== JSON.stringify([...claimed].sort()))
    throw new Error("Composition manifest differs from Git changes: " + JSON.stringify({ paths, claimed }));
  return paths;
}
async function fileDigest(job: JobStartResult, paths: string[]) {
  return hash(JSON.stringify(await Promise.all(paths.map(async path =>
    [path, hash(await readFile(join(job.worktreeStoryRoot, path)))]))));
}
const heading = (slug: string) => slug.split("-")
  .map(s => s.slice(0, 1).toUpperCase() + s.slice(1)).join(" ");
function sections(body: string) {
  const map = new Map<string, string>();
  const parts = body.split(/^## (.+)$/gm);
  for (let i = 1; i < parts.length; i += 2) {
    // Both human-readable headings and the exact slug of an authored Choice
    // outcome identify the same branch. A specialist using the canonical ID
    // is not missing that branch merely because it used hyphens instead of
    // Title Case. Preserve strict outcome identity and duplicate detection.
    const raw = parts[i]!.trim();
    const slug = /^([a-z][a-z0-9]*(?:-[a-z0-9]+)+) selected$/i.exec(raw)?.[1];
    const title = slug ? heading(slug.toLowerCase()) + " selected" :
      raw.replace(/^([a-z])/, letter => letter.toUpperCase());
    if (map.has(title)) throw new Error("Duplicate prose section: " + title);
    map.set(title, parts[i + 1]?.trim() ?? "");
  }
  return map;
}
/** Syntactic/source checks only; a separate read-only Pi reviewer checks semantics. */
export async function verifyCompositionProse(job: JobStartResult, r: Report,
  a: CompositionAssignment, paths: string[]) {
  // A Choice author cannot edit Milestone fulfillment. Composition is allowed
  // to render independently verified outcomes before authorized closeout;
  // strict canonical closure belongs to final Story acceptance, not prose admission.
  const changed = r.records.filter(x => paths.includes(x.path) && x.metadata.type === "authored-content");
  if (changed.length !== paths.length) throw new Error("Composition output is not canonical Authored Content.");
  // Inspect the authorized existing prose as well as the edited files.
  // A scoped revision need not rewrite every already-composed Event in the
  // Milestone to demonstrate complete player-facing coverage.
  const records = r.records.filter(x => x.metadata.type === "authored-content" &&
    x.metadata.status !== "superseded" &&
    (paths.includes(x.path) || a.allowedExistingContent.includes(x.path)) &&
    (x.metadata.events as string[]).some(id => a.eventIds.includes(id)));
  const linked = new Map<string, Array<{ body: string; sections: Map<string, string>; revelations: string[] }>>();
  for (const record of records) {
    const file = await readFile(join(job.worktreeStoryRoot, record.path), "utf8");
    const end = file.indexOf("\n---", 4);
    if (end < 0) throw new Error("Invalid Authored Content frontmatter.");
    const body = file.slice(end + 4).trim();
    if (body.length < 70) throw new Error("Missing playable Authored Content prose: " + record.path);
    if ((record.metadata.events as string[]).length !== 1)
      throw new Error("Composition requires one owning Event per composed Authored Content record: " + record.path);
    for (const event of record.metadata.events as string[]) {
      if (!a.eventIds.includes(event)) throw new Error("Authored Content links unrelated Event: " + event);
      linked.set(event, [...(linked.get(event) ?? []),
        { body, sections: sections(body), revelations: record.metadata.revelations as string[] }]);
    }
  }
  for (const event of a.composeTargets) {
    if (!linked.get(event)?.length)
      throw new Error("Composition missing separate playable Event coverage for " + event);
  }
  const authoredByEvent = new Map(r.records.filter(x =>
    x.metadata.type === "authored-content" && x.metadata.status !== "superseded")
    .flatMap(x => (x.metadata.events as string[]).map(id => [id, x] as const)));
  for (const event of a.requiredSources) {
    if (!linked.has(event) && !authoredByEvent.has(event))
      throw new Error("Composition has no player-facing Authored Content for Event " + event);
  }
  // Events with a selected Choice outcome in their prerequisites or branches
  // must realize both sides, rather than collapsing downstream consequences
  // into a shared prose summary.
  for (const event of a.composeTargets) {
    const record = r.records.find(x => x.metadata.id === event)!;
    const conditioned = [...new Set((record.metadata.steps as Array<{ branches: Array<{ conditions: any[] }> }> ?? [])
      .flatMap(step => step.branches.flatMap(branch =>
        branch.conditions.filter(c => c.kind === "outcome").map(c => c.value as string))))];
    if (conditioned.length < 2) continue;
    if (!linked.get(event)?.some(content => conditioned.every(outcome =>
      (content.sections.get(heading(outcome) + " selected")?.length ?? 0) >= 60)))
      throw new Error("Composition missing distinct conditioned outcome sections in later Event " + event);
  }
  for (const choice of a.choicePoints) for (const event of choice.events) {
    const section = linked.get(event)?.find(x => x.sections.has("Shared entry") &&
      x.sections.has("Choice wording") && choice.outcomes.every(o => x.sections.has(heading(o) + " selected")));
    if (!section) throw new Error("Missing shared/choice/branch prose sections for " + event);
    const intro = section.sections.get("Shared entry")!, menu = section.sections.get("Choice wording")!;
    const labels = menu.split("\n").map(s => s.trim()).filter(Boolean);
    if (intro.length < 30 || labels.length !== choice.outcomes.length ||
        choice.outcomes.some(o => !labels.some(s =>
          s.toLowerCase().startsWith("**" + heading(o).toLowerCase() + ":**") ||
          /^[-*] ([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/.exec(s)?.[1] === o)))
      throw new Error("Choice wording must be selectable labels only, one per outcome.");
    const reactions = choice.outcomes.map(o => section.sections.get(heading(o) + " selected")!);
    if (reactions.some(s => s.length < 60) || new Set(reactions).size !== reactions.length)
      throw new Error("Missing distinct playable choice branch responses.");
    // A clue from an independent discovery Event cannot be presumed in the
    // shared pre-choice text. Its identifier is a conservative lexical tripwire,
    // not semantic proof that every other paraphrase is safe.
    const clues = r.records.filter(x => x.metadata.type === "puzzle")
      .flatMap(x => x.metadata.clues as string[] ?? []);
    for (const clueId of clues) {
      const clue = r.records.find(x => x.metadata.id === clueId);
      if (!clue || (clue.metadata.events as string[]).includes(event)) continue;
      const clueName = clueId.slice("authored-content.".length).replace(/-clue$/, "");
      if (new RegExp("\\b" + clueName.split("-").join("[- ]") + "\\b", "i").test(intro + "\n" + menu))
        throw new Error("Optional discovery clue leaked into shared prose: " + clueId);
    }
    const record = r.records.find(x => x.metadata.id === event)!;
    for (const step of record.metadata.steps as Array<{ branches: Array<{ effects: any[] }> }>) {
      for (const branch of step.branches) for (const effect of branch.effects) {
        if (effect.kind !== "revealed" || effect.value !== true ||
            step.branches.every(b => b.effects.some(e => e.kind === "revealed" &&
              e.revelation === effect.revelation && e.value === true))) continue;
        const phrase = String(effect.revelation).slice("revelation.".length)
          .split("-").join("[- ]");
        if (new RegExp("\\b" + phrase + "\\b", "i").test(intro + "\n" + menu))
          throw new Error("Branch-exclusive Revelation leaked into shared/menu prose: " + effect.revelation);
      }
    }
  }
  for (const puzzle of a.puzzleSolutions) for (const event of puzzle.eventIds) {
    if (!linked.get(event)?.some(c =>
      (c.sections.get("Solution consequence")?.length ?? 0) >= 100))
      throw new Error("Missing substantive solution ending prose linked to " + event);
  }
  // The canonical authored-content.revelations link is the only typed
  // presentation relationship available. It does not identify a step; the
  // independent review must additionally establish the precise route/line.
  for (const event of a.requiredSources) {
    const record = r.records.find(x => x.metadata.id === event);
    const effects = (record?.metadata.steps as Array<{ branches: Array<{ effects: any[] }> }> ?? [])
      .flatMap(step => step.branches.flatMap(branch => branch.effects));
    for (const id of new Set(effects.filter(effect =>
      effect.kind === "revealed" && effect.value === true).map(effect => effect.revelation as string))) {
      if (!linked.get(event)?.some(content => content.revelations.includes(id)))
        throw new Error("Composition missing typed Revelation presentation " + id + " in " + event);
    }
  }
  return { outcomes: [...new Set(a.choicePoints.flatMap(c => c.outcomes))].sort(),
    solutions: [...new Set(a.puzzleSolutions.flatMap(p => p.eventIds))].sort(),
    eventCoverage: a.requiredSources.map(id => ({
      id, witness: r.coverage.eventProgress.find(e => e.id === id)?.witness ?? [],
    })) };
}
async function publishHead(job: JobStartResult, before: string, after: string, id: string) {
  const file = join(job.stateDir, "revisions", "verified-head.json");
  await mkdir(dirname(file), { recursive: true });
  if (existsSync(file)) {
    const saved = JSON.parse(await readFile(file, "utf8")) as { version: number; jobId: string; headSha: string };
    if (saved.version !== 1 || saved.jobId !== job.jobId ||
        (saved.headSha !== before && saved.headSha !== after))
      throw new Error("Last verified Story head changed outside composition.");
    if (saved.headSha === after) {
      await finalizeRecoveryCheckpoint(job, id, before, after);
      return;
    }
  }
  await save(file, { version: 1, jobId: job.jobId, headSha: after, workItemId: id });
  await finalizeRecoveryCheckpoint(job, id, before, after);
}
function verifyCommit(job: JobStartResult, state: Receipt, sha: string) {
  if (!state.paths || !state.digest || git(job, "rev-parse", sha + "^") !== (state.beforeHead ?? state.interactiveHead))
    throw new Error("Composition commit parent is unverified.");
  const message = git(job, "log", "-1", "--format=%B", sha);
  if (!message.split("\n").includes("NovelTea-Job: " + commitOrigin(job, state.workItemId, sha).jobId) ||
      !message.includes("NovelTea-Composition: " + state.digest) ||
      !message.includes("NovelTea-Work-Item: " + state.workItemId + "\n") ||
      !message.includes("NovelTea-Plan-Version: " + state.planVersion + "\n"))
    throw new Error("Composition commit provenance mismatch.");
  const actual = git(job, "diff-tree", "--no-commit-id", "--name-only", "-r", sha).split("\n").filter(Boolean).sort();
  if (JSON.stringify(actual) !== JSON.stringify(state.paths.map(p => repoPath(job, p)).sort()))
    throw new Error("Composition commit includes unauthorized files.");
}
function output(job: JobStartResult, state: Receipt) {
  return { status: state.phase === "committed" ? "composition-committed" : "in-progress",
    phase: state.phase, jobId: job.jobId, milestoneId: state.milestoneId,
    workItemId: state.workItemId, interactiveHead: state.interactiveHead,
    expectedHead: state.beforeHead ?? state.interactiveHead, planVersion: state.planVersion,
    headSha: state.commitSha ?? state.interactiveHead, worktreeStoryRoot: job.worktreeStoryRoot,
    paths: state.paths ?? [], validation: state.validation, failure: state.failure,
    obligations: state.obligations ?? [], skillSnapshot: state.snapshot?.id,
    sessionFile: state.sessionFile, reviewSessionFile: state.reviewSessionFile,
    reviewPin: state.reviewPin,
    completionEvidence: { deterministicCoverage: state.phase === "committed",
      editorialReview: state.validation?.branchReview.reviewer ?? "unverified",
      engineImplementation: "not-started", fullStory: false } };
}

export async function runCompositionWorkItem(input: CompositionOptions) {
  if (input.fixture && input.action !== "inspect") throw Error("Structural fixture execution is retired; use an authenticated Generation assignment.");
  if (!milestonePattern.test(input.milestone)) throw new Error("--milestone requires exact typed Milestone ID.");
  if (input.action === "run" && !input.round) throw Error("Composition execution requires its checkpointed assignment child.");
  const job = await startStoryJob({ story: input.story, job: input.job }, false);
  const root = job.stateDir;
  const file = join(root, "composition-items", input.milestone.slice(10) + ".json");
  if (input.action === "inspect" && !existsSync(file)) throw new Error("No composition work item receipt.");
  return withStoryJobLock(job, "composition-" + input.milestone.slice(10), async () => {
    if (input.action === "run" && !await inspectPendingCompositionInvocation(job, input.milestone))
      await processAuthorUpdatesAtBoundary(job);
    const sourceFile = join(root, "interactive-items", input.milestone.slice(10) + ".json");
    const eventFile = join(root, "event-items", input.milestone.slice(10) + ".json");
    if (!existsSync(sourceFile) || !existsSync(eventFile) || !existsSync(join(root, "architecture.json")))
      throw new Error("Composition requires verified Event and authorized interactive disposition.");
    const source = JSON.parse(await readFile(sourceFile, "utf8")) as InteractiveReceipt;
    const eventSource = JSON.parse(await readFile(eventFile, "utf8")) as EventSourceReceipt;
    const architecture = JSON.parse(await readFile(join(root, "architecture.json"), "utf8")) as ArchReceipt;
    const units = source.units;
    const eventOnly = units?.[0]?.phase === "not-applicable" && !!units?.[0]?.eventOnly;
    const milestoneBlueprint = await reviewedMilestoneHandoff(job, eventSource);
    const correctedBlueprintPin = consumedCorrection(milestoneBlueprint);
    if (JSON.stringify(source.correctedBlueprintPin) !== JSON.stringify(correctedBlueprintPin))
      throw Error("Composition lost the Blueprint supersession consumed by Interactive.");
    assertMilestoneInteractiveDisposition(milestoneBlueprint, eventOnly);
    if (source.jobId !== job.jobId || source.milestoneId !== input.milestone ||
        eventSource.jobId !== job.jobId || eventSource.milestoneId !== input.milestone ||
        eventSource.phase !== "committed" || !eventSource.commitSha || !eventSource.paths?.length ||
        architecture.jobId !== job.jobId || architecture.phase !== "committed" ||
        !architecture.plan || architecture.plan.contract.scope.depth !== "composition" ||
        units?.length !== 2 ||
        !(units[0]?.phase === "committed" && units[0].commitSha && units[0].validation ||
          eventOnly && units[0]!.beforeHead && !units[0]!.commitSha &&
            units[1]?.phase === "not-applicable" &&
            JSON.stringify(units[0]!.eventOnly) === JSON.stringify(units[1]?.eventOnly)) ||
        !(units[1]?.phase === "committed" && units[1].commitSha && units[1].validation ||
          units[1]?.phase === "not-applicable" && units[1].beforeHead &&
            (units[1].noWrite || eventOnly)))
      throw new Error("Composition requires the same authorized and verified interactive milestone.");
    assertPlanContinuity(job, architecture, "interactive:" + input.milestone, source.planVersion);
    const optionalPuzzle = units[1]!.phase === "not-applicable";
    const interactiveHead = optionalPuzzle ? units[1]!.beforeHead! : units[1]!.commitSha!;
    if (!source.eventHead) throw new Error("Interactive receipt is missing its Event baseline.");
    git(job, "merge-base", "--is-ancestor", eventSource.commitSha!, source.eventHead);
    const choiceHead = eventOnly ? units[0]!.beforeHead! : units[0]!.commitSha!;
    const choiceBaseline = eventOnly ? source.eventHead : units[0]!.beforeHead ?? source.eventHead;
    const puzzleBaseline = units[1]!.beforeHead ?? choiceHead;
    if (!choiceBaseline) throw new Error("Interactive source Event baseline is not recorded.");
    for (const [unit, sha, before] of [
      ...(!eventOnly ? [[units[0]!, choiceHead, choiceBaseline] as const] : []),
      ...(!optionalPuzzle ? [[units[1]!, interactiveHead, puzzleBaseline] as const] : []),
    ] as const) {
      if (git(job, "rev-parse", sha + "^") !== before || !unit.digest || !unit.paths?.length) {
        throw new Error("Interactive commit chain/provenance differs from work item.");
      }
      const lines = git(job, "log", "-1", "--format=%B", sha).split("\n");
      if (!["NovelTea-Job: " + commitOrigin(job, unit.id, unit.commitSha!).jobId, "NovelTea-Work-Item: " + unit.id,
        "NovelTea-Plan-Version: " + source.planVersion, "NovelTea-Interactive: " + unit.digest]
        .every(line => lines.includes(line))) {
        throw new Error("Interactive commit lacks exact historical specialist provenance.");
      }
      const committed = git(job, "diff-tree", "--no-commit-id", "--name-only", "-r", sha)
        .split("\n").filter(Boolean).sort();
      if (JSON.stringify(committed) !== JSON.stringify(unit.paths.map(p => repoPath(job, p)).sort())) {
        throw new Error("Interactive specialist commit inventory differs from saved receipt.");
      }
    }
    if (source.eventHead !== choiceBaseline) {
      await verifiedNarrativeChain(job, source.eventHead!, choiceBaseline);
    }
    if (puzzleBaseline !== choiceHead) await verifiedNarrativeChain(job, choiceHead, puzzleBaseline);
    const planDigest = hash(JSON.stringify(architecture.plan));
    if (eventOnly) {
      if (!eventSource.snapshot?.id || !units[0]!.eventOnly ||
          !units[1]!.eventOnly || units[1]!.beforeHead !== choiceHead ||
          units[0]!.paths?.length || units[1]!.paths?.length ||
          units[0]!.claimedPaths?.length || units[1]!.claimedPaths?.length ||
          units[0]!.commitSha || units[1]!.commitSha || source.planDigest !== planDigest)
        throw Error("Event-only Composition lacks a genuine, commitless controller omission.");
      const proof = await readEventOnlyOmission(job, input.milestone, units[0]!.eventOnly, {
        eventHead: eventSource.commitSha!, planDigest,
        eventSnapshotId: eventSource.snapshot.id, validatorVersion: job.validatorVersion,
      });
      if (proof.reviewHead !== interactiveHead ||
          proof.reviewMode !== source.worker || proof.planVersion !== source.planVersion ||
          JSON.stringify(proof.eventIds) !== JSON.stringify(source.eventSource?.eventIds))
        throw Error("Event-only Composition changed original Event or omission head.");
    } else if (optionalPuzzle) {
      const skipped = units[1]!;
      const proof = await readPuzzleNoWrite(job, input.milestone, skipped.noWrite);
      if (!source.snapshot?.id || source.planDigest !== planDigest ||
          proof.eventHead !== source.eventHead || proof.choiceHead !== choiceHead ||
          proof.verifiedHead !== interactiveHead || proof.unitId !== skipped.id ||
          proof.unitId !== "interactive-puzzle-" + input.milestone.slice(10) ||
          proof.planDigest !== source.planDigest || proof.planVersion !== source.planVersion ||
          proof.snapshotId !== source.snapshot.id || proof.worker !== source.worker ||
          proof.provider !== source.provider || proof.model !== source.model ||
          proof.piSessionFile !== (skipped.piSessionFile ?? null) ||
          skipped.paths?.length !== 0 || skipped.claimedPaths?.length !== 0 ||
          JSON.stringify(proof.report.architecturalConflicts) !== JSON.stringify(skipped.conflicts) ||
          JSON.stringify(proof.report.laterObligations) !== JSON.stringify(skipped.obligations) ||
          JSON.stringify(proof.skillReads) !== JSON.stringify(skipped.skillReads))
        throw new Error("Composition rejected stale, mismatched or unsealed optional Puzzle evidence.");
      // Re-evaluate the original promise and actual scoped canonical Story, not
      // just the specialist's stored claim that a Puzzle was not needed.
      const pending = await inspectPendingCompositionInvocation(job, input.milestone);
      const sourceReport = pending?.invocationBaseline ?? verified(await validateStoryJob(
        await startStoryJob({ story: input.story, job: input.job }, false),
        input.validatorSource ?? input.skillsSource, { ...job, baseSha: interactiveHead }), interactiveHead);
      const related = sourceReport.records.filter(record => record.metadata.type === "event" &&
        (record.metadata.arcs as string[] ?? []).some(id => {
          const milestone = sourceReport.records.find(item => item.metadata.id === input.milestone);
          return (milestone?.metadata.arcs as string[] ?? []).includes(id);
        })).map(record => record.metadata.id);
      const obligation = await puzzleObligation(job, architecture.plan, sourceReport.records, related,
        [...(source.eventSource?.missingObligations ?? []),
          ...(milestoneBlueprint?.design.downstream.filter(o => o.owner === "interactive").map(o => o.obligation) ?? [])]);
      if (obligation.required || obligation.turnDigest !== proof.turnDigest)
        throw new Error("Optional Puzzle source no longer satisfies the approved goal obligation.");
    }
    let state: Receipt;
    if (existsSync(file)) {
      state = JSON.parse(await readFile(file, "utf8")) as Receipt;
      if (state.version !== 1 || state.jobId !== job.jobId || state.baseSha !== job.baseSha ||
          state.milestoneId !== input.milestone || state.interactiveHead !== interactiveHead ||
          JSON.stringify(state.correctedBlueprintPin) !== JSON.stringify(correctedBlueprintPin) ||
          !state.planVersion || !state.planDigest)
        throw new Error("Composition receipt mismatches verified plan or interactive source.");
      assertPlanContinuity(job, architecture, "composition:" + input.milestone,
        state.planVersion, state.planDigest);
    } else {
      if (input.action !== "run") throw new Error("No composition receipt.");
      if (changes(job).length) throw new Error("Composition requires a clean verified worktree.");
      await verifiedNarrativeSuccessor(job, interactiveHead);
      state = { version: 1, jobId: job.jobId, baseSha: job.baseSha,
        milestoneId: input.milestone, workItemId: "composition-" + input.milestone.slice(10),
        planVersion: architecture.plan.version, planDigest, interactiveHead, correctedBlueprintPin,
        worker: "pi", provider: input.provider ?? "openai",
        model: input.model ?? "gpt-6-luna", thinking: input.thinking,
        authorTask: input.task, phase: "pending" };
      await save(file, state);
    }
    if (input.action === "inspect") return output(job, state);
    if (state.worker === "pi") {
      if (!input.round) throw Error("Composition requires its checkpointed assignment child.");
      if (!state.assignmentKey) {
        if (state.phase !== "pending" || input.round.command.phase !== "invoke")
          throw Error("Composition receipt lacks its original child assignment admission.");
        state.assignmentKey = input.round.assignmentKey;
        await save(file, state);
      }
      if (state.assignmentKey !== input.round.assignmentKey)
        throw Error("Composition round belongs to another logical assignment.");
    }
    if (Boolean(input.fixture) !== (state.worker === "fixture") ||
        input.provider && input.provider !== state.provider ||
        input.model && input.model !== state.model ||
        input.thinking && input.thinking !== state.thinking ||
        input.task && input.task !== state.authorTask)
      throw new Error("Composition worker selection or assigned task differs from persisted assignment.");
    const config = input.skillsSource
      ? { discovery: "explicit-only" as const, novelteaSkills: input.skillsSource, skillDirs: [], requiredSkills: [] }
      : state.snapshot
        ? { discovery: "explicit-only" as const, novelteaSkills: undefined, skillDirs: [], requiredSkills: [] }
        : await loadSkillConfig(undefined, false);
    if (!state.snapshot) {
      const snapshot = await createSkillSnapshot({ ...config,
        novelteaSkills: input.skillsSource ?? config.novelteaSkills,
        discovery: "explicit-only", requiredSkills: ["nt-narrative-composition", "nt-catalog"] });
      if (!snapshot) throw new Error("Composition requires pinned NovelTea skills.");
      state.snapshot = snapshot; await save(file, state);
    }
    if (await openSkillSnapshot(state.snapshot.id) !== state.snapshot.path)
      throw new Error("Composition skills snapshot changed from immutable pin.");
    const validate = async (base: string) => validateStoryJob(
      await startStoryJob({ story: input.story, job: input.job }, false),
      input.validatorSource ?? input.skillsSource ?? config.novelteaSkills, { ...job, baseSha: base });
    const Channels = Annotation.Root({ receipt: Annotation<Receipt>(),
      round: Annotation<AssignmentRoundResult | null>({ reducer: (_, next) => next, default: () => null }) });
    async function execute(s: Receipt): Promise<AssignmentRoundResult | undefined> {
      const base = s.beforeHead ?? (s.phase === "pending"
        ? await verifiedNarrativeSuccessor(job, s.interactiveHead) : s.interactiveHead);
      if (s.beforeHead && s.beforeHead !== base) throw new Error("Composition authority head changed.");
      if (s.worker === "pi" && input.round?.publish &&
          (input.round.command.phase !== "verify" || !s.invocationProof ||
            !isDeepStrictEqual(s.invocationProof, input.round.command.proof) ||
            !["authored", "committed"].includes(s.phase)))
        throw Error("Composition publication lacks its checkpointed accepted draft proof");
      if (s.phase === "committed") {
        if (s.worker === "pi" && !input.round?.publish)
          throw Error("Composition commit cannot replay without its publication command");
        if (!s.commitSha) throw new Error("Missing composition commit.");
        verifyCommit(job, s, s.commitSha);
        if (changes(job).length) throw new Error("Composition committed worktree is dirty.");
        if (git(job, "rev-parse", "HEAD") !== s.commitSha) await verifiedNarrativeSuccessor(job, s.commitSha);
        else await publishHead(job, base, s.commitSha, s.workItemId);
        return;
      }
      const continuing = s.phase === "writing";
      if (continuing && (s.worker !== "pi" ||
          !await inspectPendingCompositionInvocation(job, s.milestoneId, base)))
        throw Error("Interrupted Composition writer lacks its original invocation.");
      const current = git(job, "rev-parse", "HEAD");
      const recovering = s.phase === "authored" && current !== base;
      if (recovering && (!s.digest || !s.paths || changes(job).length ||
          git(job, "rev-parse", "HEAD^") !== base ||
          !git(job, "log", "-1", "--format=%B").includes("NovelTea-Composition: " + s.digest)))
        throw new Error("Unknown interrupted composition commit; manually reconcile.");
      if (!recovering) {
        assertHead(job, base);
        if (s.phase === "pending" && changes(job).length)
          throw new Error("Composition writer requires clean Story boundary.");
      }
      const baseline = s.invocationBaseline ?? verified(await validate(base), base);
      const assign = s.invocationAssignment ?? { ...selectAssignment(architecture.plan!, baseline, source, eventSource, input.milestone,
        milestoneBlueprint),
        ...(s.authorTask ? { authorTask: s.authorTask } : {}) };
      if (s.phase === "pending" || continuing) {
        if (!continuing) {
          await preflightPiAssignment(job, "composition:" + s.workItemId + ":write", s.worker === "pi"
            ? { provider: s.provider, model: s.model, thinking: s.thinking } : undefined);
          s.phase = "writing"; s.beforeHead = base;
          if (s.worker === "pi") {
            s.invocationAssignment = assign;
            s.invocationBaseline = baseline;
            s.invocationSource = compositionInvocationSource(job, s);
          }
          await save(file, s);
        }
        let cycle: Awaited<ReturnType<typeof createCompositionReviewCycle>> | undefined;
        try {
          const verifyDraft = async (evidence: CompositionEvidence) => {
            let paths: string[] | undefined;
            let manifestFeedback: string | undefined;
            try {
              paths = await auditCompositionPaths(job, assign, evidence.modifiedRecords);
            } catch (error) {
              const message = String(error);
              if (!message.includes("Composition manifest differs from Git changes")) throw error;
              manifestFeedback = message;
            }
            assertHead(job, base);
            if (evidence.conflicts.length) {
              const optional = optionalDialogueDeferralFeedback(assign, evidence.conflicts);
              if (optional) return { stage: "pre-review" as const, problems: [optional] };
              throw new Error("Unresolved source conflict: " + evidence.conflicts.join("; "));
            }
            const result = await validate(base);
            const report = result.report as unknown as Report | undefined;
            if (report?.protection?.status !== "checked" || report.protection.base !== base ||
                report.protection.changes.length || report.protection.warnings.length)
              throw new Error("Composition protected author decisions changed; repair refused.");
            if (manifestFeedback) return { stage: "pre-review" as const,
              problems: [manifestFeedback +
              ". Report the exact changed Authored Content paths; existing valid prose does not need cosmetic edits."] };
            if (result.status === "rejected") return { stage: "pre-review" as const, problems: [],
              defects: nativeMetadataDefects(result, { jobId: job.jobId, baseSha: base,
                worktreeStoryRoot: job.worktreeStoryRoot, validatorVersion: job.validatorVersion, paths: paths! }) };
            if (result.status !== "passed" || report.diagnostics.length)
              throw new Error("Canonical validator rejected composition draft.");
            let structural: Awaited<ReturnType<typeof verifyCompositionProse>>;
            try { structural = await verifyCompositionProse(job, report, assign, paths!); }
            catch (e) { return { stage: "pre-review" as const, problems: [String(e)] }; }
            // Independent semantic review participates in the SAME bounded
            // writer repair loop. Never accept a structurally green draft that
            // an editorial reviewer has already rejected.
            if (s.worker === "pi") {
              if (!s.sessionFile || !s.writerSessionId)
                throw new Error("Composition reviewer cannot start without original writer session provenance.");
              cycle ??= await createCompositionReviewCycle(job, s.snapshot!, assign,
                s.provider, s.model, s.thinking,
                { id: s.writerSessionId, file: s.sessionFile },
                base, s.planVersion, s.planDigest,
                async session => {
                  if (s.reviewSessionFile && s.reviewSessionFile !== session)
                    throw Error("Original Composition reviewer session changed");
                  s.reviewSessionFile = session; await save(file, s); });
              const result = await cycle.review(paths!, [...structural.outcomes, ...structural.solutions]);
              const review = result.review;
              if (review.verdict !== "pass" || review.concerns.length)
                return { stage: "editorial" as const, reviewProgress: result.reviewProgress,
                  problems: review.concerns.length ? review.concerns : ["Independent editorial review blocked without correction details."] };
              if (!result.pin) throw new Error("Composition editorial pass lacks sealed review lineage.");
              s.reviewedDigest = await fileDigest(job, paths!);
              s.reviewedEvidence = review;
              s.reviewPin = result.pin;
              await save(file, s);
            }
            return { stage: "editorial" as const, problems: [] };
          };
          const authored = await authorComposition(job, s.snapshot!, assign, s.provider, s.model,
              s.thinking, async (session, id) => {
                if (s.sessionFile && (s.sessionFile !== session || s.writerSessionId !== id))
                  throw Error("Original Composition writer session changed");
                s.sessionFile = session; s.writerSessionId = id; await save(file, s); },
              verifyDraft, { sourceDigest: s.invocationSource!,
                session: s.sessionFile && s.writerSessionId ? { file: s.sessionFile, id: s.writerSessionId } : undefined,
                authorize: async () => {
                  assertHead(job, base);
                  if (s.invocationSource !== compositionInvocationSource(job, s))
                    throw Error("Composition assignment source changed before original invocation");
                },
                effect: () => assignmentDraftEffect(job, base) }, input.round!.command);
          if ("round" in authored) return authored.round;
          const evidence = authored;
          if (s.worker === "pi") {
            if (!evidence.invocationProof) throw Error("Composition writer did not settle its original invocation");
            s.invocationProof = evidence.invocationProof;
            await verifySettledAssignment({ ...compositionInvocationOptions(job, s),
              proof: s.invocationProof, effect: await assignmentDraftEffect(job, base) });
          }
          s.claimedPaths = evidence.modifiedRecords;
          if (evidence.piSessionId) s.writerSessionId = evidence.piSessionId;
          s.paths = await auditCompositionPaths(job, assign, evidence.modifiedRecords);
          s.conflicts = evidence.conflicts; s.obligations = evidence.obligations;
          s.skillReads = evidence.skillReads;
          s.digest = await fileDigest(job, s.paths);
          s.phase = "authored"; await save(file, s);
        } catch (e) { s.failure = String(e); await save(file, s); throw e; }
        finally { cycle?.dispose(); }
      }
      if (s.worker === "pi" && !input.round?.publish) {
        if (input.round?.command.phase !== "verify" || !s.invocationProof ||
            !isDeepStrictEqual(input.round.command.proof, s.invocationProof) || s.phase !== "authored")
          throw Error("Composition draft acceptance lost its original verification command");
        return { status: "accepted", proof: s.invocationProof };
      }
      try {
        if (!s.paths || !s.claimedPaths || !s.digest || s.conflicts?.length ||
            await fileDigest(job, s.paths) !== s.digest)
          throw new Error("Composition draft bytes/manifest differ from verified receipt.");
        if (s.worker === "pi") {
          if (!s.invocationProof) throw Error("Authored Composition lacks its settled invocation");
          await verifySettledAssignment({ ...compositionInvocationOptions(job, s),
            proof: s.invocationProof, effect: s.digest });
        }
        const result = await validate(base), report = verified(result, base);
        for (const prev of baseline.coverage.eventProgress.filter(e => e.status === "reachable")) {
          if (report.coverage.eventProgress.find(e => e.id === prev.id)?.status !== "reachable")
            throw new Error("Composition lost previously reachable Event route: " + prev.id);
        }
        const structural = await verifyCompositionProse(job, report, assign, s.paths);
        const review: SemanticReview = s.reviewedDigest === s.digest && s.reviewedEvidence && s.reviewPin &&
              s.sessionFile && s.writerSessionId
            ? await verifyCompositionReviewPin(job, s.snapshot!, assign, s.provider, s.model,
                base, s.planVersion, s.planDigest,
                { id: s.writerSessionId, file: s.sessionFile }, s.paths, s.reviewPin)
            : (() => { throw Error("Composition requires its original sealed independent reviewer pass."); })();
        if (s.worker === "pi") {
          if (review.sessionFile !== s.reviewSessionFile) throw Error("Composition reviewer identity changed");
          assertCompositionReviewerMatch(review, s.reviewedEvidence);
        }
        if (review.verdict !== "pass" || review.concerns.length || !review.sourceEvidence.length)
          throw new Error("Branch-to-prose editorial review blocked: " + review.concerns.join("; "));
        if (s.worker === "pi" && [...structural.outcomes, ...structural.solutions].some(route =>
          !review.sourceEvidence.some(line => line.toLowerCase().includes(route.toLowerCase()))))
          throw new Error("Independent editorial review omitted source-linked evidence for a Choice/Puzzle route.");
        const branchReview: ReviewEvidence = { status: "passed", outcomes: structural.outcomes,
          solutions: structural.solutions, sourceEvidence: review.sourceEvidence,
          reviewer: "independent-pi",
          sessionFile: review.sessionFile };
        if (!recovering) {
          assertHead(job, base);
          const paths = await auditCompositionPaths(job, assign, s.claimedPaths);
          if (JSON.stringify(paths) !== JSON.stringify(s.paths) ||
              await fileDigest(job, paths) !== s.digest)
            throw new Error("Composition changed after editorial review.");
          git(job, "add", "--", ...paths.map(p => repoPath(job, p)));
          git(job, "-c", "user.name=NovelTea Generator",
            "-c", "user.email=noveltea-gen@users.noreply.github.com",
            "commit", "-m", `Compose branch-aware prose [${job.jobId}]\n\nNovelTea-Job: ${job.jobId}\nNovelTea-Work-Item: ${s.workItemId}\nNovelTea-Plan-Version: ${s.planVersion}\nNovelTea-Composition: ${s.digest}`);
        }
        if (changes(job).length) throw new Error("Composition commit left dirty Story worktree.");
        const sha = git(job, "rev-parse", "HEAD");
        verifyCommit(job, s, sha);
        s.commitSha = sha; s.phase = "committed";
        s.validation = { protectionBase: base, validatorVersion: result.validator.version,
          branchReview, eventCoverage: structural.eventCoverage };
        delete s.failure; await save(file, s);
        await publishHead(job, base, sha, s.workItemId);
      } catch (e) { s.failure = String(e); await save(file, s); throw e; }
    }
    const graph = new StateGraph(Channels)
      .addNode("compose_and_review", async ({ receipt }) => {
        const round = await execute(receipt); return { receipt, round: round ?? null };
      }).addEdge(START, "compose_and_review").addEdge("compose_and_review", END).compile();
    const result = await graph.invoke({ receipt: state });
    if (result.round) return { ...output(job, result.receipt),
      status: result.round.status === "accepted" ? "composition-authored" : "writer-round", round: result.round };
    const authorUpdates = await processAuthorUpdatesAfterWork(job);
    const { scheduleIdeasAtBoundary } = await import("./idea-placement.js");
    await scheduleIdeasAtBoundary(job, "composition-work");
    return { ...output(job, result.receipt), authorUpdates };
  });
}
