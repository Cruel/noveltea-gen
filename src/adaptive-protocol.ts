/** An adaptive format correction is tied to one completed read-only Pi turn.
 * A valid report is still only a proposal: normal adaptive admission owns scope. */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AdaptiveProposal } from "./adaptive-assignments.js";
import type { JobStartResult } from "./job.js";
import { canonicalPinnedReadPath } from "./pinned-skill-reads.js";
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
/** Only response *shape* is a format error. The trusted controller still
 * owns all source, scope, dependency, and authorization decisions. */
export function adaptiveResponseFailures(text: string): Array<{ path: string; expected: string }> {
  let p: AdaptiveProposal;
  try { p = parse(text); } catch { return [{ path: "$", expected: "one complete adaptive proposal JSON object" }]; }
  if (!p || typeof p !== "object" || Array.isArray(p)) return [{ path: "$", expected: "a proposal object" }];
  const errors: Array<{ path: string; expected: string }> = [];
  if (Object.keys(p).some(key => !["sourceSha", "turnDigest", "beforeVersion", "reason", "actions", "order"].includes(key)))
    errors.push({ path: "$", expected: "no unknown proposal fields" });
  const shape: Record<string, readonly string[]> = {
    add: ["kind", "stage", "milestone", "dependsOn"],
    split: ["kind", "item", "domains"],
    depend: ["kind", "item", "needs"],
    narrow: ["kind", "item", "sourcePath", "sourceHash", "outcome"],
    omit: ["kind", "item"],
  };
  const check = (value: unknown, path: string, expected: string) => {
    const valid = expected === "array" ? Array.isArray(value) :
      expected === "integer" ? Number.isInteger(value) : typeof value === expected;
    if (!valid) errors.push({ path, expected });
    return valid;
  };
  for (const field of ["sourceSha", "turnDigest", "reason", "beforeVersion", "actions", "order"] as const) {
    check(p[field], "$." + field,
      field === "actions" || field === "order" ? "array" :
      field === "beforeVersion" ? "integer" : "string");
  }
  if (Array.isArray(p.order)) p.order.forEach((id, index) =>
    check(id, "$.order[" + index + "]", "string"));
  if (Array.isArray(p.actions)) p.actions.forEach((action, index) => {
    const path = "$.actions[" + index + "]";
    if (!action || typeof action !== "object" || Array.isArray(action)) {
      errors.push({ path, expected: "action object with a recognized kind" });
      return;
    }
    const record = action as unknown as Record<string, unknown>;
    const kind = record.kind;
    if (typeof kind !== "string" || !Object.hasOwn(shape, kind)) {
      errors.push({ path: path + ".kind", expected: "add|split|depend|narrow|omit" });
      return;
    }
    const keys = shape[kind]!;
    for (const key of keys) {
      if (key === "kind") continue;
      const expected = key === "dependsOn" || key === "domains" ? "array" : "string";
      if (check(record[key], path + "." + key, expected) && expected === "array")
        (record[key] as unknown[]).forEach((value, i) =>
          check(value, path + "." + key + "[" + i + "]", "string"));
    }
    if (kind === "add" && typeof record.stage === "string" &&
        !["event", "interactive", "composition"].includes(record.stage))
      errors.push({ path: path + ".stage", expected: "event|interactive|composition" });
    if (kind === "split" && Array.isArray(record.domains))
      record.domains.forEach((domain, i) => {
        if (typeof domain === "string" && !["choice", "puzzle"].includes(domain))
          errors.push({ path: path + ".domains[" + i + "]", expected: "choice|puzzle" });
      });
    if (Object.keys(record).some(key => !keys.includes(key)))
      errors.push({ path, expected: "no unknown fields" });
  });
  return errors.slice(0, 8);
}
const validate = adaptiveResponseFailures;
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

/** C07 read-only restart proof for a finished format-only correction. The
 * original negative Pi prefix and the terminal accepted same-session receipt
 * must both remain authentic; completion prose cannot settle this case. */
export async function verifyCompletedAdaptiveResponseCorrection(job: JobStartResult,
  original: AdaptiveRecovery): Promise<boolean> {
  await verifyAdaptiveRecoveryProof(job, original);
  const completed = await inspectCompletedProtocolReads({
    receiptFile: join(job.stateDir, "adaptive-protocol", original.signature),
    sourceDigest: original.signature, contract, sessionRoots: [dirname(original.proof.file)],
  });
  return completed.sessionFile === original.proof.file;
}

/** Read-only eligibility gate. A declared fix is not enough: the original
 * terminal receipt and transcript must survive, and the newly shipped
 * contract must actually accept the SAME exhausted response. */
export async function verifyAdaptivePickupProof(job: JobStartResult, decision: AdaptiveRecovery) {
  if (decision.phase !== "protocol-exhausted")
    throw Error("Only an exact exhausted original response can be rechecked");
  await verifyAdaptiveRecoveryProof(job, decision);
  return recheckExhaustedProtocolResponse({
    receiptFile: join(job.stateDir, "adaptive-protocol", decision.signature),
    sourceDigest: decision.signature, contract,
    sessionRoots: [dirname(decision.proof.file)],
    expectedSession: { id: decision.proof.id, file: decision.proof.file },
    validate, parse,
  });
}

export async function recheckAdaptiveResponse(job: JobStartResult, decision: AdaptiveRecovery,
  snapshotRoot: string) {
  const proposal = await verifyAdaptivePickupProof(job, decision);
  const receiptFile = join(job.stateDir, "adaptive-protocol", decision.signature);
  const options = { receiptFile, sourceDigest: decision.signature,
    contract, sessionRoots: [dirname(decision.proof.file)] };
  const provenance = await inspectCompletedProtocolReads({ ...options, allowExhausted: true });
  if (provenance.sessionFile !== decision.proof.file)
    throw Error("Rechecked adaptive session no longer matches the original");
  return { proposal, sessionFile: provenance.sessionFile,
    skillReads: [...new Set(provenance.reads.map(path =>
      canonicalPinnedReadPath(path, job.worktreeStoryRoot, snapshotRoot)))], };
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
