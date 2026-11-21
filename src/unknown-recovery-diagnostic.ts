/** One advisory diagnosis for a trustworthy, otherwise unexplained generation
 * completion verdict. No model response from here is an execution grant. */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, lstat, readFile, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { JobStartResult } from "./job.js";
import { createJobModelRuntime } from "./model-runtime.js";
import { guardPiBudget, recordPiSession, resolvePiModel } from "./job-pi-policy.js";
import { openStoryProject } from "./project.js";
import { promptStorySpecialist } from "./story-interruption.js";
import { beginProtocolInvocation, inspectCompletedProtocolResponse,
  recoverResponseContract, type ResponseContractFailure } from "./response-contract-recovery.js";

const sha = (input: unknown) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
const hex40 = /^[a-f0-9]{40}$/;
const hex64 = /^[a-f0-9]{64}$/;
const contract = "generation.unknown-diagnosis.v1";
const safeCode = (value: string) => /^[a-z][a-z0-9.:-]{0,80}$/.test(value);
export interface UnknownCompletionEvidence {
  jobId: string; threadId: string; turnDigest: string | null;
  planVersion: number; sourceSha: string; checkpoint: string;
  reportStatus: string; scopeStatus: string; planStatus: string;
}
export interface UnknownRecoveryCase extends UnknownCompletionEvidence {
  schema: "noveltea-unknown-recovery-case/v1";
  operation: "completion-verification"; phase: "post-verification";
  check: "generation-fulfillment"; checkVersion: 1; signature: string;
}
export interface UnknownDiagnosis {
  schema: "noveltea-unknown-recovery-diagnosis/v1";
  signature: string;
  category: "software" | "unclassified" | "resources" | "integrity";
  action: "operator-intervention" | "inspect-existing-receipt";
  summary: string;
}
export interface UnknownRecoveryStatus {
  /** Null only for a fail-closed boundary with no authenticated case to diagnose. */
  case: UnknownRecoveryCase | null;
  phase: "assessment" | "operator-intervention" | "unsafe-evidence" | "resource-limit";
  recommendation?: UnknownDiagnosis["action"];
  advisoryCategory?: UnknownDiagnosis["category"];
}

export function unknownCompletionCase(evidence: UnknownCompletionEvidence): UnknownRecoveryCase {
  if (!evidence.jobId || !evidence.threadId || evidence.jobId.length > 160 ||
      evidence.threadId.length > 160 || evidence.turnDigest !== null &&
      !hex64.test(evidence.turnDigest) || !hex40.test(evidence.sourceSha) ||
      !Number.isSafeInteger(evidence.planVersion) || evidence.planVersion < 1 ||
      !safeCode(evidence.checkpoint) ||
      ![evidence.reportStatus, evidence.scopeStatus, evidence.planStatus].every(safeCode))
    throw Error("Unknown recovery lacks a trustworthy source, identity or failed-check state.");
  // Canonical field order makes identity independent of object construction
  // order and error-message wording, even after a graph process restart.
  const source = { schema: "noveltea-unknown-recovery-case/v1" as const,
    operation: "completion-verification" as const, phase: "post-verification" as const,
    check: "generation-fulfillment" as const, checkVersion: 1 as const,
    jobId: evidence.jobId, threadId: evidence.threadId, turnDigest: evidence.turnDigest,
    planVersion: evidence.planVersion, sourceSha: evidence.sourceSha,
    checkpoint: evidence.checkpoint, reportStatus: evidence.reportStatus,
    scopeStatus: evidence.scopeStatus, planStatus: evidence.planStatus };
  return { ...source, signature: sha(source) };
}

function exact(value: unknown, fields: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("|") === fields.sort().join("|");
}
export function parseUnknownDiagnosis(raw: string, caseFile: UnknownRecoveryCase): UnknownDiagnosis {
  if (Buffer.byteLength(raw) > 3000) throw Error("Oversized unknown-failure diagnosis.");
  let value: unknown;
  try { value = JSON.parse(raw.trim()); }
  catch { throw Error("Unknown-failure diagnosis must be strict JSON."); }
  if (!exact(value, ["schema", "signature", "category", "action", "summary"]) ||
      value.schema !== "noveltea-unknown-recovery-diagnosis/v1" ||
      value.signature !== caseFile.signature ||
      !["software", "unclassified", "resources", "integrity"].includes(String(value.category)) ||
      !["operator-intervention", "inspect-existing-receipt"].includes(String(value.action)) ||
      typeof value.summary !== "string" || value.summary.trim().length < 8 ||
      value.summary.length > 300 || /[\x00-\x1f\x7f]/.test(value.summary))
    throw Error("Unknown-failure diagnosis cannot authorize work or cite different evidence.");
  return value as unknown as UnknownDiagnosis;
}

