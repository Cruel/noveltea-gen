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
const sha = (request: GenerationRequest) => createHash("sha256")
  .update(JSON.stringify(request)).digest("hex");

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
      saved.threadId !== expected.threadId || saved.requestSha256 !== expected.requestSha256) {
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
      saved.threadId !== threadId || saved.requestSha256 !== sha(request))
    throw new Error("Existing server owner receipt conflicts with the pinned queue request.");
}
export function ensureNotServerOwned(job: JobStartResult): void {
  if (existsSync(file(job)))
    throw new Error("This Story job belongs to a server-owned generation thread; CLI checkpoint takeover is forbidden.");
}
