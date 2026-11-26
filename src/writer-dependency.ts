/** Precommit evidence, not a new dependency scheduler. The original
 * writer receipt supplies the scope; existing DependencyPlan admission
 * and supporting assignment lifecycle supply every actual write grant. */
import type { JobStartResult } from "./job.js";
import { dependencyDigest, dependencyGit, dependencyTurn, sourceDigest } from "./dependency-state.js";
import { parseDependencyReport, parseWriterDependencyFinding, type DependencyReport,
  type WriterDependencyFinding } from "./dependency-amendments.js";
import { inspectRecoveryCheckpoints, inspectHistoricalRecoveryCheckpoint } from "./recovery-checkpoints.js";
import type { OtherOwnerCheckpoint } from "./review-repair-amendment.js";
import { checkpointRecordType, readRepairCommitProof } from "./checkpoint-assurance.js";
import { writerDependencySpecialist } from "./focused-specialist.js";
import { historicalCanonicalCatalog } from "./validator.js";
import { inheritedReviewedCheckpoint, readRecoveryFork } from "./recovery-fork-state.js";
import type { CanonicalScopeRecord } from "./focused-scope.js";
import { isDeepStrictEqual } from "node:util";

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

/** Authenticate the last actual path-changing checkpoint, then resolve its
 * original producer through the immutable failed-Review chain. A support
 * correction of an existing record traces to the producer at its admitted
 * source; it cannot claim the suspended consumer's identity. */
