import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { JobStartResult } from "./job.js";
import { authorizedFoundationException } from "./foundation-conflict.js";
import { nativeValidate } from "./native-validator.js";
import { nativeExecutable, type NativeValidatorPin } from "./validator.js";

const HASH = /^[a-f0-9]{64}$/;
const SHA = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const path = (job: JobStartResult, name: string) => join(job.stateDir, name);
const AUDIT = "validator-upgrade.json";
type Candidate = { version: 1; jobId: string; threadId: string; baseSha: string;
  headSha: string; conflictDigest: string; previous: NativeValidatorPin;
  replacement: NativeValidatorPin; validationDigest: string;
  diagnostics: number; proposalSha256: string };
type Receipt = Candidate & { phase: "approved" | "committed";
  principal: string; rationale: string; authorizedAt: string; committedAt?: string };

function git(job: JobStartResult, ...args: string[]) {
  const env = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"]) delete env[name];
  return execFileSync("git", args, { cwd: job.worktreeRoot, env, encoding: "utf8" }).trim();
}
async function json(file: string): Promise<Record<string, unknown>> {
  const st = await lstat(file);
  if (!st.isFile() || st.isSymbolicLink() || st.size > 128 * 1024)
    throw Error("Invalid validator identity artifact.");
  const value = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid validator identity artifact.");
  return value;
}
async function atomic(file: string, value: unknown) {
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temp, file);
  } finally { await rm(temp, { force: true }); }
}
function native(value: unknown): value is NativeValidatorPin {
  const p = value as Partial<NativeValidatorPin> | null;
  return !!p && p.contract === "noveltea-validator/v1" && p.implementation === "native-cli" &&
    typeof p.executable === "string" && isAbsolute(p.executable) && HASH.test(p.sha256 ?? "");
}
async function identity(job: JobStartResult) {
  const manifest = await json(path(job, "job.json"));
  const saved = await json(path(job, "validator.json"));
  if (!native(saved) || manifest.jobId !== job.jobId ||
      manifest.threadId !== job.threadId || manifest.baseSha !== job.baseSha ||
      manifest.branch !== job.branch || manifest.worktreeRoot !== job.worktreeRoot ||
      manifest.validatorSha256 !== saved.sha256 ||
      job.validatorSha256 !== saved.sha256)
    throw Error("Job manifest and pinned validator receipt differ; an operator must reconcile them.");
  return { manifest, previous: saved };
}
async function currentCandidate() {
  const executable = await realpath(nativeExecutable());
  const st = await lstat(executable);
  if (!st.isFile() || st.isSymbolicLink()) throw Error("Replacement validator must be a regular trusted executable.");
  const sha256 = SHA(await readFile(executable));
  return { contract: "noveltea-validator/v1" as const, implementation: "native-cli" as const,
    executable, sha256 };
}
function proposalDigest(candidate: Omit<Candidate, "proposalSha256">) {
  return SHA(JSON.stringify(candidate));
}
function validateReceipt(value: Record<string, unknown>, job: JobStartResult): Receipt {
  const r = value as unknown as Receipt;
  const { proposalSha256: digest, ...proposal } = r;
  const immutable = { version: proposal.version, jobId: proposal.jobId, threadId: proposal.threadId,
    baseSha: proposal.baseSha, headSha: proposal.headSha, conflictDigest: proposal.conflictDigest,
    previous: proposal.previous, replacement: proposal.replacement, validationDigest: proposal.validationDigest,
    diagnostics: proposal.diagnostics };
  if (r.version !== 1 || r.jobId !== job.jobId || r.threadId !== job.threadId ||
      r.baseSha !== job.baseSha || !HASH.test(r.conflictDigest) ||
      !native(r.previous) || !native(r.replacement) || !HASH.test(r.validationDigest) ||
      r.diagnostics !== 0 || r.proposalSha256 !== proposalDigest(immutable) ||
      !["approved", "committed"].includes(r.phase) ||
      !/^user:[A-Za-z0-9_-]{1,128}$/.test(r.principal) ||
      typeof r.rationale !== "string" || r.rationale.length > 1000 ||
      typeof r.authorizedAt !== "string")
    throw Error("Validator upgrade journal identity or authorization is corrupt.");
  return r;
}
async function journal(job: JobStartResult): Promise<Receipt | null> {
  const f = path(job, AUDIT);
  return existsSync(f) ? validateReceipt(await json(f), job) : null;
}
/** Only the clean, completed Foundation refusal with the author's exact
 * authorization permits replacing a missing validator. Later committed stages
 * require a separate history-aware migration, never a silent repin. */
