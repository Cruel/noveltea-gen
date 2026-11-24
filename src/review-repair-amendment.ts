/** A failed independent semantic review becomes a source-bound corrective
 * assignment overlay. It NEVER grants a new record, owner or protected write.
 * Cross-domain source records are evidence to read, not additional targets.
 * Other-owner corrections use a separate authorized dependency amendment. */
import { createHash } from "node:crypto";
import { authorizedArchitectureRecordPath } from "./architecture-record-path.js";
import type { CheckpointAssurance, IndependentReviewResult } from "./checkpoint-assurance.js";
import type { TurnAssignmentEvidence, TurnEvidence } from "./turn-plan-evidence.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const canonicalPath = /^[a-z][a-z0-9-]*\/[a-z0-9._-]+\.md$/;

export interface ReviewRepairObligation {
  path: string;
  kind: "missing-requirement" | "unrequested-change" | "continuity" | "other";
  defect: string;
  requiredCorrection: string;
  /** These may include read-only adjacent canonical records. */
  affectedPaths: string[];
}
/** The single originally selected, native-typed Milestone. This is only
 * supplied after the controller verifies the original signed Event evidence. */
export interface EventMilestoneRepairGrant {
  id: string;
  path: string;
}
/** Separate Character writer has committed and passed review. The Event
 * correction may append only this approved Character to this exact Event. */
export interface EventCharacterRepairGrant {
  id: string;
  path: string;
  supportingCommitSha: string;
  failedSourceSha: string;
}
export interface ReviewRepairPlanAmendment {
  version: 1;
  kind: "review-correction";
  sourceSha: string;
  reviewDigest: string;
  turnDigest: string;
  /** The original work-plan version; this overlay does not rewrite that plan. */
  basePlanVersion: number;
  amendmentVersion: 1;
  originalAssignmentId: string;
  originalAssignmentDigest: string;
  obligations: ReviewRepairObligation[];
  readOnlyDependencies: string[];
  eventMilestone?: EventMilestoneRepairGrant;
  eventCharacter?: EventCharacterRepairGrant;
  /** A new bounded corrective work item, owned by the original specialist. */
  assignment: TurnAssignmentEvidence;
  /** Exact immutable digest checked against the sealed review on every restart. */
  digest: string;
}

/** A failed review can identify necessary work which no existing-path repair
 * lease can perform. This source-bound request is NOT a write grant and must
 * not invent a Character ID, path, or second owner from reviewer prose. It
 * belongs to the same versioned Turn/dependency amendment process.
 *
 * In particular, a full-Story Character omission is routine delegated
 * creative work, not automatically a protected author decision. An amended
 * plan must still verify exact proposed targets and independent reviewer
 * evidence before dispatch; until then the failed checkpoint remains failed. */
export interface ReviewDependencyRequest {
  version: 1;
  kind: "review-dependency";
  classification: "new-full-story-record" | "other-owner" | "scope-or-protected";
  action: "controller-amendment-required" | "author-approval-required";
  sourceSha: string;
  reviewDigest: string;
  turnDigest: string;
  objectiveDigest: string;
  scopeDigest: string;
  ownersDigest: string;
  basePlanVersion: number;
  originalAssignmentId: string;
  originalAssignmentDigest: string;
  originalWorkItem: string;
  findings: Array<ReviewRepairObligation & { line: number }>;
  recordTypeHint: string | null;
  /** A sealed no-write report from the original repair session, never a path grant. */
  otherOwnerPath?: string;
  /** Digest of the unchanged, exact original objective and assignment ownership.
   * No newPaths, role, or target is authorized by this request. */
  digest: string;
}

/** Review findings can be attached to a repairable Character source even
 * when the only honest fix is an entirely new Character record. Do not grant
 * a creation-capable retry merely because the cited line is writable. */
export function reviewNeedsDependency(
  assurance: CheckpointAssurance, review: IndependentReviewResult, originWorkItem: string,
  eventMilestone?: EventMilestoneRepairGrant,
): boolean {
  const repairable = new Set(reviewRepairTargets(assurance.changedPaths, originWorkItem, eventMilestone));
  return review.findings.some(f =>
    !repairable.has(f.path) ||
    (originWorkItem === "global-architecture" &&
      /\b(?:protected decision|author decision|retcon|author approval)\b/i.test(f.message + " " + (f.requiredCorrection ?? ""))) ||
    (f.kind === "missing-requirement" &&
      /\b(?:create|add|introduce|new)\b/i.test(f.requiredCorrection ?? "") &&
      /\bcharacter\b/i.test(f.requiredCorrection ?? "") &&
      /\b(?:foundation|record|profile)\b/i.test(f.requiredCorrection ?? "") &&
      !/\b(?:existing|already authored|already present)\b.{0,90}\bcharacter\b/i.test(
        f.requiredCorrection ?? "")));
}

