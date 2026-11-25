/** Precommit evidence, not a new dependency scheduler. The original
 * writer receipt supplies the scope; existing DependencyPlan admission
 * and supporting assignment lifecycle supply every actual write grant. */
import type { JobStartResult } from "./job.js";
import { dependencyDigest, dependencyGit, dependencyTurn, sourceDigest } from "./dependency-state.js";
import { parseDependencyReport, parseWriterDependencyFinding, type DependencyReport,
  type WriterDependencyFinding } from "./dependency-amendments.js";
import { inspectRecoveryCheckpoints, inspectHistoricalRecoveryCheckpoint } from "./recovery-checkpoints.js";
import type { OtherOwnerCheckpoint } from "./review-repair-amendment.js";
import { checkpointRecordType } from "./checkpoint-assurance.js";
import { focusedSpecialist } from "./focused-specialist.js";

export interface WriterDependencySource {
  stage: "event" | "choice" | "puzzle" | "composition" | "character";
  milestoneId?: string;
  workItemId: string;
  planVersion: number;
  sealDigest: string;
  origin?: "blueprint";
  targetId: string;
  targetPath: string;
  producer: OtherOwnerCheckpoint;
  predecessor?: Omit<WriterContinuation, "sessionSha256">;
}

export interface OriginalWriterDependency {
  stage: WriterDependencySource["stage"];
  milestoneId?: string;
  workItemId: string;
  planVersion: number;
  sealDigest: string;
  assignmentKey: string;
  origin?: "blueprint";
  head: string;
  sourcePaths: string[];
  obligations: string[];
  finding: WriterDependencyFinding;
  predecessor?: Omit<WriterContinuation, "sessionSha256">;
}

/** Canonical record identity is read from the historical native-validated
 * source, never inferred from the file slug. Admission independently checks
 * the actual native catalog and typed links. */
function historicalId(bytes: string, id: string) {
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(bytes);
  if (!header) return false;
  return header[1]!.split(/\r?\n/).filter(line => /^id:\s*/.test(line)).length === 1 &&
    header[1]!.split(/\r?\n/).some(line => /^id:\s*/.test(line) &&
      [id, '"' + id + '"', "'" + id + "'"].includes(line.replace(/^id:\s*/, "").trim()));
}

