/** An adaptive format correction is tied to one completed read-only Pi turn.
 * A valid report is still only a proposal: normal adaptive admission owns scope. */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AdaptiveProposal } from "./adaptive-assignments.js";
import type { JobStartResult } from "./job.js";
import { beginProtocolInvocation, recoverResponseContract, recheckExhaustedProtocolResponse,
  inspectCompletedProtocolReads, type ResponseContractSession } from "./response-contract-recovery.js";

const contract = "adaptive-plan.v1";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export interface AdaptiveResponseProof {
  file: string; id: string; bytes: number; sha256: string;
}
export interface AdaptiveRecovery {
  operation: "adaptive-planner"; failedPhase: "completed-response"; check: typeof contract; checkVersion: 1;
  action: "correct-original-response";
  phase: "assessment" | "authorized" | "completed" | "protocol-exhausted";
  jobId: string; threadId: string; turnDigest: string; planVersion: number; sourceSha: string; signature: string;
  proof: AdaptiveResponseProof;
}
export class MalformedAdaptiveResponse extends Error {
  constructor(readonly proof: AdaptiveResponseProof) { super("Malformed completed adaptive planner response"); }
}
export class AdaptiveRecoveryRequired extends Error {
  constructor(readonly decision: AdaptiveRecovery) { super("Assess the completed adaptive planner response"); }
}
const parse = (text: string): AdaptiveProposal => JSON.parse(text.trim()
  .replace(/^```(?:json)?\s*\n/i, "").replace(/\n```\s*$/, ""));
const validate = (text: string) => {
  let p: AdaptiveProposal;
  try { p = parse(text); } catch { return [{ path: "$", expected: "one complete adaptive proposal JSON object" }]; }
  if (!p || typeof p !== "object" || Array.isArray(p)) return [{ path: "$", expected: "a proposal object" }];
  return ["sourceSha", "turnDigest", "reason", "beforeVersion", "actions", "order"].flatMap(k => {
    const value = p[k as keyof AdaptiveProposal];
    const expected = ["actions", "order"].includes(k) ? "array" : k === "beforeVersion" ? "integer" : "string";
    return (expected === "array" ? Array.isArray(value) : expected === "integer" ? Number.isInteger(value) : typeof value === "string")
      ? [] : [{ path: "$." + k, expected }];
  });
};
async function transcript(job: JobStartResult, file: string) {
  if (dirname(file) !== join(job.stateDir, "adaptive-planning-sessions") || !file.endsWith(".jsonl") ||
      await realpath(file) !== file) throw Error("Unsafe adaptive recovery transcript");
  const stat = await lstat(file);
  if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw Error("Unsafe adaptive recovery transcript");
  return readFile(file);
}
export async function initialAdaptiveResponse(job: JobStartResult, text: string, file: string, id: string) {
  if (!validate(text).length) return parse(text);
  const bytes = await transcript(job, file);
  throw new MalformedAdaptiveResponse({ file, id, bytes: bytes.length, sha256: hash(bytes) });
}
export async function verifyAdaptiveRecoveryProof(job: JobStartResult, decision: AdaptiveRecovery) {
  const { proof, signature } = decision;
  if (!/^[a-f0-9]{64}$/.test(signature) || !/^[a-f0-9]{64}$/.test(decision.turnDigest) ||
      !/^[a-f0-9]{40}$/.test(decision.sourceSha) ||
      decision.operation !== "adaptive-planner" || decision.failedPhase !== "completed-response" ||
      decision.check !== contract || decision.checkVersion !== 1 ||
      decision.jobId !== job.jobId || decision.threadId !== job.threadId ||
      !proof.id || !/^[a-f0-9]{64}$/.test(proof.sha256))
    throw Error("Adaptive recovery has no matched source and check identity");
  const bytes = await transcript(job, proof.file);
  if (!Number.isSafeInteger(proof.bytes) || proof.bytes <= 0 || bytes.length < proof.bytes ||
      hash(bytes.subarray(0, proof.bytes)) !== proof.sha256)
    throw Error("Original adaptive response changed");
}

export async function recheckAdaptiveResponse(job: JobStartResult, decision: AdaptiveRecovery) {
  if (decision.phase !== "protocol-exhausted")
    throw Error("Only an exact exhausted original response can be rechecked");
  await verifyAdaptiveRecoveryProof(job, decision);
  const receiptFile = join(job.stateDir, "adaptive-protocol", decision.signature);
  const options = { receiptFile, sourceDigest: decision.signature,
    contract, sessionRoots: [dirname(decision.proof.file)] };
  const proposal = await recheckExhaustedProtocolResponse({
    ...options, expectedSession: { id: decision.proof.id, file: decision.proof.file },
    validate, parse,
  });
  const provenance = await inspectCompletedProtocolReads({ ...options, allowExhausted: true });
  if (provenance.sessionFile !== decision.proof.file)
    throw Error("Rechecked adaptive session no longer matches the original");
  return { proposal, sessionFile: provenance.sessionFile, skillReads: provenance.reads };
}

export async function correctAdaptiveResponse(job: JobStartResult, decision: AdaptiveRecovery,
  session: ResponseContractSession, beforeCorrection: () => Promise<void>, prompt: (feedback: string) => Promise<void>) {
  const { proof, signature } = decision;
  if (decision.phase !== "authorized" ||
      session.sessionManager.getSessionFile() !== proof.file || session.sessionId !== proof.id)
    throw Error("Adaptive format correction lost its source or original session");
  await verifyAdaptiveRecoveryProof(job, decision);
  const receiptFile = join(job.stateDir, "adaptive-protocol", signature);
  const options = { receiptFile, sourceDigest: signature, contract, validate, parse };
  if (!existsSync(receiptFile + ".initial.json") &&
      (await transcript(job, proof.file)).length !== proof.bytes) throw Error("Unattributed adaptive planner activity; do not repeat the correction");
  // The original malformed response is already sealed. This marker pins the
  // unchanged prefix before any format-only prompt; the shared helper seals
  // each individual attempt before dispatch and removes *all* active tools.
  if (!existsSync(receiptFile + ".started.json")) await beginProtocolInvocation({ ...options, session });
  return recoverResponseContract({ ...options, session, receiptFile: receiptFile + ".initial.json",
    resumeOriginal: { base: receiptFile, sessionRoots: [dirname(proof.file)] },
    beforeCorrection, prompt, feedback: failures => "Correct only your last adaptive work proposal in this same session. " +
      "Return only the complete JSON object (sourceSha, turnDigest, beforeVersion, reason, actions, order). " +
      "Preserve the original source, objective and authority. No tools or new planning. Contract failures: " +
      failures.map(f => f.path + ": " + f.expected).join("; ") });
}
