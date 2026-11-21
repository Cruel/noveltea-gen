import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { hostname } from "node:os";
import { mkdir, readFile, rename, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { captureStorySnapshot, pruneRoutineStorySnapshots,
  type StorySnapshotPhase } from "./story-debug-snapshot.js";
import type { JobStartResult } from "./job.js";

export interface StoryWriterContext {
  job: JobStartResult;
  workItem: string;
  /** Keep an ambiguous writer lock for manual inspection; never allow another writer. */
  retainLease: boolean;
  active: boolean;
}
const storyWriter = new AsyncLocalStorage<StoryWriterContext>();
/** Keep diagnostic Git refs out of routine controller and read-only leases. */
export function isStorySpecialistLease(item: string) {
  return item === "foundation" || item === "global-architecture" ||
    item === "character-world" || item === "rejected-review-writer" ||
    item === "idea-placement" || item === "rejected-review-validation" ||
    item === "rejected-review-commit" ||
    /^(?:event-|interactive-|composition-|focus:)/.test(item);
}
function saveDiagnostic(job: JobStartResult, phase: StorySnapshotPhase, item: string) {
  try {
    captureStorySnapshot(job, phase, item);
    if (phase === "after-work" || phase === "before-work")
      pruneRoutineStorySnapshots(job);
  } catch (error) {
    // A failed debugging facility must never hide the original writer error or
    // change the Story's recovery/author-approval semantics.
    console.warn("[Story diagnostic snapshot]", phase, item,
      error instanceof Error ? error.message : String(error));
  }
}
export function activeStoryWriter(): StoryWriterContext | undefined {
  return storyWriter.getStore();
}

/** Prove that this async operation still owns the exact per-Story lease.
 * An ambient context alone is not authority: the lease can have expired, or
 * a different job/branch can share the same human-facing Story identifier.
 */
export function requireStoryJobLease(job: JobStartResult,
  allowedWorkItems?: readonly string[]): StoryWriterContext {
  const owner = activeStoryWriter();
  if (!owner?.active)
    throw Error("Operation requires an active Story job writer lease.");
  if (owner.job.jobId !== job.jobId || owner.job.stateDir !== job.stateDir ||
      owner.job.worktreeRoot !== job.worktreeRoot ||
      owner.job.worktreeStoryRoot !== job.worktreeStoryRoot ||
      owner.job.threadId !== job.threadId)
    throw Error("Active Story job writer lease belongs to a different Story or worktree.");
  if (allowedWorkItems && !allowedWorkItems.includes(owner.workItem))
    throw Error("Story job writer lease from " + owner.workItem +
      " does not authorize this nested operation.");
  return owner;
}

/** Explicitly permitted nested operation. Ordinary withStoryJobLock remains
 * non-reentrant; only named parent workflows may reuse their exact live lease.
 * Never infer authority from a matching PID or a stale AsyncLocalStorage frame.
 */
export async function withStoryJobLockOrReuse<T>(
  job: JobStartResult, workItem: string, allowedParents: readonly string[],
  run: () => Promise<T>,
): Promise<T> {
  if (!allowedParents.length)
    throw Error("Story job lease reuse must enumerate authorized parent work items.");
  const owner = activeStoryWriter();
  if (!owner) return withStoryJobLock(job, workItem, run);
  if (!owner.active) throw Error("Story job writer lease expired before nested operation.");
  // The private state directory is the lease's lock location. Separate Story
  // jobs may legitimately share a display job ID, but never inherit each
  // other's lock; an identity mismatch inside one state directory is rejected.
  if (owner.job.stateDir !== job.stateDir)
    return withStoryJobLock(job, workItem, run);
  requireStoryJobLease(job, allowedParents);
  return run();
}

interface Owner {
  version: 1;
  jobId: string;
  pid: number;
  host: string;
  nonce: string;
  workItem: string;
}

function isOwner(value: unknown, job: JobStartResult): value is Owner {
  const o = value as Partial<Owner> | null;
  return !!o && o.version === 1 && o.jobId === job.jobId &&
    Number.isSafeInteger(o.pid) && o.pid! > 0 && typeof o.host === "string" &&
    typeof o.nonce === "string" && /^[0-9a-f-]{36}$/.test(o.nonce) &&
    typeof o.workItem === "string";
}
async function readOwner(lock: string, job: JobStartResult): Promise<Owner> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(lock, "owner.json"), "utf8"));
    if (isOwner(parsed, job)) return parsed;
  } catch { /* An interrupted lock publication must never be assumed stale. */ }
  throw new Error("Story job lock has missing/corrupt owner metadata. Inspect the lock and worktree manually; no files were changed.");
}
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means an existing process that we cannot inspect.
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true;
  }
}

