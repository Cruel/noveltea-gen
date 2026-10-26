import { homedir } from "node:os";
import { join, resolve, dirname, relative, isAbsolute, sep } from "node:path";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { SessionManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { projectSessionDir, type StoryProject } from "./project.js";

/**
 * All application checkpoint data is outside the Story root. This preserves
 * empty Story projects, and canonical-path hashes isolate the state namespaces.
 */
export function stateDirectory(project: StoryProject): string {
  const base = process.env.NT_STATE_DIR || join(
    process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
    "noveltea-gen",
  );
  return join(resolve(base), project.id);
}

export function checkpointPath(project: StoryProject): string {
  return join(stateDirectory(project), "checkpoints.sqlite");
}

export type ExecutionMode = "pi" | "fixture";

export function sessionDirectory(project: StoryProject, mode: ExecutionMode): string {
  return mode === "fixture"
    ? join(stateDirectory(project), "fixture-sessions")
    : projectSessionDir(project, getAgentDir());
}

export interface PiSessionReference {
  id: string;
  file: string;
}

/**
 * SessionManager.open() can create a new conversation if its input is missing.
 * Validate the exact persisted file and header FIRST; never silently replace
 * a missing, symlinked or incorrectly scoped session during recovery.
 */
export async function openPersistedSession(
  project: StoryProject,
  mode: ExecutionMode,
  ref: PiSessionReference,
): Promise<SessionManager> {
  const expectedDir = sessionDirectory(project, mode);
  if (typeof ref.id !== "string" || !ref.id.trim() ||
      typeof ref.file !== "string" || !isAbsolute(ref.file) ||
      !ref.file.endsWith(".jsonl")) {
    throw new Error("Cannot recover Pi session: invalid persisted session reference.");
  }
  try {
    const canonicalDir = await realpath(expectedDir);
    const canonicalFile = await realpath(ref.file);
    const pathWithin = relative(canonicalDir, canonicalFile);
    if (dirname(canonicalFile) !== canonicalDir ||
        pathWithin === ".." || pathWithin.startsWith(`..${sep}`) || isAbsolute(pathWithin) ||
        canonicalFile !== resolve(ref.file)) {
      throw new Error("session path escapes its project-specific session store");
    }
    const info = await stat(canonicalFile);
    if (!info.isFile()) throw new Error("session path is not a regular file");
    // Pi intentionally tolerates malformed JSONL lines during ordinary loading.
    // Recovery must fail closed instead of silently omitting damaged history.
    const transcript = await readFile(canonicalFile, "utf8");
    if (!transcript.endsWith("\n")) throw new Error("truncated Pi session history");
    for (const line of transcript.split("\n")) {
      if (!line.trim()) continue;
      const entry: unknown = JSON.parse(line);
      if (typeof entry !== "object" || !entry || Array.isArray(entry)) {
        throw new Error("malformed Pi session entry");
      }
    }
    const manager = SessionManager.open(canonicalFile, canonicalDir);
    const header = manager.getHeader();
    if (header?.cwd !== project.root || header.id !== ref.id ||
        manager.getSessionId() !== ref.id ||
        !manager.buildSessionContext().messages.some((message) => message.role === "user")) {
      throw new Error("session header, history, or Story project identity mismatch");
    }
    return manager;
  } catch {
    throw new Error(
      "Cannot recover Pi session: missing, unreadable, corrupted, or from a different Story project. " +
      "Restore the original session JSONL file before retrying; a new conversation was not created.",
    );
  }
}

export async function openCheckpointer(project: StoryProject, resume: boolean): Promise<SqliteSaver> {
  const path = checkpointPath(project);
  if (resume) {
    try {
      const info = await stat(path);
      if (!info.isFile()) throw new Error("not a file");
    } catch {
      throw new Error(
        "Cannot resume: no SQLite checkpoint for this Story root. " +
        "Use the original project and --thread, or start a new run.",
      );
    }
  } else {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  }
  try {
    const saver = SqliteSaver.fromConnString(path);
    const integrity = saver.db.pragma("quick_check", { simple: true });
    if (integrity !== "ok") throw new Error("SQLite integrity check failed");
    return saver;
  } catch {
    throw new Error(
      "Cannot read SQLite checkpoint: database is corrupt, inaccessible or incompatible. " +
      "Restore a valid checkpoint backup before attempting --resume.",
    );
  }
}
