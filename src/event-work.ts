import { execFileSync } from "./git-read-cache.js";
import { commitOrigin } from "./recovery-fork-state.js";
import { assertMilestoneFulfillmentOnly, milestoneBodyOnlyDrift,
  milestoneBaselineBody } from "./milestone-field-scope.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { Plan } from "./architecture.js";
import { nativeMetadataDefects, assignmentCommittedEffect, type AssignmentDiagnosticAuthorization, assignmentDraftEffect, executeAssignmentRound, verifySettledAssignment, inspectAssignmentFailure, AssignmentAuthorPauseError, type AssignmentDefect, type AssignmentInvocationProof, type AssignmentRoundCommand, type AssignmentRoundResult } from "./assignment-metadata-recovery.js";
import { readJobControl } from "./job-control.js";
import { StoryCancelledError } from "./story-interruption.js";
import { ProtocolIntegrityBlockedError, type ResponseContractSession } from "./response-contract-recovery.js";
import { parseEventManifest, authorEventCluster, eventInvocationDirectory, scopedEventEvidenceConflict, eventEvidenceRepairFeedback,
  scopedNondecisionChoiceDeferral, eventNondecisionChoiceCorrection,
  scopedDecisionSetupConflict, eventDecisionSetupCorrection,
  observedNondecisionMilestone,
  eventMilestoneBodyRestoreFeedback, type EventAssignment, type EventEvidence } from "./event-specialist.js";
import { eventPrerequisiteReportDigest, authenticateEventNoWrite } from "./event-prerequisite-auth.js";
export { eventPrerequisiteReportDigest } from "./event-prerequisite-auth.js";
import type { CausalDiscovery } from "./causal-amendment.js";
import { startStoryJob, type JobStartResult } from "./job.js";
import { trustedHead } from "./revision.js";
import { finalizeRecoveryCheckpoint } from "./recovery-checkpoints.js";
import { verifyJobPiSession } from "./job-session.js";
import { withStoryJobLock, withStoryJobLockOrReuse } from "./job-lock.js";
import { buildEventConsequenceProof, eventConsequenceProofDigest,
  type EventConsequenceProof } from "./event-consequence-proof.js";
import { assertPlanContinuity, assertFoundationArchitectureContinuity } from "./plan-continuity.js";
import { processAuthorUpdatesAtBoundary, processAuthorUpdatesAfterWork } from "./author-updates.js";
import { loadSkillConfig } from "./skills.js";
import { guardPiBudget, preflightPiAssignment } from "./job-pi-policy.js";
import { archiveReviewedMilestoneBlueprint, ensureMilestoneBlueprint,
  inspectMilestoneBlueprint, readReviewedMilestoneBlueprint, milestoneCharacterPrerequisites,
  type MilestoneBlueprintPin } from "./milestone-blueprint.js";
import { createSkillSnapshot, openSkillSnapshot, type SkillSnapshot } from "./snapshot.js";
import { validateStoryJob, type ValidationResult } from "./validator.js";
import { recordSpecialistChoice, verifySpecialistChoice, claimSpecialistChoice,
  completeSpecialistChoice, SpecialistChoiceRequiredError, inspectSpecialistChoice } from "./specialist-choice.js";

