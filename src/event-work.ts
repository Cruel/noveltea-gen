import { execFileSync } from "./git-read-cache.js";
import { commitOrigin } from "./recovery-fork-state.js";
import { assertMilestoneFulfillmentOnly, milestoneBodyOnlyDrift,
  milestoneBaselineBody } from "./milestone-field-scope.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { Plan } from "./architecture.js";
import { authorEventCluster, scopedEventEvidenceConflict, eventEvidenceRepairFeedback,
  scopedNondecisionChoiceDeferral, eventNondecisionChoiceCorrection,
  scopedDecisionSetupConflict, eventDecisionSetupCorrection,
  observedNondecisionMilestone,
  eventMilestoneBodyRestoreFeedback, type EventAssignment, type EventEvidence } from "./event-specialist.js";
import { routeEventPrerequisite } from "./event-prerequisite-routing.js";
import { startStoryJob, type JobStartResult } from "./job.js";
import { trustedHead } from "./revision.js";
import { finalizeRecoveryCheckpoint } from "./recovery-checkpoints.js";
import { verifyJobPiSession } from "./job-session.js";
import { withStoryJobLock } from "./job-lock.js";
import { fixtureCluster } from "./fixture-cluster.js";
import { buildEventConsequenceProof, eventConsequenceProofDigest,
  type EventConsequenceProof } from "./event-consequence-proof.js";
import { assertPlanContinuity } from "./plan-continuity.js";
import { processAuthorUpdatesAtBoundary, processAuthorUpdatesAfterWork } from "./author-updates.js";
import { loadSkillConfig } from "./skills.js";
import { preflightPiAssignment } from "./job-pi-policy.js";
import { createSkillSnapshot, openSkillSnapshot, type SkillSnapshot } from "./snapshot.js";
import { validateStoryJob, type ValidationResult } from "./validator.js";
import { recordSpecialistChoice, verifySpecialistChoice, claimSpecialistChoice,
  completeSpecialistChoice, SpecialistChoiceRequiredError } from "./specialist-choice.js";

