import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JobStartResult } from "./job.js";
import { verifyJobPiSession } from "./job-session.js";

export type FoundationConflict = {
  version: 1; jobId: string; baseSha: string; threadId: string; requestSha256: string;
  headSha: string; fileSha256: string; sessionSha256: string; sessionId: string; sessionFile: string;
  target: "creative-direction/foundation.md" | string; explanation: string;
  sourceExcerpt: string;
  digest: string; status: "awaiting-author" | "authorized" | "rejected";
  authorization?: { principal: string; reason: string; at: string; action: "authorized" | "rejected" };
  retryUsed?: boolean;
};
export class FoundationAuthorRequiredError extends Error {
  constructor() {
    super("Foundation requires an explicit author decision before generation can proceed.");
    this.name = "FoundationAuthorRequiredError";
  }
}
const conflictFile = (job: JobStartResult) => join(job.stateDir, "foundation-conflict.json");
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function git(job: JobStartResult, ...args: string[]) {
  const env = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"])
    delete env[name];
  return execFileSync("git", args, { cwd: job.worktreeRoot, env, encoding: "utf8" }).trim();
}
async function persist(job: JobStartResult, value: FoundationConflict) {
  const file = conflictFile(job);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + "." + randomUUID() + ".tmp";
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await rename(tmp, file);
}
async function readSaved(job: JobStartResult): Promise<FoundationConflict | null> {
  const file = conflictFile(job);
  if (!existsSync(file)) return null;
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384)
    throw new Error("Invalid Foundation conflict receipt");
  const value = JSON.parse(await readFile(file, "utf8")) as FoundationConflict;
  if (value.version !== 1 || value.jobId !== job.jobId || value.threadId !== job.threadId ||
      value.baseSha !== job.baseSha || value.headSha !== job.baseSha ||
      !/^creative-direction\/[A-Za-z0-9._-]+\.md$/.test(value.target) ||
      !["awaiting-author","authorized","rejected"].includes(value.status) ||
      !/^[a-f0-9]{64}$/.test(value.digest) ||
      typeof value.sourceExcerpt !== "string" || value.sourceExcerpt.length > 12000 ||
      sha(JSON.stringify({ jobId: value.jobId, headSha: value.headSha, requestSha256: value.requestSha256,
        fileSha256: value.fileSha256, sessionSha256: value.sessionSha256, sessionId: value.sessionId,
        explanation: value.explanation, sourceExcerpt: value.sourceExcerpt })) !== value.digest ||
      (value.status !== "awaiting-author" && (!value.authorization ||
        !/^user:[A-Za-z0-9_-]{1,128}$/.test(value.authorization.principal)))) {
    throw new Error("Foundation conflict receipt was changed or is inconsistent.");
  }
  return value;
}
async function validateEvidence(job: JobStartResult) {
  const source = join(job.stateDir, "foundation.json");
  const ownerFile = join(job.stateDir, "generation-server-owner.json");
  const activeFile = join(job.stateDir, "active-specialist.json");
  if (![source, ownerFile, activeFile].every(existsSync)) return null;
  const state = JSON.parse(await readFile(source, "utf8")) as {
    stage?: string; writerStarted?: boolean; target?: string; authoredSha256?: string;
    piSessionId?: string; piSessionFile?: string; baseSha?: string;
  };
  const owner = JSON.parse(await readFile(ownerFile, "utf8")) as { jobId?: string; requestSha256?: string };
  const active = JSON.parse(await readFile(activeFile, "utf8")) as {
    jobId?: string; phase?: string; workItem?: string; expectedHead?: string; actualHead?: string;
    dirtyFiles?: string[]; piStopReason?: string; piSessionId?: string; piSessionFile?: string;
  };
  if (state.stage !== "writing" || !state.writerStarted || state.authoredSha256 ||
      state.baseSha !== job.baseSha || !/^creative-direction\/[A-Za-z0-9._-]+\.md$/.test(state.target ?? "") ||
      owner.jobId !== job.jobId || !/^[a-f0-9]{64}$/.test(owner.requestSha256 ?? "") ||
      active.jobId !== job.jobId || active.phase !== "completed" || active.workItem !== "foundation" ||
      active.expectedHead !== job.baseSha || active.actualHead !== job.baseSha ||
      active.piStopReason !== "stop" || active.dirtyFiles?.length !== 0 ||
      state.piSessionId !== active.piSessionId || state.piSessionFile !== active.piSessionFile ||
      git(job, "rev-parse", "HEAD") !== job.baseSha ||
      git(job, "status", "--porcelain=v1", "--untracked-files=all")) return null;
  await verifyJobPiSession(job, "foundation", state.piSessionFile, state.piSessionId);
  const sessionText = await readFile(state.piSessionFile!, "utf8");
  const entries = sessionText.trim().split("\n").map(line => JSON.parse(line) as {
    type?: string; message?: { role?: string; stopReason?: string; content?: Array<{
      type?: string; name?: string; text?: string }> };
  });
  const last = entries.at(-1)?.message;
  if (last?.role !== "assistant" || last.stopReason !== "stop") return null;
  // A successful shell/write/edit tool could have had side effects outside the
  // current Git diff. Never allow a convenient clean checkout to erase them.
  if (entries.some(entry => entry.message?.role === "assistant" &&
      entry.message.content?.some(c => c.type === "toolCall" &&
        ["bash", "exec", "write", "edit"].includes(c.name ?? "")))) return null;
  const explanation = (last.content ?? []).filter(c => c.type === "text")
    .map(c => c.text ?? "").join("\n").trim().slice(0, 1500);
  if (!explanation || !/protected|authoriz|approval/i.test(explanation)) return null;
  const target = join(job.worktreeStoryRoot, state.target!);
  const sourceBytes = await readFile(target);
  // The source is the unchanged Git baseline, never the model's proposed edit.
  // A human reviews source bytes bound by the whole-file SHA; canonical native
  // validation is still mandatory for any subsequent actual writing.
  const sourceExcerpt = sourceBytes.toString("utf8").slice(0, 9000);
  if (!sourceExcerpt.includes("user-protected")) return null;
  const binding = { jobId: job.jobId, headSha: job.baseSha, requestSha256: owner.requestSha256!,
    fileSha256: sha(sourceBytes), sessionSha256: sha(sessionText), sessionId: state.piSessionId!,
    explanation, sourceExcerpt };
  return { binding, state, sessionFile: state.piSessionFile! };
}