export async function reconstructWriterDependency(job: JobStartResult, original: OriginalWriterDependency,
  points?: Awaited<ReturnType<typeof inspectRecoveryCheckpoints>>) {
  const turn = await dependencyTurn(job);
  const f = parseWriterDependencyFinding(original.finding);
  const origin = original.stage === "character" ? "foundations" : original.stage === "choice" || original.stage === "puzzle" ? "interactive" : original.stage;
  const owner = turn.assignments.find(a => a.id === origin);
  const obligation = turn.objective?.obligations[f.obligationIndex];
  if (!owner || !obligation || dependencyDigest(original.obligations) !== dependencyDigest(turn.objective!.obligations) ||
      (original.stage === "character" ? original.milestoneId !== undefined || original.workItemId !== "character-foundations" ||
        !["fact", "world-entity"].includes(f.targetId.split(".")[0]!) :
        !original.milestoneId || !f.affectedIds.includes(original.milestoneId)) ||
      f.sources.some(s => !original.sourcePaths.includes(s.path)) ||
      f.likelySpecialist !== focusedSpecialist(f.targetId))
    throw Error("Writer prerequisite lacks exact original Turn, assignment, scope or owner.");
  const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
  const targets: string[] = [];
  const sources = f.sources.map(s => {
    const bytes = dependencyGit(job, "show", original.head + ":" + prefix + s.path);
    if (!bytes.includes(s.quote)) throw Error("Writer prerequisite quote differs from original Git source.");
    if (historicalId(bytes, f.targetId)) targets.push(s.path);
    if (!f.affectedIds.some(id => historicalId(bytes, id))) throw Error("Writer prerequisite source is outside the cited typed records.");
    return { ...s, sha256: sourceDigest(bytes) };
  });
  if (targets.length !== 1) throw Error("Writer prerequisite must cite exactly one existing canonical target.");
  const targetPath = targets[0]!;
  const last = dependencyGit(job, "log", "-1", "--format=%H", original.head, "--", prefix + targetPath);
  const point = points ? points.find(p => p.commitSha === last && p.eligible) :
    await inspectHistoricalRecoveryCheckpoint(job, last);
  if (!point || !(point.assurance?.turnDigest === turn.digest &&
    point.assurance.changedPaths.includes(targetPath) &&
    ["passed", "not-required"].includes(point.semanticReview) &&
    (original.stage !== "character" || point.workItem === "world-foundations" && point.semanticReview === "passed") &&
    point.workItem !== original.workItemId && !point.workItem.startsWith("repair-") && !point.workItem.startsWith("dependency:")))
    throw Error("Writer prerequisite is not an independently verified earlier owner.");
  const priorOwner = point?.assurance && turn.assignments.find(a => a.id === point.assurance!.assignmentId);
  // A verified historical checkpoint already authenticates the effective
  // cross-domain grant (e.g. Choice legitimately updating an Event).
  // The producer is not necessarily the canonical correction owner.
  const recordType = checkpointRecordType(targetPath);
  if (!point?.assurance || !priorOwner || !recordType ||
      !point.assurance.changedRecordTypes.includes(recordType) ||
      !turn.assignments.some(a => a.authority.recordTypes.includes(recordType)))
    throw Error("Writer prerequisite has no independently verified earlier owner checkpoint.");
  const producer: OtherOwnerCheckpoint = { assignmentId: priorOwner.id, workItem: point.workItem,
    commitSha: last, assuranceDigest: dependencyDigest(point.assurance) };
  const source: WriterDependencySource = { stage: original.stage, ...(original.milestoneId ? { milestoneId: original.milestoneId } : {}),
    workItemId: original.workItemId, planVersion: original.planVersion, sealDigest: original.sealDigest,
    ...(original.origin ? { origin: original.origin } : {}),
    targetId: f.targetId, targetPath, producer,
    ...(original.predecessor ? { predecessor: original.predecessor } : {}) };
  const report: DependencyReport = parseDependencyReport({ sourceSha: original.head, turnDigest: turn.digest,
    assignmentId: origin, obligation, missing: f.missing, affectedIds: f.affectedIds,
    sources, likelySpecialist: f.likelySpecialist, authorDecisionRequired: f.authorDecisionRequired });
  return { source, report, original, reportDigest: dependencyDigest(report) };
}

export async function inspectWriterDependency(job: JobStartResult, source: WriterDependencySource,
  points?: Awaited<ReturnType<typeof inspectRecoveryCheckpoints>>) {
  const original = source.stage === "character"
    ? await (await import("./character-world.js")).inspectCharacterWriterDependency(job, source.sealDigest)
    : source.stage === "event"
    ? await (await import("./event-work.js")).inspectEventWriterDependency(job, source.milestoneId!, source.sealDigest)
    : source.stage === "composition"
      ? await (await import("./composition-work.js")).inspectCompositionWriterDependency(job, source.milestoneId!, source.sealDigest)
      : await (await import("./interactive-work.js")).inspectInteractiveWriterDependency(job, source.milestoneId!, source.stage, source.sealDigest);
  const rebuilt = await reconstructWriterDependency(job, original, points);
  if (dependencyDigest(rebuilt.source) !== dependencyDigest(source))
    throw Error("Writer prerequisite differs from its authenticated original owner/source.");
  return rebuilt;
}

/** Source of the latest suspension, rather than a replacement logical identity. */
export function writerPredecessor(pin?: Omit<WriterContinuation, "sessionSha256">) {
  return pin ? { reportDigest: pin.reportDigest, supportRef: pin.supportRef, originalHead: pin.originalHead } : undefined;
}

