import { isDeepStrictEqual } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobStartResult } from "./job.js";
import { inspectRecoveryCheckpoints, finalizeRecoveryCheckpoint } from "./recovery-checkpoints.js";
import { inspectCheckpointReview, readRepairCommitProof } from "./checkpoint-assurance.js";
import { inspectPostcommitReviewCycle } from "./postcommit-review-cycle.js";
import { readSealedPostcommitVerdict } from "./postcommit-repair-diagnostic.js";
import { runPiAssignmentReview } from "./semantic-assignment-review.js";
import { inspectRejectedRepair } from "./rejected-review-repair.js";
import { openSkillSnapshot } from "./snapshot.js";
import type { DependencyEntry } from "./dependency-state.js";
import type { EditorialVerdict } from "./narrative-review-specialist.js";

/** Independently authenticate the original support and every rejected repair
 * predecessor, not the parent ledger's claim about the final verdict. */
export async function inspectSharedSupportReview(job: JobStartResult, entry: DependencyEntry,
  head: string): Promise<EditorialVerdict> {
  const root = entry.supportRootSha;
  const assignment = entry.amendment?.assignment;
  const points = (await inspectRecoveryCheckpoints(job)).filter(p => p.eligible);
  const original = points.find(p => p.commitSha === root && p.workItem === assignment?.id);
  if (!root || !assignment || !original?.assurance) throw Error("Support Review lost its original checkpoint.");
  const digest = original.assurance.assignmentDigest;
  const cycle = await inspectPostcommitReviewCycle(job, root, digest);
  if (!cycle || cycle.turnDigest !== entry.report.turnDigest || cycle.rounds.at(-1)?.commitSha !== head)
    throw Error("Support Review lost its original reviewer cycle.");
  let parent: string | undefined;
  let projection: EditorialVerdict | undefined;
  for (const round of cycle.rounds) {
    const point = points.find(p => p.commitSha === round.commitSha &&
      p.assurance?.assignmentDigest === digest && p.assurance.assignmentId === assignment.id);
    if (!point || (!parent && round.commitSha !== root))
      throw Error("Support Review has a foreign checkpoint.");
    if (parent) {
      if (point.workItem !== "repair-" + parent || point.parentSha !== parent)
        throw Error("Support correction lost its exact predecessor.");
      const proof = await readRepairCommitProof(job, point.workItem);
      const repair = await inspectRejectedRepair(job, parent);
      if (proof.rootFailureSha !== root || repair.rootFailureSha !== root ||
          repair.origin.workItem !== assignment.id || repair.repairedCommitSha !== point.commitSha ||
          repair.phase !== (point.semanticReview === "passed" ? "passed" : "failed"))
        throw Error("Support correction has no settled original-owner repair.");
    }
    const verdict = await readSealedPostcommitVerdict(cycle, round);
    const review = await inspectCheckpointReview(job, point);
    const findings = verdict.findings.filter(f => f.commitSha === point.commitSha && f.assignmentId === assignment.id);
    const evidence = verdict.evidence.filter(f => f.commitSha === point.commitSha && f.assignmentId === assignment.id);
    if (!review?.result || review.result.reviewer !== "independent-pi-assignment-review" ||
        review.status !== (verdict.verdict === "pass" ? "passed" : "failed") ||
        (round.commitSha !== head && review.status !== "failed") ||
        !isDeepStrictEqual(review.result.findings, findings.map(f => ({
          path: f.path, message: f.path + ":" + f.line + " " + f.message,
          kind: f.kind, line: f.line, affectedPaths: f.affectedPaths, requiredCorrection: f.requiredCorrection,
        }))) || !isDeepStrictEqual(JSON.parse(review.result.evidence), {
          policy: "assignment-fidelity/v1", sourceDigest: round.packetDigest, evidence,
        }))
      throw Error("Supporting Review differs from its completed independent transcript.");
    projection = { verdict: verdict.verdict === "pass" ? "pass" : "block",
      findings: findings.map(f => ({ severity: "blocking", dimension: "obligation",
        source: f.path + ":" + f.line, message: f.message, repair: "protected" })),
      evidence: evidence.map(f => f.path + ":" + f.line + ": " + f.explanation),
      sessionFile: cycle.reviewer.file };
    parent = point.commitSha;
  }
  if (!projection || parent !== head) throw Error("Support Review has no terminal verdict.");
  return projection;
}

export async function reviewSupportRoot(job: JobStartResult, entry: DependencyEntry, parent: string) {
  const id = entry.amendment!.assignment.id, root = entry.supportRootSha!;
  const proof = JSON.parse(await readFile(join(job.stateDir, "dependency-items", id + ".json"), "utf8"));
  if (!proof.snapshot || await openSkillSnapshot(proof.snapshot.id) !== proof.snapshot.path)
    throw Error("Support Review lost its pinned method.");
  const point = await finalizeRecoveryCheckpoint(job, id, parent, root);
  const prior = await inspectCheckpointReview(job, point);
  if (!prior?.result) {
    await runPiAssignmentReview(job, [point], {
      snapshot: proof.snapshot, provider: proof.provider, model: proof.model,
      onSession: async () => {}, reviewer: "independent-pi-assignment-review",
    });
  }
  // On repair reentry the root verdict remains immutable; don't request a
  // second reviewer after the cycle has advanced.
  const sealed = await inspectCheckpointReview(job, point);
  if (!sealed?.result) throw Error("Support Review did not seal the root verdict.");
  return sealed.status;
}
