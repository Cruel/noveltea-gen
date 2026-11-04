import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

interface JobManifest {
  version: 1;
  jobId: string;
  gitRoot: string;
  gitCommonDir: string;
  storyRoot: string;
  storyRelativePath: string;
  novelteaProjectRoot?: string;
  baseSha: string;
  branch: string;
  /** Durable receipts, sessions and checkpoints; never inside the evictable cache. */
  stateDir?: string; // absent in legacy manifests
  /** Pinned worktree cache root; absent in legacy manifests. */
  cacheRoot?: string;
  worktreeRoot: string;
  worktreeStoryRoot: string;
  threadId: string;
  /** Set on first validation; missing validator receipt after this is fatal. */
  validatorSha256?: string;
}

export interface JobStartResult extends Omit<JobManifest, "version" | "gitCommonDir" | "stateDir"> {
  stateDir: string;
  status: "ready";
  headSha: string;
}

export interface JobStartOptions {
  story: string;
  job: string;
  novelteaProject?: string;
  /** Trusted controller-selected per-repository cache root; overrides NT_GIT_CACHE_DIR. */
  worktreeCacheRoot?: string;
  /** Trusted controller only: exact local commit selected after source/checkpoint
   * authorization. This primitive does NOT certify a checkpoint or initialize
   * generation continuation. Never accept a browser-provided SHA directly. */
  pinnedBaseSha?: string;
  /** Trusted server only: populate just the selected Story in each new linked worktree. */
  sparseStoryOnly?: boolean;
  /** Ephemeral authenticated Git transport configuration; never written to a job receipt. */
  gitTransportEnv?: NodeJS.ProcessEnv;
}

function git(cwd: string, ...args: string[]): string {
  return gitWithEnv(cwd, undefined, ...args);
}

function gitWithEnv(cwd: string, transportEnv: NodeJS.ProcessEnv | undefined, ...args: string[]): string {
  // Ambient GIT_DIR/GIT_WORK_TREE can silently redirect git into a different
  // repository. Always discover identities from the requested filesystem root.
  const env = { ...process.env, ...transportEnv };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"]) {
    delete env[name];
  }
  try {
    return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (cause) {
    const error = cause as Error & { stderr?: Buffer | string };
    // Never reflect authenticated transport stderr: some Git/curl errors can
    // include request headers. The ephemeral token must not enter logs/receipts.
    const detail = transportEnv ? 'authenticated transport failed; inspect provider access and retry' :
      String(error.stderr || error.message).trim();
    throw new Error(`Git ${args[0]} failed in "${cwd}": ${detail}`);
  }
}