/** Read-only preview includes legacy jobs blocked before this handoff existed. */
export async function inspectFoundationConflict(job: JobStartResult): Promise<FoundationConflict | null> {
  const existing = await readSaved(job);
  if (existing) return existing;
  const evidence = await validateEvidence(job);
  if (!evidence) return null;
  return {
    version: 1, ...evidence.binding, baseSha: job.baseSha, threadId: job.threadId,
    target: evidence.state.target!, sessionFile: evidence.sessionFile,
    digest: sha(JSON.stringify(evidence.binding)), status: "awaiting-author",
  };
}

/** Persist a deterministic request only after a completed, clean Pi refusal. */
export async function recordFoundationConflict(job: JobStartResult) {
  const preview = await inspectFoundationConflict(job);
  if (!preview) return null;
  if (!existsSync(conflictFile(job))) await persist(job, preview);
  return readSaved(job);
}
export async function decideFoundationConflict(job: JobStartResult, action: "approve" | "reject",
  digest: string, reason: string, principal: string) {
  if (!/^user:[A-Za-z0-9_-]{1,128}$/.test(principal) || reason.length > 1000)
    throw new Error("An authenticated author and substantive rationale are required.");
  const evidence = await validateEvidence(job);
  const preview = await inspectFoundationConflict(job);
  if (!preview || !evidence || digest !== preview.digest ||
      digest !== sha(JSON.stringify(evidence.binding))) throw new Error("Stale or unsafe Foundation authorization.");
  const previous = await readSaved(job);
  if (!previous) await persist(job, preview);
  else if (previous.status !== "awaiting-author") throw new Error("Foundation decision already recorded.");
  const updated: FoundationConflict = { ...preview, status: action === "approve" ? "authorized" : "rejected",
    authorization: { principal, reason: reason.trim(), at: new Date().toISOString(),
      action: action === "approve" ? "authorized" : "rejected" } };
  await persist(job, updated);
  return updated;
}
/** A job-specific exception authorizes continuing the pinned task, not changing
 * or deleting any protected Story decision. No arbitrary model payload is consent. */