/** Even 'inspect' is only advice to the human operator, never model-directed
 * dispatch, a waiver, or an Author Question. */
export function unknownDiagnosisDisposition(_diagnosis: UnknownDiagnosis): "operator-intervention" {
  return "operator-intervention";
}

const dirFor = (job: JobStartResult) => join(job.stateDir, "unknown-diagnostics");
const protocolRoot = (job: JobStartResult, key: string) => join(dirFor(job), key);
const sessionsRoot = (job: JobStartResult) => join(job.stateDir, "unknown-diagnostic-sessions");
const validation = (caseFile: UnknownRecoveryCase) => (response: string): ResponseContractFailure[] => {
  try { parseUnknownDiagnosis(response, caseFile); return []; }
  catch { return [{ path: "$.diagnosis", expected: "strict advisory-only JSON bound to the original signature" }]; }
};

function assertCaseBoundToJob(job: JobStartResult, evidence: UnknownRecoveryCase): UnknownRecoveryCase {
  const bound = unknownCompletionCase({
    jobId: job.jobId, threadId: job.threadId, turnDigest: evidence.turnDigest,
    planVersion: evidence.planVersion, sourceSha: evidence.sourceSha,
    checkpoint: evidence.checkpoint, reportStatus: evidence.reportStatus,
    scopeStatus: evidence.scopeStatus, planStatus: evidence.planStatus,
  });
  if (bound.signature !== evidence.signature || !isDeepStrictEqual(bound, evidence))
    throw Error("Unknown recovery lost its original verified failure identity.");
  return bound;
}

/** Read-only inspection never trusts a checkpointed model recommendation on
 * its own: the accepted Pi transcript and original case admission must still
 * agree. A tampered or missing receipt becomes unsafe evidence, not advice. */
export async function inspectUnknownRecoveryStatus(job: JobStartResult,
  status: UnknownRecoveryStatus | null): Promise<UnknownRecoveryStatus | null> {
  if (!status) return null;
  if (status.phase !== "operator-intervention" || !status.recommendation) return status;
  try {
    const evidence = status.case;
    if (!evidence) throw Error("Missing original case.");
    const bound = assertCaseBoundToJob(job, evidence);
    const root = protocolRoot(job, evidence.signature);
    const admission = root + ".admission.json";
    const stat = await lstat(admission);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4000 ||
        await readFile(admission, "utf8") !== JSON.stringify(bound) + "\n")
      throw Error("Missing or altered original admission.");
    const diagnosis = await inspectCompletedProtocolResponse({
      receiptFile: root, sourceDigest: evidence.signature, contract,
      sessionRoots: [sessionsRoot(job)], validate: validation(evidence),
      parse: text => parseUnknownDiagnosis(text, evidence),
    });
    if (diagnosis.action !== status.recommendation ||
        diagnosis.category !== status.advisoryCategory)
      throw Error("Checkpointed recommendation differs from authenticated transcript.");
    return status;
  } catch {
    return { case: status.case ?? null, phase: "unsafe-evidence" };
  }
}

/** A same-case graph restart may READ an accepted prior response but can
 * NEVER call Pi again. The shared protocol gate authenticates original session
 * transcript, attempt count and exact accepted bytes before returning it. */