/**
 * One serialized mutation lane per Git-backed Story job, shared by all work
 * items. Stale PID locks can be *archived*, never discarded, only after their
 * original process is known to be gone and a reclaim guard is held.
 */
export async function withStoryJobLock<T>(
  job: JobStartResult, workItem: string, run: () => Promise<T>,
): Promise<T> {
  const owner = activeStoryWriter();
  if (owner && owner.job.stateDir === job.stateDir) {
    if (!owner.active) throw Error("Story job writer lease expired before nested acquisition.");
    requireStoryJobLease(job);
    throw Error("Nested Story job writer lock acquisition by " + workItem +
      " while " + owner.workItem + " owns it; explicit authorized lease reuse is required.");
  }
  return withJobLease(job, workItem, ".story-job", run);
}

/** Serialize parent checkpoint invocations without nesting the specialist writer lock. */
export async function withStoryGenerationLock<T>(job: JobStartResult, run: () => Promise<T>): Promise<T> {
  return withJobLease(job, "generation", ".story-generation", run);
}

async function withJobLease<T>(job: JobStartResult, workItem: string, prefix: string, run: () => Promise<T>): Promise<T> {
  const jobRoot = job.stateDir;
  const lock = join(jobRoot, prefix + "-running");
  const reclaim = join(jobRoot, prefix + "-reclaim");
  const owner: Owner = {
    version: 1, jobId: job.jobId, pid: process.pid,
    host: hostname(), nonce: randomUUID(), workItem,
  };
  let recoveredOwner: Owner | undefined;
  try {
    await mkdir(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let claimed = false;
    try {
      await mkdir(reclaim);
      claimed = true;
    } catch {
      throw new Error("Another process is reconciling the Story job lock; retry after inspecting its worktree.");
    }
    try {
      const previous = await readOwner(lock, job);
      if (previous.host !== hostname() || isAlive(previous.pid)) {
        throw new Error(`Story job is already owned by ${previous.workItem} (pid ${previous.pid} on ${previous.host}); simultaneous writes/resumes are forbidden.`);
      }
      // The stale owner is saved as an audit artifact; two would-be reclaimers
      // cannot both acquire the new lock because the guard is a mkdir.
      await rename(lock, join(jobRoot, `${prefix}-stale-${previous.nonce}`));
      recoveredOwner = previous;
      await mkdir(lock);
    } finally {
      if (claimed) await rmdir(reclaim);
    }
  }
  let published = false;
  const leaseContext: StoryWriterContext = { job, workItem, retainLease: false, active: true };
  try {
    await writeFile(join(lock, "owner.json"), JSON.stringify(owner) + "\n", { flag: "wx", mode: 0o600 });
    published = true;
    if (prefix === ".story-job") {
      return await storyWriter.run(leaseContext, async () => {
        if (recoveredOwner) saveDiagnostic(job, "interrupted", recoveredOwner.workItem);
        const specialist = isStorySpecialistLease(workItem);
        if (specialist) saveDiagnostic(job, "before-work", workItem);
        let failed = true;
        try {
          const result = await run();
          failed = false;
          return result;
        } finally {
          if (specialist) saveDiagnostic(job, failed ? "work-failed" : "after-work", workItem);
        }
      });
    }
    return await run();
  } finally {
    leaseContext.active = false;
    if (published && !(prefix === ".story-job" && leaseContext.retainLease)) {
      // If the owner changed unexpectedly, retain the lock and block future
      // operations. Never remove another process's lock.
      try {
        const actual = await readOwner(lock, job);
        if (actual.nonce === owner.nonce) {
          const { unlink } = await import("node:fs/promises");
          await unlink(join(lock, "owner.json"));
          await rmdir(lock);
        }
      } catch { /* Preserve ambiguous lock for manual reconciliation. */ }
    }
  }
}
