/**
 * Private diagnostic Git snapshots of the EXACT working Story files, including
 * invalid YAML, deletions and nonignored untracked files. These are NOT
 * verified generation checkpoints or author approvals.
 *
 * A disposable GIT_INDEX_FILE is populated from HEAD and the Story worktree;
 * the real index, worktree, HEAD and branch are never modified. A private ref
 * protects each resulting commit from Git garbage collection.
 */
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  realpathSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { JobStartResult } from "./job.js";

const SHA = /^[0-9a-f]{40}$/;
const ID = /^[0-9a-f-]{36}$/;
const PHASES = [
  "before-work",
  "after-work",
  "work-failed",
  "validation-attempt",
  "validation-failed",
  "review-failed",
  "interrupted",
] as const;
export type StorySnapshotPhase = (typeof PHASES)[number];
const protectedPhases = new Set<StorySnapshotPhase>([
  "work-failed",
  "validation-failed",
  "review-failed",
  "interrupted",
]);
const MAX_ROUTINE = 48;
const MAX_PATHS = 2048;
const MAX_STORY_BYTES = 32 * 1024 * 1024;

export interface StoryDebugSnapshot {
  version: 1;
  kind: "noveltea-story-debug-snapshot/v1";
  id: string;
  jobId: string;
  phase: StorySnapshotPhase;
  workItem: string;
  recordedAt: string;
  originalHead: string;
  commitSha: string;
  treeSha: string;
  ref: string;
  storyRelativePath: string;
  fileCount: number;
  changedPaths: string[];
}
const identity = (job: JobStartResult) =>
  createHash("sha256")
    .update(JSON.stringify([job.gitRoot, job.jobId]))
    .digest("hex");
const baseRef = (job: JobStartResult) => "refs/noveltea-gen/debug-snapshots/" + identity(job);
const snapshotsDir = (job: JobStartResult) => join(job.stateDir, "story-debug-snapshots");
const cleanGitEnv = (index?: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "NovelTea Debug Snapshot",
    GIT_AUTHOR_EMAIL: "noveltea-debug@users.noreply.github.com",
    GIT_COMMITTER_NAME: "NovelTea Debug Snapshot",
    GIT_COMMITTER_EMAIL: "noveltea-debug@users.noreply.github.com",
  };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_PREFIX",
    "GIT_NAMESPACE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  ])
    delete env[key];
  if (index) env.GIT_INDEX_FILE = index;
  return env;
};
function git(job: JobStartResult, args: string[], index?: string): string {
  return execFileSync("git", args, {
    cwd: job.worktreeRoot,
    env: cleanGitEnv(index),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    maxBuffer: 40 * 1024 * 1024,
  }).trim();
}
function requireJob(job: JobStartResult) {
  if (
    !job.stateDir ||
    !job.gitRoot ||
    !job.worktreeRoot ||
    !job.jobId ||
    !existsSync(job.worktreeStoryRoot) ||
    !inside(job.worktreeRoot, job.worktreeStoryRoot) ||
    !/^[a-zA-Z0-9._/-]*$/.test(job.storyRelativePath) ||
    job.storyRelativePath.split("/").some((s) => s === "." || s === "..")
  )
    throw Error("Debug snapshot requires an existing safe Job Story worktree.");
  const actual = git(job, ["rev-parse", "--show-toplevel"]);
  if (resolve(actual) !== resolve(job.worktreeRoot))
    throw Error("Debug snapshot Git worktree identity changed.");
}
function inside(root: string, file: string) {
  const rel = relative(root, file);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}
