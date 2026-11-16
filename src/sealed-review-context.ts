import { execFileSync } from "./git-read-cache.js";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { JobStartResult } from "./job.js";
import { assertNativeVersion, nativeExecutable } from "./native-cli-version.js";
import { StoryContextReader } from "./story-context.js";

const directories = new Set(["creative-direction", "arcs", "milestones", "characters",
  "relationships", "world-entities", "facts", "revelations", "events", "authored-content",
  "choice-points", "puzzles", "narrative-positions"]);
const safePath = (path: string) => /^[a-z][a-z-]*\/[a-z0-9][a-z0-9._-]*\.md$/.test(path) &&
  directories.has(path.split("/")[0]!);
export interface SealedReviewRecord {
  path: string;
  content: string;
  commitSha: string;
  blobSha: string;
}

/** The native resolver sees a disposable, bounded snapshot, never the mutable
 * worktree or private inbox. Its selected paths are checked against the sealed
 * Git tree; only those blobs enter the reviewer packet. No write authority is
 * inferred from native context membership. */
export async function loadSealedReviewContext(job: JobStartResult, commitSha: string,
  seeds: string[]): Promise<SealedReviewRecord[]> {
  if (!/^[a-f0-9]{40}$/.test(commitSha) || !seeds.length || seeds.length > 32 ||
      seeds.some(path => !safePath(path))) throw Error("Unsafe sealed review source or paths.");
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"])
    delete env[key];
  const git = (...args: string[]) => execFileSync("git", args, { cwd: job.worktreeRoot,
    env, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  const prefix = job.storyRelativePath;
  if (prefix && !prefix.split("/").every(p => /^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(p)))
    throw Error("Unsafe sealed Story root.");
  const tree = git("ls-tree", "-r", "-l", "-z", commitSha + (prefix ? ":" + prefix : ""));
  const blobs = new Map<string, { sha: string }>();
  let size = 0;
  for (const entry of tree.split("\0").filter(Boolean)) {
    const match = entry.match(/^(\d+) (\w+) ([a-f0-9]{40}) +(-|\d+)\t(.+)$/);
    if (!match) throw Error("Malformed sealed Story tree.");
    const [, mode, type, sha, bytes, path] = match;
    if (!directories.has(path!.split("/")[0]!)) continue;
    if (!safePath(path!) || !["100644", "100755"].includes(mode!) || type !== "blob")
      throw Error("Unsafe canonical record in sealed Story tree.");
    size += Number(bytes);
    if (Number(bytes) > 128 * 1024 || size > 8 * 1024 * 1024 || blobs.size >= 1024)
      throw Error("Sealed review snapshot exceeds bounded size/count.");
    blobs.set(path!, { sha: sha! });
  }
  if (seeds.some(path => !blobs.has(path))) throw Error("Pinned canonical review context is missing.");
  assertNativeVersion(job.validatorVersion);
  const root = await mkdtemp(join(tmpdir(), "nt-review-context-"));
  try {
    for (const [path, blob] of blobs) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), git("cat-file", "blob", blob.sha), { flag: "wx" });
    }
    // Native catalog supplies typed IDs; do not infer IDs or parse YAML locally.
    const catalogRun = spawnSync(nativeExecutable(), ["--json", "narrative", "validate", root],
      { env, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    if (catalogRun.error || catalogRun.status !== 0)
      throw Error("Native sealed review catalog could not be verified.");
    const catalog = JSON.parse(catalogRun.stdout).catalog as {
      records?: Array<{ path: string; metadata: {
        id: string; type: string;
        prerequisites?: { any_of?: Array<{ conditions?: Array<{
          kind: string; choice_point?: string }> }> };
        steps?: Array<{ branches?: Array<{
          conditions?: Array<{ kind: string; choice_point?: string }>;
          effects?: Array<{ kind: string; choice_point?: string }>
        }> }>;
      } }> };
    const catalogRecords = catalog?.records ?? [];
    const choices = new Set(seeds.flatMap(path => catalogRecords
      .filter(r => r.path === path && r.metadata.type === "choice-point")
      .map(r => r.metadata.id)));
    // A changed Choice may select an outcome in one Event and consume the
    // other outcome in an unchanged downstream Event. Related-context search
    // does not reliably bring in that consumer, causing false review failures.
    // Use native-typed metadata at the EXACT sealed commit, never YAML parsing
    // or a mutable worktree, to add both sides as read-only review evidence.
    const touchesChoice = (effect: { kind: string; choice_point?: string }) =>
      effect.kind === "outcome" && choices.has(effect.choice_point ?? "");
    const linked = choices.size ? catalogRecords.filter(r => r.metadata.type === "event" &&
      (r.metadata.prerequisites?.any_of ?? []).some(route =>
        (route.conditions ?? []).some(touchesChoice)) ||
      (r.metadata.steps ?? []).some(step => (step.branches ?? []).some(branch =>
        (branch.conditions ?? []).some(touchesChoice) ||
        (branch.effects ?? []).some(touchesChoice)))) : [];
    const paths = [...new Set([...seeds, ...linked.map(record => record.path)])];
    if (paths.length > 32 || paths.some(path => !blobs.has(path)))
      throw Error("Sealed Choice review context exceeds bounded native source inventory.");
    const ids = paths.map(path => catalogRecords.find(r => r.path === path)?.metadata.id);
    if (ids.some(id => typeof id !== "string")) throw Error("Missing native review seed identity.");
    const context = await new StoryContextReader({ root, cli: nativeExecutable(), initialPaths: paths,
      task: { kind: "review", ids: ids as string[], scope: "related" },
    }).get({ batchLimit: 32 });
    if (context.pending.length || context.loaded.length > 32)
      throw Error("Reviewer context exceeds bounded path count/size.");
    const records = context.loaded.map(record => {
      const blob = blobs.get(record.path);
      if (!safePath(record.path) || !blob || record.content !== git("cat-file", "blob", blob.sha))
        throw Error("Review context differs from sealed canonical source.");
      return { path: record.path, content: record.content, commitSha, blobSha: blob.sha };
    }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    if (Buffer.byteLength(JSON.stringify(records)) > 128 * 1024)
      throw Error("Reviewer canonical context exceeds bounded size.");
    return records;
  } finally { await rm(root, { recursive: true, force: true }); }
}
