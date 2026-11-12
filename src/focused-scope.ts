import type { CompletionContract } from "./architecture.js";

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
export function resolveFocusedScope(records: CanonicalScopeRecord[], contract: CompletionContract) {
  const active = records.filter(r => r.metadata.status !== "superseded");
  const byId = new Map(active.map(r => [r.metadata.id, r]));
  const requested = contract.scope.creates ?? [];
  if (!Array.isArray(requested) || requested.length > 12 ||
      requested.some(item => !item || typeof item.id !== "string") ||
      new Set(requested.map(item => item.id)).size !== requested.length)
    throw new Error("Invalid focused creation inventory.");
  const creates = new Map(requested.map(item => [item.id, item]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const validateDependencies = (id: string): void => {
    if (visiting.has(id)) throw new Error("Cyclic focused creation dependencies.");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of creates.get(id)!.dependsOn) {
      if (typeof dependency !== "string" || !creates.has(dependency))
        throw new Error("Unknown focused creation dependency: " + dependency);
      validateDependencies(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };
  // The contract is parsed at entry, but this seam is also called from
  // independent verification paths: do not trust arbitrary caller data.
  for (const item of creates.values()) {
    if (!contract.scope.targets.includes(item.id) ||
        !/^(character|relationship|event|authored-content)\.[a-z][a-z0-9-]*$/.test(item.id) ||
        item.path !== ({ character: "characters", relationship: "relationships",
          event: "events", "authored-content": "authored-content" } as Record<string, string>)[item.id.split(".")[0] ?? ""] +
          "/" + item.id.split(".")[1] + ".md" ||
        !Array.isArray(item.references) || !Array.isArray(item.dependsOn) ||
        item.references.length > 16 || item.dependsOn.length > 12 ||
        new Set(item.references).size !== item.references.length ||
        new Set(item.dependsOn).size !== item.dependsOn.length ||
        item.references.some(ref => typeof ref !== "string" ||
          !/^(arc|character|relationship|event)\.[a-z][a-z0-9-]*$/.test(ref)))
      throw new Error("Invalid canonical focused creation grant.");
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
      const found = new Set(references(existing.metadata,
        new Set([...byId.keys(), ...creates.keys()])));
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
  for (const id of creates.keys()) validateDependencies(id);
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
