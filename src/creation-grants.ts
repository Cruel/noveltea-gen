/** Exact, catalog-independent validation of bounded creation grants.
 * Both contract parsing and focused runtime verification invoke this same
 * pure validator. Catalog presence and reference-field evidence are separate.
 */
import type { PlannedFocusCreate } from "./architecture.js";

const directories: Record<string, string> = {
  character: "characters", relationship: "relationships",
  event: "events", "authored-content": "authored-content",
};
const idPattern = /^(character|relationship|event|authored-content)\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const referencePattern = /^(arc|character|relationship|event)\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const stringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(x => typeof x === "string" && !!x.trim());

export function validateFocusedCreationGrants(
  input: unknown, targets: readonly string[], kind: "partial" | "full-story",
): PlannedFocusCreate[] {
  if (!Array.isArray(input) || input.length > 12 ||
      (input.length > 0 && kind !== "partial") ||
      input.some(item => !item || typeof item !== "object" ||
        typeof item.id !== "string") ||
      new Set(input.map(item => item.id)).size !== input.length)
    throw new Error("Invalid focused creation inventory.");

  const creates = input as PlannedFocusCreate[];
  const byId = new Map(creates.map(item => [item.id, item]));
  for (const item of creates) {
    const type = item.id.split(".")[0] ?? "";
    if (!idPattern.test(item.id) || !Object.hasOwn(directories, type) ||
        !targets.includes(item.id) ||
        item.path !== directories[type] + "/" + item.id.slice(type.length + 1) + ".md" ||
        typeof item.title !== "string" || !item.title.trim() || item.title.length > 160 ||
        /[\x00-\x1f\x7f]/.test(item.title) ||
        !stringList(item.references) || item.references.length > 16 ||
        !stringList(item.dependsOn) || item.dependsOn.length > 12 ||
        new Set(item.references).size !== item.references.length ||
        new Set(item.dependsOn).size !== item.dependsOn.length ||
        item.references.some(ref => !referencePattern.test(ref)) ||
        (type === "relationship" && (item.references.length !== 2 ||
          item.references.some(ref => !ref.startsWith("character.")))) ||
        (type === "event" && !item.references.some(ref => ref.startsWith("arc."))) ||
        (type === "authored-content" && (item.references.length !== 1 ||
          !item.references[0]?.startsWith("event."))) ||
        (type === "character" && item.references.length !== 0))
      throw new Error("Invalid focused creation scope: require exact, typed and bounded records.");

    for (const ref of item.references) {
      if (byId.has(ref) && !item.dependsOn.includes(ref))
        throw new Error("Focused creation reference lacks a prerequisite dependency: " + ref);
    }
    for (const dep of item.dependsOn) {
      if (!byId.has(dep)) throw new Error("Unknown focused creation dependency: " + dep);
    }
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error("Cyclic focused creation dependencies.");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id)!.dependsOn) visit(dep);
    visiting.delete(id);
    visited.add(id);
  };
  for (const item of creates) visit(item.id);
  return creates;
}
