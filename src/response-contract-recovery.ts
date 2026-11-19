import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, mkdir, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

/** Only the response contract is repairable here. This policy never replays a
 * writer, expands a work grant, charges a semantic correction, or compacts Pi. */
export interface ResponseContractFailure {
  path: string;
  expected: string;
}

export interface ResponseContractSession {
  sessionId: string;
  sessionManager: { getSessionFile(): string | undefined };
  messages: readonly {
    role: string;
    stopReason?: string;
    content?: string | readonly { type: string; text?: string; name?: string }[];
  }[];
  getActiveToolNames(): string[];
  setActiveToolsByName(names: string[]): void;
}

export class ProtocolExhaustedError extends Error {
  readonly code = "protocol-exhausted";
  constructor(readonly contract: string, readonly attempts: number,
    readonly failedPaths: string[], readonly sessionId: string) {
    super("protocol-exhausted: response contract " + contract + " exhausted " + attempts +
      " complete responses (" + failedPaths.join(", ") +
      "); no substantive Story defect or review verdict is implied. " +
      "Inspect the pinned session transcript and protocol receipts before continuation.");
    this.name = "ProtocolExhaustedError";
  }
}

function invocationId(contract: string, sessionId: string, sessionFile: string): string {
  return createHash("sha256").update(contract + "\u0000" + sessionId + "\u0000" + sessionFile)
    .digest("hex");
}

interface ContractReceipt {
  version: 1;
  invocationId: string;
  contract: string;
  sessionId: string;
  sessionFile: string;
  attempts: number;
  responseHash: string;
  status: "invalid-response" | "correction-pending" | "accepted" | "protocol-exhausted";
  failedPaths: string[];
  /** Bound independently to the controller Turn/review packet, not mutable prose. */
  sourceDigest?: string;
  /** Index among the original Pi conversation\'s completed assistant turns. */
  responseOrdinal?: number;
}

async function saveReceipt(file: string, state: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(state) + "\n", { flag: "wx", mode: 0o600 });
  await rename(temp, file);
}

/** Persist the active invocation before its FIRST model prompt. A retrying
 * graph node may inspect this marker and the transcript, never issue the
 * original assignment twice. */
export async function beginProtocolInvocation(options: {
  receiptFile: string; sourceDigest: string; contract: string; session: ResponseContractSession;
}): Promise<void> {
  await refuseReplayedProtocolInvocation(options.receiptFile);
  const sessionFile = options.session.sessionManager.getSessionFile();
  if (!sessionFile) throw Error("Protocol invocation requires a durable Pi transcript.");
  await mkdir(dirname(options.receiptFile), { recursive: true, mode: 0o700 });
  const transcript = await readFile(sessionFile).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  await writeFile(options.receiptFile + ".started.json", JSON.stringify({
    version: 1, sourceDigest: options.sourceDigest, contract: options.contract,
    invocationId: invocationId(options.contract, options.session.sessionId, sessionFile),
    sessionId: options.session.sessionId, sessionFile,
    ...(transcript ? { transcriptBytesBeforePrompt: transcript.length,
      transcriptSha256BeforePrompt: createHash("sha256").update(transcript).digest("hex") } : {}),
    freshInvocationAllowance: 1,
  }) + "\n", { flag: "wx", mode: 0o600 });
}

