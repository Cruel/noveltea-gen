import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSkills, type Skill, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ResourceDiagnostic } from "@earendil-works/pi-coding-agent";

export interface SkillConfig {
  discovery: "standard" | "explicit-only";
  /** Canonical location of the Git checkout, not its skills/ directory. */
  novelteaSkills?: string;
  /** Additional explicitly trusted skill directories. */
  skillDirs: string[];
  requiredSkills: string[];
}

const DEFAULT_CONFIG = fileURLToPath(new URL("../.local/config.json", import.meta.url));

function configPath(path: string, base: string): string {
  return resolve(base, path === "~" ? homedir() :
    path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
}

async function directory(path: string, description: string): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) throw new Error("not a directory");
  } catch (error) {
    throw new Error(`Invalid ${description} "${path}": ${error instanceof Error ? error.message : error}`);
  }
  return canonical;
}

/** Local app configuration is never taken from a Story root. */
export async function loadSkillConfig(path = process.env.NT_CONFIG_FILE ?? DEFAULT_CONFIG): Promise<SkillConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      if (path !== DEFAULT_CONFIG || process.env.NT_CONFIG_FILE) {
        throw new Error(`Skill configuration does not exist: ${path}`);
      }
      return { discovery: "standard", skillDirs: [], requiredSkills: [] };
    }
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error(`Invalid skill configuration "${path}": expected JSON.`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Skill configuration must be a JSON object.");
  }
  const data = parsed as Record<string, unknown>;
  const allowed = ["novelteaSkills", "skillDirs", "skillDiscovery", "requiredSkills"];
  if (Object.keys(data).some(key => !allowed.includes(key)) ||
      (data.skillDiscovery !== undefined &&
       data.skillDiscovery !== "standard" && data.skillDiscovery !== "explicit-only") ||
      (data.novelteaSkills !== undefined &&
       (typeof data.novelteaSkills !== "string" || !data.novelteaSkills.trim())) ||
      (data.skillDirs !== undefined &&
       (!Array.isArray(data.skillDirs) || data.skillDirs.some(x => typeof x !== "string" || !x.trim()))) ||
      (data.requiredSkills !== undefined &&
       (!Array.isArray(data.requiredSkills) || data.requiredSkills.some(x => typeof x !== "string" || !x.trim())))) {
    throw new Error("Invalid skill configuration: check novelteaSkills, skillDirs, skillDiscovery and requiredSkills.");
  }
  const base = dirname(resolve(path));
  const checkout = data.novelteaSkills as string | undefined;
  const novelteaSkills = checkout
    ? await directory(configPath(checkout, base), "novelteaSkills Git checkout")
    : undefined;
  if (novelteaSkills) {
    try {
      await stat(join(novelteaSkills, ".git"));
    } catch {
      throw new Error(`novelteaSkills must point to a Git checkout (missing .git): ${novelteaSkills}`);
    }
    try {
      const root = execFileSync("git", ["-C", novelteaSkills, "rev-parse", "--show-toplevel"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (await realpath(root) !== novelteaSkills) throw new Error("not the checkout root");
    } catch {
      throw new Error(`novelteaSkills is not a valid Git checkout root: ${novelteaSkills}`);
    }
    await directory(join(novelteaSkills, "skills"), "novelteaSkills/skills");
  }
  const skillDirs: string[] = [];
  for (const entry of data.skillDirs as string[] | undefined ?? []) {
    skillDirs.push(await directory(configPath(entry, base), "skillDirs entry"));
  }
  if (new Set(skillDirs).size !== skillDirs.length) {
    throw new Error("Duplicate configured skillDirs entries.");
  }
  return {
    discovery: (data.skillDiscovery as SkillConfig["discovery"] | undefined) ?? "standard",
    novelteaSkills,
    skillDirs,
    requiredSkills: [...new Set(["nt-catalog", ...(data.requiredSkills as string[] | undefined ?? [])])]
      .filter(() => Boolean(novelteaSkills)),
  };
}

function contained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function safeSkills(skills: Skill[], root: string): Skill[] {
  return skills.map(skill => {
    const canonical = realpathSync(skill.filePath);
    if (!contained(root, canonical)) {
      throw new Error(`Skill "${skill.name}" resolves outside configured directory: ${skill.filePath}`);
    }
    return skill;
  });
}

/** Dedicated checkout wins ahead of optional generic paths and normal Pi discovery. */
export function resolveConfiguredSkills(
  base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] },
  config: SkillConfig,
  cwd: string,
  agentDir: string,
): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
  const diagnostics = [...base.diagnostics];
  const chosen = new Map<string, Skill>();
  const sources: Array<{ name: string; skills: Skill[] }> = [];
  if (config.novelteaSkills) {
    const root = join(config.novelteaSkills, "skills");
    const found = loadSkills({ cwd, agentDir, skillPaths: [root], includeDefaults: false });
    diagnostics.push(...found.diagnostics);
    sources.push({ name: "novelteaSkills", skills: safeSkills(found.skills, root) });
  }
  for (const root of config.skillDirs) {
    const found = loadSkills({ cwd, agentDir, skillPaths: [root], includeDefaults: false });
    diagnostics.push(...found.diagnostics);
    sources.push({ name: "skillDirs", skills: safeSkills(found.skills, root) });
  }
  sources.push({ name: "Pi discovery", skills: base.skills });
  for (const source of sources) {
    for (const skill of source.skills) {
      const winner = chosen.get(skill.name);
      if (winner) {
        if (realpathSync(winner.filePath) !== realpathSync(skill.filePath)) {
          diagnostics.push({
            type: "collision",
            path: skill.filePath,
            message: `Skill "${skill.name}" from ${source.name} ignored: ${winner.filePath} takes precedence over ${skill.filePath}`,
            collision: {
              resourceType: "skill", name: skill.name,
              winnerPath: winner.filePath, loserPath: skill.filePath,
            },
          });
        }
      } else {
        chosen.set(skill.name, skill);
      }
    }
  }
  for (const name of config.requiredSkills) {
    const selected = chosen.get(name);
    if (!selected || !config.novelteaSkills ||
        !contained(join(config.novelteaSkills, "skills"), realpathSync(selected.filePath))) {
      throw new Error(`Missing required NovelTea skill "${name}" in ${config.novelteaSkills ?? "unconfigured checkout"}.`);
    }
  }
  return { skills: [...chosen.values()], diagnostics };
}

