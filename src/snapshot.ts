import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
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

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}
function cacheRoot(): string {
  return resolve(process.env.NT_SKILL_CACHE_DIR ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "noveltea-gen", "skill-snapshots"));
}
function permitted(name: string): boolean {
  return ![".git", "node_modules", ".cache", "dist", ".pnpm", "__pycache__", ".venv", "vendor"].includes(name);
}
async function capture(root: string): Promise<{ digest: string; files: FileEntry[] }> {
  const files: FileEntry[] = [];
  async function walk(dir: string) {
    for (const item of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!permitted(item.name)) continue;
      const full = join(dir, item.name);
      const info = await lstat(full);
      if (info.isSymbolicLink()) throw new Error(`Snapshot source contains symlink: ${full}`);
      if (info.isDirectory()) await walk(full);
      else if (info.isFile()) {
        const path = relative(root, full).split(sep).join("/");
        const data = await readFile(full);
        files.push({ path, data, digest: createHash("sha256").update(data).digest("hex") });
      } else throw new Error(`Unsupported snapshot source entry: ${full}`);
    }
  }
  await walk(join(root, "skills"));
  if (!files.some(f => /^skills\/[^/]+\/SKILL\.md$/.test(f.path))) {
    throw new Error("NovelTea checkout has no skill packages.");
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const digest = createHash("sha256").update(JSON.stringify(files.map(({ path, digest }) => [path, digest]))).digest("hex");
  return { digest, files };
}
async function verify(root: string, expected: string): Promise<void> {
  const result = await capture(root);
  if (result.digest !== expected || (await readdir(root)).some(x => x !== "skills")) {
    throw new Error(`Skill snapshot ${expected} is missing, corrupt or modified; restore the original cache. Never use the live checkout as a fallback.`);
  }
}
export async function openSkillSnapshot(id: string): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid skill snapshot ID.");
  const path = join(cacheRoot(), id);
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("not a real snapshot directory");
    await verify(path, id);
  }
  catch (error) { throw new Error(`Cannot restore pinned skill snapshot ${id}: ${error instanceof Error ? error.message : error}`); }
  return path;
}
export async function createSkillSnapshot(config: SkillConfig): Promise<SkillSnapshot | undefined> {
  if (!config.novelteaSkills) return undefined;
  const root = await realpath(config.novelteaSkills);
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
        await verify(temp, digest);
        // Refuse mixed-generation content if the source changed during copying.
        if ((await capture(root)).digest !== digest) {
          throw new Error("NovelTea skills changed during snapshot publication; retry this new workflow.");
        }
        // Stage fully, then atomically publish the immutable digest directory.
        // Never intentionally replace an existing digest directory, even if it is empty.
        try { await lstat(destination); throw new Error(`Existing skill snapshot ${digest} cannot be replaced.`); }
        catch (existing) {
          if (!(existing instanceof Error && "code" in existing && existing.code === "ENOENT")) throw existing;
        }
        try { await rename(temp, destination); }
        catch (publishError) {
          try { await openSkillSnapshot(digest); }
          catch { throw publishError; }
        }
      } finally { await rm(temp, { recursive: true, force: true }); }
    }
    if (await stat(destination).then(() => true, () => false)) await openSkillSnapshot(digest);
    else throw error;
  }
  const branchResult = spawnSync("git", ["-C", root, "symbolic-ref", "--quiet", "--short", "HEAD"], { encoding: "utf8" });
  const branch = branchResult.status === 0 ? branchResult.stdout.trim() : null;
  const commit = git(root, "rev-parse", "HEAD");
  const dirty = Boolean(git(root, "status", "--porcelain", "--untracked-files=all"));
  return { id: digest, digest, path: destination, commit, branch, detached: branch === null, dirty };
}