type Phase = "ready" | "writing" | "awaiting-author" | "authored" | "committed" | "prerequisite-reported";
interface EventReceipt {
  version: 1; jobId: string; baseSha: string; workItemId: string;
  milestoneId: string; planVersion: number; planDigest: string;
  expectedHead: string; phase: Phase; worker: "fixture" | "pi";
  provider: string; model: string; snapshot?: SkillSnapshot;
  sessionFile?: string; sessionId?: string; authorChoiceId?: string;
  invocationSource?: string; invocationChoice?: string; invocationProof?: AssignmentInvocationProof;
  writerContinuation?: { reportDigest: string; supportRef: string; originalHead: string; sessionSha256?: string };
  blueprintOwnerFinding?: { sealDigest: string; finding: import("./dependency-amendments.js").WriterDependencyFinding };
  assignmentKey?: string;
  fixtureCorrectionCase?: "repair" | "failed-repair";
  /** Older Event items predate the local Blueprint gate; new items require it. */
  blueprintRequired?: boolean; blueprintTask?: string; blueprintPin?: MilestoneBlueprintPin;
  assignment?: EventAssignment;
  blueprintPrerequisite?: EventBlueprintPrerequisite;
  blueprintSource?: NonNullable<EventAssignment["blueprintSource"]>;
  skillReads?: string[]; claimedPaths?: string[];
  paths?: string[]; contentDigest?: string; commitSha?: string;
  conflicts?: string[]; obligations?: string[];
  causalDiscovery?: CausalDiscovery;
  blueprintFinding?: EventEvidence["blueprintFinding"];
  dependencyFinding?: EventEvidence["dependencyFinding"];
  blueprintChallenge?: import("./blueprint-challenge.js").SpecialistBlueprintChallenge;
  /** Advisory typed evidence tied to native-validated draft and final commit. */
  consequenceProof?: EventConsequenceProof;
  /** A completed, clean no-write original session; never executable authority. */
  prerequisite?: { expectedHead: string; sessionSha256: string; sessionId: string;
    assignmentDigest: string; snapshotId: string; sessionFile: string; worker: "pi" | "fixture";
    reportDigest: string; transcriptBytes?: number };
  validation?: {
    status: "passed"; validatorVersion: string; protectionBase: string;
    eventIds: string[]; routes: Route[]; eventProgress: Progress[];
    milestoneState: "complete" | "partial-choice-pending";
    branchProgress: Array<{ event: string; step: string; branch: string; status: Progress["status"] }>;
    remaining: unknown[]; truncated: boolean;
  };
  /** Historical only. These receipts are inspectable, not executable grants. */
  reroutedFrom?: string;
  reroutedTask?: string;
  failure?: string;
}
interface RecordItem { path: string; metadata: Record<string, any> & { id: string; type: string; status: string } }
interface Progress { id: string; status: "reachable" | "impossible" | "unverified" | "incomplete"; path?: string; witness?: string[]; action?: string }
interface Route { alternative: number; status: Progress["status"]; witness?: string[]; action?: string }
interface Report {
  records: RecordItem[]; diagnostics: Array<{ path: string; line?: number; column?: number; code: string; message: string }>;
  outstanding: Array<{ id: string; path: string; field: string; requiredBy: string }>;
  protection: { status: string; changes: unknown[]; warnings: unknown[] };
  coverage: { eventProgress: Progress[]; milestoneRoutes: Array<{ id: string; routes: Route[] }>;
    branchProgress: Array<{ event: string; step: string; branch: string; status: Progress["status"] }>;
    search: { truncated: boolean } };
  readiness: { design: { stages: Record<string, { minimum: string }> } };
}
type ArchitectureReceipt = import("./plan-continuity.js").PlanSnapshot & { expectedHead: string };
interface FoundationsReceipt {
  jobId: string; planVersion: number; architectureHead: string;
  units: Array<{ id: string; phase: string; commitSha?: string }>;
}
export interface EventOptions {
  story: string; job: string; action: "run" | "inspect"; milestone: string;
  skillsSource?: string; validatorSource?: string; fixture?: boolean;
  provider?: string; model?: string; task?: string; turnPlanDigest?: string;
  round?: { assignmentKey: string; command: AssignmentRoundCommand };
  blueprintAssessment?: import("./blueprint-reassessment.js").BlueprintAssessmentGrant;
}
const idPattern = /^milestone\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
/** The source-committed evidence that decides whether Choice binding is still owed. */
export function eventCompletionDigest(value: {
  milestoneId: string; expectedHead: string; snapshotId: string; contentDigest: string;
  eventIds: string[]; milestoneState: "complete" | "partial-choice-pending";
  obligations: string[];
}) {
  if (!idPattern.test(value.milestoneId) || !/^[a-f0-9]{40}$/.test(value.expectedHead) ||
      !/^[a-f0-9]{64}$/.test(value.snapshotId) ||
      !/^[a-f0-9]{64}$/.test(value.contentDigest) || !value.eventIds.length ||
      !["complete", "partial-choice-pending"].includes(value.milestoneState))
    throw Error("Event completion evidence is not bound to a verified source.");
  return hash(JSON.stringify(value));
}
function eventInvocationSource(job: JobStartResult, receipt: EventReceipt) {
  return hash(JSON.stringify({ job: job.jobId, thread: job.threadId, base: receipt.baseSha,
    workItem: receipt.workItemId, head: receipt.expectedHead, planVersion: receipt.planVersion,
    plan: receipt.planDigest, assignment: receipt.assignment, snapshot: receipt.snapshot?.id,
    provider: receipt.provider, model: receipt.model, reroutedFrom: receipt.reroutedFrom,
    choice: receipt.invocationChoice ?? null, assignmentKey: receipt.assignmentKey, fixtureCorrectionCase: receipt.fixtureCorrectionCase, writerContinuation: receipt.writerContinuation }));
}
function eventInvocationOptions(job: JobStartResult, receipt: EventReceipt) {
  if (!receipt.invocationSource || receipt.invocationSource !== eventInvocationSource(job, receipt) ||
      !receipt.sessionFile || !receipt.sessionId)
    throw Error("Event invocation receipt lost its original source or session");
  return { directory: eventInvocationDirectory(job, receipt.workItemId, receipt.sessionId, receipt.invocationSource),
    sourceDigest: receipt.invocationSource, sessionId: receipt.sessionId, sessionFile: receipt.sessionFile,
    sessionRoots: [receipt.fixtureCorrectionCase ? join(job.stateDir, "event-fixture-sessions", receipt.workItemId) :
      join(job.stateDir, "event-sessions", receipt.workItemId,
        ...(receipt.reroutedFrom ? ["rerouted-" + receipt.reroutedFrom] : []))],
    responseKind: "event-manifest-or-choice" as const };
}
export async function inspectPendingEventInvocation(job: JobStartResult, milestone: string, sourceHead?: string) {
  if (!idPattern.test(milestone)) return null;
  const path = join(job.stateDir, "event-items", milestone.slice(10) + ".json");
  if (!existsSync(path)) return null;
  const r = JSON.parse(await readFile(path, "utf8")) as EventReceipt;
  if (!["writing", "authored", "committed", "awaiting-author"].includes(r.phase) ||
      sourceHead && r.expectedHead !== sourceHead) return null;
  if (r.jobId !== job.jobId || r.baseSha !== job.baseSha || r.milestoneId !== milestone ||
      r.workItemId !== "event-" + milestone.slice(10)) throw Error("Event pending receipt identity changed");
  if (r.worker === "pi" || r.fixtureCorrectionCase) {
    if (!r.assignment || !r.snapshot || r.invocationSource !== eventInvocationSource(job, r) ||
        await openSkillSnapshot(r.snapshot.id) !== r.snapshot.path)
      throw Error("Original Event invocation source changed");
    if (r.sessionFile || r.sessionId) {
      const options = eventInvocationOptions(job, r);
      if (!options.sessionFile.startsWith(options.sessionRoots[0]! + "/") ||
          await realpath(options.sessionFile) !== options.sessionFile ||
          !(await lstat(options.sessionFile)).isFile())
        throw Error("Original Event session is unsafe");
    } else if (dirty(job).length || r.phase !== "writing") throw Error("Original Event draft lacks a session");
  }
  const head = git(job, "rev-parse", "HEAD");
  if (head === r.expectedHead) await assignmentDraftEffect(job, head);
  else {
    if (!["authored", "committed"].includes(r.phase) || dirty(job).length ||
        !r.paths || await contentDigest(job, r.paths) !== r.contentDigest)
      return null;
    // Pre-publication Git effects may not have their final native proof yet.
    if (git(job, "rev-parse", head + "^") !== r.expectedHead ||
        !git(job, "log", "-1", "--format=%B", head).includes("NovelTea-Event-Design: " + r.contentDigest))
      return null;
    if (r.phase === "committed") verifyCommit(job, r, head);
    if (r.worker === "pi" || r.fixtureCorrectionCase) {
      if (!r.invocationProof) throw Error("Original Event commit lacks settled writer proof");
      await verifySettledAssignment({ ...eventInvocationOptions(job, r), proof: r.invocationProof, effect: r.contentDigest! });
    }
  }
  return r;
}
export async function inspectEventFailure(job: JobStartResult, milestone: string, sourceHead: string,
  diagnostic?: AssignmentDiagnosticAuthorization, historicalHead?: string) {
  if (!idPattern.test(milestone)) return null;
  const receipt = JSON.parse(await readFile(join(job.stateDir, "event-items", milestone.slice(10) + ".json"), "utf8")) as EventReceipt;
  if (receipt.jobId !== job.jobId || receipt.milestoneId !== milestone ||
      receipt.workItemId !== "event-" + milestone.slice(10) || receipt.expectedHead !== sourceHead ||
      (!diagnostic ? receipt.phase !== "writing" : !["writing", "authored", "committed"].includes(receipt.phase)) ||
      receipt.worker !== "pi" || !receipt.assignmentKey) return null;
  const options = eventInvocationOptions(job, receipt);
  const head = historicalHead ?? git(job, "rev-parse", "HEAD");
  let effect: string | null;
  if (head === sourceHead && !historicalHead) {
    if (!await inspectPendingEventInvocation(job, milestone, sourceHead)) return null;
    effect = await assignmentDraftEffect(job, sourceHead);
  } else {
    if (!diagnostic || !receipt.paths || !receipt.contentDigest || !receipt.invocationProof ||
        (receipt.phase !== "authored" && receipt.phase !== "committed") ||
        (historicalHead && (receipt.phase !== "committed" || receipt.commitSha !== head))) return null;
    verifyCommit(job, receipt, head);
    effect = assignmentCommittedEffect(job, sourceHead, head, receipt.paths, receipt.contentDigest);
    if (!historicalHead && !await inspectPendingEventInvocation(job, milestone, sourceHead)) return null;
    await verifySettledAssignment({ ...options, proof: receipt.invocationProof, effect, historical: !!historicalHead });
  }
  const terminal = await inspectAssignmentFailure({ ...options, effect, diagnostic });
  return terminal && { ...terminal, ref: options.directory + "/terminal.json", workItem: receipt.workItemId,
    assignmentKey: receipt.assignmentKey, invocationProof: receipt.invocationProof, sessionId: receipt.sessionId!,
    milestonePath: receipt.assignment?.milestonePath };
}
const gitEnv = () => {
  const env = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[k];
  return env;
};
function rawGit(job: JobStartResult, ...args: string[]) {
  return execFileSync("git", args, { cwd: job.worktreeRoot, env: gitEnv(),
    encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}
const git = (job: JobStartResult, ...args: string[]) => rawGit(job, ...args).trim();
const repoPath = (job: JobStartResult, path: string) => job.storyRelativePath ? job.storyRelativePath + "/" + path : path;
const dirty = (job: JobStartResult) =>
  rawGit(job, "status", "--porcelain=v1", "-z", "--untracked-files=all").split("\0").filter(Boolean);
async function persist(file: string, data: unknown) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = file + "." + randomUUID() + ".tmp";
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await rename(tmp, file);
}
function assertHead(job: JobStartResult, expected: string) {
  if (git(job, "rev-parse", "HEAD") !== expected || git(job, "symbolic-ref", "--short", "HEAD") !== job.branch) {
    throw new Error("Event work-item HEAD/branch changed; preserve and reconcile before continuing.");
  }
}
function reportOf(result: ValidationResult, baseline: string): Report {
  const r = result.report as unknown as Report | undefined;
  if (result.status !== "passed" || !r || !Array.isArray(r.records) || !Array.isArray(r.diagnostics) ||
      r.diagnostics.length || !Array.isArray(r.outstanding) ||
      r.protection?.status !== "checked" || r.protection.changes.length || r.protection.warnings.length ||
      !Array.isArray(r.coverage?.eventProgress) || !Array.isArray(r.coverage?.milestoneRoutes) ||
      !Array.isArray(r.coverage?.branchProgress) || !r.coverage.search) {
    throw new Error("Canonical Event validation/protection failed against " + baseline + ": " +
      JSON.stringify(result).slice(0, 8500));
  }
  return r;
}
export function selectedAssignment(job: JobStartResult, plan: Plan, report: Pick<Report, "records">, milestoneId: string, workItemId: string): EventAssignment {
  if (plan.contract.scope.depth === "architecture") {
    throw new Error("The author completion contract does not authorize interactive Event realization.");
  }
  const item = plan.items.find(i => i.id === "global-architecture");
  if (!item || item.status !== "verified" || !item.targetIds.includes(milestoneId)) {
    throw new Error("Milestone not authorized by the current verified architecture plan.");
  }
  const current = report.records.filter(r => r.metadata.status !== "superseded");
  const milestone = current.find(r => r.metadata.id === milestoneId && r.metadata.type === "milestone");
  if (!milestone || !Array.isArray(milestone.metadata.arcs) || !milestone.metadata.arcs.length) {
    throw new Error("Selected Milestone is absent or has no planned Arcs.");
  }
  const arcIds = milestone.metadata.arcs as string[];
  if (arcIds.some(id => !item.targetIds.includes(id))) {
    throw new Error("Milestone references an Arc outside the verified architecture cluster.");
  }
  const arcs = current.filter(r => arcIds.includes(r.metadata.id) && r.metadata.type === "arc");
  const characterIds = new Set(arcs.flatMap(r => r.metadata.characters as string[] ?? []));
  if (characterIds.size < 2) throw new Error("Event cluster requires linked Character foundations.");
  const related = current.filter(r =>
    r.metadata.type === "creative-direction" ||
    r.metadata.id === milestoneId || arcIds.includes(r.metadata.id) ||
    r.metadata.type === "character" && characterIds.has(r.metadata.id) ||
    r.metadata.type === "relationship" && (r.metadata.characters as string[] ?? []).some(id => characterIds.has(id)) ||
    r.metadata.type === "fact" && current.some(c => characterIds.has(c.metadata.id) &&
      (c.metadata.initial_knowledge as Array<{ fact: string }> ?? []).some(k => k.fact === r.metadata.id)) ||
    r.metadata.type === "event" && (r.metadata.arcs as string[] ?? []).some(id => arcIds.includes(id)) ||
    r.metadata.type === "world-entity" ||
    r.metadata.type === "revelation" && current.some(f => f.metadata.type === "fact" && f.metadata.id === r.metadata.fact));
  if (related.filter(r => r.metadata.type === "creative-direction").length !== 1) {
    throw new Error("Cannot select a unique current Creative Direction.");
  }
  return { milestoneId, milestonePath: milestone.path, arcIds, characterIds: [...characterIds].sort(), workItemId,
    sourcePaths: related.map(r => r.path).sort(), contract: plan.contract,
    authority: { existingProtectedChoices: "no-retcon",
      delegatedChoices: "draft", signingRequiredForProtectedChanges: true } };
}
export async function changedPaths(job: JobStartResult, assignment: EventAssignment, manifest: string[],
  allowEmpty = false): Promise<string[]> {
  const paths: string[] = [];
  const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
  for (const entry of dirty(job)) {
    if (![" M", "??"].includes(entry.slice(0, 2))) {
      throw new Error("Unexpected staged, renamed or deleted file during Event authoring: " + entry);
    }
    const full = entry.slice(3);
    if (!full.startsWith(prefix)) throw new Error("Event specialist modified outside Story: " + full);
    const path = full.slice(prefix.length);
    const type = path.split("/")[0];
    const allowed = path === assignment.milestonePath ||
      /^(events|arcs|facts|revelations|relationships)\/[a-z][a-z0-9-]*\.md$/.test(path);
    if (!allowed) throw new Error("Unauthorized Event specialist path: " + path);
    const target = join(job.worktreeStoryRoot, path);
    if (await realpath(target) !== target || !(await lstat(target)).isFile()) {
      throw new Error("Unsafe Event specialist output: " + path);
    }
    if (path === assignment.milestonePath) {
      const previous = git(job, "show", "HEAD:" + repoPath(job, path));
      assertMilestoneFulfillmentOnly(previous, await readFile(target, "utf8"), true);
    } else if (type !== "events" && entry.slice(0, 2) === " M" &&
               !assignment.sourcePaths.includes(path)) {
      throw new Error("Event specialist edited an unrelated canonical record: " + path);
    } else if (type === "arcs" && !assignment.sourcePaths.includes(path)) {
      throw new Error("Event specialist cannot create or revise an unplanned Arc: " + path);
    }
    paths.push(path);
  }
  paths.sort();
  // An already fulfilled Milestone need not be rewritten just to produce a diff.
  // Reachability and linkage are checked from the final canonical catalog below.
  if (!allowEmpty && !paths.some(p => p.startsWith("events/"))) {
    throw new Error("Event specialist must change at least one Event in its assigned cluster.");
  }
  const declared = [...new Set(manifest)].sort();
  if (JSON.stringify(paths) !== JSON.stringify(declared)) {
    // #158: A bounded Event writer can accidentally list the SELECTED
    // planning Milestone even after leaving it untouched and partial. The
    // exact Git diff is the authority. Only discard this one redundant,
    // original-source-identical path; never infer missing edits, ignore other
    // overclaims, or accept an unauthorized/protected mutation.
    const extra = assignment.milestonePath;
    if (manifest.length === declared.length && declared.includes(extra) &&
        !paths.includes(extra) &&
        JSON.stringify(paths) === JSON.stringify(declared.filter(p => p !== extra))) {
      const full = join(job.worktreeStoryRoot, extra);
      if (await realpath(full) === full && (await lstat(full)).isFile() &&
          await readFile(full, "utf8") === rawGit(job, "show", "HEAD:" + repoPath(job, extra)))
        return paths;
    }
    throw new Error("Event specialist modifiedRecords differ from the actual authorized Git diff: " +
      JSON.stringify({ expected: paths, declared: manifest }));
  }
  return paths;
}
async function contentDigest(job: JobStartResult, paths: string[]) {
  return hash(JSON.stringify(await Promise.all(paths.map(async path =>
    [path, hash(await readFile(join(job.worktreeStoryRoot, path)))]))));
}
/** Use ONLY native-validated metadata for the typed inventory. Actual Story bytes
 * provide exact source lines. Read-only related context is not a write grant. */
async function consequenceProof(job: JobStartResult, report: Report,
  assignment: EventAssignment, paths: string[], obligations: string[]) {
  const authored = report.records.filter(r => paths.includes(r.path) && r.metadata.type === "event")
    .map(r => r.path);
  const selected = [...new Set([assignment.milestonePath, ...authored,
    ...assignment.sourcePaths])];
  if (selected.length > 32) throw Error("Event consequence proof exceeds bounded source context.");
  const sources = await Promise.all(selected.map(async path => {
    const record = report.records.find(r => r.path === path);
    if (!record) throw Error("Event proof lacks native source metadata: " + path);
    return { path, metadata: record.metadata,
      content: await readFile(join(job.worktreeStoryRoot, path), "utf8") };
  }));
  return buildEventConsequenceProof(sources, assignment.milestoneId, authored, obligations);
}
function metadataReferences(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    if (/^(?:fact|revelation|relationship)\.[a-z][a-z0-9-]*$/.test(value)) found.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) metadataReferences(item, found);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) metadataReferences(item, found);
  }
  return found;
}
/** A staged Event may hand off the same formal binding to the later Choice
 * author, owner, specialist, writer or Choice Point. Do not mistake general mentions
 * of a future choice for an actual binding obligation. */
export function hasDeferredChoiceBinding(obligations: string[]): boolean {
  return obligations.some(obligation =>
    /choice[ -]?(?:point|binding|specialist|writer|owner)|\bformal choice\b|\bchoice[ -]?author\b.{0,120}\b(?:implement|enact|bind|author|write|create)\b/i.test(obligation));
}
/** A later, unrelated Story Choice cannot invalidate a currently completed
 * nondecision Milestone. The controller still treats an explicit Choice
 * requirement on THIS source Milestone, or an unqualified outstanding Choice
 * binding, as mandatory. This scopes model-authored handoff descriptions;
 * it never changes the immutable author objective or grants permission. */
export function currentMilestoneChoiceBinding(
  obligations: string[], milestoneId: string, sourceChange: string,
): boolean {
  // Model-generated handoff language cannot manufacture a Choice
  // requirement in an observed, nondecision Milestone. A later Choice can
  // still bind this Milestone only when the handoff explicitly says its
  // Choice *outcomes* are required, not merely that a later Event route
  // should be reassessed after a future Choice.
  const observed = observedNondecisionMilestone(sourceChange);
  return obligations.some(obligation =>
    hasDeferredChoiceBinding([obligation]) &&
    (!observed ||
      !/\b(?:later|future|subsequent|another|next|after)\b/i.test(obligation) ||
      obligation.includes(milestoneId) &&
        /\b(?:outcomes?|effects|branches|chooses?|decision)\b/i.test(obligation) &&
        /\b(?:must|required|needs?)\b/i.test(obligation)));
}
/** Structural fulfillment is not a verdict about narrative evidence.
 * An explicitly authorized Event owner must supply the binding and native
 * reachability, then the independent reviewer judges the actual prose. */
