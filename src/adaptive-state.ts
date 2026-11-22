/** Durable, Thread-owned adaptive plan history. Like specialist writer receipts,
 * an interrupted model turn is never automatically replayed. */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { openSkillSnapshot } from "./snapshot.js";
import type { JobStartResult } from "./job.js";
import { persist } from "./ideas.js";
import { dependencyGit } from "./dependency-state.js";
import { pendingDigest } from "./pending-work-amendments.js";
import { assertAdaptiveTrackedRead } from "./adaptive-source-reads.js";
import type { AdaptiveAmendment } from "./adaptive-assignments.js";

import type { AdaptiveResponseProof } from "./adaptive-protocol.js";

export interface AdaptiveSessionEvidence {
  sessionFile: string; sessionSha256: string; snapshotId: string;
  provider: string; model: string;
  /** Successful read-tool paths: pinned methods, canonical Story files and
   * the exact ancillary tracked root README.txt. */
  skillReads: string[]; proposalDigest: string;
}
/** A controller-owned, write-ahead boundary for the ORIGINAL adaptive
 * operation. "prepared" proves no adaptive Pi invocation was begun by this
 * implementation; "invoking" is deliberately ambiguous until the exact
 * transcript proves a completed response. Old attempts have no such proof. */
export interface AdaptiveEffect {
  version: 1;
  phase: "prepared" | "invoking" | "responded";
  snapshotId: string; provider: string; model: string;
  contextDigest?: string;
  invocation?: { file: string; id: string; prefixBytes: number; prefixSha256: string;
    promptSha256: string; responseSha256?: string };
}
export interface AdaptiveAttempt {
  signature: string; sourceSha: string;
  phase: "planning" | "rejected" | "unchanged" | "admitted";
  effect?: AdaptiveEffect;
  session?: AdaptiveSessionEvidence;
  malformedResponse?: AdaptiveResponseProof;
  recoveryContext?: string;
}
export interface AdaptiveState {
  schema: "noveltea-adaptive-plan/v1";
  jobId: string; threadId: string; baseSha: string; branch: string;
  turnDigest: string; planVersion: number; version: number;
  entries: AdaptiveAmendment[]; attempts: AdaptiveAttempt[];
  digest: string;
}
const HASH = /^[0-9a-f]{64}$/, SHA = /^[0-9a-f]{40}$/;
const pathFor = (job: JobStartResult) => join(job.stateDir, "adaptive-plan.json");

export const emptyAdaptiveState = (job: JobStartResult, turnDigest: string,
  planVersion: number): AdaptiveState => ({
  schema: "noveltea-adaptive-plan/v1", jobId: job.jobId, threadId: job.threadId,
  baseSha: job.baseSha, branch: job.branch, turnDigest, planVersion,
  version: 1, entries: [], attempts: [], digest: "",
});

export async function saveAdaptiveState(job: JobStartResult, state: AdaptiveState) {
  const { digest: _digest, ...body } = state;
  state.digest = pendingDigest(body);
  await persist(pathFor(job), state);
}

/** Exactly the same source-read policy is enforced before saving a proposal
 * and on every restoration, including on process restart. */
