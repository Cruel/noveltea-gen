import { createHash } from "node:crypto";
import { type Plan, type WorkItem } from "./architecture.js";
import { auditNarrativeScope, type ScopeAudit } from "./narrative-review.js";
import { type ValidationResult } from "./validator.js";
import { isFocusedScope } from "./focused-scope.js";

export const generationStages = ["foundation", "architecture", "foundations", "event", "interactive", "composition", "focus", "review"] as const;
export type GenerationStage = typeof generationStages[number];
export interface GenerationEvidence {
  stage: GenerationStage; milestone?: string; headSha: string; status: string; planVersion?: number;
}
export interface ExecutionItem extends WorkItem {
  stage: GenerationStage;
  milestone?: string;
  /** Architecture items refined by this executable unit. Never mutate the author-approved plan. */
  plannedItems: string[];
  /** Fulfilled by a reviewed, source-bound omission rather than a new writer. */
  omission?: { reason: string; evidence: string; reviewerSession: string };
}
export interface GenerationInventory {
  version: number; planVersion: number | null; headSha: string;
  items: ExecutionItem[]; audit?: ScopeAudit;
  rationale: string;
}
/** Existing work is never re-authored just because a newly discovered edge
 * invalidates its prior dependency attestation. Mark only affected verified
 * checkpoints (and their descendants via normal dependency propagation) as
 * needing an explicit reconciliation; independent checkpoints remain intact. */
export function invalidateChangedVerifiedPrerequisites(
  items: ExecutionItem[], previous?: GenerationInventory | null,
): void {
  for (const item of items) {
    const prior = previous?.items.find(other => other.id === item.id);
    const affected = prior?.blockingReason?.startsWith("Verified checkpoint has a new causal prerequisite:") ||
      (prior?.status === "verified" && item.status === "verified" &&
        item.dependencies.some(dependency => !prior.dependencies.includes(dependency)));
    if (affected && item.status === "verified") {
      item.status = "blocked";
      item.blockingReason = prior?.blockingReason?.startsWith("Verified checkpoint has a new causal prerequisite:")
        ? prior.blockingReason
        : "Verified checkpoint has a new causal prerequisite: " +
          item.dependencies.filter(dependency => !prior!.dependencies.includes(dependency)).join(", ") +
          "; inspect the preserved commit and obtain bounded reconciliation.";
      delete item.verifiedSha;
    }
  }
  // A downstream review or specialist cannot remain certified against an
  // invalidated upstream checkpoint, even if its own direct edge list did not
  // change. Do not invalidate independent branches or delete their Git commits.
  for (let pass = 0; pass < items.length; pass++) {
    for (const item of items) {
      if (item.status !== "verified") continue;
      const prior = previous?.items.find(other => other.id === item.id);
      const sticky = prior?.blockingReason?.startsWith("Downstream checkpoint depends on a changed prerequisite:") ||
        prior?.blockingReason?.startsWith("Downstream checkpoint depends on invalidated omission:");
      const affected = item.dependencies.find(id => {
        const parent = items.find(other => other.id === id);
        return parent?.status === "blocked" &&
          (parent.blockingReason?.startsWith("Verified checkpoint has a new causal prerequisite:") ||
           parent.blockingReason?.startsWith("Downstream checkpoint depends on a changed prerequisite:") ||
           parent.blockingReason?.startsWith("Downstream checkpoint depends on invalidated omission:"));
      });
      if (sticky || affected) {
        item.status = "blocked";
        item.blockingReason = sticky ? prior!.blockingReason :
          "Downstream checkpoint depends on a changed prerequisite: " + affected +
          "; review the preserved source and reconcile its assurance.";
        delete item.verifiedSha;
      }
    }
  }
}

