/**
 * A receipt adapter for the original assignment writer, not a scheduler or
 * independent RecoveryLifecycle. Format correction uses the existing protocol
 * policy; a submitted Story defect requires a new, source-bound writer effect.
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  beginProtocolInvocation, inspectCompletedProtocolResponse, recoverResponseContract,
  ProtocolIntegrityBlockedError, ProtocolExhaustedError, ProtocolVerifierRecheckRejectedError,
  recheckExhaustedProtocolResponse, type ResponseContractSession,
} from "./response-contract-recovery.js";
import { inspectSpecialistManifest, lastSpecialistManifest } from "./specialist-manifest.js";
import { extractSpecialistChoice, parseSpecialistChoice } from "./specialist-choice.js";
import type { ValidationResult } from "./validator.js";

export type AssignmentDefect = Readonly<{
  kind: "metadata" | "provenance" | "requirement";
  path: string;
  code: string;
  line?: number;
  column?: number;
  pointer?: string;
}>;
const metadataCodes = new Set(["schema", "yaml", "frontmatter"]);
/** Coordinates are navigation hints, not evidence of improvement. A smaller
 * strict set of blockers or an actual native pass exposing a later source
 * check is progress; merely trading one schema error for another is not. */
function materialProgress(before: readonly AssignmentDefect[], after: readonly AssignmentDefect[]): boolean {
  if (before.some(d => d.kind === "metadata") && after.every(d => d.kind === "provenance")) return true;
  const key = (d: AssignmentDefect) => JSON.stringify([d.kind, d.path, d.code, d.pointer ?? null]);
  const counts = (defects: readonly AssignmentDefect[]) => {
    const result = new Map<string, number>();
    for (const defect of defects) {
      const id = key(defect);
      result.set(id, (result.get(id) ?? 0) + 1);
    }
    return result;
  };
  const prior = counts(before), next = counts(after);
  return after.length < before.length &&
    [...next].every(([id, count]) => count <= (prior.get(id) ?? 0));
}
const hex = /^[a-f0-9]{64}$/;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const digest = (value: unknown) => hash(JSON.stringify(value));

/** The validator's prose can quote arbitrary authored text. Only known
 * diagnostic codes and numeric coordinates may become writer instructions.
 * Protection changes, missing provenance of the native check, foreign paths
 * and non-metadata diagnostics are not grants for this adapter. */
export function nativeMetadataDefects(
  result: ValidationResult, source: {
    jobId: string; baseSha: string; worktreeStoryRoot: string; validatorVersion: string;
    paths: readonly string[];
    /** Explicit assignment-specific derived catalog consequences, never write grants. */
    derivedDiagnostics?: readonly string[];
  },
): AssignmentDefect[] {
  if (result.status !== "rejected" || result.exitCode !== 1 ||
      result.contract !== "noveltea-validator/v1" || result.jobId !== source.jobId ||
      result.baseSha !== source.baseSha || result.worktreeStoryRoot !== source.worktreeStoryRoot ||
      result.validator.contract !== result.contract || result.validator.implementation !== "native-cli" ||
      result.validator.version !== source.validatorVersion)
    throw new ProtocolIntegrityBlockedError("Native metadata rejection lacks its original validator/source");
  const report = result.report as {
    diagnostics?: { code?: unknown; path?: unknown; line?: unknown; column?: unknown; pointer?: unknown }[];
    protection?: { status?: string; base?: string; changes?: unknown[]; warnings?: unknown[]; findings?: unknown[] };
  } | undefined;
  const protection = report?.protection;
  if (!protection || protection.status !== "checked" || protection.base !== source.baseSha ||
      !Array.isArray(protection.changes) || protection.changes.length ||
      !Array.isArray(protection.warnings) || protection.warnings.length ||
      !Array.isArray(protection.findings) || protection.findings.length ||
      !Array.isArray(report?.diagnostics) || !report.diagnostics.length)
    throw new ProtocolIntegrityBlockedError("Native rejection is not an unprotected scoped metadata defect");
  const position = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  const direct = report.diagnostics.filter(d => !(d.path === "." && typeof d.code === "string" &&
    source.derivedDiagnostics?.includes(d.code)));
  if (!direct.length) throw new ProtocolIntegrityBlockedError("No directly scoped native metadata diagnostic");
  return direct.map(d => {
    if (typeof d.code !== "string" || !metadataCodes.has(d.code) ||
        typeof d.path !== "string" || !source.paths.includes(d.path))
      throw new ProtocolIntegrityBlockedError("Native diagnostic is outside the admitted metadata repair scope");
    return { kind: "metadata", path: d.path, code: d.code,
      ...(position(d.line) ? { line: d.line } : {}),
      ...(position(d.column) ? { column: d.column } : {}),
      ...(typeof d.pointer === "string" && d.pointer.length <= 200 && /^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+){0,15}$/.test(d.pointer)
        ? { pointer: d.pointer } : {}) };
  });
}

