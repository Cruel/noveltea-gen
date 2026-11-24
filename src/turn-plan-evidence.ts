import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
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
  authority: { recordTypes: string[]; existingPaths: string[]; mayCreate: boolean;
    newPaths?: string[] };
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

/** Shared, structural objective attestation for web admission and worker replay.
 * Per-boundary ownership, Git and contract integrity checks remain with callers. */
export function validTurnObjective(plan: TurnEvidence): boolean {
  const objective = plan?.objective;
  if (!["full-story", "revision", "protected-amendment"].includes(plan?.kind) ||
      !objective || typeof objective !== "object" || Array.isArray(objective) ||
      !plan.contract?.scope || !Array.isArray(plan.contract.scope.targets)) return false;
  return objective.breadth === (plan.kind === "full-story" ? "whole-story" :
      plan.kind === "revision" ? "focused" : "protected-amendment") &&
    Array.isArray(objective.requestedTargets) &&
    JSON.stringify(objective.requestedTargets) === JSON.stringify(
      plan.kind === "revision" ? [...new Set(plan.contract.scope.targets)].sort() : []) &&
    objective.deliveryDepth === plan.contract.scope.depth &&
    Array.isArray(objective.obligations) && objective.obligations.length > 0 &&
    objective.obligations.length <= 32 &&
    objective.obligations.every(o => typeof o === "string" && !!o.trim() && o.length <= 2000);
}

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
  if (!plan?.objective)
    throw new Error("Saved plan lacks an authenticated current-format Turn objective; obsolete execution is refused.");
  if (plan?.version !== 1 || !SHA.test(plan.source?.verifiedSha ?? "") ||
    plan.source.verifiedSha !== job.baseSha || !plan.goal?.trim() ||
    (originalRequest !== undefined && plan.originalRequest !== originalRequest) ||
    (plan.creativePolicy !== undefined && !validSavedPolicy(plan.creativePolicy)) ||
    !isDeepStrictEqual(plan.contract, contract) ||
    !validTurnObjective(plan) ||
    !Array.isArray(assignments) || !assignments.length || assignments.length > 129 ||
    new Set(assignments.map(a => a.id)).size !== assignments.length ||
    assignments.some(a => !a.id || !a.outcome?.trim() ||
      a.discovery !== "canonical-story-read-only" || !Array.isArray(a.targets) ||
      !Array.isArray(a.dependsOn) ||
      !Array.isArray(a.authority?.recordTypes) ||
      !Array.isArray(a.authority?.existingPaths) ||
      a.authority.existingPaths.some(p => !safePath.test(p)) ||
      (a.authority.newPaths !== undefined && (!Array.isArray(a.authority.newPaths) ||
        a.authority.newPaths.some(p => !safePath.test(p)))) ||
      a.dependsOn?.some(parent => !assignments.some(b => b.id === parent)) ||
      typeof a.authority?.mayCreate !== "boolean" ||
      (plan.kind === "revision" && a.id.startsWith("focus:") && (() => {
        const target = a.id.slice("focus:".length);
        const create = plan.contract.scope.creates?.find(item => item.id === target);
        return a.authority.mayCreate !== !!create ||
          JSON.stringify(a.authority.newPaths ?? []) !== JSON.stringify(create ? [create.path] : []) ||
          (create && (a.targets.length !== 1 || a.targets[0] !== target ||
            !create.dependsOn.every(parent => a.dependsOn.includes("focus:" + parent))));
      })())) ||
    digest !== hash(body) || (requiredDigest && digest !== requiredDigest)) {
    throw new Error("Saved Turn plan, specialist assignments or source base are corrupt/stale.");
  }
  return plan;
}

export function assertFocusedTurnAssignment(plan: TurnEvidence, target: string,
  paths: string[], recordTypes: string[] = [target.split(".")[0]!]): TurnAssignmentEvidence {
  const assignment = plan.assignments.find(a => a.id === "focus:" + target);
  const type = target.split(".")[0]!;
  const create = plan.contract.scope.creates?.find(item => item.id === target);
  if (plan.kind !== "revision" || !assignment || assignment.targets.length !== 1 ||
    assignment.targets[0] !== target || assignment.authority.mayCreate !== !!create ||
    JSON.stringify(assignment.authority.newPaths ?? []) !==
      JSON.stringify(create ? [create.path] : []) ||
    !assignment.authority.recordTypes.includes(type) ||
    JSON.stringify([...assignment.authority.recordTypes].sort()) !==
      JSON.stringify([...new Set(recordTypes)].sort()) ||
    JSON.stringify([...assignment.authority.existingPaths,
      ...(assignment.authority.newPaths ?? [])].sort()) !==
      JSON.stringify([...paths].sort())) {
    throw new Error("Specialist assignment does not authorize this focused record write.");
  }
  return assignment;
}
