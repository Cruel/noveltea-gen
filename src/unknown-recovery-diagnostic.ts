/** One source-bound read-only Pi invocation for unfamiliar generation failures.
 * The controller, never this model, grants strategy and work authority.
 * Legacy completion-only v1 receipts remain inspectable but are not emitted. */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, lstat, readFile, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { JobStartResult } from "./job.js";
import { createJobModelRuntime } from "./model-runtime.js";
import { guardPiBudget, recordPiSession, registerPendingPiSession, resolvePiModel } from "./job-pi-policy.js";
import { openStoryProject } from "./project.js";
import { reportControllerReviewPhase } from "./controller-review-phase.js";
import { promptStorySpecialist } from "./story-interruption.js";
import { parseRecoveryDiagnosticProposal, parseDiagnosticModelResponse, validateDiagnosticModelResponse, type RecoveryDiagnosticProposal } from "./recovery-diagnostic-proposal.js";
import { beginProtocolInvocation, inspectCompletedProtocolResponse, authenticateSealedProtocolFailure, ProtocolExhaustedError,
  recoverResponseContract, type ResponseContractFailure } from "./response-contract-recovery.js";

const sha = (input: unknown) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
const hex40 = /^[a-f0-9]{40}$/;
const hex64 = /^[a-f0-9]{64}$/;
const legacyContract = "generation.unknown-diagnosis.v1";
const historicalGeneralContract = "generation.recovery-diagnostic.v2";
const generalContract = "generation.recovery-diagnostic.v3";
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
// Operation diagnostics use the authenticated original failure, not a fabricated
// completion report. The signature names one immutable source-bound invocation.
export interface OperationDiagnosisCase {
  schema: "noveltea-operation-diagnosis-case/v1";
  signature: string; jobId: string; threadId: string; caseId: string;
  sourceSha: string; turnDigest: string; operation: string; check: string;
  assignmentId: string | null; proofRef: string;
}
type DiagnosticCase = UnknownRecoveryCase | OperationDiagnosisCase;
export type RecoveryDiagnosis = UnknownDiagnosis | RecoveryDiagnosticProposal;
/** Only authenticated, bounded controller values, never author-only inbox data. */
export interface DiagnosticPacket {
  jobId: string; jobThreadId: string; graphThreadId: string; turnDigest: string;
  originalObjective: string;
  approvedScope: unknown;
  verifiedHistory: unknown;
  assignment: unknown;
  planVersion: number | null;
  failedOperation: string;
  failedCheck: string;
  originalSource: string;
  sourceProof: string;
  inventory: unknown;
  existingFindings: unknown;
  previousAttempts: unknown;
  availableAdapters: readonly string[];
}
export function operationDiagnosisCase(c: import("./generation-recovery-contract.js").RecoveryCase,
  proofRef: string): OperationDiagnosisCase {
  const body = { schema: "noveltea-operation-diagnosis-case/v1" as const,
    jobId: c.origin.jobId, threadId: c.origin.jobThreadId, caseId: c.id,
    sourceSha: c.origin.sourceHeadSha, turnDigest: c.origin.turnDigest,
    operation: c.origin.operation, check: c.origin.check, assignmentId: c.origin.assignmentId, proofRef };
  return { ...body, signature: sha(body) };
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
export function parseUnknownDiagnosis(raw: string, caseFile: DiagnosticCase): UnknownDiagnosis {
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
const contractFor = (evidence: DiagnosticCase) => evidence.schema === "noveltea-operation-diagnosis-case/v1"
  ? generalContract : legacyContract;
const decode = (response: string, evidence: DiagnosticCase, chosen: string): RecoveryDiagnosis =>
  evidence.schema === "noveltea-operation-diagnosis-case/v1" && chosen === generalContract
    ? parseDiagnosticModelResponse(response, evidence)
    : evidence.schema === "noveltea-operation-diagnosis-case/v1" && chosen === historicalGeneralContract
      ? parseRecoveryDiagnosticProposal(response, evidence)
      : parseUnknownDiagnosis(response, evidence);
const validation = (caseFile: DiagnosticCase, chosen: string) => (response: string): ResponseContractFailure[] => {
  if (chosen === generalContract && caseFile.schema === "noveltea-operation-diagnosis-case/v1")
    return validateDiagnosticModelResponse(response, caseFile);
  try { decode(response, caseFile, chosen); return []; }
  catch { return [{ path: "$.diagnosis", expected: "strict source-bound diagnostic proposal JSON" }]; }
};
/** Historical operation v1 sessions have their own immutable contract. An
 * existing started marker must never be treated as allowance for a v2 call. */
async function recordedContract(job: JobStartResult, evidence: DiagnosticCase): Promise<string> {
  const started = protocolRoot(job, evidence.signature) + ".started.json";
  if (!existsSync(started)) return contractFor(evidence);
  const stat = await lstat(started);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4000)
    throw Error("Unsafe original diagnostic invocation marker");
  const marker = JSON.parse(await readFile(started, "utf8")) as { contract?: string };
  if (marker.contract !== contractFor(evidence) && marker.contract !== legacyContract &&
      !(evidence.schema === "noveltea-operation-diagnosis-case/v1" && marker.contract === historicalGeneralContract))
    throw Error("Unknown or altered original diagnostic protocol contract");
  return marker.contract;
}

function assertCaseBoundToJob(job: JobStartResult, evidence: DiagnosticCase): DiagnosticCase {
  if (evidence.schema === "noveltea-operation-diagnosis-case/v1") {
    const { signature, ...body } = evidence;
    if (job.jobId !== body.jobId || job.threadId !== body.threadId || !hex64.test(body.caseId) ||
        !hex64.test(body.turnDigest) || !hex40.test(body.sourceSha) || signature !== sha(body))
      throw Error("Diagnostic original operation identity or source changed.");
    return evidence;
  }
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

/** Read the sealed ORIGINAL diagnostic admission and completed Pi protocol.
 * This is read-only: no model/session reentry or new invocation allowance. */
export async function inspectOriginalUnknownDiagnosis(
  job: JobStartResult, evidence: DiagnosticCase,
): Promise<RecoveryDiagnosis> {
  const bound = assertCaseBoundToJob(job, evidence);
  const chosen = await recordedContract(job, evidence);
  const root = protocolRoot(job, evidence.signature);
  const admission = root + ".admission.json";
  const stat = await lstat(admission);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4000 ||
      await readFile(admission, "utf8") !== JSON.stringify(bound) + "\n")
    throw Error("Missing or altered original diagnostic admission.");
  return inspectCompletedProtocolResponse({
    receiptFile: root, sourceDigest: evidence.signature, contract: chosen,
    sessionRoots: [sessionsRoot(job)], validate: validation(evidence, chosen),
    parse: text => decode(text, evidence, chosen),
    requireSealedTranscript: chosen === generalContract,
  });
}

/** Terminal response exhaustion is not evidence corruption. Re-read the exact
 * source-bound admission and the sealed exhausted transcript before publishing
 * a terminal protocol decision. No model request or new allowance occurs here. */
export async function inspectDiagnosticExhaustion(job: JobStartResult, evidence: DiagnosticCase) {
  if (await recordedContract(job, evidence) !== generalContract) return null;
  const receipt = protocolRoot(job, evidence.signature) + ".initial.json";
  if (!existsSync(receipt)) return null;
  const stat = await lstat(receipt);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4000)
    throw Error("Unsafe original diagnostic protocol receipt.");
  const marker = JSON.parse(await readFile(receipt, "utf8")) as { status?: string };
  if (marker.status !== "protocol-exhausted") return null;
  try { await inspectOriginalUnknownDiagnosis(job, evidence); }
  catch (error) {
    if (!(error instanceof ProtocolExhaustedError) || !error.proof) throw error;
    await authenticateSealedProtocolFailure(error.proof, [sessionsRoot(job)]);
    return { proof: { store: "response-contract" as const,
      ref: evidence.signature, digest: error.proof.transcriptDigest }, error };
  }
  throw Error("Exhausted diagnostic unexpectedly returned an accepted proposal.");
}