type Grant = Readonly<{
  version: 1; ordinal: number; source: string; sessionId: string; sessionFile: string;
  previous: string | null; effectBefore: string | null; defects: readonly AssignmentDefect[];
}>;
type Submission = Readonly<{
  grant: string; start: string; effect: string | null; transcriptBytes: number; transcriptSha256: string;
}>;
type Settlement = Readonly<{
  submission: string; protocol: string; effect: string | null;
  transcriptBytes: number; transcriptSha256: string;
}>;
export type AssignmentInvocationProof = Readonly<{
  sourceDigest: string; ordinal: number; settlementDigest: string;
}>;
export type AssignmentFailureProof = Readonly<{
  kind: "protocol-exhausted" | "nonconverging";
  sourceDigest: string; ordinal: number; receiptDigest: string;
}>;
type TerminalReceipt = Readonly<{
  kind: AssignmentFailureProof["kind"];
  sourceDigest: string; ordinal: number; grant: string; submission: string;
  protocol: string; settlement: string | null; effect: string | null;
  defects: readonly AssignmentDefect[];
  transcriptBytes: number; transcriptSha256: string;
}>;
export class AssignmentAuthorPauseError extends Error {
  constructor() {
    super("Author paused the original assignment before its next model turn.");
    this.name = "AssignmentAuthorPauseError";
  }
}
export class AssignmentNonconvergenceError extends Error {
  constructor() {
    super("Original assignment correction did not make verified progress; assess the original Story defect.");
    this.name = "AssignmentNonconvergenceError";
  }
}
async function optionalJson<T>(path: string): Promise<T | null> {
  const stat = await lstat(path).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128_000)
    throw new ProtocolIntegrityBlockedError("Unsafe original assignment receipt");
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch { throw new ProtocolIntegrityBlockedError("Unreadable original assignment receipt"); }
}
async function seal(path: string, value: unknown) {
  await writeFile(path, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 });
}
async function transcriptPrefix(file: string) {
  if (await realpath(file) !== file || !(await lstat(file)).isFile())
    throw new ProtocolIntegrityBlockedError("Unsafe original assignment transcript");
  const bytes = await readFile(file);
  return { transcriptBytes: bytes.length, transcriptSha256: hash(bytes) };
}
async function attestPrefix(file: string, receipt: { transcriptBytes: number; transcriptSha256: string }) {
  const bytes = await readFile(file);
  if (!Number.isSafeInteger(receipt.transcriptBytes) || receipt.transcriptBytes < 1 ||
      receipt.transcriptBytes > bytes.length || !hex.test(receipt.transcriptSha256) ||
      hash(bytes.subarray(0, receipt.transcriptBytes)) !== receipt.transcriptSha256)
    throw new ProtocolIntegrityBlockedError("Original assignment transcript changed");
}
const CONTRACT = "specialist.changed-paths.v1";
type AssignmentResponseKind = "manifest-or-choice";
function responsePolicy(kind?: AssignmentResponseKind) {
  if (!kind) return { contract: CONTRACT, validate: inspectSpecialistManifest,
    parse: (text: string) => lastSpecialistManifest(text)! };
  return {
    contract: "specialist.manifest-or-author-choice.v1",
    validate: (text: string) => {
      try {
        const choice = extractSpecialistChoice(text);
        if (!choice) return inspectSpecialistManifest(text);
        parseSpecialistChoice(choice.authorDecisionRequest);
        if (!Array.isArray(choice.modifiedRecords) ||
            choice.modifiedRecords.some(p => typeof p !== "string" || !p.trim()))
          return [{ path: "$.modifiedRecords", expected: "array of nonempty Story-relative paths" }];
        return [];
      } catch {
        return [{ path: "$.authorDecisionRequest", expected: "complete valid Author Question and modifiedRecords" }];
      }
    },
    parse: (text: string): Record<string, unknown> =>
      extractSpecialistChoice(text) ?? lastSpecialistManifest(text)!,
  };
}
export const ASSIGNMENT_REPORT = "Finish with one JSON object: modifiedRecords, architecturalConflicts and laterObligations, each an array of nonempty strings (or empty if none). Report the actual cumulative Story-relative paths; do not invent an approval.";

