import { createHash } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface StoryProject {
  /** Canonical absolute path, independent of how it was entered on the CLI. */
  root: string;
  /** Stable digest of the canonical root, for namespacing graph threads. */
  id: string;
}

/** Resolve and validate an explicitly selected Story project. Never scaffold a game. */
export async function openStoryProject(input: string, create = false): Promise<StoryProject> {
  if (!input.trim()) throw new Error("Missing required --project <path>.");
  const requested = resolve(input);
  if (create) {
    try {
      await mkdir(requested, { recursive: true });
    } catch (error) {
      throw new Error(`Unable to create Story project at "${requested}": ${fsReason(error)}`);
    }
  }
  let root: string;
  try {
    root = await realpath(requested);
    const info = await stat(root);
    if (!info.isDirectory()) throw new Error("Path is not a directory");
  } catch (error) {
    throw new Error(
      `Invalid Story project "${requested}": ${fsReason(error)}. ` +
      "Select an existing directory or use --create-project to create an empty one.",
    );
  }
  return {
    root,
    id: createHash("sha256").update(root).digest("hex"),
  };
}

function fsReason(error: unknown): string {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    return "directory does not exist";
  }
  return error instanceof Error ? error.message : "filesystem error";
}

/** A user-supplied thread name never identifies state in a different project. */
export function scopeThread(project: StoryProject, threadId: string): string {
  return `${project.id}:${threadId}`;
}

/**
 * Pi's default session folder encoding replaces path separators with hyphens,
 * which can collide (e.g. /a-b/c and /a/b-c). Use a SHA-256 namespace instead.
 */
export function projectSessionDir(project: StoryProject, agentDir: string): string {
  return join(agentDir, "sessions", `--noveltea-gen-${project.id}--`);
}

/**
 * Read only the selected root's AGENTS.md (or CLAUDE.md fallback).
 * Do not read ~/.pi/agent/AGENTS.md or unrelated ancestor directory context.
 */
export function projectInstructions(project: StoryProject): Array<{ path: string; content: string }> {
  for (const basename of ["AGENTS.md", "CLAUDE.md"]) {
    const path = join(project.root, basename);
    try {
      lstatSync(path);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    // lstat (rather than existsSync) detects broken symlinks instead of
    // silently skipping malformed project instructions.
    const target = realpathSync(path);
    if (!isInside(project.root, target)) {
      throw new Error(`Project instructions "${path}" resolve outside the selected Story root.`);
    }
    return [{ path, content: readFileSync(target, "utf8") }];
  }
  return [];
}

function isInside(root: string, target: string): boolean {
  const within = relative(root, target);
  return within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within);
}
