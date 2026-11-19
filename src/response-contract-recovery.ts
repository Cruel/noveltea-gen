import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

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
      "); the Story draft has not been judged defective.");
    this.name = "ProtocolExhaustedError";
  }
}

interface ContractReceipt {
  version: 1;
  contract: string;
  sessionId: string;
  sessionFile: string;
  attempts: number;
  responseHash: string;
  status: "invalid-response" | "correction-pending" | "accepted" | "protocol-exhausted";
  failedPaths: string[];
}

async function saveReceipt(file: string, state: ContractReceipt): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(state) + "\n", { flag: "wx", mode: 0o600 });
  await rename(temp, file);
}

function response(session: ResponseContractSession): string {
  const last = [...session.messages].reverse().find(m => m.role === "assistant");
  if (!last || ["error", "aborted"].includes(last.stopReason ?? "") ||
      !Array.isArray(last.content))
    throw new Error("Pi response did not finish; preserve the original operation for reconciliation.");
  return last.content.filter(c => c.type === "text").map(c => c.text ?? "").join("\n");
}

function correctionFeedback(contract: string, failures: readonly ResponseContractFailure[]): string {
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
    "\nRequired report keys: modifiedRecords, architecturalConflicts, " +
    "laterObligations (each an array of nonempty strings). modifiedRecords " +
    "must be the complete actual cumulative Story-relative changed paths. " +
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
  receiptFile?: string;
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
      version: 1, contract, sessionId: session.sessionId, sessionFile,
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
      await prompt(correctionFeedback(contract, failures));
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
