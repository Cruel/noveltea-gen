import { declaredCanonicalReferences, type CanonicalScopeRecord } from "./focused-scope.js";
import type { TurnAssignmentEvidence, TurnEvidence } from "./turn-plan-evidence.js";

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
export interface DependencyAmendment {
  beforeVersion: number; afterVersion: number; sourceSha: string; turnDigest: string;
  reportDigest: string; reason: string; objective: TurnEvidence["objective"];
  resumes: string; assignment: TurnAssignmentEvidence;
}
export function dependencySpecialist(target: string): string {
  const owner: Record<string, string> = { character: "nt-character-development",
    relationship: "nt-character-development", event: "nt-event-design",
    fact: "nt-worldbuilding", revelation: "nt-worldbuilding", "world-entity": "nt-worldbuilding",
    "authored-content": "nt-narrative-composition", "choice-point": "nt-interactive-narrative",
    puzzle: "nt-interactive-narrative" };
  const specialist = owner[target.split(".")[0]!];
  if (!specialist) throw Error("Dependency has no bounded specialist owner.");
  return specialist;
}

const text = (v: unknown, max = 2000): v is string => typeof v === "string" && !!v.trim() && v.length <= max;
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

/** Pure authorization policy. Inputs named records/sources are controller-read
 * canonical evidence at HEAD, never the model's own catalog or permission list.
 * Only existing, typed, directly connected records can be amended here. */
export function authorizeDependency(input: {
  plan: TurnEvidence; head: string; report: DependencyReport; reportDigest: string;
  proposal: DependencyProposal; records: CanonicalScopeRecord[];
  sources: DependencySource[]; version: number;
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
  if (!origin || !record || record.metadata.status === "superseded" ||
      record.metadata.type !== proposal.target.split(".")[0] || !path.test(record.path) ||
      origin.targets.includes(proposal.target) || plan.assignments.some(a => a.targets.includes(proposal.target)) ||
      report.affectedIds.some(id => !records.some(r => r.metadata.id === id && r.metadata.status !== "superseded")) ||
      !report.affectedIds.includes(proposal.target) || !origin.targets.some(id => report.affectedIds.includes(id)) ||
      !report.sources.some(s => s.path === record.path) ||
      report.sources.some(s => !records.some(r => r.path === s.path && report.affectedIds.includes(r.metadata.id))) ||
      !origin.targets.some(id => records.some(r => r.metadata.id === id &&
        (links(r, proposal.target) || links(record, id)))))
    throw Error("Unknown, speculative, already assigned or unrelated dependency record.");
  if (proposal.specialist !== dependencySpecialist(proposal.target) ||
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
      specialist: dependencySpecialist(proposal.target), outcome: proposal.outcome,
      targets: [proposal.target], dependsOn: [], discovery: "canonical-story-read-only",
      authority: { recordTypes: [record.metadata.type], existingPaths: [record.path], mayCreate: false } } };
}