export function deriveReviewDependencyRequest(input: {
  assurance: CheckpointAssurance;
  review: IndependentReviewResult;
  original: TurnAssignmentEvidence;
  turn: TurnEvidence;
  planVersion: number;
  originWorkItem: string;
  eventMilestone?: EventMilestoneRepairGrant;
  /** Only an authenticated needs-plan repair receipt may supply this path. */
  otherOwnerPath?: string;
}): ReviewDependencyRequest {
  const { assurance, review, original, turn } = input;
  const source = { jobId: assurance.jobId, commitSha: assurance.commitSha,
    turnDigest: assurance.turnDigest, assignmentId: assurance.assignmentId,
    assignmentDigest: assurance.assignmentDigest, diffDigest: assurance.diffDigest,
    validationProofDigest: assurance.validationProofDigest };
  if (review.status !== "failed" || !review.findings.length ||
      JSON.stringify(review.source) !== JSON.stringify(source) ||
      turn.digest !== assurance.turnDigest ||
      (!input.otherOwnerPath && turn.source.verifiedSha !== assurance.baseSha) ||
      original.id !== assurance.assignmentId || hash(original) !== assurance.assignmentDigest ||
      JSON.stringify(turn.assignments.find(a => a.id === original.id)) !== JSON.stringify(original) ||
      !turn.objective || !turn.contract?.scope ||
      !Number.isSafeInteger(input.planVersion) || input.planVersion < 1 ||
      !assurance.changedPaths.length ||
      assurance.changedPaths.some(path => !canonicalPath.test(path)) ||
      !(input.otherOwnerPath || reviewNeedsDependency(assurance, review, input.originWorkItem, input.eventMilestone)))
    throw Error("Review dependency request lacks sealed source, assignment, objective or out-of-lease evidence.");

  const findings = review.findings.map(f => {
    const affectedPaths = f.affectedPaths ?? [f.path];
    if (!assurance.changedPaths.includes(f.path) || !canonicalPath.test(f.path) ||
        !Number.isSafeInteger(f.line) || (f.line ?? 0) < 1 ||
        !["missing-requirement", "unrequested-change", "continuity", "other"].includes(f.kind ?? "other") ||
        typeof f.message !== "string" || !f.message.trim() ||
        typeof f.requiredCorrection !== "string" || !f.requiredCorrection.trim() ||
        !Array.isArray(affectedPaths) || !affectedPaths.includes(f.path) ||
        !affectedPaths.length || affectedPaths.length > 12 ||
        new Set(affectedPaths).size !== affectedPaths.length ||
        affectedPaths.some(path => !canonicalPath.test(path)))
      throw Error("Review dependency request has forged path, line or correction evidence.");
    return { path: f.path, line: f.line!, kind: f.kind ?? "other",
      defect: f.message, requiredCorrection: f.requiredCorrection, affectedPaths: [...affectedPaths] };
  });
  const ownerPath = input.otherOwnerPath;
  const citedOtherOwner = ownerPath && findings.some(f => f.affectedPaths.includes(ownerPath));
  const owners = ownerPath ? turn.assignments.filter(a => a.id !== original.id &&
    (a.authority.existingPaths.includes(ownerPath) || a.authority.newPaths?.includes(ownerPath))) : [];
  if (ownerPath && (!canonicalPath.test(ownerPath) || !citedOtherOwner ||
      assurance.changedPaths.includes(ownerPath) || owners.length !== 1 ||
      owners[0]!.authority.recordTypes.length === 0))
    throw Error("Cross-specialist prerequisite has no unambiguous authenticated other-owner source.");
  const missingCharacter = findings.some(f => f.kind === "missing-requirement" &&
    /\bcharacter\b/i.test(f.defect + " " + f.requiredCorrection) &&
    /\b(?:missing|create|new|profile|record)\b/i.test(f.defect + " " + f.requiredCorrection));
  const foundationsCharacter = input.originWorkItem === "character-foundations" &&
    original.authority.mayCreate && original.authority.recordTypes.includes("character");
  const eventCharacter = original.id === "event" && original.specialist === "nt-event-design" &&
    original.authority.recordTypes.includes("event") &&
    /^event-[a-z][a-z0-9-]*$/.test(input.originWorkItem) &&
    findings.length === 1 && /^events\/[a-z][a-z0-9-]*\.md$/.test(findings[0]!.path) &&
    findings[0]!.affectedPaths.every(p => p === findings[0]!.path);
  const newFullStoryRecord = turn.kind === "full-story" &&
    turn.objective.breadth === "whole-story" && missingCharacter &&
    (foundationsCharacter || eventCharacter);
  // A reviewer cannot authorize changing a protected or author-owned record.
  // Even a genuine Event/Milestone correction needs its own exact field grant.
  const protectedSource = !!ownerPath && /^(?:arcs|milestones|narrative-positions|creative-direction)\//.test(ownerPath) ||
    findings.some(f =>
    (/^(?:milestones|narrative-positions|creative-direction)\//.test(f.path) &&
      f.path !== input.eventMilestone?.path) ||
    /\b(?:protected decision|author decision|retcon|author approval)\b/i.test(
      f.defect + " " + f.requiredCorrection));
  const otherOwner = findings.some(f =>
    turn.kind === "full-story" && /^arcs\//.test(f.path) &&
      original.id !== "architecture" ||
    f.affectedPaths.some(path => turn.assignments.some(a => a.id !== original.id &&
      (a.authority.existingPaths.includes(path) || a.authority.newPaths?.includes(path)))));
  const classification: ReviewDependencyRequest["classification"] =
    protectedSource || missingCharacter && !newFullStoryRecord
      ? "scope-or-protected" : ownerPath ? "other-owner" : newFullStoryRecord ? "new-full-story-record"
        : otherOwner ? "other-owner" : "scope-or-protected";
  const body = {
    version: 1 as const, kind: "review-dependency" as const, classification,
    action: (classification === "scope-or-protected" ? "author-approval-required" :
      "controller-amendment-required") as ReviewDependencyRequest["action"],
    sourceSha: assurance.commitSha, reviewDigest: hash(review), turnDigest: turn.digest,
    objectiveDigest: hash(turn.objective), scopeDigest: hash(turn.contract.scope),
    ownersDigest: hash(turn.assignments), basePlanVersion: input.planVersion,
    originalAssignmentId: original.id, originalAssignmentDigest: hash(original),
    originalWorkItem: input.originWorkItem, findings,
    recordTypeHint: missingCharacter ? "character" : null,
    ...(ownerPath ? { otherOwnerPath: ownerPath } : {}),
  };
  return { ...body, digest: hash(body) };
}

