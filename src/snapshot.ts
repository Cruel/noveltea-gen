import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import type { SkillConfig } from "./skills.js";

export interface SkillSnapshot {
  id: string;
  digest: string;
  path: string;
  commit: string;
  branch: string | null;
  detached: boolean;
  dirty: boolean;
}
interface FileEntry { path: string; digest: string; data: Buffer }
interface Capture { digest: string; files: FileEntry[]; directories: string[] }
/** Allowlist for the restricted reader, bound to an already verified digest. */
export interface VerifiedSkillFiles { root: string; hashes: ReadonlyMap<string, string> }
type GitProvenance = Pick<SkillSnapshot, "commit" | "branch" | "detached" | "dirty">;

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}
function gitProvenance(root: string): GitProvenance {
  const branchResult = spawnSync("git", ["-C", root, "symbolic-ref", "--quiet", "--short", "HEAD"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (branchResult.status !== 0 && branchResult.status !== 1) {
    throw new Error(`Cannot read NovelTea skill checkout branch: ${root}`);
  }
  const branch = branchResult.status === 0 ? branchResult.stdout.trim() : null;
  return {
    commit: git(root, "rev-parse", "HEAD"),
    branch,
    detached: branch === null,
    dirty: Boolean(git(root, "status", "--porcelain", "--untracked-files=all")),
  };
}
function cacheRoot(): string {
  return resolve(process.env.NT_SKILL_CACHE_DIR ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "noveltea-gen", "skill-snapshots"));
}
function permitted(name: string): boolean {
  return ![".git", "node_modules", ".cache", "dist", ".pnpm", "__pycache__", ".venv", "vendor"].includes(name);
}
async function capture(root: string, includeExcluded = false): Promise<Capture> {
  const files: FileEntry[] = [];
  const directories: string[] = [];
  async function walk(dir: string) {
    for (const item of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      // Source checkout filters are NOT cache verification rules. Every
      // published file (even under dist/ or node_modules/) must be hashed.
      if (!includeExcluded && !permitted(item.name)) continue;
      const full = join(dir, item.name);
      const info = await lstat(full);
      if (info.isSymbolicLink()) throw new Error(`Snapshot source contains symlink: ${full}`);
      if (info.isDirectory()) {
        directories.push(relative(root, full).split(sep).join("/"));
        await walk(full);
      }
      else if (info.isFile()) {
        const path = relative(root, full).split(sep).join("/");
        const data = await readFile(full);
        files.push({ path, data, digest: createHash("sha256").update(data).digest("hex") });
      } else throw new Error(`Unsupported snapshot source entry: ${full}`);
    }
  }
  const skillsRoot = join(root, "skills");
  const skillsInfo = await lstat(skillsRoot);
  if (!skillsInfo.isDirectory() || skillsInfo.isSymbolicLink()) {
    throw new Error(`Snapshot skills root must be a real directory: ${skillsRoot}`);
  }
  await walk(skillsRoot);
  if (!files.some(f => /^skills\/[^/]+\/SKILL\.md$/.test(f.path))) {
    throw new Error("NovelTea checkout has no skill packages.");
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const digest = createHash("sha256").update(JSON.stringify(files.map(({ path, digest }) => [path, digest]))).digest("hex");
  return { digest, files, directories };
}
async function verify(root: string, expected: string): Promise<Capture> {
  const result = await capture(root, true);
  // Empty/new directories are also unexpected published resources; the
  // manifest is precisely the set of file paths and their parent directories.
  const expectedDirs = new Set<string>();
  for (const file of result.files) {
    const components = file.path.split("/");
    for (let i = 1; i < components.length; i++) {
      expectedDirs.add(components.slice(0, i).join("/"));
    }
  }
  if (result.digest !== expected || (await readdir(root)).some(x => x !== "skills") ||
      result.directories.some(dir => !expectedDirs.has(dir))) {
    throw new Error(`Skill snapshot ${expected} is missing, corrupt or modified; restore the original cache. Never use the live checkout as a fallback.`);
  }
  return result;
}
/** POSIX read-only permissions also upgrade valid snapshots from older builds. */
async function seal(root: string, captured: Capture) {
  for (const entry of captured.files) {
    const path = join(root, entry.path);
    if ((await lstat(path)).mode & 0o222) await chmod(path, 0o444);
  }
  // Change children before parents so staging is never blocked by its own mode.
  for (const dir of [...captured.directories].sort((a, b) => b.length - a.length)) {
    const path = join(root, dir);
    if ((await lstat(path)).mode & 0o222) await chmod(path, 0o555);
  }
  if ((await lstat(root)).mode & 0o222) await chmod(root, 0o555);
}
/** Only for discarded, unpublished staging trees, never a pinned cache. */
async function discardStage(root: string) {
  async function unlock(dir: string) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    for (const item of entries) {
      if (item.isDirectory()) await unlock(join(dir, item.name));
    }
    await chmod(dir, 0o755);
  }
  await unlock(root);
  await rm(root, { recursive: true, force: true });
}
export async function openSkillSnapshot(id: string): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid skill snapshot ID.");
  const path = join(cacheRoot(), id);
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("not a real snapshot directory");
    await seal(path, await verify(path, id));
  }
  catch (error) { throw new Error(`Cannot restore pinned skill snapshot ${id}: ${error instanceof Error ? error.message : error}`); }
  return path;
}
export async function verifiedSkillFiles(id: string): Promise<VerifiedSkillFiles> {
  const root = await openSkillSnapshot(id);
  const verified = await verify(root, id);
  return { root, hashes: new Map(verified.files.map(f => [join(root, f.path), f.digest])) };
}