export function eventFulfillmentDefect(assignment: Pick<EventAssignment, "milestoneId" | "milestonePath">,
  eventIds: readonly string[], reason: "missing-binding" | "unreachable-binding") {
  return { kind: "semantic" as const, path: assignment.milestonePath,
    code: "event-" + reason, pointer: "fulfillment.any_of",
    detail: "EVENT FULFILLMENT: " + assignment.milestoneId +
      (reason === "missing-binding"
        ? " is still partial or has no fulfillment route. This is a formal binding omission, NOT a finding that the prose lacks evidence."
        : " has a declared fulfillment route that native coverage has not proven reachable.") +
      " Inspect its exact change and existing Event prose. Distinguish an NPC expressing their own wishes from an actual player decision; " +
      " a future decision in another Milestone is not a reason to leave this nondecision Milestone unbound. " +
      " If the existing Event cluster fulfills the current promise, change ONLY the selected Milestone's YAML completeness and fulfillment.any_of to bind the real reachable Event IDs. " +
      " Preserve its body, protected decisions, and all existing prerequisites. Candidate authored IDs: " + JSON.stringify(eventIds) +
      ". Do not invent evidence or effects to satisfy a binding. If the narrative genuinely lacks required evidence, repair it within this same grant or report the specific dependency. " +
      " Independent semantic Review must still verify the binding's narrative sufficiency. Run story_validate and report the complete cumulative manifest." };
}

class EventFulfillmentError extends Error {
  constructor(readonly defect: ReturnType<typeof eventFulfillmentDefect>) { super(defect.detail); }
}

/** Native schema permits player-only inspection Events with participants: [].
 * Report the exact record and field for every actual cluster violation. */
export function eventClusterDefects(authored: Array<Pick<RecordItem, "path" | "metadata">>,
  assignment: Pick<EventAssignment, "milestonePath" | "arcIds" | "characterIds">) {
  const defects: Array<ReturnType<typeof eventFulfillmentDefect>> = [];
  const add = (path: string, pointer: string, detail: string) =>
    defects.push({ kind: "semantic", path, code: "event-cluster-" + pointer,
      pointer, detail });
  if (!authored.length) add(assignment.milestonePath, "events", "No authorized Event record was authored.");
  for (const { path, metadata: m } of authored) {
    if (!Array.isArray(m.arcs) || !m.arcs.length || m.arcs.some(id => !assignment.arcIds.includes(id)))
      add(path, "arcs", m.id + ": arcs must be a nonempty subset of the selected cluster " +
        JSON.stringify(assignment.arcIds) + "; received " + JSON.stringify(m.arcs));
    if (!Array.isArray(m.participants) || m.participants.some(id => !assignment.characterIds.includes(id)))
      add(path, "participants", m.id + ": participants must contain only authorized Character IDs " +
        JSON.stringify(assignment.characterIds) + "; received " + JSON.stringify(m.participants) +
        ". An empty array is valid for a player-only occurrence without NPC participants.");
    if (!Array.isArray(m.consequences) || !m.consequences.length)
      add(path, "consequences", m.id + ": provide at least one justified causal consequence.");
    if (!Array.isArray(m.prerequisites?.any_of) || !m.prerequisites.any_of.length)
      add(path, "prerequisites.any_of", m.id + ": provide a native-valid causal prerequisite route.");
  }
  return defects;
}

function acceptance(report: Report, assignment: EventAssignment, paths: string[], obligations: string[]) {
  const records = report.records.filter(r => r.metadata.status !== "superseded");
  if (paths.some(path => !records.some(r => r.path === path))) {
    throw new Error("Canonical catalog did not recognize every authored Event record.");
  }
  const authored = records.filter(r => paths.includes(r.path) && r.metadata.type === "event");
  const defects = eventClusterDefects(authored, assignment);
  if (defects.length) throw new EventFulfillmentError(defects[0]!);
  const routes = report.coverage.milestoneRoutes.find(m => m.id === assignment.milestoneId)?.routes ?? [];
  const milestone = records.find(r => r.metadata.id === assignment.milestoneId && r.metadata.type === "milestone");
  if (!milestone || !Array.isArray(milestone.metadata.fulfillment?.any_of)) {
    throw new Error("Selected Milestone lacks a valid fulfillment declaration.");
  }
  const missingChoice = currentMilestoneChoiceBinding(
    obligations, assignment.milestoneId, String(milestone.metadata.change ?? ""));
  const deferredChoice = milestone.metadata.completeness === "partial" &&
    milestone.metadata.fulfillment.any_of.length === 0 && missingChoice;
  if (missingChoice && !deferredChoice) {
    throw new Error("Unbound Choice obligation cannot certify a completed Milestone or authored fulfillment IDs.");
  }
  if (!deferredChoice && (!milestone.metadata.fulfillment.any_of.length ||
      milestone.metadata.completeness === "partial"))
    throw new EventFulfillmentError(eventFulfillmentDefect(assignment,
      authored.map(r => r.metadata.id), "missing-binding"));
  if (!deferredChoice && (routes.length !== milestone.metadata.fulfillment.any_of.length ||
      !routes.some(r => r.status === "reachable") || routes.some(r => r.status === "impossible")))
    throw new EventFulfillmentError(eventFulfillmentDefect(assignment,
      authored.map(r => r.metadata.id), "unreachable-binding"));
  if (!deferredChoice && milestone.metadata.fulfillment.any_of.every((route: string[]) =>
    !route.some(id => authored.some(event => event.metadata.id === id)))) {
    throw new Error("Selected Milestone's fulfillment does not use the authored Event cluster.");
  }
  if (!deferredChoice && authored.some(event => event.metadata.completeness === "partial")) {
    throw new Error("A partial Event cannot certify complete Milestone fulfillment.");
  }
  const refs = metadataReferences(authored.map(r => ({
    prerequisites: r.metadata.prerequisites, steps: r.metadata.steps,
  })));
  const crossDomain = records.filter(r => paths.includes(r.path) &&
    ["fact", "revelation", "relationship"].includes(r.metadata.type));
  for (const record of crossDomain) {
    if (record.metadata.type === "relationship" &&
        (record.metadata.characters as string[] ?? []).some(id => !assignment.characterIds.includes(id))) {
      throw new Error("Event specialist linked a Relationship outside the selected Character cluster: " + record.path);
    }
    const connected = refs.has(record.metadata.id) ||
      record.metadata.type === "fact" && records.some(other =>
        paths.includes(other.path) && other.metadata.type === "revelation" &&
        other.metadata.fact === record.metadata.id && refs.has(other.metadata.id));
    if (!connected) throw new Error("Event specialist changed an unconnected cross-domain record: " + record.path);
  }
  const eventIds = authored.map(r => r.metadata.id).sort();
  const progress = report.coverage.eventProgress.filter(e => eventIds.includes(e.id));
  const branches = report.coverage.branchProgress.filter(b => eventIds.includes(b.event));
  if (progress.length !== eventIds.length || progress.some(p => p.status !== "reachable") ||
      branches.some(b => b.status === "impossible" || b.status === "incomplete")) {
    throw new Error("Authored Event prerequisites/branches are not proven structurally reachable.");
  }
  return { eventIds, routes, milestoneState: deferredChoice ? "partial-choice-pending" as const : "complete" as const,
    eventProgress: progress, branchProgress: branches,
    remaining: report.outstanding.filter(o => records.some(r => r.path === o.path &&
      (paths.includes(r.path) || r.metadata.id === assignment.milestoneId))),
    truncated: report.coverage.search.truncated };
}
async function publishHead(job: JobStartResult, prior: string, commit: string, workItem: string) {
  const file = join(job.stateDir, "revisions", "verified-head.json");
  await mkdir(dirname(file), { recursive: true });
  if (existsSync(file)) {
    const previous = JSON.parse(await readFile(file, "utf8")) as { version: number; jobId: string; headSha: string };
    if (previous.version !== 1 || previous.jobId !== job.jobId ||
        (previous.headSha !== prior && previous.headSha !== commit)) {
      throw new Error("Different verified-head receipt exists; manual reconciliation required.");
    }
    if (previous.headSha === commit) {
      await finalizeRecoveryCheckpoint(job, workItem, prior, commit);
      return;
    }
  }
  await persist(file, { version: 1, jobId: job.jobId, headSha: commit, workItemId: workItem });
  await finalizeRecoveryCheckpoint(job, workItem, prior, commit);
}
function verifyCommit(job: JobStartResult, receipt: EventReceipt, commit: string) {
  // A post-approval challenge is noncanonical model evidence, but its exact
  // submitted bytes must be attributable to this immutable Event commit.
  const challengeTrailer = git(job, "log", "-1", "--format=%B", commit).split("\n")
    .find(line => line.startsWith("NovelTea-Blueprint-Challenge: "));
  if (challengeTrailer !== (receipt.blueprintChallenge
    ? "NovelTea-Blueprint-Challenge: " + hash(JSON.stringify(receipt.blueprintChallenge))
    : undefined)) throw Error("Event Blueprint challenge differs from the committed specialist report.");
  if (!receipt.contentDigest || !receipt.paths ||
      !git(job, "log", "-1", "--format=%B", commit).split("\n").includes(
        "NovelTea-Job: " + commitOrigin(job, receipt.workItemId, commit).jobId) ||
      git(job, "rev-parse", commit + "^") !== receipt.expectedHead ||
      !git(job, "log", "-1", "--format=%B", commit).includes("NovelTea-Event-Design: " + receipt.contentDigest) ||
      !git(job, "log", "-1", "--format=%B", commit).includes("NovelTea-Work-Item: " + receipt.workItemId + "\n") ||
      !git(job, "log", "-1", "--format=%B", commit).includes("NovelTea-Plan-Version: " + receipt.planVersion + "\n") ||
      (receipt.blueprintRequired && (!receipt.blueprintPin ||
        !git(job, "log", "-1", "--format=%B", commit).split("\n")
          .includes("NovelTea-Milestone-Blueprint: " + receipt.blueprintPin.digest)))) {
    throw new Error("Event commit provenance or previous verified HEAD changed.");
  }
  if (receipt.consequenceProof && !git(job, "log", "-1", "--format=%B", commit)
    .split("\n").includes("NovelTea-Event-Consequence: " +
      eventConsequenceProofDigest(receipt.consequenceProof))) {
    throw new Error("Committed Event typed consequence proof differs from its sealed source.");
  }
  if (receipt.validation?.milestoneState &&
      !git(job, "log", "-1", "--format=%B", commit).includes("NovelTea-Event-Completion: " +
        eventCompletionDigest({ milestoneId: receipt.milestoneId,
          expectedHead: receipt.expectedHead, snapshotId: receipt.snapshot!.id,
          contentDigest: receipt.contentDigest, eventIds: receipt.validation.eventIds,
          milestoneState: receipt.validation.milestoneState, obligations: receipt.obligations ?? [] }))) {
    throw new Error("Committed Event completion/Choice handoff has changed since its sealed source.");
  }
  const files = git(job, "diff-tree", "--no-commit-id", "--name-only", "-r", commit).split("\n").filter(Boolean).sort();
  if (JSON.stringify(files) !== JSON.stringify(receipt.paths.map(p => repoPath(job, p)).sort())) {
    throw new Error("Event commit contains unreviewed or missing files.");
  }
}
export interface EventBlueprintPrerequisite {
  milestoneId: string;
  expectedHead: string;
  planVersion: number;
  blueprintDigest: string;
  reportDigest: string;
  blockers: Array<ReturnType<typeof milestoneCharacterPrerequisites>[number] & {
    readiness: "unrealized-character" | "outside-event-authority";
  }>;
}

/** A pre-dispatch readiness report is not a specialist result or a write
 * lease. Reconstruct it from the independently reviewed plan and native
 * catalog while the source is still the original clean HEAD. */