/** Index the authenticated original invocation, not the checkpoint's selection
 * or a model-supplied identity. A started marker alone is not a settled turn. */
export async function inspectDiagnosticAttempt(job: JobStartResult, evidence: DiagnosticCase,
  caseId: string): Promise<import("./generation-recovery-contract.js").RecoveryAttempt> {
  await inspectOriginalUnknownDiagnosis(job, evidence);
  const file = protocolRoot(job, evidence.signature) + ".started.json";
  const marker = JSON.parse(await readFile(file, "utf8")) as { invocationId: string; sessionId: string };
  return { caseId, id: marker.invocationId, invocationId: marker.invocationId,
    mode: "read-only", purpose: "diagnosis", phase: "settled",
    startedRef: { store: "pi-session", ref: marker.sessionId },
    settledRef: { store: "response-contract", ref: evidence.signature } };
}

/** Read-only inspection never trusts a checkpointed model recommendation on
 * its own: the accepted Pi transcript and original case admission must still
 * agree. A tampered or missing receipt becomes unsafe evidence, not advice. */
export async function inspectUnknownRecoveryStatus(job: JobStartResult,
  status: UnknownRecoveryStatus | null): Promise<UnknownRecoveryStatus | null> {
  if (!status) return null;
  if (status.phase !== "operator-intervention" || !status.recommendation) return status;
  try {
    if (!status.case) throw Error("Missing original case.");
    const diagnosis = await inspectOriginalUnknownDiagnosis(job, status.case);
    if (!("action" in diagnosis) || diagnosis.action !== status.recommendation ||
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
export async function diagnoseUnknownCompletion(job: JobStartResult, evidence: DiagnosticCase,
  provider: string, modelId: string, packet?: DiagnosticPacket): Promise<RecoveryDiagnosis> {
  const bound = assertCaseBoundToJob(job, evidence);
  const chosen = await recordedContract(job, evidence);
  const root = dirFor(job), receipt = protocolRoot(job, evidence.signature);
  const admission = receipt + ".admission.json";
  const parse = (text: string) => decode(text, evidence, chosen);
  const validate = validation(evidence, chosen);
  const promptMetered = async (session: Parameters<typeof promptStorySpecialist>[0], file: string, text: string) => {
    await registerPendingPiSession(job, file);
    await promptStorySpecialist(session, text);
    const last = session.messages.at(-1);
    if (last?.role !== "assistant" || last.stopReason !== "stop")
      throw Error("Diagnostic invocation lacks a completed response.");
    await recordPiSession(job, file);
  };
  const correction = (session: Parameters<typeof recoverResponseContract>[0]["session"],
    file: string, resumeOriginal = false) => recoverResponseContract({
      session, contract: chosen, validate, parse, sourceDigest: evidence.signature,
      receiptFile: receipt + ".initial.json", sealTranscript: chosen === generalContract,
      ...(resumeOriginal ? { resumeOriginal: { base: receipt,
        sessionRoots: [sessionsRoot(job)] } } : {}),
      beforeCorrection: async () => {
        await guardPiBudget(job, "unknown-diagnosis:" + evidence.signature, file);
        await reportControllerReviewPhase("correcting", { activity: "protocol-correction", role: "diagnostic" });
      },
      prompt: prompt => promptMetered(session as Parameters<typeof promptStorySpecialist>[0], file, prompt),
      feedback: failures => "FORMAT CORRECTION ONLY: preserve the original diagnosis and source identity. " +
        (chosen === generalContract
          ? "Return EXACT keys schema,category,diagnosis,strategy,owner,scopeRef,prerequisites,uncertainty. Omit BOTH signature and sourceRef; the controller binds them. "
          : chosen === historicalGeneralContract
            ? "Return EXACT keys schema,signature,sourceRef,category,diagnosis,strategy,owner,scopeRef,prerequisites,uncertainty. "
            : "Return EXACT keys schema,signature,category,action,summary. ") +
        "No tools, new diagnosis, or authorization. Exact violations: " +
        failures.map(f => f.path + " expected " + f.expected).join("; "),
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
        if (chosen === historicalGeneralContract) throw Error("Historical diagnostic is inspection-only; preserve its original receipt.");
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
      receiptFile: receipt, sourceDigest: evidence.signature, contract: chosen,
      sessionRoots: [sessionsRoot(job)], validate, parse,
      requireSealedTranscript: chosen === generalContract,
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
      sourceDigest: evidence.signature, contract: chosen, session });
    await reportControllerReviewPhase("diagnosing", { activity: "operation-diagnosis", role: "diagnostic" });
    await promptMetered(session, file, chosen === generalContract &&
      evidence.schema === "noveltea-operation-diagnosis-case/v1" ?
      "INDEPENDENT READ-ONLY GENERATION RECOVERY DIAGNOSIS. No tools, Story writes, scope " +
      "grants, verdict overrides, new author approvals, or writer dispatch. " +
      "Use ONLY the authenticated controller packet, do not infer missing evidence. " +
      "Return strict JSON with EXACT keys schema,category,diagnosis,strategy,owner,scopeRef,prerequisites,uncertainty. " +
      "Do NOT transcribe signature or sourceRef: the controller binds both to this authenticated invocation. " +
      "schema=noveltea-recovery-diagnostic-proposal/v1; " +
      "Controller binding (not output fields): signature=" + evidence.signature +
      "; sourceRef=" + evidence.proofRef + "; category=defect|invalid-assignment|protocol|infrastructure|integrity; " +
      "strategy=local-repair|dependency-plan|blueprint-or-work-plan-amend|review-adjudication|reconcile-original|no-write-omission-review|resource-or-author-pause|unsafe. " +
      "Provide a specific diagnosis (4-500 chars) and uncertainty (4-300 chars), " +
      "owner and scopeRef as null or 4–120 and 4–1024 character strings respectively, prerequisites as up to five 4–160 character strings. No control characters in strings. " +
      "The strategy vocabulary describes diagnoses, not executable capability. The verified packet's availableAdapters lists candidate adapters for this original failure only. " +
      "You may identify a needed but missing capability; do not claim it was executed or that the original failure is resolved. " +
      "A proposal never grants authority; the controller independently decides whether an exact existing adapter is safe. " +
      "For local-repair, choose the exact available owner; scopeRef and prerequisites are advisory descriptions, not grants. Native validation and independent Review are always controller-owned gates. " +
      "VERIFIED PACKET: " + JSON.stringify(packet ?? { failedOperation: evidence.operation,
        failedCheck: evidence.check, sourceProof: evidence.proofRef }) :
      "INDEPENDENT READ-ONLY EXECUTION FAILURE DIAGNOSIS. No tools, Story edits, " +
      "approvals, verifier waivers, new scope, software patches, writer dispatch or " +
      "Author Questions. This operation has verified persisted source evidence but " +
      "the controller has no deterministic correction for the authenticated failed check. " +
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
