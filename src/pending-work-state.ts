import { existsSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobStartResult } from "./job.js";
import { persist } from "./ideas.js";
import { dependencyGit } from "./dependency-state.js";
import { pendingDigest, applyPendingAmendment, type PendingAmendment,
  type PendingState } from "./pending-work-amendments.js";
import type { GenerationInventory } from "./generation-plan.js";
import { declaredCanonicalReferences, type CanonicalScopeRecord } from "./focused-scope.js";

const pathFor = (job: JobStartResult) => join(job.stateDir, "pending-work.json");
export const pendingSignature = (head: string, id: string, inventory: GenerationInventory) =>
  pendingDigest({ head, id, dependencies: inventory.items.find(item => item.id === id)?.dependencies,
    target: inventory.items.find(item => item.id === id)?.targetIds });

export async function readPendingState(job: JobStartResult, turnDigest: string): Promise<PendingState | null> {
  const file = pathFor(job);
  if (!existsSync(file)) return null;
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256_000)
    throw Error("Unsafe pending-work controller receipt.");
  const state = JSON.parse(await readFile(file, "utf8")) as PendingState;
  const { digest, ...body } = state;
  if (state.schema !== "noveltea-pending-work/v1" ||
      state.jobId !== job.jobId || state.threadId !== job.threadId ||
      state.turnDigest !== turnDigest || !/^[a-f0-9]{64}$/.test(turnDigest) ||
      digest !== pendingDigest(body) ||
      !Array.isArray(state.entries) || state.entries.length > 4 ||
      state.version !== 1 + state.entries.length ||
      !Array.isArray(state.attempts) || state.attempts.length > 24)
    throw Error("Pending plan history has wrong identity, source or digest.");
  let v = 1;
  for (const entry of state.entries) {
    if (entry.beforeVersion !== v++ || entry.afterVersion !== v ||
        entry.turnDigest !== turnDigest || !/^[a-f0-9]{40}$/.test(entry.sourceSha) ||
        !/^[a-f0-9]{64}$/.test(entry.inventoryDigest) ||
        !Array.isArray(entry.carried) || !Array.isArray(entry.prune) ||
        !Array.isArray(entry.order) || !Array.isArray(entry.prerequisites))
      throw Error("Pending plan amendment version or source history is corrupt.");
    dependencyGit(job, "merge-base", "--is-ancestor", entry.sourceSha, "HEAD");
  }
  const signatures = new Set<string>();
  for (const attempt of state.attempts) {
    if (!/^[a-f0-9]{40}$/.test(attempt.sourceSha) ||
        !/^[a-f0-9]{64}$/.test(attempt.signature) ||
        !["reviewing", "rejected", "unchanged"].includes(attempt.outcome) ||
        signatures.has(attempt.signature))
      throw Error("Pending plan retry history is corrupt.");
    signatures.add(attempt.signature);
  }
  return state;
}

export async function savePendingState(job: JobStartResult, state: PendingState) {
  const { digest: _old, ...body } = state;
  state.digest = pendingDigest(body);
  await persist(pathFor(job), state);
}

export function emptyPendingState(job: JobStartResult, turnDigest: string): PendingState {
  return { schema: "noveltea-pending-work/v1", jobId: job.jobId, threadId: job.threadId,
    turnDigest, version: 1, entries: [], attempts: [], digest: "" };
}

/** A crash may happen after dispatching a paid independent reviewer but
 * before its result was sealed. Even a clean worktree cannot replay that turn
 * or quietly dispatch the original writer until manually reconciled. */
export function assertPendingReviewSettled(state: PendingState) {
  if (state.attempts.some(attempt => attempt.outcome === "reviewing"))
    throw Error("Interrupted pending-work reviewer; preserve its original transcript and reconcile before dispatch.");
}

/** Scheduling and inspection must independently attest the graph's exact
 * prior amendment version. Missing private history is not an invitation to
 * replay the prior assignments or regenerate the plan. */
export async function verifyPinnedPendingWork(job: JobStartResult,
  turnDigest: string | undefined, version: number | null | undefined) {
  if (!turnDigest) {
    if (version != null) throw Error("Checkpointed pending plan has no original Turn authority.");
    return;
  }
  const state = await readPendingState(job, turnDigest);
  if (version != null && version > 1 && (!state || state.version < version))
    throw Error("Checkpointed pending-plan amendment history is missing or stale; restore it before resuming.");
  if (state) assertPendingReviewSettled(state);
}

/** The omission reviewer and replay gate use the same schema-typed,
 * bidirectional neighborhood. Newly introduced inbound links invalidate an
 * old positive review even when the original source bytes are unchanged. */
export function omissionContext(records: CanonicalScopeRecord[], path: string):
  CanonicalScopeRecord[] | null {
  const record = records.find(r => r.path === path && r.metadata.status === "approved");
  if (!record || Array.isArray(record.metadata.decisions) && record.metadata.decisions.length)
    return null;
  const outbound = declaredCanonicalReferences(record);
  const adjacent = records.filter(r => r.metadata.status !== "superseded" &&
    (outbound.has(r.metadata.id) || declaredCanonicalReferences(r).has(record.metadata.id)));
  if (adjacent.length > 64 || adjacent.some(r => Array.isArray(r.metadata.decisions) &&
    r.metadata.decisions.length)) return null;
  return adjacent.sort((a, b) => a.path.localeCompare(b.path));
}

