/** One source-bound policy for adaptive Story reads: the planner's sandbox
 * exposure, its admitted receipt, and replay-free restoration.
 *
 * The root README.txt is ancillary context only. It never satisfies a
 * canonical Story record or required pinned methodology read.
 */
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { JobStartResult } from "./job.js";
import { dependencyGit } from "./dependency-state.js";

const SHA = /^[a-f0-9]{40}$/;
const regular = new Set(["100644", "100755"]);
const canonical = /^[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*\.md$/;

export function adaptiveStoryReadKind(path: string): "canonical" | "ancillary" | null {
  if (path === "README.txt") return "ancillary";
  return canonical.test(path) ? "canonical" : null;
}

/** Refuse traversal rather than silently normalizing it to another authorized
 * file. Both an absolute Pi read and a stored absolute source path use this. */
export function adaptiveStoryReadPath(job: JobStartResult, requested: string): string {
  const components = requested.startsWith("/") ? requested.slice(1).split("/") : requested.split("/");
  if (!requested || requested.includes("\0") || requested.includes("\\") ||
      components.some(part => !part || part === "." || part === ".."))
    throw Error("Adaptive Story read has an unsafe or traversing path.");
  const root = resolve(job.worktreeStoryRoot);
  const absolute = resolve(root, requested);
  const rel = relative(root, absolute);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep) ||
      !adaptiveStoryReadKind(rel.split(sep).join("/")))
    throw Error("Adaptive Story read is not an authorized canonical file or root README.txt.");
  return rel.split(sep).join("/");
}

function gitPath(job: JobStartResult, rel: string): string {
  return job.storyRelativePath ? job.storyRelativePath.replace(/\/$/, "") + "/" + rel : rel;
}

function parseTreeEntries(output: string): Array<{ mode: string; type: string; hash: string; path: string }> {
  return output.split("\0").filter(Boolean).map(line => {
    const match = /^(\d{6}) (\w+) ([0-9a-f]{40})\t(.+)$/.exec(line);
    if (!match) throw Error("Adaptive source tree has an invalid Git entry.");
    return { mode: match[1]!, type: match[2]!, hash: match[3]!, path: match[4]! };
  });
}

/** At the exact verified proposal source: a tracked, ordinary Git blob.
 * Git symlinks are blobs with mode 120000, which must never be read. */
export function assertAdaptiveTrackedRead(job: JobStartResult, sourceSha: string,
  requested: string): { relativePath: string; blob: string } {
  if (!SHA.test(sourceSha)) throw Error("Adaptive Story read lost its pinned Git source.");
  const relativePath = adaptiveStoryReadPath(job, requested);
  const path = gitPath(job, relativePath);
  const entries = parseTreeEntries(dependencyGit(job, "ls-tree", "-z", sourceSha, "--", path));
  const found = entries.find(e => e.path === path);
  if (!found || found.type !== "blob" || !regular.has(found.mode))
    throw Error("Adaptive Story read is absent, untracked or not a regular file at its original verified Git commit.");
  return { relativePath, blob: found.hash };
}

export function adaptiveTrackedReadPaths(job: JobStartResult, sourceSha: string): string[] {
  if (!SHA.test(sourceSha)) throw Error("Adaptive Story read lost its pinned Git source.");
  const prefix = job.storyRelativePath ? job.storyRelativePath.replace(/\/$/, "") + "/" : "";
  return parseTreeEntries(dependencyGit(job, "ls-tree", "-rz", sourceSha,
    ...(prefix ? ["--", prefix] : [])))
    .filter(e => e.path.startsWith(prefix) && e.type === "blob" && regular.has(e.mode))
    .map(e => e.path.slice(prefix.length))
    .filter(path => adaptiveStoryReadKind(path) !== null);
}

/** The sandbox reads the worktree, so check the actual path and bytes against
 * the pinned Git object before exposure; a symlink or dirty replacement cannot
 * borrow the committed file's read grant. */
export async function assertAdaptiveExposedRead(job: JobStartResult, sourceSha: string,
  requested: string): Promise<string> {
  const { relativePath, blob } = assertAdaptiveTrackedRead(job, sourceSha, requested);
  const path = join(job.worktreeStoryRoot, relativePath);
  const st = await lstat(path).catch(() => null);
  if (!st?.isFile() || st.isSymbolicLink() ||
      await realpath(path) !== resolve(path))
    throw Error("Adaptive Story read resolves to an unsafe or missing worktree file.");
  if (dependencyGit(job, "hash-object", "--", path) !== blob)
    throw Error("Adaptive Story read differs from the pinned Git source.");
  return relativePath;
}
