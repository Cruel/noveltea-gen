import assert from "node:assert/strict";
import test from "node:test";
import {
  isRepeatedUnchangedOperation,
  type GenerationOperationRecovery,
} from "../src/generation-operation-recovery.js";
import { ProtocolIntegrityBlockedError, ProtocolVerifierRecheckRejectedError } from
  "../src/response-contract-recovery.js";

const head = "a".repeat(40);
const turn = "b".repeat(64);
const source = {
  jobId: "original-job", threadId: "original-thread:generation",
  turnDigest: turn, planVersion: 2, headSha: head,
};
const evidence = { reference: "review-checkpoints" as const, assignmentId: "event:milestone.arrival" };
const previous: GenerationOperationRecovery = {
  version: 1, operation: "commit-verification", check: "committed-work-verification.v1",
  checkVersion: 1, phase: "continued", outcome: "exception",
  safeAction: "reconcile-original-operation", source, evidence,
  reason: "A native validation check failed.", nextAction: "Inspect the original result.",
};
const candidate = { operation: previous.operation, outcome: previous.outcome, source, evidence };

test("C08 repeated failed check is source-bound, not gated by human-readable error wording", () => {
  assert.equal(isRepeatedUnchangedOperation(previous, candidate), true,
    "same check/source/evidence must not regain a retry when error text changes");
  assert.equal(isRepeatedUnchangedOperation({ ...previous,
    reason: "Different wording after restart and parser upgrade.",
    nextAction: "A different suggested response." }, candidate), true);
  assert.equal(isRepeatedUnchangedOperation({ ...previous, phase: "assessment" }, candidate), false,
    "unfinished assessments keep their existing lifecycle rather than a synthetic repeat fence");
});

test("C08 rejected fixed verifier is a typed result, not an error message classifier", () => {
  const rejected = new ProtocolVerifierRecheckRejectedError("Any diagnostic wording");
  assert.equal(rejected.code, "verifier-rejected");
  assert.equal(rejected instanceof ProtocolIntegrityBlockedError, false,
    "a failed fixed verifier is a protocol outcome, not altered original receipts");
  assert.equal(rejected instanceof ProtocolVerifierRecheckRejectedError, true);
  assert.equal(new ProtocolIntegrityBlockedError("Any diagnostic wording") instanceof
    ProtocolVerifierRecheckRejectedError, false);
});

test("C08 genuinely changed original operation/source/evidence is not an unchanged failure", () => {
  for (const changed of [
    { ...candidate, source: { ...source, headSha: "c".repeat(40) } },
    { ...candidate, source: { ...source, threadId: "different-thread" } },
    { ...candidate, source: { ...source, turnDigest: "d".repeat(64) } },
    { ...candidate, source: { ...source, planVersion: 3 } },
    { ...candidate, outcome: "returned-failure" as const },
    { ...candidate, evidence: { ...evidence, assignmentId: "event:milestone.second" } },
  ])
    assert.equal(isRepeatedUnchangedOperation(previous, changed), false);
  assert.equal(isRepeatedUnchangedOperation({ ...previous, checkVersion: 2 as 1 }, candidate), false);
  assert.equal(isRepeatedUnchangedOperation({ ...previous, check: "not-the-canonical-check" }, candidate), false);
  assert.equal(isRepeatedUnchangedOperation({ ...previous, source: { ...source, headSha: null } }, candidate), false);
  assert.equal(isRepeatedUnchangedOperation(null, candidate), false);
});