type Phase = "ready" | "writing" | "awaiting-author" | "authored" | "committed" | "prerequisite-reported";
interface EventReceipt {
  version: 1; jobId: string; baseSha: string; workItemId: string;
  milestoneId: string; planVersion: number; planDigest: string;
  expectedHead: string; phase: Phase; worker: "fixture" | "pi";
  provider: string; model: string; snapshot?: SkillSnapshot;
  sessionFile?: string; sessionId?: string; authorChoiceId?: string;
  assignment?: EventAssignment;
  skillReads?: string[]; claimedPaths?: string[];
  paths?: string[]; contentDigest?: string; commitSha?: string;
  conflicts?: string[]; obligations?: string[];
  /** Advisory typed evidence tied to native-validated draft and final commit. */
  consequenceProof?: EventConsequenceProof;
  /** A completed, clean no-write original session; never executable authority. */
  prerequisite?: { expectedHead: string; sessionSha256: string; sessionId: string;
    assignmentDigest: string; snapshotId: string; sessionFile: string; worker: "pi" | "fixture";
    reportDigest: string };
  validation?: {
    status: "passed"; validatorVersion: string; protectionBase: string;
    eventIds: string[]; routes: Route[]; eventProgress: Progress[];
    milestoneState: "complete" | "partial-choice-pending";
    branchProgress: Array<{ event: string; step: string; branch: string; status: Progress["status"] }>;
    remaining: unknown[]; truncated: boolean;
  };
  /** Exact original sealed no-write receipt that authorized one new Event setup task. */
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
interface ArchitectureReceipt { jobId: string; phase: string; expectedHead: string; plan?: Plan }
interface FoundationsReceipt {
  jobId: string; planVersion: number; architectureHead: string;
  units: Array<{ id: string; phase: string; commitSha?: string }>;
}
export interface EventOptions {
  story: string; job: string; action: "run" | "inspect"; milestone: string;
  skillsSource?: string; validatorSource?: string; fixture?: boolean;
  provider?: string; model?: string; task?: string;
  /** Internal controller-only reassignment, never a model-provided grant. */
  reroute?: { reportDigest: string; sourceSha: string; task: string };
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
export function eventPrerequisiteReportDigest(value: {
  jobId: string; workItemId: string; expectedHead: string; planDigest: string;
  sessionSha256: string; sessionId: string; assignmentDigest: string;
  snapshotId: string; sessionFile: string; worker: "pi" | "fixture";
  conflicts: string[]; obligations: string[];
}) {
  if (!/^[a-f0-9]{40}$/.test(value.expectedHead) ||
      !/^[a-f0-9]{64}$/.test(value.sessionSha256) ||
      !/^[a-f0-9]{64}$/.test(value.planDigest) ||
      !/^[a-f0-9]{64}$/.test(value.assignmentDigest) ||
      !/^[a-f0-9]{64}$/.test(value.snapshotId) ||
      !["pi", "fixture"].includes(value.worker) ||
      !value.sessionFile.trim() ||
      !value.jobId.trim() || !/^event-[a-z][a-z0-9-]*$/.test(value.workItemId) ||
      !value.sessionId.trim() || !Array.isArray(value.conflicts) ||
      !Array.isArray(value.obligations) ||
      !value.conflicts.length && !value.obligations.length ||
      value.conflicts.length > 8 || value.obligations.length > 8 ||
      [...value.conflicts, ...value.obligations].some(s => typeof s !== "string" ||
        !s.trim() || s.length > 1500))
    throw Error("Unverified or unbounded Event no-write prerequisite report.");
  return hash(JSON.stringify(value));
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
function selectedAssignment(job: JobStartResult, plan: Plan, report: Report, milestoneId: string, workItemId: string): EventAssignment {
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
function acceptance(report: Report, assignment: EventAssignment, paths: string[], obligations: string[]) {
  const records = report.records.filter(r => r.metadata.status !== "superseded");
  if (paths.some(path => !records.some(r => r.path === path))) {
    throw new Error("Canonical catalog did not recognize every authored Event record.");
  }
  const authored = records.filter(r => paths.includes(r.path) && r.metadata.type === "event");
  if (!authored.length || authored.some(r =>
    !(r.metadata.arcs as string[] ?? []).some(id => assignment.arcIds.includes(id)) ||
    (r.metadata.arcs as string[] ?? []).some(id => !assignment.arcIds.includes(id)) ||
    !(r.metadata.participants as string[] ?? []).length ||
    (r.metadata.participants as string[] ?? []).some(id => !assignment.characterIds.includes(id)) ||
    !(r.metadata.consequences as string[] ?? []).length ||
    !(r.metadata.prerequisites?.any_of as unknown[] ?? []).length)) {
    throw new Error("Events must be complete, causal and belong only to the selected Arc cluster.");
  }
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
      milestone.metadata.completeness === "partial" ||
      routes.length !== milestone.metadata.fulfillment.any_of.length ||
      !routes.some(r => r.status === "reachable") || routes.some(r => r.status === "impossible"))) {
    throw new Error("Selected Milestone lacks a deterministically reachable Event fulfillment route.");
  }
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
  if (!receipt.contentDigest || !receipt.paths ||
      !git(job, "log", "-1", "--format=%B", commit).split("\n").includes(
        "NovelTea-Job: " + commitOrigin(job, receipt.workItemId, commit).jobId) ||
      git(job, "rev-parse", commit + "^") !== receipt.expectedHead ||
      !git(job, "log", "-1", "--format=%B", commit).includes("NovelTea-Event-Design: " + receipt.contentDigest) ||
      !git(job, "log", "-1", "--format=%B", commit).includes("NovelTea-Work-Item: " + receipt.workItemId + "\n") ||
      !git(job, "log", "-1", "--format=%B", commit).includes("NovelTea-Plan-Version: " + receipt.planVersion + "\n")) {
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
function output(job: JobStartResult, state: EventReceipt) {
  return { status: state.phase === "committed" ? "event-cluster-committed" :
    state.phase === "prerequisite-reported" ? "event-prerequisite-reported" : state.phase,
    jobId: job.jobId, milestoneId: state.milestoneId, workItemId: state.workItemId,
    worktreeStoryRoot: job.worktreeStoryRoot, headSha: state.commitSha ?? state.expectedHead,
    expectedHead: state.expectedHead, planVersion: state.planVersion, phase: state.phase,
    specialist: "nt-event-design", paths: state.paths, validation: state.validation,
    obligations: state.obligations, conflicts: state.conflicts,
    outstanding: state.validation?.remaining ?? [],
    failure: state.failure, prerequisite: state.prerequisite, reroutedFrom: state.reroutedFrom,
    sessionFile: state.sessionFile, skillReads: state.skillReads,
    consequenceProof: state.consequenceProof,
    skillSnapshot: state.snapshot?.id,
    completionEvidence: { eventReachability: state.phase === "committed",
      milestoneState: state.validation?.milestoneState ?? "unverified",
      deferredChoiceObligations: state.validation?.milestoneState === "partial-choice-pending"
        ? state.obligations ?? [] : [],
      editorial: "unverified", unrelatedComposition: "not-required", fullStory: false } };
}
async function fixtureAuthor(job: JobStartResult, assignment: EventAssignment,
  rerouted = false): Promise<EventEvidence> {
  const configured = process.env.NT_EVENT_FIXTURE_CASE ?? "fulfilled";
  const variant = configured === "no-write-once" ? rerouted ? "fulfilled" : "no-write-prerequisite" :
    configured === "no-write-evidence-once" ? rerouted ? "fulfilled" : "no-write-evidence" :
    configured === "no-write-accounts-once" ? rerouted ? "fulfilled" : "no-write-accounts" :
    configured === "phantom-milestone" ? "decision-pending" : configured;
  const cluster = fixtureCluster(assignment.milestoneId);
  const files: string[] = [];
  const add = async (slug: string, metadata: string, prose: string) => {
    slug = cluster.slug(slug); metadata = cluster.text(metadata);
    const local = `events/${slug}.md`;
    await mkdir(join(job.worktreeStoryRoot, "events"), { recursive: true });
    await writeFile(join(job.worktreeStoryRoot, local),
      `---\nschema: '0.1'\ntype: event\nid: event.${slug}\ntitle: "${slug}"\nstatus: draft\ndecisions: []\n${metadata}\n---\n\n${prose}\n`, { flag: "wx" });
    files.push(local);
  };
  if (["no-write-prerequisite", "no-write-evidence", "no-write-accounts", "no-write-dirty", "no-write-empty", "no-write-protected"].includes(variant)) {
    if (variant === "no-write-dirty") {
      await mkdir(join(job.worktreeStoryRoot, "events"), { recursive: true });
      await writeFile(join(job.worktreeStoryRoot, "events/uncertain-draft.md"), "Unapproved draft.\n");
    }
    return { claimedPaths: [], skillReads: [],
      conflicts: variant === "no-write-empty" ? [] : variant === "no-write-protected"
        ? ["Protected author approval for an out-of-scope new Milestone is required."] :
        variant === "no-write-evidence"
          ? ["The selected Milestone lacks the material evidence of which spaces and people were accessible during the relevant interval; the current Event does not establish it."] :
        variant === "no-write-accounts"
          ? ["The assigned Milestone requires conflicting accounts and an independent observation; canonical sources establish neither."] :
        ["A distinct Choice and authored ending are needed beyond this Event writer's scope."],
      obligations: ["no-write-empty", "no-write-evidence", "no-write-accounts"].includes(variant) ? [] :
        ["Arrange controller-approved interactive work before concluding the resolution."] };
  }
  if (["optional", "alternative-routes", "contradiction", "failed-repair", "repair"].includes(variant)) {
    await add("inspect-ledger",
      `participants: [character.ada]\narcs: [${assignment.arcIds[0]}]\nconsequences: ["Ada recognizes the handwriting"]\nafter: []\nprerequisites:\n  any_of:\n    - completed: []\n      not_completed: []\nsteps: []`,
      "Ada recognizes the ledger handwriting. Inspecting is optional, not a prerequisite of disclosure.");
  }
  const impossible = ["contradiction", "failed-repair", "repair"].includes(variant);
  await add("disclose-ledger",
    `participants: [character.ada, character.neri]\narcs: [${assignment.arcIds[0]}]\nconsequences: ["Neri discloses the ledger, changing Ada's belief and their relationship"]\nafter: ${variant === "optional" ? "[event.inspect-ledger]" : "[]"}\nprerequisites:\n  any_of:\n    - completed: ${impossible ? "[event.inspect-ledger]" : "[]"}\n      not_completed: ${impossible ? "[event.inspect-ledger]" : "[]"}\n      conditions:\n        - kind: knowledge\n          character: character.neri\n          fact: fact.evidence-concealed\n          value: knows\nsteps:\n  - id: admit\n    branches:\n      - id: disclose\n        conditions: []\n        effects:\n          - kind: knowledge\n            character: character.ada\n            fact: fact.evidence-concealed\n            value: knows\n          - kind: relationship\n            relationship: relationship.ada-neri\n            value: trusting`,
    variant === "event-only"
      ? "Neri opens the original signed transfer ledger for the missing witness on the archive table. " +
        "He places the matching daily register beside it: the witness's name, dated entry, and " +
        "transfer stamp agree. The correction ink carries Neri's initials. He admits he kept " +
        "the ledger out of Ada's sight while protecting the witness from an official inquiry. " +
        "Ada compares the two primary records herself, recognizing both the genuine transfer " +
        "evidence and Neri's deliberate concealment. Neri hands her the unaltered original " +
        "and offers to let her check every remaining page with him. His surrender of control " +
        "and the corroborating signatures answer Ada's earlier suspicion. She is still " +
        "upset, but her wariness changes to cautious trust as she takes custody of the evidence. " +
        "No selectable player decision is introduced at this observational disclosure."
      : "Neri admits concealing the ledger and explains the reason. Ada learns that the concealment is real, while the confession begins repairing their trust. These are typed effects at the disclosure step.");
  if (["decision-pending", "false-decision-complete", "fake-unrelated-effects", "descriptive"].includes(variant)) {
    const path = join(job.worktreeStoryRoot, "events/disclose-ledger.md");
    const original = await readFile(path, "utf8");
    const newText = variant === "fake-unrelated-effects" ? original :
      original.replace(/steps:\n[\s\S]*?(?=\n---)/, variant === "descriptive"
        ? "steps: []"
        : "steps:\n  - id: decision-offered\n    branches:\n      - id: release\n        conditions: []\n        effects: []\n      - id: withhold\n        conditions: []\n        effects: []");
    await writeFile(path, newText.replace("Neri discloses the ledger, changing Ada's belief and their relationship",
      variant === "descriptive" ? "Neri reports the location of the ledger without changing tracked state"
        : "Neri presents a pending opportunity to release or withhold the ledger")
      .replace("Neri admits concealing the ledger and explains the reason. Ada learns that the concealment is real, while the confession begins repairing their trust. These are typed effects at the disclosure step.",
      variant === "descriptive" ? "Neri reveals where the ledger was found; the discovery records no new canonical state."
        : "Neri shows Ada the ledger and offers to release it or withhold it. The player has not yet made that choice."));
  }
  if (variant === "revelation") {
    const path = "revelations/ledger-shared.md";
    await mkdir(join(job.worktreeStoryRoot, "revelations"), { recursive: true });
    await writeFile(join(job.worktreeStoryRoot, path), `---\nschema: '0.1'\ntype: revelation\nid: revelation.ledger-shared\ntitle: "Evidence disclosed"\nstatus: draft\ndecisions: []\nfact: fact.evidence-concealed\n---\n\nThe player is shown the concealed ledger evidence during Neri's confession.\n`, { flag: "wx" });
    files.push(path);
    const eventPath = join(job.worktreeStoryRoot, "events/disclose-ledger.md");
    await writeFile(eventPath, (await readFile(eventPath, "utf8")).replace(
      "            value: trusting", "            value: trusting\n          - kind: revealed\n            revelation: revelation.ledger-shared\n            value: true"));
  }
  if (variant === "unconnected") {
    const path = "facts/unrelated-rumor.md";
    await mkdir(join(job.worktreeStoryRoot, "facts"), { recursive: true });
    await writeFile(join(job.worktreeStoryRoot, path),
      "---\nschema: '0.1'\ntype: fact\nid: fact.unrelated-rumor\ntitle: \"Unrelated rumor\"\nstatus: draft\ndecisions: []\ninitial: false\n---\n\nAn entirely unrelated state proposition.\n",
      { flag: "wx" });
    files.push(path);
  }
  const file = join(job.worktreeStoryRoot, assignment.milestonePath);
  const old = await readFile(file, "utf8");
  if (!old.includes("fulfillment: {any_of: []}")) throw new Error("Fixture requires an unbound planning Milestone.");
  if (variant !== "decision-pending") {
    await writeFile(file, old.replace("completeness: partial\n", "")
      .replace("fulfillment: {any_of: []}", cluster.text(variant === "alternative-routes"
        ? "fulfillment: {any_of: [[event.inspect-ledger, event.disclose-ledger], [event.disclose-ledger]]}"
        : "fulfillment: {any_of: [[event.disclose-ledger]]}")));
    files.push(assignment.milestonePath);
  }
  if (variant === "milestone-retcon") {
    await writeFile(file, (await readFile(file, "utf8")).replace("The investigator can no longer act alone", "The investigator must act entirely alone"));
  }
  if (variant === "unauthorized") {
    const creative = assignment.sourcePaths.find(p => p.startsWith("creative-direction/"))!;
    await writeFile(join(job.worktreeStoryRoot, creative), (await readFile(join(job.worktreeStoryRoot, creative), "utf8")) +
      "\nThis is an unauthorized addition.\n");
  }
  if (variant === "mismatch") files.push("events/never-written.md");
  if (configured === "phantom-milestone") files.push(assignment.milestonePath);
  return { claimedPaths: files, conflicts: [], obligations:
    ["decision-pending", "false-decision-complete", "fake-unrelated-effects"].includes(variant)
      ? ["Formal Choice Point binding and outcome-specific later consumers remain with the Choice specialist."]
      : variant === "event-only"
        ? ["Player-facing prose of this source-grounded observational discovery requires Composition and independent editorial review."]
        : ["Player-facing prose and alternate branch details require composition and editorial review."],
    skillReads: [] };
}

export async function runEventWorkItem(input: EventOptions) {
  if (!idPattern.test(input.milestone)) throw new Error("--milestone must be a typed milestone.<slug> ID.");
  const job = await startStoryJob({ story: input.story, job: input.job }, false);
  const root = job.stateDir;
  const receiptFile = join(root, "event-items", input.milestone.slice(10) + ".json");
  if (input.action === "inspect" && !existsSync(receiptFile)) throw new Error("No Event work item receipt to inspect.");
  return withStoryJobLock(job, "event-" + input.milestone.slice(10), async () => {
    if (input.action === "run") await processAuthorUpdatesAtBoundary(job);
    if (!existsSync(join(root, "architecture.json")) || !existsSync(join(root, "character-world.json"))) {
      throw new Error("Event design requires committed architecture and Character/World foundations.");
    }
    const arch = JSON.parse(await readFile(join(root, "architecture.json"), "utf8")) as ArchitectureReceipt;
    const foundation = JSON.parse(await readFile(join(root, "character-world.json"), "utf8")) as FoundationsReceipt;
    if (arch.jobId !== job.jobId || arch.phase !== "committed" || !arch.plan ||
        foundation.jobId !== job.jobId ||
        foundation.architectureHead !== arch.expectedHead ||
        foundation.units?.length !== 2 || foundation.units[0]?.id !== "world-foundations" ||
        foundation.units[1]?.id !== "character-foundations" ||
        foundation.units.some(u => u.phase !== "committed" || !u.commitSha)) {
      throw new Error("Event work item requires verified current Character/World foundations and architecture.");
    }
    assertPlanContinuity(job, arch, "foundations", foundation.planVersion);
    if (!git(job, "log", "-1", "--format=%B", foundation.units[1]!.commitSha!)
      .includes("NovelTea-Work-Item: character-foundations")) {
      throw new Error("Character foundation commit does not carry verified work-item provenance.");
    }
    try {
      rawGit(job, "merge-base", "--is-ancestor", arch.expectedHead, foundation.units[0]!.commitSha!);
      rawGit(job, "merge-base", "--is-ancestor", foundation.units[0]!.commitSha!, foundation.units[1]!.commitSha!);
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
      assertPlanContinuity(job, arch, "event:" + input.milestone, receipt.planVersion, receipt.planDigest);
    } else {
      if (input.action !== "run") throw new Error("No Event work item to inspect.");
      const head = await trustedHead(job);
      if (dirty(job).length) throw new Error("Event work item requires a clean verified worktree.");
      receipt = { version: 1, jobId: job.jobId, baseSha: job.baseSha,
        milestoneId: input.milestone, workItemId, planVersion: arch.plan.version,
        planDigest, expectedHead: head, phase: "ready", worker: input.fixture ? "fixture" : "pi",
        provider: input.provider ?? "openai", model: input.model ?? "gpt-6-luna" };
      await persist(receiptFile, receipt);
    }
    if (input.action === "inspect") return output(job, receipt);
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
    if (receipt.reroutedFrom) {
      // Even after a graph restart, bind the new task to the original,
      // authenticated no-write decision; durable task text cannot grant scope.
      const history = join(root, "event-prerequisite-history",
        input.milestone.slice(10) + "-" + receipt.reroutedFrom + ".json");
      const original = JSON.parse(await readFile(history, "utf8")) as EventReceipt;
      if (original.phase !== "prerequisite-reported" || !original.prerequisite ||
          original.jobId !== job.jobId || original.workItemId !== workItemId ||
          original.planDigest !== planDigest || original.expectedHead !== receipt.expectedHead ||
          original.worker !== receipt.worker || original.provider !== receipt.provider ||
          original.model !== receipt.model || original.snapshot?.id !== receipt.snapshot.id ||
          original.claimedPaths?.length || !original.assignment ||
          !original.conflicts || !original.obligations || original.reroutedFrom ||
          receipt.reroutedFrom !== original.prerequisite.reportDigest)
        throw Error("Rerouted Event setup lacks a matching original no-write authority.");
      const source = original.prerequisite;
      if (eventPrerequisiteReportDigest({
        jobId: job.jobId, workItemId, expectedHead: original.expectedHead,
        planDigest: original.planDigest, sessionSha256: source.sessionSha256,
        sessionId: source.sessionId, assignmentDigest: hash(JSON.stringify(original.assignment)),
        snapshotId: original.snapshot!.id, sessionFile: source.sessionFile,
        worker: original.worker, conflicts: original.conflicts, obligations: original.obligations,
      }) !== receipt.reroutedFrom ||
        source.assignmentDigest !== hash(JSON.stringify(original.assignment)) ||
        source.worker !== original.worker || source.snapshotId !== original.snapshot?.id)
        throw Error("Rerouted Event setup predecessor receipt is tampered.");
      const route = routeEventPrerequisite({
        milestone: input.milestone, activeStage: "event",
        expectedHead: original.expectedHead, verifiedHead: original.expectedHead,
        reportDigest: source.reportDigest, conflicts: original.conflicts,
        obligations: original.obligations, alreadyRerouted: false,
      });
      if (route.kind !== "event-setup" || route.task !== receipt.reroutedTask)
        throw Error("Rerouted Event setup task changed from controller-approved source.");
      if (original.worker === "pi") {
        await verifyJobPiSession(job, "event", source.sessionFile, source.sessionId, original.workItemId);
        if (hash(await readFile(source.sessionFile)) !== source.sessionSha256)
          throw Error("Rerouted Event predecessor's settled Pi session changed.");
      }
    }
    const validate = async (head: string) => validateStoryJob(
      await startStoryJob({ story: input.story, job: input.job }, false),
      input.validatorSource ?? input.skillsSource ?? config.novelteaSkills, { ...job, baseSha: head });
    if (input.reroute && receipt.phase !== "prerequisite-reported" &&
        receipt.reroutedFrom !== input.reroute.reportDigest)
      throw Error("Event setup reassignment does not match the original no-write report.");
    if (receipt.phase === "prerequisite-reported") {
      if (!receipt.prerequisite || !receipt.assignment ||
          (receipt.worker === "pi" && !receipt.sessionFile) ||
          receipt.claimedPaths?.length || !receipt.conflicts || !receipt.obligations || dirty(job).length)
        throw Error("A reported Event prerequisite is missing its clean original source.");
      if (receipt.worker === "pi") {
        await verifyJobPiSession(job, "event", receipt.sessionFile,
          receipt.prerequisite.sessionId, receipt.workItemId);
        if (hash(await readFile(receipt.sessionFile!)) !== receipt.prerequisite.sessionSha256)
          throw Error("Event prerequisite report's settled Pi transcript changed.");
      } else if (receipt.prerequisite.sessionSha256 !== "f".repeat(64)) {
        throw Error("Fixture prerequisite report has unexpected source identity.");
      }
      if (receipt.prerequisite.expectedHead !== receipt.expectedHead ||
          receipt.prerequisite.assignmentDigest !== hash(JSON.stringify(receipt.assignment)) ||
          receipt.prerequisite.snapshotId !== receipt.snapshot?.id ||
          receipt.prerequisite.sessionFile !== (receipt.sessionFile ?? "fixture") ||
          receipt.prerequisite.worker !== receipt.worker ||
          receipt.prerequisite.reportDigest !== eventPrerequisiteReportDigest({
            jobId: job.jobId, workItemId: receipt.workItemId, expectedHead: receipt.expectedHead,
            planDigest: receipt.planDigest,
            sessionSha256: receipt.prerequisite.sessionSha256,
            sessionId: receipt.prerequisite.sessionId,
            assignmentDigest: receipt.prerequisite.assignmentDigest,
            snapshotId: receipt.prerequisite.snapshotId,
            sessionFile: receipt.prerequisite.sessionFile, worker: receipt.prerequisite.worker,
            conflicts: receipt.conflicts, obligations: receipt.obligations }))
        throw Error("Event prerequisite report changed after its original Pi decision.");
      try { rawGit(job, "merge-base", "--is-ancestor", receipt.expectedHead, await trustedHead(job)); }
      catch { throw Error("Event prerequisite report no longer descends from its pinned Story source."); }
      if (input.reroute) {
        const routed = routeEventPrerequisite({
          milestone: input.milestone, activeStage: "event",
          expectedHead: receipt.expectedHead, verifiedHead: receipt.expectedHead,
          reportDigest: receipt.prerequisite.reportDigest,
          conflicts: receipt.conflicts, obligations: receipt.obligations,
          alreadyRerouted: false,
        });
        if (receipt.reroutedFrom || input.reroute.reportDigest !== receipt.prerequisite.reportDigest ||
            input.reroute.sourceSha !== receipt.expectedHead ||
            await trustedHead(job) !== receipt.expectedHead ||
            routed.kind !== "event-setup" || input.reroute.task !== routed.task)
          throw Error("Stale, unauthorized or repeated Event setup reassignment; controller approval is required.");
        // Preserve the complete authenticated original, including the settled
        // session digest and no-write decision, before any new writer can start.
        const history = join(root, "event-prerequisite-history",
          input.milestone.slice(10) + "-" + receipt.prerequisite.reportDigest + ".json");
        await mkdir(join(root, "event-prerequisite-history"), { recursive: true });
        if (existsSync(history)) {
          if (await readFile(history, "utf8") !== JSON.stringify(receipt, null, 2) + "\n")
            throw Error("Conflicting Event prerequisite archive; reconcile manually.");
        } else await persist(history, receipt);
        receipt = { version: 1, jobId: job.jobId, baseSha: job.baseSha,
          workItemId, milestoneId: input.milestone, planVersion: arch.plan.version,
          planDigest, expectedHead: receipt.expectedHead, phase: "ready",
          worker: receipt.worker, provider: receipt.provider, model: receipt.model,
          snapshot: receipt.snapshot, reroutedFrom: input.reroute.reportDigest,
          reroutedTask: input.reroute.task };
        await persist(receiptFile, receipt);
      } else return output(job, receipt);
    }
    if (receipt.phase === "committed") {
      if (!receipt.commitSha) throw new Error("Committed Event work item lacks a commit.");
      verifyCommit(job, receipt, receipt.commitSha);
      try { rawGit(job, "merge-base", "--is-ancestor", receipt.commitSha, "HEAD"); }
      catch { throw new Error("Verified Event commit no longer belongs to the job branch."); }
      if (git(job, "rev-parse", "HEAD") === receipt.commitSha) {
        if (dirty(job).length) throw new Error("Unexpected edits after Event commit.");
        await publishHead(job, receipt.expectedHead, receipt.commitSha, receipt.workItemId);
      }
      return output(job, receipt);
    }
    const Channels = Annotation.Root({ receipt: Annotation<EventReceipt>() });
    const graph = new StateGraph(Channels)
      .addNode("event_specialist", async ({ receipt }) => {
        if (receipt.phase === "authored") return { receipt };
        if (receipt.phase === "writing") {
          throw new Error("Interrupted Event specialist writing; inspect preserved worktree and session before retry.");
        }
        const resuming = receipt.phase === "awaiting-author";
        const choice = resuming && receipt.authorChoiceId
          ? await verifySpecialistChoice(job, receipt.authorChoiceId, "answered") : null;
        if (resuming && (!choice || choice.workItem !== receipt.workItemId || !receipt.assignment))
          throw new Error("Event choice has no exact answered work-item assignment.");
        assertHead(job, receipt.expectedHead);
        if (!resuming && dirty(job).length)
          throw new Error("Event specialist requires a clean work-item boundary.");
        const prior = resuming ? null : reportOf(await validate(receipt.expectedHead), receipt.expectedHead);
        const assign = resuming ? receipt.assignment! : {
          ...selectedAssignment(job, arch.plan!, prior!, receipt.milestoneId, receipt.workItemId),
          ...(receipt.reroutedTask ? { authorTask: receipt.reroutedTask } :
            input.task ? { authorTask: input.task } : {}),
        };
        await preflightPiAssignment(job, "event:" + receipt.workItemId,
          receipt.worker === "pi" ? { provider: receipt.provider, model: receipt.model } : undefined);
        if (resuming) await claimSpecialistChoice(job, receipt.authorChoiceId!);
        receipt.assignment = assign;
        receipt.phase = "writing";
        await persist(receiptFile, receipt);
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
            if (draft.diagnostics.length) return draft.diagnostics.slice(0, 20)
              .map(d => `${d.path}:${d.line ?? 1}:${d.column ?? 1} ${d.code}: ${d.message}`);
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
            if (candidate.conflicts.length && !localEvidenceGap && !falseChoiceDeferral &&
                !laterChoiceSetup)
              throw new Error("Architectural conflict: " + candidate.conflicts.join("; "));
            const authoredEventIds = draft.records
              .filter(record => paths!.includes(record.path) &&
                record.metadata.type === "event" && record.metadata.status !== "superseded")
              .map(record => record.metadata.id);
            if (localEvidenceGap)
              return [eventEvidenceRepairFeedback(assign, candidate.conflicts, authoredEventIds)];
            if (falseChoiceDeferral)
              return [eventNondecisionChoiceCorrection(
                assign, candidate.conflicts, sourceChange, authoredEventIds)];
            if (laterChoiceSetup)
              return [eventDecisionSetupCorrection(assign, sourceChange, candidate.conflicts)];
            try {
              acceptance(draft, assign, paths!, candidate.obligations);
              const proof = await consequenceProof(job, draft, assign, paths!, candidate.obligations);
              return proof.diagnostics.map(d =>
                `${d.path}:${d.line} ${d.event}/${d.step}/${d.branch} ${d.slot}: ${d.message}`);
            } catch (error) {
              const message = String(error);
              if (/Selected Milestone lacks a deterministically reachable Event fulfillment route\./.test(message)) {
                // No formal Choice deferral was established. This nondecision
                // milestone is not complete merely because the Event is
                // structurally reachable; show the needed evidence in-scene.
                return [eventEvidenceRepairFeedback(assign, [
                  "Milestone " + assign.milestoneId +
                  " lacks a deterministically reachable evidence route: the Event does not establish " +
                  "the material observation or witness support promised by the selected Milestone.",
                ], authoredEventIds)];
              }
              return [message];
            }
          };
          let evidence: EventEvidence;
          if (receipt.worker === "fixture") {
            evidence = await fixtureAuthor(job, assign, !!receipt.reroutedFrom);
            if (["failed-repair", "repair"].includes(process.env.NT_EVENT_FIXTURE_CASE ?? "")) {
              // Exercise the same bounded, source-located feedback seam as Pi:
              // one fixture corrects the contradiction; another refuses.
              for (let attempt = 0; attempt < 3; attempt++) {
                const errors = await verifyDraft(evidence);
                if (!errors.length) break;
                if (process.env.NT_EVENT_FIXTURE_CASE === "repair" && attempt === 0) {
                  const target = join(job.worktreeStoryRoot, "events/disclose-ledger.md");
                  await writeFile(target, (await readFile(target, "utf8"))
                    .replace("completed: [event.inspect-ledger]\n      not_completed: [event.inspect-ledger]",
                      "completed: []\n      not_completed: []"));
                } else if (attempt === 2) {
                  throw new Error("Event specialist exhausted bounded repair attempts: " + errors.join("; "));
                }
              }
            }
          } else {
            evidence = await authorEventCluster(job, receipt.snapshot!, assign, receipt.provider, receipt.model,
              async file => { receipt.sessionFile = file; await persist(receiptFile, receipt); }, verifyDraft,
              choice ?? undefined, receipt.reroutedFrom);
          }
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
            const sessionSha256 = receipt.worker === "fixture" ? "f".repeat(64) :
              hash(await readFile(evidence.sessionFile!));
            const sessionId = receipt.worker === "fixture" ? "fixture" : evidence.piSessionId!;
            receipt.claimedPaths = [];
            receipt.conflicts = evidence.conflicts;
            receipt.obligations = evidence.obligations;
            receipt.skillReads = evidence.skillReads;
            receipt.sessionFile = evidence.sessionFile;
            const payload = { jobId: job.jobId, workItemId: receipt.workItemId,
              expectedHead: receipt.expectedHead, planDigest: receipt.planDigest,
              sessionSha256, sessionId, assignmentDigest: hash(JSON.stringify(receipt.assignment)),
              snapshotId: receipt.snapshot!.id, sessionFile: evidence.sessionFile ?? "fixture",
              worker: receipt.worker, conflicts: evidence.conflicts,
              obligations: evidence.obligations };
            receipt.prerequisite = { expectedHead: receipt.expectedHead, sessionSha256,
              sessionId, assignmentDigest: payload.assignmentDigest,
              snapshotId: payload.snapshotId, sessionFile: payload.sessionFile,
              worker: receipt.worker, reportDigest: eventPrerequisiteReportDigest(payload) };
            receipt.phase = "prerequisite-reported";
            delete receipt.failure;
            await persist(receiptFile, receipt);
            return { receipt }; // No commit, checkpoint, grant or automatic replay.
          }
          if (resuming) await completeSpecialistChoice(job, receipt.authorChoiceId!);
          receipt.claimedPaths = evidence.claimedPaths;
          receipt.conflicts = evidence.conflicts;
          receipt.obligations = evidence.obligations;
          receipt.skillReads = evidence.skillReads;
          receipt.sessionFile = evidence.sessionFile ?? receipt.sessionFile;
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
            "commit", "-m", `Realize ${receipt.milestoneId} [${job.jobId}]\n\nNovelTea-Job: ${job.jobId}\nNovelTea-Work-Item: ${receipt.workItemId}\nNovelTea-Plan-Version: ${receipt.planVersion}\nNovelTea-Event-Design: ${receipt.contentDigest}\nNovelTea-Event-Completion: ${completionDigest}\nNovelTea-Event-Consequence: ${typedDigest}`);
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
      .addEdge("event_specialist", "validate_and_commit_event")
      .addEdge("validate_and_commit_event", END).compile();
    const result = await graph.invoke({ receipt });
    const authorUpdates = await processAuthorUpdatesAfterWork(job);
    const { scheduleIdeasAtBoundary } = await import("./idea-placement.js");
    await scheduleIdeasAtBoundary(job, "event-work");
    return { ...output(job, result.receipt), authorUpdates };
  });
}
