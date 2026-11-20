/** The identity of one bounded writer/reviewer collaboration, not an approval.
 * Controllers bind it to trusted source and assignment provenance. Later review
 * adapters may share this identity without sharing their semantic findings. */
import { createHash } from "node:crypto";

export interface ReviewCycleScope {
  jobId: string;
  threadId: string;
  baseSha: string;
  executionHead: string;
  planVersion: number;
  contractDigest: string;
  snapshotId: string;
  provider: string;
  model: string;
  taskDigest: string;
}

export function reviewCycleId(scope: ReviewCycleScope): string {
  const { jobId, threadId, baseSha, executionHead, planVersion, contractDigest,
    snapshotId, provider, model, taskDigest } = scope;
  return createHash("sha256").update(JSON.stringify({
    schema: "noveltea-review-cycle/v1", jobId, threadId, baseSha, executionHead,
    planVersion, contractDigest, snapshotId, provider, model, taskDigest,
  })).digest("hex");
}

export function assertReviewCycleSession(
  writer: { id: string; file: string },
  reviewer: { id: string; file: string },
  original?: { id: string; file: string },
): void {
  if (!writer.id || !writer.file || !reviewer.id || !reviewer.file ||
      writer.id === reviewer.id || writer.file === reviewer.file ||
      (original && (reviewer.id !== original.id || reviewer.file !== original.file)))
    throw Error("Independent review cycle has a wrong or changed reviewer Pi session.");
}
