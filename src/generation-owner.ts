import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobStartResult } from "./job.js";
import type { GenerationRequest } from "./generation.js";

interface Owner {
  schema: "noveltea-generation-owner/v1";
  jobId: string;
  threadId: string;
  requestSha256: string;
}
const file = (job: JobStartResult) => join(job.stateDir, "generation-server-owner.json");
// LangGraph's Zod validation can reorder object keys without changing the
// pinned request. A byte-for-byte JSON digest would then mistake the graph's
// own scheduling step for an unrelated writer. Sort keys at every depth, but
// retain array order and all serialized values in the ownership identity.
function canonicalRequestJson(request: GenerationRequest): string {
  return JSON.stringify(request, (_key, value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map(key => [key, object[key]]));
  });
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const sha = (request: GenerationRequest) => digest(canonicalRequestJson(request));
// Historical receipts remain forensic evidence, not executable ownership.
// Only an exact canonical current request can reclaim its original writer.
const matches = (saved: string, request: GenerationRequest) => saved === sha(request);

export const sameGenerationRequest = (left: GenerationRequest, right: GenerationRequest): boolean =>
  canonicalRequestJson(left) === canonicalRequestJson(right);

/**
 * API/Studio and CLI must not take turns writing one Git job from different
 * checkpoint stores. Bind the FIRST server thread and exact request durably.
 * A second server thread, changed contract, or CLI resume is denied.
 *
 * This file is deliberate durable ownership, not a stale process lease: it
 * survives server restarts, and is never silently reset or reassigned.
 */
export async function claimServerGeneration(job: JobStartResult, threadId: string | undefined,
  request: GenerationRequest): Promise<void> {
  if (!threadId || typeof threadId !== "string")
    throw new Error("Generation requires a durable server thread identity.");
  if (existsSync(join(job.stateDir, "generation.sqlite")) ||
      existsSync(join(job.stateDir, ".story-generation-running"))) {
    throw new Error("This Story job has a CLI generation checkpoint or active CLI generation; server takeover is forbidden.");
  }
  const expected: Owner = {
    schema: "noveltea-generation-owner/v1", jobId: job.jobId,
    threadId, requestSha256: sha(request),
  };
  try {
    await writeFile(file(job), JSON.stringify(expected) + "\n", { flag: "wx", mode: 0o600 });
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  let saved: Owner;
  try {
    saved = JSON.parse(await readFile(file(job), "utf8")) as Owner;
  } catch {
    throw new Error("Generation server owner receipt is unreadable; inspect and restore it before retrying.");
  }
  if (saved.schema !== expected.schema || saved.jobId !== expected.jobId ||
      saved.threadId !== expected.threadId || !matches(saved.requestSha256, request)) {
    throw new Error("Story generation is already bound to another thread or pinned request; no second writer is allowed.");
  }
}
/** Read-only preflight for queue admission: an owner receipt may already
 * exist after a crash, but a queued item must not create one until dispatched. */
export async function assertServerClaimPermitted(job: JobStartResult,
  threadId: string, request: GenerationRequest): Promise<void> {
  if (existsSync(join(job.stateDir, "generation.sqlite")) ||
      existsSync(join(job.stateDir, ".story-generation-running")))
    throw new Error("CLI generation checkpoint exists; server takeover is forbidden.");
  if (!existsSync(file(job))) return;
  let saved: Owner;
  try { saved = JSON.parse(await readFile(file(job), "utf8")) as Owner; }
  catch { throw new Error("Server ownership receipt unreadable; manual inspection required."); }
  if (saved.schema !== "noveltea-generation-owner/v1" || saved.jobId !== job.jobId ||
      saved.threadId !== threadId || !matches(saved.requestSha256, request))
    throw new Error("Existing server owner receipt conflicts with the pinned queue request.");
}
export function ensureNotServerOwned(job: JobStartResult): void {
  if (existsSync(file(job)))
    throw new Error("This Story job belongs to a server-owned generation thread; CLI checkpoint takeover is forbidden.");
}
