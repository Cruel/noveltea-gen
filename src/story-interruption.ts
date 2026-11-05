import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { JobStartResult } from "./job.js";
import { activeStoryWriter } from "./job-lock.js";
import { readJobControl } from "./job-control.js";
import { registerPiTurn, settlePiTurn, type ActivePiTurn, type LivePiSession } from "./live-pi-registry.js";

type AbortableSession = Pick<AgentSession, "abort" | "waitForIdle" | "isStreaming"> &
  Partial<Pick<AgentSession, "sessionId" | "sessionManager" | "messages">>;

type Phase = "running" | "completed" | "cooperative-aborted" | "cancelled-at-boundary" |
  "cancellation-unverified" | "abort-unavailable" | "provider-failed";
interface InterruptionReceipt {
  version: 1;
  jobId: string;
  token: string;
  workItem: string;
  pid: number;
  host: string;
  phase: Phase;
  startedAt: string;
  finishedAt?: string;
  expectedHead: string;
  actualHead?: string;
  dirtyFiles?: string[];
  piSessionId?: string;
  piSessionFile?: string;
  error?: string;
  piStopReason?: string;
}
const stateFile = (job: JobStartResult) => join(job.stateDir, "active-specialist.json");
function git(job: JobStartResult, ...args: string[]) {
  const env = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"])
    delete env[name];
  return execFileSync("git", args, { cwd: job.worktreeRoot, encoding: "utf8", env }).trim();
}
async function persist(job: JobStartResult, receipt: InterruptionReceipt) {
  const file = stateFile(job);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + "." + randomUUID() + ".tmp";
  await writeFile(tmp, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await rename(tmp, file);
}

export class StoryCancelledError extends Error {
  constructor(readonly workItem: string) {
    super("Story specialist " + workItem +
      " was cancelled; inspect the persisted session, Git HEAD and uncommitted worktree before reconciliation. " +
      "The job is terminal; no writer was restarted.");
    this.name = "StoryCancelledError";
  }
}

/** Read-only author view. A signal is not proof of termination: a running
 * receipt remains pending until the original owner observes Pi settling. */
export async function inspectActiveStorySpecialist(job: JobStartResult) {
  const file = stateFile(job);
  if (!existsSync(file)) return null;
  const receipt = JSON.parse(await readFile(file, "utf8")) as InterruptionReceipt;
  if (receipt.version !== 1 || receipt.jobId !== job.jobId ||
      !["running", "completed", "cooperative-aborted", "cancelled-at-boundary",
        "cancellation-unverified", "abort-unavailable", "provider-failed"].includes(receipt.phase) ||
      !receipt.token || !receipt.workItem) throw new Error("Corrupt specialist interruption receipt.");
  const control = await readJobControl(job);
  let ownerExited = false;
  if (receipt.phase === "running" && receipt.host === hostname()) {
    try { process.kill(receipt.pid, 0); }
    catch (error) { ownerExited = (error as NodeJS.ErrnoException).code === "ESRCH"; }
  }
  return {
    ...receipt,
    status: ownerExited ? "owner-exited-without-pi-settlement" :
      receipt.phase === "running" && control === "cancelled"
        ? "cancellation-requested-not-yet-settled" : receipt.phase,
    action: ownerExited ? "The writer exited without settling Pi; inspect its archived/stale lock, partial worktree and transcript before manual reconciliation." :
      receipt.phase === "running"
      ? "Wait for cooperative settlement; do not start another writer. If the provider is unresponsive, inspect the live owner and its lock."
      : receipt.phase === "completed" ? null
      : "Inspect the saved Pi session, expected/actual HEAD, dirty files and work-item receipt before any reconciliation. No automatic replay.",
  };
}

/** The async Story writer lease stays held while Pi aborts and until the turn
 * has actually settled. A refusal/hung abort is NOT represented as success.
 * This wrapper also accepts a deterministic fake session for process tests. */
export async function runCancellableStoryTurn<T>(
  session: AbortableSession, run: () => Promise<T>,
): Promise<T> {
  const writer = activeStoryWriter();
  if (!writer?.active) throw new Error("Pi Story specialists require an active Story writer lock.");
  const { job, workItem } = writer;
  const receipt: InterruptionReceipt = {
    version: 1, jobId: job.jobId, token: randomUUID(), workItem,
    pid: process.pid, host: hostname(), phase: "running", startedAt: new Date().toISOString(),
    expectedHead: git(job, "rev-parse", "HEAD"),
    ...(session.sessionId ? { piSessionId: session.sessionId } : {}),
    ...(session.sessionManager?.getSessionFile() ? {
      piSessionFile: session.sessionManager.getSessionFile() ?? undefined,
    } : {}),
  };
  await persist(job, receipt);
  const piTurn: ActivePiTurn | null = session.sessionId &&
    "steer" in session && typeof session.steer === "function" &&
    "followUp" in session && typeof session.followUp === "function" &&
    "messages" in session && Array.isArray(session.messages)
    ? { jobId: job.jobId, token: receipt.token, workItem,
        expectedHead: receipt.expectedHead,
        session: session as LivePiSession } : null;
  const unregister = piTurn ? registerPiTurn(piTurn) : () => {};
  const initialMessageCount = session.messages?.length ?? 0;
  let finished = false, cancelSeen = false, abortError: unknown;
  let checking: Promise<void> | undefined;
  const check = () => {
    if (finished || checking) return;
    checking = (async () => {
      if (await readJobControl(job) !== "cancelled" || finished || cancelSeen) return;
      cancelSeen = true;
      try { await session.abort(); }
      catch (error) { abortError = error; }
    })().catch(error => { abortError = error; cancelSeen = true; })
      .finally(() => { checking = undefined; });
  };
  const timer = setInterval(check, 75);
  let result: T | undefined, failure: unknown;
  try {
    // Catch cancellation arriving between the first check and the first prompt.
    if (await readJobControl(job) === "cancelled") throw new StoryCancelledError(workItem);
    result = await run();
  } catch (error) { failure = error; }
  finally {
    finished = true;
    clearInterval(timer);
    if (checking) await checking;
  }
  // A completed model response is not authorization to commit after cancel.
  const cancelled = cancelSeen || await readJobControl(job) === "cancelled";
  if ((cancelled || failure) && session.isStreaming) {
    // A rejected model request does not prove its shell/tool process is idle.
    // Do not release a writer lease while anything can still write.
    try { await session.waitForIdle(); }
    catch (error) { abortError ??= error; }
  }
  if (session.isStreaming) {
    abortError ??= new Error("Pi remained active after interruption or provider failure.");
  }
  const lastPi = [...(session.messages?.slice(initialMessageCount) ?? [])].reverse().find(m => m.role === "assistant");
  const stopReason = lastPi?.role === "assistant" ? lastPi.stopReason : undefined;
  receipt.finishedAt = new Date().toISOString();
  if (stopReason) receipt.piStopReason = stopReason;
  receipt.phase = abortError ? "abort-unavailable" :
    cancelled && cancelSeen && stopReason === "aborted" ? "cooperative-aborted" :
    cancelled && cancelSeen && stopReason === "error" ? "provider-failed" :
    cancelled && cancelSeen && !stopReason ? "cancellation-unverified" :
    cancelled ? "cancelled-at-boundary" :
    failure ? "provider-failed" : "completed";
  if (failure || abortError) receipt.error = String(abortError ?? failure);
  // Fail closed if reading or persisting interruption evidence fails. A lock
  // cannot be released merely because Pi returned while its record is lost.
  writer.retainLease = true;
  try {
    receipt.actualHead = git(job, "rev-parse", "HEAD");
    receipt.dirtyFiles = git(job, "status", "--porcelain=v1", "--untracked-files=all").split("\n").filter(Boolean);
    await persist(job, receipt);
  } catch (error) {
    unregister();
    throw new Error("Cannot record Story interruption safely; writer lock retained: " + String(error));
  }
  // An unrecorded Pi-steering acknowledgement is ambiguous execution, not
  // proof that the writer can be released or the message replayed elsewhere.
  try {
    if (piTurn) await settlePiTurn(piTurn, !cancelled && !failure && !abortError);
    writer.retainLease = Boolean(abortError);
  } catch {
    // The original turn may have consumed the message even if SQLite could
    // not store its delivery receipt. Neither release this writer nor report
    // success: on restart the message must be inspected, never replayed.
    receipt.phase = "provider-failed";
    receipt.error = "Pi steering acknowledgement could not be persisted; writer lock retained for reconciliation.";
    await persist(job, receipt).catch(() => {});
    throw new Error(receipt.error);
  } finally { unregister(); }
  if (abortError) throw new Error("Pi abort unavailable or provider unresponsive for " + workItem +
    "; writer lock retained for inspection: " + String(abortError));
  if (cancelled) throw new StoryCancelledError(workItem);
  if (failure) throw failure;
  return result as T;
}

/** All real Story Pi turns, including bounded repairs and read-only reviews,
 * use the same cross-process cancellation path. */
export async function promptStorySpecialist(session: AgentSession, text: string): Promise<void> {
  return runCancellableStoryTurn(session, () => session.prompt(text));
}
