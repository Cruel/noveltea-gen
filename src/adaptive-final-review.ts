/** Read-only projection of the authenticated adaptive ledger for final,
 * independent whole-Story fulfillment review. Neither a planner receipt nor
 * an omission is a writer commit, semantic pass or author approval.
 *
 * The caller MUST obtain the ledger with readAdaptiveState and reconcile
 * its admitted work against the current native Story before completion. */
import type { AdaptiveState } from "./adaptive-state.js";

interface FinalWork {
  id: string;
  kind: string;
  targets: string[];
  status: string;
  outcome?: string;
  dependsOn?: string[];
  omission?: { sourceSha: string; path: string; evidence: string; reviewerSnapshot: string };
  supersession?: { originalAmendment: string; negativeReport: string;
    omissionReview: string; reviewedBlueprint: string; sourceSha: string };
}
interface FinalObjective { id: string; text: string }

export function projectAdaptiveFinal(state: AdaptiveState): {
  source: { version: number; digest: string; amendments: string[] };
  objectives: FinalObjective[];
  plannedWork: FinalWork[];
  superseded: string[];
} {
  if (state.version !== state.entries.length + (state.supersessions?.length ?? 0) + 1)
    throw Error("Final adaptive review lost the authorized plan version.");
  const work = new Map<string, FinalWork>();
  const superseded = new Set<string>();
  const objectives = new Map<string, FinalObjective>();
  const history = [...state.entries.map(entry => ({ kind: "proposal" as const, entry })),
    ...(state.supersessions ?? []).map(entry => ({ kind: "supersession" as const, entry }))]
    .sort((a, b) => a.entry.beforeVersion - b.entry.beforeVersion);
  for (const item of history) {
    if (item.kind === "supersession") {
      const successor = item.entry;
      const original = state.entries.find(entry => entry.digest === successor.originalAmendmentDigest);
      if (!original || !original.order.includes(successor.assignmentId) ||
          work.get(successor.assignmentId)?.status === "reviewed-omission")
        throw Error("Final adaptive supersession lost its unique reviewed original assignment.");
      for (const entry of state.entries) if (entry.afterVersion <= successor.beforeVersion)
        for (const [index, action] of entry.actions.entries())
          if (action.kind === "narrow" && action.item === successor.assignmentId)
            objectives.delete("adaptive:" + entry.afterVersion + ":" + index);
      const milestone = successor.assignmentId.slice("interactive:".length);
      work.set(successor.assignmentId, { id: successor.assignmentId,
        kind: "reviewed-omission", targets: [milestone], status: "reviewed-omission",
        supersession: { originalAmendment: successor.originalAmendmentDigest,
          negativeReport: successor.negativeReportDigest,
          omissionReview: successor.omission.digest,
          reviewedBlueprint: successor.reviewedBlueprint.digest,
          sourceSha: successor.sourceSha } });
      objectives.set("adaptive:" + successor.afterVersion + ":supersession", {
        id: "adaptive:" + successor.afterVersion + ":supersession",
        text: "Recheck the independently reviewed Event-only no-write outcome for " +
          successor.assignmentId + " against original author goals, actual Milestone/Event sources, " +
          "the prior negative Choice report and the superseding approved Blueprint. " +
          "Do not infer new gameplay, replay the failed specialist or treat this as a Git commit. " +
          "All remaining Story-wide Choice/Puzzle promises and causal consequences remain required." });
      continue;
    }
    const entry = item.entry;
    for (const [index, action] of entry.actions.entries()) {
      const objectiveId = "adaptive:" + entry.afterVersion + ":" + index;
      if (action.kind === "add") {
        const id = action.stage + ":" + action.milestone;
        work.set(id, { id, kind: action.stage, targets: [action.milestone],
          status: "controller-admitted", dependsOn: action.dependsOn });
        superseded.delete(id); // A later reviewed replan can reauthorize a retired aggregate.
        objectives.set(objectiveId, { id: objectiveId,
          text: "Verify newly authorized " + id + " fulfills its causal Story outcome " +
            "and dependencies (" + action.dependsOn.join(", ") +
            ") with real source-linked consequences, not record counts." });
      } else if (action.kind === "split") {
        const milestone = action.item.slice("interactive:".length);
        work.delete(action.item);
        superseded.add(action.item);
        for (const domain of action.domains) {
          const id = domain + ":" + milestone;
          work.set(id, { id, kind: domain, targets: [milestone], status: "controller-admitted" });
        }
        objectives.set(objectiveId, { id: objectiveId,
          text: "Verify the separately reviewed " + action.domains.map(domain =>
            domain === "puzzle" ? "Puzzle" : "Choice").join(" and ") +
            " assignments for " + milestone + " express justified player experience, " +
            "with causal consequences after any route convergence, not arbitrary quotas." });
      } else if (action.kind === "narrow") {
        const milestone = /milestone\.[a-z][a-z0-9-]*$/.exec(action.item)?.[0];
        const prior = work.get(action.item);
        work.set(action.item, { id: action.item, kind: action.item.split(":")[0]!,
          targets: prior?.targets ?? (milestone ? [milestone] : []),
          status: "controller-refined", outcome: action.outcome });
        objectives.set(objectiveId, { id: objectiveId,
          text: "Verify independently reviewed source-bound assignment " + action.item +
            " (" + action.sourcePath + "): " + action.outcome });
      } else if (action.kind === "depend") {
        const prior = work.get(action.item);
        if (prior) work.set(action.item, { ...prior,
          dependsOn: [...new Set([...(prior.dependsOn ?? []), action.needs])] });
        objectives.set(objectiveId, { id: objectiveId,
          text: "Verify causal prerequisite " + action.needs + " is satisfied before " +
            action.item + "; check the resulting whole-Story causal continuity." });
      } else if (action.kind === "omit") {
        const proof = entry.omissions.filter(p => p.assignmentId === action.item);
        if (proof.length !== 1 || work.get(action.item)?.status === "reviewed-omission")
          throw Error("Final adaptive review lost a unique independently reviewed omission or found a duplicate disposition.");
        const p = proof[0]!;
        const milestone = /milestone\.[a-z][a-z0-9-]*$/.exec(action.item)?.[0];
        work.set(action.item, { id: action.item, kind: "reviewed-omission",
          targets: milestone ? [milestone] : [], status: "reviewed-omission",
          omission: { sourceSha: p.sourceSha, path: p.path, evidence: p.evidence,
            reviewerSnapshot: p.reviewerSnapshot } });
        objectives.set(objectiveId, { id: objectiveId,
          text: "Independently verify the reviewed no-write omission of " + action.item +
            " at " + p.path + " (" + p.evidence + ") is justified by actual authored " +
            "Story evidence and does not erase the original Author objective or any " +
            "remaining whole-Story interaction/causal obligations. No commit is implied." });
      }
    }
  }
  return { source: { version: state.version, digest: state.digest,
      amendments: history.map(item => item.entry.digest) },
    objectives: [...objectives.values()], plannedWork: [...work.values()],
    superseded: [...superseded] };
}