async function blueprintPrerequisite(job: JobStartResult, receipt: EventReceipt, plan: Plan,
  source: Report): Promise<EventBlueprintPrerequisite | null> {
  if (!receipt.blueprintPin || receipt.phase !== "ready" || receipt.sessionFile && !receipt.writerContinuation ||
      receipt.invocationSource || receipt.claimedPaths?.length ||
      receipt.planVersion !== plan.version || receipt.planDigest !== hash(JSON.stringify(plan)) ||
      receipt.expectedHead !== await trustedHead(job) || dirty(job).length)
    throw Error("Blueprint readiness requires the original clean, unstarted Event assignment.");
  const assignment = { ...selectedAssignment(job, plan, source, receipt.milestoneId, receipt.workItemId),
    ...(receipt.blueprintSource ? { blueprintSource: receipt.blueprintSource } : {}) };
  const design = await readReviewedMilestoneBlueprint(job, receipt.blueprintPin, assignment);
  const blockers = milestoneCharacterPrerequisites(design, assignment).map(blocker => ({
    ...blocker,
    readiness: source.records.some(record => record.metadata.id === blocker.characterId &&
      record.metadata.type === "character" && record.metadata.status !== "superseded")
      ? "outside-event-authority" as const : "unrealized-character" as const,
  }));
  if (!blockers.length) return null;
  if (receipt.writerContinuation) throw Error("Re-reviewed continuation Blueprint still requires an unrealized predecessor.");
  const body = { milestoneId: receipt.milestoneId, expectedHead: receipt.expectedHead,
    planVersion: receipt.planVersion, blueprintDigest: receipt.blueprintPin.digest, blockers };
  return { ...body, reportDigest: hash(JSON.stringify({ jobId: job.jobId, assignment, ...body })) };
}

export function blueprintReadinessHistory(job: JobStartResult, milestone: string, digest: string) {
  if (!idPattern.test(milestone) || !/^[a-f0-9]{64}$/.test(digest))
    throw Error("Invalid historical Blueprint readiness reference.");
  return join(job.stateDir, "event-blueprint-history", milestone.slice(10) + "-" + digest + ".json");
}

/** Historical source authentication: no need to replay native validation on
 * the successor's different catalog. Original native readiness was checked
 * before this sealed, unstarted receipt could be admitted to the work plan. */
export async function inspectArchivedEventBlueprintPrerequisite(job: JobStartResult,
  milestone: string, digest: string) {
  const path = blueprintReadinessHistory(job, milestone, digest);
  if (await realpath(path) !== path || !(await lstat(path)).isFile())
    throw Error("Unsafe archived Blueprint readiness receipt.");
  const receipt = JSON.parse(await readFile(path, "utf8")) as EventReceipt;
  const { blueprintPrerequisite: report, assignment, blueprintPin: pin } = receipt;
  if (!report || !assignment || !pin || receipt.phase !== "ready" ||
      receipt.jobId !== job.jobId || receipt.baseSha !== job.baseSha ||
      receipt.milestoneId !== milestone || receipt.workItemId !== "event-" + milestone.slice(10) ||
      receipt.worker !== "pi" || receipt.sessionFile || receipt.invocationSource ||
      receipt.blueprintSource || receipt.claimedPaths?.length ||
      report.reportDigest !== digest || report.expectedHead !== receipt.expectedHead ||
      report.planVersion !== receipt.planVersion || report.milestoneId !== milestone ||
      pin.sourceSha !== receipt.expectedHead || report.blueprintDigest !== pin.digest ||
      assignment.milestoneId !== milestone || assignment.workItemId !== receipt.workItemId)
    throw Error("Archived Blueprint readiness lost its exact unstarted Event source.");
  if (!receipt.snapshot) throw Error("Archived readiness lacks its pinned skill snapshot.");
  const design = await readReviewedMilestoneBlueprint(job, pin, assignment, {
    provider: receipt.provider, model: receipt.model, planDigest: receipt.planDigest,
    contractDigest: hash(JSON.stringify(assignment.contract)), snapshotId: receipt.snapshot.id,
  });
  const { reportDigest, blockers, ...body } = report;
  if (hash(JSON.stringify({ jobId: job.jobId, assignment, ...body, blockers })) !== reportDigest ||
      JSON.stringify(milestoneCharacterPrerequisites(design, assignment)) !==
        JSON.stringify(blockers.map(({ readiness: _, ...blocker }) => blocker)) ||
      blockers.some(b => !["unrealized-character", "outside-event-authority"].includes(b.readiness)))
    throw Error("Archived Blueprint readiness differs from its independently reviewed design.");
  rawGit(job, "merge-base", "--is-ancestor", receipt.expectedHead, "HEAD");
  return { report, assignment, pin, receipt };
}

export async function archiveEventBlueprintPrerequisite(job: JobStartResult, report: EventBlueprintPrerequisite,
  validatorSource?: string) {
  const original = await inspectEventBlueprintPrerequisite(job, report.milestoneId, validatorSource);
  if (JSON.stringify(original) !== JSON.stringify(report))
    throw Error("Blueprint predecessor admission lost the original native readiness.");
  const receipt = JSON.parse(await readFile(join(job.stateDir, "event-items",
    report.milestoneId.slice(10) + ".json"), "utf8")) as EventReceipt;
  const path = blueprintReadinessHistory(job, report.milestoneId, report.reportDigest);
  if (existsSync(path)) {
    if (JSON.stringify(JSON.parse(await readFile(path, "utf8"))) !== JSON.stringify(receipt))
      throw Error("Archived Blueprint readiness was replaced.");
  } else await persist(path, receipt);
  return inspectArchivedEventBlueprintPrerequisite(job, report.milestoneId, report.reportDigest);
}

/** Reauthenticate the complete serial supporting chain from the original
 * Blueprint. No original Event writer or new Blueprint author is invoked. */
export async function inspectBlueprintPredecessorCompletion(job: JobStartResult,
  milestone: string, digest: string) {
  const original = await inspectArchivedEventBlueprintPrerequisite(job, milestone, digest);
  const { inspectDependencyPlan, dependencyDigest, verifiedDependencyEntries } = await import("./dependency-state.js");
  const plan = await inspectDependencyPlan(job);
  const roots = plan?.entries.filter(e => e.blueprintSource?.readinessDigest === digest) ?? [];
  const targets = [...new Set(original.report.blockers.map(b => b.characterId))];
  if (!plan || roots.length !== targets.length ||
      targets.some(target => !roots.some(e => e.blueprintSource?.target === target)))
    throw Error("Blueprint predecessor work is not yet independently verified.");
  const entries = verifiedDependencyEntries(plan, roots.map(e => e.reportDigest));
  let head = original.report.expectedHead;
  for (const entry of roots) {
    if (entry.report.sourceSha !== head) throw Error("Blueprint predecessor chain has a substituted source.");
    head = entry.commitSha!;
  }
  return { original, entries, head, digest: dependencyDigest(entries.map(e => dependencyDigest(e))) };
}

export async function authenticateReboundBlueprint(job: JobStartResult, pin: MilestoneBlueprintPin,
  assignment: Pick<EventAssignment, "milestoneId" | "milestonePath" | "sourcePaths" | "characterIds" | "blueprintSource">) {
  const binding = assignment.blueprintSource;
  if (!binding || binding.sourceSha !== pin.sourceSha) throw Error("Blueprint successor lacks its original source binding.");
  const completion = await inspectBlueprintPredecessorCompletion(job, pin.milestoneId, binding.reportDigest);
  const original = completion.original;
  if (JSON.stringify(original.pin) !== JSON.stringify(pin) ||
      assignment.milestoneId !== original.assignment.milestoneId ||
      assignment.milestonePath !== original.assignment.milestonePath ||
      JSON.stringify(binding.sourcePaths) !== JSON.stringify(original.assignment.sourcePaths) ||
      JSON.stringify(binding.characterIds) !== JSON.stringify(original.assignment.characterIds) ||
      binding.sourcePaths.some(path => !assignment.sourcePaths.includes(path)) ||
      JSON.stringify([...new Set([...binding.characterIds, ...original.report.blockers.map(b => b.characterId)])].sort()) !== JSON.stringify(assignment.characterIds))
    throw Error("Rebound Event no longer consumes the exact reviewed Blueprint and verified Character predecessors.");
  return { ...assignment, sourcePaths: binding.sourcePaths, characterIds: binding.characterIds, blueprintSource: undefined };
}

/** Read an approval at its historical source. A different writer base must
 * be the exact tip of the independently verified supporting plan, not merely
 * a Git descendant. readReviewedMilestoneBlueprint verifies the bound scope. */
export async function readEventSourceBlueprint(job: JobStartResult, pin: MilestoneBlueprintPin,
  assignment: EventAssignment, writerBase: string) {
  if (pin.sourceSha !== writerBase || assignment.blueprintSource) {
    const binding = assignment.blueprintSource;
    if (!binding || binding.sourceSha !== pin.sourceSha)
      throw new ProtocolIntegrityBlockedError("Event writer base lacks its original reviewed Blueprint source.");
    const completion = await inspectBlueprintPredecessorCompletion(job, pin.milestoneId, binding.reportDigest);
    if (completion.head !== writerBase || JSON.stringify(completion.original.pin) !== JSON.stringify(pin))
      throw new ProtocolIntegrityBlockedError("Event writer base is not the verified Blueprint predecessor tip.");
  }
  const design = await readReviewedMilestoneBlueprint(job, pin, assignment);
  if (design.upstreamCorrection)
    throw new ProtocolIntegrityBlockedError("A Blueprint with an unsettled canonical owner finding cannot authorize Event writing.");
  return design;
}

export async function rebindEventAfterBlueprintPredecessors(job: JobStartResult,
  milestone: string, digest: string, validatorSource?: string) {
  const completed = await inspectBlueprintPredecessorCompletion(job, milestone, digest);
  if (await trustedHead(job) !== completed.head || dirty(job).length)
    throw Error("Event successor requires the exact independently verified predecessor HEAD.");
  const file = join(job.stateDir, "event-items", milestone.slice(10) + ".json");
  const current = JSON.parse(await readFile(file, "utf8")) as EventReceipt;
  const original = completed.original;
  const binding = { reportDigest: digest, sourceSha: original.report.expectedHead,
    sourcePaths: original.assignment.sourcePaths, characterIds: original.assignment.characterIds };
  const architecture = JSON.parse(await readFile(join(job.stateDir, "architecture.json"), "utf8")) as ArchitectureReceipt;
  if (architecture.jobId !== job.jobId || architecture.phase !== "committed" || !architecture.plan ||
      architecture.plan.version !== original.report.planVersion ||
      hash(JSON.stringify(architecture.plan)) !== original.receipt.planDigest)
    throw Error("Event successor lost its original approved Architecture plan.");
  const source = reportOf(await validateStoryJob(job, validatorSource,
    { ...job, baseSha: completed.head }), completed.head);
  const assignment = { ...selectedAssignment(job, architecture.plan, source, milestone, original.receipt.workItemId),
    blueprintSource: binding };
  const design = await readReviewedMilestoneBlueprint(job, original.pin, assignment);
  if (milestoneCharacterPrerequisites(design, assignment).length ||
      original.report.blockers.some(b => !source.records.some(r => r.metadata.id === b.characterId &&
        r.metadata.type === "character" && r.metadata.status !== "superseded")))
    throw Error("Verified supporting work did not realize all Event prerequisites in native canon.");
  if (current.blueprintSource) {
    if (current.phase !== "ready" || current.expectedHead !== completed.head ||
        JSON.stringify(current.blueprintSource) !== JSON.stringify(binding) ||
        JSON.stringify(current.blueprintPin) !== JSON.stringify(original.pin))
      throw Error("Original Event successor receipt changed.");
    return completed;
  }
  if (JSON.stringify(current) !== JSON.stringify(original.receipt))
    throw Error("Original unstarted Event receipt changed before predecessor completion.");
  const { assignmentKey: _, blueprintPrerequisite: _report, assignment: _assignment, ...base } = current;
  await persist(file, { ...base, expectedHead: completed.head, blueprintSource: binding, assignment });
  return completed;
}

export async function inspectEventBlueprintPrerequisite(job: JobStartResult, milestone: string,
  validatorSource?: string): Promise<EventBlueprintPrerequisite> {
  if (!idPattern.test(milestone)) throw Error("Invalid Blueprint readiness target.");
  const receipt = JSON.parse(await readFile(join(job.stateDir, "event-items",
    milestone.slice(10) + ".json"), "utf8")) as EventReceipt;
  const architecture = JSON.parse(await readFile(join(job.stateDir, "architecture.json"), "utf8")) as ArchitectureReceipt;
  if (receipt.jobId !== job.jobId || receipt.baseSha !== job.baseSha || receipt.milestoneId !== milestone ||
      receipt.workItemId !== "event-" + milestone.slice(10) || receipt.worker !== "pi" ||
      architecture.jobId !== job.jobId || architecture.phase !== "committed" || !architecture.plan ||
      !receipt.blueprintPrerequisite)
    throw Error("Blueprint readiness lost its original Event or Architecture receipt.");
  const source = reportOf(await validateStoryJob(job, validatorSource,
    { ...job, baseSha: receipt.expectedHead }), receipt.expectedHead);
  const original = await blueprintPrerequisite(job, receipt, architecture.plan, source);
  if (!original || JSON.stringify(original) !== JSON.stringify(receipt.blueprintPrerequisite))
    throw Error("Blueprint readiness differs from its original reviewed source and catalog.");
  return original;
}

