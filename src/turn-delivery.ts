/** Source-bound delivery obligations for one Turn, independent of its work queue.
 * This is a semantic-review checklist, not a record-count quota or a write grant.
 * The controller retains the original criteria when a plan is amended.
 */
import { isDeepStrictEqual } from "node:util";
import type { CompletionContract } from "./architecture.js";
import type { TurnEvidence } from "./turn-plan-evidence.js";

export interface NarrativeDeliveryCriteria {
  version: 1;
  breadth: "whole-story" | "focused";
  depth: CompletionContract["scope"]["depth"];
  targets: string[];
  branches: string[];
  objectives: Array<{ id: string; text: string }>;
}

export function deliveryCriteria(kind: TurnEvidence["kind"],
  contract: CompletionContract): NarrativeDeliveryCriteria {
  if (kind === "protected-amendment")
    throw new Error("Protected author amendments are not narrative delivery Turns.");
  const { scope } = contract;
  const wholeStory = kind === "full-story" || scope.kind === "full-story";
  const cluster = wholeStory || scope.targets.length === 0 ||
    scope.targets.some(id => id.startsWith("arc.") || id.startsWith("milestone."));
  const objectives: NarrativeDeliveryCriteria["objectives"] = [];
  if (cluster) {
    objectives.push({ id: "delivery:architecture", text:
      "Verified, causally connected Arc/Milestone outcomes at the requested narrative breadth, with real Story evidence. An outline needs no Events, interactive branches or player-facing prose unless separately requested." });
    if (scope.depth !== "architecture") {
      objectives.push({ id: "delivery:interactive", text:
        "Coherent, reachable Event/Choice/Puzzle structure where relevant to the requested outcome: prerequisites, actual choices, causal consequences and branch continuity. Structural validity or record counts alone are insufficient." });
    }
    if (scope.depth === "composition") {
      objectives.push({ id: "delivery:composition", text:
        "Connected player-facing Authored Content (scenes, narration and dialogue) for the requested narrative, reflecting relevant Events and branches, not just metadata or outline summaries." });
    }
    if (wholeStory) {
      objectives.push({ id: "delivery:complete-story", text:
        "A complete playable narrative from opening through meaningful branch outcomes and endings, with the promised breadth of Story fulfilled. A valid outline, fragment or mechanical quota is not a complete game." });
      objectives.push({ id: "delivery:payoff", text:
        "The central premise, mysteries, character motivations, revelations and promises receive substantive coherent payoffs; alternative choices produce meaningful consequences and resolutions, supported by actual authored Story evidence." });
    }
  } else {
    objectives.push({ id: "delivery:focus", text:
      "The specifically requested records and outcomes are delivered at the authorized narrative depth without requiring unrelated Arc/Milestone expansion or new prose when not requested." });
    if (scope.depth !== "architecture" && scope.targets.some(id =>
      ["event.", "choice-point.", "puzzle."].some(prefix => id.startsWith(prefix))))
      objectives.push({ id: "delivery:interactive", text:
        "Coherent, reachable Event/Choice/Puzzle structure with genuine prerequisites and consequential branches, not just valid typed references or record counts." });
    if (scope.depth === "composition" && scope.targets.some(id => id.startsWith("authored-content.")))
      objectives.push({ id: "delivery:composition", text:
        "The selected Authored Content contains substantive player-facing narrative, not merely metadata or an outline." });
  }
  scope.branches.forEach((branch, i) => objectives.push({ id: "delivery:branch:" + i,
    text: scope.depth === "architecture"
      ? "The requested branch/outcome '" + branch +
        "' is included in the Arc/Milestone outline with a coherent causal path and intended consequence; playable Event realization is not required at outline depth."
      : "The requested branch/outcome '" + branch +
        "' is reachable and causally consequential, with its prerequisites and downstream effects shown in the canonical Story." }));
  return { version: 1, breadth: wholeStory ? "whole-story" : "focused",
    depth: scope.depth, targets: [...scope.targets], branches: [...scope.branches], objectives };
}

/** The first controller-approved revision must descend from the original Turn.
 * verifyPlanHistory must first authenticate every supplied history entry.
 */
export function assertTurnDeliveryHistory(original: CompletionContract,
  approved: CompletionContract,
  history: ReadonlyArray<{ plan: { contract: CompletionContract } }>): void {
  if ((!history.length && !isDeepStrictEqual(original, approved)) ||
      (history.length > 0 && !isDeepStrictEqual(history[0]!.plan.contract, original)))
    throw new Error("Approved plan history does not descend from the original Turn contract.");
  assertDeliveryNotReduced(original, approved);
}

/** A new approved assignment set can grow or reorder work, never redefine the
 * original promised delivery. Explicit author direction uses a separate Turn.
 */
export function assertDeliveryNotReduced(original: CompletionContract,
  approved: CompletionContract): void {
  const old = original.scope, next = approved.scope;
  if (old.kind === "full-story" && next.kind !== "full-story")
    throw new Error("Approved plan reduced the original whole-Story breadth.");
  const rank = { architecture: 0, interactive: 1, composition: 2 };
  if (rank[next.depth] < rank[old.depth])
    throw new Error("Approved plan reduced the original delivery depth.");
  if (old.kind !== "full-story" && next.kind !== "full-story" &&
      old.targets.some(id => !next.targets.includes(id)))
    throw new Error("Approved plan removed an originally promised target.");
  if (next.kind !== "full-story" && old.branches.some(branch => !next.branches.includes(branch)))
    throw new Error("Approved plan removed an originally requested branch.");
}