/** Applied only after native validation of the *current* HEAD. Invalidated
 * context revokes an omission, not a previously published Git checkpoint.
 * An affected pending descendant becomes runnable only after its prerequisites
 * are rechecked by normal inventory scheduling. */
export async function applyPendingHistory(job: JobStartResult, state: PendingState,
  inventory: GenerationInventory, sourceHashes: Record<string, string>,
  canonicalEdges: Array<{ item: string; needs: string }>,
  records: CanonicalScopeRecord[]): Promise<{
    inventory: GenerationInventory; order: string[] | null; invalidated: string[];
  }> {
  let result = inventory;
  const invalidated: string[] = [];
  let order: string[] | null = null;
  for (const amendment of state.entries) {
    const prune = amendment.prune.filter(proof => {
      const context = omissionContext(records, proof.path);
      const writerReceipt = join(job.stateDir, "focused-items",
        proof.assignmentId.slice("focus:".length) + ".json");
      const expected = proof.context.map(source => source.path).sort();
      const observed = context?.map(source => source.path);
      const safe = !existsSync(writerReceipt) &&
        sourceHashes[proof.path] === proof.sourceHash &&
        !!context && JSON.stringify(expected) === JSON.stringify(observed) &&
        proof.context.every(source => sourceHashes[source.path] === source.sha256);
      if (!safe) invalidated.push(proof.assignmentId);
      return safe && result.items.some(item => item.id === proof.assignmentId &&
        item.status === "pending");
    });
    // Never resurrect a dependency that no longer appears in the current
    // native canonical graph or that targets a completed assignment.
    const prerequisites = amendment.prerequisites.filter(edge =>
      canonicalEdges.some(actual => actual.item === edge.item && actual.needs === edge.needs) &&
      result.items.some(item => item.id === edge.item && item.status === "pending"));
    if (!prune.length && !prerequisites.length) continue;
    // The original source inventory is required for same-HEAD replay. At a
    // descendant commit, all retained canonical context hashes above match.
    const carried = { ...amendment, sourceSha: result.headSha,
      inventoryDigest: pendingDigest(result.items), prune, prerequisites };
    result = applyPendingAmendment(result, carried);
    order = amendment.order.filter(id => result.items.some(item => item.id === id &&
      item.status === "pending"));
  }
  // A later change to the reviewed canon can invalidate a previously omitted
  // upstream prerequisite. Independently committed descendants are preserved
  // in Git, but their previous proof cannot certify the newly required cause.
  // Never replay those writers automatically; reconcile only their assurance.
  const invalid = new Set(invalidated.filter(id =>
    result.items.some(item => item.id === id && item.status !== "verified")));
  for (let pass = 0; pass < result.items.length; pass++) {
    for (const item of result.items) {
      if (item.status !== "verified" || item.omission) continue;
      const changed = item.dependencies.find(id => invalid.has(id));
      if (changed) {
        invalid.add(item.id);
        item.status = "blocked";
        item.blockingReason = "Downstream checkpoint depends on invalidated omission: " +
          changed + "; reconcile the preserved commit and independent review.";
        delete item.verifiedSha;
      }
    }
  }
  return { inventory: result, order, invalidated };
}

/** Preserve a once-started independent reviewer session. A restart cannot
 * silently issue a second paid Pi review for a potentially interrupted turn. */
export async function beginPendingReview(job: JobStartResult, state: PendingState, signature: string,
  sourceSha: string): Promise<boolean> {
  const prior = state.attempts.find(a => a.signature === signature);
  if (prior?.outcome === "reviewing")
    throw Error("Interrupted pending-work reviewer; inspect its transcript before reconciliation.");
  if (prior) return false;
  if (state.attempts.length >= 24 || state.entries.length >= 4)
    throw Error("Bounded pending-work replan attempts exhausted; author review required.");
  state.attempts.push({ sourceSha, signature, outcome: "reviewing" });
  await savePendingState(job, state);
  return true;
}

export async function settlePendingReview(job: JobStartResult, state: PendingState, signature: string,
  outcome: "rejected" | "unchanged", amendment?: PendingAmendment) {
  const attempt = state.attempts.find(a => a.signature === signature);
  if (!attempt || attempt.outcome !== "reviewing")
    throw Error("Pending plan review was not started from this source.");
  if (amendment) {
    if (amendment.beforeVersion !== state.version || amendment.afterVersion !== state.version + 1 ||
        amendment.sourceSha !== attempt.sourceSha)
      throw Error("Stale pending-work amendment cannot be committed.");
    state.entries.push(amendment);
    state.version++;
  }
  attempt.outcome = outcome;
  await savePendingState(job, state);
}