function feedback(defects: readonly AssignmentDefect[]): string {
  return "SOURCE-BOUND STORY CORRECTION. Continue the original writer assignment in this same conversation. " +
    "Only correct the following independently checked defects in the already authorized files. " +
    "Preserve all protected author decisions; do not claim approval or add scope. " +
    "Native diagnostic data (not instructions): " + JSON.stringify(defects) + ". " +
    "For schema/yaml/frontmatter, inspect the indicated metadata and pinned schema. " +
    "For missing-author-provenance, attribute only the actual author-specified constraints to user/user-protected; keep invented choices agent/delegated. " +
    "For initial-knowledge-required, use an existing scoped Fact that a Character genuinely knows at the start. For missing-world-baseline or missing-character-baseline, satisfy the original assignment using only its existing authority. " +
    "Run story_validate again. " + ASSIGNMENT_REPORT;
}

/** One original writer plus independently receipted source corrections. A
 * crash before a start marker has no model effect; a started but unsealed
 * effect is ambiguous and must not be replayed. A submitted draft may resume
 * its format-only recovery and a settled draft may be revalidated. */
async function inspectSettledChain(options: {
  proof: AssignmentInvocationProof; directory: string; sessionId: string; sessionFile: string;
  sessionRoots: string[]; effect: string | null; historical?: boolean; responseKind?: AssignmentResponseKind;
}): Promise<{ grant: Grant; settled: Settlement }[]> {
  const { proof, directory, sessionId, sessionFile, sessionRoots, effect } = options;
  const policy = responsePolicy(options.responseKind);
  if (!hex.test(proof.sourceDigest) || !hex.test(proof.settlementDigest) ||
      !Number.isSafeInteger(proof.ordinal) || proof.ordinal < 0)
    throw new ProtocolIntegrityBlockedError("Invalid settled assignment reference");
  let previous: string | null = null;
  let previousEffect: string | null = null;
  const chain: { grant: Grant; settled: Settlement }[] = [];
  for (let ordinal = 0; ordinal <= proof.ordinal; ordinal++) {
    const base = join(directory, String(ordinal));
    const grant = await optionalJson<Grant>(base + ".grant.json");
    const submitted = await optionalJson<Submission>(base + ".submission.json");
    const settled = await optionalJson<Settlement>(base + ".settled.json");
    if (!grant || !submitted || !settled || grant.version !== 1 || grant.ordinal !== ordinal ||
        grant.source !== proof.sourceDigest || grant.sessionId !== sessionId || grant.sessionFile !== sessionFile ||
        grant.previous !== previous || ordinal > 0 && grant.effectBefore !== previousEffect ||
        submitted.grant !== digest(grant) || submitted.start !== hash(await readFile(base + ".started.json")) ||
        settled.submission !== digest(submitted) || settled.effect !== submitted.effect ||
        settled.protocol !== hash(await readFile(base + ".initial.json")))
      throw new ProtocolIntegrityBlockedError("Settled original invocation/effect proof changed");
    await attestPrefix(sessionFile, submitted);
    await attestPrefix(sessionFile, settled);
    await inspectCompletedProtocolResponse({
      receiptFile: base, sourceDigest: digest(grant), ...policy, sessionRoots,
      sealedPrefix: settled,
    });
    chain.push({ grant, settled });
    previous = digest(settled);
    previousEffect = settled.effect;
    if (ordinal === proof.ordinal) {
      const full = await transcriptPrefix(sessionFile);
      if (previous !== proof.settlementDigest || previousEffect !== effect ||
          !options.historical && (full.transcriptBytes !== settled.transcriptBytes || full.transcriptSha256 !== settled.transcriptSha256 ||
          await optionalJson(join(directory, String(ordinal + 1)) + ".grant.json")))
        throw new ProtocolIntegrityBlockedError("Settled assignment differs from its final authored effect");
    }
  }
  return chain;
}

