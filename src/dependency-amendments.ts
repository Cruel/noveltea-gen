import { declaredCanonicalReferences, type CanonicalScopeRecord } from "./focused-scope.js";
import { focusedSpecialist } from "./focused-specialist.js";
import type { TurnAssignmentEvidence, TurnEvidence } from "./turn-plan-evidence.js";
import { createHash } from "node:crypto";
import type { ReviewDependencyRequest } from "./review-repair-amendment.js";

export interface DependencySource { path: string; sha256: string; quote: string }
export interface DependencyReport {
  sourceSha: string; turnDigest: string; assignmentId: string;
  obligation: string; missing: string; affectedIds: string[];
  sources: DependencySource[]; likelySpecialist: string; authorDecisionRequired: boolean;
}
export interface DependencyProposal {
  sourceSha: string; reportDigest: string; target: string; specialist: string;
  outcome: string; reason: string;
}
/** A Character creation proposal is merely a name and rationale. It cannot
 * supply a file path or edit authorization; the controller derives those. */
export interface ReviewCharacterProposal extends DependencyProposal {
  title: string;
}
export interface DependencyAmendment {
  beforeVersion: number; afterVersion: number; sourceSha: string; turnDigest: string;
  reportDigest: string; reason: string; objective: TurnEvidence["objective"];
  resumes: string; assignment: TurnAssignmentEvidence;
}
const text = (v: unknown, max = 2000): v is string => typeof v === "string" && !!v.trim() && v.length <= max;
const sourceHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const keys = (v: unknown, expected: string) => !!v && typeof v === "object" && !Array.isArray(v) &&
  Object.keys(v).sort().join(",") === expected.split(",").sort().join(",");
const id = /^[a-z][a-z-]*\.[a-z][a-z0-9-]*$/;
const path = /^[a-z][a-z-]*\/[a-z][a-z0-9-]*\.md$/;
export function parseDependencyReport(value: unknown): DependencyReport {
  const r = value as DependencyReport;
  if (!keys(r, "sourceSha,turnDigest,assignmentId,obligation,missing,affectedIds,sources,likelySpecialist,authorDecisionRequired") ||
      !/^[a-f0-9]{40}$/.test(r.sourceSha) || !/^[a-f0-9]{64}$/.test(r.turnDigest) ||
      !text(r.assignmentId, 200) || !text(r.obligation) || !text(r.missing) ||
      !text(r.likelySpecialist, 80) || typeof r.authorDecisionRequired !== "boolean" ||
      !Array.isArray(r.affectedIds) || !r.affectedIds.length || r.affectedIds.length > 12 ||
      r.affectedIds.some(v => typeof v !== "string" || !id.test(v)) ||
      new Set(r.affectedIds).size !== r.affectedIds.length ||
      !Array.isArray(r.sources) || !r.sources.length || r.sources.length > 8 ||
      r.sources.some(s => !keys(s, "path,sha256,quote") || !path.test(s.path) ||
        !/^[a-f0-9]{64}$/.test(s.sha256) || !text(s.quote)))
    throw Error("Malformed dependency evidence report.");
  return structuredClone(r);
}
// Only typed canonical link fields establish connection; free prose and titles
// mentioning an ID cannot turn an unrelated enhancement into a prerequisite.
function links(record: CanonicalScopeRecord, target: string): boolean {
  return declaredCanonicalReferences(record).has(target);
}

/** A review-discovered gap in a whole Story can warrant one *new*
 * Character and one field-limited Arc link. This reuses DependencyAmendment
 * and the same typed owner/path grants as focused prerequisite work. Neither
 * reviewer text nor a planner-proposed ID/path is trusted as authority.
 *
 * The caller must independently attest the saved request against its sealed
 * review and reconstruct these catalog records using native validation at HEAD.
 * This pure gate checks every original Turn/owner/scope and exact proposal;
 * Git and field-level diff auditing remain mandatory at dispatch. */