/** Relative path to the trusted inbox, alongside a conventional story/ content root. */
export function siblingInboxPath(storyRelativePath: string): string | null {
  if (storyRelativePath === "story") return ".story-inbox";
  if (storyRelativePath.endsWith("/story")) return dirname(storyRelativePath) + "/.story-inbox";
  return null;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function storeRoot(): string {
  return resolve(process.env.NT_STATE_DIR || join(
    process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "noveltea-gen",
  ));
}

function gitCommonDir(root: string): string {
  return resolve(root, git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"));
}

/** Canonicalize existing ancestors, including symlinks, before allocating job state. */
export async function canonicalDestination(input: string): Promise<string> {
  const missing: string[] = [];
  let cursor = resolve(input);
  while (true) {
    try {
      return resolve(await realpath(cursor), ...missing.reverse());
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(basename(cursor));
      cursor = parent;
    }
  }
}

async function validateWorktree(manifest: JobManifest): Promise<string> {
  if (!existsSync(manifest.worktreeRoot)) {
    throw new Error("Saved job worktree is missing. Restore its original worktree; it will not be recreated.");
  }
  const expected = `refs/heads/${manifest.branch}`;
  const list = git(manifest.gitRoot, "worktree", "list", "--porcelain");
  const entries = list.split(/\n\s*\n/).map((entry) => ({
    worktree: entry.match(/^worktree (.+)$/m)?.[1],
    branch: entry.match(/^branch (.+)$/m)?.[1],
  }));
  if (!entries.some(({ worktree, branch }) => worktree && resolve(worktree) === manifest.worktreeRoot && branch === expected)) {
    throw new Error("Saved job worktree/branch identity differs from the Git registry. Restore it before retrying.");
  }
  if (resolve(git(manifest.worktreeRoot, "rev-parse", "--show-toplevel")) !== manifest.worktreeRoot ||
      gitCommonDir(manifest.worktreeRoot) !== manifest.gitCommonDir ||
      git(manifest.worktreeRoot, "symbolic-ref", "HEAD") !== expected) {
    throw new Error("Saved job worktree points to an unexpected repository or branch.");
  }
  try {
    const root = await realpath(manifest.worktreeStoryRoot);
    if (root !== manifest.worktreeStoryRoot || !inside(manifest.worktreeRoot, root) ||
        !(await stat(root)).isDirectory()) {
      throw new Error("invalid worktree Story directory");
    }
  } catch {
    throw new Error("Saved worktree Story root is missing or resolves outside the job. Restore it before retrying.");
  }
  const head = git(manifest.worktreeRoot, "rev-parse", "--verify", "HEAD^{commit}");
  try {
    git(manifest.worktreeRoot, "merge-base", "--is-ancestor", manifest.baseSha, head);
  } catch {
    throw new Error("Job branch no longer descends from its recorded base SHA. Refusing to reuse it.");
  }
  return head;
}

/**
 * Establish a durable, Git-isolated Story generation workspace.
 * This is deliberately separate from the older proof-of-concept 'run' graph.
 */
export async function startStoryJob(options: JobStartOptions, create = true): Promise<JobStartResult> {
  if (!options.story.trim()) throw new Error("Missing required --story <path>.");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(options.job) || options.job.includes("..")) {
    throw new Error("--job must be 1–64 letters, digits, dots, underscores or hyphens, without '..'.");
  }
  let storyRoot: string;
  try {
    storyRoot = await realpath(resolve(options.story));
    if (!(await stat(storyRoot)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`Story root "${resolve(options.story)}" must be an existing directory (empty is allowed).`);
  }

  let gitRoot: string;
  let baseSha: string;
  try {
    if (git(storyRoot, "rev-parse", "--is-inside-work-tree") !== "true") throw new Error("not a worktree");
    gitRoot = await realpath(git(storyRoot, "rev-parse", "--show-toplevel"));
    baseSha = git(gitRoot, "rev-parse", "--verify", "HEAD^{commit}");
  } catch {
    throw new Error(`Story root "${storyRoot}" must be inside an existing Git worktree with a committed HEAD. No Git repository was initialized or baseline committed.`);
  }

  if (options.pinnedBaseSha !== undefined) {
    const selected = options.pinnedBaseSha;
    if (!/^[a-f0-9]{40,64}$/.test(selected) ||
        git(gitRoot, "rev-parse", "--verify", selected + "^{commit}") !== selected) {
      throw new Error("Pinned job baseline must be an exact local Git commit SHA.");
    }
    baseSha = selected;
  }

  const storyRelativePath = relative(gitRoot, storyRoot).split(sep).join("/");
  if (!inside(gitRoot, storyRoot)) throw new Error("Story path resolves outside the Git repository.");
  const novelteaProjectRoot = options.novelteaProject
    ? await canonicalDestination(options.novelteaProject) : undefined;
  const identity = createHash("sha256")
    .update(JSON.stringify([gitRoot, storyRelativePath, options.job])).digest("hex");
  const branch = `noveltea-gen/${identity}`;
  const stateRoot = await canonicalDestination(storeRoot());
  const jobRoot = join(stateRoot, "jobs", identity);
  const configuredCacheRoot = options.worktreeCacheRoot ?? process.env.NT_GIT_CACHE_DIR;
  const cacheRoot = configuredCacheRoot
    ? await canonicalDestination(configuredCacheRoot) : undefined;
  const worktreeRoot = cacheRoot ? join(cacheRoot, "worktrees", identity) : join(jobRoot, "worktree");
  const worktreeStoryRoot = resolve(worktreeRoot, storyRelativePath);
  const manifestFile = join(jobRoot, "job.json");
  const common = gitCommonDir(gitRoot);
  if (inside(gitRoot, jobRoot)) {
    throw new Error("NT_STATE_DIR places durable job state inside the author Git checkout. Select external state storage.");
  }
  if (cacheRoot && (inside(cacheRoot, stateRoot) || inside(stateRoot, cacheRoot) ||
      inside(gitRoot, worktreeRoot))) {
    throw new Error("NT_GIT_CACHE_DIR must not overlap durable state or place worktrees inside the author checkout.");
  }

  if (existsSync(jobRoot)) {
    let saved: JobManifest;
    try {
      saved = JSON.parse(await readFile(manifestFile, "utf8")) as JobManifest;
    } catch {
      throw new Error(`Job state at "${jobRoot}" is incomplete or corrupt. Inspect it before retrying; no branch or worktree was replaced.`);
    }
    if (!saved || saved.version !== 1 || saved.jobId !== options.job || saved.gitRoot !== gitRoot ||
        saved.gitCommonDir !== common || saved.storyRoot !== storyRoot ||
        saved.storyRelativePath !== storyRelativePath ||
        (options.pinnedBaseSha !== undefined && saved.baseSha !== options.pinnedBaseSha) ||
        (options.novelteaProject !== undefined && saved.novelteaProjectRoot !== novelteaProjectRoot) ||
        saved.branch !== branch || (saved.stateDir !== undefined && saved.stateDir !== jobRoot) ||
        (saved.cacheRoot !== undefined && (typeof saved.cacheRoot !== "string" || !saved.cacheRoot)) ||
        saved.worktreeRoot !== (saved.cacheRoot ? join(saved.cacheRoot, "worktrees", identity) : join(jobRoot, "worktree")) ||
        saved.worktreeStoryRoot !== resolve(saved.worktreeRoot, storyRelativePath) ||
        (saved.cacheRoot !== undefined && (saved.cacheRoot !== resolve(saved.cacheRoot) ||
          inside(saved.cacheRoot, stateRoot) || inside(stateRoot, saved.cacheRoot) ||
          inside(gitRoot, saved.worktreeRoot))) ||
        !/^[0-9a-f]{40,64}$/.test(saved.baseSha) ||
        !/^[0-9a-f-]{36}$/.test(saved.threadId) ||
        (saved.validatorSha256 !== undefined && !/^[a-f0-9]{64}$/.test(saved.validatorSha256))) {
      throw new Error("Saved job identity does not match the selected Story, repository or job. No worktree was changed.");
    }
    const headSha = await validateWorktree(saved);
    return { ...publicFields(saved, jobRoot), status: "ready", headSha };
  }

  if (!create) {
    throw new Error("No existing Story job matches this Story root and job ID. Run 'job start' first.");
  }
  // Ordinary new jobs depend on the author's current clean Story baseline.
  // An explicitly pinned local commit is immutable: neither moving HEAD nor
  // working-tree drafts participate in materializing that selected tree.
  // Reopen likewise preserves later author work and unfinished job edits.
  if (options.pinnedBaseSha === undefined) {
    const pathspec = storyRelativePath || ".";
    const inboxPath = siblingInboxPath(storyRelativePath);
    const dirty = git(gitRoot, "status", "--porcelain=v1", "--untracked-files=all", "--",
      pathspec, ...(inboxPath ? [inboxPath] : []));
    if (dirty) {
      throw new Error(`Story baseline "${storyRelativePath || "."}" contains uncommitted or untracked files. Commit or resolve relevant Story changes first; unrelated monorepo changes are allowed.`);
    }
    if (git(gitRoot, "rev-parse", "--verify", "HEAD^{commit}") !== baseSha) {
      throw new Error("Author HEAD moved while resolving the Story baseline. Retry job creation.");
    }
  }
  const manifest: JobManifest = {
    version: 1, jobId: options.job, gitRoot, gitCommonDir: common,
    storyRoot, storyRelativePath, ...(novelteaProjectRoot ? { novelteaProjectRoot } : {}),
    baseSha, branch, stateDir: jobRoot, ...(cacheRoot ? { cacheRoot } : {}),
    worktreeRoot, worktreeStoryRoot, threadId: randomUUID(),
  };
  await mkdir(join(stateRoot, "jobs"), { recursive: true });
  try {
    await mkdir(jobRoot);
  } catch {
    throw new Error(`Job state "${jobRoot}" already exists or is being created. Retry once the first start completes.`);
  }
  let created = false;
  try {
    if (cacheRoot) await mkdir(join(cacheRoot, "worktrees"), { recursive: true });
    if (options.sparseStoryOnly) {
      // Normal 'worktree add' may inherit the base's empty sparse selection
      // (or check out the entire monorepo). Configure the exact scope first.
      git(gitRoot, "worktree", "add", "--no-checkout", "-b", branch, worktreeRoot, baseSha);
      created = true;
      // The trusted author inbox is a sibling of the canonical story/ folder;
      // retain it in the sparse worktree without exposing it to the sandbox.
      const inbox = siblingInboxPath(storyRelativePath);
      gitWithEnv(worktreeRoot, options.gitTransportEnv, "sparse-checkout", "set", "--no-cone", "--",
        storyRelativePath ? `/${storyRelativePath}/**` : "/**",
        ...(inbox ? [`/${inbox}/**`] : []));
      gitWithEnv(worktreeRoot, options.gitTransportEnv, "reset", "--hard", baseSha);
    } else {
      git(gitRoot, "worktree", "add", "-b", branch, worktreeRoot, baseSha);
      created = true;
    }
    await mkdir(worktreeStoryRoot, { recursive: true });
    if (await realpath(worktreeStoryRoot) !== worktreeStoryRoot) {
      throw new Error("Worktree Story root unexpectedly resolves through a symlink.");
    }
    // A completed manifest is the only marker that authorizes reopening.
    const temporary = join(jobRoot, `job.${process.pid}.tmp`);
    await writeFile(temporary, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, manifestFile);
  } catch (error) {
    if (created) {
      try { git(gitRoot, "worktree", "remove", "--force", worktreeRoot); } catch { /* preserve source error */ }
      try { git(gitRoot, "branch", "-D", branch); } catch { /* preserve source error */ }
    }
    // Never delete an unexpected existing worktree; leave it for inspection.
    if (!existsSync(worktreeRoot)) {
      try { await rm(jobRoot, { recursive: true, force: true }); } catch { /* preserve source error */ }
    }
    throw error;
  }
  return { ...publicFields(manifest, jobRoot), status: "ready", headSha: baseSha };
}

function publicFields(manifest: JobManifest, stateDir: string): Omit<JobStartResult, "status" | "headSha"> {
  const { version, gitCommonDir, ...visible } = manifest;
  void version; void gitCommonDir;
  return { ...visible, stateDir };
}
