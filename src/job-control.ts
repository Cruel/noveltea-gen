import { existsSync } from "node:fs";
import { readFile, mkdir, rename, rmdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { JobStartResult } from "./job.js";

export type JobControl = "running" | "paused" | "cancelled" | "completed";
const controlFile = (job: JobStartResult) =>
  join(job.stateDir, "author-updates", "control.json");

export async function readJobControl(job: JobStartResult): Promise<JobControl> {
  const file = controlFile(job);
  if (!existsSync(file)) return "running";
  const data = JSON.parse(await readFile(file, "utf8")) as {
    version?: number; jobId?: string; state?: JobControl;
  };
  if (data.version !== 1 || data.jobId !== job.jobId ||
      !["running", "paused", "cancelled", "completed"].includes(data.state ?? "")) {
    throw new Error("Invalid job execution control state.");
  }
  return data.state!;
}

/** An atomic, cross-process control intent. Cancellation is a request, not
 * evidence that the running specialist has stopped. */
export async function setJobControl(job: JobStartResult, next: JobControl): Promise<void> {
  const file = controlFile(job);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  // A shared writer lock cannot be used for this operation: cancellation must
  // arrive WHILE that lock is held. Serialize only concurrent control changes,
  // so a racing 'running' command cannot overwrite a terminal cancellation.
  const gate = join(dirname(file), ".control-update");
  try { await mkdir(gate); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("Another author control transition is underway; inspect the control state before retrying.");
    }
    throw error;
  }
  try {
    const previous = await readJobControl(job);
    if (["cancelled", "completed"].includes(previous) && next !== previous) {
      throw new Error("Canceled or completed jobs cannot be restarted by a new author message.");
    }
    const temp = file + "." + randomUUID() + ".tmp";
    await writeFile(temp, JSON.stringify({
      version: 1, jobId: job.jobId, state: next, at: new Date().toISOString(),
    }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temp, file);
  } finally {
    await rmdir(gate);
  }
}
