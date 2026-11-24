/** Shared bounded postcommit Review child transitions. Domain adapters supply
 * the actual authority, receipt execution and final successor verification. */
import type { AssignmentIdentity, AssignmentOutcome, AssignmentSubmission,
  AssignmentCorrection, AssignmentVerifiedSubmission } from "./generation-assignment-lifecycle.js";
import type { AssignmentInvocationProof } from "./assignment-metadata-recovery.js";
import type { ReviewRoundCommand, ReviewRoundResult } from "./rejected-review-repair.js";
import { ProtocolIntegrityBlockedError } from "./response-contract-recovery.js";

const sha = /^[a-f0-9]{40}$/;
const hash = /^[a-f0-9]{64}$/;
type VerifyResult = AssignmentOutcome | AssignmentCorrection | AssignmentVerifiedSubmission<AssignmentIdentity>;
type Options = {
  originalHead: string;
  originalReceipt: string;
  run(command: ReviewRoundCommand): Promise<ReviewRoundResult | AssignmentOutcome>;
  outcome(status: AssignmentOutcome["status"], evidenceRef: string, extra: Record<string, string>): AssignmentOutcome;
  verifySuccessor(head: string): Promise<boolean>;
};
function nativeProof(submission: AssignmentSubmission): AssignmentInvocationProof {
  const [kind, source, ordinal, settlement, extra] = submission.receiptRef.split(":");
  if (kind !== "native" || extra !== undefined || !hash.test(source ?? "") ||
      !/^(0|[1-9][0-9]*)$/.test(ordinal ?? "") || !Number.isSafeInteger(Number(ordinal)) ||
      !hash.test(settlement ?? ""))
    throw new ProtocolIntegrityBlockedError("Foreign native repair submission");
  return { sourceDigest: source!, ordinal: Number(ordinal), settlementDigest: settlement! };
}
function committed(result: Extract<ReviewRoundResult, { status: "committed" }>): AssignmentSubmission {
  return { status: "repair-round", receiptRef: ["repair", result.sourceSha, result.successorSha].join(":"),
    headSha: result.successorSha };
}