/** Protected supporting records remain read-only. The only field-limited
 * exception is the exact selected Milestone of a signed Event source, whose
 * non-fulfillment bytes are separately checked against the committed baseline.
 * Invalid paths and unauthorized Creative Direction changes fail closed. */
export function reviewRepairTargets(changedPaths: string[], originWorkItem: string,
  eventMilestone?: EventMilestoneRepairGrant): string[] {
  if (changedPaths.some(path => !canonicalPath.test(path) ||
      (path.startsWith("creative-direction/") && originWorkItem !== "foundation"))) return [];
  if (originWorkItem === "global-architecture")
    return changedPaths.filter(authorizedArchitectureRecordPath).sort();
  return changedPaths.filter(path =>
    !/^(?:arcs|milestones|narrative-positions)\//.test(path) ||
    path === eventMilestone?.path && originWorkItem.startsWith("event-")).sort();
}

export function deriveReviewRepairAmendment(input: {
  assurance: CheckpointAssurance;
  review: IndependentReviewResult;
  original: TurnAssignmentEvidence;
  planVersion: number;
  originWorkItem: string;
  eventMilestone?: EventMilestoneRepairGrant;
  eventCharacter?: EventCharacterRepairGrant;
}): ReviewRepairPlanAmendment {
  const { assurance, review, original, originWorkItem } = input;
  const source = { jobId: assurance.jobId, commitSha: assurance.commitSha,
    turnDigest: assurance.turnDigest, assignmentId: assurance.assignmentId,
    assignmentDigest: assurance.assignmentDigest, diffDigest: assurance.diffDigest,
    validationProofDigest: assurance.validationProofDigest };
  // The exact Event/Milestone grant must originate with the sealed Event
  // receipt, never with a reviewer finding, a guessed filename or the model.
  const eventMilestone = input.eventMilestone;
  if (eventMilestone && (original.id !== "event" ||
      original.specialist !== "nt-event-design" ||
      !original.authority.recordTypes.includes("event") ||
      originWorkItem !== "event-" + eventMilestone.id.replace(/^milestone\./, "") ||
      !/^milestone\.[a-z][a-z0-9-]*$/.test(eventMilestone.id) ||
      !/^milestones\/[a-z0-9][a-z0-9._-]*\.md$/.test(eventMilestone.path) ||
      (original.targets.length > 0 && !original.targets.includes(eventMilestone.id)) ||
      !assurance.changedPaths.includes(eventMilestone.path)))
    throw Error("Event Milestone repair lacks its original selected field grant.");
  const eventCharacter = input.eventCharacter;
  if (eventCharacter && (original.id !== "event" ||
      original.specialist !== "nt-event-design" ||
      !/^event-[a-z][a-z0-9-]*$/.test(originWorkItem) ||
      !/^events\/[a-z][a-z0-9-]*\.md$/.test(eventCharacter.path) ||
      !/^character\.[a-z][a-z0-9-]*$/.test(eventCharacter.id) ||
      !/^[a-f0-9]{40}$/.test(eventCharacter.supportingCommitSha) ||
      !/^[a-f0-9]{40}$/.test(eventCharacter.failedSourceSha) ||
      !assurance.changedPaths.includes(eventCharacter.path) ||
      review.findings.some(f => f.path !== eventCharacter.path)))
    throw Error("Event Character correction is not limited to its original owned Event.");
  const paths = eventCharacter ? [eventCharacter.path] :
    reviewRepairTargets(assurance.changedPaths, originWorkItem, eventMilestone);
  const owned = new Set([...original.authority.existingPaths, ...original.authority.newPaths ?? []]);
  if (review.status !== "failed" || !review.findings.length ||
      JSON.stringify(source) !== JSON.stringify(review.source) ||
      original.id !== assurance.assignmentId || hash(original) !== assurance.assignmentDigest ||
      !Number.isSafeInteger(input.planVersion) || input.planVersion < 1 ||
      !paths.length || paths.length > 32 ||
      paths.some(path => !canonicalPath.test(path) ||
        (!owned.has(path) && !original.authority.mayCreate && path !== eventMilestone?.path) ||
        (path.startsWith("creative-direction/") && originWorkItem !== "foundation") ||
        (/^(?:arcs|milestones|narrative-positions)\//.test(path) &&
          path !== eventMilestone?.path &&
          !(originWorkItem === "global-architecture" && original.id === "architecture" &&
            original.specialist === "nt-story-architecture" && authorizedArchitectureRecordPath(path)))) ||
      (originWorkItem === "foundation" && (paths.length !== 1 ||
        !paths[0]!.startsWith("creative-direction/"))) ||
      !original.specialist.trim())
    throw Error("Rejected review cannot grant a new writer, path, or protected change.");
  const obligations: ReviewRepairObligation[] = review.findings.map(f => {
    if (!paths.includes(f.path))
      throw Error("Review repair obligation has unverified source or correction: " +
        f.path + " is not writable in the original specialist's bounded repair " +
        "lease. Arc links, Milestone metadata and new record creation require " +
        "a separate controller-approved, field-limited or dependency-plan " +
        "amendment; do not replay the original writer with expanded authority.");
    const affectedPaths = f.affectedPaths ?? [f.path];
    const requiredCorrection = f.requiredCorrection ?? f.message;
    if (!Array.isArray(affectedPaths) ||
        !affectedPaths.length || affectedPaths.length > 12 ||
        !affectedPaths.includes(f.path) ||
        new Set(affectedPaths).size !== affectedPaths.length ||
        affectedPaths.some(path => !canonicalPath.test(path)) ||
        !requiredCorrection.trim() || !f.message.trim())
      throw Error("Review repair obligation has unverified source or correction.");
    return { path: f.path, kind: f.kind ?? "other", defect: f.message,
      requiredCorrection, affectedPaths: [...affectedPaths] };
  });
  const readOnlyDependencies = [...new Set(obligations.flatMap(o =>
    o.affectedPaths.filter(path => !paths.includes(path))))].sort();
  const assignment: TurnAssignmentEvidence = {
    id: "repair:" + assurance.commitSha,
    specialist: original.specialist,
    outcome: obligations.map(o => o.path + ": " + o.requiredCorrection).join("\n"),
    targets: [...original.targets], dependsOn: [original.id],
    discovery: "canonical-story-read-only",
    authority: { recordTypes: [...original.authority.recordTypes,
        ...(eventMilestone ? ["milestone"] : [])],
      existingPaths: paths, mayCreate: false },
  };
  const body = { version: 1 as const, kind: "review-correction" as const,
    sourceSha: assurance.commitSha, reviewDigest: hash(review),
    turnDigest: assurance.turnDigest, basePlanVersion: input.planVersion,
    amendmentVersion: 1 as const, originalAssignmentId: original.id,
    originalAssignmentDigest: hash(original), obligations,
    readOnlyDependencies, ...(eventMilestone ? { eventMilestone } : {}),
    ...(eventCharacter ? { eventCharacter } : {}), assignment };
  return { ...body, digest: hash(body) };
}
