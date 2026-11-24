import type { AssignmentInvocationProof, AssignmentRoundResult } from "./assignment-metadata-recovery.js";
import type { AssignmentSubmission, AssignmentCorrection } from "./generation-assignment-lifecycle.js";
import { ProtocolIntegrityBlockedError } from "./response-contract-recovery.js";

/** Convert a bounded domain round into the common checkpoint submission.
 * The adapter's persisted invocation chain authenticates each proof/grant. */
export function subunitRoundProof(submission: AssignmentSubmission): AssignmentInvocationProof {
  const [sourceDigest, ordinal, settlementDigest, extra] = submission.receiptRef.split(":");
  if (submission.status !== "writer-round" || extra !== undefined ||
      !/^[a-f0-9]{64}$/.test(sourceDigest ?? "") || !/^(0|[1-9][0-9]*)$/.test(ordinal ?? "") ||
      !/^[a-f0-9]{64}$/.test(settlementDigest ?? "") || !Number.isSafeInteger(Number(ordinal)))
    throw new ProtocolIntegrityBlockedError("Invalid checkpointed subunit writer round reference.");
  return { sourceDigest: sourceDigest!, ordinal: Number(ordinal), settlementDigest: settlementDigest! };
}

export function subunitWriterResult(result: { status: string; headSha?: string; round?: AssignmentRoundResult },
  ref: string): AssignmentSubmission | AssignmentCorrection {
  if (!result.round) return { receiptRef: ref, status: result.status, headSha: result.headSha };
  const { proof } = result.round;
  const receiptRef = [proof.sourceDigest, proof.ordinal, proof.settlementDigest].join(":");
  return result.round.status === "correction"
    ? { correctionRef: result.round.grantDigest, rejectedReceiptRef: receiptRef }
    : { receiptRef, status: "writer-round" };
}