async function safeBoundary(job: JobStartResult) {
  const conflict = await authorizedFoundationException(job);
  if (!conflict || conflict.retryUsed || git(job, "rev-parse", "HEAD") !== job.baseSha ||
      git(job, "status", "--porcelain=v1", "--untracked-files=all") ||
      existsSync(path(job, "revisions/verified-head.json")))
    throw Error("Validator changes require a clean, authorized no-write Foundation boundary.");
  return conflict;
}
async function candidate(job: JobStartResult): Promise<Candidate | null> {
  const conflict = await safeBoundary(job);
  const { previous } = await identity(job);
  const replacement = await currentCandidate();
  if (replacement.sha256 === previous.sha256 && replacement.executable === previous.executable)
    return null;
  const before = SHA(await readFile(replacement.executable));
  const validation = nativeValidate(job, replacement);
  const after = SHA(await readFile(replacement.executable));
  if (before !== replacement.sha256 || after !== replacement.sha256)
    throw Error("Replacement validator changed during preflight.");
  if (validation.status !== "passed" || validation.report?.protection == null ||
      (validation.report.protection as { status?: string }).status !== "checked" ||
      (validation.report?.diagnostics as unknown[] | undefined)?.length !== 0)
    throw Error("Replacement validator does not pass the unchanged Story: " +
      (validation.error ?? validation.status));
  const immutable = {
    version: 1 as const, jobId: job.jobId, threadId: job.threadId, baseSha: job.baseSha,
    headSha: job.baseSha, conflictDigest: conflict.digest, previous, replacement,
    validationDigest: SHA(JSON.stringify(validation.report)), diagnostics: 0,
  };
  return { ...immutable, proposalSha256: proposalDigest(immutable) };
}
export async function inspectValidatorUpgrade(job: JobStartResult) {
  const saved = await journal(job);
  if (saved) return { proposal: saved, phase: saved.phase };
  const preview = await candidate(job);
  return { proposal: preview, phase: preview ? "review-required" as const : "unchanged" as const };
}
/** Controller-only; caller MUST hold the per-Story writer lock and verify
 * queue is idle, job ownership and same-origin authentication before invoking.
 * Journal is written before both identity files; an interrupted publication
 * remains inspectable and can only be completed for the same approved digest. */
export async function approveValidatorUpgrade(job: JobStartResult,
  digest: string, rationale: string, principal: string): Promise<Receipt> {
  if (!HASH.test(digest) || !/^user:[A-Za-z0-9_-]{1,128}$/.test(principal) ||
      rationale.length > 1000)
    throw Error("Explicit authenticated validator upgrade approval required.");
  let saved = await journal(job);
  if (saved) {
    if (saved.proposalSha256 !== digest || saved.principal !== principal ||
        saved.rationale !== rationale.trim() || saved.phase === "committed")
      throw Error("A different validator migration is already authorized or completed.");
  } else {
    const preview = await candidate(job);
    if (!preview || preview.proposalSha256 !== digest)
      throw Error("Validator proposal changed or is no longer safe. Review the latest preview.");
    saved = { ...preview, phase: "approved", principal, rationale: rationale.trim(),
      authorizedAt: new Date().toISOString() };
    await atomic(path(job, AUDIT), saved);
  }
  // Recovery after a partial two-file publication only accepts the two
  // original hashes and the exact controller-authorized replacement.
  await safeBoundary(job);
  const old = await json(path(job, "validator.json"));
  const manifest = await json(path(job, "job.json"));
  if (!native(old) || ![saved.previous.sha256, saved.replacement.sha256].includes(old.sha256) ||
      ![saved.previous.sha256, saved.replacement.sha256].includes(String(manifest.validatorSha256)) ||
      manifest.jobId !== job.jobId || manifest.threadId !== job.threadId ||
      manifest.baseSha !== job.baseSha || manifest.branch !== job.branch ||
      manifest.worktreeRoot !== job.worktreeRoot)
    throw Error("Partial validator migration has unexpected job or receipt bytes. Do not replay.");
  const current = await currentCandidate();
  if (current.sha256 !== saved.replacement.sha256 ||
      current.executable !== saved.replacement.executable)
    throw Error("Approved replacement executable changed. Restore its exact bytes.");
  const result = nativeValidate(job, current);
  if (result.status !== "passed" ||
      SHA(JSON.stringify(result.report)) !== saved.validationDigest ||
      SHA(await readFile(current.executable)) !== current.sha256)
    throw Error("Replacement validator output differs from the approved preflight. Do not repin.");
  if (old.sha256 !== current.sha256) await atomic(path(job, "validator.json"), current);
  if (manifest.validatorSha256 !== current.sha256)
    await atomic(path(job, "job.json"), { ...manifest, validatorSha256: current.sha256 });
  saved = { ...saved, phase: "committed", committedAt: new Date().toISOString() };
  await atomic(path(job, AUDIT), saved);
  return saved;
}
