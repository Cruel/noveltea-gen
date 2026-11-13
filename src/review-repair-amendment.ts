/** A failed independent semantic review becomes a source-bound corrective
 * assignment overlay. It NEVER grants a new record, owner or protected write.
 * Cross-domain source records are evidence to read, not additional targets.
 * Other-owner corrections use a separate authorized dependency amendment. */
import { createHash } from "node:crypto";
import type { CheckpointAssurance, IndependentReviewResult } from "./checkpoint-assurance.js";
import type { TurnAssignmentEvidence } from "./turn-plan-evidence.js";

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
  /** A new bounded corrective work item, owned by the original specialist. */
  assignment: TurnAssignmentEvidence;
  /** Exact immutable digest checked against the sealed review on every restart. */
  digest: string;
}

export function deriveReviewRepairAmendment(input: {
  assurance: CheckpointAssurance;
  review: IndependentReviewResult;
  original: TurnAssignmentEvidence;
  planVersion: number;
  originWorkItem: string;
}): ReviewRepairPlanAmendment {
  const { assurance, review, original, originWorkItem } = input;
  const source = { jobId: assurance.jobId, commitSha: assurance.commitSha,
    turnDigest: assurance.turnDigest, assignmentId: assurance.assignmentId,
    assignmentDigest: assurance.assignmentDigest, diffDigest: assurance.diffDigest,
    validationProofDigest: assurance.validationProofDigest };
  // An Event work item may have advanced the selected Milestone's fulfillment
  // metadata in its *already validated* commit. That is read-only context for
  // any correction, never new repair authority. A finding ON that Milestone
  // still escalates rather than creating a protected-path repair grant.
  const paths = assurance.changedPaths.filter(path =>
    !(originWorkItem.startsWith("event-") && path.startsWith("milestones/"))).sort();
  const owned = new Set([...original.authority.existingPaths, ...original.authority.newPaths ?? []]);
  if (review.status !== "failed" || !review.findings.length ||
      JSON.stringify(source) !== JSON.stringify(review.source) ||
      original.id !== assurance.assignmentId || hash(original) !== assurance.assignmentDigest ||
      !Number.isSafeInteger(input.planVersion) || input.planVersion < 1 ||
      !paths.length || paths.length > 32 ||
      paths.some(path => !canonicalPath.test(path) ||
        (!owned.has(path) && !original.authority.mayCreate) ||
        (path.startsWith("creative-direction/") && originWorkItem !== "foundation") ||
        /^(?:arcs|milestones|narrative-positions)\//.test(path)) ||
      (originWorkItem === "foundation" && (paths.length !== 1 ||
        !paths[0]!.startsWith("creative-direction/"))) ||
      !original.specialist.trim())
    throw Error("Rejected review cannot grant a new writer, path, or protected change.");
  const obligations: ReviewRepairObligation[] = review.findings.map(f => {
    const affectedPaths = f.affectedPaths ?? [f.path];
    const requiredCorrection = f.requiredCorrection ?? f.message;
    if (!paths.includes(f.path) || !Array.isArray(affectedPaths) ||
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
    authority: { recordTypes: [...original.authority.recordTypes],
      existingPaths: paths, mayCreate: false },
  };
  const body = { version: 1 as const, kind: "review-correction" as const,
    sourceSha: assurance.commitSha, reviewDigest: hash(review),
    turnDigest: assurance.turnDigest, basePlanVersion: input.planVersion,
    amendmentVersion: 1 as const, originalAssignmentId: original.id,
    originalAssignmentDigest: hash(original), obligations,
    readOnlyDependencies, assignment };
  return { ...body, digest: hash(body) };
}
