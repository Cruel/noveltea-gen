import { execFileSync as nativeExecFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Process-local, bounded cache of *successful* reads from immutable Git objects.
 * Git object identities are content addressed; refs, HEAD, worktree registration,
 * status, the index, and negative results are deliberately never cached.
 *
 * A new worker starts empty. The key includes the exact checkout path and argv:
 * two repositories can have the same object ID but must not share Git facts.
 * The cache is only an optimization; every mutable trust boundary remains live.
 */
const sha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const commitSpec = /^[a-f0-9]{40}(?:[a-f0-9]{24})?(?:\^|\^\{commit\}|\^\{tree\})?$/;
const objectPath = /^[a-f0-9]{40}(?:[a-f0-9]{24})?:[^\0\n\r]+$/;
const range = /^[a-f0-9]{40}(?:[a-f0-9]{24})?\.\.[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const cache = new Map<string, string>();
const MAX_ENTRIES = 4096;
const MAX_VALUE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
let cachedBytes = 0;

function immutable(args: readonly string[]): boolean {
  const [op, ...rest] = args;
  if (op === "rev-parse")
    return rest.length === 1 && commitSpec.test(rest[0] ?? "");
  if (op === "merge-base")
    return rest.length === 3 && rest[0] === "--is-ancestor" &&
      sha.test(rest[1] ?? "") && sha.test(rest[2] ?? "");
  if (op === "log") {
    // Commit messages and a closed commit range are immutable; HEAD and refs
    // aren't. Include every option in the key, including the requested format.
    return rest.some(arg => arg.startsWith("--format=")) &&
      (sha.test(rest.at(-1) ?? "") || range.test(rest.at(-1) ?? "")) &&
      rest.every(arg => !arg.startsWith("--") || arg.startsWith("--format=") ||
        arg === "--reverse" || arg === "--no-walk");
  }
  if (op === "diff-tree") {
    const last = rest.at(-1) ?? "";
    return sha.test(last) && rest.slice(0, -1).every(arg =>
      ["-r", "--no-commit-id", "--name-only", "--name-status", "-z", "--root"].includes(arg));
  }
  if (op === "ls-tree") {
    const stop = rest.indexOf("--");
    const before = stop === -1 ? rest : rest.slice(0, stop);
    const candidates = before.filter(arg => !arg.startsWith("-"));
    return candidates.length === 1 && sha.test(candidates[0] ?? "") &&
      before.every(arg => !arg.startsWith("-") ||
        ["-r", "-z", "--name-only", "--full-tree"].includes(arg));
  }
  if (op === "show")
    return rest.length === 1 && (objectPath.test(rest[0] ?? "") || sha.test(rest[0] ?? ""));
  if (op === "cat-file")
    return rest.length === 2 && ["blob", "commit", "tree", "-p"].includes(rest[0] ?? "") &&
      sha.test(rest[1] ?? "");
  return false;
}

/** Inspect ordinary loose refs directly, afresh on every call. A linked
 * worktree's .git pointer and commondir are resolved on each read, never
 * assumed from an earlier job. Unusual, packed, detached or potentially unsafe
 * layouts go through the real Git executable instead.
 */
function liveRef(command: string, args: readonly string[], options: unknown): string | undefined {
  if (command !== "git") return undefined;
  const opts = (options ?? {}) as { cwd?: string; encoding?: string; env?: NodeJS.ProcessEnv };
  if (opts.encoding !== "utf8" || !opts.cwd || !isAbsolute(opts.cwd)) return undefined;
  if (["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_NAMESPACE",
       "GIT_REPLACE_REF_BASE", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"].some(k =>
         opts.env?.[k] || (!opts.env && process.env[k])))
    return undefined;
  const rev = args.length === 2 && args[0] === "rev-parse" && args[1] === "HEAD";
  const symbol = args.at(-1) === "HEAD" &&
    (args.length === 2 && args[0] === "symbolic-ref" ||
     args.length === 3 && args[0] === "symbolic-ref" && args[1] === "--short");
  if (!rev && !symbol) return undefined;
  try {
    const root = resolve(opts.cwd);
    const marker = join(root, ".git");
    const meta = lstatSync(marker);
    if (meta.isSymbolicLink()) return undefined;
    let gitDir = marker;
    if (meta.isFile()) {
      if (meta.size > 1024) return undefined;
      const match = /^gitdir: (.+)$/.exec(readFileSync(marker, "utf8").trim());
      if (!match) return undefined;
      gitDir = resolve(root, match[1]!);
    } else if (!meta.isDirectory()) return undefined;
    const headPath = join(gitDir, "HEAD");
    const stat = lstatSync(headPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) return undefined;
    const head = readFileSync(headPath, "utf8").trim();
    const refMatch = /^ref: (refs\/heads\/[A-Za-z0-9_./-]+)$/.exec(head);
    if (!refMatch) {
      if (rev && sha.test(head)) return head + "\n";
      return undefined;
    }
    const ref = refMatch[1]!;
    if (ref.split("/").some(part => part === "." || part === ".." || part === "") ||
        ref.endsWith(".lock")) return undefined;
    if (symbol) {
      return (args[1] === "--short" ? ref.slice("refs/heads/".length) : ref) + "\n";
    }
    let commonDir = gitDir;
    const commondir = join(gitDir, "commondir");
    try {
      const commonStat = lstatSync(commondir);
      if (!commonStat.isFile() || commonStat.isSymbolicLink() || commonStat.size > 1024)
        return undefined;
      const configured = readFileSync(commondir, "utf8").trim();
      if (!configured) return undefined;
      commonDir = resolve(gitDir, configured);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    }
    const refFile = join(commonDir, ...ref.split("/"));
    const refStat = lstatSync(refFile);
    if (!refStat.isFile() || refStat.isSymbolicLink() || refStat.size > 1024) return undefined;
    const oid = readFileSync(refFile, "utf8").trim();
    return sha.test(oid) ? oid + "\n" : undefined;
  } catch {
    // Packed refs, linked-layout changes, symlinks, and missing refs must be
    // decided by Git rather than inferred from stale local metadata.
    return undefined;
  }
}

function cacheKey(command: string, args: readonly string[], options: unknown): string | undefined {
  if (command !== "git" || !Array.isArray(args) || !args.every(x => typeof x === "string"))
    return undefined;
  const opts = (options ?? {}) as { cwd?: string; encoding?: string; env?: NodeJS.ProcessEnv };
  if (opts.encoding !== "utf8") return undefined;
  let gitArgs = args;
  let cwd = opts.cwd;
  if (gitArgs[0] === "-C" && gitArgs.length > 2) {
    cwd = gitArgs[1];
    gitArgs = gitArgs.slice(2);
  }
  if (!cwd || !immutable(gitArgs)) return undefined;
  // GIT_* redirection is explicitly removed by callers. Never cache when it
  // can redirect object lookups into an unrelated repository.
  if (["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
       "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_REPLACE_REF_BASE",
       "GIT_NO_REPLACE_OBJECTS", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"].some(x =>
         opts.env?.[x] || (!opts.env && process.env[x])))
    return undefined;
  return JSON.stringify([resolve(cwd), opts.env?.PATH ?? process.env.PATH, gitArgs]);
}

export const execFileSync = ((command: string, args?: readonly string[], options?: unknown) => {
  const fresh = args ? liveRef(command, args, options) : undefined;
  if (fresh !== undefined) return fresh;
  const key = args ? cacheKey(command, args, options) : undefined;
  if (key !== undefined) {
    const saved = cache.get(key);
    if (saved !== undefined) {
      cache.delete(key);
      cache.set(key, saved);
      return saved;
    }
  }
  const output = nativeExecFileSync(command, args as string[] | undefined, options as any);
  if (key !== undefined && typeof output === "string" &&
      Buffer.byteLength(output) <= MAX_VALUE_BYTES) {
    const bytes = Buffer.byteLength(output);
    cache.set(key, output);
    cachedBytes += bytes;
    while (cache.size > MAX_ENTRIES || cachedBytes > MAX_TOTAL_BYTES) {
      const oldest = cache.keys().next().value!;
      cachedBytes -= Buffer.byteLength(cache.get(oldest)!);
      cache.delete(oldest);
    }
  }
  return output;
}) as typeof nativeExecFileSync;
