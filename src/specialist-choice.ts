import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { JobStartResult } from "./job.js";
import { verifyJobPiSession } from "./job-session.js";

export interface SpecialistChoiceOption {
  id: string;
  title: string;
  approach: string;
  benefits: string;
  tradeoffs: string;
}
export interface SpecialistChoiceQuestion {
  question: string;
  options: SpecialistChoiceOption[];
  recommendedId: string;
  recommendationReason: string;
}
export type SpecialistChoiceAnswer =
  | { kind: "option"; optionId: string; note: string }
  | { kind: "custom"; text: string; note: string };
export interface SpecialistChoiceReceipt {
  version: 1;
  id: string; jobId: string; threadId: string; workItem: string;
  phase: "awaiting-author" | "answered" | "resuming" | "consumed";
  headSha: string; worktreeDigest: string; sessionId: string; sessionFile: string;
  sessionSha256: string; question: SpecialistChoiceQuestion; proposalSha256: string;
  answer?: SpecialistChoiceAnswer & { principal: string; submittedAt: string };
}
export class SpecialistChoiceRequiredError extends Error {
  constructor() {
    super("Specialist paused for an author choice. Review 2–4 options or supply your own direction in Author questions and approvals.");
    this.name = "SpecialistChoiceRequiredError";
  }
}
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const ID = /^[a-z][a-z0-9]*(?:[a-z0-9-]*[a-z0-9])?$/;
const file = (job: JobStartResult, id: string) => join(job.stateDir, "specialist-choices", id + ".json");
function git(job: JobStartResult, ...args: string[]) {
  const env = { ...process.env };
  for (const name of ["GIT_DIR","GIT_WORK_TREE","GIT_INDEX_FILE","GIT_COMMON_DIR","GIT_PREFIX"]) delete env[name];
  return execFileSync("git", args, { cwd: job.worktreeRoot, env, encoding: "utf8" });
}
/** Only allow self-contained, meaningful alternatives, not a generic failure
 * converted into a fake author question. Enforced for every specialist. */
export function parseSpecialistChoice(value: unknown): SpecialistChoiceQuestion {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid author-choice request.");
  const q = value as Record<string, unknown>;
  if (Object.keys(q).sort().join(",") !==
      "options,question,recommendationReason,recommendedId" ||
      typeof q.question !== "string" || q.question.trim().length < 15 || q.question.length > 1500 ||
      typeof q.recommendationReason !== "string" || q.recommendationReason.trim().length < 15 ||
      q.recommendationReason.length > 1200 ||
      typeof q.recommendedId !== "string" ||
      !Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4)
    throw Error("An author choice requires 2–4 explained alternatives and one reasoned recommendation.");
  const ids = new Set<string>();
  const options: SpecialistChoiceOption[] = q.options.map((raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("Invalid author-choice alternative.");
    const o = raw as Record<string, unknown>;
    if (Object.keys(o).sort().join(",") !== "approach,benefits,id,title,tradeoffs" ||
        typeof o.id !== "string" || !ID.test(o.id) || o.id.length > 40 || ids.has(o.id) ||
        ["title", "approach", "benefits", "tradeoffs"].some(k =>
          typeof o[k] !== "string" || !(o[k] as string).trim() ||
          (o[k] as string).length > (k === "title" ? 160 : 700)))
      throw Error("Author alternatives need unique IDs, an approach, benefits and trade-offs.");
    ids.add(o.id);
    return { id: o.id, title: o.title as string, approach: o.approach as string,
      benefits: o.benefits as string, tradeoffs: o.tradeoffs as string };
  });
  if (!ids.has(q.recommendedId)) throw Error("Recommended solution must be one of the offered alternatives.");
  return { question: q.question, options, recommendedId: q.recommendedId,
    recommendationReason: q.recommendationReason };
}
/** Recover a structured author request even when Pi formats the final JSON
 * across lines or in a Markdown code fence. Never parse tool output or allow
 * prose to substitute for a complete, validated object. */