export async function authorizedFoundationException(job: JobStartResult): Promise<FoundationConflict | null> {
  const receipt = await readSaved(job);
  if (receipt?.status !== "authorized" || !receipt.authorization) return null;
  if (git(job, "rev-parse", "HEAD") !== receipt.headSha ||
      git(job, "status", "--porcelain=v1", "--untracked-files=all") ||
      sha(await readFile(join(job.worktreeStoryRoot, receipt.target))) !== receipt.fileSha256)
    return null;
  const owner = JSON.parse(await readFile(join(job.stateDir, "generation-server-owner.json"), "utf8")) as {
    requestSha256?: string; jobId?: string;
  };
  if (owner.jobId !== job.jobId || owner.requestSha256 !== receipt.requestSha256 ||
      sha(await readFile(receipt.sessionFile)) !== receipt.sessionSha256)
    return null;
  return receipt;
}
/** An authenticated exception remains narrowly scoped to the exact job and
 * originally protected text in later specialist prompts. It never authorizes
 * changing that protected text or bypassing canonical validator approvals. */
export async function foundationExceptionContext(job: JobStartResult): Promise<string> {
  const receipt = await readSaved(job);
  if (receipt?.status !== "authorized" || !receipt.authorization) return "";
  const owner = JSON.parse(await readFile(join(job.stateDir, "generation-server-owner.json"), "utf8")) as {
    jobId?: string; requestSha256?: string;
  };
  if (owner.jobId !== job.jobId || owner.requestSha256 !== receipt.requestSha256 ||
      sha(await readFile(receipt.sessionFile)) !== receipt.sessionSha256) return "";
  try { git(job, "merge-base", "--is-ancestor", receipt.headSha, "HEAD"); }
  catch { return ""; }
  const tracked = job.storyRelativePath ? job.storyRelativePath + "/" + receipt.target : receipt.target;
  const original = execFileSync("git", ["show", receipt.headSha + ":" + tracked],
    { cwd: job.worktreeRoot, stdio: ["ignore", "pipe", "ignore"] });
  if (sha(original) !== receipt.fileSha256) return "";
  return "AUTHENTICATED JOB-SCOPED AUTHOR EXCEPTION: For this exact pinned generation task, " +
    "the author expressly permitted full composition notwithstanding the following original " +
    "discovery/preflight-only restriction(s): " +
    "Creative Direction SHA-256 " + receipt.fileSha256 +
    ". The authenticated author exception is restricted to the original file hash and job." +
    (receipt.authorization.reason ? " Additional author direction: " + receipt.authorization.reason + "." : "") +
    " Keep all original user-protected decision statements verbatim. This exception does not " +
    "grant permission to modify, delete, or weaken those decisions; the separate exact-change " +
    "trusted approval process remains mandatory.\n\n";
}
/** Only explicitly approved and unused clean no-write attempts can be retried. */
export async function consumeFoundationRetry(job: JobStartResult): Promise<FoundationConflict | null> {
  const receipt = await authorizedFoundationException(job);
  if (!receipt) return null;
  if (receipt.retryUsed) {
    // Recover a crash after marking the retry but before replacing the old
    // writerStarted receipt. Never reissue once a new Pi turn has begun.
    const old = await validateEvidence(job);
    return old?.sessionFile === receipt.sessionFile ? receipt : null;
  }
  await persist(job, { ...receipt, retryUsed: true });
  return readSaved(job);
}