/** Verify the original logical source through the already admitted dependency
 * chain, with each subsequent negative source at its verified predecessor. */
export async function assertWriterAssignmentRoot(job: JobStartResult,
    original: Awaited<ReturnType<typeof inspectWriterDependency>>, rootHead: string) {
  let current = original;
  const plan = await (await import("./dependency-state.js")).inspectDependencyPlan(job);
  const seen = new Set<string>();
  while (current.source.predecessor) {
    const predecessor = current.source.predecessor;
    if (seen.has(predecessor.reportDigest)) throw Error("Writer prerequisite has cyclic continuation evidence.");
    seen.add(predecessor.reportDigest);
    const previous = plan?.entries.find(e => e.reportDigest === predecessor.reportDigest);
    if (!previous?.writerSource || previous.reportDigest === current.reportDigest ||
        previous.report.sourceSha !== predecessor.originalHead ||
        previous.phase !== "verified" || dependencyDigest(previous) !== predecessor.supportRef ||
        previous.writerSource.stage !== current.source.stage ||
        previous.writerSource.workItemId !== current.source.workItemId ||
        previous.writerSource.milestoneId !== current.source.milestoneId ||
        previous.writerSource.planVersion !== current.source.planVersion)
      throw Error("Writer prerequisite lost its verified predecessor.");
    await verifiedWriterSupport(job, previous.writerSource, previous.reportDigest, predecessor.supportRef, current.original.head);
    const earlier = await inspectWriterDependency(job, previous.writerSource);
    if (earlier.original.assignmentKey !== original.original.assignmentKey)
      throw Error("Sequential prerequisite would replace the original assignment.");
    current = earlier;
  }
  if (current.original.head !== rootHead) throw Error("Writer prerequisite is not rooted at the original logical source.");
}

export interface WriterContinuation {
  reportDigest: string; supportRef: string; originalHead: string; sessionSha256: string;
}
export async function verifiedWriterSupport(job: JobStartResult, source: WriterDependencySource,
    reportDigest: string, supportRef: string, expectedContinuationHead?: string) {
  const { inspectDependencyPlan } = await import("./dependency-state.js");
  const entry = (await inspectDependencyPlan(job))?.entries.find(e => e.reportDigest === reportDigest);
  if (!entry?.writerSource || dependencyDigest(entry.writerSource) !== dependencyDigest(source) ||
      entry.phase !== "verified" || !entry.commitSha || entry.review?.verdict !== "pass" ||
      dependencyDigest(entry) !== supportRef)
    throw Error("Writer continuation lacks independently verified original supporting work.");
  const { assertCompletedOtherOwnerRevalidation } = await import("./selective-revalidation-work.js");
  await assertCompletedOtherOwnerRevalidation(job, { baseSha: entry.report.sourceSha,
    successorSha: entry.commitSha, turnDigest: entry.report.turnDigest, path: source.targetPath, expectedContinuationHead,
    correctionReviewDigest: dependencyDigest(entry.review) });
  return entry;
}
export async function authenticateWriterContinuation(job: JobStartResult, pin: WriterContinuation,
    stage: WriterDependencySource["stage"], milestone: string | undefined, assignmentKey?: string) {
  const { inspectDependencyPlan } = await import("./dependency-state.js");
  const entry = (await inspectDependencyPlan(job))?.entries.find(e => e.reportDigest === pin.reportDigest);
  if (!entry?.writerSource || entry.writerSource.stage !== stage || entry.writerSource.milestoneId !== milestone ||
      entry.phase !== "verified" || dependencyDigest(entry) !== pin.supportRef ||
      entry.report.sourceSha !== pin.originalHead)
    throw Error("Writer continuation lost its admitted supporting work.");
  const original = await inspectWriterDependency(job, entry.writerSource);
  if (original.original.assignmentKey !== assignmentKey) throw Error("Writer continuation has a foreign logical assignment.");
  return entry.writerSource;
}