async function verifyAdaptiveSessionEvidence(job: JobStartResult, sourceSha: string,
  proof: AdaptiveSessionEvidence): Promise<void> {
  const dir = join(job.stateDir, "adaptive-planning-sessions") + sep;
  const snapshotRoot = await openSkillSnapshot(proof.snapshotId);
  if (!proof.sessionFile.startsWith(dir) || !proof.sessionFile.endsWith(".jsonl") ||
      !HASH.test(proof.sessionSha256) || !HASH.test(proof.snapshotId) ||
      !HASH.test(proof.proposalDigest) || !proof.provider || !proof.model ||
      !Array.isArray(proof.skillReads) || !proof.skillReads.length ||
      proof.skillReads.length > 1024 || !snapshotRoot)
    throw Error("Adaptive Pi transcript or pinned skill evidence was altered.");
  const skillsDir = join(snapshotRoot, "skills") + sep;
  const storyDir = job.worktreeStoryRoot ? job.worktreeStoryRoot + sep : "";
  if (!proof.skillReads.some(path => typeof path === "string" && path.startsWith(skillsDir)))
    throw Error("Adaptive Pi transcript lacks pinned methodology reads.");
  for (const path of proof.skillReads) {
    if (typeof path !== "string" || path.length > 4096)
      throw Error("Adaptive Pi transcript contains an invalid source read.");
    if (path.startsWith(skillsDir)) {
      const skillRelative = relative(skillsDir, path);
      if (!skillRelative || skillRelative === ".." ||
          skillRelative.startsWith(".." + sep) || !skillRelative.endsWith(".md"))
        throw Error("Adaptive Pi transcript references an unsafe pinned skill path.");
      try {
        const pinned = await lstat(path);
        if (!pinned.isFile() || pinned.isSymbolicLink() || await realpath(path) !== path)
          throw Error("unsafe");
      } catch {
        throw Error("Adaptive Pi transcript references a missing or unsafe pinned skill file.");
      }
      continue;
    }
    if (!storyDir || !path.startsWith(storyDir))
      throw Error("Adaptive Pi transcript read outside its pinned skill and Story roots.");
    // An exact root README.txt is ancillary Story context, not methodology or
    // canonical evidence. A tracked symlink is never a valid source read.
    assertAdaptiveTrackedRead(job, sourceSha, path);
  }
  const stat = await lstat(proof.sessionFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024 ||
      await realpath(proof.sessionFile) !== proof.sessionFile ||
      createHash("sha256").update(await readFile(proof.sessionFile)).digest("hex") !== proof.sessionSha256)
    throw Error("Adaptive Pi transcript changed after controller admission.");
}

export async function readAdaptiveState(job: JobStartResult, turnDigest: string,
  planVersion: number): Promise<AdaptiveState | null> {
  if (!existsSync(pathFor(job))) return null;
  const stat = await lstat(pathFor(job));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512_000)
    throw Error("Unsafe private adaptive plan receipt.");
  const state = JSON.parse(await readFile(pathFor(job), "utf8")) as AdaptiveState;
  const { digest: saved, ...body } = state;
  if (state.schema !== "noveltea-adaptive-plan/v1" ||
      state.jobId !== job.jobId || state.threadId !== job.threadId ||
      state.baseSha !== job.baseSha || state.branch !== job.branch ||
      state.turnDigest !== turnDigest || !HASH.test(turnDigest) ||
      state.planVersion !== planVersion ||
      saved !== pendingDigest(body) ||
      !Array.isArray(state.entries) || state.entries.length > 4 ||
      !Array.isArray(state.attempts) || state.attempts.length > 24 ||
      state.version !== state.entries.length + 1)
    throw Error("Adaptive plan identity, source, version or digest differs.");
  for (const [index, entry] of state.entries.entries()) {
    const { digest, ...receipt } = entry;
    if (entry.schema !== "noveltea-adaptive-assignments/v1" ||
        !HASH.test(digest) || digest !== pendingDigest(receipt) ||
        entry.beforeVersion !== index + 1 || entry.afterVersion !== index + 2 ||
        entry.turnDigest !== turnDigest || entry.planVersion !== planVersion ||
        !SHA.test(entry.sourceSha) || !HASH.test(entry.inventoryDigest) ||
        !Array.isArray(entry.actions) || !Array.isArray(entry.order) ||
        !Array.isArray(entry.carried) || !Array.isArray(entry.omissions))
      throw Error("Adaptive plan amendment receipt was altered or reordered.");
    dependencyGit(job, "merge-base", "--is-ancestor", entry.sourceSha, "HEAD");
  }
  const signatures = new Set<string>();
  for (const attempt of state.attempts) {
    if (!HASH.test(attempt.signature) || !SHA.test(attempt.sourceSha) ||
        !["planning", "rejected", "unchanged", "admitted"].includes(attempt.phase) ||
        signatures.has(attempt.signature))
      throw Error("Adaptive orchestration attempt history is corrupt.");
    signatures.add(attempt.signature);
    dependencyGit(job, "merge-base", "--is-ancestor", attempt.sourceSha, "HEAD");
    const effect = attempt.effect;
    if (effect) {
      if (effect.version !== 1 || !["prepared", "invoking", "responded"].includes(effect.phase) ||
          !HASH.test(effect.snapshotId) || !effect.provider || !effect.model ||
          effect.contextDigest !== undefined && !HASH.test(effect.contextDigest) ||
          (effect.phase === "prepared") !== !effect.invocation)
        throw Error("Adaptive operation effect phase or original model/snapshot proof is invalid.");
      if (effect.invocation) {
        const ref = effect.invocation;
        if (!ref.file.startsWith(join(job.stateDir, "adaptive-planning-sessions") + sep) ||
            !ref.file.endsWith(".jsonl") || !ref.id || !Number.isSafeInteger(ref.prefixBytes) ||
            ref.prefixBytes < 0 || !HASH.test(ref.prefixSha256) || !HASH.test(ref.promptSha256) ||
            effect.phase === "responded" !== Boolean(ref.responseSha256) ||
            ref.responseSha256 !== undefined && !HASH.test(ref.responseSha256))
          throw Error("Adaptive original Pi invocation proof is invalid.");
      }
    }
    if (attempt.phase === "admitted" && !attempt.session)
      throw Error("An admitted adaptive proposal has no original read-only Pi transcript.");
    if (attempt.session)
      await verifyAdaptiveSessionEvidence(job, attempt.sourceSha, attempt.session);
  }
  const admitted = state.attempts.filter(a => a.phase === "admitted");
  if (admitted.length !== state.entries.length ||
      admitted.some((a, i) => {
        const entry = state.entries[i]!;
        return a.sourceSha !== entry.sourceSha || a.session?.proposalDigest !==
          pendingDigest({ sourceSha: entry.sourceSha, turnDigest: entry.turnDigest,
            beforeVersion: entry.beforeVersion, reason: entry.reason,
            actions: entry.actions, order: entry.order });
      }))
    throw Error("Adaptive admitted Pi proposal does not match its sealed work plan.");
  return state;
}