export function extractSpecialistChoice(text: string):
  { authorDecisionRequest: unknown; modifiedRecords?: unknown } | null {
  const marker = '"authorDecisionRequest"';
  let near = text.lastIndexOf(marker);
  if (near < 0) return null;
  while (near >= 0) {
    const start = text.lastIndexOf("{", near);
    if (start < 0) break;
    let depth = 0, quoted = false, escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i]!;
      if (quoted) {
        if (escaped) escaped = false;
        else if (ch === "\\\\") escaped = true;
        else if (ch === '"') quoted = false;
      } else if (ch === '"') quoted = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try {
          const value: unknown = JSON.parse(text.slice(start, i + 1));
          if (value && typeof value === "object" && !Array.isArray(value) &&
              "authorDecisionRequest" in value)
            return value as { authorDecisionRequest: unknown; modifiedRecords?: unknown };
        } catch { /* Try a surrounding JSON object instead. */ }
        break;
      }
    }
    near = start - 1;
  }
  throw Error("Specialist attempted an author-choice handoff without complete valid JSON.");
}
/** Snapshot any unfinished work. A question itself is never permission to
 * bypass validation or discard changes; all bytes must remain identical. */
async function evidence(job: JobStartResult) {
  const head = git(job, "rev-parse", "HEAD").trim();
  if (git(job, "symbolic-ref", "--short", "HEAD").trim() !== job.branch) throw Error("Specialist choice branch drift.");
  const changes = git(job, "status", "--porcelain=v1", "-z", "--untracked-files=all")
    .split("\0").filter(Boolean).sort();
  if (changes.length > 64 || changes.some(s => !["??", " M"].includes(s.slice(0, 2))))
    throw Error("Specialist choice cannot suspend with unsafe staged/renamed/deleted files.");
  let total = 0;
  const versions: Array<{ status: string; path: string; sha256: string }> = [];
  for (const change of changes) {
    const name = change.slice(3), full = resolve(job.worktreeRoot, name);
    if (isAbsolute(name) || name.includes("\\\\") || name.split("/").some(s => !s || s === "." || s === "..") ||
        relative(job.worktreeStoryRoot, full).startsWith(".."+sep) ||
        relative(job.worktreeStoryRoot, full) === "..")
      throw Error("Specialist choice has an unowned path.");
    const stat = await lstat(full);
    total += stat.size;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2_000_000 ||
        total > 8_000_000 || await realpath(full) !== full)
      throw Error("Specialist choice contains unsafe or oversized file.");
    versions.push({ status: change.slice(0, 2), path: name, sha256: sha(await readFile(full)) });
  }
  return { head, digest: sha(JSON.stringify({ head, versions })) };
}
async function safeRead(job: JobStartResult, id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("Invalid specialist-choice ID.");
  const path = file(job, id);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 24000)
    throw Error("Unsafe specialist-choice receipt.");
  const r = JSON.parse(await readFile(path, "utf8")) as SpecialistChoiceReceipt;
  if (r.version !== 1 || r.id !== id || r.jobId !== job.jobId || r.threadId !== job.threadId ||
      !ID.test(r.workItem) || !["awaiting-author","answered","resuming","consumed"].includes(r.phase) ||
      !/^[a-f0-9]{64}$/.test(r.worktreeDigest) ||
      !/^[a-f0-9]{64}$/.test(r.sessionSha256) ||
      !/^[a-f0-9]{64}$/.test(r.proposalSha256) ||
      sha(JSON.stringify({ jobId: r.jobId, workItem: r.workItem, headSha: r.headSha,
        worktreeDigest: r.worktreeDigest, sessionId: r.sessionId,
        sessionSha256: r.sessionSha256, question: parseSpecialistChoice(r.question) })) !== r.proposalSha256)
    throw Error("Specialist-choice receipt is inconsistent or modified.");
  if (r.phase !== "awaiting-author" && (!r.answer ||
      !/^user:[A-Za-z0-9_-]{1,128}$/.test(r.answer.principal)))
    throw Error("A resolved choice has no authenticated author answer.");
  return r;
}
async function save(job: JobStartResult, r: SpecialistChoiceReceipt) {
  const dir = join(job.stateDir, "specialist-choices");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = file(job, r.id), temp = target + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(r, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await rename(temp, target);
}
export async function recordSpecialistChoice(job: JobStartResult, workItem: string,
  question: SpecialistChoiceQuestion, sessionId: string, sessionFile: string) {
  const q = parseSpecialistChoice(question);
  if (!ID.test(workItem)) throw Error("Invalid specialist choice work item.");
  const kind = workItem === "world-foundations" ? "world" : workItem === "character-foundations" ? "character" : null;
  if (!kind) throw Error("Specialist choice work-item session binding is not configured.");
  await verifyJobPiSession(job, kind, sessionFile, sessionId);
  const { head, digest } = await evidence(job);
  const transcriptHash = sha(await readFile(sessionFile));
  const immutable = { jobId: job.jobId, workItem, headSha: head, worktreeDigest: digest,
    sessionId, sessionSha256: transcriptHash, question: q };
  const r: SpecialistChoiceReceipt = {
    version: 1, id: randomUUID(), threadId: job.threadId, ...immutable,
    sessionFile, phase: "awaiting-author", proposalSha256: sha(JSON.stringify(immutable)),
  };
  await save(job, r);
  return r;
}
export async function inspectSpecialistChoice(job: JobStartResult, id: string) {
  return safeRead(job, id);
}
/** A single shared author panel reads the currently waiting specialist rather
 * than accepting an arbitrary controller-supplied receipt path. */
export async function activeSpecialistChoice(job: JobStartResult) {
  const path = join(job.stateDir, "character-world.json");
  if (!existsSync(path)) return null;
  const st = await lstat(path);
  if (!st.isFile() || st.isSymbolicLink() || st.size > 200_000)
    throw Error("Invalid specialist state.");
  const state = JSON.parse(await readFile(path, "utf8")) as {
    jobId?: string; threadId?: string;
    units?: Array<{ id?: string; phase?: string; authorChoiceId?: string }>;
  };
  if (state.jobId !== job.jobId || (state.threadId && state.threadId !== job.threadId) ||
      !Array.isArray(state.units)) throw Error("Specialist state belongs to another job.");
  const waiting = state.units.filter(u => u.phase === "awaiting-author");
  if (!waiting.length) return null;
  if (waiting.length !== 1 || !waiting[0]?.authorChoiceId ||
      waiting[0]?.id !== "character-foundations" && waiting[0]?.id !== "world-foundations")
    throw Error("Ambiguous specialist author-choice state.");
  const receipt = await safeRead(job, waiting[0].authorChoiceId);
  if (receipt.workItem !== waiting[0].id ||
      !["awaiting-author", "answered"].includes(receipt.phase))
    throw Error("Specialist author-choice state and saved receipt differ.");
  return receipt;
}
export async function verifySpecialistChoice(job: JobStartResult, id: string,
  phase: "awaiting-author" | "answered") {
  const r = await safeRead(job, id);
  if (r.phase !== phase) throw Error("Specialist choice is not at the required author boundary.");
  const { head, digest } = await evidence(job);
  if (head !== r.headSha || digest !== r.worktreeDigest)
    throw Error("Uncommitted draft changed after the specialist asked; reconcile it before proceeding.");
  await verifyJobPiSession(job, r.workItem === "world-foundations" ? "world" : "character",
    r.sessionFile, r.sessionId);
  if (sha(await readFile(r.sessionFile)) !== r.sessionSha256)
    throw Error("Original Pi session changed since the author question; refuse replay.");
  return r;
}
/** Caller must authenticate author and hold the Story job lock. */
export async function answerSpecialistChoice(job: JobStartResult, id: string, proposalSha256: string,
  answer: SpecialistChoiceAnswer, principal: string) {
  if (!/^user:[A-Za-z0-9_-]{1,128}$/.test(principal)) throw Error("Author identity required.");
  const r = await verifySpecialistChoice(job, id, "awaiting-author");
  if (r.proposalSha256 !== proposalSha256 || !answer || !["option", "custom"].includes(answer.kind) ||
      typeof answer.note !== "string" || answer.note.length > 1000 ||
      (answer.kind === "option" && (!r.question.options.some(o => o.id === answer.optionId) ||
        Object.keys(answer).sort().join(",") !== "kind,note,optionId")) ||
      (answer.kind === "custom" && (typeof answer.text !== "string" ||
        !answer.text.trim() || answer.text.length > 4000 ||
        Object.keys(answer).sort().join(",") !== "kind,note,text")))
    throw Error("Invalid or stale author choice.");
  const updated: SpecialistChoiceReceipt = { ...r, phase: "answered",
    answer: { ...answer, principal, submittedAt: new Date().toISOString() } };
  await save(job, updated);
  return updated;
}
/** Mark a single answered turn as claimed before invoking the model. A crash
 * after this fence is MANUAL recovery; no repeated external writer calls. */
export async function claimSpecialistChoice(job: JobStartResult, id: string) {
  const r = await verifySpecialistChoice(job, id, "answered");
  await save(job, { ...r, phase: "resuming" });
  return r;
}
export async function completeSpecialistChoice(job: JobStartResult, id: string) {
  const r = await safeRead(job, id);
  if (r.phase !== "resuming") throw Error("Specialist choice was not being resumed.");
  await save(job, { ...r, phase: "consumed" });
}
