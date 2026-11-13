import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CreativeMode } from "./creative-policy.js";

/** Portable role/read contract shared by runtime, recovery admission and Gen's
 * cross-repository matrix. Methods are data, not schedulers or write grants. */
const CORE = [
  "nt-story-orchestrate/SKILL.md",
  "nt-story-orchestrate/references/planning.md",
  "nt-catalog/SKILL.md",
  "nt-catalog/references/records.md",
  "nt-catalog/references/progression.md",
  "nt-catalog/references/authority-and-validation.md",
] as const;

const COLLABORATIVE = [
  "nt-story-collaborate/SKILL.md",
  "nt-story-collaborate/references/interaction.md",
] as const;

export const requiredOrchestratorSkillReads = (mode: CreativeMode): readonly string[] =>
  mode === "collaborative" ? [...CORE, ...COLLABORATIVE] : CORE;

/** At admission, diagnose upstream method drift by portable resource name,
 * without exposing private checkout/cache paths in author-facing failures. */
export async function assertPinnedSkillResources(
  snapshotPath: string, resources: readonly string[]): Promise<void> {
  for (const resource of resources) {
    try {
      if (!(await readFile(join(snapshotPath, "skills", resource), "utf8")).trim())
        throw new Error("empty");
    } catch {
      throw new Error(`Missing or empty pinned NovelTea skill resource "${resource}". ` +
        "Install a compatible noveltea-skills checkout and start a new verified Turn; " +
        "do not rewrite or repin an existing session.");
    }
  }
}

export const assertPortableOrchestrationSkills = (snapshotPath: string): Promise<void> =>
  assertPinnedSkillResources(snapshotPath, ["nt-story-discovery/SKILL.md",
    ...requiredOrchestratorSkillReads("collaborative")]);