export async function diagnoseUnknownCompletion(job: JobStartResult, evidence: UnknownRecoveryCase,
  provider: string, modelId: string): Promise<UnknownDiagnosis> {
  const bound = assertCaseBoundToJob(job, evidence);
  const root = dirFor(job), receipt = protocolRoot(job, evidence.signature);
  const admission = receipt + ".admission.json";
  const parse = (text: string) => parseUnknownDiagnosis(text, evidence);
  const validate = validation(evidence);
  const correction = (session: Parameters<typeof recoverResponseContract>[0]["session"],
    file: string, resumeOriginal = false) => recoverResponseContract({
      session, contract, validate, parse, sourceDigest: evidence.signature,
      receiptFile: receipt + ".initial.json",
      ...(resumeOriginal ? { resumeOriginal: { base: receipt,
        sessionRoots: [sessionsRoot(job)] } } : {}),
      beforeCorrection: () => guardPiBudget(job, "unknown-diagnosis:" + evidence.signature, file),
      prompt: prompt => promptStorySpecialist(session as Parameters<typeof promptStorySpecialist>[0], prompt),
      feedback: () => "FORMAT CORRECTION ONLY: return the strict five-field " +
        "unknown-failure diagnosis JSON with the original signature. No tools or new diagnosis.",
    });
  if (existsSync(admission)) {
    const stat = await lstat(admission);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4000 ||
        await readFile(admission, "utf8") !== JSON.stringify(bound) + "\n")
      throw Error("Unknown diagnostic admission is missing or untrustworthy.");
    // A completed answer is only READ from its authenticated transcript.
    // An invalid original response paused by a resource limit may consume
    // its existing format-only allowance in the SAME Pi conversation.
    const first = receipt + ".initial.json";
    if (existsSync(first)) {
      const stat = await lstat(first);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4000)
        throw Error("Unsafe original unknown-diagnosis protocol receipt.");
      const prior = JSON.parse(await readFile(first, "utf8")) as {
        status?: string; sessionFile?: string; sessionId?: string };
      if (prior.status === "invalid-response") {
        const sessionFile = prior.sessionFile;
        if (!sessionFile || !sessionFile.startsWith(sessionsRoot(job) + sep) ||
            !prior.sessionId)
          throw Error("Original unknown-diagnosis session cannot be trusted.");
        const runtime = await createJobModelRuntime();
        await guardPiBudget(job, "unknown-diagnosis:" + evidence.signature, sessionFile);
        const resolved = await resolvePiModel(job, runtime, provider, modelId);
        const project = await openStoryProject(job.worktreeStoryRoot);
        const { session } = await createAgentSession({
          cwd: project.root, modelRuntime: runtime, model: resolved.model,
          thinkingLevel: resolved.resolution.thinking,
          sessionManager: SessionManager.open(sessionFile, dirname(sessionFile), project.root),
          noTools: "all", tools: [],
        });
        try {
          if (session.sessionId !== prior.sessionId || session.getActiveToolNames().length)
            throw Error("Original diagnostic Pi context or tool policy changed.");
          return await correction(session, sessionFile, true);
        } finally { session.dispose(); }
      }
    }
    // Ambiguous in-flight, exhausted, stale or corrupted conversations
    // never get a new model diagnosis.
    return inspectCompletedProtocolResponse({
      receiptFile: receipt, sourceDigest: evidence.signature, contract,
      sessionRoots: [sessionsRoot(job)], validate, parse,
    });
  }

  // Reuse the existing job budget and pinned model before admitting a new
  // one-time prompt. A resource pause is not a semantic Story failure.
  const runtime = await createJobModelRuntime();
  await guardPiBudget(job, "unknown-diagnosis:" + evidence.signature);
  const resolved = await resolvePiModel(job, runtime, provider, modelId);
  const project = await openStoryProject(job.worktreeStoryRoot);
  const sessions = sessionsRoot(job);
  await mkdir(sessions, { recursive: true, mode: 0o700 });
  const { session } = await createAgentSession({
    cwd: project.root, modelRuntime: runtime, model: resolved.model,
    thinkingLevel: resolved.resolution.thinking,
    sessionManager: SessionManager.create(project.root, sessions),
    noTools: "all", tools: [],
  });
  try {
    if (session.getActiveToolNames().length)
      throw Error("Unknown diagnosis unexpectedly received tools.");
    const file = session.sessionManager.getSessionFile();
    if (!file) throw Error("Unknown diagnosis requires a durable Pi session.");
    await mkdir(root, { recursive: true, mode: 0o700 });
    // Claim the sole possible diagnosis for this material evidence state
    // BEFORE the SDK is allowed to issue a model request.
    await writeFile(admission, JSON.stringify(bound) + "\n", { flag: "wx", mode: 0o600 });
    await beginProtocolInvocation({ receiptFile: receipt,
      sourceDigest: evidence.signature, contract, session });
    await promptStorySpecialist(session,
      "INDEPENDENT READ-ONLY EXECUTION FAILURE DIAGNOSIS. No tools, Story edits, " +
      "approvals, verifier waivers, new scope, software patches, writer dispatch or " +
      "Author Questions. This operation has verified persisted source evidence but " +
      "the deterministic completion assessor has no authorized automatic route. " +
      "Report only the likely operator inspection target, not a repair grant. " +
      "Do not infer cause from rephrased exception prose or invent hidden logs. " +
      "Return ONLY JSON with exact keys schema,signature,category,action,summary. " +
      "schema=noveltea-unknown-recovery-diagnosis/v1; signature=" + evidence.signature +
      "; category=software|unclassified|resources|integrity; " +
      "action=operator-intervention|inspect-existing-receipt. " +
      "The latter advises the operator to inspect the EXISTING receipt; it never " +
      "automatically reruns work. Summary: one concise, nonprivate sentence. " +
      "VERIFIED OPERATION AND FAILED CHECK: " + JSON.stringify(evidence));
    // A valid first response needs no correction; meter its completed session
    // without applying a second admission check after the model has answered.
    await recordPiSession(job, file);
    return await correction(session, file);
  } finally { session.dispose(); }
}
