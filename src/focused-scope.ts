import type { CompletionContract } from "./architecture.js";
import { validateFocusedCreationGrants } from "./creation-grants.js";

export interface CanonicalScopeRecord {
  path: string;
  metadata: { id: string; type: string; status: string; [key: string]: unknown };
}
const hierarchy = ["arc", "milestone"];

/** Focused records are goals, not a request to realize every enclosing cluster. */
export function isFocusedScope(contract: CompletionContract): boolean {
  return contract.scope.kind === "partial" &&
    contract.scope.targets.some(id => !hierarchy.some(type => id.startsWith(type + ".")));
}
const ids = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
const references = (value: unknown, known: Set<string>): string[] => {
  const found = new Set<string>();
  const visit = (v: unknown): void => {
    if (typeof v === "string" && known.has(v)) found.add(v);
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") Object.values(v).forEach(visit);
  };
  visit(value);
  return [...found];
};
/** Only canonical schema-defined reference slots establish a typed link.
 * Descriptions, consequences and arbitrary metadata strings never grant scope. */
export function declaredCanonicalReferences(record: CanonicalScopeRecord): Set<string> {
  const data = record.metadata;
  const linked = new Set<string>();
  const add = (value: unknown) => { if (typeof value === "string") linked.add(value); };
  const addList = (value: unknown) => ids(value).forEach(add);
  const objects = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value) ? value.filter((x): x is Record<string, unknown> =>
      x !== null && typeof x === "object" && !Array.isArray(x)) : [];
  const recordOf = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : {};
  const predicates = (value: unknown) => {
    for (const predicate of objects(value)) {
      if (["truth", "knowledge"].includes(String(predicate.kind))) add(predicate.fact);
      if (predicate.kind === "knowledge") add(predicate.character);
      if (predicate.kind === "relationship") add(predicate.relationship);
      if (predicate.kind === "revealed") add(predicate.revelation);
      if (predicate.kind === "outcome") add(predicate.choice_point);
    }
  };
  switch (data.type) {
    case "character":
      for (const entry of objects(data.initial_knowledge)) add(entry.fact);
      break;
    case "arc": addList(data.characters); break;
    case "milestone":
      addList(data.arcs);
      for (const alternative of Array.isArray(recordOf(data.fulfillment).any_of)
        ? recordOf(data.fulfillment).any_of as unknown[] : []) addList(alternative);
      break;
    case "event":
      addList(data.participants); addList(data.arcs); addList(data.after);
      for (const option of objects(recordOf(data.prerequisites).any_of)) {
        addList(option.completed); addList(option.not_completed);
        predicates(option.conditions);
      }
      for (const step of objects(data.steps)) for (const branch of objects(step.branches)) {
        predicates(branch.conditions); predicates(branch.effects);
      }
      break;
    case "relationship": addList(data.characters); break;
    case "revelation": add(data.fact); break;
    case "puzzle": addList(data.clues); addList(data.solutions); break;
    case "authored-content": addList(data.events); addList(data.revelations); break;
    case "narrative-position": add(data.event); break;
  }
  return linked;
}
export function resolveFocusedScope(records: CanonicalScopeRecord[], contract: CompletionContract) {
  const active = records.filter(r => r.metadata.status !== "superseded");
  const byId = new Map(active.map(r => [r.metadata.id, r]));
  // Independent callers may bypass contract parsing, so validate the entire
  // creation inventory again with the shared pure validator.
  let requested;
  try {
    requested = validateFocusedCreationGrants(contract.scope.creates ?? [],
      contract.scope.targets, contract.scope.kind);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Invalid focused creation scope"))
      throw new Error("Invalid canonical focused creation grant: " + error.message);
    throw error;
  }
  const creates = new Map(requested.map(item => [item.id, item]));
  for (const item of creates.values()) {
    for (const ref of item.references) {
      const known = byId.get(ref);
      if (!known && !creates.has(ref))
        throw new Error("Unverified focused creation prerequisite: " + ref);
      if (creates.has(ref) && !item.dependsOn.includes(ref))
        throw new Error("Focused creation reference lacks a prerequisite dependency: " + ref);
      if (known && known.metadata.type !== ref.split(".")[0])
        throw new Error("Focused creation references a mismatched typed record: " + ref);
    }
    const existing = byId.get(item.id);
    if (existing && (existing.path !== item.path || existing.metadata.type !== item.id.split(".")[0]))
      throw new Error("Focused creation ID collides with another canonical record.");
    if (existing) {
      const found = declaredCanonicalReferences(existing);
      const missing = item.references.filter(ref => !found.has(ref));
      if (missing.length)
        throw new Error("Created Story record omitted a pinned typed reference: " + item.id +
          " (" + missing.join(", ") + ")");
    } else {
      byId.set(item.id, { path: item.path, metadata: {
        id: item.id, type: item.id.split(".")[0]!, status: "planned",
      } });
    }
  }
  const selectedIds = [...new Set([...contract.scope.targets, ...(contract.scope.supportingTargets ?? [])])];
  const selected = selectedIds.map(id => {
    const record = byId.get(id);
    if (!record || record.metadata.type !== id.split(".")[0] ||
        !/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*\.md$/.test(record.path) ||
        record.path.split("/")[0] === ".story-inbox")
      throw new Error("Missing, superseded or invalid canonical scope target: " + id +
        ". Author must select an existing typed record; no automatic expansion.");
    return record;
  });
  const known = new Set(byId.keys());
  const primary = selected.filter(r => contract.scope.targets.includes(r.metadata.id));
  const context = new Set(contract.scope.targets);
  for (const record of primary) {
    references(record.metadata, known).forEach(id => context.add(id));
    creates.get(record.metadata.id)?.references.forEach(id => context.add(id));
    if (record.metadata.type === "character") {
      for (const arc of active.filter(r => r.metadata.type === "arc" &&
        ids(r.metadata.characters).includes(record.metadata.id))) context.add(arc.metadata.id);
    }
    if (record.metadata.type === "event") {
      for (const milestone of active.filter(r => {
        const fulfillment = r.metadata.fulfillment as { any_of?: string[][] } | undefined;
        return r.metadata.type === "milestone" &&
          (fulfillment?.any_of ?? []).flat().includes(record.metadata.id);
      })) context.add(milestone.metadata.id);
    }
  }
  for (const id of [...context]) {
    const record = byId.get(id);
    if (record?.metadata.type === "milestone")
      ids(record.metadata.arcs).forEach(arc => context.add(arc));
  }
  // A supporting edit must be related to a primary target, not an arbitrary
  // record smuggled into a broader writable set. Reverse references permit
  // bounded parent/child repairs (e.g. a target Character and its Arc).
  const primaryIds = new Set(contract.scope.targets);
  for (const supporting of selected.filter(r => !primaryIds.has(r.metadata.id))) {
    if (!context.has(supporting.metadata.id) &&
        !references(supporting.metadata, primaryIds).length) {
      throw new Error("Unauthorized supporting scope expansion: " + supporting.metadata.id +
        " is unrelated to selected goals; request a separately authorized target.");
    }
    context.add(supporting.metadata.id);
    references(supporting.metadata, known).forEach(id => context.add(id));
  }
  // Context may be broad enough to understand prerequisites, but is NEVER
  // granted write authority by being included in this set.
  for (const r of active.filter(r => r.metadata.type === "creative-direction")) context.add(r.metadata.id);
  const missingContext = [...context].filter(id => !byId.has(id));
  if (missingContext.length) throw new Error("Missing upstream context: " + missingContext.join(", ") +
    ". Request author authorization to repair these prerequisites.");
  return { selected, context: [...context].map(id => byId.get(id)!).filter(Boolean),
    allowedPaths: selected.map(r => r.path).sort() };
}
