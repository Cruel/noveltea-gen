import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobStartResult } from "./job.js";
import { trustedHead } from "./revision.js";
import { readChatApprovedFoundation } from "./chat-approved-foundation.js";

export type ReusedFoundation = {
  version: 1;
  jobId: string;
  sourceSha: string;
  originalObjective: string;
};

const path = (job: JobStartResult) => join(job.stateDir, "chat-reused-foundation.json");

/** Only the controller calls this after validating the pinned native catalog.
 * The receipt records a read-only fulfillment, not a fabricated author
 * approval or an authorization to modify protected Creative Decisions. */
export async function pinReusedFoundation(job: JobStartResult, objective: string) {
  const head = await trustedHead(job);
  let initialized = false;
  if (head !== job.baseSha) {
    try {
      const marker = JSON.parse(await readFile(join(job.stateDir, "revisions",
        "verified-head.json"), "utf8")) as {
        version?: number; jobId?: string; headSha?: string; workItemId?: string;
      };
      initialized = marker.version === 1 && marker.jobId === job.jobId &&
        marker.headSha === head && marker.workItemId === "story-initialization";
    } catch { /* No unverified revision may be adopted implicitly. */ }
  }
  if (!objective.trim() || (head !== job.baseSha && !initialized) ||
      await readChatApprovedFoundation(job))
    throw new Error("Cannot reuse a modified, untrusted or separately approved foundation.");
  const state: ReusedFoundation = {
    version: 1, jobId: job.jobId, sourceSha: job.baseSha, originalObjective: objective,
  };
  const serialized = JSON.stringify(state, null, 2) + "\n";
  try { await writeFile(path(job), serialized, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readReusedFoundation(job);
    if (JSON.stringify(existing) !== JSON.stringify(state))
      throw new Error("Foundation reuse belongs to a different original Turn.");
  }
}

export async function readReusedFoundation(job: JobStartResult): Promise<ReusedFoundation | null> {
  let raw: string;
  try { raw = await readFile(path(job), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const receipt = JSON.parse(raw) as ReusedFoundation;
  if (receipt?.version !== 1 || receipt.jobId !== job.jobId ||
      receipt.sourceSha !== job.baseSha || !receipt.originalObjective?.trim())
    throw new Error("Saved read-only foundation reuse has invalid job identity.");
  return receipt;
}