export function createReviewRoundTransitions({ originalHead, originalReceipt, run, outcome, verifySuccessor }: Options) {
  const stop = (result: ReviewRoundResult): AssignmentOutcome => {
    if (result.status === "assess")
      return outcome("unresolved", result.assessment.digest, { dispositionRef: "assess-review" });
    if (result.status === "paused")
      return outcome("paused", result.ref, { controlRef: result.reason + ":" + result.ref });
    if (result.status === "cancelled") return outcome("unresolved", result.ref, { dispositionRef: "cancelled" });
    if (result.status === "steering") return outcome("paused", result.ref, { controlRef: "author-updates" });
    if (result.status === "fenced") return outcome("fenced", result.ref, { inspectionRef: result.sourceSha });
    if (result.status === "native-terminal")
      return outcome("unresolved", result.ref, { dispositionRef: "repair-native:" + result.disposition });
    throw new ProtocolIntegrityBlockedError("Unexpected Review round transition");
  };
  const correction = (submission: AssignmentSubmission, ref: string): AssignmentCorrection =>
    ({ correctionRef: ref, rejectedReceiptRef: submission.receiptRef });
  const admit = async (submission: AssignmentSubmission, sourceSha: string) => {
    const admitted = await run({ phase: "admit", sourceSha });
    if ("assignmentKey" in admitted) return admitted;
    if (admitted.status !== "admitted") return stop(admitted);
    return correction(submission, admitted.sourceSha + ":" + admitted.grantDigest);
  };
  const review = async (submission: AssignmentSubmission): Promise<AssignmentOutcome | AssignmentCorrection> => {
    const [kind, sourceSha, successorSha, extra] = submission.receiptRef.split(":");
    if (kind !== "repair" || extra !== undefined || successorSha !== submission.headSha ||
        !sha.test(sourceSha ?? "") || !sha.test(successorSha ?? ""))
      throw new ProtocolIntegrityBlockedError("Foreign repair submission");
    const reviewed = await run({ phase: "verify", sourceSha: sourceSha!, successorSha: successorSha! });
    if ("assignmentKey" in reviewed) return reviewed;
    if (reviewed.status === "failed") return admit(submission, reviewed.successorSha);
    if (reviewed.status !== "passed") return stop(reviewed);
    if (!await verifySuccessor(reviewed.successorSha))
      throw new ProtocolIntegrityBlockedError("Review lacks an independently passing successor");
    return outcome("verified", "recovery-checkpoints:" + reviewed.successorSha,
      { headSha: reviewed.successorSha, reviewRef: "review-checkpoints:" + reviewed.successorSha });
  };
  return {
    async verify(submission: AssignmentSubmission): Promise<VerifyResult> {
      if (submission.status === "repair-round") return review(submission);
      if (submission.status === "repair-native-rejected") {
        const [kind, grant, extra] = submission.receiptRef.split(":");
        if (kind !== "native-rejected" || extra !== undefined || !hash.test(grant ?? "") ||
            !sha.test(submission.headSha ?? ""))
          throw new ProtocolIntegrityBlockedError("Foreign native rejection");
        return correction(submission, "native-invoke:" + grant);
      }
      if (submission.status === "repair-native-round") {
        if (!sha.test(submission.headSha ?? "")) throw new ProtocolIntegrityBlockedError("Missing native repair source");
        const proof = nativeProof(submission);
        const result = await run({ phase: "native-verify", sourceSha: submission.headSha!, proof });
        if ("assignmentKey" in result) return result;
        if (result.status === "native-correction")
          return correction(submission, "native-correct:" + result.grantDigest);
        if (result.status !== "committed") return stop(result);
        const next = committed(result);
        const verified = await review(next);
        return "correctionRef" in verified ? { submission: next, correction: verified } :
          { submission: next, outcome: verified };
      }
      if (submission.receiptRef !== originalReceipt || submission.headSha !== originalHead)
        throw new ProtocolIntegrityBlockedError("Review lost its initial negative submission");
      return admit(submission, originalHead);
    },
    async correct(submission: AssignmentSubmission, admitted: AssignmentCorrection): Promise<AssignmentSubmission | AssignmentOutcome> {
      const [kind, grantDigest, extra] = admitted.correctionRef.split(":");
      if (admitted.rejectedReceiptRef !== submission.receiptRef || extra !== undefined ||
          !hash.test(grantDigest ?? "") || !sha.test(submission.headSha ?? ""))
        throw new ProtocolIntegrityBlockedError("Review corrective grant belongs to another submission");
      let command: ReviewRoundCommand;
      if (kind === "native-invoke" && submission.status === "repair-native-rejected" &&
          submission.receiptRef === "native-rejected:" + grantDigest)
        command = { phase: kind, sourceSha: submission.headSha!, grantDigest: grantDigest! };
      else if (kind === "native-correct" && submission.status === "repair-native-round")
        command = { phase: kind, sourceSha: submission.headSha!, proof: nativeProof(submission), grantDigest: grantDigest! };
      else if (kind === submission.headSha && submission.status !== "repair-native-round" &&
          submission.status !== "repair-native-rejected")
        command = { phase: "correct", sourceSha: kind!, grantDigest: grantDigest! };
      else throw new ProtocolIntegrityBlockedError("Review correction does not match its pending phase");
      const result = await run(command);
      if ("assignmentKey" in result) return result;
      if (result.status === "committed") return committed(result);
      if (result.status === "native-rejected") return { status: "repair-native-rejected",
        receiptRef: "native-rejected:" + result.grantDigest, headSha: result.sourceSha };
      if (result.status === "native-settled") return { status: "repair-native-round", headSha: result.sourceSha,
        receiptRef: ["native", result.proof.sourceDigest, result.proof.ordinal, result.proof.settlementDigest].join(":") };
      return stop(result);
    },
  };
}