/** Interrupted or rejected planning requires explicit reconciliation, even
 * when HEAD stayed clean. Settling a rejection records evidence, not permission
 * to dispatch the old plan or silently replace the original model attempt. */
/** A read-only verifier may inspect a prepared original attempt without
 * falsely treating it as a completed Pi call or invoking it. This does NOT
 * admit any adaptive proposal or grant another session. */
export function isProvablyUninvokedAdaptiveAttempt(attempt: AdaptiveAttempt | null | undefined): boolean {
  return !!attempt && attempt.phase === "planning" && attempt.effect?.phase === "prepared" &&
    !attempt.effect.invocation && !attempt.session && !attempt.malformedResponse;
}
export function assertAdaptiveSettled(state: AdaptiveState) {
  if (state.attempts.some(a => a.phase === "planning"))
    throw Error("Interrupted adaptive orchestrator session: preserve its transcript and reconcile before another plan.");
  if (state.attempts.some(a => a.phase === "rejected"))
    throw Error("Rejected adaptive orchestrator proposal: preserve its evidence and reconcile before dispatching remaining work.");
}
export async function beginAdaptiveAttempt(job: JobStartResult, state: AdaptiveState,
  sourceSha: string, signature: string, effect?: Pick<AdaptiveEffect, "snapshotId" | "provider" | "model">): Promise<boolean> {
  assertAdaptiveSettled(state);
  if (!SHA.test(sourceSha) || !HASH.test(signature))
    throw Error("Adaptive planning attempt has invalid source identity.");
  if (state.attempts.some(a => a.signature === signature)) return false;
  if (state.attempts.length >= 24 || state.entries.length >= 4)
    throw Error("Bounded adaptive plan history exhausted; author review required.");
  if (effect && (!HASH.test(effect.snapshotId) || !effect.provider || !effect.model))
    throw Error("Adaptive original operation lacks pinned model and snapshot identity.");
  state.attempts.push({ signature, sourceSha, phase: "planning",
    ...(effect ? { effect: { version: 1 as const, phase: "prepared" as const, ...effect } } : {}) });
  await saveAdaptiveState(job, state);
  return true;
}

/** Called only under the original Story writer lease, after the independent
 * omission work has completed. Never weaken the write-ahead invocation fence. */
export async function bindAdaptiveContext(job: JobStartResult, state: AdaptiveState,
  signature: string, contextDigest: string) {
  const attempt = state.attempts.find(a => a.signature === signature);
  if (!attempt || attempt.phase !== "planning" || !attempt.effect ||
      !HASH.test(contextDigest) || attempt.effect.phase !== "prepared" ||
      attempt.effect.contextDigest && attempt.effect.contextDigest !== contextDigest)
    throw Error("Adaptive original operation context or effect phase differs.");
  attempt.effect.contextDigest = contextDigest;
  await saveAdaptiveState(job, state);
}