export async function createSkillSnapshot(config: SkillConfig): Promise<SkillSnapshot | undefined> {
  if (!config.novelteaSkills) return undefined;
  const root = await realpath(config.novelteaSkills);
  const before = gitProvenance(root);
  const { digest, files } = await capture(root);
  const base = cacheRoot();
  await mkdir(base, { recursive: true });
  const destination = join(base, digest);
  try {
    await openSkillSnapshot(digest);
  } catch (error) {
    // A previously existing but invalid snapshot must never be overwritten.
    try { await lstat(destination); }
    catch (missing) {
      if (!(missing instanceof Error && "code" in missing && missing.code === "ENOENT")) throw missing;
      const temp = join(base, `.stage-${randomUUID()}`);
      await mkdir(temp);
      try {
        for (const entry of files) {
          const target = join(temp, entry.path);
          await mkdir(join(target, ".."), { recursive: true });
          await writeFile(target, entry.data, { flag: "wx" });
        }
        await seal(temp, await verify(temp, digest));
        // Refuse mixed-generation content if the source changed during copying.
        if ((await capture(root)).digest !== digest) {
          throw new Error("NovelTea skills changed during snapshot publication; retry this new workflow.");
        }
        // Another workflow may have published the same digest while we staged.
        // Reuse a verified winner; never overwrite a present (possibly corrupt) cache.
        let alreadyPresent = false;
        try { await lstat(destination); alreadyPresent = true; }
        catch (existing) {
          if (!(existing instanceof Error && "code" in existing && existing.code === "ENOENT")) throw existing;
        }
        if (alreadyPresent) {
          await openSkillSnapshot(digest);
        } else {
          try { await rename(temp, destination); }
          catch (publishError) {
            // An atomic concurrent publish can win after our existence check.
            try { await openSkillSnapshot(digest); }
            catch { throw publishError; }
          }
        }
      } finally { await discardStage(temp); }
    }
    if (await stat(destination).then(() => true, () => false)) await openSkillSnapshot(digest);
    else throw error;
  }
  // A snapshot may be reused from the cache, but its recorded Git provenance
  // must still describe the source that was hashed. Detect concurrent checkout
  // edits/pulls even when the cached digest already existed.
  const after = gitProvenance(root);
  if (JSON.stringify(before) !== JSON.stringify(after) ||
      (await capture(root)).digest !== digest) {
    throw new Error("NovelTea skills checkout changed while capturing Git provenance; retry this new workflow.");
  }
  return { id: digest, digest, path: destination, ...before };
}