export async function refuseReplayedProtocolInvocation(receiptFile: string): Promise<void> {
  for (const suffix of [".started.json", ".initial.json", ".fresh-allowance.json", ".fresh.json"]) {
    try {
      await readFile(receiptFile + suffix, "utf8");
      throw new Error("Existing protocol invocation requires transcript/receipt reconciliation, not model replay.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** Read-only Graph restart gate for a completed model response. Only the exact
 * original Pi transcript, source grant and durable attempt receipts can yield
 * a response. Missing/ambiguous activity never creates a new Pi invocation. */
export class ProtocolIntegrityBlockedError extends Error {
  readonly code = "integrity-blocked";
  constructor(reason: string) {
    super("integrity-blocked: " + reason + "; preserve the original Pi transcript and receipts.");
    this.name = "ProtocolIntegrityBlockedError";
  }
}

interface StartedInvocation {
  version: 1;
  contract: string;
  sourceDigest: string;
  invocationId: string;
  sessionId: string;
  sessionFile: string;
  transcriptBytesBeforePrompt?: number;
  transcriptSha256BeforePrompt?: string;
}
interface FreshAuthorization {
  version: 1;
  contract: string;
  sourceDigest: string;
  originalInvocationId: string;
  originalSessionId: string;
  originalSessionFile: string;
  freshAllowanceConsumed: true;
  freshInvocationId: string;
  freshSessionId: string;
  freshSessionFile: string;
}
const hex64 = /^[a-f0-9]{64}$/;
async function regularJson<T>(file: string): Promise<T | null> {
  let stat;
  try { stat = await lstat(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128_000)
    throw new ProtocolIntegrityBlockedError("Unsafe protocol receipt");
  try { return JSON.parse(await readFile(file, "utf8")) as T; }
  catch { throw new ProtocolIntegrityBlockedError("Unreadable protocol receipt"); }
}
async function transcriptResponses(file: string, roots: readonly string[], id: string) {
  if (!roots.length || !file || !resolve(file).startsWith(sep))
    throw new ProtocolIntegrityBlockedError("Missing original transcript path");
  const canonical = await realpath(file).catch(() => null);
  if (canonical !== file || !roots.some(root => {
    const within = relative(resolve(root), file);
    return within !== "" && within !== ".." && !within.startsWith(".." + sep);
  }))
    throw new ProtocolIntegrityBlockedError("Transcript escaped its pinned session directory");
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024)
    throw new ProtocolIntegrityBlockedError("Unsafe Pi transcript file");
  const bytes = await readFile(file);
  let records: Array<Record<string, unknown>>;
  try { records = bytes.toString("utf8").trim().split("\n").map(line =>
    JSON.parse(line) as Record<string, unknown>); }
  catch { throw new ProtocolIntegrityBlockedError("Pi transcript contains malformed records"); }
  if (records[0]?.type !== "session" || records[0].id !== id)
    throw new ProtocolIntegrityBlockedError("Pi transcript session header changed");
  const messages = records.filter(r => r.type === "message").map(r =>
    r.message as { role?: string; stopReason?: string;
      content?: Array<{ type: string; text?: string }> } | undefined);
  const complete = messages.filter(m => m?.role === "assistant" &&
    !["aborted", "error"].includes(m.stopReason ?? "") &&
    Array.isArray(m.content) && m.stopReason === "stop").map(m =>
    m!.content!.filter(c => c.type === "text").map(c => c.text ?? "").join("\n"));
  return { bytes, messages, complete };
}
function checkedReceipt(receipt: ContractReceipt, sourceDigest: string,
  contract: string, started: StartedInvocation | null, allowance: FreshAuthorization | null) {
  if (receipt.version !== 1 || receipt.contract !== contract ||
      !hex64.test(receipt.invocationId) || !hex64.test(receipt.responseHash) ||
      (receipt.sourceDigest !== undefined && receipt.sourceDigest !== sourceDigest) ||
      !receipt.sessionId || !receipt.sessionFile ||
      invocationId(contract, receipt.sessionId, receipt.sessionFile) !== receipt.invocationId ||
      !Number.isInteger(receipt.attempts) || receipt.attempts < 1 || receipt.attempts > 3 ||
      !Array.isArray(receipt.failedPaths) || receipt.failedPaths.length > 8 ||
      !["invalid-response", "correction-pending", "accepted", "protocol-exhausted"].includes(receipt.status) ||
      (started && (started.sessionId !== receipt.sessionId ||
        started.sessionFile !== receipt.sessionFile ||
        started.invocationId !== receipt.invocationId)) ||
      (allowance && (allowance.freshSessionId !== receipt.sessionId ||
        allowance.freshSessionFile !== receipt.sessionFile ||
        allowance.freshInvocationId !== receipt.invocationId)))
    throw new ProtocolIntegrityBlockedError("Receipt contract, source, session or budget differs");
}
export async function inspectCompletedProtocolResponse<T>(options: {
  receiptFile: string;
  sourceDigest: string;
  contract: string;
  sessionRoots: string[];
  validate: (text: string) => ResponseContractFailure[];
  parse: (text: string) => T;
}): Promise<T> {
  const { receiptFile, sourceDigest, contract, sessionRoots, validate, parse } = options;
  if (!hex64.test(sourceDigest) || !/^[a-z][a-z0-9.-]{0,100}$/.test(contract))
    throw new ProtocolIntegrityBlockedError("Invalid source or response contract");
  const started = await regularJson<StartedInvocation>(receiptFile + ".started.json");
  const first = await regularJson<ContractReceipt>(receiptFile + ".initial.json");
  const allowance = await regularJson<FreshAuthorization>(receiptFile + ".fresh-allowance.json");
  const second = await regularJson<ContractReceipt>(receiptFile + ".fresh.json");
  if (started && (started.version !== 1 || started.contract !== contract ||
      started.sourceDigest !== sourceDigest ||
      invocationId(contract, started.sessionId, started.sessionFile) !== started.invocationId))
    throw new ProtocolIntegrityBlockedError("Original invocation marker differs from its source");
  if (first) checkedReceipt(first, sourceDigest, contract, started, null);
  if (second) {
    if (!allowance || allowance.version !== 1 || allowance.contract !== contract ||
        allowance.sourceDigest !== sourceDigest || allowance.freshAllowanceConsumed !== true ||
        !first || first.status !== "protocol-exhausted" ||
        allowance.originalInvocationId !== first.invocationId ||
        allowance.originalSessionId !== first.sessionId ||
        allowance.originalSessionFile !== first.sessionFile ||
        allowance.freshSessionFile === first.sessionFile)
      throw new ProtocolIntegrityBlockedError("Fresh fallback lacks its one-time original exhaustion grant");
    checkedReceipt(second, sourceDigest, contract, null, allowance);
  }
  if (allowance && !second)
    throw new ProtocolIntegrityBlockedError("Fresh invocation outcome remains uncertain");
  if (first && first.status !== "accepted" && first.status !== "protocol-exhausted" &&
      first.status !== "correction-pending")
    throw new ProtocolIntegrityBlockedError("Protocol retry requires original-session reconciliation");
  const selected = second ?? (first?.status === "accepted" ? first : null);
  if (first?.status === "protocol-exhausted" && !second)
    throw new ProtocolExhaustedError(contract, first.attempts, first.failedPaths, first.sessionId);
  if (!selected && !started && !first)
    throw new ProtocolIntegrityBlockedError("No original protocol invocation exists");
  const sessionFile = selected?.sessionFile ?? first?.sessionFile ?? started!.sessionFile;
  const sessionId = selected?.sessionId ?? first?.sessionId ?? started!.sessionId;
  const evidence = await transcriptResponses(sessionFile, sessionRoots, sessionId);
  const original = second && first
    ? await transcriptResponses(first.sessionFile, sessionRoots, first.sessionId)
    : evidence;
  if (started?.transcriptBytesBeforePrompt !== undefined &&
      started.transcriptSha256BeforePrompt !== undefined &&
      (original.bytes.length < started.transcriptBytesBeforePrompt ||
        createHash("sha256").update(original.bytes.subarray(0, started.transcriptBytesBeforePrompt))
          .digest("hex") !== started.transcriptSha256BeforePrompt))
    throw new ProtocolIntegrityBlockedError("Original Pi transcript is not an append-only descendant of admission");
  if (second && first && (first.responseOrdinal !== undefined &&
        first.responseOrdinal !== original.complete.length ||
      createHash("sha256").update(original.complete.at(-1) ?? "").digest("hex") !==
        first.responseHash))
    throw new ProtocolIntegrityBlockedError("Exhausted original Pi transcript differs from its sealed receipt");
  let candidate: string | undefined;
  let attempts: number;
  if (selected) {
    attempts = selected.attempts;
    if (selected.responseOrdinal !== undefined &&
        (selected.responseOrdinal < 1 || selected.responseOrdinal > evidence.complete.length ||
          selected.responseOrdinal !== evidence.complete.length))
      throw new ProtocolIntegrityBlockedError("Completed-response ordinal differs from receipt");
    candidate = evidence.complete[selected.responseOrdinal
      ? selected.responseOrdinal - 1 : evidence.complete.length - 1];
    if (!candidate || createHash("sha256").update(candidate).digest("hex") !== selected.responseHash ||
        selected.status !== "accepted")
      throw new ProtocolIntegrityBlockedError("Accepted response differs from the original transcript");
  } else if (first?.status === "correction-pending") {
    // A format-only continuation has no tools whatsoever. Even a correctly
    // shaped final JSON cannot excuse a write/inspection side effect that
    // happened after the previous response was rejected.
    let priorResponses = 0;
    let pastRejected = false;
    let correctionPrompts = 0;
    for (const message of evidence.messages) {
      if (pastRejected) {
        if (message?.role === "user") correctionPrompts++;
        if (message?.role === "toolResult" ||
            message?.role === "assistant" && Array.isArray(message.content) &&
              message.content.some(c => c.type === "toolCall"))
          throw new ProtocolIntegrityBlockedError("Format-only correction executed an unexpected tool");
      }
      if (message?.role === "assistant" && message.stopReason === "stop" &&
          ++priorResponses === first.responseOrdinal) pastRejected = true;
    }
    if (!pastRejected || correctionPrompts !== 1)
      throw new ProtocolIntegrityBlockedError("Corrected response has an ambiguous Pi prompt boundary");
    if (!first.responseOrdinal || evidence.complete.length !== first.responseOrdinal + 1 ||
        createHash("sha256").update(evidence.complete[first.responseOrdinal - 1] ?? "")
          .digest("hex") !== first.responseHash)
      throw new ProtocolIntegrityBlockedError("Pending correction has no single attributable completed response");
    attempts = first.attempts + 1;
    candidate = evidence.complete[first.responseOrdinal];
  } else if (!first && started) {
    // The first prompt was admitted but the response receipt was not written.
    // Only a single original completed model turn after the exact pinned
    // pre-prompt bytes can be adopted. Multiple turns are ambiguous.
    if (started.transcriptBytesBeforePrompt === undefined ||
        !hex64.test(started.transcriptSha256BeforePrompt ?? ""))
      throw new ProtocolIntegrityBlockedError("Legacy start marker lacks a transcript boundary");
    let newRecords: Array<{ type?: string; message?: { role?: string; stopReason?: string;
      content?: Array<{ type: string; text?: string }> } }>;
    try {
      newRecords = evidence.bytes.subarray(started.transcriptBytesBeforePrompt)
        .toString("utf8").trim().split("\n").map(s => JSON.parse(s));
    } catch { throw new ProtocolIntegrityBlockedError("Interrupted first prompt has incomplete transcript entries"); }
    const newMessages = newRecords.filter(r => r.type === "message").map(r => r.message);
    if (newMessages.filter(m => m?.role === "user").length !== 1 ||
        newMessages.filter(m => m?.role === "assistant" && m.stopReason === "stop").length !== 1 ||
        !newMessages.some(m => m?.role === "assistant" && m.stopReason === "stop"))
      throw new ProtocolIntegrityBlockedError("Original first response is missing or ambiguous");
    attempts = 1;
    candidate = evidence.complete.at(-1);
  } else {
    throw new ProtocolIntegrityBlockedError("Incomplete protocol attempt requires original-session reconciliation");
  }
  if (!candidate || validate(candidate).length)
    throw new ProtocolIntegrityBlockedError("Completed response is structurally invalid; preserve the original correction budget");
  let result: T;
  try { result = parse(candidate); }
  catch { throw new ProtocolIntegrityBlockedError("Completed response failed controller parsing"); }
  if (!selected) {
    const receipt: ContractReceipt = {
      version: 1, invocationId: invocationId(contract, sessionId, sessionFile),
      contract, sessionId, sessionFile, sourceDigest,
      attempts, responseOrdinal: evidence.complete.length,
      responseHash: createHash("sha256").update(candidate).digest("hex"),
      failedPaths: [], status: "accepted",
    };
    await saveReceipt(receiptFile + ".initial.json", receipt);
  }
  return result;
}

/** Return the authenticated completed invocation's original transcript and
 * successful read tools, for production planner/reviewer admission after a
 * crash between response completion and their next Graph checkpoint. */
export async function inspectCompletedProtocolReads(options: {
  receiptFile: string; sourceDigest: string; contract: string; sessionRoots: string[];
}): Promise<{ sessionFile: string; reads: string[] }> {
  const first = await regularJson<ContractReceipt>(options.receiptFile + ".initial.json");
  const fresh = await regularJson<ContractReceipt>(options.receiptFile + ".fresh.json");
  const selected = fresh ?? first;
  if (!selected || selected.status !== "accepted" ||
      selected.sourceDigest !== options.sourceDigest ||
      selected.contract !== options.contract)
    throw new ProtocolIntegrityBlockedError("Accepted invocation has no source-bound terminal receipt");
  const evidence = await transcriptResponses(selected.sessionFile,
    options.sessionRoots, selected.sessionId);
  const completed = new Set<string>();
  for (const message of evidence.messages as Array<{ role?: string; toolCallId?: string; isError?: boolean }>)
    if (message.role === "toolResult" && !message.isError && message.toolCallId)
      completed.add(message.toolCallId);
  const reads = evidence.messages.flatMap(message => {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) return [];
    return message.content.flatMap(c => {
      const call = c as { type: string; name?: string; id?: string;
        arguments?: { path?: unknown } };
      return call.type === "toolCall" && call.name === "read" &&
        completed.has(call.id ?? "") && typeof call.arguments?.path === "string"
        ? [call.arguments.path] : [];
    });
  });
  return { sessionFile: selected.sessionFile, reads };
}

function response(session: ResponseContractSession): string {
  const last = [...session.messages].reverse().find(m => m.role === "assistant");
  if (!last || ["error", "aborted"].includes(last.stopReason ?? "") ||
      !Array.isArray(last.content))
    throw new Error("Pi response did not finish; preserve the original operation for reconciliation.");
  return last.content.filter(c => c.type === "text").map(c => c.text ?? "").join("\n");
}

function correctionFeedback(contract: string, failures: readonly ResponseContractFailure[],
  schema?: string): string {
  // Only known schema paths and expected shapes are echoed; never send the
  // untrusted response, parser exception, secret-bearing values or stack.
  const safe = failures.slice(0, 8).map(f => f.path + ": " + f.expected).join("\n");
  return "RESPONSE-CONTRACT CORRECTION ONLY (" + contract + "). The original " +
    "Story edits are already complete. Correct your final report in this SAME " +
    "Pi session. No tool calls, new source inspections, edits, scope changes, " +
    "approval changes or new Story work are permitted. Return ONLY one complete " +
    "unfenced JSON response. Preserve all truthful architecturalConflicts and " +
    "laterObligations; do not claim that a failed review is resolved. " +
    "Exact contract failures:\n" + safe +
    "\n" + (schema ?? "Required report keys: modifiedRecords, architecturalConflicts, " +
    "laterObligations (each an array of nonempty strings). modifiedRecords " +
    "must be the complete actual cumulative Story-relative changed paths. ") +
    "The controller independently checks the Git diff, source and receipts.";
}

/**
 * Shared invocation policy. Initial completed Pi reply + at most two further
 * replies in its original Pi conversation. Receipts are written before any
 * continuation prompt so an interrupted writer must be reconciled rather than
 * silently retried by graph replay. Format-only attempts expose ZERO tools.
 */
export async function recoverResponseContract<T>(options: {
  session: ResponseContractSession;
  contract: string;
  validate: (text: string) => ResponseContractFailure[];
  parse: (text: string) => T;
  prompt: (feedback: string) => Promise<void>;
  beforeCorrection?: () => Promise<void>;
  feedback?: (failures: readonly ResponseContractFailure[]) => string;
  receiptFile?: string;
  /** Static, controller-authored contract text for a non-manifest response. */
  schema?: string;
  sourceDigest?: string;
}): Promise<T> {
  const { session, contract, validate, parse, prompt, receiptFile } = options;
  const sessionFile = session.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("Protocol recovery requires a durable Pi session transcript.");
  if (!/^[a-z][a-z0-9.-]{0,100}$/.test(contract))
    throw new Error("Invalid response contract identity.");
  if (receiptFile) {
    try {
      await readFile(receiptFile, "utf8");
      throw new Error("Existing protocol-recovery receipt requires reconciliation; do not replay a Pi response.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const originalTools = session.getActiveToolNames();
  for (let index = 0; index < 3; index++) {
    const text = response(session);
    const failures = validate(text);
    const current: ContractReceipt = {
      version: 1,
      invocationId: invocationId(contract, session.sessionId, sessionFile),
      contract, sessionId: session.sessionId, sessionFile,
      ...(options.sourceDigest ? { sourceDigest: options.sourceDigest } : {}),
      responseOrdinal: session.messages.filter(m => m.role === "assistant" &&
        m.stopReason === "stop" && Array.isArray(m.content)).length,
      attempts: index + 1, responseHash: createHash("sha256").update(text).digest("hex"),
      failedPaths: failures.map(f => f.path),
      status: failures.length ? "invalid-response" : "accepted",
    };
    if (!failures.length) {
      // Structural validity only. Semantic refusal and independent source
      // validation remain outside this policy and are never retried as JSON.
      const result = parse(text);
      if (receiptFile) await saveReceipt(receiptFile, current);
      return result;
    }
    if (index === 2) {
      current.status = "protocol-exhausted";
      if (receiptFile) await saveReceipt(receiptFile, current);
      throw new ProtocolExhaustedError(contract, 3, current.failedPaths, session.sessionId);
    }
    // The same job-level Pi budget admission is rechecked before each extra
    // model call. Protocol retries never consume semantic repair counters.
    if (receiptFile) await saveReceipt(receiptFile, current);
    await options.beforeCorrection?.();
    current.status = "correction-pending";
    if (receiptFile) await saveReceipt(receiptFile, current);
    const before = session.messages.length;
    try {
      session.setActiveToolsByName([]);
      if (session.getActiveToolNames().length)
        throw new Error("Format-only protocol correction could not revoke Pi tools.");
      await prompt(options.feedback
        ? options.feedback(failures) : correctionFeedback(contract, failures, options.schema));
      const next = session.messages.slice(before);
      if (next.some(m => m.role === "assistant" &&
          Array.isArray(m.content) && m.content.some(c => c.type === "toolCall")))
        throw new Error("Pi protocol correction attempted a tool; preserve Story files for inspection.");
      if (!next.some(m => m.role === "assistant"))
        throw new Error("Pi protocol correction produced no assistant response; preserve the session for reconciliation.");
    } finally {
      session.setActiveToolsByName(originalTools);
    }
  }
  throw new Error("Unreachable response-contract state.");
}

/** One optional source-bound fresh invocation after the original three complete
 * responses. The authorization is sealed BEFORE opening another Pi session.
 * An interrupted fallback must be reconciled, never silently replayed. */
export async function recoverWithOneFreshSession<T>(options: {
  initial: Parameters<typeof recoverResponseContract<T>>[0];
  receiptFile: string;
  sourceDigest: string;
  fresh: () => Promise<{
    session: ResponseContractSession;
    start: () => Promise<void>;
    prompt: (feedback: string) => Promise<void>;
    beforeCorrection?: () => Promise<void>;
    feedback?: (failures: readonly ResponseContractFailure[]) => string;
    completed?: () => Promise<void>;
    dispose: () => void;
  }>;
}): Promise<T> {
  const firstFile = options.receiptFile + ".initial.json";
  const allowanceFile = options.receiptFile + ".fresh-allowance.json";
  try {
    return await recoverResponseContract({ ...options.initial,
      sourceDigest: options.sourceDigest, receiptFile: firstFile });
  } catch (error) {
    if (!(error instanceof ProtocolExhaustedError)) throw error;
  }
  try {
    await readFile(allowanceFile, "utf8");
    throw new Error("Fresh protocol invocation already authorized; reconcile the preserved session.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const sessionFile = options.initial.session.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("Original protocol invocation has no transcript.");
  const authorization = {
    version: 1, contract: options.initial.contract, sourceDigest: options.sourceDigest,
    originalInvocationId: invocationId(options.initial.contract,
      options.initial.session.sessionId, sessionFile),
    originalSessionId: options.initial.session.sessionId, originalSessionFile: sessionFile,
    freshAllowanceConsumed: true, freshInvocationId: null as string | null,
    freshSessionId: null as string | null,
    freshSessionFile: null as string | null,
  };
  await saveReceipt(allowanceFile, authorization);
  const fresh = await options.fresh();
  try {
    const file = fresh.session.sessionManager.getSessionFile();
    if (!file || file === sessionFile || fresh.session.sessionId === authorization.originalSessionId)
      throw new Error("Fresh protocol recovery must use a separate durable Pi conversation.");
    await saveReceipt(allowanceFile, {
      ...authorization, freshSessionId: fresh.session.sessionId, freshSessionFile: file,
      freshInvocationId: invocationId(options.initial.contract, fresh.session.sessionId, file),
    });
    await fresh.start();
    const result = await recoverResponseContract({
      session: fresh.session, contract: options.initial.contract,
      validate: options.initial.validate, parse: options.initial.parse,
      prompt: fresh.prompt, beforeCorrection: fresh.beforeCorrection,
      feedback: fresh.feedback ?? options.initial.feedback,
      schema: options.initial.schema,
      sourceDigest: options.sourceDigest,
      receiptFile: options.receiptFile + ".fresh.json",
    });
    await fresh.completed?.();
    return result;
  } finally {
    fresh.dispose();
  }
}
