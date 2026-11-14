import { join } from "node:path";
import { pinnedSkillReferences, type SkillSnapshot } from "./snapshot.js";

/** The portable skill owns craft and representation. Studio supplies only the
 * current committed unit, access ceiling, controller checks and handoff. */
const CATALOG_CORE = [
  "nt-catalog/SKILL.md",
  "nt-catalog/references/records.md",
  "nt-catalog/references/progression.md",
  "nt-catalog/references/authority-and-validation.md",
] as const;

export function boundedPinnedSources(method: string): string[] {
  return [method + "/SKILL.md", ...CATALOG_CORE];
}

export function pinnedSourcePaths(snapshot: SkillSnapshot, sources: readonly string[]): string[] {
  return sources.map((path) => join(snapshot.path, "skills", path));
}

export interface BoundedPrompt {
  goal: string;
  sources: readonly string[];
  sourceUse: string;
  writableScope: string;
  doneWhen: string;
  laterObligations: string;
  requiredOutput: string;
  assignmentLabel: string;
  assignment: unknown;
  authorInstruction?: string;
}

/** Stable section order is deliberate: the single unit appears before safety
 * and reference detail. Controller checks, not prompt prose, enforce scope. */
export function renderBoundedPrompt(snapshot: SkillSnapshot, task: BoundedPrompt): string {
  const required = pinnedSourcePaths(snapshot, task.sources);
  return (
    [
      "CURRENT GOAL",
      task.goal,
      task.authorInstruction ?? "",
      "PINNED SOURCES",
      "Read each immutable reference with the read tool before making changes or reviewing. " +
        "Use the exact skill:// addresses; do not guess snapshot hash paths. " +
        "The skills own craft/schema rules; read nt-catalog/references/glossary.md only when terminology is unclear. " +
        task.sourceUse,
      pinnedSkillReferences(snapshot, required),
      "WRITABLE SCOPE",
      task.writableScope,
      "DONE WHEN",
      task.doneWhen,
      "LATER OBLIGATIONS",
      task.laterObligations,
      "REQUIRED OUTPUT",
      task.requiredOutput,
      task.assignmentLabel,
      JSON.stringify(task.assignment, null, 2),
    ]
      .filter(Boolean)
      .join("\n") + "\n"
  );
}
