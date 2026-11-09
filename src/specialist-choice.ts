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
  /** Omitted in existing persisted multi-alternative receipts. */
  kind?: "free-text" | "yes-no" | "alternatives";
  question: string;
  options?: SpecialistChoiceOption[];
  recommendedId?: string;
  recommendationReason?: string;
  context?: Array<{ path: string; line: number; description: string }>;
}
export function specialistChoiceKind(q: SpecialistChoiceQuestion) {
  return q.kind ?? "alternatives";
}
export function specialistChoiceOptions(q: SpecialistChoiceQuestion): SpecialistChoiceOption[] {
  if (specialistChoiceKind(q) === "yes-no") return [
    { id: "yes", title: "Yes", approach: "", benefits: "", tradeoffs: "" },
    { id: "no", title: "No", approach: "", benefits: "", tradeoffs: "" },
  ];
  return q.options ?? [];
}
export function authorChoiceDirection(q: SpecialistChoiceQuestion, answer: SpecialistChoiceAnswer): string {
  if (answer.kind === "custom") return answer.text + (answer.note ? "\nAdditional guidance: " + answer.note : "");
  const selected = specialistChoiceOptions(q).find(o => o.id === answer.optionId);
  if (!selected) throw Error("Stored author answer no longer matches the exact options.");
  return JSON.stringify({ id: selected.id, title: selected.title, approach: selected.approach }) +
    (answer.note ? "\nAdditional guidance: " + answer.note : "");
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
    super("Specialist paused for an author choice. Respond in Chat or Author questions and approvals.");
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
  const kind = q.kind ?? "alternatives";
  if (!["free-text", "yes-no", "alternatives"].includes(String(kind)) ||
      typeof q.question !== "string" || q.question.trim().length < 10 || q.question.length > 1500 ||
      Object.keys(q).some(key => !["kind", "question", "options", "recommendedId",
        "recommendationReason", "context"].includes(key)))
    throw Error("Invalid bounded author question.");
  if (q.context !== undefined && (!Array.isArray(q.context) || q.context.length > 8 ||
      q.context.some(ref => !ref || typeof ref !== "object" ||
        Object.keys(ref).sort().join(",") !== "description,line,path" ||
        typeof ref.path !== "string" ||
        !/^[a-z][a-z0-9-]*\/[a-z0-9._-]+\.md$/.test(ref.path) ||
        !Number.isSafeInteger(ref.line) || ref.line < 1 || ref.line > 100000 ||
        typeof ref.description !== "string" || !ref.description.trim() || ref.description.length > 400)))
    throw Error("Author choice context references must be bounded canonical Story locations.");
  if (kind === "free-text" && (q.options !== undefined ||
      q.recommendedId !== undefined || q.recommendationReason !== undefined))
    throw Error("A free-text question cannot force suggested alternatives.");
  if (kind === "yes-no" && (q.options !== undefined ||
      q.recommendedId !== undefined && !["yes", "no"].includes(String(q.recommendedId))))
    throw Error("A Yes/No question has fixed Yes/No/Other choices.");
  if (kind !== "alternatives") {
    if (q.recommendationReason !== undefined &&
        (typeof q.recommendationReason !== "string" ||
          !q.recommendationReason.trim() || q.recommendationReason.length > 1200))
      throw Error("Invalid author-choice recommendation.");
    return { kind: kind as "free-text" | "yes-no", question: q.question,
      ...(q.recommendedId !== undefined ? { recommendedId: q.recommendedId as string } : {}),
      ...(q.recommendationReason !== undefined ? { recommendationReason: q.recommendationReason as string } : {}),
      ...(q.context !== undefined ? { context: q.context as SpecialistChoiceQuestion["context"] } : {}) };
  }
  if (typeof q.recommendationReason !== "string" || q.recommendationReason.trim().length < 15 ||
      q.recommendationReason.length > 1200 || typeof q.recommendedId !== "string" ||
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
  return { ...(q.kind !== undefined ? { kind: "alternatives" as const } : {}),
    question: q.question, options, recommendedId: q.recommendedId as string,
    recommendationReason: q.recommendationReason as string,
    ...(q.context !== undefined ? { context: q.context as SpecialistChoiceQuestion["context"] } : {}) };
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
async function verifyChoiceSession(job: JobStartResult, workItem: string,
  sessionFile: string, sessionId: string) {
  if (workItem === "world-foundations" || workItem === "character-foundations")
    return verifyJobPiSession(job, workItem === "world-foundations" ? "world" : "character",
      sessionFile, sessionId);
  if (/^event-[a-z][a-z0-9-]*$/.test(workItem))
    return verifyJobPiSession(job, "event", sessionFile, sessionId, workItem);
  throw Error("Specialist choice work-item session binding is not configured.");
}
async function readSpecialistState(job: JobStartResult, path: string) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 200_000)
    throw Error("Unsafe specialist work-item state.");
  const state = JSON.parse(await readFile(path, "utf8")) as {
    jobId?: string; threadId?: string; workItemId?: string;
    phase?: string; authorChoiceId?: string;
    units?: Array<{ id?: string; phase?: string; authorChoiceId?: string }>;
  };
  if (state.jobId !== job.jobId || state.threadId && state.threadId !== job.threadId)
    throw Error("Specialist state belongs to another job.");
  return state;
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
  if (r.phase === "awaiting-author" && r.answer)
    throw Error("A pending author question cannot contain a prefilled answer.");
  if (r.phase !== "awaiting-author" && (!r.answer ||
      !/^user:[A-Za-z0-9_-]{1,128}$/.test(r.answer.principal) ||
      typeof r.answer.submittedAt !== "string" ||
      !/^\d{4}-\d\d-\d\dT/.test(r.answer.submittedAt) ||
      typeof r.answer.note !== "string" || r.answer.note.length > 1000 ||
      (r.answer.kind === "option"
        ? specialistChoiceKind(r.question) === "free-text" ||
          !specialistChoiceOptions(r.question).some(o =>
            o.id === (r.answer as { optionId: string }).optionId)
        : r.answer.kind !== "custom" || !r.answer.text?.trim() || r.answer.text.length > 4000)))
    throw Error("A resolved choice has no valid authenticated, source-bound answer.");
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
  await verifyChoiceSession(job, workItem, sessionFile, sessionId);
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
  const waiting: Array<{ id?: string; phase?: string; authorChoiceId?: string }> = [];
  const statePath = join(job.stateDir, "character-world.json");
  if (existsSync(statePath)) {
    const state = await readSpecialistState(job, statePath);
    if (!Array.isArray(state.units)) throw Error("Invalid Character/World choice state.");
    waiting.push(...state.units.filter(u => u.phase === "awaiting-author"));
  }
  const events = join(job.stateDir, "event-items");
  if (existsSync(events)) {
    const { readdir } = await import("node:fs/promises");
    const names = (await readdir(events)).filter(n => /^[a-z0-9-]+\.json$/.test(n));
    if (names.length > 256) throw Error("Specialist author-choice inventory exceeds bounded limit.");
    for (const name of names) {
      const state = await readSpecialistState(job, join(events, name));
      if (state.phase === "awaiting-author")
        waiting.push({ id: state.workItemId, phase: state.phase, authorChoiceId: state.authorChoiceId });
    }
  }
  if (!waiting.length) return null;
  if (waiting.length !== 1 || !waiting[0]?.authorChoiceId || !waiting[0]?.id)
    throw Error("Ambiguous specialist author-choice state.");
  const choice = await safeRead(job, waiting[0].authorChoiceId);
  if (choice.workItem !== waiting[0].id || !["awaiting-author", "answered"].includes(choice.phase))
    throw Error("Specialist author-choice state and saved receipt differ.");
  return choice;
}
export async function verifySpecialistChoice(job: JobStartResult, id: string,
  phase: "awaiting-author" | "answered") {
  const r = await safeRead(job, id);
  if (r.phase !== phase) throw Error("Specialist choice is not at the required author boundary.");
  const { head, digest } = await evidence(job);
  if (head !== r.headSha || digest !== r.worktreeDigest)
    throw Error("Uncommitted draft changed after the specialist asked; reconcile it before proceeding.");
  await verifyChoiceSession(job, r.workItem, r.sessionFile, r.sessionId);
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
      (answer.kind === "option" && (specialistChoiceKind(r.question) === "free-text" ||
        !specialistChoiceOptions(r.question).some(o => o.id === answer.optionId) ||
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