export function authorizeReviewCharacterDependency(input: {
  plan: TurnEvidence; head: string; request: ReviewDependencyRequest;
  proposal: ReviewCharacterProposal; reportDigest: string;
  records: CanonicalScopeRecord[]; version: number;
  priorAmendments?: TurnAssignmentEvidence[];
}): DependencyAmendment {
  const { plan, head, request, proposal, records } = input;
  const owner = plan.assignments.find(a => a.id === request.originalAssignmentId);
  const citedArcs = request.findings.filter(f => /^arcs\/[a-z][a-z0-9-]*\.md$/.test(f.path));
  const [cited] = citedArcs;
  const arc = records.find(r => r.path === cited?.path);
  const proposedPath = typeof proposal?.target === "string" &&
    /^character\.[a-z][a-z0-9-]*$/.test(proposal.target)
    ? "characters/" + proposal.target.slice("character.".length) + ".md" : "";
  const priorOwners = [...(input.priorAmendments ?? [])];
  if (request.kind !== "review-dependency" ||
      request.classification !== "new-full-story-record" ||
      request.action !== "controller-amendment-required" ||
      plan.kind !== "full-story" || plan.objective?.breadth !== "whole-story" ||
      !owner || owner.specialist !== "nt-worldbuilding + nt-character-development" ||
      !owner.authority.mayCreate || !owner.authority.recordTypes.includes("character") ||
      request.originalWorkItem !== "character-foundations" ||
      request.sourceSha !== head || plan.digest !== request.turnDigest ||
      sourceHash(plan.objective) !== request.objectiveDigest ||
      sourceHash(plan.contract.scope) !== request.scopeDigest ||
      sourceHash(plan.assignments) !== request.ownersDigest ||
      sourceHash(owner) !== request.originalAssignmentDigest ||
      !text(proposal.title, 120) || /[\r\n]/.test(proposal.title) ||
      !keys(proposal, "sourceSha,reportDigest,target,specialist,outcome,reason,title") ||
      !text(proposal.reason) || !text(proposal.outcome) ||
      proposal.sourceSha !== head || proposal.reportDigest !== input.reportDigest ||
      !/^[a-f0-9]{64}$/.test(input.reportDigest) ||
      proposal.specialist !== "nt-character-development" ||
      !proposedPath || !cited || citedArcs.length !== 1 ||
      proposal.outcome !== cited.requiredCorrection ||
      !arc || arc.metadata.type !== "arc" ||
      arc.metadata.status === "superseded" ||
      !/^arc\.[a-z][a-z0-9-]*$/.test(arc.metadata.id) ||
      !Array.isArray(arc.metadata.characters) ||
      !arc.metadata.characters.every(id => typeof id === "string" && /^character\.[a-z][a-z0-9-]*$/.test(id)) ||
      records.some(r => r.path === proposedPath || r.metadata.id === proposal.target) ||
      priorOwners.some(a => a.authority.existingPaths.some(p =>
        p === proposedPath || p === arc.path) ||
        a.authority.newPaths?.some(p => p === proposedPath || p === arc.path) ||
        a.targets.includes(proposal.target)) ||
      !Number.isSafeInteger(input.version) || input.version < 1 || input.version > 8)
    throw Error("Review dependency lacks exact approved full-Story creation, Arc source, owner or plan authorization.");
  // The Character may be off-screen; the reviewer-proposed name and title are
  // not allowed to rewrite existing Character histories or Arc creative prose.
  // Allow one new Character path, and one existing Arc's link-only field.
  return {
    beforeVersion: input.version, afterVersion: input.version + 1,
    sourceSha: head, turnDigest: plan.digest, reportDigest: input.reportDigest,
    reason: proposal.reason, objective: structuredClone(plan.objective),
    resumes: owner.id,
    assignment: {
      id: "dependency:" + input.version + ":" + proposal.target,
      specialist: "nt-character-development", outcome: proposal.outcome,
      targets: [proposal.target], dependsOn: [], discovery: "canonical-story-read-only",
      authority: {
        recordTypes: ["arc", "character"], existingPaths: [arc.path],
        newPaths: [proposedPath], mayCreate: true,
      },
    },
  };
}