/**
 * Custom Pi "read" tool. It can only read resources beneath a loaded skill's
 * directory and cannot follow symlinks outside those roots. No shell or writes.
 */
export function createSkillReadTool(skills: Skill[]): ToolDefinition {
  const roots = [...new Set(skills.map(skill => realpathSync(skill.baseDir)))];
  return {
    name: "read",
    label: "Read skill resource",
    description: "Read a SKILL.md or a referenced text resource by absolute path, only inside one of the advertised skill directories. No Story or other filesystem access.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute file path from an advertised skill or its references" } },
      required: ["path"],
      additionalProperties: false,
    } as ToolDefinition["parameters"],
    executionMode: "sequential",
    async execute(_id, args) {
      const path = (args as { path: string }).path;
      if (typeof path !== "string" || !isAbsolute(path) || !roots.some(root => contained(root, path))) {
        throw new Error("Skill read denied: absolute path must be inside an advertised skill.");
      }
      const canonical = await realpath(path);
      if (!roots.some(root => contained(root, canonical))) {
        throw new Error("Skill read denied: resource resolves outside an advertised skill.");
      }
      const info = await stat(canonical);
      if (!info.isFile() || info.size > 128 * 1024) {
        throw new Error("Skill read denied: expected a regular text file at most 128 KiB.");
      }
      const content = await readFile(canonical, "utf8");
      if (content.includes("\0")) throw new Error("Skill read denied: binary resources are not supported.");
      return { content: [{ type: "text", text: content }], details: undefined };
    },
  };
}
