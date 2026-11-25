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
import { deriveReviewDependencyRequest, reviewOtherOwners, type OtherOwnerCheckpoint, type EventCharacterRepairGrant,
  type ReviewDependencyRequest } from "./review-repair-amendment.js";
import { readTurnEvidence, type TurnEvidence } from "./turn-plan-evidence.js";
import { validateStoryJob } from "./validator.js";
import type { CanonicalScopeRecord } from "./focused-scope.js";
import { authorizeDependency, authorizeReviewCharacterDependency, authorizeReviewOtherOwnerDependency, authorizeBlueprintCharacterDependency, authorizeWriterDependency, selectBlueprintArcSources, parseDependencyReport,
  type DependencyReport, type DependencyProposal, type ReviewCharacterProposal,
  type DependencyAmendment, DependencyAuthorizationRefusedError } from "./dependency-amendments.js";
export { DependencyAuthorizationRefusedError };
import type { SkillSnapshot } from "./snapshot.js";
import type { EditorialVerdict, ReviewAssignment } from "./narrative-review-specialist.js";

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
export interface BlueprintArcSource { id: string; path: string }
export interface BlueprintDependencySource {
  milestoneId: string; readinessDigest: string; target: string; arcCandidates: BlueprintArcSource[];
  readiness: "unrealized-character" | "outside-event-authority";
  targetPath?: string;
}
/** Native catalog IDs, not filenames, define the possible enclosing Arc links.
 * An explicit Arc anchor narrows the candidates; a Milestone anchor does not. */
export function blueprintArcCandidates(
  assignment: { arcIds: string[]; sourcePaths: string[] },
  anchors: string[], records: CanonicalScopeRecord[],
): BlueprintArcSource[] {
  const arcs = records.filter(r => r.metadata.type === "arc" && r.metadata.status !== "superseded" &&
    assignment.arcIds.includes(r.metadata.id) && assignment.sourcePaths.includes(r.path))
    .map(r => ({ id: r.metadata.id, path: r.path })).sort((a, b) => a.id.localeCompare(b.id));
  if (arcs.length !== new Set(assignment.arcIds).size ||
      new Set(arcs.map(a => a.id)).size !== arcs.length)
    throw Error("Blueprint Arc sources differ from the native canonical assignment.");
  const cited = arcs.filter(a => anchors.includes(a.path));
  return cited.length && anchors.every(path => cited.some(a => a.path === path)) ? cited : arcs;
}
/** Previously persisted v1 entries retain their original receipt bytes and
 * digest. Read the canonical ID from their sealed report, not the filename. */
export function blueprintSourceOf(entry: Pick<DependencyEntry, "blueprintSource" | "report">): BlueprintDependencySource | undefined {
  const source = entry.blueprintSource;
  if (!source) return undefined;
  if (Array.isArray(source.arcCandidates)) return source;
  const legacy = source as unknown as { milestoneId: string; readinessDigest: string; target: string; arcPath?: string };
  const [id, milestone] = entry.report.affectedIds;
  const [arc] = entry.report.sources;
  if (!legacy.arcPath || !id?.startsWith("arc.") || milestone !== legacy.milestoneId ||
      entry.report.affectedIds.length !== 2 || arc?.path !== legacy.arcPath ||
      arc.quote.trim() !== "id: " + id)
    throw Error("Legacy Blueprint prerequisite lacks its sealed canonical Arc identity.");
  return { milestoneId: legacy.milestoneId, readinessDigest: legacy.readinessDigest,
    target: legacy.target, arcCandidates: [{ id, path: legacy.arcPath }], readiness: "unrealized-character" };
}

export interface DependencyEntry {
  writerSource?: import("./writer-dependency.js").WriterDependencySource;
  blueprintSource?: BlueprintDependencySource;
  /** Existing ledger edge: the child was reported by this exact admitted support writer. */
  parent?: { reportDigest: string; suspensionDigest: string; planVersion: number };
  report: DependencyReport; reportDigest: string;
  /** The separate Event owner's reviewed correction; not part of the Character
   * specialist's new-record write grant. */
  eventRepair?: { sourceSha: string; commitSha: string; proofDigest: string };
  phase: "reported" | "planning" | "authorized" | "reviewing" | "verified" | "rejected";
  amendment?: DependencyAmendment; proposal?: DependencyProposal;
  approval?: { authority: "necessary-dependency/v1"; jobId: string; threadId: string;
    sourceSha: string; amendmentDigest: string };
  planner?: { snapshot: SkillSnapshot; sessionFile: string; skillReads?: string[] };
  /** The original committed support remains immutable when common Review repair advances HEAD. */
  supportRootSha?: string;
  commitSha?: string; review?: EditorialVerdict; reviewerSession?: string;
  /** Independently sealed focused-support verdict transcript. */
  reviewerSessionDigest?: string;
  reviewSnapshot?: SkillSnapshot; reviewProvider?: string; reviewModel?: string;
  fixture: boolean;
  /** Exact sealed negative review which generated a supporting work report. */
  reviewSourceSha?: string;
  originalReview?: EditorialVerdict; originalReviewerSession?: string;
  originalReviewerSessionDigest?: string; originalReviewerSessionBytes?: number;
  rejection?: { kind?: "planning-needed" | "authorization-refused"; reason: string; proposal: unknown };
}
export interface DependencyPlan {
  schema: "noveltea-dependency-plan/v1"; jobId: string; threadId: string;
  turnDigest: string; version: number; entries: DependencyEntry[];
  /** Sealed findings awaiting a separate verified plan amendment. These are
   * never writer authorization and do not consume an amendment version. */
  reviewRequests?: ReviewDependencyRequest[];
  digest: string;
}
/** The supporting writer retains its original logical grant; only a fully
 * verified direct prerequisite can move its effective Git source forward. */