/** Pure authorization policy. Inputs named records/sources are controller-read
 * canonical evidence at HEAD, never the model's own catalog or permission list.
 * Only existing, typed, directly connected records can be amended here. */
export function authorizeDependency(input: {
  plan: TurnEvidence; head: string; report: DependencyReport; reportDigest: string;
  proposal: DependencyProposal; records: CanonicalScopeRecord[];
  sources: DependencySource[]; version: number;
  /** Controller-verified grants from earlier amendments in the same Turn. */
  priorAmendments?: TurnAssignmentEvidence[];
}): DependencyAmendment {
  const { plan, head, proposal, records } = input;
  const report = parseDependencyReport(input.report);
  if (!keys(proposal, "sourceSha,reportDigest,target,specialist,outcome,reason") ||
      proposal.sourceSha !== head || report.sourceSha !== head ||
      report.turnDigest !== plan.digest || proposal.reportDigest !== input.reportDigest ||
      !/^[a-f0-9]{64}$/.test(input.reportDigest) || !text(proposal.reason) ||
      !text(proposal.outcome) || proposal.outcome !== report.missing ||
      !plan.objective || !plan.objective.obligations.includes(report.obligation) ||
      plan.kind !== "revision" || report.authorDecisionRequired ||
      !Number.isSafeInteger(input.version) || input.version < 1 || input.version > 8 ||
      JSON.stringify(report.sources) !== JSON.stringify(input.sources))
    throw Error("Dependency amendment has stale evidence, changed obligations or requires author approval.");
  const origin = plan.assignments.find(a => a.id === report.assignmentId);
  const record = records.find(r => r.metadata.id === proposal.target);
  // Write authority is path-based: supportingTargets may be in existingPaths
  // without appearing in targets. Check every existing writer, including
  // earlier dependency amendments, before approving a second writer.
  const priorOwners = [...plan.assignments, ...(input.priorAmendments ?? [])];
  if (!origin || !record || record.metadata.status === "superseded" ||
      record.metadata.type !== proposal.target.split(".")[0] || !path.test(record.path) ||
      origin.targets.includes(proposal.target) || priorOwners.some(a =>
        a.targets.includes(proposal.target) || a.authority.existingPaths.includes(record.path) ||
        a.authority.newPaths?.includes(record.path)) ||
      report.affectedIds.some(id => !records.some(r => r.metadata.id === id && r.metadata.status !== "superseded")) ||
      !report.affectedIds.includes(proposal.target) || !origin.targets.some(id => report.affectedIds.includes(id)) ||
      !report.sources.some(s => s.path === record.path) ||
      report.sources.some(s => !records.some(r => r.path === s.path && report.affectedIds.includes(r.metadata.id))) ||
      !origin.targets.some(id => records.some(r => r.metadata.id === id &&
        (links(r, proposal.target) || links(record, id)))))
    throw Error("Unknown, speculative, already assigned or unrelated dependency record.");
  if (proposal.specialist !== focusedSpecialist(proposal.target) ||
      report.likelySpecialist !== proposal.specialist || proposal.specialist === origin.specialist)
    throw Error("Dependency amendment must use the proper cross-domain specialist.");
  if (records.some(r => report.affectedIds.includes(r.metadata.id) &&
      r.metadata.decisions !== undefined &&
      (!Array.isArray(r.metadata.decisions) || r.metadata.decisions.length > 0)))
    throw Error("Dependency affects decisions requiring explicit protected-authority review.");
  return { beforeVersion: input.version, afterVersion: input.version + 1,
    sourceSha: head, turnDigest: plan.digest, reportDigest: input.reportDigest,
    reason: proposal.reason, objective: structuredClone(plan.objective), resumes: origin.id,
    assignment: { id: "dependency:" + input.version + ":" + proposal.target,
      specialist: focusedSpecialist(proposal.target), outcome: proposal.outcome,
      targets: [proposal.target], dependsOn: [], discovery: "canonical-story-read-only",
      authority: { recordTypes: [record.metadata.type], existingPaths: [record.path], mayCreate: false } } };
}