/** Reopen the effect authority after the child releases the writer lease. Only
 * the sealed report, not free text returned in graph state, enters planning. */
/** Reauthenticate immutable no-write evidence at its original source. This
 * is equally required at live admission, signed amendment replay and
 * historical inspection. Callers separately establish current HEAD/plan
 * authority; an archived receipt alone cannot authorize any writer. */
export async function authenticateSettledEventNoWrite(job: JobStartResult, saved: unknown, historical = false) {
  const original = saved as EventReceipt;
  if (!original || original.version !== 1 || original.jobId !== job.jobId ||
      original.baseSha !== job.baseSha || !idPattern.test(original.milestoneId) ||
      original.workItemId !== "event-" + original.milestoneId.slice(10) ||
      original.phase !== "prerequisite-reported" || original.worker !== "pi" ||
      original.assignment?.milestoneId !== original.milestoneId ||
      original.assignment.workItemId !== original.workItemId ||
      original.claimedPaths?.length || original.reroutedFrom || original.reroutedTask ||
      !original.invocationProof || original.invocationProof.sourceDigest !== original.invocationSource ||
      original.prerequisite?.sessionId !== original.sessionId)
    throw new ProtocolIntegrityBlockedError("Event no-write lacks its original settled invocation proof.");
  const response = await verifySettledAssignment({ ...eventInvocationOptions(job, original),
    proof: original.invocationProof, effect: null, historical });
  const manifest = parseEventManifest(JSON.stringify(response));
  if (manifest.modifiedRecords.length || JSON.stringify(manifest.architecturalConflicts) !== JSON.stringify(original.conflicts) ||
      JSON.stringify(manifest.laterObligations) !== JSON.stringify(original.obligations) ||
      JSON.stringify(manifest.causalDiscovery) !== JSON.stringify(original.causalDiscovery) ||
      JSON.stringify(manifest.blueprintFinding) !== JSON.stringify(original.blueprintFinding) ||
      JSON.stringify(manifest.dependencyFinding) !== JSON.stringify(original.dependencyFinding))
    throw new ProtocolIntegrityBlockedError("Event no-write report differs from the original settled response.");
  return authenticateEventNoWrite(job, original, historical);
}

export async function inspectEventNoWrite(job: JobStartResult, milestone: string,
  head: string, planVersion: number | null) {
  if (!idPattern.test(milestone)) throw new ProtocolIntegrityBlockedError("Invalid Event no-write target.");
  return withStoryJobLockOrReuse(job, "event-no-write-admission", [
    "assess-source-bound-operation", "assess-original-operation-diagnostic",
    "generation-c05-resolution-proof", "generation-inspect",
  ], async () => {
    const original = JSON.parse(await readFile(join(job.stateDir, "event-items",
      milestone.slice(10) + ".json"), "utf8")) as EventReceipt;
    if (original.milestoneId !== milestone || original.expectedHead !== head ||
        original.planVersion !== planVersion || await trustedHead(job) !== head ||
        dirty(job).length || await assignmentDraftEffect(job, head) !== null)
      throw new ProtocolIntegrityBlockedError("Event no-write lacks its clean original assignment source.");
    const prerequisite = await authenticateSettledEventNoWrite(job, original);
    return { prerequisite, conflicts: original.conflicts!, obligations: original.obligations!,
      causalDiscovery: original.causalDiscovery, dependencyFinding: original.dependencyFinding };
  });
}

function blueprintOwnerSeal(receipt: EventReceipt, finding: import("./dependency-amendments.js").WriterDependencyFinding) {
  return hash(JSON.stringify({ jobId: receipt.jobId, baseSha: receipt.baseSha, workItemId: receipt.workItemId,
    assignmentKey: receipt.assignmentKey, planVersion: receipt.planVersion, planDigest: receipt.planDigest,
    head: receipt.expectedHead, pin: receipt.blueprintPin, assignment: receipt.assignment, finding }));
}
function writerNegativePath(job: JobStartResult, milestone: string, sealDigest: string) {
  if (!idPattern.test(milestone) || !/^[a-f0-9]{64}$/.test(sealDigest))
    throw Error("Invalid original Event prerequisite reference.");
  return join(job.stateDir, "event-writer-prerequisites", milestone.slice(10) + "-" + sealDigest + ".json");
}

/** Reopen the immutable original invocation even after the same Pi session
 * has been continued at a newly verified source. No historical receipt can
 * itself grant a new writer invocation. */
export async function inspectEventWriterDependency(job: JobStartResult, milestone: string, sealDigest: string):
    Promise<import("./writer-dependency.js").OriginalWriterDependency> {
  const archived = writerNegativePath(job, milestone, sealDigest);
  const historical = existsSync(archived);
  const path = historical ? archived : join(job.stateDir, "event-items", milestone.slice(10) + ".json");
  if (await realpath(path) !== path || !(await lstat(path)).isFile()) throw Error("Unsafe Event prerequisite source.");
  const receipt = JSON.parse(await readFile(path, "utf8")) as EventReceipt;
  if (receipt.blueprintOwnerFinding) {
    const { finding, sealDigest: sealed } = receipt.blueprintOwnerFinding;
    if (receipt.jobId !== job.jobId || receipt.baseSha !== job.baseSha ||
        receipt.milestoneId !== milestone || receipt.workItemId !== "event-" + milestone.slice(10) ||
        receipt.phase !== "ready" || receipt.worker !== "pi" || receipt.sessionFile || receipt.sessionId ||
        receipt.invocationSource || receipt.invocationProof || receipt.prerequisite || receipt.blueprintPrerequisite ||
        receipt.claimedPaths?.length || !receipt.assignmentKey || !receipt.assignment?.dependencyObligations ||
        !receipt.blueprintPin || receipt.blueprintPin.sourceSha !== receipt.expectedHead ||
        sealDigest !== sealed || sealed !== blueprintOwnerSeal(receipt, finding))
      throw Error("Blueprint owner finding lacks its exact original unstarted Event and approved design.");
    const design = await readReviewedMilestoneBlueprint(job, receipt.blueprintPin, receipt.assignment);
    if (JSON.stringify(design.upstreamCorrection) !== JSON.stringify(finding))
      throw Error("Blueprint owner finding differs from the independently reviewed design.");
    rawGit(job, "merge-base", "--is-ancestor", receipt.expectedHead, "HEAD");
    if (!historical && (await trustedHead(job) !== receipt.expectedHead || dirty(job).length))
      throw Error("Blueprint owner finding is not at its original clean source.");
    return { stage: "event", origin: "blueprint", milestoneId: milestone, workItemId: receipt.workItemId,
      planVersion: receipt.planVersion, sealDigest, assignmentKey: receipt.assignmentKey,
      head: receipt.expectedHead, sourcePaths: receipt.assignment.sourcePaths,
      obligations: receipt.assignment.dependencyObligations, finding,
      predecessor: (await import("./writer-dependency.js")).writerPredecessor(receipt.writerContinuation) };
  }
  const seal = await authenticateSettledEventNoWrite(job, receipt, historical);
  if (receipt.milestoneId !== milestone || seal.reportDigest !== sealDigest ||
      !receipt.dependencyFinding || !receipt.assignmentKey ||
      !receipt.assignment?.dependencyObligations || !receipt.blueprintPin)
    throw Error("Event writer prerequisite lost its original typed finding and assignment.");
  rawGit(job, "merge-base", "--is-ancestor", receipt.expectedHead, "HEAD");
  return { stage: "event", milestoneId: milestone, workItemId: receipt.workItemId,
    planVersion: receipt.planVersion, sealDigest, assignmentKey: receipt.assignmentKey,
    head: receipt.expectedHead, sourcePaths: receipt.assignment.sourcePaths,
    obligations: receipt.assignment.dependencyObligations, finding: receipt.dependencyFinding,
    predecessor: (await import("./writer-dependency.js")).writerPredecessor(receipt.writerContinuation) };
}

export async function archiveEventWriterDependency(job: JobStartResult, milestone: string, sealDigest: string) {
  const original = await inspectEventWriterDependency(job, milestone, sealDigest);
  const archived = writerNegativePath(job, milestone, sealDigest);
  if (!existsSync(archived)) {
    const receipt = JSON.parse(await readFile(join(job.stateDir, "event-items", milestone.slice(10) + ".json"), "utf8")) as EventReceipt;
    if (await trustedHead(job) !== original.head || dirty(job).length ||
        (receipt.blueprintOwnerFinding?.sealDigest ?? receipt.prerequisite?.reportDigest) !== sealDigest)
      throw Error("Event prerequisite must be archived before supporting writes.");
    await readReviewedMilestoneBlueprint(job, receipt.blueprintPin!, receipt.assignment!);
    await persist(archived, receipt);
  }
  return original;
}

/** Called by the existing parent after independent support and affected-only
 * revalidation. The old Blueprint is archived, not silently transplanted
 * onto different canonical bytes. The original writer/session is retained. */
export async function rebindEventAfterWriterDependency(job: JobStartResult,
  source: import("./writer-dependency.js").WriterDependencySource, reportDigest: string, supportRef: string) {
  const { inspectDependencyPlan, dependencyDigest } = await import("./dependency-state.js");
  const entry = (await inspectDependencyPlan(job))?.entries.find(e => e.reportDigest === reportDigest);
  if (!entry?.writerSource || dependencyDigest(entry.writerSource) !== dependencyDigest(source) ||
      entry.phase !== "verified" || !entry.commitSha || entry.review?.verdict !== "pass" ||
      dependencyDigest(entry) !== supportRef)
    throw Error("Event continuation lacks verified original supporting work.");
  const head = await trustedHead(job);
  const { assertCompletedOtherOwnerRevalidation } = await import("./selective-revalidation-work.js");
  await assertCompletedOtherOwnerRevalidation(job, { baseSha: entry.report.sourceSha,
    successorSha: entry.commitSha, turnDigest: entry.report.turnDigest, path: source.targetPath });
  const original = await inspectEventWriterDependency(job, source.milestoneId, source.sealDigest);
  const historical = JSON.parse(await readFile(writerNegativePath(job, source.milestoneId, source.sealDigest), "utf8")) as EventReceipt;
  const file = join(job.stateDir, "event-items", source.milestoneId.slice(10) + ".json");
  const current = JSON.parse(await readFile(file, "utf8")) as EventReceipt;
  const binding = { reportDigest, supportRef, originalHead: original.head,
    ...(historical.prerequisite ? { sessionSha256: historical.prerequisite.sessionSha256 } : {}) };
  if (current.writerContinuation?.reportDigest === reportDigest) {
    if (JSON.stringify(current.writerContinuation) !== JSON.stringify(binding) ||
        current.assignmentKey !== original.assignmentKey || !original.origin && (current.sessionFile !== historical.sessionFile ||
        current.sessionId !== historical.sessionId))
      throw Error("Event continuation receipt changed its original writer.");
    return current.expectedHead;
  }
  if (dirty(job).length || (current.blueprintOwnerFinding?.sealDigest ?? current.prerequisite?.reportDigest) !== source.sealDigest ||
      current.assignmentKey !== original.assignmentKey || JSON.stringify(current) !== JSON.stringify(historical))
    throw Error("Event continuation lost its exact settled predecessor.");
  await archiveReviewedMilestoneBlueprint(job, historical.blueprintPin!, historical.assignment!);
  const { blueprintOwnerFinding: _owner, blueprintPin: _pin, blueprintSource: _source, blueprintPrerequisite: _readiness,
    assignment: _assignment, invocationProof: _proof, invocationSource: _invocation,
    prerequisite: _negative, conflicts: _conflicts, obligations: _obligations, dependencyFinding: _finding,
    claimedPaths: _claims, causalDiscovery: _causal, blueprintFinding: _bpFinding, ...rest } = current;
  await persist(file, { ...rest, phase: "ready", expectedHead: head, writerContinuation: binding });
  return head;
}

