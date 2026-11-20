/** A causal discovery is a source-bound request for orchestration, not an
 * Architecture write grant. This is the same generation inventory and Git
 * lineage as ordinary assignment reconciliation, never a second scheduler. */
import { createHash } from "node:crypto";
import type { GenerationInventory } from "./generation-plan.js";
import type { MilestoneBlueprint } from "./milestone-blueprint.js";

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const HEAD = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MILESTONE = /^milestone\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SOURCE = /^milestones\/[a-z][a-z0-9-]*\.md$/;

export interface CausalDiscovery {
  sourcePath: string;
  sourceQuote: string;
  violatedObligation: string;
  proposedCorrection: string;
}
export interface CausalAmendmentInput extends CausalDiscovery {
  jobId: string; threadId: string; sourceSha: string;
  planVersion: number; reportDigest: string; milestoneId: string;
  sourcePaths: readonly string[]; sourceText: string;
  localBlueprint: MilestoneBlueprint; blueprintDigest: string;
  inventory: GenerationInventory;
  /** Authenticated current independent checkpoint assessments, never model claims. */
  reviewedWorkItems: readonly string[];
}
export interface CausalAmendment {
  schema: "noveltea-causal-amendment/v1";
  authority: "proposal-only";
  jobId: string; threadId: string;
  source: { sha: string; planVersion: number; reportDigest: string; blueprintDigest: string;
    path: string; quote: string; milestoneId: string };
  obligation: string;
  correction: string;
  affected: string[];
  carryForward: string[];
  /** Requires the existing trusted Architecture proposal/approval or protected
   * revision; semantic text does not grant consent or file permissions. */
  authorApprovalRequired: true;
  digest: string;
}
function impact(inventory: GenerationInventory, milestoneId: string): Set<string> {
  const items = inventory.items;
  const all = new Map(items.map(item => [item.id, item]));
  if (all.size !== items.length || items.some(item =>
    item.dependencies.some(dep => !all.has(dep) || dep === item.id))) {
    throw Error("Causal plan has duplicate, missing or self-referential assignments.");
  }
  // Check the ENTIRE DAG, including unrelated branches. A cycle cannot become
  // a valid corrective plan merely because it sits outside the selected root.
  const walked = new Set<string>(), visiting = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw Error("Cyclic Story prerequisites prohibit causal amendment.");
    if (walked.has(id)) return;
    visiting.add(id);
    for (const dep of all.get(id)!.dependencies) visit(dep);
    visiting.delete(id);
    walked.add(id);
  };
  for (const id of all.keys()) visit(id);
  const root = "event:" + milestoneId;
  if (!all.has(root)) throw Error("Causal target is absent from the authorized generation inventory.");
  const affected = new Set([root]);
  for (let step = 0; step < items.length; step++) {
    for (const item of items) if (item.dependencies.some(id => affected.has(id)))
      affected.add(item.id);
  }
  return affected;
}
export function buildCausalAmendment(input: CausalAmendmentInput): CausalAmendment {
  if (!input.jobId?.trim() || !input.threadId?.trim() || !HEAD.test(input.sourceSha) ||
      !DIGEST.test(input.reportDigest) || !DIGEST.test(input.blueprintDigest) ||
      !Number.isSafeInteger(input.planVersion) || input.planVersion < 1 ||
      input.inventory.planVersion !== input.planVersion ||
      input.inventory.headSha !== input.sourceSha ||
      !MILESTONE.test(input.milestoneId) ||
      input.localBlueprint.schema !== "noveltea-milestone-blueprint/v1" ||
      input.localBlueprint.milestoneId !== input.milestoneId ||
      !SOURCE.test(input.sourcePath) ||
      !input.sourcePaths.includes(input.sourcePath) ||
      input.sourceQuote.length < 20 || input.sourceQuote.length > 500 ||
      !input.sourceText.includes(input.sourceQuote) ||
      input.sourceText.indexOf(input.sourceQuote) !== input.sourceText.lastIndexOf(input.sourceQuote) ||
      !input.violatedObligation.trim() || input.violatedObligation.length > 500 ||
      !input.proposedCorrection.trim() || input.proposedCorrection.length > 1000 ||
      !input.localBlueprint.events.some(event =>
        event.evidence.some(e => e.anchorPath === input.sourcePath &&
          e.establishes === input.violatedObligation) ||
        event.purpose === input.violatedObligation) &&
      !input.localBlueprint.downstream.some(d => d.obligation === input.violatedObligation)) {
    throw Error("Causal discovery is not grounded in the exact canonical Milestone and reviewed local Blueprint.");
  }
  const affectedSet = impact(input.inventory, input.milestoneId);
  const reviewed = new Set(input.reviewedWorkItems);
  const selected = new Set<string>();
  // Only independently reviewed, completed, unaffected work can even be
  // nominated. Architecture and final review are never carried forward.
  const carried = input.inventory.items.filter(item =>
    item.status === "verified" && !affectedSet.has(item.id) &&
    reviewed.has(item.id) &&
    (item.stage === "foundations" ||
     ["event", "interactive", "composition"].includes(item.stage) && !!item.milestone));
  for (const item of carried) {
    if (item.stage === "foundations" ||
        (item.stage === "event" && selected.has("foundations")) ||
        (item.stage === "interactive" && selected.has("event:" + item.milestone)) ||
        (item.stage === "composition" &&
          selected.has("event:" + item.milestone) &&
          selected.has("interactive:" + item.milestone))) {
      selected.add(item.id);
    }
  }
  // Build a historical continuation proposal, not a claim that a changed
  // source has already passed new native and semantic revalidation.
  const provisional = {
    schema: "noveltea-causal-amendment/v1" as const,
    authority: "proposal-only" as const,
    jobId: input.jobId, threadId: input.threadId,
    source: { sha: input.sourceSha, planVersion: input.planVersion,
      reportDigest: input.reportDigest, blueprintDigest: input.blueprintDigest,
      path: input.sourcePath, quote: input.sourceQuote, milestoneId: input.milestoneId },
    obligation: input.violatedObligation, correction: input.proposedCorrection,
    affected: input.inventory.items.filter(item => affectedSet.has(item.id)).map(item => item.id),
    carryForward: [...selected],
    authorApprovalRequired: true as const,
  };
  return { ...provisional, digest: sha(provisional) };
}
export function verifyCausalAmendment(proposal: CausalAmendment, input: CausalAmendmentInput) {
  const expected = buildCausalAmendment(input);
  if (JSON.stringify(proposal) !== JSON.stringify(expected))
    throw Error("Causal amendment has stale, tampered or wrong-Thread source/impact evidence.");
}