export async function verifiedPathProducer(job: JobStartResult, turnDigest: string, sourceSha: string,
    path: string, points?: Awaited<ReturnType<typeof inspectRecoveryCheckpoints>>) {
  const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw Error("Invalid historical producer source.");
  dependencyGit(job, "merge-base", "--is-ancestor", sourceSha, "HEAD");
  const pointAt = async (sha: string) => {
    const fork = readRecoveryFork(job);
    const inheritedItem = Object.entries(fork?.commits ?? {}).find(([, entry]) => entry.sha === sha);
    if (inheritedItem) {
      const inherited = inheritedReviewedCheckpoint(job, inheritedItem[0], sha);
      if (!inherited?.proof.assurance || (await dependencyTurn(job)).digest !== turnDigest ||
          dependencyGit(job, "merge-base", sha, job.baseSha) !== sha)
        throw Error("Writer prerequisite lacks an independently verified inherited producer.");
      // Preserve the ORIGINAL assurance/digest. The replacement Turn grants
      // current authority independently; historical review is not rebound.
      return { ...inherited.proof, assurance: inherited.proof.assurance,
        semanticReview: inherited.status, commitSha: sha };
    }
    const point = points ? points.find(p => p.commitSha === sha && p.eligible) :
      await inspectHistoricalRecoveryCheckpoint(job, sha);
    if (!point?.assurance || point.assurance.turnDigest !== turnDigest)
      throw Error("Writer prerequisite lacks an authenticated historical checkpoint.");
    return { ...point, assurance: point.assurance, commitSha: sha };
  };
  const seen = new Set<string>();
  const trace = async (at: string): Promise<OtherOwnerCheckpoint> => {
    const last = dependencyGit(job, "log", "-1", "--format=%H", at, "--", prefix + path);
    if (seen.has(last)) throw Error("Writer prerequisite has cyclic producer lineage.");
    seen.add(last);
    const changed = await pointAt(last);
    if (!changed.assurance.changedPaths.includes(path))
      throw Error("Writer prerequisite lacks its exact path-changing checkpoint.");
    const { inspectRejectedRepair } = await import("./rejected-review-repair.js");
    // Review rejects the assignment, not just the files named by findings.
    // An untouched sibling becomes usable only after the original assignment's
    // independently passed successor is reachable at this sealed source.
    let terminal = changed;
    const forward = new Set<string>([last]);
    while (terminal.semanticReview === "failed") {
      const repair = await inspectRejectedRepair(job, terminal.commitSha, "historical").catch(cause => {
        throw Error("Writer prerequisite is not an independently verified earlier owner.", { cause });
      });
      if (!repair.repairedCommitSha || !["passed", "failed"].includes(repair.phase) ||
          forward.has(repair.repairedCommitSha))
        throw Error("Writer prerequisite is not an independently verified earlier owner.");
      const next = await pointAt(repair.repairedCommitSha);
      dependencyGit(job, "merge-base", "--is-ancestor", terminal.commitSha, next.commitSha);
      try { dependencyGit(job, "merge-base", "--is-ancestor", next.commitSha, at); }
      catch (cause) { throw Error("Writer prerequisite is not an independently verified earlier owner at this source.", { cause }); }
      if (next.workItem !== "repair-" + terminal.commitSha ||
          next.assurance.assignmentId !== changed.assurance.assignmentId ||
          next.semanticReview !== repair.phase ||
          dependencyGit(job, "log", "-1", "--format=%H", next.commitSha, "--", prefix + path) !== last ||
          dependencyGit(job, "ls-tree", next.commitSha, "--", prefix + path) !==
            dependencyGit(job, "ls-tree", last, "--", prefix + path))
        throw Error("Writer prerequisite repair does not retain the exact cited record.");
      forward.add(next.commitSha);
      terminal = next;
    }
    if (!["passed", "not-required"].includes(terminal.semanticReview))
      throw Error("Writer prerequisite is not an independently verified earlier owner.");
    let root = terminal;
    const repairRoot = root.workItem.startsWith("repair-") ?
      (await readRepairCommitProof(job, root.workItem)).rootFailureSha : undefined;
    if (repairRoot && terminal.semanticReview !== "passed")
      throw Error("Writer prerequisite repair lacks independent acceptance.");
    const lineage = new Set<string>([terminal.commitSha]);
    while (root.workItem.startsWith("repair-")) {
      const proof = await readRepairCommitProof(job, root.workItem);
      const prior = await pointAt(proof.sourceCommitSha);
      if (lineage.has(prior.commitSha) || (seen.has(prior.commitSha) && prior.commitSha !== last) || proof.commitSha !== root.commitSha ||
          proof.rootFailureSha !== repairRoot || prior.semanticReview !== "failed" ||
          prior.assurance.assignmentId !== root.assurance.assignmentId)
        throw Error("Writer prerequisite repair lost its original failed owner.");
      const repair = await inspectRejectedRepair(job, prior.commitSha, "historical");
      if (repair.rootFailureSha !== repairRoot || repair.repairedCommitSha !== root.commitSha ||
          repair.phase !== (root.semanticReview === "passed" ? "passed" : "failed"))
        throw Error("Writer prerequisite repair has no settled original-owner successor.");
      lineage.add(prior.commitSha);
      seen.add(prior.commitSha);
      root = prior;
    }
    if ((repairRoot && root.commitSha !== repairRoot) || !root.assurance.changedPaths.includes(path))
      throw Error("Writer prerequisite repair root differs from its original owner.");
    if (root.workItem.startsWith("dependency:")) {
      const entry = await (await import("./dependency-state.js")).inspectVerifiedHistoricalSupport(job,
        root.workItem, root.commitSha, terminal.commitSha, path);
      return trace(entry.report.sourceSha);
    }
    if (root.workItem === "world-foundations" && terminal.semanticReview !== "passed" ||
        !root.assurance.changedRecordTypes.includes(checkpointRecordType(path)!))
      throw Error("Writer prerequisite producer record type differs from its verified grant.");
    return { assignmentId: root.assurance.assignmentId, workItem: root.workItem,
      commitSha: root.commitSha, assuranceDigest: dependencyDigest(root.assurance),
      ...(repairRoot ? { verifiedCommitSha: terminal.commitSha } : {}) };
  };
  return trace(sourceSha);
}

/** Bind all submitted quotations to exact canonical records. Several
 * independent quotes from the SAME record are evidence, not several owners.
 * Shared by proposal validation and actual dependency admission. */