function readSnapshot(job: JobStartResult, file: string): StoryDebugSnapshot {
  const path = join(snapshotsDir(job), file);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192)
    throw Error("Unsafe Story snapshot receipt.");
  const receipt = JSON.parse(readFileSync(path, "utf8")) as StoryDebugSnapshot;
  if (
    !receipt ||
    receipt.version !== 1 ||
    receipt.kind !== "noveltea-story-debug-snapshot/v1" ||
    !ID.test(receipt.id) ||
    file !== receipt.id + ".json" ||
    receipt.jobId !== job.jobId ||
    !PHASES.includes(receipt.phase) ||
    !SHA.test(receipt.originalHead) ||
    !SHA.test(receipt.commitSha) ||
    !SHA.test(receipt.treeSha) ||
    !receipt.workItem ||
    receipt.storyRelativePath !== job.storyRelativePath ||
    receipt.ref !== baseRef(job) + "/" + receipt.id ||
    !Array.isArray(receipt.changedPaths) ||
    receipt.changedPaths.length > MAX_PATHS
  )
    throw Error("Story snapshot receipt is malformed or belongs to another Job.");
  return receipt;
}
export function listStorySnapshots(job: JobStartResult): StoryDebugSnapshot[] {
  requireJob(job);
  const directory = snapshotsDir(job);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((f) => ID.test(f.replace(/\.json$/, "")) && f.endsWith(".json"))
    .map((f) => readSnapshot(job, f))
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id));
}
function verifiedSnapshot(job: JobStartResult, id: string): StoryDebugSnapshot {
  if (!ID.test(id)) throw Error("Invalid Story snapshot identifier.");
  const receipt = readSnapshot(job, id + ".json");
  if (
    git(job, ["rev-parse", "--verify", receipt.ref + "^{commit}"]) !== receipt.commitSha ||
    git(job, ["rev-parse", receipt.commitSha + "^{tree}"]) !== receipt.treeSha ||
    git(job, ["rev-parse", receipt.commitSha + "^"]) !== receipt.originalHead
  )
    throw Error("Story snapshot Git ref, tree or parent differs from its receipt.");
  return receipt;
}
function trackedPaths(job: JobStartResult): string[] {
  // Git's -z format preserves filenames containing spaces and newlines.
  const selection = job.storyRelativePath ? ["--", ":(top,literal)" + job.storyRelativePath] : [];
  const data = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", ...selection],
    {
      cwd: job.worktreeRoot,
      env: cleanGitEnv(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
  const all = [
    ...new Set(
      data
        .split("\0")
        .filter(Boolean)
        .filter(
          (path) =>
            path.startsWith(prefix) &&
            // Private deferred ideas are never model input or debug snapshot content.
            !path.slice(prefix.length).startsWith(".story-inbox/"),
        ),
    ),
  ].sort();
  if (all.length > MAX_PATHS) throw Error("Story snapshot has too many files.");
  let total = 0;
  for (const path of all) {
    const absolute = join(job.worktreeRoot, path);
    if (!existsSync(absolute)) continue; // A tracked deletion belongs in the tree.
    const stat = lstatSync(absolute);
    if (!stat.isFile() && !stat.isSymbolicLink())
      throw Error("Cannot snapshot a non-file Story entry: " + path);
    total += stat.size;
    if (total > MAX_STORY_BYTES) throw Error("Story debug snapshot exceeds 32 MiB.");
  }
  return all;
}
/** Capture without touching the current Git index, HEAD or Story worktree. */
export function captureStorySnapshot(
  job: JobStartResult,
  phase: StorySnapshotPhase,
  workItem: string,
  options: { sourceCommit?: string } = {},
): StoryDebugSnapshot {
  requireJob(job);
  if (!PHASES.includes(phase) || !workItem || workItem.length > 180 || !/^[a-zA-Z0-9.:_-]+$/.test(workItem))
    throw Error("Invalid Story snapshot boundary.");
  const head = git(job, ["rev-parse", "HEAD"]);
  if (!SHA.test(head)) throw Error("Story snapshot needs an exact Git HEAD.");
  const temp = mkdtempSync(join(tmpdir(), "nt-story-debug-"));
  let createdRef: string | undefined;
  try {
    let tree: string;
    let parent = head;
    let paths: string[];
    if (options.sourceCommit) {
      // Reviewer failure refers to the EXACT original committed source.
      if (!SHA.test(options.sourceCommit)) throw Error("Review source must be a full commit SHA.");
      git(job, ["merge-base", "--is-ancestor", options.sourceCommit, head]);
      parent = options.sourceCommit;
      tree = git(job, ["rev-parse", parent + "^{tree}"]);
      paths = [];
    } else {
      paths = trackedPaths(job);
      const index = join(temp, "index");
      git(job, ["read-tree", "HEAD"], index);
      // Stage precisely the source Story's nonignored files, including
      // deletions/untracked files, in an isolated index. No host Git add.
      if (paths.length) {
        // Exclude the private inbox even if Git tracks it.
        git(job, ["add", "-A", "--", ...paths.map((p) => ":(top,literal)" + p)], index);
      }
      tree = git(job, ["write-tree"], index);
    }
    if (!SHA.test(tree)) throw Error("Story snapshot Git tree could not be created.");
    const committed = git(job, [
      "commit-tree",
      tree,
      "-p",
      parent,
      "-m",
      "NovelTea diagnostic Story snapshot (" + phase + ")",
    ]);
    if (!SHA.test(committed)) throw Error("Story snapshot commit was not created.");
    const id = randomUUID(),
      ref = baseRef(job) + "/" + id;
    git(job, ["update-ref", ref, committed, "0".repeat(40)]);
    createdRef = ref;
    const changed = git(job, ["diff-tree", "--no-commit-id", "--name-only", "-r", committed])
      .split("\n")
      .filter(Boolean);
    const record: StoryDebugSnapshot = {
      version: 1,
      kind: "noveltea-story-debug-snapshot/v1",
      id,
      jobId: job.jobId,
      phase,
      workItem,
      recordedAt: new Date().toISOString(),
      originalHead: parent,
      commitSha: committed,
      treeSha: tree,
      ref,
      storyRelativePath: job.storyRelativePath,
      fileCount: paths.length,
      changedPaths: changed,
    };
    const directory = snapshotsDir(job);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, id + ".json"),
      candidate = join(temp, "receipt.json");
    writeFileSync(candidate, JSON.stringify(record, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(candidate, file);
    createdRef = undefined;
    return record;
  } catch (error) {
    if (createdRef) {
      try {
        git(job, ["update-ref", "-d", createdRef]);
      } catch {
        /* Preserve otherwise orphaned ref. */
      }
    }
    throw error;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
/** Retention applies only to routine snapshots. Failures/interruption are
 * preserved until explicitly deleted by the operator. */
export function pruneRoutineStorySnapshots(job: JobStartResult, keep = MAX_ROUTINE) {
  if (!Number.isSafeInteger(keep) || keep < 0 || keep > 100_000)
    throw Error("Invalid routine Story snapshot retention limit.");
  const routine = listStorySnapshots(job).filter((item) => !protectedPhases.has(item.phase));
  const toPrune = routine.slice(0, Math.max(0, routine.length - keep));
  for (const item of toPrune) {
    verifiedSnapshot(job, item.id);
    git(job, ["update-ref", "-d", item.ref, item.commitSha]);
    unlinkSync(join(snapshotsDir(job), item.id + ".json"));
  }
  return toPrune.length;
}
/** Independent local checkout: never resets the Job branch or worktree.
 * --no-hardlinks makes a durable independent clone, not a borrowed alternates
 * store whose underlying Git objects could disappear after pruning. */
export function restoreStorySnapshot(job: JobStartResult, id: string, destination: string) {
  requireJob(job);
  const point = verifiedSnapshot(job, id);
  const full = resolve(destination);
  // Resolve existing ancestors; a symlinked parent must not redirect a restore
  // inside the live repository, worktree or durable Job state.
  let ancestor = full;
  const missing: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw Error("No safe existing restore ancestor.");
    missing.unshift(ancestor.slice(parent.length + (parent.endsWith("/") ? 0 : 1)));
    ancestor = parent;
  }
  const canonical = resolve(realpathSync(ancestor), ...missing);
  if (
    existsSync(canonical) ||
    inside(job.gitRoot, canonical) ||
    inside(job.stateDir, canonical) ||
    inside(job.worktreeRoot, canonical)
  )
    throw Error("Restore requires a new isolated directory outside Job, repository and state.");
  mkdirSync(dirname(canonical), { recursive: true });
  const env = cleanGitEnv();
  try {
    execFileSync(
      "git",
      ["clone", "--quiet", "--no-checkout", "--no-hardlinks", "--no-local", "--", job.gitRoot, canonical],
      {
        env: { ...env, GIT_ALLOW_PROTOCOL: "file" },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    // The diagnostic commit is referenced only in the job's private refs,
    // not necessarily advertised by clone. Fetch the exact ref explicitly.
    execFileSync(
      "git",
      ["fetch", "--quiet", "--no-tags", "--", job.gitRoot, point.ref + ":refs/noveltea-gen/restored"],
      {
        cwd: canonical,
        env: { ...env, GIT_ALLOW_PROTOCOL: "file" },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    execFileSync("git", ["checkout", "--quiet", "--detach", point.commitSha], {
      cwd: canonical,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    if (
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: canonical,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim() !== point.commitSha
    )
      throw Error("Isolated restore did not checkout the recorded Story snapshot.");
    return { destination: canonical, story: join(canonical, point.storyRelativePath), snapshot: point };
  } catch (error) {
    rmSync(canonical, { recursive: true, force: true });
    throw error;
  }
}
