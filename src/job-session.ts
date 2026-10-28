import { existsSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import type { JobStartResult } from "./job.js";

/** Verify the original persisted Pi conversation, never silently replace it. */
export async function verifyJobPiSession(
  job: JobStartResult,
  kind: "foundation" | "architecture" | "world" | "character",
  file: string | undefined,
  id: string | undefined,
): Promise<void> {
  const sessions = kind === "world" || kind === "character"
    ? join(dirname(job.worktreeRoot), "character-world-sessions", kind) + sep
    : join(dirname(job.worktreeRoot), kind + "-sessions") + sep;
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