export async function verifySettledAssignment(options: {
  proof: AssignmentInvocationProof; directory: string; sessionId: string; sessionFile: string;
  sessionRoots: string[]; effect: string; responseKind?: AssignmentResponseKind; historical?: boolean;
}): Promise<void> {
  await inspectSettledChain(options);
}

/** The terminal reference is not itself a verdict. Reauthenticate the
 * exact grant, submitted effect, protocol transcript and prior settlements.
 * Inspection is read-only and cannot spend a new model allowance. */
export async function inspectAssignmentFailure(options: {
  directory: string; sourceDigest: string; sessionId: string; sessionFile: string;
  sessionRoots: string[]; effect: string | null; responseKind?: AssignmentResponseKind;
}): Promise<{ proof: AssignmentFailureProof; defects: readonly AssignmentDefect[] } | null> {
  const { directory, sourceDigest, sessionId, sessionFile, sessionRoots, effect } = options;
  const policy = responsePolicy(options.responseKind);
  const terminal = await optionalJson<TerminalReceipt>(join(directory, "terminal.json"));
  if (!terminal) return null;
  const { ordinal, kind } = terminal;
  if (!hex.test(sourceDigest) || terminal.sourceDigest !== sourceDigest ||
      !Number.isSafeInteger(ordinal) || ordinal < 0 || terminal.effect !== effect ||
      !["protocol-exhausted", "nonconverging"].includes(kind) ||
      await optionalJson(join(directory, String(ordinal + 1)) + ".grant.json"))
    throw new ProtocolIntegrityBlockedError("Original terminal assignment source changed");
  const full = await transcriptPrefix(sessionFile);
  if (full.transcriptBytes !== terminal.transcriptBytes || full.transcriptSha256 !== terminal.transcriptSha256)
    throw new ProtocolIntegrityBlockedError("Original terminal transcript changed");
  const base = join(directory, String(ordinal));
  const grant = await optionalJson<Grant>(base + ".grant.json");
  const submitted = await optionalJson<Submission>(base + ".submission.json");
  if (!grant || !submitted || grant.version !== 1 || grant.ordinal !== ordinal ||
      grant.source !== sourceDigest || grant.sessionId !== sessionId || grant.sessionFile !== sessionFile ||
      digest(grant) !== terminal.grant || digest(submitted) !== terminal.submission ||
      submitted.grant !== terminal.grant || submitted.effect !== effect ||
      submitted.start !== hash(await readFile(base + ".started.json")) ||
      terminal.protocol !== hash(await readFile(base + ".initial.json")))
    throw new ProtocolIntegrityBlockedError("Terminal original effect or protocol proof changed");
  await attestPrefix(sessionFile, submitted);
  if (kind === "protocol-exhausted") {
    if (terminal.settlement !== null || terminal.defects.length ||
        await optionalJson(base + ".settled.json"))
      throw new ProtocolIntegrityBlockedError("Exhausted protocol cannot claim accepted Story defects");
    if (ordinal > 0) await inspectSettledChain({ ...options,
      proof: { sourceDigest, ordinal: ordinal - 1, settlementDigest: grant.previous! },
      effect: grant.effectBefore, historical: true });
    else if (grant.previous !== null || grant.defects.length)
      throw new ProtocolIntegrityBlockedError("Initial exhausted invocation has a foreign predecessor");
    try {
      await recheckExhaustedProtocolResponse({ receiptFile: base, sourceDigest: terminal.grant,
        ...policy, sessionRoots, expectedSession: { id: sessionId, file: sessionFile },
        submittedPrefix: submitted });
      throw new ProtocolIntegrityBlockedError("Exhausted original protocol no longer fails");
    } catch (error) {
      if (!(error instanceof ProtocolVerifierRecheckRejectedError)) throw error;
    }
  } else {
    if (!terminal.settlement || !Array.isArray(terminal.defects) || !terminal.defects.length)
      throw new ProtocolIntegrityBlockedError("Nonconverging assignment lacks a settled defect");
    const chain = await inspectSettledChain({ ...options,
      proof: { sourceDigest, ordinal, settlementDigest: terminal.settlement } });
    let nonproductive = 0;
    const seen = new Set<string>();
    let oscillating = false;
    for (let i = 0; i < chain.length; i++) {
      const { grant: original, settled } = chain[i]!;
      const next = chain[i + 1]?.grant.defects ?? terminal.defects;
      if (original.defects.length)
        nonproductive = materialProgress(original.defects, next) ? 0 : nonproductive + 1;
      const finding = digest({ effect: settled.effect, defects: next });
      oscillating = seen.has(finding) && original.effectBefore !== settled.effect;
      if (i < ordinal && (oscillating || nonproductive >= 2))
        throw new ProtocolIntegrityBlockedError("A stopped assignment illegally continued corrective writes");
      seen.add(finding);
    }
    if (!oscillating && nonproductive < 2)
      throw new ProtocolIntegrityBlockedError("Original substantive correction has not demonstrated nonconvergence");
  }
  return { proof: { kind, sourceDigest, ordinal, receiptDigest: digest(terminal) }, defects: terminal.defects };
}