export function dependencyWriterBase(plan: Pick<DependencyPlan, "entries">, entry: DependencyEntry): string {
  const children = plan.entries.filter(e => e.parent?.reportDigest === entry.reportDigest);
  if (children.length > 1) throw Error("Dependency has multiple competing suspensions.");
  const child = children[0];
  if (child?.phase === "verified") {
    if (!child.commitSha || child.amendment?.resumes !== entry.amendment?.assignment.id ||
        child.report.sourceSha !== entry.report.sourceSha)
      throw Error("Dependency successor lacks exact predecessor authority.");
    return child.commitSha;
  }
  return entry.report.sourceSha;
}
export function dependencyAncestors(entries: readonly DependencyEntry[], entry: DependencyEntry): Set<string> {
  const ancestors = new Set<string>();
  let cursor: DependencyEntry | undefined = entry;
  while (cursor) {
    if (ancestors.has(cursor.reportDigest)) throw Error("Cyclic dependency ancestry.");
    ancestors.add(cursor.reportDigest);
    if (!cursor.parent) break;
    const parentDigest: string = cursor.parent.reportDigest;
    const index = entries.indexOf(cursor);
    cursor = entries.find(e => e.reportDigest === parentDigest);
    if (!cursor || entries.indexOf(cursor) >= index) throw Error("Dependency ancestor must precede its child.");
  }
  return ancestors;
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
/** Derive the same narrow obligation at each serial predecessor boundary from
 * the original independently approved Blueprint, never model-supplied paths. */
export async function blueprintDependencyReport(job: JobStartResult, source: BlueprintDependencySource,
  head: string, turn: TurnEvidence): Promise<DependencyReport> {
  const original = await (await import("./event-work.js")).inspectArchivedEventBlueprintPrerequisite(
    job, source.milestoneId, source.readinessDigest);
  const blockers = original.report.blockers.filter(b => b.characterId === source.target);
  const arcs = source.arcCandidates;
  const cited = Array.isArray(arcs) ? arcs.filter(a => blockers.some(b => b.anchorPath === a.path)) : [];
  const onlyArcAnchors = blockers.every(b => original.assignment.sourcePaths.includes(b.anchorPath) &&
    cited.some(a => a.path === b.anchorPath));
  const obligation = turn.objective?.obligations.find(x => /\bcharacters\b/i.test(x));
  if (!Array.isArray(arcs) || !arcs.length || new Set(arcs.map(a => a.id)).size !== arcs.length ||
      new Set(arcs.map(a => a.path)).size !== arcs.length ||
      arcs.some(a => !original.assignment.sourcePaths.includes(a.path) ||
        !original.assignment.arcIds.includes(a.id)) ||
      (onlyArcAnchors ? cited.length !== arcs.length : arcs.length !== original.assignment.arcIds.length) ||
      !blockers.length || blockers.some(b => b.readiness !== source.readiness) ||
      (source.readiness === "outside-event-authority") !== !!source.targetPath ||
      !obligation || turn.kind !== "full-story" || turn.objective?.breadth !== "whole-story")
    throw Error("Blueprint prerequisite lacks authenticated Character/Arc source candidates.");
  const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
  const sources = [...arcs, { path: original.assignment.milestonePath, id: source.milestoneId },
    ...(source.targetPath ? [{ path: source.targetPath, id: source.target }] : [])].map(({ path, id }) => {
    const bytes = dependencyGit(job, "show", head + ":" + prefix + path);
    // The ID comes from native metadata at admission. Preserve a literal
    // source quote and hash to authenticate it at historical Git revisions.
    const quote = bytes.split(/\r?\n/).find(line =>
      /^id:\s*/.test(line.trim()) &&
      [id, '"' + id + '"', "'" + id + "'"].includes(line.trim().replace(/^id:\s*/, "")));
    if (!quote) throw Error("Blueprint prerequisite source ID differs from the original assignment.");
    return { path, sha256: sourceDigest(bytes), quote };
  });
  return parseDependencyReport({
    sourceSha: head, turnDigest: turn.digest, assignmentId: "event", obligation,
    missing: (source.readiness === "outside-event-authority" ? "Link existing " : "Realize ") + source.target + " for " + source.milestoneId + ": " +
      [...new Set(blockers.map(b => b.role))].join("; "),
    affectedIds: [...arcs.map(a => a.id), source.milestoneId, ...(source.targetPath ? [source.target] : [])], sources,
    likelySpecialist: "nt-character-development", authorDecisionRequired: false,
  });
}
export async function registerBlueprintDependency(job: JobStartResult,
  milestoneId: string, readinessDigest: string, target: string, validatorSource?: string) {
  const original = await (await import("./event-work.js")).inspectArchivedEventBlueprintPrerequisite(job, milestoneId, readinessDigest);
  const head = await dependencyBoundary(job);
  const native = await validateStoryJob(job, validatorSource, { ...job, baseSha: head });
  const catalog = native.report?.records as CanonicalScopeRecord[] | undefined;
  if (native.status !== "passed" || !catalog)
    throw Error("Blueprint prerequisite requires a verified native canonical catalog.");
  const arcCandidates = blueprintArcCandidates(original.assignment,
    original.report.blockers.filter(b => b.characterId === target).map(b => b.anchorPath), catalog);
  const readiness = original.report.blockers.find(b => b.characterId === target)?.readiness;
  if (!readiness) throw Error("Blueprint target is not an authenticated prerequisite.");
  const targetRecord = catalog.find(r => r.metadata.id === target && r.metadata.type === "character" &&
    r.metadata.status !== "superseded");
  if ((readiness === "outside-event-authority") !== !!targetRecord)
    throw Error("Blueprint prerequisite changed native readiness.");
  const source = { milestoneId, readinessDigest, target, arcCandidates, readiness,
    ...(targetRecord ? { targetPath: targetRecord.path } : {}) };
  const report = await blueprintDependencyReport(job, source, head, await dependencyTurn(job));
  return recordDependency(job, report, false, source);
}

/** Authenticate the last actual writer at the failed Review source, not a
 * path guessed from an assignment's record-type permission. Historical
 * inspection uses the same immutable Git history even after support commits. */
export async function reviewOtherOwnerCheckpoint(job: JobStartResult, turn: TurnEvidence,
  originalId: string, sourceSha: string, path: string,
  points?: Awaited<ReturnType<typeof inspectRecoveryCheckpoints>>): Promise<OtherOwnerCheckpoint | undefined> {
  if (turn.kind !== "full-story" || turn.objective?.breadth !== "whole-story" ||
      reviewOtherOwners(turn, originalId, path).length) return undefined;
  const repoPath = (job.storyRelativePath ? job.storyRelativePath + "/" : "") + path;
  const last = dependencyGit(job, "log", "-1", "--format=%H", sourceSha, "--", repoPath);
  const point = (points ?? await inspectRecoveryCheckpoints(job, "historical")).find(p =>
    p.commitSha === last && p.commitSha !== sourceSha && p.eligible &&
    p.assurance?.turnDigest === turn.digest && p.assurance.changedPaths.includes(path) &&
    (p.semanticReview === "passed" || p.semanticReview === "not-required") &&
    !p.workItem.startsWith("repair-") && !p.workItem.startsWith("dependency:"));
  if (!point?.assurance) return undefined;
  const checkpoint = { assignmentId: point.assurance.assignmentId, workItem: point.workItem,
    commitSha: point.commitSha, assuranceDigest: dependencyDigest(point.assurance) };
  if (reviewOtherOwners(turn, originalId, path, checkpoint).length !== 1) return undefined;
  return checkpoint;
}

async function inspectDependencyLedger(job: JobStartResult, grantsOnly: boolean): Promise<DependencyPlan | null> {
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
  if (!grantsOnly && saved.reviewRequests?.length) {
    const checkpoints = (await inspectRecoveryCheckpoints(job, "historical")).filter(p => p.eligible && p.assurance);
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
      const otherOwnerCheckpoint = repair && request.otherOwnerPath
        ? await reviewOtherOwnerCheckpoint(job, turn, original.id, request.sourceSha, request.otherOwnerPath, checkpoints)
        : undefined;
      if (sealed?.status !== "failed" || !sealed.result ||
          JSON.stringify(deriveReviewDependencyRequest({ assurance: point.assurance,
            review: sealed.result, original, turn,
            planVersion: request.basePlanVersion,
            originWorkItem: point.workItem,
            ...(repair ? { otherOwnerPath: repair.outOfAuthority!.path, otherOwnerCheckpoint } : {}) })) !== JSON.stringify(request))
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
    if (entry.writerSource) {
      if (entry.fixture || entry.parent || entry.blueprintSource || entry.reviewSourceSha)
        throw Error("Writer dependency cannot substitute another source.");
      if (!grantsOnly) {
        const original = await (await import("./writer-dependency.js")).inspectWriterDependency(job, entry.writerSource);
        if (original.reportDigest !== entry.reportDigest || dependencyDigest(original.report) !== dependencyDigest(entry.report))
          throw Error("Writer dependency lost its original settled source.");
      }
      if (entry.writerSource.predecessor) {
        const pin = entry.writerSource.predecessor;
        const prior = saved.entries.find(e => e.reportDigest === pin.reportDigest);
        if (!prior?.writerSource || !seen.has(prior.reportDigest) || prior.phase !== "verified" ||
            !prior.commitSha || prior.report.sourceSha !== pin.originalHead || dependencyDigest(prior) !== pin.supportRef ||
            prior.writerSource.stage !== entry.writerSource.stage ||
            prior.writerSource.workItemId !== entry.writerSource.workItemId ||
            prior.writerSource.milestoneId !== entry.writerSource.milestoneId ||
            prior.writerSource.planVersion !== entry.writerSource.planVersion)
          throw Error("Writer dependency lost its earlier verified continuation.");
        dependencyGit(job, "merge-base", "--is-ancestor", prior.commitSha, entry.report.sourceSha);
      }
      if (entry.amendment && (entry.amendment.assignment.targets.join() !== entry.writerSource.targetId ||
          entry.amendment.assignment.specialist !== entry.report.likelySpecialist ||
          JSON.stringify(entry.amendment.assignment.authority.existingPaths) !== JSON.stringify([entry.writerSource.targetPath]) ||
          entry.amendment.assignment.authority.newPaths?.length || entry.amendment.assignment.authority.mayCreate))
        throw Error("Writer dependency grant changed its exact existing owner scope.");
    }
    if (entry.report.assignmentId.startsWith("dependency:") && !entry.parent)
      throw Error("Nested dependency is missing its originating parent.");
    if (entry.parent) {
      dependencyAncestors(saved.entries, entry);
      const parent = saved.entries.find(e => e.reportDigest === entry.parent!.reportDigest);
      const grant = parent?.amendment;
      if (!parent || !grant || !["authorized", "reviewing", "verified", "rejected"].includes(parent.phase) ||
          !Number.isSafeInteger(entry.parent.planVersion) || entry.parent.planVersion < 1 ||
          entry.blueprintSource || entry.reviewSourceSha ||
          grant.assignment.id !== entry.report.assignmentId ||
          entry.report.sourceSha !== parent.report.sourceSha ||
          saved.entries.filter(e => e.parent?.reportDigest === parent.reportDigest).length !== 1 ||
          (parent.phase === "verified" && entry.phase !== "verified"))
        throw Error("Nested dependency lost its exact suspended parent grant.");
      const origin = await (await import("./focused-work.js")).inspectFocusedPrerequisite(job,
        grant.assignment.targets[0]!, turn.digest, false, entry.parent.planVersion, grant.assignment.id);
      if (!origin || origin.seal.reportDigest !== entry.reportDigest ||
          dependencyDigest(origin.seal) !== entry.parent.suspensionDigest ||
          dependencyDigest(origin.report) !== entry.reportDigest)
        throw Error("Nested dependency lost its original settled no-write evidence.");
    }
    if (entry.blueprintSource) {
      const source = blueprintSourceOf(entry)!;
      const original = await (await import("./event-work.js")).inspectArchivedEventBlueprintPrerequisite(
        job, source.milestoneId, source.readinessDigest);
      const earlier = saved.entries.slice(0, saved.entries.indexOf(entry))
        .filter(e => e.blueprintSource?.readinessDigest === source.readinessDigest);
      if (entry.fixture || entry.reviewSourceSha ||
          earlier.some(e => e.phase !== "verified" || e.blueprintSource!.target === source.target) ||
          entry.report.sourceSha !== (earlier.at(-1)?.commitSha ?? original.report.expectedHead) ||
          dependencyDigest(await blueprintDependencyReport(job, source, entry.report.sourceSha, turn)) !== entry.reportDigest)
        throw Error("Blueprint dependency lost the original reviewed prerequisite or serial predecessor.");
      if (entry.amendment) {
        const a = entry.amendment.assignment;
        const selected = selectBlueprintArcSources(source, entry.proposal as ReviewCharacterProposal);
        const existing = source.readiness === "outside-event-authority";
        if (a.specialist !== "nt-character-development" ||
            JSON.stringify(a.targets) !== JSON.stringify([source.target]) ||
            JSON.stringify(a.authority) !== JSON.stringify({
              recordTypes: existing ? ["arc"] : ["arc", "character"],
              existingPaths: selected.map(a => a.path),
              ...(existing ? {} : { newPaths: ["characters/" + source.target.slice(10) + ".md"] }),
              mayCreate: !existing }) ||
            a.outcome !== entry.report.missing || entry.proposal?.target !== source.target)
          throw Error("Blueprint dependency grant differs from the exact reviewed predecessor.");
      }
    }
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
    if (!grantsOnly && entry.originalReview) {
      const request = saved.reviewRequests?.find(r => r.sourceSha === entry.reviewSourceSha);
      const { inspectPostcommitReviewCycle } = await import("./postcommit-review-cycle.js");
      const cycle = request && await inspectPostcommitReviewCycle(job, request.sourceSha, request.originalAssignmentDigest);
      const round = cycle?.rounds.find(r => r.commitSha === request!.sourceSha);
      const length = entry.originalReviewerSessionBytes;
      if (!request || !cycle || !round || cycle.turnDigest !== request.turnDigest ||
          entry.originalReviewerSession !== cycle.reviewer.file ||
          !length || !Number.isSafeInteger(length) || length <= round.transcriptBytes ||
          entry.phase === "verified" && entry.originalReview.verdict !== "pass")
        throw Error("Original dependency rereview lost its sealed negative reviewer or successor.");
      const bytes = (await readFile(cycle.reviewer.file)).subarray(0, length);
      if (bytes.length !== length ||
          createHash("sha256").update(bytes).digest("hex") !== entry.originalReviewerSessionDigest)
        throw Error("Original dependency rereview transcript changed.");
    }
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
    if (!grantsOnly && entry.phase === "verified" && entry.eventRepair) {
      const request = saved.reviewRequests?.find(r => r.sourceSha === entry.reviewSourceSha);
      const correction = entry.eventRepair;
      const proof = await readRepairCommitProof(job, "repair-" + correction.sourceSha);
      const first = await readRepairCommitProof(job, "repair-" + request!.sourceSha);
      const points = (await inspectRecoveryCheckpoints(job, "historical")).filter(p => p.eligible);
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
    const supportPassed = entry.phase === "verified" ||
      entry.phase === "reviewing" && entry.review?.verdict === "pass";
    const supportRejected = entry.phase === "rejected" && (!entry.reviewSourceSha || !!entry.supportRootSha) &&
      entry.review?.verdict === "block";
    if (supportRejected && (!entry.amendment || !entry.commitSha || !entry.reviewerSession || entry.fixture))
      throw Error("Negative supporting Review lacks its original committed assignment and reviewer.");
    if (!grantsOnly && (supportPassed || supportRejected) && !entry.fixture) {
      const session = entry.reviewerSession!;
      if (!session.startsWith(join(job.stateDir, "review-sessions") + "/") ||
          await realpath(session) !== session || !entry.reviewerSessionDigest ||
          createHash("sha256").update(await readFile(session)).digest("hex") !== entry.reviewerSessionDigest)
        throw Error("Supporting review lost its independently sealed transcript.");
    }
    if (supportPassed || supportRejected || entry.supportRootSha) {
      const a = entry.amendment!;
      const writerBase = dependencyWriterBase(saved, entry);
      const committed = entry.supportRootSha ?? entry.commitSha!;
      const proof = JSON.parse(await readFile(join(job.stateDir, "dependency-items", a.assignment.id + ".json"), "utf8"));
      const authorizedPaths = [...a.assignment.authority.existingPaths,
        ...(a.assignment.authority.newPaths ?? [])].sort();
      if (proof.phase !== "committed" || proof.jobId !== job.jobId || proof.workItemId !== a.assignment.id ||
          proof.commitSha !== committed || proof.expectedHead !== writerBase ||
          proof.assignmentDigest !== turn.digest || proof.worker !== (entry.fixture ? "fixture" : "pi") ||
          proof.validation?.status !== "passed" || proof.validation.validatorVersion !== job.validatorVersion ||
          proof.validation.baseSha !== writerBase ||
          JSON.stringify(proof.paths) !== JSON.stringify(authorizedPaths))
        throw Error("Dependency work receipt is missing or no longer matches its native-validated assignment.");
      const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
      const paths = authorizedPaths;
      if (dependencyGit(job, "rev-parse", committed + "^") !== writerBase ||
          dependencyGit(job, "diff", "--name-only", writerBase, committed).split("\n").join("\n") !==
            paths.map(p => prefix + p).join("\n") ||
          proof.sha256 !== dependencyDigest(paths.map(p => [p,
            sourceDigest(dependencyGit(job, "show", committed + ":" + prefix + p))])))
        throw Error("Dependency committed bytes or exact diff differ from the work receipt.");
      if (entry.blueprintSource) {
        const { auditArcLink } = await import("./focused-work.js");
        for (const path of a.assignment.authority.existingPaths) {
          const arc = prefix + path;
          auditArcLink(dependencyGit(job, "show", writerBase + ":" + arc),
            dependencyGit(job, "show", committed + ":" + arc), entry.blueprintSource.target);
          if (entry.commitSha !== committed && dependencyGit(job, "show", committed + ":" + arc) !==
              dependencyGit(job, "show", entry.commitSha + ":" + arc)) throw Error("Support correction changed the field-only Arc link.");
        }
      }
      dependencyGit(job, "merge-base", "--is-ancestor", entry.commitSha!, "HEAD");
      if (grantsOnly || (!supportPassed && !supportRejected)) continue;
      if (entry.supportRootSha) {
        const { inspectSharedSupportReview } = await import("./support-review.js");
        const checked = await inspectSharedSupportReview(job, entry, entry.commitSha!);
        if (JSON.stringify(checked) !== JSON.stringify(entry.review)) throw Error("Supporting Review differs from its completed independent transcript.");
      } else if (!entry.reviewSourceSha && !entry.fixture) {
        const { inspectCompletedPiReviewContext } = await import("./job-pi-policy.js");
        const { recoveredCloseoutReview } = await import("./cross-domain-closeout-work.js");
        const { openSkillSnapshot } = await import("./snapshot.js");
        if (!proof.snapshot || await openSkillSnapshot(proof.snapshot.id) !== proof.snapshot.path)
          throw Error("Supporting Review lost its pinned method.");
        const packet = supportingReviewAssignment(job, saved, entry, turn);
        const completion = await inspectCompletedPiReviewContext(job, {
          group: "narrative:" + packet.planVersion + ":independent:focused-support:" + entry.reportDigest,
          sessionFile: entry.reviewerSession!, snapshotId: proof.snapshot.id,
          requested: { provider: proof.provider, model: proof.model },
        });
        const verdict = await recoveredCloseoutReview(job, entry.reviewerSession!, completion.sessionSha256, packet);
        if (completion.sessionSha256 !== entry.reviewerSessionDigest ||
            JSON.stringify({ ...verdict, sessionFile: entry.reviewerSession }) !== JSON.stringify(entry.review))
          throw Error("Supporting Review differs from its completed independent transcript.");
      }
    }
  }
  return saved;
}
export function inspectDependencyPlan(job: JobStartResult) {
  return inspectDependencyLedger(job, false);
}
/** Read-only checkpoint assignment lookup: validate the source and controller
 * grant, not the verdict whose checkpoint is currently being inspected. No
 * writer can use this lookup instead of the full dependency ledger gate. */
export async function inspectDependencyCheckpointAssignment(job: JobStartResult, id: string) {
  const plan = await inspectDependencyLedger(job, true);
  const entry = plan?.entries.find(e => e.amendment?.assignment.id === id);
  if (!entry?.amendment || !entry.approval || entry.fixture ||
      !entry.supportRootSha || !["reviewing", "verified", "rejected"].includes(entry.phase))
    throw Error("Support checkpoint has no original admitted dependency assignment.");
  return entry.amendment.assignment;
}
/** The original focused support review packet, also used to authenticate a
 * settled negative verdict without starting a new reviewer. */
export function supportingReviewAssignment(job: JobStartResult, plan: DependencyPlan,
  entry: DependencyEntry, turn: TurnEvidence): ReviewAssignment {
  const amendment = entry.amendment!;
  const assignment = amendment.assignment;
  const report = entry.report;
  const writerBase = dependencyWriterBase(plan, entry);
  const head = entry.commitSha!;
  const authorizedPaths = [...assignment.authority.existingPaths, ...(assignment.authority.newPaths ?? [])].sort();
  const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
  const dependencyContract = { ...turn.contract, scope: { ...turn.contract.scope,
    targets: assignment.targets, supportingTargets: [], creates: [] } };
  return { contract: dependencyContract,
    planVersion: amendment.afterVersion, scopeIds: [...new Set([...report.affectedIds, ...assignment.targets])],
    paths: [...new Set([...authorizedPaths, ...report.sources.map(s => s.path)])],
    routes: [], milestoneRoutes: [], puzzleRoutes: [], outstanding: [], uncertainties: [],
    turnGoal: "ONLY review the necessary supporting prerequisite for this original author goal: " + turn.goal +
      (entry.blueprintSource
        ? ". Verify the Character's exact prospective role and the independently authorized Arc references. Do not require the suspended Event to have happened yet."
        : ". The originating author dialogue is suspended and will be written only AFTER this review passes; its current incompleteness is not a failure of the supporting assignment."),
    specialistAssignments: [assignment],
    dependency: { sourceSha: writerBase, commitSha: head,
      obligation: report.obligation, reason: amendment.reason,
      sources: report.sources.map(s => ({ path: s.path, quote: s.quote })),
      diff: dependencyGit(job, "diff", writerBase, head, "--",
        ...authorizedPaths.map(p => prefix + p)) } };
}
export interface DependencyHistoryPin { reportDigest: string; entryDigest: string }
/** Include the complete verified prerequisite subtree, not just its root. */
export function verifiedDependencyEntries(plan: DependencyPlan, roots: readonly string[]): DependencyEntry[] {
  const entries = plan.entries.filter(e => roots.some(root => dependencyAncestors(plan.entries, e).has(root)));
  if (roots.some(root => !entries.some(e => e.reportDigest === root)) ||
      entries.some(e => e.phase !== "verified" || !e.commitSha || e.review?.verdict !== "pass"))
    throw Error("Dependency subtree is not independently verified.");
  return entries;
}
export async function pinVerifiedDependencyHistory(job: JobStartResult, previous: DependencyHistoryPin[], root: string) {
  const plan = await inspectDependencyPlan(job);
  if (!plan) throw Error("Dependency history lost its original plan.");
  const entries = verifiedDependencyEntries(plan, [root]);
  const pins = entries.map(e => ({ reportDigest: e.reportDigest, entryDigest: dependencyDigest(e) }));
  return [...previous.filter(p => !pins.some(q => q.reportDigest === p.reportDigest)), ...pins];
}
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
      if (entry?.phase === "reviewing" && entry.supportRootSha &&
          await (await import("./rejected-review-repair.js")).authenticateFoundationReviewHead(job, entry.supportRootSha))
        return request;
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
    if (prior.phase === "reviewing" && prior.supportRootSha &&
        await (await import("./rejected-review-repair.js")).authenticateFoundationReviewHead(job, prior.supportRootSha))
      return { plan: saved, entry: prior };
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
    const point = (await inspectRecoveryCheckpoints(job, "historical")).find(p =>
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
      !(existingOwner ? reviewOtherOwners(original, request.originalAssignmentId, sourceRecord.path,
          request.otherOwnerCheckpoint).length === 1 :
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

export async function recordDependency(job: JobStartResult, value: unknown, fixture: boolean, blueprintSource?: BlueprintDependencySource,
  writerSource?: DependencyEntry["writerSource"]) {
  if (fixture) throw Error("Historical dependency fixture execution is retired.");
  const report = parseDependencyReport(value);
  const turn = await dependencyTurn(job);
  const head = await dependencyBoundary(job);
  const plan = await inspectDependencyPlan(job) ?? { schema: "noveltea-dependency-plan/v1" as const,
    jobId: job.jobId, threadId: job.threadId, turnDigest: turn.digest, version: 1, entries: [], digest: "" };
  const parent = plan.entries.find(e => e.amendment?.assignment.id === report.assignmentId);
  if (report.sourceSha !== head || report.turnDigest !== turn.digest ||
      (!parent && !turn.assignments.some(a => a.id === report.assignmentId)))
    throw Error("Dependency report has a stale Story or originating assignment.");
  const reportDigest = dependencyDigest(report);
  const prior = plan.entries.find(e => e.reportDigest === reportDigest);
  if (prior) {
    if (prior.fixture !== fixture || JSON.stringify(prior.blueprintSource) !== JSON.stringify(blueprintSource) ||
        JSON.stringify(prior.writerSource) !== JSON.stringify(writerSource)) throw Error("Dependency worker mode or source changed.");
    return { plan, entry: prior };
  }
  const ancestors = parent ? dependencyAncestors(plan.entries, parent) : new Set<string>();
  if (plan.entries.length >= 8 || plan.entries.some(e => e.phase !== "verified" && !ancestors.has(e.reportDigest)))
    throw Error("Unresolved dependency or amendment limit reached; author reconciliation required.");
  let parentSource: DependencyEntry["parent"];
  if (parent) {
    const grant = parent.amendment!;
    if (parent.phase !== "authorized" || blueprintSource || parent.report.sourceSha !== head ||
        plan.entries.some(e => e.parent?.reportDigest === parent.reportDigest))
      throw Error("Nested dependency has no fresh suspended parent boundary.");
    const arch = JSON.parse(await readFile(join(job.stateDir, "architecture.json"), "utf8"));
    const origin = await (await import("./focused-work.js")).inspectFocusedPrerequisite(job,
      grant.assignment.targets[0]!, turn.digest, false, arch.plan.version, grant.assignment.id);
    if (!origin || origin.phase !== "waiting-dependency" || origin.seal.reportDigest !== reportDigest)
      throw Error("Nested dependency requires the original settled no-write support report.");
    parentSource = { reportDigest: parent.reportDigest, suspensionDigest: dependencyDigest(origin.seal),
      planVersion: arch.plan.version };
  }
  const entry: DependencyEntry = { report, reportDigest, fixture, phase: "reported",
    ...(parentSource ? { parent: parentSource } : {}), ...(blueprintSource ? { blueprintSource } : {}), ...(writerSource ? { writerSource } : {}) };
  plan.entries.push(entry);
  await saveDependencyPlan(job, plan);
  return { plan, entry };
}
/** Read-only admission check. Historical refusals use the identical native
 * and deterministic owner/scope checks, without creating another grant. */
export async function inspectDependencyAdmission(job: JobStartResult, plan: DependencyPlan,
  entry: DependencyEntry, proposal: DependencyProposal, validatorSource?: string,
  inspectRefusal = false): Promise<DependencyAmendment> {
  if (entry.fixture) throw Error("Historical dependency evidence cannot authorize an amendment.");
  const head = await dependencyBoundary(job);
  const turn = await dependencyTurn(job);
  const persisted = await inspectDependencyPlan(job);
  if (!persisted || persisted.digest !== plan.digest || !plan.entries.includes(entry) ||
      !(inspectRefusal ? entry.phase === "rejected" : ["reported", "planning"].includes(entry.phase)) ||
      entry.amendment || entry.approval || entry.commitSha ||
      head !== entry.report.sourceSha || proposal.sourceSha !== head ||
      proposal.reportDigest !== entry.reportDigest)
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
  if (JSON.stringify(sources) !== JSON.stringify(entry.report.sources))
    throw Error("Dependency source hashes changed before admission.");
  const priorAmendments = plan.entries.filter(e => e !== entry && e.amendment)
    .map(e => e.amendment!.assignment);
  const request = entry.reviewSourceSha ? plan.reviewRequests?.find(r =>
    r.sourceSha === entry.reviewSourceSha) : undefined;
  const blueprintSource = blueprintSourceOf(entry);
  if (blueprintSource) {
    const source = blueprintSource;
    const original = await (await import("./event-work.js")).inspectArchivedEventBlueprintPrerequisite(
      job, source.milestoneId, source.readinessDigest);
    const expected = blueprintArcCandidates(original.assignment,
      original.report.blockers.filter(b => b.characterId === source.target).map(b => b.anchorPath), report.records);
    if (JSON.stringify(expected) !== JSON.stringify(source.arcCandidates))
      throw Error("Blueprint prerequisite candidates differ from native canonical source.");
  }
  return entry.writerSource
    ? authorizeWriterDependency({ plan: turn, head, report: entry.report, reportDigest: entry.reportDigest,
        proposal, records: report.records, sources, version: plan.version, source: entry.writerSource, priorAmendments })
    : blueprintSource
    ? authorizeBlueprintCharacterDependency({ plan: turn, head, report: entry.report,
        reportDigest: entry.reportDigest, proposal: proposal as ReviewCharacterProposal,
        records: report.records, sources, version: plan.version, source: blueprintSource,
        priorAmendments })
    : request?.classification === "other-owner"
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

}

export async function approveDependency(job: JobStartResult, plan: DependencyPlan,
  entry: DependencyEntry, proposal: DependencyProposal, validatorSource?: string) {
  const amendment = await inspectDependencyAdmission(job, plan, entry, proposal, validatorSource);
  entry.proposal = proposal; entry.amendment = amendment;
  entry.approval = { authority: "necessary-dependency/v1", jobId: job.jobId,
    threadId: job.threadId, sourceSha: amendment.sourceSha, amendmentDigest: dependencyDigest(amendment) };
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
  const supportRoot = entry.supportRootSha ?? entry.commitSha;
  if (proof.phase !== "committed" || proof.jobId !== job.jobId ||
      proof.commitSha !== supportRoot || proof.expectedHead !== failedSourceSha ||
      proof.workItemId !== assignment.id || proof.worker !== "pi" ||
      proof.assignmentDigest !== request.turnDigest ||
      proof.validation?.status !== "passed" ||
      proof.validation.validatorVersion !== job.validatorVersion ||
      proof.validation.baseSha !== failedSourceSha ||
      JSON.stringify(proof.paths) !== JSON.stringify(assignment.authority.newPaths) ||
      dependencyGit(job, "rev-parse", supportRoot + "^") !== failedSourceSha ||
      dependencyGit(job, "diff", "--name-only", failedSourceSha, entry.commitSha) !==
        prefix + newPath ||
      proof.sha256 !== dependencyDigest([[newPath,
        sourceDigest(dependencyGit(job, "show", supportRoot + ":" + prefix + newPath))]]))
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
  // Traverse only the existing independently rejected successor chain; the
  // shared recovery policy, not an arbitrary local attempt ceiling, governs progress.
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(repairedSource)) throw Error("Cyclic Event repair predecessor chain.");
    seen.add(repairedSource);
    const repair = await inspectRejectedRepair(job, repairedSource);
    if (repair.rootFailureSha !== failedSourceSha || repair.origin.workItem !==
        plan.reviewRequests?.find(r => r.sourceSha === failedSourceSha)?.originalWorkItem)
      throw Error("Event prerequisite repair belongs to another original assignment.");
    if (repair.phase === "passed") {
      repairedCommit = repair.repairedCommitSha;
      break;
    }
    if (repair.phase !== "failed" || !repair.repairedCommitSha) return false;
    repairedSource = repair.repairedCommitSha;
  }
  if (!repairedCommit) return false;
  const proof = await readRepairCommitProof(job, "repair-" + repairedSource);
  const point = (await inspectRecoveryCheckpoints(job, "historical")).find(p =>
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
  if (fixture) throw Error("Historical dependency evidence cannot authorize a writer.");
  const plan = await inspectDependencyPlan(job);
  const entry = plan?.entries.find(e => e.amendment?.assignment.id === assignmentId);
  if (!entry?.amendment || !entry.approval || entry.fixture ||
      !["authorized", "reviewing", "verified"].includes(entry.phase))
    throw Error("Dependency writer lacks a trusted assignment grant.");
  return entry;
}