export function reconcileInventory(plan: Plan | undefined, validation: ValidationResult | undefined,
  headSha: string, completed: GenerationEvidence[], failures: Record<string, string>,
  previous?: GenerationInventory | null): GenerationInventory {
  const items: ExecutionItem[] = [];
  const version = plan?.version ?? 1;
  const add = (stage: GenerationStage, dependencies: string[], milestone?: string) => {
    const id = milestone ? `${stage}:${milestone}` : stage;
    const targets = milestone ? [milestone] :
      stage === "foundation" ? ["creative-direction.foundation"] : plan?.items[0]?.targetIds ?? [];
    const planned = plan?.items.filter(i => stage === "foundation" || stage === "foundations" ? false : stage === "architecture" ? i.kind === "architecture" :
      stage === "review" ? i.kind === "review" : stage === "focus" ? i.id === "focus-" + milestone?.replace(".", "-") :
      stage === "composition" ? i.kind === "composition" :
      i.kind === "realization" && i.targetIds.some(t => targets.includes(t))) ?? [];
    const evidence = [...completed].reverse().find(e => e.stage === stage && e.milestone === milestone);
    const reason = stage === "review" && evidence && evidence.status !== "complete-in-scope"
      ? evidence.status : failures[id];
    const syntheticSkills = stage === "foundation" ? ["nt-story-discovery", "nt-catalog"] :
      stage === "foundations" ? ["nt-worldbuilding", "nt-character-development", "nt-catalog"] : [];
    const syntheticChecks = stage === "foundation" ? ["foundation-design-readiness", "protected-decisions"] :
      stage === "foundations" ? ["canonical-structure", "world-and-character-foundations"] : [];
    items.push({ id, stage, milestone, kind: stage === "architecture" || stage === "foundation" ? "architecture" :
      stage === "composition" ? "composition" : stage === "review" ? "review" : "realization",
      targetIds: targets, dependencies, plannedItems: planned.map(i => i.id),
      skills: [...new Set([...syntheticSkills, ...planned.flatMap(i => i.skills)])],
      checks: [...new Set([...syntheticChecks, ...planned.flatMap(i => i.checks)])],
      authorization: { source: stage === "foundation" || version === 1 ? "explicit-author-cli" : "trusted-controller",
        planVersion: stage === "foundation" ? 1 : version, paths: [] },
      planVersion: version, status: reason ? "blocked" : evidence ? "verified" : "pending",
      ...(!reason && evidence ? { verifiedSha: evidence.headSha } : {}),
      ...(reason ? { blockingReason: reason } : {}) });
  };
  add("foundation", []);
  add("architecture", ["foundation"]);
  const focused = !!plan && isFocusedScope(plan.contract);
  let audit: ScopeAudit | undefined;
  if (plan && validation && items[1]!.status === "verified") {
    audit = auditNarrativeScope(plan, validation, headSha);
    if (focused) {
      // Existing-record revisions are not Milestone-wide realization requests.
      // The first target owns explicitly listed supporting-record edits; all
      // other targets remain independent work units.
      const selected = new Set(plan.contract.scope.targets);
      const plannedCreates = new Map((plan.contract.scope.creates ?? []).map(item => [item.id, item]));
      const records = (validation?.report as { records?: Array<{ metadata?: {
        id?: string; type?: string; events?: string[] } }> } | undefined)?.records ?? [];
      for (const target of plan.contract.scope.targets) {
        const metadata = records.find(record => record.metadata?.id === target)?.metadata;
        // Writing dependent prose before a selected Event can strand its
        // dialogue against an obsolete scene. Only trusted typed links create
        // these prerequisites; unselected context stays read-only.
        const parents = metadata?.type === "authored-content" && Array.isArray(metadata.events)
          ? metadata.events.filter(id => selected.has(id) && id.startsWith("event."))
          : [];
        const creationDependencies = plannedCreates.get(target)?.dependsOn.map(id => "focus:" + id) ?? [];
        add("focus", [...new Set(["architecture", ...parents.map(id => "focus:" + id),
          ...creationDependencies])], target);
      }
      add("review", plan.contract.scope.targets.map(target => "focus:" + target));
    } else if (plan.contract.scope.depth !== "architecture") {
      add("foundations", ["architecture"]);
      const authorized = new Set(plan.items.find(i => i.id === "global-architecture" && i.status === "verified")?.targetIds);
      const milestones = audit.scopedRecords.filter(id => id.startsWith("milestone.")).sort();
      for (const milestone of milestones) {
        add("event", ["foundations"], milestone);
        if (!authorized.has(milestone)) {
          const item = items.at(-1)!;
          item.status = "blocked"; delete item.verifiedSha;
          item.blockingReason = "Canonical scope expanded beyond verified architecture targets; approve/reconcile architecture before writing.";
        }
        add("interactive", [`event:${milestone}`], milestone);
        if (plan.contract.scope.depth === "composition") add("composition", [`interactive:${milestone}`], milestone);
      }
      // Translate the approved architecture DAG into executable prerequisites.
      // The legacy aggregate composition/review entries are planning placeholders,
      // not global barriers between independently developable Milestones.
      const planById = new Map(plan.items.map(item => [item.id, item]));
      const canonical = (validation.report as { records?: Array<{ metadata: {
        id: string; type: string; status: string; arcs?: string[] } }> }).records ?? [];
      const milestoneTargets = (target: string) => target.startsWith("milestone.") ? [target] :
        canonical.filter(record => record.metadata.type === "milestone" &&
          record.metadata.status !== "superseded" && record.metadata.arcs?.includes(target))
          .map(record => record.metadata.id);
      for (const item of items.filter(i => i.stage === "event")) {
        for (const source of plan.items.filter(p => item.plannedItems.includes(p.id))) {
          for (const dependency of source.dependencies) {
            const prerequisite = planById.get(dependency);
            if (!prerequisite) {
              item.status = "blocked";
              item.blockingReason = "Unknown typed work-item dependency: " + dependency;
              continue;
            }
            if (prerequisite.kind === "architecture") {
              item.dependencies.push("architecture");
              continue;
            }
            if (prerequisite.kind !== "realization" || !prerequisite.targetIds.length) {
              item.status = "blocked";
              item.blockingReason = "Unsupported typed work-item prerequisite: " + dependency;
              continue;
            }
            const targets = prerequisite.targetIds.flatMap(milestoneTargets);
            if (!targets.length || targets.some(target => !milestones.includes(target))) {
              item.status = "blocked";
              item.blockingReason = "Dependency requires unapproved or missing scope: " + dependency;
              continue;
            }
            item.dependencies.push(...targets.map(target => `event:${target}`));
          }
        }
        item.dependencies = [...new Set(item.dependencies)];
      }
      // Cycles are blocked explicitly; no item in a cycle can be treated as ready.
      const byId = new Map(items.map(item => [item.id, item]));
      const visiting = new Set<string>(), visited = new Set<string>();
      const visit = (id: string, path: string[]) => {
        if (visiting.has(id)) {
          for (const cyclic of path.slice(path.indexOf(id))) {
            const item = byId.get(cyclic)!;
            item.status = "blocked";
            item.blockingReason = "Cyclic work-item dependency: " + [...path, id].join(" -> ");
          }
          return;
        }
        if (visited.has(id)) return;
        visiting.add(id);
        for (const dependency of byId.get(id)?.dependencies ?? []) if (byId.has(dependency))
          visit(dependency, [...path, id]);
        visiting.delete(id); visited.add(id);
      };
      for (const item of items) visit(item.id, []);
      add("review", items.filter(i => ["composition", "interactive"].includes(i.stage) &&
        (plan.contract.scope.depth !== "composition" || i.stage === "composition")).map(i => i.id));
    } else add("review", ["architecture"]);
  }
  invalidateChangedVerifiedPrerequisites(items, previous);
  // Dependencies are live: a local block prevents its descendants, not independent clusters.
  for (let pass = 0; pass < items.length; pass++) for (const item of items) {
    if (item.status !== "pending") continue;
    const blocked = item.dependencies.find(id => !items.some(i => i.id === id) || items.find(i => i.id === id)?.status === "blocked");
    if (blocked) { item.status = "blocked"; item.blockingReason = "Blocked dependency: " + blocked; }
  }
  const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const changed = !previous || previous.headSha !== headSha || previous.planVersion !== (plan?.version ?? null) ||
    fingerprint(previous.items) !== fingerprint(items);
  return { version: (previous?.version ?? 0) + (changed ? 1 : 0), planVersion: plan?.version ?? null,
    headSha, items, audit, rationale: previous?.planVersion !== (plan?.version ?? null)
      ? "Accepted architecture plan changed; reconcile authorized scope and retained work."
      : "Reconciled current canonical coverage, dependencies and verified specialist results." };
}
/** Controller checks readiness first; the read-only orchestrator may only
 * prioritize already-runnable, controller-authorized assignments. */
export function nextExecutionItem(inventory: GenerationInventory, order?: readonly string[]) {
  const ready = inventory.items.filter(item => item.status === "pending" && item.dependencies.every(id =>
    inventory.items.some(parent => parent.id === id && parent.status === "verified")));
  if (!order?.length) return ready[0];
  const priority = (item: ExecutionItem) => {
    const exact = order.indexOf(item.id);
    return exact >= 0 ? exact : order.indexOf(item.stage);
  };
  return ready.sort((a, b) => {
    const left = priority(a), right = priority(b);
    return (left < 0 ? order.length : left) - (right < 0 ? order.length : right);
  })[0];
}