export async function beginAdaptiveInvocation(job: JobStartResult, state: AdaptiveState,
  signature: string, file: string, id: string, prompt: string) {
  const attempt = state.attempts.find(a => a.signature === signature);
  if (!attempt || attempt.phase !== "planning" || attempt.effect?.phase !== "prepared" ||
      !attempt.effect.contextDigest || !id || !prompt ||
      !file.startsWith(join(job.stateDir, "adaptive-planning-sessions") + sep) ||
      !file.endsWith(".jsonl"))
    throw Error("Adaptive Pi invocation has no prepared, source-bound original operation.");
  // Pi creates the JSONL on its first user message, not at SessionManager
  // construction. Missing *before* this marker is legitimate; missing after
  // it is ambiguous and never proves that the call did not begin.
  let bytes = Buffer.alloc(0);
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024 ||
        await realpath(file) !== file)
      throw Error("Adaptive original Pi session is unsafe.");
    bytes = await readFile(file);
    let header: { type?: string; id?: string };
    try { header = JSON.parse(bytes.toString("utf8").split("\n")[0] ?? "{}"); }
    catch { throw Error("Adaptive original Pi session header is invalid."); }
    if (header.type !== "session" || header.id !== id)
      throw Error("Adaptive original Pi session identity changed before dispatch.");
    // The adaptive group is unique per operation. Existing conversation
    // messages at a supposedly pre-call boundary imply another effect.
    try {
      if (bytes.toString("utf8").trimEnd().split("\n").slice(1)
        .some(line => JSON.parse(line).type === "message"))
        throw Error("Adaptive original Pi session already contains model activity.");
    } catch (error) {
      if (error instanceof SyntaxError) throw Error("Adaptive original Pi prefix is malformed.");
      throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  attempt.effect = { ...attempt.effect, phase: "invoking",
    invocation: { file, id, prefixBytes: bytes.length,
      prefixSha256: createHash("sha256").update(bytes).digest("hex"),
      promptSha256: createHash("sha256").update(prompt).digest("hex") } };
  // This durable commit MUST complete before session.prompt() can reach Pi.
  // A crash between this write and the actual call is ambiguous, not "prepared".
  await saveAdaptiveState(job, state);
}

export async function completeAdaptiveInvocation(job: JobStartResult, state: AdaptiveState,
  signature: string, file: string, id: string) {
  const attempt = state.attempts.find(a => a.signature === signature);
  if (attempt?.phase !== "planning" || attempt.effect?.phase !== "invoking" ||
      attempt.effect.invocation?.file !== file || attempt.effect.invocation.id !== id)
    throw Error("Completed adaptive response lacks its original invocation fence.");
  const bytes = await readFile(file);
  const original = attempt.effect.invocation;
  if (bytes.length < original.prefixBytes ||
      createHash("sha256").update(bytes.subarray(0, original.prefixBytes)).digest("hex") !== original.prefixSha256)
    throw Error("Completed adaptive Pi response no longer contains its invocation prefix.");
  attempt.effect = { ...attempt.effect, phase: "responded",
    invocation: { ...original,
      responseSha256: createHash("sha256").update(bytes).digest("hex") } };
  await saveAdaptiveState(job, state);
}

export async function settleAdaptiveAttempt(job: JobStartResult, state: AdaptiveState,
  signature: string, phase: "rejected" | "unchanged" | "admitted",
  entry?: AdaptiveAmendment, session?: AdaptiveSessionEvidence): Promise<void> {
  const attempt = state.attempts.find(a => a.signature === signature);
  if (!attempt || attempt.phase !== "planning" ||
      phase === "admitted" !== Boolean(entry) ||
      phase === "admitted" && !session)
    throw Error("Adaptive planning attempt is not an unsettled exact source.");
  if (session) await verifyAdaptiveSessionEvidence(job, attempt.sourceSha, session);
  if (entry) {
    if (entry.beforeVersion !== state.version || entry.afterVersion !== state.version + 1 ||
        entry.sourceSha !== attempt.sourceSha || entry.turnDigest !== state.turnDigest ||
        entry.planVersion !== state.planVersion)
      throw Error("Adaptive admission lost its exact original source and version.");
    state.entries.push(entry); state.version++;
  }
  attempt.phase = phase;
  if (session) attempt.session = session;
  await saveAdaptiveState(job, state);
}
