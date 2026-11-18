import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { JobStartResult } from "./job.js";
import { verifyJobPiSession } from "./job-session.js";
import { parseAuthorQuestion, parseAuthorAnswer, authorQuestionDirection, authorQuestionKind,
  authorQuestionOptions, type AuthorQuestion, type AuthorQuestionAnswer,
  type AuthorQuestionOption } from "./author-question.js";

export type SpecialistChoiceOption = AuthorQuestionOption;
export type SpecialistChoiceQuestion = AuthorQuestion;
export type SpecialistChoiceAnswer = AuthorQuestionAnswer;
export const specialistChoiceKind = authorQuestionKind;
export const specialistChoiceOptions = authorQuestionOptions;
/** Project a persisted, authenticated receipt answer for its original specialist.
 * Provenance fields stay on the receipt; only the validated response is projected. */
export function authorChoiceDirection(q: SpecialistChoiceQuestion, answer: SpecialistChoiceAnswer,
  delegationAllowed = false): string {
  // A persisted receipt carries immutable principal/time evidence. Project only
  // the accepted response fields; never pass receipt metadata into the parser.
  const clean: SpecialistChoiceAnswer = answer.kind === "option"
    ? { kind: "option", optionId: answer.optionId, note: answer.note }
    : answer.kind === "multiple"
      ? { kind: "multiple", optionIds: answer.optionIds,
        ...(answer.text !== undefined ? { text: answer.text } : {}), note: answer.note }
      : answer.kind === "custom" ? { kind: "custom", text: answer.text, note: answer.note }
        : { kind: "delegate", note: answer.note };
  return authorQuestionDirection(q, clean, delegationAllowed);
}
export interface SpecialistChoiceReceipt {
  version: 1;
  id: string; jobId: string; threadId: string; workItem: string;
  phase: "awaiting-author" | "answered" | "resuming" | "consumed";
  headSha: string; worktreeDigest: string; sessionId: string; sessionFile: string;
  sessionSha256: string; question: SpecialistChoiceQuestion; proposalSha256: string;
  /** Controller-issued permission, included in the immutable proposal digest. */
  delegationAllowed?: true;
  answer?: SpecialistChoiceAnswer & { principal: string; submittedAt: string };
}
export class SpecialistChoiceRequiredError extends Error {
  constructor() {
    super("Specialist paused for an author choice. Respond in Chat or Author questions and approvals.");
    this.name = "SpecialistChoiceRequiredError";
  }
}
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
/** Deterministic, safe work-item identity for focused record IDs containing a dot. */
export const focusedChoiceWorkItem = (target: string) => "focus-" + sha(target).slice(0, 24);
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
  const question = parseAuthorQuestion(value);
  // The existing specialist has a bounded single response with up to four
  // alternatives. The shared contract allows concise, optional detail.
  if (["alternatives", "multiple-choice"].includes(specialistChoiceKind(question)) && question.options!.length > 4)
    throw Error("Specialist author choice requires 2–4 alternatives.");
  return question;
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
  if (/^focus-[a-f0-9]{24}$/.test(workItem)) {
    for (const { target, state } of await focusedChoiceStates(job)) {
      if (state.choiceWorkItem !== workItem) continue;
      if (!["writing", "awaiting-author"].includes(state.phase ?? "") ||
          state.piSessionFile !== sessionFile || state.piSessionId !== sessionId ||
          !sessionFile.startsWith(join(job.stateDir, "focused-sessions", target) + sep) ||
          await realpath(sessionFile) !== sessionFile ||
          !(await lstat(sessionFile)).isFile())
        throw Error("Focused author choice is not bound to its original specialist session.");
      const header = JSON.parse((await readFile(sessionFile, "utf8")).split("\n")[0]!) as {
        type?: string; id?: string };
      if (header.type !== "session" || header.id !== sessionId)
        throw Error("Original focused Pi session identity changed.");
      return;
    }
    throw Error("Focused author choice has no matching assigned specialist.");
  }
  const repair = workItem.match(/^repair-([a-f0-9]{40})$/);
  if (repair) {
    const path = join(job.stateDir, "review-repairs", repair[1] + ".json");
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128_000)
      throw Error("Unsafe rejected-review repair state.");
    const state = JSON.parse(await readFile(path, "utf8")) as {
      version: number; jobId: string; threadId: string; sourceCommitSha: string;
      phase: string; origin: { sessionFile: string; sessionId: string };
    };
    if (state.version !== 1 || state.jobId !== job.jobId ||
        state.threadId !== job.threadId || state.sourceCommitSha !== repair[1] ||
        !["repairing", "awaiting-author"].includes(state.phase) ||
        state.origin?.sessionFile !== sessionFile || state.origin.sessionId !== sessionId)
      throw Error("Rejected-review author choice differs from the original writer.");
    const header = JSON.parse((await readFile(sessionFile, "utf8")).split("\n")[0]!) as {
      type?: string; id?: string };
    if (header.type !== "session" || header.id !== sessionId)
      throw Error("Original review-repair Pi session header changed.");
    return;
  }
  throw Error("Specialist choice work-item session binding is not configured.");
}
async function readSpecialistState(job: JobStartResult, path: string) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 200_000)
    throw Error("Unsafe specialist work-item state.");
  const state = JSON.parse(await readFile(path, "utf8")) as {
    jobId?: string; threadId?: string; workItemId?: string;
    phase?: string; authorChoiceId?: string; choiceWorkItem?: string;
    piSessionFile?: string; piSessionId?: string;
    units?: Array<{ id?: string; phase?: string; authorChoiceId?: string }>;
  };
  if (state.jobId !== job.jobId || state.threadId && state.threadId !== job.threadId)
    throw Error("Specialist state belongs to another job.");
  return state;
}
/** Both choice issuance and owner-facing lookup use this exact trusted inventory. */
async function focusedChoiceStates(job: JobStartResult) {
  const dir = join(job.stateDir, "focused-items");
  if (!existsSync(dir)) return [];
  const names = (await readdir(dir)).filter(name =>
    /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\.json$/.test(name));
  if (names.length > 256) throw Error("Focused choice inventory exceeds bounded limit.");
  return Promise.all(names.map(async name => {
    const target = name.slice(0, -5);
    const state = await readSpecialistState(job, join(dir, name));
    if (state.workItemId !== "focus:" + target ||
        (state.choiceWorkItem !== undefined &&
          state.choiceWorkItem !== focusedChoiceWorkItem(target)))
      throw Error("Focused choice inventory differs from its bound record target.");
    return { target, state };
  }));
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
        sessionSha256: r.sessionSha256, question: parseSpecialistChoice(r.question),
        ...(r.delegationAllowed === true ? { delegationAllowed: true } : {}) })) !== r.proposalSha256 ||
      (r.delegationAllowed !== undefined &&
        (r.delegationAllowed !== true || r.question.allowStudioDecision !== true ||
          !specialistDelegationPolicy(r.workItem))))
    throw Error("Specialist-choice receipt is inconsistent or modified.");
  if (r.phase === "awaiting-author" && r.answer)
    throw Error("A pending author question cannot contain a prefilled answer.");
  if (r.phase !== "awaiting-author") {
    if (!r.answer ||
        !/^user:[A-Za-z0-9_-]{1,128}$/.test(r.answer.principal) ||
        typeof r.answer.submittedAt !== "string" ||
        !/^\d{4}-\d\d-\d\dT/.test(r.answer.submittedAt))
      throw Error("A resolved choice has no valid authenticated, source-bound answer.");
    const { principal: _principal, submittedAt: _submittedAt, ...authorAnswer } = r.answer;
    parseAuthorAnswer(r.question, authorAnswer, r.delegationAllowed === true);
  }
  return r;
}
async function save(job: JobStartResult, r: SpecialistChoiceReceipt) {
  const dir = join(job.stateDir, "specialist-choices");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = file(job, r.id), temp = target + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(r, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await rename(temp, target);
}
/** An ordinary foundations/Event question may be delegated, never an explicitly
 * author-gated focus assignment or a disputed independent-review repair. */
export function specialistDelegationPolicy(workItem: string): boolean {
  return workItem === "world-foundations" || workItem === "character-foundations" ||
    /^event-[a-z][a-z0-9-]*$/.test(workItem);
}
export async function recordSpecialistChoice(job: JobStartResult, workItem: string,
  question: SpecialistChoiceQuestion, sessionId: string, sessionFile: string) {
  const q = parseSpecialistChoice(question);
  if (!ID.test(workItem)) throw Error("Invalid specialist choice work item.");
  await verifyChoiceSession(job, workItem, sessionFile, sessionId);
  const { head, digest } = await evidence(job);
  const transcriptHash = sha(await readFile(sessionFile));
  const immutable = { jobId: job.jobId, workItem, headSha: head, worktreeDigest: digest,
    sessionId, sessionSha256: transcriptHash, question: q,
    ...(q.allowStudioDecision === true && specialistDelegationPolicy(workItem)
      ? { delegationAllowed: true as const } : {}) };
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
    const names = (await readdir(events)).filter(n => /^[a-z0-9-]+\.json$/.test(n));
    if (names.length > 256) throw Error("Specialist author-choice inventory exceeds bounded limit.");
    for (const name of names) {
      const state = await readSpecialistState(job, join(events, name));
      if (state.phase === "awaiting-author")
        waiting.push({ id: state.workItemId, phase: state.phase, authorChoiceId: state.authorChoiceId });
    }
  }
  const repairs = join(job.stateDir, "review-repairs");
  if (existsSync(repairs)) {
    const names = (await readdir(repairs)).filter(n => /^[a-f0-9]{40}\.json$/.test(n));
    if (names.length > 256) throw Error("Rejected-review choice inventory exceeds bounded limit.");
    for (const name of names) {
      const state = JSON.parse(await readFile(join(repairs, name), "utf8")) as {
        jobId?: string; threadId?: string; phase?: string; choiceId?: string };
      if (state.jobId !== job.jobId || state.threadId !== job.threadId)
        throw Error("Rejected-review choice belongs to a different job.");
      if (state.phase === "awaiting-author")
        waiting.push({ id: "repair-" + name.slice(0, 40),
          phase: state.phase, authorChoiceId: state.choiceId });
    }
  }
  for (const { state } of await focusedChoiceStates(job)) {
    if (state.phase === "awaiting-author") waiting.push({
      id: state.choiceWorkItem, phase: state.phase, authorChoiceId: state.authorChoiceId });
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
  if (r.proposalSha256 !== proposalSha256) throw Error("Invalid or stale author choice.");
  const validAnswer = parseAuthorAnswer(r.question, answer, r.delegationAllowed === true);
  const updated: SpecialistChoiceReceipt = { ...r, phase: "answered",
    answer: { ...validAnswer, principal, submittedAt: new Date().toISOString() } };
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
