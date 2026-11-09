import { existsSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import type { JobStartResult } from "./job.js";

/** Verify the original persisted Pi conversation, never silently replace it. */
export async function verifyJobPiSession(
  job: JobStartResult,
  kind: "foundation" | "architecture" | "world" | "character" | "event",
  file: string | undefined,
  id: string | undefined,
  workItem?: string,
): Promise<void> {
  if (kind === "event" && (!workItem || !/^event-[a-z][a-z0-9-]*$/.test(workItem)))
    throw new Error("Event session requires a pinned specialist work item.");
  const sessions = kind === "event" ? join(job.stateDir, "event-sessions", workItem!) + sep :
    kind === "world" || kind === "character"
      ? join(job.stateDir, "character-world-sessions", kind) + sep
      : join(job.stateDir, kind + "-sessions") + sep;
  if (!file || !file.startsWith(sessions) || !existsSync(file) ||
      await realpath(file) !== file || !(await lstat(file)).isFile()) {
    throw new Error("Cannot recover Pi session: original " + kind +
      " transcript is missing or unsafe. Restore its exact file; no new conversation will be created.");
  }
  try {
    const records: unknown[] = (await readFile(file, "utf8")).trim().split("\n")
      .map(line => JSON.parse(line) as unknown);
    const header = records[0] as { type?: unknown; id?: unknown } | undefined;
    if (header?.type !== "session" || typeof header.id !== "string" ||
        !header.id || (id !== undefined && header.id !== id)) {
      throw new Error("Session header/identity mismatch");
    }
  } catch {
    throw new Error("Cannot recover Pi session: original " + kind +
      " transcript is corrupt or differs from the recorded session identity.");
  }
}
