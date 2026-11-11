import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobStartResult } from "./job.js";
import type { CompletionContract } from "./architecture.js";
import { parseCreativePolicy, type CreativePolicy } from "./creative-policy.js";

export interface TurnAssignmentEvidence {
  id: string;
  specialist: string;
  outcome: string;
  targets: string[];
  dependsOn: string[];
  discovery: "canonical-story-read-only";
  authority: { recordTypes: string[]; existingPaths: string[]; mayCreate: boolean };
}
export interface TurnEvidence {
  version: 1;
  kind: "full-story" | "revision" | "protected-amendment";
  originalRequest: string;
  goal: string;
  source: { jobId: string | null; verifiedSha: string };
  contract: CompletionContract;
  /** Controller-interpreted outcome for this Turn, never inherited as Thread authority. */
  objective?: {
    breadth: "whole-story" | "focused" | "protected-amendment";
    requestedTargets: string[];
    deliveryDepth: CompletionContract["scope"]["depth"];
    obligations: string[];
  };
  assignments: TurnAssignmentEvidence[];
  reviewRequired: boolean;
  creativePolicy?: CreativePolicy;
  digest: string;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const SHA = /^[a-f0-9]{40}$/;
const validSavedPolicy = (value: unknown): boolean => {
  try { parseCreativePolicy(value); return true; } catch { return false; }
};
const safePath = /^[a-z][a-z-]*\/[a-z0-9-]+\.md$/;

/** Controller-owned private evidence; a model's claim is never permission. */
export async function readTurnEvidence(job: JobStartResult, contract: CompletionContract,
  originalRequest?: string, requiredDigest?: string): Promise<TurnEvidence | null> {
  let raw: string;
  try { raw = await readFile(join(job.stateDir, "turn-plan.json"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (requiredDigest) throw new Error("Required Turn plan receipt is missing; writer cannot resume.");
      return null;
    }
    throw error;
  }
  let plan: TurnEvidence;
  try { plan = JSON.parse(raw) as TurnEvidence; }
  catch { throw new Error("Stored Turn plan is not valid JSON."); }
  const { digest, ...body } = plan ?? ({} as TurnEvidence);
  const assignments = plan?.assignments;
  if (plan?.version !== 1 || !SHA.test(plan.source?.verifiedSha ?? "") ||
    plan.source.verifiedSha !== job.baseSha || !plan.goal?.trim() ||
    (originalRequest !== undefined && plan.originalRequest !== originalRequest) ||
    (plan.creativePolicy !== undefined && !validSavedPolicy(plan.creativePolicy)) ||
    JSON.stringify(plan.contract) !== JSON.stringify(contract) ||
    (plan.objective !== undefined && (
      plan.objective.breadth !== (plan.kind === "full-story" ? "whole-story" :
        plan.kind === "revision" ? "focused" : "protected-amendment") ||
      !Array.isArray(plan.objective.requestedTargets) ||
      JSON.stringify(plan.objective.requestedTargets) !== JSON.stringify(
        plan.kind === "revision" ? [...new Set(plan.contract.scope.targets)].sort() : []) ||
      plan.objective.deliveryDepth !== plan.contract.scope.depth ||
      !Array.isArray(plan.objective.obligations) || !plan.objective.obligations.length ||
      plan.objective.obligations.length > 32 ||
      plan.objective.obligations.some(o => typeof o !== "string" || !o.trim() || o.length > 2000))) ||
    !Array.isArray(assignments) || !assignments.length || assignments.length > 129 ||
    new Set(assignments.map(a => a.id)).size !== assignments.length ||
    assignments.some(a => !a.id || !a.outcome?.trim() ||
      a.discovery !== "canonical-story-read-only" || !Array.isArray(a.targets) ||
      !Array.isArray(a.dependsOn) ||
      !Array.isArray(a.authority?.recordTypes) ||
      !Array.isArray(a.authority?.existingPaths) ||
      a.authority.existingPaths.some(p => !safePath.test(p)) ||
      a.dependsOn?.some(parent => !assignments.some(b => b.id === parent)) ||
      typeof a.authority?.mayCreate !== "boolean") ||
    digest !== hash(body) || (requiredDigest && digest !== requiredDigest)) {
    throw new Error("Saved Turn plan, specialist assignments or source base are corrupt/stale.");
  }
  return plan;
}

export function assertFocusedTurnAssignment(plan: TurnEvidence, target: string,
  paths: string[], recordTypes: string[] = [target.split(".")[0]!]): TurnAssignmentEvidence {
  const assignment = plan.assignments.find(a => a.id === "focus:" + target);
  const type = target.split(".")[0]!;
  if (plan.kind !== "revision" || !assignment || assignment.targets.length !== 1 ||
    assignment.targets[0] !== target || assignment.authority.mayCreate ||
    !assignment.authority.recordTypes.includes(type) ||
    JSON.stringify([...assignment.authority.recordTypes].sort()) !==
      JSON.stringify([...new Set(recordTypes)].sort()) ||
    JSON.stringify([...assignment.authority.existingPaths].sort()) !==
      JSON.stringify([...paths].sort())) {
    throw new Error("Specialist assignment does not authorize this focused record write.");
  }
  return assignment;
}