function output(job: JobStartResult, state: EventReceipt) {
  return { status: state.phase === "committed" ? "event-cluster-committed" :
    state.phase === "prerequisite-reported" ? "event-prerequisite-reported" :
    state.blueprintOwnerFinding ? "event-blueprint-owner-prerequisite" :
    state.blueprintPrerequisite ? "event-blueprint-prerequisite" : state.phase,
    blueprintOwnerFinding: state.blueprintOwnerFinding,
    jobId: job.jobId, milestoneId: state.milestoneId, workItemId: state.workItemId,
    worktreeStoryRoot: job.worktreeStoryRoot, headSha: state.commitSha ?? state.expectedHead,
    expectedHead: state.expectedHead, planVersion: state.planVersion, phase: state.phase,
    specialist: "nt-event-design", paths: state.paths, validation: state.validation,
    obligations: state.obligations, conflicts: state.conflicts,
    outstanding: state.validation?.remaining ?? [],
    failure: state.failure, prerequisite: state.prerequisite, causalDiscovery: state.causalDiscovery,
    blueprintPrerequisite: state.blueprintPrerequisite,
    reroutedFrom: state.reroutedFrom,
    sessionFile: state.sessionFile, skillReads: state.skillReads,
    consequenceProof: state.consequenceProof,
    milestoneBlueprint: state.blueprintPin ? { status: "approved", ...state.blueprintPin } : undefined,
    skillSnapshot: state.snapshot?.id,
    completionEvidence: { eventReachability: state.phase === "committed",
      milestoneState: state.validation?.milestoneState ?? "unverified",
      deferredChoiceObligations: state.validation?.milestoneState === "partial-choice-pending"
        ? state.obligations ?? [] : [],
      editorial: "unverified", unrelatedComposition: "not-required", fullStory: false } };
}


/** Deterministic test transport for the corrective fixture cases. It emits
 * the same manifest and effects as Pi, but never supplies Pi assurance or
 * charges invented model usage. All correction policy lives in the shared
 * round service; this function only performs the admitted fixture effect. */