export async function recoverSubmittedAssignment(options: {
  session: ResponseContractSession;
  directory: string;
  sourceDigest: string;
  sessionRoots: string[];
  responseKind?: AssignmentResponseKind;
  /** Exact prior transcript from a verified, claimed Author Choice. */
  initialTranscriptSha256?: string;
  initialPrompt: string;
  authorize: () => Promise<void>;
  effect: () => Promise<string | null>;
  verify: (manifest: Record<string, unknown>) => Promise<readonly AssignmentDefect[]>;
  beforeTurn: () => Promise<void>;
  prompt: (text: string) => Promise<void>;
}): Promise<AssignmentInvocationProof> {
  const { session, directory, sourceDigest, sessionRoots } = options;
  const policy = responsePolicy(options.responseKind);
  const sessionFile = session.sessionManager.getSessionFile();
  if (!sessionFile || !hex.test(sourceDigest)) throw new ProtocolIntegrityBlockedError("Missing assignment invocation identity");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await options.authorize();
  const inspectTerminal = async () => inspectAssignmentFailure({ directory, sourceDigest,
    sessionId: session.sessionId, sessionFile, sessionRoots, responseKind: options.responseKind, effect: await options.effect() });
  const savedTerminal = await inspectTerminal();
  if (savedTerminal) {
    if (savedTerminal.proof.kind === "nonconverging") throw new AssignmentNonconvergenceError();
    const protocol = await optionalJson<{ failedPaths: string[] }>(
      join(directory, String(savedTerminal.proof.ordinal) + ".initial.json"));
    if (!protocol) throw new ProtocolIntegrityBlockedError("Exhausted protocol receipt is missing");
    throw new ProtocolExhaustedError(policy.contract, 3, protocol.failedPaths, session.sessionId);
  }
  let previous: string | null = null;
  let effectBefore: string | null = null;
  let defects: readonly AssignmentDefect[] = [];
  const seen = new Set<string>();
  let nonproductive = 0;
  let precedingProtocol: { base: string; grantDigest: string; settlement: Settlement } | null = null;
  for (let ordinal = 0; ; ordinal++) {
    await options.authorize();
    const base = join(directory, String(ordinal));
    const grantPath = base + ".grant.json";
    const submissionPath = base + ".submission.json";
    const settlementPath = base + ".settled.json";
    const protocolPath = base + ".initial.json";
    let grant = await optionalJson<Grant>(grantPath);
    const startedPath = base + ".started.json";
    const started = await optionalJson(startedPath);
    let submitted = await optionalJson<Submission>(submissionPath);
    let settled = await optionalJson<Settlement>(settlementPath);
    if (!grant && (started || submitted || settled || await optionalJson(protocolPath)))
      throw new ProtocolIntegrityBlockedError("Original assignment attempt lost its grant");
    if (grant) {
      if (grant.version !== 1 || grant.ordinal !== ordinal || grant.source !== sourceDigest ||
          grant.sessionId !== session.sessionId || grant.sessionFile !== sessionFile ||
          grant.previous !== previous || (ordinal > 0 && grant.effectBefore !== effectBefore) ||
          (ordinal === 0 && grant.defects.length !== 0))
        throw new ProtocolIntegrityBlockedError("Original assignment grant/source changed");
      // Historical grants are authenticated by the preceding settlement and
      // the exact next transcript prefix. Current corrections are revalidated
      // below before dispatch, never simply inferred from a receipt.
      defects = grant.defects;
      effectBefore = grant.effectBefore;
    } else {
      effectBefore = await options.effect();
      grant = { version: 1, ordinal, source: sourceDigest, sessionId: session.sessionId,
        sessionFile, previous, effectBefore, defects };
      await seal(grantPath, grant);
    }
    const grantDigest = digest(grant);
    if (submitted && (!started || submitted.grant !== grantDigest ||
        submitted.start !== hash(await readFile(startedPath))))
      throw new ProtocolIntegrityBlockedError("Submitted draft differs from its original invocation grant");
    if (settled && (!submitted || settled.submission !== digest(submitted) ||
        settled.effect !== submitted.effect ||
        settled.protocol !== hash(await readFile(protocolPath))))
      throw new ProtocolIntegrityBlockedError("Settled draft differs from its independent original effect/protocol receipts");
    if (submitted) await attestPrefix(sessionFile, submitted);
    if (settled) await attestPrefix(sessionFile, settled);
    if (!submitted) {
      if (started) throw new ProtocolIntegrityBlockedError("Original writer started without a sealed effect; never replay");
      if (!precedingProtocol && session.messages.some(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") &&
          (!options.initialTranscriptSha256 || (await transcriptPrefix(sessionFile)).transcriptSha256 !== options.initialTranscriptSha256))
        throw new ProtocolIntegrityBlockedError("Original writer transcript already contains an invocation; never replay");
      if (precedingProtocol) {
        const prefix = await transcriptPrefix(sessionFile);
        if (prefix.transcriptBytes !== precedingProtocol.settlement.transcriptBytes ||
            prefix.transcriptSha256 !== precedingProtocol.settlement.transcriptSha256)
          throw new ProtocolIntegrityBlockedError("Original writer has an unreceipted transcript suffix; never replay");
      }
      if (await options.effect() !== effectBefore)
        throw new ProtocolIntegrityBlockedError("Assignment draft changed before its admitted corrective invocation");
      // An unstarted correction grant recovered after a crash is only a
      // reference. Re-run the trusted native/provenance verifier on its exact
      // predecessor; do not let a saved diagnostic payload grant a new effect.
      if (precedingProtocol) {
        const manifest = await inspectCompletedProtocolResponse({
          receiptFile: precedingProtocol.base, sourceDigest: precedingProtocol.grantDigest,
          ...policy, sessionRoots,
        });
        if (digest(await options.verify(manifest)) !== digest(grant.defects))
          throw new ProtocolIntegrityBlockedError("Corrective grant no longer matches native/source diagnostics");
      }
      await options.beforeTurn();
      await options.authorize();
      if (await options.effect() !== effectBefore)
        throw new ProtocolIntegrityBlockedError("Assignment source changed during budget admission");
      await beginProtocolInvocation({ receiptFile: base, contract: policy.contract, sourceDigest: grantDigest, session });
      await options.prompt(ordinal === 0 ? options.initialPrompt : feedback(defects));
      const last = session.messages.at(-1);
      if (last?.role !== "assistant" || last.stopReason !== "stop" || !Array.isArray(last.content))
        throw new ProtocolIntegrityBlockedError("Original writer did not settle a complete response");
      await options.authorize();
      submitted = { grant: grantDigest, start: hash(await readFile(startedPath)),
        effect: await options.effect(), ...await transcriptPrefix(sessionFile) };
      await seal(submissionPath, submitted);
    }
    if (!settled) {
      if (await options.effect() !== submitted.effect)
        throw new ProtocolIntegrityBlockedError("Submitted Story effect changed before format correction");
      const protocolOptions = {
        session, ...policy, sourceDigest: grantDigest,
        receiptFile: protocolPath,
        beforeCorrection: async () => {
          await options.authorize();
          if (await options.effect() !== submitted!.effect)
            throw new ProtocolIntegrityBlockedError("Format-only correction cannot change Story effects");
          await options.beforeTurn();
        },
        prompt: options.prompt,
      };
      const priorProtocol = await optionalJson(protocolPath);
      if (!priorProtocol) {
        const prefix = await transcriptPrefix(sessionFile);
        if (prefix.transcriptBytes !== submitted.transcriptBytes ||
            prefix.transcriptSha256 !== submitted.transcriptSha256)
          throw new ProtocolIntegrityBlockedError("Submitted writer has unreceipted protocol activity");
      }
      try {
        await recoverResponseContract({ ...protocolOptions,
          ...(priorProtocol ? { resumeOriginal: { base, sessionRoots } } : {}) });
      } catch (error) {
        if (!(error instanceof ProtocolExhaustedError)) throw error;
        await options.authorize();
        if (await options.effect() !== submitted.effect)
          throw new ProtocolIntegrityBlockedError("Exhausted format correction changed Story effects");
        await seal(join(directory, "terminal.json"), {
          kind: "protocol-exhausted", sourceDigest, ordinal, grant: grantDigest,
          submission: digest(submitted), protocol: hash(await readFile(protocolPath)),
          settlement: null, effect: submitted.effect, defects: [],
          ...await transcriptPrefix(sessionFile),
        } satisfies TerminalReceipt);
        await inspectTerminal();
        throw error;
      }
      await options.authorize();
      if (await options.effect() !== submitted.effect)
        throw new ProtocolIntegrityBlockedError("Format-only correction changed Story effects");
      settled = { submission: digest(submitted), effect: submitted.effect,
        protocol: hash(await readFile(protocolPath)), ...await transcriptPrefix(sessionFile) };
      await seal(settlementPath, settled);
    }
    previous = digest(settled);
    effectBefore = settled.effect;
    // Later attempts in this same conversation append to the earlier transcript.
    // Authenticate their predecessor receipt before inspecting the latest reply.
    const next = await optionalJson<Grant>(join(directory, String(ordinal + 1)) + ".grant.json");
    if (next) {
      await inspectCompletedProtocolResponse({
        receiptFile: base, sourceDigest: grantDigest, ...policy, sessionRoots,
        sealedPrefix: settled,
      });
      precedingProtocol = { base, grantDigest, settlement: settled };
      // The next grant preserves the exact failure observed against this
      // settled effect, so restart cannot reset progress history.
      seen.add(digest({ effect: settled.effect, defects: next.defects }));
      if (grant.defects.length)
        nonproductive = materialProgress(grant.defects, next.defects) ? 0 : nonproductive + 1;
      continue;
    }
    if (await options.effect() !== settled.effect)
      throw new ProtocolIntegrityBlockedError("Settled original Story effect changed");
    const manifest = await inspectCompletedProtocolResponse({
      receiptFile: base, sourceDigest: grantDigest, ...policy, sessionRoots,
    });
    defects = await options.verify(manifest);
    if (!defects.length) return { sourceDigest, ordinal, settlementDigest: digest(settled) };
    // A changed draft alone is not proof of progress: compare independently
    // observed defects. Distinct metadata/provenance findings are not one
    // structural counter. Two nonproductive rounds or actual oscillation
    // leave the local known-correction contract for parent assessment.
    const finding = digest({ effect: settled.effect, defects });
    if (grant.defects.length)
      nonproductive = materialProgress(grant.defects, defects) ? 0 : nonproductive + 1;
    const oscillating = seen.has(finding) && grant.effectBefore !== settled.effect;
    if (oscillating || nonproductive >= 2) {
      await seal(join(directory, "terminal.json"), {
        kind: "nonconverging", sourceDigest, ordinal, grant: grantDigest,
        submission: digest(submitted), protocol: hash(await readFile(protocolPath)),
        settlement: digest(settled), effect: settled.effect, defects,
        ...await transcriptPrefix(sessionFile),
      } satisfies TerminalReceipt);
      await inspectTerminal();
      throw new AssignmentNonconvergenceError();
    }
    seen.add(finding);
    precedingProtocol = { base, grantDigest, settlement: settled };
  }
}
