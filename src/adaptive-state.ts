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
import type { AdaptiveAmendment } from "./adaptive-assignments.js";

import type { AdaptiveResponseProof } from "./adaptive-protocol.js";

export interface AdaptiveSessionEvidence {
  sessionFile: string; sessionSha256: string; snapshotId: string;
  /** Successful read-tool paths: pinned skills and source-Git canonical Story files. */
  provider: string; model: string; skillReads: string[]; proposalDigest: string;
}
export interface AdaptiveAttempt {
  signature: string; sourceSha: string;
  phase: "planning" | "rejected" | "unchanged" | "admitted";
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
    if (attempt.phase === "admitted" && !attempt.session)
      throw Error("An admitted adaptive proposal has no original read-only Pi transcript.");
    if (attempt.session) {
      const proof = attempt.session;
      const dir = join(job.stateDir, "adaptive-planning-sessions") + sep;
      const snapshotRoot = await openSkillSnapshot(proof.snapshotId);
      if (!proof.sessionFile.startsWith(dir) || !proof.sessionFile.endsWith(".jsonl") ||
          !HASH.test(proof.sessionSha256) || !HASH.test(proof.snapshotId) ||
          !HASH.test(proof.proposalDigest) || !proof.provider || !proof.model ||
          !Array.isArray(proof.skillReads) || !proof.skillReads.length ||
          proof.skillReads.length > 1024 || !snapshotRoot)
        throw Error("Adaptive Pi transcript or pinned skill evidence was altered.");
      // Real read-only Pi transcripts include BOTH pinned skill instructions
      // and canonical Story reads. Requiring every path to contain /skills/
      // incorrectly blocks a valid settled planner on restart. Authenticate
      // each source at its original Git SHA instead of accepting a substring
      // match against an unrelated filesystem path.
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
          throw Error("Adaptive Pi transcript read outside its pinned skill and canonical Story roots.");
        const rel = relative(job.worktreeStoryRoot, path);
        if (!/^[a-z][a-z0-9-]*\/[a-z0-9._-]+\.md$/.test(rel))
          throw Error("Adaptive Pi transcript read an unsupported canonical Story path.");
        const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
        try { dependencyGit(job, "cat-file", "-e", attempt.sourceSha + ":" + prefix + rel); }
        catch { throw Error("Adaptive Pi transcript references a Story file absent from its original verified Git commit."); }
      }
      const stat = await lstat(proof.sessionFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024 ||
          await realpath(proof.sessionFile) !== proof.sessionFile ||
          createHash("sha256").update(await readFile(proof.sessionFile)).digest("hex") !== proof.sessionSha256)
        throw Error("Adaptive Pi transcript changed after controller admission.");
    }
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
export function assertAdaptiveSettled(state: AdaptiveState) {
  if (state.attempts.some(a => a.phase === "planning"))
    throw Error("Interrupted adaptive orchestrator session: preserve its transcript and reconcile before another plan.");
  if (state.attempts.some(a => a.phase === "rejected"))
    throw Error("Rejected adaptive orchestrator proposal: preserve its evidence and reconcile before dispatching remaining work.");
}
export async function beginAdaptiveAttempt(job: JobStartResult, state: AdaptiveState,
  sourceSha: string, signature: string): Promise<boolean> {
  assertAdaptiveSettled(state);
  if (!SHA.test(sourceSha) || !HASH.test(signature))
    throw Error("Adaptive planning attempt has invalid source identity.");
  if (state.attempts.some(a => a.signature === signature)) return false;
  if (state.attempts.length >= 24 || state.entries.length >= 4)
    throw Error("Bounded adaptive plan history exhausted; author review required.");
  state.attempts.push({ signature, sourceSha, phase: "planning" });
  await saveAdaptiveState(job, state);
  return true;
}
export async function settleAdaptiveAttempt(job: JobStartResult, state: AdaptiveState,
  signature: string, phase: "rejected" | "unchanged" | "admitted",
  entry?: AdaptiveAmendment, session?: AdaptiveSessionEvidence): Promise<void> {
  const attempt = state.attempts.find(a => a.signature === signature);
  if (!attempt || attempt.phase !== "planning" ||
      phase === "admitted" !== Boolean(entry) ||
      phase === "admitted" && !session)
    throw Error("Adaptive planning attempt is not an unsettled exact source.");
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