export function resolveWriterDependencySources(job: JobStartResult, head: string,
  finding: WriterDependencyFinding, catalog: readonly CanonicalScopeRecord[]) {
  const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
  const targets = new Set<string>();
  const citedIds = new Set<string>();
  const sources = finding.sources.map(s => {
    const records = catalog.filter(record => record.path === s.path);
    if (records.length !== 1 || !finding.affectedIds.includes(records[0]!.metadata.id) ||
        records[0]!.metadata.status === "superseded")
      throw Error("Writer prerequisite source " + s.path + " is outside the cited typed records.");
    const bytes = dependencyGit(job, "show", head + ":" + prefix + s.path);
    if (!bytes.includes(s.quote)) throw Error("Writer prerequisite quote differs from original Git source: " + s.path);
    citedIds.add(records[0]!.metadata.id);
    if (records[0]!.metadata.id === finding.targetId) targets.add(s.path);
    return { ...s, sha256: sourceDigest(bytes) };
  });
  const uncited = finding.affectedIds.filter(id => !citedIds.has(id));
  if (uncited.length) throw Error("Missing exact source quotation for affectedIds: " + uncited.join(", "));
  if (targets.size !== 1) throw Error("Writer prerequisite must cite exactly one existing canonical target.");
  return { targetPath: [...targets][0]!, sources };
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
      f.likelySpecialist !== writerDependencySpecialist(f.targetId))
    throw Error("Writer prerequisite lacks exact original Turn, assignment, scope or owner.");
  const catalog = await historicalCanonicalCatalog(job, original.head);
  const {targetPath, sources} = resolveWriterDependencySources(job, original.head, f, catalog);
  const producer = await verifiedPathProducer(job, turn.digest, original.head, targetPath, points);
  const priorOwner = turn.assignments.find(a => a.id === producer.assignmentId);
  const recordType = checkpointRecordType(targetPath);
  if (!priorOwner || !recordType ||
      producer.workItem === original.workItemId ||
      (original.stage === "character" && producer.workItem !== "world-foundations") ||
      !turn.assignments.some(a => a.authority.recordTypes.includes(recordType)))
    throw Error("Writer prerequisite has no independently verified earlier owner checkpoint.");
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

/** All domain adapters retain the same exact original logical writer and
 * transcript identity on idempotent re-entry. Domain-specific receipt
 * transitions remain with their existing owners. */
export function assertWriterReentry(current: {
    writerContinuation?: Omit<WriterContinuation, "sessionSha256"> & { sessionSha256?: string }; assignmentKey?: string; sessionId?: string; sessionFile?: string;
  }, archived: { assignmentKey?: string; sessionId?: string; sessionFile?: string },
  binding: Omit<WriterContinuation, "sessionSha256"> & { sessionSha256?: string }) {
  if (!isDeepStrictEqual(current.writerContinuation, binding) ||
      current.assignmentKey !== archived.assignmentKey ||
      current.sessionId !== archived.sessionId || current.sessionFile !== archived.sessionFile)
    throw Error("Writer continuation changed its original writer or support binding.");
}

export function writerContinuationBinding<T extends string | undefined>(reportDigest: string,
    supportRef: string, originalHead: string, sessionSha256: T) {
  if (!/^[a-f0-9]{64}$/.test(reportDigest) || !/^[a-f0-9]{64}$/.test(supportRef) ||
      !/^[a-f0-9]{40}$/.test(originalHead) ||
      sessionSha256 !== undefined && !/^[a-f0-9]{64}$/.test(sessionSha256))
    throw Error("Invalid original writer continuation binding.");
  return { reportDigest, supportRef, originalHead,
    ...(sessionSha256 === undefined ? {} : { sessionSha256 }) } as
    { reportDigest: string; supportRef: string; originalHead: string } &
    (T extends string ? { sessionSha256: string } : { sessionSha256?: string });
}