export async function runEventWorkItem(input: EventOptions) {
  if (input.fixture && input.action !== "inspect") throw Error("Structural fixture execution is retired; use an authenticated Generation assignment.");
  if (!idPattern.test(input.milestone)) throw new Error("--milestone must be a typed milestone.<slug> ID.");
  if (input.action === "run" && !input.round)
    throw Error("Event Pi writing requires its checkpointed Generation assignment child.");
  if (input.round && !/^[a-f0-9]{64}$/.test(input.round.assignmentKey))
    throw Error("Event round lacks its admitted assignment identity.");
  const job = await startStoryJob({ story: input.story, job: input.job }, false);
  const root = job.stateDir;
  const receiptFile = join(root, "event-items", input.milestone.slice(10) + ".json");
  if (input.action === "inspect" && !existsSync(receiptFile)) throw new Error("No Event work item receipt to inspect.");
  return withStoryJobLock(job, "event-" + input.milestone.slice(10), async () => {
    if (input.action === "run" && !await inspectPendingEventInvocation(job, input.milestone))
      await processAuthorUpdatesAtBoundary(job);
    if (!existsSync(join(root, "architecture.json")) || !existsSync(join(root, "character-world.json"))) {
      throw new Error("Event design requires committed architecture and Character/World foundations.");
    }
    const arch = JSON.parse(await readFile(join(root, "architecture.json"), "utf8")) as ArchitectureReceipt;
    const foundation = JSON.parse(await readFile(join(root, "character-world.json"), "utf8")) as FoundationsReceipt;
    if (arch.jobId !== job.jobId || arch.phase !== "committed" || !arch.plan ||
        foundation.jobId !== job.jobId ||
        foundation.units?.length !== 2 || foundation.units[0]?.id !== "world-foundations" ||
        foundation.units[1]?.id !== "character-foundations" ||
        foundation.units.some(u => u.phase !== "committed" || !u.commitSha)) {
      throw new Error("Event work item requires verified current Character/World foundations and architecture.");
    }
    assertFoundationArchitectureContinuity(job, arch, foundation);
    if (!git(job, "log", "-1", "--format=%B", foundation.units[1]!.commitSha!)
      .includes("NovelTea-Work-Item: character-foundations")) {
      throw new Error("Character foundation commit does not carry verified work-item provenance.");
    }
    try {
      rawGit(job, "merge-base", "--is-ancestor", foundation.architectureHead, foundation.units[0]!.commitSha!);
      rawGit(job, "merge-base", "--is-ancestor", foundation.units[0]!.commitSha!, foundation.units[1]!.commitSha!);
      if (foundation.architectureHead !== arch.expectedHead)
        rawGit(job, "merge-base", "--is-ancestor", foundation.units[1]!.commitSha!, arch.expectedHead);
      rawGit(job, "merge-base", "--is-ancestor", foundation.units[1]!.commitSha!, "HEAD");
    }
    catch { throw new Error("Job HEAD does not descend through the verified Character/World foundations."); }
    if (arch.plan.contract.scope.depth === "architecture" ||
        !arch.plan.items.some(item => item.id === "global-architecture" &&
          item.status === "verified" && item.targetIds.includes(input.milestone))) {
      throw new Error("Selected Milestone is not authorized for Event realization by the current completion contract.");
    }
    const workItemId = "event-" + input.milestone.slice(10);
    const planDigest = hash(JSON.stringify(arch.plan));
    let receipt: EventReceipt;
    if (existsSync(receiptFile)) {
      receipt = JSON.parse(await readFile(receiptFile, "utf8")) as EventReceipt;
      if (receipt.version !== 1 || receipt.jobId !== job.jobId || receipt.baseSha !== job.baseSha ||
          receipt.milestoneId !== input.milestone || receipt.workItemId !== workItemId) {
        throw new Error("Event receipt is not bound to the authorized Story plan and job identity.");
      }
      const amendment = arch.plan.causalAmendment;
      if (input.action === "run" && amendment && receipt.planVersion + 1 === arch.plan.version &&
          amendment.source.milestoneId === input.milestone &&
          amendment.source.sha === receipt.expectedHead &&
          amendment.source.reportDigest === receipt.prerequisite?.reportDigest) {
        const old = receipt;
        const pin = old.blueprintPin;
        const prereq = old.prerequisite;
        if (old.phase !== "prerequisite-reported" || old.claimedPaths?.length ||
            !old.assignment || !pin || !prereq || !old.snapshot ||
            !old.causalDiscovery || old.causalDiscovery.sourcePath !== amendment.source.path ||
            !old.conflicts || !old.obligations ||
            arch.history?.at(-1)?.plan.version !== old.planVersion ||
            hash(JSON.stringify(arch.history.at(-1)!.plan)) !== old.planDigest ||
            prereq.reportDigest !== amendment.source.reportDigest)
          throw Error("Causal Event replay does not match the approved original no-write discovery.");
        await authenticateSettledEventNoWrite(job, old);
        if (dirty(job).length || await trustedHead(job) !== arch.expectedHead)
          throw Error("Causal Event restart requires the exact clean corrected Architecture HEAD.");
        try { rawGit(job, "merge-base", "--is-ancestor", old.expectedHead, arch.expectedHead); }
        catch { throw Error("Causal Event source does not precede the approved Architecture correction."); }
        await archiveReviewedMilestoneBlueprint(job, pin, old.assignment);
        const archive = join(root, "event-causal-history",
          input.milestone.slice(10) + "-" + prereq.reportDigest + ".json");
        await mkdir(dirname(archive), { recursive: true });
        if (existsSync(archive)) {
          if (JSON.stringify(JSON.parse(await readFile(archive, "utf8"))) !== JSON.stringify(old))
            throw Error("Preserved original causal Event no-write report was changed.");
        } else await persist(archive, old);
        receipt = { version: 1, jobId: job.jobId, baseSha: job.baseSha,
          milestoneId: input.milestone, workItemId,
          planVersion: arch.plan.version, planDigest, expectedHead: arch.expectedHead,
          phase: "ready", worker: old.worker, provider: old.provider, model: old.model,
          snapshot: old.snapshot, blueprintRequired: true,
          blueprintTask: input.task ?? old.blueprintTask ?? "" };
        await persist(receiptFile, receipt);
      } else {
        assertPlanContinuity(job, arch, "event:" + input.milestone,
          receipt.planVersion, receipt.planDigest);
      }
    } else {
      if (input.action !== "run") throw new Error("No Event work item to inspect.");
      const head = await trustedHead(job);
      if (dirty(job).length) throw new Error("Event work item requires a clean verified worktree.");
      receipt = { version: 1, jobId: job.jobId, baseSha: job.baseSha,
        milestoneId: input.milestone, workItemId, planVersion: arch.plan.version,
        planDigest, expectedHead: head, phase: "ready", worker: "pi",
        blueprintRequired: true, blueprintTask: input.task ?? "",
        provider: input.provider ?? "openai", model: input.model ?? "gpt-6-luna" };
      await persist(receiptFile, receipt);
    }
    if (input.action === "inspect") {
      if (receipt.blueprintRequired && !receipt.blueprintPin && receipt.phase !== "ready")
        throw Error("Event inspection found a missing required Milestone Blueprint approval.");
      if (receipt.blueprintPin && receipt.assignment)
        await readReviewedMilestoneBlueprint(job, receipt.blueprintPin, receipt.assignment);
      if (receipt.blueprintPrerequisite)
        await inspectEventBlueprintPrerequisite(job, receipt.milestoneId, input.validatorSource ?? input.skillsSource);
      return { ...output(job, receipt),
        localPlanning: await inspectMilestoneBlueprint(job, receipt.milestoneId) };
    }
    if (receipt.reroutedFrom || receipt.reroutedTask)
      throw Error("Historical Event setup reassignment is not executable authority.");
    if (receipt.blueprintRequired && input.task !== undefined && input.task !== receipt.blueprintTask)
      throw Error("Event author objective changed after its source-bound Milestone planning admission.");
    if (Boolean(input.fixture) !== (receipt.worker === "fixture") ||
        input.provider && input.provider !== receipt.provider ||
        input.model && input.model !== receipt.model) {
      throw new Error("Event worker/provider/model differs from persisted work-item selection.");
    }
    const config = input.skillsSource
      ? { discovery: "explicit-only" as const, novelteaSkills: input.skillsSource, skillDirs: [], requiredSkills: [] }
      : receipt.snapshot
        ? { discovery: "explicit-only" as const, novelteaSkills: undefined, skillDirs: [], requiredSkills: [] }
        : await loadSkillConfig(undefined, false);
    if (!receipt.snapshot) {
      const snapshot = await createSkillSnapshot({ ...config,
        novelteaSkills: input.skillsSource ?? config.novelteaSkills,
        discovery: "explicit-only", requiredSkills: ["nt-event-design", "nt-catalog"] });
      if (!snapshot) throw new Error("Event design requires a pinned NovelTea skills checkout.");
      receipt.snapshot = snapshot;
      await persist(receiptFile, receipt);
    }
    if (await openSkillSnapshot(receipt.snapshot.id) !== receipt.snapshot.path) {
      throw new Error("Event snapshot does not match the pinned identity.");
    }
    const validate = async (head: string) => validateStoryJob(
      await startStoryJob({ story: input.story, job: input.job }, false),
      input.validatorSource ?? input.skillsSource ?? config.novelteaSkills, { ...job, baseSha: head });
    if (receipt.writerContinuation) {
      const { inspectDependencyPlan, dependencyDigest } = await import("./dependency-state.js");
      const pin = receipt.writerContinuation;
      const entry = (await inspectDependencyPlan(job))?.entries.find(e => e.reportDigest === pin.reportDigest);
      if (!entry?.writerSource || entry.writerSource.stage !== "event" ||
          entry.writerSource.milestoneId !== input.milestone || entry.phase !== "verified" ||
          dependencyDigest(entry) !== pin.supportRef || entry.report.sourceSha !== pin.originalHead ||
          receipt.assignmentKey !== input.round?.assignmentKey)
        throw Error("Event writer continuation has no original parent admission.");
      const archived = JSON.parse(await readFile(writerNegativePath(job, input.milestone,
        entry.writerSource.sealDigest), "utf8")) as EventReceipt;
      if (archived.assignmentKey !== receipt.assignmentKey ||
          (entry.writerSource.origin === "blueprint"
            ? !!archived.sessionFile || !!archived.sessionId || !!pin.sessionSha256 || !archived.blueprintOwnerFinding
            : archived.sessionId !== receipt.sessionId || archived.sessionFile !== receipt.sessionFile ||
              archived.prerequisite?.sessionSha256 !== pin.sessionSha256))
        throw Error("Event writer continuation differs from the original settled session.");
    }
    if (receipt.blueprintOwnerFinding) {
      await inspectEventWriterDependency(job, receipt.milestoneId, receipt.blueprintOwnerFinding.sealDigest);
      return output(job, receipt);
    }
    if (receipt.phase === "prerequisite-reported") {
      if (!receipt.prerequisite || !receipt.assignment ||
          (receipt.worker === "pi" && !receipt.sessionFile) ||
          receipt.claimedPaths?.length || !receipt.conflicts || !receipt.obligations || dirty(job).length)
        throw Error("A reported Event prerequisite is missing its clean original source.");
      await authenticateSettledEventNoWrite(job, receipt);
      try { rawGit(job, "merge-base", "--is-ancestor", receipt.expectedHead, await trustedHead(job)); }
      catch { throw Error("Event prerequisite report no longer descends from its pinned Story source."); }
      return output(job, receipt);
    }
    if (input.round && receipt.assignmentKey && receipt.assignmentKey !== input.round.assignmentKey)
      throw Error("Event round belongs to another logical assignment.");
    if (input.round && !receipt.assignmentKey) {
      if (receipt.phase !== "ready" || input.round.command.phase !== "invoke")
        throw Error("Event receipt lacks its original child assignment admission.");
      receipt.assignmentKey = input.round.assignmentKey;
      await persist(receiptFile, receipt);
    }
    if (receipt.phase === "committed") {
      if (!receipt.commitSha) throw new Error("Committed Event work item lacks a commit.");
      verifyCommit(job, receipt, receipt.commitSha);
      if (receipt.blueprintPin && receipt.assignment)
        await readReviewedMilestoneBlueprint(job, receipt.blueprintPin, receipt.assignment);
      try { rawGit(job, "merge-base", "--is-ancestor", receipt.commitSha, "HEAD"); }
      catch { throw new Error("Verified Event commit no longer belongs to the job branch."); }
      if (git(job, "rev-parse", "HEAD") === receipt.commitSha) {
        if (dirty(job).length) throw new Error("Unexpected edits after Event commit.");
        await publishHead(job, receipt.expectedHead, receipt.commitSha, receipt.workItemId);
      }
      return output(job, receipt);
    }
    if (receipt.blueprintRequired && receipt.phase === "ready") {
      assertHead(job, receipt.expectedHead);
      const source = reportOf(await validate(receipt.expectedHead), receipt.expectedHead);
      const assign = selectedAssignment(job, arch.plan!, source, receipt.milestoneId, receipt.workItemId);
      const planningAssign = { ...assign };
      if (input.turnPlanDigest) {
        const turn = await (await import("./turn-plan-evidence.js")).readTurnEvidence(job, arch.plan!.contract, undefined, input.turnPlanDigest);
        if (turn?.objective) planningAssign.dependencyObligations = turn.objective.obligations;
      }
      const task = receipt.blueprintTask ?? "";
      if (receipt.blueprintSource) {
        if (!receipt.blueprintPin || input.blueprintAssessment)
          throw Error("Rebound Event requires the preserved Blueprint approval, not another planning cycle.");
        await readReviewedMilestoneBlueprint(job, receipt.blueprintPin,
          { ...assign, blueprintSource: receipt.blueprintSource });
      } else {
        const local = await ensureMilestoneBlueprint(job, arch.plan!, planningAssign, receipt.snapshot!,
          receipt.provider, receipt.model, task, receipt.expectedHead, receipt.worker === "fixture",
          undefined, input.round?.assignmentKey ?? receipt.assignmentKey, input.turnPlanDigest, input.blueprintAssessment);
        receipt.blueprintPin = local.pin;
        if (local.blueprint.upstreamCorrection) {
          if (!receipt.assignmentKey || !planningAssign.dependencyObligations || receipt.sessionId)
            throw Error("Blueprint owner finding has no original authority or still contradicts corrected canon.");
          receipt.assignment = planningAssign;
          const finding = local.blueprint.upstreamCorrection;
          receipt.blueprintOwnerFinding = { finding, sealDigest: blueprintOwnerSeal(receipt, finding) };
          await persist(receiptFile, receipt);
          return output(job, receipt);
        }
      }
      receipt.blueprintTask = task;
      const readiness = await blueprintPrerequisite(job, receipt, arch.plan!, source);
      if (receipt.blueprintPrerequisite &&
          JSON.stringify(receipt.blueprintPrerequisite) !== JSON.stringify(readiness))
        throw Error("Original Blueprint readiness changed without an authorized successor.");
      if (readiness) {
        if (receipt.blueprintSource) throw Error("Rebound Event still lacks a verified prerequisite.");
        receipt.assignment = assign;
        receipt.blueprintPrerequisite = readiness;
      }
      await persist(receiptFile, receipt);
    }
    if (input.blueprintAssessment) {
      if (!receipt.blueprintPin || receipt.phase !== "ready")
        throw Error("Original Milestone Blueprint assessment did not reach its independently approved pin.");
      return { ...output(job, receipt), status: "blueprint-approved", blueprintPin: receipt.blueprintPin };
    }
    // A sound prospective Blueprint can be approved while a predecessor is
    // unrealized. Do not enter the Event writer graph or consume its budget.
    if (receipt.blueprintPrerequisite) return output(job, receipt);
    const Channels = Annotation.Root({ receipt: Annotation<EventReceipt>(),
      round: Annotation<AssignmentRoundResult | null>({ reducer: (_, next) => next, default: () => null }) });
    const graph = new StateGraph(Channels)
      .addNode("event_specialist", async ({ receipt }) => {
        if (receipt.phase === "authored") return { receipt };
        const continuing = receipt.phase === "writing";
        if (continuing && (!receipt.assignment ||
            !await inspectPendingEventInvocation(job, receipt.milestoneId, receipt.expectedHead)))
          throw Error("Interrupted Event specialist lacks its original invocation.");
        const resuming = receipt.phase === "awaiting-author" || continuing && !!receipt.invocationChoice;
        const savedChoice = resuming && receipt.authorChoiceId
          ? await inspectSpecialistChoice(job, receipt.authorChoiceId) : null;
        if (savedChoice?.phase === "awaiting-author") throw new SpecialistChoiceRequiredError();
        const choice = savedChoice && !continuing
          ? await verifySpecialistChoice(job, savedChoice.id, "answered") : savedChoice;
        if (continuing && choice && (choice.phase !== "resuming" || choice.sessionSha256 !== receipt.invocationChoice))
          throw Error("Interrupted Event author continuation lost its original answer.");
        if (resuming && (!choice || choice.workItem !== receipt.workItemId || !receipt.assignment))
          throw new Error("Event choice has no exact answered work-item assignment.");
        assertHead(job, receipt.expectedHead);
        if (!resuming && !continuing && dirty(job).length)
          throw new Error("Event specialist requires a clean work-item boundary.");
        const prior = resuming || continuing ? null : reportOf(await validate(receipt.expectedHead), receipt.expectedHead);
        const assign: EventAssignment = resuming || continuing ? receipt.assignment! : {
          ...selectedAssignment(job, arch.plan!, prior!, receipt.milestoneId, receipt.workItemId),
          ...(receipt.blueprintSource ? { blueprintSource: receipt.blueprintSource } : {}),
          ...((receipt.blueprintTask || input.task) ? { authorTask: receipt.blueprintTask ?? input.task } : {}),
        };
        if (!continuing && input.turnPlanDigest) {
          const turn = await (await import("./turn-plan-evidence.js")).readTurnEvidence(job, arch.plan!.contract, undefined, input.turnPlanDigest);
          if (turn?.objective) assign.dependencyObligations = turn.objective.obligations;
        }
        if (receipt.blueprintRequired && !receipt.blueprintPin)
          throw Error("Event writer has no independently reviewed local Milestone Blueprint.");
        if (receipt.blueprintPin) {
          const design = await readEventSourceBlueprint(job, receipt.blueprintPin, assign, receipt.expectedHead);
          assign.milestoneBlueprint = { digest: receipt.blueprintPin.digest, design };
        }
        if (!continuing) {
          await preflightPiAssignment(job, "event:" + receipt.workItemId,
            receipt.worker === "pi" ? { provider: receipt.provider, model: receipt.model } : undefined);
          if (resuming) await claimSpecialistChoice(job, receipt.authorChoiceId!);
          receipt.assignment = assign;
          {
            receipt.invocationChoice = choice?.sessionSha256;
            receipt.invocationSource = eventInvocationSource(job, receipt);
            delete receipt.invocationProof;
          }
          receipt.phase = "writing";
          await persist(receiptFile, receipt);
        }
        try {
          const verifyDraft = async (candidate: EventEvidence) => {
            let paths: string[] | undefined;
            let repairablePathError: string | undefined;
            let bodyRestoreFeedback: string | undefined;
            try {
              paths = await changedPaths(job, assign, candidate.claimedPaths);
            } catch (error) {
              const message = String(error);
              if (message.includes("Event specialist changed unrelated Milestone metadata/body.")) {
                // The latest real Luna source authored an Event and an otherwise
                // valid selected-Milestone binding, but appended a justification
                // to the Milestone's immutable narrative body. Permit ONE
                // correction of exact original bytes in the SAME session,
                // never tolerance of the changed body or metadata at commit.
                const baseline = rawGit(job, "show", "HEAD:" + repoPath(job, assign.milestonePath));
                const current = await readFile(join(job.worktreeStoryRoot, assign.milestonePath), "utf8");
                const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
                const modified = dirty(job);
                const paths = modified.map(entry => entry.slice(3));
                if (!milestoneBodyOnlyDrift(baseline, current) ||
                    !modified.some(entry => entry.slice(3) === repoPath(job, assign.milestonePath)) ||
                    !paths.some(path => path.startsWith(prefix + "events/")) ||
                    modified.some(entry => ![" M", "??"].includes(entry.slice(0, 2)) ||
                      !entry.slice(3).startsWith(prefix) ||
                      entry.slice(3) !== repoPath(job, assign.milestonePath) &&
                      !/^events\/[a-z][a-z0-9-]*\.md$/.test(entry.slice(3).slice(prefix.length)))) {
                  // Any changed protected decision, other frontmatter, staged
                  // file or unrelated path retains the original hard block.
                  throw error;
                }
                bodyRestoreFeedback = eventMilestoneBodyRestoreFeedback(
                  assign.milestonePath, milestoneBaselineBody(baseline));
              } else {
                // Only incomplete work/manifest claims are otherwise repairable.
                // Unauthorized edits, unsafe paths and protected mutations fail closed.
                if (!message.includes("must change at least one Event") &&
                    !message.includes("modifiedRecords differ from the actual authorized Git diff"))
                  throw error;
                repairablePathError = message;
              }
            }
            assertHead(job, receipt.expectedHead);
            if (bodyRestoreFeedback) return [bodyRestoreFeedback];
            // A model that has already authored in-scope Event files may
            // report a missing piece of reachable observation/testimony as
            // an "architectural conflict". This is one bounded correction in
            // the SAME authenticated session, never a new writer/owner grant.
            // Protected, upstream and out-of-scope claims still fail closed.
            const localEvidenceGap = candidate.claimedPaths.length > 0 &&
              scopedEventEvidenceConflict(assign, candidate.conflicts);
            const checked = await validate(receipt.expectedHead);
            const draft = checked.report as unknown as Report | undefined;
            if (draft?.protection?.status !== "checked" ||
                draft.protection.changes.length || draft.protection.warnings.length) {
              throw new Error("Event draft has protected/unverified changes; automated repair cannot authorize it.");
            }
            if (draft.diagnostics.length) {
              if (paths && draft.diagnostics.every(d => ["schema", "yaml", "frontmatter"].includes(d.code) && paths!.includes(d.path)))
                return nativeMetadataDefects(checked, { jobId: job.jobId, baseSha: receipt.expectedHead,
                  worktreeStoryRoot: job.worktreeStoryRoot, validatorVersion: job.validatorVersion, paths });
              return draft.diagnostics.slice(0, 20)
                .map(d => `${d.path}:${d.line ?? 1}:${d.column ?? 1} ${d.code}: ${d.message}`);
            }
            if (checked.status !== "passed") throw new Error("Event validator rejected the draft without diagnostics.");
            if (repairablePathError) return [repairablePathError +
              " Edit an authorized Event if necessary, or correct modifiedRecords to list the exact Git changes. " +
              "Do not modify the Milestone merely to make it appear in the diff."];
            // Derive the exception from the native-validated, protected
            // SOURCE Milestone, never the model's choice of conflict label.
            const sourceMilestone = draft.records.find(record =>
              record.metadata.type === "milestone" && record.metadata.id === assign.milestoneId);
            const sourceChange = String(sourceMilestone?.metadata.change ?? "");
            const falseChoiceDeferral = candidate.claimedPaths.length > 0 &&
              scopedNondecisionChoiceDeferral(candidate.conflicts, sourceChange) &&
              !currentMilestoneChoiceBinding(candidate.obligations, assign.milestoneId, sourceChange);
            const laterChoiceSetup = candidate.claimedPaths.length > 0 &&
              scopedDecisionSetupConflict(assign, sourceChange, candidate.conflicts);
            const authoredEventIds = draft.records
              .filter(record => paths!.includes(record.path) &&
                record.metadata.type === "event" && record.metadata.status !== "superseded")
              .map(record => record.metadata.id);
            if (localEvidenceGap)
              return [{ kind: "semantic" as const, path: assign.milestonePath, code: "event-local-evidence",
                detail: eventEvidenceRepairFeedback(assign, candidate.conflicts, authoredEventIds) }];
            if (falseChoiceDeferral)
              return [eventNondecisionChoiceCorrection(
                assign, candidate.conflicts, sourceChange, authoredEventIds)];
            if (laterChoiceSetup)
              return [eventDecisionSetupCorrection(assign, sourceChange, candidate.conflicts)];
            try {
              const clusterDefects = eventClusterDefects(draft.records.filter(record =>
                paths!.includes(record.path) && record.metadata.type === "event" &&
                record.metadata.status !== "superseded"), assign);
              if (clusterDefects.length) return clusterDefects;
              acceptance(draft, assign, paths!, candidate.obligations);
              // A native-valid, in-lease unpublished draft with a reported conflict
              // is a bounded semantic failure, not evidence of an unknown commit.
              // Keep it in the original writer-round correction/terminal ledger.
              if (candidate.conflicts.length && !localEvidenceGap && !falseChoiceDeferral &&
                  !laterChoiceSetup)
                return [{ kind: "semantic" as const, path: assign.milestonePath,
                  code: "event-unresolved-conflict", detail:
                    "Resolve only within the original authorized Event scope, or retain the draft for recovery: " +
                    candidate.conflicts.join("; ") }];
              const proof = await consequenceProof(job, draft, assign, paths!, candidate.obligations);
              return proof.diagnostics.map(d =>
                `${d.path}:${d.line} ${d.event}/${d.step}/${d.branch} ${d.slot}: ${d.message}`);
            } catch (error) {
              if (error instanceof EventFulfillmentError) return [error.defect];
              const message = String(error);
              return [message];
            }
          };
          let evidence: EventEvidence;

            const authored = await authorEventCluster(job, receipt.snapshot!, assign, receipt.provider, receipt.model,
              async (file, id) => { receipt.sessionFile = file; receipt.sessionId = id; await persist(receiptFile, receipt); }, verifyDraft,
              { sourceDigest: receipt.invocationSource!, sessionFile: receipt.sessionFile, sessionId: receipt.sessionId,
                continuation: receipt.writerContinuation?.sessionSha256 ? { ...receipt.writerContinuation, sessionSha256: receipt.writerContinuation.sessionSha256 } : undefined,
                authorize: async () => {
                  assertHead(job, receipt.expectedHead);
                  if (receipt.invocationSource !== eventInvocationSource(job, receipt))
                    throw Error("Event assignment source changed before original invocation");
                },
                effect: () => assignmentDraftEffect(job, receipt.expectedHead) },
              choice ?? undefined, input.round!.command);
            if ("round" in authored) return { receipt, round: authored.round };
            evidence = authored;
            if (!evidence.invocationProof) throw Error("Event writer did not settle its original invocation");
            receipt.invocationProof = evidence.invocationProof;
            await verifySettledAssignment({ ...eventInvocationOptions(job, receipt),
              proof: evidence.invocationProof, effect: await assignmentDraftEffect(job, receipt.expectedHead) });

          if (evidence.authorQuestion) {
            await changedPaths(job, assign, evidence.claimedPaths, true);
            assertHead(job, receipt.expectedHead);
            const checked = await validate(receipt.expectedHead);
            const protection = (checked.report as Report | undefined)?.protection;
            if (!protection || protection.status !== "checked" ||
                protection.changes.length || protection.warnings.length)
              throw Error("Event author choice cannot bypass protected-canon validation.");
            if (!evidence.sessionFile || !evidence.piSessionId)
              throw Error("Event author choice lacks a pinned Pi session.");
            if (resuming) await completeSpecialistChoice(job, receipt.authorChoiceId!);
            const pending = await recordSpecialistChoice(job, receipt.workItemId,
              evidence.authorQuestion, evidence.piSessionId, evidence.sessionFile);
            receipt.authorChoiceId = pending.id;
            receipt.sessionId = evidence.piSessionId;
            receipt.sessionFile = evidence.sessionFile;
            receipt.phase = "awaiting-author";
            await persist(receiptFile, receipt);
            throw new SpecialistChoiceRequiredError();
          }
          if (!evidence.claimedPaths.length &&
              (evidence.conflicts.length || evidence.obligations.length)) {
            // A completed original turn may raise a prerequisite; it does not
            // authorize a dependency edge, Choice writer or fabricated Event.
            if (resuming || dirty(job).length || await trustedHead(job) !== receipt.expectedHead)
              throw Error("Event prerequisite report is not at a clean unchanged source boundary.");
            if (receipt.worker === "pi") {
              await verifyJobPiSession(job, "event", evidence.sessionFile,
                evidence.piSessionId, receipt.workItemId);
            }
            const sessionBytes = await readFile(evidence.sessionFile!);
            const sessionSha256 = hash(sessionBytes);
            const sessionId = evidence.piSessionId!;
            receipt.claimedPaths = [];
            receipt.conflicts = evidence.conflicts;
            receipt.obligations = evidence.obligations;
            receipt.causalDiscovery = evidence.causalDiscovery;
            receipt.blueprintFinding = evidence.blueprintFinding;
            receipt.dependencyFinding = evidence.dependencyFinding;
            receipt.skillReads = evidence.skillReads;
            receipt.sessionFile = evidence.sessionFile;
            const payload = { jobId: job.jobId, workItemId: receipt.workItemId,
              expectedHead: receipt.expectedHead, planDigest: receipt.planDigest,
              sessionSha256, sessionId, assignmentDigest: hash(JSON.stringify(receipt.assignment)),
              snapshotId: receipt.snapshot!.id, sessionFile: evidence.sessionFile ?? "fixture",
              worker: receipt.worker, conflicts: evidence.conflicts,
              obligations: evidence.obligations,
              ...(evidence.causalDiscovery ? { causalDiscovery: evidence.causalDiscovery } : {}),
              ...(evidence.blueprintFinding ? { blueprintFinding: evidence.blueprintFinding } : {}),
              ...(evidence.dependencyFinding ? { dependencyFinding: evidence.dependencyFinding } : {}) };
            receipt.prerequisite = { expectedHead: receipt.expectedHead, sessionSha256,
              sessionId, assignmentDigest: payload.assignmentDigest,
              snapshotId: payload.snapshotId, sessionFile: payload.sessionFile,
              worker: receipt.worker, reportDigest: eventPrerequisiteReportDigest(payload), transcriptBytes: sessionBytes.length };
            receipt.phase = "prerequisite-reported";
            delete receipt.failure;
            await persist(receiptFile, receipt);
            return { receipt }; // No commit, checkpoint, grant or automatic replay.
          }
          if (resuming) await completeSpecialistChoice(job, receipt.authorChoiceId!);
          receipt.claimedPaths = evidence.claimedPaths;
          receipt.conflicts = evidence.conflicts;
          receipt.obligations = evidence.obligations;
          receipt.blueprintChallenge = evidence.blueprintChallenge;
          receipt.skillReads = evidence.skillReads;
          receipt.sessionFile = evidence.sessionFile ?? receipt.sessionFile;
          receipt.sessionId = evidence.piSessionId ?? receipt.sessionId;
          receipt.paths = await changedPaths(job, assign, evidence.claimedPaths);
          receipt.contentDigest = await contentDigest(job, receipt.paths);
          receipt.phase = "authored";
          await persist(receiptFile, receipt);
        } catch (error) {
          if (error instanceof SpecialistChoiceRequiredError) delete receipt.failure;
          else receipt.failure = String(error);
          await persist(receiptFile, receipt);
          throw error;
        }
        return { receipt };
      })
      .addNode("validate_and_commit_event", async ({ receipt }) => {
        try {
        const prior = receipt.expectedHead;
        if (receipt.phase === "prerequisite-reported") return { receipt };
        if (receipt.blueprintRequired && (!receipt.blueprintPin || !receipt.assignment))
          throw Error("Event commit requires its independently reviewed Milestone plan.");
        if (receipt.blueprintPin && receipt.assignment)
          await readReviewedMilestoneBlueprint(job, receipt.blueprintPin, receipt.assignment);
        const recovering = git(job, "rev-parse", "HEAD") !== prior;
        if (recovering && (!receipt.contentDigest || !receipt.paths || dirty(job).length ||
            git(job, "rev-parse", "HEAD^") !== prior ||
            !git(job, "log", "-1", "--format=%B").includes("NovelTea-Event-Design: " + receipt.contentDigest))) {
          throw new Error("Unrecognized Event work-item commit after interruption.");
        }
        const checked = await validate(prior);
        const report = reportOf(checked, prior);
        const assign = selectedAssignment(job, arch.plan!, report, receipt.milestoneId, receipt.workItemId);
        if (!receipt.paths || !receipt.contentDigest || receipt.conflicts?.length ||
            await contentDigest(job, receipt.paths) !== receipt.contentDigest) {
          throw new Error("Authored Event inventory changed or has architectural conflicts.");
        }
        {
          if (!receipt.invocationProof) throw Error("Authored Event lacks its settled invocation");
          await verifySettledAssignment({ ...eventInvocationOptions(job, receipt),
            proof: receipt.invocationProof, effect: receipt.contentDigest });
        }
        const proof = acceptance(report, assign, receipt.paths, receipt.obligations ?? []);
        const typedProof = await consequenceProof(job, report, assign, receipt.paths,
          receipt.obligations ?? []);
        if (typedProof.diagnostics.length) throw new Error("Event has contradictory typed effects: " +
          typedProof.diagnostics.map(d => `${d.path}:${d.line} ${d.event}/${d.step}/${d.branch} ${d.slot} ${d.message}`).join("; "));
        const typedDigest = eventConsequenceProofDigest(typedProof);
        const completionDigest = eventCompletionDigest({ milestoneId: receipt.milestoneId,
          expectedHead: receipt.expectedHead, snapshotId: receipt.snapshot!.id,
          contentDigest: receipt.contentDigest, eventIds: proof.eventIds,
          milestoneState: proof.milestoneState, obligations: receipt.obligations ?? [] });
        if (!recovering) {
          assertHead(job, prior);
          const paths = await changedPaths(job, assign, receipt.claimedPaths ?? []);
          if (JSON.stringify(paths) !== JSON.stringify(receipt.paths)) {
            throw new Error("Event work item paths changed after validation.");
          }
          git(job, "add", "--", ...paths.map(p => repoPath(job, p)));
          git(job, "-c", "user.name=NovelTea Generator", "-c", "user.email=noveltea-gen@users.noreply.github.com",
            "commit", "-m", `Realize ${receipt.milestoneId} [${job.jobId}]\n\nNovelTea-Job: ${job.jobId}\nNovelTea-Work-Item: ${receipt.workItemId}\nNovelTea-Plan-Version: ${receipt.planVersion}\nNovelTea-Event-Design: ${receipt.contentDigest}\nNovelTea-Event-Completion: ${completionDigest}\nNovelTea-Event-Consequence: ${typedDigest}${receipt.blueprintPin ?
              `\nNovelTea-Milestone-Blueprint: ${receipt.blueprintPin.digest}` : ""}${receipt.blueprintChallenge ?
              `\nNovelTea-Blueprint-Challenge: ${hash(JSON.stringify(receipt.blueprintChallenge))}` : ""}`);
        }
        if (dirty(job).length) throw new Error("Event commit left unexpected modifications.");
        const commit = git(job, "rev-parse", "HEAD");
        receipt.consequenceProof = typedProof;
        verifyCommit(job, receipt, commit);
        receipt.validation = { status: "passed", validatorVersion: checked.validator.version,
          protectionBase: prior, ...proof };
        receipt.commitSha = commit;
        receipt.phase = "committed";
        delete receipt.failure;
        await persist(receiptFile, receipt);
        await publishHead(job, prior, commit, receipt.workItemId);
        return { receipt };
        } catch (error) {
          receipt.failure = String(error);
          await persist(receiptFile, receipt);
          throw error;
        }
      })
      .addEdge(START, "event_specialist")
      .addConditionalEdges("event_specialist", state => state.round ? END : "validate_and_commit_event",
        [END, "validate_and_commit_event"])
      .addEdge("validate_and_commit_event", END).compile();
    const result = await graph.invoke({ receipt });
    if (result.round) return { ...output(job, result.receipt), status: "writer-round", round: result.round };
    const authorUpdates = await processAuthorUpdatesAfterWork(job);
    const { scheduleIdeasAtBoundary } = await import("./idea-placement.js");
    await scheduleIdeasAtBoundary(job, "event-work");
    return { ...output(job, result.receipt), authorUpdates };
  });
}
