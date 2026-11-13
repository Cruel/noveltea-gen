import { createHash } from "node:crypto";
import { homedir } from "node:os";
import type { VerifiedSkillFiles } from "./snapshot.js";
import { execFileSync } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSkills, type Skill, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ResourceDiagnostic } from "@earendil-works/pi-coding-agent";

/** A trusted controller grant, never inferred from model text or skill frontmatter. */
export type SkillReadRole = "specialist" | "orchestrator" | "reviewer";

/** Only portable craft/reference packages can be consulted across domains. */
const CROSS_DOMAIN_GUIDANCE = new Set([
  "nt-catalog", "nt-worldbuilding", "nt-character-development", "nt-story-architecture",
  "nt-event-design", "nt-interactive-narrative", "nt-puzzle-design",
  "nt-narrative-composition", "nt-story-discovery",
]);

/** Skill visibility is knowledge, never a grant to invoke a role or write Story records. */
export function roleVisibleSkills(skills: readonly Skill[], role: SkillReadRole,
  allowCollaborativeMethod = true): Skill[] {
  return skills.filter(skill =>
    // The controller binds a portable role to its package location, never
    // only to forgeable SKILL.md frontmatter or invocation metadata.
    basename(skill.baseDir) === skill.name &&
    dirname(skill.filePath) === skill.baseDir && basename(skill.filePath) === "SKILL.md" &&
    (CROSS_DOMAIN_GUIDANCE.has(skill.name) ||
      (role === "reviewer" && skill.name === "nt-narrative-review") ||
      (role === "orchestrator" &&
        (skill.name === "nt-story-orchestrate" ||
          (allowCollaborativeMethod && skill.name === "nt-story-collaborate")))));
}

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
export async function loadSkillConfig(path = process.env.NT_CONFIG_FILE ?? DEFAULT_CONFIG, verifyCheckout = true): Promise<SkillConfig> {
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
    ? verifyCheckout ? await directory(configPath(checkout, base), "novelteaSkills Git checkout")
      : configPath(checkout, base)
    : undefined;
  if (novelteaSkills && verifyCheckout) {
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
    skillDirs.push(verifyCheckout ? await directory(configPath(entry, base), "skillDirs entry") : configPath(entry, base));
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
      if (name === "nt-story-generate") {
        throw new Error("Missing legacy configured skill nt-story-generate. New Studio Turns " +
          "select nt-story-orchestrate; remove the retired requiredSkills entry for " +
          "new workflows, or restore the original pinned skills for historical sessions. " +
          "Never alias or repin the old skill implicitly.");
      }
      throw new Error(`Missing required NovelTea skill "${name}" in ${config.novelteaSkills ?? "unconfigured checkout"}.`);
    }
  }
  return { skills: [...chosen.values()], diagnostics };
}

/**
 * Custom Pi "read" tool. It can only read resources beneath a loaded skill's
 * directory and cannot follow symlinks outside those roots. No shell or writes.
 */
export function createSkillReadTool(skills: Skill[], snapshot?: VerifiedSkillFiles): ToolDefinition {
  const roots = [...new Set(skills.map(skill => realpathSync(skill.baseDir)))];
  const namedRoots = new Map(skills.map(skill => [skill.name, realpathSync(skill.baseDir)]));
  return {
    name: "read",
    label: "Read skill resource",
    description: "Read a skill or reference by a short skill://nt-name/SKILL.md or skill://nt-name/references/file.md address, or its advertised absolute path. Only loaded, authorized skill packages are accessible; no Story or host file access.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Authorized skill://name/file address (preferred) or advertised absolute skill path" } },
      required: ["path"],
      additionalProperties: false,
    } as ToolDefinition["parameters"],
    executionMode: "sequential",
    async execute(_id, args) {
      const requested = (args as { path: string }).path;
      if (typeof requested !== "string") throw new Error("Skill read denied: expected a skill resource path.");
      let path = requested;
      if (requested.startsWith("skill://")) {
        const alias = /^skill:\/\/([a-z][a-z0-9-]*)\/(.+)$/.exec(requested);
        const root = alias && namedRoots.get(alias[1]!);
        const segments = alias?.[2]?.split("/");
        if (!root || !segments?.length || segments.some(segment =>
          !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(segment) || segment === "..")) {
          throw new Error("Skill read denied: invalid or unauthorized pinned skill address.");
        }
        path = join(root, ...segments);
      }
      if (!isAbsolute(path) || !roots.some(root => contained(root, path))) {
        throw new Error("Skill read denied: absolute path must be inside an advertised skill.");
      }
      const canonical = await realpath(path);
      if (!roots.some(root => contained(root, canonical))) {
        throw new Error("Skill read denied: resource resolves outside an advertised skill.");
      }
      if (snapshot && !contained(snapshot.root, canonical)) {
        throw new Error("Skill read denied: resource is outside the verified pinned snapshot.");
      }
      const info = await stat(canonical);
      if (!info.isFile() || info.size > 128 * 1024) {
        throw new Error("Skill read denied: expected a regular text file at most 128 KiB.");
      }
      const bytes = await readFile(canonical);
      const content = bytes.toString("utf8");
      // The snapshot's file allowlist is fixed when the Pi session starts.
      // Even a cache owner injecting a new file or changing permissions and
      // editing an existing file cannot make it a valid pinned resource.
      if (snapshot && contained(snapshot.root, canonical)) {
        const expected = snapshot.hashes.get(canonical);
        if (!expected || createHash("sha256").update(bytes).digest("hex") !== expected) {
          throw new Error("Skill read denied: resource is not in the verified pinned snapshot.");
        }
      }
      if (content.includes("\0")) throw new Error("Skill read denied: binary resources are not supported.");
      return { content: [{ type: "text", text: content }], details: undefined };
    },
  };
}
