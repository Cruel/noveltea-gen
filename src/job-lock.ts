import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { mkdir, readFile, rename, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JobStartResult } from "./job.js";

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
  return withJobLease(job, workItem, ".story-job", run);
}

/** Serialize parent checkpoint invocations without nesting the specialist writer lock. */
export async function withStoryGenerationLock<T>(job: JobStartResult, run: () => Promise<T>): Promise<T> {
  return withJobLease(job, "generation", ".story-generation", run);
}

async function withJobLease<T>(job: JobStartResult, workItem: string, prefix: string, run: () => Promise<T>): Promise<T> {
  const jobRoot = dirname(job.worktreeRoot);
  const lock = join(jobRoot, prefix + "-running");
  const reclaim = join(jobRoot, prefix + "-reclaim");
  const owner: Owner = {
    version: 1, jobId: job.jobId, pid: process.pid,
    host: hostname(), nonce: randomUUID(), workItem,
  };
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
      await mkdir(lock);
    } finally {
      if (claimed) await rmdir(reclaim);
    }
  }
  let published = false;
  try {
    await writeFile(join(lock, "owner.json"), JSON.stringify(owner) + "\n", { flag: "wx", mode: 0o600 });
    published = true;
    return await run();
  } finally {
    if (published) {
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
